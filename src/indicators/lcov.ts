import type { FileId, Measurement } from '../domain/types.ts';

/**
 * Data-only parser for a bounded LCOV line-coverage subset. It receives bytes and plain matching
 * records, never read adapters, and never opens, resolves or searches a path named in the artifact.
 * See docs/indicators.md for the supported subset.
 */

export const LCOV_MAX_LINES_PER_BATCH = 256;
export const LCOV_MAX_BYTES_PER_BATCH: number = 16 * 1024;
export const LCOV_MAX_LINE_CODE_UNITS = 8_192;
export const LCOV_MAX_CHECKSUM_CODE_UNITS = 128;
export const LCOV_MAX_PATH_CODE_UNITS = 4_096;

export type LcovUnavailableReason =
  | 'invalid-encoding'
  | 'empty'
  | 'malformed'
  | 'unterminated-record'
  | 'nested-source'
  | 'unsupported-tag'
  | 'duplicate-line'
  | 'duplicate-count'
  | 'count-mismatch'
  | 'invalid-number'
  | 'invalid-checksum'
  | 'line-too-long'
  | 'invalid-path'
  | 'outside-root'
  | 'duplicate-source'
  | 'alias-collision'
  | 'unsafe-total'
  | 'limit-exceeded';

export type LcovPathStyle = 'posix' | 'win32';

/** One scoped or context file the artifact may legitimately describe. */
export interface LcovTarget {
  readonly fileId: FileId;
  readonly role: 'scoped' | 'context';
  /** Canonical and already-observed alias paths, root-relative with `/` separators. */
  readonly paths: readonly string[];
  /** Original physical line count, or unavailable. */
  readonly physicalLines: Measurement<number>;
}

export interface LcovParseOptions {
  /** Effective `maxLcovBytes`; larger input is unavailable. */
  readonly byteLimit: number;
  /** Canonical and lexical absolute root paths for host-native absolute SF paths. */
  readonly roots: readonly string[];
  readonly targets: readonly LcovTarget[];
  readonly pathStyle?: LcovPathStyle | undefined;
}

export type LcovRecordStatus =
  | 'matched'
  | 'context'
  | 'unmatched'
  | 'physical-lines-unavailable'
  | 'line-mismatch';

export interface LcovRecordResult {
  /** Normalized root-relative path. */
  readonly path: string;
  readonly status: LcovRecordStatus;
  readonly fileId: FileId | null;
  readonly coveredLines: number;
  readonly totalLines: number;
  readonly maxLine: number;
}

export type LcovParseResult =
  | {
      readonly status: 'parsed';
      readonly records: readonly LcovRecordResult[];
      /** Totals count only matched, line-valid scoped records. */
      readonly coveredLines: number;
      readonly totalLines: number;
      readonly matchedFileIds: readonly FileId[];
      readonly absentScopedFileIds: readonly FileId[];
    }
  | { readonly status: 'unavailable'; readonly reason: LcovUnavailableReason };

class LcovFailure extends Error {
  public readonly reason: LcovUnavailableReason;
  public constructor(reason: LcovUnavailableReason) {
    super('LCOV artifact is unavailable.');
    this.name = 'LcovFailure';
    this.reason = reason;
  }
}

const IGNORED_TAGS: ReadonlySet<string> = new Set([
  'FN',
  'FNDA',
  'FNF',
  'FNH',
  'BRDA',
  'BRF',
  'BRH',
  'VER',
]);
const KNOWN_TAGS: ReadonlySet<string> = new Set(['SF', 'DA', 'LF', 'LH', 'TN', ...IGNORED_TAGS]);
const NUMBER_PATTERN = /^[0-9]{1,16}$/u;

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseCount(text: string, minimum: number): number {
  if (!NUMBER_PATTERN.test(text)) throw new LcovFailure('invalid-number');
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum) throw new LcovFailure('invalid-number');
  return value;
}

function rootComponents(root: string, style: LcovPathStyle): readonly string[] {
  const text = style === 'win32' ? root.replaceAll('\\', '/') : root;
  const parts = text.split('/');
  if (text.startsWith('/')) parts.shift();
  while (parts.at(-1) === '') parts.pop();
  return parts;
}

