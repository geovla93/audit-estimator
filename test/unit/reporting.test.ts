import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { canonicalJson, fingerprint, sortById } from '../../src/domain/canonical.ts';
import {
  EstimateInputSchema,
  EstimateResultSchema,
  FileIdSchema,
  ReportEnvelopeSchema,
} from '../../src/domain/schemas.ts';
import type {
  Analysis,
  EstimateInput,
  EstimateResult,
  EvidenceRef,
  FileAnalysis,
  Measurement,
  ReportEnvelope,
  StateVariables,
} from '../../src/domain/types.ts';
import { canonicalDisplayValue, parseDisplayEnvelope } from '../../src/reporting/display.ts';
import { serializeJson } from '../../src/reporting/json.ts';
import { formatMarkdown } from '../../src/reporting/markdown.ts';
import { sanitizeMarkdownText, sanitizeTerminalText } from '../../src/reporting/sanitize.ts';
import { formatTerminal } from '../../src/reporting/terminal.ts';
import { estimateEffort } from '../../src/estimation/estimate.ts';
import { goldenReportCases, reportCases } from '../fixtures/reports/cases.ts';

interface WorkedInput {
  readonly id: string;
  readonly input: EstimateInput;
  readonly expected: { readonly estimate: EstimateResult | null };
}

const workedInputs = z
  .array(
    z.looseObject({
      id: z.string(),
      input: EstimateInputSchema,
      expected: z.looseObject({ estimate: EstimateResultSchema.nullable() }),
    }),
  )
  .parse(
    JSON.parse(
      readFileSync(new URL('../fixtures/estimation/worked-cases.json', import.meta.url), 'utf8'),
    ) as unknown,
  ) as readonly WorkedInput[];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

function asEnvelope(value: unknown): ReportEnvelope {
  return value as ReportEnvelope;
}

function reverseEvidence<T>(measurement: Measurement<T>): Measurement<T> {
  return measurement.status === 'measured'
    ? { ...measurement, evidence: [...measurement.evidence].reverse() }
    : measurement;
}

function remapEvidence<T>(
  measurement: Measurement<T>,
  fromId: string,
  toId: EvidenceRef['fileId'],
): Measurement<T> {
  return measurement.status === 'measured'
    ? {
        ...measurement,
        evidence: measurement.evidence.map((reference) =>
          reference.fileId === fromId ? { ...reference, fileId: toId } : reference,
        ),
      }
    : measurement;
}

function reverseState(state: StateVariables): StateVariables {
  const complex = reverseEvidence(state.complexMutableDeclarationIds);
  const shapes = reverseEvidence(state.typeShapes);
  return {
    count: reverseEvidence(state.count),
    mutableCount: reverseEvidence(state.mutableCount),
    complexMutableDeclarationIds:
      complex.status === 'measured' ? { ...complex, value: [...complex.value].reverse() } : complex,
    typeShapes:
      shapes.status === 'measured' ? { ...shapes, value: [...shapes.value].reverse() } : shapes,
  };
}

function reverseEvidenceRef(items: readonly EvidenceRef[]): EvidenceRef[] {
  return [...items].reverse();
}

