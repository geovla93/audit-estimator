import type {
  CallableId,
  ContractId,
  Diagnostic,
  EdgeId,
  EvidenceRef,
  FileId,
  ImportReference,
  Measurement,
  RelationshipResult,
  ScopeManifest,
  SourceRange,
} from '../domain/types.ts';
import type { ParserBatch, ParserSource } from '../parser/protocol.ts';
import type { RemappingSourceKind } from './remappings.ts';

/** Source-internal relationship DTOs. These are not package exports or public schema fields. */

export type ImportStrategy = 'relative' | 'direct' | 'remapped';

export type ImportFailureReason =
  | 'invalid-specifier'
  | 'outside-root'
  | 'remapping-conflict'
  | 'remapped-target-missing'
  | 'not-found'
  | 'ambiguous-candidates'
  | 'blocked-candidate'
  | 'unreadable'
  | 'source-changed'
  | 'importer-unavailable'
  | 'metadata-invalid'
  | 'limit'
  | 'deadline';

export interface AppliedRemappingProvenance {
  readonly source: RemappingSourceKind;
  readonly context: string | null;
  readonly prefix: string;
  readonly target: string;
  /** Lookup path after the single remapping application, or null when not representable. */
  readonly resolvedName: string | null;
}

export interface ImportProbe {
  readonly path: string;
  readonly origin: 'root' | 'node-modules' | 'lib' | 'remapped' | 'relative';
  readonly outcome: 'found' | 'missing' | 'blocked';
  /** Fixed safe-path reason when blocked, otherwise null. */
  readonly reason: string | null;
  /** Canonical file ID for a found physical file, otherwise null. */
  readonly fileId: FileId | null;
}

/** Per-import resolution evidence. Original decoded specifier, lookup name and final file ID stay separate. */
export interface ImportObservation {
  readonly importId: EdgeId;
  readonly importerFileId: FileId;
  readonly specifier: string;
  readonly range: SourceRange;
  readonly specifierRange: SourceRange;
  readonly lookupName: string | null;
  readonly strategy: ImportStrategy | null;
  readonly remapping: AppliedRemappingProvenance | null;
  readonly conflictingRemappings: readonly AppliedRemappingProvenance[];
  readonly probes: readonly ImportProbe[];
  readonly candidateFileIds: readonly FileId[];
  readonly status: 'resolved' | 'unresolved' | 'ambiguous';
  readonly targetFileId: FileId | null;
  readonly reason: ImportFailureReason | null;
}

export type ComponentUnavailableReason =
  | 'member-syntax-failed'
  | 'unresolved-import'
  | 'no-common-grammar'
  | 'authority-excludes-grammar'
  | 'component-too-large'
  | 'no-scoped-member'
  | 'semantics-failed'
  | 'semantics-limit'
  | 'semantics-cancelled';

export interface ComponentObservation {
  readonly id: FileId;
  readonly members: readonly FileId[];
  readonly grammar: string | null;
  readonly status: 'available' | 'unavailable';
  readonly reason: ComponentUnavailableReason | null;
}

export type StaticDispatch = 'static' | 'dynamic' | 'unknown' | 'not-applicable';
export type SymbolStatus =
  | 'unique'
  | 'candidates'
  | 'none'
  | 'builtin'
  | 'type-conversion'
  | 'non-callable'
  | 'unavailable';
export type BuiltinClassification = 'confirmed' | 'rejected' | 'unknown';
export type CallLimitation =
  | 'none'
  | 'overloads-or-alias-candidates'
  | 'function-pointer-or-variable'
  | 'virtual-dispatch-unproven'
  | 'external-receiver-unproven'
  | 'this-or-super-dispatch'
  | 'builtin-member'
  | 'type-conversion'
  | 'unbound-reference'
  | 'complex-callee'
  | 'semantics-unavailable';

export type CallDefinition =
  | { readonly kind: 'builtin' }
  | {
      readonly kind: 'user';
      readonly fileId: FileId;
      readonly nameRange: SourceRange;
      readonly definiens: string;
      /** Verified callable declaration at that name, otherwise null. */
      readonly callableId: CallableId | null;
      /** Verified contract-like declaration at that name, otherwise null. */
      readonly contractId: ContractId | null;
    };

export interface CallReceiver {
  readonly kind: 'none' | 'this' | 'super' | 'identifier' | 'other';
  readonly definitions: readonly CallDefinition[];
}

