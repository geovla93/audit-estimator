import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Diagnostic, DiagnosticCode } from '../../src/domain/types.ts';
import { exitCodeFor, EXIT_CODES } from '../../src/cli/exit-codes.ts';
import { createUnavailableHandler, runCli } from '../../src/cli/commands.ts';
import { ProjectRootError } from '../../src/config/load.ts';
import { ConfigError } from '../../src/config/validate.ts';
import type { CliIo, CliRequest } from '../../src/cli/options.ts';

interface CapturedIo {
  readonly io: CliIo;
  readonly stdout: string[];
  readonly stderr: string[];
}

function capturedIo(cwd = '/tmp/project'): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      cwd,
      stdout: { write: (chunk: string) => stdout.push(chunk) },
      stderr: { write: (chunk: string) => stderr.push(chunk) },
    },
    stdout,
    stderr,
  };
}

function diagnostic(code: DiagnosticCode, severity: Diagnostic['severity']): Diagnostic {
  return { code, severity, phase: 'config', message: 'A stable test diagnostic.' };
}

describe('commands and options', () => {
  it('dispatches estimate, inspect, and explain through an injected handler', async () => {
    const captured = capturedIo();
    const requests: CliRequest[] = [];

    for (const command of ['estimate', 'inspect', 'explain'] as const) {
      const status = await runCli(
        [command, 'contracts'],
        (request) => {
          requests.push(request);
        },
        captured.io,
      );
      expect(status).toBe(0);
    }

    expect(requests.map((request) => request.command)).toEqual(['estimate', 'inspect', 'explain']);
    expect(requests.map((request) => request.breakdown)).toEqual([false, false, true]);
    expect(
      requests.every((request) => request.input === resolve('/tmp/project', 'contracts')),
    ).toBe(true);
  });

  it('preserves explicit option sources and resolves CLI paths from the supplied cwd', async () => {
    const captured = capturedIo('/workspace/audit');
    let request: CliRequest | undefined;

    const status = await runCli(
      [
        'estimate',
        'src',
        '--include',
        'contracts/**/*.sol',
        '--include',
        'packages/**/*.sol',
        '--exclude',
        'vendor/**',
        '--root',
        './project',
        '--config',
        './settings/audit.json',
        '--format',
        'json',
        '--output',
        './reports/result.json',
        '--force',
        '--solidity-version',
        '0.8.28',
        '--allow-partial',
        '--strict',
        '--no-color',
      ],
      (value) => {
        request = value;
      },
      captured.io,
    );

    expect(status).toBe(0);
    expect(request).toMatchObject({
      command: 'estimate',
      input: resolve('/workspace/audit', 'src'),
      root: resolve('/workspace/audit', 'project'),
      configPath: resolve('/workspace/audit', 'settings', 'audit.json'),
      noConfig: false,
      include: ['contracts/**/*.sol', 'packages/**/*.sol'],
      exclude: ['vendor/**'],
      format: 'json',
      output: resolve('/workspace/audit', 'reports', 'result.json'),
      force: true,
      solidityVersion: '0.8.28',
      allowPartial: true,
      strict: true,
      noColor: true,
      breakdown: false,
    });
  });

  it('leaves omitted options absent so configuration values remain effective', async () => {
    const captured = capturedIo();
    let request: CliRequest | undefined;

    await runCli(
      ['inspect', 'contracts'],
      (value) => {
        request = value;
      },
      captured.io,
    );

    expect(request).toBeDefined();
    expect(request?.format).toBeUndefined();
    expect(request?.include).toBeUndefined();
    expect(request?.exclude).toBeUndefined();
    expect(request?.solidityVersion).toBeUndefined();
    expect(request?.noConfig).toBe(false);
  });

  it('uses last value for duplicate scalar options and accumulates repeatable patterns', async () => {
    const captured = capturedIo();
    let request: CliRequest | undefined;

    await runCli(
      [
        'inspect',
        'contracts',
        '--root',
        'first',
        '--root',
        'second',
        '--config',
        'first.json',
        '--config',
        'second.json',
        '--format',
        'terminal',
        '--format',
        'json',
        '--include',
        'one.sol',
        '--include',
        'two.sol',
      ],
      (value) => {
        request = value;
      },
      captured.io,
    );

    expect(request).toMatchObject({
      root: resolve('/tmp/project', 'second'),
      configPath: resolve('/tmp/project', 'second.json'),
      format: 'json',
      include: ['one.sol', 'two.sol'],
    });
  });

  it('rejects conflicting and invalid options, unknown flags, and extra arguments with usage status', async () => {
    const invalidArguments = [
      ['estimate', 'contracts', '--config', 'audit.json', '--no-config'],
      ['estimate', 'contracts', '--force'],
      ['estimate', 'contracts', '--solidity-version', '0.8'],
      ['estimate', 'contracts', '--format', 'xml'],
      ['estimate', 'contracts', '--ignore-errors'],
      ['estimate', 'contracts', 'extra.sol'],
    ];

    for (const args of invalidArguments) {
      const captured = capturedIo();
      const status = await runCli(args, () => 0, captured.io);
      expect(status).toBe(2);
      expect(captured.stderr.length).toBeGreaterThan(0);
    }
  });

  it('prints help and version without calling an analysis handler', async () => {
    const captured = capturedIo();
    let called = false;
    const handler = () => {
      called = true;
      return 0;
    };

    expect(await runCli(['inspect', '--help'], handler, captured.io)).toBe(0);
    expect(await runCli(['--version'], handler, captured.io)).toBe(0);
    expect(called).toBe(false);
    expect(captured.stdout.join('')).toContain('Usage: audit-estimator inspect [options] <input>');
    expect(captured.stdout.join('')).toContain('audit-estimator 0.1.0');
    expect(captured.stderr).toEqual([]);
  });

  it('reports that analysis is unavailable without producing a fabricated result', async () => {
    const captured = capturedIo();
    const status = await runCli(
      ['estimate', 'contracts'],
      createUnavailableHandler(captured.io),
      captured.io,
    );

    expect(status).toBe(1);
    expect(captured.stderr.join('')).toContain('INTERNAL_ERROR');
    expect(captured.stderr.join('')).not.toContain('estimate');
  });

  it('maps known handler errors to stable redacted diagnostics and hides unexpected causes', async () => {
    const cases: readonly [Error, number, string][] = [
      [
        new ConfigError('private /Users/example/project/config.json'),
        EXIT_CODES.usageOrConfig,
        'CONFIG_INVALID',
      ],
      [
        new ProjectRootError('private /Users/example/project/target'),
        EXIT_CODES.target,
        'TARGET_UNREADABLE',
      ],
      [
        new Error('private /Users/example/project/secret.sol'),
        EXIT_CODES.internal,
        'INTERNAL_ERROR',
      ],
    ];

    for (const [error, expectedStatus, diagnosticCode] of cases) {
      const captured = capturedIo();
      const status = await runCli(
        ['inspect', 'contracts'],
        () => {
          throw error;
        },
        captured.io,
      );
      const message = captured.stderr.join('');
      expect(status).toBe(expectedStatus);
      expect(message).toContain(diagnosticCode);
      expect(message).not.toContain('/Users/example');
      expect(message).not.toContain('secret.sol');
    }
  });
});

