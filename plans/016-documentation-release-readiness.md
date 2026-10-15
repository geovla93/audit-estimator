# Plan 016: Document the product and satisfy reviewable MVP readiness gates

> **Executor instructions:** Document actual implemented behavior and verify every runnable example. Do not invent release identity or claim unrun CI/calibration. Update status 016 in `plans/README.md`; publishing remains separately authorized.
>
> **Drift check first:** Reconciled at `5077f1f` on 2026-10-15; plans 001–012 are present on `main`; 013–016 remain TODO. Preserve pre-existing plan edits. Run `git status --short`, `git diff --stat 5077f1f..HEAD -- README.md CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md LICENSE AGENTS.md docs examples scripts/check-docs.mjs package.json test/e2e/documentation.test.ts plans/README.md`, and `git diff HEAD -- README.md CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md LICENSE AGENTS.md docs examples scripts/check-docs.mjs package.json test/e2e/documentation.test.ts plans/README.md` (plus inspect untracked in-scope files). Check prerequisite statuses and the current-state snapshot below. Expected completed-prerequisite additions require inspection; contradictory contracts or unrelated local edits require reconciliation before implementation.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** LOW (documentation truth and open-source governance)
- **Depends on:** `plans/015-packaging-ci-release.md`
- **Category:** docs / direction
- **Planned at:** commit `5077f1f`, reconciled 2026-10-15 after 011/012 reached `main`; supersedes `d012fb9`, `2eb8d3d` and `d11bc60`. Originally greenfield planning on 2026-10-14.

## Why this matters

Auditors need to know exactly what was counted, which assumptions produced a range and what remains a human judgment. Contributors need tested commands and compatibility rules. A release checklist prevents technical preparation from being mistaken for an approved, calibrated or already published product.

## Current state and architectural context

### Reconciled implementation baseline — 2026-10-15 (refreshed at `5077f1f`)

