import type { Diagnostic, DiagnosticCode } from '../domain/types.ts';

export const EXIT_CODES = {
  complete: 0,
  internal: 1,
  usageOrConfig: 2,
  target: 3,
  incomplete: 4,
  output: 5,
  interrupted: 130,
} as const;

export interface ExitPolicyInput {
  readonly outcome: 'complete' | 'partial' | 'failure' | 'interrupted';
  readonly diagnostics: readonly Diagnostic[];
  readonly strict?: boolean | undefined;
  readonly allowPartial?: boolean | undefined;
}

const CONFIG_CODES: ReadonlySet<DiagnosticCode> = new Set(['CONFIG_INVALID']);
const TARGET_CODES: ReadonlySet<DiagnosticCode> = new Set([
  'TARGET_UNREADABLE',
  'EMPTY_SCOPE',
  'PATH_BLOCKED',
]);
const INCOMPLETE_CODES: ReadonlySet<DiagnosticCode> = new Set([
  'SOURCE_CHANGED',
  'LIMIT_EXCEEDED',
  'LANGUAGE_UNSUPPORTED',
  'PARSE_INVALID',
  'IMPORT_UNRESOLVED',
  'SEMANTICS_UNAVAILABLE',
  'OWNERSHIP_UNKNOWN',
  'PARTIAL_ANALYSIS',
]);

export function exitCodeFor(input: ExitPolicyInput): number {
  if (input.outcome === 'interrupted') return EXIT_CODES.interrupted;
  if (input.outcome === 'partial') return EXIT_CODES.incomplete;
  if (input.outcome === 'complete') {
    return input.strict === true && input.diagnostics.some((item) => item.severity === 'warning')
      ? EXIT_CODES.incomplete
      : EXIT_CODES.complete;
  }

  if (input.diagnostics.some((item) => item.code === 'INTERNAL_ERROR')) return EXIT_CODES.internal;
  if (input.diagnostics.some((item) => item.code === 'OUTPUT_FAILED')) return EXIT_CODES.output;
  if (input.diagnostics.some((item) => CONFIG_CODES.has(item.code)))
    return EXIT_CODES.usageOrConfig;
  if (input.diagnostics.some((item) => TARGET_CODES.has(item.code))) return EXIT_CODES.target;
  if (input.diagnostics.some((item) => INCOMPLETE_CODES.has(item.code)))
    return EXIT_CODES.incomplete;
  if (input.diagnostics.some((item) => input.strict === true && item.severity === 'warning')) {
    return EXIT_CODES.incomplete;
  }
  return EXIT_CODES.internal;
}
