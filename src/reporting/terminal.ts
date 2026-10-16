import type {
  Analysis,
  CallableAnalysis,
  ContractAnalysis,
  Diagnostic,
  EstimateResult,
  EvidenceRef,
  FileAnalysis,
  Indicator,
  Measurement,
  ParameterRange,
  ReportEnvelope,
  RelationshipResult,
  SourceRange,
  StateVariables,
} from '../domain/types.ts';
import { canonicalDisplayValue, parseDisplayEnvelope } from './display.ts';
import { sanitizeTerminalText } from './sanitize.ts';

export interface TerminalFormatOptions {
  readonly detail?: boolean | undefined;
  readonly color?: boolean | undefined;
}

const ANSI_RESET = '\u001b[0m';
const ANSI_BOLD = '\u001b[1m';
const ANSI_GREEN = '\u001b[32m';
const ANSI_YELLOW = '\u001b[33m';
const ANSI_RED = '\u001b[31m';

function safe(value: string): string {
  return sanitizeTerminalText(value);
}

function number(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}

function range(value: ParameterRange): string {
  return `${number(value.low)} to ${number(value.high)}`;
}

function measurement<T>(
  value: Measurement<T>,
  render: (item: T) => string,
  includeEvidence = false,
): string {
  if (value.status === 'unavailable') return `unavailable (${safe(value.reason)})`;
  const evidenceText = includeEvidence ? `; evidence: ${evidenceList(value.evidence)}` : '';
  return `measured ${render(value.value)}${evidenceText}`;
}

function measurementDetail<T>(value: Measurement<T>, render: (item: T) => string): string {
  return measurement(value, render, true);
}

function evidence(reference: EvidenceRef): string {
  return `${safe(reference.fileId)} ${formatRange(reference.range)}`;
}

function formatRange(value: SourceRange): string {
  return `${number(value.start.line)}:${number(value.start.column)}-${number(value.end.line)}:${number(value.end.column)} [bytes ${number(value.startByte)}-${number(value.endByte)}]`;
}

function evidenceList(values: readonly EvidenceRef[]): string {
  return values.length === 0 ? 'none supplied' : values.map(evidence).join('; ');
}

function values(items: readonly string[]): string {
  return items.length === 0 ? 'none' : items.map(safe).join(', ');
}

function listSection(title: string, rows: readonly string[]): string {
  return `${title}\n${rows.length === 0 ? '  none supplied' : rows.map((row) => `  - ${row}`).join('\n')}`;
}

function coloredStatus(status: ReportEnvelope['status'], enabled: boolean): string {
  if (!enabled) return status;
  const color = status === 'complete' ? ANSI_GREEN : status === 'partial' ? ANSI_YELLOW : ANSI_RED;
  return `${color}${status}${ANSI_RESET}`;
}

function amountOfFiles(analysis: Analysis): number {
  return analysis.files.filter((file) => file.role === 'scoped' && file.syntaxComplete).length;
}

function aggregate(name: string, value: Measurement<number>, unit: string): string {
  return `${name}: ${measurement(value, (item) => `${number(item)}${unit}`)}`;
}

function stateVariableSummary(state: StateVariables): string {
  return `declared ${measurement(state.count, number)}, mutable ${measurement(state.mutableCount, number)}`;
}

function graphSummary(analysis: Analysis): string[] {
  const counts = new Map<string, number>();
  for (const graph of analysis.graphs) {
    counts.set(graph.resolution, (counts.get(graph.resolution) ?? 0) + 1);
  }
  const kinds = ['resolved-unique', 'ambiguous', 'unresolved', 'unsupported'];
  return kinds.map((kind) => `${kind}: ${number(counts.get(kind) ?? 0)}`);
}

function readinessSummary(analysis: Analysis): string[] {
  const rows = analysis.testObservations.map(
    (observation) => `${safe(observation.path)}: ${measurement(observation.present, String)}`,
  );
  if (analysis.coverageObservation !== null) {
    const source =
      analysis.coverageObservation.source === null
        ? 'source unavailable'
        : `source ${safe(analysis.coverageObservation.source)}`;
    rows.push(
      `${source}; covered lines ${measurement(analysis.coverageObservation.coveredLines, number)}; total lines ${measurement(analysis.coverageObservation.totalLines, number)}; supplied matched subset, provenance unverified`,
    );
  }
  return rows;
}

