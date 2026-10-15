import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const distPath = resolve(repositoryRoot, 'dist');
const binPath = resolve(distPath, 'bin.js');

function runNode(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: false,
    timeout: 5_000,
  });
}

describe('built bootstrap artifacts', () => {
  it('contains only the production ESM entries, map, and library declaration', async () => {
    const entries = (await readdir(distPath)).sort();

    const expectedEntries = [
      'bin.js',
      'bin.js.map',
      'index.d.ts',
      'index.js',
      'parser',
      'version.js',
      'version.js.map',
      'versions.js',
      'versions.js.map',
    ];

    expect(entries).toEqual(expectedEntries);

    const parserEntries = (await readdir(resolve(distPath, 'parser'))).sort();
    expect(parserEntries).toEqual(['worker.js', 'worker.js.map']);

    const declaration = await readFile(resolve(distPath, 'index.d.ts'), 'utf8');
    expect(declaration).toContain('TOOL_VERSION');
    expect(declaration).not.toMatch(/from\s+['"][^'"]+\.ts['"]/);
  });

  it('preserves the executable shebang and runs help and version through Node', () => {
    const binSourcePromise = readFile(binPath, 'utf8');
    return binSourcePromise.then((binSource) => {
      expect(binSource.startsWith('#!/usr/bin/env node\n')).toBe(true);

      const help = runNode([binPath, '--help']);
      expect(help.error).toBeUndefined();
      expect(help.status).toBe(0);
      expect(help.stdout).toContain('Usage: audit-estimator [--help|-h] [--version|-v]');
      expect(help.stderr).toBe('');

      const version = runNode([binPath, '--version']);
      expect(version.error).toBeUndefined();
      expect(version.status).toBe(0);
      expect(version.stdout).toBe('audit-estimator 0.1.0\n');
      expect(version.stderr).toBe('');
    });
  });

  it('loads the emitted library as native Node ESM', () => {
    const libraryUrl = pathToFileURL(resolve(distPath, 'index.js')).href;
    const importCode = `import(${JSON.stringify(libraryUrl)}).then(({ TOOL_VERSION }) => process.stdout.write(TOOL_VERSION));`;
    const result = runNode(['--input-type=module', '--eval', importCode]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('0.1.0');
    expect(result.stderr).toBe('');
  });
});