Root `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, a license and public release identity are still absent. `AGENTS.md`, five accepted ADRs (001 toolchain, 002 domain contract, 003 CLI/config, 004 scope safety, 005 parser boundary), `docs/dependencies.md`, the Slang research report, `docs/metrics.md`, `docs/relationships.md`, `docs/indicators.md`, the three `docs/model/` documents, `docs/calibration/protocol.md` and `docs/output-schema.md` now exist. Preserve their actual toolchain, domain and CLI/config decisions. Root package remains private `audit-estimator@0.1.0`; no publication is established.

Plans 001–012 are implemented; discovery and parsing are internal modules not yet wired to commands. The current CLI has command/help/config contracts and deliberately reports the unavailable handler for analysis. Do not write current-tense estimate examples until 013–015 actually provide and verify them. `docs:check`, `check`, `test:package` and documentation examples are still proposed future capabilities. `src/index.ts` exports versions/domain types, `estimateEffort`, `selectModel`, `EstimationError` and its reason type, `serializeJson`, `formatTerminal` with its options type, and `formatMarkdown`; `analyzeProject` remains a 013 deliverable. Extend documentation around the eventual reviewed implementation and explicit pending owner/platform gates; the empty-directory statements below describe original planning history, not today's scaffold.

Match established strict ESM conventions: `.ts` source imports, explicit named exports and exported annotations, `import type`, readonly DTOs, no `any` or suppressions, unknown caught values narrowed before use. Tests use Vitest source imports for units and the trusted build-first integration wrapper for artifact suites. These current facts supersede prospective wording in the original context below.

### Implemented documentation baseline after 011/012

`docs/metrics.md` now fixes metrics `1.0.0`; `docs/relationships.md` documents import lookup, physical identity, components, semantics, builtin confirmation, pair accounting and completeness. ADR 005 includes protocol version 2 semantic jobs. Preserve those reviewed limitations: internal calls have unproven dynamic dispatch, user-defined storage refinement is deferred, builtin candidates may remain unavailable, and a V8 heap flag is not an RSS limit. 009’s `docs/indicators.md` now documents eight supported rules, eight unanswered prompts, bounded test/coverage inspection and matched-subset/unverified-artifact coverage. `docs/model/heuristic-v1.md` freezes single-input engine DTOs, unavailable-channel rules, rounded-ledger reserve order and result bounds; alternatives/limitations and consented calibration docs exist. Preserve their meanings and immutable fixture totals. Model, parser and metric versions remain independent. The engine and renderers are now public library APIs with independent unit/native tests. `docs/output-schema.md` records renderer ordering, sanitization and current-schema validation; preserve it. Discovery, parser, relationship and indicator modules remain internal, and analysis commands still use the unavailable handler until 013. Public docs/examples/CI/release artifacts remain future work; do not translate completed module status into a claim of a usable released CLI.

### Original design context (retained)

No README/license/governance existed during planning. Prerequisites should implement local scope/discovery, exact-pinned Slang, pure metrics/model, terminal/JSON/Markdown CLI, package checks and CI preparation. Document actual version/commands from these modules, not assumed Solidity support. Package identity/license/security contact and actual remote CI status can still be owner-controlled pending decisions. Recommend MIT; do not claim a license/contact/repository is approved when absent.

Key terminology: scoped versus context; first-party versus third-party/unknown; measured versus heuristic versus human-assessed; planning scenario range versus statistical confidence; cumulative auditor-hours versus elapsed calendar delivery; complete versus analyzed-subset. Default heuristic is uncalibrated. Pricing/remote/explorer/Slither/other languages are deferred. No vulnerability detection or security assurance claim.

## Commands you will need

**Reconciliation gate note (2026-10-15 at `5077f1f`):** Plans 001–012 are implemented on `main`; 013–016 remain TODO. Node `24.21.0`, pnpm `11.28.4`; typecheck, lint, format-check (**139 matched files**) and **429 unit tests in 17 files** passed. Fresh-build `test:integration` passed **215 integration/research tests in 10 files**; `schemas:check` passed with committed schemas unchanged. Commands used installed dependencies with `--config.verifyDepsBeforeRun=false`. No frozen install, coverage, dependency advisory lookup or Linux/Windows checks were rerun. The known parser timing concerns did not recur; 014 retains its test-hardening follow-up. No inherited formatting exception remains.

Current production output is the eleven-file inventory in `test/integration/bootstrap-cli.test.ts`: `bin.js`/`.map`, `canonical.js`/`.map`, `index.d.ts`, `index.js`/`.map`, `parser/worker.js`/`.map`, `version.js`/`.map`. The shared `canonical.js` replaces the older `versions.js` chunk, and the substantive library has its own source map. Estimation and reporting native API/purity checks already exist in that suite. Plan 013 permits narrowly reviewed explicit inventory changes when application exports and CLI wiring add shared production code: inspect every actual path/import and use its approved successor inventory. Retain the strict recursive allowlist and worker checks; do not accept arbitrary chunks/test/config artifacts. A new production entry, bundler/dependency-policy change or unexplained artifact requires a focused amendment. Feature-specific tests/scripts below remain future deliverables.

An executor works in its own checkout or worktree, which does not share `node_modules`: run `pnpm install --frozen-lockfile` first and obtain success. Afterwards `pnpm --config.verifyDepsBeforeRun=false run <script>` runs a script without pnpm's implicit dependency reconciliation (it does not repair missing packages). Built-artifact suites run through the build-first wrapper (`pnpm test:integration` / `pnpm test:all`), never against stale `dist/`. This reconciliation did not run `pnpm install --frozen-lockfile` or `pnpm test:coverage`.

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Feature-specific commands below are execution targets; the shared gates above were verified during this reconciliation.

| Purpose | Command | Expected |
|---|---|---|
| Examples/docs | `pnpm --config.verifyDepsBeforeRun=false run test:integration test/e2e/documentation.test.ts` | every committed CLI example passes assertions |
| Documentation checker | `pnpm docs:check` | local links/example/schema references/version facts validated, no network |
| Full release preparation | `pnpm check`, `pnpm test:package`, `pnpm test:coverage` | 0 |
| Installed artifact help | checked by `pnpm test:package` | documented flags match built package |

## Scope

**In scope:** `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` (approved conventional text/contact only), `LICENSE` (only after owner approval), `AGENTS.md` (verification/documentation updates), `docs/{configuration,cli,architecture,limitations,roadmap,release-readiness}.md`, `docs/adr/002-domain-contract.md` (stale summary corrections only: actual EstimateInput has no syntax flag; root exports now include engine/reporting and later application APIs; current build includes the worker and approved shared production artifacts), existing `docs/{metrics,indicators,relationships,output-schema,releasing}.md` (consistency fixes), `examples/**`, `test/e2e/documentation.test.ts`, `scripts/check-docs.mjs`, `package.json` (docs:check), 016 status row.

**Out of scope:** application changes/refactors, weights/metric/schema changes, remote deployments/publishing, fake legal/security contacts, issue creation, sending email/messages, claims of achieved accuracy or supported versions not verified by package tests.

## Git workflow

Use supplied checkout. No commits/pushes/publication or branch changes without operator instruction; no observed historical conventions to cite.

## Steps

### Step 1: Write an honest quickstart and scope/config guide

README leads with concrete purpose, supported Node versions and visibly uncalibrated effort range. Installation uses the confirmed npm name only after identity approval; before publication document local packed/development installation and mark registry publication pending. Show `audit-estimator estimate ./contracts`, inspect/explain, exclude glob, JSON/Markdown and safe `--output`; Windows/macOS/Linux shell quoting examples must match supported glob grammar. No remote input example that the MVP cannot execute.

Explain root choice, Foundry default-only metadata and Hardhat convention-only discovery, explicit custom source roots/remappings, dependency ownership promotion, no `.gitignore` auto-application, include/exclude precedence, arrays replacing at higher layers, default exclusions and pruned-tree reporting, symlink option/inside-root boundary, outside-root pnpm store limitation and strict/partial exits. Include actual valid JSON config with model/profile/manual reason and 8-hour day convention, no invented commercial rate. Avoid repository-private paths.

Create small original runnable examples: simple local contract, local Foundry-shaped/custom-root and Hardhat-shaped project, third-party context/dependency, malformed scoped subset and documented manual model adjustment. Each is licensed/attributed and testable without compiler or target dependency installation. Share fixture snippets only if provenance known.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test:integration test/e2e/documentation.test.ts -t 'quickstart and scope'` → 0, documented scope/include/exclude/config/output commands produce specified results/exits.

### Step 2: Document analysis/model/output boundaries and contributor workflow

Architecture guide includes module responsibilities, one-package choice, child isolation, parent safe reads, no target execution/network/default code transmission, strict types/pure estimator and independent schema/metric/indicator/model versions. Link and preserve normative metric/model/relationship/indicator/calibration docs; correct ADR 002’s historical summary to the actual eligible-file DTO and built production entries without changing the accepted architecture. Explicitly state no compiler-equivalent typing, storage layout, runtime dispatch, economic complexity or vulnerability conclusions. Show manual contribution ledger example from independent worked fixture and describe SLOC layout sensitivity.

CLI/config/output docs enumerate actual help flags, all exit codes, JSON envelope statuses/version compatibility, null/unavailable metrics, partial coverage and deterministic fingerprints. Explain that no statistical confidence/empirical accuracy claim follows from heuristic bounds; effort excludes price/fix re-review unless manually added. Documentation example JSON must validate against generated schemas. Contributor guide specifies pinned pnpm/node setup and actual `pnpm check`, focused tests, fixture oracles, no blind golden updates, supported-platform matrix and dependency/Slang upgrade review. AGENTS keeps safe task boundaries and commands, not inferred permission to publish.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test:integration test/e2e/documentation.test.ts -t 'schema and formula examples'` → 0; `pnpm docs:check` → local links valid, command flags/config/JSON examples validate, model/metrics versions match code.

### Step 3: Prepare responsible open-source governance and roadmap

SECURITY explains safe issue reporting procedure with **confirmed** contact/channel; if absent, prominently mark owner decision pending and do not invent email/repo URL. Describe this tool's own security scope separately from vulnerabilities in analyzed contracts. Recommend MIT, provide license only after owner approval, preserve fixture/upstream notices and dependency-license records. No outbound messages or external account setup.

Roadmap groups post-MVP by prerequisite: safe remote Git acquisition/archive handling first, explorer multi-file verified metadata/network trust next, optional isolated Slither/compiler adapter after execution policy, richer dependency/protocol analysis with tested evidence, consented calibration tooling/data before accuracy claims, pricing/proposal adapter after explicit currency/day-rate/commercial scope, dedicated CI action/policy integration after stable JSON. Pricing future API consumes effort + explicit currency/rate/hours-per-day/commercial ranges and labels price as nonbinding scenario; it must not change technical effort or invent universal rates. No plugin system until multiple real adapters justify it.

**Verify:** `pnpm docs:check` → 0 for confirmed fields or explicit pending markers; documentation tests assert deferred features aren't in current command help and no uncalibrated profile is called validated.

### Step 4: Record actual release evidence and owner-controlled pending gates

Write `docs/release-readiness.md` with machine-readable table/status values for local type/lint/test/schema/boundary/coverage/package/docs gates, parser compatibility/fixture evidence, platform CI result references if real, package identity/license/contact approval, reachable advisory review, changelog, owner-reviewed heuristic label and authorized release operator/OIDC setup. Do not convert unknown to passed. Run all local gates once after final docs/config/example changes; do not repeatedly broaden tests without a new failure.

If real remote matrix/owner approvals are missing, status is **MVP implementation prepared; public release pending <specific gates>**, not production-released. Plans 015/016 preparation may be DONE while release table remains pending. Publishing requires a later explicit operator action. Summarize implemented MVP and honest limits to the operator, without claiming a benchmark error percentage.

**Verify:** `pnpm build`, documentation tests, `pnpm docs:check`, `pnpm check`, `pnpm test:coverage`, `pnpm test:package` → 0; readiness table references actual logs/status and pending owner/platform items.

## Test plan

Execute committed CLI examples in temp copied projects using built/packed tool, validate JSON/config schema and known simple estimate values, exact scope/report output and intentional exit4 subset. Docs checker uses local links/structured manifest/CLI help output, no external link fetch. Link text alone is not verification of installed commands. Compare claimed supported versions with 002/006 runtime compatibility evidence.

## Done criteria

- [ ] Every documented runnable example, docs/check/full/coverage/package gate passes locally.
- [ ] Purpose, scope, metrics/model/formulas/manual adjustments, uncertainty, JSON compatibility and exits are documented.
- [ ] No invented source evidence/release identity/license/contact/accuracy or unrun platform claims.
- [ ] MVP/deferred roadmap and actual release-pending gates are explicit; approved governance fields present or pending.
- [ ] No application/outside-scope/publication edits; 016 status updated.

## STOP conditions

Stop dependent public-release steps if owner identity/license/contact or real CI evidence is missing; continue unaffected docs/examples and mark pending. Stop implementation-related doc changes if real commands/formula/schema contradict the plan, example needs target script/remote execution, expected numbers lack independent evidence, or a gate fails twice. Request a focused implementation correction rather than writing around a defect.

## Maintenance notes

Generate/validate examples against actual versioned contracts each release. Update Node/Slang support, fixtures and output compatibility together. Calibration/privacy/governance changes need owner review; a README accuracy sentence never substitutes for a reproducible held-out evaluation.
