import { canonicalJson } from '../domain/canonical.ts';
import type { ReportEnvelope } from '../domain/types.ts';
import { parseDisplayEnvelope } from './display.ts';

/** Serializes a validated report with stable collection and object-key ordering. */
export function serializeJson(envelope: ReportEnvelope): string {
  const normalized = parseDisplayEnvelope(envelope);
  const canonical = canonicalJson(normalized);
  const parsed: unknown = JSON.parse(canonical);
  const pretty = JSON.stringify(parsed, null, 2);
  if (pretty === undefined) throw new Error('Validated report could not be serialized');
  return `${pretty}\n`;
}
