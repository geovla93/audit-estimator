import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  EstimateInputSchema,
  EstimateResultSchema,
  FileIdSchema,
  ManualAdjustmentSchema,
  ModelProfileSchema,
} from '../../src/domain/schemas.ts';
import type {
  EstimateInput,
  EstimateResult,
  ModelParameters,
  ModelProfile,
} from '../../src/domain/types.ts';

// These tests validate frozen literals and documents only. They contain no effort engine:
// plan 011 owns the arithmetic and plan 013 owns source-to-input conversion.

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/estimation/${name}.json`, import.meta.url), 'utf8'),
  ) as unknown;
}

function doc(path: string): string {
  return readFileSync(new URL(`../../docs/${path}`, import.meta.url), 'utf8');
}

const WorkedCaseSchema = z.strictObject({
  id: z.string().min(1),
  group: z.enum(['simple', 'combined', 'unknown', 'evm', 'partial', 'validation', 'variants']),
  description: z.string().min(1),
  input: EstimateInputSchema,
  expected: z.strictObject({
    estimate: EstimateResultSchema.nullable(),
    preciseMicrohours: z.strictObject({ low: z.int(), high: z.int() }).nullable(),
  }),
  application: z.strictObject({
    selectedFileIds: z.array(FileIdSchema),
    omittedFileIds: z.array(FileIdSchema),
    reportStatus: z.enum(['complete', 'partial']),
    fullScopeEstimateExpected: z.boolean(),
  }),
});
type WorkedCase = z.infer<typeof WorkedCaseSchema>;

const InvalidCasesSchema = z.strictObject({
  schema: z.array(
    z.strictObject({
      id: z.string().min(1),
      target: z.enum(['model', 'input', 'result']),
      value: z.unknown(),
      issuePath: z.array(z.union([z.string(), z.number()])),
    }),
  ),
  eligibility: z.array(
    z.strictObject({
      id: z.string().min(1),
      input: EstimateInputSchema,
      expectedEstimate: z.null(),
      reason: z.string().min(1),
    }),
  ),
  engine: z.array(
    z.strictObject({
      id: z.string().min(1),
      input: EstimateInputSchema,
      reason: z.string().min(1),
    }),
  ),
});

const cases: readonly WorkedCase[] = z.array(WorkedCaseSchema).parse(fixture('worked-cases'));
const invalid = InvalidCasesSchema.parse(fixture('invalid-cases'));
const profile: ModelProfile = ModelProfileSchema.parse(fixture('profile'));

const ESTIMATED = cases.flatMap((item) =>
  item.expected.estimate === null ? [] : [{ item, estimate: item.expected.estimate }],
);

function byId(id: string): WorkedCase {
  const found = cases.find((item) => item.id === id);
  if (found === undefined) throw new Error(`Missing worked case ${id}`);
  return found;
}

function estimateOf(id: string): EstimateResult {
  const estimate = byId(id).expected.estimate;
  if (estimate === null) throw new Error(`Worked case ${id} has no estimate`);
  return estimate;
}

function precise(id: string): { readonly low: number; readonly high: number } {
  const value = byId(id).expected.preciseMicrohours;
  if (value === null) throw new Error(`Worked case ${id} has no precise totals`);
  return value;
}

// Independent named constants from the frozen plan: microhours, displayed hours, displayed days.
const NAMED: Readonly<
  Record<
    string,
    {
      readonly micro: readonly [number, number];
      readonly hours: readonly [number, number];
      readonly days: readonly [number, number];
    }
  >
> = {
  simple: { micro: [8_000_000, 24_000_000], hours: [8, 24], days: [1, 3] },
  combined: { micro: [10_200_000, 33_200_000], hours: [10, 34], days: [1.2, 4.3] },
  unknown: { micro: [10_200_000, 40_750_000], hours: [10, 41], days: [1.2, 5.2] },
  'evm-dominance': { micro: [8_800_000, 30_000_000], hours: [8, 30], days: [1, 3.8] },
  'evm-more-delegatecall': { micro: [8_800_000, 30_000_000], hours: [8, 30], days: [1, 3.8] },
  'partial-explicit': { micro: [8_000_000, 24_000_000], hours: [8, 24], days: [1, 3] },
  'failed-context-partial': { micro: [8_000_000, 30_000_000], hours: [8, 30], days: [1, 3.8] },
  'unavailable-storage': { micro: [8_000_000, 30_000_000], hours: [8, 30], days: [1, 3.8] },
  'unavailable-builtin': { micro: [8_000_000, 30_000_000], hours: [8, 30], days: [1, 3.8] },
  'assembly-unavailable-builtin': {
    micro: [8_800_000, 37_500_000],
    hours: [8, 38],
    days: [1, 4.8],
  },
  'unavailable-assembly-positive-builtin': {
    micro: [8_000_000, 30_000_000],
    hours: [8, 30],
    days: [1, 3.8],
  },
  'unavailable-decisions': { micro: [8_000_000, 30_000_000], hours: [8, 30], days: [1, 3.8] },
  'zero-storage-unavailable-numerator': {
    micro: [8_000_000, 24_000_000],
    hours: [8, 24],
    days: [1, 3],
  },
  'builtin-only': { micro: [8_400_000, 27_000_000], hours: [8, 27], days: [1, 3.4] },
  'internal-dynamic-calls': { micro: [8_000_000, 24_000_000], hours: [8, 24], days: [1, 3] },
  'fractional-microhours': { micro: [8_028_571, 24_257_143], hours: [8, 25], days: [1, 3.2] },
  'fractional-with-discount': {
    micro: [7_028_571, 23_757_143],
    hours: [7, 24],
    days: [0.8, 3],
  },
  'rounding-order-reserve-override': {
    micro: [8_085_714, 74_314_287],
    hours: [8, 75],
    days: [1, 9.4],
  },
  'hours-per-day-override': { micro: [8_000_000, 24_000_000], hours: [8, 24], days: [0.8, 2.4] },
  'allow-partial-complete': { micro: [8_000_000, 24_000_000], hours: [8, 24], days: [1, 3] },
  'precision-boundary': { micro: [100, 100], hours: [0, 1], days: [0, 0.2] },
  'zero-sloc-file-with-positive-file': {
    micro: [8_000_000, 24_000_000],
    hours: [8, 24],
    days: [1, 3],
  },
};

const NULL_CASES: readonly string[] = [
  'partial-normal',
  'failed-context-normal',
  'empty-scope',
  'comment-only-scope',
  'unavailable-baseline',
];

const PARAMETER_OVERRIDES: Readonly<Record<string, Partial<ModelParameters>>> = {
  'rounding-order-reserve-override': { unknownReserveHigh: 2 },
  'hours-per-day-override': { hoursPerDay: 10 },
  'precision-boundary': {
    slocHours: { low: 0.000001, high: 0.000001 },
    projectHours: { low: 0, high: 0 },
  },
};

// Categories whose premium row is expected to be unavailable (literal classification).
const UNAVAILABLE_ROWS: Readonly<Record<string, readonly string[]>> = {
  'unavailable-storage': ['storage'],
  'unavailable-builtin': ['evm'],
  'unavailable-assembly-positive-builtin': ['evm'],
  'unavailable-decisions': ['control'],
};

function sumRows(estimate: EstimateResult): { low: number; high: number } {
  let low = 0;
  let high = 0;
  for (const item of estimate.contributions) {
    low += item.lowMicrohours;
    high += item.highMicrohours;
  }
  return { low, high };
}

function manualMicrohours(estimate: EstimateResult): { low: number; high: number } {
  let low = 0;
  let high = 0;
  for (const item of estimate.contributions) {
    if (item.inputStatus === 'manual') {
      low += item.lowMicrohours;
      high += item.highMicrohours;
    }
  }
  return { low, high };
}

function codePointCompare(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = a[index]?.codePointAt(0) ?? 0;
    const y = b[index]?.codePointAt(0) ?? 0;
    if (x !== y) return x - y;
  }
  return a.length - b.length;
}

interface TableRow {
  readonly low: number;
  readonly high: number;
  readonly unit: string;
}

const PARAMETER_NAMES = [
  'projectHours',
  'slocHours',
  'controlPremium',
  'storagePremium',
  'evmPremium',
  'interactionHours',
  'boundaryHours',
  'unknownReserveHigh',
  'hoursPerDay',
] as const;

const EXPECTED_UNITS: Readonly<Record<(typeof PARAMETER_NAMES)[number], string>> = {
  projectHours: 'auditor-hours/project',
  slocHours: 'auditor-hours/SLOC',
  controlPremium: 'fraction of file baseline at q=1',
  storagePremium: 'fraction of file baseline at q=1',
  evmPremium: 'fraction of file baseline at q=1',
  interactionHours: 'hours/unique scoped directed pair',
  boundaryHours: 'hours/unique context boundary pair',
  unknownReserveHigh: 'high-only fraction of pre-manual subtotal',
  hoursPerDay: 'conversion convention, configurable',
};

/** Narrow reader for the `Starter assumptions` table; rejects absent, duplicate or extra rows. */
function readDefaultTable(markdown: string): Map<string, TableRow> {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line === '## Starter assumptions');
  if (start < 0) throw new Error('Missing Starter assumptions heading');
  const rows = new Map<string, TableRow>();
  let sawHeader = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 4) throw new Error(`Malformed table row: ${line}`);
    const [name = '', low = '', high = '', unit = ''] = cells;
    if (name === 'Parameter') {
      sawHeader = true;
      continue;
    }
    if (/^-+$/.test(name)) continue;
    if (rows.has(name)) throw new Error(`Duplicate table row ${name}`);
    rows.set(name, { low: Number(low), high: Number(high), unit });
  }
  if (!sawHeader) throw new Error('Missing table header');
  return rows;
}

function markdownSections(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3).trim());
}

describe('profile and examples', () => {
  it('loads a complete profile through the existing runtime schema', () => {
    expect(profile.profile).toBe('heuristic-v1');
    expect(profile.modelVersion).toBe('1.0.0');
    expect(Object.keys(profile.parameters)).toEqual([...PARAMETER_NAMES]);
    expect(profile.parameters.unknownReserveHigh).toBe(0.25);
    expect(profile.parameters.hoursPerDay).toBe(8);
  });

  it('covers every original fixture group and the required variants', () => {
    const groups = new Set(cases.map((item) => item.group));
    expect([...groups].sort()).toEqual(
      ['combined', 'evm', 'partial', 'simple', 'unknown', 'validation', 'variants'].sort(),
    );
    const ids = cases.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const expectedIds = [...Object.keys(NAMED), ...NULL_CASES];
    expect([...ids].sort()).toEqual([...expectedIds].sort());
  });

  it('uses defaults for every case except the named overrides', () => {
    for (const item of cases) {
      const expectedParameters = { ...profile.parameters, ...PARAMETER_OVERRIDES[item.id] };
      expect(item.input.model.profile).toBe('heuristic-v1');
      expect(item.input.model.parameters).toEqual(expectedParameters);
    }
    for (const { item, estimate } of ESTIMATED) {
      const expectedParameters = { ...profile.parameters, ...PARAMETER_OVERRIDES[item.id] };
      expect(estimate.parameters).toEqual(expectedParameters);
      expect(estimate.manualAdjustments).toEqual(item.input.manualAdjustments);
    }
  });

  it('matches the independently frozen precise totals, displayed hours and days', () => {
    for (const [id, named] of Object.entries(NAMED)) {
      const estimate = estimateOf(id);
      expect(precise(id)).toEqual({ low: named.micro[0], high: named.micro[1] });
      expect(estimate.auditorHours).toEqual({ low: named.hours[0], high: named.hours[1] });
      expect(estimate.auditorDays).toEqual({ low: named.days[0], high: named.days[1] });
      expect(estimate.label).toBe('uncalibrated heuristic');
    }
  });

  it('sums literal ledger rows exactly to the literal precise totals', () => {
    for (const { item, estimate } of ESTIMATED) {
      expect(sumRows(estimate)).toEqual(precise(item.id));
    }
  });

  it('displays floor-low and ceil-high hours and tenth-day outward rounding', () => {
    for (const { item, estimate } of ESTIMATED) {
      const { low, high } = precise(item.id);
      expect(estimate.auditorHours.low).toBe(Math.floor(low / 1_000_000));
      expect(estimate.auditorHours.high).toBe(Math.ceil(high / 1_000_000));
      const perDay = estimate.parameters.hoursPerDay;
      expect(estimate.auditorDays.low).toBe(
        Math.floor((estimate.auditorHours.low * 10) / perDay) / 10,
      );
      expect(estimate.auditorDays.high).toBe(
        Math.ceil((estimate.auditorHours.high * 10) / perDay) / 10,
      );
    }
  });

  it('keeps rows unique, ordered by code points, bounded and well-formed', () => {
    for (const { estimate } of ESTIMATED) {
      const ids = estimate.contributions.map((row) => row.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual([...ids].sort(codePointCompare));
      expect(ids.every((id) => id.length <= 512)).toBe(true);
      expect(ids.filter((id) => id === 'project').length).toBe(1);
      expect(ids.filter((id) => id === 'reserve').length).toBe(1);
      for (const row of estimate.contributions) {
        expect(Number.isSafeInteger(row.lowMicrohours)).toBe(true);
        expect(row.lowMicrohours).toBeLessThanOrEqual(row.highMicrohours);
        expect(row.explanation.length).toBeLessThanOrEqual(512);
      }
    }
  });

  it('retains exactly one row per file channel, pair and manual adjustment', () => {
    for (const { item, estimate } of ESTIMATED) {
      const count = (category: string): number =>
        estimate.contributions.filter((row) => row.category === category).length;
      const files = item.input.eligibleFiles.length;
      expect(count('baseline')).toBe(files);
      expect(count('control')).toBe(files);
      expect(count('storage')).toBe(files);
      expect(count('evm')).toBe(files);
      expect(count('interaction')).toBe(item.input.scopedPairs.length);
      expect(count('boundary')).toBe(item.input.contextPairs.length);
      expect(count('manual')).toBe(item.input.manualAdjustments.length);
    }
  });

  it('keeps the manual rows equal to the exact signed microhour conversion of the inputs', () => {
    for (const { item, estimate } of ESTIMATED) {
      const low = item.input.manualAdjustments.reduce(
        (sum, adjustment) => sum + Math.round(adjustment.lowHours * 1_000_000),
        0,
      );
      const high = item.input.manualAdjustments.reduce(
        (sum, adjustment) => sum + Math.round(adjustment.highHours * 1_000_000),
        0,
      );
      expect(manualMicrohours(estimate)).toEqual({ low, high });
    }
    expect(manualMicrohours(estimateOf('fractional-with-discount'))).toEqual({
      low: -1_000_000,
      high: -500_000,
    });
  });

  it('pins the combined, unknown and rounding-order ledger literals', () => {
    const rowsOf = (id: string): Record<string, readonly [number, number]> =>
      Object.fromEntries(
        estimateOf(id).contributions.map((row) => [
          row.id,
          [row.lowMicrohours, row.highMicrohours] as const,
        ]),
      );
    const combined = rowsOf('combined');
    expect(combined['control:file:src/A.sol']).toEqual([400_000, 3_000_000]);
    expect(combined['storage:file:src/A.sol']).toEqual([50_000, 450_000]);
    expect(combined['reserve']).toEqual([0, 0]);
    expect(rowsOf('unknown')['reserve']).toEqual([0, 7_550_000]);
    const rounded = rowsOf('rounding-order-reserve-override');
    expect(rounded['storage:file:src/A.sol']).toEqual([85_714, 771_429]);
    expect(rounded['reserve']).toEqual([0, 49_542_858]);
    const fractional = rowsOf('fractional-microhours');
    expect(fractional['storage:file:src/A.sol']).toEqual([28_571, 257_143]);
    expect(rowsOf('evm-dominance')['evm:file:src/A.sol']).toEqual([800_000, 6_000_000]);
    expect(rowsOf('builtin-only')['evm:file:src/A.sol']).toEqual([400_000, 3_000_000]);
  });

  it('describes storage state with consistent counts, shapes and complex subsets', () => {
    const violations: string[] = [];
    for (const item of cases) {
      for (const file of item.input.eligibleFiles) {
        const { mutableCount, count, complexMutableDeclarationIds, typeShapes } =
          file.stateVariables;
        if (typeShapes.status !== 'measured') continue;
        const mutable = typeShapes.value.filter((shape) => shape.mutable);
        const shapeIds = typeShapes.value.map((shape) => shape.declarationId);
        if (new Set(shapeIds).size !== shapeIds.length) {
          violations.push(`${item.id}: duplicate shape IDs`);
        }
        if (mutableCount.status === 'measured' && mutable.length !== mutableCount.value) {
          violations.push(`${item.id}: mutable count differs from shapes`);
        }
        if (count.status === 'measured' && count.value !== typeShapes.value.length) {
          violations.push(`${item.id}: count differs from shapes`);
        }
        if (complexMutableDeclarationIds.status === 'measured') {
          const complex = new Set(complexMutableDeclarationIds.value);
          if (complex.size !== complexMutableDeclarationIds.value.length) {
            violations.push(`${item.id}: duplicate complex IDs`);
          }
          const complexShapes = typeShapes.value.filter((shape) =>
            complex.has(shape.declarationId),
          );
          if (
            complexShapes.length !== complex.size ||
            !complexShapes.every(
              (shape) => shape.mutable && (shape.shape === 'mapping' || shape.shape === 'array'),
            )
          ) {
            violations.push(`${item.id}: complex IDs are not mutable mapping or array shapes`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('unavailable and eligibility', () => {
  it('has a null estimate and null precise totals for every unavailable outcome', () => {
    for (const id of NULL_CASES) {
      const item = byId(id);
      expect(item.expected.estimate).toBeNull();
      expect(item.expected.preciseMicrohours).toBeNull();
      expect(item.application.fullScopeEstimateExpected).toBe(false);
    }
    for (const item of cases) {
      if (NULL_CASES.includes(item.id)) continue;
      expect(item.expected.estimate).not.toBeNull();
    }
  });

  it('encodes the partial and failed-context outcomes with the analyzed-subset label', () => {
    expect(byId('partial-normal').input.allowPartial).toBe(false);
    expect(byId('partial-normal').input.requiredAnalysisComplete).toBe(false);
    expect(byId('partial-normal').input.hasUnknownSemantics).toBe(false);
    expect(byId('partial-explicit').input).toEqual({
      ...byId('partial-normal').input,
      allowPartial: true,
    });
    expect(estimateOf('partial-explicit').coverage).toBe('analyzed-subset');
    expect(estimateOf('partial-explicit').contributions).toEqual(
      estimateOf('simple').contributions,
    );
    expect(byId('partial-explicit').application).toEqual({
      selectedFileIds: ['file:src/A.sol'],
      omittedFileIds: ['file:src/B.sol'],
      reportStatus: 'partial',
      fullScopeEstimateExpected: false,
    });
    expect(byId('failed-context-normal').input.hasUnknownSemantics).toBe(true);
    expect(byId('failed-context-normal').input.requiredAnalysisComplete).toBe(false);
    expect(estimateOf('failed-context-partial').coverage).toBe('analyzed-subset');
    expect(byId('failed-context-partial').input.eligibleFiles).toEqual(
      byId('failed-context-normal').input.eligibleFiles,
    );
  });

  it('keeps full coverage when allowPartial is set on complete input', () => {
    const item = byId('allow-partial-complete');
    expect(item.input.allowPartial).toBe(true);
    expect(item.input.requiredAnalysisComplete).toBe(true);
    expect(estimateOf('allow-partial-complete').coverage).toBe('full');
    const fullIds = Object.keys(NAMED).filter(
      (id) => !['partial-explicit', 'failed-context-partial'].includes(id),
    );
    expect(fullIds.map((id) => estimateOf(id).coverage)).toEqual(fullIds.map(() => 'full'));
  });

  it('records unavailable premium rows with numeric zeros and unavailable status', () => {
    for (const { item, estimate } of ESTIMATED) {
      const unavailable = estimate.contributions
        .filter((row) => row.inputStatus === 'unavailable')
        .map((row) => row.category);
      expect(unavailable).toEqual(UNAVAILABLE_ROWS[item.id] ?? []);
      const rows = estimate.contributions.filter((row) => row.inputStatus === 'unavailable');
      expect(
        rows.every(
          (row) =>
            row.lowMicrohours === 0 && row.highMicrohours === 0 && /omitted/.test(row.explanation),
        ),
      ).toBe(true);
    }
  });

  it('pairs each unavailable row with an unavailable measurement in the input', () => {
    const unavailableChannel = (id: string): readonly string[] => {
      const channels: string[] = [];
      for (const file of byId(id).input.eligibleFiles) {
        if (file.decisions.status === 'unavailable') channels.push('control');
        if (file.assemblyBlocks.status === 'unavailable') channels.push('evm');
        if (
          file.confirmedBuiltinLowLevelCalls.status === 'unavailable' &&
          file.assemblyBlocks.status === 'measured' &&
          file.assemblyBlocks.value === 0
        ) {
          channels.push('evm');
        }
        if (file.stateVariables.complexMutableDeclarationIds.status === 'unavailable') {
          if (file.stateVariables.mutableCount.status === 'measured') {
            if (file.stateVariables.mutableCount.value > 0) channels.push('storage');
          }
        }
      }
      return channels;
    };
    for (const [id, categories] of Object.entries(UNAVAILABLE_ROWS)) {
      expect([...new Set(unavailableChannel(id))].sort()).toEqual([...categories].sort());
    }
    // Measured assembly with an unavailable builtin count still earns a measured premium row.
    expect(unavailableChannel('assembly-unavailable-builtin')).toEqual([]);
    // Measured S=0 never needs the unavailable classification.
    expect(unavailableChannel('zero-storage-unavailable-numerator')).toEqual([]);
  });

  it('pins the reserve and effective-unknown literals for unavailable measurements', () => {
    const reserveHigh = (id: string): number =>
      estimateOf(id).contributions.find((row) => row.id === 'reserve')?.highMicrohours ?? -1;
    for (const id of [
      'unavailable-storage',
      'unavailable-builtin',
      'unavailable-assembly-positive-builtin',
      'unavailable-decisions',
    ]) {
      expect(byId(id).input.hasUnknownSemantics).toBe(false);
      expect(reserveHigh(id)).toBe(6_000_000);
    }
    expect(reserveHigh('assembly-unavailable-builtin')).toBe(7_500_000);
    expect(reserveHigh('zero-storage-unavailable-numerator')).toBe(0);
    expect(reserveHigh('internal-dynamic-calls')).toBe(0);
    expect(byId('internal-dynamic-calls').input.scopedPairs).toEqual([]);
    expect(byId('internal-dynamic-calls').input).toEqual({
      ...byId('simple').input,
    });
  });

  it('classifies each eligibility row as a schema-valid input with no estimate', () => {
    const ids = invalid.eligibility.map((item) => item.id).sort();
    expect(ids).toEqual(
      [
        'empty-scope-normal',
        'empty-scope-partial',
        'failed-context-no-partial',
        'incomplete-and-empty-partial',
        'incomplete-no-partial',
        'unavailable-baseline-normal',
        'unavailable-baseline-partial',
        'zero-sloc-normal',
        'zero-sloc-partial-with-allowances',
      ].sort(),
    );
    for (const item of invalid.eligibility) {
      expect(item.expectedEstimate).toBeNull();
      const files = item.input.eligibleFiles;
      const unavailableBaseline = files.some((file) => file.sourceLines.status !== 'measured');
      const totalSloc = files.reduce(
        (sum, file) => sum + (file.sourceLines.status === 'measured' ? file.sourceLines.value : 0),
        0,
      );
      const incompleteNormal = !item.input.requiredAnalysisComplete && !item.input.allowPartial;
      // Literal classification: at least one documented unavailable condition applies.
      expect(unavailableBaseline || totalSloc === 0 || incompleteNormal).toBe(true);
    }
  });

  it('defers engine and application gates explicitly', () => {
    const spec = doc('model/heuristic-v1.md');
    expect(spec).toContain('## Deferred verification boundary');
    expect(spec).toContain('estimateEffort');
    expect(spec).toContain('Plan 013');
  });
});

describe('precision and invalid cases', () => {
  it('rejects each schema case with the declared issue path', () => {
    const schemas = {
      model: ModelProfileSchema,
      input: EstimateInputSchema,
      result: EstimateResultSchema,
    } as const;
    expect(invalid.schema.length).toBeGreaterThan(0);
    for (const item of invalid.schema) {
      const result = schemas[item.target].safeParse(item.value);
      expect(result.success).toBe(false);
      const paths = result.success
        ? []
        : result.error.issues.map((issue) => JSON.stringify(issue.path));
      expect(paths).toContain(JSON.stringify(item.issuePath));
    }
    const targets = new Set(invalid.schema.map((item) => item.target));
    expect([...targets].sort()).toEqual(['input', 'model', 'result']);
  });

  it('accepts schema-valid engine-invalid inputs and leaves rejection to plan 011', () => {
    const ids = invalid.engine.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of invalid.engine) {
      expect(EstimateInputSchema.safeParse(item.input).success).toBe(true);
      expect(item.reason.length).toBeGreaterThan(0);
    }
    for (const needed of [
      'excessive-discount',
      'mutable-exceeds-count',
      'duplicate-complex-ids',
      'output-bound-overflow',
      'unsafe-integer-sum',
    ]) {
      expect(ids).toContain(needed);
    }
  });

  it('shows the literal contradictions of the storage engine-invalid inputs', () => {
    const find = (id: string): EstimateInput => {
      const found = invalid.engine.find((item) => item.id === id);
      if (found === undefined) throw new Error(`Missing engine case ${id}`);
      return found.input;
    };
    const storage = (id: string) => find(id).eligibleFiles[0]?.stateVariables;
    const mutableExceeds = storage('mutable-exceeds-count');
    expect(
      mutableExceeds?.count.status === 'measured' &&
        mutableExceeds.mutableCount.status === 'measured' &&
        mutableExceeds.mutableCount.value > mutableExceeds.count.value,
    ).toBe(true);
    const duplicate = storage('duplicate-complex-ids')?.complexMutableDeclarationIds;
    expect(
      duplicate?.status === 'measured' && new Set(duplicate.value).size < duplicate.value.length,
    ).toBe(true);
    const discount = find('excessive-discount');
    expect(discount.manualAdjustments[0]?.lowHours).toBeLessThan(-8);
  });

  it('accepts the six-decimal boundary and rejects seven decimals', () => {
    const parameters = { ...profile.parameters, slocHours: { low: 0.000001, high: 0.000001 } };
    expect(ModelProfileSchema.safeParse({ ...profile, parameters }).success).toBe(true);
    const tooFine = { ...profile.parameters, slocHours: { low: 0.0000001, high: 0.000001 } };
    expect(ModelProfileSchema.safeParse({ ...profile, parameters: tooFine }).success).toBe(false);
    expect(ManualAdjustmentSchema.safeParse(manual({ lowHours: 0.000001 })).success).toBe(true);
    expect(ManualAdjustmentSchema.safeParse(manual({ lowHours: 0.0000001 })).success).toBe(false);
  });

  it('validates signed manual rows including a reasoned discount', () => {
    const discount = byId('fractional-with-discount').input.manualAdjustments[0];
    expect(ManualAdjustmentSchema.safeParse(discount).success).toBe(true);
    expect(discount?.lowHours).toBeLessThan(0);
    expect(discount?.highHours).toBeLessThan(0);
    expect(discount?.reason.trim().length).toBeGreaterThan(0);
    expect(ManualAdjustmentSchema.safeParse(manual({ reason: ' ' })).success).toBe(false);
  });

  it('rejects nonfinite values only as in-memory TypeScript mutations', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const parameters = { ...profile.parameters, slocHours: { low: bad, high: 0.12 } };
      expect(ModelProfileSchema.safeParse({ ...profile, parameters }).success).toBe(false);
      expect(
        ModelProfileSchema.safeParse({
          ...profile,
          parameters: { ...profile.parameters, hoursPerDay: bad },
        }).success,
      ).toBe(false);
      expect(ManualAdjustmentSchema.safeParse(manual({ highHours: bad })).success).toBe(false);
      const base = byId('simple');
      const estimate = base.expected.estimate;
      expect(
        EstimateResultSchema.safeParse({ ...estimate, auditorHours: { low: 0, high: bad } })
          .success,
      ).toBe(false);
    }
    const text = readFileSync(
      new URL('../fixtures/estimation/worked-cases.json', import.meta.url),
      'utf8',
    );
    expect(text).not.toMatch(/NaN|Infinity/);
  });

  it('keeps the precision-boundary and hours-per-day overrides exact', () => {
    expect(byId('precision-boundary').input.model.parameters.slocHours).toEqual({
      low: 0.000001,
      high: 0.000001,
    });
    expect(
      estimateOf('precision-boundary').contributions.map((row) => row.lowMicrohours),
    ).toContain(100);
    expect(estimateOf('hours-per-day-override').auditorDays).toEqual({ low: 0.8, high: 2.4 });
  });
});

function manual(
  overrides: Partial<{ reason: string; lowHours: number; highHours: number }>,
): unknown {
  return {
    id: 'illustrative',
    reason: 'Illustrative reason.',
    category: 'illustrative',
    lowHours: 1,
    highHours: 2,
    ...overrides,
  };
}

describe('methodology contract', () => {
  const spec = doc('model/heuristic-v1.md');

  it('requires the model documents and their section structure', () => {
    expect(markdownSections(spec)).toEqual([
      'Scope of the estimate',
      'Inputs',
      'Formulas',
      'Starter assumptions',
      'Eligibility and unavailable rules',
      'Evaluation order',
      'Double-counting controls',
      'Frozen worked examples',
      'Deferred verification boundary',
    ]);
    for (const path of ['model/alternatives.md', 'model/limitations.md']) {
      expect(doc(path).startsWith('# ')).toBe(true);
    }
    expect(spec).toContain('uncalibrated heuristic');
    expect(spec).toContain('1,000,000');
  });

  it('matches all nine numeric default rows and units to the profile', () => {
    const table = readDefaultTable(spec);
    expect([...table.keys()].sort()).toEqual([...PARAMETER_NAMES].sort());
    for (const name of PARAMETER_NAMES) {
      const row = table.get(name);
      expect(row).toBeDefined();
      expect(row?.unit).toBe(EXPECTED_UNITS[name]);
      const value = profile.parameters[name];
      const expectedPair =
        typeof value === 'object'
          ? [value.low, value.high]
          : name === 'unknownReserveHigh'
            ? [0, value]
            : [value, value];
      expect([row?.low, row?.high]).toEqual(expectedPair);
    }
  });

  it('rejects absent or duplicate default rows in the narrow reader', () => {
    const duplicate = spec.replace(
      '| hoursPerDay',
      '| projectHours | 4 | 12 | auditor-hours/project |\n| hoursPerDay',
    );
    expect(() => readDefaultTable(duplicate)).toThrow(/Duplicate/);
    const absent = spec
      .split('\n')
      .filter((line) => !line.startsWith('| boundaryHours'))
      .join('\n');
    expect([...readDefaultTable(absent).keys()]).not.toContain('boundaryHours');
    expect(() => readDefaultTable('# nothing')).toThrow(/Missing/);
  });

  it('documents the bounds, rounding order and eligibility table', () => {
    for (const phrase of [
      '100,000,000,000 microhours',
      '100,000 rows',
      '1,000,000,000',
      'six decimal places',
      'floor on low and ceil on high',
      '`EMPTY_SCOPE`',
      "coverage='analyzed-subset'",
    ]) {
      expect(spec).toContain(phrase);
    }
  });

  it('parses every manual adjustment example against the runtime schema', () => {
    const limitations = doc('model/limitations.md');
    const blocks = [...limitations.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    expect(blocks.length).toBe(5);
    const parsed = blocks.map((block) => ManualAdjustmentSchema.parse(JSON.parse(block ?? '')));
    expect(new Set(parsed.map((item) => item.id)).size).toBe(parsed.length);
    expect(parsed.some((item) => item.lowHours < 0 && item.highHours < 0)).toBe(true);
    expect(limitations).toContain('illustrative non-default allowances');
  });

  it('maps all eight human prompts to optional assessment', () => {
    const limitations = doc('model/limitations.md');
    for (const key of [
      'business-invariants',
      'protocol-novelty',
      'external-trust',
      'custom-math-cryptography',
      'documentation',
      'upgrade-lifecycle',
      'cross-chain',
      'review-depth',
    ]) {
      expect(limitations).toContain(`\`${key}\``);
    }
  });

  it('cites the checked sources without claiming validation', () => {
    const alternatives = doc('model/alternatives.md');
    for (const url of [
      'https://arxiv.org/abs/1609.05563',
      'https://bura.brunel.ac.uk/handle/2438/1101',
      'https://www.openzeppelin.com/news/geb-protocol-audit',
    ]) {
      expect(alternatives).toContain(url);
    }
    expect(alternatives).toContain('did not establish a reusable, matched benchmark');
  });
});

