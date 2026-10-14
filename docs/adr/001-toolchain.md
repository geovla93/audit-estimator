# ADR 001: Strict ESM tooling and verification baseline

- **Status:** Accepted
- **Date:** 2026-10-14

## Context

The repository is a local Solidity audit-effort CLI. Later work needs a reproducible typecheck, source tests, build-first artifact tests, lint and format checks before parser and estimation code is added.

## Decision

- Support Node.js `>=24.11.0 <25` for development and execution. Pin the working patch in `.node-version`; let tsdown derive the emitted JavaScript target from the package engine range.
- Use pnpm with exact direct development-tool pins and a committed lockfile. Keep runtime dependencies external from emitted bundles.
- Use TypeScript 7 for `tsc --noEmit` checks. Use tsdown for ESM bundling and declaration output, with isolated declarations generated through Oxc. Emit `dist/index.js`, `dist/index.d.ts`, and the `dist/bin.js` executable shim; do not emit CommonJS.
- Keep source tests in `test/unit/`. Keep integration, end-to-end and research tests in their separate directories under the build-first integration project. The fast unit command never builds; integration builds immediately before running artifact tests.
- Use Vitest, Oxlint with type-aware checks, and Oxfmt. Exact package versions, licenses, purposes and engine evidence are recorded in `docs/dependencies.md`.
- Keep `src/index.ts` side-effect-free. The bootstrap CLI supports help and version only; future application behavior belongs in later feature work.
- Local analysis treats Solidity projects as data. It never executes target-project scripts or downloads compilers. Compiler/parser evaluation is a separate decision.

## Consequences

- A build-first integration command is required for tests that load `dist/`.
- Future runtime packages must be declared, remain external to the bundle, and be added to the dependency inventory with a reviewed reason.
- Recheck Node support and every tool's compatibility before changing the runtime floor or making a major release.
