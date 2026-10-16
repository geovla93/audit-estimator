# Estimation scope and dependency reuse

A flattened contract loses the path distinction between project code and dependencies, so familiar library implementations and their relationships are priced as newly written project code. This page records how a caller states which declarations an estimate should cover, and how that selection is accounted. It is a planning-policy change under [model 1.1.0](model/heuristic-v1-1.md); it is not a claim that any code is safe.

## Status

- **Caller-selected contract scope: implemented.** It needs no reference data and no catalog.
- **Content-matched dependency reuse: not implemented in this revision.** No reference catalog is bundled, no declaration is ever discounted automatically, and `analysis.dependencyReuse` is not emitted. Recognition and selection are independent inputs: failed or absent recognition never creates a caller scope, and a caller scope never depends on recognition.

## Caller scope

`estimationScope` is available as `AnalyzeRequest.estimationScope` and as a `1.1.0` config field. The selector grammar, hash guard semantics, project-root-relative paths and error behavior are described in [configuration](configuration.md#estimation-scope).

### Accounting

For the eligible, successfully analyzed first-party scoped files the application derives a **review projection** next to the raw metrics. Raw file, contract and callable metrics, relationship graphs, indicators and fingerprints of the source evidence keep their meaning. The projection:

1. removes the tokens, declarations and events of each caller-excluded top-level declaration, keyed by its original contract identity and byte range;
2. counts review SLOC as the union of physical lines touched by retained non-trivia tokens, with a bounded incremental decoder, so a mixed line stays chargeable once;
3. recomputes decisions, storage counts and shapes, assembly and confirmed builtin calls from retained facts; the builtin count is recomputed with the existing rule over retained call sites only when their coverage can be proved, and otherwise stays unavailable;
4. conserves lines: `raw = review + reused + caller-excluded`, per file and in aggregate. In this revision `reused` is always zero.

Free functions, file-level constants and directives, imports and pragmas always stay in the review.

### Reported metadata

`analysis.estimationScope` is present in every non-error analysis. It records the mode, the caller's reason, the sorted selected and context contract identities, `scopeNarrowed`, `requestedScopeComplete` and four aggregate line counts. The counts are all measured or all `unavailable`; if a projection cannot be completed the partition is kept, the counts are unavailable, `requestedScopeComplete` is false, and no estimate is produced even with `--allow-partial`. An over-large internal scope is reported as a sanitized `LIMIT_EXCEEDED` error with no analysis. `requestedScopeComplete` does not replace `requiredAnalysisComplete`.

### Coverage and exit status

A narrowed estimate keeps the existing vocabulary: `coverage: analyzed-subset`, `fullScopeEstimate: null`, status `partial` and exit code 4, without a second `--allow-partial` opt-in, because the caller authorized the subset. Genuine required-analysis failures keep their existing rules and still need `--allow-partial`. If every eligible declaration is selected, nothing is narrowed and the report is an ordinary full-scope result. `inspect` reports the scope metadata and stays complete when raw analysis is complete.

### Limits of an explicit selection

- Selecting a contract does not select its inheritance ancestors, helpers or callees. A named root contract alone is not the behavioral scope of a deployed token, because Solidity inheritance combines base behavior. List every declaration whose review belongs in the engagement.
- Caller-excluded code is context chosen by the caller. It is never evidence of verified reuse and must not be described as a known-safe library. Known relationships between selected and context code keep a boundary allowance; relationships among context declarations are not charged.
- A source change can move declarations without a hash guard; a guarded selector must be refreshed deliberately.

## Evidence

Verified on the synthetic `examples/projects/contract-scope` project (22 source lines; the `Token` selection leaves 9 review lines and 13 caller-excluded lines, one `Token` to `Lib` boundary pair): the integration suite hand-checks the baseline (`9 x 0.04` to `9 x 0.12`), the boundary allowance, the reserve and the 4 to 19 hour range. No external project and no upstream library source was used.
