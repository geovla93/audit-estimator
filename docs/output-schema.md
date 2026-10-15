# Report output contract

The report renderers consume one validated `ReportEnvelope`. They do not discover files, inspect source, read the environment or recalculate an estimate. All three functions validate at runtime with `ReportEnvelopeSchema`; malformed input throws. A producer emits the exact schema version it implements (`1.0.0`). The strict producer schema rejects unknown keys and future versions even when a newer version is compatible. A separate consumer may accept additive `1.x` fields and diagnostic codes while rejecting an unknown major.

```ts
export function serializeJson(envelope: ReportEnvelope): string;
export function formatTerminal(envelope: ReportEnvelope, options?: TerminalFormatOptions): string;
export function formatMarkdown(envelope: ReportEnvelope): string;

export interface TerminalFormatOptions {
  readonly detail?: boolean | undefined;
  readonly color?: boolean | undefined;
}
```

`serializeJson` emits two-space pretty JSON, canonical object-key order, normalized set-like collections and exactly one final LF. It adds no renderer fields. `formatTerminal` defaults to detailed output for `explain` and summary output otherwise. An explicit `detail` value overrides that choice. Color is off by default; `color: true` adds only fixed renderer-owned status and heading styles after input text has been sanitized. `formatMarkdown` always includes full detail.

## Collection order

Renderers sort copies for the collections below. They retain duplicates and never mutate the envelope. All other arrays retain their supplied order. Object keys use Unicode code point order, including astral characters.

| Collection                                                                                                                   | Order                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `scope.entries`, `analysis.files`                                                                                            | Code point order by `fileId`                    |
| `analysis.contracts`, `analysis.callables`, `analysis.graphs`, `analysis.indicators`                                         | Code point order by `id`                        |
| Scope role IDs, completeness IDs, file import/contract/callable IDs, contract callable IDs, graph candidate targets          | Code point order by string value                |
| `analysis.testObservations`                                                                                                  | Path, then canonical record as a tie-breaker    |
| Measurement evidence, ownership evidence, graph and indicator evidence                                                       | `fileId`, byte start/end, line/column start/end |
| Measured complex mutable declaration IDs                                                                                     | String value                                    |
| Measured type shapes                                                                                                         | Declaration ID, then canonical record           |
| Contributions, manual adjustments, assumptions, applied modifiers, diagnostics and details, limitations, and unlisted arrays | Supplied order                                  |

Ledger order is meaningful and is preserved. The engine already emits contribution rows in its stable production order. Renderer normalization does not change a supplied fingerprint or prove that arithmetic, references or cross-field relationships are semantically correct.

## Status, scope and measurements

`complete`, `partial` and `error` share one envelope. An error has no analysis or estimates, although it may carry a manifest describing the scope that was discovered before failure. Partial output is labeled **analyzed subset**; an estimate, when present, must have `coverage: "analyzed-subset"`, and full-scope effort is unavailable. A required context failure can make the report partial while every scoped source record remains syntax complete. Optional readiness observations do not change status, coverage or effort.

Summary counts are explicitly labeled as manifest scoped, context and excluded entries. They do not claim to be selected-file totals. Syntax-complete scoped records count only supplied `analysis.files` whose role is `scoped` and whose syntax is complete. Reported unavailable IDs come from `analysis.completeness.unavailableFileIds`. Unread paths, pruned directory entries and selection totals are not present in the envelope and are never inferred or fabricated; 013 must preserve those observations in diagnostics or limitations.

Every measurement is either `measured` with a value and evidence references, or `unavailable` with a reason. An unavailable value is never printed as numeric zero. Detailed terminal and Markdown output retain each supplied evidence reference. Per-contract SLOC may overlap; project SLOC is represented by the supplied scoped aggregate and is not recomputed by adding contract rows. Declaration kind, ownership and scope role remain separate properties; a library declaration is not an ownership classification.

Graph candidates are candidates, not confirmed targets. Dynamic internal calls remain unproven dispatch. The public graph cannot provide every internal relationship companion fact; renderers do not serialize companion objects or infer a builtin count from low-level call candidates. Supplied readiness data may describe a matched subset whose provenance is unverified. It is not a security score and does not add effort.

## Effort and assumptions

The current model label is **uncalibrated heuristic**. Displayed values are cumulative auditor effort, not elapsed delivery time or a commercial quote. Hour and day endpoints are copied exactly from the estimate. They are scenario bounds without probabilities or accuracy claims. A renderer does not convert days using `hoursPerDay`, round endpoints or run the estimator.

Contribution rows contain signed integer microhours, a category, input status and explanation. The effective model parameters are rendered with their documented units. A zero-valued contribution with `inputStatus: "unavailable"` means the premium was omitted; it does not mean the metric was observed as zero. Contributions are public rows only: their opaque IDs do not reveal file or edge associations. Manual adjustments have separate reasoned IDs and signed hour ranges. Their IDs cannot be reversed or paired with contribution rows by list position. The normative formulas and limitations are in [the heuristic-v1 model](model/heuristic-v1.md).

## Fingerprints and source privacy

Fingerprints are supplied by the application and remain unchanged. They contain no timestamp or renderer metadata. JSON keeps original labels as escaped string data; human formats replace terminal controls and escape Markdown syntax so labels stay inert. Structured project-relative paths are validated by the schema. Free-form diagnostic messages are application-supplied prose and cannot be reliably scanned for native paths or source snippets; the application must redact public prose before it builds the envelope. Renderers never add Solidity excerpts, machine paths, active links, stacks or current-time metadata. URL-like filenames remain inert data.

The runtime schemas include cross-field refinements that the generated Draft 2020-12 JSON Schemas do not express. Consumers should validate against the stable fields they use and tolerate compatible optional additions rather than assuming the generated document captures every runtime invariant.

## Forward-compatible consumer example

This consumer reads only stable envelope fields, accepts unknown compatible fields and diagnostic codes, and rejects an unsupported schema major.

```ts
import { z } from 'zod';

const stableEnvelope = z.looseObject({
  schemaVersion: z.string(),
  toolVersion: z.string(),
  command: z.enum(['estimate', 'inspect', 'explain']),
  status: z.enum(['complete', 'partial', 'error']),
  diagnostics: z.array(
    z.looseObject({
      code: z.string().min(1),
      severity: z.enum(['info', 'warning', 'error']),
      message: z.string(),
    }),
  ),
});

export function readReport(input: unknown) {
  const report = stableEnvelope.parse(input);
  const major = report.schemaVersion.split('.', 1)[0];
  if (major !== '1') throw new Error('Unsupported report schema major');
  return report;
}
```
