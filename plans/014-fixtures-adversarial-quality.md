# Plan 014: Verify metrics, stability and untrusted-input behavior independently

> **Executor instructions:** Complete the cross-cutting verification gaps; earlier plans already test their features. Run each gate, do not execute Solidity projects, and update status 014 in `plans/README.md`. Distinguish tested current platform from future CI-platform evidence.
>
> **Drift check first:** Reviewed at `5c1effa` on 2026-10-15 (implementation baseline remains `5077f1f`); plans 001–012 are present on `main`; 013–016 remain TODO. Preserve pre-existing plan edits. Run `git status --short`, `git diff --stat 5c1effa..HEAD -- test scripts/check-boundaries.mjs vitest.config.ts package.json src docs/testing.md plans/014-fixtures-adversarial-quality.md plans/README.md`, and `git diff HEAD -- test scripts/check-boundaries.mjs vitest.config.ts package.json src docs/testing.md plans/014-fixtures-adversarial-quality.md plans/README.md` (plus inspect untracked in-scope files). Check prerequisite statuses and the current-state snapshot below. Expected completed-prerequisite additions require inspection; contradictory contracts or unrelated local edits require reconciliation before implementation.

## Status

**Resumption verdict — 2026-10-16: DONE (APPROVED after one bounded
revision).** The focused resumption below was executed in the same worktree:
60 s outer watchdog added to the forged-reply test, ten consecutive green
fresh-build full integration runs (logs in `.vitest/plan014/`), ledger
completed, duplicate unit test removed. Reviewer independently re-ran every
final gate (497 unit + 274 integration, enforced coverage, boundary scan and
self-test, typecheck/lint/format/schemas). Work remains uncommitted in the
worktree; merging is the operator's decision.

**Earlier execution verdict — 2026-10-16: BLOCKED.** The separate executor stopped at
the twice-failed integration-gate rule. Partial implementation is preserved,
uncommitted, in `/private/tmp/audit-estimator-014-worktree` (detached base
`4a2100e`). It is not approved or integrated. See the focused resumption plan
below; do not interpret intermediate passing results as completion.

### Execution reconciliation — 2026-10-16 at `4a2100e`

Plan 013 is DONE and its reviewed implementation is present at current HEAD
`4a2100e`. The changes since `5c1effa` are exactly its application, CLI, fixtures,
tests and reviewed production-artifact inventory. These expected prerequisite
changes supersede historical statements below that orchestration is absent or
013 remains TODO. The main checkout has pre-existing edits only to this plan
and `plans/README.md`; preserve them. Execution uses the isolated detached
worktree `/private/tmp/audit-estimator-014-worktree`, based on `4a2100e`, without
committing, merging or changing the user's branch.

The successor production inventory is `analyze.js`/`.map`, `bin.js`/`.map`,
`index.d.ts`, forwarding `index.js`, `version-policy.js`/`.map`, and
`parser/worker.js`/`.map`. Keep the explicit bootstrap allowlist unchanged.
013 additionally introduced package-owned `createRequire(import.meta.url)` and
literal Slang manifest resolution in `src/application/envelope.ts`; review that
site alongside `src/parser/worker.ts` in the boundary capability inventory.
The two staggered suite starts and deferred built-CLI SIGINT remain mandatory
014 follow-ups as specified in Step 3. Historical verification counts below
are baseline evidence, not evidence for this execution.

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH (measurement trust and safety claims)
- **Depends on:** `plans/013-analysis-cli-orchestration.md`
- **Category:** tests / security
- **Planned at:** review commit `5c1effa`; implementation baseline `5077f1f`, reconciled 2026-10-15 after 011/012 reached `main`; supersedes `d012fb9`, `2eb8d3d` and `d11bc60`. Originally greenfield planning on 2026-10-14.

## Why this matters

Golden output consistency does not prove that counts are correct. Independent line/node/graph oracles, metamorphic cases and adversarial resource/path tests are required here. Plan 015 separately owns packed ESM tests before a production-quality release claim. These validate measurement/software behavior, not actual human-effort accuracy.

## Current state and architectural context

### Reconciled implementation baseline — 2026-10-15 (refreshed at `5077f1f`)

