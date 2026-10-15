import { basename, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parseConfigInput } from '../config/validate.ts';
import { CONFIG_SCHEMA_VERSION } from '../domain/versions.ts';
import type { ConfigInput, Diagnostic, Remapping } from '../domain/types.ts';
import { BudgetError } from './budget.ts';
import type { MetadataReadContext } from './safe-read.ts';
import { readMetadataFile, SafeReadError } from './safe-read.ts';
import { isPathInside, resolveSafePath, SafePathError, type SafePathContext } from './safe-path.ts';
import { diagnostic, type ProjectMetadataPaths, type ProjectMetadataResult } from './scope.ts';

const MAX_METADATA_STRING_LENGTH = 4096;
const MAX_RECOGNIZED_ARRAY_LENGTH = 1000;
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const HARDHAT_MARKERS = [
  'hardhat.config.ts',
  'hardhat.config.js',
  'hardhat.config.cjs',
  'hardhat.config.mjs',
] as const;

interface NormalizedProjectPath {
  readonly path: string;
  readonly isRoot: boolean;
  readonly kind: 'directory' | 'file' | 'missing';
}

function emptyPaths(): ProjectMetadataPaths {
  return { libs: [], test: null, script: null, out: null };
}

function emptyResult(
  observation: ProjectMetadataResult['observation'],
  diagnostics: readonly Diagnostic[] = [],
  valid = false,
): ProjectMetadataResult {
  return { hints: {}, paths: emptyPaths(), observation, valid, diagnostics };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnsafeKeys(value: unknown): boolean {
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === null || typeof item !== 'object') continue;
    visited += 1;
    if (visited > 100_000) return true;
    for (const key of Object.keys(item)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return true;
      pending.push((item as Record<string, unknown>)[key]);
    }
  }
  return false;
}

function safeString(value: unknown, maximumLength = MAX_METADATA_STRING_LENGTH): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) return null;
  if (
    Array.from(value).some((scalar) => {
      const codePoint = scalar.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  )
    return null;
  return value;
}

function normalizeMetadataPath(value: unknown): string {
  const text = safeString(value);
  if (
    text === null ||
    text.includes('\\') ||
    text.startsWith('/') ||
    /^[A-Za-z]:/u.test(text) ||
    text.includes('//')
  ) {
    throw new SafePathError('PATH_BLOCKED', 'invalid-name');
  }
  const segments = text.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new SafePathError('PATH_BLOCKED', 'outside-root');
  }
  return segments.length === 0 ? '.' : segments.join('/');
}

