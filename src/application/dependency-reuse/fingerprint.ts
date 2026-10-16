import { createHash } from 'node:crypto';
import { canonicalJson } from '../../domain/canonical.ts';
import type { DeclarationKind, SourceRange } from '../../domain/types.ts';
import { TRIVIA_TOKEN_KINDS } from '../../metrics/definitions.ts';
import type { ParserToken } from '../../parser/protocol.ts';
import type { DependencyCatalog } from './types.ts';

/** Identity of the token normalizer; part of every digest and of the catalog provenance. */
export const NORMALIZER_VERSION = 'solidity-tokens-v1' as const;
/** Largest byte slice hashed between two checkpoints. */
export const HASH_CHUNK_BYTES: number = 64 * 1024;
/** Records (tokens) processed between two checkpoints. */
export const HASH_RECORD_INTERVAL: number = 256;

const encoder = new TextEncoder();

/** A local, typed recognizer allowance was exhausted; the affected file falls back atomically. */
export class RecognizerLimitError extends Error {
  public constructor() {
    super('The dependency recognizer allowance was exhausted.');
    this.name = 'RecognizerLimitError';
  }
}

/** Mutable per-file work allowance for the local recognizer (not the shared analysis budget). */
export class RecognizerAllowance {
  #tokens: number;
  #bytes: number;

  public constructor(maxTokens: number, maxBytes: number) {
    this.#tokens = maxTokens;
    this.#bytes = maxBytes;
  }

  public charge(tokens: number, bytes: number): void {
    this.#tokens -= tokens;
    this.#bytes -= bytes;
    if (this.#tokens < 0 || this.#bytes < 0) throw new RecognizerLimitError();
  }
}

export interface TokenIndex {
  /** Significant (non-trivia) tokens sorted by start byte. */
  readonly tokens: readonly ParserToken[];
  /** Sorted, merged Yul assembly intervals. */
  readonly assembly: readonly { readonly startByte: number; readonly endByte: number }[];
}

function mergeIntervals(
  ranges: readonly SourceRange[],
): { readonly startByte: number; readonly endByte: number }[] {
  const ordered = [...ranges].sort(
    (left, right) => left.startByte - right.startByte || left.endByte - right.endByte,
  );
  const merged: { startByte: number; endByte: number }[] = [];
  for (const range of ordered) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.startByte <= last.endByte) {
      last.endByte = Math.max(last.endByte, range.endByte);
    } else {
      merged.push({ startByte: range.startByte, endByte: range.endByte });
    }
  }
  return merged;
}

/** Indexes sorted token and assembly spans once per file instead of per declaration. */
export function indexTokens(
  tokens: readonly ParserToken[],
  assemblyRanges: readonly SourceRange[],
): TokenIndex {
  const significant = tokens.filter((token) => !TRIVIA_TOKEN_KINDS.has(token.kind));
  significant.sort((left, right) => left.range.startByte - right.range.startByte);
  return { tokens: significant, assembly: mergeIntervals(assemblyRanges) };
}

function firstTokenAtOrAfter(tokens: readonly ParserToken[], startByte: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((tokens[middle]?.range.startByte ?? 0) < startByte) low = middle + 1;
    else high = middle;
  }
  return low;
}

