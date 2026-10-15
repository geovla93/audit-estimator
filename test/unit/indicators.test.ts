import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  callableIdentity,
  contractIdentity,
  edgeIdentity,
  fileIdentity,
} from '../../src/domain/canonical.ts';
import { IndicatorSchema } from '../../src/domain/schemas.ts';
import type {
  CallableId,
  ContractId,
  EdgeId,
  EvidenceRef,
  FileId,
  FileScopeEntry,
  ImportReference,
  Indicator,
  ScopeManifest,
  ScopeRole,
  SourceRange,
} from '../../src/domain/types.ts';
import { INDICATORS_VERSION } from '../../src/domain/versions.ts';
import {
  INDICATOR_RULES,
  INDICATOR_RULE_VERSION,
  PRIVILEGE_MODIFIER_NAMES,
  UPGRADE_FUNCTION_NAMES,
} from '../../src/indicators/catalog.ts';
import { classifyIndicators } from '../../src/indicators/classify.ts';
import type { IndicatorInput } from '../../src/indicators/classify.ts';
import { HUMAN_PROMPTS, buildHumanPrompts } from '../../src/indicators/human-prompts.ts';
import { buildFileMetrics } from '../../src/metrics/structural.ts';
import type { FileMetrics } from '../../src/metrics/structural.ts';
import type {
  ParseFileResult,
  ParserAttribute,
  ParserBatch,
  ParserDeclaration,
  ParserEvent,
  ParserSource,
} from '../../src/parser/protocol.ts';
import type {
  CallSiteFact,
  ComponentObservation,
  DirectBaseEdge,
} from '../../src/relationships/types.ts';

type Attributes = Readonly<Record<string, string | number | boolean | null>>;

function attributes(values: Attributes): ParserAttribute[] {
  return Object.entries(values).map(([key, value]) => ({ key, value }));
}

