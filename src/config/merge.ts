import { canonicalJson, fingerprint } from '../domain/canonical.ts';
import { CONFIG_SCHEMA_VERSION } from '../domain/versions.ts';
import type {
  AnalysisLimits,
  ConfigInput,
  EstimationScopeInput,
  ManualAdjustment,
  MeasurementSource,
  ModelParameters,
  ModelProfile,
  Remapping,
  ResolvedConfig,
  ScopeSettings,
} from '../domain/types.ts';
import { selectModel } from '../estimation/model.ts';
import { DEFAULT_EXCLUSION_PATTERNS } from './defaults.ts';
import {
  ConfigError,
  parseConfigInput,
  parseResolvedConfig,
  validateConfigPatterns,
  validatePatternList,
} from './validate.ts';

export interface TrustedConfigDefaults {
  readonly scope: ScopeSettings;
  readonly imports: { readonly remappings: readonly Remapping[] };
  readonly solidity: { readonly version: string };
  readonly analysis: { readonly limits: AnalysisLimits };
  readonly model: ModelProfile;
  readonly manualAdjustments: readonly ManualAdjustment[];
  readonly coverage: { readonly lcovPath: string | null };
}

export type ProjectMetadataHints = Pick<ConfigInput, 'scope' | 'imports' | 'solidity'>;

export interface ConfigCliOverrides {
  readonly include?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly solidityVersion?: string | undefined;
  readonly format?: 'terminal' | 'json' | 'markdown' | undefined;
  /** Library request override: replaces any configured estimation scope. */
  readonly estimationScope?: EstimationScopeInput | undefined;
}

export interface MergeConfigOptions {
  readonly defaults: TrustedConfigDefaults;
  readonly metadata?: ProjectMetadataHints | undefined;
  readonly fileConfig?: ConfigInput | undefined;
  readonly cli?: ConfigCliOverrides | undefined;
}

export interface ConfigMergeResult {
  readonly config: ResolvedConfig;
  readonly semanticHash: string;
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (scalar) => scalar.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (scalar) => scalar.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const leftPoint = leftPoints[index] ?? 0;
    const rightPoint = rightPoints[index] ?? 0;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftPoints.length < rightPoints.length
    ? -1
    : leftPoints.length > rightPoints.length
      ? 1
      : 0;
}

function copyScope(scope: ScopeSettings): ScopeSettings {
  return {
    sourceRoots: [...scope.sourceRoots],
    include: [...scope.include],
    exclude: [...scope.exclude],
    defaultExcludes: scope.defaultExcludes,
    thirdPartyRoots: [...scope.thirdPartyRoots],
    firstPartyOverrides: [...scope.firstPartyOverrides],
    followSymlinks: scope.followSymlinks,
  };
}

function copyModel(model: ModelProfile): ModelProfile {
  const parameters = model.parameters;
  return {
    profile: model.profile,
    modelVersion: model.modelVersion,
    parameters: {
      projectHours: { ...parameters.projectHours },
      slocHours: { ...parameters.slocHours },
      controlPremium: { ...parameters.controlPremium },
      storagePremium: { ...parameters.storagePremium },
      evmPremium: { ...parameters.evmPremium },
      interactionHours: { ...parameters.interactionHours },
      boundaryHours: { ...parameters.boundaryHours },
      unknownReserveHigh: parameters.unknownReserveHigh,
      hoursPerDay: parameters.hoursPerDay,
    },
  };
}

function copyLimits(limits: AnalysisLimits): AnalysisLimits {
  return { ...limits };
}

type ParameterOverrides = { -readonly [K in keyof ModelParameters]?: ModelParameters[K] };

const MODEL_PARAMETER_KEYS = [
  'projectHours',
  'slocHours',
  'controlPremium',
  'storagePremium',
  'evmPremium',
  'interactionHours',
  'boundaryHours',
  'unknownReserveHigh',
  'hoursPerDay',
] as const;

function copyParameterValue(value: ModelParameters[keyof ModelParameters]): never {
  return (typeof value === 'number' ? value : { ...value }) as never;
}

/** Selectors keep their identity; only the order is made deterministic (code-point order). */
function sortedEstimationScope(scope: EstimationScopeInput): EstimationScopeInput {
  if (scope.mode === 'all') return { mode: 'all' };
  const contracts = scope.contracts
    .map((item) => ({
      path: item.path,
      kind: item.kind,
      name: item.name,
      ...(item.sourceHash === undefined ? {} : { sourceHash: item.sourceHash }),
    }))
    .sort(
      (left, right) =>
        compareCodePoints(left.path, right.path) ||
        compareCodePoints(left.kind, right.kind) ||
        compareCodePoints(left.name, right.name),
    );
  return { mode: 'contracts', contracts, reason: scope.reason };
}

