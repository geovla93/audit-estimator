import { Command, CommanderError, Option } from 'commander';
import {
  buildErrorEnvelope,
  fixedDiagnostic,
  trustedParserLabel,
} from '../application/envelope.ts';
import type { FailureCategory } from '../application/envelope.ts';
import type { Diagnostic } from '../domain/types.ts';
import { serializeJson } from '../reporting/json.ts';
import { ConfigError, ProjectRootError } from '../config/defaults.ts';
import { EXIT_CODES } from './exit-codes.ts';
import { TOOL_VERSION } from '../version.ts';
import { normalizeCliRequest, type CliIo, type CliRequest } from './options.ts';
import type { CliCommand } from './options.ts';

export type CliHandler = (request: CliRequest) => number | void | Promise<number | void>;

class NoConfigOption extends Option {
  public override attributeName(): string {
    return 'noConfig';
  }
}

function configureOptions(command: Command): Command {
  return command
    .option(
      '--include <glob>',
      'include matching root-relative Solidity paths',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      '--exclude <glob>',
      'exclude matching root-relative paths',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option('--root <path>', 'set the project root')
    .option('--config <file>', 'load this JSON configuration file')
    .addOption(
      new NoConfigOption('--no-config', 'disable automatic configuration loading').default(false),
    )
    .addOption(
      new Option('--format <format>', 'select terminal, json, or markdown output').choices([
        'terminal',
        'json',
        'markdown',
      ]),
    )
    .option('--output <file>', 'write output to this file')
    .option('--force', 'replace an existing output file')
    .option('--solidity-version <version>', 'select an exact Solidity major.minor.patch version')
    .option('--allow-partial', 'allow a subset analysis with an incomplete exit status')
    .option('--strict', 'treat any warning as an incomplete result')
    .option('--no-color', 'disable colored terminal output');
}

function createSubcommand(name: CliCommand, handler: CliHandler, io: CliIo): Command {
  const command = configureOptions(new Command(name))
    .description(
      name === 'estimate'
        ? 'estimate audit effort for local Solidity input'
        : name === 'inspect'
          ? 'inspect local Solidity scope and measurements'
          : 'explain the estimate breakdown for local Solidity input',
    )
    .argument('<input>', 'Solidity file or project directory')
    .allowExcessArguments(false)
    .configureOutput({
      writeOut: (text: string) => {
        io.stdout.write(text);
      },
      writeErr: (text: string) => {
        io.stderr.write(text);
      },
    })
    .exitOverride();

  command.action(async (input: string, _options: unknown, actionCommand: Command) => {
    let request: CliRequest;
    try {
      request = normalizeCliRequest(name, input, actionCommand, io);
    } catch (error: unknown) {
      if (error instanceof Error) {
        actionCommand.error(error.message, { code: 'commander.invalidOption', exitCode: 2 });
      }
      actionCommand.error('Command options are invalid.', {
        code: 'commander.invalidOption',
        exitCode: 2,
      });
    }
    await handler(request);
  });

  return command;
}

export function createProgram(handler: CliHandler, io: CliIo): Command {
  const program = new Command()
    .name('audit-estimator')
    .description('Estimate human audit effort from local Solidity sources.')
    .version(`audit-estimator ${TOOL_VERSION}`, '-v, --version')
    .configureOutput({
      writeOut: (text: string) => {
        io.stdout.write(text);
      },
      writeErr: (text: string) => {
        io.stderr.write(text);
      },
    })
    .exitOverride();

  program.addCommand(createSubcommand('estimate', handler, io));
  program.addCommand(createSubcommand('inspect', handler, io));
  program.addCommand(createSubcommand('explain', handler, io));
  program.addHelpText('afterAll', '\nUsage: audit-estimator [--help|-h] [--version|-v]\n');
  return program;
}

function isCommanderError(error: unknown): error is CommanderError {
  return error instanceof CommanderError;
}

const COMMAND_NAMES: readonly CliCommand[] = ['estimate', 'inspect', 'explain'];

/**
 * Pre-scans argv for the final `--format json` or `--format=json` (last occurrence wins, matching
 * Commander) so usage errors can still honor JSON mode. Anything else, including an invalid
 * value, keeps terminal mode.
 */
export function requestsJsonFormat(args: readonly string[]): boolean {
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') break;
    if (arg === '--format') {
      const value = args[index + 1];
      if (value !== undefined) {
        json = value === 'json';
        index += 1;
      }
    } else if (arg !== undefined && arg.startsWith('--format=')) {
      json = arg.slice('--format='.length) === 'json';
    }
  }
  return json;
}

