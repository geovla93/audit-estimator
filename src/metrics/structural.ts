import { declarationIdentity, sortById } from '../domain/canonical.ts';
import type {
  CallableAnalysis,
  CallableKind,
  ContractAnalysis,
  ContractId,
  DeclarationKind,
  EvidenceRef,
  FileAnalysis,
  FileId,
  Measurement,
  SourceLineSet,
  SourceRange,
  StateVariableShape,
  StateVariables,
} from '../domain/types.ts';
import type {
  ParseFileResult,
  ParserAttribute,
  ParserDeclaration,
  ParserEvent,
  ParserSource,
} from '../parser/protocol.ts';
import {
  DECISION_CONTROL_KINDS,
  LOOP_CONTROL_KINDS,
  REASON_EFFECTIVE_RULE_UNCONFIRMED,
  REASON_NOT_APPLICABLE,
  REASON_NO_BODY,
  REASON_PARSE_INTERNAL_ERROR,
  REASON_PARSE_INVALID,
  REASON_PARSE_LANGUAGE_UNSUPPORTED,
  REASON_PARSE_LIMIT_EXCEEDED,
  REASON_VISIBILITY_MISSING,
  compareSolidityVersion,
} from './definitions.ts';
import {
  BOUNDED_RECORD_INTERVAL,
  buildRetainedLineSet,
  buildSourceLineSet,
  countPhysicalLines,
  endOfTextPosition,
  linesWithin,
} from './source.ts';

export interface FileMetrics {
  readonly file: FileAnalysis;
  readonly contracts: readonly ContractAnalysis[];
  readonly callables: readonly CallableAnalysis[];
  /** Null when the file failed to parse. */
  readonly lineSet: SourceLineSet | null;
  /** One range covering the whole original text; evidence for file-level line counts. */
  readonly wholeFile: EvidenceRef;
}

type FailedCode = Extract<ParseFileResult, { status: 'failed' }>['code'];
type ParsedResult = Extract<ParseFileResult, { status: 'parsed' }>;

const FAILURE_REASONS: Readonly<Record<FailedCode, string>> = {
  LANGUAGE_UNSUPPORTED: REASON_PARSE_LANGUAGE_UNSUPPORTED,
  PARSE_INVALID: REASON_PARSE_INVALID,
  LIMIT_EXCEEDED: REASON_PARSE_LIMIT_EXCEEDED,
  INTERNAL_ERROR: REASON_PARSE_INTERNAL_ERROR,
};

const UNNAMED_CALLABLE_KINDS: ReadonlySet<string> = new Set(['constructor', 'fallback', 'receive']);
const COMPLEX_SHAPES: ReadonlySet<string> = new Set(['mapping', 'array']);

function measured<T>(value: T, evidence: readonly EvidenceRef[]): Measurement<T> {
  return { status: 'measured', value, evidence };
}

function unavailable<T>(reason: string): Measurement<T> {
  return { status: 'unavailable', reason };
}

/** A measured count: a zero count carries no evidence. */
function counted(evidence: readonly EvidenceRef[]): Measurement<number> {
  return measured(evidence.length, evidence);
}

function refs(fileId: FileId, ranges: readonly SourceRange[]): EvidenceRef[] {
  return ranges.map((range) => ({ fileId, range }));
}

function attribute(
  attributes: readonly ParserAttribute[],
  key: string,
): ParserAttribute['value'] | undefined {
  return attributes.find((candidate) => candidate.key === key)?.value;
}

function stringAttribute(attributes: readonly ParserAttribute[], key: string): string | null {
  const value = attribute(attributes, key);
  return typeof value === 'string' ? value : null;
}

function contains(outer: SourceRange, inner: SourceRange): boolean {
  return inner.startByte >= outer.startByte && inner.endByte <= outer.endByte;
}

function byRange(left: SourceRange, right: SourceRange): number {
  if (left.startByte !== right.startByte) return left.startByte - right.startByte;
  return left.endByte - right.endByte;
}

function wholeFileEvidence(source: ParserSource): EvidenceRef {
  const end = endOfTextPosition(source.snapshot.originalText);
  return {
    fileId: source.fileId,
    range: {
      startByte: 0,
      endByte: end.byte,
      start: { line: 1, column: 1 },
      end: { line: end.line, column: end.column },
    },
  };
}

