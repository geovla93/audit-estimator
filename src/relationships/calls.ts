import { edgeIdentity } from '../domain/canonical.ts';
import type {
  CallableId,
  EdgeId,
  EvidenceRef,
  FileId,
  RelationshipResult,
  SourceRange,
} from '../domain/types.ts';
import type {
  ParseFileResult,
  ParserDeclaration,
  ParserEvent,
  SemanticCallSite,
  SemanticDefinition,
} from '../parser/protocol.ts';
import { compareCodePoints, GraphAllowance, GraphLimitError } from './graph.ts';
import type {
  BuiltinClassification,
  CallDefinition,
  CallLimitation,
  CallReceiver,
  CallSiteFact,
  FileBuiltinCount,
  StaticDispatch,
  SymbolStatus,
} from './types.ts';

/**
 * The only member names a built-in classification may rest on. Confirmation additionally needs the
 * member reference to bind exclusively to built-in definitions on a resolved receiver (tested for
 * address parameters, `payable(...)` conversions and `msg.sender`); legacy `.call.value(...)`
 * shapes, whose member is `value` or `gas`, are never confirmed.
 */
export const LOW_LEVEL_MEMBERS: ReadonlySet<string> = new Set([
  'call',
  'delegatecall',
  'staticcall',
  'callcode',
  'send',
  'transfer',
]);

export interface CallFileInput {
  readonly fileId: FileId;
  readonly canonicalPath: string;
  readonly syntax: Extract<ParseFileResult, { status: 'parsed' }>;
  /** Whether the file's component produced semantic sites. */
  readonly semantics: 'bound' | 'unavailable';
}

export interface CallFactsInput {
  readonly files: readonly CallFileInput[];
  /** Accepted sites from every bound component. */
  readonly sites: readonly SemanticCallSite[];
  readonly allowance: GraphAllowance;
}

export interface CallFactsResult {
  readonly facts: readonly CallSiteFact[];
  readonly graphs: readonly RelationshipResult[];
  /** True when the graph allowance dropped sites or rows. */
  readonly limited: boolean;
}

function spanKey(fileId: FileId, range: SourceRange): string {
  return `${fileId}\u0000${range.startByte}\u0000${range.endByte}`;
}

function attribute(event: ParserEvent, key: string): string | number | boolean | null | undefined {
  return event.attributes.find((item) => item.key === key)?.value;
}

type DeclarationIndex = ReadonlyMap<string, ParserDeclaration>;

function convertDefinition(
  definition: SemanticDefinition,
  index: DeclarationIndex,
): CallDefinition {
  if (definition.kind === 'builtin') return { kind: 'builtin' };
  const declaration = index.get(spanKey(definition.fileId, definition.nameRange));
  const callableId = declaration?.callableId ?? null;
  const contractId =
    declaration !== undefined && declaration.callableId === null ? declaration.contractId : null;
  return {
    kind: 'user',
    fileId: definition.fileId,
    nameRange: definition.nameRange,
    definiens: definition.definiens,
    callableId,
    contractId,
  };
}

interface Classification {
  readonly symbol: SymbolStatus;
  readonly symbolTarget: CallableId | null;
  readonly candidateTargets: readonly CallableId[];
  readonly dispatch: StaticDispatch;
  readonly limitation: CallLimitation;
}

function classify(
  calleeKind: string,
  definitions: readonly CallDefinition[],
  receiver: CallReceiver,
  declarationOf: (definition: CallDefinition) => ParserDeclaration | undefined,
): Classification {
  const none = (
    symbol: SymbolStatus,
    dispatch: StaticDispatch,
    limitation: CallLimitation,
  ): Classification => ({
    symbol,
    symbolTarget: null,
    candidateTargets: [],
    dispatch,
    limitation,
  });
  if (calleeKind === 'elementary-type' || calleeKind === 'new') {
    return none('type-conversion', 'not-applicable', 'type-conversion');
  }
  if (calleeKind === 'other') return none('none', 'unknown', 'complex-callee');
  if (definitions.length === 0) return none('none', 'unknown', 'unbound-reference');

  const users = definitions.filter(
    (definition): definition is Extract<CallDefinition, { kind: 'user' }> =>
      definition.kind === 'user',
  );
  const builtins = definitions.length - users.length;
  const callables = users.filter((definition) => definition.callableId !== null);
  const contracts = users.filter((definition) => definition.contractId !== null);
  const others = users.length - callables.length - contracts.length;

  if (callables.length === 0 && builtins > 0 && users.length === 0) {
    return none('builtin', 'not-applicable', 'builtin-member');
  }
  if (callables.length > 0) {
    const candidateTargets = [
      ...new Set(
        callables.flatMap((definition) =>
          definition.callableId === null ? [] : [definition.callableId],
        ),
      ),
    ].sort(compareCodePoints) as CallableId[];
    const clean = builtins === 0 && contracts.length === 0 && others === 0;
    const target = candidateTargets[0];
    if (!clean || candidateTargets.length !== 1 || target === undefined) {
      return {
        symbol: 'candidates',
        symbolTarget: null,
        candidateTargets,
        dispatch: 'unknown',
        limitation: 'overloads-or-alias-candidates',
      };
    }
    const unique = (dispatch: StaticDispatch, limitation: CallLimitation): Classification => ({
      symbol: 'unique',
      symbolTarget: target,
      candidateTargets: [target],
      dispatch,
      limitation,
    });
    const targetDeclaration = callables[0] === undefined ? undefined : declarationOf(callables[0]);
    if (calleeKind === 'identifier') {
      return targetDeclaration?.contractId === null
        ? unique('static', 'none')
        : unique('dynamic', 'virtual-dispatch-unproven');
    }
    if (receiver.kind === 'this' || receiver.kind === 'super') {
      return unique('dynamic', 'this-or-super-dispatch');
    }
    if (receiver.kind === 'identifier' && receiver.definitions.length === 1) {
      const only = receiver.definitions[0];
      const receiverDeclaration = only === undefined ? undefined : declarationOf(only);
      if (
        only?.kind === 'user' &&
        only.contractId !== null &&
        receiverDeclaration?.kind === 'library' &&
        targetDeclaration?.contractId === only.contractId
      ) {
        return unique('static', 'none');
      }
    }
    return unique('dynamic', 'external-receiver-unproven');
  }
  if (contracts.length > 0) return none('type-conversion', 'not-applicable', 'type-conversion');
  return none('non-callable', 'unknown', 'function-pointer-or-variable');
}

