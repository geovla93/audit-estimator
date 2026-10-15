import { edgeIdentity } from '../domain/canonical.ts';
import type {
  CallableId,
  ContractId,
  EdgeId,
  EvidenceRef,
  FileId,
  Measurement,
  RelationshipResult,
  SourceRange,
} from '../domain/types.ts';
import type { ParseFileResult, ParserDeclaration, SemanticBaseSite } from '../parser/protocol.ts';
import {
  compareCodePoints,
  GraphAllowance,
  GraphLimitError,
  stronglyConnectedComponents,
  uniqueEvidence,
} from './graph.ts';
import type {
  ContractInheritance,
  DirectBaseEdge,
  DirectBaseResolution,
  InheritanceUnavailableReason,
} from './types.ts';

/** One verified candidate for a declared base: a contract ID, or null for a non-contract symbol. */
export interface BaseCandidate {
  readonly contractId: ContractId | null;
}

/** One declared direct base reference, in declaration order. */
export interface BaseSiteFact {
  readonly contractId: ContractId;
  readonly ordinal: number;
  readonly edgeId: EdgeId;
  readonly evidence: EvidenceRef;
  readonly candidates: readonly BaseCandidate[];
}

export interface InheritanceContract {
  readonly id: ContractId;
  readonly fileId: FileId;
  readonly callableIds: readonly CallableId[];
  /** False when the contract's component had no semantic result. */
  readonly semantics: 'bound' | 'unavailable';
}

export interface InheritanceInput {
  readonly contracts: readonly InheritanceContract[];
  readonly sites: readonly BaseSiteFact[];
  readonly allowance: GraphAllowance;
}

export interface InheritanceResult {
  readonly edges: readonly DirectBaseEdge[];
  readonly inheritance: readonly ContractInheritance[];
  readonly graphs: readonly RelationshipResult[];
  /** True when the graph allowance cut off edges or measurements. */
  readonly limited: boolean;
}

export interface InheritanceFile {
  readonly fileId: FileId;
  readonly canonicalPath: string;
  readonly syntax: Extract<ParseFileResult, { status: 'parsed' }>;
}

const CONTRACT_LIKE_KINDS: readonly string[] = [
  'contract',
  'abstract-contract',
  'library',
  'interface',
];

function nameKey(fileId: FileId, range: SourceRange): string {
  return `${fileId}\u0000${range.startByte}\u0000${range.endByte}`;
}

/**
 * Maps validated semantic base sites onto verified contract declarations. Identity is canonical
 * file plus declaration range through the accepted syntax records; no short name is ever looked
 * up globally. A definition that is not a contract declaration (an import alias symbol, a
 * built-in) stays a null candidate so the edge cannot become unique.
 */
export function toBaseSiteFacts(
  files: readonly InheritanceFile[],
  sites: readonly SemanticBaseSite[],
): BaseSiteFact[] {
  const contractByName = new Map<string, ContractId>();
  const contractByStart = new Map<string, ParserDeclaration>();
  const paths = new Map<FileId, string>();
  for (const file of files) {
    paths.set(file.fileId, file.canonicalPath);
    for (const declaration of file.syntax.declarations) {
      if (!CONTRACT_LIKE_KINDS.includes(declaration.kind) || declaration.contractId === null) {
        continue;
      }
      contractByName.set(nameKey(file.fileId, declaration.nameRange), declaration.contractId);
      contractByStart.set(
        `${file.fileId}\u0000${declaration.declarationRange.startByte}`,
        declaration,
      );
    }
  }
  const facts: BaseSiteFact[] = [];
  for (const site of sites) {
    const owner = contractByStart.get(`${site.fileId}\u0000${site.contractStartByte}`);
    const path = paths.get(site.fileId);
    if (owner === undefined || owner.contractId === null || path === undefined) continue;
    facts.push({
      contractId: owner.contractId,
      ordinal: site.ordinal,
      edgeId: edgeIdentity(path, 'inheritance', owner.declarationRange.startByte, site.ordinal),
      evidence: { fileId: site.fileId, range: site.reference },
      candidates: site.definitions.map((definition) => ({
        contractId:
          definition.kind === 'user'
            ? (contractByName.get(nameKey(definition.fileId, definition.nameRange)) ?? null)
            : null,
      })),
    });
  }
  return facts;
}

const REASON_PRIORITY: readonly InheritanceUnavailableReason[] = [
  'inheritance-cycle',
  'unresolved-base',
  'semantics-unavailable',
  'graph-limit',
];

function unavailable<T>(reason: InheritanceUnavailableReason): Measurement<T> {
  return { status: 'unavailable', reason };
}

