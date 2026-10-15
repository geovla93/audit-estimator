import { describe, expect, it } from 'vitest';
import { selectLanguageVersion } from '../../src/parser/version-policy.ts';
import type {
  LanguageVersionAuthority,
  LanguageVersionEvidence,
} from '../../src/parser/version-policy.ts';

const installedVersions = ['0.8.9', '0.8.10', '0.7.6'];

function evidence(
  pragma: LanguageVersionEvidence['pragma'],
  compatibleVersions: readonly string[] = installedVersions,
): LanguageVersionEvidence {
  return { installedVersions, compatibleVersions, pragma };
}

function authority(
  source: LanguageVersionAuthority['source'],
  version = '0.8.9',
): LanguageVersionAuthority {
  return { source, version };
}

describe('language version policy', () => {
  it('selects a compatible version from each explicit authority', () => {
    for (const source of ['cli', 'config'] as const) {
      expect(selectLanguageVersion(evidence('valid'), authority(source))).toMatchObject({
        status: 'selected',
        version: '0.8.9',
        source,
      });
    }
    expect(selectLanguageVersion(evidence('valid'), authority('metadata'))).toMatchObject({
      status: 'selected',
      version: '0.8.9',
      source: 'metadata',
      ignoredHint: 'used',
    });
  });

  it('sorts exact versions numerically and ignores a populated default version', () => {
    expect(selectLanguageVersion(evidence('valid'), authority('default', '0.7.6'))).toMatchObject({
      status: 'selected',
      version: '0.8.10',
      source: 'inferred',
    });
    expect(selectLanguageVersion(evidence('absent'), authority('default', '0.7.6'))).toMatchObject({
      status: 'selected',
      version: '0.8.10',
      source: 'latest-no-pragma',
      warnings: ['no-version-pragma'],
    });
  });

  it('distinguishes a broad pragma from no version pragma evidence', () => {
    const broad = selectLanguageVersion(evidence('valid'), authority('default'));
    const absent = selectLanguageVersion(evidence('absent'), authority('default'));
    expect(broad.compatibleVersions).toEqual(absent.compatibleVersions);
    expect(broad.source).toBe('inferred');
    expect(broad.warnings).toEqual([]);
    expect(absent.source).toBe('latest-no-pragma');
    expect(absent.warnings).toEqual(['no-version-pragma']);
  });

  it('warns about an absent constraint even when an explicit version is selected', () => {
    expect(selectLanguageVersion(evidence('absent'), authority('config', '0.7.6'))).toMatchObject({
      status: 'selected',
      version: '0.7.6',
      source: 'config',
      warnings: ['no-version-pragma'],
    });
    expect(selectLanguageVersion(evidence('absent'), authority('metadata', '0.7.6'))).toMatchObject(
      {
        status: 'selected',
        version: '0.7.6',
        source: 'metadata',
        warnings: ['no-version-pragma'],
      },
    );
  });

  it('rejects explicit conflicts and empty pragma intersections without fallback', () => {
    expect(
      selectLanguageVersion(evidence('valid', ['0.7.6']), authority('config', '0.8.9')),
    ).toMatchObject({ status: 'unsupported', version: null });
    expect(selectLanguageVersion(evidence('valid', []), authority('default'))).toMatchObject({
      status: 'unsupported',
      version: null,
      compatibleVersions: [],
    });
  });

  it('ignores an unsupported metadata hint with a fixed warning and deterministic inference', () => {
    expect(selectLanguageVersion(evidence('valid'), authority('metadata', '0.9.0'))).toMatchObject({
      status: 'selected',
      version: '0.8.10',
      source: 'inferred',
      ignoredHint: 'ignored',
      warnings: ['metadata-hint-ignored'],
    });
  });

  it('keeps malformed pragma evidence invalid instead of treating it as absent', () => {
    expect(selectLanguageVersion(evidence('malformed'), authority('default'))).toMatchObject({
      status: 'invalid',
      version: null,
    });
  });

  it('rejects malformed and duplicate installed grammar values', () => {
    expect(() =>
      selectLanguageVersion(
        { installedVersions: ['0.8'], compatibleVersions: ['0.8'], pragma: 'valid' },
        authority('default'),
      ),
    ).toThrow('exact semantic versions');
    expect(() =>
      selectLanguageVersion(
        { installedVersions: ['0.8.1', '0.8.1'], compatibleVersions: ['0.8.1'], pragma: 'valid' },
        authority('default'),
      ),
    ).toThrow('must be unique');
  });
});