function lineMeasurement(value: number, source: ParserSource): Measurement<number> {
  return measured(value, value === 0 ? [] : [wholeFileEvidence(source)]);
}

function contractKind(kind: string): DeclarationKind {
  if (
    kind === 'contract' ||
    kind === 'abstract-contract' ||
    kind === 'library' ||
    kind === 'interface'
  ) {
    return kind;
  }
  throw new TypeError(`Unexpected contract kind: ${kind}`);
}

function callableKind(declaration: ParserDeclaration): CallableKind {
  const kind = declaration.kind;
  if (kind === 'function') return declaration.contractId === null ? 'free-function' : 'function';
  if (kind === 'constructor' || kind === 'fallback' || kind === 'receive' || kind === 'modifier') {
    return kind;
  }
  throw new TypeError(`Unexpected callable kind: ${kind}`);
}

function stateVariableShape(raw: string | null): StateVariableShape['shape'] {
  if (
    raw === 'elementary' ||
    raw === 'mapping' ||
    raw === 'array' ||
    raw === 'struct' ||
    raw === 'user-defined'
  ) {
    return raw;
  }
  return 'unknown';
}

/** Longest chain of ranges nested by containment, outermost first. */
function deepestChain(ranges: readonly SourceRange[]): readonly SourceRange[] {
  const ordered = [...ranges].sort(
    (left, right) => left.startByte - right.startByte || right.endByte - left.endByte,
  );
  const stack: SourceRange[] = [];
  let best: SourceRange[] = [];
  for (const range of ordered) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top !== undefined && contains(top, range)) break;
      stack.pop();
    }
    stack.push(range);
    if (stack.length > best.length) best = [...stack];
  }
  return best;
}

function effectiveVisibility(
  kind: CallableKind,
  explicit: string | null,
  version: string,
  evidence: readonly EvidenceRef[],
): Measurement<string> {
  if (kind === 'modifier') return unavailable(REASON_NOT_APPLICABLE);
  if (explicit !== null) return measured(explicit, evidence);
  switch (kind) {
    case 'function':
    case 'fallback':
    case 'receive':
      return compareSolidityVersion(version, '0.5.0') < 0
        ? measured('public', evidence)
        : unavailable(REASON_VISIBILITY_MISSING);
    case 'free-function':
      return measured('internal', evidence);
    case 'constructor':
      return compareSolidityVersion(version, '0.7.0') < 0
        ? measured('public', evidence)
        : unavailable(REASON_NOT_APPLICABLE);
    default:
      return unavailable(REASON_EFFECTIVE_RULE_UNCONFIRMED);
  }
}

function effectiveMutability(
  kind: CallableKind,
  explicit: string | null,
  evidence: readonly EvidenceRef[],
): Measurement<string> {
  if (kind === 'modifier') return unavailable(REASON_NOT_APPLICABLE);
  if (explicit !== null) return measured(explicit === 'constant' ? 'view' : explicit, evidence);
  switch (kind) {
    case 'function':
    case 'free-function':
    case 'constructor':
    case 'fallback':
      return measured('nonpayable', evidence);
    case 'receive':
      return measured('payable', evidence);
    default:
      return unavailable(REASON_EFFECTIVE_RULE_UNCONFIRMED);
  }
}

interface CallableCounts {
  readonly decisions: readonly SourceRange[];
  readonly loops: readonly SourceRange[];
  readonly loopChain: readonly SourceRange[];
  readonly assemblyBlocks: readonly SourceRange[];
  readonly yulStatements: readonly SourceRange[];
  readonly yulCalls: readonly SourceRange[];
  readonly yulControlFlow: readonly SourceRange[];
  readonly lowLevelCallCandidates: readonly SourceRange[];
}

interface CallableDetail {
  readonly analysis: CallableAnalysis;
  /** Null when the callable has no body; its counts are then unavailable, never zero. */
  readonly counts: CallableCounts | null;
}

