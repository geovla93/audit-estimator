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

/** Version 2 adds the explicit `semantic-component` job beside the unchanged `parse-file` job. */
export const PARSER_PROTOCOL_VERSION: number = 2;
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
/** Schema ceilings for the semantic-component job (configured limits can only tighten them). */
export const MAX_SEMANTIC_FILES_CEILING: number = 1_280;
export const MAX_SEMANTIC_BYTES_CEILING: number = 80 * 1024 * 1024;
export const MAX_SEMANTIC_LOOKUPS_CEILING: number = 200_000;
export const MAX_SEMANTIC_RECORDS_CEILING: number = 1_000_000;
export const MAX_SEMANTIC_NODES_CEILING: number = 20_000_000;
export const MAX_SEMANTIC_DEFINITIONS_PER_REFERENCE: number = 256;
export const MAX_SEMANTIC_ORDINAL: number = 65_535;
export const SEMANTIC_FILE_FRAME_OVERHEAD_BYTES: number = 512;
export const SEMANTIC_LOOKUP_FRAME_OVERHEAD_BYTES: number = 768;

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

/** One member file of a semantic component. The child verifies the bytes against `byteHash`. */
export interface SemanticComponentFile {
  readonly fileId: FileId;
  readonly canonicalPath: string;
  readonly originalText: string;
  readonly byteHash: string;
}

/** A resolved import keyed by importer ID plus the original-byte range of its path literal. */
export interface SemanticImportLookup {
  readonly importerFileId: FileId;
  readonly importId: EdgeId;
  readonly specifier: string;
  readonly specifierRange: SourceRange;
  readonly targetFileId: FileId;
}

export interface SemanticWorkerRequest {
  readonly protocolVersion: number;
  readonly requestId: number;
  readonly kind: 'semantic-component';
  readonly componentId: FileId;
  readonly grammar: string;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxFileBytes: number;
  readonly maxAstNodesPerFile: number;
  readonly maxAstNodesRemaining: number;
  readonly maxRecords: number;
  readonly files: readonly SemanticComponentFile[];
  readonly imports: readonly SemanticImportLookup[];
}

export type SemanticUnavailableReason =
  | 'invalid-request'
  | 'source-mismatch'
  | 'grammar-unavailable'
  | 'syntax-invalid'
  | 'import-mapping'
  | 'binding-failed'
  | 'limit';

/** A binding definition, reduced to plain data. Built-in definitions carry no location. */
export type SemanticDefinition =
  | { readonly kind: 'builtin' }
  | {
      readonly kind: 'user';
      readonly fileId: FileId;
      /** Original-byte range of the definition's name token. */
      readonly nameRange: SourceRange;
      /** CST kind label of the defining node, for example `FunctionDefinition`. */
      readonly definiens: string;
    };

export interface SemanticBaseSite {
  readonly fileId: FileId;
  /** Original-byte start of the owning contract-like declaration. */
  readonly contractStartByte: number;
  readonly ordinal: number;
  /** Range of the last identifier of the inheritance path. */
  readonly reference: SourceRange;
  readonly definitions: readonly SemanticDefinition[];
}

export type SemanticCalleeKind = 'identifier' | 'member' | 'elementary-type' | 'new' | 'other';
export type SemanticReceiverKind = 'none' | 'this' | 'super' | 'identifier' | 'other';

export interface SemanticCallSite {
  readonly fileId: FileId;
  /** The call expression range, identical to the syntax `call-site` event range. */
  readonly range: SourceRange;
  readonly callee: SemanticCalleeKind;
  readonly definitions: readonly SemanticDefinition[];
  readonly receiver: SemanticReceiverKind;
  readonly receiverDefinitions: readonly SemanticDefinition[];
}

export type SemanticComponentResult =
  | {
      readonly status: 'bound';
      readonly grammar: string;
      readonly baseSites: readonly SemanticBaseSite[];
      readonly callSites: readonly SemanticCallSite[];
    }
  | { readonly status: 'unavailable'; readonly reason: SemanticUnavailableReason };

export interface SemanticWorkerReply {
  readonly protocolVersion: number;
  readonly requestId: number;
  readonly kind: 'result';
  readonly jobKind: 'semantic-component';
  readonly componentId: FileId;
  /** Confirmed explicit CST visits, including work on an unsuccessful component. */
  readonly consumedNodes: number;
  readonly result: SemanticComponentResult;
}

export type AnyWorkerRequest = ParserWorkerRequest | SemanticWorkerRequest;
export type AnyWorkerReply = WorkerReply | SemanticWorkerReply;

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

