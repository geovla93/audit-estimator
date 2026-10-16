import type { ContractId, FileId, Measurement } from '../../domain/types.ts';
import type { FileMetrics } from '../../metrics/structural.ts';

/**
 * Why a top-level declaration receives no full-review charge. `content-reuse` is verified reusable
 * source; `caller-context` is code the caller left out of an explicit contract selection. The two
 * are never interchangeable: a caller exclusion is not evidence of reuse.
 */
export type OmissionReason = 'content-reuse' | 'caller-context';

/** Complete, disjoint disposition of every eligible top-level declaration. */
export interface ContractDispositions {
  readonly mode: 'all' | 'contracts';
  readonly reason: string | null;
  /** Declarations that receive the full-review rate. */
  readonly fullReview: ReadonlySet<ContractId>;
  /** Declarations omitted from the full-review view, with the reason. */
  readonly omitted: ReadonlyMap<ContractId, OmissionReason>;
  /** True when at least one eligible declaration was excluded by the caller. */
  readonly scopeNarrowed: boolean;
}

/** One eligible file's review view and its line accounting. */
export interface FileProjection {
  readonly fileId: FileId;
  /** Raw metrics when nothing is omitted, otherwise the derived review view. */
  readonly metrics: FileMetrics;
  /** Confirmed builtin low-level call count for the review view. */
  readonly builtin: Measurement<number> | null;
  readonly rawSourceLines: number;
  readonly reviewSourceLines: number;
  readonly reusedSourceLines: number;
  readonly outOfScopeSourceLines: number;
}

export interface ReviewProjection {
  readonly dispositions: ContractDispositions;
  readonly files: ReadonlyMap<FileId, FileProjection>;
  readonly rawSourceLines: number;
  readonly reviewSourceLines: number;
  readonly reusedSourceLines: number;
  readonly outOfScopeSourceLines: number;
}

/** Typed outcome for a numeric projection that cannot be proven; never widens the scope. */
export class ProjectionUnavailableError extends Error {
  public constructor() {
    super('The requested review scope could not be projected.');
    this.name = 'ProjectionUnavailableError';
  }
}
