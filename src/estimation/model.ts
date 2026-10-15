import { MODEL_PROFILE, MODEL_VERSION } from '../domain/versions.ts';
import type { ModelProfile } from '../domain/types.ts';
import { heuristicV1Profile } from './profiles/heuristic-v1.ts';

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

/** Returns a fresh copy of the static starter profile; no config loading or I/O. */
export function selectModel(profile?: string, modelVersion?: string): ModelProfile {
  if (profile !== undefined && profile !== MODEL_PROFILE) {
    throw new EstimationError('invalid-input');
  }
  if (modelVersion !== undefined && modelVersion !== MODEL_VERSION) {
    throw new EstimationError('invalid-input');
  }
  return heuristicV1Profile();
}
