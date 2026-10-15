# Plan 010: Freeze an explicitly heuristic effort model and calibration protocol

> **Executor instructions:** This plan produces the normative methodology, starter-profile data and independent worked fixtures. It does **not** implement the calculation engine, including inside tests. Follow each gate and update only status 010 in `plans/README.md` (unless a dispatching reviewer owns the index). Do not describe assumptions as measured industry rates.
>
> **Drift check first:** Reviewed at `9d13113` on 2026-10-15; plans 001–009 are present on `main`. Run `git status --short`, `git diff --stat 9d13113..HEAD -- docs/model docs/calibration test/fixtures/estimation test/unit/model-spec.test.ts src/domain src/metrics src/relationships src/indicators package.json vitest.config.ts .node-version`, and `git diff HEAD -- docs/model docs/calibration test/fixtures/estimation test/unit/model-spec.test.ts src/domain src/metrics src/relationships src/indicators package.json vitest.config.ts .node-version`. Inspect untracked files and the existing 010 index row too. The first four paths are implementation scope; the others are read-only contract/tooling dependencies. Reconcile contradictory contracts, existing implementation at the proposed new paths or overlapping local edits before execution; preserve unrelated local work. Check Scope and prerequisite status below.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** HIGH (model credibility, double counting, false precision)
- **Depends on:** `plans/003-domain-contracts-schemas.md`, `plans/007-source-structural-metrics.md`, `plans/008-imports-inheritance-interactions.md`, `plans/009-effort-indicators.md` — all implemented in this checkout.
- **Category:** direction / research
- **Planned at:** commit `9d13113`, reviewed 2026-10-15 after 009 reached `main`; supersedes `2eb8d3d` and `d11bc60`. Originally greenfield planning on 2026-10-14.

## Why this matters

Effort cannot be inferred accurately by choosing plausible-looking coefficients and calling them industry standard. A small replaceable model with explicit units, assumptions, exclusions and hand-computed examples is a defensible starting point. Calibration later must use actual human hours matched to exact historical scope.

## Current state and architectural context

### Reviewed implementation baseline — 2026-10-15 at `9d13113`

No `docs/model/`, `docs/calibration/`, estimation fixtures or calculation engine exist. The merged domain layer already reserves `heuristic-v1@1.0.0`, validates its parameter bounds/precision and accepts signed reasoned manual adjustments. `ModelProfile` has `profile`, `modelVersion`, `parameters`; reserve and hours/day are scalar numbers. Preserve those implemented shapes and validate fixtures using existing schemas. The local `trustedDefaults()` model in `test/integration/config.test.ts` is arbitrary test input and must not become the production profile.

`EstimateInput` already embeds `model` and `manualAdjustments`, carries only eligible files plus directed pairs, and records `requiredAnalysisComplete`, `hasUnknownSemantics`, `allowPartial`. Syntax completeness/omitted-file IDs belong to the analysis/application layer before eligibility conversion. `EstimateResult` has contribution rows with `id`, `category`, `lowMicrohours`, `highMicrohours`, `inputStatus`, `explanation`; no top-level precise-total or structured formula/evidence fields exist. `fullScopeEstimate` belongs to `ReportEnvelope`, not `EstimateResult`. Worked fixtures keep independent precise expectations separately. The methodology and coefficients remain unimplemented. All direct prerequisites are present, including 009 commits `ab0f67c`, `cec7271`, `2bfade3`; no merge is needed.

Read `docs/adr/002-domain-contract.md`, `docs/metrics.md`, `docs/relationships.md` and `docs/indicators.md` before writing fixtures. The ADR's older prose mentioning syntax completeness inside `EstimateInput` is superseded by the actual type. No root README, CI configuration, product brief or design specification exists. The following current excerpts are the load-bearing contracts, not prospective API designs:

```ts
// src/domain/types.ts:285 (eligibleFiles element shown in full)
export interface EstimateInput {
  readonly eligibleFiles: readonly {
    readonly fileId: FileId;
    readonly sourceLines: Measurement<number>;
    readonly stateVariables: StateVariables;
    readonly decisions: Measurement<number>;
    readonly assemblyBlocks: Measurement<number>;
    readonly confirmedBuiltinLowLevelCalls: Measurement<number>;
  }[];
  readonly scopedPairs: readonly { readonly leftId: string; readonly rightId: string }[];
  readonly contextPairs: readonly { readonly leftId: string; readonly rightId: string }[];
  readonly requiredAnalysisComplete: boolean;
  readonly hasUnknownSemantics: boolean;
  readonly allowPartial: boolean;
  readonly model: ModelProfile;
  readonly manualAdjustments: readonly ManualAdjustment[];
}
```

`src/domain/types.ts:302` defines result fields `profile`, `modelVersion`, `label`, `coverage`, `auditorHours`, `auditorDays`, `contributions`, `assumptions`, `manualAdjustments`, `parameters`. Contribution `inputStatus` is exactly `measured | unavailable | manual`. `src/domain/schemas.ts:568` bounds each row to **±100,000,000,000 microhours**, at most **100,000 rows**, with ordered ranges, IDs up to 512 characters and explanations up to 512 characters. Hour/day endpoints are ordered, nonnegative and <=**1,000,000,000**. A schema-valid input can exceed these output bounds; later engine validation must reject it explicitly without widening schemas, truncating rows or clamping values.

Match this existing fixture-loader pattern (`test/unit/domain.test.ts:43`):

```ts
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/domain/${name}.json`, import.meta.url), 'utf8'),
  ) as unknown;
}
```

Match established strict ESM conventions: `.ts` source imports, explicit named exports and exported annotations, `import type`, readonly DTOs, no `any` or suppressions, unknown caught values narrowed before use. Tests use Vitest source imports for units and the trusted build-first integration wrapper for artifact suites. These current facts supersede prospective wording in the original context below.

### Implemented input constraints

007/008 now supply pure `buildFileMetrics`/`aggregateMetrics` (`src/metrics/`) and the internal `RelationshipAnalysis` (`src/relationships/types.ts`, produced by `resolveRelationships` in `src/relationships/closure.ts`). Freeze examples against these actual capabilities. Directed pairs are deduplicated direct resolved inheritance and statically resolved cross-contract calls; ordinary internal calls remain dynamic and do not create pairs. Imports alone never create contract pairs.

`confirmedBuiltinLowLevelCalls` is a separate per-file measurement, not `lowLevelCallCandidates`. Storage refinement is deferred: if any mutable state shape is `user-defined` or `unknown`, the eventual estimator input's complex-storage classification must be unavailable, even though 007's syntax-only mapping/array ID list is measured. Preserve the syntax record and document the conversion. Test unavailable storage, unavailable builtin counts and dynamic internal calls in worked input variants, without revising the six mandatory oracle totals below. 008 intentionally does not set `hasUnknownSemantics` solely for ordinary internal virtual dispatch; preserve its explicit flags rather than treating every unsupported call edge as incomplete/unknown. No numeric default exists in production yet; `test/helpers/parse-source.ts` also contains arbitrary test-only coefficients.

009 now supplies eight unanswered human prompts (`src/indicators/human-prompts.ts:32`): `business-invariants`, `protocol-novelty`, `external-trust`, `custom-math-cryptography`, `documentation`, `upgrade-lifecycle`, `cross-chain`, `review-depth`. Classification copies the relationship completeness/unknown flags; classifier `complete` describes output truncation only. Readiness `complete` describes optional test/coverage inspection, never required source analysis. Missing tests, absent/malformed/unverified LCOV, prompt answers or indicator confidence do not automatically add premiums/reserve or change those flags. Any manual allowance remains separate, explicit configuration.

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
U_high = effectiveUnknown ? P_high * unknownReserveHigh : 0
H_s = P_s + U_s + sum_j(manualAdjustment_j,s)
```

Here `s` is the low/high planning scenario, not a fitted quantile. A missing required measurement does **not** become measured zero: its unmeasurable premium is omitted with unavailable ledger input, and `effectiveUnknown=true` without mutating supplied flags. For a syntax-incomplete scoped file, omit all of its AST/SLOC effort; ordinary full-scope estimation is unavailable. Partial mode's caller selects only complete-syntax files and filters graph pairs to eligible scoped owners/endpoints; the engine marks `coverage="analyzed-subset"`, and the report has `fullScopeEstimate=null`. Even a very wide range must not substitute for missing scoped code. Unresolved context imports/bases, skipped binding components, ambiguous relevant targets and unavailable storage classification set the unknown-semantics flag; ordinary dynamic target uncertainty can set this reserve without making syntax analysis erroneous. Completeness and capability uncertainty are separate fields.

