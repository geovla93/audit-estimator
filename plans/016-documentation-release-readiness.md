# Plan 016: Document the implemented product and record release readiness evidence

> **Executor instructions:** Follow the steps and verification gates below. Document actual behavior and test the exact published examples. Change only the listed files. Update only row 016 in `plans/README.md`; implementation preparation and permission to publish are separate. Preserve unrelated working-tree edits.
>
> **Drift check first:** Reviewed at `a42129f` on 2026-10-16. Run `git status --short`, then `git diff --stat a42129f..HEAD -- README.md CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md LICENSE AGENTS.md docs examples scripts/check-docs.mjs scripts/check.mjs package.json test/e2e/documentation.test.ts plans/README.md` and the equivalent `git diff HEAD -- <same paths>`. Inspect untracked in-scope paths too. Compare changed contracts with the excerpts below. Expected 015 additions must be inspected before starting; contradictory contracts or overlapping local edits require reconciliation. Never discard pre-existing plan edits.

## Status

- **Priority:** P1
- **Effort:** L (public documentation, executable examples, checker and readiness evidence)
- **Risk:** MED (false release claims, example drift and verification orchestration)
- **Depends on:** `plans/015-packaging-ci-release.md`, with 013/014 implementation present
- **Category:** docs / direction
- **Planned at:** commit `a42129f`, reviewed 2026-10-16; supersedes the `5077f1f` reconciliation. Original planning: 2026-10-14.

## Why this matters

Auditors need to understand what was measured, which assumptions produced the range and what remains human judgment. Contributors need commands that run, and maintainers need evidence that distinguishes local preparation from permission and readiness to release. Tested documentation should expose drift rather than silently turning proposed behavior into promises.

## Current state and architectural context

### Verified by inspection at `a42129f`

Commits `4a2100e` (013 orchestration) and `a42129f` (014 quality) are in HEAD. The CLI now performs real local analysis. The index still contains historical unmerged/TODO statements; the commit graph and files supersede those statements. 015 is still absent: no `.github/`, `scripts/check.mjs`, package smoke suite, `docs/releasing.md`, `CHANGELOG.md`, `check` or `test:package` scripts. **Do not execute 016 until the reviewed 015 implementation is present.** Reviewing this plan does not mark 015 or 016 DONE.

