# ADR 005: Version-aware parser in a bounded trusted subprocess

Status: accepted for the internal syntax-analysis layer.

## Context

Slang parsing and pragma inference are synchronous native/WASM-backed operations. Running them on the caller's thread would make a promise timeout ineffective and let parser failures take down the analysis process. Parser output also needs a reviewed wire format: AST objects, cursors, and `ParseOutput` instances are not stable serializable domain data. This ADR defines the private boundary consumed by plans 007, 008, and 013. It does not add public metrics, change schemas, or wire parsing into the CLI.

## Session and result contract

The internal API is `createParserSession({ budget, config })`, `analyzeSources(session, sources)`, and awaited `session.close()`. A `ParserSource` pairs its existing `SourceSnapshot`, derived `fileIdentity`, and matching manifest entry. `ParserBatch` contains per-file parse outcomes, parse diagnostics, completion state, visited-node count, and processed source bytes. It is not `SyntaxBatch`: physical lines and final measurements remain later consumer responsibilities.

One session accepts one analysis call at a time and sends at most one `parse-file` request at a time. It sorts by file ID, sends one source per request, caches accepted outcomes by file identity and byte hash, and retains unique-file, byte, node, import, and response counters across later calls and worker recycling. Reusing an identity with different bytes fails closed. Cache hits still check cancellation and the shared deadline before returning.

The parent verifies file IDs, canonical paths, manifest hashes, UTF-8 decoding with the original BOM preserved, source text, and SHA-256. It checks source byte length against per-file and remaining unique-session limits before copying, decoding, or hashing the bytes. The child re-encodes the text, rejects invalid or non-round-tripping UTF-8 including unpaired surrogates, and verifies the supplied hash before parsing. Only the canonical relative path, file ID, source text/hash, effective limits, and version authority cross IPC; `absolutePath`, target configuration, and executable settings do not.

## Version and syntax policy

On startup the worker emits one `ready` record containing protocol version, Slang version, and the exact installed grammar set. The parent validates it and compares every successful file's parser and installed-version metadata against that record. The child obtains pragma evidence from the pinned Slang concrete syntax tree; it does not infer pragma absence from a regular expression or from candidate-set size. Broad constraints can match every installed grammar while still being present. Malformed pragma evidence and invalid syntax fail without recovered declarations or fallback retries.

The pure version policy applies the request's provenance. `cli` and `config` versions are exact constraints, `metadata` is a hint that can be ignored with a fixed warning, and a populated `default` is not treated as an override. With no Solidity version pragma, an accepted explicit version or valid metadata hint may still select the grammar, and the result carries the fixed absent-constraint warning. Otherwise selection is deterministic over numerically ordered installed versions. Before accepting a parsed reply, the parent recomputes this selection from the validated ready set, candidate set, pragma ranges, and request authority, then checks selected version, selection source, ignored-hint status, and warning records.

The child emits bounded tokens, declarations, imports, generic events, version evidence, and diagnostics as plain DTOs. Event fields are `{ fileId, kind, contractId, callableId, range, attributes }`; 006 emits only declaration, import, and pragma events. Declaration/import records retain richer details. Attribute keys and kinds are lowercase kebab-case labels, values are scalar, and record names/specifiers have explicit length bounds. Imports preserve CST-derived `bare`, `namespace`, or `named` alias form and are not resolved here.

