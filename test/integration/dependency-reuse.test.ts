import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { productionConfigDefaults } from '../../src/application/defaults.ts';
import { REASON_ALLOWANCE } from '../../src/application/dependency-reuse/classify.ts';
import {
  NORMALIZER_VERSION,
  computeCatalogDigest,
  fingerprintDeclaration,
  indexTokens,
} from '../../src/application/dependency-reuse/fingerprint.ts';
import type { DependencyCatalog } from '../../src/application/dependency-reuse/types.ts';
import { trustedParserLabel } from '../../src/application/envelope.ts';
import { mergeConfig } from '../../src/config/merge.ts';
import { createDiscoveryBudget, BudgetError } from '../../src/discovery/budget.ts';
import { fileIdentity } from '../../src/domain/canonical.ts';
import { ReportEnvelopeSchema } from '../../src/domain/schemas.ts';
import type { EstimationScopeInput, ReportEnvelope } from '../../src/domain/types.ts';
import { buildFileMetrics } from '../../src/metrics/structural.ts';
import { createParserSession } from '../../src/parser/adapter.ts';
import { analyzeProject, formatMarkdown, formatTerminal, serializeJson } from '../../src/index.ts';
import type { AnalyzeRequest } from '../../src/index.ts';
import { createProject, removeProject, writeProjectFile } from '../helpers/filesystem.ts';

const hooks = vi.hoisted(() => ({
  catalog: undefined as unknown,
  classify: undefined as undefined | (() => object | undefined),
}));

vi.mock('../../src/application/dependency-reuse/catalog.ts', () => ({
  get BUNDLED_CATALOG(): unknown {
    return hooks.catalog;
  },
}));

vi.mock('../../src/application/dependency-reuse/classify.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/application/dependency-reuse/classify.ts')>();
  return {
    ...actual,
    classifyDependencies: (...args: Parameters<typeof actual.classifyDependencies>) => {
      const injected = hooks.classify?.();
      return actual.classifyDependencies(
        injected === undefined ? args[0] : { ...args[0], ...injected },
      );
    },
  };
});

const SOL = 'pragma solidity ^0.8.20;\n';
const TINY_ORACLE_DIGEST = '7e69f4495d8e7fe43b38035f36609488707492fd70ef492aad45afa90db0dc8d';

const FLATTENED = `${SOL}
// Dependency file: Tiny.sol
library Tiny {}

// Root file: Custom.sol
contract Custom {
    uint256 public v;

    function f() external {
        v = 1;
    }
}
`;

async function parserVersion(): Promise<string> {
  const label = await trustedParserLabel();
  return label.replace('slang@', '');
}

async function catalogWith(
  declarations: readonly { name: string; kind: 'library' | 'contract'; digest: string }[],
  overrides: Partial<DependencyCatalog> = {},
): Promise<DependencyCatalog> {
  const real = await vi.importActual<
    typeof import('../../src/application/dependency-reuse/catalog.ts')
  >('../../src/application/dependency-reuse/catalog.ts');
  // The reference grammar set for `^0.8.0`, which contains the grammar selected for `^0.8.20`.
  const grammarSet = real.BUNDLED_CATALOG.grammarSets[0] ?? [];
  const body: Omit<DependencyCatalog, 'digest'> = {
    status: 'available',
    version: '9.9.9-test',
    parserVersion: await parserVersion(),
    normalizerVersion: NORMALIZER_VERSION,
    grammarSets: [grammarSet],
    files: [
      {
        id: 'test-ref@v1:contracts/Reference.sol',
        repository: 'https://example.invalid/reference',
        tag: 'v1',
        commit: 'a'.repeat(40),
        path: 'contracts/Reference.sol',
        sha256: 'b'.repeat(64),
        license: 'MIT',
        pragma: 'solidity ^0.8.0',
        selectedGrammar: grammarSet[grammarSet.length - 1] ?? '0.8.28',
        grammarSet: 0,
      },
    ],
    declarations: declarations.map((item) => ({
      file: 0,
      kind: item.kind,
      name: item.name,
      digest: item.digest,
      tokenCount: 1,
    })),
    ...overrides,
  };
  return { ...body, digest: computeCatalogDigest(body) };
}

