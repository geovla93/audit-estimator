# Model `heuristic-v1`

This document freezes the normative specification of the first effort model: profile `heuristic-v1`, model version `1.0.0`, label **uncalibrated heuristic**. It is a specification and a set of hand-computed fixtures. It is not a calculation engine: plan 011 implements the arithmetic and plan 013 implements source-to-input conversion and report envelopes. Nothing here is a measured industry rate, and no numeric specificity implies accuracy.

Changing any formula, default, rounding rule or unavailable rule below changes the meaning of `1.0.0` and needs a reviewed model decision that bumps the version. Model semantics and defaults version independently from metrics and schemas. See [alternatives](alternatives.md), [limitations](limitations.md) and the [calibration protocol](../calibration/protocol.md).

## Scope of the estimate

The model estimates one coordinated initial audit review: preparation and scoping, code review, interaction and trust-boundary review, and synthesis and reporting. Hours are cumulative across participating auditors.

Excluded: remediation engineering, repeated independent duplicate reviews (unless added manually), fix verification and re-review, formal proofs, deployment operations, commercial overhead and queue or calendar time. There is no team-parallelism estimate and no price.

## Inputs

The estimator input is the existing `EstimateInput` DTO (`src/domain/types.ts`, `EstimateInputSchema` in `src/domain/schemas.ts`). It embeds the resolved `ModelProfile` and the `manualAdjustments`, carries only eligible files, and carries deduplicated directed pairs. Syntax completeness and omitted-file IDs belong to the analysis and application layer and are converted before the engine runs.

For each eligible unique scoped file `f` with complete syntax:

```text
L_f = measured file SLOC (includes declarations, imports and pragmas)
D_f = measured decisions in Solidity callable bodies
S_f = mutable state declaration count (excludes constants and immutables)
M_f = distinct mutable declarations with mapping, array or resolved struct type
      (each declaration at most once, not nested type-node count)
A_f = measured inline assembly blocks > 0
K_f = confirmed builtin low-level call sites > 0 (candidates do not qualify)
```

`confirmedBuiltinLowLevelCalls` is a separate per-file measurement and is not `lowLevelCallCandidates`. The metrics definitions are in [metrics](../metrics.md), the graph facts in [relationships](../relationships.md) and the indicator and readiness boundary in [indicators](../indicators.md).

## Formulas

```text
q_control_f = min(1, D_f / max(1, L_f / 10))
q_storage_f = 0 when S_f = 0; otherwise min(1, M_f / S_f)
q_evm_f     = max(A_f ? 1 : 0, K_f ? 0.5 : 0)

B_f,s = L_f * slocHours_s
C_f,s = B_f,s * controlPremium_s * q_control_f
T_f,s = B_f,s * storagePremium_s * q_storage_f
V_f,s = B_f,s * evmPremium_s * q_evm_f
P_s   = projectHours_s + sum_f(B_f,s + C_f,s + T_f,s + V_f,s)
        + resolvedScopedPairCount * interactionHours_s
        + resolvedContextBoundaryPairCount * boundaryHours_s
U_low  = 0
U_high = effectiveUnknown ? P_high * unknownReserveHigh : 0
H_s    = P_s + U_s + sum_j(manualAdjustment_j,s)
```

`s` is the low or high planning scenario. It is not a fitted quantile. The formulas are conceptual; the evaluation order below is normative.

### Directed pairs

Directed scoped pairs are the union of direct resolved inheritance and statically resolved cross-contract calls. Self-pairs are excluded and each `(fromContractId, toContractId)` counts once. A to B and B to A stay distinct. Context boundary pairs count resolved scoped contract to out-of-scope contract dependencies, with kind and evidence unioned. The two partitions are disjoint. Imports alone never create contract pairs, and ordinary internal calls remain dynamic and create no pairs.

Deduplication happens before engine input is built: `EstimateInputSchema` rejects duplicate ordered pairs within and across partitions, self-pairs, and duplicate file or manual IDs. The engine does not have to accept schema-invalid duplicates.

