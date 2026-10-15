# Plan 010: Freeze an explicitly heuristic effort model and calibration protocol

> **Executor instructions:** This plan produces the normative methodology, starter-profile data and independent worked fixtures. It does **not** implement the calculation engine. Follow each gate and update status 010 in `plans/README.md`. Do not describe assumptions as measured industry rates.
>
> **Drift check first:** Re-reconciled at `d11bc60` on 2026-10-15. Run `git status --short`, `git diff --stat d11bc60..HEAD -- docs/model docs/calibration test/fixtures/estimation src/domain src/metrics src/relationships src/indicators`, and `git diff HEAD -- docs/model docs/calibration test/fixtures/estimation src/domain src/metrics src/relationships src/indicators` (plus inspect untracked in-scope files). Check prerequisite statuses and the current-state snapshot below. Expected completed-prerequisite additions require inspection; contradictory contracts or unrelated local edits require reconciliation before implementation.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** HIGH (model credibility, double counting, false precision)
- **Depends on:** `plans/003-domain-contracts-schemas.md`, `plans/007-source-structural-metrics.md`, `plans/008-imports-inheritance-interactions.md`, `plans/009-effort-indicators.md`
- **Category:** direction / research
- **Planned at:** commit `d11bc60`, re-reconciled 2026-10-15 after 005/006 merged (previously `9b0bfe7`); originally greenfield planning on 2026-10-14.

## Why this matters

Effort cannot be inferred accurately by choosing plausible-looking coefficients and calling them industry standard. A small replaceable model with explicit units, assumptions, exclusions and hand-computed examples is a defensible starting point. Calibration later must use actual human hours matched to exact historical scope.

## Current state and architectural context

### Reconciled implementation baseline — 2026-10-15 (refreshed at `d11bc60`)

No `docs/model/`, `docs/calibration/`, estimation fixtures or calculation engine exist. The merged domain layer already reserves `heuristic-v1@1.0.0`, validates its parameter bounds/precision and accepts signed reasoned manual adjustments. `ModelProfile` has `profile`, `modelVersion`, `parameters`; reserve and hours/day are scalar numbers. Preserve those implemented shapes and validate fixtures using existing schemas. The local `trustedDefaults()` model in `test/integration/config.test.ts` is arbitrary test input and must not become the production profile.

`EstimateInput` already embeds `model` and `manualAdjustments`, carries only eligible files plus directed pairs, and records `requiredAnalysisComplete`, `hasUnknownSemantics`, `allowPartial`. Syntax completeness/omitted-file IDs belong to the analysis/application layer before eligibility conversion. `EstimateResult` has contribution rows with `id`, `category`, `lowMicrohours`, `highMicrohours`, `inputStatus`, `explanation`; no top-level precise-total or structured formula/evidence fields exist. Worked fixtures can keep independent precise expectations separately; engine/report plans must map to these actual contracts. The methodology and coefficients remain unimplemented; 007–009 must land first.

Match established strict ESM conventions: `.ts` source imports, explicit named exports and exported annotations, `import type`, readonly DTOs, no `any` or suppressions, unknown caught values narrowed before use. Tests use Vitest source imports for units and the trusted build-first integration wrapper for artifact suites. These current facts supersede prospective wording in the original context below.

### Original design context (retained)

No estimates/model dataset existed during planning. Prerequisites establish scoped unique-file SLOC, decisions, complex mutable storage declarations, confirmed builtin low-level sites, assembly blocks and directed contract pairs. Indicators such as privileged intent/upgradeability/novelty remain heuristic or human inputs, not automatic multipliers. Estimator must be independent of CLI/parser/filesystem; input consists only of versioned plain metrics, graph facts, completeness and optional manual ranges.

