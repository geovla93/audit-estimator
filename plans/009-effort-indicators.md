# Plan 009: Separate measured evidence, heuristic indicators and human assessment

> **Executor instructions:** Add versioned evidence rules and metadata observations only. Run each gate and update status 009 in `plans/README.md`. These are audit-effort indicators, not security findings.
>
> **Drift check first:** Reconciled at `2eb8d3d` on 2026-10-15; plans 001–008 are present on `main`. Run `git status --short`, `git diff --stat 2eb8d3d..HEAD -- src/indicators src/domain src/parser src/metrics src/relationships src/discovery test/unit/indicators.test.ts test/unit/lcov.test.ts test/integration/readiness-metadata.test.ts test/integration/safe-read.test.ts test/fixtures/indicators test/fixtures/coverage test/fixtures/manifest.json docs/indicators.md docs/adr/004-scope-safety.md plans/README.md`, and `git diff HEAD --` with that same path list (plus inspect untracked in-scope files). Check prerequisite statuses and the current-state snapshot below. Expected completed-prerequisite additions require inspection; contradictory contracts or overlapping implementation edits require reconciliation before implementation. Preserve unrelated local edits, including the existing edits to plans 010–016. Domain/parser/metric/relationship paths are read-only drift dependencies, not edit permission.

## Status

- **Priority:** P1
- **Effort:** L (catalog, readiness walker, safe LCOV reader and adversarial verification)
- **Risk:** MED (false interpretation and misleading assurance)
- **Depends on:** `plans/007-source-structural-metrics.md`, `plans/008-imports-inheritance-interactions.md`
- **Category:** direction
- **Planned at:** commit `2eb8d3d`, reconciled 2026-10-15 after 007/008 reached `main`; supersedes `d11bc60`. Reviewed against the template and live contracts on 2026-10-15. Originally greenfield planning on 2026-10-14.

## Why this matters

Syntax can reveal additional review work without proving exploitability or business intent. Explicit indicator provenance and human prompts help an auditor interpret upgrade/access/dependency/test evidence while keeping speculative characteristics out of automatic numeric weighting.

## Current state and architectural context

### Reconciled implementation baseline — 2026-10-15 (refreshed at `2eb8d3d`)

`src/indicators/` is absent. `Indicator` is already defined with the exact fields shown below in the original context, and `Analysis` already has `testObservations`, `coverageObservation` and explicit completeness fields. `coverageObservation` currently exposes source, coveredLines and totalLines; per-file matching/stale provenance details need internal readiness records plus existing diagnostics/limitations, not extra keys on strict public objects. Use the existing measured/unavailable tags and diagnostic codes. If required machine-readable detail cannot fit, STOP for a focused schema amendment.

Config already supplies root-confined `coverage.lcovPath` and `maxLcovBytes`; do not reuse `parseConfigBytes` for LCOV or allow its parser to execute anything. `firstPartyOverrides` is a path-root policy, not a name-based trust signal. Safe bounded reads (005, `src/discovery/safe-read.ts`) and parser syntax records (006, `src/parser/`) are merged; read LCOV through 005's bounded primitives and shared budget, never a new unbounded `readFile`. Metrics (007) and relationships (008) are implemented; their internal handoff is specified below. Application assembly remains 013 work; this plan must not implement it.

Match established strict ESM conventions: `.ts` source imports, explicit named exports and exported annotations, `import type`, readonly DTOs, no `any` or suppressions, unknown caught values narrowed before use. Tests use Vitest source imports for units and the trusted build-first integration wrapper for artifact suites. These current facts supersede prospective wording in the original context below.

### Implemented metrics and semantic handoff

`src/metrics/structural.ts:533` exports `buildFileMetrics(source, result): FileMetrics`; `src/metrics/aggregate.ts` exports `aggregateMetrics(files)`. `FileMetrics` contains `file`, `contracts`, `callables`, `lineSet`, `wholeFile`. Source counts are pure syntax facts; `file.lowLevelCallCandidates` is not a builtin measurement.

