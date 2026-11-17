# Audit report

## Overview

- Command: estimate
- Status: error
- Failure category: target

**Effort unavailable:** Target could not be read&#x2e;; No analysis was produced&#x2e;

## Diagnostics and limitations

- **error / discovery / TARGET_UNREADABLE:** Target could not be read&#x2e;; file file&#x3a;src&#x2f;A&#x2e;sol 1:6-1:11 [bytes 5-10]; details source=application companion, observation=not enumerated
- **Limitation:** No analysis was produced&#x2e;

## Manifest entries

| Path | Role | Ownership | File ID | Ownership evidence |
| --- | --- | --- | --- | --- |
| src&#x2f;A&#x2e;sol | scoped | first-party | file&#x3a;src&#x2f;A&#x2e;sol | file&#x3a;lib&#x2f;Ctx&#x2e;sol 1:16-1:21 [bytes 15-20]; file&#x3a;src&#x2f;A&#x2e;sol 1:6-1:11 [bytes 5-10] |

## Versions and fingerprints

| Field | Value |
| --- | --- |
| Report schema | 1&#x2e;1&#x2e;0 |
| Tool | 0&#x2e;1&#x2e;0 |
| Parser | slang&#x40;1&#x2e;3&#x2e;9 |
| Metrics | 1&#x2e;0&#x2e;0 |
| Indicators | 1&#x2e;0&#x2e;0 |
| Model | 1&#x2e;1&#x2e;0 |
| Sources fingerprint | 0000000000000000000000000000000000000000000000000000000000000000 |
| Semantic config fingerprint | 1111111111111111111111111111111111111111111111111111111111111111 |
| Analysis fingerprint | 2222222222222222222222222222222222222222222222222222222222222222 |

Model formulas are defined in `docs/model/heuristic-v1.md`.
