# Plan 001: Establish strict ESM tooling and a working verification baseline

> **Executor instructions:** Execute only this plan, in order. Each verification must pass before the next step. Honor STOP conditions. Update the 001 status row in `plans/README.md` on completion. This document authorizes future implementation within its scope, not publishing or project-script execution.
>
> **Drift check first:** The planning directory was empty on 2026-10-14 before plans were added and was not a Git repository. No SHA exists. Run `rg --files --hidden -g '!.git' -g '!node_modules'` and compare root implementation files with the current-state facts below. If a Git checkout now exists, inspect `git status --short` and `git diff --stat -- package.json src test tsconfig.json tsdown.config.ts pnpm-workspace.yaml .oxlintrc.json .oxfmtrc.json vitest.config.ts`. Preserve operator changes; stop if a conflicting scaffold exists.

## Status

- **Priority:** P1
- **Effort:** M (roughly one to two implementation days including checks)
- **Risk:** LOW
- **Depends on:** none
- **Category:** dx / direction
- **Planned at:** no commit available; empty non-Git directory inspected 2026-10-14

## Why this matters

Every later workstream needs reproducible typechecking, tests, linting and an npm-compatible ESM artifact. Use the user-selected tsdown build tool; verify emitted CLI and worker paths and parser WASM loading explicitly as those features are introduced. Establish actual commands before describing any feature as working.

## Current state and architectural context

There is no `package.json`, source, lockfile, CI, test, or existing convention to copy. All implementation paths are new proposals. The product is a local Solidity audit-effort CLI.

The user confirmed the following tooling decisions during review on 2026-10-14:

| Area | Confirmed decision |
|---|---|
| Runtime | Node 24.11+ only for development, CI and users; engines `>=24.11.0 <25` |
| Package manager | pnpm |
| Typechecking | Stable TS7; `tsc --noEmit`; no application JavaScript emission |
| Build | tsdown compiles and bundles project code |
| Modules | ESM only; `type:module`; no CommonJS distribution |
| Dependencies | Runtime packages stay external, including future Slang/WASM |
| Resolution | `module:ESNext`, `moduleResolution:bundler`, `.ts` relative imports, `allowImportingTsExtensions:true`, `verbatimModuleSyntax:true` |
| Type safety | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; catch variables remain `unknown` through strict mode |
| Declarations | `isolatedDeclarations`; explicit exported API annotations; tsdown uses Oxc declaration generation |
| Build target | Derived by tsdown from `engines.node` |
| Build outputs | `dist/index.js` with declarations; `dist/bin.js` with executable shebang; source maps; no minification; clean only `dist`; separate future parser-worker entry |
| Testing | Vitest; separate source unit and build-first integration/CLI/worker suites |
| Test commands | `test` = units without build; `test:integration` = build then integration; `test:all` = both; `test:coverage` = units with V8 coverage without build |
| Coverage | V8 with a matching `@vitest/coverage-v8` version |
| Linting | oxlint type-aware linting with compatible `oxlint-tsgolint`; `oxlint --type-aware` |
| Formatting | oxfmt; two-space indentation; semicolons |
| Naming/imports | Kebab-case filenames, explicit named exports and `import type` for type-only imports |
| Version policy | Exact reviewed stable direct dependency and pnpm `packageManager` pins; committed lockfile; frozen verification installs |

Additional user-approved defaults (2026-10-14): one package without a framework or DI library; readonly plain records; `unknown` at input boundaries; no `any`/suppression shortcuts; Oxlint recommended rules plus type-aware checks; `pnpm format:check` for non-mutating Oxfmt checks; reviewed allowlisting of necessary dependency build scripts; provisional package `audit-estimator`, version `0.1.0`, `private:true`.

