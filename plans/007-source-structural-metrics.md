# Plan 007: Map parser output to source and structural metrics with explicit counting rules

> **Executor instructions:** Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If anything in "STOP conditions" occurs, stop and report; do not improvise. When done, update the 007 row in `plans/README.md` unless a reviewer dispatched you and said they maintain the index. Do not infer vulnerabilities, attach effort weights, or resolve imports/inheritance here.
>
> **Drift check (run first):**
>
> ```sh
> git status --short
> git diff --stat d11bc60..HEAD -- src/parser src/domain src/metrics docs/adr test/unit test/integration test/helpers test/fixtures
> ```
>
> Expected: `git status` shows nothing except possibly `plans/` files (this plan and the index may carry uncommitted review edits; that is fine). The diff is empty, or lists only files this plan creates. If `src/parser/protocol.ts`, `src/parser/extract-syntax.ts`, `src/parser/adapter.ts` or `src/domain/types.ts` changed, compare the excerpts in "Current state" with the live code. Any mismatch is a STOP condition.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** MED. Counting errors propagate silently into estimates (plans 010/011).
- **Depends on:** `plans/006-parser-adapter-isolation.md` (merged into `main`; `2a04649` is an ancestor of `d11bc60`)
- **Category:** direction
- **Planned at:** commit `d11bc60`, 2026-10-15. Rewritten by `review-plan` on 2026-10-15; the earlier text targeted `9b0bfe7`, before the parser existed.

## Why this matters

The estimator's explainable baseline is unique-file SLOC plus syntactic decision, loop, storage, assembly and low-level-call counts. Plan 006 delivered a parser that emits tokens, declarations, imports and three event kinds (`declaration`, `import`, `pragma`), but nothing yet turns those into the public `FileAnalysis`/`ContractAnalysis`/`CallableAnalysis` records. This plan adds the missing extraction events and pure, unit-tested transforms that fill those records under the counting rules fixed in ADR 002. Plans 008, 009, 011, 012 and 013 consume these records. A double-counted line or a decision counted outside a function body becomes a wrong estimate with "measured" evidence attached.

## Current state

### Files and roles

- `src/parser/protocol.ts`: parser DTOs. `ParseFileResult`, `ParserToken`, `ParserDeclaration`, `ParserEvent`, `ParserAttribute`, `ParserSource`. **Do not modify.**
- `src/parser/extract-syntax.ts`: runs inside the worker child. One iterative cursor traversal (`extractSyntax`, around lines 424–778) emits tokens, declarations, imports and events. **The only parser file you modify.**
- `src/parser/adapter.ts`: parent-side validation of worker replies. **Do not modify.** It already accepts any kebab-case event kind (lines 576–616).
- `src/parser/worker.ts`: child entry; it calls `analyzeSource`. **Do not modify.** New events flow through it automatically.
- `src/parser/ranges.ts`: pure coordinate helpers. No Slang import.
- `src/domain/types.ts`: public DTOs. `FileAnalysis` (line ~124), `ContractAnalysis`, `CallableAnalysis`, `StateVariables`, `Measurement<T>` (line 33), `Analysis.aggregates`, internal `SourceLineSet` (line 384). **Do not modify.**
- `src/domain/canonical.ts`: `declarationIdentity(path, kind, startByte)`, `contractIdentity`, `callableIdentity`, `fileIdentity`.
- `src/domain/versions.ts`: `METRICS_VERSION = '1.0.0'`. **Leave it unchanged.** These rules *are* 1.0.0.
- `src/metrics/`: does not exist yet. You create it.

### What the parser emits today

`ParseFileResult` (`src/parser/protocol.ts`):

```ts
| { status: 'parsed'; fileId; version: ParserVersionRecord; tokens: readonly ParserToken[];
    declarations: readonly ParserDeclaration[]; imports: readonly ParserImport[];
    events: readonly ParserEvent[]; diagnostics; visitedNodes: number }
| { status: 'failed'; fileId; code: 'LANGUAGE_UNSUPPORTED' | 'PARSE_INVALID' | 'LIMIT_EXCEEDED' | 'INTERNAL_ERROR'; diagnostics }
```

