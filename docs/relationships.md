# Import closure and contract relationships

This is the internal relationship layer implemented by plan 008 (`src/relationships/`). It is a source-internal API: nothing here is a package export, a public schema field or a report field. Plans 009 and 013 consume it. It never changes `METRICS_VERSION` `1.0.0` measurements and never runs target scripts, compilers or other target-provided executables ([ADR 004](adr/004-scope-safety.md), [ADR 005](adr/005-parser-boundary.md)).

The layer answers four questions about a discovered scope, using only local data:

1. Which root-local files do the scoped files depend on, and who owns them? (import closure)
2. Which import-connected groups of files can be bound together? (components)
3. Which declared bases, ancestors and call targets can be verified? (inheritance and call facts)
4. Which ordered contract pairs carry audit interaction effort? (pairs)

An unresolved target is a result, not permission to guess. No fallback performs a global name search.

## Internal API

`resolveRelationships(input): Promise<RelationshipAnalysis>` in `closure.ts` runs the whole pipeline. `resolveImportClosure(input)` runs only the closure phase and returns `ImportClosureResult`.

The input holds the discovery result, the captured reader `SafePathContext` (including the optional `target`/`lexicalTarget` confinement, which is never removed to make an import succeed), the `IdentityRegistry`, the shared `DiscoveryBudget`, the resolved config, the metadata result, the **same** parser session that produced the initial syntax, and that initial `ParserBatch`. The session type is named with `ReturnType<typeof createParserSession>`. The caller closes the session in `finally`; this layer never creates a budget or session and never rediscovers the root.

Before doing any work the closure phase rejects input that does not match: every snapshot must match its manifest entry and be registered with the identity registry, every scoped snapshot needs an initial outcome, and each outcome must be exactly the accepted result cached by the session for that file ID and byte hash (or a failed outcome that was never cached). A mismatch throws `TypeError`.

`RelationshipAnalysis` fields:

