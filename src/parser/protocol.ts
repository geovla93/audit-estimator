import type {
  CallableId,
  ContractId,
  Diagnostic,
  EdgeId,
  FileId,
  FileScopeEntry,
  SourceRange,
  SourceSnapshot,
} from '../domain/types.ts';

export const PARSER_PROTOCOL_VERSION: number = 1;
export const MAX_READY_VERSIONS: number = 256;
export const MAX_VERSION_CODE_UNITS: number = 128;
export const MAX_RESPONSE_BYTES: number = 32 * 1024 * 1024;
export const MAX_SESSION_RESPONSE_BYTES: number = 64 * 1024 * 1024;
export const MAX_DIAGNOSTICS_PER_FILE: number = 256;
export const MAX_DIAGNOSTIC_MESSAGE_CODE_UNITS: number = 512;
export const MAX_DIAGNOSTIC_MESSAGE_BYTES: number = 1024;
export const MAX_EVENT_ATTRIBUTES: number = 32;
export const MAX_EVENT_LABEL_CODE_UNITS: number = 128;
export const MAX_EVENT_STRING_CODE_UNITS: number = 512;
export const MAX_DECLARATION_NAME_CODE_UNITS: number = 128;
export const MAX_IMPORT_SPECIFIER_CODE_UNITS: number = 512;
/** Configured schema ceiling; each result is further checked against its job allowance. */
export const MAX_RECORDS_PER_FILE: number = 2_000_000;
export const MAX_FRAMES_PER_CHUNK: number = 4_096;
export const REQUEST_FRAME_OVERHEAD_BYTES: number = 64 * 1024;

export type VersionSelectionSource =
  | 'cli'
  | 'config'
  | 'metadata'
  | 'inferred'
  | 'latest-no-pragma';

export type ParserTokenKind =
  | 'whitespace'
  | 'comment'
  | 'natspec'
  | 'string'
  | 'identifier'
  | 'keyword'
  | 'operator'
  | 'punctuation'
  | 'unknown';

export interface ParserSource {
  readonly fileId: FileId;
  readonly snapshot: SourceSnapshot;
  readonly manifestEntry: FileScopeEntry;
}

export interface ParserVersionRecord {
  readonly selectedVersion: string;
  readonly selectionSource: VersionSelectionSource;
  readonly ignoredHint: 'used' | 'ignored' | 'not-applicable';
  readonly compatibleVersions: readonly string[];
  readonly installedVersions: readonly string[];
  readonly pragmaRanges: readonly SourceRange[];
  readonly parserVersion: string;
}

export interface ParserToken {
  readonly fileId: FileId;
  readonly kind: ParserTokenKind;
  readonly range: SourceRange;
}

export interface ParserAttribute {
  readonly key: string;
  readonly value: string | number | boolean | null;
}

export interface ParserDeclaration {
  readonly id: ContractId | CallableId;
  readonly kind: string;
  readonly name: string;
  readonly contractId: ContractId | null;
  readonly callableId: CallableId | null;
  readonly declarationRange: SourceRange;
  readonly nameRange: SourceRange;
  readonly bodyRange: SourceRange | null;
  readonly hasBody: boolean;
  readonly attributes: readonly ParserAttribute[];
}

export interface ParserImport {
  readonly id: EdgeId;
  readonly specifier: string;
  readonly range: SourceRange;
  readonly specifierRange: SourceRange;
  readonly aliasForm: 'bare' | 'namespace' | 'named';
}

export interface ParserEvent {
  readonly fileId: FileId;
  readonly kind: string;
  readonly contractId: ContractId | null;
  readonly callableId: CallableId | null;
  readonly range: SourceRange;
  readonly attributes: readonly ParserAttribute[];
}

