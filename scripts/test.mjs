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

const [mode, ...forwardedArgs] = process.argv.slice(2);
if (mode !== 'integration' && mode !== 'all') {
  process.stderr.write('Usage: node scripts/test.mjs <integration|all> [...vitest-args]\n');
  process.exitCode = 2;
} else {
  const tsdownBin = resolveInstalledBin('tsdown', 'tsdown');
  const vitestBin = resolveInstalledBin('vitest', 'vitest');
  let status = 0;

  if (mode === 'all') {
    status = runTool(vitestBin, ['run', '--project', 'unit', ...forwardedArgs]);
  }

  if (status === 0) {
    status = runTool(tsdownBin, []);
  }

  if (status === 0) {
    status = runTool(vitestBin, ['run', '--project', 'integration', ...forwardedArgs]);
  }

  process.exitCode = status;
}
