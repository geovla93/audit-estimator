import { sortById } from '../domain/canonical.ts';
import type { Analysis, EvidenceRef, Measurement, SourceRange } from '../domain/types.ts';
import { REASON_SCOPED_FILE_UNAVAILABLE } from './definitions.ts';
import type { FileMetrics } from './structural.ts';

function measured<T>(value: T, evidence: readonly EvidenceRef[]): Measurement<T> {
  return { status: 'measured', value, evidence };
}

function unavailable<T>(reason: string): Measurement<T> {
  return { status: 'unavailable', reason };
}

function measuredLines(file: FileMetrics, field: 'physicalLines' | 'sourceLines'): number {
  const measurement = file.file[field];
  if (measurement.status !== 'measured') {
    throw new TypeError(`Expected a measured ${field} for a parsed file.`);
  }
  return measurement.value;
}

function declarationEvidence(
  files: readonly FileMetrics[],
  select: (file: FileMetrics) => readonly { readonly id: string; readonly range: SourceRange }[],
): Measurement<number> {
  const distinct = new Map<string, EvidenceRef>();
  for (const file of files) {
    for (const item of select(file)) {
      if (!distinct.has(item.id)) {
        distinct.set(item.id, { fileId: file.file.fileId, range: item.range });
      }
    }
  }
  const ordered = sortById([...distinct].map(([id, evidence]) => ({ id, evidence })));
  return measured(
    ordered.length,
    ordered.map((item) => item.evidence),
  );
}

/**
 * Scoped project totals. Only scoped files contribute, file line counts are summed (never contract
 * line counts, which may overlap), and identical content at different paths is never discounted.
 */
export function aggregateMetrics(files: readonly FileMetrics[]): Analysis['aggregates'] {
  const seen = new Set<string>();
  for (const metrics of files) {
    if (seen.has(metrics.file.fileId)) {
      throw new TypeError(`Duplicate file in aggregate input: ${metrics.file.fileId}`);
    }
    seen.add(metrics.file.fileId);
  }
  const scoped = sortById(
    files
      .filter((metrics) => metrics.file.role === 'scoped')
      .map((metrics) => ({ id: metrics.file.fileId, metrics })),
  ).map((item) => item.metrics);
  const wholeFiles = scoped.map((metrics) => metrics.wholeFile);

  const physical = scoped.reduce(
    (sum, metrics) => sum + measuredLines(metrics, 'physicalLines'),
    0,
  );
  const physicalLines = measured(physical, physical === 0 ? [] : wholeFiles);
  const scopedFiles = measured(scoped.length, wholeFiles);

  if (scoped.some((metrics) => !metrics.file.syntaxComplete)) {
    return {
      scopedFiles,
      physicalLines,
      sourceLines: unavailable(REASON_SCOPED_FILE_UNAVAILABLE),
      contracts: unavailable(REASON_SCOPED_FILE_UNAVAILABLE),
      callables: unavailable(REASON_SCOPED_FILE_UNAVAILABLE),
    };
  }

  const source = scoped.reduce((sum, metrics) => sum + measuredLines(metrics, 'sourceLines'), 0);
  return {
    scopedFiles,
    physicalLines,
    sourceLines: measured(source, source === 0 ? [] : wholeFiles),
    contracts: declarationEvidence(scoped, (metrics) =>
      metrics.contracts.map((contract) => ({ id: contract.id, range: contract.range })),
    ),
    callables: declarationEvidence(scoped, (metrics) =>
      metrics.callables.map((callable) => ({ id: callable.id, range: callable.range })),
    ),
  };
}
