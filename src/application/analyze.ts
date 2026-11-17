import { realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ConfigError, DEFAULT_CONFIG_FILE, ProjectRootError } from '../config/defaults.ts';
import { resolveConfig, selectProjectRoot } from '../config/load.ts';
import { BudgetError, createDiscoveryBudget } from '../discovery/budget.ts';
import { discoverScope } from '../discovery/discover.ts';
import { IdentityRegistry } from '../discovery/identity.ts';
import { readProjectMetadata } from '../discovery/metadata.ts';
import { resolveSafePath, SafePathError } from '../discovery/safe-path.ts';
import type { SafePathContext } from '../discovery/safe-path.ts';
import { SafeReadError } from '../discovery/safe-read.ts';
import { fileIdentity } from '../domain/canonical.ts';
import { MODEL_VERSION } from '../domain/versions.ts';
import type {
  Analysis,
  ContractId,
  EstimationScopeInput,
  Diagnostic,
  EstimateResult,
  FileId,
  Measurement,
  ReportEnvelope,
  ResolvedConfig,
  ScopeManifest,
} from '../domain/types.ts';
import { EstimationError } from '../estimation/model.ts';
import { estimateEffort } from '../estimation/estimate.ts';
import { classifyIndicators } from '../indicators/classify.ts';
import { collectReadiness } from '../indicators/readiness.ts';
import type { ObservedAlias, ReadinessResult } from '../indicators/readiness.ts';
import { aggregateMetrics } from '../metrics/aggregate.ts';
import { buildFileMetrics } from '../metrics/structural.ts';
import type { FileMetrics } from '../metrics/structural.ts';
import { createParserSession } from '../parser/adapter.ts';
import type { ParseFileResult, ParserSource } from '../parser/protocol.ts';
import { resolveRelationships } from '../relationships/closure.ts';
import type { RelationshipAnalysis } from '../relationships/types.ts';
import { productionConfigDefaults } from './defaults.ts';
import {
  buildAnalysisEnvelope,
  buildErrorEnvelope,
  fixedDiagnostic,
  parserLabelFromVersion,
  trustedParserLabel,
} from './envelope.ts';
import type { EnvelopeIdentity, FailureCategory } from './envelope.ts';
import { buildEstimateInput } from './estimate-input.ts';
import { sourcesFingerprint } from './fingerprints.ts';
import { BUNDLED_CATALOG } from './dependency-reuse/catalog.ts';
import { classifyDependencies } from './dependency-reuse/classify.ts';
import type { ClassifyFile } from './dependency-reuse/classify.ts';
import { buildDependencyReuse, projectReview } from './dependency-reuse/project.ts';
import { ProjectionUnavailableError } from './dependency-reuse/types.ts';
import type { ReviewProjection } from './dependency-reuse/types.ts';
import {
  ScopeLimitError,
  buildEstimationScopeAnalysis,
  resolveDispositions,
} from './estimation-scope.ts';

export interface AnalyzeRequest {
  readonly command: 'estimate' | 'inspect' | 'explain';
  /** Absolute, lexical (not realpath'd). */
  readonly input: string;
  readonly root?: string | undefined;
  readonly configPath?: string | undefined;
  readonly noConfig: boolean;
  readonly include?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly solidityVersion?: string | undefined;
  readonly format?: 'terminal' | 'json' | 'markdown' | undefined;
  readonly allowPartial: boolean;
  /**
   * Optional exact contract selection for the estimate. Replaces any configured selection and is
   * validated like a configured one, even with `noConfig`. Default: every eligible declaration.
   */
  readonly estimationScope?: EstimationScopeInput | undefined;
}

export interface AnalyzeOptions {
  readonly signal?: AbortSignal | undefined;
  readonly cwd?: string | undefined;
}

