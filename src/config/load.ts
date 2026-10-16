import { constants as fsConstants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open, lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { CONFIG_SCHEMA_VERSION } from '../domain/versions.ts';
import type { ConfigInput } from '../domain/types.ts';
import {
  CONFIG_MAX_BYTES,
  ConfigError,
  DEFAULT_CONFIG_FILE,
  ProjectRootError,
} from './defaults.ts';
import {
  mergeConfig,
  type ConfigCliOverrides,
  type ConfigMergeResult,
  type ProjectMetadataHints,
  type TrustedConfigDefaults,
} from './merge.ts';
import { parseConfigInput } from './validate.ts';

export { ProjectRootError } from './defaults.ts';

export interface LoadConfigOptions {
  readonly root: string;
  readonly configPath?: string | undefined;
  readonly noConfig?: boolean | undefined;
}

export interface LoadedConfig {
  readonly input: ConfigInput | null;
  readonly directory: string;
}

export interface ResolveConfigOptions extends LoadConfigOptions {
  readonly defaults: TrustedConfigDefaults;
  readonly metadata?: ProjectMetadataHints | undefined;
  readonly cli?: ConfigCliOverrides | undefined;
}

export interface ResolvedConfigContext extends ConfigMergeResult {
  /** Canonical native path used internally by discovery and filesystem readers. */
  readonly root: string;
  readonly configFileLoaded: boolean;
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
  );
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function resolveNearestExistingPath(candidate: string): Promise<string> {
  let cursor = candidate;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const physical = await realpath(cursor);
      return resolve(physical, ...missingSegments.reverse());
    } catch (error: unknown) {
      if (!isMissingPath(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(basename(cursor));
      cursor = parent;
    }
  }
}

export async function toRootRelativePath(
  root: string,
  baseDirectory: string,
  value: string,
): Promise<string> {
  const segments = value.split('/');
  const lexicalPath = resolve(baseDirectory, ...segments);
  if (!isInside(root, lexicalPath)) {
    throw new ConfigError('A configured path is outside the project root.');
  }

  let physicalPath: string;
  try {
    physicalPath = await resolveNearestExistingPath(lexicalPath);
  } catch (error: unknown) {
    throw new ConfigError('A configured path could not be resolved safely.', error);
  }
  if (!isInside(root, physicalPath)) {
    throw new ConfigError('A configured path is outside the project root.');
  }

  const rootRelative = relative(root, physicalPath);
  return rootRelative === '' ? '.' : rootRelative.split(sep).join('/');
}

export async function normalizeConfigPaths(
  input: ConfigInput,
  root: string,
  baseDirectory: string,
): Promise<ConfigInput> {
  const scope = input.scope;
  const imports = input.imports;
  const coverage = input.coverage;
  const normalizedScope =
    scope === undefined
      ? undefined
      : {
          ...scope,
          ...(scope.sourceRoots === undefined
            ? {}
            : {
                sourceRoots: await Promise.all(
                  scope.sourceRoots.map((path) => toRootRelativePath(root, baseDirectory, path)),
                ),
              }),
          ...(scope.thirdPartyRoots === undefined
            ? {}
            : {
                thirdPartyRoots: await Promise.all(
                  scope.thirdPartyRoots.map((path) =>
                    toRootRelativePath(root, baseDirectory, path),
                  ),
                ),
              }),
          ...(scope.firstPartyOverrides === undefined
            ? {}
            : {
                firstPartyOverrides: await Promise.all(
                  scope.firstPartyOverrides.map((path) =>
                    toRootRelativePath(root, baseDirectory, path),
                  ),
                ),
              }),
        };
  const normalizedImports =
    imports === undefined
      ? undefined
      : {
          remappings: await Promise.all(
            imports.remappings.map(async (remapping) => ({
              ...remapping,
              ...(remapping.context === undefined
                ? {}
                : { context: await toRootRelativePath(root, baseDirectory, remapping.context) }),
              target: await toRootRelativePath(root, baseDirectory, remapping.target),
            })),
          ),
        };
  const normalizedCoverage =
    coverage === undefined
      ? undefined
      : { lcovPath: await toRootRelativePath(root, baseDirectory, coverage.lcovPath) };

  return {
    configVersion: input.configVersion,
    ...(normalizedScope === undefined ? {} : { scope: normalizedScope }),
    ...(normalizedImports === undefined ? {} : { imports: normalizedImports }),
    ...(input.solidity === undefined ? {} : { solidity: input.solidity }),
    ...(input.analysis === undefined ? {} : { analysis: input.analysis }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.manualAdjustments === undefined
      ? {}
      : { manualAdjustments: input.manualAdjustments }),
    ...(normalizedCoverage === undefined ? {} : { coverage: normalizedCoverage }),
    ...(input.report === undefined ? {} : { report: input.report }),
    // Deliberate exception: selector paths are project-root-relative, never config-directory
    // relative, so the same object behaves identically from any config location. They are only
    // resolved against the final accepted manifest and never added to discovery.
    ...(input.estimationScope === undefined ? {} : { estimationScope: input.estimationScope }),
  };
}

async function readConfigFile(filePath: string, allowSymlink: boolean): Promise<LoadedConfig> {
  let resolvedPath = filePath;
  let fileStat;
  try {
    fileStat = await lstat(filePath);
  } catch (error: unknown) {
    throw new ConfigError('Configuration file could not be opened.', error);
  }

  if (fileStat.isSymbolicLink() && !allowSymlink) {
    throw new ConfigError('Automatic configuration files cannot be symbolic links.');
  }
  if (allowSymlink) {
    try {
      resolvedPath = await realpath(filePath);
    } catch (error: unknown) {
      throw new ConfigError('Configuration file could not be resolved.', error);
    }
  }

  const openFlags =
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  let file: FileHandle | undefined;
  try {
    file = await open(resolvedPath, openFlags);
    const openedStat = await file.stat();
    if (!openedStat.isFile()) {
      throw new ConfigError('Configuration path is not a regular file.');
    }
    if (openedStat.size > CONFIG_MAX_BYTES) {
      throw new ConfigError('Configuration file exceeds the 256 KiB limit.');
    }

    const chunks: Buffer[] = [];
    let byteLength = 0;
    while (byteLength <= CONFIG_MAX_BYTES) {
      const buffer = Buffer.alloc(Math.min(16 * 1024, CONFIG_MAX_BYTES + 1 - byteLength));
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      byteLength += bytesRead;
      if (byteLength > CONFIG_MAX_BYTES) {
        throw new ConfigError('Configuration file exceeds the 256 KiB limit.');
      }
    }

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch (error: unknown) {
      throw new ConfigError('Configuration file is not valid UTF-8.', error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error: unknown) {
      throw new ConfigError('Configuration file is not valid JSON.', error);
    }

    const input = parseConfigInput(parsed);
    return { input, directory: dirname(resolvedPath) };
  } catch (error: unknown) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('Configuration file could not be read safely.', error);
  } finally {
    await file?.close();
  }
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  let root: string;
  try {
    root = await realpath(options.root);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      throw new ConfigError('The selected project root is not a directory.');
    }
  } catch (error: unknown) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('The selected project root could not be resolved.', error);
  }

  if (options.noConfig === true) {
    if (options.configPath !== undefined) {
      throw new ConfigError('Explicit configuration cannot be combined with --no-config.');
    }
    return { input: null, directory: root };
  }

  const isExplicit = options.configPath !== undefined;
  const filePath = isExplicit ? resolve(options.configPath) : resolve(root, DEFAULT_CONFIG_FILE);
  if (!isExplicit) {
    try {
      await lstat(filePath);
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return { input: null, directory: root };
      throw new ConfigError('Automatic configuration could not be inspected.', error);
    }
  }

  return readConfigFile(filePath, isExplicit);
}