| Field                                                                           | Meaning                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`, `sources`, `syntax`                                                 | The immutable final manifest, unique `ParserSource` records and the merged syntax batch. `syntax.visitedNodes` and `processedBytes` are the session's syntax-only counters, so repeated cache hits are not summed.                           |
| `imports`, `graphs`                                                             | `ImportReference[]` and `RelationshipResult[]` that obey the exported schemas. Import graph endpoints are file IDs, inheritance endpoints contract IDs. A call source is the containing callable ID, else its contract ID, else the file ID. |
| `importObservations`                                                            | Per import: strategy, applied remapping provenance, every probed path with its outcome, candidate file IDs and a fixed failure reason. The decoded specifier, the normalized lookup name and the final canonical file ID are kept separate.  |
| `importCycles`                                                                  | Sorted nontrivial import SCCs (plus a one-file SCC for a self-import). A structural observation, not an inheritance validity claim.                                                                                                          |
| `components`                                                                    | Component ID (smallest member file ID), sorted members, the common grammar or `null`, `available`/`unavailable` and a fixed reason.                                                                                                          |
| `inheritance`, `directBaseEdges`                                                | Declared-order direct base edges and, per contract, ancestor IDs, maximum depth and ancestor-declared callable IDs as `Measurement`s.                                                                                                        |
| `callSites`                                                                     | One fact per syntax `call-site` event with raw definition locations, symbol status, dispatch, built-in classification and a fixed limitation reason.                                                                                         |
| `scopedPairs`, `contextPairs`                                                   | Disjoint, sorted directed contract pairs `{ leftId, rightId, kinds, evidence }`. 013 maps the two IDs onto `EstimateInput` pairs; this layer never calls the estimator.                                                                      |
| `confirmedBuiltinLowLevelCalls`                                                 | A per-file `Measurement<number>` kept separate from the unchanged syntax `lowLevelCallCandidates`.                                                                                                                                           |
| `invalidatedScopedFileIds`                                                      | Scoped IDs whose later alias ownership disqualifies first-party eligibility.                                                                                                                                                                 |
| `diagnostics`, `requiredAnalysisComplete`, `hasUnknownSemantics`, `fingerprint` | Deduplicated diagnostics, the two independent flags below, and the relationship fingerprint.                                                                                                                                                 |

## Lookup rules (the analyzer's local subset)

The rules are modeled on the [official Solidity path-resolution rules](https://docs.soliditylang.org/en/latest/path-resolution.html#import-remapping) but are a documented **local subset**, not compiler or Foundry equivalence. Where they are stricter than solc, the difference is intentional.

1. **Specifier.** The already decoded `ParserImport.specifier` is used; it is never decoded again. Schemes, absolute/drive/UNC paths, backslashes, NUL/control characters and empty names or segments are rejected (`invalid-specifier`) before any native path conversion. `./` and `../` names are resolved against the importer's canonical root-relative path; a traversal above the root is rejected (`outside-root`) before normalization can erase it. Direct names such as `contracts/Base.sol` stay root-relative.
2. **Source-unit name.** The importer's frozen canonical root-relative POSIX path is the source-unit name. Relative segments are resolved before remapping.
3. **Remapping array.** The array is chosen as a whole by existing provenance, never concatenated: explicit estimator config (including `[]`) replaces Foundry `foundry.toml` remappings (including `[]`), which replace `remappings.txt`. `remappings.txt` is read once, only when `imports.remappings` provenance is `default`, through `readMetadataFile` with the shared budget, symlink rejection and the 256 KiB ceiling. It accepts fatal UTF-8, one initial BOM, LF/CRLF/CR, blank lines and full-line `#` comments; every other line must be `[context:]prefix=target` with exactly one `=`, a nonempty prefix and target, and at most one context separator. At most 1,000 entries are accepted. There is no shell expansion and no inline comment. Contexts and targets are confined root-relative paths, never URLs. A malformed or oversized active file is diagnosed, no partial list is used, and import coverage is incomplete.
4. **Ranking.** The context matches the canonical importer (`.` or no context is global; otherwise the importer must equal the context or be a directory descendant of it). Entries are ranked by **longest context first, then longest prefix**. Identical duplicates collapse. Equal-ranked entries with different targets are an `ambiguous` import with `IMPORT_UNRESOLVED`; unlike solc's last-wins rule, order never decides. A remapping is applied once and never recursively.
5. **Application.** Config normalization strips trailing slashes from targets. A prefix ending in `/` is a directory mapping: the target and the suffix are joined with exactly one `/` (target `.` means the root). Any other prefix is an exact/file-style mapping: the prefix is replaced literally by the target. The result is revalidated for traversal and emptiness.
6. **Candidates.** A matched remapping is authoritative: its single path is the only candidate even if the file is missing or blocked, and there is no fallback. Without a remapping a relative name has one candidate. A direct name has a bounded set: `<root>/<name>`, `<root>/node_modules/<name>` and, for each validated `metadata.paths.libs` entry, `<lib>/<package>/src/<rest>` (a package is one segment or `@scope/name`). There is no inferred lib directory, recursive search, extension guessing, package `exports`, JS `require.resolve` or package-file execution.
7. **Uniqueness.** More than one distinct safe physical file is `ambiguous`; several aliases of one identity are one candidate. A blocked or unreadable candidate is an explicit limitation (`blocked-candidate`) and never proves absence, so a clean unique result is not produced next to it.

Probes use `resolveSafePath` and reads use `readSource`, both under `budget.checkpoint()`. Outside-root pnpm-style symlinks remain unsupported.

### Canonical identity and aliases

This layer deduplicates by **physical** identity, which differs from solc (it can treat aliases as different source units). The first physical path read freezes the file ID through the registry; a later, smaller alias cannot rename an ID that was already published. Every alias seen while probing is registered, and after the closure each file's aliases are reclassified with `reevaluateIdentityOwnership` using the original scoped IDs. Copies with identical bytes at different paths are distinct files; a shared physical file is read, parsed and counted once.

## Closure and scope