function strongest(reasons: readonly InheritanceUnavailableReason[]): InheritanceUnavailableReason {
  for (const reason of REASON_PRIORITY) if (reasons.includes(reason)) return reason;
  return 'unresolved-base';
}

function resolutionOf(candidates: readonly BaseCandidate[]): {
  readonly resolution: DirectBaseResolution;
  readonly base: ContractId | null;
  readonly candidateContractIds: readonly ContractId[];
} {
  const ids = [
    ...new Set(
      candidates.flatMap((candidate) =>
        candidate.contractId === null ? [] : [candidate.contractId],
      ),
    ),
  ].sort(compareCodePoints) as ContractId[];
  const only = candidates[0];
  if (candidates.length === 1 && only?.contractId !== null && only !== undefined) {
    return { resolution: 'resolved-unique', base: only.contractId, candidateContractIds: ids };
  }
  return {
    resolution: ids.length > 0 ? 'ambiguous' : 'unresolved',
    base: null,
    candidateContractIds: ids,
  };
}

/**
 * Builds direct-base edges and bounded transitive measurements. Only a single verified contract
 * definition yields `resolved-unique`; alias candidate sets stay ambiguous and missing references
 * unresolved. Ancestors and depth are computed only when every reachable direct base is resolved
 * and the reachable subgraph is acyclic; independent subgraphs stay measurable. Traversal is
 * iterative, and every retained element is charged against the shared graph allowance.
 */