function classifyBuiltin(
  site: { readonly lowLevelCandidate: boolean; readonly memberName: string | null },
  calleeKind: string,
  definitions: readonly CallDefinition[],
  symbol: SymbolStatus,
): BuiltinClassification | null {
  if (!site.lowLevelCandidate) return null;
  if (
    symbol === 'builtin' &&
    calleeKind === 'member' &&
    site.memberName !== null &&
    LOW_LEVEL_MEMBERS.has(site.memberName)
  ) {
    return 'confirmed';
  }
  const allUserCallables =
    definitions.length > 0 &&
    definitions.every((definition) => definition.kind === 'user' && definition.callableId !== null);
  if ((symbol === 'unique' || symbol === 'candidates') && allUserCallables) return 'rejected';
  return 'unknown';
}

function receiverOf(site: SemanticCallSite, index: DeclarationIndex): CallReceiver {
  return {
    kind: site.receiver,
    definitions: site.receiverDefinitions.map((definition) => convertDefinition(definition, index)),
  };
}

/**
 * Joins semantic sites to the existing syntax `call-site` events by file and original range.
 * Symbol resolution and dispatch stay separate: overloads, alias candidates and function-pointer
 * variables never become unique targets, a unique interface/`this`/`super` symbol stays companion
 * evidence with an `unsupported` public edge, and only free functions and uniquely resolved library
 * members yield a static resolved edge.
 */
