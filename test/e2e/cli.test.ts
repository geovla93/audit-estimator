import { constants } from 'node:fs';
import {
  access,
  chmod,
  cp,
  link,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ReportEnvelope } from '../../src/domain/types.ts';
import { createProject, removeProject } from '../helpers/filesystem.ts';
import { collect, runCli, spawnCli, staggerStart } from '../helpers/run-cli.ts';

const fixtures = fileURLToPath(new URL('../fixtures/e2e/', import.meta.url));

function fixture(name: string): string {
  return resolve(fixtures, name);
}

function parseEnvelope(text: string): ReportEnvelope {
  return ReportEnvelopeSchema.parse(JSON.parse(text) as unknown);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function withCopy<T>(name: string, body: (root: string) => Promise<T>): Promise<T> {
  const root = await createProject('audit-estimator-e2e-');
  try {
    await cp(fixture(name), root, { recursive: true });
    return await body(root);
  } finally {
    await removeProject(root);
  }
}

// Schemas are loaded lazily, after the staggered start (see staggerStart).
let ReportEnvelopeSchema: typeof import('../../src/domain/schemas.ts').ReportEnvelopeSchema;
let OutputError: typeof import('../../src/cli/output.ts').OutputError;
let writeReport: typeof import('../../src/cli/output.ts').writeReport;

beforeAll(async () => {
  await staggerStart();
  ({ ReportEnvelopeSchema } = await import('../../src/domain/schemas.ts'));
  ({ OutputError, writeReport } = await import('../../src/cli/output.ts'));
}, 120_000);

describe('commands and streams', () => {
  it('prints a terminal estimate to stdout with exit 0', async () => {
    const run = await runCli(['estimate', fixture('simple'), '--no-config', '--no-color']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Auditor effort scenario');
    expect(run.stdout).not.toContain('\u001b[');
    expect(run.stderr).toBe('');
  });

  it('prints exactly one JSON envelope for --format json', async () => {
    const run = await runCli(['estimate', fixture('simple'), '--format', 'json', '--no-config']);
    expect(run.status).toBe(0);
    expect(run.stdout.endsWith('\n')).toBe(true);
    const envelope = parseEnvelope(run.stdout);
    expect(envelope.command).toBe('estimate');
    expect(envelope.status).toBe('complete');
    expect(envelope.estimate?.coverage).toBe('full');
    expect(envelope.fullScopeEstimate).toEqual(envelope.estimate);
    expect(run.stderr).toBe('');
    expect(run.stdout).not.toContain(fixtures);
  });

  it('prints Markdown with exit 0', async () => {
    const run = await runCli([
      'estimate',
      fixture('simple'),
      '--format',
      'markdown',
      '--no-config',
    ]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^#/u);
    expect(run.stderr).toBe('');
  });

  it('inspects without an estimate', async () => {
    const run = await runCli(['inspect', fixture('simple'), '--format', 'json', '--no-config']);
    expect(run.status).toBe(0);
    const envelope = parseEnvelope(run.stdout);
    expect(envelope.command).toBe('inspect');
    expect(envelope.status).toBe('complete');
    expect(envelope.estimate).toBeNull();
    expect(envelope.fullScopeEstimate).toBeNull();
  });

  it('explains with a ledger and the same estimate as estimate', async () => {
    const terminal = await runCli(['explain', fixture('simple'), '--no-color', '--no-config']);
    expect(terminal.status).toBe(0);
    expect(terminal.stdout).toMatch(/ledger/iu);
    expect(terminal.stderr).toBe('');
    const explained = await runCli([
      'explain',
      fixture('simple'),
      '--format',
      'json',
      '--no-config',
    ]);
    const estimated = await runCli([
      'estimate',
      fixture('simple'),
      '--format',
      'json',
      '--no-config',
    ]);
    expect(parseEnvelope(explained.stdout).command).toBe('explain');
    expect(parseEnvelope(explained.stdout).estimate).toEqual(
      parseEnvelope(estimated.stdout).estimate,
    );
  });

  it('shows help and version', async () => {
    const help = await runCli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: audit-estimator');
    const version = await runCli(['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout).toBe('audit-estimator 0.1.0\n');
    expect(version.stderr).toBe('');
  });

  it('prints one error envelope for a JSON-mode usage error', async () => {
    const run = await runCli(['estimate', fixture('simple'), '--format', 'json', '--bogus']);
    expect(run.status).toBe(2);
    const envelope = parseEnvelope(run.stdout);
    expect(envelope.status).toBe('error');
    expect(envelope.failureCategory).toBe('config');
    const equals = await runCli(['inspect', fixture('simple'), '--format=json', '--bogus']);
    expect(equals.status).toBe(2);
    expect(parseEnvelope(equals.stdout).command).toBe('inspect');
  });

  it('keeps terminal mode for an invalid format value', async () => {
    const run = await runCli(['estimate', fixture('simple'), '--format', 'yaml']);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('yaml');
  });

  it('reports an invalid configuration file as a config error', async () => {
    await withCopy('simple', async (root) => {
      await writeFile(join(root, 'audit-estimator.config.json'), '{ not json');
      const run = await runCli(['estimate', root, '--format', 'json']);
      expect(run.status).toBe(2);
      const envelope = parseEnvelope(run.stdout);
      expect(envelope.failureCategory).toBe('config');
      expect(run.stderr).toContain('CONFIG_INVALID');
      expect(run.stdout).not.toContain(root);
    });
  });

  it('reports a nonexistent path and a Solidity-free directory as target errors', async () => {
    const missing = await runCli([
      'estimate',
      resolve(fixtures, 'does-not-exist'),
      '--format',
      'json',
    ]);
    expect(missing.status).toBe(3);
    expect(parseEnvelope(missing.stdout).failureCategory).toBe('target');
    const root = await createProject('audit-estimator-e2e-empty-');
    try {
      await writeFile(join(root, 'README.md'), 'no Solidity here\n');
      const empty = await runCli(['estimate', root, '--format', 'json']);
      expect(empty.status).toBe(3);
      const envelope = parseEnvelope(empty.stdout);
      expect(envelope.diagnostics.map((item) => item.code)).toContain('EMPTY_SCOPE');
    } finally {
      await removeProject(root);
    }
    const comments = await runCli([
      'estimate',
      fixture('empty'),
      '--format',
      'json',
      '--no-config',
    ]);
    expect(comments.status).toBe(3);
  });

  it('exits 4 for a malformed scoped file, with and without --allow-partial', async () => {
    const strict = await runCli([
      'estimate',
      fixture('malformed'),
      '--format',
      'json',
      '--no-config',
    ]);
    expect(strict.status).toBe(4);
    const strictEnvelope = parseEnvelope(strict.stdout);
    expect(strictEnvelope.status).toBe('partial');
    expect(strictEnvelope.estimate).toBeNull();
    expect(strictEnvelope.analysis?.completeness.unavailableFileIds).toEqual([
      'file:src/Broken.sol',
    ]);
    const partial = await runCli([
      'estimate',
      fixture('malformed'),
      '--format',
      'json',
      '--no-config',
      '--allow-partial',
    ]);
    expect(partial.status).toBe(4);
    const envelope = parseEnvelope(partial.stdout);
    expect(envelope.estimate?.coverage).toBe('analyzed-subset');
    expect(envelope.fullScopeEstimate).toBeNull();
  });

  it('treats a warning as incomplete only under --strict', async () => {
    await withCopy('coverage', async (root) => {
      await rm(join(root, 'lcov.info'));
      const relaxed = await runCli(['estimate', root, '--format', 'json']);
      expect(relaxed.status).toBe(0);
      const envelope = parseEnvelope(relaxed.stdout);
      expect(envelope.status).toBe('complete');
      expect(envelope.diagnostics.some((item) => item.severity === 'warning')).toBe(true);
      const strict = await runCli(['estimate', root, '--format', 'json', '--strict']);
      expect(strict.status).toBe(4);
      expect(parseEnvelope(strict.stdout).status).toBe('complete');
    });
  });

  it('analyzes the remaining fixtures without running project scripts', async () => {
    const names = ['excluded-base', 'duplicate', 'custom-roots', 'coverage'];
    for (const name of names) {
      const run = await runCli(['estimate', fixture(name), '--format', 'json']);
      expect([name, run.status]).toEqual([name, 0]);
      expect(parseEnvelope(run.stdout).status).toBe('complete');
    }
    const missing = await runCli(['estimate', fixture('missing-context'), '--format', 'json']);
    expect(missing.status).toBe(4);
    const custom = parseEnvelope(
      (await runCli(['estimate', fixture('custom-roots'), '--format', 'json'])).stdout,
    );
    expect(custom.analysis?.completeness.analyzedFileIds).toEqual(['file:contracts/Token.sol']);
    for (const name of ['simple', 'malformed']) {
      expect(await exists(join(fixture(name), 'postinstall-marker.txt'))).toBe(false);
    }
  });

  it('keeps a closed stdout pipe free of stack traces', async () => {
    const child = spawnCli(['explain', fixture('simple'), '--format', 'json', '--no-config']);
    child.stdin.end();
    child.stdout.once('data', () => {
      child.stdout.destroy();
    });
    const run = await collect(child);
    expect(run.stderr).not.toMatch(/EPIPE|Error:|\n\s+at /u);
    expect(run.signal).toBeNull();
  });

  // Deferred to plan 014: SIGINT on the built CLI (exit 130) needs a trusted stalled-worker hook
  // that production code does not expose. Cancellation is covered at the analyzeProject level in
  // test/integration/application.test.ts.
});

describe('output safety and cancellation', () => {
  const unix = process.platform !== 'win32';

  async function reportBytes(args: readonly string[]): Promise<string> {
    const run = await runCli(args);
    expect(run.status).toBe(0);
    return run.stdout;
  }

  it('writes a new file with the same bytes as stdout mode', async () => {
    await withCopy('simple', async (root) => {
      const expected = await reportBytes(['estimate', root, '--format', 'json']);
      const out = join(root, 'report.json');
      const run = await runCli(['estimate', root, '--format', 'json', '--output', out]);
      expect(run.status).toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('Report written.');
      expect(run.stderr).not.toContain(out);
      expect(await readFile(out, 'utf8')).toBe(expected);
    });
  });

  it('refuses an existing file without --force and replaces a regular report with it', async () => {
    await withCopy('simple', async (root) => {
      const out = join(root, 'report.json');
      await writeFile(out, 'original');
      const refused = await runCli(['estimate', root, '--format', 'json', '--output', out]);
      expect(refused.status).toBe(5);
      expect(parseEnvelope(refused.stdout).failureCategory).toBe('output');
      expect(await readFile(out, 'utf8')).toBe('original');
      const forced = await runCli([
        'estimate',
        root,
        '--format',
        'json',
        '--output',
        out,
        '--force',
      ]);
      expect(forced.status).toBe(0);
      expect(forced.stdout).toBe('');
      expect(parseEnvelope(await readFile(out, 'utf8')).status).toBe('complete');
    });
  });

  it('reports an output failure on stderr outside JSON mode', async () => {
    await withCopy('simple', async (root) => {
      const out = join(root, 'report.txt');
      await writeFile(out, 'original');
      const run = await runCli(['estimate', root, '--no-color', '--output', out]);
      expect(run.status).toBe(5);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('OUTPUT_FAILED');
      expect(run.stderr).not.toContain(out);
    });
  });

  it.runIf(unix)('refuses a destination symlink with and without --force', async () => {
    await withCopy('simple', async (root) => {
      const target = join(root, 'target.txt');
      await writeFile(target, 'untouched');
      const linkPath = join(root, 'link.json');
      await symlink(target, linkPath);
      for (const extra of [[], ['--force']]) {
        const run = await runCli([
          'estimate',
          root,
          '--format',
          'json',
          '--output',
          linkPath,
          ...extra,
        ]);
        expect(run.status).toBe(5);
        expect(await readFile(target, 'utf8')).toBe('untouched');
      }
    });
  });

  it('refuses a .sol destination', async () => {
    await withCopy('simple', async (root) => {
      const out = join(root, 'Report.SOL');
      const run = await runCli(['estimate', root, '--format', 'json', '--output', out]);
      expect(run.status).toBe(5);
      expect(await exists(out)).toBe(false);
    });
  });

  it('never overwrites a scoped source, a configuration file or a coverage file', async () => {
    await withCopy('simple', async (root) => {
      const source = join(root, 'src', 'Vault.sol');
      const before = await readFile(source, 'utf8');
      for (const extra of [[], ['--force']]) {
        const run = await runCli([
          'estimate',
          root,
          '--format',
          'json',
          '--output',
          source,
          ...extra,
        ]);
        expect(run.status).toBe(5);
      }
      expect(await readFile(source, 'utf8')).toBe(before);
    });
    await withCopy('coverage', async (root) => {
      for (const name of ['lcov.info', 'audit-estimator.config.json']) {
        const path = join(root, name);
        const before = await readFile(path, 'utf8');
        const run = await runCli([
          'estimate',
          root,
          '--format',
          'json',
          '--output',
          path,
          '--force',
        ]);
        expect([name, run.status]).toEqual([name, 5]);
        expect(await readFile(path, 'utf8')).toBe(before);
      }
    });
  });

  it.runIf(unix)('refuses a hardlink to a scoped source even with --force', async () => {
    await withCopy('simple', async (root) => {
      const source = join(root, 'src', 'Vault.sol');
      const before = await readFile(source, 'utf8');
      const alias = join(root, 'alias.txt');
      await link(source, alias);
      const run = await runCli([
        'estimate',
        root,
        '--format',
        'json',
        '--output',
        alias,
        '--force',
      ]);
      expect(run.status).toBe(5);
      expect(await readFile(source, 'utf8')).toBe(before);
      expect(await readFile(alias, 'utf8')).toBe(before);
    });
  });

  it('does not create a missing parent directory', async () => {
    await withCopy('simple', async (root) => {
      const parent = join(root, 'missing-dir');
      const run = await runCli([
        'estimate',
        root,
        '--format',
        'json',
        '--output',
        join(parent, 'report.json'),
      ]);
      expect(run.status).toBe(5);
      expect(await exists(parent)).toBe(false);
    });
  });

  it.runIf(unix && process.getuid?.() !== 0)('reports an unwritable directory', async () => {
    await withCopy('simple', async (root) => {
      const locked = join(root, 'locked');
      await mkdir(locked);
      await chmod(locked, 0o500);
      try {
        const run = await runCli([
          'estimate',
          root,
          '--format',
          'json',
          '--output',
          join(locked, 'report.json'),
        ]);
        expect(run.status).toBe(5);
        expect(await readdir(locked)).toEqual([]);
      } finally {
        await chmod(locked, 0o700);
      }
    });
  });

  it('removes only the file it created after an injected write failure', async () => {
    const root = await createProject('audit-estimator-e2e-write-');
    try {
      const created = join(root, 'created.json');
      await expect(
        writeReport(created, 'body', {
          force: false,
          protectedPaths: [],
          writeBody: async (handle) => {
            await handle.writeFile('partial');
            throw new Error('injected failure');
          },
        }),
      ).rejects.toBeInstanceOf(OutputError);
      expect(await exists(created)).toBe(false);

      const existing = join(root, 'existing.json');
      await writeFile(existing, 'original');
      await expect(
        writeReport(existing, 'body', {
          force: false,
          protectedPaths: [],
          writeBody: async () => {
            throw new Error('never reached');
          },
        }),
      ).rejects.toBeInstanceOf(OutputError);
      expect(await readFile(existing, 'utf8')).toBe('original');

      await expect(
        writeReport(existing, 'body', {
          force: true,
          protectedPaths: [],
          writeBody: async () => {
            throw new Error('injected failure');
          },
        }),
      ).rejects.toBeInstanceOf(OutputError);
      // A pre-existing file is never unlinked, even when the forced write fails.
      expect((await stat(existing)).isFile()).toBe(true);
    } finally {
      await removeProject(root);
    }
  });
});
