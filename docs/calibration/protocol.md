# Calibration and evaluation protocol

This is a protocol for a **future, consented** study. It is a document, not data-acquisition or fitting tooling, and it contains no collected data. `heuristic-v1` ([specification](../model/heuristic-v1.md)) is uncalibrated; nothing here validates it. Acquisition, fitting code and any label, version or schema change are separate post-MVP work. A calibrated model must be proposed as a new profile and must preserve the original profile and fixtures.

## Data dictionary

Missing values are recorded explicitly (see the representation column) and are never recorded as zero.

| Field                  | Unit or type                                       | Required | Missing or censored representation                  | Provenance                              |
| ---------------------- | -------------------------------------------------- | -------- | --------------------------------------------------- | --------------------------------------- |
| `engagementId`         | pseudonymous string                                | required | not allowed                                         | assigned by the data steward            |
| `projectId`            | pseudonymous string                                | required | not allowed                                         | assigned by the data steward            |
| `familyId`             | pseudonymous string (forks, diffs)                 | required | not allowed                                         | assigned by the data steward            |
| `sourceScope`          | frozen file list                                   | required | not allowed                                         | frozen at engagement start              |
| `sourceCommit`         | commit identifier                                  | required | not allowed                                         | frozen at engagement start              |
| `sourceHash`           | content hash of the scoped files                   | required | not allowed                                         | computed by the steward                 |
| `sourceAvailability`   | enum: public, restricted, withheld                 | required | `withheld` marks unalignable metrics                | contributor declaration                 |
| `sourceLicense`        | license identifier                                 | required | `unknown` blocks publication                        | contributor declaration                 |
| `metricsVersion`       | version string                                     | required | not allowed                                         | tool output                             |
| `parserVersion`        | version string                                     | required | not allowed                                         | tool output                             |
| `modelVersion`         | version string                                     | required | not allowed                                         | tool output                             |
| `indicatorsVersion`    | version string                                     | required | not allowed                                         | tool output                             |
| `reviewPolicy`         | structured text (phases, depth, duplicate reviews) | required | `undeclared` makes rows ineligible for fitting      | contributor declaration                 |
| `hoursPreparation`     | auditor-hours, number                              | optional | `missing`, interval, or left/right-censored marker  | contributor timesheet or declaration    |
| `hoursReview`          | auditor-hours, number                              | optional | `missing`, interval, or left/right-censored marker  | contributor timesheet or declaration    |
| `hoursInteractions`    | auditor-hours, number                              | optional | `missing`, interval, or left/right-censored marker  | contributor timesheet or declaration    |
| `hoursReport`          | auditor-hours, number                              | optional | `missing`, interval, or left/right-censored marker  | contributor timesheet or declaration    |
| `hoursReReview`        | auditor-hours, number                              | optional | `missing`, interval, or left/right-censored marker  | contributor timesheet or declaration    |
| `staffSeniority`       | enum levels with counts                            | optional | `missing`                                           | contributor declaration                 |
| `staffParticipation`   | headcount and share of time                        | optional | `missing`                                           | contributor declaration                 |
| `excludedDependencies` | list of out-of-scope dependencies                  | required | empty list means none                               | frozen at engagement start              |
| `domainNovelty`        | enum plus free text                                | optional | `not-assessed`                                      | contributor declaration                 |
| `manualFactors`        | list of the manual factors considered              | optional | empty list means none                               | contributor declaration                 |
| `originalEstimate`     | profile, parameters, hours range                   | required | not allowed                                         | recorded before actual hours were known |
| `originalAdjustments`  | list of manual adjustments                         | required | empty list means none                               | recorded before actual hours were known |
| `estimateRecordedAt`   | timestamp, research record only                    | required | `missing` makes the row unusable for leakage checks | consented research record               |

Research records may contain consented estimate-before-actual timing evidence. Canonical product reports remain timestamp-free.

## Eligibility and target hours

The target is matched **initial-review hours**, meaning the work defined by the model's scope. Remediation, fix verification, independent duplicate review and commercial work are excluded unless a row's review policy separately declares them. Excluded phase-hours are kept in separate fields and never merged into the target.

- Record missing, interval and left- or right-censored hours explicitly. Never record them as zero.
- Do not derive hours by multiplying calendar weeks by an assumed utilization.
- Rows whose source scope or review policy cannot be aligned with the model scope are ineligible for supervised fitting and point-error scoring.
- Censored and interval rows need an explicit, separate evaluation method and denominator before they are scored.
- Retain both the original manual-adjusted estimate and a no-manual baseline estimate to expose outcome leakage through manual adjustments.
- Keep technical hours separate from price and engagement dates.

## Splits and leakage

- Split by project family and by time. Forks and diff audits of the same codebase belong to one family and never straddle train, validation and holdout.
- Hold out the most recent eligible rows chronologically for evaluation.
- Fit features, preprocessing and coefficients on training data only. Choose among candidates on validation data. Lock every choice before the final holdout is opened.
- If family isolation and time order leave too few independent groups, report insufficiency and defer fitting. Do not weaken the splits to obtain a result.

## Baselines and evaluation

Compare at least these baselines on the same held-out eligible rows:

1. The unchanged starter profile `heuristic-v1`.
2. A training-only fitted SLOC model.
3. Expert estimates recorded before the actual hours were known.

Fit few, nonnegative, identifiable coefficients locally. Inspect collinearity, residuals, review policy and data quality before adding any weight or channel.

Report, on held-out eligible rows: absolute error in hours; signed bias; scenario interval containment and width; relative error only for positive actual hours under a declared small-project and denominator policy; and subgroup and family failures. Any point summary (for example the midpoint) is for research scoring only. It is not a product point prediction and not a promised quantile. Do not select a model solely by MMRE or by training fit. Report exclusions, uncertainty and sample size. Pre-register acceptance criteria before the holdout is evaluated once data exists. No threshold is fabricated now, and empirical containment is not a promised confidence level.

## Consent and publication

- Obtain separate consent for collection, for use and for publication.
- Define access, retention and deletion policy before collection.
- Anonymize identifiers and review licensing and provenance of any source material.
- Publish only approved rows.
- Maintain model cards and versioned profiles, and record training, validation and holdout lineage.

## Model lifecycle

- A calibrated model is a new profile and version. It must not rewrite historical report assumptions or hide parser changes.
- Preserve the original `heuristic-v1` profile and fixtures when proposing a calibrated model.
- Any change to labels, versions or schemas is separate reviewed work.
- The unit test for this plan checks only the document structure and the deferred verification boundary. It contains no records and no accuracy test, and it establishes no predictive accuracy.

## Deferred verification boundary

Plan 010 verifies the structure of this protocol. Whether any model predicts audit effort can only be established by a consented study that follows it.