`src/relationships/closure.ts:916` exports `resolveRelationships(input: RelationshipInput): Promise<RelationshipAnalysis>`. The internal DTO in `src/relationships/types.ts` contains `manifest`, `sources`, `syntax`, `imports`, `graphs`, `inheritance`, `directBaseEdges`, `callSites`, `scopedPairs`, `contextPairs`, `confirmedBuiltinLowLevelCalls`, `invalidatedScopedFileIds`, `requiredAnalysisComplete`, `hasUnknownSemantics`, `fingerprint`. Public `Analysis.graphs` cannot encode all these facts. Define an explicitly annotated internal classifier input in an in-scope indicator module that accepts the required plain syntax/metric/relationship records; the historical `classifyIndicators(analysis)` sketch below is not a requirement to squeeze companion fields into public `Analysis`. Pure rules use type-only imports; they must not invoke the parser or filesystem.

Consume `CallSiteFact.symbol`, `dispatch`, `builtin`, `limitation` separately. A builtin name alone never confirms a builtin; an internal contract call may have a unique symbol with dynamic dispatch and an unsupported public edge. Named aliases/overloads retain candidates. `confirmedBuiltinLowLevelCalls` is per-file `Measurement<number>`: preserve unavailable and unknown outcomes. User-defined mutable storage types remain unresolved; the measured syntax complex-ID list includes mappings/arrays only and does not prove other declarations simple. Never change syntax metrics to manufacture a resolved type.

Read `docs/metrics.md` and `docs/relationships.md` for accepted definitions. Where the catalog below requests facts not emitted by the current parser (arithmetic operations or named cryptographic builtin classification), omit the automatic rule and record the limitation plus a human prompt. Do not extend parser scope, infer facts from generic call names, or block the whole catalog for a deliberately unsupported recognizer. Use `test/unit/relationships.test.ts` as a plain-record test exemplar; native tests can follow `test/integration/relationships.test.ts`. Add regression cases for confirmed/rejected/unknown low-level calls and unavailable user-defined storage. Run readiness artifact tests through `pnpm test:integration test/integration/readiness-metadata.test.ts` so the worker is fresh.

### Reviewed load-bearing contracts — 2026-10-15

The following live-code details supersede the historical sketches below:

```ts
// src/domain/schemas.ts:338 — Indicator category is narrower than its TS string field.
category: z.enum(['control', 'storage', 'evm', 'interaction', 'boundary', 'uncertainty']),
// src/discovery/safe-read.ts:317 — maximumBytes cannot lift this metadata ceiling.
const maximumBytes = Math.min(
  BOOTSTRAP_METADATA_BYTES, // 256 KiB
  context.maximumBytes ?? context.budget.limits.maxMetadataBytes,
  context.budget.limits.maxMetadataBytes,
);
```

`src/domain/types.ts:333` exposes only test `{path,present: Measurement<boolean>}` and coverage `{source:string|null,coveredLines:Measurement<number>,totalLines:Measurement<number>} | null`. `source` is a root-relative **path** in the strict schema, not a provenance label. EvidenceRef only references original Solidity bytes: metadata observations use `evidence: []`, with matching/provenance details returned internally and through existing diagnostics/limitations. Diagnostic phases have no `indicators` value; details are capped at 32 scalar pairs. Public indicator IDs/summaries are capped at 512 code units, evidence at 10,000/row, limitations at 1,000/row, rows at 100,000 with unique IDs.

`src/discovery/budget.ts:6` lacks LCOV accounting; `maxLcovBytes` exists but the source/metadata counters cannot enforce it independently. `src/discovery/discover.ts:375` probes test-directory existence only; its catch maps blocked/unreadable paths to false, so readiness must independently distinguish missing from uninspected. `src/parser/extract-syntax.ts:865` does emit modifier-invocation name records, with no binding/access-effect proof. Arithmetic/bitwise and named cryptographic builtin recognizers remain unsupported. No root README, CONTRIBUTING or CI workflow exists at baseline; intent/accepted contracts are in plans and ADRs 002–005. The public entry remains types/versions only.

**Verification in this review:** Node `24.21.0`, pnpm `11.28.4`, typecheck, lint, format check and all **209 existing units** pass using installed dependencies and `verifyDepsBeforeRun=false`. No install, build, integration, schemas or coverage rerun in this review; the reconciliation results below are historical. New feature tests remain executor targets. Oxfmt ignores `plans/**`; also check Markdown links/fences and `git diff --check` for plan changes.

