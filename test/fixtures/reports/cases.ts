import { readFileSync } from 'node:fs';
import { canonicalJson, fingerprint, sortById } from '../../../src/domain/canonical.ts';
import { EstimateResultSchema, ReportEnvelopeSchema } from '../../../src/domain/schemas.ts';
import type { EstimateResult, ReportEnvelope } from '../../../src/domain/types.ts';
import { z } from 'zod';

const FILE_A = 'file:src/A.sol';
const FILE_B = 'file:src/B.sol';
const FILE_CONTEXT = 'file:lib/Ctx.sol';
const FILE_EXCLUDED = 'file:examples/ignored.sol';
const CONTRACT_A = 'decl:src/A.sol:contract:0';
const CONTRACT_B = 'decl:src/A.sol:contract:200';
const CONTRACT_CONTEXT = 'decl:lib/Ctx.sol:contract:0';
const LIBRARY_CONTEXT = 'decl:lib/Ctx.sol:library:100';
const CALLABLE_A = 'decl:src/A.sol:function:10';
const CALLABLE_B = 'decl:src/A.sol:function:210';

interface WorkedEstimateCase {
  readonly id: string;
  readonly expected: { readonly estimate: unknown };
}

const workedCasesSchema = z.array(
  z.looseObject({
    id: z.string(),
    expected: z.looseObject({ estimate: z.unknown() }),
  }),
);
const workedCases = workedCasesSchema.parse(
  JSON.parse(
    readFileSync(new URL('../estimation/worked-cases.json', import.meta.url), 'utf8'),
  ) as unknown,
) as readonly WorkedEstimateCase[];

const ENGINE_ASSUMPTIONS = [
  'Every coefficient is an uncalibrated planning assumption, not a measured productivity or industry rate.',
  'Low and high are scenario bounds with no stated probability, percentage accuracy or confidence level.',
  'Hours are cumulative initial-review effort across participating auditors and exclude remediation, fix verification, duplicate independent reviews, proofs and calendar time unless added as manual adjustments.',
] as const;

const ENGINE_EXPLANATIONS: Readonly<
  Record<EstimateResult['contributions'][number]['category'], string>
> = {
  baseline:
    'SLOC baseline for one eligible file: measured lines times the SLOC hour rate (uncalibrated assumption).',
  control:
    'Control premium on the file baseline, scaled by the measured decision density (uncalibrated assumption).',
  storage:
    'Storage premium on the file baseline, scaled by the measured complex mutable declaration share (uncalibrated assumption).',
  evm: 'EVM premium on the file baseline for measured assembly or confirmed builtin low-level calls (uncalibrated assumption).',
  interaction:
    'Interaction allowance for one unique scoped directed contract pair (uncalibrated assumption).',
  boundary:
    'Boundary allowance for one unique scoped-to-context directed contract pair (uncalibrated assumption).',
  project: 'Fixed project allowance (uncalibrated assumption), charged once.',
  reserve:
    'High-scenario uncertainty reserve on the rounded pre-manual high subtotal; the low scenario has none (uncalibrated assumption).',
  manual:
    'Reasoned manual adjustment supplied by the operator; the reserve is never applied to it.',
};

function productionId(fixtureId: string): string {
  if (fixtureId === 'project' || fixtureId === 'reserve') return fixtureId;
  const colon = fixtureId.indexOf(':');
  const category = fixtureId.slice(0, colon);
  const rest = fixtureId.slice(colon + 1);
  const identity = category === 'interaction' || category === 'boundary' ? rest.split('>') : [rest];
  return `${category}:${fingerprint([category, canonicalJson(identity)])}`;
}

function expectedEstimate(id: string): EstimateResult {
  const fixture = workedCases.find((item) => item.id === id);
  if (fixture === undefined || fixture.expected.estimate === null) {
    throw new Error(`Expected a literal estimate for worked case ${id}`);
  }
  const literal = EstimateResultSchema.parse(fixture.expected.estimate);
  return EstimateResultSchema.parse({
    ...literal,
    assumptions: ENGINE_ASSUMPTIONS,
    contributions: sortById(
      literal.contributions.map((row) => ({
        ...row,
        id: productionId(row.id),
        explanation: ENGINE_EXPLANATIONS[row.category],
      })),
    ),
  });
}

