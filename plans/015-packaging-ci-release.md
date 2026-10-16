# Plan 015: Package a portable npm artifact and prepare protected, inert CI/release workflows

> **Executor instructions:** Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If anything in "STOP conditions" occurs, stop and report — do not improvise. When done, update the 015 row in `plans/README.md` (unless a reviewer dispatched you and said they maintain the index).
>
> This plan prepares files and runs **local** gates only. It does **not** authorize `npm publish`, `git push`, tags, PRs, `gh workflow run`, GitHub/npm account or settings changes, or secret creation. Record remote CI results only if an authorized operator supplies them.
>
> **Drift check (run first):**
>
> ```sh
> git status --short
> git diff --stat a42129f..HEAD -- package.json pnpm-lock.yaml pnpm-workspace.yaml vitest.config.ts tsdown.config.ts scripts src/version.ts src/parser/adapter.ts src/cli/commands.ts test/integration/bootstrap-cli.test.ts test/helpers/run-cli.ts AGENTS.md docs/dependencies.md docs/testing.md schemas .github test/package CHANGELOG.md docs/releasing.md
> ```
>
> Expected: the diff is empty and `git status` shows at most edits under `plans/`. If any listed path changed, compare it against the "Current state" excerpts below; a mismatch is a STOP condition.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED (artifact correctness, supply chain, release permissions)
- **Depends on:** `plans/014-fixtures-adversarial-quality.md` (landed on `main` as `a42129f`)
- **Category:** dx
- **Planned at:** commit `a42129f`, 2026-10-16 (review-plan rewrite; supersedes the `5077f1f` text, whose eleven-file inventory and "013/014 TODO" facts are obsolete)

## Why this matters

A checkout can pass every test while the npm tarball silently omits `dist/` (it is gitignored and there is no `files` field, so `npm pack` today would ship no build output), the parser worker, the declarations or the schemas. The parser worker is located at runtime through a package self-reference, which has never been exercised from an installed copy. This plan makes the exact tarball testable from a clean consumer, adds a single `pnpm check` gate, and prepares read-only cross-platform CI plus a release workflow that is disabled by default — without exposing publish credentials to pull requests or deciding owner-only questions (name, license, repository).

## Current state

### Package and build

`package.json` (complete relevant parts, at `a42129f`):

```json
"name": "audit-estimator", "version": "0.1.0", "private": true,
"bin": { "audit-estimator": "./dist/bin.js" },
"type": "module", "main": "./dist/index.js", "types": "./dist/index.d.ts",
"exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
"scripts": {
  "build": "tsdown --clean",
  "typecheck": "tsc --noEmit -p tsconfig.json",
  "test": "vitest run --project unit",
  "test:integration": "node scripts/test.mjs integration",
  "test:all": "node scripts/test.mjs all",
  "test:coverage": "vitest run --project unit --coverage",
  "boundaries:check": "node scripts/check-boundaries.mjs",
  "lint": "oxlint --type-aware", "format": "oxfmt", "format:check": "oxfmt --check",
  "schemas:generate": "pnpm build && node scripts/generate-schemas.mjs generate",
  "schemas:check": "pnpm build && node scripts/generate-schemas.mjs check"
},
"engines": { "node": ">=24.11.0 <25" }, "packageManager": "pnpm@11.28.4"
```

- No `files`, `license`, `repository`, `publishConfig` field. No `README.md`, `LICENSE`, `CHANGELOG.md` at the repo root (README/LICENSE are plan 016 / owner decisions). No `.github/` directory. No `.npmignore`.
- `.gitignore` ignores `dist/`, `*.tgz`, `coverage/`, `.env*`, `.vitest/`.
- `pnpm-workspace.yaml` contains only `packages: []`. No `allowBuilds` entry exists; `docs/dependencies.md` records that no runtime dependency declares install lifecycle scripts.
- Runtime deps (exact pins): `@nomicfoundation/slang@1.3.9` (ships its own WASM), `commander@15.0.0`, `picomatch@4.0.7`, `smol-toml@1.9.0`, `zod@4.4.3`. `tsdown.config.ts` sets `deps.neverBundle: true`, entries `index`, `bin`, `parser/worker`, `dts` for `src/index.ts` only.
- `src/bin.ts` line 1 is `#!/usr/bin/env node`. `src/version.ts` is `export const TOOL_VERSION: string = '0.1.0';` and `test/unit/bootstrap.test.ts:7` already asserts it equals `package.json` `version`.
- Schemas: `schemas/config-v1.schema.json`, `schemas/model-v1.schema.json`, `schemas/result-v1.schema.json`.