- **Tokens** are every CST terminal, including trivia, sorted by range. `kind` is one of `whitespace | comment | natspec | string | identifier | keyword | operator | punctuation | unknown`. Trivia means `whitespace`, `comment` and `natspec`. Newline terminals are `whitespace`. Ranges are half-open UTF-8 byte offsets on the **original** text, with one-based `line` and one-based Unicode-scalar `column`. **Caution:** the coordinate index (`src/parser/ranges.ts:59-74`) starts a new line at CR, LF, CRLF **and U+2028/U+2029**. ADR 002 counts only CR/LF/CRLF, so token `start.line`/`end.line` are **not** physical-line numbers. Metrics must derive line numbers from byte offsets (Step 1). A leading BOM is not a token, and its 3 bytes are already accounted for in offsets.
- **Failed files carry no tokens, declarations or events.** Physical lines for them must come from `ParserSource.snapshot.originalText`.
- **Declarations:** `kind` is one of `contract | abstract-contract | library | interface | function | constructor | fallback | receive | modifier`. Free functions come out as `kind: 'function'` with `contractId: null`. Legacy unnamed `function()` comes out as `fallback`. Legacy same-name constructors (`function Foo()` inside `contract Foo`) come out as `function`. `attributes` always contain `declaration-kind` and `has-body`. They contain `visibility` / `mutability` **only when explicitly written**, and `abstract: true` for abstract contracts. `bodyRange` is the outer `{…}` of the body, or `null`.
- Explicit mutability currently maps only `pure`, `view` and `payable` (`extract-syntax.ts:685-694`). The legacy function keyword `constant` is **not** captured yet.

### Hard invariants enforced by `adapter.ts` (violating any one fails the whole file)

1. `tokens.length + declarations.length + imports.length + events.length <= visitedNodes` (lines 368–372). **Emit at most one event per distinct non-terminal CST node.** Put extra facts in that event's attributes, never in a second event.
2. Event keys are exactly `{fileId, kind, contractId, callableId, range, attributes}`. `kind` matches `/^[a-z]+(?:-[a-z]+)*$/` and is ≤128 chars. There are at most 32 attributes, with unique kebab-case keys and scalar values. String values are ≤512 code units.
3. If `contractId` is set, the event range must lie within that contract's declaration range. If `callableId` is set, it must lie within that callable's declaration range.

### Binding counting definitions (ADR 002, `docs/adr/002-domain-contract.md:13`, quoted)

> physical lines split CRLF/LF/CR with no terminal empty segment; source lines are unique lines intersecting non-trivia Solidity or Yul tokens; contract lines can overlap, while project totals use unions of unique scoped file lines. Decisions count syntactic `if`, ternary, loop, catch and logical operators in callable bodies; loops and depth are separately explanatory. Yul statement/call/control counts are distinct from Solidity decisions. State variable counts distinguish declared and mutable variables, and syntactic complex shapes from resolved types. Candidate low-level syntax is distinct from confirmed builtin calls. Unsupported syntax, failed binding and unknown type classification use `unavailable`.

### Conventions to match

Strict ESM, `.ts` import extensions, explicit named exports with explicit return/type annotations (`isolatedDeclarations`), `import type` for types, `readonly` DTOs, no `any`, no `@ts-` suppressions, and caught values stay `unknown` until narrowed. Exemplar of a pure, annotated module: `src/domain/canonical.ts`. Exemplar of the extractor's frame-stack pattern for multi-node state: `pragmaFrames` in `extract-syntax.ts`. It is declared around line 440, pushed at line 553, popped and emitted when the cursor leaves its depth at lines 469-480, and drained at end of file at lines 755-767. Do **not** copy the `importFrames` end-of-file drain (line 768): it throws.

Tests: unit tests live in `test/unit/**/*.test.ts`, import source, and **must not import Slang or `extract-syntax.ts`**. Model them after `test/unit/parser-ranges.test.ts`. Real-parser tests are integration tests that go through `createParserSession`/`analyzeSources` against the built worker. Model them after `test/integration/parser-worker.test.ts`: `makeContext` (line 66), `parserSource` (line 97) and the test at line 241. They need `pnpm build` first.

## Metric contract (normative; `docs/metrics.md` must restate it)

All counts below are produced in the **parent** by pure functions in `src/metrics/` from `ParserSource` + `ParseFileResult`. The worker only emits raw events.