function permuteSetCollections(envelope: ReportEnvelope): ReportEnvelope {
  const analysis = envelope.analysis;
  if (analysis === null) return envelope;
  const permutedAnalysis: Analysis = {
    ...analysis,
    files: [...analysis.files].reverse().map((file) => ({
      ...file,
      physicalLines: reverseEvidence(file.physicalLines),
      sourceLines: reverseEvidence(file.sourceLines),
      declarationCounts: {
        contracts: reverseEvidence(file.declarationCounts.contracts),
        abstractContracts: reverseEvidence(file.declarationCounts.abstractContracts),
        libraries: reverseEvidence(file.declarationCounts.libraries),
        interfaces: reverseEvidence(file.declarationCounts.interfaces),
      },
      stateVariables: reverseState(file.stateVariables),
      decisions: reverseEvidence(file.decisions),
      loops: reverseEvidence(file.loops),
      maxLoopDepth: reverseEvidence(file.maxLoopDepth),
      assemblyBlocks: reverseEvidence(file.assemblyBlocks),
      yulStatements: reverseEvidence(file.yulStatements),
      yulCalls: reverseEvidence(file.yulCalls),
      yulControlFlow: reverseEvidence(file.yulControlFlow),
      lowLevelCallCandidates: reverseEvidence(file.lowLevelCallCandidates),
      importIds: [...file.importIds].reverse(),
      contractIds: [...file.contractIds].reverse(),
      callableIds: [...file.callableIds].reverse(),
    })),
    contracts: [...analysis.contracts].reverse().map((contract) => ({
      ...contract,
      sourceLines: reverseEvidence(contract.sourceLines),
      callableIds: [...contract.callableIds].reverse(),
      stateVariables: reverseState(contract.stateVariables),
    })),
    callables: [...analysis.callables].reverse().map((callable) => ({
      ...callable,
      visibilityExplicit: reverseEvidence(callable.visibilityExplicit),
      visibilityEffective: reverseEvidence(callable.visibilityEffective),
      mutabilityExplicit: reverseEvidence(callable.mutabilityExplicit),
      mutabilityEffective: reverseEvidence(callable.mutabilityEffective),
      hasBody: reverseEvidence(callable.hasBody),
      decisions: reverseEvidence(callable.decisions),
      loops: reverseEvidence(callable.loops),
      maxLoopDepth: reverseEvidence(callable.maxLoopDepth),
      assemblyBlocks: reverseEvidence(callable.assemblyBlocks),
      yulStatements: reverseEvidence(callable.yulStatements),
      yulCalls: reverseEvidence(callable.yulCalls),
      yulControlFlow: reverseEvidence(callable.yulControlFlow),
      lowLevelCallCandidates: reverseEvidence(callable.lowLevelCallCandidates),
      modifiersApplied: reverseEvidence(callable.modifiersApplied),
    })),
    aggregates: {
      scopedFiles: reverseEvidence(analysis.aggregates.scopedFiles),
      physicalLines: reverseEvidence(analysis.aggregates.physicalLines),
      sourceLines: reverseEvidence(analysis.aggregates.sourceLines),
      contracts: reverseEvidence(analysis.aggregates.contracts),
      callables: reverseEvidence(analysis.aggregates.callables),
    },
    graphs: [...analysis.graphs].reverse().map((graph) => ({
      ...graph,
      candidateTargets: [...graph.candidateTargets].reverse(),
      evidence: reverseEvidenceRef(graph.evidence),
    })),
    indicators: [...analysis.indicators].reverse().map((indicator) => ({
      ...indicator,
      evidence: reverseEvidenceRef(indicator.evidence),
    })),
    testObservations: [...analysis.testObservations].reverse().map((observation) => ({
      ...observation,
      present: reverseEvidence(observation.present),
    })),
    coverageObservation:
      analysis.coverageObservation === null
        ? null
        : {
            ...analysis.coverageObservation,
            coveredLines: reverseEvidence(analysis.coverageObservation.coveredLines),
            totalLines: reverseEvidence(analysis.coverageObservation.totalLines),
          },
    completeness: {
      ...analysis.completeness,
      analyzedFileIds: [...analysis.completeness.analyzedFileIds].reverse(),
      unavailableFileIds: [...analysis.completeness.unavailableFileIds].reverse(),
    },
  };
  return {
    ...envelope,
    scope: {
      ...envelope.scope,
      entries: [...envelope.scope.entries].reverse().map((entry) => ({
        ...entry,
        ownershipEvidence: [...entry.ownershipEvidence].reverse(),
      })),
      scopedFileIds: [...envelope.scope.scopedFileIds].reverse(),
      contextFileIds: [...envelope.scope.contextFileIds].reverse(),
      excludedFileIds: [...envelope.scope.excludedFileIds].reverse(),
    },
    analysis: permutedAnalysis,
  };
}

function markdownTableCellCounts(markdown: string): number[][] {
  const lines = markdown.split('\n');
  const result: number[][] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.startsWith('| ')) continue;
    const cells = line.split('|').length - 2;
    const block = [cells];
    let next = index + 1;
    while ((lines[next] ?? '').startsWith('| ')) {
      block.push((lines[next] ?? '').split('|').length - 2);
      next += 1;
    }
    result.push(block);
    index = next - 1;
  }
  return result;
}

function golden(directory: 'json' | 'terminal' | 'markdown', filename: string): string {
  return readFileSync(new URL(`../golden/${directory}/${filename}`, import.meta.url), 'utf8');
}

function productionId(fixtureId: string): string {
  if (fixtureId === 'project' || fixtureId === 'reserve') return fixtureId;
  const colon = fixtureId.indexOf(':');
  const category = fixtureId.slice(0, colon);
  const rest = fixtureId.slice(colon + 1);
  const identity = category === 'interaction' || category === 'boundary' ? rest.split('>') : [rest];
  return `${category}:${fingerprint([category, canonicalJson(identity)])}`;
}

function numericEstimate(estimate: EstimateResult): unknown {
  return {
    profile: estimate.profile,
    modelVersion: estimate.modelVersion,
    label: estimate.label,
    coverage: estimate.coverage,
    auditorHours: estimate.auditorHours,
    auditorDays: estimate.auditorDays,
    contributions: estimate.contributions.map((row) => ({
      id: row.id,
      category: row.category,
      lowMicrohours: row.lowMicrohours,
      highMicrohours: row.highMicrohours,
      inputStatus: row.inputStatus,
    })),
    parameters: estimate.parameters,
    manualAdjustments: estimate.manualAdjustments,
  };
}

