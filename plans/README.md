# Implementation plans

Generated with the improve skill on 2026-11-17 against commit `1e61ad0`. The maintainer selected all three vetted findings. These are implementation handoffs, not completed fixes. Source, dependencies, tests and configuration were not changed by the advisor.

Read a plan fully before execution, honor its scope and STOP conditions, and update its status and actual verification evidence. Do not mark a plan DONE with skipped required checks. Status values: TODO, IN PROGRESS, DONE, BLOCKED (reason), REJECTED (reason).

## Execution order and status

| Plan | Title | Priority | Effort | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| [001](001-regenerate-dependency-catalog.md) | Regenerate the dependency catalog with the pinned parser | P1 | M | — | TODO |
| [002](002-refresh-dependency-evidence.md) | Restore current dependency facts and the documentation gate | P1 | S | 001 | TODO |
| [003](003-index-semantic-import-lookups.md) | Build semantic import lookups once per analysis | P2 | M | —; final full gate needs catalog/docs repair | TODO |

S means hours; M means roughly a day including verification. All three findings have HIGH confidence. Catalog regeneration and relationship indexing have MED fix risk; documentation correction has LOW fix risk.

## Dependency notes

Recommended order: **001 → 002 → 003**. Plan 002 must use the actual regenerated catalog identity and successful compatibility evidence from 001. Plan 003 can be implemented independently, but cannot claim a clean full repository gate while the catalog/documentation failures remain.

Plan 001 requires an external local reference corpus laid out and hash-pinned by `scripts/dependency-references.json`. It is not present in the repository. If unavailable, report that prerequisite rather than hand-editing generated provenance or automatically obtaining substitute sources.

Executors may install the trusted repository dependencies with `pnpm install --frozen-lockfile` and build ignored production/test artifacts as specified in their plans. They must never run target/reference scripts, package hooks, compiler commands or other target-provided executables. No plan permits pushing, merging or publishing.

## Audit baseline and limits

- Working tree was clean at the beginning and end of the source audit; audit-created pnpm store data was removed.
- Node v24.21.0 and pnpm 11.28.4 were available on the local macOS environment.
- Typecheck, lint, formatting, boundaries and 626 unit tests passed against the **existing installed dependencies**. Several installed packages were stale: Slang 1.3.9 instead of locked 1.3.10, Node declarations 24.19.2 instead of 25.9.9, tsdown 0.23.1 instead of 0.23.4, Oxlint 1.88.0 instead of 1.89.0 and Oxfmt 0.73.0 instead of 0.78.0. These results do not establish the locked baseline.
- `node scripts/check-docs.mjs` failed with the recorded Slang manifest-fact mismatch. A fresh locked install is also expected to fail the existing installed-parser/catalog equality test.
- Integration, packed-consumer, clean-install and Linux/Windows verification were not performed during the audit. The read-only production advisory query failed to reach its registry; no current advisory conclusion is claimed.
- Review was a standard hotspot audit across the analyzer, filesystem/parser safety boundaries, estimation scope/reuse, tests, tooling and docs. It was not an exhaustive review of every parser semantic or every supported platform. No wall-clock performance improvement was benchmarked.

## Findings considered and rejected

- Missing automatic inheritance/helper/callee scope closure: explicitly deferred; caller selection is exact and intentionally does not infer behavioral scope.
- Uncalibrated coefficients and zero full-review cost for token-matched declarations: disclosed model-policy decisions, not implementation defects.
- Lack of hard RSS or OS sandboxing, and concurrent adversarial filesystem mutation outside the documented guarantee: explicit ADR 004/005 limits. No additional concrete containment flaw was confirmed in the reviewed paths.
- Old versions in dated Slang research or historical private-sample runs: historical evidence must stay historical. Only current facts and falsely current inventory claims are corrected.
- Node 25 type declarations with a Node 24 runtime: a compatibility-review concern, but no concrete use of an unsupported runtime API was established. The documentation plan must describe the actual declaration version accurately; repinning is not included.
- Broad decomposition of large modules or optimization of every nested scan: no demonstrated leverage sufficient to expand these plans.

## Optional directions, not selected for implementation

- A design spike for generating reviewable exact scope-selector drafts from inspection output, reducing manual path/kind/name/hash transcription while keeping selection explicit.
- A consented calibration feasibility assessment against the existing family/time split protocol, before acquisition or fitting tooling.

Neither option authorizes collection, remote acquisition, automatic scope expansion or calibration claims.

## Execution evidence

Executors should append actual commands, outcomes, runtime/platform and remaining limitations under their plan number. Include the regenerated catalog digest and reference-verification outcome for 001; final docs/full-gate evidence for 002; traversal/checkpoint and native multi-component evidence for 003. Never include secret values, private source text or raw private reports.
