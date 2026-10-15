import { canonicalJson, fingerprint } from '../domain/canonical.ts';
import type {
  CallableAnalysis,
  CallableId,
  ContractAnalysis,
  ContractId,
  Diagnostic,
  EvidenceRef,
  FileId,
  Indicator,
  ScopeManifest,
  ScopeRole,
} from '../domain/types.ts';
import { LOOP_CONTROL_KINDS } from '../metrics/definitions.ts';
import type { FileMetrics } from '../metrics/structural.ts';
import type {
  ParseFileResult,
  ParserAttribute,
  ParserBatch,
  ParserDeclaration,
  ParserEvent,
} from '../parser/protocol.ts';
import type { CallSiteFact, ComponentUnavailableReason } from '../relationships/types.ts';
import type { RelationshipAnalysis } from '../relationships/types.ts';
import {
  compareCodePoints,
  INDICATOR_RULE_VERSION,
  MAX_INDICATOR_EVIDENCE,
  MAX_INDICATOR_LIMITATIONS,
  MAX_INDICATOR_ROWS,
  MAX_INDICATOR_TEXT,
  PRIVILEGE_MODIFIER_NAMES,
  UPGRADE_FUNCTION_NAMES,
  ruleDefinition,
  scopeLimitation,
  summaryFor,
} from './catalog.ts';
import type { OwnerKind, RuleKey, ScopeLabel } from './catalog.ts';
import { buildHumanPrompts, HUMAN_PROMPT_COUNT } from './human-prompts.ts';
import type { HumanPromptKey } from './human-prompts.ts';

/**
 * Pure indicator classification over plain syntax, metric and relationship records. This module
 * never reads source text, the filesystem or parser handles.
 */

export interface IndicatorBounds {
  readonly maxRows: number;
  readonly maxEvidencePerRow: number;
  readonly maxLimitationsPerRow: number;
}

export interface IndicatorInput {
  readonly manifest: ScopeManifest;
  readonly syntax: ParserBatch;
  readonly metrics: readonly FileMetrics[];
  readonly relationships: Pick<
    RelationshipAnalysis,
    | 'imports'
    | 'components'
    | 'directBaseEdges'
    | 'inheritance'
    | 'callSites'
    | 'confirmedBuiltinLowLevelCalls'
    | 'requiredAnalysisComplete'
    | 'hasUnknownSemantics'
  >;
  /** Test hook: bounds may only tighten the schema ceilings. */
  readonly bounds?: Partial<IndicatorBounds> | undefined;
}

export interface IndicatorClassification {
  readonly indicators: readonly Indicator[];
  /** Copied unchanged from the relationship input. */
  readonly requiredAnalysisComplete: boolean;
  /** Copied unchanged from the relationship input. */
  readonly hasUnknownSemantics: boolean;
  /** Classification output is exhaustive within its bounds. Input completeness is separate. */
  readonly complete: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly limitations: readonly string[];
}

const COMPONENT_REASON_TEXT: Readonly<Record<ComponentUnavailableReason, string>> = {
  'member-syntax-failed':
    'Semantic evidence is unavailable because a file in its import component failed to parse.',
  'unresolved-import':
    'Semantic evidence is unavailable because an import in its component is unresolved.',
  'no-common-grammar':
    'Semantic evidence is unavailable because no installed grammar fits every file in its component.',
  'authority-excludes-grammar':
    'Semantic evidence is unavailable because the configured Solidity version excludes every compatible grammar.',
  'component-too-large':
    'Semantic evidence is unavailable because its import component exceeds the configured size limit.',
  'no-scoped-member': 'Semantic evidence was not requested for a component without scoped files.',
  'semantics-failed': 'Semantic evidence is unavailable because semantic binding failed.',
  'semantics-limit': 'Semantic evidence is unavailable because a semantic limit was reached.',
  'semantics-cancelled': 'Semantic evidence is unavailable because semantic analysis was stopped.',
};

const SYNTAX_FAILURE_TEXT: Readonly<Record<string, string>> = {
  LANGUAGE_UNSUPPORTED:
    'Syntax evidence is unavailable because the Solidity version is unsupported.',
  PARSE_INVALID: 'Syntax evidence is unavailable because the file did not parse.',
  LIMIT_EXCEEDED: 'Syntax evidence is unavailable because a parse limit was reached.',
  INTERNAL_ERROR: 'Syntax evidence is unavailable because of an internal parser error.',
};

