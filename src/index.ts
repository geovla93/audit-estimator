export { TOOL_VERSION } from './version.ts';
export {
  REPORT_SCHEMA_VERSION,
  CONFIG_SCHEMA_VERSION,
  METRICS_VERSION,
  INDICATORS_VERSION,
  MODEL_PROFILE,
  MODEL_VERSION,
  LEGACY_MODEL_VERSION,
} from './domain/versions.ts';
export type {
  FileId,
  ContractId,
  CallableId,
  EdgeId,
  EvidenceRef,
  SourceRange,
  FileScopeEntry,
  ScopeManifest,
  SyntaxBatch,
  FileAnalysis,
  ContractAnalysis,
  CallableAnalysis,
  ImportReference,
  RelationshipResult,
  Indicator,
  EstimateInput,
  EstimateResult,
  Diagnostic,
  ConfigInput,
  ResolvedConfig,
  ModelProfile,
  ModelVersion,
  EstimationScopeInput,
  EstimationScopeSelector,
  EstimationScopeAnalysis,
  ReviewSummary,
  ReportEnvelope,
} from './domain/schemas.ts';
export { estimateEffort } from './estimation/estimate.ts';
export { EstimationError, selectModel } from './estimation/model.ts';
export type { EstimationErrorReason } from './estimation/model.ts';
export { serializeJson } from './reporting/json.ts';
export { formatTerminal } from './reporting/terminal.ts';
export type { TerminalFormatOptions } from './reporting/terminal.ts';
export { formatMarkdown } from './reporting/markdown.ts';
export { analyzeProject } from './application/analyze.ts';
export type { AnalyzeRequest, AnalyzeOptions, AnalyzeOutcome } from './application/analyze.ts';