function position(
  line: number,
  column: number,
): { readonly line: number; readonly column: number } {
  return { line, column };
}

function range(startByte: number, endByte: number, line = 1): unknown {
  return {
    startByte,
    endByte,
    start: position(line, startByte + 1),
    end: position(line, endByte + 1),
  };
}

function evidence(fileId: string, startByte: number): unknown {
  return { fileId, range: range(startByte, startByte + 5) };
}

function measured(value: unknown, references: readonly unknown[] = []): unknown {
  return { status: 'measured', value, evidence: references };
}

function unavailable(reason: string): unknown {
  return { status: 'unavailable', reason };
}

function normalStateVariables(fileId: string, rich: boolean): unknown {
  const ids = rich
    ? ['decl:src/A.sol:state-variable:101', 'decl:src/A.sol:state-variable:100']
    : [];
  const shapes = rich
    ? [
        { declarationId: 'decl:src/A.sol:state-variable:101', shape: 'mapping', mutable: true },
        { declarationId: 'decl:src/A.sol:state-variable:100', shape: 'mapping', mutable: true },
        { declarationId: 'decl:src/A.sol:state-variable:102', shape: 'elementary', mutable: true },
        { declarationId: 'decl:src/A.sol:state-variable:103', shape: 'elementary', mutable: true },
        { declarationId: 'decl:src/A.sol:state-variable:104', shape: 'elementary', mutable: true },
        { declarationId: 'decl:src/A.sol:state-variable:105', shape: 'elementary', mutable: true },
        { declarationId: 'decl:src/A.sol:state-variable:106', shape: 'elementary', mutable: true },
        { declarationId: 'decl:src/A.sol:state-variable:107', shape: 'elementary', mutable: true },
        { declarationId: 'decl:src/A.sol:state-variable:900', shape: 'elementary', mutable: false },
      ]
    : [];
  const references = [evidence(fileId, 30), evidence(fileId, 15)];
  return {
    count: measured(rich ? 9 : 0, references),
    mutableCount: measured(rich ? 8 : 0, references),
    complexMutableDeclarationIds: measured(ids, references),
    typeShapes: measured(shapes, references),
  };
}

function makeFile(
  fileId: string,
  role: 'scoped' | 'context',
  ownership: 'first-party' | 'third-party',
  sourceLines: number,
  options: { readonly rich?: boolean; readonly contextLibrary?: boolean } = {},
): unknown {
  const rich = options.rich ?? false;
  const contextLibrary = options.contextLibrary ?? false;
  const references = [evidence(fileId, 20), evidence(fileId, 5)];
  const count = (value: number): unknown => measured(value, references);
  return {
    fileId,
    role,
    ownership,
    physicalLines: count(sourceLines + 25),
    sourceLines: measured(sourceLines, [evidence(FILE_CONTEXT, 20), evidence(fileId, 5)]),
    declarationCounts: {
      contracts: count(contextLibrary ? 1 : rich ? 2 : 0),
      abstractContracts: count(0),
      libraries: count(contextLibrary ? 1 : 0),
      interfaces: count(0),
    },
    stateVariables: normalStateVariables(fileId, rich),
    decisions: count(rich ? 10 : 0),
    loops: count(rich ? 2 : 0),
    maxLoopDepth: count(rich ? 2 : 0),
    assemblyBlocks: count(0),
    yulStatements: count(0),
    yulCalls: count(0),
    yulControlFlow: count(0),
    lowLevelCallCandidates: count(rich ? 2 : 0),
    importIds: [],
    contractIds: rich
      ? [CONTRACT_B, CONTRACT_A]
      : contextLibrary
        ? [LIBRARY_CONTEXT, CONTRACT_CONTEXT]
        : [],
    callableIds: rich ? [CALLABLE_B, CALLABLE_A] : [],
    syntaxComplete: true,
  };
}

