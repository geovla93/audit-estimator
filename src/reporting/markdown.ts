import type {
  Analysis,
  CallableAnalysis,
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
import { sanitizeMarkdownText } from './sanitize.ts';

function text(value: string): string {
  return sanitizeMarkdownText(value);
}

function number(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}

function range(value: ParameterRange): string {
  return `${number(value.low)} to ${number(value.high)}`;
}

function measurement<T>(value: Measurement<T>, render: (item: T) => string): string {
  if (value.status === 'unavailable') return `unavailable (${text(value.reason)})`;
  return `measured ${render(value.value)}; evidence: ${evidenceList(value.evidence)}`;
}

function sourceRange(value: SourceRange): string {
  return `${number(value.start.line)}:${number(value.start.column)}-${number(value.end.line)}:${number(value.end.column)} [bytes ${number(value.startByte)}-${number(value.endByte)}]`;
}

function evidence(reference: EvidenceRef): string {
  return `${text(reference.fileId)} ${sourceRange(reference.range)}`;
}

function evidenceList(items: readonly EvidenceRef[]): string {
  return items.length === 0 ? 'none supplied' : items.map(evidence).join('; ');
}

function strings(items: readonly string[]): string {
  return items.length === 0 ? 'none' : items.map(text).join(', ');
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${headers.join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`);
  return [head, separator, ...body].join('\n');
}

function list(items: readonly string[]): string {
  return items.length === 0 ? '- none supplied' : items.map((item) => `- ${item}`).join('\n');
}

function location(diagnostic: Diagnostic): string {
  const file = diagnostic.fileId === undefined ? '' : `; file ${text(diagnostic.fileId)}`;
  const rangeText = diagnostic.range === undefined ? '' : ` ${sourceRange(diagnostic.range)}`;
  const details =
    diagnostic.details === undefined
      ? ''
      : `; details ${diagnostic.details.map((item) => `${text(item.key)}=${text(String(item.value))}`).join(', ')}`;
  return `${file}${rangeText}${details}`;
}

function renderDiagnostics(envelope: ReportEnvelope): string {
  const rows = [
    ...envelope.diagnostics.map(
      (diagnostic) =>
        `- **${diagnostic.severity} / ${diagnostic.phase} / ${diagnostic.code}:** ${text(diagnostic.message)}${location(diagnostic)}`,
    ),
    ...envelope.limitations.map((limitation) => `- **Limitation:** ${text(limitation)}`),
  ];
  return `## Diagnostics and limitations\n\n${rows.length === 0 ? '- none supplied' : rows.join('\n')}`;
}

function renderSummary(envelope: ReportEnvelope): string[] {
  const sections = [
    `## Overview\n\n- Command: ${envelope.command}\n- Status: ${envelope.status}${envelope.failureCategory === null ? '' : `\n- Failure category: ${envelope.failureCategory}`}`,
  ];
  if (envelope.status === 'partial') {
    sections.push('**Analyzed subset. Full-scope effort unavailable.**');
  }
  if (envelope.command !== 'inspect') {
    if (envelope.estimate === null) {
      const reasons = [
        ...envelope.diagnostics.map((diagnostic) => text(diagnostic.message)),
        ...envelope.limitations.map(text),
      ];
      sections.push(
        `**Effort unavailable:** ${reasons.length === 0 ? 'reason not supplied' : reasons.join('; ')}`,
      );
    } else {
      sections.push(renderEstimateSummary(envelope.estimate));
    }
  }

  if (envelope.analysis !== null) {
    sections.push(renderScopeSummary(envelope));
    sections.push(renderAggregateTable(envelope.analysis));
    const scope = renderEstimationScope(envelope.analysis);
    if (scope !== null) sections.push(scope);
    sections.push(renderContractTable(envelope));
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
        `### Omitted premiums in ${title}\n\n${list(omitted.map((row) => `${text(row.category)}: ${text(row.explanation)} (zero is not observed zero)`))}`,
      );
    }
  }
  sections.push(renderDiagnostics(envelope));
  return sections;
}

function renderEstimateSummary(estimate: EstimateResult): string {
  return [
    `**Auditor effort scenario:** ${range(estimate.auditorHours)} auditor hours; ${range(estimate.auditorDays)} auditor days.`,
    `**${text(estimate.label)}.** Effort, not elapsed delivery time. Scenario bounds have no probability or accuracy claim.`,
  ].join('\n\n');
}

