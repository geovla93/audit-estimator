import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { realpathSync } from 'node:fs';
import { chmod, copyFile, link, mkdir, open, rename, symlink, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createDiscoveryBudget } from '../../src/discovery/budget.ts';
import { IdentityRegistry } from '../../src/discovery/identity.ts';
import {
  readCoverageFile,
  readMetadataFile,
  readSource,
  type SafeReadAdapter,
  type SafeReadHandle,
} from '../../src/discovery/safe-read.ts';
import { resolveSafePath } from '../../src/discovery/safe-path.ts';
import {
  absoluteProjectPath,
  createProject,
  removeProject,
  safePathContext,
  testLimits,
  writeProjectFile,
} from '../helpers/filesystem.ts';

function makeReadContext(
  root: string,
  limits: ReturnType<typeof testLimits>,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly deadlineAt?: number | undefined;
    readonly adapter?: SafeReadAdapter | undefined;
  } = {},
) {
  return {
    pathContext: {
      // The native variant expands Windows 8.3 short names like resolveSafePath's realpath does.
      root: realpathSync.native(root),
      lexicalRoot: root,
      followSymlinks: false,
    },
    budget: createDiscoveryBudget(limits, options.signal, options.deadlineAt),
    identities: new IdentityRegistry(),
    ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
  };
}

function forwardingAdapter(
  afterOpen?: (path: string) => Promise<void>,
  beforeRead?: () => Promise<void>,
  closeObserved?: () => void,
): SafeReadAdapter {
  return {
    open: async (path, flags): Promise<SafeReadHandle> => {
      const handle = await open(path, flags);
      if (afterOpen !== undefined) await afterOpen(path);
      return {
        stat: (options) => handle.stat(options),
        read: async (buffer, offset, length, position) => {
          if (beforeRead !== undefined) await beforeRead();
          return handle.read(buffer, offset, length, position);
        },
        close: async () => {
          closeObserved?.();
          await handle.close();
        },
      };
    },
    resolve: resolveSafePath,
  };
}

