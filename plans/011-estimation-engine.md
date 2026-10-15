# Plan 011: Implement the pure, deterministic effort calculation engine

> **Executor instructions:** Implement the approved model exactly, using independent worked fixtures. Run every gate and update status 011 in `plans/README.md`. Do not tune coefficients to make tests look plausible.
>
> **Drift check first:** Reconciled at `2eb8d3d` on 2026-10-15; plans 001–008 are present on `main`. Run `git status --short`, `git diff --stat 2eb8d3d..HEAD -- src/estimation src/index.ts src/domain docs/model test/fixtures/estimation`, and `git diff HEAD -- src/estimation src/index.ts src/domain docs/model test/fixtures/estimation` (plus inspect untracked in-scope files). Check prerequisite statuses and the current-state snapshot below. Expected completed-prerequisite additions require inspection; contradictory contracts or unrelated local edits require reconciliation before implementation.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** HIGH (numerical correctness and coverage honesty)
- **Depends on:** `plans/010-model-methodology-calibration.md`
- **Category:** direction / correctness
- **Planned at:** commit `2eb8d3d`, reconciled 2026-10-15 after 007/008 reached `main`; supersedes `d11bc60`. Originally greenfield planning on 2026-10-14.

## Why this matters

The central product is a transparent estimate another auditor can reproduce. A pure engine with exact contribution sums, independent oracles and replaceable versioned profiles can evolve without changing parsing or CLI behavior.

## Current state and architectural context

### Reconciled implementation baseline — 2026-10-15 (refreshed at `2eb8d3d`)

`src/estimation/` is absent. The merged `EstimateInput` embeds model/manual adjustments; use a single-input `estimateEffort(input: EstimateInput): EstimateResult | null` API. Return null for ineligible/incomplete normal estimation; invalid inputs may raise an explicit in-scope typed error. This supersedes the proposed three-argument/nonnullable signature below. Do not change public schemas to match that old proposal.

Eligible file records have no syntax-complete flag and pairs have no contract-to-file map. Plan 013 must select complete-syntax files, retain omissions in analysis and filter scoped endpoints/context owners before constructing this input; the pure engine validates the supplied input and completeness flags without inventing missing mappings. Document that caller boundary and test it in 013.

Public contribution rows are exactly `{id, category, lowMicrohours, highMicrohours, inputStatus, explanation}`. Keep formula IDs, units and input/evidence associations in internal ledger records and render bounded explanations using the public fields; effective coefficients remain in `parameters`. Sum integer contribution rows to derive precise totals internally and in test assertions; do not add a nonexistent public precise-total field. Enforce actual schema contribution bounds (currently ±100,000,000,000 microhours per row) as well as safe-integer checks. Valid configuration can exceed a result bound; return an explicit invalid-estimate error rather than silently clamp or widen schemas. Profile/spec fixtures from 010 are still pending and must be checked before execution.

Match established strict ESM conventions: `.ts` source imports, explicit named exports and exported annotations, `import type`, readonly DTOs, no `any` or suppressions, unknown caught values narrowed before use. Tests use Vitest source imports for units and the trusted build-first integration wrapper for artifact suites. These current facts supersede prospective wording in the original context below.

### Measured input boundary after 007/008

`EstimateInput` (`src/domain/types.ts:285`) is still the plain engine boundary. Its callers must join 007 `FileMetrics` with 008 `RelationshipAnalysis` by canonical file ID, use the final manifest for ownership/role, and supply the separate `confirmedBuiltinLowLevelCalls` measurement. Never substitute the syntax candidate count. The syntax complex-mutable-ID list covers mappings/arrays only; when any mutable `typeShapes` entry is `user-defined` or `unknown`, the caller supplies unavailable complex-storage classification without overwriting source metrics. The engine keeps that premium input unavailable and activates the documented high reserve. Preserve 008 completeness flags and pair partitions; do not reconstruct dispatch from public edge names. Add plain-input engine tests for unavailable storage and builtin inputs. This is a caller/engine contract; parser/relationship changes remain outside this plan. Model specification 010 remains pending.

### Original design context (retained)

No production estimate existed during planning. Expected prerequisites define unique-file SLOC, decisions/complex storage/EVM facts, graph pair partitions, completeness and profile JSON. Implement `estimateEffort(input, model, manual): EstimateResult` and `selectModel` without filesystem, Slang, terminal or clocks. Strict ESM readonly records, no hidden mutable registry or external services. Model `heuristic-v1@1.0.0` is explicitly uncalibrated.

