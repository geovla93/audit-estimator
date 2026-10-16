# Plan 019: Carry recognition checkpoints across small declarations and token indexing

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report. Do not improvise. When done, update the status row for this plan in `plans/README.md`, unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat d68d466..HEAD -- src/application/dependency-reuse/classify.ts src/application/dependency-reuse/fingerprint.ts test/unit/dependency-reuse.test.ts scripts/generate-dependency-catalog.mjs docs/dependency-reuse.md`
> If any listed file changed since this plan was written, compare the "Current state" excerpts below against the live code before proceeding. On a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED. The digest bytes, the local-allowance atomicity and shared-error propagation must all stay unchanged.
- **Depends on**: none. Independent of plans 018 and 020; recommended after 018.
- **Category**: bug (bounded processing, with tests)
- **Planned at**: commit `d68d466`, 2026-10-16, branch `estimation_scope`

## Why this matters

Dependency recognition hashes every top-level declaration of every eligible Solidity file. Long-running analysis work in this project must call a shared-budget `checkpoint()` regularly. That call is how cancellation (SIGINT/`AbortSignal`), the analysis deadline and shared limits are enforced: it throws a `BudgetError`, and the error propagates. Fingerprinting checkpoints every 256 tokens, **but the counter restarts at zero for each declaration**, and the per-declaration loop in `classifyDependencies` never checkpoints.

A reviewer parsed a real file containing a pragma and 600 empty libraries (4,211 parser tokens). Recognition finished with **exactly one checkpoint**, the one at file start. Building the token index (filter plus sort over every token in the file) is also synchronous and unchecked. A large flattened file made of many small declarations can therefore do substantial work without honoring cancellation or the deadline. After this plan, the 256-record cadence carries across declarations and through index building. Digests, matches and fallback behavior stay byte-for-byte unchanged.

## Current state

Files involved:

- `src/application/dependency-reuse/classify.ts`: `classifyDependencies`, per-file content recognition. Production change here.
- `src/application/dependency-reuse/fingerprint.ts`: token normalizer and hashing helpers (`indexTokens`, `fingerprintDeclaration`, `RecognizerAllowance`, constants). Additive change here.
- `scripts/generate-dependency-catalog.mjs:192,228`: the catalog generator also calls `reuse.indexTokens(...)` and `reuse.fingerprintDeclaration(...)` from the built library. **Their signatures and behavior must not change**, or regenerating the catalog would break or change its digests.
- `test/unit/dependency-reuse.test.ts`: unit tests for fingerprinting and classification. New tests go here.
- `docs/dependency-reuse.md:51`: documents the checkpoint cadence. Gets one added sentence.

### The constants and the per-declaration counter (`fingerprint.ts`)

`src/application/dependency-reuse/fingerprint.ts:10-13`:

```ts
/** Largest byte slice hashed between two checkpoints. */
export const HASH_CHUNK_BYTES: number = 64 * 1024;
/** Records (tokens) processed between two checkpoints. */
export const HASH_RECORD_INTERVAL: number = 256;
```

`src/application/dependency-reuse/fingerprint.ts:67-75`, the synchronous whole-file index:

```ts
/** Indexes sorted token and assembly spans once per file instead of per declaration. */
export function indexTokens(
  tokens: readonly ParserToken[],
  assemblyRanges: readonly SourceRange[],
): TokenIndex {
  const significant = tokens.filter((token) => !TRIVIA_TOKEN_KINDS.has(token.kind));
  significant.sort((left, right) => left.range.startByte - right.range.startByte);
  return { tokens: significant, assembly: mergeIntervals(assemblyRanges) };
}
```

`src/application/dependency-reuse/fingerprint.ts:169-187`. `visited` is local, so a declaration with fewer than 256 tokens never checkpoints:

```ts
export async function fingerprintDeclaration(
  index: TokenIndex,
  originalBytes: Uint8Array,
  target: FingerprintTarget,
  checkpoint: () => Promise<void>,
  allowance?: RecognizerAllowance,
): Promise<Fingerprint> {
  const tokens = tokensWithin(index, target.range);
  allowance?.charge(tokens.length, 0);
  ...
  let visited = 0;
  for (const token of tokens) {
    visited += 1;
    if (visited % HASH_RECORD_INTERVAL === 0) await checkpoint();
```

It returns `{ digest, tokenCount: tokens.length }`.

### The classification loop (`classify.ts`)

`src/application/dependency-reuse/classify.ts:119-148`:

```ts
  for (const file of input.files) {
    await input.checkpoint();
    ...
    const allowance = new RecognizerAllowance(
      input.maxTokensPerFile ?? MAX_RECOGNIZER_TOKENS_PER_FILE,
      input.maxBytesPerFile ?? MAX_RECOGNIZER_BYTES_PER_FILE,
    );
    const matches: DependencyMatch[] = [];
    try {
      const index = indexTokens(
        result.tokens,
        result.events.filter((event) => event.kind === 'assembly').map((event) => event.range),
      );
      for (const contract of file.metrics.contracts) {
        const fingerprint = await fingerprintDeclaration(
          index,
          file.source.snapshot.originalBytes,
          { kind: contract.kind, name: contract.name, range: contract.range },
          input.checkpoint,
          allowance,
        );
        const candidates = byDigest.get(fingerprint.digest);
        if (candidates === undefined) continue;
        ...
      }
    } catch (error: unknown) {
      if (!(error instanceof RecognizerLimitError)) throw error;
      states.set(fileId, { status: 'unavailable', reason: REASON_ALLOWANCE });
      continue;
    }
```

Note the `continue` statements inside the declaration loop (no candidates, or no compatible reference). Any per-declaration accounting must run **before** them.

### Invariants you must preserve

- **Digests:** the bytes fed to SHA-256 must not change. `fingerprintDeclaration` stays untouched. The oracle `TINY_DIGEST = '7e69f…dc8d'` (`test/unit/dependency-reuse.test.ts:319`) and the documented digest input at `docs/dependency-reuse.md:51` must keep passing.
- **Local allowance atomicity:** a `RecognizerLimitError` anywhere in a file discards all its provisional matches and marks the file `unavailable` with `REASON_ALLOWANCE` (test `falls back atomically when only the local allowance is exhausted`, line ~632).
- **Shared failures propagate unchanged:** any error thrown by `input.checkpoint` (a `BudgetError` of kind `cancelled`, `deadline` or `limit`) must reject `classifyDependencies` with **the same error object**. It must never be converted to a fallback (test `propagates shared cancellation, deadline and limit failures instead of falling back`, line ~647). The existing `catch` rethrows anything that is not `RecognizerLimitError`; keep it that way.
- **Exact existing checkpoint counts in direct `fingerprintDeclaration` tests** (`checkpoints).toBe(3)` at line 256 and `toBe(2)` at line 292). These call `fingerprintDeclaration` directly, so they stay valid because that function is unchanged. Do not edit them.
- `indexTokens` keeps its exact signature and output; the catalog generator uses it.

### Conventions

- Strict TypeScript with `isolatedDeclarations`: every exported function, class member and constructor parameter needs an explicit type annotation. Private state uses `#field` (see `RecognizerAllowance`, `fingerprint.ts:26-40`). Match that class style exactly.
- JSDoc one-liners above exported symbols, in the existing voice.
- Import with `.ts` extensions; use `import type` for types only.

## Commands you will need

If a plain `pnpm <script>` tries to install dependencies, prefix it as `pnpm --config.verifyDepsBeforeRun=false <script>`.

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Format check | `pnpm format:check` | exit 0 |
| Targeted unit tests | `pnpm test test/unit/dependency-reuse.test.ts` | all pass |
| All unit tests | `pnpm test` | all pass |
| Integration (fresh build) | `pnpm test:integration` | all pass |
| Full local gate | `pnpm check` | exit 0 |

## Scope

**In scope** (the only files you should modify):

- `src/application/dependency-reuse/fingerprint.ts`: **add** `CheckpointPacer` and `indexTokensPaced`. Do not modify existing exports.
- `src/application/dependency-reuse/classify.ts`: use them inside `classifyDependencies`.
- `test/unit/dependency-reuse.test.ts`: add tests.
- `docs/dependency-reuse.md`: one sentence at line 51.
- `plans/README.md`: status row only.

**Out of scope** (do NOT touch):

- `fingerprintDeclaration`, `indexTokens`, `tokensWithin`, `mergeIntervals`, `RecognizerAllowance`, `HASH_RECORD_INTERVAL`, `HASH_CHUNK_BYTES`: behavior and signatures are frozen. Changing them risks catalog/digest drift.
- `scripts/generate-dependency-catalog.mjs` and `src/application/dependency-reuse/catalog.ts` (the bundled catalog): no regeneration.
- `MAX_RECOGNIZER_TOKENS_PER_FILE` / allowance charging. Charging indexing work to the local allowance would change which files fall back. That is a separate policy decision (see Maintenance notes).
- `src/metrics/**`, `src/discovery/budget.ts`, `src/parser/**`.
- `docs/model/heuristic-v1.md`: frozen specification.

## Git workflow

- Branch: `advisor/019-recognition-checkpoint-cadence`, from `estimation_scope`.
- Conventional commits (repo style: `feat: content fingerprints and seeded reference catalog for dependency reuse`). Suggested: `test: cover recognition checkpoint cadence across small declarations`, then `fix: carry recognition checkpoints across declarations and indexing`.
- Do NOT push, merge or open a PR unless instructed.

## Steps

### Step 1: Add failing regression tests

In `test/unit/dependency-reuse.test.ts`, inside `describe('catalog classification', ...)` (starts around line 571; it defines the local `classify(target, catalog, checkpoint, limits)` helper), add:

1. `it('checkpoints across many small declarations in one file', ...)`:
   - Build `const empty: readonly Part[] = [['keyword', 'library'], ['identifier', 'Custom'], ['punctuation', '{'], ['punctuation', '}']];`, matching the shape already used in the test `keeps unmatched custom code out of the match list entirely`.
   - `const target = targetWith(TINY, { extra: Array.from({ length: 599 }, () => empty) });` gives 600 declarations of 4 significant tokens each.
   - Count checkpoint calls with a counting callback that resolves.
   - Assert `state.status === 'available'` and that the match list's contract IDs equal `[target.contractId]` (the first declaration is `TINY` and still matches, which proves digests are unchanged).
   - Assert `calls >= 1 + Math.floor((600 * 5) / HASH_RECORD_INTERVAL)`. Each declaration contributes at least `tokenCount + 1 = 5` records, plus the file-start checkpoint.
2. `it('propagates a shared failure raised after the file-start checkpoint across small declarations', ...)`:
   - Same 600-declaration target.
   - `const failure = new BudgetError('cancelled');` and a callback that resolves on the first call and returns `Promise.reject(failure)` from the second call on.
   - `await expect(classify(target, testCatalog(), callback)).rejects.toBe(failure);`

Add `HASH_RECORD_INTERVAL` to the existing import from `'../../src/application/dependency-reuse/fingerprint.ts'` (keep the import list sorted the way it is: constants first, then classes, then functions, matching the current order).

**Verify**: `pnpm test test/unit/dependency-reuse.test.ts` → both new tests FAIL. Test 1 fails on the call-count assertion (expect `calls` to be 1). Test 2 fails because the promise resolves instead of rejecting. All other tests pass. If either new test passes before the source change, STOP.

### Step 2: Add `CheckpointPacer` to `fingerprint.ts`

Directly after the `RecognizerAllowance` class, add:

```ts
/**
 * Carries the record checkpoint cadence across calls, so many small declarations or index batches
 * cannot bypass the interval that a single large declaration observes. Checkpoint failures
 * propagate unchanged.
 */
export class CheckpointPacer {
  readonly #checkpoint: () => Promise<void>;
  readonly #interval: number;
  #pending: number = 0;

  public constructor(checkpoint: () => Promise<void>, interval: number = HASH_RECORD_INTERVAL) {
    this.#checkpoint = checkpoint;
    this.#interval = interval;
  }

  /** Accounts `records` units of work and checkpoints once the interval is reached. */
  public async record(records: number): Promise<void> {
    this.#pending += records;
    if (this.#pending < this.#interval) return;
    this.#pending = 0;
    await this.#checkpoint();
  }
}
```

Adapt the field-declaration syntax only if `pnpm typecheck` or `pnpm lint` requires it (e.g. the linter rejects the redundant `: number`). Keep the behavior identical.

**Verify**: `pnpm typecheck` → exit 0. `pnpm lint` → exit 0.

### Step 3: Add `indexTokensPaced` to `fingerprint.ts`

Directly after `indexTokens`, add an async counterpart with **identical output**:

```ts
/**
 * Bounded counterpart of `indexTokens` with identical output: filtering and the sortedness scan
 * record work with the pacer in batches of `HASH_RECORD_INTERVAL`. Parser tokens normally arrive
 * in source order, so the synchronous sort runs only for out-of-order input.
 */
export async function indexTokensPaced(
  tokens: readonly ParserToken[],
  assemblyRanges: readonly SourceRange[],
  pacer: CheckpointPacer,
): Promise<TokenIndex> {
  const significant: ParserToken[] = [];
  let sorted = true;
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token !== undefined && !TRIVIA_TOKEN_KINDS.has(token.kind)) {
      const previous = significant[significant.length - 1];
      if (previous !== undefined && previous.range.startByte > token.range.startByte) sorted = false;
      significant.push(token);
    }
    if ((at + 1) % HASH_RECORD_INTERVAL === 0) await pacer.record(HASH_RECORD_INTERVAL);
  }
  await pacer.record(tokens.length % HASH_RECORD_INTERVAL);
  if (!sorted) significant.sort((left, right) => left.range.startByte - right.range.startByte);
  return { tokens: significant, assembly: mergeIntervals(assemblyRanges) };
}
```

Why the output is identical: `indexTokens` filters with the same predicate and then calls `Array.prototype.sort` with the same comparator. `sort` is stable, so on an input that is already non-decreasing by `startByte` it is the identity. Skipping it in that case yields the same array contents in the same order.

Add a unit test in the existing `describe` that contains the `indexTokens` usages near lines 91-130 (the fingerprint tests), or a new `describe('paced token index', ...)` placed right after it:

- For a built fixture (`layout(...)` of `TINY` plus a comment token, as the comments test near line 130 does), `expect(await indexTokensPaced(built.tokens, [], new CheckpointPacer(noop))).toEqual(indexTokens(built.tokens, []))`.
- For the same tokens **reversed** (`[...built.tokens].reverse()`), the same equality holds (this exercises the sort branch).
- With a counting pacer callback over at least `2 * HASH_RECORD_INTERVAL + 1` tokens, the callback runs at least twice.

**Verify**: `pnpm test test/unit/dependency-reuse.test.ts` → the new index tests pass. The two Step 1 tests still fail.

### Step 4: Use the pacer in `classifyDependencies`

In `src/application/dependency-reuse/classify.ts`:

1. Update the import from `./fingerprint.ts` to also import `CheckpointPacer` and `indexTokensPaced`. Remove `indexTokens` from the import if it becomes unused (lint will report it).
2. Before the `for (const file of input.files)` loop, create one pacer for the whole call: `const pacer = new CheckpointPacer(input.checkpoint);`. Keep the existing `await input.checkpoint();` at the start of each file.
3. Inside the `try`, replace the synchronous index construction with a paced one. Collect assembly ranges in a paced loop:

   ```ts
      const assembly: SourceRange[] = [];
      for (let at = 0; at < result.events.length; at += 1) {
        const event = result.events[at];
        if (event !== undefined && event.kind === 'assembly') assembly.push(event.range);
        if ((at + 1) % HASH_RECORD_INTERVAL === 0) await pacer.record(HASH_RECORD_INTERVAL);
      }
      const index = await indexTokensPaced(result.tokens, assembly, pacer);
   ```

   (Import `HASH_RECORD_INTERVAL` from `./fingerprint.ts` and `type SourceRange` from `'../../domain/types.ts'` as needed.)
4. Immediately after the `const fingerprint = await fingerprintDeclaration(...)` statement, before `const candidates = ...` and therefore before any `continue`, add:

   ```ts
        await pacer.record(fingerprint.tokenCount + 1);
   ```

   The `+ 1` makes even zero-token declarations count toward the interval.
5. Do not change the `catch` block. Pacer failures come from `input.checkpoint` and must propagate unchanged, exactly like the existing in-hash checkpoints.

Resulting bound (for the reviewer): between two checkpoints, recognition processes at most about `3 × HASH_RECORD_INTERVAL` tokens (pending pacer records, plus one declaration's head and tail around its internal checkpoints), or one 64 KiB byte slice. The one residual unbounded step is the synchronous `sort` for out-of-order token input, which the parser does not normally produce.

**Verify**: `pnpm typecheck` → exit 0. `pnpm lint` → exit 0. `pnpm test test/unit/dependency-reuse.test.ts` → **all** tests pass, including both Step 1 regressions, the atomic-allowance test, the shared-propagation test and the exact-count fingerprint tests at lines ~256 and ~292.

### Step 5: Document the cadence

In `docs/dependency-reuse.md`, the paragraph at line 51 ends with "...with a shared-budget checkpoint between slices and every 256 tokens." Append:

> The 256-record cadence carries across declarations in a file and also covers building the file's token index, so many small declarations cannot skip checkpoints.

**Verify**: `pnpm docs:check` → exit 0.

### Step 6: Full regression, including the real parser and catalog

**Verify**, in order:

- `pnpm format:check` → exit 0
- `pnpm test` → all unit tests pass
- `pnpm test:integration` → fresh build, then all integration tests pass. This includes `test/integration/dependency-reuse.test.ts`, which checks the real parser's `library Tiny {}` digest and the bundled-catalog matches.
- `pnpm check` → exit 0 (includes `schemas:check` and `boundaries:check`)
- `git diff --stat -- src/application/dependency-reuse/catalog.ts scripts/` → empty
- `git status --short` → only in-scope files modified

## Test plan

- `test/unit/dependency-reuse.test.ts`:
  - many-small-declarations checkpoint count (regression for the finding);
  - shared failure after the file-start checkpoint propagates as the same object (regression);
  - `indexTokensPaced` equals `indexTokens` for sorted and reversed input, and its pacer fires on large input;
  - existing tests unchanged: oracle digest, huge-token slicing (exact 3 checkpoints), small-token interval (exact 2), atomic allowance fallback, shared-failure propagation.
- Pattern to follow: `propagates shared cancellation, deadline and limit failures instead of falling back` (line ~647) for counting/rejecting callbacks, and `targetWith(TINY, { extra: [...] })` for multi-declaration fixtures.
- Optional, only if cheap: an integration test in `test/integration/dependency-reuse.test.ts` that parses an original in-memory source with `pragma solidity ^0.8.20;` and 600 `library L<n> {}` declarations through the real worker, then asserts more than one checkpoint. Skip it if it needs new helpers beyond what that file already has.

## Done criteria

- [ ] `pnpm check` exits 0
- [ ] `grep -n "export class CheckpointPacer" src/application/dependency-reuse/fingerprint.ts` → one line
- [ ] `grep -n "export async function indexTokensPaced" src/application/dependency-reuse/fingerprint.ts` → one line
- [ ] `grep -n "pacer.record(fingerprint.tokenCount + 1)" src/application/dependency-reuse/classify.ts` → one line
- [ ] `grep -n "indexTokens(" src/application/dependency-reuse/classify.ts` → no match (classification uses the paced index)
- [ ] `git diff d68d466 -- src/application/dependency-reuse/fingerprint.ts` shows only additions (no `-` lines other than diff headers)
- [ ] `git diff --stat -- src/application/dependency-reuse/catalog.ts scripts/` is empty
- [ ] Only in-scope files modified (`git status --short`)
- [ ] `plans/README.md` row 019 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Live code differs from the "Current state" excerpts.
- Either Step 1 regression passes before the source change.
- Any digest-related test fails (`TINY_DIGEST`, the real-parser digest integration test, the bundled-catalog match tests). That means hashed bytes changed.
- The exact-count tests at lines ~256 / ~292 fail. That means `fingerprintDeclaration` was changed, which is out of scope.
- The fix seems to require changing `fingerprintDeclaration`, `indexTokens`, the catalog or the generator script.
- `targetWith` cannot build 600 declarations (an error or a >5 s test). Report it rather than restructuring the helper. A smaller count such as 300 with the same formula is acceptable if it still makes Step 1's tests fail before the fix.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Any new per-declaration or per-record loop in recognition or projection should take the shared `CheckpointPacer` rather than calling `checkpoint` on a local counter.
- **Deferred:** the token index is still not charged to the local `RecognizerAllowance`. A file whose total tokens exceed the allowance but whose declarations do not currently still succeeds. Charging it would change fallback outcomes, so treat it as a separate, documented policy change.
- **Deferred:** `mergeIntervals` sorts assembly ranges synchronously. Assembly blocks are few in practice.
- Reviewer focus: `fingerprint.ts` is diff-additive only, the pacer call sits before every `continue`, and the `catch` still rethrows non-`RecognizerLimitError` errors.
- `src/application/dependency-reuse/project.ts` (`reviewBuiltin`) has an O(files × call facts) rescan that was deliberately deferred pending profiling. It is not part of this plan.
