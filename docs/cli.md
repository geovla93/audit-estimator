# CLI reference

The CLI has three commands. The help output is the operational contract; the tables below are checked against the registered command inventory in `examples/manifest.json`.

<!-- docs:help commands -->

| Command    | Purpose                              |
| ---------- | ------------------------------------ |
| `estimate` | Analyze and estimate auditor effort  |
| `inspect`  | Analyze without estimating effort    |
| `explain`  | Analyze and render the effort ledger |
| `help`     | Display root or command help         |

<!-- docs:help root-options -->

| Option          | Purpose            |
| --------------- | ------------------ |
| `-v, --version` | Print tool version |
| `-h, --help`    | Print help         |

<!-- docs:help common-options -->

| Option                         | Purpose                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `--include <glob>`             | Add an include pattern; repeatable                                 |
| `--exclude <glob>`             | Add an exclude pattern; repeatable                                 |
| `--root <path>`                | Set project root                                                   |
| `--config <file>`              | Read a config file                                                 |
| `--no-config`                  | Disable config loading                                             |
| `--format <format>`            | Select json, markdown or terminal                                  |
| `--output <file>`              | Write report to a path resolved from the current working directory |
| `--force`                      | Replace a regular existing output file                             |
| `--solidity-version <version>` | Select parser grammar version                                      |
| `--allow-partial`              | Permit an analyzed-subset estimate                                 |
| `--strict`                     | Return incomplete exit for warning diagnostics                     |
| `--no-color`                   | Disable terminal color                                             |
| `-h, --help`                   | Print command help                                                 |

## Estimate, inspect and explain

`estimate` analyzes required scope and requests an estimate when its preconditions hold. `inspect` returns an analysis envelope with null estimates. `explain` returns the same effort values as `estimate` plus detailed ledger output. JSON is a versioned `ReportEnvelope`; text renderers are presentation formats. See [the output contract](output-schema.md).

Measurement fields can be explicitly `unavailable`; an unavailable value is not a measured zero. Error envelopes have null analysis and estimates. Partial envelopes can carry an analyzed-subset estimate with `fullScopeEstimate: null`. Fingerprints identify source/config/analysis inputs without a timestamp; they are not a security attestation or source-redaction guarantee.

The report schema version is <!-- docs:fact report-schema-version -->1.1.0. It is independent of the tool, model, metrics and indicator versions.

## Partial analysis and exit codes

An incomplete required analysis normally has no estimate. `--allow-partial` permits an estimate over the analyzed subset when eligible measured SLOC remains; it does not make the full project complete. Both cases use exit 4. A strict warning can also return exit 4 while the envelope remains `complete`. Check the envelope status and coverage rather than inferring them from the process code alone.

Default behavior:

<!-- docs:case partial-default -->

```sh
audit-estimator estimate examples/projects/partial --format json --no-config
```

Explicit analyzed-subset behavior:

<!-- docs:case partial-allow -->

```sh
audit-estimator estimate examples/projects/partial --format json --no-config --allow-partial
```

## Command contracts

The process codes are 0 for a complete result, 1 for an internal failure, 2 for usage/configuration errors, 3 for target or empty-scope errors, 4 for incomplete analysis or strict warnings, 5 for output failures, and 130 for interruption. Exit status and envelope status are related but not interchangeable.

`--output` resolves its path from the process current working directory, which can differ from the selected project root. Parent directories must already exist. Existing output is refused unless `--force` is set; force replaces only an eligible regular report file, not protected source, configuration or readiness inputs. JSON errors can still be returned on stdout when report writing fails. `--config` selects an explicit config file and cannot be combined with `--no-config`; `--no-config` disables automatic config discovery.

To exclude the Solidity sources under the simple fixture, quote the glob so the command receives it as one argument:

<!-- docs:case exclude-glob -->

```sh
audit-estimator inspect examples/projects/simple --format json --no-config --exclude "src/**"
```

Help is available without a target:

<!-- docs:illustrative -->

```console
audit-estimator --help
```

The canonical registered examples cover exact help contracts in the E2E suite; this console line is illustrative command syntax.