| Public field | Rule | Unavailable when |
|---|---|---|
| `FileAnalysis.physicalLines` | Strip at most one leading U+FEFF. Empty → 0. Otherwise 1 + number of terminators (`\r\n` counts once, lone `\r`, lone `\n`), minus 1 if the text ends with a terminator. U+2028/U+2029 are not terminators. | never (computed from snapshot text, also for failed files) |
| `FileAnalysis.sourceLines` | Size of the file's line set: for each token whose kind is **not** `whitespace`/`comment`/`natspec`, decode its bytes, split on `\r\n|\r|\n`, and add `physicalLineAt(lineStarts, range.startByte) + i` for each piece `i` that contains a non-whitespace character. A U+2028 inside a token does not start a new piece. Never use `range.start.line`. Invariant: `sourceLines <= physicalLines`. | file `failed` |
| `ContractAnalysis.sourceLines` | Size of the subset of the file line set contributed by tokens whose range lies within the contract's `declarationRange`. Same-line contracts both count that line. | file `failed` |
| `declarationCounts.*` | Count declarations by kind: `contract`, `abstract-contract`, `library`, `interface`. | file `failed` |
| `CallableAnalysis.kind` | Parser kind, except `function` with `contractId === null` → `free-function`. | n/a |
| `visibilityExplicit` / `mutabilityExplicit` | Measured: the explicit attribute value, or the string `'none'` if absent. Legacy `constant` function keyword → explicit `'constant'`. | never for parsed files |
| `visibilityEffective` | See the effective-attribute table below. | as the table says |
| `mutabilityEffective` | Explicit value, with `'constant'` → `'view'`. If absent: `'nonpayable'` for function, free-function, constructor and fallback; `'payable'` for receive. | modifier → unavailable `not-applicable` |
| `hasBody` | `declaration.hasBody`. | never for parsed files |
| `decisions` (callable) | Count of `control` events whose `callableId` is this callable **and** whose range lies within its `bodyRange`. Kinds: `if`, `ternary`, `for`, `while`, `do-while`, `catch`, `and`, `or`. `else`, `try`, `require`/`assert` and Yul constructs are never decisions. | `hasBody` false → unavailable `no-body` |
| `loops` (callable) | Subset of those decisions with kind `for`/`while`/`do-while`. | `no-body` |
| `maxLoopDepth` (callable) | Longest chain of loop events nested by range containment (0 if no loops). | `no-body` |
| `assemblyBlocks`, `yulStatements`, `yulCalls`, `yulControlFlow` (callable) | Count of `assembly`, `yul-statement`, `yul-call` and `yul-control` events owned by the callable. | `no-body` |
| `lowLevelCallCandidates` (callable) | Count of `call-site` events owned by the callable with `low-level-candidate: true`. | `no-body` |
| `modifiersApplied` | Names from `modifier-invocation` events owned by the callable, in source order. | never for parsed files |
| File `decisions`, `loops`, Yul counts, `lowLevelCallCandidates` | Sum over the file's callables that have bodies. Events outside any callable body (for example a ternary in a state-variable initializer) are **not** counted (ADR 002: "in callable bodies"). | file `failed` |
| File `maxLoopDepth` | Max over callables (0 if none). | file `failed` |
| `StateVariables.count` | Number of `state-variable` events in scope (contract or file). | file `failed` |
| `mutableCount` | Those with `constant: false` and `immutable: false`. `transient` variables count as mutable. | file `failed` |
| `typeShapes` | One `StateVariableShape` per state variable: `declarationId = declarationIdentity(canonicalPath, 'state-variable', range.startByte)`, `shape` from the event's `type-shape` attribute, and `mutable` as above. | file `failed` |
| `complexMutableDeclarationIds` | IDs of mutable variables whose shape is `mapping` or `array`, sorted. `user-defined` is **not** treated as complex in 007 (its resolution belongs to 008). Document this limitation. | file `failed` |

**Effective visibility table.** `v` means the selected grammar version, `ParseFileResult.version.selectedVersion`.

| Callable kind | Explicit present | Explicit absent |
|---|---|---|
| function (in contract/library/interface) | explicit | `v < 0.5.0` → `public`; else unavailable `visibility-missing` |
| free-function | explicit | `internal` |
| constructor | explicit | `v < 0.7.0` → `public`; else unavailable `not-applicable` |
| fallback, receive | explicit | `v < 0.5.0` → `public`; else unavailable `visibility-missing` |
| modifier | — | unavailable `not-applicable` |

Any case not covered → unavailable `effective-rule-unconfirmed`. Compare versions numerically as `major.minor.patch` triples, with a small helper in `src/metrics/definitions.ts`. No comparator exists in the codebase today.

**Evidence.** Every `measured` value carries `EvidenceRef`s:

- File line counts: one range covering the whole original text, built by `endOfTextPosition(text)` (see Step 1).
- Contract line count: the contract `declarationRange`.
- Event-based counts: one ref per counted event range.
- Declaration counts: the declaration ranges.
- Explicit/effective attributes and `hasBody`: the callable `declarationRange`.