File-level unused imports, free functions and interface-only observations are reported but are not charged by this pair formula. This is a known limitation and a human-adjustment prompt, with no fake endpoint. Imported shared code receives no baseline unless it is explicitly scoped or promoted. Scoped-out first-party dependencies stay disclosed, with no claim that they were audited.

## Starter assumptions

These are advisor-chosen, **uncalibrated assumptions**. They are not empirical constants, and every value can be overridden within the schema bounds in the next section.

| Parameter          | Low  | High | Unit                                      |
| ------------------ | ---- | ---- | ----------------------------------------- |
| projectHours       | 4    | 12   | auditor-hours/project                     |
| slocHours          | 0.04 | 0.12 | auditor-hours/SLOC                        |
| controlPremium     | 0.10 | 0.25 | fraction of file baseline at q=1          |
| storagePremium     | 0.05 | 0.15 | fraction of file baseline at q=1          |
| evmPremium         | 0.20 | 0.50 | fraction of file baseline at q=1          |
| interactionHours   | 0.25 | 0.75 | hours/unique scoped directed pair         |
| boundaryHours      | 0.50 | 2.00 | hours/unique context boundary pair        |
| unknownReserveHigh | 0    | 0.25 | high-only fraction of pre-manual subtotal |
| hoursPerDay        | 8    | 8    | conversion convention, configurable       |

`unknownReserveHigh` is stored as the single high-scenario fraction `0.25`. The table's low `0` is the fixed absence of a low-scenario reserve, not a configurable second parameter. `hoursPerDay` is stored as the single conversion value `8`. All other parameters are stored as `{ low, high }` objects. The profile JSON uses the keys `profile`, `modelVersion` and `parameters`; the frozen profile is `test/fixtures/estimation/profile.json`.

### Override bounds

Low and high parameters are finite, nonnegative and ordered. Premiums and the reserve are bounded 0 to 2. SLOC rates are bounded 0 to 10 hours per line. Fixed project and pair allowances are bounded 0 to 10,000 hours. `hoursPerDay` is greater than 0 and at most 24. Manual magnitudes are at most 100,000 hours each, IDs are unique and reasons are nonempty. JSON numbers support at most six decimal places; `0.000001` is accepted and `0.0000001` is rejected. Negative manual adjustments are allowed only with a reason; resulting negative or reversed totals are rejected and never clamped silently.

Every default is an assumption that must appear in the resolved model and the report, with its unit.

## Eligibility and unavailable rules

| Condition                                                    | Behavior                                                                                                                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required analysis complete, eligible total measured SLOC > 0 | Estimate with `coverage='full'`, including unknown semantics. `allowPartial=true` alone does not change this label.                                                     |
| Required analysis incomplete, `allowPartial=false`           | No estimate, including failed required context, import or component work when all scoped syntax is complete.                                                            |
| Required analysis incomplete, `allowPartial=true`, SLOC > 0  | Estimate only the supplied eligible files with `coverage='analyzed-subset'`. The application keeps omissions and `fullScopeEstimate=null`.                              |
| Empty eligible set or total measured SLOC = 0                | No estimate in either mode (`EMPTY_SCOPE` at the application boundary), even with project or manual allowances. A zero-SLOC file can coexist with a positive-SLOC file. |
| Any supplied eligible file has unavailable baseline SLOC     | No estimate in either mode. The caller must reconcile or exclude the file first; the engine cannot silently remove it or fabricate omissions.                           |

A missing required measurement never becomes a measured zero. The unmeasurable premium is omitted with an unavailable ledger input, and `effectiveUnknown` becomes true without mutating the supplied flags. For a syntax-incomplete scoped file, all of its AST and SLOC effort is omitted and ordinary full-scope estimation is unavailable. A very wide range must not stand in for missing scoped code.

Plan 013 filters syntax-incomplete files and graph endpoints against the final manifest. The plain engine input has no syntax flag and no contract-to-file map, so the engine must not attempt that conversion itself.

