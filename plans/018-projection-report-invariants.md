# Plan 018: Reject contradictory projection metadata at the public report boundary

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report. Do not improvise. When done, update the status row for this plan in `plans/README.md`, unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat d68d466..HEAD -- src/domain/schemas.ts src/application/estimation-scope.ts src/application/dependency-reuse/project.ts src/application/analyze.ts test/integration/estimation-scope.test.ts docs/dependency-reuse.md`
> If any listed file changed since this plan was written, compare the "Current state" excerpts below against the live code before proceeding. On a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (plan 017's implementation is present at `d68d466`)
- **Category**: bug (validation correctness, with tests)
- **Planned at**: commit `d68d466`, 2026-10-16, branch `estimation_scope`

## Why this matters

`ReportEnvelopeSchema` (in `src/domain/schemas.ts`) is the validation boundary for every public renderer. `formatMarkdown`, `formatTerminal` and `serializeJson` all call `parseDisplayEnvelope`, which calls `ReportEnvelopeSchema.parse`. That boundary currently accepts two contradictory report shapes that the analyzer itself never produces:

1. **An estimate whose review projection is unavailable.** The four aggregate line counts in `analysis.estimationScope` can be `unavailable` while `estimate` or `fullScopeEstimate` still holds a priced result. The documented contract (`docs/dependency-reuse.md:31`) says that "if a projection cannot be completed … no estimate is produced even with `--allow-partial`."
2. **Measured aggregate counts with no per-file provenance rows.** When `analysis.dependencyReuse.files` is an empty array, the per-file/aggregate consistency check is skipped entirely. Deleting every row therefore removes the numeric provenance without rejection.

A reviewer reproduced both by mutating a real envelope in memory. Both validated, and Markdown rendered the contradictory report. After this plan, those shapes are rejected while every report the analyzer actually produces still validates.

## Current state

Files involved:

- `src/domain/schemas.ts`: Zod schemas and cross-field refinements for all public DTOs. The only production file this plan changes.
  - `validateEstimationScope` (starts line 789): checks the scope partition and aggregate counts.
  - `validateDependencyReuse` (starts line 894): checks per-file reuse rows against the scope.
  - `ReportEnvelopeSchema` (starts line 1044): envelope-level refinements (status vs. estimate rules).
- `src/application/estimation-scope.ts:158`: `buildEstimationScopeAnalysis`, the producer of `estimationScope`. Read only; do not change.
- `src/application/dependency-reuse/project.ts:192`: `buildDependencyReuse`, the producer of `dependencyReuse`. Read only; do not change.
- `src/application/analyze.ts:615-715`: the analyzer. If `projectReview` throws `ProjectionUnavailableError`, `projection` stays `null` and no estimate is computed. Read only; do not change.
- `test/integration/estimation-scope.test.ts`: the integration suite that analyzes a synthetic flattened file through `analyzeProject`. New tests go here.
- `docs/dependency-reuse.md`: user-facing policy document. It gets one added sentence.

### What the producer guarantees (these facts are why the new rules are safe)

`src/application/estimation-scope.ts:158-176`: the counts are all `counted(projection?.…)`, so they are all measured exactly when `projection !== null`:

```ts
export function buildEstimationScopeAnalysis(input: ScopeAnalysisInput): EstimationScopeAnalysis {
  const { dispositions, projection } = input;
  ...
  const projected = projection !== null;
  return {
    ...
    requestedScopeComplete:
      projected && (dispositions.mode === 'contracts' || input.requiredAnalysisComplete),
    rawSourceLines: counted(projection?.rawSourceLines),
    reviewSourceLines: counted(projection?.reviewSourceLines),
    reusedSourceLines: counted(projection?.reusedSourceLines),
    outOfScopeSourceLines: counted(projection?.outOfScopeSourceLines),
  };
}
```

`src/application/dependency-reuse/project.ts:186-212`: per-file rows exist **only** when the projection completed, and then there is one row per projected file:

```ts
/**
 * Public provenance of content recognition. Per-file line rows exist only for completed numeric
 * projections of eligible files; failed or unprojected files never appear as zeros. ...
 */
