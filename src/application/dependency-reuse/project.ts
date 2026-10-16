import type { ContractId, FileId, Measurement } from '../../domain/types.ts';
import { buildReviewMetrics, retainedEvents } from '../../metrics/structural.ts';
import type { FileMetrics } from '../../metrics/structural.ts';
import type { ParseFileResult, ParserSource } from '../../parser/protocol.ts';
import { countConfirmedBuiltins } from '../../relationships/calls.ts';
import type { CallSiteFact } from '../../relationships/types.ts';
import { ProjectionUnavailableError } from './types.ts';
import type { ContractDispositions, FileProjection, ReviewProjection } from './types.ts';

export interface ProjectReviewInput {
  readonly dispositions: ContractDispositions;
  /** Raw metrics of the eligible files only. */
  readonly metrics: readonly FileMetrics[];
  readonly sources: ReadonlyMap<FileId, ParserSource>;
  readonly syntax: ReadonlyMap<FileId, ParseFileResult>;
  readonly callSites: readonly CallSiteFact[];
  /** Raw per-file confirmed builtin counts from the relationship analysis. */
  readonly rawBuiltin: ReadonlyMap<FileId, Measurement<number>>;
  /** Shared-budget checkpoint; its failures propagate to the caller unchanged. */
  readonly checkpoint: () => Promise<void>;
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

const SEMANTICS_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  'semantics-unavailable',
  'syntax-failed',
]);

/**
 * Recomputes the confirmed builtin low-level call count for the retained region with the existing
 * counting rule. Syntax call events and call-site facts are filtered consistently; coverage that
 * cannot be proven stays unavailable rather than being guessed.
 */
async function reviewBuiltin(
  fileId: FileId,
  result: Extract<ParseFileResult, { status: 'parsed' }>,
  raw: FileMetrics,
  omitted: ReadonlySet<ContractId>,
  callSites: readonly CallSiteFact[],
  rawBuiltin: Measurement<number> | undefined,
  checkpoint: () => Promise<void>,
): Promise<Measurement<number>> {
  const semantics =
    rawBuiltin !== undefined &&
    !(rawBuiltin.status === 'unavailable' && SEMANTICS_UNAVAILABLE_REASONS.has(rawBuiltin.reason))
      ? ('bound' as const)
      : ('unavailable' as const);
  const events = await retainedEvents(raw, result, omitted, checkpoint);
  const facts = callSites.filter(
    (fact) =>
      fact.fileId === fileId &&
      (fact.ownerContractId === null || !omitted.has(fact.ownerContractId)),
  );
  const counted = countConfirmedBuiltins({
    files: [{ fileId, syntax: { ...result, events }, semantics }],
    facts,
  });
  const row = counted[0];
  if (row === undefined) throw new ProjectionUnavailableError();
  return row.confirmedBuiltinLowLevelCalls;
}

/**
 * Builds the estimator-specific review view for the eligible files. Raw metrics, accepted syntax
 * and graphs are never changed. A file with no omitted declaration keeps its raw facts; otherwise
 * a derived view removes only the omitted declarations, and removed physical lines are accounted
 * as content reuse (`all` mode) or caller exclusion (`contracts` mode) exactly once.
 */
export async function projectReview(input: ProjectReviewInput): Promise<ReviewProjection> {
  const { dispositions } = input;
  const files = new Map<FileId, FileProjection>();
  let raw = 0;
  let review = 0;
  let reused = 0;
  let outOfScope = 0;
  const ordered = [...input.metrics].sort((left, right) =>
    compareCodePoints(left.file.fileId, right.file.fileId),
  );
  for (const metrics of ordered) {
    await input.checkpoint();
    const fileId = metrics.file.fileId;
    if (metrics.file.sourceLines.status !== 'measured') throw new ProjectionUnavailableError();
    const rawLines = metrics.file.sourceLines.value;
    const omitted = new Set<ContractId>();
    for (const contract of metrics.contracts) {
      if (dispositions.omitted.has(contract.id)) omitted.add(contract.id);
    }
    let projection: FileProjection;
    if (omitted.size === 0) {
      projection = {
        fileId,
        metrics,
        builtin: input.rawBuiltin.get(fileId) ?? null,
        rawSourceLines: rawLines,
        reviewSourceLines: rawLines,
        reusedSourceLines: 0,
        outOfScopeSourceLines: 0,
      };
    } else {
      const source = input.sources.get(fileId);
      const result = input.syntax.get(fileId);
      if (source === undefined || result === undefined || result.status !== 'parsed') {
        throw new ProjectionUnavailableError();
      }
      let derived: FileMetrics;
      try {
        derived = await buildReviewMetrics(metrics, source, result, omitted, input.checkpoint);
      } catch (error: unknown) {
        if (error instanceof TypeError) throw new ProjectionUnavailableError();
        throw error;
      }
      if (derived.file.sourceLines.status !== 'measured') throw new ProjectionUnavailableError();
      const reviewLines = derived.file.sourceLines.value;
      const removed = rawLines - reviewLines;
      if (removed < 0) throw new ProjectionUnavailableError();
      const builtin = await reviewBuiltin(
        fileId,
        result,
        metrics,
        omitted,
        input.callSites,
        input.rawBuiltin.get(fileId),
        input.checkpoint,
      );
      projection = {
        fileId,
        metrics: derived,
        builtin,
        rawSourceLines: rawLines,
        reviewSourceLines: reviewLines,
        reusedSourceLines: dispositions.mode === 'all' ? removed : 0,
        outOfScopeSourceLines: dispositions.mode === 'contracts' ? removed : 0,
      };
    }
    files.set(fileId, projection);
    raw += projection.rawSourceLines;
    review += projection.reviewSourceLines;
    reused += projection.reusedSourceLines;
    outOfScope += projection.outOfScopeSourceLines;
    if (![raw, review, reused, outOfScope].every((value) => Number.isSafeInteger(value))) {
      throw new ProjectionUnavailableError();
    }
  }
  if (raw !== review + reused + outOfScope) throw new ProjectionUnavailableError();
  return {
    dispositions,
    files,
    rawSourceLines: raw,
    reviewSourceLines: review,
    reusedSourceLines: reused,
    outOfScopeSourceLines: outOfScope,
  };
}