Completeness and capability uncertainty are separate. Failed required context, import or component analysis makes normal estimation unavailable even when all scoped files parsed. A supported capability limitation, such as the runtime target of a dynamic receiver, is a documented unknown: it produces a complete analysis with `hasUnknownSemantics=true` and the high reserve. Unresolved context imports or bases, skipped binding components, ambiguous relevant targets and unavailable storage classification set the unknown-semantics flag. The distinction is driven by the explicit completeness and capability fields, never by treating every unresolved identifier as harmless or fatal. Plan 008 intentionally does not set `hasUnknownSemantics` solely for ordinary internal virtual dispatch, and these rules preserve its explicit flags.

### Channel rules

- **Control.** Unavailable decisions make the whole control row unavailable.
- **Storage.** Validate measured facts for contradictions before applying shortcuts. Measured `S=0` determines `q=0` without a numerator or division. Otherwise require the measured mutable count, type shapes and a complete complex-ID classification. Duplicate IDs, `M > S`, or contradictory counts, shapes or subset facts are engine-invalid even when the structural schema accepts them. Mutable `user-defined` or `unknown` shapes, or unavailable classification or shapes, make the estimator copy of the complex IDs unavailable; the 007 syntax record is preserved. Structs are never resolved from names, and synthetic resolved-struct cases are labelled future-capability plain inputs.
- **EVM.** Measured assembly greater than 0 determines `q=1` even with an unavailable builtin count. Otherwise both counts must be measured: assembly 0 and builtin greater than 0 gives `q=0.5`, and both 0 gives `q=0`. Unavailable assembly leaves the max unknown even with a positive builtin count, so the whole EVM premium is omitted. There is no partial-premium channel.
- **Ledger status.** An unavailable premium row is retained with numeric `0/0` and `inputStatus='unavailable'` with an explanation of the omission; the zeros do not assert measured absence. A known zero channel uses `measured`.
- **Reserve flag.** `effectiveUnknown` is the upstream `hasUnknownSemantics` OR an unavailable control, assembly or builtin measurement OR an unavailable required storage count or classification. `S=0` does not require a complex numerator. A known assembly-dominant `q=1` still retains the unavailable-builtin limitation and reserve. An upstream flag is never cleared, and the flag is never derived from readiness or indicator confidence. Missing selected syntax alone does not add unknown semantics for surviving files.

Test presence, supplied coverage, absent or malformed LCOV, prompt answers and indicator confidence never add premiums or reserve and never change those flags. Any manual allowance is separate, explicit configuration.

## Evaluation order

This order is normative:

1. Interpret six-decimal inputs exactly, including supported JSON numbers written in scientific notation. Derive `q` and each whole contribution with rational or fixed-point arithmetic. Do not round an intermediate `q` or baseline before multiplying a premium.
2. Retain one project row, baseline, control, storage and EVM rows per eligible file, one row per unique directed pair in each partition, one reserve row and one row per manual adjustment, including zero and unavailable rows. Row identity derives deterministically from the category plus the file, pair or adjustment identity and fits the 512-character bound. Rows are ordered by code points. Known configured rows use `measured` for computability, with explanations labelling coefficients as uncalibrated assumptions and never as measured productivity. Manual rows use `manual`.
3. Round each whole contribution low down and high up to integer microhours (1 hour = 1,000,000 microhours). Sum project, file and pair ledger integers exactly to form the pre-manual subtotals.
4. Compute the high reserve from the **already rounded pre-manual high ledger subtotal**, multiply by the exact scalar and ceil once to microhours. Reserve low is 0. Convert manual hours exactly to signed microhours and add them last. The reserve never applies to manual hours. Reject negative or reversed totals and unsafe integer sums.
5. Display hours with floor on low and ceil on high to integers. Derive days from those displayed hours divided by the exact hours per day, floor on low and ceil on high to tenths (10 low hours at 8 per day is 1.2 days). Enforce the bounds below before serialization. Do not clamp, truncate or widen schemas.

### Output bounds

