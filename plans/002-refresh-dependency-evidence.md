# Plan 002: Restore current dependency facts and the documentation gate

> **Executor instructions:** Execute each step and verify its result. Honor the STOP conditions. Update this plan's row in `plans/README.md`, unless a dispatching reviewer maintains the index.
>
> **Drift check:** Run `git diff --stat 1e61ad0..HEAD -- examples/manifest.json docs/architecture.md docs/dependencies.md docs/dependency-reuse.md docs/release-readiness.md` and inspect uncommitted changes. Compare current-state excerpts below. The dependency catalog will intentionally have changed through the prerequisite; read its final values and evidence rather than copying the old ones.

## Status

- **Priority:** P1
- **Effort:** S (hours, assuming compatibility evidence is available)
- **Risk:** LOW — documentation and registered facts only; incorrect evidence remains a review risk.
- **Depends on:** `plans/001-regenerate-dependency-catalog.md` marked DONE
- **Category:** docs
- **Planned at:** commit `1e61ad0`, 2026-11-17

## Why this matters

`node scripts/check-docs.mjs` currently fails with `package.json: /dependencies/@nomicfoundation~1slang is 1.3.10, manifest records 1.3.9`. This checker is part of `pnpm check` and CI. The dependency inventory also presents several superseded pins as the current reviewed set. Align current facts with the actual locked dependencies and record only verification that was performed.

## Current state

- `examples/manifest.json:105` registers this current version fact:

  ```json
  {
    "id": "slang-package-version",
    "sourceFile": "package.json",
    "selector": "/dependencies/@nomicfoundation~1slang",
    "value": "1.3.9",
    "document": "docs/architecture.md"
  }
  ```

- `docs/architecture.md:16` says `The current implementation uses Slang <!-- docs:fact slang-package-version -->1.3.9.` and describes the installed grammar inventory as 0.4.11–0.8.37.
- `scripts/check-docs.mjs:752` compares the source value against the fact and then checks exactly one matching document marker:

  ```js
  const actual = versionSourceValue(root, fact);
  if (actual !== fact.value)
    fail(`${fact.sourceFile}: ${fact.selector} is ${actual}, manifest records ${fact.value}`);
  ```

- `docs/dependencies.md:8–20` has outdated rows. The manifest's current exact pins are:

  | Package | Current pin | Inventory currently says |
  | --- | --- | --- |
  | `@nomicfoundation/slang` | 1.3.10 | 1.3.9 |
  | `tsdown` | 0.23.4 | 0.23.1 |
  | `oxlint` | 1.89.0 | 1.88.0 |
  | `oxfmt` | 0.78.0 | 0.73.0 |
  | `@types/node` | 25.9.9 | 24.19.2 |
  | `zod` | 4.6.7 | 4.4.3 |
  | `smol-toml` | 1.9.1 | 1.9.0 |

- `docs/dependency-reuse.md:81` describes catalog 1.0.0, 37 files/declarations, parser 1.3.9 and digest `d72accbbcfb7dce7200cb9b927ba81d7d121961b2628067c6d2be42d29c1bbae`. Its generation evidence at line 99 and sample runs below that are historical observations.
- `scripts/check.mjs:53` includes the documentation checker in the local gate.
- `docs/release-readiness.md` records actual evidence and separates untested platform/release claims. Follow that convention when appending new evidence.

From `CONTRIBUTING.md`:

> “A version bump alone is not evidence that the new version behaves compatibly.”

> “Report platforms that were not actually tested rather than extrapolating from macOS.”

The analyzer remains local and data-only. Parser upgrades are not compiler-compatibility proof, a content match is not security evidence, and no license, release authorization or calibration claim changes in this plan.

## Commands you will need

Use Node `>=24.11.0 <25`, `.node-version` 24.21.0, and `pnpm@11.28.4` from the repository root.

| Purpose | Command | Expected result |
| --- | --- | --- |
| Trusted reproducible install | `pnpm install --frozen-lockfile` | Exit 0, no manifest/lockfile changes |
| Capture environment | `node --version`, `pnpm --version`, `node -p 'process.platform + "/" + process.arch'` | Record actual outputs |
| Focused docs validation | `node scripts/check-docs.mjs` | Before fix: stale Slang fact error; afterward: `docs:check passed:` |
| Registered docs command | `pnpm docs:check` | Exit 0 |
| Current grammar inventory | `node --input-type=module -e 'import { LanguageFacts } from "@nomicfoundation/slang/utils"; console.log(LanguageFacts.allVersions());'` | Print actual installed grammar versions; compare with prose |
| Required source/tool gates | `pnpm typecheck`, `pnpm lint`, `pnpm format:check` | Each exits 0 |
| Complete local verification | `pnpm check` | Every gate exits 0, including freshly built integration suites and docs |
| Patch hygiene | `git diff --check` | Exit 0 |

## Scope

**Only modify:**