/** One semantic call-site fact. Symbol resolution and dispatch are deliberately separate. */
export interface CallSiteFact {
  readonly id: EdgeId;
  readonly fileId: FileId;
  readonly range: SourceRange;
  readonly ownerCallableId: CallableId | null;
  readonly ownerContractId: ContractId | null;
  readonly syntax: {
    readonly calleeShape: string;
    readonly memberName: string | null;
    readonly lowLevelCandidate: boolean;
  };
  readonly calleeKind: string;
  readonly definitions: readonly CallDefinition[];
  readonly receiver: CallReceiver;
  readonly symbol: SymbolStatus;
  /** Unique verified callable definition, kept even when dispatch is unproven. */
  readonly symbolTarget: CallableId | null;
  readonly candidateTargets: readonly CallableId[];
  readonly dispatch: StaticDispatch;
  /** Null unless the syntax layer flagged this site as a low-level call candidate. */
  readonly builtin: BuiltinClassification | null;
  readonly limitation: CallLimitation;
  readonly evidence: readonly EvidenceRef[];
  /** Public edge row id; null when the site stays companion-only. */
  readonly edgeId: EdgeId | null;
}

export type DirectBaseResolution = 'resolved-unique' | 'ambiguous' | 'unresolved';

export interface DirectBaseEdge {
  readonly id: EdgeId;
  readonly contractId: ContractId;
  readonly ordinal: number;
  readonly resolution: DirectBaseResolution;
  readonly baseContractId: ContractId | null;
  readonly candidateContractIds: readonly ContractId[];
  readonly evidence: readonly EvidenceRef[];
}

export type InheritanceUnavailableReason =
  | 'unresolved-base'
  | 'inheritance-cycle'
  | 'semantics-unavailable'
  | 'graph-limit';

export interface ContractInheritance {
  readonly contractId: ContractId;
  readonly fileId: FileId;
  /** Declared-order direct base edge IDs. */
  readonly directBaseEdgeIds: readonly EdgeId[];
  readonly ancestorIds: Measurement<readonly ContractId[]>;
  readonly maxDepth: Measurement<number>;
  /** Declaration references in ancestors; not effective member visibility, overrides or dispatch. */
  readonly ancestorDeclaredCallableIds: Measurement<readonly CallableId[]>;
}

export type PairKind = 'inheritance' | 'call';

export interface ContractPair {
  readonly leftId: ContractId;
  readonly rightId: ContractId;
  readonly kinds: readonly PairKind[];
  readonly evidence: readonly EvidenceRef[];
}

export interface FileBuiltinCount {
  readonly fileId: FileId;
  readonly confirmedBuiltinLowLevelCalls: Measurement<number>;
}

/** Closure-phase output. Semantic fields are added by `resolveRelationships`. */
export interface ImportClosureResult {
  readonly manifest: ScopeManifest;
  readonly sources: readonly ParserSource[];
  readonly syntax: ParserBatch;
  readonly imports: readonly ImportReference[];
  readonly importObservations: readonly ImportObservation[];
  readonly importCycles: readonly (readonly FileId[])[];
  readonly invalidatedScopedFileIds: readonly FileId[];
  readonly diagnostics: readonly Diagnostic[];
  /** True when every required import resolved uniquely and every closure file parsed. */
  readonly closureComplete: boolean;
  /** True when work was stopped by a resource or deadline limit. */
  readonly stopped: boolean;
  readonly remappingSource: RemappingSourceKind;
  readonly activeRemappings: readonly {
    readonly context: string | null;
    readonly prefix: string;
    readonly target: string;
  }[];
}

export interface RelationshipAnalysis {
  readonly manifest: ScopeManifest;
  readonly sources: readonly ParserSource[];
  readonly syntax: ParserBatch;
  readonly imports: readonly ImportReference[];
  readonly graphs: readonly RelationshipResult[];
  readonly importObservations: readonly ImportObservation[];
  readonly importCycles: readonly (readonly FileId[])[];
  readonly components: readonly ComponentObservation[];
  readonly inheritance: readonly ContractInheritance[];
  readonly directBaseEdges: readonly DirectBaseEdge[];
  readonly callSites: readonly CallSiteFact[];
  readonly scopedPairs: readonly ContractPair[];
  readonly contextPairs: readonly ContractPair[];
  readonly confirmedBuiltinLowLevelCalls: readonly FileBuiltinCount[];
  readonly invalidatedScopedFileIds: readonly FileId[];
  readonly diagnostics: readonly Diagnostic[];
  readonly requiredAnalysisComplete: boolean;
  readonly hasUnknownSemantics: boolean;
  readonly fingerprint: string;
}
