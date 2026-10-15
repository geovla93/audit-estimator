import { describe, expect, it } from 'vitest';
import type { ParserDeclaration, ParserEvent, ParseFileResult } from '../../src/parser/protocol.ts';
import type { Measurement } from '../../src/domain/types.ts';
import { aggregateMetrics } from '../../src/metrics/aggregate.ts';
import { buildFileMetrics } from '../../src/metrics/structural.ts';
import type { FileMetrics } from '../../src/metrics/structural.ts';
import { parseOne, parseSources } from '../helpers/parse-source.ts';

type Parsed = Extract<ParseFileResult, { status: 'parsed' }>;

const PRAGMA = 'pragma solidity ^0.8.28;\n';

function attributesOf(event: ParserEvent): Record<string, string | number | boolean | null> {
  return Object.fromEntries(event.attributes.map((attribute) => [attribute.key, attribute.value]));
}

function eventsOfKind(result: Parsed, kind: string): readonly ParserEvent[] {
  return result.events.filter((event) => event.kind === kind);
}

function controlKinds(result: Parsed): readonly (string | number | boolean | null | undefined)[] {
  return eventsOfKind(result, 'control').map((event) => attributesOf(event)['control-kind']);
}

function sortedStrings(values: readonly unknown[]): string[] {
  return values.map((value) => String(value)).sort((a, b) => a.localeCompare(b));
}

function declarationNamed(result: Parsed, name: string): ParserDeclaration {
  const declaration = result.declarations.find((candidate) => candidate.name === name);
  if (declaration === undefined) throw new Error(`Missing declaration ${name}.`);
  return declaration;
}

function textOf(source: string, event: ParserEvent): string {
  return Buffer.from(source, 'utf8')
    .subarray(event.range.startByte, event.range.endByte)
    .toString('utf8')
    .trim();
}

function expectNodeBudget(result: Parsed): void {
  expect(result.visitedNodes).toBeGreaterThanOrEqual(
    result.tokens.length +
      result.declarations.length +
      result.imports.length +
      result.events.length,
  );
}

function inFunction(body: string, pragma = PRAGMA): string {
  return `${pragma}contract C { function f() public { ${body} } }`;
}

