import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { BigIntStats } from 'node:fs';
import { BudgetError, type DiscoveryBudget } from './budget.ts';

export type SafePathErrorCode = 'PATH_BLOCKED' | 'TARGET_UNREADABLE';
export type SafePathFailureReason =
  | 'missing'
  | 'outside-root'
  | 'outside-target'
  | 'symlink'
  | 'hard-excluded'
  | 'special-file'
  | 'invalid-name'
  | 'unreadable'
  | 'changed';

export class SafePathError extends Error {
  public readonly code: SafePathErrorCode;
  public readonly reason: SafePathFailureReason;

  public constructor(code: SafePathErrorCode, reason: SafePathFailureReason) {
    super('The selected path could not be accessed safely.');
    this.name = 'SafePathError';
    this.code = code;
    this.reason = reason;
  }
}

export interface SafePathContext {
  /** Canonical project root, captured once by the caller. */
  readonly root: string;
  /** Operator-selected lexical root, captured before realpath. */
  readonly lexicalRoot: string;
  /** Optional canonical scope target boundary. */
  readonly target?: string | undefined;
  /** Optional lexical scope target boundary. */
  readonly lexicalTarget?: string | undefined;
  readonly followSymlinks: boolean;
  /** Shared analysis budget used before each path inspection syscall. */
  readonly budget?: DiscoveryBudget | undefined;
}

export interface SafePath {
  readonly lexicalPath: string;
  readonly physicalPath: string;
  readonly lexicalRelativePath: string;
  readonly physicalRelativePath: string;
  readonly identityKey: string;
  readonly stats: BigIntStats;
  readonly followedSymlink: boolean;
  readonly kind: 'directory' | 'file' | 'special';
}

function contained(base: string, candidate: string, allowBase: boolean): boolean {
  if (parse(base).root !== parse(candidate).root) return false;
  const pathFromBase = relative(base, candidate);
  if (pathFromBase === '') return allowBase;
  return !isAbsolute(pathFromBase) && pathFromBase !== '..' && !pathFromBase.startsWith(`..${sep}`);
}

function relativeProjectPath(root: string, absolutePath: string): string {
  const nativeRelative = relative(root, absolutePath);
  if (nativeRelative === '') return '.';
  const parts = nativeRelative.split(sep);
  if (
    parts.some((part) => part.length === 0 || part === '.' || part === '..' || part.includes('\\'))
  ) {
    throw new SafePathError('PATH_BLOCKED', 'invalid-name');
  }
  const projectPath = parts.join('/');
  if (!isProjectPathRepresentable(projectPath)) {
    throw new SafePathError('PATH_BLOCKED', 'invalid-name');
  }
  return projectPath;
}

function isProjectPathRepresentable(projectPath: string): boolean {
  return (
    projectPath.length <= 4096 &&
    !projectPath.startsWith('/') &&
    !/^[A-Za-z]:/u.test(projectPath) &&
    !projectPath.includes('\\') &&
    !projectPath.includes('\0') &&
    !projectPath.endsWith('/') &&
    !projectPath.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  );
}

function hasHardExcludedSegment(projectPath: string): boolean {
  return projectPath.split('/').includes('.git');
}

function identityKey(stats: BigIntStats, physicalRelativePath: string): string {
  if (stats.ino > 0n && stats.dev >= 0n)
    return `inode:${stats.dev.toString()}:${stats.ino.toString()}`;
  return `path:${physicalRelativePath}`;
}

function throwIfMissing(error: unknown): never {
  if (error instanceof BudgetError) throw error;
  if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    throw new SafePathError('TARGET_UNREADABLE', 'missing');
  }
  throw new SafePathError('TARGET_UNREADABLE', 'unreadable');
}

/**
 * Checks lexical and physical containment. Call it again immediately before and after opening:
 * Node does not expose an atomic open-beneath primitive for hostile concurrent mutation.
 */
