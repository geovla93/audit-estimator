# Source and structural metrics

These definitions are `METRICS_VERSION` <!-- docs:fact metrics-version -->1.0.0 (`src/domain/versions.ts`). They implement the counting rules fixed in [ADR 002](adr/002-domain-contract.md). Changing any rule below changes the meaning of `1.0.0` and needs a reviewed plan that bumps the version.

All counts are produced in the parent process by pure functions in `src/metrics/` from a `ParserSource` and its `ParseFileResult`. The isolated parser worker only emits raw syntax events ([ADR 005](adr/005-parser-boundary.md)). Counts are syntactic. None of them claims compiler-level control flow, resolved types or storage layout.

- `src/metrics/source.ts`: physical lines, token-backed source-line sets, end-of-text evidence position.
- `src/metrics/structural.ts`: `buildFileMetrics(source, result)` produces `FileAnalysis`, `ContractAnalysis` and `CallableAnalysis` records.
- `src/metrics/aggregate.ts`: `aggregateMetrics(files)` produces `Analysis['aggregates']`.
- `src/metrics/definitions.ts`: unavailable-reason constants, the Solidity version comparator and shared kind sets.

## Measurements and evidence

Every public field is a `Measurement<T>`. A `measured` value carries `EvidenceRef`s, and a measured value of 0 carries `evidence: []` (observed absence). An `unavailable` value carries one of the reasons below and is never reported as 0.

| Evidence for                                             | Reference                                                                                             |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| File line counts                                         | One range covering the whole original text, ending at `endOfTextPosition(text)` (parser coordinates). |
| Contract `sourceLines`                                   | The contract `declarationRange`.                                                                      |
| Event-based counts (decisions, Yul, state, ...)          | One reference per counted event range.                                                                |
| Declaration counts                                       | The counted declaration ranges.                                                                       |
| Explicit/effective attributes and `hasBody`              | The callable `declarationRange`.                                                                      |
| Aggregates `scopedFiles`, `physicalLines`, `sourceLines` | One whole-file reference per scoped file.                                                             |
| Aggregates `contracts`, `callables`                      | One reference per counted declaration range.                                                          |

Unavailable reasons (constants in `src/metrics/definitions.ts`):

| Reason                       | Meaning                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `parse-language-unsupported` | The parser result for the file is `failed` with `LANGUAGE_UNSUPPORTED`.        |
| `parse-invalid`              | The parser result is `failed` with `PARSE_INVALID`.                            |
| `parse-limit-exceeded`       | The parser result is `failed` with `LIMIT_EXCEEDED`.                           |
| `parse-internal-error`       | The parser result is `failed` with `INTERNAL_ERROR`.                           |
| `no-body`                    | The callable has no body (interface or abstract function, for example).        |
| `not-applicable`             | The attribute does not exist for this callable kind or Solidity version.       |
| `visibility-missing`         | No explicit visibility and the selected grammar version has no default for it. |
| `effective-rule-unconfirmed` | A kind/version combination that the effective-attribute table does not cover.  |
| `scoped-file-unavailable`    | An aggregate cannot be computed because a scoped file failed to parse.         |

## Field rules

### Line counts

| Field                          | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Unit  | Unavailable when                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------- |
| `FileAnalysis.physicalLines`   | Strip at most one leading U+FEFF. Empty text is 0. Otherwise 1 plus the number of terminators (`\r\n` counts once, lone `\r`, lone `\n`), minus 1 if the text ends with a terminator. U+2028 and U+2029 are not terminators.                                                                                                                                                                                                                            | lines | never (computed from the snapshot text, also for failed files) |
| `FileAnalysis.sourceLines`     | The size of the file's line set. For each token whose kind is not `whitespace`, `comment` or `natspec`, decode its bytes, split on `\r\n`, `\r` or `\n`, and add the physical line of the token start plus the piece index for each piece that contains a non-whitespace character. A U+2028 inside a token does not start a new piece. Token `line` fields are never used, because the parser coordinate index also breaks lines at U+2028 and U+2029. | lines | file failed                                                    |
| `ContractAnalysis.sourceLines` | The size of the subset of the file line set contributed by tokens whose byte range lies inside the contract `declarationRange`. Two contracts on one line both count that line.                                                                                                                                                                                                                                                                         | lines | file failed                                                    |

`sourceLines <= physicalLines` always holds. A line with only a comment, NatSpec or whitespace is not a source line. A line with code and a trailing comment counts once. A string literal containing `//` is a string token and counts.

### Declarations and callables