**Unavailable reasons** are fixed string constants exported from `src/metrics/definitions.ts`: `parse-language-unsupported`, `parse-invalid`, `parse-limit-exceeded`, `parse-internal-error`, `no-body`, `not-applicable`, `visibility-missing`, `effective-rule-unconfirmed`, `scoped-file-unavailable`. Unavailable must never become 0.

**Not produced here** (no public field exists; do not add one). These can stay internal or be omitted:

- a `syntacticCyclomatic` value (document it as the derived proxy `1 + decisions`)
- branch/loop/operator subtotal fields
- counts of Solidity `event`/`error`/`struct` definitions
- storage-location annotations
- call-site shapes beyond the low-level candidate count
- context-only totals
- duplicate-content groups

If you believe a public field is required, STOP.

## New extraction events (Step 2 adds these in `extract-syntax.ts`)

| Event `kind` | Emitted at CST non-terminal | Owner fields | Attributes |
|---|---|---|---|
| `control` | `IfStatement`, `ConditionalExpression`, `ForStatement`, `WhileStatement`, `DoWhileStatement`, `CatchClause`, `AndExpression`, `OrExpression` | enclosing contract/callable, or `null` | `control-kind`: `if`/`ternary`/`for`/`while`/`do-while`/`catch`/`and`/`or` |
| `assembly` | `AssemblyStatement` | enclosing | `memory-safe`: boolean, true iff its `AssemblyFlags` contain the string literal `"memory-safe"` |
| `yul-statement` | `YulStatement` | enclosing | none |
| `yul-call` | `YulFunctionCallExpression` | enclosing | none |
| `yul-control` | `YulIfStatement`, `YulForStatement`, `YulSwitchStatement` | enclosing | `yul-kind`: `if`/`for`/`switch` |
| `state-variable` | `StateVariableDefinition` | contract, `callableId: null` | `type-shape`: from the definition's `TypeName` child, **after unwrapping that `TypeName` wrapper** (`ElementaryType`→`elementary`, `MappingType`→`mapping`, `ArrayTypeName`→`array`, `IdentifierPath`→`user-defined`, anything else→`unknown`); `constant`, `immutable`, `transient`: booleans from `ConstantKeyword`/`ImmutableKeyword`/`TransientKeyword` in its `StateVariableAttribute`s |
| `call-site` | `FunctionCallExpression` | enclosing | `callee-shape`: `identifier`/`member`/`new`/`other`; `member-name` (only when `member`); `low-level-candidate`: boolean (rule below) |
| `modifier-invocation` | `ModifierInvocation` | enclosing callable | `name`: the invoked path text (≤128 code units; longer → `TraversalLimit`, matching the existing name rule) |

All these Slang 1.3.9 kind names were verified in `node_modules/@nomicfoundation/slang/wasm/generated/interfaces/nomic-foundation-slang-cst.d.ts`.

**Callee rule.** Slang wraps operands in `Expression` nodes. `FunctionCallExpression.operand`, `MemberAccessExpression.operand` and `CallOptionsExpression.operand` are all `Expression` wrappers, so always unwrap `Expression` to its single child before classifying. If the unwrapped operand is a `CallOptionsExpression` (`x.call{value: v}(…)`), unwrap it and its inner `Expression` too. Descend at most 6 nodes per call site for this inspection.

- A `MemberAccessExpression` has shape `member`. Its `member-name` is the member identifier.
- An `Identifier` has shape `identifier`.
- A `NewExpression` has shape `new`.
- Anything else has shape `other`.

`low-level-candidate` is true iff either:

- `member-name` ∈ {`call`, `delegatecall`, `staticcall`, `callcode`, `send`, `transfer`}, or
- `member-name` ∈ {`value`, `gas`} and that member's object is itself a member access named `call`/`delegatecall`/`callcode`. This is the legacy `a.call.value(1)(d)` chain, which then counts exactly once, at the inner `.value(…)` call.

This is a **name match only**. `token.transfer(to, amt)` is a candidate; confirmation is plan 008's job.

**Ownership.** Use the innermost open contract and callable from the existing `contracts`/`pending` stacks. Inspecting a node's children with a cloned cursor (as `directHasLabel` does) must `charge(work)` per visited child, as `directHasLabel` already does.

