#!/usr/bin/env node
import { TOOL_VERSION } from './version.ts';

const args = process.argv.slice(2);
const wantsHelp =
  args.length === 0 || (args.length === 1 && (args[0] === '--help' || args[0] === '-h'));
const wantsVersion = args.length === 1 && (args[0] === '--version' || args[0] === '-v');

if (wantsHelp) {
  process.stdout.write(
    `audit-estimator ${TOOL_VERSION}
Usage: audit-estimator [--help|-h] [--version|-v]
`,
  );
} else if (wantsVersion) {
  process.stdout.write(`audit-estimator ${TOOL_VERSION}
`);
} else {
  process.stderr.write(`Unsupported arguments: ${args.join(' ')}
Run audit-estimator --help for usage.
`);
  process.exitCode = 2;
}