/** Digests of every top-level declaration of a reference text, from the real parser. */
async function referenceDigests(
  text: string,
): Promise<readonly { name: string; kind: 'library' | 'contract'; digest: string }[]> {
  const config = mergeConfig({ defaults: productionConfigDefaults() }).config;
  const budget = createDiscoveryBudget(config.analysis.limits);
  const session = createParserSession({ budget, config });
  try {
    const bytes = Buffer.from(text, 'utf8');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const fileId = fileIdentity('Reference.sol');
    const source = {
      fileId,
      snapshot: {
        canonicalPath: 'Reference.sol',
        absolutePath: '/reference/Reference.sol',
        originalBytes: bytes,
        originalText: text,
        byteHash: hash,
      },
      manifestEntry: {
        fileId,
        path: 'Reference.sol',
        role: 'scoped' as const,
        ownership: 'first-party' as const,
        ownershipEvidence: [],
        physicalIdentity: 'Reference.sol',
        byteHash: hash,
      },
    };
    const batch = await session.analyzeSources([source]);
    const result = batch.files[0];
    if (result === undefined || result.status !== 'parsed') throw new Error('reference parse');
    const raw = buildFileMetrics(source, result);
    const index = indexTokens(
      result.tokens,
      result.events.filter((event) => event.kind === 'assembly').map((event) => event.range),
    );
    const rows: { name: string; kind: 'library' | 'contract'; digest: string }[] = [];
    for (const contract of raw.contracts) {
      if (contract.kind !== 'library' && contract.kind !== 'contract') continue;
      const fingerprint = await fingerprintDeclaration(
        index,
        bytes,
        { kind: contract.kind, name: contract.name, range: contract.range },
        () => budget.checkpoint(),
      );
      rows.push({ name: contract.name, kind: contract.kind, digest: fingerprint.digest });
    }
    return rows;
  } finally {
    await session.close();
  }
}

async function withProject<T>(
  files: Readonly<Record<string, string>>,
  body: (root: string) => Promise<T>,
): Promise<T> {
  const root = await createProject('audit-estimator-reuse-');
  try {
    for (const [path, contents] of Object.entries(files)) {
      await writeProjectFile(root, path, contents);
    }
    return await body(root);
  } finally {
    await removeProject(root);
  }
}

async function analyze(
  root: string,
  overrides: Partial<AnalyzeRequest> = {},
): Promise<Awaited<ReturnType<typeof analyzeProject>>> {
  const outcome = await analyzeProject({
    command: 'estimate',
    input: root,
    noConfig: true,
    allowPartial: false,
    ...overrides,
  });
  ReportEnvelopeSchema.parse(outcome.envelope);
  return outcome;
}

function ledger(envelope: ReportEnvelope): Record<string, readonly [number, number]> {
  const rows: Record<string, [number, number]> = {};
  for (const row of envelope.estimate?.contributions ?? []) {
    const current = rows[row.category] ?? [0, 0];
    rows[row.category] = [current[0] + row.lowMicrohours, current[1] + row.highMicrohours];
  }
  return rows;
}

function scopeLines(envelope: ReportEnvelope): readonly number[] {
  const scope = envelope.analysis?.estimationScope;
  if (scope === undefined) throw new Error('Expected estimation scope metadata.');
  return [
    scope.rawSourceLines,
    scope.reviewSourceLines,
    scope.reusedSourceLines,
    scope.outOfScopeSourceLines,
  ].map((item) => (item.status === 'measured' ? item.value : -1));
}

afterEach(() => {
  hooks.catalog = undefined;
  hooks.classify = undefined;
});

