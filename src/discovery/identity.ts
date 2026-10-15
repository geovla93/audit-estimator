import type { BigIntStats } from 'node:fs';
import type { SourceSnapshot } from '../domain/types.ts';
import type { SafePath } from './safe-path.ts';

export interface IdentityObservation {
  readonly identityKey: string;
  readonly representativePath: string;
  readonly representativeAbsolutePath: string;
  readonly physicalPaths: readonly string[];
  readonly lexicalAliases: readonly string[];
  readonly frozen: boolean;
  readonly snapshot: SourceSnapshot | null;
}

export interface IdentityReference {
  readonly identityKey: string;
  readonly representativePath: string;
  readonly representativeAbsolutePath: string;
  readonly frozen: boolean;
  readonly snapshot: SourceSnapshot | null;
}

interface MutableIdentityObservation {
  readonly identityKey: string;
  representativePath: string;
  representativeAbsolutePath: string;
  readonly physicalPaths: Set<string>;
  readonly lexicalAliases: Set<string>;
  frozen: boolean;
  snapshot: SourceSnapshot | null;
  snapshotVersion: string | null;
}

function compareCodePoints(left: string, right: string): number {
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

function snapshot(record: MutableIdentityObservation): IdentityObservation {
  return {
    identityKey: record.identityKey,
    representativePath: record.representativePath,
    representativeAbsolutePath: record.representativeAbsolutePath,
    physicalPaths: [...record.physicalPaths].sort(compareCodePoints),
    lexicalAliases: [...record.lexicalAliases].sort(compareCodePoints),
    frozen: record.frozen,
    snapshot: record.snapshot,
  };
}

function reference(record: MutableIdentityObservation): IdentityReference {
  return {
    identityKey: record.identityKey,
    representativePath: record.representativePath,
    representativeAbsolutePath: record.representativeAbsolutePath,
    frozen: record.frozen,
    snapshot: record.snapshot,
  };
}

/** Groups stable device/inode identities; path fallback is supplied by resolveSafePath. */
export class IdentityRegistry {
  #records = new Map<string, MutableIdentityObservation>();
  #physicalPathToIdentity = new Map<string, string>();

  public observe(safePath: SafePath): IdentityReference {
    let record = this.#records.get(safePath.identityKey);
    if (record === undefined) {
      record = {
        identityKey: safePath.identityKey,
        representativePath: safePath.physicalRelativePath,
        representativeAbsolutePath: safePath.physicalPath,
        physicalPaths: new Set<string>(),
        lexicalAliases: new Set<string>(),
        frozen: false,
        snapshot: null,
        snapshotVersion: null,
      };
      this.#records.set(safePath.identityKey, record);
    }
    record.physicalPaths.add(safePath.physicalRelativePath);
    record.lexicalAliases.add(safePath.lexicalRelativePath);
    this.#physicalPathToIdentity.set(safePath.physicalRelativePath, safePath.identityKey);
    if (
      !record.frozen &&
      compareCodePoints(safePath.physicalRelativePath, record.representativePath) < 0
    ) {
      record.representativePath = safePath.physicalRelativePath;
      record.representativeAbsolutePath = safePath.physicalPath;
    }
    return reference(record);
  }

  public freeze(identityKey: string): IdentityReference | undefined {
    const record = this.#records.get(identityKey);
    if (record === undefined) return undefined;
    record.frozen = true;
    return reference(record);
  }

  public get(identityKey: string): IdentityObservation | undefined {
    const record = this.#records.get(identityKey);
    return record === undefined ? undefined : snapshot(record);
  }

  public identityForPhysicalPath(path: string): string | undefined {
    return this.#physicalPathToIdentity.get(path);
  }

  public setSnapshot(identityKey: string, source: SourceSnapshot, stats: BigIntStats): void {
    const record = this.#records.get(identityKey);
    if (record === undefined || record.snapshot !== null) return;
    record.snapshot = source;
    record.snapshotVersion = this.#versionOf(stats);
  }

  public matchesSnapshotVersion(identityKey: string, stats: BigIntStats): boolean {
    const record = this.#records.get(identityKey);
    return record?.snapshotVersion === this.#versionOf(stats);
  }

  public snapshotForIdentity(identityKey: string): SourceSnapshot | undefined {
    return this.#records.get(identityKey)?.snapshot ?? undefined;
  }

  #versionOf(stats: BigIntStats): string {
    // ctime changes when a hardlink is added or removed, without changing source bytes.
    // Snapshot reuse therefore checks content-relevant metadata; a fresh read still checks
    // ctime around its descriptor read to detect concurrent mutation.
    return [
      stats.dev.toString(),
      stats.ino.toString(),
      stats.mode.toString(),
      stats.size.toString(),
      stats.mtimeNs.toString(),
    ].join(':');
  }

  public identities(): readonly IdentityObservation[] {
    return [...this.#records.values()]
      .map(snapshot)
      .sort((left, right) => compareCodePoints(left.representativePath, right.representativePath));
  }
}
