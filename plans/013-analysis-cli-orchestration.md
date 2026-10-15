# Plan 013: Connect local analysis, estimation and CLI output end to end

> **Executor instructions:** Follow this plan step by step. Run every verification command and confirm its expected result before moving on. Wire the existing modules together. Do not invent substitute metrics or estimates, and do not widen any public schema. If anything under "STOP conditions" happens, stop and report instead of improvising. When done, update the 013 row in `plans/README.md`, unless a reviewer dispatched you and said they maintain the index. You are not authorized to execute target-project code, use the network at runtime, or download a compiler.
>
> **Drift check (run first):**
>
> ```sh
> git status --short
> git diff --stat 5077f1f..HEAD -- src test/integration/bootstrap-cli.test.ts test/helpers docs/adr/003-cli-config.md docs/output-schema.md tsdown.config.ts package.json
> ```
>
> Expected: no output from the second command, and `git status --short` shows nothing outside `plans/`. If an in-scope file changed, compare it with the "Current state" excerpts below. Treat any contract mismatch as a STOP. `src/application/`, `test/e2e/` and `test/helpers/run-cli.ts` must not exist yet; if any of them does, STOP.

## Status

- **Priority:** P1
- **Effort:** L (raised from M at the 2026-10-15 review: orchestration, source-to-engine conversion, envelope mapping, signal handling and safe file output are each substantial)
- **Risk:** HIGH (completeness, exit/stdout contracts and file writes are public behavior)
- **Depends on:** 004–009, 011, 012. **All are implemented on `main` at `5077f1f`.** 011 is `69101d5`; 012 is `5077f1f`.
- **Category:** direction / correctness
- **Planned at:** commit `5077f1f`, reviewed 2026-10-15. This supersedes the `d012fb9`, `2eb8d3d` and `d11bc60` baselines. Original greenfield planning: 2026-10-14.

## Why this matters

Every phase now exists separately: config, discovery, parser, metrics, relationships, indicators/readiness, the pure estimator (011) and the pure renderers (012). The shipped CLI still answers every command with "handler not available" and exit 1 (`src/bin.ts`). This plan connects those phases into `analyzeProject` and a working `estimate | inspect | explain`. It has two jobs. A phase failure must never disappear: an incomplete analysis must not be billed as a full estimate. And the public CLI contracts must hold: exit codes, a single JSON envelope on stdout, and no unsafe file writes.

## Current state (verified at `5077f1f`)

### Baseline gates

Node `24.21.0`, pnpm `11.28.4`. At review time `pnpm typecheck`, `pnpm lint` and `pnpm format:check` exit 0, and `pnpm test` passes 429 unit tests in 17 files. 012's execution review reported `test:all` = 429 unit + 215 integration/research tests and `schemas:check` exit 0. That run was not repeated at this review.

### Entry points you will change

`src/bin.ts` (whole file):

```ts
#!/usr/bin/env node
import { createUnavailableHandler, runCli } from './cli/commands.ts';

const io = { stdout: process.stdout, stderr: process.stderr };
const exitCode = await runCli(process.argv.slice(2), createUnavailableHandler(io), io);
process.exitCode = exitCode;
```

`src/cli/commands.ts:116-158`: `runCli(args, handler, io)` builds the Commander program. Today it catches only `ConfigError` (→ stderr text, exit 2) and `ProjectRootError` (→ exit 3) from the handler. Every other throw becomes `INTERNAL_ERROR`, exit 1. A Commander usage error returns 2 and writes **no** JSON envelope. `--format` is a Commander `.choices([...])` option (`commands.ts:35-41`), so an invalid format is rejected before the handler runs.

