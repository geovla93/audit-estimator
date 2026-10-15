import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, link, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/load.ts';
import { BudgetError, createDiscoveryBudget } from '../../src/discovery/budget.ts';
import { discoverScope } from '../../src/discovery/discover.ts';
import { IdentityRegistry } from '../../src/discovery/identity.ts';
import { readProjectMetadata } from '../../src/discovery/metadata.ts';
import { resolveSafePath } from '../../src/discovery/safe-path.ts';
import { fileIdentity } from '../../src/domain/canonical.ts';
import {
  ImportReferenceSchema,
  RelationshipResultSchema,
  ScopeManifestSchema,
} from '../../src/domain/schemas.ts';
import type {
  AnalysisLimits,
  CallableId,
  ContractId,
  FileId,
  Measurement,
} from '../../src/domain/types.ts';
import { buildCallFacts, countConfirmedBuiltins } from '../../src/relationships/calls.ts';
import type { CallFileInput } from '../../src/relationships/calls.ts';
import { GraphAllowance } from '../../src/relationships/graph.ts';
import { buildInheritance, toBaseSiteFacts } from '../../src/relationships/inheritance.ts';
import type { InheritanceContract, InheritanceFile } from '../../src/relationships/inheritance.ts';
import { resolveRelationships } from '../../src/relationships/closure.ts';
import type { RelationshipInput } from '../../src/relationships/closure.ts';
import { createParserSession, createParserSessionForTests } from '../../src/parser/adapter.ts';
import type {
  ParsedSyntax,
  SemanticComponentInput,
  SemanticComponentMember,
  SemanticComponentOutcome,
} from '../../src/parser/adapter.ts';
import type {
  ParserDeclaration,
  ParserSource,
  SemanticImportLookup,
} from '../../src/parser/protocol.ts';
import {
  absoluteProjectPath,
  createProject,
  removeProject,
  safePathContext,
  testLimits,
  writeProjectFile,
} from '../helpers/filesystem.ts';
import { parserSource, trustedDefaults } from '../helpers/parse-source.ts';

const GRAMMAR = '0.8.37';

