# Plan 007: Extract source and AST metrics with explicit counting definitions

> **Executor instructions:** Implement only these measured metrics and adapter event additions. Verify each step and update status 007 in `plans/README.md`. Do not infer vulnerabilities or attach effort weights here.
>
> **Drift check first:** No baseline SHA exists. Require 006 parser records and 003 schemas. If Git exists inspect `git status --short` and `git diff --stat -- src/metrics src/parser/extract-syntax.ts src/parser/worker.ts test/unit/source-metrics.test.ts test/unit/structural-metrics.test.ts`. Stop if existing metric definitions conflict with this contract.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** MED (auditable counting and aggregate correctness)
- **Depends on:** `plans/006-parser-adapter-isolation.md`
- **Category:** direction / correctness
- **Planned at:** no commit available; greenfield non-Git directory inspected 2026-10-14

## Why this matters

An explainable estimate requires stable, reproducible evidence. Metrics need concrete definitions, known unavailable cases and independent counts; summing inherited copies or overlapping contract lines would create artificial size and effort.

## Current state and architectural context

No metrics existed during planning. Prerequisite parser flattens valid source into normalized token/declaration/import/events inside a trusted child. AST knowledge remains in `src/parser/extract-syntax.ts`; `src/metrics` contains parser-independent pure transforms. All files use strict ESM, explicit types and readonly records. Public measurements carry measured/unavailable status and source evidence.

