# Audit report

## Overview

- Command: estimate
- Status: partial

**Analyzed subset. Full-scope effort unavailable.**

**Auditor effort scenario:** 8 to 30 auditor hours; 1 to 3.8 auditor days.

**uncalibrated heuristic.** Effort, not elapsed delivery time. Scenario bounds have no probability or accuracy claim.

## Scope and completeness

- Manifest scoped entries: 1
- Manifest context entries: 1
- Manifest excluded entries: 0
- Syntax-complete scoped records: 1
- Reported unavailable IDs: file&#x3a;lib&#x2f;Ctx&#x2e;sol
- Required analysis complete: false
- Unknown semantics reported: true

## Scoped aggregate measurements

| Measure | Supplied value and evidence |
| --- | --- |
| Scoped files | measured 1; evidence: none supplied |
| Physical lines | measured 125; evidence: none supplied |
| Source lines | measured 100 SLOC; evidence: none supplied |
| Contracts | measured 0; evidence: none supplied |
| Callables | measured 0; evidence: none supplied |

## Contracts

| Contract ID | Path | Name | Declaration kind | SLOC | State variables |
| --- | --- | --- | --- | --- | --- |

## Graph resolution

| Resolution | Count |
| --- | --- |
| resolved-unique | 0 |
| ambiguous | 0 |
| unresolved | 0 |
| unsupported | 0 |

## Indicators requiring human assessment

- none supplied

## Readiness observations

- No readiness measurements supplied.
- Readiness observations do not change report status or effort.

## Diagnostics and limitations

- **warning / parse / PARTIAL_ANALYSIS:** Required context analysis failed&#x2e;; file file&#x3a;lib&#x2f;Ctx&#x2e;sol 1:6-1:11 [bytes 5-10]; details source=application companion, observation=not enumerated
- **Limitation:** Scoped syntax is complete&#x3b; required context work is incomplete&#x2e;

## Manifest entries

| Path | Role | Ownership | File ID | Ownership evidence |
| --- | --- | --- | --- | --- |
| lib&#x2f;Ctx&#x2e;sol | context | third-party | file&#x3a;lib&#x2f;Ctx&#x2e;sol | file&#x3a;lib&#x2f;Ctx&#x2e;sol 1:6-1:11 [bytes 5-10] |
| src&#x2f;A&#x2e;sol | scoped | first-party | file&#x3a;src&#x2f;A&#x2e;sol | file&#x3a;lib&#x2f;Ctx&#x2e;sol 1:16-1:21 [bytes 15-20]; file&#x3a;src&#x2f;A&#x2e;sol 1:6-1:11 [bytes 5-10] |

## File metrics

| Path | Role | Ownership | File ID | Supplied metrics and evidence |
| --- | --- | --- | --- | --- |
| src&#x2f;A&#x2e;sol | scoped | first-party | file&#x3a;src&#x2f;A&#x2e;sol | Physical lines: measured 125; evidence: none supplied; Source lines: measured 100; evidence: none supplied; Contracts: measured 0; evidence: none supplied; Abstract contracts: measured 0; evidence: none supplied; Libraries: measured 0; evidence: none supplied; Interfaces: measured 0; evidence: none supplied; Decisions: measured 0; evidence: none supplied; Loops: measured 0; evidence: none supplied; Maximum loop depth: measured 0; evidence: none supplied; Assembly blocks: measured 0; evidence: none supplied; Yul statements: measured 0; evidence: none supplied; Yul calls: measured 0; evidence: none supplied; Yul control flow: measured 0; evidence: none supplied; Low-level call candidates: measured 0; evidence: none supplied; Import IDs: none; Contract IDs: none; Callable IDs: none; Syntax complete: true; State variables: State variable count: measured 0; evidence: none supplied; State variables: Mutable state variable count: measured 0; evidence: none supplied; State variables: Complex mutable declaration IDs: measured none; evidence: none supplied; State variables: Type shapes: measured none; evidence: none supplied |