Root `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `LICENSE` and `examples/` are absent. The package remains private `audit-estimator@0.1.0`, Node `>=24.11.0 <25`, pnpm `11.28.4`; `.node-version` is `24.21.0`. No approved public identity, license, reporting contact, registry publication or remote CI result is established by these facts. Existing fixture `MIT (proposed)` labels are provisional provenance, not an approved repository license grant.

Preserve five accepted ADRs, `docs/dependencies.md`, `docs/testing.md`, the Slang research report, metrics/relationships/indicators/output-schema docs, model specs and calibration protocol. ADR 002 has stale statements: types-only root exports, an engine syntax flag, and only index/bin build entries. Correct those summaries without changing the accepted architecture. Other existing docs may retain historical plan language; distinguish history from current user instructions.

### Load-bearing code and exemplar paths

`src/index.ts` exports `analyzeProject` and its request/options/outcome types, the pure estimator/model APIs, renderers, domain types and version constants. Discovery/parser/relationship/indicator internals are not public deep-import APIs. `src/bin.ts` connects the real handler:

```ts
// src/bin.ts: executable boundary (excerpt)
const io = { stdout: process.stdout, stderr: process.stderr, signal: controller.signal };
process.exitCode = await runCli(process.argv.slice(2), createAnalysisHandler(io), io);
```

`src/cli/commands.ts:configureOptions` and `createProgram` own the three commands, repeatable globs, help and version. `src/cli/options.ts` records provenance and sets breakdown for `explain`. `src/cli/exit-codes.ts` defines 0 complete, 1 internal, 2 usage/config, 3 target/empty scope, 4 incomplete/strict warning, 5 output failure, 130 interruption. `--allow-partial` retains exit 4; a strict warning may yield a complete envelope with exit 4. Never equate exit status mechanically with envelope status.

`src/domain/schemas.ts:configInputBody` fixes the config shape (excerpt):

```ts
configVersion: z.literal(CONFIG_SCHEMA_VERSION),
model: modelInput.optional(),
manualAdjustments: z.array(ManualAdjustmentSchema).max(1000).optional(),
report: z.strictObject({ format: z.enum(['json', 'markdown', 'terminal']) }).optional(),
```

The model object uses `profile`, optional `modelVersion`, and optional `parameters`; manual adjustments use the existing schema's signed hour ranges and nonempty reasons. Validate complete examples with the actual schemas rather than copying this abbreviated excerpt as JSON.

`test/e2e/cli.test.ts` is the example-test exemplar: `withCopy` copies fixtures to a temporary root, `runCli` comes from `test/helpers/run-cli.ts`, JSON is parsed as `unknown` through `ReportEnvelopeSchema`, and cleanup runs in `finally`. These helpers execute `process.execPath` with argument arrays, `shell:false`, separate streams and bounded timeouts. Reuse them without editing them. Use existing `createProject`/`removeProject` from `test/helpers/filesystem.ts`.

`scripts/generate-schemas.mjs` is the checker exemplar for loading internal schemas without exporting them: tsdown with `config:false`, `deps:{neverBundle:true}`, no declarations, into a unique ignored `.vitest/` directory, import via `pathToFileURL`, cleanup in `finally`. It validates generated schema bytes without rewriting committed schemas in check mode. Reuse that pattern for documentation validation; do not add a JSON Schema validator dependency or widen public exports.

`test/integration/bootstrap-cli.test.ts:22` fixes the current production inventory: `analyze.js`/`.map`, `bin.js`/`.map`, `index.d.ts`, `index.js`, `version-policy.js`/`.map`, `parser/worker.js`/`.map` (ten files). This supersedes the old eleven-file canonical/version inventory. 015 may have reviewed packaging changes; inspect its successor contract. This plan never changes production entries or weakens allowlists.

### Constraints and terminology

Match strict ESM: `.ts` source imports, explicit named exports and public annotations, `import type`, readonly DTOs, no `any`, no suppressions, caught values narrowed from `unknown`. Trusted tooling scripts follow existing `.mjs` conventions. Tests live outside `src`; unit tests import source without building. No new dependencies or compiler downloads.

Preserve ADR 003's config/glob/exit/output contracts and ADR 004's confinement limits. Preserve ADR 005's child isolation without claiming OS/RSS sandboxing. Relationship limitations include unproven internal dynamic dispatch, deferred user-defined storage refinement and potentially unavailable builtin confirmation. Indicators include eight supported rules and eight human prompts; coverage is supplied, unverified, matched-subset evidence, not proof of testing quality.

Use scoped/context, first-party/third-party/unknown, measured/heuristic/human-assessed, complete/analyzed-subset, cumulative auditor-hours and planning scenario range consistently. Model `heuristic-v1` is uncalibrated, not a statistical confidence interval. SLOC depends on source layout. Model, parser, metric, indicator and schema versions are independent. No vulnerability detection, assurance, calendar delivery, pricing or empirical accuracy claims. No network or target scripts/compiler/config execution during analysis or examples; trusted package installation and future registry publication are distinct operations.

## Review findings addressed by this revision

All findings are HIGH confidence from local inspection; these are plan defects, not new runtime bug claims. Effort and risk describe the plan correction.

| Finding | Evidence | Impact | Effort | Risk |
|---|---|---|---|---|
| Refresh prerequisite and artifact facts | `src/bin.ts`, `src/index.ts`, `test/integration/bootstrap-cli.test.ts:22`; previous plan's baseline | Obsolete unavailable-handler and eleven-file statements would block valid examples or overwrite approved contracts | S | LOW |
| Specify the checker and its failure tests | previous plan Steps 2–4 and Test plan; `scripts/generate-schemas.mjs` | A generic promise to check links/flags/schemas permits a vacuous checker and undocumented dependencies | M | LOW |
| Bind commands in prose to the executed examples | previous plan Step 1; `test/helpers/run-cli.ts` | Parallel hard-coded test commands can stay green while the quickstart breaks | S | LOW |
| Wire documentation into the full gate within scope | `package.json:scripts`; 015 Step 3; previous 016 scope | A new docs script could never run in CI, or require an out-of-scope edit to the checker orchestrator | S | LOW |
| Make readiness evidence and licensing states explicit | previous plan Step 4; provisional fixture labels; `docs/testing.md` | Free-form statuses and assumed licenses can produce unsupported public-release claims | S | LOW |

## Commands you will need

No runtime/tests were rerun during this plan review. Existing results in `docs/testing.md` and the index remain historical evidence, not newly verified gates. Node/pnpm versions above were read from configuration. All commands below are executor gates.

Use the pinned runtime/package manager; in an independent checkout obtain a successful `pnpm install --frozen-lockfile` first. Afterwards `pnpm --config.verifyDepsBeforeRun=false run <script>` uses installed tools without implicit reconciliation; it cannot repair missing packages. Never install dependencies in an example/target project.

| Purpose | Command | Expected |
|---|---|---|
| Source contracts | `pnpm typecheck`, `pnpm lint`, `pnpm format:check` | each exits 0; no mutation |
| Units | `pnpm test` | 0; no build |
| Documentation examples | `pnpm --config.verifyDepsBeforeRun=false run test:integration test/e2e/documentation.test.ts` | fresh build; named groups below pass |
| Checker and failure controls (new) | `pnpm docs:check`, `pnpm docs:check --self-test` | both 0; no committed-file writes or network |
| Full local gate (015) | `pnpm check` | existing gates plus docs:check, no recursion |
| Coverage and installed package (015) | `pnpm test:coverage`, `pnpm test:package` | both 0; package tests remain separate |
| Schema and boundaries | `pnpm schemas:check`, `pnpm boundaries:check` | 0; preserve 014 controls and thresholds |

`scripts/test.mjs` forwards arguments to the integration project after building. Do not call direct Vitest on a stale `dist/`. `docs:check` will validate source-backed facts without invoking the analysis CLI; the E2E suite owns built-command/help verification. A fresh full `check` plus coverage/package runs subsumes individual gates in the final sweep; avoid redundant builds/runs just to repeat this table.

## Scope

**In scope (only these may change):**

- Root `README.md`, `CONTRIBUTING.md`, `SECURITY.md`; `CODE_OF_CONDUCT.md` and `LICENSE` only with approved text/identity/contact as applicable; `AGENTS.md` command/documentation updates only.
- New `docs/{configuration,cli,architecture,limitations,roadmap,release-readiness}.md`.
- Existing `docs/{metrics,indicators,relationships,output-schema,releasing,testing}.md` for consistency/evidence references only; `docs/adr/002-domain-contract.md` for the three stale summaries identified above only.
- `examples/**` for original data-only fixtures, manifest and independent expected facts, `test/e2e/documentation.test.ts`, `scripts/check-docs.mjs`.
- `package.json` for `docs:check` only; `scripts/check.mjs` for invoking that gate once after existing gates only.
- `plans/README.md` row 016 and this review's evidence note only.

**Out of scope:** source/application changes; schema/metric/model/weight changes; existing fixture registry/goldens/coverage thresholds; dependency/lockfile/bundler/test-project changes; workflows/account settings; guessed legal/security contacts; remote actions, publishing, commits, tags, pushes, issues or messages. Example output files go in OS temp, never tracked source directories. If 015's tarball allowlist or orchestration cannot accommodate these docs without broader changes, report a focused amendment.

## Git workflow

Use the supplied checkout. Preserve pre-existing changes (014 and the index were dirty at review entry). No branch/ref changes or commits/pushes/publication are authorized by this plan. Worktree setup, if supplied by an operator, does not supply shared node_modules.

## Steps

### Step 0: Confirm prerequisites and define the example/checker contract

Inspect 015's actual `check`, package test and release documentation. Verify 013/014 implementations are present. Record missing owner/platform evidence as pending without blocking local docs. Keep package private until an explicitly approved later release change.

Create `examples/manifest.json` as a strict, data-only registry. Define its schema in `scripts/check-docs.mjs` using existing Zod. Require unique IDs; repo-relative confined paths; a list of documented files; document marker IDs; source provenance/license status; command `argv` arrays; cwd/fixture roots; expected exit/status/coverage; stdout/stderr or output-file assertions; referenced config/model/result JSON examples; literal expected metrics/effort with calculation notes. Reject unknown fields, invalid paths and duplicate IDs. Do not allow executable setup hooks, arbitrary command names or shell strings. E2E setup may copy fixtures and create a temporary output directory; it never executes fixture code. The E2E suite must consume this registry, not maintain its own duplicate quickstart argv.

Use explicit `<!-- docs:case <id> -->` immediately before each canonical runnable `sh` fence. Restrict runnable fences to one `audit-estimator` invocation per line with simple tokens or double-quoted arguments (no escaping, interpolation, redirection, pipes, continuations or substitutions). Document this grammar. Parse only that limited grammar and require exact argv equality with the registered case, retaining quoted glob text. Label prerequisites/installation commands separately; label placeholders and non-runnable fragments explicitly. Require every product invocation fence in the public document set to be registered or explicitly labelled illustrative/pending, so adding a broken quickstart cannot bypass tests. Additional platform snippets must have registered equivalent argv; no claim of a locally untested shell/platform run. Use double quotes around globs for bash/zsh, PowerShell and cmd examples; the harness validates argv, not shell execution. Do not evaluate Markdown as code.

Define `docs:check` as `node scripts/check-docs.mjs`. It reads public root docs, `docs/**/*.md` and `examples/**/*.md`, excluding historical `plans/` and skill content. It validates confined local links (inline/reference/image, root-relative repository links, percent-encoded paths and heading fragments), skips external/mail links without fetching them, and reports document plus line on failure. Specify deterministic GitHub-style heading slugs and duplicate suffixes; support the syntax actually used in this repo, with explicit rejection of unsupported local-link syntax instead of silently skipping it. Test heading normalization and same-file anchors. Check required README/CONTRIBUTING/SECURITY and guide presence (LICENSE/CODE_OF_CONDUCT remain conditional), marker coverage and command equality, registered JSON content, schema URN/file references and explicit version facts against package/source constants. Annotate selected version facts in prose and compare them mechanically; do not search-and-replace historical version mentions. An unresolved LICENSE/contact link is not excused by a pending release gate: omit the link and explain pending status.

For schema validation, bundle the trusted internal schemas/version modules into a unique ignored `.vitest/` directory like `scripts/generate-schemas.mjs`; no production output, public export or dependency changes. Validate JSON examples with `ConfigInputSchema`, `ModelProfileSchema` or `ReportEnvelopeSchema`, including cross-field checks. Check their generated-schema references/IDs and rely on existing `schemas:check` for schema equivalence. Do not claim an independent Draft 2020-12 validator ran. Validate exact fenced JSON against its registered data file (or parse the fence directly); omitted report fragments must be labelled fragments and cannot count as validated full envelopes.

**Verify:** `pnpm docs:check --self-test` → 0 with a counted control summary. Build controls in isolated temp data using the same checker functions: valid link/reference/image/duplicate heading/encoded path; missing target/fragment; duplicate case; changed command flag/argv; invalid config and report cross-field data; stale annotated version/schema ID; and an unregistered runnable fence must each be detected. No source/docs mutations for negative controls, no subprocess that executes fixture commands. Baseline public docs can be minimal at this step and expand next.

### Step 1: Write and exercise the quickstart, scope and configuration guides

README leads with purpose, supported Node range and visible uncalibrated label. Give a working development path (`pnpm install --frozen-lockfile`, `pnpm build`, then `node dist/bin.js ...`) and explain that canonical examples spell the executable `audit-estimator`. The E2E runner substitutes only that executable with `process.execPath` plus the absolute built bin. If describing local tarball installation, match the verified 015 procedure with an explicitly local tarball path; do not use `npx`, registry install or imply unpublished identity is available. Publication remains pending until real evidence exists.

Cover estimate/inspect/explain, exclude glob, JSON/Markdown and safe output. Explain root selection, Foundry default-only metadata, Hardhat convention-only detection, custom roots/remappings, ownership promotion, no automatic `.gitignore`, include/exclude precedence and pruning, arrays replacing at higher layers, symlink inside-root option, outside-root pnpm-store limits, strict/partial exits. Use complete valid config JSON with the actual profile/manual reason/8-hour day shape. No price/rate field.

Create original tiny fixtures under `examples/projects/{simple,foundry-custom,hardhat,dependency,partial}/` plus a manual adjustment config for the simple project. Record authorship and provisional/approved licensing honestly in `examples/README.md` and the manifest. Do not stamp SPDX MIT on newly created files without a real grant; owner-pending originals may be tested locally while release remains pending. Copied snippets with unknown provenance are a STOP. No fixture dependency installs, executable Hardhat config, compiler runs or imported upstream repositories. Metadata can be data-only markers.

Create named `quickstart and scope` tests in `test/e2e/documentation.test.ts`. Copy each example to a temp directory, execute registered argv with the built bin, timeout and `shell:false`, assert exact selected/context paths and exits, and clean up in `finally`. Check inspect has null estimates; explain and estimate agree numerically; terminal/JSON/Markdown select the intended format. Test partial twice: default has no estimate, allow-partial has analyzed-subset estimate and null fullScopeEstimate, both exit 4. For output, create the parent only in temp; assert stdout/file routing, refusal to overwrite without force, exit 5, safe forced replacement and unchanged input bytes. Existing broad E2E tests remain untouched.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test:integration test/e2e/documentation.test.ts -t 'quickstart and scope'` and `pnpm docs:check` → both 0; registered README and scope commands produce the literal path/status expectations.

