import type { FileId } from '../../domain/types.ts';
import type { FileMetrics } from '../../metrics/structural.ts';
import type { ParseFileResult, ParserSource } from '../../parser/protocol.ts';
import {
  NORMALIZER_VERSION,
  RecognizerAllowance,
  RecognizerLimitError,
  computeCatalogDigest,
  fingerprintDeclaration,
  indexTokens,
} from './fingerprint.ts';
import type { DependencyCatalog, DependencyMatch, RecognitionState } from './types.ts';

/** Local recognizer allowance per file; the shared analysis budget is separate and unaffected. */
export const MAX_RECOGNIZER_TOKENS_PER_FILE: number = 2_000_000;
export const MAX_RECOGNIZER_BYTES_PER_FILE: number = 64 * 1024 * 1024;
const MAX_REFERENCE_IDS = 32;

export const REASON_CATALOG_UNAVAILABLE = 'The reference catalog is unavailable.';
export const REASON_CATALOG_INVALID = 'The reference catalog failed its integrity check.';
export const REASON_PARSER_MISMATCH =
  'The reference catalog was generated with a different parser version.';
export const REASON_ALLOWANCE = 'The dependency recognizer allowance was exhausted for this file.';

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

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
 * Returns a fixed reason when the catalog cannot be trusted, otherwise null. A corrupt catalog is
 * never partially used: it behaves exactly like an unavailable one.
 */
export function catalogProblem(catalog: DependencyCatalog): string | null {
  if (catalog.status !== 'available') return REASON_CATALOG_UNAVAILABLE;
  if (
    !SHA256.test(catalog.digest) ||
    catalog.normalizerVersion !== NORMALIZER_VERSION ||
    catalog.parserVersion.length === 0 ||
    catalog.digest !== computeCatalogDigest(catalog)
  ) {
    return REASON_CATALOG_INVALID;
  }
  for (const file of catalog.files) {
    const grammars = catalog.grammarSets[file.grammarSet];
    if (
      !SHA256.test(file.sha256) ||
      !COMMIT.test(file.commit) ||
      grammars === undefined ||
      grammars.length === 0 ||
      !grammars.includes(file.selectedGrammar)
    ) {
      return REASON_CATALOG_INVALID;
    }
  }
  for (const declaration of catalog.declarations) {
    if (!SHA256.test(declaration.digest) || catalog.files[declaration.file] === undefined) {
      return REASON_CATALOG_INVALID;
    }
  }
  return null;
}

export interface ClassifyFile {
  readonly metrics: FileMetrics;
  readonly source: ParserSource;
  readonly result: ParseFileResult;
}

export interface ClassifyInput {
  readonly catalog: DependencyCatalog;
  /** Eligible files only. */
  readonly files: readonly ClassifyFile[];
  /** Shared-budget checkpoint; every failure it raises propagates unchanged. */
  readonly checkpoint: () => Promise<void>;
  readonly maxTokensPerFile?: number | undefined;
  readonly maxBytesPerFile?: number | undefined;
}

/**
 * Content recognition of complete top-level declarations. A digest match establishes
 * token-equivalent declaration content under the documented normalizer, nothing more: markers,
 * names and paths never establish a match, and a match does not prove the installed version,
 * dependency bindings, compiler behavior or security. Candidates are kept only when the active
 * parser version equals the catalog's and the target's selected grammar is in the reference's
 * worker-validated compatible set. Only the local allowance can make a file fall back (its
 * provisional matches are discarded atomically); shared-budget errors always propagate.
 */
export async function classifyDependencies(
  input: ClassifyInput,
): Promise<ReadonlyMap<FileId, RecognitionState>> {
  const states = new Map<FileId, RecognitionState>();
  const problem = catalogProblem(input.catalog);
  const unavailableFor = (reason: string): void => {
    for (const file of input.files) {
      states.set(file.metrics.file.fileId, { status: 'unavailable', reason });
    }
  };
  if (problem !== null) {
    unavailableFor(problem);
    return states;
  }
  const byDigest = new Map<string, number[]>();
  input.catalog.declarations.forEach((declaration, index) => {
    const list = byDigest.get(declaration.digest) ?? [];
    list.push(index);
    byDigest.set(declaration.digest, list);
  });

  for (const file of input.files) {
    await input.checkpoint();
    const fileId = file.metrics.file.fileId;
    const result = file.result;
    if (result.status !== 'parsed') {
      states.set(fileId, { status: 'unavailable', reason: REASON_CATALOG_UNAVAILABLE });
      continue;
    }
    if (result.version.parserVersion !== input.catalog.parserVersion) {
      states.set(fileId, { status: 'unavailable', reason: REASON_PARSER_MISMATCH });
      continue;
    }
    const allowance = new RecognizerAllowance(
      input.maxTokensPerFile ?? MAX_RECOGNIZER_TOKENS_PER_FILE,
      input.maxBytesPerFile ?? MAX_RECOGNIZER_BYTES_PER_FILE,
    );
    const matches: DependencyMatch[] = [];
    try {
      const index = indexTokens(
        result.tokens,
        result.events.filter((event) => event.kind === 'assembly').map((event) => event.range),
      );
      for (const contract of file.metrics.contracts) {
        const fingerprint = await fingerprintDeclaration(
          index,
          file.source.snapshot.originalBytes,
          { kind: contract.kind, name: contract.name, range: contract.range },
          input.checkpoint,
          allowance,
        );
        const candidates = byDigest.get(fingerprint.digest);
        if (candidates === undefined) continue;
        const referenceIds = new Set<string>();
        for (const candidate of candidates) {
          const declaration = input.catalog.declarations[candidate];
          const reference =
            declaration === undefined ? undefined : input.catalog.files[declaration.file];
          const grammars =
            reference === undefined ? undefined : input.catalog.grammarSets[reference.grammarSet];
          if (
            declaration === undefined ||
            reference === undefined ||
            grammars === undefined ||
            !grammars.includes(result.version.selectedVersion)
          ) {
            continue;
          }
          referenceIds.add(`${reference.id}#${declaration.name}`);
        }
        if (referenceIds.size === 0) continue;
        matches.push({
          fileId,
          contractId: contract.id,
          range: contract.range,
          digest: fingerprint.digest,
          referenceIds: [...referenceIds].sort(compareCodePoints).slice(0, MAX_REFERENCE_IDS),
        });
      }
    } catch (error: unknown) {
      if (!(error instanceof RecognizerLimitError)) throw error;
      states.set(fileId, { status: 'unavailable', reason: REASON_ALLOWANCE });
      continue;
    }
    matches.sort((left, right) => compareCodePoints(left.contractId, right.contractId));
    states.set(fileId, { status: 'available', matches });
  }
  return states;
}