export type ParseFileResult =
  | {
      readonly status: 'parsed';
      readonly fileId: FileId;
      readonly version: ParserVersionRecord;
      readonly tokens: readonly ParserToken[];
      readonly declarations: readonly ParserDeclaration[];
      readonly imports: readonly ParserImport[];
      readonly events: readonly ParserEvent[];
      readonly diagnostics: readonly Diagnostic[];
      readonly visitedNodes: number;
    }
  | {
      readonly status: 'failed';
      readonly fileId: FileId;
      readonly code: 'LANGUAGE_UNSUPPORTED' | 'PARSE_INVALID' | 'LIMIT_EXCEEDED' | 'INTERNAL_ERROR';
      readonly diagnostics: readonly Diagnostic[];
    };

export interface ParserBatch {
  readonly files: readonly ParseFileResult[];
  readonly diagnostics: readonly Diagnostic[];
  readonly complete: boolean;
  readonly visitedNodes: number;
  readonly processedBytes: number;
}

export interface WorkerReady {
  readonly protocolVersion: number;
  readonly kind: 'ready';
  readonly parserVersion: string;
  readonly supportedVersions: readonly string[];
}

export type ParserWorkerRequest = {
  readonly protocolVersion: number;
  readonly requestId: number;
  readonly kind: 'parse-file';
  readonly fileId: FileId;
  readonly canonicalPath: string;
  readonly originalText: string;
  readonly byteHash: string;
  readonly maxFileBytes: number;
  readonly maxAstNodesPerFile: number;
  readonly maxAstNodesRemaining: number;
  readonly maxImportsRemaining: number;
  readonly versionAuthority: 'cli' | 'config' | 'metadata' | 'default';
  readonly version: string;
};

export interface WorkerReply {
  readonly protocolVersion: number;
  readonly requestId: number;
  readonly kind: 'result';
  readonly jobKind: 'parse-file';
  readonly fileId: FileId;
  /** Confirmed CST visits, including work on an unsuccessful file. */
  readonly consumedNodes: number;
  /** Import directives traversed, including work on an unsuccessful file. */
  readonly consumedImports: number;
  readonly result: ParseFileResult;
}

export class ParserProtocolError extends Error {
  public readonly failure: 'limit' | 'protocol';

  public constructor(failure: 'limit' | 'protocol') {
    super(failure === 'limit' ? 'Parser transport limit exceeded.' : 'Parser protocol violation.');
    this.name = 'ParserProtocolError';
    this.failure = failure;
  }
}

export function maxRequestFrameBytes(maxFileBytes: number): number {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0) {
    throw new TypeError('The parser file-byte limit must be a nonnegative safe integer.');
  }
  const maximum = maxFileBytes * 6 + REQUEST_FRAME_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum > 0xffff_ffff) {
    throw new ParserProtocolError('limit');
  }
  return maximum;
}

export function encodeFrame(value: unknown, maximumBytes: number): Buffer {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 0xffff_ffff) {
    throw new TypeError('The frame ceiling must be an unsigned 32-bit safe integer.');
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ParserProtocolError('protocol');
  }
  if (serialized === undefined) throw new ParserProtocolError('protocol');
  const payloadBytes = Buffer.byteLength(serialized, 'utf8');
  if (payloadBytes > maximumBytes || payloadBytes > 0xffff_ffff) {
    throw new ParserProtocolError('limit');
  }
  const frame = Buffer.allocUnsafe(4 + payloadBytes);
  frame.writeUInt32BE(payloadBytes, 0);
  frame.write(serialized, 4, payloadBytes, 'utf8');
  return frame;
}

/** Incremental frame decoder that validates advertised sizes before payload allocation. */
export class FrameDecoder {
  readonly #maximumBytes: number;
  readonly #header = Buffer.alloc(4);
  #headerBytes = 0;
  #payload: Buffer | null = null;
  #payloadBytes = 0;
  #framesInChunk = 0;