function countCallable(
  declaration: ParserDeclaration,
  owned: readonly ParserEvent[],
): CallableCounts | null {
  const body = declaration.bodyRange;
  if (!declaration.hasBody || body === null) return null;
  const ranges = (kind: string): SourceRange[] =>
    owned.filter((event) => event.kind === kind).map((event) => event.range);
  const controlWithin = owned.filter(
    (event) =>
      event.kind === 'control' &&
      contains(body, event.range) &&
      DECISION_CONTROL_KINDS.has(stringAttribute(event.attributes, 'control-kind') ?? ''),
  );
  const loops = controlWithin
    .filter((event) =>
      LOOP_CONTROL_KINDS.has(stringAttribute(event.attributes, 'control-kind') ?? ''),
    )
    .map((event) => event.range);
  return {
    decisions: controlWithin.map((event) => event.range),
    loops,
    loopChain: deepestChain(loops),
    assemblyBlocks: ranges('assembly'),
    yulStatements: ranges('yul-statement'),
    yulCalls: ranges('yul-call'),
    yulControlFlow: ranges('yul-control'),
    lowLevelCallCandidates: owned
      .filter(
        (event) =>
          event.kind === 'call-site' && attribute(event.attributes, 'low-level-candidate') === true,
      )
      .map((event) => event.range),
  };
}

function buildCallable(
  fileId: FileId,
  version: string,
  declaration: ParserDeclaration,
  owned: readonly ParserEvent[],
): CallableDetail {
  const kind = callableKind(declaration);
  const id = declaration.callableId;
  if (id === null) throw new TypeError('Expected a callable declaration.');
  const declared = refs(fileId, [declaration.declarationRange]);
  const explicitVisibility = stringAttribute(declaration.attributes, 'visibility');
  const explicitMutability = stringAttribute(declaration.attributes, 'mutability');
  const counts = countCallable(declaration, owned);
  const count = (select: (value: CallableCounts) => readonly SourceRange[]): Measurement<number> =>
    counts === null ? unavailable(REASON_NO_BODY) : counted(refs(fileId, select(counts)));
  const modifiers = owned
    .filter((event) => event.kind === 'modifier-invocation')
    .sort((left, right) => byRange(left.range, right.range));
  const analysis: CallableAnalysis = {
    id,
    fileId,
    contractId: declaration.contractId,
    kind,
    name: UNNAMED_CALLABLE_KINDS.has(declaration.kind) ? null : declaration.name,
    range: declaration.declarationRange,
    visibilityExplicit: measured(explicitVisibility ?? 'none', declared),
    visibilityEffective: effectiveVisibility(kind, explicitVisibility, version, declared),
    mutabilityExplicit: measured(explicitMutability ?? 'none', declared),
    mutabilityEffective: effectiveMutability(kind, explicitMutability, declared),
    hasBody: measured(declaration.hasBody, declared),
    decisions: count((value) => value.decisions),
    loops: count((value) => value.loops),
    maxLoopDepth:
      counts === null
        ? unavailable(REASON_NO_BODY)
        : measured(counts.loopChain.length, refs(fileId, counts.loopChain)),
    assemblyBlocks: count((value) => value.assemblyBlocks),
    yulStatements: count((value) => value.yulStatements),
    yulCalls: count((value) => value.yulCalls),
    yulControlFlow: count((value) => value.yulControlFlow),
    lowLevelCallCandidates: count((value) => value.lowLevelCallCandidates),
    modifiersApplied: measured(
      modifiers.map((event) => stringAttribute(event.attributes, 'name') ?? ''),
      refs(
        fileId,
        modifiers.map((event) => event.range),
      ),
    ),
  };
  return { analysis, counts };
}

function stateVariables(
  fileId: FileId,
  canonicalPath: string,
  events: readonly ParserEvent[],
): StateVariables {
  const variables = events.filter((event) => event.kind === 'state-variable');
  const evidence = refs(
    fileId,
    variables.map((event) => event.range),
  );
  const shapes = variables.map((event) => {
    const shape = stateVariableShape(stringAttribute(event.attributes, 'type-shape'));
    const mutable =
      attribute(event.attributes, 'constant') !== true &&
      attribute(event.attributes, 'immutable') !== true;
    const entry: StateVariableShape = {
      declarationId: declarationIdentity(canonicalPath, 'state-variable', event.range.startByte),
      shape,
      mutable,
    };
    return { id: entry.declarationId, entry, range: event.range };
  });
  const mutable = shapes.filter((item) => item.entry.mutable);
  const complex = mutable.filter((item) => COMPLEX_SHAPES.has(item.entry.shape));
  const orderedShapes = sortById(shapes);
  return {
    count: counted(evidence),
    mutableCount: counted(
      refs(
        fileId,
        mutable.map((item) => item.range),
      ),
    ),
    complexMutableDeclarationIds: measured(
      sortById(complex).map((item) => item.id),
      refs(
        fileId,
        complex.map((item) => item.range),
      ),
    ),
    typeShapes: measured(
      orderedShapes.map((item) => item.entry),
      refs(
        fileId,
        orderedShapes.map((item) => item.range),
      ),
    ),
  };
}

