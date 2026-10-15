import type { ModelProfile } from '../../domain/types.ts';

/**
 * Starter assumptions for `heuristic-v1@1.0.0`. Every value is an uncalibrated assumption.
 * A fresh object is returned on each call so callers cannot mutate the static profile.
 */
export function heuristicV1Profile(): ModelProfile {
  return {
    profile: 'heuristic-v1',
    modelVersion: '1.0.0',
    parameters: {
      projectHours: { low: 4, high: 12 },
      slocHours: { low: 0.04, high: 0.12 },
      controlPremium: { low: 0.1, high: 0.25 },
      storagePremium: { low: 0.05, high: 0.15 },
      evmPremium: { low: 0.2, high: 0.5 },
      interactionHours: { low: 0.25, high: 0.75 },
      boundaryHours: { low: 0.5, high: 2 },
      unknownReserveHigh: 0.25,
      hoursPerDay: 8,
    },
  };
}
