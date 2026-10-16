import { describe, expect, it } from 'vitest';
import { createDiscoveryBudget, BudgetError } from '../../src/discovery/budget.ts';
import {
  compilePatternList,
  findMatchingPattern,
  findPrunablePattern,
  isGlobBudgetError,
} from '../../src/discovery/patterns.ts';
import { testLimits } from '../helpers/filesystem.ts';

describe('discovery path patterns', () => {
  it('matches zero and multiple globstar segments with root-relative anchoring', async () => {
    const budget = createDiscoveryBudget(testLimits());
    const compiled = compilePatternList(
      ['src/**/A.sol', '**/Root.sol', 'contracts/*.sol'],
      budget.limits,
    );
    expect(await findMatchingPattern('src/A.sol', compiled, budget)).toBe(0);
    expect(await findMatchingPattern('src/deep/nested/A.sol', compiled, budget)).toBe(0);
    expect(await findMatchingPattern('Root.sol', compiled, budget)).toBe(1);
    expect(await findMatchingPattern('contracts/A.sol', compiled, budget)).toBe(2);
    expect(await findMatchingPattern('nested/contracts/A.sol', compiled, budget)).toBeNull();
  });

  it('matches dotfiles and keeps accepted regexp punctuation and quotes literal', async () => {
    const budget = createDiscoveryBudget(testLimits());
    const literals = [
      'plus+sign.sol',
      'cash$.sol',
      'caret^.sol',
      'pipe|name.sol',
      "single'quote.sol",
      'double"quote.sol',
    ];
    const compiled = compilePatternList(literals, budget.limits);
    for (let index = 0; index < literals.length; index += 1) {
      const pattern = literals[index];
      expect(pattern).toBeDefined();
      expect(await findMatchingPattern(pattern ?? '', compiled, budget)).toBe(index);
    }
    expect(await findMatchingPattern('plusxsign.sol', compiled, budget)).toBeNull();
    const dotfiles = compilePatternList(['*'], budget.limits);
    expect(await findMatchingPattern('.hidden.sol', dotfiles, budget)).toBe(0);
  });

  it('rejects unsupported grammar and enforces configured list and length ceilings', () => {
    const limits = testLimits({ maxPatternsPerList: 2, maxPatternLength: 8 });
    expect(() => compilePatternList(['!secret'], limits)).toThrow('A path pattern is invalid.');
    expect(() => compilePatternList(['a/**b'], limits)).toThrow('A path pattern is invalid.');
    expect(() => compilePatternList(['abcdefghx'], limits)).toThrow('A path pattern is invalid.');
    expect(() => compilePatternList(['a', 'b', 'c'], limits)).toThrow(
      'A path pattern list exceeds its configured limit.',
    );
    expect(() => compilePatternList(['segment*middle*end.sol'], limits)).toThrow(
      'A path pattern is invalid.',
    );
    expect(() => compilePatternList(['abcdefgh'], limits)).not.toThrow();
  });

  it('charges rolling-DP states once and stops at the shared limit', async () => {
    const budget = createDiscoveryBudget(testLimits({ maxGlobStates: 2 }));
    const compiled = compilePatternList(['a/b'], budget.limits);
    await expect(findMatchingPattern('a/b', compiled, budget)).rejects.toBeInstanceOf(BudgetError);
    expect(budget.counters.globStates).toBe(2);
  });

  it('bounds multiple standalone globstars with rolling dynamic-programming states', async () => {
    const pattern = compilePatternList(['**/**/A.sol'], testLimits());
    const exact = createDiscoveryBudget(testLimits({ maxGlobStates: 9 }));
    expect(await findMatchingPattern('x/y/A.sol', pattern, exact)).toBe(0);
    expect(exact.counters.globStates).toBe(9);

    const over = createDiscoveryBudget(testLimits({ maxGlobStates: 8 }));
    await expect(findMatchingPattern('x/y/A.sol', pattern, over)).rejects.toBeInstanceOf(
      BudgetError,
    );
    expect(over.counters.globStates).toBe(8);
  });

  it('prunes only directories covered by a trailing globstar', async () => {
    const budget = createDiscoveryBudget(testLimits());
    const compiled = compilePatternList(['contracts/A.sol', '**/mocks/**'], budget.limits);
    expect(await findPrunablePattern('contracts', compiled, budget)).toBeNull();
    expect(await findPrunablePattern('contracts/mocks', compiled, budget)).toBe(1);
    expect(await findPrunablePattern('contracts/mocks/deep', compiled, budget)).toBe(1);
  });

  it('rejects noncanonical path segments and distinguishes root from empty paths', async () => {
    const budget = createDiscoveryBudget(testLimits());
    const compiled = compilePatternList(['**'], budget.limits);
    for (const path of [
      '/absolute.sol',
      'contracts\\A.sol',
      'contracts//A.sol',
      'contracts/./A.sol',
      'contracts/../A.sol',
      '',
    ]) {
      expect(await findMatchingPattern(path, compiled, budget)).toBeNull();
      expect(await findPrunablePattern(path, compiled, budget)).toBeNull();
    }
    expect(await findMatchingPattern('.', compiled, budget)).toBe(0);
    expect(await findPrunablePattern('.', compiled, budget)).toBe(0);
    expect(isGlobBudgetError(new BudgetError('limit', 'globStates'))).toBe(true);
    expect(isGlobBudgetError(new BudgetError('limit', 'filesystemEntries'))).toBe(false);
  });

  it('delivers scheduled cancellation during a long segment comparison', async () => {
    const controller = new AbortController();
    const budget = createDiscoveryBudget(testLimits(), controller.signal);
    const path = `${'x/'.repeat(254)}x`;
    const pattern = `${'*/'.repeat(254)}*`;
    const compiled = compilePatternList([pattern], budget.limits);
    const timer = setTimeout(() => controller.abort(), 0);
    try {
      await expect(findMatchingPattern(path, compiled, budget)).rejects.toMatchObject({
        kind: 'cancelled',
      });
    } finally {
      clearTimeout(timer);
    }
    expect(budget.counters.globStates).toBeGreaterThan(0);
  });
});
