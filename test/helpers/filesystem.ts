import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AnalysisLimits } from '../../src/domain/types.ts';
import { DEFAULT_ANALYSIS_LIMITS } from '../../src/config/defaults.ts';
import type { SafePathContext } from '../../src/discovery/safe-path.ts';

export async function createProject(prefix = 'audit-estimator-discovery-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeProject(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export function absoluteProjectPath(root: string, projectPath: string): string {
  return projectPath === '.' ? root : join(root, ...projectPath.split('/'));
}

export async function writeProjectFile(
  root: string,
  projectPath: string,
  contents: string | Uint8Array,
): Promise<string> {
  const path = absoluteProjectPath(root, projectPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
}

export async function safePathContext(
  root: string,
  options: {
    readonly target?: string | undefined;
    readonly followSymlinks?: boolean | undefined;
  } = {},
): Promise<SafePathContext> {
  const physicalRoot = await realpath(root);
  const target = options.target === undefined ? undefined : await realpath(options.target);
  return {
    root: physicalRoot,
    lexicalRoot: root,
    ...(target === undefined ? {} : { target }),
    ...(options.target === undefined ? {} : { lexicalTarget: options.target }),
    followSymlinks: options.followSymlinks ?? false,
  };
}

export function testLimits(overrides: Partial<AnalysisLimits> = {}): AnalysisLimits {
  return { ...DEFAULT_ANALYSIS_LIMITS, ...overrides };
}
