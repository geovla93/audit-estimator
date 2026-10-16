import { z } from 'zod';
import type * as DTO from './types.ts';

import {
  CONFIG_SCHEMA_VERSION,
  LEGACY_CONFIG_SCHEMA_VERSION,
  LEGACY_MODEL_VERSION,
  MODEL_PROFILE,
  MODEL_VERSION,
  REPORT_SCHEMA_VERSION,
} from './versions.ts';

const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveCount = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const boundedCount = (maximum: number) => z.int().min(1).max(maximum);
const smallText = z.string().min(1).max(512);
const label = z.string().min(1).max(128);
const path = z
  .string()
  .min(1)
  .max(4096)
  .regex(
    new RegExp(
      String.raw`^(?!/|[A-Za-z]:)(?!.*(?:^|/)\.{1,2}(?:/|$))(?!.*//)(?!.*\/$)[^\\\u0000]+$`,
    ),
  );
const rootPath = z.union([path, z.literal('.')]);
const identifier: z.ZodString = z.string().min(1).max(512);
const fileIdText: z.ZodString = z
  .string()
  .min(6)
  .max(4101)
  .regex(
    new RegExp(
      String.raw`^file:(?!/|[A-Za-z]:|\.{1,2}(?:/|$))(?!.*(?:^|/)\.{1,2}(?:/|$))(?!.*//)(?!.*\/$)[^\\\u0000]+$`,
    ),
  );
const declarationIdText: z.ZodString = z
  .string()
  .min(9)
  .max(4200)
  .regex(
    new RegExp(
      String.raw`^decl:(?!/|[A-Za-z]:|\.{1,2}(?:/|:))(?!.*\/\.{1,2}(?:/|:))(?!.*//)(?!.*\/:)[^\\\u0000]+:[a-z][a-z-]*:[0-9]+(?::[0-9]+)?$`,
    ),
  );
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const decimals = (maximum: number) => z.number().finite().min(0).max(maximum).multipleOf(0.000001);
const signedHours = z.number().finite().min(-100000).max(100000).multipleOf(0.000001);

const FileIdSchema: ReturnType<typeof fileIdText.brand<'FileId'>> = fileIdText.brand<'FileId'>();
const ContractIdSchema: ReturnType<typeof declarationIdText.brand<'ContractId'>> =
  declarationIdText.brand<'ContractId'>();
const CallableIdSchema: ReturnType<typeof declarationIdText.brand<'CallableId'>> =
  declarationIdText.brand<'CallableId'>();
const EdgeIdSchema: ReturnType<typeof declarationIdText.brand<'EdgeId'>> =
  declarationIdText.brand<'EdgeId'>();
const OwnershipSchema: z.ZodType<DTO.Ownership> = z.enum(['first-party', 'third-party', 'unknown']);
const ScopeRoleSchema: z.ZodType<DTO.ScopeRole> = z.enum(['scoped', 'context', 'excluded']);
const DeclarationKindSchema: z.ZodType<DTO.DeclarationKind> = z.enum([
  'contract',
  'abstract-contract',
  'library',
  'interface',
]);
const CallableKindSchema: z.ZodType<DTO.CallableKind> = z.enum([
  'function',
  'constructor',
  'fallback',
  'receive',
  'modifier',
  'free-function',
]);
const MeasurementSourceSchema: z.ZodType<DTO.MeasurementSource> = z.enum([
  'default',
  'metadata',
  'config',
  'cli',
]);

const PositionSchema: z.ZodType<DTO.Position> = z.strictObject({
  line: positiveCount,
  column: positiveCount,
});
const SourceRangeSchema: z.ZodType<DTO.SourceRange> = z
  .strictObject({
    startByte: count.describe('Inclusive UTF-8 byte offset in original source'),
    endByte: count.describe('Exclusive UTF-8 byte offset in original source'),
    start: PositionSchema.describe('One-based line and Unicode scalar column'),
    end: PositionSchema.describe('One-based line and Unicode scalar column'),
  })
  .refine((range) => range.endByte >= range.startByte, 'Half-open range must be ordered')
  .refine(
    (range) =>
      range.end.line > range.start.line ||
      (range.end.line === range.start.line && range.end.column >= range.start.column),
    'Presentation coordinates must be ordered',
  );
const EvidenceRefSchema: z.ZodType<DTO.EvidenceRef> = z.strictObject({
  fileId: FileIdSchema,
  range: SourceRangeSchema,
});

function measurementSchema<T>(value: z.ZodType<T>): z.ZodType<DTO.Measurement<T>> {
  return z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('measured'),
      value,
      evidence: z.array(EvidenceRefSchema).max(10000),
    }),
    z.strictObject({ status: z.literal('unavailable'), reason: smallText }),
  ]);
}

