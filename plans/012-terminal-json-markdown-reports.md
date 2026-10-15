# Plan 012: Render complete, stable terminal, JSON and Markdown reports

> **Executor instructions:** Implement pure report rendering only; file writes/command wiring belong to 013. Verify each gate and update status 012 in `plans/README.md`. Do not hide uncertainty or present effort as a quotation.
>
> **Drift check first:** Reviewed at `69101d5` on 2026-10-15; implementations 001–011 are present in this checkout; 012–016 remain TODO. Check commit presence in the execution checkout rather than relying on historical merge notes. Preserve pre-existing plan edits. Run `git status --short`, `git diff --stat 69101d5..HEAD -- src/reporting src/index.ts src/domain src/estimation test/unit/reporting.test.ts test/integration/bootstrap-cli.test.ts test/golden test/fixtures/reports test/fixtures/estimation docs/model docs/output-schema.md plans/012-terminal-json-markdown-reports.md plans/README.md`, and `git diff HEAD -- src/reporting src/index.ts src/domain src/estimation test/unit/reporting.test.ts test/integration/bootstrap-cli.test.ts test/golden test/fixtures/reports test/fixtures/estimation docs/model docs/output-schema.md plans/012-terminal-json-markdown-reports.md plans/README.md` (plus inspect untracked in-scope files). Check prerequisite statuses and the current-state snapshot below. Expected completed-prerequisite additions require inspection; contradictory contracts or unrelated local edits require reconciliation before implementation.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED (automation compatibility and misunderstood output)
- **Depends on:** `plans/003-domain-contracts-schemas.md`, `plans/007-source-structural-metrics.md`, `plans/008-imports-inheritance-interactions.md`, `plans/009-effort-indicators.md`, `plans/011-estimation-engine.md`
- **Category:** direction / dx
- **Planned at:** commit `69101d5`, reviewed 2026-10-15 after 011 implementation became available in this checkout; supersedes the `d012fb9`, `2eb8d3d` and `d11bc60` handoffs. Originally greenfield planning on 2026-10-14.

## Why this matters

Users must be able to review the exact scope, measured evidence and contribution of assumptions. Stable JSON enables automation; terminal and Markdown make the same result understandable without recomputing or changing the model.

## Current state and architectural context

### Reviewed implementation baseline — 2026-10-15 at `69101d5`

`src/reporting/` is absent. Strict `ReportEnvelope` and generated schemas already exist; examples are `test/fixtures/domain/{complete,partial,error,populated}.json`. Use them as structural exemplars without treating their arbitrary numeric values as model oracles. `src/domain/canonical.ts` already provides compact canonical JSON and preserves array order; add pretty rendering and explicit semantic collection ordering in the renderer without changing domain canonicalization.

The existing public ledger uses `contributions` with `explanation`, not structured formula/evidence fields or a precise-total property. Show integer contribution values, explanations and `estimate.parameters`; compute display-only exact sums from rows if needed, never rerun the estimator. `ScopeManifest` has only complete entries/role lists; selection/pruned/unread observations must arrive through existing diagnostics/limitations from discovery/application companion data. Preserve them in all formats. A required public field that cannot be represented needs a focused schema amendment before implementation, not an ad hoc extra JSON key. Discovery observations (005: `DiscoveryResult.observations` in `src/discovery/scope.ts`) and parser records (006) now exist as internal companions; metrics (007) and relationships (008) are implemented; 009 indicator/readiness modules and 010 model docs/fixtures are implemented; engine (011) is implemented and exported. Reporting is the next unimplemented layer; orchestration (013) remains TODO.

Match established strict ESM conventions: `.ts` source imports, explicit named exports and exported annotations, `import type`, readonly DTOs, no `any` or suppressions, unknown caught values narrowed before use. Tests use Vitest source imports for units and the trusted build-first integration wrapper for artifact suites. These current facts supersede prospective wording in the original context below.

