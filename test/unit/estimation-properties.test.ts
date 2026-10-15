import { describe, expect, it } from 'vitest';
import { EstimateInputSchema, EstimateResultSchema } from '../../src/domain/schemas.ts';
import type {
  EstimateInput,
  EstimateResult,
  Measurement,
  ModelParameters,
  StateVariableShape,
  StateVariables,
} from '../../src/domain/types.ts';
import { EstimationError, estimateEffort, selectModel } from '../../src/index.ts';

type InputFile = EstimateInput['eligibleFiles'][number];
type Pair = EstimateInput['scopedPairs'][number];
type Manual = EstimateInput['manualAdjustments'][number];

const measured = (value: number): Measurement<number> => ({
  status: 'measured',
  value,
  evidence: [],
});
const unavailable: Measurement<never> = { status: 'unavailable', reason: 'test' };

function emptyState(): StateVariables {
  return {
    count: measured(0),
    mutableCount: measured(0),
    complexMutableDeclarationIds: { status: 'measured', value: [], evidence: [] },
    typeShapes: { status: 'measured', value: [], evidence: [] },
  };
}

function file(
  id: string,
  lines: number,
  overrides: Partial<Omit<InputFile, 'fileId'>> = {},
): InputFile {
  return {
    fileId: id as InputFile['fileId'],
    sourceLines: measured(lines),
    stateVariables: emptyState(),
    decisions: measured(0),
    assemblyBlocks: measured(0),
    confirmedBuiltinLowLevelCalls: measured(0),
    ...overrides,
  };
}

const range = (low: number, high: number = low): { low: number; high: number } => ({ low, high });

function zeroParameters(overrides: Partial<ModelParameters> = {}): ModelParameters {
  return {
    projectHours: range(0),
    slocHours: range(0),
    controlPremium: range(0),
    storagePremium: range(0),
    evmPremium: range(0),
    interactionHours: range(0),
    boundaryHours: range(0),
    unknownReserveHigh: 0,
    hoursPerDay: 8,
    ...overrides,
  };
}

function input(
  files: readonly InputFile[],
  parameters: ModelParameters,
  extra: Partial<EstimateInput> = {},
): EstimateInput {
  return {
    eligibleFiles: [...files],
    scopedPairs: [],
    contextPairs: [],
    requiredAnalysisComplete: true,
    hasUnknownSemantics: false,
    allowPartial: false,
    model: { profile: 'heuristic-v1', modelVersion: '1.0.0', parameters },
    manualAdjustments: [],
    ...extra,
  };
}

function defaultInput(
  files: readonly InputFile[],
  extra: Partial<EstimateInput> = {},
): EstimateInput {
  return input(files, selectModel().parameters, extra);
}

function est(value: EstimateInput): EstimateResult {
  expect(EstimateInputSchema.safeParse(value).success).toBe(true);
  const result = estimateEffort(value);
  if (result === null) throw new Error('expected an estimate');
  return result;
}

function reasonOf(value: EstimateInput): string {
  expect(EstimateInputSchema.safeParse(value).success).toBe(true);
  try {
    estimateEffort(value);
  } catch (error: unknown) {
    if (error instanceof EstimationError) return error.reason;
    throw error;
  }
  throw new Error('expected a rejection');
}

function totals(result: EstimateResult): { low: number; high: number } {
  return result.contributions.reduce(
    (sum, row) => ({ low: sum.low + row.lowMicrohours, high: sum.high + row.highMicrohours }),
    { low: 0, high: 0 },
  );
}

function row(result: EstimateResult, category: string): EstimateResult['contributions'][number] {
  const found = result.contributions.find((item) => item.category === category);
  if (found === undefined) throw new Error(`missing ${category} row`);
  return found;
}

function pairs(count: number, offset = 0): Pair[] {
  return Array.from({ length: count }, (_, index) => ({
    leftId: `decl:src/A.sol:contract:${index + offset}`,
    rightId: `decl:src/B.sol:contract:${index + offset}`,
  }));
}

function manual(id: string, low: number, high: number = low): Manual {
  return { id, reason: 'bounded test allowance', category: 'test', lowHours: low, highHours: high };
}