**Capture owners when the node is first seen.** For framed events (`assembly`, `state-variable`), store `contractId`/`callableId` in the frame at push time. The loop pops `contracts`/`pending` (lines 464-468) before frames are emitted, so reading them at emission time gives a wrong or null owner.

**String attribute limits.** If `member-name` or `name` is longer than 128 code units, throw `TraversalLimit` (giving `LIMIT_EXCEEDED`). This matches the existing declaration-name rule; never emit a value the adapter would reject (over 512). For `memory-safe`, strip the surrounding quotes from the `StringLiteral` token text (`"memory-safe"` or `'memory-safe'`) and compare the result with `memory-safe`.

## Commands you will need

Verified green at `d11bc60` on 2026-10-15: `pnpm typecheck`, `pnpm test` (7 files, 52 tests), `pnpm lint` and `pnpm format:check` all exit 0.

| Purpose | Command | Expected |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | exit 0 (run first in a fresh checkout) |
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests (no build) | `pnpm test` | exit 0 |
| One unit file | `pnpm exec vitest run --project unit test/unit/source-metrics.test.ts` | exit 0 |
| Extraction integration | `pnpm build && pnpm exec vitest run --project integration test/integration/structural-extraction.test.ts` | exit 0 |
| Full regression | `pnpm test:all` | exit 0 (builds before integration) |
| Schemas unchanged | `pnpm schemas:check` | exit 0 |
| Lint / format | `pnpm lint`, `pnpm format:check` | exit 0 |

If pnpm tries to reinstall before a script and aborts for lack of a TTY, run `pnpm --config.verifyDepsBeforeRun=false run <script>` after a successful frozen install. Never set `CI` or approve a purge to get past it.

## Scope

**In scope** (the only files you may create or modify):

- `src/parser/extract-syntax.ts`: new events and the legacy `constant` mutability mapping only
- `src/metrics/definitions.ts` (create): reason constants, version comparator, internal types
- `src/metrics/source.ts` (create): physical lines, line sets, EOF position
- `src/metrics/structural.ts` (create): `ParseFileResult` → `FileAnalysis`/`ContractAnalysis`/`CallableAnalysis`
- `src/metrics/aggregate.ts` (create): `Analysis['aggregates']`
- `test/unit/source-metrics.test.ts`, `test/unit/structural-metrics.test.ts`, `test/unit/aggregate-metrics.test.ts` (create)
- `test/integration/structural-extraction.test.ts` (create)
- `test/helpers/parse-source.ts` (create): copy of the `makeContext`/`parserSource`/`trustedDefaults` pattern from `parser-worker.test.ts`
- `test/fixtures/metrics/*.sol` (create, if you prefer file fixtures to inline strings)
- `docs/metrics.md` (create)
- `plans/README.md`: the 007 row only

**Out of scope** (do NOT touch):

- `src/parser/{protocol,adapter,worker,ranges,version-policy}.ts`. The validation and wire format are reviewed (ADR 005), and new kinds pass without changes.
- `src/domain/**`, including `versions.ts` and `schemas.ts`. The public contract is frozen at 1.0.0.
- `test/fixtures/manifest.json`. `test/research/slang-spike.test.ts:594` iterates every entry and asserts spike-specific fields.
- `test/integration/parser-worker.test.ts`. Copy its helpers; do not refactor it.
- `src/index.ts`, `src/cli/**` and reports. Orchestration and exports belong to plan 013.
- Import resolution, inheritance, binding, builtin confirmation (008), and indicators (009).

## Git workflow

- Branch: `advisor/007-source-structural-metrics` (repo convention, e.g. `advisor/006-parser-adapter-isolation`).
- Conventional commits, one per step, e.g. `feat: add token-backed source line metrics`. The repo style is `feat: add version-aware isolated parser boundary`.
- End each commit message with the attribution line your operator specifies.
- Do NOT push, merge or open a PR unless the operator instructs it.

## Steps

### Step 1: Source line metrics (`src/metrics/source.ts`, `src/metrics/definitions.ts`)

Export, with explicit annotations:

```ts
export function countPhysicalLines(text: string): number;
export function endOfTextPosition(text: string): { readonly byte: number; readonly line: number; readonly column: number };
export function buildSourceLineSet(fileId: FileId, originalBytes: Uint8Array, tokens: readonly ParserToken[]): SourceLineSet;
export function buildLineStartIndex(originalBytes: Uint8Array): readonly number[];
export function physicalLineAt(lineStarts: readonly number[], byte: number): number;
// Lines contributed only by non-trivia tokens whose byte range lies within `range`.
export function linesWithin(originalBytes: Uint8Array, tokens: readonly ParserToken[], range: SourceRange): ReadonlySet<number>;
```