function insideAssembly(index: TokenIndex, range: SourceRange): boolean {
  let low = 0;
  let high = index.assembly.length - 1;
  let candidate: { readonly startByte: number; readonly endByte: number } | undefined;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const interval = index.assembly[middle];
    if (interval === undefined) return false;
    if (interval.startByte <= range.startByte) {
      candidate = interval;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candidate !== undefined && range.endByte <= candidate.endByte;
}

/** Significant tokens wholly inside `span`, in source order. */
export function tokensWithin(index: TokenIndex, span: SourceRange): ParserToken[] {
  const result: ParserToken[] = [];
  for (
    let at = firstTokenAtOrAfter(index.tokens, span.startByte);
    at < index.tokens.length;
    at += 1
  ) {
    const token = index.tokens[at];
    if (token === undefined || token.range.startByte >= span.endByte) break;
    if (token.range.endByte <= span.endByte) result.push(token);
  }
  return result;
}

/**
 * `frame(bytes)` is the ASCII decimal byte length, a colon and then exactly those bytes. A string
 * is UTF-8 encoded first.
 */
function frameText(hash: ReturnType<typeof createHash>, text: string): void {
  const bytes = encoder.encode(text);
  hash.update(`${bytes.byteLength}:`, 'ascii');
  hash.update(bytes);
}

/** `uint` and `int` outside assembly are the only normalized spellings. */
function aliasFor(bytes: Uint8Array): string | null {
  if (
    bytes.byteLength === 4 &&
    bytes[0] === 0x75 &&
    bytes[1] === 0x69 &&
    bytes[2] === 0x6e &&
    bytes[3] === 0x74
  ) {
    return 'uint256';
  }
  if (bytes.byteLength === 3 && bytes[0] === 0x69 && bytes[1] === 0x6e && bytes[2] === 0x74) {
    return 'int256';
  }
  return null;
}

export interface FingerprintTarget {
  readonly kind: DeclarationKind;
  readonly name: string;
  readonly range: SourceRange;
}

export interface Fingerprint {
  readonly digest: string;
  readonly tokenCount: number;
}

/**
 * SHA-256 over the framed canonical token sequence of one complete declaration:
 * `frame('dependency-declaration') || frame('solidity-tokens-v1') || frame(kind) || frame(name) ||
 * frame(String(significantTokenCount))` followed by `frame(token.kind) || frame(tokenBytes)` for
 * every significant token in source order. `||` is byte concatenation. Whitespace, comments and
 * NatSpec are ignored. Token bytes stream unchanged in slices of at most 64 KiB with a checkpoint
 * between slices, so one huge literal cannot monopolize the thread; the only rewrite is the
 * `uint`/`int` keyword alias outside assembly. Shared-budget failures from `checkpoint` and the
 * local allowance failure both propagate.
 */
export async function fingerprintDeclaration(
  index: TokenIndex,
  originalBytes: Uint8Array,
  target: FingerprintTarget,
  checkpoint: () => Promise<void>,
  allowance?: RecognizerAllowance,
): Promise<Fingerprint> {
  const tokens = tokensWithin(index, target.range);
  allowance?.charge(tokens.length, 0);
  const hash = createHash('sha256');
  frameText(hash, 'dependency-declaration');
  frameText(hash, NORMALIZER_VERSION);
  frameText(hash, target.kind);
  frameText(hash, target.name);
  frameText(hash, String(tokens.length));
  let visited = 0;
  for (const token of tokens) {
    visited += 1;
    if (visited % HASH_RECORD_INTERVAL === 0) await checkpoint();
    frameText(hash, token.kind);
    const start = token.range.startByte;
    const end = token.range.endByte;
    const length = end - start;
    allowance?.charge(0, length);
    const alias =
      token.kind === 'keyword' && !insideAssembly(index, token.range)
        ? aliasFor(originalBytes.subarray(start, end))
        : null;
    if (alias !== null) {
      frameText(hash, alias);
      continue;
    }
    hash.update(`${length}:`, 'ascii');
    for (let offset = start; offset < end; offset += HASH_CHUNK_BYTES) {
      hash.update(originalBytes.subarray(offset, Math.min(offset + HASH_CHUNK_BYTES, end)));
      if (offset + HASH_CHUNK_BYTES < end) await checkpoint();
    }
  }
  return { digest: hash.digest('hex'), tokenCount: tokens.length };
}

/**
 * Identity of a catalog: a SHA-256 over its canonical JSON without the digest field itself, so
 * any changed record, provenance field or parser/normalizer identity changes the digest (and with
 * it the analysis fingerprint).
 */
export function computeCatalogDigest(catalog: Omit<DependencyCatalog, 'digest'>): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        status: catalog.status,
        version: catalog.version,
        parserVersion: catalog.parserVersion,
        normalizerVersion: catalog.normalizerVersion,
        grammarSets: catalog.grammarSets,
        files: catalog.files,
        declarations: catalog.declarations,
      }),
      'utf8',
    )
    .digest('hex');
}
