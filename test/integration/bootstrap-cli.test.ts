import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const distPath = resolve(repositoryRoot, 'dist');
const binPath = resolve(distPath, 'bin.js');

/** Relative path with `/` separators, so expectations hold on Windows too. */
function portableRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/');
}

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
      // Shared production chunk holding the analysis pipeline, estimation engine, reporting and
      // domain code; it is imported by both index.js (library) and bin.js (CLI handler).
      'analyze.js',
      'analyze.js.map',
      'bin.js',
      'bin.js.map',
      'index.d.ts',
      'index.js',
      // Shared production chunk (parser protocol, version policy and domain schemas) imported by
      // analyze.js and parser/worker.js; it replaces the former canonical.js and version.js chunks.
      'parser',
      'version-policy.js',
      'version-policy.js.map',
    ];

    expect(entries).toEqual(expectedEntries);

    const parserEntries = (await readdir(resolve(distPath, 'parser'))).sort();
    expect(parserEntries).toEqual(['worker.js', 'worker.js.map']);

    const declaration = await readFile(resolve(distPath, 'index.d.ts'), 'utf8');
    expect(declaration).toContain('TOOL_VERSION');
    expect(declaration).not.toMatch(/from\s+['"][^'"]+\.ts['"]/);
    expect(declaration).toContain('estimateEffort');
    expect(declaration).toContain('analyzeProject');
    expect(declaration).toContain('AnalyzeRequest');
    expect(declaration).toContain('selectModel');
    expect(declaration).toContain('EstimationError');
    expect(declaration).toContain('serializeJson');
    expect(declaration).toContain('formatTerminal');
    expect(declaration).toContain('formatMarkdown');
    expect(declaration).toContain('TerminalFormatOptions');
  });

  it('emits no .ts or src/ import specifiers in runtime JavaScript', async () => {
    const files = ['analyze.js', 'bin.js', 'index.js', 'version-policy.js', 'parser/worker.js'];
    for (const name of files) {
      const text = await readFile(resolve(distPath, name), 'utf8');
      for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1] ?? '';
        expect(specifier, `${name}: ${specifier}`).not.toMatch(/\.ts$|^src\/|\/src\//);
      }
    }
    const worker = await readFile(resolve(distPath, 'parser', 'worker.js'), 'utf8');
    expect(worker).toContain('"../version-policy.js"');
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

describe('estimation module purity', () => {
  const estimationRoot = resolve(repositoryRoot, 'src', 'estimation');
  const allowedDomain = ['canonical', 'schemas', 'types', 'versions'].map((name) =>
    resolve(repositoryRoot, 'src', 'domain', `${name}.ts`),
  );
  const allowedExternal = new Set(['zod', 'node:crypto']);
  const forbiddenSource =
    /\b(?:require\s*\(|import\s*\(|Date\.now|new\s+Date|performance\.|setTimeout|setInterval|fetch\s*\(|process\.|XMLHttpRequest|globalThis)/;

  async function listTypeScript(directory: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) found.push(...(await listTypeScript(path)));
      else if (entry.name.endsWith('.ts')) found.push(path);
    }
    return found;
  }

  function specifiers(source: string): string[] {
    const pattern =
      /(?:^|\n)\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
    return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? '');
  }

  it('follows static imports transitively inside the permitted closure', async () => {
    const entries = await listTypeScript(estimationRoot);
    expect(entries.map((path) => portableRelative(estimationRoot, path)).sort()).toEqual([
      'eligibility.ts',
      'estimate.ts',
      'fixed-point.ts',
      'ledger.ts',
      'model.ts',
      'profiles/heuristic-v1.ts',
    ]);
    const seen = new Set<string>();
    const violations: string[] = [];
    const pending = [...entries];
    while (pending.length > 0) {
      const path = pending.pop();
      if (path === undefined || seen.has(path)) continue;
      seen.add(path);
      const source = await readFile(path, 'utf8');
      if (path.startsWith(estimationRoot) && forbiddenSource.test(source)) {
        violations.push(`${relative(repositoryRoot, path)} uses a forbidden construct`);
      }
      for (const specifier of specifiers(source)) {
        const label = `${relative(repositoryRoot, path)} -> ${specifier}`;
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(path), specifier);
          if (!target.startsWith(estimationRoot) && !allowedDomain.includes(target)) {
            violations.push(label);
          }
          pending.push(target);
        } else if (!allowedExternal.has(specifier)) {
          violations.push(label);
        }
      }
    }
    expect(violations).toEqual([]);
    expect(allowedDomain.slice(0, 2).every((required) => seen.has(required))).toBe(true);
  });
});