### Relationship reporting boundary after 007/008

007 metrics and 008 relationships are internal working modules. `RelationshipAnalysis` in `src/relationships/types.ts` includes richer inheritance/call-site/pair/builtin observations than public `Analysis.graphs`. Renderer inputs remain the strict `ReportEnvelope`; 013 maps necessary companion observations into existing diagnostics/limitations. Never serialize companion objects as extra public keys or derive a confirmed builtin count from `lowLevelCallCandidates`. Preserve unavailable storage/type/builtin status, and describe dynamic internal calls as unproven dispatch rather than missing source. `docs/metrics.md` and `docs/relationships.md` now supply the implemented definitions; estimator/report/application integration is still pending. `src/indicators/readiness.ts:122` now returns public test/coverage projections plus internal `testRoots`, `coverageStatus`, `coverageFiles`, inspection `complete`, provenance, diagnostics and limitations. Those internal fields cannot be serialized as new envelope keys. The existing artifact always has unverified provenance, and numeric coverage describes the matched supplied subset. The renderer preserves the application-provided limitations without changing effort or required completeness.

### Confirmed report and model boundary

No formatters exist at this baseline. The implemented ReportEnvelope fields are: schema/tool/command/status/version/fingerprint, scope, nullable analysis/estimate/fullScopeEstimate, diagnostics/limitations. Estimate includes profile, uncalibrated label, microhour ledger, outward hour/day scenarios and coverage. Analysis has per-file/contract/callable metrics, scoped aggregates, graph resolution, indicators, readiness projections and completeness. It has no standalone context-total, selected-count, pruned-tree or resolved-config field; compute only counts provable from existing records and retain unread/pruned observations through diagnostics/limitations. Unread omitted paths cannot be invented as manifest entries. Pure formatters accept this envelope; no filesystem, streams, ANSI auto-detection, locale, clocks or parser imports. CLI supplies `detail`/color preference as presentation options. `docs/model/heuristic-v1.md` and the immutable 010 fixtures now freeze numeric rules. 011 returns a single-input nullable result; ledger precision is the sum of public microhour rows, never a top-level precise-total field. Preserve 011’s bounded production row IDs; do not rewrite them to the readable fixture IDs.

Version policy: schema 1.x allows additive optional fields/codes; breaking type/meaning/removal requires major. Producer validates exact current schema; consumers ignore unknown compatible optional fields and reject unknown majors. Fingerprints use domain canonicalization, no timestamp/absolute paths or source text. Same successful semantic input and versions yields identical JSON; byte hashes may differ for CRLF while metric values remain equal.

### Current code anchors and convention exemplar

`src/index.ts:34` exports the implemented `estimateEffort`; `src/estimation/ledger.ts:37` hashes row identities and `:43` preserves canonical production order. The renderer must never decode those hashes. `src/domain/types.ts:321` is the analysis shape and `:350` is the report shape; `src/domain/schemas.ts:648` validates reports with runtime cross-field refinements. Confirm these snippets during drift review:

```ts
// src/domain/types.ts:302 (excerpt)
export interface EstimateResult {
  readonly profile: 'heuristic-v1';
  readonly modelVersion: '1.0.0';
  readonly label: 'uncalibrated heuristic';
  readonly coverage: 'full' | 'analyzed-subset';
  readonly auditorHours: ParameterRange;
  readonly auditorDays: ParameterRange;
  // contributions, assumptions, manualAdjustments and parameters follow.
}

// src/domain/canonical.ts:115 (excerpt)
/** Only explicit ID-bearing collections get stable ordering. Ledger order remains meaningful. */
export function sortById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => codePointCompare(a.id, b.id));
}

// src/domain/diagnostics.ts:36 (validation/convention exemplar)
export function parseProducerReport(input: unknown): ReportEnvelope {
  return ReportEnvelopeSchema.parse(input);
}
```

