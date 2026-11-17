# Plan 003: Build semantic import lookups once per relationship analysis

> **Executor instructions:** Follow the steps, run their verification commands, and honor STOP conditions. Update this plan's row in `plans/README.md` unless a dispatching reviewer owns the index.
>
> **Drift check:** Run `git diff --stat 1e61ad0..HEAD -- src/relationships/closure.ts src/relationships/lookups.ts test/unit/relationship-lookups.test.ts test/integration/relationships.test.ts` and inspect uncommitted changes. Compare the excerpts below and stop for unexpected drift. Catalog/documentation changes from other plans are expected outside this scope.

## Status

- **Priority:** P2
- **Effort:** M (roughly a day with regression coverage)
- **Risk:** MED — incorrect partitioning or ordering could change semantic binding.
- **Depends on:** none for implementation; full repository gates require the existing catalog/docs drift to be fixed, normally by plans 001 and 002
- **Category:** perf
- **Planned at:** commit `1e61ad0`, 2026-11-17

## Why this matters

Relationship analysis scans every import observation for every available semantic component. The cost is O(C × I), where C is the number of available components and I is the total import count, even when most imports belong elsewhere. Replace that repeated scan with one shared index while keeping each job's lookup contents and order exactly equal to the existing filter. This plan makes no measured wall-clock speedup claim: parser-worker startup may still dominate small or highly disconnected projects.

## Current state

- `src/relationships/closure.ts:973` obtains deterministic component plans from `planComponents`.
- `src/relationships/closure.ts:989–1023` processes each plan. The relevant current code is:

  ```ts
  for (const plan of plans) {
    let status: ComponentObservation['status'] = plan.status;
    let reason: ComponentObservation['reason'] = plan.reason;
    if (plan.status === 'available' && plan.grammar !== null) {
      const memberSet = new Set<FileId>(plan.members);
      const members: SemanticComponentMember[] = [];
      for (const memberId of plan.members) {
        const source = sourceById.get(memberId);
        const syntax = syntaxById.get(memberId);
        if (source === undefined || syntax?.status !== 'parsed') {
          throw new TypeError('A planned component member has no accepted syntax.');
        }
        members.push({ source, syntax });
      }
      const lookups = closure.importObservations.flatMap((item) =>
        memberSet.has(item.importerFileId) &&
        item.status === 'resolved' &&
        item.targetFileId !== null
          ? [
              {
                importerFileId: item.importerFileId,
                importId: item.importId,
                specifier: item.specifier,
                specifierRange: item.specifierRange,
                targetFileId: item.targetFileId,
              },
            ]
          : [],
      );
  ```

  It passes `lookups` to the same session's `analyzeSemanticComponent` immediately afterward.

- `src/relationships/components.ts` defines `ComponentPlan extends ComponentObservation`; plans partition all accepted files, including isolated files. Only plans with `status === 'available'` and non-null grammar receive semantic jobs.
- `src/relationships/types.ts:40` defines `ImportObservation`. Relevant fields are `importerFileId`, `importId`, `specifier`, original-byte `specifierRange`, `status` and nullable `targetFileId`.
- `src/parser/protocol.ts:187` defines the exact transport DTO:

  ```ts
  export interface SemanticImportLookup {
    readonly importerFileId: FileId;
    readonly importId: EdgeId;
    readonly specifier: string;
    readonly specifierRange: SourceRange;
    readonly targetFileId: FileId;
  }
  ```

- `src/parser/adapter.ts:117` accepts `readonly SemanticImportLookup[]`; its existing validation/sorting stays untouched.
- `src/domain/schemas.ts:356,359` allows ceilings of 20,000 files and 200,000 imports. Do not raise them.
- `src/discovery/budget.ts` exposes `checkpoint(forceYield = false)`. A call checks cancellation/deadline; passing `true` also yields to the event loop. A default call yields only after 256 calls, so batching calls every 256 records without forcing a yield would create a much larger effective yield interval.
- `test/unit/relationships.test.ts:118` has `zeroRange` and `fid(path)` fixtures; it also has an import-observation factory and component tests. `test/integration/relationships.test.ts:828` has a relationship-pipeline suite using `withPipeline`, with real syntax/session cleanup and complete/incomplete component assertions.

From `docs/roadmap.md`:

> “Keep local analysis bounded, deterministic and data-only.”

The semantic adapter in ADR 005 requires original-byte lookup identity and validated in-memory imports. Preserve that boundary. Do not resolve new paths, decode specifiers again, deduplicate imports, infer closure or change binding/dispatch semantics.

Match strict TypeScript ESM conventions: named exports, explicit public type annotations, `.ts` imports and `import type`. The internal `src/relationships/components.ts` module is a suitable exemplar; the new helper must not become a public root export.

## Commands you will need

Run from the repository root on Node `>=24.11.0 <25`, with `.node-version` 24.21.0 and pnpm 11.28.4.