function diagnosticLine(item: Diagnostic): string {
  const location = item.fileId === undefined ? '' : `; file ${safe(item.fileId)}`;
  const rangeText = item.range === undefined ? '' : ` ${formatRange(item.range)}`;
  const details =
    item.details === undefined
      ? ''
      : `; details ${item.details.map((detail) => `${safe(detail.key)}=${safe(String(detail.value))}`).join(', ')}`;
  return `${item.severity}/${item.phase}/${item.code}: ${safe(item.message)}${location}${rangeText}${details}`;
}

function renderWarnings(envelope: ReportEnvelope): string {
  const diagnostics = envelope.diagnostics.map(diagnosticLine);
  const limitations = envelope.limitations.map((item) => `limitation: ${safe(item)}`);
  return listSection('Diagnostics and limitations', [...diagnostics, ...limitations]);
}

function renderHeader(envelope: ReportEnvelope, color: boolean): string {
  const heading = color ? `${ANSI_BOLD}Audit report${ANSI_RESET}` : 'Audit report';
  const status = coloredStatus(envelope.status, color);
  const failure =
    envelope.failureCategory === null ? '' : `; failure category: ${envelope.failureCategory}`;
  return `${heading}\nCommand: ${envelope.command}; status: ${status}${failure}`;
}

function renderEstimateSummary(estimate: EstimateResult): string {
  return [
    `Auditor effort scenario: ${range(estimate.auditorHours)} auditor hours; ${range(estimate.auditorDays)} auditor days.`,
    `${safe(estimate.label)}. Effort, not elapsed delivery time. Scenario bounds have no probability or accuracy claim.`,
  ].join('\n');
}

function renderEstimateAvailability(envelope: ReportEnvelope): string | null {
  if (envelope.command === 'inspect') return null;
  if (envelope.estimate !== null) return renderEstimateSummary(envelope.estimate);
  const reasons = [
    ...envelope.diagnostics.map((item) => safe(item.message)),
    ...envelope.limitations.map(safe),
  ];
  const reason = reasons.length === 0 ? 'reason not supplied' : reasons.join('; ');
  return `Effort unavailable: ${reason}`;
}

function renderOverview(envelope: ReportEnvelope): string {
  if (envelope.analysis === null) return '';
  const scoped = envelope.scope.entries.filter((entry) => entry.role === 'scoped').length;
  const context = envelope.scope.entries.filter((entry) => entry.role === 'context').length;
  const excluded = envelope.scope.entries.filter((entry) => entry.role === 'excluded').length;
  const unavailable = envelope.analysis.completeness.unavailableFileIds;
  const rows = [
    `Manifest scoped entries: ${number(scoped)}`,
    `Manifest context entries: ${number(context)}`,
    `Manifest excluded entries: ${number(excluded)}`,
    `Syntax-complete scoped records: ${number(amountOfFiles(envelope.analysis))}`,
    `Reported unavailable IDs: ${unavailable.length === 0 ? 'none' : values(unavailable)}`,
    `Required analysis complete: ${String(envelope.analysis.completeness.requiredAnalysisComplete)}`,
    `Unknown semantics reported: ${String(envelope.analysis.completeness.hasUnknownSemantics)}`,
  ];
  return listSection('Scope and completeness', rows);
}

function renderAggregates(analysis: Analysis): string {
  const aggregates = analysis.aggregates;
  return listSection('Scoped aggregates', [
    aggregate('Scoped files', aggregates.scopedFiles, ''),
    aggregate('Physical lines', aggregates.physicalLines, ''),
    aggregate('Source lines', aggregates.sourceLines, ' SLOC'),
    aggregate('Contracts', aggregates.contracts, ''),
    aggregate('Callables', aggregates.callables, ''),
  ]);
}

function filePath(envelope: ReportEnvelope, fileId: string): string {
  return envelope.scope.entries.find((entry) => entry.fileId === fileId)?.path ?? fileId;
}

function lineCount(value: Measurement<number>): string {
  return value.status === 'measured' ? number(value.value) : `unavailable (${safe(value.reason)})`;
}

