import { DEFAULT_ANALYSIS_LIMITS, DEFAULT_SCOPE_SETTINGS } from '../config/defaults.ts';
import type { TrustedConfigDefaults } from '../config/merge.ts';
import { selectModel } from '../estimation/model.ts';

/** Fresh production defaults for every call; callers may not share or mutate a prior result. */
export function productionConfigDefaults(): TrustedConfigDefaults {
  return {
    scope: { ...DEFAULT_SCOPE_SETTINGS },
    imports: { remappings: [] },
    // Placeholder only: under the 'default' version authority the parser selection policy ignores
    // this value and picks the highest compatible installed grammar. Any exact version is valid.
    solidity: { version: '0.8.28' },
    analysis: { limits: { ...DEFAULT_ANALYSIS_LIMITS } },
    model: selectModel(),
    manualAdjustments: [],
    coverage: { lcovPath: null },
  };
}