function commandFor(args: readonly string[]): CliCommand {
  const first = args[0];
  return COMMAND_NAMES.find((name) => name === first) ?? 'estimate';
}

async function writeErrorEnvelope(
  io: CliIo,
  command: CliCommand,
  category: FailureCategory,
  diagnostic: Diagnostic,
): Promise<void> {
  try {
    const envelope = buildErrorEnvelope({
      identity: { command, parser: await trustedParserLabel(), semanticConfig: null },
      category,
      diagnostics: [diagnostic],
    });
    io.stdout.write(serializeJson(envelope));
  } catch {
    io.stderr.write('INTERNAL_ERROR: Error report could not be produced.\n');
  }
}

export async function runCli(
  args: readonly string[],
  handler: CliHandler,
  io: CliIo,
): Promise<number> {
  let handlerExitCode = 0;
  const jsonMode = requestsJsonFormat(args);
  const program = createProgram(async (request) => {
    try {
      const result = await handler(request);
      if (typeof result === 'number') handlerExitCode = result;
    } catch (error: unknown) {
      if (error instanceof ConfigError) {
        io.stderr.write('CONFIG_INVALID: Configuration data is invalid.\n');
        handlerExitCode = EXIT_CODES.usageOrConfig;
        if (jsonMode) {
          await writeErrorEnvelope(
            io,
            request.command,
            'config',
            fixedDiagnostic('CONFIG_INVALID', 'error', 'config', 'Configuration data is invalid.'),
          );
        }
        return;
      }
      if (error instanceof ProjectRootError) {
        io.stderr.write('TARGET_UNREADABLE: The selected input or project root is unavailable.\n');
        handlerExitCode = EXIT_CODES.target;
        if (jsonMode) {
          await writeErrorEnvelope(
            io,
            request.command,
            'target',
            fixedDiagnostic(
              'TARGET_UNREADABLE',
              'error',
              'discovery',
              'The selected input or project root is unavailable.',
            ),
          );
        }
        return;
      }
      io.stderr.write('INTERNAL_ERROR: Command handler failed.\n');
      handlerExitCode = EXIT_CODES.internal;
      if (jsonMode) {
        await writeErrorEnvelope(
          io,
          request.command,
          'internal',
          fixedDiagnostic('INTERNAL_ERROR', 'error', 'report', 'Command handler failed.'),
        );
      }
    }
  }, io);

  if (args.length === 0) {
    program.outputHelp();
    return 0;
  }

  try {
    await program.parseAsync([...args], { from: 'user' });
    return handlerExitCode;
  } catch (error: unknown) {
    if (!isCommanderError(error)) {
      io.stderr.write('INTERNAL_ERROR: Command dispatch failed.\n');
      if (jsonMode) {
        await writeErrorEnvelope(
          io,
          commandFor(args),
          'internal',
          fixedDiagnostic('INTERNAL_ERROR', 'error', 'report', 'Command dispatch failed.'),
        );
      }
      return EXIT_CODES.internal;
    }
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') return 0;
    if (jsonMode) {
      await writeErrorEnvelope(
        io,
        commandFor(args),
        'config',
        fixedDiagnostic('CONFIG_INVALID', 'error', 'config', 'Command usage is invalid.'),
      );
    }
    return 2;
  }
}

export function createUnavailableHandler(io: CliIo): CliHandler {
  return async () => {
    io.stderr.write('INTERNAL_ERROR: The analysis handler is not available yet.\n');
    return 1;
  };
}