describe('content-matched dependency reuse through the application', () => {
  it('omits only the matched library, with hand-counted lines and ledger', async () => {
    hooks.catalog = await catalogWith([
      { name: 'Tiny', kind: 'library', digest: TINY_ORACLE_DIGEST },
    ]);
    await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      const { envelope, outcome } = await analyze(root);
      expect(outcome).toBe('complete');
      // The independent oracle digest for `library Tiny {}` matches the real parser's tokens.
      const reuse = envelope.analysis?.dependencyReuse;
      expect(reuse?.policy).toBe('verified-reuse');
      expect(reuse?.catalogVersion).toBe('9.9.9-test');
      expect(reuse?.matches).toHaveLength(1);
      expect(reuse?.matches[0]).toMatchObject({
        digest: TINY_ORACLE_DIGEST,
        referenceIds: ['test-ref@v1:contracts/Reference.sol#Tiny'],
      });
      // Raw 8 lines (pragma, Tiny, six Custom lines); Tiny's single line is reused.
      expect(scopeLines(envelope)).toEqual([8, 7, 1, 0]);
      expect(reuse?.files).toEqual([
        expect.objectContaining({
          recognitionStatus: 'available',
          unavailableReason: null,
          rawSourceLines: 8,
          reviewSourceLines: 7,
          reusedSourceLines: 1,
          outOfScopeSourceLines: 0,
        }),
      ]);
      expect(envelope.analysis?.estimationScope?.scopeNarrowed).toBe(false);
      expect(envelope.analysis?.estimationScope?.contextContractIds).toHaveLength(1);
      // Baseline 7 x 0.04 / 0.12; project 4 / 12; nothing else is charged.
      expect(ledger(envelope)['baseline']).toEqual([280_000, 840_000]);
      expect(envelope.estimate?.coverage).toBe('full');
      expect(envelope.status).toBe('complete');
      // The custom contract stays at full review.
      expect(envelope.analysis?.estimationScope?.selectedContractIds).toHaveLength(1);
    });
  });

  it('matches regardless of flattening markers, comments and formatting', async () => {
    hooks.catalog = await catalogWith([
      { name: 'Tiny', kind: 'library', digest: TINY_ORACLE_DIGEST },
    ]);
    const variants: Readonly<Record<string, string>> = {
      none: `${SOL}library Tiny {}\ncontract Custom {\n    uint256 public v;\n}\n`,
      hardhat: `${SOL}// File contracts/Tiny.sol\n\n\nlibrary    Tiny\n{\n}\ncontract Custom {\n    uint256 public v;\n}\n`,
      spoofed: `${SOL}// Dependency file: node_modules/@openzeppelin/contracts/Fake.sol\n/// @title Tiny\nlibrary Tiny { /* body */ }\ncontract Custom {\n    uint256 public v;\n}\n`,
      crlf: `${SOL}library Tiny {}\r\ncontract Custom {\r\n    uint256 public v;\r\n}\r\n`,
    };
    const observed: Record<string, readonly [number, string | undefined, number]> = {};
    for (const [label, source] of Object.entries(variants)) {
      await withProject({ 'Flattened.sol': source }, async (root) => {
        const { envelope } = await analyze(root);
        const matches = envelope.analysis?.dependencyReuse?.matches ?? [];
        observed[label] = [matches.length, matches[0]?.digest, scopeLines(envelope)[2] ?? -1];
      });
    }
    // The reused line count differs only with formatting (the braces span three lines in one
    // variant); recognition and the digest do not.
    expect(observed).toEqual({
      none: [1, TINY_ORACLE_DIGEST, 1],
      hardhat: [1, TINY_ORACLE_DIGEST, 3],
      spoofed: [1, TINY_ORACLE_DIGEST, 1],
      crlf: [1, TINY_ORACLE_DIGEST, 1],
    });
  });

  it('does not match a changed, renamed or marker-spoofed declaration', async () => {
    hooks.catalog = await catalogWith([
      { name: 'Tiny', kind: 'library', digest: TINY_ORACLE_DIGEST },
    ]);
    const changed = `${SOL}// Dependency file: Tiny.sol (OpenZeppelin v4.3.2)\nlibrary Tiny { uint256 constant X = 1; }\ncontract Custom {\n    uint256 public v;\n}\n`;
    const renamed = `${SOL}library Other {}\ncontract Custom {\n    uint256 public v;\n}\n`;
    for (const source of [changed, renamed]) {
      await withProject({ 'Flattened.sol': source }, async (root) => {
        const { envelope } = await analyze(root);
        expect(envelope.analysis?.dependencyReuse?.matches).toEqual([]);
        const lines = scopeLines(envelope);
        expect(lines[2]).toBe(0);
        expect(lines[0]).toBe(lines[1]);
        expect(envelope.analysis?.estimationScope?.contextContractIds).toEqual([]);
      });
    }
  });

  it('discloses but never applies a match for the frozen 1.0.0 model', async () => {
    hooks.catalog = await catalogWith([
      { name: 'Tiny', kind: 'library', digest: TINY_ORACLE_DIGEST },
    ]);
    await withProject(
      {
        'Flattened.sol': FLATTENED,
        'legacy.json': JSON.stringify({
          configVersion: '1.1.0',
          model: { profile: 'heuristic-v1', modelVersion: '1.0.0' },
        }),
      },
      async (root) => {
        const { envelope } = await analyze(root, {
          noConfig: false,
          configPath: `${root}/legacy.json`,
        });
        const reuse = envelope.analysis?.dependencyReuse;
        expect(reuse?.policy).toBe('full-review');
        expect(reuse?.matches).toHaveLength(1);
        expect(scopeLines(envelope)).toEqual([8, 8, 0, 0]);
        expect(envelope.analysis?.estimationScope?.contextContractIds).toEqual([]);
        expect(ledger(envelope)['baseline']).toEqual([320_000, 960_000]);
        expect(envelope.versions.model).toBe('1.0.0');
      },
    );
  });

  it('applies no reuse to an explicit selection even when the selected declaration matches', async () => {
    hooks.catalog = await catalogWith([
      { name: 'Tiny', kind: 'library', digest: TINY_ORACLE_DIGEST },
    ]);
    await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      const scope: EstimationScopeInput = {
        mode: 'contracts',
        reason: 'Review the library and the custom contract.',
        contracts: [{ path: 'Flattened.sol', kind: 'library', name: 'Tiny' }],
      };
      const { envelope } = await analyze(root, { estimationScope: scope });
      const reuse = envelope.analysis?.dependencyReuse;
      // The selected library matches the catalog but keeps the full-review rate; Custom is
      // caller-excluded context and is not reuse.
      expect(reuse?.policy).toBe('full-review');
      expect(reuse?.matches).toHaveLength(1);
      expect(scopeLines(envelope)).toEqual([8, 2, 0, 6]);
      expect(envelope.analysis?.estimationScope?.selectedContractIds).toHaveLength(1);
      expect(envelope.analysis?.estimationScope?.contextContractIds).toHaveLength(1);
      expect(envelope.status).toBe('partial');
      expect(ledger(envelope)['baseline']).toEqual([80_000, 240_000]);
    });
  });

  it.each([
    [
      'an unavailable catalog',
      async () => ({ ...(await catalogWith([])), status: 'unavailable' as const }),
    ],
    [
      'a corrupt catalog',
      async () => ({
        ...(await catalogWith([{ name: 'Tiny', kind: 'library', digest: TINY_ORACLE_DIGEST }])),
        digest: 'f'.repeat(64),
      }),
    ],
    [
      'a catalog from another parser version',
      async () =>
        await catalogWith([{ name: 'Tiny', kind: 'library', digest: TINY_ORACLE_DIGEST }], {
          parserVersion: '0.0.1',
        }),
    ],
  ] as const)('falls back to full review for %s', async (_label, make) => {
    hooks.catalog = await make();
    await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      const { envelope } = await analyze(root);
      const reuse = envelope.analysis?.dependencyReuse;
      expect(reuse?.matches).toEqual([]);
      expect(reuse?.files[0]).toMatchObject({ recognitionStatus: 'unavailable' });
      expect(reuse?.files[0]?.unavailableReason).toEqual(expect.any(String));
      expect(scopeLines(envelope)).toEqual([8, 8, 0, 0]);
      expect(ledger(envelope)['baseline']).toEqual([320_000, 960_000]);
      // An explicit selection is unchanged by an unavailable catalog.
      const selected = await analyze(root, {
        estimationScope: {
          mode: 'contracts',
          reason: 'Only Custom.',
          contracts: [{ path: 'Flattened.sol', kind: 'contract', name: 'Custom' }],
        },
      });
      expect(scopeLines(selected.envelope)).toEqual([8, 7, 0, 1]);
    });
  });

  it('falls back atomically when only the local recognizer allowance is exhausted', async () => {
    hooks.catalog = await catalogWith([
      { name: 'Tiny', kind: 'library', digest: TINY_ORACLE_DIGEST },
    ]);
    hooks.classify = () => ({ maxTokensPerFile: 3 });
    await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      const { envelope, outcome } = await analyze(root);
      expect(outcome).toBe('complete');
      expect(envelope.analysis?.dependencyReuse?.matches).toEqual([]);
      expect(envelope.analysis?.dependencyReuse?.files[0]?.unavailableReason).toBe(
        REASON_ALLOWANCE,
      );
      expect(scopeLines(envelope)).toEqual([8, 8, 0, 0]);
    });
  });

  it('never turns a shared cancellation, deadline or limit into a successful fallback', async () => {
    hooks.catalog = await catalogWith([
      { name: 'Tiny', kind: 'library', digest: TINY_ORACLE_DIGEST },
    ]);
    await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      for (const [kind, code, interrupted] of [
        ['cancelled', 'PARTIAL_ANALYSIS', true],
        ['deadline', 'LIMIT_EXCEEDED', false],
        ['limit', 'LIMIT_EXCEEDED', false],
      ] as const) {
        hooks.classify = () => {
          throw new BudgetError(kind);
        };
        const { envelope, outcome } = await analyze(root);
        expect(envelope.status).toBe('error');
        expect(envelope.estimate).toBeNull();
        expect(envelope.diagnostics.map((item) => item.code)).toEqual([code]);
        expect(outcome).toBe(interrupted ? 'interrupted' : 'failure');
      }
    });
  });

  it('reflects the catalog in the analysis fingerprint but not in the source fingerprint', async () => {
    await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      hooks.catalog = await catalogWith([
        { name: 'Tiny', kind: 'library', digest: TINY_ORACLE_DIGEST },
      ]);
      const first = await analyze(root);
      const again = await analyze(root);
      expect(again.envelope).toEqual(first.envelope);
      hooks.catalog = await catalogWith(
        [{ name: 'Tiny', kind: 'library', digest: TINY_ORACLE_DIGEST }],
        { version: '9.9.10-test' },
      );
      const bumped = await analyze(root);
      expect(bumped.envelope.fingerprints.sources).toBe(first.envelope.fingerprints.sources);
      expect(bumped.envelope.fingerprints.analysis).not.toBe(first.envelope.fingerprints.analysis);
      expect(bumped.envelope.estimate).toEqual(first.envelope.estimate);
    });
  });

  it('removes a reusable assembly library from the EVM channel but keeps custom assembly', async () => {
    const library = `${SOL}library Mem {\n    function peek() internal pure returns (uint256 r) {\n        assembly {\n            r := 7\n        }\n    }\n}\n`;
    const digests = await referenceDigests(library);
    hooks.catalog = await catalogWith(digests);
    const custom = `contract Plain {\n    uint256 public v;\n}\n`;
    const customAssembly = `contract Raw {\n    function z() external pure returns (uint256 r) {\n        assembly {\n            r := 1\n        }\n    }\n}\n`;
    await withProject({ 'A.sol': `${library}${custom}` }, async (root) => {
      const { envelope } = await analyze(root);
      expect(envelope.analysis?.dependencyReuse?.matches).toHaveLength(1);
      // Raw assembly is still reported for the file, but the effective view carries none.
      const rawAssembly = envelope.analysis?.files[0]?.assemblyBlocks;
      expect(rawAssembly).toMatchObject({ status: 'measured', value: 1 });
      expect(ledger(envelope)['evm']).toEqual([0, 0]);
      expect(envelope.analysis?.estimationScope?.reusedSourceLines).toMatchObject({
        status: 'measured',
      });
    });
    await withProject({ 'A.sol': `${library}${customAssembly}` }, async (root) => {
      const { envelope } = await analyze(root);
      expect(envelope.analysis?.dependencyReuse?.matches).toHaveLength(1);
      // The custom contract's own assembly keeps the EVM premium: baseline x 0.2 / 0.5.
      const baseline = ledger(envelope)['baseline'] ?? [0, 0];
      expect(ledger(envelope)['evm']).toEqual([
        Math.floor(baseline[0] * 0.2),
        Math.ceil(baseline[1] * 0.5),
      ]);
    });
  });
});

