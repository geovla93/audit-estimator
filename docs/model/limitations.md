# Model limitations

`heuristic-v1` ([specification](heuristic-v1.md)) is an uncalibrated heuristic. This document lists what it cannot see, separates input incompleteness from human-productivity uncertainty, and gives illustrative manual adjustments. See [alternatives](alternatives.md) for the method comparison.

## What the model cannot see

- **SLOC layout and density.** SLOC is the only size driver. Formatting, per-file density and a few very dense files versus many sparse ones change the real effort without changing the formula. The control premium uses a per-file decision-density cap, which is a coarse signal.
- **Business complexity.** Invariants, economic design and protocol novelty are not parsed. They are human inputs, not coefficients.
- **Selective scope.** Only scoped files are charged. Scoped-out first-party dependencies are disclosed and never claimed audited. A narrow scope that depends on large out-of-scope code understates real review needs.
- **Unmodified library assumptions.** Imported shared code receives no baseline unless explicitly scoped or promoted. The model does not know whether a library is unmodified.
- **Dynamic dispatch.** Ordinary internal calls stay dynamic and create no pairs. The interaction and boundary charges count only statically resolved cross-contract pairs, so the formula misses runtime-resolved coupling.
- **Capped semantics.** Each premium channel is capped at `q=1` and counted once. Large numbers of loops, mappings or delegatecall sites cannot add more than one channel, even where real review effort grows.
- **Uncharged observations.** Unused imports, free functions and interface-only files are reported but not charged by the pair formula. This is a known limitation and a prompt for a manual adjustment.
- **Review-policy variation.** Reviewer seniority, number of reviewers, duplicate independent reviews, fix verification and depth differ between firms. The model assumes one coordinated initial review and says nothing about team parallelism, elapsed time or price.

## Completeness versus productivity uncertainty

Two different kinds of uncertainty are kept apart.

1. **Input completeness and capability.** Did the analysis see all required code, and did it classify what it saw? Incomplete required analysis makes a normal estimate unavailable; an explicit partial mode estimates only the analyzed subset and is labelled `analyzed-subset`. Unclassified semantics set an unknown-semantics flag and add the high-scenario reserve. These are explicit fields, not guesses.
2. **Human productivity uncertainty.** Even with perfect input, auditors differ in speed and review depth. The low and high parameters express planning scenarios only. They have no stated probability, percent accuracy or confidence level, and the reserve is not a statistical interval.

A wide range never substitutes for missing scoped code.

## Optional human assessment prompts

The indicator layer ([indicators](../indicators.md)) supplies eight unanswered prompts. Each may justify an optional manual adjustment. None is converted into an automatic adjustment, and test or coverage readiness stays report-only: it does not change the estimate, the unknown flag or the reserve.

| Prompt key                 | Possible reason to consider a manual adjustment                           |
| -------------------------- | ------------------------------------------------------------------------- |
| `business-invariants`      | Intended behavior and invariants need extra reconstruction.               |
| `protocol-novelty`         | The design is new enough that review needs extra research time.           |
| `external-trust`           | Behavior depends on external systems whose trust assumptions need review. |
| `custom-math-cryptography` | Custom arithmetic or cryptography needs specialist review.                |
| `documentation`            | Poor or missing documentation increases comprehension effort.             |
| `upgrade-lifecycle`        | Upgrade, initialization or migration flows need extra review.             |
| `cross-chain`              | Cross-chain or bridge behavior widens the trust boundary.                 |
| `review-depth`             | The requested depth differs from the assumed coordinated initial review.  |

Adding review phases beyond the assumed initial review (a second independent review, fix verification) expands the estimated work. Any such expansion must be disclosed as a manual adjustment and never hidden in a default.

## Manual adjustment examples

The following objects are **illustrative non-default allowances** that match `ManualAdjustmentSchema`. They are examples of the shape and of an explicit reason, not recommended values and not part of any default profile. Negative adjustments are valid only with a reason, and resulting negative totals are rejected rather than clamped.

Economic novelty:

```json
{
  "id": "illustrative-economic-novelty",
  "reason": "Illustrative: novel incentive design needs additional research and modelling time.",
  "category": "economic-novelty",
  "lowHours": 8,
  "highHours": 24
}
```

Independent second review:

```json
{
  "id": "illustrative-second-review",
  "reason": "Illustrative: a second independent reviewer repeats part of the review by request.",
  "category": "independent-second-review",
  "lowHours": 12,
  "highHours": 30
}
```

Poor documentation:

```json
{
  "id": "illustrative-poor-documentation",
  "reason": "Illustrative: no specification exists, so intended behavior must be reconstructed from code.",
  "category": "documentation",
  "lowHours": 4,
  "highHours": 16
}
```

Fix verification:

```json
{
  "id": "illustrative-fix-verification",
  "reason": "Illustrative: fix verification is outside the base model and is declared separately.",
  "category": "fix-verification",
  "lowHours": 6,
  "highHours": 14
}
```

Reasoned discount:

```json
{
  "id": "illustrative-prior-review-discount",
  "reason": "Illustrative: a prior independent review of the same commit is documented and reused.",
  "category": "discount",
  "lowHours": -4,
  "highHours": -2
}
```
