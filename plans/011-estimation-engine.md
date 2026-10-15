# Plan 011: Implement the pure, deterministic effort calculation engine

> **Executor instructions:** Implement the frozen model exactly. Run each gate and update only row 011 in `plans/README.md` unless a reviewer maintains the index. Preserve all approved fixture values. Do not tune coefficients, implement caller-side source selection, or extend public DTOs.
>
> **Drift check first:** Reconciled at `d012fb9` on 2026-10-15, with 001–010 present on `main`. Run `git status --short`, `git diff --stat d012fb9..HEAD -- src/estimation src/index.ts src/domain src/config/merge.ts docs/model test/fixtures/estimation test/unit/model-spec.test.ts test/unit/estimation.test.ts test/unit/estimation-properties.test.ts test/integration/bootstrap-cli.test.ts tsdown.config.ts package.json`, then `git diff HEAD --` with that same path list, and inspect untracked files. Domain/config/model/fixture/tooling paths are read-only dependencies. Compare the excerpts below. Inspect expected predecessor changes; stop for incompatible contracts or overlapping source edits. Preserve pre-existing plan edits.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** HIGH (numerical correctness and coverage honesty)
- **Depends on:** `plans/010-model-methodology-calibration.md` — implemented as `d012fb9`, present on `main`; no merge blocker.
- **Category:** direction / correctness
- **Planned at:** commit `d012fb9`, reconciled 2026-10-15 after 009/010 landed; supersedes `2eb8d3d` and `d11bc60`. Originally greenfield planning on 2026-10-14.

## Plan review — 2026-10-15 at `d012fb9`

Reviewed against the frozen specification, runtime schemas, canonical helpers, fixture tests and build/test configuration. The amendments below are implementation instructions; the engine remains TODO. Evidence locations in this table refer to the pre-review plan, where applicable.

| Priority | Gap and impact | Category | Effort / amendment risk | Evidence | Confidence |
| --- | --- | --- | --- | --- | --- |
| P1 | Raw UTF-8 hashing merges distinct schema-valid unpaired-surrogate IDs, causing duplicate contribution IDs and rejection of an otherwise valid estimate. JSON-encode the identity tuple before hashing and test file, pair and manual identities. | correctness | S / LOW — only prospective production IDs change; fixtures already permit different IDs | Original Step 2; `src/domain/canonical.ts:103–112`; string schemas at `src/domain/schemas.ts:18–30` | HIGH — reproduced distinct accepted file IDs with equal raw fingerprints |
| P2 | “Product overflow” does not distinguish exact BigInt intermediates from bounded ledger integers. A Number-sized numerator/denominator restriction would reject valid fractional premiums. Define the conversion boundary and add an accepted large-intermediate oracle. | correctness / tests | S / LOW — clarifies the frozen rational-arithmetic rule | Original Step 3; `docs/model/heuristic-v1.md`, Evaluation order; `src/domain/schemas.ts:9,414–424` | HIGH — accepted input and exact oracle checked independently |
| P2 | Step 4 refers to existing source import-boundary checks that do not exist. A silent import smoke test cannot enforce the transitive purity requirement. Specify new dependency assertions and preserve the actual declaration import guard. | tests / architecture | S / LOW — extends the already scoped bootstrap suite | Original Scope/Step 4; `test/integration/bootstrap-cli.test.ts:20–75` | HIGH — read the complete existing suite |

Additional handoff clarifications: keep malformed runtime test values typed `unknown`, define fresh result ownership, cover storage-unavailability branches absent from the frozen examples, and give explicit accepted/over-limit numerical constructions. This review changes only plan documents; source, schemas, fixtures and frozen methodology remain untouched. Caller filtering, metadata neutrality and ordinary internal virtual dispatch remain intentional 013/008 responsibilities, not engine defects.

## Why this matters

The central product is a transparent estimate another auditor can reproduce. A pure engine with exact contribution sums, independent oracles and a static versioned profile makes the model executable without depending on parsing or CLI behavior. Plan 010 has frozen the specification and fixtures; this plan supplies the previously deferred behavioral verification.

## Current state and architectural context

`src/estimation/` does not exist. These reviewed artifacts now exist:

- `docs/model/heuristic-v1.md`: normative formulas, eligibility, channel availability, rounding order and output bounds.
- `test/fixtures/estimation/profile.json`: full starter profile; copy its literals into production, never import test data at runtime.
- `test/fixtures/estimation/worked-cases.json`: 27 cases, 22 nonnull results and 5 null outcomes, with independent precise totals and public contribution rows.
- `test/fixtures/estimation/invalid-cases.json`: 35 schema failures, 9 eligibility-null cases and 11 schema-valid engine rejection cases.
- `test/unit/model-spec.test.ts`: 37 tests checking literal shape/consistency and documents, not engine behavior. Its five describe groups remain unchanged.

Load-bearing current type (`src/domain/types.ts:285`):

```ts
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

`EstimateResult` (`src/domain/types.ts:302`) has exactly `profile`, `modelVersion`, `label`, `coverage`, `auditorHours`, `auditorDays`, `contributions`, `assumptions`, `manualAdjustments`, `parameters`. Each public contribution is:

```ts
{
  readonly id: string;
  readonly category: string;
  readonly lowMicrohours: number;
  readonly highMicrohours: number;
  readonly inputStatus: 'measured' | 'unavailable' | 'manual';
  readonly explanation: string;
}
```

There is no public precise-total, formula/evidence association, resolved-config provenance or omission field. Keep richer computation records internal. Derive precise totals in tests by summing the emitted rows. `fullScopeEstimate` is a report-envelope field owned by 013.

`EstimateInputSchema` (`src/domain/schemas.ts:492`) rejects duplicate eligible file IDs, duplicate manual IDs, self-pairs and duplicate directed pairs within or across partitions. Pair endpoints are opaque strings here; the engine has no contract-to-file map. **013 selects complete-syntax first-party scoped files, deduplicates and filters pairs, and retains omissions before constructing this input.** Do not parse declaration IDs to reconstruct missing ownership or silently drop files/pairs inside the engine.

`src/config/merge.ts` already resolves partial overrides into a complete `ModelProfile` and records provenance. The engine consumes the effective embedded profile; it must not reapply defaults or duplicate config precedence. `selectModel()` supplies fresh trusted starter defaults for callers; it does no config loading.

The reusable canonical helpers are `canonicalJson`, `fingerprint` and `sortById` in `src/domain/canonical.ts`. `fingerprint` frames UTF-8 bytes with lengths; it does not preserve distinct unpaired UTF-16 surrogates in raw strings. `canonicalJson` JSON-escapes those code units and returns a string. Use the encoded identity tuple specified in Step 2; do not change the shared helper or reject strings the existing schemas accept. The bootstrap suite currently checks inventory, declarations, help/version/shebang and one native import. It has no source dependency-closure assertion yet.

Match strict ESM: `.ts` source imports, explicit named exports and public annotations, `import type`, readonly DTOs, no `any`/suppressions, narrow caught `unknown`. Pure-module exemplar: `src/domain/canonical.ts`; source-test loader/style: `test/unit/model-spec.test.ts` and `test/unit/domain.test.ts`. Domain canonical helpers intentionally use `node:crypto` for deterministic fingerprints; that is permitted. Estimation must import no filesystem, child process, parser/Slang, readiness, CLI, reporting, network or clocks. No new dependencies.

## Frozen calculation contract

For each file: `L=sourceLines`, `D=decisions`, `S=mutableCount`, `M=distinct complexMutableDeclarationIds`. Constants/immutables are excluded from S/M. Each mutable mapping, array or explicitly resolved struct counts once.

```text
q_control = min(1, D / max(1, L/10))
q_storage = 0 if S=0, otherwise min(1, M/S)
q_evm = max(assemblyBlocks>0 ? 1 : 0, confirmedBuiltinLowLevelCalls>0 ? .5 : 0)
B_s = L * slocHours_s
C_s = B_s * controlPremium_s * q_control
T_s = B_s * storagePremium_s * q_storage
V_s = B_s * evmPremium_s * q_evm
P_s = projectHours_s + sum_files(B_s+C_s+T_s+V_s)
      + sum_scoped_pairs(interactionHours_s) + sum_context_pairs(boundaryHours_s)