- `examples/manifest.json` — the existing Slang version fact only.
- `docs/architecture.md` — current parser version/inventory wording only.
- `docs/dependencies.md` — direct dependency inventory and compatibility/lifecycle evidence.
- `docs/dependency-reuse.md` — current catalog description and separately dated generation evidence.
- `docs/release-readiness.md` — append actual verification evidence and limits, if needed.
- This plan's status/evidence row in `plans/README.md`.

**Out of scope:** production/test code, checker logic, dependency pins and lockfile, schemas, model specifications, fixture values, historical Slang research results, owner policy and CI workflow changes. Do not add a dependency-inventory generator or new test framework. Existing checker negative tests already enforce stale facts.

## Git workflow

Use `advisor/002-refresh-dependency-evidence` or an equivalent isolated task branch after the prerequisite has landed in that checkout. If committing, use a message such as `docs: refresh dependency and parser evidence`. Preserve unrelated changes; do not push, merge or open a PR without authorization.

## Steps

### Step 1: Verify prerequisites and installed versions

Confirm the catalog plan is DONE and its equality/regeneration checks passed. Perform the frozen install and read `node_modules/<package-name>/package.json` directly for every direct dependency, asserting its `version` equals `package.json`; direct file reads avoid export-map restrictions on `package.json` imports. Do not rely on the audit's stale installed tree.

Record current environment outputs. Run the focused documentation checker before editing.

**Verify:** Installed direct versions equal every exact pin, the regenerated catalog parser is 1.3.10, and the checker reproduces the stale registered Slang fact. If that failure has already been fixed, reconcile the plan before proceeding.

### Step 2: Correct current registered facts

Set only the registered `slang-package-version` value to 1.3.10 and its existing architecture marker to the same value. Inspect the installed `LanguageFacts.allVersions()` result and the prerequisite's actual parser evidence before retaining or changing grammar claims. Keep the distinction between available grammars, tested examples and compiler compatibility.

**Verify:** Run the grammar-inventory command and `node scripts/check-docs.mjs`. The marker mismatch must be gone and the checker must pass. Do not remove a marker, relax validation or change schema/example expectations to obtain that pass.

### Step 3: Refresh the inventory and catalog evidence honestly

Update all seven stale inventory rows and corresponding explanatory references, including the Oxlint peer-compatibility text. Check the installed packages' license, engines, peers and `preinstall`/`install`/`postinstall`/`prepare` fields against official package metadata and release notes for the changed versions. Use official upstream sources when upstream verification is needed; report an unavailable check rather than inventing evidence. No lifecycle allowlist is introduced.

`@types/node` now targets Node 25 while the supported runtime is still Node 24. State those facts accurately; do not call it a Node 24 declaration package or expand the runtime promise. Changing the pin is a separate policy decision if compatibility review identifies a concrete problem.

In `docs/dependency-reuse.md`, take the current parser version, catalog digest and counts from the regenerated catalog. Add separately dated regeneration evidence from the actual successful commands. Preserve the older private-sample and packed-consumer observations as historical results; do not relabel them as new runs. Do not copy private project sources or newly obtained report contents into the repository.

**Verify:** `pnpm docs:check` exits 0. Read all seven updated rows against installed manifests. Review `git diff -- docs/dependency-reuse.md` and confirm historical numeric samples were not silently replaced or attributed to 1.3.10.

### Step 4: Close the verification gate

Run typecheck, lint, non-mutating format checking and `pnpm check`. Record the actual runtime/platform and the successful commands in the allowed evidence document or index. If the package suite evidence comes from the prerequisite, attribute it to that execution; do not claim to have rerun it.

**Verify:** All four commands exit 0; `git diff --check` passes; no files outside scope were changed. Update the index status with the new evidence.

## Test plan

No new tests are needed for corrected facts. `scripts/check-docs.mjs` already rejects source/fact mismatches and duplicate or stale document markers and runs its own negative self-tests. The documentation E2E suite runs through `pnpm check`'s fresh-build integration stage. Keep the existing independent literal examples unchanged unless a separately reviewed behavior change justifies them.

## Done criteria

- [ ] Every installed direct dependency equals its exact manifest pin after a frozen install.
- [ ] The manifest fact and architecture marker both say Slang 1.3.10.
- [ ] All direct dependency inventory rows describe their actual current pins, with dated evidence and truthful limitations.
- [ ] Current catalog identity matches generated data; historical observations remain historical.
- [ ] `pnpm docs:check`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm check` and `git diff --check` exit 0.
- [ ] Only in-scope files changed and the index row records actual verification and status.

## STOP conditions

- The catalog prerequisite is incomplete, dependency installation fails, or a required compatibility fact cannot be established.
- A new grammar inventory or actual compatibility failure contradicts the proposed current-state wording.
- Fixing a gate requires production code, test/golden changes, checker relaxation, dependency repinning or a lifecycle allowlist.
- A check fails twice after a reasonable in-scope attempt. Report unresolved failures without updating evidence to imply a pass.

## Maintenance notes

Future dependency PRs must update current version facts and the direct inventory together with their compatibility review. Keep research snapshots and dated evidence distinct from current operational claims. An automated inventory guard could be considered separately; it is not part of this documentation correction.
