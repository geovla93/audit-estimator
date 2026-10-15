import { describe, expect, it } from 'vitest';
import { fileIdentity } from '../../src/domain/canonical.ts';
import type { EdgeId, FileId, Remapping, SourceRange } from '../../src/domain/types.ts';
import type { ParseFileResult } from '../../src/parser/protocol.ts';
import { planComponents } from '../../src/relationships/components.ts';
import type { ComponentFileInput, ComponentPlanInput } from '../../src/relationships/components.ts';
import type { ImportObservation } from '../../src/relationships/types.ts';
import {
  directCandidates,
  normalizeSourceUnitName,
  planImportLookup,
  selectRemappingArray,
  splitPackage,
} from '../../src/relationships/imports.ts';
import {
  applyRemapping,
  normalizeConfinedPath,
  parseRemappingsText,
  selectRemapping,
} from '../../src/relationships/remappings.ts';

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const result: T[][] = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) result.push([item, ...tail]);
  });
  return result;
}

function appliedName(match: ReturnType<typeof selectRemapping>): string | null {
  return match.kind === 'applied' ? match.candidate.resolvedName : null;
}

function conflictNames(match: ReturnType<typeof selectRemapping>): (string | null)[] {
  return match.kind === 'conflict' ? match.candidates.map((item) => item.resolvedName) : [];
}

function text(value: string): Uint8Array {
  return Buffer.from(value, 'utf8');
}

const zeroRange: SourceRange = {
  startByte: 0,
  endByte: 1,
  start: { line: 1, column: 1 },
  end: { line: 1, column: 2 },
};

function fid(path: string): FileId {
  return fileIdentity(path);
}

function parsedFile(path: string, compatible: readonly string[], bytes = 10): ComponentFileInput {
  const fileId = fid(path);
  const result: ParseFileResult = {
    status: 'parsed',
    fileId,
    version: {
      selectedVersion: compatible[compatible.length - 1] ?? '0.8.37',
      selectionSource: 'inferred',
      ignoredHint: 'not-applicable',
      compatibleVersions: [...compatible],
      installedVersions: ['0.7.6', '0.8.4', '0.8.28', '0.8.37'],
      pragmaRanges: [],
      parserVersion: '1.3.9',
    },
    tokens: [],
    declarations: [],
    imports: [],
    events: [],
    diagnostics: [],
    visitedNodes: 0,
  };
  return { fileId, syntax: result, byteLength: bytes };
}

function failedFile(path: string): ComponentFileInput {
  const fileId = fid(path);
  return {
    fileId,
    syntax: { status: 'failed', fileId, code: 'PARSE_INVALID', diagnostics: [] },
    byteLength: 10,
  };
}

function edge(
  from: string,
  to: string | null,
  status: ImportObservation['status'] = 'resolved',
): ImportObservation {
  return {
    importId: `decl:${from}:import:0:0` as EdgeId,
    importerFileId: fid(from),
    specifier: './x.sol',
    range: zeroRange,
    specifierRange: zeroRange,
    lookupName: null,
    strategy: null,
    remapping: null,
    conflictingRemappings: [],
    probes: [],
    candidateFileIds: [],
    status,
    targetFileId: to === null ? null : fid(to),
    reason: null,
  };
}

const ALL_VERSIONS = ['0.7.6', '0.8.4', '0.8.28', '0.8.37'] as const;

function plan(
  files: readonly ComponentFileInput[],
  observations: readonly ImportObservation[],
  overrides: Partial<ComponentPlanInput> = {},
): ReturnType<typeof planComponents> {
  return planComponents({
    files,
    observations,
    authority: { source: 'default', version: '0.8.28' },
    scopedFileIds: new Set(files.map((file) => file.fileId)),
    maxFiles: 128,
    maxBytes: 8 * 1024 * 1024,
    ...overrides,
  });
}

