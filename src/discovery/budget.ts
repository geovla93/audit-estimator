import { setImmediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { AnalysisLimits } from '../domain/types.ts';

export type BudgetFailureKind = 'limit' | 'cancelled' | 'deadline';
export type BudgetCounterName =
  | 'filesystemEntries'
  | 'globStates'
  | 'sourceBytes'
  | 'metadataBytes';

export interface BudgetCounters {
  readonly filesystemEntries: number;
  readonly globStates: number;
  readonly sourceBytes: number;
  readonly metadataBytes: number;
  readonly sourceFiles: number;
  readonly failedSourceReads: number;
}

export interface DiscoveryBudgetOptions {
  readonly limits: AnalysisLimits;
  readonly signal?: AbortSignal | undefined;
  readonly deadlineAt?: number | undefined;
}

const ANALYSIS_LIMIT_KEYS = [
  'maxFileBytes',
  'maxTotalSourceBytes',
  'maxFiles',
  'maxFsEntries',
  'maxDirectoryDepth',
  'maxImports',
  'maxGraphEdges',
  'maxAstNodesPerFile',
  'maxAstNodesTotal',
  'maxPatternsPerList',
  'maxPatternLength',
  'maxGlobStates',
  'maxMetadataBytes',
  'maxLcovBytes',
  'parseTimeoutMs',
  'maxSemanticFiles',
  'maxSemanticBytes',
  'semanticTimeoutMs',
  'analysisTimeoutMs',
] as const satisfies readonly (keyof AnalysisLimits)[];

function immutableLimits(limits: AnalysisLimits): AnalysisLimits {
  return Object.freeze({ ...limits });
}

export class BudgetError extends Error {
  public readonly kind: BudgetFailureKind;
  public readonly budget: BudgetCounterName | null;

  public constructor(kind: BudgetFailureKind, budget: BudgetCounterName | null = null) {
    super(kind === 'limit' ? 'An analysis budget was exceeded.' : 'Analysis was interrupted.');
    this.name = 'BudgetError';
    this.kind = kind;
    this.budget = budget;
  }
}

const YIELD_INTERVAL = 256;

/** One mutable budget is shared by discovery, metadata, source reads, and later imports. */
export class DiscoveryBudget {
  #limits: AnalysisLimits;
  public readonly signal: AbortSignal | undefined;
  #startedAt: number;
  #externalDeadlineAt: number;
  #deadlineAt: number;
  #filesystemEntries = 0;
  #globStates = 0;
  #sourceBytes = 0;
  #metadataBytes = 0;
  #sourceIdentities = new Map<string, 'reserved' | 'committed'>();
  #failedSourceReads = 0;
  #operationsSinceYield = 0;

  public constructor(options: DiscoveryBudgetOptions) {
    this.#limits = immutableLimits(options.limits);
    this.signal = options.signal;
    this.#startedAt = performance.now();
    this.#externalDeadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;
    this.#deadlineAt = Math.min(
      this.#externalDeadlineAt,
      this.#startedAt + this.#limits.analysisTimeoutMs,
    );
  }

  public get limits(): AnalysisLimits {
    return this.#limits;
  }

  public get deadlineAt(): number {
    return this.#deadlineAt;
  }

  /** Shortens the absolute monotonic-clock deadline without changing the budget start. */
  public tightenDeadline(deadlineAt: number): void {
    if (!Number.isFinite(deadlineAt)) {
      throw new TypeError('A tightened analysis deadline must be finite.');
    }
    this.#externalDeadlineAt = Math.min(this.#externalDeadlineAt, deadlineAt);
    this.#deadlineAt = Math.min(this.#deadlineAt, deadlineAt);
    this.check();
  }

  /**
   * Applies resolved configuration limits without resetting any accumulated work.
   * This is intended for the metadata-to-discovery handoff, before source reads begin.
   */
  public tightenLimits(limits: AnalysisLimits): void {
    for (const key of ANALYSIS_LIMIT_KEYS) {
      if (limits[key] > this.#limits[key]) {
        throw new TypeError('Resolved analysis limits cannot widen the shared budget.');
      }
    }

    const counters = this.counters;
    if (
      counters.filesystemEntries > limits.maxFsEntries ||
      counters.globStates > limits.maxGlobStates ||
      counters.sourceBytes > limits.maxTotalSourceBytes ||
      counters.metadataBytes > limits.maxMetadataBytes ||
      counters.sourceFiles > limits.maxFiles
    ) {
      throw new BudgetError('limit');
    }
    if (counters.sourceBytes > 0 && limits.maxFileBytes < this.#limits.maxFileBytes) {
      // Per-file consumption is not retained after a snapshot is cached, so a smaller
      // per-file cap cannot be proven safe after any source read has started.
      throw new BudgetError('limit', 'sourceBytes');
    }

    this.#limits = immutableLimits(limits);
    this.#deadlineAt = Math.min(
      this.#externalDeadlineAt,
      this.#startedAt + this.#limits.analysisTimeoutMs,
    );
    this.check();
  }

  public assertLimitsMatch(limits: AnalysisLimits): void {
    if (ANALYSIS_LIMIT_KEYS.some((key) => limits[key] !== this.#limits[key])) {
      throw new TypeError('Discovery configuration limits must match the shared analysis budget.');
    }
  }

  public check(): void {
    if (this.signal?.aborted === true) throw new BudgetError('cancelled');
    if (performance.now() >= this.deadlineAt) throw new BudgetError('deadline');
  }

  public async checkpoint(forceYield = false): Promise<void> {
    this.check();
    this.#operationsSinceYield += 1;
    if (!forceYield && this.#operationsSinceYield < YIELD_INTERVAL) return;
    this.#operationsSinceYield = 0;
    await setImmediate();
    this.check();
  }

  public chargeFilesystemEntry(): void {
    this.#filesystemEntries += 1;
    this.check();
    if (this.#filesystemEntries > this.limits.maxFsEntries) {
      throw new BudgetError('limit', 'filesystemEntries');
    }
  }

  public chargeGlobState(): void {
    this.check();
    if (this.#globStates >= this.limits.maxGlobStates) {
      throw new BudgetError('limit', 'globStates');
    }
    this.#globStates += 1;
  }

  public reserveSourceIdentity(identity: string): boolean {
    this.check();
    if (this.#sourceIdentities.has(identity)) return false;
    if (this.#sourceIdentities.size >= this.limits.maxFiles) {
      throw new BudgetError('limit', null);
    }
    this.#sourceIdentities.set(identity, 'reserved');
    return true;
  }

  public commitSourceIdentity(identity: string): void {
    this.check();
    if (this.#sourceIdentities.has(identity)) this.#sourceIdentities.set(identity, 'committed');
  }

  public releaseSourceIdentity(identity: string): void {
    if (this.#sourceIdentities.get(identity) === 'reserved')
      this.#sourceIdentities.delete(identity);
  }

  public hasSourceIdentity(identity: string): boolean {
    return this.#sourceIdentities.has(identity);
  }

  public recordSourceReadFailure(): void {
    this.#failedSourceReads += 1;
  }

  public sourceByteAllowance(fileBytesRead: number): number {
    return Math.max(
      0,
      Math.min(
        this.limits.maxFileBytes - fileBytesRead,
        this.limits.maxTotalSourceBytes - this.#sourceBytes,
      ),
    );
  }

  public chargeSourceBytes(bytesRead: number): void {
    this.#sourceBytes += bytesRead;
    this.check();
  }

  public metadataByteAllowance(): number {
    return Math.max(0, this.limits.maxMetadataBytes - this.#metadataBytes);
  }

  public chargeMetadataBytes(bytesRead: number): void {
    this.#metadataBytes += bytesRead;
    this.check();
  }

  public get counters(): BudgetCounters {
    return {
      filesystemEntries: this.#filesystemEntries,
      globStates: this.#globStates,
      sourceBytes: this.#sourceBytes,
      metadataBytes: this.#metadataBytes,
      sourceFiles: this.#sourceIdentities.size,
      failedSourceReads: this.#failedSourceReads,
    };
  }
}

export function createDiscoveryBudget(
  limits: AnalysisLimits,
  signal?: AbortSignal,
  deadlineAt?: number,
): DiscoveryBudget {
  return new DiscoveryBudget({
    limits,
    ...(signal === undefined ? {} : { signal }),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  });
}
