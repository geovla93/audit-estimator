import { ConfigError } from '../config/defaults.ts';
import type {
  ContractId,
  EstimationScopeAnalysis,
  EstimationScopeInput,
  FileId,
  Measurement,
  ScopeManifest,
} from '../domain/types.ts';
import type { FileMetrics } from '../metrics/structural.ts';
import type {
  ContractDispositions,
  OmissionReason,
  ReviewProjection,
} from './dependency-reuse/types.ts';

/** Absolute bound on every scope ID array; a caller selection is never truncated. */
export const MAX_SCOPE_CONTRACT_IDS: number = 100_000;
/** Bound on explicit selectors, checked before any allocation. */
export const MAX_SCOPE_SELECTORS: number = 10_000;

const UNAVAILABLE_PROJECTION_REASON =
  'The requested review scope could not be projected, so no line accounting is available.';

/** An internal scope exceeds its public bound; reported as a sanitized `LIMIT_EXCEEDED`. */
export class ScopeLimitError extends Error {
  public constructor() {
    super('An estimation scope exceeds its public bound.');
    this.name = 'ScopeLimitError';
  }
}

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

export function assertScopeBounds(ids: readonly unknown[]): void {
  if (ids.length > MAX_SCOPE_CONTRACT_IDS) throw new ScopeLimitError();
}

export interface ScopeResolutionInput {
  readonly scope: EstimationScopeInput;
  readonly manifest: ScopeManifest;
  /** Raw metrics of every scoped file. */
  readonly metrics: readonly FileMetrics[];
  /** Scoped, first-party, parsed, non-invalidated files. */
  readonly eligibleFileIds: ReadonlySet<FileId>;
  /** Shared-budget checkpoint; its failures propagate unchanged. */
  readonly checkpoint: () => Promise<void>;
}

function unresolved(): ConfigError {
  return new ConfigError(
    'An estimation scope selector did not resolve to one eligible declaration.',
  );
}

/**
 * Resolves the estimation scope against the final accepted declarations and returns a complete,
 * disjoint partition of the eligible top-level declarations. Selector validation is independent of
 * any content recognition. Every selector must name exactly one declaration (path, kind and name)
 * in an eligible first-party scoped file; nothing is silently dropped or retargeted. The only
 * rejection raised here is a sanitized `ConfigError`.
 */
export async function resolveDispositions(
  input: ScopeResolutionInput,
): Promise<ContractDispositions> {
  const eligibleMetrics = input.metrics.filter((metrics) =>
    input.eligibleFileIds.has(metrics.file.fileId),
  );
  const eligibleIds: ContractId[] = [];
  for (const metrics of eligibleMetrics) {
    for (const contract of metrics.contracts) eligibleIds.push(contract.id);
  }
  assertScopeBounds(eligibleIds);

  const scope = input.scope;
  if (scope.mode === 'all') {
    return {
      mode: 'all',
      reason: null,
      fullReview: new Set(eligibleIds),
      omitted: new Map(),
      scopeNarrowed: false,
    };
  }

  if (scope.contracts.length === 0 || scope.contracts.length > MAX_SCOPE_SELECTORS) {
    throw unresolved();
  }
  const entryByPath = new Map(input.manifest.entries.map((entry) => [entry.path, entry]));
  const metricsByFile = new Map(eligibleMetrics.map((metrics) => [metrics.file.fileId, metrics]));
  const selected = new Set<ContractId>();
  const identities = new Set<string>();
  for (const selector of scope.contracts) {
    await input.checkpoint();
    const identity = JSON.stringify([selector.path, selector.kind, selector.name]);
    if (identities.has(identity)) throw unresolved();
    identities.add(identity);
    const entry = entryByPath.get(selector.path);
    if (entry === undefined || !input.eligibleFileIds.has(entry.fileId)) throw unresolved();
    if (selector.sourceHash !== undefined && selector.sourceHash !== entry.byteHash) {
      throw unresolved();
    }
    const metrics = metricsByFile.get(entry.fileId);
    const matches = (metrics?.contracts ?? []).filter(
      (contract) => contract.kind === selector.kind && contract.name === selector.name,
    );
    const match = matches[0];
    if (matches.length !== 1 || match === undefined) throw unresolved();
    selected.add(match.id);
  }
  const omitted = new Map<ContractId, OmissionReason>();
  for (const id of eligibleIds) {
    if (!selected.has(id)) omitted.set(id, 'caller-context');
  }
  return {
    mode: 'contracts',
    reason: scope.reason,
    fullReview: selected,
    omitted,
    scopeNarrowed: omitted.size > 0,
  };
}

function counted(value: number | undefined): Measurement<number> {
  return value === undefined
    ? { status: 'unavailable', reason: UNAVAILABLE_PROJECTION_REASON }
    : { status: 'measured', value, evidence: [] };
}

export interface ScopeAnalysisInput {
  readonly dispositions: ContractDispositions;
  /** Null when the numeric projection could not be completed. */
  readonly projection: ReviewProjection | null;
  /** Raw required-analysis completeness, which `all` mode additionally requires. */
  readonly requiredAnalysisComplete: boolean;
}

/**
 * Public scope metadata. In `all` mode selected IDs are full-review declarations and context IDs
 * are applied content reuse; in `contracts` mode they are the exact caller selection and its
 * context complement. Aggregate counts are measured together or unavailable together.
 */
export function buildEstimationScopeAnalysis(input: ScopeAnalysisInput): EstimationScopeAnalysis {
  const { dispositions, projection } = input;
  assertScopeBounds([...dispositions.fullReview]);
  assertScopeBounds([...dispositions.omitted.keys()]);
  const projected = projection !== null;
  return {
    mode: dispositions.mode,
    reason: dispositions.reason,
    selectedContractIds: [...dispositions.fullReview].sort(compareCodePoints),
    contextContractIds: [...dispositions.omitted.keys()].sort(compareCodePoints),
    scopeNarrowed: dispositions.scopeNarrowed,
    requestedScopeComplete:
      projected && (dispositions.mode === 'contracts' || input.requiredAnalysisComplete),
    rawSourceLines: counted(projection?.rawSourceLines),
    reviewSourceLines: counted(projection?.reviewSourceLines),
    reusedSourceLines: counted(projection?.reusedSourceLines),
    outOfScopeSourceLines: counted(projection?.outOfScopeSourceLines),
  };
}
