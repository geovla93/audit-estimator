import { describe, expect, it } from 'vitest';
import { BudgetError } from '../../src/discovery/budget.ts';
import { edgeIdentity, fileIdentity } from '../../src/domain/canonical.ts';
import type { FileId, SourceRange } from '../../src/domain/types.ts';
import type { SemanticImportLookup } from '../../src/parser/protocol.ts';
import type { ComponentPlan } from '../../src/relationships/components.ts';
import { buildComponentImportLookups } from '../../src/relationships/lookups.ts';
import type { ImportObservation } from '../../src/relationships/types.ts';

const zeroRange: SourceRange = Object.freeze({
  startByte: 0,
  endByte: 0,
  start: Object.freeze({ line: 1, column: 1 }),
  end: Object.freeze({ line: 1, column: 1 }),
});

function fid(path: string): FileId {
  return fileIdentity(path);
}

function plan(members: readonly string[], overrides: Partial<ComponentPlan> = {}): ComponentPlan {
  const id = members[0];
  if (id === undefined) throw new Error('A test component needs a member.');
  return Object.freeze({
    id: fid(id),
    members: Object.freeze(members.map(fid)),
    grammar: '0.8.38',
    status: 'available',
    reason: null,
    totalBytes: 0,
    ...overrides,
  });
}

function observation(
  importer: string,
  target: string | null,
  ordinal = 0,
  overrides: Partial<ImportObservation> = {},
): ImportObservation {
  return Object.freeze({
    importId: edgeIdentity(importer, 'import', ordinal, 0),
    importerFileId: fid(importer),
    specifier: target ?? './missing.sol',
    range: zeroRange,
    specifierRange: zeroRange,
    lookupName: target,
    strategy: 'relative',
    remapping: null,
    conflictingRemappings: Object.freeze([]),
    probes: Object.freeze([]),
    candidateFileIds: Object.freeze(target === null ? [] : [fid(target)]),
    status: target === null ? 'unresolved' : 'resolved',
    targetFileId: target === null ? null : fid(target),
    reason: target === null ? 'not-found' : null,
    ...overrides,
  });
}

function previousLookups(
  component: ComponentPlan,
  observations: readonly ImportObservation[],
): SemanticImportLookup[] {
  const members = new Set(component.members);
  return observations.flatMap((item) =>
    members.has(item.importerFileId) && item.status === 'resolved' && item.targetFileId !== null
      ? [
          {
            importerFileId: item.importerFileId,
            importId: item.importId,
            specifier: item.specifier,
            specifierRange: item.specifierRange,
            targetFileId: item.targetFileId,
          },
        ]
      : [],
  );
}

async function checkpoint(): Promise<void> {}