Closure expansion is deterministic: files are ordered by canonical ID and imports by source range. New files are always **context**, never automatically scoped; first-, third-party and unknown ownership are preserved. Existing scoped imports stay scoped. A safe, excluded first-party file that is imported becomes context and is disclosed with a `PARTIAL_ANALYSIS` omitted-audit-dependency notice. `.git`, outside-root, outside-target and forbidden-symlink paths stay blocked.

If a later alias makes a previously scoped file's ownership conflict, the ID and snapshot are kept, the manifest entry becomes `context` with the updated ownership, the ID appears in `invalidatedScopedFileIds`, and the analysis is incomplete.

Defaults are 2,000 files, 64 MiB of source and 20,000 imports; the effective configured limits are used. On a limit the accepted evidence is kept, the unfinished imports become `unresolved` with reason `limit`, and no further work is scheduled under the exhausted budget. A single file over `maxFileBytes` affects only its own import. Cancellation propagates the established cancelled `BudgetError` after the caller's cleanup.

## Components and grammar policy

`components.ts` partitions resolved import connectivity as an undirected graph, including isolated files. A component is **unavailable** when any member's syntax failed (`member-syntax-failed`), any member import is unresolved/ambiguous/blocked (`unresolved-import`), no installed grammar is common to all members (`no-common-grammar`), an exact `cli`/`config` version is not in the intersection (`authority-excludes-grammar`), the component exceeds the effective file/byte limits (`component-too-large`) or has no scoped member (`no-scoped-member`). Foundry metadata and the default version are hints only. With no exact authority the numerically highest version in the intersection of every member's `compatibleVersions` is selected. The common grammar is recorded separately from each file's original selected syntax version, which is never rewritten.

## Semantic jobs

Binding runs in a **fresh disposable child** launched by the same trusted supervisor as syntax jobs, serialized with syntax calls on the same session and terminated and reaped after success or failure. The protocol (version 2) adds an explicit `semantic-component` job; see [ADR 005](adr/005-parser-boundary.md) for framing and lifecycle.

Defaults are 128 files, 8 MiB and 10 seconds per component, tightened by the shared deadline and by configuration within the schema ceilings. The request carries only canonical paths, file IDs, original text with byte hashes, resolved import lookup entries (importer ID, import ID, decoded specifier, original-byte `specifierRange` and target file ID) and the remaining traversal and record allowances. No absolute path, environment or project executable crosses IPC, and the child answers import and file callbacks only from the supplied in-memory map.

The child verifies every file's bytes, hash and BOM reconstruction, parses **every** member under the common grammar, and only then reads bindings. It maps Slang's `resolveImport` callback by **location**: the callback cursor's `textRange` is mapped to original-byte coordinates (BOM and CRLF aware) and must match exactly one lookup entry for that importer. Repeated decoded specifiers at different ranges stay separate sites, and escaped spellings such as `\x62` or `b` never need re-decoding. Duplicate, forged, unmatched or missing mappings make the component unavailable with the fixed reason `import-mapping`. Definition cursors that point at a name token are mapped to the original declaration through `nameRange` and checked against the accepted syntax declarations, so a reply cannot claim a callable at a name where syntax found none.

Replies contain plain site records only. The parent validates strict keys, IDs, original-byte ranges, ownership, component membership, exact call-site coverage against the syntax `call-site` events, ordinal continuity and consumption counters. A reply failing any check is discarded; the original syntax result is untouched.

## Facts without invented dispatch

### Inheritance

One direct edge per declared base, in source order. Only a single verified contract definition yields `resolved-unique`. A named import alias returns both the alias symbol and the imported definition (Slang 1.3.9), so the candidate set is kept and the edge stays `ambiguous`; a missing reference is `unresolved`. Identity is canonical file plus kind plus mapped declaration range; no global short-name lookup exists. Ancestor IDs, maximum depth (a root has depth 0, otherwise `1 + max(base depth)`) and ancestor-declared callable IDs are computed iteratively and **only** when every reachable direct base is resolved and the reachable subgraph is acyclic. Otherwise they are unavailable (`unresolved-base`, `inheritance-cycle`, `semantics-unavailable` or `graph-limit`) with the evidence kept on the direct edges; independent subgraphs stay measurable. The callable list is declaration references in ancestors. It does not claim effective C3 membership, visibility, overrides or dispatch, and it never adds to source or callable totals.