function applyInput(
  current: ResolvedConfig,
  input: ConfigInput,
  source: MeasurementSource,
  provenance: Map<string, MeasurementSource>,
  defaultModel: ModelProfile,
  overrides: ParameterOverrides,
): ResolvedConfig {
  let scope = current.scope;
  const scopeInput = input.scope;
  if (scopeInput !== undefined) {
    scope = {
      ...scope,
      ...(scopeInput.sourceRoots === undefined ? {} : { sourceRoots: [...scopeInput.sourceRoots] }),
      ...(scopeInput.include === undefined ? {} : { include: [...scopeInput.include] }),
      ...(scopeInput.exclude === undefined ? {} : { exclude: [...scopeInput.exclude] }),
      ...(scopeInput.defaultExcludes === undefined
        ? {}
        : { defaultExcludes: scopeInput.defaultExcludes }),
      ...(scopeInput.thirdPartyRoots === undefined
        ? {}
        : { thirdPartyRoots: [...scopeInput.thirdPartyRoots] }),
      ...(scopeInput.firstPartyOverrides === undefined
        ? {}
        : { firstPartyOverrides: [...scopeInput.firstPartyOverrides] }),
      ...(scopeInput.followSymlinks === undefined
        ? {}
        : { followSymlinks: scopeInput.followSymlinks }),
    };
    for (const key of [
      'sourceRoots',
      'include',
      'exclude',
      'defaultExcludes',
      'thirdPartyRoots',
      'firstPartyOverrides',
      'followSymlinks',
    ] as const) {
      if (scopeInput[key] !== undefined) provenance.set(`scope.${key}`, source);
    }
  }

  let remappings = current.imports.remappings;
  if (input.imports !== undefined) {
    remappings = [...input.imports.remappings];
    provenance.set('imports.remappings', source);
  }

  let solidityVersion = current.solidity.version;
  if (input.solidity !== undefined) {
    solidityVersion = input.solidity.version;
    provenance.set('solidity.version', source);
  }

  let limits = current.analysis.limits;
  const limitInput = input.analysis?.limits;
  if (limitInput !== undefined) {
    limits = {
      ...limits,
      ...(limitInput.maxFileBytes === undefined ? {} : { maxFileBytes: limitInput.maxFileBytes }),
      ...(limitInput.maxTotalSourceBytes === undefined
        ? {}
        : { maxTotalSourceBytes: limitInput.maxTotalSourceBytes }),
      ...(limitInput.maxFiles === undefined ? {} : { maxFiles: limitInput.maxFiles }),
      ...(limitInput.maxFsEntries === undefined ? {} : { maxFsEntries: limitInput.maxFsEntries }),
      ...(limitInput.maxDirectoryDepth === undefined
        ? {}
        : { maxDirectoryDepth: limitInput.maxDirectoryDepth }),
      ...(limitInput.maxImports === undefined ? {} : { maxImports: limitInput.maxImports }),
      ...(limitInput.maxGraphEdges === undefined
        ? {}
        : { maxGraphEdges: limitInput.maxGraphEdges }),
      ...(limitInput.maxAstNodesPerFile === undefined
        ? {}
        : { maxAstNodesPerFile: limitInput.maxAstNodesPerFile }),
      ...(limitInput.maxAstNodesTotal === undefined
        ? {}
        : { maxAstNodesTotal: limitInput.maxAstNodesTotal }),
      ...(limitInput.maxPatternsPerList === undefined
        ? {}
        : { maxPatternsPerList: limitInput.maxPatternsPerList }),
      ...(limitInput.maxPatternLength === undefined
        ? {}
        : { maxPatternLength: limitInput.maxPatternLength }),
      ...(limitInput.maxGlobStates === undefined
        ? {}
        : { maxGlobStates: limitInput.maxGlobStates }),
      ...(limitInput.maxMetadataBytes === undefined
        ? {}
        : { maxMetadataBytes: limitInput.maxMetadataBytes }),
      ...(limitInput.maxLcovBytes === undefined ? {} : { maxLcovBytes: limitInput.maxLcovBytes }),
      ...(limitInput.parseTimeoutMs === undefined
        ? {}
        : { parseTimeoutMs: limitInput.parseTimeoutMs }),
      ...(limitInput.maxSemanticFiles === undefined
        ? {}
        : { maxSemanticFiles: limitInput.maxSemanticFiles }),
      ...(limitInput.maxSemanticBytes === undefined
        ? {}
        : { maxSemanticBytes: limitInput.maxSemanticBytes }),
      ...(limitInput.semanticTimeoutMs === undefined
        ? {}
        : { semanticTimeoutMs: limitInput.semanticTimeoutMs }),
      ...(limitInput.analysisTimeoutMs === undefined
        ? {}
        : { analysisTimeoutMs: limitInput.analysisTimeoutMs }),
    };
    for (const key of [
      'maxFileBytes',
      'maxTotalSourceBytes',
      'maxFiles',
      'maxFsEntries',
      'maxDirectoryDepth',
      'maxImports',
      'maxGraphEdges',
      'maxAstNodesPerFile',
      'maxAstNodesTotal',
      'maxPatternsPerList',
      'maxPatternLength',
      'maxGlobStates',
      'maxMetadataBytes',
      'maxLcovBytes',
      'parseTimeoutMs',
      'maxSemanticFiles',
      'maxSemanticBytes',
      'semanticTimeoutMs',
      'analysisTimeoutMs',
    ] as const) {
      if (limitInput[key] !== undefined) provenance.set(`analysis.limits.${key}`, source);
    }
  }

  let model = current.model;
  const modelInput = input.model;
  if (modelInput !== undefined) {
    // Resolve the final profile and version first, then apply explicit overrides in layer order.
    const modelVersion = modelInput.modelVersion ?? model.modelVersion;
    for (const key of MODEL_PARAMETER_KEYS) {
      const value = modelInput.parameters?.[key];
      if (value !== undefined) overrides[key] = copyParameterValue(value);
    }
    const base =
      modelVersion === defaultModel.modelVersion
        ? defaultModel.parameters
        : selectModel(modelInput.profile, modelVersion).parameters;
    const parameters: ModelParameters = { ...base };
    for (const key of MODEL_PARAMETER_KEYS) {
      const value = overrides[key];
      if (value !== undefined) Object.assign(parameters, { [key]: copyParameterValue(value) });
    }
    model = { profile: modelInput.profile, modelVersion, parameters };
    provenance.set('model.profile', source);
    if (modelInput.modelVersion !== undefined) provenance.set('model.modelVersion', source);
    for (const key of MODEL_PARAMETER_KEYS) {
      if (modelInput.parameters?.[key] !== undefined) {
        provenance.set(`model.parameters.${key}`, source);
      }
    }
  }

  let manualAdjustments = current.manualAdjustments;
  if (input.manualAdjustments !== undefined) {
    manualAdjustments = [...input.manualAdjustments];
    provenance.set('manualAdjustments', source);
  }

  let coverage = current.coverage;
  if (input.coverage !== undefined) {
    coverage = { lcovPath: input.coverage.lcovPath };
    provenance.set('coverage.lcovPath', source);
  }

  let reportFormat = current.report.format;
  if (input.report !== undefined) {
    reportFormat = input.report.format;
    provenance.set('report.format', source);
  }

  let estimationScope = current.estimationScope;
  if (input.estimationScope !== undefined) {
    estimationScope = sortedEstimationScope(input.estimationScope);
    provenance.set('estimationScope', source);
  }

  return {
    configVersion: current.configVersion,
    scope,
    imports: { remappings },
    solidity: { version: solidityVersion },
    analysis: { limits },
    model,
    manualAdjustments,
    coverage,
    report: { format: reportFormat },
    estimationScope,
    provenance: current.provenance,
  };
}

