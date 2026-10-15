import type { FileId } from '../domain/types.ts';
import type { ParseFileResult } from '../parser/protocol.ts';
import { compareCodePoints } from './graph.ts';
import type {
  ComponentObservation,
  ComponentUnavailableReason,
  ImportObservation,
} from './types.ts';

/** The configured version authority that constrains a common grammar. */
export interface ComponentAuthority {
  readonly source: 'cli' | 'config' | 'metadata' | 'default';
  readonly version: string;
}

export interface ComponentFileInput {
  readonly fileId: FileId;
  /** Accepted syntax outcome for the file, or undefined when none was produced. */
  readonly syntax: ParseFileResult | undefined;
  readonly byteLength: number;
}

export interface ComponentPlanInput {
  readonly files: readonly ComponentFileInput[];
  readonly observations: readonly ImportObservation[];
  readonly authority: ComponentAuthority;
  readonly scopedFileIds: ReadonlySet<FileId>;
  readonly maxFiles: number;
  readonly maxBytes: number;
}

export interface ComponentPlan extends ComponentObservation {
  readonly totalBytes: number;
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

class DisjointSet {
  readonly #parent = new Map<string, string>();

  public add(id: string): void {
    if (!this.#parent.has(id)) this.#parent.set(id, id);
  }

  public find(id: string): string {
    let root = id;
    for (;;) {
      const parent = this.#parent.get(root);
      if (parent === undefined || parent === root) break;
      root = parent;
    }
    let current = id;
    while (current !== root) {
      const parent = this.#parent.get(current);
      if (parent === undefined) break;
      this.#parent.set(current, root);
      current = parent;
    }
    return root;
  }

  public union(left: string, right: string): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b)
      this.#parent.set(compareCodePoints(a, b) < 0 ? b : a, compareCodePoints(a, b) < 0 ? a : b);
  }
}

/**
 * Partitions resolved import connectivity as an undirected graph, including isolated files, and
 * decides per component whether binding is meaningful. A component is unavailable when any member
 * failed syntax, any member import is not uniquely resolved, no installed grammar satisfies every
 * member, an exact `cli`/`config` version is excluded, or the effective size limits are exceeded.
 * Foundry metadata is only a hint and never constrains the common grammar.
 */
export function planComponents(input: ComponentPlanInput): ComponentPlan[] {
  const files = new Map<FileId, ComponentFileInput>();
  const sets = new DisjointSet();
  for (const file of input.files) {
    files.set(file.fileId, file);
    sets.add(file.fileId);
  }
  const unresolvedImporters = new Set<FileId>();
  for (const item of input.observations) {
    if (!files.has(item.importerFileId)) continue;
    if (item.status !== 'resolved' || item.targetFileId === null) {
      unresolvedImporters.add(item.importerFileId);
      continue;
    }
    if (files.has(item.targetFileId)) sets.union(item.importerFileId, item.targetFileId);
  }

  const groups = new Map<string, FileId[]>();
  for (const file of input.files) {
    const root = sets.find(file.fileId);
    const members = groups.get(root) ?? [];
    members.push(file.fileId);
    groups.set(root, members);
  }

  const plans: ComponentPlan[] = [];
  for (const members of groups.values()) {
    const sorted = [...members].sort(compareCodePoints);
    const id = sorted[0];
    if (id === undefined) continue;
    const memberFiles = sorted.map((memberId) => files.get(memberId));
    let totalBytes = 0;
    let syntaxFailed = false;
    let intersection: string[] | null = null;
    for (const member of memberFiles) {
      if (member === undefined) continue;
      totalBytes += member.byteLength;
      if (member.syntax?.status !== 'parsed') {
        syntaxFailed = true;
        continue;
      }
      const compatible: readonly string[] = member.syntax.version.compatibleVersions;
      intersection =
        intersection === null
          ? [...compatible]
          : intersection.filter((version) => compatible.includes(version));
    }
    const base = { id: id as FileId, members: sorted as FileId[], totalBytes };
    const unavailable = (reason: ComponentUnavailableReason): ComponentPlan => ({
      ...base,
      grammar: null,
      status: 'unavailable',
      reason,
    });

    if (syntaxFailed) {
      plans.push(unavailable('member-syntax-failed'));
      continue;
    }
    if (sorted.some((memberId) => unresolvedImporters.has(memberId))) {
      plans.push(unavailable('unresolved-import'));
      continue;
    }
    const candidates = (intersection ?? []).sort(compareVersions);
    if (candidates.length === 0) {
      plans.push(unavailable('no-common-grammar'));
      continue;
    }
    const exact = input.authority.source === 'cli' || input.authority.source === 'config';
    if (exact && !candidates.includes(input.authority.version)) {
      plans.push(unavailable('authority-excludes-grammar'));
      continue;
    }
    if (sorted.length > input.maxFiles || totalBytes > input.maxBytes) {
      plans.push(unavailable('component-too-large'));
      continue;
    }
    if (!sorted.some((memberId) => input.scopedFileIds.has(memberId as FileId))) {
      plans.push(unavailable('no-scoped-member'));
      continue;
    }
    const grammar = exact ? input.authority.version : candidates[candidates.length - 1];
    if (grammar === undefined) {
      plans.push(unavailable('no-common-grammar'));
      continue;
    }
    plans.push({ ...base, grammar, status: 'available', reason: null });
  }
  return plans.sort((left, right) => compareCodePoints(left.id, right.id));
}
