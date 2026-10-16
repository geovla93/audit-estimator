import { resolveConfig } from '../../src/config/load.ts';
import { DEFAULT_ANALYSIS_LIMITS, DEFAULT_SCOPE_SETTINGS } from '../../src/config/defaults.ts';
import type {
  AnalysisLimits,
  ManualAdjustment,
  ModelProfile,
  Remapping,
  ScopeSettings,
} from '../../src/domain/types.ts';
import type { TrustedConfigDefaults } from '../../src/config/merge.ts';
import { createDiscoveryBudget } from '../../src/discovery/budget.ts';
import { IdentityRegistry } from '../../src/discovery/identity.ts';
import { readProjectMetadata } from '../../src/discovery/metadata.ts';
import type { DiscoveryInput } from '../../src/discovery/scope.ts';
import { resolveSafePath } from '../../src/discovery/safe-path.ts';
import { absoluteProjectPath, safePathContext } from './filesystem.ts';

export function trustedDiscoveryDefaults(
  limits: AnalysisLimits = { ...DEFAULT_ANALYSIS_LIMITS },
): TrustedConfigDefaults {
  const model: ModelProfile = {
    profile: 'heuristic-v1',
    modelVersion: '1.0.0',
    parameters: {
      projectHours: { low: 0.5, high: 1 },
      slocHours: { low: 0.001, high: 0.002 },
      controlPremium: { low: 0.1, high: 0.2 },
      storagePremium: { low: 0.1, high: 0.2 },
      evmPremium: { low: 0.1, high: 0.2 },
      interactionHours: { low: 0.25, high: 0.5 },
      boundaryHours: { low: 0.25, high: 0.5 },
      unknownReserveHigh: 0.5,
      hoursPerDay: 8,
    },
  };
  const scope: ScopeSettings = {
    ...DEFAULT_SCOPE_SETTINGS,
    sourceRoots: [],
    include: [],
    exclude: [],
    thirdPartyRoots: [],
    firstPartyOverrides: [],
  };
  const remappings: readonly Remapping[] = [];
  const manualAdjustments: readonly ManualAdjustment[] = [];
  return {
    scope,
    imports: { remappings },
    solidity: { version: '0.8.28' },
    analysis: { limits },
    model,
    manualAdjustments,
    coverage: { lcovPath: null },
  };
}

export async function makeDiscoveryInput(
  root: string,
  targetPath = '.',
  limits: AnalysisLimits = { ...DEFAULT_ANALYSIS_LIMITS },
  options: { readonly signal?: AbortSignal; readonly identities?: IdentityRegistry } = {},
): Promise<DiscoveryInput> {
  const defaults = trustedDiscoveryDefaults(limits);
  const operational = await resolveConfig({ root, defaults });
  const budget = createDiscoveryBudget(operational.config.analysis.limits, options.signal);
  const initialContext = await safePathContext(root);
  const metadata = await readProjectMetadata({ pathContext: initialContext, budget });
  const resolved = await resolveConfig({
    root,
    defaults,
    metadata: metadata.hints,
  });
  budget.assertLimitsMatch(resolved.config.analysis.limits);
  const targetAbsolute = absoluteProjectPath(root, targetPath);
  const pathContext = await safePathContext(root, {
    target: targetAbsolute,
    followSymlinks: resolved.config.scope.followSymlinks,
  });
  const target = await resolveSafePath({ ...pathContext, budget }, targetAbsolute);
  return {
    root: pathContext.root,
    lexicalRoot: pathContext.lexicalRoot,
    target,
    lexicalTarget: targetAbsolute,
    config: resolved.config,
    metadata,
    budget,
    identities: options.identities ?? new IdentityRegistry(),
  };
}
