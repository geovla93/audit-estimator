# Plan 013: Connect local analysis, estimation and CLI output end to end

> **Executor instructions:** Wire the completed modules without inventing substitute metrics or estimates. Run every gate and update status 013 in `plans/README.md`. No target-project execution or network access is authorized.
>
> **Drift check first:** Reconciled at `9b0bfe7` on 2026-10-15. Run `git status --short`, `git diff --stat 9b0bfe7..HEAD -- src/application src/cli src/config src/discovery src/parser src/domain src/estimation src/reporting src/bin.ts src/index.ts`, and `git diff HEAD -- src/application src/cli src/config src/discovery src/parser src/domain src/estimation src/reporting src/bin.ts src/index.ts` (plus inspect untracked in-scope files). Check prerequisite statuses and the current-state snapshot below. Expected completed-prerequisite additions require inspection; contradictory contracts or unrelated local edits require reconciliation before implementation.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** HIGH (phase completeness and exit/output correctness)
- **Depends on:** `plans/004-cli-configuration.md`, `plans/005-safe-source-discovery.md`, `plans/006-parser-adapter-isolation.md`, `plans/007-source-structural-metrics.md`, `plans/008-imports-inheritance-interactions.md`, `plans/009-effort-indicators.md`, `plans/011-estimation-engine.md`, `plans/012-terminal-json-markdown-reports.md`
- **Category:** direction / correctness
- **Planned at:** commit `9b0bfe7`, reconciled 2026-10-15; originally greenfield planning on 2026-10-14.

## Why this matters

Individually correct modules can still produce a misleading estimate if phase failures disappear or stdout becomes non-JSON. The application layer owns completeness and cancellation; CLI owns process/streams and safe requested output writes.

## Current state and architectural context

### Reconciled implementation baseline — 2026-10-15

`src/application/` and report/output modules are absent. `src/cli/commands.ts` already implements `createProgram`, `runCli` and `createUnavailableHandler`; `src/bin.ts` awaits that `runCli` and sets exitCode. Extend/delegate the existing runner rather than defining two unrelated dispatchers. `CliRequest` in `src/cli/options.ts` already includes canonical CLI option names, `breakdown`, `noConfig` and stream/cwd injection via `CliIo`.

`resolveConfig` already returns `{config, semanticHash, root, configFileLoaded}` and requires a trusted full model default; load the production profile from 011, never the test-only values in config tests. Metadata I/O belongs to 005; the loader consumes validated hints. Keep original lexical target information until discovery enforces the default symlink policy. Carry config version provenance into parser selection so a default or metadata version is not mistaken for an explicit override.

`EstimateInput` embeds `model`/`manualAdjustments`; it has no per-file syntax flag or endpoint-to-file membership. The application must filter eligibility and pairs using its analysis map, preserve omitted IDs in `analysis.completeness`, then invoke the single-input nullable API defined in refreshed 011. Inspect bypasses calculation.

`ReportEnvelope` has no top-level resolved-config/provenance or expanded discovery fields. Preserve effective parameters in `estimate.parameters`, semantic hash in `fingerprints.semanticConfig`, and bounded human-readable assumptions/provenance/scope observations in existing diagnostics/limitations (details are arrays of at most 32 scalar key/value items). Do not add unsupported envelope keys or serialize native root/config paths. If the required structured full configuration/provenance cannot be represented faithfully, STOP for a focused schema amendment before claiming that acceptance item complete. This narrows the mapping instructions below to the existing public contract; it does not authorize silent loss of observations. All analysis/renderer/engine prerequisites are still TODO.

Match established strict ESM conventions: `.ts` source imports, explicit named exports and exported annotations, `import type`, readonly DTOs, no `any` or suppressions, unknown caught values narrowed before use. Tests use Vitest source imports for units and the trusted build-first integration wrapper for artifact suites. These current facts supersede prospective wording in the original context below.

### Original design context (retained)

No working feature existed at planning. Expected prerequisites supply command requests/config, bounded discovery/snapshots, parser worker, measured metrics/relationships, indicators, pure estimator and formatters. Implement `analyzeProject` without terminal dependency and expose it from `src/index.ts` without import-time I/O. Resolve safe reads and semantic options before analysis; keep application option type separate from raw CLI values. Layer flow: config → discovery → parse/import closure → metrics/graph → indicators/readiness → optional estimate → versioned envelope.