export interface AnalyzeOutcome {
  readonly envelope: ReportEnvelope;
  readonly outcome: 'complete' | 'partial' | 'failure' | 'interrupted';
  /** Effective report format: CLI value, then configuration, then terminal. */
  readonly reportFormat: 'terminal' | 'json' | 'markdown';
  /** Canonical paths of every read source, configuration, metadata and coverage file. */
  readonly protectedPaths: readonly string[];
}

type Phase = Diagnostic['phase'];

const METADATA_FILE_NAMES: readonly string[] = [
  'foundry.toml',
  'remappings.txt',
  'package.json',
  'hardhat.config.ts',
  'hardhat.config.js',
  'hardhat.config.cjs',
  'hardhat.config.mjs',
];

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (scalar) => scalar.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (scalar) => scalar.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const leftPoint = leftPoints[index] ?? 0;
    const rightPoint = rightPoints[index] ?? 0;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

function sortedUnique<T extends string>(items: Iterable<T>): T[] {
  return [...new Set(items)].sort(compareCodePoints);
}

async function canonicalizeAll(paths: ReadonlySet<string>): Promise<string[]> {
  const result = new Set<string>();
  for (const path of paths) {
    try {
      result.add(await realpath(path));
    } catch {
      // A missing file may be created later; keep the lexical absolute path as the comparison key.
      try {
        result.add(join(await realpath(dirname(path)), path.slice(dirname(path).length + 1)));
      } catch {
        result.add(path);
      }
    }
  }
  return [...result].sort(compareCodePoints);
}

interface Failure {
  readonly category: FailureCategory;
  readonly diagnostics: readonly Diagnostic[];
  readonly interrupted: boolean;
}

function failureFor(error: unknown, phase: Phase, signal: AbortSignal | undefined): Failure {
  if (signal?.aborted === true || (error instanceof BudgetError && error.kind === 'cancelled')) {
    return {
      category: 'analysis',
      interrupted: true,
      diagnostics: [
        fixedDiagnostic('PARTIAL_ANALYSIS', 'error', phase, 'Analysis was interrupted.'),
      ],
    };
  }
  if (error instanceof ScopeLimitError) {
    return {
      category: 'analysis',
      interrupted: false,
      diagnostics: [
        fixedDiagnostic(
          'LIMIT_EXCEEDED',
          'error',
          phase,
          'The estimation scope exceeds a documented output bound.',
        ),
      ],
    };
  }
  if (error instanceof ConfigError) {
    return {
      category: 'config',
      interrupted: false,
      diagnostics: [
        fixedDiagnostic('CONFIG_INVALID', 'error', 'config', 'Configuration data is invalid.'),
      ],
    };
  }
  if (error instanceof ProjectRootError) {
    return {
      category: 'target',
      interrupted: false,
      diagnostics: [
        fixedDiagnostic(
          'TARGET_UNREADABLE',
          'error',
          'discovery',
          'The selected input or project root is unavailable.',
        ),
      ],
    };
  }
  if (error instanceof SafePathError) {
    return {
      category: 'target',
      interrupted: false,
      diagnostics: [
        error.code === 'PATH_BLOCKED'
          ? fixedDiagnostic(
              'PATH_BLOCKED',
              'error',
              'discovery',
              'The selected path could not be accessed safely.',
            )
          : fixedDiagnostic(
              'TARGET_UNREADABLE',
              'error',
              'discovery',
              'The selected input or project root is unavailable.',
            ),
      ],
    };
  }
  if (error instanceof SafeReadError) {
    return error.code === 'SOURCE_CHANGED'
      ? {
          category: 'analysis',
          interrupted: false,
          diagnostics: [
            fixedDiagnostic(
              'SOURCE_CHANGED',
              'error',
              'discovery',
              'A source file changed while it was being read.',
            ),
          ],
        }
      : {
          category: 'target',
          interrupted: false,
          diagnostics: [
            fixedDiagnostic(
              'TARGET_UNREADABLE',
              'error',
              'discovery',
              'The selected input or project root is unavailable.',
            ),
          ],
        };
  }
  if (error instanceof BudgetError) {
    return {
      category: 'analysis',
      interrupted: false,
      diagnostics: [
        fixedDiagnostic(
          'LIMIT_EXCEEDED',
          'error',
          phase,
          error.kind === 'deadline'
            ? 'The analysis time limit was reached.'
            : 'An analysis limit was exceeded.',
        ),
      ],
    };
  }
  return {
    category: 'internal',
    interrupted: false,
    diagnostics: [
      fixedDiagnostic('INTERNAL_ERROR', 'error', phase, 'Analysis failed unexpectedly.'),
    ],
  };
}