describe('semantic components', () => {
  it('partitions import connectivity as an undirected graph and keeps isolated files', () => {
    const files = ['c.sol', 'a.sol', 'b.sol', 'd.sol', 'e.sol'].map((path) =>
      parsedFile(path, ['0.8.28', '0.8.37']),
    );
    const plans = plan(files, [edge('b.sol', 'a.sol'), edge('c.sol', 'b.sol')]);
    expect(plans.map((item) => [item.id, item.members])).toEqual([
      [fid('a.sol'), [fid('a.sol'), fid('b.sol'), fid('c.sol')]],
      [fid('d.sol'), [fid('d.sol')]],
      [fid('e.sol'), [fid('e.sol')]],
    ]);
    expect(plans.every((item) => item.status === 'available' && item.grammar === '0.8.37')).toBe(
      true,
    );
    // Direction does not matter and the result is independent of input order.
    const reversed = plan([...files].reverse(), [edge('a.sol', 'b.sol'), edge('b.sol', 'c.sol')]);
    expect(reversed.map((item) => item.members)).toEqual(plans.map((item) => item.members));
  });

  it('selects the highest common installed grammar over overlapping and disjoint members', () => {
    const overlapping = plan(
      [
        parsedFile('a.sol', ['0.8.4', '0.8.28', '0.8.37']),
        parsedFile('b.sol', ['0.7.6', '0.8.4', '0.8.28']),
      ],
      [edge('a.sol', 'b.sol')],
    );
    expect(overlapping).toMatchObject([{ status: 'available', grammar: '0.8.28' }]);
    const disjoint = plan(
      [parsedFile('a.sol', ['0.8.37']), parsedFile('b.sol', ['0.7.6'])],
      [edge('a.sol', 'b.sol')],
    );
    expect(disjoint).toMatchObject([
      { status: 'unavailable', grammar: null, reason: 'no-common-grammar' },
    ]);
    // Disjoint files in separate components are bound independently.
    const separate = plan([parsedFile('a.sol', ['0.8.37']), parsedFile('b.sol', ['0.7.6'])], []);
    expect(separate.map((item) => item.grammar)).toEqual(['0.8.37', '0.7.6']);
  });

  it('honors an exact cli or config version as an additional constraint only', () => {
    const files = [parsedFile('a.sol', ALL_VERSIONS), parsedFile('b.sol', ALL_VERSIONS)];
    const edges = [edge('a.sol', 'b.sol')];
    expect(plan(files, edges, { authority: { source: 'config', version: '0.8.4' } })).toMatchObject(
      [{ status: 'available', grammar: '0.8.4' }],
    );
    expect(plan(files, edges, { authority: { source: 'cli', version: '0.8.28' } })).toMatchObject([
      { grammar: '0.8.28' },
    ]);
    const narrowed = [parsedFile('a.sol', ['0.8.28', '0.8.37']), parsedFile('b.sol', ALL_VERSIONS)];
    expect(plan(narrowed, edges, { authority: { source: 'cli', version: '0.7.6' } })).toMatchObject(
      [{ status: 'unavailable', reason: 'authority-excludes-grammar' }],
    );
    // Foundry/default hints never constrain the common grammar.
    for (const source of ['metadata', 'default'] as const) {
      expect(plan(files, edges, { authority: { source, version: '0.7.6' } })).toMatchObject([
        { status: 'available', grammar: '0.8.37' },
      ]);
    }
  });

  it('is unavailable for failed syntax, unresolved imports or oversized components', () => {
    expect(
      plan([parsedFile('a.sol', ALL_VERSIONS), failedFile('b.sol')], [edge('a.sol', 'b.sol')]),
    ).toMatchObject([{ status: 'unavailable', reason: 'member-syntax-failed' }]);
    for (const status of ['unresolved', 'ambiguous'] as const) {
      expect(
        plan([parsedFile('a.sol', ALL_VERSIONS)], [edge('a.sol', null, status)]),
      ).toMatchObject([{ status: 'unavailable', reason: 'unresolved-import' }]);
    }
    const trio = ['a.sol', 'b.sol', 'c.sol'].map((path) => parsedFile(path, ALL_VERSIONS, 100));
    const chain = [edge('a.sol', 'b.sol'), edge('b.sol', 'c.sol')];
    expect(plan(trio, chain, { maxFiles: 3, maxBytes: 300 })).toMatchObject([
      { status: 'available', totalBytes: 300 },
    ]);
    expect(plan(trio, chain, { maxFiles: 2, maxBytes: 300 })).toMatchObject([
      { status: 'unavailable', reason: 'component-too-large' },
    ]);
    expect(plan(trio, chain, { maxFiles: 3, maxBytes: 299 })).toMatchObject([
      { status: 'unavailable', reason: 'component-too-large' },
    ]);
  });

  it('skips components without a scoped member', () => {
    const files = [parsedFile('a.sol', ALL_VERSIONS), parsedFile('b.sol', ALL_VERSIONS)];
    expect(plan(files, [], { scopedFileIds: new Set([fid('a.sol')]) })).toMatchObject([
      { id: fid('a.sol'), status: 'available' },
      { id: fid('b.sol'), status: 'unavailable', reason: 'no-scoped-member' },
    ]);
  });
});

