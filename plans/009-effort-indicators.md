# Plan 009: Separate measured evidence, heuristic indicators and human assessment

> **Executor instructions:** Add versioned evidence rules and metadata observations only. Run each gate and update status 009 in `plans/README.md`. These are audit-effort indicators, not security findings.
>
> **Drift check first:** Re-reconciled at `d11bc60` on 2026-10-15. Run `git status --short`, `git diff --stat d11bc60..HEAD -- src/indicators src/domain src/metrics src/relationships src/discovery`, and `git diff HEAD -- src/indicators src/domain src/metrics src/relationships src/discovery` (plus inspect untracked in-scope files). Check prerequisite statuses and the current-state snapshot below. Expected completed-prerequisite additions require inspection; contradictory contracts or unrelated local edits require reconciliation before implementation.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED (false interpretation and misleading assurance)
- **Depends on:** `plans/007-source-structural-metrics.md`, `plans/008-imports-inheritance-interactions.md`
- **Category:** direction
- **Planned at:** commit `d11bc60`, re-reconciled 2026-10-15 after 005/006 merged (previously `9b0bfe7`); originally greenfield planning on 2026-10-14.

## Why this matters

Syntax can reveal additional review work without proving exploitability or business intent. Explicit indicator provenance and human prompts help an auditor interpret upgrade/access/dependency/test evidence while keeping speculative characteristics out of automatic numeric weighting.

## Current state and architectural context

### Reconciled implementation baseline — 2026-10-15 (refreshed at `d11bc60`)

`src/indicators/` is absent. `Indicator` is already defined with the exact fields shown below in the original context, and `Analysis` already has `testObservations`, `coverageObservation` and explicit completeness fields. `coverageObservation` currently exposes source, coveredLines and totalLines; per-file matching/stale provenance details need internal readiness records plus existing diagnostics/limitations, not extra keys on strict public objects. Use the existing measured/unavailable tags and diagnostic codes. If required machine-readable detail cannot fit, STOP for a focused schema amendment.

Config already supplies root-confined `coverage.lcovPath` and `maxLcovBytes`; do not reuse `parseConfigBytes` for LCOV or allow its parser to execute anything. `firstPartyOverrides` is a path-root policy, not a name-based trust signal. Safe bounded reads (005, `src/discovery/safe-read.ts`) and parser syntax records (006, `src/parser/`) are merged; read LCOV through 005's bounded primitives and shared budget, never a new unbounded `readFile`. Metrics (007) and graphs (008) are still TODO, so do not fabricate an analysis layer to make this plan run early.

Match established strict ESM conventions: `.ts` source imports, explicit named exports and exported annotations, `import type`, readonly DTOs, no `any` or suppressions, unknown caught values narrowed before use. Tests use Vitest source imports for units and the trusted build-first integration wrapper for artifact suites. These current facts supersede prospective wording in the original context below.

### Original design context (retained)

No classifiers existed at planning. Prerequisites should provide measured/unavailable values, call/inheritance resolution status, scope ownership and safe read helpers. `classifyIndicators(analysis)` is a pure function; separate readiness metadata loading uses bounded data-only reads. Indicators have `{id,ruleVersion,category,evidenceKind:"measured|heuristic|human",confidence:"high|medium|low|not-assessed",summary,evidence,limitations,requiresAssessment}`. Confidence refers to the indicator inference, **not estimate accuracy**. Use `1.0.0` rule catalog version.

