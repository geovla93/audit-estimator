import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cp, link, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AnalyzeRequest } from '../../src/index.ts';
import type { ReportEnvelope } from '../../src/domain/types.ts';
import type { ParserSessionOptions } from '../../src/parser/adapter.ts';
import { createProject, removeProject, writeProjectFile } from '../helpers/filesystem.ts';
import { staggerStart } from '../helpers/run-cli.ts';

const hooks = vi.hoisted(() => ({
  factory: undefined as undefined | ((options: unknown) => unknown),
}));

vi.mock('../../src/estimation/estimate.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/estimation/estimate.ts')>();
  return { ...actual, estimateEffort: vi.fn<typeof actual.estimateEffort>(actual.estimateEffort) };
});

vi.mock('../../src/parser/adapter.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/parser/adapter.ts')>();
  return {
    ...actual,
    createParserSession: (options: ParserSessionOptions) =>
      hooks.factory === undefined
        ? actual.createParserSession(options)
        : (hooks.factory(options) as ReturnType<typeof actual.createParserSession>),
  };
});

const repositoryRoot = resolve(new URL('../../', import.meta.url).pathname);
const helperPath = resolve(repositoryRoot, '.vitest/application/parser-child.mjs');
const SOL = '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n';

function contractSource(name: string, imports: readonly string[] = []): string {
  return `${SOL}${imports.map((item) => `import "${item}";\n`).join('')}contract ${name} {\n    uint256 public value;\n\n    function set(uint256 next) external {\n        value = next;\n    }\n}\n`;
}

const BROKEN = `${SOL}contract Broken {\n    function oops( external {\n`;

async function withProject<T>(
  files: Readonly<Record<string, string>>,
  body: (root: string) => Promise<T>,
): Promise<T> {
  const root = await createProject('audit-estimator-application-');
  try {
    for (const [path, contents] of Object.entries(files)) {
      await writeProjectFile(root, path, contents);
    }
    return await body(root);
  } finally {
    await removeProject(root);
  }
}

function request(root: string, overrides: Partial<AnalyzeRequest> = {}): AnalyzeRequest {
  return { command: 'estimate', input: root, noConfig: false, allowPartial: false, ...overrides };
}

async function analyze(
  root: string,
  overrides: Partial<AnalyzeRequest> = {},
): Promise<Awaited<ReturnType<typeof analyzeProject>>> {
  const outcome = await analyzeProject(request(root, overrides));
  ReportEnvelopeSchema.parse(outcome.envelope);
  return outcome;
}

function configFile(body: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ configVersion: '1.0.0', ...body });
}

// The analysis graph is loaded lazily, after the staggered start (see staggerStart).
let analyzeProject: typeof import('../../src/index.ts').analyzeProject;
let buildErrorEnvelope: typeof import('../../src/application/envelope.ts').buildErrorEnvelope;
let fixedDiagnostic: typeof import('../../src/application/envelope.ts').fixedDiagnostic;
let ReportEnvelopeSchema: typeof import('../../src/domain/schemas.ts').ReportEnvelopeSchema;
let estimateEffort: typeof import('../../src/estimation/estimate.ts').estimateEffort;
let serializeJson: typeof import('../../src/reporting/json.ts').serializeJson;

beforeAll(async () => {
  await staggerStart();
  ({ analyzeProject } = await import('../../src/index.ts'));
  ({ buildErrorEnvelope, fixedDiagnostic } = await import('../../src/application/envelope.ts'));
  ({ ReportEnvelopeSchema } = await import('../../src/domain/schemas.ts'));
  ({ estimateEffort } = await import('../../src/estimation/estimate.ts'));
  ({ serializeJson } = await import('../../src/reporting/json.ts'));
}, 120_000);