export function buildDependencyReuse(input: DependencyReuseInput): DependencyReuse {
  ...
  const files: DependencyReuse['files'][number][] = [];
  if (input.projection !== null) {
    for (const [fileId, row] of [...input.projection.files].sort(...)) {
      ...
      files.push({ fileId, recognitionStatus: ..., rawSourceLines: row.rawSourceLines, ... });
    }
  }
```

`src/application/analyze.ts:572,619`: the projection is built from exactly the files in `completeness.analyzedFileIds` (`const eligibleFileIds = new Set<FileId>(completeness.analyzedFileIds);`), and `projectReview` emits one row per input file or throws. So with a measured projection, `dependencyReuse.files.length === analysis.completeness.analyzedFileIds.length`.

`src/application/analyze.ts:689-698`: no estimate without a projection:

```ts
        if (projection === null) {
          // The requested view could not be proven; never fall back to a wider scope.
          diagnostics.push(fixedDiagnostic('PARTIAL_ANALYSIS', 'warning', 'estimate',
              'No estimate was produced because the requested review scope could not be projected.'));
        } else {
          estimate = estimateEffort(buildEstimateInput({ ... }));
        }
```

### The gaps (current code)

`src/domain/schemas.ts:830-840` in `validateEstimationScope`: with all counts unavailable, it only checks `requestedScopeComplete` and returns. It has no access to the estimate:

```ts
  const measuredCounts = counts.filter((item) => item.status === 'measured').length;
  if (measuredCounts !== 0 && measuredCounts !== counts.length) {
    reject('Aggregate line counts must be all measured or all unavailable');
    return;
  }
  if (measuredCounts === 0) {
    if (scope.requestedScopeComplete) reject('Unavailable projection cannot be complete');
    return;
  }
```

`src/domain/schemas.ts:979-996`, at the end of `validateDependencyReuse`: the `reuse.files.length > 0 &&` guard skips the whole check when the rows are deleted:

```ts
  if (reuse.files.length > 0 && scope.rawSourceLines.status === 'measured') {
    const complete = reuse.files.length === analyzed.size;
    const aggregates = [
      scope.rawSourceLines,
      scope.reviewSourceLines,
      scope.reusedSourceLines,
      scope.outOfScopeSourceLines,
    ].map((item) => (item.status === 'measured' ? item.value : -1));
    if (
      !complete ||
      aggregates[0] !== raw ||
      aggregates[1] !== review ||
      aggregates[2] !== reused ||
      aggregates[3] !== outOfScope
    ) {
      reject('Per-file rows must sum to the aggregate line counts');
    }
  }
}
```

`src/domain/schemas.ts:1064-1150`: the `ReportEnvelopeSchema` `.superRefine((report, context) => { ... })` block. Every rule there has this shape (excerpt, lines 1121-1130):

```ts
    if (
      report.command !== 'inspect' &&
      report.status === 'complete' &&
      report.analysis?.estimationScope?.scopeNarrowed === true
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A narrowed estimation scope cannot produce a complete report',
      });
    }