Inspect never calculates effort. Explain is the same estimate with detailed rendering. JSON schema `1.0.0` envelopes are used for complete/partial/error. Exit 0 complete, 1 internal defect, 2 usage/config, 3 bad target/empty scope, 4 partial/unsupported/limit/strict warnings, 5 output failure, 130 SIGINT. Ordinary warning without strict can remain 0; documented dynamic dispatch uncertainty is not itself a parse error, but may widen high scenario. Missing required context, unsupported selected source or failed semantic component marks partial; full-scope estimate is null unless analysis is complete. `--allow-partial` permits a subset/scoped-syntax estimate but keeps exit 4 and `fullScopeEstimate=null`.

## Commands you will need

**Reconciliation gate note (2026-10-15):** Scripts below exist for typecheck, lint, format-check, source units, build-first integration/all, coverage and schema checks; feature-specific suites and later scripts exist only when their owning plans land. Current main-checkout checks are not green: missing installed Commander/Zod/Slang block typecheck, lint and domain/CLI unit collection. The bootstrap source unit passes (1 test); the other two unit suites fail collection. `pnpm format:check` fails on the same four unchanged `.agents/skills/improve` Markdown files recorded in prior approvals. No new format exception is granted: preserve the exact inherited exception and verify changed artifacts, or arrange a separately scoped fix; any additional failure is a STOP condition.

An executor must first run `pnpm install --frozen-lockfile` in its authorized implementation checkout and obtain success. This reconcile run did not install dependencies. Pnpm 11 attempted automatic installation before scripts and aborted removal of node_modules due to no TTY; do not set CI or approve purge merely to bypass it. With dependencies correctly installed, `pnpm --config.verifyDepsBeforeRun=false run <script>` can run an existing script without implicit dependency reconciliation; it does not repair missing packages. Do not claim schema/build/integration/coverage/frozen-install verification from this reconciliation: those gates were not rerun. Run the prescribed fresh build before any built-artifact test in implementation.

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Proposed prerequisite commands; none verified during recon.