function renderScopeSummary(envelope: ReportEnvelope): string {
  const analysis = envelope.analysis;
  if (analysis === null) return '';
  const count = (role: string): number =>
    envelope.scope.entries.filter((entry) => entry.role === role).length;
  const unavailable = analysis.completeness.unavailableFileIds;
  return [
    '## Scope and completeness',
    '',
    `- Manifest scoped entries: ${number(count('scoped'))}`,
    `- Manifest context entries: ${number(count('context'))}`,
    `- Manifest excluded entries: ${number(count('excluded'))}`,
    `- Syntax-complete scoped records: ${number(analysis.files.filter((file) => file.role === 'scoped' && file.syntaxComplete).length)}`,
    `- Reported unavailable IDs: ${unavailable.length === 0 ? 'none' : strings(unavailable)}`,
    `- Required analysis complete: ${String(analysis.completeness.requiredAnalysisComplete)}`,
    `- Unknown semantics reported: ${String(analysis.completeness.hasUnknownSemantics)}`,
  ].join('\n');
}

function renderAggregateTable(analysis: Analysis): string {
  const aggregates = analysis.aggregates;
  return [
    '## Scoped aggregate measurements',
    '',
    table(
      ['Measure', 'Supplied value and evidence'],
      [
        ['Scoped files', measurement(aggregates.scopedFiles, number)],
        ['Physical lines', measurement(aggregates.physicalLines, number)],
        ['Source lines', measurement(aggregates.sourceLines, (value) => `${number(value)} SLOC`)],
        ['Contracts', measurement(aggregates.contracts, number)],
        ['Callables', measurement(aggregates.callables, number)],
      ],
    ),
  ].join('\n');
}

function filePath(envelope: ReportEnvelope, fileId: string): string {
  return envelope.scope.entries.find((entry) => entry.fileId === fileId)?.path ?? fileId;
}

function variableCount(state: StateVariables): string {
  return `declared ${measurement(state.count, number)}; mutable ${measurement(state.mutableCount, number)}`;
}

function lineCount(value: Measurement<number>): string {
  return value.status === 'measured' ? number(value.value) : `unavailable (${text(value.reason)})`;
}

