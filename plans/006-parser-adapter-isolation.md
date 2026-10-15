# Plan 006: Integrate version-aware Slang parsing in a bounded trusted subprocess

> **Executor instructions:** Implement the internal adapter/isolation boundary, not final metrics, graphs or CLI wiring. Run each gate. Update status 006 in `plans/README.md`. All production Slang execution, including pragma inference, stays inside the timed child; do not manufacture public measurements to fill `SyntaxBatch`.
>
> **Drift check first:** Reviewed at `ba9a136` on 2026-10-15. Run `git status --short`, then `git diff --stat ba9a136..HEAD -- src/parser src/domain src/discovery src/config tsdown.config.ts scripts/test.mjs package.json pnpm-lock.yaml test/unit/parser-version.test.ts test/unit/parser-protocol.test.ts test/unit/parser-ranges.test.ts test/integration/parser-worker.test.ts test/integration/bootstrap-cli.test.ts test/helpers/parser-child.ts test/fixtures/parser test/fixtures/manifest.json test/research docs/adr docs/research/slang-spike.md plans/006-parser-adapter-isolation.md plans/README.md` and the same path-filtered `git diff HEAD -- …` for local changes. Inspect untracked in-scope files too. Some paths are read-only dependencies, not edit permission. Reconcile contradictory contracts or conflicting local edits before implementation.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH (sync parser failure, language/version correctness)
- **Depends on:** `plans/002-slang-compatibility-spike.md`, `plans/003-domain-contracts-schemas.md`, `plans/005-safe-source-discovery.md`
- **Category:** direction / security
- **Execution:** APPROVE, 2026-10-15; reviewed implementation committed as `2a04649` in `/private/tmp/audit-estimator-006-worktree` on `advisor/006-parser-adapter-isolation`, based on `2a3cd54`. See the 006 execution review in `plans/README.md` for independent gates and limitations.
- **Planned at:** commit `ba9a136`, reviewed 2026-10-15; supersedes this plan's `9b0bfe7` reconciliation.

## Why this matters

Synchronous parsing cannot be interrupted with a same-thread Promise timeout. A fixed analyzer-owned subprocess makes cancellation/deadlines real and contains parser crashes while returning clear per-file failures. Version selection and source ranges must be reproducible before metrics use them.

## Current state and architectural context

### Reconciled implementation baseline — 2026-10-15

`src/parser/` is absent. Slang is already pinned to `1.3.9`; research is implemented in `test/research/{slang-spike.test,slang-child,slang-source-view}.ts`. The reviewed report `docs/research/slang-spike.md` records 92 supported grammars (0.4.11 through 0.8.37), candidate alias/overload results, invalid-dependency/mixed-grammar hazards, Unicode-scalar columns and the approved single-leading-BOM view. Query the installed supported set at runtime; these endpoints are evidence for the pin, not a replacement selection table. Production decoding/worker supervision is still new work.

`tsdown.config.ts` currently has only index and bin entries; add the package-owned worker entry here. `SourceSnapshot` uses `originalBytes`, `originalText`, `canonicalPath`, `absolutePath`, `byteHash`; do not rename these fields. `SyntaxBatch` currently contains analyzed file/contract/callable/import arrays, not token/event transport. Put bounded token/declaration/event protocol DTOs in the in-scope `src/parser/protocol.ts`; keep them internal and map to existing public DTOs when metrics are available. Do not extend public schemas merely to serialize parser transport.

`ResolvedConfig.solidity.version` is a required string even for defaults/metadata. Carry its provenance into version selection: a default version is not an explicit CLI/config override. Explicit `cli`/`config` versions constrain grammar; `metadata` is a hint; inferred/no-pragma behavior follows Step 1. The authority comes from `config.provenance` at key `solidity.version`, not solely from the populated string. Plans 001–005 are now merged: HEAD `ba9a136` merges reviewed discovery commit `7a93562`. The index's older statement that 005 is unmerged is superseded for this review; do not wait for another discovery implementation.

### Load-bearing contracts and exemplars