| Purpose | Command | Expected |
|---|---|---|
| Application | `pnpm build` then `pnpm exec vitest run test/integration/application.test.ts` | phase/completeness/cancel cases pass |
| Built CLI | `pnpm exec vitest run test/e2e/cli.test.ts` | all three commands/streams/exits pass |
| Manual success | `node dist/bin.js estimate test/fixtures/e2e/simple --format json --no-config` | 0, exactly one schema-valid JSON envelope |
| Explain | `node dist/bin.js explain test/fixtures/e2e/simple --no-color --no-config` | 0, scope/model/ledger details |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm schemas:check` | 0 |

## Scope

**In scope:** `src/application/{analyze,completeness,fingerprints}.ts`, `src/cli/{run,output,errors,commands}.ts` (handler wiring), `src/bin.ts`, `src/index.ts` (analysis export), `test/integration/application.test.ts`, `test/e2e/cli.test.ts`, `test/helpers/run-cli.ts`, `test/fixtures/e2e/**`, `test/fixtures/manifest.json`, 013 status row.

**Out of scope:** formula/metric/schema changes, remote fetching, project commands/tests/compilers, telemetry, progress UI libraries, publishing, implicit config/output writes, automatic source modifications.

## Git workflow

Use supplied checkout. No commits/pushes/publication or branch changes without operator instruction.

## Steps

### Step 1: Orchestrate phases with explicit completeness and one global budget

Implement `analyzeProject(request,{signal})` resolving config/metadata through existing loaders, discovering snapshots, iteratively parsing/resolving context, measuring unique scope, producing graph/indicators/coverage and building fingerprints. Pass one mutable internal resource-budget object across phases, expose immutable final counts; don't reset byte/file/node limits at each phase. Cancellation reaches safe reads and worker disposal. Cache per-run parsed identity only; no persistent cache.

Completeness tracks selected files, valid parsed files, omitted files/reasons, import closure and semantic-component coverage. An invalid scoped file is never billed with recovered AST metrics. Normal estimation requires complete required scope/context analysis; partial mode restricts eligible files/pairs, marks analyzed subset and still shows every omitted/context limitation. Pure estimator receives explicit completeness/allow-partial input; application doesn't bypass its checks. Capability-normal unknown calls can remain complete with high-only uncertainty reserve; failed required graph work is partial. No-source/all-comment scope maps to EMPTY_SCOPE. Inspect returns best available analysis even on partial status, with exit 4.

**Verify:** `pnpm build` and `pnpm exec vitest run test/integration/application.test.ts -t 'phases and completeness'` → 0; complete/incomplete/context-missing/binding-limit/inspect/partial cases obey schema and effort coverage.

### Step 2: Compute stable provenance and expose library entry

Sources fingerprint includes sorted scoped/context IDs, byte hashes, roles/ownership, parser grammar/version and relevant metadata/remappings; semantic config hash excludes output destination/format/color. Analysis fingerprint includes component versions and canonical evidence, not wall time, absolute root/cwd or subprocess IDs. Return full effective config/model assumptions/provenance in schema-defined fields. Ensure relocating an identical project preserves public output when logical paths/options are identical. Changing format alone does not change effort/analysis hash.

**Verify:** `pnpm exec vitest run test/integration/application.test.ts -t 'determinism and api'` → 0 for repeated/relocated/shuffled projects and silent built library import; `pnpm typecheck` → 0.

### Step 3: Implement stream, exit and expected-error behavior

Replace unavailable handler in 004 with the application. Reusable `runCli(argv,io)` returns exit code; shim sets process.exitCode, never abruptly terminates output. Format detection for a usage error must honor an explicitly valid `--format json` even if Commander rejects another option; conflicting/invalid format itself uses a documented terminal usage error. JSON mode stdout contains exactly one envelope plus LF, diagnostics stderr only, no ANSI/progress. With successful `--output`, report body goes to requested file and stdout is empty; stderr may describe saved destination. On output failure, emit error envelope to stdout in JSON mode and exit 5. Ordinary analysis partial returns data/error envelope as applicable and 4. `--strict` warns →4; no fake success from `allowPartial`. SIGINT cancels/closes worker and maps130; broken pipe handled cleanly without noisy internal stack.

**Verify:** `pnpm exec vitest run test/e2e/cli.test.ts -t 'commands and streams'` → 0 for terminal/json/Markdown/inspect/explain/help/version/config-error/no-files/partial/strict/output-error/interrupt cases; schema validates JSON errors.

### Step 4: Write only operator-requested reports safely

Render/validate the whole bounded report before writing. Resolve output relative to cwd; don't create parent directories implicitly. Refuse selected/context source identities, any `.sol` destination, input metadata/config paths, symlink/special-file destinations and missing parents. Default no-overwrite uses exclusive create (`wx`), not exists-then-write; `--force` permits replacing a verified regular report file only, preserving source/config guards. Use open/fstat/no-follow where available, compare identity before truncation and cleanup on failures. Ensure partial writes on newly created files are removed by identity-checked cleanup; never unlink a preexisting file on error. Document mutable-filesystem race limitation consistently with discovery. Avoid pretending cross-platform rename provides atomic no-clobber everywhere.

**Verify:** `pnpm exec vitest run test/e2e/cli.test.ts -t 'output safety and cancellation'` → 0 for existing/default/force/symlink/source/hardlink/unwritable/write-failure/cleanup cases; application/full/type/lint/schema gates → 0; manual JSON/explain commands in table pass.

## Test plan

Use real built Node child CLI with `shell:false`, fixed environment/cwd and timeout; no shell redirection for assertions. Fixture includes simple project, malformed second source, excluded first-party base, missing third-party dependency, duplicate files, custom roots and coverage. Assert stderr/stdout/code separately, schema and named ledger values, report-file contents and untouched target scripts/sources. Cancellation test uses trusted test hooks/stalled worker, not timing-dependent pathological Solidity.

## Done criteria

- [ ] Application/CLI/full suites, standards/schema and documented manual success commands pass.
- [ ] All commands analyze real local fixtures; inspect has null effort, explain matches estimate values.
- [ ] Expected errors and partial outputs use correct schemas/exits; stdout is machine-clean.
- [ ] Relocation/repeat output stable; cancellation disposes workers; source/config outputs blocked.
- [ ] No runtime network/project execution or outside-scope edits; status 013 updated.

## STOP conditions

Stop if phases require inconsistent DTO/schema changes, selected-source failures disappear, full-scope estimates need fabricated metrics, deterministic results include machine paths/time, output needs unsafe source overwrite, subprocess cancellation leaks, or a gate fails twice. Fix contracts through a focused amendment rather than bundling unplanned refactors.

## Maintenance notes

The application is the integration boundary: new sources/engines preserve cancellation/completeness/fingerprints. Exit codes and stdout behavior are public CLI contracts. Output writing remains separate from pure serializers and never becomes an implicit analysis side effect.