`EstimateResultSchema` bounds each contribution to plus or minus 100,000,000,000 microhours, at most 100,000 rows, ordered ranges, IDs up to 512 characters and explanations up to 512 characters. Hour and day endpoints are ordered, nonnegative and at most 1,000,000,000. A schema-valid input can exceed these bounds. The engine must reject it explicitly, never widening schemas, truncating rows or clamping values.

Structured formula and evidence associations stay internal to plan 011; public explanations remain bounded. Precise microhour totals appear only in internal arithmetic and in the independent fixture expectations. There is no binary-float accumulation, no public BigInt and no invented DTO field. Scenario ranges carry no claimed probability, percent accuracy or statistical confidence.

## Double-counting controls

- SLOC is the only baseline size driver. Function, contract and physical-line counts are explanatory and are not charged separately.
- Control operators and loops are one decision channel, storage structures one declaration channel, and assembly plus low-level calls one max channel.
- Inheritance and call sites collapse into endpoint pairs. Graph overhead models relationships rather than re-reviewing inherited lines.
- The unknown reserve is a high-scenario uncertainty allowance listed separately from structural premiums. It is not a risk score and not an additional occurrence charge.
- Test presence, coverage, privilege and upgrade patterns, custom math or cryptography and protocol novelty stay manual-only until a calibration study supports extra channels. No general proxy, access or name multipliers apply.

## Frozen worked examples

Fixtures live in `test/fixtures/estimation/` and are validated by `test/unit/model-spec.test.ts` against the existing runtime schemas. Expected ledger rows are hand-written literals. The unit test checks schema validity, that the literal rows sum to the literal precise totals, display rounding, and that the profile equals the table above. It does not implement the formulas.

| Case                                                | Precise total (hours) | Displayed hours | Displayed days |
| --------------------------------------------------- | --------------------- | --------------- | -------------- |
| simple (L=100, nothing else)                        | 8 to 24               | 8 to 24         | 1.0 to 3.0     |
| combined (D=10, S=8, M=2, one pair of each, +1..+3) | 10.2 to 33.2          | 10 to 34        | 1.2 to 4.3     |
| unknown variant of combined                         | 10.2 to 40.75         | 10 to 41        | 1.2 to 5.2     |
| EVM dominance (assembly plus delegatecall)          | 8.8 to 30             | 8 to 30         | 1.0 to 3.8     |
| builtin-only (K=2)                                  | 8.4 to 27             | 8 to 27         | 1.0 to 3.4     |
| fractional microhours (S=7, M=1)                    | 8.028571 to 24.257143 | 8 to 25         | 1.0 to 3.2     |
| reserve override 2 (S=7, M=3, unknown)              | 8.085714 to 74.314287 | 8 to 75         | 1.0 to 9.4     |

The rounding-order example distinguishes summing rounded rows from rounding only the final symbolic formula. The reserve override of 2 is a schema-maximum override, not a new default. Further variants cover unavailable storage, builtin, assembly and decisions, `S=0` with an unavailable numerator, signed discounts, an hours-per-day override, `allowPartial=true` on complete input, the six-decimal precision boundary, partial and failed-context cases, and null outcomes for empty scope, comment-only scope and unavailable baseline.

The `application` object in each worked case (`selectedFileIds`, `omittedFileIds`, `reportStatus`, `fullScopeEstimateExpected`) describes future caller expectations and is not an engine field.

## Deferred verification boundary

Plan 010 verifies that the literals are valid and internally consistent. It does **not** verify engine behavior or application conversion, and synthetic fixture success establishes neither predictive accuracy nor engine conformance.

- Plan 011 must run every worked, eligibility and engine-invalid input through `estimateEffort` and compare the results to the literals. This covers channel arithmetic, eligibility, storage-consistency errors, negative totals, output-bound overflow, unsafe integer sums and the 100,000-row bound.
- Plan 013 must test source-to-input conversion: eligibility filtering, pair deduplication and filtering, omissions, exit codes, envelopes, `fullScopeEstimate`, and that readiness and indicator metadata do not change the flags or the estimate.
- Empirical validity is deferred to the [calibration protocol](../calibration/protocol.md).