  public constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 0xffff_ffff) {
      throw new TypeError('The frame ceiling must be an unsigned 32-bit safe integer.');
    }
    this.#maximumBytes = maximumBytes;
  }

  public push(chunk: Uint8Array): readonly Buffer[] {
    const frames: Buffer[] = [];
    let offset = 0;
    this.#framesInChunk = 0;
    while (offset < chunk.byteLength) {
      if (this.#payload === null) {
        const copied = Math.min(4 - this.#headerBytes, chunk.byteLength - offset);
        this.#header.set(chunk.subarray(offset, offset + copied), this.#headerBytes);
        this.#headerBytes += copied;
        offset += copied;
        if (this.#headerBytes < 4) continue;

        const advertisedBytes = this.#header.readUInt32BE(0);
        if (advertisedBytes > this.#maximumBytes) throw new ParserProtocolError('limit');
        this.#headerBytes = 0;
        if (advertisedBytes === 0) {
          this.#recordFrame(frames, Buffer.alloc(0));
          continue;
        }
        this.#payload = Buffer.allocUnsafe(advertisedBytes);
        this.#payloadBytes = 0;
      }

      const current = this.#payload;
      if (current === null) throw new ParserProtocolError('protocol');
      const copied = Math.min(current.byteLength - this.#payloadBytes, chunk.byteLength - offset);
      current.set(chunk.subarray(offset, offset + copied), this.#payloadBytes);
      this.#payloadBytes += copied;
      offset += copied;
      if (this.#payloadBytes === current.byteLength) {
        this.#payload = null;
        this.#payloadBytes = 0;
        this.#recordFrame(frames, current);
      }
    }
    return frames;
  }

  public finish(): void {
    if (this.#headerBytes !== 0 || this.#payload !== null) {
      throw new ParserProtocolError('protocol');
    }
  }

  #recordFrame(frames: Buffer[], frame: Buffer): void {
    this.#framesInChunk += 1;
    if (this.#framesInChunk > MAX_FRAMES_PER_CHUNK) throw new ParserProtocolError('limit');
    frames.push(frame);
  }
}

export function decodeJsonFrame(payload: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw new ParserProtocolError('protocol');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ParserProtocolError('protocol');
  }
}

export function validateReady(value: unknown): WorkerReady {
  const record = strictRecord(value, [
    'protocolVersion',
    'kind',
    'parserVersion',
    'supportedVersions',
  ]);
  if (
    record.protocolVersion !== PARSER_PROTOCOL_VERSION ||
    record.kind !== 'ready' ||
    typeof record.parserVersion !== 'string' ||
    record.parserVersion.length === 0 ||
    record.parserVersion.length > MAX_VERSION_CODE_UNITS ||
    !Array.isArray(record.supportedVersions) ||
    record.supportedVersions.length === 0 ||
    record.supportedVersions.length > MAX_READY_VERSIONS
  ) {
    throw new ParserProtocolError('protocol');
  }
  const supportedVersions: string[] = [];
  for (const version of record.supportedVersions) {
    if (
      typeof version !== 'string' ||
      version.length > MAX_VERSION_CODE_UNITS ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)
    ) {
      throw new ParserProtocolError('protocol');
    }
    supportedVersions.push(version);
  }
  if (new Set(supportedVersions).size !== supportedVersions.length) {
    throw new ParserProtocolError('protocol');
  }
  return {
    protocolVersion: PARSER_PROTOCOL_VERSION,
    kind: 'ready',
    parserVersion: record.parserVersion,
    supportedVersions,
  };
}

export function validateWorkerReply(
  value: unknown,
  expected: { readonly requestId: number; readonly fileId: FileId },
): WorkerReply {
  const record = strictRecord(value, [
    'protocolVersion',
    'requestId',
    'kind',
    'jobKind',
    'fileId',
    'consumedNodes',
    'consumedImports',
    'result',
  ]);
  if (
    record.protocolVersion !== PARSER_PROTOCOL_VERSION ||
    record.kind !== 'result' ||
    record.jobKind !== 'parse-file' ||
    record.requestId !== expected.requestId ||
    !Number.isSafeInteger(record.requestId) ||
    !Number.isSafeInteger(record.consumedNodes) ||
    (record.consumedNodes as number) < 0 ||
    (record.consumedNodes as number) > MAX_RECORDS_PER_FILE ||
    !Number.isSafeInteger(record.consumedImports) ||
    (record.consumedImports as number) < 0 ||
    (record.consumedImports as number) > MAX_RECORDS_PER_FILE ||
    typeof record.fileId !== 'string' ||
    record.fileId !== expected.fileId
  ) {
    throw new ParserProtocolError('protocol');
  }
  validateParseFileResult(record.result, expected.fileId);
  return record as unknown as WorkerReply;
}

export function validateParseFileResult(value: unknown, expectedFileId: FileId): void {
  if (!isRecord(value)) throw new ParserProtocolError('protocol');
  if (value.status === 'failed') {
    const record = strictRecord(value, ['status', 'fileId', 'code', 'diagnostics']);
    if (
      record.fileId !== expectedFileId ||
      !['LANGUAGE_UNSUPPORTED', 'PARSE_INVALID', 'LIMIT_EXCEEDED', 'INTERNAL_ERROR'].includes(
        String(record.code),
      ) ||
      !Array.isArray(record.diagnostics) ||
      record.diagnostics.length > MAX_DIAGNOSTICS_PER_FILE
    ) {
      throw new ParserProtocolError('protocol');
    }
    for (const diagnostic of record.diagnostics) validateDiagnostic(diagnostic, expectedFileId);
    return;
  }
  if (value.status !== 'parsed') throw new ParserProtocolError('protocol');
  const record = strictRecord(value, [
    'status',
    'fileId',
    'version',
    'tokens',
    'declarations',
    'imports',
    'events',
    'diagnostics',
    'visitedNodes',
  ]);
  if (
    record.fileId !== expectedFileId ||
    !Number.isSafeInteger(record.visitedNodes) ||
    (record.visitedNodes as number) < 0 ||
    (record.visitedNodes as number) > MAX_RECORDS_PER_FILE ||
    !Array.isArray(record.tokens) ||
    !Array.isArray(record.declarations) ||
    !Array.isArray(record.imports) ||
    !Array.isArray(record.events) ||
    !Array.isArray(record.diagnostics) ||
    record.tokens.length > MAX_RECORDS_PER_FILE ||
    record.declarations.length > MAX_RECORDS_PER_FILE ||
    record.imports.length > MAX_RECORDS_PER_FILE ||
    record.events.length > MAX_RECORDS_PER_FILE ||
    record.diagnostics.length > MAX_DIAGNOSTICS_PER_FILE ||
    !isRecord(record.version)
  ) {
    throw new ParserProtocolError('protocol');
  }
  for (const diagnostic of record.diagnostics) validateDiagnostic(diagnostic, expectedFileId);
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ParserProtocolError('protocol');
  return value;
}

export function strictRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new ParserProtocolError('protocol');
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new ParserProtocolError('protocol');
  }
  if (allowed.some((key) => !Object.hasOwn(value, key))) throw new ParserProtocolError('protocol');
  return value;
}

function validateDiagnostic(value: unknown, fileId: FileId): void {
  if (!isRecord(value)) throw new ParserProtocolError('protocol');
  if (
    Object.keys(value).some(
      (key) =>
        !['code', 'severity', 'phase', 'message', 'fileId', 'range', 'details'].includes(key),
    ) ||
    !Object.hasOwn(value, 'code') ||
    !Object.hasOwn(value, 'severity') ||
    !Object.hasOwn(value, 'phase') ||
    !Object.hasOwn(value, 'message') ||
    value.fileId !== fileId ||
    typeof value.message !== 'string' ||
    value.message.length > MAX_DIAGNOSTIC_MESSAGE_CODE_UNITS ||
    Buffer.byteLength(value.message, 'utf8') > MAX_DIAGNOSTIC_MESSAGE_BYTES ||
    value.phase !== 'parse' ||
    !['info', 'warning', 'error'].includes(String(value.severity)) ||
    ![
      'LANGUAGE_UNSUPPORTED',
      'PARSE_INVALID',
      'LIMIT_EXCEEDED',
      'INTERNAL_ERROR',
      'SEMANTICS_UNAVAILABLE',
    ].includes(String(value.code))
  ) {
    throw new ParserProtocolError('protocol');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
