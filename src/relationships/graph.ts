import { canonicalJson } from '../domain/canonical.ts';
import type { Diagnostic, EvidenceRef } from '../domain/types.ts';

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
