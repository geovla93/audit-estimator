import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG } from '../../src/application/dependency-reuse/catalog.ts';
import {
  REASON_ALLOWANCE,
  REASON_CATALOG_INVALID,
  REASON_CATALOG_UNAVAILABLE,
  REASON_PARSER_MISMATCH,
  catalogProblem,
  classifyDependencies,
} from '../../src/application/dependency-reuse/classify.ts';
import type { ClassifyFile } from '../../src/application/dependency-reuse/classify.ts';
import {
  HASH_CHUNK_BYTES,
  NORMALIZER_VERSION,
  RecognizerAllowance,
  RecognizerLimitError,
  computeCatalogDigest,
  fingerprintDeclaration,
  indexTokens,
} from '../../src/application/dependency-reuse/fingerprint.ts';
import type { DependencyCatalog } from '../../src/application/dependency-reuse/types.ts';
import { trustedParserLabel } from '../../src/application/envelope.ts';
import { BudgetError } from '../../src/discovery/budget.ts';
import { contractIdentity, fileIdentity } from '../../src/domain/canonical.ts';
import type { DeclarationKind, FileScopeEntry, SourceRange } from '../../src/domain/types.ts';
import { buildFileMetrics } from '../../src/metrics/structural.ts';
import type {
  ParseFileResult,
  ParserDeclaration,
  ParserEvent,
  ParserSource,
  ParserToken,
  ParserTokenKind,
} from '../../src/parser/protocol.ts';

type Part = readonly [ParserTokenKind, string];

interface Built {
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly tokens: ParserToken[];
}

const fileId = fileIdentity('contracts/Dep.sol');

/** Lays out tokens separated by `separator`; ranges are original UTF-8 byte offsets. */
function layout(parts: readonly Part[], separator = ' ', prefix = ''): Built {
  let text = prefix;
  const tokens: ParserToken[] = [];
  parts.forEach(([kind, value], index) => {
    if (index > 0) text += separator;
    const startByte = Buffer.byteLength(text, 'utf8');
    text += value;
    tokens.push({
      fileId,
      kind,
      range: {
        startByte,
        endByte: startByte + Buffer.byteLength(value, 'utf8'),
        start: { line: 1, column: 1 },
        end: { line: 1, column: 1 },
      },
    });
  });
  return { text, bytes: Buffer.from(text, 'utf8'), tokens };
}

function spanOf(tokens: readonly ParserToken[]): SourceRange {
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (first === undefined || last === undefined) throw new Error('empty');
  return { ...first.range, endByte: last.range.endByte };
}

const noop = (): Promise<void> => Promise.resolve();

const TINY: readonly Part[] = [
  ['keyword', 'library'],
  ['identifier', 'Tiny'],
  ['punctuation', '{'],
  ['punctuation', '}'],
];

async function digestOf(
  built: Built,
  kind: DeclarationKind,
  name: string,
  assembly: readonly SourceRange[] = [],
): Promise<string> {
  const index = indexTokens(built.tokens, assembly);
  const result = await fingerprintDeclaration(
    index,
    built.bytes,
    { kind, name, range: spanOf(built.tokens) },
    noop,
  );
  return result.digest;
}

