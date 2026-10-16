export const REPORT_SCHEMA_VERSION = '1.1.0' as const;
export const CONFIG_SCHEMA_VERSION = '1.1.0' as const;
/** Previous config revision, still accepted as an input through its strict legacy shape. */
export const LEGACY_CONFIG_SCHEMA_VERSION = '1.0.0' as const;
export const METRICS_VERSION = '1.0.0' as const;
export const INDICATORS_VERSION = '1.0.0' as const;
export const MODEL_PROFILE = 'heuristic-v1' as const;
/** Default model for new calls. */
export const MODEL_VERSION = '1.1.0' as const;
/** Frozen physical full-review model, selectable explicitly. */
export const LEGACY_MODEL_VERSION = '1.0.0' as const;

/** Readers accept additive v1.x reports; producers validate against the exact current schema. */
export function acceptsReportVersion(version: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  return match !== null && match[1] === '1';
}

export function acceptsKnownModel(profile: string, version: string): boolean {
  return (
    profile === MODEL_PROFILE && (version === MODEL_VERSION || version === LEGACY_MODEL_VERSION)
  );
}