```ts
// src/domain/types.ts:144 — completed metrics, NOT parser transport
export interface SyntaxBatch {
  readonly files: readonly FileAnalysis[];
  readonly contracts: readonly ContractAnalysis[];
  readonly callables: readonly CallableAnalysis[];
  readonly imports: readonly ImportReference[];
}
// src/domain/types.ts:376 — snapshots have no fileId field
export interface SourceSnapshot {
  readonly canonicalPath: string;
  readonly absolutePath: string;
  readonly originalBytes: Uint8Array;
  readonly originalText: string;
  readonly byteHash: string;
}
// src/domain/schemas.ts:79 — public presentation coordinates are ONE-based
const PositionSchema: z.ZodType<DTO.Position> = z.strictObject({
  line: positiveCount,
  column: positiveCount,
});
```

ADR 002 defines zero-based half-open original UTF-8 byte ranges with one-based Unicode-scalar line/column positions. Slang's zero-based coordinates cannot be copied directly. `src/discovery/scope.ts:137` returns `DiscoveryResult` with manifest, snapshots, diagnostics, observations and completeness. Derive snapshot IDs using `fileIdentity(snapshot.canonicalPath)` from `src/domain/canonical.ts` and verify manifest ID/hash agreement. Never send `absolutePath` to the worker.

`src/discovery/budget.ts:93` exposes shared `limits`, monotonic absolute `deadlineAt`, `signal`, `check()`, `checkpoint()` and `assertLimitsMatch()`. Reuse that budget across parsing/context batches; source reads are already charged. `src/config/defaults.ts:24` supplies effective limit defaults, which config can override within schema ceilings. `src/discovery/safe-read.ts:281` already decodes with fatal UTF-8 and `ignoreBOM: true`; do not change discovery to strip the prefix. `src/discovery/metadata.ts:390` already filters exact Foundry compiler hints and diagnoses ignored invalid hints.

`test/integration/bootstrap-cli.test.ts:24` allowlists seven root artifacts and currently rejects a new `parser` directory. Extend this assertion when adding the worker. Match error/budget conventions in `src/discovery/budget.ts`, source-unit style in `test/unit/discovery-patterns.test.ts`, and trusted helper compilation to ignored `.vitest/` in `test/research/slang-spike.test.ts:48`.

Match established strict ESM conventions: `.ts` source imports, explicit named exports and exported annotations, `import type`, readonly DTOs, no `any` or suppressions, unknown caught values narrowed before use. Tests use Vitest source imports for units and the trusted build-first integration wrapper for artifact suites. These current facts supersede prospective wording in the original context below.

### Original design context (retained)

No production adapter existed during planning. Expect exact-pinned Slang from 002, plain DTOs from 003 and safe `SourceSnapshot` reads from 005. The parent alone reads the filesystem. The child receives bounded strings/IDs/settings over validated IPC and never discovers source files or executes project scripts. Import/binding compilation later uses an in-memory snapshot map. Do not expose CST/AST/cursor objects publicly.

Use the local reviewed `docs/research/slang-spike.md` and research code as pinned API evidence: `LanguageFacts.allVersions()`, `LanguageFacts.inferLanguageVersions(parserText)`, `Parser.create(version).parseFileContents(parserText)`, `isValid()`, `errors()` and `tree.unparse()`. Exact grammar support is queried from the installed package, not a hardcoded current compiler release. No pragma returns the entire supported set, but so can a broad pragma; inference cardinality alone cannot establish pragma absence. Malformed-pragma detection needs an additional explicit fixture before production relies on it.

## Commands you will need

**Static review evidence (2026-10-15):** Node `24.21.0` matches `.node-version`; pnpm is pinned to `11.28.4`. A read-only module-resolution probe found all five runtime dependencies missing locally (Slang, Commander, Zod, picomatch and smol-toml). This review ran no install, build or software tests. The executor must establish a fresh baseline after a frozen install. Historical reviews record one inherited formatting deviation in four unchanged files: `.agents/skills/improve/SKILL.md` and its `references/{audit-playbook,closing-the-loop,plan-template}.md`. Recheck that exact failure set before edits; every changed implementation artifact must pass a targeted format check. If full formatting now passes, keep it green. Do not describe a failing command as exit 0.