## Contract details

| Name | Kind | Path | Contract ID | Source range | SLOC | Callable IDs | State variable details |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Callable details

| Name | Kind | File ID | Contract ID | Callable ID | Range | Visibility | Mutability | Body | Control metrics | Assembly and Yul | Low-level candidates | Modifiers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Graph details

| Edge ID | Kind | From | To | Resolution | Candidate targets | Evidence |
| --- | --- | --- | --- | --- | --- | --- |

## Indicators

| ID | Category | Evidence kind | Confidence | Requires assessment | Rule version | Summary | Evidence | Limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Readiness measurements

| Observation | Supplied value and evidence |
| --- | --- |
| Readiness | No readiness measurements supplied. |

## Completeness IDs and flags

- Analyzed file IDs: file&#x3a;src&#x2f;A&#x2e;sol
- Reported unavailable file IDs: file&#x3a;lib&#x2f;Ctx&#x2e;sol
- Required analysis complete: false
- Unknown semantics: true

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

## Estimate

- Label: uncalibrated heuristic
- Model: heuristic-v1 1.1.0
- Coverage: analyzed-subset
- Auditor hours: 8 to 30
- Auditor days: 1 to 3.8
- Effort, not elapsed delivery time. Scenario bounds have no probability or accuracy claim.

### Effective parameters and units

| Parameter | Supplied value | Unit |
| --- | --- | --- |
| projectHours | 4 to 12 | auditor-hours/project |
| slocHours | 0.04 to 0.12 | auditor-hours/SLOC |
| controlPremium | 0.1 to 0.25 | fraction of file baseline at q=1 |
| storagePremium | 0.05 to 0.15 | fraction of file baseline at q=1 |
| evmPremium | 0.2 to 0.5 | fraction of file baseline at q=1 |
| interactionHours | 0.25 to 0.75 | hours/unique scoped directed pair |
| boundaryHours | 0.5 to 2 | hours/unique context boundary pair |
| unknownReserveHigh | 0.25 | high-only fraction of pre-manual subtotal |
| hoursPerDay | 8 | conversion convention |

### Contribution ledger in supplied order

| Opaque row ID | Category | Microhours | Input status | Parameter mapping | Explanation |
| --- | --- | --- | --- | --- | --- |
| baseline&#x3a;golden | baseline | 4000000 to 12000000 microhours | measured | slocHours | SLOC baseline for one eligible file&#x3a; measured lines times the SLOC hour rate &#x28;uncalibrated assumption&#x29;&#x2e; |
| project | project | 4000000 to 12000000 microhours | measured | projectHours | Fixed project allowance &#x28;uncalibrated assumption&#x29;&#x2c; charged once&#x2e; |
| reserve | reserve | 0 to 6000000 microhours | measured | unknownReserveHigh | High&#x2d;scenario uncertainty reserve on the rounded pre&#x2d;manual high subtotal&#x3b; the low scenario has none &#x28;uncalibrated assumption&#x29;&#x2e; |

Contribution IDs are opaque and do not identify files or edges. A zero-valued unavailable row means the premium was omitted, not measured as zero.

### Assumptions in supplied order

- Every coefficient is an uncalibrated planning assumption&#x2c; not a measured productivity or industry rate&#x2e;
- Low and high are scenario bounds with no stated probability&#x2c; percentage accuracy or confidence level&#x2e;
- Hours are cumulative initial&#x2d;review effort across participating auditors and exclude remediation&#x2c; fix verification&#x2c; duplicate independent reviews&#x2c; proofs and calendar time unless added as manual adjustments&#x2e;

### Manual adjustments in supplied order

| Adjustment ID | Category | Signed range | Reason |
| --- | --- | --- | --- |

Manual adjustment hashes cannot be reversed or matched to contribution rows by index.

Model formulas are defined in `docs/model/heuristic-v1.md`.
