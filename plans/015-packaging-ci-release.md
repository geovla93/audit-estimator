# Plan 015: Package a portable npm artifact and prepare protected releases

> **Executor instructions:** Prepare packaging/CI/release files and local verification. This plan does **not** authorize publishing, pushing, tagging, account changes or triggering remote workflows. Run each gate and update status 015 in `plans/README.md`; record remote matrix evidence only if supplied by an authorized operator.
>
> **Drift check first:** Re-reconciled at `d11bc60` on 2026-10-15. Run `git status --short`, `git diff --stat d11bc60..HEAD -- package.json pnpm-lock.yaml .github scripts vitest.config.ts tsdown.config.ts src/version.ts test/e2e/packed-artifact.test.ts`, and `git diff HEAD -- package.json pnpm-lock.yaml .github scripts vitest.config.ts tsdown.config.ts src/version.ts test/e2e/packed-artifact.test.ts` (plus inspect untracked in-scope files). Check prerequisite statuses and the current-state snapshot below. Expected completed-prerequisite additions require inspection; contradictory contracts or unrelated local edits require reconciliation before implementation.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED (artifact correctness, supply chain and release permissions)
- **Depends on:** `plans/014-fixtures-adversarial-quality.md`
- **Category:** dx / direction
- **Planned at:** commit `d11bc60`, re-reconciled 2026-10-15 after 005/006 merged (previously `9b0bfe7`); originally greenfield planning on 2026-10-14.

## Why this matters

A development checkout can pass while the npm tarball omits its worker, declarations or parser assets. Portable artifact tests and protected release preparation make distribution reviewable without exposing publishing credentials to pull requests.

## Current state and architectural context

### Reconciled implementation baseline — 2026-10-15 (refreshed at `d11bc60`)

The package already exists as private `audit-estimator@0.1.0`, Node `>=24.11.0 <25`, pnpm `11.28.4`. Runtime pins are Slang `1.3.9`, Zod `4.4.3`, Commander `15.0.0`, Picomatch `4.0.7`, smol-toml `1.9.0`; dependency inventory is `docs/dependencies.md`. Current tsdown entries are `index`, `bin` and `parser/worker` (added by 006); `src/parser/adapter.ts` resolves the worker as `./parser/worker.js` relative to the package entry. Packed-tarball worker resolution and WASM loading are unverified and are this plan's responsibility. `src/version.ts` is the version authority and remains synchronized with package.json. Three schemas already exist, but schema package exports, distribution allowlist, CI/release workflows and package-smoke/check commands do not.

`vitest.config.ts` currently includes every e2e test in integration; explicitly exclude the new packed suite as prescribed before adding it. `scripts/test.mjs` is already the build-first wrapper; preserve it. An executor still needs its own successful frozen install before verification (worktrees do not share `node_modules`). Do not copy main node_modules into a clean consumer as a substitute for installing the exact tarball. Owner identity/license/OIDC/remote platform evidence remain pending; local package preparation can proceed after 014 without inventing those approvals.

Match established strict ESM conventions: `.ts` source imports, explicit named exports and exported annotations, `import type`, readonly DTOs, no `any` or suppressions, unknown caught values narrowed before use. Tests use Vitest source imports for units and the trusted build-first integration wrapper for artifact suites. These current facts supersede prospective wording in the original context below.

### Original design context (retained)

There was no package/repository/CI at planning. Expected implementation now builds tsdown-bundled ESM project code with external runtime dependencies under `dist`, schemas under `schemas`, fixed `dist/parser/worker.js`, pure library entry and `audit-estimator` bin. Provisional package is private and version0.1.0; no final npm owner/repository/license/security contact has been confirmed. Recommend MIT and a scoped npm package if unscoped name is unavailable; bin stays `audit-estimator`. Keep `private:true` until owner explicitly approves identity/license/release. No publish authorization can be inferred from this document.

Primary references: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/). Trusted publishing requires a supported npm/Node CLI and maintainer account setup; local dry-run does not prove OIDC permissions. Prefer GitHub-hosted Node24 release job with pinned compatible npm and protected environment, no long-lived publish token by default.

## Commands you will need

