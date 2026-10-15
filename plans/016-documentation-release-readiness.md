# Plan 016: Document the product and satisfy reviewable MVP readiness gates

> **Executor instructions:** Document actual implemented behavior and verify every runnable example. Do not invent release identity or claim unrun CI/calibration. Update status 016 in `plans/README.md`; publishing remains separately authorized.
>
> **Drift check first:** Reconciled at `9b0bfe7` on 2026-10-15. Run `git status --short`, `git diff --stat 9b0bfe7..HEAD -- README.md CONTRIBUTING.md SECURITY.md AGENTS.md docs examples package.json test/e2e/documentation.test.ts`, and `git diff HEAD -- README.md CONTRIBUTING.md SECURITY.md AGENTS.md docs examples package.json test/e2e/documentation.test.ts` (plus inspect untracked in-scope files). Check prerequisite statuses and the current-state snapshot below. Expected completed-prerequisite additions require inspection; contradictory contracts or unrelated local edits require reconciliation before implementation.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** LOW (documentation truth and open-source governance)
- **Depends on:** `plans/015-packaging-ci-release.md`
- **Category:** docs / direction
- **Planned at:** commit `9b0bfe7`, reconciled 2026-10-15; originally greenfield planning on 2026-10-14.

## Why this matters

Auditors need to know exactly what was counted, which assumptions produced a range and what remains a human judgment. Contributors need tested commands and compatibility rules. A release checklist prevents technical preparation from being mistaken for an approved, calibrated or already published product.

## Current state and architectural context

### Reconciled implementation baseline — 2026-10-15