U_low = 0; U_high = effectiveUnknown ? roundedPreManualHigh * unknownReserveHigh : 0
H_s = P_s + U_s + sum_manual(lowHours or highHours)
```

Starter low/high assumptions: project 4/12 h; SLOC .04/.12 h/line; control .10/.25; storage .05/.15; EVM .20/.50; scoped pair .25/.75 h; context boundary .50/2 h. Scalar high reserve .25; scalar hours/day 8. Every coefficient is an **uncalibrated assumption**. No extra weights for declared counts, indicators, tests, coverage or human prompts.

**Eligibility:** validate structural inputs first. Required incomplete analysis with `allowPartial=false` returns null. Empty eligible set, total measured SLOC=0, or any supplied unavailable baseline returns null in either mode. Do not remove unavailable baseline files internally. Positive complete input returns `coverage='full'` even when `allowPartial=true`. Positive incomplete input with explicit partial returns `analyzed-subset`. A zero-SLOC file may accompany a positive file and retains its zero channel rows.

**Control:** unavailable D makes the control row unavailable. **Storage:** reject contradictory measured facts before S=0 shortcuts: duplicate shape/complex IDs, mutable>total, available shape length/count disagreement, mutable-shape count disagreement, M>S, complex IDs absent from the mutable shapes, or elementary/constant IDs declared complex. When all relevant shape information is measured and classifiable, the complex set must match mutable mapping/array/struct declarations. S=0 needs no numerator; otherwise unavailable mutable count, type shapes or complex classification makes the channel unavailable. Mutable `user-defined`/`unknown` shapes make classification unavailable even if a supplied syntax-only mapping/array list is measured. Preserve the input; never infer structs from names or change metrics.

**EVM:** measured assembly>0 determines q=1 even with unavailable builtin count. Otherwise both counts must be measured: A=0/K>0 gives .5, both zero gives 0. Unavailable assembly leaves q unknown even with a positive K; omit the whole premium. Do not charge a guessed partial premium.

**Unknown reserve:** upstream `hasUnknownSemantics` OR unavailable D/A/K OR required unavailable storage inputs. S=0 needs no numerator. Assembly dominance still retains unavailable-K uncertainty. Never clear upstream flags or derive new ones from unsupported graph edge names, indicator confidence or optional readiness. 008 intentionally does not flag ordinary internal virtual dispatch alone. Unavailable premium rows remain 0/0 with `inputStatus='unavailable'`; known zero uses `measured`.

**Precision/order:** interpret accepted six-decimal numbers exactly, including `1e-6`; JSON spelling is lost by input time, so parse the number's canonical decimal/scientific representation. Use BigInt rational arithmetic internally. Do not round q or baseline before multiplying a whole premium. Floor each whole low contribution and ceil each high contribution to microhours. Sum rounded project/file/pair rows, calculate and ceil high reserve from that rounded high subtotal, then add exact signed manual microhours. Sort final rows by Unicode code points. Display hours floor-low/ceil-high to integers; derive days from those displayed hours and exact hours/day outward to tenths. BigInt never escapes public output.

BigInt numerators, denominators and multiplication intermediates may exceed `Number.MAX_SAFE_INTEGER`; this alone is not overflow. Apply safe-integer checks to ledger microhour integers/totals before conversion, and output bounds to their corresponding final quantities. Do not convert a rational to Number to check it. Eligibility needs only all baselines measured and at least one positive L; avoid Number accumulation of potentially huge SLOC counts. Positive SLOC with all rates/allowances zero is an eligible zero-hour result, not null.

**Bounds:** individual row ±100,000,000,000 microhours; <=100,000 rows; IDs/explanations <=512 code units; ordered nonnegative hour/day endpoints <=1,000,000,000; safe-integer microhour values/totals. Row count is `2 + 4*files + scopedPairs + contextPairs + manualAdjustments`, including zero/unavailable rows. Preflight count before retaining rows. Validate the final result with `EstimateResultSchema`. Schema-valid inputs may exceed output bounds: reject explicitly, never clamp, truncate or widen schemas. An overflow rejection exercised by a test is expected behavior, not a development STOP.

## Commands you will need

Prior reconciliation on Node `24.21.0`, pnpm `11.28.4`, at `d012fb9` recorded passing typecheck, lint, format-check, 284 units, 210 fresh-build integration/research tests and `schemas:check`. This plan review independently reran the 37 frozen spec tests and typecheck; fresh lint/format and documentation checks are recorded in the 011 index review. Full regression, builds, installs, coverage, advisories and platform checks were not rerun for this plan-only review. The historical stalled-child timing issue remains a 014 follow-up.

In a fresh implementation checkout run `pnpm install --frozen-lockfile` successfully first. With installed dependencies use `pnpm --config.verifyDepsBeforeRun=false run <script>` to avoid implicit reconciliation; it does not repair missing packages. Unit commands never build. Artifact tests use the build-first wrapper, and schema checking builds itself. Oxfmt ignores plans; plan changes need Markdown/link checks and `git diff --check`.

| Purpose | Command | Expected |
| --- | --- | --- |
| Formula and fixture cases | `pnpm --config.verifyDepsBeforeRun=false run test test/unit/estimation.test.ts` | actual engine cases execute and pass |
| Bounded numerical properties | `pnpm --config.verifyDepsBeforeRun=false run test test/unit/estimation-properties.test.ts` | deterministic assertions pass |
| Frozen spec regression | `pnpm --config.verifyDepsBeforeRun=false run test test/unit/model-spec.test.ts` | 37 existing spec tests pass unchanged |
| Native API/artifacts | `pnpm --config.verifyDepsBeforeRun=false run test:integration test/integration/bootstrap-cli.test.ts` | fresh build, exact inventory and native library/API checks pass |
| Final gates | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm schemas:check`, `git diff --check` | all exit 0 |