| Field                                                                              | Rule                                                                                                                                                        | Unavailable when           |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `declarationCounts.contracts`, `abstractContracts`, `libraries`, `interfaces`      | Count of declarations of kind `contract`, `abstract-contract`, `library`, `interface`.                                                                      | file failed                |
| `CallableAnalysis.kind`                                                            | The parser kind, except a `function` with no enclosing contract is `free-function`.                                                                         | n/a                        |
| `CallableAnalysis.name`                                                            | `null` for `constructor`, `fallback` and `receive` (the parser only supplies placeholder names). The declaration name otherwise.                            | n/a                        |
| `visibilityExplicit`, `mutabilityExplicit`                                         | The explicitly written attribute value, or the string `none` if absent. The legacy `constant` function keyword is explicit mutability `constant`.           | never for parsed files     |
| `visibilityEffective`                                                              | See the effective-attribute table.                                                                                                                          | as the table says          |
| `mutabilityEffective`                                                              | The explicit value, with `constant` mapped to `view`. If absent: `nonpayable` for function, free-function, constructor and fallback; `payable` for receive. | modifier: `not-applicable` |
| `hasBody`                                                                          | Whether the declaration has a `{ ... }` body.                                                                                                               | never for parsed files     |
| `modifiersApplied`                                                                 | Names from `modifier-invocation` events owned by the callable, in source order. Base-constructor calls on a constructor are listed here too.                | never for parsed files     |
| `ContractAnalysis.callableIds`                                                     | Callables whose `contractId` is the contract.                                                                                                               | n/a                        |
| `FileAnalysis.importIds`                                                           | Import ids in source order. Import references are not built here.                                                                                           | n/a                        |
| `FileAnalysis.contractIds`, `callableIds`, and the `contracts`/`callables` records | Sorted ascending by id.                                                                                                                                     | n/a                        |

#### Effective-attribute table

`v` is the grammar version the parser selected (`ParseFileResult.version.selectedVersion`). Versions are compared numerically as `major.minor.patch` triples.

| Callable kind                           | Explicit visibility present | Explicit visibility absent                                        |
| --------------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| function (contract, library, interface) | the explicit value          | `v < 0.5.0`: `public`; otherwise unavailable `visibility-missing` |
| free-function                           | the explicit value          | `internal`                                                        |
| constructor                             | the explicit value          | `v < 0.7.0`: `public`; otherwise unavailable `not-applicable`     |
| fallback, receive                       | the explicit value          | `v < 0.5.0`: `public`; otherwise unavailable `visibility-missing` |
| modifier                                | n/a                         | unavailable `not-applicable`                                      |

Any other combination is unavailable `effective-rule-unconfirmed`.

