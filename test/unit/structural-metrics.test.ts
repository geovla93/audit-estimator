import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  callableIdentity,
  contractIdentity,
  declarationIdentity,
  edgeIdentity,
  fileIdentity,
} from '../../src/domain/canonical.ts';
import type {
  CallableAnalysis,
  FileScopeEntry,
  Measurement,
  SourceRange,
} from '../../src/domain/types.ts';
import type {
  ParseFileResult,
  ParserAttribute,
  ParserDeclaration,
  ParserEvent,
  ParserSource,
  ParserToken,
  ParserTokenKind,
} from '../../src/parser/protocol.ts';
import { buildFileMetrics } from '../../src/metrics/structural.ts';
import type { FileMetrics } from '../../src/metrics/structural.ts';

const PATH = 'contracts/A.sol';
const fileId = fileIdentity(PATH);

function makeSource(text: string): ParserSource {
  const bytes = Buffer.from(text, 'utf8');
  const byteHash = createHash('sha256').update(bytes).digest('hex');
  const entry: FileScopeEntry = {
    fileId,
    path: PATH,
    role: 'scoped',
    ownership: 'first-party',
    ownershipEvidence: [],
    physicalIdentity: 'fixture',
    byteHash,
  };
  return {
    fileId,
    snapshot: {
      canonicalPath: PATH,
      absolutePath: `/fixture/${PATH}`,
      originalBytes: bytes,
      originalText: text,
      byteHash,
    },
    manifestEntry: entry,
  };
}

/** Range of the `nth` occurrence of `needle`. Line and column fields are not used by metrics. */
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

/** A tiny lexer sufficient for hand-built fixtures: words, whitespace, // comments, punctuation. */
function lex(text: string): ParserToken[] {
  const tokens: ParserToken[] = [];
  const pattern = /(\/\/[^\n]*)|(\s+)|(\w+)|(.)/gu;
  for (const match of text.matchAll(pattern)) {
    const lexeme = match[0];
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
        endByte: startByte + Buffer.byteLength(lexeme, 'utf8'),
        start: { line: 1, column: 1 },
        end: { line: 1, column: 1 },
      },
    });
  }
  return tokens;
}

function attributes(
  values: Readonly<Record<string, string | number | boolean | null>>,
): ParserAttribute[] {
  return Object.entries(values).map(([key, value]) => ({ key, value }));
}

function contractDeclaration(
  text: string,
  header: string,
  whole: string,
  kind = 'contract',
): ParserDeclaration {
  const range = at(text, whole);
  const id = contractIdentity(PATH, kind, range.startByte);
  return {
    id,
    kind,
    name: header,
    contractId: id,
    callableId: null,
    declarationRange: range,
    nameRange: at(text, header),
    bodyRange: range,
    hasBody: true,
    attributes: [],
  };
}

interface CallableSpec {
  readonly kind: string;
  readonly name: string;
  readonly whole: string;
  readonly body?: string;
  readonly contract: ParserDeclaration | null;
  readonly attributes?: Readonly<Record<string, string | number | boolean | null>>;
}

function callableDeclaration(text: string, spec: CallableSpec): ParserDeclaration {
  const range = at(text, spec.whole);
  const id = callableIdentity(PATH, spec.kind, range.startByte);
  const bodyText = spec.body;
  const bodyRange = bodyText === undefined ? null : at(text, bodyText);
  return {
    id,
    kind: spec.kind,
    name: spec.name,
    contractId: spec.contract === null ? null : (spec.contract.contractId ?? null),
    callableId: id,
    declarationRange: range,
    nameRange: range,
    bodyRange,
    hasBody: bodyRange !== null,
    attributes: attributes({
      'declaration-kind': spec.kind,
      'has-body': bodyRange !== null,
      ...spec.attributes,
    }),
  };
}