### Production build inventory (authoritative: `test/integration/bootstrap-cli.test.ts:20-43`)

Exactly ten files: `dist/analyze.js`, `dist/analyze.js.map`, `dist/bin.js`, `dist/bin.js.map`, `dist/index.d.ts`, `dist/index.js` (no map), `dist/version-policy.js`, `dist/version-policy.js.map`, `dist/parser/worker.js`, `dist/parser/worker.js.map`. (A local `dist/` may be stale from an older build — always rebuild; never trust it.)

### Worker resolution — load-bearing for packaging

`src/parser/adapter.ts:1114-1121`:

```ts
function packageWorkerPaths(): { readonly workerPath: string; readonly packageRoot: string } {
  const packageEntry = new URL(import.meta.resolve('audit-estimator'));
  if (packageEntry.protocol !== 'file:') throw new Error('Package entry is not a local file.');
  return {
    workerPath: fileURLToPath(new URL('./parser/worker.js', packageEntry)),
    packageRoot: resolve(fileURLToPath(new URL('../', packageEntry))),
  };
}
```

This is a Node **package self-reference**: it works only because `name` is `audit-estimator` and `exports["."]` exists. Consequences:

1. Renaming the package (e.g. to a scoped `@owner/audit-estimator`) breaks worker spawning unless this string changes too.
2. `scripts/check-boundaries.mjs` pins `packageWorkerPaths`, `trustedEnvironment` and `spawnWorker` by SHA-256 AST fingerprints (`docs/testing.md`, "Platform skips and scanner maintenance"); editing this function fails `pnpm boundaries:check` with `worker-ast-fingerprint` until fingerprints are regenerated under review.
3. `exports["."]` must keep resolving to `./dist/index.js` so `./parser/worker.js` resolves next to it.

**Therefore this plan keeps the name `audit-estimator` and does not edit `src/`.** A rename is an owner decision that requires a separate amendment touching `src/parser/adapter.ts` and the scanner fingerprints.

### Test harness conventions to match

- `scripts/test.mjs` is the trusted build-first wrapper: resolves tool bins from each package's `package.json` `bin` field and runs `spawnSync(process.execPath, [binPath, ...args], { shell: false, stdio: 'inherit' })`. Modes: `integration`, `all`. Extend it; do not replace it. `typescript` (`bin/tsc`), `oxlint` (`bin/oxlint`), `oxfmt` (`bin/oxfmt`), `tsdown`, `vitest` bins are all `#!/usr/bin/env node` JS shims, so the same pattern works for every gate, including on Windows.
- `vitest.config.ts` has two projects: `unit` (`test/unit/**/*.test.ts`) and `integration` (`test/integration/**`, `test/e2e/**`, `test/research/**`), plus coverage thresholds.
- Built-CLI tests spawn with `shell: false`, an explicit minimal `env`, and a timeout — exemplar `test/helpers/run-cli.ts` (`spawnCli`, `collect`, `runCli`). Temp projects use `createProject`/`removeProject` from `test/helpers/filesystem.ts` inside `try/finally` (see `withCopy` in `test/e2e/cli.test.ts:44-52`).
- CLI surface: `audit-estimator --help|-h`, `--version|-v` (prints `audit-estimator 0.1.0`), subcommands `estimate`, `inspect`, `explain`; options used in tests: `--format json`, `--no-config`, `--no-color`. Exemplar call: `runCli(['estimate', fixture('simple'), '--format', 'json', '--no-config'])` (`test/e2e/cli.test.ts:119`). Fixture: `test/fixtures/e2e/simple/` (`package.json`, `src/Vault.sol` — data only, never executed).
- Source conventions (`AGENTS.md`): ESM only, `.ts` import extensions, explicit named exports with annotations, `import type`, no `any`/suppressions, caught values `unknown` until narrowed.
- Commits in this repo use Conventional Commits, e.g. `test: add independent oracles, stability, adversarial and boundary verification`, `feat: connect analysis pipeline to CLI commands`.

### Toolchain on the planning machine

Node `24.21.0`, npm `12.2.0` (bundled), pnpm `11.28.4`. npm's CLI script lives at `<dir of node>/../lib/node_modules/npm/bin/npm-cli.js` on POSIX and `<dir of node>/node_modules/npm/bin/npm-cli.js` on Windows.

## Commands you will need

