# Plan 004: Define predictable commands and data-only configuration

> **Executor instructions:** Implement command/config contracts only; analysis is connected in plan 013. Run every step gate. Update status 004 in `plans/README.md`. Do not make placeholder estimates or execute analyzed-project configuration.
>
> **Drift check first:** No SHA exists from the empty/non-Git planning baseline. Require 003 domain schemas and 001 scripts. If Git exists inspect `git status --short` and `git diff --stat -- src/cli src/config src/bin.ts test/unit/cli-options.test.ts test/integration/config.test.ts`. Stop on incompatible command/config implementations; prerequisite changes are expected.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED
- **Depends on:** `plans/003-domain-contracts-schemas.md`
- **Category:** direction / dx
- **Planned at:** no commit available; greenfield non-Git directory inspected 2026-10-14

## Why this matters

Scope mistakes can outweigh formula improvements. Strict configuration, observable precedence and predictable command errors make the tool reproducible in automation while preventing arbitrary project code execution.

## Current state and architectural context

No CLI/config existed during planning. Expected prerequisites: strict ESM tooling, `src/domain` schemas/diagnostics/canonical utilities, and a minimal help/version shim. Use Commander stable 15, exact version recorded at implementation; [upstream manifest](https://raw.githubusercontent.com/tj/commander.js/master/package.json) is ESM with Node 22.12+ floor. Command objects are local instances with injected trusted application handler and streams, not the global singleton. Keep argument parsing independent from calculation.

`resolveConfig` returns validated `ResolvedConfig` plus per-field provenance; it does not invoke analysis. Auto-load only `audit-estimator.config.json` directly under resolved root, capped at 256 KiB. Root is explicit `--root` or directory target or file parent. No upward/home search, JS/TS config, YAML, environment interpolation, dynamic import or schema fetch. A project config may affect scope/model/limits but cannot supply arbitrary executable names, module paths or network endpoints.

## Commands you will need

**Confirmed toolchain and test gates:** Node 24.11+ only (`>=24.11.0 <25`), pinned pnpm, TS7 no-emit typechecking, tsdown ESM bundling with external runtime dependencies and Oxc declarations, type-aware oxlint plus oxlint-tsgolint, and oxfmt. Source imports use `.ts` with ESNext/bundler resolution. Tests live outside `src` under `test/`. `pnpm test` runs only `test/unit` without building; `pnpm test:coverage` runs those units with V8 coverage without building. `pnpm test:integration` builds first, then runs integration/E2E/research suites; `pnpm test:all` runs both groups. Packed-artifact tests remain a separate build-first `pnpm test:package` command once plan 015 adds it. Before direct Vitest commands that invoke built CLI/worker artifacts, run `pnpm build`; never accept stale artifacts. All standards gates include non-mutating `pnpm lint` and `pnpm format:check`.

Proposed by prerequisites; none verified during planning.

| Purpose | Command | Expected |
|---|---|---|
| Options/help | `pnpm exec vitest run test/unit/cli-options.test.ts` | all flag/help/error assertions pass |
| Config | `pnpm exec vitest run test/integration/config.test.ts` | precedence/read/validation cases pass |
| Built help | `pnpm build` then `node dist/bin.js estimate --help` | 0, documented flags |
| Standards | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all` | 0 |
| Schema drift | `pnpm schemas:check` | 0 |

## Scope

**In scope:** `src/cli/{commands,options,exit-codes}.ts`, `src/config/{defaults,load,merge,validate}.ts`, `src/bin.ts`, `test/unit/cli-options.test.ts`, `test/integration/config.test.ts`, `test/fixtures/config/**`, `package.json`, `pnpm-lock.yaml`, `docs/dependencies.md`, `docs/adr/003-cli-config.md`, 004 status row.

**Out of scope:** discovery/parsing/model calculations/report formatters, target-project scripts or metadata execution, shell completion, interactive prompts, configuration writers, home settings, unrelated schemas. Fixing a schema mismatch requires a focused amendment to 003.

## Git workflow

Use supplied checkout; no observed conventions. No commits/pushes/branch changes/publication without operator instruction.

## Steps

### Step 1: Implement command and option parsing with injectable handlers

Expose `createProgram(handler, io)` and normalize into `CliRequest`; handlers accept estimate/inspect/explain. Path is required, exactly one positional input. Shared flags: repeatable `--include <glob>`, `--exclude <glob>`, `--root <path>`, `--config <file>`, `--no-config`, `--format <terminal|json|markdown>`, `--output <file>`, `--force`, `--solidity-version <exact>`, `--allow-partial`, `--strict`, `--no-color`; help/version available without analysis. Reject unknown options, surplus arguments, invalid format, `--config` with `--no-config`, and force without output. Long flags and documented repeatability avoid ambiguous comma-list parsing. No broad `--ignore-errors` or network options.

Commander owns syntax/help; override exit/output behavior for testing. Use explicit option-source detection so parser defaults do not overwrite config. The default format is terminal when no config/flag specifies otherwise. `explain` sets breakdown presentation; it shares the same eventual estimate handler. Until 013, attempts to analyze return a clear internal unavailable-handler diagnostic/exit 1 rather than fake success; unit tests use injected handlers.

**Verify:** `pnpm exec vitest run test/unit/cli-options.test.ts -t 'commands'` → 0; `pnpm build` and `node dist/bin.js inspect --help` → 0, no target reads.

### Step 2: Load bounded JSON and normalize path ownership

Implement safe read of operator-selected config using open/fstat/bounded read/close, UTF-8 validation and a 256 KiB cap; reject file symlinks for auto-config, explicit config symlink paths require an explicit documented operator read policy confined to their resolved file, never recursively load includes. Do not echo config contents in errors. Reject prototype-like object keys and unknown schema fields. Resolve file-config relative paths against config directory, ensure all source/import/coverage paths ultimately fall inside root; CLI root/config/output paths resolve from cwd. Explicit config may be outside root, but it does not authorize outside-root sources. A relative glob is always root-relative POSIX syntax, never a filesystem path.

**Verify:** `pnpm exec vitest run test/integration/config.test.ts -t 'safe load'` → 0; oversized/malformed/encoding/path cases produce CONFIG_INVALID without logging source content; missing explicit config fails, absent automatic config is allowed.

### Step 3: Apply deterministic precedence and provenance

Defaults → supplied project metadata hints → file config → explicitly present CLI options. This loader accepts metadata as plain validated input; plan 005 reads Foundry metadata later. Scalars replace; arrays replace at each layer (CLI repeat flags create replacement lists); objects merge only recognized fields, never generic recursive assignment. Default exclusions live separately and remain enabled unless `scope.defaultExcludes=false`. Config includes can select files outside detected source roots, but do not override exclusions/safety/ownership. `firstPartyOverrides` is the deliberate ownership promotion mechanism; record which rule applied.

Define baseline limits: file 2 MiB, total source 64 MiB, files 2,000 including context, filesystem entries 100,000, directory depth 64, imports 20,000, graph edges 100,000, AST nodes/file 200,000, AST nodes/session 2,000,000, patterns/list 64 and pattern length 512, metadata/config 256 KiB, LCOV 4 MiB, per-file parse deadline 2,000 ms, semantic component 128 files/8 MiB, semantic job deadline 10,000 ms, whole analysis deadline 120,000 ms. Expose limits in JSON, allow validated operator config overrides within documented finite ceilings (at most 10× defaults; duration ceilings 600,000 ms). Limits are operational safeguards, not accuracy coefficients. No infinite/negative limits.

Add `maxGlobStates=10,000,000` as the total per-run path-glob dynamic-programming state budget (005), with the same at-most-10× override ceiling. Patterns use only literal segments, standalone `**`, `?`, and at most one `*` within each non-globstar segment; unsupported multiple-star segments fail validation. These constraints bound matching work rather than relying on a Promise timeout around synchronous regular expressions.

**Verify:** `pnpm exec vitest run test/integration/config.test.ts -t 'precedence'` → 0; absent CLI leaves config intact, arrays replace, false/zero values preserve semantics, provenance and semantic hash match the selected settings.

### Step 4: Freeze exit mapping and noninteractive stream conventions

Define constants 0 complete, 1 internal defect, 2 usage/config, 3 invalid/unreadable target or empty scope, 4 partial/unsupported/limited/strict-warning analysis, 5 output failure, 130 interruption. Signal/format/output behavior is implemented in 013; test pure mapping here. `allowPartial` never maps an incomplete analysis to 0; `strict` means any warning promotes 4, and informational diagnostics do not. Known errors carry stable diagnostics; unexpected errors preserve a cause internally but public summaries omit stack/source/absolute paths. No process.exit in reusable command code; entry shim sets exitCode.

**Verify:** `pnpm exec vitest run test/unit/cli-options.test.ts -t 'exit policy'` → 0; then config/command suites, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:all`, `pnpm schemas:check` → 0.

## Test plan

Use Vitest patterns from 001/003, temporary directories with cleanup, isolated cwd input and injected streams. Cover file/directory root choice; config conflict flags; duplicate flags; malformed/oversized config; unsupported versions; null/unknown fields; source-root escape; override replacement; no parent config search; no project JS execution; no sources in error messages. Include a project config marker that would throw if imported and assert it remains untouched.

## Done criteria

- [ ] Both focused suites, full tests, standards, help and schema checks exit 0.
- [ ] Command options and validation match the specified UX; invalid inputs map to 2.
- [ ] Every effective semantic option has deterministic provenance; script/config execution never occurs.
- [ ] Limits and precedence ADR exists; no fabricated analysis result.
- [ ] Changed files are in scope and status 004 updated.

## STOP conditions

Stop if commands require interactive prompts or executable configuration, safe root semantics conflict with existing contracts, a library version forces unsupported Node, schema changes are required, metadata cannot be separated from I/O, or a gate fails twice. Do not silently search parent projects to make a test pass.

## Maintenance notes

Treat flag/default/merge changes as observable API changes and update help/docs/tests together. Keep operational limits distinct from estimation parameters. New config formats or environment support need an explicit safety and reproducibility decision.