const measuredCount = measurementSchema(count);
const measuredBoolean = measurementSchema(z.boolean());
const measuredText = measurementSchema(label);
const measuredIds = measurementSchema(z.array(identifier).max(100000));
const StateVariablesSchema: z.ZodType<DTO.StateVariables> = z.strictObject({
  count: measuredCount,
  mutableCount: measuredCount,
  complexMutableDeclarationIds: measuredIds,
  typeShapes: measurementSchema(
    z
      .array(
        z.strictObject({
          declarationId: identifier,
          shape: z.enum(['elementary', 'mapping', 'array', 'struct', 'user-defined', 'unknown']),
          mutable: z.boolean(),
        }),
      )
      .max(100000),
  ),
});

const FileScopeEntrySchema: z.ZodType<DTO.FileScopeEntry> = z.strictObject({
  fileId: FileIdSchema,
  path,
  role: ScopeRoleSchema,
  ownership: OwnershipSchema,
  ownershipEvidence: z.array(EvidenceRefSchema).max(1000),
  physicalIdentity: path.describe('Root-confined canonical physical identity for deduplication'),
  byteHash: digest.describe('SHA-256 of original source bytes; never a file deduplication key'),
});
const ScopeManifestSchema: z.ZodType<DTO.ScopeManifest> = z
  .strictObject({
    entries: z.array(FileScopeEntrySchema).max(100000),
    scopedFileIds: z.array(FileIdSchema).max(100000),
    contextFileIds: z.array(FileIdSchema).max(100000),
    excludedFileIds: z.array(FileIdSchema).max(100000),
  })
  .superRefine((scope, context) => {
    for (const [field, ids] of [
      ['entries', scope.entries.map((entry) => entry.fileId)],
      ['scopedFileIds', scope.scopedFileIds],
      ['contextFileIds', scope.contextFileIds],
      ['excludedFileIds', scope.excludedFileIds],
    ] as const) {
      if (new Set(ids).size !== ids.length)
        context.addIssue({ code: 'custom', path: [field], message: 'Duplicate file ID' });
    }
    const physical = scope.entries.map((entry) => entry.physicalIdentity);
    if (new Set(physical).size !== physical.length)
      context.addIssue({
        code: 'custom',
        path: ['entries'],
        message: 'Duplicate physical identity',
      });
    const assigned = new Map<string, DTO.ScopeRole>();
    for (const [role, ids] of [
      ['scoped', scope.scopedFileIds],
      ['context', scope.contextFileIds],
      ['excluded', scope.excludedFileIds],
    ] as const) {
      for (const id of ids) {
        if (assigned.has(id))
          context.addIssue({ code: 'custom', message: 'File has multiple scope roles' });
        assigned.set(id, role);
      }
    }
    for (const entry of scope.entries) {
      if (assigned.get(entry.fileId) !== entry.role) {
        context.addIssue({ code: 'custom', message: 'Scope role list disagrees with entry' });
      }
    }
    if (assigned.size !== scope.entries.length) {
      context.addIssue({ code: 'custom', message: 'Scope role lists must match entries' });
    }
  });

const importReferenceBase = {
  id: EdgeIdSchema,
  importerFileId: FileIdSchema,
  specifier: smallText,
  range: SourceRangeSchema,
  candidateFileIds: z.array(FileIdSchema).max(10000),
};
const ImportReferenceSchema: z.ZodType<DTO.ImportReference> = z.discriminatedUnion('status', [
  z.strictObject({
    ...importReferenceBase,
    status: z.literal('resolved'),
    targetFileId: FileIdSchema,
  }),
  z.strictObject({
    ...importReferenceBase,
    status: z.literal('unresolved'),
    targetFileId: z.null(),
  }),
  z.strictObject({
    ...importReferenceBase,
    status: z.literal('ambiguous'),
    targetFileId: z.null(),
    candidateFileIds: z.array(FileIdSchema).min(1).max(10000),
  }),
]);
const relationshipBase = {
  id: EdgeIdSchema,
  kind: z.enum(['inheritance', 'call', 'import']),
  from: identifier,
  candidateTargets: z.array(identifier).max(10000),
  evidence: z.array(EvidenceRefSchema).max(10000),
};
const RelationshipResultSchema: z.ZodType<DTO.RelationshipResult> = z.discriminatedUnion(
  'resolution',
  [
    z.strictObject({
      ...relationshipBase,
      resolution: z.literal('resolved-unique'),
      to: identifier,
    }),
    z.strictObject({
      ...relationshipBase,
      resolution: z.literal('ambiguous'),
      candidateTargets: z.array(identifier).min(1).max(10000),
    }),
    z.strictObject({ ...relationshipBase, resolution: z.literal('unresolved') }),
    z.strictObject({ ...relationshipBase, resolution: z.literal('unsupported') }),
  ],
);

