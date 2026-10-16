import { LEGACY_MODEL_VERSION, MODEL_PROFILE, MODEL_VERSION } from '../domain/versions.ts';
import type { ModelProfile } from '../domain/types.ts';
import { heuristicV1Profile } from './profiles/heuristic-v1.ts';
import { heuristicV1_1Profile } from './profiles/heuristic-v1-1.ts';

export type EstimationErrorReason =
  | 'invalid-input'
  | 'inconsistent-measurements'
  | 'invalid-total'
  | 'output-bound'
  | 'unsafe-arithmetic';

const MESSAGES: Readonly<Record<EstimationErrorReason, string>> = {
  'invalid-input': 'Estimation input or model selection is invalid',
  'inconsistent-measurements': 'Measured facts contradict each other',
  'invalid-total': 'Estimate totals are negative or reversed',
  'output-bound': 'Estimate exceeds a documented output bound',
  'unsafe-arithmetic': 'Estimate arithmetic exceeds the safe integer range',
};

/** Typed engine rejection. Messages are fixed and never interpolate caller data. */
export class EstimationError extends Error {
  readonly reason: EstimationErrorReason;

  constructor(reason: EstimationErrorReason) {
    super(MESSAGES[reason]);
    this.name = 'EstimationError';
    this.reason = reason;
  }
}

/**
 * Returns a fresh copy of a static starter profile; no config loading or I/O. An omitted version
 * selects the current default (1.1.0); the frozen 1.0.0 profile stays selectable explicitly.
 */
export function selectModel(profile?: string, modelVersion?: string): ModelProfile {
  if (profile !== undefined && profile !== MODEL_PROFILE) {
    throw new EstimationError('invalid-input');
  }
  if (modelVersion === undefined || modelVersion === MODEL_VERSION) return heuristicV1_1Profile();
  if (modelVersion === LEGACY_MODEL_VERSION) return heuristicV1Profile();
  throw new EstimationError('invalid-input');
}
