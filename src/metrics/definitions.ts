import type { ParserTokenKind } from '../parser/protocol.ts';

/** Unavailable-reason constants for METRICS_VERSION 1.0.0. See docs/metrics.md. */
export const REASON_PARSE_LANGUAGE_UNSUPPORTED = 'parse-language-unsupported' as const;
export const REASON_PARSE_INVALID = 'parse-invalid' as const;
export const REASON_PARSE_LIMIT_EXCEEDED = 'parse-limit-exceeded' as const;
export const REASON_PARSE_INTERNAL_ERROR = 'parse-internal-error' as const;
export const REASON_NO_BODY = 'no-body' as const;
export const REASON_NOT_APPLICABLE = 'not-applicable' as const;
export const REASON_VISIBILITY_MISSING = 'visibility-missing' as const;
export const REASON_EFFECTIVE_RULE_UNCONFIRMED = 'effective-rule-unconfirmed' as const;
export const REASON_SCOPED_FILE_UNAVAILABLE = 'scoped-file-unavailable' as const;

/** Token kinds that never contribute to source lines. */
export const TRIVIA_TOKEN_KINDS: ReadonlySet<ParserTokenKind> = new Set<ParserTokenKind>([
  'whitespace',
  'comment',
  'natspec',
]);

/** Decision kinds counted in callable bodies (`control-kind` attribute values). */
export const DECISION_CONTROL_KINDS: ReadonlySet<string> = new Set<string>([
  'if',
  'ternary',
  'for',
  'while',
  'do-while',
  'catch',
  'and',
  'or',
]);

/** Subset of decision kinds that are loops. */
export const LOOP_CONTROL_KINDS: ReadonlySet<string> = new Set<string>([
  'for',
  'while',
  'do-while',
]);

function parseVersion(version: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) throw new TypeError('Expected a major.minor.patch Solidity version.');
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compares two `major.minor.patch` versions numerically. */
export function compareSolidityVersion(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < 3; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}