### Step 2: Document and verify the model, public APIs and contributor workflow

Architecture covers module responsibilities, one package, trusted child isolation/parent safe reads, no target execution/default source transmission, pure estimator and independent version axes. Include a minimal public-root ESM library example with the actual `analyzeProject(request, options)` shape; test it by native Node against built index, not private imports. Preserve limitations on typing/storage/runtime dispatch/economic complexity/vulnerability conclusions.

CLI/config/output docs enumerate actual help, exit meanings, JSON envelope compatibility, unavailable/null fields, analyzed-subset coverage and deterministic fingerprints. Add named `schema and formula examples` tests: parse registered complete JSON through runtime schemas; assert a hand-counted simple source's SLOC and literal ledger/hour/day endpoints; assert a reasoned signed manual adjustment changes only the documented ledger/total. Write the independent arithmetic in manifest notes before running the implementation; do not regenerate expectations from observed output or import private model fixtures into distribution. Reference the existing normative rounding order: integer microhours per row, reserve on rounded pre-manual high subtotal, manual last, outward hours/days. Tests verify implementation conformance, never empirical accuracy.

Add named `help and contracts` tests. Compare documented flag/command tables (registered in the manifest) to root and subcommand help, asserting deferred remote/explorer/Slither/pricing flags are absent. Do not equate installed-artifact help with built-bin help; 015's package tests provide installed evidence. Validate registered package/config/schema/metrics/indicator/model version facts independently rather than asserting every version string equals TOOL_VERSION. The installed Slang research tests assert grammar versions 0.4.11–0.8.37; describe that as pinned parser capability with representative fixtures, not full compiler support across that interval. Read 002/006 research and current 014 oracles before making compatibility claims.

