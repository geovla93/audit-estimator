import { canonicalJson } from '../domain/canonical.ts';
import { ReportEnvelopeSchema } from '../domain/schemas.ts';
import type {
  Analysis,
  CallableAnalysis,
  ContractAnalysis,
  EvidenceRef,
  EstimateResult,
  FileAnalysis,
  FileScopeEntry,
  Indicator,
  Measurement,
  ReportEnvelope,
  RelationshipResult,
  ScopeManifest,
  StateVariables,
} from '../domain/types.ts';

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const leftPoint = leftPoints[index] ?? 0;
    const rightPoint = rightPoints[index] ?? 0;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftPoints.length < rightPoints.length
    ? -1
    : leftPoints.length > rightPoints.length
      ? 1
      : 0;
}

function compareEvidence(left: EvidenceRef, right: EvidenceRef): number {
  const fileOrder = compareCodePoints(left.fileId, right.fileId);
  if (fileOrder !== 0) return fileOrder;
  const leftRange = left.range;
  const rightRange = right.range;
  const values = [
    leftRange.startByte - rightRange.startByte,
    leftRange.endByte - rightRange.endByte,
    leftRange.start.line - rightRange.start.line,
    leftRange.start.column - rightRange.start.column,
    leftRange.end.line - rightRange.end.line,
    leftRange.end.column - rightRange.end.column,
  ];
  return values.find((value) => value !== 0) ?? 0;
}

function sortEvidence(items: readonly EvidenceRef[]): EvidenceRef[] {
  return [...items].sort(compareEvidence);
}

function sortStrings<T extends string>(items: readonly T[]): T[] {
  return [...items].sort(compareCodePoints);
}

function normalizeMeasurement<T>(measurement: Measurement<T>): Measurement<T> {
  return measurement.status === 'measured'
    ? { ...measurement, evidence: sortEvidence(measurement.evidence) }
    : { ...measurement };
}

function normalizeStateVariables(value: StateVariables): StateVariables {
  const complexMutableDeclarationIds = normalizeMeasurement(value.complexMutableDeclarationIds);
  const typeShapes = normalizeMeasurement(value.typeShapes);
  return {
    count: normalizeMeasurement(value.count),
    mutableCount: normalizeMeasurement(value.mutableCount),
    complexMutableDeclarationIds:
      complexMutableDeclarationIds.status === 'measured'
        ? {
            ...complexMutableDeclarationIds,
            value: sortStrings(complexMutableDeclarationIds.value),
          }
        : complexMutableDeclarationIds,
    typeShapes:
      typeShapes.status === 'measured'
        ? {
            ...typeShapes,
            value: [...typeShapes.value].sort((left, right) => {
              const idOrder = compareCodePoints(left.declarationId, right.declarationId);
              return idOrder !== 0
                ? idOrder
                : compareCodePoints(canonicalJson(left), canonicalJson(right));
            }),
          }
        : typeShapes,
  };
}

function normalizeScopeEntry(entry: FileScopeEntry): FileScopeEntry {
  return { ...entry, ownershipEvidence: sortEvidence(entry.ownershipEvidence) };
}

function normalizeScope(scope: ScopeManifest): ScopeManifest {
  return {
    entries: [...scope.entries]
      .sort((left, right) => compareCodePoints(left.fileId, right.fileId))
      .map(normalizeScopeEntry),
    scopedFileIds: sortStrings(scope.scopedFileIds),
    contextFileIds: sortStrings(scope.contextFileIds),
    excludedFileIds: sortStrings(scope.excludedFileIds),
  };
}

function normalizeFile(file: FileAnalysis): FileAnalysis {
  return {
    ...file,
    physicalLines: normalizeMeasurement(file.physicalLines),
    sourceLines: normalizeMeasurement(file.sourceLines),
    declarationCounts: {
      contracts: normalizeMeasurement(file.declarationCounts.contracts),
      abstractContracts: normalizeMeasurement(file.declarationCounts.abstractContracts),
      libraries: normalizeMeasurement(file.declarationCounts.libraries),
      interfaces: normalizeMeasurement(file.declarationCounts.interfaces),
    },
    stateVariables: normalizeStateVariables(file.stateVariables),
    decisions: normalizeMeasurement(file.decisions),
    loops: normalizeMeasurement(file.loops),
    maxLoopDepth: normalizeMeasurement(file.maxLoopDepth),
    assemblyBlocks: normalizeMeasurement(file.assemblyBlocks),
    yulStatements: normalizeMeasurement(file.yulStatements),
    yulCalls: normalizeMeasurement(file.yulCalls),
    yulControlFlow: normalizeMeasurement(file.yulControlFlow),
    lowLevelCallCandidates: normalizeMeasurement(file.lowLevelCallCandidates),
    importIds: [...file.importIds].sort(compareCodePoints),
    contractIds: [...file.contractIds].sort(compareCodePoints),
    callableIds: [...file.callableIds].sort(compareCodePoints),
  };
}