describe('resolution and remappings', () => {
  describe('source-unit names', () => {
    it('resolves relative segments against the importer before any remapping', () => {
      expect(normalizeSourceUnitName('src/a/B.sol', './C.sol')).toEqual({
        ok: true,
        kind: 'relative',
        name: 'src/a/C.sol',
      });
      expect(normalizeSourceUnitName('src/a/B.sol', '../c/D.sol')).toEqual({
        ok: true,
        kind: 'relative',
        name: 'src/c/D.sol',
      });
      expect(normalizeSourceUnitName('A.sol', './B.sol')).toEqual({
        ok: true,
        kind: 'relative',
        name: 'B.sol',
      });
      expect(normalizeSourceUnitName('src/A.sol', 'contracts/Base.sol')).toEqual({
        ok: true,
        kind: 'direct',
        name: 'contracts/Base.sol',
      });
    });

    it('rejects above-root traversal before normalization can erase it', () => {
      expect(normalizeSourceUnitName('src/A.sol', '../../x.sol')).toEqual({
        ok: false,
        reason: 'outside-root',
      });
      expect(normalizeSourceUnitName('A.sol', '../x.sol')).toEqual({
        ok: false,
        reason: 'outside-root',
      });
      expect(normalizeSourceUnitName('A.sol', 'a/../../x.sol')).toEqual({
        ok: false,
        reason: 'outside-root',
      });
    });

    it.each([
      ['empty', ''],
      ['scheme', 'https://example.com/a.sol'],
      ['file scheme', 'file:///a.sol'],
      ['absolute', '/etc/a.sol'],
      ['drive', 'C:/a.sol'],
      ['drive backslash', 'C:\\a.sol'],
      ['UNC', '//server/share/a.sol'],
      ['backslash', 'a\\b.sol'],
      ['NUL', 'a\u0000b.sol'],
      ['control', 'a\u001fb.sol'],
      ['empty segment', 'a//b.sol'],
      ['trailing slash', 'a/'],
    ])('rejects %s before native path conversion', (_name, specifier) => {
      expect(normalizeSourceUnitName('src/A.sol', specifier).ok).toBe(false);
    });
  });

  describe('remapping text', () => {
    it('accepts one BOM, mixed line endings, blank lines and full-line comments', () => {
      const parsed = parseRemappingsText(
        text('\uFEFF# libs\r\n\r\n@oz/=lib/oz/\r  src/a:forge/=./vendor/forge/\n#tail'),
      );
      expect(parsed).toEqual({
        ok: true,
        remappings: [
          { prefix: '@oz/', target: 'lib/oz' },
          { prefix: 'forge/', target: 'vendor/forge', context: 'src/a' },
        ],
      });
    });

    it.each([
      ['no equals', 'a/b'],
      ['two equals', 'a=b=c'],
      ['empty prefix', '=lib'],
      ['empty target', 'a/='],
      ['two contexts', 'x:y:a/=lib/'],
      ['empty context', ':a/=lib/'],
      ['control character', 'a/=lib/\u0000'],
      ['remote target', 'a/=https://example.com/'],
      ['absolute target', 'a/=/usr/lib/'],
      ['traversal', 'a/=../outside/'],
      ['backslash', 'a/=lib\\x'],
    ])('rejects the whole file for %s', (_name, line) => {
      expect(parseRemappingsText(text(`ok/=lib/\n${line}\n`))).toMatchObject({ ok: false });
    });

    it('bounds entries, bytes and UTF-8', () => {
      const exact = Array.from({ length: 1_000 }, (_unused, index) => `p${index}/=lib/`).join('\n');
      const over = `${exact}\nlast/=lib/`;
      expect(parseRemappingsText(text(exact))).toMatchObject({ ok: true });
      expect(parseRemappingsText(text(over))).toEqual({ ok: false, reason: 'too-many-entries' });
      expect(parseRemappingsText(new Uint8Array(256 * 1024 + 1))).toEqual({
        ok: false,
        reason: 'oversized',
      });
      expect(parseRemappingsText(Uint8Array.from([0x61, 0x2f, 0x3d, 0xc3, 0x28]))).toEqual({
        ok: false,
        reason: 'invalid-utf8',
      });
    });

    it('normalizes confined paths without accepting traversal above the root', () => {
      expect(normalizeConfinedPath('./lib//oz/')).toBe('lib/oz');
      expect(normalizeConfinedPath('.')).toBe('.');
      expect(normalizeConfinedPath('a/../b')).toBe('b');
      expect(normalizeConfinedPath('../b')).toBeNull();
    });
  });

  describe('ranking and application', () => {
    it('lets a shorter prefix in a longer matching context beat a longer global prefix', () => {
      const remappings: Remapping[] = [
        { prefix: '@oz/contracts/', target: 'global' },
        { prefix: '@oz/', target: 'scoped', context: 'src/feature' },
        { prefix: '@oz/', target: 'rootish', context: '.' },
      ];
      for (const order of permutations(remappings)) {
        const match = selectRemapping('src/feature/F.sol', '@oz/contracts/T.sol', order);
        expect(appliedName(match)).toBe('scoped/contracts/T.sol');
      }
      const outside = selectRemapping('src/other/F.sol', '@oz/contracts/T.sol', remappings);
      expect(outside.kind === 'applied' && outside.candidate.resolvedName).toBe('global/T.sol');
    });

    it('matches contexts on directory boundaries only', () => {
      const remappings: Remapping[] = [{ prefix: 'x/', target: 'y', context: 'src/a' }];
      expect(selectRemapping('src/a/F.sol', 'x/f.sol', remappings).kind).toBe('applied');
      expect(selectRemapping('src/ab/F.sol', 'x/f.sol', remappings).kind).toBe('none');
      expect(selectRemapping('src/a', 'x/f.sol', remappings).kind).toBe('applied');
    });

    it('remaps a relative name after normalization', () => {
      const plan = planImportLookup(
        'src/a/B.sol',
        '../c/D.sol',
        [{ prefix: 'src/c/', target: 'vendor/c' }],
        [],
      );
      expect(plan).toMatchObject({
        ok: true,
        strategy: 'remapped',
        name: 'src/c/D.sol',
        candidates: [{ path: 'vendor/c/D.sol', origin: 'remapped' }],
      });
    });

    it('joins directory targets with one slash and treats dot as the root', () => {
      expect(applyRemapping('@oz/x.sol', { prefix: '@oz/', target: 'lib/oz' })).toBe(
        'lib/oz/x.sol',
      );
      expect(applyRemapping('@oz/x.sol', { prefix: '@oz/', target: '.' })).toBe('x.sol');
      expect(applyRemapping('@oz/x/y.sol', { prefix: '@oz/', target: 'lib' })).toBe('lib/x/y.sol');
    });

    it('replaces exact-file prefixes literally', () => {
      expect(
        applyRemapping('contracts/Token.sol', {
          prefix: 'contracts/Token.sol',
          target: 'vendor/Token.sol',
        }),
      ).toBe('vendor/Token.sol');
      expect(applyRemapping('foo/x.sol', { prefix: 'foo', target: 'lib/foo' })).toBe(
        'lib/foo/x.sol',
      );
    });

    it('applies once and never chains remappings', () => {
      const remappings: Remapping[] = [
        { prefix: 'a/', target: 'b' },
        { prefix: 'b/', target: 'c' },
      ];
      const match = selectRemapping('src/F.sol', 'a/x.sol', remappings);
      expect(match.kind === 'applied' && match.candidate.resolvedName).toBe('b/x.sol');
    });

    it('rejects equal-ranked conflicting targets under every input permutation', () => {
      const remappings: Remapping[] = [
        { prefix: 'lib/', target: 'one' },
        { prefix: 'lib/', target: 'two' },
        { prefix: 'li', target: 'shorter' },
      ];
      for (const order of permutations(remappings)) {
        const match = selectRemapping('src/F.sol', 'lib/x.sol', order);
        expect(match.kind).toBe('conflict');
        expect(conflictNames(match)).toEqual(['one/x.sol', 'two/x.sol']);
      }
      const duplicates: Remapping[] = [
        { prefix: 'lib/', target: 'one' },
        { prefix: 'lib/', target: 'one', context: '.' },
      ];
      expect(selectRemapping('src/F.sol', 'lib/x.sol', duplicates).kind).toBe('applied');
    });

    it('reports a conflicting plan without choosing a target', () => {
      const plan = planImportLookup(
        'src/F.sol',
        'lib/x.sol',
        [
          { prefix: 'lib/', target: 'two' },
          { prefix: 'lib/', target: 'one' },
        ],
        [],
      );
      expect(plan.ok).toBe(false);
      expect(plan).toMatchObject({ reason: 'remapping-conflict' });
    });
  });

  describe('array selection', () => {
    it('lets explicit config, including an empty array, replace every other array', () => {
      expect(
        selectRemappingArray({
          imports: { remappings: [] },
          provenance: [{ field: 'imports.remappings', source: 'config' }],
        }),
      ).toEqual({ source: 'config', needsFile: false, remappings: [] });
      expect(
        selectRemappingArray({
          imports: { remappings: [{ prefix: 'a/', target: 'b' }] },
          provenance: [{ field: 'imports.remappings', source: 'metadata' }],
        }),
      ).toEqual({
        source: 'metadata',
        needsFile: false,
        remappings: [{ prefix: 'a/', target: 'b' }],
      });
      expect(
        selectRemappingArray({
          imports: { remappings: [] },
          provenance: [{ field: 'imports.remappings', source: 'metadata' }],
        }),
      ).toMatchObject({ source: 'metadata', needsFile: false, remappings: [] });
    });

    it('falls back to remappings.txt only when no higher-priority array exists', () => {
      expect(selectRemappingArray({ imports: { remappings: [] }, provenance: [] })).toMatchObject({
        source: 'default',
        needsFile: true,
      });
    });
  });

  describe('candidates', () => {
    it('collects root, node_modules and configured lib candidates only', () => {
      expect(directCandidates('contracts/Base.sol', ['lib'])).toEqual([
        { path: 'contracts/Base.sol', origin: 'root' },
        { path: 'node_modules/contracts/Base.sol', origin: 'node-modules' },
        { path: 'lib/contracts/src/Base.sol', origin: 'lib' },
      ]);
      expect(directCandidates('@oz/contracts/token/T.sol', ['lib', 'vendor/libs'])).toEqual([
        { path: '@oz/contracts/token/T.sol', origin: 'root' },
        { path: 'node_modules/@oz/contracts/token/T.sol', origin: 'node-modules' },
        { path: 'lib/@oz/contracts/src/token/T.sol', origin: 'lib' },
        { path: 'vendor/libs/@oz/contracts/src/token/T.sol', origin: 'lib' },
      ]);
      expect(directCandidates('single.sol', ['lib'])).toHaveLength(2);
      expect(splitPackage('@oz')).toBeNull();
      expect(splitPackage('pkg/a.sol')).toEqual({ packageName: 'pkg', rest: 'a.sol' });
    });

    it('uses exactly one candidate for relative names', () => {
      expect(planImportLookup('src/A.sol', './B.sol', [], ['lib'])).toMatchObject({
        ok: true,
        strategy: 'relative',
        candidates: [{ path: 'src/B.sol', origin: 'relative' }],
      });
    });
  });
});