CONTRIBUTING documents pinned setup, source-only units, fresh-build artifact suites, `check`, separate package/coverage/docs gates, fixture provenance/oracles, no blind golden updates, upgrade review and actual platform evidence. AGENTS adds docs gates while retaining its safety boundary. Correct only ADR 002's stale summaries; use `docs/testing.md` as the existing evidence ledger instead of duplicating all its rows.

**Verify:** `pnpm --config.verifyDepsBeforeRun=false run test:integration test/e2e/documentation.test.ts` and `pnpm docs:check --self-test` → 0, including schema/formula/help/library cases. Every canonical runnable product example is linked to the executed manifest case.

### Step 3: Prepare governance and a grounded roadmap

SECURITY separates vulnerabilities in this tool from findings in analyzed contracts. Use only a confirmed reporting contact/channel. Without one, say `PENDING OWNER DECISION` prominently and state that confidential reports must wait for a confirmed channel; do not recommend posting secrets in public issues. Do not invent email, repository URL or private-reporting availability. Create LICENSE only after explicit owner approval of license and copyright identity; MIT is a recommendation. CODE_OF_CONDUCT is optional until conventional text, applicable attribution/license and enforcement contact are approved; do not make it a preparation prerequisite. Preserve upstream notices and record provisional original-example/fixture licensing as release gates.