function multipleCompletenessCase(): ReportEnvelope {
  const base = reportCases.partialWithoutEstimate;
  const analysis = base.analysis;
  if (analysis === null) throw new Error('Partial fixture requires analysis');
  const scopedFile = analysis.files.find((file) => file.fileId === 'file:src/A.sol');
  const scopedEntry = base.scope.entries.find((entry) => entry.fileId === 'file:src/A.sol');
  if (scopedFile === undefined || scopedEntry === undefined) {
    throw new Error('Partial fixture requires scoped file and manifest entry');
  }
  const secondFileId = FileIdSchema.parse('file:src/B.sol');
  const omittedFileId = FileIdSchema.parse('file:src/C.sol');
  const contextFileId = FileIdSchema.parse('file:lib/Ctx.sol');
  const secondFile: FileAnalysis = {
    ...scopedFile,
    fileId: secondFileId,
    physicalLines: remapEvidence(scopedFile.physicalLines, scopedFile.fileId, secondFileId),
    sourceLines: remapEvidence(scopedFile.sourceLines, scopedFile.fileId, secondFileId),
    declarationCounts: {
      contracts: remapEvidence(
        scopedFile.declarationCounts.contracts,
        scopedFile.fileId,
        secondFileId,
      ),
      abstractContracts: remapEvidence(
        scopedFile.declarationCounts.abstractContracts,
        scopedFile.fileId,
        secondFileId,
      ),
      libraries: remapEvidence(
        scopedFile.declarationCounts.libraries,
        scopedFile.fileId,
        secondFileId,
      ),
      interfaces: remapEvidence(
        scopedFile.declarationCounts.interfaces,
        scopedFile.fileId,
        secondFileId,
      ),
    },
    stateVariables: {
      count: remapEvidence(scopedFile.stateVariables.count, scopedFile.fileId, secondFileId),
      mutableCount: remapEvidence(
        scopedFile.stateVariables.mutableCount,
        scopedFile.fileId,
        secondFileId,
      ),
      complexMutableDeclarationIds: remapEvidence(
        scopedFile.stateVariables.complexMutableDeclarationIds,
        scopedFile.fileId,
        secondFileId,
      ),
      typeShapes: remapEvidence(
        scopedFile.stateVariables.typeShapes,
        scopedFile.fileId,
        secondFileId,
      ),
    },
    decisions: remapEvidence(scopedFile.decisions, scopedFile.fileId, secondFileId),
    loops: remapEvidence(scopedFile.loops, scopedFile.fileId, secondFileId),
    maxLoopDepth: remapEvidence(scopedFile.maxLoopDepth, scopedFile.fileId, secondFileId),
    assemblyBlocks: remapEvidence(scopedFile.assemblyBlocks, scopedFile.fileId, secondFileId),
    yulStatements: remapEvidence(scopedFile.yulStatements, scopedFile.fileId, secondFileId),
    yulCalls: remapEvidence(scopedFile.yulCalls, scopedFile.fileId, secondFileId),
    yulControlFlow: remapEvidence(scopedFile.yulControlFlow, scopedFile.fileId, secondFileId),
    lowLevelCallCandidates: remapEvidence(
      scopedFile.lowLevelCallCandidates,
      scopedFile.fileId,
      secondFileId,
    ),
  };
  const secondEntry = {
    ...scopedEntry,
    fileId: secondFileId,
    path: 'src/B.sol',
    physicalIdentity: 'src/B.sol',
    byteHash: '3'.repeat(64),
    ownershipEvidence: scopedEntry.ownershipEvidence.map((reference) =>
      reference.fileId === scopedEntry.fileId ? { ...reference, fileId: secondFileId } : reference,
    ),
  };
  return ReportEnvelopeSchema.parse({
    ...base,
    scope: {
      ...base.scope,
      entries: [...base.scope.entries, secondEntry],
      scopedFileIds: [...base.scope.scopedFileIds, secondFileId],
    },
    analysis: {
      ...analysis,
      files: [...analysis.files, secondFile],
      aggregates: {
        ...analysis.aggregates,
        scopedFiles: { status: 'measured', value: 2, evidence: [] },
        physicalLines: { status: 'measured', value: 250, evidence: [] },
        sourceLines: { status: 'measured', value: 200, evidence: [] },
      },
      completeness: {
        requiredAnalysisComplete: false,
        hasUnknownSemantics: false,
        analyzedFileIds: [...analysis.completeness.analyzedFileIds, secondFileId],
        unavailableFileIds: [omittedFileId, contextFileId],
      },
    },
  });
}

