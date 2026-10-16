import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReportEnvelopeSchema } from '../../src/domain/schemas.ts';
import { binPath, repositoryRoot } from '../helpers/run-cli.ts';

interface NodeRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const COMMAND_TIMEOUT_MS = 240_000;
const ANALYSIS_COMMANDS: readonly string[] = ['estimate', 'inspect', 'explain'];

/** The ten-file production build inventory plus the static package files. */
const BASE_PACKED_FILES: readonly string[] = [
  'CHANGELOG.md',
  'dist/analyze.js',
  'dist/analyze.js.map',
  'dist/bin.js',
  'dist/bin.js.map',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/parser/worker.js',
  'dist/parser/worker.js.map',
  'dist/version-policy.js',
  'dist/version-policy.js.map',
  'package.json',
  'schemas/config-v1.schema.json',
  'schemas/model-v1.schema.json',
  'schemas/result-v1.schema.json',
];

const NON_DECLARATION_TS = /(?<!\.d)\.ts$/;

const FORBIDDEN_PACKED_PATH =
  /^(?:(?:src|test|plans|docs|scripts|coverage|\.github|\.vitest|node_modules)\/|.*\.env(?:\.|$)|.*\.tgz$)/;

function expectedPackedFiles(): readonly string[] {
  const files = [...BASE_PACKED_FILES];
  for (const optional of ['README.md', 'LICENSE']) {
    if (existsSync(join(repositoryRoot, optional))) files.push(optional);
  }
  return files.sort();
}

/**
 * One environment for every child (npm, tsc, both CLIs): npm never inherits pnpm's
 * `npm_config_*` variables and the installed and checkout CLIs see identical environments.
 */
function sandboxEnv(tmp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Put the running Node first so `#!/usr/bin/env node` shims use the same version.
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    npm_config_cache: join(tmp, 'npm-cache'),
    npm_config_userconfig: join(tmp, 'empty-npmrc'), // ignore the user's ~/.npmrc
    npm_config_update_notifier: 'false',
  };
  // Pass through only proxy/registry settings that are already set, so CI behind a proxy still works.
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'npm_config_registry']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (process.platform === 'win32') {
    for (const key of [
      'SystemRoot',
      'WINDIR',
      'ComSpec',
      'PATHEXT',
      'TEMP',
      'TMP',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
    ]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  } else {
    env.HOME = tmp;
  }
  return env;
}

function expectSuccess(run: NodeRun): void {
  expect({ status: run.status, stderr: run.stderr.slice(-4000) }).toMatchObject({ status: 0 });
}

function toRun(result: SpawnSyncReturns<string>): NodeRun {
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function npmCliPath(): string {
  const path = join(
    dirname(process.execPath),
    process.platform === 'win32'
      ? 'node_modules/npm/bin/npm-cli.js'
      : '../lib/node_modules/npm/bin/npm-cli.js',
  );
  if (!existsSync(path)) {
    throw new Error(
      `npm CLI not found at ${path}. The package suite needs the npm bundled with the running Node.`,
    );
  }
  return path;
}

function packedPathsFrom(json: unknown): readonly string[] {
  // npm 11 prints an array; npm 12 prints an object keyed by package name.
  const first: unknown = Array.isArray(json)
    ? json[0]
    : typeof json === 'object' && json !== null
      ? Object.values(json)[0]
      : undefined;
  if (typeof first !== 'object' || first === null || !('files' in first)) {
    throw new Error('Unrecognized npm pack JSON shape.');
  }
  const files: unknown = first.files;
  if (!Array.isArray(files)) throw new Error('npm pack JSON has no files array.');
  return files.map((entry: unknown): string => {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'path' in entry &&
      typeof entry.path === 'string'
    ) {
      return entry.path;
    }
    throw new Error('npm pack JSON file entry has no path.');
  });
}

