# Limitations

Audit Estimator reports evidence and an effort scenario. It does not detect vulnerabilities, prove correctness, certify security, decide whether a protocol is safe, or guarantee that a review will find defects. Its estimate is not a quote, calendar schedule or probability statement.

## Effort model

`heuristic-v1` is uncalibrated. A caller-selected contract scope narrows the priced declarations without verifying that excluded code is safe or reused; see [dependency reuse and estimation scope](dependency-reuse.md). Its inputs and coefficients are documented assumptions. The low/high endpoints do not have measured coverage probabilities or empirical accuracy claims. Cumulative auditor-hours represent participating reviewers’ effort; days are a display conversion using configured hours per day, not elapsed calendar time. Manual adjustments are explicit human judgment and can include signed discounts.

SLOC is a baseline driver and depends on source layout. The model does not independently charge function, contract and physical-line counts. Unsupported risk signals stay manual rather than being treated as calibrated premiums. See the [model specification](model/heuristic-v1.md) and [calibration protocol](calibration/protocol.md).

## Analysis evidence

Parser completeness and supported capability are different. An incomplete required parse/context result can prevent an ordinary full-scope estimate. A documented unknown capability may instead produce a complete analysis with an uncertainty reserve. Neither outcome establishes security coverage.

Relationship edges are evidence and candidate targets, not proof of runtime dispatch. Dynamic internal calls remain unproven. Storage typing, inheritance, imports and compiler-version interpretation have explicit boundaries documented in [relationships](relationships.md), [metrics](metrics.md), and [the Slang research report](research/slang-spike.md).

Readiness indicators are bounded observations, not tests of quality. Test directory presence and matched LCOV records do not prove that tests are relevant, complete, passing or secure. Some records may be unverified or matched only to a subset. They do not change estimate effort.

## Operational and privacy boundaries

The tool is designed to analyze local files without target execution or network access. It is not an operating-system sandbox. A compromised runtime, hostile filesystem, resource exhaustion or operating-system behavior remains outside that promise. Symlink traversal is opt-in and confined to the project’s physical root; external pnpm store paths are not project content.

Reports can contain project-relative names and bounded evidence. Diagnostic prose is supplied by application components and should be reviewed before publication. Renderers do not add native source paths or source excerpts, but users should still inspect output for private project information.

Supported target conventions and metadata are intentionally narrow. Foundry defaults are read as data; Hardhat is recognized by markers without evaluating JavaScript/TypeScript configuration. Arbitrary build systems, custom compiler behavior, generated-source provenance and external package installation are not inferred.
