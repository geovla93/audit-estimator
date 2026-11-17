# Effort indicators and readiness metadata

These definitions are `INDICATORS_VERSION` <!-- docs:fact indicators-version -->1.0.0 (`src/domain/versions.ts`). Indicators are audit-effort review prompts. They are **not security findings**: no rule states severity, vulnerability, protection or intent, and changing any predicate below changes the meaning of `1.0.0` and needs a reviewed plan that bumps the version.

- `src/indicators/catalog.ts`: the frozen rule catalog, exact-name sets, summary templates and ordering helper.
- `src/indicators/classify.ts`: pure `classifyIndicators(input)`.
- `src/indicators/human-prompts.ts`: the eight unanswered project prompts.
- `src/indicators/lcov.ts`: data-only LCOV subset parser (`parseLcovBatches`).
- `src/indicators/readiness.ts`: bounded test-directory and coverage inspection (`collectReadiness`).

Nothing here is exported from `src/index.ts`. Application assembly, the envelope and the estimate belong to later plans. Indicators and readiness never change a numeric estimate: tests and indicator-derived dependency names earn no automatic trust or effort discount, and no rule carries a coefficient. Only the separate [content-match policy](dependency-reuse.md) can reduce the full-review scope.

## Evidence kinds and confidence

| `evidenceKind` | Meaning                                                                                   | `requiresAssessment` |
| -------------- | ----------------------------------------------------------------------------------------- | -------------------- |
| `measured`     | A syntactic or semantic occurrence fact, with evidence ranges in original Solidity bytes. | `false`              |
| `heuristic`    | A name or shape match that suggests where to look. It never proves semantics.             | `true`               |
| `human`        | An unassessed prompt or an explicit evidence gap.                                         | `true`               |

`confidence` describes how strongly the **indicator inference** is supported, not the accuracy of any estimate. `high` is reserved for measured occurrence facts, `medium` for the semantically grounded boundary candidate, `low` for pure name matches and `not-assessed` for human rows. Name decoys (for example a function named `initialize` that is not an initializer) are **expected to trigger** the name-based rules at low confidence.

## Catalog

All names are case-sensitive comparisons of parsed identifier fields. Categories use the schema enum `control | storage | evm | interaction | boundary | uncertainty`.