const CallableAnalysisSchema: z.ZodType<DTO.CallableAnalysis> = z.strictObject({
  id: CallableIdSchema,
  fileId: FileIdSchema,
  contractId: ContractIdSchema.nullable(),
  kind: CallableKindSchema,
  name: label.nullable(),
  range: SourceRangeSchema,
  visibilityExplicit: measuredText,
  visibilityEffective: measuredText,
  mutabilityExplicit: measuredText,
  mutabilityEffective: measuredText,
  hasBody: measuredBoolean,
  decisions: measuredCount,
  loops: measuredCount,
  maxLoopDepth: measuredCount,
  assemblyBlocks: measuredCount,
  yulStatements: measuredCount,
  yulCalls: measuredCount,
  yulControlFlow: measuredCount,
  lowLevelCallCandidates: measuredCount,
  modifiersApplied: measuredIds,
});
const ContractAnalysisSchema: z.ZodType<DTO.ContractAnalysis> = z.strictObject({
  id: ContractIdSchema,
  fileId: FileIdSchema,
  kind: DeclarationKindSchema,
  name: label,
  range: SourceRangeSchema,
  sourceLines: measuredCount,
  callableIds: z.array(CallableIdSchema).max(100000),
  stateVariables: StateVariablesSchema,
});
const FileAnalysisSchema: z.ZodType<DTO.FileAnalysis> = z.strictObject({
  fileId: FileIdSchema,
  role: ScopeRoleSchema,
  ownership: OwnershipSchema,
  physicalLines: measuredCount,
  sourceLines: measuredCount,
  declarationCounts: z.strictObject({
    contracts: measuredCount,
    abstractContracts: measuredCount,
    libraries: measuredCount,
    interfaces: measuredCount,
  }),
  stateVariables: StateVariablesSchema,
  decisions: measuredCount,
  loops: measuredCount,
  maxLoopDepth: measuredCount,
  assemblyBlocks: measuredCount,
  yulStatements: measuredCount,
  yulCalls: measuredCount,
  yulControlFlow: measuredCount,
  lowLevelCallCandidates: measuredCount,
  importIds: z.array(EdgeIdSchema).max(100000),
  contractIds: z.array(ContractIdSchema).max(100000),
  callableIds: z.array(CallableIdSchema).max(100000),
  syntaxComplete: z.boolean(),
});
const SyntaxBatchSchema: z.ZodType<DTO.SyntaxBatch> = z.strictObject({
  files: z.array(FileAnalysisSchema).max(100000),
  contracts: z.array(ContractAnalysisSchema).max(100000),
  callables: z.array(CallableAnalysisSchema).max(100000),
  imports: z.array(ImportReferenceSchema).max(100000),
});

const DiagnosticCodeSchema: z.ZodType<DTO.DiagnosticCode> = z.enum([
  'CONFIG_INVALID',
  'TARGET_UNREADABLE',
  'EMPTY_SCOPE',
  'PATH_BLOCKED',
  'LIMIT_EXCEEDED',
  'SOURCE_CHANGED',
  'LANGUAGE_UNSUPPORTED',
  'PARSE_INVALID',
  'IMPORT_UNRESOLVED',
  'SEMANTICS_UNAVAILABLE',
  'OWNERSHIP_UNKNOWN',
  'PARTIAL_ANALYSIS',
  'OUTPUT_FAILED',
  'INTERNAL_ERROR',
]);
const DiagnosticSchema: z.ZodType<DTO.Diagnostic> = z.strictObject({
  code: DiagnosticCodeSchema,
  severity: z.enum(['info', 'warning', 'error']),
  phase: z.enum(['config', 'discovery', 'parse', 'semantics', 'metrics', 'estimate', 'report']),
  message: smallText,
  fileId: FileIdSchema.optional(),
  range: SourceRangeSchema.optional(),
  details: z
    .array(
      z.strictObject({
        key: label,
        value: z.union([smallText, z.number().finite(), z.boolean(), z.null()]),
      }),
    )
    .max(32)
    .optional(),
});

const IndicatorSchema: z.ZodType<DTO.Indicator> = z.strictObject({
  id: identifier,
  ruleVersion: label,
  category: z.enum(['control', 'storage', 'evm', 'interaction', 'boundary', 'uncertainty']),
  evidenceKind: z.enum(['measured', 'heuristic', 'human']),
  confidence: z.enum(['high', 'medium', 'low', 'not-assessed']),
  summary: smallText,
  evidence: z.array(EvidenceRefSchema).max(10000),
  limitations: z.array(smallText).max(1000),
  requiresAssessment: z.boolean(),
});