function ascending(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function range(startByte: number, endByte: number): SourceRange {
  return {
    startByte,
    endByte,
    start: { line: 1, column: startByte + 1 },
    end: { line: 1, column: endByte + 1 },
  };
}

/** One hand-built file. Source text is synthetic; ranges are located by needle. */
class FileBuilder {
  public readonly fileId: FileId;
  public readonly declarations: ParserDeclaration[] = [];
  public readonly events: ParserEvent[] = [];
  public failed: Extract<ParseFileResult, { status: 'failed' }>['code'] | null = null;

  public constructor(
    public readonly path: string,
    public readonly text: string,
    public readonly role: ScopeRole = 'scoped',
  ) {
    this.fileId = fileIdentity(path);
  }

  public at(needle: string, nth = 0): SourceRange {
    let from = -1;
    for (let count = 0; count <= nth; count += 1) {
      from = this.text.indexOf(needle, from + 1);
      if (from < 0) throw new Error(`Missing ${needle} #${nth}`);
    }
    const start = Buffer.byteLength(this.text.slice(0, from), 'utf8');
    return range(start, start + Buffer.byteLength(needle, 'utf8'));
  }

  public span(startNeedle: string, endNeedle: string): SourceRange {
    const start = this.at(startNeedle);
    const end = this.at(endNeedle);
    return range(start.startByte, end.endByte);
  }

  public contract(name: string, kind = 'contract'): ParserDeclaration {
    const whole = this.span(`${kind} ${name}`, `end ${name}`);
    const id = contractIdentity(this.path, kind, whole.startByte);
    const declaration: ParserDeclaration = {
      id,
      kind,
      name,
      contractId: id,
      callableId: null,
      declarationRange: whole,
      nameRange: this.at(name),
      bodyRange: whole,
      hasBody: true,
      attributes: [],
    };
    this.declarations.push(declaration);
    return declaration;
  }

  public callable(
    contract: ParserDeclaration | null,
    kind: string,
    name: string,
    start: string,
    end: string,
  ): ParserDeclaration {
    const whole = this.span(start, end);
    const id = callableIdentity(this.path, kind, whole.startByte);
    const declaration: ParserDeclaration = {
      id,
      kind,
      name,
      contractId: contract?.contractId ?? null,
      callableId: id,
      declarationRange: whole,
      nameRange: this.at(name),
      bodyRange: whole,
      hasBody: true,
      attributes: attributes({ 'declaration-kind': kind, 'has-body': true }),
    };
    this.declarations.push(declaration);
    return declaration;
  }

  public event(
    kind: string,
    needle: string,
    owner: { contract?: ParserDeclaration | null; callable?: ParserDeclaration | null },
    values: Attributes = {},
    nth = 0,
  ): ParserEvent {
    return this.eventAt(kind, this.at(needle, nth), owner, values);
  }

  public eventAt(
    kind: string,
    where: SourceRange,
    owner: { contract?: ParserDeclaration | null; callable?: ParserDeclaration | null },
    values: Attributes = {},
  ): ParserEvent {
    const event: ParserEvent = {
      fileId: this.fileId,
      kind,
      contractId: owner.contract?.contractId ?? owner.callable?.contractId ?? null,
      callableId: owner.callable?.callableId ?? null,
      range: where,
      attributes: attributes(values),
    };
    this.events.push(event);
    return event;
  }

  public entry(): FileScopeEntry {
    return {
      fileId: this.fileId,
      path: this.path,
      role: this.role,
      ownership: 'first-party',
      ownershipEvidence: [],
      physicalIdentity: `fixture:${this.path}`,
      byteHash: createHash('sha256').update(this.text).digest('hex'),
    };
  }

  public source(): ParserSource {
    const bytes = Buffer.from(this.text, 'utf8');
    const entry = this.entry();
    return {
      fileId: this.fileId,
      snapshot: {
        canonicalPath: this.path,
        absolutePath: `/fixture/${this.path}`,
        originalBytes: bytes,
        originalText: this.text,
        byteHash: entry.byteHash,
      },
      manifestEntry: entry,
    };
  }

  public result(): ParseFileResult {
    if (this.failed !== null) {
      return { status: 'failed', fileId: this.fileId, code: this.failed, diagnostics: [] };
    }
    return {
      status: 'parsed',
      fileId: this.fileId,
      version: {
        selectedVersion: '0.8.28',
        selectionSource: 'inferred',
        ignoredHint: 'not-applicable',
        compatibleVersions: ['0.8.28'],
        installedVersions: ['0.8.28'],
        pragmaRanges: [],
        parserVersion: 'test',
      },
      tokens: [],
      declarations: [...this.declarations],
      imports: [],
      events: [...this.events],
      diagnostics: [],
      visitedNodes: 1,
    };
  }

  public metrics(): FileMetrics {
    return buildFileMetrics(this.source(), this.result());
  }
}

interface Extras {
  readonly imports?: readonly ImportReference[];
  readonly components?: readonly ComponentObservation[];
  readonly directBaseEdges?: readonly DirectBaseEdge[];
  readonly callSites?: readonly CallSiteFact[];
  readonly bounds?: IndicatorInput['bounds'];
  readonly confirmed?: IndicatorInput['relationships']['confirmedBuiltinLowLevelCalls'];
  readonly requiredAnalysisComplete?: boolean;
  readonly hasUnknownSemantics?: boolean;
}

function manifest(files: readonly FileBuilder[]): ScopeManifest {
  const entries = files.map((file) => file.entry());
  return {
    entries,
    scopedFileIds: entries.filter((e) => e.role === 'scoped').map((e) => e.fileId),
    contextFileIds: entries.filter((e) => e.role === 'context').map((e) => e.fileId),
    excludedFileIds: entries.filter((e) => e.role === 'excluded').map((e) => e.fileId),
  };
}

function input(files: readonly FileBuilder[], extras: Extras = {}): IndicatorInput {
  const batch: ParserBatch = {
    files: files.map((file) => file.result()),
    diagnostics: [],
    complete: true,
    visitedNodes: 1,
    processedBytes: 1,
  };
  return {
    manifest: manifest(files),
    syntax: batch,
    metrics: files.map((file) => file.metrics()),
    relationships: {
      imports: extras.imports ?? [],
      components: extras.components ?? [],
      directBaseEdges: extras.directBaseEdges ?? [],
      inheritance: [],
      callSites: extras.callSites ?? [],
      confirmedBuiltinLowLevelCalls: extras.confirmed ?? [],
      requiredAnalysisComplete: extras.requiredAnalysisComplete ?? true,
      hasUnknownSemantics: extras.hasUnknownSemantics ?? false,
    },
    bounds: extras.bounds,
  };
}

function site(
  file: FileBuilder,
  needle: string,
  overrides: Partial<CallSiteFact> & { readonly nth?: number } = {},
): CallSiteFact {
  const where = file.at(needle, overrides.nth ?? 0);
  const { nth: _nth, ...rest } = overrides;
  return {
    id: edgeIdentity(file.path, 'call', where.startByte, 0),
    fileId: file.fileId,
    range: where,
    ownerCallableId: null,
    ownerContractId: null,
    syntax: { calleeShape: 'member', memberName: 'x', lowLevelCandidate: false },
    calleeKind: 'member',
    definitions: [],
    receiver: { kind: 'identifier', definitions: [] },
    symbol: 'none',
    symbolTarget: null,
    candidateTargets: [],
    dispatch: 'unknown',
    builtin: null,
    limitation: 'none',
    evidence: [{ fileId: file.fileId, range: where }],
    edgeId: null,
    ...rest,
  };
}

function byRule(indicators: readonly Indicator[], rule: string): Indicator[] {
  return indicators.filter((item) => item.id.startsWith(`indicator:${rule}:`));
}

function occurrenceRows(indicators: readonly Indicator[]): Indicator[] {
  return indicators.filter((item) => !item.id.startsWith('indicator:prompt:'));
}

function evidenceStarts(indicator: Indicator | undefined): number[] {
  return (indicator?.evidence ?? []).map((ref) => ref.range.startByte);
}

const SAMPLE = [
  'contract Vault is Base {',
  '  mapping(address => uint) balances;',
  '  uint[] values;',
  '  uint constant LIMIT = 1;',
  '  mapping(address => uint) constant frozen;',
  '  Custom stored;',
  '  function initialize() external onlyOwner { assembly { for {} {} {} } }',
  '  function run() external { for (;;) {} while (x) {} do {} while (y); if (z) {} }',
  '  modifier onlyOwner() { _; }',
  '  function pull() external { target.delegatecall(data); token.transfer(a, b); }',
  '} end Vault',
].join('\n');

function sampleFile(
  role: ScopeRole = 'scoped',
  path = 'src/Vault.sol',
): {
  file: FileBuilder;
  contract: ParserDeclaration;
  initialize: ParserDeclaration;
  run: ParserDeclaration;
  pull: ParserDeclaration;
} {
  const file = new FileBuilder(path, SAMPLE, role);
  const contract = file.contract('Vault');
  const initialize = file.callable(
    contract,
    'function',
    'initialize',
    'function initialize',
    '} } }',
  );
  const run = file.callable(contract, 'function', 'run', 'function run', 'if (z) {} }');
  file.callable(contract, 'modifier', 'onlyOwner', 'modifier onlyOwner', '_; }');
  const pull = file.callable(contract, 'function', 'pull', 'function pull', 'a, b); }');
  return { file, contract, initialize, run, pull };
}

describe('catalog rules', () => {
  it('freezes a versioned catalog with the documented kinds and confidence', () => {
    expect(INDICATOR_RULE_VERSION).toBe(INDICATORS_VERSION);
    expect(Object.isFrozen(INDICATOR_RULES)).toBe(true);
    const summary = INDICATOR_RULES.map((rule) => [
      rule.key,
      rule.category,
      rule.evidenceKind,
      rule.confidence,
      rule.requiresAssessment,
    ]);
    expect(summary).toEqual([
      ['assembly', 'evm', 'measured', 'high', false],
      ['loops', 'control', 'measured', 'high', false],
      ['complex-storage-syntax', 'storage', 'measured', 'high', false],
      ['builtin-low-level', 'evm', 'measured', 'high', false],
      ['unresolved-import', 'uncertainty', 'measured', 'high', false],
      ['upgrade-name-candidate', 'boundary', 'heuristic', 'low', true],
      ['privilege-name-candidate', 'control', 'heuristic', 'low', true],
      ['external-boundary-candidate', 'boundary', 'heuristic', 'medium', true],
      ['file-evidence-incomplete', 'uncertainty', 'human', 'not-assessed', true],
    ]);
    expect([...UPGRADE_FUNCTION_NAMES].sort()).toEqual([
      'initialize',
      'reinitialize',
      'upgradeTo',
      'upgradeToAndCall',
    ]);
    expect([...PRIVILEGE_MODIFIER_NAMES].sort()).toEqual(['onlyOwner', 'onlyRole', 'requiresAuth']);
  });

  it('classifies assembly, loops and storage syntax from parsed events with exact owners', () => {
    const { file, contract, initialize, run } = sampleFile();
    file.event('assembly', 'assembly {', { callable: initialize }, { 'memory-safe': true });
    file.event('yul-control', 'for {}', { callable: initialize }, { 'yul-kind': 'for' });
    file.event('yul-control', 'assembly', { callable: initialize }, { 'yul-kind': 'if' });
    file.event('control', 'for (;;)', { callable: run }, { 'control-kind': 'for' });
    file.event('control', 'while (x)', { callable: run }, { 'control-kind': 'while' });
    file.event('control', 'do {}', { callable: run }, { 'control-kind': 'do-while' });
    file.event('control', 'if (z)', { callable: run }, { 'control-kind': 'if' });
    const mapping = file.event(
      'state-variable',
      'mapping(address => uint) balances',
      { contract },
      { 'type-shape': 'mapping', constant: false, immutable: false, transient: false },
    );
    file.event(
      'state-variable',
      'uint[] values',
      { contract },
      { 'type-shape': 'array', constant: false, immutable: false, transient: false },
    );
    file.event(
      'state-variable',
      'uint constant LIMIT',
      { contract },
      { 'type-shape': 'elementary', constant: true, immutable: false, transient: false },
    );
    file.event(
      'state-variable',
      'mapping(address => uint) constant frozen',
      { contract },
      { 'type-shape': 'mapping', constant: true, immutable: false, transient: false },
    );
    const result = classifyIndicators(input([file]));

    const assembly = byRule(result.indicators, 'assembly');
    expect(assembly).toHaveLength(1);
    expect(assembly[0]).toMatchObject({
      category: 'evm',
      evidenceKind: 'measured',
      confidence: 'high',
      requiresAssessment: false,
      ruleVersion: INDICATORS_VERSION,
    });
    expect(assembly[0]?.limitations.join(' ')).toContain('memory-safe annotation is not evidence');

    const loops = byRule(result.indicators, 'loops');
    // Two owners: the initialize callable (Yul for) and the run callable (three Solidity loops).
    expect(loops).toHaveLength(2);
    expect(loops.map((row) => row.evidence.length).sort((a, b) => a - b)).toEqual([1, 3]);

    const storage = byRule(result.indicators, 'complex-storage-syntax');
    expect(storage).toHaveLength(1);
    expect(storage[0]?.evidence).toHaveLength(2);
    expect(evidenceStarts(storage[0])).toContain(mapping.range.startByte);
    expect(result.complete).toBe(true);
  });

  it('reports no occurrence rows for absent patterns and keeps decoys quiet', () => {
    const file = new FileBuilder(
      'src/Quiet.sol',
      'contract Oracle { function hash() {} function Math() {} } end Oracle',
    );
    const contract = file.contract('Oracle');
    file.callable(contract, 'function', 'hash', 'function hash', '{}');
    const result = classifyIndicators(input([file]));
    expect(occurrenceRows(result.indicators)).toEqual([]);
    expect(result.indicators).toHaveLength(HUMAN_PROMPTS.length);
  });

  it('fires name-based rules at low confidence on exact names only, including decoys', () => {
    const text = [
      'contract Names {',
      '  function initialize() {} function Initialize() {} function initializer() {}',
      '  function upgradeTo() {} function upgradeToAndCall() {} function reinitialize() {}',
      '  function upgrade() {}',
      '  function a() onlyOwner {} function b() Ownable.onlyOwner {} function c() onlyRole(X) {}',
      '  function d() AuthLib.requiresAuth {} function e() onlyOwnerish {} function f() OnlyOwner {}',
      '  function g() owner {}',
      '} end Names',
    ].join('\n');
    const file = new FileBuilder('src/Names.sol', text);
    const contract = file.contract('Names');
    const callables: Record<string, ParserDeclaration> = {};
    for (const name of [
      'initialize',
      'Initialize',
      'initializer',
      'upgradeTo',
      'upgradeToAndCall',
      'reinitialize',
      'upgrade',
    ]) {
      callables[name] = file.callable(contract, 'function', name, `function ${name}(`, '{}');
    }
    const owners = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) =>
      file.callable(contract, 'function', name, `function ${name}()`, '{}'),
    );
    const invocation = (owner: ParserDeclaration, needle: string, name: string): void => {
      file.event('modifier-invocation', needle, { callable: owner }, { name });
    };
    invocation(owners[0] as ParserDeclaration, 'onlyOwner {}', 'onlyOwner');
    invocation(owners[1] as ParserDeclaration, 'Ownable.onlyOwner', 'Ownable.onlyOwner');
    invocation(owners[2] as ParserDeclaration, 'onlyRole(X)', 'onlyRole');
    invocation(owners[3] as ParserDeclaration, 'AuthLib.requiresAuth', 'AuthLib.requiresAuth');
    invocation(owners[4] as ParserDeclaration, 'onlyOwnerish', 'onlyOwnerish');
    invocation(owners[5] as ParserDeclaration, 'OnlyOwner {}', 'OnlyOwner');
    invocation(owners[6] as ParserDeclaration, 'owner {}', 'owner');

    const result = classifyIndicators(input([file]));
    const upgrade = byRule(result.indicators, 'upgrade-name-candidate');
    expect(upgrade).toHaveLength(4);
    for (const row of upgrade) {
      expect(row).toMatchObject({
        category: 'boundary',
        evidenceKind: 'heuristic',
        confidence: 'low',
        requiresAssessment: true,
      });
    }
    const privilege = byRule(result.indicators, 'privilege-name-candidate');
    expect(privilege).toHaveLength(4);
    for (const row of privilege) {
      expect(row).toMatchObject({
        evidenceKind: 'heuristic',
        confidence: 'low',
        category: 'control',
      });
    }
    expect(Object.keys(callables)).toHaveLength(7);
  });

  it('supplements name evidence from the same contract without raising confidence', () => {
    const { file, contract, initialize, pull } = sampleFile();
    const baseId = edgeIdentity(file.path, 'inheritance', 5, 0);
    const baseEvidence: EvidenceRef = { fileId: file.fileId, range: file.at('Base') };
    const edge: DirectBaseEdge = {
      id: baseId,
      contractId: contract.contractId as ContractId,
      ordinal: 0,
      resolution: 'resolved-unique',
      baseContractId: contractIdentity('src/Base.sol', 'contract', 0),
      candidateContractIds: [],
      evidence: [baseEvidence],
    };
    const delegate = site(file, 'target.delegatecall(data)', {
      ownerCallableId: pull.callableId as CallableId,
      ownerContractId: contract.contractId as ContractId,
      syntax: { calleeShape: 'member', memberName: 'delegatecall', lowLevelCandidate: true },
      builtin: 'confirmed',
    });
    file.event(
      'modifier-invocation',
      'onlyOwner {',
      { callable: initialize },
      { name: 'onlyOwner' },
    );
    const result = classifyIndicators(
      input([file], { callSites: [delegate], directBaseEdges: [edge] }),
    );
    const upgrade = byRule(result.indicators, 'upgrade-name-candidate');
    expect(upgrade).toHaveLength(1);
    expect(upgrade[0]).toMatchObject({ confidence: 'low', evidenceKind: 'heuristic' });
    expect(upgrade[0]?.evidence.length).toBe(3);
    expect(upgrade[0]?.limitations.join(' ')).toContain('not as proof of proxy semantics');
    const privilege = byRule(result.indicators, 'privilege-name-candidate');
    expect(privilege[0]?.evidence).toHaveLength(2);
    expect(privilege[0]?.confidence).toBe('low');
    expect(privilege[0]?.limitations.join(' ')).toContain('effect is not assessed');
  });

  it('confirms only built-in low-level calls and keeps rejected and unknown candidates apart', () => {
    const { file, contract, pull } = sampleFile();
    const owner = {
      ownerCallableId: pull.callableId as CallableId,
      ownerContractId: contract.contractId as ContractId,
    };
    const low = (needle: string, member: string, builtin: CallSiteFact['builtin']) =>
      site(file, needle, {
        ...owner,
        syntax: { calleeShape: 'member', memberName: member, lowLevelCandidate: true },
        builtin,
      });
    const result = classifyIndicators(
      input([file], {
        callSites: [
          low('target.delegatecall(data)', 'delegatecall', 'confirmed'),
          low('token.transfer(a, b)', 'transfer', 'rejected'),
          site(file, 'run()', { ...owner, builtin: null }),
        ],
      }),
    );
    const builtin = byRule(result.indicators, 'builtin-low-level');
    expect(builtin).toHaveLength(1);
    expect(builtin[0]?.evidence).toHaveLength(1);
    expect(builtin[0]?.limitations.join(' ')).toContain('not exhaustive');
    expect(byRule(result.indicators, 'file-evidence-incomplete')).toHaveLength(0);

    const unknown = classifyIndicators(
      input([file], {
        callSites: [low('token.transfer(a, b)', 'transfer', 'unknown')],
        confirmed: [
          {
            fileId: file.fileId,
            confirmedBuiltinLowLevelCalls: { status: 'unavailable', reason: 'semantics-failed' },
          },
        ],
      }),
    );
    expect(byRule(unknown.indicators, 'builtin-low-level')).toHaveLength(0);
    const uncertainty = byRule(unknown.indicators, 'file-evidence-incomplete');
    expect(uncertainty).toHaveLength(1);
    expect(uncertainty[0]).toMatchObject({
      evidenceKind: 'human',
      confidence: 'not-assessed',
      requiresAssessment: true,
      category: 'uncertainty',
    });
    expect(uncertainty[0]?.evidence).toHaveLength(1);
    expect(uncertainty[0]?.limitations.join(' ')).toContain('could not be classified');
    expect(uncertainty[0]?.limitations.join(' ')).toContain('total is unavailable');
  });

  it('keeps positive confirmed evidence when the per-file total is unavailable', () => {
    const { file, contract, pull } = sampleFile();
    const confirmed = site(file, 'target.delegatecall(data)', {
      ownerCallableId: pull.callableId as CallableId,
      ownerContractId: contract.contractId as ContractId,
      syntax: { calleeShape: 'member', memberName: 'delegatecall', lowLevelCandidate: true },
      builtin: 'confirmed',
    });
    const result = classifyIndicators(
      input([file], {
        callSites: [confirmed],
        confirmed: [
          {
            fileId: file.fileId,
            confirmedBuiltinLowLevelCalls: { status: 'unavailable', reason: 'x' },
          },
        ],
      }),
    );
    expect(byRule(result.indicators, 'builtin-low-level')).toHaveLength(1);
    expect(byRule(result.indicators, 'file-evidence-incomplete')).toHaveLength(1);
  });

  it('flags a member call to another contract only with unique symbol and dynamic dispatch', () => {
    const text = [
      'contract Caller {',
      '  function go() { remote.ping(); lib.pure(); self.ping(); this.ping(); same.ping(); }',
      '  function ping() {}',
      '} end Caller',
      'interface IRemote { function ping(); } end IRemote',
      'library Lib { function pure() {} } end Lib',
      'function freeFn() {}',
    ].join('\n');
    const file = new FileBuilder('src/Caller.sol', text);
    const caller = file.contract('Caller');
    const go = file.callable(caller, 'function', 'go', 'function go', 'same.ping(); }');
    const ping = file.callable(caller, 'function', 'ping', 'function ping() {}', '{}');
    const remote = file.contract('IRemote', 'interface');
    const remotePing = file.callable(remote, 'function', 'ping', 'function ping();', 'ping();');
    const lib = file.contract('Lib', 'library');
    const libPure = file.callable(lib, 'function', 'pure', 'function pure', '{}');
    const free = file.callable(null, 'function', 'freeFn', 'function freeFn', '{}');
    const owner = {
      ownerCallableId: go.callableId as CallableId,
      ownerContractId: caller.contractId as ContractId,
    };
    const unique = (
      needle: string,
      target: ParserDeclaration,
      extra: Partial<CallSiteFact> & { readonly nth?: number } = {},
    ) =>
      site(file, needle, {
        ...owner,
        symbol: 'unique',
        symbolTarget: target.callableId as CallableId,
        dispatch: 'dynamic',
        receiver: { kind: 'identifier', definitions: [] },
        ...extra,
      });
    const result = classifyIndicators(
      input([file], {
        callSites: [
          unique('remote.ping()', remotePing),
          unique('lib.pure()', libPure),
          unique('self.ping()', free),
          unique('this.ping()', remotePing, { receiver: { kind: 'this', definitions: [] } }),
          unique('same.ping()', ping),
          // Same target but static dispatch, candidate symbols and identifier-only calls never fire.
          unique('remote.ping()', remotePing, { dispatch: 'static' }),
          unique('remote.ping()', remotePing, { symbol: 'candidates' }),
          unique('remote.ping()', remotePing, {
            syntax: { calleeShape: 'identifier', memberName: null, lowLevelCandidate: false },
          }),
        ].map((item, index) => ({
          ...item,
          id: edgeIdentity(file.path, 'call', index, 0) as EdgeId,
        })),
      }),
    );
    const boundary = byRule(result.indicators, 'external-boundary-candidate');
    expect(boundary).toHaveLength(1);
    expect(boundary[0]).toMatchObject({
      evidenceKind: 'heuristic',
      confidence: 'medium',
      category: 'boundary',
      requiresAssessment: true,
    });
    expect(boundary[0]?.evidence.length).toBeGreaterThanOrEqual(1);
    expect(boundary[0]?.limitations.join(' ')).toContain('runtime target address');
  });

  it('reports unresolved and ambiguous imports, never resolved ones', () => {
    const file = new FileBuilder('src/Importer.sol', 'import "./a"; import "./b"; import "./c";');
    const reference = (needle: string, status: ImportReference['status']): ImportReference => {
      const where = file.at(needle);
      const base = {
        id: edgeIdentity(file.path, 'import', where.startByte, 0),
        importerFileId: file.fileId,
        specifier: needle,
        range: where,
        candidateFileIds: [],
      };
      return status === 'resolved'
        ? { ...base, status, targetFileId: fileIdentity('src/a.sol') }
        : { ...base, status, targetFileId: null };
    };
    const result = classifyIndicators(
      input([file], {
        imports: [
          reference('import "./a";', 'unresolved'),
          reference('import "./b";', 'ambiguous'),
          reference('import "./c";', 'resolved'),
        ],
      }),
    );
    const rows = byRule(result.indicators, 'unresolved-import');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.evidence).toHaveLength(2);
    expect(rows[0]).toMatchObject({ category: 'uncertainty', confidence: 'high' });
  });
});

