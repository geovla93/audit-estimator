import type { Command } from 'commander';
import { resolve } from 'node:path';

export type CliCommand = 'estimate' | 'inspect' | 'explain';
export type CliFormat = 'terminal' | 'json' | 'markdown';

export interface CliRequest {
  readonly command: CliCommand;
  readonly input: string;
  readonly root?: string | undefined;
  readonly configPath?: string | undefined;
  readonly noConfig: boolean;
  readonly include?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly format?: CliFormat | undefined;
  readonly output?: string | undefined;
  readonly force: boolean;
  readonly solidityVersion?: string | undefined;
  readonly allowPartial: boolean;
  readonly strict: boolean;
  readonly noColor: boolean;
  readonly breakdown: boolean;
}

export interface CliIo {
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
  readonly cwd?: string | undefined;
}

export class CliOptionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CliOptionError';
  }
}

function wasSet(command: Command, name: string): boolean {
  return command.getOptionValueSource(name) === 'cli';
}

function stringValue(command: Command, name: string): string | undefined {
  if (!wasSet(command, name)) return undefined;
  const value: unknown = command.getOptionValue(name);
  if (typeof value !== 'string') throw new CliOptionError('An option value is invalid.');
  return value;
}

function stringListValue(command: Command, name: string): readonly string[] | undefined {
  if (!wasSet(command, name)) return undefined;
  const value: unknown = command.getOptionValue(name);
  if (!Array.isArray(value) || !value.every((entry: unknown) => typeof entry === 'string')) {
    throw new CliOptionError('A repeated path pattern option is invalid.');
  }
  return value;
}

function booleanValue(command: Command, name: string): boolean {
  return wasSet(command, name) && command.getOptionValue(name) === true;
}

function formatValue(command: Command): CliFormat | undefined {
  const value = stringValue(command, 'format');
  if (value === undefined) return undefined;
  if (value === 'terminal' || value === 'json' || value === 'markdown') return value;
  throw new CliOptionError('Format must be terminal, json, or markdown.');
}

export function normalizeCliRequest(
  commandName: CliCommand,
  input: string,
  command: Command,
  io: CliIo,
): CliRequest {
  const configPath = stringValue(command, 'config');
  const root = stringValue(command, 'root');
  const output = stringValue(command, 'output');
  const solidityVersion = stringValue(command, 'solidityVersion');
  const include = stringListValue(command, 'include');
  const exclude = stringListValue(command, 'exclude');
  const noConfig = wasSet(command, 'noConfig');
  const force = booleanValue(command, 'force');

  if (configPath !== undefined && noConfig) {
    throw new CliOptionError('--config cannot be used with --no-config.');
  }
  if (force && output === undefined) {
    throw new CliOptionError('--force requires --output.');
  }
  if (
    solidityVersion !== undefined &&
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(solidityVersion)
  ) {
    throw new CliOptionError('--solidity-version must be an exact major.minor.patch version.');
  }

  const cwd = io.cwd ?? process.cwd();
  const colorSource = command.getOptionValueSource('color');
  const colorValue: unknown = command.getOptionValue('color');
  const format = formatValue(command);

  return {
    command: commandName,
    input: resolve(cwd, input),
    ...(root === undefined ? {} : { root: resolve(cwd, root) }),
    ...(configPath === undefined ? {} : { configPath: resolve(cwd, configPath) }),
    noConfig,
    ...(include === undefined ? {} : { include }),
    ...(exclude === undefined ? {} : { exclude }),
    ...(format === undefined ? {} : { format }),
    ...(output === undefined ? {} : { output: resolve(cwd, output) }),
    force,
    ...(solidityVersion === undefined ? {} : { solidityVersion }),
    allowPartial: booleanValue(command, 'allowPartial'),
    strict: booleanValue(command, 'strict'),
    noColor: colorSource === 'cli' && colorValue === false,
    breakdown: commandName === 'explain',
  };
}
