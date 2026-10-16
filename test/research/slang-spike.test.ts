import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ContractDefinition,
  ErrorDefinition,
  InterfaceDefinition,
  LibraryDefinition,
  SourceUnit,
  StateVariableDefinition,
} from '@nomicfoundation/slang/ast';
import { CompilationBuilder } from '@nomicfoundation/slang/compilation';
import type { CompilationUnit } from '@nomicfoundation/slang/compilation';
import type { BindingLocation } from '@nomicfoundation/slang/bindings';
import { NonterminalKind, TerminalKind, TerminalKindExtensions } from '@nomicfoundation/slang/cst';
import type { Cursor, TextRange } from '@nomicfoundation/slang/cst';
import { Parser } from '@nomicfoundation/slang/parser';
import { LanguageFacts } from '@nomicfoundation/slang/utils';
import fixtureManifest from '../fixtures/manifest.json' with { type: 'json' };
import { bundleTestChild } from '../helpers/bundle-child.ts';
import {
  decodeSource,
  mapRangeToOriginal,
  parserTextForCallback,
  reconstructOriginalText,
} from './slang-source-view.ts';
import { beforeAll, describe, expect, it } from 'vitest';

const parserFixtures = new URL('../fixtures/parser/', import.meta.url);

async function readFixture(name: string): Promise<string> {
  return readFile(new URL(name, parserFixtures), 'utf8');
}

const researchChildPath = fileURLToPath(
  new URL('../../.vitest/research/slang-child.mjs', import.meta.url),
);