Feature tests below are new deliverables, not present verification. Every `-t` filter must execute real assertions; zero tests or all skipped is failure.

## Scope

**In scope (only these implementation paths):**

- Create `src/estimation/{estimate,eligibility,model,fixed-point,ledger}.ts` and `src/estimation/profiles/heuristic-v1.ts`. Put `EstimationError` in `estimate.ts` or another listed module; no extra error-module path is needed.
- Extend `src/index.ts` with the pure calculation/model/error named exports and necessary existing types.
- Create `test/unit/{estimation,estimation-properties}.test.ts`.
- Extend `test/integration/bootstrap-cli.test.ts` only for native estimate/model API assertions, the transitive dependency checks in Step 4 and the exact production inventory consequence below; preserve help/version/shebang and the declaration `.ts`-import guard.
- Update only status/review evidence for 011 in `plans/README.md`.

**Read-only/out of scope:** all existing 010 fixtures and `test/unit/model-spec.test.ts`, normative model docs, `src/domain/**`, schemas, config, dependency pins/lockfile, build/test config, parser/discovery/relationships/metrics/indicators, application/CLI wiring and report formatting. New numerical edge cases belong in the two new test files. No fitting, coefficient change, fetching, source execution, pricing, calendar or plugin system.

**Artifact amendment:** current output is exactly ten files: `bin.js`/`.map`, `index.js`, `index.d.ts`, `version.js`/`.map`, `versions.js`/`.map`, `parser/worker.js`/`.map`. Adding runtime root exports can make `index.js` substantive and add its map or alter shared production chunks. Inspect the actual new output and imports, record each path and its production purpose, then update the existing explicit recursive allowlist only for those justified files/removals. No wildcard directory/chunk acceptance, test/config entries or tsdown/dependency-policy changes. An unexplained artifact requires STOP/review. Verify the worker still resolves and no build cleans beyond `dist/`.

## Git workflow

Use the supplied checkout and preserve unrelated work. Recent messages are Conventional Commits, e.g. `d012fb9 docs: freeze heuristic-v1 model methodology and calibration protocol`. No commit/push/merge/publication or branch change without operator instruction.

## Steps

### Step 1: Add profile selection, typed errors and validated eligibility

Implement `selectModel(profile?: string, modelVersion?: string): ModelProfile` returning a fresh deep copy of the static `heuristic-v1@1.0.0` literals, defaulting omitted arguments to those versions and rejecting unsupported values with `EstimationError` reason `invalid-input`. Keep the shared error in a listed module that both entry points can import without a cycle. Test defaults, explicit supported values, each unsupported argument independently and equality to `profile.json`; mutating one returned copy must not alter future selections. Do no I/O or fixture imports in production.

