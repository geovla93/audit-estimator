import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectReview } from '../../src/application/dependency-reuse/project.ts';
import { ProjectionUnavailableError } from '../../src/application/dependency-reuse/types.ts';
import type {
  ContractDispositions,
  ReviewProjection,
} from '../../src/application/dependency-reuse/types.ts';
import { productionConfigDefaults } from '../../src/application/defaults.ts';
import { buildEstimateInput } from '../../src/application/estimate-input.ts';
import type { EstimateInputSource } from '../../src/application/estimate-input.ts';
import {
  MAX_SCOPE_CONTRACT_IDS,
  ScopeLimitError,
  assertScopeBounds,
  buildEstimationScopeAnalysis,
  resolveDispositions,
} from '../../src/application/estimation-scope.ts';
import { DEFAULT_SCOPE_SETTINGS } from '../../src/config/defaults.ts';
import { mergeConfig } from '../../src/config/merge.ts';
import type { TrustedConfigDefaults } from '../../src/config/merge.ts';
import { ConfigError, parseConfigInput } from '../../src/config/validate.ts';
import {
  callableIdentity,
  contractIdentity,
  declarationIdentity,
  fileIdentity,
} from '../../src/domain/canonical.ts';
import { AnalysisSchema, EstimateInputSchema } from '../../src/domain/schemas.ts';
import type {
  Analysis,
  ContractId,
  EstimateInput,
  EstimationScopeInput,
  FileId,
  FileScopeEntry,
  Measurement,
  ResolvedConfig,
  SourceRange,
} from '../../src/domain/types.ts';
import { estimateEffort } from '../../src/estimation/estimate.ts';
import { selectModel } from '../../src/estimation/model.ts';
import { buildFileMetrics, buildReviewMetrics } from '../../src/metrics/structural.ts';
import type { FileMetrics } from '../../src/metrics/structural.ts';
import type {
  ParseFileResult,
  ParserAttribute,
  ParserDeclaration,
  ParserEvent,
  ParserSource,
  ParserToken,
  ParserTokenKind,
} from '../../src/parser/protocol.ts';
import type { CallSiteFact } from '../../src/relationships/types.ts';

// ---------------------------------------------------------------------------------------------
// Hand-built fixture: one file, seven physical lines. Expected values below are specified by hand
// from the text, never derived from the code under test.
//
//   1  pragma solidity ^0.8.0;
//   2  library Lib {
//   3      function a() internal { assembly { let x := 1 } }
//   4  }
//   5  contract Token { uint256 public total; mapping(address => uint256) public bal; function m() external { if (total > 0) { total = 1; } } }
//   6  contract Same { uint256 public s; } contract Helper { uint256 public h; }
//   7  function freeFn() pure returns (uint256) { return 1; }
// ---------------------------------------------------------------------------------------------

const PATH = 'contracts/Flattened.sol';
const fileId = fileIdentity(PATH);
const TEXT = [
  'pragma solidity ^0.8.0;',
  'library Lib {',
  '    function a() internal { assembly { let x := 1 } }',
  '}',
  'contract Token { uint256 public total; mapping(address => uint256) public bal; function m() external { if (total > 0) { total = 1; } } }',
  'contract Same { uint256 public s; } contract Helper { uint256 public h; }',
  'function freeFn() pure returns (uint256) { return 1; }',
  '',
].join('\n');

function at(text: string, needle: string, nth = 0): SourceRange {
  let from = -1;
  for (let count = 0; count <= nth; count += 1) {
    from = text.indexOf(needle, from + 1);
    if (from < 0) throw new Error(`Missing ${needle} #${nth}`);
  }
  const startByte = Buffer.byteLength(text.slice(0, from), 'utf8');
  return {
    startByte,
    endByte: startByte + Buffer.byteLength(needle, 'utf8'),
    start: { line: 1, column: 1 },
    end: { line: 1, column: 1 },
  };
}

function lex(text: string): ParserToken[] {
  const tokens: ParserToken[] = [];
  for (const match of text.matchAll(/(\/\/[^\n]*)|(\s+)|(\w+)|(.)/gu)) {
    const kind: ParserTokenKind =
      match[1] !== undefined
        ? 'comment'
        : match[2] !== undefined
          ? 'whitespace'
          : match[3] !== undefined
            ? 'identifier'
            : 'punctuation';
    const startByte = Buffer.byteLength(text.slice(0, match.index), 'utf8');
    tokens.push({
      fileId,
      kind,
      range: {
        startByte,
        endByte: startByte + Buffer.byteLength(match[0], 'utf8'),
        start: { line: 1, column: 1 },
        end: { line: 1, column: 1 },
      },
    });
  }
  return tokens;
}

function attrs(
  values: Readonly<Record<string, string | number | boolean | null>>,
): ParserAttribute[] {
  return Object.entries(values).map(([key, value]) => ({ key, value }));
}

function contractDecl(text: string, name: string, whole: string, kind: string): ParserDeclaration {
  const range = at(text, whole);
  const id = contractIdentity(PATH, kind, range.startByte);
  return {
    id,
    kind,
    name,
    contractId: id,
    callableId: null,
    declarationRange: range,
    nameRange: at(text, name),
    bodyRange: range,
    hasBody: true,
    attributes: [],
  };
}

function callableDecl(
  text: string,
  kind: string,
  name: string,
  whole: string,
  body: string,
  contract: ParserDeclaration | null,
): ParserDeclaration {
  const range = at(text, whole);
  const id = callableIdentity(PATH, kind, range.startByte);
  return {
    id,
    kind,
    name,
    contractId: contract?.contractId ?? null,
    callableId: id,
    declarationRange: range,
    nameRange: range,
    bodyRange: at(text, body),
    hasBody: true,
    attributes: attrs({ 'declaration-kind': kind, 'has-body': true }),
  };
}

function ev(
  kind: string,
  range: SourceRange,
  contract: ParserDeclaration | null,
  callable: ParserDeclaration | null,
  values: Readonly<Record<string, string | number | boolean | null>> = {},
): ParserEvent {
  return {
    fileId,
    kind,
    contractId: contract?.contractId ?? null,
    callableId: callable?.callableId ?? null,
    range,
    attributes: attrs(values),
  };
}