describe('report fixture validation', () => {
  it('validates all report envelopes and structural exemplars at runtime', () => {
    for (const envelope of Object.values(reportCases)) {
      expect(ReportEnvelopeSchema.parse(envelope)).toEqual(envelope);
    }
    for (const envelope of Object.values(goldenReportCases)) {
      expect(ReportEnvelopeSchema.parse(envelope)).toEqual(envelope);
    }
    for (const name of ['inspect.json', 'error.json']) {
      const fixture = JSON.parse(
        readFileSync(new URL(`../fixtures/reports/${name}`, import.meta.url), 'utf8'),
      ) as unknown;
      expect(ReportEnvelopeSchema.parse(fixture)).toBeDefined();
    }
  });
});

describe('json', () => {
  it('matches the simple complete and required-context partial goldens byte for byte', () => {
    expect(serializeJson(goldenReportCases.simple)).toBe(golden('json', 'simple.json'));
    const partial = serializeJson(goldenReportCases.requiredContextFailure);
    expect(partial).toBe(golden('json', 'required-context-failure.json'));
    expect(ReportEnvelopeSchema.parse(JSON.parse(partial) as unknown)).toBeDefined();
  });

  it('matches the independently authored error golden byte for byte', () => {
    const actual = serializeJson(reportCases.error);
    expect(actual).toBe(golden('json', 'error.json'));
    expect(ReportEnvelopeSchema.parse(JSON.parse(actual) as unknown)).toBeDefined();
  });

  it('emits canonical two-space JSON with one trailing LF and preserves raw strings', () => {
    const envelope = reportCases.combined;
    const serialized = serializeJson(envelope);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(serialized.endsWith('\n\n')).toBe(false);
    expect(serialized).toContain('\n  "analysis":');
    expect(serialized).toContain('Review dynamic call dispatch');
    expect(ReportEnvelopeSchema.parse(JSON.parse(serialized) as unknown)).toEqual(
      parseDisplayEnvelope(envelope),
    );
    expect(Object.keys(JSON.parse(serialized) as Record<string, unknown>)).toEqual([
      'analysis',
      'command',
      'diagnostics',
      'estimate',
      'failureCategory',
      'fingerprints',
      'fullScopeEstimate',
      'limitations',
      'schemaVersion',
      'scope',
      'status',
      'toolVersion',
      'versions',
    ]);
  });

  it('uses Unicode code point order for canonical object keys, including astral scalars', () => {
    expect(canonicalDisplayValue({ '😀': 2, '\uE000': 1 })).toBe(
      `{"${String.fromCodePoint(0xe000)}":1,"😀":2}`,
    );
  });

  it('normalizes every set-like collection while preserving supplied ledger and detail order', () => {
    const original = reportCases.combined;
    const permuted = permuteSetCollections(original);
    expect(serializeJson(permuted)).toBe(serializeJson(original));
    expect(original.analysis?.completeness.analyzedFileIds).toEqual([
      'file:lib/Ctx.sol',
      'file:src/A.sol',
    ]);
    expect(original.analysis?.completeness.unavailableFileIds).toEqual([]);

    const estimate = original.estimate;
    expect(estimate).not.toBeNull();
    if (estimate === null) throw new Error('Combined fixture requires an estimate');
    const reorderedEnvelope: ReportEnvelope = {
      ...original,
      estimate: { ...estimate, contributions: [...estimate.contributions].reverse() },
    };
    expect(serializeJson(reorderedEnvelope)).not.toBe(serializeJson(original));

    const multipleIds = multipleCompletenessCase();
    expect(multipleIds.analysis?.completeness.analyzedFileIds).toHaveLength(2);
    expect(multipleIds.analysis?.completeness.unavailableFileIds).toHaveLength(2);
    expect(serializeJson(permuteSetCollections(multipleIds))).toBe(serializeJson(multipleIds));
  });

  it('rejects invalid versions, numeric values and runtime status invariants in every renderer', () => {
    const frozen = deepFreeze(clone(reportCases.combined));
    const before = serializeJson(frozen);
    expect(formatTerminal(frozen)).toBe(formatTerminal(frozen));
    expect(formatMarkdown(frozen)).toBe(formatMarkdown(frozen));
    expect(serializeJson(frozen)).toBe(before);

    const invalids: unknown[] = [
      { ...frozen, extra: true },
      { ...frozen, schemaVersion: '1.1.0' },
      {
        ...frozen,
        analysis: {
          ...frozen.analysis,
          aggregates: {
            ...frozen.analysis?.aggregates,
            sourceLines: { status: 'measured', value: Number.POSITIVE_INFINITY, evidence: [] },
          },
        },
      },
      {
        ...frozen,
        analysis: {
          ...frozen.analysis,
          aggregates: {
            ...frozen.analysis?.aggregates,
            sourceLines: { status: 'measured', value: Number.MAX_SAFE_INTEGER + 1, evidence: [] },
          },
        },
      },
      {
        ...frozen,
        status: 'partial',
        estimate: frozen.estimate,
      },
      {
        ...reportCases.error,
        analysis: reportCases.simple.analysis,
      },
    ];
    const renderers: readonly ((envelope: ReportEnvelope) => string)[] = [
      serializeJson,
      formatTerminal,
      formatMarkdown,
    ];
    for (const invalid of invalids) {
      for (const render of renderers) {
        expect(() => render(asEnvelope(invalid))).toThrow(/./u);
      }
    }
  });

  it('retains assumptions, adjustments, modifiers, diagnostics, details and limitations in supplied order', () => {
    const original = reportCases.combined;
    const analysis = original.analysis;
    const estimate = original.estimate;
    const diagnostic = original.diagnostics[0];
    if (analysis === null || estimate === null || diagnostic === undefined) {
      throw new Error('Combined fixture requires analysis, estimate and diagnostic');
    }
    const ordered: ReportEnvelope = {
      ...original,
      diagnostics: [
        {
          ...diagnostic,
          details: [...(diagnostic.details ?? [])].reverse(),
        },
        {
          code: 'PARTIAL_ANALYSIS',
          severity: 'info',
          phase: 'report',
          message: 'second diagnostic',
          details: [{ key: 'position', value: 'second' }],
        },
      ],
      limitations: [...original.limitations, 'Second supplied limitation.'],
      analysis: {
        ...analysis,
        callables: analysis.callables.map((callable, index) => {
          if (index !== 0 || callable.modifiersApplied.status !== 'measured') return callable;
          return {
            ...callable,
            modifiersApplied: {
              ...callable.modifiersApplied,
              value: [...callable.modifiersApplied.value].reverse(),
            },
          };
        }),
      },
      estimate: {
        ...estimate,
        assumptions: [...estimate.assumptions].reverse(),
        manualAdjustments: [
          {
            id: 'manual-second',
            reason: 'second adjustment',
            category: 'ordered-test',
            lowHours: -0.5,
            highHours: 1.25,
          },
          ...estimate.manualAdjustments,
        ],
      },
    };
    expect(serializeJson(ordered)).not.toBe(serializeJson(original));
    const terminal = formatTerminal(ordered, { detail: true });
    expect(terminal.indexOf('OWNERSHIP_UNKNOWN')).toBeLessThan(
      terminal.indexOf('second diagnostic'),
    );
    expect(terminal.indexOf('observation=not enumerated')).toBeLessThan(
      terminal.indexOf('source=application companion'),
    );
    expect(terminal).toContain('modifiers applied (supplied order): measured onlyOwner, whenOpen');
    expect(terminal.indexOf('Low and high are scenario bounds')).toBeLessThan(
      terminal.indexOf('Every coefficient is an uncalibrated planning assumption'),
    );
    expect(terminal.indexOf('Second supplied limitation.')).toBeGreaterThan(
      terminal.indexOf('Unresolved companion observations'),
    );
    expect(terminal.indexOf('manual-second')).toBeLessThan(
      terminal.indexOf('illustrative-economic-review'),
    );
    const markdown = formatMarkdown(ordered);
    expect(markdown).toContain('modifiers in supplied order measured onlyOwner, whenOpen');
    expect(markdown.indexOf('OWNERSHIP_UNKNOWN')).toBeLessThan(
      markdown.indexOf('second diagnostic'),
    );
    expect(markdown.indexOf('manual-second')).toBeLessThan(
      markdown.indexOf('illustrative&#x2d;economic&#x2d;review'),
    );
  });

  it('matches worked-case estimator numbers and row classifications independently of renderer wording', () => {
    const mappings = [
      ['combined', reportCases.combined],
      ['unknown', reportCases.unknownSemantics],
      ['partial-explicit', reportCases.partialSubset],
      ['failed-context-partial', reportCases.requiredContextFailure],
    ] as const;
    for (const [workedId, envelope] of mappings) {
      const worked = workedInputs.find((item) => item.id === workedId);
      if (worked === undefined) throw new Error(`Missing worked input ${workedId}`);
      const actual = estimateEffort(worked.input);
      const literal = worked.expected.estimate;
      if (actual === null || literal === null || envelope.estimate === null) {
        throw new Error(`Expected estimator result for ${workedId}`);
      }
      const expected = {
        ...literal,
        contributions: sortById(
          literal.contributions.map((row) => ({ ...row, id: productionId(row.id) })),
        ),
      };
      expect(numericEstimate(actual)).toEqual(numericEstimate(expected));
      expect(numericEstimate(envelope.estimate)).toEqual(numericEstimate(expected));
    }
  });

  it('shows fractional overrides, signed adjustments and a distinct full-scope estimate as supplied', () => {
    const estimate = reportCases.combined.estimate;
    if (estimate === null) throw new Error('Combined fixture requires an estimate');
    const manualAdjustment = estimate.manualAdjustments[0];
    if (manualAdjustment === undefined)
      throw new Error('Combined fixture requires a manual adjustment');
    const report: ReportEnvelope = {
      ...reportCases.combined,
      estimate: {
        ...estimate,
        parameters: { ...estimate.parameters, slocHours: { low: 0.05, high: 0.11 } },
        manualAdjustments: [{ ...manualAdjustment, lowHours: -0.5, highHours: 1.25 }],
      },
      fullScopeEstimate: {
        ...estimate,
        auditorHours: { low: 40, high: 50 },
        auditorDays: { low: 5, high: 7 },
      },
    };
    const terminal = formatTerminal(report, { detail: true });
    expect(terminal).toContain('slocHours (auditor-hours/SLOC): 0.05 to 0.11');
    expect(terminal).toContain('-0.5 to 1.25 signed auditor-hours');
    expect(terminal).toContain(
      'Full-scope estimate: uncalibrated heuristic; model heuristic-v1 1.0.0; coverage full; auditor hours 40 to 50; auditor days 5 to 7',
    );
    expect(terminal).toContain('Auditor effort scenario: 10 to 34 auditor hours');
    const markdown = formatMarkdown(report);
    expect(markdown).toContain('| slocHours | 0.05 to 0.11 | auditor-hours/SLOC |');
    expect(markdown).toContain('-0.5 to 1.25 signed auditor-hours');
    expect(markdown).toContain('- Auditor hours: 40 to 50');
  });
});

