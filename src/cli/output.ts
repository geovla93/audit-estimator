import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

/** Typed report-file failure. The message is fixed and never carries a path. */
export class OutputError extends Error {
  public constructor() {
    super('The report file could not be written.');
    this.name = 'OutputError';
  }
}

export interface WriteReportOptions {
  /** Replace an existing regular file (never a symlink, source, configuration or coverage file). */
  readonly force: boolean;
  /** Canonical paths of every file the analysis read. */
  readonly protectedPaths: readonly string[];
  /** Test seam for the final body write; defaults to `handle.writeFile`. */
  readonly writeBody?: ((handle: FileHandle, body: Buffer) => Promise<void>) | undefined;
}

interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
  );
}

async function protectedIdentities(paths: readonly string[]): Promise<Identity[]> {
  const identities: Identity[] = [];
  for (const path of paths) {
    try {
      const stats = await stat(path, { bigint: true });
      if (stats.isFile() && stats.ino > 0n) identities.push({ dev: stats.dev, ino: stats.ino });
    } catch {
      // A missing protected path has no identity to collide with.
    }
  }
  return identities;
}

async function protectedKeys(paths: readonly string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const path of paths) {
    keys.add(path);
    try {
      keys.add(join(await realpath(dirname(path)), basename(path)));
    } catch {
      // The lexical entry above remains the comparison key.
    }
  }
  return keys;
}

async function writeNew(
  path: string,
  body: Buffer,
  write: NonNullable<WriteReportOptions['writeBody']>,
): Promise<void> {
  let handle: FileHandle;
  try {
    // O_CREAT | O_EXCL: creation and existence check are one atomic step.
    handle = await open(path, 'wx', 0o644);
  } catch {
    throw new OutputError();
  }
  let created: Identity | undefined;
  try {
    const stats = await handle.stat({ bigint: true });
    created = { dev: stats.dev, ino: stats.ino };
    await write(handle, body);
    await handle.close();
  } catch {
    try {
      await handle.close();
    } catch {
      // Already failing; the cleanup below still runs.
    }
    // Unlink only the file this process created, proven by device and inode.
    if (created !== undefined) {
      try {
        const current = await lstat(path, { bigint: true });
        if (current.isFile() && sameIdentity(current, created)) await unlink(path);
      } catch {
        // Nothing safe left to remove.
      }
    }
    throw new OutputError();
  }
}

async function overwriteExisting(
  path: string,
  body: Buffer,
  existing: Identity,
  protectedIds: readonly Identity[],
  write: NonNullable<WriteReportOptions['writeBody']>,
): Promise<void> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle: FileHandle;
  try {
    // No O_TRUNC: the handle is verified before anything is truncated.
    handle = await open(path, fsConstants.O_WRONLY | noFollow);
  } catch {
    throw new OutputError();
  }
  try {
    const stats = await handle.stat({ bigint: true });
    const identity: Identity = { dev: stats.dev, ino: stats.ino };
    if (
      !stats.isFile() ||
      !sameIdentity(identity, existing) ||
      protectedIds.some((item) => sameIdentity(item, identity))
    ) {
      throw new OutputError();
    }
    await handle.truncate(0);
    await write(handle, body);
    await handle.close();
  } catch {
    try {
      await handle.close();
    } catch {
      // The pre-existing file is never unlinked.
    }
    throw new OutputError();
  }
}

/**
 * Writes an already rendered and validated report body to an operator-selected file. It never
 * creates directories, refuses sources, configuration, symlinks and non-regular files, and never
 * checks and writes in two separate steps. A concurrent attacker able to mutate the destination
 * directory between verification and write is outside the guarantee.
 */
export async function writeReport(
  path: string,
  body: string,
  options: WriteReportOptions,
): Promise<void> {
  if (!isAbsolute(path) || path.toLowerCase().endsWith('.sol')) throw new OutputError();
  const bytes = Buffer.from(body, 'utf8');
  const write = options.writeBody ?? (async (handle, data) => handle.writeFile(data));

  let target: string;
  try {
    const parent = await realpath(dirname(path));
    if (!(await stat(parent)).isDirectory()) throw new OutputError();
    target = join(parent, basename(path));
  } catch {
    throw new OutputError();
  }
  if ((await protectedKeys(options.protectedPaths)).has(target)) throw new OutputError();
  const protectedIds = await protectedIdentities(options.protectedPaths);

  let existing: Identity | undefined;
  try {
    const stats = await lstat(path, { bigint: true });
    if (!stats.isFile()) throw new OutputError();
    const found: Identity = { dev: stats.dev, ino: stats.ino };
    if (protectedIds.some((item) => sameIdentity(item, found))) throw new OutputError();
    existing = found;
  } catch (error: unknown) {
    if (error instanceof OutputError) throw error;
    if (!isErrno(error, 'ENOENT')) throw new OutputError();
  }

  if (existing === undefined || !options.force) {
    // Without --force an existing destination fails inside the exclusive create.
    await writeNew(path, bytes, write);
    return;
  }
  await overwriteExisting(path, bytes, existing, protectedIds, write);
}