| Purpose | Command | Expected result |
| --- | --- | --- |
| Trusted installation | `pnpm install --frozen-lockfile` | Exit 0; no package/lockfile changes |
| Focused source tests | `pnpm test test/unit/relationship-lookups.test.ts test/unit/relationships.test.ts` | New helper tests and existing relationship units pass |
| Typecheck | `pnpm typecheck` | Exit 0 |
| Lint | `pnpm lint` | Exit 0 |
| Non-mutating formatting | `pnpm format:check` | Exit 0 |
| Production boundary | `pnpm boundaries:check` | Exit 0; new internal file is accepted |
| Focused artifact tests | `pnpm test:integration test/integration/relationships.test.ts` | Fresh build, then passing relationship integrations |
| Full regression/local gate | `pnpm check` | All gates pass once catalog/docs drift is fixed |
| Patch hygiene | `git diff --check` | Exit 0 |

## Scope

**Only modify:**

- `src/relationships/lookups.ts` — create the internal indexed helper.
- `src/relationships/closure.ts` — build the index once and replace the per-component scan.
- `test/unit/relationship-lookups.test.ts` — create behavior, work-count and cancellation tests.
- `test/integration/relationships.test.ts` — add one native multi-component regression.
- This plan's status/evidence row in `plans/README.md`.

**Out of scope:** parser/worker/protocol behavior, component partitioning/grammar selection, import resolution, graph allowances, contract/callable scans elsewhere in the module, filesystem access, public exports/schemas, estimates, dependencies, fixtures/goldens and unrelated refactoring. Do not optimize every scan in `closure.ts` while implementing this one.

## Git workflow

Use an isolated task branch such as `advisor/003-index-semantic-import-lookups`. If committing, use `perf: index semantic import lookups once`. Preserve unrelated work and do not merge, push or open a PR without authorization.

## Steps

### Step 1: Establish source/dependency and behavioral baselines

Run the drift check and frozen install. Verify installed direct dependency versions match the manifest by reading `node_modules/<name>/package.json` for each dependency and dev dependency; the advisor found a stale installed tree, so a passing pre-install suite is insufficient. Read the current plan loop, `ComponentPlan`, `ImportObservation`, `SemanticImportLookup`, budget checkpoint and existing test helpers.

Run `pnpm test test/unit/relationships.test.ts` and `pnpm test:integration test/integration/relationships.test.ts` before editing. Existing catalog and documentation failures may block the later full gate, but must not be hidden with stale dependencies or modified assertions.

**Verify:** Both focused suites pass on the locked dependency set. Record unrelated baseline failures separately; stop if they prevent verifying relationship behavior.

### Step 2: Add one indexed, checkpointed helper and its behavioral tests

Create `src/relationships/lookups.ts` with a named, explicitly annotated async export shaped as:

```ts
export async function buildComponentImportLookups(
  plans: readonly ComponentPlan[],
  observations: readonly ImportObservation[],
  checkpoint: () => Promise<void>,
): Promise<ReadonlyMap<FileId, readonly SemanticImportLookup[]>>
```

Import these types from their existing internal modules using type-only `.ts` imports. Algorithm:

1. Await `checkpoint()` before work.
2. Traverse plans once. For available plans with non-null grammar, create an empty lookup array keyed by `plan.id` and map each member file ID to that component ID. Do not retain unavailable plans in the lookup index.
3. Traverse observations once in their original array order. For a resolved observation with non-null target whose importer belongs to an indexed component, append exactly the five DTO fields shown above to that component's array. Preserve repeated imports, literal ranges and target IDs. Do not sort or deduplicate.
4. Use a single visited-record counter across plan records, member records and observation records. After at most 256 visited records, await the supplied checkpoint. Count skipped/unresolved records too. Await a final checkpoint before returning, including empty/small inputs.
5. Return the readonly-typed map. Do not mutate inputs or catch checkpoint failures. No extra traversal of the complete observation array per component is permitted.

The intended traversal is O(P + M + I), with P plans, M total plan memberships and I observations. Lookup arrays together retain at most I records.

Add tests in `test/unit/relationship-lookups.test.ts` using source imports and the existing `fid`, range and observation fixture patterns as local exemplars. Cover empty plans, available no-import components, mixed available/unavailable/null-grammar plans, unresolved or null-target observations, interleaved component imports, duplicate imports, original range preservation and input immutability. The expected lookup list for each plan must equal the old filter/projection semantics.

**Verify:** `pnpm typecheck` and the focused source test command both exit 0.

### Step 3: Prove bounded traversal and failure propagation

In the new unit file, create many small, disjoint components and an interleaved observation list containing both usable and skipped imports. Instrument observation field reads with typed getter objects, for example a getter for `importerFileId` on a complete `ImportObservation` fixture; increment a test counter before returning its normal value. Increase component count while holding the observation list fixed, and assert a constant-per-observation bound rather than a bound multiplied by component count. Avoid wall-clock assertions and production-only test counters.