const DENY_NETWORK_SOURCE = `import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

function deny(name) {
  return function denied() {
    process.stderr.write('NETWORK_ATTEMPT ' + name + '\\n');
    throw new Error('Network access is denied: ' + name);
  };
}

net.connect = deny('net.connect');
net.createConnection = deny('net.createConnection');
tls.connect = deny('tls.connect');
dns.lookup = deny('dns.lookup');
dns.promises.lookup = deny('dns.promises.lookup');
http.request = deny('http.request');
https.request = deny('https.request');
globalThis.fetch = deny('fetch');
// Without this, ESM named imports such as \`import { connect } from 'node:net'\` keep the original bindings.
syncBuiltinESMExports();
`;

describe('packed npm artifact', () => {
  let tmp = '';
  let consumer = '';
  let elsewhere = '';
  let project = '';
  let env: NodeJS.ProcessEnv = {};
  let npmCli = '';
  let installedBin = '';

  function runNode(args: readonly string[], cwd: string, options: SpawnSyncOptions = {}): NodeRun {
    return toRun(
      spawnSync(process.execPath, [...args], {
        ...options,
        cwd,
        env,
        shell: false,
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      }) as SpawnSyncReturns<string>,
    );
  }

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'audit-estimator-pack-'));
    for (const name of ['tarball', 'consumer', 'npm-cache', 'elsewhere', 'harness']) {
      await mkdir(join(tmp, name), { recursive: true });
    }
    await writeFile(join(tmp, 'empty-npmrc'), '');
    consumer = join(tmp, 'consumer');
    elsewhere = join(tmp, 'elsewhere');
    project = join(tmp, 'project');
    env = sandboxEnv(tmp);
    npmCli = npmCliPath();
    installedBin = join(consumer, 'node_modules', 'audit-estimator', 'dist', 'bin.js');
  });

  afterAll(async () => {
    if (tmp !== '') await rm(tmp, { recursive: true, force: true });
  });

  it('packs exactly the allowlisted files', async () => {
    const packed = runNode(
      [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', join(tmp, 'tarball')],
      repositoryRoot,
    );
    expectSuccess(packed);
    const paths = [...packedPathsFrom(JSON.parse(packed.stdout) as unknown)].sort();
    expect(paths).toEqual(expectedPackedFiles());
    for (const path of paths) {
      expect(path).not.toMatch(FORBIDDEN_PACKED_PATH);
      expect(path).not.toMatch(NON_DECLARATION_TS);
    }
  });

  it('installs into a clean consumer without development tools', async () => {
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
    );
    const tarballs = (await readdir(join(tmp, 'tarball'))).filter((name) => name.endsWith('.tgz'));
    expect(tarballs).toHaveLength(1);
    const tarball = join(tmp, 'tarball', tarballs[0] ?? '');
    const install = runNode(
      [
        npmCli,
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        tarball,
      ],
      consumer,
    );
    expectSuccess(install);

    const firstLine = (await readFile(installedBin, 'utf8')).split('\n', 1)[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
    const installed = await readdir(join(consumer, 'node_modules'));
    for (const tool of ['vitest', 'tsdown', 'typescript', 'oxlint']) {
      expect(installed).not.toContain(tool);
    }
  });

  it('imports the library and honours the export map', () => {
    const library = runNode(
      [
        '--input-type=module',
        '-e',
        "import('audit-estimator').then(m => process.stdout.write(JSON.stringify([m.TOOL_VERSION, typeof m.analyzeProject, typeof m.estimateEffort])))",
      ],
      consumer,
    );
    expectSuccess(library);
    expect(JSON.parse(library.stdout) as unknown).toEqual(['0.1.0', 'function', 'function']);

    const schema = runNode(
      [
        '--input-type=module',
        '-e',
        "import('audit-estimator/schemas/result-v1.schema.json', { with: { type: 'json' } }).then(m => process.stdout.write(JSON.stringify(typeof m.default.$schema)))",
      ],
      consumer,
    );
    expectSuccess(schema);
    expect(JSON.parse(schema.stdout) as unknown).toBe('string');

    const deep = runNode(
      [
        '--input-type=module',
        '-e',
        "import('audit-estimator/dist/bin.js').then(() => process.stdout.write('IMPORTED'), e => process.stdout.write(String(e.code)))",
      ],
      consumer,
    );
    expectSuccess(deep);
    expect(deep.stdout).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });

  it('typechecks a strict consumer against the published declarations', async () => {
    const templates = join(repositoryRoot, 'test', 'package', 'consumer');
    await copyFile(join(templates, 'tsconfig.json.txt'), join(consumer, 'tsconfig.json'));
    await copyFile(join(templates, 'index.ts.txt'), join(consumer, 'index.ts'));
    // Trusted checker from the repository, run against the consumer (not installed into it).
    const tsc = runNode(
      [
        join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p',
        join(consumer, 'tsconfig.json'),
      ],
      consumer,
    );
    expect({ status: tsc.status, diagnostics: tsc.stdout }).toEqual({ status: 0, diagnostics: '' });
  });

  it('runs the installed CLI directly', () => {
    const version = runNode([installedBin, '--version'], consumer);
    expectSuccess(version);
    expect(version.stdout).toBe('audit-estimator 0.1.0\n');

    const help = runNode([installedBin, '--help'], consumer);
    expectSuccess(help);
    for (const command of ANALYSIS_COMMANDS) expect(help.stdout).toContain(command);
  });

  it('runs the installed CLI through the package-manager shim', () => {
    const binDir = join(consumer, 'node_modules', '.bin');
    let result: SpawnSyncReturns<string>;
    if (process.platform === 'win32') {
      const shimPath = join(binDir, 'audit-estimator.cmd');
      result = spawnSync(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', `"${JSON.stringify(shimPath)} --version"`],
        {
          cwd: consumer,
          env,
          encoding: 'utf8',
          timeout: COMMAND_TIMEOUT_MS,
          windowsVerbatimArguments: true,
        },
      );
    } else {
      result = spawnSync(join(binDir, 'audit-estimator'), ['--version'], {
        cwd: consumer,
        env,
        shell: false,
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
      });
    }
    const run = toRun(result);
    expectSuccess(run);
    expect(run.stdout).toBe('audit-estimator 0.1.0\n');
  });

  it('analyzes a project from an unrelated cwd and matches the checkout build byte for byte', async () => {
    await cp(join(repositoryRoot, 'test', 'fixtures', 'e2e', 'simple'), project, {
      recursive: true,
    });
    for (const command of ANALYSIS_COMMANDS) {
      const args = [command, project, '--format', 'json', '--no-config'];
      const installed = runNode([installedBin, ...args], elsewhere);
      expectSuccess(installed);
      const parsed = ReportEnvelopeSchema.safeParse(JSON.parse(installed.stdout) as unknown);
      expect(parsed.success).toBe(true);

      const checkout = runNode([binPath, ...args], elsewhere);
      expectSuccess(checkout);
      expect(installed.stdout).toBe(checkout.stdout);
    }
  });

  it('makes no network attempts from the CLI process', async () => {
    // The parser worker child is spawned with a trusted environment and is covered statically by
    // `pnpm boundaries:check`, not by this preload.
    const preload = join(tmp, 'harness', 'deny-network.mjs');
    await writeFile(preload, DENY_NETWORK_SOURCE);
    const preloadUrl = pathToFileURL(preload).href;

    const selfCheck = runNode(
      [
        '--import',
        preloadUrl,
        '--input-type=module',
        '-e',
        "import { connect } from 'node:net'; try { connect(1, '127.0.0.1'); } catch { process.exit(0); } process.exit(1)",
      ],
      elsewhere,
    );
    expectSuccess(selfCheck);
    expect(selfCheck.stderr).toContain('NETWORK_ATTEMPT');

    const estimate = runNode(
      [
        '--import',
        preloadUrl,
        installedBin,
        'estimate',
        project,
        '--format',
        'json',
        '--no-config',
      ],
      elsewhere,
    );
    expectSuccess(estimate);
    expect(estimate.stderr).not.toContain('NETWORK_ATTEMPT');
  });
});
