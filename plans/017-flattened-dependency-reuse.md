# Plan 017: Support explicit contract estimation scope and content-matched dependency reuse

> **Executor instructions**: Read this plan completely, then implement its steps in order. Run every verification command and check the stated result. Update only this plan's status row in `plans/README.md` when done. This is an implementation handoff, not evidence that the feature already exists.
>
> **Drift check (run first)**: `git diff --stat ba8a7b2..HEAD -- src/application src/domain src/config src/estimation src/metrics/structural.ts src/metrics/source.ts src/indicators/classify.ts src/reporting src/index.ts scripts test schemas docs examples`
>
> Compare the current-state excerpts below with the live files and inspect `git status --short` before editing. Expected unrelated dependency changes do not invalidate the plan. Stop on an incompatible change to the estimator, parser DTOs, schemas, or scope policy; preserve unrelated local edits.

## Status

- **Priority**: P1
- **Effort**: L — explicit scope selection, reference acquisition, deterministic recognition, model/config compatibility, projections, reporting, and regression coverage
- **Risk**: HIGH — false reuse matches or incomplete filtering could undercount custom code
- **Depends on**: implemented 003, 005–008, 010–013, and 015–016 contracts, present at `ba8a7b2`; no unimplemented prerequisite
- **Category**: direction — requested estimation-policy change with a concrete overcounting reproduction
- **Planned at**: commit `ba8a7b2`, 2026-10-16

## Why this matters

A flattened contract currently loses the path distinction between project code and dependencies. Familiar library implementations, their internal relationships, and their assembly are all priced as newly written project code. The user's example produces **96–457 cumulative auditor-hours**. Account for content-verified reuse without treating a package name, declaration name, or flattening comment as proof, while retaining work for custom logic and integration.

Also let a caller explicitly identify the declarations the estimate should cover. This works for forks, unsupported reference versions, and intentionally narrow audit engagements without needing a fingerprint match. Caller-excluded code is context selected by the caller, never evidence of verified reuse. Implement the shared projection and explicit scope path before catalog acquisition so external reference availability cannot block that capability.

This intentionally revises the original no-automatic-discount policy. Zero full-review cost for matched content is an uncalibrated reusable-source planning assumption, not a consequence proved by a hash or a conclusion that a release, deployment, or combination is secure. Do not lower global coefficients to make one sample look plausible. Contract selection and content recognition are independent inputs; failed recognition must never silently create a caller scope.

## Review amendment — 2026-10-16 at `ba8a7b2`

The following findings were checked against the live source. This is a review of this plan and its direct implementation dependencies, not a whole-repository audit. Effort refers to correcting the specification and implementing the affected behavior; all listed findings have HIGH confidence.

| Priority | Finding and impact | Effort / fix risk | Evidence and correction |
| --- | --- | --- | --- |
| P1 | No contract-level fallback exists; file filters cannot express which declarations in one flattened file should count. | L / HIGH | `src/domain/types.ts:215`, `src/application/analyze.ts:47`, `src/application/estimate-input.ts:84`. Add a distinct caller-supplied estimation scope, strict selector resolution, and separate exclusion accounting. |
| P1 | Generic recognition-exhaustion fallback could swallow cancellation or the shared deadline and return a successful estimate. | S / MED | `src/discovery/budget.ts:55`, `src/discovery/budget.ts:161`, `src/application/analyze.ts:133`. Propagate shared `BudgetError`; only a local recognizer allowance may fall back to full review. |
| P1 | Checking declarations/records alone does not bound hashing one very large declaration or literal. | M / MED | `src/parser/protocol.ts:26`, `src/parser/protocol.ts:82`. Check token/event work and byte chunks, with bounded incremental hashing instead of one large canonical token array. |
| P2 | The reference generator requires a built worker even when its entry imports source TypeScript. | S / LOW | `src/parser/adapter.ts:1114`, `src/parser/adapter.ts:1942`. Fresh-build before generation/check and close the parser session in `finally`. |
| P2 | Named upstream matches and strictly lower endpoints were acceptance requirements without established matches; boundary rates can exceed interaction rates. | M / MED | Reference candidates were not verified in this plan; `src/estimation/profiles/heuristic-v1.ts:18`. Add a reference-feasibility gate and verify the actual ledger rather than force a desired number or named match. |
| P1 | The proposed `reviewSummary` has no mode discriminator, although its validity and eligibility rules depend on the mode. An executor could accept contradictory reuse/exclusion facts. | S / MED | Design section 3 below; `src/domain/schemas.ts:492`, `src/estimation/eligibility.ts:25`. Include `mode` and implement the explicit summary truth table below. |
| P1 | Unavailable aggregate projection counts lack a defined relationship to complete disposition IDs, per-file rows, and estimate eligibility. A partial projection could be published as a completed request. | M / MED | Design section 4 below; `src/application/analyze.ts:523`, `src/application/envelope.ts:193`. Keep resolved identities separate from available measurements; define unavailable-state validation and forbid an estimate from incomplete projections. |
| P2 | Existing config paths are config-directory-relative; applying that convention to the new selectors would break config/request parity and temporary external configs. | S / LOW | `src/config/load.ts:112`, `src/config/load.ts:170`, `docs/adr/003-cli-config.md`. Preserve selectors through normalization without rebasing; document the deliberate root-relative exception and test nested/external config locations. |
| P2 | Existing line-count helpers decode/split a whole token synchronously. Token checkpoints alone do not bound review-SLOC work, and the source helper was outside implementation scope. | M / MED | `src/metrics/source.ts:103`, `src/metrics/source.ts:118`, design section 2 below. Authorize an additive bounded source-line helper, keep raw synchronous APIs unchanged, and verify chunk-boundary parity. |

The last four rows are the follow-up review in this session. They refine the handoff; no new implementation or upstream-match evidence is implied.

Direction decision: add exact contract selection as an opt-in input and build it first. Do not add fuzzy automatic discounts, implicit dependency reachability, or a second parser. A token match remains source-content evidence only. Changed external bindings, file-level directives, custom ancestors, compiler behavior, and deployment assumptions remain integration limitations; their existence was already acknowledged and is not a newly discovered parser defect.

Other options when a fingerprint misses:

- Analyze the original multi-file sources when available and express engagement scope with the existing file filters/ownership settings. This restores file boundaries; it does not prove that a dependency is safe or authorize changing the source being measured.
- Add a reviewed immutable upstream reference when the miss is a catalog coverage gap. If the declaration differs, retain full review or use the exact caller scope above; never relax the matcher until it accepts a desired result.
- Use the existing reasoned `manualAdjustments` for a human planning correction today. It is an explicit ledger assumption, with the current arithmetic/validity bounds, rather than declaration-level reuse evidence.
- Consider a later human-reviewed baseline/diff workflow for maintained forks. Similarity may help locate differences, but function-delta accounting, omitted context, provenance, and integration work require a separate design; similarity alone must not award automatic credit.

## Current state and measured reproduction

The original planning checkout was clean. Node `v24.21.0` and pnpm `11.28.4` were installed. That planning run used both the existing built CLI and the current source application to reproduce a complete estimate of 96–457 hours without writing a report or executing anything supplied by the target project. These measurements are retained historical evidence; the review did not rerun the private sample. At review start this plan was untracked and `plans/README.md` already had local edits; preserve them.

The input is the local file supplied by the user:

```text
/Users/geovla/Developer/work/apps/coinscope/public/commonContracts/pinksale/AntiBotBabyToken.sol
SHA-256: c6764b24b7ec3352aa26b688bf96600f28c92d3798d0b265ff7a217f7af743e0
108,497 bytes; 1,746 measured file SLOC; 28 contract/interface/library declarations
```

It contains `// Dependency file: ...` markers and a `// Root file: ...` marker at line 2800. Its real pragma is `=0.8.4`. Markers label OpenZeppelin contracts and upgradeable contracts, Uniswap V2 interfaces, and several project-specific dependencies. `Dependency file` also labels `BabyTokenDividendTracker.sol`, `IterableMapping.sol`, and other custom code. Therefore excluding every marked dependency would remove substantial actual review scope.

The existing ledger, aggregated by category:

| Category | Low hours | High hours | Detail |
| --- | ---: | ---: | --- |
| Baseline | 69.84 | 209.52 | All 1,746 SLOC × 0.04 / 0.12 |
| Control | 2.8 | 21 | Whole-file decision density |
| EVM | 13.968 | 104.76 | Whole-file baseline × 0.2 / 0.5 |
| Interactions | 6 | 18 | 24 directed pairs |
| Project | 4 | 12 | Charged once |
| Storage | 0 | 0 | Unavailable classification, not measured absence |
| Reserve | 0 | 91.32 | 25% of pre-manual high subtotal |
| Precise total | 96.608 | 456.6 | Displayed outward as 96–457 |

All five assembly blocks are in the sections labelled `Clones` and `Address` (lines 828, 846, 864, 921, 1094). Their presence activates the EVM premium on the entire file. The root token declaration is 426 reported SLOC; `DividendPayingToken` and `BABYTOKENDividendTracker` add 131 and 214. These are measurements, not an assertion about reasonable human productivity or verified provenance. No match to an upstream release was established during planning.

Relevant implementation:

- `src/discovery/scope.ts:334` onward: `classifyOwnershipPath` uses overrides, dependency path segments, and configured dependency roots. An ordinary flattened file is first-party. Keep that filesystem policy.
- `src/application/estimate-input.ts:97` copies raw per-file facts directly into the estimator:

  ```ts
  const eligibleFiles: EligibleFile[] = eligibleMetrics.map((metrics) => {
    const builtin = builtinByFile.get(metrics.file.fileId);
    return {
      fileId: metrics.file.fileId,
      sourceLines: metrics.file.sourceLines,
      stateVariables: estimatorStorage(metrics.file.stateVariables),
      decisions: metrics.file.decisions,
      assemblyBlocks: metrics.file.assemblyBlocks,
  ```