async function resolveMetadataLocation(
  pathContext: SafePathContext,
  budget: MetadataReadContext['budget'],
  value: unknown,
  allowFile: boolean,
): Promise<NormalizedProjectPath> {
  const normalized = normalizeMetadataPath(value);
  const lexicalPath =
    normalized === '.'
      ? pathContext.lexicalRoot
      : resolve(pathContext.lexicalRoot, ...normalized.split('/'));
  const canonicalCandidate =
    normalized === '.' ? pathContext.root : resolve(pathContext.root, ...normalized.split('/'));
  if (
    !isPathInside(pathContext.lexicalRoot, lexicalPath) ||
    !isPathInside(pathContext.root, canonicalCandidate)
  ) {
    throw new SafePathError('PATH_BLOCKED', 'outside-root');
  }

  let cursor = lexicalPath;
  const missingSegments: string[] = [];
  while (isPathInside(pathContext.lexicalRoot, cursor)) {
    budget.check();
    try {
      const safePath = await resolveSafePath({ ...pathContext, budget }, cursor);
      if (safePath.kind === 'special' || (safePath.kind === 'file' && !allowFile)) {
        throw new SafePathError('PATH_BLOCKED', 'special-file');
      }
      if (missingSegments.length > 0 && safePath.kind !== 'directory') {
        throw new SafePathError('PATH_BLOCKED', 'special-file');
      }
      const suffix = [...missingSegments].reverse();
      const path =
        [
          ...(safePath.physicalRelativePath === '.' ? [] : [safePath.physicalRelativePath]),
          ...suffix,
        ].join('/') || '.';
      return {
        path,
        isRoot: path === '.',
        kind: missingSegments.length > 0 ? 'missing' : safePath.kind,
      };
    } catch (error: unknown) {
      if (error instanceof BudgetError) throw error;
      if (!(error instanceof SafePathError && error.reason === 'missing')) throw error;
      const component = basename(cursor);
      if (component.length > 0) missingSegments.push(component);
      const parent = resolve(cursor, '..');
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  throw new SafePathError('PATH_BLOCKED', 'outside-root');
}

async function resolveMetadataDirectory(
  pathContext: SafePathContext,
  budget: MetadataReadContext['budget'],
  value: unknown,
): Promise<NormalizedProjectPath> {
  const location = await resolveMetadataLocation(pathContext, budget, value, false);
  if (location.kind === 'file') throw new SafePathError('PATH_BLOCKED', 'special-file');
  return location;
}

async function resolveMetadataPath(
  pathContext: SafePathContext,
  budget: MetadataReadContext['budget'],
  value: unknown,
): Promise<NormalizedProjectPath> {
  return resolveMetadataLocation(pathContext, budget, value, true);
}

function extractDefaultProfile(parsed: unknown): Record<string, unknown> {
  if (!isRecord(parsed)) throw new TypeError('invalid-toml-root');
  const profiles = parsed.profile;
  if (profiles === undefined) return {};
  if (!isRecord(profiles)) throw new TypeError('invalid-profile-table');
  const defaultProfile = profiles.default;
  if (defaultProfile === undefined) return {};
  if (!isRecord(defaultProfile)) throw new TypeError('invalid-default-profile');
  return defaultProfile;
}

function parseRemapping(value: unknown): readonly Remapping[] {
  if (!Array.isArray(value) || value.length > MAX_RECOGNIZED_ARRAY_LENGTH) {
    throw new TypeError('invalid-remappings');
  }
  const remappings: Remapping[] = [];
  for (const item of value) {
    const entry = safeString(item);
    if (entry === null) throw new TypeError('invalid-remapping');
    const equals = entry.indexOf('=');
    if (equals <= 0 || equals === entry.length - 1) throw new TypeError('invalid-remapping');
    const left = entry.slice(0, equals);
    const targetRaw = entry.slice(equals + 1);
    const colon = left.indexOf(':');
    const contextRaw = colon < 0 ? undefined : left.slice(0, colon);
    const prefix = colon < 0 ? left : left.slice(colon + 1);
    if (safeString(prefix, 128) === null) throw new TypeError('invalid-remapping-prefix');
    const target = normalizeMetadataPath(targetRaw);
    const context = contextRaw === undefined ? undefined : normalizeMetadataPath(contextRaw);
    remappings.push({ prefix, target, ...(context === undefined ? {} : { context }) });
  }
  return remappings;
}

function failureDiagnostic(code: Diagnostic['code'], message: string, reason: string): Diagnostic {
  return diagnostic(code, 'warning', message, [
    { key: 'path', value: 'foundry.toml' },
    { key: 'reason', value: reason },
  ]);
}

function metadataNotice(message: string, path?: string): Diagnostic {
  return diagnostic(
    'PARTIAL_ANALYSIS',
    'info',
    message,
    path === undefined ? [] : [{ key: 'path', value: path }],
  );
}

async function detectHardhatMarkers(
  pathContext: SafePathContext,
  budget: MetadataReadContext['budget'],
): Promise<readonly string[]> {
  const markers: string[] = [];
  for (const marker of HARDHAT_MARKERS) {
    budget.check();
    try {
      const safePath = await resolveSafePath(
        { ...pathContext, budget },
        join(pathContext.lexicalRoot, marker),
      );
      if (safePath.kind === 'file') markers.push(marker);
    } catch (error: unknown) {
      if (error instanceof BudgetError) throw error;
      if (error instanceof SafePathError && error.reason === 'missing') continue;
      if (error instanceof SafePathError && error.reason === 'symlink') markers.push(marker);
    }
  }
  return markers;
}

/** Reads only root-local Foundry TOML and inspects fixed Hardhat marker paths. */
export async function readProjectMetadata(
  context: MetadataReadContext,
): Promise<ProjectMetadataResult> {
  const pathContext: SafePathContext = {
    root: context.pathContext.root,
    lexicalRoot: context.pathContext.lexicalRoot,
    followSymlinks: false,
    budget: context.budget,
  };
  const foundryPath = join(pathContext.lexicalRoot, 'foundry.toml');
  let foundryBytes: Uint8Array;
  try {
    foundryBytes = await readMetadataFile({ ...context, pathContext }, foundryPath);
  } catch (error: unknown) {
    if (error instanceof BudgetError && error.kind !== 'limit') throw error;
    if (error instanceof BudgetError) {
      const oversized = error.budget === 'metadataBytes';
      const base = emptyResult(
        {
          path: 'foundry.toml',
          status: oversized ? 'oversized' : 'unreadable',
          reason: 'metadata-limit',
        },
        [
          failureDiagnostic(
            'LIMIT_EXCEEDED',
            'Foundry metadata exceeded its configured read limit.',
            'metadata-limit',
          ),
        ],
      );
      return withHardhatNotice(base, pathContext, context.budget);
    }
    if (error instanceof SafePathError && error.reason === 'missing') {
      return withHardhatNotice(
        emptyResult({ path: 'foundry.toml', status: 'absent', reason: null }, [], true),
        pathContext,
        context.budget,
      );
    }
    if (
      error instanceof SafePathError &&
      (error.reason === 'symlink' ||
        error.reason === 'outside-root' ||
        error.reason === 'hard-excluded')
    ) {
      const base = emptyResult({ path: 'foundry.toml', status: 'blocked', reason: error.reason }, [
        failureDiagnostic(
          'PATH_BLOCKED',
          'Foundry metadata was blocked by path safety checks.',
          error.reason,
        ),
      ]);
      return withHardhatNotice(base, pathContext, context.budget);
    }
    const safeRead = error instanceof SafeReadError ? error : undefined;
    const reason =
      safeRead?.reason ?? (error instanceof SafePathError ? error.reason : 'unreadable');
    const code =
      safeRead?.code ?? (error instanceof SafePathError ? error.code : 'TARGET_UNREADABLE');
    const base = emptyResult({ path: 'foundry.toml', status: 'unreadable', reason }, [
      failureDiagnostic(code, 'Foundry metadata could not be read safely.', reason),
    ]);
    return withHardhatNotice(base, pathContext, context.budget);
  }

  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(foundryBytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    context.budget.check();
    parsed = parseToml(text, { maxDepth: 32, unsafeKeyBehaviour: 'throw' });
    if (hasUnsafeKeys(parsed)) throw new TypeError('unsafe-key');
  } catch (error: unknown) {
    if (error instanceof BudgetError) throw error;
    const base = emptyResult(
      { path: 'foundry.toml', status: 'invalid', reason: 'invalid-metadata' },
      [
        failureDiagnostic(
          'TARGET_UNREADABLE',
          'Foundry metadata was invalid and its hints were ignored.',
          'invalid-metadata',
        ),
      ],
    );
    return withHardhatNotice(base, pathContext, context.budget);
  }

  context.budget.check();
  let profile: Record<string, unknown>;
  try {
    profile = extractDefaultProfile(parsed);
  } catch {
    const base = emptyResult(
      { path: 'foundry.toml', status: 'invalid', reason: 'invalid-profile' },
      [
        failureDiagnostic(
          'TARGET_UNREADABLE',
          'Foundry metadata was invalid and its hints were ignored.',
          'invalid-profile',
        ),
      ],
    );
    return withHardhatNotice(base, pathContext, context.budget);
  }

  try {
    const normalizeField = async (key: string): Promise<NormalizedProjectPath | undefined> => {
      if (profile[key] === undefined) return undefined;
      return resolveMetadataDirectory(pathContext, context.budget, profile[key]);
    };
    const src = await normalizeField('src');
    const test = await normalizeField('test');
    const script = await normalizeField('script');
    const out = await normalizeField('out');

    let libs: string[] = [];
    if (profile.libs !== undefined) {
      if (!Array.isArray(profile.libs) || profile.libs.length > MAX_RECOGNIZED_ARRAY_LENGTH) {
        throw new TypeError('invalid-libs');
      }
      libs = [];
      for (const item of profile.libs) {
        const path = await resolveMetadataDirectory(pathContext, context.budget, item);
        libs.push(path.path);
      }
    }

    let remappings: readonly Remapping[] | undefined;
    if (profile.remappings !== undefined) {
      const parsedRemappings = parseRemapping(profile.remappings);
      const normalizedRemappings: Remapping[] = [];
      for (const mapping of parsedRemappings) {
        const target = await resolveMetadataPath(pathContext, context.budget, mapping.target);
        const contextPath =
          mapping.context === undefined
            ? undefined
            : await resolveMetadataPath(pathContext, context.budget, mapping.context);
        normalizedRemappings.push({
          prefix: mapping.prefix,
          target: target.path,
          ...(contextPath === undefined ? {} : { context: contextPath.path }),
        });
      }
      remappings = normalizedRemappings;
    }

    const rawSolc = profile.solc;
    const rawSolcVersion = profile.solc_version;
    const solc = rawSolc === undefined ? undefined : safeString(rawSolc, 128);
    const solcVersion = rawSolcVersion === undefined ? undefined : safeString(rawSolcVersion, 128);
    for (const compilerValue of [rawSolc, rawSolcVersion]) {
      if (compilerValue !== undefined && safeString(compilerValue, 128) === null) {
        throw new TypeError('invalid-compiler-version');
      }
    }
    const solcValue = solc ?? undefined;
    const solcVersionValue = solcVersion ?? undefined;
    const conflictingCompilerKeys =
      solcValue !== undefined && solcVersionValue !== undefined && solcValue !== solcVersionValue;
    const compilerValue = conflictingCompilerKeys ? undefined : (solcValue ?? solcVersionValue);
    const exactSolidityVersion =
      compilerValue !== undefined && EXACT_VERSION.test(compilerValue) ? compilerValue : undefined;

    const rootWideExclusions = [test, script, out].some((path) => path?.isRoot === true);
    const paths: ProjectMetadataPaths = {
      libs,
      test: test?.isRoot === true ? null : (test?.path ?? null),
      script: script?.isRoot === true ? null : (script?.path ?? null),
      out: out?.isRoot === true ? null : (out?.path ?? null),
    };
    const scope = src === undefined ? undefined : { sourceRoots: [src.path] };
    const input: ConfigInput = {
      configVersion: CONFIG_SCHEMA_VERSION,
      ...(scope === undefined ? {} : { scope }),
      ...(remappings === undefined ? {} : { imports: { remappings } }),
      ...(exactSolidityVersion === undefined
        ? {}
        : { solidity: { version: exactSolidityVersion } }),
    };
    const validated = parseConfigInput(input);
    const hints = {
      ...(validated.scope === undefined ? {} : { scope: validated.scope }),
      ...(validated.imports === undefined ? {} : { imports: validated.imports }),
      ...(validated.solidity === undefined ? {} : { solidity: validated.solidity }),
    };
    const diagnostics: Diagnostic[] = [
      metadataNotice(
        'Only the default Foundry profile is interpreted; environment and global overrides are not read.',
      ),
    ];
    const rootDiagnostics = rootWideExclusions
      ? [
          failureDiagnostic(
            'PATH_BLOCKED',
            'Root-wide Foundry exclusion paths were ignored.',
            'root-wide-exclusion',
          ),
        ]
      : [];
    diagnostics.push(...rootDiagnostics);
    if (conflictingCompilerKeys) {
      diagnostics.push(metadataNotice('Conflicting Foundry compiler keys were ignored.'));
    } else if (compilerValue !== undefined && exactSolidityVersion === undefined) {
      diagnostics.push(
        metadataNotice('A nonexact Foundry compiler version was not used as a version hint.'),
      );
    }
    if (
      isRecord(parsed) &&
      isRecord(parsed.profile) &&
      Object.keys(parsed.profile).some((key) => key !== 'default')
    ) {
      diagnostics.push(
        metadataNotice('Nondefault Foundry profiles and profile inheritance are not interpreted.'),
      );
    }
    if (isRecord(parsed) && (parsed.extends !== undefined || parsed.inherits !== undefined)) {
      diagnostics.push(metadataNotice('Foundry configuration inheritance is not interpreted.'));
    }
    const base: ProjectMetadataResult = {
      hints,
      paths,
      observation: { path: 'foundry.toml', status: 'read', reason: null },
      valid: true,
      diagnostics,
    };
    return withHardhatNotice(base, pathContext, context.budget);
  } catch (error: unknown) {
    if (error instanceof BudgetError) throw error;
    const reason = error instanceof SafePathError ? error.reason : 'invalid-metadata';
    const code: Diagnostic['code'] =
      error instanceof SafePathError ? error.code : 'TARGET_UNREADABLE';
    const status = error instanceof SafePathError ? 'blocked' : 'invalid';
    const base = emptyResult({ path: 'foundry.toml', status, reason }, [
      failureDiagnostic(code, 'Foundry metadata was invalid and its hints were ignored.', reason),
    ]);
    return withHardhatNotice(base, pathContext, context.budget);
  }
}

async function withHardhatNotice(
  result: ProjectMetadataResult,
  pathContext: SafePathContext,
  budget: MetadataReadContext['budget'],
): Promise<ProjectMetadataResult> {
  const markers = await detectHardhatMarkers(pathContext, budget);
  if (markers.length === 0) return result;
  return {
    ...result,
    diagnostics: [
      ...result.diagnostics,
      metadataNotice(
        'Hardhat configuration was detected by path only; custom paths are not interpreted.',
        markers[0],
      ),
    ],
  };
}