describe('fingerprints (framing and normalization)', () => {
  it('matches the independently calculated framing oracle for `library Tiny {}`', async () => {
    const oracle =
      '22:dependency-declaration18:solidity-tokens-v17:library4:Tiny1:47:keyword7:library10:identifier4:Tiny11:punctuation1:{11:punctuation1:}';
    // The 135-byte digest input and its SHA-256 were calculated independently with Python's
    // hashlib over this literal; the test recomputes only the hash of the literal.
    expect(Buffer.byteLength(oracle, 'ascii')).toBe(135);
    const expected = '7e69f4495d8e7fe43b38035f36609488707492fd70ef492aad45afa90db0dc8d';
    expect(createHash('sha256').update(oracle, 'ascii').digest('hex')).toBe(expected);
    expect(NORMALIZER_VERSION).toBe('solidity-tokens-v1');
    expect(await digestOf(layout(TINY), 'library', 'Tiny')).toBe(expected);
  });

  it('ignores whitespace, comments, NatSpec, CRLF, a BOM and Unicode spacing', async () => {
    const plain = layout(TINY);
    const base = await digestOf(plain, 'library', 'Tiny');
    const comments = layout(
      [
        ['natspec', '/// @title Tiny'],
        ...TINY.slice(0, 2),
        ['comment', '// flattening banner'],
        ...TINY.slice(2),
      ],
      '\r\n\t 　',
      '﻿',
    );
    // The same significant tokens at different original byte offsets: evidence stays in original
    // coordinates while the digest is unchanged.
    expect(comments.tokens[1]?.range.startByte).not.toBe(plain.tokens[0]?.range.startByte);
    const index = indexTokens(comments.tokens, []);
    const result = await fingerprintDeclaration(
      index,
      comments.bytes,
      { kind: 'library', name: 'Tiny', range: spanOf(comments.tokens) },
      noop,
    );
    expect(result.digest).toBe(base);
    expect(result.tokenCount).toBe(4);
  });

  it('normalizes only uint and int keyword aliases outside assembly', async () => {
    const aliased = layout([
      ['keyword', 'interface'],
      ['identifier', 'I'],
      ['punctuation', '{'],
      ['keyword', 'uint'],
      ['keyword', 'int'],
      ['punctuation', '}'],
    ]);
    const spelled = layout([
      ['keyword', 'interface'],
      ['identifier', 'I'],
      ['punctuation', '{'],
      ['keyword', 'uint256'],
      ['keyword', 'int256'],
      ['punctuation', '}'],
    ]);
    expect(await digestOf(aliased, 'interface', 'I')).toBe(
      await digestOf(spelled, 'interface', 'I'),
    );
    // Widths, other types, identifiers and strings never normalize away.
    const shapes: readonly (readonly [ParserTokenKind, string])[] = [
      ['keyword', 'uint128'],
      ['keyword', 'bytes32'],
      ['identifier', 'uint'],
      ['string', '"uint"'],
    ];
    for (const [kind, text] of shapes) {
      const other = layout([
        ['keyword', 'interface'],
        ['identifier', 'I'],
        ['punctuation', '{'],
        [kind, text],
        ['keyword', 'int256'],
        ['punctuation', '}'],
      ]);
      expect(await digestOf(other, 'interface', 'I')).not.toBe(
        await digestOf(spelled, 'interface', 'I'),
      );
    }
    // Inside a Yul assembly range the keyword spelling is preserved.
    const inAssembly = layout([
      ['keyword', 'library'],
      ['identifier', 'L'],
      ['punctuation', '{'],
      ['keyword', 'uint'],
      ['punctuation', '}'],
    ]);
    const asm = inAssembly.tokens[3]?.range;
    if (asm === undefined) throw new Error('fixture');
    const alias = layout([
      ['keyword', 'library'],
      ['identifier', 'L'],
      ['punctuation', '{'],
      ['keyword', 'uint256'],
      ['punctuation', '}'],
    ]);
    expect(await digestOf(inAssembly, 'library', 'L', [asm])).not.toBe(
      await digestOf(alias, 'library', 'L'),
    );
    expect(await digestOf(inAssembly, 'library', 'L')).toBe(await digestOf(alias, 'library', 'L'));
  });

  it('separates every token boundary, kind, name and declaration kind', async () => {
    const joined = layout([
      ['keyword', 'library'],
      ['identifier', 'ab'],
      ['identifier', 'c'],
    ]);
    const split = layout([
      ['keyword', 'library'],
      ['identifier', 'a'],
      ['identifier', 'bc'],
    ]);
    expect(await digestOf(joined, 'library', 'X')).not.toBe(await digestOf(split, 'library', 'X'));
    const base = await digestOf(layout(TINY), 'library', 'Tiny');
    expect(await digestOf(layout(TINY), 'library', 'Other')).not.toBe(base);
    expect(await digestOf(layout(TINY), 'contract', 'Tiny')).not.toBe(base);
    const changedKind = layout([TINY[0] as Part, ['keyword', 'Tiny'], ...TINY.slice(2)]);
    expect(await digestOf(changedKind, 'library', 'Tiny')).not.toBe(base);
    const oneToken = layout([...TINY.slice(0, 3), ['punctuation', ';'], TINY[3] as Part]);
    expect(await digestOf(oneToken, 'library', 'Tiny')).not.toBe(base);
    // Numeric literals carry the coarse `unknown` kind and hash their exact text.
    const one = layout([...TINY.slice(0, 3), ['unknown', '1'], TINY[3] as Part]);
    const two = layout([...TINY.slice(0, 3), ['unknown', '2'], TINY[3] as Part]);
    expect(await digestOf(one, 'library', 'Tiny')).not.toBe(await digestOf(two, 'library', 'Tiny'));
  });

  it('hashes a huge token in slices that equal the unsliced definition, with checkpoints', async () => {
    const huge = 'x'.repeat(HASH_CHUNK_BYTES * 3 + 17);
    const built = layout([
      ['keyword', 'library'],
      ['identifier', 'Big'],
      ['punctuation', '{'],
      ['string', `"${huge}"`],
      ['punctuation', '}'],
    ]);
    const literal = `"${huge}"`;
    const expectedInput =
      '22:dependency-declaration18:solidity-tokens-v17:library3:Big1:5' +
      '7:keyword7:library10:identifier3:Big11:punctuation1:{' +
      `6:string${Buffer.byteLength(literal)}:${literal}11:punctuation1:}`;
    const expected = createHash('sha256').update(expectedInput, 'utf8').digest('hex');
    let checkpoints = 0;
    const result = await fingerprintDeclaration(
      indexTokens(built.tokens, []),
      built.bytes,
      { kind: 'library', name: 'Big', range: spanOf(built.tokens) },
      () => {
        checkpoints += 1;
        return Promise.resolve();
      },
    );
    expect(result.digest).toBe(expected);
    // Four slices need three checkpoints between them; five small tokens need none.
    expect(checkpoints).toBe(3);
    const failure = new Error('interrupted');
    let seen = 0;
    await expect(
      fingerprintDeclaration(
        indexTokens(built.tokens, []),
        built.bytes,
        { kind: 'library', name: 'Big', range: spanOf(built.tokens) },
        () => {
          seen += 1;
          return seen === 2 ? Promise.reject(failure) : Promise.resolve();
        },
      ),
    ).rejects.toBe(failure);
    expect(seen).toBe(2);
  });

  it('checkpoints every record interval while hashing many small tokens', async () => {
    const parts: Part[] = [
      ['keyword', 'library'],
      ['identifier', 'Many'],
      ['punctuation', '{'],
    ];
    for (let index = 0; index < 600; index += 1) parts.push(['unknown', String(index)]);
    parts.push(['punctuation', '}']);
    const built = layout(parts);
    let checkpoints = 0;
    await fingerprintDeclaration(
      indexTokens(built.tokens, []),
      built.bytes,
      { kind: 'library', name: 'Many', range: spanOf(built.tokens) },
      () => {
        checkpoints += 1;
        return Promise.resolve();
      },
    );
    expect(checkpoints).toBe(2);
  });

  it('enforces the local recognizer allowance in tokens and bytes', async () => {
    const built = layout(TINY);
    const run = (allowance: RecognizerAllowance): Promise<unknown> =>
      fingerprintDeclaration(
        indexTokens(built.tokens, []),
        built.bytes,
        { kind: 'library', name: 'Tiny', range: spanOf(built.tokens) },
        noop,
        allowance,
      );
    await expect(run(new RecognizerAllowance(4, 1000))).resolves.toBeDefined();
    await expect(run(new RecognizerAllowance(3, 1000))).rejects.toBeInstanceOf(
      RecognizerLimitError,
    );
    await expect(run(new RecognizerAllowance(1000, 5))).rejects.toBeInstanceOf(
      RecognizerLimitError,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// catalog integrity and classification against a test-only catalog
// ---------------------------------------------------------------------------------------------

const TINY_DIGEST = '7e69f4495d8e7fe43b38035f36609488707492fd70ef492aad45afa90db0dc8d';
const COMMIT = 'a'.repeat(40);

function testCatalog(overrides: Partial<DependencyCatalog> = {}): DependencyCatalog {
  const body: Omit<DependencyCatalog, 'digest'> = {
    status: 'available',
    version: '9.9.9',
    parserVersion: 'test-parser',
    normalizerVersion: NORMALIZER_VERSION,
    grammarSets: [['0.8.4', '0.8.28']],
    files: [
      {
        id: 'ref-b@v2:contracts/Tiny.sol',
        repository: 'https://example.invalid/b',
        tag: 'v2',
        commit: COMMIT,
        path: 'contracts/Tiny.sol',
        sha256: 'b'.repeat(64),
        license: 'MIT',
        pragma: 'solidity ^0.8.0',
        selectedGrammar: '0.8.28',
        grammarSet: 0,
      },
      {
        id: 'ref-a@v1:contracts/Tiny.sol',
        repository: 'https://example.invalid/a',
        tag: 'v1',
        commit: COMMIT,
        path: 'contracts/Tiny.sol',
        sha256: 'c'.repeat(64),
        license: 'MIT',
        pragma: 'solidity ^0.8.0',
        selectedGrammar: '0.8.28',
        grammarSet: 0,
      },
      {
        id: 'ref-c@v3:contracts/Tiny.sol',
        repository: 'https://example.invalid/c',
        tag: 'v3',
        commit: COMMIT,
        path: 'contracts/Tiny.sol',
        sha256: 'd'.repeat(64),
        license: 'MIT',
        pragma: 'solidity ^0.8.0',
        selectedGrammar: '0.8.28',
        grammarSet: 1,
      },
    ],
    declarations: [
      { file: 0, kind: 'library', name: 'Tiny', digest: TINY_DIGEST, tokenCount: 4 },
      { file: 1, kind: 'library', name: 'Tiny', digest: TINY_DIGEST, tokenCount: 4 },
      { file: 2, kind: 'library', name: 'Tiny', digest: TINY_DIGEST, tokenCount: 4 },
    ],
    ...overrides,
  };
  // The third file belongs to a grammar set that excludes the target's selected grammar.
  const withSets: Omit<DependencyCatalog, 'digest'> = {
    ...body,
    grammarSets: overrides.grammarSets ?? [['0.8.4', '0.8.28'], ['0.7.0']],
  };
  const fixed: Omit<DependencyCatalog, 'digest'> = {
    ...withSets,
    files: withSets.files.map((file) =>
      file.id.startsWith('ref-c') ? { ...file, selectedGrammar: '0.7.0' } : file,
    ),
  };
  return { ...fixed, digest: computeCatalogDigest(fixed) };
}

interface Target {
  readonly file: ClassifyFile;
  readonly contractId: ReturnType<typeof contractIdentity>;
}

function targetWith(
  parts: readonly Part[],
  options: {
    readonly kind?: DeclarationKind;
    readonly name?: string;
    readonly parserVersion?: string;
    readonly selectedVersion?: string;
    readonly extra?: readonly (readonly Part[])[];
  } = {},
): Target {
  const kind = options.kind ?? 'library';
  const name = options.name ?? 'Tiny';
  const groups: readonly (readonly Part[])[] = [parts, ...(options.extra ?? [])];
  const all: Part[] = groups.flatMap((group) => [...group]);
  const built = layout(all, ' ');
  const declarations: ParserDeclaration[] = [];
  let offset = 0;
  const ranges: SourceRange[] = [];
  for (const group of groups) {
    const slice = built.tokens.slice(offset, offset + group.length);
    ranges.push(spanOf(slice));
    offset += group.length;
  }
  const names = [name, ...(options.extra ?? []).map((_group, index) => `Extra${index}`)];
  const kinds: DeclarationKind[] = [kind, ...(options.extra ?? []).map(() => 'library' as const)];
  ranges.forEach((range, index) => {
    const declKind = kinds[index] ?? 'library';
    const id = contractIdentity('contracts/Dep.sol', declKind, range.startByte);
    declarations.push({
      id,
      kind: declKind,
      name: names[index] ?? 'X',
      contractId: id,
      callableId: null,
      declarationRange: range,
      nameRange: range,
      bodyRange: range,
      hasBody: true,
      attributes: [],
    });
  });
  const events: ParserEvent[] = [];
  const result: Extract<ParseFileResult, { status: 'parsed' }> = {
    status: 'parsed',
    fileId,
    version: {
      selectedVersion: options.selectedVersion ?? '0.8.28',
      selectionSource: 'inferred',
      ignoredHint: 'not-applicable',
      compatibleVersions: [options.selectedVersion ?? '0.8.28'],
      installedVersions: [options.selectedVersion ?? '0.8.28'],
      pragmaRanges: [],
      parserVersion: options.parserVersion ?? 'test-parser',
    },
    tokens: built.tokens,
    declarations,
    imports: [],
    events,
    diagnostics: [],
    visitedNodes: 10,
  };
  const byteHash = createHash('sha256').update(built.bytes).digest('hex');
  const entry: FileScopeEntry = {
    fileId,
    path: 'contracts/Dep.sol',
    role: 'scoped',
    ownership: 'first-party',
    ownershipEvidence: [],
    physicalIdentity: 'fixture',
    byteHash,
  };
  const source: ParserSource = {
    fileId,
    snapshot: {
      canonicalPath: 'contracts/Dep.sol',
      absolutePath: '/fixture/contracts/Dep.sol',
      originalBytes: built.bytes,
      originalText: built.text,
      byteHash,
    },
    manifestEntry: entry,
  };
  const metrics = buildFileMetrics(source, result);
  const first = declarations[0];
  if (first === undefined || first.contractId === null) throw new Error('fixture');
  return {
    file: { metrics, source, result },
    contractId: contractIdentity('contracts/Dep.sol', kind, ranges[0]?.startByte ?? 0),
  };
}

describe('catalog integrity', () => {
  it('accepts a well-formed catalog and rejects every kind of corruption', () => {
    expect(catalogProblem(testCatalog())).toBeNull();
    const good = testCatalog();
    expect(catalogProblem({ ...good, status: 'unavailable' })).toBe(REASON_CATALOG_UNAVAILABLE);
    expect(catalogProblem({ ...good, digest: 'e'.repeat(64) })).toBe(REASON_CATALOG_INVALID);
    expect(catalogProblem({ ...good, version: '8.8.8' })).toBe(REASON_CATALOG_INVALID);
    expect(catalogProblem({ ...good, normalizerVersion: 'solidity-tokens-v0' })).toBe(
      REASON_CATALOG_INVALID,
    );
    const rebuild = (changes: Partial<DependencyCatalog>): DependencyCatalog => {
      const body = { ...good, ...changes };
      const { digest: _digest, ...rest } = body;
      return { ...rest, digest: computeCatalogDigest(rest) };
    };
    expect(
      catalogProblem(
        rebuild({
          declarations: [
            { file: 99, kind: 'library', name: 'X', digest: TINY_DIGEST, tokenCount: 1 },
          ],
        }),
      ),
    ).toBe(REASON_CATALOG_INVALID);
    expect(
      catalogProblem(
        rebuild({
          declarations: [{ file: 0, kind: 'library', name: 'X', digest: 'zz', tokenCount: 1 }],
        }),
      ),
    ).toBe(REASON_CATALOG_INVALID);
    expect(
      catalogProblem(rebuild({ files: good.files.map((file) => ({ ...file, commit: 'main' })) })),
    ).toBe(REASON_CATALOG_INVALID);
    expect(catalogProblem(rebuild({ parserVersion: '' }))).toBe(REASON_CATALOG_INVALID);
    expect(catalogProblem(rebuild({ grammarSets: [[]] }))).toBe(REASON_CATALOG_INVALID);
    expect(
      catalogProblem(rebuild({ files: good.files.map((file) => ({ ...file, grammarSet: 7 })) })),
    ).toBe(REASON_CATALOG_INVALID);
  });

  it('was generated with the installed parser, so an upgrade forces regeneration', async () => {
    expect(await trustedParserLabel()).toBe(`slang@${BUNDLED_CATALOG.parserVersion}`);
  });

  it('describes the bundled catalog with immutable official provenance', () => {
    expect(BUNDLED_CATALOG.status).toBe('available');
    expect(catalogProblem(BUNDLED_CATALOG)).toBeNull();
    expect(BUNDLED_CATALOG.digest).toBe(computeCatalogDigest(BUNDLED_CATALOG));
    expect(BUNDLED_CATALOG.normalizerVersion).toBe(NORMALIZER_VERSION);
    const ids = new Set<string>();
    for (const file of BUNDLED_CATALOG.files) {
      expect(file.commit).toMatch(/^[0-9a-f]{40}$/u);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(file.repository).toMatch(
        /^https:\/\/github\.com\/(OpenZeppelin|Uniswap)\/[A-Za-z0-9._-]+$/u,
      );
      expect(BUNDLED_CATALOG.grammarSets[file.grammarSet]).toContain(file.selectedGrammar);
    }
    for (const declaration of BUNDLED_CATALOG.declarations) {
      const file = BUNDLED_CATALOG.files[declaration.file];
      const id = `${file?.id ?? ''}#${declaration.name}`;
      expect(id.length).toBeLessThanOrEqual(128);
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
    const names = new Set(BUNDLED_CATALOG.declarations.map((item) => item.name));
    for (const expected of [
      'Address',
      'Clones',
      'ERC20',
      'Ownable',
      'Context',
      'SafeMath',
      'Initializable',
      'IERC20',
      'IUniswapV2Factory',
      'IUniswapV2Pair',
      'IUniswapV2Router01',
      'IUniswapV2Router02',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });
});

describe('catalog classification', () => {
  const classify = async (
    target: Target,
    catalog: DependencyCatalog = testCatalog(),
    checkpoint: () => Promise<void> = noop,
    limits: { maxTokensPerFile?: number; maxBytesPerFile?: number } = {},
  ): Promise<ReturnType<typeof classifyDependencies>> =>
    classifyDependencies({ catalog, files: [target.file], checkpoint, ...limits });

  it('matches complete content, keeping only grammar-compatible references in stable order', async () => {
    const target = targetWith(TINY);
    const state = (await classify(target)).get(fileId);
    expect(state?.status).toBe('available');
    const matches = state?.status === 'available' ? state.matches : [];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.digest).toBe(TINY_DIGEST);
    expect(matches[0]?.contractId).toBe(target.contractId);
    // ref-c's grammar set excludes the target's selected grammar and is dropped; the rest sort.
    expect(matches[0]?.referenceIds).toEqual([
      'ref-a@v1:contracts/Tiny.sol#Tiny',
      'ref-b@v2:contracts/Tiny.sol#Tiny',
    ]);
  });

  it('never matches by name, marker or comment and never fuzzily', async () => {
    const spoofed = targetWith([
      ['comment', '// Dependency file: Tiny.sol (OpenZeppelin v4.3.2)'],
      ...TINY.slice(0, 3),
      ['punctuation', ';'],
      TINY[3] as Part,
    ]);
    const state = (await classify(spoofed)).get(fileId);
    expect(state).toEqual({ status: 'available', matches: [] });
    const renamed = targetWith(TINY, { name: 'Renamed' });
    expect((await classify(renamed)).get(fileId)).toEqual({ status: 'available', matches: [] });
  });

  it('refuses a different selected grammar outside every reference set', async () => {
    const target = targetWith(TINY, { selectedVersion: '0.5.0' });
    expect((await classify(target)).get(fileId)).toEqual({ status: 'available', matches: [] });
  });

  it('refuses parser, normalizer and catalog problems without awarding a match', async () => {
    const target = targetWith(TINY, { parserVersion: 'other-parser' });
    expect((await classify(target)).get(fileId)).toEqual({
      status: 'unavailable',
      reason: REASON_PARSER_MISMATCH,
    });
    const good = targetWith(TINY);
    expect((await classify(good, { ...testCatalog(), status: 'unavailable' })).get(fileId)).toEqual(
      {
        status: 'unavailable',
        reason: REASON_CATALOG_UNAVAILABLE,
      },
    );
    expect(
      (await classify(good, { ...testCatalog(), digest: 'f'.repeat(64) })).get(fileId),
    ).toEqual({
      status: 'unavailable',
      reason: REASON_CATALOG_INVALID,
    });
  });

  it('falls back atomically when only the local allowance is exhausted', async () => {
    // Two declarations of four tokens each: the first would match, but the allowance dies in the
    // second, so the whole file is discarded rather than keeping a partial recognition result.
    const target = targetWith(TINY, { extra: [TINY] });
    const state = (await classify(target, testCatalog(), noop, { maxTokensPerFile: 6 })).get(
      fileId,
    );
    expect(state).toEqual({ status: 'unavailable', reason: REASON_ALLOWANCE });
    const roomy = (await classify(target, testCatalog(), noop, { maxTokensPerFile: 100 })).get(
      fileId,
    );
    expect(roomy?.status).toBe('available');
  });

  it('propagates shared cancellation, deadline and limit failures instead of falling back', async () => {
    const target = targetWith(TINY);
    for (const kind of ['cancelled', 'deadline', 'limit'] as const) {
      const failure = new BudgetError(kind);
      await expect(classify(target, testCatalog(), () => Promise.reject(failure))).rejects.toBe(
        failure,
      );
    }
    // A failure raised deep inside hashing (second checkpoint) propagates as well.
    const huge = targetWith([
      ['keyword', 'library'],
      ['identifier', 'Tiny'],
      ['punctuation', '{'],
      ['string', `"${'x'.repeat(HASH_CHUNK_BYTES * 2)}"`],
      ['punctuation', '}'],
    ]);
    const failure = new BudgetError('deadline');
    let calls = 0;
    await expect(
      classify(huge, testCatalog(), () => {
        calls += 1;
        return calls >= 3 ? Promise.reject(failure) : Promise.resolve();
      }),
    ).rejects.toBe(failure);
  });

  it('keeps unmatched custom code out of the match list entirely', async () => {
    const target = targetWith(TINY, {
      extra: [
        [
          ['keyword', 'library'],
          ['identifier', 'Custom'],
          ['punctuation', '{'],
          ['punctuation', '}'],
        ],
      ],
    });
    const state = (await classify(target)).get(fileId);
    expect(
      state?.status === 'available' ? state.matches.map((item) => item.contractId) : [],
    ).toEqual([target.contractId]);
  });
});