async function lexicalRootFor(request: AnalyzeRequest): Promise<string> {
  if (request.root !== undefined) return request.root;
  try {
    return (await stat(request.input)).isDirectory() ? request.input : dirname(request.input);
  } catch {
    return dirname(request.input);
  }
}

function collectAliases(
  relationshipAliases: readonly {
    readonly representativePath: string;
    readonly lexicalAliases: readonly string[];
  }[],
  manifest: ScopeManifest,
): ObservedAlias[] {
  const known = new Set<FileId>(manifest.entries.map((entry) => entry.fileId));
  const aliases: ObservedAlias[] = [];
  for (const observation of relationshipAliases) {
    let fileId: FileId;
    try {
      fileId = fileIdentity(observation.representativePath);
    } catch {
      continue;
    }
    if (!known.has(fileId)) continue;
    for (const path of observation.lexicalAliases) {
      if (path !== observation.representativePath) aliases.push({ fileId, path });
    }
  }
  return aliases;
}

function scopedMetricsFor(
  manifest: ScopeManifest,
  sources: readonly ParserSource[],
  syntax: readonly ParseFileResult[],
): FileMetrics[] {
  const sourceById = new Map(sources.map((source) => [source.fileId, source]));
  const syntaxById = new Map(syntax.map((result) => [result.fileId, result]));
  const metrics: FileMetrics[] = [];
  for (const entry of manifest.entries) {
    if (entry.role !== 'scoped') continue;
    const source = sourceById.get(entry.fileId);
    if (source === undefined) throw new TypeError('A scoped file has no source record.');
    const result: ParseFileResult = syntaxById.get(entry.fileId) ?? {
      status: 'failed',
      fileId: entry.fileId,
      code: 'INTERNAL_ERROR',
      diagnostics: [],
    };
    metrics.push(buildFileMetrics(source, result));
  }
  return metrics.sort((left, right) => compareCodePoints(left.file.fileId, right.file.fileId));
}

interface Completeness {
  readonly requiredAnalysisComplete: boolean;
  readonly parsedScoped: ReadonlySet<FileId>;
  readonly analyzedFileIds: FileId[];
  readonly unavailableFileIds: FileId[];
}

function computeCompleteness(
  discoveryComplete: boolean,
  relationships: RelationshipAnalysis,
): Completeness {
  const syntaxById = new Map(relationships.syntax.files.map((result) => [result.fileId, result]));
  const invalidated = new Set<FileId>(relationships.invalidatedScopedFileIds);
  const parsedScoped = new Set<FileId>();
  const analyzed: FileId[] = [];
  const unavailable: FileId[] = [];
  let allScopedParsed = true;
  for (const entry of relationships.manifest.entries) {
    const parsed = syntaxById.get(entry.fileId)?.status === 'parsed';
    if (entry.role === 'scoped') {
      if (parsed) parsedScoped.add(entry.fileId);
      else allScopedParsed = false;
      if (!parsed || invalidated.has(entry.fileId)) unavailable.push(entry.fileId);
      else if (entry.ownership === 'first-party') analyzed.push(entry.fileId);
    } else if (entry.role === 'context') {
      if (syntaxById.get(entry.fileId)?.status === 'failed') unavailable.push(entry.fileId);
    }
  }
  for (const fileId of invalidated) unavailable.push(fileId);
  return {
    requiredAnalysisComplete:
      discoveryComplete &&
      relationships.requiredAnalysisComplete &&
      allScopedParsed &&
      invalidated.size === 0,
    parsedScoped,
    analyzedFileIds: sortedUnique(analyzed),
    unavailableFileIds: sortedUnique(unavailable),
  };
}

