import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/load.ts';
import { BudgetError, createDiscoveryBudget } from '../../src/discovery/budget.ts';
import type { DiscoveryBudget } from '../../src/discovery/budget.ts';
import { discoverScope } from '../../src/discovery/discover.ts';
import { IdentityRegistry } from '../../src/discovery/identity.ts';
import { readProjectMetadata } from '../../src/discovery/metadata.ts';
import type { SafeReadAdapter, SafeReadHandle } from '../../src/discovery/safe-read.ts';
import { resolveSafePath } from '../../src/discovery/safe-path.ts';
import type { DiscoveryDirectoryAdapter } from '../../src/discovery/scope.ts';
import { fileIdentity } from '../../src/domain/canonical.ts';
import { AnalysisSchema, IndicatorSchema } from '../../src/domain/schemas.ts';
import type {
  Analysis,
  AnalysisLimits,
  FileId,
  FileScopeEntry,
  Measurement,
  ScopeManifest,
  ScopeRole,
} from '../../src/domain/types.ts';
import { classifyIndicators } from '../../src/indicators/classify.ts';
import { collectReadiness } from '../../src/indicators/readiness.ts';
import type { ReadinessInput } from '../../src/indicators/readiness.ts';
import { buildFileMetrics } from '../../src/metrics/structural.ts';
import type { FileMetrics } from '../../src/metrics/structural.ts';
import { createParserSession } from '../../src/parser/adapter.ts';
import type { ParserSource } from '../../src/parser/protocol.ts';
import { resolveRelationships } from '../../src/relationships/closure.ts';
import {
  absoluteProjectPath,
  createProject,
  removeProject,
  safePathContext,
  testLimits,
  writeProjectFile,
} from '../helpers/filesystem.ts';
import { trustedDefaults } from '../helpers/parse-source.ts';
import fixtureManifest from '../fixtures/manifest.json' with { type: 'json' };

const A = fileIdentity('src/A.sol');
const B = fileIdentity('src/B.sol');
const C = fileIdentity('lib/C.sol');

function entry(fileId: FileId, path: string, role: ScopeRole): FileScopeEntry {
  return {
    fileId,
    path,
    role,
    ownership: 'first-party',
    ownershipEvidence: [],
    physicalIdentity: `fixture:${path}`,
    byteHash: createHash('sha256').update(path).digest('hex'),
  };
}

const MANIFEST: ScopeManifest = {
  entries: [
    entry(A, 'src/A.sol', 'scoped'),
    entry(B, 'src/B.sol', 'scoped'),
    entry(C, 'lib/C.sol', 'context'),
  ],
  scopedFileIds: [A, B],
  contextFileIds: [C],
  excludedFileIds: [],
};

function lines(value: number): Measurement<number> {
  return { status: 'measured', value, evidence: [] };
}

interface Overrides {
  readonly limits?: Partial<AnalysisLimits>;
  readonly signal?: AbortSignal;
  readonly lcovPath?: string | null;
  readonly testPath?: string | null;
  readonly followSymlinks?: boolean;
  readonly physicalLines?: ReadinessInput['physicalLines'];
  readonly aliases?: ReadinessInput['aliases'];
  readonly directoryAdapter?: DiscoveryDirectoryAdapter;
  readonly readAdapter?: SafeReadAdapter;
  readonly budget?: DiscoveryBudget;
  readonly target?: string;
}

async function makeInput(root: string, overrides: Overrides = {}): Promise<ReadinessInput> {
  const pathContext = await safePathContext(root, {
    followSymlinks: overrides.followSymlinks ?? false,
    ...(overrides.target === undefined ? {} : { target: overrides.target }),
  });
  return {
    pathContext,
    budget:
      overrides.budget ??
      createDiscoveryBudget(testLimits(overrides.limits ?? {}), overrides.signal),
    metadataPaths: { libs: [], test: overrides.testPath ?? null, script: null, out: null },
    coverage: { lcovPath: overrides.lcovPath ?? null },
    manifest: MANIFEST,
    physicalLines: overrides.physicalLines ?? [
      { fileId: A, physicalLines: lines(3) },
      { fileId: B, physicalLines: lines(10) },
    ],
    aliases: overrides.aliases ?? [],
    ...(overrides.directoryAdapter === undefined
      ? {}
      : { directoryAdapter: overrides.directoryAdapter }),
    ...(overrides.readAdapter === undefined ? {} : { readAdapter: overrides.readAdapter }),
  };
}

