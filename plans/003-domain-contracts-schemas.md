# Plan 003: Freeze plain domain contracts, diagnostics and versioned schemas

> **Executor instructions:** Implement this contract layer before its consumers. Each step has a gate. Stop on incompatible prerequisite evidence rather than patching consumers outside scope. Update status 003 in `plans/README.md`.
>
> **Drift check first:** No planned-at SHA exists: the directory was empty/non-Git on 2026-10-14. Verify 001 scripts and 002 parser capability report. If Git exists inspect `git status --short` and `git diff --stat -- src/domain src/index.ts schemas scripts/generate-schemas.mjs docs/adr/002-domain-contract.md package.json`. Existing unrelated schemas are a STOP condition; expected prerequisite files are not drift.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED (public compatibility and unknown handling)
- **Depends on:** `plans/001-bootstrap-tooling.md`, `plans/002-slang-compatibility-spike.md`
- **Category:** direction / architecture
- **Planned at:** no commit available; greenfield non-Git directory inspected 2026-10-14

## Why this matters

Independent executors need stable vocabulary and data contracts. Separating measured data, heuristics, human inputs and unavailable values prevents an unresolved binding from becoming a misleading zero or a security conclusion. Schema compatibility must be defined before JSON consumers exist.

## Current state and architectural context

No source existed during planning. Prerequisites should supply strict ESM tooling and a pinned/tested Slang API matrix. This plan adds domain code only; no filesystem/parser/terminal imports in the contract layer. Use Zod 4 as the strict serialization-compatible runtime schema/type source. Pure calculations later consume plain numeric/entity records; no Slang cursors escape the worker.

Proposed conventions: kebab-case files, named exports, `.ts` TypeScript imports with ESNext/bundler resolution, readonly records, unknown input validation. Unknown metrics use a tagged value, not omitted keys or `0`: `Measurement<T> = {status:"measured",value:T,evidence:EvidenceRef[]} | {status:"unavailable",reason:string}`. A zero with measured status means observed absence. Evidence ranges use project-relative POSIX path, zero-based half-open UTF-8 byte offsets and one-based line/column for presentation; schema names explicitly label units. New evidence semantics require metrics-version review.