function event(
  kind: string,
  range: SourceRange,
  owner: {
    readonly contract?: ParserDeclaration | null;
    readonly callable?: ParserDeclaration | null;
  },
  values: Readonly<Record<string, string | number | boolean | null>> = {},
): ParserEvent {
  return {
    fileId,
    kind,
    contractId: owner.contract?.contractId ?? owner.callable?.contractId ?? null,
    callableId: owner.callable?.callableId ?? null,
    range,
    attributes: attributes(values),
  };
}

function parsed(
  text: string,
  declarations: readonly ParserDeclaration[],
  events: readonly ParserEvent[],
  version = '0.8.28',
): ParseFileResult {
  return {
    status: 'parsed',
    fileId,
    version: {
      selectedVersion: version,
      selectionSource: 'inferred',
      ignoredHint: 'not-applicable',
      compatibleVersions: [version],
      installedVersions: [version],
      pragmaRanges: [],
      parserVersion: 'test',
    },
    tokens: lex(text),
    declarations: [...declarations],
    imports: [],
    events: [...events],
    diagnostics: [],
    visitedNodes: 1_000,
  };
}

function metricsFor(
  text: string,
  declarations: readonly ParserDeclaration[],
  events: readonly ParserEvent[],
  version = '0.8.28',
): FileMetrics {
  return buildFileMetrics(makeSource(text), parsed(text, declarations, events, version));
}

function value<T>(measurement: Measurement<T>): T {
  if (measurement.status !== 'measured') {
    throw new Error(`Expected measured, got unavailable: ${measurement.reason}`);
  }
  return measurement.value;
}

function reason(measurement: Measurement<unknown>): string {
  if (measurement.status !== 'unavailable') throw new Error('Expected unavailable.');
  return measurement.reason;
}

function evidenceOf<T>(measurement: Measurement<T>): readonly SourceRange[] {
  if (measurement.status !== 'measured') throw new Error('Expected measured.');
  return measurement.evidence.map((item) => item.range);
}

function onlyCallable(metrics: FileMetrics): CallableAnalysis {
  const callable = metrics.callables[0];
  if (callable === undefined) throw new Error('Expected a callable.');
  return callable;
}