- `buildLineStartIndex(originalBytes)` returns the sorted byte offsets at which each ADR-002 physical line starts (CR, LF and CRLF only; CRLF counted once; skip a leading BOM's 3 bytes for line 1's content but keep offsets absolute). `physicalLineAt(lineStarts, byte)` binary-searches it and returns a one-based line. `buildSourceLineSet` and `linesWithin` use it instead of token `line` fields.
- `endOfTextPosition` is for **evidence ranges**, so it must use the parser's domain coordinate system, not ADR line counting. It returns:
  - `byte`: the UTF-8 length.
  - `line`: 1 + the number of line breaks as `SourceCoordinateIndex` counts them (CR, LF, CRLF once, U+2028, U+2029).
  - `column`: 1 + the number of Unicode scalars after the last terminator, iterating with `for…of` and **including** a leading BOM, to match the ADR 005 column rule.
- Decode token bytes with `new TextDecoder('utf-8', { fatal: true })` on `originalBytes.subarray(startByte, endByte)`.
- In `definitions.ts`, export:
  - the reason constants from the contract above;
  - `compareSolidityVersion(a: string, b: string): -1 | 0 | 1`;
  - the trivia kind set `['whitespace', 'comment', 'natspec']`.

Write `test/unit/source-metrics.test.ts` **before** the implementation. Use hand-built `ParserToken` arrays and literal byte strings, with oracles written by hand. Cases:

- `''` → 0
- `'a'` → 1
- `'a\n'` → 1
- `'\n'` → 1
- `'\n\n'` → 2
- `'a\r\nb'`, `'a\rb'` and `'a\nb'` → 2 each
- `'\uFEFF'` → 0 (write it as this escape sequence in the test, never as a pasted invisible character)
- `'\uFEFFa'` → 1
- `'a\u2028b'` → 1 physical line, and a non-trivia token spanning it contributes line 1 only
- `endOfTextPosition('a\u2028b')` → line 2 (domain coordinates differ on purpose; see Step 1)
- comment-only lines excluded
- NatSpec excluded
- a string token containing `//` counts
- a 3-line string token whose middle line is empty counts lines 1 and 3 only
- code followed by a trailing comment on the same line counts once
- two contract ranges on one line give `linesWithin` the same single line each, while the file set contains it once
- a token after a CRLF break is on line 2, not line 3

**Verify:** `pnpm exec vitest run --project unit test/unit/source-metrics.test.ts` → exit 0. `pnpm typecheck` → exit 0.

### Step 2: Emit the new events (`src/parser/extract-syntax.ts`)

Add the events from the "New extraction events" table inside the existing `extractSyntax` loop's non-terminal branch. Use the existing `contracts`/`pending` stacks for ownership. For `assembly` (`memory-safe`) and `state-variable` (attribute keywords), follow the `pragmaFrames` frame-stack pattern: push a frame at the node, update it from children/terminals, and emit the event when the cursor leaves its depth. Add `ConstantKeyword` → `'constant'` to the function-attribute mutability map (`extract-syntax.ts:685-694`). This applies only within a function attribute item, which the existing depth check already guarantees. Push all new events into the existing `events` array; the final `events.sort(compareRanges)` stays.

Write `test/integration/structural-extraction.test.ts` with `test/helpers/parse-source.ts`. Assert event kinds, attributes and owners per tiny inline fixture, one construct per fixture first, then one combined fixture:

- each `control-kind`, including `&&`/`||` and a ternary inside a modifier invocation argument (event emitted; Step 3 excludes it from decisions)
- `try`/`catch` with two catch clauses gives two `catch` events
- nested `for` inside `while`
- `assembly ("memory-safe") { … }` versus plain `assembly`, with Yul `if`/`for`/`switch`, `call(...)` and `sstore(...)`
- state variables: `uint`, `mapping`, `uint[]`, `S` (struct), `constant`, `immutable`, `transient` (with `pragma solidity ^0.8.28`)
- calls: `f()`, `a.b()`, `new C()`, `x.call{value: 1}("")`, `x.delegatecall("")`, legacy `x.call.value(1)("")` with `pragma solidity ^0.4.24`, and the decoy `token.transfer(a, 1)` (candidate true) next to a contract that defines its own `call()` function invoked as `this.call()` (candidate true; name match only)
- modifier invocations `onlyOwner` and `Base(1)` on a constructor
- legacy `function f() constant returns (uint)` gives `mutability` explicit `constant`
- for every fixture above, assert `result.visitedNodes >= tokens + declarations + imports + events` explicitly. The extra cursor inspections slightly raise `visitedNodes`, so a file already near `maxAstNodesPerFile` may now hit `LIMIT_EXCEEDED`. Note this in `docs/metrics.md`; no near-limit fixture is required.

