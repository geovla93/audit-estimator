# Architecture

The public library and CLI are two entry points over the same analysis pipeline. `src/index.ts` is a side-effect-free root API. `src/bin.ts` is the executable shim. Production build output is controlled by `tsdown.config.ts`; parser worker code is an internal runtime entry, not a public deep-import API. Internal discovery, parser, relationship and indicator modules are not supported public imports.

The root API exports `analyzeProject`, its request/options/outcome types, pure estimator and model APIs, report renderers, domain types and version constants. A caller supplies an input path; the optional `root` request property can select a containing project root, and the optional `AbortSignal` can cancel work. The analyzer returns a typed outcome without invoking the CLI process boundary. The command adapter owns argument parsing, streams and exit status.

## Analysis flow

1. Parse and merge bounded JSON config, metadata defaults and explicit CLI settings with provenance.
2. Resolve scope and ownership using confined paths and deterministic discovery.
3. Read source through bounded parent-process safe file operations and send it only to the trusted local parser worker; no source is transmitted to a remote service by default.
4. Convert parser observations into metrics, graph/context relationships, completeness facts and optional readiness observations.
5. Resolve the optional caller estimation scope, recognize reusable declarations by content against the bundled reference catalog, and derive the effective review projection beside the unchanged raw metrics ([dependency reuse](dependency-reuse.md)).
6. Estimate only when required measured inputs satisfy model preconditions using the pure estimator/model API; validate a report envelope and render it.

The parser is selected through a reviewed adapter. The current implementation uses Slang <!-- docs:fact slang-package-version -->1.3.9. The tool does not invoke `solc`, target build tools, target scripts or an external language server. Parser and schema changes require separate compatibility review. The installed grammar inventory spans 0.4.11–0.8.37, with representative tested versions; this does not imply full compiler compatibility across that interval.

The worker boundary bounds protocol data and isolates parser state, but it is not an OS security sandbox and makes no memory/RSS isolation promise. See [ADR 005](adr/005-parser-boundary.md) and [the limitations guide](limitations.md).

## Library example

This example is executed by the documentation E2E test after the package build. It uses the public package root import and runs against an isolated copy of the simple fixture. It does not execute fixture files.

<!-- docs:library public-library-example -->

```js
import { analyzeProject } from 'audit-estimator';

const outcome = await analyzeProject(
  {
    input: process.cwd(),
    command: 'estimate',
    noConfig: true,
    allowPartial: false,
    format: 'json',
  },
  {
    signal: new AbortController().signal,
  },
);

console.log(
  JSON.stringify({
    status: outcome.envelope.status,
    sourceLines: outcome.envelope.analysis?.aggregates.sourceLines.value ?? null,
  }),
);
```

The example reports envelope status and the measured aggregate source-line count. Callers should handle failures without assuming a non-null estimate. API shape and error details are described by the exported declarations.

## Build and distribution boundary

The package manifest allowlists `dist`, generated JSON schemas and `CHANGELOG.md`, with optional root README and LICENSE files. Package tests verify the actual tarball inventory and consumer behavior. Build output is not the list of public APIs: only the root package export and explicitly documented data schemas form stable imports. See [release procedure](releasing.md) and the [readiness record](release-readiness.md).