The repository already has source unit tests and integration/research suites for plans 001–012, including hand-authored parser and domain fixtures. Preserve them; this is an additive cross-cutting verification plan, not initial test scaffolding. `vitest.config.ts` has disjoint unit/integration projects and unit V8 coverage; `scripts/test.mjs` builds before artifact tests. Integration currently includes all e2e files; 015 owns the later packed-suite exclusion. Extend the existing fixture manifest instead of replacing parser provenance/oracles. Preserve separate `readinessFixtures` metadata registration: `test/research/slang-spike.test.ts` parses every member of `fixtures` as Solidity. Do not insert LCOV/model JSON into that list. Coverage fixture paths are currently ignored by the broad `coverage/` rule; preserve existing tracked fixtures and explicitly inspect newly added ignored paths rather than silently omitting them. `.gitignore` edits remain outside this plan.

Production indicators/readiness (`src/indicators/`, 009) and model specification/fixtures (010) now exist. Production discovery (`src/discovery/`, 005) and the parser boundary (`src/parser/`, 006) exist; the parent spawns the package-owned `dist/parser/worker.js` via `node:child_process` in `src/parser/adapter.ts`. Metrics and relationships exist. The pure engine and renderers are implemented in `src/estimation/` and `src/reporting/`, with public APIs and transitive purity checks in `test/integration/bootstrap-cli.test.ts`; application orchestration is absent, and there is no `boundaries:check` script. A boundary scanner must account for domain canonicalization intentionally using `node:crypto`, the package-owned parser child, and config filesystem loading; ban I/O only in layers documented as pure. TypeScript 7 is the pinned checker: use the installed unstable AST APIs only after a capability probe, as specified in Step 3; do not assume the former root compiler API is present. Do not introduce an unreviewed parser dependency outside scope. At `5077f1f` the reconciliation gates listed below pass and no format exception remains; any failure blocks approval.

Match established strict ESM conventions: `.ts` source imports, explicit named exports and exported annotations, `import type`, readonly DTOs, no `any` or suppressions, unknown caught values narrowed before use. Tests use Vitest source imports for units and the trusted build-first integration wrapper for artifact suites. These current facts supersede prospective wording in the original context below.

### Existing 007/008 tests and retained verification work

Existing independent coverage includes `test/unit/{source-metrics,structural-metrics,aggregate-metrics,relationships,parser-protocol}.test.ts` and `test/integration/{structural-extraction,imports,relationships,parser-worker}.test.ts`. Preserve those oracles and fixtures; target cross-cutting gaps instead of recreating feature suites. `docs/relationships.md` documents shared syntax/semantic node budgets, graph reference charging, disposable children and non-compiler-equivalent dispatch.

The prior 008 and 010 reviews recorded intermittent parser-worker startup/deadline failures and a duplicate-reply scheduling race; this reconciliation’s 215-test fresh-build integration suite passed but does not establish that either can never recur. Inspect `test/helpers/parser-child.ts` and `test/integration/parser-worker.test.ts` before test hardening. A single pipe write can be split by the OS. Any deterministic duplicate-frame expectation must use an explicit trusted harness/handshake, not tighter sleeps or assumed pipe chunking. This plan additionally permits narrowly scoped edits to `test/integration/parser-worker.test.ts` for test synchronization only; production supervisor/protocol changes require a separate focused plan. Keep watchdog/kill/reap assertions meaningful and report unreproduced timing concerns honestly. Include unavailable storage/builtin conversion and preservation of the accepted internal dynamic-call policy in cross-cutting application assertions after 013 exists. If 013 uses its documented cancellation fallback, finish the deferred built-CLI SIGINT verification here using a trusted deterministic harness; do not add production environment hooks. Also assert that optional readiness inspection/classifier-output completeness never overwrites required source-analysis flags, and that the same measured facts retain identical effort when metadata changes. Preserve 010’s immutable formula/eligibility/engine-invalid fixtures and 011’s explicit fixture-to-production row-ID mapping. Do not substitute golden-output consistency for those numerical oracles.

### Original design context (retained)

No tests existed at planning. Every prerequisite should now have feature-local unit/integration/e2e suites and attributable fixtures. Maintain Vitest run-once, strict ESM, Node-native child invocation and no network/target execution. Metrics version/model profile semantics are frozen; independent expectations must not be generated from current implementation.

Security limits: 2 MiB/file, 64 MiB source total, 2,000 source/context files, 100,000 walked entries, depth64, 20,000 imports, 200,000 AST nodes/file, 2,000,000/session, 100,000 graph edges, 128 files/8 MiB semantic component, bounded pattern/config/LCOV data and actual child deadlines. Tests can lower limits. Symlinks default skipped; opt-in inside-root only; graph unknowns remain explicit; WASM hard RSS/hostile concurrent filesystem sandbox is outside guaranteed containment.

## Review amendments — 2026-10-15 at `5c1effa`