describe('structural extraction events', () => {
  it.each([
    ['if with else', 'if (a) {} else {}', ['if']],
    ['ternary', 'uint x = a ? 1 : 2;', ['ternary']],
    ['for', 'for (uint i = 0; i < 1; i++) {}', ['for']],
    ['while', 'while (a) {}', ['while']],
    ['do-while', 'do {} while (a);', ['do-while']],
    ['logical and', 'bool x = a && b;', ['and']],
    ['logical or', 'bool x = a || b;', ['or']],
    ['mixed logical operators', 'bool x = a && b || c;', ['and', 'or']],
    ['no control flow', 'uint x = 1;', []],
  ])('emits control events for %s', async (_name, body, expected) => {
    const source = inFunction(body);
    const result = await parseOne(source);
    expect(sortedStrings(controlKinds(result))).toEqual(sortedStrings(expected));
    const f = declarationNamed(result, 'f');
    for (const event of eventsOfKind(result, 'control')) {
      expect(event.callableId).toBe(f.id);
      expect(event.contractId).toBe(f.contractId);
    }
    expectNodeBudget(result);
  });

  it('emits two catch events for two catch clauses and no event for try', async () => {
    const source = inFunction(
      'try this.g() returns (uint) {} catch Error(string memory) {} catch {}',
    );
    const result = await parseOne(source);
    expect(controlKinds(result)).toEqual(['catch', 'catch']);
    expect(eventsOfKind(result, 'control').map((event) => textOf(source, event))).toEqual([
      'catch Error(string memory) {}',
      'catch {}',
    ]);
    expectNodeBudget(result);
  });

  it('nests a for event inside a while event by range containment', async () => {
    const source = inFunction('while (a) { for (uint i = 0; i < 1; i++) {} }');
    const result = await parseOne(source);
    const events = eventsOfKind(result, 'control');
    const whileEvent = events.find((event) => attributesOf(event)['control-kind'] === 'while');
    const forEvent = events.find((event) => attributesOf(event)['control-kind'] === 'for');
    expect(whileEvent).toBeDefined();
    expect(forEvent).toBeDefined();
    if (whileEvent === undefined || forEvent === undefined) return;
    expect(forEvent.range.startByte).toBeGreaterThanOrEqual(whileEvent.range.startByte);
    expect(forEvent.range.endByte).toBeLessThanOrEqual(whileEvent.range.endByte);
    expectNodeBudget(result);
  });

  it('emits a ternary in a modifier-invocation argument outside the function body', async () => {
    const source = `${PRAGMA}contract C { function f() public onlyOwner(a ? 1 : 2) { if (a) {} } }`;
    const result = await parseOne(source);
    const f = declarationNamed(result, 'f');
    const ternary = eventsOfKind(result, 'control').find(
      (event) => attributesOf(event)['control-kind'] === 'ternary',
    );
    expect(ternary).toBeDefined();
    expect(ternary?.callableId).toBe(f.id);
    expect(f.bodyRange).not.toBeNull();
    expect(ternary?.range.endByte).toBeLessThanOrEqual(f.bodyRange?.startByte ?? 0);
    expectNodeBudget(result);
  });

  it('gives a state-variable initializer ternary a contract owner and no callable', async () => {
    const result = await parseOne(`${PRAGMA}contract C { uint x = a ? 1 : 2; }`);
    const contract = declarationNamed(result, 'C');
    const ternary = eventsOfKind(result, 'control')[0];
    expect(ternary?.contractId).toBe(contract.id);
    expect(ternary?.callableId).toBeNull();
    expectNodeBudget(result);
  });

  it('gives free-function events a null contract owner', async () => {
    const result = await parseOne(
      `${PRAGMA}function g(bool a) pure returns (bool) { return a && a; }`,
    );
    const g = declarationNamed(result, 'g');
    const and = eventsOfKind(result, 'control')[0];
    expect(and?.contractId).toBeNull();
    expect(and?.callableId).toBe(g.id);
    expectNodeBudget(result);
  });
});

describe('assembly and Yul events', () => {
  const memorySafe =
    'assembly ("memory-safe") { if x {} for { let i := 0 } lt(i, 1) { i := add(i, 1) } {} switch x case 0 {} default {} sstore(0, 1) }';

  it('marks memory-safe assembly and counts Yul constructs', async () => {
    const result = await parseOne(inFunction(memorySafe));
    const f = declarationNamed(result, 'f');
    const assembly = eventsOfKind(result, 'assembly');
    expect(assembly).toHaveLength(1);
    expect(attributesOf(assembly[0] as ParserEvent)).toEqual({ 'memory-safe': true });
    expect(assembly[0]?.callableId).toBe(f.id);
    expect(
      sortedStrings(
        eventsOfKind(result, 'yul-control').map((event) => attributesOf(event)['yul-kind']),
      ),
    ).toEqual(['for', 'if', 'switch']);
    expect(eventsOfKind(result, 'yul-call')).toHaveLength(3);
    // if, for, its init and post statements, switch, and the sstore expression statement.
    expect(eventsOfKind(result, 'yul-statement')).toHaveLength(6);
    for (const kind of ['yul-control', 'yul-call', 'yul-statement']) {
      for (const event of eventsOfKind(result, kind)) expect(event.callableId).toBe(f.id);
    }
    // Yul constructs are never Solidity control events.
    expect(eventsOfKind(result, 'control')).toEqual([]);
    expectNodeBudget(result);
  });

  it('marks plain assembly as not memory-safe', async () => {
    const result = await parseOne(inFunction('assembly { sstore(0, 1) }'));
    const assembly = eventsOfKind(result, 'assembly');
    expect(assembly).toHaveLength(1);
    expect(attributesOf(assembly[0] as ParserEvent)).toEqual({ 'memory-safe': false });
    expect(eventsOfKind(result, 'yul-call')).toHaveLength(1);
    expect(eventsOfKind(result, 'yul-statement')).toHaveLength(1);
    expectNodeBudget(result);
  });

  it('accepts single-quoted memory-safe flags', async () => {
    const result = await parseOne(inFunction("assembly ('memory-safe') { }"));
    expect(attributesOf(eventsOfKind(result, 'assembly')[0] as ParserEvent)).toEqual({
      'memory-safe': true,
    });
  });

  it('does not treat other flag strings as memory-safe', async () => {
    const result = await parseOne(inFunction('assembly ("other") { }'));
    expect(attributesOf(eventsOfKind(result, 'assembly')[0] as ParserEvent)).toEqual({
      'memory-safe': false,
    });
  });
});

