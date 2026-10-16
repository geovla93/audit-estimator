import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { analyzeProject } from '../../src/index.ts';
import type { AnalyzeRequest } from '../../src/index.ts';
import { ProjectionUnavailableError } from '../../src/application/dependency-reuse/types.ts';
import { ScopeLimitError } from '../../src/application/estimation-scope.ts';
import { exitCodeFor } from '../../src/cli/exit-codes.ts';
import { ReportEnvelopeSchema } from '../../src/domain/schemas.ts';
import type { EstimationScopeInput, ReportEnvelope } from '../../src/domain/types.ts';
import { createProject, removeProject, writeProjectFile } from '../helpers/filesystem.ts';

const hooks = vi.hoisted(() => ({
  project: undefined as undefined | (() => never),
  resolve: undefined as undefined | (() => never),
}));

vi.mock('../../src/application/dependency-reuse/project.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/application/dependency-reuse/project.ts')>();
  return {
    ...actual,
    projectReview: (...args: Parameters<typeof actual.projectReview>) => {
      if (hooks.project !== undefined) hooks.project();
      return actual.projectReview(...args);
    },
  };
});

vi.mock('../../src/application/estimation-scope.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/application/estimation-scope.ts')>();
  return {
    ...actual,
    resolveDispositions: (...args: Parameters<typeof actual.resolveDispositions>) => {
      if (hooks.resolve !== undefined) hooks.resolve();
      return actual.resolveDispositions(...args);
    },
  };
});

// Original synthetic flattened fixture. Hand-counted physical lines (comments are not source
// lines): pragma 1, Lib 5, Helper 8, Token 8 = 22 raw lines; Token plus the pragma = 9.
const FLATTENED = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Dependency file: Lib.sol
library Lib {
    function twice(uint256 x) internal pure returns (uint256) {
        return x * 2;
    }
}

// Dependency file: Helper.sol
contract Helper {
    uint256 public stored;

    function put(uint256 v) external {
        if (v > 0) {
            stored = v;
        }
    }
}