describe('terminal', () => {
  it('matches independently authored simple complete and required-context partial summaries', () => {
    expect(formatTerminal(goldenReportCases.simple)).toBe(golden('terminal', 'simple.txt'));
    expect(formatTerminal(goldenReportCases.requiredContextFailure, { detail: false })).toBe(
      golden('terminal', 'required-context-failure.txt'),
    );
  });

  it('matches the independently authored error golden byte for byte', () => {
    expect(formatTerminal(reportCases.error, { detail: true })).toBe(
      golden('terminal', 'error.txt'),
    );
  });

  it('shows supplied scenario bounds and per-contract facts without recomputing effort', () => {
    const output = formatTerminal(reportCases.combined);
    expect(output).toContain('10 to 34 auditor hours; 1.2 to 4.3 auditor days');
    expect(output).toContain('Effort, not elapsed delivery time');
    expect(output).toContain('VaultA');
    expect(output).toContain('VaultB');
    expect(output).toContain('Manifest context entries: 1');
    expect(output).toContain('Contribution ledger (supplied row order)');
    expect(output).not.toContain('\u001b');
  });

  it('defaults to explain detail, honors explicit detail, and includes evidence and model docs', () => {
    const explain = reportCases.combined;
    const detailed = formatTerminal(explain);
    expect(detailed).toContain('Contribution ledger (supplied row order)');
    expect(detailed).toContain('docs/model/heuristic-v1.md');
    expect(detailed).toContain('evidence: file:src/A.sol');
    expect(formatTerminal(explain, { detail: false })).not.toContain('Contribution ledger');
    expect(formatTerminal(reportCases.simple, { detail: true })).toContain('Contribution ledger');
  });

  it('labels partial cases and distinguishes full-scope effort availability', () => {
    const subset = formatTerminal(reportCases.partialSubset);
    expect(subset).toContain('Analyzed subset. Full-scope effort unavailable.');
    expect(subset).toContain('Reported unavailable IDs: file:src/B.sol');
    expect(subset).toContain('8 to 24 auditor hours; 1 to 3 auditor days');

    const noEstimate = formatTerminal(reportCases.partialWithoutEstimate);
    expect(noEstimate).toContain('Effort unavailable: Required context analysis failed.');
    expect(noEstimate).toContain('Syntax-complete scoped records: 1');
    expect(noEstimate).toContain('Reported unavailable IDs: file:lib/Ctx.sol');

    const required = formatTerminal(reportCases.requiredContextFailure, { detail: true });
    expect(required).toContain('8 to 30 auditor hours; 1 to 3.8 auditor days');
    expect(required).toContain('Syntax-complete scoped records: 1');
    expect(required).toContain('source lines: measured 100');
    expect(required).toContain('required analysis complete: false');
  });

  it('shows complete diagnostics, limitations, error scope, and no fabricated error analysis', () => {
    const combined = formatTerminal(reportCases.combined);
    expect(combined).toContain('OWNERSHIP_UNKNOWN');
    expect(combined).toContain('source=application companion');
    expect(combined).toContain('Unresolved companion observations remain visible as supplied.');

    const error = formatTerminal(reportCases.error, { detail: true });
    expect(error).toContain('Manifest entries');
    expect(error).toContain('src/A.sol | role scoped');
    expect(error).not.toContain('Scoped aggregates');
    expect(error).toContain('TARGET_UNREADABLE');
  });

  it('keeps readiness advisory and labels supplied zero unavailable premiums', () => {
    const readiness = formatTerminal(reportCases.completeReadinessWarning);
    expect(readiness).toContain('Readiness observations are not a security score');
    expect(readiness).toContain('Readiness coverage is supplied for a matched subset only.');

    const estimate = reportCases.combined.estimate;
    expect(estimate).not.toBeNull();
    if (estimate === null) throw new Error('Combined fixture requires an estimate');
    const contributions = estimate.contributions.map((row) =>
      row.category === 'evm'
        ? { ...row, inputStatus: 'unavailable' as const, lowMicrohours: 0, highMicrohours: 0 }
        : row,
    );
    const withOmission: ReportEnvelope = {
      ...reportCases.combined,
      estimate: { ...estimate, contributions },
    };
    expect(formatTerminal(withOmission)).toContain('Omitted premiums in estimate');
  });

  it('applies only renderer-owned color codes after sanitizing attacker-controlled text', () => {
    const modified = clone(reportCases.combined);
    const diagnostic = modified.diagnostics[0];
    expect(diagnostic).toBeDefined();
    if (diagnostic === undefined) throw new Error('Combined fixture requires a diagnostic');
    const hostile = asEnvelope({
      ...modified,
      diagnostics: [
        {
          ...diagnostic,
          message: 'before\r\n\u001b]0;title\u0007mid\u009b31m\u2066after',
          details: [{ key: 'key\rbreak', value: 'value\u0000tail' }],
        },
      ],
      estimate:
        modified.estimate === null
          ? null
          : {
              ...modified.estimate,
              contributions: modified.estimate.contributions.map((row, index) =>
                index === 0
                  ? {
                      ...row,
                      id: '[row](https://evil.test)',
                      category: '<img src=x>',
                    }
                  : row,
              ),
            },
    });
    const output = formatTerminal(hostile, { detail: true, color: true });
    expect(output).toContain('before\\r\\n\\u001b]0;title\\u0007mid\\u009b31m\\u2066after');
    expect(output).toContain('key\\rbreak=value\\u0000tail');
    expect(output).toContain('category <img src=x>');
    expect(output).toContain('[row](https://evil.test) | category <img src=x>');
    const escape = String.fromCodePoint(0x1b);
    const unstyled = [0, 1, 31, 32, 33].reduce(
      (value, code) => value.replaceAll(`${escape}[${String(code)}m`, ''),
      output,
    );
    expect(unstyled).not.toContain(escape);
    expect(output).not.toContain('\u0007');
    expect(output).not.toContain('\u009b');
    expect(output).not.toContain('\u2066');
  });
});