Roadmap defers remote Git/archive acquisition until a safe acquisition boundary, then explorer metadata/network trust, optional compiler/Slither adapters after reviewed execution policy, richer dependency analysis after tested evidence, consented calibration before accuracy claims, pricing after explicit commercial inputs and a hosted CI action after stable JSON. Pricing consumes effort plus explicit currency/rate/hours-per-day/commercial scope and labels a nonbinding scenario; it cannot change technical effort or invent a universal rate. No plugin architecture before multiple actual adapters.

Add named `governance and claims` checks for explicit pending/approved manifest states, required uncalibrated labels and absence of deferred commands in help. These checks cover specific structured claims, not an assertion that automated text matching proves all prose accurate. Manually review remaining public prose and list pending decisions.

**Verify:** `pnpm docs:check` and `pnpm --config.verifyDepsBeforeRun=false run test:integration test/e2e/documentation.test.ts -t 'governance and claims'` → 0 with confirmed facts or explicit pending markers; no broken pending-field links or false license approval.

### Step 4: Connect verification and record final release evidence

Add one `docs:check` call to 015's `scripts/check.mjs` after its existing checks using the existing safe command runner. Do not call `check` from docs:check or from documentation tests. The checker never invokes tests; the E2E file runs only in the ordinary build-first integration project. Keep `test:package` separate. Prove a checker failure propagates through its own nonzero status via the negative controls; no need to rerun an entire full gate for each failure control.

