#!/usr/bin/env node
import { createUnavailableHandler, runCli } from './cli/commands.ts';

const io = { stdout: process.stdout, stderr: process.stderr };
const exitCode = await runCli(process.argv.slice(2), createUnavailableHandler(io), io);
process.exitCode = exitCode;