export async function resolveSafePath(
  context: SafePathContext,
  candidatePath: string,
  options: { readonly rejectSymlinks?: boolean | undefined } = {},
): Promise<SafePath> {
  const lexicalPath = resolve(context.lexicalRoot, candidatePath);
  if (!contained(context.lexicalRoot, lexicalPath, true)) {
    throw new SafePathError('PATH_BLOCKED', 'outside-root');
  }
  if (context.lexicalTarget !== undefined && !contained(context.lexicalTarget, lexicalPath, true)) {
    throw new SafePathError('PATH_BLOCKED', 'outside-target');
  }
  const lexicalProjectRelative = relative(context.lexicalRoot, lexicalPath);
  const lexicalRelativePath =
    lexicalProjectRelative === '' ? '.' : lexicalProjectRelative.split(sep).join('/');
  if (lexicalRelativePath !== '.' && !isProjectPathRepresentable(lexicalRelativePath)) {
    throw new SafePathError('PATH_BLOCKED', 'invalid-name');
  }

  let followedSymlink = false;
  let current = context.lexicalRoot;
  let rootLink: BigIntStats;
  try {
    context.budget?.check();
    rootLink = await lstat(current, { bigint: true });
  } catch (error: unknown) {
    throwIfMissing(error);
  }
  if (rootLink.isSymbolicLink()) {
    followedSymlink = true;
    if (options.rejectSymlinks === true || !context.followSymlinks) {
      throw new SafePathError('PATH_BLOCKED', 'symlink');
    }
  }

  const lexicalRelative = relative(context.lexicalRoot, lexicalPath);
  const components = lexicalRelative === '' ? [] : lexicalRelative.split(sep);
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    if (
      component === undefined ||
      component.length === 0 ||
      component === '.' ||
      component === '..'
    ) {
      throw new SafePathError('PATH_BLOCKED', 'invalid-name');
    }
    current = join(current, component);
    let item: BigIntStats;
    try {
      context.budget?.check();
      item = await lstat(current, { bigint: true });
    } catch (error: unknown) {
      throwIfMissing(error);
    }
    if (item.isSymbolicLink()) {
      followedSymlink = true;
      if (options.rejectSymlinks === true || !context.followSymlinks) {
        throw new SafePathError('PATH_BLOCKED', 'symlink');
      }
    }
    if (index + 1 < components.length) {
      let directory = item;
      if (item.isSymbolicLink()) {
        try {
          context.budget?.check();
          directory = await stat(current, { bigint: true });
        } catch (error: unknown) {
          throwIfMissing(error);
        }
      }
      if (!directory.isDirectory()) throw new SafePathError('PATH_BLOCKED', 'special-file');
    }
  }

  let physicalPath: string;
  let stats: BigIntStats;
  try {
    context.budget?.check();
    physicalPath = await realpath(lexicalPath);
    context.budget?.check();
    stats = await stat(physicalPath, { bigint: true });
  } catch (error: unknown) {
    throwIfMissing(error);
  }
  if (!contained(context.root, physicalPath, true)) {
    throw new SafePathError('PATH_BLOCKED', 'outside-root');
  }
  if (context.target !== undefined && !contained(context.target, physicalPath, true)) {
    throw new SafePathError('PATH_BLOCKED', 'outside-target');
  }

  const physicalRelativePath = relativeProjectPath(context.root, physicalPath);
  if (hasHardExcludedSegment(lexicalRelativePath) || hasHardExcludedSegment(physicalRelativePath)) {
    throw new SafePathError('PATH_BLOCKED', 'hard-excluded');
  }

  const kind = stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'special';
  return {
    lexicalPath,
    physicalPath,
    lexicalRelativePath,
    physicalRelativePath,
    identityKey: identityKey(stats, physicalRelativePath),
    stats,
    followedSymlink,
    kind,
  };
}

export function isPathInside(base: string, candidate: string): boolean {
  return contained(resolve(base), resolve(candidate), true);
}