### Original design context (retained)

No classifiers existed at planning. The implemented companion records above replace that prospective assumption. Classification is pure; separate readiness loading uses bounded data-only reads. Indicators have `{id,ruleVersion,category,evidenceKind:"measured|heuristic|human",confidence:"high|medium|low|not-assessed",summary,evidence,limitations,requiresAssessment}`. Confidence refers to the indicator inference, **not estimate accuracy**. Use `1.0.0` rule catalog version.

Rules describe patterns, never severity/vulnerability/safe/unsafe conclusions. Existing tests or known dependencies do not earn automatic effort discounts. [OpenZeppelin readiness guidance](https://learn.openzeppelin.com/security-audits/readiness-guide) motivates test/documentation context; it does not supply quantitative coefficients.

## Commands you will need

**Reconciliation gate note (2026-10-15 at `2eb8d3d`):** Plans 001–008 are implemented on `main`. On Node `24.21.0` with pinned pnpm `11.28.4`, this reconciliation passed `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` (209 units), fresh-build `pnpm test:integration` (182 integration/research tests) and `pnpm schemas:check`. Scripts were invoked with `--config.verifyDepsBeforeRun=false` against installed dependencies to avoid implicit dependency reconciliation. No frozen install or coverage run was performed. Production output still has ten files: `index.js`, `index.d.ts`, `bin.js`/`.map`, `version.js`/`.map`, `versions.js`/`.map`, `parser/worker.js`/`.map`. Preserve the inventory assertion in `test/integration/bootstrap-cli.test.ts`; new entries/chunks require an explicit amendment. The former skill-file formatting exception is gone; **any format-check failure is a STOP**. Linux/Windows and package installation remain unverified. Proposed feature-specific tests/scripts below must be supplied by their owning plans.

An executor works in its own checkout or worktree, which does not share `node_modules`: run `pnpm install --frozen-lockfile` first and obtain success. Afterwards `pnpm --config.verifyDepsBeforeRun=false run <script>` runs a script without pnpm's implicit dependency reconciliation (it does not repair missing packages). Built-artifact suites run through the build-first wrapper (`pnpm test:integration` / `pnpm test:all`), never against stale `dist/`. This reconciliation did not run `pnpm install --frozen-lockfile` or `pnpm test:coverage`.

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Feature-specific commands below are execution targets; the shared gates above were verified during this reconciliation.

| Purpose | Command | Expected |
|---|---|---|
| Indicator rules | `pnpm --config.verifyDepsBeforeRun=false run test test/unit/indicators.test.ts` | positive/decoy/unknown cases pass |
| LCOV units | `pnpm --config.verifyDepsBeforeRun=false run test test/unit/lcov.test.ts` | supported line-data subset and invalid cases pass |
| Readiness metadata | `pnpm --config.verifyDepsBeforeRun=false run test:integration test/integration/readiness-metadata.test.ts test/integration/safe-read.test.ts test/integration/discovery.test.ts` | fresh build, bounded test/LCOV observations and reader/discovery regressions pass |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm build`, `pnpm schemas:check` | 0 |

## Scope

**In scope (only these implementation files):** create `src/indicators/{catalog,classify,readiness,lcov,human-prompts}.ts`, `test/unit/indicators.test.ts`, `test/unit/lcov.test.ts`, `test/integration/readiness-metadata.test.ts`, `docs/indicators.md`; amend `src/discovery/safe-read.ts`, `src/discovery/budget.ts` and `test/integration/safe-read.test.ts` only for the dedicated LCOV reader/accounting and regressions; add `test/fixtures/indicators/**`, `test/fixtures/coverage/**` and their attribution/independent counts to `test/fixtures/manifest.json` (Solidity entries in existing `fixtures`; non-Solidity entries in a new separate `readinessFixtures` array validated by readiness tests); amend `docs/adr/004-scope-safety.md` only for the LCOV reader/accounting contract; update only the 009 status row in `plans/README.md`. Internal input/result types live in these indicator modules. Generate large/racy fixtures in temporary projects and clean them up with existing helpers.

**Out of scope:** parser/relationship/metric extraction, public domain schemas/types/versions, config keys/defaults, package exports/build configuration/dependencies, application/CLI/renderer implementation, numerical coefficients/formulas, running tests/coverage/build scripts in target projects, fetching dependency trust/security lists, vulnerability labels, advanced protocol fingerprinting, business-logic/cryptographic correctness, generic regex Solidity recognition, report changes.

## Git workflow

Use the supplied checkout; no additional branch-naming convention was observed. Recent history uses Conventional Commits (for example `896d27a feat: wire relationship pipeline, pairs, limits and handoff docs`). No commit/push/publication or branch change without operator instruction.

## Steps

### Step 1: Freeze a supported catalog and pure input/output contract

Create a readonly catalog in `src/indicators/catalog.ts`. Use existing `INDICATORS_VERSION` (`1.0.0`) from `src/domain/versions.ts`, not a duplicate version value. Implement only these automatic rules:

| Rule key | Category / evidence kind / confidence | Trigger and limits |
|---|---|---|
| `assembly` | evm / measured / high | Parsed assembly/Yul events; cite their ranges. A memory-safe annotation is not safety assurance. |
| `loops` | control / measured / high | Parsed Solidity `control` events using existing `LOOP_CONTROL_KINDS`, and Yul `yul-control` with `yul-kind: for`; do not add Yul loops to Solidity metrics. |
| `complex-storage-syntax` | storage / measured / high | Mutable mapping/array state-variable events, excluding constant/immutable declarations; user-defined/unknown storage remains unresolved. |
| `builtin-low-level` | evm / measured / high | A low-level candidate call-site fact with `builtin: confirmed`; delegatecall is identified only from its confirmed parsed member name. Rejected/unknown candidates do not trigger. |
| `unresolved-import` | uncertainty / measured / high | Unresolved/ambiguous import and its importer range; measures failed resolution, never dependency risk. |
| `upgrade-name-candidate` | boundary / heuristic / low | A parsed function named exactly `initialize`, `reinitialize`, `upgradeTo` or `upgradeToAndCall`. Same-contract resolved inheritance/confirmed delegatecall can supplement evidence, never prove proxy semantics or raise confidence. |
| `privilege-name-candidate` | control / heuristic / low | Parsed modifier-invocation name whose final dotted segment is exactly `onlyOwner`, `onlyRole` or `requiresAuth`. Same-contract matching modifier declarations may supplement evidence; no binding/access-effect conclusion. |
| `external-boundary-candidate` | boundary / heuristic / medium | Member-call fact with unique symbol target, dynamic dispatch, identifier/other receiver, and target callable belonging to a different contract/interface/abstract contract. Exclude libraries, free functions, this/super and identifier-only internal calls. Possible boundary only; runtime dispatch/address remains unproven. |

Names use case-sensitive comparisons of parsed identifier fields. Name decoys are **expected to trigger the explicitly name-based rules at low confidence**; no test should demand their absence while those predicates hold. `Oracle`, `hash`, `Math` or base names alone trigger no other rule. Arithmetic/cryptography, effective access control and upgrade correctness remain human assessment; do not extend the parser to support them. Do not classify whole protocols.

Measured occurrence rows use `requiresAssessment: false`; all heuristic and unassessed rows use true. Every rule has a fixed limitation explaining its inference boundary, including the measured rules.

Create an annotated internal `IndicatorInput` in `classify.ts` with `manifest: ScopeManifest`, `syntax: ParserBatch`, `metrics: readonly FileMetrics[]`, and `relationships: Pick<RelationshipAnalysis, 'imports' | 'components' | 'directBaseEdges' | 'inheritance' | 'callSites' | 'confirmedBuiltinLowLevelCalls' | 'requiredAnalysisComplete' | 'hasUnknownSemantics'>`. Export `classifyIndicators(input): IndicatorClassification`; its readonly result fields are `indicators: readonly Indicator[]`, `requiredAnalysisComplete: boolean`, `hasUnknownSemantics: boolean` (both copied unchanged), `complete: boolean` (classification only), `diagnostics: readonly Diagnostic[]`, `limitations: readonly string[]`. Resolution uncertainty is reported separately from confidence; no confidence score substitutes for missing records. No source text, filesystem context or parser handles. Join by canonical IDs; contradictory duplicate IDs are an error, never an order-dependent choice.

Positive confirmed call-site evidence may survive an unavailable per-file builtin total; do not claim it is exhaustive. Failed syntax/unavailable semantics or unresolved mutable user-defined storage produce explicit per-file unassessed uncertainty rows (`human`, `not-assessed`, `requiresAssessment: true`) with valid existing evidence or `[]`. Preserve measured mapping/array observations alongside that limitation. Map every unavailable `components` member to the per-file uncertainty row even when that file has no call-site facts; use the fixed component reason. Exclude nonselected/excluded members and retain context labels. Missing evidence never becomes measured absence/low risk.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test test/unit/indicators.test.ts -t 'catalog rules'` → 0 for positive/absent/failed syntax, confirmed/rejected/unknown builtin, name-decoy, ambiguous-alias and dynamic-dispatch cases; `pnpm typecheck` → 0.

### Step 2: Make prompts and output deterministic, schema-valid and bounded

Always expose eight project prompts in `human-prompts.ts`: `business-invariants`, `protocol-novelty`, `external-trust`, `custom-math-cryptography`, `documentation`, `upgrade-lifecycle`, `cross-chain`, `review-depth`. Use `human`, `not-assessed`, `requiresAssessment: true`. Categories: `boundary` for external-trust/upgrade-lifecycle/cross-chain, `evm` for custom-math-cryptography, `uncertainty` for the rest. Relevant evidence may be attached without answering prompts. They are optional operator work, not interactive CLI questions. Existing reasoned manual adjustments remain separate config/estimator input; do not generate or infer them.

Use one row per `(rule, owner entity)`, owned by innermost callable, otherwise contract, otherwise file; prompts use a fixed project owner. Deduplicate evidence by file/startByte/endByte and sort by Unicode code point/file/range, rows by ID. Generate bounded IDs such as `indicator:<rule>:<fingerprint>` with existing length-framed `fingerprint` on rule and owner, not raw declaration IDs (which may exceed the indicator's 512-code-unit limit). Summaries use fixed templates and scope labels instead of arbitrarily long source names. Exclude excluded files; retain scoped/context distinction in summary/limitations from the final manifest. Context evidence never changes scoped review size.

Enforce current schema bounds before retaining output: 100,000 rows, 10,000 evidence/row, 1,000 limitations/row and 512-code-unit text. Overflow returns a bounded `LIMIT_EXCEEDED` diagnostic/limitation and incomplete internal classification, never an apparently exhaustive truncated result. Reserve room for all project prompts, deduplicate reasons and preserve input completeness flags. No native paths/errors/source text in messages. Document ordering, unavailable and overflow policies.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test test/unit/indicators.test.ts -t 'classification and prompts'` → 0 with frozen/shuffled inputs, duplicate evidence, long valid file IDs, mixed roles, unavailable facts and >10,000 evidence references. Validate every row with `IndicatorSchema`, unique IDs and eight mandatory unanswered prompts. `pnpm typecheck` → 0.

### Step 3: Add dedicated safe LCOV reading and accounting

The existing safe metadata reader cannot deliver the promised LCOV capacity. Extend `src/discovery/budget.ts` with internal `lcovBytes` counter/failure-budget name, allowance/charge methods against effective `maxLcovBytes`, and tightening checks against bytes already consumed. Preserve the same shared budget object/deadline; no reset on repeated reads. LCOV bytes do not consume metadata/source bytes, source file identities or parser allowances. Charge returned bytes, including an over-limit probe, before propagating interruption, following existing reader behavior.

Generalize private `readBoundedBytes` in `src/discovery/safe-read.ts` from the metadata boolean to source/metadata/lcov modes. Add annotated `readCoverageFile(context, candidatePath): Promise<Uint8Array>` taking `SafePathContext`, shared `DiscoveryBudget` and optional existing `SafeReadAdapter`. Reuse descriptor/nonblocking/no-follow/identity/version checks, bounded chunking and guaranteed close. Reject symlinks as metadata does, even when source symlinks are enabled. Metadata keeps its existing 256 KiB cap; coverage uses effective `maxLcovBytes` (4 MiB default; existing schema ceiling 40 MiB), never `maxFileBytes`.

Read only the configured root-local artifact. Like other metadata, coverage uses root-only containment without the selected Solidity target restriction, allowing a report beside a literal `.sol` target. This does not change source/context confinement. Outside-root, `.git`, special files and weaker-flag retries remain forbidden. Amend ADR 004 narrowly with these decisions.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test:integration test/integration/safe-read.test.ts test/integration/discovery.test.ts` → 0 for valid >256 KiB LCOV, exact/lowered/over-limit caps, nonzero source/metadata counters, cumulative reads, tightening below consumption, cancellation/deadline and close-on-error. Existing metadata still rejects >256 KiB. Retain symlink/outside-root/FIFO/descriptor-change regressions and existing platform capability checks. `pnpm typecheck`, `pnpm lint` → 0.

### Step 4: Parse a bounded LCOV subset and collect readiness

Implement `parseLcovBatches(bytes: Uint8Array, options: LcovParseOptions): Generator<void, LcovParseResult, void>` in `lcov.ts`. Options carry the byte limit and plain path/manifest/alias/physical-line matching inputs, never read adapters. The generator is data-only: process at most 256 lines or 16 KiB per `next()` (a single line may complete up to the line cap), yielding void before continuing; it returns a discriminated parsed/unavailable result with safe root-relative records and fixed reasons. Readiness calls `await budget.checkpoint(true)` between advances, propagating interruptions after cleanup. Units drain the same generator without filesystem/native APIs. Use pure unit oracles and this explicit supported subset:

- Fatal UTF-8, optional one leading BOM, LF/CRLF/CR, at least one terminated record. Each record has one nonempty `SF`, then unique `DA:<positive-safe-line>,<nonnegative-safe-hit-count>[,<bounded-checksum>]`, optional single LF/LH, then `end_of_record`. Reject nested SF, unterminated records and trailing nonblank text.
- Derive missing LF/LH from unique DA lines and DA hits >0. If supplied, counts must agree. Reject duplicate DA lines (including identical duplicates), duplicate LF/LH, negatives/fractions/unsafe integers and unsafe aggregate sums. Zero DA lines is valid only with derived/provided LF=LH=0.
- Recognize and ignore bounded TN/FN/FNDA/FNF/FNH/BRDA/BRF/BRH/VER lines: TN may precede SF; others belong inside a record. They never affect line totals. Reject unknown tags and duplicate normalized SF records rather than invent a multi-run merge. Distinct SF aliases that map to the same scoped identity also invalidate the artifact, avoiding double counting. Document this line-only compatibility subset.
- Bound retained lines/records/maps by byte-derived limits before growth; cap a decoded line at 8,192 code units and optional checksums at 128 nonempty code units without commas/control characters. Reject before retaining an oversized line. Scan incrementally, never split the entire artifact into an unbounded line array or buffer all records before yielding. Exceeded parse limits produce unavailable/LIMIT_EXCEEDED, never partial totals. Shared-budget checkpoints between batches make cancellation/deadlines observable.

SF paths are root-relative, or host-native absolute paths lexically contained under captured canonical/lexical root by components. Reject above-root traversal before normalization, URI/foreign-drive/UNC/control paths and invalid separators. Document platform behavior. Map only through final scoped manifest identities and already-observed safe aliases; never open/realpath/search an SF target. Outside-root records invalidate the supplied artifact. Valid in-root unmatched/context records remain internal unmatched observations, excluded from numeric totals. Match DA line numbers against known original physical line counts; out-of-range lines make that file unavailable. An unavailable/missing physical-line measurement likewise excludes that file with a fixed unassessed reason, never an assumed zero or guessed line bound. Paths/line numbers cannot establish freshness.

In `readiness.ts`, export annotated `ReadinessInput`, `ReadinessResult` and `collectReadiness(input): Promise<ReadinessResult>`. Input contains root-only safe-path context, existing shared budget, validated `ProjectMetadataPaths`, `ResolvedConfig['coverage']`, final manifest, scoped physical-line measurements and already-observed alias mappings; allow existing safe-read/directory adapters for tests. Result readonly fields are `testObservations: Analysis['testObservations']`, `coverageObservation: Analysis['coverageObservation']`, `testRoots` (internal per-root existence/traversal/count summaries), `coverageFiles` (internal per-record/scoped-file matching statuses), `complete: boolean` (readiness inspection only), `provenance: 'unverified-existing-artifact' | null`, `diagnostics: readonly Diagnostic[]`, `limitations: readonly string[]`. Define discriminated readonly records for test/coverage internal statuses from the policies below; no native paths in the result. No envelope assembly here.

**Test presence:** probe validated Foundry test path, otherwise `test` and `tests`; there is no estimator config key for test roots. Public `present` measures directory existence with `evidence: []`, not test quality/counts. Only a safe `missing` result proves false. A safe directory proves true even if later enumeration fails; a regular file/blocked/unreadable/uninspected path yields unavailable. Discovery's false boolean alone cannot establish absence. Enumerate directories using `opendir`, existing `DiscoveryDirectoryAdapter`, `resolveSafePath`, shared filesystem-entry/depth budgets, cooperative checkpoints and finally-closed handles. Recheck descendant confinement, deduplicate physical directories/files across aliases and respect hard exclusions; do not recurse through dependency/output trees found inside a test root. Count only regular `.t.sol` files and `.test`/`.spec` filenames ending `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, without opening bodies. Counts remain internal; exact count is unavailable on incomplete traversal, with any observed lower bound labelled. Empty directories and unrelated filenames are separate summaries.

**Coverage projection:**

- No configured artifact: public null, internal `not-requested`, no search/warning.
- Supplied missing/blocked/unreadable/oversized/malformed artifact: keep configured root-relative `source`, both measurements unavailable with a fixed reason. No partial totals from malformed records. Map read failures to existing TARGET_UNREADABLE/PATH_BLOCKED/SOURCE_CHANGED/LIMIT_EXCEEDED in phase discovery; malformed/unsupported LCOV uses SEMANTICS_UNAVAILABLE in phase metrics. No new code/phase.
- Valid artifact: totals count unique DA lines/hits only from matched line-valid scoped identities. Record matched, unmatched artifact records, scoped files absent from artifact, and line mismatches internally. Public totals measure this **matched supplied subset** with `evidence: []`; no usable match means unavailable (`no-matched-source`), never 0% coverage. Do not substitute SLOC for executable lines or count missing scoped files as zero-covered.
- Every supplied artifact carries internal provenance `unverified-existing-artifact` and an explicit returned limitation, even with plausible current paths. Public `source` remains the artifact path. No stale/fresh verdict, branch coverage or project-wide coverage claim. Return bounded diagnostic/limitation summaries of unmatched/missing/mismatch counts and the matched-subset basis; detailed lists stay internal.

Independent coverage oracle: scoped A has physical lines 1–3 with `DA:1,0` and `DA:3,4`; scoped B is absent, and context C has its own record. Public matched-subset totals are covered=1, total=2, with B missing and C unmatched; neither contributes extra lines. Two A aliases in SF invalidate the artifact rather than doubling it.

Do not rewrite required Solidity-analysis completeness or unknown-semantics flags for optional readiness failures. Return separate inspection completeness and warnings for 013. Cancellation/deadline BudgetErrors propagate after cleanup. Exhausted global budgets cannot be disguised as complete optional observations or reset for further work. Never execute scripts, test bodies, coverage generators, compiler binaries or project configs.

**Verify:** LCOV units and the fresh-build readiness/read/discovery command → 0. Cover valid optional fields, absent totals, duplicates/conflicts, unsafe numbers, invalid UTF-8, empty/truncated data, absolute/relative/outside paths, aliases, unmatched/context-only/partial scope, zero lines, line mismatches and stale-but-plausible paths. Test presence separately from count completeness, adapters closed on error, and no test-body/SF-target reads or target marker execution. Include an unavailable component with no call sites in classifier units, an alias pair resolving to one covered identity, and abort/deadline triggered between LCOV parsing batches. Validate public projections with `AnalysisSchema` using an existing complete domain fixture with readiness replaced. `pnpm typecheck` → 0.

### Step 5: Document limits and verify decoupling

The existing research suite (`test/research/slang-spike.test.ts:594`) parses **every** `manifest.fixtures` entry as Solidity. Register new Solidity fixtures there using its existing format; register committed LCOV/other metadata in a separate top-level `readinessFixtures` array with origin/license/byte/line expectations, checked independently by the new readiness integration test. Do not put LCOV text in the Solidity list or change research tests. Temporary generated metadata is also allowed without manifest entries.

Complete `docs/indicators.md` with exact catalog predicates, confidence meaning, category/ID/version rules, unavailable behavior, scope/context labels, prompt mapping, LCOV subset/path/duplicate policy, matched-subset totals and unverified provenance. Document input/result exports and diagnostic/limitation mapping so 013 needs no guessed handoff. Tests and known dependencies earn no automatic trust or effort discount.

Pure catalog/classifier/prompt modules may import only plain types plus deterministic domain/metric-definition helpers and the version constant. No parser runtime/worker, filesystem, readiness, CLI, application, estimation or reporting imports. LCOV parses data only; readiness owns I/O/checkpoints. Export internal functions from their modules; do not change public `src/index.ts` or production entries.

Use meaningful frozen-input, no-estimate/adjustment-output and import-boundary assertions now. The estimator does not exist, so defer the end-to-end assertion to 011/013: changing report-only indicators/readiness on the **same fixed measured facts** must not alter the estimate. Physically adding proxy/storage/call code can change measured facts; do not demand numerical invariance across changed Solidity fixtures, invent a placeholder estimator or create a speculative EstimateInput builder.

**Verify:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm build`, `pnpm schemas:check` → 0. Preserve artifact inventory; no committed schema/version/dependency/public-entry changes. Review tracked/untracked changes against scope while preserving prior edits, then update only status 009 with implementation evidence.

## Test plan

- `test/unit/indicators.test.ts`: plain-record catalog/decoy/unavailable cases, eight prompts, schema bounds/long IDs, role labels, deterministic/deduplicated output, frozen input and module boundaries. Follow `test/unit/relationships.test.ts`; no native parser imports in units.
- `test/unit/lcov.test.ts`: independent record/path/count oracles and all malformed/unsupported cases in step 4; no coverage generation.
- `test/integration/readiness-metadata.test.ts`: safe artifact reading, filename-only walking, shared budgets, no unintended reads/execution and cleanup. Follow existing filesystem tests/helpers. If native catalog fixtures are used, invoke only the trusted parser supervisor through the build-first suite.
- `test/integration/safe-read.test.ts`: regression coverage for existing source/metadata semantics and dedicated LCOV reader/counters. Capability-detect unsupported permission/link/FIFO behavior and report skips honestly.

## Done criteria

- [ ] Targeted/full tests, typecheck/lint/format/build/schema gates exit 0; capability skips recorded.
- [ ] Every rule and readiness projection validates against current strict schemas; schemas/versions unchanged.
- [ ] Eight human prompts remain unassessed; heuristic decoys cannot establish protection/proxy/crypto semantics.
- [ ] Unavailable builtin/storage facts stay explicit; positive syntax is non-exhaustive where required.
- [ ] Valid LCOV above 256 KiB succeeds within effective dedicated budget; metadata cap stays 256 KiB, counters shared and monotonic.
- [ ] Presence, blocked/uninspected metadata and incomplete filename counts are distinct; no target execution/test-body/SF-target reads.
- [ ] Coverage totals only count matched supplied scoped records and always return unverified provenance/matching limitations.
- [ ] No vulnerability/pricing/numerical logic, public-entry/schema/config/dependency or outside-scope implementation edit; 009 status updated.

## STOP conditions

Stop if current contracts drift, a read needs weaker safety flags/outside-root access, a required representation cannot fit schema/internal projections, an out-of-scope change is needed, high-confidence classification depends only on names, unverified runtime/compiler semantics or target execution/downloads are required, or a gate fails twice after a reasonable fix. Unsupported arithmetic/cryptography/access-effect/proxy recognizers are already deferred and do not block the supported catalog. An invalid supplied artifact is a tested unavailable result, not a development STOP; cancellation/exhausted budgets still follow step 4.

## Maintenance notes

Version inference independently from parser/model changes and retain counterexamples. Extending LCOV tags/multi-run merging or claiming freshness needs a reviewed contract. 013 owns envelope/fingerprint/exit-status assembly and readiness warning/limitation consumption; 011/013 own numeric-independence integration once estimation exists. Darwin checks do not prove Linux/Windows behavior. Advanced protocol analysis remains post-MVP.
