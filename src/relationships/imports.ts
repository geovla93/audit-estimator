import type { Remapping, ResolvedConfig } from '../domain/types.ts';
import { selectRemapping } from './remappings.ts';
import type { RemappingCandidate, RemappingSourceKind } from './remappings.ts';

export const MAX_SOURCE_UNIT_NAME_CODE_UNITS: number = 4_096;

export type SpecifierFailure = 'invalid-specifier' | 'outside-root';

export type SourceUnitName =
  | { readonly ok: true; readonly kind: 'relative' | 'direct'; readonly name: string }
  | { readonly ok: false; readonly reason: SpecifierFailure };

export type LookupStrategy = 'relative' | 'direct' | 'remapped';

/** One bounded probe path with the strategy that produced it. */
export interface LookupCandidate {
  readonly path: string;
  readonly origin: 'root' | 'node-modules' | 'lib' | 'remapped' | 'relative';
}

export type LookupPlan =
  | {
      readonly ok: true;
      readonly strategy: LookupStrategy;
      /** The normalized source-unit name before any remapping. */
      readonly name: string;
      readonly candidates: readonly LookupCandidate[];
      readonly remapping: RemappingCandidate | null;
    }
  | { readonly ok: false; readonly reason: SpecifierFailure }
  | {
      readonly ok: false;
      readonly reason: 'remapping-conflict';
      readonly name: string;
      readonly conflicts: readonly RemappingCandidate[];
    };

function hasControlOrBackslash(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

function directoryOf(importerPath: string): readonly string[] {
  const parts = importerPath.split('/');
  parts.pop();
  return parts;
}

/**
 * Converts a decoded import specifier into this analyzer's source-unit name. Relative segments
 * are resolved against the importer's canonical root-relative path before any remapping; a
 * traversal above the root is rejected before normalization can erase it. The specifier is
 * already decoded by the syntax layer and is never decoded again.
 */
export function normalizeSourceUnitName(importerPath: string, specifier: string): SourceUnitName {
  if (specifier.length === 0 || specifier.length > MAX_SOURCE_UNIT_NAME_CODE_UNITS) {
    return { ok: false, reason: 'invalid-specifier' };
  }
  if (hasControlOrBackslash(specifier)) return { ok: false, reason: 'invalid-specifier' };
  if (specifier.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier)) {
    return { ok: false, reason: 'invalid-specifier' };
  }
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  const stack: string[] = relative ? [...directoryOf(importerPath)] : [];
  for (const segment of specifier.split('/')) {
    if (segment === '') return { ok: false, reason: 'invalid-specifier' };
    if (segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) return { ok: false, reason: 'outside-root' };
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  if (stack.length === 0) return { ok: false, reason: 'invalid-specifier' };
  const name = stack.join('/');
  if (name.length > MAX_SOURCE_UNIT_NAME_CODE_UNITS) {
    return { ok: false, reason: 'invalid-specifier' };
  }
  return { ok: true, kind: relative ? 'relative' : 'direct', name };
}

/** `@scope/name` is one package; any other first segment is the package. */
export function splitPackage(
  name: string,
): { readonly packageName: string; readonly rest: string } | null {
  const segments = name.split('/');
  const first = segments[0];
  if (first === undefined) return null;
  const packageLength = first.startsWith('@') ? 2 : 1;
  if (segments.length <= packageLength) return null;
  const packageName = segments.slice(0, packageLength).join('/');
  const rest = segments.slice(packageLength).join('/');
  return rest.length === 0 ? null : { packageName, rest };
}

/**
 * Builds the bounded candidate list for a direct name: root, `node_modules/<name>`, and one
 * `<lib>/<package>/src/<rest>` per validated library directory. No recursive search, extension
 * guessing, package exports or JS resolution.
 */
export function directCandidates(
  name: string,
  libs: readonly string[],
): readonly LookupCandidate[] {
  const candidates: LookupCandidate[] = [
    { path: name, origin: 'root' },
    { path: `node_modules/${name}`, origin: 'node-modules' },
  ];
  const split = splitPackage(name);
  if (split !== null) {
    for (const lib of libs) {
      const prefix = lib === '.' ? '' : `${lib}/`;
      candidates.push({
        path: `${prefix}${split.packageName}/src/${split.rest}`,
        origin: 'lib',
      });
    }
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

/**
 * Plans the lookup for one import. A matched remapping is authoritative: its single resolved
 * path is the only candidate, even when that file is missing or blocked.
 */
export function planImportLookup(
  importerPath: string,
  specifier: string,
  remappings: readonly Remapping[],
  libs: readonly string[],
): LookupPlan {
  const normalized = normalizeSourceUnitName(importerPath, specifier);
  if (!normalized.ok) return { ok: false, reason: normalized.reason };
  const match = selectRemapping(importerPath, normalized.name, remappings);
  if (match.kind === 'conflict') {
    return {
      ok: false,
      reason: 'remapping-conflict',
      name: normalized.name,
      conflicts: match.candidates,
    };
  }
  if (match.kind === 'applied') {
    const resolved = match.candidate.resolvedName;
    if (resolved === null) return { ok: false, reason: 'invalid-specifier' };
    return {
      ok: true,
      strategy: 'remapped',
      name: normalized.name,
      candidates: [{ path: resolved, origin: 'remapped' }],
      remapping: match.candidate,
    };
  }
  if (normalized.kind === 'relative') {
    return {
      ok: true,
      strategy: 'relative',
      name: normalized.name,
      candidates: [{ path: normalized.name, origin: 'relative' }],
      remapping: null,
    };
  }
  return {
    ok: true,
    strategy: 'direct',
    name: normalized.name,
    candidates: directCandidates(normalized.name, libs),
    remapping: null,
  };
}

export interface RemappingArrayDecision {
  readonly source: RemappingSourceKind;
  /** True when the active array is the root `remappings.txt` fallback and must be read. */
  readonly needsFile: boolean;
  readonly remappings: readonly Remapping[];
}

/**
 * Selects the active remapping array by existing provenance. Explicit config (including `[]`)
 * replaces Foundry hints, which replace `remappings.txt`; the text file is only the fallback when
 * no higher-priority input supplied an array. Arrays are never concatenated.
 */
export function selectRemappingArray(
  config: Pick<ResolvedConfig, 'imports' | 'provenance'>,
): RemappingArrayDecision {
  const provenance =
    config.provenance.find((item) => item.field === 'imports.remappings')?.source ?? 'default';
  if (provenance === 'default') {
    return { source: 'default', needsFile: true, remappings: config.imports.remappings };
  }
  return { source: provenance, needsFile: false, remappings: config.imports.remappings };
}