describe('unavailable evidence stays explicit', () => {
  it('turns failed syntax into an unassessed row without evidence and no measured absence', () => {
    const failed = new FileBuilder('src/Broken.sol', 'broken');
    failed.failed = 'PARSE_INVALID';
    const result = classifyIndicators(input([failed]));
    expect(occurrenceRows(result.indicators)).toHaveLength(1);
    const row = byRule(result.indicators, 'file-evidence-incomplete')[0];
    expect(row).toMatchObject({
      evidenceKind: 'human',
      confidence: 'not-assessed',
      requiresAssessment: true,
      evidence: [],
    });
    expect(result.limitations.join(' ')).toContain('not measured absence');
  });

  it('keeps mapping observations beside unresolved user-defined mutable storage', () => {
    const { file, contract } = sampleFile();
    file.event(
      'state-variable',
      'mapping(address => uint) balances',
      { contract },
      { 'type-shape': 'mapping', constant: false, immutable: false, transient: false },
    );
    const custom = file.event(
      'state-variable',
      'Custom stored',
      { contract },
      { 'type-shape': 'user-defined', constant: false, immutable: false, transient: false },
    );
    file.event(
      'state-variable',
      'uint constant LIMIT',
      { contract },
      { 'type-shape': 'user-defined', constant: true, immutable: false, transient: false },
    );
    const result = classifyIndicators(input([file]));
    expect(byRule(result.indicators, 'complex-storage-syntax')).toHaveLength(1);
    const uncertainty = byRule(result.indicators, 'file-evidence-incomplete');
    expect(uncertainty).toHaveLength(1);
    expect(evidenceStarts(uncertainty[0])).toEqual([custom.range.startByte]);
    expect(uncertainty[0]?.limitations.join(' ')).toContain('user-defined or unknown types');
  });

  it('maps an unavailable component member to its file even without call sites', () => {
    const included = new FileBuilder('src/A.sol', 'contract A {}');
    const context = new FileBuilder('lib/B.sol', 'contract B {}', 'context');
    const excluded = new FileBuilder('src/C.sol', 'contract C {}', 'excluded');
    const component: ComponentObservation = {
      id: included.fileId,
      members: [included.fileId, context.fileId, excluded.fileId, fileIdentity('missing/D.sol')],
      grammar: null,
      status: 'unavailable',
      reason: 'no-common-grammar',
    };
    const result = classifyIndicators(
      input([included, context, excluded], { components: [component] }),
    );
    const rows = byRule(result.indicators, 'file-evidence-incomplete');
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.limitations.join(' ').includes('no installed grammar'))).toBe(
      true,
    );
    const labels = rows.map((row) => row.summary);
    expect(labels.some((label) => label.includes('scoped file'))).toBe(true);
    expect(labels.some((label) => label.includes('context file'))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('missing/D.sol');
  });

  it('excludes excluded files and labels context observations', () => {
    const scoped = sampleFile('scoped', 'src/Vault.sol');
    const context = sampleFile('context', 'lib/Vault.sol');
    const excluded = sampleFile('excluded', 'out/Vault.sol');
    for (const item of [scoped, context, excluded]) {
      item.file.event(
        'assembly',
        'assembly {',
        { callable: item.initialize },
        { 'memory-safe': false },
      );
    }
    const result = classifyIndicators(input([scoped.file, context.file, excluded.file]));
    const rows = byRule(result.indicators, 'assembly');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.evidence[0]?.fileId ?? '').sort(ascending)).toEqual(
      [scoped.file.fileId, context.file.fileId].sort(ascending),
    );
    const contextRow = rows.find((row) => row.evidence[0]?.fileId === context.file.fileId);
    expect(contextRow?.summary).toContain('context file');
    expect(contextRow?.limitations.join(' ')).toContain('does not change the scoped review size');
  });

  it('copies required-analysis flags unchanged', () => {
    const file = new FileBuilder('src/A.sol', 'contract A {}');
    const flags = classifyIndicators(
      input([file], { requiredAnalysisComplete: false, hasUnknownSemantics: true }),
    );
    expect(flags).toMatchObject({ requiredAnalysisComplete: false, hasUnknownSemantics: true });
    const clean = classifyIndicators(input([file]));
    expect(clean).toMatchObject({ requiredAnalysisComplete: true, hasUnknownSemantics: false });
  });
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