function makeIncompleteContextFile(): unknown {
  return {
    fileId: FILE_CONTEXT,
    role: 'context',
    ownership: 'third-party',
    physicalLines: measured(25, [evidence(FILE_CONTEXT, 5)]),
    sourceLines: unavailable('Context syntax unavailable'),
    declarationCounts: {
      contracts: unavailable('Context syntax unavailable'),
      abstractContracts: unavailable('Context syntax unavailable'),
      libraries: unavailable('Context syntax unavailable'),
      interfaces: unavailable('Context syntax unavailable'),
    },
    stateVariables: {
      count: unavailable('Context syntax unavailable'),
      mutableCount: unavailable('Context syntax unavailable'),
      complexMutableDeclarationIds: unavailable('Context syntax unavailable'),
      typeShapes: unavailable('Context syntax unavailable'),
    },
    decisions: unavailable('Context syntax unavailable'),
    loops: unavailable('Context syntax unavailable'),
    maxLoopDepth: unavailable('Context syntax unavailable'),
    assemblyBlocks: unavailable('Context syntax unavailable'),
    yulStatements: unavailable('Context syntax unavailable'),
    yulCalls: unavailable('Context syntax unavailable'),
    yulControlFlow: unavailable('Context syntax unavailable'),
    lowLevelCallCandidates: unavailable('Context syntax unavailable'),
    importIds: [],
    contractIds: [],
    callableIds: [],
    syntaxComplete: false,
  };
}

function callable(
  fileId: string,
  contractId: string,
  id: string,
  name: string | null,
  start: number,
): unknown {
  const ref = [evidence(fileId, start)];
  return {
    id,
    fileId,
    contractId,
    kind: 'function',
    name,
    range: range(start, start + 10),
    visibilityExplicit: measured('public', ref),
    visibilityEffective: measured('public', ref),
    mutabilityExplicit: measured('nonpayable', ref),
    mutabilityEffective: measured('nonpayable', ref),
    hasBody: measured(true, ref),
    decisions: measured(5, ref),
    loops: measured(1, ref),
    maxLoopDepth: measured(1, ref),
    assemblyBlocks: measured(0, ref),
    yulStatements: measured(0, ref),
    yulCalls: measured(0, ref),
    yulControlFlow: measured(0, ref),
    lowLevelCallCandidates: measured(2, ref),
    modifiersApplied: measured(['whenOpen', 'onlyOwner'], ref),
  };
}

function contract(
  id: string,
  fileId: string,
  kind: 'contract' | 'library',
  name: string,
  start: number,
  lines: number,
  callableIds: readonly string[],
  stateVariables: unknown,
): unknown {
  return {
    id,
    fileId,
    kind,
    name,
    range: range(start, start + 40),
    sourceLines: measured(lines, [evidence(fileId, start + 1), evidence(fileId, start)]),
    callableIds,
    stateVariables,
  };
}

function contractStateVariables(
  fileId: string,
  declarations: readonly {
    readonly index: number;
    readonly shape: 'mapping' | 'elementary';
    readonly mutable: boolean;
  }[],
): unknown {
  const references = [evidence(fileId, 30), evidence(fileId, 15)];
  const complexIds = declarations
    .filter((declaration) => declaration.shape === 'mapping' && declaration.mutable)
    .map((declaration) => `decl:src/A.sol:state-variable:${declaration.index}`);
  return {
    count: measured(declarations.length, references),
    mutableCount: measured(
      declarations.filter((declaration) => declaration.mutable).length,
      references,
    ),
    complexMutableDeclarationIds: measured(complexIds, references),
    typeShapes: measured(
      declarations.map((declaration) => ({
        declarationId: `decl:src/A.sol:state-variable:${declaration.index}`,
        shape: declaration.shape,
        mutable: declaration.mutable,
      })),
      references,
    ),
  };
}