// Root file: Token.sol
contract Token {
    uint256 public total;
    Helper public helper;

    function mint(uint256 v) external {
        total = Lib.twice(v);
        helper.put(v);
    }
}
`;

const BROKEN = 'pragma solidity ^0.8.20;\ncontract Broken {\n    function oops( external {\n';

const TOKEN: EstimationScopeInput = {
  mode: 'contracts',
  contracts: [{ path: 'Flattened.sol', kind: 'contract', name: 'Token' }],
  reason: 'Estimate the agreed token review scope.',
};

async function withProject<T>(
  files: Readonly<Record<string, string>>,
  body: (root: string) => Promise<T>,
): Promise<T> {
  const root = await createProject('audit-estimator-scope-');
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

function configJson(body: Readonly<Record<string, unknown>>, version = '1.1.0'): string {
  return JSON.stringify({ configVersion: version, ...body });
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function lines(envelope: ReportEnvelope): readonly number[] {
  const scope = envelope.analysis?.estimationScope;
  if (scope === undefined) throw new Error('Expected estimation scope metadata.');
  return [
    scope.rawSourceLines,
    scope.reviewSourceLines,
    scope.reusedSourceLines,
    scope.outOfScopeSourceLines,
  ].map((item) => (item.status === 'measured' ? item.value : -1));
}

function ledger(envelope: ReportEnvelope): Record<string, readonly [number, number]> {
  const rows: Record<string, [number, number]> = {};
  for (const row of envelope.estimate?.contributions ?? []) {
    const current = rows[row.category] ?? [0, 0];
    rows[row.category] = [current[0] + row.lowMicrohours, current[1] + row.highMicrohours];
  }
  return rows;
}

describe('whole-scope default under the current model', () => {
  it('prices every declaration and reports an unnarrowed scope', async () => {
    await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      const { envelope, outcome } = await analyze(root);
      expect(outcome).toBe('complete');
      expect(envelope.versions.model).toBe('1.1.0');
      expect(envelope.estimate?.modelVersion).toBe('1.1.0');
      expect(envelope.estimate?.coverage).toBe('full');
      expect(envelope.fullScopeEstimate).toEqual(envelope.estimate);
      const scope = envelope.analysis?.estimationScope;
      expect(scope?.mode).toBe('all');
      expect(scope?.scopeNarrowed).toBe(false);
      expect(scope?.requestedScopeComplete).toBe(true);
      expect(scope?.contextContractIds).toEqual([]);
      expect(scope?.selectedContractIds).toHaveLength(3);
      expect(lines(envelope)).toEqual([22, 22, 0, 0]);
      // Baseline: 22 lines x 0.04 / 0.12.
      expect(ledger(envelope)['baseline']).toEqual([880_000, 2_640_000]);
    });
  });

  it('matches the frozen 1.0.0 model numerically and labels it explicitly', async () => {
    await withProject(
      {
        'Flattened.sol': FLATTENED,
        'legacy.json': configJson(
          { model: { profile: 'heuristic-v1', modelVersion: '1.0.0' } },
          '1.0.0',
        ),
      },
      async (root) => {
        const current = await analyze(root);
        const legacy = await analyze(root, {
          noConfig: false,
          configPath: join(root, 'legacy.json'),
        });
        expect(legacy.envelope.versions.model).toBe('1.0.0');
        expect(legacy.envelope.estimate?.modelVersion).toBe('1.0.0');
        expect(legacy.envelope.estimate?.assumptions).toHaveLength(3);
        expect(current.envelope.estimate?.assumptions).toHaveLength(4);
        expect(legacy.envelope.estimate?.auditorHours).toEqual(
          current.envelope.estimate?.auditorHours,
        );
        expect(ledger(legacy.envelope)).toEqual(ledger(current.envelope));
        expect(legacy.envelope.analysis?.estimationScope?.mode).toBe('all');
        expect(legacy.envelope.fingerprints.semanticConfig).not.toBe(
          current.envelope.fingerprints.semanticConfig,
        );
      },
    );
  });
});

describe('exact caller selection', () => {
  it('keeps selected code at full review, context out of it, and narrows coverage', async () => {
    await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      const whole = await analyze(root);
      const { envelope, outcome } = await analyze(root, { estimationScope: TOKEN });
      expect(outcome).toBe('partial');
      expect(envelope.status).toBe('partial');
      expect(exitCodeFor({ outcome, diagnostics: envelope.diagnostics })).toBe(4);
      expect(envelope.estimate?.coverage).toBe('analyzed-subset');
      expect(envelope.fullScopeEstimate).toBeNull();
      const scope = envelope.analysis?.estimationScope;
      expect(scope?.mode).toBe('contracts');
      expect(scope?.reason).toBe('Estimate the agreed token review scope.');
      expect(scope?.scopeNarrowed).toBe(true);
      expect(scope?.requestedScopeComplete).toBe(true);
      expect(scope?.selectedContractIds).toEqual(['decl:Flattened.sol:contract:374']);
      expect(scope?.contextContractIds).toEqual([
        'decl:Flattened.sol:contract:194',
        'decl:Flattened.sol:library:57',
      ]);
      // Raw 22; Token plus the pragma 9; the other 13 are caller exclusions, never reuse.
      expect(lines(envelope)).toEqual([22, 9, 0, 13]);
      // Hand ledger: baseline 9 x 0.04/0.12; one Token->Lib boundary 0.5/2; project 4/12; the
      // Helper storage in Token is user-defined so the reserve is 25% of the 15.08 high subtotal.
      expect(ledger(envelope)).toMatchObject({
        baseline: [360_000, 1_080_000],
        boundary: [500_000, 2_000_000],
        project: [4_000_000, 12_000_000],
        reserve: [0, 3_770_000],
      });
      expect(ledger(envelope)['interaction']).toBeUndefined();
      expect(envelope.estimate?.auditorHours).toEqual({ low: 4, high: 19 });
      expect(
        envelope.diagnostics.some(
          (item) => item.code === 'PARTIAL_ANALYSIS' && item.severity === 'info',
        ),
      ).toBe(true);
      expect(
        envelope.limitations.some((text) => text.includes('not evidence of verified reuse')),
      ).toBe(true);
      // Raw measurements, graphs and completeness are untouched by the selection.
      expect(envelope.analysis?.files).toEqual(whole.envelope.analysis?.files);
      expect(envelope.analysis?.contracts).toEqual(whole.envelope.analysis?.contracts);
      expect(envelope.analysis?.callables).toEqual(whole.envelope.analysis?.callables);
      expect(envelope.analysis?.graphs).toEqual(whole.envelope.analysis?.graphs);
      expect(envelope.analysis?.completeness).toEqual(whole.envelope.analysis?.completeness);
      expect(envelope.fingerprints.sources).toBe(whole.envelope.fingerprints.sources);
      expect(envelope.fingerprints.semanticConfig).not.toBe(
        whole.envelope.fingerprints.semanticConfig,
      );
      expect(envelope.fingerprints.analysis).not.toBe(whole.envelope.fingerprints.analysis);
    });
  });

  it('inspect reports the scope metadata but stays complete for complete raw analysis', async () => {
    await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      const { envelope, outcome } = await analyze(root, {
        command: 'inspect',
        estimationScope: TOKEN,
      });
      expect(outcome).toBe('complete');
      expect(envelope.status).toBe('complete');
      expect(envelope.estimate).toBeNull();
      expect(envelope.analysis?.estimationScope?.scopeNarrowed).toBe(true);
    });
  });

  it('is not a subset when every eligible declaration is selected', async () => {
    await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      const scope: EstimationScopeInput = {
        mode: 'contracts',
        reason: 'Everything is in scope.',
        contracts: [
          { path: 'Flattened.sol', kind: 'library', name: 'Lib' },
          { path: 'Flattened.sol', kind: 'contract', name: 'Helper' },
          { path: 'Flattened.sol', kind: 'contract', name: 'Token' },
        ],
      };
      const whole = await analyze(root);
      const { envelope, outcome } = await analyze(root, { estimationScope: scope });
      expect(outcome).toBe('complete');
      expect(envelope.estimate?.coverage).toBe('full');
      expect(envelope.fullScopeEstimate).toEqual(envelope.estimate);
      expect(envelope.analysis?.estimationScope?.scopeNarrowed).toBe(false);
      expect(envelope.estimate?.auditorHours).toEqual(whole.envelope.estimate?.auditorHours);
    });
  });

  it('agrees across request, root config, nested config and a config outside the project', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'audit-estimator-outside-'));
    try {
      await withProject(
        {
          'Flattened.sol': FLATTENED,
          'audit-estimator.config.json': configJson({ estimationScope: TOKEN }),
          'nested/deeper/scope.json': configJson({ estimationScope: TOKEN }),
        },
        async (root) => {
          const external = join(outside, 'external.json');
          await mkdir(outside, { recursive: true });
          await writeFile(external, configJson({ estimationScope: TOKEN }));
          const viaRequest = await analyze(root, { estimationScope: TOKEN });
          const viaRoot = await analyze(root, { noConfig: false });
          const viaNested = await analyze(root, {
            noConfig: false,
            configPath: join(root, 'nested/deeper/scope.json'),
          });
          const viaExternal = await analyze(root, { noConfig: false, configPath: external });
          for (const other of [viaRoot, viaNested, viaExternal]) {
            expect(other.envelope.fingerprints.semanticConfig).toBe(
              viaRequest.envelope.fingerprints.semanticConfig,
            );
            expect(other.envelope.analysis?.estimationScope).toEqual(
              viaRequest.envelope.analysis?.estimationScope,
            );
            expect(other.envelope.estimate).toEqual(viaRequest.envelope.estimate);
          }
          // A request override replaces a configured selection.
          const replaced = await analyze(root, {
            noConfig: false,
            estimationScope: { mode: 'all' },
          });
          expect(replaced.envelope.analysis?.estimationScope?.mode).toBe('all');
        },
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('is independent of selector order and changes identity with the selection', async () => {
    await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      const pair: EstimationScopeInput = {
        mode: 'contracts',
        reason: 'Two declarations.',
        contracts: [
          { path: 'Flattened.sol', kind: 'contract', name: 'Token' },
          { path: 'Flattened.sol', kind: 'contract', name: 'Helper' },
        ],
      };
      const reversed: EstimationScopeInput = {
        ...pair,
        contracts: [...(pair.mode === 'contracts' ? pair.contracts : [])].reverse(),
      };
      const one = await analyze(root, { estimationScope: pair });
      const two = await analyze(root, { estimationScope: reversed });
      const token = await analyze(root, { estimationScope: TOKEN });
      expect(one.envelope.fingerprints).toEqual(two.envelope.fingerprints);
      expect(one.envelope.estimate).toEqual(two.envelope.estimate);
      expect(one.envelope.fingerprints.sources).toBe(token.envelope.fingerprints.sources);
      expect(one.envelope.fingerprints.semanticConfig).not.toBe(
        token.envelope.fingerprints.semanticConfig,
      );
      expect(one.envelope.fingerprints.analysis).not.toBe(token.envelope.fingerprints.analysis);
    });
  });

  it('honors source hash guards: current passes and stale fails without retargeting', async () => {
    await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      const guarded = (hash: string): EstimationScopeInput => ({
        mode: 'contracts',
        reason: 'Pinned review scope.',
        contracts: [{ path: 'Flattened.sol', kind: 'contract', name: 'Token', sourceHash: hash }],
      });
      const current = await analyze(root, { estimationScope: guarded(sha(FLATTENED)) });
      expect(current.envelope.status).toBe('partial');
      const stale = await analyze(root, { estimationScope: guarded(sha(`${FLATTENED}\n`)) });
      expect(stale.envelope.status).toBe('error');
      expect(stale.envelope.diagnostics.map((item) => item.code)).toEqual(['CONFIG_INVALID']);
      expect(stale.envelope.estimate).toBeNull();
      expect(stale.envelope.analysis).toBeNull();
    });
  });

  it('follows a same-name edit when no hash is supplied, as documented', async () => {
    const edited = FLATTENED.replace('total = Lib.twice(v);', 'total = Lib.twice(v) + 1;');
    await withProject({ 'Flattened.sol': edited }, async (root) => {
      const { envelope } = await analyze(root, { estimationScope: TOKEN });
      expect(envelope.status).toBe('partial');
      expect(envelope.analysis?.estimationScope?.selectedContractIds).toHaveLength(1);
    });
  });

  const invalidCases: readonly (readonly [string, EstimationScopeInput])[] = [
    [
      'an unknown declaration',
      { ...TOKEN, contracts: [{ path: 'Flattened.sol', kind: 'contract', name: 'Missing' }] },
    ],
    [
      'a wrong kind',
      { ...TOKEN, contracts: [{ path: 'Flattened.sol', kind: 'library', name: 'Token' }] },
    ],
    [
      'a missing path',
      { ...TOKEN, contracts: [{ path: 'Other.sol', kind: 'contract', name: 'Token' }] },
    ],
  ];
  it.each(invalidCases)(
    'fails with a sanitized error for %s, for estimate and inspect',
    async (_n, scope) => {
      await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
        for (const command of ['estimate', 'inspect'] as const) {
          const { envelope, outcome } = await analyze(root, { command, estimationScope: scope });
          expect(outcome).toBe('failure');
          expect(envelope.status).toBe('error');
          expect(envelope.failureCategory).toBe('config');
          expect(envelope.diagnostics.map((item) => item.code)).toEqual(['CONFIG_INVALID']);
          expect(envelope.estimate).toBeNull();
          expect(envelope.analysis).toBeNull();
          expect(JSON.stringify(envelope)).not.toContain(root);
        }
      });
    },
  );

  it('validates a request override even when configuration is disabled', async () => {
    await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      const { envelope } = await analyze(root, {
        noConfig: true,
        estimationScope: { mode: 'contracts', contracts: [], reason: 'No selectors.' },
      });
      expect(envelope.status).toBe('error');
      expect(envelope.failureCategory).toBe('config');
    });
  });

  it('rejects an explicit contract scope together with the frozen 1.0.0 model', async () => {
    await withProject(
      {
        'Flattened.sol': FLATTENED,
        'audit-estimator.config.json': configJson({
          model: { profile: 'heuristic-v1', modelVersion: '1.0.0' },
          estimationScope: TOKEN,
        }),
      },
      async (root) => {
        const { envelope } = await analyze(root, { noConfig: false });
        expect(envelope.status).toBe('error');
        expect(envelope.failureCategory).toBe('config');
        // The configuration never resolved, so the default model labels the failure.
        expect(envelope.versions.model).toBe('1.1.0');
      },
    );
  });

  it('keeps free functions and a same-line neighbour in the review view', async () => {
    const source = `pragma solidity ^0.8.20;
