import type { Remapping } from '../domain/types.ts';

/** Maximum entries accepted from one active remapping array (matches the Foundry hint bound). */
export const MAX_REMAPPING_ENTRIES: number = 1_000;
/** Maximum prefix length accepted by the configured remapping schema. */
export const MAX_REMAPPING_PREFIX_CODE_UNITS: number = 128;
/** Maximum root-relative path length accepted by the configured remapping schema. */
export const MAX_REMAPPING_PATH_CODE_UNITS: number = 4_096;
/** Fixed ceiling for `remappings.txt`, never above the bootstrap metadata ceiling. */
export const MAX_REMAPPINGS_FILE_BYTES: number = 256 * 1024;

export type RemappingSourceKind = 'config' | 'cli' | 'metadata' | 'remappings-txt' | 'default';

export type RemappingTextFailure =
  | 'invalid-utf8'
  | 'invalid-line'
  | 'too-many-entries'
  | 'oversized';

export type ParsedRemappingText =
  | { readonly ok: true; readonly remappings: readonly Remapping[] }
  | { readonly ok: false; readonly reason: RemappingTextFailure };

/** A remapping that won ranking, with the already-transformed lookup name. */
export interface RemappingCandidate {
  readonly remapping: Remapping;
  /** Root-relative POSIX lookup path, or null when the replacement is not representable. */
  readonly resolvedName: string | null;
}

export type RemappingMatch =
  | { readonly kind: 'none' }
  | { readonly kind: 'applied'; readonly candidate: RemappingCandidate }
  | { readonly kind: 'conflict'; readonly candidates: readonly RemappingCandidate[] };

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

function hasForbiddenCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * Normalizes a text-file context/target into a confined root-relative POSIX path. Returns null
 * for anything that is not a plain local path (schemes, absolute, drive, UNC, traversal above
 * the root, control characters or backslashes).
 */
export function normalizeConfinedPath(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_REMAPPING_PATH_CODE_UNITS) return null;
  if (hasForbiddenCharacter(raw)) return null;
  if (raw.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(raw)) return null;
  const stack: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.length === 0 ? '.' : stack.join('/');
}

function parseRemappingLine(line: string): Remapping | null {
  const parts = line.split('=');
  if (parts.length !== 2) return null;
  const left = parts[0] ?? '';
  const targetRaw = parts[1] ?? '';
  const leftParts = left.split(':');
  if (leftParts.length > 2) return null;
  const prefix = leftParts.length === 2 ? (leftParts[1] ?? '') : (leftParts[0] ?? '');
  const contextRaw = leftParts.length === 2 ? (leftParts[0] ?? '') : undefined;
  if (prefix.length === 0 || prefix.length > MAX_REMAPPING_PREFIX_CODE_UNITS) return null;
  if (hasForbiddenCharacter(prefix) || prefix.includes(':')) return null;
  const target = normalizeConfinedPath(targetRaw);
  if (target === null) return null;
  if (contextRaw === undefined) return { prefix, target };
  const context = normalizeConfinedPath(contextRaw);
  return context === null ? null : { prefix, target, context };
}

/**
 * Parses a Foundry-style `remappings.txt`. Accepts one initial BOM, LF/CRLF/CR separators, blank
 * lines and full-line `#` comments. No shell expansion, inline comments or partial lists: any
 * invalid line rejects the whole file.
 */
export function parseRemappingsText(bytes: Uint8Array): ParsedRemappingText {
  if (bytes.byteLength > MAX_REMAPPINGS_FILE_BYTES) return { ok: false, reason: 'oversized' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, reason: 'invalid-utf8' };
  }
  const remappings: Remapping[] = [];
  for (const rawLine of text.split(/\r\n|\r|\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const parsed = parseRemappingLine(line);
    if (parsed === null) return { ok: false, reason: 'invalid-line' };
    remappings.push(parsed);
    if (remappings.length > MAX_REMAPPING_ENTRIES) return { ok: false, reason: 'too-many-entries' };
  }
  return { ok: true, remappings };
}

function contextOf(remapping: Remapping): string | null {
  const context = remapping.context;
  return context === undefined || context === '.' ? null : context;
}

function contextMatches(context: string | null, importerPath: string): boolean {
  if (context === null) return true;
  return importerPath === context || importerPath.startsWith(`${context}/`);
}

function validReplacement(candidate: string): string | null {
  if (candidate.length === 0 || candidate.length > MAX_REMAPPING_PATH_CODE_UNITS) return null;
  if (hasForbiddenCharacter(candidate) || candidate.startsWith('/')) return null;
  for (const segment of candidate.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return null;
  }
  return candidate;
}

/**
 * Applies one remapping once. A prefix ending in `/` is a directory mapping (target and suffix
 * are joined with exactly one `/`; `.` means the root). Any other prefix is replaced literally.
 */
export function applyRemapping(name: string, remapping: Remapping): string | null {
  if (!name.startsWith(remapping.prefix)) return null;
  const suffix = name.slice(remapping.prefix.length);
  const target = remapping.target;
  let replaced: string;
  if (remapping.prefix.endsWith('/')) {
    replaced = target === '.' ? suffix : `${target}/${suffix}`;
  } else {
    replaced = target === '.' ? suffix.replace(/^\//u, '') : `${target}${suffix}`;
  }
  return validReplacement(replaced);
}

function remappingKey(remapping: Remapping): string {
  return JSON.stringify([contextOf(remapping) ?? '', remapping.prefix, remapping.target]);
}

/**
 * Chooses the single winning remapping by longest matching context, then longest prefix.
 * Identical duplicates collapse. Equal-ranked entries with different targets are a conflict;
 * order never decides. The result is never remapped again.
 */
export function selectRemapping(
  importerPath: string,
  sourceUnitName: string,
  remappings: readonly Remapping[],
): RemappingMatch {
  const matching: { readonly remapping: Remapping; readonly contextLength: number }[] = [];
  for (const remapping of remappings) {
    const context = contextOf(remapping);
    if (!contextMatches(context, importerPath)) continue;
    if (!sourceUnitName.startsWith(remapping.prefix)) continue;
    matching.push({ remapping, contextLength: context?.length ?? -1 });
  }
  let best: { readonly contextLength: number; readonly prefixLength: number } | null = null;
  for (const item of matching) {
    const prefixLength = item.remapping.prefix.length;
    if (
      best === null ||
      item.contextLength > best.contextLength ||
      (item.contextLength === best.contextLength && prefixLength > best.prefixLength)
    ) {
      best = { contextLength: item.contextLength, prefixLength };
    }
  }
  const winners = new Map<string, Remapping>();
  for (const item of matching) {
    if (
      best !== null &&
      item.contextLength === best.contextLength &&
      item.remapping.prefix.length === best.prefixLength
    ) {
      winners.set(remappingKey(item.remapping), item.remapping);
    }
  }
  if (best === null || winners.size === 0) return { kind: 'none' };
  const ordered = [...winners.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([, remapping]) => remapping);
  const candidates: RemappingCandidate[] = ordered.map((remapping) => ({
    remapping,
    resolvedName: applyRemapping(sourceUnitName, remapping),
  }));
  const first = candidates[0];
  if (first === undefined) return { kind: 'none' };
  const distinctTargets = new Set(
    candidates.map((candidate) => candidate.resolvedName ?? candidate.remapping.target),
  );
  if (candidates.length === 1 || distinctTargets.size === 1) {
    return { kind: 'applied', candidate: first };
  }
  return { kind: 'conflict', candidates };
}