- `src/application/estimate-input.ts:113` maps contracts to files; pair eligibility is currently file-based. `src/relationships/graph.ts` derives raw pairs using physical scope and ownership. Preserve the raw graph and project only the estimator pairs.
- `src/estimation/eligibility.ts:107` applies the EVM channel per file:

  ```ts
  const assembly = file.assemblyBlocks;
  const calls = file.confirmedBuiltinLowLevelCalls;
  if (assembly.status !== 'measured') return { status: 'unavailable' };
  if (assembly.value > 0) return { status: 'measured', factor: ONE };
  if (calls.status !== 'measured') return { status: 'unavailable' };
  return { status: 'measured', factor: calls.value > 0 ? rational(1n, 2n) : ZERO };
  ```

- `src/estimation/estimate.ts`: `filesRows` creates baseline and three premium rows per physical eligible file; the fixed-point arithmetic, outward rounding, reserve, bounds, and manual adjustments are already implemented.
- `src/metrics/structural.ts`: `parsedFileMetrics` derives storage and callable facts from accepted parser events. `src/metrics/source.ts` exports `buildSourceLineSet` and `linesWithin`. Reuse these counting rules.
- `src/parser/protocol.ts`: accepted syntax contains token kinds and original-byte ranges, declaration/name/body ranges, and event `contractId`/`callableId`. Token text is obtained from the accepted snapshot bytes; no parser change or compiler is needed.
- `src/parser/extract-syntax.ts:463`: numeric literals can have the coarse token kind `unknown`. Do not mistake that kind for parse failure; hash their exact text. Only accepted `status: 'parsed'` results qualify.
- `src/relationships/types.ts`: `RelationshipAnalysis` already includes `sources`, `syntax`, `components`, `callSites`, directed pairs, and completeness flags. `countConfirmedBuiltins` in `src/relationships/calls.ts:371` checks complete call-site coverage and rejects unknown candidates. Do not derive confirmed builtins from member names.
- `src/application/analyze.ts:477` builds raw metrics; lines 525 onward build public analysis; lines 557 onward build the estimator input. Insert reuse classification/projection between accepted analysis and estimation.
- `src/domain/types.ts:215` and `src/application/analyze.ts:47` expose only file/path selection. `src/domain/canonical.ts:38` includes byte offsets in declaration IDs; do not use saved declaration IDs as durable caller selectors. `src/config/merge.ts` owns config precedence/provenance and semantic hashing; the new selection must pass through it.
- `src/application/envelope.ts:193` currently derives full coverage from raw completeness and mirrors it to `fullScopeEstimate`. A deliberate contract subset must not populate that field as though the entire physical scope was priced.
- `src/domain/versions.ts` currently fixes report, config, metrics, indicators, and model at `1.0.0`. `ModelProfile`, config input, and estimate result currently permit only model `1.0.0`. `selectModel` only returns that profile. `src/application/envelope.ts:80` always uses the default `MODEL_VERSION` in the envelope, so it must learn the effective selected model version.
- `src/indicators/classify.ts:549` says known dependencies earn no automatic discount. Narrow that sentence to indicator-derived names and test presence; the new reuse policy belongs in estimation/application, not indicator confidence.

Existing conventions and constraints:

- Node `>=24.11.0 <25`, exact pnpm `11.28.4`; ESM, named exports, `.ts` imports, `import type`, explicit public annotations, readonly DTOs, no `any` or suppression comments. Match the imports and `measured<T>` helper pattern in `test/unit/application-estimate-input.test.ts`.
- ADR 002 separates physical ownership/scope, raw metrics, unavailable values, model semantics, and versioned report data. Raw file/contract/callable metrics and graph records must keep their existing meanings and original-byte identities.
- ADR 004 and `AGENTS.md` forbid target execution and dependency/compiler installation. ADR 005 confines Slang to the trusted worker. Runtime recognition must be local and use already accepted syntax and snapshots.
- `docs/model/heuristic-v1.md` freezes `1.0.0`; changed model behavior needs a version. Keep its old formulas and worked fixtures intact.
- `CONTRIBUTING.md` prohibits adding copied fixtures without approved provenance/license grants. This plan does not authorize copying the user's token into the repository or committing upstream source fixtures. Seed runtime hashes from reviewed official reference data; use originally authored synthetic fixtures and test-only catalog injection for committed automated tests.
- `scripts/check-boundaries.mjs` restricts transitive imports from pure domain, estimation, metrics, and reporting code. Put recognition/catalog code in application, and pass plain results into the estimator. Do not change scanner allowlists or parser fingerprints to bypass it.

## Design decisions to implement

### 0. Let callers select contracts independently of recognition

Add optional `estimationScope` to `AnalyzeRequest` and `ConfigInput`, and a fully resolved value to `ResolvedConfig`. This is separate from filesystem `scope`: it never selects additional files, changes ownership, or avoids required parsing/import-context work. Add no CLI flags; CLI callers use a data-only config, and library callers can pass the request field directly. Default omission means `{ mode: 'all' }`.

Use this bounded discriminated union, with explicit readonly annotations in the implementation:

```ts
type EstimationScopeInput =
  | { readonly mode: 'all' }
  | {
      readonly mode: 'contracts';
      readonly contracts: readonly {
        readonly path: string;
        readonly kind: 'contract' | 'abstract-contract' | 'library' | 'interface';
        readonly name: string;
        readonly sourceHash?: string | undefined;
      }[];
      readonly reason: string;
    };
```

`path` is an exact canonical project-relative POSIX path as shown by `inspect`, never a glob, native absolute path, basename search, import hint, or flattening banner. Reject empty/traversal segments, backslashes, controls, and paths exceeding the existing 512-character path bound. Match `{ path, kind, name }` case-sensitively against accepted current declarations in eligible first-party scoped files. Names use the parser's 128-code-unit bound. Require 1–10,000 selectors, capped before allocation, and a nonblank reason within the existing 512-code-unit text bound. Arrays replace earlier layers; request overrides replace file config, which replaces the default. Record provenance using the existing request/CLI override convention and include normalized, deterministically sorted selectors and the reason in semantic config hashing. Do not derive them from project metadata or comments.

Selector paths always use the selected project root, including when `--config` names a nested file or a file outside that root. This is a deliberate exception to existing config-directory-relative filesystem settings. In `normalizeConfigPaths`, preserve the validated `estimationScope` object when reconstructing the input; do not pass selector paths through `toRootRelativePath`, resolve symlinks from the config directory, or add them to discovery. Resolve them only against the final accepted manifest/declarations. Leave every existing config path's base and confinement rules unchanged. Document the exception in ADR 003 and the configuration guide. Duplicate identity is the `{ path, kind, name }` tuple even if optional hashes differ; sort selectors by that tuple using the existing code-point ordering.

Reject duplicate selectors and zero/multiple declaration matches with sanitized `CONFIG_INVALID` diagnostics. A selector for a blocked, excluded, third-party, missing, invalidated, or unparsed file cannot silently disappear, promote ownership, or select a declaration with the same short name elsewhere. If a shared budget interrupts resolution, propagate that interruption rather than misreporting a config typo. A failed required file that contains a selected declaration cannot be priced merely because `allowPartial` is set; unresolved explicit selectors produce no estimate. Optional `sourceHash` is a SHA-256 guard checked against the accepted snapshot. If absent, the selector intentionally follows the same path/kind/name through edits; document that this does not detect same-name replacement. If present and stale, reject. Original byte-offset contract IDs remain output evidence, not durable config selectors.

