import { INDICATORS_VERSION } from '../domain/versions.ts';
import type { Indicator } from '../domain/types.ts';

/**
 * Frozen indicator rule catalog for `INDICATORS_VERSION` 1.0.0. See docs/indicators.md.
 * Rules describe syntactic or name-based patterns that deserve review attention. They never
 * state severity, vulnerability, protection or intent.
 */

export type IndicatorCategory =
  | 'control'
  | 'storage'
  | 'evm'
  | 'interaction'
  | 'boundary'
  | 'uncertainty';
export type IndicatorEvidenceKind = Indicator['evidenceKind'];
export type IndicatorConfidence = Indicator['confidence'];

export type AutomaticRuleKey =
  | 'assembly'
  | 'loops'
  | 'complex-storage-syntax'
  | 'builtin-low-level'
  | 'unresolved-import'
  | 'upgrade-name-candidate'
  | 'privilege-name-candidate'
  | 'external-boundary-candidate';

/** Per-file uncertainty row produced when evidence is missing; it is not an occurrence rule. */
export type UncertaintyRuleKey = 'file-evidence-incomplete';
export type RuleKey = AutomaticRuleKey | UncertaintyRuleKey;

export type OwnerKind = 'callable' | 'contract' | 'file' | 'project';
export type ScopeLabel = 'scoped' | 'context';

export interface RuleDefinition {
  readonly key: RuleKey;
  readonly category: IndicatorCategory;
  readonly evidenceKind: IndicatorEvidenceKind;
  readonly confidence: IndicatorConfidence;
  readonly requiresAssessment: boolean;
  /** Fixed summary stem. The scope and owner labels are appended by `summaryFor`. */
  readonly summaryStem: string;
  /** Fixed inference-boundary limitation, present on every row of the rule. */
  readonly limitation: string;
}

export const INDICATOR_RULE_VERSION: string = INDICATORS_VERSION;
export const MAX_INDICATOR_ROWS = 100_000;
export const MAX_INDICATOR_EVIDENCE = 10_000;
export const MAX_INDICATOR_LIMITATIONS = 1_000;
export const MAX_INDICATOR_TEXT = 512;

/** Case-sensitive exact names for the name-based rules. */
export const UPGRADE_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  'initialize',
  'reinitialize',
  'upgradeTo',
  'upgradeToAndCall',
]);
export const PRIVILEGE_MODIFIER_NAMES: ReadonlySet<string> = new Set([
  'onlyOwner',
  'onlyRole',
  'requiresAuth',
]);

const RULES: readonly RuleDefinition[] = [
  {
    key: 'assembly',
    category: 'evm',
    evidenceKind: 'measured',
    confidence: 'high',
    requiresAssessment: false,
    summaryStem: 'Inline assembly syntax is present',
    limitation:
      'Counts parsed assembly blocks only. A memory-safe annotation is not evidence of safety, and the block contents are not assessed.',
  },
  {
    key: 'loops',
    category: 'control',
    evidenceKind: 'measured',
    confidence: 'high',
    requiresAssessment: false,
    summaryStem: 'Loop syntax is present',
    limitation:
      'Counts parsed for, while and do-while statements and Yul for loops. Iteration bounds and gas behavior are not assessed.',
  },
  {
    key: 'complex-storage-syntax',
    category: 'storage',
    evidenceKind: 'measured',
    confidence: 'high',
    requiresAssessment: false,
    summaryStem: 'Mutable mapping or array state variable syntax is present',
    limitation:
      'Covers syntactic mapping and array declarations only. User-defined and unknown mutable storage types are unresolved and are not classified.',
  },
  {
    key: 'builtin-low-level',
    category: 'evm',
    evidenceKind: 'measured',
    confidence: 'high',
    requiresAssessment: false,
    summaryStem: 'A semantically confirmed built-in low-level call is present',
    limitation:
      'Lists confirmed call sites only and is not exhaustive when semantic evidence is unavailable. Rejected and unknown candidates are not listed. Call safety is not assessed.',
  },
  {
    key: 'unresolved-import',
    category: 'uncertainty',
    evidenceKind: 'measured',
    confidence: 'high',
    requiresAssessment: false,
    summaryStem: 'An import could not be resolved to a single file',
    limitation:
      'Measures failed or ambiguous import resolution only. It says nothing about dependency risk, and semantic analysis of affected files may be incomplete.',
  },
  {
    key: 'upgrade-name-candidate',
    category: 'boundary',
    evidenceKind: 'heuristic',
    confidence: 'low',
    requiresAssessment: true,
    summaryStem: 'A function name is commonly used in upgradeable or initializer patterns',
    limitation:
      'Exact-name match only. Same-contract inheritance or delegatecall evidence is supplementary and does not establish proxy semantics, initializer correctness or upgrade authorization.',
  },
  {
    key: 'privilege-name-candidate',
    category: 'control',
    evidenceKind: 'heuristic',
    confidence: 'low',
    requiresAssessment: true,
    summaryStem: 'A modifier name is commonly used for access restriction',
    limitation:
      'Exact final-name match only. Modifier binding, its effect and effective access control are not established.',
  },
  {
    key: 'external-boundary-candidate',
    category: 'boundary',
    evidenceKind: 'heuristic',
    confidence: 'medium',
    requiresAssessment: true,
    summaryStem: 'A member call may cross into another contract',
    limitation:
      'Based on a unique static symbol with dynamic dispatch on an identifier or expression receiver. The runtime target address, implementation and trust are unproven.',
  },
  {
    key: 'file-evidence-incomplete',
    category: 'uncertainty',
    evidenceKind: 'human',
    confidence: 'not-assessed',
    requiresAssessment: true,
    summaryStem: 'Evidence for a file is incomplete',
    limitation:
      'Missing evidence is not measured absence. Occurrence rows for this file are not exhaustive and need human assessment.',
  },
];

const RULES_BY_KEY: ReadonlyMap<RuleKey, RuleDefinition> = new Map(
  RULES.map((rule) => [rule.key, rule]),
);

export const INDICATOR_RULES: readonly RuleDefinition[] = Object.freeze(
  RULES.map((rule) => Object.freeze({ ...rule })),
);

export function ruleDefinition(key: RuleKey): RuleDefinition {
  const found = RULES_BY_KEY.get(key);
  if (found === undefined) throw new TypeError('Unknown indicator rule.');
  return found;
}

export function summaryFor(rule: RuleDefinition, owner: OwnerKind, scope: ScopeLabel): string {
  if (owner === 'project') return `${rule.summaryStem} for the project.`;
  if (owner === 'file') return `${rule.summaryStem} in a ${scope} file.`;
  return `${rule.summaryStem} in a ${owner} of a ${scope} file.`;
}

export function scopeLimitation(scope: ScopeLabel): string {
  return scope === 'context'
    ? 'Context file: this observation does not change the scoped review size.'
    : 'Scoped file: this observation relates to files selected for review.';
}

/** Unicode code point order, independent of UTF-16 surrogate ordering. */
export function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (scalar) => scalar.codePointAt(0) ?? 0);
  const b = Array.from(right, (scalar) => scalar.codePointAt(0) ?? 0);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const l = a[index] ?? 0;
    const r = b[index] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}