**Verify:** `pnpm build && pnpm exec vitest run --project integration test/integration/structural-extraction.test.ts` → exit 0. `pnpm build && pnpm exec vitest run --project integration test/integration/parser-worker.test.ts` → exit 0 (no regression).

### Step 3: Map one file's result to public records (`src/metrics/structural.ts`)

```ts
export interface FileMetrics {
  readonly file: FileAnalysis;
  readonly contracts: readonly ContractAnalysis[];
  readonly callables: readonly CallableAnalysis[];
  readonly lineSet: SourceLineSet | null; // null when the file failed
}
export function buildFileMetrics(source: ParserSource, result: ParseFileResult): FileMetrics;
```

- `role`/`ownership` come from `source.manifestEntry`.
- `syntaxComplete = result.status === 'parsed'`.
- `importIds` are the `result.imports` ids in source order. Do **not** build `ImportReference`s (that is 008).
- `ContractAnalysis.range` and `CallableAnalysis.range` are `declarationRange`. `ContractAnalysis.name` is `declaration.name`.
- `CallableAnalysis.name` is `null` for `constructor`, `fallback` and `receive` (the parser fills in placeholder names for these at `extract-syntax.ts:786`). For every other kind it is `declaration.name`.
- `contractIds`, `callableIds` and `typeShapes` (by `declarationId`) are sorted ascending by id.
- A measured value of 0 has `evidence: []`.
- Contracts and callables are sorted by `id`. Use `sortById` from `src/domain/canonical.ts`.
- `ContractAnalysis.callableIds` are callables whose `contractId` matches. `stateVariables` are computed per contract and per file.
- A failed result yields:
  - measured `physicalLines`;
  - every other `Measurement` unavailable with reason `parse-<code lowercased with _ → ->`;
  - empty id lists;
  - `lineSet: null`.

Apply every row of the metric contract table exactly. Write `test/unit/structural-metrics.test.ts` first, using hand-built `ParseFileResult` objects (no Slang). Cases:

- each effective-visibility table row at versions `0.4.24`, `0.6.12` and `0.8.28`
- a bodyless interface function is `no-body` for decisions/loops/depth, not 0
- a ternary in a modifier-invocation argument (outside `bodyRange`) is not counted
- a ternary in a state initializer (`callableId: null`) is not counted at file level
- loop depth 2 from nested ranges
- Yul control is not counted as decisions or loops
- free-function kind mapping
- `transient` counts as mutable
- `user-defined` is not complex
- failed `PARSE_INVALID` gives `physicalLines` measured and `sourceLines` unavailable `parse-invalid`

**Verify:** `pnpm exec vitest run --project unit test/unit/structural-metrics.test.ts` → exit 0. `pnpm typecheck` → exit 0.

### Step 4: Aggregate scoped totals (`src/metrics/aggregate.ts`)

```ts
export function aggregateMetrics(files: readonly FileMetrics[]): Analysis['aggregates'];
```

- Only files with `file.role === 'scoped'` contribute. Context and excluded files never do.
- Do not deduplicate. A repeated `fileId` in the input is a programming error, so throw `TypeError`.
- `scopedFiles` is the number of distinct scoped files.
- `physicalLines` and `sourceLines` are the sum over scoped files of **file** values, never contract values.
- `contracts` and `callables` are counts of distinct IDs across scoped files. Callables include modifiers.
- If any scoped file has `syntaxComplete === false`, then `sourceLines`, `contracts` and `callables` are all unavailable `scoped-file-unavailable`. `physicalLines` stays measured, because it is computed for failed files too. `scopedFiles` is always measured.
- Aggregate evidence: `scopedFiles`, `physicalLines` and `sourceLines` get one whole-file ref per scoped file. `contracts` and `callables` get one ref per counted declaration range.
- Byte-identical files at different paths remain separate files. Do not discount them.

`test/unit/aggregate-metrics.test.ts` cases:

