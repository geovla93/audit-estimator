# Plan 005: Discover an explicit audit scope with bounded, safe filesystem reads

> **Executor instructions:** Execute only these discovery/read tasks. Run each gate before continuing. Never execute analyzed-project commands/config. Trusted analyzer verification commands below are permitted. Update status 005 in `plans/README.md`.
>
> **Drift check first:** Reviewed at `9b0bfe7` on 2026-10-15. Run `git status --short`, then both `git diff --stat 9b0bfe7..HEAD -- <paths>` and `git diff HEAD -- <paths>`, replacing `<paths>` with `src/discovery src/config src/domain test/unit/discovery-patterns.test.ts test/integration/discovery.test.ts test/integration/safe-read.test.ts test/helpers/filesystem.ts test/fixtures/discovery test/fixtures/manifest.json package.json pnpm-lock.yaml pnpm-workspace.yaml docs/dependencies.md docs/adr/004-scope-safety.md plans/005-safe-source-discovery.md plans/README.md`. Inspect untracked in-scope files too. Config/domain/workspace paths are read-only drift sentinels, not permission to modify them. Plans were already locally modified when this review began; preserve those changes. Reconcile conflicting implementation edits; unrelated changes elsewhere need only be preserved.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH (filesystem confinement and scope correctness)
- **Depends on:** `plans/003-domain-contracts-schemas.md`, `plans/004-cli-configuration.md`
- **Category:** direction / security
- **Planned at:** commit `9b0bfe7`, reconciled 2026-10-15; originally greenfield planning on 2026-10-14.
- **Plan review:** 2026-10-15 at the same commit; implementation remains TODO. Review covers discovery contracts and their direct consumers, not a whole-repository audit.

## Why this matters

Accidental library inclusion or missing first-party contracts invalidates the estimate before any formula runs. Explicit scope/ownership manifests, deterministic discovery and bounded reads make untrusted local projects reviewable without silently following links or counting generated artifacts.

## Current state and architectural context

### Reconciled implementation baseline — 2026-10-15

`src/discovery/` is absent. Plans 003 and 004 are merged: use `ScopeManifest`, `SourceSnapshot`, `ResolvedConfig` and diagnostics from `src/domain/types.ts`; runtime validation lives in `src/domain/schemas.ts`. `src/config/load.ts` already supplies `selectProjectRoot`, `resolveConfig` and physical config-path normalization. `src/config/validate.ts` already rejects unsupported glob grammar; reuse it without changing config behavior. `src/config/defaults.ts` owns operational limits and the exact default exclusions (including `**/*.t.sol` and `**/*.s.sol`). Picomatch and smol-toml are not installed or declared yet.

The implemented internal snapshot contract is:

```ts
// src/domain/types.ts:376
export interface SourceSnapshot {
  readonly canonicalPath: string;
  readonly absolutePath: string;
  readonly originalBytes: Uint8Array;
  readonly originalText: string;
  readonly byteHash: string;
}
```

Keep original text including BOM/newlines; any normalized view is an additional internal derivative, never a replacement. `canonicalPath` is root-relative; native paths remain internal. Reuse `fileIdentity` from `src/domain/canonical.ts` after safe identity selection. Config path `.` denotes the root; do not pass it as a file identity. `firstPartyOverrides` and `thirdPartyRoots` are normalized directory/path roots, not glob patterns; only include/exclude lists use the restricted matcher.

`ScopeManifest` currently contains only entries and the three role-ID lists. Each entry requires a real byte hash and physical identity; it has no selection-reason or pruned-tree fields. Define an internal discovery-result companion in the in-scope discovery modules for excluded/unread candidates, pruned directories, root decisions, counters, rule provenance and diagnostics. Do not read excluded/unsafe files merely to invent manifest entries, and never fabricate hashes or evidence ranges. Only safely read files can receive complete entries; keep unread candidate observations separate. Plan 013 must carry those observations into report diagnostics/limitations without adding unreviewed schema fields. If this cannot preserve a required machine-readable observation, STOP for a focused domain/schema amendment rather than weakening the read policy.

