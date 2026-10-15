import { describe, expect, it } from 'vitest';
import { fileIdentity } from '../../src/domain/canonical.ts';
import type { Measurement } from '../../src/domain/types.ts';
import {
  LCOV_MAX_LINES_PER_BATCH,
  normalizeSourcePath,
  parseLcovBatches,
} from '../../src/indicators/lcov.ts';
import type {
  LcovParseOptions,
  LcovParseResult,
  LcovTarget,
  LcovUnavailableReason,
} from '../../src/indicators/lcov.ts';

const ROOT = '/work/project';
const A = fileIdentity('src/A.sol');
const B = fileIdentity('src/B.sol');
const C = fileIdentity('lib/C.sol');

function lines(count: number): Measurement<number> {
  return { status: 'measured', value: count, evidence: [] };
}

function targets(overrides: Partial<Record<'A' | 'B' | 'C', LcovTarget>> = {}): LcovTarget[] {
  return [
    overrides.A ?? { fileId: A, role: 'scoped', paths: ['src/A.sol'], physicalLines: lines(3) },
    overrides.B ?? { fileId: B, role: 'scoped', paths: ['src/B.sol'], physicalLines: lines(10) },
    overrides.C ?? { fileId: C, role: 'context', paths: ['lib/C.sol'], physicalLines: lines(5) },
  ];
}

function options(overrides: Partial<LcovParseOptions> = {}): LcovParseOptions {
  return {
    byteLimit: 4 * 1024 * 1024,
    roots: [ROOT],
    targets: targets(),
    pathStyle: 'posix',
    ...overrides,
  };
}

function drain(
  input: string | Uint8Array,
  config: LcovParseOptions = options(),
): { result: LcovParseResult; steps: number } {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  const generator = parseLcovBatches(bytes, config);
  let steps = 0;
  for (;;) {
    const next = generator.next();
    if (next.done === true) return { result: next.value, steps };
    steps += 1;
  }
}

function parse(input: string | Uint8Array, config?: LcovParseOptions): LcovParseResult {
  return drain(input, config).result;
}

function unavailable(
  input: string | Uint8Array,
  reason: LcovUnavailableReason,
  config?: LcovParseOptions,
): void {
  expect(parse(input, config)).toEqual({ status: 'unavailable', reason });
}

const VALID = 'TN:\nSF:src/A.sol\nDA:1,0\nDA:3,4\nLF:2\nLH:1\nend_of_record\n';