function unavailableStateVariables(reason: string): StateVariables {
  return {
    count: unavailable(reason),
    mutableCount: unavailable(reason),
    complexMutableDeclarationIds: unavailable(reason),
    typeShapes: unavailable(reason),
  };
}

function failedFileMetrics(
  source: ParserSource,
  result: Extract<ParseFileResult, { status: 'failed' }>,
): FileMetrics {
  const reason = FAILURE_REASONS[result.code];
  const file: FileAnalysis = {
    fileId: source.fileId,
    role: source.manifestEntry.role,
    ownership: source.manifestEntry.ownership,
    physicalLines: lineMeasurement(countPhysicalLines(source.snapshot.originalText), source),
    sourceLines: unavailable(reason),
    declarationCounts: {
      contracts: unavailable(reason),
      abstractContracts: unavailable(reason),
      libraries: unavailable(reason),
      interfaces: unavailable(reason),
    },
    stateVariables: unavailableStateVariables(reason),
    decisions: unavailable(reason),
    loops: unavailable(reason),
    maxLoopDepth: unavailable(reason),
    assemblyBlocks: unavailable(reason),
    yulStatements: unavailable(reason),
    yulCalls: unavailable(reason),
    yulControlFlow: unavailable(reason),
    lowLevelCallCandidates: unavailable(reason),
    importIds: [],
    contractIds: [],
    callableIds: [],
    syntaxComplete: false,
  };
  return {
    file,
    contracts: [],
    callables: [],
    lineSet: null,
    wholeFile: wholeFileEvidence(source),
  };
}

function parsedFileMetrics(source: ParserSource, result: ParsedResult): FileMetrics {
  const fileId = source.fileId;
  const canonicalPath = source.snapshot.canonicalPath;
  const version = result.version.selectedVersion;
  const eventsByCallable = new Map<string, ParserEvent[]>();
  for (const event of result.events) {
    if (event.callableId === null) continue;
    const list = eventsByCallable.get(event.callableId) ?? [];
    list.push(event);
    eventsByCallable.set(event.callableId, list);
  }
  const contractDeclarations = result.declarations.filter(
    (declaration) => declaration.callableId === null,
  );
  const callableDeclarations = result.declarations.filter(
    (declaration) => declaration.callableId !== null,
  );
  const details = sortById(
    callableDeclarations
      .map((declaration) =>
        buildCallable(fileId, version, declaration, eventsByCallable.get(declaration.id) ?? []),
      )
      .map((detail) => ({ id: detail.analysis.id, detail })),
  ).map((item) => item.detail);
  const callables = details.map((detail) => detail.analysis);

  const lineSet = buildSourceLineSet(fileId, source.snapshot.originalBytes, result.tokens);
  const contracts = sortById(
    contractDeclarations.map((declaration): ContractAnalysis => {
      const id = declaration.contractId;
      if (id === null) throw new TypeError('Expected a contract declaration.');
      const lines = linesWithin(
        source.snapshot.originalBytes,
        result.tokens,
        declaration.declarationRange,
      );
      return {
        id,
        fileId,
        kind: contractKind(declaration.kind),
        name: declaration.name,
        range: declaration.declarationRange,
        sourceLines: measured(
          lines.size,
          lines.size === 0 ? [] : refs(fileId, [declaration.declarationRange]),
        ),
        callableIds: sortById(callables.filter((callable) => callable.contractId === id)).map(
          (callable) => callable.id,
        ),
        stateVariables: stateVariables(
          fileId,
          canonicalPath,
          result.events.filter((event) => event.contractId === id),
        ),
      };
    }),
  );

  const countKind = (kind: string): Measurement<number> =>
    counted(
      refs(
        fileId,
        contractDeclarations
          .filter((declaration) => declaration.kind === kind)
          .map((declaration) => declaration.declarationRange),
      ),
    );
  const bodied = details.flatMap((detail) => (detail.counts === null ? [] : [detail.counts]));
  const total = (select: (value: CallableCounts) => readonly SourceRange[]): Measurement<number> =>
    counted(refs(fileId, bodied.flatMap(select)));
  const deepest = bodied.reduce<readonly SourceRange[]>(
    (best, value) => (value.loopChain.length > best.length ? value.loopChain : best),
    [],
  );

  const file: FileAnalysis = {
    fileId,
    role: source.manifestEntry.role,
    ownership: source.manifestEntry.ownership,
    physicalLines: lineMeasurement(countPhysicalLines(source.snapshot.originalText), source),
    sourceLines: lineMeasurement(lineSet.oneBasedLines.size, source),
    declarationCounts: {
      contracts: countKind('contract'),
      abstractContracts: countKind('abstract-contract'),
      libraries: countKind('library'),
      interfaces: countKind('interface'),
    },
    stateVariables: stateVariables(fileId, canonicalPath, result.events),
    decisions: total((value) => value.decisions),
    loops: total((value) => value.loops),
    maxLoopDepth: measured(deepest.length, refs(fileId, deepest)),
    assemblyBlocks: total((value) => value.assemblyBlocks),
    yulStatements: total((value) => value.yulStatements),
    yulCalls: total((value) => value.yulCalls),
    yulControlFlow: total((value) => value.yulControlFlow),
    lowLevelCallCandidates: total((value) => value.lowLevelCallCandidates),
    importIds: result.imports.map((item) => item.id),
    contractIds: contracts.map((contract) => contract.id),
    callableIds: callables.map((callable) => callable.id),
    syntaxComplete: true,
  };
  return { file, contracts, callables, lineSet, wholeFile: wholeFileEvidence(source) };
}