`selectProjectRoot` canonicalizes inputs, so retain the original lexical target/root separately and inspect them before losing symlink information. Discovery must enforce the default skip policy even when config root selection resolved the link. Config also normalizes configured roots physically; recheck the paths actually used and do not claim that normalized settings retain their original lexical aliases. Do not alter the config loader to hide this distinction. For tests, follow the `mkdtemp`/`try`/`finally` cleanup pattern and the local `trustedDefaults()` factory in `test/integration/config.test.ts`; its numeric values are test-only, not a production profile. Accept already-resolved scope/limits or explicit test defaults here: the production model is supplied in 011, not invented in 005.

Match established strict ESM conventions: `.ts` source imports, explicit named exports and exported annotations, `import type`, readonly DTOs, no `any` or suppressions, unknown caught values narrowed before use. Tests use Vitest source imports for units and the trusted build-first integration wrapper for artifact suites.

### Existing contracts to preserve

Use `node:fs/promises`, `node:path`, `node:crypto` plus exact-pinned Picomatch and smol-toml; no filesystem glob walker or project framework runtime. Consult [Picomatch options](https://github.com/micromatch/picomatch#options), [smol-toml](https://github.com/squirrelchat/smol-toml), [Foundry config](https://github.com/foundry-rs/foundry/blob/master/crates/config/README.md), and [Hardhat paths](https://hardhat.org/docs/reference/configuration#path-configuration). Verify selected release behavior at implementation; this review did not select or install new versions.

Scope and ownership are independent: role `scoped|context|excluded`, ownership `first-party|third-party|unknown`. Imports are not resolved here. This module exposes `discoverScope`, `readSource`, `readProjectMetadata` and reusable `resolveSafePath`. All public paths are root-relative POSIX; absolute/native paths remain internal. Root is explicit `--root`, directory target, or file parent; target must be inside it. No parent traversal/project search. Ordinary metadata hints never supersede explicit estimator settings.

ADR 002 requires physical identity selection before `fileIdentity`, original-byte SHA-256 hashes, root-relative public identities and original source coordinates. ADR 003 freezes config precedence and glob grammar. The relevant current shapes are:

```ts
// src/domain/types.ts:54 — unchanged public domain contract
export interface FileScopeEntry {
  readonly fileId: FileId;
  readonly path: string;
  readonly role: ScopeRole;
  readonly ownership: Ownership;
  readonly ownershipEvidence: readonly EvidenceRef[];
  readonly physicalIdentity: string;
  readonly byteHash: string;
}
// src/config/merge.ts:33 — use this type for metadata passed to resolveConfig
export type ProjectMetadataHints = Pick<ConfigInput, 'scope' | 'imports' | 'solidity'>;
```

Filesystem/config ownership decisions have no Solidity source range: use `ownershipEvidence: []` and record the actual path/rule in the internal companion. Do not invent `EvidenceRef` ranges. `physicalIdentity` is a representative root-relative path, never serialized device/inode numbers. The domain schema rejects duplicate file IDs/physical identities and requires role lists to agree with entries.

Define explicitly annotated internal interfaces in `src/discovery/scope.ts` and budget operations in `src/discovery/budget.ts` before consumers use them:

- Discovery input: canonical native root, lexical root/target captured before `realpath`, resolved scope/limits, validated metadata companion, and one shared budget with cancellation/deadline. Capture cwd resolution once at the boundary, never use changing process cwd mid-run.
- `DiscoveryResult`: `manifest: ScopeManifest`, `snapshots: readonly SourceSnapshot[]`, `diagnostics: readonly Diagnostic[]`, `observations` (unread candidates/pruned trees, aliases, selection/ownership rules, root decisions and test-directory presence), plus explicit completeness. A limit or failed selected read cannot masquerade as an empty complete scope. Context lists start empty in 005; 008 adds context through the same reader and identity registry.
- `SafePath`/identity registry: native resolved location and stable device/inode key internally, root-relative physical path externally; retain lexical aliases and classification before deduplication. `resolveSafePath` checks a location; its result is not permission to skip checks at open time.
- `ProjectMetadataResult`: validated `hints: ProjectMetadataHints`, root-relative Foundry libs/test/script/out paths, bounded metadata file observations and diagnostics. Preserve libs separately for 008, since `ScopeSettings` has no libs field. Metadata does not contain a model or an alternate config system.
- Shared budget: effective limits, signal, monotonic deadline, cumulative filesystem-entry/glob-state/source-byte counters, unique source identity count and bounded metadata accounting. Keep timing/native identities internal. Readers and future imports must receive the same object; never reset limits between phases. Final public counters are immutable observations.

These are internal module exports, not additions to `src/index.ts` or domain schemas. Record final signatures and how 008/013 consume them in ADR 004. In 013, metadata hints feed `resolveConfig` before source discovery; do not separately merge metadata inside `discoverScope`.

## Commands you will need

**Historical reconciliation evidence (2026-10-15, not rerun by this plan review):** missing installed Commander/Zod/Slang blocked typecheck, lint and domain/CLI unit collection; only the bootstrap source unit passed. `pnpm format:check` failed on four unchanged `.agents/skills/improve` Markdown files recorded in prior approvals. Establish the current baseline at implementation instead of treating this historical result as current verification. No new exception is granted: preserve the exact inherited format exception, verify all changed artifacts, and report the full-check failure explicitly; any additional failure blocks completion.

An executor must first run `pnpm install --frozen-lockfile` in its authorized implementation checkout and obtain success. This reconcile run did not install dependencies. Pnpm 11 attempted automatic installation before scripts and aborted removal of node_modules due to no TTY; do not set CI or approve purge merely to bypass it. With dependencies correctly installed, `pnpm --config.verifyDepsBeforeRun=false run <script>` can run an existing script without implicit dependency reconciliation; it does not repair missing packages. Do not claim schema/build/integration/coverage/frozen-install verification from this reconciliation: those gates were not rerun. Run the prescribed fresh build before any built-artifact test in implementation.

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`. `.oxfmtrc.json` deliberately ignores `plans/**` and `pnpm-lock.yaml`; targeted formatting checks apply to nonignored implementation artifacts, while plan edits use Markdown/link and diff checks.

The script names and argument forwarding below are verified against `package.json` and `scripts/test.mjs`. Feature suites are to be created by this plan. Run commands from the trusted analyzer checkout, never an analyzed-project directory. Use the build-first wrapper for every integration gate; no direct Vitest shortcut.

| Purpose | Command | Expected |
|---|---|---|
| Reproducible baseline | `pnpm install --frozen-lockfile`, then `pnpm typecheck`, `pnpm lint`, `pnpm test` | 0 before implementation |
| Pure pattern tests | `pnpm test test/unit/discovery-patterns.test.ts` | named pattern tests run and pass, no build |
| Discovery | `pnpm test:integration test/integration/discovery.test.ts` | fresh build, scope and metadata cases pass |
| Safe reads | `pnpm test:integration test/integration/safe-read.test.ts` | fresh build, path/link/limit/read cases pass |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all` | 0 except the documented inherited formatting exception |
| Schema consistency | `pnpm schemas:check` | 0 |

## Scope

**In scope:** `src/discovery/{discover,scope,budget,metadata,patterns,safe-path,safe-read,identity}.ts`, `test/unit/discovery-patterns.test.ts`, `test/integration/{discovery,safe-read}.test.ts`, `test/helpers/filesystem.ts`, `test/fixtures/discovery/**`, `test/fixtures/manifest.json`, `package.json`, `pnpm-lock.yaml`, `docs/dependencies.md`, `docs/adr/004-scope-safety.md`, 005 status row in `plans/README.md`.

**Out of scope:** `src/config/**`, `src/domain/**`, `src/index.ts`, generated schemas, trusted build/test configuration, `pnpm-workspace.yaml`, other plans, import/AST parsing, effort calculations, external sources, `$HOME`/global config, Git worktree mutation, `forge config`, Hardhat imports, npm install in analyzed projects, third-party package resolution via executable exports. A necessary lifecycle allowlist or schema/config change requires a focused amendment; do not silently expand scope.

## Git workflow

Use the supplied checkout. No commit/push/publication/branch change without operator instruction; no conventions were available during planning.

## Steps

### Step 1: Implement shared budgets, safe paths and bounded readers first

Create the internal contracts above in `scope.ts`/`budget.ts`, then `safe-path.ts`, `identity.ts` and `safe-read.ts`. Use `DEFAULT_ANALYSIS_LIMITS` instead of duplicating production defaults. Check cancellation/deadline before each operation and between bounded CPU batches; yield to the event loop so a real AbortController/timer can run. Use sequential or tightly bounded I/O, never one promise per discovered entry.

`resolveSafePath` inspects lexical components before following links and verifies both lexical and physical containment using `path.relative`, separators and volume checks. The lexical root is the operator-selected directory boundary (`--root`, directory target, or file parent) captured before canonicalization. Inspect that boundary itself and components below it; do not reject trusted OS aliases above it such as the platform temporary-directory prefix. Default skip symlink roots/targets/files/directories with `PATH_BLOCKED`, including an intermediate target component below the boundary. With `followSymlinks=true`, require resolved locations inside canonical project root and, for scoped directory discovery, inside the canonical target subtree too. Check physical hard-excluded paths as well as aliases, so a link cannot expose `.git`. Track directory identities to stop cycles; distinguish a cycle from a second alias and retain the latter as an observation.

Before opening a source or metadata file, reject known special files. Open with `O_RDONLY` plus available `O_NOFOLLOW` and `O_NONBLOCK`, then descriptor `stat` and reject anything other than a regular file. Nonblocking open prevents a substituted FIFO from waiting for a writer on supporting platforms. Compare descriptor identity with the inspected file, recheck components/resolution, read bounded chunks, then compare descriptor and path identity/size/high-resolution modification metadata again. Always close handles in `finally`; never fall back to an unguarded `readFile` if a safety flag is unsupported. Test platform fallbacks and state their limitations.

`readSource` uses the effective per-file/total-source ceilings (defaults 2 MiB/64 MiB). Reserve a unique-file slot before reading a new identity and commit it on success (default maxFiles 2,000); failed reads may release the slot but never refund actual bytes read. Charge actual read bytes cumulatively, including failed reads. Enforce the smallest remaining ceiling before allocating the next chunk, with at most one overflow-detection byte. Reject growth, oversize, invalid UTF-8 and changed sources instead of estimating a prefix. Hash original bytes with SHA-256. Fatal UTF-8 decoding must preserve one leading BOM in `originalText` (for example, TextDecoder with `ignoreBOM:true`); CRLF/CR/LF stay unchanged. Empty files are valid snapshots. Any normalized/parser view belongs to later consumers. Metadata uses the same low-level confinement/open/read/close primitive, but its own byte accounting, never the source hash/manifest path.

Detect hardlinks with stable device/inode identity where available; equal bytes alone never deduplicate. Realpath alone does not deduplicate hardlinks. No raw inode/device data goes into reports. If a platform lacks reliable identity, document a conservative path fallback rather than guessing from hashes or case-folding every path. Cross-platform Node APIs do not provide atomic open-beneath confinement against hostile concurrent filesystem mutation; the documented guarantee assumes a stable local snapshot, with an OS sandbox required for the stronger threat.

**Verify:** `pnpm test:integration test/integration/safe-read.test.ts` → fresh build and passing `paths and identities`, `bounded reads` and `cancellation and cleanup` groups. Include pre-aborted signals and an actual scheduled abort; assert handles close on every error path. Do not claim Windows runtime coverage from a POSIX path-string test.

### Step 2: Read bounded metadata without executing project configuration

Add exact stable Picomatch/smol-toml dependencies with engine/license/lifecycle review in `docs/dependencies.md`. If Picomatch lacks declarations, add an exact dev-only `@types/picomatch` pin. Do not introduce `any`, a second runtime matcher or a broad script allowlist. After changing the analyzer lockfile intentionally, verify `pnpm install --frozen-lockfile` succeeds.

`readProjectMetadata` examines only fixed root-local metadata locations. Marker detection uses path inspection only: never open/import Hardhat JS/TS, package scripts or dependency manifests. Missing `foundry.toml` is normal. A present symlink/special/unreadable/oversized/malformed Foundry file produces a sanitized diagnostic and no hints from that file; do not echo TOML/parser text or native paths. Return explicit metadata validity so 013 can mark required metadata omissions honestly, rather than presenting fallback inference as fully interpreted configuration.

Use the safe reader before TOML parsing. For metadata read before resolved config exists, use trusted defaults and always reject metadata symlinks; do not infer its read policy from the file being parsed. A supplied resolved metadata ceiling can tighten the bootstrap 256 KiB cap, never increase that bootstrap cap. Read one root Foundry file; future `remappings.txt` reads in 008 share metadata accounting. Reject prototype-like keys in parsed data, validate types/counts/string lengths of recognized fields, and normalize every recognized path inside root even if another config layer will override it. Unknown normal Foundry fields are ignored, not projected into estimator config.

Recognize only `[profile.default]` `src`, `test`, `script`, `out`, `libs`, `remappings` and exact `solc`/`solc_version` strings. `src` becomes `hints.scope.sourceRoots`; parse remappings into existing `Remapping` records with confined context/target; an exact compiler version becomes `hints.solidity.version`. Conflicting compiler keys invalidate those hints; ranges/executable compiler paths are unsupported observations, never executable values or exact version overrides. Preserve libs/test/script/out in the internal companion for dependency classification/imports/test observations. A nonconventional metadata test/script/out directory is excluded from scoped selection while defaults are enabled; record the metadata rule. Empty/root-wide exclusion hints must be diagnosed rather than silently pruning the project root. First-party overrides affect ownership only, never disable these exclusions.

Warn that nondefault profiles, inheritance, environment/global overrides and Hardhat custom paths are not interpreted. Do not consult home config, FOUNDRY variables or execute `forge config`. Hardhat markers produce an informational limitation using an existing diagnostic code and conventional root selection. Effective hints pass through `resolveConfig` with its established precedence/provenance; do not recompute semantic hashes or invent config fields here. `readProjectMetadata` does not call `discoverScope` or recursively load metadata.

Implement `selectSourceRoots` in `scope.ts` as a separate bounded root-decision helper, without traversal or source reads. Apply the Step 4 selection table, resolved-config precedence and target intersection so metadata/root tests can pass before `discoverScope` is implemented. Test the full metadata → `resolveConfig` → root-decision path using the trusted test model: explicit config/CLI values must override metadata with correct provenance.

**Verify:** `pnpm test:integration test/integration/discovery.test.ts -t 'metadata and roots'` → named tests run and pass for Foundry/generic/Hardhat markers, bounded/symlink/special/malformed metadata, custom paths, confined remappings/libs and exact-version hints. Assert an inert Hardhat sentinel was neither read as source nor executed. `pnpm typecheck` → 0; `pnpm install --frozen-lockfile` → 0 with no further lockfile change.

### Step 3: Implement a bounded, literal glob policy

Implement `patterns.ts` as pure matching with no filesystem access. Reuse `validatePatternList` from `src/config/validate.ts` and effective configured list/length limits (defaults 64/512); no new grammar or lower undocumented cap. Root-relative POSIX, case-sensitive patterns support literals, `?`, at most one `*` per ordinary segment and standalone `**`. Existing validation rejects controls, backslashes, negation, braces, extglobs, character classes, absolute/drive paths and empty/dot/traversal segments. Characters accepted as literals by validation must stay literal in matching, including `+`, `$`, `^`, `|` and quotes; verify the selected Picomatch behavior instead of silently accepting regexp or quote syntax.

Compile/cache only single segments with explicit options disabling extra syntax, `dot:true`, `nocase:false`, `windows:false`, `regex:false`, `keepQuotes:true` and `fastpaths:false`; pin/review any additional options needed by the selected release. Never compile a whole multi-globstar pattern as a regexp. Combine segment matches with iterative dynamic programming. Evaluate each `(patternSegment,pathSegment)` state at most once per comparison and charge it to the shared `maxGlobStates` counter (default 10,000,000) before allocating/evaluating it. Use rolling rows or otherwise bounded state storage. Include default/user/metadata-rule comparisons in the work budget; never reset it per file. Bound caches by validated patterns, yield/check cancellation in batches, and test actual abort delivery. Limited length alone is not a proof of regexp safety.

Import the exact `DEFAULT_EXCLUSION_PATTERNS` array from `src/config/defaults.ts`. It currently covers dependency/build/test/generated directories and `**/*.t.sol`/`**/*.s.sol`; it contains no generated-file suffix rule. Do not invent suffix rules in 005. Always hard-exclude `.git` and unsafe files. Config excludes win over includes; default excludes remain active unless explicitly disabled. Do not consult `.gitignore` or implement negate/reinclude behavior. Only prune an entire directory when a rule proves all descendants are excluded (for example `**/mocks/**`); excluding `contracts/A.sol` never justifies pruning `contracts`. Retain the exact rule/index/source in observations.

**Verify:** `pnpm test test/unit/discovery-patterns.test.ts` → all tests pass without a build, covering zero/multiple globstar segments, dotfiles, root-relative anchoring, literals/quotes, malformed patterns, maximum allowed lengths, shared state exhaustion and scheduled cancellation. `pnpm typecheck` → 0.

### Step 4: Traverse deterministically and finalize scope/ownership by identity

In `discover.ts`, use iterative nonrecursive `opendir` with a small fixed `bufferSize`. Charge every returned entry before retaining it, including non-Solidity names and symlinks. Collect at most the remaining `maxFsEntries` allowance for a directory, then sort that bounded list by Unicode code point before descending. An additional entry proves exhaustion: stop with `LIMIT_EXCEEDED`, close the directory and do not analyze an arbitrary prefix. Do not use whole-directory `readdir`, recursive `opendir`, or filesystem glob APIs. Node exposes bounded iterative directory buffering via [opendir](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesopendirpath-options).

Count depth from the target directory at zero; check before scheduling each child directory (default maxDirectoryDepth 64). Charge repeated physical directory enumeration to the same budget or reuse its bounded listing, but evaluate all encountered logical aliases before suppressing work: deduplication must not silently remove an explicit selected alias. Retained entries/queues/observations are bounded by entry/file limits. Pruned paths are `not-enumerated` with unknown descendant counts. Test-directory presence is a bounded path/type observation only, never a recursive scan or claim that tests are effective.

Reject names that cannot round-trip through the domain's project-path representation instead of silently rewriting them into another file's identity (notably literal backslashes in POSIX filenames). Keep native separators distinct from filename characters, and add a collision regression test. Public path normalization is not filesystem containment.

Selection is evaluated before ownership and safe reads, using these rules:

| Target/settings | Selection before exclusions/ownership |
| --- | --- |
| Literal `.sol` file | That file only, bypassing root/include selection; defaults and explicit excludes still apply |
| Directory, nonempty effective include list | Union of include matches within the target; this replaces the default root-based candidate set |
| Directory, empty include list | Effective source roots, otherwise detected existing `src` and `contracts`, otherwise target subtree |

Resolved nonempty source roots already reflect explicit config over Foundry hints. Explicitly empty root lists suppress metadata roots through existing array replacement, then permit convention fallback. Validate configured roots exist inside root; intersect them with the directory target before walking. A valid root elsewhere in the project adds no scope outside that target. If configured/detected roots do not intersect target, observe that mismatch and return empty selection, not a wider fallback. A non-Solidity literal target produces a target diagnostic, never arbitrary source decoding. Both lexical and physical scoped paths must obey the target boundary. No extension inference or imports happen here; match the `.sol` suffix case-sensitively.

`scope.ts` applies configured third-party roots, metadata libs and conventional dependency segments (`node_modules`, `lib`, `vendor`, `deps`) as third-party. Ordinary paths outside them are first-party. A matching explicit `firstPartyOverrides` path promotes ownership with the exact rule recorded; includes alone never promote. Selected third-party/unknown candidates remain excluded observations until 008 needs context, with an actionable `OWNERSHIP_UNKNOWN` diagnostic explaining whether dependency ownership is known or ambiguous and how to promote it. Do not read excluded candidates merely to populate a hash. Unknown selected ownership cannot yield complete estimated scope.

`identity.ts` groups observed safe physical identities before finalizing classification; hardlinks count once, separate copies count separately. For multiple observed hardlink paths, choose the smallest root-relative physical path by Unicode code point as representative; symlink aliases resolve to their physical path. Use that representative consistently for `fileIdentity`, entry path, `physicalIdentity` and snapshot `canonicalPath`. Evaluate safety/exclusions on both lexical and resolved paths, and ownership on all observed aliases/physical paths. A first-party alias cannot silently launder a known dependency: conflicting observed ownership remains unknown unless explicit promotion covers the conflicting dependency paths. A plain excluded alias does not veto an independently eligible first-party selected alias. Retain alias-specific reasons regardless of the chosen representative. Hidden/pruned/unseen hardlinks cannot be claimed as classified.

Freeze the representative for each discovery identity before publishing snapshots. When 008 later finds another alias, reuse that existing ID/snapshot rather than renaming previously emitted files/declarations. Reevaluate ownership evidence: a newly observed conflicting dependency alias must invalidate eligibility/completeness pending override, never silently preserve billed first-party status. New context identities use deterministic resolution order; test a smaller-named late alias to prove existing IDs remain stable.

Only selected eligible identities are passed to `readSource`; finalize entries from successful snapshots. Unread selected failures, excluded candidates and pruned trees stay in observations/diagnostics, with no fake hashes or file IDs requiring successful read. Sort all final lists/observations deterministically, independent of directory creation order, locale and inode numbering. No contracts are named at discovery. Keep source snapshots internal and manifest role arrays consistent with schema validation.

**Verify:** `pnpm test:integration test/integration/discovery.test.ts` → all `metadata and roots`, `selection and ownership`, `patterns and manifest`, and `traversal limits` tests run and pass. Creation-order reversal, hardlink alias order, include replacement, excluded literal targets, metadata/default opt-outs and directory-budget exhaustion have explicit expected outputs. `pnpm typecheck` → 0.

### Step 5: Verify the downstream handoff and record the safety decision

Write `docs/adr/004-scope-safety.md` with the final internal signatures, metadata bootstrap policy, selection truth table, physical/alias ownership rules, counter charging, diagnostics/completeness behavior and platform race/identity limits. Explain that 008 may read scope-excluded sources as context through `readSource`, while hard exclusions, containment and source budgets still apply. Such reads neither change ownership nor automatically promote audit scope. Record observations as structured internal data that 013 can map into existing bounded diagnostics/limitations; stop if a required machine-readable report claim cannot fit existing schemas.

Sanitize diagnostic messages/details: fixed prose plus bounded root-relative paths/reason codes only, no absolute paths, file contents or raw caught errors. If an unread candidate has no complete manifest entry, omit `fileId`/range and use path details. Emit existing codes (`PATH_BLOCKED`, `TARGET_UNREADABLE`, `LIMIT_EXCEEDED`, `SOURCE_CHANGED`, `OWNERSHIP_UNKNOWN`, `PARTIAL_ANALYSIS`, `EMPTY_SCOPE`) with explicit severity/completeness; do not invent diagnostic enums. An empty valid scope differs from a failed/limited discovery. Metadata fallback limitations remain visible even when explicit config makes source selection usable.

Add handoff tests reusing one registry/budget for discovery followed by a direct context `readSource` call; do not implement imports. Demonstrate no duplicate read/count for a reused identity, independent counts for copies, cumulative file/byte limits across phases, and retained failed-read completeness. Add attributable hand-authored fixture entries without changing existing parser/domain fixture records.

**Verify:** `pnpm test:integration test/integration/safe-read.test.ts test/integration/discovery.test.ts` → fresh build, all named groups pass with no unexpected skips. Then `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm schemas:check`, `pnpm install --frozen-lockfile`, and `git diff --check` → 0 except the explicitly preserved inherited formatting exception. Review `git status --short` against the initial snapshot; only this plan's allowed implementation paths may have additional edits. Mark 005 DONE only with gate evidence and clearly reported platform skips/limitations.

## Test plan

Use 004 temporary-directory style and add reusable filesystem fixtures/helpers. Unit pattern tests import source and need no build; integration filesystem tests run through `pnpm test:integration`. Use the exact describe-group names named in step gates and confirm each `-t` gate executes tests; a zero-test/fully skipped result is not success.

Hand-author Foundry/Hardhat/generic/file fixtures, include replacement, exclusion precedence and defaults, metadata libs/custom test/output paths, nested dependency roots, literal excluded targets, no files, source-root mismatch, same-prefix siblings, symlinked targets/intermediate directories/loops, hardlinks and copied bytes. Alias tests must include a dependency alias reached before a first-party alias and the reverse, plus a followed source link whose physical target is excluded or outside the directory target. Validate completed manifests with `ScopeManifestSchema`.

Use reduced configured limits for exact-boundary and boundary-plus-one cases (files, source bytes, metadata bytes, entries, depth, glob states); no huge committed fixture trees. A directory-entry test must prove enumeration stops after the allowance plus a probe, not simply assert a returned error after whole-directory allocation. Use a narrow injected filesystem adapter or controlled Vitest mock for mutation/growth/cleanup races, and genuine filesystem cases for containment and symlinks. Read BOM preservation directly from `originalText` and compare SHA-256 against fixture bytes. Test invalid UTF-8, CRLF/CR/LF, empty files, actual scheduled cancellation, descriptor cleanup and read failure sanitization.

Permission/FIFO/link tests must detect host capabilities. Report a skip reason when unsupported; never substitute an empty passing test. Platform creation helpers run only trusted fixture setup, never a command from an analyzed root. Windows path-string cases are unit checks; actual Windows identity/open behavior remains a platform gate for the later CI plan. Do not build/test the discovered projects.

## Done criteria

- [ ] `pnpm test test/unit/discovery-patterns.test.ts` and the two focused build-first integration suites exit 0 with the named groups executed.
- [ ] `pnpm test:all`, `pnpm typecheck`, `pnpm lint`, `pnpm schemas:check`, `pnpm install --frozen-lockfile`, and `git diff --check` exit 0; frozen install makes no new lockfile changes.
- [ ] `pnpm format:check` exits 0, or fails only on the exact inherited four-file exception recorded in `plans/README.md`; changed artifacts independently pass the installed `oxfmt --check <changed-paths>` without formatting unrelated files.
- [ ] Tests validate every completed manifest against `ScopeManifestSchema`; each scoped entry is first-party and has one safe snapshot with matching canonical identity/hash and a selection/ownership rule in companion observations.
- [ ] Tests prove outside-root/target paths, special files, default links, alias ownership conflicts and shared limit overruns remain blocked; no excluded unread file needs a fabricated hash/evidence range.
- [ ] Handoff tests prove source/context budgets and identities are reused, and incomplete selected discovery cannot be reported as a complete empty scope.
- [ ] `docs/dependencies.md`, fixture provenance and ADR 004 match implementation; added runtime dependencies remain external under the existing build.
- [ ] Diff against the initial working-tree snapshot contains only in-scope edits; no target-project execution/runtime network access; 005 status/evidence updated without altering other plan statuses.

## STOP conditions

Stop and report instead of improvising if prerequisites contradict the excerpts/ADR decisions, a required behavior needs domain/config/index/build/workspace edits, a new dependency requires a lifecycle allowlist, exact safe literal matching cannot be achieved with the chosen matcher, metadata cannot be safely bounded/validated, or required machine-readable observations cannot fit the existing reporting contract. Stop for arbitrary JS/TOML extension execution, outside-root reads, unbounded walkers, duplicate billing/ownership promotion by alias order, failed platform containment assumptions, guessed ownership, or a gate failing twice after a reasonable fix attempt. Do not relax confinement to support pnpm's outside-root stores; record the limitation. Incomplete local/remote platform verification is reported explicitly, never described as a passed matrix.

## Maintenance notes

Exclusion/selection/representative identity changes alter scope, fingerprints and effort eligibility; review their fixtures and provenance together. New metadata ecosystems need data-only adapters. Plans 008/013 must consume ADR 004's internal handoff and preserve unread omissions when creating report diagnostics; do not reduce the result back to `ScopeManifest` alone. Review TOCTOU limitations, bounded directory allocation, abort delivery, platform flags and identity fallbacks honestly. Parser process isolation is not a filesystem sandbox.