function normalizeOrThrow(raw: string, roots: readonly string[], style: LcovPathStyle): string {
  if (raw.length === 0 || raw.length > LCOV_MAX_PATH_CODE_UNITS || hasControlCharacter(raw)) {
    throw new LcovFailure('invalid-path');
  }
  // URI schemes need at least two scheme characters, which leaves drive letters to the check below.
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/u.test(raw)) throw new LcovFailure('invalid-path');
  let text = raw;
  if (style === 'win32') text = text.replaceAll('\\', '/');
  else if (text.includes('\\')) throw new LcovFailure('invalid-path');
  if (text.startsWith('//')) throw new LcovFailure('invalid-path');
  const drive = /^[A-Za-z]:\//u.test(text);
  if (/^[A-Za-z]:/u.test(text) && (!drive || style === 'posix')) {
    throw new LcovFailure('invalid-path');
  }
  const absolute = text.startsWith('/') || drive;
  const segments = text.split('/');
  if (text.startsWith('/')) segments.shift();

  let relativeSegments: string[];
  if (absolute) {
    // Host-native absolute path: contained under a captured root by whole components.
    if (segments.includes('..')) throw new LcovFailure('outside-root');
    relativeSegments = [];
    let contained = false;
    for (const root of roots) {
      const rootParts = rootComponents(root, style);
      if (
        segments.length > rootParts.length &&
        rootParts.every((part, index) => segments[index] === part)
      ) {
        relativeSegments = segments.slice(rootParts.length);
        contained = true;
        break;
      }
    }
    if (!contained) throw new LcovFailure('outside-root');
  } else {
    // Reject above-root traversal before any normalization could collapse it.
    let depth = 0;
    for (const segment of segments) {
      if (segment === '..') {
        depth -= 1;
        if (depth < 0) throw new LcovFailure('outside-root');
      } else if (segment !== '.' && segment !== '') {
        depth += 1;
      }
    }
    relativeSegments = segments;
  }
  if (relativeSegments.some((segment) => segment === '')) throw new LcovFailure('invalid-path');
  const stack: string[] = [];
  for (const segment of relativeSegments) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (stack.pop() === undefined) throw new LcovFailure('outside-root');
      continue;
    }
    stack.push(segment);
  }
  if (stack.length === 0) throw new LcovFailure('invalid-path');
  const normalized = stack.join('/');
  if (normalized.length > LCOV_MAX_PATH_CODE_UNITS) throw new LcovFailure('invalid-path');
  return normalized;
}

/** Normalizes one SF value to a root-relative `/` path, or reports a fixed rejection reason. */
export function normalizeSourcePath(
  raw: string,
  roots: readonly string[],
  style: LcovPathStyle,
):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: LcovUnavailableReason } {
  try {
    return { ok: true, path: normalizeOrThrow(raw, roots, style) };
  } catch (error: unknown) {
    if (error instanceof LcovFailure) return { ok: false, reason: error.reason };
    throw error;
  }
}

interface RecordState {
  path: string | null;
  readonly lines: Set<number>;
  covered: number;
  maxLine: number;
  providedLf: number | null;
  providedLh: number | null;
}

interface RawRecord {
  readonly path: string;
  readonly covered: number;
  readonly total: number;
  readonly maxLine: number;
}

