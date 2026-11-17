import { EstimateInputSchema, EstimateResultSchema } from '../domain/schemas.ts';
import type { EstimateInput, EstimateResult, ParameterRange } from '../domain/types.ts';
import { classifyFile, eligibleCoverage } from './eligibility.ts';
import type { Channel, FileFacts } from './eligibility.ts';
import {
  ceilDivide,
  ceilMicro,
  ceilScaled,
  floorDivide,
  floorMicro,
  rational,
  fromDecimal,
  multiply,
} from './fixed-point.ts';
import type { Rational } from './fixed-point.ts';
import { MAX_ROWS, toContributions } from './ledger.ts';
import type { LedgerRow } from './ledger.ts';
import { EstimationError } from './model.ts';

export { EstimationError, selectModel } from './model.ts';
export type { EstimationErrorReason } from './model.ts';

const MAX_OUTPUT = 1_000_000_000n;
const MAX_DAY_TENTHS = MAX_OUTPUT * 10n;

const ASSUMPTIONS: readonly string[] = [
  'Every coefficient is an uncalibrated planning assumption, not a measured productivity or industry rate.',
  'Low and high are scenario bounds with no stated probability, percentage accuracy or confidence level.',
  'Hours are cumulative initial-review effort across participating auditors and exclude remediation, fix verification, duplicate independent reviews, proofs and calendar time unless added as manual adjustments.',
];

const REUSE_ASSUMPTION =
  'Declarations excluded by the caller or recognized as reusable source receive no full-review baseline or premium; this is an uncalibrated planning assumption and a content match does not verify an installed version, bindings, compiler behavior, deployment or security.';

const TEXT = {
  baseline:
    'SLOC baseline for one eligible file: measured lines times the SLOC hour rate (uncalibrated assumption).',
  control:
    'Control premium on the file baseline, scaled by the measured decision density (uncalibrated assumption).',
  controlOmitted:
    'Control premium omitted: the decision count is unavailable, so zero does not assert absence; the high reserve applies.',
  storage:
    'Storage premium on the file baseline, scaled by the measured complex mutable declaration share (uncalibrated assumption).',
  storageOmitted:
    'Storage premium omitted: a required storage measurement or classification is unavailable, so zero does not assert absence; the high reserve applies.',
  evm: 'EVM premium on the file baseline for measured assembly or confirmed builtin low-level calls (uncalibrated assumption).',
  evmOmitted:
    'EVM premium omitted: a required assembly or builtin low-level call measurement is unavailable, so zero does not assert absence; the high reserve applies.',
  interaction:
    'Interaction allowance for one unique scoped directed contract pair (uncalibrated assumption).',
  boundary:
    'Boundary allowance for one unique scoped-to-context directed contract pair (uncalibrated assumption).',
  manual:
    'Reasoned manual adjustment supplied by the operator; the reserve is never applied to it.',
  reviewBaseline:
    'SLOC baseline for one eligible file: measured effective review lines (physical lines of retained code) times the SLOC hour rate (uncalibrated assumption).',
  reviewBoundary:
    'Boundary allowance for one unique directed pair between full-review code and either context or reusable code (uncalibrated assumption).',
  project: 'Fixed project allowance (uncalibrated assumption), charged once.',
  reserve:
    'High-scenario uncertainty reserve on the rounded pre-manual high subtotal; the low scenario has none (uncalibrated assumption).',
} as const;

interface Scenarios {
  readonly low: Rational;
  readonly high: Rational;
}

function scenarios(range: ParameterRange): Scenarios {
  return { low: fromDecimal(range.low), high: fromDecimal(range.high) };
}

function premiumRow(
  category: 'control' | 'storage' | 'evm',
  fileId: string,
  channel: Channel,
  baseline: Scenarios,
  premium: Scenarios,
  measuredText: string,
  omittedText: string,
): LedgerRow {
  if (channel.status === 'unavailable') {
    return {
      category,
      identity: [fileId],
      low: 0n,
      high: 0n,
      inputStatus: 'unavailable',
      explanation: omittedText,
    };
  }
  return {
    category,
    identity: [fileId],
    low: floorMicro(multiply(multiply(baseline.low, premium.low), channel.factor)),
    high: ceilMicro(multiply(multiply(baseline.high, premium.high), channel.factor)),
    inputStatus: 'measured',
    explanation: measuredText,
  };
}

function filesRows(facts: readonly FileFacts[], input: EstimateInput): LedgerRow[] {
  const parameters = input.model.parameters;
  const baselineText = input.model.modelVersion === '1.0.0' ? TEXT.baseline : TEXT.reviewBaseline;
  const sloc = scenarios(parameters.slocHours);
  const control = scenarios(parameters.controlPremium);
  const storage = scenarios(parameters.storagePremium);
  const evm = scenarios(parameters.evmPremium);
  const rows: LedgerRow[] = [];
  for (const file of facts) {
    const lines = rational(file.sourceLines);
    const baseline: Scenarios = {
      low: multiply(lines, sloc.low),
      high: multiply(lines, sloc.high),
    };
    rows.push({
      category: 'baseline',
      identity: [file.fileId],
      low: floorMicro(baseline.low),
      high: ceilMicro(baseline.high),
      inputStatus: 'measured',
      explanation: baselineText,
    });
    rows.push(
      premiumRow(
        'control',
        file.fileId,
        file.control,
        baseline,
        control,
        TEXT.control,
        TEXT.controlOmitted,
      ),
      premiumRow(
        'storage',
        file.fileId,
        file.storage,
        baseline,
        storage,
        TEXT.storage,
        TEXT.storageOmitted,
      ),
      premiumRow('evm', file.fileId, file.evm, baseline, evm, TEXT.evm, TEXT.evmOmitted),
    );
  }
  return rows;
}