const SEMANTIC_UNAVAILABLE_REASONS: readonly string[] = [
  'invalid-request',
  'source-mismatch',
  'grammar-unavailable',
  'syntax-invalid',
  'import-mapping',
  'binding-failed',
  'limit',
];
const SEMANTIC_CALLEE_KINDS: readonly string[] = [
  'identifier',
  'member',
  'elementary-type',
  'new',
  'other',
];
const SEMANTIC_RECEIVER_KINDS: readonly string[] = ['none', 'this', 'super', 'identifier', 'other'];
const SEMANTIC_DEFINIENS_PATTERN: RegExp = /^[A-Za-z]{1,64}$/u;

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

/**
 * Derives the semantic request frame ceiling from effective component sizes before any encoding
 * or decoding. JSON escaping can expand a UTF-8 byte to at most six bytes, so text and metadata
 * code units are scaled by six; fixed per-record overheads cover keys and numbers. The result
 * must fit an unsigned 32-bit frame header.
 */
export function maxSemanticRequestFrameBytes(sizes: {
  readonly textBytes: number;
  readonly metadataCodeUnits: number;
  readonly files: number;
  readonly lookups: number;
}): number {
  for (const value of [sizes.textBytes, sizes.metadataCodeUnits, sizes.files, sizes.lookups]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Semantic request sizes must be nonnegative safe integers.');
    }
  }
  const bound =
    6 * sizes.textBytes +
    6 * sizes.metadataCodeUnits +
    SEMANTIC_FILE_FRAME_OVERHEAD_BYTES * sizes.files +
    SEMANTIC_LOOKUP_FRAME_OVERHEAD_BYTES * sizes.lookups +
    REQUEST_FRAME_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(bound) || bound > 0xffff_ffff) throw new ParserProtocolError('limit');
  return bound;
}

function shapeRange(value: unknown): void {
  const range = strictRecord(value, ['startByte', 'endByte', 'start', 'end']);
  const start = strictRecord(range.start, ['line', 'column']);
  const end = strictRecord(range.end, ['line', 'column']);
  if (
    !boundedInteger(range.startByte, 0, Number.MAX_SAFE_INTEGER) ||
    !boundedInteger(range.endByte, 0, Number.MAX_SAFE_INTEGER) ||
    !boundedInteger(start.line, 1, Number.MAX_SAFE_INTEGER) ||
    !boundedInteger(start.column, 1, Number.MAX_SAFE_INTEGER) ||
    !boundedInteger(end.line, 1, Number.MAX_SAFE_INTEGER) ||
    !boundedInteger(end.column, 1, Number.MAX_SAFE_INTEGER)
  ) {
    throw new ParserProtocolError('protocol');
  }
}

/**
 * Strictly decodes a semantic-component request. Every count and byte bound is checked before
 * any map is built from the payload or Slang is invoked.
 */
export function decodeSemanticRequest(value: unknown): SemanticWorkerRequest {
  const record = strictRecord(value, [
    'protocolVersion',
    'requestId',
    'kind',
    'componentId',
    'grammar',
    'maxFiles',
    'maxBytes',
    'maxFileBytes',
    'maxAstNodesPerFile',
    'maxAstNodesRemaining',
    'maxRecords',
    'files',
    'imports',
  ]);
  if (
    record.protocolVersion !== PARSER_PROTOCOL_VERSION ||
    !boundedInteger(record.requestId, 1, Number.MAX_SAFE_INTEGER) ||
    record.kind !== 'semantic-component' ||
    typeof record.componentId !== 'string' ||
    typeof record.grammar !== 'string' ||
    record.grammar.length === 0 ||
    record.grammar.length > MAX_VERSION_CODE_UNITS ||
    !boundedInteger(record.maxFiles, 0, MAX_SEMANTIC_FILES_CEILING) ||
    !boundedInteger(record.maxBytes, 0, MAX_SEMANTIC_BYTES_CEILING) ||
    !boundedInteger(record.maxFileBytes, 0, MAX_SEMANTIC_BYTES_CEILING) ||
    !boundedInteger(record.maxAstNodesPerFile, 0, MAX_RECORDS_PER_FILE) ||
    !boundedInteger(record.maxAstNodesRemaining, 0, MAX_SEMANTIC_NODES_CEILING) ||
    !boundedInteger(record.maxRecords, 0, MAX_SEMANTIC_RECORDS_CEILING) ||
    !Array.isArray(record.files) ||
    record.files.length > record.maxFiles ||
    !Array.isArray(record.imports) ||
    record.imports.length > MAX_SEMANTIC_LOOKUPS_CEILING
  ) {
    throw new ParserProtocolError('protocol');
  }
  for (const file of record.files) {
    const item = strictRecord(file, ['fileId', 'canonicalPath', 'originalText', 'byteHash']);
    if (
      typeof item.fileId !== 'string' ||
      typeof item.canonicalPath !== 'string' ||
      item.canonicalPath.length === 0 ||
      item.canonicalPath.length > 4096 ||
      typeof item.originalText !== 'string' ||
      typeof item.byteHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(item.byteHash)
    ) {
      throw new ParserProtocolError('protocol');
    }
  }
  for (const lookup of record.imports) {
    const item = strictRecord(lookup, [
      'importerFileId',
      'importId',
      'specifier',
      'specifierRange',
      'targetFileId',
    ]);
    if (
      typeof item.importerFileId !== 'string' ||
      typeof item.importId !== 'string' ||
      typeof item.specifier !== 'string' ||
      item.specifier.length > MAX_IMPORT_SPECIFIER_CODE_UNITS ||
      typeof item.targetFileId !== 'string'
    ) {
      throw new ParserProtocolError('protocol');
    }
    shapeRange(item.specifierRange);
  }
  return record as unknown as SemanticWorkerRequest;
}