const pattern = z.string().min(1).max(5120);
const analysisLimitsShape = {
  maxFileBytes: boundedCount(20 * 1024 * 1024),
  maxTotalSourceBytes: boundedCount(640 * 1024 * 1024),
  maxFiles: boundedCount(20_000),
  maxFsEntries: boundedCount(1_000_000),
  maxDirectoryDepth: boundedCount(640),
  maxImports: boundedCount(200_000),
  maxGraphEdges: boundedCount(1_000_000),
  maxAstNodesPerFile: boundedCount(2_000_000),
  maxAstNodesTotal: boundedCount(20_000_000),
  maxPatternsPerList: boundedCount(640),
  maxPatternLength: boundedCount(5120),
  maxGlobStates: boundedCount(100_000_000),
  maxMetadataBytes: boundedCount(2560 * 1024),
  maxLcovBytes: boundedCount(40 * 1024 * 1024),
  parseTimeoutMs: boundedCount(20_000),
  maxSemanticFiles: boundedCount(1280),
  maxSemanticBytes: boundedCount(80 * 1024 * 1024),
  semanticTimeoutMs: boundedCount(100_000),
  analysisTimeoutMs: boundedCount(600_000),
};
const AnalysisLimitsSchema: z.ZodType<DTO.AnalysisLimits> = z.strictObject(analysisLimitsShape);
const scopeSettingsShape = {
  sourceRoots: z.array(rootPath).max(1000),
  include: z.array(pattern).max(1000),
  exclude: z.array(pattern).max(1000),
  defaultExcludes: z.boolean(),
  thirdPartyRoots: z.array(rootPath).max(1000),
  firstPartyOverrides: z.array(rootPath).max(1000),
  followSymlinks: z.boolean(),
};
const scopeSettings: z.ZodType<DTO.ScopeSettings> = z.strictObject(scopeSettingsShape);
const remapping: z.ZodType<DTO.Remapping> = z.strictObject({
  context: rootPath.optional(),
  prefix: label,
  target: rootPath,
});
const ManualAdjustmentSchema: z.ZodType<DTO.ManualAdjustment> = z
  .strictObject({
    id: identifier,
    reason: smallText.regex(/\S/),
    category: label,
    lowHours: signedHours,
    highHours: signedHours,
  })
  .refine((item) => item.lowHours <= item.highHours, 'Manual range must be ordered');

const ParameterRangeSchema: z.ZodType<DTO.ParameterRange> = z
  .strictObject({ low: z.number().finite(), high: z.number().finite() })
  .refine((range) => range.low <= range.high, 'Range must be ordered');
function boundedRange(maximum: number): z.ZodType<DTO.ParameterRange> {
  return z
    .strictObject({ low: decimals(maximum), high: decimals(maximum) })
    .refine((range) => range.low <= range.high, 'Range must be ordered');
}
const ModelParametersSchema: z.ZodType<DTO.ModelParameters> = z.strictObject({
  projectHours: boundedRange(10000),
  slocHours: boundedRange(10),
  controlPremium: boundedRange(2),
  storagePremium: boundedRange(2),
  evmPremium: boundedRange(2),
  interactionHours: boundedRange(10000),
  boundaryHours: boundedRange(10000),
  unknownReserveHigh: decimals(2),
  hoursPerDay: z.number().finite().gt(0).max(24).multipleOf(0.000001),
});
const ModelVersionSchema: z.ZodType<DTO.ModelVersion> = z.enum([
  LEGACY_MODEL_VERSION,
  MODEL_VERSION,
]);
const ModelProfileSchema: z.ZodType<DTO.ModelProfile> = z.strictObject({
  profile: z.literal(MODEL_PROFILE),
  modelVersion: ModelVersionSchema,
  parameters: ModelParametersSchema,
});
const modelParametersInput = z
  .strictObject({
    projectHours: boundedRange(10000).optional(),
    slocHours: boundedRange(10).optional(),
    controlPremium: boundedRange(2).optional(),
    storagePremium: boundedRange(2).optional(),
    evmPremium: boundedRange(2).optional(),
    interactionHours: boundedRange(10000).optional(),
    boundaryHours: boundedRange(10000).optional(),
    unknownReserveHigh: decimals(2).optional(),
    hoursPerDay: z.number().finite().gt(0).max(24).multipleOf(0.000001).optional(),
  })
  .optional();
const legacyModelInput: z.ZodType<NonNullable<DTO.ConfigInput['model']>> = z.strictObject({
  profile: z.literal(MODEL_PROFILE),
  modelVersion: z.literal(LEGACY_MODEL_VERSION).optional(),
  parameters: modelParametersInput,
});
const modelInput: z.ZodType<NonNullable<DTO.ConfigInput['model']>> = z.strictObject({
  profile: z.literal(MODEL_PROFILE),
  modelVersion: ModelVersionSchema.optional(),
  parameters: modelParametersInput,
});

const selectorPath = z
  .string()
  .min(1)
  .max(512)
  .regex(
    new RegExp(
      String.raw`^(?!/|[A-Za-z]:)(?!.*(?:^|/)\.{1,2}(?:/|$))(?!.*//)(?!.*\/$)[^\\\u0000-\u001f\u007f]+$`,
    ),
  );
const EstimationScopeSelectorSchema: z.ZodType<DTO.EstimationScopeSelector> = z.strictObject({
  path: selectorPath,
  kind: DeclarationKindSchema,
  name: label,
  sourceHash: digest.optional(),
});
const MAX_SELECTORS = 10_000;
const estimationScopeShape = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('all') }),
  z.strictObject({
    mode: z.literal('contracts'),
    contracts: z.array(EstimationScopeSelectorSchema).min(1).max(MAX_SELECTORS),
    reason: smallText.regex(/\S/),
  }),
]);
const EstimationScopeInputSchema: z.ZodType<DTO.EstimationScopeInput> =
  estimationScopeShape.superRefine((scope, context) => {
    if (scope.mode !== 'contracts') return;
    const seen = new Set<string>();
    for (const [index, item] of scope.contracts.entries()) {
      const key = JSON.stringify([item.path, item.kind, item.name]);
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['contracts', index],
          message: 'Duplicate selector',
        });
      }
      seen.add(key);
    }
  });

