import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { BudgetError, type DiscoveryBudget } from '../discovery/budget.ts';
import {
  callableIdentity,
  contractIdentity,
  edgeIdentity,
  fileIdentity,
} from '../domain/canonical.ts';
import type {
  ContractId,
  Diagnostic,
  FileId,
  ResolvedConfig,
  SourceRange,
} from '../domain/types.ts';
import {
  decodeJsonFrame,
  encodeFrame,
  FrameDecoder,
  MAX_DIAGNOSTICS_PER_FILE,
  MAX_DIAGNOSTIC_MESSAGE_BYTES,
  MAX_DIAGNOSTIC_MESSAGE_CODE_UNITS,
  MAX_EVENT_ATTRIBUTES,
  MAX_EVENT_LABEL_CODE_UNITS,
  MAX_EVENT_STRING_CODE_UNITS,
  MAX_DECLARATION_NAME_CODE_UNITS,
  MAX_IMPORT_SPECIFIER_CODE_UNITS,
  MAX_READY_VERSIONS,
  MAX_RECORDS_PER_FILE,
  MAX_RESPONSE_BYTES,
  MAX_SEMANTIC_BYTES_CEILING,
  MAX_SEMANTIC_FILES_CEILING,
  MAX_SEMANTIC_LOOKUPS_CEILING,
  MAX_SEMANTIC_NODES_CEILING,
  MAX_SEMANTIC_RECORDS_CEILING,
  MAX_SESSION_RESPONSE_BYTES,
  MAX_VERSION_CODE_UNITS,
  maxRequestFrameBytes,
  maxSemanticRequestFrameBytes,
  PARSER_PROTOCOL_VERSION,
  ParserProtocolError,
  validateReady,
  validateSemanticReply,
  validateWorkerReply,
} from './protocol.ts';
import type {
  ParseFileResult,
  ParserBatch,
  ParserDeclaration,
  ParserEvent,
  ParserSource,
  SemanticBaseSite,
  SemanticCallSite,
  SemanticComponentFile,
  SemanticDefinition,
  SemanticImportLookup,
  SemanticUnavailableReason,
  SemanticWorkerRequest,
  WorkerReady,
} from './protocol.ts';
import { isValidDomainRange, SourceCoordinateIndex } from './ranges.ts';
import { selectLanguageVersion } from './version-policy.ts';
import type { VersionAuthority } from './version-policy.ts';

const WORKER_HEAP_MIB: number = 64;
const WORKER_MAX_FILES: number = 32;
const WORKER_MAX_INPUT_BYTES: number = 8 * 1024 * 1024;
const TERMINATION_GRACE_MS: number = 100;
const TERMINATION_WATCHDOG_MS: number = 5_000;
const MAX_FILE_PATH_CODE_UNITS: number = 4_096;
const FIXED_DIAGNOSTIC_MESSAGES: readonly string[] = [
  'No Solidity version pragma is present; grammar selection used configured evidence.',
  'The metadata Solidity version hint is unsupported or incompatible and was ignored.',
  'No installed Solidity grammar satisfies this file.',
  'The Solidity file contains invalid syntax.',
  'The Solidity pragma is malformed.',
  'Parser traversal or record limits were exceeded.',
  'Parser output exceeded the configured response ceiling.',
  'The parser worker could not validate its syntax result.',
  'The parser did not preserve the original source bytes.',
  'The parser could not represent an import path as UTF-8.',
];

export interface ParserSessionOptions {
  readonly budget: DiscoveryBudget;
  readonly config: ResolvedConfig;
}

interface CachedResult {
  readonly byteHash: string;
  readonly result: ParseFileResult;
}

/** Cumulative internal session counters. Syntax and semantic work are reported separately. */
export interface ParserSessionCounters {
  readonly syntaxFiles: number;
  readonly syntaxBytes: number;
  readonly syntaxImports: number;
  readonly syntaxNodes: number;
  readonly semanticNodes: number;
  readonly responseBytes: number;
}

export type ParsedSyntax = Extract<ParseFileResult, { status: 'parsed' }>;

/** One member of a semantic component: its source and the accepted syntax result for it. */
export interface SemanticComponentMember {
  readonly source: ParserSource;
  readonly syntax: ParsedSyntax;
}

export interface SemanticComponentInput {
  /** The smallest member file ID. */
  readonly componentId: FileId;
  /** One exact installed grammar common to every member. */
  readonly grammar: string;
  readonly members: readonly SemanticComponentMember[];
  /** Resolved imports of the members, keyed by importer ID plus path-literal range. */
  readonly lookups: readonly SemanticImportLookup[];
  /** Remaining record allowance for sites and definition references. */
  readonly maxRecords: number;
}

export type SemanticFailure = SemanticUnavailableReason | 'protocol';

export type SemanticComponentOutcome =
  | {
      readonly status: 'bound';
      readonly componentId: FileId;
      readonly grammar: string;
      readonly baseSites: readonly SemanticBaseSite[];
      readonly callSites: readonly SemanticCallSite[];
      readonly consumedNodes: number;
    }
  | {
      readonly status: 'unavailable';
      readonly componentId: FileId;
      readonly reason: SemanticFailure;
      readonly consumedNodes: number;
    };

interface FileOutcome {
  readonly result: ParseFileResult;
  readonly consumedNodes: number;
  readonly consumedImports: number;
  readonly inputBytes: number;
  readonly responseBytes: number;
}

type JobTerminationKind = 'timeout' | 'deadline' | 'cancelled';

class JobTermination extends Error {
  public readonly kind: JobTerminationKind;