describe('effective visibility and mutability', () => {
  const body = '{}';
  type Outcome = { readonly measured: string } | { readonly unavailable: string };
  const cases: readonly (readonly [string, string, string, Outcome, Outcome])[] = [
    // kind, version, explicit visibility ('' = absent), expected effective visibility, mutability
    ['function', '0.4.24', '', { measured: 'public' }, { measured: 'nonpayable' }],
    ['function', '0.6.12', '', { unavailable: 'visibility-missing' }, { measured: 'nonpayable' }],
    ['function', '0.8.28', '', { unavailable: 'visibility-missing' }, { measured: 'nonpayable' }],
    ['function', '0.8.28', 'external', { measured: 'external' }, { measured: 'nonpayable' }],
    ['function', '0.4.24', 'private', { measured: 'private' }, { measured: 'nonpayable' }],
    ['free-function', '0.4.24', '', { measured: 'internal' }, { measured: 'nonpayable' }],
    ['free-function', '0.6.12', '', { measured: 'internal' }, { measured: 'nonpayable' }],
    ['free-function', '0.8.28', '', { measured: 'internal' }, { measured: 'nonpayable' }],
    ['constructor', '0.4.24', '', { measured: 'public' }, { measured: 'nonpayable' }],
    ['constructor', '0.6.12', '', { measured: 'public' }, { measured: 'nonpayable' }],
    ['constructor', '0.8.28', '', { unavailable: 'not-applicable' }, { measured: 'nonpayable' }],
    ['constructor', '0.6.12', 'internal', { measured: 'internal' }, { measured: 'nonpayable' }],
    ['fallback', '0.4.24', '', { measured: 'public' }, { measured: 'nonpayable' }],
    ['fallback', '0.6.12', '', { unavailable: 'visibility-missing' }, { measured: 'nonpayable' }],
    ['fallback', '0.8.28', '', { unavailable: 'visibility-missing' }, { measured: 'nonpayable' }],
    ['fallback', '0.8.28', 'external', { measured: 'external' }, { measured: 'nonpayable' }],
    ['receive', '0.4.24', '', { measured: 'public' }, { measured: 'payable' }],
    ['receive', '0.6.12', '', { unavailable: 'visibility-missing' }, { measured: 'payable' }],
    ['receive', '0.8.28', '', { unavailable: 'visibility-missing' }, { measured: 'payable' }],
    ['receive', '0.8.28', 'external', { measured: 'external' }, { measured: 'payable' }],
    [
      'modifier',
      '0.4.24',
      '',
      { unavailable: 'not-applicable' },
      { unavailable: 'not-applicable' },
    ],
    [
      'modifier',
      '0.6.12',
      '',
      { unavailable: 'not-applicable' },
      { unavailable: 'not-applicable' },
    ],
    [
      'modifier',
      '0.8.28',
      '',
      { unavailable: 'not-applicable' },
      { unavailable: 'not-applicable' },
    ],
  ];

  function expectOutcome(actual: Measurement<string>, expected: Outcome): void {
    const summary: Outcome =
      actual.status === 'measured' ? { measured: actual.value } : { unavailable: actual.reason };
    expect(summary).toEqual(expected);
  }

  it.each(cases)('%s at %s with explicit visibility %j', (kind, version, explicit, vis, mut) => {
    const parserKind = kind === 'free-function' ? 'function' : kind;
    const text = `contract C { callable ${body} }`;
    const contract = kind === 'free-function' ? null : contractDeclaration(text, 'C', text);
    const callable = callableDeclaration(text, {
      kind: parserKind,
      name: parserKind,
      whole: `callable ${body}`,
      body,
      contract,
      attributes: explicit === '' ? {} : { visibility: explicit },
    });
    const metrics = metricsFor(
      text,
      contract === null ? [callable] : [contract, callable],
      [],
      version,
    );
    const analysis = onlyCallable(metrics);
    expect(analysis.kind).toBe(kind);
    expectOutcome(analysis.visibilityEffective, vis);
    expectOutcome(analysis.mutabilityEffective, mut);
    expect(value(analysis.visibilityExplicit)).toBe(explicit === '' ? 'none' : explicit);
    expect(value(analysis.mutabilityExplicit)).toBe('none');
  });

  it('maps explicit payable and the legacy constant keyword', () => {
    const text = 'contract C { function f() {} function g() {} }';
    const contract = contractDeclaration(text, 'C', text);
    const payable = callableDeclaration(text, {
      kind: 'function',
      name: 'f',
      whole: 'function f() {}',
      body: '{}',
      contract,
      attributes: { visibility: 'public', mutability: 'payable' },
    });
    const legacy = callableDeclaration(text, {
      kind: 'function',
      name: 'g',
      whole: 'function g() {}',
      body: '{}',
      contract,
      attributes: { mutability: 'constant' },
    });
    const metrics = metricsFor(text, [contract, payable, legacy], [], '0.4.24');
    const byName = (name: string): CallableAnalysis => {
      const found = metrics.callables.find((callable) => callable.name === name);
      if (found === undefined) throw new Error('missing');
      return found;
    };
    expect(value(byName('f').mutabilityExplicit)).toBe('payable');
    expect(value(byName('f').mutabilityEffective)).toBe('payable');
    expect(value(byName('g').mutabilityExplicit)).toBe('constant');
    expect(value(byName('g').mutabilityEffective)).toBe('view');
    expect(value(byName('g').visibilityEffective)).toBe('public');
  });
});

