# Plan 014: Verify metrics, stability and untrusted-input behavior independently

> **Executor instructions:** Complete the cross-cutting verification gaps; earlier plans already test their features. Run each gate, do not execute Solidity projects, and update status 014 in `plans/README.md`. Distinguish tested current platform from future CI-platform evidence.
>
> **Drift check first:** No planned-at SHA exists. Require working 013 CLI/application and all prior suites. If Git exists inspect `git status --short` and `git diff --stat -- test scripts/check-boundaries.mjs vitest.config.ts package.json docs/testing.md`. Stop if fixing a newly found production bug needs outside-scope changes: report a focused fix before continuing.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH (measurement trust and safety claims)
- **Depends on:** `plans/013-analysis-cli-orchestration.md`
- **Category:** tests / security
- **Planned at:** no commit available; greenfield non-Git directory inspected 2026-10-14

## Why this matters

Golden output consistency does not prove that counts are correct. Independent line/node/graph oracles, metamorphic cases, adversarial resource/path tests and packed ESM tests are required before a production-quality release claim. These validate measurement/software behavior, not actual human-effort accuracy.

## Current state and architectural context

No tests existed at planning. Every prerequisite should now have feature-local unit/integration/e2e suites and attributable fixtures. Maintain Vitest run-once, strict ESM, Node-native child invocation and no network/target execution. Metrics version/model profile semantics are frozen; independent expectations must not be generated from current implementation.

Security limits: 2 MiB/file, 64 MiB source total, 2,000 source/context files, 100,000 walked entries, depth64, 20,000 imports, 200,000 AST nodes/file, 2,000,000/session, 100,000 graph edges, 128 files/8 MiB semantic component, bounded pattern/config/LCOV data and actual child deadlines. Tests can lower limits. Symlinks default skipped; opt-in inside-root only; graph unknowns remain explicit; WASM hard RSS/hostile concurrent filesystem sandbox is outside guaranteed containment.

## Commands you will need

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Proposed scripts; none verified at planning.

