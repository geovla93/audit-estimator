import type { z } from 'zod';

export type FileId = string & z.$brand<'FileId'>;
export type ContractId = string & z.$brand<'ContractId'>;
export type CallableId = string & z.$brand<'CallableId'>;
export type EdgeId = string & z.$brand<'EdgeId'>;
export type Ownership = 'first-party' | 'third-party' | 'unknown';
export type ScopeRole = 'scoped' | 'context' | 'excluded';
export type DeclarationKind = 'contract' | 'abstract-contract' | 'library' | 'interface';
export type CallableKind =
  | 'function'
  | 'constructor'
  | 'fallback'
  | 'receive'
  | 'modifier'
  | 'free-function';
export type MeasurementSource = 'default' | 'metadata' | 'config' | 'cli';
export type OptionalFields<T> = { readonly [P in keyof T]?: T[P] | undefined };
export interface Position {
  readonly line: number;
  readonly column: number;
}
export interface SourceRange {
  readonly startByte: number;
  readonly endByte: number;
  readonly start: Position;
  readonly end: Position;
}
export interface EvidenceRef {
  readonly fileId: FileId;
  readonly range: SourceRange;
}
export type Measurement<T> =
  | { readonly status: 'measured'; readonly value: T; readonly evidence: readonly EvidenceRef[] }
  | { readonly status: 'unavailable'; readonly reason: string };
export interface StateVariableShape {
  readonly declarationId: string;
  readonly shape: 'elementary' | 'mapping' | 'array' | 'struct' | 'user-defined' | 'unknown';
  readonly mutable: boolean;
}
export interface StateVariables {
  readonly count: Measurement<number>;
  readonly mutableCount: Measurement<number>;
  readonly complexMutableDeclarationIds: Measurement<readonly string[]>;
  readonly typeShapes: Measurement<readonly StateVariableShape[]>;
}
export interface FileScopeEntry {
  readonly fileId: FileId;
  readonly path: string;
  readonly role: ScopeRole;
  readonly ownership: Ownership;
  readonly ownershipEvidence: readonly EvidenceRef[];
  readonly physicalIdentity: string;
  readonly byteHash: string;
}
export interface ScopeManifest {
  readonly entries: readonly FileScopeEntry[];
  readonly scopedFileIds: readonly FileId[];
  readonly contextFileIds: readonly FileId[];
  readonly excludedFileIds: readonly FileId[];
}
interface ImportReferenceBase {
  readonly id: EdgeId;
  readonly importerFileId: FileId;
  readonly specifier: string;
  readonly range: SourceRange;
  readonly candidateFileIds: readonly FileId[];
}
export type ImportReference = ImportReferenceBase &
  (
    | { readonly status: 'resolved'; readonly targetFileId: FileId }
    | { readonly status: 'unresolved' | 'ambiguous'; readonly targetFileId: null }
  );
interface RelationshipBase {
  readonly id: EdgeId;
  readonly kind: 'inheritance' | 'call' | 'import';
  readonly from: string;
  readonly candidateTargets: readonly string[];
  readonly evidence: readonly EvidenceRef[];
}
export type RelationshipResult = RelationshipBase &
  (
    | { readonly resolution: 'resolved-unique'; readonly to: string }
    | { readonly resolution: 'ambiguous' | 'unresolved' | 'unsupported' }
  );