describe('callable counts', () => {
  const text =
    'contract C {\n  function f() public onlyOwner(a ? 1 : 2) {\n    for (;;) { while (x) { if (y) {} } }\n    for (;;) {}\n  }\n  function g() external;\n}\n';

  function build(extra: (c: ParserDeclaration, f: ParserDeclaration) => ParserEvent[]): {
    readonly metrics: FileMetrics;
    readonly f: ParserDeclaration;
    readonly g: ParserDeclaration;
  } {
    const contract = contractDeclaration(text, 'C', text.trimEnd());
    const f = callableDeclaration(text, {
      kind: 'function',
      name: 'f',
      whole: text.slice(text.indexOf('function f'), text.indexOf('  function g') - 1),
      body: text.slice(text.indexOf('{\n    for'), text.indexOf('  function g') - 3),
      contract,
      attributes: { visibility: 'public' },
    });
    const g = callableDeclaration(text, {
      kind: 'function',
      name: 'g',
      whole: 'function g() external;',
      contract,
      attributes: { visibility: 'external' },
    });
    return { metrics: metricsFor(text, [contract, f, g], extra(contract, f)), f, g };
  }

  function callableNamed(metrics: FileMetrics, name: string): CallableAnalysis {
    const found = metrics.callables.find((callable) => callable.name === name);
    if (found === undefined) throw new Error('missing callable');
    return found;
  }

  it('reports no-body counts as unavailable, never zero', () => {
    const { metrics } = build(() => []);
    const g = callableNamed(metrics, 'g');
    expect(value(g.hasBody)).toBe(false);
    for (const field of [
      g.decisions,
      g.loops,
      g.maxLoopDepth,
      g.assemblyBlocks,
      g.yulStatements,
      g.yulCalls,
      g.yulControlFlow,
      g.lowLevelCallCandidates,
    ]) {
      expect(reason(field)).toBe('no-body');
    }
    expect(value(g.modifiersApplied)).toEqual([]);
    const f = callableNamed(metrics, 'f');
    expect(value(f.hasBody)).toBe(true);
    expect(value(f.decisions)).toBe(0);
    expect(evidenceOf(f.decisions)).toEqual([]);
  });

  it('excludes a ternary in a modifier-invocation argument (outside the body)', () => {
    const { metrics, f } = build((_c, fDecl) => [
      event('control', at(text, 'a ? 1 : 2'), { callable: fDecl }, { 'control-kind': 'ternary' }),
    ]);
    const analysis = callableNamed(metrics, 'f');
    expect(f.bodyRange?.startByte).toBeGreaterThan(at(text, 'a ? 1 : 2').endByte);
    expect(value(analysis.decisions)).toBe(0);
    expect(value(metrics.file.decisions)).toBe(0);
  });

  it('counts decisions, loops and loop depth from nested ranges', () => {
    const { metrics } = build((_c, f) => [
      event(
        'control',
        at(text, 'for (;;) { while (x) { if (y) {} } }'),
        { callable: f },
        { 'control-kind': 'for' },
      ),
      event(
        'control',
        at(text, 'while (x) { if (y) {} }'),
        { callable: f },
        { 'control-kind': 'while' },
      ),
      event('control', at(text, 'if (y) {}'), { callable: f }, { 'control-kind': 'if' }),
      event('control', at(text, 'for (;;) {}'), { callable: f }, { 'control-kind': 'for' }),
    ]);
    const analysis = callableNamed(metrics, 'f');
    expect(value(analysis.decisions)).toBe(4);
    expect(value(analysis.loops)).toBe(3);
    expect(value(analysis.maxLoopDepth)).toBe(2);
    expect(evidenceOf(analysis.decisions)).toHaveLength(4);
    expect(value(metrics.file.maxLoopDepth)).toBe(2);
    expect(value(metrics.file.decisions)).toBe(4);
    expect(value(metrics.file.loops)).toBe(3);
  });

  it('counts only the eight decision kinds and never else, try or Yul', () => {
    const kinds = ['if', 'ternary', 'for', 'while', 'do-while', 'catch', 'and', 'or'];
    const { metrics } = build((_c, f) => [
      ...kinds.map((kind, index) =>
        event('control', at(text, 'x', 0), { callable: f }, { 'control-kind': kind, index }),
      ),
      event('control', at(text, 'x', 0), { callable: f }, { 'control-kind': 'else' }),
      event('control', at(text, 'x', 0), { callable: f }, { 'control-kind': 'try' }),
      event('yul-control', at(text, 'x', 0), { callable: f }, { 'yul-kind': 'for' }),
      event('yul-control', at(text, 'x', 0), { callable: f }, { 'yul-kind': 'if' }),
      event('yul-call', at(text, 'x', 0), { callable: f }),
      event('yul-statement', at(text, 'x', 0), { callable: f }),
      event('assembly', at(text, 'x', 0), { callable: f }, { 'memory-safe': true }),
      event('call-site', at(text, 'x', 0), { callable: f }, { 'low-level-candidate': true }),
      event('call-site', at(text, 'y', 0), { callable: f }, { 'low-level-candidate': false }),
    ]);
    const analysis = callableNamed(metrics, 'f');
    expect(value(analysis.decisions)).toBe(8);
    expect(value(analysis.loops)).toBe(3);
    expect(value(analysis.yulControlFlow)).toBe(2);
    expect(value(analysis.yulCalls)).toBe(1);
    expect(value(analysis.yulStatements)).toBe(1);
    expect(value(analysis.assemblyBlocks)).toBe(1);
    expect(value(analysis.lowLevelCallCandidates)).toBe(1);
    expect(value(metrics.file.yulControlFlow)).toBe(2);
    expect(value(metrics.file.lowLevelCallCandidates)).toBe(1);
  });

  it('ignores a contract-level control event (state initializer) at file level', () => {
    const { metrics } = build((contract) => [
      event('control', at(text, 'a ? 1 : 2'), { contract }, { 'control-kind': 'ternary' }),
    ]);
    expect(value(metrics.file.decisions)).toBe(0);
    expect(value(metrics.file.loops)).toBe(0);
  });

  it('lists modifier invocations in source order', () => {
    const { metrics } = build((_c, f) => [
      event(
        'modifier-invocation',
        at(text, 'onlyOwner(a ? 1 : 2)'),
        { callable: f },
        { name: 'onlyOwner' },
      ),
      event('modifier-invocation', at(text, 'public'), { callable: f }, { name: 'first' }),
    ]);
    expect(value(callableNamed(metrics, 'f').modifiersApplied)).toEqual(['first', 'onlyOwner']);
  });
});

