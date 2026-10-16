import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const tsdownCliPath = createRequire(import.meta.url).resolve('tsdown/run');

/**
 * Bundles a test-only child entry as ESM with Slang left external. Runs tsdown's CLI module
 * through the current Node binary, with no shell or package-manager shim, so it also works on
 * Windows where `pnpm` resolves only to a `.cmd` file.
 */
export function bundleTestChild(entry: string, outDir: string): void {
  execFileSync(
    process.execPath,
    [
      tsdownCliPath,
      entry,
      '--out-dir',
      outDir,
      '--no-config',
      '--format',
      'esm',
      '--deps.never-bundle',
      '@nomicfoundation/slang',
    ],
    { cwd: repositoryRoot, stdio: 'pipe' },
  );
}
