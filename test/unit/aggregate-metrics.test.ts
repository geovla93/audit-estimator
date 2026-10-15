import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { callableIdentity, contractIdentity, fileIdentity } from '../../src/domain/canonical.ts';
import type { FileScopeEntry, Measurement, ScopeRole } from '../../src/domain/types.ts';
import type {
  ParseFileResult,
  ParserDeclaration,
  ParserSource,
  ParserToken,
} from '../../src/parser/protocol.ts';
import { aggregateMetrics } from '../../src/metrics/aggregate.ts';
import { buildFileMetrics } from '../../src/metrics/structural.ts';
import type { FileMetrics } from '../../src/metrics/structural.ts';

function makeSource(path: string, text: string, role: ScopeRole = 'scoped'): ParserSource {
  const bytes = Buffer.from(text, 'utf8');
  const byteHash = createHash('sha256').update(bytes).digest('hex');
  const fileId = fileIdentity(path);
  const entry: FileScopeEntry = {
    fileId,
    path,
    role,
    ownership: 'first-party',
    ownershipEvidence: [],
    physicalIdentity: `fixture:${path}`,
    byteHash,
  };
  return {
    fileId,
    snapshot: {
      canonicalPath: path,
      absolutePath: `/fixture/${path}`,
      originalBytes: bytes,
      originalText: text,
      byteHash,
    },
    manifestEntry: entry,
  };
}

function lex(source: ParserSource): ParserToken[] {
  const text = source.snapshot.originalText;
  return [...text.matchAll(/(\s+)|(\w+)|(.)/gu)].map((match) => {
    const startByte = Buffer.byteLength(text.slice(0, match.index), 'utf8');
    return {
      fileId: source.fileId,
      kind:
        match[1] !== undefined
          ? 'whitespace'
          : match[2] !== undefined
            ? 'identifier'
            : 'punctuation',
      range: {
        startByte,
        endByte: startByte + Buffer.byteLength(match[0], 'utf8'),
        start: { line: 1, column: 1 },
        end: { line: 1, column: 1 },
      },
    };
  });
}

function range(text: string, needle: string): ParserDeclaration['declarationRange'] {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`Missing ${needle}`);
  const startByte = Buffer.byteLength(text.slice(0, index), 'utf8');
  return {
    startByte,
    endByte: startByte + Buffer.byteLength(needle, 'utf8'),
    start: { line: 1, column: 1 },
    end: { line: 1, column: 1 },
  };
}

function contract(source: ParserSource, name: string, whole: string): ParserDeclaration {
  const declarationRange = range(source.snapshot.originalText, whole);
  const id = contractIdentity(
    source.snapshot.canonicalPath,
    'contract',
    declarationRange.startByte,
  );
  return {
    id,
    kind: 'contract',
    name,
    contractId: id,
    callableId: null,
    declarationRange,
    nameRange: declarationRange,
    bodyRange: declarationRange,
    hasBody: true,
    attributes: [],
  };
}

function modifier(
  source: ParserSource,
  owner: ParserDeclaration,
  whole: string,
): ParserDeclaration {
  const declarationRange = range(source.snapshot.originalText, whole);
  const id = callableIdentity(
    source.snapshot.canonicalPath,
    'modifier',
    declarationRange.startByte,
  );
  return {
    id,
    kind: 'modifier',
    name: 'm',
    contractId: owner.contractId,
    callableId: id,
    declarationRange,
    nameRange: declarationRange,
    bodyRange: declarationRange,
    hasBody: true,
    attributes: [],
  };
}

function parsedMetrics(
  source: ParserSource,
  declarations: readonly ParserDeclaration[],
): FileMetrics {
  const result: ParseFileResult = {
    status: 'parsed',
    fileId: source.fileId,
    version: {
      selectedVersion: '0.8.28',
      selectionSource: 'inferred',
      ignoredHint: 'not-applicable',
      compatibleVersions: ['0.8.28'],
      installedVersions: ['0.8.28'],
      pragmaRanges: [],
      parserVersion: 'test',
    },
    tokens: lex(source),
    declarations: [...declarations],
    imports: [],
    events: [],
    diagnostics: [],
    visitedNodes: 1_000,
  };
  return buildFileMetrics(source, result);
}

function failedMetrics(source: ParserSource): FileMetrics {
  return buildFileMetrics(source, {
    status: 'failed',
    fileId: source.fileId,
    code: 'PARSE_INVALID',
    diagnostics: [],
  });
}

function twoContractFile(path: string, role: ScopeRole = 'scoped'): FileMetrics {
  const source = makeSource(path, 'contract A {} contract B {}\n', role);
  return parsedMetrics(source, [
    contract(source, 'A', 'contract A {}'),
    contract(source, 'B', 'contract B {}'),
  ]);
}

function value<T>(measurement: Measurement<T>): T {
  if (measurement.status !== 'measured') {
    throw new Error(`Expected measured, got ${measurement.reason}`);
  }
  return measurement.value;
}