An executor must first run `pnpm install --frozen-lockfile` in its authorized implementation checkout and obtain success without lockfile/pin changes. Do not bypass a failed install, force a node_modules purge or improvise a dependency upgrade. Use the build-first integration wrapper for artifact/research suites. `scripts/test.mjs` forwards file and test-name filters after building; focused suites below are implementation deliverables, not tests already present.

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Existing script definitions were inspected; runtime success remains an execution gate.

| Purpose | Command | Expected |
|---|---|---|
| Source-only units | `pnpm exec vitest run --project unit test/unit/parser-version.test.ts test/unit/parser-protocol.test.ts test/unit/parser-ranges.test.ts` | pass without `dist/` or Slang runtime imports |
| Child/adapter | `pnpm test:integration -- test/integration/parser-worker.test.ts` | fresh build; real worker and termination cases pass |
| Parser evidence regression | `pnpm test:integration -- test/research/slang-spike.test.ts` | fresh build; existing evidence passes |
| Production inventory | `pnpm test:integration -- test/integration/bootstrap-cli.test.ts` | strict recursive allowlist passes |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm schemas:check` | exit 0 except exact inherited formatting case above |

## Scope

**In scope:** `tsdown.config.ts` (worker entry/output only), `src/parser/{adapter,protocol,worker,version-policy,extract-syntax,ranges}.ts`, `test/unit/{parser-version,parser-protocol,parser-ranges}.test.ts`, `test/integration/parser-worker.test.ts`, `test/integration/bootstrap-cli.test.ts` (strict worker artifact inventory only; preserve existing assertions), `test/helpers/parser-child.ts`, `test/fixtures/parser/**`, `test/fixtures/manifest.json`, `docs/adr/005-parser-boundary.md`, only 006 status/review entries in `plans/README.md`.

**Out of scope:** public domain/schema changes and `src/index.ts`, CLI wiring, discovery/config changes, dependency/toolchain changes, research evidence rewrites, graph/type inference, final physical/SLOC/structural metrics, semantic-component execution (008 owns it), compiler execution/downloads, fallback parsers, executable/worker paths from config. Keep parser transport internal; STOP for a reviewed amendment if a public contract truly must change.

## Git workflow

Use the supplied checkout. No commits, pushes, branch changes or publication without operator instruction.

## Steps

### Step 1: Implement deterministic grammar selection and honest errors

Keep `version-policy.ts` pure: `selectLanguageVersion(evidence, authority)` consumes validated installed versions, compatible candidates and pragma-presence/range evidence. All Slang inference and CST inspection supplying this evidence runs in the timed worker, not the parent or source-only unit tests. Sort versions numerically by major/minor/patch. Do not detect absent pragmas using regex or by comparing inferred/supported set sizes: a broad pragma can match the entire supported set. Obtain actual pragma evidence from Slang; add malformed-pragma fixtures before relying on that distinction.

An explicit `cli`/`config` exact version must be installed and compatible with every pragma; conflict yields `LANGUAGE_UNSUPPORTED` and no structural success, without fallback. A `metadata` exact hint wins only if supported/compatible; otherwise issue a fixed warning using existing `LANGUAGE_UNSUPPORTED` code and infer deterministically. Carry upstream ignored-hint diagnostics instead of rereading Foundry metadata. A `default` version string is not an authority: choose the numerically highest compatible installed grammar. No pragma still honors a valid explicit version or hint first, otherwise installed latest; emit a fixed absent-constraint warning using the existing code. Empty candidates yield `LANGUAGE_UNSUPPORTED`; malformed pragmas/syntax yield `PARSE_INVALID`, never successful no-pragma fallback. Do not retry grammars until one parses.

Record selected grammar, selection source (`cli | config | metadata | inferred | latest-no-pragma`), ignored-hint status, compatible set, pragma ranges and installed supported-set/parser version in internal records. Syntactic parsing is per file. Later 008 chooses a common grammar for an import component and records it separately; retain each file's candidates/original grammar for that consumer. Empty component intersection means unavailable semantics without discarding valid per-file syntax. No binding implementation belongs here.

**Verify:** `pnpm exec vitest run --project unit test/unit/parser-version.test.ts` and `pnpm typecheck` → exit 0. Units use hand-entered evidence sets, import no Slang and require no build. Cover all authorities, numeric ordering, exact conflicts, broad vs absent pragma, empty intersections and hint fallback. Actual Slang inference is verified in Step 4.

### Step 2: Define and validate bounded IPC jobs/results

Define readonly `ParserSource` (`fileId`, existing `snapshot`, matching `manifestEntry: FileScopeEntry`), discriminated `ParseFileResult`, and `ParserBatch` in `protocol.ts`. A successful file carries selected grammar and normalized records; a failed file carries a reason and diagnostics with no recovered record arrays. Keep snapshots in the parent so 007 calculates physical lines. Return this internal `ParserBatch`, not the public metric-bearing `SyntaxBatch`; 007 owns the conversion. Add internal named APIs `createParserSession({ budget, config })`, `analyzeSources(session, sources): Promise<ParserBatch>` and awaited `session.close()`. Validate effective limits against the shared budget. Session counters/cache persist across later context batches and recycling: same ID/hash reuses a result, while same ID with different bytes/hash is rejected.

Use length-prefixed UTF-8 JSON over child stdin/stdout (four-byte unsigned big-endian payload length). Validate the length before allocating a whole frame or calling `JSON.parse`, bound chunk accumulation, handle fragmented/coalesced frames and backpressure, and reject truncation. Avoid Node object IPC, which deserializes a reply before the receiving validator can bound it. One request is in flight at a time; validate private protocol version, monotonically increasing safe-integer request ID, job kind and expected file ID. Unknown keys/kinds, duplicate/wrong replies and invalid numeric values yield sanitized `INTERNAL_ERROR` and dispose the worker. Reserve `semantic-component` only as an explicitly rejected unsupported kind until 008 supplies its payload/implementation; no stub success.

Each `parse-file` wire request contains **exactly one file**, with exactly one terminal reply. The parent sorts/schedules the `sources` array, reuses cache hits and aggregates outcomes into `ParserBatch`; never send the entire source array in one frame. On startup the worker emits exactly one bounded `ready` frame with protocol/parser versions and the installed supported set (at most 256 exact-version strings, each at most 128 code units). This is the sole frame without a request ID; validate it and reject a duplicate. The first file's timer covers this initialization. No jobs are sent before readiness.

Parent checks IDs via `fileIdentity`, manifest/hash agreement, effective byte/file limits, original bytes vs fatal BOM-preserving decode, and SHA-256. Copy caller-owned bytes needed across awaits. Send only bounded `{ fileId, canonicalPath, originalText, byteHash }` plus validated policy/limit settings; never absolute paths, functions or process options. Child re-encodes text, rejects unpaired-surrogate/encoding or hash mismatches, derives its own BOM metadata and repeats validation. This is not another filesystem read: do not double-charge discovery's source-byte counters.

Freeze internal transport ceilings in `protocol.ts` and ADR 005, with no new config keys: request payload `6 * maxFileBytes + 64 KiB` maximum (JSON escaping plus envelope), response 32 MiB, cumulative accepted response bytes 64 MiB/session, 256 diagnostics/file, diagnostic messages at most 512 code units **and** 1,024 UTF-8 bytes (compatible with the public schema), and 64 KiB captured stderr/job. Check safe-integer arithmetic and encoded bytes before allocation; reject advertised oversized frames immediately. A resource cap yields `LIMIT_EXCEEDED`, never silently truncated success. Drain stderr with a cap or ignore it; never expose raw stderr/native errors in diagnostics. These are protocol bounds, not a hard process-memory sandbox.

Use flat bounded record schemas, not recursive arbitrary JSON. Validate all range endpoints against original source lengths/UTF-8 boundaries and a linear line/scalar index; validate owners exist and contain child ranges, IDs are unique/derived with existing identity helpers, and names/attributes have finite bounds. Combined emitted record counts cannot exceed charged visited nodes; imports also consume effective `maxImports` cumulatively. Reject out-of-bounds/reversed ranges, mismatched files and conflicting IDs before accepting any file result. Yield/check budget during parent-side validation loops rather than blocking timers with a large synchronous pass.

`extract-syntax.ts` keeps CST/AST knowledge in the child. Tokens distinguish whitespace/comments/NatSpec/strings/identifiers/keywords/operators/punctuation by original ranges without duplicating full token text. Declarations carry ID/kind/name, owner IDs, declaration/name/body ranges, explicit attributes and body presence; unproved effective defaults remain unavailable to 007. Imports preserve bounded literal value/range and alias forms without resolving targets. Generic events have bounded kind, owner IDs, range and scalar attributes, allowing 007 to extend event coverage without public schema changes or Slang handles. Invalid trees return diagnostics only; physical accounting stays with the parent snapshots and later metrics.

Freeze the generic event shape as `{ fileId, kind, contractId: ContractId | null, callableId: CallableId | null, range: SourceRange, attributes: readonly { key, value }[] }`. Kinds/attribute keys are nonempty lowercase kebab-case labels of at most 128 code units; attributes have unique keys, at most 32 entries, and scalar values `string | number | boolean | null` (strings at most 512 code units, numbers finite). Required declaration names are at most 128 code units, decoded import specifiers at most 512, and IDs/paths use existing domain validators. An overlong required field makes the file limited, never silently truncated. In 006 emit only `declaration` (attributes `declaration-kind`, `has-body`), `import` (`alias-form`: `bare | namespace | named`), and `pragma` (`pragma-kind`: `solidity | other`) events, with appropriate null owners for top-level records. Plain declaration/import records retain their richer fields. The generic schema bounds labels without a closed metric-kind enum: 007 adds documented metric event kinds/attributes in `extract-syntax.ts` and its consumers, keeping the transport shape fixed. Metrics consumers must explicitly recognize their event kinds rather than infer counts from arbitrary labels.

**Verify:** `pnpm exec vitest run --project unit test/unit/parser-protocol.test.ts` and `pnpm typecheck` → exit 0. Pure tests cover exact/one-byte-over frame bounds, fragments/coalescing/truncation, invalid UTF-8/JSON, wrong/duplicate IDs, unknown jobs, hash/text mismatches, invalid ranges/owners and cumulative caps. Real child round-trips follow Steps 3–4; do not run a built suite before its worker exists.

### Step 3: Spawn only the fixed built ESM worker and enforce deadlines

Add tsdown entry `'parser/worker': 'src/parser/worker.ts'`, producing `dist/parser/worker.js` plus its map. Preserve external runtime dependencies and declarations only for the library. Extend the bootstrap inventory to recursively allow exactly these two worker files in addition to the existing seven artifacts; accepting an unrestricted directory is insufficient. If shared production chunks are unavoidable, inspect their exact purpose/path and STOP before relaxing the allowlist to arbitrary chunks.

**Reviewed execution amendment — 2026-10-15:** The first isolated worker build at base `2a3cd54` passed but emitted `dist/versions.js` and `dist/versions.js.map`. The executor stopped as required. The reviewer inspected the complete chunk: it contains only the six existing constants from `src/domain/versions.ts`, shared by `dist/index.js` and `dist/parser/worker.js` through the worker's canonical/schema imports. These two exact additional production files are approved. The recursive inventory must require exactly ten files: `bin.js`, `bin.js.map`, `index.d.ts`, `index.js`, `version.js`, `version.js.map`, `parser/worker.js`, `parser/worker.js.map`, `versions.js`, and `versions.js.map`. Follow-up inspection confirmed that `index.js` is now a pure forwarding module without a source-map reference; tsdown emits no `index.js.map` for it. Do not invent an unused map or weaken exact inventory assertions. Do not change public source/schema exports or bundling policy to eliminate this reviewed chunk. Any further unexpected artifact still triggers the STOP condition; wildcard chunk/directory allowances remain forbidden.

Resolve the fixed worker from the installed package, never target cwd or an assumed source-relative path. A strategy to prove is `import.meta.resolve('audit-estimator')` to locate the package's own emitted `dist/index.js` export, then resolve `./parser/worker.js` against that URL without importing the library. Verify this in a native Node bridge compiled under `.vitest/`, including another cwd. Record package-name coupling for 015. No configurable worker path. Use `spawn(process.execPath, [fixedHeapFlag, fixedWorkerPath], …)` with `shell: false`, package-owned cwd, pipes and no inherited `process.execArgv`. Build an explicit minimal environment (fixed locale/timezone and necessary Windows launch values where present); do not spread the environment and only remove `NODE_OPTIONS`. Exclude loader/preload, `NODE_PATH`, debug/coverage and target additions without mutating parent state. Trusted dependency/WASM loads are allowed; analyzed-source filesystem reads are not.

Use one child at a time. The effective per-file cutoff is `min(budget.deadlineAt, jobStart + limits.parseTimeoutMs)`; install the real timer/abort listener before spawn and recheck already-aborted/expired state. Cover startup, inference, parse, extraction and reply validation. Defaults are 2,000 ms/file and 120,000 ms/application, not fresh allowances at parser entry. Honor effective configured values. Semantic deadlines remain reserved for 008. Parent-side bounded validation loops must yield/check the shared budget.

Retain the timer until a reply is fully validated and accepted. Each parent validation checkpoint must call both the shared budget check and a job-local check comparing `performance.now()` to this file's cutoff and observing its terminal/abort flag. `DiscoveryBudget.checkpoint()` alone cannot enforce the earlier per-file deadline. Recheck immediately after bounded synchronous JSON decode/encoding and before accepting results; those native calls cannot be preempted mid-call, and an expired result must still be rejected. Test validation crossing the file cutoff while the application budget remains live.

Unify spawn/send/backpressure errors, timeout, abort, exit/close and result completion through one settle-once cleanup path. Job timeout/node/output exhaustion yields `LIMIT_EXCEEDED`; crash/spawn/protocol defects yield sanitized `INTERNAL_ERROR`. Do not mislabel them parse errors. Never retry the failed file. Continue independent files only within remaining global resources; on total deadline/node/import/output exhaustion, stop scheduling and mark unscheduled outcomes explicitly incomplete. Cancellation kills/reaps then propagates existing `BudgetError('cancelled')` so 013 retains SIGINT exit 130; it is not ordinary partial success.

Terminate with 100 ms grace, then force-kill if needed; await exit/close, destroy streams and clear timers/listeners on every path and session close. A separate 5-second cleanup watchdog fails an unreaped-child check instead of hanging forever. Recycle after 32 completed files or 8 MiB processed input, whichever comes first, without resetting counters/deadline. Node heap caps do not cap WASM/external memory; document the OS sandbox needed for hard RSS isolation.

Compile only repository-owned `test/helpers/parser-child.ts` into ignored `.vitest/`, following the research helper pattern. Test stall/crash/protocol behaviors through a private supervisor seam inaccessible from config/jobs; the analysis API always picks the fixed real worker. Use handshake-synchronized stages for startup/inference/traversal stalls, real timers and a generous outer watchdog. At least one native bridge must exercise the real adapter, worker and WASM loading rather than only a fake child.

For this step's native bridge, implement and verify real-worker initialization/`ready` and teardown through the supervisor; full parse/extraction success assertions land in Step 4. This keeps the gate independent of the next step's record visitors. Unsupported temporary work must never be reported as a successful empty parse result.

**Verify:** `pnpm test:integration -- test/integration/parser-worker.test.ts -t 'isolation and deadlines'` then `pnpm test:integration -- test/integration/bootstrap-cli.test.ts` → fresh builds, exit 0. Assert actual child exit/closed resources, already-aborted/expired no-spawn paths, stalls in every stage, crash/missing worker, late/duplicate replies, no retries, independent continuation, global cutoff, persistent recycle counters, bounded stderr/backpressure and native loading from another cwd. Verify hostile loader-environment markers are absent from the child and target marker scripts remain unexecuted.

### Step 4: Handle ranges, malformed sources and traversal budgets

Convert Slang coordinates using verified UTF-8/UTF-16 mapping. The user approved the leading-BOM encoding contract in plan 002: retain original snapshot bytes/text and hashes, and exclude exactly one initial UTF-8 BOM only from the parser, pragma-inference and compilation callback view. No interior/repeated U+FEFF removal, newline normalization, replacement decoding or token rewriting is permitted. Keep decoding inside the reviewed adapter, shared by syntax/version/semantic operations, and do not change discovery to hide the prefix.

For a removed BOM, first map both endpoints into zero-based original coordinates: add 3 UTF-8 bytes and 1 UTF-16 unit, keep the line, and add 1 scalar column only on line 0. **Then** form domain `SourceRange`: `startByte/endByte` remain zero-based/half-open; presentation `line = mapped.line + 1`, `column = mapped.column + 1`. No-BOM byte mapping is identity, but presentation conversion still adds 1. Public ranges have no UTF-16 fields; retain internal UTF-16 only for validation/slicing. Apply this to every token/declaration/import/event/pragma/diagnostic endpoint, including EOF/zero-width ranges. Use a linear original-source coordinate index instead of rescanning per endpoint.

Hand oracle: `/* 🙂 */ contract C {}` reports `C` at Slang UTF-8 20, UTF-16 18, line 0 column 17; domain start is byte 20, line 1 column 18. With a leading BOM it becomes byte 23, line 1 column 19 (internal UTF-16 19). BOM-prefixed malformed `contract` EOF is byte 11, line 1 column 10. Empty-source EOF is byte 0, line 1 column 1; BOM-only EOF maps to byte 3, line 1 column 2. A valid reconstructed tree plus recorded BOM must reproduce original bytes/hash exactly. Do not normalize CRLF/CR/LF or turn unsupported U+2028/U+2029 into supported syntax. Validate derived prefix metadata instead of trusting client offsets.

Query/infer/parse/extract inside the supervised child. Count CST nodes, including terminals/trivia, iteratively and charge before processing/emitting; no recursive visitors or whole-tree recursive JSON conversion. Enforce effective `maxAstNodesPerFile` and remaining session `maxAstNodesTotal` inside the child, not just after serialization (defaults 200,000/file and 2,000,000/session). Persist confirmed consumption across batches/recycling. If a killed child cannot report consumed nodes, conservatively charge its full granted allowance; a hard session cap takes precedence over continuing after timeout. These caps bound extraction visits, not Slang's earlier tree allocation: input limits, subprocess deadlines and disposal cover that limitation.

Bound diagnostic processing even for invalid trees and emit no recovered structural records. Use existing codes, `phase: 'parse'`, fixed sanitized messages and validated original ranges; do not relay arbitrary parser/native messages or source excerpts. Sort files by file ID in code-point order, records/diagnostics by original range and stable tie-breakers. No locale ordering, absolute paths, PIDs, request IDs or timing data in deterministic results. Add actual absent/broad/multiple/malformed pragma integration fixtures; STOP if pinned APIs cannot supply safe evidence instead of guessing.

**Verify:** `pnpm exec vitest run --project unit test/unit/parser-ranges.test.ts`, `pnpm test:integration -- test/integration/parser-worker.test.ts`, and `pnpm test:integration -- test/research/slang-spike.test.ts` → exit 0. Range units use hand-entered plain coordinates without Slang runtime imports. Real-worker tests cover exact bytes/hash and schema-valid one-based evidence, absent/broad/malformed pragmas, record round-trips, nested/malformed/empty/unsupported input, and exact/one-above per-file/session limits.

### Step 5: Record the boundary and run final verification

Write ADR 005 describing the internal session/result APIs, generic event fields, framing ceilings, version authority, coordinate conversion, shared-budget/cancellation mapping, killed-job accounting, fixed worker resolution, test seam and disposal. State tested/unverified platforms and limits of heap/process isolation. 007 maps `ParserBatch` to existing `SyntaxBatch`; 008 adds common-version semantic jobs; 013 retains discovery diagnostics/omissions and cancellation. Parsing alone cannot make an incomplete project complete. Future consumers must inspect these implemented contracts at their drift gates; do not update unrelated plans in this execution.

**Verify:** run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm schemas:check`, and `git -c core.whitespace=cr-at-eol diff --check` → exit 0 except the exact inherited formatting case documented above. If inherited failures remain, additionally run `pnpm exec oxfmt --check src/parser tsdown.config.ts test/unit/parser-version.test.ts test/unit/parser-protocol.test.ts test/unit/parser-ranges.test.ts test/integration/parser-worker.test.ts test/integration/bootstrap-cli.test.ts test/helpers/parser-child.ts test/fixtures/manifest.json docs/adr/005-parser-boundary.md` → exit 0, also checking new format-supported fixtures without changing intentional BOM/CRLF bytes. Check `git diff --name-only` and `git ls-files --others --exclude-standard` against Scope. Record measured gates and API/platform evidence in status 006 only after success; no dependency/public-schema changes.

