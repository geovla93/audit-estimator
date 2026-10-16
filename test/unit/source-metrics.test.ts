import { describe, expect, it } from 'vitest';
import { fileIdentity } from '../../src/domain/canonical.ts';
import type { SourceRange } from '../../src/domain/types.ts';
import type { ParserToken, ParserTokenKind } from '../../src/parser/protocol.ts';
import {
  BOUNDED_CHUNK_BYTES,
  BOUNDED_RECORD_INTERVAL,
  buildLineStartIndex,
  buildRetainedLineSet,
  buildSourceLineSet,
  countPhysicalLines,
  endOfTextPosition,
  linesWithin,
  physicalLineAt,
} from '../../src/metrics/source.ts';

const fileId = fileIdentity('contracts/A.sol');

/** Builds a token over the first occurrence of `text` at or after `from` in `source`. */
function token(source: string, text: string, kind: ParserTokenKind, from = 0): ParserToken {
  const startUtf16 = source.indexOf(text, from);
  if (startUtf16 < 0) throw new Error(`Missing token text: ${text}`);
  const startByte = Buffer.byteLength(source.slice(0, startUtf16), 'utf8');
  const endByte = startByte + Buffer.byteLength(text, 'utf8');
  // Token line/column fields are deliberately wrong: metrics must derive lines from bytes.
  const range: SourceRange = {
    startByte,
    endByte,
    start: { line: 999, column: 1 },
    end: { line: 999, column: 1 },
  };
  return { fileId, kind, range };
}

function bytes(source: string): Uint8Array {
  return Buffer.from(source, 'utf8');
}

function sorted(lines: ReadonlySet<number>): number[] {
  return [...lines].sort((a, b) => a - b);
}

describe('countPhysicalLines', () => {
  it.each([
    ['', 0],
    ['a', 1],
    ['a\n', 1],
    ['\n', 1],
    ['\n\n', 2],
    ['a\r\nb', 2],
    ['a\rb', 2],
    ['a\nb', 2],
    ['a\r\n', 1],
    ['a\r', 1],
    ['\r\n\r\n', 2],
    ['\uFEFF', 0],
    ['\uFEFFa', 1],
    ['\uFEFF\n', 1],
    ['a\u2028b', 1],
    ['a\u2029b\n', 1],
  ])('counts %j as %i', (text, expected) => {
    expect(countPhysicalLines(text)).toBe(expected);
  });
});

describe('endOfTextPosition', () => {
  it('uses parser domain coordinates, where U+2028 starts a new line', () => {
    expect(endOfTextPosition('a\u2028b')).toEqual({ byte: 5, line: 2, column: 2 });
  });

  it('counts CRLF once and columns in Unicode scalars', () => {
    expect(endOfTextPosition('')).toEqual({ byte: 0, line: 1, column: 1 });
    expect(endOfTextPosition('ab\r\ncd')).toEqual({ byte: 6, line: 2, column: 3 });
    expect(endOfTextPosition('a\r\n')).toEqual({ byte: 3, line: 2, column: 1 });
    expect(endOfTextPosition('a\rb\nc')).toEqual({ byte: 5, line: 3, column: 2 });
    expect(endOfTextPosition('\u{1F600}x')).toEqual({ byte: 5, line: 1, column: 3 });
  });

  it('includes a leading BOM in the first-line column', () => {
    expect(endOfTextPosition('\uFEFFab')).toEqual({ byte: 5, line: 1, column: 4 });
  });
});

describe('line start index', () => {
  it('records absolute byte offsets of CR, LF and CRLF line starts', () => {
    const starts = buildLineStartIndex(bytes('a\r\nb\rc\nd'));
    expect(starts).toEqual([0, 3, 5, 7]);
    expect(physicalLineAt(starts, 0)).toBe(1);
    expect(physicalLineAt(starts, 1)).toBe(1);
    expect(physicalLineAt(starts, 2)).toBe(1);
    expect(physicalLineAt(starts, 3)).toBe(2);
    expect(physicalLineAt(starts, 5)).toBe(3);
    expect(physicalLineAt(starts, 7)).toBe(4);
  });

  it('keeps absolute offsets after a leading BOM and ignores U+2028', () => {
    const starts = buildLineStartIndex(bytes('\uFEFFa\u2028b\nc'));
    expect(starts).toEqual([3, 9]);
    expect(physicalLineAt(starts, 3)).toBe(1);
    expect(physicalLineAt(starts, 9)).toBe(2);
  });

  it('adds no start for a terminal empty segment', () => {
    expect(buildLineStartIndex(bytes('a\n'))).toEqual([0]);
  });
});

