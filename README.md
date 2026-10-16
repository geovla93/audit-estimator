# Audit Estimator

Audit Estimator is a local Solidity project analyzer that produces a transparent, cumulative auditor-effort planning scenario. It reads project files as data and does not run project scripts, package hooks, compiler commands or network requests. The current `heuristic-v1` model is an **uncalibrated heuristic**: its range is not a statistical confidence interval, delivery promise, price quote or security assessment.

The package is currently private. The documented package version is <!-- docs:fact tool-version -->0.1.0, and its supported Node.js range is <!-- docs:fact node-engine -->>=24.11.0 <25. It uses pnpm <!-- docs:fact pnpm-version -->pnpm@11.28.4.

## Try the example

From the repository root, install the trusted repository dependencies and build the CLI. The following registered commands run against a tiny, original data-only fixture. The test harness substitutes `audit-estimator` with the built CLI path and passes the remaining tokens directly; it does not evaluate this Markdown as shell code.

<!-- docs:prerequisite -->

```sh
pnpm install --frozen-lockfile
pnpm build
```

<!-- docs:case quickstart-estimate -->

```sh
audit-estimator estimate examples/projects/simple --format json --no-config
```

The same project can be inspected without calculating an estimate:

<!-- docs:case quickstart-inspect -->

```sh
audit-estimator inspect examples/projects/simple --format json --no-config
```

Use `explain` to include the estimate ledger. Its numeric estimate matches `estimate` for the same inputs.

<!-- docs:case quickstart-explain -->

```sh
audit-estimator explain examples/projects/simple --format json --no-config
```

Choose Markdown or terminal output when a human-readable report is more useful:

<!-- docs:case quickstart-markdown -->

```sh
audit-estimator estimate examples/projects/simple --format markdown --no-config
```

<!-- docs:case quickstart-terminal -->

```sh
audit-estimator estimate examples/projects/simple --no-config --no-color
```

The fixture has seven code-bearing physical lines. Under the default profile, its literal ledger has project effort of 4–12 hours, baseline effort of 0.28–0.84 hours and measured zero premiums. The total is 4.28–12.84 precise hours, displayed outward as 4–13 hours or 0.5–1.7 eight-hour days. This is a planning scenario, not observed project performance.

For a direct development invocation after building, run the trusted Node entry from the repository root. Canonical examples use the executable name `audit-estimator`; E2E substitutes it with `process.execPath` and the absolute built entry, then passes the remaining arguments unchanged.

<!-- docs:illustrative -->

```sh
node dist/bin.js estimate examples/projects/simple --format json --no-config
```

The fixture configuration includes a signed manual adjustment. It is used only when configuration loading is enabled:

For the output-routing commands below, run `cd examples/projects/simple` first so `.` names the fixture project. The test harness copies the fixture to a temporary directory and uses that directory as its working directory.

<!-- docs:case output-write -->

```sh
audit-estimator estimate . --format json --no-config --output report.json
```

That output-routing case intentionally disables config so it tests file writing separately. In a real project, omit `--no-config` to load the root config. The configuration guide documents a tested example, including its -0.50/-0.25-hour manual adjustment.

`--output` refuses to replace an existing file unless `--force` is supplied. These examples operate in a disposable test copy.

<!-- docs:case output-refuse -->

```sh
audit-estimator estimate . --format json --no-config --output report.json
```

<!-- docs:case output-force -->

```sh
audit-estimator estimate . --format json --no-config --output report.json --force
```

## Read more

- [Configuration and scope](docs/configuration.md)
- [CLI reference](docs/cli.md)
- [Architecture](docs/architecture.md)
- [Limitations](docs/limitations.md)
- [Roadmap](docs/roadmap.md)
- [Release readiness](docs/release-readiness.md)
- [Contributing](CONTRIBUTING.md)
- [Security reporting status](SECURITY.md)

## License and fixture status

The repository has no approved license grant or public fixture redistribution grant at this time. The examples are original in-repository data written for local tests; see [their provenance record](examples/README.md). Publication remains pending owner approval.