describe('exit policy', () => {
  it('maps complete, partial, strict-warning, and interrupted outcomes', () => {
    const warning = diagnostic('OWNERSHIP_UNKNOWN', 'warning');
    const info = diagnostic('OWNERSHIP_UNKNOWN', 'info');

    expect(exitCodeFor({ outcome: 'complete', diagnostics: [] })).toBe(EXIT_CODES.complete);
    expect(exitCodeFor({ outcome: 'complete', diagnostics: [warning] })).toBe(EXIT_CODES.complete);
    expect(exitCodeFor({ outcome: 'complete', diagnostics: [warning], strict: true })).toBe(
      EXIT_CODES.incomplete,
    );
    expect(exitCodeFor({ outcome: 'complete', diagnostics: [info], strict: true })).toBe(
      EXIT_CODES.complete,
    );
    expect(exitCodeFor({ outcome: 'partial', diagnostics: [], allowPartial: true })).toBe(
      EXIT_CODES.incomplete,
    );
    expect(exitCodeFor({ outcome: 'interrupted', diagnostics: [] })).toBe(EXIT_CODES.interrupted);
  });

  it('maps stable failure diagnostics without letting strict warnings mask them', () => {
    const warning = diagnostic('OWNERSHIP_UNKNOWN', 'warning');
    const cases: readonly [DiagnosticCode, number][] = [
      ['INTERNAL_ERROR', EXIT_CODES.internal],
      ['CONFIG_INVALID', EXIT_CODES.usageOrConfig],
      ['TARGET_UNREADABLE', EXIT_CODES.target],
      ['EMPTY_SCOPE', EXIT_CODES.target],
      ['PARTIAL_ANALYSIS', EXIT_CODES.incomplete],
      ['OUTPUT_FAILED', EXIT_CODES.output],
    ];

    for (const [code, expected] of cases) {
      expect(
        exitCodeFor({
          outcome: 'failure',
          diagnostics: [warning, diagnostic(code, 'error')],
          strict: true,
        }),
      ).toBe(expected);
    }
  });
});
