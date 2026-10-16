# Estimation scope and dependency reuse

A flattened contract loses the path distinction between project code and dependencies, so familiar library implementations and their relationships are priced as newly written project code. This page records how a caller states which declarations an estimate covers, how content-verified reuse is recognized and accounted, and the evidence behind both. It is a planning-policy change under [model 1.1.0](model/heuristic-v1-1.md); it is not a claim that any code is safe.

Two independent inputs exist and must not be conflated:

- **Caller selection** (`estimationScope`) states which declarations belong in the engagement. It needs no reference data.
- **Content recognition** identifies declarations whose complete token content matches a reviewed upstream reference. It never creates a caller scope, and failed or unavailable recognition never silently narrows an estimate.

Caller-excluded code is context chosen by the caller. It is never evidence of verified reuse.

## Caller scope

`estimationScope` is available as `AnalyzeRequest.estimationScope` and as a `1.1.0` config field. The selector grammar, hash guard semantics, project-root-relative paths and error behavior are described in [configuration](configuration.md#estimation-scope).

Selected declarations receive the ordinary full-review rate even if they also match the catalog: an explicit selection always wins, and `analysis.dependencyReuse.policy` is `full-review` with the matches disclosed only.

### Accounting

For the eligible, successfully analyzed first-party scoped files the application derives a **review projection** next to the raw metrics. Raw file, contract and callable metrics, relationship graphs, indicators and the source fingerprint keep their meaning. The projection:

1. removes the tokens, declarations and events of each omitted top-level declaration, keyed by its original contract identity and byte range;
2. counts review SLOC as the union of physical lines touched by retained non-trivia tokens, using a bounded incremental decoder, so a line shared with retained code stays chargeable once;
3. recomputes decisions, storage counts and shapes, assembly and confirmed builtin calls from retained facts; the builtin count is recomputed with the existing rule over retained call sites only when their coverage can be proved, and otherwise stays unavailable;
4. conserves lines: `raw = review + content-reused + caller-excluded`, per file and in aggregate.

Free functions, file-level constants and directives, imports and pragmas always stay in the review. Directed contract pairs are re-partitioned by role (see the [1.1.0 amendment](model/heuristic-v1-1.md#pair-projection)); the graph itself is unchanged.

### Reported metadata

`analysis.estimationScope` is present in every non-error analysis. It records the mode, the caller's reason, the sorted selected and context contract identities, `scopeNarrowed`, `requestedScopeComplete` and four aggregate line counts. The counts are all measured or all `unavailable`. If a projection cannot be completed the partition is kept, the counts are unavailable, `requestedScopeComplete` is false, and no estimate is produced even with `--allow-partial`. An over-large internal scope is reported as a sanitized `LIMIT_EXCEEDED` error with no analysis. `requestedScopeComplete` does not replace `requiredAnalysisComplete`.

### Coverage and exit status

A narrowed estimate keeps the existing vocabulary: `coverage: analyzed-subset`, `fullScopeEstimate: null`, status `partial` and exit code 4, without a second `--allow-partial` opt-in, because the caller authorized the subset. Genuine required-analysis failures keep their existing rules and still need `--allow-partial`. If every eligible declaration is selected, nothing is narrowed. `inspect` reports the scope metadata and stays complete when raw analysis is complete.

### Limits of an explicit selection

- Selecting a contract does not select its inheritance ancestors, helpers or callees. A named root contract alone is not the behavioral scope of a deployed token, because Solidity inheritance combines base behavior. List every declaration whose review belongs in the engagement.
- Known relationships between selected and context code keep a boundary allowance; relationships among context declarations are not charged.
- Without a hash guard a selector follows the same path, kind and name through source edits. A guarded selector must be refreshed deliberately.

## Content recognition

For each complete top-level contract, abstract contract, library or interface of an eligible parsed file, the application computes a digest and looks it up in a bundled, statically generated catalog. Markers such as `// Dependency file:` are comments and play no role: the same content matches with no markers, Hardhat markers or misleading markers, and a custom declaration under a library's name does not match.

### Normalizer `solidity-tokens-v1`

The digest is SHA-256 over `frame('dependency-declaration') || frame('solidity-tokens-v1') || frame(kind) || frame(name) || frame(String(significantTokenCount))` followed by `frame(token.kind) || frame(tokenBytes)` for every significant token in source order, where `frame(bytes)` is the ASCII decimal byte length, a colon and those bytes (strings are UTF-8 encoded first) and `||` is byte concatenation. Whitespace, comments and NatSpec are ignored; identifiers, strings, numbers, operators, widths, inheritance, visibility, mutability and assembly text are hashed exactly. The only rewrite is the builtin integer alias `uint` to `uint256` and `int` to `int256` on Solidity keyword tokens outside Yul assembly. There is no renaming, reordering, fuzzy or AST-similarity matching.

The independent oracle for `library Tiny {}` has four significant records and the 135-byte digest input `22:dependency-declaration18:solidity-tokens-v17:library4:Tiny1:47:keyword7:library10:identifier4:Tiny11:punctuation1:{11:punctuation1:}`, whose SHA-256 is `7e69f4495d8e7fe43b38035f36609488707492fd70ef492aad45afa90db0dc8d`. The unit tests recompute only the hash of that literal, and an integration test confirms the real parser's tokens for `library Tiny {}` produce the same digest. Hashing streams unchanged token bytes in slices of at most 64 KiB with a shared-budget checkpoint between slices and every 256 tokens.

### What a match means

A digest match establishes token-equivalent declaration content under the documented normalizer, nothing more. It does not establish the installed package or release, external constants, imports, file-level `using` directives, override dispatch, dependency bindings, compiler behavior, deployment or security. Several releases that share content all remain in `referenceIds`; no exact version is reported as detected. An entire changed declaration, however similar, stays at the full-review rate, and a known declaration beside a malicious same-name base or override does not remove that custom code from review.

A candidate is accepted only when the active parser package version equals the version the catalog was generated with, the normalizer identity matches, and the target's selected grammar belongs to the reference's worker-validated compatible grammar set. A parser upgrade therefore requires regenerating the catalog (a unit test fails until then).

### Model policy and fallbacks

Under model `1.1.0` and whole-scope mode the matched declarations receive no full-review baseline or premium (policy `verified-reuse`); the project allowance, boundary allowances for custom-to-reused relationships, the reserve and manual adjustments remain. This zero full-review cost is an uncalibrated planning assumption, not a consequence of a hash. Under the frozen `1.0.0` model, or with an explicit contract selection, matches are disclosed with policy `full-review`.

- A corrupt, unavailable or parser-mismatched catalog, or a local per-file recognizer allowance exhaustion, leaves that code at full review: no partial recognition result is ever accepted for a file, and `analysis.dependencyReuse.files[].unavailableReason` records a fixed safe reason.
- A shared cancellation, deadline or limit failure is never a fallback: it propagates to the existing interrupted or `LIMIT_EXCEEDED` handling.
- `analysis.dependencyReuse` records the catalog version and digest, so a catalog change alters the analysis fingerprint (not the source fingerprint).

## Reference catalog

The catalog contains digests and provenance only; no upstream source is stored. Each file record pins the repository, tag, immutable commit, file path, original file SHA-256, license, pragma evidence, selected grammar and the compatible grammar set captured by the trusted worker.

| Alias                  | Repository and tag                                               | Commit                                     | License |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------ | ------- |
| `oz-contracts`         | OpenZeppelin/openzeppelin-contracts `v4.2.0`                     | `9fbc1d71c0ed4c68a0bc160c69df1f85e94d2d8e` | MIT     |
| `oz-contracts`         | OpenZeppelin/openzeppelin-contracts `v4.3.2`                     | `0c4de6721d9668d7b5b2c5a9400fd0b2a5e8de90` | MIT     |
| `oz-upgradeable`       | OpenZeppelin/openzeppelin-contracts-upgradeable `v4.2.0`         | `875c640787f467b3c912eec33ce1e7b73f838117` | MIT     |
| `oz-upgradeable`       | OpenZeppelin/openzeppelin-contracts-upgradeable `v4.3.2`         | `5c21639dc39b9062310ee3ca30aa2c3a4feccd8f` | MIT     |
| `uniswap-v2-core`      | Uniswap/v2-core `v1.0.1`                                         | `4dd59067c76dea4a0e8e4bfdda41877a6b16dedc` | GPL-3.0 |
| `uniswap-v2-periphery` | Uniswap/v2-periphery `v1.0.0-beta.0` (`IUniswapV2Router01` only) | `949199ec79cf4b4a67c34da344f1ca7e9ce2acb2` | GPL-3.0 |
| `uniswap-v2-periphery` | Uniswap/v2-periphery `master-ed24991` (pinned commit)            | `ed24991304291297c3b4a52818d02f46a17aa9a2` | GPL-3.0 |

Each OpenZeppelin release contributes `Ownable`, `Clones`, `ERC20`, `IERC20`, `IERC20Metadata`, `Address`, `Context` and `SafeMath` (and the `Upgradeable` counterparts plus `Initializable`). The four Uniswap V2 factory, pair and router interfaces are included as reference candidates only: no router or pair implementation is discounted. The generated catalog is version `1.0.0` with 37 files and 37 declarations; its digest is `d72accbbcfb7dce7200cb9b927ba81d7d121961b2628067c6d2be42d29c1bbae`, generated with Slang parser `1.3.9` and normalizer `solidity-tokens-v1`. Because the Uniswap interfaces are GPL-3.0 and the catalog stores only content digests of them, no upstream source is redistributed.

### Regeneration

The reviewed manifest is `scripts/dependency-references.json`. The generator reads explicitly supplied local reference data (one directory per reference named `<alias>@<tag>` holding the upstream files at their repository paths), verifies every file against the manifest hash, parses it with the trusted worker session and emits `src/application/dependency-reuse/catalog.ts`. It never fetches, installs, executes reference scripts or reads a target project, and `pnpm build` must run first because the worker is packaged. Normal builds, tests and analysis never need the reference directory.

<!-- docs:prerequisite -->

```sh
pnpm build
node scripts/generate-dependency-catalog.mjs generate --reference-root <reviewed-reference-directory>
node scripts/generate-dependency-catalog.mjs check --reference-root <reviewed-reference-directory>
```

The reference data for the current catalog was retrieved as data from the official repositories at the commits above, each file also verified against the git blob SHA-1 reported by the GitHub contents API for the same commit, into a temporary untracked directory. Adding a reference is a policy change: pin the official source, recompute hashes, record provenance, verify mutation negatives, and never grow the catalog from package-lock names, flattening banners or frequently seen copies.

## Evidence

Generation was run on Node v24.21.0 with Slang `1.3.9` and `check` passed against the same reference data with no tracked changes and no retained worker process.

Synthetic projects (original, hand-counted): `examples/projects/contract-scope` has 22 source lines; selecting `Token` leaves 9 review lines and 13 caller-excluded lines, one `Token` to `Lib` boundary pair, and a 4 to 19 hour range whose ledger is hand-calculated in the integration and documentation suites. The integration suite also covers marker independence, spoofed markers, mutation, the unavailable and corrupt catalog fallbacks, local allowance fallback, shared-failure propagation, a reusable assembly library leaving the EVM channel while custom assembly keeps its premium, and the packed library's exact-scope parity.

### Private sample (manual, read-only)

The unchanged local file `AntiBotBabyToken.sol` (SHA-256 `c6764b24b7ec3352aa26b688bf96600f28c92d3798d0b265ff7a217f7af743e0`, 1,746 raw SLOC, 28 declarations) was analyzed through the built CLI with `--no-config --format json` and parsed in memory. It is not part of the repository and no output was written. Results on 2026-10-16:

| Run                                                          | Hours                                                           | Review / reused SLOC                        | Matched declarations       |
| ------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------- | -------------------------- |
| Frozen model `1.0.0`                                         | 96 to 457 (exit 0, unchanged from the baseline)                 | 1,746 / 0                                   | 18 disclosed, none applied |
| Default model `1.1.0`                                        | 50 to 228 (exit 0, full coverage)                               | 916 / 830                                   | 18 applied                 |
| Explicit selection of the 10 other declarations, hash pinned | 50 to 228 (exit 4, `analyzed-subset`, null full-scope estimate) | 916 reviewed, 830 caller-excluded, 0 reused | 18 disclosed, none applied |

The 18 matches are `IERC20`, `IERC20Metadata`, `Context`, `ERC20`, `Ownable`, `SafeMath`, `Clones`, `Address`, `IUniswapV2Factory`, `IUniswapV2Router01`, `IUniswapV2Router02`, `IUniswapV2Pair`, `IERC20Upgradeable`, `IERC20MetadataUpgradeable`, `Initializable`, `ContextUpgradeable`, `ERC20Upgradeable` and `OwnableUpgradeable`. `Address` matches only `v4.3.2` (it differs in `v4.2.0`), the other OpenZeppelin matches list every compatible release, and the Uniswap interfaces match although the sample spells `uint256` where upstream spells `uint`. The custom root token, dividend, helper and arithmetic declarations (`SafeMathInt`, `SafeMathUint`, `IterableMapping`, `DividendPayingToken`, `BABYTOKENDividendTracker`, `BaseToken`, `AntiBotBABYTOKEN`, `IPinkAntiBot` and the two dividend interfaces) stay at full review. Raw assembly (five blocks) remains reported, but with `Clones` and `Address` matched none is in the review view; the EVM premium that remains comes from confirmed builtin low-level calls in the retained custom code.

Category changes (hours, low to high): baseline 69.84 to 209.52 becomes 36.64 to 109.92; control 2.8 to 21 becomes 2.36 to 17.7; EVM 13.968 to 104.76 becomes 3.664 to 27.48; interactions fall from 24 pairs (6 to 18) to 4 pairs (1 to 3) and 6 higher-rate boundary pairs (3 to 12) appear; the reserve 0 to 91.32 becomes 0 to 45.525 (user-defined storage keeps the reserve); project 4 to 12 is unchanged. The low and high sums (50.664 and 227.625) display outward as 50 and 228. These are measurements under uncalibrated coefficients, not a claim about reasonable productivity or about the supplied code's provenance.

### Installed analyzer

The packed tarball was installed into a clean consumer and run over official `v4.3.2` `Address.sol`, `Clones.sol` and `IERC20.sol` copied as data into a temporary project beside one custom contract: the three declarations matched their references (catalog `1.0.0`), 143 of 153 lines were content-reused, the custom contract stayed at full review, and the range was 4 to 17 hours. The package suite (`pnpm test:package`) additionally asserts the bundled catalog identity and metadata, the default model and exact-scope parity between library request and config using original synthetic data, and makes no reference downloads.