For checkpoints, use an injected callback that counts completed batches, and observation/member getters that count visits since the last callback. Assert no batch exceeds 256 records, including many skipped imports and many members before observations begin. Include empty and less-than-256-record cases. Inject sentinel `BudgetError` instances with `cancelled`, `deadline` and `limit` kinds, and assert exact object-identity rejection with no returned partial map. Checkpoints must not be converted into successful partial indexes.

**Verify:** The focused source command exits 0. The work-bound test must distinguish a single observation pass from a per-component rescan; the checkpoint tests must fail if checkpoints are removed or only retained records are counted.

### Step 4: Use the shared index in the real pipeline

In `resolveRelationships`, after `planComponents` and before the component-processing loop, build the index exactly once:

```ts
const lookupsByComponent = await buildComponentImportLookups(
  plans,
  closure.importObservations,
  () => input.budget.checkpoint(true),
);
```

Inside an available plan's existing branch, replace the whole `flatMap` block with `const lookups = lookupsByComponent.get(plan.id) ?? [];`. Remove `memberSet` because it becomes unused. Keep the member-building loop, job order, semantic session call, graph allowance and error/completeness handling unchanged. Each job must receive the same ordered lookup records as before. The `true` is intentional: the helper batches 256 records between callbacks.

**Verify:** Focused source tests, `pnpm typecheck`, `pnpm lint` and `pnpm boundaries:check` pass. `rg -n 'importObservations\.flatMap' src/relationships/closure.ts` returns no matches (exit 1 expected). Review the diff to confirm the helper is called once outside the plan loop.

### Step 5: Verify native multi-component behavior and full regression

Extend the existing `relationship pipeline` suite in `test/integration/relationships.test.ts`, following `withPipeline` and its `finally` cleanup. Create a small synthetic project in memory with two disconnected import-connected groups, each having an importing child and its own base, plus one isolated file and a separate file with an unresolved import. Use distinct paths/names so accidentally assigning another component's imports fails binding or the exact pair assertions. Do not create a large project or benchmark native startup.

Assert exact component memberships, successful semantic status and directed inheritance pairs for both valid groups, availability of the isolated file's component, and the expected unavailable state for the unresolved group. Assert no cross-group pair and that independent valid components survive the incomplete group. Existing tests continue to cover aliases, diamond bases, original-byte BOM/CRLF/escaped literal mapping and deterministic fingerprints.

**Verify:** Run the focused artifact command, `pnpm format:check`, and `pnpm check`. All must pass after the separate catalog/docs drift is fixed. If those prerequisite repairs are not yet present, record the exact known failures and keep this plan IN PROGRESS pending final verification; do not expand this plan's scope to fix them.

## Test plan

New source-only tests go in `test/unit/relationship-lookups.test.ts`; use Vitest `describe`, `it`, `expect` and typed local factories like the existing relationship unit file. Their purpose is semantic equivalence, linear traversal and shared-budget propagation, not mirroring a Map implementation. The single native integration regression belongs in the existing relationship pipeline suite; use original synthetic Solidity data and existing temporary-project cleanup. No new fixtures, package downloads, target execution or timing thresholds are required.

## Done criteria

- [ ] Lookup output equals the previous ordered projection for every covered available component, including repeated imports and original-byte ranges.
- [ ] Source tests prove a constant-per-observation read bound independent of component count and a checkpoint gap no larger than 256 visited records.
- [ ] Cancellation, deadline and limit errors propagate unchanged; no partial index is returned.
- [ ] `resolveRelationships` builds one index outside the plan loop; the old `importObservations.flatMap` scan is absent.
- [ ] Native multi-component regression passes with exact component/pair expectations.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm boundaries:check`, focused unit/integration commands, `pnpm check` and `git diff --check` exit 0.
- [ ] No public contract, fixture/golden or dependency changes; only listed files changed; index status/evidence updated.

## STOP conditions

- Live input types or loop semantics differ from the excerpts, or a file appears in multiple component plans contrary to the current partition contract.
- Preserving job behavior requires protocol, parser, import-resolution, public-schema or component-planning changes.
- A golden/fingerprint changes without a demonstrated unrelated baseline cause; do not update it as part of a performance refactor.
- Meaningful linearity/checkpoint tests require production test seams or elapsed-time thresholds; reassess the test design instead.
- A required command fails twice after a reasonable in-scope attempt, dependency installation fails, or final gates remain blocked by unrelated drift. Report what passed and what remains pending.

## Maintenance notes

The index lifetime is one relationship analysis; do not cache across source revisions or parser sessions. Preserve importer ID plus original-byte literal range identity and the existing adapter's validation. If components later cease to partition files, revisit the index contract explicitly. Other nested scans and worker-startup overhead are separate investigations, not promised improvements from this change.