Run `pnpm install --frozen-lockfile` once first in your checkout/worktree (worktrees do not share `node_modules`). Never copy another checkout's `node_modules`.

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | exit 0, lockfile unchanged |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Format check | `pnpm format:check` | exit 0 |
| Unit tests (no build) | `pnpm test` | exit 0 |
| Build + integration | `pnpm test:integration` | exit 0 |
| Boundaries | `pnpm boundaries:check` and `node scripts/check-boundaries.mjs --self-test` | exit 0 both |
| Schemas | `pnpm schemas:check` | exit 0 |
| Coverage | `pnpm test:coverage` | exit 0, thresholds pass |
| New: full gate | `pnpm check` | exit 0 (Step 3) |
| New: packed artifact | `pnpm test:package` | exit 0 (Step 2) |
| Pack listing | `pnpm build && npm pack --dry-run --json --ignore-scripts` | exit 0; entries exactly as in Step 1 |
| Advisories (network) | `pnpm audit --prod --audit-level high` | exit 0, or each finding documented per Step 3 |

## Scope

**In scope (the only files you may create or modify):**

- `package.json` — `files`, `exports`, new scripts `check`, `test:package`; provisional metadata only as described.
- `vitest.config.ts` — add a third `package` project only.
- `scripts/test.mjs` — add a `package` mode only.
- `scripts/check.mjs` (create).
- `test/package/packed-artifact.test.ts` (create) and `test/package/consumer/index.ts.txt` + `test/package/consumer/tsconfig.json.txt` (create; tiny TS consumer template). The `.txt` suffix is deliberate: the repo `tsconfig.json` includes `test/**/*.ts`, so a real `.ts` file there would be typechecked by `pnpm typecheck`/`oxlint` against a possibly missing or stale `dist/` and fail CI before the build runs. The test copies them into the sandbox and drops the `.txt` suffix.
- `test/unit/release-config.test.ts` (create).
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/dependabot.yml` (create).
- `CHANGELOG.md` (create), `docs/releasing.md` (create).
- `docs/dependencies.md` (only if a direct dependency changes — none is expected), `docs/testing.md` (add a "Packed artifact" row), `AGENTS.md` (add the two new commands to the "Current commands" table and one sentence that `test/package/**` is a separate build-first suite run by `pnpm test:package`).
- The 015 row in `plans/README.md`.

**Out of scope (do not touch):**

- Anything under `src/` — including `src/parser/adapter.ts` (fingerprinted; see above) and `src/version.ts`.
- `tsdown.config.ts`, `scripts/check-boundaries.mjs`, `scripts/generate-schemas.mjs`, `schemas/**`, existing tests — the build boundary and inventory test are settled by earlier plans.
- `pnpm-lock.yaml` and dependencies — no new dependency is needed (no YAML parser: release-config tests use text assertions). If you believe one is needed, STOP.
- `README.md`, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md` — plan 016 / owner approval.
- `"private": true`, `name`, `version` — keep unchanged. Do not add `license`, `repository`, `author` or `publishConfig` values that guess owner identity.
- Running `npm publish`, `npm login`, `gh workflow run`, `git push`, `git tag`, or any npm/GitHub settings API.

## Git workflow

- Work on a branch `advisor/015-packaging-ci-release` (or the dispatcher's worktree branch).
- One commit per step, Conventional Commits, e.g. `build: add npm distribution allowlist and schema exports`, `test: verify the packed tarball from a clean consumer`, `ci: add read-only cross-platform workflow and check gate`, `ci: add disabled-by-default release workflow`. End each message with the attribution trailer the operator specifies.
- Do NOT push, tag or open a PR unless the operator instructs it.

## Steps

### Step 1: Define the distribution allowlist and public entry paths

Edit `package.json`:

1. Add `"files": ["dist", "schemas", "CHANGELOG.md"]`. (npm always adds `package.json`, and auto-includes `README*`/`LICENSE*` if they exist at the root; they do not exist yet — that is expected.)
2. Replace `exports` with:

   ```json
   "exports": {
     ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
     "./schemas/config-v1.schema.json": "./schemas/config-v1.schema.json",
     "./schemas/model-v1.schema.json": "./schemas/model-v1.schema.json",
     "./schemas/result-v1.schema.json": "./schemas/result-v1.schema.json",
     "./package.json": "./package.json"
   }
   ```

   Keep `"."` exactly as-is (worker self-reference depends on it). No wildcard or `./dist/*` deep exports.
3. Keep `bin`, `main`, `types`, `engines`, `private`, `name`, `version` unchanged.
4. Create `CHANGELOG.md` with a `# Changelog` heading and an `## Unreleased` section listing "Initial local package preparation (not published)". Do not invent a release date or version entry.

**Verify:**

```sh
PACK_JSON="$(mktemp)"
pnpm build && npm pack --dry-run --json --ignore-scripts > "$PACK_JSON"; echo $?
node -e 'const [r]=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.files.map(f=>f.path).sort().join("\n"))' "$PACK_JSON"
```

→ exit 0, and exactly these 15 paths, plus `README.md` and/or `LICENSE` only if those files exist at the repo root (they do not at `a42129f`; plan 016 may add them):

```
CHANGELOG.md
dist/analyze.js
dist/analyze.js.map
dist/bin.js
dist/bin.js.map
dist/index.d.ts
dist/index.js
dist/parser/worker.js
dist/parser/worker.js.map
dist/version-policy.js
dist/version-policy.js.map
package.json
schemas/config-v1.schema.json
schemas/model-v1.schema.json
schemas/result-v1.schema.json
```

(Do not write `pack.json` into the repo.) If the build produces a different `dist/` set, STOP — `bootstrap-cli.test.ts` would also fail and the inventory has drifted.

### Step 2: Test the exact tarball from a clean consumer (`pnpm test:package`)

**2a. Wiring.**

- `vitest.config.ts`: add a third project `{ test: { name: 'package', include: ['test/package/**/*.test.ts'], environment: 'node', testTimeout: 300_000, hookTimeout: 300_000 } }`. Do not change the other two projects. Because `test/package/` is not matched by `integration`, `pnpm test:integration`/`test:all` never run it, and no recursive loop is possible.
- `scripts/test.mjs`: accept a third mode `package` that runs tsdown then `vitest run --project package ...forwardedArgs`. Update the usage string to `<integration|all|package>`. Keep the existing two modes byte-identical in behavior.
- `package.json`: `"test:package": "node scripts/test.mjs package"`.

