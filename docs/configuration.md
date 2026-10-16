# Configuration and scope

Audit Estimator analyzes a local project tree. Scope selection controls which Solidity files are eligible for analysis, which files provide required context, and which observed paths are excluded. It does not infer security importance from names or directory conventions.

## Project roots

The target may be a directory or one Solidity file. When no explicit source roots or include patterns are configured, discovery uses existing `src/` and `contracts/` directories; if neither is present, it considers the target directory. Foundry metadata contributes default-profile source roots, library roots and remappings as data. It does not evaluate profiles, environment interpolation, shell commands or Solidity compilation. Hardhat is recognized by convention markers; JavaScript or TypeScript configuration files are not loaded or executed.

`--root` sets the project root, and the input must resolve inside it. Without `--root`, a directory input is its own root and a file input uses its containing directory. Automatic configuration is read from `audit-estimator.config.json` at that project root. An explicit `--config` path is resolved from the CLI process working directory; path values inside that file are interpreted relative to the config file's directory and must normalize to locations inside the project root. `--config` and `--no-config` are mutually exclusive.

Use `sourceRoots` for a custom layout. Remappings and configured roots remain confined to the project root. Files reached through imports may be retained as context even when they are not first-party estimate scope. A directory name such as `lib`, `vendor`, `deps` or `node_modules` is a third-party ownership signal. A scoped file with known third-party ownership is not silently promoted; an explicit first-party override is required. Conflicting aliases can remain `unknown`.

## Include and exclude patterns

Patterns use a bounded glob grammar implemented by the project; they are not passed to a shell. `/` separates path segments; `*` and `?` match within one segment, while `**` is the only recursive segment and must occupy a whole segment. A segment can contain at most one `*`. Braces, character classes, extglobs, negation, absolute paths, backslashes and `.`/`..` segments are rejected. A non-empty `include` list selects matching candidate paths and makes the target directory the candidate base. `exclude` removes matching paths. Include and exclude patterns are evaluated against both lexical and physical aliases when symlink following is enabled. There is no automatic `.gitignore` interpretation.

Metadata exclusions and the hard `.git` exclusion still apply. Default exclusions are enabled unless `defaultExcludes` is disabled; they cover common dependency, build, generated, test and deployment trees, as well as `*.t.sol` and `*.s.sol` files. A matching exclude does not always prune descendants: recursive pruning requires `**` or a trailing `/**`. Symlinks are not followed by default. When `followSymlinks` is explicitly enabled, traversal remains confined to the physical project root. pnpm store links outside that root are not treated as safe project files.

Ownership is separate from scope role. Paths below dependency segments such as `lib`, `vendor`, `deps` and `node_modules`, and configured third-party roots, are classified as third-party. `firstPartyOverrides` can explicitly promote a known dependency path for a project that owns and maintains that code. Conflicting aliases can remain unknown; a path or package name alone does not prove ownership.

The CLI’s repeatable `--include` and `--exclude` values replace the corresponding arrays from lower configuration layers. Arrays do not concatenate. Scalars also replace lower-layer values; absent CLI options leave config values untouched. See the [CLI reference](cli.md) for command flags.

## Config file

The tool discovers `audit-estimator.config.json` at the project root unless disabled. `--config <file>` selects an explicit file; `--no-config` disables loading. Config is data-only JSON, strict about unknown fields, versioned, byte-bounded, and validated before use. It cannot contain executable hooks. Config and CLI values override metadata and defaults according to field provenance.

The current config schema version is <!-- docs:fact config-schema-version -->1.0.0. The [config schema](../schemas/config-v1.schema.json), [model schema](../schemas/model-v1.schema.json), and [model specification](model/heuristic-v1.md) describe the accepted data. The snippets below are complete files validated against the runtime schemas and must stay byte-for-byte synchronized with their fixture files.

This config is included in `examples/projects/simple/audit-estimator.config.json`. It uses the uncalibrated profile and applies a signed adjustment after modeled work and reserve. Run it without `--no-config`:

<!-- docs:json simple-config -->

```json
{
  "configVersion": "1.0.0",
  "model": {
    "profile": "heuristic-v1",
    "parameters": {
      "hoursPerDay": 8
    }
  },
  "manualAdjustments": [
    {
      "id": "scope-correction",
      "reason": "Remove time for deployment work excluded from this review.",
      "category": "scope correction",
      "lowHours": -0.5,
      "highHours": -0.25
    }
  ],
  "report": {
    "format": "json"
  }
}
```

<!-- docs:case manual-adjustment -->

```sh
audit-estimator estimate examples/projects/simple --format json
```

For a reusable profile file, all parameters below are explicit. Model profile <!-- docs:fact model-profile -->heuristic-v1 and model version <!-- docs:fact model-version -->1.0.0 are independent version facts; neither makes the model calibrated.

<!-- docs:json model-profile -->

```json
{
  "profile": "heuristic-v1",
  "modelVersion": "1.0.0",
  "parameters": {
    "projectHours": { "low": 4, "high": 12 },
    "slocHours": { "low": 0.04, "high": 0.12 },
    "controlPremium": { "low": 0.1, "high": 0.25 },
    "storagePremium": { "low": 0.05, "high": 0.15 },
    "evmPremium": { "low": 0.2, "high": 0.5 },
    "interactionHours": { "low": 0.25, "high": 0.75 },
    "boundaryHours": { "low": 0.5, "high": 2 },
    "unknownReserveHigh": 0.25,
    "hoursPerDay": 8
  }
}
```

## Example project layouts

The [Foundry custom-root example](../examples/projects/foundry-custom/foundry.toml) supplies a custom `src` and a remapped library; the library is context and third-party owned. The [Hardhat example](../examples/projects/hardhat/hardhat.config.js) is an inert marker only; it is never evaluated. This is the complete strict config used by the [dependency example](../examples/projects/dependency/audit-estimator.config.json); it demonstrates explicit roots, dependency ownership and a remapping:

<!-- docs:json dependency-config -->

```json
{
  "configVersion": "1.0.0",
  "scope": {
    "sourceRoots": ["src"],
    "thirdPartyRoots": ["lib"]
  },
  "imports": {
    "remappings": [
      {
        "prefix": "vendor/",
        "target": "lib/vendor"
      }
    ]
  }
}
```

The [partial example](../examples/projects/partial/src/Broken.sol) contains malformed Solidity so the command contract can demonstrate incomplete analysis.

The installed Slang grammar inventory spans versions 0.4.11 through 0.8.37. Tests exercise representative grammar fixtures within that inventory; the range is not a claim of full compiler compatibility or equivalent semantic analysis for every Solidity release. The [research report](research/slang-spike.md) records the fixture matrix and parser boundary.

<!-- docs:case foundry-custom -->

```sh
audit-estimator estimate examples/projects/foundry-custom --format json --no-config
```

<!-- docs:case hardhat-convention -->

```sh
audit-estimator inspect examples/projects/hardhat --format json --no-config
```

<!-- docs:case dependency-context -->

```sh
audit-estimator inspect examples/projects/dependency --format json
```

These are local data fixtures, not complete deployable projects. No fixture script, config executable, compiler, package manager or external dependency is run. Their original authorship and redistribution status are recorded in [examples/README](../examples/README.md).