const CONTRACT_A_STATE = contractStateVariables(FILE_A, [
  { index: 100, shape: 'mapping', mutable: true },
  { index: 102, shape: 'elementary', mutable: true },
  { index: 103, shape: 'elementary', mutable: true },
  { index: 104, shape: 'elementary', mutable: true },
  { index: 900, shape: 'elementary', mutable: false },
]);
const CONTRACT_B_STATE = contractStateVariables(FILE_A, [
  { index: 101, shape: 'mapping', mutable: true },
  { index: 105, shape: 'elementary', mutable: true },
  { index: 106, shape: 'elementary', mutable: true },
  { index: 107, shape: 'elementary', mutable: true },
]);
const EMPTY_CONTRACT_STATE = contractStateVariables(FILE_CONTEXT, []);

function graph(
  id: string,
  from: string,
  to: string,
  kind: 'call' | 'inheritance',
  resolution: 'resolved-unique' | 'ambiguous',
): unknown {
  return {
    id,
    kind,
    from,
    ...(resolution === 'resolved-unique' ? { to } : {}),
    candidateTargets: resolution === 'ambiguous' ? [CONTRACT_CONTEXT, CONTRACT_B] : [],
    resolution,
    evidence: [evidence(FILE_CONTEXT, 40), evidence(FILE_A, 20)],
  };
}

function indicator(id: string, summary: string, requiresAssessment: boolean): unknown {
  return {
    id,
    ruleVersion: '1.0.0',
    category: 'control',
    evidenceKind: 'heuristic',
    confidence: requiresAssessment ? 'low' : 'high',
    summary,
    evidence: [evidence(FILE_CONTEXT, 20), evidence(FILE_A, 5)],
    limitations: ['Syntactic observation only', 'No security conclusion'],
    requiresAssessment,
  };
}

function scope(includeContext: boolean, includeExcluded: boolean): unknown {
  const entries: Record<string, unknown>[] = [
    {
      fileId: FILE_A,
      path: 'src/A.sol',
      role: 'scoped',
      ownership: 'first-party',
      ownershipEvidence: [evidence(FILE_CONTEXT, 15), evidence(FILE_A, 5)],
      physicalIdentity: 'src/A.sol',
      byteHash: '0'.repeat(64),
    },
  ];
  if (includeContext) {
    entries.push({
      fileId: FILE_CONTEXT,
      path: 'lib/Ctx.sol',
      role: 'context',
      ownership: 'third-party',
      ownershipEvidence: [evidence(FILE_CONTEXT, 5)],
      physicalIdentity: 'lib/Ctx.sol',
      byteHash: '1'.repeat(64),
    });
  }
  if (includeExcluded) {
    entries.push({
      fileId: FILE_EXCLUDED,
      path: 'examples/ignored.sol',
      role: 'excluded',
      ownership: 'unknown',
      ownershipEvidence: [],
      physicalIdentity: 'examples/ignored.sol',
      byteHash: '2'.repeat(64),
    });
  }
  return {
    entries,
    scopedFileIds: [FILE_A],
    contextFileIds: includeContext ? [FILE_CONTEXT] : [],
    excludedFileIds: includeExcluded ? [FILE_EXCLUDED] : [],
  };
}

function simpleAnalysis(): Record<string, unknown> {
  const onlyFile = makeFile(FILE_A, 'scoped', 'first-party', 100);
  return {
    files: [onlyFile],
    contracts: [],
    callables: [],
    aggregates: {
      scopedFiles: measured(1, [evidence(FILE_A, 1)]),
      physicalLines: measured(125, [evidence(FILE_A, 1)]),
      sourceLines: measured(100, [evidence(FILE_A, 1)]),
      contracts: measured(0),
      callables: measured(0),
    },
    graphs: [],
    indicators: [],
    testObservations: [],
    coverageObservation: null,
    completeness: {
      requiredAnalysisComplete: true,
      hasUnknownSemantics: false,
      analyzedFileIds: [FILE_A],
      unavailableFileIds: [],
    },
  };
}