function renderEstimationScope(analysis: Analysis): string | null {
  const scope = analysis.estimationScope;
  if (scope === undefined) return null;
  const contracts = scope.mode === 'contracts';
  const rows = [
    contracts
      ? `Mode: caller-selected contracts; reason: ${safe(scope.reason ?? 'not supplied')}`
      : 'Mode: every eligible declaration',
    `Source lines: raw ${lineCount(scope.rawSourceLines)}; effective review ${lineCount(scope.reviewSourceLines)}; content-reused ${lineCount(scope.reusedSourceLines)}; caller-excluded ${lineCount(scope.outOfScopeSourceLines)}`,
    `Full-review declarations: ${number(scope.selectedContractIds.length)}; ${contracts ? 'caller-excluded context' : 'content-reused'} declarations: ${number(scope.contextContractIds.length)}`,
    `Requested scope complete: ${String(scope.requestedScopeComplete)}`,
    'Retained integration work: directed relationships between full-review and context code keep a boundary allowance.',
  ];
  if (scope.scopeNarrowed) {
    rows.push(
      'The requested contracts were resolved; the whole physical scope was not priced. Caller-excluded declarations are caller-selected context, not verified libraries.',
    );
  }
  return listSection('Estimation scope', rows);
}

function renderContracts(envelope: ReportEnvelope, analysis: Analysis): string {
  const rows = analysis.contracts.map((contract) => {
    const name = safe(contract.name);
    return `${safe(contract.id)} | ${safe(filePath(envelope, contract.fileId))} | ${name} | ${contract.kind} | SLOC ${measurement(contract.sourceLines, number)} | ${stateVariableSummary(contract.stateVariables)}`;
  });
  return listSection(
    'Contracts (ID | path | name | declaration kind | SLOC | state variables)',
    rows,
  );
}

function renderGraphSummary(analysis: Analysis): string {
  return listSection('Graph resolution counts', graphSummary(analysis));
}

function renderAssessmentIndicators(analysis: Analysis): string {
  const indicators = analysis.indicators.filter((indicator) => indicator.requiresAssessment);
  return listSection(
    'Indicators requiring human assessment',
    indicators.map(
      (indicator) =>
        `${safe(indicator.id)} (${safe(indicator.category)}): ${safe(indicator.summary)}`,
    ),
  );
}

function renderReadiness(analysis: Analysis): string {
  const rows = readinessSummary(analysis);
  if (rows.length === 0) rows.push('No readiness measurements supplied.');
  else rows.push('Readiness observations are not a security score and do not change effort.');
  return listSection('Readiness observations', rows);
}

function renderSummary(envelope: ReportEnvelope): string[] {
  const sections = [renderOverview(envelope)];
  if (envelope.analysis !== null) {
    sections.push(renderAggregates(envelope.analysis));
    const scope = renderEstimationScope(envelope.analysis);
    if (scope !== null) sections.push(scope);
    sections.push(renderContracts(envelope, envelope.analysis));
    sections.push(renderGraphSummary(envelope.analysis));
    sections.push(renderAssessmentIndicators(envelope.analysis));
    sections.push(renderReadiness(envelope.analysis));
  }
  for (const [title, estimate] of [
    ['estimate', envelope.estimate],
    ['full-scope estimate', envelope.fullScopeEstimate],
  ] as const) {
    if (estimate === null) continue;
    const omitted = estimate.contributions.filter(
      (row) =>
        row.inputStatus === 'unavailable' && row.lowMicrohours === 0 && row.highMicrohours === 0,
    );
    if (omitted.length > 0) {
      sections.push(
        listSection(
          `Omitted premiums in ${title} (zero values are not observed zero)`,
          omitted.map((row) => `${safe(row.category)}: ${safe(row.explanation)}`),
        ),
      );
    }
  }
  sections.push(renderWarnings(envelope));
  return sections;
}

function renderScopeDetail(envelope: ReportEnvelope): string {
  const entries = envelope.scope.entries.map(
    (entry) =>
      `${safe(entry.path)} | role ${entry.role} | ownership ${entry.ownership} | ID ${safe(entry.fileId)} | ownership evidence ${evidenceList(entry.ownershipEvidence)}`,
  );
  return listSection(
    'Manifest entries (path | role | ownership | file ID | ownership evidence)',
    entries,
  );
}

function renderStateVariables(state: StateVariables, detail = false): string[] {
  const render = detail ? measurementDetail : measurement;
  return [
    `state variable count: ${render(state.count, number)}`,
    `mutable state variable count: ${render(state.mutableCount, number)}`,
    `complex mutable declaration IDs: ${render(state.complexMutableDeclarationIds, values)}`,
    `type shapes: ${render(state.typeShapes, (items) => items.map((item) => `${safe(item.declarationId)} ${item.shape} mutable=${String(item.mutable)}`).join('; ') || 'none')}`,
  ];
}