describe('supported LCOV subset', () => {
  it('matches the independent oracle: A covered 1 of 2, B absent, C context-only', () => {
    const result = parse(`${VALID}SF:lib/C.sol\nDA:1,9\nend_of_record\n`);
    expect(result).toMatchObject({
      status: 'parsed',
      coveredLines: 1,
      totalLines: 2,
      matchedFileIds: [A],
      absentScopedFileIds: [B],
    });
    if (result.status !== 'parsed') throw new Error('Expected parsed.');
    expect(result.records.map((record) => [record.path, record.status])).toEqual([
      ['src/A.sol', 'matched'],
      ['lib/C.sol', 'context'],
    ]);
  });

  it('derives missing LF/LH, accepts checksums, ignored tags, BOM and every newline style', () => {
    const body =
      'TN:name\nSF:src/A.sol\nFN:1,f\nFNDA:3,f\nFNF:1\nFNH:1\nBRDA:1,0,0,1\nBRF:1\nBRH:1\nVER:2\n' +
      'DA:1,0,abc123\nDA:2,5\nend_of_record';
    for (const newline of ['\n', '\r\n', '\r']) {
      const text = body.replaceAll('\n', newline) + newline;
      expect(parse(`\ufeff${text}`)).toMatchObject({
        status: 'parsed',
        coveredLines: 1,
        totalLines: 2,
      });
    }
    expect(parse(body)).toMatchObject({ status: 'parsed', totalLines: 2 });
  });

  it('accepts zero DA lines only with zero totals and never counts them as coverage', () => {
    const empty = 'SF:src/A.sol\nend_of_record\n';
    expect(parse(empty)).toMatchObject({ status: 'parsed', coveredLines: 0, totalLines: 0 });
    expect(parse('SF:src/A.sol\nLF:0\nLH:0\nend_of_record\n')).toMatchObject({ status: 'parsed' });
    unavailable('SF:src/A.sol\nLF:3\nend_of_record\n', 'count-mismatch');
  });

  it('rejects duplicate and conflicting counts, lines, sources and malformed numbers', () => {
    unavailable('SF:src/A.sol\nDA:1,0\nDA:1,0\nend_of_record\n', 'duplicate-line');
    unavailable('SF:src/A.sol\nDA:1,0\nDA:1,3\nend_of_record\n', 'duplicate-line');
    unavailable('SF:src/A.sol\nLF:1\nLF:1\nDA:1,1\nend_of_record\n', 'duplicate-count');
    unavailable('SF:src/A.sol\nLH:1\nLH:1\nDA:1,1\nend_of_record\n', 'duplicate-count');
    unavailable('SF:src/A.sol\nDA:1,1\nLF:2\nend_of_record\n', 'count-mismatch');
    unavailable('SF:src/A.sol\nDA:1,1\nLH:0\nend_of_record\n', 'count-mismatch');
    unavailable(
      'SF:src/A.sol\nDA:1,0\nend_of_record\nSF:src/A.sol\nDA:2,0\nend_of_record\n',
      'duplicate-source',
    );
    unavailable(
      'SF:src/A.sol\nDA:1,0\nend_of_record\nSF:./src/A.sol\nDA:2,0\nend_of_record\n',
      'duplicate-source',
    );
    for (const bad of [
      '-1,0',
      '0,0',
      '1.5,0',
      '1,-1',
      '1,1.5',
      '1,',
      ',1',
      '1',
      '1,2,3,4',
      'a,b',
    ]) {
      const reason = parse(`SF:src/A.sol\nDA:${bad}\nend_of_record\n`);
      expect(reason.status).toBe('unavailable');
    }
    unavailable('SF:src/A.sol\nDA:9007199254740992,1\nend_of_record\n', 'invalid-number');
    unavailable('SF:src/A.sol\nDA:1,9007199254740992\nend_of_record\n', 'invalid-number');
    unavailable('SF:src/A.sol\nDA:1,1,\nend_of_record\n', 'invalid-checksum');
    unavailable(`SF:src/A.sol\nDA:1,1,${'x'.repeat(129)}\nend_of_record\n`, 'invalid-checksum');
    expect(parse(`SF:src/A.sol\nDA:1,1,${'x'.repeat(128)}\nend_of_record\n`).status).toBe('parsed');
  });

  it('rejects structural problems and unsupported tags instead of guessing', () => {
    unavailable('', 'empty');
    unavailable('TN:\n', 'empty');
    unavailable('SF:src/A.sol\nDA:1,1\n', 'unterminated-record');
    unavailable('SF:src/A.sol\nSF:src/B.sol\nend_of_record\n', 'nested-source');
    unavailable('DA:1,1\nend_of_record\n', 'malformed');
    unavailable('end_of_record\n', 'malformed');
    unavailable('SF:src/A.sol\nend_of_record\nDA:1,1\n', 'malformed');
    unavailable('SF:src/A.sol\nend_of_record\ntrailing text\n', 'unsupported-tag');
    unavailable('SF:src/A.sol\nXYZ:1\nend_of_record\n', 'unsupported-tag');
    unavailable('SF:src/A.sol\nTN:late\nend_of_record\n', 'malformed');
    unavailable('SF:\nend_of_record\n', 'invalid-path');
    unavailable('SF:src/A.sol\n\nend_of_record\n', 'malformed');
    expect(parse('\n\nSF:src/A.sol\nend_of_record\n\n\n').status).toBe('parsed');
  });

  it('fails closed on invalid UTF-8, a second BOM and truncated sequences', () => {
    expect.hasAssertions();
    unavailable(Buffer.from([0x53, 0x46, 0x3a, 0xc3, 0x28]), 'invalid-encoding');
    unavailable(Buffer.from([0x53, 0x46, 0x3a, 0xe2, 0x82]), 'invalid-encoding');
    unavailable('\ufeff\ufeffSF:src/A.sol\nend_of_record\n', 'unsupported-tag');
  });

  it('bounds line length, byte size and the work done per step', () => {
    unavailable(`SF:${'a'.repeat(8_200)}\nend_of_record\n`, 'line-too-long');
    unavailable(`TN:${'a'.repeat(9_000)}`, 'line-too-long');
    unavailable(VALID, 'limit-exceeded', options({ byteLimit: VALID.length - 1 }));
    expect(parse(VALID, options({ byteLimit: VALID.length })).status).toBe('parsed');

    const many = `SF:src/A.sol\n${Array.from({ length: 2_000 }, (_unused, index) => `DA:${index + 1},1`).join('\n')}\nend_of_record\n`;
    const { result, steps } = drain(
      many,
      options({
        targets: targets({
          A: { fileId: A, role: 'scoped', paths: ['src/A.sol'], physicalLines: lines(2_000) },
        }),
      }),
    );
    expect(result).toMatchObject({ status: 'parsed', totalLines: 2_000, coveredLines: 2_000 });
    expect(steps).toBeGreaterThanOrEqual(Math.floor(2_000 / LCOV_MAX_LINES_PER_BATCH));

    // A single oversized token stream cannot be buffered without bound.
    const huge = Buffer.alloc(200_000, 0x61);
    expect(parse(huge).status).toBe('unavailable');
  });

  it('yields between batches so cancellation can be observed', () => {
    const many = `SF:src/A.sol\n${Array.from({ length: 1_000 }, (_unused, index) => `DA:${index + 1},0`).join('\n')}\nend_of_record\n`;
    const generator = parseLcovBatches(Buffer.from(many), options());
    let first = generator.next();
    expect(first.done).toBe(false);
    // Disposing mid-parse leaves no pending work and returns promptly.
    first = generator.return({ status: 'unavailable', reason: 'empty' });
    expect(first.done).toBe(true);
  });
});