- two contracts on one line → file SLOC 1, aggregate SLOC 1, sum of contract SLOC 2 (proving that contract SLOC is not summed)
- a context file contributes nothing
- two identical-byte scoped files count twice
- input order permutation gives deep-equal output
- one failed scoped file → `sourceLines` unavailable, while `scopedFiles` stays measured

**Verify:** `pnpm exec vitest run --project unit test/unit/aggregate-metrics.test.ts` → exit 0.

### Step 5: Document and prove stability

Write `docs/metrics.md`:

- every public field from the contract table with its rule, unit, evidence and unavailable reasons
- the effective-attribute table, with links to the Solidity docs on visibility/mutability defaults for 0.4.x, 0.5.0 and 0.7.0
- the "Not produced here" list
- known limitations:
  - layout-sensitive SLOC
  - name-only low-level candidates
  - legacy same-name constructors counted as `function`
  - base-constructor calls listed in `modifiersApplied`
  - `user-defined` state shapes not classified
  - file-level `constant` definitions not counted as state variables
  - Slang node ranges may include leading trivia (affects evidence ranges, not counts)

State that these definitions are `METRICS_VERSION` 1.0.0.

Add stability tests to the integration file. Each one parses two variants and compares the resulting `FileMetrics`:

- adding comments/blank lines changes `physicalLines` only
- LF ↔ CRLF ↔ CR leaves every value unchanged
- renaming locals leaves every count unchanged
- reordering files leaves aggregates unchanged
- reflowing a statement across lines **may** change `sourceLines`; assert the exact new value instead of asserting invariance

**Verify:** run everything in the "Done criteria" block below.

## Test plan

New unit suites: `source-metrics`, `structural-metrics` and `aggregate-metrics`. They use hand-built DTOs and hand-written oracles, with no Slang and no build. The new integration suite `structural-extraction` uses the real parser through the built worker. Assert exact values; no snapshot files. When a parser upgrade changes output, you must update the oracle by hand and give a reason. Never accept a golden update just because output changed.

## Done criteria

All must hold:

- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm format:check` exit 0
- [ ] `pnpm test` exits 0, and the three new unit files are present and pass
- [ ] `pnpm test:all` exits 0, including `structural-extraction` and the unchanged `parser-worker` suite
- [ ] `pnpm schemas:check` exits 0 with no generated-schema diff (`git status --short` shows no schema files)
- [ ] `git diff --name-only d11bc60..HEAD` lists only in-scope files, plus `plans/007-source-structural-metrics.md` if its review edits were committed
- [ ] `git diff d11bc60..HEAD -- src/domain src/parser/protocol.ts src/parser/adapter.ts src/parser/worker.ts test/fixtures/manifest.json` is empty
- [ ] `grep -rnE '\.replace(All)?\(' src/metrics; test $? -eq 1` → exit 0. grep exit 1 means no matches; exit 2 means a broken command, so never read it as success. Comments are excluded by token kind, not by rewriting text.
- [ ] `docs/metrics.md` exists and mentions every field in the metric contract table
- [ ] The 007 row in `plans/README.md` is updated

## STOP conditions

Stop and report if:

- Excerpts or line references in "Current state" don't match the live code (drift).
- A file that parsed before this change now fails validation in `parser-worker.test.ts`. This most likely breaks the `records <= visitedNodes` invariant or an owner-range check.
- A listed Slang kind name is not produced where expected, for example `CatchClause` or `ModifierInvocation` never appears for a fixture that contains it. Do not substitute regex or text matching.
- A rule in the effective-visibility table contradicts the Solidity documentation for that version.
- Any public field, schema or `src/domain` change seems necessary.
- Emitting events requires changing `adapter.ts`, `protocol.ts` or `worker.ts`.
- A verification step fails twice after a reasonable fix.

## Maintenance notes

- Changing any rule above changes the meaning of `METRICS_VERSION` 1.0.0. Bump the version via a reviewed plan, and update the oracles independently.
- Plan 008 consumes `call-site` events (candidate → confirmed builtin) and state `user-defined` shapes (→ struct/complex). Keep attribute names stable.
- Plan 009 will want arithmetic/bitwise operation and hashing-builtin events. They are deliberately deferred; add them there with the same one-event-per-node rule.
- Plan 013 wires `buildFileMetrics`/`aggregateMetrics` into the analysis pipeline and decides public exports. Duplicate-content observations and context totals, if wanted, need a schema amendment there.
- Reviewers: check the decision filter (`bodyRange` containment), the CRLF single-count, that unavailable values never collapse to 0, and that every new event is emitted at a distinct non-terminal node.
