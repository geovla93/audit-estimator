import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildAnalysisEnvelope, EMPTY_SCOPE_MANIFEST } from '../../src/application/envelope.ts';
import { buildEstimateInput } from '../../src/application/estimate-input.ts';
import type { EstimateInputSource } from '../../src/application/estimate-input.ts';
import { productionConfigDefaults } from '../../src/application/defaults.ts';
import { contractIdentity, fileIdentity } from '../../src/domain/canonical.ts';
import {
  EstimateInputSchema,
  EstimateResultSchema,
  ReportEnvelopeSchema,
} from '../../src/domain/schemas.ts';
import type {
  Analysis,
  ContractAnalysis,
  ContractId,
  FileAnalysis,
  FileId,
  FileScopeEntry,
  Measurement,
  Ownership,
  ResolvedConfig,
  ScopeRole,
  StateVariables,
} from '../../src/domain/types.ts';
import { estimateEffort } from '../../src/index.ts';
import type { FileMetrics } from '../../src/metrics/structural.ts';
import { DEFAULT_SCOPE_SETTINGS } from '../../src/config/defaults.ts';
import { selectModel } from '../../src/estimation/model.ts';

function measured<T>(value: T): Measurement<T> {
  return { status: 'measured', value, evidence: [] };
}

const RANGE = {
  startByte: 0,
  endByte: 10,
  start: { line: 1, column: 1 },
  end: { line: 1, column: 11 },
};

function id(path: string): FileId {
  return fileIdentity(path);
}

function contractId(path: string, start = 0): ContractId {
  return contractIdentity(path, 'contract', start);
}

function storage(
  shapes: readonly {
    readonly declarationId: string;
    readonly shape: 'elementary' | 'mapping' | 'array' | 'struct' | 'user-defined' | 'unknown';
    readonly mutable: boolean;
  }[],
): StateVariables {
  const mutable = shapes.filter((shape) => shape.mutable);
  const complex = mutable.filter((shape) => shape.shape === 'mapping' || shape.shape === 'array');
  return {
    count: measured(shapes.length),
    mutableCount: measured(mutable.length),
    complexMutableDeclarationIds: measured(complex.map((shape) => shape.declarationId)),
    typeShapes: measured(shapes),
  };
}

function fileAnalysis(path: string, state: StateVariables, sourceLines = 20): FileAnalysis {
  return {
    fileId: id(path),
    role: 'scoped',
    ownership: 'first-party',
    physicalLines: measured(sourceLines + 2),
    sourceLines: measured(sourceLines),
    declarationCounts: {
      contracts: measured(1),
      abstractContracts: measured(0),
      libraries: measured(0),
      interfaces: measured(0),
    },
    stateVariables: state,
    decisions: measured(2),
    loops: measured(0),
    maxLoopDepth: measured(0),
    assemblyBlocks: measured(0),
    yulStatements: measured(0),
    yulCalls: measured(0),
    yulControlFlow: measured(0),
    lowLevelCallCandidates: measured(0),
    importIds: [],
    contractIds: [contractId(path)],
    callableIds: [],
    syntaxComplete: true,
  };
}

function contractFor(path: string): ContractAnalysis {
  const fileId = id(path);
  return {
    id: contractId(path),
    fileId,
    kind: 'contract',
    name: 'C',
    range: RANGE,
    sourceLines: measured(10),
    callableIds: [],
    stateVariables: storage([]),
  };
}

function metricsFor(path: string, state: StateVariables = storage([])): FileMetrics {
  const file = fileAnalysis(path, state);
  return {
    file,
    contracts: [contractFor(path)],
    callables: [],
    lineSet: { fileId: file.fileId, oneBasedLines: new Set([1, 2, 3]) },
    wholeFile: { fileId: file.fileId, range: RANGE },
  };
}

function entry(
  path: string,
  role: ScopeRole = 'scoped',
  ownership: Ownership = 'first-party',
): FileScopeEntry {
  return {
    fileId: id(path),
    path,
    role,
    ownership,
    ownershipEvidence: [],
    physicalIdentity: `fixture:${path}`,
    byteHash: 'a'.repeat(64),
  };
}

function configFor(): ResolvedConfig {
  const defaults = productionConfigDefaults();
  return {
    configVersion: '1.0.0',
    scope: { ...DEFAULT_SCOPE_SETTINGS },
    imports: defaults.imports,
    solidity: defaults.solidity,
    analysis: defaults.analysis,
    model: selectModel(),
    manualAdjustments: [],
    coverage: { lcovPath: null },
    report: { format: 'terminal' },
    provenance: [],
  };
}

interface SourceOverrides {
  readonly entries?: readonly FileScopeEntry[];
  readonly metrics?: readonly FileMetrics[];
  readonly parsed?: readonly string[];
  readonly invalidated?: readonly string[];
  readonly builtins?: readonly { readonly path: string; readonly value: number }[];
  readonly scopedPairs?: readonly [string, string][];
  readonly contextPairs?: readonly [string, string][];
  readonly complete?: boolean;
  readonly allowPartial?: boolean;
}

