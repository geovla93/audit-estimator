# Plan 012: Render complete, stable terminal, JSON and Markdown reports

> **Executor instructions:** Implement pure report rendering only; file writes/command wiring belong to 013. Verify each gate and update status 012 in `plans/README.md`. Do not hide uncertainty or present effort as a quotation.
>
> **Drift check first:** Reconciled at `9b0bfe7` on 2026-10-15. Run `git status --short`, `git diff --stat 9b0bfe7..HEAD -- src/reporting src/index.ts src/domain src/estimation test/golden`, and `git diff HEAD -- src/reporting src/index.ts src/domain src/estimation test/golden` (plus inspect untracked in-scope files). Check prerequisite statuses and the current-state snapshot below. Expected completed-prerequisite additions require inspection; contradictory contracts or unrelated local edits require reconciliation before implementation.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED (automation compatibility and misunderstood output)
- **Depends on:** `plans/003-domain-contracts-schemas.md`, `plans/007-source-structural-metrics.md`, `plans/008-imports-inheritance-interactions.md`, `plans/009-effort-indicators.md`, `plans/011-estimation-engine.md`
- **Category:** direction / dx
- **Planned at:** commit `9b0bfe7`, reconciled 2026-10-15; originally greenfield planning on 2026-10-14.

## Why this matters

Users must be able to review the exact scope, measured evidence and contribution of assumptions. Stable JSON enables automation; terminal and Markdown make the same result understandable without recomputing or changing the model.

## Current state and architectural context

### Reconciled implementation baseline — 2026-10-15

`src/reporting/` is absent. Strict `ReportEnvelope` and generated schemas already exist; examples are `test/fixtures/domain/{complete,partial,error,populated}.json`. Use them as structural exemplars without treating their arbitrary numeric values as model oracles. `src/domain/canonical.ts` already provides compact canonical JSON and preserves array order; add pretty rendering and explicit semantic collection ordering in the renderer without changing domain canonicalization.

The existing public ledger uses `contributions` with `explanation`, not structured formula/evidence fields or a precise-total property. Show integer contribution values, explanations and `estimate.parameters`; compute display-only exact sums from rows if needed, never rerun the estimator. `ScopeManifest` has only complete entries/role lists; selection/pruned/unread observations must arrive through existing diagnostics/limitations from discovery/application companion data. Preserve them in all formats. A required public field that cannot be represented needs a focused schema amendment before implementation, not an ad hoc extra JSON key. Metrics, engine and readiness layers remain TODO.

Match established strict ESM conventions: `.ts` source imports, explicit named exports and exported annotations, `import type`, readonly DTOs, no `any` or suppressions, unknown caught values narrowed before use. Tests use Vitest source imports for units and the trusted build-first integration wrapper for artifact suites. These current facts supersede prospective wording in the original context below.

### Original design context (retained)

No formatters existed at planning. Prerequisite ReportEnvelope fields: schema/tool/command/status/version/fingerprint, scope, nullable analysis/estimate/fullScopeEstimate, diagnostics/limitations. Estimate includes profile, uncalibrated label, microhour ledger, outward hour/day scenarios and coverage. Analysis has per-file/contract/callable metrics, context totals, relationship resolution and indicators. Pure formatters accept this envelope; no filesystem, streams, ANSI auto-detection, locale, clocks or parser imports. CLI supplies `detail`/color preference as presentation options.

Version policy: schema 1.x allows additive optional fields/codes; breaking type/meaning/removal requires major. Producer validates exact current schema; consumers ignore unknown compatible optional fields and reject unknown majors. Fingerprints use domain canonicalization, no timestamp/absolute paths or source text. Same successful semantic input and versions yields identical JSON; byte hashes may differ for CRLF while metric values remain equal.

## Commands you will need

**Reconciliation gate note (2026-10-15):** Scripts below exist for typecheck, lint, format-check, source units, build-first integration/all, coverage and schema checks; feature-specific suites and later scripts exist only when their owning plans land. Current main-checkout checks are not green: missing installed Commander/Zod/Slang block typecheck, lint and domain/CLI unit collection. The bootstrap source unit passes (1 test); the other two unit suites fail collection. `pnpm format:check` fails on the same four unchanged `.agents/skills/improve` Markdown files recorded in prior approvals. No new format exception is granted: preserve the exact inherited exception and verify changed artifacts, or arrange a separately scoped fix; any additional failure is a STOP condition.

An executor must first run `pnpm install --frozen-lockfile` in its authorized implementation checkout and obtain success. This reconcile run did not install dependencies. Pnpm 11 attempted automatic installation before scripts and aborted removal of node_modules due to no TTY; do not set CI or approve purge merely to bypass it. With dependencies correctly installed, `pnpm --config.verifyDepsBeforeRun=false run <script>` can run an existing script without implicit dependency reconciliation; it does not repair missing packages. Do not claim schema/build/integration/coverage/frozen-install verification from this reconciliation: those gates were not rerun. Run the prescribed fresh build before any built-artifact test in implementation.

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Proposed prerequisite scripts; none existed during planning.

