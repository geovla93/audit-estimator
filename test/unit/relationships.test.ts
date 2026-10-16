import { describe, expect, it } from 'vitest';
import {
  callableIdentity,
  contractIdentity,
  edgeIdentity,
  fileIdentity,
} from '../../src/domain/canonical.ts';
import { RelationshipResultSchema } from '../../src/domain/schemas.ts';
import type {
  CallableId,
  ContractId,
  EdgeId,
  EvidenceRef,
  FileId,
  Measurement,
  Remapping,
  RelationshipResult,
  SourceRange,
} from '../../src/domain/types.ts';
import type {
  ParseFileResult,
  ParserDeclaration,
  ParserEvent,
  SemanticCallSite,
  SemanticDefinition,
} from '../../src/parser/protocol.ts';
import { buildCallFacts, countConfirmedBuiltins } from '../../src/relationships/calls.ts';
import type { CallFileInput } from '../../src/relationships/calls.ts';
import {
  compareCodePoints,
  derivePairs,
  GraphAllowance,
  MAX_EDGE_FANOUT,
  MAX_IDENTIFIER_CODE_UNITS,
  MAX_PUBLIC_ROWS,
  relationshipFingerprint,
  rowFits,
  summarizeCompleteness,
} from '../../src/relationships/graph.ts';
import type {
  FingerprintParts,
  PairClaim,
  PairEligibility,
} from '../../src/relationships/graph.ts';
import { buildInheritance } from '../../src/relationships/inheritance.ts';
import type { BaseSiteFact, InheritanceContract } from '../../src/relationships/inheritance.ts';
import type { PairKind } from '../../src/relationships/types.ts';
import { planComponents } from '../../src/relationships/components.ts';
import type { ComponentFileInput, ComponentPlanInput } from '../../src/relationships/components.ts';
import type { ImportObservation } from '../../src/relationships/types.ts';
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

describe('relationship ID ordering', () => {
  it('orders prefixes, astral scalars and unpaired surrogates by code point', () => {
    const ordered = [
      '',
      'a',
      'a\ud800',
      'a\udfff',
      'a\ue000',
      'a\u{10000}',
      'a\u{10000}a',
      'a\u{1f600}',
      'b',
    ];
    for (const [leftIndex, left] of ordered.entries()) {
      for (const [rightIndex, right] of ordered.entries()) {
        expect(compareCodePoints(left, right)).toBe(Math.sign(leftIndex - rightIndex));
      }
    }
  });
});