function pair(left: string, right: string): EstimateInputSource['relationships']['scopedPairs'][0] {
  return {
    leftId: left as ContractId,
    rightId: right as ContractId,
    kinds: ['call'],
    evidence: [],
  };
}

function sourceWith(overrides: SourceOverrides = {}): EstimateInputSource {
  const entries = overrides.entries ?? [entry('src/A.sol'), entry('src/B.sol')];
  const metrics = overrides.metrics ?? [metricsFor('src/A.sol'), metricsFor('src/B.sol')];
  const parsed = overrides.parsed ?? ['src/A.sol', 'src/B.sol'];
  return {
    manifest: {
      entries,
      scopedFileIds: entries.filter((item) => item.role === 'scoped').map((item) => item.fileId),
      contextFileIds: entries.filter((item) => item.role === 'context').map((item) => item.fileId),
      excludedFileIds: [],
    },
    metrics,
    parsedFileIds: new Set(parsed.map(id)),
    relationships: {
      scopedPairs: (overrides.scopedPairs ?? []).map(([left, right]) => pair(left, right)),
      contextPairs: (overrides.contextPairs ?? []).map(([left, right]) => pair(left, right)),
      confirmedBuiltinLowLevelCalls: (
        overrides.builtins ?? [
          { path: 'src/A.sol', value: 0 },
          { path: 'src/B.sol', value: 0 },
        ]
      ).map((item) => ({
        fileId: id(item.path),
        confirmedBuiltinLowLevelCalls: measured(item.value),
      })),
      invalidatedScopedFileIds: (overrides.invalidated ?? []).map(id),
      requiredAnalysisComplete: overrides.complete ?? true,
      hasUnknownSemantics: false,
    },
    requiredAnalysisComplete: overrides.complete ?? true,
    config: configFor(),
    allowPartial: overrides.allowPartial ?? false,
  };
}

const A = contractId('src/A.sol');
const B = contractId('src/B.sol');
const EXTERNAL = contractId('lib/External.sol');

describe('eligible file selection', () => {
  it('keeps parsed first-party scoped files in code-point order', () => {
    const input = buildEstimateInput(sourceWith());
    expect(input.eligibleFiles.map((file) => file.fileId)).toEqual([
      id('src/A.sol'),
      id('src/B.sol'),
    ]);
    expect(EstimateInputSchema.parse(input)).toEqual(input);
  });

  it('excludes a file whose syntax failed', () => {
    const input = buildEstimateInput(sourceWith({ parsed: ['src/A.sol'] }));
    expect(input.eligibleFiles.map((file) => file.fileId)).toEqual([id('src/A.sol')]);
  });

  it('excludes an ownership-invalidated file', () => {
    const input = buildEstimateInput(sourceWith({ invalidated: ['src/B.sol'] }));
    expect(input.eligibleFiles.map((file) => file.fileId)).toEqual([id('src/A.sol')]);
  });

  it('excludes a third-party scoped file', () => {
    const input = buildEstimateInput(
      sourceWith({ entries: [entry('src/A.sol'), entry('src/B.sol', 'scoped', 'third-party')] }),
    );
    expect(input.eligibleFiles.map((file) => file.fileId)).toEqual([id('src/A.sol')]);
  });

  it('reports a missing builtin row as unavailable, never zero', () => {
    const input = buildEstimateInput(sourceWith({ builtins: [{ path: 'src/A.sol', value: 2 }] }));
    const [first, second] = input.eligibleFiles;
    expect(first?.confirmedBuiltinLowLevelCalls).toEqual(measured(2));
    expect(second?.confirmedBuiltinLowLevelCalls.status).toBe('unavailable');
  });
});

describe('storage classification', () => {
  const userDefined = storage([
    { declarationId: 'decl:a', shape: 'user-defined', mutable: true },
    { declarationId: 'decl:b', shape: 'mapping', mutable: true },
  ]);

  it('marks complex storage unavailable only in the estimator copy', () => {
    const metrics = [metricsFor('src/A.sol', userDefined), metricsFor('src/B.sol')];
    const before = structuredClone(metrics);
    const input = buildEstimateInput(sourceWith({ metrics }));
    expect(input.eligibleFiles[0]?.stateVariables.complexMutableDeclarationIds.status).toBe(
      'unavailable',
    );
    expect(input.eligibleFiles[1]?.stateVariables.complexMutableDeclarationIds.status).toBe(
      'measured',
    );
    expect(metrics).toEqual(before);
    expect(metrics[0]?.file.stateVariables.complexMutableDeclarationIds.status).toBe('measured');
  });

  it('keeps mapping and array only storage measured', () => {
    const mapped = storage([
      { declarationId: 'decl:a', shape: 'mapping', mutable: true },
      { declarationId: 'decl:b', shape: 'array', mutable: true },
    ]);
    const input = buildEstimateInput(
      sourceWith({ metrics: [metricsFor('src/A.sol', mapped), metricsFor('src/B.sol')] }),
    );
    expect(input.eligibleFiles[0]?.stateVariables).toEqual(mapped);
  });
});