describe('Yul control is separate from Solidity decisions', () => {
  it('counts a Yul for loop only as Yul control flow', () => {
    const text = 'contract C { function f() public { assembly { for {} 1 {} {} } } }';
    const contract = contractDeclaration(text, 'C', text);
    const f = callableDeclaration(text, {
      kind: 'function',
      name: 'f',
      whole: 'function f() public { assembly { for {} 1 {} {} } }',
      body: '{ assembly { for {} 1 {} {} } }',
      contract,
      attributes: { visibility: 'public' },
    });
    const metrics = metricsFor(
      text,
      [contract, f],
      [
        event(
          'assembly',
          at(text, 'assembly { for {} 1 {} {} }'),
          { callable: f },
          { 'memory-safe': false },
        ),
        event('yul-control', at(text, 'for {} 1 {} {}'), { callable: f }, { 'yul-kind': 'for' }),
      ],
    );
    const analysis = onlyCallable(metrics);
    expect(value(analysis.decisions)).toBe(0);
    expect(value(analysis.loops)).toBe(0);
    expect(value(analysis.maxLoopDepth)).toBe(0);
    expect(value(analysis.yulControlFlow)).toBe(1);
    expect(value(analysis.assemblyBlocks)).toBe(1);
  });
});

describe('record shapes', () => {
  const text =
    'function free() {}\ncontract C {\n  constructor() {}\n  fallback() external {}\n  modifier m() { _; }\n}\n';

  it('maps free functions, nulls placeholder names, and sorts ids ascending', () => {
    const contract = contractDeclaration(
      text,
      'C',
      text.slice(text.indexOf('contract C')).trimEnd(),
    );
    const free = callableDeclaration(text, {
      kind: 'function',
      name: 'free',
      whole: 'function free() {}',
      body: '{}',
      contract: null,
    });
    const constructor = callableDeclaration(text, {
      kind: 'constructor',
      name: 'constructor',
      whole: 'constructor() {}',
      body: '{}',
      contract,
    });
    const fallback = callableDeclaration(text, {
      kind: 'fallback',
      name: 'fallback',
      whole: 'fallback() external {}',
      body: '{}',
      contract,
      attributes: { visibility: 'external' },
    });
    const modifier = callableDeclaration(text, {
      kind: 'modifier',
      name: 'm',
      whole: 'modifier m() { _; }',
      body: '{ _; }',
      contract,
    });
    const metrics = metricsFor(text, [modifier, contract, fallback, free, constructor], []);
    const byKind = new Map(metrics.callables.map((callable) => [callable.kind, callable]));
    expect(byKind.get('free-function')?.name).toBe('free');
    expect(byKind.get('free-function')?.contractId).toBeNull();
    expect(byKind.get('constructor')?.name).toBeNull();
    expect(byKind.get('fallback')?.name).toBeNull();
    expect(byKind.get('modifier')?.name).toBe('m');
    const ids = metrics.callables.map((callable) => callable.id);
    expect(ids).toEqual([...ids].sort());
    expect(metrics.file.callableIds).toEqual(ids);
    const contractRecord = metrics.contracts[0];
    expect(contractRecord?.callableIds).toEqual(
      metrics.callables
        .filter((callable) => callable.contractId !== null)
        .map((callable) => callable.id),
    );
    expect(metrics.file.contractIds).toEqual([contract.id]);
    expect(metrics.file.role).toBe('scoped');
    expect(metrics.file.ownership).toBe('first-party');
    expect(metrics.file.syntaxComplete).toBe(true);
  });

  it('counts declarations by kind with their ranges as evidence', () => {
    const source = 'contract A {} abstract contract B {} library L {} interface I {} contract D {}';
    const declarations = [
      contractDeclaration(source, 'A', 'contract A {}'),
      contractDeclaration(source, 'B', 'abstract contract B {}', 'abstract-contract'),
      contractDeclaration(source, 'L', 'library L {}', 'library'),
      contractDeclaration(source, 'I', 'interface I {}', 'interface'),
      contractDeclaration(source, 'D', 'contract D {}'),
    ];
    const counts = metricsFor(source, declarations, []).file.declarationCounts;
    expect(value(counts.contracts)).toBe(2);
    expect(value(counts.abstractContracts)).toBe(1);
    expect(value(counts.libraries)).toBe(1);
    expect(value(counts.interfaces)).toBe(1);
    expect(evidenceOf(counts.contracts)).toEqual([
      at(source, 'contract A {}'),
      at(source, 'contract D {}'),
    ]);
  });
});