export function mergeConfig(options: MergeConfigOptions): ConfigMergeResult {
  const provenance = new Map<string, MeasurementSource>();
  const defaults = options.defaults;
  const metadataInput =
    options.metadata === undefined
      ? undefined
      : parseConfigInput({ configVersion: CONFIG_SCHEMA_VERSION, ...options.metadata });
  const fileConfig =
    options.fileConfig === undefined ? undefined : parseConfigInput(options.fileConfig);

  if (metadataInput !== undefined) {
    validateConfigPatterns(metadataInput, options.defaults.analysis.limits);
  }
  if (fileConfig !== undefined) {
    const filePatternLimits = {
      maxPatternsPerList:
        fileConfig.analysis?.limits.maxPatternsPerList ??
        options.defaults.analysis.limits.maxPatternsPerList,
      maxPatternLength:
        fileConfig.analysis?.limits.maxPatternLength ??
        options.defaults.analysis.limits.maxPatternLength,
    };
    validateConfigPatterns(fileConfig, filePatternLimits);
  }

  const initial: ResolvedConfig = {
    configVersion: CONFIG_SCHEMA_VERSION,
    scope: copyScope(defaults.scope),
    imports: { remappings: [...defaults.imports.remappings] },
    solidity: { version: defaults.solidity.version },
    analysis: { limits: copyLimits(defaults.analysis.limits) },
    model: copyModel(defaults.model),
    manualAdjustments: [...defaults.manualAdjustments],
    coverage: { lcovPath: defaults.coverage.lcovPath },
    report: { format: 'terminal' },
    estimationScope: { mode: 'all' },
    provenance: [],
  };

  for (const field of [
    'scope.sourceRoots',
    'scope.include',
    'scope.exclude',
    'scope.defaultExcludes',
    'scope.thirdPartyRoots',
    'scope.firstPartyOverrides',
    'scope.followSymlinks',
    'imports.remappings',
    'solidity.version',
    'analysis.limits.maxFileBytes',
    'analysis.limits.maxTotalSourceBytes',
    'analysis.limits.maxFiles',
    'analysis.limits.maxFsEntries',
    'analysis.limits.maxDirectoryDepth',
    'analysis.limits.maxImports',
    'analysis.limits.maxGraphEdges',
    'analysis.limits.maxAstNodesPerFile',
    'analysis.limits.maxAstNodesTotal',
    'analysis.limits.maxPatternsPerList',
    'analysis.limits.maxPatternLength',
    'analysis.limits.maxGlobStates',
    'analysis.limits.maxMetadataBytes',
    'analysis.limits.maxLcovBytes',
    'analysis.limits.parseTimeoutMs',
    'analysis.limits.maxSemanticFiles',
    'analysis.limits.maxSemanticBytes',
    'analysis.limits.semanticTimeoutMs',
    'analysis.limits.analysisTimeoutMs',
    'model.profile',
    'model.modelVersion',
    'model.parameters.projectHours',
    'model.parameters.slocHours',
    'model.parameters.controlPremium',
    'model.parameters.storagePremium',
    'model.parameters.evmPremium',
    'model.parameters.interactionHours',
    'model.parameters.boundaryHours',
    'model.parameters.unknownReserveHigh',
    'model.parameters.hoursPerDay',
    'manualAdjustments',
    'coverage.lcovPath',
    'report.format',
    'estimationScope',
  ]) {
    provenance.set(field, 'default');
  }

  let current = initial;
  const overrides: ParameterOverrides = {};
  if (metadataInput !== undefined) {
    current = applyInput(current, metadataInput, 'metadata', provenance, defaults.model, overrides);
  }
  if (fileConfig !== undefined) {
    current = applyInput(current, fileConfig, 'config', provenance, defaults.model, overrides);
  }

  const cli = options.cli;
  if (cli !== undefined) {
    const supportedCliKeys = new Set([
      'include',
      'exclude',
      'solidityVersion',
      'format',
      'estimationScope',
    ]);
    if (Object.keys(cli).some((key) => !supportedCliKeys.has(key))) {
      throw new ConfigError('Configuration data is invalid.');
    }
    const cliInput: ConfigInput = {
      configVersion: CONFIG_SCHEMA_VERSION,
      ...(cli.include === undefined ? {} : { scope: { include: [...cli.include] } }),
      ...(cli.exclude === undefined
        ? {}
        : {
            scope: {
              ...(cli.include === undefined ? {} : { include: [...cli.include] }),
              exclude: [...cli.exclude],
            },
          }),
      ...(cli.solidityVersion === undefined ? {} : { solidity: { version: cli.solidityVersion } }),
      ...(cli.format === undefined ? {} : { report: { format: cli.format } }),
      ...(cli.estimationScope === undefined ? {} : { estimationScope: cli.estimationScope }),
    };
    const validatedCliInput = parseConfigInput(cliInput);
    validateConfigPatterns(validatedCliInput, current.analysis.limits);
    current = applyInput(current, validatedCliInput, 'cli', provenance, defaults.model, overrides);
  }

  if (current.scope.defaultExcludes) {
    validatePatternList(
      DEFAULT_EXCLUSION_PATTERNS,
      DEFAULT_EXCLUSION_PATTERNS.length,
      current.analysis.limits.maxPatternLength,
    );
  }
  validatePatternList(
    current.scope.include,
    current.analysis.limits.maxPatternsPerList,
    current.analysis.limits.maxPatternLength,
  );
  validatePatternList(
    current.scope.exclude,
    current.analysis.limits.maxPatternsPerList,
    current.analysis.limits.maxPatternLength,
  );

  const validated = parseResolvedConfig({
    ...current,
    provenance: [...provenance.entries()]
      .map(([field, source]) => ({ field, source }))
      .sort((left, right) => compareCodePoints(left.field, right.field)),
  });
  const semanticSettings = {
    scope: validated.scope,
    defaultExclusionPatterns: validated.scope.defaultExcludes ? DEFAULT_EXCLUSION_PATTERNS : [],
    imports: validated.imports,
    solidity: validated.solidity,
    analysis: validated.analysis,
    model: validated.model,
    manualAdjustments: validated.manualAdjustments,
    coverage: validated.coverage,
    estimationScope: validated.estimationScope,
  };

  return {
    config: validated,
    semanticHash: fingerprint([canonicalJson(semanticSettings)]),
  };
}