  public constructor(kind: JobTerminationKind) {
    super(kind === 'cancelled' ? 'Parser job was cancelled.' : 'Parser job exceeded its deadline.');
    this.name = 'JobTermination';
    this.kind = kind;
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error('Parser worker operation failed.');
}

function failedResult(
  fileId: FileId,
  code: 'LANGUAGE_UNSUPPORTED' | 'PARSE_INVALID' | 'LIMIT_EXCEEDED' | 'INTERNAL_ERROR',
  message: string,
): ParseFileResult {
  const diagnostic: Diagnostic = {
    code,
    severity: code === 'PARSE_INVALID' || code === 'INTERNAL_ERROR' ? 'error' : 'warning',
    phase: 'parse',
    message,
    fileId,
  };
  return { status: 'failed', fileId, code, diagnostics: [diagnostic] };
}

function codePointCompare(left: string, right: string): number {
  const leftPoints = Array.from(left, (scalar) => scalar.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (scalar) => scalar.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const a = leftPoints[index] ?? 0;
    const b = rightPoints[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return leftPoints.length < rightPoints.length
    ? -1
    : leftPoints.length > rightPoints.length
      ? 1
      : 0;
}

function versionCompare(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function rangeWithin(inner: SourceRange, outer: SourceRange): boolean {
  return inner.startByte >= outer.startByte && inner.endByte <= outer.endByte;
}

function validRange(value: unknown, index: SourceCoordinateIndex): value is SourceRange {
  if (!exactKeys(value, ['startByte', 'endByte', 'start', 'end'])) return false;
  const start = value.start;
  const end = value.end;
  if (
    !exactKeys(start, ['line', 'column']) ||
    !exactKeys(end, ['line', 'column']) ||
    !Number.isSafeInteger(value.startByte) ||
    !Number.isSafeInteger(value.endByte) ||
    !Number.isSafeInteger(start.line) ||
    !Number.isSafeInteger(start.column) ||
    !Number.isSafeInteger(end.line) ||
    !Number.isSafeInteger(end.column) ||
    (start.line as number) < 1 ||
    (start.column as number) < 1 ||
    (end.line as number) < 1 ||
    (end.column as number) < 1
  ) {
    return false;
  }
  return isValidDomainRange(value as unknown as SourceRange, index);
}

function validAttribute(value: unknown, keyPattern: RegExp, stringMaximum: number): boolean {
  if (!exactKeys(value, ['key', 'value'])) return false;
  if (
    typeof value.key !== 'string' ||
    value.key.length === 0 ||
    value.key.length > MAX_EVENT_LABEL_CODE_UNITS ||
    !keyPattern.test(value.key)
  ) {
    return false;
  }
  const attributeValue = value.value;
  if (attributeValue === null || typeof attributeValue === 'boolean') return true;
  if (typeof attributeValue === 'number') return Number.isFinite(attributeValue);
  return typeof attributeValue === 'string' && attributeValue.length <= stringMaximum;
}

function diagnosticIsValid(value: unknown, fileId: FileId, index: SourceCoordinateIndex): boolean {
  if (!isRecord(value)) return false;
  const allowed = ['code', 'severity', 'phase', 'message', 'fileId', 'range', 'details'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  if (
    typeof value.code !== 'string' ||
    ![
      'LANGUAGE_UNSUPPORTED',
      'PARSE_INVALID',
      'LIMIT_EXCEEDED',
      'INTERNAL_ERROR',
      'SEMANTICS_UNAVAILABLE',
    ].includes(value.code) ||
    !['info', 'warning', 'error'].includes(String(value.severity)) ||
    value.phase !== 'parse' ||
    typeof value.message !== 'string' ||
    value.message.length > MAX_DIAGNOSTIC_MESSAGE_CODE_UNITS ||
    Buffer.byteLength(value.message, 'utf8') > MAX_DIAGNOSTIC_MESSAGE_BYTES ||
    !FIXED_DIAGNOSTIC_MESSAGES.includes(value.message) ||
    value.fileId !== fileId
  ) {
    return false;
  }
  if (Object.hasOwn(value, 'range') && !validRange(value.range, index)) return false;
  if (Object.hasOwn(value, 'details')) {
    if (!Array.isArray(value.details) || value.details.length > 32) return false;
    const seen = new Set<string>();
    for (const detail of value.details) {
      if (!validAttribute(detail, /^[a-z]+(?:-[a-z]+)*$/u, MAX_EVENT_STRING_CODE_UNITS))
        return false;
      if (!isRecord(detail) || typeof detail.key !== 'string' || seen.has(detail.key)) return false;
      seen.add(detail.key);
    }
  }
  return true;
}

function validateVersionRecord(value: unknown): boolean {
  if (
    !exactKeys(value, [
      'selectedVersion',
      'selectionSource',
      'ignoredHint',
      'compatibleVersions',
      'installedVersions',
      'pragmaRanges',
      'parserVersion',
    ])
  ) {
    return false;
  }
  const exactVersion = (version: unknown): version is string =>
    typeof version === 'string' &&
    version.length <= MAX_VERSION_CODE_UNITS &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version);
  if (
    !exactVersion(value.selectedVersion) ||
    !['cli', 'config', 'metadata', 'inferred', 'latest-no-pragma'].includes(
      String(value.selectionSource),
    ) ||
    !['used', 'ignored', 'not-applicable'].includes(String(value.ignoredHint)) ||
    !Array.isArray(value.compatibleVersions) ||
    value.compatibleVersions.length > MAX_READY_VERSIONS ||
    !Array.isArray(value.installedVersions) ||
    value.installedVersions.length === 0 ||
    value.installedVersions.length > 256 ||
    !Array.isArray(value.pragmaRanges) ||
    typeof value.parserVersion !== 'string' ||
    value.parserVersion.length === 0 ||
    value.parserVersion.length > MAX_VERSION_CODE_UNITS
  ) {
    return false;
  }
  const installed = value.installedVersions;
  const compatible = value.compatibleVersions;
  if (
    installed.some((version) => !exactVersion(version)) ||
    compatible.some((version) => !exactVersion(version)) ||
    new Set(installed).size !== installed.length ||
    new Set(compatible).size !== compatible.length ||
    installed.some(
      (version, index) =>
        index > 0 && versionCompare(installed[index - 1] ?? '', version as string) >= 0,
    ) ||
    compatible.some(
      (version, index) =>
        index > 0 && versionCompare(compatible[index - 1] ?? '', version as string) >= 0,
    ) ||
    compatible.some((version) => !installed.includes(version)) ||
    !installed.includes(value.selectedVersion) ||
    value.pragmaRanges.length > MAX_RECORDS_PER_FILE
  ) {
    return false;
  }
  return true;
}

async function validationCheckpoint(
  budget: DiscoveryBudget,
  jobCheck: () => void,
  observer: ValidationObserver | undefined,
  fileId: FileId,
  phase: ValidationPhase,
  index: number,
): Promise<void> {
  await budget.checkpoint(true);
  if (observer !== undefined) await observer({ fileId, phase, index });
  jobCheck();
}

async function validateParsedResult(
  result: ParseFileResult,
  fileId: FileId,
  canonicalPath: string,
  sourceIndex: SourceCoordinateIndex,
  allowance: number,
  consumedNodes: number,
  budget: DiscoveryBudget,
  jobCheck: () => void,
  installedVersions: readonly string[],
  authority: { readonly source: VersionAuthority; readonly version: string },
  observer?: ValidationObserver,
): Promise<void> {
  if (result.status === 'failed') {
    if (
      !exactKeys(result, ['status', 'fileId', 'code', 'diagnostics']) ||
      result.fileId !== fileId ||
      !Array.isArray(result.diagnostics) ||
      result.diagnostics.length > MAX_DIAGNOSTICS_PER_FILE
    ) {
      throw new ParserProtocolError('protocol');
    }
    for (let index = 0; index < result.diagnostics.length; index += 1) {
      if ((index & 255) === 0)
        await validationCheckpoint(budget, jobCheck, observer, fileId, 'diagnostics', index);
      if (!diagnosticIsValid(result.diagnostics[index], fileId, sourceIndex)) {
        throw new ParserProtocolError('protocol');
      }
    }
    return;
  }

  if (
    !exactKeys(result, [
      'status',
      'fileId',
      'version',
      'tokens',
      'declarations',
      'imports',
      'events',
      'diagnostics',
      'visitedNodes',
    ]) ||
    result.fileId !== fileId ||
    !Number.isSafeInteger(result.visitedNodes) ||
    result.visitedNodes !== consumedNodes ||
    consumedNodes > allowance ||
    consumedNodes > MAX_RECORDS_PER_FILE ||
    !validateVersionRecord(result.version) ||
    !Array.isArray(result.tokens) ||
    !Array.isArray(result.declarations) ||
    !Array.isArray(result.imports) ||
    !Array.isArray(result.events) ||
    !Array.isArray(result.diagnostics) ||
    result.tokens.length > allowance ||
    result.declarations.length > allowance ||
    result.imports.length > allowance ||
    result.events.length > allowance ||
    result.diagnostics.length > MAX_DIAGNOSTICS_PER_FILE ||
    result.tokens.length +
      result.declarations.length +
      result.imports.length +
      result.events.length >
      consumedNodes
  ) {
    throw new ParserProtocolError('protocol');
  }

  if (
    result.version.installedVersions.length !== installedVersions.length ||
    result.version.installedVersions.some((version, index) => version !== installedVersions[index])
  ) {
    throw new ParserProtocolError('protocol');
  }
  let previousPragmaStart = -1;
  for (let index = 0; index < result.version.pragmaRanges.length; index += 1) {
    if ((index & 255) === 0)
      await validationCheckpoint(budget, jobCheck, observer, fileId, 'pragma-ranges', index);
    const range = result.version.pragmaRanges[index];
    if (!validRange(range, sourceIndex) || range.startByte < previousPragmaStart) {
      throw new ParserProtocolError('protocol');
    }
    previousPragmaStart = range.startByte;
  }
  const selection = selectLanguageVersion(
    {
      installedVersions,
      compatibleVersions: result.version.compatibleVersions,
      pragma: result.version.pragmaRanges.length === 0 ? 'absent' : 'valid',
    },
    authority,
  );
  if (
    selection.status !== 'selected' ||
    selection.version !== result.version.selectedVersion ||
    selection.source !== result.version.selectionSource ||
    selection.ignoredHint !== result.version.ignoredHint ||
    selection.compatibleVersions.length !== result.version.compatibleVersions.length ||
    selection.compatibleVersions.some(
      (version, index) => version !== result.version.compatibleVersions[index],
    )
  ) {
    throw new ParserProtocolError('protocol');
  }
  const expectedWarningMessages = selection.warnings.map((warningCode) =>
    warningCode === 'no-version-pragma'
      ? 'No Solidity version pragma is present; grammar selection used configured evidence.'
      : 'The metadata Solidity version hint is unsupported or incompatible and was ignored.',
  );
  const actualWarningMessages = result.diagnostics
    .filter((diagnostic) => diagnostic.code === 'LANGUAGE_UNSUPPORTED')
    .map((diagnostic) => diagnostic.message);
  if (
    expectedWarningMessages.length !== actualWarningMessages.length ||
    expectedWarningMessages.some((message, index) => message !== actualWarningMessages[index])
  ) {
    throw new ParserProtocolError('protocol');
  }

  for (let index = 0; index < result.diagnostics.length; index += 1) {
    if ((index & 255) === 0)
      await validationCheckpoint(budget, jobCheck, observer, fileId, 'diagnostics', index);
    if (!diagnosticIsValid(result.diagnostics[index], fileId, sourceIndex)) {
      throw new ParserProtocolError('protocol');
    }
  }

  const contractRanges = new Map<string, SourceRange>();
  const callableRanges = new Map<string, SourceRange>();
  const declarationIds = new Set<string>();
  for (let index = 0; index < result.declarations.length; index += 1) {
    if ((index & 255) === 0)
      await validationCheckpoint(budget, jobCheck, observer, fileId, 'declarations', index);
    const declaration = result.declarations[index];
    if (
      !isRecord(declaration) ||
      !exactKeys(declaration, [
        'id',
        'kind',
        'name',
        'contractId',
        'callableId',
        'declarationRange',
        'nameRange',
        'bodyRange',
        'hasBody',
        'attributes',
      ]) ||
      typeof declaration.id !== 'string' ||
      typeof declaration.kind !== 'string' ||
      !/^[a-z]+(?:-[a-z]+)*$/u.test(declaration.kind) ||
      declaration.kind.length > MAX_EVENT_LABEL_CODE_UNITS ||
      typeof declaration.name !== 'string' ||
      declaration.name.length > MAX_DECLARATION_NAME_CODE_UNITS ||
      typeof declaration.hasBody !== 'boolean' ||
      !validRange(declaration.declarationRange, sourceIndex) ||
      !validRange(declaration.nameRange, sourceIndex) ||
      !rangeWithin(declaration.nameRange, declaration.declarationRange) ||
      (declaration.bodyRange !== null &&
        (!validRange(declaration.bodyRange, sourceIndex) ||
          !rangeWithin(declaration.bodyRange, declaration.declarationRange))) ||
      declaration.hasBody !== (declaration.bodyRange !== null) ||
      !Array.isArray(declaration.attributes) ||
      declaration.attributes.length > MAX_EVENT_ATTRIBUTES
    ) {
      throw new ParserProtocolError('protocol');
    }
    const seenAttributes = new Set<string>();
    for (const attribute of declaration.attributes) {
      if (!validAttribute(attribute, /^[a-z]+(?:-[a-z]+)*$/u, MAX_EVENT_STRING_CODE_UNITS)) {
        throw new ParserProtocolError('protocol');
      }
      if (
        !isRecord(attribute) ||
        typeof attribute.key !== 'string' ||
        seenAttributes.has(attribute.key)
      ) {
        throw new ParserProtocolError('protocol');
      }
      seenAttributes.add(attribute.key);
    }
    const startByte = declaration.declarationRange.startByte;
    const contractKind = ['contract', 'abstract-contract', 'library', 'interface'].includes(
      declaration.kind,
    );
    const expectedId = contractKind
      ? contractIdentity(canonicalPath, declaration.kind, startByte)
      : callableIdentity(canonicalPath, declaration.kind, startByte);
    if (declaration.id !== expectedId || declarationIds.has(expectedId)) {
      throw new ParserProtocolError('protocol');
    }
    declarationIds.add(expectedId);
    if (contractKind) {
      if (
        declaration.contractId !== expectedId ||
        declaration.callableId !== null ||
        (declaration.id as ContractId) !== expectedId
      ) {
        throw new ParserProtocolError('protocol');
      }
      contractRanges.set(expectedId, declaration.declarationRange);
    } else {
      if (
        declaration.callableId !== expectedId ||
        (declaration.contractId !== null && typeof declaration.contractId !== 'string')
      ) {
        throw new ParserProtocolError('protocol');
      }
      callableRanges.set(expectedId, declaration.declarationRange);
    }
  }

  for (const declaration of result.declarations) {
    if (declaration.contractId !== null) {
      const owner = contractRanges.get(declaration.contractId);
      if (
        owner === undefined ||
        (declaration.callableId !== null && !rangeWithin(declaration.declarationRange, owner))
      ) {
        throw new ParserProtocolError('protocol');
      }
    }
  }

  for (let index = 0; index < result.tokens.length; index += 1) {
    if ((index & 255) === 0)
      await validationCheckpoint(budget, jobCheck, observer, fileId, 'tokens', index);
    const token = result.tokens[index];
    if (
      !exactKeys(token, ['fileId', 'kind', 'range']) ||
      token.fileId !== fileId ||
      ![
        'whitespace',
        'comment',
        'natspec',
        'string',
        'identifier',
        'keyword',
        'operator',
        'punctuation',
        'unknown',
      ].includes(String(token.kind)) ||
      !validRange(token.range, sourceIndex)
    ) {
      throw new ParserProtocolError('protocol');
    }
  }

  for (let index = 0; index < result.imports.length; index += 1) {
    if ((index & 255) === 0)
      await validationCheckpoint(budget, jobCheck, observer, fileId, 'imports', index);
    const item = result.imports[index];
    if (
      !exactKeys(item, ['id', 'specifier', 'range', 'specifierRange', 'aliasForm']) ||
      typeof item.id !== 'string' ||
      typeof item.specifier !== 'string' ||
      item.specifier.length > MAX_IMPORT_SPECIFIER_CODE_UNITS ||
      !validRange(item.range, sourceIndex) ||
      !validRange(item.specifierRange, sourceIndex) ||
      !rangeWithin(item.specifierRange, item.range) ||
      !['bare', 'namespace', 'named'].includes(String(item.aliasForm)) ||
      item.id !== edgeIdentity(canonicalPath, 'import', item.range.startByte, index)
    ) {
      throw new ParserProtocolError('protocol');
    }
  }

  for (let index = 0; index < result.events.length; index += 1) {
    if ((index & 255) === 0)
      await validationCheckpoint(budget, jobCheck, observer, fileId, 'events', index);
    const event = result.events[index];
    if (
      !exactKeys(event, ['fileId', 'kind', 'contractId', 'callableId', 'range', 'attributes']) ||
      event.fileId !== fileId ||
      (event.contractId !== null && typeof event.contractId !== 'string') ||
      (event.callableId !== null && typeof event.callableId !== 'string') ||
      typeof event.kind !== 'string' ||
      event.kind.length === 0 ||
      event.kind.length > MAX_EVENT_LABEL_CODE_UNITS ||
      !/^[a-z]+(?:-[a-z]+)*$/u.test(event.kind) ||
      !validRange(event.range, sourceIndex) ||
      !Array.isArray(event.attributes) ||
      event.attributes.length > MAX_EVENT_ATTRIBUTES
    ) {
      throw new ParserProtocolError('protocol');
    }
    const keys = new Set<string>();
    for (const attribute of event.attributes) {
      if (!validAttribute(attribute, /^[a-z]+(?:-[a-z]+)*$/u, MAX_EVENT_STRING_CODE_UNITS)) {
        throw new ParserProtocolError('protocol');
      }
      if (!isRecord(attribute) || typeof attribute.key !== 'string' || keys.has(attribute.key)) {
        throw new ParserProtocolError('protocol');
      }
      keys.add(attribute.key);
    }
    const contractId = event.contractId;
    if (typeof contractId === 'string') {
      const owner = contractRanges.get(contractId);
      if (owner === undefined || !rangeWithin(event.range, owner))
        throw new ParserProtocolError('protocol');
    }
    const callableId = event.callableId;
    if (typeof callableId === 'string') {
      const owner = callableRanges.get(callableId);
      if (owner === undefined || !rangeWithin(event.range, owner))
        throw new ParserProtocolError('protocol');
    }
  }
}

interface SemanticMemberIndex {
  readonly fileId: FileId;
  readonly index: SourceCoordinateIndex;
  readonly contractsByStart: ReadonlyMap<number, ParserDeclaration>;
  readonly declarationsByName: ReadonlyMap<string, ParserDeclaration>;
  readonly callEvents: ReadonlyMap<string, ParserEvent>;
}

const CONTRACT_DECLARATION_KINDS: readonly string[] = [
  'contract',
  'abstract-contract',
  'library',
  'interface',
];
const DEFINIENS_DECLARATION_KINDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['ContractDefinition', ['contract', 'abstract-contract']],
  ['LibraryDefinition', ['library']],
  ['InterfaceDefinition', ['interface']],
  ['FunctionDefinition', ['function']],
  ['FreeFunctionDefinition', ['function']],
  ['ModifierDefinition', ['modifier']],
]);
const CALLEE_SHAPE_FOR_KIND: ReadonlyMap<string, readonly string[]> = new Map([
  ['identifier', ['identifier']],
  ['member', ['member']],
  ['new', ['new']],
  ['elementary-type', ['other']],
  ['other', ['other']],
]);

function spanKey(range: SourceRange): string {
  return `${range.startByte}:${range.endByte}`;
}

function buildSemanticIndexes(
  members: readonly SemanticComponentMember[],
  texts: ReadonlyMap<FileId, string>,
): Map<FileId, SemanticMemberIndex> {
  const indexes = new Map<FileId, SemanticMemberIndex>();
  for (const member of members) {
    const text = texts.get(member.source.fileId);
    if (text === undefined) throw new ParserProtocolError('protocol');
    const contractsByStart = new Map<number, ParserDeclaration>();
    const declarationsByName = new Map<string, ParserDeclaration>();
    for (const declaration of member.syntax.declarations) {
      if (CONTRACT_DECLARATION_KINDS.includes(declaration.kind)) {
        contractsByStart.set(declaration.declarationRange.startByte, declaration);
      }
      declarationsByName.set(spanKey(declaration.nameRange), declaration);
    }
    const callEvents = new Map<string, ParserEvent>();
    for (const event of member.syntax.events) {
      if (event.kind !== 'call-site') continue;
      const key = spanKey(event.range);
      if (callEvents.has(key)) throw new ParserProtocolError('protocol');
      callEvents.set(key, event);
    }
    indexes.set(member.source.fileId, {
      fileId: member.source.fileId,
      index: new SourceCoordinateIndex(text),
      contractsByStart,
      declarationsByName,
      callEvents,
    });
  }
  return indexes;
}

function checkSemanticDefinition(
  definition: SemanticDefinition,
  members: ReadonlyMap<FileId, SemanticMemberIndex>,
): void {
  if (definition.kind === 'builtin') return;
  const member = members.get(definition.fileId);
  if (member === undefined || !validRange(definition.nameRange, member.index)) {
    throw new ParserProtocolError('protocol');
  }
  const declaration = member.declarationsByName.get(spanKey(definition.nameRange));
  const expected = DEFINIENS_DECLARATION_KINDS.get(definition.definiens);
  if (declaration !== undefined) {
    if (expected === undefined || !expected.includes(declaration.kind)) {
      throw new ParserProtocolError('protocol');
    }
  } else if (expected !== undefined) {
    throw new ParserProtocolError('protocol');
  }
}

function checkSemanticDefinitions(
  definitions: readonly SemanticDefinition[],
  members: ReadonlyMap<FileId, SemanticMemberIndex>,
): void {
  const seen = new Set<string>();
  for (const definition of definitions) {
    checkSemanticDefinition(definition, members);
    if (definition.kind === 'user') {
      const key = `${definition.fileId}\u0000${spanKey(definition.nameRange)}`;
      if (seen.has(key)) throw new ParserProtocolError('protocol');
      seen.add(key);
    }
  }
}

/**
 * Contextual validation of a structurally valid semantic reply: component membership, original-byte
 * coordinates, site ownership against the accepted syntax, exact call-site coverage, and that no
 * definition forges a declaration kind. Yields and checks the shared budget and job cutoff every 256
 * records.
 */
async function validateSemanticSites(
  baseSites: readonly SemanticBaseSite[],
  callSites: readonly SemanticCallSite[],
  members: ReadonlyMap<FileId, SemanticMemberIndex>,
  componentId: FileId,
  budget: DiscoveryBudget,
  jobCheck: () => void,
  observer: ValidationObserver | undefined,
): Promise<void> {
  const seenBases = new Set<string>();
  const ordinals = new Map<string, number[]>();
  for (let index = 0; index < baseSites.length; index += 1) {
    if ((index & 255) === 0) {
      await validationCheckpoint(
        budget,
        jobCheck,
        observer,
        componentId,
        'semantic-base-sites',
        index,
      );
    }
    const site = baseSites[index];
    if (site === undefined) continue;
    const member = members.get(site.fileId);
    const declaration = member?.contractsByStart.get(site.contractStartByte);
    if (
      member === undefined ||
      declaration === undefined ||
      declaration.kind === 'library' ||
      !validRange(site.reference, member.index) ||
      !rangeWithin(site.reference, declaration.declarationRange) ||
      (declaration.bodyRange !== null && site.reference.endByte > declaration.bodyRange.startByte)
    ) {
      throw new ParserProtocolError('protocol');
    }
    const key = `${site.fileId}\u0000${site.contractStartByte}\u0000${site.ordinal}`;
    if (seenBases.has(key)) throw new ParserProtocolError('protocol');
    seenBases.add(key);
    const contractKey = `${site.fileId}\u0000${site.contractStartByte}`;
    const list = ordinals.get(contractKey) ?? [];
    list.push(site.ordinal);
    ordinals.set(contractKey, list);
    checkSemanticDefinitions(site.definitions, members);
  }
  for (const list of ordinals.values()) {
    list.sort((left, right) => left - right);
    if (list.some((ordinal, position) => ordinal !== position)) {
      throw new ParserProtocolError('protocol');
    }
  }

  let expectedCalls = 0;
  for (const member of members.values()) expectedCalls += member.callEvents.size;
  if (callSites.length !== expectedCalls) throw new ParserProtocolError('protocol');
  const seenCalls = new Set<string>();
  for (let index = 0; index < callSites.length; index += 1) {
    if ((index & 255) === 0) {
      await validationCheckpoint(
        budget,
        jobCheck,
        observer,
        componentId,
        'semantic-call-sites',
        index,
      );
    }
    const site = callSites[index];
    if (site === undefined) continue;
    const member = members.get(site.fileId);
    if (member === undefined || !validRange(site.range, member.index)) {
      throw new ParserProtocolError('protocol');
    }
    const event = member.callEvents.get(spanKey(site.range));
    const shape = event?.attributes.find((attribute) => attribute.key === 'callee-shape')?.value;
    const key = `${site.fileId}\u0000${spanKey(site.range)}`;
    if (
      event === undefined ||
      seenCalls.has(key) ||
      typeof shape !== 'string' ||
      !(CALLEE_SHAPE_FOR_KIND.get(site.callee) ?? []).includes(shape) ||
      (site.callee === 'member') !== (site.receiver !== 'none') ||
      (site.receiver !== 'identifier' && site.receiverDefinitions.length > 0) ||
      (site.callee !== 'identifier' && site.callee !== 'member' && site.definitions.length > 0)
    ) {
      throw new ParserProtocolError('protocol');
    }
    seenCalls.add(key);
    checkSemanticDefinitions(site.definitions, members);
    checkSemanticDefinitions(site.receiverDefinitions, members);
  }
}

class WorkerConnection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly #decoder = new FrameDecoder(MAX_RESPONSE_BYTES);
  readonly #frames: Buffer[] = [];
  readonly #waiters: { resolve: (frame: Buffer) => void; reject: (error: Error) => void }[] = [];
  readonly #closePromise: Promise<void>;
  #closeResolve: (() => void) | undefined;
  #failure: Error | undefined;
  #closed = false;
  #termination: Promise<void> | undefined;

  public constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.#closePromise = new Promise<void>((resolvePromise) => {
      this.#closeResolve = resolvePromise;
    });
    child.stdout.on('data', (chunk: Buffer) => this.#onStdout(chunk));
    child.stdout.on('error', (error: Error) => this.#fail(error));
    child.stderr.on('data', () => undefined);
    child.stdin.on('error', (error: Error) => this.#fail(error));
    child.on('error', (error: Error) => this.#fail(error));
    child.on('close', () => {
      this.#closed = true;
      try {
        this.#decoder.finish();
      } catch (error: unknown) {
        this.#fail(toError(error));
      }
      this.#closeResolve?.();
      this.#fail(new Error('Parser worker closed before the request completed.'));
    });
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public get hasQueuedFrames(): boolean {
    return this.#frames.length > 0;
  }

  public async nextFrame(): Promise<Buffer> {
    const frame = this.#frames.shift();
    if (frame !== undefined) return frame;
    if (this.#failure !== undefined) throw this.#failure;
    return await new Promise<Buffer>((resolvePromise, rejectPromise) => {
      this.#waiters.push({ resolve: resolvePromise, reject: rejectPromise });
    });
  }

  public async send(frame: Buffer): Promise<void> {
    if (this.#closed || this.child.stdin.destroyed)
      throw new Error('Parser worker input is closed.');
    if (this.child.stdin.write(frame)) return;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onDrain = () => {
        this.child.stdin.off('error', onError);
        resolvePromise();
      };
      const onError = (error: Error) => {
        this.child.stdin.off('drain', onDrain);
        rejectPromise(error);
      };
      this.child.stdin.once('drain', onDrain);
      this.child.stdin.once('error', onError);
    });
  }

  public async terminate(): Promise<void> {
    if (this.#termination !== undefined) return await this.#termination;
    this.#termination = this.#terminate();
    return await this.#termination;
  }

  #onStdout(chunk: Buffer): void {
    if (this.#failure !== undefined) return;
    try {
      for (const frame of this.#decoder.push(chunk)) {
        const waiter = this.#waiters.shift();
        if (waiter === undefined) {
          if (this.#frames.length >= 1) throw new ParserProtocolError('protocol');
          this.#frames.push(frame);
        } else waiter.resolve(frame);
      }
    } catch (error: unknown) {
      this.#fail(toError(error));
    }
  }

  #fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  async #terminate(): Promise<void> {
    if (!this.#closed) {
      this.child.kill('SIGTERM');
      const gracefullyClosed = await closesWithin(this.#closePromise, TERMINATION_GRACE_MS);
      if (!gracefullyClosed) {
        this.child.kill('SIGKILL');
        const forciblyClosed = await closesWithin(this.#closePromise, TERMINATION_WATCHDOG_MS);
        if (!forciblyClosed)
          throw new Error('Parser worker did not close within the cleanup watchdog.');
      }
    }
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}

async function closesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolvePromise) => {
      timeout = setTimeout(() => resolvePromise(false), milliseconds);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  return result;
}

class JobGuard {
  readonly cutoff: number;
  readonly #signal: AbortSignal | undefined;
  readonly #budget: DiscoveryBudget;
  readonly #usesApplicationDeadline: boolean;
  readonly #interruption: Promise<never>;
  #rejectInterruption: ((error: JobTermination) => void) | undefined;
  #timer: NodeJS.Timeout | undefined;
  #termination: JobTermination | undefined;
  #worker: WorkerConnection | undefined;
  readonly #abortListener: (() => void) | undefined;

  public constructor(budget: DiscoveryBudget, timeoutMs: number) {
    this.#budget = budget;
    this.#signal = budget.signal;
    const start = performance.now();
    this.#usesApplicationDeadline = budget.deadlineAt <= start + timeoutMs;
    this.cutoff = Math.min(budget.deadlineAt, start + timeoutMs);
    this.#interruption = new Promise<never>((_resolve, reject) => {
      this.#rejectInterruption = reject;
    });
    void this.#interruption.catch(() => undefined);
    const abortListener = () => this.#interrupt('cancelled');
    this.#abortListener = abortListener;
    if (this.#signal !== undefined)
      this.#signal.addEventListener('abort', abortListener, { once: true });
    const remaining = Math.max(0, this.cutoff - performance.now());
    this.#timer = setTimeout(
      () => this.#interrupt(this.#usesApplicationDeadline ? 'deadline' : 'timeout'),
      remaining,
    );
    if (this.#signal?.aborted === true) this.#interrupt('cancelled');
  }

  public setWorker(worker: WorkerConnection): void {
    this.#worker = worker;
    if (this.#termination !== undefined) void worker.terminate().catch(() => undefined);
  }

  public check(): void {
    if (this.#termination !== undefined) throw this.#termination;
    if (this.#signal?.aborted === true) {
      this.#interrupt('cancelled');
      throw this.#termination;
    }
    if (performance.now() >= this.cutoff) {
      this.#interrupt(this.#usesApplicationDeadline ? 'deadline' : 'timeout');
      throw this.#termination;
    }
    try {
      this.#budget.check();
    } catch (error: unknown) {
      if (error instanceof BudgetError && error.kind === 'cancelled') this.#interrupt('cancelled');
      if (error instanceof BudgetError && error.kind === 'deadline') this.#interrupt('deadline');
      if (this.#termination !== undefined) throw this.#termination;
      throw error;
    }
  }

  public async race<T>(promise: Promise<T>): Promise<T> {
    this.check();
    return await Promise.race([promise, this.#interruption]);
  }

  public dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#signal !== undefined && this.#abortListener !== undefined) {
      this.#signal.removeEventListener('abort', this.#abortListener);
    }
  }

  public get termination(): JobTermination | undefined {
    return this.#termination;
  }

  public cancel(): void {
    this.#interrupt('cancelled');
  }

  #interrupt(kind: JobTerminationKind): void {
    if (this.#termination !== undefined) return;
    this.#termination = new JobTermination(kind);
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#rejectInterruption?.(this.#termination);
    if (this.#worker !== undefined) void this.#worker.terminate().catch(() => undefined);
  }
}

function trustedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'ComSpec', 'PATHEXT']) {
      const value = process.env[key];
      if (value !== undefined) environment[key] = value;
    }
  }
  return environment;
}

function packageWorkerPaths(): { readonly workerPath: string; readonly packageRoot: string } {
  const packageEntry = new URL(import.meta.resolve('audit-estimator'));
  if (packageEntry.protocol !== 'file:') throw new Error('Package entry is not a local file.');
  return {
    workerPath: fileURLToPath(new URL('./parser/worker.js', packageEntry)),
    packageRoot: resolve(fileURLToPath(new URL('../', packageEntry))),
  };
}

function spawnWorker(): WorkerConnection {
  const paths = packageWorkerPaths();
  const child = spawn(
    process.execPath,
    [`--max-old-space-size=${WORKER_HEAP_MIB}`, paths.workerPath],
    {
      cwd: paths.packageRoot,
      env: trustedEnvironment(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  return new WorkerConnection(child);
}

function versionAuthority(config: ResolvedConfig): VersionAuthority {
  const source =
    config.provenance.find((item) => item.field === 'solidity.version')?.source ?? 'default';
  return source;
}

function sourceBytes(source: ParserSource): {
  readonly bytes: Buffer;
  readonly text: string;
  readonly hash: string;
} {
  const bytes = Buffer.from(source.snapshot.originalBytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new TypeError('Source snapshot is not valid UTF-8.');
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (text !== source.snapshot.originalText || hash !== source.snapshot.byteHash) {
    throw new TypeError('Source snapshot text or hash does not match its original bytes.');
  }
  return { bytes, text, hash };
}

function validateSourceIdentity(source: ParserSource, hash: string): void {
  validateSourceMetadata(source);
  if (source.manifestEntry.byteHash !== hash) {
    throw new TypeError('Source identity does not match the discovery manifest.');
  }
}

function validateSourceMetadata(source: ParserSource): number {
  const expectedId = fileIdentity(source.snapshot.canonicalPath);
  if (
    source.fileId !== expectedId ||
    source.manifestEntry.fileId !== expectedId ||
    source.manifestEntry.path !== source.snapshot.canonicalPath ||
    source.snapshot.canonicalPath.length > MAX_FILE_PATH_CODE_UNITS ||
    !(source.snapshot.originalBytes instanceof Uint8Array) ||
    !Number.isSafeInteger(source.snapshot.originalBytes.byteLength)
  ) {
    throw new TypeError('Source identity does not match the discovery manifest.');
  }
  return source.snapshot.originalBytes.byteLength;
}

function stopDiagnostic(fileId: FileId, message: string): ParseFileResult {
  return failedResult(fileId, 'LIMIT_EXCEEDED', message);
}

function copyResult(result: ParseFileResult): ParseFileResult {
  return result;
}

type WorkerFactory = () => WorkerConnection;

type ValidationPhase =
  | 'diagnostics'
  | 'declarations'
  | 'tokens'
  | 'imports'
  | 'events'
  | 'pragma-ranges'
  | 'semantic-base-sites'
  | 'semantic-call-sites';

interface ValidationCheckpoint {
  readonly fileId: FileId;
  readonly phase: ValidationPhase;
  readonly index: number;
}

type ValidationObserver = (checkpoint: ValidationCheckpoint) => void | Promise<void>;

class ParserSession {
  readonly #budget: DiscoveryBudget;
  readonly #config: ResolvedConfig;
  readonly #cache = new Map<FileId, CachedResult>();
  #worker: WorkerConnection | undefined;
  #requestId = 0;
  #visitedNodes = 0;
  #semanticNodes = 0;
  #imports = 0;
  #responseBytes = 0;
  #processedBytes = 0;
  #filesAnalyzed = 0;
  #filesSinceRecycle = 0;
  #bytesSinceRecycle = 0;
  #ready: WorkerReady | undefined;
  #activeGuard: JobGuard | undefined;
  #analyzing = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  readonly #workerFactory: WorkerFactory;
  readonly #validationObserver: ValidationObserver | undefined;

  public constructor(
    options: ParserSessionOptions,
    workerFactory: WorkerFactory = spawnWorker,
    validationObserver?: ValidationObserver,
  ) {
    this.#budget = options.budget;
    this.#config = options.config;
    this.#workerFactory = workerFactory;
    this.#validationObserver = validationObserver;
    this.#budget.assertLimitsMatch(options.config.analysis.limits);
  }

  #totalNodes(): number {
    return this.#visitedNodes + this.#semanticNodes;
  }

  /** Readonly snapshot of cumulative session accounting. */
  public get counters(): ParserSessionCounters {
    return {
      syntaxFiles: this.#filesAnalyzed,
      syntaxBytes: this.#processedBytes,
      syntaxImports: this.#imports,
      syntaxNodes: this.#visitedNodes,
      semanticNodes: this.#semanticNodes,
      responseBytes: this.#responseBytes,
    };
  }

  /**
   * Returns the accepted syntax outcome cached for exactly this identity and byte hash, if any.
   * Callers use it to prove that a supplied batch came from this session.
   */
  public cachedSyntax(fileId: FileId, byteHash: string): ParseFileResult | undefined {
    const cached = this.#cache.get(fileId);
    return cached !== undefined && cached.byteHash === byteHash ? cached.result : undefined;
  }

  public async analyzeSources(sources: readonly ParserSource[]): Promise<ParserBatch> {
    if (this.#closed) throw new Error('Parser session is closed.');
    if (this.#analyzing) throw new Error('Parser session already has an active analysis batch.');
    this.#analyzing = true;
    try {
      return await this.#analyzeSources(sources);
    } finally {
      this.#analyzing = false;
    }
  }

  async #analyzeSources(sources: readonly ParserSource[]): Promise<ParserBatch> {
    const ordered = [...sources].sort((left, right) => codePointCompare(left.fileId, right.fileId));
    const results: ParseFileResult[] = [];
    const batchDiagnostics: Diagnostic[] = [];
    let batchVisitedNodes = 0;
    let batchProcessedBytes = 0;
    let complete = true;
    let globalStop: 'deadline' | 'nodes' | 'imports' | 'files' | 'bytes' | 'response' | null = null;
    let sessionDeadlineReached = false;
    const seen = new Set<FileId>();

    const checkSessionBudget = async (yieldNow: boolean): Promise<void> => {
      try {
        if (yieldNow) await this.#budget.checkpoint(true);
        else this.#budget.check();
      } catch (error: unknown) {
        if (error instanceof BudgetError && error.kind === 'cancelled') {
          await this.close();
          throw error;
        }
        if (error instanceof BudgetError && error.kind === 'deadline') {
          globalStop = 'deadline';
          sessionDeadlineReached = true;
          complete = false;
          return;
        }
        throw error;
      }
    };

    await checkSessionBudget(true);

    for (let index = 0; index < ordered.length; index += 1) {
      await checkSessionBudget((index & 255) === 0);
      const source = ordered[index];
      if (source === undefined) continue;
      if (seen.has(source.fileId)) {
        const duplicate = failedResult(
          source.fileId,
          'INTERNAL_ERROR',
          'Duplicate source identity in parser input.',
        );
        results.push(duplicate);
        batchDiagnostics.push(...duplicate.diagnostics);
        complete = false;
        continue;
      }
      seen.add(source.fileId);

      if (sessionDeadlineReached) {
        const limited = stopDiagnostic(source.fileId, stopMessage('deadline'));
        results.push(limited);
        batchDiagnostics.push(...limited.diagnostics);
        complete = false;
        continue;
      }

      const cached = this.#cache.get(source.fileId);
      let sourceByteLength: number;
      try {
        sourceByteLength = validateSourceMetadata(source);
      } catch {
        const invalid = failedResult(
          source.fileId,
          'INTERNAL_ERROR',
          'The source snapshot failed identity validation.',
        );
        results.push(invalid);
        batchDiagnostics.push(...invalid.diagnostics);
        complete = false;
        continue;
      }
      if (sourceByteLength > this.#config.analysis.limits.maxFileBytes) {
        this.#filesAnalyzed += 1;
        const limited = stopDiagnostic(
          source.fileId,
          'Parser source exceeds the configured per-file byte limit.',
        );
        results.push(limited);
        batchDiagnostics.push(...limited.diagnostics);
        complete = false;
        continue;
      }
      if (cached === undefined) {
        if (this.#filesAnalyzed >= this.#config.analysis.limits.maxFiles) globalStop = 'files';
        if (this.#totalNodes() >= this.#config.analysis.limits.maxAstNodesTotal)
          globalStop = 'nodes';
        if (this.#imports >= this.#config.analysis.limits.maxImports) globalStop = 'imports';
        if (
          this.#processedBytes + sourceByteLength >
          this.#config.analysis.limits.maxTotalSourceBytes
        ) {
          globalStop = 'bytes';
        }
        if (this.#responseBytes >= MAX_SESSION_RESPONSE_BYTES) globalStop = 'response';
        if (globalStop !== null) {
          const limited = stopDiagnostic(source.fileId, stopMessage(globalStop));
          results.push(limited);
          batchDiagnostics.push(...limited.diagnostics);
          complete = false;
          continue;
        }
      }
      let identity: { readonly bytes: Buffer; readonly text: string; readonly hash: string };
      try {
        identity = sourceBytes(source);
        validateSourceIdentity(source, identity.hash);
      } catch {
        const invalid = failedResult(
          source.fileId,
          'INTERNAL_ERROR',
          'The source snapshot failed identity validation.',
        );
        results.push(invalid);
        batchDiagnostics.push(...invalid.diagnostics);
        complete = false;
        continue;
      }
      if (cached !== undefined) {
        if (cached.byteHash !== identity.hash) {
          const changed = failedResult(
            source.fileId,
            'INTERNAL_ERROR',
            'A cached file identity was reused with different bytes.',
          );
          results.push(changed);
          batchDiagnostics.push(...changed.diagnostics);
          complete = false;
        } else {
          const result = copyResult(cached.result);
          results.push(result);
          batchDiagnostics.push(...result.diagnostics);
          if (result.status === 'failed') complete = false;
        }
        continue;
      }

      if (globalStop !== null) {
        const message = stopMessage(globalStop);
        const limited = stopDiagnostic(source.fileId, message);
        results.push(limited);
        batchDiagnostics.push(...limited.diagnostics);
        complete = false;
        continue;
      }

      if (this.#filesAnalyzed >= this.#config.analysis.limits.maxFiles) globalStop = 'files';
      if (this.#totalNodes() >= this.#config.analysis.limits.maxAstNodesTotal) globalStop = 'nodes';
      if (this.#imports >= this.#config.analysis.limits.maxImports) globalStop = 'imports';
      if (
        this.#processedBytes + identity.bytes.byteLength >
        this.#config.analysis.limits.maxTotalSourceBytes
      ) {
        globalStop = 'bytes';
      }
      if (this.#responseBytes >= MAX_SESSION_RESPONSE_BYTES) globalStop = 'response';
      if (globalStop !== null) {
        const limited = stopDiagnostic(source.fileId, stopMessage(globalStop));
        results.push(limited);
        batchDiagnostics.push(...limited.diagnostics);
        complete = false;
        continue;
      }

      if (identity.bytes.byteLength > this.#config.analysis.limits.maxFileBytes) {
        this.#filesAnalyzed += 1;
        const limited = stopDiagnostic(
          source.fileId,
          'Parser source exceeds the configured per-file byte limit.',
        );
        this.#cache.set(source.fileId, { byteHash: identity.hash, result: limited });
        results.push(limited);
        batchDiagnostics.push(...limited.diagnostics);
        complete = false;
        continue;
      }

      const nodeAllowance = Math.min(
        this.#config.analysis.limits.maxAstNodesPerFile,
        this.#config.analysis.limits.maxAstNodesTotal - this.#totalNodes(),
      );
      const importAllowance = this.#config.analysis.limits.maxImports - this.#imports;
      this.#filesAnalyzed += 1;
      const outcome = await this.#parseSource(source, identity, nodeAllowance, importAllowance);
      this.#visitedNodes += outcome.consumedNodes;
      this.#imports += outcome.consumedImports;
      this.#processedBytes += outcome.inputBytes;
      this.#responseBytes += outcome.responseBytes;
      this.#filesSinceRecycle += 1;
      this.#bytesSinceRecycle += outcome.inputBytes;
      batchVisitedNodes += outcome.consumedNodes;
      this.#cache.set(source.fileId, { byteHash: identity.hash, result: outcome.result });
      results.push(outcome.result);
      batchDiagnostics.push(...outcome.result.diagnostics);
      if (outcome.result.status === 'failed') complete = false;

      if (this.#totalNodes() >= this.#config.analysis.limits.maxAstNodesTotal) globalStop = 'nodes';
      if (this.#imports >= this.#config.analysis.limits.maxImports) globalStop = 'imports';
      if (this.#processedBytes >= this.#config.analysis.limits.maxTotalSourceBytes)
        globalStop = 'bytes';
      if (this.#responseBytes >= MAX_SESSION_RESPONSE_BYTES) globalStop = 'response';

      if (
        this.#filesSinceRecycle >= WORKER_MAX_FILES ||
        this.#bytesSinceRecycle >= WORKER_MAX_INPUT_BYTES ||
        this.#worker?.closed === true
      ) {
        await this.#disposeWorker();
      }
    }

    results.sort((left, right) => codePointCompare(left.fileId, right.fileId));
    batchDiagnostics.sort((left, right) => {
      const idCompare = codePointCompare(left.fileId ?? '', right.fileId ?? '');
      if (idCompare !== 0) return idCompare;
      const a = left.range?.startByte ?? -1;
      const b = right.range?.startByte ?? -1;
      return a === b ? codePointCompare(left.message, right.message) : a < b ? -1 : 1;
    });
    return {
      files: results,
      diagnostics: batchDiagnostics,
      complete,
      visitedNodes: batchVisitedNodes,
      processedBytes: batchProcessedBytes,
    };
  }

  /**
   * Binds one import-connected component in a fresh disposable child launched by the same
   * supervisor. Serialized with syntax calls, rejected after close, and terminated and reaped
   * after success or failure. Failed semantics never alter cached syntax results.
   */
  public async analyzeSemanticComponent(
    input: SemanticComponentInput,
  ): Promise<SemanticComponentOutcome> {
    if (this.#closed) throw new Error('Parser session is closed.');
    if (this.#analyzing) throw new Error('Parser session already has an active analysis batch.');
    this.#analyzing = true;
    try {
      return await this.#analyzeSemanticComponent(input);
    } finally {
      this.#analyzing = false;
    }
  }

  async #analyzeSemanticComponent(
    input: SemanticComponentInput,
  ): Promise<SemanticComponentOutcome> {
    const limits = this.#config.analysis.limits;
    const unavailable = (
      reason: SemanticFailure,
      consumedNodes: number,
    ): SemanticComponentOutcome => ({
      status: 'unavailable',
      componentId: input.componentId,
      reason,
      consumedNodes,
    });

    const members = [...input.members].sort((left, right) =>
      codePointCompare(left.source.fileId, right.source.fileId),
    );
    if (
      members.length === 0 ||
      members[0]?.source.fileId !== input.componentId ||
      new Set(members.map((member) => member.source.fileId)).size !== members.length ||
      !Number.isSafeInteger(input.maxRecords) ||
      input.maxRecords < 0
    ) {
      throw new TypeError('Semantic component input is not a valid sorted unique component.');
    }
    const texts = new Map<FileId, string>();
    const files: SemanticComponentFile[] = [];
    let textBytes = 0;
    let metadataCodeUnits = 0;
    for (const member of members) {
      const identity = sourceBytes(member.source);
      validateSourceIdentity(member.source, identity.hash);
      const cached = this.#cache.get(member.source.fileId);
      if (
        cached === undefined ||
        cached.byteHash !== identity.hash ||
        cached.result !== member.syntax ||
        member.syntax.fileId !== member.source.fileId
      ) {
        throw new TypeError('Semantic component syntax was not produced by this session.');
      }
      textBytes += identity.bytes.byteLength;
      metadataCodeUnits +=
        member.source.fileId.length + member.source.snapshot.canonicalPath.length;
      texts.set(member.source.fileId, identity.text);
      files.push({
        fileId: member.source.fileId,
        canonicalPath: member.source.snapshot.canonicalPath,
        originalText: identity.text,
        byteHash: identity.hash,
      });
    }
    const lookups = [...input.lookups].sort(
      (left, right) =>
        codePointCompare(left.importerFileId, right.importerFileId) ||
        left.specifierRange.startByte - right.specifierRange.startByte,
    );
    for (const lookup of lookups) {
      if (!texts.has(lookup.importerFileId) || !texts.has(lookup.targetFileId)) {
        throw new TypeError('A semantic import lookup names a file outside the component.');
      }
      metadataCodeUnits +=
        lookup.importerFileId.length +
        lookup.importId.length +
        lookup.specifier.length +
        lookup.targetFileId.length;
    }

    try {
      await this.#budget.checkpoint(true);
    } catch (error: unknown) {
      if (error instanceof BudgetError && error.kind === 'cancelled') {
        await this.close();
        throw error;
      }
      if (error instanceof BudgetError && error.kind === 'deadline') {
        return unavailable('limit', 0);
      }
      throw error;
    }

    const maxRecords = Math.min(input.maxRecords, MAX_SEMANTIC_RECORDS_CEILING);
    const grantedNodes = Math.min(
      limits.maxAstNodesTotal - this.#totalNodes(),
      limits.maxAstNodesPerFile * members.length,
      MAX_SEMANTIC_NODES_CEILING,
    );
    if (
      members.length > Math.min(limits.maxSemanticFiles, MAX_SEMANTIC_FILES_CEILING) ||
      textBytes > Math.min(limits.maxSemanticBytes, MAX_SEMANTIC_BYTES_CEILING) ||
      lookups.length > Math.min(limits.maxImports, MAX_SEMANTIC_LOOKUPS_CEILING) ||
      grantedNodes <= 0 ||
      this.#responseBytes >= MAX_SESSION_RESPONSE_BYTES
    ) {
      return unavailable('limit', 0);
    }
    let frameBound: number;
    try {
      frameBound = maxSemanticRequestFrameBytes({
        textBytes,
        metadataCodeUnits,
        files: files.length,
        lookups: lookups.length,
      });
    } catch (error: unknown) {
      if (error instanceof ParserProtocolError && error.failure === 'limit') {
        return unavailable('limit', 0);
      }
      throw error;
    }

    const guard = new JobGuard(this.#budget, limits.semanticTimeoutMs);
    this.#activeGuard = guard;
    let worker: WorkerConnection | undefined;
    let acceptedResponseBytes = 0;
    let outcome: SemanticComponentOutcome;
    try {
      guard.check();
      worker = this.#workerFactory();
      guard.setWorker(worker);
      const readyPayload = await guard.race(worker.nextFrame());
      acceptedResponseBytes += readyPayload.byteLength;
      if (this.#responseBytes + acceptedResponseBytes > MAX_SESSION_RESPONSE_BYTES) {
        throw new ParserProtocolError('limit');
      }
      const ready = validateReady(decodeJsonFrame(readyPayload));
      guard.check();
      if (worker.hasQueuedFrames) throw new ParserProtocolError('protocol');
      if (!ready.supportedVersions.includes(input.grammar)) {
        outcome = unavailable('grammar-unavailable', 0);
      } else {
        const requestId = this.#nextRequestId();
        const request: SemanticWorkerRequest = {
          protocolVersion: PARSER_PROTOCOL_VERSION,
          requestId,
          kind: 'semantic-component',
          componentId: input.componentId,
          grammar: input.grammar,
          maxFiles: Math.min(limits.maxSemanticFiles, MAX_SEMANTIC_FILES_CEILING),
          maxBytes: Math.min(limits.maxSemanticBytes, MAX_SEMANTIC_BYTES_CEILING),
          maxFileBytes: limits.maxFileBytes,
          maxAstNodesPerFile: limits.maxAstNodesPerFile,
          maxAstNodesRemaining: grantedNodes,
          maxRecords,
          files,
          imports: lookups,
        };
        await guard.race(worker.send(encodeFrame(request, frameBound)));
        const payload = await guard.race(worker.nextFrame());
        acceptedResponseBytes += payload.byteLength;
        if (this.#responseBytes + acceptedResponseBytes > MAX_SESSION_RESPONSE_BYTES) {
          throw new ParserProtocolError('limit');
        }
        const value = decodeJsonFrame(payload);
        guard.check();
        const reply = validateSemanticReply(value, {
          requestId,
          componentId: input.componentId,
          maxNodes: grantedNodes,
          maxRecords,
        });
        if (reply.result.status === 'bound') {
          if (reply.result.grammar !== input.grammar) throw new ParserProtocolError('protocol');
          await validateSemanticSites(
            reply.result.baseSites,
            reply.result.callSites,
            buildSemanticIndexes(members, texts),
            input.componentId,
            this.#budget,
            () => guard.check(),
            this.#validationObserver,
          );
        }
        guard.check();
        if (worker.hasQueuedFrames) throw new ParserProtocolError('protocol');
        outcome =
          reply.result.status === 'bound'
            ? {
                status: 'bound',
                componentId: input.componentId,
                grammar: reply.result.grammar,
                baseSites: reply.result.baseSites,
                callSites: reply.result.callSites,
                consumedNodes: reply.consumedNodes,
              }
            : unavailable(reply.result.reason, reply.consumedNodes);
      }
    } catch (error: unknown) {
      if (
        (error instanceof JobTermination && error.kind === 'cancelled') ||
        (error instanceof BudgetError && error.kind === 'cancelled')
      ) {
        if (worker !== undefined) await worker.terminate();
        throw error instanceof BudgetError ? error : new BudgetError('cancelled');
      }
      if (worker !== undefined) await worker.terminate();
      const timedOut = error instanceof JobTermination && error.kind === 'timeout';
      const deadline =
        (error instanceof JobTermination && error.kind === 'deadline') ||
        (error instanceof BudgetError && error.kind === 'deadline');
      const transportLimit = error instanceof ParserProtocolError && error.failure === 'limit';
      // An untrusted or killed job is charged its full granted traversal allowance.
      outcome = unavailable(
        timedOut || deadline || transportLimit ? 'limit' : 'protocol',
        grantedNodes,
      );
    } finally {
      guard.dispose();
      if (this.#activeGuard === guard) this.#activeGuard = undefined;
      if (worker !== undefined) await worker.terminate();
    }
    this.#semanticNodes += outcome.consumedNodes;
    this.#responseBytes += acceptedResponseBytes;
    return outcome;
  }

  public async close(): Promise<void> {
    if (this.#closePromise !== undefined) return await this.#closePromise;
    if (this.#closed) return;
    this.#closed = true;
    this.#activeGuard?.cancel();
    this.#closePromise = this.#disposeWorker();
    await this.#closePromise;
  }

  async #parseSource(
    source: ParserSource,
    identity: { readonly bytes: Buffer; readonly text: string; readonly hash: string },
    nodeAllowance: number,
    importAllowance: number,
  ): Promise<FileOutcome> {
    const guard = new JobGuard(this.#budget, this.#config.analysis.limits.parseTimeoutMs);
    this.#activeGuard = guard;
    const maximumRequestBytes = maxRequestFrameBytes(this.#config.analysis.limits.maxFileBytes);
    let grantedNodes = nodeAllowance;
    let acceptedResponseBytes = 0;
    let worker: WorkerConnection | undefined;
    try {
      if (nodeAllowance === 0 || importAllowance === 0) {
        const result = failedResult(
          source.fileId,
          'LIMIT_EXCEEDED',
          'Parser traversal or import limits were exhausted.',
        );
        return { result, consumedNodes: 0, consumedImports: 0, inputBytes: 0, responseBytes: 0 };
      }
      guard.check();
      worker = await guard.race(this.#ensureWorker(guard));
      const requestId = this.#nextRequestId();
      const request = {
        protocolVersion: PARSER_PROTOCOL_VERSION,
        requestId,
        kind: 'parse-file' as const,
        fileId: source.fileId,
        canonicalPath: source.snapshot.canonicalPath,
        originalText: identity.text,
        byteHash: identity.hash,
        maxFileBytes: this.#config.analysis.limits.maxFileBytes,
        maxAstNodesPerFile: this.#config.analysis.limits.maxAstNodesPerFile,
        maxAstNodesRemaining: grantedNodes,
        maxImportsRemaining: importAllowance,
        versionAuthority: versionAuthority(this.#config),
        version: this.#config.solidity.version,
      };
      const frame = encodeFrame(request, maximumRequestBytes);
      await guard.race(worker.send(frame));
      const payload = await guard.race(worker.nextFrame());
      acceptedResponseBytes += payload.byteLength;
      if (this.#responseBytes + acceptedResponseBytes > MAX_SESSION_RESPONSE_BYTES) {
        throw new ParserProtocolError('limit');
      }
      const value = decodeJsonFrame(payload);
      guard.check();
      const reply = validateWorkerReply(value, { requestId, fileId: source.fileId });
      if (reply.consumedNodes > grantedNodes) throw new ParserProtocolError('protocol');
      if (reply.consumedImports > importAllowance) throw new ParserProtocolError('protocol');
      const ready = this.#ready;
      if (ready === undefined) throw new ParserProtocolError('protocol');
      if (
        reply.result.status === 'parsed' &&
        (reply.result.version.parserVersion !== ready.parserVersion ||
          reply.result.version.installedVersions.length !== ready.supportedVersions.length ||
          reply.result.version.installedVersions.some(
            (version, index) => version !== ready.supportedVersions[index],
          ))
      )
        throw new ParserProtocolError('protocol');
      await validateParsedResult(
        reply.result,
        source.fileId,
        source.snapshot.canonicalPath,
        new SourceCoordinateIndex(identity.text),
        grantedNodes,
        reply.consumedNodes,
        this.#budget,
        () => guard.check(),
        ready.supportedVersions,
        { source: versionAuthority(this.#config), version: this.#config.solidity.version },
        this.#validationObserver,
      );
      guard.check();
      if (worker.hasQueuedFrames) throw new ParserProtocolError('protocol');
      if (
        reply.result.status === 'parsed' &&
        reply.result.imports.length !== reply.consumedImports
      ) {
        throw new ParserProtocolError('protocol');
      }
      return {
        result: reply.result,
        consumedNodes: reply.consumedNodes,
        consumedImports: reply.consumedImports,
        inputBytes: identity.bytes.byteLength,
        responseBytes: acceptedResponseBytes,
      };
    } catch (error: unknown) {
      if (error instanceof JobTermination && error.kind === 'cancelled') {
        const activeWorker = worker ?? this.#worker;
        if (activeWorker !== undefined) await activeWorker.terminate();
        this.#worker = undefined;
        this.#ready = undefined;
        throw new BudgetError('cancelled');
      }
      if (error instanceof BudgetError && error.kind === 'cancelled') {
        const activeWorker = worker ?? this.#worker;
        if (activeWorker !== undefined) await activeWorker.terminate();
        this.#worker = undefined;
        this.#ready = undefined;
        throw error;
      }
      const activeWorker = worker ?? this.#worker;
      if (activeWorker !== undefined) {
        await activeWorker.terminate();
        if (this.#worker === activeWorker) this.#worker = undefined;
        this.#ready = undefined;
      }
      const timedOut = error instanceof JobTermination && error.kind === 'timeout';
      const deadline =
        (error instanceof JobTermination && error.kind === 'deadline') ||
        (error instanceof BudgetError && error.kind === 'deadline');
      const transportLimit = error instanceof ParserProtocolError && error.failure === 'limit';
      const code = timedOut || deadline || transportLimit ? 'LIMIT_EXCEEDED' : 'INTERNAL_ERROR';
      const message =
        code === 'LIMIT_EXCEEDED'
          ? 'Parser worker exceeded a time, traversal, or transport limit.'
          : 'The parser worker failed or returned an invalid protocol message.';
      const result = failedResult(source.fileId, code, message);
      const consumedNodes = Math.max(0, grantedNodes);
      return {
        result,
        consumedNodes,
        consumedImports: 0,
        inputBytes: identity.bytes.byteLength,
        responseBytes: acceptedResponseBytes,
      };
    } finally {
      guard.dispose();
      if (this.#activeGuard === guard) this.#activeGuard = undefined;
    }
  }

  async #ensureWorker(guard: JobGuard): Promise<WorkerConnection> {
    if (this.#worker !== undefined && !this.#worker.closed) return this.#worker;
    this.#worker = undefined;
    this.#ready = undefined;
    const worker = this.#workerFactory();
    this.#worker = worker;
    guard.setWorker(worker);
    const payload = await guard.race(worker.nextFrame());
    this.#responseBytes += payload.byteLength;
    if (this.#responseBytes > MAX_SESSION_RESPONSE_BYTES) {
      throw new ParserProtocolError('limit');
    }
    const ready = validateReady(decodeJsonFrame(payload));
    guard.check();
    if (worker.hasQueuedFrames) throw new ParserProtocolError('protocol');
    this.#ready = ready;
    this.#filesSinceRecycle = 0;
    this.#bytesSinceRecycle = 0;
    return worker;
  }

  #nextRequestId(): number {
    this.#requestId += 1;
    if (!Number.isSafeInteger(this.#requestId)) throw new ParserProtocolError('limit');
    return this.#requestId;
  }

  async #disposeWorker(): Promise<void> {
    const worker = this.#worker;
    this.#worker = undefined;
    this.#ready = undefined;
    this.#filesSinceRecycle = 0;
    this.#bytesSinceRecycle = 0;
    if (worker !== undefined) await worker.terminate();
  }
}

function stopMessage(
  reason: 'deadline' | 'nodes' | 'imports' | 'files' | 'bytes' | 'response',
): string {
  if (reason === 'deadline')
    return 'The shared analysis deadline was exhausted before parsing completed.';
  if (reason === 'nodes')
    return 'The session CST node budget was exhausted before parsing completed.';
  if (reason === 'imports')
    return 'The session import budget was exhausted before parsing completed.';
  if (reason === 'files') return 'The configured parser file budget was exhausted.';
  if (reason === 'bytes') return 'The configured parser source-byte budget was exhausted.';
  return 'The session parser response budget was exhausted.';
}

export function createParserSession(options: ParserSessionOptions): ParserSession {
  return new ParserSession(options);
}

/** Test-only launcher seam. Production callers should use createParserSession(). */
export function createParserSessionForTests(
  options: ParserSessionOptions,
  childFactory: () => ChildProcessWithoutNullStreams,
  validationObserver?: ValidationObserver,
): ParserSession {
  return new ParserSession(options, () => new WorkerConnection(childFactory()), validationObserver);
}

export async function analyzeSources(
  session: ParserSession,
  sources: readonly ParserSource[],
): Promise<ParserBatch> {
  return await session.analyzeSources(sources);
}

export async function analyzeSemanticComponent(
  session: ParserSession,
  input: SemanticComponentInput,
): Promise<SemanticComponentOutcome> {
  return await session.analyzeSemanticComponent(input);
}