Match explicit return annotations, readonly inputs and copied arrays. `canonicalJson` is compact and order-preserving for arrays; `sortById` works only for objects with `id`, so fileId/evidence/value collections need their explicitly specified comparators. Do not change domain APIs just to export their private comparator.

## Commands you will need

**Historical reconciliation gate note (2026-10-15 at `d012fb9`, before 011):** Plans 001–010 are implemented on `main`. Node `24.21.0`, pnpm `11.28.4`; typecheck, lint, format-check and **284 unit tests** passed. Fresh-build `test:integration` passed **210 integration/research tests**; `schemas:check` passed with committed schemas unchanged. Commands used installed dependencies with `--config.verifyDepsBeforeRun=false`. No frozen install, coverage, dependency advisory lookup or Linux/Windows checks were rerun. The known stalled-child startup timing failure did not recur; 014 retains its test-hardening follow-up. No inherited formatting exception remains.

Current production output has **eleven files**: `bin.js`, `bin.js.map`, `canonical.js`, `canonical.js.map`, `index.d.ts`, `index.js`, `index.js.map`, `parser/worker.js`, `parser/worker.js.map`, `version.js`, `version.js.map`. The exact inventory and runtime imports are checked in `test/integration/bootstrap-cli.test.ts`; `canonical.js` now carries shared domain code and `index.js.map` accompanies the implemented engine. This count includes nested worker files, not the `parser/` directory itself. Plans 011–013 now permit narrowly reviewed explicit inventory changes caused by runtime library exports: inspect and record every actual production path/import, retain a strict recursive allowlist and all worker checks. Do not restore the historical forwarding-only index inventory, or accept arbitrary chunks/test/config artifacts. A new production entry, bundler/dependency-policy change or unexplained artifact requires a focused amendment. Feature-specific tests/scripts below remain future deliverables.

An executor works in its own checkout or worktree, which does not share `node_modules`: run `pnpm install --frozen-lockfile` first and obtain success. Afterwards `pnpm --config.verifyDepsBeforeRun=false run <script>` runs a script without pnpm's implicit dependency reconciliation (it does not repair missing packages). Built-artifact suites run through the build-first wrapper (`pnpm test:integration` / `pnpm test:all`), never against stale `dist/`. This reconciliation did not run `pnpm install --frozen-lockfile` or `pnpm test:coverage`.

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

**This review at `69101d5`:** Node `24.21.0`, pnpm `11.28.4`; read-only `typecheck`, `lint`, `format:check` (129 matched non-plan files) and 171 tests across `domain`, `model-spec`, `estimation` and `estimation-properties` passed with installed dependencies and the reconciliation override. Markdown heading/fence/local-link checks and `git diff --check` also pass; Oxfmt intentionally ignores `plans/`. No install, build, artifact/integration suite, schema generation check, coverage or platform run was performed in this review. Feature-specific commands below are executor targets, not completed reporting tests.