function minimalFileAnalysis(
  fileId: string,
  role: 'scoped' | 'context',
  ownership: 'first-party' | 'third-party',
  sourceLines: number,
): unknown {
  const measuredValue = (value: unknown): unknown => measured(value);
  return {
    fileId,
    role,
    ownership,
    physicalLines: measuredValue(sourceLines + 25),
    sourceLines: measuredValue(sourceLines),
    declarationCounts: {
      contracts: measuredValue(0),
      abstractContracts: measuredValue(0),
      libraries: measuredValue(0),
      interfaces: measuredValue(0),
    },
    stateVariables: {
      count: measuredValue(0),
      mutableCount: measuredValue(0),
      complexMutableDeclarationIds: measuredValue([]),
      typeShapes: measuredValue([]),
    },
    decisions: measuredValue(0),
    loops: measuredValue(0),
    maxLoopDepth: measuredValue(0),
    assemblyBlocks: measuredValue(0),
    yulStatements: measuredValue(0),
    yulCalls: measuredValue(0),
    yulControlFlow: measuredValue(0),
    lowLevelCallCandidates: measuredValue(0),
    importIds: [],
    contractIds: [],
    callableIds: [],
    syntaxComplete: true,
  };
}

function minimalAnalysis(
  input: {
    readonly partial?: boolean;
    readonly unknown?: boolean;
  } = {},
): Record<string, unknown> {
  const partial = input.partial ?? false;
  return {
    files: [minimalFileAnalysis(FILE_A, 'scoped', 'first-party', 100)],
    contracts: [],
    callables: [],
    aggregates: {
      scopedFiles: measured(1),
      physicalLines: measured(125),
      sourceLines: measured(100),
      contracts: measured(0),
      callables: measured(0),
    },
    graphs: [],
    indicators: [],
    testObservations: [],
    coverageObservation: null,
    completeness: {
      requiredAnalysisComplete: !partial,
      hasUnknownSemantics: input.unknown ?? false,
      analyzedFileIds: [FILE_A],
      unavailableFileIds: partial ? [FILE_CONTEXT] : [],
    },
  };
}

function goldenEstimate(coverage: 'full' | 'analyzed-subset'): EstimateResult {
  const partial = coverage === 'analyzed-subset';
  return EstimateResultSchema.parse({
    profile: 'heuristic-v1',
    modelVersion: '1.0.0',
    label: 'uncalibrated heuristic',
    coverage,
    auditorHours: { low: 8, high: partial ? 30 : 24 },
    auditorDays: { low: 1, high: partial ? 3.8 : 3 },
    contributions: [
      {
        id: 'baseline:golden',
        category: 'baseline',
        lowMicrohours: 4_000_000,
        highMicrohours: 12_000_000,
        inputStatus: 'measured',
        explanation:
          'SLOC baseline for one eligible file: measured lines times the SLOC hour rate (uncalibrated assumption).',
      },
      {
        id: 'project',
        category: 'project',
        lowMicrohours: 4_000_000,
        highMicrohours: 12_000_000,
        inputStatus: 'measured',
        explanation: 'Fixed project allowance (uncalibrated assumption), charged once.',
      },
      ...(partial
        ? [
            {
              id: 'reserve',
              category: 'reserve',
              lowMicrohours: 0,
              highMicrohours: 6_000_000,
              inputStatus: 'measured',
              explanation:
                'High-scenario uncertainty reserve on the rounded pre-manual high subtotal; the low scenario has none (uncalibrated assumption).',
            },
          ]
        : []),
    ],
    assumptions: ENGINE_ASSUMPTIONS,
    manualAdjustments: [],
    parameters: {
      projectHours: { low: 4, high: 12 },
      slocHours: { low: 0.04, high: 0.12 },
      controlPremium: { low: 0.1, high: 0.25 },
      storagePremium: { low: 0.05, high: 0.15 },
      evmPremium: { low: 0.2, high: 0.5 },
      interactionHours: { low: 0.25, high: 0.75 },
      boundaryHours: { low: 0.5, high: 2 },
      unknownReserveHigh: 0.25,
      hoursPerDay: 8,
    },
  });
}

