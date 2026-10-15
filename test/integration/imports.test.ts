import { link, mkdir, symlink } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/load.ts';
import { createDiscoveryBudget, BudgetError } from '../../src/discovery/budget.ts';
import { discoverScope } from '../../src/discovery/discover.ts';
import { IdentityRegistry } from '../../src/discovery/identity.ts';
import { readProjectMetadata } from '../../src/discovery/metadata.ts';
import { resolveSafePath } from '../../src/discovery/safe-path.ts';
import { fileIdentity } from '../../src/domain/canonical.ts';
import { ImportReferenceSchema, ScopeManifestSchema } from '../../src/domain/schemas.ts';
import type { AnalysisLimits, FileId } from '../../src/domain/types.ts';
import { createParserSession } from '../../src/parser/adapter.ts';
import type { ParserSource } from '../../src/parser/protocol.ts';
import { resolveImportClosure } from '../../src/relationships/closure.ts';
import type { RelationshipInput } from '../../src/relationships/closure.ts';
import type { ImportClosureResult, ImportObservation } from '../../src/relationships/types.ts';
import {
  absoluteProjectPath,
  createProject,
  removeProject,
  safePathContext,
  testLimits,
  writeProjectFile,
} from '../helpers/filesystem.ts';
import { trustedDefaults } from '../helpers/parse-source.ts';

const PRAGMA = 'pragma solidity ^0.8.20;\n';

interface ProjectOptions {
  readonly config?: Record<string, unknown>;
  readonly limits?: Partial<AnalysisLimits>;
  readonly target?: string;
  readonly signal?: AbortSignal;
}

interface Harness {
  readonly root: string;
  readonly input: RelationshipInput;
  readonly identities: IdentityRegistry;
}

async function withProject<T>(
  files: Readonly<Record<string, string>>,
  options: ProjectOptions,
  body: (harness: Harness) => Promise<T>,
  prepare?: (root: string) => Promise<void>,
): Promise<T> {
  const root = await createProject('audit-estimator-imports-');
  let session: ReturnType<typeof createParserSession> | undefined;
  try {
    for (const [path, contents] of Object.entries(files)) {
      await writeProjectFile(root, path, contents);
    }
    if (options.config !== undefined) {
      await writeProjectFile(
        root,
        'audit-estimator.config.json',
        JSON.stringify({ configVersion: '1.0.0', ...options.config }),
      );
    }
    await prepare?.(root);
    const limits = testLimits(options.limits ?? {});
    const defaults = trustedDefaults(limits);
    const operational = await resolveConfig({ root, defaults });
    const budget = createDiscoveryBudget(operational.config.analysis.limits, options.signal);
    const rootContext = await safePathContext(root);
    const metadata = await readProjectMetadata({ pathContext: rootContext, budget });
    const resolved = await resolveConfig({ root, defaults, metadata: metadata.hints });
    budget.assertLimitsMatch(resolved.config.analysis.limits);
    const targetAbsolute = absoluteProjectPath(root, options.target ?? '.');
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
      const manifestEntry = discovery.manifest.entries.find((entry) => entry.fileId === fileId);
      if (manifestEntry === undefined) throw new Error('Missing manifest entry for snapshot.');
      return { fileId, snapshot, manifestEntry };
    });
    const initialSyntax = await session.analyzeSources(sources);
    return await body({
      root,
      identities,
      input: {
        discovery,
        pathContext,
        identities,
        budget,
        config: resolved.config,
        metadata,
        session,
        initialSyntax,
      },
    });
  } finally {
    await session?.close();
    await removeProject(root);
  }
}

function id(path: string): FileId {
  return fileIdentity(path);
}

function observationFor(
  result: ImportClosureResult,
  importer: string,
  specifier: string,
): ImportObservation {
  const found = result.importObservations.find(
    (item) => item.importerFileId === id(importer) && item.specifier === specifier,
  );
  if (found === undefined)
    throw new Error(`No observation for ${importer} importing ${specifier}.`);
  return found;
}