| Rule key                      | Category    | Kind      | Confidence | Predicate                                                                                                                                                                                                                                                   |
| ----------------------------- | ----------- | --------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assembly`                    | evm         | measured  | high       | Parsed `assembly` events. A memory-safe annotation is not a safety conclusion.                                                                                                                                                                              |
| `loops`                       | control     | measured  | high       | `control` events whose `control-kind` is in `LOOP_CONTROL_KINDS` (`for`, `while`, `do-while`) and `yul-control` events with `yul-kind` `for`. Yul loops are not added to Solidity metrics.                                                                  |
| `complex-storage-syntax`      | storage     | measured  | high       | `state-variable` events with `type-shape` `mapping` or `array` that are neither `constant` nor `immutable`. User-defined and unknown mutable storage stays unresolved.                                                                                      |
| `builtin-low-level`           | evm         | measured  | high       | A call-site fact with `lowLevelCandidate` and `builtin: confirmed`. Delegatecall is identified only through its confirmed parsed member name. `rejected` and `unknown` candidates never trigger.                                                            |
| `unresolved-import`           | uncertainty | measured  | high       | An import reference with status `unresolved` or `ambiguous`, cited at the importing directive. It measures failed resolution, never dependency risk.                                                                                                        |
| `upgrade-name-candidate`      | boundary    | heuristic | low        | A parsed `function` named exactly `initialize`, `reinitialize`, `upgradeTo` or `upgradeToAndCall`. Confirmed same-contract delegatecall sites and resolved same-contract inheritance edges are added as supplementary evidence only.                        |
| `privilege-name-candidate`    | control     | heuristic | low        | A `modifier-invocation` whose name has a final dotted segment equal to `onlyOwner`, `onlyRole` or `requiresAuth`. A same-contract modifier declaration of that name is added as supplementary evidence only. No binding or access-effect conclusion.        |
| `external-boundary-candidate` | boundary    | heuristic | medium     | A member call with `symbol: unique`, `dispatch: dynamic`, an identifier or other receiver, and a target callable of a different contract, interface or abstract contract. Libraries, free functions, `this`/`super` and identifier-only calls are excluded. |

Names such as `Oracle`, `hash` or `Math` trigger nothing by themselves. Arithmetic and cryptography recognition, effective access control and upgrade correctness are not parsed and stay human assessment (see prompts). The parser is not extended for them.

Every row carries a fixed rule limitation, including measured rules, plus a scope limitation. `file-evidence-incomplete` is not an occurrence rule: it is the per-file uncertainty row described below.

## Unavailable behavior

Missing evidence never becomes measured absence or low risk. For each included file (scope role `scoped` or `context`) the classifier emits one `file-evidence-incomplete` row (`human`, `not-assessed`, `requiresAssessment: true`) when any of these holds. The row lists the fixed reasons as limitations and cites existing evidence ranges where there are any, otherwise `[]`.

- The parser record is missing or `failed` (any failure code), or metrics report incomplete syntax.
- The file belongs to an unavailable semantic component, even if it has no call sites. The fixed text names the component reason (`member-syntax-failed`, `unresolved-import`, `no-common-grammar`, `authority-excludes-grammar`, `component-too-large`, `no-scoped-member`, `semantics-failed`, `semantics-limit`, `semantics-cancelled`).
- The per-file confirmed built-in low-level total is unavailable. Positive confirmed call-site rows may still be listed and are labelled non-exhaustive.
- A low-level call candidate is `unknown` (cited at the candidate).
- A mutable state variable has a `user-defined` or `unknown` shape (cited at the declaration). Measured mapping and array observations are kept beside this limitation.

Members that are not in the final manifest, or are `excluded`, are ignored. Context observations carry the label "context file" and the limitation that they do not change the scoped review size.

## IDs, ordering and bounds

- Occurrence rows are one per `(rule, owner entity)`, owned by the innermost callable, otherwise contract, otherwise file. Prompts use a fixed project owner.
- IDs are `indicator:<rule>:<sha256 fingerprint>` where the fingerprint is the existing length-framed `fingerprint([rule, ownerKind, ownerId])`. Raw declaration IDs may exceed the 512 code-unit ID bound and are never embedded.
- Summaries are fixed templates with a scope label; source names are never interpolated.
- Evidence is deduplicated by `(file, startByte, endByte)` and sorted by file ID (Unicode code point) then range. Rows are sorted by ID.
- Output bounds mirror the schema: 100,000 rows, 10,000 evidence per row, 1,000 limitations per row, 512 code units of text. Overflow keeps a bounded result and sets `complete: false` with a `LIMIT_EXCEEDED` diagnostic (phase `metrics`) and an explicit limitation. Room for all eight prompts is reserved first; rows beyond the budget are dropped in ID order. Truncated evidence carries a row limitation. Nothing is silently truncated.
- Contradictory duplicate records for one canonical ID throw `TypeError`. Byte-identical duplicates are deduplicated.

## Human prompts

Eight project prompts are always present, unanswered (`human`, `not-assessed`, `requiresAssessment: true`). They are optional operator work, not interactive CLI questions, and they never become automatic adjustments. Reasoned manual adjustments stay separate configuration.

| Key                        | Category    |
| -------------------------- | ----------- |
| `business-invariants`      | uncertainty |
| `protocol-novelty`         | uncertainty |
| `external-trust`           | boundary    |
| `custom-math-cryptography` | evm         |
| `documentation`            | uncertainty |
| `upgrade-lifecycle`        | boundary    |
| `cross-chain`              | boundary    |
| `review-depth`             | uncertainty |

Related evidence may be attached without answering the prompt: `external-trust` receives `builtin-low-level` and `external-boundary-candidate` evidence, `custom-math-cryptography` receives `assembly` evidence and `upgrade-lifecycle` receives `upgrade-name-candidate` evidence.

## Classifier handoff

```ts
classifyIndicators(input: IndicatorInput): IndicatorClassification
```

`IndicatorInput` is `{ manifest, syntax: ParserBatch, metrics: FileMetrics[], relationships: Pick<RelationshipAnalysis, 'imports' | 'components' | 'directBaseEdges' | 'inheritance' | 'callSites' | 'confirmedBuiltinLowLevelCalls' | 'requiredAnalysisComplete' | 'hasUnknownSemantics'> }` plus an optional `bounds` test hook that can only tighten the schema ceilings. The result is `{ indicators, requiredAnalysisComplete, hasUnknownSemantics, complete, diagnostics, limitations }`. The two required-analysis flags are copied unchanged. `complete` describes classification output only (no truncation); resolution uncertainty is reported through `file-evidence-incomplete` rows, never through a confidence score. The classifier performs no I/O and is pure. 013 should copy `indicators` into `Analysis.indicators` and map `diagnostics`/`limitations` into the envelope.

## Readiness metadata

`collectReadiness(input: ReadinessInput): Promise<ReadinessResult>` inspects optional context. It reads no test bodies, runs no scripts, opens no path named inside a coverage artifact, and never changes the required-analysis flags. A `BudgetError` of kind `cancelled` or `deadline` propagates after handles are closed. An exhausted `maxFsEntries` limit is reported as an incomplete observation and is never reset.

`ReadinessResult` fields: `testObservations` and `coverageObservation` (the public `Analysis` projections), `testRoots` (internal per-root summaries), `coverageStatus`, `coverageFiles` (internal per-record statuses), `complete` (readiness inspection only), `provenance` (`unverified-existing-artifact` or `null`), `diagnostics`, `limitations`. Diagnostics use existing codes and phases only; coverage read failures use phase `discovery` (`TARGET_UNREADABLE`, `PATH_BLOCKED`, `SOURCE_CHANGED`, `LIMIT_EXCEEDED`) and malformed or unsupported LCOV uses `SEMANTICS_UNAVAILABLE` in phase `metrics`. 013 consumes `diagnostics` and `limitations` as warnings; they never convert an otherwise complete required analysis into an incomplete one.

### Test presence

The probed path is the validated Foundry test path, otherwise `test` and `tests`; there is no estimator config key for test roots. The public `present` measurement is directory existence with `evidence: []`. It is not test quality, count or pass status.

- `missing` observed safely: measured `false`.
- A safe directory: measured `true`, even if later enumeration fails.
- A regular file, blocked, unreadable or uninspected path: unavailable (`test-path-not-directory`, `test-path-blocked`, `test-path-unreadable`). Discovery's false boolean alone cannot establish absence.

Internal summaries enumerate with `opendir`, the shared filesystem-entry budget and checkpoints, deduplicate physical directories and files across aliases, skip `.git` and do not enter dependency or output trees (`node_modules`, `lib`, `vendor`, `deps`, `out`, `artifacts`, `cache`, `coverage`, `dist`, `build`). Counted files are regular files named `*.t.sol` or `*.test|spec.{js,jsx,ts,tsx,mjs,cjs,mts,cts}`. The count is exact only when traversal completes; otherwise it is an observed lower bound with `exact: null`. Empty directories and unrelated filenames are separate summaries.

### LCOV subset

`readCoverageFile` (ADR 004) reads the configured, root-local artifact under the dedicated `maxLcovBytes` budget. `parseLcovBatches(bytes, options)` is a generator that decodes at most 16 KiB and handles at most 256 lines per `next()`, then yields; readiness calls `budget.checkpoint(true)` between advances.

Supported subset (line coverage only):

- Fatal UTF-8, at most one leading BOM, LF/CRLF/CR, at least one terminated record.
- Each record is one nonempty `SF`, unique `DA:<line>,<hits>[,<checksum>]` lines, optional single `LF` and `LH`, then `end_of_record`. `TN` may precede `SF`. `FN`, `FNDA`, `FNF`, `FNH`, `BRDA`, `BRF`, `BRH` and `VER` inside a record are recognized and ignored; they never affect line totals.
- Lines are positive safe integers; hits are nonnegative safe integers; checksums are 1-128 code units without commas or control characters; decoded lines are at most 8,192 code units.
- Missing `LF`/`LH` are derived from unique DA lines and DA hits > 0; supplied values must agree. A zero-DA record is valid only with LF=LH=0.
- Rejected, with the whole artifact unavailable: duplicate DA lines (even identical), duplicate `LF`/`LH`, negative, fractional or unsafe numbers, nested `SF`, unterminated records, unknown tags, trailing nonblank text, duplicate normalized `SF` paths, and two `SF` aliases that map to one scoped identity. Exceeding byte-derived limits is `LIMIT_EXCEEDED`. No partial totals are ever produced.

`SF` paths are root-relative, or host-native absolute paths contained under the captured canonical or lexical root by whole components. Above-root traversal is rejected before normalization. URI schemes, foreign drive letters, UNC prefixes, control characters, empty segments, and backslashes (on POSIX) are rejected. Windows-style handling exists for parity but only Darwin has been run. An outside-root record invalidates the artifact. Paths map only through final manifest identities and already-observed aliases; no `SF` target is opened, resolved or searched.

### Coverage projection

- No configured artifact: public `null`, no warning.
- Missing, blocked, unreadable, oversized or malformed artifact: the configured root-relative `source` is kept and both measurements are unavailable with a fixed reason (`coverage-missing`, `coverage-blocked`, `coverage-unreadable`, `coverage-oversized`, `coverage-changed`, `lcov-<reason>`).
- Valid artifact: totals count unique DA lines and hits **only** for matched, line-valid scoped files, with `evidence: []`. In-root unmatched and context records are internal observations. A scoped file whose DA line exceeds its known physical line count, or whose physical line count is unavailable, is excluded. A scoped file missing from the artifact is not counted as zero. When nothing matches, both measurements are unavailable with `no-matched-source`, never 0%.
- Every artifact that was read carries internal provenance `unverified-existing-artifact` and a returned limitation. Paths and line numbers cannot establish freshness; there is no stale or fresh verdict, no branch coverage and no project-wide coverage claim. Public totals describe the matched supplied subset only.

Independent oracle: scoped `A` has physical lines 1-3 with `DA:1,0` and `DA:3,4`; scoped `B` is absent from the artifact; context `C` has its own record. Public totals are `covered=1`, `total=2`, with `B` missing and `C` unmatched.

## Known limitations

- Heuristic rows are name matches. A renamed initializer or a custom authorization modifier is not found.
- Arithmetic, cryptographic builtin and access-effect recognizers are not implemented.
- The supported LCOV subset is deliberately narrow. Multi-run merging, branch coverage and freshness claims need a reviewed contract.
- Test and coverage inspection is data-only and Darwin-verified only.