describe('state variables', () => {
  const text = 'contract C { m; a; t; c; i; u; s; e; }';

  function build(
    variables: readonly (readonly [string, string, Readonly<Record<string, boolean>>])[],
  ): { readonly metrics: FileMetrics; readonly contract: ParserDeclaration } {
    const contract = contractDeclaration(text, 'C', text);
    const events = variables.map(([needle, shape, flags]) =>
      event(
        'state-variable',
        at(text, needle),
        { contract },
        { 'type-shape': shape, constant: false, immutable: false, transient: false, ...flags },
      ),
    );
    return { metrics: metricsFor(text, [contract], events), contract };
  }

  it('distinguishes declared from mutable and classifies complex mutable shapes', () => {
    const { metrics } = build([
      ['m', 'mapping', {}],
      ['a', 'array', {}],
      ['t', 'elementary', { transient: true }],
      ['c', 'elementary', { constant: true }],
      ['i', 'array', { immutable: true }],
      ['u', 'user-defined', {}],
      ['s', 'struct', {}],
      ['e', 'weird', {}],
    ]);
    const vars = metrics.file.stateVariables;
    expect(value(vars.count)).toBe(8);
    // everything except constant and immutable is mutable, and transient counts as mutable
    expect(value(vars.mutableCount)).toBe(6);
    const ids = (needle: string): string =>
      declarationIdentity(PATH, 'state-variable', at(text, needle).startByte);
    expect(value(vars.complexMutableDeclarationIds)).toEqual([ids('m'), ids('a')].sort());
    const shapes = value(vars.typeShapes);
    const shapeIds = shapes.map((shape) => shape.declarationId);
    expect(shapeIds).toEqual([...shapeIds].sort());
    const byId = new Map(shapes.map((shape) => [shape.declarationId, shape]));
    expect(byId.get(ids('t'))).toEqual({
      declarationId: ids('t'),
      shape: 'elementary',
      mutable: true,
    });
    expect(byId.get(ids('c'))?.mutable).toBe(false);
    expect(byId.get(ids('i'))).toEqual({ declarationId: ids('i'), shape: 'array', mutable: false });
    expect(byId.get(ids('u'))?.shape).toBe('user-defined');
    expect(byId.get(ids('e'))?.shape).toBe('unknown');
    expect(
      value(metrics.contracts[0]?.stateVariables.count ?? { status: 'unavailable', reason: 'x' }),
    ).toBe(8);
    expect(evidenceOf(vars.count)).toHaveLength(8);
  });

  it('does not treat user-defined or struct shapes as complex in 007', () => {
    const { metrics } = build([
      ['u', 'user-defined', {}],
      ['s', 'struct', {}],
    ]);
    expect(value(metrics.file.stateVariables.complexMutableDeclarationIds)).toEqual([]);
    expect(value(metrics.file.stateVariables.mutableCount)).toBe(2);
  });

  it('reports zero state variables as measured zero with no evidence', () => {
    const { metrics } = build([]);
    expect(value(metrics.file.stateVariables.count)).toBe(0);
    expect(evidenceOf(metrics.file.stateVariables.count)).toEqual([]);
  });
});