const configInputShape = {
  scope: z.strictObject(scopeSettingsShape).partial().optional(),
  imports: z.strictObject({ remappings: z.array(remapping).max(1000) }).optional(),
  solidity: z.strictObject({ version: label }).optional(),
  analysis: z.strictObject({ limits: z.strictObject(analysisLimitsShape).partial() }).optional(),
  manualAdjustments: z.array(ManualAdjustmentSchema).max(1000).optional(),
  coverage: z.strictObject({ lcovPath: path }).optional(),
  report: z.strictObject({ format: z.enum(['json', 'markdown', 'terminal']) }).optional(),
};
function uniqueManualIds(
  config: { readonly manualAdjustments?: readonly DTO.ManualAdjustment[] | undefined },
  context: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  for (const [index, item] of (config.manualAdjustments ?? []).entries()) {
    if (ids.has(item.id))
      context.addIssue({
        code: 'custom',
        path: ['manualAdjustments', index, 'id'],
        message: 'Duplicate ID',
      });
    ids.add(item.id);
  }
}
/** Strict legacy 1.0.0 input: no estimation scope and only the frozen model version. */
const legacyConfigInputBody = z
  .strictObject({
    configVersion: z.literal(LEGACY_CONFIG_SCHEMA_VERSION),
    ...configInputShape,
    model: legacyModelInput.optional(),
  })
  .superRefine(uniqueManualIds);
const configInputBody = z
  .strictObject({
    configVersion: z.literal(CONFIG_SCHEMA_VERSION),
    ...configInputShape,
    model: modelInput.optional(),
    estimationScope: EstimationScopeInputSchema.optional(),
  })
  .superRefine((config, context) => {
    uniqueManualIds(config, context);
    if (config.estimationScope?.mode === 'contracts' && config.model?.modelVersion === '1.0.0') {
      context.addIssue({
        code: 'custom',
        path: ['estimationScope'],
        message: 'Explicit contract scope is not available under model 1.0.0',
      });
    }
  });
const ConfigInputSchema: z.ZodType<DTO.ConfigInput> = z
  .unknown()
  .superRefine((input, context) => {
    const pending: unknown[] = [input];
    while (pending.length > 0) {
      const value = pending.pop();
      if (value === null || typeof value !== 'object') continue;
      for (const key of Object.keys(value)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          context.addIssue({ code: 'custom', message: 'Forbidden object key' });
        }
        pending.push((value as Record<string, unknown>)[key]);
      }
    }
  })
  .pipe(z.discriminatedUnion('configVersion', [legacyConfigInputBody, configInputBody]));
const ResolvedConfigSchema: z.ZodType<DTO.ResolvedConfig> = z
  .strictObject({
    configVersion: z.literal(CONFIG_SCHEMA_VERSION),
    scope: scopeSettings,
    imports: z.strictObject({ remappings: z.array(remapping).max(1000) }),
    solidity: z.strictObject({ version: label }),
    analysis: z.strictObject({ limits: AnalysisLimitsSchema }),
    model: ModelProfileSchema,
    manualAdjustments: z.array(ManualAdjustmentSchema).max(1000),
    coverage: z.strictObject({ lcovPath: path.nullable() }),
    report: z.strictObject({ format: z.enum(['json', 'markdown', 'terminal']) }),
    estimationScope: EstimationScopeInputSchema,
    provenance: z
      .array(z.strictObject({ field: label, source: MeasurementSourceSchema }))
      .max(1000),
  })
  .superRefine((config, context) => {
    if (config.estimationScope.mode === 'contracts' && config.model.modelVersion === '1.0.0') {
      context.addIssue({
        code: 'custom',
        path: ['estimationScope'],
        message: 'Explicit contract scope is not available under model 1.0.0',
      });
    }
  });

const ReviewSummarySchema: z.ZodType<DTO.ReviewSummary> = z.strictObject({
  mode: z.enum(['all', 'contracts']),
  analyzedSourceLines: count,
  reusedSourceLines: count,
  outOfScopeSourceLines: count,
  scopeNarrowed: z.boolean(),
});