describe('phases and completeness', () => {
  it('produces a complete full-scope estimate for a simple project', async () => {
    await withProject({ 'src/Vault.sol': contractSource('Vault') }, async (root) => {
      const { envelope, outcome } = await analyze(root);
      expect(outcome).toBe('complete');
      expect(envelope.status).toBe('complete');
      expect(envelope.failureCategory).toBeNull();
      expect(envelope.analysis?.completeness.requiredAnalysisComplete).toBe(true);
      expect(envelope.estimate?.coverage).toBe('full');
      expect(envelope.fullScopeEstimate).toEqual(envelope.estimate);
      expect(envelope.analysis?.completeness.analyzedFileIds).toEqual(['file:src/Vault.sol']);
      expect(envelope.analysis?.completeness.unavailableFileIds).toEqual([]);
      expect(envelope.versions.parser).toMatch(/^slang@\d+\.\d+\.\d+$/);
    });
  });

  it('reports a malformed scoped file as partial and bills no AST metrics for it', async () => {
    const files = { 'src/Good.sol': contractSource('Good'), 'src/Broken.sol': BROKEN };
    await withProject(files, async (root) => {
      const { envelope, outcome } = await analyze(root);
      expect(outcome).toBe('partial');
      expect(envelope.status).toBe('partial');
      expect(envelope.estimate).toBeNull();
      expect(envelope.fullScopeEstimate).toBeNull();
      expect(envelope.analysis?.completeness.requiredAnalysisComplete).toBe(false);
      expect(envelope.analysis?.completeness.unavailableFileIds).toContain('file:src/Broken.sol');
      const broken = envelope.analysis?.files.find((file) => file.fileId === 'file:src/Broken.sol');
      expect(broken?.syntaxComplete).toBe(false);
      expect(broken?.sourceLines.status).toBe('unavailable');
      expect(broken?.physicalLines.status).toBe('measured');
      expect(envelope.analysis?.contracts.map((item) => item.name)).toEqual(['Good']);
      expect(envelope.analysis?.aggregates.sourceLines.status).toBe('unavailable');
    });
  });

  it('reports a missing required context import as partial', async () => {
    const files = { 'src/Main.sol': contractSource('Main', ['../lib/Missing.sol']) };
    await withProject(files, async (root) => {
      const { envelope } = await analyze(root);
      expect(envelope.status).toBe('partial');
      expect(envelope.estimate).toBeNull();
      expect(envelope.diagnostics.map((item) => item.code)).toContain('IMPORT_UNRESOLVED');
      expect(envelope.analysis?.completeness.requiredAnalysisComplete).toBe(false);
    });
  });

  it('bills only the analyzed subset under --allow-partial and keeps fullScopeEstimate null', async () => {
    const files = { 'src/Good.sol': contractSource('Good'), 'src/Broken.sol': BROKEN };
    await withProject(files, async (root) => {
      const { envelope, outcome } = await analyze(root, { allowPartial: true });
      expect(outcome).toBe('partial');
      expect(envelope.status).toBe('partial');
      expect(envelope.estimate?.coverage).toBe('analyzed-subset');
      expect(envelope.fullScopeEstimate).toBeNull();
      const baselines = envelope.estimate?.contributions.filter(
        (item) => item.category === 'baseline',
      );
      expect(baselines).toHaveLength(1);
    });
  });

  it('keeps full coverage for complete input even with allowPartial', async () => {
    await withProject({ 'src/Vault.sol': contractSource('Vault') }, async (root) => {
      const strict = await analyze(root);
      const lenient = await analyze(root, { allowPartial: true });
      expect(lenient.envelope.estimate?.coverage).toBe('full');
      expect(lenient.envelope.fullScopeEstimate).toEqual(lenient.envelope.estimate);
      expect(lenient.envelope.estimate).toEqual(strict.envelope.estimate);
    });
  });

  it('never calls the engine for inspect', async () => {
    await withProject({ 'src/Vault.sol': contractSource('Vault') }, async (root) => {
      vi.mocked(estimateEffort).mockClear();
      const { envelope, outcome } = await analyze(root, { command: 'inspect' });
      expect(estimateEffort).not.toHaveBeenCalled();
      expect(outcome).toBe('complete');
      expect(envelope.status).toBe('complete');
      expect(envelope.estimate).toBeNull();
      expect(envelope.fullScopeEstimate).toBeNull();
    });
  });

  it('marks inspect partial when required analysis is incomplete', async () => {
    const files = { 'src/Good.sol': contractSource('Good'), 'src/Broken.sol': BROKEN };
    await withProject(files, async (root) => {
      const { envelope, outcome } = await analyze(root, { command: 'inspect' });
      expect(outcome).toBe('partial');
      expect(envelope.status).toBe('partial');
      expect(envelope.estimate).toBeNull();
    });
  });

  it('maps comment-only and Solidity-free scopes to EMPTY_SCOPE', async () => {
    await withProject({ 'src/Empty.sol': '// only a comment\n/* nothing */\n' }, async (root) => {
      const { envelope, outcome } = await analyze(root);
      expect(outcome).toBe('failure');
      expect(envelope.status).toBe('error');
      expect(envelope.failureCategory).toBe('target');
      expect(envelope.diagnostics.map((item) => item.code)).toContain('EMPTY_SCOPE');
      expect(envelope.analysis).toBeNull();
    });
    await withProject({ 'README.md': 'no Solidity here\n' }, async (root) => {
      const { envelope } = await analyze(root);
      expect(envelope.failureCategory).toBe('target');
      expect(envelope.diagnostics.map((item) => item.code)).toContain('EMPTY_SCOPE');
    });
  });

  it('honors configured limits both below and above the defaults', async () => {
    const two = { 'src/A.sol': contractSource('A'), 'src/B.sol': contractSource('B') };
    await withProject(
      {
        ...two,
        'audit-estimator.config.json': configFile({ analysis: { limits: { maxFiles: 1 } } }),
      },
      async (root) => {
        const { envelope, outcome } = await analyze(root);
        // Discovery reports a reached limit as an incomplete scope rather than throwing.
        expect(outcome).toBe('partial');
        expect(envelope.status).toBe('partial');
        expect(envelope.estimate).toBeNull();
        expect(envelope.diagnostics.map((item) => item.code)).toContain('LIMIT_EXCEEDED');
      },
    );
    // The default directory depth is 64; 66 nested directories only analyze with a raised limit.
    const deep = `src/${Array.from({ length: 66 }, (_, index) => `d${index}`).join('/')}/Deep.sol`;
    await withProject({ [deep]: contractSource('Deep') }, async (root) => {
      const { envelope } = await analyze(root);
      expect(envelope.analysis?.completeness.analyzedFileIds ?? []).toEqual([]);
    });
    await withProject(
      {
        [deep]: contractSource('Deep'),
        'audit-estimator.config.json': configFile({
          analysis: { limits: { maxDirectoryDepth: 200 } },
        }),
      },
      async (root) => {
        const { envelope } = await analyze(root);
        expect(envelope.status).toBe('complete');
        expect(envelope.analysis?.completeness.analyzedFileIds).toEqual([`file:${deep}`]);
      },
    );
  });

  it('keeps an ownership-invalidated file in the omissions', async () => {
    const files = {
      'src/Shared.sol': contractSource('Shared'),
      'src/Main.sol': contractSource('Main', ['../lib/Shared.sol']),
      'audit-estimator.config.json': configFile({ scope: { sourceRoots: ['src'] } }),
    };
    await withProject(files, async (root) => {
      await mkdir(join(root, 'lib'), { recursive: true });
      try {
        await link(join(root, 'src/Shared.sol'), join(root, 'lib/Shared.sol'));
      } catch {
        // Hardlinks are a platform capability; without them there is no alias to observe.
        return;
      }
      const { envelope } = await analyze(root, { allowPartial: true });
      expect(envelope.status).toBe('partial');
      expect(envelope.analysis?.completeness.unavailableFileIds).toContain('file:src/Shared.sol');
      expect(envelope.analysis?.completeness.analyzedFileIds).toEqual(['file:src/Main.sol']);
      expect(envelope.fullScopeEstimate).toBeNull();
      expect(
        envelope.estimate?.contributions.filter((item) => item.category === 'baseline'),
      ).toHaveLength(1);
    });
  });

  it('maps manual adjustments that drive the total negative to a config error', async () => {
    // Finding: the config validator checks adjustments only one by one, so the engine's
    // `invalid-total` reason is reachable from valid-looking configuration.
    const files = {
      'src/Vault.sol': contractSource('Vault'),
      'audit-estimator.config.json': configFile({
        manualAdjustments: [
          {
            id: 'discount',
            reason: 'Excessive discount for the test',
            category: 'manual',
            lowHours: -100000,
            highHours: -100000,
          },
        ],
      }),
    };
    await withProject(files, async (root) => {
      const { envelope, outcome } = await analyze(root);
      expect(outcome).toBe('failure');
      expect(envelope.status).toBe('error');
      expect(envelope.failureCategory).toBe('config');
      expect(envelope.diagnostics).toEqual([
        expect.objectContaining({ code: 'CONFIG_INVALID', phase: 'estimate' }),
      ]);
    });
  });

  it('maps an invalid configuration file to a config error', async () => {
    await withProject(
      { 'src/Vault.sol': contractSource('Vault'), 'audit-estimator.config.json': '{ nope' },
      async (root) => {
        const { envelope, outcome } = await analyze(root);
        expect(outcome).toBe('failure');
        expect(envelope.failureCategory).toBe('config');
        expect(envelope.fingerprints.semanticConfig).toBeNull();
      },
    );
  });

  it('maps a nonexistent input to a target error', async () => {
    await withProject({}, async (root) => {
      const { envelope } = await analyze(root, { input: join(root, 'missing') });
      expect(envelope.failureCategory).toBe('target');
      expect(envelope.diagnostics.map((item) => item.code)).toEqual(['TARGET_UNREADABLE']);
    });
  });
});