function ascending(left: unknown, right: unknown): number {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
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
      const sortedIds = members.map((member) => member.source.fileId).sort(ascending);
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

function inheritanceFiles(harness: SemanticHarness): InheritanceFile[] {
  return harness.members.map((member) => ({
    fileId: member.source.fileId,
    canonicalPath: member.source.snapshot.canonicalPath,
    syntax: member.syntax,
  }));
}

function contractNodes(harness: SemanticHarness): InheritanceContract[] {
  return harness.members.flatMap((member) =>
    member.syntax.declarations
      .filter(
        (declaration) =>
          declaration.callableId === null && declaration.contractId === declaration.id,
      )
      .map((declaration) => ({
        id: declaration.id as ContractId,
        fileId: member.source.fileId,
        callableIds: member.syntax.declarations
          .filter(
            (candidate) => candidate.contractId === declaration.id && candidate.callableId !== null,
          )
          .map((candidate) => candidate.callableId as CallableId),
        semantics: 'bound' as const,
      })),
  );
}

function contractIdOf(harness: SemanticHarness, path: string, name: string): ContractId {
  return harness.declaration(path, name).id as ContractId;
}

function inheritanceValue<T>(measurement: Measurement<T>): T | string {
  return measurement.status === 'measured' ? measurement.value : measurement.reason;
}

describe('native inheritance and call facts', () => {
  it('derives exact inheritance edges and measurements from native base sites', async () => {
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
        const result = buildInheritance({
          contracts: contractNodes(harness),
          sites: toBaseSiteFacts(inheritanceFiles(harness), outcome.baseSites),
          allowance: new GraphAllowance(100_000),
        });
        const id = (path: string, name: string) =>
          contractIdOf(harness, `contracts/${path}.sol`, name);
        const edgesOf = (path: string, name: string) =>
          result.edges.filter((edge) => edge.contractId === id(path, name));
        const record = (path: string, name: string) => {
          const found = result.inheritance.find((item) => item.contractId === id(path, name));
          if (found === undefined) throw new Error(`No inheritance record for ${name}.`);
          return found;
        };

        // Direct and namespace-qualified bases are unique; the alias stays ambiguous.
        for (const name of ['Direct', 'ViaNamespace']) {
          expect(edgesOf('Child', name)).toMatchObject([
            { resolution: 'resolved-unique', baseContractId: id('Base', 'Parent') },
          ]);
        }
        expect(edgesOf('Child', 'ViaAlias')).toMatchObject([
          {
            resolution: 'ambiguous',
            baseContractId: null,
            candidateContractIds: [id('Base', 'Parent')],
          },
        ]);
        expect(edgesOf('Child', 'MissingBase')).toMatchObject([
          { resolution: 'unresolved', candidateContractIds: [] },
        ]);

        // The diamond shares one DiamondBase ancestor; Grandchild merges two hierarchies.
        const diamond = record('Base', 'Diamond');
        expect(inheritanceValue(diamond.ancestorIds)).toEqual(
          [id('Base', 'DiamondLeft'), id('Base', 'DiamondRight'), id('Base', 'DiamondBase')].sort(
            ascending,
          ),
        );
        expect(inheritanceValue(diamond.maxDepth)).toBe(2);
        const grandchild = record('Child', 'Grandchild');
        expect(inheritanceValue(grandchild.ancestorIds)).toEqual(
          [
            id('Child', 'Direct'),
            id('Base', 'Parent'),
            id('Base', 'Diamond'),
            id('Base', 'DiamondLeft'),
            id('Base', 'DiamondRight'),
            id('Base', 'DiamondBase'),
          ].sort(ascending),
        );
        expect(inheritanceValue(grandchild.maxDepth)).toBe(3);
        const declared = (path: string, owner: string, name: string) =>
          harness
            .member(`contracts/${path}.sol`)
            .syntax.declarations.find(
              (declaration) =>
                declaration.name === name && declaration.contractId === id(path, owner),
            )?.callableId;
        expect(inheritanceValue(grandchild.ancestorDeclaredCallableIds)).toEqual(
          [
            declared('Base', 'Parent', 'inherited'),
            declared('Base', 'Parent', 'extra'),
            declared('Base', 'DiamondBase', 'shared'),
            declared('Base', 'DiamondLeft', 'left'),
          ].sort(ascending),
        );
        expect(inheritanceValue(record('Base', 'IDerived').maxDepth)).toBe(1);
        // Unresolved and ambiguous bases make that contract's transitive measurements unavailable.
        expect(inheritanceValue(record('Child', 'ViaAlias').ancestorIds)).toBe('unresolved-base');
        expect(inheritanceValue(record('Child', 'MissingBase').maxDepth)).toBe('unresolved-base');
        // Every public row is schema-valid and carries a target only when resolved.
        for (const row of result.graphs) {
          expect(RelationshipResultSchema.safeParse(row).success).toBe(true);
          expect('to' in row).toBe(row.resolution === 'resolved-unique');
        }
        // Inherited declarations never change the contract's own callable totals.
        const parent = harness.declaration('contracts/Base.sol', 'Parent');
        expect(
          contractNodes(harness).find((node) => node.id === parent.id)?.callableIds,
        ).toHaveLength(2);
      },
    );
  });

  it('keeps cyclic and descendant measurements unavailable while independent contracts stay measurable', async () => {
    const cycles = await fixture('hierarchy/Cycles.sol');
    await withSemantic([{ path: 'contracts/Cycles.sol', text: cycles }], {}, async (harness) => {
      const outcome = requireBound(await harness.session.analyzeSemanticComponent(harness.input()));
      const result = buildInheritance({
        contracts: contractNodes(harness),
        sites: toBaseSiteFacts(inheritanceFiles(harness), outcome.baseSites),
        allowance: new GraphAllowance(100_000),
      });
      const record = (name: string) => {
        const target = contractIdOf(harness, 'contracts/Cycles.sol', name);
        const found = result.inheritance.find((item) => item.contractId === target);
        if (found === undefined) throw new Error(`No record for ${name}.`);
        return inheritanceValue(found.ancestorIds);
      };
      for (const name of ['CycleA', 'CycleB', 'SelfLoop', 'Heir']) {
        expect(record(name)).toBe('inheritance-cycle');
      }
      expect(record('Independent')).toEqual([]);
      expect(record('IndependentChild')).toEqual([
        contractIdOf(harness, 'contracts/Cycles.sol', 'Independent'),
      ]);
      // Edges are all resolved: the cycle is a graph property, not a missing reference.
      expect(result.edges.every((edge) => edge.resolution === 'resolved-unique')).toBe(true);
    });
  });

  it('classifies native calls without inventing dispatch or builtin certainty', async () => {
    const calls = await fixture('calls/Calls.sol');
    await withSemantic([{ path: 'contracts/Calls.sol', text: calls }], {}, async (harness) => {
      const outcome = requireBound(await harness.session.analyzeSemanticComponent(harness.input()));
      const member = harness.member('contracts/Calls.sol');
      const file: CallFileInput = {
        fileId: member.source.fileId,
        canonicalPath: 'contracts/Calls.sol',
        syntax: member.syntax,
        semantics: 'bound',
      };
      const result = buildCallFacts({
        files: [file],
        sites: outcome.callSites,
        allowance: new GraphAllowance(100_000),
      });
      expect(result.limited).toBe(false);
      const eventCount = member.syntax.events.filter((event) => event.kind === 'call-site').length;
      expect(result.facts).toHaveLength(eventCount);
      const factFor = (needle: string) => {
        const text = Buffer.from(calls, 'utf8');
        const exact = result.facts.find(
          (fact) =>
            text.subarray(fact.range.startByte, fact.range.endByte).toString('utf8').trim() ===
            needle,
        );
        if (exact === undefined) throw new Error(`No fact for ${needle}.`);
        return exact;
      };
      const callableNamed = (name: string, owner: string | null) =>
        member.syntax.declarations.find(
          (declaration) =>
            declaration.name === name &&
            (owner === null
              ? declaration.contractId === null
              : declaration.contractId === contractIdOf(harness, 'contracts/Calls.sol', owner)),
        )?.callableId;

      expect(factFor('identity(1)')).toMatchObject({
        symbol: 'unique',
        dispatch: 'dynamic',
        symbolTarget: callableNamed('identity', 'Caller'),
        limitation: 'virtual-dispatch-unproven',
      });
      const nested = result.facts.filter((fact) =>
        Buffer.from(calls, 'utf8')
          .subarray(fact.range.startByte, fact.range.endByte)
          .toString('utf8')
          .includes('identity(identity(2))'),
      );
      expect(nested.length).toBeGreaterThan(0);
      expect(new Set(result.facts.map((fact) => fact.id)).size).toBe(result.facts.length);
      expect(factFor('freeAdd(1, 2)')).toMatchObject({
        symbol: 'unique',
        dispatch: 'static',
        symbolTarget: callableNamed('freeAdd', null),
      });
      expect(factFor('Helpers.twice(2)')).toMatchObject({
        symbol: 'unique',
        dispatch: 'static',
        symbolTarget: callableNamed('twice', 'Helpers'),
      });
      expect(factFor('remote.ping(1)')).toMatchObject({
        symbol: 'unique',
        dispatch: 'dynamic',
        symbolTarget: callableNamed('ping', 'IRemote'),
        limitation: 'external-receiver-unproven',
      });
      expect(factFor('this.visible()')).toMatchObject({
        symbol: 'unique',
        dispatch: 'dynamic',
        limitation: 'this-or-super-dispatch',
      });
      expect(factFor('overloaded(1)')).toMatchObject({ symbol: 'candidates', dispatch: 'unknown' });
      expect(factFor('overloaded(1)').candidateTargets).toHaveLength(2);
      expect(factFor('fp(1)')).toMatchObject({ symbol: 'non-callable', dispatch: 'unknown' });
      expect(factFor('uint160(target)')).toMatchObject({ symbol: 'type-conversion' });
      expect(factFor('require(ok)')).toMatchObject({ symbol: 'builtin', builtin: null });

      // Built-in low-level members are confirmed only through built-in bindings; custom
      // transfer/call functions bind to user definitions and are rejected.
      for (const needle of [
        'target.call(data)',
        'target.delegatecall(data)',
        'target.staticcall(data)',
        'receiver.transfer(1)',
        'receiver.send(1)',
        'target.call{value: 1}(data)',
      ]) {
        expect(factFor(needle)).toMatchObject({ symbol: 'builtin', builtin: 'confirmed' });
      }
      expect(factFor('token.transfer(to, 1)')).toMatchObject({
        symbol: 'unique',
        builtin: 'rejected',
        dispatch: 'dynamic',
      });
      expect(factFor('CallLib.call(target)')).toMatchObject({
        symbol: 'unique',
        builtin: 'rejected',
        dispatch: 'static',
      });
      const counts = countConfirmedBuiltins({
        files: [{ fileId: file.fileId, syntax: file.syntax, semantics: 'bound' }],
        facts: result.facts,
      });
      expect(counts).toMatchObject([
        { confirmedBuiltinLowLevelCalls: { status: 'measured', value: 6 } },
      ]);
      // The syntax-level candidate count is untouched by confirmation.
      const candidates = member.syntax.events.filter(
        (event) =>
          event.kind === 'call-site' &&
          event.attributes.some((a) => a.key === 'low-level-candidate' && a.value === true),
      );
      expect(candidates).toHaveLength(8);
      for (const row of result.graphs) {
        expect(RelationshipResultSchema.safeParse(row).success).toBe(true);
        expect('to' in row).toBe(row.resolution === 'resolved-unique');
      }
      const resolved = result.graphs.filter((row) => row.resolution === 'resolved-unique');
      expect(resolved).toHaveLength(3);
    });
  });
});

