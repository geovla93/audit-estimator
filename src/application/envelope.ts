import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  INDICATORS_VERSION,
  METRICS_VERSION,
  MODEL_VERSION,
  REPORT_SCHEMA_VERSION,
} from '../domain/versions.ts';
import { canonicalJson } from '../domain/canonical.ts';
import type {
  Analysis,
  Diagnostic,
  EstimateResult,
  ReportEnvelope,
  ScopeManifest,
} from '../domain/types.ts';
import { TOOL_VERSION } from '../version.ts';
import { analysisFingerprint } from './fingerprints.ts';

const require = createRequire(import.meta.url);
const MAX_LABEL = 128;
const MAX_TEXT = 512;
const MAX_LIMITATIONS = 1000;
const FALLBACK_PARSER_LABEL = 'slang@unavailable';

let cachedParserLabel: Promise<string> | undefined;

/**
 * Label used before any file is parsed. It is derived from the same trusted package metadata the
 * parser worker reports (`@nomicfoundation/slang` package version) without loading the parser.
 */
export function trustedParserLabel(): Promise<string> {
  cachedParserLabel ??= (async (): Promise<string> => {
    try {
      const entry = require.resolve('@nomicfoundation/slang');
      const packagePath = fileURLToPath(new URL('../package.json', pathToFileURL(entry)));
      const value: unknown = JSON.parse(await readFile(packagePath, 'utf8')) as unknown;
      if (
        typeof value === 'object' &&
        value !== null &&
        'version' in value &&
        typeof value.version === 'string' &&
        value.version.length > 0 &&
        `slang@${value.version}`.length <= MAX_LABEL
      ) {
        return `slang@${value.version}`;
      }
    } catch {
      // Fall through to the fixed label; an error envelope must still be producible.
    }
    return FALLBACK_PARSER_LABEL;
  })();
  return cachedParserLabel;
}

/** Parser label from the version record the worker attached to parsed files. */
export function parserLabelFromVersion(parserVersion: string): string {
  const label = `slang@${parserVersion}`;
  return label.length <= MAX_LABEL ? label : FALLBACK_PARSER_LABEL;
}

export interface EnvelopeIdentity {
  readonly command: ReportEnvelope['command'];
  readonly parser: string;
  /** Null until configuration resolves. */
  readonly semanticConfig: string | null;
  /** Effective model version once configuration resolves; the default before that. */
  readonly model?: string | undefined;
}

export type FailureCategory = NonNullable<ReportEnvelope['failureCategory']>;

export const EMPTY_SCOPE_MANIFEST: ScopeManifest = {
  entries: [],
  scopedFileIds: [],
  contextFileIds: [],
  excludedFileIds: [],
};

function versionsFor(parser: string, model: string | undefined): ReportEnvelope['versions'] {
  return {
    parser,
    metrics: METRICS_VERSION,
    indicators: INDICATORS_VERSION,
    model: model ?? MODEL_VERSION,
  };
}

/** Fixed-message diagnostic constructor; messages never carry paths, source text or stacks. */
export function fixedDiagnostic(
  code: Diagnostic['code'],
  severity: Diagnostic['severity'],
  phase: Diagnostic['phase'],
  message: string,
  details?: Diagnostic['details'],
): Diagnostic {
  return {
    code,
    severity,
    phase,
    message,
    ...(details === undefined || details.length === 0 ? {} : { details }),
  };
}

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

/** Removes exact duplicates while preserving the first occurrence order. */
export function dedupeDiagnostics(items: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const result: Diagnostic[] = [];
  for (const item of items) {
    const key = canonicalJson(JSON.parse(JSON.stringify(item)) as unknown);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** Sorted, de-duplicated, length-bounded limitation strings. */
export function boundLimitations(items: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const item of items) {
    const text = item.length > MAX_TEXT ? item.slice(0, MAX_TEXT) : item;
    if (text.length > 0) unique.add(text);
  }
  return [...unique].sort(compareCodePoints).slice(0, MAX_LIMITATIONS);
}

export interface ErrorEnvelopeInput {
  readonly identity: EnvelopeIdentity;
  readonly category: FailureCategory;
  readonly diagnostics: readonly Diagnostic[];
  readonly scope?: ScopeManifest | undefined;
  readonly limitations?: readonly string[] | undefined;
  readonly sources?: string | null | undefined;
}

/** Error envelope: no analysis and no estimate are ever fabricated. */
export function buildErrorEnvelope(input: ErrorEnvelopeInput): ReportEnvelope {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    toolVersion: TOOL_VERSION,
    command: input.identity.command,
    status: 'error',
    failureCategory: input.category,
    versions: versionsFor(input.identity.parser, input.identity.model),
    fingerprints: {
      sources: input.sources ?? null,
      semanticConfig: input.identity.semanticConfig,
      analysis: null,
    },
    scope: input.scope ?? EMPTY_SCOPE_MANIFEST,
    analysis: null,
    estimate: null,
    fullScopeEstimate: null,
    diagnostics: dedupeDiagnostics(input.diagnostics),
    limitations: boundLimitations(input.limitations ?? []),
  };
}

export interface AnalysisEnvelopeInput {
  readonly identity: EnvelopeIdentity;
  readonly sources: string;
  readonly scope: ScopeManifest;
  readonly analysis: Analysis;
  /** Engine output, or null when no estimate was produced or the command is `inspect`. */
  readonly estimate: EstimateResult | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly limitations: readonly string[];
}

/**
 * Success or partial envelope. `complete` requires complete required analysis and, for estimating
 * commands, an engine result with full coverage. A full estimate is mirrored into
 * `fullScopeEstimate`; a subset or missing estimate never populates it.
 */
export function buildAnalysisEnvelope(input: AnalysisEnvelopeInput): ReportEnvelope {
  const requiredComplete = input.analysis.completeness.requiredAnalysisComplete;
  const estimating = input.identity.command !== 'inspect';
  const full = input.estimate !== null && input.estimate.coverage === 'full';
  const complete = requiredComplete && (!estimating || full);
  const versions = versionsFor(input.identity.parser, input.identity.model);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    toolVersion: TOOL_VERSION,
    command: input.identity.command,
    status: complete ? 'complete' : 'partial',
    failureCategory: null,
    versions,
    fingerprints: {
      sources: input.sources,
      semanticConfig: input.identity.semanticConfig,
      analysis: analysisFingerprint(input.analysis, { tool: TOOL_VERSION, ...versions }),
    },
    scope: input.scope,
    analysis: input.analysis,
    estimate: estimating ? input.estimate : null,
    fullScopeEstimate: complete && estimating ? input.estimate : null,
    diagnostics: dedupeDiagnostics(input.diagnostics),
    limitations: boundLimitations(input.limitations),
  };
}
