import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot: string = fileURLToPath(new URL('../../', import.meta.url));
export const binPath: string = resolve(repositoryRoot, 'dist', 'bin.js');

export interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface CliOptions {
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

/** Starts the built CLI with a minimal environment and no shell. */
export function spawnCli(
  args: readonly string[],
  options: CliOptions = {},
): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [binPath, ...args], {
    shell: false,
    cwd: options.cwd ?? repositoryRoot,
    env: { PATH: process.env.PATH ?? '' },
    timeout: options.timeoutMs ?? 60_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child;
}

/**
 * Delays a suite that loads the whole analysis graph and spawns many processes, so that its CPU
 * burst does not coincide with the first seconds of the parser-worker suite. That suite has a
 * 100 ms child-startup deadline test that is sensitive to ambient CPU load. Heavy imports must
 * happen after this call.
 */
export async function staggerStart(): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 8_000));
}

/** Resolves once the child closes, with the separately captured streams. */
export function collect(child: ChildProcessWithoutNullStreams): Promise<CliRun> {
  return new Promise<CliRun>((resolveRun, rejectRun) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', rejectRun);
    child.once('close', (status, signal) => {
      resolveRun({ stdout, stderr, status, signal });
    });
  });
}

/** Runs the built CLI to completion. */
export async function runCli(args: readonly string[], options: CliOptions = {}): Promise<CliRun> {
  const child = spawnCli(args, options);
  child.stdin.end();
  return await collect(child);
}