function ascending(left: unknown, right: unknown): number {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

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

const zeroRange: SourceRange = {
  startByte: 0,
  endByte: 1,
  start: { line: 1, column: 1 },
  end: { line: 1, column: 2 },
};

function fid(path: string): FileId {
  return fileIdentity(path);
}

function parsedFile(path: string, compatible: readonly string[], bytes = 10): ComponentFileInput {
  const fileId = fid(path);
  const result: ParseFileResult = {
    status: 'parsed',
    fileId,
    version: {
      selectedVersion: compatible[compatible.length - 1] ?? '0.8.37',
      selectionSource: 'inferred',
      ignoredHint: 'not-applicable',
      compatibleVersions: [...compatible],
      installedVersions: ['0.7.6', '0.8.4', '0.8.28', '0.8.37'],
      pragmaRanges: [],
      parserVersion: '1.3.9',
    },
    tokens: [],
    declarations: [],
    imports: [],
    events: [],
    diagnostics: [],
    visitedNodes: 0,
  };
  return { fileId, syntax: result, byteLength: bytes };
}

function failedFile(path: string): ComponentFileInput {
  const fileId = fid(path);
  return {
    fileId,
    syntax: { status: 'failed', fileId, code: 'PARSE_INVALID', diagnostics: [] },
    byteLength: 10,
  };
}

function edge(
  from: string,
  to: string | null,
  status: ImportObservation['status'] = 'resolved',
): ImportObservation {
  return {
    importId: `decl:${from}:import:0:0` as EdgeId,
    importerFileId: fid(from),
    specifier: './x.sol',
    range: zeroRange,
    specifierRange: zeroRange,
    lookupName: null,
    strategy: null,
    remapping: null,
    conflictingRemappings: [],
    probes: [],
    candidateFileIds: [],
    status,
    targetFileId: to === null ? null : fid(to),
    reason: null,
  };
}

const ALL_VERSIONS = ['0.7.6', '0.8.4', '0.8.28', '0.8.37'] as const;

function plan(
  files: readonly ComponentFileInput[],
  observations: readonly ImportObservation[],
  overrides: Partial<ComponentPlanInput> = {},
): ReturnType<typeof planComponents> {
  return planComponents({
    files,
    observations,
    authority: { source: 'default', version: '0.8.28' },
    scopedFileIds: new Set(files.map((file) => file.fileId)),
    maxFiles: 128,
    maxBytes: 8 * 1024 * 1024,
    ...overrides,
  });
}

describe('semantic components', () => {
  it('partitions import connectivity as an undirected graph and keeps isolated files', () => {
    const files = ['c.sol', 'a.sol', 'b.sol', 'd.sol', 'e.sol'].map((path) =>
      parsedFile(path, ['0.8.28', '0.8.37']),
    );
    const plans = plan(files, [edge('b.sol', 'a.sol'), edge('c.sol', 'b.sol')]);
    expect(plans.map((item) => [item.id, item.members])).toEqual([
      [fid('a.sol'), [fid('a.sol'), fid('b.sol'), fid('c.sol')]],
      [fid('d.sol'), [fid('d.sol')]],
      [fid('e.sol'), [fid('e.sol')]],
    ]);
    expect(plans.every((item) => item.status === 'available' && item.grammar === '0.8.37')).toBe(
      true,
    );
    // Direction does not matter and the result is independent of input order.
    const reversed = plan([...files].reverse(), [edge('a.sol', 'b.sol'), edge('b.sol', 'c.sol')]);
    expect(reversed.map((item) => item.members)).toEqual(plans.map((item) => item.members));
  });

  it('selects the highest common installed grammar over overlapping and disjoint members', () => {
    const overlapping = plan(
      [
        parsedFile('a.sol', ['0.8.4', '0.8.28', '0.8.37']),
        parsedFile('b.sol', ['0.7.6', '0.8.4', '0.8.28']),
      ],
      [edge('a.sol', 'b.sol')],
    );
    expect(overlapping).toMatchObject([{ status: 'available', grammar: '0.8.28' }]);
    const disjoint = plan(
      [parsedFile('a.sol', ['0.8.37']), parsedFile('b.sol', ['0.7.6'])],
      [edge('a.sol', 'b.sol')],
    );
    expect(disjoint).toMatchObject([
      { status: 'unavailable', grammar: null, reason: 'no-common-grammar' },
    ]);
    // Disjoint files in separate components are bound independently.
    const separate = plan([parsedFile('a.sol', ['0.8.37']), parsedFile('b.sol', ['0.7.6'])], []);
    expect(separate.map((item) => item.grammar)).toEqual(['0.8.37', '0.7.6']);
  });

  it('honors an exact cli or config version as an additional constraint only', () => {
    const files = [parsedFile('a.sol', ALL_VERSIONS), parsedFile('b.sol', ALL_VERSIONS)];
    const edges = [edge('a.sol', 'b.sol')];
    expect(plan(files, edges, { authority: { source: 'config', version: '0.8.4' } })).toMatchObject(
      [{ status: 'available', grammar: '0.8.4' }],
    );
    expect(plan(files, edges, { authority: { source: 'cli', version: '0.8.28' } })).toMatchObject([
      { grammar: '0.8.28' },
    ]);
    const narrowed = [parsedFile('a.sol', ['0.8.28', '0.8.37']), parsedFile('b.sol', ALL_VERSIONS)];
    expect(plan(narrowed, edges, { authority: { source: 'cli', version: '0.7.6' } })).toMatchObject(
      [{ status: 'unavailable', reason: 'authority-excludes-grammar' }],
    );
    // Foundry/default hints never constrain the common grammar.
    for (const source of ['metadata', 'default'] as const) {
      expect(plan(files, edges, { authority: { source, version: '0.7.6' } })).toMatchObject([
        { status: 'available', grammar: '0.8.37' },
      ]);
    }
  });

  it('is unavailable for failed syntax, unresolved imports or oversized components', () => {
    expect(
      plan([parsedFile('a.sol', ALL_VERSIONS), failedFile('b.sol')], [edge('a.sol', 'b.sol')]),
    ).toMatchObject([{ status: 'unavailable', reason: 'member-syntax-failed' }]);
    for (const status of ['unresolved', 'ambiguous'] as const) {
      expect(
        plan([parsedFile('a.sol', ALL_VERSIONS)], [edge('a.sol', null, status)]),
      ).toMatchObject([{ status: 'unavailable', reason: 'unresolved-import' }]);
    }
    const trio = ['a.sol', 'b.sol', 'c.sol'].map((path) => parsedFile(path, ALL_VERSIONS, 100));
    const chain = [edge('a.sol', 'b.sol'), edge('b.sol', 'c.sol')];
    expect(plan(trio, chain, { maxFiles: 3, maxBytes: 300 })).toMatchObject([
      { status: 'available', totalBytes: 300 },
    ]);
    expect(plan(trio, chain, { maxFiles: 2, maxBytes: 300 })).toMatchObject([
      { status: 'unavailable', reason: 'component-too-large' },
    ]);
    expect(plan(trio, chain, { maxFiles: 3, maxBytes: 299 })).toMatchObject([
      { status: 'unavailable', reason: 'component-too-large' },
    ]);
  });

  it('skips components without a scoped member', () => {
    const files = [parsedFile('a.sol', ALL_VERSIONS), parsedFile('b.sol', ALL_VERSIONS)];
    expect(plan(files, [], { scopedFileIds: new Set([fid('a.sol')]) })).toMatchObject([
      { id: fid('a.sol'), status: 'available' },
      { id: fid('b.sol'), status: 'unavailable', reason: 'no-scoped-member' },
    ]);
  });
});

function cid(path: string, start: number, kind = 'contract'): ContractId {
  return contractIdentity(path, kind, start);
}

function callable(path: string, start: number, kind = 'function'): CallableId {
  return callableIdentity(path, kind, start);
}

function ev(path: string, start: number, end = start + 1): EvidenceRef {
  return {
    fileId: fid(path),
    range: {
      startByte: start,
      endByte: end,
      start: { line: 1, column: start + 1 },
      end: { line: 1, column: end + 1 },
    },
  };
}

function contractNode(
  path: string,
  start: number,
  callableIds: readonly CallableId[] = [],
  semantics: 'bound' | 'unavailable' = 'bound',
): InheritanceContract {
  return { id: cid(path, start), fileId: fid(path), callableIds, semantics };
}

function baseSite(
  owner: ContractId,
  ordinal: number,
  candidates: readonly (ContractId | null)[],
  path = 'A.sol',
): BaseSiteFact {
  const start = 1000 + ordinal;
  return {
    contractId: owner,
    ordinal,
    edgeId: edgeIdentity(path, 'inheritance', Number(owner.split(':').at(-1)), ordinal),
    evidence: ev(path, start),
    candidates: candidates.map((contractId) => ({ contractId })),
  };
}

function inheritanceOf(result: ReturnType<typeof buildInheritance>, id: ContractId) {
  const found = result.inheritance.find((item) => item.contractId === id);
  if (found === undefined) throw new Error('Missing inheritance record.');
  return found;
}

function measuredValue<T>(measurement: Measurement<T>): T | string {
  return measurement.status === 'measured' ? measurement.value : measurement.reason;
}

describe('inheritance and identity', () => {
  const A = cid('A.sol', 0);
  const B = cid('A.sol', 100);
  const C = cid('A.sol', 200);
  const D = cid('A.sol', 300);
  const callableA1 = callable('A.sol', 10);
  const callableA2 = callable('A.sol', 20);
  const callableB = callable('A.sol', 110);

  function diamond(allowance = new GraphAllowance(1_000)): ReturnType<typeof buildInheritance> {
    return buildInheritance({
      contracts: [
        contractNode('A.sol', 0, [callableA1, callableA2]),
        contractNode('A.sol', 100, [callableB]),
        contractNode('A.sol', 200),
        contractNode('A.sol', 300),
      ],
      sites: [baseSite(B, 0, [A]), baseSite(C, 0, [A]), baseSite(D, 0, [B]), baseSite(D, 1, [C])],
      allowance,
    });
  }

  it('computes exact diamond ancestors, depth and de-duplicated inherited declarations', () => {
    const result = diamond();
    expect(measuredValue(inheritanceOf(result, A).ancestorIds)).toEqual([]);
    expect(measuredValue(inheritanceOf(result, A).maxDepth)).toBe(0);
    expect(measuredValue(inheritanceOf(result, B).ancestorIds)).toEqual([A]);
    expect(measuredValue(inheritanceOf(result, D).ancestorIds)).toEqual([A, B, C].sort(ascending));
    expect(measuredValue(inheritanceOf(result, D).maxDepth)).toBe(2);
    // A is reachable through B and C but its declarations appear once; the list is sorted.
    expect(measuredValue(inheritanceOf(result, D).ancestorDeclaredCallableIds)).toEqual(
      [callableA1, callableA2, callableB].sort(ascending),
    );
    expect(measuredValue(inheritanceOf(result, B).ancestorDeclaredCallableIds)).toEqual([
      callableA1,
      callableA2,
    ]);
    expect(measuredValue(inheritanceOf(result, A).ancestorDeclaredCallableIds)).toEqual([]);
    // Direct edge IDs keep declared order.
    expect(inheritanceOf(result, D).directBaseEdgeIds).toHaveLength(2);
    expect(
      result.edges.filter((edge) => edge.contractId === D).map((edge) => edge.ordinal),
    ).toEqual([0, 1]);
    expect(result.limited).toBe(false);
  });

  it('produces schema-valid direct edges with no target on unresolved or ambiguous edges', () => {
    const result = buildInheritance({
      contracts: [
        contractNode('A.sol', 0),
        contractNode('A.sol', 100),
        contractNode('A.sol', 200),
        contractNode('A.sol', 300),
      ],
      sites: [
        baseSite(B, 0, [A]),
        baseSite(C, 0, [null, A]),
        baseSite(D, 0, []),
        baseSite(D, 1, [null]),
      ],
      allowance: new GraphAllowance(1_000),
    });
    expect(result.graphs).toHaveLength(4);
    for (const row of result.graphs) {
      expect(RelationshipResultSchema.safeParse(row).success).toBe(true);
      expect(row.kind).toBe('inheritance');
      expect('to' in row).toBe(row.resolution === 'resolved-unique');
    }
    const byResolution = result.edges.map((edge) => [edge.contractId, edge.resolution]);
    expect(byResolution).toEqual([
      [B, 'resolved-unique'],
      [C, 'ambiguous'],
      [D, 'unresolved'],
      [D, 'unresolved'],
    ]);
    // An alias candidate set stays ambiguous and exposes the verified candidate only.
    expect(result.edges.find((edge) => edge.contractId === C)?.candidateContractIds).toEqual([A]);
    expect(result.edges.find((edge) => edge.contractId === C)?.baseContractId).toBeNull();
  });

  it('makes unresolved and cyclic reachable bases unavailable while independent subgraphs stay measurable', () => {
    const E = cid('A.sol', 400);
    const F = cid('A.sol', 500);
    const G = cid('A.sol', 600);
    const H = cid('A.sol', 700);
    const result = buildInheritance({
      contracts: [A, B, C, D, E, F, G, H].map((id) =>
        contractNode('A.sol', Number(id.split(':').at(-1))),
      ),
      sites: [
        // A is independent; B has an unresolved base; C inherits B; D and E form a cycle.
        baseSite(B, 0, []),
        baseSite(C, 0, [B]),
        baseSite(D, 0, [E]),
        baseSite(E, 0, [D]),
        baseSite(F, 0, [D]),
        baseSite(G, 0, [G]),
        baseSite(H, 0, [A]),
      ],
      allowance: new GraphAllowance(1_000),
    });
    expect(measuredValue(inheritanceOf(result, A).maxDepth)).toBe(0);
    expect(measuredValue(inheritanceOf(result, H).ancestorIds)).toEqual([A]);
    expect(measuredValue(inheritanceOf(result, B).ancestorIds)).toBe('unresolved-base');
    expect(measuredValue(inheritanceOf(result, C).maxDepth)).toBe('unresolved-base');
    for (const id of [D, E, G]) {
      expect(measuredValue(inheritanceOf(result, id).ancestorIds)).toBe('inheritance-cycle');
    }
    expect(measuredValue(inheritanceOf(result, F).ancestorDeclaredCallableIds)).toBe(
      'inheritance-cycle',
    );
    // Evidence stays on the direct edges even when transitive measurements are unavailable.
    expect(result.edges.filter((edge) => edge.contractId === B)).toHaveLength(1);
  });

  it('keeps contracts with same-named declarations in different files distinct by ID', () => {
    const other = cid('B.sol', 0);
    const result = buildInheritance({
      contracts: [contractNode('A.sol', 0), contractNode('B.sol', 0), contractNode('B.sol', 50)],
      sites: [baseSite(cid('B.sol', 50), 0, [other], 'B.sol')],
      allowance: new GraphAllowance(100),
    });
    expect(measuredValue(inheritanceOf(result, cid('B.sol', 50)).ancestorIds)).toEqual([other]);
    expect(measuredValue(inheritanceOf(result, A).ancestorIds)).toEqual([]);
  });

  it('marks contracts without semantic results unavailable and never invents edges', () => {
    const result = buildInheritance({
      contracts: [contractNode('A.sol', 0, [], 'unavailable'), contractNode('A.sol', 100)],
      sites: [],
      allowance: new GraphAllowance(100),
    });
    expect(result.edges).toEqual([]);
    expect(measuredValue(inheritanceOf(result, A).ancestorIds)).toBe('semantics-unavailable');
    expect(measuredValue(inheritanceOf(result, B).ancestorIds)).toEqual([]);
  });

  it('enforces the graph allowance at exact-bound and one-over without truncating silently', () => {
    const run = (limit: number) =>
      buildInheritance({
        contracts: [contractNode('A.sol', 0, [callableA1, callableA2]), contractNode('A.sol', 100)],
        sites: [baseSite(B, 0, [A])],
        allowance: new GraphAllowance(limit),
      });
    // Edge: 1 + 1 candidate + 1 evidence = 3; ancestors: 1; inherited declarations: 2.
    const exact = run(6);
    expect(exact.limited).toBe(false);
    expect(measuredValue(inheritanceOf(exact, B).ancestorDeclaredCallableIds)).toEqual([
      callableA1,
      callableA2,
    ]);
    const callablesCut = run(5);
    expect(callablesCut.limited).toBe(true);
    expect(measuredValue(inheritanceOf(callablesCut, B).ancestorIds)).toEqual([A]);
    expect(measuredValue(inheritanceOf(callablesCut, B).ancestorDeclaredCallableIds)).toBe(
      'graph-limit',
    );
    const ancestorsCut = run(3);
    expect(measuredValue(inheritanceOf(ancestorsCut, B).ancestorIds)).toBe('graph-limit');
    const edgeCut = run(2);
    expect(edgeCut.edges).toEqual([]);
    expect(edgeCut.limited).toBe(true);
    expect(measuredValue(inheritanceOf(edgeCut, B).maxDepth)).toBe('graph-limit');
    expect(measuredValue(inheritanceOf(edgeCut, A).maxDepth)).toBe(0);
  });

  it('traverses long chains and large diamonds iteratively under a reduced allowance', () => {
    const count = 2_000;
    const ids = Array.from({ length: count }, (_unused, index) => cid('Chain.sol', index * 10));
    const chain = (limit: number) =>
      buildInheritance({
        contracts: ids.map((id) => contractNode('Chain.sol', Number(id.split(':').at(-1)))),
        sites: ids.slice(1).map((id, index) => baseSite(id, 0, [ids[index] ?? null], 'Chain.sol')),
        allowance: new GraphAllowance(limit),
      });
    const roomy = chain(10_000_000);
    expect(roomy.limited).toBe(false);
    const last = ids[count - 1];
    if (last === undefined) throw new Error('Expected a chain.');
    expect(measuredValue(inheritanceOf(roomy, last).maxDepth)).toBe(count - 1);
    const reduced = chain(100_000);
    expect(reduced.limited).toBe(true);
    // Early contracts remain measurable while later ones are explicitly unavailable.
    const first = ids[1];
    if (first === undefined) throw new Error('Expected a chain.');
    expect(measuredValue(inheritanceOf(reduced, first).maxDepth)).toBe(1);
    expect(measuredValue(inheritanceOf(reduced, last).maxDepth)).toBe('graph-limit');
  });
});

const CALL_PATH = 'Calls.sol';

function span(start: number, end: number): SourceRange {
  return {
    startByte: start,
    endByte: end,
    start: { line: 1, column: start + 1 },
    end: { line: 1, column: end + 1 },
  };
}

function declaration(
  kind: string,
  name: string,
  start: number,
  contractId: ContractId | null,
): ParserDeclaration {
  const contractLike = ['contract', 'abstract-contract', 'library', 'interface'].includes(kind);
  const id = contractLike ? cid(CALL_PATH, start, kind) : callable(CALL_PATH, start, kind);
  return {
    id,
    kind,
    name,
    contractId: contractLike ? (id as ContractId) : contractId,
    callableId: contractLike ? null : (id as CallableId),
    declarationRange: span(start, start + 50),
    nameRange: span(start + 5, start + 5 + name.length),
    bodyRange: null,
    hasBody: false,
    attributes: [],
  };
}

function callEvent(
  start: number,
  end: number,
  shape: string,
  memberName: string | null,
  lowLevel: boolean,
  owner: { readonly callableId: CallableId | null; readonly contractId: ContractId | null },
): ParserEvent {
  return {
    fileId: fid(CALL_PATH),
    kind: 'call-site',
    contractId: owner.contractId,
    callableId: owner.callableId,
    range: span(start, end),
    attributes: [
      { key: 'callee-shape', value: shape },
      ...(memberName === null ? [] : [{ key: 'member-name', value: memberName }]),
      { key: 'low-level-candidate', value: lowLevel },
    ],
  };
}

function userDef(target: ParserDeclaration, definiens: string): SemanticDefinition {
  return {
    kind: 'user',
    fileId: fid(CALL_PATH),
    nameRange: target.nameRange,
    definiens,
  };
}

function paramDef(start: number): SemanticDefinition {
  return {
    kind: 'user',
    fileId: fid(CALL_PATH),
    nameRange: span(start, start + 2),
    definiens: 'Parameter',
  };
}

function semanticSite(
  event: ParserEvent,
  callee: SemanticCallSite['callee'],
  definitions: readonly SemanticDefinition[],
  receiver: SemanticCallSite['receiver'] = 'none',
  receiverDefinitions: readonly SemanticDefinition[] = [],
): SemanticCallSite {
  return {
    fileId: fid(CALL_PATH),
    range: event.range,
    callee,
    definitions,
    receiver,
    receiverDefinitions,
  };
}

function callFile(
  declarations: readonly ParserDeclaration[],
  events: readonly ParserEvent[],
  semantics: 'bound' | 'unavailable' = 'bound',
): CallFileInput {
  const fileId = fid(CALL_PATH);
  return {
    fileId,
    canonicalPath: CALL_PATH,
    semantics,
    syntax: {
      status: 'parsed',
      fileId,
      version: {
        selectedVersion: '0.8.37',
        selectionSource: 'inferred',
        ignoredHint: 'not-applicable',
        compatibleVersions: ['0.8.37'],
        installedVersions: ['0.8.37'],
        pragmaRanges: [],
        parserVersion: '1.3.9',
      },
      tokens: [],
      declarations: [...declarations],
      imports: [],
      events: [...events],
      diagnostics: [],
      visitedNodes: 0,
    },
  };
}

describe('calls and pairs', () => {
  const owner = declaration('contract', 'Caller', 0, null);
  const base = declaration('contract', 'Base', 1000, null);
  const library = declaration('library', 'Lib', 2000, null);
  const iface = declaration('interface', 'IRemote', 3000, null);
  const ownerId = owner.contractId as ContractId;
  const libFn = declaration('function', 'twice', 2100, library.contractId);
  const ifaceFn = declaration('function', 'ping', 3100, iface.contractId);
  const baseFn = declaration('function', 'inherited', 1100, base.contractId);
  const freeFn = declaration('free-function', 'freeAdd', 4000, null);
  const callerFn = declaration('function', 'run', 100, ownerId);
  const overloadA = declaration('function', 'over', 200, ownerId);
  const overloadB = declaration('function', 'over', 300, ownerId);
  const customCall = declaration('function', 'call', 2200, library.contractId);
  const all = [
    owner,
    base,
    library,
    iface,
    libFn,
    ifaceFn,
    baseFn,
    freeFn,
    callerFn,
    overloadA,
    overloadB,
    customCall,
  ];
  const inRun = { callableId: callerFn.callableId, contractId: ownerId };

  function facts(
    events: readonly ParserEvent[],
    sites: readonly SemanticCallSite[],
    limit = 100_000,
    semantics: 'bound' | 'unavailable' = 'bound',
  ): ReturnType<typeof buildCallFacts> {
    return buildCallFacts({
      files: [callFile(all, events, semantics)],
      sites,
      allowance: new GraphAllowance(limit),
    });
  }

  it('keeps symbol evidence separate from dispatch and never invents a dynamic target', () => {
    const internal = callEvent(500, 510, 'identifier', null, false, inRun);
    const free = callEvent(520, 530, 'identifier', null, false, inRun);
    const viaLibrary = callEvent(540, 560, 'member', 'twice', false, inRun);
    const viaInterface = callEvent(570, 590, 'member', 'ping', false, inRun);
    const viaThis = callEvent(600, 620, 'member', 'inherited', false, inRun);
    const overloaded = callEvent(630, 640, 'identifier', null, false, inRun);
    const pointer = callEvent(650, 660, 'identifier', null, false, inRun);
    const events = [internal, free, viaLibrary, viaInterface, viaThis, overloaded, pointer];
    const result = facts(events, [
      semanticSite(internal, 'identifier', [userDef(baseFn, 'FunctionDefinition')]),
      semanticSite(free, 'identifier', [userDef(freeFn, 'FreeFunctionDefinition')]),
      semanticSite(viaLibrary, 'member', [userDef(libFn, 'FunctionDefinition')], 'identifier', [
        userDef(library, 'LibraryDefinition'),
      ]),
      semanticSite(viaInterface, 'member', [userDef(ifaceFn, 'FunctionDefinition')], 'identifier', [
        paramDef(10),
      ]),
      semanticSite(viaThis, 'member', [userDef(baseFn, 'FunctionDefinition')], 'this'),
      semanticSite(overloaded, 'identifier', [
        userDef(overloadA, 'FunctionDefinition'),
        userDef(overloadB, 'FunctionDefinition'),
      ]),
      semanticSite(pointer, 'identifier', [paramDef(20)]),
    ]);
    const byStart = (start: number) => {
      const fact = result.facts.find((item) => item.range.startByte === start);
      if (fact === undefined) throw new Error(`No fact at ${start}.`);
      return fact;
    };
    expect(byStart(500)).toMatchObject({
      symbol: 'unique',
      dispatch: 'dynamic',
      symbolTarget: baseFn.callableId,
      limitation: 'virtual-dispatch-unproven',
    });
    expect(byStart(520)).toMatchObject({
      symbol: 'unique',
      dispatch: 'static',
      limitation: 'none',
    });
    expect(byStart(540)).toMatchObject({ symbol: 'unique', dispatch: 'static' });
    expect(byStart(570)).toMatchObject({
      symbol: 'unique',
      dispatch: 'dynamic',
      symbolTarget: ifaceFn.callableId,
      limitation: 'external-receiver-unproven',
    });
    expect(byStart(600)).toMatchObject({
      dispatch: 'dynamic',
      limitation: 'this-or-super-dispatch',
    });
    expect(byStart(630)).toMatchObject({
      symbol: 'candidates',
      dispatch: 'unknown',
      symbolTarget: null,
    });
    expect(byStart(630).candidateTargets).toEqual(
      [overloadA.callableId, overloadB.callableId].sort(ascending),
    );
    expect(byStart(650)).toMatchObject({
      symbol: 'non-callable',
      dispatch: 'unknown',
      limitation: 'function-pointer-or-variable',
    });
    // Public rows: only free/library calls resolve; unique dynamic symbols are unsupported with
    // the candidate retained; overloads are ambiguous; pointers are unsupported with no candidate.
    const rows = new Map(result.graphs.map((row) => [row.id, row]));
    for (const row of result.graphs) {
      expect(RelationshipResultSchema.safeParse(row).success).toBe(true);
      expect('to' in row).toBe(row.resolution === 'resolved-unique');
    }
    expect(rows.get(byStart(520).id)).toMatchObject({
      resolution: 'resolved-unique',
      to: freeFn.callableId,
      from: callerFn.callableId,
    });
    expect(rows.get(byStart(540).id)).toMatchObject({
      resolution: 'resolved-unique',
      to: libFn.callableId,
    });
    expect(rows.get(byStart(500).id)).toMatchObject({
      resolution: 'unsupported',
      candidateTargets: [baseFn.callableId],
    });
    expect(rows.get(byStart(570).id)).toMatchObject({ resolution: 'unsupported' });
    expect(rows.get(byStart(630).id)).toMatchObject({ resolution: 'ambiguous' });
    expect(rows.get(byStart(650).id)).toMatchObject({
      resolution: 'unsupported',
      candidateTargets: [],
    });
    expect(result.limited).toBe(false);
  });

  it('gives repeated sites and nested calls distinct ordered IDs and retains all evidence', () => {
    const outer = callEvent(500, 520, 'identifier', null, false, inRun);
    const inner = callEvent(500, 510, 'identifier', null, false, inRun);
    const again = callEvent(700, 710, 'identifier', null, false, inRun);
    const def = [userDef(baseFn, 'FunctionDefinition')];
    const result = facts(
      [again, outer, inner],
      [
        semanticSite(outer, 'identifier', def),
        semanticSite(inner, 'identifier', def),
        semanticSite(again, 'identifier', def),
      ],
    );
    expect(result.facts.map((fact) => fact.id)).toEqual([
      edgeIdentity(CALL_PATH, 'call', 500, 0),
      edgeIdentity(CALL_PATH, 'call', 500, 1),
      edgeIdentity(CALL_PATH, 'call', 700, 0),
    ]);
    expect(new Set(result.facts.map((fact) => fact.id)).size).toBe(3);
    expect(result.facts.every((fact) => fact.evidence.length === 1)).toBe(true);
    expect(result.facts[0]?.range.endByte).toBe(510);
  });

  it('classifies low-level candidates conservatively and keeps custom call and transfer user-defined', () => {
    const builtinCall = callEvent(500, 520, 'member', 'call', true, inRun);
    const builtinSend = callEvent(530, 550, 'member', 'send', true, inRun);
    const customLib = callEvent(560, 580, 'member', 'call', true, inRun);
    const legacy = callEvent(590, 610, 'member', 'value', true, inRun);
    const unknownReceiver = callEvent(620, 640, 'member', 'call', true, inRun);
    const nonCandidate = callEvent(650, 670, 'member', 'keccak', false, inRun);
    const result = facts(
      [builtinCall, builtinSend, customLib, legacy, unknownReceiver, nonCandidate],
      [
        semanticSite(builtinCall, 'member', [{ kind: 'builtin' }], 'identifier', [paramDef(1)]),
        semanticSite(builtinSend, 'member', [{ kind: 'builtin' }], 'identifier', [paramDef(1)]),
        semanticSite(
          customLib,
          'member',
          [userDef(customCall, 'FunctionDefinition')],
          'identifier',
          [userDef(library, 'LibraryDefinition')],
        ),
        semanticSite(legacy, 'member', [{ kind: 'builtin' }], 'identifier', [paramDef(1)]),
        semanticSite(unknownReceiver, 'member', [], 'other'),
        semanticSite(nonCandidate, 'member', [{ kind: 'builtin' }], 'identifier', [paramDef(1)]),
      ],
    );
    const classes = result.facts.map((fact) => [fact.range.startByte, fact.builtin]);
    expect(classes).toEqual([
      [500, 'confirmed'],
      [530, 'confirmed'],
      [560, 'rejected'],
      [590, 'unknown'],
      [620, 'unknown'],
      [650, null],
    ]);
    // Builtin members produce no public edge and no dispatch claim.
    expect(result.facts[0]).toMatchObject({ symbol: 'builtin', dispatch: 'not-applicable' });
    expect(result.graphs.map((row) => row.id)).toEqual([result.facts[2]?.id]);
  });

  it('counts confirmed builtins per file without turning unknown into zero', () => {
    const fileId = fid(CALL_PATH);
    const confirmedEvent = callEvent(500, 520, 'member', 'call', true, inRun);
    const rejectedEvent = callEvent(530, 550, 'member', 'call', true, inRun);
    const unknownEvent = callEvent(560, 580, 'member', 'call', true, inRun);
    const run = (
      events: readonly ParserEvent[],
      sites: readonly SemanticCallSite[],
      semantics: 'bound' | 'unavailable' = 'bound',
      limit = 100_000,
    ) => {
      const built = facts(events, sites, limit, semantics);
      const file = callFile(all, events, semantics);
      return countConfirmedBuiltins({
        files: [{ fileId, syntax: file.syntax, semantics }],
        facts: built.facts,
      })[0]?.confirmedBuiltinLowLevelCalls;
    };
    const confirmedSite = semanticSite(
      confirmedEvent,
      'member',
      [{ kind: 'builtin' }],
      'identifier',
      [paramDef(1)],
    );
    const rejectedSite = semanticSite(
      rejectedEvent,
      'member',
      [userDef(customCall, 'FunctionDefinition')],
      'identifier',
      [userDef(library, 'LibraryDefinition')],
    );
    const unknownSite = semanticSite(unknownEvent, 'member', [], 'other');
    expect(run([confirmedEvent, rejectedEvent], [confirmedSite, rejectedSite])).toMatchObject({
      status: 'measured',
      value: 1,
    });
    expect(run([rejectedEvent], [rejectedSite])).toMatchObject({ status: 'measured', value: 0 });
    expect(run([], [])).toMatchObject({ status: 'measured', value: 0 });
    expect(run([confirmedEvent, unknownEvent], [confirmedSite, unknownSite])).toEqual({
      status: 'unavailable',
      reason: 'unconfirmed-low-level-candidate',
    });
    expect(run([confirmedEvent], [confirmedSite], 'unavailable')).toEqual({
      status: 'unavailable',
      reason: 'semantics-unavailable',
    });
    expect(
      countConfirmedBuiltins({
        files: [
          {
            fileId,
            syntax: { status: 'failed', fileId, code: 'PARSE_INVALID', diagnostics: [] },
            semantics: 'bound',
          },
        ],
        facts: [],
      })[0]?.confirmedBuiltinLowLevelCalls,
    ).toEqual({ status: 'unavailable', reason: 'syntax-failed' });
    // A dropped site (graph allowance) must not read as a measured zero.
    expect(run([confirmedEvent], [confirmedSite], 'bound', 1)).toEqual({
      status: 'unavailable',
      reason: 'graph-limit',
    });
  });

  it('retains unavailable-component sites as unknown evidence and enforces the call allowance', () => {
    const event = callEvent(500, 520, 'member', 'call', true, inRun);
    const unavailable = facts([event], [], 100_000, 'unavailable');
    expect(unavailable.facts).toMatchObject([
      {
        symbol: 'unavailable',
        dispatch: 'unknown',
        builtin: 'unknown',
        limitation: 'semantics-unavailable',
      },
    ]);
    expect(unavailable.graphs).toEqual([]);
    // One companion site plus one evidence reference costs 2 slots (no definitions).
    expect(facts([event], [], 2, 'unavailable').facts).toHaveLength(1);
    const cut = facts([event], [], 1, 'unavailable');
    expect(cut.facts).toEqual([]);
    expect(cut.limited).toBe(true);
  });

  describe('pairs', () => {
    const scopedA = cid('src/A.sol', 0);
    const scopedB = cid('src/B.sol', 0);
    const contextC = cid('lib/C.sol', 0);
    const excludedD = cid('src/D.sol', 0);
    const demoted = cid('src/E.sol', 0);
    const eligibility: PairEligibility = {
      fileOf: new Map([
        [scopedA, fid('src/A.sol')],
        [scopedB, fid('src/B.sol')],
        [contextC, fid('lib/C.sol')],
        [excludedD, fid('src/D.sol')],
        [demoted, fid('src/E.sol')],
      ]),
      entries: new Map([
        [fid('src/A.sol'), { role: 'scoped', ownership: 'first-party' }],
        [fid('src/B.sol'), { role: 'scoped', ownership: 'first-party' }],
        [fid('lib/C.sol'), { role: 'context', ownership: 'third-party' }],
        [fid('src/D.sol'), { role: 'excluded', ownership: 'first-party' }],
        [fid('src/E.sol'), { role: 'context', ownership: 'unknown' }],
      ]),
    };
    const claim = (
      leftId: ContractId,
      rightId: ContractId,
      kind: PairKind,
      start = 1,
    ): PairClaim => ({ leftId, rightId, kind, evidence: [ev('src/A.sol', start)] });

    it('partitions scoped and context pairs, unions kinds and evidence, and skips ineligible ends', () => {
      const claims: PairClaim[] = [
        claim(scopedA, scopedB, 'inheritance', 1),
        claim(scopedA, scopedB, 'call', 2),
        claim(scopedA, scopedB, 'call', 2),
        claim(scopedB, scopedA, 'call', 3),
        claim(scopedA, contextC, 'inheritance', 4),
        claim(scopedA, scopedA, 'call', 5),
        claim(contextC, scopedA, 'call', 6),
        claim(scopedA, excludedD, 'call', 7),
        claim(demoted, scopedA, 'call', 8),
        claim(scopedA, cid('src/Ghost.sol', 0), 'call', 9),
      ];
      for (const order of [claims, [...claims].reverse()]) {
        const result = derivePairs(order, eligibility, new GraphAllowance(1_000));
        expect(result.limited).toBe(false);
        expect(result.scopedPairs.map((pair) => [pair.leftId, pair.rightId, pair.kinds])).toEqual([
          [scopedA, scopedB, ['call', 'inheritance']],
          [scopedB, scopedA, ['call']],
        ]);
        expect(result.scopedPairs[0]?.evidence.map((item) => item.range.startByte)).toEqual([1, 2]);
        expect(result.contextPairs.map((pair) => [pair.leftId, pair.rightId, pair.kinds])).toEqual([
          [scopedA, contextC, ['inheritance']],
        ]);
        const scopedKeys = result.scopedPairs.map((pair) => `${pair.leftId}|${pair.rightId}`);
        const contextKeys = result.contextPairs.map((pair) => `${pair.leftId}|${pair.rightId}`);
        expect(scopedKeys.filter((key) => contextKeys.includes(key))).toEqual([]);
      }
    });

    it('charges pairs, kinds and evidence against the allowance without partial pairs', () => {
      const claims: PairClaim[] = [
        claim(scopedA, scopedB, 'inheritance', 1),
        claim(scopedB, scopedA, 'call', 2),
      ];
      // Each pair costs pair + first kind (2) plus one evidence element (1).
      const exact = derivePairs(claims, eligibility, new GraphAllowance(6));
      expect(exact.limited).toBe(false);
      expect(exact.scopedPairs).toHaveLength(2);
      const over = derivePairs(claims, eligibility, new GraphAllowance(5));
      expect(over.limited).toBe(true);
      expect(over.scopedPairs.length).toBe(1);
      expect(over.scopedPairs.every((pair) => pair.kinds.length > 0)).toBe(true);
      expect(derivePairs(claims, eligibility, new GraphAllowance(1)).scopedPairs).toEqual([]);
    });
  });
});

describe('completeness and fingerprint', () => {
  it.each([
    [
      'clean',
      { prerequisiteComplete: true, relationshipIncomplete: false, unknownEvidence: false },
      [true, false],
    ],
    [
      'unknown evidence only',
      { prerequisiteComplete: true, relationshipIncomplete: false, unknownEvidence: true },
      [true, true],
    ],
    [
      'relationship failure',
      { prerequisiteComplete: true, relationshipIncomplete: true, unknownEvidence: false },
      [false, true],
    ],
    [
      'false prerequisite is never upgraded',
      { prerequisiteComplete: false, relationshipIncomplete: false, unknownEvidence: false },
      [false, false],
    ],
    [
      'false prerequisite with unknowns',
      { prerequisiteComplete: false, relationshipIncomplete: false, unknownEvidence: true },
      [false, true],
    ],
  ] as const)('keeps the two flags independent: %s', (_name, input, expected) => {
    const result = summarizeCompleteness(input);
    expect([result.requiredAnalysisComplete, result.hasUnknownSemantics]).toEqual(expected);
  });

  const parts: FingerprintParts = {
    entries: [
      { fileId: 'file:b.sol', byteHash: 'b'.repeat(64), role: 'context', ownership: 'third-party' },
      { fileId: 'file:a.sol', byteHash: 'a'.repeat(64), role: 'scoped', ownership: 'first-party' },
    ],
    imports: [
      {
        importId: 'decl:a.sol:import:0:0',
        status: 'resolved',
        targetFileId: 'file:b.sol',
        candidateFileIds: ['file:b.sol'],
        strategy: 'relative',
        lookupName: 'b.sol',
        reason: null,
        remapping: null,
      },
    ],
    semanticConfig: { remappings: [], libs: [], limits: { maxGraphEdges: 100 } },
    parserVersion: '1.3.9',
    fileVersions: [
      { fileId: 'file:a.sol', version: '0.8.37' },
      { fileId: 'file:b.sol', version: '0.8.37' },
    ],
    components: [
      {
        id: 'file:a.sol',
        members: ['file:a.sol', 'file:b.sol'],
        grammar: '0.8.37',
        status: 'available',
        reason: null,
      },
    ],
    invalidated: [],
  };

  it('is stable under input permutation and sensitive to every decision input', () => {
    const base = relationshipFingerprint(parts);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(
      relationshipFingerprint({
        ...parts,
        entries: [...parts.entries].reverse(),
        fileVersions: [...parts.fileVersions].reverse(),
      }),
    ).toBe(base);
    const changed: readonly FingerprintParts[] = [
      {
        ...parts,
        entries: [
          { ...(parts.entries[0] as object), byteHash: 'c'.repeat(64) },
          parts.entries[1],
        ] as never,
      },
      {
        ...parts,
        entries: [{ ...(parts.entries[0] as object), role: 'scoped' }, parts.entries[1]] as never,
      },
      {
        ...parts,
        semanticConfig: {
          remappings: [{ prefix: 'a/', target: 'b' }],
          libs: [],
          limits: { maxGraphEdges: 100 },
        },
      },
      {
        ...parts,
        semanticConfig: { remappings: [], libs: ['lib'], limits: { maxGraphEdges: 100 } },
      },
      { ...parts, parserVersion: '1.3.10' },
      {
        ...parts,
        fileVersions: [{ fileId: 'file:a.sol', version: '0.8.28' }, parts.fileVersions[1]] as never,
      },
      { ...parts, invalidated: ['file:a.sol'] },
      {
        ...parts,
        components: [{ ...(parts.components[0] as object), grammar: '0.8.28' }] as never,
      },
    ];
    const fingerprints = changed.map((item) => relationshipFingerprint(item));
    expect(new Set([base, ...fingerprints]).size).toBe(changed.length + 1);
  });

  it('checks public rows against the schema field bounds at the exact and one-over sizes', () => {
    const row = (candidates: number, evidence: number, from = 'a'): RelationshipResult => ({
      id: edgeIdentity('A.sol', 'call', 0, 0),
      kind: 'call',
      from,
      candidateTargets: Array.from({ length: candidates }, (_unused, index) => `c${index}`),
      evidence: Array.from({ length: evidence }, () => ev('A.sol', 0)),
      resolution: 'unsupported',
    });
    expect(rowFits(row(MAX_EDGE_FANOUT, MAX_EDGE_FANOUT))).toBe(true);
    expect(RelationshipResultSchema.safeParse(row(MAX_EDGE_FANOUT, MAX_EDGE_FANOUT)).success).toBe(
      true,
    );
    expect(rowFits(row(MAX_EDGE_FANOUT + 1, 1))).toBe(false);
    expect(RelationshipResultSchema.safeParse(row(MAX_EDGE_FANOUT + 1, 1)).success).toBe(false);
    expect(rowFits(row(1, MAX_EDGE_FANOUT + 1))).toBe(false);
    expect(rowFits(row(0, 0, 'x'.repeat(MAX_IDENTIFIER_CODE_UNITS)))).toBe(true);
    expect(rowFits(row(0, 0, 'x'.repeat(MAX_IDENTIFIER_CODE_UNITS + 1)))).toBe(false);
    expect(RelationshipResultSchema.safeParse(row(0, 0, 'x'.repeat(513))).success).toBe(false);
    expect(MAX_PUBLIC_ROWS).toBe(100_000);
  });

  it('keeps length-framed fields from colliding when text moves between components', () => {
    const left = relationshipFingerprint({ ...parts, parserVersion: 'ab' });
    const right = relationshipFingerprint({ ...parts, parserVersion: 'a' });
    expect(left).not.toBe(right);
  });
});

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