describe('calibration contract', () => {
  const protocol = doc('calibration/protocol.md');

  it('has the required sections', () => {
    expect(markdownSections(protocol)).toEqual([
      'Data dictionary',
      'Eligibility and target hours',
      'Splits and leakage',
      'Baselines and evaluation',
      'Consent and publication',
      'Model lifecycle',
      'Deferred verification boundary',
    ]);
  });

  it('lists every required data dictionary field with representation columns', () => {
    const lines = protocol.split('\n').filter((line) => line.startsWith('| `'));
    const fields = lines.map((line) => line.split('|')[1]?.trim().replaceAll('`', '') ?? '');
    for (const field of [
      'engagementId',
      'projectId',
      'familyId',
      'sourceScope',
      'sourceCommit',
      'sourceHash',
      'sourceAvailability',
      'sourceLicense',
      'metricsVersion',
      'parserVersion',
      'modelVersion',
      'indicatorsVersion',
      'reviewPolicy',
      'hoursPreparation',
      'hoursReview',
      'hoursInteractions',
      'hoursReport',
      'hoursReReview',
      'staffSeniority',
      'staffParticipation',
      'excludedDependencies',
      'domainNovelty',
      'manualFactors',
      'originalEstimate',
      'originalAdjustments',
    ]) {
      expect(fields).toContain(field);
    }
    expect(new Set(fields).size).toBe(fields.length);
    for (const line of lines) expect(line.split('|').length).toBe(7);
    expect(protocol).toContain('Never record them as zero');
  });

  it('states leakage controls, baselines and held-out reporting', () => {
    for (const phrase of [
      'family and by time',
      'Lock every choice before the final holdout is opened',
      'report insufficiency and defer fitting',
      'The unchanged starter profile',
      'training-only fitted SLOC model',
      'Expert estimates recorded before the actual hours were known',
      'no-manual baseline',
      'signed bias',
      'interval containment',
      'Pre-register acceptance criteria',
      'separate consent',
      'multiplying calendar weeks',
    ]) {
      expect(protocol).toContain(phrase);
    }
  });

  it('defers acquisition and fitting and contains no fabricated records', () => {
    expect(protocol).toContain('contains no collected data');
    expect(protocol).toContain('separate post-MVP work');
    expect(protocol).not.toMatch(/MMRE\s*[<=>]\s*\d/);
    expect(protocol).not.toMatch(/\d+(\.\d+)?\s*%\s*(accuracy|confidence)/i);
  });
});