describe('paths and identities', () => {
  it('confines paths with component-aware boundaries and blocks default symlinks', async () => {
    const root = await createProject();
    const outside = await createProject('audit-estimator-outside-');
    try {
      const source = await writeProjectFile(root, 'contracts/A.sol', 'contract A {}\n');
      const outsideSource = await writeProjectFile(outside, 'A.sol', 'contract Outside {}\n');
      const context = await safePathContext(root);
      const safe = await resolveSafePath(context, source);
      expect(safe.physicalRelativePath).toBe('contracts/A.sol');

      const siblingPrefix = `${root}-sibling`;
      await expect(resolveSafePath(context, `${siblingPrefix}/A.sol`)).rejects.toMatchObject({
        code: 'PATH_BLOCKED',
        reason: 'outside-root',
      });
      const linkPath = absoluteProjectPath(root, 'contracts/linked.sol');
      await symlink(outsideSource, linkPath);
      await expect(resolveSafePath(context, linkPath)).rejects.toMatchObject({
        code: 'PATH_BLOCKED',
        reason: 'symlink',
      });
    } finally {
      await removeProject(root);
      await removeProject(outside);
    }
  });

  it('preserves cancellation raised before a path-component inspection', async () => {
    const root = await createProject();
    try {
      const file = await writeProjectFile(root, 'contracts/Cancel.sol', 'contract Cancel {}\n');
      const pathContext = await safePathContext(root);
      const controller = new AbortController();
      const budget = createDiscoveryBudget(testLimits(), controller.signal);
      const check = budget.check.bind(budget);
      let checks = 0;
      budget.check = () => {
        checks += 1;
        if (checks === 2) controller.abort();
        check();
      };

      await expect(resolveSafePath({ ...pathContext, budget }, file)).rejects.toMatchObject({
        kind: 'cancelled',
      });
      expect(checks).toBe(2);
    } finally {
      await removeProject(root);
    }
  });

  it('requires followed source links to remain inside the scoped target subtree', async () => {
    const root = await createProject();
    try {
      const target = absoluteProjectPath(root, 'contracts');
      const externalTree = absoluteProjectPath(root, 'other');
      await writeProjectFile(root, 'other/Outside.sol', 'contract Outside {}\n');
      await writeProjectFile(root, 'contracts/Local.sol', 'contract Local {}\n');
      const linkPath = absoluteProjectPath(root, 'contracts/external');
      await symlink(externalTree, linkPath);
      const context = await safePathContext(root, { target, followSymlinks: true });
      await expect(
        resolveSafePath(context, absoluteProjectPath(root, 'contracts/external/Outside.sol')),
      ).rejects.toMatchObject({ code: 'PATH_BLOCKED', reason: 'outside-target' });
    } finally {
      await removeProject(root);
    }
  });

  it('blocks symlink roots, intermediate links, and hard-excluded physical targets', async () => {
    const root = await createProject();
    const rootAlias = `${root}-alias`;
    try {
      await writeProjectFile(root, 'contracts/real/Inside.sol', 'contract Inside {}\n');
      const context = await safePathContext(root);
      await symlink(
        absoluteProjectPath(root, 'contracts/real'),
        absoluteProjectPath(root, 'contracts/linked'),
      );
      await expect(
        resolveSafePath(context, absoluteProjectPath(root, 'contracts/linked/Inside.sol')),
      ).rejects.toMatchObject({ code: 'PATH_BLOCKED', reason: 'symlink' });

      await writeProjectFile(root, '.git/Hidden.sol', 'contract Hidden {}\n');
      const gitLink = absoluteProjectPath(root, 'contracts/HardExcluded.sol');
      await symlink(absoluteProjectPath(root, '.git/Hidden.sol'), gitLink);
      const following = await safePathContext(root, { target: root, followSymlinks: true });
      await expect(resolveSafePath(following, gitLink)).rejects.toMatchObject({
        code: 'PATH_BLOCKED',
        reason: 'hard-excluded',
      });

      await symlink(root, rootAlias);
      await expect(
        resolveSafePath(
          await safePathContext(rootAlias),
          absoluteProjectPath(rootAlias, 'contracts/real/Inside.sol'),
        ),
      ).rejects.toMatchObject({
        code: 'PATH_BLOCKED',
        reason: 'symlink',
      });
    } finally {
      await removeProject(root);
      await removeProject(rootAlias);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'rejects drive-like file identities and backslash symlink aliases',
    async () => {
      const root = await createProject();
      try {
        const file = await writeProjectFile(root, 'contracts/Real.sol', 'contract Real {}\n');
        const context = await safePathContext(root);
        const driveLike = await writeProjectFile(root, 'C:Alias.sol', 'contract Alias {}\n');
        await expect(resolveSafePath(context, driveLike)).rejects.toMatchObject({
          code: 'PATH_BLOCKED',
          reason: 'invalid-name',
        });
        const backslashAlias = absoluteProjectPath(root, 'contracts/alias\\Real.sol');
        await symlink(file, backslashAlias);
        await expect(resolveSafePath(context, backslashAlias)).rejects.toMatchObject({
          code: 'PATH_BLOCKED',
          reason: 'invalid-name',
        });
      } finally {
        await removeProject(root);
      }
    },
  );

  it('rejects directories and other non-regular source candidates', async () => {
    const root = await createProject();
    try {
      const directory = absoluteProjectPath(root, 'contracts/special.sol');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(directory, { recursive: true });
      const context = makeReadContext(root, testLimits());
      await expect(readSource(context, directory)).rejects.toMatchObject({
        code: 'PATH_BLOCKED',
        reason: 'special-file',
      });
    } finally {
      await removeProject(root);
    }
  });

  it('groups hardlinks by physical identity and keeps copied bytes separate', async (testContext) => {
    const root = await createProject();
    try {
      const second = await writeProjectFile(root, 'contracts/B.sol', 'contract Alias {}\n');
      const first = absoluteProjectPath(root, 'contracts/A.sol');
      try {
        await link(second, first);
      } catch (error: unknown) {
        testContext.skip(`hard links unsupported by this filesystem: ${String(error)}`);
      }

      const context = await safePathContext(root);
      const paths = makeReadContext(root, testLimits());
      const secondSafe = await resolveSafePath(context, second);
      const firstSafe = await resolveSafePath(context, first);
      const record = paths.identities.observe(secondSafe);
      paths.identities.observe(firstSafe);
      paths.identities.freeze(record.identityKey);

      const snapshot = await readSource(paths, second);
      expect(snapshot.canonicalPath).toBe('contracts/A.sol');
      expect((await readSource(paths, first)).byteHash).toBe(snapshot.byteHash);
      expect(paths.budget.counters.sourceFiles).toBe(1);
      expect(paths.budget.counters.sourceBytes).toBe(Buffer.byteLength('contract Alias {}\n'));

      const copy = absoluteProjectPath(root, 'contracts/Copy.sol');
      await copyFile(first, copy);
      const copiedSnapshot = await readSource(paths, copy);
      expect(copiedSnapshot.byteHash).toBe(snapshot.byteHash);
      expect(copiedSnapshot.canonicalPath).toBe('contracts/Copy.sol');
      expect(paths.budget.counters.sourceFiles).toBe(2);
    } finally {
      await removeProject(root);
    }
  });

  it('freezes a direct read before a smaller hardlink alias is observed', async (testContext) => {
    const root = await createProject();
    try {
      const laterRepresentative = await writeProjectFile(
        root,
        'contracts/B.sol',
        'contract LateAlias {}\n',
      );
      const earlierName = absoluteProjectPath(root, 'contracts/A.sol');
      const context = makeReadContext(root, testLimits());
      const firstSnapshot = await readSource(context, laterRepresentative);
      expect(firstSnapshot.canonicalPath).toBe('contracts/B.sol');

      try {
        await link(laterRepresentative, earlierName);
      } catch (error: unknown) {
        testContext.skip(`hard links unsupported by this filesystem: ${String(error)}`);
      }

      const secondSnapshot = await readSource(context, earlierName);
      expect(secondSnapshot).toBe(firstSnapshot);
      expect(secondSnapshot.canonicalPath).toBe('contracts/B.sol');
      expect(context.budget.counters.sourceFiles).toBe(1);
      expect(context.budget.counters.sourceBytes).toBe(
        Buffer.byteLength('contract LateAlias {}\n'),
      );
      expect(context.identities.identities()[0]?.representativePath).toBe('contracts/B.sol');
      expect(context.identities.identities()[0]?.frozen).toBe(true);
    } finally {
      await removeProject(root);
    }
  });
});

describe('bounded reads', () => {
  it('preserves BOM and line endings, hashes original bytes, and accepts empty files', async () => {
    const root = await createProject();
    try {
      const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('A\r\nB\rC\n')]);
      const path = await writeProjectFile(root, 'src/Bom.sol', bytes);
      const emptyPath = await writeProjectFile(root, 'src/Empty.sol', new Uint8Array());
      const context = makeReadContext(root, testLimits());
      const source = await readSource(context, path);
      expect(source.originalText.charCodeAt(0)).toBe(0xfeff);
      expect(source.originalText).toBe('\ufeffA\r\nB\rC\n');
      expect(source.byteHash).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect((await readSource(context, emptyPath)).originalText).toBe('');
    } finally {
      await removeProject(root);
    }
  });

  it('rejects invalid UTF-8 and files beyond the effective source ceilings', async () => {
    const root = await createProject();
    try {
      const invalidPath = await writeProjectFile(
        root,
        'src/Invalid.sol',
        new Uint8Array([0xc3, 0x28]),
      );
      const context = makeReadContext(
        root,
        testLimits({ maxFileBytes: 4, maxTotalSourceBytes: 4 }),
      );
      await expect(readSource(context, invalidPath)).rejects.toMatchObject({
        code: 'TARGET_UNREADABLE',
        reason: 'invalid-utf8',
      });
      expect(context.budget.counters.sourceBytes).toBe(2);
      expect(context.budget.counters.failedSourceReads).toBe(1);

      const largePath = await writeProjectFile(root, 'src/Large.sol', '12345');
      const limited = makeReadContext(
        root,
        testLimits({ maxFileBytes: 4, maxTotalSourceBytes: 4 }),
      );
      await expect(readSource(limited, largePath)).rejects.toMatchObject({ kind: 'limit' });
      expect(limited.budget.counters.sourceBytes).toBe(0);
      expect(limited.budget.counters.sourceFiles).toBe(0);
    } finally {
      await removeProject(root);
    }
  });

  it('accepts exact file/total/file-count boundaries and rejects the next unique identity', async () => {
    const root = await createProject();
    try {
      const first = await writeProjectFile(root, 'src/First.sol', '1234');
      const second = await writeProjectFile(root, 'src/Second.sol', '5');
      const copied = await writeProjectFile(root, 'src/Copy.sol', '1234');
      const context = makeReadContext(
        root,
        testLimits({
          maxFileBytes: 4,
          maxTotalSourceBytes: 4,
          maxFiles: 1,
        }),
      );
      expect((await readSource(context, first)).originalText).toBe('1234');
      await expect(readSource(context, second)).rejects.toMatchObject({ kind: 'limit' });
      await expect(readSource(context, copied)).rejects.toMatchObject({ kind: 'limit' });
      expect(context.budget.counters.sourceBytes).toBe(4);
      expect(context.budget.counters.sourceFiles).toBe(1);
      expect(context.budget.counters.failedSourceReads).toBe(2);

      const overFile = await writeProjectFile(root, 'src/OverFile.sol', '12345');
      const fileLimited = makeReadContext(
        root,
        testLimits({ maxFileBytes: 4, maxTotalSourceBytes: 20 }),
      );
      await expect(readSource(fileLimited, overFile)).rejects.toMatchObject({ kind: 'limit' });
      expect(fileLimited.budget.counters.sourceBytes).toBe(0);
      expect(fileLimited.budget.counters.sourceFiles).toBe(0);
    } finally {
      await removeProject(root);
    }
  });

  it('detects growth during an open descriptor read and charges actual returned bytes', async () => {
    const root = await createProject();
    try {
      const path = await writeProjectFile(root, 'src/Growing.sol', 'A');
      let closeCalls = 0;
      const context = makeReadContext(root, testLimits(), {
        adapter: forwardingAdapter(
          undefined,
          async () => {
            await writeFile(path, 'A grew while the descriptor was open');
          },
          () => {
            closeCalls += 1;
          },
        ),
      });
      await expect(readSource(context, path)).rejects.toMatchObject({
        code: 'SOURCE_CHANGED',
        reason: 'changed',
      });
      expect(context.budget.counters.sourceBytes).toBeGreaterThan(1);
      expect(context.budget.counters.failedSourceReads).toBe(1);
      expect(closeCalls).toBe(1);
    } finally {
      await removeProject(root);
    }
  });

  it('rejects descriptor identity substitution and closes the original handle', async () => {
    const root = await createProject();
    try {
      const path = await writeProjectFile(root, 'src/Substitute.sol', 'contract Original {}\n');
      let closeCalls = 0;
      const adapter = forwardingAdapter(
        async (openedPath) => {
          await rename(openedPath, `${openedPath}.moved`);
          await writeFile(openedPath, 'contract Replacement {}\n');
        },
        undefined,
        () => {
          closeCalls += 1;
        },
      );
      const context = makeReadContext(root, testLimits(), { adapter });
      await expect(readSource(context, path)).rejects.toMatchObject({
        code: 'SOURCE_CHANGED',
        reason: 'changed',
      });
      expect(context.budget.counters.sourceBytes).toBe(0);
      expect(closeCalls).toBe(1);
    } finally {
      await removeProject(root);
    }
  });

  it('fails closed when open rejects safe flags instead of retrying an unguarded read', async () => {
    const root = await createProject();
    try {
      const path = await writeProjectFile(root, 'src/Flags.sol', 'contract Flags {}\n');
      let openCalls = 0;
      const adapter: SafeReadAdapter = {
        open: async (_path, flags) => {
          openCalls += 1;
          expect(flags & fsConstants.O_NOFOLLOW).not.toBe(0);
          expect(flags & fsConstants.O_NONBLOCK).not.toBe(0);
          throw new Error('safe flags unsupported');
        },
        resolve: resolveSafePath,
      };
      const context = makeReadContext(root, testLimits(), { adapter });
      await expect(readSource(context, path)).rejects.toMatchObject({
        code: 'TARGET_UNREADABLE',
        reason: 'read-failed',
      });
      expect(openCalls).toBe(1);
      expect(context.budget.counters.failedSourceReads).toBe(1);
    } finally {
      await removeProject(root);
    }
  });

  it('rejects a FIFO before opening it when the host can create FIFOs', async (testContext) => {
    if (process.platform === 'win32') testContext.skip('FIFOs are unavailable on Windows.');
    const root = await createProject();
    try {
      const fifo = absoluteProjectPath(root, 'src/pipe.sol');
      await mkdir(absoluteProjectPath(root, 'src'), { recursive: true });
      try {
        const { execFile } = await import('node:child_process');
        await new Promise<void>((resolve, reject) => {
          execFile('mkfifo', [fifo], (error) => {
            if (error !== null) reject(error);
            else resolve();
          });
        });
      } catch {
        testContext.skip('The host does not provide a usable mkfifo utility.');
      }
      const context = makeReadContext(root, testLimits());
      await expect(readSource(context, fifo)).rejects.toMatchObject({
        code: 'PATH_BLOCKED',
        reason: 'special-file',
      });
      expect(context.budget.counters.sourceBytes).toBe(0);
    } finally {
      await removeProject(root);
    }
  });

  it('reports permission denial when the host user can enforce file modes', async (testContext) => {
    const root = await createProject();
    try {
      const path = await writeProjectFile(root, 'src/Denied.sol', 'contract Denied {}\n');
      if (process.getuid?.() === 0) {
        testContext.skip('The process runs as root and bypasses mode-based read denial.');
      }
      await chmod(path, 0);
      let permissionDenied = false;
      try {
        await open(path, fsConstants.O_RDONLY).then((handle) => handle.close());
      } catch {
        permissionDenied = true;
      }
      if (!permissionDenied) {
        testContext.skip('The host filesystem does not enforce the requested permission denial.');
      }
      const context = makeReadContext(root, testLimits());
      await expect(readSource(context, path)).rejects.toMatchObject({
        code: 'TARGET_UNREADABLE',
        reason: 'read-failed',
      });
    } finally {
      await removeProject(root);
    }
  });

  it('closes descriptors after descriptor-stat and chunk-read failures', async () => {
    const root = await createProject();
    try {
      const path = await writeProjectFile(root, 'src/Failures.sol', 'contract Failures {}\n');
      let statCloseCalls = 0;
      const statFailure: SafeReadAdapter = {
        open: async (openedPath, flags) => {
          const handle = await open(openedPath, flags);
          return {
            stat: async () => {
              throw new Error('stat failed');
            },
            read: (buffer, offset, length, position) =>
              handle.read(buffer, offset, length, position),
            close: async () => {
              statCloseCalls += 1;
              await handle.close();
            },
          };
        },
        resolve: resolveSafePath,
      };
      const statContext = makeReadContext(root, testLimits(), { adapter: statFailure });
      await expect(readSource(statContext, path)).rejects.toMatchObject({
        code: 'TARGET_UNREADABLE',
        reason: 'read-failed',
      });
      expect(statCloseCalls).toBe(1);

      let readCloseCalls = 0;
      const readContext = makeReadContext(root, testLimits(), {
        adapter: forwardingAdapter(
          undefined,
          async () => {
            throw new Error('read failed');
          },
          () => {
            readCloseCalls += 1;
          },
        ),
      });
      await expect(readSource(readContext, path)).rejects.toMatchObject({
        code: 'TARGET_UNREADABLE',
        reason: 'read-failed',
      });
      expect(readCloseCalls).toBe(1);
    } finally {
      await removeProject(root);
    }
  });
});