export interface CallableAnalysis {
  readonly id: CallableId;
  readonly fileId: FileId;
  readonly contractId: ContractId | null;
  readonly kind: CallableKind;
  readonly name: string | null;
  readonly range: SourceRange;
  readonly visibilityExplicit: Measurement<string>;
  readonly visibilityEffective: Measurement<string>;
  readonly mutabilityExplicit: Measurement<string>;
  readonly mutabilityEffective: Measurement<string>;
  readonly hasBody: Measurement<boolean>;
  readonly decisions: Measurement<number>;
  readonly loops: Measurement<number>;
  readonly maxLoopDepth: Measurement<number>;
  readonly assemblyBlocks: Measurement<number>;
  readonly yulStatements: Measurement<number>;
  readonly yulCalls: Measurement<number>;
  readonly yulControlFlow: Measurement<number>;
  readonly lowLevelCallCandidates: Measurement<number>;
  readonly modifiersApplied: Measurement<readonly string[]>;
}
export interface ContractAnalysis {
  readonly id: ContractId;
  readonly fileId: FileId;
  readonly kind: DeclarationKind;
  readonly name: string;
  readonly range: SourceRange;
  readonly sourceLines: Measurement<number>;
  readonly callableIds: readonly CallableId[];
  readonly stateVariables: StateVariables;
}
export interface FileAnalysis {
  readonly fileId: FileId;
  readonly role: ScopeRole;
  readonly ownership: Ownership;
  readonly physicalLines: Measurement<number>;
  readonly sourceLines: Measurement<number>;
  readonly declarationCounts: {
    readonly contracts: Measurement<number>;
    readonly abstractContracts: Measurement<number>;
    readonly libraries: Measurement<number>;
    readonly interfaces: Measurement<number>;
  };
  readonly stateVariables: StateVariables;
  readonly decisions: Measurement<number>;
  readonly loops: Measurement<number>;
  readonly maxLoopDepth: Measurement<number>;
  readonly assemblyBlocks: Measurement<number>;
  readonly yulStatements: Measurement<number>;
  readonly yulCalls: Measurement<number>;
  readonly yulControlFlow: Measurement<number>;
  readonly lowLevelCallCandidates: Measurement<number>;
  readonly importIds: readonly EdgeId[];
  readonly contractIds: readonly ContractId[];
  readonly callableIds: readonly CallableId[];
  readonly syntaxComplete: boolean;
}
export interface SyntaxBatch {
  readonly files: readonly FileAnalysis[];
  readonly contracts: readonly ContractAnalysis[];
  readonly callables: readonly CallableAnalysis[];
  readonly imports: readonly ImportReference[];
}
export type DiagnosticCode =
  | 'CONFIG_INVALID'
  | 'TARGET_UNREADABLE'
  | 'EMPTY_SCOPE'
  | 'PATH_BLOCKED'
  | 'LIMIT_EXCEEDED'
  | 'SOURCE_CHANGED'
  | 'LANGUAGE_UNSUPPORTED'
  | 'PARSE_INVALID'
  | 'IMPORT_UNRESOLVED'
  | 'SEMANTICS_UNAVAILABLE'
  | 'OWNERSHIP_UNKNOWN'
  | 'PARTIAL_ANALYSIS'
  | 'OUTPUT_FAILED'
  | 'INTERNAL_ERROR';
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: 'info' | 'warning' | 'error';
  readonly phase:
    | 'config'
    | 'discovery'
    | 'parse'
    | 'semantics'
    | 'metrics'
    | 'estimate'
    | 'report';
  readonly message: string;
  readonly fileId?: FileId | undefined;
  readonly range?: SourceRange | undefined;
  readonly details?:
    | readonly { readonly key: string; readonly value: string | number | boolean | null }[]
    | undefined;
}
export interface Indicator {
  readonly id: string;
  readonly ruleVersion: string;
  readonly category: string;
  readonly evidenceKind: 'measured' | 'heuristic' | 'human';
  readonly confidence: 'high' | 'medium' | 'low' | 'not-assessed';
  readonly summary: string;
  readonly evidence: readonly EvidenceRef[];
  readonly limitations: readonly string[];
  readonly requiresAssessment: boolean;
}
export interface AnalysisLimits {
  readonly maxFileBytes: number;
  readonly maxTotalSourceBytes: number;
  readonly maxFiles: number;
  readonly maxFsEntries: number;
  readonly maxDirectoryDepth: number;
  readonly maxImports: number;
  readonly maxGraphEdges: number;
  readonly maxAstNodesPerFile: number;
  readonly maxAstNodesTotal: number;
  readonly maxPatternsPerList: number;
  readonly maxPatternLength: number;
  readonly maxGlobStates: number;
  readonly maxMetadataBytes: number;
  readonly maxLcovBytes: number;
  readonly parseTimeoutMs: number;
  readonly maxSemanticFiles: number;
  readonly maxSemanticBytes: number;
  readonly semanticTimeoutMs: number;
  readonly analysisTimeoutMs: number;
}
export interface ScopeSettings {
  readonly sourceRoots: readonly string[];
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly defaultExcludes: boolean;
  readonly thirdPartyRoots: readonly string[];
  readonly firstPartyOverrides: readonly string[];
  readonly followSymlinks: boolean;
}
export interface Remapping {
  readonly context?: string | undefined;
  readonly prefix: string;
  readonly target: string;
}
export interface ManualAdjustment {
  readonly id: string;
  readonly reason: string;
  readonly category: string;
  readonly lowHours: number;
  readonly highHours: number;
}
export interface ParameterRange {
  readonly low: number;
  readonly high: number;
}
export interface ModelParameters {
  readonly projectHours: ParameterRange;
  readonly slocHours: ParameterRange;
  readonly controlPremium: ParameterRange;
  readonly storagePremium: ParameterRange;
  readonly evmPremium: ParameterRange;
  readonly interactionHours: ParameterRange;
  readonly boundaryHours: ParameterRange;
  readonly unknownReserveHigh: number;
  readonly hoursPerDay: number;
}
export interface ModelProfile {
  readonly profile: 'heuristic-v1';
  readonly modelVersion: '1.0.0';
  readonly parameters: ModelParameters;
}
export interface ConfigInput {
  readonly configVersion: '1.0.0';
  readonly scope?: OptionalFields<ScopeSettings> | undefined;
  readonly imports?: { readonly remappings: readonly Remapping[] } | undefined;
  readonly solidity?: { readonly version: string } | undefined;
  readonly analysis?: { readonly limits: OptionalFields<AnalysisLimits> } | undefined;
  readonly model?:
    | {
        readonly profile: 'heuristic-v1';
        readonly modelVersion?: '1.0.0' | undefined;
        readonly parameters?: OptionalFields<ModelParameters> | undefined;
      }
    | undefined;
  readonly manualAdjustments?: readonly ManualAdjustment[] | undefined;
  readonly coverage?: { readonly lcovPath: string } | undefined;
  readonly report?: { readonly format: 'json' | 'markdown' | 'terminal' } | undefined;
}
export interface ResolvedConfig {
  readonly configVersion: '1.0.0';
  readonly scope: ScopeSettings;
  readonly imports: { readonly remappings: readonly Remapping[] };
  readonly solidity: { readonly version: string };
  readonly analysis: { readonly limits: AnalysisLimits };
  readonly model: ModelProfile;
  readonly manualAdjustments: readonly ManualAdjustment[];
  readonly coverage: { readonly lcovPath: string | null };
  readonly report: { readonly format: 'json' | 'markdown' | 'terminal' };
  readonly provenance: readonly { readonly field: string; readonly source: MeasurementSource }[];
}
export interface EstimateInput {
  readonly eligibleFiles: readonly {
    readonly fileId: FileId;
    readonly sourceLines: Measurement<number>;
    readonly stateVariables: StateVariables;
    readonly decisions: Measurement<number>;
    readonly assemblyBlocks: Measurement<number>;
    readonly confirmedBuiltinLowLevelCalls: Measurement<number>;
  }[];
  readonly scopedPairs: readonly { readonly leftId: string; readonly rightId: string }[];
  readonly contextPairs: readonly { readonly leftId: string; readonly rightId: string }[];
  readonly requiredAnalysisComplete: boolean;
  readonly hasUnknownSemantics: boolean;
  readonly allowPartial: boolean;
  readonly model: ModelProfile;
  readonly manualAdjustments: readonly ManualAdjustment[];
}
export interface EstimateResult {
  readonly profile: 'heuristic-v1';
  readonly modelVersion: '1.0.0';
  readonly label: 'uncalibrated heuristic';
  readonly coverage: 'full' | 'analyzed-subset';
  readonly auditorHours: ParameterRange;
  readonly auditorDays: ParameterRange;
  readonly contributions: readonly {
    readonly id: string;
    readonly category: string;
    readonly lowMicrohours: number;
    readonly highMicrohours: number;
    readonly inputStatus: 'measured' | 'unavailable' | 'manual';
    readonly explanation: string;
  }[];
  readonly assumptions: readonly string[];
  readonly manualAdjustments: readonly ManualAdjustment[];
  readonly parameters: ModelParameters;
}
export interface Analysis {
  readonly files: readonly FileAnalysis[];
  readonly contracts: readonly ContractAnalysis[];
  readonly callables: readonly CallableAnalysis[];
  readonly aggregates: {
    readonly scopedFiles: Measurement<number>;
    readonly physicalLines: Measurement<number>;
    readonly sourceLines: Measurement<number>;
    readonly contracts: Measurement<number>;
    readonly callables: Measurement<number>;
  };
  readonly graphs: readonly RelationshipResult[];
  readonly indicators: readonly Indicator[];
  readonly testObservations: readonly {
    readonly path: string;
    readonly present: Measurement<boolean>;
  }[];
  readonly coverageObservation: {
    readonly source: string | null;
    readonly coveredLines: Measurement<number>;
    readonly totalLines: Measurement<number>;
  } | null;
  readonly completeness: {
    readonly requiredAnalysisComplete: boolean;
    readonly hasUnknownSemantics: boolean;
    readonly analyzedFileIds: readonly FileId[];
    readonly unavailableFileIds: readonly FileId[];
  };
}
export interface ReportEnvelope {
  readonly schemaVersion: '1.0.0';
  readonly toolVersion: string;
  readonly command: 'estimate' | 'inspect' | 'explain';
  readonly status: 'complete' | 'partial' | 'error';
  readonly failureCategory: 'config' | 'target' | 'analysis' | 'output' | 'internal' | null;
  readonly versions: {
    readonly parser: string;
    readonly metrics: string;
    readonly indicators: string;
    readonly model: string;
  };
  readonly fingerprints: {
    readonly sources: string | null;
    readonly semanticConfig: string | null;
    readonly analysis: string | null;
  };
  readonly scope: ScopeManifest;
  readonly analysis: Analysis | null;
  readonly estimate: EstimateResult | null;
  readonly fullScopeEstimate: EstimateResult | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly limitations: readonly string[];
}

/** Parser/worker-owned source data. Never serialize it into a public report. */
export interface SourceSnapshot {
  readonly canonicalPath: string;
  readonly absolutePath: string;
  readonly originalBytes: Uint8Array;
  readonly originalText: string;
  readonly byteHash: string;
}
/** Internal union inputs prevent overlapping contract ranges from inflating file SLOC. */
export interface SourceLineSet {
  readonly fileId: FileId;
  readonly oneBasedLines: ReadonlySet<number>;
}
export interface SyntaxEvent {
  readonly fileId: FileId;
  readonly kind: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly evidence: readonly EvidenceRef[];
}