function fileMetrics(file: FileAnalysis): string[] {
  const declarationCounts = file.declarationCounts;
  const rows = [
    `physical lines: ${measurementDetail(file.physicalLines, number)}`,
    `source lines: ${measurementDetail(file.sourceLines, number)}`,
    `contracts: ${measurementDetail(declarationCounts.contracts, number)}`,
    `abstract contracts: ${measurementDetail(declarationCounts.abstractContracts, number)}`,
    `libraries: ${measurementDetail(declarationCounts.libraries, number)}`,
    `interfaces: ${measurementDetail(declarationCounts.interfaces, number)}`,
    ...renderStateVariables(file.stateVariables, true),
    `decisions: ${measurementDetail(file.decisions, number)}`,
    `loops: ${measurementDetail(file.loops, number)}`,
    `maximum loop depth: ${measurementDetail(file.maxLoopDepth, number)}`,
    `assembly blocks: ${measurementDetail(file.assemblyBlocks, number)}`,
    `Yul statements: ${measurementDetail(file.yulStatements, number)}`,
    `Yul calls: ${measurementDetail(file.yulCalls, number)}`,
    `Yul control flow: ${measurementDetail(file.yulControlFlow, number)}`,
    `low-level call candidates: ${measurementDetail(file.lowLevelCallCandidates, number)}`,
    `import IDs: ${values(file.importIds)}`,
    `contract IDs: ${values(file.contractIds)}`,
    `callable IDs: ${values(file.callableIds)}`,
    `syntax complete: ${String(file.syntaxComplete)}`,
  ];
  return rows;
}

function renderFiles(envelope: ReportEnvelope, analysis: Analysis): string {
  const rows = analysis.files.map((file) => {
    const summary = `${safe(filePath(envelope, file.fileId))} | role ${file.role} | ownership ${file.ownership} | ID ${safe(file.fileId)}`;
    return `${summary}\n${fileMetrics(file)
      .map((item) => `    ${item}`)
      .join('\n')}`;
  });
  return listSection('File metrics', rows);
}

function renderContractsDetail(envelope: ReportEnvelope, analysis: Analysis): string {
  const rows = analysis.contracts.map((contract: ContractAnalysis) => {
    const header = `${safe(contract.name)} | ${contract.kind} | ${safe(filePath(envelope, contract.fileId))} | ID ${safe(contract.id)} | range ${formatRange(contract.range)}`;
    return `${header}\n    source lines: ${measurementDetail(contract.sourceLines, number)}\n    callable IDs: ${values(contract.callableIds)}\n${renderStateVariables(
      contract.stateVariables,
      true,
    )
      .map((item) => `    ${item}`)
      .join('\n')}`;
  });
  return listSection('Contract metrics', rows);
}

function renderCallables(analysis: Analysis): string {
  const rows = analysis.callables.map((callable: CallableAnalysis) => {
    const name = callable.name === null ? '(name unavailable)' : safe(callable.name);
    return [
      `${name} | ${callable.kind} | ID ${safe(callable.id)} | contract ${callable.contractId === null ? 'none' : safe(callable.contractId)} | file ${safe(callable.fileId)} | range ${formatRange(callable.range)}`,
      `visibility explicit: ${measurementDetail(callable.visibilityExplicit, safe)}; effective: ${measurementDetail(callable.visibilityEffective, safe)}`,
      `mutability explicit: ${measurementDetail(callable.mutabilityExplicit, safe)}; effective: ${measurementDetail(callable.mutabilityEffective, safe)}`,
      `body: ${measurementDetail(callable.hasBody, String)}`,
      `decisions: ${measurementDetail(callable.decisions, number)}; loops: ${measurementDetail(callable.loops, number)}; maximum loop depth: ${measurementDetail(callable.maxLoopDepth, number)}`,
      `assembly blocks: ${measurementDetail(callable.assemblyBlocks, number)}; Yul statements: ${measurementDetail(callable.yulStatements, number)}; Yul calls: ${measurementDetail(callable.yulCalls, number)}; Yul control flow: ${measurementDetail(callable.yulControlFlow, number)}`,
      `low-level call candidates: ${measurementDetail(callable.lowLevelCallCandidates, number)}`,
      `modifiers applied (supplied order): ${measurementDetail(callable.modifiersApplied, values)}`,
    ].join('\n    ');
  });
  return listSection('Callable metrics', rows);
}

function graphEndpoints(graph: RelationshipResult): string {
  const target = 'to' in graph ? graph.to : '(no resolved target)';
  return `from ${safe(graph.from)} to ${safe(target)}; candidates ${values(graph.candidateTargets)}`;
}

