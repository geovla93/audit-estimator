# Repository instructions

## Runtime and module conventions

- Use Node.js `>=24.11.0 <25`; `.node-version` records the current patch. Use pnpm and keep its exact version in `package.json`.
- The package is ESM only. Write TypeScript source imports with `.ts` extensions and use explicit named exports. Use `import type` for type-only imports.
- Keep compiler settings strict: no `any`, no suppression shortcuts, and keep caught values as `unknown` until narrowed. Public declarations need explicit annotations for `isolatedDeclarations`.
- `src/index.ts` is a side-effect-free library entry. `src/bin.ts` is the CLI shim. `src/version.ts` is the single bootstrap version value and must match `package.json`.
- `tsdown.config.ts` is the production build boundary. Only production source entries belong in `dist/`; runtime dependencies stay external. `pnpm build` may clean only `dist/`.

## Safety boundary

Local analysis treats user-supplied Solidity repositories as data. Never run target-project scripts, package lifecycle hooks, build commands, compiler binaries or other target-provided executables. Do not download or install a compiler as part of local analysis. Keep parser/compiler selection isolated behind a reviewed adapter and its own documented decision.

## Tests and checks

- Unit tests live in `test/unit/**/*.test.ts` and import source. `pnpm test` must not build or require `dist/`.
- Build-first suites live in `test/integration/**/*.test.ts`, `test/e2e/**/*.test.ts` and `test/research/**/*.test.ts`. Run them through `pnpm test:integration`, which builds once immediately before Vitest runs the integration project.
- `pnpm test:all` runs unit tests and then the fresh-build integration suite. `pnpm test:coverage` covers unit tests only and must not build.
- Run `pnpm typecheck`, `pnpm lint`, and `pnpm format:check` for the current source and trusted tool configuration. Keep lint and format-check commands non-mutating.
- Use `pnpm install --frozen-lockfile` to verify reproducible installs. Update `docs/dependencies.md` whenever a direct dependency changes and review whether any lifecycle script needs a narrow pnpm allowlist.

## Current commands

| Purpose                                                              | Command                 |
| -------------------------------------------------------------------- | ----------------------- |
| Build ESM library and CLI                                            | `pnpm build`            |
| Typecheck source, tests and tool configs without emitting JavaScript | `pnpm typecheck`        |
| Source unit tests, no build                                          | `pnpm test`             |
| Fresh build followed by artifact integration tests                   | `pnpm test:integration` |
| Full unit and integration regression                                 | `pnpm test:all`         |
| Unit V8 coverage, no build                                           | `pnpm test:coverage`    |
| Type-aware lint                                                      | `pnpm lint`             |
| Non-mutating format check                                            | `pnpm format:check`     |
