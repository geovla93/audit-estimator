# Plan 006: Integrate version-aware Slang parsing in a bounded trusted subprocess

> **Executor instructions:** Implement the adapter/isolation boundary, not final metrics or graphs. Run each gate. Update status 006 in `plans/README.md`. Slang objects stay inside the parser process.
>
> **Drift check first:** No planned-at SHA exists. Verify completed 002 capability matrix, 003 domain and 005 safe snapshots. If Git exists inspect `git status --short` and `git diff --stat -- tsdown.config.ts src/parser test/unit/parser-version.test.ts test/integration/parser-worker.test.ts`. Stop on API mismatch or a different existing parser strategy.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH (sync parser failure, language/version correctness)
- **Depends on:** `plans/002-slang-compatibility-spike.md`, `plans/003-domain-contracts-schemas.md`, `plans/005-safe-source-discovery.md`
- **Category:** direction / security
- **Planned at:** no commit available; greenfield non-Git directory inspected 2026-10-14

## Why this matters

Synchronous parsing cannot be interrupted with a same-thread Promise timeout. A fixed analyzer-owned subprocess makes cancellation/deadlines real and contains parser crashes while returning clear per-file failures. Version selection and source ranges must be reproducible before metrics use them.

## Current state and architectural context

No production adapter existed during planning. Expect exact-pinned Slang from 002, plain DTOs from 003 and safe `SourceSnapshot` reads from 005. The parent alone reads the filesystem. The child receives bounded strings/IDs/settings over validated IPC and never discovers source files or executes project scripts. Import/binding compilation later uses an in-memory snapshot map. Do not expose CST/AST/cursor objects publicly.

