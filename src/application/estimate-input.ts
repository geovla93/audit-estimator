import type {
  ContractId,
  EstimateInput,
  FileId,
  Measurement,
  ResolvedConfig,
  ScopeManifest,
  StateVariables,
} from '../domain/types.ts';
import type { FileMetrics } from '../metrics/structural.ts';
import type { RelationshipAnalysis } from '../relationships/types.ts';
import type { ReviewProjection } from './dependency-reuse/types.ts';

export interface EstimateInputSource {
  /** Final manifest from relationships. */
  readonly manifest: ScopeManifest;
  /** Scoped files only. */
  readonly metrics: readonly FileMetrics[];
  /** Scoped files whose syntax succeeded. */
  readonly parsedFileIds: ReadonlySet<FileId>;
  readonly relationships: Pick<
    RelationshipAnalysis,
    | 'scopedPairs'
    | 'contextPairs'
    | 'confirmedBuiltinLowLevelCalls'
    | 'invalidatedScopedFileIds'
    | 'requiredAnalysisComplete'
    | 'hasUnknownSemantics'
  >;
  /** Completeness computed by the orchestrator (discovery, relationships and parse results). */
  readonly requiredAnalysisComplete: boolean;
  /** Effective model and manual adjustments. */
  readonly config: ResolvedConfig;
  readonly allowPartial: boolean;
  /**
   * Effective review projection. Used only under model 1.1.0; model 1.0.0 always reads the raw
   * physical-file facts and pairs.
   */
  readonly projection?: ReviewProjection | undefined;
}

type EligibleFile = EstimateInput['eligibleFiles'][number];
type Pair = EstimateInput['scopedPairs'][number];

const UNCLASSIFIABLE_SHAPES: ReadonlySet<string> = new Set(['user-defined', 'unknown']);
const STORAGE_UNCLASSIFIED_REASON =
  'A mutable state variable has a user-defined or unknown type, so its storage complexity is not classified.';
const BUILTIN_UNAVAILABLE_REASON = 'No confirmed builtin low-level call count exists for the file.';

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (scalar) => scalar.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (scalar) => scalar.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const leftPoint = leftPoints[index] ?? 0;
    const rightPoint = rightPoints[index] ?? 0;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

/** Estimator-only copy: the stored metrics object is never mutated. */
function estimatorStorage(storage: StateVariables): StateVariables {
  const shapes = storage.typeShapes;
  const unclassified =
    shapes.status === 'measured' &&
    shapes.value.some((shape) => shape.mutable && UNCLASSIFIABLE_SHAPES.has(shape.shape));
  if (!unclassified) return storage;
  return {
    ...storage,
    complexMutableDeclarationIds: { status: 'unavailable', reason: STORAGE_UNCLASSIFIED_REASON },
  };
}

function pairKey(pair: Pair): string {
  return JSON.stringify([pair.leftId, pair.rightId]);
}

/**
 * Pure conversion of analysis facts to the estimator input. It never infers a missing measurement
 * as zero and never parses identifier text to find files.
 */