describe('reporting module purity', () => {
  const reportingRoot = resolve(repositoryRoot, 'src', 'reporting');
  const allowedRoots = [
    reportingRoot,
    ...['canonical', 'schemas', 'types', 'versions'].map((name) =>
      resolve(repositoryRoot, 'src', 'domain', `${name}.ts`),
    ),
  ];
  const allowedExternal = new Set(['zod', 'node:crypto']);
  const forbiddenSource =
    /\b(?:require\s*\(|import\s*\(|Date\.now|new\s+Date|performance\.|setTimeout|setInterval|fetch\s*\(|process\.|XMLHttpRequest|globalThis|node:(?:fs|path|child_process|worker_threads|net|http|https))/;

  async function listTypeScript(directory: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) found.push(...(await listTypeScript(path)));
      else if (entry.name.endsWith('.ts')) found.push(path);
    }
    return found;
  }

  function specifiers(source: string): string[] {
    const pattern =
      /(?:^|\n)\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
    return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? '');
  }

  it('follows static imports transitively inside the permitted closure', async () => {
    const entries = await listTypeScript(reportingRoot);
    expect(entries.map((path) => portableRelative(reportingRoot, path)).sort()).toEqual([
      'display.ts',
      'json.ts',
      'markdown.ts',
      'sanitize.ts',
      'terminal.ts',
    ]);
    const seen = new Set<string>();
    const violations: string[] = [];
    const pending = [...entries];
    while (pending.length > 0) {
      const path = pending.pop();
      if (path === undefined || seen.has(path)) continue;
      seen.add(path);
      const source = await readFile(path, 'utf8');
      if (path.startsWith(reportingRoot) && forbiddenSource.test(source)) {
        violations.push(`${relative(repositoryRoot, path)} uses a forbidden construct`);
      }
      for (const specifier of specifiers(source)) {
        const label = `${relative(repositoryRoot, path)} -> ${specifier}`;
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(path), specifier);
          if (!allowedRoots.some((root) => target === root || target.startsWith(`${root}${sep}`))) {
            violations.push(label);
          }
          pending.push(target);
        } else if (!allowedExternal.has(specifier)) {
          violations.push(label);
        }
      }
    }
    expect(violations).toEqual([]);
    expect(allowedRoots.slice(1, 3).every((required) => seen.has(required))).toBe(true);
  });
});

describe('native estimation API', () => {
  it('runs estimateEffort and selectModel from the emitted library', async () => {
    const cases = JSON.parse(
      await readFile(resolve(repositoryRoot, 'test/fixtures/estimation/worked-cases.json'), 'utf8'),
    ) as readonly { readonly id: string; readonly input: unknown }[];
    const combined = cases.find((item) => item.id === 'combined');
    expect(combined).toBeDefined();
    const libraryUrl = pathToFileURL(resolve(distPath, 'index.js')).href;
    const code = `
      const api = await import(${JSON.stringify(libraryUrl)});
      const input = ${JSON.stringify(combined?.input)};
      const result = api.estimateEffort(input);
      const sum = (field) => result.contributions.reduce((total, row) => total + row[field], 0);
      let rejection = null;
      try { api.estimateEffort({}); } catch (error) {
        rejection = { instance: error instanceof api.EstimationError, reason: error.reason };
      }
      let badSelection = null;
      try { api.selectModel('other'); } catch (error) { badSelection = error.reason; }
      process.stdout.write(JSON.stringify({
        hours: result.auditorHours, days: result.auditorDays, rows: result.contributions.length,
        low: sum('lowMicrohours'), high: sum('highMicrohours'),
        model: api.selectModel(), rejection, badSelection,
      }));
    `;
    const result = runNode(['--input-type=module', '--eval', code]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).toMatchObject({
      hours: { low: 10, high: 34 },
      days: { low: 1.2, high: 4.3 },
      rows: 9,
      low: 10_200_000,
      high: 33_200_000,
      rejection: { instance: true, reason: 'invalid-input' },
      badSelection: 'invalid-input',
    });
    expect(output['model']).toMatchObject({ profile: 'heuristic-v1', modelVersion: '1.0.0' });
  });
});

describe('native reporting API', () => {
  it('imports and calls all serializers from the emitted library without extra output', async () => {
    const fixture = await readFile(
      resolve(repositoryRoot, 'test/fixtures/reports/inspect.json'),
      'utf8',
    );
    const libraryUrl = pathToFileURL(resolve(distPath, 'index.js')).href;
    const code = `
      const api = await import(${JSON.stringify(libraryUrl)});
      const report = JSON.parse(${JSON.stringify(fixture)});
      const json = api.serializeJson(report);
      const terminal = api.formatTerminal(report, { detail: false });
      const markdown = api.formatMarkdown(report);
      process.stdout.write(JSON.stringify({
        jsonStatus: JSON.parse(json).status,
        terminalHeading: terminal.startsWith('Audit report\\n'),
        markdownHeading: markdown.startsWith('# Audit report\\n'),
      }));
    `;
    const result = runNode(['--input-type=module', '--eval', code]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout) as unknown).toEqual({
      jsonStatus: 'complete',
      terminalHeading: true,
      markdownHeading: true,
    });
  });
});