This focused review changed only this plan and its index entry. HEAD differs from `5077f1f` only in planning documents; application/CLI orchestration remains absent. Do not start implementation until 013 is DONE and its source, tests and reviewed artifact inventory are present in the executor checkout. A status label alone is insufficient.

| Gap | Evidence | Required correction | Effort / risk / confidence |
|---|---|---|---|
| Stability wording conflates metrics with offset-dependent identities | `src/domain/canonical.ts`; `docs/metrics.md` (byte ranges and layout-sensitive SLOC) | Compare a named projection for each transform; reserve whole-envelope equality for unchanged inputs | S / LOW / HIGH |
| Coverage goals have no executable group definitions | `vitest.config.ts:29-34` has include/reporters, no thresholds | Separate glob thresholds for each critical directory; report all source coverage | S / LOW / HIGH |
| Scanner has no specified negative controls or TS7 API strategy | `test/integration/bootstrap-cli.test.ts:120-123` uses regexp imports; installed `typescript/package.json` exports root version metadata and unstable APIs | Probe installed AST access first; add in-memory negative controls and explicit runtime/type-only rules | M / MED / HIGH |
| Broad adversarial checklist duplicates feature tests without an evidence ledger | `test/integration/discovery.test.ts`, `safe-read.test.ts`, `parser-worker.test.ts`; `test/unit/discovery-patterns.test.ts` | Inventory named cases first and add only missing evidence, especially application propagation | S / LOW / HIGH |
| Deferred built-CLI SIGINT may require a harness that the plan does not define | 013 Test plan cancellation fallback; `test/helpers/parser-child.ts:237-244` also assumes pipe chunking | Resolve harness feasibility explicitly; no production hooks or timing-based substitutes | M / MED / HIGH |

### Current code exemplars and entry points

Use `test/helpers/filesystem.ts` for temp projects and cleanup, `test/helpers/parse-source.ts` for parser DTO construction, `test/integration/structural-extraction.test.ts` for extraction assertions, and `test/integration/relationships.test.ts` for the real relationship pipeline. The parser helper's `trustedDefaults()` uses test model parameters: application assertions must instead use 013's production defaults or an explicitly declared override. Do not assume helper defaults equal the production profile.

`test/unit/source-metrics.test.ts:1-12` illustrates source imports and type separation:

```ts
import { describe, expect, it } from 'vitest';
import { fileIdentity } from '../../src/domain/canonical.ts';
import type { SourceRange } from '../../src/domain/types.ts';
```

`vitest.config.ts` currently includes every source file and has no thresholds:

```ts
coverage: {
  provider: 'v8',
  reportsDirectory: 'coverage',
  include: ['src/**/*.ts'],
  reporter: ['text', 'lcov'],
},
```

Retain that source inventory and reporting contract. `docs/adr/004-scope-safety.md` and `docs/adr/005-parser-boundary.md` define accepted containment limitations. Follow them: safe bounded reads and a disposable package-owned child are required, while hostile concurrent filesystem mutation and total WASM RSS containment are outside the guarantee.

## Commands you will need

**Reconciliation gate note (2026-10-15 at `5077f1f`):** Plans 001–012 are implemented on `main`; 013–016 remain TODO. Node `24.21.0`, pnpm `11.28.4`; typecheck, lint, format-check (**139 matched files**) and **429 unit tests in 17 files** passed. Fresh-build `test:integration` passed **215 integration/research tests in 10 files**; `schemas:check` passed with committed schemas unchanged. Commands used installed dependencies with `--config.verifyDepsBeforeRun=false`. No frozen install, coverage, dependency advisory lookup or Linux/Windows checks were rerun. The known parser timing concerns did not recur; 014 retains its test-hardening follow-up. No inherited formatting exception remains.

Current production output is the eleven-file inventory in `test/integration/bootstrap-cli.test.ts`: `bin.js`/`.map`, `canonical.js`/`.map`, `index.d.ts`, `index.js`/`.map`, `parser/worker.js`/`.map`, `version.js`/`.map`. The shared `canonical.js` replaces the older `versions.js` chunk, and the substantive library has its own source map. Estimation and reporting native API/purity checks already exist in that suite. Plan 013 permits narrowly reviewed explicit inventory changes when application exports and CLI wiring add shared production code: inspect every actual path/import and use its approved successor inventory. Retain the strict recursive allowlist and worker checks; do not accept arbitrary chunks/test/config artifacts. A new production entry, bundler/dependency-policy change or unexplained artifact requires a focused amendment. Feature-specific tests/scripts below remain future deliverables.