### Calls

Each fact keeps **symbol resolution** (`unique`, `candidates`, `none`, `builtin`, `type-conversion`, `non-callable`, `unavailable`) separate from **dispatch** (`static`, `dynamic`, `unknown`, `not-applicable`) and states a fixed limitation:

| Situation                                                        | Symbol            | Dispatch         | Public edge                   |
| ---------------------------------------------------------------- | ----------------- | ---------------- | ----------------------------- |
| Free function, uniquely bound                                    | `unique`          | `static`         | `resolved-unique`             |
| Library member through a receiver that binds only to the library | `unique`          | `static`         | `resolved-unique`             |
| Internal call to a contract function                             | `unique`          | `dynamic`        | `unsupported`, candidate kept |
| Interface/contract-typed variable receiver                       | `unique`          | `dynamic`        | `unsupported`, candidate kept |
| `this.f()` / `super.f()`                                         | `unique`          | `dynamic`        | `unsupported`, candidate kept |
| Overloads or alias candidates                                    | `candidates`      | `unknown`        | `ambiguous`                   |
| Function-pointer variable or other non-callable                  | `non-callable`    | `unknown`        | `unsupported`, no candidate   |
| Built-in member (`abi.encode`, `require`, address members)       | `builtin`         | `not-applicable` | none (companion fact only)    |
| Type conversion or `new`                                         | `type-conversion` | `not-applicable` | none                          |

Internal calls are `dynamic` because the syntax layer does not record `virtual`, so an override cannot be excluded; a library receiver written through a named import alias returns alias candidates and is therefore not `static`. Nothing infers a runtime external address or selects an override from a member name.

### Built-in low-level calls

007's `lowLevelCallCandidates` stays an unchanged syntax count. This layer adds a **separate** per-file confirmed count. A candidate is `confirmed` only when its member name is one of `call`, `delegatecall`, `staticcall`, `callcode`, `send` or `transfer` **and** Slang binds that member exclusively to built-in definitions on a resolved receiver; this is tested for `address` parameters, `payable(...)` conversions and `msg.sender`. It is `rejected` when every definition is a user-defined callable (a custom `transfer` or library `call`). Every other shape, including legacy `.call.value(...)` and any receiver Slang could not type, is `unknown`. The confirmed count is measured (zero is allowed) only when every candidate in the file was confirmed or rejected; any unknown candidate, failed syntax, unavailable component or dropped site makes it unavailable. Delegatecall and assembly are effort evidence, never vulnerability claims. Broader receiver typing or alias normalization needs a separate reviewed plan.

### Storage shapes

User-defined storage refinement is deferred. If any scoped mutable (not `constant` or `immutable`) state-variable event has shape `user-defined` or `unknown`, `hasUnknownSemantics` is true. Later consumers must mark storage classification that depends on it unavailable instead of treating the syntax-only complex-ID list as an exhaustive non-complex proof.

## Pairs

`graph.ts` derives pairs only from direct `resolved-unique` inheritance edges and from `static` resolved call edges whose target callable belongs to a different contract. The owner must be an eligible first-party scoped contract. A scoped first-party target gives a scoped pair, a context target a context pair. Self-pairs, unknown or ineligible endpoints and free-function/file endpoints are skipped. Imports alone create only file-level observations, so interface-only, constants-only and unused imports never create a pair, and an import is never attributed to every contract in its file. Kinds and distinct evidence are united per ordered `(leftId, rightId)`; the reverse direction is a separate pair; no transitive ancestor pairs are materialized. The scoped and context partitions are disjoint and sorted. 013 filters again for eligible syntax files before building `EstimateInput`.

## Accounting