export async function selectProjectRoot(
  inputPath: string,
  rootOverride?: string,
  cwd: string = process.cwd(),
): Promise<string> {
  const selectedPath = resolve(cwd, rootOverride ?? inputPath);
  try {
    if (rootOverride !== undefined) {
      const root = await realpath(selectedPath);
      const rootStat = await stat(root);
      if (!rootStat.isDirectory()) {
        throw new ProjectRootError('The selected project root is not a directory.');
      }

      const target = await realpath(resolve(cwd, inputPath));
      const targetStat = await stat(target);
      if (!targetStat.isDirectory() && !targetStat.isFile()) {
        throw new ProjectRootError('The selected input is not a regular file or directory.');
      }
      if (!isInside(root, target)) {
        throw new ProjectRootError('The selected input is outside the project root.');
      }
      return root;
    }

    const physicalPath = await realpath(selectedPath);
    const selectedStat = await stat(physicalPath);
    if (selectedStat.isDirectory()) return physicalPath;
    if (!selectedStat.isFile()) {
      throw new ProjectRootError('The selected input is not a regular file or directory.');
    }

    const root = dirname(physicalPath);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      throw new ProjectRootError('The selected file does not have a directory root.');
    }
    return root;
  } catch (error: unknown) {
    if (error instanceof ProjectRootError) throw error;
    throw new ProjectRootError('The selected input or project root could not be resolved.', error);
  }
}

function metadataConfigInput(metadata: ProjectMetadataHints | undefined): ConfigInput | undefined {
  if (metadata === undefined) return undefined;
  return parseConfigInput({ configVersion: CONFIG_SCHEMA_VERSION, ...metadata });
}

export async function resolveConfig(options: ResolveConfigOptions): Promise<ResolvedConfigContext> {
  const loaded = await loadConfig(options);
  let root: string;
  try {
    root = await realpath(options.root);
  } catch (error: unknown) {
    throw new ConfigError('The selected project root could not be resolved.', error);
  }

  const metadataInput = metadataConfigInput(options.metadata);
  const normalizedMetadata =
    metadataInput === undefined ? undefined : await normalizeConfigPaths(metadataInput, root, root);
  const metadata: ProjectMetadataHints | undefined =
    normalizedMetadata === undefined
      ? undefined
      : {
          ...(normalizedMetadata.scope === undefined ? {} : { scope: normalizedMetadata.scope }),
          ...(normalizedMetadata.imports === undefined
            ? {}
            : { imports: normalizedMetadata.imports }),
          ...(normalizedMetadata.solidity === undefined
            ? {}
            : { solidity: normalizedMetadata.solidity }),
        };
  const fileConfig =
    loaded.input === null
      ? undefined
      : await normalizeConfigPaths(loaded.input, root, loaded.directory);
  const merged = mergeConfig({
    defaults: options.defaults,
    ...(metadata === undefined ? {} : { metadata }),
    ...(fileConfig === undefined ? {} : { fileConfig }),
    ...(options.cli === undefined ? {} : { cli: options.cli }),
  });

  return { ...merged, root, configFileLoaded: loaded.input !== null };
}
