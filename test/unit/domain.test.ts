import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  callableIdentity,
  canonicalJson,
  contractIdentity,
  edgeIdentity,
  fileIdentity,
  fingerprint,
  normalizeProjectPath,
  sortById,
} from '../../src/domain/canonical.ts';
import {
  MAX_CONFIG_BYTES,
  parseConfigBytes,
  parseConsumerEnvelope,
  parseProducerReport,
} from '../../src/domain/diagnostics.ts';
import {
  CallableAnalysisSchema,
  ConfigInputSchema,
  ContractAnalysisSchema,
  ContractIdSchema,
  EdgeIdSchema,
  EstimateInputSchema,
  EstimateResultSchema,
  FileAnalysisSchema,
  FileIdSchema,
  FileScopeEntrySchema,
  ImportReferenceSchema,
  IndicatorSchema,
  ManualAdjustmentSchema,
  ModelProfileSchema,
  RelationshipResultSchema,
  ReportEnvelopeSchema,
  ScopeManifestSchema,
  SourceRangeSchema,
} from '../../src/domain/schemas.ts';
import type { ContractId, FileId, Measurement, ReportEnvelope } from '../../src/domain/types.ts';
import { acceptsReportVersion } from '../../src/domain/versions.ts';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/domain/${name}.json`, import.meta.url), 'utf8'),
  ) as unknown;
}

function profile(): unknown {
  const zero = { low: 0, high: 0 };
  return {
    profile: 'heuristic-v1',
    modelVersion: '1.0.0',
    parameters: {
      projectHours: zero,
      slocHours: zero,
      controlPremium: zero,
      storagePremium: zero,
      evmPremium: zero,
      interactionHours: zero,
      boundaryHours: zero,
      unknownReserveHigh: 0,
      hoursPerDay: 8,
    },
  };
}

describe('identity and measurement', () => {
  it('uses physical paths and declaration offsets to distinguish same-name declarations', () => {
    expectTypeOf<FileId>().not.toEqualTypeOf<ContractId>();
    const file = fileIdentity('src/π.sol');
    expect(file).toBe('file:src/π.sol');
    expect(contractIdentity('src/A.sol', 'contract', 12)).not.toBe(
      contractIdentity('src/A.sol', 'contract', 13),
    );
    expect(callableIdentity('src/A.sol', 'function', 12)).not.toBe(
      callableIdentity('src/B.sol', 'function', 12),
    );
    expect(edgeIdentity('src/A.sol', 'call', 12, 0)).not.toBe(
      edgeIdentity('src/A.sol', 'call', 12, 1),
    );
    expect(fileIdentity('src/A.sol')).not.toBe(fileIdentity('src/B.sol'));
    expect(normalizeProjectPath('src\\A.sol')).toBe('src/A.sol');
    expect(() => normalizeProjectPath('C:relative.sol')).toThrow(/project-relative/);
    expect(() => normalizeProjectPath('../outside.sol')).toThrow(/traversal/);
    expect(FileIdSchema.safeParse('file:../outside.sol').success).toBe(false);
    expect(FileIdSchema.safeParse('file:src/../outside.sol').success).toBe(false);
    for (const id of [
      'decl:src/..:contract:0',
      'decl:src/.:contract:0',
      'decl:.:contract:0',
      'decl:src//A.sol:contract:0',
      'decl:src/:contract:0',
      'decl:src\\A.sol:contract:0',
    ]) {
      expect(ContractIdSchema.safeParse(id).success).toBe(false);
      expect(EdgeIdSchema.safeParse(`${id}:0`).success).toBe(false);
    }
    expect(ContractIdSchema.safeParse('decl:src/A.sol:contract:0').success).toBe(true);
    expect(EdgeIdSchema.safeParse('decl:src/A.sol:call:0:0').success).toBe(true);
  });

  it('preserves unavailable separately from observed zero and checks original UTF-8 half-open bytes', () => {
    const zero: Measurement<number> = { status: 'measured', value: 0, evidence: [] };
    const unknown: Measurement<number> = { status: 'unavailable', reason: 'Binding was skipped' };
    expect(zero).not.toEqual(unknown);
    const range = {
      startByte: 3,
      endByte: 5,
      start: { line: 1, column: 2 },
      end: { line: 1, column: 3 },
    };
    expect(SourceRangeSchema.safeParse(range).success).toBe(true);
    expect(SourceRangeSchema.safeParse({ ...range, endByte: 2 }).success).toBe(false);
    expect(
      SourceRangeSchema.safeParse({
        ...range,
        start: { line: 2, column: 1 },
        end: { line: 1, column: 1 },
      }).success,
    ).toBe(false);
    const file = fixture('complete') as {
      analysis: { files: unknown[] };
      scope: { entries: unknown[] };
    };
    expect(FileAnalysisSchema.safeParse(file.analysis.files[0]).success).toBe(true);
    expect(
      FileAnalysisSchema.safeParse({
        ...(file.analysis.files[0] as object),
        sourceLines: { status: 'measured', value: -1, evidence: [] },
      }).success,
    ).toBe(false);
    expect(FileScopeEntrySchema.safeParse(file.scope.entries[0]).success).toBe(true);
    expect(
      FileScopeEntrySchema.safeParse({
        ...(file.scope.entries[0] as object),
        physicalIdentity: '/Users/private/A.sol',
      }).success,
    ).toBe(false);
  });

  it('canonicalizes objects by Unicode code point but preserves meaningful array order', () => {
    expect(canonicalJson({ '\u{10000}': 1, '\uE000': 2 })).toBe('{"":2,"𐀀":1}');
    expect(canonicalJson([2, 1])).toBe('[2,1]');
    expect(sortById([{ id: 'b' }, { id: 'a' }]).map((item) => item.id)).toEqual(['a', 'b']);
    expect(fingerprint(['a', 'bc'])).not.toBe(fingerprint(['ab', 'c']));
    expect(() => canonicalJson(new Date())).toThrow(/Non-plain/);
    const sparse: number[] = [];
    sparse.length = 2;
    sparse[1] = 1;
    expect(() => canonicalJson(sparse)).toThrow(/Sparse/);
    expect(() => canonicalJson({ bad: Number.NaN })).toThrow(/Non-finite/);
  });
});

describe('config and model', () => {
  it('accepts a bounded partial override and root settings', () => {
    const input = {
      configVersion: '1.0.0',
      scope: { sourceRoots: ['.'], defaultExcludes: false },
      model: { profile: 'heuristic-v1', parameters: { slocHours: { low: 0.1, high: 0.3 } } },
    };
    expect(ConfigInputSchema.safeParse(input).success).toBe(true);
    expect(parseConfigBytes(Buffer.from(JSON.stringify(input)))).toEqual(input);
    expect(ModelProfileSchema.safeParse(profile()).success).toBe(true);
  });

  it('rejects unknown keys, prototype keys, duplicate IDs, nonfinite and reversed inputs', () => {
    expect(ConfigInputSchema.safeParse({ configVersion: '1.0.0', surprise: true }).success).toBe(
      false,
    );
    expect(
      ConfigInputSchema.safeParse(
        JSON.parse('{"configVersion":"1.0.0","__proto__":{"polluted":true}}') as unknown,
      ).success,
    ).toBe(false);
    expect(() =>
      parseConfigBytes(Buffer.from('{"configVersion":"1.0.0","__proto__":{"polluted":true}}')),
    ).toThrow(/./);
    const adjustment = {
      id: 'one',
      reason: 'Explicit credit',
      category: 'scope',
      lowHours: -2,
      highHours: -1,
    };
    expect(
      ConfigInputSchema.safeParse({ configVersion: '1.0.0', manualAdjustments: [adjustment] })
        .success,
    ).toBe(true);
    expect(
      ConfigInputSchema.safeParse({
        configVersion: '1.0.0',
        manualAdjustments: [adjustment, adjustment],
      }).success,
    ).toBe(false);
    expect(
      ConfigInputSchema.safeParse({
        configVersion: '1.0.0',
        manualAdjustments: [{ ...adjustment, lowHours: 2, highHours: 1 }],
      }).success,
    ).toBe(false);
    expect(
      ConfigInputSchema.safeParse({
        configVersion: '1.0.0',
        model: { profile: 'heuristic-v1', parameters: { slocHours: { low: Number.NaN, high: 1 } } },
      }).success,
    ).toBe(false);
    expect(
      ConfigInputSchema.safeParse({
        configVersion: '1.0.0',
        model: {
          profile: 'heuristic-v1',
          parameters: { slocHours: { low: 0, high: Number.POSITIVE_INFINITY } },
        },
      }).success,
    ).toBe(false);
    expect(
      ConfigInputSchema.safeParse({
        configVersion: '1.0.0',
        model: { profile: 'heuristic-v1', parameters: { slocHours: { low: 0, high: 0.0000001 } } },
      }).success,
    ).toBe(false);
    expect(
      ConfigInputSchema.safeParse({
        configVersion: '1.0.0',
        analysis: { limits: { maxFileBytes: 20 * 1024 * 1024 + 1 } },
      }).success,
    ).toBe(false);
    expect(
      ConfigInputSchema.safeParse({
        configVersion: '1.0.0',
        model: { profile: 'heuristic-v1', parameters: { slocHours: { low: 0, high: 11 } } },
      }).success,
    ).toBe(false);
    expect(
      ConfigInputSchema.safeParse({ configVersion: '1.0.0', model: { profile: 'other' } }).success,
    ).toBe(false);
    expect(
      ConfigInputSchema.safeParse({
        configVersion: '1.0.0',
        scope: { include: ['x'.repeat(5121)] },
      }).success,
    ).toBe(false);
    expect(() => parseConfigBytes(new Uint8Array(MAX_CONFIG_BYTES + 1))).toThrow(/256 KiB/);
  });

  it('keeps generated Draft 2020-12 schemas strict and serializable', () => {
    for (const name of ['config', 'result', 'model']) {
      const schema = JSON.parse(
        readFileSync(new URL(`../../schemas/${name}-v1.schema.json`, import.meta.url), 'utf8'),
      ) as Record<string, unknown>;
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      // The config input is a union of the strict 1.0.0 and 1.1.0 shapes; both stay strict.
      const variants = (name === 'config' ? schema.oneOf : [schema]) as readonly Record<
        string,
        unknown
      >[];
      expect(variants).toHaveLength(name === 'config' ? 2 : 1);
      for (const variant of variants) expect(variant.additionalProperties).toBe(false);
      expect(schema).not.toHaveProperty('unrepresentable');
      const reconstructed = z.fromJSONSchema(schema);
      const valid =
        name === 'config'
          ? { configVersion: '1.1.0' }
          : name === 'model'
            ? profile()
            : fixture('complete');
      expect(reconstructed.safeParse(valid).success).toBe(true);
      const populatedValid =
        name === 'result' ? reconstructed.safeParse(fixture('populated')).success : true;
      expect(populatedValid).toBe(true);
      expect(reconstructed.safeParse({ ...(valid as object), unexpected: true }).success).toBe(
        false,
      );
    }
  });
});

describe('envelopes and compatibility', () => {
  it('validates complete, partial and error fixtures without invented error measurements', () => {
    for (const name of ['complete', 'partial', 'error']) {
      const parsed: ReportEnvelope = parseProducerReport(fixture(name));
      expect(parsed.status).toBe(name);
      expect(
        ReportEnvelopeSchema.safeParse(JSON.parse(JSON.stringify(parsed)) as unknown).success,
      ).toBe(true);
    }
    const error = fixture('error') as Record<string, unknown>;
    expect(ReportEnvelopeSchema.safeParse({ ...error, diagnostics: [] }).success).toBe(false);
    expect(
      ReportEnvelopeSchema.safeParse({
        ...error,
        analysis: (fixture('complete') as Record<string, unknown>).analysis,
      }).success,
    ).toBe(false);
  });

  it('requires complete analysis and coverage labels consistent with report status', () => {
    const complete = fixture('complete') as Record<string, unknown>;
    const partial = fixture('partial') as Record<string, unknown>;
    const completeAnalysis = complete.analysis as Record<string, unknown>;
    const completeness = completeAnalysis.completeness as Record<string, unknown>;
    const estimate = {
      profile: 'heuristic-v1',
      modelVersion: '1.0.0',
      label: 'uncalibrated heuristic',
      coverage: 'analyzed-subset',
      auditorHours: { low: 1, high: 2 },
      auditorDays: { low: 0.1, high: 0.3 },
      contributions: [],
      assumptions: [],
      manualAdjustments: [],
      parameters: ModelProfileSchema.parse(profile()).parameters,
    };
    expect(
      ReportEnvelopeSchema.safeParse({
        ...complete,
        analysis: {
          ...completeAnalysis,
          completeness: { ...completeness, requiredAnalysisComplete: false },
        },
      }).success,
    ).toBe(false);
    expect(ReportEnvelopeSchema.safeParse({ ...partial, estimate }).success).toBe(true);
    expect(
      ReportEnvelopeSchema.safeParse({
        ...partial,
        estimate: { ...estimate, coverage: 'full' },
      }).success,
    ).toBe(false);
    expect(
      ReportEnvelopeSchema.safeParse({
        ...partial,
        fullScopeEstimate: { ...estimate, coverage: 'full' },
      }).success,
    ).toBe(false);
    expect(
      ReportEnvelopeSchema.safeParse({ ...complete, fullScopeEstimate: estimate }).success,
    ).toBe(false);
    expect(
      ReportEnvelopeSchema.safeParse({
        ...complete,
        fullScopeEstimate: { ...estimate, coverage: 'full' },
      }).success,
    ).toBe(true);
  });

  it('refuses unknown majors but accepts additive v1.x fields and diagnostic codes in readers', () => {
    const complete = fixture('complete') as Record<string, unknown>;
    expect(acceptsReportVersion('1.7.2')).toBe(true);
    expect(acceptsReportVersion('2.0.0')).toBe(false);
    expect(
      parseConsumerEnvelope({
        ...complete,
        schemaVersion: '1.1.0',
        futureField: true,
        diagnostics: [{ code: 'NEW_CODE', severity: 'info', message: 'Added in v1.1' }],
      }).schemaVersion,
    ).toBe('1.1.0');
    expect(() => parseConsumerEnvelope({ ...complete, schemaVersion: '2.0.0' })).toThrow(/./);
    expect(ReportEnvelopeSchema.safeParse({ ...complete, futureField: true }).success).toBe(false);
  });

  it('keeps the legacy 1.0.0 report readable but no longer producible', () => {
    const legacy = fixture('legacy-v1.0.0-complete') as Record<string, unknown>;
    expect(parseConsumerEnvelope(legacy).schemaVersion).toBe('1.0.0');
    expect(ReportEnvelopeSchema.safeParse(legacy).success).toBe(false);
  });

  it('requires a narrowed estimation scope to be partial for estimating commands', () => {
    const populated = fixture('populated') as Record<string, unknown> & {
      analysis: Record<string, unknown>;
    };
    const scope = {
      mode: 'contracts',
      reason: 'Only part of the scope.',
      selectedContractIds: [],
      contextContractIds: ['decl:src/A.sol:contract:0'],
      scopeNarrowed: true,
      requestedScopeComplete: true,
      rawSourceLines: { status: 'measured', value: 1, evidence: [] },
      reviewSourceLines: { status: 'measured', value: 0, evidence: [] },
      reusedSourceLines: { status: 'measured', value: 0, evidence: [] },
      outOfScopeSourceLines: { status: 'measured', value: 1, evidence: [] },
    };
    const narrowed = { ...populated, analysis: { ...populated.analysis, estimationScope: scope } };
    // inspect stays complete because raw analysis is complete.
    expect(ReportEnvelopeSchema.safeParse(narrowed).success).toBe(true);
    expect(ReportEnvelopeSchema.safeParse({ ...narrowed, command: 'estimate' }).success).toBe(
      false,
    );
    expect(
      ReportEnvelopeSchema.safeParse({ ...narrowed, command: 'estimate', status: 'partial' })
        .success,
    ).toBe(true);
  });

  it('rejects accidental public source and absolute-path fields and duplicate identities', () => {
    const complete = fixture('complete') as Record<string, unknown>;
    expect(
      ReportEnvelopeSchema.safeParse({ ...complete, sourceText: 'contract C {}' }).success,
    ).toBe(false);
    expect(
      ReportEnvelopeSchema.safeParse({ ...complete, absolutePath: '/Users/example/C.sol' }).success,
    ).toBe(false);
    const scope = complete.scope as { entries: unknown[]; scopedFileIds: string[] };
    expect(
      ReportEnvelopeSchema.safeParse({
        ...complete,
        scope: { ...scope, entries: [...scope.entries, scope.entries[0]] },
      }).success,
    ).toBe(false);
  });

  it('keeps the domain free of filesystem, terminal and parser imports', () => {
    for (const name of ['schemas', 'types', 'diagnostics', 'versions', 'canonical']) {
      const source = readFileSync(new URL(`../../src/domain/${name}.ts`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/from ['"](?:node:fs|node:process|@nomicfoundation\/slang)/);
      expect(source).not.toMatch(/\b(?:readFile|writeFile|process\.stdout|Parser\.create)\s*\(/);
    }
  });
});

describe('populated contracts and estimate invariants', () => {
  it('preserves resolved target requirements in exported status unions', () => {
    const report = ReportEnvelopeSchema.parse(fixture('populated'));
    if (report.analysis === null) throw new Error('Populated fixture has no analysis');
    const relationship = report.analysis.graphs[0];
    if (relationship === undefined) throw new Error('Populated fixture has no relationship');
    const reconstructedRelationship = z.fromJSONSchema(
      z.toJSONSchema(RelationshipResultSchema, {
        target: 'draft-2020-12',
        unrepresentable: 'throw',
      }),
    );
    const unresolvedTarget = {
      id: relationship.id,
      kind: relationship.kind,
      from: relationship.from,
      candidateTargets: [],
      evidence: relationship.evidence,
      resolution: 'resolved-unique',
    };
    expect(reconstructedRelationship.safeParse(relationship).success).toBe(true);
    expect(reconstructedRelationship.safeParse(unresolvedTarget).success).toBe(false);
    const reconstructedImport = z.fromJSONSchema(
      z.toJSONSchema(ImportReferenceSchema, {
        target: 'draft-2020-12',
        unrepresentable: 'throw',
      }),
    );
    const importReference = {
      id: 'decl:src/A.sol:import:22:0',
      importerFileId: 'file:src/A.sol',
      specifier: './B.sol',
      range: report.analysis.callables[0]?.range,
      targetFileId: null,
      status: 'resolved',
      candidateFileIds: [],
    };
    expect(reconstructedImport.safeParse(importReference).success).toBe(false);
    expect(
      reconstructedImport.safeParse({ ...importReference, targetFileId: 'file:src/B.sol' }).success,
    ).toBe(true);
  });

  it('validates populated contract, callable, relationship and indicator records', () => {
    const report = ReportEnvelopeSchema.parse(fixture('populated'));
    if (report.analysis === null) throw new Error('Populated fixture has no analysis');
    expect(ContractAnalysisSchema.safeParse(report.analysis.contracts[0]).success).toBe(true);
    expect(CallableAnalysisSchema.safeParse(report.analysis.callables[0]).success).toBe(true);
    expect(RelationshipResultSchema.safeParse(report.analysis.graphs[0]).success).toBe(true);
    expect(IndicatorSchema.safeParse(report.analysis.indicators[0]).success).toBe(true);
    const relationship = report.analysis.graphs[0];
    if (relationship === undefined) throw new Error('Populated fixture has no relationship');
    expect(RelationshipResultSchema.safeParse({ ...relationship, to: undefined }).success).toBe(
      false,
    );
    expect(
      RelationshipResultSchema.safeParse({ ...relationship, resolution: 'unresolved' }).success,
    ).toBe(false);
    expect(
      RelationshipResultSchema.safeParse({
        ...relationship,
        resolution: 'ambiguous',
        to: undefined,
        candidateTargets: [],
      }).success,
    ).toBe(false);
    expect(
      RelationshipResultSchema.safeParse({
        ...relationship,
        resolution: 'ambiguous',
        to: undefined,
        candidateTargets: ['file:src/B.sol'],
      }).success,
    ).toBe(false);
    const relationshipWithoutTarget = {
      id: relationship.id,
      kind: relationship.kind,
      from: relationship.from,
      candidateTargets: ['file:src/B.sol'],
      evidence: relationship.evidence,
    };
    expect(
      RelationshipResultSchema.safeParse({ ...relationshipWithoutTarget, resolution: 'ambiguous' })
        .success,
    ).toBe(true);
    expect(
      RelationshipResultSchema.safeParse({ ...relationshipWithoutTarget, resolution: 'unresolved' })
        .success,
    ).toBe(true);
    expect(
      RelationshipResultSchema.safeParse({
        ...relationshipWithoutTarget,
        resolution: 'unsupported',
      }).success,
    ).toBe(true);
    const importReference = {
      id: 'decl:src/A.sol:import:22:0',
      importerFileId: 'file:src/A.sol',
      specifier: './B.sol',
      range: report.analysis.callables[0]?.range,
      targetFileId: null,
      status: 'unresolved',
      candidateFileIds: [],
    };
    expect(ImportReferenceSchema.safeParse(importReference).success).toBe(true);
    expect(
      ImportReferenceSchema.safeParse({ ...importReference, status: 'resolved' }).success,
    ).toBe(false);
    expect(
      ImportReferenceSchema.safeParse({
        ...importReference,
        status: 'resolved',
        targetFileId: 'file:src/B.sol',
      }).success,
    ).toBe(true);
    expect(
      ImportReferenceSchema.safeParse({
        ...importReference,
        status: 'unresolved',
        targetFileId: 'file:src/B.sol',
      }).success,
    ).toBe(false);
    expect(
      ImportReferenceSchema.safeParse({ ...importReference, status: 'ambiguous' }).success,
    ).toBe(false);
    expect(
      ImportReferenceSchema.safeParse({
        ...importReference,
        status: 'ambiguous',
        candidateFileIds: ['file:src/B.sol'],
      }).success,
    ).toBe(true);
    expect(
      ManualAdjustmentSchema.safeParse({
        id: 'a',
        reason: '  \t',
        category: 'scope',
        lowHours: 0,
        highHours: 1,
      }).success,
    ).toBe(false);
  });

  it('requires disjoint scope roles and unique eligible files and endpoint pairs', () => {
    const report = ReportEnvelopeSchema.parse(fixture('populated'));
    if (report.analysis === null) throw new Error('Populated fixture has no analysis');
    const file = report.analysis.files[0];
    if (file === undefined) throw new Error('Populated fixture has no file');
    const eligible = {
      fileId: file.fileId,
      sourceLines: file.sourceLines,
      stateVariables: file.stateVariables,
      decisions: file.decisions,
      assemblyBlocks: file.assemblyBlocks,
      confirmedBuiltinLowLevelCalls: { status: 'measured', value: 0, evidence: [] },
    };
    const input = {
      eligibleFiles: [eligible],
      scopedPairs: [{ leftId: 'owner-a', rightId: 'owner-b' }],
      contextPairs: [],
      requiredAnalysisComplete: true,
      hasUnknownSemantics: false,
      allowPartial: false,
      model: ModelProfileSchema.parse(profile()),
      manualAdjustments: [],
    };
    expect(EstimateInputSchema.safeParse(input).success).toBe(true);
    expect(
      EstimateInputSchema.safeParse({ ...input, eligibleFiles: [eligible, eligible] }).success,
    ).toBe(false);
    expect(
      EstimateInputSchema.safeParse({
        ...input,
        contextPairs: [{ leftId: 'owner-b', rightId: 'owner-a' }],
      }).success,
    ).toBe(true);
    expect(
      EstimateInputSchema.safeParse({
        ...input,
        contextPairs: [{ leftId: 'owner-a', rightId: 'owner-b' }],
      }).success,
    ).toBe(false);
    expect(
      EstimateInputSchema.safeParse({
        ...input,
        scopedPairs: [{ leftId: 'owner-a', rightId: 'owner-a' }],
      }).success,
    ).toBe(false);
    expect(
      ScopeManifestSchema.safeParse({ ...report.scope, contextFileIds: report.scope.scopedFileIds })
        .success,
    ).toBe(false);
  });

  it('allows signed manual ledger entries and rejects negative or reversed totals', () => {
    const adjustment = {
      id: 'credit',
      reason: 'Explicit scope credit',
      category: 'scope',
      lowHours: -1,
      highHours: -1,
    };
    const result = {
      profile: 'heuristic-v1',
      modelVersion: '1.0.0',
      label: 'uncalibrated heuristic',
      coverage: 'full',
      auditorHours: { low: 1, high: 2 },
      auditorDays: { low: 0.1, high: 0.3 },
      contributions: [
        {
          id: 'base',
          category: 'baseline',
          lowMicrohours: 2_000_000,
          highMicrohours: 3_000_000,
          inputStatus: 'measured',
          explanation: 'Synthetic contract validation',
        },
        {
          id: 'credit',
          category: 'manual',
          lowMicrohours: -1_000_000,
          highMicrohours: -1_000_000,
          inputStatus: 'manual',
          explanation: 'Explicit credit',
        },
      ],
      assumptions: ['Synthetic validation only'],
      manualAdjustments: [adjustment],
      parameters: ModelProfileSchema.parse(profile()).parameters,
    };
    expect(EstimateResultSchema.safeParse(result).success).toBe(true);
    expect(
      EstimateResultSchema.safeParse({ ...result, auditorHours: { low: -1, high: 2 } }).success,
    ).toBe(false);
    expect(
      EstimateResultSchema.safeParse({ ...result, auditorDays: { low: 2, high: 1 } }).success,
    ).toBe(false);
    expect(
      EstimateResultSchema.safeParse({
        ...result,
        contributions: [{ ...result.contributions[0], lowMicrohours: 3, highMicrohours: 1 }],
      }).success,
    ).toBe(false);
    expect(
      EstimateResultSchema.safeParse({
        ...result,
        contributions: [result.contributions[0], result.contributions[0]],
      }).success,
    ).toBe(false);
  });
});
