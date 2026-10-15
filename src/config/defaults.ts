import type { AnalysisLimits, ScopeSettings } from '../domain/types.ts';

export const DEFAULT_CONFIG_FILE: string = 'audit-estimator.config.json';
export const CONFIG_MAX_BYTES: number = 256 * 1024;

export class ConfigError extends Error {
  public readonly code = 'CONFIG_INVALID' as const;

  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ConfigError';
  }
}

export class ProjectRootError extends Error {
  public readonly code = 'TARGET_UNREADABLE' as const;

  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProjectRootError';
  }
}

export const DEFAULT_ANALYSIS_LIMITS: AnalysisLimits = {
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalSourceBytes: 64 * 1024 * 1024,
  maxFiles: 2_000,
  maxFsEntries: 100_000,
  maxDirectoryDepth: 64,
  maxImports: 20_000,
  maxGraphEdges: 100_000,
  maxAstNodesPerFile: 200_000,
  maxAstNodesTotal: 2_000_000,
  maxPatternsPerList: 64,
  maxPatternLength: 512,
  maxGlobStates: 10_000_000,
  maxMetadataBytes: 256 * 1024,
  maxLcovBytes: 4 * 1024 * 1024,
  parseTimeoutMs: 2_000,
  maxSemanticFiles: 128,
  maxSemanticBytes: 8 * 1024 * 1024,
  semanticTimeoutMs: 10_000,
  analysisTimeoutMs: 120_000,
};

export const DEFAULT_SCOPE_SETTINGS: ScopeSettings = {
  sourceRoots: [],
  include: [],
  exclude: [],
  defaultExcludes: true,
  thirdPartyRoots: [],
  firstPartyOverrides: [],
  followSymlinks: false,
};

export const DEFAULT_EXCLUSION_PATTERNS: readonly string[] = [
  '**/node_modules/**',
  '**/lib/**',
  '**/vendor/**',
  '**/deps/**',
  '**/out/**',
  '**/artifacts/**',
  '**/cache/**',
  '**/coverage/**',
  '**/dist/**',
  '**/build/**',
  '**/test/**',
  '**/tests/**',
  '**/mocks/**',
  '**/script/**',
  '**/scripts/**',
  '**/generated/**',
  '**/deployments/**',
  '**/*.t.sol',
  '**/*.s.sol',
];
