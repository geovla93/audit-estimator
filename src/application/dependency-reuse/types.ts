import type {
  ContractId,
  DeclarationKind,
  FileId,
  Measurement,
  SourceRange,
} from '../../domain/types.ts';
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

/** One reviewed immutable upstream source file in the bundled reference catalog. */
export interface CatalogFile {
  /** Stable short reference ID prefix, e.g. `oz-contracts@v4.3.2:contracts/utils/Address.sol`. */
  readonly id: string;
  readonly repository: string;
  readonly tag: string;
  /** Immutable 40-hex commit the tag was resolved to. */
  readonly commit: string;
  readonly path: string;
  /** SHA-256 of the original file bytes. */
  readonly sha256: string;
  readonly license: string;
  /** Reference pragma evidence, selected grammar and the worker-validated compatible set. */
  readonly pragma: string;
  readonly selectedGrammar: string;
  /** Index into the catalog's shared `grammarSets` (worker-validated compatible versions). */
  readonly grammarSet: number;
}

export interface CatalogDeclaration {
  /** Index into `files`. */
  readonly file: number;
  readonly kind: DeclarationKind;
  readonly name: string;
  readonly digest: string;
  readonly tokenCount: number;
}

/** Bundled, statically generated reference data. Never loaded from a target or the network. */
export interface DependencyCatalog {
  /** `unavailable` can never award a match. */
  readonly status: 'available' | 'unavailable';
  readonly version: string;
  /** SHA-256 identity of everything below; changes whenever any record changes. */
  readonly digest: string;
  readonly parserVersion: string;
  readonly normalizerVersion: string;
  /** Distinct compatible grammar version sets, shared by the files that reference them. */
  readonly grammarSets: readonly (readonly string[])[];
  readonly files: readonly CatalogFile[];
  readonly declarations: readonly CatalogDeclaration[];
}

export interface DependencyMatch {
  readonly fileId: FileId;
  readonly contractId: ContractId;
  readonly range: SourceRange;
  readonly digest: string;
  /** Sorted reference IDs whose content and compatible grammar set both match. */
  readonly referenceIds: readonly string[];
}

export type RecognitionState =
  | { readonly status: 'available'; readonly matches: readonly DependencyMatch[] }
  | { readonly status: 'unavailable'; readonly reason: string };