/** Mode, narrowing and line-conservation truth table for a supplied review summary. */
function validateReviewSummary(
  input: {
    readonly eligibleFiles: readonly { readonly sourceLines: DTO.Measurement<number> }[];
    readonly model: DTO.ModelProfile;
    readonly reviewSummary?: DTO.ReviewSummary | undefined;
  },
  context: z.RefinementCtx,
): void {
  const summary = input.reviewSummary;
  if (summary === undefined) return;
  const reject = (message: string): void => {
    context.addIssue({ code: 'custom', path: ['reviewSummary'], message });
  };
  if (input.model.modelVersion !== MODEL_VERSION) {
    reject('A review summary requires model 1.1.0');
    return;
  }
  let review = 0;
  for (const file of input.eligibleFiles) {
    if (file.sourceLines.status !== 'measured') {
      reject('A review summary requires measured review lines for every eligible file');
      return;
    }
    review += file.sourceLines.value;
    if (!Number.isSafeInteger(review)) {
      reject('Review lines exceed the safe integer range');
      return;
    }
  }
  const total = review + summary.reusedSourceLines + summary.outOfScopeSourceLines;
  if (!Number.isSafeInteger(total) || total !== summary.analyzedSourceLines) {
    reject('Analyzed lines must equal review plus reused plus caller-excluded lines');
    return;
  }
  if (summary.mode === 'all') {
    if (summary.outOfScopeSourceLines !== 0 || summary.scopeNarrowed) {
      reject('Whole-scope mode cannot contain caller exclusions');
    }
    return;
  }
  if (summary.reusedSourceLines !== 0) {
    reject('Contract-scope mode cannot contain content reuse');
  }
  if (!summary.scopeNarrowed && summary.outOfScopeSourceLines !== 0) {
    reject('Caller-excluded lines require a narrowed scope');
  }
  if (review === 0) reject('Contract-scope mode requires positive review lines');
}

const EstimateInputSchema: z.ZodType<DTO.EstimateInput> = z
  .strictObject({
    eligibleFiles: z
      .array(
        z.strictObject({
          fileId: FileIdSchema,
          sourceLines: measuredCount,
          stateVariables: StateVariablesSchema,
          decisions: measuredCount,
          assemblyBlocks: measuredCount,
          confirmedBuiltinLowLevelCalls: measuredCount,
        }),
      )
      .max(100000),
    scopedPairs: z.array(z.strictObject({ leftId: identifier, rightId: identifier })).max(100000),
    contextPairs: z.array(z.strictObject({ leftId: identifier, rightId: identifier })).max(100000),
    requiredAnalysisComplete: z.boolean(),
    hasUnknownSemantics: z.boolean(),
    allowPartial: z.boolean(),
    model: ModelProfileSchema,
    manualAdjustments: z.array(ManualAdjustmentSchema).max(1000),
    reviewSummary: ReviewSummarySchema.optional(),
  })
  .superRefine((input, context) => {
    validateReviewSummary(input, context);
    const fileIds = input.eligibleFiles.map((file) => file.fileId);
    if (new Set(fileIds).size !== fileIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['eligibleFiles'],
        message: 'Duplicate eligible file ID',
      });
    }
    const pairs = new Set<string>();
    for (const [field, values] of [
      ['scopedPairs', input.scopedPairs],
      ['contextPairs', input.contextPairs],
    ] as const) {
      for (const [index, pair] of values.entries()) {
        if (pair.leftId === pair.rightId) {
          context.addIssue({ code: 'custom', path: [field, index], message: 'Self pair' });
        }
        const key = JSON.stringify([pair.leftId, pair.rightId]);
        if (pairs.has(key)) {
          context.addIssue({
            code: 'custom',
            path: [field, index],
            message: 'Duplicate endpoint pair',
          });
        }
        pairs.add(key);
      }
    }
    const manualIds = input.manualAdjustments.map((item) => item.id);
    if (new Set(manualIds).size !== manualIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['manualAdjustments'],
        message: 'Duplicate adjustment ID',
      });
    }
  });

const nonnegativeRange: z.ZodType<DTO.ParameterRange> = z
  .strictObject({
    low: z.number().finite().min(0).max(1_000_000_000),
    high: z.number().finite().min(0).max(1_000_000_000),
  })
  .refine((range) => range.low <= range.high, 'Estimate range must be ordered');

const EstimateResultSchema: z.ZodType<DTO.EstimateResult> = z
  .strictObject({
    profile: z.literal(MODEL_PROFILE),
    modelVersion: ModelVersionSchema,
    label: z.literal('uncalibrated heuristic'),
    coverage: z.enum(['full', 'analyzed-subset']),
    auditorHours: nonnegativeRange.describe('Cumulative auditor hours, outward rounded'),
    auditorDays: nonnegativeRange.describe('Cumulative auditor days, outward rounded'),
    contributions: z
      .array(
        z
          .strictObject({
            id: identifier,
            category: label,
            lowMicrohours: z.int().min(-100_000_000_000).max(100_000_000_000),
            highMicrohours: z.int().min(-100_000_000_000).max(100_000_000_000),
            inputStatus: z.enum(['measured', 'unavailable', 'manual']),
            explanation: smallText,
          })
          .refine(
            (item) => item.lowMicrohours <= item.highMicrohours,
            'Contribution range must be ordered',
          ),
      )
      .max(100000),
    assumptions: z.array(smallText).max(1000),
    manualAdjustments: z.array(ManualAdjustmentSchema).max(1000),
    parameters: ModelParametersSchema,
  })
  .superRefine((estimate, context) => {
    const ids = estimate.contributions.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['contributions'],
        message: 'Duplicate contribution ID',
      });
    }
    const manualIds = estimate.manualAdjustments.map((item) => item.id);
    if (new Set(manualIds).size !== manualIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['manualAdjustments'],
        message: 'Duplicate adjustment ID',
      });
    }
  });