User-confirmed final test layout (2026-10-14): all tests live outside `src` under `test/`. Unit tests use `test/unit/**/*.test.ts`; build-first suites use `test/integration/**/*.test.ts`, `test/e2e/**/*.test.ts` and `test/research/**/*.test.ts`. Bootstrap tests are `test/unit/bootstrap.test.ts` and `test/integration/bootstrap-cli.test.ts`. Fixtures, helpers and goldens stay under `test/`; tests are never distribution entry points. Packed-artifact tests are excluded from the normal integration group once plan 015 adds its separate package command.

References: [Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json), [TypeScript module options](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html), [Vitest](https://vitest.dev/guide/), [Oxlint type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware), [Oxfmt](https://oxc.rs/docs/guide/usage/formatter), [pnpm installation](https://pnpm.io/installation), [tsdown getting started](https://tsdown.dev/guide/getting-started).

## Review outcome

Tooling and test-layout review completed with the user's choices on 2026-10-14. The user authorized synchronizing the index and affected plans. This is planning work only; implementation remains TODO. Exact compatible stable pins and selected pnpm configuration syntax must be verified during bootstrap. Report incompatible requirements rather than choosing a fallback or raising Node support floors without approval.

## Commands you will need

**Fresh-artifact gate (user-approved separation):** Fast unit tests run against source without building. Integration, CLI and future parser-worker suites run through a separate build-first command. Never include built-artifact tests in the fast unit command or run them against stale output. The user-approved commands are `pnpm test:integration` for build-first suites and `pnpm test:all` for the complete regression gate. Direct Vitest invocations of built-artifact suites require `pnpm build` immediately beforehand.

**No implementation command was verified during recon.** Establish these scripts here; later plans rely on their exact names.

| Purpose | Proposed command | Expected result |
|---|---|---|
| Select versions | `node --version` and `pnpm --version` | Node 24.11+ supported patch, selected stable pnpm patch |
| Initial install | `pnpm install` | 0, reviewed lockfile created |
| Reproducible install | `pnpm install --frozen-lockfile` | 0, no manifest/lock drift |
| Typecheck | `pnpm typecheck` (TS7 `tsc --noEmit -p tsconfig.json`) | 0, source/tests/config checked, no emitted JavaScript |
| Unit tests | `pnpm test` (Vitest unit project, run once) | 0, source unit tests pass, no build |
| Integration/CLI tests | `pnpm test:integration` (build-first wrapper) | fresh tsdown build then artifact suites, 0 |
| Full regression | `pnpm test:all` | unit and build-first integration suites pass |
| Focused tests | `pnpm exec vitest run test/unit/bootstrap.test.ts` | smoke suite passes |
| Lint check | `pnpm lint` (`oxlint --type-aware`) | 0, no writes; recommended rules plus type-aware checks |
| Format check | `pnpm format:check` (`oxfmt --check`) | 0, no writes; approved non-mutating format-check script |
| Build | `pnpm build` (`tsdown`) | 0, fresh compiled/bundled ESM `dist` output |
| Coverage | `pnpm test:coverage` (Vitest unit project with V8 coverage) | 0, unit coverage under ignored `coverage/`, no build |

## Scope

**In scope:** `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (root-package settings only; not a monorepo), `.npmrc` (only if registry settings are necessary), `.node-version`, `.gitignore`, `.editorconfig`, `tsconfig.json`, `tsdown.config.ts`, `.oxlintrc.json`, `.oxfmtrc.json`, `vitest.config.ts`, `scripts/test.mjs`, `src/index.ts`, `src/bin.ts`, `src/version.ts`, `test/unit/bootstrap.test.ts`, `test/integration/bootstrap-cli.test.ts`, `docs/adr/001-toolchain.md`, `docs/dependencies.md`, `AGENTS.md`, and this plan's status row. `dist/`, `coverage/`, `.vitest/`, `node_modules/` are ignored build/tool artifacts.

**Out of scope:** all application features, Solidity parsing, runtime dependencies other than eventual CLI infrastructure, CI/publishing, production license decisions, unrelated planning files. Do not initialize Git, commit, push, install globally, or alter user/system settings.

## Git workflow

No repository/branch/message conventions exist. Use the supplied working checkout. If an operator has created Git, inspect changes and propose branch `advisor/001-bootstrap-tooling` only if branch creation is authorized. Do not commit, push or open a PR without operator instruction.

## Steps

### Step 1: Record compatible versions and create the manifest

Resolve current **stable** versions of tsdown, TypeScript 7, Vitest, matching `@vitest/coverage-v8`, oxlint, compatible oxlint-tsgolint, oxfmt, `@types/node` and pnpm using primary manifests/registry metadata. Check all tool and runtime dependency engines for compatibility with Node 24.11+ only. Apply the user-approved exact-pin policy to direct dependencies and `packageManager`; put resolution date, engine floors, license and purpose in `docs/dependencies.md`. Set provisional package name `audit-estimator`, version `0.1.0`, `private:true` until release plan 015, `type:module`, and user-confirmed engines `>=24.11.0 <25`. Do not install Slang here; plan 002 evaluates it. Review required lifecycle/build scripts and allowlist only necessary dependencies under the chosen pnpm version. Use its documented local settings file (`pnpm-workspace.yaml` for current pnpm), containing only the root package; do not create a monorepo. Do not write non-registry settings into `.npmrc` when the selected pnpm release does not read them there. Do not broadly enable dependency scripts.

**Verify:** `pnpm install` → 0; `pnpm install --frozen-lockfile` → 0 with identical lockfile; `pnpm list --depth 0` → only recorded development tools, no prereleases/unexplained packages.

### Step 2: Establish configs and real smoke tests

Create the approved compiler/check configurations. Configure oxlint recommended rules and oxfmt with the approved two-space/semicolon conventions instead of Biome. Enable user-approved type-aware linting with `oxlint-tsgolint` and `oxlint --type-aware`; verify the selected versions are compatible. Its typescript-go-based semantic lint rules complement the separate TS7 typecheck gate; both must pass. Pin a stable TypeScript 7 release for the dedicated typecheck gate; tsdown owns JavaScript compilation and bundling. Enable user-approved `isolatedDeclarations` in `tsconfig.json` and declaration output in tsdown so the selected release uses its documented Oxc declaration-generation path. Give exported functions and values the explicit annotations required by isolated declarations. Verify generated declarations with the selected TS7 typechecker. If this requires a different declaration backend or an additional older compiler dependency, stop and ask rather than choosing a fallback. `tsconfig.json` checks `src`, `test`, and the trusted Vitest and tsdown configs using `tsc --noEmit`; `tsdown.config.ts` defines the build with explicit library and CLI entries (`src/index.ts` and `src/bin.ts`), user-approved output under `dist`, declarations and source maps, with minification disabled. Configure ESM-only output (`format:esm` in the form supported by the selected tsdown release); do not emit CommonJS. Bundle project code and keep runtime dependencies external using the selected tsdown release's documented dependency controls. Verify emitted dependency imports are preserved and all runtime imports are declared in the manifest. Do not inline Slang or copy its WASM assets into the project bundle. Use user-approved `moduleResolution:bundler` and `allowImportingTsExtensions:true` with TS7 no-emit checking; source-relative imports end in `.ts`. Use user-approved `module:ESNext` and `verbatimModuleSyntax:true`. Let tsdown derive its build target from `engines.node`; do not override it with the original ES2023 proposal. Verify tsdown resolves source imports and emits runtime-valid ESM JavaScript and declarations with no unresolved source `.ts` references. Explicitly preserve user-approved `dist/index.js` and `dist/bin.js` paths rather than assuming tsdown defaults produce them. Enable source maps and disable minification. Later parser workers require their own emitted entry and verified asset resolution. Exclude generated output. Vitest uses this repository's explicit test config, Node environment and run-once script; no framework config discovery in target projects. Keep `src/index.ts` as a side-effect-free entry with a version export, and `src/bin.ts` as a shebang shim supporting only version/help until plan 004. Define `TOOL_VERSION` in `src/version.ts` and assert it equals package.json's version; the release guard must keep them synchronized. This small explicit constant avoids import-time metadata I/O or compiled imports outside `dist`.

Configure separate Vitest unit and integration projects with explicit, disjoint directory includes. Unit includes `test/unit/**/*.test.ts`; integration includes `test/integration/**/*.test.ts`, `test/e2e/**/*.test.ts` and `test/research/**/*.test.ts`, excluding the packed-artifact suite reserved for plan 015's separate package command. Fixtures and helper scripts must not be discovered as tests. Keep library source-import/version assertions in `test/unit/bootstrap.test.ts`; place built shim help/version/shebang and artifact checks in `test/integration/bootstrap-cli.test.ts`. `pnpm test` runs only source unit tests, without building. Create trusted `scripts/test.mjs` for `pnpm test:integration`: run tsdown once, then local Vitest's integration project with forwarded arguments using Node child argument arrays and installed tools' recorded bin entry points, never a shell or target-project executable. The complete regression command must run both test projects, building before the integration project. Use the user-approved script names above. `pnpm test:all` runs unit tests, then the build-first integration command; each must exit 0. `pnpm test:coverage` runs source unit tests with V8 coverage without building. Do not use untrusted cwd/package metadata to locate tool executables.

Tests assert the library imports without I/O and the built shim prints help/version without crashing. If spawning the shim, run `process.execPath` with an argument array, `shell:false` and a timeout. Build first for artifact tests. Do not add meaningless arithmetic tests.

**Verify:** `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `node dist/bin.js --help`, `node dist/bin.js --version` → all 0, real output and import assertions pass.

### Step 3: Document the baseline and enforce clean emission

Document commands and module boundaries in the ADR and `AGENTS.md`. State local analysis never executes target scripts or downloads compilers. Configure `pnpm build` to clean only the repository-owned `dist` using the selected tsdown release's documented cleaning option so removed sources do not survive packaging. Do not clean arbitrary paths or use Unix-only shell commands. Ignore artifacts and set LF text conventions. Do not present proposed later commands as already implemented.

**Verify:** `pnpm build` twice → 0, equivalent executable/declaration paths; `pnpm test:all`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:coverage` → 0. `rg --files dist` → only compiled production shim/library artifacts and maps/declarations; no test files, test declarations, test-runner imports or config sources. Files under `test/` must not enter bundles or declarations.

## Test plan

Create `test/unit/bootstrap.test.ts` for source library loading and exact package version, and `test/integration/bootstrap-cli.test.ts` for emitted shim shebang/help/version and fresh build output. No existing exemplar exists. Verify source unit tests run without dist and the separate integration command builds before executing the emitted shim. Establish Vitest imports, explicit assertions and temporary-directory cleanup as conventions. No network-dependent tests.

## Done criteria

- [ ] `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test:all`, `pnpm lint`, `pnpm format:check`, `pnpm build`, `pnpm test:coverage` all exit 0.
- [ ] `node dist/bin.js --help` and `--version` exit 0.
- [ ] Manifest and lockfile use recorded stable exact versions; runtime ESM/declarations exist.
- [ ] No application feature, target execution, outside-scope edit, commit or publish occurred; compare changed paths with Scope.
- [ ] 001 status row updated with established verification commands and result.

## STOP conditions

Stop/report if an incompatible existing scaffold appears; a required stable dependency cannot run on the chosen Node baseline; a dependency requires unexpected system/global installation; version/help needs runtime TypeScript loaders; a gate fails twice after a bounded fix; or a fix needs outside-scope files. Do not weaken TypeScript rules or mark tests passing without assertions.

## Maintenance notes

Review engine floors and Node support before every major release. Upgrade Vitest/coverage together. Keep emitted file paths stable for later worker packaging. Lint/check commands must remain non-mutating; formatting fixes require explicit implementation edits. Record new dependencies with reason and build-script permissions.