describe('state variable events', () => {
  it('classifies shapes and keyword attributes', async () => {
    const result = await parseOne(
      `${PRAGMA}struct S { uint a; }\ncontract C {\n` +
        '  uint a;\n  mapping(uint => uint) b;\n  uint[] c;\n  S d;\n' +
        '  uint constant e = 1;\n  uint immutable g;\n  uint transient h;\n' +
        '  function () external k;\n  constructor() { g = 1; }\n}\n',
    );
    const contract = declarationNamed(result, 'C');
    const variables = eventsOfKind(result, 'state-variable');
    expect(variables.map((event) => attributesOf(event))).toEqual([
      { 'type-shape': 'elementary', constant: false, immutable: false, transient: false },
      { 'type-shape': 'mapping', constant: false, immutable: false, transient: false },
      { 'type-shape': 'array', constant: false, immutable: false, transient: false },
      { 'type-shape': 'user-defined', constant: false, immutable: false, transient: false },
      { 'type-shape': 'elementary', constant: true, immutable: false, transient: false },
      { 'type-shape': 'elementary', constant: false, immutable: true, transient: false },
      { 'type-shape': 'elementary', constant: false, immutable: false, transient: true },
      { 'type-shape': 'unknown', constant: false, immutable: false, transient: false },
    ]);
    for (const event of variables) {
      expect(event.contractId).toBe(contract.id);
      expect(event.callableId).toBeNull();
    }
    expectNodeBudget(result);
  });

  it('does not emit state variables for locals or file-level constants', async () => {
    const result = await parseOne(
      `${PRAGMA}uint constant TOP = 1;\ncontract C { function f() public { uint x = 1; } }`,
    );
    expect(eventsOfKind(result, 'state-variable')).toEqual([]);
  });
});

describe('call-site events', () => {
  it('classifies callee shapes and name-only low-level candidates', async () => {
    const source =
      `${PRAGMA}contract C {\n  function call() public {}\n  function f() public {\n` +
      '    f();\n    a.b();\n    new C();\n    x.call{value: 1}("");\n    x.delegatecall("");\n' +
      '    token.transfer(a, 1);\n    this.call();\n    x.staticcall("");\n  }\n}\n';
    const result = await parseOne(source);
    const f = declarationNamed(result, 'f');
    const calls = eventsOfKind(result, 'call-site');
    expect(calls.map((event) => attributesOf(event))).toEqual([
      { 'callee-shape': 'identifier', 'low-level-candidate': false },
      { 'callee-shape': 'member', 'member-name': 'b', 'low-level-candidate': false },
      { 'callee-shape': 'new', 'low-level-candidate': false },
      { 'callee-shape': 'member', 'member-name': 'call', 'low-level-candidate': true },
      { 'callee-shape': 'member', 'member-name': 'delegatecall', 'low-level-candidate': true },
      { 'callee-shape': 'member', 'member-name': 'transfer', 'low-level-candidate': true },
      { 'callee-shape': 'member', 'member-name': 'call', 'low-level-candidate': true },
      { 'callee-shape': 'member', 'member-name': 'staticcall', 'low-level-candidate': true },
    ]);
    for (const event of calls) expect(event.callableId).toBe(f.id);
    expectNodeBudget(result);
  });

  it('counts the legacy x.call.value(1)("") chain exactly once, at the inner call', async () => {
    const source = `pragma solidity ^0.4.24;\ncontract C { function f() public { x.call.value(1)(""); } }`;
    const result = await parseOne(source);
    expect(result.version.selectedVersion.startsWith('0.4.')).toBe(true);
    const calls = eventsOfKind(result, 'call-site');
    expect(calls).toHaveLength(2);
    const candidates = calls.filter((event) => attributesOf(event)['low-level-candidate'] === true);
    expect(candidates).toHaveLength(1);
    expect(attributesOf(candidates[0] as ParserEvent)).toEqual({
      'callee-shape': 'member',
      'member-name': 'value',
      'low-level-candidate': true,
    });
    expect(textOf(source, candidates[0] as ParserEvent)).toBe('x.call.value(1)');
    const outer = calls.find((event) => attributesOf(event)['low-level-candidate'] === false);
    expect(attributesOf(outer as ParserEvent)).toEqual({
      'callee-shape': 'other',
      'low-level-candidate': false,
    });
    expectNodeBudget(result);
  });

  it('does not treat .value on a non-call object as a candidate', async () => {
    const result = await parseOne(inFunction('x.value(1); x.gas(1);'));
    expect(
      eventsOfKind(result, 'call-site').map((event) => attributesOf(event)['low-level-candidate']),
    ).toEqual([false, false]);
  });
});

