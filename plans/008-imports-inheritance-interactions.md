# Plan 008: Resolve local import closure and bounded contract relationships

> **Executor instructions:** Implement local resolution and evidence graphs only. Honor ownership/safety limits. Verify each gate and update status 008 in `plans/README.md`. An unresolved target is a result, not permission to guess globally.
>
> **Drift check first:** Reconciled at `9b0bfe7` on 2026-10-15. Run `git status --short`, `git diff --stat 9b0bfe7..HEAD -- src/relationships src/parser src/discovery src/domain test/integration/imports.test.ts`, and `git diff HEAD -- src/relationships src/parser src/discovery src/domain test/integration/imports.test.ts` (plus inspect untracked in-scope files). Check prerequisite statuses and the current-state snapshot below. Expected completed-prerequisite additions require inspection; contradictory contracts or unrelated local edits require reconciliation before implementation.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH (identity, inheritance, compiler-like ambiguity)
- **Depends on:** `plans/005-safe-source-discovery.md`, `plans/006-parser-adapter-isolation.md`, `plans/007-source-structural-metrics.md`
- **Category:** direction / correctness
- **Planned at:** commit `9b0bfe7`, reconciled 2026-10-15; originally greenfield planning on 2026-10-14.

## Why this matters

Human audit effort depends on interactions and dependency assumptions, not just independent contract sizes. A bounded graph accounts for shared bases/imports without duplicating their code and shows exactly where local evidence cannot establish a relationship.

## Current state and architectural context

### Reconciled implementation baseline — 2026-10-15

`src/relationships/` and production semantic jobs are absent. Use implemented `ImportReference` and `RelationshipResult` discriminated unions from `src/domain/types.ts`: a resolved import has `targetFileId`; other imports have `targetFileId: null`; a `resolved-unique` relationship has `to`, while other relationship variants omit it. Do not copy the illustrative optional-target object in Step 3 literally into a strict producer schema.

The merged Slang 1.3.9 research report proves tested namespace/direct inheritance locations, but named aliases return candidate sets, overload selection is ambiguous and member references do not establish runtime receivers. Preserve those limits. `Remapping` is `{context?: string, prefix: string, target: string}` and config normalizes contexts/targets to root-relative paths; matching still uses source-unit POSIX names. `ScopeSettings` does not contain Foundry `libs`; preserve validated libs in a bounded internal metadata companion from 005 rather than adding undocumented config fields. Import snapshots and shared resource budgets must be supplied by 005/006. These prerequisites are still TODO; recheck their actual interfaces before implementing closure or graph construction.

Match established strict ESM conventions: `.ts` source imports, explicit named exports and exported annotations, `import type`, readonly DTOs, no `any` or suppressions, unknown caught values narrowed before use. Tests use Vitest source imports for units and the trusted build-first integration wrapper for artifact suites. These current facts supersede prospective wording in the original context below.

### Original design context (retained)