describe('buildSourceLineSet', () => {
  it('excludes comment-only and NatSpec-only lines', () => {
    const source = '// c\n/// n\nuint a;\n/* b */\n';
    const tokens = [
      token(source, '// c', 'comment'),
      token(source, '/// n', 'natspec'),
      token(source, 'uint', 'keyword'),
      token(source, 'a', 'identifier'),
      token(source, ';', 'punctuation'),
      token(source, '/* b */', 'comment'),
      token(source, '\n', 'whitespace'),
    ];
    const set = buildSourceLineSet(fileId, bytes(source), tokens);
    expect(set.fileId).toBe(fileId);
    expect(sorted(set.oneBasedLines)).toEqual([3]);
  });

  it('counts a string token that contains comment markers', () => {
    const source = 'x\n"// not a comment"\n';
    const tokens = [
      token(source, 'x', 'identifier'),
      token(source, '"// not a comment"', 'string'),
    ];
    expect(sorted(buildSourceLineSet(fileId, bytes(source), tokens).oneBasedLines)).toEqual([1, 2]);
  });

  it('counts only non-empty pieces of a multi-line token', () => {
    const source = 'a "x\n\ny" b';
    const tokens = [
      token(source, 'a', 'identifier'),
      token(source, '"x\n\ny"', 'string'),
      token(source, 'b', 'identifier', 8),
    ];
    expect(sorted(buildSourceLineSet(fileId, bytes(source), tokens).oneBasedLines)).toEqual([1, 3]);
  });

  it('counts only the first and third line of a lone 3-line token with an empty middle', () => {
    const source = '"x\n\ny"';
    const tokens = [token(source, source, 'string')];
    expect(sorted(buildSourceLineSet(fileId, bytes(source), tokens).oneBasedLines)).toEqual([1, 3]);
  });

  it('counts a line with code and a trailing comment once', () => {
    const source = 'a; // tail\n';
    const tokens = [
      token(source, 'a', 'identifier'),
      token(source, ';', 'punctuation'),
      token(source, '// tail', 'comment'),
    ];
    expect(sorted(buildSourceLineSet(fileId, bytes(source), tokens).oneBasedLines)).toEqual([1]);
  });

  it('places a token after a CRLF break on line 2 and ignores token line fields', () => {
    const source = 'a\r\nb';
    const tokens = [token(source, 'a', 'identifier'), token(source, 'b', 'identifier')];
    expect(sorted(buildSourceLineSet(fileId, bytes(source), tokens).oneBasedLines)).toEqual([1, 2]);
  });

  it('does not start a new line at U+2028 inside a token', () => {
    const source = '"a\u2028b"';
    const tokens = [token(source, source, 'string')];
    const lines = sorted(buildSourceLineSet(fileId, bytes(source), tokens).oneBasedLines);
    expect(countPhysicalLines(source)).toBe(1);
    expect(lines).toEqual([1]);
  });

  it('counts a token after a leading BOM on line 1', () => {
    const source = '\uFEFFa';
    const tokens = [token(source, 'a', 'identifier')];
    expect(sorted(buildSourceLineSet(fileId, bytes(source), tokens).oneBasedLines)).toEqual([1]);
  });
});