## Test plan

Use 002 fixtures and hand assertions; add original attributed fixtures/manifest expectations rather than generating expected values from Slang. Exercise BOM-only/malformed, first/later-line identifiers, CRLF/CR/LF, multibyte/emoji, EOF/zero-width and exact one-based evidence, reconstruction/hash preservation and interior/repeated U+FEFF. Exercise mixed per-file grammars, broad/absent/malformed pragmas, override provenance and hint fallback. Pure policy/protocol/range units run without `dist/` or Slang runtime imports. Built-worker/helper suites cover timed startup/inference/extraction, crashes, frame/array/string/node/import/output bounds, configured overrides, cancellation before/during/between jobs, shared deadline consumption, killed-job charging, recycling and absence of target configuration/loader execution. Use real child exit assertions with handshake synchronization and outer watchdogs. The final full regression includes the strict artifact inventory and unchanged research tests. Parser success does not mean Solidity compiles or binds correctly.

## Done criteria

- [x] Frozen install succeeds without lockfile changes; source units, built-worker/research/full tests, type/lint/schema gates pass. Formatting is green or only the exact verified inherited exception remains, with every changed artifact passing.
- [x] `ParserBatch` is internal plain data with recorded parser/grammar provenance; no fabricated `SyntaxBatch` metrics, Slang handles, absolute paths or snapshot serialization.
- [x] Every exposed range uses original bytes and one-based scalar presentation coordinates; invalid/unsupported/limited files have no recovered structural records.
- [x] All production Slang operations run in a supervised child; startup/inference/traversal deadlines kill/reap real work and honor the pre-existing global deadline. Cancellation remains distinguishable for exit 130. Existing research-only direct API tests stay unchanged.
- [x] Frame validation precedes JSON decoding; cumulative counters survive batches/recycling and conservatively charge killed jobs. No failed-file retries or silent truncation.
- [x] Real native ESM adapter/worker/WASM loading works from another cwd; recursive artifact inventory contains only reviewed production output.
- [x] All edits scoped; ADR/status 006 records measured API, gate and platform evidence. Public schemas, CLI and dependency pins remain unchanged.

## STOP conditions

Stop if prerequisites contradict the excerpts, frozen installation cannot succeed, the pinned API cannot supply safe pragma/range evidence, package worker/WASM loading needs unsafe bundling/target scripts/path injection, cancellation cannot terminate/reap the child, range conversion/reconstruction loses fidelity, validation/traversal requires unbounded allocation/recursion, out-of-scope/domain/dependency changes appear necessary, or a gate fails twice after a reasonable scoped fix. Do not replace isolation with `Promise.race`, add a fallback parser, reset the application budget, silently truncate complete results or advertise a heap cap as a full memory sandbox.

## Maintenance notes

Retest packed worker paths, native library self-resolution and package-name coupling in 015 and every packaging change. Review Slang upgrades against pragma, range and node fixtures. New event/job types must preserve framing, owners, cumulative counters and cleanup; keep AST knowledge in the adapter. Evidence/metric semantic changes need version review. Actual platform tests must precede cross-platform termination claims.