function pairRows(
  category: 'interaction' | 'boundary',
  pairs: EstimateInput['scopedPairs'],
  range: ParameterRange,
  explanation: string,
): LedgerRow[] {
  const rate = scenarios(range);
  const low = floorMicro(rate.low);
  const high = ceilMicro(rate.high);
  return pairs.map((pair) => ({
    category,
    identity: [pair.leftId, pair.rightId],
    low,
    high,
    inputStatus: 'measured',
    explanation,
  }));
}

function sum(rows: readonly LedgerRow[], field: 'low' | 'high'): bigint {
  let total = 0n;
  for (const row of rows) total += row[field];
  return total;
}

function displayRange(
  low: bigint,
  high: bigint,
  hoursPerDay: Rational,
): { readonly hours: ParameterRange; readonly days: ParameterRange } {
  const lowHours = floorDivide(low, 1_000_000n);
  const highHours = ceilDivide(high, 1_000_000n);
  if (lowHours > MAX_OUTPUT || highHours > MAX_OUTPUT) throw new EstimationError('output-bound');
  const lowDays = floorDivide(lowHours * 10n * hoursPerDay.denominator, hoursPerDay.numerator);
  const highDays = ceilDivide(highHours * 10n * hoursPerDay.denominator, hoursPerDay.numerator);
  if (lowDays > MAX_DAY_TENTHS || highDays > MAX_DAY_TENTHS) {
    throw new EstimationError('output-bound');
  }
  return {
    hours: { low: Number(lowHours), high: Number(highHours) },
    days: { low: Number(lowDays) / 10, high: Number(highDays) / 10 },
  };
}

/**
 * Pure deterministic effort calculation. Returns null when the input is not eligible for an
 * estimate; throws `EstimationError` for invalid input, contradictory facts or exceeded bounds.
 */
export function estimateEffort(input: EstimateInput): EstimateResult | null {
  let parsed: ReturnType<typeof EstimateInputSchema.safeParse>;
  try {
    parsed = EstimateInputSchema.safeParse(input);
  } catch {
    throw new EstimationError('invalid-input');
  }
  if (!parsed.success) throw new EstimationError('invalid-input');
  const data = parsed.data;

  const coverage = eligibleCoverage(data);
  if (coverage === null) return null;

  const rowCount =
    2 +
    4 * data.eligibleFiles.length +
    data.scopedPairs.length +
    data.contextPairs.length +
    data.manualAdjustments.length;
  if (rowCount > MAX_ROWS) throw new EstimationError('output-bound');

  const facts = data.eligibleFiles.map(classifyFile);
  const effectiveUnknown = data.hasUnknownSemantics || facts.some((file) => file.unknown);
  const parameters = data.model.parameters;
  const project = scenarios(parameters.projectHours);
  const legacy = data.model.modelVersion === '1.0.0';

  const projectRow: LedgerRow = {
    category: 'project',
    identity: undefined,
    low: floorMicro(project.low),
    high: ceilMicro(project.high),
    inputStatus: 'measured',
    explanation: TEXT.project,
  };
  const preManual: LedgerRow[] = [
    projectRow,
    ...filesRows(facts, data),
    ...pairRows('interaction', data.scopedPairs, parameters.interactionHours, TEXT.interaction),
    ...pairRows(
      'boundary',
      data.contextPairs,
      parameters.boundaryHours,
      legacy ? TEXT.boundary : TEXT.reviewBoundary,
    ),
  ];
  const preLow = sum(preManual, 'low');
  const preHigh = sum(preManual, 'high');
  const reserveHigh = effectiveUnknown
    ? ceilScaled(preHigh, fromDecimal(parameters.unknownReserveHigh))
    : 0n;
  const manualRows: LedgerRow[] = data.manualAdjustments.map((item) => ({
    category: 'manual',
    identity: [item.id],
    low: floorMicro(fromDecimal(item.lowHours)),
    high: ceilMicro(fromDecimal(item.highHours)),
    inputStatus: 'manual',
    explanation: TEXT.manual,
  }));
  const reserveRow: LedgerRow = {
    category: 'reserve',
    identity: undefined,
    low: 0n,
    high: reserveHigh,
    inputStatus: 'measured',
    explanation: TEXT.reserve,
  };

  const totalLow = preLow + sum(manualRows, 'low');
  const totalHigh = preHigh + reserveHigh + sum(manualRows, 'high');
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if ([totalLow, totalHigh, preLow, preHigh].some((value) => value > limit || value < -limit)) {
    throw new EstimationError('unsafe-arithmetic');
  }
  if (totalLow < 0n || totalHigh < 0n || totalLow > totalHigh) {
    throw new EstimationError('invalid-total');
  }

  const contributions = toContributions([...preManual, reserveRow, ...manualRows]);
  const display = displayRange(totalLow, totalHigh, fromDecimal(parameters.hoursPerDay));

  const candidate: EstimateResult = {
    profile: data.model.profile,
    modelVersion: data.model.modelVersion,
    label: 'uncalibrated heuristic',
    coverage,
    auditorHours: display.hours,
    auditorDays: display.days,
    contributions,
    assumptions: legacy ? [...ASSUMPTIONS] : [...ASSUMPTIONS, REUSE_ASSUMPTION],
    manualAdjustments: data.manualAdjustments.map((item) => ({ ...item })),
    parameters: structuredClone(parameters),
  };
  const checked = EstimateResultSchema.safeParse(candidate);
  if (!checked.success) throw new EstimationError('output-bound');
  return checked.data;
}