describe('modifier-invocation events', () => {
  it('lists modifier and base-constructor invocations on a constructor', async () => {
    const result = await parseOne(
      `${PRAGMA}contract C is Base { constructor() Base(1) onlyOwner {} }`,
    );
    const constructor = result.declarations.find(
      (declaration) => declaration.kind === 'constructor',
    );
    const invocations = eventsOfKind(result, 'modifier-invocation');
    expect(invocations.map((event) => attributesOf(event))).toEqual([
      { name: 'Base' },
      { name: 'onlyOwner' },
    ]);
    for (const event of invocations) expect(event.callableId).toBe(constructor?.id);
    expectNodeBudget(result);
  });

  it('keeps qualified invocation paths and function modifiers', async () => {
    const result = await parseOne(`${PRAGMA}contract C { function g() public lib.guard() {} }`);
    expect(eventsOfKind(result, 'modifier-invocation').map((event) => attributesOf(event))).toEqual(
      [{ name: 'lib.guard' }],
    );
  });
});

describe('legacy mutability', () => {
  it('records the legacy constant function keyword as explicit constant mutability', async () => {
    const result = await parseOne(
      'pragma solidity ^0.4.24;\ncontract C { function f() constant returns (uint) { return 1; } }',
    );
    const f = declarationNamed(result, 'f');
    expect(f.attributes).toContainEqual({ key: 'mutability', value: 'constant' });
    expect(f.attributes).not.toContainEqual(expect.objectContaining({ key: 'visibility' }));
    expectNodeBudget(result);
  });
});

describe('combined fixture', () => {
  const source =
    `${PRAGMA}contract Base {}\n` +
    'contract C is Base {\n' +
    '  mapping(address => uint) balances;\n' +
    '  uint total = 1 > 0 ? 1 : 2;\n' +
    '  modifier onlyOwner() { require(msg.sender != address(0)); _; }\n' +
    '  constructor() Base() {}\n' +
    '  function f(address to) public onlyOwner returns (uint) {\n' +
    '    for (uint i = 0; i < 2; i++) { if (i > 0 && total > 0) { total += 1; } }\n' +
    '    (bool ok, ) = to.call{value: 1}("");\n' +
    '    assembly ("memory-safe") { sstore(0, 1) }\n' +
    '    return ok ? 1 : 0;\n' +
    '  }\n' +
    '}\n';

  it('keeps every owner valid and satisfies the node budget', async () => {
    const result = await parseOne(source);
    const f = declarationNamed(result, 'f');
    const ids = new Set(result.declarations.map((declaration) => declaration.id));
    const orphans = result.events.filter(
      (event) =>
        (event.callableId !== null && !ids.has(event.callableId)) ||
        (event.contractId !== null && !ids.has(event.contractId)),
    );
    expect(orphans).toEqual([]);
    const inF = result.events.filter((event) => event.callableId === f.id);
    expect(sortedStrings(inF.map((event) => event.kind))).toEqual(
      [
        'assembly',
        'call-site',
        'control', // for
        'control', // if
        'control', // and
        'control', // ternary
        'declaration',
        'modifier-invocation',
        'yul-call',
        'yul-statement',
      ].sort(),
    );
    expect(eventsOfKind(result, 'state-variable')).toHaveLength(2);
    expect(controlKinds(result).filter((kind) => kind === 'ternary')).toHaveLength(2);
    expectNodeBudget(result);
  });
});