The thresholds follow the Solidity documentation: before 0.5.0 an omitted function visibility defaults to `public` ([0.4.24 visibility documentation](https://docs.soliditylang.org/en/v0.4.24/contracts.html#visibility-and-getters)); 0.5.0 makes explicit visibility mandatory ([0.5.0 breaking changes](https://docs.soliditylang.org/en/v0.8.28/050-breaking-changes.html)); 0.7.0 removes visibility from constructors ([0.7.0 breaking changes](https://docs.soliditylang.org/en/v0.8.28/070-breaking-changes.html)).

### Control flow and Yul

A callable's counts are computed from the extraction events the parser emits for it. Every event is owned by the innermost enclosing contract and callable at the node, or by none.

| Field                                                                                                                | Rule                                                                                                                                                                                                                                                                                                                                                                                 | Unavailable when |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `CallableAnalysis.decisions`                                                                                         | Count of `control` events owned by the callable whose range lies inside its `bodyRange`. Kinds counted: `if`, `ternary`, `for`, `while`, `do-while`, `catch`, `and`, `or`. `else`, `try`, `require`/`assert` and every Yul construct are never decisions. A ternary in a modifier-invocation argument, or in a state-variable initializer, lies outside any body and is not counted. | `no-body`        |
| `loops`                                                                                                              | The subset of those decisions of kind `for`, `while` or `do-while`.                                                                                                                                                                                                                                                                                                                  | `no-body`        |
| `maxLoopDepth`                                                                                                       | The longest chain of loop events nested by range containment (0 if no loops).                                                                                                                                                                                                                                                                                                        | `no-body`        |
| `assemblyBlocks`, `yulStatements`, `yulCalls`, `yulControlFlow`                                                      | Count of the callable's `assembly`, `yul-statement`, `yul-call` and `yul-control` events. Yul `if`, `for` and `switch` are `yulControlFlow` and are not Solidity decisions or loops.                                                                                                                                                                                                 | `no-body`        |
| `lowLevelCallCandidates`                                                                                             | Count of the callable's `call-site` events whose `low-level-candidate` attribute is true. This is a name match on the member being called (`call`, `delegatecall`, `staticcall`, `callcode`, `send`, `transfer`, or the legacy `.call.value(...)`/`.call.gas(...)` chain), not a confirmed builtin.                                                                                  | `no-body`        |
| File `decisions`, `loops`, `assemblyBlocks`, `yulStatements`, `yulCalls`, `yulControlFlow`, `lowLevelCallCandidates` | Sum over the file's callables that have bodies. Events outside any callable body are not counted ("in callable bodies" in ADR 002).                                                                                                                                                                                                                                                  | file failed      |
| File `maxLoopDepth`                                                                                                  | Maximum over the file's callables (0 if none).                                                                                                                                                                                                                                                                                                                                       | file failed      |

The derived proxy for cyclomatic complexity is `1 + decisions`. It is not stored in any public field.

### State variables

`StateVariables` is computed per contract (`ContractAnalysis.stateVariables`) and per file (`FileAnalysis.stateVariables`) from `state-variable` events.

| Field                          | Rule                                                                                                                                                                                            | Unavailable when |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `count`                        | Number of state-variable definitions in scope.                                                                                                                                                  | file failed      |
| `mutableCount`                 | Those that are neither `constant` nor `immutable`. `transient` variables count as mutable.                                                                                                      | file failed      |
| `typeShapes`                   | One entry per variable: `declarationId` (`decl:<path>:state-variable:<startByte>`), `shape` and `mutable`. Shapes: `elementary`, `mapping`, `array`, `user-defined` or `unknown`. Sorted by id. | file failed      |
| `complexMutableDeclarationIds` | Ids of mutable variables whose shape is `mapping` or `array`, sorted.                                                                                                                           | file failed      |

### Aggregates

Only files whose scope role is `scoped` contribute; context and excluded files never do.

| Field           | Rule                                                                                                                                  | Unavailable when                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `scopedFiles`   | Number of distinct scoped files.                                                                                                      | never                                              |
| `physicalLines` | Sum of the scoped files' file-level `physicalLines`. Failed files still contribute.                                                   | never                                              |
| `sourceLines`   | Sum of the scoped files' file-level `sourceLines`. Contract values are never summed, so contracts that share a line are counted once. | any scoped file failed (`scoped-file-unavailable`) |
| `contracts`     | Number of distinct contract ids across scoped files.                                                                                  | any scoped file failed (`scoped-file-unavailable`) |
| `callables`     | Number of distinct callable ids across scoped files, including modifiers.                                                             | any scoped file failed (`scoped-file-unavailable`) |

Byte-identical files at different paths are separate files and are not discounted. A repeated file id in the input is a programming error and throws `TypeError`.

## Extraction events

The parser worker emits one event per distinct CST non-terminal node, in addition to the existing `declaration`, `import` and `pragma` events. Extra facts go into the event's attributes.

| Event                 | CST node                                                                                                                                     | Attributes                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `control`             | `IfStatement`, `ConditionalExpression`, `ForStatement`, `WhileStatement`, `DoWhileStatement`, `CatchClause`, `AndExpression`, `OrExpression` | `control-kind`: `if`, `ternary`, `for`, `while`, `do-while`, `catch`, `and`, `or`                                   |
| `assembly`            | `AssemblyStatement`                                                                                                                          | `memory-safe`: true if the assembly flags contain the string `"memory-safe"`                                        |
| `yul-statement`       | `YulStatement`                                                                                                                               | none                                                                                                                |
| `yul-call`            | `YulFunctionCallExpression`                                                                                                                  | none                                                                                                                |
| `yul-control`         | `YulIfStatement`, `YulForStatement`, `YulSwitchStatement`                                                                                    | `yul-kind`: `if`, `for`, `switch`                                                                                   |
| `state-variable`      | `StateVariableDefinition`                                                                                                                    | `type-shape`, `constant`, `immutable`, `transient`                                                                  |
| `call-site`           | `FunctionCallExpression`                                                                                                                     | `callee-shape` (`identifier`, `member`, `new`, `other`), `member-name` (member callees only), `low-level-candidate` |
| `modifier-invocation` | `ModifierInvocation`                                                                                                                         | `name`: the invoked path text                                                                                       |

Because the extractor inspects a few extra cursor nodes per call site, state variable and modifier invocation, `visitedNodes` rises slightly. A file already near `maxAstNodesPerFile` may now fail with `LIMIT_EXCEEDED` where it previously parsed. This is expected and is not a regression.

## Not produced here

These have no public field in 1.0.0 and are deliberately absent. They may stay internal.

- A `syntacticCyclomatic` value (use `1 + decisions`).
- Branch, loop and operator subtotal fields.
- Counts of Solidity `event`, `error` and `struct` definitions.
- Storage-location annotations.
- Call-site shapes beyond the low-level candidate count.
- Context-only totals.
- Duplicate-content groups.

## Known limitations

- Source lines are layout-sensitive. Reflowing one statement over several lines changes `sourceLines` (and `physicalLines`) even though no behavior changes.
- Low-level call candidates are a name match only. `token.transfer(to, amount)` is a candidate, as is a contract's own `this.call()`. Confirming that a call is a builtin address call belongs to a later semantic plan.
- A legacy same-name constructor (`function Foo()` inside `contract Foo`, Solidity before 0.5.0) is classified as a `function`, not a `constructor`.
- Base-constructor calls on a constructor (`constructor() Base(1)`) are listed in `modifiersApplied`.
- State variables of `user-defined` shape are not classified further. Whether an identifier path is a struct, enum, contract or user-defined value type needs resolution, so such variables are never counted in `complexMutableDeclarationIds`.
- File-level `constant` definitions are not state variables and are not counted.
- Slang node ranges may include leading trivia. This affects evidence ranges only, never counts.
- Events from modifier-invocation arguments (for example a `call-site`) are owned by the callable but lie outside its body. Only decisions apply the body-range filter, per the rule above.
