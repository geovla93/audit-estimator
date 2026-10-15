import { canonicalJson, fingerprint, sortById } from '../domain/canonical.ts';
import type { EstimateResult } from '../domain/types.ts';
import { toSafeNumber } from './fixed-point.ts';
import { EstimationError } from './model.ts';

export type RowCategory =
  | 'baseline'
  | 'control'
  | 'storage'
  | 'evm'
  | 'interaction'
  | 'boundary'
  | 'manual'
  | 'project'
  | 'reserve';

export type Contribution = EstimateResult['contributions'][number];

/** Internal row: exact BigInt microhours plus the identity tuple used to derive the public ID. */
export interface LedgerRow {
  readonly category: RowCategory;
  /** Undefined for the singleton project and reserve rows. */
  readonly identity: readonly string[] | undefined;
  readonly low: bigint;
  readonly high: bigint;
  readonly inputStatus: Contribution['inputStatus'];
  readonly explanation: string;
}

export const MAX_ROWS = 100_000;
const ROW_LIMIT = 100_000_000_000n;

/**
 * Singleton rows keep their category as ID. Other IDs hash the JSON-encoded identity tuple, which
 * preserves unpaired surrogates and tuple boundaries that raw UTF-8 framing would lose.
 */
export function rowId(category: RowCategory, identity: readonly string[] | undefined): string {
  if (identity === undefined) return category;
  return `${category}:${fingerprint([category, canonicalJson(identity)])}`;
}

/** Converts exact rows to the public DTO shape, sorted by code points. */
export function toContributions(rows: readonly LedgerRow[]): Contribution[] {
  if (rows.length > MAX_ROWS) throw new EstimationError('output-bound');
  const publicRows: Contribution[] = rows.map((row) => {
    const low = toSafeNumber(row.low);
    const high = toSafeNumber(row.high);
    if (
      row.low < -ROW_LIMIT ||
      row.low > ROW_LIMIT ||
      row.high < -ROW_LIMIT ||
      row.high > ROW_LIMIT
    ) {
      throw new EstimationError('output-bound');
    }
    return {
      id: rowId(row.category, row.identity),
      category: row.category,
      lowMicrohours: low,
      highMicrohours: high,
      inputStatus: row.inputStatus,
      explanation: row.explanation,
    };
  });
  return sortById(publicRows);
}
