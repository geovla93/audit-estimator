import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function read(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
}

function usesLines(text: string): readonly string[] {
  return text.split('\n').filter((line) => /^\s*-?\s*uses:/.test(line));
}

describe('release workflow', () => {
  it('is manually dispatched only', async () => {
    const release = await read('.github/workflows/release.yml');
    expect(release).toContain('workflow_dispatch:');
    for (const forbidden of ['pull_request', 'push:', 'schedule:', 'pull_request_target']) {
      expect(release).not.toContain(forbidden);
    }
  });

  it('is disabled by default, protected by an environment and uses OIDC without secrets', async () => {
    const release = await read('.github/workflows/release.yml');
    expect(release).toContain("vars.RELEASE_ENABLED == 'true'");
    expect(release).toContain('environment: npm-release');
    expect(release).toContain('id-token: write');
    expect(release).not.toMatch(/secrets\./);
  });

  it('guards the version and package metadata before publishing', async () => {
    const lines = (await read('.github/workflows/release.yml')).split('\n');
    const starts = lines.flatMap((line, index) =>
      line.trim() === '# release-guard:start' ? [index] : [],
    );
    const ends = lines.flatMap((line, index) =>
      line.trim() === '# release-guard:end' ? [index] : [],
    );
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    const start = starts[0] ?? -1;
    const end = ends[0] ?? -1;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(end);
    const guard = lines.slice(start, end).join('\n');
    for (const needle of [
      'RELEASE_VERSION',
      'private',
      'license',
      'repository',
      'src/version.ts',
    ]) {
      expect(guard).toContain(needle);
    }
    const publish = lines.flatMap((line, index) => (line.includes('npm publish') ? [index] : []));
    expect(publish).toHaveLength(1);
    expect(publish[0] ?? -1).toBeGreaterThan(end);
  });

  it('never interpolates the dispatch input into a run script', async () => {
    const release = await read('.github/workflows/release.yml');
    const runLines = release.split('\n').filter((line) => /^\s*-?\s*run:/.test(line));
    expect(runLines.length).toBeGreaterThan(0);
    for (const line of runLines) expect(line).not.toContain('${{ inputs.version }}');
    // The input reaches scripts only through an env entry.
    expect(release).toMatch(/env:\s*\n\s*RELEASE_VERSION: \$\{\{ inputs\.version \}\}/);
  });
});

describe('ci workflow', () => {
  it('is read-only and secretless', async () => {
    const ci = await read('.github/workflows/ci.yml');
    expect(ci).toContain('contents: read');
    for (const forbidden of ['id-token', 'secrets.', 'pull_request_target']) {
      expect(ci).not.toContain(forbidden);
    }
  });
});

describe('workflow action pins', () => {
  it.each(['.github/workflows/ci.yml', '.github/workflows/release.yml'])(
    'pins every action in %s to a full commit SHA',
    async (path) => {
      const lines = usesLines(await read(path));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).toMatch(/@[0-9a-f]{40}\s+#\s+v\S+/);
    },
  );
});

describe('package manifest', () => {
  it('stays private until the owner decisions in docs/releasing.md are made', async () => {
    const manifest = JSON.parse(await read('package.json')) as { readonly private?: unknown };
    expect(manifest.private).toBe(true);
  });
});