export function buildEstimateInput(source: EstimateInputSource): EstimateInput {
  const entries = new Map(source.manifest.entries.map((entry) => [entry.fileId, entry]));
  const invalidated = new Set<FileId>(source.relationships.invalidatedScopedFileIds);
  const builtinByFile = new Map<FileId, Measurement<number>>();
  for (const row of source.relationships.confirmedBuiltinLowLevelCalls) {
    builtinByFile.set(row.fileId, row.confirmedBuiltinLowLevelCalls);
  }

  const eligibleMetrics = source.metrics
    .filter((metrics) => {
      const entry = entries.get(metrics.file.fileId);
      return (
        entry !== undefined &&
        entry.role === 'scoped' &&
        entry.ownership === 'first-party' &&
        source.parsedFileIds.has(metrics.file.fileId) &&
        !invalidated.has(metrics.file.fileId)
      );
    })
    .sort((left, right) => compareCodePoints(left.file.fileId, right.file.fileId));

  const projection = source.config.model.modelVersion === '1.0.0' ? undefined : source.projection;
  const eligibleFiles: EligibleFile[] = eligibleMetrics.map((rawMetrics) => {
    const fileProjection = projection?.files.get(rawMetrics.file.fileId);
    if (projection !== undefined && fileProjection === undefined) {
      throw new TypeError('An eligible file has no review projection.');
    }
    const metrics = fileProjection?.metrics ?? rawMetrics;
    const builtin = fileProjection?.builtin ?? builtinByFile.get(metrics.file.fileId);
    return {
      fileId: metrics.file.fileId,
      sourceLines: metrics.file.sourceLines,
      stateVariables: estimatorStorage(metrics.file.stateVariables),
      decisions: metrics.file.decisions,
      assemblyBlocks: metrics.file.assemblyBlocks,
      confirmedBuiltinLowLevelCalls: builtin ?? {
        status: 'unavailable',
        reason: BUILTIN_UNAVAILABLE_REASON,
      },
    };
  });
  const eligibleIds = new Set<FileId>(eligibleFiles.map((file) => file.fileId));

  const contractFile = new Map<ContractId, FileId>();
  for (const metrics of source.metrics) {
    for (const contract of metrics.contracts) contractFile.set(contract.id, contract.fileId);
  }
  const isEligibleContract = (id: ContractId): boolean => {
    const fileId = contractFile.get(id);
    return fileId !== undefined && eligibleIds.has(fileId);
  };
  const fullReview = projection?.dispositions.fullReview;
  const omitted = projection?.dispositions.omitted;
  /** Review role of an endpoint: retained, omitted from full review, or outside the scope. */
  const roleOf = (id: ContractId): 'full' | 'omitted' | 'external' => {
    if (!isEligibleContract(id)) return 'external';
    if (omitted?.has(id) === true) return 'omitted';
    return fullReview === undefined || fullReview.has(id) ? 'full' : 'omitted';
  };

  const seen = new Set<string>();
  const scopedPairs: Pair[] = [];
  const contextPairs: Pair[] = [];
  for (const pair of source.relationships.scopedPairs) {
    if (!isEligibleContract(pair.leftId) || !isEligibleContract(pair.rightId)) continue;
    const key = pairKey(pair);
    if (seen.has(key)) continue;
    seen.add(key);
    const left = roleOf(pair.leftId);
    const right = roleOf(pair.rightId);
    if (left === 'omitted' && right === 'omitted') continue;
    const target = left === 'full' && right === 'full' ? scopedPairs : contextPairs;
    target.push({ leftId: pair.leftId, rightId: pair.rightId });
  }
  for (const pair of source.relationships.contextPairs) {
    // One endpoint is scoped; an endpoint absent from the contract map is a context contract.
    if (!isEligibleContract(pair.leftId) && !isEligibleContract(pair.rightId)) continue;
    const key = pairKey(pair);
    if (seen.has(key)) continue;
    seen.add(key);
    const scopedEndpoint = isEligibleContract(pair.leftId) ? pair.leftId : pair.rightId;
    if (roleOf(scopedEndpoint) === 'omitted') continue;
    contextPairs.push({ leftId: pair.leftId, rightId: pair.rightId });
  }

  const reviewSummary =
    projection === undefined
      ? undefined
      : {
          mode: projection.dispositions.mode,
          analyzedSourceLines: projection.rawSourceLines,
          reusedSourceLines: projection.reusedSourceLines,
          outOfScopeSourceLines: projection.outOfScopeSourceLines,
          scopeNarrowed: projection.dispositions.scopeNarrowed,
        };

  return {
    eligibleFiles,
    scopedPairs,
    contextPairs,
    requiredAnalysisComplete: source.requiredAnalysisComplete,
    hasUnknownSemantics: source.relationships.hasUnknownSemantics,
    allowPartial: source.allowPartial,
    model: source.config.model,
    manualAdjustments: source.config.manualAdjustments,
    ...(reviewSummary === undefined ? {} : { reviewSummary }),
  };
}
