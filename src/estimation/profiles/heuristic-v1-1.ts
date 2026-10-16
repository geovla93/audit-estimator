import type { ModelProfile } from '../../domain/types.ts';
import { heuristicV1Profile } from './heuristic-v1.ts';

/**
 * Starter assumptions for `heuristic-v1@1.1.0`. The numeric parameters equal those of 1.0.0; the
 * version changes which declarations require full review, not any coefficient. Every value is an
 * uncalibrated assumption, and a fresh object is returned on each call.
 */
export function heuristicV1_1Profile(): ModelProfile {
  return { ...heuristicV1Profile(), modelVersion: '1.1.0' };
}