| Purpose | Command | Expected |
|---|---|---|
| Renderers/goldens | `pnpm exec vitest run test/unit/reporting.test.ts` | hand-reviewed complete/partial/error outputs pass |
| Schemas | `pnpm schemas:check` | 0, all serialized fixture envelopes validate |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm build` | 0 |

## Scope

**In scope:** `src/reporting/{terminal,json,markdown,display,sanitize}.ts`, `src/index.ts` (serialization exports), `test/unit/reporting.test.ts`, `test/golden/{terminal,json,markdown}/**`, `test/fixtures/reports/**`, `docs/output-schema.md`, 012 status row.

**Out of scope:** CLI stream routing/output writes, color/TTY libraries, HTML/PDF/UI, estimates recomputation, pricing/proposal generation, schema/metric/model semantics changes, dynamic output plugins.

## Git workflow

Use supplied checkout. No commits/pushes/publication or branch change without operator instruction.

## Steps

### Step 1: Serialize one validated stable JSON envelope

Implement `serializeJson(envelope)` using canonical object-key sorting and explicit collection ordering from 003, indent 2 and one trailing LF. Preserve ledger order/units and empty/null/unavailable values, reject unsupported major/nonfinite/unsafe serialized numbers. Complete/partial/error are the same envelope contract, not ad hoc success shapes or different stderr JSON. No source content, external URLs from analyzed code, raw absolute paths, stacks, cwd, timestamps or runtime stats. Error internal details stay internal.

**Verify:** `pnpm exec vitest run test/unit/reporting.test.ts -t 'json'` → 0, domain schema validates every result, permuted input produces identical bytes, error envelope is parseable.

### Step 2: Render concise terminal summary with optional full explanation

Use plain strings/ASCII tables by default and Node-native optional ANSI only if CLI requests it. Summary leads with status and auditor-hours/day scenario range plus **uncalibrated heuristic** and **effort, not elapsed delivery time**. `inspect` has metrics/scope and no estimate. Include selected/parsed/omitted scope counts, context/library separation, per-contract metric rows, warnings and missing assessment topics. `explain` or detail mode shows effective model parameters, every ledger category/formula/input/evidence, cap/dedup decisions and manual reasons.

Never show zero for unavailable metrics; render `unavailable (reason)`. In partial reports prominently label analyzed subset and list omitted selected files; full scope estimate remains unavailable. Full detail enumerates exact included paths and contracts, excluded inspected files and pruned trees with not-enumerated labels. Scope/diagnostics may be long; deterministic concise summary may point to `explain`/JSON but must not hide omissions. Avoid arbitrary terminal width/locale assumptions in canonical snapshots.

**Verify:** `pnpm exec vitest run test/unit/reporting.test.ts -t 'terminal'` → 0; complete/inspect/explain/partial/error goldens contain explicit labels, no price/security severity/schedule claims.

### Step 3: Render Markdown from the same data with safe escaping

Markdown includes overview, scope table, per-contract metrics, aggregate measurements, relationship coverage/indicators, parameter/ledger breakdown, manual assumptions, warnings and limitations. Use plain tables and lists; escape pipes/newlines/backticks/angle brackets in untrusted names/paths/reasons, sanitize control sequences for human text, never allow raw HTML or active links derived from source. Terminal strips ESC/control characters in untrusted labels; JSON preserves valid escaped raw labels as data. Code snippets are unnecessary; reports do not reproduce Solidity code.

**Verify:** `pnpm exec vitest run test/unit/reporting.test.ts -t 'markdown and sanitization'` → 0; malicious-looking filenames/text cannot introduce terminal controls, HTML or extra Markdown table rows, JSON remains valid data.

### Step 4: Freeze goldens and output compatibility documentation

Create hand-reviewed golden reports for simple, combined, unknown, partial, inspect and error cases using independent 010 fixtures; assert semantic fields/formula sums separately from snapshots. `docs/output-schema.md` lists schema version policy, statuses/nulls/unknowns, units/range meaning, fingerprints, source privacy and deterministic ordering. No automatic snapshot update in CI or tests. Provide forward-compatible consumer example that checks major then reads optional fields rather than strictly rejecting future 1.x additive fields.

**Verify:** `pnpm exec vitest run test/unit/reporting.test.ts`, `pnpm schemas:check`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm build` → 0; golden fixtures byte-stable across repeated runs.

## Test plan

Use 003 envelopes and 010 manual oracles. Validate JSON schema, stable ordering, unknown/zero/null, per-contract versus project line unions, ledgers, context exclusions, partial scope and error shapes. Include Unicode/control characters/Markdown metacharacters, no-color output, long filenames, no docs/tests data and unavailable semantic metrics. Assert important messages explicitly, not snapshot acceptance alone.

## Done criteria

- [ ] Renderer/golden/full suites and standards/schema gates exit 0.
- [ ] Terminal/JSON/Markdown represent the same scope/metrics/effort values without recomputation.
- [ ] Uncalibrated/scenario/partial/unavailable/source-privacy labels and exact scope are visible.
- [ ] JSON canonical bytes are stable, all statuses schema-valid, unsafe terminal/Markdown text escaped.
- [ ] No unrelated writes/schema/model changes; 012 status updated.

## STOP conditions

Stop if renderer needs to infer unavailable facts, recompute estimates, alter numeric rounding/schema, emit absolute paths/source contents, format a commercial quote, or a gate fails twice. Do not bless changed goldens without explaining the underlying semantic change.

## Maintenance notes

JSON is a public integration API. Preserve old schema fixtures for compatible releases; separate presentation polish from semantic field changes. New formats should consume the same result, not rerun discovery/calculation.