const SYNTAX_MISSING_TEXT = 'Syntax evidence is unavailable because no parser record exists.';
const SYNTAX_INCOMPLETE_TEXT = 'Metric records report incomplete syntax evidence for the file.';
const METRICS_MISSING_TEXT = 'Metric records are unavailable, so storage shapes are unassessed.';
const BUILTIN_TOTAL_TEXT =
  'The per-file confirmed built-in low-level call total is unavailable; listed calls are not exhaustive.';
const BUILTIN_UNKNOWN_TEXT =
  'Some low-level call candidates could not be classified as built-in or not built-in.';
const STORAGE_UNRESOLVED_TEXT =
  'Mutable state variables with user-defined or unknown types are unresolved and are not classified as simple or complex storage.';
const EVIDENCE_TRUNCATED_TEXT =
  'Evidence was truncated at the output bound; additional matching occurrences exist.';
const LIMITATION_TRUNCATED_TEXT = 'Limitations were truncated at the output bound.';

interface RowAccumulator {
  readonly rule: RuleKey;
  readonly ownerKind: OwnerKind;
  readonly ownerId: string;
  readonly scope: ScopeLabel;
  readonly evidence: Map<string, EvidenceRef>;
  readonly limitations: Set<string>;
}

function attribute(
  attributes: readonly ParserAttribute[],
  key: string,
): ParserAttribute['value'] | undefined {
  return attributes.find((candidate) => candidate.key === key)?.value;
}

function evidenceKey(ref: EvidenceRef): string {
  return `${ref.fileId}\u0000${ref.range.startByte}\u0000${ref.range.endByte}`;
}

function compareEvidence(left: EvidenceRef, right: EvidenceRef): number {
  return (
    compareCodePoints(left.fileId, right.fileId) ||
    left.range.startByte - right.range.startByte ||
    left.range.endByte - right.range.endByte
  );
}

function clip(text: string): string {
  return text.length <= MAX_INDICATOR_TEXT ? text : `${text.slice(0, MAX_INDICATOR_TEXT - 1)}.`;
}

/** Joins records by canonical ID. A repeated ID is tolerated only when the records are identical. */
function indexById<T, K extends string>(
  items: readonly T[],
  keyOf: (item: T) => K,
  serialize: (item: T) => string,
  label: string,
): Map<K, T> {
  const index = new Map<K, T>();
  for (const item of items) {
    const key = keyOf(item);
    const existing = index.get(key);
    if (existing === undefined) {
      index.set(key, item);
      continue;
    }
    if (serialize(existing) !== serialize(item)) {
      throw new TypeError(`Contradictory duplicate ${label} record.`);
    }
  }
  return index;
}

function scopeOf(role: ScopeRole): ScopeLabel | null {
  if (role === 'scoped') return 'scoped';
  if (role === 'context') return 'context';
  return null;
}

class RowStore {
  readonly #rows = new Map<string, RowAccumulator>();

  public add(
    rule: RuleKey,
    ownerKind: OwnerKind,
    ownerId: string,
    scope: ScopeLabel,
    evidence: readonly EvidenceRef[],
    limitations: readonly string[] = [],
  ): void {
    const key = `${rule}\u0000${ownerKind}\u0000${ownerId}`;
    let row = this.#rows.get(key);
    if (row === undefined) {
      row = { rule, ownerKind, ownerId, scope, evidence: new Map(), limitations: new Set() };
      this.#rows.set(key, row);
    }
    for (const ref of evidence) row.evidence.set(evidenceKey(ref), ref);
    for (const limitation of limitations) row.limitations.add(limitation);
  }

  public values(): IterableIterator<RowAccumulator> {
    return this.#rows.values();
  }
}

function ownerOf(
  callableId: CallableId | null,
  contractId: ContractId | null,
  fileId: FileId,
): { readonly kind: OwnerKind; readonly id: string } {
  if (callableId !== null) return { kind: 'callable', id: callableId };
  if (contractId !== null) return { kind: 'contract', id: contractId };
  return { kind: 'file', id: fileId };
}

function lastSegment(name: string): string {
  const index = name.lastIndexOf('.');
  return index < 0 ? name : name.slice(index + 1);
}

function callEvidence(site: CallSiteFact): readonly EvidenceRef[] {
  return site.evidence.length > 0 ? site.evidence : [{ fileId: site.fileId, range: site.range }];
}

