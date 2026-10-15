import { createHash } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceSnapshot } from '../domain/types.ts';
import { BudgetError, type DiscoveryBudget } from './budget.ts';
import type { IdentityRegistry } from './identity.ts';
import {
  resolveSafePath,
  SafePathError,
  type SafePath,
  type SafePathContext,
} from './safe-path.ts';

const CHUNK_BYTES = 16 * 1024;
const BOOTSTRAP_METADATA_BYTES = 256 * 1024;

export interface SafeReadHandle {
  stat(options: { readonly bigint: true }): Promise<BigIntStats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ readonly bytesRead: number; readonly buffer: Buffer }>;
  close(): Promise<void>;
}

export interface SafeReadAdapter {
  readonly open: (path: string, flags: number) => Promise<SafeReadHandle>;
  readonly resolve: (
    context: SafePathContext,
    path: string,
    options?: { readonly rejectSymlinks?: boolean | undefined },
  ) => Promise<SafePath>;
}

export interface SourceReadContext {
  readonly pathContext: SafePathContext;
  readonly budget: DiscoveryBudget;
  readonly identities: IdentityRegistry;
  readonly adapter?: SafeReadAdapter | undefined;
}

export interface MetadataReadContext {
  readonly pathContext: SafePathContext;
  readonly budget: DiscoveryBudget;
  readonly adapter?: SafeReadAdapter | undefined;
  /** A resolved ceiling may tighten, but never raise, the bootstrap cap. */
  readonly maximumBytes?: number | undefined;
}

export class SafeReadError extends Error {
  public readonly code: 'TARGET_UNREADABLE' | 'SOURCE_CHANGED';
  public readonly reason: 'read-failed' | 'invalid-utf8' | 'changed' | 'closed';

  public constructor(
    code: 'TARGET_UNREADABLE' | 'SOURCE_CHANGED',
    reason: 'read-failed' | 'invalid-utf8' | 'changed' | 'closed',
  ) {
    super('A selected file could not be read safely.');
    this.name = 'SafeReadError';
    this.code = code;
    this.reason = reason;
  }
}

const defaultAdapter: SafeReadAdapter = {
  open: async (path, flags) => open(path, flags),
  resolve: resolveSafePath,
};

function openFlags(): number {
  return fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
}

function sameFileVersion(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function identityKey(stats: BigIntStats, path: SafePath): string {
  if (stats.ino > 0n && stats.dev >= 0n)
    return `inode:${stats.dev.toString()}:${stats.ino.toString()}`;
  return `path:${path.physicalRelativePath}`;
}

function projectPathUnderLexicalRoot(lexicalRoot: string, projectPath: string): string {
  return projectPath === '.' ? lexicalRoot : join(lexicalRoot, ...projectPath.split('/'));
}

function asSafeReadError(error: unknown): Error {
  if (
    error instanceof BudgetError ||
    error instanceof SafePathError ||
    error instanceof SafeReadError
  ) {
    return error;
  }
  return new SafeReadError('TARGET_UNREADABLE', 'read-failed');
}

function byteLimitError(): BudgetError {
  return new BudgetError('limit', 'sourceBytes');
}

function metadataLimitError(): BudgetError {
  return new BudgetError('limit', 'metadataBytes');
}

function ensureRegularFile(path: SafePath): void {
  if (path.kind !== 'file') throw new SafePathError('PATH_BLOCKED', 'special-file');
}

async function readBoundedBytes(options: {
  readonly pathContext: SafePathContext;
  readonly path: string;
  readonly budget: DiscoveryBudget;
  readonly adapter: SafeReadAdapter;
  readonly byteLimit: number;
  readonly metadata: boolean;
}): Promise<{ readonly bytes: Buffer; readonly openedPath: SafePath }> {
  const { path, budget, adapter, byteLimit, metadata } = options;
  const pathContext: SafePathContext = { ...options.pathContext, budget };
  budget.check();
  const openedPath = await adapter.resolve(
    pathContext,
    path,
    metadata ? { rejectSymlinks: true } : {},
  );
  ensureRegularFile(openedPath);

  const remainingBudget = metadata ? budget.metadataByteAllowance() : budget.sourceByteAllowance(0);
  const readCeiling = Math.min(byteLimit, remainingBudget);
  if (openedPath.stats.size > BigInt(readCeiling)) {
    throw metadata ? metadataLimitError() : byteLimitError();
  }

  let handle: SafeReadHandle | undefined;
  let readBytes = 0;
  const chunks: Buffer[] = [];
  let failed = false;
  try {
    budget.check();
    handle = await adapter.open(openedPath.physicalPath, openFlags());
    const descriptorStat = await handle.stat({ bigint: true });
    if (
      !descriptorStat.isFile() ||
      identityKey(descriptorStat, openedPath) !== openedPath.identityKey
    ) {
      throw new SafeReadError('SOURCE_CHANGED', 'changed');
    }
    if (!sameFileVersion(openedPath.stats, descriptorStat)) {
      throw new SafeReadError('SOURCE_CHANGED', 'changed');
    }
    const afterOpenPath = await adapter.resolve(
      pathContext,
      path,
      metadata ? { rejectSymlinks: true } : {},
    );
    if (
      afterOpenPath.identityKey !== openedPath.identityKey ||
      !sameFileVersion(openedPath.stats, afterOpenPath.stats)
    ) {
      throw new SafeReadError('SOURCE_CHANGED', 'changed');
    }

    for (;;) {
      await budget.checkpoint();
      const available = metadata
        ? Math.min(byteLimit - readBytes, budget.metadataByteAllowance())
        : budget.sourceByteAllowance(readBytes);
      const bufferSize = Math.max(1, Math.min(CHUNK_BYTES, available + 1));
      const buffer = Buffer.alloc(bufferSize);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      readBytes += bytesRead;
      if (metadata) budget.chargeMetadataBytes(bytesRead);
      else budget.chargeSourceBytes(bytesRead);
      if (bytesRead > available) {
        throw metadata ? metadataLimitError() : byteLimitError();
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }

    if (BigInt(readBytes) !== openedPath.stats.size) {
      throw new SafeReadError('SOURCE_CHANGED', 'changed');
    }
    const afterReadStat = await handle.stat({ bigint: true });
    const afterPath = await adapter.resolve(
      pathContext,
      path,
      metadata ? { rejectSymlinks: true } : {},
    );
    if (
      !sameFileVersion(openedPath.stats, afterReadStat) ||
      afterPath.identityKey !== openedPath.identityKey ||
      !sameFileVersion(openedPath.stats, afterPath.stats)
    ) {
      throw new SafeReadError('SOURCE_CHANGED', 'changed');
    }
    const bytes = Buffer.concat(chunks, readBytes);
    const closingHandle = handle;
    handle = undefined;
    await closingHandle.close();
    return { bytes, openedPath };
  } catch (error: unknown) {
    failed = true;
    throw asSafeReadError(error);
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        if (!failed) failed = true;
      }
    }
  }
}

