import picomatch from 'picomatch';
import type { AnalysisLimits } from '../domain/types.ts';
import { BudgetError, type DiscoveryBudget } from './budget.ts';
import { validatePatternList } from '../config/validate.ts';

type SegmentMatcher = (value: string) => boolean;

interface CompiledPattern {
  readonly source: string;
  readonly segments: readonly { readonly source: string; readonly match: SegmentMatcher }[];
}

export interface CompiledPatternList {
  readonly patterns: readonly CompiledPattern[];
}

const PATTERN_OPTIONS = {
  basename: false,
  bash: false,
  capture: false,
  contains: false,
  debug: false,
  dot: true,
  fastpaths: false,
  keepQuotes: true,
  nobrace: true,
  nobracket: true,
  nocase: false,
  noextglob: true,
  nonegate: true,
  noglobstar: true,
  regex: false,
  strictBrackets: true,
  strictSlashes: true,
  unescape: false,
  windows: false,
} as const;

const MATCH_YIELD_BATCH = 256;

/** Validates once and compiles only bounded, single path segments. */
export function compilePatternList(
  patterns: readonly string[],
  limits: Pick<AnalysisLimits, 'maxPatternsPerList' | 'maxPatternLength'>,
): CompiledPatternList {
  validatePatternList(patterns, limits.maxPatternsPerList, limits.maxPatternLength);
  const cache = new Map<string, SegmentMatcher>();
  const compiled = patterns.map((source) => {
    const segments = source.split('/').map((segment) => {
      if (segment === '**') return { source: segment, match: (_value: string): boolean => true };
      let matcher = cache.get(segment);
      if (matcher === undefined) {
        matcher = picomatch(segment, PATTERN_OPTIONS);
        cache.set(segment, matcher);
      }
      return { source: segment, match: matcher };
    });
    return { source, segments };
  });
  return { patterns: compiled };
}

function pathSegments(path: string): readonly string[] {
  if (path === '.' || path.length === 0) return [];
  if (path.startsWith('/') || path.includes('\\')) return [];
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return [];
  }
  return segments;
}

async function matchesOne(
  pattern: CompiledPattern,
  pathParts: readonly string[],
  budget: DiscoveryBudget,
): Promise<boolean> {
  let previous = new Uint8Array(pathParts.length + 1);
  previous[0] = 1;
  let operations = 0;
  for (const patternSegment of pattern.segments) {
    const current = new Uint8Array(pathParts.length + 1);
    if (patternSegment.source === '**') current[0] = previous[0] ?? 0;
    for (let pathIndex = 1; pathIndex <= pathParts.length; pathIndex += 1) {
      budget.chargeGlobState();
      const pathSegment = pathParts[pathIndex - 1];
      if (patternSegment.source === '**') {
        current[pathIndex] =
          (previous[pathIndex] ?? 0) === 1 || (current[pathIndex - 1] ?? 0) === 1 ? 1 : 0;
      } else {
        current[pathIndex] =
          (previous[pathIndex - 1] ?? 0) === 1 &&
          pathSegment !== undefined &&
          patternSegment.match(pathSegment)
            ? 1
            : 0;
      }
      operations += 1;
      if (operations === MATCH_YIELD_BATCH) {
        operations = 0;
        await budget.checkpoint(true);
      }
    }
    previous = current;
  }
  budget.check();
  return previous[pathParts.length] === 1;
}

/** Returns the first matching pattern index, charging every DP state to the shared budget. */
export async function findMatchingPattern(
  path: string,
  compiled: CompiledPatternList,
  budget: DiscoveryBudget,
): Promise<number | null> {
  budget.check();
  const pathParts = pathSegments(path);
  if (pathParts.length === 0 && path !== '.') return null;
  for (let index = 0; index < compiled.patterns.length; index += 1) {
    const pattern = compiled.patterns[index];
    if (pattern !== undefined && (await matchesOne(pattern, pathParts, budget))) return index;
  }
  return null;
}

/** True only when a trailing globstar proves every descendant of this directory is excluded. */
export async function findPrunablePattern(
  directoryPath: string,
  compiled: CompiledPatternList,
  budget: DiscoveryBudget,
): Promise<number | null> {
  budget.check();
  const pathParts = pathSegments(directoryPath);
  if (pathParts.length === 0 && directoryPath !== '.') return null;
  for (let index = 0; index < compiled.patterns.length; index += 1) {
    const pattern = compiled.patterns[index];
    if (pattern === undefined || !(pattern.source === '**' || pattern.source.endsWith('/**')))
      continue;
    if (await matchesOne(pattern, pathParts, budget)) return index;
  }
  return null;
}

export function isGlobBudgetError(error: unknown): error is BudgetError {
  return error instanceof BudgetError && error.budget === 'globStates';
}