| Purpose | Command | Expected |
|---|---|---|
| Renderers/goldens | `pnpm --config.verifyDepsBeforeRun=false run test test/unit/reporting.test.ts` | hand-reviewed complete/partial/error outputs pass |
| Schemas | `pnpm schemas:check` | 0, generated schema bytes match; runtime fixture validation is asserted in reporting units |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all` | 0; test:all performs its required fresh build |

## Scope

**In scope:** `src/reporting/{terminal,json,markdown,display,sanitize}.ts`, `src/index.ts` (serialization exports), `test/integration/bootstrap-cli.test.ts` (native serialization/purity checks and justified exact artifact-inventory changes only), `test/unit/reporting.test.ts`, `test/golden/{terminal,json,markdown}/**`, `test/fixtures/reports/**`, `docs/output-schema.md`, 012 status row and scoped review/execution note in `plans/README.md`. The plan file itself is planning context, not an implementation target.

**Out of scope:** CLI stream routing/output writes, color/TTY libraries, HTML/PDF/UI, estimates recomputation, pricing/proposal generation, schema/metric/model semantics changes, dynamic output plugins.

## Git workflow

Use supplied checkout. No commits/pushes/publication or branch change without operator instruction.

## Steps

### Step 1: Freeze the pure API and serialize one validated stable JSON envelope

Create `src/reporting/json.ts` and `display.ts`. The final named public API through `src/index.ts` is `serializeJson(envelope: ReportEnvelope): string`, `formatTerminal(envelope: ReportEnvelope, options?: TerminalFormatOptions): string`, `formatMarkdown(envelope: ReportEnvelope): string` and the `TerminalFormatOptions` type. Export serializeJson now; add the other exports alongside their implementations in Steps 2/3, without placeholder functions. In Step 2 define the readonly terminal options in `terminal.ts`: `detail?: boolean | undefined` and `color?: boolean | undefined`. Omitted detail means `envelope.command === 'explain'`; explicit detail overrides that default. Color defaults to false; when true, apply only fixed renderer-owned ANSI styles, after sanitizing untrusted values. Markdown always supplies full detail. No API reads `process`, environment, TTY, terminal width, locale, filesystem or clocks; no parser, discovery, application or estimation imports. Unit fixture construction may call the existing estimator; production rendering may not.

All three public renderers validate with `ReportEnvelopeSchema.parse` before rendering, including callers that bypass TypeScript. Let validation failure throw; never return a fabricated error envelope or print schema error details. 013 owns sanitized error mapping. Producers support the exact current schema `1.0.0`, rejecting even a future compatible minor; forward readers use the separate compatibility policy. Schema numeric bounds distinguish safe integer counts/microhours from valid fractional parameters/hour/day endpoints. Reject NaN/Infinity/unsafe integer fields, without applying `Number.isSafeInteger` to decimal parameters. Preserve signed manual rows. Do not recalculate or validate model formulas by invoking the engine.

Use the collection policy below on fresh copies in `display.ts` for every format. Never mutate caller objects, drop duplicates, deduplicate diagnostics or modify supplied fingerprints. Structural validation alone does not prove model arithmetic or referenced-ID consistency; tests must construct coherent envelopes rather than adding schema amendments here.

| Collection | Presentation/serialization order |
| --- | --- |
| `scope.entries`, `analysis.files` | Unicode code point order by `fileId` |
| `analysis.contracts`, `analysis.callables`, `analysis.graphs`, `analysis.indicators` | Unicode code point order by `id` |
| Scope role ID arrays, completeness ID arrays, file `importIds`/`contractIds`/`callableIds`, contract `callableIds`, graph `candidateTargets` | Code point order of the string values; retain every value |
| `analysis.testObservations` | Path, then canonical serialized record as a deterministic tie breaker |
| Every measurement's `evidence`, entry `ownershipEvidence`, graph/indicator `evidence` | File ID, then numeric startByte/endByte, then numeric start/end line/column; sort copies |
| Measured `complexMutableDeclarationIds.value`; measured `typeShapes.value` | String value; declaration ID then canonical record respectively |
| `estimate` and `fullScopeEstimate`: `contributions`, `manualAdjustments`, `assumptions` | Preserve supplied order exactly; 011 already returns contributions sorted by production ID |
| `modifiersApplied.value`, diagnostics (including `details`), envelope/indicator limitations, all arrays not explicitly listed above | Preserve supplied order exactly; never recursively sort arbitrary arrays |

Object keys use the Unicode **code point** comparison already implemented by `canonicalJson`/`sortById`, including astral characters (default JS sort uses UTF-16 units). Pretty output must retain canonical key order, indent with two spaces and end in exactly one LF. A safe approach for this fixed schema is canonicalizing the normalized envelope and pretty-printing its parsed JSON; if implementing a recursive pretty writer instead, test equivalent ordering. Do not change `src/domain/canonical.ts`. JSON preserves raw labels as escaped data; human sanitization never rewrites JSON or fingerprints.

Keep complete/partial/error in the one envelope contract, preserving empty/null/unavailable values. JSON contains no renderer-added fields, source snippets, machine metadata, active link objects or diagnostic stacks. Structured project-path fields already reject native absolute paths via the schema. Native paths/source text accidentally embedded in free-form application messages cannot be reliably identified by a renderer: 013 must supply redacted public prose. Do not implement heuristic path/URL redaction that corrupts legitimate labels; URL-like filenames remain inert JSON strings.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test test/unit/reporting.test.ts -t json` → 0. Check both input and parsed serialized result with `ReportEnvelopeSchema.parse`; permutation tests cover every sorted family above, while ordered arrays remain unchanged. Deep-freeze a multi-record input and render twice, asserting no mutation and identical bytes. Test exact LF/indentation, fractional parameters, signed rows, invalid versions/numbers/unknown public keys and a runtime status/coverage invariant. Do not rely on generated JSON Schema for runtime cross-field refinements.

### Step 2: Render a concise terminal summary and full explanation

Create `terminal.ts` using shared display projection/measurement formatting. Lead with command/status and supplied auditor-hour/day scenarios when an estimate exists, plus **uncalibrated heuristic**, **effort, not elapsed delivery time**, and scenario bounds with no probability/accuracy claim. Display supplied endpoints unchanged; do not re-round or convert days using `hoursPerDay`. `inspect` shows metrics/scope without an effort claim. Null estimate means `effort unavailable`; show supplied reasons from diagnostics/limitations, or `reason not supplied` if absent. Error output leads with failure category and every supplied diagnostic and limitation; no invented analysis/effort rows. If a distinct `fullScopeEstimate` is supplied, label and render it separately; avoid printing a duplicate when both estimate values are identical.

The envelope cannot prove a total selected/unread/pruned count. Label counts as **manifest scoped/context/excluded entries**, **syntax-complete scoped records** (`analysis.files` where role is scoped and syntaxComplete), and **reported unavailable IDs** from completeness. Do not call them total selected/omitted files or infer that all manifest omissions are known. Display `analysis.aggregates` as supplied; never sum overlapping contract SLOC or count context toward scoped totals. Library is a declaration kind, not an ownership synonym: show role, ownership and declaration kind independently.

Summary includes per-contract rows (ID/path/name, kind, supplied SLOC, declared/mutable state counts), measured/unavailable scoped aggregates, graph resolution counts, warning/limitation text and indicators requiring human assessment. Put nullable names and unavailable measurements through explicit display branches; unavailable is `unavailable (supplied reason)`, never numeric zero. A zero microhour contribution with `inputStatus=unavailable` is an **omitted premium**, not an observed-zero metric; retain its status and explanation.

Partial reports prominently show **analyzed subset**, all supplied unavailable IDs/diagnostics and `full-scope effort unavailable`; this applies with or without a subset estimate. A context-only required failure can make the envelope partial even when every scoped syntax record is complete. Optional readiness warnings do not change report status, estimate coverage or effort. Readiness coverage describes a supplied, unverified matched subset and is never a security score.

Full detail enumerates all manifest paths/roles/ownership and contract IDs, metric/callable facts and ranges present in the envelope, graph endpoints/resolution/candidates, indicator evidence/assessment, readiness measurements, versions and fingerprints. Show `estimate.parameters` with units, every contribution's ID/category/integer low/high microhours/inputStatus/explanation, assumptions, and each manual adjustment's ID/category/signed hours/reason. Manual-row identity hashes cannot be reversed or matched by index: list supplied manual adjustments separately. Likewise, hashed contribution IDs do not expose a file/edge association. Relate category to its parameter (`baseline→slocHours`, `control/storage/evm→corresponding premium`, `project→projectHours`, `interaction→interactionHours`, `boundary→boundaryHours`, `reserve→unknownReserveHigh`, `manual→reasoned adjustment`), without inventing structured formula/evidence links. Refer in plain text to `docs/model/heuristic-v1.md` for formulas; render only existing evidence references. Exact optional totals may sum public integer rows safely, but must not overwrite the supplied scenarios or introduce a public JSON field.

Keep all diagnostic fields (code/severity/phase/message, file/range and supplied details) available in detail/Markdown and JSON; summary includes all diagnostic messages and limitations without truncating omissions. Pruned/unread/dedup observations supplied by 013 are opaque diagnostic details/limitations: display them faithfully, including not-enumerated labels, rather than parsing prose or inferring manifest entries/counts. Use plain ASCII tables, fixed number formatting and no wrapping/truncation by host width. Large metric/evidence detail can be deferred to explain/JSON, but omissions and warnings remain visible.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test test/unit/reporting.test.ts -t terminal` → 0. Assert explicit labels and numeric values for complete, inspect, explain default/overrides, partial with/without estimate, required-context failure, error and complete-with-readiness-warnings. No-color output contains no ESC. `color:true` introduces only the fixed allowed styles and cannot restore input control sequences. Renderer rendering leaves all fields/fingerprints unchanged.

### Step 3: Render full Markdown with safe plain-text escaping

Create `markdown.ts` and `sanitize.ts`. Markdown contains overview/status/scenarios, scope and contract tables, aggregate measurements, graph resolution/indicators, readiness, parameters, full ledger, assumptions/manual adjustments, diagnostics/limitations, versions/fingerprints and available evidence references. Apply the same unavailable/partial/null labels and field mappings as terminal detail. All untrusted strings pass through centralized helpers **before** interpolation, including IDs, diagnostic keys/values, explanations, reasons, names and paths. Never sanitize an assembled table or fixed renderer-owned markup.

Human control policy: replace C0 (U+0000–001F), DEL/C1 (U+007F–009F), line separators (U+2028–2029) and bidi embedding/override/isolate controls (U+202A–202E, U+2066–2069) with visible deterministic escapes; turn CR/LF/TAB in table/list values into visible `\r`/`\n`/`\t`. Preserve ordinary Unicode text. Escape ESC/C1 as well as BEL so CSI, OSC hyperlinks and cursor controls cannot reach terminal output. Removing only ESC is insufficient. Renderer-owned ANSI is applied only afterwards. JSON retains original strings with JSON escaping.

Markdown untrusted text must remain plain text: escape backslashes and Markdown punctuation including brackets, image markers, backticks, pipes, emphasis markers and angle brackets; escape ampersands before generating any entities so supplied entities cannot bypass escaping. Escape raw HTML, link/image/reference syntax, list/heading delimiters and newlines so values cannot create extra rows/blocks. Neutralize URL/email autolinking (including bare GFM URLs), for example by encoding colon, dot and at-sign as numeric character references in untrusted text. Do not use untrusted labels as code-span delimiters, anchors or link targets. No Markdown parser dependency is needed. Tests must check the emitted escape rules/structural row counts for inline links/images, reference links, HTML/entities, bare URLs/email, table separators, backslashes and CR/LF, alongside terminal CSI/OSC/C1 and bidi controls. Fixed model-document references may remain plain text; reports reproduce no Solidity snippets.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test test/unit/reporting.test.ts -t 'markdown|sanitization'` → 0 (regex alternation matches separately named test groups). Adversarial values cannot add raw markup, active link syntax, extra rows or terminal controls, while parsed JSON recovers the original values. Do not assert sanitization merely by snapshot acceptance.

### Step 4: Freeze independent goldens and document output compatibility

Use `test/fixtures/reports/` for validated **full envelope** inputs and `test/golden/{terminal,json,markdown}/` for expected UTF-8 outputs ending in one LF. Include simple, combined, unknown-semantics, partial subset, partial without estimate, inspect and error, plus separate complete-with-optional-readiness-warning and required-context-failure cases. Fixtures must exercise multiple records/evidence, a context library and overlapping contract lines so ordering/role/union mistakes are observable. Domain fixtures supply structural exemplars only; do not silently retain their arbitrary model numbers as numeric oracles.

010's `test/fixtures/estimation/worked-cases.json` has plain engine inputs, literal expected results and test-only `application` wrappers, **not analysis envelopes**. Hand-construct coherent scope/analysis companions for report fixtures (metrics, graph facts and required flags matching the chosen case); validate them with `ReportEnvelopeSchema`. For matching cases take the literal expected result, map readable row IDs to production IDs using the test-only `productionId` pattern in `test/unit/estimation.test.ts:57`, then sort contributions like 011. Preserve original assumption/manual order. Assert real `estimateEffort` output agrees with the literal numerical/category/status/coverage expectations separately; fixture explanation/assumption wording is illustrative, so do not require full textual equality with 011. For production-like report inputs, hand-review and commit the implemented engine explanations/assumptions while keeping every expected number independently literal; never generate expected numerical values, golden bytes or schema fields by running the code under test. Error/inspect/partial-without-estimate companions require no fabricated result. Preserve all existing domain/model fixtures; put additions only in the new report-fixture directory.

Read literal golden files with `new URL(..., import.meta.url)` and compare output bytes in ordinary tests. Initial expected files are explicitly reviewed artifacts; no test/CI update mode or automatic snapshot rewrites. Assert important semantics separately: supplied hours/days/microhour rows, nulls, unavailable reasons, scenario/partial labels, omissions, role separation, privacy and escaping. `schemas:check` verifies generated schema consistency, **not** fixture enumeration; reporting tests must runtime-validate every report fixture and each parsed JSON result. Repeated renders/permuted set-like records give the same bytes; meaningful array permutations intentionally change output.

`docs/output-schema.md` documents the public function signatures/defaults, explicit terminal color contract, ordering table, producer-versus-consumer validation, statuses/nulls/unknowns, measurement and effort units, scope-count limitations, scenario ranges, fingerprints and source privacy boundary. Explain zero unavailable-premium rows and opaque contribution IDs. Include a forward-compatible consumer example that checks the schema major, validates the stable fields it reads and tolerates compatible optional fields/codes; the existing `parseConsumerEnvelope` in `src/domain/diagnostics.ts` is the pattern, but exporting it is outside this plan. State that runtime schema refinements express invariants not present in generated Draft 2020-12 documents.

Extend `test/integration/bootstrap-cli.test.ts` with native Node ESM imports and calls to all three serialization APIs plus declaration checks. It may read committed report fixtures/goldens using the trusted test process; child stdout must contain only the explicitly requested test output, stderr empty. Retain silent-import, worker/shebang/runtime-specifier, estimator and exact recursive inventory tests. Inspect each actual built artifact/import and narrowly update the explicit inventory if renderer exports change chunk layout. Add a reporting purity check using the existing estimation-purity test as a pattern: production reporting imports remain within reporting plus the necessary domain schema/type/version/canonical modules and their reviewed `zod`/`node:crypto` closure; no estimation, parser, I/O/process/network/clock access. Do not broaden the estimation purity allowlist.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test test/unit/reporting.test.ts`, `pnpm schemas:check`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all` → 0. Run `pnpm --config.verifyDepsBeforeRun=false run test:integration test/integration/bootstrap-cli.test.ts` → 0 after its fresh build, including native serialization and exact inspected inventory; the wrapper already builds, so a further standalone build is unnecessary. Keep gate results separate from the historical baseline.

## Test plan

Use `test/unit/domain.test.ts` for schema/identity/measurement and fixture loading patterns, `test/unit/estimation.test.ts` for validated numerical oracles/production ID mapping, and `test/integration/bootstrap-cli.test.ts` for native imports and purity. Group tests under `json`, `terminal`, `markdown` and `sanitization` so the focused commands select real tests. Do not call the future application or CLI handlers; 013 owns end-to-end assembly and stream behavior.

Beyond the cases in Steps 1–4, test absent optional diagnostics details, empty collections, null callable names, measured false/zero versus unavailable, long names, Unicode astral ordering, negative manual adjustments, parameter overrides, missing tests/coverage, failed context with complete scoped syntax, contribution/assumption order retention, fullScopeEstimate handling and error invariants. A deeply frozen input and cross-format value assertions catch mutation and accidental estimation. Test both estimates independently when supplied; no substitution of fullScopeEstimate for a subset estimate. Do not change schema/model fixtures to make reporting pass.

## Done criteria

- [ ] Focused reporting tests, source standards, schema consistency, full regression and fresh-build native API/inventory/purity suites exit 0.
- [ ] All report fixtures and parsed serialized outputs pass runtime `ReportEnvelopeSchema.parse`; no generated-schema-only validity claim.
- [ ] All three functions and terminal options type are named public exports with explicit declarations; native ESM smoke calls each and library import remains silent.
- [ ] Cross-format tests assert supplied scope/metric/effort values and fingerprints without recomputation; deep-frozen input stays unchanged.
- [ ] Explicit tests prove uncalibrated/scenario/partial/unavailable labels, null/error/inspect behavior, omitted-premium semantics and exact supplied scope/diagnostics without invented selection totals.
- [ ] Goldens match checked-in bytes, collection ordering matches the table, meaningful arrays retain order, and human sanitization leaves JSON raw-label values recoverable.
- [ ] No source/model/schema/dependency changes outside the listed implementation scope; only the 012 status row and a scoped review/execution note change in the index.

## STOP conditions

Stop if required capabilities need an out-of-scope file, a new dependency, unavailable companion facts, estimate recomputation, numeric/schema/model changes, source contents/native paths in public fields, a commercial quote, or if a gate fails twice. If expected prerequisite code has drifted, reconcile the actual interfaces before implementation. Historical DONE status alone does not establish prerequisite availability. Do not bless changed goldens without explaining the underlying semantic change.

## Maintenance notes

### Execution review amendment — 2026-10-15

The first executor stopped after two Markdown golden-authoring failures. The reviewer independently ran the complete reporting suite under Node 24.21.0: 25 tests passed and one failed solely because the partial reserve explanation's expected text left two hyphens unescaped. The sanitizer's documented punctuation policy requires `High&#x2d;scenario` and `pre&#x2d;manual`; the supplied text and numeric values are unchanged. One bounded revision is authorized to correct those two literal expected tokens, format only in-scope implementation artifacts, and complete the original verification gates. This is an independently reviewed expectation correction, not permission to regenerate goldens from renderers or relax semantic criteria. A repeated unresolved verification failure after this correction still requires STOP. The executor must report all earlier failures and this amendment.

Golden coverage is explicitly complete, required-context partial and error in all three formats; the other named scenario families use validated full-envelope fixtures and independent semantic assertions. This narrower byte-golden set is an accepted scope tradeoff, provided those assertions remain meaningful.

The reviewer also reproduced `pnpm format:check` failing exclusively on the six JSON/Markdown golden files: Oxfmt's preferred layout conflicts with the renderer's required canonical pretty JSON and fixed Markdown bytes. Add `.oxfmtrc.json` to implementation scope solely to append `test/golden/**` to `ignorePatterns`. Golden files remain independently authored and checked byte-for-byte by tests; source, tests, documentation and all other existing formatting coverage remain checked. No other formatter setting or tool configuration change is authorized.

JSON is a public integration API. Preserve old schema fixtures for compatible releases; separate presentation polish from semantic field changes. New formats should consume the same result, not rerun discovery/calculation.