function completeGoldenAnalysis(): Record<string, unknown> {
  return {
    ...minimalAnalysis(),
    testObservations: [{ path: 'test/Smoke.sol', present: measured(true) }],
    coverageObservation: {
      source: 'coverage/lcov.info',
      coveredLines: measured(75),
      totalLines: measured(100),
    },
  };
}

function combinedAnalysis(options: { readonly unknown?: boolean } = {}): Record<string, unknown> {
  const files = [
    makeFile(FILE_CONTEXT, 'context', 'third-party', 30, { contextLibrary: true }),
    makeFile(FILE_A, 'scoped', 'first-party', 100, { rich: true }),
  ];
  const contracts = [
    contract(CONTRACT_B, FILE_A, 'contract', 'VaultB', 200, 60, [CALLABLE_B], CONTRACT_B_STATE),
    contract(CONTRACT_A, FILE_A, 'contract', 'VaultA', 0, 70, [CALLABLE_A], CONTRACT_A_STATE),
    contract(
      CONTRACT_CONTEXT,
      FILE_CONTEXT,
      'contract',
      'CtxBoundary',
      0,
      20,
      [],
      EMPTY_CONTRACT_STATE,
    ),
    contract(LIBRARY_CONTEXT, FILE_CONTEXT, 'library', 'Ctx', 20, 10, [], EMPTY_CONTRACT_STATE),
  ];
  const callables = [
    callable(FILE_A, CONTRACT_B, CALLABLE_B, null, 210),
    callable(FILE_A, CONTRACT_A, CALLABLE_A, 'withdraw', 10),
  ];
  const graphs = [
    graph('decl:src/A.sol:call:20:0', CONTRACT_A, CONTRACT_B, 'call', 'resolved-unique'),
    graph(
      'decl:src/A.sol:boundary:40:0',
      CONTRACT_A,
      CONTRACT_CONTEXT,
      'inheritance',
      'resolved-unique',
    ),
    graph(
      'decl:src/A.sol:inheritance:50:0',
      CONTRACT_A,
      CONTRACT_CONTEXT,
      'inheritance',
      'ambiguous',
    ),
  ];
  return {
    files,
    contracts,
    callables,
    aggregates: {
      scopedFiles: measured(1, [evidence(FILE_A, 1)]),
      physicalLines: measured(125, [evidence(FILE_A, 1)]),
      sourceLines: measured(100, [evidence(FILE_A, 1)]),
      contracts: measured(2, [evidence(FILE_A, 5)]),
      callables: measured(2, [evidence(FILE_A, 10)]),
    },
    graphs,
    indicators: [
      indicator('needs-manual-review', 'Review dynamic call dispatch', true),
      indicator('understood-pattern', 'Known state shape', false),
    ],
    testObservations: [
      { path: 'test/Happy.sol', present: measured(false, [evidence(FILE_A, 5)]) },
      { path: 'test/Happy.sol', present: measured(true, [evidence(FILE_A, 8)]) },
    ],
    coverageObservation: {
      source: 'coverage/lcov.info',
      coveredLines: measured(75, [evidence(FILE_A, 15)]),
      totalLines: measured(100, [evidence(FILE_A, 18)]),
    },
    completeness: {
      requiredAnalysisComplete: true,
      hasUnknownSemantics: options.unknown ?? false,
      analyzedFileIds: [FILE_CONTEXT, FILE_A],
      unavailableFileIds: [],
    },
  };
}