function renderGraphs(analysis: Analysis): string {
  const rows = analysis.graphs.map(
    (graph) =>
      `${safe(graph.id)} | ${graph.kind} | ${graph.resolution} | ${graphEndpoints(graph)} | evidence ${evidenceList(graph.evidence)}`,
  );
  return listSection('Graph relationships', rows);
}

function renderIndicators(analysis: Analysis): string {
  const rows = analysis.indicators.map((indicator: Indicator) => {
    return `${safe(indicator.id)} | ${safe(indicator.category)} | ${indicator.evidenceKind} | confidence ${indicator.confidence} | requires assessment ${String(indicator.requiresAssessment)} | rule ${safe(indicator.ruleVersion)}\n    ${safe(indicator.summary)}\n    evidence: ${evidenceList(indicator.evidence)}\n    limitations: ${values(indicator.limitations)}`;
  });
  return listSection('Indicators', rows);
}

function renderReadinessDetail(analysis: Analysis): string {
  const rows = analysis.testObservations.map(
    (observation) => `${safe(observation.path)}: ${measurementDetail(observation.present, String)}`,
  );
  if (analysis.coverageObservation !== null) {
    const observation = analysis.coverageObservation;
    rows.push(
      `coverage source: ${observation.source === null ? 'unavailable' : safe(observation.source)}; covered lines: ${measurementDetail(observation.coveredLines, number)}; total lines: ${measurementDetail(observation.totalLines, number)}; matched supplied subset; provenance unverified; not a security score`,
    );
  }
  if (rows.length === 0) rows.push('No readiness measurements supplied.');
  return listSection('Readiness measurements', rows);
}

function parameterRows(estimate: EstimateResult): string[] {
  const parameters = estimate.parameters;
  return [
    `projectHours (auditor-hours/project): ${range(parameters.projectHours)}`,
    `slocHours (auditor-hours/SLOC): ${range(parameters.slocHours)}`,
    `controlPremium (fraction of file baseline at q=1): ${range(parameters.controlPremium)}`,
    `storagePremium (fraction of file baseline at q=1): ${range(parameters.storagePremium)}`,
    `evmPremium (fraction of file baseline at q=1): ${range(parameters.evmPremium)}`,
    `interactionHours (hours/unique scoped directed pair): ${range(parameters.interactionHours)}`,
    `boundaryHours (hours/unique context boundary pair): ${range(parameters.boundaryHours)}`,
    `unknownReserveHigh (high-only fraction of pre-manual subtotal): ${number(parameters.unknownReserveHigh)}`,
    `hoursPerDay (conversion convention): ${number(parameters.hoursPerDay)}`,
  ];
}

function parameterForCategory(category: string): string {
  switch (category) {
    case 'baseline':
      return 'slocHours';
    case 'control':
      return 'controlPremium';
    case 'storage':
      return 'storagePremium';
    case 'evm':
      return 'evmPremium';
    case 'project':
      return 'projectHours';
    case 'interaction':
      return 'interactionHours';
    case 'boundary':
      return 'boundaryHours';
    case 'reserve':
      return 'unknownReserveHigh';
    case 'manual':
      return 'reasoned adjustment';
    default:
      return 'no parameter mapping supplied';
  }
}

function renderEstimateDetail(estimate: EstimateResult, title: string): string {
  const header = `${title}: ${safe(estimate.label)}; model ${estimate.profile} ${estimate.modelVersion}; coverage ${estimate.coverage}; auditor hours ${range(estimate.auditorHours)}; auditor days ${range(estimate.auditorDays)}`;
  const contributions = estimate.contributions.map((row) => {
    const omitted =
      row.inputStatus === 'unavailable' && row.lowMicrohours === 0 && row.highMicrohours === 0
        ? '; zero values mean omitted premium, not observed zero'
        : '';
    return `${safe(row.id)} | category ${safe(row.category)} | ${number(row.lowMicrohours)} to ${number(row.highMicrohours)} microhours | input ${row.inputStatus} | parameter ${parameterForCategory(row.category)}${omitted}\n    ${safe(row.explanation)}`;
  });
  const adjustments = estimate.manualAdjustments.map(
    (row) =>
      `${safe(row.id)} | category ${safe(row.category)} | ${number(row.lowHours)} to ${number(row.highHours)} signed auditor-hours | reason ${safe(row.reason)}`,
  );
  const sections = [
    header,
    'Model formulas: docs/model/heuristic-v1.md.',
    listSection('Effective parameters and units', parameterRows(estimate)),
    listSection('Contribution ledger (supplied row order)', contributions),
    listSection('Assumptions (supplied order)', estimate.assumptions.map(safe)),
    listSection('Manual adjustments (listed separately; supplied order)', adjustments),
  ];
  if (estimate.contributions.some((row) => row.id.startsWith('manual:'))) {
    sections.push(
      'Contribution IDs are opaque; row IDs do not identify files or edges. Manual adjustment hashes cannot be reversed or matched by row index.',
    );
  } else {
    sections.push('Contribution IDs are opaque; row IDs do not identify files or edges.');
  }
  return sections.join('\n\n');
}

