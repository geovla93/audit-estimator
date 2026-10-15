import { describe, expect, it } from 'vitest';
import type { Remapping } from '../../src/domain/types.ts';
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
