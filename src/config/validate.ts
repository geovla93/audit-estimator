import { ConfigInputSchema, ResolvedConfigSchema } from '../domain/schemas.ts';
import type { AnalysisLimits, ConfigInput, ResolvedConfig } from '../domain/types.ts';
import { ConfigError } from './defaults.ts';

export { ConfigError } from './defaults.ts';

export function parseConfigInput(value: unknown): ConfigInput {
  const result = ConfigInputSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigError('Configuration data is invalid.');
  }
  if (
    result.data.solidity !== undefined &&
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(result.data.solidity.version)
  ) {
    throw new ConfigError('Configuration data is invalid.');
  }
  return result.data;
}

export function validateConfigPatterns(
  input: ConfigInput,
  limits: Pick<AnalysisLimits, 'maxPatternsPerList' | 'maxPatternLength'>,
): void {
  const patterns = input.scope;
  if (patterns === undefined) return;
  validatePatternList(patterns.include ?? [], limits.maxPatternsPerList, limits.maxPatternLength);
  validatePatternList(patterns.exclude ?? [], limits.maxPatternsPerList, limits.maxPatternLength);
}

export function parseResolvedConfig(value: unknown): ResolvedConfig {
  const result = ResolvedConfigSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigError('Resolved configuration is invalid.');
  }
  return result.data;
}

export function validatePatternList(
  patterns: readonly string[],
  maximumCount: number,
  maximumLength: number,
): void {
  if (patterns.length > maximumCount) {
    throw new ConfigError('A path pattern list exceeds its configured limit.');
  }

  for (const pattern of patterns) {
    if (
      pattern.length > maximumLength ||
      pattern.startsWith('/') ||
      /^[A-Za-z]:/u.test(pattern) ||
      pattern.endsWith('/') ||
      pattern.includes('\\') ||
      /[!{}()[\]]/u.test(pattern) ||
      Array.from(pattern).some((scalar) => {
        const point = scalar.codePointAt(0) ?? 0;
        return point <= 0x1f || point === 0x7f;
      })
    ) {
      throw new ConfigError('A path pattern is invalid.');
    }

    const segments = pattern.split('/');
    if (
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === '.' ||
          segment === '..' ||
          (segment !== '**' && (segment.match(/\*/gu)?.length ?? 0) > 1),
      )
    ) {
      throw new ConfigError('A path pattern is invalid.');
    }
  }
}