function expectSchemas(result: ImportClosureResult): void {
  for (const item of result.imports)
    expect(ImportReferenceSchema.safeParse(item).success).toBe(true);
  expect(ScopeManifestSchema.safeParse(result.manifest).success).toBe(true);
  const unresolvedTargets = result.imports
    .filter((item) => item.status !== 'resolved')
    .map((item) => item.targetFileId);
  expect(unresolvedTargets.every((target) => target === null)).toBe(true);
}

function contract(name: string, imports: readonly string[] = []): string {
  return `${PRAGMA}${imports.map((specifier) => `import "${specifier}";\n`).join('')}contract ${name} {}\n`;
}

describe('resolution and remappings', () => {
  it('resolves root-direct, relative, named, namespace and scoped-package imports', async () => {
    const files = {
      'src/A.sol': `${PRAGMA}import "shared/Base.sol";\nimport {B} from "./B.sol";\nimport * as C from "./sub/C.sol";\nimport "@scope/pkg/Token.sol";\ncontract A {}\n`,
      'src/B.sol': contract('B'),
      'src/sub/C.sol': contract('C', ['../B.sol']),
      'shared/Base.sol': contract('Base'),
      'node_modules/@scope/pkg/Token.sol': contract('Token'),
    };
    await withProject(files, {}, async ({ input }) => {
      const result = await resolveImportClosure(input);
      expectSchemas(result);
      expect(result.closureComplete).toBe(true);
      expect(observationFor(result, 'src/A.sol', 'shared/Base.sol')).toMatchObject({
        status: 'resolved',
        strategy: 'direct',
        lookupName: 'shared/Base.sol',
        targetFileId: id('shared/Base.sol'),
      });
      expect(observationFor(result, 'src/A.sol', './B.sol')).toMatchObject({
        status: 'resolved',
        strategy: 'relative',
        targetFileId: id('src/B.sol'),
      });
      expect(observationFor(result, 'src/A.sol', './sub/C.sol').targetFileId).toBe(
        id('src/sub/C.sol'),
      );
      expect(observationFor(result, 'src/sub/C.sol', '../B.sol').targetFileId).toBe(
        id('src/B.sol'),
      );
      const scoped = observationFor(result, 'src/A.sol', '@scope/pkg/Token.sol');
      expect(scoped.targetFileId).toBe(id('node_modules/@scope/pkg/Token.sol'));
      expect(scoped.probes.map((probe) => probe.outcome)).toEqual(['missing', 'found']);
      const role = (path: string) =>
        result.manifest.entries.find((entry) => entry.fileId === id(path));
      expect(role('src/A.sol')).toMatchObject({ role: 'scoped', ownership: 'first-party' });
      expect(role('src/B.sol')).toMatchObject({ role: 'scoped', ownership: 'first-party' });
      expect(role('shared/Base.sol')).toMatchObject({ role: 'context', ownership: 'first-party' });
      expect(role('node_modules/@scope/pkg/Token.sol')).toMatchObject({
        role: 'context',
        ownership: 'third-party',
      });
      expect(
        result.diagnostics
          .filter((item) => item.code === 'PARTIAL_ANALYSIS')
          .map((item) => item.fileId),
      ).toEqual([id('shared/Base.sol')]);
    });
  });

  it('finds a configured Foundry lib package and reports a missing installed package', async () => {
    const files = {
      'foundry.toml': '[profile.default]\nlibs = ["lib"]\n',
      'src/A.sol': contract('A', ['forge-std/Test.sol', 'missing-pkg/Token.sol']),
      'lib/forge-std/src/Test.sol': contract('Test'),
    };
    await withProject(files, {}, async ({ input }) => {
      const result = await resolveImportClosure(input);
      expectSchemas(result);
      const lib = observationFor(result, 'src/A.sol', 'forge-std/Test.sol');
      expect(lib).toMatchObject({
        status: 'resolved',
        targetFileId: id('lib/forge-std/src/Test.sol'),
      });
      expect(lib.probes.map((probe) => [probe.origin, probe.outcome])).toEqual([
        ['root', 'missing'],
        ['node-modules', 'missing'],
        ['lib', 'found'],
      ]);
      expect(
        result.manifest.entries.find((entry) => entry.fileId === id('lib/forge-std/src/Test.sol')),
      ).toMatchObject({ role: 'context', ownership: 'third-party' });
      const missing = observationFor(result, 'src/A.sol', 'missing-pkg/Token.sol');
      expect(missing).toMatchObject({
        status: 'unresolved',
        targetFileId: null,
        reason: 'not-found',
      });
      expect(result.imports.find((item) => item.id === missing.importId)).toMatchObject({
        status: 'unresolved',
        targetFileId: null,
      });
      expect(result.closureComplete).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'IMPORT_UNRESOLVED', fileId: id('src/A.sol') }),
      );
    });
  });

  it('reports distinct safe physical candidates as ambiguous without choosing one', async () => {
    const files = {
      'src/A.sol': contract('A', ['pkg/T.sol']),
      'pkg/T.sol': contract('RootT'),
      'node_modules/pkg/T.sol': contract('ModulesT'),
    };
    await withProject(files, {}, async ({ input }) => {
      const result = await resolveImportClosure(input);
      expectSchemas(result);
      const ambiguous = observationFor(result, 'src/A.sol', 'pkg/T.sol');
      expect(ambiguous).toMatchObject({
        status: 'ambiguous',
        targetFileId: null,
        reason: 'ambiguous-candidates',
        candidateFileIds: [id('node_modules/pkg/T.sol'), id('pkg/T.sol')],
      });
      expect(result.manifest.entries.map((entry) => entry.path)).toEqual(['src/A.sol']);
      expect(result.closureComplete).toBe(false);
    });
  });

  it('treats a matched remapping as authoritative even when its target is missing', async () => {
    const files = {
      'src/A.sol': contract('A', ['@x/T.sol']),
      'node_modules/@x/T.sol': contract('T'),
    };
    await withProject(
      files,
      { config: { imports: { remappings: [{ prefix: '@x/', target: 'vendor/x' }] } } },
      async ({ input }) => {
        const result = await resolveImportClosure(input);
        expectSchemas(result);
        const missing = observationFor(result, 'src/A.sol', '@x/T.sol');
        expect(missing).toMatchObject({
          status: 'unresolved',
          strategy: 'remapped',
          reason: 'remapped-target-missing',
          lookupName: '@x/T.sol',
          remapping: {
            source: 'config',
            prefix: '@x/',
            target: 'vendor/x',
            resolvedName: 'vendor/x/T.sol',
          },
        });
        expect(missing.probes).toHaveLength(1);
        expect(result.manifest.entries.map((entry) => entry.path)).toEqual(['src/A.sol']);
      },
    );
  });

  it('applies remappings.txt only when no higher-priority array exists', async () => {
    const files = {
      'src/A.sol': contract('A', ['@oz/T.sol']),
      'remappings.txt': '# libs\n@oz/=vendor/oz/\n',
      'vendor/oz/T.sol': contract('T'),
    };
    await withProject(files, {}, async ({ input }) => {
      const result = await resolveImportClosure(input);
      expectSchemas(result);
      expect(result.remappingSource).toBe('remappings-txt');
      expect(observationFor(result, 'src/A.sol', '@oz/T.sol')).toMatchObject({
        status: 'resolved',
        strategy: 'remapped',
        remapping: { source: 'remappings-txt', target: 'vendor/oz' },
        targetFileId: id('vendor/oz/T.sol'),
      });
    });
    await withProject(files, { config: { imports: { remappings: [] } } }, async ({ input }) => {
      const result = await resolveImportClosure(input);
      expect(result.remappingSource).toBe('config');
      expect(observationFor(result, 'src/A.sol', '@oz/T.sol')).toMatchObject({
        status: 'unresolved',
        strategy: 'direct',
        reason: 'not-found',
      });
    });
    await withProject(
      { ...files, 'foundry.toml': '[profile.default]\nremappings = []\n' },
      {},
      async ({ input }) => {
        const result = await resolveImportClosure(input);
        expect(result.remappingSource).toBe('metadata');
        expect(observationFor(result, 'src/A.sol', '@oz/T.sol').status).toBe('unresolved');
      },
    );
  });

  it('diagnoses an invalid active remappings.txt and applies no partial list', async () => {
    const files = {
      'src/A.sol': contract('A', ['@oz/T.sol']),
      'remappings.txt': '@oz/=vendor/oz/\nnot a mapping\n',
      'vendor/oz/T.sol': contract('T'),
    };
    await withProject(files, {}, async ({ input }) => {
      const result = await resolveImportClosure(input);
      expect(result.activeRemappings).toEqual([]);
      expect(observationFor(result, 'src/A.sol', '@oz/T.sol').status).toBe('unresolved');
      expect(result.closureComplete).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'IMPORT_UNRESOLVED',
          details: [
            { key: 'metadata', value: 'remappings.txt' },
            { key: 'reason', value: 'invalid-line' },
          ],
        }),
      );
    });
  });

  it('rejects remapping conflicts instead of selecting by order', async () => {
    const files = {
      'src/A.sol': contract('A', ['@x/T.sol']),
      'one/T.sol': contract('One'),
      'two/T.sol': contract('Two'),
    };
    await withProject(
      files,
      {
        config: {
          imports: {
            remappings: [
              { prefix: '@x/', target: 'two' },
              { prefix: '@x/', target: 'one' },
            ],
          },
        },
      },
      async ({ input }) => {
        const result = await resolveImportClosure(input);
        expectSchemas(result);
        expect(observationFor(result, 'src/A.sol', '@x/T.sol')).toMatchObject({
          status: 'ambiguous',
          reason: 'remapping-conflict',
          targetFileId: null,
          candidateFileIds: [id('one/T.sol'), id('two/T.sol')],
        });
        expect(result.manifest.entries.map((entry) => entry.path)).toEqual(['src/A.sol']);
      },
    );
  });
});