const MAX_SCOPE_IDS = 100_000;
const EstimationScopeAnalysisSchema: z.ZodType<DTO.EstimationScopeAnalysis> = z.strictObject({
  mode: z.enum(['all', 'contracts']),
  reason: smallText.nullable(),
  selectedContractIds: z.array(ContractIdSchema).max(MAX_SCOPE_IDS),
  contextContractIds: z.array(ContractIdSchema).max(MAX_SCOPE_IDS),
  scopeNarrowed: z.boolean(),
  requestedScopeComplete: z.boolean(),
  rawSourceLines: measuredCount,
  reviewSourceLines: measuredCount,
  reusedSourceLines: measuredCount,
  outOfScopeSourceLines: measuredCount,
});

function codePointLess(left: string, right: string): boolean {
  const a = Array.from(left, (scalar) => scalar.codePointAt(0) ?? 0);
  const b = Array.from(right, (scalar) => scalar.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) < (b[index] ?? 0);
  }
  return a.length < b.length;
}

function sortedUnique(ids: readonly string[]): boolean {
  for (let index = 1; index < ids.length; index += 1) {
    if (!codePointLess(ids[index - 1] ?? '', ids[index] ?? '')) return false;
  }
  return true;
}

function validateEstimationScope(analysis: DTO.Analysis, context: z.RefinementCtx): void {
  const scope = analysis.estimationScope;
  if (scope === undefined) return;
  const reject = (message: string): void => {
    context.addIssue({ code: 'custom', path: ['estimationScope'], message });
  };
  if (!sortedUnique(scope.selectedContractIds) || !sortedUnique(scope.contextContractIds)) {
    reject('Scope contract IDs must be unique and sorted');
  }
  const known = new Set<string>(analysis.contracts.map((contract) => contract.id));
  const selected = new Set<string>(scope.selectedContractIds);
  for (const id of [...scope.selectedContractIds, ...scope.contextContractIds]) {
    if (!known.has(id)) {
      reject('Scope contract IDs must reference analyzed contracts');
      break;
    }
  }
  if (scope.contextContractIds.some((id) => selected.has(id))) {
    reject('Selected and context contracts must be disjoint');
  }
  const analyzed = new Set<string>(analysis.completeness.analyzedFileIds);
  const eligibleContracts = analysis.contracts.filter((contract) => analyzed.has(contract.fileId));
  if (
    scope.selectedContractIds.length + scope.contextContractIds.length !==
    eligibleContracts.length
  ) {
    reject('Scope contract IDs must partition every eligible contract');
  }
  if (scope.mode === 'all') {
    if (scope.reason !== null) reject('Whole-scope mode has no reason');
    if (scope.scopeNarrowed) reject('Whole-scope mode cannot be narrowed');
  } else {
    if (scope.reason === null) reject('Contract-scope mode requires a reason');
    if (scope.scopeNarrowed !== scope.contextContractIds.length > 0) {
      reject('Narrowing must match the context contracts');
    }
  }
  const counts = [
    scope.rawSourceLines,
    scope.reviewSourceLines,
    scope.reusedSourceLines,
    scope.outOfScopeSourceLines,
  ];
  const measuredCounts = counts.filter((item) => item.status === 'measured').length;
  if (measuredCounts !== 0 && measuredCounts !== counts.length) {
    reject('Aggregate line counts must be all measured or all unavailable');
    return;
  }
  if (measuredCounts === 0) {
    if (scope.requestedScopeComplete) reject('Unavailable projection cannot be complete');
    return;
  }
  const [raw, review, reused, outOfScope] = counts.map((item) =>
    item.status === 'measured' ? item.value : 0,
  );
  if ((raw ?? 0) !== (review ?? 0) + (reused ?? 0) + (outOfScope ?? 0)) {
    reject('Raw lines must equal review plus reused plus caller-excluded lines');
  }
  if (scope.mode === 'all' && (outOfScope ?? 0) !== 0) reject('Whole-scope mode excludes no lines');
  if (scope.mode === 'contracts' && (reused ?? 0) !== 0) {
    reject('Contract-scope mode reuses no lines');
  }
  let fileTotal = 0;
  for (const file of analysis.files) {
    if (analyzed.has(file.fileId) && file.sourceLines.status === 'measured') {
      fileTotal += file.sourceLines.value;
    }
  }
  if (fileTotal !== (raw ?? 0)) reject('Raw lines must equal the analyzed files source lines');
}