function contextFailureAnalysis(): Record<string, unknown> {
  return {
    files: [makeIncompleteContextFile(), makeFile(FILE_A, 'scoped', 'first-party', 100)],
    contracts: [],
    callables: [],
    aggregates: {
      scopedFiles: measured(1, [evidence(FILE_A, 1)]),
      physicalLines: measured(125, [evidence(FILE_A, 1)]),
      sourceLines: measured(100, [evidence(FILE_A, 1)]),
      contracts: measured(0),
      callables: measured(0),
    },
    graphs: [],
    indicators: [],
    testObservations: [],
    coverageObservation: null,
    completeness: {
      requiredAnalysisComplete: false,
      hasUnknownSemantics: true,
      analyzedFileIds: [FILE_A],
      unavailableFileIds: [FILE_CONTEXT],
    },
  };
}

function diagnostic(
  code: 'PARTIAL_ANALYSIS' | 'OWNERSHIP_UNKNOWN' | 'TARGET_UNREADABLE',
  severity: 'warning' | 'error',
  phase: 'discovery' | 'parse',
  message: string,
  fileId?: string,
): unknown {
  return {
    code,
    severity,
    phase,
    message,
    ...(fileId === undefined ? {} : { fileId, range: range(5, 10) }),
    details: [
      { key: 'source', value: 'application companion' },
      { key: 'observation', value: 'not enumerated' },
    ],
  };
}

function envelope(input: {
  readonly command: 'estimate' | 'inspect' | 'explain';
  readonly status: 'complete' | 'partial' | 'error';
  readonly failureCategory?: 'target' | null;
  readonly scope: unknown;
  readonly analysis: unknown;
  readonly estimate: unknown;
  readonly fullScopeEstimate?: unknown;
  readonly diagnostics?: readonly unknown[];
  readonly limitations?: readonly string[];
}): ReportEnvelope {
  return ReportEnvelopeSchema.parse({
    schemaVersion: '1.0.0',
    toolVersion: '0.1.0',
    command: input.command,
    status: input.status,
    failureCategory: input.failureCategory ?? null,
    versions: {
      parser: 'slang@1.3.9',
      metrics: '1.0.0',
      indicators: '1.0.0',
      model: '1.0.0',
    },
    fingerprints: {
      sources: '0'.repeat(64),
      semanticConfig: '1'.repeat(64),
      analysis: '2'.repeat(64),
    },
    scope: input.scope,
    analysis: input.analysis,
    estimate: input.estimate,
    fullScopeEstimate: input.fullScopeEstimate ?? null,
    diagnostics: input.diagnostics ?? [],
    limitations: input.limitations ?? [],
  });
}

const simple = envelope({
  command: 'estimate',
  status: 'complete',
  scope: scope(false, false),
  analysis: simpleAnalysis(),
  estimate: expectedEstimate('simple'),
  limitations: ['No parser semantics beyond supplied syntax metrics.'],
});

const combined = envelope({
  command: 'explain',
  status: 'complete',
  scope: scope(true, true),
  analysis: combinedAnalysis(),
  estimate: expectedEstimate('combined'),
  fullScopeEstimate: expectedEstimate('combined'),
  diagnostics: [
    diagnostic(
      'OWNERSHIP_UNKNOWN',
      'warning',
      'discovery',
      'Ownership for an excluded path is unknown.',
      FILE_EXCLUDED,
    ),
  ],
  limitations: ['Unresolved companion observations remain visible as supplied.'],
});

const unknownSemantics = envelope({
  command: 'estimate',
  status: 'complete',
  scope: scope(true, false),
  analysis: combinedAnalysis({ unknown: true }),
  estimate: expectedEstimate('unknown'),
  limitations: ['Unknown semantics add only the supplied uncertainty reserve.'],
});

const partialAnalysis = {
  ...simpleAnalysis(),
  completeness: {
    requiredAnalysisComplete: false,
    hasUnknownSemantics: false,
    analyzedFileIds: [FILE_A],
    unavailableFileIds: [FILE_B],
  },
};