function shapeDefinitions(value: unknown, budget: { remaining: number }): void {
  if (!Array.isArray(value) || value.length > MAX_SEMANTIC_DEFINITIONS_PER_REFERENCE) {
    throw new ParserProtocolError('protocol');
  }
  budget.remaining -= value.length;
  if (budget.remaining < 0) throw new ParserProtocolError('limit');
  for (const definition of value) {
    if (!isRecord(definition)) throw new ParserProtocolError('protocol');
    if (definition.kind === 'builtin') {
      strictRecord(definition, ['kind']);
      continue;
    }
    const user = strictRecord(definition, ['kind', 'fileId', 'nameRange', 'definiens']);
    if (
      user.kind !== 'user' ||
      typeof user.fileId !== 'string' ||
      typeof user.definiens !== 'string' ||
      !SEMANTIC_DEFINIENS_PATTERN.test(user.definiens)
    ) {
      throw new ParserProtocolError('protocol');
    }
    shapeRange(user.nameRange);
  }
}

/**
 * Validates the structure of a semantic-component reply: strict keys, bounded counts, enumerated
 * values and safe-integer ranges. Coordinate validity, site ownership and component membership
 * need source context and are checked by the parent adapter.
 */
export function validateSemanticReply(
  value: unknown,
  expected: {
    readonly requestId: number;
    readonly componentId: FileId;
    readonly maxNodes: number;
    readonly maxRecords: number;
  },
): SemanticWorkerReply {
  const record = strictRecord(value, [
    'protocolVersion',
    'requestId',
    'kind',
    'jobKind',
    'componentId',
    'consumedNodes',
    'result',
  ]);
  if (
    record.protocolVersion !== PARSER_PROTOCOL_VERSION ||
    record.kind !== 'result' ||
    record.jobKind !== 'semantic-component' ||
    record.requestId !== expected.requestId ||
    record.componentId !== expected.componentId ||
    !boundedInteger(record.consumedNodes, 0, expected.maxNodes)
  ) {
    throw new ParserProtocolError('protocol');
  }
  if (!isRecord(record.result)) throw new ParserProtocolError('protocol');
  if (record.result.status === 'unavailable') {
    const result = strictRecord(record.result, ['status', 'reason']);
    if (!SEMANTIC_UNAVAILABLE_REASONS.includes(String(result.reason))) {
      throw new ParserProtocolError('protocol');
    }
    return record as unknown as SemanticWorkerReply;
  }
  const result = strictRecord(record.result, ['status', 'grammar', 'baseSites', 'callSites']);
  if (
    result.status !== 'bound' ||
    typeof result.grammar !== 'string' ||
    !Array.isArray(result.baseSites) ||
    !Array.isArray(result.callSites) ||
    result.baseSites.length + result.callSites.length > expected.maxRecords
  ) {
    throw new ParserProtocolError('protocol');
  }
  const budget = {
    remaining: expected.maxRecords - result.baseSites.length - result.callSites.length,
  };
  for (const site of result.baseSites) {
    const item = strictRecord(site, [
      'fileId',
      'contractStartByte',
      'ordinal',
      'reference',
      'definitions',
    ]);
    if (
      typeof item.fileId !== 'string' ||
      !boundedInteger(item.contractStartByte, 0, Number.MAX_SAFE_INTEGER) ||
      !boundedInteger(item.ordinal, 0, MAX_SEMANTIC_ORDINAL)
    ) {
      throw new ParserProtocolError('protocol');
    }
    shapeRange(item.reference);
    shapeDefinitions(item.definitions, budget);
  }
  for (const site of result.callSites) {
    const item = strictRecord(site, [
      'fileId',
      'range',
      'callee',
      'definitions',
      'receiver',
      'receiverDefinitions',
    ]);
    if (
      typeof item.fileId !== 'string' ||
      !SEMANTIC_CALLEE_KINDS.includes(String(item.callee)) ||
      !SEMANTIC_RECEIVER_KINDS.includes(String(item.receiver))
    ) {
      throw new ParserProtocolError('protocol');
    }
    shapeRange(item.range);
    shapeDefinitions(item.definitions, budget);
    shapeDefinitions(item.receiverDefinitions, budget);
  }
  return record as unknown as SemanticWorkerReply;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