describe('closure and scope', () => {
  it('loads shared, diamond and cyclic dependencies once and records cycles', async () => {
    const files = {
      'src/A.sol': contract('A', ['./B.sol', './C.sol']),
      'src/B.sol': contract('B', ['../shared/D.sol']),
      'src/C.sol': contract('C', ['../shared/D.sol']),
      'shared/D.sol': contract('D', ['../src/A.sol']),
    };
    await withProject(files, {}, async ({ input }) => {
      const result = await resolveImportClosure(input);
      expectSchemas(result);
      expect(result.closureComplete).toBe(true);
      expect(result.sources.map((source) => source.fileId)).toEqual([
        id('shared/D.sol'),
        id('src/A.sol'),
        id('src/B.sol'),
        id('src/C.sol'),
      ]);
      expect(input.budget.counters.sourceFiles).toBe(4);
      expect(result.syntax.files).toHaveLength(4);
      expect(result.importCycles).toEqual([
        [id('shared/D.sol'), id('src/A.sol'), id('src/B.sol'), id('src/C.sol')],
      ]);
      expect(result.imports).toHaveLength(5);
      expect(input.session.counters.syntaxFiles).toBe(4);
      expect(result.syntax.visitedNodes).toBe(input.session.counters.syntaxNodes);
    });
  });

  it('records a self-import as a one-file cycle', async () => {
    await withProject({ 'src/A.sol': contract('A', ['./A.sol']) }, {}, async ({ input }) => {
      const result = await resolveImportClosure(input);
      expect(result.importCycles).toEqual([[id('src/A.sol')]]);
      expect(result.closureComplete).toBe(true);
    });
  });

  it('keeps identical copies distinct while sharing one physical identity per file', async () => {
    const same = contract('Same');
    const files = {
      'src/A.sol': contract('A', ['../shared/One.sol', '../shared/Two.sol']),
      'shared/One.sol': same,
      'shared/Two.sol': same,
    };
    await withProject(files, {}, async ({ input }) => {
      const result = await resolveImportClosure(input);
      const one = result.sources.find((source) => source.fileId === id('shared/One.sol'));
      const two = result.sources.find((source) => source.fileId === id('shared/Two.sol'));
      expect(one?.snapshot.byteHash).toBe(two?.snapshot.byteHash);
      expect(one?.fileId).not.toBe(two?.fileId);
      expect(result.manifest.entries).toHaveLength(3);
      expect(input.budget.counters.sourceFiles).toBe(3);
    });
  });

  it('keeps an excluded first-party import as disclosed context, never scoped', async () => {
    const files = {
      'src/A.sol': contract('A', ['./Excluded.sol']),
      'src/Excluded.sol': contract('Excluded'),
    };
    await withProject(
      files,
      { config: { scope: { exclude: ['src/Excluded.sol'] } } },
      async ({ input }) => {
        expect(input.discovery.manifest.scopedFileIds).toEqual([id('src/A.sol')]);
        const result = await resolveImportClosure(input);
        expect(result.manifest.scopedFileIds).toEqual([id('src/A.sol')]);
        expect(result.manifest.contextFileIds).toEqual([id('src/Excluded.sol')]);
        expect(
          result.manifest.entries.find((entry) => entry.path === 'src/Excluded.sol'),
        ).toMatchObject({
          role: 'context',
          ownership: 'first-party',
        });
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            code: 'PARTIAL_ANALYSIS',
            severity: 'info',
            fileId: id('src/Excluded.sol'),
          }),
        );
        expect(result.closureComplete).toBe(true);
      },
    );
  });

  it('reclassifies a late hardlink alias without renaming published IDs', async () => {
    const files = {
      'src/Shared.sol': contract('Shared'),
      'src/Main.sol': contract('Main', ['../lib/Shared.sol']),
    };
    let linked = false;
    await withProject(
      files,
      { config: { scope: { sourceRoots: ['src'] } } },
      async ({ input }) => {
        // Hardlink creation is a platform capability; skip the body where it is unavailable.
        expect(linked || process.platform === 'win32').toBe(true);
        if (!linked) return;
        const originalIds = [...input.discovery.manifest.scopedFileIds];
        const result = await resolveImportClosure(input);
        expectSchemas(result);
        expect(originalIds).toContain(id('src/Shared.sol'));
        expect(observationFor(result, 'src/Main.sol', '../lib/Shared.sol')).toMatchObject({
          status: 'resolved',
          targetFileId: id('src/Shared.sol'),
        });
        expect(result.invalidatedScopedFileIds).toEqual([id('src/Shared.sol')]);
        expect(result.manifest.scopedFileIds).toEqual([id('src/Main.sol')]);
        expect(result.manifest.contextFileIds).toEqual([id('src/Shared.sol')]);
        expect(
          result.manifest.entries.find((entry) => entry.fileId === id('src/Shared.sol')),
        ).toMatchObject({ role: 'context', ownership: 'unknown', byteHash: expect.any(String) });
        expect(result.sources.map((source) => source.snapshot.canonicalPath)).toEqual([
          'src/Main.sol',
          'src/Shared.sol',
        ]);
        expect(result.closureComplete).toBe(false);
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({ code: 'OWNERSHIP_UNKNOWN', fileId: id('src/Shared.sol') }),
        );
      },
      async (root) => {
        await mkdir(absoluteProjectPath(root, 'lib'), { recursive: true });
        try {
          await link(
            absoluteProjectPath(root, 'src/Shared.sol'),
            absoluteProjectPath(root, 'lib/Shared.sol'),
          );
          linked = true;
        } catch {
          linked = false;
        }
      },
    );
  });

  it('blocks outside-root, outside-target, hard-excluded and symlinked candidates', async () => {
    const files = {
      'src/sub/A.sol': contract('A', [
        '../../../outside.sol',
        '../Other.sol',
        '.git/hooks.sol',
        'linked/T.sol',
      ]),
      'src/Other.sol': contract('Other'),
      '.git/hooks.sol': contract('Hook'),
      'real/T.sol': contract('Real'),
    };
    let symlinked = false;
    await withProject(
      files,
      { target: 'src/sub' },
      async ({ input }) => {
        const result = await resolveImportClosure(input);
        expectSchemas(result);
        expect(observationFor(result, 'src/sub/A.sol', '../../../outside.sol')).toMatchObject({
          reason: 'outside-root',
          probes: [],
        });
        expect(observationFor(result, 'src/sub/A.sol', '../Other.sol')).toMatchObject({
          status: 'unresolved',
          reason: 'blocked-candidate',
          probes: [{ outcome: 'blocked', reason: 'outside-target' }],
        });
        expect(observationFor(result, 'src/sub/A.sol', '.git/hooks.sol').reason).toBe(
          'blocked-candidate',
        );
        expect(symlinked || process.platform === 'win32').toBe(true);
        const linkedProbe = observationFor(result, 'src/sub/A.sol', 'linked/T.sol');
        expect(linkedProbe.status).toBe('unresolved');
        expect(linkedProbe.targetFileId).toBeNull();
        expect(result.manifest.entries.map((entry) => entry.path)).toEqual(['src/sub/A.sol']);
        expect(result.closureComplete).toBe(false);
      },
      async (root) => {
        try {
          await symlink(absoluteProjectPath(root, 'real'), absoluteProjectPath(root, 'linked'));
          symlinked = true;
        } catch {
          symlinked = false;
        }
      },
    );
  });

  it('is deterministic across aliases and input order and does not mutate discovery input', async () => {
    const files = {
      'src/A.sol': contract('A', ['./B.sol', '../shared/C.sol']),
      'src/B.sol': contract('B'),
      'shared/C.sol': contract('C'),
    };
    const outputs: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await withProject(files, {}, async ({ input }) => {
        const reversed: RelationshipInput = {
          ...input,
          discovery: {
            ...input.discovery,
            snapshots: [...input.discovery.snapshots].reverse(),
            manifest: {
              ...input.discovery.manifest,
              entries: [...input.discovery.manifest.entries].reverse(),
            },
          },
        };
        const result = await resolveImportClosure(attempt === 0 ? input : reversed);
        outputs.push(
          JSON.stringify({
            manifest: result.manifest,
            imports: result.imports,
            cycles: result.importCycles,
            sources: result.sources.map((source) => [source.fileId, source.snapshot.byteHash]),
          }),
        );
      });
    }
    expect(outputs[0]).toBe(outputs[1]);
  });

  it('stops scheduling at the shared unique-file limit and retains accepted evidence', async () => {
    const files = {
      'src/A.sol': contract('A', ['./B.sol']),
      'src/B.sol': contract('B', ['./C.sol']),
      'src/C.sol': contract('C'),
    };
    await withProject(
      files,
      { config: { scope: { include: ['src/A.sol'] } }, limits: { maxFiles: 2 } },
      async ({ input }) => {
        const result = await resolveImportClosure(input);
        expectSchemas(result);
        expect(result.stopped).toBe(true);
        expect(result.closureComplete).toBe(false);
        expect(observationFor(result, 'src/A.sol', './B.sol').status).toBe('resolved');
        expect(observationFor(result, 'src/B.sol', './C.sol')).toMatchObject({
          status: 'unresolved',
          reason: 'limit',
        });
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({ code: 'LIMIT_EXCEEDED', phase: 'semantics' }),
        );
        expect(input.budget.counters.sourceFiles).toBe(2);
      },
    );
  });

  it('treats a per-file byte overrun as that import only and total byte exhaustion as a stop', async () => {
    const big = `${PRAGMA}contract Big {}\n${'// padding\n'.repeat(40)}`;
    const files = {
      'src/A.sol': contract('A', ['../shared/Big.sol', '../shared/Small.sol']),
      'shared/Big.sol': big,
      'shared/Small.sol': contract('Small'),
    };
    await withProject(files, { limits: { maxFileBytes: 300 } }, async ({ input }) => {
      const result = await resolveImportClosure(input);
      expect(observationFor(result, 'src/A.sol', '../shared/Big.sol').reason).toBe('limit');
      expect(observationFor(result, 'src/A.sol', '../shared/Small.sol').status).toBe('resolved');
      expect(result.stopped).toBe(false);
      expect(result.closureComplete).toBe(false);
    });
    const totalLimit = Buffer.byteLength(contract('A', ['./B.sol']), 'utf8') + 20;
    await withProject(
      { 'src/A.sol': contract('A', ['./B.sol']), 'src/B.sol': contract('B') },
      {
        config: { scope: { include: ['src/A.sol'] } },
        limits: { maxTotalSourceBytes: totalLimit },
      },
      async ({ input }) => {
        const result = await resolveImportClosure(input);
        expect(result.stopped).toBe(true);
        expect(observationFor(result, 'src/A.sol', './B.sol').reason).toBe('limit');
      },
    );
  });

  it('keeps parser import and node exhaustion as failed context syntax', async () => {
    const files = {
      'src/A.sol': contract('A', ['./B.sol']),
      'src/B.sol': contract('B', ['./C.sol']),
      'src/C.sol': contract('C'),
    };
    await withProject(
      files,
      { config: { scope: { include: ['src/A.sol'] } }, limits: { maxImports: 1 } },
      async ({ input }) => {
        const result = await resolveImportClosure(input);
        expect(result.syntax.complete).toBe(false);
        expect(result.syntax.files.find((item) => item.fileId === id('src/B.sol'))).toMatchObject({
          status: 'failed',
          code: 'LIMIT_EXCEEDED',
        });
        expect(result.closureComplete).toBe(false);
        expect(result.syntax.visitedNodes).toBe(input.session.counters.syntaxNodes);
      },
    );
    await withProject(
      files,
      { config: { scope: { include: ['src/A.sol'] } }, limits: { maxAstNodesTotal: 40 } },
      async ({ input }) => {
        const result = await resolveImportClosure(input);
        expect(result.closureComplete).toBe(false);
        expect(result.syntax.files.some((item) => item.status === 'failed')).toBe(true);
      },
    );
  });

  it('applies the metadata byte limit to remappings.txt', async () => {
    const files = {
      'src/A.sol': contract('A'),
      'remappings.txt': `@oz/=vendor/oz/\n${'#'.repeat(80)}\n`,
    };
    await withProject(files, { limits: { maxMetadataBytes: 32 } }, async ({ input }) => {
      const result = await resolveImportClosure(input);
      expect(result.closureComplete).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'IMPORT_UNRESOLVED',
          details: [
            { key: 'metadata', value: 'remappings.txt' },
            { key: 'reason', value: 'metadata-limit' },
          ],
        }),
      );
    });
  });

  it('propagates cancellation without closing the caller-owned session', async () => {
    const controller = new AbortController();
    await withProject(
      { 'src/A.sol': contract('A', ['./B.sol']), 'src/B.sol': contract('B') },
      { signal: controller.signal },
      async ({ input }) => {
        controller.abort();
        await expect(resolveImportClosure(input)).rejects.toBeInstanceOf(BudgetError);
        await expect(resolveImportClosure(input)).rejects.toMatchObject({ kind: 'cancelled' });
      },
    );
  });

  it('rejects syntax that did not come from the supplied snapshots and session', async () => {
    await withProject(
      { 'src/A.sol': contract('A'), 'src/B.sol': contract('B') },
      {},
      async ({ input }) => {
        await expect(
          resolveImportClosure({
            ...input,
            initialSyntax: { ...input.initialSyntax, files: input.initialSyntax.files.slice(1) },
          }),
        ).rejects.toThrow('Initial syntax is missing a scoped snapshot.');
        const other = input.initialSyntax.files.map((file) => ({ ...file }));
        await expect(
          resolveImportClosure({
            ...input,
            initialSyntax: { ...input.initialSyntax, files: other },
          }),
        ).rejects.toThrow('Initial syntax was not produced by this session');
      },
    );
  });
});
