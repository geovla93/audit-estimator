# Plan 002: Prove Slang's parser and binding capabilities before promising them

> **Executor instructions:** This is an implementation-time research/spike plan, not application scaffolding beyond its listed files. Read fully, run each gate, report unsupported capabilities honestly, and update status 002 in `plans/README.md`. Do not change parsers or metric definitions on your own.
>
> **Drift check first:** Planned at an empty non-Git directory; no SHA exists. Require plan 001's manifest/scripts. Inspect `git status --short` and `git diff --stat -- package.json pnpm-lock.yaml test/research test/fixtures/parser docs/research/slang-spike.md docs/dependencies.md` if Git exists. Compare existing spike files with the facts here; completed bootstrap changes are expected. Stop on conflicting parser experiments.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED (parser/version/binding feasibility)
- **Depends on:** `plans/001-bootstrap-tooling.md`
- **Category:** direction / research
- **Planned at:** no commit available; greenfield non-Git directory inspected 2026-10-14. Execution drift check passed against `2077848` on 2026-10-14; prerequisite 001 is merged as `ee639aa`.

## Execution finding and approved BOM amendment (2026-10-14)

Execution selected exact runtime pin `@nomicfoundation/slang@1.3.9` in isolated worktree `/private/tmp/audit-estimator-002-worktree`. The reviewer independently reproduced a required location-matrix failure on Node 24.21.0: `Parser.create('0.8.37').parseFileContents('\uFEFFcontract C {}\n')` returns `isValid() === false`, one diagnostic covering the input, and `tree.unparse() === 'contract C {}\n'`. Input length is 15 UTF-16 units / 17 UTF-8 bytes; reconstruction omits the leading BOM. Without the BOM, the same declaration parses and reconstructs exactly. A separate CRLF source containing π and an emoji also reconstructs exactly.

This initially triggered the required syntax/trivia fidelity STOP condition: Step 2 explicitly includes BOM and requires reconstruction, while forbidding source rewriting. The initial partial tests established the raw-parser limitation without satisfying the original gate. The approved amendment below resolved this blocker; the resumed spike subsequently completed its semantic and isolation gates.

The user approved analyzer-owned BOM decoding with preserved original bytes and exact offset mapping. Execution may resume in the existing isolated worktree. Preserve the direct-parser rejection test as evidence, and prove the narrow decoding contract below; do not switch parser implementations.

### Approved encoding contract

Retain the original bytes/text for fingerprints, physical source accounting and reporting. Detect exactly one leading UTF-8 BOM (`EF BB BF` / initial U+FEFF) and exclude it only from the parser/pragma-inference/compilation callback view. Do not remove interior or repeated BOM characters, normalize newlines, replace invalid encoding, or modify Solidity tokens. This is the sole approved exception to the no-source-rewriting rule.

Map every parser range back to original source coordinates: add 3 to UTF-8 offsets and 1 to UTF-16 offsets for a removed BOM; keep line numbers unchanged and add 1 to Slang's Unicode-scalar column only on original line 0. Columns are not UTF-16 offsets: explicitly verify the installed unit with an astral character before an identifier on the same line. Without a BOM all coordinates remain identical. Apply the mapping to both ends of ranges, including EOF and syntax diagnostics. Reattach the recorded BOM to a valid tree's unparsed text and require exact original bytes, including CRLF and Unicode. Raw hashes remain based on original bytes. Range mapping must not rely on regex parsing.

In this spike implement the contract only in the in-scope research harness; the production adapter belongs to plan 006. Test BOM-only and BOM + malformed input, first-line and later-line identifiers, CRLF/multibyte/emoji, and interior/repeated U+FEFF preservation. Record raw-parser limitations separately from adapter-supported capabilities.

### Resumed execution review

**APPROVE** on 2026-10-14, in `/private/tmp/audit-estimator-002-worktree`, based on `2077848`. Committed at the user's request as `fea9ef2` on `advisor/002-slang-compatibility-spike`; unmerged. Reviewer independently verified the amended BOM contract, full test assertions and scope, all 23 fixture byte/line counts, frozen installation, exact installed Slang 1.3.9 listing, typecheck, lint, targeted formatting and fresh-build `pnpm test:all` (one unit plus eighteen integration/research tests, nineteen total; fifteen research tests). Research evidence is in that worktree's `docs/research/slang-spike.md`.

