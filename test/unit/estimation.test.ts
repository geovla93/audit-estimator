import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { canonicalJson, fingerprint } from '../../src/domain/canonical.ts';
import {
  EstimateInputSchema,
  EstimateResultSchema,
  ModelProfileSchema,
} from '../../src/domain/schemas.ts';
import type { EstimateInput, EstimateResult, ModelProfile } from '../../src/domain/types.ts';
import { EstimationError, estimateEffort, selectModel } from '../../src/index.ts';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/estimation/${name}.json`, import.meta.url), 'utf8'),
  ) as unknown;
}

const WorkedCaseSchema = z.strictObject({
  id: z.string().min(1),
  group: z.string(),
  description: z.string(),
  input: EstimateInputSchema,
  expected: z.strictObject({
    estimate: EstimateResultSchema.nullable(),
    preciseMicrohours: z.strictObject({ low: z.int(), high: z.int() }).nullable(),
  }),
  application: z.unknown(),
});
const InvalidCasesSchema = z.strictObject({
  schema: z.array(
    z.strictObject({
      id: z.string(),
      target: z.enum(['model', 'input', 'result']),
      value: z.unknown(),
      issuePath: z.array(z.union([z.string(), z.number()])),
    }),
  ),
  eligibility: z.array(
    z.strictObject({
      id: z.string(),
      input: EstimateInputSchema,
      expectedEstimate: z.null(),
      reason: z.string(),
    }),
  ),
  engine: z.array(
    z.strictObject({ id: z.string(), input: EstimateInputSchema, reason: z.string() }),
  ),
});

const cases = z.array(WorkedCaseSchema).parse(fixture('worked-cases'));
const invalid = InvalidCasesSchema.parse(fixture('invalid-cases'));
const profile: ModelProfile = ModelProfileSchema.parse(fixture('profile'));

/** Test-only mapping from the fixtures' readable row IDs to production identity hashes. */
function productionId(fixtureId: string): string {
  if (fixtureId === 'project' || fixtureId === 'reserve') return fixtureId;
  const colon = fixtureId.indexOf(':');
  const category = fixtureId.slice(0, colon);
  const rest = fixtureId.slice(colon + 1);
  const identity = category === 'interaction' || category === 'boundary' ? rest.split('>') : [rest];
  return `${category}:${fingerprint([category, canonicalJson(identity)])}`;
}

function run(input: EstimateInput): EstimateResult | null {
  return estimateEffort(input);
}

const ANY_REASON =
  /^(invalid-input|inconsistent-measurements|invalid-total|output-bound|unsafe-arithmetic)$/;

/** Reason of the typed rejection, or a marker string when nothing or a foreign error is thrown. */
function reasonOfCall(call: () => unknown): string {
  try {
    call();
  } catch (error: unknown) {
    return error instanceof EstimationError ? error.reason : 'foreign-error';
  }
  return 'no-rejection';
}

/** Malformed runtime values are passed as unknown through Reflect.apply, never cast. */
function rejectionOf(value: unknown): string {
  return reasonOfCall(() => Reflect.apply(estimateEffort, undefined, [value]));
}

const ENGINE_REASONS: Readonly<Record<string, readonly string[]>> = {
  'excessive-discount': ['invalid-total'],
  'discount-negates-whole-total': ['invalid-total'],
  'mutable-exceeds-count': ['inconsistent-measurements'],
  'complex-count-exceeds-mutable': ['inconsistent-measurements'],
  'duplicate-complex-ids': ['inconsistent-measurements'],
  'mutable-count-contradicts-shapes': ['inconsistent-measurements'],
  'complex-id-is-elementary-shape': ['inconsistent-measurements'],
  'complex-id-is-constant': ['inconsistent-measurements'],
  'zero-storage-with-complex-ids': ['inconsistent-measurements'],
  'output-bound-overflow': ['output-bound'],
  'unsafe-integer-sum': ['unsafe-arithmetic', 'output-bound'],
};

function validInput(): EstimateInput {
  const found = cases.find((item) => item.id === 'simple');
  if (found === undefined) throw new Error('missing simple');
  return structuredClone(found.input);
}

describe('validation and eligibility', () => {
  it('selects the static profile with fresh copies', () => {
    expect(selectModel()).toEqual(profile);
    expect(selectModel('heuristic-v1')).toEqual(profile);
    expect(selectModel('heuristic-v1', '1.0.0')).toEqual(profile);
    expect(selectModel(undefined, '1.0.0')).toEqual(profile);
    const mutable = selectModel() as { parameters: { hoursPerDay: number } };
    mutable.parameters.hoursPerDay = 1;
    expect(selectModel()).toEqual(profile);
    expect(selectModel()).not.toBe(selectModel());
  });

  it('rejects each unsupported selection argument independently', () => {
    expect(() => selectModel('other')).toThrow(EstimationError);
    expect(() => selectModel(undefined, '2.0.0')).toThrow(EstimationError);
    expect(() => selectModel('heuristic-v1', '2.0.0')).toThrow(EstimationError);
    expect(() => selectModel('other', '1.0.0')).toThrow(EstimationError);
    expect(reasonOfCall(() => selectModel('other'))).toBe('invalid-input');
    expect(reasonOfCall(() => selectModel(undefined, '2.0.0'))).toBe('invalid-input');
  });

  for (const item of invalid.eligibility) {
    it(`returns null for eligibility case ${item.id}`, () => {
      expect(run(item.input)).toBeNull();
    });
  }

  for (const item of cases.filter((entry) => entry.expected.estimate === null)) {
    it(`returns null for worked null outcome ${item.id}`, () => {
      expect(run(item.input)).toBeNull();
    });
  }

  for (const item of invalid.schema.filter((entry) => entry.target !== 'result')) {
    it(`rejects schema-invalid ${item.target} case ${item.id}`, () => {
      const value = item.target === 'input' ? item.value : { ...validInput(), model: item.value };
      expect(rejectionOf(value)).toBe('invalid-input');
    });
  }

  for (const item of invalid.schema.filter((entry) => entry.target === 'result')) {
    it(`treats result case ${item.id} as result validation, not engine input`, () => {
      expect(EstimateResultSchema.safeParse(item.value).success).toBe(false);
    });
  }

  for (const item of invalid.engine) {
    it(`rejects schema-valid engine case ${item.id}`, () => {
      const reasons = ENGINE_REASONS[item.id];
      expect(reasons).toBeDefined();
      expect(reasons).toContain(reasonOfCall(() => run(item.input)));
    });
  }

  it('rejects in-memory nonfinite numbers, non-objects and extra keys', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const input = validInput();
      const badModel = {
        ...input,
        model: {
          ...input.model,
          parameters: { ...input.model.parameters, hoursPerDay: bad },
        },
      };
      const badManual = {
        ...input,
        manualAdjustments: [{ id: 'm', reason: 'r', category: 'c', lowHours: bad, highHours: bad }],
      };
      expect(rejectionOf(badModel)).toMatch(ANY_REASON);
      expect(rejectionOf(badManual)).toMatch(ANY_REASON);
    }
    expect(rejectionOf(null)).toMatch(ANY_REASON);
    expect(rejectionOf(undefined)).toMatch(ANY_REASON);
    expect(rejectionOf('input')).toMatch(ANY_REASON);
    expect(rejectionOf({ ...validInput(), extra: true })).toMatch(ANY_REASON);
  });

  it('keeps messages fixed and sanitized', () => {
    const error = new EstimationError('output-bound');
    expect(error.name).toBe('EstimationError');
    expect(error.message).not.toMatch(/file:|decl:/);
  });

  it('does not clear the allowPartial=true label on complete input', () => {
    const found = cases.find((item) => item.id === 'allow-partial-complete');
    expect(found?.input.allowPartial).toBe(true);
    expect(run(found?.input ?? validInput())?.coverage).toBe('full');
  });
});

describe('worked formulas and ledger', () => {
  const estimated = cases.flatMap((item) =>
    item.expected.estimate === null || item.expected.preciseMicrohours === null
      ? []
      : [{ item, estimate: item.expected.estimate, precise: item.expected.preciseMicrohours }],
  );

  it('covers the frozen case counts', () => {
    expect(cases).toHaveLength(27);
    expect(estimated).toHaveLength(22);
    expect(invalid.eligibility).toHaveLength(9);
    expect(invalid.engine).toHaveLength(11);
  });

  for (const { item, estimate, precise } of estimated) {
    it(`reproduces worked case ${item.id}`, () => {
      const result = run(item.input);
      expect(result).not.toBeNull();
      if (result === null) return;
      expect(EstimateResultSchema.safeParse(result).success).toBe(true);
      expect(result.profile).toBe(estimate.profile);
      expect(result.modelVersion).toBe(estimate.modelVersion);
      expect(result.label).toBe(estimate.label);
      expect(result.coverage).toBe(estimate.coverage);
      expect(result.parameters).toEqual(estimate.parameters);
      expect(result.manualAdjustments).toEqual(estimate.manualAdjustments);
      expect(result.auditorHours).toEqual(estimate.auditorHours);
      expect(result.auditorDays).toEqual(estimate.auditorDays);
      expect(result.assumptions.length).toBeGreaterThanOrEqual(3);
      expect(result.assumptions.join(' ')).toMatch(/uncalibrated/);
      expect(result.contributions).toHaveLength(estimate.contributions.length);
      const actual = new Map(result.contributions.map((row) => [row.id, row]));
      for (const expected of estimate.contributions) {
        const row = actual.get(productionId(expected.id));
        expect(row).toBeDefined();
        expect(row?.category).toBe(expected.category);
        expect(row?.lowMicrohours).toBe(expected.lowMicrohours);
        expect(row?.highMicrohours).toBe(expected.highMicrohours);
        expect(row?.inputStatus).toBe(expected.inputStatus);
        expect(row?.explanation.length ?? 0).toBeGreaterThan(20);
      }
      const low = result.contributions.reduce((total, row) => total + row.lowMicrohours, 0);
      const high = result.contributions.reduce((total, row) => total + row.highMicrohours, 0);
      expect(low).toBe(precise.low);
      expect(high).toBe(precise.high);
      const ids = result.contributions.map((row) => row.id);
      expect(ids).toEqual([...ids].sort());
    });
  }

  it('hits the named pins', () => {
    const pins: readonly (readonly [string, number, number])[] = [
      ['combined', 10_200_000, 33_200_000],
      ['unknown', 10_200_000, 40_750_000],
      ['fractional-microhours', 8_028_571, 24_257_143],
      ['assembly-unavailable-builtin', 8_800_000, 37_500_000],
      ['zero-storage-unavailable-numerator', 8_000_000, 24_000_000],
      ['rounding-order-reserve-override', 8_085_714, 74_314_287],
      ['fractional-with-discount', 7_028_571, 23_757_143],
    ];
    for (const [id, low, high] of pins) {
      const found = cases.find((item) => item.id === id);
      const result = run(found?.input ?? validInput());
      const sums = (result?.contributions ?? []).reduce(
        (total, row) => ({
          low: total.low + row.lowMicrohours,
          high: total.high + row.highMicrohours,
        }),
        { low: 0, high: 0 },
      );
      expect(sums).toEqual({ low, high });
    }
    const reserve = run(
      cases.find((item) => item.id === 'rounding-order-reserve-override')?.input ?? validInput(),
    );
    expect(reserve?.contributions.find((row) => row.category === 'reserve')?.highMicrohours).toBe(
      49_542_858,
    );
  });

  it('reproduces documented display ranges', () => {
    const combined = run(cases.find((item) => item.id === 'combined')?.input ?? validInput());
    expect(combined?.auditorHours).toEqual({ low: 10, high: 34 });
    expect(combined?.auditorDays).toEqual({ low: 1.2, high: 4.3 });
  });

  it('returns fresh, frozen-input-safe results with copied fields', () => {
    const input = validInput();
    const frozen = structuredClone(input);
    const first = run(input);
    expect(input).toEqual(frozen);
    const second = run(input);
    if (first === null || second === null) throw new Error('expected estimates');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).not.toBe(second);
    expect(first.parameters).not.toBe(input.model.parameters);
    expect(first.contributions).not.toBe(second.contributions);
    (first.contributions as unknown[]).length = 0;
    expect(second.contributions.length).toBeGreaterThan(0);
  });
});