describe('determinism and api', () => {
  const files = {
    'src/Token.sol': contractSource('Token'),
    'src/Vault.sol': contractSource('Vault', ['./Token.sol']),
  };

  it('exports analyzeProject from the library entry', () => {
    expect(typeof analyzeProject).toBe('function');
  });

  it('is byte-identical across runs and project locations', async () => {
    await withProject(files, async (root) => {
      const first = serializeJson((await analyze(root)).envelope);
      const second = serializeJson((await analyze(root)).envelope);
      expect(second).toBe(first);
      const copy = await createProject('audit-estimator-application-copy-');
      try {
        await cp(root, copy, { recursive: true });
        expect(serializeJson((await analyze(copy)).envelope)).toBe(first);
      } finally {
        await removeProject(copy);
      }
      expect(first).not.toContain(root);
      expect(first).not.toContain(await realpath(root));
    });
  });

  it('is independent of file creation order', async () => {
    const forward = await withProject(files, async (root) =>
      serializeJson((await analyze(root)).envelope),
    );
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    const backward = await withProject(reversed, async (root) =>
      serializeJson((await analyze(root)).envelope),
    );
    expect(backward).toBe(forward);
  });

  it('keeps the analysis and semantic hash independent of the report format', async () => {
    await withProject(files, async (root) => {
      const json = (await analyze(root, { format: 'json' })).envelope;
      const markdown = (await analyze(root, { format: 'markdown' })).envelope;
      expect(markdown.fingerprints.semanticConfig).toBe(json.fingerprints.semanticConfig);
      expect(markdown.fingerprints.analysis).toBe(json.fingerprints.analysis);
      expect(markdown.analysis).toEqual(json.analysis);
      expect(markdown.estimate).toEqual(json.estimate);
      const reported = await analyze(root, { format: 'markdown' });
      expect(reported.reportFormat).toBe('markdown');
    });
  });

  it('lets coverage configuration change the semantic hash but never the estimate', async () => {
    await withProject(files, async (root) => {
      const base = (await analyze(root)).envelope;
      await writeFile(
        join(root, 'audit-estimator.config.json'),
        configFile({ coverage: { lcovPath: 'missing.info' } }),
      );
      const covered = (await analyze(root)).envelope;
      expect(covered.fingerprints.semanticConfig).not.toBe(base.fingerprints.semanticConfig);
      expect(covered.estimate).toEqual(base.estimate);
      expect(covered.fullScopeEstimate).toEqual(base.fullScopeEstimate);
    });
  });

  it('validates every error envelope shape', async () => {
    const identity = { command: 'estimate', parser: 'slang@1.3.9', semanticConfig: null } as const;
    const envelopes: ReportEnvelope[] = [
      buildErrorEnvelope({
        identity,
        category: 'output',
        diagnostics: [
          fixedDiagnostic(
            'OUTPUT_FAILED',
            'error',
            'report',
            'The report file could not be written.',
          ),
        ],
      }),
      buildErrorEnvelope({
        identity,
        category: 'internal',
        diagnostics: [
          fixedDiagnostic(
            'INTERNAL_ERROR',
            'error',
            'estimate',
            'Estimation input was inconsistent.',
          ),
        ],
      }),
      buildErrorEnvelope({
        identity,
        category: 'analysis',
        diagnostics: [
          fixedDiagnostic('PARTIAL_ANALYSIS', 'error', 'parse', 'Analysis was interrupted.'),
        ],
      }),
    ];
    await withProject({ 'src/Empty.sol': '// nothing\n' }, async (root) => {
      envelopes.push((await analyze(root)).envelope);
      envelopes.push((await analyze(root, { input: join(root, 'missing') })).envelope);
    });
    for (const envelope of envelopes) {
      expect(envelope.status).toBe('error');
      ReportEnvelopeSchema.parse(envelope);
      expect(serializeJson(envelope).endsWith('\n')).toBe(true);
    }
  });
});

