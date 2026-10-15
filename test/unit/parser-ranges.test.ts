import { describe, expect, it } from 'vitest';
import {
  SourceCoordinateIndex,
  isValidDomainRange,
  parserSourceView,
} from '../../src/parser/ranges.ts';
import type { SlangTextRange } from '../../src/parser/ranges.ts';

describe('original source ranges', () => {
  it('maps a hand-checked UTF-8 and UTF-16 coordinate into one-based domain positions', () => {
    const text = '/* 🙂 */ contract C {}';
    const view = parserSourceView(text);
    const index = new SourceCoordinateIndex(view.parserText);
    const range: SlangTextRange = {
      start: { utf8: 20, utf16: 18, line: 0, column: 17 },
      end: { utf8: 21, utf16: 19, line: 0, column: 18 },
    };
    expect(index.toOriginalRange(range, false)).toEqual({
      startByte: 20,
      endByte: 21,
      start: { line: 1, column: 18 },
      end: { line: 1, column: 19 },
    });
  });

  it('adds the leading BOM byte and scalar offsets while preserving original text', () => {
    const original = '\uFEFF/* 🙂 */ contract C {}';
    const view = parserSourceView(original);
    const index = new SourceCoordinateIndex(view.parserText);
    expect(view.parserText).toBe('/* 🙂 */ contract C {}');
    expect(
      index.toOriginalRange(
        {
          start: { utf8: 20, utf16: 18, line: 0, column: 17 },
          end: { utf8: 21, utf16: 19, line: 0, column: 18 },
        },
        view.hasLeadingBom,
      ),
    ).toEqual({
      startByte: 23,
      endByte: 24,
      start: { line: 1, column: 19 },
      end: { line: 1, column: 20 },
    });
    expect(original.startsWith('\uFEFF')).toBe(true);
  });

  it('maps empty, BOM-only, and malformed EOF positions without losing byte offsets', () => {
    const emptyIndex = new SourceCoordinateIndex('');
    const emptyRange: SlangTextRange = {
      start: { utf8: 0, utf16: 0, line: 0, column: 0 },
      end: { utf8: 0, utf16: 0, line: 0, column: 0 },
    };
    expect(emptyIndex.toOriginalRange(emptyRange, false)).toEqual({
      startByte: 0,
      endByte: 0,
      start: { line: 1, column: 1 },
      end: { line: 1, column: 1 },
    });
    expect(emptyIndex.toOriginalRange(emptyRange, true)).toEqual({
      startByte: 3,
      endByte: 3,
      start: { line: 1, column: 2 },
      end: { line: 1, column: 2 },
    });

    const malformedIndex = new SourceCoordinateIndex('contract');
    expect(
      malformedIndex.toOriginalRange(
        {
          start: { utf8: 8, utf16: 8, line: 0, column: 8 },
          end: { utf8: 8, utf16: 8, line: 0, column: 8 },
        },
        true,
      ),
    ).toMatchObject({ startByte: 11, endByte: 11, start: { line: 1, column: 10 } });
  });

  it('indexes CRLF, CR, LF, scalar columns, and UTF-8 boundaries in one pass', () => {
    const index = new SourceCoordinateIndex('A\r\nB\rC\n🙂D');
    expect(index.mapsDomainPosition(3, 2, 1)).toBe(true);
    expect(index.mapsDomainPosition(5, 3, 1)).toBe(true);
    expect(index.mapsDomainPosition(7, 4, 1)).toBe(true);
    expect(index.mapsDomainPosition(11, 4, 2)).toBe(true);
    expect(index.mapsDomainPosition(9, 4, 2)).toBe(false);
  });

  it('rejects out-of-bounds, reversed, and interior UTF-8 endpoints', () => {
    const index = new SourceCoordinateIndex('🙂');
    expect(
      isValidDomainRange(
        {
          startByte: 0,
          endByte: 4,
          start: { line: 1, column: 1 },
          end: { line: 1, column: 2 },
        },
        index,
      ),
    ).toBe(true);
    expect(
      isValidDomainRange(
        {
          startByte: 1,
          endByte: 4,
          start: { line: 1, column: 1 },
          end: { line: 1, column: 2 },
        },
        index,
      ),
    ).toBe(false);
    expect(
      isValidDomainRange(
        {
          startByte: 4,
          endByte: 0,
          start: { line: 1, column: 2 },
          end: { line: 1, column: 1 },
        },
        index,
      ),
    ).toBe(false);
  });
});