Import paths decode `\\xNN` as one byte and `\\uNNNN` as a UTF-8 encoded Unicode scalar; a backslash followed by an actual newline contributes no path byte. Decoding uses fatal UTF-8 validation. Overlong decoded paths remain `LIMIT_EXCEEDED`; a syntactically accepted import whose escaped bytes cannot be represented as UTF-8 returns a sanitized `INTERNAL_ERROR` with no recovered records, rather than being reported as invalid Solidity syntax. These rules follow the [Solidity string literal escape specification](https://docs.soliditylang.org/en/latest/types.html#string-literals-and-types).

Explicit declaration attributes are collected only from the declaration's CST attribute section. Function body ranges use that declaration's `FunctionBody` block variant; nested control-flow blocks do not replace the outer range, and a semicolon-only function has no body range.

## Coordinates and source fidelity

Snapshots keep their original text and bytes. Exactly one leading UTF-8 BOM is excluded from the Slang parser and inference view; interior or repeated U+FEFF characters, line endings, and token text are not rewritten. For a removed leading BOM, both Slang range endpoints are first shifted by three original UTF-8 bytes, one UTF-16 unit, and one scalar column on line zero. Domain ranges then retain zero-based half-open byte offsets and use one-based line and Unicode-scalar columns. A linear source-coordinate index validates endpoints, UTF-8 boundaries, EOF positions, declaration ownership, and event ownership.

After a valid parse, the child reconstructs the source from the recorded BOM plus `tree.unparse()` and checks exact original bytes and SHA-256. Invalid trees return diagnostics only. Diagnostic traversal is bounded; an over-limit result becomes `LIMIT_EXCEEDED` rather than a silently truncated success.

## IPC, limits, and disposal

The parent and worker use four-byte unsigned big-endian length-prefixed UTF-8 JSON frames. Advertised lengths are checked before payload allocation or JSON parsing. The decoder handles fragmented/coalesced chunks, rejects truncation, bounds frames, and caps frames per received chunk. IPC results use flat records and strict key/range/owner/identity checks. Parent validation yields and checks both the shared budget and per-file cutoff every 256 records and pragma ranges, then checks again before accepting the result.

| Boundary                  | Fixed or configured limit                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request payload           | `6 * maxFileBytes + 64 KiB`, with safe-integer and 32-bit frame checks                                                                            |
| Worker response frame     | 32 MiB                                                                                                                                            |
| Accepted response bytes   | 64 MiB per parser session, including startup metadata                                                                                             |
| Ready grammar set         | At most 256 exact-version strings, each at most 128 code units                                                                                    |
| Diagnostics               | 256 per file; each message at most 512 code units and 1,024 UTF-8 bytes                                                                           |
| Generic event             | At most 32 attributes; labels at most 128 code units and string values at most 512                                                                |
| Declaration/import fields | Names at most 128 and decoded import specifiers at most 512 code units                                                                            |
| Record validation ceiling | 2,000,000 records per file, further bounded by the effective configured node allowance                                                            |
| Parser defaults           | 200,000 visited CST nodes per file and 2,000,000 per session; configured limits remain authoritative                                              |
| Worker lifecycle          | 64 MiB V8 old-space flag; recycle after 32 completed files or 8 MiB processed input                                                               |
| Deadline and termination  | Minimum of shared application deadline and configured per-file timeout; 100 ms graceful termination, force-kill, then a 5-second cleanup watchdog |

Timeouts and traversal/transport exhaustion become per-file `LIMIT_EXCEEDED` outcomes and do not retry the file. A killed or otherwise untrusted reply without confirmed consumption charges the full node allowance granted to that file; imports from an unaccepted reply are not counted. Validated replies charge their confirmed counts. Independent files may continue while global resources remain. Cancellation terminates and reaps the worker, then propagates the existing cancelled `BudgetError` so the CLI layer can retain its established interrupt behavior.

The child is resolved only from the installed `audit-estimator` package entry and launched with `process.execPath`, a fixed heap flag, package-owned working directory, `shell: false`, pipes, and a minimal deterministic environment. No `process.execArgv` or loader/coverage/debug variables are inherited. Stderr is drained and discarded; native messages and stderr never enter diagnostics. Tests can inject a child only through the internal test-only supervisor seam; production APIs cannot select a worker path.

## Semantic-component jobs

Protocol version 2 adds one explicit job beside the unchanged `parse-file` job. `ParserWorkerRequest` and `WorkerReply` stay the parse-only types used by syntax extraction; the semantic types are separate (`SemanticWorkerRequest`, `SemanticWorkerReply`) and are joined with the parse types only in the `AnyWorkerRequest`/`AnyWorkerReply` unions and the worker's transport dispatcher. The session method is `session.analyzeSemanticComponent(input)` (with a named `analyzeSemanticComponent(session, input)` wrapper). It is serialized with `analyzeSources` through the same single-active-call rule and rejected after `close()`. Plan 008 is the only consumer ([relationships](../relationships.md)); the plan 007 syntax assertions are unchanged.

Each job starts a **fresh disposable child** through the same trusted supervisor (fixed launch, environment, stderr and heap policy, `shell: false`, package-resolved worker path) and terminates and reaps it after success or failure, so a stalled build or binding job cannot be reused. The input is a component ID (the smallest member file ID), one exact installed grammar, sorted members each paired with the accepted syntax result cached by this session for that file ID and hash, and the resolved import lookup entries. Lookup entries are keyed by importer ID plus the original-byte `specifierRange` of the path literal and carry the importer ID, import ID, decoded specifier and target file ID. No absolute path, environment or project executable is sent. Slang's `resolveImport` callback passes a cursor whose text is the raw quoted literal; the child therefore maps the callback cursor's `textRange` to original-byte coordinates (BOM and CRLF aware) and requires exactly one lookup entry, rather than stripping or decoding quotes.

The child verifies the supplied bytes against their hashes and BOM reconstruction, requires every member to parse under the common grammar before any binding access, and uses only the supplied in-memory map for both `readFile` and `resolveImport`. Replies contain base-site and call-site definition locations (an original-byte name range plus the defining node kind, or a built-in marker) and a consumption counter; Slang objects never cross the boundary.

Limits and accounting:

| Boundary                | Rule                                                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component size          | Defaults 128 files, 8 MiB, 10 seconds (`maxSemanticFiles`, `maxSemanticBytes`, `semanticTimeoutMs`), tightened by the shared deadline; the schema ceilings are 1,280 files, 80 MiB and 100 seconds.                        |
| Request frame           | Derived before encoding from effective text bytes, metadata code units, file and lookup counts and the six-times JSON escaping bound, and required to fit an unsigned 32-bit header. The old one-file ceiling is not used. |
| Child request decoding  | Strict keys, per-kind counts and byte caps are checked before any map is built or Slang is invoked.                                                                                                                        |
| Reply frame and session | The 32 MiB reply frame and 64 MiB cumulative response ceilings are unchanged. Semantic startup and reply frames count toward the session total; exceeding it is an incomplete outcome, not a raised ceiling.               |
| Traversal nodes         | Every explicit semantic CST visit consumes the session `maxAstNodesTotal`, shared with syntax, and is capped per file by `maxAstNodesPerFile`. A killed or untrusted job is charged its full granted allowance.            |
| Binding engine          | Slang's lazy binding graph has no proven internal node counter. It is bounded by the component inputs, the record allowance and the killable wall-clock deadline, not by node counting.                                    |
| Parent validation       | Strict key, ID, original-byte range, ownership and exact call-site coverage checks yield to the shared budget and job cutoff every 256 records.                                                                            |

`session.counters` returns the readonly internal snapshot `{ syntaxFiles, syntaxBytes, syntaxImports, syntaxNodes, semanticNodes, responseBytes }`. Source-file, source-byte and import counts are unique syntax counts and are not charged again by semantic reparsing. Per-call `ParserBatch` values keep their existing behavior; the relationship result reports the cumulative syntax-only counters. `session.cachedSyntax(fileId, byteHash)` returns the accepted syntax outcome for exactly that identity and bytes, which lets a caller prove a supplied batch came from this session.

A timeout, abort, validation rejection or protocol violation disposes the child before another job is accepted. Cancellation propagates the established cancelled `BudgetError` after the child is reaped. A failed job never overwrites cached syntax results or 007 metrics; it returns a fixed unavailable reason (`invalid-request`, `source-mismatch`, `grammar-unavailable`, `syntax-invalid`, `import-mapping`, `binding-failed`, `limit` or `protocol`). The semantic child inherits the same `--max-old-space-size=64` heap limit as syntax children; a component too large for that heap fails as an unavailable job rather than raising the limit.

## Verification and limits

The native bridge exercises package self-resolution, worker startup, Slang/WASM loading, parsing, and teardown from a different working directory. Integration coverage also exercises malformed and legacy syntax, absent/broad/multiple/malformed pragmas, source reconstruction, ranges, hostile loader variables, timeout and abort cleanup, duplicate/late replies, backpressure, counters across batches/recycling, forged records, and configured/resource ceilings. Source-only version, protocol, and range tests import parser policy/DTO code and do not import Slang.

Packaging validation intentionally requires exactly ten artifacts: `bin.js` and its map, `index.d.ts`, forwarding-only `index.js`, `version.js` and its map, shared `versions.js` and its map, and `parser/worker.js` and its map. The forwarding-only index has no map because it emits no implementation code; the worker imports version policy from the shared versions chunk. The bridge resolves the worker through the installed `audit-estimator` package name, so package-name or export-map changes must retest self-resolution. Plan 015 must retest the packed worker and WASM loading after any future packaging change.

Execution evidence for this decision was gathered on Node `24.21.0`, pnpm `11.28.4`, Darwin `arm64` (`Darwin 27.0.0`). Linux and Windows termination, environment, filesystem, and package-resolution behavior have not been tested here. `--max-old-space-size=64` limits the JavaScript heap, not WASM linear memory or process RSS. This adapter is a process boundary with deadlines, not a hard memory or operating-system sandbox; hard RSS containment needs an OS-level policy.

Plan 007 maps `ParserBatch` to existing analysis contracts. Plan 008 added the explicitly versioned semantic-component job described above and preserves per-file syntax evidence and the same framing, accounting and cleanup rules. Plan 013 retains discovery omissions, parser failures, and cancellation in final completeness and reporting. Parsing alone is not proof that Solidity compiles or binds.