`src/cli/options.ts:7-29`: `CliRequest` has `command`, `input` (already `resolve(cwd, input)`, not realpath'd), optional `root`/`configPath`/`include`/`exclude`/`format`/`output`/`solidityVersion`, and booleans `noConfig`, `force`, `allowPartial`, `strict`, `noColor`, `breakdown` (`breakdown === (command === 'explain')`). `CliIo` is `{ stdout: {write(chunk: string): unknown}; stderr: {...}; cwd?: string }`. It has no signal and no TTY flag.

`src/cli/exit-codes.ts` already implements the exit policy. **Reuse it; do not write a second mapping.**

```ts
export const EXIT_CODES = { complete: 0, internal: 1, usageOrConfig: 2, target: 3, incomplete: 4, output: 5, interrupted: 130 } as const;
export interface ExitPolicyInput {
  readonly outcome: 'complete' | 'partial' | 'failure' | 'interrupted';
  readonly diagnostics: readonly Diagnostic[];
  readonly strict?: boolean | undefined;
  readonly allowPartial?: boolean | undefined;
}
// complete → 0, or 4 when strict and any warning; partial → 4; interrupted → 130;
// failure → INTERNAL_ERROR 1 > OUTPUT_FAILED 5 > CONFIG_INVALID 2 > TARGET_UNREADABLE|EMPTY_SCOPE|PATH_BLOCKED 3 > incomplete codes 4 > 1
export function exitCodeFor(input: ExitPolicyInput): number;
```

`src/index.ts` exports versions, domain types, `estimateEffort`, `EstimationError`, `selectModel`, `EstimationErrorReason`, `serializeJson`, `formatTerminal`, `TerminalFormatOptions` and `formatMarkdown`. It has no `analyzeProject` yet.

### Phase APIs (all exist; call them, do not reimplement)

| Phase | API | Location |
|---|---|---|
| Root selection | `selectProjectRoot(inputPath, rootOverride?, cwd?)` → **canonical (realpath'd)** root | `src/config/load.ts:289` |
| Config | `resolveConfig({root, configPath?, noConfig?, defaults, metadata?, cli?})` → `{config, semanticHash, root, configFileLoaded}` | `src/config/load.ts:338` |
| Budget | `createDiscoveryBudget(limits, signal?, deadlineAt?)`; `budget.assertLimitsMatch(limits)` | `src/discovery/budget.ts:261` |
| Metadata | `readProjectMetadata({pathContext, budget})` → includes `.hints`, `.valid`, `.diagnostics` | `src/discovery/metadata.ts:237` |
| Target | `resolveSafePath({...pathContext, budget}, absoluteTarget)` | `src/discovery/safe-path.ts:112` |
| Discovery | `discoverScope({root, lexicalRoot, target, lexicalTarget, config, metadata, budget, identities})` → `{manifest, snapshots, diagnostics, observations, complete}` | `src/discovery/discover.ts:187` |
| Parser | `createParserSession({budget, config})`; `session.analyzeSources(sources)`; `await session.close()` | `src/parser/adapter.ts:1942` |
| Relationships | `resolveRelationships(input: RelationshipInput)` → `RelationshipAnalysis` | `src/relationships/closure.ts:916-918` |
| Metrics | `buildFileMetrics(source, result)` per file; `aggregateMetrics(files)` | `src/metrics/structural.ts:533`, `src/metrics/aggregate.ts:45` |
| Indicators | `classifyIndicators(input: IndicatorInput)` (sync) | `src/indicators/classify.ts:53`, `:250` |
| Readiness | `collectReadiness(input: ReadinessInput)` (async) | `src/indicators/readiness.ts:61`, `:598` |
| Estimate | `estimateEffort(input: EstimateInput): EstimateResult \| null`, throws `EstimationError` | `src/estimation/estimate.ts:189` |
| Render | `serializeJson(env)`, `formatTerminal(env, {detail?, color?})`, `formatMarkdown(env)`; all validate the envelope and throw on invalid input | `src/reporting/*.ts` |

**Pipeline exemplar: copy this sequence.** `test/integration/imports.test.ts:62-110` already runs the ADR 004 order end to end:

```ts
const operational = await resolveConfig({ root, defaults });                       // config without metadata
const budget = createDiscoveryBudget(operational.config.analysis.limits, options.signal);
const rootContext = await safePathContext(root);                                   // TEST helper, see below
const metadata = await readProjectMetadata({ pathContext: rootContext, budget });
const resolved = await resolveConfig({ root, defaults, metadata: metadata.hints });
budget.assertLimitsMatch(resolved.config.analysis.limits);
const pathContext = await safePathContext(root, { target: targetAbsolute, followSymlinks: resolved.config.scope.followSymlinks });
const target = await resolveSafePath({ ...pathContext, budget }, targetAbsolute);
const identities = new IdentityRegistry();
const discovery = await discoverScope({ root: pathContext.root, lexicalRoot: pathContext.lexicalRoot, target, lexicalTarget: targetAbsolute, config: resolved.config, metadata, budget, identities });
session = createParserSession({ budget, config: resolved.config });
const sources = discovery.snapshots.map((snapshot) => { const fileId = fileIdentity(snapshot.canonicalPath); /* find manifestEntry by fileId */ return { fileId, snapshot, manifestEntry }; });
const initialSyntax = await session.analyzeSources(sources);
// then resolveRelationships({ discovery, pathContext, identities, budget, config: resolved.config, metadata, session, initialSyntax })
// finally { await session?.close(); }
```

`safePathContext` and `trustedDefaults` are **test helpers** (`test/helpers/filesystem.ts:31`, `test/helpers/parse-source.ts:21`). Production code must not import from `test/`. Build the `SafePathContext` inline the same way: `{ root: await realpath(root), lexicalRoot: root, target?: await realpath(t), lexicalTarget?: t, followSymlinks }`. The `SafePathContext` interface is at `src/discovery/safe-path.ts:30-42`.

### No production config defaults exist yet

`resolveConfig` requires `TrustedConfigDefaults` (`src/config/merge.ts:23-31`): `scope`, `imports.remappings`, `solidity.version`, `analysis.limits`, `model`, `manualAdjustments`, `coverage.lcovPath`. Only tests construct this today, with invented model numbers. Production defaults are a deliverable of this plan (Step 1).

`solidity.version`: when no CLI/config value is given, the provenance lookup in `src/parser/adapter.ts:1138-1142` resolves the authority to `'default'`. In that branch `src/parser/version-policy.ts:175-193` **ignores the value** and picks the highest compatible installed grammar. The default only needs to be a valid exact version. Use `'0.8.28'`, which the tests already use, and comment that it is an ignored placeholder under `'default'` authority. Version provenance already reaches the parser through `ResolvedConfig.provenance`, so no extra plumbing is needed.

### Domain contracts the envelope must satisfy

`ReportEnvelope` (`src/domain/types.ts:350-373`) has: `schemaVersion '1.0.0'`, `toolVersion`, `command`, `status: 'complete'|'partial'|'error'`, `failureCategory: 'config'|'target'|'analysis'|'output'|'internal'|null`, `versions {parser, metrics, indicators, model}` (all non-empty labels), `fingerprints {sources, semanticConfig, analysis}` (each a digest or null), `scope: ScopeManifest` (**required even for errors**), `analysis`, `estimate`, `fullScopeEstimate`, `diagnostics`, `limitations` (≤1000 strings).

Cross-field rules enforced by `ReportEnvelopeSchema` (`src/domain/schemas.ts:668-721`):

1. `error` ⇒ `failureCategory` is non-null and there is ≥1 diagnostic; `analysis`, `estimate` and `fullScopeEstimate` are all null.
2. Not `error` ⇒ `failureCategory` is null **and** `analysis` is non-null.
3. `partial` ⇒ `fullScopeEstimate` is null; any `estimate` has `coverage: 'analyzed-subset'`.
4. `complete` ⇒ `analysis.completeness.requiredAnalysisComplete === true`.
5. `fullScopeEstimate`, when present, has `coverage: 'full'`.

An error envelope with no discovered scope uses the empty manifest `{entries: [], scopedFileIds: [], contextFileIds: [], excludedFileIds: []}` (see `test/fixtures/reports/error.json`). `DiagnosticCode` (`src/domain/types.ts:150-164`) is a closed set: `CONFIG_INVALID, TARGET_UNREADABLE, EMPTY_SCOPE, PATH_BLOCKED, LIMIT_EXCEEDED, SOURCE_CHANGED, LANGUAGE_UNSUPPORTED, PARSE_INVALID, IMPORT_UNRESOLVED, SEMANTICS_UNAVAILABLE, OWNERSHIP_UNKNOWN, PARTIAL_ANALYSIS, OUTPUT_FAILED, INTERNAL_ERROR`. `phase` ∈ `config|discovery|parse|semantics|metrics|estimate|report`. `details` holds at most 32 scalar key/value items. **There is no interruption code and no new code is authorized.**

`EstimateInput` (`src/domain/types.ts:285-301`):

```ts
eligibleFiles: { fileId; sourceLines; stateVariables; decisions; assemblyBlocks; confirmedBuiltinLowLevelCalls }[]  // Measurement<…> each
scopedPairs: { leftId; rightId }[];  contextPairs: { leftId; rightId }[];
requiredAnalysisComplete: boolean;  hasUnknownSemantics: boolean;  allowPartial: boolean;
model: ModelProfile;  manualAdjustments: ManualAdjustment[];
```

`estimateEffort` returns null when (`src/estimation/eligibility.ts:23-33`) required analysis is incomplete without `allowPartial`, or there are no eligible files, or any `sourceLines` is unavailable, or every file has zero SLOC. It throws `EstimationError` (`src/estimation/model.ts:5-30`) with `reason` ∈ `invalid-input | inconsistent-measurements | invalid-total | output-bound | unsafe-arithmetic`.

`RelationshipAnalysis` (`src/relationships/types.ts:226-246`) returns the final `manifest`, closure-expanded `sources`/`syntax`, `imports`, `graphs`, `inheritance`, `directBaseEdges`, `callSites`, `scopedPairs`/`contextPairs` (`ContractPair {leftId: ContractId; rightId: ContractId; kinds; evidence}`), `confirmedBuiltinLowLevelCalls: {fileId; confirmedBuiltinLowLevelCalls: Measurement<number>}[]`, `invalidatedScopedFileIds`, `diagnostics`, `requiredAnalysisComplete`, `hasUnknownSemantics` and `fingerprint`. `FileMetrics` (`src/metrics/structural.ts:43-51`) is `{file: FileAnalysis; contracts: ContractAnalysis[]; callables; lineSet; wholeFile}`. `ContractAnalysis.fileId` (`src/domain/types.ts:110`) is the verified contract→file map.

### Frozen model/application oracles

- `test/fixtures/estimation/worked-cases.json`: 27 cases. Each has an `application` object with `reportStatus` and `fullScopeEstimateExpected`. All 20 `complete` cases expect a full-scope estimate; all 7 `partial` cases expect none.
- `docs/model/heuristic-v1.md:90-94,150,157` freezes the conversions this plan owns: eligibility filtering, pair deduplication/filtering, omissions, exit codes, envelopes, `fullScopeEstimate`, and readiness/indicator neutrality.
- **Caution:** 012's renderer golden `test/golden/json/simple.json` is a complete estimate with `fullScopeEstimate: null`. It is a renderer input fixture, not an application oracle. Follow the 010 fixtures: a complete estimate sets `estimate` and `fullScopeEstimate` to the same full result. Do not edit the 012 goldens.

### Build artifact boundary

`tsdown.config.ts` has three entries: `index`, `bin` and `parser/worker`. `deps.neverBundle: true`. `test/integration/bootstrap-cli.test.ts:21-45` asserts the **eleven**-entry `dist/` listing: `bin.js(.map)`, `canonical.js(.map)`, `index.d.ts`, `index.js(.map)`, `parser/`, `version.js(.map)`, and `parser/worker.js(.map)`. Once both `index` and `bin` import `src/application/`, tsdown will emit at least one new shared chunk. That inventory change is expected. Each new path needs a comment naming its production purpose, as the existing `canonical.js` comment does. The worker is located through `import.meta.resolve('audit-estimator')` (`src/parser/adapter.ts:1115-1119`), so chunking does not move it.

### Conventions

Strict ESM, `.ts` source imports, explicit named exports with explicit return/type annotations (`isolatedDeclarations`), `import type` for types, readonly DTOs, no `any`, no `@ts-*` or lint suppressions, and `catch (error: unknown)` narrowed before use. Kebab-case filenames, two-space indent, semicolons. Reusable code never calls `process.exit`; only `src/bin.ts` sets `process.exitCode` (ADR 003). Diagnostics use fixed sanitized messages with no native paths, source text or stack traces (ADR 004 line 40). For exemplars of fixed-message typed errors, see `src/config/defaults.ts:6-22` and `src/estimation/model.ts:21-30`.

## Decisions fixed by this review

Earlier drafts left these open. Do not reopen them. If one turns out impossible, STOP.

1. **Outcome → envelope → exit table.** `strict` means `request.strict`. Run every exit through `exitCodeFor`.

   | Situation | status | failureCategory | analysis | estimate | fullScopeEstimate | outcome passed to `exitCodeFor` → exit |
   |---|---|---|---|---|---|---|
   | estimate/explain, required complete, engine returns `coverage:'full'` | complete | null | yes | full | **same full result** | complete → 0 (4 if `--strict` and any warning) |
   | estimate/explain, required incomplete, `--allow-partial`, engine returns subset | partial | null | yes | analyzed-subset | null | partial → 4 |
   | estimate/explain, required incomplete, no `--allow-partial` (engine returns null) | partial | null | yes | null | null | partial → 4 |
   | estimate/explain, required complete but engine returns null (e.g. unavailable `sourceLines`) | partial | null | yes | null | null | partial → 4; add `PARTIAL_ANALYSIS` warning, phase `estimate` |
   | inspect, required complete | complete | null | yes | null | null | complete → 0 (strict rule applies) |
   | inspect, required incomplete | partial | null | yes | null | null | partial → 4 |
   | `EstimationError` `invalid-total` (reasoned discounts exceed totals) | error | config | null | null | null | failure + `CONFIG_INVALID` (phase `estimate`) → 2 |
   | `EstimationError` `output-bound` / `unsafe-arithmetic` | partial | null | yes | null | null | partial + `LIMIT_EXCEEDED` error (phase `estimate`) → 4 |
   | `EstimationError` `invalid-input` / `inconsistent-measurements` | error | internal | null | null | null | failure + `INTERNAL_ERROR` → 1 |
   | `ConfigError` / CLI option error / bad config file | error | config | null | null | null | failure + `CONFIG_INVALID` → 2 |
   | `ProjectRootError`, unreadable/blocked target | error | target | null | null | null | failure + `TARGET_UNREADABLE`/`PATH_BLOCKED` → 3 |
   | no scoped Solidity, or scope is all comments (aggregate `sourceLines` = 0) | error | target | null | null | null | failure + `EMPTY_SCOPE` → 3 |
   | `BudgetError` limit (not cancellation) before analysis exists | error | analysis | null | null | null | failure + `LIMIT_EXCEEDED` → 4 |
   | report write failure | error | output | null | null | null | failure + `OUTPUT_FAILED` (phase `report`) → 5 |
   | SIGINT / abort | error | analysis | null | null | null | **interrupted** → 130; one `PARTIAL_ANALYSIS` error diagnostic, message `Analysis was interrupted.` |
   | any other throw | error | internal | null | null | null | failure + `INTERNAL_ERROR` → 1 |

   For `invalid-total`, verify first that the config validator cannot already reject the case. If it can, the engine error is unreachable from config and should map as `invalid-input`. In that case record the finding and keep the table row.

2. **Format precedence:** CLI `--format` > config `report.format` (`src/domain/schemas.ts:488`) > `terminal`. For failures before config resolves, only the CLI value counts. To honor `--format json` on a Commander usage error, pre-scan `argv` before parsing. Accept exactly `--format json` or `--format=json`; if the flag appears more than once, the last occurrence wins, matching Commander. An invalid value such as `--format yaml` stays a terminal-mode usage error.
3. **Color:** `color = format === 'terminal' && output === undefined && !noColor && io.stdout.isTTY === true`. Add `readonly isTTY?: boolean | undefined` to the stdout member of `CliIo`. Ignore environment variables: the README decision forbids implicit env options.
4. **Explain:** run the same analysis as `estimate`. In terminal format render with `formatTerminal(env, {detail: true, color})`. In JSON/Markdown the output is the same envelope with `command: 'explain'`.
5. **Signals:** `bin.ts` owns one `AbortController`. On the first `SIGINT` it calls `abort()`; on a second `SIGINT` it lets Node's default handler terminate. Pass the signal as `CliIo.signal?: AbortSignal`. The parser session must be closed in `finally` on every path.
6. **Fixture registry:** do **not** add e2e fixtures to `test/fixtures/manifest.json`. Its `fixtures` entries are hand-counted Slang oracles that `test/research/slang-spike.test.ts:593` asserts byte for byte.

## Commands you will need

An executor in a fresh worktree runs `pnpm install --frozen-lockfile` first; it must exit 0. After that, prefix scripts with `pnpm --config.verifyDepsBeforeRun=false run`. That flag skips pnpm's implicit dependency reconciliation; it does not repair a missing install. `test:integration` builds with tsdown, then runs the integration Vitest project (`test/integration`, `test/e2e`, `test/research`) and forwards extra args to Vitest (`scripts/test.mjs`). Never run artifact suites against a stale `dist/`.

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Format check | `pnpm format:check` | exit 0 |
| Unit (no build) | `pnpm --config.verifyDepsBeforeRun=false run test test/unit/application-estimate-input.test.ts` | all pass |
| Application integration | `pnpm --config.verifyDepsBeforeRun=false run test:integration test/integration/application.test.ts` | all pass |
| Built CLI | `pnpm --config.verifyDepsBeforeRun=false run test:integration test/e2e/cli.test.ts` | all pass |
| Bootstrap artifacts | `pnpm --config.verifyDepsBeforeRun=false run test:integration test/integration/bootstrap-cli.test.ts` | all pass |
| Full | `pnpm --config.verifyDepsBeforeRun=false run test:all` | exit 0 |
| Schemas | `pnpm --config.verifyDepsBeforeRun=false run schemas:check` | exit 0; `schemas/` unchanged |
| Manual JSON (after a build) | `node dist/bin.js estimate test/fixtures/e2e/simple --format json --no-config; echo $?` | exactly one JSON document, then `0` |
| Manual explain | `node dist/bin.js explain test/fixtures/e2e/simple --no-color --no-config; echo $?` | scope/model/ledger text, then `0` |

## Scope

**In scope (create or modify only these):**

- `src/application/defaults.ts` (create): production `TrustedConfigDefaults`
- `src/application/analyze.ts` (create): `analyzeProject` orchestration
- `src/application/estimate-input.ts` (create): pure source-to-`EstimateInput` conversion and pair filtering
- `src/application/envelope.ts` (create): outcome → `ReportEnvelope` mapping, including error envelopes
- `src/application/fingerprints.ts` (create): sources/analysis fingerprints
- `src/cli/run.ts` (create): the real `CliHandler` (render, stdout/stderr, exit)
- `src/cli/output.ts` (create): safe report-file writing
- `src/cli/commands.ts`: JSON-mode usage/handler-error envelopes and pre-scan; keep `createProgram`/`runCli` signatures backward compatible
- `src/cli/options.ts`: `CliIo` gains `signal?` and `stdout.isTTY?` only
- `src/bin.ts`
- `src/index.ts`: add `analyzeProject` and its exported option/result types only
- `test/unit/application-estimate-input.test.ts` (create)
- `test/integration/application.test.ts` (create)
- `test/e2e/cli.test.ts` (create)
- `test/helpers/run-cli.ts` (create)
- `test/fixtures/e2e/**` (create)
- `test/integration/bootstrap-cli.test.ts`: the exact inventory update and `analyzeProject` declaration/import smoke only
- `docs/adr/003-cli-config.md`: replace the "Until the analysis handler is connected…" sentence (line 7); add one paragraph on output-file safety and its race limitation
- `plans/README.md`: the 013 status row only

**Out of scope (do not touch):**

- `src/domain/**`, `schemas/**`: no schema, enum or DTO change. If one seems necessary, STOP.
- `src/estimation/**`, `src/reporting/**`, `src/metrics/**`, `src/relationships/**`, `src/indicators/**`, `src/parser/**`, `src/discovery/**`, `src/config/**`. Call them; do not alter them. If a needed export is missing, STOP.
- `src/cli/exit-codes.ts`: reuse as is.
- `test/golden/**`, `test/fixtures/reports/**`, `test/fixtures/estimation/**`, `test/fixtures/manifest.json`
- `tsdown.config.ts`, `package.json`, the lockfile and `.oxfmtrc.json`: no new entries, scripts or dependencies.
- Telemetry, progress UI, caching, network access, project-command execution and implicit file writes.

## Git workflow

Work in the checkout or worktree you were given. Do not commit, push, change branches or publish unless the operator instructs it. If asked to commit, use conventional commits that match `git log`, for example `feat: connect analysis pipeline to CLI commands`.

## Steps

### Step 1: Production defaults and `analyzeProject` orchestration

Create `src/application/defaults.ts`:

```ts
export function productionConfigDefaults(): TrustedConfigDefaults; // fresh object each call
// scope: {...DEFAULT_SCOPE_SETTINGS}, imports: {remappings: []}, solidity: {version: '0.8.28'} (placeholder ignored under 'default' authority),
// analysis: {limits: {...DEFAULT_ANALYSIS_LIMITS}}, model: selectModel(), manualAdjustments: [], coverage: {lcovPath: null}
```

Create `src/application/analyze.ts` exporting:

```ts
export interface AnalyzeRequest {
  readonly command: 'estimate' | 'inspect' | 'explain';
  readonly input: string;            // absolute, lexical (not realpath'd)
  readonly root?: string | undefined; readonly configPath?: string | undefined; readonly noConfig: boolean;
  readonly include?: readonly string[] | undefined; readonly exclude?: readonly string[] | undefined;
  readonly solidityVersion?: string | undefined; readonly format?: 'terminal' | 'json' | 'markdown' | undefined;
  readonly allowPartial: boolean;
}
export interface AnalyzeOptions { readonly signal?: AbortSignal | undefined; readonly cwd?: string | undefined }
export interface AnalyzeOutcome {
  readonly envelope: ReportEnvelope;
  readonly outcome: 'complete' | 'partial' | 'failure' | 'interrupted';
  readonly reportFormat: 'terminal' | 'json' | 'markdown'; // effective, per Decision 2
  readonly protectedPaths: readonly string[];              // canonical paths of every read source/config/metadata/LCOV file, for Step 5
}
export async function analyzeProject(request: AnalyzeRequest, options?: AnalyzeOptions): Promise<AnalyzeOutcome>;
```

`analyzeProject` **never throws** for expected conditions. It returns an error envelope as defined in Decision 1. It must not import `commander`, `src/cli/**` or `src/reporting/**`, and it must not write to any stream. Sequence:

1. Lexical root: `request.root`, else `request.input` if that is a directory, else `dirname(request.input)`. Capture it **before** calling `selectProjectRoot`, which returns the canonical path.
2. Follow the exemplar order above exactly: config without metadata → one budget from those limits, created with `options.signal` and with `deadlineAt` derived from `analysisTimeoutMs` → metadata → final config with hints → `budget.assertLimitsMatch` → target `SafePathContext` → `discoverScope` → `createParserSession` → `analyzeSources` → `resolveRelationships`. Pass CLI include/exclude/solidityVersion/format as `cli` overrides. Never construct a second budget and never reset counters.
3. Metrics: for each scoped entry in the **final** `relationships.manifest`, join `relationships.sources` and `relationships.syntax` results by `fileId`, then call `buildFileMetrics`. Pass the scoped `FileMetrics` to `aggregateMetrics`. Failed syntax yields unavailable aggregates; never zero.
4. `classifyIndicators({manifest, syntax, metrics, relationships})`. Its `complete` flag means output truncation only. Never AND it into required completeness.
5. `collectReadiness({pathContext, budget, metadataPaths, coverage: config.coverage, manifest, physicalLines, aliases})`. Take physical lines from the matching `FileMetrics` and pass only safely observed identity aliases. Optional failures (missing, blocked or malformed LCOV; test-dir inspection failures) become diagnostics/limitations and leave completeness unchanged. Cancellation or deadline `BudgetError` propagates as interruption or limit.
6. Completeness: `requiredAnalysisComplete = discovery.complete && relationships.requiredAnalysisComplete && every scoped file parsed && invalidatedScopedFileIds is empty`. Take `hasUnknownSemantics` from relationships. Internal virtual-call uncertainty alone does not set it (008 policy). `analysis.completeness.analyzedFileIds` lists the eligible scoped files; `unavailableFileIds` lists every scoped or required-context file that failed, was invalidated or could not be read. An invalid scoped file contributes physical lines only and never AST metrics or effort.
7. `inspect` stops here. It never builds `EstimateInput` and never calls `estimateEffort`.
8. `estimate`/`explain`: call `buildEstimateInput` (Step 2), then `estimateEffort`, then map the result through Decision 1.
9. Always `await session.close()` in `finally`, including on abort and on error.

**Verify:** `pnpm typecheck` → exit 0, then `pnpm --config.verifyDepsBeforeRun=false run test:integration test/integration/application.test.ts -t 'phases and completeness'` → all pass. That `describe` block must contain at least these cases: complete simple project; malformed scoped file (status partial, file in `unavailableFileIds`, no AST metrics billed); missing required context import with complete scoped syntax (partial); `--allow-partial` subset (estimate `analyzed-subset`, `fullScopeEstimate` null); complete input with `allowPartial: true` (still `full`); inspect returns `estimate: null` and the engine is never called (assert with `vi.spyOn` on the module namespace, or assert the absence of `estimate.contributions`); all-comment scope → `EMPTY_SCOPE`; a raised `maxFiles` in config is honored, not capped by the defaults; ownership invalidation keeps the file in omissions. Validate every envelope with `ReportEnvelopeSchema.parse`.

### Step 2: Pure source-to-`EstimateInput` conversion

Create `src/application/estimate-input.ts`:

```ts
export interface EstimateInputSource {
  readonly manifest: ScopeManifest;                     // final manifest from relationships
  readonly metrics: readonly FileMetrics[];             // scoped files only
  readonly parsedFileIds: ReadonlySet<FileId>;          // scoped files whose syntax succeeded
  readonly relationships: Pick<RelationshipAnalysis, 'scopedPairs' | 'contextPairs' | 'confirmedBuiltinLowLevelCalls' | 'invalidatedScopedFileIds' | 'requiredAnalysisComplete' | 'hasUnknownSemantics'>;
  readonly requiredAnalysisComplete: boolean;           // from Step 1.6
  readonly config: ResolvedConfig;                      // effective model + manualAdjustments
  readonly allowPartial: boolean;
}
export function buildEstimateInput(source: EstimateInputSource): EstimateInput;
```

Rules:

- **Eligible files:** scoped role, `first-party` ownership in the final manifest, in `parsedFileIds`, and not in `invalidatedScopedFileIds`. Sort by `fileId` code point.
- **Builtins:** join `confirmedBuiltinLowLevelCalls` by `fileId`. If no row exists, the value is `{status: 'unavailable'}`, **never** `0`.
- **Storage:** if any mutable entry in `stateVariables.typeShapes` has shape `user-defined` or `unknown`, set `complexMutableDeclarationIds` to unavailable **in the estimator copy only**. The `FileMetrics`/`Analysis` objects stay unchanged; assert that with `structuredClone` + `toEqual`. Mapping/array-only storage remains measured.
- **Pairs:** build `contractFile: Map<ContractId, FileId>` from `FileMetrics.contracts[].fileId`. Keep a `scopedPairs` entry only if both endpoints map to eligible files. Keep a `contextPairs` entry only if its scoped endpoint maps to an eligible file. An endpoint absent from the map is a context contract. Never parse ID text to find files. Deduplicate directed `(leftId, rightId)` within each partition and across the two partitions; on a cross-partition duplicate, keep the scoped one. A→B and B→A are distinct. Do not invent self or unused-import pairs.
- `model` = `config.model`, `manualAdjustments` = `config.manualAdjustments`, and `hasUnknownSemantics` comes from relationships unchanged.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test test/unit/application-estimate-input.test.ts` → all pass. Required cases: failed-syntax file excluded; invalidated file excluded; third-party scoped file excluded; missing builtin row gives unavailable; a user-defined mutable type gives unavailable storage while the original metrics are unchanged; scoped pair with an ineligible endpoint dropped; cross-partition duplicate collapsed; reversed pair kept; output passes `EstimateInputSchema.parse`. Readiness neutrality: two inputs built from identical measured facts with different readiness/indicator results are `toEqual`, and give the same `estimateEffort` output.

### Step 3: Envelope, fingerprints and library export

Create `src/application/envelope.ts`. It holds the only code that builds `ReportEnvelope` objects, for both success and every row of Decision 1. Use `TOOL_VERSION`, `METRICS_VERSION`, `INDICATORS_VERSION` and `MODEL_VERSION`. For `versions.parser`, use the `parserVersion` string from the parsed files' version records (`src/parser/protocol.ts:72`; all files in one run share it). Before any file is parsed (config/target errors), use the label format 012's fixtures use (`slang@1.3.9`, `test/fixtures/reports/error.json:8`), derived from the same source the worker uses rather than hard-coded. If no such source is importable from the parent without loading Slang, STOP. `semanticConfig` = `resolveConfig(...).semanticHash`; it is null before config resolves. Put the effective model parameters in `estimate.parameters` (the engine does this). Bounded human-readable provenance and scope observations go into `limitations` (each ≤ smallText) or diagnostic `details` (≤32 scalar pairs). Never put native absolute paths, the config path or cwd in either.

Create `src/application/fingerprints.ts`:

- `sources`: the 008 `relationships.fingerprint` composed with sorted scoped/context `fileId`s, their byte hashes, roles/ownership and the selected grammar versions. Never hash only the initial scoped bytes.
- `analysis`: canonical JSON of the public `analysis` object plus component versions. Exclude wall time, absolute root, cwd and PIDs.
- Use the existing helpers `fingerprint(parts: readonly (string | Uint8Array)[])` (`src/domain/canonical.ts:103`) and `canonicalJson(value)` (`:77`), e.g. `fingerprint(['sources', canonicalJson(parts)])`. Do not add a new hashing scheme.

Add to `src/index.ts`: `export { analyzeProject } from './application/analyze.ts';` and `export type { AnalyzeRequest, AnalyzeOptions, AnalyzeOutcome } from './application/analyze.ts';`. The entry must stay side-effect free.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test:integration test/integration/application.test.ts -t 'determinism and api'` → all pass, then `pnpm typecheck` → exit 0. Required cases: two runs give byte-identical `serializeJson` output; the same project copied to a different temp directory gives identical output; files created in a different order give identical output; `format: 'json'` vs `'markdown'` gives the same `fingerprints.semanticConfig` and `analysis`; changing `coverage.lcovPath` changes `semanticConfig` (accepted contract, `src/config/merge.ts:466`) but not the estimate; the serialized output contains no occurrence of the temp root path; every error-row envelope validates.

### Step 4: CLI handler, streams, exits and signals

1. Create `src/cli/run.ts` with `createAnalysisHandler(io: CliIo): CliHandler`. It maps `CliRequest` → `AnalyzeRequest`, calls `analyzeProject(req, {signal: io.signal, cwd: io.cwd})`, renders by `reportFormat` (Decisions 3–4), writes the output (Step 5 when `--output` is set), and returns `exitCodeFor({outcome, diagnostics: envelope.diagnostics, strict, allowPartial})`.
2. stdout contract: in JSON mode stdout receives exactly `serializeJson(envelope)`, which already ends in one LF. Nothing else goes to stdout: no ANSI, no progress. Human-readable diagnostics go to stderr as one sanitized line each, `CODE: message`. In terminal/Markdown mode the rendered report goes to stdout and diagnostics still go to stderr.
3. `src/cli/commands.ts`: when the pre-scan (Decision 2) says JSON, Commander usage errors and handler-level `ConfigError`/`ProjectRootError`/unknown throws must still print exactly one error envelope (`command` = the parsed subcommand, else `estimate`) on stdout and return the same exit code as today. Help and version output are unchanged.
4. `src/bin.ts`: create an `AbortController` and install `process.on('SIGINT', …)` per Decision 5. Pass `{stdout: process.stdout, stderr: process.stderr, signal}`; `process.stdout.isTTY` is visible structurally. Then `process.exitCode = await runCli(argv, createAnalysisHandler(io), io)`. Keep `createUnavailableHandler` exported, since existing tests may use it, but stop using it in `bin.ts`.
5. Broken pipe: attach `stdout.on('error')`. When the code is `EPIPE`, stop writing and keep the computed exit code. No stack trace may reach stderr.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test:integration test/e2e/cli.test.ts -t 'commands and streams'` → all pass. Cases, each asserting stdout, stderr and exit code separately: terminal estimate (0); `--format json` estimate (stdout parses as one JSON document, `ReportEnvelopeSchema` valid, stderr has no envelope); Markdown; inspect (estimate null, 0); explain (terminal contains the ledger, and JSON `estimate` deep-equals estimate's); `--help` and `--version` (0); `--format json --bogus` (one error envelope, 2); invalid config file in JSON mode (`failureCategory 'config'`, 2); nonexistent path (3); directory with no `.sol` (3); malformed scoped file (4); malformed + `--allow-partial` (4, subset estimate); `--strict` with a warning-producing fixture (4); SIGINT via the trusted stalled-worker test hook (130, one error envelope in JSON mode, no orphan child; see Test plan); closing stdout early (`head -c 1` equivalent via a child stream that is destroyed) gives no stack trace on stderr.

### Step 5: Safe operator-requested report files

Create `src/cli/output.ts` with `writeReport(path, body, {force, protectedPaths}): Promise<void>`, throwing a typed `OutputError` with a fixed message. Rules:

1. Render and validate the full body **before** opening anything.
2. `path` is already absolute (`normalizeCliRequest`). Do not create parent directories. A missing parent is an `OutputError`.
3. Refuse: any destination ending in `.sol` (case-insensitive); any destination whose `realpath(parent) + basename` equals one of `protectedPaths` (sources, config, metadata, LCOV); an existing symlink (`lstat`); an existing non-regular file; an existing file whose `(dev, ino)` matches a protected path, which catches hardlinks.
4. Without `--force`: `open(path, 'wx')` (O_CREAT|O_EXCL). On `EEXIST`, throw `OutputError`. Never do a check-then-write.
5. With `--force`: open with `O_WRONLY | O_NOFOLLOW` where `fs.constants.O_NOFOLLOW` exists, without `O_TRUNC`. `fstat` the handle and require a regular file whose `(dev, ino)` is not protected. Only then `ftruncate(0)` and write.
6. On a write failure after the exclusive create, `fstat` the handle, `lstat` the path, and unlink only if `(dev, ino)` still match the file **this process created**. Never unlink a pre-existing file.
7. On success stdout is empty and stderr may say `Report written.`, without the path. On `OutputError`: in JSON mode, emit the `output` error envelope (Decision 1) to **stdout**; in other formats write one stderr line. Exit 5.
8. Document in ADR 003 that a concurrent attacker able to mutate the destination directory between `fstat` and write is outside the guarantee, consistent with ADR 004's race statement. Do not claim that rename-based writes give atomic no-clobber on every platform.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test:integration test/e2e/cli.test.ts -t 'output safety and cancellation'` → all pass. Cases: new file (0, contents equal stdout-mode bytes); existing file without `--force` (5, original bytes unchanged); `--force` over a regular report (0); destination symlink, with and without `--force` (5, link target unchanged); `.sol` destination (5); destination = a scoped source path (5, source unchanged); hardlink to a scoped source with `--force` (5, source unchanged); missing parent (5, directory not created); unwritable directory (5; skip on platforms where chmod has no effect, and record the skip); an injected write failure removes only the newly created file. Then run the Full, Schemas and Bootstrap rows of the command table and both manual commands.

## Test plan

- **Unit** (`test/unit/application-estimate-input.test.ts`, pattern `test/unit/estimation.test.ts`): Step 2 cases. Build `FileMetrics` inputs by hand or from `test/fixtures/estimation/worked-cases.json` application descriptions. For at least the 20 complete and 7 partial worked cases, assert that the produced envelope status and `fullScopeEstimate` presence match `application.reportStatus` / `fullScopeEstimateExpected` through the Step 3 envelope builder.
- **Integration** (`test/integration/application.test.ts`, pattern `test/integration/imports.test.ts` with `createProject`/`writeProjectFile`/`removeProject` from `test/helpers/filesystem.ts`): Steps 1 and 3. Use temp projects and import source modules. `describe` blocks must be named exactly `phases and completeness` and `determinism and api`, so the `-t` filters match.
- **E2E** (`test/e2e/cli.test.ts`): spawn the built `dist/bin.js` with `spawn(process.execPath, [...], {shell: false, cwd, env: {PATH: process.env.PATH ?? ''}, timeout})`. Model the runner on `runNode` in `test/integration/bootstrap-cli.test.ts:11-18`, extracted to `test/helpers/run-cli.ts` with async spawn for signals and stream control. `describe` blocks: `commands and streams`, `output safety and cancellation`. Never use shell redirection.
- **Cancellation** must use a trusted deterministic hook, not pathological Solidity or timing. First check whether the parser adapter already exposes a test-only stalled-worker path; `test/helpers/parser-child.ts` and `createParserSessionForTests` (`src/parser/adapter.ts:1947`) exist. If interrupting the **built CLI** needs a production-side hook that does not exist, test SIGINT at the `analyzeProject` level with an `AbortSignal` and a test session, assert `session.close()` and no orphan child, and record the e2e SIGINT case as deferred to 014. Do not add an env-var hook to production code.
- **Fixtures** (`test/fixtures/e2e/`, all original MIT content, `pragma solidity ^0.8.20;`): `simple/` (one valid contract), `malformed/` (one valid and one syntax-invalid scoped file), `missing-context/` (scoped file importing a non-existent `lib/` file), `excluded-base/` (scoped contract inheriting a default-excluded first-party base), `duplicate/` (two byte-identical files at different paths), `custom-roots/` (with `audit-estimator.config.json` setting `scope.sourceRoots`), `coverage/` (with an `lcov.info` and config `coverage.lcovPath`), `empty/` (comments-only `.sol`). Include a `package.json` with a `postinstall` writing a marker file, and assert the marker never appears. Note that `**/test/**` default exclusion is evaluated root-relative; fixture roots are the fixture directories themselves.
- **Bootstrap:** update `expectedEntries` to the exact new listing with a purpose comment per new chunk; add `analyzeProject` to the declaration assertions; add every new runtime `.js` to the "no `.ts` or `src/` import specifiers" file list.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm format:check` exit 0.
- [ ] `pnpm --config.verifyDepsBeforeRun=false run test:all` exits 0, including the new unit, application, e2e and bootstrap tests.
- [ ] `pnpm --config.verifyDepsBeforeRun=false run schemas:check` exits 0 and `git status --short schemas/` is empty.
- [ ] `node dist/bin.js estimate test/fixtures/e2e/simple --format json --no-config` prints one document that `ReportEnvelopeSchema` accepts, with `status: "complete"` and `fullScopeEstimate` deep-equal to `estimate`; exit 0.
- [ ] `grep -rn "createUnavailableHandler" src/bin.ts` returns nothing.
- [ ] `grep -rnE "from '\.\./(cli|reporting)/" src/application` returns nothing.
- [ ] `grep -rn "from '../../test\|from '../test" src` returns nothing.
- [ ] `git status --short` lists only in-scope paths; `git diff --stat -- src/domain src/estimation src/reporting src/config src/discovery src/parser src/metrics src/relationships src/indicators src/cli/exit-codes.ts schemas test/golden test/fixtures/manifest.json package.json tsdown.config.ts` is empty.
- [ ] The 013 row in `plans/README.md` is updated.

## STOP conditions

Stop and report; do not improvise, if:

- The drift check shows in-scope or contract files changed since `5077f1f`, or any excerpt above does not match the code.
- A required outcome cannot be expressed under the envelope rules or the closed `DiagnosticCode` set without a schema change.
- `EstimationError` reasons cannot be told apart for the Decision 1 mapping, or a needed phase export is missing.
- Any scoped-file failure would be dropped from `unavailableFileIds`, or a full-scope estimate would need a fabricated or zeroed measurement.
- Canonical output contains a machine path, timestamp or PID after the Step 3 fixes.
- tsdown emits an artifact you cannot attribute to a production import, or a build/dependency config change seems necessary.
- Interrupting the built CLI would require a new production test hook (use the fallback in the Test plan instead).
- The output writer would need to unlink or truncate a file it cannot prove it created or verified.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- `src/application/analyze.ts` is the integration boundary. A new phase must share the one budget, close resources in `finally`, and feed `requiredAnalysisComplete`. Optional observations must never feed it.
- Exit codes, the stdout single-envelope rule and the Decision 1 table are public CLI contracts. Changing them needs an ADR 003 update.
- Reviewers should scrutinize: pair filtering (no ID-text parsing), builtin/storage unavailability (never zero), `fullScopeEstimate` population, `close()` on every path, and the force/cleanup identity checks in `output.ts`.
- Deferred: e2e SIGINT on the built CLI if no trusted hook exists (→ 014); Linux/Windows output-safety behavior (→ 014); public usage docs (→ 016).

## Review history

- **2026-10-15, review at `5077f1f`:** Rebaselined after 011/012 landed on `main`, and inlined the excerpts and contracts. Added production defaults (none existed), reuse of `exitCodeFor`, envelope invariants, the outcome/exit table, format/color/explain/signal decisions, and the `fullScopeEstimate` rule versus the 012 golden. Moved pure conversion into a unit-tested module, named the `describe` blocks to match the `-t` filters, and dropped the `manifest.json` registration. Added ADR 003 to scope for the output-safety documentation that earlier drafts required without a file. Effort raised to L.
- Earlier reconciliations at `d012fb9`, `2eb8d3d` and `d11bc60` are superseded. Their substantive constraints are carried into the steps above: ADR 004 budget order, 009 readiness/indicator separation, 010 unavailable-not-zero rules, and 011 error mapping.