function trackingReadAdapter(opened: string[]): SafeReadAdapter {
  return {
    resolve: resolveSafePath,
    open: async (path, flags): Promise<SafeReadHandle> => {
      opened.push(path);
      const handle = await open(path, flags);
      return {
        stat: (options) => handle.stat(options),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: () => handle.close(),
      };
    },
  };
}

const VALID_LCOV =
  'TN:\nSF:src/A.sol\nDA:1,0\nDA:3,4\nLF:2\nLH:1\nend_of_record\nSF:lib/C.sol\nDA:1,7\nend_of_record\n';

describe('test directory presence', () => {
  it('proves presence and exact filename counts without opening bodies or running anything', async () => {
    const root = await createProject('audit-estimator-readiness-');
    try {
      const marker = absoluteProjectPath(root, 'marker.txt');
      const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`;
      await writeProjectFile(root, 'test/Vault.t.sol', 'contract VaultTest {}\n');
      await writeProjectFile(root, 'test/run.test.js', script);
      await writeProjectFile(root, 'test/nested/deep.spec.mts', 'export {};\n');
      await writeProjectFile(root, 'test/notes.md', 'not a test\n');
      await writeProjectFile(root, 'test/helper.ts', 'export {};\n');
      await writeProjectFile(root, 'test/node_modules/dep/ignored.test.js', script);
      await writeProjectFile(root, 'test/.git/hooks.test.js', script);
      await mkdir(absoluteProjectPath(root, 'test/empty'), { recursive: true });
      const opened: string[] = [];
      const result = await collectReadiness(
        await makeInput(root, { readAdapter: trackingReadAdapter(opened) }),
      );
      expect(result.testObservations).toEqual([
        { path: 'test', present: { status: 'measured', value: true, evidence: [] } },
        { path: 'tests', present: { status: 'measured', value: false, evidence: [] } },
      ]);
      expect(result.testRoots[0]).toMatchObject({
        path: 'test',
        status: 'directory',
        traversal: 'complete',
        testFiles: { exact: 3, observed: 3 },
        unrelatedFiles: 2,
        emptyDirectories: 1,
        prunedDirectories: 1,
        blockedEntries: 0,
      });
      expect(result.testRoots[1]).toEqual({ path: 'tests', status: 'missing' });
      expect(result.complete).toBe(true);
      expect(result.coverageObservation).toBeNull();
      expect(result.provenance).toBeNull();
      expect(opened).toEqual([]);
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.stringify(result)).not.toContain(root);
    } finally {
      await removeProject(root);
    }
  });

  it('probes only the validated metadata test path when one is supplied', async () => {
    const root = await createProject('audit-estimator-readiness-');
    try {
      await writeProjectFile(root, 'spec/A.t.sol', 'contract T {}\n');
      await writeProjectFile(root, 'test/B.t.sol', 'contract T {}\n');
      const result = await collectReadiness(await makeInput(root, { testPath: 'spec' }));
      expect(result.testObservations.map((item) => item.path)).toEqual(['spec']);
      expect(result.testRoots[0]).toMatchObject({ testFiles: { exact: 1, observed: 1 } });
    } finally {
      await removeProject(root);
    }
  });

  it('keeps absence, blocked and uninspected paths distinct', async (testContext) => {
    const root = await createProject('audit-estimator-readiness-');
    try {
      await writeProjectFile(root, 'test', 'a regular file\n');
      await mkdir(absoluteProjectPath(root, 'real-tests'), { recursive: true });
      try {
        await symlink(absoluteProjectPath(root, 'real-tests'), absoluteProjectPath(root, 'tests'));
      } catch {
        testContext.skip('symbolic links are not available on this host');
      }
      const result = await collectReadiness(await makeInput(root));
      expect(result.testObservations).toEqual([
        { path: 'test', present: { status: 'unavailable', reason: 'test-path-not-directory' } },
        { path: 'tests', present: { status: 'unavailable', reason: 'test-path-blocked' } },
      ]);
      expect(result.complete).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'PATH_BLOCKED', phase: 'discovery' }),
      );
      // Only a safely observed missing path is a measured false.
      const missing = await collectReadiness(await makeInput(root, { testPath: 'nowhere' }));
      expect(missing.testObservations).toEqual([
        { path: 'nowhere', present: { status: 'measured', value: false, evidence: [] } },
      ]);
    } finally {
      await removeProject(root);
    }
  });

  it('reports presence with a lower-bound count when enumeration stops at a limit', async () => {
    const root = await createProject('audit-estimator-readiness-');
    try {
      for (let index = 0; index < 20; index += 1) {
        await writeProjectFile(
          root,
          `test/T${String(index).padStart(2, '0')}.t.sol`,
          'contract T {}\n',
        );
      }
      const result = await collectReadiness(await makeInput(root, { limits: { maxFsEntries: 5 } }));
      expect(result.testObservations[0]).toEqual({
        path: 'test',
        present: { status: 'measured', value: true, evidence: [] },
      });
      expect(result.testRoots[0]).toMatchObject({
        status: 'directory',
        traversal: 'incomplete',
        stoppedBy: 'limit',
        testFiles: { exact: null, observed: 0 },
      });
      expect(result.complete).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'LIMIT_EXCEEDED', phase: 'discovery' }),
      );
      // The exhausted shared budget is not reset for the second default root.
      expect(result.testRoots[1]).toEqual({ path: 'tests', status: 'missing' });
    } finally {
      await removeProject(root);
    }
  });

  it('closes handles on read errors and labels the count incomplete', async () => {
    const root = await createProject('audit-estimator-readiness-');
    try {
      await writeProjectFile(root, 'test/A.t.sol', 'contract T {}\n');
      await writeProjectFile(root, 'test/sub/B.t.sol', 'contract T {}\n');
      let opens = 0;
      let closes = 0;
      const adapter: DiscoveryDirectoryAdapter = {
        opendir: async (path, options) => {
          const { opendir } = await import('node:fs/promises');
          const handle = await opendir(path, options);
          opens += 1;
          const failing = path.endsWith('sub');
          return {
            read: async () => {
              if (failing) throw new Error('simulated read failure');
              return handle.read();
            },
            close: async () => {
              closes += 1;
              await handle.close();
            },
          };
        },
      };
      const result = await collectReadiness(await makeInput(root, { directoryAdapter: adapter }));
      expect(opens).toBe(2);
      expect(closes).toBe(2);
      expect(result.testRoots[0]).toMatchObject({
        status: 'directory',
        traversal: 'incomplete',
        testFiles: { exact: null, observed: 1 },
        stoppedBy: 'read-error',
      });
      expect(result.testObservations[0]?.present).toMatchObject({
        status: 'measured',
        value: true,
      });
      expect(result.limitations.join(' ')).toContain('lower bounds');
      expect(JSON.stringify(result)).not.toContain('simulated');
    } finally {
      await removeProject(root);
    }
  });

  it('propagates cancellation during enumeration after closing handles', async () => {
    const root = await createProject('audit-estimator-readiness-');
    try {
      for (let index = 0; index < 8; index += 1) {
        await writeProjectFile(root, `test/T${index}.t.sol`, 'contract T {}\n');
      }
      const controller = new AbortController();
      let closes = 0;
      const adapter: DiscoveryDirectoryAdapter = {
        opendir: async (path, options) => {
          const { opendir } = await import('node:fs/promises');
          const handle = await opendir(path, options);
          let reads = 0;
          return {
            read: async () => {
              reads += 1;
              if (reads === 3) controller.abort();
              return handle.read();
            },
            close: async () => {
              closes += 1;
              await handle.close();
            },
          };
        },
      };
      await expect(
        collectReadiness(
          await makeInput(root, { directoryAdapter: adapter, signal: controller.signal }),
        ),
      ).rejects.toMatchObject({ kind: 'cancelled' });
      expect(closes).toBe(1);
    } finally {
      await removeProject(root);
    }
  });
});

describe('coverage projection', () => {
  it('matches the independent oracle: A covered 1 of 2, B absent, C context-only', async () => {
    const root = await createProject('audit-estimator-readiness-');
    try {
      await writeProjectFile(root, 'coverage/lcov.info', VALID_LCOV);
      const opened: string[] = [];
      const result = await collectReadiness(
        await makeInput(root, {
          lcovPath: 'coverage/lcov.info',
          readAdapter: trackingReadAdapter(opened),
        }),
      );
      expect(result.coverageObservation).toEqual({
        source: 'coverage/lcov.info',
        coveredLines: { status: 'measured', value: 1, evidence: [] },
        totalLines: { status: 'measured', value: 2, evidence: [] },
      });
      expect(result.coverageStatus).toEqual({ kind: 'matched-subset' });
      expect(result.coverageFiles).toEqual([
        { kind: 'matched', path: 'src/A.sol', fileId: A, coveredLines: 1, totalLines: 2 },
        { kind: 'context-record', path: 'lib/C.sol', fileId: C },
        { kind: 'absent-from-artifact', fileId: B },
      ]);
      expect(result.provenance).toBe('unverified-existing-artifact');
      expect(result.limitations.join(' ')).toContain('not generated or checked for freshness');
      expect(result.limitations.join(' ')).toContain(
        '1 matched scoped files, 1 unmatched artifact records (1 context), 1 scoped files absent',
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'PARTIAL_ANALYSIS', severity: 'info', phase: 'metrics' }),
      );
      expect(result.complete).toBe(true);
      // Only the configured artifact is opened: never an SF target or a test body.
      expect(opened).toEqual([join(await realRoot(root), 'coverage', 'lcov.info')]);
    } finally {
      await removeProject(root);
    }
  });

  it('reads a valid artifact above the metadata cap within the dedicated counter', async () => {
    const root = await createProject('audit-estimator-readiness-');
    try {
      const body = Array.from(
        { length: 40_000 },
        (_unused, index) => `DA:${index + 1},${index % 3}`,
      );
      const text = `SF:src/A.sol\n${body.join('\n')}\nend_of_record\n`;
      expect(Buffer.byteLength(text)).toBeGreaterThan(256 * 1024);
      await writeProjectFile(root, 'lcov.info', text);
      const budget = createDiscoveryBudget(testLimits());
      const result = await collectReadiness(
        await makeInput(root, {
          lcovPath: 'lcov.info',
          budget,
          physicalLines: [{ fileId: A, physicalLines: lines(40_000) }],
        }),
      );
      expect(result.coverageObservation).toMatchObject({
        totalLines: { status: 'measured', value: 40_000 },
        coveredLines: { status: 'measured', value: 26_666 },
      });
      expect(budget.counters.lcovBytes).toBe(Buffer.byteLength(text));
      expect(budget.counters.metadataBytes).toBe(0);
      expect(budget.counters.sourceBytes).toBe(0);
    } finally {
      await removeProject(root);
    }
  });

  it('treats an in-range but wrong artifact as unavailable, never as 0% coverage', async () => {
    const root = await createProject('audit-estimator-readiness-');
    try {
      await writeProjectFile(
        root,
        'lcov.info',
        'SF:src/A.sol\nDA:99,5\nend_of_record\nSF:src/Other.sol\nDA:1,1\nend_of_record\n',
      );
      const result = await collectReadiness(await makeInput(root, { lcovPath: 'lcov.info' }));
      expect(result.coverageObservation).toEqual({
        source: 'lcov.info',
        coveredLines: { status: 'unavailable', reason: 'no-matched-source' },
        totalLines: { status: 'unavailable', reason: 'no-matched-source' },
      });
      expect(result.coverageFiles).toEqual(
        expect.arrayContaining([
          { kind: 'excluded-record', path: 'src/A.sol', fileId: A, reason: 'line-mismatch' },
          { kind: 'unmatched-record', path: 'src/Other.sol' },
          { kind: 'absent-from-artifact', fileId: B },
        ]),
      );
      expect(result.provenance).toBe('unverified-existing-artifact');
      expect(result.complete).toBe(false);
    } finally {
      await removeProject(root);
    }
  });

  it('excludes files whose physical line count is unavailable without guessing a bound', async () => {
    const root = await createProject('audit-estimator-readiness-');
    try {
      await writeProjectFile(root, 'lcov.info', 'SF:src/A.sol\nDA:1,1\nend_of_record\n');
      const result = await collectReadiness(
        await makeInput(root, {
          lcovPath: 'lcov.info',
          physicalLines: [
            {
              fileId: A,
              physicalLines: { status: 'unavailable', reason: 'scoped-file-unavailable' },
            },
          ],
        }),
      );
      expect(result.coverageFiles).toContainEqual({
        kind: 'excluded-record',
        path: 'src/A.sol',
        fileId: A,
        reason: 'physical-lines-unavailable',
      });
      expect(result.coverageObservation?.totalLines).toMatchObject({ status: 'unavailable' });
    } finally {
      await removeProject(root);
    }
  });

  it('resolves an observed alias to one covered identity and rejects a doubled identity', async () => {
    const root = await createProject('audit-estimator-readiness-');
    try {
      const aliases = [{ fileId: A, path: 'alias/A.sol' }];
      await writeProjectFile(root, 'one.info', 'SF:alias/A.sol\nDA:1,1\nend_of_record\n');
      const single = await collectReadiness(
        await makeInput(root, { lcovPath: 'one.info', aliases }),
      );
      expect(single.coverageObservation).toMatchObject({
        coveredLines: { status: 'measured', value: 1 },
        totalLines: { status: 'measured', value: 1 },
      });
      const duplicate = await readFile(
        new URL('../fixtures/coverage/duplicate-alias.info', import.meta.url),
      );
      await writeProjectFile(root, 'two.info', duplicate);
      const doubled = await collectReadiness(
        await makeInput(root, { lcovPath: 'two.info', aliases }),
      );
      expect(doubled.coverageObservation).toEqual({
        source: 'two.info',
        coveredLines: { status: 'unavailable', reason: 'lcov-alias-collision' },
        totalLines: { status: 'unavailable', reason: 'lcov-alias-collision' },
      });
      expect(doubled.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'SEMANTICS_UNAVAILABLE', phase: 'metrics' }),
      );
    } finally {
      await removeProject(root);
    }
  });

  it('maps absent, blocked, oversized and malformed artifacts to fixed unavailable reasons', async (testContext) => {
    const root = await createProject('audit-estimator-readiness-');
    try {
      const missing = await collectReadiness(await makeInput(root, { lcovPath: 'missing.info' }));
      expect(missing.coverageObservation).toEqual({
        source: 'missing.info',
        coveredLines: { status: 'unavailable', reason: 'coverage-missing' },
        totalLines: { status: 'unavailable', reason: 'coverage-missing' },
      });
      expect(missing.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'TARGET_UNREADABLE', phase: 'discovery' }),
      );
      expect(missing.provenance).toBeNull();

      await writeProjectFile(
        root,
        'big.info',
        `SF:src/A.sol\n${'DA:1,1\n'.repeat(20)}end_of_record\n`,
      );
      const oversized = await collectReadiness(
        await makeInput(root, { lcovPath: 'big.info', limits: { maxLcovBytes: 16 } }),
      );
      expect(oversized.coverageObservation?.totalLines).toEqual({
        status: 'unavailable',
        reason: 'coverage-oversized',
      });
      expect(oversized.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'LIMIT_EXCEEDED', phase: 'discovery' }),
      );

      const malformed = await readFile(
        new URL('../fixtures/coverage/malformed.info', import.meta.url),
      );
      await writeProjectFile(root, 'bad.info', malformed);
      const bad = await collectReadiness(await makeInput(root, { lcovPath: 'bad.info' }));
      expect(bad.coverageObservation).toEqual({
        source: 'bad.info',
        coveredLines: { status: 'unavailable', reason: 'lcov-duplicate-line' },
        totalLines: { status: 'unavailable', reason: 'lcov-duplicate-line' },
      });
      expect(bad.provenance).toBe('unverified-existing-artifact');
      expect(bad.complete).toBe(false);

      await writeProjectFile(root, 'outside.info', 'SF:../outside.sol\nDA:1,1\nend_of_record\n');
      const outside = await collectReadiness(await makeInput(root, { lcovPath: 'outside.info' }));
      expect(outside.coverageObservation?.totalLines).toEqual({
        status: 'unavailable',
        reason: 'lcov-outside-root',
      });

      try {
        await symlink(
          absoluteProjectPath(root, 'bad.info'),
          absoluteProjectPath(root, 'link.info'),
        );
        const linked = await collectReadiness(
          await makeInput(root, { lcovPath: 'link.info', followSymlinks: true }),
        );
        expect(linked.coverageObservation?.totalLines).toEqual({
          status: 'unavailable',
          reason: 'coverage-blocked',
        });
        expect(linked.diagnostics).toContainEqual(
          expect.objectContaining({ code: 'PATH_BLOCKED' }),
        );
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
          testContext.skip('symbolic links are not available on this host');
        } else {
          throw error;
        }
      }
    } finally {
      await removeProject(root);
    }
  });

  it('reads a report beside a literal target and leaves required flags untouched', async () => {
    const root = await createProject('audit-estimator-readiness-');
    try {
      await writeProjectFile(root, 'src/A.sol', 'contract A {}\n');
      await writeProjectFile(root, 'src/lcov.info', VALID_LCOV);
      const result = await collectReadiness(
        await makeInput(root, {
          lcovPath: 'src/lcov.info',
          target: absoluteProjectPath(root, 'src/A.sol'),
        }),
      );
      expect(result.coverageStatus).toEqual({ kind: 'matched-subset' });
      expect(Object.keys(result).sort()).toEqual([
        'complete',
        'coverageFiles',
        'coverageObservation',
        'coverageStatus',
        'diagnostics',
        'limitations',
        'provenance',
        'testObservations',
        'testRoots',
      ]);
    } finally {
      await removeProject(root);
    }
  });

  it('observes cancellation and deadlines between LCOV parsing batches', async () => {
    const root = await createProject('audit-estimator-readiness-');
    try {
      const body = Array.from({ length: 2_000 }, (_unused, index) => `DA:${index + 1},1`);
      await writeProjectFile(
        root,
        'lcov.info',
        `SF:src/A.sol\n${body.join('\n')}\nend_of_record\n`,
      );
      const physicalLines = [{ fileId: A, physicalLines: lines(2_000) }];

      const controller = new AbortController();
      const cancelled = await makeInput(root, {
        lcovPath: 'lcov.info',
        signal: controller.signal,
        physicalLines,
      });
      const checkpoint = cancelled.budget.checkpoint.bind(cancelled.budget);
      let forced = 0;
      cancelled.budget.checkpoint = async (forceYield?: boolean) => {
        if (forceYield === true) {
          forced += 1;
          if (forced === 3) controller.abort();
        }
        await checkpoint(forceYield);
      };
      await expect(collectReadiness(cancelled)).rejects.toMatchObject({ kind: 'cancelled' });
      expect(forced).toBe(3);

      const timed = await makeInput(root, { lcovPath: 'lcov.info', physicalLines });
      const timedCheckpoint = timed.budget.checkpoint.bind(timed.budget);
      let calls = 0;
      timed.budget.checkpoint = async (forceYield?: boolean) => {
        if (forceYield === true) {
          calls += 1;
          if (calls === 2) timed.budget.tightenDeadline(performance.now() - 1);
        }
        await timedCheckpoint(forceYield);
      };
      const failure = await collectReadiness(timed).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(BudgetError);
      expect(failure).toMatchObject({ kind: 'deadline' });
    } finally {
      await removeProject(root);
    }
  });
});

async function realRoot(root: string): Promise<string> {
  const context = await safePathContext(root);
  return context.root;
}

describe('public projections', () => {
  it('validates readiness and indicator output inside a complete analysis fixture', async () => {
    const root = await createProject('audit-estimator-readiness-');
    try {
      await writeProjectFile(root, 'test/A.t.sol', 'contract T {}\n');
      await writeProjectFile(root, 'lcov.info', VALID_LCOV);
      const result = await collectReadiness(await makeInput(root, { lcovPath: 'lcov.info' }));
      const classification = classifyIndicators({
        manifest: MANIFEST,
        syntax: { files: [], diagnostics: [], complete: true, visitedNodes: 0, processedBytes: 0 },
        metrics: [],
        relationships: {
          imports: [],
          components: [],
          directBaseEdges: [],
          inheritance: [],
          callSites: [],
          confirmedBuiltinLowLevelCalls: [],
          requiredAnalysisComplete: true,
          hasUnknownSemantics: false,
        },
      });
      const fixture = JSON.parse(
        await readFile(new URL('../fixtures/domain/complete.json', import.meta.url), 'utf8'),
      ) as { analysis: Analysis };
      const analysis = {
        ...fixture.analysis,
        indicators: [...classification.indicators],
        testObservations: [...result.testObservations],
        coverageObservation: result.coverageObservation,
      };
      // Eight prompts plus one unassessed row for each manifest file without syntax records.
      expect(AnalysisSchema.parse(analysis).indicators).toHaveLength(11);
      for (const observation of [
        null,
        {
          source: 'lcov.info',
          coveredLines: { status: 'unavailable', reason: 'x' },
          totalLines: { status: 'unavailable', reason: 'x' },
        },
      ]) {
        expect(
          AnalysisSchema.safeParse({ ...analysis, coverageObservation: observation }).success,
        ).toBe(true);
      }
      for (const row of classification.indicators) expect(IndicatorSchema.parse(row)).toEqual(row);
    } finally {
      await removeProject(root);
    }
  });
});

describe('committed readiness fixtures', () => {
  it('matches the independent byte and line counts and parses as documented', async () => {
    const { parseLcovBatches } = await import('../../src/indicators/lcov.ts');
    expect(fixtureManifest.readinessFixtures.map((item) => item.file)).toEqual([
      'coverage/valid.info',
      'coverage/duplicate-alias.info',
      'coverage/malformed.info',
    ]);
    for (const fixture of fixtureManifest.readinessFixtures) {
      const bytes = await readFile(new URL(`../fixtures/${fixture.file}`, import.meta.url));
      const text = bytes.toString('utf8');
      expect(fixture.origin).toBe('original');
      expect(fixture.license).toBe('MIT (proposed)');
      expect(bytes.byteLength).toBe(fixture.physicalBytes);
      expect(text.split('\n').length - 1).toBe(fixture.physicalLines);
      expect(text.match(/^end_of_record$/gmu)?.length).toBe(fixture.records);
    }
    const targets = [
      { fileId: A, role: 'scoped' as const, paths: ['src/A.sol'], physicalLines: lines(3) },
      { fileId: B, role: 'scoped' as const, paths: ['src/B.sol'], physicalLines: lines(10) },
      { fileId: C, role: 'context' as const, paths: ['lib/C.sol'], physicalLines: lines(5) },
    ];
    const drain = async (name: string, extra: typeof targets) => {
      const bytes = await readFile(new URL(`../fixtures/coverage/${name}`, import.meta.url));
      const generator = parseLcovBatches(bytes, {
        byteLimit: 1024 * 1024,
        roots: [],
        targets: extra,
      });
      for (;;) {
        const next = generator.next();
        if (next.done === true) return next.value;
      }
    };
    expect(await drain('valid.info', targets)).toMatchObject({
      status: 'parsed',
      coveredLines: 1,
      totalLines: 2,
      absentScopedFileIds: [B],
    });
    expect(await drain('malformed.info', targets)).toEqual({
      status: 'unavailable',
      reason: 'duplicate-line',
    });
    expect(
      await drain('duplicate-alias.info', [
        { ...targets[0], paths: ['src/A.sol', 'alias/A.sol'] } as (typeof targets)[number],
        ...targets.slice(1),
      ]),
    ).toEqual({ status: 'unavailable', reason: 'alias-collision' });
  });
});

describe('native catalog fixtures', () => {
  interface Harness {
    readonly analysis: Awaited<ReturnType<typeof resolveRelationships>>;
  }

  async function withNative<T>(
    files: Readonly<Record<string, string>>,
    body: (harness: Harness) => Promise<T>,
  ): Promise<T> {
    const root = await createProject('audit-estimator-native-');
    let session: ReturnType<typeof createParserSession> | undefined;
    try {
      for (const [path, contents] of Object.entries(files)) {
        await writeProjectFile(root, path, contents);
      }
      const defaults = trustedDefaults(testLimits());
      const operational = await resolveConfig({ root, defaults });
      const budget = createDiscoveryBudget(operational.config.analysis.limits);
      const rootContext = await safePathContext(root);
      const metadata = await readProjectMetadata({ pathContext: rootContext, budget });
      const resolved = await resolveConfig({ root, defaults, metadata: metadata.hints });
      budget.assertLimitsMatch(resolved.config.analysis.limits);
      const targetAbsolute = absoluteProjectPath(root, '.');
      const pathContext = await safePathContext(root, {
        target: targetAbsolute,
        followSymlinks: resolved.config.scope.followSymlinks,
      });
      const target = await resolveSafePath({ ...pathContext, budget }, targetAbsolute);
      const identities = new IdentityRegistry();
      const discovery = await discoverScope({
        root: pathContext.root,
        lexicalRoot: pathContext.lexicalRoot,
        target,
        lexicalTarget: targetAbsolute,
        config: resolved.config,
        metadata,
        budget,
        identities,
      });
      session = createParserSession({ budget, config: resolved.config });
      const sources: ParserSource[] = discovery.snapshots.map((snapshot) => {
        const fileId = fileIdentity(snapshot.canonicalPath);
        const manifestEntry = discovery.manifest.entries.find((item) => item.fileId === fileId);
        if (manifestEntry === undefined) throw new Error('Missing manifest entry.');
        return { fileId, snapshot, manifestEntry };
      });
      const initialSyntax = await session.analyzeSources(sources);
      const analysis = await resolveRelationships({
        discovery,
        pathContext,
        identities,
        budget,
        config: resolved.config,
        metadata,
        session,
        initialSyntax,
      });
      return await body({ analysis });
    } finally {
      await session?.close();
      await removeProject(root);
    }
  }

  function classifyNative(analysis: Harness['analysis']) {
    const metrics: FileMetrics[] = [];
    for (const source of analysis.sources) {
      const result = analysis.syntax.files.find((item) => item.fileId === source.fileId);
      if (result !== undefined) metrics.push(buildFileMetrics(source, result));
    }
    return classifyIndicators({
      manifest: analysis.manifest,
      syntax: analysis.syntax,
      metrics,
      relationships: analysis,
    });
  }

  it('classifies a real parsed project with exact measured and heuristic rows', async () => {
    const text = await readFile(
      new URL('../fixtures/indicators/Catalog.sol', import.meta.url),
      'utf8',
    );
    await withNative({ 'src/Catalog.sol': text }, async ({ analysis }) => {
      expect(analysis.requiredAnalysisComplete).toBe(true);
      const result = classifyNative(analysis);
      expect(result.complete).toBe(true);
      const kinds = new Map<string, number>();
      for (const row of result.indicators) {
        const rule = row.id.split(':')[1] ?? '';
        kinds.set(rule, (kinds.get(rule) ?? 0) + 1);
        expect(IndicatorSchema.parse(row)).toEqual(row);
      }
      expect(Object.fromEntries(kinds)).toEqual({
        assembly: 1,
        'builtin-low-level': 1,
        'complex-storage-syntax': 1,
        'external-boundary-candidate': 1,
        'file-evidence-incomplete': 1,
        loops: 2,
        'privilege-name-candidate': 2,
        prompt: 8,
        'upgrade-name-candidate': 1,
      });
      const builtin = result.indicators.find((row) =>
        row.id.startsWith('indicator:builtin-low-level:'),
      );
      // Only the delegatecall on an address parameter is confirmed; Token.transfer is rejected.
      expect(builtin?.evidence).toHaveLength(1);
      const text = JSON.stringify(builtin);
      expect(text).toContain('"startByte"');
      const uncertainty = result.indicators.find((row) =>
        row.id.startsWith('indicator:file-evidence-incomplete:'),
      );
      // Position and Token are user-defined mutable storage and stay unresolved.
      expect(uncertainty?.evidence).toHaveLength(3);
      expect(uncertainty?.limitations.join(' ')).toContain('user-defined or unknown types');
    });
  });

  it('reports a failed import as measured uncertainty and loses semantic rows honestly', async () => {
    const text = await readFile(
      new URL('../fixtures/indicators/Unresolved.sol', import.meta.url),
      'utf8',
    );
    await withNative({ 'src/Unresolved.sol': text }, async ({ analysis }) => {
      expect(analysis.requiredAnalysisComplete).toBe(false);
      const result = classifyNative(analysis);
      const rules = result.indicators.map((row) => row.id.split(':')[1]);
      expect(rules).toContain('unresolved-import');
      expect(rules).toContain('file-evidence-incomplete');
      expect(result.requiredAnalysisComplete).toBe(false);
    });
  });
});