describe('source lines', () => {
  it('counts contract lines from tokens inside the contract range and the union at file level', () => {
    const text = 'contract A {} contract B {}\n// note\ncontract Z {\n  uint x; // tail\n}\n';
    const a = contractDeclaration(text, 'A', 'contract A {}');
    const b = contractDeclaration(text, 'B', 'contract B {}');
    const z = contractDeclaration(text, 'Z', 'contract Z {\n  uint x; // tail\n}');
    const metrics = metricsFor(text, [a, b, z], []);
    const byName = new Map(metrics.contracts.map((contract) => [contract.name, contract]));
    expect(value(byName.get('A')?.sourceLines ?? { status: 'unavailable', reason: '' })).toBe(1);
    expect(value(byName.get('B')?.sourceLines ?? { status: 'unavailable', reason: '' })).toBe(1);
    expect(value(byName.get('Z')?.sourceLines ?? { status: 'unavailable', reason: '' })).toBe(3);
    expect(value(metrics.file.sourceLines)).toBe(4);
    expect(value(metrics.file.physicalLines)).toBe(5);
    expect([...(metrics.lineSet?.oneBasedLines ?? [])].sort((a, b) => a - b)).toEqual([1, 3, 4, 5]);
    expect(metrics.lineSet?.fileId).toBe(fileId);
  });
});

