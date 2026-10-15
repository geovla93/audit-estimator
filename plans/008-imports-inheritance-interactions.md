# Plan 008: Resolve local import closure and bounded contract relationships

> **Executor instructions:** Implement the internal relationship layer described here, step by step. Run every gate and confirm its expected result. Preserve existing syntax metrics and the safety boundary. An unresolved target is a result, not permission to guess globally. Update only row 008 in `plans/README.md` when done. Do not implement later application/report/model plans.
>
> **Drift check first:** Reviewed against commit `892073d` on 2026-10-15, with 001–007 present on `main`. Run `git status --short`, `git diff --stat 892073d..HEAD -- src test docs tsdown.config.ts`, and `git diff HEAD -- src test docs tsdown.config.ts`; inspect untracked files too. Compare the excerpts below with live code. Expected prerequisite changes need inspection; incompatible contracts or unrelated local source edits require reconciliation. Record the starting diff so existing plan edits are not attributed to this execution.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH — import identity, worker isolation and compiler-like ambiguity
- **Depends on:** 005 safe discovery, 006 parser adapter and 007 structural metrics, all implemented at this baseline
- **Category:** direction / correctness
- **Planned at:** commit `892073d`, reviewed 2026-10-15; supersedes the `d11bc60` handoff

## Why this matters

Audit effort depends on interactions and dependency assumptions as well as independent source size. This layer discovers root-local dependencies once, preserves their ownership, and produces evidence for bounded declaration relationships. Its result must distinguish a known symbol reference from an unknown runtime call target so later estimates cannot charge invented certainty or count inherited source twice.

## Current state

There is no `src/relationships/` directory or production semantic job. Plans 001–007 are implemented in the current checkout; the former statement that 007 is TODO is stale.

Relevant existing contracts and exemplars:

- `src/discovery/scope.ts` exports `DiscoveryInput`, `DiscoveryResult`, `ProjectMetadataResult` and `reevaluateIdentityOwnership`. `metadata.paths.libs` is the validated internal Foundry companion; `ScopeSettings` has no libs field. `DiscoveryResult` includes omissions, observations and `complete`, not just a manifest.
- `src/discovery/safe-read.ts` exports `readSource(context, candidatePath)` and `readMetadataFile(context, candidatePath)`. All reads reuse the captured `SafePathContext`, `DiscoveryBudget` and `IdentityRegistry`. Metadata reads reject symlinks and enforce a fixed 256 KiB ceiling plus remaining metadata allowance. Preserve optional `target`/`lexicalTarget` confinement supplied by the caller; never delete those fields to make an import succeed.
- `src/config/merge.ts:144` replaces the entire remapping array when a higher-priority input supplies `imports`; this includes an explicit empty array. Provenance records `imports.remappings`. Do not concatenate a resolved config array with the superseded Foundry array.
- `src/parser/adapter.ts` owns the fixed trusted child, serialization, counters, cache, validation, cancellation/deadline and cleanup. `createParserSession({ budget, config })`, `analyzeSources(session, sources)` and awaited `session.close()` are the existing internal API. Keep one session through initial syntax, closure expansion and semantics. Match results by `fileId`, never by array position.
- `src/parser/protocol.ts:139` currently permits only `kind: 'parse-file'`; `PARSER_PROTOCOL_VERSION` is 1. New semantic-component requests need a version bump and parent/worker/test updates together.
- `src/parser/extract-syntax.ts:698` already emits decoded imports. Do not decode their strings again:

  ```ts
  const record: ParserImport = {
    id,
    specifier: decoded.value,
    range: item.range,
    specifierRange: item.literal.range,
    aliasForm,
  };
  ```

- 007 emits `call-site` events with `callee-shape`, optional `member-name` and `low-level-candidate`. These are syntax hints. It does not emit binding definitions or direct-base edges. Events can be callable-owned outside its body, for example modifier-invocation arguments; use the same ownership convention for low-level confirmation.
- `src/metrics/structural.ts:533` is the metrics exemplar:

  ```ts
  export function buildFileMetrics(source: ParserSource, result: ParseFileResult): FileMetrics {
    if (result.fileId !== source.fileId) throw new TypeError('Parser result is for another file.');
    return result.status === 'parsed'
      ? parsedFileMetrics(source, result)
      : failedFileMetrics(source, result);
  }
  ```

  `FileMetrics` contains `file`, `contracts`, `callables`, `lineSet` and `wholeFile`. Leave these syntax measurements unchanged. In particular `lowLevelCallCandidates` is not a confirmed builtin count; user-defined state shapes remain unresolved syntax facts in this plan.
