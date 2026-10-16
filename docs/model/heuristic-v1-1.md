# heuristic-v1 model version 1.1.0

This amendment defines profile `heuristic-v1`, model version `1.1.0`, the default for new calls. The frozen [1.0.0 specification](heuristic-v1.md) is unchanged and stays selectable with `model.modelVersion: "1.0.0"`; its worked fixtures and arithmetic are retained. Every coefficient below is the same uncalibrated starter assumption as in `1.0.0`, and nothing here is a measured productivity rate.

## What changed

Version `1.1.0` changes **which code requires full review**, not any coefficient or formula. The estimator input may carry an optional `reviewSummary`; the application builds it from an effective review projection of the eligible files. In that projection:

- each eligible file's `sourceLines` is the measured effective review SLOC, the union of physical lines touched by the tokens of retained code, so a line shared with an omitted declaration is still counted once;
- decisions, mutable-storage counts and shapes, assembly blocks and confirmed builtin low-level calls are recomputed from the retained declarations and events, never scaled from whole-file ratios;
- a declaration omitted from full review contributes no baseline and no control, storage or EVM premium, while the four rows per eligible file are still emitted (possibly with zero values);
- the project allowance, the unavailable-measurement reserve and manual adjustments are unchanged.

A declaration is omitted only for an explicit reason, and the two reasons are never interchangeable: **content reuse** (the declaration's complete token content matches a reviewed upstream reference, whole-scope mode only) and **caller-excluded context** (a declaration left out of an explicit `estimationScope.mode: "contracts"` selection); see [estimation scope and dependency reuse](../dependency-reuse.md). The summary records the mode, analyzed lines, content-reused lines (always zero in contract mode), caller-excluded lines (always zero in whole-scope mode) and whether the scope was narrowed. Plain `1.1.0` input without a summary prices every supplied line, so the model is numerically identical to `1.0.0` for the same facts and parameters; only the version and report metadata differ.

## Pair projection

The existing directed scoped and context pairs are re-partitioned by review role, with the original ordered endpoints de-duplicated and the two partitions kept disjoint:

| Endpoints                                                                    | Category                   |
| ---------------------------------------------------------------------------- | -------------------------- |
| two full-review contracts                                                    | interaction                |
| one full-review contract and one omitted contract, either original direction | boundary                   |
| two omitted contracts                                                        | no charge                  |
| full-review contract to an existing external contract                        | existing boundary behavior |
| omitted contract to an existing external contract                            | no charge                  |

Boundary rates are higher than interaction rates in the starter profile, so omitting code does not guarantee that both endpoints of the range fall. The graph itself is unchanged: only the estimator input is projected, and no reverse or transitive edge is invented.

## Eligibility and coverage

A supplied summary requires measured review lines for every eligible file and must satisfy a truth table: whole-scope mode has no caller exclusions and is never narrowed; contract mode has no content reuse, and a narrowed scope may exclude zero whole lines when excluded declarations share a physical line with retained code; analyzed lines must equal review plus reused plus caller-excluded lines with safe integer arithmetic; contract mode needs positive review lines. An intentional narrowed scope is labelled `analyzed-subset` even when the raw analysis is complete; genuine incomplete analysis still needs `allowPartial`. Fully reused code with positive analyzed lines and zero review lines in whole-scope mode still receives the project allowance, integration allowances and reserve.

## Assumption

The `1.1.0` ledger adds one assumption: omitted declarations (content-reused or caller-excluded) receive no full-review baseline or premium. This is an uncalibrated planning assumption; neither a caller exclusion nor a content match verifies an installed version, dependency bindings, compiler behavior, deployment or security.