function normalizeContract(contract: ContractAnalysis): ContractAnalysis {
  return {
    ...contract,
    sourceLines: normalizeMeasurement(contract.sourceLines),
    callableIds: [...contract.callableIds].sort(compareCodePoints),
    stateVariables: normalizeStateVariables(contract.stateVariables),
  };
}

function normalizeCallable(callable: CallableAnalysis): CallableAnalysis {
  return {
    ...callable,
    visibilityExplicit: normalizeMeasurement(callable.visibilityExplicit),
    visibilityEffective: normalizeMeasurement(callable.visibilityEffective),
    mutabilityExplicit: normalizeMeasurement(callable.mutabilityExplicit),
    mutabilityEffective: normalizeMeasurement(callable.mutabilityEffective),
    hasBody: normalizeMeasurement(callable.hasBody),
    decisions: normalizeMeasurement(callable.decisions),
    loops: normalizeMeasurement(callable.loops),
    maxLoopDepth: normalizeMeasurement(callable.maxLoopDepth),
    assemblyBlocks: normalizeMeasurement(callable.assemblyBlocks),
    yulStatements: normalizeMeasurement(callable.yulStatements),
    yulCalls: normalizeMeasurement(callable.yulCalls),
    yulControlFlow: normalizeMeasurement(callable.yulControlFlow),
    lowLevelCallCandidates: normalizeMeasurement(callable.lowLevelCallCandidates),
    modifiersApplied: normalizeMeasurement(callable.modifiersApplied),
  };
}

function normalizeGraph(graph: RelationshipResult): RelationshipResult {
  const base = {
    ...graph,
    candidateTargets: [...graph.candidateTargets].sort(compareCodePoints),
    evidence: sortEvidence(graph.evidence),
  };
  return base;
}

function normalizeIndicator(indicator: Indicator): Indicator {
  return { ...indicator, evidence: sortEvidence(indicator.evidence) };
}

function normalizeAnalysis(analysis: Analysis): Analysis {
  return {
    ...analysis,
    files: [...analysis.files]
      .sort((left, right) => compareCodePoints(left.fileId, right.fileId))
      .map(normalizeFile),
    contracts: [...analysis.contracts]
      .sort((left, right) => compareCodePoints(left.id, right.id))
      .map(normalizeContract),
    callables: [...analysis.callables]
      .sort((left, right) => compareCodePoints(left.id, right.id))
      .map(normalizeCallable),
    aggregates: {
      scopedFiles: normalizeMeasurement(analysis.aggregates.scopedFiles),
      physicalLines: normalizeMeasurement(analysis.aggregates.physicalLines),
      sourceLines: normalizeMeasurement(analysis.aggregates.sourceLines),
      contracts: normalizeMeasurement(analysis.aggregates.contracts),
      callables: normalizeMeasurement(analysis.aggregates.callables),
    },
    graphs: [...analysis.graphs]
      .sort((left, right) => compareCodePoints(left.id, right.id))
      .map(normalizeGraph),
    indicators: [...analysis.indicators]
      .sort((left, right) => compareCodePoints(left.id, right.id))
      .map(normalizeIndicator),
    testObservations: [...analysis.testObservations]
      .map((observation) => ({
        ...observation,
        present: normalizeMeasurement(observation.present),
      }))
      .sort((left, right) => {
        const pathOrder = compareCodePoints(left.path, right.path);
        return pathOrder !== 0
          ? pathOrder
          : compareCodePoints(canonicalJson(left), canonicalJson(right));
      }),
    coverageObservation:
      analysis.coverageObservation === null
        ? null
        : {
            ...analysis.coverageObservation,
            coveredLines: normalizeMeasurement(analysis.coverageObservation.coveredLines),
            totalLines: normalizeMeasurement(analysis.coverageObservation.totalLines),
          },
    completeness: {
      ...analysis.completeness,
      analyzedFileIds: sortStrings(analysis.completeness.analyzedFileIds),
      unavailableFileIds: sortStrings(analysis.completeness.unavailableFileIds),
    },
  };
}

/** Validates the public envelope and sorts only explicitly set-like collections on fresh copies. */
export function parseDisplayEnvelope(input: unknown): ReportEnvelope {
  const envelope = ReportEnvelopeSchema.parse(input);
  return {
    ...envelope,
    scope: normalizeScope(envelope.scope),
    analysis: envelope.analysis === null ? null : normalizeAnalysis(envelope.analysis),
  };
}

/** Stable code point ordering for renderer-owned values. */
export function compareDisplayText(left: string, right: string): number {
  return compareCodePoints(left, right);
}

/** Canonical serialized comparison for stable tie-breaks and identity checks. */
export function canonicalDisplayValue(value: unknown): string {
  return canonicalJson(value);
}

/** Ledger rows are intentionally kept in their supplied order. */
export function estimateDisplayIdentity(estimate: EstimateResult): string {
  return canonicalJson(estimate);
}