describe('aggregateMetrics', () => {
  it('uses the union of file lines, not the sum of overlapping contract lines', () => {
    const file = twoContractFile('contracts/A.sol');
    const contractSourceLines = file.contracts.map((item) => value(item.sourceLines));
    expect(contractSourceLines).toEqual([1, 1]);
    expect(contractSourceLines.reduce((sum, lines) => sum + lines, 0)).toBe(2);
    expect(value(file.file.sourceLines)).toBe(1);

    const aggregate = aggregateMetrics([file]);
    expect(value(aggregate.sourceLines)).toBe(1);
    expect(value(aggregate.physicalLines)).toBe(1);
    expect(value(aggregate.scopedFiles)).toBe(1);
    expect(value(aggregate.contracts)).toBe(2);
    expect(value(aggregate.callables)).toBe(0);
  });

  it('lets a context or excluded file contribute nothing', () => {
    const scoped = twoContractFile('contracts/A.sol');
    const context = twoContractFile('lib/B.sol', 'context');
    const excluded = twoContractFile('test/C.sol', 'excluded');
    expect(aggregateMetrics([scoped, context, excluded])).toEqual(aggregateMetrics([scoped]));
    const empty = aggregateMetrics([context, excluded]);
    expect(value(empty.scopedFiles)).toBe(0);
    expect(value(empty.physicalLines)).toBe(0);
    expect(value(empty.sourceLines)).toBe(0);
    expect(value(empty.contracts)).toBe(0);
    expect(value(empty.callables)).toBe(0);
  });

  it('counts byte-identical scoped files at different paths twice', () => {
    const aggregate = aggregateMetrics([
      twoContractFile('contracts/A.sol'),
      twoContractFile('contracts/Copy.sol'),
    ]);
    expect(value(aggregate.scopedFiles)).toBe(2);
    expect(value(aggregate.physicalLines)).toBe(2);
    expect(value(aggregate.sourceLines)).toBe(2);
    expect(value(aggregate.contracts)).toBe(4);
  });

  it('counts modifiers as callables and gives one declaration range per contract and callable', () => {
    const source = makeSource('contracts/M.sol', 'contract M { modifier m() { _; } }\n');
    const owner = contract(source, 'M', 'contract M { modifier m() { _; } }');
    const aggregate = aggregateMetrics([
      parsedMetrics(source, [owner, modifier(source, owner, 'modifier m() { _; }')]),
    ]);
    expect(value(aggregate.contracts)).toBe(1);
    expect(value(aggregate.callables)).toBe(1);
    const callables = aggregate.callables;
    expect(callables.status === 'measured' && callables.evidence).toHaveLength(1);
  });

  it('is deep-equal for every input order', () => {
    const files = [
      twoContractFile('contracts/B.sol'),
      twoContractFile('contracts/A.sol'),
      twoContractFile('lib/C.sol', 'context'),
      parsedMetrics(makeSource('contracts/Z.sol', 'contract Z {}\n'), []),
    ];
    const expected = aggregateMetrics(files);
    for (const order of [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [1, 3, 0, 2],
      [2, 0, 3, 1],
    ]) {
      const permuted = order.map((index) => files[index] as FileMetrics);
      expect(aggregateMetrics(permuted)).toEqual(expected);
    }
  });

  it('makes sourceLines, contracts and callables unavailable when a scoped file failed', () => {
    const failed = failedMetrics(makeSource('contracts/Bad.sol', 'contract {\nbroken\n'));
    const aggregate = aggregateMetrics([twoContractFile('contracts/A.sol'), failed]);
    expect(value(aggregate.scopedFiles)).toBe(2);
    expect(value(aggregate.physicalLines)).toBe(3);
    for (const field of [aggregate.sourceLines, aggregate.contracts, aggregate.callables]) {
      expect(field).toEqual({ status: 'unavailable', reason: 'scoped-file-unavailable' });
    }
  });

  it('ignores a failed context file', () => {
    const failed = failedMetrics(makeSource('lib/Bad.sol', 'broken', 'context'));
    const aggregate = aggregateMetrics([twoContractFile('contracts/A.sol'), failed]);
    expect(value(aggregate.sourceLines)).toBe(1);
  });

  it('rejects a repeated file id', () => {
    const file = twoContractFile('contracts/A.sol');
    expect(() => aggregateMetrics([file, file])).toThrow(TypeError);
  });

  it('carries one whole-file evidence reference per scoped file', () => {
    const a = twoContractFile('contracts/A.sol');
    const b = twoContractFile('contracts/B.sol');
    const aggregate = aggregateMetrics([b, a]);
    expect(aggregate.scopedFiles.status === 'measured' && aggregate.scopedFiles.evidence).toEqual([
      a.wholeFile,
      b.wholeFile,
    ]);
    expect(aggregate.sourceLines.status === 'measured' && aggregate.sourceLines.evidence).toEqual([
      a.wholeFile,
      b.wholeFile,
    ]);
  });
});