Implement `estimateEffort(input: EstimateInput): EstimateResult | null`. Invalid structural input is rejected via `EstimateInputSchema` and a named `EstimationError` with an explicitly annotated readonly `reason: 'invalid-input' | 'inconsistent-measurements' | 'invalid-total' | 'output-bound' | 'unsafe-arithmetic'` and fixed sanitized message; use that same class for inconsistent measured facts and invalid/output-overflow totals. Keep causes internal. This error is not a new domain diagnostic code; 013 owns public diagnostic/exit mapping. Validate before eligibility; for eligible inputs validate measured storage contradictions as specified. Unsupported model/structural failures use `invalid-input`; storage contradictions use `inconsistent-measurements`; negative/reversed totals use `invalid-total`; row/count/hour/day limits use `output-bound`; unsafe integer arithmetic uses `unsafe-arithmetic`. If multiple rejection conditions apply, tests should require rejection rather than an invented numeric result. Normal null is distinct from rejection. Return only actual public DTO fields, using the embedded effective model unchanged.

Load fixtures as unknown using local wrapper schemas following `test/unit/model-spec.test.ts`; do not import that test module. Run every eligibility row and all null worked outcomes. Run schema cases targeting input/model through the relevant boundary (embed invalid model values in a valid input); result-schema failures remain schema tests, not engine requests. Add in-memory NaN/infinity tests without inventing JSON numbers.

Keep the public typed signature. For deliberately malformed runtime values, use `Reflect.apply(estimateEffort, undefined, [value])` inside rejection assertions with `value: unknown`; do not cast malformed data to `EstimateInput` or add a type suppression. Valid fixtures are narrowed by the existing schemas. Return fresh result objects/arrays, including copied parameters and manual adjustments, so neither subsequent caller mutation nor a previous result changes the other; preserve manual adjustment input order and values.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test test/unit/estimation.test.ts -t 'validation and eligibility'` and `pnpm typecheck` → exit 0, named cases execute, null versus typed errors asserted. Do not return placeholder success results for positive cases; add those tests with Step 2.

### Step 2: Implement exact channels, ledger and outward display

Implement rational helpers in `fixed-point.ts`, calculation/channel selection in the listed engine files, and internal formula/identity records in `ledger.ts`. Check bounds before Number conversion. Use one row per file channel/pair/manual and project/reserve rows, including zeros; category labels are `baseline`, `control`, `storage`, `evm`, `interaction`, `boundary`, `manual`, `project`, `reserve`.

Freeze this bounded identity scheme: project/reserve IDs are `project`/`reserve`; other IDs are `<category>:<fingerprint>` with the existing helpers composed as `fingerprint([category, canonicalJson(identityParts)])`. Identity parts are `[fileId]`, `[leftId,rightId]` (direction preserved), or `[manual.id]`. JSON-encoding the tuple before UTF-8 hashing preserves unpaired surrogates and tuple boundaries. Do not hash raw identity strings, concatenate endpoints with a delimiter, normalize Unicode or alter shared domain helpers. Explanations use bounded fixed templates labelling effective coefficients as uncalibrated assumptions, unavailable omissions and manual rationale retained in `manualAdjustments`; unbounded input names are not interpolated. The fixed bounded assumptions array must state the uncalibrated label, scenario/non-probabilistic meaning and cumulative effort/excluded-work conventions from the fixtures.

The frozen fixtures use readable IDs such as `storage:file:src/A.sol` and `interaction:<left>><right>`. Their docs permit different production IDs. Build an explicit test-only mapping from each fixture row's known file/pair/manual identity to the production ID; compare category, low/high amounts and input status per mapped row without changing fixture IDs or values. Assert the actual complete DTO separately through `EstimateResultSchema`, model/coverage/parameters/manual fields and substantive explanation/assumption checks. Explanations need not match fixture prose byte-for-byte. Never compare only total hours or use the engine to generate expected amounts.

Run all 27 worked cases (null included), all 9 eligibility rows and all 11 engine-invalid rows. For nonnull results compare every row and precise sums, displayed hours/days and label/coverage/parameters. Pins include combined 10,200,000..33,200,000, unknown high 40,750,000, fractional storage 28,571..257,143, signed discount 7,028,571..23,757,143, and reserve override high reserve 49,542,858 / total 74,314,287 microhours. Assembly with unavailable builtin must yield 8.8..37.5 precise hours; S=0/unavailable numerator stays 8..24. Preserve six-decimal/scientific notation support.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test test/unit/estimation.test.ts -t 'worked formulas and ledger'`, full estimation suite and `pnpm typecheck` → exit 0; every fixture stage is exercised by the right boundary, exact row/sum/display checks pass.

### Step 3: Exercise output bounds and meaningful properties