| Purpose | Command | Expected |
|---|---|---|
| Independent metrics | `pnpm exec vitest run test/integration/measurement-oracles.test.ts` | exact hand-reviewed counts/edges |
| Metamorphic | `pnpm exec vitest run test/integration/stability.test.ts` | declared invariants pass |
| Adversarial | `pnpm exec vitest run test/integration/adversarial.test.ts` | budgets/paths/IPC/errors terminate safely |
| E2E | `pnpm build` then `pnpm exec vitest run test/e2e` | 0 |
| Boundary check | `pnpm boundaries:check` | 0, allowed layering/no runtime network imports |
| Coverage | `pnpm test:coverage` | reviewed branch coverage gates pass |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm schemas:check` | 0 |

## Scope

**In scope:** `test/helpers/**`, `test/integration/{measurement-oracles,stability,adversarial}.test.ts`, `test/e2e/cli.test.ts` (extend cross-cutting cases), `test/fixtures/**`, `test/golden/**` (only reviewed additions), `scripts/check-boundaries.mjs`, `vitest.config.ts`, `package.json` (verification scripts), `docs/testing.md`, 014 status row.

**Out of scope:** production behavior changes/refactors, production compiler or network dependencies, fetching entire repositories in CI, effort benchmark fitting, vulnerability detection, silently updating existing approved golden/model expectations.

## Git workflow

Use supplied checkout. No commits/pushes/publication or branch changes without operator instruction.

## Steps

### Step 1: Complete licensed, representative fixture infrastructure

Maintain `test/fixtures/manifest.json` with relative fixture path, original/upstream provenance, author/license, verified source tag/commit **only if real**, parser grammar expectations, hand-counted lines/declarations/decisions and relationship expectations. Prefer original tiny ERC20-like token, vault/math, access-controlled, proxy/upgrade, interface/library, Foundry and Hardhat-shaped projects. They are test shapes, not claims of compiled/audited implementations. For copied upstream snippets retain license/header and pinned source citation; no invented commit SHA or proprietary audit code. Fixtures stay local/offline; no install/build/test of fixture projects.

Create hand-reviewed oracle cases separate from golden outputs; reviewers enumerate contributing line IDs/node sites/edge identities. Add free functions, old constructor/fallback, supported modern grammar, complex inheritance/import aliases, custom builtin-name decoys and partially parseable source. Test latest supported grammar by installed API rather than frozen documentation example.

**Verify:** `pnpm exec vitest run test/integration/measurement-oracles.test.ts` → 0; every fixture has manifest provenance and explicit expected facts, no self-generated expected values.

### Step 2: Verify metamorphic stability with declared exceptions

Transforms: comment/blank insertion preserves declaration/decision/call/graph counts but changes physical lines; newline style preserves metrics while raw byte hashes may differ; local identifier rename preserves counts; input enumeration order preserves output; identical project relocation preserves relative paths/config hashes; repeated shared imports/hardlinks count once; copied bytes remain distinct. Same-line contracts union correctly. Layout reflow may change SLOC and estimate; assert/report this limitation rather than requiring impossible invariance. Changing format/color/output destination must not affect semantic hashes/effort.

**Verify:** `pnpm exec vitest run test/integration/stability.test.ts` → 0 with independent before/after invariants and documented fingerprint exceptions.

### Step 3: Exercise resource, filesystem and parser failures

Use bounded generated sources/temp trees with reduced limits, not giant committed payloads. Cover file/total/entry/depth/import/node/edge/component/pattern/LCOV caps; invalid UTF-8/BOM/CRLF; nested syntax; malformed trees; version mismatch; missing/read-denied file; source mutation detection; symlink/hardlink/junction/cycle/outside-root/sibling-prefix paths; ambiguous remappings; oversized/malformed IPC; trusted stalled/crashed worker; cancellation/cleanup; output overwrite guards. Assert diagnostic/exit/partial envelope plus untouched external sentinel/source, no live worker/open test handle. Do not provide runnable misuse payloads in user docs; benign focused fixtures suffice.

Include `maxGlobStates` exhaustion and rejected multi-star filename segments; verify standalone multiple globstars use bounded dynamic-programming states and cannot stall the parent in an unconstrained path regexp. Deadline checks alone do not interrupt synchronous regexp matching, so test the restricted matcher policy itself.

Test runtime imports/boundaries with a trusted script checking actual import graph/known API uses using TypeScript's compiler API or a constrained AST scan of this codebase, not fragile substring assertions alone. Forbid runtime source layers from loading network modules, eval/Function, project-derived dynamic imports or shell execution. Allow only fixed package-owned worker fork and built CLI test children; no blanket ban on child_process that would reject required isolation. Check estimator/formatters remain pure. This is a review aid, not proof arbitrary dependency code never accesses network; offline runtime smoke is additional evidence.

**Verify:** `pnpm exec vitest run test/integration/adversarial.test.ts`, `pnpm boundaries:check` → 0, each cap/error class checked. Explicitly report unsupported current-platform link/junction permissions rather than claiming full Windows coverage.

### Step 4: Establish meaningful coverage and platform verification contract

Preserve the approved unit-only `pnpm test:coverage` command. Configure matching V8 coverage for source code directly instrumented by unit tests in `src/domain`, `metrics`, `estimation`, `discovery`, `config`, `relationships`, `indicators`, `reporting`, `application`, `cli`. Initial per-critical-group goals: engine/metrics >=95% lines and >=90% branches; config/discovery/path safety >=90% lines and >=85% branches. Do not count integration/E2E execution toward the unit coverage report or weaken thresholds to compensate; add meaningful source unit tests. Do not count parser child code as covered simply because parent tests ran; child boundary requires explicit behavior tests and optionally trusted NODE_V8_COVERAGE instrumentation in test harness. Exclude declarations/test files/generated schemas, not hard-to-test branches. If thresholds expose real untested cases, add meaningful assertions; do not merely lower gates or mirror implementation.

Document current-platform results and future matrix: maintained Node 24.11+ × ubuntu/macos/windows, platform-specific path/link tests and built/packed artifact smoke. 015 configures actual CI. 014 can be DONE on the local platform with cross-platform test definitions; release readiness remains blocked until actual 015 matrix passes. Keep timing/RSS benchmarks advisory outside canonical golden data; no elapsed-time assertions beyond bounded kill/controller tests with generous scheduling margin.

**Verify:** `pnpm test:coverage`, built e2e, oracle/stability/adversarial/boundary suites, type/lint/full/schema gates → 0 locally; `docs/testing.md` names unrun platforms and required CI gates.

## Test plan

Independent fixture oracles are the main accuracy check for **metrics**, followed by version/grammar matrix and metamorphic properties. No solc executable/download is required. Future optional differential checks can use an independently installed trusted compiler, but would need a separate plan. Effort accuracy requires 010 historical protocol, not synthetic software tests. Goldens need human semantic review before updates.

## Done criteria

- [ ] All listed local suites/coverage/type/lint/schema/build/boundary commands exit 0.
- [ ] Fixture manifest and independent line/node/graph evidence exist for representative cases.
- [ ] Every declared budget, ambiguity/error/partial path and key platform abstraction has meaningful assertions.
- [ ] No self-generated oracle or silently blessed golden drift; current platform and unrun platforms documented.
- [ ] No production/outside-scope changes; 014 status updated and release matrix requirement retained.

## STOP conditions

Stop if a production defect needs out-of-scope repair, independent counts disagree without understood cause, CI tests need runtime network/target scripts, fixture provenance/license is unknown, coverage thresholds require fake assertions, worker leaks remain, or a gate fails twice. Report a focused bug/fix plan; don't silently change model coefficients/metric definitions.

## Maintenance notes

Add a counterexample oracle for every measurement bug or grammar upgrade. Retain old golden/metric versions when semantics change. Distinguish software safety/measurement tests from calibration evidence and platform tests that have actually run.