describe('output bounds and large intermediates', () => {
  const sloc = zeroParameters({ slocHours: range(0.000001) });

  it('accepts a row of exactly 1e11 microhours and rejects one more', () => {
    const ok = est(input([file('file:src/A.sol', 100_000_000_000)], sloc));
    expect(row(ok, 'baseline')).toMatchObject({
      lowMicrohours: 100_000_000_000,
      highMicrohours: 100_000_000_000,
    });
    expect(reasonOf(input([file('file:src/A.sol', 100_000_000_001)], sloc))).toBe('output-bound');
  });

  it('accepts exactly 100000 rows with zero hours and rejects one more pair', () => {
    const files = [file('file:src/A.sol', 10)];
    const ok = est(input(files, zeroParameters(), { scopedPairs: pairs(99_994) }));
    expect(ok.contributions).toHaveLength(100_000);
    expect(ok.auditorHours).toEqual({ low: 0, high: 0 });
    expect(ok.auditorDays).toEqual({ low: 0, high: 0 });
    expect(reasonOf(input(files, zeroParameters(), { scopedPairs: pairs(99_995) }))).toBe(
      'output-bound',
    );
  }, 60_000);

  it('accepts exactly 1e9 hours at 100000 rows and rejects 60001 hours of allowance', () => {
    const parameters = zeroParameters({
      projectHours: range(10_000),
      interactionHours: range(10_000),
    });
    const build = (allowance: number): EstimateInput =>
      input([file('file:src/A.sol', 1)], parameters, {
        scopedPairs: pairs(99_993),
        manualAdjustments: [manual('allowance', allowance)],
      });
    const ok = est(build(60_000));
    expect(ok.contributions).toHaveLength(100_000);
    expect(ok.auditorHours).toEqual({ low: 1_000_000_000, high: 1_000_000_000 });
    expect(ok.auditorDays.high).toBe(125_000_000);
    expect(reasonOf(build(60_001))).toBe('output-bound');
  }, 60_000);

  it('accepts exactly 1e9 days and rejects one more line', () => {
    const parameters = zeroParameters({ slocHours: range(1), hoursPerDay: 0.000001 });
    const ok = est(input([file('file:src/A.sol', 1000)], parameters));
    expect(ok.auditorHours).toEqual({ low: 1000, high: 1000 });
    expect(ok.auditorDays).toEqual({ low: 1_000_000_000, high: 1_000_000_000 });
    expect(reasonOf(input([file('file:src/A.sol', 1001)], parameters))).toBe('output-bound');
  });

  it('accepts exact large BigInt intermediates', () => {
    const parameters = zeroParameters({
      slocHours: range(0.000001),
      controlPremium: range(0.000001),
    });
    const result = est(
      input([file('file:src/A.sol', 99_999_999_991, { decisions: measured(1) })], parameters),
    );
    expect(row(result, 'baseline')).toMatchObject({
      lowMicrohours: 99_999_999_991,
      highMicrohours: 99_999_999_991,
    });
    expect(row(result, 'control')).toMatchObject({ lowMicrohours: 0, highMicrohours: 1 });
    expect(totals(result)).toEqual({ low: 99_999_999_991, high: 99_999_999_992 });
    expect(result.auditorHours).toEqual({ low: 99_999, high: 100_000 });
    expect(result.auditorDays).toEqual({ low: 12_499.8, high: 12_500 });
  });

  it('sums Number.MAX_SAFE_INTEGER lines across files without Number accumulation', () => {
    const result = est(
      input(
        [
          file('file:src/A.sol', Number.MAX_SAFE_INTEGER),
          file('file:src/B.sol', Number.MAX_SAFE_INTEGER),
        ],
        zeroParameters(),
      ),
    );
    expect(totals(result)).toEqual({ low: 0, high: 0 });
    expect(result.contributions).toHaveLength(10);
  });

  it('rejects oversized rows and totals without clamping', () => {
    const huge = zeroParameters({ slocHours: range(10) });
    expect(() =>
      estimateEffort(input([file('file:src/A.sol', Number.MAX_SAFE_INTEGER)], huge)),
    ).toThrow(EstimationError);
    expect(() => estimateEffort(input([file('file:src/A.sol', 10_000_000_000_000)], huge))).toThrow(
      EstimationError,
    );
    expect(
      reasonOf(
        input([file('file:src/A.sol', 1)], zeroParameters(), {
          manualAdjustments: [manual('discount', -1, -1)],
        }),
      ),
    ).toBe('invalid-total');
  });
});