describe('failed files', () => {
  it.each([
    ['PARSE_INVALID', 'parse-invalid'],
    ['LANGUAGE_UNSUPPORTED', 'parse-language-unsupported'],
    ['LIMIT_EXCEEDED', 'parse-limit-exceeded'],
    ['INTERNAL_ERROR', 'parse-internal-error'],
  ] as const)('%s keeps physical lines and makes the rest %s', (code, expected) => {
    const text = 'contract {\r\n  broken\r\n';
    const metrics = buildFileMetrics(makeSource(text), {
      status: 'failed',
      fileId,
      code,
      diagnostics: [],
    });
    expect(value(metrics.file.physicalLines)).toBe(2);
    expect(metrics.file.syntaxComplete).toBe(false);
    expect(metrics.lineSet).toBeNull();
    expect(metrics.contracts).toEqual([]);
    expect(metrics.callables).toEqual([]);
    expect(metrics.file.contractIds).toEqual([]);
    expect(metrics.file.callableIds).toEqual([]);
    expect(metrics.file.importIds).toEqual([]);
    for (const field of [
      metrics.file.sourceLines,
      metrics.file.declarationCounts.contracts,
      metrics.file.declarationCounts.abstractContracts,
      metrics.file.declarationCounts.libraries,
      metrics.file.declarationCounts.interfaces,
      metrics.file.stateVariables.count,
      metrics.file.stateVariables.mutableCount,
      metrics.file.stateVariables.complexMutableDeclarationIds,
      metrics.file.stateVariables.typeShapes,
      metrics.file.decisions,
      metrics.file.loops,
      metrics.file.maxLoopDepth,
      metrics.file.assemblyBlocks,
      metrics.file.yulStatements,
      metrics.file.yulCalls,
      metrics.file.yulControlFlow,
      metrics.file.lowLevelCallCandidates,
    ]) {
      expect(reason(field)).toBe(expected);
    }
  });

  it('measures physical lines of an empty failed file as zero with no evidence', () => {
    const metrics = buildFileMetrics(makeSource(''), {
      status: 'failed',
      fileId,
      code: 'PARSE_INVALID',
      diagnostics: [],
    });
    expect(value(metrics.file.physicalLines)).toBe(0);
    expect(evidenceOf(metrics.file.physicalLines)).toEqual([]);
  });

  it('rejects a result for another file', () => {
    expect(() =>
      buildFileMetrics(makeSource('x'), {
        status: 'failed',
        fileId: fileIdentity('contracts/Other.sol'),
        code: 'PARSE_INVALID',
        diagnostics: [],
      }),
    ).toThrow(TypeError);
  });
});

describe('imports and evidence', () => {
  it('lists import ids in result order and uses one whole-file range for line evidence', () => {
    const text = 'import "./a.sol";\nimport "./b.sol";\n';
    const result = parsed(text, [], []);
    if (result.status !== 'parsed') throw new Error('unreachable');
    const importIds = [edgeIdentity(PATH, 'import', 0, 0), edgeIdentity(PATH, 'import', 18, 1)];
    const withImports: ParseFileResult = {
      ...result,
      imports: importIds.map((id, index) => ({
        id,
        specifier: index === 0 ? './a.sol' : './b.sol',
        range: at(text, 'import', index),
        specifierRange: at(text, index === 0 ? '"./a.sol"' : '"./b.sol"'),
        aliasForm: 'bare' as const,
      })),
    };
    const metrics = buildFileMetrics(makeSource(text), withImports);
    expect(metrics.file.importIds).toEqual(importIds);
    expect(value(metrics.file.physicalLines)).toBe(2);
    expect(
      metrics.file.physicalLines.status === 'measured' && metrics.file.physicalLines.evidence,
    ).toEqual([
      {
        fileId,
        range: {
          startByte: 0,
          endByte: Buffer.byteLength(text, 'utf8'),
          start: { line: 1, column: 1 },
          end: { line: 3, column: 1 },
        },
      },
    ]);
  });
});
