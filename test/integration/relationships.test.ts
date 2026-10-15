import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/load.ts';
import { createDiscoveryBudget } from '../../src/discovery/budget.ts';
import { fileIdentity } from '../../src/domain/canonical.ts';
import type { AnalysisLimits, FileId } from '../../src/domain/types.ts';
import { createParserSessionForTests } from '../../src/parser/adapter.ts';
import type {
  ParsedSyntax,
  SemanticComponentInput,
  SemanticComponentMember,
  SemanticComponentOutcome,
} from '../../src/parser/adapter.ts';
import type { ParserDeclaration, SemanticImportLookup } from '../../src/parser/protocol.ts';
import { createProject, removeProject, testLimits } from '../helpers/filesystem.ts';
import { parserSource, trustedDefaults } from '../helpers/parse-source.ts';

const GRAMMAR = '0.8.37';
const fixtureDirectory = new URL('../fixtures/relationships/', import.meta.url);

async function fixture(name: string): Promise<string> {
  return await readFile(new URL(name, fixtureDirectory), 'utf8');
}

function byteOffset(text: string, needle: string, from = 0): number {
  const index = text.indexOf(needle, from);
  if (index < 0) throw new Error(`Missing ${needle}.`);
  return Buffer.byteLength(text.slice(0, index), 'utf8');
}

function processExists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code !== 'ESRCH';
  }
}