**Reconciliation gate note (re-reconciled 2026-10-15 at `d11bc60`):** Plans 001–006 are merged on `main`. In the primary checkout with dependencies installed, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm schemas:check`, `pnpm test` (52 unit tests) and fresh-build `pnpm test:integration` (99 integration/research tests) all exit 0. `.oxfmtrc.json` now ignores `.agents/**`, `.claude/**`, `dist/**`, `plans/**` and `pnpm-lock.yaml`, so the former four-file `.agents/skills/improve` format exception **no longer exists: any `pnpm format:check` failure is a STOP condition.** The production build emits exactly ten files (`index.js`, `index.d.ts`, `bin.js`/`.map`, `version.js`/`.map`, the shared `versions.js`/`.map` chunk, `parser/worker.js`/`.map`) and `test/integration/bootstrap-cli.test.ts` asserts that inventory; a new entry or shared chunk requires an explicit plan amendment, not a silent test edit. Feature-specific suites and later scripts exist only when their owning plans land.

An executor works in its own checkout or worktree, which does not share `node_modules`: run `pnpm install --frozen-lockfile` first and obtain success. Afterwards `pnpm --config.verifyDepsBeforeRun=false run <script>` runs a script without pnpm's implicit dependency reconciliation (it does not repair missing packages). Built-artifact suites run through the build-first wrapper (`pnpm test:integration` / `pnpm test:all`), never against stale `dist/`. This reconciliation did not rerun `pnpm install --frozen-lockfile` or `pnpm test:coverage`.

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Proposed prerequisite/new scripts; none existed at planning.

| Purpose | Command | Expected |
|---|---|---|
| Frozen tools | `pnpm install --frozen-lockfile` | 0, reviewed allowed dependency scripts |
| Full local gate | `pnpm check` | type/lint/test/build/schema/boundary checks all 0 |
| Packed artifact | `pnpm test:package` | tarball/installed bin/library/worker tests pass |
| Metadata dry run | `npm pack --dry-run --json --ignore-scripts` (after build) | only allowlisted distribution files |
| Advisory review | `pnpm audit --prod --audit-level high` | report reachable high/critical advisories; exceptions require evidence |

`pnpm audit` is an implementation-time networked dependency check, not analyzed-source transmission or a planning-run command. Do not send target sources in it. Actual `npm publish` is excluded from execution here.

## Scope

**In scope:** `package.json`, `pnpm-lock.yaml` (tool changes only if justified), `vitest.config.ts` (packed-artifact suite separation only), `.github/workflows/{ci,release}.yml`, `.github/dependabot.yml`, `scripts/{check,package-smoke}.mjs`, `test/e2e/packed-artifact.test.ts`, `docs/releasing.md`, `docs/dependencies.md`, `CHANGELOG.md`, 015 status row. Build/tarballs/install sandbox live in ignored `dist/` and OS temp only.

**Out of scope:** runtime feature/metric/model changes, npm/GitHub account settings, branch protection changes, initial package creation, secret creation, tags/commits/pushes/publishing, automatic GitHub issues or report upload containing analyzed sources.

## Git workflow

No conventions existed at planning. Prepare reviewable files in supplied checkout. Do not initialize remote Git, commit/push/tag/open PR or trigger remote CI without operator instruction.

## Steps

### Step 1: Define the distribution allowlist and public entry paths

Manifest bin `audit-estimator:dist/bin.js`; exports root ESM import/types `dist/index.js`/`.d.ts`, explicit schema export paths, no arbitrary deep source exports. Files allowlist: dist, schemas, README, LICENSE when owner-approved, CHANGELOG and selected public docs if necessary. Exclude tests/fixtures/plans/.git/.env/coverage/private calibration data and development scripts. Preserve executable shebang/bin mode. Runtime dependencies remain external installed packages, including Slang's own WASM assets; no accidental dev-tool requirement at runtime. Do not bundle Slang or bake absolute worker paths. Consumers receive maintained Node engines.

Record provisional package metadata and required owner fields without claiming a guessed repository exists. Keep package private; pack locally regardless. Final public switch/license/repository happens only after owner decision and authorized release preparation. Do not create a legal license text under an unapproved copyright identity.

**Verify:** `pnpm build`, `npm pack --dry-run --json --ignore-scripts` → 0; structured test compares every tarball entry to allowlist, no source fixtures/plans/secrets.

### Step 2: Test the exact tarball in a clean consumer sandbox

Create `pnpm test:package` using trusted Node script/test harness. Explicitly exclude `test/e2e/packed-artifact.test.ts` from the regular integration project and select it only through the package-test harness so full-test/check commands cannot recursively invoke package tests. Build first, `npm pack --ignore-scripts --json` into OS temp, install that exact local tarball with a fresh temp manifest using argument arrays/no shell, no local path links/workspace hooks, no ts-node/tsx/dev dependencies. Runtime dependency retrieval at installation is normal; runtime analysis test then runs offline with no target scripts. Supply-chain allowlisted installation scripts follow recorded dependencies; do not enable arbitrary lifecycle scripts. Import library, check types with a tiny consumer TypeScript project using available trusted checker, run installed bin help/version/inspect/estimate/explain and load parser worker from consumer cwd. Test bin name through platform npm shim (`.cmd` on Windows via safe explicit invocation) and directly via process.execPath; do not assert POSIX chmod on Windows.

Verify installed worker and dependency assets resolve when repository cwd/node_modules are unavailable. Confirm result schema, exact simple model values and zero application network calls using offline/no-network test environment where available; document environmental restriction if not enforceable locally. Cleanup temp/tarballs in finally, never remove user's npm cache or root.

**Verify:** `pnpm test:package` → 0, packed library/bin/parser worker succeeds under supported Node/current platform without checkout dev tools.

### Step 3: Prepare read-only cross-platform CI and dependency maintenance

CI matrix ubuntu/macos/windows × maintained Node 24.11+; use exact verified action commit pins and record their release/tag provenance. On PR/push: checkout, pinned pnpm, frozen install with narrow reviewed dependency build-script policy, `pnpm check`, coverage on primary Linux/Node24, `pnpm test:package` per platform/Node. Verify minimum Node 24.11 compatibility as well as a maintained Node 24 patch; minimum-patch checks are compatibility evidence, not a recommendation to run an old patch in production. Cache package store keyed to lock/tool/runtime; no artifacts of analyzed source beyond original committed tiny fixtures. Permissions contents:read; do not use pull_request_target to execute untrusted contributions with secrets. Set bounded job timeouts.

Implement `pnpm check` as a trusted cross-platform Node orchestrator for TS7 typecheck/oxlint/oxfmt/full-test/schema/boundary gates; build precedes child/E2E tests. `pnpm test` remains unit-only without building. `pnpm test:all` runs units followed by `pnpm test:integration`, whose wrapper refreshes tsdown artifacts before integration/E2E/research suites. Package tests stay separate to avoid recursive script loops. Prepare Dependabot weekly updates for pnpm/GitHub Actions, no auto-merge; Slang updates need capability/oracle/golden review. Audit reachable runtime high/critical advisories and document resolution or scoped evidence-based exception; don't claim every registry finding reachable.

Preserve 001's `scripts/test.mjs` build-first integration wrapper; full check may avoid a redundant build only by an internal trusted flag, never by leaving stale workers. `TOOL_VERSION` in `src/version.ts` must equal manifest version; verify equality in release guards and document updating both during an operator-authorized version change.

**Verify:** `pnpm check`, `pnpm test:coverage`, `pnpm test:package` → 0 locally. Review workflow permissions/matrix/pins against upstream official action metadata. If authorized remote CI results exist, require all three platform/Node 24 jobs and the minimum-patch compatibility check green; otherwise record **remote matrix not yet executed**, no claim of release readiness.

### Step 4: Prepare an inert, maintainer-controlled release workflow

Use manual workflow_dispatch plus protected `npm-release` environment and repository variable `RELEASE_ENABLED` default false; validate manifest version matches approved release input, no automatic version bump/tag/publish on PR. Job-local permissions contents:read/id-token:write, exact pinned npm supporting OIDC, pinned Node24, frozen build/full/artifact gates, license/identity/private:false checks before actual publish step. Workflow may contain the future publish command but must not be run by this plan. No reusable workflow indirection until publisher identity rules are understood.

Document maintainer steps: select npm name/license/repository/security contact; initial registry creation/bootstrap if necessary; configure trusted publisher/protected environment and authorized workflow; independently review artifact/changelog; approve an actual release. Provenance attached when supported, no source telemetry. Record local package gates separately from remote auth/platform gates. If package remains private/unapproved, preparation can be complete but release status is pending owner decisions.

**Verify:** `pnpm check`, `pnpm test:package`, pack dry-run → 0; release-config tests assert manual trigger, disabled-by-default condition, no tokens/PR publish and private/license/version guards. Do not run `npm publish`, account APIs or workflow-dispatch commands.

## Test plan

Test tarball entries/bin/types/schema exports, clean consumer import, worker/WASM paths, version consistency, package name independence from executable name and offline local analysis. Add workflow policy assertions where meaningful; real platform green CI remains separate operator-provided evidence. `npm pack --dry-run` alone is not installation or release validation.

## Done criteria

- [ ] `pnpm check`, coverage, package smoke and pack dry-run pass locally with allowlisted entries.
- [ ] Clean consumer needs no dev tooling/source checkout to analyze fixtures.
- [ ] Read-only pinned CI matrix/release guards exist; real matrix evidence or unrun status explicit.
- [ ] Public identity/license/OIDC prerequisites are listed, package private until approved, release inert by default.
- [ ] No publication/account/tag/push/outside-scope changes; status 015 records preparation versus release evidence.

## STOP conditions

Stop dependent release work if package ownership/license/repository identity is unapproved, packed worker/WASM/bin fails on a supported platform, a reachable high/critical dependency issue lacks resolution, OIDC needs unapproved secrets/account changes, action pins cannot be verified, any gate fails twice, or remote execution is being assumed without authorization. Complete unaffected local artifact preparation first and report remaining owner/CI gates.

## Maintenance notes

Recheck npm OIDC/provenance requirements and supported Node majors at release. Every parser/tool upgrade runs packed artifact tests. Keep source/fixture/calibration data outside tarballs and public CI uploads; automated updates never silently alter measured/model behavior.