contract A { uint256 public a; } contract B { uint256 public b; }
function helper() pure returns (uint256) {
    return 1;
}
`;
    await withProject({ 'Same.sol': source }, async (root) => {
      const scope: EstimationScopeInput = {
        mode: 'contracts',
        reason: 'Only A.',
        contracts: [{ path: 'Same.sol', kind: 'contract', name: 'A' }],
      };
      const { envelope } = await analyze(root, { estimationScope: scope });
      expect(envelope.analysis?.estimationScope?.scopeNarrowed).toBe(true);
      // Pragma, the shared contract line and the three free-function lines remain: 5 lines. B
      // shares line 2 with A, so no whole line is excluded even though B is context.
      expect(lines(envelope)).toEqual([5, 5, 0, 0]);
      expect(envelope.estimate?.coverage).toBe('analyzed-subset');
      expect(envelope.status).toBe('partial');
    });
  });
});

describe('selection together with genuine analysis failure', () => {
  const files = { 'Flattened.sol': FLATTENED, 'Broken.sol': BROKEN };

  it('keeps the existing allowPartial rule for unrelated failures', async () => {
    await withProject(files, async (root) => {
      const strict = await analyze(root, { estimationScope: TOKEN });
      expect(strict.envelope.status).toBe('partial');
      expect(strict.envelope.estimate).toBeNull();
      expect(strict.envelope.analysis?.completeness.requiredAnalysisComplete).toBe(false);
      expect(strict.envelope.analysis?.estimationScope?.requestedScopeComplete).toBe(true);
      const lenient = await analyze(root, { estimationScope: TOKEN, allowPartial: true });
      expect(lenient.envelope.estimate?.coverage).toBe('analyzed-subset');
      expect(lenient.envelope.fullScopeEstimate).toBeNull();
      expect(lenient.envelope.estimate?.auditorHours).toEqual({ low: 4, high: 19 });
    });
  });

  it('never prices a selection that points into a failed file', async () => {
    await withProject(files, async (root) => {
      const scope: EstimationScopeInput = {
        mode: 'contracts',
        reason: 'Broken file selected.',
        contracts: [{ path: 'Broken.sol', kind: 'contract', name: 'Broken' }],
      };
      const { envelope } = await analyze(root, { estimationScope: scope, allowPartial: true });
      expect(envelope.status).toBe('error');
      expect(envelope.failureCategory).toBe('config');
      expect(envelope.estimate).toBeNull();
    });
  });

  it('whole-scope requested completeness follows raw completeness', async () => {
    await withProject(files, async (root) => {
      const { envelope } = await analyze(root, { allowPartial: true });
      expect(envelope.analysis?.estimationScope?.requestedScopeComplete).toBe(false);
    });
  });
});

describe('effective model identity', () => {
  it('labels inspect and post-configuration errors with the selected model', async () => {
    const config = configJson(
      { model: { profile: 'heuristic-v1', modelVersion: '1.0.0' } },
      '1.0.0',
    );
    await withProject({ 'Flattened.sol': FLATTENED, 'legacy.json': config }, async (root) => {
      const inspect = await analyze(root, {
        command: 'inspect',
        noConfig: false,
        configPath: join(root, 'legacy.json'),
      });
      expect(inspect.envelope.versions.model).toBe('1.0.0');
    });
    await withProject({ 'README.md': 'no Solidity\n', 'legacy.json': config }, async (root) => {
      const { envelope } = await analyze(root, {
        noConfig: false,
        configPath: join(root, 'legacy.json'),
      });
      expect(envelope.status).toBe('error');
      expect(envelope.versions.model).toBe('1.0.0');
    });
    await withProject({ 'README.md': 'no Solidity\n' }, async (root) => {
      const { envelope } = await analyze(root);
      expect(envelope.versions.model).toBe('1.1.0');
    });
  });
});

describe('typed projection and bound failures', () => {
  it('keeps the partition, drops the estimate and counts when projection is unavailable', async () => {
    await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      hooks.project = (): never => {
        throw new ProjectionUnavailableError();
      };
      try {
        const { envelope, outcome } = await analyze(root, {
          estimationScope: TOKEN,
          allowPartial: true,
        });
        expect(outcome).toBe('partial');
        expect(envelope.estimate).toBeNull();
        expect(envelope.fullScopeEstimate).toBeNull();
        const scope = envelope.analysis?.estimationScope;
        expect(scope?.selectedContractIds).toEqual(['decl:Flattened.sol:contract:374']);
        expect(scope?.contextContractIds).toHaveLength(2);
        expect(scope?.scopeNarrowed).toBe(true);
        expect(scope?.requestedScopeComplete).toBe(false);
        for (const value of [
          scope?.rawSourceLines,
          scope?.reviewSourceLines,
          scope?.reusedSourceLines,
          scope?.outOfScopeSourceLines,
        ]) {
          expect(value?.status).toBe('unavailable');
        }
        expect(
          envelope.diagnostics.some((item) => item.message.includes('could not be projected')),
        ).toBe(true);
        const inspect = await analyze(root, { command: 'inspect', estimationScope: TOKEN });
        expect(inspect.envelope.status).toBe('complete');
        expect(inspect.envelope.analysis?.estimationScope?.requestedScopeComplete).toBe(false);
      } finally {
        hooks.project = undefined;
      }
    });
  });

  it('turns an over-bound internal scope into a sanitized LIMIT_EXCEEDED error', async () => {
    await withProject({ 'Flattened.sol': FLATTENED }, async (root) => {
      hooks.resolve = (): never => {
        throw new ScopeLimitError();
      };
      try {
        const { envelope, outcome } = await analyze(root);
        expect(outcome).toBe('failure');
        expect(envelope.status).toBe('error');
        expect(envelope.diagnostics.map((item) => item.code)).toEqual(['LIMIT_EXCEEDED']);
        expect(envelope.analysis).toBeNull();
        expect(envelope.estimate).toBeNull();
      } finally {
        hooks.resolve = undefined;
      }
    });
  });
});