```

### Compatibility constraints you must preserve

- `estimationScope` and `dependencyReuse` are **optional** on `AnalysisSchema`. Older fixtures and goldens have neither and must still validate. Every new rule must apply only when that metadata is present.
- A valid typed projection failure must still validate: counts unavailable, `requestedScopeComplete: false`, `estimate: null`, `fullScopeEstimate: null`, `dependencyReuse.files: []`, `status: 'partial'` (estimate) or `'complete'` (inspect). The existing integration test `keeps the partition, drops the estimate and counts when projection is unavailable` (`test/integration/estimation-scope.test.ts:535`) produces exactly this through `analyze()`. Its helper (line 101-113) calls `ReportEnvelopeSchema.parse(outcome.envelope)`, so it acts as the positive control automatically.
- Zod `superRefine` logic is not emitted into JSON Schema. `schemas/result-v1.schema.json` must therefore stay byte-identical (`pnpm schemas:check` passes unchanged).

### Conventions

- Refinement messages are short imperative sentences in the existing style ("Per-file rows must sum to the aggregate line counts").
- Use `context.addIssue({ code: 'custom', message })` in the envelope refinement and the local `reject(message)` closures in the analysis validators, as the surrounding code does.
- Strict TypeScript: no `any`, no non-null assertions beyond the patterns already in this file (it uses `?? 0` / `?.`).

## Commands you will need

The reviewer's environment needed `--config.verifyDepsBeforeRun=false` to stop pnpm from installing implicitly. If a plain `pnpm <script>` tries to install, prefix it as `pnpm --config.verifyDepsBeforeRun=false <script>`.

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Format check | `pnpm format:check` | exit 0 |
| Targeted integration test | `pnpm test:integration test/integration/estimation-scope.test.ts` | fresh build, then all tests in the file pass |
| Unit tests | `pnpm test` | all pass (621+ tests) |
| Full local gate | `pnpm check` | exit 0 |

Do not run `pnpm format` (it mutates files) unless `pnpm format:check` fails on lines you wrote. In that case run it, then confirm `git status` shows only in-scope files changed.

## Scope

**In scope** (the only files you should modify):

- `src/domain/schemas.ts`: `validateDependencyReuse` and the `ReportEnvelopeSchema` refinement only.
- `test/integration/estimation-scope.test.ts`: add one `describe` block.
- `docs/dependency-reuse.md`: add one sentence to the paragraph at line 31.
- `plans/README.md`: status row only.

**Out of scope** (do NOT touch):

- `src/application/**`: the producers are already correct. Changing them would hide, not fix, the validation gap.
- `src/reporting/**`: the renderers already delegate to `ReportEnvelopeSchema`, so fixing the schema fixes them.
- `schemas/*.json`: generated. They must not change.
- `docs/model/heuristic-v1.md`: frozen specification. Never edit.
- `validateEstimationScope`'s existing rules: keep them. The new "no estimate" rule belongs at the envelope level, because `AnalysisSchema` cannot see the estimate.
- Any rule that would require `estimationScope`/`dependencyReuse` to be present.

## Git workflow

- Branch: `advisor/018-projection-report-invariants`, from `estimation_scope`.
- Conventional-commit messages, matching the repo (e.g. `feat: apply content-matched dependency reuse with report provenance`). Use: `fix: reject contradictory projection metadata in report validation`.
- Do NOT push, merge or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing negative tests first

In `test/integration/estimation-scope.test.ts`, add the following imports alongside the existing ones (keep import grouping and ordering consistent with the file):

```ts
import { formatMarkdown, formatTerminal, serializeJson } from '../../src/index.ts';
```

If `src/index.ts` does not export all three (check `grep -n "formatMarkdown\|formatTerminal\|serializeJson" src/index.ts`; at planning time lines 43-46 export them), STOP.

Append a new `describe('projection invariants at the report boundary', ...)` block at the end of the file. Use the existing `withProject`, `analyze`, `FLATTENED` and `TOKEN` helpers defined at the top of the file. Do not create new fixture files. Build each mutated envelope with `structuredClone(envelope)` so no case leaks into another.

Get a valid baseline from `const { envelope } = await analyze(root);`. This is whole-scope mode, `status: 'complete'`, measured counts, one per-file reuse row for `Flattened.sol`, and a non-null `estimate`. Assert the baseline has `envelope.estimate !== null` and `envelope.analysis?.dependencyReuse?.files.length === 1` before mutating, so the test fails loudly if the fixture changes.

Write these cases. Each asserts `ReportEnvelopeSchema.safeParse(mutated).success === false`:

1. **Estimate with unavailable projection.** Set all four `analysis.estimationScope.*SourceLines` to `{ status: 'unavailable', reason: 'no projection' }`, set `requestedScopeComplete: false`, and set `analysis.dependencyReuse.files = []`. Keep `estimate` and `fullScopeEstimate`. This is the reviewer's exact reproduction.
2. **Full-scope estimate only with unavailable projection.** Same as case 1, but also set `estimate: null` and keep `fullScopeEstimate`. (The envelope rules may reject this for more than one reason. It must simply be rejected.)
3. **Measured counts with every per-file row deleted.** Starting from the unmodified baseline, set only `analysis.dependencyReuse.files = []`.
4. **Per-file rows without a completed projection.** Starting from the baseline: set the four counts unavailable, set `requestedScopeComplete: false`, set `estimate` and `fullScopeEstimate` to `null`, set `status: 'partial'`, and **keep** the per-file row.

Add renderer assertions for case 1: `expect(() => formatMarkdown(mutated)).toThrow()`, and the same for `formatTerminal(mutated)` and `serializeJson(mutated)`.

Add positive controls, each asserting `ReportEnvelopeSchema.safeParse(x).success === true`:

- (a) the unmodified baseline;
- (b) a metadata-absent copy of the baseline: `delete analysis.estimationScope` **and** `delete analysis.dependencyReuse` (reuse without scope is already rejected by design, so remove both). Use a typed clone and the `delete` operator on the optional properties. If the type system rejects `delete` on a `readonly` property, construct the copy with object rest destructuring instead;
- (c) the typed projection-failure path, re-created exactly like the existing test at line 535: set `hooks.project` to throw `new ProjectionUnavailableError()`, then call `analyze(root, { estimationScope: TOKEN, allowPartial: true })` and also `analyze(root, { command: 'inspect', estimationScope: TOKEN })`. Reset `hooks.project = undefined` in `finally`. Both must validate, because `analyze` already calls `ReportEnvelopeSchema.parse`.

The type of a mutated envelope: declare `const mutated = structuredClone(envelope) as ReportEnvelope;` and mutate through a local mutable alias if needed. If the readonly DTO types block assignment, build each case with spread objects instead (`{ ...envelope, analysis: { ...analysis, estimationScope: { ...scope, ...changes } } }`). That is the pattern `test/unit/estimation-scope.test.ts:952-953` uses (`mutate(...)`).

**Verify**: `pnpm test:integration test/integration/estimation-scope.test.ts` → negative cases 1, 3 and 4 FAIL (the schema accepts them today). Case 2 may also fail. Positive controls pass. Record which cases failed. If case 1 or 3 passes before any source change, STOP: the gap is not where this plan says.

### Step 2: Require complete per-file rows whenever the projection is measured

In `src/domain/schemas.ts`, `validateDependencyReuse`, replace the guard

```ts
  if (reuse.files.length > 0 && scope.rawSourceLines.status === 'measured') {
```

with

```ts
  if (scope.rawSourceLines.status === 'measured') {
```

Leave the body unchanged. `complete` (`reuse.files.length === analyzed.size`) now rejects an empty row array whenever at least one file was analyzed. An analysis with zero analyzed files and zero rows still passes, because `0 === 0` and all sums are 0.

Directly after that `if` block (still inside `validateDependencyReuse`), add the converse rule:

```ts
  if (scope.rawSourceLines.status !== 'measured' && reuse.files.length > 0) {
    reject('Per-file rows require a completed review projection');
  }
```

`validateEstimationScope` has already rejected mixed measured/unavailable counts, so checking `rawSourceLines` alone is sufficient here. That is the same assumption the existing code makes.

**Verify**: `pnpm typecheck` → exit 0. `pnpm test:integration test/integration/estimation-scope.test.ts` → cases 3 and 4 now pass. Case 1 may still fail.

### Step 3: Forbid estimates when the projection is unavailable

In `src/domain/schemas.ts`, inside the `ReportEnvelopeSchema` `.superRefine((report, context) => { ... })`, add a rule after the existing `scopeNarrowed` rule (the one whose message is `'A narrowed estimation scope cannot produce a complete report'`):

```ts
    const projectionScope = report.analysis?.estimationScope;
    if (
      projectionScope !== undefined &&
      [
        projectionScope.rawSourceLines,
        projectionScope.reviewSourceLines,
        projectionScope.reusedSourceLines,
        projectionScope.outOfScopeSourceLines,
      ].some((item) => item.status !== 'measured') &&
      (report.estimate !== null || report.fullScopeEstimate !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An unavailable review projection cannot carry an estimate',
      });
    }
```

Use `.some(...)` (any count unavailable), not only `rawSourceLines`, so the rule holds even if the mixed-state rule is ever relaxed.

**Verify**: `pnpm typecheck` → exit 0. `pnpm test:integration test/integration/estimation-scope.test.ts` → every test in the file passes, including all four negative cases, the renderer throws and the three positive controls.

### Step 4: Document the enforced invariant

In `docs/dependency-reuse.md`, at the end of the paragraph that begins `` `analysis.estimationScope` is present in every non-error analysis. `` (line 31 at planning time), append this sentence:

> Report validation enforces this: an envelope whose aggregate counts are unavailable cannot carry an estimate or per-file rows, and measured counts require one per-file row for every analyzed file.

**Verify**: `pnpm docs:check` → exit 0.

### Step 5: Full regression

**Verify**, all in order:

- `pnpm typecheck` → exit 0
- `pnpm lint` → exit 0
- `pnpm format:check` → exit 0
- `pnpm test` → all unit tests pass (at least 621, with no previously passing test now failing)
- `pnpm check` → exit 0. It runs typecheck, lint, format, boundaries, unit and integration tests, and the schema check. The schema check must show no change to `schemas/`.
- `git status --short` → only the in-scope files are modified.

If any existing test that you did not write now fails validation, read its envelope. If it is a producer-generated report, a new rule is wrong: STOP. If it is a hand-built fixture that encodes one of the contradictions, STOP and report the file and line rather than editing it.

## Test plan

- New `describe('projection invariants at the report boundary')` in `test/integration/estimation-scope.test.ts`, with four negative cases, three renderer throw assertions and three positive controls (valid baseline, metadata-absent, typed projection failure for estimate and inspect).
- Structural patterns: `test/integration/estimation-scope.test.ts:535-571` (projection-failure hook and `analyze` helper) and `test/unit/estimation-scope.test.ts:909-971` (the `mutate(...)` style of schema negative tests).
- Verification: `pnpm test:integration test/integration/estimation-scope.test.ts` → all pass. `pnpm check` → exit 0.

## Done criteria

- [ ] `pnpm check` exits 0
- [ ] `grep -n "reuse.files.length > 0 && scope.rawSourceLines" src/domain/schemas.ts` returns nothing
- [ ] `grep -n "An unavailable review projection cannot carry an estimate" src/domain/schemas.ts` returns one line
- [ ] `grep -n "Per-file rows require a completed review projection" src/domain/schemas.ts` returns one line
- [ ] `grep -n "projection invariants at the report boundary" test/integration/estimation-scope.test.ts` returns one line
- [ ] `git diff --stat -- schemas/` is empty
- [ ] `git status --short` lists only `src/domain/schemas.ts`, `test/integration/estimation-scope.test.ts`, `docs/dependency-reuse.md` and `plans/README.md`
- [ ] `plans/README.md` row 018 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" don't match the live code (drift).
- Negative case 1 or 3 already fails validation before Step 2 (the gap is elsewhere or was fixed).
- Any producer-generated envelope in an existing test (one that comes from `analyzeProject`, the CLI or a golden file) fails the new rules. That would mean the producer violates the invariant, which is a separate bug to report, not to patch around.
- `pnpm schemas:check` (inside `pnpm check`) reports a changed generated schema.
- The fix seems to require changing `src/application/**` or `src/reporting/**`.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Any future producer path that emits an estimate must also emit a measured projection. If an "estimate despite partial projection" mode is ever wanted, it must be a deliberate, documented contract change that edits these refinements, not a workaround.
- If per-file rows are ever made optional (e.g. a summary-only report mode), Step 2's completeness rule must be revisited together with `buildDependencyReuse`.
- Reviewer focus: the new rules are gated on metadata presence (metadata-absent compatibility), and the typed failure path still validates for both `estimate` and `inspect`.
- Direction work (a scope-selection export or a ledger-comparison report) that adds new output paths should land after this plan so those paths inherit these checks.