describe('linesWithin', () => {
  it('gives two same-line contracts the same line while the file set holds it once', () => {
    const source = 'contract A {} contract B {}\n';
    const tokens = [
      token(source, 'contract', 'keyword'),
      token(source, 'A', 'identifier'),
      token(source, '{', 'punctuation'),
      token(source, '}', 'punctuation'),
      token(source, 'contract', 'keyword', 14),
      token(source, 'B', 'identifier'),
      token(source, '{', 'punctuation', 23),
      token(source, '}', 'punctuation', 24),
    ];
    const first = tokens[0];
    const aEnd = tokens[3];
    const second = tokens[4];
    const bEnd = tokens[7];
    if (first === undefined || aEnd === undefined || second === undefined || bEnd === undefined) {
      throw new Error('Expected tokens.');
    }
    const rangeA: SourceRange = { ...first.range, endByte: aEnd.range.endByte };
    const rangeB: SourceRange = { ...second.range, endByte: bEnd.range.endByte };
    const data = bytes(source);
    expect(sorted(linesWithin(data, tokens, rangeA))).toEqual([1]);
    expect(sorted(linesWithin(data, tokens, rangeB))).toEqual([1]);
    expect(buildSourceLineSet(fileId, data, tokens).oneBasedLines.size).toBe(1);
  });

  it('excludes tokens outside the range and trivia inside it', () => {
    const source = 'a;\n// c\nb;\n';
    const tokens = [
      token(source, 'a', 'identifier'),
      token(source, ';', 'punctuation'),
      token(source, '// c', 'comment'),
      token(source, 'b', 'identifier'),
      token(source, ';', 'punctuation', 8),
    ];
    const range: SourceRange = {
      startByte: 3,
      endByte: source.length,
      start: { line: 2, column: 1 },
      end: { line: 4, column: 1 },
    };
    expect(sorted(linesWithin(bytes(source), tokens, range))).toEqual([3]);
  });
});

