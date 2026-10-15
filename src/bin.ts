#!/usr/bin/env node
import { runCli } from './cli/commands.ts';
import { createAnalysisHandler } from './cli/run.ts';

const controller = new AbortController();
// The first SIGINT requests a graceful stop; the listener is then gone, so a second one terminates.
process.once('SIGINT', () => {
  controller.abort();
});

// A closed downstream pipe must not produce a stack trace or change the computed exit code.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') return;
  process.stderr.write('INTERNAL_ERROR: Output stream failed.\n');
  process.exitCode = 1;
});

const io = { stdout: process.stdout, stderr: process.stderr, signal: controller.signal };
process.exitCode = await runCli(process.argv.slice(2), createAnalysisHandler(io), io);