Research compared SLOC productivity, COCOMO-style parametric drivers, historical analogy and additive expert work breakdown. Choose additive work breakdown for explainability and absent matched audit dataset. [Menzies et al.](https://arxiv.org/abs/1609.05563) studies software-development estimation, not audit effort; [analogy research](https://bura.brunel.ac.uk/handle/2438/1101) needs historical projects. [A public GEB audit](https://www.openzeppelin.com/news/geb-protocol-audit) gives staffing/elapsed weeks, not exact phase hours. These sources do not validate any coefficient below. The searched evidence did not establish a reusable calibrated audit-effort dataset.

## Normative model specification

Model ID `heuristic-v1`, model version `1.0.0`, label **uncalibrated heuristic**. Estimate one coordinated initial audit review effort: preparation/scoping, code review, interaction/trust-boundary review and synthesis/reporting. All hours are cumulative across participating auditors. Excludes remediation engineering, repeated independent duplicate reviews unless manually added, fix verification/re-review, formal proofs, deployment operations, commercial overhead and queue/calendar time. No estimate of team parallelism or price.

For each eligible unique scoped file `f` with complete syntax:

```text
L_f = measured file SLOC (includes declarations, imports and pragmas)
D_f = measured decisions in Solidity callable bodies
S_f = mutable state declaration count (exclude constants/immutables)
M_f = distinct mutable declarations with mapping, array or resolved struct type
      (each declaration at most once, not nested type-node count)
A_f = measured inline assembly blocks > 0
K_f = confirmed builtin low-level call sites > 0 (candidates don't qualify)

q_control_f = min(1, D_f / max(1, L_f/10))
q_storage_f = 0 when S_f=0; otherwise min(1, M_f/S_f)
q_evm_f = max(A_f ? 1 : 0, K_f ? 0.5 : 0)

B_f,s = L_f * slocHours_s
C_f,s = B_f,s * controlPremium_s * q_control_f
T_f,s = B_f,s * storagePremium_s * q_storage_f
V_f,s = B_f,s * evmPremium_s * q_evm_f
P_s = projectHours_s + sum_f(B_f,s + C_f,s + T_f,s + V_f,s)
      + resolvedScopedPairCount * interactionHours_s
      + resolvedContextBoundaryPairCount * boundaryHours_s
U_low = 0
U_high = hasUnknownSemantics ? P_high * unknownReserveHigh : 0
H_s = P_s + U_s + sum_j(manualAdjustment_j,s)
```

Here `s` is the low/high planning scenario, not a fitted quantile. A missing required measurement does **not** become measured zero: its unmeasurable premium is omitted with unavailable ledger input, and `hasUnknownSemantics=true`. For a syntax-incomplete scoped file, omit all of its AST/SLOC effort; ordinary full-scope estimation is unavailable. Partial mode computes only complete-syntax files, filters graph pairs to those eligible scoped owners/endpoints, and marks `coverage="analyzed-subset"`, `fullScopeEstimate=null`. Even a very wide range must not substitute for missing scoped code. Unresolved context imports/bases, skipped binding components, ambiguous relevant targets and unavailable storage classification set the unknown-semantics flag; ordinary dynamic target uncertainty can set this reserve without making syntax analysis erroneous. Completeness and capability uncertainty are separate fields.

The complete/partial gate also covers **failed required context/import/component analysis**: normal estimation is unavailable if that coverage is partial even when all scoped files parsed; explicit partial mode can estimate their known syntactic scope with the uncertainty reserve and analyzed-subset label. By contrast, normal supported capability limitations (such as a dynamic receiver's runtime target) are documented unknowns and can produce a complete analysis with `hasUnknownSemantics=true`. This distinction must be driven by explicit completeness/capability fields, not by treating every unresolved identifier as either harmless or fatal.

Directed scoped pairs union inheritance and resolved cross-contract calls, exclude self-pairs, and count each `(fromContractId,toContractId)` once. Context boundary pairs count resolved scoped contract → out-of-scope contract dependencies, with kind/evidence union. Partitions are disjoint. File-level unused imports/free-function/interface-only observations are reported but not charged by this initial pair formula. This known limitation is a human-adjustment prompt; no fake endpoint. Imported shared code receives no baseline unless explicitly scoped/promoted. Scoped-out first-party dependencies remain disclosed; no claim they were audited.

### Starter assumptions (advisor-chosen, not empirical constants)

| Parameter | Low | High | Unit |
|---|---:|---:|---|
| projectHours | 4 | 12 | auditor-hours/project |
| slocHours | 0.04 | 0.12 | auditor-hours/SLOC |
| controlPremium | 0.10 | 0.25 | fraction of file baseline at q=1 |
| storagePremium | 0.05 | 0.15 | fraction of file baseline at q=1 |
| evmPremium | 0.20 | 0.50 | fraction of file baseline at q=1 |
| interactionHours | 0.25 | 0.75 | hours/unique scoped directed pair |
| boundaryHours | 0.50 | 2.00 | hours/unique context boundary pair |
| unknownReserveHigh | 0 | 0.25 | high-only fraction of pre-manual subtotal |
| hoursPerDay | 8 | 8 | conversion convention, configurable |

These values make the MVP functional while exposing all assumptions. They must appear in the resolved model/report. No claim of accuracy follows from numerical specificity. Low/high parameters must be finite, nonnegative and ordered; premiums/reserve bounded 0..2, SLOC rates 0..10 hours/line, fixed project and pair allowances 0..10,000 hours, hours/day >0..24, manual magnitudes <=100,000 hours each, IDs unique/reasons nonempty. JSON number inputs support at most six decimal places. Negative manual adjustments are allowed only with a reason; reject resulting negative or reversed totals, do not clamp silently. Require positive review SLOC; comment-only/empty scope is unavailable (EMPTY_SCOPE).

Store `unknownReserveHigh` as the single high-scenario fraction `0.25`; the table's low `0` is the fixed absence of low-scenario reserve, not a configurable second parameter. Store `hoursPerDay` as the single conversion value `8`. All other scenario parameters use `{low,high}` objects. This matches the domain schema; profile JSON uses `profile`, `modelVersion`, and `parameters` keys.

### Double-counting controls and precision

SLOC is the only baseline size driver. Function/contract/physical-line counts are explanatory, not separately charged. Control operators/loops are one decision channel, storage structures one declaration channel, assembly/low-level one max channel. Inheritance and call sites collapse into endpoint pairs; graph overhead models relationships rather than re-reviewing inherited LOC. The unknown reserve is a high-scenario uncertainty allowance, listed separately from structural premiums; it is not a risk score or additional occurrence charge. Test presence, supplied coverage, privilege/upgrade patterns, custom math/crypto and protocol novelty remain manual-only until a calibration study supports extra channels. Do not apply general proxy/access/name multipliers on top.

Use exact internal rational/fixed-point arithmetic, with microhour integers (1 hour = 1,000,000 microhours), lower contributions rounded down and upper rounded up at the microhour boundary. Preserve a contribution ledger at this precision and sum it exactly; no binary-float accumulation hidden in reports. Final displayed hours: floor low to whole hour, ceil high to whole hour. Days derive from these outward-rounded hours divided by configured hours/day, outward-rounded to 0.1 day. Never round lower bounds up/upper down. Serialization uses safe JSON integers/numbers, no BigInt strings disguised as normal counts. Scenario ranges have no claimed probability, percent accuracy or statistical confidence level.

### Mandatory worked fixtures

1. **Simple:** one complete scoped file `L=100,D=0,S=0,M=0,A=false,K=false`, no pairs/manual/unknown. Baseline 4..12, overhead 4..12, subtotal 8..24 hours, displayed 8..24 hours and 1.0..3.0 auditor-days.
2. **Combined channels:** one file (two scoped contracts permissible) `L=100,D=10,S=8,M=2,A=false,K=false`, one scoped pair and one context pair, manual +1..+3 hours. `q_control=1`, `q_storage=0.25`. Baseline 4..12; control .4..3; storage .05...45; interaction .25...75; boundary .5..2; overhead 4..12. Pre-manual 9.2..30.2; total 10.2..33.2; display 10..34 hours, 1.2..4.3 days. Fixture numbers use explicit decimals, not punctuation shorthand in JSON.
3. **Unknown variant:** same as fixture 2 with unknown semantics: high reserve 7.55; total 10.2..40.75; display 10..41 hours, 1.2..5.2 days.
4. **EVM dominance:** `L=100,D=0,S=0`, assembly plus a confirmed delegatecall: q_evm=1, premium .8..6, total 8.8..30; display 8..30. Adding more delegatecall sites to the same file cannot add another EVM channel.
5. **Partial:** fixture 1 plus a syntax-invalid second scoped file: normal estimate null; explicit partial yields fixture-1 effort, analyzed-subset label, omitted second file and fullScopeEstimate null, exit policy remains 4 later.
6. **Validation:** all-comments scope, unknown required baseline SLOC, NaN/infinite/reversed profiles, duplicate/manual-without-reason, excessive negative discount and unsafe totals are rejected, not coerced.

## Commands you will need

**Reconciliation gate note (re-reconciled 2026-10-15 at `d11bc60`):** Plans 001–006 are merged on `main`. In the primary checkout with dependencies installed, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm schemas:check`, `pnpm test` (52 unit tests) and fresh-build `pnpm test:integration` (99 integration/research tests) all exit 0. `.oxfmtrc.json` now ignores `.agents/**`, `.claude/**`, `dist/**`, `plans/**` and `pnpm-lock.yaml`, so the former four-file `.agents/skills/improve` format exception **no longer exists: any `pnpm format:check` failure is a STOP condition.** The production build emits exactly ten files (`index.js`, `index.d.ts`, `bin.js`/`.map`, `version.js`/`.map`, the shared `versions.js`/`.map` chunk, `parser/worker.js`/`.map`) and `test/integration/bootstrap-cli.test.ts` asserts that inventory; a new entry or shared chunk requires an explicit plan amendment, not a silent test edit. Feature-specific suites and later scripts exist only when their owning plans land.

An executor works in its own checkout or worktree, which does not share `node_modules`: run `pnpm install --frozen-lockfile` first and obtain success. Afterwards `pnpm --config.verifyDepsBeforeRun=false run <script>` runs a script without pnpm's implicit dependency reconciliation (it does not repair missing packages). Built-artifact suites run through the build-first wrapper (`pnpm test:integration` / `pnpm test:all`), never against stale `dist/`. This reconciliation did not rerun `pnpm install --frozen-lockfile` or `pnpm test:coverage`.

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Proposed prerequisite scripts; none existed during planning.

| Purpose | Command | Expected |
|---|---|---|
| Spec fixture validation | `pnpm exec vitest run test/unit/model-spec.test.ts` | profile/fixture fields and hand-known expectations validate |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm schemas:check` | 0 |

## Scope

**In scope:** `docs/model/{heuristic-v1,alternatives,limitations}.md`, `docs/calibration/protocol.md`, `test/fixtures/estimation/{profile,worked-cases,invalid-cases}.json`, `test/unit/model-spec.test.ts`, 010 status row.

**Out of scope:** calculation engine, fitted coefficients, collecting private audit data, executing audits, pricing/schedule formulas, changing measured definitions/graph status to fit the model, web services or ML dependencies.

## Git workflow

Use supplied checkout. No commits/pushes/publication/account/data sharing without operator instruction.

## Steps

### Step 1: Freeze the model specification and profile

Write the normative formulas/units/parameters/eligibility/version contract exactly above, with additive low/high scenarios and explicit double-counting decisions. Create profile JSON that validates against 003 model schema and human-authored input/expected-output fixtures. Keep fixture expected values independent of any future implementation. Add tests checking schema/invariants, named hand-computed constants and profile equality to documented tables; do not implement the engine inside tests or generate expectations from it.

**Verify:** `pnpm exec vitest run test/unit/model-spec.test.ts -t 'profile and examples'` → 0; all six fixture groups exist and exact hand-computed values are asserted.

### Step 2: Document model alternatives and scope limitations

Write alternatives and source applicability with primary links above. State no identified matched benchmark, no transferred development coefficients and no security/elapsed-price claims. Describe SLOC layout sensitivity, unknown business complexity, selective scope, unmodified library assumptions, dynamic dispatch, capped semantics and review-policy variation. Make uncertainty of input completeness distinct from uncertainty of human productivity. Include manual examples for economic novelty, independent second review, poor documentation and fix verification with reasons, without universal coefficients.

**Verify:** `pnpm exec vitest run test/unit/model-spec.test.ts -t 'methodology contract'` → 0, documentation contains model/uncalibrated/scenario/coverage/unit declarations and all required assumption names; `pnpm lint`, `pnpm format:check` → 0.

### Step 3: Specify a future, consented calibration and evaluation process

Define dataset row: pseudonymous project/family ID, frozen source scope/hash, source availability/license, metric/parser/model/indicator versions, review policy, auditor-hours by preparation/review/interactions/report/re-review, staff seniority and participation, excluded dependencies, domain novelty/manual factors and estimate-before-actual evidence. Record interval/censored hours if exact effort unavailable; do not multiply calendar weeks by assumed utilization. Separate technical hours from price and engagement dates.

Use family/time split to prevent forks/diff audits leaking across train/test. Start with independently measured SLOC-only and expert baseline comparisons; fit few nonnegative identifiable coefficients locally, inspect collinearity/residuals and consent/data quality before adding weights. Reserve held-out projects for absolute error in hours, signed bias, interval coverage and width, median relative error with small-project caveats, and subgroup/family failures. Do not select solely by MMRE or train-set fit. Report uncertainty and sample size; predefine evaluation and broad acceptance targets once data exists, not a fabricated accuracy threshold now. Publish only approved anonymized/licensed rows, maintain model cards/versioned profiles and data provenance. Calibration tooling and dataset acquisition remain post-MVP.

**Verify:** `pnpm exec vitest run test/unit/model-spec.test.ts -t 'calibration contract'` → 0, documented data dictionary/split/baselines/metrics/privacy fields present; full/standards/schema gates → 0.

## Test plan

Use 003 schema test style, not engine implementation style. Fixture tests check explicit profile values, numeric ordering, eligibility/status and known totals. Independent human review should confirm arithmetic before 011; any adjustment becomes a documented model/spec version decision. No accuracy claim can be verified by synthetic fixtures.

## Done criteria

- [ ] Spec suite, full/type/lint/schema checks exit 0; normative docs/profile/worked/invalid fixtures exist.
- [ ] Every default number is labelled uncalibrated assumption with unit and override bounds.
- [ ] Complete/partial/unknown/rounding/manual policies are deterministic and fully specified.
- [ ] Calibration protocol includes consented matched actual hours, leakage controls and held-out baselines.
- [ ] No fitted model, production engine or outside-scope edit; status 010 updated.

## STOP conditions

Stop if measured inputs cannot support the model, required graph pairs aren't distinguishable, fixtures expose reversed/nonfinite totals, existing schema cannot represent the profile, someone requires claimed statistical accuracy without data, or a gate fails twice. Obtain a focused model/schema amendment rather than silently introducing new weights or compiler inference.

## Maintenance notes

Model semantics and defaults version independently from metrics/schema. Preserve original profile/fixtures when adding calibrated profiles. A successful calibration may replace this heuristic but must not rewrite historical report assumptions or make parser changes invisible.
