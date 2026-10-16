# Example provenance

Every Solidity and JSON example in this directory was created in-repository for Plan 016 as a small, data-only local test fixture. No external project code, generated third-party source or upstream snippet is included. The Solidity text is intentionally minimal and does not represent production contracts.

No license grant is asserted. Local tests may read these original fixtures; public redistribution awaits owner approval.

The `hardhat.config.js` file is only a marker for convention detection. It contains no configuration values or project logic; only an empty module declaration to satisfy repository lint. The estimator never loads it. The Foundry TOML and JSON config files are read as bounded data only. Tests copy fixtures to an operating-system temporary directory and execute only the trusted built Audit Estimator CLI with registered argument arrays.
