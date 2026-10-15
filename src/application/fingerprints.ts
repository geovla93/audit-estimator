import { canonicalJson, fingerprint } from '../domain/canonical.ts';
import type { Analysis, FileId, ScopeManifest } from '../domain/types.ts';
import type { ParseFileResult } from '../parser/protocol.ts';

export interface SourcesFingerprintInput {
  /** The 008 relationship fingerprint, which already covers closure, semantics and config limits. */
  readonly relationshipFingerprint: string;
  readonly manifest: ScopeManifest;
  readonly syntax: readonly ParseFileResult[];
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (scalar) => scalar.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (scalar) => scalar.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const leftPoint = leftPoints[index] ?? 0;
    const rightPoint = rightPoints[index] ?? 0;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

/**
 * Digest of every scoped and context file (identity, bytes, role, ownership) plus the selected
 * grammar versions, composed with the relationship fingerprint. It never hashes only the initial
 * scoped bytes and never includes a native path.
 */
export function sourcesFingerprint(input: SourcesFingerprintInput): string {
  const entries = input.manifest.entries
    .filter((entry) => entry.role !== 'excluded')
    .map((entry) => ({
      fileId: entry.fileId,
      byteHash: entry.byteHash,
      role: entry.role,
      ownership: entry.ownership,
    }))
    .sort((left, right) => compareCodePoints(left.fileId, right.fileId));
  const grammars: { readonly fileId: FileId; readonly version: string }[] = [];
  for (const result of input.syntax) {
    if (result.status === 'parsed') {
      grammars.push({ fileId: result.fileId, version: result.version.selectedVersion });
    }
  }
  grammars.sort((left, right) => compareCodePoints(left.fileId, right.fileId));
  return fingerprint([
    'sources',
    canonicalJson({ relationships: input.relationshipFingerprint, entries, grammars }),
  ]);
}

/** Digest of the public analysis plus the component versions. Excludes time, root, cwd and PIDs. */
export function analysisFingerprint(
  analysis: Analysis,
  versions: Readonly<Record<string, string>>,
): string {
  // The JSON round trip drops undefined optional members, which canonical JSON rejects.
  const plain: unknown = JSON.parse(JSON.stringify(analysis)) as unknown;
  return fingerprint(['analysis', canonicalJson({ analysis: plain, versions })]);
}