describe('cancellation and cleanup', () => {
  it('honors pre-aborted and scheduled signals, charges bytes returned before abort, and closes handles', async () => {
    const root = await createProject();
    try {
      const path = await writeProjectFile(root, 'src/Abort.sol', 'contract Abort {}\n');
      const preAborted = new AbortController();
      preAborted.abort();
      const preContext = makeReadContext(root, testLimits(), { signal: preAborted.signal });
      await expect(readSource(preContext, path)).rejects.toMatchObject({ kind: 'cancelled' });
      expect(preContext.budget.counters.sourceBytes).toBe(0);

      const scheduled = new AbortController();
      let closeCalls = 0;
      let scheduledTimer: ReturnType<typeof setTimeout> | undefined;
      const adapter = forwardingAdapter(
        undefined,
        async () => {
          scheduledTimer = setTimeout(() => scheduled.abort(), 1);
          await delay(10);
        },
        () => {
          closeCalls += 1;
        },
      );
      const scheduledContext = makeReadContext(root, testLimits(), {
        signal: scheduled.signal,
        adapter,
      });
      await expect(readSource(scheduledContext, path)).rejects.toMatchObject({ kind: 'cancelled' });
      if (scheduledTimer !== undefined) clearTimeout(scheduledTimer);
      expect(scheduledContext.budget.counters.sourceBytes).toBeGreaterThan(0);
      expect(scheduledContext.budget.counters.failedSourceReads).toBe(1);
      expect(scheduledContext.budget.counters.sourceFiles).toBe(0);
      expect(closeCalls).toBe(1);
    } finally {
      await removeProject(root);
    }
  });

  it('rechecks after open and closes the descriptor when the path changes', async () => {
    const root = await createProject();
    try {
      const path = await writeProjectFile(root, 'src/Changing.sol', 'contract Before {}\n');
      let closeCalls = 0;
      const adapter = forwardingAdapter(
        async (openedPath) => {
          await writeFile(openedPath, 'contract After {}\n');
        },
        undefined,
        () => {
          closeCalls += 1;
        },
      );
      const context = makeReadContext(root, testLimits(), { adapter });
      await expect(readSource(context, path)).rejects.toMatchObject({
        code: 'SOURCE_CHANGED',
        reason: 'changed',
      });
      expect(closeCalls).toBe(1);
      expect(context.budget.counters.sourceBytes).toBe(0);
    } finally {
      await removeProject(root);
    }
  });

  it('enforces an elapsed deadline during I/O while charging bytes returned before the deadline check', async () => {
    const root = await createProject();
    try {
      const path = await writeProjectFile(root, 'src/Deadline.sol', 'contract Deadline {}\n');
      let closeCalls = 0;
      const controlledBudget: { value: ReturnType<typeof createDiscoveryBudget> | undefined } = {
        value: undefined,
      };
      const context = makeReadContext(root, testLimits(), {
        adapter: forwardingAdapter(
          undefined,
          async () => {
            const budget = controlledBudget.value;
            if (budget === undefined) throw new Error('Read boundary was not armed.');
            budget.tightenDeadline(performance.now() + 5);
            await delay(25);
          },
          () => {
            closeCalls += 1;
          },
        ),
      });
      controlledBudget.value = context.budget;
      await expect(readSource(context, path)).rejects.toMatchObject({ kind: 'deadline' });
      expect(context.budget.counters.sourceBytes).toBeGreaterThan(0);
      expect(context.budget.counters.failedSourceReads).toBe(1);
      expect(closeCalls).toBe(1);
    } finally {
      await removeProject(root);
    }
  });
});

