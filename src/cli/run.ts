import { analyzeProject } from '../application/analyze.ts';
import type { AnalyzeOutcome, AnalyzeRequest } from '../application/analyze.ts';
import { buildErrorEnvelope, fixedDiagnostic } from '../application/envelope.ts';
import type { Diagnostic, ReportEnvelope } from '../domain/types.ts';
import { serializeJson } from '../reporting/json.ts';
import { formatMarkdown } from '../reporting/markdown.ts';
import { formatTerminal } from '../reporting/terminal.ts';
import type { CliHandler } from './commands.ts';
import { exitCodeFor } from './exit-codes.ts';
import type { CliIo, CliRequest } from './options.ts';
import { OutputError, writeReport } from './output.ts';

function toAnalyzeRequest(request: CliRequest): AnalyzeRequest {
  return {
    command: request.command,
    input: request.input,
    root: request.root,
    configPath: request.configPath,
    noConfig: request.noConfig,
    include: request.include,
    exclude: request.exclude,
    solidityVersion: request.solidityVersion,
    format: request.format,
    allowPartial: request.allowPartial,
  };
}

function render(
  envelope: ReportEnvelope,
  format: AnalyzeOutcome['reportFormat'],
  detail: boolean,
  color: boolean,
): string {
  if (format === 'json') return serializeJson(envelope);
  if (format === 'markdown') return formatMarkdown(envelope);
  return formatTerminal(envelope, { detail, color });
}

function diagnosticLine(item: Diagnostic): string {
  // Fixed library messages only; strip control characters defensively.
  const message = Array.from(item.message, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  }).join('');
  return `${item.code}: ${message}\n`;
}

function writeDiagnostics(io: CliIo, diagnostics: readonly Diagnostic[]): void {
  for (const item of diagnostics) io.stderr.write(diagnosticLine(item));
}

/** Creates the handler that runs the real analysis and renders its result. */
export function createAnalysisHandler(io: CliIo): CliHandler {
  return async (request: CliRequest): Promise<number> => {
    const analyzed = await analyzeProject(toAnalyzeRequest(request), {
      signal: io.signal,
      cwd: io.cwd,
    });
    const strict = request.strict;
    const allowPartial = request.allowPartial;
    const format = analyzed.reportFormat;
    const color =
      format === 'terminal' &&
      request.output === undefined &&
      !request.noColor &&
      io.stdout.isTTY === true;

    let envelope = analyzed.envelope;
    let body: string;
    try {
      body = render(envelope, format, request.breakdown, color);
    } catch {
      const failed = buildErrorEnvelope({
        identity: {
          command: envelope.command,
          parser: envelope.versions.parser,
          semanticConfig: envelope.fingerprints.semanticConfig,
        },
        category: 'internal',
        diagnostics: [
          fixedDiagnostic('INTERNAL_ERROR', 'error', 'report', 'The report could not be rendered.'),
        ],
      });
      writeDiagnostics(io, failed.diagnostics);
      try {
        io.stdout.write(render(failed, format === 'json' ? 'json' : 'terminal', false, false));
      } catch {
        // The stderr line above already reports the failure.
      }
      return exitCodeFor({
        outcome: 'failure',
        diagnostics: failed.diagnostics,
        strict,
        allowPartial,
      });
    }

    writeDiagnostics(io, envelope.diagnostics);
    let outcome = analyzed.outcome;

    if (request.output !== undefined && envelope.status !== 'error') {
      try {
        await writeReport(request.output, body, {
          force: request.force,
          protectedPaths: analyzed.protectedPaths,
        });
        io.stderr.write('Report written.\n');
      } catch (error: unknown) {
        if (!(error instanceof OutputError)) throw error;
        const failure = fixedDiagnostic(
          'OUTPUT_FAILED',
          'error',
          'report',
          'The report file could not be written.',
        );
        envelope = buildErrorEnvelope({
          identity: {
            command: envelope.command,
            parser: envelope.versions.parser,
            semanticConfig: envelope.fingerprints.semanticConfig,
          },
          category: 'output',
          diagnostics: [failure],
        });
        outcome = 'failure';
        if (format === 'json') {
          io.stdout.write(serializeJson(envelope));
        } else {
          io.stderr.write(diagnosticLine(failure));
        }
      }
    } else {
      io.stdout.write(body);
    }

    return exitCodeFor({ outcome, diagnostics: envelope.diagnostics, strict, allowPartial });
  };
}
