# Contributing

Contributions should preserve the analyzer’s local, data-only boundary and keep behavior, schemas, tests and documentation in agreement. Start with the architecture and limitations guides, then run the focused suite and the full local gate before proposing a change.

## Development environment

The package requires Node.js <!-- docs:fact node-engine -->`>=24.11.0 <25` and pnpm <!-- docs:fact pnpm-version -->`pnpm@11.28.4`. `.node-version` records the current Node patch. Install only the trusted repository dependencies:

<!-- docs:prerequisite -->

```sh
pnpm install --frozen-lockfile
```

The project is strict ESM TypeScript. Keep source imports suffixed with `.ts`, use named exports, use `import type` for type-only imports, annotate public declarations, and avoid `any` and suppression comments. Unit tests live in `test/unit/**/*.test.ts` and import source without building. Integration and E2E tests run after a fresh build.

## Checks

Useful focused checks are `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm docs:check`, and `pnpm schemas:check`. The complete local gate is:

<!-- docs:prerequisite -->

```sh
pnpm check
```

`pnpm test:coverage` covers the unit project without building. `pnpm test:package` builds and packs a tarball, then installs it into a clean consumer; that check needs network access for trusted package dependencies. Do not run it inside example project directories.

`pnpm test:integration` and `pnpm test:all` build immediately before the artifact suites. `pnpm boundaries:check` verifies the reviewed production boundary. The docs and package checks are separate from unit coverage; none of those results implies a remote CI matrix ran. Record actual operating system and runtime for platform-sensitive behavior.

## Safety boundary

Treat every Solidity target repository as untrusted data. Do not run its scripts, package lifecycle hooks, build commands, compiler binaries or configuration files. Do not install compilers or target dependencies for a local analysis. The analyzer’s parser worker is an internal trusted component; target configuration formats are inspected as data according to the documented adapter boundary.

Do not add fixture code copied from another project unless its provenance and license grant have been approved. The current examples are locally authored for tests, with publication and redistribution pending owner review. Do not add a license, security contact or release claim based on an assumption.

## Documentation examples

Canonical runnable commands use a single `audit-estimator` invocation in a fenced shell block, immediately preceded by `<!-- docs:case <id> -->`. The case registry in `examples/manifest.json` is the argv contract for the docs checker and E2E suite. It accepts simple tokens and double-quoted arguments only. It rejects shell evaluation features such as substitutions, escaping, redirection and pipes. Prerequisite commands are marked separately; illustrative or pending fragments must say so explicitly. Never execute Markdown as code.

The documentation checker resolves confined local Markdown links and fragments without network access. It validates registered JSON against trusted internal Zod schemas bundled in ignored temporary storage. Keep source and fixtures free of generated evidence logs; the release-readiness guide records verification evidence separately. Fixture counts and formula values are independent literals: review the hand calculation and source-line count before changing them. Do not blindly update goldens or manifest expectations to match a changed implementation.

Heading fragments use the documented checker’s GitHub-style normalization: lowercase Unicode letters and numbers, remove punctuation other than underscores and hyphens, trim leading/trailing whitespace, and turn each remaining whitespace character into a hyphen. Existing repeated hyphens remain repeated (`A -- B` becomes `#a----b`). Duplicate headings take the first unused global suffix: `Foo`, `Foo`, `Foo-1` become `#foo`, `#foo-1`, `#foo-1-1`. Local links must remain inside the repository; percent-encoded paths are decoded before confinement checks. HTTP(S), `mailto:` and `tel:` links are external and allowed. Unsupported schemes, local queries, raw whitespace or backslashes, and fragments to non-Markdown files fail the check.

When upgrading Node, pnpm, TypeScript, Slang, schemas or the bundler, review upstream changes, lockfile and lifecycle effects, supported grammar evidence, generated schema diffs, fixture behavior and the full relevant platform matrix. A version bump alone is not evidence that the new version behaves compatibly. Report platforms that were not actually tested rather than extrapolating from macOS.

## Proposing a change

Describe the user-visible behavior, its limits, focused verification and any remaining unknowns. Keep scope explicit, preserve existing public contracts unless a reviewed decision changes them, and report any platform-specific check that could not run. Changes to estimator assumptions require an independent calibration and model review; better documentation alone does not establish empirical accuracy.
