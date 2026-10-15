import { canonicalJson } from '../domain/canonical.ts';
import type {
  ContractId,
  Diagnostic,
  EvidenceRef,
  FileId,
  Ownership,
  ScopeRole,
} from '../domain/types.ts';
import type { ContractPair, PairKind } from './types.ts';

export function compareCodePoints(left: string, right: string): number {
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

/** Thrown when a retained collection element would exceed the shared graph allowance. */
export class GraphLimitError extends Error {
  public constructor() {
    super('The relationship graph allowance was exhausted.');
    this.name = 'GraphLimitError';
  }
}

/**
 * One analysis-level allowance shared by public graph/import rows, semantic sites, candidate and
 * evidence references, and derived pair/ancestor references. Every retained collection element is
 * charged before it is added; a reference stored in several collections costs several slots.
 */
export class GraphAllowance {
  readonly #maximum: number;
  #used = 0;

  public constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 0) {
      throw new TypeError('The graph allowance must be a nonnegative safe integer.');
    }
    this.#maximum = maximum;
  }

  public get used(): number {
    return this.#used;
  }

  public get remaining(): number {
    return this.#maximum - this.#used;
  }

  public get exhausted(): boolean {
    return this.#used >= this.#maximum;
  }

  /** Charges `count` slots, throwing before any state changes when they do not fit. */
  public spend(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError('A graph charge must be a nonnegative safe integer.');
    }
    if (this.#used + count > this.#maximum) throw new GraphLimitError();
    this.#used += count;
  }

  public tryCharge(count: number): boolean {
    try {
      this.spend(count);
      return true;
    } catch (error: unknown) {
      if (error instanceof GraphLimitError) return false;
      throw error;
    }
  }
}

/**
 * Iterative Tarjan SCC. Components are emitted successors-first (reverse topological order of the
 * condensation), members and edges are visited in sorted order for deterministic output.
 */
export function stronglyConnectedComponents(
  nodes: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const ordered = [...nodes].sort(compareCodePoints);
  const nodeSet = new Set(ordered);
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of ordered) {
    if (index.has(root)) continue;
    const frames: {
      readonly node: string;
      next: number;
      readonly successors: readonly string[];
    }[] = [];
    const enter = (node: string): void => {
      index.set(node, counter);
      lowLink.set(node, counter);
      counter += 1;
      stack.push(node);
      onStack.add(node);
      const successors = [...new Set(edges.get(node) ?? [])]
        .filter((candidate) => nodeSet.has(candidate))
        .sort(compareCodePoints);
      frames.push({ node, next: 0, successors });
    };
    enter(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) break;
      if (frame.next < frame.successors.length) {
        const successor = frame.successors[frame.next];
        frame.next += 1;
        if (successor === undefined) continue;
        if (!index.has(successor)) {
          enter(successor);
        } else if (onStack.has(successor)) {
          lowLink.set(
            frame.node,
            Math.min(lowLink.get(frame.node) ?? 0, index.get(successor) ?? 0),
          );
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) {
        lowLink.set(
          parent.node,
          Math.min(lowLink.get(parent.node) ?? 0, lowLink.get(frame.node) ?? 0),
        );
      }
      if (lowLink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        components.push(component.sort(compareCodePoints));
      }
    }
  }
  return components;
}

/** Nontrivial SCCs, plus one-node SCCs that import themselves, sorted by smallest member. */
export function cyclicComponents(
  nodes: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): string[][] {
  return stronglyConnectedComponents(nodes, edges)
    .filter((component) => {
      if (component.length > 1) return true;
      const only = component[0];
      return only !== undefined && (edges.get(only) ?? []).includes(only);
    })
    .sort((left, right) => compareCodePoints(left[0] ?? '', right[0] ?? ''));
}

function diagnosticKey(item: Diagnostic): string {
  return canonicalJson({
    code: item.code,
    severity: item.severity,
    phase: item.phase,
    message: item.message,
    fileId: item.fileId ?? null,
    range: item.range ?? null,
    details: item.details ?? null,
  });
}

/** Deterministic deduplication and ordering of accumulated diagnostics. */
export function dedupeDiagnostics(items: readonly Diagnostic[]): Diagnostic[] {
  const unique = new Map<string, Diagnostic>();
  for (const item of items) {
    const key = diagnosticKey(item);
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([, item]) => item);
}

/** One directed pair claim before eligibility filtering and deduplication. */
export interface PairClaim {
  readonly leftId: ContractId;
  readonly rightId: ContractId;
  readonly kind: PairKind;
  readonly evidence: readonly EvidenceRef[];
}

export interface PairEligibility {
  readonly fileOf: ReadonlyMap<ContractId, FileId>;
  readonly entries: ReadonlyMap<
    FileId,
    { readonly role: ScopeRole; readonly ownership: Ownership }
  >;
}

export interface DerivedPairs {
  readonly scopedPairs: readonly ContractPair[];
  readonly contextPairs: readonly ContractPair[];
  readonly limited: boolean;
}