describe('markdown', () => {
  it('matches independently authored simple complete and required-context partial outputs', () => {
    expect(formatMarkdown(goldenReportCases.simple)).toBe(golden('markdown', 'simple.md'));
    expect(formatMarkdown(goldenReportCases.requiredContextFailure)).toBe(
      golden('markdown', 'required-context-failure.md'),
    );
  });

  it('matches the independently authored error golden byte for byte', () => {
    expect(formatMarkdown(reportCases.error)).toBe(golden('markdown', 'error.md'));
  });

  it('renders full supplied detail, effort semantics, evidence, diagnostics and limitations', () => {
    const output = formatMarkdown(reportCases.combined);
    expect(output).toContain('10 to 34 auditor hours');
    expect(output).toContain('Manifest entries');
    expect(output).toContain('Contribution ledger in supplied order');
    expect(output).toContain('docs/model/heuristic-v1.md');
    expect(output).toContain('OWNERSHIP_UNKNOWN');
    expect(output).toContain('Unresolved companion observations remain visible as supplied&#x2e;');
    expect(output).toContain('file&#x3a;src&#x2f;A&#x2e;sol 1:6-1:11 [bytes 5-10]');
  });

  it('keeps every emitted table row within its header column count', () => {
    for (const envelope of Object.values(reportCases)) {
      for (const tableCounts of markdownTableCellCounts(formatMarkdown(envelope))) {
        expect(new Set(tableCounts).size).toBe(1);
      }
    }
  });

  it('renders nonempty error scope without fabricating analysis and preserves partial context facts', () => {
    const error = formatMarkdown(reportCases.error);
    expect(error).toContain('## Manifest entries');
    expect(error).toContain('src&#x2f;A&#x2e;sol');
    expect(error).not.toContain('## Scoped aggregate measurements');
    const required = formatMarkdown(reportCases.requiredContextFailure);
    expect(required).toContain('Syntax-complete scoped records: 1');
    expect(required).toContain('file&#x3a;lib&#x2f;Ctx&#x2e;sol');
    expect(required).toContain('measured 100 SLOC');
  });
});