describe('buildRetainedLineSet (bounded derived lines)', () => {
  const noop = (): Promise<void> => Promise.resolve();
  const keepAll = (): boolean => true;

  it.each([
    // [label, source, token text, kind, expected lines]
    ['a one-line token', 'a b', 'a b', 'identifier', [1]],
    ['a CRLF multi-line token', 'x\r\n\r\ny', 'x\r\n\r\ny', 'string', [1, 3]],
    ['a lone CR', 'x\ry', 'x\ry', 'string', [1, 2]],
    ['a lone LF', 'x\n\ny', 'x\n\ny', 'string', [1, 3]],
    ['a blank middle line', 'a\n \t \nb', 'a\n \t \nb', 'string', [1, 3]],
    ['U+2028 inside a token', 'a\u2028b', 'a\u2028b', 'string', [1]],
    [
      'only Unicode whitespace after a break',
      'a\n\u00a0\u3000\ufeff',
      'a\n\u00a0\u3000\ufeff',
      'string',
      [1],
    ],
    ['an astral scalar', '\u{1F600}', '\u{1F600}', 'string', [1]],
  ] as const)(
    'matches the independent literal for %s',
    async (_label, source, text, kind, expected) => {
      const tokens = [token(source, text, kind)];
      const lines = await buildRetainedLineSet(bytes(source), tokens, keepAll, noop);
      expect(sorted(lines)).toEqual([...expected]);
      expect(sorted(buildSourceLineSet(fileId, bytes(source), tokens).oneBasedLines)).toEqual([
        ...expected,
      ]);
    },
  );

  it('places a token after earlier lines on its own physical line', async () => {
    const source = 'a\nb\r\nc d\n';
    const tokens = [
      token(source, 'a', 'identifier'),
      token(source, 'c', 'identifier'),
      token(source, 'd', 'identifier'),
    ];
    const lines = await buildRetainedLineSet(bytes(source), tokens, keepAll, noop);
    expect(sorted(lines)).toEqual([1, 3]);
  });

  it('skips trivia and tokens the caller does not retain', async () => {
    const source = '// c\nkeep\n/* d */\ndrop';
    const tokens = [
      token(source, '// c', 'comment'),
      token(source, 'keep', 'identifier'),
      token(source, '/* d */', 'comment'),
      token(source, 'drop', 'identifier'),
    ];
    const lines = await buildRetainedLineSet(
      bytes(source),
      tokens,
      (item) => item.range.startByte !== tokens[3]?.range.startByte,
      noop,
    );
    expect(sorted(lines)).toEqual([2]);
  });

  it('counts a huge multi-line token identically to the raw rule across chunk boundaries', async () => {
    // A CR in the last byte of the first slice and its LF in the first byte of the second, a
    // three-byte scalar split across the second boundary, then a final non-empty line.
    const first = 'a'.repeat(BOUNDED_CHUNK_BYTES - 1) + '\r';
    const second = '\n' + 'b'.repeat(BOUNDED_CHUNK_BYTES - 4) + '\u20ac';
    const third = 'tail\n\n   \nlast';
    const source = first + second + third;
    const tokens = [token(source, source, 'string')];
    const reference = buildSourceLineSet(fileId, bytes(source), tokens).oneBasedLines;
    const bounded = await buildRetainedLineSet(bytes(source), tokens, keepAll, noop);
    expect(sorted(bounded)).toEqual(sorted(reference));
    // Lines: a-run (1), b-run plus the scalar and the start of the tail (2), blank/space-only
    // pieces are skipped, then "last" on line 5.
    expect(sorted(bounded)).toEqual([1, 2, 5]);
    // The token was decoded in more than one slice.
    expect(Buffer.byteLength(source)).toBeGreaterThan(BOUNDED_CHUNK_BYTES * 2);
  });

  it('splits a CRLF pair that straddles a slice boundary into one terminator', async () => {
    const source = 'x'.repeat(BOUNDED_CHUNK_BYTES - 1) + '\r\n' + 'y';
    const tokens = [token(source, source, 'string')];
    const bounded = await buildRetainedLineSet(bytes(source), tokens, keepAll, noop);
    expect(sorted(bounded)).toEqual([1, 2]);
  });

  it('checkpoints inside one large retained token and propagates the interruption', async () => {
    const source = 'z'.repeat(BOUNDED_CHUNK_BYTES * 3 + 10);
    const tokens = [token(source, source, 'string')];
    let calls = 0;
    await buildRetainedLineSet(bytes(source), tokens, keepAll, () => {
      calls += 1;
      return Promise.resolve();
    });
    // Four slices need three checkpoints between them.
    expect(calls).toBe(3);
    const failure = new Error('cancelled');
    let seen = 0;
    await expect(
      buildRetainedLineSet(bytes(source), tokens, keepAll, () => {
        seen += 1;
        return seen === 2 ? Promise.reject(failure) : Promise.resolve();
      }),
    ).rejects.toBe(failure);
    expect(seen).toBe(2);
  });

  it('checkpoints every record interval even when no token is retained', async () => {
    const source = 'a '.repeat(BOUNDED_RECORD_INTERVAL * 2 + 5);
    const tokens: ParserToken[] = [];
    let from = 0;
    for (let index = 0; index < BOUNDED_RECORD_INTERVAL * 2 + 5; index += 1) {
      tokens.push(token(source, 'a', 'identifier', from));
      from = source.indexOf('a', from) + 1;
    }
    let calls = 0;
    await buildRetainedLineSet(
      bytes(source),
      tokens,
      () => false,
      () => {
        calls += 1;
        return Promise.resolve();
      },
    );
    expect(calls).toBe(2);
  });

  it('keeps the BOM-adjusted first line for a retained token', async () => {
    const source = '\uFEFFpragma\nx';
    const tokens = [token(source, 'pragma', 'identifier'), token(source, 'x', 'identifier')];
    const lines = await buildRetainedLineSet(bytes(source), tokens, keepAll, noop);
    expect(sorted(lines)).toEqual([1, 2]);
  });

  it('handles an empty token without inventing a line', async () => {
    const source = 'a';
    const empty: ParserToken = {
      fileId,
      kind: 'identifier',
      range: {
        startByte: 1,
        endByte: 1,
        start: { line: 1, column: 1 },
        end: { line: 1, column: 1 },
      },
    };
    const lines = await buildRetainedLineSet(bytes(source), [empty], keepAll, noop);
    expect(lines.size).toBe(0);
  });
});