const PAIR_KIND_ORDER: readonly PairKind[] = ['call', 'inheritance'];

/**
 * Deduplicates directed contract-pair claims into disjoint, sorted scoped and context partitions.
 * The owner must be a still-eligible first-party scoped contract; a scoped first-party target
 * yields a scoped pair and a context target a context pair. Self-pairs, unknown or ineligible
 * endpoints and file-level endpoints are skipped. Reverse direction is a separate pair, kinds and
 * distinct evidence are united per ordered pair, and nothing transitive is materialized.
 */
export function derivePairs(
  claims: readonly PairClaim[],
  eligibility: PairEligibility,
  allowance: GraphAllowance,
): DerivedPairs {
  interface Accumulator {
    readonly leftId: ContractId;
    readonly rightId: ContractId;
    readonly partition: 'scoped' | 'context';
    readonly kinds: Set<PairKind>;
    readonly evidence: Map<string, EvidenceRef>;
  }
  const accumulators = new Map<string, Accumulator>();
  let limited = false;
  const eligibleOwner = (id: ContractId): boolean => {
    const fileId = eligibility.fileOf.get(id);
    const entry = fileId === undefined ? undefined : eligibility.entries.get(fileId);
    return entry?.role === 'scoped' && entry.ownership === 'first-party';
  };
  const partitionOf = (id: ContractId): 'scoped' | 'context' | null => {
    const fileId = eligibility.fileOf.get(id);
    const entry = fileId === undefined ? undefined : eligibility.entries.get(fileId);
    if (entry === undefined) return null;
    if (entry.role === 'scoped') return entry.ownership === 'first-party' ? 'scoped' : null;
    return entry.role === 'context' ? 'context' : null;
  };

  const ordered = [...claims].sort(
    (left, right) =>
      compareCodePoints(left.leftId, right.leftId) ||
      compareCodePoints(left.rightId, right.rightId) ||
      compareCodePoints(left.kind, right.kind),
  );
  for (const claim of ordered) {
    if (claim.leftId === claim.rightId || !eligibleOwner(claim.leftId)) continue;
    const partition = partitionOf(claim.rightId);
    if (partition === null) continue;
    const key = `${claim.leftId}\u0000${claim.rightId}`;
    let accumulator = accumulators.get(key);
    let prepaid = 0;
    if (accumulator === undefined) {
      // The pair, its first kind and its first evidence reference are charged together so a pair
      // never exists without a kind or without evidence.
      prepaid = Math.min(1, claim.evidence.length);
      if (!allowance.tryCharge(2 + prepaid)) {
        limited = true;
        continue;
      }
      accumulator = {
        leftId: claim.leftId,
        rightId: claim.rightId,
        partition,
        kinds: new Set(),
        evidence: new Map(),
      };
      accumulator.kinds.add(claim.kind);
      accumulators.set(key, accumulator);
    } else if (!accumulator.kinds.has(claim.kind)) {
      if (!allowance.tryCharge(1)) {
        limited = true;
        continue;
      }
      accumulator.kinds.add(claim.kind);
    }
    for (const item of claim.evidence) {
      const evidenceId = evidenceKey(item);
      if (accumulator.evidence.has(evidenceId)) continue;
      if (prepaid > 0) {
        prepaid -= 1;
      } else if (!allowance.tryCharge(1)) {
        limited = true;
        break;
      }
      accumulator.evidence.set(evidenceId, item);
    }
  }
  const scopedPairs: ContractPair[] = [];
  const contextPairs: ContractPair[] = [];
  for (const accumulator of accumulators.values()) {
    const pair: ContractPair = {
      leftId: accumulator.leftId,
      rightId: accumulator.rightId,
      kinds: PAIR_KIND_ORDER.filter((kind) => accumulator.kinds.has(kind)),
      evidence: uniqueEvidence([...accumulator.evidence.values()]),
    };
    (accumulator.partition === 'scoped' ? scopedPairs : contextPairs).push(pair);
  }
  const sortPairs = (pairs: ContractPair[]): ContractPair[] =>
    pairs.sort(
      (left, right) =>
        compareCodePoints(left.leftId, right.leftId) ||
        compareCodePoints(left.rightId, right.rightId),
    );
  return { scopedPairs: sortPairs(scopedPairs), contextPairs: sortPairs(contextPairs), limited };
}

export function evidenceKey(evidence: EvidenceRef): string {
  return `${evidence.fileId}\u0000${evidence.range.startByte}\u0000${evidence.range.endByte}`;
}

/** Distinct evidence sorted by file and range. */
export function uniqueEvidence(items: readonly EvidenceRef[]): EvidenceRef[] {
  const unique = new Map<string, EvidenceRef>();
  for (const item of items) unique.set(evidenceKey(item), item);
  return [...unique.values()].sort(
    (left, right) =>
      compareCodePoints(left.fileId, right.fileId) ||
      left.range.startByte - right.range.startByte ||
      left.range.endByte - right.range.endByte,
  );
}