describe('sanitization', () => {
  it('makes terminal control sequences visible while preserving ordinary Unicode', () => {
    expect(sanitizeTerminalText('é😀\n\r\t\u001b[2J\u202e')).toBe('é😀\\n\\r\\t\\u001b[2J\\u202e');
  });

  it('escapes Markdown punctuation and controls as inert text', () => {
    const escaped = sanitizeMarkdownText('[x](https://example.test/a?b=1) | `code`\n');
    expect(escaped).toContain(
      '&#x5b;x&#x5d;&#x28;https&#x3a;&#x2f;&#x2f;example&#x2e;test&#x2f;a&#x3f;b&#x3d;1&#x29;',
    );
    expect(escaped).toContain('&#x7c;');
    expect(escaped).toContain('&#x60;code&#x60;');
    expect(escaped).toContain('&#x5c;n');
    expect(escaped).not.toContain('\n');
    const attack = sanitizeMarkdownText(
      '[x](javascript:alert(1)) <img src=x onerror=alert(1)> &copy; ![pic](https://img.test/a) [ref][id]\r\n[id]: https://evil.test mail@example.test \\path',
    );
    expect(attack).toContain('&#x3c;img');
    expect(attack).toContain('&amp;copy&#x3b;');
    expect(attack).toContain('&#x21;&#x5b;pic&#x5d;');
    expect(attack).toContain('&#x5b;ref&#x5d;&#x5b;id&#x5d;');
    expect(attack).toContain('&#x40;');
    expect(attack).toContain('&#x5c;path');
    expect(attack).not.toContain('<img');
    expect(attack).not.toContain('https://');
    expect(attack).not.toContain('mail@example.test');
    expect(attack).not.toContain('\r\n');
  });

  it('neutralizes attacker text across Markdown paths, names, categories, IDs, and explanations', () => {
    const source = clone(reportCases.combined);
    const diagnostic = source.diagnostics[0];
    const file = source.analysis?.files[0];
    const contract = source.analysis?.contracts[0];
    const estimate = source.estimate;
    expect(diagnostic).toBeDefined();
    expect(file).toBeDefined();
    expect(contract).toBeDefined();
    expect(estimate).not.toBeNull();
    if (
      diagnostic === undefined ||
      file === undefined ||
      contract === undefined ||
      estimate === null
    ) {
      throw new Error('Combined fixture is missing adversarial text targets');
    }
    const hostile = asEnvelope({
      ...source,
      diagnostics: [
        {
          ...diagnostic,
          message:
            '[click](javascript:alert(1)) <img src=x> &copy; ![pic](https://evil.test/a) [ref][id]\r\n[id]: https://evil.test mail@example.test \\path',
          details: [{ key: '[detail]|key', value: '&copy; <img src=x>' }],
        },
      ],
      scope: {
        ...source.scope,
        entries: source.scope.entries.map((entry) =>
          entry.fileId === file.fileId ? { ...entry, path: 'src/[owned]|A.sol' } : entry,
        ),
      },
      analysis: {
        ...source.analysis,
        files: source.analysis?.files.map((item) =>
          item.fileId === file.fileId ? { ...item, fileId: item.fileId } : item,
        ),
        contracts: source.analysis?.contracts.map((item) =>
          item.id === contract.id ? { ...item, name: 'Vault|[evil]' } : item,
        ),
      },
      estimate: {
        ...estimate,
        contributions: estimate.contributions.map((row, index) =>
          index === 0
            ? {
                ...row,
                id: '[row](https://evil.test)',
                category: '[category]|<img src=x>',
                explanation: '[row](https://evil.test)|\r\nnext',
              }
            : row,
        ),
      },
    });
    const output = formatMarkdown(hostile);
    expect(output).toContain('&#x5b;click&#x5d;&#x28;javascript&#x3a;alert&#x28;1&#x29;&#x29;');
    expect(output).toContain('&#x3c;img src&#x3d;x&#x3e;');
    expect(output).toContain('&amp;copy&#x3b;');
    expect(output).toContain('&#x21;&#x5b;pic&#x5d;');
    expect(output).toContain('&#x5b;ref&#x5d;&#x5b;id&#x5d;');
    expect(output).toContain('mail&#x40;example&#x2e;test');
    expect(output).toContain('&#x5c;path');
    expect(output).toContain('&#x5b;category&#x5d;&#x7c;&#x3c;img src&#x3d;x&#x3e;');
    expect(output).toContain('&#x5b;row&#x5d;&#x28;https&#x3a;&#x2f;&#x2f;evil&#x2e;test&#x29;');
    expect(output).toContain(
      '&#x5b;detail&#x5d;&#x7c;key=&amp;copy&#x3b; &#x3c;img src&#x3d;x&#x3e;',
    );
    expect(output).toContain('src&#x2f;&#x5b;owned&#x5d;&#x7c;A&#x2e;sol');
    expect(output).toContain('Vault&#x7c;&#x5b;evil&#x5d;');
    expect(output).toContain('&#x7c;&#x5c;r&#x5c;nnext');
    expect(output).not.toContain('[click](');
    expect(output).not.toContain('|[evil]');
    expect(output).not.toContain('<img');
    expect(output).not.toContain('https://');
    expect(output).not.toContain('mail@example.test');
  });
});