function realWorkerFactory(children: ChildProcessWithoutNullStreams[]) {
  const packageEntry = new URL(import.meta.resolve('audit-estimator'));
  const workerPath = fileURLToPath(new URL('./parser/worker.js', packageEntry));
  const packageRoot = resolve(fileURLToPath(new URL('../', packageEntry)));
  return (): ChildProcessWithoutNullStreams => {
    const child = spawn(process.execPath, ['--max-old-space-size=64', workerPath], {
      cwd: packageRoot,
      env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    return child;
  };
}

interface SourceInput {
  readonly path: string;
  readonly text: string;
}

interface SemanticHarness {
  readonly session: ReturnType<typeof createParserSessionForTests>;
  readonly members: readonly SemanticComponentMember[];
  readonly lookups: readonly SemanticImportLookup[];
  readonly children: readonly ChildProcessWithoutNullStreams[];
  readonly input: (overrides?: Partial<SemanticComponentInput>) => SemanticComponentInput;
  readonly member: (path: string) => SemanticComponentMember;
  readonly declaration: (path: string, name: string) => ParserDeclaration;
}

function joinRelative(importerPath: string, specifier: string): string {
  const stack = importerPath.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') stack.pop();
    else stack.push(segment);
  }
  return stack.join('/');
}

async function withSemantic<T>(
  inputs: readonly SourceInput[],
  options: { readonly limits?: Partial<AnalysisLimits> },
  body: (harness: SemanticHarness) => Promise<T>,
): Promise<T> {
  const root = await createProject('audit-estimator-semantic-');
  const children: ChildProcessWithoutNullStreams[] = [];
  try {
    const resolved = await resolveConfig({
      root,
      noConfig: true,
      defaults: trustedDefaults(testLimits(options.limits ?? {})),
    });
    const budget = createDiscoveryBudget(resolved.config.analysis.limits);
    const session = createParserSessionForTests(
      { budget, config: resolved.config },
      realWorkerFactory(children),
    );
    try {
      const sources = inputs.map((item) => parserSource(root, item.path, item.text, 'scoped'));
      const batch = await session.analyzeSources(sources);
      expect(batch.complete).toBe(true);
      const members: SemanticComponentMember[] = sources.map((source) => {
        const syntax = batch.files.find((file) => file.fileId === source.fileId);
        if (syntax?.status !== 'parsed') throw new Error('Expected parsed fixture syntax.');
        return { source, syntax: syntax satisfies ParsedSyntax };
      });
      const lookups: SemanticImportLookup[] = members.flatMap((member) =>
        member.syntax.imports.map((imported) => ({
          importerFileId: member.source.fileId,
          importId: imported.id,
          specifier: imported.specifier,
          specifierRange: imported.specifierRange,
          targetFileId: fileIdentity(
            joinRelative(member.source.snapshot.canonicalPath, imported.specifier),
          ),
        })),
      );
      const sortedIds = members.map((member) => member.source.fileId).sort();
      const componentId = sortedIds[0];
      if (componentId === undefined) throw new Error('Expected at least one source.');
      const harness: SemanticHarness = {
        session,
        members,
        lookups,
        children,
        input: (overrides = {}) => ({
          componentId,
          grammar: GRAMMAR,
          members,
          lookups,
          maxRecords: 100_000,
          ...overrides,
        }),
        member: (path) => {
          const found = members.find((item) => item.source.snapshot.canonicalPath === path);
          if (found === undefined) throw new Error(`Missing member ${path}.`);
          return found;
        },
        declaration: (path, name) => {
          const found = harness
            .member(path)
            .syntax.declarations.find((declaration) => declaration.name === name);
          if (found === undefined) throw new Error(`Missing declaration ${name}.`);
          return found;
        },
      };
      return await body(harness);
    } finally {
      await session.close();
    }
  } finally {
    await removeProject(root);
  }
}

function requireBound(outcome: SemanticComponentOutcome) {
  if (outcome.status !== 'bound') throw new Error(`Expected bound, got ${outcome.reason}.`);
  return outcome;
}

function expectChildrenReaped(children: readonly ChildProcessWithoutNullStreams[]): void {
  for (const child of children) {
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(processExists(child.pid)).toBe(false);
  }
}

describe('semantic component jobs', () => {
  it('maps direct, namespace, alias and diamond bases to exact declaration name ranges', async () => {
    const base = await fixture('hierarchy/Base.sol');
    const child = await fixture('hierarchy/Child.sol');
    await withSemantic(
      [
        { path: 'contracts/Base.sol', text: base },
        { path: 'contracts/Child.sol', text: child },
      ],
      {},
      async (harness) => {
        const outcome = requireBound(
          await harness.session.analyzeSemanticComponent(harness.input()),
        );
        expect(outcome.grammar).toBe(GRAMMAR);
        const parentName = harness.declaration('contracts/Base.sol', 'Parent').nameRange;
        expect(parentName.startByte).toBe(byteOffset(base, 'Parent'));
        const sitesOf = (path: string, name: string) =>
          outcome.baseSites.filter(
            (site) =>
              site.fileId === harness.member(path).source.fileId &&
              site.contractStartByte === harness.declaration(path, name).declarationRange.startByte,
          );

        // Direct and namespace-qualified bases resolve to exactly the Parent declaration.
        for (const name of ['Direct', 'ViaNamespace']) {
          const [site, ...rest] = sitesOf('contracts/Child.sol', name);
          expect(rest).toEqual([]);
          expect(site?.ordinal).toBe(0);
          expect(site?.definitions).toEqual([
            {
              kind: 'user',
              fileId: harness.member('contracts/Base.sol').source.fileId,
              nameRange: parentName,
              definiens: 'ContractDefinition',
            },
          ]);
        }

        // A named alias returns both the alias symbol and the imported definition.
        const [alias] = sitesOf('contracts/Child.sol', 'ViaAlias');
        expect(
          alias?.definitions.map(
            (definition) => definition.kind === 'user' && definition.definiens,
          ),
        ).toEqual(['ImportDeconstructionSymbol', 'ContractDefinition']);
        expect(alias?.definitions[0]).toMatchObject({
          fileId: harness.member('contracts/Child.sol').source.fileId,
          nameRange: { startByte: byteOffset(child, 'AliasParent') },
        });
        expect(alias?.definitions[1]).toMatchObject({ nameRange: parentName });

        // A missing base has no definitions, and the file still parses.
        const [missing] = sitesOf('contracts/Child.sol', 'MissingBase');
        expect(missing?.definitions).toEqual([]);

        // The diamond declares bases in source order with ordinals 0 and 1.
        const diamond = sitesOf('contracts/Base.sol', 'Diamond');
        expect(diamond.map((site) => site.ordinal)).toEqual([0, 1]);
        expect(diamond.map((site) => site.definitions)).toEqual([
          [
            {
              kind: 'user',
              fileId: harness.member('contracts/Base.sol').source.fileId,
              nameRange: harness.declaration('contracts/Base.sol', 'DiamondLeft').nameRange,
              definiens: 'ContractDefinition',
            },
          ],
          [
            {
              kind: 'user',
              fileId: harness.member('contracts/Base.sol').source.fileId,
              nameRange: harness.declaration('contracts/Base.sol', 'DiamondRight').nameRange,
              definiens: 'ContractDefinition',
            },
          ],
        ]);

        // Interfaces inherit with the same site shape, and bases are reported only for declarations
        // that have an inheritance specifier.
        const [iface] = sitesOf('contracts/Base.sol', 'IDerived');
        expect(iface?.definitions).toMatchObject([{ definiens: 'InterfaceDefinition' }]);
        expect(sitesOf('contracts/Base.sol', 'Parent')).toEqual([]);

        // The job charges semantic nodes separately and the child is reaped.
        expect(harness.session.counters.semanticNodes).toBe(outcome.consumedNodes);
        expect(outcome.consumedNodes).toBeGreaterThan(0);
        // One long-lived syntax child plus one disposable semantic child.
        expect(harness.children).toHaveLength(2);
        expectChildrenReaped(harness.children.slice(1));
      },
    );
  });

  it('returns resolved cyclic bases without inventing an order', async () => {
    const cycles = await fixture('hierarchy/Cycles.sol');
    await withSemantic([{ path: 'contracts/Cycles.sol', text: cycles }], {}, async (harness) => {
      const outcome = requireBound(await harness.session.analyzeSemanticComponent(harness.input()));
      const target = (name: string) =>
        outcome.baseSites
          .filter(
            (site) =>
              site.contractStartByte ===
              harness.declaration('contracts/Cycles.sol', name).declarationRange.startByte,
          )
          .map((site) =>
            site.definitions.map(
              (definition) => definition.kind === 'user' && definition.nameRange.startByte,
            ),
          );
      expect(target('CycleA')).toEqual([[byteOffset(cycles, 'contract CycleB') + 9]]);
      expect(target('CycleB')).toEqual([[byteOffset(cycles, 'contract CycleA') + 9]]);
      expect(target('SelfLoop')).toEqual([[byteOffset(cycles, 'SelfLoop')]]);
    });
  });

  it('keeps symbol candidates, builtin members and receivers separate from dispatch', async () => {
    const calls = await fixture('calls/Calls.sol');
    await withSemantic([{ path: 'contracts/Calls.sol', text: calls }], {}, async (harness) => {
      const outcome = requireBound(await harness.session.analyzeSemanticComponent(harness.input()));
      const member = harness.member('contracts/Calls.sol');
      const callEvents = member.syntax.events.filter((event) => event.kind === 'call-site');
      expect(outcome.callSites).toHaveLength(callEvents.length);
      const siteFor = (needle: string) => {
        const start = byteOffset(calls, needle);
        const found = outcome.callSites.find(
          (site) => site.range.startByte <= start && site.range.endByte > start,
        );
        if (found === undefined) throw new Error(`No call site for ${needle}.`);
        return found;
      };
      const exact = (needle: string, expression: string) => {
        const expressionStart = byteOffset(calls, expression, calls.indexOf(needle));
        const found = outcome.callSites.filter(
          (site) =>
            site.range.endByte === expressionStart + Buffer.byteLength(expression, 'utf8') + 0,
        );
        return found;
      };
      expect(exact('identity(1)', 'identity(1)')).toHaveLength(1);

      // Overloads return every candidate; the function pointer parameter is not a callable.
      expect(siteFor('overloaded(1)').definitions).toHaveLength(2);
      expect(siteFor('fp(1)').definitions).toMatchObject([{ definiens: 'Parameter' }]);

      // `this`, interface receivers and library receivers keep their receiver evidence.
      expect(siteFor('this.visible()')).toMatchObject({
        callee: 'member',
        receiver: 'this',
        receiverDefinitions: [],
        definitions: [{ definiens: 'FunctionDefinition' }],
      });
      expect(siteFor('remote.ping(1)')).toMatchObject({
        receiver: 'identifier',
        receiverDefinitions: [{ definiens: 'StateVariableDefinition' }],
        definitions: [{ definiens: 'FunctionDefinition' }],
      });
      expect(siteFor('Helpers.twice(2)')).toMatchObject({
        receiver: 'identifier',
        receiverDefinitions: [{ definiens: 'LibraryDefinition' }],
        definitions: [{ definiens: 'FunctionDefinition' }],
      });

      // Builtin members bind to built-in definitions on resolved receivers, never user ones.
      for (const needle of [
        'target.call(data)',
        'target.delegatecall(data)',
        'target.staticcall(data)',
        'receiver.transfer(1)',
        'receiver.send(1)',
        'target.call{value: 1}(data)',
      ]) {
        const site = siteFor(needle);
        expect(site.definitions.length).toBeGreaterThan(0);
        expect(site.definitions.every((definition) => definition.kind === 'builtin')).toBe(true);
        expect(site.receiverDefinitions).toMatchObject([{ definiens: 'Parameter' }]);
      }

      // Custom call/transfer functions bind to user definitions, so they are not builtins.
      for (const needle of ['token.transfer(to, 1)', 'CallLib.call(target)']) {
        const site = siteFor(needle);
        expect(site.definitions).toMatchObject([{ kind: 'user', definiens: 'FunctionDefinition' }]);
      }

      // Type conversions are neither member nor identifier calls.
      expect(siteFor('uint160(target)').callee).toBe('elementary-type');
    });
  });

  it('maps BOM, CRLF, Unicode and escaped import literals by original byte range', async () => {
    const root =
      '﻿pragma solidity 0.8.37;\r\n// é\u{1F642}\r\nimport "./\\x62.sol";\r\nimport "./\\u0062.sol";\r\n' +
      'contract A is B {}\r\n';
    const dependency = 'pragma solidity 0.8.37;\r\ncontract B {}\r\n';
    await withSemantic(
      [
        { path: 'contracts/a.sol', text: root },
        { path: 'contracts/b.sol', text: dependency },
      ],
      {},
      async (harness) => {
        const imports = harness.member('contracts/a.sol').syntax.imports;
        expect(imports.map((item) => item.specifier)).toEqual(['./b.sol', './b.sol']);
        const firstLiteral = '"./\\x62.sol"';
        expect(imports[0]?.specifierRange.startByte).toBe(
          Buffer.byteLength(root.slice(0, root.indexOf(firstLiteral)), 'utf8'),
        );
        expect(imports[1]?.specifierRange.startByte).toBeGreaterThan(
          imports[0]?.specifierRange.endByte ?? 0,
        );
        expect(harness.lookups).toHaveLength(2);
        const outcome = requireBound(
          await harness.session.analyzeSemanticComponent(harness.input()),
        );
        const [site] = outcome.baseSites;
        expect(outcome.baseSites).toHaveLength(1);
        expect(site?.definitions).toEqual([
          {
            kind: 'user',
            fileId: harness.member('contracts/b.sol').source.fileId,
            nameRange: harness.declaration('contracts/b.sol', 'B').nameRange,
            definiens: 'ContractDefinition',
          },
        ]);
        // The reference maps through the removed BOM, CRLF lines and astral text.
        expect(site?.reference.startByte).toBe(
          Buffer.byteLength(root.slice(0, root.indexOf('B {}')), 'utf8'),
        );
        expect(site?.reference.start).toEqual({ line: 5, column: 15 });
      },
    );
  });
});

const PAIR: readonly SourceInput[] = [
  {
    path: 'contracts/a.sol',
    text: 'pragma solidity 0.8.37;\nimport "./b.sol";\ncontract A is B {}\n',
  },
  { path: 'contracts/b.sol', text: 'pragma solidity 0.8.37;\ncontract B {}\n' },
];

describe('semantic job boundaries', () => {
  it('rejects forged, duplicate, missing and unmapped import lookups with a fixed reason', async () => {
    await withSemantic(PAIR, {}, async (harness) => {
      const lookup = harness.lookups[0];
      if (lookup === undefined) throw new Error('Expected one import lookup.');
      const aText = harness.member('contracts/a.sol').source.snapshot.originalText;
      const bogusStart = byteOffset(aText, 'contract');
      const cases: readonly [string, readonly SemanticImportLookup[], string][] = [
        ['missing entry', [], 'import-mapping'],
        ['duplicate range', [lookup, { ...lookup, importId: lookup.importId }], 'import-mapping'],
        [
          'entry without a literal',
          [
            lookup,
            {
              ...lookup,
              specifierRange: {
                startByte: bogusStart,
                endByte: bogusStart + 8,
                start: { line: 3, column: 1 },
                end: { line: 3, column: 9 },
              },
            },
          ],
          'import-mapping',
        ],
        [
          'range off a character boundary',
          [
            {
              ...lookup,
              specifierRange: {
                ...lookup.specifierRange,
                start: { line: 2, column: 99 },
              },
            },
          ],
          'invalid-request',
        ],
      ];
      for (const [name, lookups, reason] of cases) {
        const outcome = await harness.session.analyzeSemanticComponent(harness.input({ lookups }));
        expect({ name, status: outcome.status }).toEqual({ name, status: 'unavailable' });
        expect({ name, reason: outcome.status === 'unavailable' ? outcome.reason : null }).toEqual({
          name,
          reason,
        });
      }
      await expect(
        harness.session.analyzeSemanticComponent(
          harness.input({
            lookups: [{ ...lookup, targetFileId: fileIdentity('contracts/elsewhere.sol') }],
          }),
        ),
      ).rejects.toThrow('outside the component');
      expect(harness.children).toHaveLength(1 + cases.length);
      expectChildrenReaped(harness.children.slice(1));
    });
  });

  it('requires every member to parse under the common grammar and keeps original syntax', async () => {
    const inputs: readonly SourceInput[] = [
      { path: 'contracts/e.sol', text: 'pragma solidity ^0.8.4;\nerror E();\ncontract C {}\n' },
    ];
    await withSemantic(inputs, {}, async (harness) => {
      const member = harness.member('contracts/e.sol');
      expect(member.syntax.version.compatibleVersions).toContain('0.8.37');
      const old = await harness.session.analyzeSemanticComponent(
        harness.input({ grammar: '0.7.6' }),
      );
      expect(old).toMatchObject({ status: 'unavailable', reason: 'syntax-invalid' });
      const unknown = await harness.session.analyzeSemanticComponent(
        harness.input({ grammar: '0.3.3' }),
      );
      expect(unknown).toMatchObject({
        status: 'unavailable',
        reason: 'grammar-unavailable',
        consumedNodes: 0,
      });
      // Failed semantics never replace the accepted syntax record.
      expect(
        harness.session.cachedSyntax(member.source.fileId, member.source.snapshot.byteHash),
      ).toBe(member.syntax);
      expect(harness.session.counters.syntaxFiles).toBe(1);
      expectChildrenReaped(harness.children.slice(1));
    });
  });

  it('applies exact-bound and one-over component file and byte limits before spawning', async () => {
    const totalBytes = PAIR.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0);
    await withSemantic(
      PAIR,
      { limits: { maxSemanticFiles: 2, maxSemanticBytes: totalBytes } },
      async (harness) => {
        expect((await harness.session.analyzeSemanticComponent(harness.input())).status).toBe(
          'bound',
        );
        expect(harness.children).toHaveLength(2);
      },
    );
    await withSemantic(PAIR, { limits: { maxSemanticFiles: 1 } }, async (harness) => {
      const outcome = await harness.session.analyzeSemanticComponent(harness.input());
      expect(outcome).toMatchObject({ status: 'unavailable', reason: 'limit', consumedNodes: 0 });
      expect(harness.children).toHaveLength(1);
    });
    await withSemantic(PAIR, { limits: { maxSemanticBytes: totalBytes - 1 } }, async (harness) => {
      const outcome = await harness.session.analyzeSemanticComponent(harness.input());
      expect(outcome).toMatchObject({ status: 'unavailable', reason: 'limit', consumedNodes: 0 });
      expect(harness.children).toHaveLength(1);
    });
    // One base site plus its one definition reference need exactly two records.
    await withSemantic(PAIR, {}, async (harness) => {
      const outcome = await harness.session.analyzeSemanticComponent(
        harness.input({ maxRecords: 1 }),
      );
      expect(outcome).toMatchObject({ status: 'unavailable', reason: 'limit' });
      const fine = await harness.session.analyzeSemanticComponent(harness.input({ maxRecords: 2 }));
      expect(fine.status).toBe('bound');
    });
  });

  it('shares one node budget across syntax, semantic and later syntax work', async () => {
    let syntaxNodes = 0;
    await withSemantic(PAIR, {}, async (harness) => {
      syntaxNodes = harness.session.counters.syntaxNodes;
      const outcome = requireBound(await harness.session.analyzeSemanticComponent(harness.input()));
      const counters = harness.session.counters;
      expect(counters.syntaxNodes).toBe(syntaxNodes);
      expect(counters.semanticNodes).toBe(outcome.consumedNodes);
      expect(counters.syntaxNodes + counters.semanticNodes).toBeLessThanOrEqual(
        testLimits().maxAstNodesTotal,
      );
    });
    const grant = 3;
    await withSemantic(
      PAIR,
      { limits: { maxAstNodesTotal: syntaxNodes + grant } },
      async (harness) => {
        const before = harness.session.counters;
        expect(before.syntaxNodes).toBe(syntaxNodes);
        const outcome = await harness.session.analyzeSemanticComponent(harness.input());
        expect(outcome).toMatchObject({ status: 'unavailable', reason: 'limit' });
        expect(outcome.consumedNodes).toBe(grant);
        expect(harness.session.counters.semanticNodes).toBe(outcome.consumedNodes);
        // The exhausted shared budget now stops further syntax work instead of resetting.
        const extra = parserSource(
          '/virtual',
          'contracts/c.sol',
          'pragma solidity 0.8.37;\ncontract C {}\n',
          'scoped',
        );
        const batch = await harness.session.analyzeSources([extra]);
        const total = harness.session.counters.syntaxNodes + harness.session.counters.semanticNodes;
        expect(batch.files[0]).toMatchObject({ status: 'failed', code: 'LIMIT_EXCEEDED' });
        expect(batch.complete).toBe(false);
        expect(total).toBe(syntaxNodes + grant);
      },
    );
  });

  it('serializes jobs, rejects use after close, and is independent of member order', async () => {
    await withSemantic(PAIR, {}, async (harness) => {
      const first = harness.session.analyzeSemanticComponent(harness.input());
      await expect(harness.session.analyzeSemanticComponent(harness.input())).rejects.toThrow(
        'active analysis batch',
      );
      await expect(harness.session.analyzeSources([])).rejects.toThrow('active analysis batch');
      const outcome = requireBound(await first);
      const reversed = requireBound(
        await harness.session.analyzeSemanticComponent(
          harness.input({ members: [...harness.members].reverse() }),
        ),
      );
      expect(reversed.baseSites).toEqual(outcome.baseSites);
      expect(reversed.callSites).toEqual(outcome.callSites);
      await harness.session.close();
      await expect(harness.session.analyzeSemanticComponent(harness.input())).rejects.toThrow(
        'closed',
      );
      expectChildrenReaped(harness.children);
    });
  });

  it('rejects syntax that this session did not produce', async () => {
    await withSemantic(PAIR, {}, async (harness) => {
      const forged: SemanticComponentMember[] = harness.members.map((member) => ({
        source: member.source,
        syntax: { ...member.syntax },
      }));
      await expect(
        harness.session.analyzeSemanticComponent(harness.input({ members: forged })),
      ).rejects.toThrow('not produced by this session');
      const fileOutside: FileId = fileIdentity('contracts/missing.sol');
      await expect(
        harness.session.analyzeSemanticComponent(harness.input({ componentId: fileOutside })),
      ).rejects.toThrow('valid sorted unique component');
    });
  });
});
