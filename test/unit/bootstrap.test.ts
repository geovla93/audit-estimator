import packageManifest from '../../package.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { TOOL_VERSION } from '../../src/index.ts';

describe('bootstrap library', () => {
  it('loads the side-effect-free entry and matches the package version', () => {
    expect(TOOL_VERSION).toBe(packageManifest.version);
  });
});