An executor works in its own checkout or worktree, which does not share `node_modules`: run `pnpm install --frozen-lockfile` first and obtain success. Afterwards `pnpm --config.verifyDepsBeforeRun=false run <script>` runs a script without pnpm's implicit dependency reconciliation (it does not repair missing packages). Built-artifact suites run through the build-first wrapper (`pnpm test:integration` / `pnpm test:all`), never against stale `dist/`. This reconciliation did not run `pnpm install --frozen-lockfile` or `pnpm test:coverage`.

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

**Review checks at `5c1effa`:** Node `24.21.0`, pnpm `11.28.4`; typecheck, lint, format-check (139 files) and 429 units pass using installed dependencies. No build, integration, schema, coverage, install, advisory lookup or cross-platform checks were rerun in this focused review. Historical fresh-build results above are not new review evidence.

Feature-specific commands below are execution targets; the shared gates above were verified during this reconciliation.

| Purpose | Command | Expected |
|---|---|---|
| Independent metrics | `pnpm --config.verifyDepsBeforeRun=false run test:integration test/integration/measurement-oracles.test.ts` | exact hand-reviewed counts/edges |
| Metamorphic | `pnpm --config.verifyDepsBeforeRun=false run test:integration test/integration/stability.test.ts` | declared invariants pass |
| Adversarial | `pnpm --config.verifyDepsBeforeRun=false run test:integration test/integration/adversarial.test.ts` | budgets/paths/IPC/errors terminate safely |
| E2E | `pnpm --config.verifyDepsBeforeRun=false run test:integration test/e2e` | 0 |
| Boundary controls | `node scripts/check-boundaries.mjs --self-test` | 0; positive and negative scanner controls pass |
| Boundary check | `pnpm boundaries:check` | 0, allowed layering/no runtime network imports |
| Coverage | `pnpm test:coverage` | reviewed branch coverage gates pass |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm schemas:check` | 0 |

## Scope

**In scope:** `test/helpers/**`, `test/unit/**/*.test.ts` (meaningful additive coverage cases for the named critical layers only; preserve existing assertions and frozen `model-spec.test.ts`), `test/integration/{measurement-oracles,stability,adversarial}.test.ts`, `test/integration/parser-worker.test.ts` (trusted harness synchronization only), `test/integration/application.test.ts` (removing the `staggerStart` workaround only), `test/e2e/cli.test.ts` (extend cross-cutting cases), `test/fixtures/**`, `test/golden/**` (only reviewed additions), `scripts/check-boundaries.mjs`, `vitest.config.ts`, `package.json` (verification scripts), `docs/testing.md`, 014 status row.

**Out of scope:** production behavior changes/refactors, production compiler or network dependencies, fetching entire repositories in CI, effort benchmark fitting, vulnerability detection, silently updating existing approved golden/model expectations.

## Git workflow

Use supplied checkout. No commits/pushes/publication or branch changes without operator instruction.

## Steps

### Step 0: Build a case-to-test evidence ledger

Create `docs/testing.md` before adding suites. For each requirement below record: contract/limit name, exact test path and test name, layer, independently specified expected outcome, current-platform result, and any platform skip with reason. Reuse existing tests when their assertions meet the contract. Do not duplicate cap tests solely to put them in `adversarial.test.ts`; add application-level propagation cases where lower-layer evidence is insufficient. At completion no mandatory row may remain unmapped or silently skipped.

Seed the ledger from source/structural/aggregate unit tests; discovery, safe-read, imports, relationships and parser-worker integration tests; parser-protocol and discovery-patterns unit tests; readiness/LCOV tests; and 013's application/E2E tests. Preserve frozen model-spec/estimation numerical cases. List each `AnalysisLimits` field in `src/domain/types.ts`, config byte bounds in `src/config/load.ts`, and protocol frame/session ceilings in `src/parser/protocol.ts`/`adapter.ts`. For deterministic count/byte caps record exact-at-cap acceptance and cap-plus-one rejection where the contract permits; for deadlines record stage, cutoff, kill and reap, not exact milliseconds. Distinguish optional-readiness failures from required-analysis incompleteness.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test` → existing units pass; inspect the ledger against the named limit definitions and test assertions before proceeding. The ledger's final rows must cite tests that actually ran, not planned test names.

### Step 1: Complete licensed, representative fixture infrastructure

Maintain `test/fixtures/manifest.json` with relative fixture path, original/upstream provenance, author/license, verified source tag/commit **only if real**, parser grammar expectations, hand-counted lines/declarations/decisions and relationship expectations. Prefer original tiny ERC20-like token, vault/math, access-controlled, proxy/upgrade, interface/library, Foundry and Hardhat-shaped projects. They are test shapes, not claims of compiled/audited implementations. For copied upstream snippets retain license/header and pinned source citation; no invented commit SHA or proprietary audit code. Fixtures stay local/offline; no install/build/test of fixture projects. Preserve existing manifest keys and add a separate `measurementOracles` collection for new oracle metadata; retain `fixtures` as the parser research suite's Solidity-only registry. Register every new Solidity source there with the existing required grammar/provenance fields, and put JSON/LCOV/expected-site lists only in suitable metadata collections. `measurement-oracles.test.ts` must validate registration, unique paths, on-disk existence and consistency of each new oracle's enumerated sites/lines/edges with its literal totals. Use original small fixtures to cover each named shape without copying an external repository. Keep new coverage artifacts under a non-ignored path such as `test/fixtures/readiness-data/`; verify `git check-ignore <new-path>` exits 1. Do not force-add ignored paths or change `.gitignore`.

Existing `MIT (proposed)` entries are provisional provenance, not evidence of a repository license grant. Record original authorship honestly; do not relabel existing or copied material as approved MIT. Unknown copied provenance/license is a STOP. Owner licensing decisions remain 015 work.

Create hand-reviewed oracle cases separate from golden outputs; reviewers enumerate contributing line IDs/node sites/edge identities. Add free functions, old constructor/fallback, supported modern grammar, complex inheritance/import aliases, custom builtin-name decoys and partially parseable source. Obtain latest supported grammar from the installed Slang API and assert against that set; preserve explicit historical-version fixtures. Never calculate expected line/node/edge totals from production extraction. Raw parser traversal `visitedNodes` is a resource counter, not a stable semantic node oracle; enumerate declaration/decision sites and graph edges instead.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test:integration test/integration/measurement-oracles.test.ts` → 0; every fixture has manifest provenance and explicit expected facts, no self-generated expected values.

### Step 2: Verify metamorphic stability with declared exceptions

For every transform define the compared fields and the fields allowed to change before running the implementation. Use these minimum cases:

| Transform | Required invariants | Allowed differences / restrictions |
|---|---|---|
| Insert comment-only/blank lines between tokens | Source-line, declaration, decision, call and graph counts; effort | Physical lines, byte hashes, ranges, byte-offset IDs and evidence fingerprints change. Do not insert inside strings or token spellings. |
| LF ↔ CRLF, with the same trailing-newline policy | Line counts, structural counts, normalized edge topology and effort | Bytes, hashes, byte ranges and IDs can change; “all metrics” equality is not required. |
| Rename a plain local variable | Structural counts and normalized topology | Restrict to a variable unused by recognizers and no shadowing/overloads; labels, hashes and offsets may change. |
| Change creation/enumeration order; relocate identical project | Canonical serialized envelope for identical relative paths, bytes, semantic config and versions | Do not normalize away unexpected fields; no absolute paths may appear. |
| Repeat shared imports / add hardlink alias | Unique physical-file accounting and no duplicate semantic edges | Compare selected representatives/ownership under the documented alias policy; extra import sites/aliases can change diagnostics, paths and hashes. |
| Copy identical source bytes to a distinct file | Two physical identities counted separately | Do not content-deduplicate; the aggregate/estimate may change. |
| Two contracts share one source line | File SLOC is a line-set union, never sum of contract SLOC | Reflow may change SLOC and effort; document this limitation. |
| Format/color/output destination changes | Analysis, semantic config fingerprint and effort | Rendered strings differ; compare CLI stdout/file bytes only within a fixed format. |
| Optional readiness metadata changes | Same required-analysis completeness and numerical effort for identical measured facts | Readiness/diagnostics may change; changing configured LCOV path intentionally changes semantic config hash (013 contract). |

Compare graph topology by hand-labelled declaration endpoints/site ordinals for transforms that shift byte IDs. Do not compare raw IDs or scrub the entire envelope indiscriminately. Have each case assert the expected changed fields as well as invariant fields.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test:integration test/integration/stability.test.ts` → 0 with independent before/after invariants and documented fingerprint exceptions.

### Step 3: Exercise resource, filesystem and parser failures

Use bounded generated sources/temp trees with reduced limits, not giant committed payloads. Cover file/total/entry/depth/import/node/edge/component/pattern/LCOV caps; invalid UTF-8/BOM/CRLF; nested syntax; malformed trees; version mismatch; missing/read-denied file; source mutation detection; symlink/hardlink/junction/cycle/outside-root/sibling-prefix paths; ambiguous remappings; oversized/malformed IPC; trusted stalled/crashed worker; cancellation/cleanup; output overwrite guards. Assert diagnostic/exit/partial envelope plus untouched external sentinel/source, no live worker/open test handle. Do not provide runnable misuse payloads in user docs; benign focused fixtures suffice.

Include `maxGlobStates` exhaustion and rejected multi-star filename segments; verify standalone multiple globstars use bounded dynamic-programming states and cannot stall the parent in an unconstrained path regexp. Deadline checks alone do not interrupt synchronous regexp matching, so test the restricted matcher policy itself.

**013 hand-off (2026-10-15, approved worktree `4a2100e`):** the pre-existing test `isolated parser worker` › "isolation and deadlines: kills and reaps stalled children on timeout, cancellation, and close" (`test/integration/parser-worker.test.ts:835-847`) is racy by construction. It sets `parseTimeoutMs: 100`, then awaits `stageBarrier('startup')`, but an idle child takes about 62–69 ms to emit `stage:startup`; under suite load the 100 ms cutoff kills the child first and the barrier rejects. With 12 integration files (after 013) it failed in about 40–60% of full runs when unmitigated. 013 masked it with an 8-second `staggerStart()` sleep in `test/helpers/run-cli.ts`, called from `beforeAll` in `test/integration/application.test.ts` and `test/e2e/cli.test.ts` (which also moved their heavy imports to lazy `await import(...)`). Required here: (1) make that timeout case deterministic without lengthening sleeps, for example by letting a startup-stage barrier failure count as acceptable when the session reports `LIMIT_EXCEEDED` and the child is reaped, or by stalling only after a trusted startup handshake so the cutoff cannot fire before the barrier; keep the kill/reap assertions. (2) Delete `staggerStart` and its two call sites, restoring static imports in those two files. (3) Show at least 10 consecutive green `pnpm --config.verifyDepsBeforeRun=false run test:integration` runs and record the count in the ledger. If (1) cannot be made deterministic without a production change, STOP with the missing seam rather than keeping the stagger.

Before deadline/duplicate test hardening, inspect `stageBarrier` in `test/integration/parser-worker.test.ts` and `runSemanticReply` in `test/helpers/parser-child.ts`. Its current single-write guarantee is invalid for OS pipes. Use the existing test-only session factory and a trusted controlled stream/observer barrier if it can make the tested ordering explicit. If the required ordering cannot be observed without production changes, STOP with the exact missing seam; increasing sleeps, retries or assuming one write is one data event is not a repair. Set generous outer watchdogs independently of deliberately short worker cutoffs; cleanup must run in `finally` and await close before temp-tree removal.

If 013 deferred built-CLI SIGINT, first demonstrate a test-owned harness can pause the real built CLI after its signal handler is installed and before completion, then signal and assert exit 130, one valid JSON error envelope, and child cleanup. A test-owned Node preload/loader may be considered only if it wraps a fixed package-owned worker launch without changing production files/environment policy or loading anything from the analyzed root. Record the exact mechanism in the ledger. The production child must still receive its sanitized environment. If no deterministic harness is feasible, STOP and report the missing seam; do not mark 014 DONE using only API abort evidence or a signal sent at an arbitrary delay.

Test runtime imports/boundaries with a trusted script checking actual import graph/known API uses using the installed TypeScript AST API over this codebase, not fragile substring assertions alone. Forbid runtime source layers from loading network modules, eval/Function, project-derived dynamic imports or shell execution. Allow only fixed package-owned worker spawn and built CLI test children; no blanket ban on child_process that would reject required isolation. Check estimator/formatters remain pure. This is a review aid, not proof arbitrary dependency code never accesses network.

Scanner implementation contract for `scripts/check-boundaries.mjs`:

- Scan only this package's trusted `src/**/*.ts`, never target-project config/source. Follow relative runtime imports/re-exports transitively, ignore `import type`/type-only specifiers, and fail on unresolved runtime paths or unsupported computed loading. Normalize bare and `node:` builtin names.
- Start with the installed TS7 APIs: root `typescript` is version metadata, not the old `createSourceFile` API. Probe `typescript/unstable/sync` plus `typescript/unstable/ast`/visitor against this package's tsconfig, close the API/snapshot in `finally`, and document the exact version/API used. The current package exports these paths. If they cannot provide a usable AST, STOP with a concrete dependency/tooling amendment instead of silently replacing syntax checks with regex or adding an unreviewed parser. Do not execute target-project programs or load their tsconfig.
- Explicit runtime capability map: pure estimator/reporters may reach only their own modules and the existing domain closure (`canonical`, `schemas`, `types`, `versions`) with `zod`/`node:crypto`; metrics may reach its pure parser protocol/constants, not adapter/worker; parser implementation may load fixed Slang paths. Config/discovery/readiness/application/CLI have documented filesystem/process roles; they are not globally pure. Keep side-effect-free library import separate from call-time analysis I/O.
- Reject network builtin imports (`net`, `http`, `https`, `http2`, `tls`, `dns`, `dgram`), `fetch`/WebSocket, eval/Function constructors, shell/exec APIs, and computed project-derived module loading. Trace ordinary named/namespace imports and aliases used by checks; fail closed on unsupported indirection at capability sites. Allow `createRequire`/manifest reads only at reviewed package-owned sites such as `src/parser/worker.ts`; inspect the exact literals and `require.resolve` use. Do not allow arbitrary `require` globally.
- Permit only the reviewed `spawn` site in `src/parser/adapter.ts` with Node executable, fixed worker path, `shell:false` and sanitized environment. Trusted test/script child launches are outside the runtime graph, not a blanket runtime exemption. Inventory any new capability introduced by completed 013 before approving it.
- Provide `--self-test` with in-memory trusted snippets/virtual graph fixtures. Positive controls: type-only forbidden-module import, comments/string literals mentioning APIs, permitted crypto closure and owned-worker launch. Negative controls: named and namespace/alias network use, global fetch, transitive forbidden import/re-export, computed import/require, eval/Function, unapproved spawn and a pure layer reaching filesystem or CLI. Assert each negative fails for its intended diagnostic; default scanning must exit nonzero on violations. No temporary mutation of real `src` files. Add `boundaries:check` as `node scripts/check-boundaries.mjs`.

Preserve existing bootstrap artifact/purity assertions. Scanner negative controls complement them; no broad weakening or production inventory update is in scope here.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test:integration test/integration/adversarial.test.ts`, `pnpm boundaries:check` → 0, each cap/error class checked. Explicitly report unsupported current-platform link/junction permissions rather than claiming full Windows coverage.