**Inlined formula:** for each complete scoped file, baseline `B=L*slocHours`; `q_control=min(1,D/max(1,L/10))`; storage `q=0` for no mutable state else `min(1,M/S)` where each mapping/array/resolved-struct declaration counts once; EVM `q=max(assembly?1:0,confirmedBuiltinLowLevel?0.5:0)`. Add baseline times each q/group premium. Add project allowance and unique directed scoped-pair/context-boundary allowances. Unknown semantics adds **high-only 25% of pre-manual high subtotal**; unavailable premium input contributes no guessed premium and triggers this reserve. Add reasoned low/high manual hours last. Reject negative/reversed totals. Invalid scoped syntax makes normal estimate null; explicit partial computes complete-syntax subset, filtered pairs, coverage analyzed-subset and fullScopeEstimate null.

Starter low/high: project 4/12 hours; SLOC .04/.12 h/line; control .10/.25; storage .05/.15; EVM .20/.50; scoped-pair .25/.75 h; context-boundary .50/2 h; hours/day 8; reserve 0/.25. All are assumptions, not empirical standards. Declared metric counts beyond these channels/heuristic indicators/test coverage do not add weights. Empty/all-comment scope is unavailable. Final hours floor-low/ceil-high integers; days from rounded hours / hoursPerDay outward to .1.

Worked oracles: simple `L=100` no channels/pairs/manual → 8..24 h, 1..3 days. `L=100,D=10,S=8,M=2`, one scoped and context pair, +1..+3 manual → precise 10.2..33.2, display 10..34 h, 1.2..4.3 days. Unknown semantics variant → precise high 40.75, display 10..41 h, 1.2..5.2 days. Assembly plus confirmed delegatecall at L100 → 8.8..30 precise, displayed 8..30; site repetition doesn't add another premium.

## Commands you will need

**Reconciliation gate note (2026-10-15 at `2eb8d3d`):** Plans 001–008 are implemented on `main`. On Node `24.21.0` with pinned pnpm `11.28.4`, this reconciliation passed `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` (209 units), fresh-build `pnpm test:integration` (182 integration/research tests) and `pnpm schemas:check`. Scripts were invoked with `--config.verifyDepsBeforeRun=false` against installed dependencies to avoid implicit dependency reconciliation. No frozen install or coverage run was performed. Production output still has ten files: `index.js`, `index.d.ts`, `bin.js`/`.map`, `version.js`/`.map`, `versions.js`/`.map`, `parser/worker.js`/`.map`. Preserve the inventory assertion in `test/integration/bootstrap-cli.test.ts`; new entries/chunks require an explicit amendment. The former skill-file formatting exception is gone; **any format-check failure is a STOP**. Linux/Windows and package installation remain unverified. Proposed feature-specific tests/scripts below must be supplied by their owning plans.

An executor works in its own checkout or worktree, which does not share `node_modules`: run `pnpm install --frozen-lockfile` first and obtain success. Afterwards `pnpm --config.verifyDepsBeforeRun=false run <script>` runs a script without pnpm's implicit dependency reconciliation (it does not repair missing packages). Built-artifact suites run through the build-first wrapper (`pnpm test:integration` / `pnpm test:all`), never against stale `dist/`. This reconciliation did not run `pnpm install --frozen-lockfile` or `pnpm test:coverage`.

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Feature-specific commands below are execution targets; the shared gates above were verified during this reconciliation.