Write `docs/release-readiness.md` with two clearly separated tables: implementation verification and public-release gates. Use stable gate IDs and columns `gate | status | revision | date (UTC) | environment | command/evidence | pending reason`. Allowed statuses: `PASS`, `FAIL`, `PENDING`, `NOT_RUN`, `NOT_APPLICABLE`; each non-pass needs a reason, PASS needs evidence identifying the run/revision/platform. Capture actual UTC dates, exit codes and logs under ignored `.vitest/plan016/` or a CI URL when supplied; portable doc references must describe ignored local logs as local-only evidence, not broken links or permanent public artifacts. Never commit absolute workstation paths, analyzed sources, tokens or full private logs. Historical results and current runs must have distinct revisions/dates. For uncommitted execution changes, identify the base SHA plus dirty state and a digest of the relevant diff/files; do not pretend the base commit contains those changes. If `check` expands to multiple gates, record that mapping; a package dry run is not an installed-consumer test.

Cover local type/lint/format/unit/fresh-build integration/schema/boundary/docs/coverage/package gates, parser/fixture evidence (link `docs/testing.md`), advisory review supplied by 015 with date/scope, actual Linux/macOS/Windows and minimum-Node CI evidence if available, identity/private switch/license/security/fixture licensing, changelog, owner heuristic-label review and authorized release operator/OIDC setup. Unknown owner fields are `PENDING`, unrun platform checks `NOT_RUN`, a failed command `FAIL`. Owner/remote evidence may come from an authorized supplied record; reading this plan is not approval.