describe('identity, determinism and ownership', () => {
  const surrogates = ['file:a\ud800', 'file:a\ud801', 'file:a�', 'file:a\u{1f600}', 'file:a'];

  it('keeps distinct file, pair and manual identities with unpaired surrogates', () => {
    const files = surrogates.map((id) => file(id, 10));
    const pairList = surrogates.map((id) => ({ leftId: `x${id}`, rightId: 'right' }));
    const manuals = surrogates.map((id) => manual(`m${id}`, 0));
    const value = defaultInput(files, { scopedPairs: pairList, manualAdjustments: manuals });
    const first = est(value);
    const second = est(value);
    expect(new Set(first.contributions.map((item) => item.id)).size).toBe(
      first.contributions.length,
    );
    expect(first.contributions).toHaveLength(2 + 20 + 5 + 5);
    expect(first.contributions.map((item) => item.id)).toEqual(
      second.contributions.map((item) => item.id),
    );
    expect(EstimateResultSchema.safeParse(first).success).toBe(true);
  });

  it('keeps bounded unique IDs for long files, delimiters and reversed pairs', () => {
    const long = file(`file:${'a'.repeat(4000)}`, 10);
    const longer = file(`file:${'a'.repeat(4000)}b`, 10);
    const value = defaultInput([long, longer], {
      scopedPairs: [
        { leftId: 'a>b', rightId: 'c' },
        { leftId: 'a', rightId: 'b>c' },
        { leftId: 'c', rightId: 'a>b' },
      ],
      contextPairs: [{ leftId: 'a>b', rightId: 'c\u0000' }],
    });
    const result = est(value);
    expect(new Set(result.contributions.map((item) => item.id)).size).toBe(
      result.contributions.length,
    );
    for (const item of result.contributions) expect(item.id.length).toBeLessThanOrEqual(512);
  });

  it('is permutation invariant and byte stable', () => {
    const files = [
      file('file:src/B.sol', 50),
      file('file:src/A.sol', 70, { decisions: measured(3) }),
    ];
    const forward = defaultInput(files, {
      scopedPairs: pairs(3),
      contextPairs: pairs(2, 10),
      manualAdjustments: [manual('a', 1), manual('b', 2)],
    });
    const reversed = defaultInput([...files].reverse(), {
      scopedPairs: [...pairs(3)].reverse(),
      contextPairs: [...pairs(2, 10)].reverse(),
      manualAdjustments: [manual('a', 1), manual('b', 2)],
    });
    const a = est(forward);
    expect(JSON.stringify(est(reversed))).toBe(JSON.stringify(a));
    expect(JSON.stringify(est(forward))).toBe(JSON.stringify(a));
  });

  it('permutes shapes and complex IDs without changing the result', () => {
    const shapes: StateVariableShape[] = [
      { declarationId: 'decl:src/A.sol:state-variable:1', shape: 'mapping', mutable: true },
      { declarationId: 'decl:src/A.sol:state-variable:2', shape: 'array', mutable: true },
      { declarationId: 'decl:src/A.sol:state-variable:3', shape: 'elementary', mutable: true },
    ];
    const make = (list: readonly StateVariableShape[], ids: readonly string[]): EstimateInput =>
      defaultInput([
        file('file:src/A.sol', 100, {
          stateVariables: {
            count: measured(3),
            mutableCount: measured(3),
            complexMutableDeclarationIds: { status: 'measured', value: ids, evidence: [] },
            typeShapes: { status: 'measured', value: list, evidence: [] },
          },
        }),
      ]);
    const ids = shapes.slice(0, 2).map((item) => item.declarationId);
    expect(est(make([...shapes].reverse(), [...ids].reverse()))).toEqual(est(make(shapes, ids)));
  });

  it('does not mutate frozen inputs and isolates result ownership', () => {
    const value = defaultInput([file('file:src/A.sol', 100)], {
      manualAdjustments: [manual('m', 1, 2)],
    });
    const deepFreeze = (target: unknown): void => {
      if (typeof target !== 'object' || target === null) return;
      Object.freeze(target);
      for (const child of Object.values(target)) deepFreeze(child);
    };
    deepFreeze(value);
    const result = est(value);
    expect(result.manualAdjustments[0]).not.toBe(value.manualAdjustments[0]);
    expect(result.manualAdjustments).toEqual(value.manualAdjustments);
    expect(result.parameters).not.toBe(value.model.parameters);
    expect(Object.isFrozen(result.parameters)).toBe(false);
  });

  it('rejects schema-invalid duplicates', () => {
    const base = defaultInput([file('file:src/A.sol', 10)]);
    for (const bad of [
      { ...base, eligibleFiles: [file('file:src/A.sol', 10), file('file:src/A.sol', 10)] },
      { ...base, scopedPairs: [{ leftId: 'a', rightId: 'a' }] },
      { ...base, scopedPairs: pairs(1), contextPairs: pairs(1) },
      { ...base, manualAdjustments: [manual('x', 0), manual('x', 0)] },
    ]) {
      expect(() => Reflect.apply(estimateEffort, undefined, [bad])).toThrow(EstimationError);
    }
  });
});