Reference: [Zod JSON Schema conversion](https://zod.dev/json-schema). Run its output in strict-object mode, with no transforms or unsupported schema nodes.

## Commands you will need

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

All are **proposed**, established by prerequisite implementation, not verified at planning.

| Purpose | Command | Expected |
|---|---|---|
| Contract tests | `pnpm exec vitest run test/unit/domain.test.ts` | all validations pass/fail as specified |
| Check standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build` | 0 |
| Generate schemas | `pnpm schemas:generate` | stable schema files |
| Check schema drift | `pnpm schemas:check` | 0, no writes, generated equals committed |
| Full suite | `pnpm test:all` | 0 |

## Scope

**In scope:** `src/domain/{schemas,types,diagnostics,versions,canonical}.ts`, `src/index.ts` (type/version exports only), `test/unit/domain.test.ts`, `test/fixtures/domain/**`, `schemas/{config-v1,result-v1,model-v1}.schema.json`, `scripts/generate-schemas.mjs`, `package.json`, `pnpm-lock.yaml`, `docs/dependencies.md`, `docs/adr/002-domain-contract.md`, 003 status row.

**Out of scope:** executable CLI/config loading, traversal, parser, metrics implementation, numerical estimator, reports, schema download/network resolution, new architecture frameworks.

## Git workflow

No Git conventions were observed. Use the supplied checkout; do not commit/push/publish or create a branch without operator instruction.

## Steps

### Step 1: Define domain identities and measured syntax records

Add exact Zod 4 pin and document purpose/license. Define branded opaque `FileId`, `ContractId`, `CallableId`, `EdgeId`; identities derive from normalized relative path plus declaration kind/start byte offset, never short names alone. File identity uses canonical path/physical identity for dedup; byte hash is separate and is **not** a dedup key. Contracts with same names stay distinct. DTOs must use serializable arrays/objects/numbers/strings only.

Define `SourceSnapshot` (internal content/absolute path permitted, never public), `ScopeManifest`, `FileScopeEntry`, `SyntaxBatch`, `FileAnalysis`, `ContractAnalysis`, `CallableAnalysis`, `ImportReference`, `RelationshipResult`, `Indicator`, `EstimateInput`, `EstimateResult`, `Diagnostic`. Ownership is `first-party|third-party|unknown`; role `scoped|context|excluded`. Include declaration kinds contract/abstract contract/library/interface; named functions/constructors/fallback/receive/modifiers/free functions remain identifiable.

Core metric fields: `physicalLines`, `sourceLines`, declarations by kind, callable visibility/mutability explicit vs effective, body presence, decisions/loops/maxLoopDepth, assembly/Yul counts, low-level call syntax candidates, state variables/type shape, modifiers applied, import list. Source-line sets and syntax event records may stay internal to support unions; public counts include definitions/version/status. Define aggregate metrics as unions/counts over unique scoped files, not sums of overlapping contract lines.

**Verify:** `pnpm exec vitest run test/unit/domain.test.ts -t 'identity and measurement'` and `pnpm typecheck` → 0; same-name entities and unavailable-vs-zero cases pass.

### Step 2: Specify config/model input schemas and semantic provenance

Create `ConfigInput` with `configVersion:"1.0.0"`, `scope` (`sourceRoots`, `include`, `exclude`, `defaultExcludes`, `thirdPartyRoots`, `firstPartyOverrides`, `followSymlinks`), `imports.remappings`, `solidity.version`, `analysis.limits`, `model` (profile and optional parameter overrides), `manualAdjustments`, optional `coverage.lcovPath`, and `report.format`. CLI output destination/force/color are presentation options, not estimator weights. No prices/team schedule fields. Bound numbers/arrays/string lengths; forbid unknown keys/prototype merge behavior.

Freeze limit field names: `maxFileBytes`, `maxTotalSourceBytes`, `maxFiles`, `maxFsEntries`, `maxDirectoryDepth`, `maxImports`, `maxGraphEdges`, `maxAstNodesPerFile`, `maxAstNodesTotal`, `maxPatternsPerList`, `maxPatternLength`, `maxGlobStates`, `maxMetadataBytes`, `maxLcovBytes`, `parseTimeoutMs`, `maxSemanticFiles`, `maxSemanticBytes`, `semanticTimeoutMs`, `analysisTimeoutMs`. All are positive bounded integers; config itself always has a fixed 256-KiB cap checked before it is parsed. `ResolvedConfig` expands every default and contains logical root-relative path settings plus provenance; native/absolute root/config paths stay in internal load context. Model input field names are `profile`, `modelVersion`, `parameters`; parameters are `projectHours`, `slocHours`, `controlPremium`, `storagePremium`, `evmPremium`, `interactionHours`, `boundaryHours` (each `{low,high}`), `unknownReserveHigh` (number), `hoursPerDay` (number). Optional user `modelVersion` must match the selected known profile, and omission resolves to its current recorded version. `EstimateInput` includes eligible file records, scoped/context pair lists, required-analysis completeness, `hasUnknownSemantics` and `allowPartial`. File `sourceLines` is the model's `L`; `stateVariables.mutableCount` is `S`; distinct `complexMutableDeclarationIds` produce `M`, with measured/unavailable tags retained.

Define semantic config representation and per-field provenance `default|metadata|config|cli`. Array override means replacement, scalar override means last supplied layer; absent CLI values do not overwrite config. `Remapping={context?:string,prefix:string,target:string}`; relative targets confined to root. Manual record `{id,reason,category,lowHours,highHours}`; range may be negative but ordered, explicit discount allowed, nonempty reason required, unique IDs. Model 010 will populate the exact numerical profile; schema reserves fixed project allowance, SLOC rates, three group premium ranges, interaction/boundary rates, unknown-semantics reserve and hours/day. Every pair must be finite and ordered; reject unsupported model ID/version.

**Verify:** `pnpm exec vitest run test/unit/domain.test.ts -t 'config and model'` → 0, unknown keys, invalid pair ordering, duplicate manual IDs, nonfinite/oversized input rejected.

### Step 3: Define report/error envelopes and version policy

`ReportEnvelope` always includes `schemaVersion:"1.0.0"`, `toolVersion`, `command`, `status:"complete|partial|error"`, `versions:{parser,metrics,indicators,model}`, `fingerprints:{sources,semanticConfig,analysis}`, `scope`, `analysis` (nullable), `estimate` (nullable), `fullScopeEstimate` (nullable), `diagnostics`, `limitations`. Analysis has files/contracts/callables, aggregates, graphs, indicators, test/coverage observations and completeness summaries. Estimate has profile/uncalibrated label, auditor-hour/day ranges, contribution ledger, assumptions, manual adjustments, and `coverage:"full|analyzed-subset"`. Error envelopes use the same required keys with nulls/empty structures, a stable diagnostic code and failure category. No source text, absolute path, stack, timestamp or metrics fabricated on failure.

`Diagnostic={code,severity:"info|warning|error",phase,message,fileId?,range?,details?}` with bounded structured details. Define codes for CONFIG_INVALID, TARGET_UNREADABLE, EMPTY_SCOPE, PATH_BLOCKED, LIMIT_EXCEEDED, SOURCE_CHANGED, LANGUAGE_UNSUPPORTED, PARSE_INVALID, IMPORT_UNRESOLVED, SEMANTICS_UNAVAILABLE, OWNERSHIP_UNKNOWN, PARTIAL_ANALYSIS, OUTPUT_FAILED, INTERNAL_ERROR. Exit mapping belongs to CLI later, not diagnostics.

Publish independent semantic versions for report schema, metrics definitions, indicators and model. Schema minor allows additive fields/new diagnostic codes; consumers must ignore unknown optional fields/codes but reject unknown major versions. Changing required meanings/types/removing fields requires schema major. Producers validate their current exact schema; consumers should not use strict v1.0 producer schema to reject all v1.x extensions. Even npm 0.x does not silently alter JSON v1 semantics. Parser updates are included in fingerprints and can change outputs with reviewed metric-version decisions.

**Verify:** `pnpm exec vitest run test/unit/domain.test.ts -t 'envelopes and compatibility'` → 0; complete/partial/error fixtures validate, source/absolute-path accidental serialization rejected by contract tests, version-policy tests pass.

### Step 4: Generate schemas and canonical serialization utilities

Implement recursively sorted object keys and stable collection ordering under explicit IDs; do not globally sort arrays whose order is meaningful (manual ledger/model steps). Use code-point sorting, stable SHA-256 over framed length-prefixed content identities, no locale/time/performance. Generate committed draft-2020-12 JSON Schemas from domain schemas via built ESM using a trusted `.mjs` script. Scripts `schemas:generate` and `schemas:check` build first; check compares in memory without writes. Export schema files through package paths later; avoid absolute/network `$id` resolution at runtime.

**Verify:** `pnpm schemas:generate`, `pnpm schemas:check`, `pnpm exec vitest run test/unit/domain.test.ts`, `pnpm test:all`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck` → 0; two generations byte-identical.

## Test plan

Use bootstrap tests as structural style; add valid/invalid DTO fixtures and schema round-trip checks. Test null/unavailable/zero, Unicode/Windows path normalization at boundaries, duplicate IDs, NaN/Infinity, prototype-like keys, stable key ordering, array-order semantics, major-version refusal and additive consumer policy. Do not assert name/type wrappers alone without actual invalid-input behavior.

## Done criteria

- [ ] Contract suite, full regression, standards and schema drift gates exit 0.
- [ ] All specified DTOs, complete/partial/error fixtures and JSON Schemas exist.
- [ ] No domain import from CLI/filesystem/Slang and no import-time I/O; tests enforce boundaries.
- [ ] Stable unknown/ownership/evidence/version policies are documented.
- [ ] Changed paths remain scoped and 003 status updated.

## STOP conditions

Stop if 002 contradicts required range/API capability, an existing consumer requires incompatible schema changes, schema export requires unsupported transformations, public data needs Slang cursors/BigInt/absolute source paths, a gate fails twice, or numerical method choices would need guessing. Do not add fields for vulnerability severity or pricing to solve unrelated needs.

## Maintenance notes

Review all schema/metric/model version changes explicitly. Keep internal snapshots separate from public DTOs. Regenerate and check schemas whenever validation changes; add producer and forward-compatible consumer fixtures rather than relying on compiler types alone.