After final functional edits run `pnpm check`, `pnpm test:coverage`, `pnpm test:package` once, capturing their results. `check` must include docs examples, checker and all prior 015 gates. Record results and pending items, then rerun docs/format checks after evidence-only Markdown updates. If `test:package` includes README/LICENSE changes, those final bytes need fresh package verification; prefer keeping final evidence in non-distributed readiness docs and rerun package only when distributed files changed. Never claim untested final artifact bytes. Do not run remote workflows or a publish command.

If owner/remote gates remain, report **MVP implementation prepared; public release pending <named gates>**. 016 can be DONE for preparation while release remains pending. A local gate failure prevents DONE. Update row 016 only and report exact remaining gates.

**Verify:** `pnpm check`, `pnpm test:coverage`, `pnpm test:package` → 0; then `pnpm docs:check`, `pnpm format:check` after evidence updates → 0. Readiness tables identify executed revision/environment and distinguish pending owner decisions from unrun platform work. Inspect final diff/status for scope; do not count pre-existing edits as this execution's changes.

## Test plan

Use `test/e2e/documentation.test.ts` with named groups `quickstart and scope`, `schema and formula examples`, `help and contracts`, `governance and claims`. Pattern after `test/e2e/cli.test.ts`; reuse `test/helpers/{run-cli,filesystem}.ts`. Tests consume the registered Markdown commands and JSON, copy projects to OS temp, use built bin/native library with no shell/target execution, assert separate streams/intentional exits and independent facts, then clean up. Test exact output-file safety examples, not every pre-existing writer edge case.

Checker self-tests exercise its actual parsing/validation functions with isolated good/bad data, including missing links/fragments, stale facts, invalid JSON and command drift. They must fail when detection is removed; merely counting controls is insufficient. No network links are fetched and no generic shell/Markdown execution is supported. No tests for whether prose contains an arbitrary number of headings; check claims that affect user behavior. Real platform/shell execution, installed package behavior and empirical calibration each retain their own evidence boundary.

## Done criteria

- [ ] 015's implementation is present; no prerequisite status inferred solely from historical index text.
- [ ] `pnpm check`, `pnpm test:coverage`, `pnpm test:package`, final `pnpm docs:check` and `pnpm format:check` exit 0 for the final relevant files.
- [ ] `pnpm docs:check --self-test` exits 0 with positive and negative controls; checker failures have nonzero status and actionable file/line or field diagnostics.
- [ ] Registered runnable commands/config/model/result examples are the exact content checked/executed; independent numerical expectations and public-library example pass.
- [ ] Local links and registered version/schema/help facts validate; no new dependencies, runtime exports, build entries or weakened checks.
- [ ] Release readiness uses the specified statuses/evidence fields; uncalibrated label, provisional licensing and unknown owner/platform gates remain explicit.
- [ ] No invented identity/contact/license/accuracy/platform result or publication; only scoped execution changes; 016 index row updated.

## STOP conditions

- 015's reviewed package/check implementation is missing: do not invent it within 016. Report prerequisite pending; unaffected plan review is still possible.
- A documented command, schema, formula or independent literal expectation contradicts runtime behavior: stop the affected example and request a focused correction, never rewrite the expected answer to hide a defect.
- Work needs runtime/schema/dependency/workflow/test-harness/allowlist changes outside scope, network/target scripts/compiler execution, or copied material with unknown provenance: stop that work and report the specific boundary.
- A verification gate fails twice after a reasonable in-scope correction: report the failure and do not mark local preparation DONE.
- Identity/license/contact/fixture grants/CI/OIDC approval is missing: stop only dependent public-release steps, finish local docs/examples and record pending gates. Do not pause completed authorized local work merely to ask about optional CODE_OF_CONDUCT or publication.

## Maintenance notes

Every CLI/config/schema/version change updates manifest-linked docs and runs docs examples plus checker controls. Model/parser/metrics changes retain independent versions and hand-reviewed expectations. Review the full public prose as well as automated claims. Changes to tarball contents require fresh installed-artifact evidence. Calibration/privacy/governance decisions require owner review; a README accuracy sentence never substitutes for consented matched data and held-out evaluation.