function hasWarningOrError(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((item) => item.severity !== 'info');
}

/**
 * Runs the full local analysis pipeline. Expected conditions never throw: they become an error or
 * partial envelope. The parser session is closed on every path.
 */
export async function analyzeProject(
  request: AnalyzeRequest,
  options: AnalyzeOptions = {},
): Promise<AnalyzeOutcome> {
  const cwd = options.cwd ?? process.cwd();
  const signal = options.signal;
  const protectedCandidates = new Set<string>();
  let phase: Phase = 'config';
  let reportFormat: AnalyzeOutcome['reportFormat'] = request.format ?? 'terminal';
  let semanticConfig: string | null = null;
  let parser = await trustedParserLabel();
  let session: ReturnType<typeof createParserSession> | undefined;
  let manifestForErrors: ScopeManifest | undefined;
  let modelVersion: string = MODEL_VERSION;

  const identity = (): EnvelopeIdentity => ({
    command: request.command,
    parser,
    semanticConfig,
    model: modelVersion,
  });
  const finish = async (
    envelope: ReportEnvelope,
    outcome: AnalyzeOutcome['outcome'],
  ): Promise<AnalyzeOutcome> => ({
    envelope,
    outcome,
    reportFormat,
    protectedPaths: await canonicalizeAll(protectedCandidates),
  });

  try {
    const lexicalRoot = await lexicalRootFor(request);
    const root = await selectProjectRoot(request.input, request.root, cwd);
    const defaults = productionConfigDefaults();
    const cli = {
      ...(request.include === undefined ? {} : { include: request.include }),
      ...(request.exclude === undefined ? {} : { exclude: request.exclude }),
      ...(request.solidityVersion === undefined
        ? {}
        : { solidityVersion: request.solidityVersion }),
      ...(request.format === undefined ? {} : { format: request.format }),
      ...(request.estimationScope === undefined
        ? {}
        : { estimationScope: request.estimationScope }),
    };
    const configInputs = {
      root,
      ...(request.configPath === undefined ? {} : { configPath: request.configPath }),
      noConfig: request.noConfig,
      defaults,
      cli,
    };
    if (request.configPath !== undefined) protectedCandidates.add(request.configPath);
    if (!request.noConfig) protectedCandidates.add(join(root, DEFAULT_CONFIG_FILE));
    for (const name of METADATA_FILE_NAMES) protectedCandidates.add(join(root, name));

    const operational = await resolveConfig(configInputs);
    reportFormat = operational.config.report.format;
    modelVersion = operational.config.model.modelVersion;
    const limits = operational.config.analysis.limits;
    const budget = createDiscoveryBudget(
      limits,
      signal,
      performance.now() + limits.analysisTimeoutMs,
    );

    phase = 'discovery';
    const rootContext: SafePathContext = { root, lexicalRoot, followSymlinks: false };
    const metadata = await readProjectMetadata({ pathContext: rootContext, budget });
    const resolved = await resolveConfig({ ...configInputs, metadata: metadata.hints });
    const config: ResolvedConfig = resolved.config;
    semanticConfig = resolved.semanticHash;
    reportFormat = config.report.format;
    modelVersion = config.model.modelVersion;
    budget.assertLimitsMatch(config.analysis.limits);
    if (config.coverage.lcovPath !== null) {
      protectedCandidates.add(resolve(root, config.coverage.lcovPath));
    }

    const pathContext: SafePathContext = {
      root,
      lexicalRoot,
      target: await realpath(request.input),
      lexicalTarget: request.input,
      followSymlinks: config.scope.followSymlinks,
    };
    const target = await resolveSafePath({ ...pathContext, budget }, request.input);
    const identities = new IdentityRegistry();
    const discovery = await discoverScope({
      root: pathContext.root,
      lexicalRoot: pathContext.lexicalRoot,
      target,
      lexicalTarget: request.input,
      config,
      metadata,
      budget,
      identities,
    });
    for (const snapshot of discovery.snapshots) protectedCandidates.add(snapshot.absolutePath);
    manifestForErrors = discovery.manifest;

    if (discovery.manifest.scopedFileIds.length === 0) {
      return await finish(
        buildErrorEnvelope({
          identity: identity(),
          category: 'target',
          scope: discovery.manifest,
          diagnostics: [
            fixedDiagnostic(
              'EMPTY_SCOPE',
              'error',
              'discovery',
              'No Solidity source is in the analysis scope.',
            ),
            ...discovery.diagnostics,
          ],
        }),
        'failure',
      );
    }

    phase = 'parse';
    session = createParserSession({ budget, config });
    const parserSources: ParserSource[] = discovery.snapshots.map((snapshot) => {
      const fileId = fileIdentity(snapshot.canonicalPath);
      const manifestEntry = discovery.manifest.entries.find((entry) => entry.fileId === fileId);
      if (manifestEntry === undefined) throw new TypeError('A source has no manifest entry.');
      return { fileId, snapshot, manifestEntry };
    });
    const initialSyntax = await session.analyzeSources(parserSources);

    phase = 'semantics';
    const relationships = await resolveRelationships({
      discovery,
      pathContext,
      identities,
      budget,
      config,
      metadata,
      session,
      initialSyntax,
    });
    for (const source of relationships.sources) {
      protectedCandidates.add(source.snapshot.absolutePath);
    }
    manifestForErrors = relationships.manifest;
    const firstParsed = relationships.syntax.files.find((result) => result.status === 'parsed');
    if (firstParsed?.status === 'parsed') {
      parser = parserLabelFromVersion(firstParsed.version.parserVersion);
    }

    phase = 'metrics';
    const scopedMetrics = scopedMetricsFor(
      relationships.manifest,
      relationships.sources,
      relationships.syntax.files,
    );
    const aggregates = aggregateMetrics(scopedMetrics);
    if (aggregates.sourceLines.status === 'measured' && aggregates.sourceLines.value === 0) {
      return await finish(
        buildErrorEnvelope({
          identity: identity(),
          category: 'target',
          scope: relationships.manifest,
          diagnostics: [
            fixedDiagnostic(
              'EMPTY_SCOPE',
              'error',
              'metrics',
              'The analysis scope contains no source lines.',
            ),
            ...relationships.diagnostics,
          ],
        }),
        'failure',
      );
    }

    const indicators = classifyIndicators({
      manifest: relationships.manifest,
      syntax: relationships.syntax,
      metrics: scopedMetrics,
      relationships,
    });
    const readiness: ReadinessResult = await collectReadiness({
      pathContext,
      budget,
      metadataPaths: metadata.paths,
      coverage: config.coverage,
      manifest: relationships.manifest,
      physicalLines: scopedMetrics.map((metrics) => ({
        fileId: metrics.file.fileId,
        physicalLines: metrics.file.physicalLines,
      })),
      aliases: collectAliases(discovery.observations.aliases, relationships.manifest),
    });

    const completeness = computeCompleteness(discovery.complete, relationships);

    // Caller scope is resolved against the final accepted declarations, independent of any content
    // recognition; an invalid selector is a sanitized configuration failure and never narrows.
    const eligibleFileIds = new Set<FileId>(completeness.analyzedFileIds);
    const checkpoint = (): Promise<void> => budget.checkpoint();
    const sourceById = new Map(relationships.sources.map((item) => [item.fileId, item]));
    const syntaxById = new Map(relationships.syntax.files.map((item) => [item.fileId, item]));
    // Content recognition is independent of caller selection: it is always computed and disclosed,
    // but it is applied only to the whole eligible scope under the current model, never to an
    // explicit contract selection and never to the frozen 1.0.0 model.
    const classifyFiles: ClassifyFile[] = [];
    for (const metrics of scopedMetrics) {
      if (!eligibleFileIds.has(metrics.file.fileId)) continue;
      const source = sourceById.get(metrics.file.fileId);
      const result = syntaxById.get(metrics.file.fileId);
      if (source !== undefined && result !== undefined)
        classifyFiles.push({ metrics, source, result });
    }
    const recognition = await classifyDependencies({
      catalog: BUNDLED_CATALOG,
      files: classifyFiles,
      checkpoint,
    });
    const reuseApplies =
      config.model.modelVersion !== '1.0.0' && config.estimationScope.mode === 'all';
    const reusable = new Set<ContractId>();
    if (reuseApplies) {
      for (const state of recognition.values()) {
        if (state.status !== 'available') continue;
        for (const match of state.matches) reusable.add(match.contractId);
      }
    }
    const dispositions = await resolveDispositions({
      scope: config.estimationScope,
      manifest: relationships.manifest,
      metrics: scopedMetrics,
      eligibleFileIds,
      reusable,
      checkpoint,
    });
    const rawBuiltin = new Map<FileId, Measurement<number>>(
      relationships.confirmedBuiltinLowLevelCalls.map((row) => [
        row.fileId,
        row.confirmedBuiltinLowLevelCalls,
      ]),
    );
    let projection: ReviewProjection | null = null;
    try {
      projection = await projectReview({
        dispositions,
        metrics: scopedMetrics.filter((metrics) => eligibleFileIds.has(metrics.file.fileId)),
        sources: sourceById,
        syntax: syntaxById,
        callSites: relationships.callSites,
        rawBuiltin,
        checkpoint,
      });
    } catch (error: unknown) {
      if (!(error instanceof ProjectionUnavailableError)) throw error;
    }
    const estimationScope = buildEstimationScopeAnalysis({
      dispositions,
      projection,
      requiredAnalysisComplete: completeness.requiredAnalysisComplete,
    });

    const analysis: Analysis = {
      files: scopedMetrics.map((metrics) => metrics.file),
      contracts: scopedMetrics
        .flatMap((metrics) => metrics.contracts)
        .sort((left, right) => compareCodePoints(left.id, right.id)),
      callables: scopedMetrics
        .flatMap((metrics) => metrics.callables)
        .sort((left, right) => compareCodePoints(left.id, right.id)),
      aggregates,
      graphs: relationships.graphs,
      indicators: indicators.indicators,
      testObservations: readiness.testObservations,
      coverageObservation: readiness.coverageObservation,
      completeness: {
        requiredAnalysisComplete: completeness.requiredAnalysisComplete,
        hasUnknownSemantics: relationships.hasUnknownSemantics,
        analyzedFileIds: completeness.analyzedFileIds,
        unavailableFileIds: completeness.unavailableFileIds,
      },
      estimationScope,
      dependencyReuse: buildDependencyReuse({
        catalog: BUNDLED_CATALOG,
        recognition,
        projection,
        policy: reuseApplies ? 'verified-reuse' : 'full-review',
      }),
    };

    const diagnostics: Diagnostic[] = [
      ...relationships.diagnostics,
      ...indicators.diagnostics,
      ...readiness.diagnostics,
    ];
    const limitations: string[] = [...indicators.limitations, ...readiness.limitations];
    if (reusable.size > 0) {
      limitations.push(
        'Declarations matched by content to reviewed reference sources receive no full-review charge; a match does not verify the installed version, dependency bindings, compiler behavior, deployment or security.',
      );
    }
    if (dispositions.scopeNarrowed) {
      limitations.push(
        'Declarations left out of the explicit contract selection are caller-selected context, not evidence of verified reuse; unselected custom bases, helpers and callees are not reviewed in full and the whole physical scope was not priced.',
      );
    }
    const sources = sourcesFingerprint({
      relationshipFingerprint: relationships.fingerprint,
      manifest: relationships.manifest,
      syntax: relationships.syntax.files,
    });

    let estimate: EstimateResult | null = null;
    if (request.command !== 'inspect') {
      phase = 'estimate';
      try {
        if (projection === null) {
          // The requested view could not be proven; never fall back to a wider scope.
          diagnostics.push(
            fixedDiagnostic(
              'PARTIAL_ANALYSIS',
              'warning',
              'estimate',
              'No estimate was produced because the requested review scope could not be projected.',
            ),
          );
        } else {
          estimate = estimateEffort(
            buildEstimateInput({
              manifest: relationships.manifest,
              metrics: scopedMetrics,
              parsedFileIds: completeness.parsedScoped,
              relationships,
              requiredAnalysisComplete: completeness.requiredAnalysisComplete,
              config,
              allowPartial: request.allowPartial,
              projection,
            }),
          );
        }
      } catch (error: unknown) {
        if (!(error instanceof EstimationError)) throw error;
        if (error.reason === 'invalid-total') {
          return await finish(
            buildErrorEnvelope({
              identity: identity(),
              category: 'config',
              scope: relationships.manifest,
              sources,
              diagnostics: [
                fixedDiagnostic(
                  'CONFIG_INVALID',
                  'error',
                  'estimate',
                  'Manual adjustments make the estimate total invalid.',
                ),
              ],
            }),
            'failure',
          );
        }
        if (error.reason === 'output-bound' || error.reason === 'unsafe-arithmetic') {
          diagnostics.push(
            fixedDiagnostic(
              'LIMIT_EXCEEDED',
              'error',
              'estimate',
              'The estimate exceeds a documented output bound.',
            ),
          );
        } else {
          return await finish(
            buildErrorEnvelope({
              identity: identity(),
              category: 'internal',
              scope: relationships.manifest,
              sources,
              diagnostics: [
                fixedDiagnostic(
                  'INTERNAL_ERROR',
                  'error',
                  'estimate',
                  'Estimation input was inconsistent.',
                ),
              ],
            }),
            'failure',
          );
        }
      }
      if (estimate !== null && dispositions.scopeNarrowed) {
        diagnostics.push(
          fixedDiagnostic(
            'PARTIAL_ANALYSIS',
            'info',
            'estimate',
            'The estimate covers only the caller-selected contracts; the whole physical scope was not priced.',
          ),
        );
      }
      if (
        estimate === null &&
        projection !== null &&
        completeness.requiredAnalysisComplete &&
        !diagnostics.some((item) => item.code === 'LIMIT_EXCEEDED' && item.phase === 'estimate')
      ) {
        diagnostics.push(
          fixedDiagnostic(
            'PARTIAL_ANALYSIS',
            'warning',
            'estimate',
            'No estimate was produced because a required measurement is unavailable.',
          ),
        );
      }
    }

    if (!completeness.requiredAnalysisComplete && !hasWarningOrError(diagnostics)) {
      diagnostics.push(
        fixedDiagnostic(
          'PARTIAL_ANALYSIS',
          'warning',
          'semantics',
          'Required analysis is incomplete.',
        ),
      );
    }

    const envelope = buildAnalysisEnvelope({
      identity: identity(),
      sources,
      scope: relationships.manifest,
      analysis,
      estimate,
      diagnostics,
      limitations,
    });
    return await finish(envelope, envelope.status === 'complete' ? 'complete' : 'partial');
  } catch (error: unknown) {
    const failure = failureFor(error, phase, signal);
    return await finish(
      buildErrorEnvelope({
        identity: identity(),
        category: failure.category,
        scope: failure.interrupted ? undefined : manifestForErrors,
        diagnostics: failure.diagnostics,
      }),
      failure.interrupted ? 'interrupted' : 'failure',
    );
  } finally {
    try {
      await session?.close();
    } catch {
      // Closing is best effort; the outcome has already been decided.
    }
  }
}