const AnalysisSchema: z.ZodType<DTO.Analysis> = z
  .strictObject({
    files: z.array(FileAnalysisSchema).max(100000),
    contracts: z.array(ContractAnalysisSchema).max(100000),
    callables: z.array(CallableAnalysisSchema).max(100000),
    aggregates: z.strictObject({
      scopedFiles: measuredCount,
      physicalLines: measuredCount,
      sourceLines: measuredCount,
      contracts: measuredCount,
      callables: measuredCount,
    }),
    graphs: z.array(RelationshipResultSchema).max(100000),
    indicators: z.array(IndicatorSchema).max(100000),
    testObservations: z.array(z.strictObject({ path, present: measuredBoolean })).max(100000),
    coverageObservation: z
      .strictObject({
        source: path.nullable(),
        coveredLines: measuredCount,
        totalLines: measuredCount,
      })
      .nullable(),
    completeness: z.strictObject({
      requiredAnalysisComplete: z.boolean(),
      hasUnknownSemantics: z.boolean(),
      analyzedFileIds: z.array(FileIdSchema).max(100000),
      unavailableFileIds: z.array(FileIdSchema).max(100000),
    }),
    estimationScope: EstimationScopeAnalysisSchema.optional(),
  })
  .superRefine((analysis, context) => {
    validateEstimationScope(analysis, context);
    for (const [field, ids] of [
      ['files', analysis.files.map((item) => item.fileId)],
      ['contracts', analysis.contracts.map((item) => item.id)],
      ['callables', analysis.callables.map((item) => item.id)],
      ['graphs', analysis.graphs.map((item) => item.id)],
      ['indicators', analysis.indicators.map((item) => item.id)],
    ] as const) {
      if (new Set(ids).size !== ids.length)
        context.addIssue({ code: 'custom', path: [field], message: 'Duplicate ID' });
    }
  });
const ReportEnvelopeSchema: z.ZodType<DTO.ReportEnvelope> = z
  .strictObject({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    toolVersion: label,
    command: z.enum(['estimate', 'inspect', 'explain']),
    status: z.enum(['complete', 'partial', 'error']),
    failureCategory: z.enum(['config', 'target', 'analysis', 'output', 'internal']).nullable(),
    versions: z.strictObject({ parser: label, metrics: label, indicators: label, model: label }),
    fingerprints: z.strictObject({
      sources: digest.nullable(),
      semanticConfig: digest.nullable(),
      analysis: digest.nullable(),
    }),
    scope: ScopeManifestSchema,
    analysis: AnalysisSchema.nullable(),
    estimate: EstimateResultSchema.nullable(),
    fullScopeEstimate: EstimateResultSchema.nullable(),
    diagnostics: z.array(DiagnosticSchema).max(100000),
    limitations: z.array(smallText).max(1000),
  })
  .superRefine((report, context) => {
    if (
      report.status === 'error' &&
      (report.failureCategory === null || report.diagnostics.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Error report requires a failure category and diagnostic',
      });
    }
    if (report.status !== 'error' && report.failureCategory !== null) {
      context.addIssue({ code: 'custom', message: 'Failure category is only for error reports' });
    }
    if (
      report.status === 'error' &&
      (report.analysis !== null || report.estimate !== null || report.fullScopeEstimate !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Error reports cannot fabricate analysis or estimates',
      });
    }
    if (report.status === 'partial' && report.fullScopeEstimate !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Partial reports cannot contain a full-scope estimate',
      });
    }
    if (
      report.status === 'complete' &&
      report.analysis?.completeness.requiredAnalysisComplete === false
    ) {
      context.addIssue({ code: 'custom', message: 'Complete report requires complete analysis' });
    }
    if (
      report.status === 'partial' &&
      report.estimate !== null &&
      report.estimate.coverage !== 'analyzed-subset'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Partial estimate must cover the analyzed subset',
      });
    }
    if (report.fullScopeEstimate !== null && report.fullScopeEstimate.coverage !== 'full') {
      context.addIssue({ code: 'custom', message: 'Full-scope estimate must have full coverage' });
    }
    if (
      report.command !== 'inspect' &&
      report.status === 'complete' &&
      report.analysis?.estimationScope?.scopeNarrowed === true
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A narrowed estimation scope cannot produce a complete report',
      });
    }
    if (report.status !== 'error' && report.analysis === null) {
      context.addIssue({
        code: 'custom',
        message: 'Successful and partial reports require analysis',
      });
    }
  });

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
} from './types.ts';

export {
  FileIdSchema,
  ContractIdSchema,
  CallableIdSchema,
  EdgeIdSchema,
  OwnershipSchema,
  ScopeRoleSchema,
  DeclarationKindSchema,
  CallableKindSchema,
  MeasurementSourceSchema,
  PositionSchema,
  SourceRangeSchema,
  EvidenceRefSchema,
  FileScopeEntrySchema,
  ScopeManifestSchema,
  ImportReferenceSchema,
  RelationshipResultSchema,
  CallableAnalysisSchema,
  ContractAnalysisSchema,
  FileAnalysisSchema,
  SyntaxBatchSchema,
  DiagnosticCodeSchema,
  DiagnosticSchema,
  IndicatorSchema,
  AnalysisLimitsSchema,
  ManualAdjustmentSchema,
  ParameterRangeSchema,
  ModelParametersSchema,
  ModelProfileSchema,
  ModelVersionSchema,
  EstimationScopeInputSchema,
  EstimationScopeAnalysisSchema,
  ReviewSummarySchema,
  ConfigInputSchema,
  ResolvedConfigSchema,
  EstimateInputSchema,
  EstimateResultSchema,
  AnalysisSchema,
  ReportEnvelopeSchema,
};