function matchRecords(
  records: readonly RawRecord[],
  targets: readonly LcovTarget[],
): LcovParseResult {
  const byPath = new Map<string, LcovTarget>();
  for (const target of targets) {
    for (const path of target.paths) {
      const existing = byPath.get(path);
      if (existing !== undefined && existing.fileId !== target.fileId) {
        throw new TypeError('Contradictory matching paths for distinct files.');
      }
      byPath.set(path, target);
    }
  }
  const results: LcovRecordResult[] = [];
  const claimed = new Set<FileId>();
  let covered = 0;
  let total = 0;
  for (const record of records) {
    const target = byPath.get(record.path);
    let status: LcovRecordStatus;
    let fileId: FileId | null = null;
    if (target === undefined) {
      status = 'unmatched';
    } else {
      fileId = target.fileId;
      if (claimed.has(target.fileId)) throw new LcovFailure('alias-collision');
      claimed.add(target.fileId);
      if (target.role === 'context') {
        status = 'context';
      } else if (target.physicalLines.status !== 'measured') {
        status = 'physical-lines-unavailable';
      } else if (record.maxLine > target.physicalLines.value) {
        status = 'line-mismatch';
      } else {
        status = 'matched';
        covered += record.covered;
        total += record.total;
        if (!Number.isSafeInteger(covered) || !Number.isSafeInteger(total)) {
          throw new LcovFailure('unsafe-total');
        }
      }
    }
    results.push({
      path: record.path,
      status,
      fileId,
      coveredLines: record.covered,
      totalLines: record.total,
      maxLine: record.maxLine,
    });
  }
  const matched = results
    .filter((item) => item.status === 'matched' && item.fileId !== null)
    .map((item) => item.fileId as FileId);
  const absent = targets
    .filter((target) => target.role === 'scoped' && !claimed.has(target.fileId))
    .map((target) => target.fileId);
  return {
    status: 'parsed',
    records: results,
    coveredLines: covered,
    totalLines: total,
    matchedFileIds: matched,
    absentScopedFileIds: absent,
  };
}

/**
 * Incremental parse. Each `next()` decodes at most 16 KiB and handles at most 256 lines, then
 * yields. Failure is returned as an unavailable result; no partial totals are ever produced.
 */
export function* parseLcovBatches(
  bytes: Uint8Array,
  options: LcovParseOptions,
): Generator<void, LcovParseResult, void> {
  try {
    return yield* parseSteps(bytes, options);
  } catch (error: unknown) {
    if (error instanceof LcovFailure) return { status: 'unavailable', reason: error.reason };
    throw error;
  }
}