### Step 4: Establish meaningful coverage and platform verification contract

Preserve the approved unit-only `pnpm test:coverage` command. Configure matching V8 coverage for source code directly instrumented by unit tests in `src/domain`, `metrics`, `estimation`, `discovery`, `config`, `relationships`, `indicators`, `reporting`, `application`, `cli`. Enforce four separate aggregate glob groups using Vitest's installed `coverage.thresholds` syntax: `src/estimation/**` and `src/metrics/**` each `{ lines: 95, branches: 90 }`; `src/config/**` and `src/discovery/**` each `{ lines: 90, branches: 85 }`. Set `autoUpdate: false` and group `perFile: false`; these are mandatory thresholds, not aspirational goals or a single pooled percentage. Preserve `include: ['src/**/*.ts']` so parser and other source coverage remains visible; record all other directory results without inventing unspecified mandatory percentages. Every group must match files and show nonempty line/branch data. Use installed Vitest type declarations as the configuration contract, then run TS7 and the coverage command. In `docs/testing.md` record measured group results and the final settings. Do not count integration/E2E execution toward the unit coverage report or weaken thresholds to compensate; add meaningful source unit tests. Do not count parser child code as covered simply because parent tests ran; child boundary requires explicit behavior tests and optionally trusted NODE_V8_COVERAGE instrumentation in test harness. Exclude declarations/test files/generated schemas, not hard-to-test branches. If thresholds expose real untested cases, add meaningful assertions; do not merely lower gates or mirror implementation.