Rules describe patterns, never severity/vulnerability/safe/unsafe conclusions. Existing tests or known dependencies do not earn automatic effort discounts. [OpenZeppelin readiness guidance](https://learn.openzeppelin.com/security-audits/readiness-guide) motivates test/documentation context; it does not supply quantitative coefficients.

## Commands you will need

**Reconciliation gate note (re-reconciled 2026-10-15 at `d11bc60`):** Plans 001–006 are merged on `main`. In the primary checkout with dependencies installed, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm schemas:check`, `pnpm test` (52 unit tests) and fresh-build `pnpm test:integration` (99 integration/research tests) all exit 0. `.oxfmtrc.json` now ignores `.agents/**`, `.claude/**`, `dist/**`, `plans/**` and `pnpm-lock.yaml`, so the former four-file `.agents/skills/improve` format exception **no longer exists: any `pnpm format:check` failure is a STOP condition.** The production build emits exactly ten files (`index.js`, `index.d.ts`, `bin.js`/`.map`, `version.js`/`.map`, the shared `versions.js`/`.map` chunk, `parser/worker.js`/`.map`) and `test/integration/bootstrap-cli.test.ts` asserts that inventory; a new entry or shared chunk requires an explicit plan amendment, not a silent test edit. Feature-specific suites and later scripts exist only when their owning plans land.

An executor works in its own checkout or worktree, which does not share `node_modules`: run `pnpm install --frozen-lockfile` first and obtain success. Afterwards `pnpm --config.verifyDepsBeforeRun=false run <script>` runs a script without pnpm's implicit dependency reconciliation (it does not repair missing packages). Built-artifact suites run through the build-first wrapper (`pnpm test:integration` / `pnpm test:all`), never against stale `dist/`. This reconciliation did not rerun `pnpm install --frozen-lockfile` or `pnpm test:coverage`.

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Proposed prerequisite scripts; none verified during recon.

| Purpose | Command | Expected |
|---|---|---|
| Indicator rules | `pnpm exec vitest run test/unit/indicators.test.ts` | positive/decoy/unknown cases pass |
| Readiness metadata | `pnpm exec vitest run test/integration/readiness-metadata.test.ts` | bounded test/LCOV observations pass |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm build`, `pnpm schemas:check` | 0 |

## Scope

**In scope:** `src/indicators/{catalog,classify,readiness,lcov,human-prompts}.ts`, `test/unit/indicators.test.ts`, `test/integration/readiness-metadata.test.ts`, `test/fixtures/indicators/**`, `test/fixtures/coverage/**`, `test/fixtures/manifest.json`, `docs/indicators.md`, 009 status row.

**Out of scope:** numerical coefficients/formulas, running tests/coverage/build scripts in target projects, fetching dependency trust/security lists, vulnerability labels, advanced protocol fingerprinting, business-logic/cryptographic correctness, generic regex Solidity recognition, report changes.

## Git workflow

Use supplied checkout; no observed conventions. No commit/push/publication or branch change without operator instruction.

## Steps

### Step 1: Publish a deliberately small indicator catalog

Implement measured indicators for confirmed assembly/Yul usage, builtin low-level/delegatecall sites, loops/complex-storage-type declarations and unresolved dependency edges. Heuristic indicators: upgrade-related structure from resolved inheritance/builtin evidence plus initializer/upgrade function shapes; privileged-operation candidates from modifier application + owner/role-shaped definition evidence; external integrations from resolved external interface/contract boundaries; mathematical/cryptographic review candidates from AST arithmetic/bitwise operations, cryptographic builtin calls and user-defined implementations. Name-only matches such as `onlyOwner`, `upgrade`, `Oracle`, `hash` or `Math` are low-confidence candidates or human prompts, never high-confidence facts. Built-in hashing alone is not custom cryptography.

Each rule must cite AST/binding records, state what it can and cannot establish, and emit deterministic evidence sorted by entity/range. Do not scan source with regex for recognizable names. String matching against already parsed identifier fields is allowed as a declared heuristic. Do not classify whole protocols (DEX/lending/bridges) automatically.

**Verify:** `pnpm exec vitest run test/unit/indicators.test.ts -t 'catalog rules'` → 0 with at least one positive, name-decoy and unknown-resolution fixture per heuristic rule.

### Step 2: Collect test presence and optional existing coverage safely

Observe configured/default test directories and bounded file counts/extensions through 005 safety, including `.t.sol` and JS/TS test filenames, without reading/executing test bodies or trusting filenames as quality. Distinguish observed present, observed absent, and not inspected due to limits. No penalty/discount for absence in the MVP default model.

If operator config supplies `coverage.lcovPath`, load only this root-confined existing text file (4 MiB cap) with safe reader and validate LCOV record format. Parse `SF`, `DA`, `LF`, `LH`, `end_of_record` strictly; ignore recognized optional fields with documented behavior and reject inconsistent/negative/duplicate conflicting counts. Normalize SF paths relative to root, disallow outside paths, map only to scoped source identities. Report supplied line coverage plus matched/unmatched scoped files and provenance `unverified-existing-artifact`; no assumption it corresponds to current bytes, compiler settings or branch coverage. Do not automatically scan artifact trees or download coverage. Parsing this line-oriented data format may use bounded line parsing; this does not permit regex Solidity analysis.

**Verify:** `pnpm exec vitest run test/integration/readiness-metadata.test.ts` → 0 for test presence/absence/uninspected, valid LCOV, malformed/oversized/outside-path/unmatched/stale-provenance cases, with no scripts spawned.

### Step 3: Add human assessment prompts and stable classification output

Always expose unassessed prompts for business/economic invariants, protocol novelty, external trust assumptions, custom cryptography/math, documentation maturity, upgrade lifecycle, cross-chain behavior and review depth. Prompts are optional operator work, not interactive CLI questions or model guesses. Manual adjustment input uses the schema's reasoned `{id,reason,category,lowHours,highHours}`; no automatic answers or external requests. Associate likely relevant prompts with evidence without answering them.

Report resolution coverage separately from confidence: syntactic occurrence certainty does not prove access control, storage effects or protocol dependency. Deduplicate indicator IDs/evidence per entity/rule; do not count repeated patterns as separate vulnerability findings. Distinct scoped/context observations remain labelled, and context code does not get included as first-party review size.

**Verify:** `pnpm exec vitest run test/unit/indicators.test.ts -t 'classification and prompts'` → 0; shuffled input yields identical output and no unavailable field silently becomes absent/low risk.

### Step 4: Freeze limitations and prevent numeric coupling

Document catalog definitions, confidence meaning, manual-only categories and LCOV provenance in `docs/indicators.md`. Tests ensure adding test/coverage/proxy/onlyOwner/name-only signals cannot alter the later numeric estimate input's measured code/graph facts. Export classifier only; no parser/CLI/estimation imports inside pure rules. Builtin confirmation consumes 008 status; candidate member names stay heuristic.

**Verify:** indicator/readiness suites, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm build`, `pnpm schemas:check` → 0; module-boundary assertions confirm classification does not calculate effort.

## Test plan

Follow 007's tiny independent fixtures and add custom call/owner/upgrade/hash name decoys, resolved known inheritance, ambiguous aliases, assembly/Yul, mappings/structs, external interface call candidates and absent dependencies. Test LCOV provenance with current and unrelated paths without claiming accuracy. Include readonly/determinism assertions and mandatory human prompts.

## Done criteria

- [ ] Indicator/readiness/full suites and all standards/schema gates exit 0.
- [ ] Every rule labels evidence kind, confidence and limitation; heuristic decoys covered.
- [ ] Tests/coverage are observed without execution and cannot grant automatic trust/discounts.
- [ ] Human assessment remains unassessed unless explicit operator input exists.
- [ ] No vulnerability/pricing/numerical model logic or outside-scope edit; status 009 updated.

## STOP conditions

Stop if a rule requires unverified compiler/runtime semantics, high-confidence classification depends only on names, coverage needs generation or outside-root reads, an indicator is being treated as vulnerability assurance or numeric validation, a schema change is required, or a gate fails twice. Omit an unsupported rule with documented limitation rather than regex-scan arbitrary source.

## Maintenance notes

Version rules independently of parser/model. Add counterexamples for every new recognizer. Keep historical rule evidence so calibration can distinguish changes in inference from changes in numeric weights. Advanced protocol analysis remains post-MVP.