- `src/domain/types.ts:81` defines one edge, not the whole relationship analysis:

  ```ts
  export type RelationshipResult = RelationshipBase &
    (
      | { readonly resolution: 'resolved-unique'; readonly to: string }
      | { readonly resolution: 'ambiguous' | 'unresolved' | 'unsupported' }
    );
  ```

  Imports similarly require `targetFileId` for `resolved` and `null` otherwise. Strict producer schemas forbid `to` on nonresolved edges. Existing `Analysis.graphs` permits only `inheritance | call | import`; ancestor metrics, site metadata and pair partitions belong in an internal companion, not new public fields.

Honor `docs/adr/004-scope-safety.md`: “Context inclusion does not change ownership, promote audit scope, or bypass hard exclusions, containment, or target policy.” Honor ADR 005: semantic jobs preserve per-file syntax evidence and the existing framing/accounting/cleanup rules. `docs/research/slang-spike.md` and its hand-written tests prove these limits for Slang 1.3.9:

- Tested namespace/direct bases resolve to exact locations. Named aliases return both alias and imported definitions; retain candidates until a separate reviewed alias-normalization design exists.
- Overloads return multiple definitions. Function-pointer variables do not establish callable targets.
- `this`, interface and library member references can identify declarations; that alone does not establish runtime receivers or override dispatch.
- Never bind invalid recovered trees or incompatible grammar components, even if the builder produces references.

Use strict ESM TypeScript: `.ts` source imports, explicit named exports and annotations, `import type`, readonly records, no `any` or suppressions, and narrow caught `unknown`. Units import pure DTO/graph code without Slang or built artifacts. Real Slang work remains in the trusted child. Preserve the existing ten-file production inventory, dependency pins, public schemas and versions.

## Commands you will need

Node `24.21.0` and pnpm `11.28.4` were observed. This review passed typecheck, lint, format check and all **137 unit tests**. It did not run an install, build, integration, schema generation/check or coverage. No root README, CONTRIBUTING or CI workflow is present; use `AGENTS.md`, `package.json` and the ADRs for current commands.

In a new execution checkout first run `pnpm install --frozen-lockfile` successfully against this trusted analyzer repository. Do not install anything in analyzed repositories. With dependencies present, `pnpm --config.verifyDepsBeforeRun=false run <script>` avoids implicit dependency reconciliation. No dependency changes are authorized.