describe('isolation and esm', () => {
  beforeAll(() => {
    bundleTestChild('test/research/slang-child.ts', '.vitest/research');
  });

  it('loads Slang as plain Node ESM and survives malformed and invalid dependency input', async () => {
    const child = spawn(process.execPath, ['--max-old-space-size=64', researchChildPath], {
      env: sanitizedNodeEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = createChildClient(child);
    try {
      const malformed = await client.request({
        action: 'parse',
        id: 1,
        version: '0.8.37',
        source: 'contract',
      });
      expect(malformed.valid).toBe(false);
      expect(malformed.diagnostics).toHaveLength(1);

      const valid = await client.request({
        action: 'parse',
        id: 2,
        version: '0.8.37',
        source: 'contract Isolated {}',
      });
      expect(valid.valid).toBe(true);
      expect(valid.unparse).toBe('contract Isolated {}');

      const serialization = await client.request({
        action: 'serialize',
        id: 3,
        version: '0.8.37',
        source: 'contract TransferCheck {}',
      });
      expect(serialization.serializedOutputHasIsValid).toBe(false);
      expect(serialization.jsonBytes).toBe(25);
      expect(serialization.structuredCloneResult).toBe('plain-object');

      const invalidBinding = await client.request({
        action: 'binding',
        id: 4,
        root: await readFixture('binding-invalid-root.sol'),
        dependency: await readFixture('binding-invalid-dependency.sol'),
      });
      expect(invalidBinding.graphAccess).toBe('completed');
      expect(invalidBinding.fileDiagnostics).toEqual([
        {
          id: '/trusted/dependency.sol',
          messages: [
            'Expected AddressKeyword or BoolKeyword or BytesKeyword or CloseParen or FixedKeyword or FunctionKeyword or Identifier or IntKeyword or MappingKeyword or StringKeyword or UfixedKeyword or UintKeyword.',
          ],
        },
        { id: '/trusted/root.sol', messages: [] },
      ]);
      expect(invalidBinding.unresolvedBrokenReference).toBe(true);

      for (let id = 10; id < 22; id += 1) {
        const batch = await client.request({
          action: 'parse',
          id,
          version: '0.8.37',
          source: `contract Batch${id} { uint value; }`,
        });
        expect(batch.valid).toBe(true);
      }
    } finally {
      child.stdin.end();
      await waitForChildExit(child);
    }
    expect(child.exitCode).toBe(0);
    expect(processExists(child.pid)).toBe(false);
  });

  it('measures synthetic batches as advisory and kills a stalled child within a generous deadline', async () => {
    const child = spawn(process.execPath, ['--max-old-space-size=64', researchChildPath], {
      env: sanitizedNodeEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = createChildClient(child);
    try {
      const small = await client.request({
        action: 'measure',
        id: 30,
        declarations: 100,
        iterations: 3,
      });
      const large = await client.request({
        action: 'measure',
        id: 31,
        declarations: 5000,
        iterations: 2,
      });
      expect(small.advisory).toBe(true);
      expect(large.advisory).toBe(true);
      expect(small.errors).toBe(0);
      expect(large.errors).toBe(0);
      expect(small.sourceBytes).toBeLessThan(large.sourceBytes as number);
      expect(small.elapsedMs).toEqual(expect.any(Number));
      expect(large.elapsedMs).toEqual(expect.any(Number));
    } finally {
      child.stdin.end();
      await waitForChildExit(child);
    }

    const stalled = spawn(process.execPath, [researchChildPath], {
      env: sanitizedNodeEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stalledClient = createChildClient(stalled);
    let deadlineStart = 0;
    try {
      const acknowledgement = await stalledClient.request({ action: 'stall', id: 40 });
      expect(acknowledgement.stalled).toBe(true);
      deadlineStart = performance.now();
      await expect(
        stalledClient.request(
          {
            action: 'parse',
            id: 41,
            version: '0.8.37',
            source: 'contract DeadlineProbe {}',
          },
          350,
        ),
      ).rejects.toThrow('Child did not respond within 350 ms.');
    } finally {
      if (stalled.exitCode === null && stalled.signalCode === null) stalled.kill('SIGKILL');
      await waitForChildExit(stalled);
    }
    expect(performance.now() - deadlineStart).toBeLessThan(5_000);
    expect(stalled.signalCode).toBe('SIGKILL');
    expect(processExists(stalled.pid)).toBe(false);
  });
});

describe('api and versions', () => {
  it('creates parsers, exposes the installed grammar range, and returns typed AST fields', () => {
    const versions = LanguageFacts.allVersions();

    expect(LanguageFacts.earliestVersion()).toBe('0.4.11');
    expect(LanguageFacts.latestVersion()).toBe('0.8.37');
    expect(versions).toHaveLength(92);
    expect(versions).toContain('0.5.0');
    expect(versions).toContain('0.6.0');
    expect(versions).toContain('0.7.0');
    expect(versions).toContain('0.8.37');
    expect(Parser.create('0.8.37').languageVersion).toBe('0.8.37');
    expect(LanguageFacts.inferLanguageVersions('pragma solidity >=0.8.20 <0.8.30;')).toEqual([
      '0.8.20',
      '0.8.21',
      '0.8.22',
      '0.8.23',
      '0.8.24',
      '0.8.25',
      '0.8.26',
      '0.8.27',
      '0.8.28',
      '0.8.29',
    ]);

    const output = Parser.create('0.8.37').parseFileContents('contract ApiSample { uint value; }');
    expect(output.isValid()).toBe(true);

    const sourceUnit = new SourceUnit(output.tree);
    const contractMember = sourceUnit.members.items.find(
      (member) => member.variant instanceof ContractDefinition,
    );
    if (!(contractMember?.variant instanceof ContractDefinition)) {
      throw new Error('Expected a typed ContractDefinition AST member.');
    }

    expect(contractMember.variant.name.unparse()).toBe('ApiSample');
    const stateVariable = contractMember.variant.members.items.find(
      (member) => member.variant instanceof StateVariableDefinition,
    );
    if (!(stateVariable?.variant instanceof StateVariableDefinition)) {
      throw new Error('Expected a typed StateVariableDefinition AST member.');
    }
    expect(stateVariable.variant.name.unparse()).toBe('value');

    const invalid = Parser.create('0.8.37').parseFileContents('contract');
    expect(invalid.isValid()).toBe(false);
    expect(invalid.errors()[0]?.message).toBe('Expected Identifier.');
  });

  it('loads imports through caller-provided in-memory callbacks', async () => {
    const files = new Map([
      ['/virtual/Root.sol', 'pragma solidity 0.8.37; import "./Library.sol"; contract Root {}'],
      ['/virtual/Library.sol', 'pragma solidity 0.8.37; library Library {}'],
    ]);
    const resolvedImports: string[] = [];
    const builder = CompilationBuilder.create({
      languageVersion: '0.8.37',
      readFile: async (fileId) => files.get(fileId),
      resolveImport: async (sourceFileId, importPath) => {
        expect(sourceFileId).toBe('/virtual/Root.sol');
        expect(importPath.node.unparse()).toBe('"./Library.sol"');
        resolvedImports.push(importPath.node.unparse());
        return '/virtual/Library.sol';
      },
    });

    await builder.addFile('/virtual/Root.sol');
    const unit = builder.build();

    expect(resolvedImports).toEqual(['"./Library.sol"']);
    expect(
      unit
        .files()
        .map((file) => file.id)
        .sort(),
    ).toEqual(['/virtual/Library.sol', '/virtual/Root.sol']);
  });
});

describe('semantic capabilities', () => {
  it('reports exact binding targets and leaves ambiguous or unresolved edges explicit', async () => {
    const fileNames = [
      'binding-base.sol',
      'binding-dependency.sol',
      'binding-mixed-version.sol',
      'binding-root.sol',
    ];
    const files = new Map<string, string>();
    for (const name of fileNames) files.set(`/virtual/${name}`, await readFixture(name));
    const importTargets = new Map([
      ['"./binding-base.sol"', '/virtual/binding-base.sol'],
      ['"./binding-mixed-version.sol"', '/virtual/binding-mixed-version.sol'],
      ['"./binding-dependency.sol"', '/virtual/binding-dependency.sol'],
    ]);
    const builder = CompilationBuilder.create({
      languageVersion: '0.8.37',
      readFile: async (fileId) => {
        const original = files.get(fileId);
        return original === undefined ? undefined : parserTextForCallback(original);
      },
      resolveImport: async (_sourceFileId, importPath) =>
        importTargets.get(importPath.node.unparse()),
    });
    await builder.addFile('/virtual/binding-root.sol');
    const unit = builder.build();
    const graph = unit.bindingGraph;
    const rootFile = requireUnitFile(unit, '/virtual/binding-root.sol');
    const baseFile = requireUnitFile(unit, '/virtual/binding-base.sol');
    const dependencyFile = requireUnitFile(unit, '/virtual/binding-dependency.sol');
    const root = files.get('/virtual/binding-root.sol');
    const base = files.get('/virtual/binding-base.sol');
    const dependency = files.get('/virtual/binding-dependency.sol');
    const mixed = files.get('/virtual/binding-mixed-version.sol');
    if (
      root === undefined ||
      base === undefined ||
      dependency === undefined ||
      mixed === undefined
    ) {
      throw new Error('Expected all in-memory semantic fixture contents.');
    }

    expect(
      unit
        .files()
        .map((file) => file.id)
        .sort(),
    ).toEqual([
      '/virtual/binding-base.sol',
      '/virtual/binding-dependency.sol',
      '/virtual/binding-mixed-version.sol',
      '/virtual/binding-root.sol',
    ]);
    expect(unit.files().flatMap((file) => file.errors())).toEqual([]);

    const baseSame = cursorAt(baseFile.createTreeCursor(), 'SameName', base.indexOf('SameName'));
    const dependencySame = cursorAt(
      dependencyFile.createTreeCursor(),
      'SameName',
      dependency.indexOf('SameName'),
    );
    expect(definitionTarget(graph, baseSame)).toEqual({
      fileId: '/virtual/binding-base.sol',
      utf8: base.indexOf('SameName'),
      text: 'SameName',
    });
    expect(definitionTarget(graph, dependencySame)).toEqual({
      fileId: '/virtual/binding-dependency.sol',
      utf8: dependency.indexOf('SameName'),
      text: 'SameName',
    });

    const diamondLeft = cursorAt(
      baseFile.createTreeCursor(),
      'DiamondLeft',
      base.indexOf('DiamondLeft', base.indexOf('contract Diamond is')),
    );
    const diamondRight = cursorAt(
      baseFile.createTreeCursor(),
      'DiamondRight',
      base.indexOf('DiamondRight', base.indexOf('contract Diamond is')),
    );
    expect(referenceTargets(graph, diamondLeft)).toEqual([
      {
        fileId: '/virtual/binding-base.sol',
        utf8: base.indexOf('DiamondLeft'),
        text: 'DiamondLeft',
      },
    ]);
    expect(referenceTargets(graph, diamondRight)).toEqual([
      {
        fileId: '/virtual/binding-base.sol',
        utf8: base.indexOf('DiamondRight'),
        text: 'DiamondRight',
      },
    ]);
    const diamondLeftBase = cursorAt(
      baseFile.createTreeCursor(),
      'DiamondBase',
      base.indexOf('DiamondBase', base.indexOf('contract DiamondLeft')),
    );
    const diamondRightBase = cursorAt(
      baseFile.createTreeCursor(),
      'DiamondBase',
      base.indexOf('DiamondBase', base.indexOf('contract DiamondRight')),
    );
    for (const cursor of [diamondLeftBase, diamondRightBase]) {
      expect(referenceTargets(graph, cursor)).toEqual([
        {
          fileId: '/virtual/binding-base.sol',
          utf8: base.indexOf('DiamondBase'),
          text: 'DiamondBase',
        },
      ]);
    }

    const aliasInheritanceOffset = root.indexOf('AliasParent', root.indexOf('contract Root is'));
    const aliasInheritance = cursorAt(
      rootFile.createTreeCursor(),
      'AliasParent',
      aliasInheritanceOffset,
    );
    expect(referenceTargets(graph, aliasInheritance)).toEqual([
      {
        fileId: '/virtual/binding-root.sol',
        utf8: root.indexOf('AliasParent'),
        text: 'AliasParent',
      },
      {
        fileId: '/virtual/binding-dependency.sol',
        utf8: dependency.indexOf('Parent'),
        text: 'Parent',
      },
    ]);

    const namedUseStart = root.indexOf('function useNamed');
    for (const offset of [
      root.indexOf('NamedSame', namedUseStart),
      root.indexOf('NamedSame', root.indexOf('new NamedSame', namedUseStart)),
    ]) {
      expect(
        referenceTargets(graph, cursorAt(rootFile.createTreeCursor(), 'NamedSame', offset)),
      ).toEqual([
        { fileId: '/virtual/binding-root.sol', utf8: root.indexOf('NamedSame'), text: 'NamedSame' },
        {
          fileId: '/virtual/binding-dependency.sol',
          utf8: dependency.indexOf('SameName'),
          text: 'SameName',
        },
      ]);
    }

    const namespaceUse = root.indexOf('NS.SameName', root.indexOf('function useNamespace')) + 3;
    expect(
      referenceTargets(graph, cursorAt(rootFile.createTreeCursor(), 'SameName', namespaceUse)),
    ).toEqual([
      {
        fileId: '/virtual/binding-dependency.sol',
        utf8: dependency.indexOf('SameName'),
        text: 'SameName',
      },
    ]);

    const inheritedCallOffset = root.indexOf('inherited()', root.indexOf('function inheritedCall'));
    const superCallOffset = root.indexOf('inherited()', root.indexOf('function superCall'));
    expect(
      referenceTargets(
        graph,
        cursorAt(rootFile.createTreeCursor(), 'inherited', inheritedCallOffset),
      ),
    ).toEqual([
      {
        fileId: '/virtual/binding-dependency.sol',
        utf8: dependency.indexOf('inherited'),
        text: 'inherited',
      },
    ]);
    expect(
      referenceTargets(graph, cursorAt(rootFile.createTreeCursor(), 'inherited', superCallOffset)),
    ).toEqual([
      {
        fileId: '/virtual/binding-dependency.sol',
        utf8: dependency.indexOf('inherited'),
        text: 'inherited',
      },
    ]);

    const directChildOffset = dependency.indexOf(
      'Parent',
      dependency.indexOf('contract DirectChild is'),
    );
    expect(
      referenceTargets(
        graph,
        cursorAt(dependencyFile.createTreeCursor(), 'Parent', directChildOffset),
      ),
    ).toEqual([
      {
        fileId: '/virtual/binding-dependency.sol',
        utf8: dependency.indexOf('contract Parent') + 'contract '.length,
        text: 'Parent',
      },
    ]);
    const directInherited = dependency.indexOf(
      'inherited()',
      dependency.indexOf('function inheritedCall'),
    );
    expect(
      referenceTargets(
        graph,
        cursorAt(dependencyFile.createTreeCursor(), 'inherited', directInherited),
      ),
    ).toEqual([
      {
        fileId: '/virtual/binding-dependency.sol',
        utf8: dependency.indexOf('function inherited') + 'function '.length,
        text: 'inherited',
      },
    ]);

    const overloadedUse = root.indexOf('overloaded(1)', root.indexOf('function invokeOverloads'));
    expect(
      referenceTargets(graph, cursorAt(rootFile.createTreeCursor(), 'overloaded', overloadedUse)),
    ).toEqual([
      {
        fileId: '/virtual/binding-root.sol',
        utf8: root.indexOf('function overloaded') + 'function '.length,
        text: 'overloaded',
      },
      {
        fileId: '/virtual/binding-root.sol',
        utf8:
          root.indexOf('function overloaded', root.indexOf('function overloaded') + 1) +
          'function '.length,
        text: 'overloaded',
      },
    ]);

    const identityUse = root.indexOf('identity;', root.indexOf('function functionPointer'));
    expect(
      referenceTargets(graph, cursorAt(rootFile.createTreeCursor(), 'identity', identityUse)),
    ).toEqual([
      {
        fileId: '/virtual/binding-root.sol',
        utf8: root.indexOf('function identity') + 'function '.length,
        text: 'identity',
      },
    ]);
    const pointerUse = root.indexOf('fp(value)', root.indexOf('function callPointer'));
    expect(
      referenceTargets(graph, cursorAt(rootFile.createTreeCursor(), 'fp', pointerUse)),
    ).toEqual([
      { fileId: '/virtual/binding-root.sol', utf8: root.indexOf('fp, uint value'), text: 'fp' },
    ]);

    const thisUse = root.indexOf('visible()', root.indexOf('this.visible'));
    expect(
      referenceTargets(graph, cursorAt(rootFile.createTreeCursor(), 'visible', thisUse)),
    ).toEqual([
      {
        fileId: '/virtual/binding-root.sol',
        utf8: root.indexOf('function visible') + 'function '.length,
        text: 'visible',
      },
    ]);
    const externalCall = root.indexOf('remote.ping') + 'remote.'.length;
    expect(
      referenceTargets(graph, cursorAt(rootFile.createTreeCursor(), 'ping', externalCall)),
    ).toEqual([
      { fileId: '/virtual/binding-dependency.sol', utf8: dependency.indexOf('ping'), text: 'ping' },
    ]);
    const libraryCall = root.indexOf('Helpers.twice') + 'Helpers.'.length;
    expect(
      referenceTargets(graph, cursorAt(rootFile.createTreeCursor(), 'twice', libraryCall)),
    ).toEqual([
      {
        fileId: '/virtual/binding-dependency.sol',
        utf8: dependency.indexOf('twice'),
        text: 'twice',
      },
    ]);

    const mismatchedSources = `${root}\n${files.get('/virtual/binding-mixed-version.sol') ?? ''}`;
    expect(LanguageFacts.inferLanguageVersions(mismatchedSources)).toEqual([]);
    const mixedUse = root.indexOf('Mixed mixed');
    expect(
      referenceTargets(graph, cursorAt(rootFile.createTreeCursor(), 'Mixed', mixedUse)),
    ).toEqual([
      {
        fileId: '/virtual/binding-mixed-version.sol',
        utf8: mixed.indexOf('contract Mixed') + 'contract '.length,
        text: 'Mixed',
      },
    ]);
  });

  it('keeps unresolved imports and missing types unknown instead of guessing by name', async () => {
    const source = await readFixture('binding-unresolved.sol');
    const builder = CompilationBuilder.create({
      languageVersion: '0.8.37',
      readFile: async (fileId) =>
        fileId === '/virtual/binding-unresolved.sol' ? source : undefined,
      resolveImport: async () => undefined,
    });
    await builder.addFile('/virtual/binding-unresolved.sol');
    const unit = builder.build();
    const file = requireUnitFile(unit, '/virtual/binding-unresolved.sol');
    const graph = unit.bindingGraph;
    const missingType = cursorAt(
      file.createTreeCursor(),
      'MissingType',
      source.indexOf('MissingType'),
    );

    expect(unit.files().map((entry) => entry.id)).toEqual(['/virtual/binding-unresolved.sol']);
    expect(file.errors()).toEqual([]);
    expect(referenceTargets(graph, missingType)).toEqual([]);
  });
});

describe('syntax and ranges', () => {
  it('matches the hand-counted version, syntax, and physical-location fixture manifest', async () => {
    for (const fixture of fixtureManifest.fixtures) {
      const bytes = await readFile(new URL(fixture.file, new URL('../fixtures/', import.meta.url)));
      const view = decodeSource(bytes);
      const output = Parser.create(fixture.intendedVersion).parseFileContents(view.parserText);
      const diagnosticMessages = output.errors().map((error) => error.message);
      const inferred = LanguageFacts.inferLanguageVersions(view.parserText);
      const inferredSummary =
        inferred.length === 0
          ? { count: 0 }
          : { count: inferred.length, first: inferred[0], last: inferred.at(-1) };
      const lineBreakCount = view.originalText.match(/\r\n|\r|\n|\u2028|\u2029/g)?.length ?? 0;
      const hasFinalLineBreak = /(?:\r\n|\r|\n|\u2028|\u2029)$/.test(view.originalText);
      const physicalLines = lineBreakCount + (hasFinalLineBreak ? 0 : 1);

      expect(fixture.origin).toBe('original');
      expect(fixture.license).toBe('MIT (proposed)');
      expect(view.originalBytes.byteLength).toBe(fixture.physicalBytes);
      expect(physicalLines).toBe(fixture.physicalLines);
      expect(output.isValid()).toBe(fixture.valid);
      expect(diagnosticMessages).toEqual(fixture.diagnostics);
      expect(inferredSummary).toEqual(fixture.inferredVersions);

      let declarationNames: string[] = [];
      if (fixture.valid) {
        const sourceUnit = new SourceUnit(output.tree);
        declarationNames = sourceUnit.members.items.flatMap((member) => {
          if (
            member.variant instanceof ContractDefinition ||
            member.variant instanceof ErrorDefinition ||
            member.variant instanceof InterfaceDefinition ||
            member.variant instanceof LibraryDefinition
          ) {
            return [member.variant.name.unparse()];
          }
          return [];
        });
      }
      expect(declarationNames).toEqual(fixture.declarations);
    }
  });

  it('exposes import forms, ordinary control nodes, assembly, and Yul through the CST', async () => {
    const view = decodeSource(await readFile(new URL('solidity-0.8.37.sol', parserFixtures)));
    const output = Parser.create('0.8.37').parseFileContents(view.parserText);
    const kinds = new Set<NonterminalKind>();
    const cursor = output.createTreeCursor();
    let hasNext = true;
    while (hasNext) {
      if (cursor.node.isNonterminalNode()) kinds.add(cursor.node.kind);
      hasNext = cursor.goToNext();
    }

    expect(output.isValid()).toBe(true);
    expect(kinds.has(NonterminalKind.ImportDirective)).toBe(true);
    expect(kinds.has(NonterminalKind.IfStatement)).toBe(true);
    expect(kinds.has(NonterminalKind.ForStatement)).toBe(true);
    expect(kinds.has(NonterminalKind.WhileStatement)).toBe(true);
    expect(kinds.has(NonterminalKind.AssemblyStatement)).toBe(true);
    expect(kinds.has(NonterminalKind.YulBlock)).toBe(true);
  });

  it('records that a leading UTF-8 BOM is rejected and omitted from unparse output', async () => {
    const bytes = await readFile(new URL('bom-locations.sol', parserFixtures));
    const source = bytes.toString('utf8');
    const output = Parser.create('0.8.37').parseFileContents(source);
    const [error] = output.errors();

    expect(output.isValid()).toBe(false);
    expect(output.errors()).toHaveLength(1);
    expect(error?.message).toBe(
      'Expected AddressKeyword or BoolKeyword or BytesKeyword or ContractKeyword or EnumKeyword or ErrorKeyword or EventKeyword or FixedKeyword or FunctionKeyword or Identifier or ImportKeyword or IntKeyword or InterfaceKeyword or LibraryKeyword or MappingKeyword or PragmaKeyword or StringKeyword or StructKeyword or TypeKeyword or UfixedKeyword or UintKeyword or UsingKeyword.',
    );
    expect(error?.textRange).toEqual({
      start: { utf8: 0, utf16: 0, line: 0, column: 0 },
      end: { utf8: 60, utf16: 58, line: 2, column: 0 },
    });

    const unparsed = output.tree.unparse();
    expect(Buffer.byteLength(source)).toBe(60);
    expect(Buffer.byteLength(unparsed)).toBe(57);
    expect(Buffer.from(unparsed, 'utf8')).toEqual(bytes.subarray(3));
  });

  it('keeps original bytes while parsing a single stripped leading BOM view', async () => {
    const bytes = await readFile(new URL('bom-locations.sol', parserFixtures));
    const view = decodeSource(bytes);
    const output = Parser.create('0.8.37').parseFileContents(view.parserText);
    const restoredText = reconstructOriginalText(output.tree.unparse(), view.hasLeadingBom);

    expect(view.hasLeadingBom).toBe(true);
    expect(view.originalText.startsWith('\uFEFF')).toBe(true);
    expect(view.parserText.startsWith('\uFEFF')).toBe(false);
    expect(LanguageFacts.inferLanguageVersions(view.parserText)).toContain('0.8.37');
    expect(output.isValid()).toBe(true);
    expect(Buffer.from(restoredText, 'utf8')).toEqual(Buffer.from(view.originalBytes));
    expect(createHash('sha256').update(view.originalBytes).digest('hex')).toBe(
      createHash('sha256').update(Buffer.from(view.originalText, 'utf8')).digest('hex'),
    );
    expect(createHash('sha256').update(view.originalBytes).digest('hex')).not.toBe(
      createHash('sha256').update(Buffer.from(view.parserText, 'utf8')).digest('hex'),
    );

    const contractName = findIdentifier(output.createTreeCursor(), 'BomLocations');
    expect(contractName).toBeDefined();
    expect(mapRangeToOriginal(contractName!.textRange, view.hasLeadingBom)).toEqual({
      start: { utf8: 44, utf16: 42, line: 1, column: 9 },
      end: { utf8: 56, utf16: 54, line: 1, column: 21 },
    });

    const crlfBytes = await readFile(new URL('bom-crlf-unicode.sol', parserFixtures));
    const crlfView = decodeSource(crlfBytes);
    const crlfOutput = Parser.create('0.8.37').parseFileContents(crlfView.parserText);
    const unicodeContract = findIdentifier(crlfOutput.createTreeCursor(), 'BomUnicode');
    const originalNameOffset = crlfView.originalText.indexOf('BomUnicode');
    const mappedUnicodeRange = mapRangeToOriginal(unicodeContract!.textRange, true);

    expect(crlfOutput.isValid()).toBe(true);
    expect(mappedUnicodeRange.start).toEqual({
      utf8: Buffer.byteLength(crlfView.originalText.slice(0, originalNameOffset), 'utf8'),
      utf16: originalNameOffset,
      line: 2,
      column: 9,
    });
    expect(Buffer.from(reconstructOriginalText(crlfOutput.tree.unparse(), true), 'utf8')).toEqual(
      Buffer.from(crlfView.originalBytes),
    );

    const callbackRoot =
      '\uFEFFpragma solidity 0.8.37;\r\nimport "./Callback.sol";\r\ncontract CallbackRoot {}\r\n';
    const callbackFiles = new Map([
      ['/virtual/CallbackRoot.sol', callbackRoot],
      ['/virtual/Callback.sol', 'pragma solidity 0.8.37; library Callback {}'],
    ]);
    const callbackImports: string[] = [];
    const callbackBuilder = CompilationBuilder.create({
      languageVersion: '0.8.37',
      readFile: async (fileId) => {
        const contents = callbackFiles.get(fileId);
        return contents === undefined ? undefined : parserTextForCallback(contents);
      },
      resolveImport: async (sourceFileId, importPath) => {
        callbackImports.push(`${sourceFileId}:${importPath.node.unparse()}`);
        return '/virtual/Callback.sol';
      },
    });
    await callbackBuilder.addFile('/virtual/CallbackRoot.sol');
    const callbackUnit = callbackBuilder.build();
    const callbackFile = requireUnitFile(callbackUnit, '/virtual/CallbackRoot.sol');
    expect(callbackImports).toEqual(['/virtual/CallbackRoot.sol:"./Callback.sol"']);
    expect(callbackUnit.files().flatMap((file) => file.errors())).toEqual([]);
    expect(callbackFile.tree.unparse()).toBe(parserTextForCallback(callbackRoot));
    expect(Buffer.from(reconstructOriginalText(callbackFile.tree.unparse(), true), 'utf8')).toEqual(
      Buffer.from(callbackRoot, 'utf8'),
    );
  });

  it('maps BOM offsets and scalar columns, including same-line astral text, diagnostics, and EOF', () => {
    const sameLine = '\uFEFF/* 🙂 */ contract C {}';
    const sameLineView = decodeSource(Buffer.from(sameLine, 'utf8'));
    const sameLineOutput = Parser.create('0.8.37').parseFileContents(sameLineView.parserText);
    const name = findIdentifier(sameLineOutput.createTreeCursor(), 'C');

    expect(sameLineOutput.isValid()).toBe(true);
    expect(name?.textRange.start).toEqual({ utf8: 20, utf16: 18, line: 0, column: 17 });
    expect(mapRangeToOriginal(name!.textRange, true)).toEqual({
      start: { utf8: 23, utf16: 19, line: 0, column: 18 },
      end: { utf8: 24, utf16: 20, line: 0, column: 19 },
    });

    const malformed = decodeSource(Buffer.from('\uFEFFcontract', 'utf8'));
    const malformedOutput = Parser.create('0.8.37').parseFileContents(malformed.parserText);
    const [error] = malformedOutput.errors();
    expect(error?.textRange).toEqual({
      start: { utf8: 8, utf16: 8, line: 0, column: 8 },
      end: { utf8: 8, utf16: 8, line: 0, column: 8 },
    });
    expect(mapRangeToOriginal(error!.textRange, true)).toEqual({
      start: { utf8: 11, utf16: 9, line: 0, column: 9 },
      end: { utf8: 11, utf16: 9, line: 0, column: 9 },
    });

    const bomOnly = decodeSource(Buffer.from('\uFEFF', 'utf8'));
    const bomOnlyOutput = Parser.create('0.8.37').parseFileContents(bomOnly.parserText);
    expect(bomOnly.parserText).toBe('');
    expect(bomOnlyOutput.isValid()).toBe(true);
    expect(reconstructOriginalText(bomOnlyOutput.tree.unparse(), true)).toBe('\uFEFF');
    expect(
      mapRangeToOriginal(
        {
          start: { utf8: 0, utf16: 0, line: 0, column: 0 },
          end: { utf8: 0, utf16: 0, line: 0, column: 0 },
        },
        true,
      ),
    ).toEqual({
      start: { utf8: 3, utf16: 1, line: 0, column: 1 },
      end: { utf8: 3, utf16: 1, line: 0, column: 1 },
    });
  });

  it('strips only the first BOM and rejects invalid UTF-8 instead of replacing bytes', () => {
    const repeated = decodeSource(Buffer.from('\uFEFF\uFEFFcontract C {}', 'utf8'));
    expect(repeated.hasLeadingBom).toBe(true);
    expect(repeated.parserText).toBe('\uFEFFcontract C {}');
    expect(Parser.create('0.8.37').parseFileContents(repeated.parserText).isValid()).toBe(false);

    const interior = decodeSource(Buffer.from('contract C { string s = "\uFEFF"; }', 'utf8'));
    expect(interior.hasLeadingBom).toBe(false);
    expect(interior.parserText).toBe(interior.originalText);

    let invalidUtf8Error: unknown;
    try {
      decodeSource(new Uint8Array([0xc3, 0x28]));
    } catch (error: unknown) {
      invalidUtf8Error = error;
    }
    expect(invalidUtf8Error).toBeInstanceOf(TypeError);
    expect(parserTextForCallback('\uFEFFpragma solidity 0.8.37;')).toBe('pragma solidity 0.8.37;');
    expect(parserTextForCallback('contract Interior { string s = "\uFEFF"; }')).toBe(
      'contract Interior { string s = "\uFEFF"; }',
    );
  });

  it('round-trips CRLF and Unicode trivia and exposes UTF-8 and UTF-16 cursor ranges', async () => {
    const source = await readFixture('crlf-locations.sol');
    const output = Parser.create('0.8.37').parseFileContents(source);

    expect(output.isValid()).toBe(true);
    expect(Buffer.from(output.tree.unparse(), 'utf8')).toEqual(Buffer.from(source, 'utf8'));

    const cursor = output.createTreeCursor();
    let markerRange: TextRange | undefined;
    const trivia: string[] = [];
    let hasNext = true;
    while (hasNext) {
      const node = cursor.node;
      if (node.isTerminalNode()) {
        if (node.kind === TerminalKind.Identifier && node.unparse() === 'MARKERS') {
          markerRange = cursor.textRange;
        }
        if (TerminalKindExtensions.isTrivia(node.kind)) {
          trivia.push(node.unparse());
        }
      }
      hasNext = cursor.goToNext();
    }

    expect(trivia.join('')).toContain('// π🙂 comment markers /* and // remain comment text');
    expect(trivia.join('')).not.toContain('this is text');
    expect(markerRange).toEqual({
      start: { utf8: 139, utf16: 136, line: 3, column: 27 },
      end: { utf8: 146, utf16: 143, line: 3, column: 34 },
    });
    expect(markerRange?.start.utf16).toBe(source.indexOf('MARKERS'));
    expect(markerRange?.start.utf8).toBe(
      Buffer.byteLength(source.slice(0, source.indexOf('MARKERS'))),
    );

    const sourceUnit = new SourceUnit(output.tree);
    const contractMember = sourceUnit.members.items.find(
      (member) => member.variant instanceof ContractDefinition,
    );
    if (!(contractMember?.variant instanceof ContractDefinition)) {
      throw new Error('Expected a typed ContractDefinition AST member.');
    }
    expect(contractMember.variant.name.unparse()).toBe('Locations');
  });

  it('reports malformed syntax with a source range and keeps a partial tree', () => {
    const output = Parser.create('0.8.37').parseFileContents('contract');

    expect(output.isValid()).toBe(false);
    expect(output.errors()[0]?.textRange).toEqual({
      start: { utf8: 8, utf16: 8, line: 0, column: 8 },
      end: { utf8: 8, utf16: 8, line: 0, column: 8 },
    });
    expect(output.tree.kind).toBe(NonterminalKind.SourceUnit);
  });

  it('reports CR, LF, and CRLF lines and observes Unicode separator ranges', () => {
    const source = 'contract A {}\rcontract B {}\ncontract C {}\r\ncontract D {}';
    const output = Parser.create('0.8.37').parseFileContents(source);
    const ranges = ['A', 'B', 'C', 'D'].map(
      (name) => findIdentifier(output.createTreeCursor(), name)?.textRange.start,
    );

    expect(output.isValid()).toBe(true);
    expect(ranges.map((range) => range?.line)).toEqual([0, 1, 2, 3]);
    expect(ranges.map((range) => range?.column)).toEqual([9, 9, 9, 9]);
    for (const [index, name] of ['A', 'B', 'C', 'D'].entries()) {
      const characterIndex = source.indexOf(`contract ${name}`) + 'contract '.length;
      const range = ranges[index];
      expect(range?.utf8).toBe(Buffer.byteLength(source.slice(0, characterIndex), 'utf8'));
      expect(range?.utf16).toBe(characterIndex);
    }

    for (const separator of ['\u2028', '\u2029']) {
      const unicodeSeparated = Parser.create('0.8.37').parseFileContents(
        `contract A {}${separator}contract B {}`,
      );
      expect(unicodeSeparated.isValid()).toBe(false);
      expect(unicodeSeparated.errors()[0]?.textRange).toEqual({
        start: { utf8: 13, utf16: 13, line: 0, column: 13 },
        end: { utf8: 29, utf16: 27, line: 1, column: 13 },
      });
    }
  });
});

function findIdentifier(cursor: Cursor, text: string): Cursor | undefined {
  let hasNext = true;
  while (hasNext) {
    const node = cursor.node;
    if (node.isTerminalNode() && node.kind === TerminalKind.Identifier && node.unparse() === text) {
      return cursor;
    }
    hasNext = cursor.goToNext();
  }
  return undefined;
}

interface BindingTarget {
  readonly fileId: string;
  readonly utf8: number;
  readonly text: string;
}

function requireUnitFile(unit: CompilationUnit, fileId: string) {
  const file = unit.file(fileId);
  if (file === undefined) throw new Error(`Expected compilation file ${fileId}.`);
  return file;
}

function cursorAt(cursor: Cursor, identifier: string, utf16Offset: number): Cursor {
  let hasNext = true;
  while (hasNext) {
    const node = cursor.node;
    if (
      node.isTerminalNode() &&
      node.kind === TerminalKind.Identifier &&
      node.unparse() === identifier &&
      cursor.textRange.start.utf16 === utf16Offset
    ) {
      return cursor;
    }
    hasNext = cursor.goToNext();
  }
  throw new Error(`Could not find ${identifier} at UTF-16 offset ${utf16Offset}.`);
}

function bindingTarget(location: BindingLocation): BindingTarget {
  const userFileLocation = location.asUserFileLocation();
  if (userFileLocation === undefined) throw new Error('Expected a source-file binding location.');
  return {
    fileId: userFileLocation.fileId,
    utf8: userFileLocation.cursor.textRange.start.utf8,
    text: userFileLocation.cursor.node.unparse(),
  };
}

function definitionTarget(graph: CompilationUnit['bindingGraph'], cursor: Cursor): BindingTarget {
  const definition = graph.definitionAt(cursor);
  if (definition === undefined)
    throw new Error('Expected a binding definition at the requested cursor.');
  return bindingTarget(definition.nameLocation);
}

function referenceTargets(
  graph: CompilationUnit['bindingGraph'],
  cursor: Cursor,
): BindingTarget[] | null {
  const reference = graph.referenceAt(cursor);
  return reference === undefined
    ? null
    : reference.definitions().map((definition) => bindingTarget(definition.nameLocation));
}

function createChildClient(child: ChildProcessWithoutNullStreams) {
  const queuedLines: string[] = [];
  const waiters: Array<{
    readonly resolve: (response: Record<string, unknown>) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];
  let pendingText = '';
  child.stdout.setEncoding('utf8');
  child.stderr.resume();
  child.stdout.on('data', (chunk: string) => {
    pendingText += chunk;
    let newline = pendingText.indexOf('\n');
    while (newline >= 0) {
      const line = pendingText.slice(0, newline);
      pendingText = pendingText.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter === undefined) queuedLines.push(line);
      else {
        clearTimeout(waiter.timer);
        try {
          waiter.resolve(decodeChildResponse(line));
        } catch (error: unknown) {
          waiter.reject(error instanceof Error ? error : new Error('Invalid child response.'));
        }
      }
      newline = pendingText.indexOf('\n');
    }
  });

  return {
    request(payload: Readonly<Record<string, string | number>>, timeoutMs = 10_000) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const queued = queuedLines.shift();
        if (queued !== undefined) {
          try {
            resolve(decodeChildResponse(queued));
          } catch (error: unknown) {
            reject(error instanceof Error ? error : new Error('Invalid child response.'));
          }
          return;
        }
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Child did not respond within ${timeoutMs} ms.`));
        }, timeoutMs);
        waiters.push({ resolve, reject, timer });
        child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
          if (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
      });
    },
  };
}

function decodeChildResponse(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected the child to return a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (await waitForExitEvent(child, 5_000)) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await waitForExitEvent(child, 2_000);
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`Child process ${child.pid ?? 'unknown'} did not exit after SIGKILL.`);
  }
}

function waitForExitEvent(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function processExists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function sanitizedNodeEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  return environment;
}