- `session.counters` is an internal readonly snapshot: `syntaxFiles`, `syntaxBytes`, `syntaxImports`, `syntaxNodes`, `semanticNodes` and cumulative `responseBytes`. Syntax and semantic nodes share `maxAstNodesTotal`; each file's semantic traversal is capped by `maxAstNodesPerFile`. A killed or untrusted semantic job is charged its full granted allowance, never reset across disposable children.
- Source files, source bytes and imports are unique syntax/discovery counts and are not charged again by a semantic reparse. `DiscoveryBudget` owns filesystem and read accounting.
- Slang's lazy binding engine has no proven internal node counter. It is bounded by the component inputs, the record allowance and the killable wall-clock deadline, not by node counting, and `--max-old-space-size=64` is a JavaScript heap limit rather than a WASM or RSS ceiling.
- One graph allowance (`maxGraphEdges`, default 100,000) is shared by public import and graph rows, semantic sites, candidate and evidence references, and derived ancestor and pair references. Every retained element is charged before it is added, so a reference stored in several collections costs several slots. Exhaustion yields `LIMIT_EXCEEDED`, unavailable affected measurements and incomplete coverage, never a truncated complete graph. Public rows are also checked against the schema field bounds (100,000 rows, 10,000 candidates or evidence per edge, 512-character identifiers); a row that cannot fit is dropped and reported, and no schema is widened.

## Completeness

| Situation                                                                                                                | `requiredAnalysisComplete`                                    | `hasUnknownSemantics` |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | --------------------- |
| All required work succeeded, no unknown sites                                                                            | preserves the prerequisite                                    | false                 |
| Dynamic receiver, overload/function-pointer/alias candidate, unconfirmed built-in, unresolved mutable storage shape only | preserves the prerequisite                                    | true                  |
| Missing, ambiguous or blocked import; failed context syntax; unavailable component; unresolved base or inheritance cycle | false                                                         | true                  |
| Resource, deadline or protocol failure; invalidated scoped ownership                                                     | false                                                         | true                  |
| Safe scoped-out first-party context analyzed successfully                                                                | preserves the prerequisite, with an omitted-dependency notice | per other evidence    |

The prerequisite is `discovery.complete && initialSyntax.complete`; a false prerequisite is never upgraded. Ordinary dynamic-call uncertainty is not a parse failure.

## Fingerprint

`fingerprint` is a length-framed hash (`fingerprint`/`canonicalJson`) over sorted canonical file IDs, original byte hashes, final roles and ownership, each import's effective lookup and remapping decision, the semantic configuration (active remappings and their source, validated `libs`, version authority and the relevant limits), the parser version, every file's selected syntax version, the component grammars and statuses, and the invalidated IDs. It contains no absolute paths, inode or device keys, timing or host data. Permuting discovery snapshots or manifest entries does not change it; changing context bytes, a remapping, a library path or a grammar does. 013 combines it with the other phase fingerprints.

## Consuming the companion

009 and 013 may read `inheritance`, `callSites`, the pair partitions and `confirmedBuiltinLowLevelCalls` as an internal companion. None of it is published: the public `Analysis.graphs` carries only the schema-valid rows, and structured companion publication needs a separate schema review. Unavailable builtin and ancestor measurements must stay unavailable and must not be coerced to zero.

## Verification

Pure rules are covered by `test/unit/relationships.test.ts` (describe blocks `resolution and remappings`, `semantic components`, `inheritance and identity`, `calls and pairs`, `completeness and fingerprint`) and protocol envelopes by `test/unit/parser-protocol.test.ts`. Native behavior is covered by `test/integration/imports.test.ts`, `test/integration/relationships.test.ts` and the hostile-child cases in `test/integration/parser-worker.test.ts`, using the hand-written fixtures under `test/fixtures/relationships/` (listed in `test/fixtures/manifest.json` with independently counted bytes and lines). A Slang upgrade must rerun the research matrix and these semantic boundary regressions. Evidence was gathered on Darwin arm64 only; Linux and Windows termination, filesystem-link and packaging behavior are untested.