function renderVersions(envelope: ReportEnvelope): string {
  return listSection('Versions and fingerprints', [
    `report schema: ${safe(envelope.schemaVersion)}`,
    `tool: ${safe(envelope.toolVersion)}`,
    `parser: ${safe(envelope.versions.parser)}`,
    `metrics: ${safe(envelope.versions.metrics)}`,
    `indicators: ${safe(envelope.versions.indicators)}`,
    `model: ${safe(envelope.versions.model)}`,
    `sources fingerprint: ${envelope.fingerprints.sources ?? 'unavailable'}`,
    `semantic config fingerprint: ${envelope.fingerprints.semanticConfig ?? 'unavailable'}`,
    `analysis fingerprint: ${envelope.fingerprints.analysis ?? 'unavailable'}`,
  ]);
}

function renderDetailedAnalysis(envelope: ReportEnvelope, analysis: Analysis): string[] {
  return [
    renderScopeDetail(envelope),
    listSection('Aggregate measurements with evidence', [
      aggregateDetail('Scoped files', analysis.aggregates.scopedFiles, ''),
      aggregateDetail('Physical lines', analysis.aggregates.physicalLines, ''),
      aggregateDetail('Source lines', analysis.aggregates.sourceLines, ' SLOC'),
      aggregateDetail('Contracts', analysis.aggregates.contracts, ''),
      aggregateDetail('Callables', analysis.aggregates.callables, ''),
    ]),
    renderFiles(envelope, analysis),
    renderContractsDetail(envelope, analysis),
    renderCallables(analysis),
    renderGraphs(analysis),
    renderIndicators(analysis),
    renderReadinessDetail(analysis),
    listSection('Completeness IDs', [
      `analyzed file IDs: ${values(analysis.completeness.analyzedFileIds)}`,
      `reported unavailable file IDs: ${values(analysis.completeness.unavailableFileIds)}`,
      `required analysis complete: ${String(analysis.completeness.requiredAnalysisComplete)}`,
      `unknown semantics: ${String(analysis.completeness.hasUnknownSemantics)}`,
    ]),
  ];
}

function aggregateDetail(name: string, value: Measurement<number>, unit: string): string {
  return `${name}: ${measurementDetail(value, (item) => `${number(item)}${unit}`)}`;
}

/** Formats a validated envelope as a deterministic terminal report with opt-in renderer color. */
export function formatTerminal(envelope: ReportEnvelope, options?: TerminalFormatOptions): string {
  const report = parseDisplayEnvelope(envelope);
  const color = options?.color ?? false;
  const detail = options?.detail ?? report.command === 'explain';
  const sections = [renderHeader(report, color)];
  if (report.status === 'partial') sections.push('Analyzed subset. Full-scope effort unavailable.');
  const estimateSummary = renderEstimateAvailability(report);
  if (estimateSummary !== null) sections.push(estimateSummary);
  sections.push(...renderSummary(report));

  if (detail && report.status !== 'error') {
    if (report.analysis !== null) sections.push(...renderDetailedAnalysis(report, report.analysis));
    sections.push(renderVersions(report));
    if (report.estimate !== null) sections.push(renderEstimateDetail(report.estimate, 'Estimate'));
    if (
      report.fullScopeEstimate !== null &&
      canonicalDisplayValue(report.fullScopeEstimate) !== canonicalDisplayValue(report.estimate)
    ) {
      sections.push(renderEstimateDetail(report.fullScopeEstimate, 'Full-scope estimate'));
    }
  } else if (report.status === 'error' && detail) {
    sections.push(renderScopeDetail(report));
    sections.push(renderVersions(report));
  }

  return `${sections
    .filter((section) => section.length > 0)
    .join('\n\n')
    .replace(/\n+$/u, '')}\n`;
}