Slang typed AST/cursors are the implementation source, not regex approximations. [Solidity grammar](https://docs.soliditylang.org/en/latest/grammar.html) informs definitions, but metrics here are syntactic approximations to review complexity, not a compiler control-flow graph or storage layout.

## Metric contract

- **Physical lines:** empty text = 0; split CRLF/LF/CR line terminators, do not count a terminal empty segment; BOM is not a code token. Newline style must not change counts.
- **SLOC:** unique physical lines intersecting at least one non-trivia Solidity/Yul token, excluding blank/comment-only lines. Strings containing comment delimiters are code. Multiline string contents containing non-whitespace source characters count as code; embedded blank lines remain blank. Imports/pragmas/braces/declarations count; label this layout-sensitive line metric. Derive with token spans, never stripping comments via regex.
- **Contract lines:** line-set intersection for each declaration span; same-line contracts can overlap. Project totals use unions of unique file line sets, never sum contract SLOC. Also expose file-level/top-level/free-function code outside contracts.
- **Declarations:** distinct contracts/abstract contracts/libraries/interfaces and functions/modifiers. Functions include constructors/fallback/receive and bodyless declarations, with subtype totals; modifiers counted separately. Free functions and generated getters are separate: do not invent implicit compiler-generated callable counts. Inherited members are not new declarations.
- **Attributes:** visibility/mutability explicit vs effective according to tested grammar-version defaults; use unavailable if legacy rules aren't confirmed. Record body presence and modifier applications separately.
- **Decision count:** `if`, ternary, for/while/do-while, catch clause, logical `&&` and `||` each count once within a callable body. Else alone and `require`/assert calls do not add decisions. `syntacticCyclomatic = 1 + decisions` only for callable bodies; bodyless declarations are unavailable/not applicable. This is a defined proxy, not CFG cyclomatic complexity. Report branch/loop/operator subtotals; do not separately weight all of them.
- **Loops/nesting:** each loop node once; maximum lexical loop depth measured from AST nesting, not textual indentation. No recursion/termination claims.
- **Assembly/Yul:** inline assembly block count plus separate Yul statement/call/control counts. Exclude Yul decisions from Solidity cyclomatic; no double count. Report source ranges and memory-safe annotation syntax without treating it as proof.
- **State:** declared state variables excluding constants/immutables from mutable-storage subtotal; mappings/arrays/struct definitions and syntactic type nesting, events/errors and storage-location annotations. Referenced struct classification may be unavailable until relationships resolve it. No exact storage slots, alias effects, write reachability or layout compatibility.
- **Calls:** expression-site shape (identifier/member/function-pointer/new/low-level-name), literal `.call/.delegatecall/.staticcall/.send/.transfer` candidates and Yul call builtins. Name matches are measured syntax only; confirmed builtins/targets require 008. Custom `.call()` methods must not be classified as confirmed low-level calls here.

## Commands you will need

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Proposed prerequisite scripts; none existed during recon.

| Purpose | Command | Expected |
|---|---|---|
| Lines/tokens | `pnpm exec vitest run test/unit/source-metrics.test.ts` | hand-counted fixtures pass |
| AST metrics | `pnpm exec vitest run test/unit/structural-metrics.test.ts` | all declared semantics pass |
| Parser boundary | `pnpm build` then `pnpm exec vitest run test/integration/parser-worker.test.ts` | enriched DTOs pass |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm schemas:check` | 0 |

## Scope

**In scope:** `src/metrics/{source,structural,aggregate,definitions}.ts`, `src/parser/extract-syntax.ts`, `src/parser/worker.ts` (metric/event wiring only), `test/unit/{source-metrics,structural-metrics}.test.ts`, `test/fixtures/metrics/**`, `test/fixtures/manifest.json`, `docs/metrics.md`, 007 status row.

**Out of scope:** graph resolution, heuristic classifiers, estimation, CLI/report changes, parser/version policy changes, regex comment/pragma parsing, implicit compiler artifacts, imported-code scoring.

## Git workflow

Use supplied checkout; no observed conventions. No commit/push/publication or branch change without operator instruction.

## Steps

### Step 1: Implement token-backed physical/SLOC and source attribution

Implement pure line-index/token-span transforms with BOM/UTF-8 coordinate support. Keep internal counted line sets for file/contract unions. Mask comment-only ranges by token class, not by deleting source. Add hand-reviewed fixtures: empty, trailing newline, CRLF/CR/LF, multiline comments/NatSpec, strings containing comment syntax, multiline literals, comment plus code, multiple contracts same line and top-level free functions. Invalid trees expose physical lines only; unavailable SLOC must not become zero.

**Verify:** `pnpm exec vitest run test/unit/source-metrics.test.ts` → 0 with exact manually enumerated line sets/counts; `pnpm typecheck` → 0.

### Step 2: Normalize declaration/attribute/control/state/assembly events

Extend adapter event visitors iteratively under 006 node caps. For each event include owner callable/contract ID and range; reset ownership at declaration boundaries, avoid attributing nested assembly decisions to Solidity. Implement `extractStructuralMetrics(records)` with the definitions above. Keep bodyless/legacy unsupported defaults distinguishable. Walk user-defined functions once; constructor-like names in old grammars are handled per tested parse node, not just string naming.

Create tiny fixtures isolating every node/attribute before combined fixtures. Counts from a deliberately generated getter or inherited base may appear in semantics later, but not declaration totals. Record call syntax site candidates without claiming dispatch.

**Verify:** `pnpm exec vitest run test/unit/structural-metrics.test.ts -t 'declarations and control'` → 0 for old/modern callable kinds, exact loop/decision nesting, Yul separation and unavailable cases.

### Step 3: Aggregate unique scoped source while preserving context metrics

`aggregateMetrics(files,scope)` counts unique canonical scoped identities only. Report context totals separately; inherited/shared dependencies never enlarge declared scoped totals. Identical byte copies remain separate until explicitly excluded; emit duplicate-content groups as observations, not discounts. Function counts sum distinct declared IDs; contract SLOC overlap does not inflate project union. Do not allocate per-contract effort here; estimate baseline is file-based and per-contract output is metrics.

**Verify:** `pnpm exec vitest run test/unit/source-metrics.test.ts -t 'aggregation'` and `pnpm exec vitest run test/unit/structural-metrics.test.ts -t 'aggregation'` → 0 for same-line declarations, shared imported bases, copied bytes and context-only files.

### Step 4: Freeze measurement definitions and stability properties

Write `docs/metrics.md` naming every unit, inclusion/exclusion, version-default policy, layout limitation and unavailable condition. Set metrics version `1.0.0`. Add transformations: comments/blank lines change physical lines but not declaration/control counts; changing newline style keeps all metric values; renaming locals does not change counts; reordering file enumeration keeps aggregates. Layout reflow can change SLOC and baseline, and must be documented rather than falsely asserted invariant. Worker integration returns evidence and metrics without raw tree serialization.

**Verify:** both metric suites and built worker suite → 0; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm schemas:check` → 0, no regenerated schema needed unless previously specified event fields were missing (STOP instead of silently extending public contracts).

## Test plan

Use parser fixture style from 002; hand-write line/node oracles before implementation. Include contracts/libraries/interfaces/abstract/free functions, visibility/mutability, modifiers, loops/try-catch/boolean/ternary, state types/constants/immutables, custom `.call` decoy, inline assembly/Yul and invalid files. Snapshot only normalized outputs backed by hand assertions, not entire parser trees.

## Done criteria

- [ ] Metric/worker suites, full tests, standards and schemas exit 0.
- [ ] Every emitted metric has an explicit documented counting rule and measured/unavailable semantics.
- [ ] Scoped aggregation counts shared physical source once and excludes context; line overlap tested.
- [ ] No regex Solidity parsing, implicit getters, vulnerability claims or effort weights.
- [ ] Edits scoped and status 007 updated.

## STOP conditions

Stop if adapter token ranges cannot support correct line sets, recovery nodes would be treated as complete metrics, a metric needs full compiler semantics, an AST kind cannot be handled under the pinned version, public schemas need incompatible extension, or a gate fails twice. Mark genuinely unavailable measurements instead of inventing approximations.

## Maintenance notes

Metric semantic changes require version review and independent fixture updates. New language nodes need targeted oracles; do not approve golden updates merely because parser output changed. Keep storage/dispatch limits explicit as semantic support evolves.
