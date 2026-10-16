import { createHash } from 'node:crypto';
import { link, mkdir, open as openFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { createDiscoveryBudget, BudgetError } from '../../src/discovery/budget.ts';
import { discoverScope } from '../../src/discovery/discover.ts';
import { IdentityRegistry } from '../../src/discovery/identity.ts';
import { readProjectMetadata } from '../../src/discovery/metadata.ts';
import {
  readCoverageFile,
  readMetadataFile,
  readSource,
  type SafeReadAdapter,
} from '../../src/discovery/safe-read.ts';
import {
  classifyOwnership,
  classifyOwnershipBounded,
  diagnostic,
  emptyScopeManifest,
  isUnderSelectedRoot,
  reevaluateIdentityOwnership,
  selectSourceRoots,
  type DiscoveryDirectoryEntry,
} from '../../src/discovery/scope.ts';
import { isPathInside, resolveSafePath, SafePathError } from '../../src/discovery/safe-path.ts';
import type { SourceSnapshot } from '../../src/domain/types.ts';
import { fileIdentity } from '../../src/domain/canonical.ts';
import { makeDiscoveryInput } from '../helpers/discovery-input.ts';
import {
  absoluteProjectPath,
  createProject,
  removeProject,
  safePathContext,
  testLimits,
  writeProjectFile,
} from '../helpers/filesystem.ts';

function captureSyncError(callback: () => void): unknown {
  try {
    callback();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

describe('shared discovery budgets and physical identities', () => {
  it('tracks exact allowances, cancellation, deadline, tightening and identity reservations', async () => {
    const limits = testLimits({
      maxFsEntries: 1,
      maxGlobStates: 1,
      maxFiles: 1,
      maxFileBytes: 8,
      maxTotalSourceBytes: 8,
    });
    const budget = createDiscoveryBudget(limits);
    expect(Object.isFrozen(budget.limits)).toBe(true);
    budget.chargeFilesystemEntry();
    budget.chargeGlobState();
    budget.chargeSourceBytes(4);
    budget.chargeMetadataBytes(2);
    budget.chargeLcovBytes(3);
    expect(budget.sourceByteAllowance(4)).toBe(4);
    expect(budget.metadataByteAllowance()).toBe(limits.maxMetadataBytes - 2);
    expect(budget.lcovByteAllowance()).toBe(limits.maxLcovBytes - 3);
    expect(budget.reserveSourceIdentity('one')).toBe(true);
    expect(budget.reserveSourceIdentity('one')).toBe(false);
    budget.releaseSourceIdentity('one');
    expect(budget.reserveSourceIdentity('one')).toBe(true);
    budget.commitSourceIdentity('one');
    budget.commitSourceIdentity('never-reserved');
    budget.releaseSourceIdentity('one');
    expect(budget.counters).toMatchObject({
      filesystemEntries: 1,
      globStates: 1,
      sourceBytes: 4,
      metadataBytes: 2,
      lcovBytes: 3,
      sourceFiles: 1,
    });
    expect(budget.hasSourceIdentity('never-reserved')).toBe(false);
    await budget.checkpoint(true);
    expect(() => budget.assertLimitsMatch({ ...limits, maxFiles: 2 })).toThrow(TypeError);
    expect(() => budget.tightenLimits({ ...limits, maxFiles: 2 })).toThrow(TypeError);
    expect(() => budget.tightenLimits({ ...limits, maxFileBytes: 3 })).toThrow(BudgetError);
    budget.tightenLimits({ ...limits, maxFsEntries: 1 });
    expect(() => budget.tightenDeadline(Number.POSITIVE_INFINITY)).toThrow(TypeError);

    const exhausted = createDiscoveryBudget(
      testLimits({ maxFsEntries: 1, maxGlobStates: 1, maxFiles: 1 }),
    );
    exhausted.chargeFilesystemEntry();
    expect(captureSyncError(() => exhausted.chargeFilesystemEntry())).toMatchObject({
      kind: 'limit',
      budget: 'filesystemEntries',
    });
    exhausted.chargeGlobState();
    expect(captureSyncError(() => exhausted.chargeGlobState())).toMatchObject({
      kind: 'limit',
      budget: 'globStates',
    });
    exhausted.reserveSourceIdentity('one');
    expect(captureSyncError(() => exhausted.reserveSourceIdentity('two'))).toMatchObject({
      kind: 'limit',
    });

    const controller = new AbortController();
    controller.abort();
    expect(
      captureSyncError(() => createDiscoveryBudget(testLimits(), controller.signal).check()),
    ).toMatchObject({ kind: 'cancelled' });
    expect(
      captureSyncError(() => createDiscoveryBudget(testLimits(), undefined, 0).check()),
    ).toMatchObject({ kind: 'deadline' });
  });

  it('freezes the first representative snapshot across hardlink aliases and detects changed versions', async () => {
    const root = await createProject();
    try {
      const first = await writeProjectFile(root, 'contracts/A.sol', 'contract Same {}\n');
      const second = absoluteProjectPath(root, 'contracts/Z.sol');
      await link(first, second);
      const aliases = ['contracts/é.sol', 'contracts/😀.sol', 'contracts/😀a.sol'];
      for (const alias of aliases) await link(first, absoluteProjectPath(root, alias));
      const context = await safePathContext(root);
      const firstPath = await resolveSafePath(context, first);
      const secondPath = await resolveSafePath(context, second);
      const identities = new IdentityRegistry();
      identities.observe(secondPath);
      for (const alias of aliases) {
        identities.observe(await resolveSafePath(context, absoluteProjectPath(root, alias)));
      }
      identities.observe(firstPath);
      const record = identities.get(firstPath.identityKey);
      expect(record?.representativePath).toBe('contracts/A.sol');
      expect(record?.physicalPaths).toEqual([
        'contracts/A.sol',
        'contracts/Z.sol',
        'contracts/é.sol',
        'contracts/😀.sol',
        'contracts/😀a.sol',
      ]);
      expect(identities.identityForPhysicalPath('contracts/Z.sol')).toBe(firstPath.identityKey);
      const bytes = Buffer.from('contract Same {}\n');
      const snapshot: SourceSnapshot = {
        canonicalPath: 'contracts/A.sol',
        absolutePath: first,
        originalBytes: bytes,
        originalText: bytes.toString('utf8'),
        byteHash: createHash('sha256').update(bytes).digest('hex'),
      };
      identities.setSnapshot(firstPath.identityKey, snapshot, firstPath.stats);
      identities.setSnapshot(
        firstPath.identityKey,
        { ...snapshot, canonicalPath: 'contracts/Z.sol' },
        firstPath.stats,
      );
      identities.freeze(firstPath.identityKey);
      expect(identities.snapshotForIdentity(firstPath.identityKey)).toBe(snapshot);
      expect(identities.matchesSnapshotVersion(firstPath.identityKey, firstPath.stats)).toBe(true);
      const lateAlias = absoluteProjectPath(root, 'contracts/0.sol');
      await link(first, lateAlias);
      const latePath = await resolveSafePath(context, lateAlias);
      identities.observe(latePath);
      expect(identities.get(firstPath.identityKey)?.representativePath).toBe('contracts/A.sol');
      expect(identities.get(firstPath.identityKey)?.physicalPaths).toEqual([
        'contracts/0.sol',
        'contracts/A.sol',
        'contracts/Z.sol',
        'contracts/é.sol',
        'contracts/😀.sol',
        'contracts/😀a.sol',
      ]);
      expect(identities.identities().map((item) => item.representativePath)).toEqual([
        'contracts/A.sol',
      ]);
      await writeFile(first, 'contract Changed { uint x; }\n');
      const changed = await resolveSafePath(context, first);
      expect(identities.matchesSnapshotVersion(firstPath.identityKey, changed.stats)).toBe(false);
      expect(identities.freeze('missing')).toBeUndefined();
      expect(identities.get('missing')).toBeUndefined();
    } finally {
      await removeProject(root);
    }
  });
});

describe('safe project paths and bounded reads', () => {
  it.skipIf(process.platform === 'win32')(
    'enforces physical boundaries, symlink policy, hard exclusions and special paths',
    async () => {
      const root = await createProject();
      const outside = await createProject();
      try {
        const file = await writeProjectFile(root, 'contracts/A.sol', 'contract A {}\n');
        const outsideFile = await writeProjectFile(outside, 'Outside.sol', 'contract Outside {}\n');
        const context = await safePathContext(root);
        expect((await resolveSafePath(context, file)).physicalRelativePath).toBe('contracts/A.sol');
        expect(isPathInside(root, file)).toBe(true);
        expect(isPathInside(root, `${root}-sibling/A.sol`)).toBe(false);
        await expect(resolveSafePath(context, `${root}-sibling/A.sol`)).rejects.toMatchObject({
          reason: 'outside-root',
        });
        await expect(
          resolveSafePath(context, join(root, '.git', 'missing.sol')),
        ).rejects.toMatchObject({ reason: 'missing' });
        await expect(resolveSafePath(context, join(root, 'missing.sol'))).rejects.toBeInstanceOf(
          SafePathError,
        );
        await symlink(outsideFile, absoluteProjectPath(root, 'contracts/Outside.sol'));
        await expect(
          resolveSafePath(context, absoluteProjectPath(root, 'contracts/Outside.sol')),
        ).rejects.toMatchObject({ reason: 'symlink' });
        const following = await safePathContext(root, { followSymlinks: true });
        await expect(
          resolveSafePath(following, absoluteProjectPath(root, 'contracts/Outside.sol')),
        ).rejects.toMatchObject({ reason: 'outside-root' });
        const targetContext = await safePathContext(root, {
          target: absoluteProjectPath(root, 'contracts'),
        });
        await expect(resolveSafePath(targetContext, outsideFile)).rejects.toMatchObject({
          reason: 'outside-root',
        });
        await writeProjectFile(root, '.git/Hidden.sol', 'contract Hidden {}\n');
        await expect(
          resolveSafePath(
            await safePathContext(root, { followSymlinks: true }),
            join(root, '.git/Hidden.sol'),
          ),
        ).rejects.toMatchObject({ reason: 'hard-excluded' });
        const specialPath = absoluteProjectPath(root, 'contracts/special.sol');
        await symlink(join(root, 'contracts'), specialPath);
        const special = await resolveSafePath(
          await safePathContext(root, { followSymlinks: true }),
          specialPath,
        );
        expect(special.kind).toBe('directory');
        await symlink(
          absoluteProjectPath(root, 'contracts/loop.sol'),
          absoluteProjectPath(root, 'contracts/loop.sol'),
        );
        await expect(
          resolveSafePath(
            await safePathContext(root, { followSymlinks: true }),
            absoluteProjectPath(root, 'contracts/loop.sol'),
          ),
        ).rejects.toMatchObject({ reason: 'unreadable' });
        await symlink(
          absoluteProjectPath(root, 'other/InsideProject.sol'),
          absoluteProjectPath(root, 'contracts/OutsideTarget.sol'),
        );
        await writeProjectFile(root, 'other/InsideProject.sol', 'contract InsideProject {}\n');
        const targetBound = await safePathContext(root, {
          target: absoluteProjectPath(root, 'contracts'),
          followSymlinks: true,
        });
        await expect(
          resolveSafePath(targetBound, absoluteProjectPath(root, 'contracts/OutsideTarget.sol')),
        ).rejects.toMatchObject({ reason: 'outside-target' });
        const allowedLink = await resolveSafePath(
          await safePathContext(root, { followSymlinks: true }),
          absoluteProjectPath(root, 'contracts/OutsideTarget.sol'),
        );
        expect(allowedLink.followedSymlink).toBe(true);
        await expect(
          resolveSafePath(
            await safePathContext(root, { followSymlinks: true }),
            absoluteProjectPath(root, 'contracts/OutsideTarget.sol'),
            { rejectSymlinks: true },
          ),
        ).rejects.toMatchObject({ reason: 'symlink' });
        const unrepresentable = await writeFile(
          join(root, 'contracts', 'backslash\\name.sol'),
          'contract BadName {}\n',
        ).then(() => join(root, 'contracts', 'backslash\\name.sol'));
        await expect(resolveSafePath(context, unrepresentable)).rejects.toMatchObject({
          reason: 'invalid-name',
        });
      } finally {
        await removeProject(root);
        await removeProject(outside);
      }
    },
  );

  it('reads source, metadata and coverage with separate counters and cached snapshots', async () => {
    const root = await createProject();
    try {
      const sourcePath = await writeProjectFile(root, 'contracts/A.sol', '\uFEFFcontract A {}\r\n');
      const metadataPath = await writeProjectFile(
        root,
        'foundry.toml',
        '[profile.default]\nsrc = "contracts"\n',
      );
      const coveragePath = await writeProjectFile(
        root,
        'coverage/lcov.info',
        'SF:contracts/A.sol\nDA:1,1\n',
      );
      const limits = testLimits({
        maxFileBytes: 64,
        maxTotalSourceBytes: 64,
        maxMetadataBytes: 128,
        maxLcovBytes: 128,
      });
      const budget = createDiscoveryBudget(limits);
      const pathContext = await safePathContext(root, { target: join(root, 'contracts') });
      const identities = new IdentityRegistry();
      const context = { pathContext, budget, identities };
      const source = await readSource(context, sourcePath);
      expect(source.originalText).toBe('\uFEFFcontract A {}\r\n');
      expect(source.byteHash).toBe(createHash('sha256').update(source.originalBytes).digest('hex'));
      expect(await readSource(context, sourcePath)).toBe(source);
      expect(budget.counters.sourceFiles).toBe(1);
      expect(
        new TextDecoder().decode(
          await readMetadataFile(
            {
              pathContext: { ...pathContext, target: undefined, lexicalTarget: undefined },
              budget,
            },
            metadataPath,
          ),
        ),
      ).toContain('profile.default');
      expect(
        new TextDecoder().decode(await readCoverageFile({ pathContext, budget }, coveragePath)),
      ).toContain('DA:1,1');
      expect(budget.counters.metadataBytes).toBeGreaterThan(0);
      expect(budget.counters.lcovBytes).toBeGreaterThan(0);
      expect(budget.counters.sourceBytes).toBe(source.originalBytes.byteLength);
    } finally {
      await removeProject(root);
    }
  });

  it('reports invalid UTF-8 and independent source, metadata, and LCOV byte ceilings', async () => {
    const root = await createProject();
    try {
      const invalid = await writeProjectFile(
        root,
        'contracts/Invalid.sol',
        Buffer.from([0xc3, 0x28]),
      );
      const source = await writeProjectFile(root, 'contracts/Large.sol', 'contract Large {}\n');
      const metadata = await writeProjectFile(
        root,
        'foundry.toml',
        '[profile.default]\nsrc = "contracts"\n',
      );
      const coverage = await writeProjectFile(root, 'coverage/lcov.info', 'SF:x\nDA:1,1\n');
      const pathContext = await safePathContext(root);
      const invalidBudget = createDiscoveryBudget(testLimits());
      await expect(
        readSource(
          { pathContext, budget: invalidBudget, identities: new IdentityRegistry() },
          invalid,
        ),
      ).rejects.toMatchObject({ reason: 'invalid-utf8' });
      expect(invalidBudget.counters.failedSourceReads).toBe(1);
      expect(invalidBudget.counters.sourceFiles).toBe(0);
      const sourceBudget = createDiscoveryBudget(
        testLimits({ maxFileBytes: 4, maxTotalSourceBytes: 64 }),
      );
      await expect(
        readSource(
          { pathContext, budget: sourceBudget, identities: new IdentityRegistry() },
          source,
        ),
      ).rejects.toMatchObject({ kind: 'limit', budget: 'sourceBytes' });
      const metadataBudget = createDiscoveryBudget(testLimits({ maxMetadataBytes: 4 }));
      await expect(
        readMetadataFile({ pathContext, budget: metadataBudget }, metadata),
      ).rejects.toMatchObject({ kind: 'limit', budget: 'metadataBytes' });
      const lcovBudget = createDiscoveryBudget(testLimits({ maxLcovBytes: 4 }));
      await expect(
        readCoverageFile({ pathContext, budget: lcovBudget }, coverage),
      ).rejects.toMatchObject({ kind: 'limit', budget: 'lcovBytes' });
    } finally {
      await removeProject(root);
    }
  });

  it('rejects changed descriptors, short reads, failed closes, and externally reserved identities', async () => {
    const root = await createProject();
    try {
      const sourcePath = await writeProjectFile(
        root,
        'contracts/Changing.sol',
        'contract Before {}\n',
      );
      const pathContext = await safePathContext(root);
      const changedIdentities = new IdentityRegistry();
      const changedBudget = createDiscoveryBudget(testLimits());
      const mutationAdapter: SafeReadAdapter = {
        open: async (path, flags) => {
          await writeFile(path, 'contract After { uint256 value; }\n');
          return await openFile(path, flags);
        },
        resolve: resolveSafePath,
      };
      await expect(
        readSource(
          {
            pathContext,
            budget: changedBudget,
            identities: changedIdentities,
            adapter: mutationAdapter,
          },
          sourcePath,
        ),
      ).rejects.toMatchObject({ code: 'SOURCE_CHANGED', reason: 'changed' });
      expect(changedBudget.counters.failedSourceReads).toBe(1);
      expect(changedBudget.counters.sourceFiles).toBe(0);

      await writeFile(sourcePath, 'contract Stable {}\n');
      const shortBudget = createDiscoveryBudget(testLimits());
      const shortRead: SafeReadAdapter = {
        open: async (path, flags) => {
          const handle = await openFile(path, flags);
          return {
            stat: async (options) => await handle.stat(options),
            read: async (buffer) => ({ bytesRead: 0, buffer }),
            close: async () => await handle.close(),
          };
        },
        resolve: resolveSafePath,
      };
      await expect(
        readSource(
          {
            pathContext,
            budget: shortBudget,
            identities: new IdentityRegistry(),
            adapter: shortRead,
          },
          sourcePath,
        ),
      ).rejects.toMatchObject({ code: 'SOURCE_CHANGED', reason: 'changed' });
      expect(shortBudget.counters.failedSourceReads).toBe(1);

      const closeBudget = createDiscoveryBudget(testLimits());
      let closeAttempted = false;
      const failedClose: SafeReadAdapter = {
        open: async (path, flags) => {
          const handle = await openFile(path, flags);
          return {
            stat: async (options) => await handle.stat(options),
            read: async (buffer, offset, length, position) =>
              await handle.read(buffer, offset, length, position),
            close: async () => {
              closeAttempted = true;
              await handle.close();
              throw new Error('controlled close failure');
            },
          };
        },
        resolve: resolveSafePath,
      };
      await expect(
        readSource(
          {
            pathContext,
            budget: closeBudget,
            identities: new IdentityRegistry(),
            adapter: failedClose,
          },
          sourcePath,
        ),
      ).rejects.toMatchObject({ code: 'TARGET_UNREADABLE', reason: 'read-failed' });
      expect(closeAttempted).toBe(true);

      const readAndCloseBudget = createDiscoveryBudget(testLimits());
      let failedReadCloseAttempted = false;
      const readAndCloseFailure: SafeReadAdapter = {
        open: async (path, flags) => {
          const handle = await openFile(path, flags);
          return {
            stat: async (options) => await handle.stat(options),
            read: async () => {
              throw new Error('controlled descriptor read failure');
            },
            close: async () => {
              failedReadCloseAttempted = true;
              await handle.close();
              throw new Error('secondary descriptor close failure');
            },
          };
        },
        resolve: resolveSafePath,
      };
      await expect(
        readSource(
          {
            pathContext,
            budget: readAndCloseBudget,
            identities: new IdentityRegistry(),
            adapter: readAndCloseFailure,
          },
          sourcePath,
        ),
      ).rejects.toMatchObject({ code: 'TARGET_UNREADABLE', reason: 'read-failed' });
      expect(failedReadCloseAttempted).toBe(true);

      const beforeGrowth = 'contract Bounded {}\n';
      await writeFile(sourcePath, beforeGrowth);
      const growthBudget = createDiscoveryBudget(
        testLimits({ maxFileBytes: Buffer.byteLength(beforeGrowth, 'utf8') }),
      );
      const growthAdapter: SafeReadAdapter = {
        open: async (path, flags) => {
          const handle = await openFile(path, flags);
          let changed = false;
          return {
            stat: async (options) => await handle.stat(options),
            read: async (buffer, offset, length, position) => {
              if (!changed) {
                changed = true;
                await writeFile(path, `${beforeGrowth}extra`);
              }
              return await handle.read(buffer, offset, length, position);
            },
            close: async () => await handle.close(),
          };
        },
        resolve: resolveSafePath,
      };
      await expect(
        readSource(
          {
            pathContext,
            budget: growthBudget,
            identities: new IdentityRegistry(),
            adapter: growthAdapter,
          },
          sourcePath,
        ),
      ).rejects.toMatchObject({ kind: 'limit', budget: 'sourceBytes' });
      expect(growthBudget.counters.sourceBytes).toBe(Buffer.byteLength(beforeGrowth, 'utf8') + 1);

      const reservedPath = await resolveSafePath(pathContext, sourcePath);
      const reservedBudget = createDiscoveryBudget(testLimits());
      expect(reservedBudget.reserveSourceIdentity(reservedPath.identityKey)).toBe(true);
      const reservedIdentities = new IdentityRegistry();
      reservedIdentities.observe(reservedPath);
      await expect(
        readSource(
          { pathContext, budget: reservedBudget, identities: reservedIdentities },
          sourcePath,
        ),
      ).rejects.toMatchObject({ code: 'SOURCE_CHANGED', reason: 'changed' });
      expect(reservedBudget.hasSourceIdentity(reservedPath.identityKey)).toBe(true);
      expect(reservedBudget.counters.failedSourceReads).toBe(1);

      const cachedIdentities = new IdentityRegistry();
      const cachedBudget = createDiscoveryBudget(testLimits());
      const first = await readSource(
        { pathContext, budget: cachedBudget, identities: cachedIdentities },
        sourcePath,
      );
      await writeFile(sourcePath, 'contract Mutated { uint value; }\n');
      await expect(
        readSource({ pathContext, budget: cachedBudget, identities: cachedIdentities }, sourcePath),
      ).rejects.toMatchObject({ code: 'SOURCE_CHANGED', reason: 'changed' });
      expect(first.canonicalPath).toBe('contracts/Changing.sol');
    } finally {
      await removeProject(root);
    }
  });
});

describe('metadata, ownership, roots and scope discovery', () => {
  it('reads Foundry hints safely and records invalid or Hardhat-only metadata states', async () => {
    const root = await createProject();
    try {
      await mkdir(join(root, 'contracts'), { recursive: true });
      await mkdir(join(root, 'lib'), { recursive: true });
      await writeProjectFile(
        root,
        'foundry.toml',
        [
          '[profile.default]',
          'src = "contracts"',
          'test = "test"',
          'libs = ["lib"]',
          'remappings = ["@lib/=lib/", "contracts/:@ctx/=contracts/"]',
          'solc = "0.8.28"',
          '[profile.ci]',
          'src = "ignored"',
          '',
        ].join('\n'),
      );
      await writeProjectFile(root, 'hardhat.config.ts', 'export default {};\n');
      const pathContext = await safePathContext(root);
      const metadata = await readProjectMetadata({
        pathContext,
        budget: createDiscoveryBudget(testLimits()),
      });
      expect(metadata.valid).toBe(true);
      expect(metadata.observation.status).toBe('read');
      expect(metadata.hints.scope?.sourceRoots).toEqual(['contracts']);
      expect(metadata.hints.imports?.remappings).toEqual([
        { prefix: '@lib/', target: 'lib' },
        { context: 'contracts', prefix: '@ctx/', target: 'contracts' },
      ]);
      expect(metadata.hints.solidity?.version).toBe('0.8.28');
      expect(metadata.diagnostics.some((item) => item.message.includes('Hardhat'))).toBe(true);

      await writeFile(join(root, 'foundry.toml'), '[profile.default]\nsrc = "../outside"\n');
      const invalid = await readProjectMetadata({
        pathContext,
        budget: createDiscoveryBudget(testLimits()),
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.observation.status).toBe('blocked');
      await rm(join(root, 'foundry.toml'));
      const absent = await readProjectMetadata({
        pathContext,
        budget: createDiscoveryBudget(testLimits()),
      });
      expect(absent.observation.status).toBe('absent');
      expect(absent.valid).toBe(true);
    } finally {
      await removeProject(root);
    }
  });

  it('classifies ownership conflicts, rechecks cached identities, and selects configured roots', async () => {
    const root = await createProject();
    try {
      const sourcePath = await writeProjectFile(root, 'contracts/A.sol', 'contract A {}\n');
      const input = await makeDiscoveryInput(root);
      const metadataPaths = { libs: ['vendor'], test: null, script: null, out: null };
      const scope = {
        ...input.config.scope,
        thirdPartyRoots: ['vendor'],
        firstPartyOverrides: ['vendor/local'],
      };
      expect(classifyOwnership([], scope, metadataPaths)).toMatchObject({
        ownership: 'unknown',
        conflicted: false,
      });
      expect(await classifyOwnershipBounded([], scope, metadataPaths, input.budget)).toMatchObject({
        ownership: 'unknown',
        rule: 'no-observed-path',
        conflicted: false,
      });
      expect(
        classifyOwnership(['src/Main.sol', 'vendor/pkg/A.sol'], scope, metadataPaths),
      ).toMatchObject({ ownership: 'unknown', conflicted: true });
      expect(classifyOwnership(['vendor/local/A.sol'], scope, metadataPaths)).toMatchObject({
        ownership: 'first-party',
        rule: 'first-party-override:vendor/local',
      });
      expect(
        await classifyOwnershipBounded(
          ['lib/A.sol', 'lib/A.sol'],
          scope,
          metadataPaths,
          input.budget,
        ),
      ).toMatchObject({ ownership: 'third-party', conflicted: false });

      const path = await resolveSafePath(await safePathContext(root), sourcePath);
      input.identities.observe(path);
      input.identities.freeze(path.identityKey);
      const bytes = Buffer.from('contract A {}\n');
      input.identities.setSnapshot(
        path.identityKey,
        {
          canonicalPath: path.physicalRelativePath,
          absolutePath: path.physicalPath,
          originalBytes: bytes,
          originalText: bytes.toString('utf8'),
          byteHash: createHash('sha256').update(bytes).digest('hex'),
        },
        path.stats,
      );
      const reevaluated = await reevaluateIdentityOwnership({
        identities: input.identities,
        identityKey: path.identityKey,
        scope: { ...scope, thirdPartyRoots: ['contracts'] },
        metadataPaths,
        scopedFileIds: [fileIdentity('contracts/A.sol')],
        budget: input.budget,
      });
      expect(reevaluated).toMatchObject({
        ownership: 'third-party',
        complete: false,
        invalidatedScopedFileIds: [expect.any(String)],
      });
      expect(
        await reevaluateIdentityOwnership({
          identities: input.identities,
          identityKey: 'absent',
          scope,
          metadataPaths,
          scopedFileIds: [],
          budget: input.budget,
        }),
      ).toBeNull();

      await writeProjectFile(
        root,
        'audit-estimator.config.json',
        JSON.stringify({ configVersion: '1.0.0', scope: { sourceRoots: ['contracts'] } }),
      );
      const configured = await makeDiscoveryInput(root);
      expect(
        await selectSourceRoots({
          pathContext: await safePathContext(root),
          target: configured.target,
          scope: configured.config.scope,
          config: configured.config,
          budget: configured.budget,
        }),
      ).toMatchObject({
        mode: 'configured-roots',
        candidateBasePaths: ['contracts'],
        configuredRootSource: 'config',
      });
      expect(isUnderSelectedRoot('contracts/A.sol', ['contracts'])).toBe(true);
      expect(isUnderSelectedRoot('contracts-old/A.sol', ['contracts'])).toBe(false);
      const rootConfigured = await selectSourceRoots({
        pathContext: await safePathContext(root),
        target: configured.target,
        scope: { ...configured.config.scope, sourceRoots: ['.'], include: [] },
        config: configured.config,
        budget: configured.budget,
      });
      expect(rootConfigured.candidateBasePaths).toEqual(['.']);

      const unsnapshotted = new IdentityRegistry();
      unsnapshotted.observe(path);
      const unmaterialized = await reevaluateIdentityOwnership({
        identities: unsnapshotted,
        identityKey: path.identityKey,
        scope,
        metadataPaths,
        scopedFileIds: [fileIdentity('contracts/A.sol')],
        budget: input.budget,
      });
      expect(unmaterialized).toMatchObject({
        ownership: 'first-party',
        invalidatedScopedFileIds: [],
        complete: true,
      });
      expect(emptyScopeManifest()).toEqual({
        entries: [],
        scopedFileIds: [],
        contextFileIds: [],
        excludedFileIds: [],
      });
      expect(
        diagnostic('PARTIAL_ANALYSIS', 'info', 'bounded', [
          { key: 'path', value: 'contracts/A.sol' },
        ]),
      ).toMatchObject({ phase: 'discovery', details: [{ key: 'path', value: 'contracts/A.sol' }] });
      expect(diagnostic('EMPTY_SCOPE', 'warning', 'none')).not.toHaveProperty('details');
    } finally {
      await removeProject(root);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'resolves literal, include, configured, conventional, mismatched and fallback roots',
    async () => {
      const root = await createProject();
      try {
        await mkdir(join(root, 'src', 'nested'), { recursive: true });
        await mkdir(join(root, 'contracts'), { recursive: true });
        await mkdir(join(root, 'other'), { recursive: true });
        await writeProjectFile(root, 'src/Main.sol', 'contract Main {}\n');
        await writeProjectFile(root, 'contracts/NotDir', 'file\n');
        const input = await makeDiscoveryInput(root, 'src');
        const pathContext = await safePathContext(root);
        const noExplicitRoots = { ...input.config.scope, sourceRoots: [], include: [] };

        const conventional = await selectSourceRoots({
          pathContext,
          target: input.target,
          scope: noExplicitRoots,
          config: input.config,
          budget: input.budget,
        });
        expect(conventional).toMatchObject({
          mode: 'conventional-roots',
          candidateBasePaths: ['src'],
          targetMismatch: false,
        });

        const include = await selectSourceRoots({
          pathContext,
          target: input.target,
          scope: { ...noExplicitRoots, include: ['**/*.sol'] },
          config: input.config,
          budget: input.budget,
        });
        expect(include).toMatchObject({ mode: 'include', candidateBasePaths: ['src'] });

        const configured = await selectSourceRoots({
          pathContext,
          target: input.target,
          scope: {
            ...input.config.scope,
            sourceRoots: ['missing', 'contracts/NotDir', '../outside', 'src/nested'],
            include: [],
          },
          config: input.config,
          budget: input.budget,
        });
        expect(configured).toMatchObject({
          mode: 'configured-roots',
          candidateBasePaths: ['src/nested'],
          targetMismatch: false,
        });
        expect(configured.issues.map((issue) => issue.reason)).toEqual([
          'missing',
          'not-directory',
          'outside-root',
        ]);

        const noUsableConfiguredRoot = await selectSourceRoots({
          pathContext,
          target: input.target,
          scope: { ...input.config.scope, sourceRoots: ['missing'], include: [] },
          config: input.config,
          budget: input.budget,
        });
        expect(noUsableConfiguredRoot).toMatchObject({
          mode: 'configured-roots',
          candidateBasePaths: [],
          targetMismatch: false,
        });

        const ancestorRoot = await selectSourceRoots({
          pathContext,
          target: input.target,
          scope: { ...input.config.scope, sourceRoots: ['.'], include: [] },
          config: input.config,
          budget: input.budget,
        });
        expect(ancestorRoot).toMatchObject({
          mode: 'configured-roots',
          candidateBasePaths: ['src'],
          targetMismatch: false,
        });

        const mismatchInput = await makeDiscoveryInput(root, 'other');
        const mismatch = await selectSourceRoots({
          pathContext,
          target: mismatchInput.target,
          scope: noExplicitRoots,
          config: mismatchInput.config,
          budget: mismatchInput.budget,
        });
        expect(mismatch).toMatchObject({
          mode: 'conventional-roots',
          candidateBasePaths: [],
          targetMismatch: true,
        });

        const fileInput = await makeDiscoveryInput(root, 'src/Main.sol');
        const literal = await selectSourceRoots({
          pathContext,
          target: fileInput.target,
          scope: noExplicitRoots,
          config: fileInput.config,
          budget: fileInput.budget,
        });
        expect(literal).toMatchObject({
          mode: 'literal-file',
          candidateBasePaths: ['src/Main.sol'],
        });
      } finally {
        await removeProject(root);
      }

      const fallbackRoot = await createProject();
      try {
        await mkdir(join(fallbackRoot, 'other'));
        const fallbackInput = await makeDiscoveryInput(fallbackRoot, 'other');
        const fallback = await selectSourceRoots({
          pathContext: await safePathContext(fallbackRoot),
          target: fallbackInput.target,
          scope: { ...fallbackInput.config.scope, sourceRoots: [], include: [] },
          config: fallbackInput.config,
          budget: fallbackInput.budget,
        });
        expect(fallback).toMatchObject({
          mode: 'target',
          candidateBasePaths: ['other'],
          targetMismatch: false,
        });
      } finally {
        await removeProject(fallbackRoot);
      }

      const blockedConventionalRoot = await createProject();
      const outside = await createProject();
      try {
        await mkdir(join(blockedConventionalRoot, 'other'));
        await symlink(outside, join(blockedConventionalRoot, 'src'));
        const blockedInput = await makeDiscoveryInput(blockedConventionalRoot, 'other');
        const decision = await selectSourceRoots({
          pathContext: await safePathContext(blockedConventionalRoot),
          target: blockedInput.target,
          scope: { ...blockedInput.config.scope, sourceRoots: [], include: [] },
          config: blockedInput.config,
          budget: blockedInput.budget,
        });
        expect(decision).toMatchObject({
          mode: 'conventional-roots',
          candidateBasePaths: [],
          targetMismatch: false,
        });
        expect(decision.issues).toContainEqual(
          expect.objectContaining({ path: 'src', reason: 'symlink' }),
        );
      } finally {
        await Promise.all([removeProject(blockedConventionalRoot), removeProject(outside)]);
      }
    },
  );

  it('contains malformed and unusual Foundry metadata while retaining safe hints', async () => {
    const root = await createProject();
    try {
      const pathContext = await safePathContext(root);
      const budget = () => createDiscoveryBudget(testLimits());
      await writeProjectFile(
        root,
        'foundry.toml',
        '\uFEFFextends = "base"\n[profile.default]\nsrc = "src"\ntest = "."\nsolc = "0.8.28"\nsolc_version = "0.8.29"\n[profile.ci]\nsrc = "ignored"\n',
      );
      const conflicting = await readProjectMetadata({ pathContext, budget: budget() });
      expect(conflicting.valid).toBe(true);
      expect(conflicting.hints.scope?.sourceRoots).toEqual(['src']);
      expect(conflicting.paths.test).toBeNull();
      expect(conflicting.diagnostics.map((item) => item.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Conflicting Foundry compiler keys'),
          expect.stringContaining('Root-wide Foundry exclusion paths'),
          expect.stringContaining('Nondefault Foundry profiles'),
          expect.stringContaining('Foundry configuration inheritance'),
        ]),
      );

      await writeFile(join(root, 'foundry.toml'), '[profile.default\nsrc = "src"');
      expect(await readProjectMetadata({ pathContext, budget: budget() })).toMatchObject({
        valid: false,
        observation: { status: 'invalid', reason: 'invalid-metadata' },
      });

      await writeFile(join(root, 'foundry.toml'), 'profile = []\n');
      expect(await readProjectMetadata({ pathContext, budget: budget() })).toMatchObject({
        valid: false,
        observation: { status: 'invalid', reason: 'invalid-profile' },
      });

      await writeFile(
        join(root, 'foundry.toml'),
        '[profile.default]\nremappings = ["not-a-mapping"]',
      );
      expect(await readProjectMetadata({ pathContext, budget: budget() })).toMatchObject({
        valid: false,
        observation: { status: 'invalid', reason: 'invalid-metadata' },
      });

      await writeFile(join(root, 'foundry.toml'), '[profile.default]\nsrc = "../outside"');
      expect(await readProjectMetadata({ pathContext, budget: budget() })).toMatchObject({
        valid: false,
        observation: { status: 'blocked', reason: 'outside-root' },
      });

      await writeFile(
        join(root, 'foundry.toml'),
        '[profile.default]\nsolc = "^0.8.20"\n[profile.ci]\nsrc = "ignored"\n',
      );
      const defaultsOnly = await readProjectMetadata({ pathContext, budget: budget() });
      expect(defaultsOnly).toMatchObject({
        valid: true,
        hints: {},
        paths: { libs: [], test: null, script: null, out: null },
      });
      expect(defaultsOnly.diagnostics).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('nonexact Foundry compiler version'),
        }),
      );

      await writeFile(join(root, 'foundry.toml'), '[profile.ci]\nsrc = "ignored"\n');
      expect(await readProjectMetadata({ pathContext, budget: budget() })).toMatchObject({
        valid: true,
        hints: {},
      });
      await writeFile(
        join(root, 'foundry.toml'),
        '[profile.default]\nsrc = "."\ntest = "."\nscript = "."\nout = "."\n',
      );
      const rootPaths = await readProjectMetadata({ pathContext, budget: budget() });
      expect(rootPaths).toMatchObject({
        valid: true,
        hints: { scope: { sourceRoots: ['.'] } },
        paths: { test: null, script: null, out: null },
      });
      expect(rootPaths.diagnostics).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('Root-wide Foundry exclusion paths'),
        }),
      );

      await rm(join(root, 'foundry.toml'));
      await writeProjectFile(root, 'hardhat.config.cjs', 'module.exports = {};\n');
      expect(await readProjectMetadata({ pathContext, budget: budget() })).toMatchObject({
        valid: true,
        observation: { status: 'absent' },
        diagnostics: [
          expect.objectContaining({
            message: expect.stringContaining('Hardhat configuration was detected'),
          }),
        ],
      });
    } finally {
      await removeProject(root);
    }
  });

  it('handles missing metadata destinations, invalid path shapes, read limits and cancellation', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'contracts/Code.sol', 'contract Code {}\n');
      const pathContext = await safePathContext(root);
      const budget = () => createDiscoveryBudget(testLimits());
      await writeFile(
        join(root, 'foundry.toml'),
        '[profile.default]\nsrc = "missing/src"\nremappings = ["@code/=contracts/Code.sol", "missing:@lib/=missing/lib"]\nsolc_version = "0.8.30"\n',
      );
      const missingDestinations = await readProjectMetadata({ pathContext, budget: budget() });
      expect(missingDestinations.valid).toBe(true);
      expect(missingDestinations.hints.scope?.sourceRoots).toEqual(['missing/src']);
      expect(missingDestinations.hints.solidity?.version).toBe('0.8.30');
      expect(missingDestinations.hints.imports?.remappings).toEqual([
        { prefix: '@code/', target: 'contracts/Code.sol' },
        { context: 'missing', prefix: '@lib/', target: 'missing/lib' },
      ]);

      const malformedCases: readonly {
        readonly toml: string;
        readonly status: 'invalid' | 'blocked';
        readonly reason: string;
      }[] = [
        {
          toml: '[profile.default]\nlibs = "lib"\n',
          status: 'invalid',
          reason: 'invalid-metadata',
        },
        {
          toml: '[profile.default]\nremappings = 1\n',
          status: 'invalid',
          reason: 'invalid-metadata',
        },
        {
          toml: '[profile.default]\nlibs = ["contracts/Code.sol"]\n',
          status: 'blocked',
          reason: 'special-file',
        },
        {
          toml: '[profile.default]\nremappings = ["bad-prefix="]\n',
          status: 'invalid',
          reason: 'invalid-metadata',
        },
        {
          toml: `[profile.default]\nremappings = ["${'x'.repeat(129)}=lib"]\n`,
          status: 'invalid',
          reason: 'invalid-metadata',
        },
        {
          toml: "[profile.default]\nsrc = 'bad\\\\path'\n",
          status: 'blocked',
          reason: 'invalid-name',
        },
        {
          toml: '[profile.default]\nsolc = "\\u0001"\n',
          status: 'invalid',
          reason: 'invalid-metadata',
        },
        {
          toml: '[profile.default]\nsrc = "contracts/Code.sol/child"\n',
          status: 'blocked',
          reason: 'special-file',
        },
      ];
      for (const malformed of malformedCases) {
        await writeFile(join(root, 'foundry.toml'), malformed.toml);
        expect(await readProjectMetadata({ pathContext, budget: budget() })).toMatchObject({
          valid: false,
          observation: { status: malformed.status, reason: malformed.reason },
        });
      }

      await writeFile(join(root, 'foundry.toml'), '[profile.default]\nsrc = "contracts"\n');
      const unreadableAdapter: SafeReadAdapter = {
        open: async () => {
          throw new Error('controlled metadata read error');
        },
        resolve: resolveSafePath,
      };
      expect(
        await readProjectMetadata({ pathContext, budget: budget(), adapter: unreadableAdapter }),
      ).toMatchObject({
        valid: false,
        observation: { status: 'unreadable', reason: 'read-failed' },
      });

      const oversizedBudget = createDiscoveryBudget(testLimits({ maxMetadataBytes: 4 }));
      expect(await readProjectMetadata({ pathContext, budget: oversizedBudget })).toMatchObject({
        valid: false,
        observation: { status: 'oversized', reason: 'metadata-limit' },
      });

      const controller = new AbortController();
      controller.abort();
      await expect(
        readProjectMetadata({
          pathContext,
          budget: createDiscoveryBudget(testLimits(), controller.signal),
        }),
      ).rejects.toMatchObject({ kind: 'cancelled' });
    } finally {
      await removeProject(root);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'detects root-local Hardhat marker symlinks without following them',
    async () => {
      const root = await createProject();
      const outside = await createProject();
      try {
        await writeProjectFile(outside, 'hardhat.config.ts', 'export default {};\n');
        await symlink(join(outside, 'hardhat.config.ts'), join(root, 'hardhat.config.ts'));
        const metadata = await readProjectMetadata({
          pathContext: await safePathContext(root),
          budget: createDiscoveryBudget(testLimits()),
        });
        expect(metadata.observation.status).toBe('absent');
        expect(metadata.diagnostics).toContainEqual(
          expect.objectContaining({
            message: expect.stringContaining('Hardhat configuration was detected by path only'),
            details: [{ key: 'path', value: 'hardhat.config.ts' }],
          }),
        );
        await writeProjectFile(outside, 'foundry.toml', '[profile.default]\nsrc = "src"\n');
        await symlink(join(outside, 'foundry.toml'), join(root, 'foundry.toml'));
        expect(
          await readProjectMetadata({
            pathContext: await safePathContext(root),
            budget: createDiscoveryBudget(testLimits()),
          }),
        ).toMatchObject({ valid: false, observation: { status: 'blocked', reason: 'symlink' } });
      } finally {
        await Promise.all([removeProject(root), removeProject(outside)]);
      }
    },
  );

  it('discovers selected Solidity files, prunes exclusions and preserves required analysis completeness', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'contracts/Good.sol', 'contract Good {}\n');
      await writeProjectFile(root, 'contracts/Skip.t.sol', 'contract TestOnly {}\n');
      await writeProjectFile(root, 'contracts/No.sol', 'contract No {}\n');
      await writeProjectFile(
        root,
        'node_modules/dependency/Dependency.sol',
        'contract Dependency {}\n',
      );
      await writeProjectFile(root, '.git/Hidden.sol', 'contract Hidden {}\n');
      await writeProjectFile(
        root,
        'audit-estimator.config.json',
        JSON.stringify({
          configVersion: '1.0.0',
          scope: {
            sourceRoots: ['contracts'],
            include: ['contracts/**/*.sol'],
            exclude: ['contracts/No.sol'],
          },
        }),
      );
      const result = await discoverScope(await makeDiscoveryInput(root));
      expect(result.complete).toBe(true);
      expect(result.manifest.entries.map((entry) => [entry.path, entry.role])).toEqual([
        ['contracts/Good.sol', 'scoped'],
      ]);
      expect(
        result.observations.candidates.some(
          (item) => item.path === 'contracts/No.sol' && item.reason === 'excluded',
        ),
      ).toBe(true);
      expect(
        result.observations.prunedDirectories.some((item) => item.path === 'node_modules'),
      ).toBe(true);
      expect(result.observations.prunedDirectories.some((item) => item.path === '.git')).toBe(true);
      expect(result.observations.rootDecision.mode).toBe('include');
    } finally {
      await removeProject(root);
    }
  });

  it('projects include, config and metadata exclusions plus dependency ownership and alias conflicts', async () => {
    const root = await createProject();
    try {
      const shared = await writeProjectFile(root, 'contracts/Shared.sol', 'library Shared {}\n');
      await mkdir(join(root, 'lib'), { recursive: true });
      await link(shared, absoluteProjectPath(root, 'lib/Shared.sol'));
      await writeProjectFile(root, 'contracts/A.sol', 'contract A {}\n');
      await writeProjectFile(root, 'contracts/skip/Deep.sol', 'contract Deep {}\n');
      await writeProjectFile(root, 'contracts/generated/Generated.sol', 'contract Generated {}\n');
      await writeProjectFile(root, 'contracts/test/Test.sol', 'contract TestOnly {}\n');
      await writeProjectFile(root, 'lib/Dependency.sol', 'library Dependency {}\n');
      await writeProjectFile(root, 'vendor/local/Override.sol', 'contract Override {}\n');
      await writeProjectFile(root, 'foundry.toml', '[profile.default]\ntest = "contracts/test"\n');
      await writeProjectFile(
        root,
        'audit-estimator.config.json',
        JSON.stringify({
          configVersion: '1.0.0',
          scope: {
            sourceRoots: ['contracts'],
            include: ['contracts/A.sol'],
            exclude: ['contracts/generated/**'],
          },
        }),
      );

      const selected = await discoverScope(await makeDiscoveryInput(root));
      expect(selected.manifest.entries.map((entry) => entry.path)).toEqual(['contracts/A.sol']);
      expect(selected.observations.candidates).toContainEqual(
        expect.objectContaining({
          path: 'contracts/skip/Deep.sol',
          reason: 'not-selected',
        }),
      );
      expect(selected.observations.prunedDirectories).toContainEqual(
        expect.objectContaining({
          path: 'contracts/generated',
          rule: 'config-exclude:contracts/generated/**',
        }),
      );
      expect(selected.observations.prunedDirectories).toContainEqual(
        expect.objectContaining({
          path: 'contracts/test',
          rule: 'metadata-path:contracts/test',
        }),
      );

      await writeProjectFile(
        root,
        'audit-estimator.config.json',
        JSON.stringify({
          configVersion: '1.0.0',
          scope: {
            sourceRoots: ['contracts', 'lib', 'vendor/local'],
            include: ['**/*.sol'],
            defaultExcludes: false,
            thirdPartyRoots: ['lib'],
            firstPartyOverrides: ['vendor/local'],
          },
        }),
      );
      const complete = await discoverScope(await makeDiscoveryInput(root));
      expect(complete.manifest.entries.map((entry) => entry.path)).toEqual([
        'contracts/A.sol',
        'contracts/generated/Generated.sol',
        'contracts/skip/Deep.sol',
        'contracts/test/Test.sol',
        'vendor/local/Override.sol',
      ]);
      expect(complete.observations.candidates).toContainEqual(
        expect.objectContaining({
          path: 'lib/Dependency.sol',
          reason: 'third-party',
          ownership: 'third-party',
        }),
      );
      expect(complete.observations.candidates).toContainEqual(
        expect.objectContaining({
          path: 'contracts/Shared.sol',
          reason: 'unknown-ownership',
          ownership: 'unknown',
        }),
      );
      expect(complete.observations.aliases).toContainEqual(
        expect.objectContaining({
          representativePath: 'contracts/Shared.sol',
          ownership: 'unknown',
          rule: 'conflicting-alias-ownership',
        }),
      );
      expect(complete.complete).toBe(false);
    } finally {
      await removeProject(root);
    }
  });

  it('returns partial diagnostics for target mismatch, directory limits and unavailable directories', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'contracts/A.sol', 'contract A {}\n');
      await writeProjectFile(root, 'other/B.sol', 'contract B {}\n');
      await writeProjectFile(
        root,
        'audit-estimator.config.json',
        JSON.stringify({ configVersion: '1.0.0', scope: { sourceRoots: ['contracts'] } }),
      );
      const mismatch = await discoverScope(await makeDiscoveryInput(root, 'other'));
      expect(mismatch.complete).toBe(false);
      expect(
        mismatch.diagnostics.some((item) =>
          item.details?.some((detail) => detail.value === 'target-mismatch'),
        ),
      ).toBe(true);

      await writeProjectFile(
        root,
        'audit-estimator.config.json',
        JSON.stringify({
          configVersion: '1.0.0',
          scope: { sourceRoots: ['contracts/nested/deeper'] },
        }),
      );
      await mkdir(join(root, 'contracts/nested/deeper'), { recursive: true });
      await writeProjectFile(root, 'contracts/nested/deeper/Deep.sol', 'contract Deep {}\n');
      const shallow = await discoverScope(
        await makeDiscoveryInput(root, '.', testLimits({ maxDirectoryDepth: 1 })),
      );
      expect(shallow.complete).toBe(false);
      expect(
        shallow.diagnostics.some((item) =>
          item.details?.some((detail) => detail.value === 'max-directory-depth'),
        ),
      ).toBe(true);

      const missingInput = await makeDiscoveryInput(root);
      const adapter = {
        opendir: async () => {
          throw Object.assign(new Error('unavailable'), { code: 'EACCES' });
        },
      };
      const unavailable = await discoverScope({
        ...missingInput,
        config: {
          ...missingInput.config,
          scope: { ...missingInput.config.scope, sourceRoots: [], include: [] },
        },
        directoryAdapter: adapter,
      });
      expect(unavailable.complete).toBe(false);
      expect(unavailable.diagnostics.some((item) => item.code === 'TARGET_UNREADABLE')).toBe(true);
    } finally {
      await removeProject(root);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'matches include and exclusion rules across followed directory aliases',
    async () => {
      const root = await createProject();
      try {
        await writeProjectFile(root, 'storage/Good.sol', 'contract Good {}\n');
        await writeProjectFile(root, 'storage/test/Hidden.sol', 'contract Hidden {}\n');
        await mkdir(join(root, 'contracts'));
        await symlink(join(root, 'storage'), join(root, 'contracts', 'alias'));
        await symlink(join(root, 'contracts'), join(root, 'contracts', 'cycle'));
        await writeProjectFile(
          root,
          'audit-estimator.config.json',
          JSON.stringify({
            configVersion: '1.0.0',
            scope: {
              sourceRoots: ['contracts'],
              include: ['contracts/alias/**/*.sol'],
              exclude: ['storage/test/**'],
              defaultExcludes: false,
              followSymlinks: true,
            },
          }),
        );
        const lexical = await discoverScope(await makeDiscoveryInput(root));
        expect(lexical.manifest.entries.map((entry) => entry.path)).toEqual(['storage/Good.sol']);
        expect(lexical.observations.aliases[0]?.pathDecisions).toContainEqual(
          expect.objectContaining({
            lexicalPath: 'contracts/alias/Good.sol',
            physicalPath: 'storage/Good.sol',
            selected: true,
            selectionRule: expect.stringContaining(':lexical'),
          }),
        );
        expect(lexical.observations.prunedDirectories).toContainEqual(
          expect.objectContaining({
            path: 'storage/test',
            rule: 'config-exclude:storage/test/**',
          }),
        );
        expect(lexical.observations.prunedDirectories).toContainEqual(
          expect.objectContaining({
            path: 'contracts',
            rule: 'directory-cycle',
          }),
        );

        await writeProjectFile(
          root,
          'audit-estimator.config.json',
          JSON.stringify({
            configVersion: '1.0.0',
            scope: {
              sourceRoots: ['contracts'],
              include: ['storage/Good.sol'],
              defaultExcludes: false,
              followSymlinks: true,
            },
          }),
        );
        const physical = await discoverScope(await makeDiscoveryInput(root));
        expect(physical.manifest.entries.map((entry) => entry.path)).toEqual(['storage/Good.sol']);
        expect(physical.observations.aliases[0]?.pathDecisions).toContainEqual(
          expect.objectContaining({
            lexicalPath: 'contracts/alias/Good.sol',
            selected: true,
            selectionRule: expect.stringContaining(':physical'),
          }),
        );
      } finally {
        await removeProject(root);
      }
    },
  );

  it('closes failed directory handles and rejects non-Solidity literal targets with partial diagnostics', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'contracts/A.sol', 'contract A {}\n');
      const input = await makeDiscoveryInput(root);
      let closed = 0;
      const readFailure = {
        opendir: async () => ({
          read: async () => {
            throw new Error('controlled directory failure');
          },
          close: async () => {
            closed += 1;
          },
        }),
      };
      const failed = await discoverScope({ ...input, directoryAdapter: readFailure });
      expect(failed.complete).toBe(false);
      expect(closed).toBe(1);
      expect(failed.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'TARGET_UNREADABLE' }),
      );

      await writeProjectFile(root, 'README.md', 'not Solidity');
      const literal = await discoverScope(await makeDiscoveryInput(root, 'README.md'));
      expect(literal.complete).toBe(false);
      expect(literal.manifest.entries).toEqual([]);
      expect(literal.observations.candidates).toContainEqual(
        expect.objectContaining({
          path: 'README.md',
          reason: 'not-solidity',
          rule: 'literal-target',
        }),
      );
      expect(literal.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'TARGET_UNREADABLE' }),
      );
    } finally {
      await removeProject(root);
    }
  });

  it('records false directory-entry type claims and failed selected source reads', async () => {
    const root = await createProject();
    try {
      const sourcePath = await writeProjectFile(root, 'contracts/A.sol', 'contract A {}\n');
      const input = await makeDiscoveryInput(root);
      const falselyTypedEntry: DiscoveryDirectoryEntry = {
        name: 'A.sol',
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => false,
      };
      const ghostEntry: DiscoveryDirectoryEntry = {
        name: 'Ghost.sol',
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      };
      const entries = [ghostEntry, falselyTypedEntry];
      let entryIndex = 0;
      const misleadingAdapter = {
        opendir: async () => ({
          read: async () => entries[entryIndex++] ?? null,
          close: async () => undefined,
        }),
      };
      const misleading = await discoverScope({ ...input, directoryAdapter: misleadingAdapter });
      expect(misleading.complete).toBe(false);
      expect(misleading.observations.candidates).toContainEqual(
        expect.objectContaining({
          path: 'contracts/A.sol',
          reason: 'unsafe',
          rule: 'special-file',
        }),
      );
      expect(misleading.observations.candidates).toContainEqual(
        expect.objectContaining({
          path: 'contracts/Ghost.sol',
          reason: 'unsafe',
          rule: 'missing',
        }),
      );

      const nextInput = await makeDiscoveryInput(root);
      const failingRead: SafeReadAdapter = {
        open: async () => {
          throw new Error('controlled open failure');
        },
        resolve: resolveSafePath,
      };
      const unreadable = await discoverScope({ ...nextInput, readAdapter: failingRead });
      expect(unreadable.complete).toBe(false);
      expect(unreadable.manifest.entries).toEqual([]);
      expect(unreadable.observations.candidates).toContainEqual(
        expect.objectContaining({
          path: 'contracts/A.sol',
          reason: 'read-failed',
        }),
      );
      expect(unreadable.observations.counters.failedSourceReads).toBe(1);
      expect(unreadable.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'TARGET_UNREADABLE' }),
      );
      expect(sourcePath).toBe(join(root, 'contracts', 'A.sol'));
      let yieldedBackslash = false;
      const backslashName = await discoverScope({
        ...(await makeDiscoveryInput(root)),
        directoryAdapter: {
          opendir: async () => ({
            read: async () => {
              if (yieldedBackslash) return null;
              yieldedBackslash = true;
              return {
                name: 'unrepresentable\\name.sol',
                isDirectory: () => false,
                isFile: () => true,
                isSymbolicLink: () => false,
              };
            },
            close: async () => undefined,
          }),
        },
      });
      expect(backslashName.complete).toBe(false);
      expect(backslashName.observations.candidates).toContainEqual(
        expect.objectContaining({ rule: 'unrepresentable-path-name' }),
      );
    } finally {
      await removeProject(root);
    }
  });

  it('reads a literal Solidity target and stops before reading a source beyond the filesystem allowance', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'contracts/A.sol', 'contract A {}\n');
      const literal = await discoverScope(await makeDiscoveryInput(root, 'contracts/A.sol'));
      expect(literal.complete).toBe(true);
      expect(literal.manifest.entries.map((entry) => entry.path)).toEqual(['contracts/A.sol']);
      expect(literal.observations.rules).toContainEqual(
        expect.objectContaining({
          path: 'contracts/A.sol',
          rule: 'literal-file',
          source: 'target',
        }),
      );

      let returned = 0;
      let closed = 0;
      const entry: DiscoveryDirectoryEntry = {
        name: 'A.sol',
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      };
      const limited = await discoverScope({
        ...(await makeDiscoveryInput(root, '.', testLimits({ maxFsEntries: 1 }))),
        directoryAdapter: {
          opendir: async () => ({
            read: async () => (returned++ < 2 ? entry : null),
            close: async () => {
              closed += 1;
            },
          }),
        },
      });
      expect(limited.complete).toBe(false);
      expect(limited.manifest.entries).toEqual([]);
      expect(limited.observations.counters.filesystemEntries).toBe(2);
      expect(limited.observations.counters.sourceBytes).toBe(0);
      expect(closed).toBe(1);
      expect(limited.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'LIMIT_EXCEEDED' }),
      );
    } finally {
      await removeProject(root);
    }
  });

  it('preserves empty and dependency-only scopes and reports root-selection deadlines', async () => {
    const emptyRoot = await createProject();
    try {
      await writeProjectFile(emptyRoot, 'src/notes.txt', 'not Solidity');
      const empty = await discoverScope(await makeDiscoveryInput(emptyRoot));
      expect(empty.complete).toBe(true);
      expect(empty.manifest.entries).toEqual([]);
      expect(empty.diagnostics).toContainEqual(expect.objectContaining({ code: 'EMPTY_SCOPE' }));
    } finally {
      await removeProject(emptyRoot);
    }

    const dependencyRoot = await createProject();
    try {
      await writeProjectFile(dependencyRoot, 'vendor/Only.sol', 'library Only {}\n');
      await writeProjectFile(
        dependencyRoot,
        'audit-estimator.config.json',
        JSON.stringify({
          configVersion: '1.0.0',
          scope: { sourceRoots: ['vendor'], include: ['**/*.sol'], defaultExcludes: false },
        }),
      );
      const dependencyOnly = await discoverScope(await makeDiscoveryInput(dependencyRoot));
      expect(dependencyOnly.complete).toBe(true);
      expect(dependencyOnly.manifest.entries).toEqual([]);
      expect(dependencyOnly.observations.candidates).toContainEqual(
        expect.objectContaining({ reason: 'third-party' }),
      );
      expect(dependencyOnly.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'EMPTY_SCOPE' }),
      );
    } finally {
      await removeProject(dependencyRoot);
    }

    const deadlineRoot = await createProject();
    try {
      await mkdir(join(deadlineRoot, 'src'));
      const deadline = await makeDiscoveryInput(deadlineRoot);
      const expiredBudget = createDiscoveryBudget(
        deadline.config.analysis.limits,
        undefined,
        performance.now() - 1,
      );
      const interrupted = await discoverScope({ ...deadline, budget: expiredBudget });
      expect(interrupted.complete).toBe(false);
      expect(interrupted.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'LIMIT_EXCEEDED',
          details: expect.arrayContaining([
            expect.objectContaining({ key: 'reason', value: 'deadline' }),
          ]),
        }),
      );
    } finally {
      await removeProject(deadlineRoot);
    }
  });

  it('orders Unicode source paths by scalar value and retains default root provenance', async () => {
    const root = await createProject();
    try {
      const paths = [
        'contracts/A.sol',
        'contracts/AA.sol',
        'contracts/B.sol',
        'contracts/é.sol',
        'contracts/😀.sol',
        'contracts/😀a.sol',
      ];
      for (let index = 0; index < paths.length; index += 1) {
        const path = paths[index];
        if (path === undefined) throw new Error('Expected a fixture path.');
        await writeProjectFile(root, path, `contract C${index} {}\n`);
      }
      await writeProjectFile(
        root,
        'audit-estimator.config.json',
        JSON.stringify({
          configVersion: '1.0.0',
          scope: {
            sourceRoots: ['contracts'],
            include: ['**/*.sol'],
            defaultExcludes: false,
          },
        }),
      );
      const input = await makeDiscoveryInput(root);
      const result = await discoverScope(input);
      expect(result.manifest.entries.map((entry) => entry.path)).toEqual(paths);

      await mkdir(absoluteProjectPath(root, 'contracts/é'));
      await mkdir(absoluteProjectPath(root, 'contracts/😀'));
      const target = (await makeDiscoveryInput(root, 'contracts')).target;
      const selected = await selectSourceRoots({
        pathContext: await safePathContext(root),
        target,
        scope: { ...input.config.scope, sourceRoots: ['contracts/😀', 'contracts/é'], include: [] },
        config: { ...input.config, provenance: [] },
        budget: input.budget,
      });
      expect(selected.candidateBasePaths).toEqual(['contracts/é', 'contracts/😀']);
      expect(selected.configuredRootSource).toBe('default');
    } finally {
      await removeProject(root);
    }
  });

  it('keeps missing non-source directory entries inert and reports a selected-file budget stop', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'contracts/A.sol', 'contract A {}\n');
      const input = await makeDiscoveryInput(root);
      const ghostEntry: DiscoveryDirectoryEntry = {
        name: 'notes.txt',
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      };
      let returned = false;
      const inert = await discoverScope({
        ...input,
        directoryAdapter: {
          opendir: async () => ({
            read: async () => (returned ? null : ((returned = true), ghostEntry)),
            close: async () => undefined,
          }),
        },
      });
      expect(inert.complete).toBe(true);
      expect(inert.observations.candidates).toEqual([]);

      await writeProjectFile(root, 'contracts/B.sol', 'contract B {}\n');
      await writeProjectFile(
        root,
        'audit-estimator.config.json',
        JSON.stringify({
          configVersion: '1.0.0',
          scope: { sourceRoots: ['contracts'], include: ['**/*.sol'] },
        }),
      );
      const limited = await discoverScope(
        await makeDiscoveryInput(root, '.', testLimits({ maxFiles: 1 })),
      );
      expect(limited.complete).toBe(false);
      expect(limited.manifest.entries).toHaveLength(1);
      expect(limited.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'LIMIT_EXCEEDED' }),
      );
    } finally {
      await removeProject(root);
    }
  });
});