Document current-platform results and future matrix: maintained Node 24.11+ × ubuntu/macos/windows, platform-specific path/link tests and built/packed artifact smoke. 015 configures actual CI. 014 can be DONE on the local platform with cross-platform test definitions; release readiness remains blocked until actual 015 matrix passes. Keep timing/RSS benchmarks advisory outside canonical golden data; no elapsed-time assertions beyond bounded kill/controller tests with generous scheduling margin.

**Verify:** `pnpm test:coverage`, built e2e, oracle/stability/adversarial/boundary suites, type/lint/full/schema gates → 0 locally; `docs/testing.md` names unrun platforms and required CI gates.

## Test plan

Independent fixture oracles are the main accuracy check for **metrics**, followed by version/grammar matrix and metamorphic properties. No solc executable/download is required. Future optional differential checks can use an independently installed trusted compiler, but would need a separate plan. Effort accuracy requires 010 historical protocol, not synthetic software tests. Goldens need human semantic review before updates.

## Done criteria

- [ ] All listed local suites/coverage/type/lint/schema/build/boundary commands exit 0; boundary self-tests reject every named negative control.
- [ ] Fixture manifest and independent line/node/graph evidence exist for representative cases.
- [ ] `docs/testing.md` maps every named limit/error/partial contract to an exact executed test and expected outcome; supported link/permission tests ran, unsupported platform cases have explicit reasons. Deferred built-CLI SIGINT is completed or 014 remains blocked with the missing seam reported.
- [ ] No self-generated oracle or silently blessed golden drift; current platform and unrun platforms documented.
- [ ] No production/outside-scope changes; 014 status updated and release matrix requirement retained.