| Purpose | Command | Expected |
|---|---|---|
| Formula fixtures | `pnpm exec vitest run test/unit/estimation.test.ts` | exact worked/invalid cases pass |
| Properties | `pnpm exec vitest run test/unit/estimation-properties.test.ts` | deterministic numerical properties pass |
| Spec regression | `pnpm exec vitest run test/unit/model-spec.test.ts` | 0, profile unchanged |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm build`, `pnpm schemas:check` | 0 |

## Scope

**In scope:** `src/estimation/{estimate,eligibility,model,fixed-point,ledger}.ts`, `src/estimation/profiles/heuristic-v1.ts`, `src/index.ts` (pure estimate/type export), `test/unit/{estimation,estimation-properties}.test.ts`, `test/fixtures/estimation/**` (add edge cases; preserve approved expected values), 011 status row.

**Out of scope:** coefficient tuning/fitting, parsing/discovery changes, new indicators/multipliers, team calendars, pricing, report formatting, production data collection, mutable model download/plugin registry.

## Git workflow

Use supplied checkout. No commits/pushes/publication or branch change without operator instruction.

## Steps

### Step 1: Validate inputs and eligibility before arithmetic

Select only known model/version. Resolve configured parameter overrides against profile, preserve the full effective profile/provenance. Validate finite ordered nonnegative coefficient pairs, allowed bounds and <=6 decimal places from 010. Manual IDs/reasons/order/bounds validated; negative manual ranges are permitted but final totals must be nonnegative/ordered. Check consistent scoped IDs/counts, measured SLOC and state type numerator <=denominator. Unknown optional premium metrics remain tagged unavailable. Exclude incomplete files only when partial explicitly allowed and record every omission; filter both scoped endpoints and boundary owners to eligible scope.

Required context/import/component coverage is part of the same normal-estimate gate: if incomplete, return unavailable unless `allowPartial` is explicit, even when every scoped file parsed. Normal supported dynamic-call/overload uncertainty is a capability limit that sets high reserve without independently failing completeness. Consume explicit completeness/capability fields rather than guessing from names or raw diagnostic severity. Profile storage uses paired parameters except scalar `unknownReserveHigh` and `hoursPerDay`, matching 003.

**Verify:** `pnpm exec vitest run test/unit/estimation.test.ts -t 'validation and eligibility'` → 0, normal incomplete estimate unavailable; partial subset exact; malformed/nonfinite/duplicate/negative-total inputs rejected.

### Step 2: Implement exact internal arithmetic and auditable contributions

Convert decimal parameters to microhours/fractions using exact decimal parsing (bounded representation, handle scientific notation deterministically or reject only if outside supported decimal precision, not valid simple JSON values). Use internal BigInt rational numerators/denominators with reduction; compute low contributions rounded down and high rounded up to microhours, then sum exact integer ledger values. BigInt never escapes public JSON. Check all serialized integers are <=Number.MAX_SAFE_INTEGER; overflow returns invalid-estimate diagnostic, not lossy cast. Iterate files/pairs/model groups in deterministic ID order.

Ledger rows include stable ID, category, formula ID, input evidence/values/status, units, effective low/high coefficients, low/high microhours and assumptions. Include baseline, project, each complexity group, interactions, boundaries, unknown reserve and each manual adjustment. Zero rows may be retained for explainability; unavailable rows state reason, not measured 0. Ledger sum is exact total before outward display. Do not run source callbacks or console output.

**Verify:** `pnpm exec vitest run test/unit/estimation.test.ts -t 'worked formulas and ledger'` → 0 against 010 independent fixtures; decimal .1/.2 combinations and subtotal/reserve/manual order exact.

### Step 3: Format numeric effort bounds and independent properties

Return precise microhour totals, outward integer auditorHours, days outward .1 from these integer hours, uncalibrated label/model ID/version/full parameters, assumptions/coverage and limitation messages. No midpoint masquerading as prediction or calendar schedule. Add bounded deterministic generated test cases (fixed enumerated inputs/seed stated in test only) without property-test dependency. Assert row-sum equality, scenario ordering, no input mutation, repeated calls byte-equivalent, permutation invariance, duplicate endpoint dedup and no effect from report-only indicators.

Monotonicity must follow the actual formula: adding baseline SLOC with fixed decisions yields nondecreasing total; adding decisions is nondecreasing until cap; adding state declarations can lower a **density** premium, so do not falsely assert generic all-metric monotonicity. Assembly/low-level dominance and pair-site repetition caps are explicit. Unknown semantics never lowers high; changing hours/day changes only days. Negative manual adjustments are explicit exception to monotonic totals.

**Verify:** `pnpm exec vitest run test/unit/estimation-properties.test.ts` → 0; no hidden randomness or runtime parser dependency.

### Step 4: Expose the stable calculation API and review boundary

Export pure engine functions/types via `src/index.ts`; library import produces no I/O and estimator module imports only domain/config data helpers as needed. Add tests inspecting dependency imports or module graph for no node filesystem/child/CLI/Slang usage. Keep profiles in a small static map for model selection, not a plugin system. All effective assumptions are available to 012 rendering.

**Verify:** formula/property/spec suites, full tests, type/lint/build/schema gates → 0; built library import and pure API test succeed.

## Test plan

Use 010 hand-computed cases; do not regenerate expected values from engine output. Cover exact decimal rounding, zero/high-only coefficients, huge safe/unsafe values, incomplete/unavailable data, discounts, graph duplicate/source-role filtering, input immutability, per-file versus per-contract aggregation, no test/coverage/proxy multiplier and replaceable profile selection.

## Done criteria

- [ ] Formula/property/spec/full suites and all standards/schema gates exit 0.
- [ ] Independent worked examples match exact microhours and outward ranges.
- [ ] Ledger sums exactly; no double counting, guessed unavailable inputs or binary-float drift.
- [ ] Pure library engine has no parser/CLI/filesystem/network coupling and no mutation.
- [ ] No coefficient changes/outside-scope edits; status 011 updated.

## STOP conditions

Stop if the frozen model or schema differs, a fixture expected value is arithmetically inconsistent, rounding cannot preserve ordered bounds/ledger equality, output exceeds safe integers, implementation needs extra weights or human guesses, or a gate fails twice. Do not tune default numbers or widen ranges to hide a failure.

## Maintenance notes

Any formula/default/rounding change requires model-version review and preserved old fixtures. New models consume the same EstimateInput while retaining their own version/ledger. Calibration changes profiles, not measurement meaning or source ownership.