| Purpose | Command | Expected |
| --- | --- | --- |
| Pure relationship units | `pnpm exec vitest run --project unit test/unit/relationships.test.ts` | exit 0; named cases below pass |
| Protocol units | `pnpm exec vitest run --project unit test/unit/parser-protocol.test.ts` | exit 0; old and new envelopes pass |
| Import integration | `pnpm test:integration -- test/integration/imports.test.ts` | fresh build, then closure/remapping cases pass |
| Semantic boundary | `pnpm test:integration -- test/integration/relationships.test.ts test/integration/parser-worker.test.ts test/research/slang-spike.test.ts` | fresh build, native and hostile-child regressions pass |
| Full regression | `pnpm test:all` | units, fresh build, all integration/research suites pass |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check` | each exit 0; no inherited format exception |
| Schema contract | `pnpm schemas:check` | exit 0; generated schemas unchanged |

Run artifact suites through the build-first wrapper, not direct Vitest against stale `dist/`. `schemas:check` itself builds. Use reduced test limits rather than huge inputs or long sleeps.

## Scope

**In scope, the only implementation files you may create or modify:**

- Create `src/relationships/{types,imports,remappings,closure,graph,inheritance,calls,components}.ts`.
- Modify `src/parser/{adapter,protocol,worker}.ts` for semantic requests, supervision and validation; create `src/parser/bindings.ts` for worker-only Slang binding extraction.
- Modify `test/unit/parser-protocol.test.ts`; create `test/unit/relationships.test.ts`.
- Create `test/integration/{imports,relationships}.test.ts`; extend `test/integration/parser-worker.test.ts` and `test/helpers/parser-child.ts` for new adversarial jobs. Existing syntax assertions must remain.
- Create `test/fixtures/relationships/**`; append attributable hand-written entries to `test/fixtures/manifest.json`, retaining all old entries.
- Create `docs/relationships.md`; update only the new-job/accounting sections of `docs/adr/005-parser-boundary.md` to describe the actual internal API.
- Update row 008 in `plans/README.md`.

**Out of scope:** `src/domain/**`, `schemas/**`, `src/config/**`, `src/discovery/**`, `src/metrics/**`, syntax extraction/range/version-policy modules, `src/index.ts`, CLI/application/reporting/estimation wiring, dependency/tool/build configuration and existing research fixtures/oracles. Do not add a production entry or chunk, widen path access, run target scripts/config/compiler executables, fetch dependencies, implement C3/type inference, or promote dependencies. Missing/blocked imports are supported outcomes, not reasons to stop the entire implementation or weaken safety.

## Git workflow

Use the supplied implementation checkout. Do not commit, push, publish, switch branches or modify other existing plan edits without operator instruction. Record baseline status and use a baseline-aware scope check; unrelated pre-existing plan modifications are not yours to overwrite or clean up.

## Internal handoff contract

Define explicitly annotated readonly DTOs in `src/relationships/types.ts`. These are source-internal APIs, not package exports or public schema additions.

`resolveRelationships(input): Promise<RelationshipAnalysis>` lives in `closure.ts`. Input holds the discovery result; captured reader path context, registry and budget; resolved config and metadata result; the **same** parser session used for initial syntax; and that initial `ParserBatch`. Initial syntax must have been requested on this session for exactly these discovery snapshots; reject mismatched cached identities/hashes. Initial sources are reconstructed from matching discovery snapshots/manifest entries. Require initial syntax outcomes for every supplied scoped snapshot. Do not create a new budget/session or rediscover the root. The caller owns closing the session in `finally`; integration helpers do this too. `ParserSession` is currently an unexported class: name its input type through `ReturnType<typeof createParserSession>` with a type-only import rather than requiring a new package export.

The result contains these named fields:

| Field | Required meaning |
| --- | --- |
| `manifest`, `sources`, `syntax` | Final immutable manifest, unique `ParserSource[]`, and merged `ParserBatch`; include context and original failed outcomes. Sort/join by ID, preserve original per-file selected versions and syntax records. Recompute batch completion from unique outcomes. Set merged syntax `visitedNodes` / `processedBytes` from the syntax-only session counters specified in Step 3, including failed work, not sums of repeated cache-hit batches. |
| `imports`, `graphs` | `ImportReference[]` and `RelationshipResult[]`; obey existing schemas. Import graph endpoints are file IDs; inheritance endpoints are contract IDs; call source is containing callable ID, else containing contract/file ID, and resolved target is a verified callable ID. Retain evidence for all sites. |
| `importObservations` | Per-import strategy, applied remapping provenance, bounded candidate paths/IDs, and fixed failure reason. Preserve original decoded specifier, normalized lookup name and final canonical file ID separately. |
| `importCycles` | Sorted nontrivial import SCC member-ID arrays, including a one-file SCC only if it has a self-import. Structural observations, not inheritance validity claims. |
| `components` | Stable component ID (smallest member file ID), sorted members, selected common grammar or null, `available | unavailable`, and fixed reason. |
| `inheritance` | Per-contract declared-order direct base edge IDs, `Measurement<readonly ContractId[]>` ancestor IDs, `Measurement<number>` max depth and `Measurement<readonly CallableId[]>` ancestor-declared-callable IDs. Last field is declaration references in ancestors, not effective member visibility/overrides or dispatch. |
| `callSites` | Per-site ID/evidence/owners, syntax form, raw definition locations/candidates, symbol-resolution status and separate `static | dynamic | unknown | not-applicable` dispatch. Builtin classification is `confirmed | rejected | unknown`; include a fixed limitation reason. Preserve import-alias/local-variable definition locations internally instead of casting them to callable IDs. |
| `scopedPairs`, `contextPairs` | Directed contract pairs `{ leftId: ContractId, rightId: ContractId, kinds, evidence }`, disjoint and sorted. Map their two IDs to existing `EstimateInput` pairs later in 013; do not call the estimator here. |
| `confirmedBuiltinLowLevelCalls` | Per-file `Measurement<number>`, separate from unchanged 007 candidate counts. If all candidates are confirmed/rejected, measure the confirmed count (zero permitted); any unclassified candidate makes the count unavailable. Failed syntax/component also makes it unavailable. |
| `invalidatedScopedFileIds` | IDs whose later alias ownership disqualifies previously selected first-party scope. Preserve IDs/snapshots; reflect updated ownership and remove them from final scoped eligibility, retaining their context role if needed by imports. |
| `diagnostics`, `requiredAnalysisComplete`, `hasUnknownSemantics` | Accumulated discovery/parser/relationship diagnostics, with deterministic deduplication. Completion never upgrades a false prerequisite. Truth table below applies. |
| `fingerprint` | Length-framed hash via existing `fingerprint`/`canonicalJson` over sorted canonical IDs, original byte hashes, final roles/ownership, effective lookup/remapping decisions, semantic config and parser/component grammar versions. No absolute paths, inode/device keys, timing or host data. 013 combines this with other phase fingerprints. |

File-only imports stay file graph observations; never fabricate a contract endpoint. Unused imports do not create billable contract pairs. Ancestor and builtin companions are available to 009/013 but must not silently become new report fields or mutate `METRICS_VERSION` 1.0.0 measurements. User-defined storage refinement is deferred. If any scoped mutable state-variable event has `user-defined` or `unknown` shape, set `hasUnknownSemantics=true`; later consumers must mark storage classification dependent on it unavailable rather than treat the syntax-only complex-ID list as an exhaustive noncomplex proof. Preserve 007 measurements themselves.

| Situation | `requiredAnalysisComplete` | `hasUnknownSemantics` |
| --- | --- | --- |
| All required work succeeded, no unknown sites | preserve prerequisite completion | false |
| Dynamic receiver, overload/function-pointer/alias candidates, unconfirmed builtin or unresolved mutable storage shape only | preserve prerequisite completion | true |
| Missing/ambiguous/blocked import, failed context syntax, unavailable component, unresolved base or inheritance cycle | false | true |
| Resource/deadline/protocol failure or invalidated scoped ownership | false | true |
| Safe scoped-out first-party context successfully analyzed | preserve prerequisite completion; emit omitted-audit-dependency notice | according to other evidence |

Cancellation propagates the established cancelled `BudgetError` after cleanup. Deadline/limit exhaustion returns explicit incomplete results for unfinished work, never successful empty graphs or measured zero. Ordinary dynamic-call uncertainty alone is not a parse failure. Fixed sanitized diagnostic messages use existing codes; use bounded structured details for IDs/rule/reason, not raw exception strings or absolute paths.

## Steps

### Step 1: Implement pure lookup and remapping rules

Create `types.ts`, `remappings.ts`, `imports.ts` and pure units first. Treat this as the analyzer's documented **local subset**, not compiler/Foundry equivalence. The [official Solidity path-resolution rules](https://docs.soliditylang.org/en/latest/path-resolution.html#import-remapping) establish relative-name translation before remapping and context-before-prefix priority; the stricter conflict, directory-target and canonical-identity rules below are explicit analyzer policies.

1. Consume the already decoded `ParserImport.specifier`. Reject schemes, absolute/drive/UNC paths, backslashes, NUL/control characters and empty names before native-path conversion. Relative `./` and `../` are allowed only when segment resolution stays within the root and supplied target policy. Reject above-root traversal before normalization can erase it.
2. Use the importer's frozen canonical root-relative POSIX path as this analyzer's source-unit name. Resolve relative segments before remapping. Direct names such as `contracts/Base.sol` remain root-relative names. Retain lexical aliases as ownership/lookup observations; this physical-file deduplication differs from solc, which can treat aliases as different source units. Do not rebind the same file under multiple source-unit identities.
3. Select the remapping **array**, not individual entries, by existing provenance: explicit estimator config (including `[]`) replaces Foundry hints; present Foundry remappings (including `[]`) replace `remappings.txt`; use root `remappings.txt` only when neither supplies an array (`imports.remappings` provenance is `default`). Do not reread overridden metadata. Read fallback text once with `readMetadataFile`, shared budget and symlink rejection, at most 256 KiB. Accept fatal UTF-8, one initial BOM, LF/CRLF/CR, blank lines and trimmed full-line `#` comments. Other lines must be `[context:]prefix=target`, with exactly one `=`, nonempty prefix/target and at most one context separator. Enforce at most 1,000 entries and current remapping schema string/path bounds; no shell expansion or inline comments. Malformed/oversized active metadata is diagnosed and makes import coverage incomplete; do not silently use a truncated/partly valid list. Absence is normal. Contexts/targets are confined root-relative paths, not executable config or remote URLs.
4. Match remapping context against the canonical importer (root `.` means global; otherwise require exact path or directory-descendant boundary), and prefix against the resolved POSIX source-unit name. Rank **longest context first, then longest prefix**. Collapse identical duplicates. Equal-ranked conflicting targets produce ambiguous import status and `IMPORT_UNRESOLVED`; unlike solc's last-wins rule, never select a conflict by order. Apply once, never recursively. Context matching is the documented boundary-aware local subset.
5. Config normalization strips trailing slashes from targets. For a prefix ending `/`, interpret the normalized target as a directory: join target and suffix with one `/` (`.` means root). For an exact/file-style prefix without `/`, replace the prefix literally with the target before validating the result. Document this convention rather than silently losing a separator. Revalidate traversal/root/target safety after replacement.
6. A matched remapping is authoritative even if its file is missing/blocked; no fallback to a different dependency. Without a remapping, relative names have one candidate. For direct names, collect a bounded set: `<root>/<name>`, `<root>/node_modules/<name>`, and for each validated `metadata.paths.libs` entry `<lib>/<package>/src/<rest>`. A package is one segment, or `@scope/name` for scoped names; rest must be nonempty. No inferred lib directories, recursive search, extension guessing, package exports, JS `require.resolve`, or package-file execution. More than one distinct safe physical candidate is ambiguous; multiple aliases to the same identity are one candidate. A blocked/unreadable candidate is an explicit limitation, never evidence of absence that permits a clean unique result.

Use `resolveSafePath` for probes and the shared safe reader for reads. Keep all candidate inspection bounded with `budget.checkpoint()`; do not list directories to search. Preserve path failures and attempted strategies in observations. Outside-root pnpm symlinks remain unsupported.

**Verify:** `pnpm exec vitest run --project unit test/unit/relationships.test.ts -t 'resolution and remappings'` → exit 0. Include a shorter prefix in a longer matching context beating a longer global prefix, relative-name remapping after normalization, config/Foundry empty-array replacement, stripped target slash, exact-file mapping, no chained remapping and equal-rank conflicts under input permutations.

### Step 2: Expand local closure through existing readers and session

Implement an independently callable internal `resolveImportClosure` phase in `closure.ts`, returning the closure fields of the handoff plus completion/diagnostics; wire the full `resolveRelationships` pipeline in Step 5 after semantics exists. Do not fabricate successful semantic fields to satisfy an unfinished pipeline. Exercise real filesystem/worker behavior in `test/integration/imports.test.ts`, with the describe blocks `resolution and remappings` and `closure and scope`.

Use a deterministic queue ordered by canonical importer path and import range/ID; freeze first observed physical identities through the registry. All aliases discovered during candidate probing must be registered and reclassified, even when a file was already visited. Read each accepted unique identity with `readSource`, then call `reevaluateIdentityOwnership` with the original scoped IDs, same budget and metadata paths. A later smaller alias cannot rename published IDs. A newly conflicting dependency alias invalidates scoped eligibility/completeness; update the final manifest immutably, retain the original snapshot and disclose the change. Do not discard discovery omissions or claim unseen aliases were classified.

New files are context, never automatically scoped, with first/third/unknown ownership preserved. Existing scoped imports stay scoped. Excluded-but-safe source may become context; `.git`, outside-root/target paths and forbidden symlinks stay blocked. First-party context is explicitly disclosed as an omitted audit dependency. Build `ParserSource` from matching manifest/hash/snapshot records, then call `analyzeSources` on the same parser session; retain failed outcomes. Never call `buildFileMetrics` with mismatched array positions or fabricate hashes for unread sources.

Deduplicate physical source reads, syntax parsing and source totals; identical bytes in different files still count separately. Count imports once from syntax jobs, including context. Defaults are 2,000 files, 64 MiB source and 20,000 imports; use effective configured limits, not literals. Parser session owns AST/import accounting; DiscoveryBudget owns filesystem/read accounting. Detect source import cycles by iterative SCC traversal and record sorted member IDs as component observations; a source import cycle alone is not invalid inheritance.

On a limit, retain accepted evidence, record unfinished coverage and stop scheduling more work under the exhausted budget. Do not retry a failed parse or reconstruct a budget. Fingerprints include context byte/config/role decisions; input permutations preserve identity and output for the same deterministic alias observations.

**Verify:** `pnpm test:integration -- test/integration/imports.test.ts` → exit 0 with fresh build. Exact cases: root direct import, relative/named/namespace imports, npm scoped package, configured lib, missing installed package, ambiguous candidates, authoritative missing remap, shared/diamond/cycle loads once, copies stay distinct, excluded first-party context, late hardlink ownership conflict and smaller alias, unchanged file IDs, root/target/symlink confinement, shared source/file/import/node/metadata limits and cancellation. Platform-only link cases use the existing capability-detection pattern.

### Step 3: Add semantic-component jobs through the existing supervisor

Extend `adapter.ts`, `protocol.ts`, `worker.ts`, create worker-only `bindings.ts`, and update protocol units/adversarial child helpers. Do not create an independent launcher in the relationship layer.

`components.ts` partitions resolved import connectivity as an undirected graph, including isolated files. A component is unavailable if any member's syntax failed or any outgoing required import is unresolved/ambiguous/blocked; do not bind a misleading partial closure. Compute the intersection of each member's `compatibleVersions` against the worker's installed set. Honor a `cli`/`config` exact authority as an additional constraint; Foundry metadata is only a hint. With no exact authority select the numerically highest intersection member. No intersection means `SEMANTICS_UNAVAILABLE`. Record the common version separately from original per-file syntax versions.

Add `analyzeSemanticComponent` to the session (and a named adapter wrapper if useful), serialized with syntax calls and rejected after close. A request contains component ID, selected grammar, sorted canonical sources/text/hashes/IDs, resolved import lookup entries containing importer ID, import ID, decoded specifier, original-byte `specifierRange` and target file ID, keyed by importer ID plus literal range, and remaining traversal/record allowances. No absolute paths or project executables cross IPC. Replies contain component/file identities, consumption counters, base-site/call-site definition locations and status; never Slang objects. Validate strict keys, IDs, UTF-8 original ranges, site ownership, allowed kinds, known import endpoints and candidate membership in the provided component. Reject forged cross-file IDs, duplicate sites, mismatched grammar or late/duplicate/wrong-job replies. A returned definition cursor often points at a name token: map its `nameRange` back to the original declaration's kind and `declarationRange.startByte` identity; do not confuse the two start offsets.

Bridge import callbacks by location, not string quoting: `test/research/slang-spike.test.ts:250` proves Slang passes `resolveImport(sourceFileId, importPath)` a cursor whose `node.unparse()` is the **raw quoted literal**. Map the callback cursor's `textRange` to original-byte coordinates with the existing parser-view/BOM `SourceCoordinateIndex.toOriginalRange` helpers, then require exactly one lookup entry with that importer and `specifierRange`. Return only its already-validated target ID. Repeated decoded specifiers at different ranges remain separate import sites. Do not naively strip quotes, decode a second time, or compare raw literals to decoded strings. Verify each entry belongs to an actual import literal in the common-grammar tree; duplicate ranges, entries without a matching actual literal, forged entries or a missing required callback mapping make component semantics unavailable with a fixed reason. Add native cases for `\\xNN` / `\\uNNNN` spellings, two literals decoding to the same target, and a BOM/CRLF/Unicode prefix before the import; require exact original ranges and one physical target read.

Increment `PARSER_PROTOCOL_VERSION` and use an explicit `semantic-component` discriminator; preserve existing syntax request/result content. Keep `ParserWorkerRequest` and `WorkerReply` as the existing parse-only types used by `extract-syntax.ts`; add separately named semantic types and composite unions at the transport dispatcher so syntax extraction needs no out-of-scope edits. Derive semantic frame limits **before decoding** from effective component bytes, bounded lookup/record counts and JSON escaping overhead, with safe-integer/uint32 checks. The old one-file frame ceiling is insufficient for a component. Keep 32 MiB reply-frame and 64 MiB cumulative session response ceilings, counting semantic replies/startups too; rejection is an incomplete outcome, not permission to raise them. Child request decoding must reject oversized/count-invalid components before building maps or invoking Slang.

Each semantic job uses a fresh disposable child launched by the same trusted supervisor and terminated/reaped after success or failure. Effective defaults are 128 files/8 MiB/10 seconds, tightened by the shared deadline; config can change these within existing schema ceilings. Check all input counts/bytes before allocating request copies. Reuse fixed launch/env/stderr/heap policy. Bound preparse, extraction and parent validation; yield/check parent budget and job cutoff every 256 records. In the worker, verify byte hashes/BOM reconstruction and valid parsing of **every** member under the common grammar before accessing bindings. Use only the supplied in-memory map for both `readFile` and `resolveImport`; unknown callbacks return unavailable, never filesystem reads.

Accounting rules: add an internal readonly session-counter snapshot accessor distinguishing `syntaxFiles`, `syntaxBytes`, `syntaxImports`, `syntaxNodes`, `semanticNodes` and cumulative `responseBytes`. Preserve existing per-call `ParserBatch` behavior; the relationship result uses cumulative syntax-only counters and semantics returns its own consumption. Source-file/source-byte/import counts are unique syntax/discovery counts and are not charged a second time by semantic reparse. All explicit semantic CST visits, including prevalidation/extraction on failures, consume the same session `maxAstNodesTotal`; cap each file's traversal by `maxAstNodesPerFile`. On an untrusted/killed job charge its full granted remaining node allowance, as existing syntax jobs do; never reset nodes/output across disposable children. Slang's lazy binding engine has no proven internal node counter: bound it by component inputs and the killable wall-clock deadline, and document that distinction. Keep record/site/evidence/candidate fanout bounded by the graph budget and wire ceilings. On timeout/abort/validation rejection, dispose the child before accepting another job. Failed semantics never overwrite original parsed records/007 metrics.

**Verify:** `pnpm exec vitest run --project unit test/unit/parser-protocol.test.ts` and `pnpm test:integration -- test/integration/relationships.test.ts test/integration/parser-worker.test.ts test/research/slang-spike.test.ts` → each exit 0. Cover exact-bound/one-over component files/bytes, mixed disjoint and overlapping grammars, exact override, common-grammar parse failure, unknown callbacks, BOM/CRLF/Unicode name-vs-declaration offsets, startup/build/binding stalls, active abort, parent-validation cutoff, forged candidates/counters, malformed/oversized frames and cumulative budgets across syntax → semantics → syntax. Verify no child remains after every termination case and the production inventory is unchanged.

### Step 4: Produce inheritance and call facts without inventing dispatch

Implement pure `inheritance.ts`, `calls.ts` and graph helpers; build DTO tests independent of Slang. Native semantic assertions go in integration, following the 002 capability fixtures with hand-written expected IDs/ranges/candidates. Do not put built-worker tests in the unit project.

Inheritance: one direct edge per declared base in source order. Only a single verified contract definition yields `resolved-unique`; named alias candidate sets stay ambiguous, missing references unresolved. Use canonical file plus kind plus mapped declaration range, never a global short-name lookup. Compute ancestor sets/depth only when every reachable direct base is resolved and the subgraph acyclic: root depth 0, otherwise `1 + max(base depth)`, ancestor IDs unique/sorted. A diamond has one shared ancestor. Cyclic or unresolved reachable bases make all transitive measurements for affected descendants unavailable with reason/evidence retained on direct edges; independent subgraphs remain measurable. Ancestor-declared-callable refs union declarations from ancestors without changing any source/callable totals or claiming effective C3/override membership. Use iterative traversal to avoid stack overflow.

Calls: join semantic sites to existing `call-site` events by original owner/range. Keep symbol candidates separate from dispatch. Overloads, named aliases and function-pointer variables must not become unique callable targets. A unique interface member or `this`/`super` reference can remain unique **symbol evidence** in the companion while its public call edge is `unsupported` and carries candidates when dispatch is unproven. Statically qualified library references may yield a resolved call edge only when the namespace and callable definitions are unique and match a tested static case; otherwise retain candidates/limitations. Internal/self calls never produce self-pairs. Do not infer a runtime external address or select overrides from a single member name.

Builtin low-level calls: 007 candidates stay unchanged. Confirmation requires an explicitly tested binding to a builtin or a verified address receiver category; custom `call`/`transfer` functions are not builtins. The existing spike does not prove general receiver typing, so initial unsupported cases **remain unknown and produce unavailable confirmed counts**. A pure synthetic DTO test cannot prove native builtin support. Any new confirmed/rejected native category needs a hand-authored positive/counterexample integration test and a documented narrow rule; broad typing/alias normalization needs a plan amendment. Delegatecall/assembly are effort evidence, never vulnerability claims.

**Verify:** `pnpm exec vitest run --project unit test/unit/relationships.test.ts -t 'inheritance and identity|calls and pairs'` and `pnpm test:integration -- test/integration/relationships.test.ts` → exit 0. Cover duplicate contract names, namespace/direct and named-alias bases, exact diamond IDs/depth, unresolved/cyclic descendants, inherited declaration deduplication, repeat/self/internal/static-library/interface calls, `this`/`super`, overloads, custom call/transfer, address candidates and function pointers. Assert every unknown case's exact status, absence of `to`, noninflated totals and conservative builtin measurement.

### Step 5: Deduplicate pairs, enforce graph limits and document the handoff

Wire `resolveRelationships` in `closure.ts` to closure → components → semantic jobs → facts → pairs/fingerprint, retaining all earlier failures. In `graph.ts`, derive pairs only from direct resolved inheritance and dispatch-proven cross-contract call edges. Pair owner/target declarations map to known files. Require a still-eligible first-party scoped owner. If target is also eligible first-party scoped, add a scoped pair; if target is context, add a context pair. Skip self-pairs, unknown/ineligible endpoints and free-function/file endpoints. Imports alone create only file-level graph observations, including interface/constants/free-function-only and unused imports. Do not attribute an import to every contract in its file. Named candidates and unresolved runtime dispatch remain observations rather than pairs. Context can have first/third/unknown ownership; it never receives a scope baseline.

Union kinds and distinct evidence for each ordered `(leftId,rightId)` once; reverse direction is a separate pair. Direct inheritance plus call evidence for the same endpoints yields one pair. Do not materialize transitive ancestor pairs. Return sorted disjoint partitions; the same pair cannot occur in both. Later 013 filters again for eligible syntax files before passing IDs to `EstimateInput`.

Use one analysis-level graph allowance (`maxGraphEdges`, default 100,000) shared across public graph/import rows, semantic sites, candidate/evidence references and derived pair/ancestor references. Charge each retained collection element, including candidate fanout and per-site evidence, before adding it; duplicate references stored in multiple collections cost multiple slots. This is deliberately conservative. Avoid Cartesian materialization and O(n²) ancestor/pair fanout without an allowance check. Run cooperative budget checkpoints in parent loops. Exhaustion yields `LIMIT_EXCEEDED`, unavailable affected companion measurements and incomplete coverage, not a truncated complete graph. Output arrays must also fit existing schema field/collection bounds (e.g. 10,000 candidates/evidence per edge and 100,000 public graph rows); a smaller field limit fails explicitly rather than widening schemas. Include exact-bound/one-over and large-diamond reduced-limit tests.

Write `docs/relationships.md` with this internal API, lookup precedence and local-subset differences, canonical alias convention, safety/ownership rules, component grammar policy, node/response/graph accounting, completeness table, evidence/dispatch/builtin limits and deterministic fingerprint inputs. Update ADR 005 for the actual semantic protocol/API/counters/lifecycle; keep its original safety promises. Explain how 009/013 consume the companion without publishing unsupported fields, and defer user-defined storage classification explicitly.

**Verify:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm schemas:check` → each exit 0. Unit pairs assert exact endpoint/kind/evidence sets and permutations, repeated sites, reverse direction, mixed inheritance/call deduplication, no unused-import charge, invalidated ownership removal, no transitive pairs, no unknown dispatch charge, independent completeness/unknown flags, exact/overflow fanout limits and stable fingerprints when context bytes/remappings change.

## Test plan

- Pure units: follow `test/unit/structural-metrics.test.ts` for explicit DTO construction and hand-calculated assertions; no Slang or `dist/` dependencies. Organize `relationships.test.ts` with the exact describe names used by the step filters.
- Native integration: follow `test/integration/structural-extraction.test.ts`, `test/helpers/parse-source.ts` and parser-worker tests, closing all sessions in `finally`. Use real discovery/readers for closure; use the fake child seam only for protocol/resource failures. Synthetic DTOs do not substitute for native alias/dispatch claims.
- Fixtures: commit small MIT hand-authored files with independent expected identities, byte/line counts, grammar and edge/status oracles. Reuse existing spike fixtures as read-only evidence. Never generate expected values from the implementation or replace old fixture oracles wholesale.
- Determinism and safety: permute initial inputs/remappings/candidates; change cwd and hostile loader environment using the existing helper pattern; verify target marker scripts/configs never execute. Use escaped Unicode/BOM literals in TypeScript, not pasted invisible characters. Preserve original-byte evidence.

## Done criteria

All must hold:

- [ ] Every verification command above exits 0 with the named tests present; full `pnpm test:all` and `pnpm schemas:check` use fresh builds.
- [ ] Existing syntax-worker/007 metric assertions and ten-artifact inventory pass unchanged in meaning; new protocol tests exercise both request kinds.
- [ ] New native tests prove exact declaration mapping, unknown preservation, shared budgets, cancellation/timeout cleanup and original syntax survival after unavailable semantics.
- [ ] Every produced graph/import record validates through exported `RelationshipResultSchema` / `ImportReferenceSchema`; no nonresolved edge has `to`, no unresolved import has a fabricated target, and pair partitions are disjoint.
- [ ] Copies count separately, shared physical identities once, inherited source never added to syntax totals, and all count/fanout limits have exact-bound/overflow tests.
- [ ] `git diff 892073d -- src/domain schemas src/config src/discovery src/metrics src/parser/extract-syntax.ts src/parser/ranges.ts src/parser/version-policy.ts src/index.ts package.json pnpm-lock.yaml tsdown.config.ts` is empty (or only a reconciled prerequisite diff recorded before execution).
- [ ] `git diff --name-only` plus untracked-file inspection, compared with the recorded starting status, shows only allowed implementation paths and the 008 status row. Do not delete unrelated existing plan edits.
- [ ] `docs/relationships.md` and the amended semantic-job ADR sections describe the final implementation; status 008 records gates and any platform limits.

## STOP conditions

Stop and report, without improvising, if:

- Baseline excerpts/contracts differ incompatibly, initial syntax did not come from the supplied session, or source identities cannot be joined without changing them.
- The implementation needs an out-of-scope file, dependency, build entry/chunk or public schema/version change.
- A previously proven 002 binding case changes under the pinned Slang release, or unique call/runtime claims require unproved alias normalization, C3, type inference or receiver dispatch. Ordinary unknown outcomes themselves are expected and do not block implementation.
- Safety would require dropping root/target/link policy, or anyone requires remote/compiler/project execution. Report that import as unavailable under current policy; do not implement a bypass.
- Bounded semantic frames, cumulative accounting or kill/reap behavior cannot be preserved using the existing supervisor.
- A verification command fails twice after a reasonable fix, an old fixture oracle must change without a source-grounded explanation, or the ten-artifact inventory changes.

## Maintenance notes

Lookup/alias/ownership policy changes affect relationship fingerprints and future estimates. Public DTOs stay frozen; structured companion publication requires a separate schema review. Keep named aliases, overloads, symbol references and runtime dispatch distinct, and extend native capability only with counterexamples. Slang upgrades must rerun both the research matrix and semantic boundary regressions. Deadline/heap isolation is not an OS sandbox or a WASM/RSS ceiling; this review makes no cross-platform claims. Later 009/013 plan reviews must use this companion contract and preserve unavailable storage/builtin measurements instead of coercing them to zero.