interface PipelineOptions {
  readonly config?: Record<string, unknown>;
  readonly limits?: Partial<AnalysisLimits>;
  readonly signal?: AbortSignal;
}

interface PipelineHarness {
  readonly root: string;
  readonly input: RelationshipInput;
}

async function withPipeline<T>(
  files: Readonly<Record<string, string>>,
  options: PipelineOptions,
  body: (harness: PipelineHarness) => Promise<T>,
  prepare?: (root: string) => Promise<void>,
): Promise<T> {
  const root = await createProject('audit-estimator-pipeline-');
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
    const defaults = trustedDefaults(testLimits(options.limits ?? {}));
    const operational = await resolveConfig({ root, defaults });
    const budget = createDiscoveryBudget(operational.config.analysis.limits, options.signal);
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
      const manifestEntry = discovery.manifest.entries.find((entry) => entry.fileId === fileId);
      if (manifestEntry === undefined) throw new Error('Missing manifest entry for snapshot.');
      return { fileId, snapshot, manifestEntry };
    });
    const initialSyntax = await session.analyzeSources(sources);
    return await body({
      root,
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

const SOL = 'pragma solidity ^0.8.20;\n';
const CLEAN_PROJECT: Readonly<Record<string, string>> = {
  'src/Base.sol': `${SOL}contract Base {\n    function helper() internal pure returns (uint256) { return 1; }\n}\n`,
  'src/Lib.sol': `${SOL}library Lib {\n    function twice(uint256 v) internal pure returns (uint256) { return v * 2; }\n}\n`,
  'src/Unused.sol': `${SOL}contract Unused {}\n`,
  'shared/Ext.sol': `${SOL}contract Ext {}\n`,
  'node_modules/dep/Dep.sol': `${SOL}contract Dep {}\n`,
  'src/Token.sol':
    `${SOL}import "./Base.sol";\nimport "./Lib.sol";\nimport "./Unused.sol";\nimport "../shared/Ext.sol";\nimport "dep/Dep.sol";\n` +
    'contract Token is Base, Ext, Dep {\n    function run() internal pure returns (uint256) { return Lib.twice(helper()); }\n}\n',
};

describe('relationship pipeline', () => {
  it('derives deduplicated pairs, builtin counts and completeness for a clean project', async () => {
    await withPipeline(CLEAN_PROJECT, {}, async ({ input }) => {
      const analysis = await resolveRelationships(input);
      const id = (path: string) => fileIdentity(path);
      const contract = (path: string, name: string) => {
        const source = analysis.sources.find((item) => item.fileId === id(path));
        const syntax = analysis.syntax.files.find((item) => item.fileId === id(path));
        const found =
          syntax?.status === 'parsed'
            ? syntax.declarations.find((declaration) => declaration.name === name)
            : undefined;
        if (source === undefined || found === undefined) throw new Error(`Missing ${name}.`);
        return found.id as ContractId;
      };
      const token = contract('src/Token.sol', 'Token');

      expect(analysis.requiredAnalysisComplete).toBe(true);
      expect(analysis.hasUnknownSemantics).toBe(false);
      // Every file is reachable from Token, so one component holds the whole closure and the
      // highest common installed grammar is selected (the default config version is no constraint).
      expect(analysis.components).toHaveLength(1);
      const tokenComponent = analysis.components[0];
      expect(tokenComponent).toMatchObject({
        id: id('node_modules/dep/Dep.sol'),
        status: 'available',
        reason: null,
        grammar: '0.8.37',
      });
      expect(tokenComponent?.members).toEqual(
        [
          'node_modules/dep/Dep.sol',
          'shared/Ext.sol',
          'src/Base.sol',
          'src/Lib.sol',
          'src/Token.sol',
          'src/Unused.sol',
        ].map(id),
      );

      // Roles: scoped first-party sources, a disclosed first-party context, third-party context.
      expect(analysis.manifest.scopedFileIds).toEqual(
        ['src/Base.sol', 'src/Lib.sol', 'src/Token.sol', 'src/Unused.sol'].map(id),
      );
      expect(analysis.manifest.contextFileIds).toEqual(
        ['node_modules/dep/Dep.sol', 'shared/Ext.sol'].map(id),
      );
      expect(analysis.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'PARTIAL_ANALYSIS', fileId: id('shared/Ext.sol') }),
      );

      // Pairs: direct inheritance and the static library call only; imports never create pairs.
      const pairKey = (pair: { leftId: string; rightId: string; kinds: readonly string[] }) => [
        pair.leftId,
        pair.rightId,
        pair.kinds.join('+'),
      ];
      expect(analysis.scopedPairs.map(pairKey)).toEqual(
        [
          [token, contract('src/Base.sol', 'Base'), 'inheritance'],
          [token, contract('src/Lib.sol', 'Lib'), 'call'],
        ].sort((left, right) => ascending(left[1], right[1])),
      );
      expect(analysis.contextPairs.map(pairKey)).toEqual(
        [
          [token, contract('node_modules/dep/Dep.sol', 'Dep'), 'inheritance'],
          [token, contract('shared/Ext.sol', 'Ext'), 'inheritance'],
        ].sort((left, right) => ascending(left[1], right[1])),
      );
      const allPairs = [...analysis.scopedPairs, ...analysis.contextPairs];
      expect(allPairs.some((pair) => pair.rightId === contract('src/Unused.sol', 'Unused'))).toBe(
        false,
      );
      expect(allPairs.every((pair) => pair.leftId !== pair.rightId)).toBe(true);
      const scopedKeys = analysis.scopedPairs.map((pair) => `${pair.leftId}|${pair.rightId}`);
      expect(
        analysis.contextPairs.some((pair) => scopedKeys.includes(`${pair.leftId}|${pair.rightId}`)),
      ).toBe(false);

      // Token's ancestors are exactly its three direct bases; inherited source is not re-counted.
      const record = analysis.inheritance.find((item) => item.contractId === token);
      expect(
        inheritanceValue(record?.ancestorIds ?? { status: 'unavailable', reason: 'x' }),
      ).toEqual(
        [
          contract('src/Base.sol', 'Base'),
          contract('node_modules/dep/Dep.sol', 'Dep'),
          contract('shared/Ext.sol', 'Ext'),
        ].sort(ascending),
      );
      expect(analysis.directBaseEdges.filter((edge) => edge.contractId === token)).toHaveLength(3);

      // Built-in counts are measured zero (no candidates), separate from syntax candidates.
      expect(
        analysis.confirmedBuiltinLowLevelCalls.every(
          (item) =>
            item.confirmedBuiltinLowLevelCalls.status === 'measured' &&
            item.confirmedBuiltinLowLevelCalls.value === 0,
        ),
      ).toBe(true);
      expect(analysis.confirmedBuiltinLowLevelCalls).toHaveLength(analysis.sources.length);

      // Public graph and import rows validate and carry targets only when resolved.
      for (const row of analysis.graphs) {
        expect(RelationshipResultSchema.safeParse(row).success).toBe(true);
        expect('to' in row).toBe(row.resolution === 'resolved-unique');
      }
      for (const reference of analysis.imports) {
        expect(ImportReferenceSchema.safeParse(reference).success).toBe(true);
      }
      expect(ScopeManifestSchema.safeParse(analysis.manifest).success).toBe(true);
      expect(analysis.graphs.filter((row) => row.kind === 'import')).toHaveLength(5);

      // Shared accounting: unique syntax counters, separate semantic nodes, original syntax kept.
      const counters = input.session.counters;
      expect(counters.syntaxFiles).toBe(analysis.sources.length);
      expect(analysis.syntax.visitedNodes).toBe(counters.syntaxNodes);
      expect(counters.semanticNodes).toBeGreaterThan(0);
      for (const outcome of input.initialSyntax.files) {
        expect(analysis.syntax.files.find((item) => item.fileId === outcome.fileId)).toBe(outcome);
      }
      expect(analysis.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('keeps dynamic receivers as unknown semantics, not failures, and charges no pair', async () => {
    const files = {
      'src/Remote.sol': `${SOL}interface IRemote {\n    function ping() external returns (uint256);\n}\n`,
      'src/Caller.sol':
        `${SOL}import "./Remote.sol";\ncontract Caller {\n    IRemote remote;\n` +
        '    function go(address a) external returns (uint256) {\n        a.call("");\n        return remote.ping();\n    }\n}\n',
    };
    await withPipeline(files, {}, async ({ input }) => {
      const analysis = await resolveRelationships(input);
      expect(analysis.requiredAnalysisComplete).toBe(true);
      expect(analysis.hasUnknownSemantics).toBe(true);
      expect(analysis.scopedPairs).toEqual([]);
      expect(analysis.contextPairs).toEqual([]);
      const ping = analysis.callSites.find((fact) => fact.syntax.memberName === 'ping');
      expect(ping).toMatchObject({
        symbol: 'unique',
        dispatch: 'dynamic',
        limitation: 'external-receiver-unproven',
      });
      const row = analysis.graphs.find((item) => item.id === ping?.edgeId);
      expect(row).toMatchObject({ kind: 'call', resolution: 'unsupported' });
      expect(row !== undefined && 'to' in row).toBe(false);
      const caller = analysis.confirmedBuiltinLowLevelCalls.find(
        (item) => item.fileId === fileIdentity('src/Caller.sol'),
      );
      expect(caller?.confirmedBuiltinLowLevelCalls).toMatchObject({ status: 'measured', value: 1 });
    });
  });

  it('marks an unavailable component incomplete while independent components stay analyzed', async () => {
    const files = {
      'src/A.sol': `${SOL}import "./Missing.sol";\nimport "./B.sol";\ncontract A is B {}\n`,
      'src/B.sol': `${SOL}contract B {}\n`,
      'src/Solo.sol':
        `${SOL}contract Solo {\n    function f() internal pure {}\n    function g() internal pure { f(); }\n}\n` +
        'contract SoloChild is Solo {}\n',
    };
    await withPipeline(files, {}, async ({ input }) => {
      const analysis = await resolveRelationships(input);
      const id = (path: string) => fileIdentity(path);
      expect(analysis.requiredAnalysisComplete).toBe(false);
      expect(analysis.hasUnknownSemantics).toBe(true);
      const component = (path: string) =>
        analysis.components.find((item) => item.members.includes(id(path)));
      expect(component('src/A.sol')).toMatchObject({
        status: 'unavailable',
        reason: 'unresolved-import',
        grammar: null,
      });
      expect(component('src/Solo.sol')).toMatchObject({ status: 'available', grammar: '0.8.37' });
      // The failed component keeps its syntax evidence; semantic facts are unavailable, not zero.
      const a = analysis.syntax.files.find((item) => item.fileId === id('src/A.sol'));
      expect(a?.status).toBe('parsed');
      expect(input.initialSyntax.files.find((item) => item.fileId === id('src/A.sol'))).toBe(a);
      const builtins = (path: string) =>
        analysis.confirmedBuiltinLowLevelCalls.find((item) => item.fileId === id(path))
          ?.confirmedBuiltinLowLevelCalls;
      expect(builtins('src/A.sol')).toEqual({
        status: 'unavailable',
        reason: 'semantics-unavailable',
      });
      expect(builtins('src/Solo.sol')).toMatchObject({ status: 'measured', value: 0 });
      const soloChild = analysis.inheritance.find(
        (item) =>
          item.fileId === id('src/Solo.sol') &&
          item.maxDepth.status === 'measured' &&
          item.maxDepth.value === 1,
      );
      expect(soloChild).toBeDefined();
      const contractA = analysis.inheritance.find((item) => item.fileId === id('src/A.sol'));
      expect(contractA?.ancestorIds).toEqual({
        status: 'unavailable',
        reason: 'semantics-unavailable',
      });
      expect(analysis.scopedPairs.map((pair) => pair.kinds)).toEqual([['inheritance']]);
      expect(analysis.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'IMPORT_UNRESOLVED', fileId: id('src/A.sol') }),
      );
      expect(analysis.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'SEMANTICS_UNAVAILABLE', fileId: id('src/A.sol') }),
      );
      expect(analysis.callSites.filter((fact) => fact.fileId === id('src/A.sol'))).toEqual([]);
      expect(analysis.callSites.filter((fact) => fact.fileId === id('src/Solo.sol'))).toHaveLength(
        1,
      );
    });
  });

  it('derives exact direct pairs from native hierarchy fixtures without transitive or alias pairs', async () => {
    const base = await fixture('hierarchy/Base.sol');
    const child = await fixture('hierarchy/Child.sol');
    await withPipeline({ 'src/Base.sol': base, 'src/Child.sol': child }, {}, async ({ input }) => {
      const analysis = await resolveRelationships(input);
      const name = (path: string, contractName: string) => {
        const syntax = analysis.syntax.files.find((item) => item.fileId === fileIdentity(path));
        const found =
          syntax?.status === 'parsed'
            ? syntax.declarations.find((declaration) => declaration.name === contractName)
            : undefined;
        if (found === undefined) throw new Error(`Missing ${contractName}.`);
        return found.id as ContractId;
      };
      const pair = (leftPath: string, left: string, rightPath: string, right: string) =>
        `${name(leftPath, left)}|${name(rightPath, right)}`;
      const expected = [
        pair('src/Child.sol', 'Direct', 'src/Base.sol', 'Parent'),
        pair('src/Child.sol', 'ViaNamespace', 'src/Base.sol', 'Parent'),
        pair('src/Child.sol', 'Grandchild', 'src/Child.sol', 'Direct'),
        pair('src/Child.sol', 'Grandchild', 'src/Base.sol', 'Diamond'),
        pair('src/Base.sol', 'DiamondLeft', 'src/Base.sol', 'DiamondBase'),
        pair('src/Base.sol', 'DiamondRight', 'src/Base.sol', 'DiamondBase'),
        pair('src/Base.sol', 'Diamond', 'src/Base.sol', 'DiamondLeft'),
        pair('src/Base.sol', 'Diamond', 'src/Base.sol', 'DiamondRight'),
        pair('src/Base.sol', 'IDerived', 'src/Base.sol', 'IBase'),
      ].sort(ascending);
      expect(
        analysis.scopedPairs.map((item) => `${item.leftId}|${item.rightId}`).sort(ascending),
      ).toEqual(expected);
      expect(analysis.scopedPairs.every((item) => item.kinds.join() === 'inheritance')).toBe(true);
      expect(analysis.contextPairs).toEqual([]);
      // Alias and missing bases are observations, never pairs; they make the analysis incomplete.
      expect(analysis.requiredAnalysisComplete).toBe(false);
      expect(analysis.hasUnknownSemantics).toBe(true);
      expect(analysis.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'SEMANTICS_UNAVAILABLE',
          details: [
            { key: 'measurement', value: 'inheritance' },
            { key: 'reason', value: 'unresolved-base' },
          ],
        }),
      );
    });
  });

  it('removes invalidated ownership from scoped eligibility and pairs', async () => {
    const files = {
      'src/Shared.sol': `${SOL}contract Shared {}\n`,
      'src/Main.sol': `${SOL}import "../lib/Shared.sol";\ncontract Main is Shared {}\n`,
    };
    let linked = false;
    await withPipeline(
      files,
      { config: { scope: { sourceRoots: ['src'] } } },
      async ({ input }) => {
        expect(linked || process.platform === 'win32').toBe(true);
        if (!linked) return;
        const analysis = await resolveRelationships(input);
        const shared = fileIdentity('src/Shared.sol');
        expect(analysis.invalidatedScopedFileIds).toEqual([shared]);
        expect(analysis.manifest.scopedFileIds).toEqual([fileIdentity('src/Main.sol')]);
        expect(analysis.requiredAnalysisComplete).toBe(false);
        expect(analysis.hasUnknownSemantics).toBe(true);
        expect(analysis.scopedPairs).toEqual([]);
        expect(analysis.contextPairs.map((item) => item.kinds)).toEqual([['inheritance']]);
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

  it('reports failed context syntax and mixed grammars as unavailable components', async () => {
    await withPipeline(
      {
        'src/A.sol': `${SOL}import "../shared/Broken.sol";\ncontract A {}\n`,
        'shared/Broken.sol': `${SOL}contract Broken {\n`,
      },
      {},
      async ({ input }) => {
        const analysis = await resolveRelationships(input);
        expect(analysis.requiredAnalysisComplete).toBe(false);
        expect(analysis.hasUnknownSemantics).toBe(true);
        expect(analysis.components).toMatchObject([
          { status: 'unavailable', reason: 'member-syntax-failed' },
        ]);
        expect(analysis.syntax.complete).toBe(false);
        expect(analysis.syntax.files.map((item) => item.status)).toEqual(['failed', 'parsed']);
      },
    );
    await withPipeline(
      {
        'src/A.sol': 'pragma solidity 0.8.37;\nimport "../shared/Old.sol";\ncontract A {}\n',
        'shared/Old.sol': 'pragma solidity 0.7.6;\ncontract Old {}\n',
      },
      {},
      async ({ input }) => {
        const analysis = await resolveRelationships(input);
        expect(analysis.components).toMatchObject([
          { status: 'unavailable', reason: 'no-common-grammar', grammar: null },
        ]);
        expect(analysis.requiredAnalysisComplete).toBe(false);
        // Original per-file selected versions stay distinct from any component grammar.
        const versions = analysis.syntax.files.map((item) =>
          item.status === 'parsed' ? item.version.selectedVersion : null,
        );
        expect(versions).toEqual(['0.7.6', '0.8.37']);
      },
    );
  });

  it('enforces the graph allowance explicitly and propagates cancellation', async () => {
    await withPipeline(CLEAN_PROJECT, { limits: { maxGraphEdges: 5 } }, async ({ input }) => {
      const analysis = await resolveRelationships(input);
      expect(analysis.requiredAnalysisComplete).toBe(false);
      expect(analysis.hasUnknownSemantics).toBe(true);
      expect(analysis.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'LIMIT_EXCEEDED', phase: 'semantics' }),
      );
      expect(analysis.graphs.length).toBeLessThan(5);
    });
    const controller = new AbortController();
    await withPipeline(CLEAN_PROJECT, { signal: controller.signal }, async ({ input }) => {
      controller.abort();
      await expect(resolveRelationships(input)).rejects.toMatchObject({ kind: 'cancelled' });
      await expect(resolveRelationships(input)).rejects.toBeInstanceOf(BudgetError);
    });
  });

  it('is deterministic, fingerprints decisions, and never runs target scripts or config', async () => {
    const results: string[] = [];
    const fingerprints: string[] = [];
    const markers: string[] = [];
    const variants: readonly {
      readonly files: Readonly<Record<string, string>>;
      readonly config?: Record<string, unknown>;
      readonly reverse: boolean;
    }[] = [
      { files: CLEAN_PROJECT, reverse: false },
      { files: CLEAN_PROJECT, reverse: true },
      { files: { ...CLEAN_PROJECT, 'shared/Ext.sol': `${SOL}contract Ext { }\n` }, reverse: false },
      {
        files: CLEAN_PROJECT,
        config: { imports: { remappings: [{ prefix: 'zzz/', target: 'shared' }] } },
        reverse: false,
      },
    ];
    for (const variant of variants) {
      await withPipeline(
        {
          ...variant.files,
          'package.json': '{"scripts":{"preinstall":"node marker.js","build":"node marker.js"}}',
          'hardhat.config.js': "require('node:fs').writeFileSync('marker-hardhat', 'ran');",
          'marker.js': "require('node:fs').writeFileSync('marker-script', 'ran');",
        },
        variant.config === undefined ? {} : { config: variant.config },
        async ({ root, input }) => {
          const prepared: RelationshipInput = variant.reverse
            ? {
                ...input,
                discovery: {
                  ...input.discovery,
                  snapshots: [...input.discovery.snapshots].reverse(),
                  manifest: {
                    ...input.discovery.manifest,
                    entries: [...input.discovery.manifest.entries].reverse(),
                  },
                },
              }
            : input;
          const analysis = await resolveRelationships(prepared);
          results.push(
            JSON.stringify({
              manifest: analysis.manifest,
              imports: analysis.imports,
              graphs: analysis.graphs,
              components: analysis.components,
              inheritance: analysis.inheritance,
              callSites: analysis.callSites,
              scoped: analysis.scopedPairs,
              context: analysis.contextPairs,
              builtins: analysis.confirmedBuiltinLowLevelCalls,
              diagnostics: analysis.diagnostics,
              flags: [analysis.requiredAnalysisComplete, analysis.hasUnknownSemantics],
            }),
          );
          fingerprints.push(analysis.fingerprint);
          for (const marker of ['marker-hardhat', 'marker-script']) {
            try {
              await access(absoluteProjectPath(root, marker));
              markers.push(marker);
            } catch {
              // The marker is absent, as required.
            }
          }
        },
      );
    }
    expect(markers).toEqual([]);
    expect(results[0]).toBe(results[1]);
    expect(fingerprints[0]).toBe(fingerprints[1]);
    expect(new Set(fingerprints).size).toBe(3);
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