Source references: [version inference](https://nomicfoundation.github.io/slang/latest/user-guide/04-getting-started/02-choosing-a-solidity-version/), [syntax errors](https://nomicfoundation.github.io/slang/latest/user-guide/05-syntax-trees/02-handling-syntax-errors/), [WASM memory](https://nomicfoundation.github.io/slang/latest/user-guide/09-appendix/02-slang-memory-management/). The actual API names/ranges must match 002 evidence. Exact version grammar support is queried from the installed package, not a hardcoded current compiler release.

## Commands you will need

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Proposed prerequisite scripts; not verified at planning.

| Purpose | Command | Expected |
|---|---|---|
| Version policy | `pnpm exec vitest run test/unit/parser-version.test.ts` | exact/inferred/mixed version cases pass |
| Child/adapter | `pnpm build` then `pnpm exec vitest run test/integration/parser-worker.test.ts` | built ESM worker and termination cases pass |
| Parser evidence regression | `pnpm exec vitest run test/research/slang-spike.test.ts` | 0 |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm schemas:check` | 0 |

## Scope

**In scope:** `tsdown.config.ts` (worker entry/output only), `src/parser/{adapter,protocol,worker,version-policy,extract-syntax,ranges}.ts`, `test/unit/parser-version.test.ts`, `test/integration/parser-worker.test.ts`, `test/helpers/parser-child.ts`, `test/fixtures/parser/**`, `test/fixtures/manifest.json`, `docs/adr/005-parser-boundary.md`, 006 status row.

**Out of scope:** CLI wiring, input discovery changes, graph/type inference, final metric calculations, compiler execution or downloads, fallback parsers, custom executable locations or worker paths from config.

## Git workflow

Use the supplied checkout. No commits, pushes, branch changes or publication without operator instruction.

## Steps

### Step 1: Implement deterministic grammar selection and honest errors

`selectLanguageVersion(source, explicitVersion, metadataHint, supportedVersions)` uses Slang's pragma inference; avoid regex pragma extraction. Explicit exact estimator/CLI version must be supported and compatible with all file pragmas; conflict is an analysis diagnostic and no AST effort. Exact valid Foundry version is a hint, used if supported/compatible; invalid hint warns and deterministic inferred selection proceeds. Otherwise choose the highest installed supported pragma-compatible grammar; no pragma chooses installed latest with warning. No candidate produces LANGUAGE_UNSUPPORTED. Do not retry arbitrary versions until something parses or silently ignore pragmas.

Record selected grammar, provenance, pragma constraints and supported-set/parser version. Syntactic parsing is per file. Later binding chooses a common grammar for an import component and records it separately; syntax metrics remain attributed to each file's original selected grammar. If component intersection is empty, preserve syntactic metrics and mark semantics unavailable. Tests must show how no pragma, multiple pragmas and unsupported future versions behave.

**Verify:** `pnpm exec vitest run test/unit/parser-version.test.ts` → 0, deterministic version/provenance and failure assertions.

### Step 2: Define and validate bounded IPC jobs/results

Expose `analyzeSources` plus an internal trusted worker runner. Parent validates source byte totals, limits, IDs and job type; child validates messages again. Job kinds `parse-file` and reserved `semantic-component` contain plain immutable snapshots; no arbitrary module/executable path or callback source. Include a deterministic request counter internal to IPC, not public output. Bound result arrays/token/events/source-range lengths, expected file IDs and numeric counts before accepting results. Unexpected child replies become INTERNAL_ERROR, not silently discarded success.

`extract-syntax.ts` converts valid CST/AST into normalized declaration/import/token/event records. Keep AST knowledge in this adapter; the later `src/metrics` module consumes plain records. Token records distinguish trivia/comments/strings/keywords/operators with byte ranges. Declaration records include owner/ranges/kind/attributes/body; imports retain source literal and alias forms. Invalid trees return diagnostics and physical source information only, not recovered structural metrics. 007 extends event coverage without exporting Slang handles.

**Verify:** `pnpm exec vitest run test/integration/parser-worker.test.ts -t 'protocol and records'` and `pnpm typecheck` → 0, malformed IPC and oversized replies rejected, valid declarations/imports/ranges round-trip as JSON.

### Step 3: Spawn only the fixed built ESM worker and enforce deadlines

Add `src/parser/worker.ts` as an explicit tsdown entry preserving `dist/parser/worker.js` alongside the existing library/CLI entries. Keep Slang external and verify its WASM resolves from the installed dependency. Validate worker URL resolution from the emitted bundle rather than assuming unbundled source paths. Use `child_process.fork`/`process.execPath` for the package-owned `dist/parser/worker.js`, resolved relative to `import.meta.url`, with `shell:false`, cwd independent of analyzed project and sanitized environment. Do not inherit loader flags or NODE_OPTIONS into the child; use a fixed safe execArgv (e.g. JS heap guard) and no target-supplied process options. Do not mutate the parent environment. In tests compile trusted helpers explicitly rather than running TypeScript through target loaders.

Default one child at a time; per-file deadline 2,000 ms, semantic job 10,000 ms and full application budget 120,000 ms. Parent-owned real timer kills the child on expiry/cancel, waits for exit, clears timers/listeners, and converts termination to LIMIT_EXCEEDED/analysis partial. Replace dead workers only for remaining independent jobs within the total budget; no infinite retries. Recycle after bounded batches (e.g. 32 files or 8 MiB) to release WASM memory; semantic components own a disposable child. Node JS heap limits are not hard external-memory caps; document OS sandbox need for stronger resource isolation.

**Verify:** `pnpm build` and `pnpm exec vitest run test/integration/parser-worker.test.ts -t 'isolation and deadlines'` → 0, stalled trusted child killed, cancellation/error paths close resources, child crash does not crash test parent.

### Step 4: Handle ranges, malformed sources and traversal budgets

Convert Slang coordinates using verified UTF-8/UTF-16 mapping; count BOM bytes explicitly and do not splice source before parsing without offset compensation. Enforce AST node caps during iterative traversal (200,000/file, 2,000,000/session), not only after conversion; avoid recursive visitors prone to JS stack overflow. Keep parent deadlines effective while child is traversing. Deterministic ordered diagnostics include stable codes/ranges without reproducing source in messages. Encoding errors should already come from safe reads, but IPC rejects inconsistent bytes/text claims.

**Verify:** `pnpm exec vitest run test/integration/parser-worker.test.ts` → 0 for Unicode/BOM/CRLF, deeply nested, malformed, empty and unsupported source; spike regression, standards and schemas → 0.

## Test plan

Use 002 fixtures and hand assertions; test plain built worker rather than Vitest-only module behavior. Exercise mixed grammars, erroneous pragmas, timeouts using trusted stalled helper, crashes, malformed IPC, output-size/node limits, worker disposal and absence of target configuration execution. Don't claim parser success means Solidity compiles or binds correctly.

## Done criteria

- [ ] Version/worker/spike suites and type/lint/build/full/schema gates exit 0.
- [ ] Successful public output contains only normalized plain records and recorded parser/grammar versions.
- [ ] Invalid scoped files never receive AST metric success; deadlines interrupt actual child work.
- [ ] Package-owned worker path works under built ESM independent of target cwd.
- [ ] All edits scoped; status 006 updated with measured API/limitation evidence.

## STOP conditions

Stop if installed API differs from 002, package worker/WASM loading needs unsafe bundling/target scripts, true cancellation cannot terminate the child on a supported OS, range conversion loses evidence fidelity, node limits require unconstrained recursion, or a gate fails twice. Do not replace isolation with Promise.race or advertise a heap cap as a full memory sandbox.

## Maintenance notes

Retest packed worker paths in 015 and every packaging change. Review Slang minor/patch changes against range and node fixtures. Preserve error codes and IPC bounds as new job types are added; never serialize arbitrary parser objects to simplify implementation.