One documented baseline deviation is accepted: full `pnpm format:check` reports only four unchanged files under `.agents/skills/improve`, introduced before this execution. All changed research/code/documentation artifacts pass targeted formatting; no out-of-scope fix was made. Slang alias uses can return the local alias plus imported definition, and overloads return candidate sets; the spike preserves these results rather than selecting targets. Direct inheritance and namespace identity work in tested cases. Plan 008 must preserve candidates until any alias normalization is separately reviewed, as its existing capability boundary requires. Production BOM handling remains plan 006 work.

## Why this matters

SLOC, assembly analysis and dependency graphs need verified parser behavior. Documentation alone cannot establish range units, ESM/WASM packaging, malformed-input safety or what binding resolves. A focused spike converts those assumptions into tests and a capability contract before consumers depend on them.

## Current state and architectural context

At planning there was no application or installed parser. Prerequisite 001 should provide strict TS7 no-emit checking with ESNext/bundler resolution and `.ts` imports, tsdown ESM builds/Oxc declarations, Vitest/V8, type-aware oxlint/oxlint-tsgolint, oxfmt, pnpm and exact dependency pins on Node 24.11+ only. Do not assume a compiler or Foundry/Hardhat is available. Slang is selected; investigate alternatives only if minimum required behavior fails.