const partialSubset = envelope({
  command: 'estimate',
  status: 'partial',
  scope: scope(false, false),
  analysis: partialAnalysis,
  estimate: expectedEstimate('partial-explicit'),
  diagnostics: [
    diagnostic(
      'PARTIAL_ANALYSIS',
      'warning',
      'discovery',
      'One selected path was omitted from the manifest.',
    ),
  ],
  limitations: ['Omitted path list is incomplete; not enumerated.'],
});

const failedContext = contextFailureAnalysis();
const partialWithoutEstimate = envelope({
  command: 'estimate',
  status: 'partial',
  scope: scope(true, false),
  analysis: failedContext,
  estimate: null,
  diagnostics: [
    diagnostic(
      'PARTIAL_ANALYSIS',
      'warning',
      'parse',
      'Required context analysis failed.',
      FILE_CONTEXT,
    ),
  ],
  limitations: ['Full-scope effort unavailable because required context did not complete.'],
});

const requiredContextFailure = envelope({
  command: 'explain',
  status: 'partial',
  scope: scope(true, false),
  analysis: failedContext,
  estimate: expectedEstimate('failed-context-partial'),
  diagnostics: [
    diagnostic(
      'PARTIAL_ANALYSIS',
      'warning',
      'parse',
      'Required context analysis failed.',
      FILE_CONTEXT,
    ),
  ],
  limitations: ['Scoped syntax is complete; required context work is incomplete.'],
});

const inspect = envelope({
  command: 'inspect',
  status: 'complete',
  scope: scope(true, true),
  analysis: combinedAnalysis(),
  estimate: null,
  limitations: ['Inspect mode reports observations without effort.'],
});

const error = envelope({
  command: 'estimate',
  status: 'error',
  failureCategory: 'target',
  scope: scope(false, false),
  analysis: null,
  estimate: null,
  diagnostics: [
    diagnostic('TARGET_UNREADABLE', 'error', 'discovery', 'Target could not be read.', FILE_A),
  ],
  limitations: ['No analysis was produced.'],
});

const completeReadinessWarning = envelope({
  command: 'estimate',
  status: 'complete',
  scope: scope(true, false),
  analysis: combinedAnalysis(),
  estimate: expectedEstimate('combined'),
  diagnostics: [
    diagnostic(
      'PARTIAL_ANALYSIS',
      'warning',
      'parse',
      'Optional readiness evidence is incomplete.',
    ),
  ],
  limitations: ['Readiness coverage is supplied for a matched subset only.'],
});

const simpleGolden = envelope({
  command: 'estimate',
  status: 'complete',
  scope: scope(false, false),
  analysis: completeGoldenAnalysis(),
  estimate: goldenEstimate('full'),
});

const requiredContextGolden = envelope({
  command: 'estimate',
  status: 'partial',
  scope: scope(true, false),
  analysis: minimalAnalysis({ partial: true, unknown: true }),
  estimate: goldenEstimate('analyzed-subset'),
  diagnostics: [
    diagnostic(
      'PARTIAL_ANALYSIS',
      'warning',
      'parse',
      'Required context analysis failed.',
      FILE_CONTEXT,
    ),
  ],
  limitations: ['Scoped syntax is complete; required context work is incomplete.'],
});

type ReportCaseName =
  | 'simple'
  | 'combined'
  | 'unknownSemantics'
  | 'partialSubset'
  | 'partialWithoutEstimate'
  | 'inspect'
  | 'error'
  | 'completeReadinessWarning'
  | 'requiredContextFailure';

export const reportCases: Readonly<Record<ReportCaseName, ReportEnvelope>> = {
  simple,
  combined,
  unknownSemantics,
  partialSubset,
  partialWithoutEstimate,
  inspect,
  error,
  completeReadinessWarning,
  requiredContextFailure,
};

export const goldenReportCases: Readonly<{
  readonly simple: ReportEnvelope;
  readonly requiredContextFailure: ReportEnvelope;
}> = {
  simple: simpleGolden,
  requiredContextFailure: requiredContextGolden,
} as const;

export function reportCase(name: ReportCaseName): ReportEnvelope {
  return reportCases[name];
}
