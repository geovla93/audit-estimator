import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

function resolveInstalledBin(packageName, commandName) {
  const manifestPath = require.resolve(`${packageName}/package.json`, { paths: [projectRoot] });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[commandName];

  if (typeof bin !== 'string') {
    throw new Error(`No ${commandName} bin is recorded by ${packageName}.`);
  }

  return resolve(dirname(manifestPath), bin);
}

function runTool(binPath, args) {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    return 1;
  }

  return result.status ?? 1;
}

const scriptPath = (name) => resolve(projectRoot, 'scripts', name);

const gates = [
  {
    name: 'typecheck',
    bin: resolveInstalledBin('typescript', 'tsc'),
    args: ['--noEmit', '-p', 'tsconfig.json'],
  },
  { name: 'lint', bin: resolveInstalledBin('oxlint', 'oxlint'), args: ['--type-aware'] },
  { name: 'format check', bin: resolveInstalledBin('oxfmt', 'oxfmt'), args: ['--check'] },
  { name: 'boundaries self-test', bin: scriptPath('check-boundaries.mjs'), args: ['--self-test'] },
  { name: 'boundaries', bin: scriptPath('check-boundaries.mjs'), args: [] },
  // Unit tests, then a fresh build, then integration tests.
  { name: 'unit and integration tests', bin: scriptPath('test.mjs'), args: ['all'] },
  // Runs right after the fresh build above; this is the only build shortcut allowed.
  { name: 'schemas check', bin: scriptPath('generate-schemas.mjs'), args: ['check'] },
];

let status = 0;
for (const [index, gate] of gates.entries()) {
  process.stdout.write(`\n[check ${index + 1}/${gates.length}] ${gate.name}\n`);
  status = runTool(gate.bin, gate.args);
  if (status !== 0) {
    process.stderr.write(`\ncheck failed at gate ${index + 1}/${gates.length}: ${gate.name}\n`);
    break;
  }
}

process.exitCode = status;