Primary sources: [AST types](https://nomicfoundation.github.io/slang/latest/user-guide/05-syntax-trees/04-using-ast-types/), [version inference](https://nomicfoundation.github.io/slang/latest/user-guide/04-getting-started/02-choosing-a-solidity-version/), [errors](https://nomicfoundation.github.io/slang/latest/user-guide/05-syntax-trees/02-handling-syntax-errors/), [bindings](https://nomicfoundation.github.io/slang/latest/user-guide/07-semantic-analysis/02-binding-graph/), [memory](https://nomicfoundation.github.io/slang/latest/user-guide/09-appendix/02-slang-memory-management/), [releases](https://github.com/NomicFoundation/slang/releases). Retrieved releases showed 1.3.8; **verify stable availability and exact APIs at execution**, not a claimed final pin. Query installed supported versions rather than copying documentation examples.

## Commands you will need

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

These commands are proposed by 001 and only usable after it lands; none existed during recon.

| Purpose | Command | Expected |
|---|---|---|
| Record installed parser | `pnpm list @nomicfoundation/slang --depth 0` | exact documented version |
| Spike | `pnpm exec vitest run test/research/slang-spike.test.ts` | all capability assertions pass |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build` | 0 |
| Full regression | `pnpm test:all` | all prior tests plus spike pass |

## Scope

**In scope:** `package.json`, `pnpm-lock.yaml`, `docs/dependencies.md`, `docs/research/slang-spike.md`, `test/research/slang-spike.test.ts`, `test/research/slang-child.ts`, `test/research/slang-source-view.ts` (research-only BOM decoding/range helpers under the approved amendment), `test/fixtures/parser/**`, `test/fixtures/manifest.json`, and 002 status row. Test-only child experiments may compile into ignored `.vitest/` via the trusted test harness. Do not ship experimental code under `src`.

**Out of scope:** production parser, discovery, metrics, estimator, solc installation/downloads, compiling external projects, Slither, compiler fallback, entire repositories fetched as fixtures, runtime network services.

## Git workflow

Use the operator's checkout; there was no observed Git convention. No commits, pushes, branch creation or publication without operator authorization.

## Steps

### Step 1: Pin one verified Slang release and identify API entry points

Check published stable versions, engines, exports, license and package assets. Add one exact runtime pin using `pnpm add --save-exact @nomicfoundation/slang@<verified-version>`; the placeholder means choose/record the verified version, not a literal command. Document ESM import of parser/CST/AST/utils/compilation/bindings and whether load requires WASM assets or lifecycle scripts. Use upstream exported definitions, not guessed node-kind strings. Enumerate supported language versions and freeze the list in the spike evidence with package version. Verify `Parser.create`, file parsing, errors, tree cursor traversal, typed AST fields, token trivia access, range coordinate units and import callbacks.

**Verify:** `pnpm exec vitest run test/research/slang-spike.test.ts -t 'api and versions'` → 0, package/version list and smallest/modern grammar assertions pass; `pnpm typecheck` → 0 without type suppression.

### Step 2: Build a hand-reviewed syntax and location matrix

Create minimal original fixtures for representative 0.4.11, 0.5, 0.6, 0.7, modern 0.8 versions and the installed latest grammar; not every fixture runs under every grammar. Include old constructors/fallbacks, receive, abstract/interface declarations, custom errors, assembly/Yul, transient syntax when supported, import forms, pragma intersections, no pragma, contradictory/unsupported pragma, incomplete tokens and malformed syntax. Include BOM, CRLF, UTF-8 multibyte text/emoji comments and comment markers in strings. Assert trivia reconstruction and explicit UTF-8/UTF-16/line coordinate conversions. No regex parser or source rewriting except the approved leading-BOM encoding contract above.

The manifest records origin `original`, intended compiler grammar version, license `MIT-proposed`, expected declarations/errors, and exact hand-counted metrics. Do not claim compilation merely because the parser accepts a fixture.

**Verify:** `pnpm exec vitest run test/research/slang-spike.test.ts -t 'syntax and ranges'` → all matrix cases pass, malformed cases return identifiable diagnostics, reconstruction matches original bytes/text where encoding applies.

### Step 3: Establish the semantic capability matrix

Use an in-memory virtual filesystem for compilation callbacks. Test relative imports, namespace/named aliases, same-named contracts in separate files, diamond bases, interface declarations, inherited references, overloads, `super`, internal library calls, external interface receivers, `this`, function pointers and unresolved imports. For each record one of `resolved-unique`, `ambiguous`, `unresolved`, `not-supported`; assert exact observed definitions and never silently promote candidates. Test graph behavior with an invalid dependency and mixed version constraints; skip binding invalid trees in production if unsafe. No executing target configs.

Required MVP gate: declarations/imports/control nodes/trivia/ranges/version errors must work. Binding is an enhancement to graph accuracy: failure of overload/runtime-type resolution is acceptable if documented and schema supports unknown edges. Failure of basic import alias and inheritance identity resolution requires a documented narrower graph design approved before plan 008; do not invent a name-only global resolver.

**Verify:** `pnpm exec vitest run test/research/slang-spike.test.ts -t 'semantic capabilities'` → 0 with resolved and intentionally unknown cases; `docs/research/slang-spike.md` has one expected/observed/capability row per fixture.

### Step 4: Prove artifact loading and bounded isolation

Exercise Slang imports in plain built Node ESM in a disposable test-owned child. Test termination of a deliberately stalled **trusted test child**, malformed-source crashes, repeated parse batches and child disposal. Measure a small/large bounded synthetic fixture for advisory timing/memory data, without putting elapsed measurements into canonical output. Do not assert a JavaScript heap cap is a hard WASM/RSS limit. Report the child-process design and safe default limits for production. Verify parser objects are not transferable via plain JSON; plan 006 must flatten records inside the child.

**Verify:** `pnpm exec vitest run test/research/slang-spike.test.ts -t 'isolation and esm'` → 0, stalled child killed within a generous test harness deadline, no child survives; `pnpm test:all`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build` → 0.

## Test plan

Use 001's Vitest assertion style. Fixtures must be committed and runnable offline. Test capabilities explicitly rather than snapshotting opaque CST dumps. Tests for deadline control use trusted stalls and generous scheduling margins; do not rely on a particular Solidity input taking exactly two seconds. Record all weaker-than-assumed capabilities in the report.

## Done criteria

- [ ] Spike suite and complete standards gates exit 0.
- [ ] Exact parser version, supported-version list, import/AST/trivia/range APIs, ESM/WASM packaging and license are recorded.
- [ ] Semantic matrix includes ambiguous/unresolved cases with assertions; required syntactic gate passes.
- [ ] Resource-isolation findings distinguish JS heap from WASM/external memory.
- [ ] No production code or outside-scope edits; 002 status updated. A failed minimum gate is BLOCKED with evidence, not DONE.

## STOP conditions

Stop if stable Slang cannot load on supported Node/OS without unplanned native installs, required syntax/trivia/range APIs fail, malformed input crashes the parent, bindings require uncontrolled I/O, a workaround requires regex parsing or another runtime parser, or a verification fails twice. If semantic capability needs narrowing, document the evidence and obtain a design amendment before dependent graph work.

## Maintenance notes

Rerun the capability matrix on every Slang upgrade, including patch releases; grammar fixes can change metrics. Add fixtures for new Solidity syntax before extending claims. Keep real experiment evidence distinct from documentation examples and proposed limits.