The complete/partial gate also covers **failed required context/import/component analysis**: normal estimation is unavailable if that coverage is partial even when all scoped files parsed; explicit partial mode can estimate their known syntactic scope with the uncertainty reserve and analyzed-subset label. By contrast, normal supported capability limitations (such as a dynamic receiver's runtime target) are documented unknowns and can produce a complete analysis with `hasUnknownSemantics=true`. This distinction must be driven by explicit completeness/capability fields, not by treating every unresolved identifier as either harmless or fatal.

Directed scoped pairs union inheritance and resolved cross-contract calls, exclude self-pairs, and count each `(fromContractId,toContractId)` once. Context boundary pairs count resolved scoped contract → out-of-scope contract dependencies, with kind/evidence union. Partitions are disjoint. File-level unused imports/free-function/interface-only observations are reported but not charged by this initial pair formula. This known limitation is a human-adjustment prompt; no fake endpoint. Imported shared code receives no baseline unless explicitly scoped/promoted. Scoped-out first-party dependencies remain disclosed; no claim they were audited.

Graph deduplication occurs **before** construction of engine input. `EstimateInputSchema` (`src/domain/schemas.ts:492`) rejects duplicate ordered pairs both within and across partitions, self-pairs and duplicate file/manual IDs. Do not require the engine to accept schema-invalid duplicates. A→B and B→A remain distinct.

### Explicit eligibility and unavailable rules

Freeze the following behaviors in the docs and literal fixtures. 010 validates their representation; 011/013 later execute them.

| Condition | Behavior |
|---|---|
| Required analysis complete, eligible total measured SLOC >0 | Estimate with `coverage='full'`, including unknown semantics. `allowPartial=true` alone does not change this label. |
| Required analysis incomplete, `allowPartial=false` | No estimate, including failed required context/import/component work with complete scoped syntax. |
| Required analysis incomplete, `allowPartial=true`, positive eligible measured SLOC | Estimate only supplied eligible files with `coverage='analyzed-subset'`; application keeps omissions and `fullScopeEstimate=null`. |
| Empty eligible set or total measured SLOC=0 | No estimate in either mode (`EMPTY_SCOPE` at application boundary), even with project/manual allowances. A zero-SLOC file can coexist with a positive-SLOC file. |
| Any supplied eligible file has unavailable baseline SLOC | No estimate in either mode. Caller must reconcile/exclude it first; the engine cannot silently remove it or fabricate omissions. |

Plan 013 filters syntax-incomplete files and graph endpoints against the final manifest. The plain engine input has no syntax flag or contract-to-file map, so the engine must not attempt that conversion itself.

- **Control:** unavailable decisions makes the whole control row unavailable.
- **Storage:** validate measured facts for contradictions before applying shortcuts. Measured S=0 determines q=0 without a numerator or division. Otherwise require measured mutable count, type shapes and complete complex-ID classification. Duplicate IDs, M>S, or contradictory measured counts/shapes/subset facts are engine-invalid even when the structural schema accepts them. Mutable `user-defined`/`unknown` shapes or unavailable classification/type shapes make the **estimator copy** of complex IDs unavailable; preserve syntax metrics. Do not resolve structs from names. Synthetic resolved-struct cases must be labelled future-capability plain inputs.
- **EVM:** measured assembly>0 determines q=1 even with unavailable builtin count. Otherwise both counts must be measured: assembly=0 and builtin>0 gives q=0.5; both zero gives q=0. Unavailable assembly leaves the max unknown even with positive builtin count: omit the whole EVM premium. Do not invent a partial-premium channel.
- **Ledger status:** retain an unavailable premium row with numeric 0/0 and `inputStatus='unavailable'`, explaining omission; those zero amounts do not assert measured absence. A known zero channel uses `measured`.
- **Reserve flag:** `effectiveUnknown` is upstream `hasUnknownSemantics` OR unavailable control/assembly/builtin measurement OR unavailable required storage count/classification. S=0 does not require a complex numerator. A known assembly-dominant q=1 still retains the unavailable-builtin limitation/reserve. Never clear an upstream flag or derive it from readiness/indicator confidence. Missing selected syntax alone need not add unknown semantics for surviving files; preserve explicit flags.

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

The formulas above are conceptual; this evaluation order is normative:

1. Interpret six-decimal inputs exactly, including supported JSON numbers written in scientific notation. Derive q and each whole contribution using rational/fixed-point arithmetic; do not round an intermediate q or baseline before multiplying a premium.
2. Retain one project row, baseline/control/storage/EVM rows per eligible file, one row per unique directed pair in each partition, one reserve row and one row per manual adjustment, including zero/unavailable rows. Identity derives deterministically from category plus file/pair/adjustment identity and fits the 512-character bound (the existing framed fingerprint is an option). Order by code points. Known configured rows use `measured` for computability with explanations labelling coefficients as uncalibrated assumptions, never measured productivity; manual rows use `manual`.
3. Round each whole contribution low down and high up to integer microhours (1 hour = 1,000,000). Sum project/file/pair ledger integers exactly to form the pre-manual subtotals.
4. Compute high reserve from the **already rounded pre-manual high ledger subtotal**, multiply by the exact scalar and ceil once to microhours; reserve low is 0. Convert manual hours exactly to signed microhours and add last. Reserve never applies to manual hours. Reject negative/reversed totals and unsafe integer sums.
5. Display hours floor-low/ceil-high to integers. Derive days from those displayed hours divided by exact hours/day, floor-low/ceil-high to tenths (10 low hours /8 becomes 1.2 days). Enforce row bounds/count, safe-integer totals and result hour/day bounds before serialization; do not clamp, truncate or widen schemas.

Keep structured formula/evidence associations internal to 011; public explanations remain bounded and precise totals appear only in internal arithmetic and independent fixture expectations. No binary-float accumulation, public BigInt or invented DTO field. Scenario ranges have no claimed probability, percent accuracy or statistical confidence level.

### Mandatory worked fixtures

1. **Simple:** one complete scoped file `L=100,D=0,S=0,M=0,A=false,K=false`, no pairs/manual/unknown. Baseline 4..12, overhead 4..12, subtotal 8..24 hours, displayed 8..24 hours and 1.0..3.0 auditor-days.
2. **Combined channels:** one file (two scoped contracts permissible) `L=100,D=10,S=8,M=2,A=false,K=false`, one scoped pair and one context pair, manual +1..+3 hours. `q_control=1`, `q_storage=0.25`. Baseline 4..12; control .4..3; storage .05...45; interaction .25...75; boundary .5..2; overhead 4..12. Pre-manual 9.2..30.2; total 10.2..33.2; display 10..34 hours, 1.2..4.3 days. Fixture numbers use explicit decimals, not punctuation shorthand in JSON.
3. **Unknown variant:** same as fixture 2 with unknown semantics: high reserve 7.55; total 10.2..40.75; display 10..41 hours, 1.2..5.2 days.
4. **EVM dominance:** `L=100,D=0,S=0`, assembly plus a confirmed delegatecall: q_evm=1, premium .8..6, total 8.8..30; display 8..30. Adding more delegatecall sites to the same file cannot add another EVM channel.
5. **Partial:** selected fixture 1 plus a syntax-invalid second scoped file. Both plain engine inputs contain only the simple file, filtered pairs, `requiredAnalysisComplete=false`, `hasUnknownSemantics=false`; differ only in `allowPartial`. Normal estimate null; explicit partial yields fixture-1 effort, analyzed-subset label, omitted second file and report fullScopeEstimate null. Separate failed-context case uses unknown=true: normal null; partial precise 8..30. 013 later checks omissions/envelopes/exit 4, which are not engine fields.
6. **Validation:** all-comments/empty scope and unknown baseline yield null; malformed profiles/manual IDs/reasons/ranges fail runtime schemas; excessive discount, inconsistent measured storage and output-bound overflow are schema-valid inputs for later engine rejection. None is coerced. JSON cannot encode NaN/infinities: test those as in-memory TypeScript mutations, never purported JSON numbers.

Additional independent variants (preserve all original totals above):

- Unavailable storage (`L100,S1`, mutable user-defined shape, estimator complex-ID measurement unavailable) and unavailable builtin (`L100,S0,A0,K unavailable`), with other channels measured zero: omitted premium row, effective unknown, precise 8..30; displayed 8..30 hours, 1.0..3.8 days.
- Measured assembly with unavailable builtin: q=1 plus reserve; precise 8.8..37.5; displayed 8..38 hours, 1.0..4.8 days. Unavailable assembly with measured positive builtin: omit EVM, precise 8..30. Include unavailable decisions and S=0 with unavailable numerator cases to pin the rules.
- Builtin-only (no assembly), L100: precise 8.4..27; display 8..27 hours, 1.0..3.4 days. Ordinary internal dynamic-call observations without other unknown facts leave simple effort 8..24, no pair or reserve; keep observations as fixture descriptions outside engine input.
- Fractional microhours, `L100,D0,S7,M1,A0,K0`, no unknown/manual/pairs: storage low 1/35 hour → **28,571** microhours; high 9/35 → **257,143**. Totals **8,028,571..24,257,143**; display 8..25 hours, 1.0..3.2 days. Add a reasoned -1..-0.5 hour discount counterpart to establish valid signed rows.
- Rounding-order variant: same file with M3, unknown=true and explicit reserve override **2** (schema maximum). Storage **85,714..771,429**; pre-manual **8,085,714..24,771,429**; high reserve **49,542,858**; totals **8,085,714..74,314,287**. This distinguishes summing rounded rows from rounding only the final symbolic formula. It is an override, not a new default.
- Hours/day override, complete input with `allowPartial=true`, supported precision boundary `0.000001` and rejected `0.0000001`.

### Fixture representation and verification boundary

Create exactly three JSON files. Wrappers are test-only; define small local Zod schemas inside `test/unit/model-spec.test.ts`, without public types/schema changes:

- `profile.json`: one complete object validated by existing `ModelProfileSchema`.
- `worked-cases.json`: array of `{id, group, description, input, expected, application}`. `group` is `simple | combined | unknown | evm | partial | validation | variants`. `input` is a full `EstimateInput`, including embedded profile, measured count objects (not boolean A/K abbreviations), full `StateVariables` and unique consistent declaration shapes/IDs. `expected` is `{estimate: EstimateResult | null, preciseMicrohours: {low: number, high: number} | null}`. Every nonnull estimate contains all actual public fields and literal contribution rows. `application` is `{selectedFileIds: FileId[], omittedFileIds: FileId[], reportStatus: 'complete' | 'partial', fullScopeEstimateExpected: boolean}`; these describe future caller expectations, not engine fields or a fake envelope. Descriptions may record internal-call facts. Do not use hidden model references or cast abbreviated records to DTO types.
- `invalid-cases.json`: `{schema: [...], eligibility: [...], engine: [...]}`. Schema rows are `{id, target: 'model' | 'input' | 'result', value: unknown, issuePath: (string | number)[]}` and must fail the named runtime schema. Eligibility rows are `{id, input: EstimateInput, expectedEstimate: null, reason: string}`. Engine rows are `{id, input: EstimateInput, reason: string}` and must **pass** `EstimateInputSchema` while specifying future rejection for negative totals, inconsistent storage, output bounds or unsafe totals. Reasons are descriptions, not new production diagnostic codes. Nonfinite mutations live only in TypeScript tests.

010 verifies valid/consistent literals, **not nonexistent engine behavior**. Parse worked input/result with existing runtime schemas; assert original named constants, ledger-row sums equal literal precise totals, outward hours/days and unchanged defaults except named overrides. Checking sums/display rounding is allowed; do not implement q/premiums/pair weights/effectiveUnknown/reserve derivation in tests. Parse the normative default table with a narrow reader and compare all nine numeric rows/units to the profile; reject absent/duplicate rows rather than maintaining a second parameter registry or relying only on keywords.

For eligibility/engine-invalid inputs, schema validity plus literal classification is all that can be checked now. 011 must run them through `estimateEffort`; 013 must test eligibility conversion, omissions, pair filtering and report/readiness neutrality. Explicitly document these deferred gates. Synthetic fixture success establishes neither predictive accuracy nor engine/application conformance.

## Commands you will need

**Review verification (2026-10-15 at `9d13113`):** Plans 001–009 are implemented on `main`. On Node `24.21.0` with pinned pnpm `11.28.4`, this review passed typecheck, lint, format-check and **247 units**, using `--config.verifyDepsBeforeRun=false` against installed dependencies. No install, build, integration/schema/coverage rerun or platform audit occurred. Earlier 009 execution evidence records 210 integration/research tests; that is historical, not fresh verification. Preserve the ten-artifact inventory assertion in `test/integration/bootstrap-cli.test.ts`; this docs/fixture plan adds no production entry/chunk. The former skill-file formatting exception is gone; **any format-check failure is a real failure**. Oxfmt ignores plans; check links/fences and `git diff --check` separately.

An executor works in its own checkout or worktree, which does not share `node_modules`: run `pnpm install --frozen-lockfile` first and obtain success. Afterwards `pnpm --config.verifyDepsBeforeRun=false run <script>` runs a script without pnpm's implicit dependency reconciliation (it does not repair missing packages). Built-artifact suites run through the build-first wrapper (`pnpm test:integration` / `pnpm test:all`), never against stale `dist/`. This review did not run `pnpm install --frozen-lockfile` or `pnpm test:coverage`.

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Feature-specific commands below are execution targets; current verification is limited to the four gates listed above. Script names/test separation were confirmed against `package.json` and `vitest.config.ts`.

| Purpose | Command | Expected |
|---|---|---|
| Spec fixture validation | `pnpm --config.verifyDepsBeforeRun=false exec vitest run --project unit test/unit/model-spec.test.ts` | actual tests run; literal fixtures/defaults validate; no build |
| Typecheck | `pnpm --config.verifyDepsBeforeRun=false run typecheck` | exit 0 |
| Lint / format | `pnpm --config.verifyDepsBeforeRun=false run lint`, `pnpm --config.verifyDepsBeforeRun=false run format:check` | exit 0, no writes |
| Regression | `pnpm --config.verifyDepsBeforeRun=false run test:all` | units and fresh-build integration/research pass |
| Schemas | `pnpm --config.verifyDepsBeforeRun=false run schemas:check` | fresh build; generated bytes match without committed schema writes |
| Whitespace/scope | `git diff --check`, `git status --short` | no whitespace errors; only allowlisted changes beyond recorded baseline |

## Scope

**In scope — the only files to create/modify:**

- `docs/model/heuristic-v1.md`
- `docs/model/alternatives.md`
- `docs/model/limitations.md`
- `docs/calibration/protocol.md`
- `test/fixtures/estimation/profile.json`
- `test/fixtures/estimation/worked-cases.json`
- `test/fixtures/estimation/invalid-cases.json`
- `test/unit/model-spec.test.ts`
- Only the 010 completion/status row in `plans/README.md` (unless reviewer-owned).

**Out of scope:** all production source/domain/schema artifacts, config defaults, package/dependency/tooling changes, other plans, calculation engine (including inside tests), fitted coefficients, collecting private audit data, executing audits/target scripts/compilers, pricing/schedule formulas, changing measured definitions/graph status to fit the model, web services or ML dependencies. 011 owns production profile/arithmetic; 013 owns source-to-input conversion/envelopes. No new dependency is needed.

## Git workflow

Use supplied checkout and preserve pre-existing work. Recent history uses conventional messages such as `feat: classify evidence indicators and bounded readiness metadata`. No commits/pushes/publication/account/data sharing or branch changes without operator instruction.

## Steps

### Step 1: Freeze the model specification and profile

Write `docs/model/heuristic-v1.md` with the formulas/units/parameters, eligibility/unavailable table, version, contribution rounding order/output bounds and double-counting contract above. Create the three JSON files using the specified wrappers and full actual DTOs. Create `test/unit/model-spec.test.ts` following `test/unit/domain.test.ts`. Use describe groups `profile and examples`, `unavailable and eligibility`, `precision and invalid cases`. Check schema/invariants, named literal constants, ledger sums, outward display and profile/default-table equality; do not derive expectations from an engine or implement one in tests. Schema-valid semantic/engine-invalid inputs remain deferred behavior cases, not unexpected schema-test failures.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false exec vitest run --project unit test/unit/model-spec.test.ts -t 'profile and examples|unavailable and eligibility|precision and invalid cases'` → exit 0, all three groups actually execute, six original fixture groups and regression variants exist, exact constants/sums and declared-stage validation pass. Typecheck → exit 0.

### Step 2: Document model alternatives and scope limitations

Write `docs/model/alternatives.md` and `docs/model/limitations.md` with source applicability. Primary sources were checked during this review: [Menzies et al., Negative Results for Software Effort Estimation](https://arxiv.org/abs/1609.05563) concerns COCOMO-style development datasets, [Shepperd/Schofield's analogy study](https://bura.brunel.ac.uk/handle/2438/1101) depends on completed projects with known effort, and the [GEB report](https://www.openzeppelin.com/news/geb-protocol-audit) identifies scope/staffing/elapsed time without matched phase-hours/utilization. None validates these audit coefficients. State that reviewed sources did not establish a reusable matched benchmark, not that none exists anywhere. Compare additive expert work breakdown with SLOC-only, parametric development and analogy methods without transferring coefficients or claiming security/elapsed-price accuracy.

Describe SLOC layout/per-file-density sensitivity, unknown business complexity, selective scope, unmodified library assumptions, dynamic dispatch, capped semantics and review-policy variation. Distinguish input completeness from human-productivity uncertainty. Map all eight current human prompts to optional assessment; test/coverage remains report-only. Include manual JSON examples for economic novelty, independent second review, poor documentation and fix verification, plus a reasoned valid discount, all matching `ManualAdjustmentSchema` and labelled illustrative non-default allowances. Explicitly disclose manually expanded review phases. Add describe group `methodology contract` checking required files/section structure, numeric default table/units and parsed manual JSON examples; matching keywords does not establish methodological validity.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false exec vitest run --project unit test/unit/model-spec.test.ts -t 'methodology contract'` → exit 0, actual tests execute, all nine documented default rows/units match the profile and manual examples parse. Lint and format-check → exit 0.

### Step 3: Specify a future, consented calibration and evaluation process

Write `docs/calibration/protocol.md` with sections `Data dictionary`, `Eligibility and target hours`, `Splits and leakage`, `Baselines and evaluation`, `Consent and publication`, `Model lifecycle`. This is a document, not data acquisition/fitting tooling. The dictionary gives field name, unit/type, required/optional status, missing/censored representation and provenance for: pseudonymous engagement/project/family IDs; frozen source scope/commit/hash; source availability/license; metric/parser/model/indicator versions; review policy; auditor-hours by preparation/review/interactions/report/re-review; staff seniority/participation; excluded dependencies; domain novelty/manual factors; original pre-outcome estimate/profile/adjustments. Research records may contain consented estimate-before-actual timing evidence; canonical product reports remain timestamp-free.

Target effort is matched initial-review hours, excluding remediation, fix verification, independent duplicate review and commercial work unless separately declared in a row's review policy. Keep excluded phase-hours separately. Record missing, interval and left/right-censored hours explicitly, never as zero; do not multiply calendar weeks by assumed utilization. Unalignable source/policy rows are ineligible for supervised fitting and point-error scoring; censoring/interval evaluation needs an explicit separate method/denominator. Retain both original manual-adjusted estimates and a no-manual baseline to expose outcome leakage. Separate technical hours from price and engagement dates.

Use family/time splits to isolate forks/diff audits and hold evaluation chronologically out. Fit features/preprocessing/coefficients only on training data; select on validation data; lock choices before the final holdout is opened. If family isolation/time order leaves too few independent groups, report insufficiency and defer fitting. Compare unchanged starter-profile, training-only fitted SLOC and expert-before-actual baselines. Fit few nonnegative identifiable coefficients locally; inspect collinearity/residuals and policy/data quality before adding weights.

On held-out eligible rows report absolute error in hours, signed bias, scenario interval containment/width, relative error only for positive actual hours with a declared small-project/denominator policy, and subgroup/family failures. Define any point summary (e.g. midpoint) for research scoring only; it is not a product point prediction or promised quantile. Do not select solely by MMRE or training fit. Report exclusions, uncertainty and sample size; pre-register acceptance criteria before holdout evaluation once data exists, not a fabricated threshold now. Empirical containment is not a promised confidence level.

Require separate consent for collection/use/publication, access/retention/deletion policy, anonymization and licensing/provenance review. Publish only approved rows, maintain model cards/versioned profiles and training/validation/holdout lineage. Preserve the original profile/fixtures when proposing a calibrated model. Acquisition, fitting code and any label/version/schema change remain separate post-MVP work. Add describe group `calibration contract` checking required sections/dictionary fields and the deferred verification boundary, without fabricated records or accuracy tests.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false exec vitest run --project unit test/unit/model-spec.test.ts -t 'calibration contract'` → exit 0, actual tests execute. Full spec suite, typecheck, lint, format-check, `test:all`, `schemas:check`, `git diff --check` → exit 0; scope inspection passes. Only then update 010's status row.

## Test plan

Use `test/unit/domain.test.ts` style: load JSON as unknown and parse local wrappers with existing runtime model/input/result schemas. Assert the literal constants, table/profile equality, signed rows, sums/outward displays, complete/subset labels and invalid-case validation stage. Include nonfinite in-memory mutations, genuine schema failures with issue paths, and schema-valid future engine errors. Fixture states must have consistent measured counts, unique declaration shapes and mutable complex-ID subsets; one mapping counts once and constants/immutables do not count. Do not add a parser/type resolver/engine to validate them.

All six original groups and the listed variants must exist, including null outcomes. Numerical channel/eligibility/error behavior is specified literally now and deferred to 011; source-to-input selection, pair deduplication, omissions, metadata neutrality and envelopes are deferred to 013. No `dist/` import, install/build in the unit suite, parser subprocess, network/dataset or property-test dependency. Independent review should confirm arithmetic before 011; any changed expected constant becomes a documented model/spec decision. No accuracy claim follows from synthetic fixtures.

## Done criteria

- [ ] All eight deliverables in Scope exist; spec suite executes the five named describe groups and passes.
- [ ] Typecheck, lint, format-check, `test:all`, `schemas:check` and `git diff --check` exit 0.
- [ ] Every default number is labelled uncalibrated assumption with unit and override bounds.
- [ ] Runtime schemas validate all worked inputs/results and each invalid case's declared stage; all six groups/variants have independent literals and exact ledger-sum/outward-display checks; no test engine generates expectations.
- [ ] Complete/partial/unknown/rounding/manual policies are deterministic, output bounds enforced in the specification, and all nine numeric table rows/units match the profile.
- [ ] Calibration protocol includes consented matched actual hours, leakage controls and held-out baselines.
- [ ] Engine/application/empirical verification is explicitly deferred; no source/schema/dependency changes or fitted model. `git diff --name-only` plus untracked-file inspection shows only allowlisted changes beyond recorded pre-existing edits; status 010 updated or completion handed to reviewer.

## STOP conditions

Stop if contract excerpts drift incompatibly, proposed artifact paths already contain implementation, local work overlaps, measured inputs cannot support the model, required graph pairs aren't distinguishable, a frozen worked constant fails independent arithmetic, a supposedly valid fixture cannot fit current DTOs/bounds, or unavailable/partial rules contradict actual measurement/relationship flags. Also stop for any required source/schema/dependency change, engine implementation in tests, extra weight/type resolver/compiler, claimed statistical accuracy without matched data, or a gate failing twice after a reasonable scoped correction. Obtain a focused model/schema amendment; do not widen bounds or tune numbers. Expected invalid-case rejection is part of the fixtures, not itself a STOP.

Review 011 before execution against the frozen contract. Its retained older prose about a three-argument API, public precise totals, duplicate-input acceptance and in-engine eligibility filtering must not override the actual DTOs or this model. 013 must later verify caller conversion/report metadata; those tests cannot honestly pass in 010.

## Maintenance notes

Model semantics and defaults version independently from metrics/schema. Preserve original profile/fixtures when adding calibrated profiles. A successful calibration may replace this heuristic but must not rewrite historical report assumptions or make parser changes invisible.
