import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveConfig } from '../../src/config/load.ts';
import { DEFAULT_SCOPE_SETTINGS } from '../../src/config/defaults.ts';
import { createDiscoveryBudget } from '../../src/discovery/budget.ts';
import { fileIdentity } from '../../src/domain/canonical.ts';
import type {
  AnalysisLimits,
  FileScopeEntry,
  ModelProfile,
  ScopeRole,
  SourceSnapshot,
} from '../../src/domain/types.ts';
import type { TrustedConfigDefaults } from '../../src/config/merge.ts';
import { createParserSession } from '../../src/parser/adapter.ts';
import type { ParseFileResult, ParserSource } from '../../src/parser/protocol.ts';
import { testLimits } from './filesystem.ts';

export function trustedDefaults(limits: AnalysisLimits): TrustedConfigDefaults {
  const model: ModelProfile = {
    profile: 'heuristic-v1',
    modelVersion: '1.0.0',
    parameters: {
      projectHours: { low: 0.5, high: 1 },
      slocHours: { low: 0.001, high: 0.002 },
      controlPremium: { low: 0.1, high: 0.2 },
      storagePremium: { low: 0.1, high: 0.2 },
      evmPremium: { low: 0.1, high: 0.2 },
      interactionHours: { low: 0.25, high: 0.5 },
      boundaryHours: { low: 0.25, high: 0.5 },
      unknownReserveHigh: 0.5,
      hoursPerDay: 8,
    },
  };
  return {
    scope: { ...DEFAULT_SCOPE_SETTINGS },
    imports: { remappings: [] },
    solidity: { version: '0.8.28' },
    analysis: { limits },
    model,
    manualAdjustments: [],
    coverage: { lcovPath: null },
  };
}

export function parserSource(
  root: string,
  canonicalPath: string,
  source: string,
  role: ScopeRole = 'scoped',
): ParserSource {
  const fileId = fileIdentity(canonicalPath);
  const originalBytes = Buffer.from(source, 'utf8');
  const byteHash = createHash('sha256').update(originalBytes).digest('hex');
  const snapshot: SourceSnapshot = {
    canonicalPath,
    absolutePath: resolve(root, canonicalPath),
    originalBytes,
    originalText: source,
    byteHash,
  };
  const manifestEntry: FileScopeEntry = {
    fileId,
    path: canonicalPath,
    role,
    ownership: 'first-party',
    ownershipEvidence: [],
    physicalIdentity: `fixture:${canonicalPath}`,
    byteHash,
  };
  return { fileId, snapshot, manifestEntry };
}

export interface ParsedSource {
  readonly source: ParserSource;
  readonly result: ParseFileResult;
}

export interface SourceInput {
  readonly path: string;
  readonly text: string;
  readonly role?: ScopeRole;
}

/** Parses the inputs through the real isolated worker. Requires `pnpm build` first. */
export async function parseSources(
  inputs: readonly SourceInput[],
  limits: AnalysisLimits = testLimits(),
): Promise<readonly ParsedSource[]> {
  const root = await mkdtemp(join(tmpdir(), 'audit-estimator-metrics-'));
  try {
    const resolved = await resolveConfig({
      root,
      noConfig: true,
      defaults: trustedDefaults(limits),
    });
    const budget = createDiscoveryBudget(resolved.config.analysis.limits);
    const session = createParserSession({ budget, config: resolved.config });
    try {
      const sources = inputs.map((input) =>
        parserSource(root, input.path, input.text, input.role ?? 'scoped'),
      );
      const batch = await session.analyzeSources(sources);
      if (!batch.complete || batch.files.length !== sources.length) {
        throw new Error('Parser batch did not complete.');
      }
      return sources.map((source) => {
        const result = batch.files.find((candidate) => candidate.fileId === source.fileId);
        if (result === undefined) throw new Error('Missing parser result.');
        return { source, result };
      });
    } finally {
      await session.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Parses one source and requires a successful result. */
export async function parseOne(
  text: string,
  path = 'contracts/T.sol',
): Promise<Extract<ParseFileResult, { status: 'parsed' }>> {
  const [parsed] = await parseSources([{ path, text }]);
  if (parsed?.result.status !== 'parsed') {
    throw new Error(`Expected a parsed result, got ${parsed?.result.status ?? 'nothing'}.`);
  }
  return parsed.result;
}