/** Safely reads a selected source and caches the snapshot by physical identity. */
export async function readSource(
  context: SourceReadContext,
  candidatePath: string,
): Promise<SourceSnapshot> {
  const adapter = context.adapter ?? defaultAdapter;
  const pathContext: SafePathContext = { ...context.pathContext, budget: context.budget };
  let identityKeyValue: string | undefined;
  let reserved = false;
  try {
    context.budget.check();
    const observed = await adapter.resolve(pathContext, candidatePath);
    ensureRegularFile(observed);
    identityKeyValue = observed.identityKey;
    context.identities.observe(observed);
    // A first read publishes a stable canonical path. Later observations may add aliases,
    // but cannot rename an identity after its snapshot is cached.
    context.identities.freeze(observed.identityKey);
    const existing = context.identities.snapshotForIdentity(observed.identityKey);
    if (existing !== undefined) {
      const current = await adapter.resolve(pathContext, candidatePath);
      if (
        current.identityKey !== observed.identityKey ||
        !context.identities.matchesSnapshotVersion(observed.identityKey, current.stats)
      ) {
        throw new SafeReadError('SOURCE_CHANGED', 'changed');
      }
      return existing;
    }

    const isNew = context.budget.reserveSourceIdentity(observed.identityKey);
    if (!isNew) {
      const cached = context.identities.snapshotForIdentity(observed.identityKey);
      if (cached !== undefined) return cached;
      throw new SafeReadError('SOURCE_CHANGED', 'changed');
    }
    reserved = true;

    const { bytes, openedPath } = await readBoundedBytes({
      pathContext,
      // Open through the caller's checked alias. The frozen representative can be outside a
      // lexical target reached through an in-root directory symlink, while this alias remains
      // inside that target and resolves to the same observed physical identity.
      path: candidatePath,
      budget: context.budget,
      adapter,
      byteLimit: context.budget.limits.maxFileBytes,
      metadata: false,
    });
    const finalAlias = await adapter.resolve(pathContext, candidatePath);
    if (finalAlias.identityKey !== openedPath.identityKey) {
      throw new SafeReadError('SOURCE_CHANGED', 'changed');
    }

    let originalText: string;
    try {
      originalText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new SafeReadError('TARGET_UNREADABLE', 'invalid-utf8');
    }
    const finalRecord = context.identities.get(openedPath.identityKey);
    if (finalRecord === undefined) throw new SafeReadError('SOURCE_CHANGED', 'changed');
    const canonicalPath = finalRecord.representativePath;
    const absolutePath = projectPathUnderLexicalRoot(pathContext.root, canonicalPath);
    const source: SourceSnapshot = {
      canonicalPath,
      absolutePath,
      originalBytes: Uint8Array.from(bytes),
      originalText,
      byteHash: createHash('sha256').update(bytes).digest('hex'),
    };
    context.identities.setSnapshot(openedPath.identityKey, source, openedPath.stats);
    context.budget.commitSourceIdentity(openedPath.identityKey);
    reserved = false;
    return source;
  } catch (error: unknown) {
    context.budget.recordSourceReadFailure();
    if (reserved && identityKeyValue !== undefined) {
      context.budget.releaseSourceIdentity(identityKeyValue);
    }
    throw asSafeReadError(error);
  }
}

/** Reads bounded root-local metadata through the same descriptor and confinement checks. */
export async function readMetadataFile(
  context: MetadataReadContext,
  candidatePath: string,
): Promise<Uint8Array> {
  const pathContext: SafePathContext = { ...context.pathContext, budget: context.budget };
  const maximumBytes = Math.min(
    BOOTSTRAP_METADATA_BYTES,
    context.maximumBytes ?? context.budget.limits.maxMetadataBytes,
    context.budget.limits.maxMetadataBytes,
  );
  try {
    const { bytes } = await readBoundedBytes({
      pathContext,
      path: candidatePath,
      budget: context.budget,
      adapter: context.adapter ?? defaultAdapter,
      byteLimit: maximumBytes,
      metadata: true,
    });
    return Uint8Array.from(bytes);
  } catch (error: unknown) {
    throw asSafeReadError(error);
  }
}
