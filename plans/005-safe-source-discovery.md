# Plan 005: Discover an explicit audit scope with bounded, safe filesystem reads

> **Executor instructions:** Execute only these discovery/read tasks. Run each gate before continuing. Never execute project commands/config. Update status 005 in `plans/README.md`.
>
> **Drift check first:** No SHA exists from the empty/non-Git planning baseline. Require 003 domain and 004 config/limits. Inspect `git status --short` and `git diff --stat -- src/discovery test/integration/discovery.test.ts test/integration/safe-read.test.ts` if Git exists. Stop on contradictory discovery behavior; expected prerequisite changes are normal.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH (filesystem confinement and scope correctness)
- **Depends on:** `plans/003-domain-contracts-schemas.md`, `plans/004-cli-configuration.md`
- **Category:** direction / security
- **Planned at:** no commit available; empty non-Git directory inspected 2026-10-14

## Why this matters

Accidental library inclusion or missing first-party contracts invalidates the estimate before any formula runs. Explicit scope/ownership manifests, deterministic discovery and bounded reads make untrusted local projects reviewable without silently following links or counting generated artifacts.

## Current state and architectural context

No discovery exists at planning. Prerequisites should provide `ScopeManifest`, diagnostics, config precedence and limits. Use `node:fs/promises`, `node:path`, `node:crypto` plus exact-pinned Picomatch and smol-toml; no filesystem glob walker or project framework runtime. See [Picomatch](https://github.com/micromatch/picomatch), [smol-toml](https://github.com/squirrelchat/smol-toml), [Foundry config](https://github.com/foundry-rs/foundry/blob/master/crates/config/README.md), [Hardhat paths](https://hardhat.org/docs/reference/configuration#path-configuration).

Scope and ownership are independent: role `scoped|context|excluded`, ownership `first-party|third-party|unknown`. Imports are not resolved here. This module exposes `discoverScope`, `readSource`, `readProjectMetadata` and reusable `resolveSafePath`. All public paths are root-relative POSIX; absolute/native paths remain internal. Root is explicit `--root`, directory target, or file parent; target must be inside it. No parent traversal/project search. Ordinary metadata hints never supersede explicit estimator settings.

## Commands you will need

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Proposed and established by prerequisites; none existed during recon.

| Purpose | Command | Expected |
|---|---|---|
| Discovery | `pnpm exec vitest run test/integration/discovery.test.ts` | scope and metadata cases pass |
| Safe reads | `pnpm exec vitest run test/integration/safe-read.test.ts` | path/link/limit/read cases pass |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm build` | 0 |
| Schema consistency | `pnpm schemas:check` | 0 |

## Scope

**In scope:** `src/discovery/{discover,scope,metadata,patterns,safe-path,safe-read,identity}.ts`, `test/integration/{discovery,safe-read}.test.ts`, `test/helpers/filesystem.ts`, `test/fixtures/discovery/**`, `test/fixtures/manifest.json`, `package.json`, `pnpm-lock.yaml`, `docs/dependencies.md`, `docs/adr/004-scope-safety.md`, 005 status row.

**Out of scope:** import/AST parsing, effort calculations, external sources, `$HOME`/global config, Git worktree mutation, `forge config`, Hardhat imports, npm install in analyzed projects, third-party package resolution via executable exports.

## Git workflow

Use the supplied checkout. No commit/push/publication/branch change without operator instruction; no conventions were available during planning.

## Steps

### Step 1: Define bounded project metadata and source-root selection

Add exact stable dependencies with recorded engines/licenses. Recognize local `foundry.toml`, `hardhat.config.{js,ts,cjs,mjs}`, `src`, `contracts`, package/dependency directory markers without executing or importing them. Read at most 256 KiB of Foundry TOML, validate recognized `[profile.default]` `src`, `test`, `script`, `out`, `libs`, `remappings`, exact `solc`/`solc_version` hint. Warn for custom-profile/environment/global settings not interpreted; do not read home config or inherit FOUNDRY env overrides. Invalid present metadata is diagnostic, never silently executed as a fallback. Hardhat source overrides require estimator config; conventional `contracts` remains the default and an informational limitation names it.

If the selected Picomatch release does not ship TypeScript declarations, add a matching exact dev-only `@types/picomatch` pin in the already in-scope manifest/lockfile and record it. Do not suppress missing types with `any` or introduce a second runtime glob dependency.

Source-root order: explicit roots → validated Foundry default root → existing `src` and/or `contracts` → target directory. Include both convention roots if both exist. A directory target limits discovery to its descendants; `--root` permits imports elsewhere in that root later, not unrequested audit-scope expansion. Explicit includes can select other locations **within the directory target**, outside detected source roots. A literal file selects only itself before exclusions. Reject missing/outside-root roots and cross-drive paths.

**Verify:** `pnpm exec vitest run test/integration/discovery.test.ts -t 'metadata and roots'` → 0 for file/directory/Foundry/Hardhat/custom/generic cases, malicious JS config remains unread/executed.

### Step 2: Implement deterministic traversal and glob policy

Use a sorted iterative `readdir` walk. Check cancellation/depth/entry/file counters before allocating more work; default limits 100,000 entries, depth 64, 2,000 Solidity files including eventual context. Glob strings are root-relative, `/` separators, case-sensitive, support `*`, `**`, `?`; reject negation, extglobs, braces, raw regexp forms, absolute paths and `..` segments. Document this deliberately limited grammar. Use Picomatch with explicit options disabling unsupported forms and `dot:true`; hard exclusions apply before patterns. Limit each list to 64 patterns and each pattern to 512 characters. Glob matching does not perform filesystem access.

Do not run a full arbitrary multi-star path regexp in the parent. Split patterns/paths into segments, allow standalone `**` as recursive wildcard and at most one `*` per other segment (`?` has fixed-width matching). Compile/cache Picomatch only for these bounded single-segment patterns with unsupported regexp features disabled; combine segment results using iterative memoized dynamic programming for globstars. Each `(patternSegment,pathSegment)` state is evaluated once, charge states to per-run `maxGlobStates=10,000,000`, and check cancellation/deadline between bounded batches. Reject repeated-star segments such as multiple separated `*` within one filename segment, controls and unsupported escapes; document examples. Multiple standalone globstars like `**/mocks/**` remain supported without unbounded backtracking. Test maximum-length and unsupported patterns with a benign sentinel/real deadline controller. Bounded input length alone must not be advertised as proof of regexp safety.

Hard-prune `.git` and non-source special files always. Default exclusion directories: node_modules, lib, vendor, deps, out, artifacts, cache, coverage, dist, build, test, tests, mocks, script, scripts, generated, deployments; file defaults `*.t.sol`, `*.s.sol`, and explicitly generated suffixes with documented patterns. Dependencies are third-party even if defaults are disabled. Configuration exclusions override inclusion; no negate-reinclude magic. Disabling defaults is explicit; it does not disable hard safety constraints. Do not silently consult `.gitignore`.

Manifest records every inspected Solidity candidate and exclusion reason; pruned directory records state `not-enumerated` rather than fabricated per-file counts. Include exact selected files/contracts later, skipped trees, root decisions, rule provenance, warnings and inspected-file totals. Sort by normalized code-point order, independent of readdir order.

**Verify:** `pnpm exec vitest run test/integration/discovery.test.ts -t 'patterns and manifest'` → 0; shuffled directory creation order produces identical manifest, tests/mocks/vendor/default overrides behave exactly as documented.

### Step 3: Enforce path/link/special-file rules and deduplicate identities

Default skip symlink files/directories, including a symlink target, with actionable diagnostics. `scope.followSymlinks=true` allows only resolved targets inside canonical root. Compare path containment using `path.relative`/segments and volume checks, not string prefix. Use `lstat`/`realpath` on encountered components; block outside-root resolutions, cycles, dangling links, devices/FIFOs/sockets. Preserve legitimate same-prefix sibling separation. Deduplicate canonical paths and stable device/inode identities when available; hardlinks count once, distinct copied bytes count separately and may later be reported as duplicate-content groups. Do not case-fold Linux paths; test Windows filesystem identity/case behavior with actual platform checks.

Ownership: configured third-party roots plus conventional dependency roots are third-party; explicit `firstPartyOverrides` promotes selected matches with recorded reason; ordinary roots outside dependencies are first-party. Ambiguous known dependency layouts are unknown, excluded from effort pending override. Imports will add context only. A CLI include selecting third-party code does not promote ownership; report OWNERSHIP_UNKNOWN/actionable promotion requirements instead of billing it as first-party.

**Verify:** `pnpm exec vitest run test/integration/safe-read.test.ts -t 'paths and identities'` → 0; inside/outside links, link loops, hardlinks, same-byte copies, sibling prefixes and Windows path cases pass. Platform unsupported symlink creation is an explicit reported test skip, covered on supported CI platforms.

### Step 4: Read source snapshots without unbounded allocation

Open regular files, fstat before/read/after, check per-file 2 MiB and total 64 MiB before buffering; count actual bytes and stop growth at limit+1. Validate UTF-8 with fatal decoding; retain BOM/raw hash and normalized text separately. Use available no-follow open flags where supported, component rechecks elsewhere, and compare identity/size/mtime to detect mutation. Always close handles. Reject unsafe or changed sources with PATH_BLOCKED/SOURCE_CHANGED; do not truncate and estimate the prefix. Reuse this reader for imports in 008. Record honest limitation: cross-platform Node APIs do not provide atomic open-beneath protection against a concurrently malicious filesystem; require a stable local snapshot/OS sandbox for that threat.

Capture bounded test-directory presence metadata only, without loading test scripts; imported Solidity tests still follow normal source safety later. Every counter includes context so import closure cannot bypass limits. Shared cancellation budget is passed across discovery/read phases.

**Verify:** `pnpm exec vitest run test/integration/safe-read.test.ts` → 0 for oversized/growing/unreadable/empty/BOM/invalid-UTF8/CRLF/cancelled sources and cleanup; then discovery suite, standards and schema checks → 0.

## Test plan

Use 004 temporary-directory style and add reusable filesystem fixtures/helpers. Hand-author Foundry/Hardhat/generic/file cases, include replacement and exclusion precedence, nested dependency roots, literal excluded targets, no files, source-root mismatch, duplicate identity and symlink cases. Limit tests use reduced configurable ceilings, not huge fixture commits. Do not build/test the discovered projects.

## Done criteria

- [ ] Discovery/safe-read suites, full tests, build/type/lint/schema checks exit 0.
- [ ] Every scoped file has explicit ownership, canonical identity, selection rule and safe snapshot hash.
- [ ] Imported/vendor/generated code is not silently scoped; pruned-tree counts are honest.
- [ ] Outside-root paths, special files, default links and limit overruns are blocked in tests.
- [ ] No command/project execution, external access or outside-scope change; 005 status updated.

## STOP conditions

Stop if arbitrary JS/TOML extensions must execute, outside-root reads are needed for ordinary fixtures, traversal needs a generic unbounded glob walker, identity behavior causes duplicate billing, a containment assumption fails on a platform, unknown ownership would have to be guessed, or a verification fails twice. Do not relax safety to support pnpm's outside-root stores; document explicit inside-root limitations.

## Maintenance notes

Exclusion changes alter scope and must be documented with fixtures and option provenance. New project ecosystems must supply data-only adapters. Review TOCTOU limitations, platform flags and identity fallbacks honestly; never advertise process isolation as a filesystem sandbox.