Use bounded enumerated inputs, no property-test dependency/random runtime behavior. Generate unique bounded IDs rather than huge committed files; count expected retained rows independently from the engine. Include these independent constructions in the two new test files, with all unrelated premiums/reserve/manual allowances disabled unless specified:

- **Row amount:** one file, SLOC rate `0.000001` for both scenarios and project zero; L=`100_000_000_000` gives exactly `100_000_000_000` baseline microhours and succeeds, L+1 exceeds the row limit by one microhour and rejects.
- **Row count:** one positive-SLOC file, all coefficients zero and `99_994` scoped pairs gives exactly `100_000` retained rows and a nonnull zero-hour result; one more pair rejects. Do not omit zero rows. Both inputs must pass `EstimateInputSchema` before invoking the engine.
- **Hour bound:** one positive-SLOC file with zero SLOC rate, `99_993` scoped pairs at `10_000` hours each, project `10_000` and one manual allowance of `60_000` hours, all low=high. This gives exactly `100_000` rows and `1_000_000_000` hours and succeeds at 8 hours/day. Raising only the allowance to `60_001` rejects for the hour bound while row amounts/count and days stay within bounds. Keep large cases sequential and release references between cases.
- **Day bound:** one file with L=`1_000`, rate 1 hour/line, project zero and hours/day `0.000001` gives exactly `1_000_000_000` days and succeeds; L=`1_001` rejects for days while rows and hours stay within bounds.
- **Large valid intermediates:** L=`99_999_999_991`, D=1, equal SLOC/control rates `0.000001` and project zero gives baseline `99_999_999_991` microhours per side and control `0/1` microhours. The precise totals are `99_999_999_991..99_999_999_992`, displayed hours `99_999..100_000` and days `12_499.8..12_500` at 8 hours/day. A rational denominator can exceed Number safety; this input must succeed. Separately, two files with L=`Number.MAX_SAFE_INTEGER` and all rates zero must succeed without unsafe Number SLOC accumulation.
- **Actual overflow:** exercise the frozen `unsafe-integer-sum` rejection plus generated oversized rounded rows/totals. These can also violate row/hour bounds; require a typed rejection without requiring a particular reason when multiple conditions apply. Do not require a contrived public input that violates only safe-total arithmetic, or reject exact large BigInt intermediates.

Assert frozen-input nonmutation, result/input ownership isolation, repeat byte equality, file/pair/shape/complex-ID input permutation invariance, unique stable bounded IDs even for long file IDs and delimiter-containing identities, reverse-pair distinction, schema-invalid duplicate rejection, assembly/low-level max dominance, decisions increasing only to cap and reserve excluding manual allowances. Add schema-valid pairs of distinct file IDs, pair endpoints and manual IDs containing different unpaired surrogates and literal U+FFFD; each must retain distinct stable row IDs. A supplementary Unicode scalar must retain its own identity too. Increasing L at fixed D must not lower total; do not assert generic storage-density monotonicity (adding simple state can reduce density). Changing hours/day changes the echoed parameter and days; hours, rows, coverage and manual values stay identical. Reasoned discounts are an explicit exception to nondecreasing totals. Test effective profile override use with immutable defaults.

Add table-driven storage cases beyond the frozen fixtures: duplicate shape IDs; measured shape/total-count mismatch; a missing known mutable mapping/array/struct ID when classification is otherwise complete; unavailable mutable count or shapes at S>0; and each mutable `user-defined`/`unknown` shape with a measured syntax-only complex list. The unavailable cases retain a `0/0 unavailable` storage row and add the high reserve; measured contradictions reject even when S=0 or another storage input is unavailable. Measured S=0 with unavailable shapes/classification still gives a measured zero row and no storage-derived reserve. Unavailable total declaration `count` alone does not block a channel whose S, shapes and complete complex set are measured consistently. Include a labelled synthetic resolved-struct input to verify the explicitly supported plain-input channel without extending parser capabilities.

Indicator/readiness metadata are absent from `EstimateInput`; assert dependency boundaries now. End-to-end same-facts metadata neutrality, source-to-input filtering and graph-site deduplication belong to 013. Do not fabricate an application builder in engine tests or accept extra unknown keys to test these concerns.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test test/unit/estimation-properties.test.ts`, estimation/spec units, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` → all exit 0. Existing spec fixtures/tests remain byte-identical.

### Step 4: Expose the API and verify native artifacts