describe('metric stability across source variants', () => {
  function baseSource(names: { readonly param: string; readonly index: string }): string {
    const { param, index } = names;
    return [
      'pragma solidity ^0.8.28;',
      'contract C {',
      '  uint x;',
      '  mapping(address => uint) m;',
      `  function f(uint ${param}) public returns (uint) {`,
      `    for (uint ${index} = 0; ${index} < ${param}; ${index}++) {`,
      `      if (${index} > 1 && ${param} > 2) { x += ${index}; }`,
      '    }',
      '    assembly { sstore(0, 1) }',
      `    return ${param} > 0 ? 1 : 0;`,
      '  }',
      '}',
      '',
    ].join('\n');
  }

  const BASE = baseSource({ param: 'a', index: 'i' });

  async function metricsOf(text: string, path = 'contracts/C.sol'): Promise<FileMetrics> {
    const [parsed] = await parseSources([{ path, text }]);
    if (parsed === undefined) throw new Error('Expected a parsed source.');
    return buildFileMetrics(parsed.source, parsed.result);
  }

  function summary(measurement: Measurement<unknown>): unknown {
    if (measurement.status === 'measured') {
      return Array.isArray(measurement.value) ? measurement.value.length : measurement.value;
    }
    return `unavailable:${measurement.reason}`;
  }

  /** Every count, without ids or ranges, which legitimately move when bytes move. */
  function counts(metrics: FileMetrics): unknown {
    const file = metrics.file;
    return {
      sourceLines: summary(file.sourceLines),
      declarations: [
        summary(file.declarationCounts.contracts),
        summary(file.declarationCounts.abstractContracts),
        summary(file.declarationCounts.libraries),
        summary(file.declarationCounts.interfaces),
      ],
      state: [
        summary(file.stateVariables.count),
        summary(file.stateVariables.mutableCount),
        summary(file.stateVariables.complexMutableDeclarationIds),
      ],
      decisions: summary(file.decisions),
      loops: summary(file.loops),
      maxLoopDepth: summary(file.maxLoopDepth),
      assemblyBlocks: summary(file.assemblyBlocks),
      yulStatements: summary(file.yulStatements),
      yulCalls: summary(file.yulCalls),
      yulControlFlow: summary(file.yulControlFlow),
      lowLevelCallCandidates: summary(file.lowLevelCallCandidates),
      contracts: metrics.contracts.map((contract) => ({
        name: contract.name,
        sourceLines: summary(contract.sourceLines),
        stateVariables: summary(contract.stateVariables.count),
      })),
      callables: metrics.callables.map((callable) => ({
        name: callable.name,
        kind: callable.kind,
        visibility: summary(callable.visibilityEffective),
        decisions: summary(callable.decisions),
        loops: summary(callable.loops),
        maxLoopDepth: summary(callable.maxLoopDepth),
        yulCalls: summary(callable.yulCalls),
      })),
    };
  }

  it('measures the base fixture exactly', async () => {
    const metrics = await metricsOf(BASE);
    expect(metrics.file.syntaxComplete).toBe(true);
    expect(summary(metrics.file.physicalLines)).toBe(12);
    expect(summary(metrics.file.sourceLines)).toBe(12);
    // for, if, `&&`, ternary
    expect(summary(metrics.file.decisions)).toBe(4);
    expect(summary(metrics.file.loops)).toBe(1);
    expect(summary(metrics.file.maxLoopDepth)).toBe(1);
    expect(summary(metrics.file.assemblyBlocks)).toBe(1);
    expect(summary(metrics.file.yulCalls)).toBe(1);
    expect(summary(metrics.file.stateVariables.count)).toBe(2);
    expect(summary(metrics.file.stateVariables.complexMutableDeclarationIds)).toBe(1);
  });

  it('changes only physicalLines when comments and blank lines are added', async () => {
    const commented = [
      '// header comment',
      '',
      'pragma solidity ^0.8.28;',
      '/// @notice natspec above the contract',
      'contract C {',
      '',
      '  uint x; // trailing comment',
      '  /* block',
      '     comment */',
      '  mapping(address => uint) m;',
      '  function f(uint a) public returns (uint) {',
      '    // loop',
      '    for (uint i = 0; i < a; i++) {',
      '      if (i > 1 && a > 2) { x += i; }',
      '    }',
      '',
      '    assembly { sstore(0, 1) }',
      '    return a > 0 ? 1 : 0;',
      '  }',
      '}',
      '',
    ].join('\n');
    const base = await metricsOf(BASE);
    const variant = await metricsOf(commented);
    expect(counts(variant)).toEqual(counts(base));
    expect(summary(base.file.physicalLines)).toBe(12);
    expect(summary(variant.file.physicalLines)).toBe(20);
  });

  it.each([
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ])('keeps every value when LF line endings become %s', async (_name, terminator) => {
    const base = await metricsOf(BASE);
    const variant = await metricsOf(BASE.split('\n').join(terminator));
    expect(counts(variant)).toEqual(counts(base));
    expect(summary(variant.file.physicalLines)).toBe(summary(base.file.physicalLines));
    expect(variant.lineSet?.oneBasedLines).toEqual(base.lineSet?.oneBasedLines);
  });

  it('keeps every count when locals are renamed', async () => {
    const base = await metricsOf(BASE);
    const renamed = await metricsOf(baseSource({ param: 'amount', index: 'cursor' }));
    expect(counts(renamed)).toEqual(counts(base));
    expect(summary(renamed.file.physicalLines)).toBe(summary(base.file.physicalLines));
  });

  it('keeps aggregates unchanged when files are reordered', async () => {
    const parsed = await parseSources([
      { path: 'contracts/B.sol', text: BASE },
      { path: 'contracts/A.sol', text: 'pragma solidity ^0.8.28;\ncontract A {}\n' },
      { path: 'lib/Ctx.sol', text: 'pragma solidity ^0.8.28;\ncontract Ctx {}\n', role: 'context' },
    ]);
    const metrics = parsed.map((item) => buildFileMetrics(item.source, item.result));
    const forward = aggregateMetrics(metrics);
    expect(aggregateMetrics([...metrics].reverse())).toEqual(forward);
    expect(summary(forward.scopedFiles)).toBe(2);
    expect(summary(forward.physicalLines)).toBe(14);
    expect(summary(forward.sourceLines)).toBe(14);
    expect(summary(forward.contracts)).toBe(2);
    expect(summary(forward.callables)).toBe(1);
  });

  it('may change sourceLines when a statement is reflowed, by an exactly known amount', async () => {
    const oneLine = [
      'pragma solidity ^0.8.28;',
      'contract C {',
      '  function f(uint a) public {',
      '    uint y = a > 0 ? 1 : 0;',
      '  }',
      '}',
      '',
    ].join('\n');
    const reflowed = [
      'pragma solidity ^0.8.28;',
      'contract C {',
      '  function f(uint a) public {',
      '    uint y =',
      '      a > 0',
      '      ? 1',
      '      : 0;',
      '  }',
      '}',
      '',
    ].join('\n');
    const before = await metricsOf(oneLine);
    const after = await metricsOf(reflowed);
    expect(summary(before.file.sourceLines)).toBe(6);
    expect(summary(after.file.sourceLines)).toBe(9);
    expect(summary(before.file.physicalLines)).toBe(6);
    expect(summary(after.file.physicalLines)).toBe(9);
    expect(summary(before.file.decisions)).toBe(1);
    expect(summary(after.file.decisions)).toBe(1);
  });
});