function* parseSteps(
  bytes: Uint8Array,
  options: LcovParseOptions,
): Generator<void, LcovParseResult, void> {
  if (bytes.byteLength > options.byteLimit) throw new LcovFailure('limit-exceeded');
  if (bytes.byteLength === 0) throw new LcovFailure('empty');
  const style: LcovPathStyle =
    options.pathStyle ?? (process.platform === 'win32' ? 'win32' : 'posix');
  // Byte-derived retention ceilings: the shortest DA and record encodings bound legitimate input.
  const maxRetainedLines = Math.floor(options.byteLimit / 7) + 1;
  const maxRecords = Math.floor(options.byteLimit / 19) + 1;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  let offset = 0;
  let pending = '';
  let position = 0;
  let first = true;
  let retained = 0;
  const records: RawRecord[] = [];
  const seenPaths = new Set<string>();
  let current: RecordState | null = null;

  const processLine = (line: string): void => {
    if (line.length > LCOV_MAX_LINE_CODE_UNITS) throw new LcovFailure('line-too-long');
    if (current === null) {
      if (line.trim() === '' || line.startsWith('TN:')) return;
      if (line.startsWith('SF:')) {
        current = {
          path: null,
          lines: new Set(),
          covered: 0,
          maxLine: 0,
          providedLf: null,
          providedLh: null,
        };
      } else {
        const tag = line.split(':', 1)[0] ?? '';
        throw new LcovFailure(
          KNOWN_TAGS.has(tag) || line === 'end_of_record' ? 'malformed' : 'unsupported-tag',
        );
      }
    }
    const state: RecordState | null = current;
    if (state === null) return;
    if (line === 'end_of_record') {
      if (state.path === null) throw new LcovFailure('malformed');
      const total = state.lines.size;
      if (state.providedLf !== null && state.providedLf !== total) {
        throw new LcovFailure('count-mismatch');
      }
      if (state.providedLh !== null && state.providedLh !== state.covered) {
        throw new LcovFailure('count-mismatch');
      }
      if (records.length >= maxRecords) throw new LcovFailure('limit-exceeded');
      if (seenPaths.has(state.path)) throw new LcovFailure('duplicate-source');
      seenPaths.add(state.path);
      records.push({ path: state.path, covered: state.covered, total, maxLine: state.maxLine });
      current = null;
      return;
    }
    const colon = line.indexOf(':');
    if (colon < 0) throw new LcovFailure('malformed');
    const tag = line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (tag === 'SF') {
      if (state.path !== null) throw new LcovFailure('nested-source');
      state.path = normalizeOrThrow(value, options.roots, style);
    } else if (tag === 'DA') {
      if (state.path === null) throw new LcovFailure('malformed');
      const parts = value.split(',');
      if (parts.length < 2 || parts.length > 3) throw new LcovFailure('malformed');
      const lineNumber = parseCount(parts[0] ?? '', 1);
      const hits = parseCount(parts[1] ?? '', 0);
      const checksum = parts[2];
      if (
        checksum !== undefined &&
        (checksum.length === 0 ||
          checksum.length > LCOV_MAX_CHECKSUM_CODE_UNITS ||
          hasControlCharacter(checksum))
      ) {
        throw new LcovFailure('invalid-checksum');
      }
      if (state.lines.has(lineNumber)) throw new LcovFailure('duplicate-line');
      retained += 1;
      if (retained > maxRetainedLines) throw new LcovFailure('limit-exceeded');
      state.lines.add(lineNumber);
      if (hits > 0) state.covered += 1;
      if (lineNumber > state.maxLine) state.maxLine = lineNumber;
    } else if (tag === 'LF' || tag === 'LH') {
      if (state.path === null) throw new LcovFailure('malformed');
      const count = parseCount(value, 0);
      if (tag === 'LF') {
        if (state.providedLf !== null) throw new LcovFailure('duplicate-count');
        state.providedLf = count;
      } else {
        if (state.providedLh !== null) throw new LcovFailure('duplicate-count');
        state.providedLh = count;
      }
    } else if (IGNORED_TAGS.has(tag)) {
      if (state.path === null) throw new LcovFailure('malformed');
    } else if (tag === 'TN') {
      throw new LcovFailure('malformed');
    } else {
      throw new LcovFailure('unsupported-tag');
    }
  };

  const drainLines = (final: boolean): void => {
    let handled = 0;
    while (handled < LCOV_MAX_LINES_PER_BATCH) {
      let end = -1;
      let width = 1;
      for (let index = position; index < pending.length; index += 1) {
        const code = pending.charCodeAt(index);
        if (code === 0x0a) {
          end = index;
          break;
        }
        if (code === 0x0d) {
          if (index + 1 < pending.length) {
            end = index;
            width = pending.charCodeAt(index + 1) === 0x0a ? 2 : 1;
            break;
          }
          if (final) {
            end = index;
            break;
          }
          // A trailing CR may be the first half of CRLF; wait for more input.
          break;
        }
        if (index - position > LCOV_MAX_LINE_CODE_UNITS) throw new LcovFailure('line-too-long');
      }
      if (end < 0) {
        if (final && position < pending.length) {
          processLine(pending.slice(position));
          position = pending.length;
        }
        if (pending.length - position > LCOV_MAX_LINE_CODE_UNITS + 1) {
          throw new LcovFailure('line-too-long');
        }
        return;
      }
      processLine(pending.slice(position, end));
      position = end + width;
      handled += 1;
    }
  };

  for (;;) {
    if (offset < bytes.byteLength && pending.length - position < LCOV_MAX_BYTES_PER_BATCH) {
      const next = Math.min(bytes.byteLength, offset + LCOV_MAX_BYTES_PER_BATCH);
      let piece: string;
      try {
        piece = decoder.decode(bytes.subarray(offset, next), { stream: next < bytes.byteLength });
      } catch {
        throw new LcovFailure('invalid-encoding');
      }
      offset = next;
      if (first && piece.startsWith('﻿')) piece = piece.slice(1);
      if (piece.length > 0) first = false;
      pending = pending.slice(position) + piece;
      position = 0;
    }
    const final = offset >= bytes.byteLength;
    drainLines(final);
    if (final) {
      // Complete lines may remain beyond the per-batch line cap.
      if (position < pending.length) {
        yield;
        continue;
      }
      break;
    }
    yield;
  }
  if (current !== null) throw new LcovFailure('unterminated-record');
  if (records.length === 0) throw new LcovFailure('empty');
  return matchRecords(records, options.targets);
}