describe('dedicated coverage reader', () => {
  it('reads a valid artifact above the metadata cap under the lcov counter only', async () => {
    const root = await createProject();
    try {
      const bytes = Buffer.alloc(300 * 1024, 0x61);
      const path = await writeProjectFile(root, 'coverage/lcov.info', bytes);
      const context = makeReadContext(root, testLimits({ maxLcovBytes: 400 * 1024 }));
      const read = await readCoverageFile(context, path);
      expect(read.byteLength).toBe(bytes.byteLength);
      expect(context.budget.counters.lcovBytes).toBe(bytes.byteLength);
      expect(context.budget.counters.sourceBytes).toBe(0);
      expect(context.budget.counters.metadataBytes).toBe(0);
      expect(context.budget.counters.sourceFiles).toBe(0);
      expect(context.budget.counters.failedSourceReads).toBe(0);
      // Metadata keeps its own 256 KiB ceiling regardless of the coverage limit.
      await expect(readMetadataFile(context, path)).rejects.toMatchObject({
        kind: 'limit',
        budget: 'metadataBytes',
      });
    } finally {
      await removeProject(root);
    }
  });

  it('accepts the exact cap, rejects one byte beyond it and ignores maxFileBytes', async () => {
    const root = await createProject();
    try {
      const exact = await writeProjectFile(root, 'lcov-exact.info', 'x'.repeat(64));
      const over = await writeProjectFile(root, 'lcov-over.info', 'x'.repeat(65));
      const limits = testLimits({ maxLcovBytes: 64, maxFileBytes: 8, maxTotalSourceBytes: 8 });
      const context = makeReadContext(root, limits);
      expect((await readCoverageFile(context, exact)).byteLength).toBe(64);
      expect(context.budget.counters.lcovBytes).toBe(64);

      const second = makeReadContext(root, limits);
      await expect(readCoverageFile(second, over)).rejects.toMatchObject({
        kind: 'limit',
        budget: 'lcovBytes',
      });
      expect(second.budget.counters.lcovBytes).toBe(0);
    } finally {
      await removeProject(root);
    }
  });

  it('accumulates across reads without resetting the shared counter', async () => {
    const root = await createProject();
    try {
      const first = await writeProjectFile(root, 'a.info', 'x'.repeat(40));
      const second = await writeProjectFile(root, 'b.info', 'x'.repeat(40));
      const context = makeReadContext(root, testLimits({ maxLcovBytes: 64 }));
      await readCoverageFile(context, first);
      await expect(readCoverageFile(context, second)).rejects.toMatchObject({
        kind: 'limit',
        budget: 'lcovBytes',
      });
      expect(context.budget.counters.lcovBytes).toBe(40);
    } finally {
      await removeProject(root);
    }
  });

  it('refuses to tighten the lcov limit below consumed bytes and cannot widen it', async () => {
    const root = await createProject();
    try {
      const path = await writeProjectFile(root, 'a.info', 'x'.repeat(40));
      const limits = testLimits({ maxLcovBytes: 100 });
      const context = makeReadContext(root, limits);
      await readCoverageFile(context, path);
      expect(() => context.budget.tightenLimits({ ...limits, maxLcovBytes: 39 })).toThrow(
        expect.objectContaining({ kind: 'limit' }),
      );
      context.budget.tightenLimits({ ...limits, maxLcovBytes: 40 });
      expect(context.budget.counters.lcovBytes).toBe(40);
      expect(context.budget.lcovByteAllowance()).toBe(0);
      expect(() => context.budget.tightenLimits({ ...limits, maxLcovBytes: 101 })).toThrow(
        TypeError,
      );
    } finally {
      await removeProject(root);
    }
  });

  it('is not confined by the selected Solidity target but is confined by the root', async () => {
    const root = await createProject();
    const outside = await createProject('audit-estimator-outside-');
    try {
      await writeProjectFile(root, 'src/A.sol', 'contract A {}\n');
      const path = await writeProjectFile(root, 'src/lcov.info', 'TN:\n');
      const outsideFile = await writeProjectFile(outside, 'lcov.info', 'TN:\n');
      const pathContext = await safePathContext(root, {
        target: absoluteProjectPath(root, 'src/A.sol'),
      });
      const budget = createDiscoveryBudget(testLimits());
      expect((await readCoverageFile({ pathContext, budget }, path)).byteLength).toBe(4);
      await expect(readCoverageFile({ pathContext, budget }, outsideFile)).rejects.toMatchObject({
        code: 'PATH_BLOCKED',
        reason: 'outside-root',
      });
    } finally {
      await removeProject(root);
      await removeProject(outside);
    }
  });

  it('blocks .git paths', async () => {
    const root = await createProject();
    try {
      const path = await writeProjectFile(root, '.git/lcov.info', 'TN:\n');
      const pathContext = await safePathContext(root);
      const budget = createDiscoveryBudget(testLimits());
      await expect(readCoverageFile({ pathContext, budget }, path)).rejects.toMatchObject({
        code: 'PATH_BLOCKED',
        reason: 'hard-excluded',
      });
    } finally {
      await removeProject(root);
    }
  });

  it('rejects symlinks even when source symlinks are followed, and directories', async (testContext) => {
    const root = await createProject();
    try {
      const real = await writeProjectFile(root, 'real.info', 'TN:\n');
      try {
        await symlink(real, absoluteProjectPath(root, 'link.info'));
      } catch {
        testContext.skip('symbolic links are not available on this host');
      }
      const pathContext = await safePathContext(root, { followSymlinks: true });
      const budget = createDiscoveryBudget(testLimits());
      await expect(
        readCoverageFile({ pathContext, budget }, absoluteProjectPath(root, 'link.info')),
      ).rejects.toMatchObject({ code: 'PATH_BLOCKED', reason: 'symlink' });
      await expect(
        readCoverageFile({ pathContext, budget }, absoluteProjectPath(root, '.')),
      ).rejects.toMatchObject({ code: 'PATH_BLOCKED', reason: 'special-file' });
      expect(budget.counters.lcovBytes).toBe(0);
    } finally {
      await removeProject(root);
    }
  });

  it('honors cancellation, charging returned bytes and closing the handle', async () => {
    const root = await createProject();
    try {
      const path = await writeProjectFile(root, 'a.info', 'TN:\n');
      const controller = new AbortController();
      let closeCalls = 0;
      const context = makeReadContext(root, testLimits(), {
        signal: controller.signal,
        adapter: forwardingAdapter(
          undefined,
          async () => {
            controller.abort();
          },
          () => {
            closeCalls += 1;
          },
        ),
      });
      await expect(readCoverageFile(context, path)).rejects.toMatchObject({ kind: 'cancelled' });
      expect(closeCalls).toBe(1);
      expect(context.budget.counters.lcovBytes).toBeGreaterThan(0);
      expect(context.budget.counters.sourceBytes).toBe(0);

      const preAborted = new AbortController();
      preAborted.abort();
      const pre = makeReadContext(root, testLimits(), { signal: preAborted.signal });
      await expect(readCoverageFile(pre, path)).rejects.toMatchObject({ kind: 'cancelled' });
      expect(pre.budget.counters.lcovBytes).toBe(0);
    } finally {
      await removeProject(root);
    }
  });

  it('honors an elapsed deadline during I/O', async () => {
    const root = await createProject();
    try {
      const path = await writeProjectFile(root, 'a.info', 'TN:\n');
      let closeCalls = 0;
      const controlledBudget: { value: ReturnType<typeof createDiscoveryBudget> | undefined } = {
        value: undefined,
      };
      const context = makeReadContext(root, testLimits(), {
        adapter: forwardingAdapter(
          undefined,
          async () => {
            const budget = controlledBudget.value;
            if (budget === undefined) throw new Error('Read boundary was not armed.');
            budget.tightenDeadline(performance.now() + 5);
            await delay(25);
          },
          () => {
            closeCalls += 1;
          },
        ),
      });
      controlledBudget.value = context.budget;
      await expect(readCoverageFile(context, path)).rejects.toMatchObject({ kind: 'deadline' });
      expect(context.budget.counters.lcovBytes).toBeGreaterThan(0);
      expect(closeCalls).toBe(1);
    } finally {
      await removeProject(root);
    }
  });

  it('closes the descriptor when the file changes after open', async () => {
    const root = await createProject();
    try {
      const path = await writeProjectFile(root, 'a.info', 'TN:\n');
      let closeCalls = 0;
      const context = makeReadContext(root, testLimits(), {
        adapter: forwardingAdapter(
          async (openedPath) => {
            await writeFile(openedPath, 'TN:\nTN:\n');
          },
          undefined,
          () => {
            closeCalls += 1;
          },
        ),
      });
      await expect(readCoverageFile(context, path)).rejects.toMatchObject({
        code: 'SOURCE_CHANGED',
      });
      expect(closeCalls).toBe(1);
    } finally {
      await removeProject(root);
    }
  });
});