describe('reuse provenance validation and rendering', () => {
  async function matchedReport(): Promise<ReportEnvelope> {
    hooks.catalog = await catalogWith([
      { name: 'Tiny', kind: 'library', digest: TINY_ORACLE_DIGEST },
    ]);
    return await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      return (await analyze(root)).envelope;
    });
  }

  function mutated(
    report: ReportEnvelope,
    change: (analysis: NonNullable<ReportEnvelope['analysis']>) => Record<string, unknown>,
  ): unknown {
    if (report.analysis === null) throw new Error('analysis expected');
    return { ...report, analysis: { ...report.analysis, ...change(report.analysis) } };
  }

  it('rejects inconsistent reuse accounting, matches and policy', async () => {
    const report = await matchedReport();
    const reuse = report.analysis?.dependencyReuse;
    if (reuse === undefined) throw new Error('reuse expected');
    const row = reuse.files[0];
    const match = reuse.matches[0];
    if (row === undefined || match === undefined) throw new Error('fixture');
    const withReuse = (changes: Record<string, unknown>): unknown =>
      mutated(report, () => ({ dependencyReuse: { ...reuse, ...changes } }));
    expect(ReportEnvelopeSchema.safeParse(report).success).toBe(true);
    const invalid: readonly unknown[] = [
      withReuse({ files: [{ ...row, reviewSourceLines: row.reviewSourceLines + 1 }] }),
      withReuse({ files: [{ ...row, rawSourceLines: 99, reviewSourceLines: 98 }] }),
      withReuse({ files: [{ ...row, recognitionStatus: 'unavailable' }] }),
      withReuse({ files: [row, row] }),
      withReuse({ matches: [{ ...match, contractId: 'decl:Other.sol:contract:0' }] }),
      withReuse({ matches: [match, match] }),
      withReuse({ matches: [{ ...match, referenceIds: ['b', 'a'] }] }),
      withReuse({ matches: [{ ...match, digest: 'xyz' }] }),
      withReuse({ matches: [] }),
      withReuse({ policy: 'full-review' }),
      withReuse({ catalogDigest: 'nothex' }),
      withReuse({ limitations: Array.from({ length: 33 }, () => 'x') }),
      withReuse({ policyVersion: '2.0.0' }),
    ];
    invalid.forEach((candidate) => {
      expect(ReportEnvelopeSchema.safeParse(candidate).success).toBe(false);
    });
    // Matches without scope metadata are not a valid report.
    expect(
      ReportEnvelopeSchema.safeParse(mutated(report, () => ({ estimationScope: undefined })))
        .success,
    ).toBe(false);
  });

  it('renders effective review, reuse and references deterministically in every format', async () => {
    const report = await matchedReport();
    const terminal = formatTerminal(report, { detail: true });
    expect(terminal).toContain('Dependency reuse');
    expect(terminal).toContain('raw 8; effective review 7; content-reused 1; caller-excluded 0');
    expect(terminal).toContain('Content matches: 1 declaration (omitted from full review)');
    expect(terminal).toContain('Omitted from full review: content reuse');
    expect(terminal).toContain('test-ref@v1:contracts/Reference.sol#Tiny');
    expect(terminal).toContain('does not verify the installed version');
    expect(formatTerminal(report, { detail: true })).toBe(terminal);
    const markdown = formatMarkdown(report);
    expect(markdown).toContain('## Dependency reuse');
    expect(markdown).toContain('## Omitted from full review: content reuse');
    expect(serializeJson(report)).toBe(serializeJson(report));
    expect(serializeJson(report)).toContain('"policy": "verified-reuse"');
    // No native path or source excerpt reaches the rendered output.
    for (const output of [terminal, markdown, serializeJson(report)]) {
      expect(output).not.toContain('library Tiny');
      expect(output).not.toContain(tmpdir());
    }
  });

  it('labels caller-selected context separately from content reuse', async () => {
    hooks.catalog = await catalogWith([
      { name: 'Tiny', kind: 'library', digest: TINY_ORACLE_DIGEST },
    ]);
    await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      const { envelope } = await analyze(root, {
        estimationScope: {
          mode: 'contracts',
          reason: 'Only the custom contract.',
          contracts: [{ path: 'Flattened.sol', kind: 'contract', name: 'Custom' }],
        },
      });
      const terminal = formatTerminal(envelope, { detail: true });
      expect(terminal).toContain('Omitted from full review: caller-selected context');
      expect(terminal).toContain('caller-selected context, not evidence of reuse');
      expect(terminal).toContain('disclosed only, not applied');
      expect(terminal).toContain('the whole physical scope was not priced');
      expect(terminal).not.toContain('Omitted from full review: content reuse');
    });
  });
});