describe('numerical properties', () => {
  it('lets assembly dominate low-level calls by max, not by sum', () => {
    const evmHigh = (assembly: number, calls: number): number =>
      row(
        est(
          defaultInput([
            file('file:src/A.sol', 100, {
              assemblyBlocks: measured(assembly),
              confirmedBuiltinLowLevelCalls: measured(calls),
            }),
          ]),
        ),
        'evm',
      ).highMicrohours;
    expect(evmHigh(0, 0)).toBe(0);
    expect(evmHigh(0, 5)).toBe(3_000_000);
    expect(evmHigh(1, 0)).toBe(6_000_000);
    expect(evmHigh(1, 5)).toBe(evmHigh(7, 0));
    expect(evmHigh(3, 9)).toBe(6_000_000);
  });

  it('increases decisions only up to the density cap', () => {
    const control = (decisions: number): number =>
      row(
        est(defaultInput([file('file:src/A.sol', 100, { decisions: measured(decisions) })])),
        'control',
      ).highMicrohours;
    const values = Array.from({ length: 26 }, (_, decisions) => control(decisions));
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values.slice(10))).toEqual(new Set([3_000_000]));
    expect(values[9]).toBeLessThan(3_000_000);
    expect(values[5]).toBe(1_500_000);
  });

  it('never lowers the total when L grows at fixed D', () => {
    let previous = 0;
    for (let lines = 1; lines <= 300; lines += 7) {
      const result = est(defaultInput([file('file:src/A.sol', lines, { decisions: measured(5) })]));
      const { high } = totals(result);
      expect(high).toBeGreaterThanOrEqual(previous);
      previous = high;
    }
  });

  it('excludes manual allowances from the reserve and keeps negative totals typed', () => {
    const base = defaultInput([file('file:src/A.sol', 100)], { hasUnknownSemantics: true });
    const without = est(base);
    const withManual = est({ ...base, manualAdjustments: [manual('big', 10, 50)] });
    expect(row(withManual, 'reserve').highMicrohours).toBe(row(without, 'reserve').highMicrohours);
    expect(row(withManual, 'reserve').lowMicrohours).toBe(0);
    expect(totals(withManual).high - totals(without).high).toBe(50_000_000);
    const discount = est({ ...base, manualAdjustments: [manual('cut', -1, -1)] });
    expect(totals(discount).high).toBeLessThan(totals(without).high);
  });

  it('changes only days and the echoed parameter with hours per day', () => {
    const files = [file('file:src/A.sol', 100)];
    const base = defaultInput(files, { manualAdjustments: [manual('m', 1, 2)] });
    const other = {
      ...base,
      model: {
        ...base.model,
        parameters: { ...base.model.parameters, hoursPerDay: 6 },
      },
    };
    const a = est(base);
    const b = est(other);
    expect(b.parameters.hoursPerDay).toBe(6);
    expect(b.auditorHours).toEqual(a.auditorHours);
    expect(b.contributions).toEqual(a.contributions);
    expect(b.coverage).toBe(a.coverage);
    expect(b.manualAdjustments).toEqual(a.manualAdjustments);
    expect(b.auditorDays).not.toEqual(a.auditorDays);
  });

  it('uses an overridden effective profile and leaves defaults immutable', () => {
    const overridden = zeroParameters({ projectHours: range(2, 3) });
    const result = est(input([file('file:src/A.sol', 1)], overridden));
    expect(totals(result)).toEqual({ low: 2_000_000, high: 3_000_000 });
    expect(selectModel().parameters.projectHours).toEqual({ low: 4, high: 12 });
  });

  it('supports six-decimal and scientific number spellings exactly', () => {
    const result = est(
      input([file('file:src/A.sol', 100)], zeroParameters({ slocHours: range(1e-6, 1.5e-5) })),
    );
    expect(row(result, 'baseline')).toMatchObject({ lowMicrohours: 100, highMicrohours: 1500 });
  });

  it('allows zero rates and allowances with positive SLOC', () => {
    const result = est(input([file('file:src/A.sol', 5)], zeroParameters()));
    expect(result.auditorHours).toEqual({ low: 0, high: 0 });
  });
});