Root `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, a license and public release identity are still absent. `AGENTS.md`, three accepted ADRs, `docs/dependencies.md` and the Slang research report now exist. Preserve their actual toolchain, domain and CLI/config decisions. Root package remains private `audit-estimator@0.1.0`; no publication is established.

Only plans 001–004 are implemented: the current CLI has command/help/config contracts and deliberately reports the unavailable handler for analysis. Do not write current-tense estimate examples until 013–015 actually provide and verify them. `docs:check`, `check`, `test:package` and documentation examples are still proposed future capabilities. `src/index.ts` currently exports versions and domain types only. Extend documentation around the eventual reviewed implementation and explicit pending owner/platform gates; the empty-directory statements below describe original planning history, not today's scaffold.

Match established strict ESM conventions: `.ts` source imports, explicit named exports and exported annotations, `import type`, readonly DTOs, no `any` or suppressions, unknown caught values narrowed before use. Tests use Vitest source imports for units and the trusted build-first integration wrapper for artifact suites. These current facts supersede prospective wording in the original context below.

### Original design context (retained)

No README/license/governance existed during planning. Prerequisites should implement local scope/discovery, exact-pinned Slang, pure metrics/model, terminal/JSON/Markdown CLI, package checks and CI preparation. Document actual version/commands from these modules, not assumed Solidity support. Package identity/license/security contact and actual remote CI status can still be owner-controlled pending decisions. Recommend MIT; do not claim a license/contact/repository is approved when absent.

Key terminology: scoped versus context; first-party versus third-party/unknown; measured versus heuristic versus human-assessed; planning scenario range versus statistical confidence; cumulative auditor-hours versus elapsed calendar delivery; complete versus analyzed-subset. Default heuristic is uncalibrated. Pricing/remote/explorer/Slither/other languages are deferred. No vulnerability detection or security assurance claim.

## Commands you will need

**Reconciliation gate note (2026-10-15):** Scripts below exist for typecheck, lint, format-check, source units, build-first integration/all, coverage and schema checks; feature-specific suites and later scripts exist only when their owning plans land. Current main-checkout checks are not green: missing installed Commander/Zod/Slang block typecheck, lint and domain/CLI unit collection. The bootstrap source unit passes (1 test); the other two unit suites fail collection. `pnpm format:check` fails on the same four unchanged `.agents/skills/improve` Markdown files recorded in prior approvals. No new format exception is granted: preserve the exact inherited exception and verify changed artifacts, or arrange a separately scoped fix; any additional failure is a STOP condition.

An executor must first run `pnpm install --frozen-lockfile` in its authorized implementation checkout and obtain success. This reconcile run did not install dependencies. Pnpm 11 attempted automatic installation before scripts and aborted removal of node_modules due to no TTY; do not set CI or approve purge merely to bypass it. With dependencies correctly installed, `pnpm --config.verifyDepsBeforeRun=false run <script>` can run an existing script without implicit dependency reconciliation; it does not repair missing packages. Do not claim schema/build/integration/coverage/frozen-install verification from this reconciliation: those gates were not rerun. Run the prescribed fresh build before any built-artifact test in implementation.

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Proposed prerequisite scripts; these must now actually exist and pass.

| Purpose | Command | Expected |
|---|---|---|
| Examples/docs | `pnpm build` then `pnpm exec vitest run test/e2e/documentation.test.ts` | every committed CLI example passes assertions |
| Documentation checker | `pnpm docs:check` | local links/example/schema references/version facts validated, no network |
| Full release preparation | `pnpm check`, `pnpm test:package`, `pnpm test:coverage` | 0 |
| Installed artifact help | checked by `pnpm test:package` | documented flags match built package |

## Scope

**In scope:** `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` (approved conventional text/contact only), `LICENSE` (only after owner approval), `AGENTS.md` (verification/documentation updates), `docs/{configuration,cli,architecture,limitations,roadmap,release-readiness}.md`, existing `docs/{metrics,indicators,relationships,output-schema,releasing}.md` (consistency fixes), `examples/**`, `test/e2e/documentation.test.ts`, `scripts/check-docs.mjs`, `package.json` (docs:check), 016 status row.

**Out of scope:** application changes/refactors, weights/metric/schema changes, remote deployments/publishing, fake legal/security contacts, issue creation, sending email/messages, claims of achieved accuracy or supported versions not verified by package tests.

## Git workflow

Use supplied checkout. No commits/pushes/publication or branch changes without operator instruction; no observed historical conventions to cite.

## Steps

### Step 1: Write an honest quickstart and scope/config guide

README leads with concrete purpose, supported Node versions and visibly uncalibrated effort range. Installation uses the confirmed npm name only after identity approval; before publication document local packed/development installation and mark registry publication pending. Show `audit-estimator estimate ./contracts`, inspect/explain, exclude glob, JSON/Markdown and safe `--output`; Windows/macOS/Linux shell quoting examples must match supported glob grammar. No remote input example that the MVP cannot execute.

Explain root choice, Foundry default-only metadata and Hardhat convention-only discovery, explicit custom source roots/remappings, dependency ownership promotion, no `.gitignore` auto-application, include/exclude precedence, arrays replacing at higher layers, default exclusions and pruned-tree reporting, symlink option/inside-root boundary, outside-root pnpm store limitation and strict/partial exits. Include actual valid JSON config with model/profile/manual reason and 8-hour day convention, no invented commercial rate. Avoid repository-private paths.

Create small original runnable examples: simple local contract, local Foundry-shaped/custom-root and Hardhat-shaped project, third-party context/dependency, malformed scoped subset and documented manual model adjustment. Each is licensed/attributed and testable without compiler or target dependency installation. Share fixture snippets only if provenance known.

**Verify:** `pnpm exec vitest run test/e2e/documentation.test.ts -t 'quickstart and scope'` → 0, documented scope/include/exclude/config/output commands produce specified results/exits.

### Step 2: Document analysis/model/output boundaries and contributor workflow

Architecture guide includes module responsibilities, one-package choice, child isolation, parent safe reads, no target execution/network/default code transmission, strict types/pure estimator and independent schema/metric/indicator/model versions. Link normative metric/model/relationship docs and explicitly state no compiler-equivalent typing, storage layout, runtime dispatch, economic complexity or vulnerability conclusions. Show manual contribution ledger example from independent worked fixture and describe SLOC layout sensitivity.

CLI/config/output docs enumerate actual help flags, all exit codes, JSON envelope statuses/version compatibility, null/unavailable metrics, partial coverage and deterministic fingerprints. Explain that no statistical confidence/empirical accuracy claim follows from heuristic bounds; effort excludes price/fix re-review unless manually added. Documentation example JSON must validate against generated schemas. Contributor guide specifies pinned pnpm/node setup and actual `pnpm check`, focused tests, fixture oracles, no blind golden updates, supported-platform matrix and dependency/Slang upgrade review. AGENTS keeps safe task boundaries and commands, not inferred permission to publish.

**Verify:** `pnpm exec vitest run test/e2e/documentation.test.ts -t 'schema and formula examples'` → 0; `pnpm docs:check` → local links valid, command flags/config/JSON examples validate, model/metrics versions match code.

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