## STOP conditions

Stop if a production defect needs out-of-scope repair, independent counts disagree without understood cause, CI tests need runtime network/target scripts, fixture provenance/license is unknown, coverage thresholds require fake assertions, worker leaks remain, or a gate fails twice. Report a focused bug/fix plan; don't silently change model coefficients/metric definitions.

## Maintenance notes

### Focused resumption plan — serial hostile-child test watchdog

This is a test-harness follow-up discovered during execution, not evidence of a
production defect. No repair was implemented after the STOP condition.

The executor reported two full integration failures: an added LCOV entry
conflicted with the existing exact readiness-fixture list (fixed by moving its
metadata to `measurementArtifacts`), then, after five consecutive green fresh
builds, run six exceeded Vitest's default 5-second timeout in
`test/integration/parser-worker.test.ts`, test
`rejects forged candidates, ownership, coverage, identities and counters`.
The latter passed alone in approximately 2.9 seconds. The executor did not save
full-run logs, so those results are executor-reported rather than independently
reproduced reviewer evidence. The cause is consistent with scheduling pressure;
the isolated pass does not prove that no other timing issue exists.

Reviewer inspection confirms that this single test serially exercises fourteen
hostile semantic replies, preparing syntax and starting a fresh semantic child
for each case, but has no explicit outer Vitest timeout. Its actual parser and
semantic job cutoffs remain 2 seconds and 10 seconds respectively. Step 3 already
requires generous outer watchdogs separate from the deliberate worker cutoffs.

