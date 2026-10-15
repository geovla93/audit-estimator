export type VersionAuthority = 'cli' | 'config' | 'metadata' | 'default';
export type VersionSelectionSource =
  | 'cli'
  | 'config'
  | 'metadata'
  | 'inferred'
  | 'latest-no-pragma';
export type PragmaEvidence = 'absent' | 'valid' | 'malformed';

export interface LanguageVersionEvidence {
  readonly installedVersions: readonly string[];
  readonly compatibleVersions: readonly string[];
  readonly pragma: PragmaEvidence;
}

export interface LanguageVersionAuthority {
  readonly source: VersionAuthority;
  readonly version: string;
}

export type LanguageVersionSelection =
  | {
      readonly status: 'selected';
      readonly version: string;
      readonly source: VersionSelectionSource;
      readonly compatibleVersions: readonly string[];
      readonly ignoredHint: 'used' | 'ignored' | 'not-applicable';
      readonly warnings: readonly ('no-version-pragma' | 'metadata-hint-ignored')[];
    }
  | {
      readonly status: 'unsupported';
      readonly version: null;
      readonly source: null;
      readonly compatibleVersions: readonly string[];
      readonly ignoredHint: 'used' | 'ignored' | 'not-applicable';
      readonly warnings: readonly ('no-version-pragma' | 'metadata-hint-ignored')[];
    }
  | {
      readonly status: 'invalid';
      readonly version: null;
      readonly source: null;
      readonly compatibleVersions: readonly string[];
      readonly ignoredHint: 'not-applicable';
      readonly warnings: readonly [];
    };

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly value: string;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, value };
}

function compareVersion(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return 0;
}

function sortedInstalled(versions: readonly string[]): readonly string[] {
  const parsed = versions.map(parseVersion);
  if (parsed.some((version) => version === null)) {
    throw new TypeError('Installed language versions must be exact semantic versions.');
  }
  const exact = parsed as ParsedVersion[];
  const values = exact.toSorted(compareVersion).map((version) => version.value);
  if (new Set(values).size !== values.length) {
    throw new TypeError('Installed language versions must be unique.');
  }
  return values;
}

/** Selects only from worker-validated Slang evidence and never retries a grammar. */
export function selectLanguageVersion(
  evidence: LanguageVersionEvidence,
  authority: LanguageVersionAuthority,
): LanguageVersionSelection {
  const installedVersions = sortedInstalled(evidence.installedVersions);
  const installed = new Set(installedVersions);
  const compatible = sortedInstalled(evidence.compatibleVersions);
  if (compatible.some((version) => !installed.has(version))) {
    throw new TypeError('Compatible language versions must be installed.');
  }

  if (evidence.pragma === 'malformed') {
    return {
      status: 'invalid',
      version: null,
      source: null,
      compatibleVersions: compatible,
      ignoredHint: 'not-applicable',
      warnings: [],
    };
  }

  const hasVersionPragma = evidence.pragma === 'valid';
  if (authority.source === 'cli' || authority.source === 'config') {
    const exact = parseVersion(authority.version);
    const isSupported = exact !== null && installed.has(exact.value);
    const isCompatible = !hasVersionPragma || compatible.includes(authority.version);
    if (!isSupported || !isCompatible) {
      return {
        status: 'unsupported',
        version: null,
        source: null,
        compatibleVersions: compatible,
        ignoredHint: 'not-applicable',
        warnings: hasVersionPragma ? [] : ['no-version-pragma'],
      };
    }
    return {
      status: 'selected',
      version: authority.version,
      source: authority.source,
      compatibleVersions: compatible,
      ignoredHint: 'not-applicable',
      warnings: hasVersionPragma ? [] : ['no-version-pragma'],
    };
  }

  if (authority.source === 'metadata') {
    const hint = parseVersion(authority.version);
    if (
      hint !== null &&
      installed.has(hint.value) &&
      (!hasVersionPragma || compatible.includes(hint.value))
    ) {
      return {
        status: 'selected',
        version: hint.value,
        source: 'metadata',
        compatibleVersions: compatible,
        ignoredHint: 'used',
        warnings: hasVersionPragma ? [] : ['no-version-pragma'],
      };
    }
    const inferred = compatible.at(-1);
    if (inferred === undefined) {
      return {
        status: 'unsupported',
        version: null,
        source: null,
        compatibleVersions: compatible,
        ignoredHint: 'ignored',
        warnings: [
          'metadata-hint-ignored',
          ...(hasVersionPragma ? [] : (['no-version-pragma'] as const)),
        ],
      };
    }
    return {
      status: 'selected',
      version: inferred,
      source: hasVersionPragma ? 'inferred' : 'latest-no-pragma',
      compatibleVersions: compatible,
      ignoredHint: 'ignored',
      warnings: [
        'metadata-hint-ignored',
        ...(hasVersionPragma ? [] : (['no-version-pragma'] as const)),
      ],
    };
  }

  const inferred = compatible.at(-1);
  if (inferred === undefined) {
    return {
      status: 'unsupported',
      version: null,
      source: null,
      compatibleVersions: compatible,
      ignoredHint: 'not-applicable',
      warnings: hasVersionPragma ? [] : ['no-version-pragma'],
    };
  }
  return {
    status: 'selected',
    version: inferred,
    source: hasVersionPragma ? 'inferred' : 'latest-no-pragma',
    compatibleVersions: compatible,
    ignoredHint: 'not-applicable',
    warnings: hasVersionPragma ? [] : ['no-version-pragma'],
  };
}