function resolveBounds(input: IndicatorInput['bounds']): IndicatorBounds {
  const clamp = (value: number | undefined, ceiling: number): number =>
    value === undefined || !Number.isSafeInteger(value) || value < 1
      ? ceiling
      : Math.min(value, ceiling);
  return {
    maxRows: Math.max(clamp(input?.maxRows, MAX_INDICATOR_ROWS), HUMAN_PROMPT_COUNT),
    maxEvidencePerRow: clamp(input?.maxEvidencePerRow, MAX_INDICATOR_EVIDENCE),
    maxLimitationsPerRow: clamp(input?.maxLimitationsPerRow, MAX_INDICATOR_LIMITATIONS),
  };
}

function limitDiagnostic(message: string, rows: number): Diagnostic {
  return {
    code: 'LIMIT_EXCEEDED',
    severity: 'warning',
    phase: 'metrics',
    message,
    details: [{ key: 'rows', value: rows }],
  };
}

/** Classifies indicator rows and the eight unanswered human prompts. */
export function classifyIndicators(input: IndicatorInput): IndicatorClassification {
  const bounds = resolveBounds(input.bounds);
  const { relationships } = input;

  const entries = indexById(
    input.manifest.entries,
    (entry) => entry.fileId,
    (entry) => canonicalJson(entry),
    'manifest',
  );
  const syntaxByFile = indexById(
    input.syntax.files,
    (file) => file.fileId,
    (file) => canonicalJson(file),
    'syntax',
  );
  const metricsByFile = indexById(
    input.metrics,
    (metric) => metric.file.fileId,
    (metric) => canonicalJson({ f: metric.file, c: metric.contracts, k: metric.callables }),
    'metrics',
  );
  const contractsById = new Map<ContractId, ContractAnalysis>();
  const callablesById = new Map<CallableId, CallableAnalysis>();
  for (const metric of metricsByFile.values()) {
    for (const contract of metric.contracts) contractsById.set(contract.id, contract);
    for (const callable of metric.callables) callablesById.set(callable.id, callable);
  }
  indexById(
    relationships.callSites,
    (site) => site.id,
    (site) => canonicalJson(site),
    'call-site',
  );
  indexById(
    relationships.directBaseEdges,
    (edge) => edge.id,
    (edge) => canonicalJson(edge),
    'inheritance edge',
  );

  const includedScope = new Map<FileId, ScopeLabel>();
  for (const entry of entries.values()) {
    const scope = scopeOf(entry.role);
    if (scope !== null) includedScope.set(entry.fileId, scope);
  }
  const includedFiles = [...includedScope.keys()].sort(compareCodePoints);

  const store = new RowStore();
  const reasons = new Map<FileId, Set<string>>();
  const reasonEvidence = new Map<FileId, Map<string, EvidenceRef>>();
  const addReason = (
    fileId: FileId,
    reason: string,
    evidence: readonly EvidenceRef[] = [],
  ): void => {
    let set = reasons.get(fileId);
    if (set === undefined) {
      set = new Set();
      reasons.set(fileId, set);
    }
    set.add(reason);
    if (evidence.length > 0) {
      let map = reasonEvidence.get(fileId);
      if (map === undefined) {
        map = new Map();
        reasonEvidence.set(fileId, map);
      }
      for (const ref of evidence) map.set(evidenceKey(ref), ref);
    }
  };

  // Same-contract supplementary evidence, indexed once.
  const delegatecallByContract = new Map<ContractId, EvidenceRef[]>();
  for (const site of relationships.callSites) {
    if (!includedScope.has(site.fileId)) continue;
    if (
      site.builtin === 'confirmed' &&
      site.syntax.memberName === 'delegatecall' &&
      site.ownerContractId !== null
    ) {
      const list = delegatecallByContract.get(site.ownerContractId) ?? [];
      list.push(...callEvidence(site));
      delegatecallByContract.set(site.ownerContractId, list);
    }
  }
  const resolvedBaseEvidence = new Map<ContractId, EvidenceRef[]>();
  for (const edge of relationships.directBaseEdges) {
    if (edge.resolution !== 'resolved-unique') continue;
    const list = resolvedBaseEvidence.get(edge.contractId) ?? [];
    list.push(...edge.evidence);
    resolvedBaseEvidence.set(edge.contractId, list);
  }

  for (const fileId of includedFiles) {
    const scope = includedScope.get(fileId);
    if (scope === undefined) continue;
    const syntax: ParseFileResult | undefined = syntaxByFile.get(fileId);
    const metrics = metricsByFile.get(fileId);
    if (syntax === undefined) {
      addReason(fileId, SYNTAX_MISSING_TEXT);
      continue;
    }
    if (syntax.status === 'failed') {
      addReason(
        fileId,
        SYNTAX_FAILURE_TEXT[syntax.code] ?? SYNTAX_FAILURE_TEXT['PARSE_INVALID'] ?? '',
      );
      continue;
    }
    const ref = (event: ParserEvent): EvidenceRef => ({ fileId, range: event.range });
    const declarationsByContractModifier = new Map<string, ParserDeclaration>();
    for (const declaration of syntax.declarations) {
      if (declaration.kind === 'modifier' && declaration.contractId !== null) {
        declarationsByContractModifier.set(
          `${declaration.contractId}\u0000${declaration.name}`,
          declaration,
        );
      }
    }

    for (const event of syntax.events) {
      const owner = ownerOf(event.callableId, event.contractId, fileId);
      if (event.kind === 'assembly') {
        store.add('assembly', owner.kind, owner.id, scope, [ref(event)]);
      } else if (event.kind === 'control') {
        const kind = attribute(event.attributes, 'control-kind');
        if (typeof kind === 'string' && LOOP_CONTROL_KINDS.has(kind)) {
          store.add('loops', owner.kind, owner.id, scope, [ref(event)]);
        }
      } else if (event.kind === 'yul-control') {
        if (attribute(event.attributes, 'yul-kind') === 'for') {
          store.add('loops', owner.kind, owner.id, scope, [ref(event)]);
        }
      } else if (event.kind === 'state-variable') {
        const shape = attribute(event.attributes, 'type-shape');
        const mutable =
          attribute(event.attributes, 'constant') !== true &&
          attribute(event.attributes, 'immutable') !== true;
        if (mutable && (shape === 'mapping' || shape === 'array')) {
          store.add('complex-storage-syntax', owner.kind, owner.id, scope, [ref(event)]);
        }
      } else if (event.kind === 'modifier-invocation') {
        const name = attribute(event.attributes, 'name');
        if (typeof name === 'string') {
          const final = lastSegment(name);
          if (PRIVILEGE_MODIFIER_NAMES.has(final)) {
            const evidence: EvidenceRef[] = [ref(event)];
            const extra: string[] = [];
            if (event.contractId !== null) {
              const declaration = declarationsByContractModifier.get(
                `${event.contractId}\u0000${final}`,
              );
              if (declaration !== undefined) {
                evidence.push({ fileId, range: declaration.nameRange });
                extra.push(
                  'A same-contract modifier declaration with the same name is included as evidence; its effect is not assessed.',
                );
              }
            }
            store.add('privilege-name-candidate', owner.kind, owner.id, scope, evidence, extra);
          }
        }
      }
    }

    for (const declaration of syntax.declarations) {
      if (
        declaration.kind === 'function' &&
        declaration.callableId !== null &&
        UPGRADE_FUNCTION_NAMES.has(declaration.name)
      ) {
        const evidence: EvidenceRef[] = [{ fileId, range: declaration.nameRange }];
        const extra: string[] = [];
        if (declaration.contractId !== null) {
          const delegate = delegatecallByContract.get(declaration.contractId);
          if (delegate !== undefined && delegate.length > 0) {
            evidence.push(...delegate);
            extra.push(
              'Same-contract confirmed delegatecall evidence is included as context, not as proof of proxy semantics.',
            );
          }
          const bases = resolvedBaseEvidence.get(declaration.contractId);
          if (bases !== undefined && bases.length > 0) {
            evidence.push(...bases);
            extra.push(
              'Same-contract resolved inheritance evidence is included as context, not as proof of upgrade semantics.',
            );
          }
        }
        store.add(
          'upgrade-name-candidate',
          'callable',
          declaration.callableId,
          scope,
          evidence,
          extra,
        );
      }
    }

    if (metrics === undefined) {
      addReason(fileId, METRICS_MISSING_TEXT);
    } else {
      if (!metrics.file.syntaxComplete) addReason(fileId, SYNTAX_INCOMPLETE_TEXT);
      const shapes = metrics.file.stateVariables.typeShapes;
      if (shapes.status === 'measured') {
        const starts = new Set<number>();
        for (const shape of shapes.value) {
          if (shape.mutable && (shape.shape === 'user-defined' || shape.shape === 'unknown')) {
            starts.add(Number(shape.declarationId.slice(shape.declarationId.lastIndexOf(':') + 1)));
          }
        }
        if (starts.size > 0) {
          addReason(
            fileId,
            STORAGE_UNRESOLVED_TEXT,
            syntax.events
              .filter(
                (event) => event.kind === 'state-variable' && starts.has(event.range.startByte),
              )
              .map(ref),
          );
        }
      }
    }
  }

  // Semantic call-site rules.
  for (const site of relationships.callSites) {
    const scope = includedScope.get(site.fileId);
    if (scope === undefined) continue;
    const owner = ownerOf(site.ownerCallableId, site.ownerContractId, site.fileId);
    if (site.syntax.lowLevelCandidate && site.builtin === 'confirmed') {
      store.add('builtin-low-level', owner.kind, owner.id, scope, callEvidence(site));
    } else if (site.syntax.lowLevelCandidate && site.builtin === 'unknown') {
      addReason(site.fileId, BUILTIN_UNKNOWN_TEXT, callEvidence(site));
    }
    if (
      site.syntax.calleeShape === 'member' &&
      site.symbol === 'unique' &&
      site.dispatch === 'dynamic' &&
      (site.receiver.kind === 'identifier' || site.receiver.kind === 'other') &&
      site.symbolTarget !== null
    ) {
      const target = callablesById.get(site.symbolTarget);
      const targetContract =
        target?.contractId === null || target?.contractId === undefined
          ? undefined
          : contractsById.get(target.contractId);
      if (
        targetContract !== undefined &&
        targetContract.kind !== 'library' &&
        targetContract.id !== site.ownerContractId
      ) {
        store.add('external-boundary-candidate', owner.kind, owner.id, scope, callEvidence(site));
      }
    }
  }

  for (const reference of relationships.imports) {
    const scope = includedScope.get(reference.importerFileId);
    if (scope === undefined || reference.status === 'resolved') continue;
    store.add('unresolved-import', 'file', reference.importerFileId, scope, [
      { fileId: reference.importerFileId, range: reference.range },
    ]);
  }

  for (const component of relationships.components) {
    if (component.status !== 'unavailable' || component.reason === null) continue;
    for (const member of component.members) {
      if (includedScope.has(member)) addReason(member, COMPONENT_REASON_TEXT[component.reason]);
    }
  }
  for (const count of relationships.confirmedBuiltinLowLevelCalls) {
    if (
      includedScope.has(count.fileId) &&
      count.confirmedBuiltinLowLevelCalls.status !== 'measured'
    ) {
      addReason(count.fileId, BUILTIN_TOTAL_TEXT);
    }
  }

  for (const [fileId, set] of reasons) {
    const scope = includedScope.get(fileId);
    if (scope === undefined) continue;
    store.add(
      'file-evidence-incomplete',
      'file',
      fileId,
      scope,
      [...(reasonEvidence.get(fileId)?.values() ?? [])],
      [...set],
    );
  }

  const diagnostics: Diagnostic[] = [];
  const limitations = new Set<string>([
    'Indicators are audit-effort review prompts derived from syntax and names. They are not security findings, severity ratings or proof of protection.',
    'Existing tests and known dependencies earn no automatic trust or effort discount.',
  ]);
  let complete = true;
  let truncatedRows = 0;
  let evidenceTruncated = 0;

  const rows: Indicator[] = [];
  const ruleEvidence = new Map<RuleKey, Map<string, EvidenceRef>>();
  for (const row of store.values()) {
    const rule = ruleDefinition(row.rule);
    const ordered = [...row.evidence.values()].sort(compareEvidence);
    let evidence = ordered;
    const rowLimitations = [
      rule.limitation,
      scopeLimitation(row.scope),
      ...[...row.limitations].sort(compareCodePoints),
    ];
    if (ordered.length > bounds.maxEvidencePerRow) {
      evidence = ordered.slice(0, bounds.maxEvidencePerRow);
      rowLimitations.push(EVIDENCE_TRUNCATED_TEXT);
      evidenceTruncated += 1;
      complete = false;
    }
    const known = ruleEvidence.get(row.rule) ?? new Map<string, EvidenceRef>();
    for (const ref of ordered) known.set(evidenceKey(ref), ref);
    ruleEvidence.set(row.rule, known);

    let finalLimitations = rowLimitations.map(clip);
    if (finalLimitations.length > bounds.maxLimitationsPerRow) {
      finalLimitations = [
        ...finalLimitations.slice(0, bounds.maxLimitationsPerRow - 1),
        LIMITATION_TRUNCATED_TEXT,
      ];
      complete = false;
    }
    rows.push({
      id: `indicator:${row.rule}:${fingerprint([row.rule, row.ownerKind, row.ownerId])}`,
      ruleVersion: INDICATOR_RULE_VERSION,
      category: rule.category,
      evidenceKind: rule.evidenceKind,
      confidence: rule.confidence,
      summary: clip(summaryFor(rule, row.ownerKind, row.scope)),
      evidence,
      limitations: finalLimitations,
      requiresAssessment: rule.requiresAssessment,
    });
  }
  rows.sort((left, right) => compareCodePoints(left.id, right.id));
  const duplicate = rows.find((row, index) => index > 0 && rows[index - 1]?.id === row.id);
  if (duplicate !== undefined) throw new TypeError('Indicator IDs must be unique.');

  const rowBudget = bounds.maxRows - HUMAN_PROMPT_COUNT;
  let retained = rows;
  if (rows.length > rowBudget) {
    truncatedRows = rows.length - rowBudget;
    retained = rows.slice(0, rowBudget);
    complete = false;
    diagnostics.push(
      limitDiagnostic(
        'Indicator rows exceeded the output bound and were truncated.',
        truncatedRows,
      ),
    );
    limitations.add(
      'Indicator rows were truncated at the output bound; the listed rows are not exhaustive.',
    );
  }
  if (evidenceTruncated > 0) {
    diagnostics.push(
      limitDiagnostic(
        'Indicator evidence exceeded the per-row bound and was truncated.',
        evidenceTruncated,
      ),
    );
    limitations.add('Some indicator evidence lists were truncated at the output bound.');
  }
  if ([...store.values()].some((row) => row.rule === 'file-evidence-incomplete')) {
    limitations.add(
      'Some files have incomplete syntax or semantic evidence; missing indicators in them are not measured absence.',
    );
  }

  // Prompts carry related evidence without answering anything.
  const promptSources: Readonly<Record<string, readonly RuleKey[]>> = {
    'external-trust': ['builtin-low-level', 'external-boundary-candidate'],
    'custom-math-cryptography': ['assembly'],
    'upgrade-lifecycle': ['upgrade-name-candidate'],
  };
  const promptEvidence: Partial<Record<HumanPromptKey, readonly EvidenceRef[]>> = {};
  const promptLimitations: Partial<Record<HumanPromptKey, readonly string[]>> = {};
  let promptTruncated = 0;
  for (const [key, sources] of Object.entries(promptSources)) {
    const merged = new Map<string, EvidenceRef>();
    for (const source of sources) {
      for (const [id, ref] of ruleEvidence.get(source) ?? []) merged.set(id, ref);
    }
    const ordered = [...merged.values()].sort(compareEvidence);
    const promptKey = key as HumanPromptKey;
    if (ordered.length > bounds.maxEvidencePerRow) {
      promptEvidence[promptKey] = ordered.slice(0, bounds.maxEvidencePerRow);
      promptLimitations[promptKey] = [EVIDENCE_TRUNCATED_TEXT];
      promptTruncated += 1;
      complete = false;
    } else {
      promptEvidence[promptKey] = ordered;
    }
  }
  if (promptTruncated > 0) {
    diagnostics.push(
      limitDiagnostic(
        'Prompt evidence exceeded the per-row bound and was truncated.',
        promptTruncated,
      ),
    );
  }

  const indicators = [...retained, ...buildHumanPrompts(promptEvidence, promptLimitations)].sort(
    (left, right) => compareCodePoints(left.id, right.id),
  );
  return {
    indicators,
    requiredAnalysisComplete: relationships.requiredAnalysisComplete,
    hasUnknownSemantics: relationships.hasUnknownSemantics,
    complete,
    diagnostics,
    limitations: [...limitations].sort(compareCodePoints),
  };
}
