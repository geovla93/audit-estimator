# Releasing

## Status

- Local preparation: complete (distribution allowlist, packed-artifact suite, `pnpm check`, CI and release workflow files).
- Remote CI matrix: not yet executed. No workflow has run on GitHub; nothing here was pushed, tagged or published.
- Release: pending owner decisions below. The package is still `"private": true`, and the release workflow is disabled by default.

## Owner decisions required

- **npm package name.** The name `audit-estimator` is load-bearing: the parser worker is located through a Node package self-reference (`import.meta.resolve('audit-estimator')` in `src/parser/adapter.ts`). A rename (for example to a scoped `@owner/audit-estimator`) requires changing that self-reference and regenerating the boundary-scanner AST fingerprints under review (`pnpm boundaries:check`, `worker-ast-fingerprint`), then re-running `pnpm test:package`.
- **License.** None is set. MIT is recommended. Add `LICENSE` and the `license` field together.
- **Repository URL.** The `repository` field is unset; trusted publishing and provenance need it.
- **Security contact.** No `SECURITY.md` exists (plan 016 / owner).

## One-time setup

1. Create the npm package, or perform a bootstrap publish, under the chosen name.
2. Configure an npm trusted publisher for this repository, workflow `release.yml` and environment `npm-release`.
3. Create the `npm-release` GitHub environment and add required reviewers.
4. Set the repository variable `RELEASE_ENABLED` to `true` only when ready to release. While unset, the `release` job is skipped.
5. Remove `"private": true` and set `license` and `repository` in `package.json`. The release guard fails until they are set, and `test/unit/release-config.test.ts` asserts `private: true` and must be updated in the same change.

## Release checklist

1. Bump `version` in `package.json` and `TOOL_VERSION` in `src/version.ts` together.
2. Update `CHANGELOG.md`.
3. Run `pnpm check` and `pnpm test:package`.
4. Review `pnpm build && npm pack --dry-run --json --ignore-scripts` output against the 15-path allowlist (plus `README.md` / `LICENSE` when present).
5. Dispatch `release.yml` with the `version` input.

## Pinned actions

Every action is pinned to a full commit SHA. Looked up on 2026-10-16 with read-only `gh api` calls (`releases/latest`, then `git/ref/tags/<tag>`, dereferencing annotated tags via `git/tags/<sha>`).

| Action               | Tag    | Commit SHA                                 |
| -------------------- | ------ | ------------------------------------------ |
| `actions/checkout`   | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| `pnpm/action-setup`  | v6.1.0 | `ea17c68df8912ef543352723c149a84f56e3d413` |

Dependabot (`github-actions` ecosystem) proposes updates; review each SHA against the upstream tag.

## Advisory review

`pnpm audit --prod --audit-level high` on 2026-10-16 (macOS, Node 24.21.0, pnpm 11.28.4): "No known vulnerabilities found". No exceptions are recorded.

## Evidence

Local results on macOS (Darwin), Node 24.21.0, pnpm 11.28.4, npm 12.2.0, 2026-10-16:

- `pnpm check`: exit 0 (all seven gates).
- `pnpm test:package`: exit 0 (8 tests).
- `pnpm test:coverage`: exit 0.
- `pnpm test:integration`: exit 0 (15 files, 274 tests).
- `pnpm audit --prod --audit-level high`: no known vulnerabilities.

Remote CI results: none. The matrix (ubuntu, macOS and Windows; Node 24.11.0 and 24.x) has not been executed.