describe('component import lookups', () => {
  it('checkpoints before and after empty input', async () => {
    let calls = 0;
    const result = await buildComponentImportLookups([], [], async () => {
      calls += 1;
    });
    expect([...result]).toEqual([]);
    expect(calls).toBe(2);
  });

  it('retains an empty lookup list for an available component without imports', async () => {
    const component = plan(['isolated.sol']);
    const result = await buildComponentImportLookups([component], [], checkpoint);
    expect([...result]).toEqual([[component.id, []]]);
  });

  it('matches the previous ordered projection without changing inputs or original ranges', async () => {
    const originalRange: SourceRange = Object.freeze({
      startByte: 39,
      endByte: 61,
      start: Object.freeze({ line: 3, column: 8 }),
      end: Object.freeze({ line: 3, column: 30 }),
    });
    const duplicate = observation('a.sol', 'b.sol', 7, {
      specifier: './escaped\\x2esol',
      specifierRange: originalRange,
    });
    const plans = Object.freeze([
      plan(['a.sol', 'b.sol']),
      plan(['c.sol', 'd.sol']),
      plan(['unavailable.sol'], { status: 'unavailable', reason: 'unresolved-import' }),
      plan(['null-grammar.sol'], { grammar: null }),
      plan(['empty.sol']),
    ]);
    const observations = Object.freeze([
      observation('c.sol', 'd.sol'),
      duplicate,
      observation('a.sol', null, 1),
      observation('unavailable.sol', 'a.sol'),
      observation('null-grammar.sol', 'b.sol'),
      observation('outside.sol', 'a.sol'),
      observation('b.sol', 'a.sol', 2, { status: 'ambiguous' }),
      observation('d.sol', 'c.sol', 3),
      observation('b.sol', null, 4, { status: 'resolved' }),
      observation('a.sol', 'b.sol', 5, { status: 'unresolved' }),
      duplicate,
      observation('b.sol', 'outside.sol', 6),
    ]);
    const before = structuredClone({ plans, observations });
    const result = await buildComponentImportLookups(plans, observations, checkpoint);
    const available = plans.filter((item) => item.status === 'available' && item.grammar !== null);
    expect([...result]).toEqual(
      available.map((component) => [component.id, previousLookups(component, observations)]),
    );
    expect(result.get(fid('a.sol'))).toHaveLength(3);
    expect(result.get(fid('a.sol'))?.[0]?.specifierRange).toBe(originalRange);
    expect(result.get(fid('a.sol'))?.[1]?.specifierRange).toBe(originalRange);
    expect({ plans, observations }).toEqual(before);
  });

  it('reads a fixed observation set a bounded number of times as component count grows', async () => {
    async function readsFor(componentCount: number): Promise<number> {
      let reads = 0;
      const plans = Array.from({ length: componentCount }, (_, index) => plan([`${index}.sol`]));
      const observations = Array.from({ length: 80 }, (_, index): ImportObservation => {
        const item = observation(`${index % 2}.sol`, 'target.sol', index, {
          status: index % 4 < 2 ? 'resolved' : 'unresolved',
        });
        return {
          ...item,
          get importerFileId(): FileId {
            reads += 1;
            return item.importerFileId;
          },
        };
      });
      const result = await buildComponentImportLookups(plans, observations, checkpoint);
      expect(result.size).toBe(componentCount);
      expect(result.get(fid('0.sol'))).toHaveLength(20);
      expect(result.get(fid('1.sol'))).toHaveLength(20);
      expect(reads).toBeGreaterThanOrEqual(observations.length);
      expect(reads).toBeLessThanOrEqual(2 * observations.length);
      return reads;
    }

    expect(await readsFor(128)).toBe(await readsFor(2));
  });

  it.each([
    { name: 'empty input', unavailable: 0, members: 0, observations: 0 },
    { name: 'small input', unavailable: 1, members: 3, observations: 7 },
    { name: 'unavailable plans', unavailable: 800, members: 1, observations: 0 },
    { name: 'members before imports', unavailable: 0, members: 800, observations: 100 },
    { name: 'skipped imports', unavailable: 0, members: 1, observations: 900 },
    { name: 'combined batches', unavailable: 257, members: 260, observations: 520 },
  ])('checkpoints at most 256 visited records apart for $name', async (input) => {
    let records = 0;
    let lastCheckpoint = 0;
    const gaps: number[] = [];
    const plans: ComponentPlan[] = Array.from({ length: input.unavailable }, (_, index) => ({
      ...plan([`unavailable-${index}.sol`], { grammar: null, reason: 'unresolved-import' }),
      get status(): ComponentPlan['status'] {
        records += 1;
        return 'unavailable';
      },
    }));
    if (input.members > 0) {
      const members = Array.from({ length: input.members }, (_, index) => fid(`${index}.sol`));
      for (const [index, member] of members.entries()) {
        Object.defineProperty(members, index, {
          get(): FileId {
            records += 1;
            return member;
          },
        });
      }
      plans.push({
        ...plan(['0.sol']),
        members,
        get status(): ComponentPlan['status'] {
          records += 1;
          return 'available';
        },
      });
    }
    const observations = Array.from(
      { length: input.observations },
      (_, index): ImportObservation => {
        const item = observation('0.sol', null, index);
        return {
          ...item,
          get importerFileId(): FileId {
            records += 1;
            return item.importerFileId;
          },
        };
      },
    );
    const total =
      input.unavailable + (input.members > 0 ? 1 + input.members : 0) + input.observations;
    await buildComponentImportLookups(plans, observations, async () => {
      gaps.push(records - lastCheckpoint);
      lastCheckpoint = records;
    });
    expect(records).toBe(total);
    expect(gaps[0]).toBe(0);
    expect(lastCheckpoint).toBe(total);
    expect(gaps).toHaveLength(2 + Math.floor(total / 256));
    expect(gaps.every((gap) => gap <= 256)).toBe(true);
  });

  it.each(['cancelled', 'deadline', 'limit'] as const)(
    'propagates the exact %s budget error before, during and after indexing',
    async (kind) => {
      for (const failAt of [1, 2, 4]) {
        const sentinel = new BudgetError(kind);
        let calls = 0;
        let published: ReadonlyMap<FileId, readonly SemanticImportLookup[]> | undefined;
        const result = buildComponentImportLookups(
          [plan(['a.sol'])],
          Array.from({ length: 600 }, (_, index) => observation('a.sol', 'b.sol', index)),
          async () => {
            calls += 1;
            if (calls === failAt) throw sentinel;
          },
        ).then((value) => {
          published = value;
          return value;
        });
        await expect(result).rejects.toBe(sentinel);
        expect(calls).toBe(failAt);
        expect(published).toBeUndefined();
      }
    },
  );
});