In `contracts` mode, selected declarations receive the ordinary full-review rate even if they match the catalog. Every other contract/interface/library declaration in the eligible physical scope becomes estimation context, with a caller-exclusion reason; do not mark it reusable. Non-contract tokens, free functions, file-level constants/types/directives, and their owned events remain full-rate. Count mixed physical lines once. Do not automatically add ancestor/helper/callee declarations or claim reachability: list known selected-to-context relationships and explicitly disclose that unselected custom bases/helpers remain outside full review. Callers must list those declarations when their review belongs in the engagement. A named root contract alone is not the whole behavioral scope of a deployed token; Solidity inheritance combines base behavior ([official inheritance documentation](https://docs.soliditylang.org/en/latest/contracts.html#inheritance)).

The user confirmed an exact list, with dependencies shown as context, during this review. Do not add automatic ancestor/helper/callee expansion; the current syntax/binding limits do not support a promise to discover every required helper.

Preserve the current meaning of whole-project coverage. When any otherwise eligible declaration is caller-excluded, set `scopeNarrowed=true`, produce `estimate.coverage='analyzed-subset'`, keep `fullScopeEstimate=null`, and return the existing partial outcome/exit 4 for estimating commands. Explicit selection authorizes this intentional subset without a second `allowPartial` opt-in; actual required-analysis failures still need `allowPartial` and retain all current omissions. Keep raw `requiredAnalysisComplete` unchanged. `inspect` still reports complete when its raw analysis is complete and includes the scope metadata without an estimate. If all eligible declarations are selected, no narrowing occurred. Do not fabricate a full-project estimate or relabel intentional exclusions as analysis failures. Add `analysis.estimationScope.requestedScopeComplete` to distinguish selector resolution and selected-input availability from whole-project completeness; it cannot clear upstream failures. Making an intentional subset exit 0 is a separate compatibility decision, not an implicit change in this plan.

Introduce config revision `1.1.0` for the added selection field. Accept existing `1.0.0` config files through their old strict input shape, retain their existing explicit-model behavior, and normalize both to resolved `1.1.0`; new config data uses `1.1.0`. Old config inputs must not acquire arbitrary unknown fields. Both known model versions are accepted by the new config shape; legacy configs may still explicitly select `1.0.0`. An explicit `contracts` scope with model `1.0.0` is invalid, because that compatibility path must retain physical full-review semantics. Omitted scope works with both models. Update version facts and generated config schema without changing its existing `config-v1.schema.json` export path.

Illustrative complete config for two declarations in one original synthetic fixture (the library request takes the same `estimationScope` object):

```json
{
  "configVersion": "1.1.0",
  "estimationScope": {
    "mode": "contracts",
    "contracts": [
      { "path": "Flattened.sol", "kind": "contract", "name": "Token" },
      { "path": "Flattened.sol", "kind": "contract", "name": "DividendTracker" }
    ],
    "reason": "Estimate the agreed token and dividend-tracker review scope."
  }
}
```

### 1. Recognize complete declarations by content, with no dependence on markers

Create a bounded, bundled catalog for a small explicit set of OpenZeppelin Contracts/Contracts Upgradeable releases and Uniswap V2 interfaces. Start reference investigation with OpenZeppelin `v4.3.2` and nearby `v4.2.0` where needed for the supplied historical source. Resolve every included release to an immutable official commit and record its original file byte hash. Include `Clones`, `Address`, ERC20, ownership, context, math, initialization, and ERC20 interface declarations when their reference data is available and verified. Cover the four Uniswap V2 factory/pair/router interface declarations as reference candidates; do not add router/pair implementation discounts without actual implementation fingerprints.

For each complete top-level contract, abstract contract, library, or interface:

1. Use its validated declaration span and non-trivia tokens from the accepted snapshot. Ignore whitespace/comments/NatSpec, including flattening banners. Keep declaration kind/name and all significant token boundaries and text.
2. Permit only the builtin integer aliases `uint`→`uint256` and `int`→`int256` on Solidity keyword tokens outside assembly ranges. This matters here: the sample's Uniswap interfaces spell `uint256` where upstream interfaces spell `uint`. Preserve identifiers, strings, numbers, operators, widths, inheritance, visibility, mutability, storage layout, and assembly text. No identifier renaming, function reordering, string normalization, fuzzy matching, AST similarity, or generic ABI-only matching.
3. Frame/hash a canonical ordered sequence of separate token kind/text records with SHA-256. Define `frame(bytes)` as ASCII decimal byte length, then `:`, then those exact bytes; `frame(text)` first UTF-8-encodes text. The digest input is `frame('dependency-declaration') || frame('solidity-tokens-v1') || frame(kind) || frame(name) || frame(String(significantTokenCount))`, followed by `frame(token.kind) || frame(normalizedTokenBytes)` for each significant token in source order. `||` means byte concatenation, not a literal delimiter. Hand-write a tiny expected digest oracle. Stream unchanged token bytes rather than materializing a whole canonical token array; normalizing the two short keyword aliases is the only token rewrite. Use the same implementation for reference generation and target matching. Include the normalizer and parser package version in catalog provenance. Do not concatenate tokens ambiguously or strip comments with regex.
4. Index the catalog by digest. Index sorted declaration/token spans once rather than rescanning every token for every declaration. Reference names/marker paths can be displayed or used to narrow candidates but never establish a match. No normalizer exception may depend on the sample's source hash or names.
5. A digest match establishes token-equivalent declaration content under the documented normalizer, not the installed package/version or equivalent runtime behavior. Retain all matching reference IDs in stable order if several releases share the same content. Do not report a guessed exact version as detected.

Independent framing oracle: `library Tiny {}` has four significant records, `keyword/library`, `identifier/Tiny`, `punctuation/{`, `punctuation/}`. Its 135 ASCII digest-input bytes are `22:dependency-declaration18:solidity-tokens-v17:library4:Tiny1:47:keyword7:library10:identifier4:Tiny11:punctuation1:{11:punctuation1:}` and SHA-256 is `7e69f4495d8e7fe43b38035f36609488707492fd70ef492aad45afa90db0dc8d`. This was calculated independently with Python `hashlib` over that literal frame, not the planned normalizer.

Before applying a match, require the active parser package version and normalizer identity to equal the reviewed catalog provenance, and require the target's selected grammar to belong to the reference's worker-validated `compatibleVersions` set captured during catalog generation. Retain the reference pragma evidence, selected grammar, and compatible grammar set in provenance; do not implement another pragma parser. A different selected patch within that set does not prove compiler equivalence. Reject a candidate lacking usable reference version evidence; regenerate the catalog after a parser upgrade. Where several references share a digest, retain only compatible reference IDs. A plain content match cannot validate external constants, imports, file-level `using` directives, override dispatch, or dependency bindings; retain their raw evidence and integration limitations. Do not invent a semantic-context equivalence test that requires compiler resolution.

An entire changed declaration remains at the normal review rate, even if 99% similar. Unknown releases, missing markers, renamed declarations, and mismatches must not produce an automatic discount. A known declaration beside a malicious same-name base or an override does not remove the custom base/override from review. The graph, compiler selection, inherited behavior limitations, and upstream uncertainty remain visible. No claim that a registry reference is vulnerability-free is allowed.

### 2. Keep raw analysis and produce a separate effective review projection

Do not split files on comment markers, synthesize virtual files, reparse fragments, rewrite snapshots, or change `ScopeManifest` ownership. Preserve all raw SLOC, declarations, assembly evidence, and graph facts.

For **eligible parsed first-party scoped files only**, build one estimator-specific disposition map. In `all` mode, classify reusable top-level declarations; matched declarations are `content-reuse`, and all others are `full-review`. In `contracts` mode, selected declarations are `full-review` and all other declarations are `caller-context`; recognition may be displayed as evidence but applies no reuse discount. Remove omitted significant tokens and owned declarations/events only from this derived view. Derive it with the existing metric helpers and retain the physical `fileId`. Free functions, top-level code, imports and pragmas remain ordinary review tokens. Unmatched custom code remains full-rate in `all` mode; only an explicit caller selection can exclude it.

Compute review SLOC as the union of physical lines touched by retained non-trivia tokens. A line shared by omitted and retained tokens stays chargeable once. In `all` mode, `reusedSourceLines = raw - review` and `outOfScopeSourceLines = 0`. In `contracts` mode, `outOfScopeSourceLines = raw - review` and `reusedSourceLines = 0`. These counts mean fully removed physical lines, not sums of contract SLOC or all lines touched by an omitted declaration. Require `raw = review + reused + outOfScope` per file and in aggregate for the eligible analyzed subset. Track `scopeNarrowed` by excluded declaration identities even if line sharing leaves out-of-scope SLOC zero.

Recompute decisions, mutable storage counts/shapes/complex IDs, and assembly from retained events using original identities/ranges. Do not copy whole-file ratios after changing SLOC, subtract an estimated percentage, or scale the final answer. Preserve `unavailable` where the remaining evidence cannot establish a measurement.

For confirmed builtins, filter accepted syntax call events and `callSites` consistently to the retained region, then reuse `countConfirmedBuiltins` with the original component availability. The existing helper can accept filtered readonly copies; do not mutate cached accepted syntax. If coverage of retained sites cannot be proved, return `unavailable`. An unavailable raw count caused only by removed sites can be resolved for the retained view only when that complete site-level proof exists. Never clear upstream `requiredAnalysisComplete=false`, invalidated scope, or `hasUnknownSemantics=true`.

Factor a narrow `buildReviewMetrics` helper into `src/metrics/structural.ts` so raw and review views share counting code. Give it accepted source/syntax and omitted contract IDs, independent of the reason for omission. It must return a distinct derived `FileMetrics` view, never publish a filtered DTO as a newly accepted worker reply. Its empty-omission path must equal today's raw metrics. Keep this helper independent of config/catalog/application types.

Keep the existing raw `buildFileMetrics` synchronous contract intact. The derived path may be asynchronous and receive a narrowly typed checkpoint callback from the application so bounded traversal can yield without importing discovery/budget or timer modules into metrics. Avoid one uninterruptible rescan of all retained tokens/events after the bounded filtering phase; process retained work in bounded batches and share counting primitives rather than rerunning the complete raw builder on a fabricated parsed reply.

Add a bounded derived-line-count path in `src/metrics/source.ts`: reuse the existing physical-line index where already available, and checkpoint any new byte scan and token decoding in chunks of at most 64 KiB as well as every 256 records. Calling the existing synchronous `buildSourceLineSet`/`linesWithin` over the retained token list does not satisfy this requirement: `addTokenLines` decodes and splits an entire token at once. Preserve those raw APIs and their exact line semantics. Streaming decoding/counting must handle a split UTF-8 scalar or CRLF and the existing Unicode-whitespace rule without inventing lines. Test parity against independent small literals and the current raw counting rules, plus an abort inside one large retained string token; a hashing-only checkpoint test is insufficient.

### 3. Charge reuse as integration work, under model `1.1.0`

Use `heuristic-v1@1.1.0` as the default for new calls. Keep the exact existing numeric parameters; recognition changes what requires full review. Full-review baseline and premiums for a matched declaration are zero. Keep one project allowance, normal custom-code baseline/premiums, boundary integration allowances, uncertainty reserve, and manual adjustments. This is an explicit reuse assumption, with no invented empirical productivity claim.

In explicit `contracts` mode, full-review baseline/premiums instead use exactly the selected declarations plus retained non-contract code; selected matches are not discounted. Caller-context declarations receive no full-review charge. They still participate in integration boundaries. The two modes share projection mechanics but have different evidence and omission reasons.

Project the existing directed pair union as follows, deduplicating the original ordered endpoints before charging:

| Endpoints in the existing eligible pair set | Estimator category in 1.1.0 |
| --- | --- |
| Two retained/custom scoped contracts | `interaction` |
| One retained/custom scoped contract and one matched reusable contract, either original direction | `boundary` |
| Two matched reusable contracts | No internal pair charge |
| Retained/custom scoped contract to existing external/context contract | Existing `boundary` behavior |
| Reusable contract to existing external/context contract | No full-review pair charge |
| Invalidated/ineligible scoped endpoint or self-pair | Retain current exclusion rules |

For `contracts` mode apply the same partition using `selected` versus `caller-context`: selected↔selected pairs are interactions; selected↔caller-context pairs in either existing direction are boundaries; caller-context↔caller-context and caller-context→external pairs are omitted; selected→existing external/context pairs keep the existing boundary behavior. Project only existing eligible directed pairs, never infer missing reverse/context-originating edges. This distinction matters because the raw graph currently creates pairs only when the owner is physically scoped first-party (`src/relationships/graph.ts:249`). Preserve raw evidence, deduplicate the original ordered endpoints, and keep interaction/boundary partitions disjoint even within one physical file.

Keep graph edges and evidence unchanged in public analysis. Reuse-related and caller-scope boundaries use the existing `boundaryHours` parameter; do not also charge them as interactions. Dynamic dispatch and unproven overrides remain limitations, not invented edges. No new zero-effort claim about hooks or initialization follows from a content match. Boundary rates are higher than interaction rates in the current profile, so removing review lines is not a universal promise that both total endpoints decrease. Explain changes row by row.

Keep model `1.0.0` selectable through config `model.modelVersion` and `selectModel('heuristic-v1', '1.0.0')`. It must reproduce the old engine and raw source-to-input behavior, not the new projection with the old label. Keep its frozen profile and worked fixtures. Selecting `1.0.0` is the physical full-review compatibility path; omission selects `1.1.0`. The new `estimationScope` config/request field is the separate caller-intent control; no new CLI flag is needed.

Extend `EstimateInput` additively with optional `reviewSummary: { readonly mode: 'all' | 'contracts'; readonly analyzedSourceLines: number; readonly reusedSourceLines: number; readonly outOfScopeSourceLines: number; readonly scopeNarrowed: boolean }`. In 1.1.0 the application supplies it only after complete numeric projection, and each eligible file's `sourceLines` is explicitly the measured effective review SLOC. Validate nonnegative safe bounded integers and safe aggregate arithmetic, with `analyzedSourceLines = sum(eligible review SLOC) + reusedSourceLines + outOfScopeSourceLines`. A supplied summary requires measured per-file review SLOC; unavailable baselines without a summary retain the old null behavior. Reject the summary for 1.0.0. A plain 1.1.0 library input without it means all supplied lines require full review, with no intentional narrowing.

| Summary mode | Reused lines | Caller-excluded lines | `scopeNarrowed` | Additional requirement |
| --- | --- | --- | --- | --- |
| `all` | Nonnegative | 0 | `false` | Positive analyzed SLOC may have zero review SLOC when all analyzed lines are reused. |
| `contracts`, all eligible declarations selected | 0 | 0 | `false` | Positive measured review SLOC for any non-null estimate. |
| `contracts`, declarations excluded | 0 | Nonnegative | `true` | Positive measured review SLOC; excluded line count may be zero on shared lines. |

Reject every other combination. The pure engine validates this summary; the application additionally proves declaration selection, disposition IDs, and exact line accounting. Preserve the raw completeness flag; `eligibleCoverage` returns `analyzed-subset` for intentional narrowing independently of raw completeness, while its existing `allowPartial` check still controls genuine incomplete analysis. Fully reused code with positive analyzed SLOC and zero review SLOC may still incur project/integration/reserve/manual costs. An empty selector list is invalid; a contracts-mode summary with zero review SLOC cannot manufacture a context-only allowance. Genuine empty scope retains its old null behavior.

Use the existing fixed-point and ledger implementation. Keep four file rows even for zero review SLOC, with explanations saying which measured line basis is used. Add the reuse policy assumption only for 1.1.0. Do not feed catalog/source bytes into the pure engine.

When selecting a model during config merge, first resolve the final profile/version and then apply explicit parameter overrides in established precedence order. Preserve overrides from earlier layers when a later layer selects only a version; do not accidentally replace those values with fresh defaults. Regression-test version changes and layered overrides together.

### 4. Publish provenance and the basis of each estimate

Add an optional `analysis.dependencyReuse` field for backward structural compatibility, populated by all new analyses, including `inspect` and partial analyses. It contains:

- policy/normalizer version and bundled catalog version/digest;
- applied model policy (`full-review` or `verified-reuse`); explicit `contracts` mode uses `full-review` even when matches are disclosed;
- stable per-file records keyed by original file ID: raw analyzed SLOC, effective review SLOC, fully reused SLOC, caller-excluded SLOC;
- matched declaration records with original contract ID/range, normalized digest, and sorted reference IDs;
- a bounded limitation explaining that content reuse does not verify installed versions, dependency bindings, compiler behavior, deployment, or security.

All counts concern eligible successfully analyzed scope; omissions remain in existing completeness fields. In model 1.0.0 matches may be disclosed, but effective SLOC must equal raw SLOC and fully reused SLOC is zero. Do not label a detected match as an applied discount on that path. For failed files, omit numeric projection records and retain their existing unavailable analysis. Never fabricate zero raw SLOC for them.

Use these concrete public fields (with explicit readonly TypeScript annotations and strict Zod objects):

```ts
interface DependencyReuse {
  readonly policyVersion: '1.0.0';
  readonly normalizerVersion: 'solidity-tokens-v1';
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly policy: 'full-review' | 'verified-reuse';
  readonly files: readonly {
    readonly fileId: FileId;
    readonly recognitionStatus: 'available' | 'unavailable';
    readonly unavailableReason: string | null;
    readonly rawSourceLines: number;
    readonly reviewSourceLines: number;
    readonly reusedSourceLines: number;
    readonly outOfScopeSourceLines: number;
  }[];
  readonly matches: readonly {
    readonly fileId: FileId;
    readonly contractId: ContractId;
    readonly range: SourceRange;
    readonly digest: string;
    readonly referenceIds: readonly string[];
  }[];
  readonly limitations: readonly string[];
}
```

Use SHA-256 hex validation for digests, existing label/text bounds, at most 32 reference IDs per match and 32 limitations, and the 100,000 row ceilings below. Match records must reference existing eligible file/contract IDs with the original range; each contract appears at most once. In `all` mode a per-file unavailable recognition result has a fixed safe reason, raw = review, reused = 0, out-of-scope = 0, and no retained matches for that file. A valid catalog with no matches is available, with the same full-review accounting. A corrupt/unavailable catalog falls back for every eligible file. Do not invent negative evidence such as a "modified upstream" claim merely because a same-name declaration failed to match.

The preceding raw=review fallback applies to `all` mode. In explicit `contracts` mode, recognition failure leaves caller selection unchanged: `reusedSourceLines=0`, while review and caller-excluded lines still follow the valid selection. Do not restore excluded declarations or remove selected ones because the catalog is unavailable. A projection failure is different: if the selected view cannot be proven, do not fabricate that estimate or silently widen its requested scope.

Add a separate optional `analysis.estimationScope`, populated by every new non-error analysis, with `mode`, `reason: string | null`, sorted resolved `selectedContractIds` and `contextContractIds`, `scopeNarrowed`, `requestedScopeComplete`, and aggregate `rawSourceLines`, `reviewSourceLines`, `reusedSourceLines`, `outOfScopeSourceLines`. In `all` mode selected IDs denote full-review declarations and context IDs denote applied content reuse; in `contracts` mode the IDs denote the exact caller selection and its context complement. `mode` disambiguates those reasons; the dependency match table remains the content evidence. Aggregate counts equal the sum of eligible per-file rows, never include failed/unavailable files as zeros, and are unavailable rather than invented if that projection was not completed. Use `Measurement<number>` for aggregate counts when unavailable. `requestedScopeComplete` is true only when selector resolution and all selected inputs/projections are available; it does not substitute for raw completeness. Preserve the bounded original selectors in resolved config; do not put native paths or source excerpts in output. Error envelopes retain null analysis/estimates.

Make the unavailable state precise: construct and validate the disposition ID partition before numeric projection. If selector resolution or the partition cannot be established, use a sanitized error envelope; empty arrays must not stand for an unknown partition. If the partition is known but a typed projection-unavailable outcome prevents complete numeric projection, keep those known IDs and `scopeNarrowed`, set all four aggregate measurements to `unavailable` with one fixed safe reason, set `requestedScopeComplete=false`, and produce no estimate or `fullScopeEstimate`, even with `allowPartial`. Keep numeric per-file rows only for completed file projections; their partial sum is not an aggregate for the whole eligible subset. Unexpected errors and shared interruptions retain existing application failure handling. In an available projection all four aggregates are measured, conserve lines, and equal the complete eligible per-file rows; mixed measured/unavailable aggregate states are invalid. `inspect` still derives envelope completeness from raw analysis. In `all` mode `requestedScopeComplete` additionally requires raw `requiredAnalysisComplete`; in `contracts` mode it requires every explicit selector and its selected input to be available and the numeric projection complete, while unrelated raw failures remain governed by existing `allowPartial`/coverage rules.

Cap each scope ID array at 100,000 unique original eligible contract IDs and validate their disjoint, complete partition before retention. Never truncate a caller selection or context complement. A complete raw public contract array already obeys the same bound. If an internal input exceeds it, produce a sanitized `LIMIT_EXCEEDED` analysis error envelope, with null analysis/estimates; do not fabricate a smaller successful projection or an empty partition. Do not fabricate a valid raw report if raw analysis itself exceeds its existing public bound. Include a focused overflow test through internal synthetic input rather than requiring a huge native fixture.

Bound collections by existing parsed declaration/file allowances, with an explicit absolute maximum of 100,000 match and per-file rows and bounded reference lists/text. Enforce bounds before allocation/retention. Check/yield to the shared application budget at least every 256 tokens, events, selectors, or other records, not merely once per file/declaration. Stream hashing in byte chunks of at most 64 KiB and checkpoint between chunks so a single large string token cannot monopolize the work. A typed local catalog/recognizer allowance exhaustion discards the affected file's provisional matches atomically and retains its code at full review in `all` mode. Keep explicit selection in `contracts` mode. Propagate every shared `BudgetError` (`cancelled`, `deadline`, or `limit`) into the existing application handling; never catch it as a successful full-cost fallback. These shared failures keep existing cancellation, timeout, incomplete-analysis and exit contracts. Apply the same work/disposal rules to the generator. Do not accept a partial set of matches for an unavailable file as a complete recognition result.

Bump report and config producers to `1.1.0` for the additive fields; keep raw metrics and indicator versions at `1.0.0`. Keep the strict report producer schema exact for its current revision, preserve the existing forward-compatible consumer reader, and migrate current producer fixture/golden envelopes to 1.1.0 with independently specified scope/reuse fields where applicable. Config inputs explicitly accept the two supported revision shapes as specified above. Do not widen either producer to arbitrary v1 shapes to avoid updating fixtures. Preserve legacy 1.0.0 report/config input compatibility tests. Model profile/result validation must explicitly support the two known model versions, not arbitrary versions. Intentional narrowed estimates retain the existing subset coverage vocabulary, null full-scope estimate and partial exit semantics; this amendment does not reinterpret an old full-scope field.

The envelope's `versions.model` must reflect the selected model, including `inspect`, partial/error reports after configuration, and explicit 1.0.0 use. Errors before configuration use the default. Existing `analysisFingerprint` already hashes public analysis and component versions: include catalog identity in `dependencyReuse` so catalog changes affect analysis fingerprints even if the source bytes do not. Keep source fingerprints about source/relationship evidence. Keep selected model version in semantic config hashing.

Terminal/Markdown output must show raw versus effective review SLOC, content-reused lines/declarations, caller-excluded lines/declarations, requested-scope completeness, and retained integration work. For intentional subsets state that the requested contracts were resolved and that the whole physical scope was not priced; do not describe omitted custom dependencies as known-safe libraries. `explain` associates content match/reference IDs or caller-selected/context IDs with each omission reason. Keep output bounded, sanitized, deterministic, and free of source excerpts/native paths. JSON uses the same structured data. Additive metadata must not erase raw indicators/callables, weaken genuine analysis-failure behavior, or imply that discounted source received a fresh full audit.

## Commands you will need

Run from the trusted estimator repository, never from the analyzed project.

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Reproducible setup, if needed | `pnpm install --frozen-lockfile` | Exit 0; no manifest/lockfile changes |
| Typecheck | `pnpm typecheck` | Exit 0 |
| Lint | `pnpm lint` | Exit 0, non-mutating |
| Format check | `pnpm format:check` | Exit 0, non-mutating |
| Focused new units | `pnpm test test/unit/estimation-scope.test.ts test/unit/dependency-reuse.test.ts test/unit/application-estimate-input.test.ts test/unit/estimation.test.ts test/unit/model-spec.test.ts` | Exit 0; all five files run, including named new tests |
| Focused scope integration | `pnpm test:integration test/integration/estimation-scope.test.ts` | Fresh build; API/config exact-selection, context and exit assertions pass |
| Focused new integration | `pnpm test:integration test/integration/dependency-reuse.test.ts` | Fresh build, nonzero new test count, all pass |
| Regenerate schemas after DTO changes | `pnpm schemas:generate` | Only the three existing schema files update |
| Verify schemas | `pnpm schemas:check` | Exit 0 |
| Full local gate | `pnpm check` | Exit 0 across type/lint/format/boundaries/unit/integration/schemas/docs |
| Unit coverage | `pnpm test:coverage` | Exit 0 with existing thresholds intact |
| Packed consumer | `pnpm test:package` | Fresh build; installed CLI/library work with no runtime reference downloads |

During this review, `pnpm typecheck`, `pnpm lint`, and the focused existing baseline `pnpm test test/unit/estimation.test.ts test/unit/model-spec.test.ts test/unit/application-estimate-input.test.ts` passed (**168 tests in three files**). Final non-mutating formatting and plan checks are recorded in the index. No fresh build, full gate, new feature tests, catalog generation, or private-sample comparison was run by the advisor.

Follow-up review in this session: typecheck, lint, format check, and the preceding focused units plus `test/unit/domain.test.ts` and `test/unit/config-loading.test.ts` passed (**187 tests in five files**), using `pnpm --config.verifyDepsBeforeRun=false` to prevent implicit dependency verification/installation. Runtime remained Node `24.21.0` / pnpm `11.28.4`. These checks verify the current baseline only, not the proposed feature.

## Scope

**In scope — only these implementation paths and necessary existing test expectations:**

- Create `src/application/dependency-reuse/{types,fingerprint,catalog,classify,project}.ts`.
- Create `src/application/estimation-scope.ts` for selector resolution and disposition construction, independent of catalog availability.
- `src/application/{analyze,estimate-input,envelope,defaults}.ts`.
- `src/metrics/{structural,source}.ts` — shared raw/review counting and bounded derived-line helpers, preserving existing synchronous raw APIs and outputs.
- `src/domain/{types,schemas,versions}.ts`; `src/index.ts` only to export newly public domain types if required by its current explicit export pattern.
- `src/config/{merge,load,validate,defaults}.ts` and `src/application/defaults.ts` — additive estimation-scope input/default, version selection, strict old/new config shapes, validation/provenance/hashing; do not change filesystem ownership, operational limits, root resolution, data-only read rules, or existing option precedence.
- `src/estimation/{model,eligibility,estimate}.ts`; create `src/estimation/profiles/heuristic-v1-1.ts`; retain the old profile unchanged.
- `src/indicators/classify.ts` — only the contradictory limitation sentence, with no indicator weight/flag changes.
- `src/reporting/{display,terminal,markdown}.ts`; JSON serialization only if new set-like ordering cannot be handled in `display.ts`.
- Create `scripts/generate-dependency-catalog.mjs` and `scripts/dependency-references.json` for explicit maintainer reference processing. No runtime network acquisition.
- `schemas/{config,model,result}-v1.schema.json`, generated from Zod.
- Create `test/unit/{estimation-scope,dependency-reuse}.test.ts` and `test/integration/{estimation-scope,dependency-reuse}.test.ts`; necessary compatibility/default/projection assertions in existing `test/unit/*.test.ts`, `test/integration/application.test.ts`, and `test/e2e/{cli,documentation}.test.ts`.
- Current producer envelopes under `test/fixtures/domain/`, `test/golden/`, and `examples/results/`, only for the schema/metadata migration; preserve the old consumer fixture separately. Preserve all 1.0.0 arithmetic in `test/fixtures/estimation/`.
- Create `examples/projects/contract-scope/Flattened.sol` and `audit-estimator.config.json` with original tiny selected/context declarations; add their provenance in `examples/README.md` and one registered command/config case with independent expected totals in `examples/manifest.json`. Inline synthetic unit/integration builders need no new Solidity fixture files.
- `test/package/packed-artifact.test.ts` only for positive installed-catalog evidence and version/metadata expectations; preserve the tarball allowlist and network-denial controls. `test/integration/bootstrap-cli.test.ts` only for changed version/default expectations, with purity gates intact.
- `docs/{architecture,configuration,output-schema,limitations,roadmap,cli,indicators}.md`, `docs/model/limitations.md`, `docs/adr/{002-domain-contract,003-cli-config}.md`, and new `docs/dependency-reuse.md` / `docs/model/heuristic-v1-1.md`.
- `examples/manifest.json` and existing registered documentation examples where version facts/producer envelope schemas change, plus the explicit contract-scope example above. Keep annotations and independent arithmetic expectations consistent.
- `plans/README.md` — this plan's status and factual execution evidence only.

**Out of scope:**

- All target-project files and report outputs, including the user's token/repository. Do not commit or upload their source.
- Parser adapter/worker/protocol/extraction changes, Slang/compiler upgrades, discovery/safe-read/ownership behavior, and graph extraction.
- Dependencies, lockfile, runtime/toolchain versions, build entries, scanner allowlists/fingerprints, release identity, publication, and CI policy.
- Changing the frozen 1.0.0 formulas/coefficients/worked-case arithmetic, global productivity calibration, custom-protocol recognition, function-level/fuzzy delta discounts, or automatic advisory-based security claims.
- New runtime downloads, reference learning from the target, custom registry/plugin APIs, broad manual byte/function-range exclusions, automatic ancestor/helper closure, and new CLI flags. The exact top-level declaration selection specified above is explicitly in scope.
- Copying upstream source fixtures without the separately required provenance/license approval. Originally authored synthetic test code and checked-in metadata/digests are sufficient for the implementation path below.

## Git workflow

- Suggested branch: `advisor/017-flattened-dependency-reuse`, based on the actual current local checkout after drift inspection.
- Preserve unrelated edits. Use logical commits if the operator asks for commits; match observed messages such as `refactor: ...` and `test: ...`.
- Do not commit to the user's branch, merge, push, open issues/PRs, or publish without separate operator instructions. This plan itself authorizes implementation and local verification only when assigned to an executor.

## Steps

### Step 1: Freeze compatibility and create independent reuse oracles

Keep current explicit-1.0.0 tests and worked cases. Add test builders with originally authored tiny reusable/custom contracts, a reusable assembly helper, a custom dividend-like helper, duplicate short names in separate files, a selected derived contract, a free function, and a same-line mixed declaration. Supply a test-only registry through module mocks or internal function arguments; no production API can inject executable code or select a registry from a target. Hand-write expected token framing/digests, caller-selector resolutions, line/pair partitions, and new numerical ledgers rather than deriving expected values with production functions.

Commit positive and negative cases from the test matrix below. Tests may be introduced with their implementation in the same logical change, but do not leave failing or skipped placeholders as a completed step.

**Verify**: `pnpm test test/unit/model-spec.test.ts test/unit/estimation.test.ts test/unit/application-estimate-input.test.ts` → existing 1.0.0 literals/rounding/eligibility still pass. Before proceeding, confirm the new oracle cases have explicit expected counts/ledger values, not snapshots obtained from the new engine.

### Step 2: Implement exact caller scope and the shared review projection

Implement `src/application/estimation-scope.ts` and `buildReviewMetrics` from design sections 0 and 2. Keep selector validation separate from recognition. Resolve exact path/kind/name against current accepted declarations; validate optional hashes, reject duplicate/unresolved/ineligible selectors, and keep non-contract code. In `all` mode the empty-omission path equals today's raw facts. In `contracts` mode use only caller-selected declarations for full review, retain all other declarations as context, and record the distinct out-of-scope reason. Do not fetch references or require an operational catalog for this step.

Use retained contract IDs to filter owned events/declarations and significant token spans for the review SLOC union, using the bounded derived-line helper in `src/metrics/source.ts`. Pass retained call-site facts through the existing builtin counter with original component status and prove one-to-one retained call-site coverage before counting. Preserve raw `FileMetrics`, accepted syntax, snapshots, scope manifest, graph, and indicators. Return raw/review/excluded accounting and the projected eligible facts/pairs from the specified truth tables. Keep original IDs and storage consistency. A failed selected projection cannot silently widen scope or produce a fabricated result. Yield within record/byte work, including a single retained multiline literal, and propagate shared interruptions.

**Verify**: `pnpm test test/unit/estimation-scope.test.ts test/unit/application-estimate-input.test.ts test/unit/structural-metrics.test.ts test/unit/source-metrics.test.ts` → nonzero tests prove selector outcomes, raw immutability, line conservation, retained free functions/custom facts, builtin coverage, both pair truth tables, raw/derived counting parity across chunk boundaries, and interruption during derived line counting. `pnpm typecheck` and `pnpm boundaries:check` → exit 0.

### Step 3: Add model/config/report revisions and exercise caller scope without a catalog

Add model 1.1.0 with unchanged parameters and an explicit model 1.0.0 raw/full-review path. Implement `reviewSummary` consistency/eligibility, including intentional subset coverage without weakening genuine `allowPartial` rules. Resolve final model/version before layered parameter overrides and preserve earlier explicit overrides. Update effective model identity in all envelopes, including post-config failures and `inspect`.

Add strict config 1.1.0 with `estimationScope`, old-config input compatibility, default `all`, public request override, field provenance and semantic hashing. Preserve project-root-relative selectors through config-path normalization, including nested/external config files. Do not make a request field bypass validation when `noConfig` is true. Preserve all existing root/confined-read behavior. Add report 1.1.0 and scope metadata, including the unavailable-state rules; enforce that a narrowed result is partial/analyzed-subset with null `fullScopeEstimate`, even when raw analysis is complete. Raw `inspect` completeness stays independent. Update current producer fixtures; preserve the legacy consumer example and frozen arithmetic. A deliberately unavailable catalog during this phase means no content-based omissions, not fake recognized reference data.

Render caller selection, retained context boundaries and exclusion accounting. Add one registered data-only config example using original synthetic declarations and independent expectations, without new CLI syntax. Keep fixed-point arithmetic, ledger order/bounds, manual application order, uncertainty reserve and import-time purity unchanged.

**Verify**: `pnpm test test/unit/estimation-scope.test.ts test/unit/model-spec.test.ts test/unit/estimation.test.ts test/unit/application-estimate-input.test.ts test/unit/config-loading.test.ts test/unit/domain.test.ts test/unit/reporting.test.ts` → all pass with independently calculated ledgers, config/version/hash invariants, intentional-subset versus genuine-partial cases, and legacy fixture bytes unchanged. `pnpm schemas:generate` then `pnpm test:integration test/integration/estimation-scope.test.ts` → fresh build, all exact-scope API/config/CLI tests pass without reference downloads. `pnpm typecheck`, `pnpm lint`, `pnpm boundaries:check` → exit 0. Record this as the independently reviewable caller-scope milestone; 017 as a whole remains unfinished until its catalog gates also pass.

### Step 4: Establish real-reference feasibility, then seed the static matcher/catalog

Implement the bounded normalizer/matcher under `src/application/dependency-reuse/`. Catalog records contain bounded reference IDs, official repository URL, immutable commit, relative source path, original file SHA-256, worker-validated reference pragma/selected and compatible grammars, declaration kind/name, parser package/normalizer identity, digest, and a license/provenance note. Multiple references sharing content retain their compatible IDs. Refuse parser/normalizer/version incompatibility; keep unknown releases and modified declarations at full review cost in `all` mode. Caller mode applies its independent selection even if recognition is unavailable or mismatched.

Add `scripts/generate-dependency-catalog.mjs` and its reviewed manifest. It reads explicitly supplied local reference data, validates confined paths/hashes, uses the trusted parser session, and emits/checks deterministic TypeScript catalog data. Importing local TypeScript on Node 24 does not remove its dependency on the packaged worker: run `pnpm build` immediately before either mode. Bootstrap with a clearly unavailable catalog module until first generation; this cannot award matches and must not be reported as a seeded production catalog. Await `session.close()` in `finally`, including failed generation/check and cancellation. The generator never fetches, installs packages, executes reference scripts, or infers references from target comments. Expose `generate` and `check`, e.g. `node scripts/generate-dependency-catalog.mjs check --reference-root <reviewed-reference-directory>`. Normal builds/tests/analysis must not require that external directory.

Retrieve official references as data in a temporary/ignored maintenance directory using available approved network access, resolve immutable commits, and independently verify generated records against those bytes. Do not save upstream source in tracked fixtures. Before promising named sample discounts, compare actual accepted declarations with these references and record successes/mismatches. No matching result was established by the advisor. Missing `Clones`/`Address` matches must remain full-rate in automatic mode; they are a reference-coverage limitation, not justification for normalization exceptions. If no reference match can be established, stop the automatic-reuse portion and retain the completed explicit-scope milestone for review. If network is unavailable, continue synthetic matcher/projection work and report the unseeded-catalog limitation; never ship fake/sample-derived production trust entries or mark the catalog work done.

Record exact reference revisions, parser/normalizer provenance, command, runtime and generation result in `docs/dependency-reuse.md`. Apply only finalized per-file matches to the shared projection, preserving line/owned-event/builtin/storage/pair invariants. Local recognizer exhaustion falls back atomically as specified; shared interruption propagates. Never silently discount a partial recognition result.

**Verify**: `pnpm test test/unit/dependency-reuse.test.ts -t 'fingerprints|catalog|budget'` → nonzero tests pass, including mutation, spoofed markers, parser/grammar incompatibility, giant-token checkpoint, local fallback, shared deadline and cancellation cases. `pnpm build` followed by the generator `check` command → exit 0 on the pinned acquired reference directory, no tracked changes, no retained worker process. `pnpm test test/unit/dependency-reuse.test.ts test/unit/estimation-scope.test.ts` and `pnpm boundaries:check` → exit 0. Record actual real-reference positive evidence, not merely a self-consistent generated digest.

### Step 5: Wire provenance, report revisions, and all three commands

Complete bounded `analysis.dependencyReuse` and `analysis.estimationScope` for `inspect`, `estimate`, and `explain`, including catalog identity and both policy modes. Add matched-record validation/stable sorting to the report revision introduced in step 3 and update affected current producer fixtures. Keep consumer acceptance of additive v1 data. Add cross-field checks for aggregate/per-file line accounting, resolved IDs, policy/mode/model consistency, and narrowed coverage. Exercise error/partial envelopes and scoped inspection separately.

Render raw/review/reused/caller-excluded SLOC and integration explanation in terminal and Markdown, with reference or caller-selection detail in explain output and structured JSON. Use existing sanitization and display sorting. Replace the blanket indicator limitation with wording that test presence/name-based indicators never earn reuse credit; the matcher alone supplies content evidence. Include catalog identity in analysis hashing and explicit scope in semantic config hashing. Demonstrate deterministic output for unchanged inputs and selector order independence. Changing selection must change the semantic/analysis identity while preserving raw source/relationship evidence.

**Verify**: `pnpm schemas:generate` followed by `pnpm schemas:check` → only expected schema changes, exit 0. `pnpm test test/unit/domain.test.ts test/unit/reporting.test.ts test/unit/estimation-scope.test.ts test/unit/dependency-reuse.test.ts` → all pass; old consumer/config fixtures are accepted and strict new producers validate. `pnpm test:integration test/integration/estimation-scope.test.ts test/integration/dependency-reuse.test.ts` → fresh build, nonzero tests, all pass. `pnpm docs:check` → registered config/command/version examples remain consistent.

### Step 6: Verify actual default behavior on the user's sample and installed package

When the supplied local file exists and still matches the recorded SHA, run the built CLI with `--no-config --format json` and parse stdout in memory. Do not pass `--output`, overwrite `report.json`, or change the target. Compare the explicit legacy library/config path and the new default; any temporary estimator config belongs in a disposable test directory and must not change the target's scope/root. Record measured raw/review/reused SLOC, match reference IDs, low/high category totals, pair counts, and high-reserve status.

Use this concrete reproduction after the fresh integration build. It writes only a temporary estimator config and summarizes the two CLI reports in memory:

```sh
node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const target = '/Users/geovla/Developer/work/apps/coinscope/public/commonContracts/pinksale/AntiBotBabyToken.sol';
const bytes = await readFile(target);
if (createHash('sha256').update(bytes).digest('hex') !== 'c6764b24b7ec3352aa26b688bf96600f28c92d3798d0b265ff7a217f7af743e0') {
  throw new Error('Sample changed: do not compare with the frozen 96–457 baseline.');
}
const temporary = await mkdtemp(join(tmpdir(), 'audit-estimator-017-'));
try {
  const configPath = join(temporary, 'legacy.json');
  await writeFile(configPath, JSON.stringify({ configVersion: '1.0.0', model: { profile: 'heuristic-v1', modelVersion: '1.0.0' } }));
  for (const [label, flags] of [['default', ['--no-config']], ['legacy', ['--config', configPath]]]) {
    const child = spawnSync(process.execPath, ['./dist/bin.js', 'estimate', target, '--format', 'json', ...flags], { encoding: 'utf8', shell: false, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(`${label}: ${child.error?.message ?? child.stderr}`);
    const report = JSON.parse(child.stdout);
    const categories = {};
    for (const row of report.estimate.contributions) {
      const total = categories[row.category] ??= { low: 0, high: 0, count: 0 };
      total.low += row.lowMicrohours / 1000000;
      total.high += row.highMicrohours / 1000000;
      total.count += 1;
    }
    console.log(JSON.stringify({ label, model: report.versions.model, hours: report.estimate.auditorHours, rawSloc: report.analysis.aggregates.sourceLines, reuse: report.analysis.dependencyReuse, categories }, null, 2));
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
NODE
```

Expected: legacy reports 1.0.0 and 96–457 hours; default reports 1.1.0 with the source/match/accounting conditions below. This shell example is a maintainer verification instruction, not a new registered public-doc command.

Acceptance for this exact local sample: raw SLOC remains 1,746; every reported match has independently obtained official reference evidence; only actually matched declarations are omitted in default `all` mode; custom root/dividend/helper declarations stay at full review cost unless independently matched. If `Clones` and `Address` match, their assembly leaves the review view; otherwise retain the unmatched assembly and disclose the coverage gap. Record precise endpoint/category changes, including increased boundary charges and remaining reserve. No arbitrary final number, mandatory named match, or universally decreasing endpoint is an acceptance oracle. If the catalog yields no meaningful match for this sample, document that limit and demonstrate the caller-scope alternative; do not mark automatic support for this sample as established. If the sample differs or is absent, label that reproduction unavailable and use the reviewed reference-data experiment plus portable synthetic regressions; do not hardcode the workstation path into automated tests.

Run a third explicit-scope experiment against the original synthetic example and, when accessible, the unchanged private sample. Select a deliberate recorded list of current path/kind/name declarations from `inspect` and pin the accepted file hash for the private experiment; do not derive scope from `Dependency file` comments. Put config 1.1.0 only in a disposable estimator directory and preserve the target/root. Expect exit 4 and analyzed-subset coverage when declarations were excluded, `fullScopeEstimate=null`, exact selected/context IDs, no applied reuse lines, unchanged raw metrics, and independently checked review/out-of-scope lines and boundary ledger. A programmatic `AnalyzeRequest.estimationScope` and equivalent data-only config must produce identical semantic settings/estimates. Using disposable synthetic data only, confirm the selection still works with an unavailable catalog and with locally modified nonselected context when no hash guard is supplied; a pinned stale source hash must fail instead of silently retargeting. Never mutate the user's source for this experiment.

The registry is statically bundled into an existing production chunk. Preserve production entries and the existing package artifact allowlist. Add installed-package assertions for registry identity/metadata, default model, exact library request/config scope parity, and intentional subset behavior using original synthetic data. Run a manual positive-match experiment against the same temporary official reference data using the installed analyzer, without making package CI download Solidity. Retain network-denial and import-time purity checks. If installed real-reference evidence is unavailable, record it as an unfinished verification gate rather than weakening the artifact assertions.

**Verify**: `pnpm test:integration test/integration/estimation-scope.test.ts test/integration/dependency-reuse.test.ts test/integration/application.test.ts test/e2e/cli.test.ts` → all pass after a fresh build. Local stdout comparisons meet the stated conditions when sources are available; installed real-reference positive evidence is recorded. `pnpm test:package` → passes with catalog bundled and exact scope supported, no new runtime files/source dependencies or reference fetches. Do not weaken artifact assertions if the bundler unexpectedly changes chunk layout; investigate and report scope drift.

### Step 7: Document the reuse policy and run the complete gates

Write `docs/dependency-reuse.md` with exact caller-scope and match rules, selector/hash semantics, no automatic ancestor expansion, explicit selected-match precedence, reference revisions/generation procedure, catalog coverage, raw/review/reused/out-of-scope line meanings, full-cost mismatch behavior in `all` mode, model/config compatibility, known binding/override/compiler limits, no-runtime-network boundary, and actual manual evidence. Explain intentional partial coverage/exit 4 and null whole-project effort for narrowed scope. Write the 1.1.0 model amendment while retaining the frozen 1.0.0 specification. Update listed public docs/version facts and registered examples. Narrow the roadmap's deferred dependency item to remaining unsupported capabilities; content matching does not depend on a compiler adapter.

Keep all default coefficients visibly uncalibrated. Record what was actually tested and any missing reference coverage/platform/package evidence. Mark 017 DONE only after all required local gates and seeded production recognition pass.

**Verify**: `pnpm check` → exit 0 across all gates; `pnpm test:coverage` → existing thresholds pass; `pnpm test:package` need not be repeated if step 6 passed and step 7 changes only docs/manifest evidence. `git diff --check` → exit 0. `git status --short` → no edits outside Scope and no tracked target/upstream source.

## Test plan

Use source-only DTO/oracle tests patterned after `test/unit/application-estimate-input.test.ts` and `test/unit/estimation.test.ts`. Native parsing belongs in `test/integration/dependency-reuse.test.ts`, following `test/integration/structural-extraction.test.ts` and the `withProject` pattern in `test/integration/application.test.ts`; use their bounded trusted parser worker and cleanup. Module mocks/test-only catalog arguments are allowed in tests, not as a target-controlled production extension.

Required named cases:

1. **Exact reusable declaration** matches the test catalog, removes only its full-review facts, retains raw evidence, and keeps the once-per-project allowance.
2. **Flattened with custom dividend helper** discounts the matched library but fully counts both the root and custom dependency. Marking the custom helper `Dependency file` changes nothing.
3. **No markers / Hardhat markers / supplied Dependency-file markers** produce the same content match and review facts for otherwise identical code. Multiple declarations in one section work.
4. **Whitespace, LF/CRLF, BOM, comments and Unicode** preserve matching under normalizer rules while evidence stays in original byte/scalar coordinates. Raw source hashes and displayed SLOC may change with formatting; do not require identical totals across differently formatted sources.
5. **Builtin integer aliases** match outside assembly; `uint128`, `bytes32`, identifiers, string text and assembly identifier changes do not normalize away. Coarse `unknown` numeric token kinds retain exact literal bytes.
6. **One-token logic, modifier, initializer, inheritance, storage or literal change** prevents reuse of that entire declaration. Merely naming a custom contract `ERC20`/`Ownable` or spoofing its comment cannot match.
7. **Same-name dependencies and overrides** leave unmatched bases/overrides chargeable and retain boundary/uncertainty evidence; no content match asserts resolved runtime behavior.
8. **Library-only assembly** has raw assembly > 0 but review assembly = 0. Add assembly in a custom contract and its EVM premium remains. Confirmed custom low-level calls still create the existing channel; unknown custom candidates stay unavailable.
9. **Storage projection** removes matched state IDs and recomputes counts/shapes/complex IDs consistently. Remaining user-defined mutable storage stays unavailable and retains the reserve. No measured contradiction is fabricated by filtering.
10. **Pair projection** checks every truth-table row, reverse directions, inheritance+call deduplication, same physical file endpoints, and repeated/shared library uses. Two custom callers retain their distinct boundary pairs; shared reusable internal pairs are not re-reviewed.
11. **Mixed tokens on one physical line / top-level free function** retain the line once; raw = review + fully reused + caller-excluded. Exercise both modes; no negative/double-counted SLOC. Do not sum contract SLOC as the file total.
12. **Failed syntax, missing context, partial mode, invalidated ownership** retain existing completeness/omission/exit contracts. Recognition cannot turn partial analysis complete or clear upstream unknown flags.
13. **All reusable versus empty** positive raw analyzed SLOC with zero review SLOC permits the project allowance; empty/comment-only or unavailable baseline without a summary remains null. Test every `reviewSummary` truth-table row and reject absent/invalid mode in a supplied summary, mixed omission reasons, mode/narrowing conflicts, zero-review contract scope, unavailable per-file lines with a supplied summary, unsafe aggregate totals, and legacy summaries. Imports/pragmas remain review tokens, so a declaration-only all-reusable fixture must explicitly omit them; do not assert zero review for an ordinary pragma-bearing source.
14. **Explicit legacy 1.0.0** preserves frozen literals and raw-file pair/premium semantics. New default 1.1.0 in `all` mode with no matches has the same numerical result as legacy for the same raw facts/parameters; only version/policy/report metadata differs. Version identity follows effective selection in estimate, inspect, partial and post-config errors. Unknown versions fail validation; explicit contract scope with model 1.0.0 is rejected. Layered model-version changes preserve prior explicit parameter overrides.
15. **Bounded matching and deterministic reports** exercise catalog conflicts/shared content, count/record bounds, token/event/byte checkpoints inside a single large declaration and literal, stable reference sorting, catalog fingerprint changes, no dropped custom code, and no import-time I/O. Local recognition failure falls back atomically; shared cancellation/deadline/limit propagate and never return a successful full-review fallback. Corrupt catalog data cannot discount code or change a valid caller selection.
16. **Real reference evidence** generation/check uses a fresh built worker, closes it on success/error/abort, and succeeds on pinned reference data. Record actual sample matches/misses and ledger changes when accessible; no required named match or forced lower endpoint. Normal unit/integration/package CI uses committed original data and does not require this user's filesystem or network access to Solidity repositories. Record the separate installed-analyzer real-reference positive experiment.
17. **Exact caller list independent of fingerprints** selects two named declarations while a modified/unrecognized custom helper remains context. Selected declarations matching the catalog still receive full review. Unknown/unavailable catalogs and formatting/marker variants cannot alter the selection; no ancestor/helper expansion occurs. Non-contract code/free functions remain charged. Known selected↔context boundaries remain; context↔context pairs do not. Library request and equivalent config agree.
18. **Selector validation and identity** covers empty/duplicate lists, zero/multiple matches, same short name in different files, incorrect kind/case/path, native/traversal/glob paths, blocked/excluded/third-party files, optional current/stale hashes, same-name edited declaration without a hash, count/text limits, failed selected parsing and shared interruption. Invalid/unresolved selectors produce no estimate. Reordering a valid selector list preserves semantic hash and output; changing the selected set changes semantic/analysis hashes while leaving source evidence unchanged.
19. **Intentional subset versus failed analysis** verifies complete raw analysis + narrowed selection yields analyzed-subset/partial, null full-scope estimate, exit 4, and `requestedScopeComplete=true` without `allowPartial`. Genuine analysis failures retain existing opt-in/completeness rules; unresolved selected inputs never silently shrink the list. `inspect` stays complete for complete raw analysis. All eligible declarations selected means no intentional narrowing. Same-line exclusions still mark narrowing even when fully excluded line count is zero. Inject a typed numeric-projection failure after resolving the partition: retain known IDs, make all aggregate counts unavailable, omit unfinished numeric rows, set requested completeness false, and attach no estimate even with `allowPartial`; reject mixed measurement states and incomplete partitions. A partition-size/output-bound failure instead produces an analysis error envelope with `LIMIT_EXCEEDED` and null analysis/estimates.
20. **Config revision compatibility** accepts strict old 1.0.0 inputs and new 1.1.0 inputs, rejects new fields under the old input revision and unsupported versions, preserves existing root/data-only read rules and parameter precedence, and validates the request override even with `noConfig=true`. Compare the same selector object supplied by library request, root config, nested config, and temporary config outside the project: all resolve against the explicit project root and agree on semantic hash, IDs, and estimate. Existing config-relative source/remapping/coverage paths retain their current behavior. New selection is included in resolved provenance and semantic hashing without granting metadata/comments authority to select contracts.
21. **No universal monotonicity promise** hand-calculate a case where converting interactions to higher-rate boundaries offsets some removed baseline effort. Compare exact ledger rows and outward rounding rather than asserting that any omission always reduces both endpoints.

## Done criteria

- [ ] New named tests above exist and run with nonzero counts; no skipped placeholders.
- [ ] Explicit 1.0.0 engine worked cases and original arithmetic fixture bytes are unchanged.
- [ ] Default model is 1.1.0, explicit 1.0.0 remains selectable, and envelopes identify the effective model.
- [ ] Exact caller scope works through config 1.1.0 and the library request with no catalog requirement; old config 1.0.0 inputs remain supported by their strict old shape.
- [ ] Selected declarations stay full-rate, unselected declarations stay context without automatic expansion, and invalid selectors never silently narrow or retarget scope.
- [ ] Intentional subsets retain raw completeness and subset/partial coverage, exit 4, null `fullScopeEstimate`, and explicit requested-scope metadata; genuine partial analysis retains its existing rules.
- [ ] Checked production catalog has immutable official provenance, source hashes, normalizer identity, and successful reference-generation evidence; no sample-derived trust entries.
- [ ] Raw metrics/graphs and required completeness remain intact; review/reused/out-of-scope line conservation and both pair partitions pass tests.
- [ ] Summary mode/line/narrowing invariants, incomplete-projection reporting, config-location/request parity, and bounded derived line counting pass the specified regression cases.
- [ ] The real sample comparison records actual matches/misses and ledger changes when accessible; otherwise record the exact unrun condition and alternate real-reference evidence. No false claim that a named library or the sample is automatically supported.
- [ ] Installed-analyzer real-reference recognition and installed exact-scope synthetic experiments pass and are recorded; normal CI needs no upstream-source download.
- [ ] `pnpm check`, `pnpm test:coverage`, and `pnpm test:package` exit 0 with existing safety/coverage/package controls intact.
- [ ] `git diff --check` exits 0; no implementation edits outside Scope; no source from the target or unapproved upstream fixtures is tracked.
- [ ] `plans/README.md` row records execution status and factual verification results.

## STOP conditions

Stop the affected work and report, continuing independent safe steps where possible, if:

- Accepted parser tokens/ranges or the estimator contracts materially differ from the current-state excerpts and cannot support the specified projection.
- Recognition needs target execution, an installed compiler, a parser-boundary change, runtime network access, or trusting comments/names.
- Official reference identity or file hashes cannot be established, or a desired match requires an undocumented normalizer exception. Retain full review for that code; never manufacture a match or mark the seeded-catalog gate complete.
- A selected declaration cannot be uniquely resolved, hash-guarded as requested, or projected with consistent evidence. Return a sanitized failure rather than silently omit it or widen the caller's scope. Shared interruption is not a config typo or local recognition fallback.
- A source-compatible match is being interpreted as proof of dependency version, bindings, compiler equivalence, or security.
- You cannot prove retention of all required full-review code, separation of caller exclusions from content reuse, line conservation, consistent storage IDs, retained-call coverage, or pair disjointness.
- Preserving 1.0.0 appears to require changing its frozen arithmetic expectations; report the incompatibility instead.
- Copying upstream source fixtures is needed despite the approved-provenance constraint. Use synthetic tests/temporary reference evidence first; report any remaining requirement concretely.
- A verification step fails twice after reasonable fixes, or success requires weakening limits, boundaries, coverage, package allowlists, or unrelated assertions.
- Implementation needs a file or behavior outside Scope, including unexpected build chunk/packaging changes.

## Maintenance notes

Catalog releases and normalizer changes alter effective review facts and must change their version/digest and analysis fingerprint. Review reference additions like estimation-policy changes: pin official source, recompute hashes, record provenance, verify mutation negatives, and make no automatic security endorsement. Do not grow the registry by trusting package-lock names, flattening banners, or frequently seen copies.

Raw metrics remain the diagnostic source of truth; effective review facts belong to the selected model. Future function-level diff accounting, unused dependency reachability, independent interface-specific rates, security-advisory policy, override-aware behavior, and empirical calibration are separate follow-ups. File-level decision density and remaining-code EVM premiums retain their existing coarse behavior in this plan; the correction removes matched library facts rather than redesigning every premium.

Caller scope is maintained by the engagement owner. A selector without a hash follows a declaration name through edits; a hash-pinned selector must be refreshed deliberately after a source change. Contract IDs/byte offsets remain snapshot-specific. Changes to selection, reasons, or optional hash guards change semantic config identity. Neither narrowing scope nor recognizing library content establishes adequate review of inherited/deployed behavior. Keep the exact-scope milestone independently usable when reference coverage is incomplete.

Reference material inspected during planning: [OpenZeppelin ERC20 at v4.3.2](https://raw.githubusercontent.com/OpenZeppelin/openzeppelin-contracts/v4.3.2/contracts/token/ERC20/ERC20.sol) and [upgradeable Initializable at v4.3.2](https://raw.githubusercontent.com/OpenZeppelin/openzeppelin-contracts-upgradeable/v4.3.2/contracts/proxy/utils/Initializable.sol) provide official candidate content, not an established match to the sample. [Solidity integer types](https://docs.soliditylang.org/en/latest/types.html#integers) documents the two integer aliases. [Hardhat flattening](https://v2.hardhat.org/hardhat-runner/docs/advanced/flattening) documents combined source and `// File` markers; the user's file uses another marker form. Resolve all release/tag candidates to immutable commits before catalog generation.
