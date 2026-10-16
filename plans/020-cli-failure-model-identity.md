# Plan 020: Preserve the selected model version in CLI failure envelopes

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report. Do not improvise. When done, update the status row for this plan in `plans/README.md`, unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat d68d466..HEAD -- src/cli/run.ts src/application/envelope.ts test/e2e/cli.test.ts test/integration/cli-run.test.ts`
> If any listed file changed since this plan was written, compare the "Current state" excerpts below against the live code before proceeding. On a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none. Independent of plans 018 and 019.
- **Category**: bug (report metadata correctness / compatibility)
- **Planned at**: commit `d68d466`, 2026-10-16, branch `estimation_scope`

## Why this matters

The estimator supports two model versions: the default `1.1.0` and the frozen legacy `1.0.0`, selected through configuration (`{"configVersion":"1.0.0","model":{"profile":"heuristic-v1","modelVersion":"1.0.0"}}`). Every report envelope records the effective model in `versions.model`, which is reproducibility metadata. When the CLI replaces a produced report with an error envelope (the output file cannot be written, or the report cannot be rendered), it rebuilds the identity **without** the model. The builder then substitutes the default. A `1.0.0` run that hits an output failure therefore emits an `OUTPUT_FAILED` JSON envelope that claims model `1.1.0`. Successful estimates and output-file protection are unaffected. The fix carries `envelope.versions.model` into both replacement envelopes.

## Current state

Files involved:

- `src/cli/run.ts`: the CLI analysis handler. It renders the envelope and writes it to stdout or `--output`. Contains both buggy sites. The only production file this plan changes.
- `src/application/envelope.ts`: `EnvelopeIdentity`, `buildErrorEnvelope` and `versionsFor`. Read only.
- `test/e2e/cli.test.ts`: built-CLI end-to-end tests (spawns `dist` binary). One new test goes here.
- `test/integration/cli-run.test.ts`: **create**. An in-process handler test for the render-failure path.

### The builder falls back to the default model (`src/application/envelope.ts`)

Lines 63-69 and 81-88:

```ts
export interface EnvelopeIdentity {
  readonly command: ReportEnvelope['command'];
  readonly parser: string;
  /** Null until configuration resolves. */
  readonly semanticConfig: string | null;
  /** Effective model version once configuration resolves; the default before that. */
  readonly model?: string | undefined;
}
...
function versionsFor(parser: string, model: string | undefined): ReportEnvelope['versions'] {
  return {
    parser,
    metrics: METRICS_VERSION,
    indicators: INDICATORS_VERSION,
    model: model ?? MODEL_VERSION,
  };
}
```

`buildErrorEnvelope` (line 151) uses `versions: versionsFor(input.identity.parser, input.identity.model)`. The application layer (`src/application/analyze.ts`) already passes the effective model, and the integration test `labels inspect and post-configuration errors with the selected model` (`test/integration/estimation-scope.test.ts:505`) proves it. Only the CLI drops the model.

### Site 1, render failure (`src/cli/run.ts:68-83`)

```ts
    let envelope = analyzed.envelope;
    let body: string;
    try {
      body = render(envelope, format, request.breakdown, color);
    } catch {
      const failed = buildErrorEnvelope({
        identity: {
          command: envelope.command,
          parser: envelope.versions.parser,
          semanticConfig: envelope.fingerprints.semanticConfig,
        },
        category: 'internal',
        diagnostics: [
          fixedDiagnostic('INTERNAL_ERROR', 'error', 'report', 'The report could not be rendered.'),
        ],
      });
      writeDiagnostics(io, failed.diagnostics);
      try {
        io.stdout.write(render(failed, format === 'json' ? 'json' : 'terminal', false, false));
      } catch {
```

### Site 2, output failure (`src/cli/run.ts:108-124`)

```ts
      } catch (error: unknown) {
        if (!(error instanceof OutputError)) throw error;
        const failure = fixedDiagnostic('OUTPUT_FAILED', 'error', 'report',
          'The report file could not be written.');
        envelope = buildErrorEnvelope({
          identity: {
            command: envelope.command,
            parser: envelope.versions.parser,
            semanticConfig: envelope.fingerprints.semanticConfig,
          },
          category: 'output',
          diagnostics: [failure],
        });
        outcome = 'failure';
        if (format === 'json') {
          io.stdout.write(serializeJson(envelope));
```

`run.ts` currently imports `buildErrorEnvelope, fixedDiagnostic` from `'../application/envelope.ts'` (line 3) and `type { Diagnostic, ReportEnvelope }` from `'../domain/types.ts'` (line 4).

### Existing test patterns to reuse

- `test/e2e/cli.test.ts:477-497`, `refuses an existing file without --force ...`: copies the `simple` fixture (`test/fixtures/e2e/simple/{package.json,src/Vault.sol}`) with `withCopy`, writes an existing `report.json`, runs `runCli(['estimate', root, '--format', 'json', '--output', out])`, and expects `status` `5` and `parseEnvelope(refused.stdout).failureCategory === 'output'`.
- `test/integration/estimation-scope.test.ts:15-41`: the `vi.hoisted` hooks plus `vi.mock(path, async (importOriginal) => ...)` pattern for making one module function throw on demand. Copy that pattern for the renderer.
- `CliIo` (`src/cli/options.ts:25-30`): `{ stdout: { write(chunk: string): unknown; isTTY?: boolean }, stderr: { write(chunk: string): unknown }, cwd?: string, signal?: AbortSignal }`.
- `CliRequest` (`src/cli/options.ts:7-23`): required fields are `command`, `input`, `noConfig`, `force`, `allowPartial`, `strict`, `noColor` and `breakdown`. Optional ones include `configPath`, `format` and `output`.
- `EXIT_CODES` (`src/cli/exit-codes.ts:3-11`): `internal: 1`, `output: 5`.

## Commands you will need

If a plain `pnpm <script>` tries to install dependencies, prefix it as `pnpm --config.verifyDepsBeforeRun=false <script>`.

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Format check | `pnpm format:check` | exit 0 |
| Targeted e2e (builds first) | `pnpm test:integration test/e2e/cli.test.ts` | all pass |
| Targeted handler test (builds first) | `pnpm test:integration test/integration/cli-run.test.ts` | all pass |
| Full local gate | `pnpm check` | exit 0 |

## Scope

**In scope** (the only files you should modify):

- `src/cli/run.ts`
- `test/e2e/cli.test.ts`: add one test inside `describe('output safety and cancellation', ...)`.
- `test/integration/cli-run.test.ts`: create.
- `plans/README.md`: status row only.

**Out of scope** (do NOT touch):

- `src/application/envelope.ts`: the default-before-configuration fallback is correct and documented. Do not make `model` required.
- `src/application/analyze.ts`: already passes the effective model.
- Exit codes, diagnostic messages, stdout/stderr routing and output-file protection in `run.ts`: behavior must stay identical apart from `versions.model`.
- `docs/**`: no documentation states the buggy behavior.

## Git workflow

- Branch: `advisor/020-cli-failure-model-identity`, from `estimation_scope`.
- Conventional commits, e.g. `fix: keep the effective model version in CLI failure envelopes`.
- Do NOT push, merge or open a PR unless instructed.

## Steps

### Step 1: Add the failing built-CLI regression

In `test/e2e/cli.test.ts`, inside `describe('output safety and cancellation', ...)`, directly after the test `refuses an existing file without --force and replaces a regular report with it`, add:

```ts
  it('keeps the selected legacy model in an output-failure envelope', async () => {
    await withCopy('simple', async (root) => {
      const config = join(root, 'legacy.json');
      await writeFile(
        config,
        JSON.stringify({
          configVersion: '1.0.0',
          model: { profile: 'heuristic-v1', modelVersion: '1.0.0' },
        }),
      );
      const out = join(root, 'report.json');
      await writeFile(out, 'original');
      const legacy = await runCli([
        'estimate', root, '--format', 'json', '--output', out, '--config', config,
      ]);
      expect(legacy.status).toBe(5);
      const envelope = parseEnvelope(legacy.stdout);
      expect(envelope.failureCategory).toBe('output');
      expect(envelope.versions.model).toBe('1.0.0');
      expect(await readFile(out, 'utf8')).toBe('original');
      // Control: without the legacy configuration the default model is reported.
      const current = await runCli(['estimate', root, '--format', 'json', '--output', out]);
      expect(current.status).toBe(5);
      expect(parseEnvelope(current.stdout).versions.model).toBe('1.1.0');
    });
  });
```

`writeFile`, `readFile`, `join`, `withCopy`, `runCli` and `parseEnvelope` are already imported or defined in this file. Let `pnpm format:check` decide the argument-array formatting.

**Verify**: `pnpm test:integration test/e2e/cli.test.ts` → the new test FAILS on `expect(envelope.versions.model).toBe('1.0.0')` (received `'1.1.0'`). All other tests in the file pass. If it fails earlier (e.g. `status` is not 5, or the legacy config is rejected), STOP and report the actual output.

### Step 2: Add the failing in-process render-failure regression

Create `test/integration/cli-run.test.ts`. It drives `createAnalysisHandler` in-process and makes the JSON serializer throw **once**, so the handler takes the render-failure branch. The second serializer call (rendering the replacement envelope) then runs normally, which makes the replacement observable on stdout.

Structure:

```ts
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAnalysisHandler } from '../../src/cli/run.ts';
import { EXIT_CODES } from '../../src/cli/exit-codes.ts';
import type { CliRequest } from '../../src/cli/options.ts';
import { ReportEnvelopeSchema } from '../../src/domain/schemas.ts';
import { createProject, removeProject, writeProjectFile } from '../helpers/filesystem.ts';

const hooks = vi.hoisted(() => ({ failNextRender: false }));

vi.mock('../../src/reporting/json.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/reporting/json.ts')>();
  return {
    ...actual,
    serializeJson: (...args: Parameters<typeof actual.serializeJson>) => {
      if (hooks.failNextRender) {
        hooks.failNextRender = false;
        throw new Error('render failure for test');
      }
      return actual.serializeJson(...args);
    },
  };
});
```

Then one test, `it('keeps the selected model when the report cannot be rendered', ...)`:

- Create a project with `createProject('audit-estimator-cli-run-')`. Write `src/A.sol` with a tiny original contract (e.g. `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract A {\n    uint256 public x;\n}\n`) and `legacy.json` with the same legacy config as Step 1, using `writeProjectFile(root, path, contents)`. Remove the project in `finally` with `removeProject(root)`. Check the helper signatures in `test/helpers/filesystem.ts` first; `test/integration/estimation-scope.test.ts:86-99` shows their use.
- Collect output: `let stdout = ''; let stderr = '';` and an `io` object whose `stdout.write` / `stderr.write` append to those strings, with `cwd: root`.
- Build a full `CliRequest`: `{ command: 'estimate', input: root, configPath: join(root, 'legacy.json'), noConfig: false, format: 'json', force: false, allowPartial: false, strict: false, noColor: true, breakdown: false }`.
- Set `hooks.failNextRender = true`, then `const code = await createAnalysisHandler(io)(request);`.
- Assert `code === EXIT_CODES.internal`, `stderr` contains `'INTERNAL_ERROR'`, and `const envelope = ReportEnvelopeSchema.parse(JSON.parse(stdout) as unknown)` has `status === 'error'`, `failureCategory === 'internal'` and `versions.model === '1.0.0'`.
- Reset `hooks.failNextRender = false` in `finally`.

Before relying on the `vi.mock` path, confirm that `run.ts`'s `render` imports `serializeJson` from `'../reporting/json.ts'` (line 5 at planning time). Vitest resolves both specifiers to the same module.

**Verify**: `pnpm test:integration test/integration/cli-run.test.ts` → the test FAILS on `versions.model` (received `'1.1.0'`), and its other assertions pass. If the handler does not reach the render-failure branch (e.g. exit code 0), STOP and report. Do not restructure `run.ts` to make it testable.

### Step 3: Carry the effective model at both replacement sites

In `src/cli/run.ts`, add a module-private helper above `createAnalysisHandler`, and import the `EnvelopeIdentity` type:

```ts
import type { EnvelopeIdentity } from '../application/envelope.ts';
...
/** Identity for an envelope that replaces a produced report; keeps its effective model. */
function replacementIdentity(envelope: ReportEnvelope): EnvelopeIdentity {
  return {
    command: envelope.command,
    parser: envelope.versions.parser,
    semanticConfig: envelope.fingerprints.semanticConfig,
    model: envelope.versions.model,
  };
}
```

Merge the type import into the existing `'../application/envelope.ts'` import if lint/format prefers that (`import { buildErrorEnvelope, fixedDiagnostic } from ...` plus a separate `import type { EnvelopeIdentity } from ...` matches the repo's `import type` rule).

Replace **both** inline `identity: { command: ..., parser: ..., semanticConfig: ... }` objects (site 1 and site 2) with `identity: replacementIdentity(envelope)`. Do not change anything else in either branch.

Do not export `replacementIdentity`.

**Verify**: `pnpm typecheck` → exit 0. `pnpm lint` → exit 0. `grep -c "replacementIdentity(envelope)" src/cli/run.ts` → `2`. `grep -n "semanticConfig: envelope.fingerprints.semanticConfig" src/cli/run.ts` → exactly one line (inside the helper).

### Step 4: Confirm both regressions pass and nothing else moved

**Verify**:

- `pnpm test:integration test/e2e/cli.test.ts` → all pass, including the new legacy-model test.
- `pnpm test:integration test/integration/cli-run.test.ts` → passes.
- `pnpm format:check` → exit 0
- `pnpm check` → exit 0
- `git status --short` → only `src/cli/run.ts`, `test/e2e/cli.test.ts`, `test/integration/cli-run.test.ts` and `plans/README.md`.

## Test plan

- `test/e2e/cli.test.ts`: the legacy-config output failure reports `versions.model: '1.0.0'`, exit 5, and leaves the destination untouched. The default-config control reports `'1.1.0'`.
- `test/integration/cli-run.test.ts` (new): an in-process render failure under the legacy config reports `versions.model: '1.0.0'`, exit `EXIT_CODES.internal`, and `INTERNAL_ERROR` on stderr.
- Patterns: `test/e2e/cli.test.ts:477-497` and the hook/mock pattern in `test/integration/estimation-scope.test.ts:15-41`.

## Done criteria

- [ ] `pnpm check` exits 0
- [ ] `grep -c "replacementIdentity(envelope)" src/cli/run.ts` prints `2`
- [ ] `grep -n "model: envelope.versions.model" src/cli/run.ts` → one line
- [ ] `git diff d68d466 -- src/application/` is empty
- [ ] The new e2e and integration tests exist and pass
- [ ] Only in-scope files modified (`git status --short`)
- [ ] `plans/README.md` row 020 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Live code differs from the "Current state" excerpts.
- The legacy config is rejected by the CLI (exit 2) in Step 1, meaning the legacy selection syntax has changed.
- Either new test passes before Step 3, meaning the bug was fixed elsewhere.
- The mock in Step 2 cannot intercept `serializeJson` from `run.ts`. In that case, drop the in-process test, keep the e2e test, and report it. Do not refactor `run.ts` for testability.
- The fix appears to require changing `src/application/envelope.ts` or `analyze.ts`.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Any future CLI path that replaces an envelope (new output formats, streaming, retries) must use `replacementIdentity(envelope)` so it keeps the parser, semantic-config fingerprint and model identity.
- If `EnvelopeIdentity` gains fields (e.g. a catalog version), extend `replacementIdentity` in the same change.
- Plan 017's execution record lists this `OUTPUT_FAILED` model mislabel as an accepted follow-up. Mark it resolved when this plan lands.