/**
 * Maps one parser result to the public per-file records under the METRICS_VERSION 1.0.0 counting
 * rules in docs/metrics.md. Failed files keep measured physical lines; everything else is
 * unavailable with a parse reason, never zero.
 */
export function buildFileMetrics(source: ParserSource, result: ParseFileResult): FileMetrics {
  if (result.fileId !== source.fileId) throw new TypeError('Parser result is for another file.');
  return result.status === 'parsed'
    ? parsedFileMetrics(source, result)
    : failedFileMetrics(source, result);
}

interface ByteInterval {
  readonly startByte: number;
  readonly endByte: number;
}

/** Sorted, merged intervals so containment can be tested by binary search. */
function mergedIntervals(ranges: readonly SourceRange[]): ByteInterval[] {
  const ordered = [...ranges].sort(byRange);
  const merged: ByteInterval[] = [];
  for (const range of ordered) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.startByte <= last.endByte) {
      merged[merged.length - 1] = {
        startByte: last.startByte,
        endByte: Math.max(last.endByte, range.endByte),
      };
    } else {
      merged.push({ startByte: range.startByte, endByte: range.endByte });
    }
  }
  return merged;
}

/** True when `range` lies wholly inside one interval (intervals are sorted and disjoint). */
function insideAny(intervals: readonly ByteInterval[], range: SourceRange): boolean {
  let low = 0;
  let high = intervals.length - 1;
  let candidate: ByteInterval | undefined;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const interval = intervals[middle];
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

function omittedIntervals(
  raw: FileMetrics,
  omittedContractIds: ReadonlySet<ContractId>,
): ByteInterval[] {
  const known = new Set<ContractId>(raw.contracts.map((contract) => contract.id));
  for (const id of omittedContractIds) {
    if (!known.has(id)) throw new TypeError('An omitted contract is not in this file.');
  }
  return mergedIntervals(
    raw.contracts
      .filter((contract) => omittedContractIds.has(contract.id))
      .map((contract) => contract.range),
  );
}

/**
 * Accepted parser events that remain once the omitted top-level contracts are removed, in their
 * original order and with their original identities. The accepted result is never mutated.
 */
export async function retainedEvents(
  raw: FileMetrics,
  result: Extract<ParseFileResult, { status: 'parsed' }>,
  omittedContractIds: ReadonlySet<ContractId>,
  checkpoint: () => Promise<void> = (): Promise<void> => Promise.resolve(),
): Promise<ParserEvent[]> {
  const intervals = omittedIntervals(raw, omittedContractIds);
  const events: ParserEvent[] = [];
  let visited = 0;
  for (const event of result.events) {
    visited += 1;
    if (visited % BOUNDED_RECORD_INTERVAL === 0) await checkpoint();
    if (event.contractId !== null && omittedContractIds.has(event.contractId)) continue;
    if (insideAny(intervals, event.range)) continue;
    events.push(event);
  }
  return events;
}

/**
 * Derived review view of a parsed file: the same counting rules over the declarations, events and
 * tokens that remain after the omitted top-level contracts are removed. Raw metrics, accepted
 * syntax and identities are untouched, and the result is a distinct `FileMetrics` value that is
 * never published as accepted parser output. Retained contracts and callables keep their raw
 * records; file-level totals are rebuilt from the retained callables' evidence and the retained
 * events, so an empty omission set reproduces the raw metrics exactly. Work is checkpointed per
 * record batch and inside large tokens.
 */
export async function buildReviewMetrics(
  raw: FileMetrics,
  source: ParserSource,
  result: ParseFileResult,
  omittedContractIds: ReadonlySet<ContractId>,
  checkpoint: () => Promise<void> = (): Promise<void> => Promise.resolve(),
): Promise<FileMetrics> {
  if (result.status !== 'parsed' || raw.lineSet === null || result.fileId !== source.fileId) {
    throw new TypeError('A review view requires a parsed file.');
  }
  const fileId = source.fileId;
  const intervals = omittedIntervals(raw, omittedContractIds);

  const lines = await buildRetainedLineSet(
    source.snapshot.originalBytes,
    result.tokens,
    (token) => !insideAny(intervals, token.range),
    checkpoint,
  );

  const events = await retainedEvents(raw, result, omittedContractIds, checkpoint);
  const contracts = raw.contracts.filter((contract) => !omittedContractIds.has(contract.id));
  const callables = raw.callables.filter(
    (callable) => callable.contractId === null || !omittedContractIds.has(callable.contractId),
  );
  await checkpoint();

  const bodied = callables.filter((callable) => callable.decisions.status === 'measured');
  const total = (select: (value: CallableAnalysis) => Measurement<number>): Measurement<number> =>
    counted(
      bodied.flatMap((callable) => {
        const measurement = select(callable);
        return measurement.status === 'measured' ? measurement.evidence : [];
      }),
    );
  let deepest: readonly EvidenceRef[] = [];
  for (const callable of bodied) {
    const depth = callable.maxLoopDepth;
    if (depth.status === 'measured' && depth.value > deepest.length) deepest = depth.evidence;
  }
  // Parser declaration order, as in the raw view, so evidence order is identical.
  const retainedDeclarations = result.declarations.filter(
    (declaration) =>
      declaration.callableId === null &&
      !(declaration.contractId !== null && omittedContractIds.has(declaration.contractId)),
  );
  const countKind = (kind: DeclarationKind): Measurement<number> =>
    counted(
      refs(
        fileId,
        retainedDeclarations
          .filter((declaration) => declaration.kind === kind)
          .map((declaration) => declaration.declarationRange),
      ),
    );

  const file: FileAnalysis = {
    ...raw.file,
    sourceLines: lineMeasurement(lines.size, source),
    declarationCounts: {
      contracts: countKind('contract'),
      abstractContracts: countKind('abstract-contract'),
      libraries: countKind('library'),
      interfaces: countKind('interface'),
    },
    stateVariables: stateVariables(fileId, source.snapshot.canonicalPath, events),
    decisions: total((value) => value.decisions),
    loops: total((value) => value.loops),
    maxLoopDepth: measured(deepest.length, deepest),
    assemblyBlocks: total((value) => value.assemblyBlocks),
    yulStatements: total((value) => value.yulStatements),
    yulCalls: total((value) => value.yulCalls),
    yulControlFlow: total((value) => value.yulControlFlow),
    lowLevelCallCandidates: total((value) => value.lowLevelCallCandidates),
    contractIds: contracts.map((contract) => contract.id),
    callableIds: callables.map((callable) => callable.id),
  };
  return {
    file,
    contracts,
    callables,
    lineSet: { fileId, oneBasedLines: lines },
    wholeFile: raw.wholeFile,
  };
}
