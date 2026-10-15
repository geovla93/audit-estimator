import { z } from 'zod';
import { ConfigInputSchema, ReportEnvelopeSchema } from './schemas.ts';
import type { ConfigInput, ReportEnvelope } from './types.ts';
import { acceptsReportVersion } from './versions.ts';

export const MAX_CONFIG_BYTES: number = 256 * 1024;

function rejectPrototypeKeys(input: unknown): void {
  const pending: unknown[] = [input];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object') continue;
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error('CONFIG_INVALID: forbidden object key');
      }
      pending.push((value as Record<string, unknown>)[key]);
    }
  }
}

/** Call before parsing JSON so oversized input never reaches the parser. */
export function parseConfigBytes(bytes: Uint8Array): ConfigInput {
  if (bytes.byteLength > MAX_CONFIG_BYTES)
    throw new Error('CONFIG_INVALID: configuration exceeds 256 KiB');
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error: unknown) {
    throw new Error('CONFIG_INVALID: invalid UTF-8 or JSON', { cause: error });
  }
  rejectPrototypeKeys(input);
  return ConfigInputSchema.parse(input);
}

export function parseProducerReport(input: unknown): ReportEnvelope {
  return ReportEnvelopeSchema.parse(input);
}

/** A reader validates the stable v1 envelope and tolerates additive v1.x data and codes. */
const consumerEnvelopeSchema: z.ZodType<{
  schemaVersion: string;
  toolVersion: string;
  command: 'estimate' | 'inspect' | 'explain';
  status: 'complete' | 'partial' | 'error';
  diagnostics: readonly { code: string; severity: 'info' | 'warning' | 'error'; message: string }[];
}> = z.looseObject({
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

export interface ConsumerEnvelope {
  readonly schemaVersion: string;
  readonly toolVersion: string;
  readonly command: 'estimate' | 'inspect' | 'explain';
  readonly status: 'complete' | 'partial' | 'error';
  readonly diagnostics: readonly {
    readonly code: string;
    readonly severity: 'info' | 'warning' | 'error';
    readonly message: string;
  }[];
}

export function parseConsumerEnvelope(input: unknown): ConsumerEnvelope {
  const parsed = consumerEnvelopeSchema.parse(input);
  if (!acceptsReportVersion(parsed.schemaVersion))
    throw new Error('Unsupported report schema major');
  return parsed;
}
