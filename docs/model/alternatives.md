# Estimation alternatives

This document records why `heuristic-v1` ([specification](heuristic-v1.md)) is an additive expert work breakdown, and what was compared. No source below validates any coefficient in the model. The reviewed sources did not establish a reusable, matched benchmark of audit effort. That is a statement about what was reviewed, not a claim that no such dataset exists anywhere.

## Source applicability

| Source                                                                                              | What it covers                                                       | Why it does not validate these coefficients                                                                               |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [Menzies et al., Negative Results for Software Effort Estimation](https://arxiv.org/abs/1609.05563) | COCOMO-style parametric estimation on software-development datasets. | It studies development effort, not audit effort, and its datasets are not audit engagements.                              |
| [Shepperd and Schofield, analogy-based estimation](https://bura.brunel.ac.uk/handle/2438/1101)      | Estimation by analogy to completed projects with known effort.       | It needs a repository of completed projects with known effort. No matched audit repository was available to this project. |
| [OpenZeppelin, GEB protocol audit](https://www.openzeppelin.com/news/geb-protocol-audit)            | A public audit report identifying scope, staffing and elapsed weeks. | It gives no phase-hours or utilization, so it cannot be matched to exact scope and hours.                                 |

## Methods compared

| Method                         | Strength                                                           | Weakness for this tool                                                                                  | Decision                                                            |
| ------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| SLOC-only productivity         | Trivial to compute and explain.                                    | One rate hides control, storage and low-level review differences, and is sensitive to layout and style. | Kept only as the baseline size driver.                              |
| Parametric (COCOMO-style)      | Established structure of size times effort multipliers.            | Its multipliers were fitted to development projects. Reusing them for audits would invent a transfer.   | Not adopted. Coefficients are not transferred.                      |
| Historical analogy             | Reflects real outcomes when comparable projects exist.             | Needs historical projects with matched scope and hours, which are absent today.                         | Deferred to the [calibration protocol](../calibration/protocol.md). |
| Additive expert work breakdown | Every line of the estimate has a named cause and an editable unit. | Coefficients are expert assumptions until calibrated.                                                   | **Chosen** for explainability and the absent dataset.               |

The additive breakdown keeps each assumption visible and replaceable: a baseline from SLOC, three capped premium channels, pair allowances, a fixed project allowance, a separate high-scenario reserve and explicit manual adjustments. It claims nothing about security quality, price or elapsed time, and it does not transfer coefficients from any compared method.

## Why not add more channels now

Privilege patterns, upgradeability, custom math or cryptography, protocol novelty and test presence have plausible effort effects, but no matched data supports a coefficient. Adding them as automatic multipliers would turn guesses into hidden precision and would risk double counting with the SLOC and control channels. They stay human prompts and manual adjustments (see [limitations](limitations.md)) until a calibration study supports them.