describe('classification and prompts', () => {
  it('always emits eight unanswered prompts with the documented categories', () => {
    const prompts = buildHumanPrompts();
    expect(prompts.map((item) => item.summary)).toHaveLength(8);
    expect(HUMAN_PROMPTS.map((item) => [item.key, item.category])).toEqual([
      ['business-invariants', 'uncertainty'],
      ['protocol-novelty', 'uncertainty'],
      ['external-trust', 'boundary'],
      ['custom-math-cryptography', 'evm'],
      ['documentation', 'uncertainty'],
      ['upgrade-lifecycle', 'boundary'],
      ['cross-chain', 'boundary'],
      ['review-depth', 'uncertainty'],
    ]);
    const empty = classifyIndicators(input([]));
    expect(empty.indicators).toHaveLength(8);
    for (const prompt of empty.indicators) {
      expect(IndicatorSchema.parse(prompt)).toBeDefined();
      expect(prompt).toMatchObject({
        evidenceKind: 'human',
        confidence: 'not-assessed',
        requiresAssessment: true,
      });
    }
    expect(new Set(empty.indicators.map((item) => item.id)).size).toBe(8);
  });

  it('attaches related evidence to prompts without answering them', () => {
    const { file, initialize } = sampleFile();
    file.event('assembly', 'assembly {', { callable: initialize }, { 'memory-safe': false });
    const result = classifyIndicators(input([file]));
    const math = result.indicators.find((item) => item.summary === HUMAN_PROMPTS[3]?.summary);
    expect(math?.evidence).toHaveLength(1);
    expect(math).toMatchObject({ confidence: 'not-assessed', requiresAssessment: true });
  });

  it('validates every row, keeps IDs bounded for long file IDs and is deterministic', () => {
    const longDirectory = 'd'.repeat(4000);
    const long = sampleFile('scoped', `${longDirectory}/Vault.sol`);
    long.file.event(
      'assembly',
      'assembly {',
      { callable: long.initialize },
      { 'memory-safe': false },
    );
    long.file.event('control', 'for (;;)', { callable: long.run }, { 'control-kind': 'for' });
    long.file.event(
      'modifier-invocation',
      'onlyOwner {',
      { callable: long.initialize },
      { name: 'onlyOwner' },
    );
    const other = sampleFile('context', 'lib/Other.sol');
    other.file.event(
      'assembly',
      'assembly {',
      { callable: other.initialize },
      { 'memory-safe': true },
    );
    const failed = new FileBuilder('src/Failed.sol', 'x');
    failed.failed = 'LIMIT_EXCEEDED';

    const base = input([long.file, other.file, failed]);
    const frozen = deepFreeze(structuredClone(base));
    const result = classifyIndicators(frozen);
    expect(result.complete).toBe(true);
    const ids = result.indicators.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of result.indicators) {
      expect(row.id.length).toBeLessThanOrEqual(512);
      expect(row.summary.length).toBeLessThanOrEqual(512);
      expect(IndicatorSchema.parse(row)).toBeDefined();
      expect(row.ruleVersion).toBe('1.0.0');
    }
    expect(ids).toEqual([...ids].sort());

    const shuffled: IndicatorInput = {
      ...base,
      manifest: { ...base.manifest, entries: [...base.manifest.entries].reverse() },
      syntax: {
        ...base.syntax,
        files: [...base.syntax.files]
          .reverse()
          .map((item) =>
            item.status === 'parsed' ? { ...item, events: [...item.events].reverse() } : item,
          ),
      },
      metrics: [...base.metrics].reverse(),
    };
    expect(classifyIndicators(shuffled)).toEqual(result);
  });

  it('deduplicates identical evidence and sorts it by file and range', () => {
    const { file, initialize, run } = sampleFile();
    file.event('assembly', 'assembly {', { callable: initialize }, { 'memory-safe': false });
    file.event('assembly', 'assembly {', { callable: initialize }, { 'memory-safe': true });
    file.event('control', 'while (x)', { callable: run }, { 'control-kind': 'while' });
    file.event('control', 'for (;;)', { callable: run }, { 'control-kind': 'for' });
    file.event('control', 'while (x)', { callable: run }, { 'control-kind': 'while' });
    const result = classifyIndicators(input([file]));
    expect(byRule(result.indicators, 'assembly')[0]?.evidence).toHaveLength(1);
    const starts = evidenceStarts(byRule(result.indicators, 'loops')[0]);
    expect(starts).toHaveLength(2);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('bounds evidence at 10,000 references and reports incomplete classification', () => {
    const body = 'x'.repeat(10_100);
    const big = new FileBuilder(
      'src/Big2.sol',
      `contract Big { function f() { ${body} } } end Big`,
    );
    const bigContract = big.contract('Big');
    const bigCallable = big.callable(bigContract, 'function', 'f', 'function f', '} }');
    for (let index = 0; index < 10_001; index += 1) {
      big.eventAt('assembly', range(40 + index, 41 + index), { callable: bigCallable });
    }
    const result = classifyIndicators(input([big]));
    const row = byRule(result.indicators, 'assembly')[0];
    expect(row?.evidence).toHaveLength(10_000);
    expect(row?.limitations.join(' ')).toContain('truncated');
    expect(result.complete).toBe(false);
    // One diagnostic for the row and one for the prompt that mirrors the same evidence.
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'LIMIT_EXCEEDED', phase: 'metrics' }),
      expect.objectContaining({ code: 'LIMIT_EXCEEDED', phase: 'metrics' }),
    ]);
    expect(IndicatorSchema.parse(row)).toBeDefined();
    const message = JSON.stringify(result.diagnostics);
    expect(message).not.toContain('src/Big2.sol');
    // The rest of the output survives: all eight prompts are still present.
    expect(
      result.indicators.filter((item) => item.id.startsWith('indicator:prompt:')),
    ).toHaveLength(8);
  });

  it('truncates rows at the bound while reserving room for every prompt', () => {
    const files = Array.from({ length: 5 }, (_unused, index) => {
      const item = sampleFile('scoped', `src/V${index}.sol`);
      item.file.event(
        'assembly',
        'assembly {',
        { callable: item.initialize },
        { 'memory-safe': false },
      );
      return item.file;
    });
    const result = classifyIndicators({ ...input(files), bounds: { maxRows: 10 } });
    expect(result.indicators).toHaveLength(10);
    expect(byRule(result.indicators, 'assembly')).toHaveLength(2);
    expect(result.complete).toBe(false);
    expect(result.limitations.join(' ')).toContain('not exhaustive');
    expect(result.diagnostics[0]).toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('rejects contradictory duplicate records and tolerates identical ones', () => {
    const file = new FileBuilder('src/A.sol', 'contract A {} end A');
    const base = input([file]);
    const duplicate = (changed: boolean): IndicatorInput => ({
      ...base,
      manifest: {
        ...base.manifest,
        entries: [
          ...base.manifest.entries,
          changed ? { ...file.entry(), role: 'context' } : file.entry(),
        ],
      },
    });
    expect(() => classifyIndicators(duplicate(true))).toThrow(TypeError);
    expect(() => classifyIndicators(duplicate(false))).not.toThrow();
  });
});