export function buildInheritance(input: InheritanceInput): InheritanceResult {
  const contracts = new Map(input.contracts.map((contract) => [contract.id, contract]));
  const sitesByContract = new Map<ContractId, BaseSiteFact[]>();
  for (const site of input.sites) {
    const list = sitesByContract.get(site.contractId) ?? [];
    list.push(site);
    sitesByContract.set(site.contractId, list);
  }

  let limited = false;
  const edges: DirectBaseEdge[] = [];
  const graphs: RelationshipResult[] = [];
  const edgeIdsByContract = new Map<ContractId, EdgeId[]>();
  const edgeEvidenceByContract = new Map<ContractId, EvidenceRef[]>();
  const tainted = new Set<ContractId>();
  const cutOff = new Set<ContractId>();

  const orderedContracts = [...contracts.values()].sort((left, right) =>
    compareCodePoints(left.id, right.id),
  );
  for (const contract of orderedContracts) {
    const sites = (sitesByContract.get(contract.id) ?? []).sort(
      (left, right) => left.ordinal - right.ordinal,
    );
    for (const site of sites) {
      const outcome = resolutionOf(site.candidates);
      // A base that is not a known contract in the closure cannot be verified.
      const base = outcome.base !== null && contracts.has(outcome.base) ? outcome.base : null;
      const resolution: DirectBaseResolution =
        outcome.resolution === 'resolved-unique' && base === null
          ? 'unresolved'
          : outcome.resolution;
      const candidateIds =
        resolution === 'resolved-unique' ? [base ?? ''] : outcome.candidateContractIds;
      try {
        input.allowance.spend(1 + candidateIds.length + 1);
      } catch (error: unknown) {
        if (!(error instanceof GraphLimitError)) throw error;
        limited = true;
        cutOff.add(contract.id);
        continue;
      }
      const edge: DirectBaseEdge = {
        id: site.edgeId,
        contractId: contract.id,
        ordinal: site.ordinal,
        resolution,
        baseContractId: resolution === 'resolved-unique' ? base : null,
        candidateContractIds: candidateIds as ContractId[],
        evidence: [site.evidence],
      };
      edges.push(edge);
      const ids = edgeIdsByContract.get(contract.id) ?? [];
      ids.push(edge.id);
      edgeIdsByContract.set(contract.id, ids);
      const evidence = edgeEvidenceByContract.get(contract.id) ?? [];
      evidence.push(site.evidence);
      edgeEvidenceByContract.set(contract.id, evidence);
      if (resolution !== 'resolved-unique') tainted.add(contract.id);
      const common = {
        id: edge.id,
        kind: 'inheritance' as const,
        from: contract.id,
        candidateTargets: [...edge.candidateContractIds],
        evidence: [...edge.evidence],
      };
      if (resolution === 'resolved-unique' && base !== null) {
        graphs.push({ ...common, resolution: 'resolved-unique', to: base });
      } else {
        graphs.push({
          ...common,
          resolution: resolution === 'ambiguous' ? 'ambiguous' : 'unresolved',
        });
      }
    }
  }

  const resolvedBases = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.baseContractId === null) continue;
    const list = resolvedBases.get(edge.contractId) ?? [];
    list.push(edge.baseContractId);
    resolvedBases.set(edge.contractId, list);
  }

  type State =
    | { readonly status: 'ok'; readonly ancestors: readonly ContractId[]; readonly depth: number }
    | { readonly status: 'blocked'; readonly reason: InheritanceUnavailableReason };
  const states = new Map<ContractId, State>();
  const components = stronglyConnectedComponents(
    orderedContracts.map((contract) => contract.id),
    resolvedBases,
  );
  let allowanceExhausted = false;
  for (const component of components) {
    const first = component[0];
    if (first === undefined) continue;
    const isCycle = component.length > 1 || (resolvedBases.get(first) ?? []).includes(first);
    if (isCycle) {
      for (const member of component) {
        states.set(member as ContractId, { status: 'blocked', reason: 'inheritance-cycle' });
      }
      continue;
    }
    const id = first as ContractId;
    const contract = contracts.get(id);
    if (contract === undefined) continue;
    if (contract.semantics === 'unavailable') {
      states.set(id, { status: 'blocked', reason: 'semantics-unavailable' });
      continue;
    }
    if (cutOff.has(id)) {
      states.set(id, { status: 'blocked', reason: 'graph-limit' });
      continue;
    }
    if (tainted.has(id)) {
      states.set(id, { status: 'blocked', reason: 'unresolved-base' });
      continue;
    }
    const bases = [...new Set(resolvedBases.get(id) ?? [])] as ContractId[];
    const blockedReasons: InheritanceUnavailableReason[] = [];
    let depth = 0;
    const ancestors = new Set<ContractId>();
    for (const base of bases) {
      const state = states.get(base);
      if (state === undefined || state.status === 'blocked') {
        blockedReasons.push(state?.status === 'blocked' ? state.reason : 'unresolved-base');
        continue;
      }
      ancestors.add(base);
      for (const ancestor of state.ancestors) ancestors.add(ancestor);
      depth = Math.max(depth, state.depth + 1);
    }
    if (blockedReasons.length > 0) {
      states.set(id, { status: 'blocked', reason: strongest(blockedReasons) });
      continue;
    }
    const sorted = [...ancestors].sort(compareCodePoints) as ContractId[];
    try {
      input.allowance.spend(sorted.length);
    } catch (error: unknown) {
      if (!(error instanceof GraphLimitError)) throw error;
      allowanceExhausted = true;
      states.set(id, { status: 'blocked', reason: 'graph-limit' });
      continue;
    }
    states.set(id, { status: 'ok', ancestors: sorted, depth: bases.length === 0 ? 0 : depth });
  }
  if (allowanceExhausted) limited = true;

  const inheritance: ContractInheritance[] = [];
  for (const contract of orderedContracts) {
    const state = states.get(contract.id);
    const directBaseEdgeIds = edgeIdsByContract.get(contract.id) ?? [];
    if (state === undefined || state.status === 'blocked') {
      const reason = state?.status === 'blocked' ? state.reason : 'unresolved-base';
      inheritance.push({
        contractId: contract.id,
        fileId: contract.fileId,
        directBaseEdgeIds,
        ancestorIds: unavailable(reason),
        maxDepth: unavailable(reason),
        ancestorDeclaredCallableIds: unavailable(reason),
      });
      continue;
    }
    const evidence = uniqueEvidence(edgeEvidenceByContract.get(contract.id) ?? []);
    const callables = new Set<CallableId>();
    for (const ancestor of state.ancestors) {
      for (const callable of contracts.get(ancestor)?.callableIds ?? []) callables.add(callable);
    }
    const sortedCallables = [...callables].sort(compareCodePoints) as CallableId[];
    try {
      input.allowance.spend(sortedCallables.length);
    } catch (error: unknown) {
      if (!(error instanceof GraphLimitError)) throw error;
      limited = true;
      inheritance.push({
        contractId: contract.id,
        fileId: contract.fileId,
        directBaseEdgeIds,
        ancestorIds: { status: 'measured', value: state.ancestors, evidence },
        maxDepth: { status: 'measured', value: state.depth, evidence },
        ancestorDeclaredCallableIds: unavailable('graph-limit'),
      });
      continue;
    }
    inheritance.push({
      contractId: contract.id,
      fileId: contract.fileId,
      directBaseEdgeIds,
      ancestorIds: { status: 'measured', value: state.ancestors, evidence },
      maxDepth: { status: 'measured', value: state.depth, evidence },
      ancestorDeclaredCallableIds: {
        status: 'measured',
        value: sortedCallables,
        evidence,
      },
    });
  }

  return {
    edges: edges.sort((left, right) => compareCodePoints(left.id, right.id)),
    inheritance,
    graphs: graphs.sort((left, right) => compareCodePoints(left.id, right.id)),
    limited,
  };
}