describe('LCOV paths and matching', () => {
  it('normalizes relative and root-contained absolute paths and rejects the rest', () => {
    const ok = (raw: string) => normalizeSourcePath(raw, [ROOT, '/real/project'], 'posix');
    expect(ok('src/A.sol')).toEqual({ ok: true, path: 'src/A.sol' });
    expect(ok('./src/A.sol')).toEqual({ ok: true, path: 'src/A.sol' });
    expect(ok('src/../src/A.sol')).toEqual({ ok: true, path: 'src/A.sol' });
    expect(ok(`${ROOT}/src/A.sol`)).toEqual({ ok: true, path: 'src/A.sol' });
    expect(ok('/real/project/src/A.sol')).toEqual({ ok: true, path: 'src/A.sol' });
    for (const bad of [
      '../x.sol',
      'src/../../x.sol',
      `${ROOT}/../x.sol`,
      '/other/x.sol',
      ROOT,
      `${ROOT}-sibling/x.sol`,
    ]) {
      expect(ok(bad)).toMatchObject({ ok: false, reason: 'outside-root' });
    }
    for (const bad of [
      '',
      'file:///work/project/src/A.sol',
      'https://x/y.sol',
      'C:/work/src/A.sol',
      'C:src/A.sol',
      '//host/share/x.sol',
      'src\\A.sol',
      'src//A.sol',
      'src/A.sol/',
      'src/\u0000A.sol',
      'src/\nA.sol',
      '..',
    ]) {
      expect(ok(bad).ok).toBe(false);
    }
    expect(
      normalizeSourcePath('C:/work/project/src/A.sol', ['C:\\work\\project'], 'win32'),
    ).toEqual({
      ok: true,
      path: 'src/A.sol',
    });
    expect(normalizeSourcePath('src\\A.sol', [], 'win32')).toEqual({ ok: true, path: 'src/A.sol' });
  });

  it('invalidates the artifact for an outside-root record even when other records are fine', () => {
    expect.hasAssertions();
    unavailable(`${VALID}SF:../elsewhere.sol\nDA:1,1\nend_of_record\n`, 'outside-root');
    unavailable(`${VALID}SF:/etc/passwd\nDA:1,1\nend_of_record\n`, 'outside-root');
  });

  it('excludes in-root unmatched records and context records from numeric totals', () => {
    const result = parse(
      `${VALID}SF:src/Unknown.sol\nDA:1,1\nend_of_record\nSF:lib/C.sol\nDA:1,1\nDA:2,1\nend_of_record\n`,
    );
    if (result.status !== 'parsed') throw new Error('Expected parsed.');
    expect(result.coveredLines).toBe(1);
    expect(result.totalLines).toBe(2);
    expect(result.records.map((record) => record.status)).toEqual([
      'matched',
      'unmatched',
      'context',
    ]);
  });

  it('does not double count two SF aliases of one identity', () => {
    const aliased = targets({
      A: {
        fileId: A,
        role: 'scoped',
        paths: ['src/A.sol', 'alias/A.sol'],
        physicalLines: lines(3),
      },
    });
    const text = `${VALID}SF:alias/A.sol\nDA:1,1\nend_of_record\n`;
    unavailable(text, 'alias-collision', options({ targets: aliased }));
    // Without the alias mapping the second record is simply unmatched and contributes nothing.
    expect(parse(text)).toMatchObject({ status: 'parsed', coveredLines: 1, totalLines: 2 });
    // One alias record alone resolves to the covered identity.
    expect(
      parse('SF:alias/A.sol\nDA:1,1\nend_of_record\n', options({ targets: aliased })),
    ).toMatchObject({ status: 'parsed', coveredLines: 1, totalLines: 1, matchedFileIds: [A] });
  });

  it('excludes files with out-of-range lines or unavailable physical lines', () => {
    const result = parse(
      'SF:src/A.sol\nDA:4,1\nend_of_record\nSF:src/B.sol\nDA:1,1\nend_of_record\n',
      options({
        targets: targets({
          B: {
            fileId: B,
            role: 'scoped',
            paths: ['src/B.sol'],
            physicalLines: { status: 'unavailable', reason: 'parse-invalid' },
          },
        }),
      }),
    );
    if (result.status !== 'parsed') throw new Error('Expected parsed.');
    expect(result.records.map((record) => record.status)).toEqual([
      'line-mismatch',
      'physical-lines-unavailable',
    ]);
    expect(result.totalLines).toBe(0);
    expect(result.matchedFileIds).toEqual([]);
    expect(result.absentScopedFileIds).toEqual([]);
  });

  it('accepts a line exactly at the physical line count and keeps stale-but-plausible paths unverified', () => {
    const result = parse('SF:src/A.sol\nDA:3,2\nend_of_record\n');
    expect(result).toMatchObject({ status: 'parsed', coveredLines: 1, totalLines: 1 });
  });

  it('rejects contradictory matching inputs as a programming error', () => {
    expect(() =>
      parse(
        VALID,
        options({
          targets: [
            ...targets(),
            { fileId: B, role: 'scoped', paths: ['src/A.sol'], physicalLines: lines(1) },
          ],
        }),
      ),
    ).toThrow(TypeError);
  });
});