Export `estimateEffort`, `selectModel` and `EstimationError` through `src/index.ts`; preserve all existing exports. Add a native Node ESM library test in `test/integration/bootstrap-cli.test.ts` using its existing `runNode`/URL pattern: import silently, pass a plain input loaded from a frozen fixture by the test harness, call the emitted API and compare known hours/ledger sums. Exercise static profile selection and a malformed plain input yielding the exported `EstimationError`. Assert stdout contains only the harness's expected serialization and stderr is empty. Fixture loading belongs to the test harness; estimation does no fs/Slang/worker/config reads.

Create the missing dependency checks in that same scoped bootstrap test file. Check every new estimation module and follow its static source imports/re-exports transitively. The permitted local closure is `src/estimation/**` plus `src/domain/{canonical,schemas,types,versions}.ts`; permitted external runtime specifiers are `zod` and `node:crypto`. Type-only imports must also stay within the local domain/estimation boundary. Reject filesystem, child-process, parser/Slang, config, readiness, reporting, CLI, application, network, clock, dynamic-import/require and callback coupling. Keep the helper test-local; do not add a tool/config dependency or scan dependency-package internals. Separately inspect emitted `.js` import specifiers for `.ts`/`src/` references while preserving the existing declaration guard. Checking only direct engine imports or a silent import is insufficient to establish the transitive boundary.

Run the fresh build and inspect every artifact change under the scoped inventory amendment. Preserve all bootstrap assertions and worker regression behavior; no bundler/source export workaround that hides a test or changes external dependency policy. Schema check must leave all committed schemas untouched.

**Verify:** native API/artifact gate in the table, then `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm schemas:check`, `git diff --check` → all exit 0. Compare `git diff --name-only` and untracked paths with starting status/Scope; only then update 011.

## Test plan

Two new source-only unit suites exercise actual engine behavior against immutable independent fixtures. Follow `test/unit/model-spec.test.ts` for unknown JSON loading/local wrappers and `test/unit/domain.test.ts` for schema/error assertions. Organize describe groups exactly as named in the gates. Test storage contradictions, availability shortcuts, fractional/signed arithmetic, reserve evaluation order, decimal/scientific parsing, all bounds, identity/determinism and module purity. Built native API tests remain in the integration project through the build-first wrapper. No network, parser, target scripts or empirical accuracy assertions.

## Done criteria

- [ ] All 27 worked, 9 eligibility and 11 engine-invalid cases execute against the engine; every nonnull row/precise sum/display range matches independent literals through the documented ID mapping.
- [ ] Structural/model invalid cases and nonfinite inputs reject; fixture result-schema cases are checked as result validation, not passed as inputs.
- [ ] Exact row/count/hour/day bounds and overflows reject without clamps/truncation; rational arithmetic has no binary-float accumulation or public BigInt.
- [ ] All accepted boundary/large-intermediate oracles in Step 3 succeed with their exact rows/totals; unpaired-surrogate identities stay distinct; storage availability and ownership-isolation assertions pass.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm schemas:check`, `git diff --check` exit 0; native API/inventory/worker assertions pass.
- [ ] Existing model docs, fixtures, spec test, schemas and dependency/tooling files unchanged; no application selection logic or I/O coupling.
- [ ] Diff scope is clean relative to initial local work; status 011 includes evidence and the exact justified artifact inventory if it changed.

## STOP conditions

Stop for incompatible drift, an independently incorrect frozen oracle, a necessary source/schema/dependency/tooling edit outside Scope, unexplained production artifacts, I/O/parser coupling, new weights/type inference, or a gate failing twice after a reasonable scoped fix. Do not reinterpret a fixture's expected rejection/null as a development blocker. Do not tune coefficients, widen output schemas, silently remove invalid input or add public precision/omission fields. Report a focused amendment if the frozen contract cannot be implemented honestly.

## Maintenance notes

Formula/default/rounding/availability changes need model-version review and preserved old fixtures. Caller filtering and metadata neutrality remain 013 gates. Public explanation strings may evolve without changing numerical semantics; stable identity mappings and exact row-value assertions must remain. Preserve JSON tuple encoding before fingerprinting; length framing alone does not preserve ill-formed UTF-16 strings through UTF-8. Config precedence/provenance stays in config, measurement meaning stays in metrics, and empirical validity stays with the calibration protocol.
