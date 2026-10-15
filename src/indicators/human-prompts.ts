import { fingerprint } from '../domain/canonical.ts';
import type { EvidenceRef, Indicator } from '../domain/types.ts';
import { INDICATOR_RULE_VERSION } from './catalog.ts';
import type { IndicatorCategory } from './catalog.ts';

/**
 * Eight project-level questions that syntax cannot answer. They are optional operator work, never
 * interactive CLI questions, and they are always emitted unanswered. Reasoned manual adjustments
 * stay separate configuration and are never generated from these rows.
 */

export type HumanPromptKey =
  | 'business-invariants'
  | 'protocol-novelty'
  | 'external-trust'
  | 'custom-math-cryptography'
  | 'documentation'
  | 'upgrade-lifecycle'
  | 'cross-chain'
  | 'review-depth';

export interface HumanPromptDefinition {
  readonly key: HumanPromptKey;
  readonly category: IndicatorCategory;
  readonly summary: string;
  readonly limitation: string;
}

const PROMPT_LIMITATION =
  'Human assessment prompt: unanswered, not inferred from source, and never converted into an automatic estimate adjustment.';

export const HUMAN_PROMPTS: readonly HumanPromptDefinition[] = Object.freeze([
  {
    key: 'business-invariants',
    category: 'uncertainty',
    summary: 'Assess how well the intended business invariants are specified and understood.',
    limitation: PROMPT_LIMITATION,
  },
  {
    key: 'protocol-novelty',
    category: 'uncertainty',
    summary: 'Assess whether the protocol design is novel relative to well-known patterns.',
    limitation: PROMPT_LIMITATION,
  },
  {
    key: 'external-trust',
    category: 'boundary',
    summary:
      'Assess trust assumptions about external contracts, oracles, tokens and privileged roles.',
    limitation: PROMPT_LIMITATION,
  },
  {
    key: 'custom-math-cryptography',
    category: 'evm',
    summary:
      'Assess custom arithmetic, fixed-point math, hashing or cryptographic logic that the parser does not classify.',
    limitation: PROMPT_LIMITATION,
  },
  {
    key: 'documentation',
    category: 'uncertainty',
    summary: 'Assess the availability and quality of specifications, documentation and tests.',
    limitation: PROMPT_LIMITATION,
  },
  {
    key: 'upgrade-lifecycle',
    category: 'boundary',
    summary: 'Assess upgradeability, initialization, migration and administrative lifecycle.',
    limitation: PROMPT_LIMITATION,
  },
  {
    key: 'cross-chain',
    category: 'boundary',
    summary: 'Assess cross-chain messaging, bridging and multi-deployment assumptions.',
    limitation: PROMPT_LIMITATION,
  },
  {
    key: 'review-depth',
    category: 'uncertainty',
    summary: 'Assess the review depth the engagement requires beyond syntactic size and shape.',
    limitation: PROMPT_LIMITATION,
  },
] satisfies readonly HumanPromptDefinition[]);

export const HUMAN_PROMPT_COUNT: number = HUMAN_PROMPTS.length;

/** Evidence that may accompany a prompt, keyed by prompt. Prompts stay unanswered either way. */
export type PromptEvidence = Readonly<Partial<Record<HumanPromptKey, readonly EvidenceRef[]>>>;

export function promptIndicatorId(key: HumanPromptKey): string {
  return `indicator:prompt:${fingerprint(['prompt', key, 'project'])}`;
}

export function buildHumanPrompts(
  evidence: PromptEvidence = {},
  extraLimitations: Readonly<Partial<Record<HumanPromptKey, readonly string[]>>> = {},
): readonly Indicator[] {
  return HUMAN_PROMPTS.map((prompt) => ({
    id: promptIndicatorId(prompt.key),
    ruleVersion: INDICATOR_RULE_VERSION,
    category: prompt.category,
    evidenceKind: 'human' as const,
    confidence: 'not-assessed' as const,
    summary: prompt.summary,
    evidence: [...(evidence[prompt.key] ?? [])],
    limitations: [prompt.limitation, ...(extraLimitations[prompt.key] ?? [])],
    requiresAssessment: true,
  }));
}