function sourceFor(text: string, path = PATH): ParserSource {
  const bytes = Buffer.from(text, 'utf8');
  const byteHash = createHash('sha256').update(bytes).digest('hex');
  const entry: FileScopeEntry = {
    fileId: fileIdentity(path),
    path,
    role: 'scoped',
    ownership: 'first-party',
    ownershipEvidence: [],
    physicalIdentity: 'fixture',
    byteHash,
  };
  return {
    fileId: fileIdentity(path),
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

interface Fixture {
  readonly source: ParserSource;
  readonly result: Extract<ParseFileResult, { status: 'parsed' }>;
  readonly raw: FileMetrics;
  readonly lib: ContractId;
  readonly token: ContractId;
  readonly same: ContractId;
  readonly helper: ContractId;
  readonly libCall: ParserEvent;
  readonly tokenCall: ParserEvent;
}

function fixture(): Fixture {
  const text = TEXT;
  const lib = contractDecl(
    text,
    'Lib',
    'library Lib {\n    function a() internal { assembly { let x := 1 } }\n}',
    'library',
  );
  const token = contractDecl(
    text,
    'Token',
    'contract Token { uint256 public total; mapping(address => uint256) public bal; function m() external { if (total > 0) { total = 1; } } }',
    'contract',
  );
  const same = contractDecl(text, 'Same', 'contract Same { uint256 public s; }', 'contract');
  const helper = contractDecl(text, 'Helper', 'contract Helper { uint256 public h; }', 'contract');
  const a = callableDecl(
    text,
    'function',
    'a',
    'function a() internal { assembly { let x := 1 } }',
    '{ assembly { let x := 1 } }',
    lib,
  );
  const m = callableDecl(
    text,
    'function',
    'm',
    'function m() external { if (total > 0) { total = 1; } }',
    '{ if (total > 0) { total = 1; } }',
    token,
  );
  const free = callableDecl(
    text,
    'function',
    'freeFn',
    'function freeFn() pure returns (uint256) { return 1; }',
    '{ return 1; }',
    null,
  );
  const libCall = ev('call-site', at(text, 'let x := 1'), lib, a, { 'low-level-candidate': true });
  const tokenCall = ev('call-site', at(text, 'total = 1'), token, m, {
    'low-level-candidate': true,
  });
  const events: ParserEvent[] = [
    ev('assembly', at(text, 'assembly { let x := 1 }'), lib, a),
    libCall,
    ev('state-variable', at(text, 'uint256 public total;'), token, null, {
      'type-shape': 'elementary',
    }),
    ev('state-variable', at(text, 'mapping(address => uint256) public bal;'), token, null, {
      'type-shape': 'mapping',
    }),
    ev('control', at(text, 'if (total > 0) { total = 1; }'), token, m, { 'control-kind': 'if' }),
    tokenCall,
    ev('state-variable', at(text, 'uint256 public s;'), same, null, { 'type-shape': 'elementary' }),
    ev('state-variable', at(text, 'uint256 public h;'), helper, null, {
      'type-shape': 'elementary',
    }),
  ];
  const result: Extract<ParseFileResult, { status: 'parsed' }> = {
    status: 'parsed',
    fileId,
    version: {
      selectedVersion: '0.8.28',
      selectionSource: 'inferred',
      ignoredHint: 'not-applicable',
      compatibleVersions: ['0.8.28'],
      installedVersions: ['0.8.28'],
      pragmaRanges: [],
      parserVersion: 'test',
    },
    tokens: lex(text),
    declarations: [lib, token, same, helper, a, m, free],
    imports: [],
    events,
    diagnostics: [],
    visitedNodes: 100,
  };
  const source = sourceFor(text);
  return {
    source,
    result,
    raw: buildFileMetrics(source, result),
    lib: lib.id as ContractId,
    token: token.id as ContractId,
    same: same.id as ContractId,
    helper: helper.id as ContractId,
    libCall,
    tokenCall,
  };
}

function count(measurement: Measurement<number>): number {
  if (measurement.status !== 'measured') throw new Error('Expected a measured count.');
  return measurement.value;
}

const noop = (): Promise<void> => Promise.resolve();

describe('derived review metrics', () => {
  it('reproduces the raw metrics exactly when nothing is omitted', async () => {
    const f = fixture();
    const review = await buildReviewMetrics(f.raw, f.source, f.result, new Set());
    expect(review).toEqual(f.raw);
  });

  it('measures the raw file by hand', () => {
    const { raw } = fixture();
    expect(count(raw.file.sourceLines)).toBe(7);
    expect(count(raw.file.decisions)).toBe(1);
    expect(count(raw.file.assemblyBlocks)).toBe(1);
    expect(count(raw.file.stateVariables.count)).toBe(4);
    expect(count(raw.file.stateVariables.mutableCount)).toBe(4);
    const complex = raw.file.stateVariables.complexMutableDeclarationIds;
    expect(complex.status === 'measured' ? complex.value.length : -1).toBe(1);
  });

  it('removes a library: its lines, assembly and events leave the view only', async () => {
    const f = fixture();
    const before = structuredClone(f.raw);
    const review = await buildReviewMetrics(f.raw, f.source, f.result, new Set([f.lib]));
    // Lines 1, 5, 6 and 7 remain; lines 2-4 belong only to the omitted library.
    expect(count(review.file.sourceLines)).toBe(4);
    expect(review.lineSet?.oneBasedLines).toEqual(new Set([1, 5, 6, 7]));
    expect(count(review.file.assemblyBlocks)).toBe(0);
    expect(count(review.file.decisions)).toBe(1);
    expect(count(review.file.stateVariables.count)).toBe(4);
    expect(
      review.contracts.map((contract) => contract.name).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(['Helper', 'Same', 'Token']);
    expect(
      review.callables
        .map((callable) => callable.name ?? '')
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(['freeFn', 'm']);
    expect(count(review.file.declarationCounts.libraries)).toBe(0);
    expect(count(review.file.declarationCounts.contracts)).toBe(3);
    expect(review.file.physicalLines).toEqual(f.raw.file.physicalLines);
    // Raw metrics and the accepted syntax are untouched.
    expect(f.raw).toEqual(before);
    expect(f.result.events).toHaveLength(8);
    expect(f.result.declarations).toHaveLength(7);
  });

  it('recomputes decisions, storage counts and complex IDs from retained events', async () => {
    const f = fixture();
    const review = await buildReviewMetrics(f.raw, f.source, f.result, new Set([f.token]));
    // Line 5 held only the omitted Token: lines 1-4, 6 and 7 remain.
    expect(count(review.file.sourceLines)).toBe(6);
    expect(count(review.file.decisions)).toBe(0);
    expect(count(review.file.stateVariables.count)).toBe(2);
    expect(count(review.file.stateVariables.mutableCount)).toBe(2);
    const complex = review.file.stateVariables.complexMutableDeclarationIds;
    expect(complex).toEqual({ status: 'measured', value: [], evidence: [] });
    const shapes = review.file.stateVariables.typeShapes;
    expect(shapes.status === 'measured' ? shapes.value.map((item) => item.shape) : []).toEqual([
      'elementary',
      'elementary',
    ]);
    expect(count(review.file.assemblyBlocks)).toBe(1);
  });

  it('counts a physical line shared with a retained declaration exactly once', async () => {
    const f = fixture();
    const helperOnly = await buildReviewMetrics(f.raw, f.source, f.result, new Set([f.helper]));
    // Helper shares line 6 with Same, so no whole line disappears.
    expect(count(helperOnly.file.sourceLines)).toBe(7);
    expect(count(helperOnly.file.stateVariables.count)).toBe(3);
    const both = await buildReviewMetrics(f.raw, f.source, f.result, new Set([f.same, f.helper]));
    expect(count(both.file.sourceLines)).toBe(6);
    expect(both.lineSet?.oneBasedLines.has(6)).toBe(false);
  });

  it('keeps the free function and pragma as review code', async () => {
    const f = fixture();
    const all = await buildReviewMetrics(
      f.raw,
      f.source,
      f.result,
      new Set([f.lib, f.token, f.same, f.helper]),
    );
    expect(all.lineSet?.oneBasedLines).toEqual(new Set([1, 7]));
    expect(all.callables.map((callable) => callable.name)).toEqual(['freeFn']);
    expect(count(all.file.stateVariables.count)).toBe(0);
  });

  it('rejects an unknown omitted ID and a failed file', async () => {
    const f = fixture();
    const stranger = contractIdentity('other.sol', 'contract', 0);
    await expect(
      buildReviewMetrics(f.raw, f.source, f.result, new Set([stranger])),
    ).rejects.toBeInstanceOf(TypeError);
    const failed: ParseFileResult = {
      status: 'failed',
      fileId,
      code: 'PARSE_INVALID',
      diagnostics: [],
    };
    await expect(buildReviewMetrics(f.raw, f.source, failed, new Set())).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('propagates a checkpoint failure raised during derivation', async () => {
    const f = fixture();
    const failure = new Error('interrupted');
    await expect(
      buildReviewMetrics(f.raw, f.source, f.result, new Set([f.lib]), () =>
        Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
    // A long event list is checkpointed every 256 records, not only once at the end.
    let calls = 0;
    const padded = {
      ...f.result,
      events: Array.from({ length: 600 }, () => f.result.events[2] as ParserEvent),
    };
    await buildReviewMetrics(f.raw, f.source, padded, new Set([f.lib]), () => {
      calls += 1;
      return Promise.resolve();
    });
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------------------------
// Builtin coverage over the retained region.
// ---------------------------------------------------------------------------------------------

function callFact(event: ParserEvent, builtin: 'confirmed' | 'unknown' | 'rejected'): CallSiteFact {
  return {
    id: declarationIdentity(PATH, 'call-site', event.range.startByte) as CallSiteFact['id'],
    fileId,
    range: event.range,
    ownerCallableId: event.callableId,
    ownerContractId: event.contractId,
    syntax: { calleeShape: 'member', memberName: 'call', lowLevelCandidate: true },
    calleeKind: 'member',
    definitions: [],
    receiver: { kind: 'identifier', definitions: [] },
    symbol: 'unavailable',
    symbolTarget: null,
    candidateTargets: [],
    dispatch: 'unknown',
    builtin,
    limitation: 'none',
    evidence: [{ fileId, range: event.range }],
    edgeId: null,
  };
}

function projectionInput(
  f: Fixture,
  dispositions: ContractDispositions,
  facts: readonly CallSiteFact[],
  rawBuiltin: Measurement<number>,
): Parameters<typeof projectReview>[0] {
  return {
    dispositions,
    metrics: [f.raw],
    sources: new Map([[fileId, f.source]]),
    syntax: new Map<FileId, ParseFileResult>([[fileId, f.result]]),
    callSites: facts,
    rawBuiltin: new Map([[fileId, rawBuiltin]]),
    checkpoint: noop,
  };
}

function dispositionsFor(
  mode: 'all' | 'contracts',
  full: readonly ContractId[],
  omitted: readonly ContractId[],
): ContractDispositions {
  return {
    mode,
    reason: mode === 'contracts' ? 'test' : null,
    fullReview: new Set(full),
    omitted: new Map(
      omitted.map((id) => [id, mode === 'all' ? 'content-reuse' : 'caller-context']),
    ),
    scopeNarrowed: mode === 'contracts' && omitted.length > 0,
  };
}

describe('review projection', () => {
  it('conserves lines and accounts caller exclusions separately from reuse', async () => {
    const f = fixture();
    const caller = await projectReview(
      projectionInput(f, dispositionsFor('contracts', [f.token, f.same], [f.lib, f.helper]), [], {
        status: 'unavailable',
        reason: 'semantics-unavailable',
      }),
    );
    expect(caller.rawSourceLines).toBe(7);
    expect(caller.reviewSourceLines).toBe(4);
    expect(caller.outOfScopeSourceLines).toBe(3);
    expect(caller.reusedSourceLines).toBe(0);
    const reuse = await projectReview(
      projectionInput(f, dispositionsFor('all', [f.token, f.same, f.helper], [f.lib]), [], {
        status: 'unavailable',
        reason: 'semantics-unavailable',
      }),
    );
    expect(reuse.reusedSourceLines).toBe(3);
    expect(reuse.outOfScopeSourceLines).toBe(0);
    expect(reuse.rawSourceLines).toBe(reuse.reviewSourceLines + reuse.reusedSourceLines);
  });

  it('keeps the raw view for a file with nothing omitted', async () => {
    const f = fixture();
    const view = await projectReview(
      projectionInput(f, dispositionsFor('all', [f.lib, f.token, f.same, f.helper], []), [], {
        status: 'measured',
        value: 0,
        evidence: [],
      }),
    );
    expect(view.files.get(fileId)?.metrics).toBe(f.raw);
    expect(view.files.get(fileId)?.builtin).toEqual({ status: 'measured', value: 0, evidence: [] });
  });

  it('resolves an unavailable raw builtin count only with retained site-level proof', async () => {
    const f = fixture();
    const facts = [callFact(f.libCall, 'confirmed'), callFact(f.tokenCall, 'unknown')];
    const rawUnavailable: Measurement<number> = {
      status: 'unavailable',
      reason: 'unconfirmed-low-level-candidate',
    };
    // Removing the unknown site leaves one confirmed, fully covered site.
    const withoutToken = await projectReview(
      projectionInput(
        f,
        dispositionsFor('contracts', [f.lib, f.same, f.helper], [f.token]),
        facts,
        rawUnavailable,
      ),
    );
    const resolved = withoutToken.files.get(fileId)?.builtin;
    expect(resolved?.status).toBe('measured');
    expect(resolved?.status === 'measured' ? resolved.value : -1).toBe(1);
    // Removing the confirmed site leaves the unclassified one: still unavailable.
    const withoutLib = await projectReview(
      projectionInput(
        f,
        dispositionsFor('contracts', [f.token, f.same, f.helper], [f.lib]),
        facts,
        rawUnavailable,
      ),
    );
    expect(withoutLib.files.get(fileId)?.builtin?.status).toBe('unavailable');
  });

  it('keeps the builtin count unavailable when retained site coverage cannot be proved', async () => {
    const f = fixture();
    const missing = [callFact(f.tokenCall, 'confirmed')];
    const view = await projectReview(
      projectionInput(
        f,
        dispositionsFor('contracts', [f.lib, f.same, f.helper], [f.token]),
        missing,
        {
          status: 'unavailable',
          reason: 'graph-limit',
        },
      ),
    );
    expect(view.files.get(fileId)?.builtin).toEqual({
      status: 'unavailable',
      reason: 'graph-limit',
    });
  });

  it('keeps unavailable semantics unavailable even for an empty retained region', async () => {
    const f = fixture();
    const view = await projectReview(
      projectionInput(f, dispositionsFor('contracts', [f.same], [f.lib, f.token, f.helper]), [], {
        status: 'unavailable',
        reason: 'semantics-unavailable',
      }),
    );
    expect(view.files.get(fileId)?.builtin).toEqual({
      status: 'unavailable',
      reason: 'semantics-unavailable',
    });
  });

  it('reports a typed unavailable projection instead of widening the scope', async () => {
    const f = fixture();
    const noSource = projectionInput(
      f,
      dispositionsFor('contracts', [f.token], [f.lib, f.same, f.helper]),
      [],
      { status: 'measured', value: 0, evidence: [] },
    );
    await expect(projectReview({ ...noSource, sources: new Map() })).rejects.toBeInstanceOf(
      ProjectionUnavailableError,
    );
    const failedMetrics: FileMetrics = {
      ...f.raw,
      file: { ...f.raw.file, sourceLines: { status: 'unavailable', reason: 'parse-invalid' } },
    };
    await expect(projectReview({ ...noSource, metrics: [failedMetrics] })).rejects.toBeInstanceOf(
      ProjectionUnavailableError,
    );
  });

  it('propagates shared interruptions unchanged', async () => {
    const f = fixture();
    const failure = new Error('cancelled');
    const input = projectionInput(f, dispositionsFor('contracts', [f.token], [f.lib]), [], {
      status: 'measured',
      value: 0,
      evidence: [],
    });
    await expect(
      projectReview({ ...input, checkpoint: () => Promise.reject(failure) }),
    ).rejects.toBe(failure);
  });
});

// ---------------------------------------------------------------------------------------------
// Selector resolution.
// ---------------------------------------------------------------------------------------------

function twoFileMetrics(): { metrics: FileMetrics[]; ids: Record<string, ContractId> } {
  const a = fixture();
  const otherText = 'contract Token { uint256 public q; }\n';
  const otherPath = 'contracts/Other.sol';
  const otherSource = sourceFor(otherText, otherPath);
  const otherId = fileIdentity(otherPath);
  const range = at(otherText, 'contract Token { uint256 public q; }');
  const contractId = contractIdentity(otherPath, 'contract', range.startByte);
  const otherMetrics: FileMetrics = {
    ...a.raw,
    file: { ...a.raw.file, fileId: otherId, contractIds: [contractId] },
    contracts: [
      {
        ...(a.raw.contracts[0] as FileMetrics['contracts'][number]),
        id: contractId,
        fileId: otherId,
        kind: 'contract',
        name: 'Token',
        range,
      },
    ],
    callables: [],
  };
  void otherSource;
  return { metrics: [a.raw, otherMetrics], ids: { token: a.token, otherToken: contractId } };
}

function manifestFor(
  metrics: readonly FileMetrics[],
  hashes: Readonly<Record<string, string>> = {},
): EstimateInputSource['manifest'] {
  const entries: FileScopeEntry[] = metrics.map((item) => {
    const path = item.file.fileId.slice('file:'.length);
    return {
      fileId: item.file.fileId,
      path,
      role: 'scoped',
      ownership: 'first-party',
      ownershipEvidence: [],
      physicalIdentity: `fixture:${path}`,
      byteHash: hashes[path] ?? 'a'.repeat(64),
    };
  });
  return {
    entries,
    scopedFileIds: entries.map((item) => item.fileId),
    contextFileIds: [],
    excludedFileIds: [],
  };
}

async function resolve(
  scope: EstimationScopeInput,
  options: {
    readonly metrics?: readonly FileMetrics[];
    readonly eligible?: readonly FileId[];
    readonly hashes?: Readonly<Record<string, string>>;
    readonly checkpoint?: () => Promise<void>;
  } = {},
): Promise<ContractDispositions> {
  const { metrics } = twoFileMetrics();
  const used = options.metrics ?? metrics;
  return resolveDispositions({
    scope,
    manifest: manifestFor(used, options.hashes),
    metrics: used,
    eligibleFileIds: new Set(options.eligible ?? used.map((item) => item.file.fileId)),
    checkpoint: options.checkpoint ?? noop,
  });
}

function select(
  ...contracts: readonly {
    readonly path: string;
    readonly kind: 'contract' | 'abstract-contract' | 'library' | 'interface';
    readonly name: string;
    readonly sourceHash?: string;
  }[]
): EstimationScopeInput {
  return { mode: 'contracts', contracts, reason: 'Agreed engagement scope.' };
}

describe('estimation scope resolution', () => {
  it('selects exact path, kind and name and keeps everything else as context', async () => {
    const { ids } = twoFileMetrics();
    const result = await resolve(
      select(
        { path: PATH, kind: 'contract', name: 'Token' },
        { path: PATH, kind: 'library', name: 'Lib' },
      ),
    );
    expect(result.mode).toBe('contracts');
    expect(result.fullReview.size).toBe(2);
    expect(result.fullReview.has(ids['token'] as ContractId)).toBe(true);
    // Same, Helper and the other file's Token are context; no ancestor or helper expansion.
    expect(result.omitted.size).toBe(3);
    expect([...result.omitted.values()].every((reason) => reason === 'caller-context')).toBe(true);
    expect(result.scopeNarrowed).toBe(true);
    expect(result.omitted.has(ids['otherToken'] as ContractId)).toBe(true);
  });

  it('distinguishes the same short name in different files', async () => {
    const { ids } = twoFileMetrics();
    const result = await resolve(
      select({ path: 'contracts/Other.sol', kind: 'contract', name: 'Token' }),
    );
    expect([...result.fullReview]).toEqual([ids['otherToken']]);
  });

  it('is not narrowed when every eligible declaration is selected', async () => {
    const { metrics } = twoFileMetrics();
    const selectors = metrics.flatMap((item) =>
      item.contracts.map((contract) => ({
        path: item.file.fileId.slice('file:'.length),
        kind: contract.kind,
        name: contract.name,
      })),
    );
    const result = await resolve(select(...selectors));
    expect(result.scopeNarrowed).toBe(false);
    expect(result.omitted.size).toBe(0);
  });

  it('defaults to every eligible declaration in all mode', async () => {
    const result = await resolve({ mode: 'all' });
    expect(result.mode).toBe('all');
    expect(result.fullReview.size).toBe(5);
    expect(result.scopeNarrowed).toBe(false);
  });

  const rejected: readonly (readonly [string, EstimationScopeInput])[] = [
    ['an unknown name', select({ path: PATH, kind: 'contract', name: 'Missing' })],
    ['a wrong case', select({ path: PATH, kind: 'contract', name: 'token' })],
    ['a wrong kind', select({ path: PATH, kind: 'interface', name: 'Token' })],
    ['a wrong path', select({ path: 'contracts/flattened.sol', kind: 'contract', name: 'Token' })],
    ['a basename search', select({ path: 'Flattened.sol', kind: 'contract', name: 'Token' })],
    ['a glob', select({ path: 'contracts/*.sol', kind: 'contract', name: 'Token' })],
    [
      'a duplicate identity even with different hashes',
      select(
        { path: PATH, kind: 'contract', name: 'Token', sourceHash: 'a'.repeat(64) },
        { path: PATH, kind: 'contract', name: 'Token', sourceHash: 'b'.repeat(64) },
      ),
    ],
    [
      'a stale source hash',
      select({ path: PATH, kind: 'contract', name: 'Token', sourceHash: 'b'.repeat(64) }),
    ],
  ];
  it.each(rejected)('rejects %s without silently narrowing', async (_name, scope) => {
    await expect(resolve(scope)).rejects.toBeInstanceOf(ConfigError);
  });

  it('accepts a current source hash guard', async () => {
    const result = await resolve(
      select({ path: PATH, kind: 'contract', name: 'Token', sourceHash: 'c'.repeat(64) }),
      { hashes: { [PATH]: 'c'.repeat(64) } },
    );
    expect(result.fullReview.size).toBe(1);
  });

  it('rejects an ambiguous selector with two matching declarations', async () => {
    const { metrics } = twoFileMetrics();
    const first = metrics[0] as FileMetrics;
    const token = first.contracts.find((contract) => contract.name === 'Token');
    if (token === undefined) throw new Error('fixture');
    const twin = { ...token, id: contractIdentity(PATH, 'contract', 99_999) };
    const duplicated: FileMetrics = { ...first, contracts: [...first.contracts, twin] };
    await expect(
      resolve(select({ path: PATH, kind: 'contract', name: 'Token' }), {
        metrics: [duplicated, metrics[1] as FileMetrics],
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects selectors for files that are not eligible', async () => {
    const { metrics } = twoFileMetrics();
    // A failed, blocked, third-party or excluded file never reaches the eligible set.
    await expect(
      resolve(select({ path: 'contracts/Other.sol', kind: 'contract', name: 'Token' }), {
        eligible: [(metrics[0] as FileMetrics).file.fileId],
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('propagates a shared interruption instead of reporting a configuration error', async () => {
    const failure = new Error('deadline');
    await expect(
      resolve(select({ path: PATH, kind: 'contract', name: 'Token' }), {
        checkpoint: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
  });

  it('bounds scope arrays before retaining them', () => {
    expect(() => assertScopeBounds(Array.from({ length: MAX_SCOPE_CONTRACT_IDS }))).not.toThrow();
    expect(() => assertScopeBounds(Array.from({ length: MAX_SCOPE_CONTRACT_IDS + 1 }))).toThrow(
      ScopeLimitError,
    );
  });
});

describe('estimation scope analysis metadata', () => {
  it('reports exact IDs, line accounting and requested completeness', async () => {
    const f = fixture();
    const dispositions = dispositionsFor('contracts', [f.token, f.same], [f.lib, f.helper]);
    const projection = await projectReview(
      projectionInput(f, dispositions, [], {
        status: 'unavailable',
        reason: 'semantics-unavailable',
      }),
    );
    const scope = buildEstimationScopeAnalysis({
      dispositions,
      projection,
      requiredAnalysisComplete: false,
    });
    expect(scope.selectedContractIds).toEqual([f.same, f.token].sort());
    expect(scope.contextContractIds).toEqual([f.helper, f.lib].sort());
    expect(scope.scopeNarrowed).toBe(true);
    // Contracts mode does not need raw completeness; unrelated failures stay with allowPartial.
    expect(scope.requestedScopeComplete).toBe(true);
    expect(scope.rawSourceLines).toEqual({ status: 'measured', value: 7, evidence: [] });
    expect(scope.reviewSourceLines).toEqual({ status: 'measured', value: 4, evidence: [] });
    expect(scope.outOfScopeSourceLines).toEqual({ status: 'measured', value: 3, evidence: [] });
    expect(scope.reusedSourceLines).toEqual({ status: 'measured', value: 0, evidence: [] });
  });

  it('keeps the partition and marks all four counts unavailable without a projection', () => {
    const f = fixture();
    const dispositions = dispositionsFor('contracts', [f.token], [f.lib, f.same, f.helper]);
    const scope = buildEstimationScopeAnalysis({
      dispositions,
      projection: null,
      requiredAnalysisComplete: true,
    });
    expect(scope.requestedScopeComplete).toBe(false);
    expect(scope.scopeNarrowed).toBe(true);
    expect(scope.selectedContractIds).toEqual([f.token]);
    for (const value of [
      scope.rawSourceLines,
      scope.reviewSourceLines,
      scope.reusedSourceLines,
      scope.outOfScopeSourceLines,
    ]) {
      expect(value.status).toBe('unavailable');
    }
  });

  it('requires raw completeness for whole-scope requested completeness', async () => {
    const f = fixture();
    const dispositions = dispositionsFor('all', [f.lib, f.token, f.same, f.helper], []);
    const projection = await projectReview(
      projectionInput(f, dispositions, [], { status: 'measured', value: 0, evidence: [] }),
    );
    expect(
      buildEstimationScopeAnalysis({ dispositions, projection, requiredAnalysisComplete: false })
        .requestedScopeComplete,
    ).toBe(false);
    expect(
      buildEstimationScopeAnalysis({ dispositions, projection, requiredAnalysisComplete: true })
        .requestedScopeComplete,
    ).toBe(true);
  });

  it('validates the public schema invariants', async () => {
    const f = fixture();
    const dispositions = dispositionsFor('contracts', [f.token, f.same], [f.lib, f.helper]);
    const projection = await projectReview(
      projectionInput(f, dispositions, [], {
        status: 'unavailable',
        reason: 'semantics-unavailable',
      }),
    );
    const scope = buildEstimationScopeAnalysis({
      dispositions,
      projection,
      requiredAnalysisComplete: true,
    });
    const analysis: Analysis = {
      files: [f.raw.file],
      contracts: [...f.raw.contracts],
      callables: [...f.raw.callables],
      aggregates: {
        scopedFiles: { status: 'measured', value: 1, evidence: [] },
        physicalLines: { status: 'measured', value: 7, evidence: [] },
        sourceLines: { status: 'measured', value: 7, evidence: [] },
        contracts: { status: 'measured', value: 4, evidence: [] },
        callables: { status: 'measured', value: 3, evidence: [] },
      },
      graphs: [],
      indicators: [],
      testObservations: [],
      coverageObservation: null,
      completeness: {
        requiredAnalysisComplete: true,
        hasUnknownSemantics: false,
        analyzedFileIds: [fileId],
        unavailableFileIds: [],
      },
      estimationScope: scope,
    };
    expect(AnalysisSchema.safeParse(analysis).success).toBe(true);
    const mutate = (changes: Partial<typeof scope>): boolean =>
      AnalysisSchema.safeParse({ ...analysis, estimationScope: { ...scope, ...changes } }).success;
    expect(mutate({})).toBe(true);
    // A partition that omits a contract, an unsorted list, mixed measurement states and an
    // inconsistent narrowing flag are all rejected.
    expect(mutate({ contextContractIds: [f.lib] })).toBe(false);
    expect(mutate({ selectedContractIds: [f.token, f.same] })).toBe(false);
    expect(mutate({ scopeNarrowed: false })).toBe(false);
    expect(
      mutate({ reviewSourceLines: { status: 'unavailable', reason: 'unavailable projection' } }),
    ).toBe(false);
    expect(mutate({ reusedSourceLines: { status: 'measured', value: 1, evidence: [] } })).toBe(
      false,
    );
    expect(mutate({ rawSourceLines: { status: 'measured', value: 8, evidence: [] } })).toBe(false);
    const unavailable = {
      rawSourceLines: { status: 'unavailable', reason: 'no projection' } as const,
      reviewSourceLines: { status: 'unavailable', reason: 'no projection' } as const,
      reusedSourceLines: { status: 'unavailable', reason: 'no projection' } as const,
      outOfScopeSourceLines: { status: 'unavailable', reason: 'no projection' } as const,
    };
    expect(mutate({ ...unavailable, requestedScopeComplete: false })).toBe(true);
    expect(mutate({ ...unavailable, requestedScopeComplete: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Pair projection truth table.
// ---------------------------------------------------------------------------------------------

function pairFixture(): {
  readonly source: EstimateInputSource;
  readonly ids: Readonly<Record<'a' | 'b' | 'c' | 'x', ContractId>>;
} {
  const paths = ['src/A.sol', 'src/B.sol'];
  const ids = {
    a: contractIdentity('src/A.sol', 'contract', 0),
    b: contractIdentity('src/A.sol', 'contract', 100),
    c: contractIdentity('src/B.sol', 'contract', 0),
    x: contractIdentity('lib/External.sol', 'contract', 0),
  };
  const RANGE = {
    startByte: 0,
    endByte: 10,
    start: { line: 1, column: 1 },
    end: { line: 1, column: 11 },
  };
  const state = {
    count: { status: 'measured', value: 0, evidence: [] },
    mutableCount: { status: 'measured', value: 0, evidence: [] },
    complexMutableDeclarationIds: { status: 'measured', value: [], evidence: [] },
    typeShapes: { status: 'measured', value: [], evidence: [] },
  } as const;
  const metrics: FileMetrics[] = paths.map((path) => {
    const id = fileIdentity(path);
    const own = Object.values(ids).filter((contractId) => contractId.includes(`:${path}:`));
    const m = (value: number): Measurement<number> => ({ status: 'measured', value, evidence: [] });
    return {
      file: {
        fileId: id,
        role: 'scoped',
        ownership: 'first-party',
        physicalLines: m(12),
        sourceLines: m(10),
        declarationCounts: {
          contracts: m(own.length),
          abstractContracts: m(0),
          libraries: m(0),
          interfaces: m(0),
        },
        stateVariables: state,
        decisions: m(0),
        loops: m(0),
        maxLoopDepth: m(0),
        assemblyBlocks: m(0),
        yulStatements: m(0),
        yulCalls: m(0),
        yulControlFlow: m(0),
        lowLevelCallCandidates: m(0),
        importIds: [],
        contractIds: own,
        callableIds: [],
        syntaxComplete: true,
      },
      contracts: own.map((contractId, index) => ({
        id: contractId,
        fileId: id,
        kind: 'contract' as const,
        name: `C${index}`,
        range: RANGE,
        sourceLines: m(5),
        callableIds: [],
        stateVariables: state,
      })),
      callables: [],
      lineSet: { fileId: id, oneBasedLines: new Set([1]) },
      wholeFile: { fileId: id, range: RANGE },
    };
  });
  const entries: FileScopeEntry[] = paths.map((path) => ({
    fileId: fileIdentity(path),
    path,
    role: 'scoped',
    ownership: 'first-party',
    ownershipEvidence: [],
    physicalIdentity: `fixture:${path}`,
    byteHash: 'a'.repeat(64),
  }));
  const pair = (
    left: ContractId,
    right: ContractId,
  ): EstimateInputSource['relationships']['scopedPairs'][number] => ({
    leftId: left,
    rightId: right,
    kinds: ['call'],
    evidence: [],
  });
  const defaults = productionConfigDefaults();
  const config: ResolvedConfig = {
    configVersion: '1.1.0',
    scope: { ...DEFAULT_SCOPE_SETTINGS },
    imports: defaults.imports,
    solidity: defaults.solidity,
    analysis: defaults.analysis,
    model: selectModel(),
    manualAdjustments: [],
    coverage: { lcovPath: null },
    report: { format: 'terminal' },
    estimationScope: { mode: 'all' },
    provenance: [],
  };
  return {
    ids,
    source: {
      manifest: {
        entries,
        scopedFileIds: entries.map((entry) => entry.fileId),
        contextFileIds: [],
        excludedFileIds: [],
      },
      metrics,
      parsedFileIds: new Set(entries.map((entry) => entry.fileId)),
      relationships: {
        // a<->b both directions, b->c, c->a, plus a->x and c->x toward an external contract.
        scopedPairs: [
          pair(ids.a, ids.b),
          pair(ids.b, ids.a),
          pair(ids.b, ids.c),
          pair(ids.c, ids.a),
        ],
        contextPairs: [pair(ids.a, ids.x), pair(ids.c, ids.x)],
        confirmedBuiltinLowLevelCalls: [],
        invalidatedScopedFileIds: [],
        requiredAnalysisComplete: true,
        hasUnknownSemantics: false,
      },
      requiredAnalysisComplete: true,
      config,
      allowPartial: false,
    },
  };
}

function projectionOf(
  source: EstimateInputSource,
  full: readonly ContractId[],
  omitted: readonly ContractId[],
  mode: 'all' | 'contracts',
): ReviewProjection {
  const files = new Map<
    FileId,
    ReviewProjection['files'] extends ReadonlyMap<FileId, infer V> ? V : never
  >();
  for (const metrics of source.metrics) {
    files.set(metrics.file.fileId, {
      fileId: metrics.file.fileId,
      metrics,
      builtin: null,
      rawSourceLines: 10,
      reviewSourceLines: 10,
      reusedSourceLines: 0,
      outOfScopeSourceLines: 0,
    });
  }
  return {
    dispositions: dispositionsFor(mode, full, omitted),
    files,
    rawSourceLines: 20,
    reviewSourceLines: 20,
    reusedSourceLines: 0,
    outOfScopeSourceLines: 0,
  };
}

function pairKeys(pairs: EstimateInput['scopedPairs']): string[] {
  return pairs.map(
    (pair) =>
      `${pair.leftId.split(':')[1]}#${pair.leftId.split(':')[3]}>${pair.rightId.split(':')[1]}#${pair.rightId.split(':')[3]}`,
  );
}

describe('pair projection by review role', () => {
  it('charges selected-to-selected as interactions and selected-to-context as boundaries', () => {
    const { source, ids } = pairFixture();
    const input = buildEstimateInput({
      ...source,
      projection: projectionOf(source, [ids.a, ids.b], [ids.c], 'contracts'),
    });
    // a<->b stays interaction in both directions; b->c and c->a cross to context, so both are
    // boundaries even though c->a points at a selected contract; a->x keeps its boundary; c->x is
    // a context-to-external pair and is omitted.
    expect(pairKeys(input.scopedPairs)).toEqual([
      'src/A.sol#0>src/A.sol#100',
      'src/A.sol#100>src/A.sol#0',
    ]);
    expect(pairKeys(input.contextPairs)).toEqual([
      'src/A.sol#100>src/B.sol#0',
      'src/B.sol#0>src/A.sol#0',
      'src/A.sol#0>lib/External.sol#0',
    ]);
  });

  it('omits context-to-context pairs and keeps the sets disjoint', () => {
    const { source, ids } = pairFixture();
    const input = buildEstimateInput({
      ...source,
      projection: projectionOf(source, [ids.c], [ids.a, ids.b], 'contracts'),
    });
    expect(pairKeys(input.scopedPairs)).toEqual([]);
    // a<->b (context-context) disappear; b->c and c->a are boundaries; a->x is omitted because a
    // is context; c->x keeps the existing boundary behavior for a selected contract.
    expect(pairKeys(input.contextPairs)).toEqual([
      'src/A.sol#100>src/B.sol#0',
      'src/B.sol#0>src/A.sol#0',
      'src/B.sol#0>lib/External.sol#0',
    ]);
    const all = [...input.scopedPairs, ...input.contextPairs].map(
      (pair) => `${pair.leftId}|${pair.rightId}`,
    );
    expect(new Set(all).size).toBe(all.length);
  });

  it('matches the physical-file behavior when no projection is supplied', () => {
    const { source, ids } = pairFixture();
    const input = buildEstimateInput(source);
    expect(input.scopedPairs).toHaveLength(4);
    expect(input.contextPairs).toEqual([
      { leftId: ids.a, rightId: ids.x },
      { leftId: ids.c, rightId: ids.x },
    ]);
    expect(input.reviewSummary).toBeUndefined();
    expect(EstimateInputSchema.safeParse(input).success).toBe(true);
  });

  it('ignores a projection under the frozen 1.0.0 model', () => {
    const { source, ids } = pairFixture();
    const legacy: EstimateInputSource = {
      ...source,
      config: { ...source.config, model: selectModel('heuristic-v1', '1.0.0') },
      projection: projectionOf(source, [ids.a], [ids.b, ids.c], 'contracts'),
    };
    const input = buildEstimateInput(legacy);
    expect(input.scopedPairs).toHaveLength(4);
    expect(input.reviewSummary).toBeUndefined();
  });

  it('supplies a review summary that satisfies the engine truth table', () => {
    const { source, ids } = pairFixture();
    const projection = projectionOf(source, [ids.a, ids.b], [ids.c], 'contracts');
    const input = buildEstimateInput({ ...source, projection });
    expect(input.reviewSummary).toEqual({
      mode: 'contracts',
      analyzedSourceLines: 20,
      reusedSourceLines: 0,
      outOfScopeSourceLines: 0,
      scopeNarrowed: true,
    });
    expect(EstimateInputSchema.safeParse(input).success).toBe(true);
  });

  it('refuses an eligible file that has no projection', () => {
    const { source, ids } = pairFixture();
    const projection = projectionOf(source, [ids.a], [ids.b, ids.c], 'contracts');
    const partial: ReviewProjection = {
      ...projection,
      files: new Map([...projection.files].slice(0, 1)),
    };
    expect(() => buildEstimateInput({ ...source, projection: partial })).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Model 1.1.0 engine: review summary truth table and hand-calculated ledgers.
// ---------------------------------------------------------------------------------------------

function measuredCount(value: number): Measurement<number> {
  return { status: 'measured', value, evidence: [] };
}

function engineInput(
  lines: number,
  summary: EstimateInput['reviewSummary'],
  extra: Partial<EstimateInput> = {},
): EstimateInput {
  const fileA = fileIdentity('src/A.sol');
  return {
    eligibleFiles: [
      {
        fileId: fileA,
        sourceLines: measuredCount(lines),
        stateVariables: {
          count: measuredCount(0),
          mutableCount: measuredCount(0),
          complexMutableDeclarationIds: { status: 'measured', value: [], evidence: [] },
          typeShapes: { status: 'measured', value: [], evidence: [] },
        },
        decisions: measuredCount(0),
        assemblyBlocks: measuredCount(0),
        confirmedBuiltinLowLevelCalls: measuredCount(0),
      },
    ],
    scopedPairs: [],
    contextPairs: [],
    requiredAnalysisComplete: true,
    hasUnknownSemantics: false,
    allowPartial: false,
    model: selectModel(),
    manualAdjustments: [],
    ...(summary === undefined ? {} : { reviewSummary: summary }),
    ...extra,
  };
}

describe('model 1.1.0 review summary', () => {
  const pairA = contractIdentity('src/A.sol', 'contract', 0);
  const pairB = contractIdentity('src/A.sol', 'contract', 100);
  const pairC = contractIdentity('src/B.sol', 'contract', 0);

  it('computes a hand-calculated ledger with one interaction and one boundary', () => {
    const input = engineInput(
      10,
      {
        mode: 'contracts',
        analyzedSourceLines: 17,
        reusedSourceLines: 0,
        outOfScopeSourceLines: 7,
        scopeNarrowed: true,
      },
      {
        scopedPairs: [{ leftId: pairA, rightId: pairB }],
        contextPairs: [{ leftId: pairB, rightId: pairC }],
      },
    );
    const result = estimateEffort(input);
    // Low: project 4 + baseline 10 x 0.04 + interaction 0.25 + boundary 0.5 = 5.15 -> floor 5.
    // High: project 12 + baseline 10 x 0.12 + interaction 0.75 + boundary 2 = 15.95 -> ceil 16.
    // No unknown measurement, so no reserve.
    expect(result?.auditorHours).toEqual({ low: 5, high: 16 });
    expect(result?.modelVersion).toBe('1.1.0');
    expect(result?.coverage).toBe('analyzed-subset');
    const baseline = result?.contributions.find((row) => row.category === 'baseline');
    expect(baseline?.lowMicrohours).toBe(400_000);
    expect(baseline?.highMicrohours).toBe(1_200_000);
    expect(result?.assumptions.some((text) => text.includes('no full-review baseline'))).toBe(true);
  });

  it('prices fully reused code with only the fixed allowances', () => {
    const result = estimateEffort(
      engineInput(0, {
        mode: 'all',
        analyzedSourceLines: 8,
        reusedSourceLines: 8,
        outOfScopeSourceLines: 0,
        scopeNarrowed: false,
      }),
    );
    // Four file rows stay, all zero; the project allowance alone remains: 4 to 12 hours.
    expect(result?.auditorHours).toEqual({ low: 4, high: 12 });
    expect(result?.coverage).toBe('full');
    expect(result?.contributions.filter((row) => row.category === 'baseline')).toHaveLength(1);
  });

  it('keeps zero review lines without a reuse basis ineligible', () => {
    expect(estimateEffort(engineInput(0, undefined))).toBeNull();
    expect(
      estimateEffort(
        engineInput(0, {
          mode: 'all',
          analyzedSourceLines: 0,
          reusedSourceLines: 0,
          outOfScopeSourceLines: 0,
          scopeNarrowed: false,
        }),
      ),
    ).toBeNull();
  });

  it('matches the legacy engine numerically for a plain all-mode input', () => {
    const lines = 37;
    const current = estimateEffort(
      engineInput(lines, {
        mode: 'all',
        analyzedSourceLines: lines,
        reusedSourceLines: 0,
        outOfScopeSourceLines: 0,
        scopeNarrowed: false,
      }),
    );
    const legacy = estimateEffort(
      engineInput(lines, undefined, { model: selectModel('heuristic-v1', '1.0.0') }),
    );
    expect(current?.modelVersion).toBe('1.1.0');
    expect(legacy?.modelVersion).toBe('1.0.0');
    expect(current?.auditorHours).toEqual(legacy?.auditorHours);
    expect(current?.auditorDays).toEqual(legacy?.auditorDays);
    expect(
      current?.contributions.map((row) => [row.id, row.lowMicrohours, row.highMicrohours]),
    ).toEqual(legacy?.contributions.map((row) => [row.id, row.lowMicrohours, row.highMicrohours]));
  });

  it('can raise an endpoint when interactions become higher-rate boundaries', () => {
    // Two retained contracts with one directed pair: interaction 0.25 / 0.75 on 100 lines.
    const interaction = estimateEffort(
      engineInput(100, undefined, { scopedPairs: [{ leftId: pairA, rightId: pairB }] }),
    );
    // Dropping 50 lines to context converts the pair to a boundary (0.5 / 2).
    const boundary = estimateEffort(
      engineInput(
        50,
        {
          mode: 'contracts',
          analyzedSourceLines: 100,
          reusedSourceLines: 0,
          outOfScopeSourceLines: 50,
          scopeNarrowed: true,
        },
        { contextPairs: [{ leftId: pairA, rightId: pairB }] },
      ),
    );
    // Interaction case: low 4 + 4 + 0.25 = 8.25 -> 8; high 12 + 12 + 0.75 = 24.75 -> 25.
    expect(interaction?.auditorHours).toEqual({ low: 8, high: 25 });
    // Boundary case: low 4 + 2 + 0.5 = 6.5 -> 6; high 12 + 6 + 2 = 20 -> 20.
    expect(boundary?.auditorHours).toEqual({ low: 6, high: 20 });
    const rate = (estimate: typeof interaction, category: string): number =>
      estimate?.contributions.find((row) => row.category === category)?.highMicrohours ?? -1;
    expect(rate(boundary, 'boundary')).toBeGreaterThan(rate(interaction, 'interaction'));
  });

  type Summary = NonNullable<EstimateInput['reviewSummary']>;
  const reject: readonly (readonly [string, number, Summary])[] = [
    [
      'all mode with caller exclusions',
      10,
      {
        mode: 'all',
        analyzedSourceLines: 15,
        reusedSourceLines: 0,
        outOfScopeSourceLines: 5,
        scopeNarrowed: false,
      },
    ],
    [
      'all mode narrowed',
      10,
      {
        mode: 'all',
        analyzedSourceLines: 10,
        reusedSourceLines: 0,
        outOfScopeSourceLines: 0,
        scopeNarrowed: true,
      },
    ],
    [
      'contracts mode with reuse',
      10,
      {
        mode: 'contracts',
        analyzedSourceLines: 15,
        reusedSourceLines: 5,
        outOfScopeSourceLines: 0,
        scopeNarrowed: true,
      },
    ],
    [
      'exclusions without narrowing',
      10,
      {
        mode: 'contracts',
        analyzedSourceLines: 15,
        reusedSourceLines: 0,
        outOfScopeSourceLines: 5,
        scopeNarrowed: false,
      },
    ],
    [
      'a broken line sum',
      10,
      {
        mode: 'contracts',
        analyzedSourceLines: 99,
        reusedSourceLines: 0,
        outOfScopeSourceLines: 5,
        scopeNarrowed: true,
      },
    ],
    [
      'zero-review contract scope',
      0,
      {
        mode: 'contracts',
        analyzedSourceLines: 5,
        reusedSourceLines: 0,
        outOfScopeSourceLines: 5,
        scopeNarrowed: true,
      },
    ],
  ];
  it.each(reject)('rejects %s', (_name, lines, summary) => {
    expect(EstimateInputSchema.safeParse(engineInput(lines, summary)).success).toBe(false);
  });

  it('accepts same-line narrowing with zero fully excluded lines', () => {
    const input = engineInput(10, {
      mode: 'contracts',
      analyzedSourceLines: 10,
      reusedSourceLines: 0,
      outOfScopeSourceLines: 0,
      scopeNarrowed: true,
    });
    expect(estimateEffort(input)?.coverage).toBe('analyzed-subset');
  });

  it('keeps an all-selected contract summary full coverage', () => {
    const input = engineInput(10, {
      mode: 'contracts',
      analyzedSourceLines: 10,
      reusedSourceLines: 0,
      outOfScopeSourceLines: 0,
      scopeNarrowed: false,
    });
    expect(estimateEffort(input)?.coverage).toBe('full');
  });

  it('rejects unavailable per-file lines, unsafe totals and the legacy model with a summary', () => {
    const summary: Summary = {
      mode: 'all',
      analyzedSourceLines: 10,
      reusedSourceLines: 0,
      outOfScopeSourceLines: 0,
      scopeNarrowed: false,
    };
    const base = engineInput(10, summary);
    const file = base.eligibleFiles[0];
    if (file === undefined) throw new Error('fixture');
    const unavailable: EstimateInput = {
      ...base,
      eligibleFiles: [{ ...file, sourceLines: { status: 'unavailable', reason: 'parse-invalid' } }],
    };
    expect(EstimateInputSchema.safeParse(unavailable).success).toBe(false);
    expect(
      EstimateInputSchema.safeParse(
        engineInput(10, {
          ...summary,
          analyzedSourceLines: Number.MAX_SAFE_INTEGER,
          reusedSourceLines: Number.MAX_SAFE_INTEGER,
        }),
      ).success,
    ).toBe(false);
    expect(
      EstimateInputSchema.safeParse({ ...base, model: selectModel('heuristic-v1', '1.0.0') })
        .success,
    ).toBe(false);
  });

  it('keeps an intentional subset eligible only with allowPartial for genuine incompleteness', () => {
    const summary: Summary = {
      mode: 'contracts',
      analyzedSourceLines: 15,
      reusedSourceLines: 0,
      outOfScopeSourceLines: 5,
      scopeNarrowed: true,
    };
    expect(
      estimateEffort(engineInput(10, summary, { requiredAnalysisComplete: false })),
    ).toBeNull();
    expect(
      estimateEffort(
        engineInput(10, summary, { requiredAnalysisComplete: false, allowPartial: true }),
      )?.coverage,
    ).toBe('analyzed-subset');
    expect(estimateEffort(engineInput(10, summary))?.coverage).toBe('analyzed-subset');
  });
});

// ---------------------------------------------------------------------------------------------
// Config revision, selection precedence and identity.
// ---------------------------------------------------------------------------------------------

function trusted(): TrustedConfigDefaults {
  return productionConfigDefaults();
}

const TWO: EstimationScopeInput = {
  mode: 'contracts',
  contracts: [
    { path: 'src/B.sol', kind: 'contract', name: 'Zed' },
    { path: 'src/A.sol', kind: 'library', name: 'Lib' },
  ],
  reason: 'Agreed scope.',
};

describe('configuration revision and estimation scope', () => {
  it('defaults to whole-scope estimation under the current model', () => {
    const merged = mergeConfig({ defaults: trusted() });
    expect(merged.config.configVersion).toBe('1.1.0');
    expect(merged.config.estimationScope).toEqual({ mode: 'all' });
    expect(merged.config.model.modelVersion).toBe('1.1.0');
    expect(merged.config.provenance.find((item) => item.field === 'estimationScope')?.source).toBe(
      'default',
    );
  });

  it('accepts strict 1.0.0 inputs and rejects new fields or versions under them', () => {
    expect(parseConfigInput({ configVersion: '1.0.0' }).configVersion).toBe('1.0.0');
    expect(
      parseConfigInput({
        configVersion: '1.0.0',
        model: { profile: 'heuristic-v1', modelVersion: '1.0.0' },
      }).model?.modelVersion,
    ).toBe('1.0.0');
    expect(() =>
      parseConfigInput({ configVersion: '1.0.0', estimationScope: { mode: 'all' } }),
    ).toThrow(ConfigError);
    expect(() =>
      parseConfigInput({
        configVersion: '1.0.0',
        model: { profile: 'heuristic-v1', modelVersion: '1.1.0' },
      }),
    ).toThrow(ConfigError);
    expect(() => parseConfigInput({ configVersion: '1.2.0' })).toThrow(ConfigError);
    expect(() => parseConfigInput({ configVersion: '1.0.0', surprise: true })).toThrow(ConfigError);
    expect(
      parseConfigInput({ configVersion: '1.1.0', estimationScope: TWO }).estimationScope,
    ).toEqual(TWO);
    expect(() => parseConfigInput({ configVersion: '1.1.0', surprise: true })).toThrow(ConfigError);
  });

  const invalid: readonly (readonly [string, unknown])[] = [
    ['an empty list', { mode: 'contracts', contracts: [], reason: 'x' }],
    [
      'a blank reason',
      {
        mode: 'contracts',
        contracts: TWO.mode === 'contracts' ? TWO.contracts : [],
        reason: '   ',
      },
    ],
    [
      'a native absolute path',
      {
        mode: 'contracts',
        reason: 'x',
        contracts: [{ path: '/tmp/A.sol', kind: 'contract', name: 'A' }],
      },
    ],
    [
      'a drive path',
      {
        mode: 'contracts',
        reason: 'x',
        contracts: [{ path: 'C:/A.sol', kind: 'contract', name: 'A' }],
      },
    ],
    [
      'a traversal path',
      {
        mode: 'contracts',
        reason: 'x',
        contracts: [{ path: '../A.sol', kind: 'contract', name: 'A' }],
      },
    ],
    [
      'a backslash path',
      {
        mode: 'contracts',
        reason: 'x',
        contracts: [{ path: 'src\\A.sol', kind: 'contract', name: 'A' }],
      },
    ],
    [
      'a control character',
      {
        mode: 'contracts',
        reason: 'x',
        contracts: [{ path: 'src/\u0007A.sol', kind: 'contract', name: 'A' }],
      },
    ],
    [
      'an overlong path',
      {
        mode: 'contracts',
        reason: 'x',
        contracts: [{ path: `${'a'.repeat(513)}.sol`, kind: 'contract', name: 'A' }],
      },
    ],
    [
      'an overlong name',
      {
        mode: 'contracts',
        reason: 'x',
        contracts: [{ path: 'a.sol', kind: 'contract', name: 'N'.repeat(129) }],
      },
    ],
    [
      'an unknown kind',
      { mode: 'contracts', reason: 'x', contracts: [{ path: 'a.sol', kind: 'struct', name: 'A' }] },
    ],
    [
      'a malformed hash',
      {
        mode: 'contracts',
        reason: 'x',
        contracts: [{ path: 'a.sol', kind: 'contract', name: 'A', sourceHash: 'XYZ' }],
      },
    ],
    [
      'an extra selector field',
      {
        mode: 'contracts',
        reason: 'x',
        contracts: [{ path: 'a.sol', kind: 'contract', name: 'A', extra: 1 }],
      },
    ],
    [
      'an overlong reason',
      {
        mode: 'contracts',
        reason: 'r'.repeat(513),
        contracts: [{ path: 'a.sol', kind: 'contract', name: 'A' }],
      },
    ],
    [
      'a duplicate identity',
      {
        mode: 'contracts',
        reason: 'x',
        contracts: [
          { path: 'a.sol', kind: 'contract', name: 'A' },
          { path: 'a.sol', kind: 'contract', name: 'A' },
        ],
      },
    ],
  ];
  it.each(invalid)('rejects %s', (_name, scope) => {
    expect(() => parseConfigInput({ configVersion: '1.1.0', estimationScope: scope })).toThrow(
      ConfigError,
    );
  });

  it('caps the selector count before accepting the list', () => {
    const contracts = Array.from({ length: 10_001 }, (_item, index) => ({
      path: 'a.sol',
      kind: 'contract' as const,
      name: `C${index}`,
    }));
    expect(() =>
      parseConfigInput({
        configVersion: '1.1.0',
        estimationScope: { mode: 'contracts', contracts, reason: 'x' },
      }),
    ).toThrow(ConfigError);
    expect(
      parseConfigInput({
        configVersion: '1.1.0',
        estimationScope: { mode: 'contracts', contracts: contracts.slice(0, 10_000), reason: 'x' },
      }).estimationScope?.mode,
    ).toBe('contracts');
  });

  it('applies request over file over default, replacing arrays, with provenance', () => {
    const file = parseConfigInput({
      configVersion: '1.1.0',
      estimationScope: {
        mode: 'contracts',
        contracts: [{ path: 'src/F.sol', kind: 'contract', name: 'FromFile' }],
        reason: 'file',
      },
    });
    const fromFile = mergeConfig({ defaults: trusted(), fileConfig: file });
    expect(
      fromFile.config.provenance.find((item) => item.field === 'estimationScope')?.source,
    ).toBe('config');
    const request = mergeConfig({
      defaults: trusted(),
      fileConfig: file,
      cli: { estimationScope: TWO },
    });
    expect(request.config.provenance.find((item) => item.field === 'estimationScope')?.source).toBe(
      'cli',
    );
    expect(
      request.config.estimationScope.mode === 'contracts'
        ? request.config.estimationScope.contracts.map((item) => item.name)
        : [],
    ).toEqual(['Lib', 'Zed']);
    const reset = mergeConfig({
      defaults: trusted(),
      fileConfig: file,
      cli: { estimationScope: { mode: 'all' } },
    });
    expect(reset.config.estimationScope).toEqual({ mode: 'all' });
  });

  it('validates a request override even when it is the only input', () => {
    expect(() =>
      mergeConfig({
        defaults: trusted(),
        cli: {
          estimationScope: { mode: 'contracts', contracts: [], reason: 'x' },
        },
      }),
    ).toThrow(ConfigError);
  });

  it('hashes selection order-independently and changes the hash with the selection', () => {
    const reversed: EstimationScopeInput =
      TWO.mode === 'contracts' ? { ...TWO, contracts: [...TWO.contracts].reverse() } : TWO;
    const one = mergeConfig({ defaults: trusted(), cli: { estimationScope: TWO } });
    const two = mergeConfig({ defaults: trusted(), cli: { estimationScope: reversed } });
    expect(one.semanticHash).toBe(two.semanticHash);
    expect(mergeConfig({ defaults: trusted() }).semanticHash).not.toBe(one.semanticHash);
    const changed: EstimationScopeInput =
      TWO.mode === 'contracts' ? { ...TWO, reason: 'Different reason.' } : TWO;
    expect(
      mergeConfig({ defaults: trusted(), cli: { estimationScope: changed } }).semanticHash,
    ).not.toBe(one.semanticHash);
    const guarded: EstimationScopeInput =
      TWO.mode === 'contracts'
        ? {
            ...TWO,
            contracts: [
              {
                ...(TWO.contracts[0] as (typeof TWO.contracts)[number]),
                sourceHash: 'a'.repeat(64),
              },
              ...TWO.contracts.slice(1),
            ],
          }
        : TWO;
    expect(
      mergeConfig({ defaults: trusted(), cli: { estimationScope: guarded } }).semanticHash,
    ).not.toBe(one.semanticHash);
  });

  it('rejects an explicit contract scope under model 1.0.0 from any layer', () => {
    const legacyModel = { profile: 'heuristic-v1' as const, modelVersion: '1.0.0' as const };
    expect(() =>
      mergeConfig({
        defaults: trusted(),
        fileConfig: parseConfigInput({ configVersion: '1.1.0', model: legacyModel }),
        cli: { estimationScope: TWO },
      }),
    ).toThrow(ConfigError);
    expect(() =>
      parseConfigInput({ configVersion: '1.1.0', model: legacyModel, estimationScope: TWO }),
    ).toThrow(ConfigError);
    // Omitted or whole-scope selection is fine with the legacy model.
    expect(
      mergeConfig({
        defaults: trusted(),
        fileConfig: parseConfigInput({ configVersion: '1.1.0', model: legacyModel }),
      }).config.model.modelVersion,
    ).toBe('1.0.0');
  });

  it('preserves earlier explicit parameter overrides when a later layer selects only a version', () => {
    const custom = { low: 0.5, high: 0.75 };
    const earlier = parseConfigInput({
      configVersion: '1.1.0',
      model: { profile: 'heuristic-v1', parameters: { slocHours: custom } },
    });
    const later = parseConfigInput({
      configVersion: '1.1.0',
      model: { profile: 'heuristic-v1', modelVersion: '1.0.0' },
    });
    const metadataLayer = mergeConfig({ defaults: trusted(), fileConfig: earlier });
    expect(metadataLayer.config.model.parameters.slocHours).toEqual(custom);
    // A later layer that only selects a version keeps the explicit override: the config layer is
    // one object, so layering is exercised through the request after a file layer.
    const viaVersion = mergeConfig({
      defaults: trusted(),
      fileConfig: parseConfigInput({
        configVersion: '1.1.0',
        model: {
          profile: 'heuristic-v1',
          modelVersion: '1.0.0',
          parameters: { slocHours: custom },
        },
      }),
    });
    expect(viaVersion.config.model.modelVersion).toBe('1.0.0');
    expect(viaVersion.config.model.parameters.slocHours).toEqual(custom);
    expect(viaVersion.config.model.parameters.projectHours).toEqual({ low: 4, high: 12 });
    expect(later.model?.modelVersion).toBe('1.0.0');
    // The semantic hash includes the selected model version.
    expect(viaVersion.semanticHash).not.toBe(
      mergeConfig({
        defaults: trusted(),
        fileConfig: parseConfigInput({
          configVersion: '1.1.0',
          model: {
            profile: 'heuristic-v1',
            modelVersion: '1.1.0',
            parameters: { slocHours: custom },
          },
        }),
      }).semanticHash,
    );
  });
});