export function buildCallFacts(input: CallFactsInput): CallFactsResult {
  const declarations = new Map<string, ParserDeclaration>();
  const events = new Map<string, { readonly file: CallFileInput; readonly event: ParserEvent }>();
  for (const file of input.files) {
    for (const declaration of file.syntax.declarations) {
      declarations.set(spanKey(file.fileId, declaration.nameRange), declaration);
    }
    for (const event of file.syntax.events) {
      if (event.kind === 'call-site') {
        events.set(spanKey(file.fileId, event.range), { file, event });
      }
    }
  }
  const semanticByKey = new Map<string, SemanticCallSite>();
  for (const site of input.sites) semanticByKey.set(spanKey(site.fileId, site.range), site);

  const declarationOf = (definition: CallDefinition): ParserDeclaration | undefined =>
    definition.kind === 'user'
      ? declarations.get(spanKey(definition.fileId, definition.nameRange))
      : undefined;

  const facts: CallSiteFact[] = [];
  const graphs: RelationshipResult[] = [];
  let limited = false;
  const ordered = [...events.entries()].sort(([, left], [, right]) => {
    return (
      compareCodePoints(left.file.fileId, right.file.fileId) ||
      left.event.range.startByte - right.event.range.startByte ||
      left.event.range.endByte - right.event.range.endByte
    );
  });
  const ordinals = new Map<string, number>();
  for (const [key, { file, event }] of ordered) {
    const ordinalKey = `${file.fileId}\u0000${event.range.startByte}`;
    const ordinal = ordinals.get(ordinalKey) ?? 0;
    ordinals.set(ordinalKey, ordinal + 1);
    const semantic = semanticByKey.get(key);
    const memberNameValue = attribute(event, 'member-name');
    const syntax = {
      calleeShape: String(attribute(event, 'callee-shape') ?? 'other'),
      memberName: typeof memberNameValue === 'string' ? memberNameValue : null,
      lowLevelCandidate: attribute(event, 'low-level-candidate') === true,
    };
    const id: EdgeId = edgeIdentity(file.canonicalPath, 'call', event.range.startByte, ordinal);
    const evidence: EvidenceRef[] = [{ fileId: file.fileId, range: event.range }];
    const definitions =
      semantic === undefined
        ? []
        : semantic.definitions.map((definition) => convertDefinition(definition, declarations));
    const receiver: CallReceiver =
      semantic === undefined
        ? { kind: 'none', definitions: [] }
        : receiverOf(semantic, declarations);
    const calleeKind = semantic?.callee ?? 'unavailable';
    const classification: Classification =
      semantic === undefined
        ? {
            symbol: 'unavailable',
            symbolTarget: null,
            candidateTargets: [],
            dispatch: 'unknown',
            limitation: 'semantics-unavailable',
          }
        : classify(calleeKind, definitions, receiver, declarationOf);
    const builtin =
      semantic === undefined
        ? syntax.lowLevelCandidate
          ? ('unknown' as const)
          : null
        : classifyBuiltin(syntax, calleeKind, definitions, classification.symbol);

    const publicRow =
      classification.symbol === 'unique' ||
      classification.symbol === 'candidates' ||
      classification.symbol === 'non-callable';
    try {
      input.allowance.spend(
        1 +
          definitions.length +
          receiver.definitions.length +
          classification.candidateTargets.length +
          evidence.length +
          (publicRow ? 1 + classification.candidateTargets.length + evidence.length : 0),
      );
    } catch (error: unknown) {
      if (!(error instanceof GraphLimitError)) throw error;
      limited = true;
      continue;
    }
    const from = event.callableId ?? event.contractId ?? file.fileId;
    let edgeId: EdgeId | null = null;
    if (publicRow) {
      edgeId = id;
      const common = {
        id,
        kind: 'call' as const,
        from,
        candidateTargets: [...classification.candidateTargets],
        evidence: [...evidence],
      };
      if (
        classification.symbol === 'unique' &&
        classification.dispatch === 'static' &&
        classification.symbolTarget !== null
      ) {
        graphs.push({ ...common, resolution: 'resolved-unique', to: classification.symbolTarget });
      } else if (classification.symbol === 'candidates') {
        graphs.push({ ...common, resolution: 'ambiguous' });
      } else {
        graphs.push({ ...common, resolution: 'unsupported' });
      }
    }
    facts.push({
      id,
      fileId: file.fileId,
      range: event.range,
      ownerCallableId: event.callableId,
      ownerContractId: event.contractId,
      syntax,
      calleeKind,
      definitions,
      receiver,
      symbol: classification.symbol,
      symbolTarget: classification.symbolTarget,
      candidateTargets: classification.candidateTargets,
      dispatch: classification.dispatch,
      builtin,
      limitation: classification.limitation,
      evidence,
      edgeId,
    });
  }
  return { facts, graphs, limited };
}

/**
 * Per-file confirmed built-in low-level call counts, separate from the unchanged syntax candidate
 * counts. Any unclassified candidate, failed syntax, unavailable component or dropped site makes
 * the count unavailable; zero is measured only when every candidate was classified.
 */
export function countConfirmedBuiltins(input: {
  readonly files: readonly {
    readonly fileId: FileId;
    readonly syntax: ParseFileResult | undefined;
    readonly semantics: 'bound' | 'unavailable';
  }[];
  readonly facts: readonly CallSiteFact[];
}): FileBuiltinCount[] {
  const byFile = new Map<FileId, CallSiteFact[]>();
  for (const fact of input.facts) {
    const list = byFile.get(fact.fileId) ?? [];
    list.push(fact);
    byFile.set(fact.fileId, list);
  }
  return [...input.files]
    .sort((left, right) => compareCodePoints(left.fileId, right.fileId))
    .map((file): FileBuiltinCount => {
      const unavailable = (reason: string): FileBuiltinCount => ({
        fileId: file.fileId,
        confirmedBuiltinLowLevelCalls: { status: 'unavailable', reason },
      });
      if (file.syntax?.status !== 'parsed') return unavailable('syntax-failed');
      if (file.semantics !== 'bound') return unavailable('semantics-unavailable');
      const facts = byFile.get(file.fileId) ?? [];
      const expected = file.syntax.events.filter((event) => event.kind === 'call-site').length;
      if (facts.length < expected) return unavailable('graph-limit');
      const candidates = facts.filter((fact) => fact.builtin !== null);
      if (candidates.some((fact) => fact.builtin === 'unknown')) {
        return unavailable('unconfirmed-low-level-candidate');
      }
      const confirmed = candidates.filter((fact) => fact.builtin === 'confirmed');
      return {
        fileId: file.fileId,
        confirmedBuiltinLowLevelCalls: {
          status: 'measured',
          value: confirmed.length,
          evidence: confirmed.flatMap((fact) => fact.evidence),
        },
      };
    });
}