function renderEstimationScope(analysis: Analysis): string | null {
  const scope = analysis.estimationScope;
  if (scope === undefined) return null;
  const contracts = scope.mode === 'contracts';
  const rows = [
    contracts
      ? `Mode: caller-selected contracts; reason: ${text(scope.reason ?? 'not supplied')}`
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
  return `## Estimation scope\n\n${list(rows)}`;
}

function renderContractTable(envelope: ReportEnvelope): string {
  const analysis = envelope.analysis;
  if (analysis === null) return '';
  const rows = analysis.contracts.map((contract) => [
    text(contract.id),
    text(filePath(envelope, contract.fileId)),
    text(contract.name),
    contract.kind,
    measurement(contract.sourceLines, number),
    variableCount(contract.stateVariables),
  ]);
  return [
    '## Contracts',
    '',
    table(['Contract ID', 'Path', 'Name', 'Declaration kind', 'SLOC', 'State variables'], rows),
  ].join('\n');
}

function renderGraphSummary(analysis: Analysis): string {
  const counts = new Map<string, number>();
  for (const graph of analysis.graphs) {
    counts.set(graph.resolution, (counts.get(graph.resolution) ?? 0) + 1);
  }
  return [
    '## Graph resolution',
    '',
    table(
      ['Resolution', 'Count'],
      ['resolved-unique', 'ambiguous', 'unresolved', 'unsupported'].map((resolution) => [
        resolution,
        number(counts.get(resolution) ?? 0),
      ]),
    ),
  ].join('\n');
}

function renderAssessmentIndicators(analysis: Analysis): string {
  const rows = analysis.indicators
    .filter((indicator) => indicator.requiresAssessment)
    .map(
      (indicator) =>
        `${text(indicator.id)} (${text(indicator.category)}): ${text(indicator.summary)}`,
    );
  return `## Indicators requiring human assessment\n\n${list(rows)}`;
}

function renderReadiness(analysis: Analysis): string {
  const rows = analysis.testObservations.map(
    (observation) => `${text(observation.path)}: ${measurement(observation.present, String)}`,
  );
  if (analysis.coverageObservation !== null) {
    const item = analysis.coverageObservation;
    rows.push(
      `Coverage source ${item.source === null ? 'unavailable' : text(item.source)}; covered lines ${measurement(item.coveredLines, number)}; total lines ${measurement(item.totalLines, number)}; matched supplied subset; provenance unverified; not a security score.`,
    );
  }
  if (rows.length === 0) rows.push('No readiness measurements supplied.');
  rows.push('Readiness observations do not change report status or effort.');
  return `## Readiness observations\n\n${list(rows)}`;
}

function stateVariableRows(state: StateVariables): string[] {
  return [
    `State variable count: ${measurement(state.count, number)}`,
    `Mutable state variable count: ${measurement(state.mutableCount, number)}`,
    `Complex mutable declaration IDs: ${measurement(state.complexMutableDeclarationIds, strings)}`,
    `Type shapes: ${measurement(state.typeShapes, (items) => items.map((item) => `${text(item.declarationId)} ${item.shape} mutable=${String(item.mutable)}`).join('; ') || 'none')}`,
  ];
}

function measurementRows(file: FileAnalysis): string[][] {
  const declarationCounts = file.declarationCounts;
  return [
    ['Physical lines', measurement(file.physicalLines, number)],
    ['Source lines', measurement(file.sourceLines, number)],
    ['Contracts', measurement(declarationCounts.contracts, number)],
    ['Abstract contracts', measurement(declarationCounts.abstractContracts, number)],
    ['Libraries', measurement(declarationCounts.libraries, number)],
    ['Interfaces', measurement(declarationCounts.interfaces, number)],
    ['Decisions', measurement(file.decisions, number)],
    ['Loops', measurement(file.loops, number)],
    ['Maximum loop depth', measurement(file.maxLoopDepth, number)],
    ['Assembly blocks', measurement(file.assemblyBlocks, number)],
    ['Yul statements', measurement(file.yulStatements, number)],
    ['Yul calls', measurement(file.yulCalls, number)],
    ['Yul control flow', measurement(file.yulControlFlow, number)],
    ['Low-level call candidates', measurement(file.lowLevelCallCandidates, number)],
    ['Import IDs', strings(file.importIds)],
    ['Contract IDs', strings(file.contractIds)],
    ['Callable IDs', strings(file.callableIds)],
    ['Syntax complete', String(file.syntaxComplete)],
    ...stateVariableRows(file.stateVariables).map((row) => ['State variables', row]),
  ];
}

function renderFiles(analysis: Analysis, envelope: ReportEnvelope): string {
  const rows: string[][] = [];
  for (const file of analysis.files) {
    rows.push([
      text(filePath(envelope, file.fileId)),
      file.role,
      file.ownership,
      text(file.fileId),
      measurementRows(file)
        .map(([label, value]) => `${label}: ${value}`)
        .join('; '),
    ]);
  }
  const headers = ['Path', 'Role', 'Ownership', 'File ID', 'Supplied metrics and evidence'];
  return ['## File metrics', '', table(headers, rows)].join('\n');
}

function renderContractsDetail(envelope: ReportEnvelope, analysis: Analysis): string {
  const rows = analysis.contracts.map((contract) => [
    text(contract.name),
    contract.kind,
    text(filePath(envelope, contract.fileId)),
    text(contract.id),
    sourceRange(contract.range),
    measurement(contract.sourceLines, number),
    strings(contract.callableIds),
    stateVariableRows(contract.stateVariables).join('; '),
  ]);
  return [
    '## Contract details',
    '',
    table(
      [
        'Name',
        'Kind',
        'Path',
        'Contract ID',
        'Source range',
        'SLOC',
        'Callable IDs',
        'State variable details',
      ],
      rows,
    ),
  ].join('\n');
}

function renderCallables(analysis: Analysis): string {
  const rows = analysis.callables.map((callable: CallableAnalysis) => [
    callable.name === null ? 'name unavailable' : text(callable.name),
    callable.kind,
    text(callable.fileId),
    callable.contractId === null ? 'none' : text(callable.contractId),
    text(callable.id),
    sourceRange(callable.range),
    `visibility explicit ${measurement(callable.visibilityExplicit, text)}; effective ${measurement(callable.visibilityEffective, text)}`,
    `mutability explicit ${measurement(callable.mutabilityExplicit, text)}; effective ${measurement(callable.mutabilityEffective, text)}`,
    `body ${measurement(callable.hasBody, String)}`,
    `decisions ${measurement(callable.decisions, number)}; loops ${measurement(callable.loops, number)}; max loop depth ${measurement(callable.maxLoopDepth, number)}`,
    `assembly ${measurement(callable.assemblyBlocks, number)}; Yul statements ${measurement(callable.yulStatements, number)}; calls ${measurement(callable.yulCalls, number)}; control flow ${measurement(callable.yulControlFlow, number)}`,
    `low-level call candidates ${measurement(callable.lowLevelCallCandidates, number)}`,
    `modifiers in supplied order ${measurement(callable.modifiersApplied, strings)}`,
  ]);
  return [
    '## Callable details',
    '',
    table(
      [
        'Name',
        'Kind',
        'File ID',
        'Contract ID',
        'Callable ID',
        'Range',
        'Visibility',
        'Mutability',
        'Body',
        'Control metrics',
        'Assembly and Yul',
        'Low-level candidates',
        'Modifiers',
      ],
      rows,
    ),
  ].join('\n');
}

function target(graph: RelationshipResult): string {
  return 'to' in graph ? text(graph.to) : 'no resolved target';
}

function renderGraphs(analysis: Analysis): string {
  const rows = analysis.graphs.map((graph) => [
    text(graph.id),
    graph.kind,
    text(graph.from),
    target(graph),
    graph.resolution,
    strings(graph.candidateTargets),
    evidenceList(graph.evidence),
  ]);
  return [
    '## Graph details',
    '',
    table(['Edge ID', 'Kind', 'From', 'To', 'Resolution', 'Candidate targets', 'Evidence'], rows),
  ].join('\n');
}

function renderIndicators(analysis: Analysis): string {
  const rows = analysis.indicators.map((indicator: Indicator) => [
    text(indicator.id),
    text(indicator.category),
    indicator.evidenceKind,
    indicator.confidence,
    String(indicator.requiresAssessment),
    text(indicator.ruleVersion),
    text(indicator.summary),
    evidenceList(indicator.evidence),
    strings(indicator.limitations),
  ]);
  return [
    '## Indicators',
    '',
    table(
      [
        'ID',
        'Category',
        'Evidence kind',
        'Confidence',
        'Requires assessment',
        'Rule version',
        'Summary',
        'Evidence',
        'Limitations',
      ],
      rows,
    ),
  ].join('\n');
}

function renderReadinessDetail(analysis: Analysis): string {
  const rows: string[][] = analysis.testObservations.map((observation) => [
    text(observation.path),
    measurement(observation.present, String),
  ]);
  if (analysis.coverageObservation !== null) {
    const observation = analysis.coverageObservation;
    rows.push([
      'Coverage',
      `source ${observation.source === null ? 'unavailable' : text(observation.source)}; covered lines ${measurement(observation.coveredLines, number)}; total lines ${measurement(observation.totalLines, number)}; matched supplied subset; provenance unverified; not a security score`,
    ]);
  }
  if (rows.length === 0) rows.push(['Readiness', 'No readiness measurements supplied.']);
  return [
    '## Readiness measurements',
    '',
    table(['Observation', 'Supplied value and evidence'], rows),
  ].join('\n');
}

function renderManifest(envelope: ReportEnvelope): string {
  const rows = envelope.scope.entries.map((entry) => [
    text(entry.path),
    entry.role,
    entry.ownership,
    text(entry.fileId),
    evidenceList(entry.ownershipEvidence),
  ]);
  return [
    '## Manifest entries',
    '',
    table(['Path', 'Role', 'Ownership', 'File ID', 'Ownership evidence'], rows),
  ].join('\n');
}

function parameters(estimate: EstimateResult): string[][] {
  const item = estimate.parameters;
  return [
    ['projectHours', range(item.projectHours), 'auditor-hours/project'],
    ['slocHours', range(item.slocHours), 'auditor-hours/SLOC'],
    ['controlPremium', range(item.controlPremium), 'fraction of file baseline at q=1'],
    ['storagePremium', range(item.storagePremium), 'fraction of file baseline at q=1'],
    ['evmPremium', range(item.evmPremium), 'fraction of file baseline at q=1'],
    ['interactionHours', range(item.interactionHours), 'hours/unique scoped directed pair'],
    ['boundaryHours', range(item.boundaryHours), 'hours/unique context boundary pair'],
    [
      'unknownReserveHigh',
      number(item.unknownReserveHigh),
      'high-only fraction of pre-manual subtotal',
    ],
    ['hoursPerDay', number(item.hoursPerDay), 'conversion convention'],
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

function renderEstimate(estimate: EstimateResult, title: string): string {
  const omittedNote = (row: EstimateResult['contributions'][number]): string =>
    row.inputStatus === 'unavailable' && row.lowMicrohours === 0 && row.highMicrohours === 0
      ? '; zero values mean omitted premium, not observed zero'
      : '';
  const contributionRows = estimate.contributions.map((row) => [
    text(row.id),
    text(row.category),
    `${number(row.lowMicrohours)} to ${number(row.highMicrohours)} microhours`,
    row.inputStatus,
    parameterForCategory(row.category),
    `${text(row.explanation)}${omittedNote(row)}`,
  ]);
  const adjustmentRows = estimate.manualAdjustments.map((row) => [
    text(row.id),
    text(row.category),
    `${number(row.lowHours)} to ${number(row.highHours)} signed auditor-hours`,
    text(row.reason),
  ]);
  return [
    `## ${title}`,
    '',
    `- Label: ${text(estimate.label)}`,
    `- Model: ${estimate.profile} ${estimate.modelVersion}`,
    `- Coverage: ${estimate.coverage}`,
    `- Auditor hours: ${range(estimate.auditorHours)}`,
    `- Auditor days: ${range(estimate.auditorDays)}`,
    '- Effort, not elapsed delivery time. Scenario bounds have no probability or accuracy claim.',
    '',
    '### Effective parameters and units',
    '',
    table(['Parameter', 'Supplied value', 'Unit'], parameters(estimate)),
    '',
    '### Contribution ledger in supplied order',
    '',
    table(
      [
        'Opaque row ID',
        'Category',
        'Microhours',
        'Input status',
        'Parameter mapping',
        'Explanation',
      ],
      contributionRows,
    ),
    '',
    'Contribution IDs are opaque and do not identify files or edges. A zero-valued unavailable row means the premium was omitted, not measured as zero.',
    '',
    '### Assumptions in supplied order',
    '',
    list(estimate.assumptions.map(text)),
    '',
    '### Manual adjustments in supplied order',
    '',
    table(['Adjustment ID', 'Category', 'Signed range', 'Reason'], adjustmentRows),
    '',
    'Manual adjustment hashes cannot be reversed or matched to contribution rows by index.',
  ].join('\n');
}

function renderVersions(envelope: ReportEnvelope): string {
  return [
    '## Versions and fingerprints',
    '',
    table(
      ['Field', 'Value'],
      [
        ['Report schema', text(envelope.schemaVersion)],
        ['Tool', text(envelope.toolVersion)],
        ['Parser', text(envelope.versions.parser)],
        ['Metrics', text(envelope.versions.metrics)],
        ['Indicators', text(envelope.versions.indicators)],
        ['Model', text(envelope.versions.model)],
        ['Sources fingerprint', envelope.fingerprints.sources ?? 'unavailable'],
        ['Semantic config fingerprint', envelope.fingerprints.semanticConfig ?? 'unavailable'],
        ['Analysis fingerprint', envelope.fingerprints.analysis ?? 'unavailable'],
      ],
    ),
  ].join('\n');
}

function renderCompleteness(analysis: Analysis): string {
  return [
    '## Completeness IDs and flags',
    '',
    `- Analyzed file IDs: ${strings(analysis.completeness.analyzedFileIds)}`,
    `- Reported unavailable file IDs: ${strings(analysis.completeness.unavailableFileIds)}`,
    `- Required analysis complete: ${String(analysis.completeness.requiredAnalysisComplete)}`,
    `- Unknown semantics: ${String(analysis.completeness.hasUnknownSemantics)}`,
  ].join('\n');
}

/** Renders full Markdown from one validated envelope; dynamic text is escaped as inert plain text. */
export function formatMarkdown(envelope: ReportEnvelope): string {
  const report = parseDisplayEnvelope(envelope);
  const sections = ['# Audit report', ...renderSummary(report)];
  sections.push(renderManifest(report));
  if (report.analysis !== null && report.status !== 'error') {
    sections.push(
      renderFiles(report.analysis, report),
      renderContractsDetail(report, report.analysis),
      renderCallables(report.analysis),
      renderGraphs(report.analysis),
      renderIndicators(report.analysis),
      renderReadinessDetail(report.analysis),
      renderCompleteness(report.analysis),
    );
  }
  sections.push(renderVersions(report));
  if (report.estimate !== null) sections.push(renderEstimate(report.estimate, 'Estimate'));
  if (
    report.fullScopeEstimate !== null &&
    canonicalDisplayValue(report.fullScopeEstimate) !== canonicalDisplayValue(report.estimate)
  ) {
    sections.push(renderEstimate(report.fullScopeEstimate, 'Full-scope estimate'));
  }
  sections.push('Model formulas are defined in `docs/model/heuristic-v1.md`.');
  return `${sections
    .filter((section) => section.length > 0)
    .join('\n\n')
    .replace(/\n+$/u, '')}\n`;
}