On a subsequent execution:

1. Reconcile the main checkout and reuse the existing isolated worktree only
   after confirming its base and all uncommitted paths. Preserve the partial
   implementation and pre-existing main-checkout plan edits. Do not rebuild this
   work from an unamended committed copy of 014.
2. In that one named parser-worker test, set an explicit outer Vitest timeout of
   `60_000` ms. Keep all fourteen forged-reply cases, expected protocol results,
   charged-node/cached-syntax assertions, child-reaping checks and `finally`
   cleanup intact. This is narrowly within Step 3's test synchronization scope.
   Do not change production code, real worker cutoffs, concurrency settings,
   delays, retries or the removed stagger workaround. If inspection reveals a
   worker leak or another production problem, STOP and report it separately.
3. Run the fresh-build parser-worker suite, then restart the ten-consecutive-full-
   integration count from zero. Save stdout/stderr and exit status for every run
   under the ignored `.vitest/plan014/` directory. Do not call five prior passes
   a completed ten-run gate.
4. Complete the still-draft `docs/testing.md` ledger with exact executed tests,
   outcomes, current-platform skips/reasons, all directory coverage results and
   the scanner API/fingerprint maintenance contract. Its pending rows must not
   be silently marked complete from an aggregate suite count. Preserve the
   three original readiness entries and all original fixture metadata.
5. Run every original final gate, including source units, enforced unit coverage,
   `test:all`, typecheck, lint, format-check, schema check, AST self-tests and
   boundary scan. Obtain a new independent review before marking 014 DONE.

The partial work also reached the configured four coverage thresholds in the
saved V8 report: estimation 187/188 lines and 174/189 branches; metrics 289/296
and 171/189; config 247/258 and 283/316; discovery 1001/1053 and 826/971.
The reviewer independently read those counters and verified original fixture
metadata preservation and an empty production/dependency/schema/model diff.
Final full regression, ledger completion and ten-run stability remain pending.
Linux and Windows evidence and packed-artifact release gates remain 015 work.

Add a counterexample oracle for every measurement bug or grammar upgrade. Retain old golden/metric versions when semantics change. Distinguish software safety/measurement tests from calibration evidence and platform tests that have actually run.