describe('module boundaries', () => {
  it('keeps pure modules free of parser runtime, filesystem and readiness imports', () => {
    const allowed = new Set([
      '../domain/canonical.ts',
      '../domain/versions.ts',
      '../metrics/definitions.ts',
      './catalog.ts',
      './human-prompts.ts',
    ]);
    for (const name of ['catalog', 'classify', 'human-prompts']) {
      const source = readFileSync(
        new URL(`../../src/indicators/${name}.ts`, import.meta.url),
        'utf8',
      );
      const imports = [...source.matchAll(/^import (type )?[^;]*? from '([^']+)';/gmu)];
      expect(imports.length).toBeGreaterThan(0);
      for (const match of imports) {
        const specifier = match[2] ?? '';
        expect(match[1] !== undefined || allowed.has(specifier)).toBe(true);
        expect(specifier.startsWith('node:')).toBe(false);
        expect(specifier).not.toMatch(/readiness|lcov|adapter|worker|discovery/u);
      }
    }
  });

  it('produces no estimate or adjustment fields', () => {
    const result = classifyIndicators(input([]));
    expect(Object.keys(result).sort()).toEqual([
      'complete',
      'diagnostics',
      'hasUnknownSemantics',
      'indicators',
      'limitations',
      'requiredAnalysisComplete',
    ]);
  });
});