describe('pair filtering', () => {
  const contextEntries = [
    entry('src/A.sol'),
    entry('src/B.sol'),
    entry('lib/External.sol', 'context'),
  ];

  it('drops a scoped pair with an ineligible endpoint', () => {
    const input = buildEstimateInput(sourceWith({ parsed: ['src/A.sol'], scopedPairs: [[A, B]] }));
    expect(input.scopedPairs).toEqual([]);
  });

  it('keeps a context pair only for an eligible scoped endpoint', () => {
    const kept = buildEstimateInput(
      sourceWith({ entries: contextEntries, contextPairs: [[A, EXTERNAL]] }),
    );
    expect(kept.contextPairs).toEqual([{ leftId: A, rightId: EXTERNAL }]);
    const dropped = buildEstimateInput(
      sourceWith({
        entries: contextEntries,
        parsed: ['src/B.sol'],
        contextPairs: [[A, EXTERNAL]],
      }),
    );
    expect(dropped.contextPairs).toEqual([]);
  });

  it('collapses a cross-partition duplicate and keeps the scoped one', () => {
    const input = buildEstimateInput(
      sourceWith({ entries: contextEntries, scopedPairs: [[A, B]], contextPairs: [[A, B]] }),
    );
    expect(input.scopedPairs).toEqual([{ leftId: A, rightId: B }]);
    expect(input.contextPairs).toEqual([]);
  });

  it('collapses same-partition duplicates and keeps the reversed direction', () => {
    const input = buildEstimateInput(
      sourceWith({
        scopedPairs: [
          [A, B],
          [A, B],
          [B, A],
        ],
      }),
    );
    expect(input.scopedPairs).toEqual([
      { leftId: A, rightId: B },
      { leftId: B, rightId: A },
    ]);
  });
});

describe('readiness neutrality', () => {
  it('ignores non-estimating facts, so the estimate is identical', () => {
    const base = sourceWith();
    const altered: EstimateInputSource = {
      ...base,
      metrics: base.metrics.map((metrics) => ({
        ...metrics,
        lineSet: null,
        callables: [],
      })),
    };
    const first = buildEstimateInput(base);
    const second = buildEstimateInput(altered);
    expect(second).toEqual(first);
    expect(estimateEffort(second)).toEqual(estimateEffort(first));
  });
});

describe('report status from worked cases', () => {
  const WorkedCase = z.object({
    id: z.string(),
    input: EstimateInputSchema,
    application: z.object({
      reportStatus: z.enum(['complete', 'partial']),
      fullScopeEstimateExpected: z.boolean(),
    }),
  });
  const cases = z
    .array(WorkedCase)
    .parse(
      JSON.parse(
        readFileSync(new URL('../fixtures/estimation/worked-cases.json', import.meta.url), 'utf8'),
      ) as unknown,
    );

  function minimalAnalysis(requiredAnalysisComplete: boolean): Analysis {
    const count = measured(0);
    return {
      files: [],
      contracts: [],
      callables: [],
      aggregates: {
        scopedFiles: count,
        physicalLines: count,
        sourceLines: count,
        contracts: count,
        callables: count,
      },
      graphs: [],
      indicators: [],
      testObservations: [],
      coverageObservation: null,
      completeness: {
        requiredAnalysisComplete,
        hasUnknownSemantics: false,
        analyzedFileIds: [],
        unavailableFileIds: [],
      },
    };
  }

  it('covers every frozen application case', () => {
    expect(cases).toHaveLength(27);
    expect(cases.filter((item) => item.application.reportStatus === 'complete')).toHaveLength(20);
  });

  it.each(cases.map((item) => [item.id, item] as const))('maps %s', (_name, item) => {
    const estimate = estimateEffort(item.input);
    if (estimate !== null) EstimateResultSchema.parse(estimate);
    const envelope = buildAnalysisEnvelope({
      identity: { command: 'estimate', parser: 'slang@1.3.9', semanticConfig: 'b'.repeat(64) },
      sources: 'c'.repeat(64),
      scope: EMPTY_SCOPE_MANIFEST,
      analysis: minimalAnalysis(item.input.requiredAnalysisComplete),
      estimate,
      diagnostics: [],
      limitations: [],
    });
    expect(envelope.status).toBe(item.application.reportStatus);
    expect(envelope.fullScopeEstimate !== null).toBe(item.application.fullScopeEstimateExpected);
    expect(envelope.fullScopeEstimate).toBe(
      item.application.fullScopeEstimateExpected ? envelope.estimate : null,
    );
    ReportEnvelopeSchema.parse(envelope);
  });
});