No graphs/import resolver existed at planning. Prerequisites provide scoped source snapshots, ownership roles, parsed imports/declarations/call sites, file metrics and a Slang semantic capability matrix. Use the parent-owned safe reader for all import discovery and an in-memory map in Slang callbacks. See [Solidity import resolution](https://docs.soliditylang.org/en/latest/path-resolution.html), [Slang compilation units](https://nomicfoundation.github.io/slang/latest/user-guide/07-semantic-analysis/01-compilation-units/), [inheritance](https://docs.soliditylang.org/en/latest/contracts.html#inheritance).

This is a documented **local subset**, not exact solc/Foundry/Hardhat behavior. Syntax parse grammars stay per-file; semantic binding per import-connected component uses highest common compatible installed grammar, with selected version recorded. No common version means unavailable semantics. Alias/definition binding follows verified Slang capability; no inference based solely on matching contract/function names.

## Commands you will need

**Reconciliation gate note (2026-10-15):** Scripts below exist for typecheck, lint, format-check, source units, build-first integration/all, coverage and schema checks; feature-specific suites and later scripts exist only when their owning plans land. Current main-checkout checks are not green: missing installed Commander/Zod/Slang block typecheck, lint and domain/CLI unit collection. The bootstrap source unit passes (1 test); the other two unit suites fail collection. `pnpm format:check` fails on the same four unchanged `.agents/skills/improve` Markdown files recorded in prior approvals. No new format exception is granted: preserve the exact inherited exception and verify changed artifacts, or arrange a separately scoped fix; any additional failure is a STOP condition.

An executor must first run `pnpm install --frozen-lockfile` in its authorized implementation checkout and obtain success. This reconcile run did not install dependencies. Pnpm 11 attempted automatic installation before scripts and aborted removal of node_modules due to no TTY; do not set CI or approve purge merely to bypass it. With dependencies correctly installed, `pnpm --config.verifyDepsBeforeRun=false run <script>` can run an existing script without implicit dependency reconciliation; it does not repair missing packages. Do not claim schema/build/integration/coverage/frozen-install verification from this reconciliation: those gates were not rerun. Run the prescribed fresh build before any built-artifact test in implementation.

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Proposed prerequisite scripts; none verified during planning.

| Purpose | Command | Expected |
|---|---|---|
| Imports | `pnpm build` then `pnpm exec vitest run test/integration/imports.test.ts` | closure/remapping/safety cases pass |
| Graphs | `pnpm exec vitest run test/unit/relationships.test.ts` | exact and unknown edges pass |
| Boundary regression | `pnpm exec vitest run test/integration/parser-worker.test.ts test/research/slang-spike.test.ts` | 0 |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm schemas:check` | 0 |

## Scope

**In scope:** `src/relationships/{imports,remappings,closure,graph,inheritance,calls,components}.ts`, `src/parser/{worker,protocol}.ts` (semantic jobs only), `src/parser/bindings.ts`, `test/integration/imports.test.ts`, `test/unit/relationships.test.ts`, `test/fixtures/relationships/**`, `test/fixtures/manifest.json`, `docs/relationships.md`, 008 status row.

**Out of scope:** weakening safe paths, installing dependencies, remote URLs/IPFS/Git, reading compiler build-info/artifacts as executable truth, complete overload/type inference, recompilation, effort weighting or automatic dependency trust.

## Git workflow

Use supplied checkout. No commits/pushes/publication/branch changes without operator instruction.

## Steps

### Step 1: Implement explicit safe import lookup and remappings

Parse Solidity import directives/alias forms via 006 AST records; decode string literals with verified grammar handling, not naive quote stripping. Local relative imports resolve from importer. Apply configured/contextual remappings using source-unit-name POSIX strings: longest matching prefix, then longest matching context, equal-specificity conflicting targets produce IMPORT_UNRESOLVED/ambiguity. Preserve exact matching information/provenance. Bare imports resolve via explicit remappings, then conventional root `node_modules/<specifier>`, then configured Foundry libs with the documented `<lib>/<package>/src/<rest>` convention. If multiple allowed existing candidates remain, fail ambiguous rather than choose filesystem order. Do not invoke package exports, `require.resolve` on JS, recursive global search, or auto-install missing libs.

Read root `remappings.txt` under the 256 KiB data cap; merge foundry/estimator remapping arrays via established precedence, with duplicate conflicts diagnosed. Validate no remote scheme/absolute/cross-volume/outside-root path, including traversal after remapping. Every candidate uses 005 safety/link policy. pnpm symlink dependencies outside root remain unsupported and diagnostic.

**Verify:** `pnpm exec vitest run test/integration/imports.test.ts -t 'resolution and remappings'` → 0 for relative/named/namespace/contextual/shared/prefix/collision/missing/blocked imports and missing installed packages.

### Step 2: Build import closure once with roles and global budgets

Use a sorted queue/visited identity set; reusing a physical file does not reparse/count it. Add imported files as context, never scoped automatically, preserving first-party/third-party/unknown ownership. Scoped exclusion is not a hard read prohibition: an explicitly scoped-out first-party base can be read as context and reported as an omitted audit dependency; unsafe paths/hard exclusions stay blocked. Missing/unsupported context sources mark relationship coverage partial and produce diagnostic; all selected valid syntax metrics remain available. Do not pretend omitted dependencies were audited.

Count context against the same files/bytes/nodes/import caps (2,000 files, 64 MiB source, 20,000 imports). Cycles terminate safely; record import cycles as structural facts without claiming invalid code. Metadata/remapping reads do not escape root. Keep scoped source hash and context hashes in deterministic analysis fingerprint.

**Verify:** `pnpm exec vitest run test/integration/imports.test.ts -t 'closure and scope'` → 0; diamond/cycle/shared dependency loads once, first-party context notice appears, dependency is never promoted, limits terminate without silent truncation.

### Step 3: Bind declarations and inheritance with explicit statuses

Partition undirected import connectivity deterministically. Semantic components capped at 128 files/8 MiB and 10-second job budget use disposable children. Over limit or no grammar intersection: retain syntax records, mark required semantic metrics unavailable, issue SEMANTICS_UNAVAILABLE. Build Slang CompilationUnit solely from the provided map; unresolved callbacks return unavailable and corresponding parent diagnostics.

Before binding, require every component file to parse validly under the selected common grammar; do not build bindings over recovered invalid trees. A new semantic-grammar parse failure makes this component's semantics unavailable while preserving its original per-file syntax metrics. Map returned definitions back by canonical file ID, declaration kind and start-byte range; inconsistent identities become unavailable/diagnostic rather than replacing the original metrics.

Return edges `{id,kind,from,to?,candidateTargets,resolution:"resolved-unique|ambiguous|unresolved|unsupported",evidence}`. Resolve direct bases from bound definitions with aliases/source context. Compute ancestor sets/depth only for a fully resolved acyclic base subgraph; unresolved/cyclic inheritance makes transitive metrics unavailable. Distinguish imported source cycles from inheritance cycles. Report inherited declaration references uniquely without adding them to source declaration/LOC totals. Do not implement unverified C3 linearization or override dispatch; preserve declared base order and direct edges.

**Verify:** `pnpm exec vitest run test/unit/relationships.test.ts -t 'inheritance and identity'` → 0 for diamond depth/shared members, duplicate names, alias bases, missing bases/cycles and mixed-version components.

### Step 4: Classify call resolution and interaction/boundary graph facts

Resolve call-site bindings only as far as 002 proves. Separate identifier reference resolution from exact callable-overload/receiver dispatch. Internal/self/library/interface/external/unknown call forms retain syntax evidence, target candidates and dynamic-dispatch limitations. A unique function-name definition alone is insufficient to identify runtime external target. Builtin low-level call classification requires binding to the builtin or verified receiver type; a custom `call` method remains a candidate. Delegatecall/Yul opcodes are syntax indicators, not vulnerability findings.

Create deterministic **directed contract endpoint pairs** for resolved first-party scoped inheritance or cross-contract calls; union kinds/evidence, count a pair once regardless of call-site count or inherited paths, exclude self-pairs. Create separate scoped-owner → context dependency boundary pairs for resolved imported/inherited/call targets, with kind/evidence union. The same endpoint pair belongs to exactly one partition. Imports containing only interfaces/constants/free functions can have file-level boundary records separately; do not invent contract targets or charge unused import declarations as calls. Unknown/candidate interactions are reported but not inserted as resolved edges. Cap total edge/site records at 100,000.

**Verify:** `pnpm exec vitest run test/unit/relationships.test.ts -t 'calls and pairs'` → 0 for repeat calls, self/internal/library/interface/custom-call/low-level/overload/function-pointer cases; imports/boundary/spike/worker/full/standards/schema gates → 0.

## Test plan

Use 002 semantic fixtures with independent expected edges. Include relative and remapped imports, namespace aliases, shared third-party base, excluded first-party context, identical copied files, diamond inheritance, overload ambiguity, `this`/`super`, dynamic receivers, import cycles, missing package and hostile path forms. Assert unknown stays unknown and declaration totals don't inflate. Reduced limits verify termination without giant test inputs.

## Done criteria

- [ ] Import/graph/worker/spike/full suites and standards/schema gates exit 0.
- [ ] Local import closure is bounded, deterministic, root-confined and role-preserving.
- [ ] Every edge has evidence/resolution status; identity never comes from global short-name matching.
- [ ] Reused/inherited code counts once and repeated interaction endpoint pairs deduplicate.
- [ ] No compiler/config/dependency execution or outside-scope edits; status 008 updated.

## STOP conditions

Stop if binding capability deviates from 002, resolving ordinary imports requires remote install or outside-root access, ambiguous definitions would have to be selected arbitrarily, graph construction exceeds limits silently, exact runtime dispatch/C3 is needed for required claims, schema amendments are necessary, or a gate fails twice. Narrow capability with documented approval rather than fabricate graph certainty.

## Maintenance notes

Remapping/ownership changes affect fingerprints and estimates. Keep source-unit names distinct from native paths. Extend semantic capability only with counterexample fixtures; review Slang binding changes against aliases/overloads and unavailable values.