**2b. Test file `test/package/packed-artifact.test.ts`.** Structure: one `describe` with a `beforeAll` that creates `<tmp>` via `mkdtemp(join(os.tmpdir(), 'audit-estimator-pack-'))`, then `mkdir(..., { recursive: true })` for `<tmp>/tarball`, `<tmp>/consumer`, `<tmp>/npm-cache`, `<tmp>/elsewhere`, `<tmp>/harness`, and writes an empty `<tmp>/empty-npmrc`. `afterAll` removes only `<tmp>` (`rm(tmp, { recursive: true, force: true })`) — never the user's npm cache or anything outside it. All child processes: `spawnSync`/`spawn` with `process.execPath` + script path, `shell: false`, explicit `cwd`, explicit timeout.

Define **one** environment builder in the test and use it for every child (npm, tsc, both CLIs), so npm never inherits pnpm's `npm_config_*` variables and the installed and checkout CLIs see identical environments:

```ts
function sandboxEnv(tmp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Put the running Node first so `#!/usr/bin/env node` shims use the same version.
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    npm_config_cache: join(tmp, 'npm-cache'),
    npm_config_userconfig: join(tmp, 'empty-npmrc'), // ignore the user's ~/.npmrc
    npm_config_update_notifier: 'false',
  };
  // Pass through only proxy/registry settings that are already set, so CI behind a proxy still works.
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'npm_config_registry']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  } else {
    env.HOME = tmp;
  }
  return env;
}
```

Do not use `runCli`/`spawnCli` from `test/helpers/run-cli.ts` for these runs (they hardcode the checkout `binPath` and a `{ PATH }`-only env); write a local `runNode(args, cwd)` helper that uses `sandboxEnv`.

1. **Locate npm without a shell:** `npmCli = join(dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js')`. If it does not exist, fail with a clear message (do not fall back to `npm.cmd`, `npx` or `process.env.npm_execpath`, which points at pnpm under `pnpm run`).
2. **Pack:** `node npmCli pack --ignore-scripts --json --pack-destination <tmp>/tarball` with `cwd` = repo root and `env` = `sandboxEnv(tmp)` (`dist/` was just built by the wrapper). Parse JSON; assert the file list equals the Step 1 list, plus `README.md` and/or `LICENSE` only when those files exist at the repo root (same rule as Step 1). Assert no path matches `/^(src|test|plans|docs|scripts|coverage|\.github|\.vitest|node_modules)\//`, `.env`, `.ts` (other than `.d.ts`) or `.tgz`.
3. **Consumer install:** create `<tmp>/consumer/package.json` = `{ "name": "consumer", "private": true, "type": "module" }`. Run `node npmCli install --ignore-scripts --no-audit --no-fund --no-package-lock <absolute tarball path>` with `cwd` = consumer dir and `env` = `sandboxEnv(tmp)` (isolated cache and userconfig, so the user's cache and `~/.npmrc` are never touched). Runtime deps come from the registry — this is the only networked step. If the install fails for network reasons, the test must fail with a message saying so; do not skip silently.
4. **Isolation:** assert `<consumer>/node_modules/audit-estimator/dist/bin.js` exists and its first line is `#!/usr/bin/env node`; assert `<consumer>/node_modules` contains no `vitest`, `tsdown`, `typescript`, `oxlint` directories.
5. **Library import:** from `cwd` = consumer, run `node --input-type=module -e "import('audit-estimator').then(m => process.stdout.write(JSON.stringify([m.TOOL_VERSION, typeof m.analyzeProject, typeof m.estimateEffort])))"` → `["0.1.0","function","function"]`. Also import `audit-estimator/schemas/result-v1.schema.json` with `{ with: { type: 'json' } }` and assert it parses with a `$schema` key, and assert `import('audit-estimator/dist/bin.js')` rejects with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
6. **Types:** copy `test/package/consumer/tsconfig.json.txt` → `<consumer>/tsconfig.json` and `test/package/consumer/index.ts.txt` → `<consumer>/index.ts`. `index.ts` imports `{ TOOL_VERSION, analyzeProject }` and `type { ReportEnvelope }` from `'audit-estimator'` and uses them in a typed assignment (e.g. `const v: string = TOOL_VERSION; const f: typeof analyzeProject = analyzeProject; let e: ReportEnvelope | undefined;`). tsconfig: `{ "compilerOptions": { "strict": true, "module": "nodenext", "moduleResolution": "nodenext", "target": "es2023", "noEmit": true, "types": [] }, "files": ["index.ts"] }`. Do **not** set `lib` (the default lib includes DOM, which supplies `AbortSignal` used by `AnalyzeOptions`; with `types: []` there is no `@types/node`). Do **not** set `skipLibCheck`. Run the repo's own checker: `node <repo>/node_modules/typescript/bin/tsc -p <consumer>/tsconfig.json` → exit 0. (Trusted tool from the repo, run against the consumer — not installed into it.) If errors come only from third-party `.d.ts` files under `<consumer>/node_modules` (e.g. zod), STOP and report them rather than adding `skipLibCheck`.
7. **CLI, direct:** `node <consumer>/node_modules/audit-estimator/dist/bin.js --version` → stdout `audit-estimator 0.1.0\n`, exit 0; `--help` → exit 0, contains `estimate`, `inspect`, `explain`.
8. **CLI, via shim:** POSIX: spawn `<consumer>/node_modules/.bin/audit-estimator --version` directly (`shell: false`) → same output. Windows: spawn `process.env.ComSpec ?? 'cmd.exe'` with args `['/d', '/s', '/c', `"${JSON.stringify(shimPath)} --version"`]` and `windowsVerbatimArguments: true` (this is how Node itself wraps `cmd /s /c`, and it survives spaces in the temp path); `shimPath` is the absolute `<consumer>\node_modules\.bin\audit-estimator.cmd`, test-controlled and never user input. Do not assert file modes on Windows.
9. **Analysis from an unrelated cwd (exercises the worker self-reference, syntax and semantic jobs):** copy `test/fixtures/e2e/simple` into `<tmp>/project` (use `cp(..., { recursive: true })`). Run the **installed** bin with `cwd` = `<tmp>/elsewhere` (an empty dir, so no repo `node_modules` is reachable) for each of: `estimate <tmp>/project --format json --no-config`, `inspect <tmp>/project --format json --no-config`, `explain <tmp>/project --format json --no-config`. Each → exit 0 and stdout parses with `ReportEnvelopeSchema` (import from `../../src/domain/schemas.ts` in the test — the test may import source; the consumer may not).
10. **Differential oracle:** run the same three commands with the checkout's `dist/bin.js` (import `binPath` from `test/helpers/run-cli.ts`, but spawn it with the local `runNode` helper) against the **same** `<tmp>/project` path, the same cwd and the same `sandboxEnv(tmp)`. Assert installed stdout === checkout stdout byte-for-byte. If they differ, STOP and report the diff — do not normalize fields away.
11. **No network from the CLI process:** write `<tmp>/harness/deny-network.mjs` that replaces `net.connect`, `net.createConnection`, `tls.connect`, `dns.lookup`, `dns.promises.lookup`, `http.request`, `https.request` and `globalThis.fetch` with functions that write `NETWORK_ATTEMPT` to stderr and throw, and then calls `syncBuiltinESMExports()` from `node:module` (without it, ESM named imports such as `import { connect } from 'node:net'` keep the original bindings and the preload proves nothing). **Self-check first:** run `node --import <preload URL> --input-type=module -e "import { connect } from 'node:net'; try { connect(1, '127.0.0.1'); } catch { process.exit(0); } process.exit(1)"` → exit 0 and stderr contains `NETWORK_ATTEMPT`; if not, fail the test. Then re-run the `estimate` call as `node --import <file URL of deny-network.mjs> <installed bin.js> ...` → exit 0, stderr does not contain `NETWORK_ATTEMPT`. Note in a code comment that the parser worker child is spawned with a trusted environment and is covered statically by `pnpm boundaries:check`, not by this preload.

**Verify:** `pnpm test:package` → exit 0, all tests pass. Then `pnpm test:integration` → exit 0 and its reported file count is unchanged from before this step (the package suite is not included).

### Step 3: `pnpm check`, read-only cross-platform CI and dependency maintenance

**3a. `scripts/check.mjs`.** Same structure as `scripts/test.mjs` (copy its `resolveInstalledBin`/`runTool` helpers). Run sequentially, stopping at the first non-zero status and printing which gate failed:

1. `tsc --noEmit -p tsconfig.json` (bin from `typescript`)
2. `oxlint --type-aware`
3. `oxfmt --check`
4. `node scripts/check-boundaries.mjs --self-test`
5. `node scripts/check-boundaries.mjs`
6. `node scripts/test.mjs all` (units, then fresh build, then integration)
7. `node scripts/generate-schemas.mjs check` — run immediately after 6, which just rebuilt `dist/` (this is the only "avoid a redundant build" shortcut allowed; never skip the build in 6).

Add `"check": "node scripts/check.mjs"`. Coverage and the package suite are deliberately separate commands.

**Verify:** `pnpm check` → exit 0, and its output names all seven gates in order. Failure propagation is checked by code reading: every `runTool` status is tested before the next gate starts and the final `process.exitCode` is the first non-zero status.

**3b. `.github/workflows/ci.yml`.**

- Triggers: `pull_request`, `push` to `main`. Never `pull_request_target`.
- Top-level `permissions: contents: read`. `concurrency` group per ref with `cancel-in-progress: true`.
- Job `check`: matrix `os: [ubuntu-latest, macos-latest, windows-latest]` × `node: ['24.11.0', '24.x']`, `fail-fast: false`, `timeout-minutes: 30`. Steps: `actions/checkout` (with `persist-credentials: false`), `pnpm/action-setup` (version from `packageManager`, no explicit version input), `actions/setup-node` (`node-version: ${{ matrix.node }}`, `cache: pnpm`), `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test:package`.
- Job `coverage`: `ubuntu-latest`, Node `24.x`, `timeout-minutes: 20`, install then `pnpm test:coverage`. No artifact upload.
- **Pin every action to a full 40-character commit SHA** with a trailing comment naming the release tag, e.g. `uses: actions/checkout@<sha> # v5.0.0`. Which tag: the newest non-prerelease full semver tag (`vX.Y.Z`) of each action's current major line, from `gh api repos/<owner>/<repo>/releases/latest`. Resolve its SHA with read-only `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`; if the returned object `type` is `tag` (annotated), dereference via `gh api repos/<owner>/<repo>/git/tags/<sha>` to the commit SHA. Actions used: `actions/checkout`, `actions/setup-node`, `pnpm/action-setup` — no others. Record each action, tag, SHA and lookup date in `docs/releasing.md` ("Pinned actions"). If `gh` is unavailable/unauthenticated or a SHA cannot be verified, STOP for Steps 3b/4a only — do not guess, use tags, or copy SHAs from memory.
- **Create `docs/releasing.md` now** with the full section skeleton from Step 4c (headings only, plus content you have so far), so Steps 3b/3d write into existing sections.

**3c. `.github/dependabot.yml`.** `version: 2`; updates for `package-ecosystem: npm` (covers pnpm lockfiles) and `github-actions`, both `directory: /`, `schedule.interval: weekly`, `open-pull-requests-limit: 5`. No auto-merge configuration anywhere. Add a comment: Slang updates require re-running parser oracles, goldens and `pnpm test:package` before merge.

**3d. Advisories.** Run `pnpm audit --prod --audit-level high` (sends only package names/versions to the registry — never target sources). For each high/critical finding, record in `docs/releasing.md` under "Advisory review": package, advisory ID, whether the vulnerable code path is reachable from `audit-estimator` with evidence, and resolution. An unreachable finding may be documented as an exception; a reachable one is a STOP.

**Verify:** `pnpm check` → 0; `pnpm test:coverage` → 0; `pnpm test:package` → 0; `grep -n "pull_request_target" .github/workflows/*.yml` → no output; `grep -nE "uses: [^ ]+@[0-9a-f]{40} # v" .github/workflows/ci.yml | wc -l` equals the number of `uses:` lines in that file.

### Step 4: Prepare an inert, maintainer-controlled release workflow

**4a. `.github/workflows/release.yml`.**

- Trigger: `workflow_dispatch` only, with one required string input `version`.
- Top-level `permissions: {}`. Single job `release`, `environment: npm-release`, `timeout-minutes: 30`, `if: vars.RELEASE_ENABLED == 'true'` (the variable is unset by default, so the job is skipped), job-level `permissions: { contents: read, id-token: write }`.
- Steps: pinned checkout (`persist-credentials: false`), pinned pnpm setup, pinned setup-node with `node-version: '24.x'` and `registry-url: https://registry.npmjs.org`; `pnpm install --frozen-lockfile`; `pnpm check`; `pnpm test:package`; a guard step whose YAML is bracketed by the exact comment lines `# release-guard:start` and `# release-guard:end`, using `env: { RELEASE_VERSION: ${{ inputs.version }} }` (never interpolate the input directly into the `run:` script) and an inline `node -e` that fails unless: `package.json` `version` === `inputs.version`, `TOOL_VERSION` in `src/version.ts` === `inputs.version`, `private` is not `true`, `license` is a non-empty string, and `repository` is set. Final step `npm publish --provenance --access public --ignore-scripts`.
- No `NODE_AUTH_TOKEN`/`NPM_TOKEN` secret references (trusted publishing via OIDC). No reusable-workflow indirection. Same SHA-pinning rule as Step 3.
- Because `private: true` remains, the guard step will fail even if someone enables the workflow — this double lock is intended.

**4b. `test/unit/release-config.test.ts`.** Read both workflow files as text with `readFile` (no YAML dependency) and assert:

- `release.yml` contains `workflow_dispatch:` and contains none of `pull_request`, `push:`, `schedule:`, `pull_request_target`.
- `release.yml` contains `vars.RELEASE_ENABLED == 'true'`, `environment: npm-release`, `id-token: write`, and does not match `/secrets\./`.
- `release.yml` has exactly one `# release-guard:start` and one `# release-guard:end` line, start before end, and the text between them contains `RELEASE_VERSION`, `private`, `license`, `repository` and `src/version.ts`; the line `npm publish` appears only after `# release-guard:end`.
- `release.yml` contains no `${{ inputs.version }}` inside any `run:` line (input reaches scripts only via `env`).
- `ci.yml` does not contain `id-token`, `secrets.` or `pull_request_target`, and contains `contents: read`.
- Every `uses:` line in both files matches `/@[0-9a-f]{40}\s+#\s+v\S+/`.
- `package.json` still has `"private": true` (fails loudly if someone flips it without updating this test and the owner checklist).

**4c. `docs/releasing.md`.** Sections: "Status" (local preparation complete / remote matrix not yet executed / release pending owner decisions), "Owner decisions required" (npm name — note a rename requires changing `src/parser/adapter.ts` self-reference and regenerating boundary fingerprints; license — recommend MIT; repository URL; security contact), "One-time setup" (create npm package or bootstrap publish, configure npm trusted publisher for this repo + `release.yml` + `npm-release` environment, add required reviewers to the environment, set `RELEASE_ENABLED`), "Release checklist" (bump `package.json` and `src/version.ts` together, update `CHANGELOG.md`, run `pnpm check` and `pnpm test:package`, review `npm pack --dry-run` output, dispatch with the version input), "Pinned actions" (table from Step 3), "Advisory review" (Step 3d), "Evidence" (local gate results with platform/Node; remote CI results only if operator-supplied).

Also add a "Packed artifact" row to `docs/testing.md` (gate, expected result, current-platform result with OS/Node/date) noting that a bare `vitest run` without `--project` now also runs the networked package suite, and add the two command rows to `AGENTS.md`.

**Verify:** `pnpm test` → exit 0 including the new `release-config` tests; `pnpm check` → 0; `pnpm test:package` → 0; `pnpm format:check` → 0 (format new Markdown/YAML only if oxfmt supports them; if oxfmt reports a new file, fix that file only).

## Test plan

- `test/package/packed-artifact.test.ts` (new, project `package`): tarball allowlist; no dev tools in consumer; library import + export map (including blocked deep import); consumer typecheck; `--version`/`--help` direct and via shim; `estimate`/`inspect`/`explain` JSON from an unrelated cwd; byte-identical differential against the checkout build; no network attempts from the CLI process. Pattern: `test/e2e/cli.test.ts` (`withCopy`, schema parsing) and `test/helpers/run-cli.ts` (spawn options).
- `test/unit/release-config.test.ts` (new, project `unit`): workflow trigger/permission/pin/guard assertions and `private: true`. Pattern: `test/unit/bootstrap.test.ts` (reads `package.json`).
- Existing suites unchanged: `pnpm test`, `pnpm test:integration` file/test counts must not change except for the new unit file.

## Done criteria

- [ ] `pnpm install --frozen-lockfile` exit 0; `git diff --exit-code pnpm-lock.yaml` exit 0.
- [ ] `pnpm check` exit 0.
- [ ] `pnpm test:coverage` exit 0.
- [ ] `pnpm test:package` exit 0.
- [ ] `pnpm build && npm pack --dry-run --json --ignore-scripts` lists exactly the 15 Step 1 paths (plus `README.md`/`LICENSE` only if present at the root).
- [ ] `pnpm audit --prod --audit-level high` exit 0, or every high/critical finding is recorded under "Advisory review" in `docs/releasing.md` as unreachable with evidence.
- [ ] `node -e 'const p=require("./package.json");process.exit(p.private===true&&p.name==="audit-estimator"&&p.version==="0.1.0"?0:1)'` exit 0.
- [ ] `git diff --stat a42129f..HEAD -- src tsdown.config.ts scripts/check-boundaries.mjs scripts/generate-schemas.mjs schemas` is empty.
- [ ] `grep -rn "pull_request_target\|NPM_TOKEN\|NODE_AUTH_TOKEN" .github` returns nothing.
- [ ] `docs/releasing.md` states "remote matrix not yet executed" unless operator-supplied results are recorded.
- [ ] `git status --short` shows only in-scope paths.
- [ ] `plans/README.md` 015 row updated (local preparation status separate from release status).

## STOP conditions

Stop and report (do not improvise) if:

- The drift check shows changes to in-scope or watched paths that contradict "Current state" (especially `packageWorkerPaths`, the `dist/` inventory, or `scripts/test.mjs`).
- The packed CLI cannot spawn the parser worker or Slang cannot load its WASM from the installed copy — report the error; do not change `src/` or `tsdown.config.ts`.
- The installed vs checkout differential (Step 2.10) differs.
- Any step seems to need a new dependency, a `src/` change, an `allowBuilds` entry, or a package rename.
- An action SHA cannot be verified from upstream, or OIDC/trusted publishing appears to need a long-lived token or account change.
- `pnpm audit` reports a reachable high/critical advisory.
- The consumer install fails for lack of network — report it; do not mock the registry or copy `node_modules`.
- Any gate fails twice after a reasonable fix attempt.
- You are about to run `npm publish`, `gh workflow run`, `git push` or `git tag`.

When a STOP blocks only the release work (Step 4) or remote evidence, finish Steps 1–3 first and report what remains.

## Maintenance notes

- Package rename or `exports["."]` change ⇒ update `src/parser/adapter.ts` self-reference, regenerate boundary fingerprints under review, and re-run `pnpm test:package`.
- Any tsdown/bundling change that alters `dist/` must update both `test/integration/bootstrap-cli.test.ts` and the Step 1 list in `test/package/packed-artifact.test.ts`.
- Every Slang/parser upgrade must pass `pnpm test:package` on all three OSes before merge.
- Version bumps change `package.json` and `src/version.ts` together (`test/unit/bootstrap.test.ts` enforces equality; the release guard checks the dispatch input).
- Re-check npm trusted-publishing/provenance requirements (supported npm version, environment naming) and the supported Node 24 range before the first real release.
- Reviewers: scrutinize workflow permissions, SHA pins, absence of `pull_request_target`/secrets, and that `private: true` is unchanged.
- Deferred: README/LICENSE/SECURITY (plan 016 + owner), package rename, actual publication, remote matrix evidence.