describe('cancellation', () => {
  beforeAll(() => {
    execFileSync(
      'pnpm',
      [
        'exec',
        'tsdown',
        'test/helpers/parser-child.ts',
        '--out-dir',
        '.vitest/application',
        '--no-config',
        '--format',
        'esm',
        '--deps.never-bundle',
        '@nomicfoundation/slang',
      ],
      { cwd: repositoryRoot, stdio: 'pipe' },
    );
  });

  it('interrupts a stalled parser, closes the session and leaves no child behind', async () => {
    const adapter = await vi.importActual<typeof import('../../src/parser/adapter.ts')>(
      '../../src/parser/adapter.ts',
    );
    const controller = new AbortController();
    let child: ChildProcessWithoutNullStreams | undefined;
    let closed = 0;
    let stalled: () => void = () => undefined;
    const reachedStall = new Promise<void>((resolveStall) => {
      stalled = resolveStall;
    });
    hooks.factory = (options: unknown) => {
      const session = adapter.createParserSessionForTests(options as ParserSessionOptions, () => {
        const started = spawn(process.execPath, [helperPath, 'fake-worker', 'stall-request'], {
          env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        child = started;
        let buffered = '';
        started.stderr.on('data', (chunk: Buffer) => {
          buffered += chunk.toString('utf8');
          if (buffered.includes('stage:request\n')) stalled();
        });
        return started;
      });
      const close = session.close.bind(session);
      session.close = async () => {
        closed += 1;
        await close();
      };
      return session;
    };
    try {
      await withProject({ 'src/Vault.sol': contractSource('Vault') }, async (root) => {
        const pending = analyzeProject(request(root, { format: 'json' }), {
          signal: controller.signal,
        });
        await reachedStall;
        controller.abort();
        const { envelope, outcome } = await pending;
        expect(outcome).toBe('interrupted');
        expect(envelope.status).toBe('error');
        expect(envelope.failureCategory).toBe('analysis');
        expect(envelope.diagnostics).toEqual([
          expect.objectContaining({
            code: 'PARTIAL_ANALYSIS',
            severity: 'error',
            message: 'Analysis was interrupted.',
          }),
        ]);
        ReportEnvelopeSchema.parse(envelope);
      });
      expect(closed).toBeGreaterThanOrEqual(1);
      const started = child;
      if (started === undefined) throw new Error('The stalled worker was never started.');
      if (started.exitCode === null && started.signalCode === null) {
        await new Promise<void>((resolveClose) => started.once('close', () => resolveClose()));
      }
      expect(started.exitCode !== null || started.signalCode !== null).toBe(true);
    } finally {
      hooks.factory = undefined;
    }
  });
});