describe('storage channel availability and contradictions', () => {
  const id = (n: number): string => `decl:src/A.sol:state-variable:${n}`;
  const shape = (
    n: number,
    kind: StateVariableShape['shape'],
    mutable = true,
  ): StateVariableShape => ({
    declarationId: id(n),
    shape: kind,
    mutable,
  });
  const list = <T>(value: readonly T[]): Measurement<readonly T[]> => ({
    status: 'measured',
    value,
    evidence: [],
  });
  function state(overrides: Partial<StateVariables>): StateVariables {
    return {
      count: measured(2),
      mutableCount: measured(2),
      complexMutableDeclarationIds: list([id(1)]),
      typeShapes: list([shape(1, 'mapping'), shape(2, 'elementary')]),
      ...overrides,
    };
  }
  const build = (stateVariables: StateVariables): EstimateInput =>
    defaultInput([file('file:src/A.sol', 100, { stateVariables })]);

  it('computes the measured density', () => {
    const result = est(build(state({})));
    expect(row(result, 'storage')).toMatchObject({
      inputStatus: 'measured',
      highMicrohours: 900_000,
    });
    expect(row(result, 'reserve').highMicrohours).toBe(0);
  });

  it('supports an explicitly synthetic resolved-struct plain input', () => {
    const result = est(
      build(
        state({
          complexMutableDeclarationIds: list([id(1), id(2)]),
          typeShapes: list([shape(1, 'mapping'), shape(2, 'struct')]),
        }),
      ),
    );
    expect(row(result, 'storage').highMicrohours).toBe(1_800_000);
  });

  it('rejects measured contradictions', () => {
    const contradictions: readonly [string, StateVariables][] = [
      [
        'duplicate shape IDs',
        state({ typeShapes: list([shape(1, 'mapping'), shape(1, 'mapping')]) }),
      ],
      ['shape count mismatch', state({ count: measured(3) })],
      [
        'missing known mutable mapping',
        state({
          complexMutableDeclarationIds: list([]),
          typeShapes: list([shape(1, 'mapping'), shape(2, 'elementary')]),
        }),
      ],
      [
        'duplicate with unavailable mutable count',
        state({
          mutableCount: unavailable,
          typeShapes: list([shape(1, 'mapping'), shape(1, 'mapping')]),
        }),
      ],
      [
        'S=0 with duplicate shape IDs',
        state({
          count: measured(2),
          mutableCount: measured(0),
          complexMutableDeclarationIds: list([]),
          typeShapes: list([shape(1, 'elementary', false), shape(1, 'elementary', false)]),
        }),
      ],
      ['complex ID declared elementary', state({ complexMutableDeclarationIds: list([id(2)]) })],
    ];
    const reasons = contradictions.map(([, stateVariables]) => reasonOf(build(stateVariables)));
    expect(reasons).toEqual(contradictions.map(() => 'inconsistent-measurements'));
  });

  it('omits the channel and adds the reserve when required inputs are unavailable', () => {
    const unavailableCases: readonly [string, StateVariables][] = [
      ['mutable count', state({ mutableCount: unavailable })],
      ['shapes', state({ typeShapes: unavailable })],
      ['complex classification', state({ complexMutableDeclarationIds: unavailable })],
      [
        'user-defined shape with syntax-only complex list',
        state({ typeShapes: list([shape(1, 'mapping'), shape(2, 'user-defined')]) }),
      ],
      ['unknown shape', state({ typeShapes: list([shape(1, 'mapping'), shape(2, 'unknown')]) })],
    ];
    const results = unavailableCases.map(([, stateVariables]) => est(build(stateVariables)));
    expect(results.map((result) => row(result, 'storage'))).toMatchObject(
      unavailableCases.map(() => ({
        lowMicrohours: 0,
        highMicrohours: 0,
        inputStatus: 'unavailable',
      })),
    );
    expect(results.map((result) => row(result, 'reserve').highMicrohours > 0)).toEqual(
      unavailableCases.map(() => true),
    );
  });

  it('keeps a measured zero when S=0 even with unavailable shapes', () => {
    const result = est(
      build(
        state({
          count: measured(1),
          mutableCount: measured(0),
          complexMutableDeclarationIds: unavailable,
          typeShapes: unavailable,
        }),
      ),
    );
    expect(row(result, 'storage')).toMatchObject({ inputStatus: 'measured', highMicrohours: 0 });
    expect(row(result, 'reserve').highMicrohours).toBe(0);
  });

  it('does not require the total declaration count', () => {
    const result = est(build(state({ count: unavailable })));
    expect(row(result, 'storage')).toMatchObject({
      inputStatus: 'measured',
      highMicrohours: 900_000,
    });
  });

  it('keeps assembly dominance while retaining the unavailable-builtin reserve', () => {
    const result = est(
      defaultInput([
        file('file:src/A.sol', 100, {
          assemblyBlocks: measured(1),
          confirmedBuiltinLowLevelCalls: unavailable,
        }),
      ]),
    );
    expect(row(result, 'evm')).toMatchObject({
      inputStatus: 'measured',
      highMicrohours: 6_000_000,
    });
    expect(row(result, 'reserve').highMicrohours).toBeGreaterThan(0);
  });
});
