import { opendir as nodeOpendir } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { fileIdentity } from '../domain/canonical.ts';
import { DEFAULT_EXCLUSION_PATTERNS } from '../config/defaults.ts';
import type { Diagnostic, FileScopeEntry, ScopeManifest } from '../domain/types.ts';
import { BudgetError } from './budget.ts';
import {
  classifyOwnershipBounded,
  classifyOwnership,
  diagnostic,
  emptyScopeManifest,
  selectSourceRoots,
  type AliasObservation,
  type CandidateObservation,
  type DiscoveryDirectoryAdapter,
  type DiscoveryDirectoryEntry,
  type DiscoveryInput,
  type DiscoveryResult,
  type PrunedDirectoryObservation,
  type RuleObservation,
} from './scope.ts';
import { findMatchingPattern, findPrunablePattern, compilePatternList } from './patterns.ts';
import { readSource, SafeReadError } from './safe-read.ts';
import { isPathInside, resolveSafePath, SafePathError, type SafePath } from './safe-path.ts';

const DIRECTORY_BUFFER_SIZE = 32;

const defaultDirectoryAdapter: DiscoveryDirectoryAdapter = {
  opendir: async (path, options) => nodeOpendir(path, options),
};

interface DirectoryWork {
  readonly lexicalPath: string;
  readonly physicalRelativePath: string;
  readonly depth: number;
  readonly ancestry: ReadonlySet<string>;
}

interface SourceAlias {
  readonly path: string;
  readonly lexicalPath: string;
  readonly physicalPath: string;
  readonly identityKey: string;
  readonly selected: boolean;
  readonly excluded: boolean;
  readonly selectionRule: string;
  readonly lexicalExclusionRule: string | null;
  readonly physicalExclusionRule: string | null;
}

interface SourceGroup {
  readonly identityKey: string;
  readonly aliases: SourceAlias[];
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (scalar) => scalar.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (scalar) => scalar.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const a = leftPoints[index] ?? 0;
    const b = rightPoints[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return leftPoints.length < rightPoints.length
    ? -1
    : leftPoints.length > rightPoints.length
      ? 1
      : 0;
}

function projectAbsolute(root: string, projectPath: string): string {
  return projectPath === '.' ? root : join(root, ...projectPath.split('/'));
}

function segments(path: string): number {
  return path === '.' || path.length === 0 ? 0 : path.split('/').length;
}

function insideProjectPath(path: string, root: string): boolean {
  return root === '.' || path === root || path.startsWith(`${root}/`);
}

async function metadataExclusion(path: string, input: DiscoveryInput): Promise<string | null> {
  if (!input.config.scope.defaultExcludes) return null;
  await input.budget.checkpoint();
  const known = [
    input.metadata.paths.test,
    input.metadata.paths.script,
    input.metadata.paths.out,
  ].filter((value): value is string => value !== null);
  const match = known.find((root) => insideProjectPath(path, root));
  return match === undefined ? null : `metadata-path:${match}`;
}

function includesDefaultExclusions(input: DiscoveryInput): boolean {
  return input.config.scope.defaultExcludes;
}

function details(
  path: string,
  reason: string,
): readonly { readonly key: string; readonly value: string }[] {
  return [
    { key: 'path', value: path },
    { key: 'reason', value: reason },
  ];
}

function addDiagnostic(
  diagnostics: Diagnostic[],
  code: Diagnostic['code'],
  severity: Diagnostic['severity'],
  message: string,
  path?: string,
  reason?: string,
): void {
  diagnostics.push(
    diagnostic(
      code,
      severity,
      message,
      path === undefined || reason === undefined ? undefined : details(path, reason),
    ),
  );
}

async function readDirectoryEntries(
  adapter: DiscoveryDirectoryAdapter,
  path: string,
  input: DiscoveryInput,
): Promise<readonly DiscoveryDirectoryEntry[]> {
  const handle = await adapter.opendir(path, { bufferSize: DIRECTORY_BUFFER_SIZE });
  const entries: DiscoveryDirectoryEntry[] = [];
  try {
    for (;;) {
      await input.budget.checkpoint();
      const entry = await handle.read();
      if (entry === null) break;
      // chargeFilesystemEntry increments before propagating abort/deadline, preserving the
      // fact that the OS already returned this entry.
      input.budget.chargeFilesystemEntry();
      entries.push(entry);
    }
  } catch (error: unknown) {
    try {
      await handle.close();
    } catch {
      // Preserve the original bounded-read or budget failure.
    }
    throw error;
  }
  await handle.close();
  return entries.sort((left, right) => compareCodePoints(left.name, right.name));
}

function makeManifest(entries: readonly FileScopeEntry[]): ScopeManifest {
  const ordered = [...entries].sort((left, right) => compareCodePoints(left.path, right.path));
  return {
    entries: ordered,
    scopedFileIds: ordered.filter((entry) => entry.role === 'scoped').map((entry) => entry.fileId),
    contextFileIds: ordered
      .filter((entry) => entry.role === 'context')
      .map((entry) => entry.fileId),
    excludedFileIds: ordered
      .filter((entry) => entry.role === 'excluded')
      .map((entry) => entry.fileId),
  };
}

function sortCandidates(items: readonly CandidateObservation[]): CandidateObservation[] {
  return [...items].sort(
    (left, right) =>
      compareCodePoints(left.path, right.path) || compareCodePoints(left.reason, right.reason),
  );
}

function safePathFailure(error: unknown): {
  readonly code: 'PATH_BLOCKED' | 'TARGET_UNREADABLE' | 'SOURCE_CHANGED';
  readonly reason: string;
} {
  if (error instanceof SafePathError) return { code: error.code, reason: error.reason };
  if (error instanceof SafeReadError) return { code: error.code, reason: error.reason };
  return { code: 'TARGET_UNREADABLE', reason: 'unreadable' };
}

/** Deterministically discovers selected Solidity sources without executing target content. */
export async function discoverScope(input: DiscoveryInput): Promise<DiscoveryResult> {
  input.budget.assertLimitsMatch(input.config.analysis.limits);
  const diagnostics: Diagnostic[] = [...input.metadata.diagnostics];
  const candidates: CandidateObservation[] = [];
  const prunedDirectories: PrunedDirectoryObservation[] = [];
  const aliases: AliasObservation[] = [];
  const rules: RuleObservation[] = [];
  const testDirectories: { path: string; present: boolean }[] = [];
  const groups = new Map<string, SourceGroup>();
  const entries: FileScopeEntry[] = [];
  const snapshots: DiscoveryResult['snapshots'][number][] = [];
  let complete = input.metadata.valid;
  let stopped = false;
  let selectedBases: readonly string[] = [];
  let rootSource = 'default';
  const context = {
    root: input.root,
    lexicalRoot: input.lexicalRoot,
    target: input.target.physicalPath,
    lexicalTarget: input.lexicalTarget,
    followSymlinks: input.config.scope.followSymlinks,
    budget: input.budget,
  };

  const limits = input.config.analysis.limits;
  const includes = compilePatternList(input.config.scope.include, {
    maxPatternsPerList: limits.maxPatternsPerList,
    maxPatternLength: limits.maxPatternLength,
  });
  const excludes = compilePatternList(input.config.scope.exclude, {
    maxPatternsPerList: limits.maxPatternsPerList,
    maxPatternLength: limits.maxPatternLength,
  });
  const defaultExcludes = includesDefaultExclusions(input)
    ? compilePatternList(DEFAULT_EXCLUSION_PATTERNS, {
        maxPatternsPerList: DEFAULT_EXCLUSION_PATTERNS.length,
        maxPatternLength: limits.maxPatternLength,
      })
    : null;

  const isExcluded = async (
    path: string,
  ): Promise<{ readonly rule: string | null; readonly prune: boolean }> => {
    const metadataRule = await metadataExclusion(path, input);
    if (metadataRule !== null) return { rule: metadataRule, prune: true };
    const configuredMatch = await findMatchingPattern(path, excludes, input.budget);
    if (configuredMatch !== null) {
      const pattern = input.config.scope.exclude[configuredMatch];
      return {
        rule: `config-exclude:${pattern ?? ''}`,
        prune: pattern === '**' || (pattern?.endsWith('/**') ?? false),
      };
    }
    if (defaultExcludes !== null) {
      const defaultMatch = await findMatchingPattern(path, defaultExcludes, input.budget);
      if (defaultMatch !== null) {
        const pattern = DEFAULT_EXCLUSION_PATTERNS[defaultMatch];
        return {
          rule: `default-exclude:${pattern ?? ''}`,
          prune: pattern === '**' || (pattern?.endsWith('/**') ?? false),
        };
      }
    }
    return { rule: null, prune: false };
  };

  const findPruneRule = async (path: string): Promise<string | null> => {
    const metadataRule = await metadataExclusion(path, input);
    if (metadataRule !== null) return metadataRule;
    const configured = await findPrunablePattern(path, excludes, input.budget);
    if (configured !== null)
      return `config-exclude:${input.config.scope.exclude[configured] ?? ''}`;
    if (defaultExcludes !== null) {
      const builtin = await findPrunablePattern(path, defaultExcludes, input.budget);
      if (builtin !== null) return `default-exclude:${DEFAULT_EXCLUSION_PATTERNS[builtin] ?? ''}`;
    }
    return null;
  };

  const selectionFor = async (
    physical: string,
    lexical: string,
  ): Promise<{ readonly selected: boolean; readonly rule: string }> => {
    if (input.target.kind === 'file') return { selected: true, rule: 'literal-file' };
    if (input.config.scope.include.length > 0) {
      const physicalIndex = await findMatchingPattern(physical, includes, input.budget);
      if (physicalIndex !== null) {
        return {
          selected: true,
          rule: `include[${physicalIndex}]:${input.config.scope.include[physicalIndex] ?? ''}:physical`,
        };
      }
      const lexicalIndex = await findMatchingPattern(lexical, includes, input.budget);
      if (lexicalIndex !== null) {
        return {
          selected: true,
          rule: `include[${lexicalIndex}]:${input.config.scope.include[lexicalIndex] ?? ''}:lexical`,
        };
      }
      return { selected: false, rule: 'include:no-match' };
    }
    const root = selectedBases.find(
      (candidate) =>
        insideProjectPath(physical, candidate) || insideProjectPath(lexical, candidate),
    );
    return root === undefined
      ? { selected: false, rule: 'source-root:no-match' }
      : { selected: true, rule: `source-root:${rootSource}:${root}` };
  };

  const observeCandidate = (
    safePath: SafePath,
    path: string,
    selection: { readonly selected: boolean; readonly rule: string },
    lexicalExclusionRule: string | null,
    physicalExclusionRule: string | null,
  ): void => {
    const group = groups.get(safePath.identityKey) ?? {
      identityKey: safePath.identityKey,
      aliases: [],
    };
    group.aliases.push({
      path,
      lexicalPath: safePath.lexicalRelativePath,
      physicalPath: safePath.physicalRelativePath,
      identityKey: safePath.identityKey,
      selected: selection.selected,
      excluded: lexicalExclusionRule !== null || physicalExclusionRule !== null,
      selectionRule: selection.rule,
      lexicalExclusionRule,
      physicalExclusionRule,
    });
    groups.set(safePath.identityKey, group);
    input.identities.observe(safePath);
  };

  let rootDecision;
  try {
    rootDecision = await selectSourceRoots({
      pathContext: context,
      target: input.target,
      scope: input.config.scope,
      config: input.config,
      budget: input.budget,
    });
  } catch (error: unknown) {
    complete = false;
    stopped = true;
    const reason = error instanceof BudgetError ? error.kind : 'root-selection-failed';
    addDiagnostic(
      diagnostics,
      error instanceof BudgetError ? 'LIMIT_EXCEEDED' : 'TARGET_UNREADABLE',
      'error',
      'Source roots could not be selected safely.',
      '.',
      reason,
    );
    rootDecision = {
      mode: 'target' as const,
      candidateBasePaths: [],
      configuredRootSource: 'default' as const,
      targetMismatch: false,
      issues: [],
    };
  }
  for (const issue of rootDecision.issues) {
    complete = false;
    addDiagnostic(
      diagnostics,
      issue.code,
      'warning',
      'A configured source root could not be used.',
      issue.path,
      issue.reason,
    );
  }
  selectedBases = rootDecision.candidateBasePaths;
  rootSource = rootDecision.configuredRootSource;
  if (rootDecision.targetMismatch) {
    complete = false;
    addDiagnostic(
      diagnostics,
      'TARGET_UNREADABLE',
      'warning',
      'Selected source roots do not intersect the target.',
      '.',
      'target-mismatch',
    );
  }

  for (const testPath of [
    input.metadata.paths.test ?? 'test',
    ...(input.metadata.paths.test === null ? ['tests'] : []),
  ]) {
    try {
      const projectContext = {
        root: input.root,
        lexicalRoot: input.lexicalRoot,
        followSymlinks: input.config.scope.followSymlinks,
        budget: input.budget,
      };
      const safe = await resolveSafePath(
        projectContext,
        projectAbsolute(input.lexicalRoot, testPath),
      );
      testDirectories.push({ path: safe.physicalRelativePath, present: safe.kind === 'directory' });
    } catch (error: unknown) {
      if (error instanceof BudgetError) {
        complete = false;
        stopped = true;
        addDiagnostic(
          diagnostics,
          'LIMIT_EXCEEDED',
          'error',
          'Discovery stopped at an analysis limit.',
          testPath,
          error.kind,
        );
        break;
      }
      testDirectories.push({ path: testPath, present: false });
    }
  }

  if (input.target.kind === 'file' && extname(input.target.lexicalPath) !== '.sol') {
    complete = false;
    addDiagnostic(
      diagnostics,
      'TARGET_UNREADABLE',
      'warning',
      'The literal target is not a Solidity source file.',
      input.target.lexicalRelativePath,
      'not-solidity',
    );
    candidates.push({
      path: input.target.lexicalRelativePath,
      reason: 'not-solidity',
      ownership: null,
      rule: 'literal-target',
      physicalIdentity: null,
    });
  } else if (!stopped) {
    const work: DirectoryWork[] = [];
    if (input.target.kind === 'file') {
      work.push({
        lexicalPath: input.lexicalTarget,
        physicalRelativePath: input.target.physicalRelativePath,
        depth: 0,
        ancestry: new Set<string>(),
      });
    } else {
      const targetAbsolute = input.target.physicalPath;
      for (const selectedRoot of [...rootDecision.candidateBasePaths].reverse()) {
        const selectedAbsolute = projectAbsolute(input.root, selectedRoot);
        if (!isPathInside(targetAbsolute, selectedAbsolute)) continue;
        const childRelative = relative(targetAbsolute, selectedAbsolute);
        const lexicalPath =
          childRelative === '' ? input.lexicalTarget : join(input.lexicalTarget, childRelative);
        const depth = segments(childRelative === '' ? '.' : childRelative.split(sep).join('/'));
        if (depth > limits.maxDirectoryDepth) {
          complete = false;
          stopped = true;
          prunedDirectories.push({
            path: selectedRoot,
            rule: 'max-directory-depth',
            descendants: 'not-enumerated',
          });
          addDiagnostic(
            diagnostics,
            'LIMIT_EXCEEDED',
            'error',
            'Discovery stopped at the directory depth limit.',
            selectedRoot,
            'max-directory-depth',
          );
          continue;
        }
        work.push({
          lexicalPath,
          physicalRelativePath: selectedRoot,
          depth,
          ancestry: new Set<string>(),
        });
      }
    }

    const directoryAdapter = input.directoryAdapter ?? defaultDirectoryAdapter;
    try {
      while (work.length > 0 && !stopped) {
        const directory = work.pop();
        if (directory === undefined) break;
        input.budget.check();
        let safeDirectory: SafePath;
        try {
          safeDirectory = await resolveSafePath(context, directory.lexicalPath);
        } catch (error: unknown) {
          if (error instanceof BudgetError) throw error;
          const failure = safePathFailure(error);
          complete = false;
          addDiagnostic(
            diagnostics,
            failure.code,
            'warning',
            'A source directory could not be inspected safely.',
            directory.physicalRelativePath,
            failure.reason,
          );
          prunedDirectories.push({
            path: directory.physicalRelativePath,
            rule: failure.reason,
            descendants: 'not-enumerated',
          });
          continue;
        }
        if (safeDirectory.kind !== 'directory') {
          const path = safeDirectory.physicalRelativePath;
          if (
            input.target.kind === 'file' &&
            safeDirectory.kind === 'file' &&
            extname(path) === '.sol'
          ) {
            const lexicalExclusion = await isExcluded(safeDirectory.lexicalRelativePath);
            const physicalExclusion = await isExcluded(safeDirectory.physicalRelativePath);
            const selection = await selectionFor(
              safeDirectory.physicalRelativePath,
              safeDirectory.lexicalRelativePath,
            );
            observeCandidate(
              safeDirectory,
              path,
              selection,
              lexicalExclusion.rule,
              physicalExclusion.rule,
            );
          } else if (safeDirectory.kind !== 'file') {
            complete = false;
            addDiagnostic(
              diagnostics,
              'PATH_BLOCKED',
              'warning',
              'A selected path is not a regular file.',
              path,
              'special-file',
            );
          }
          continue;
        }

        const ownPruneRule =
          (await findPruneRule(safeDirectory.physicalRelativePath)) ??
          (await findPruneRule(safeDirectory.lexicalRelativePath));
        if (ownPruneRule !== null) {
          prunedDirectories.push({
            path: safeDirectory.physicalRelativePath,
            rule: ownPruneRule,
            descendants: 'not-enumerated',
          });
          rules.push({
            path: safeDirectory.physicalRelativePath,
            rule: ownPruneRule,
            source: ownPruneRule.startsWith('metadata-')
              ? 'metadata'
              : ownPruneRule.startsWith('default-')
                ? 'default'
                : 'config',
          });
          continue;
        }
        if (directory.ancestry.has(safeDirectory.identityKey)) {
          prunedDirectories.push({
            path: safeDirectory.physicalRelativePath,
            rule: 'directory-cycle',
            descendants: 'not-enumerated',
          });
          continue;
        }

        let entries: readonly DiscoveryDirectoryEntry[];
        try {
          entries = await readDirectoryEntries(directoryAdapter, safeDirectory.physicalPath, input);
        } catch (error: unknown) {
          if (error instanceof BudgetError) throw error;
          complete = false;
          const failure = safePathFailure(error);
          addDiagnostic(
            diagnostics,
            failure.code,
            'warning',
            'A source directory could not be read completely.',
            safeDirectory.physicalRelativePath,
            failure.reason,
          );
          continue;
        }

        const ancestry = new Set(directory.ancestry);
        ancestry.add(safeDirectory.identityKey);
        const childDirectories: DirectoryWork[] = [];
        for (const entry of entries) {
          await input.budget.checkpoint();
          const lexicalChild = join(safeDirectory.lexicalPath, entry.name);
          const lexicalRelative = relative(input.lexicalRoot, lexicalChild).split(sep).join('/');
          if (sep === '/' && entry.name.includes('\\')) {
            complete = false;
            candidates.push({
              path: lexicalRelative,
              reason: 'unsafe',
              ownership: null,
              rule: 'unrepresentable-path-name',
              physicalIdentity: null,
            });
            addDiagnostic(
              diagnostics,
              'PATH_BLOCKED',
              'warning',
              'A path name cannot be represented safely.',
              lexicalRelative,
              'invalid-name',
            );
            continue;
          }

          let safe: SafePath;
          try {
            safe = await resolveSafePath(context, lexicalChild);
          } catch (error: unknown) {
            if (error instanceof BudgetError) throw error;
            const failure = safePathFailure(error);
            if (failure.reason === 'hard-excluded') {
              if (entry.isDirectory()) {
                prunedDirectories.push({
                  path: lexicalRelative,
                  rule: 'hard-exclusion:.git',
                  descendants: 'not-enumerated',
                });
              }
              continue;
            }
            const likelySource =
              entry.name.endsWith('.sol') || entry.isDirectory() || entry.isSymbolicLink();
            if (likelySource) {
              complete = false;
              candidates.push({
                path: lexicalRelative,
                reason: 'unsafe',
                ownership: null,
                rule: failure.reason,
                physicalIdentity: null,
              });
              addDiagnostic(
                diagnostics,
                failure.code,
                'warning',
                'A selected path could not be inspected safely.',
                lexicalRelative,
                failure.reason,
              );
            }
            continue;
          }

          const physical = safe.physicalRelativePath;
          if (safe.kind === 'directory') {
            const observedDirectory = input.identities.observe(safe);
            const lexicalExclusion = await isExcluded(safe.lexicalRelativePath);
            const physicalExclusion = await isExcluded(physical);
            const exclusion = lexicalExclusion.rule === null ? physicalExclusion : lexicalExclusion;
            const pruneRule =
              (await findPruneRule(safe.lexicalRelativePath)) ?? (await findPruneRule(physical));
            if (pruneRule !== null) {
              prunedDirectories.push({
                path: physical,
                rule: pruneRule,
                descendants: 'not-enumerated',
              });
              rules.push({
                path: physical,
                rule: pruneRule,
                source: pruneRule.startsWith('metadata-')
                  ? 'metadata'
                  : pruneRule.startsWith('default-')
                    ? 'default'
                    : 'config',
              });
              continue;
            }
            if (ancestry.has(observedDirectory.identityKey)) {
              prunedDirectories.push({
                path: physical,
                rule: 'directory-cycle',
                descendants: 'not-enumerated',
              });
              continue;
            }
            const childDepth = directory.depth + 1;
            if (childDepth > limits.maxDirectoryDepth) {
              complete = false;
              stopped = true;
              prunedDirectories.push({
                path: physical,
                rule: 'max-directory-depth',
                descendants: 'not-enumerated',
              });
              addDiagnostic(
                diagnostics,
                'LIMIT_EXCEEDED',
                'error',
                'Discovery stopped at the directory depth limit.',
                physical,
                'max-directory-depth',
              );
              break;
            }
            if (exclusion.rule !== null) {
              rules.push({
                path: physical,
                rule: exclusion.rule,
                source: exclusion.rule.startsWith('default-')
                  ? 'default'
                  : exclusion.rule.startsWith('metadata-')
                    ? 'metadata'
                    : 'config',
              });
            }
            childDirectories.push({
              lexicalPath: lexicalChild,
              physicalRelativePath: physical,
              depth: childDepth,
              ancestry,
            });
            continue;
          }

          if (safe.kind !== 'file' || (!entry.isFile() && !safe.followedSymlink)) {
            if (entry.name.endsWith('.sol')) {
              complete = false;
              candidates.push({
                path: physical,
                reason: 'unsafe',
                ownership: null,
                rule: 'special-file',
                physicalIdentity: safe.identityKey,
              });
              addDiagnostic(
                diagnostics,
                'PATH_BLOCKED',
                'warning',
                'A selected path is not a regular file.',
                physical,
                'special-file',
              );
            }
            continue;
          }
          if (!entry.name.endsWith('.sol')) continue;

          const selection = await selectionFor(physical, safe.lexicalRelativePath);
          const lexicalExclusion = await isExcluded(safe.lexicalRelativePath);
          const physicalExclusion = await isExcluded(physical);
          const exclusionRule = lexicalExclusion.rule ?? physicalExclusion.rule;
          observeCandidate(
            safe,
            physical,
            selection,
            lexicalExclusion.rule,
            physicalExclusion.rule,
          );
          if (!selection.selected) {
            candidates.push({
              path: physical,
              reason: 'not-selected',
              ownership: null,
              rule: 'include-list',
              physicalIdentity: safe.identityKey,
            });
          } else if (exclusionRule !== null) {
            rules.push({
              path: physical,
              rule: exclusionRule,
              source: exclusionRule.startsWith('default-')
                ? 'default'
                : exclusionRule.startsWith('metadata-')
                  ? 'metadata'
                  : 'config',
            });
          }
        }
        for (const child of childDirectories.reverse()) work.push(child);
      }
    } catch (error: unknown) {
      complete = false;
      stopped = true;
      const reason =
        error instanceof BudgetError ? (error.budget ?? error.kind) : 'traversal-failed';
      addDiagnostic(
        diagnostics,
        error instanceof BudgetError ? 'LIMIT_EXCEEDED' : 'TARGET_UNREADABLE',
        'error',
        'Discovery stopped before the selected tree was complete.',
        '.',
        reason,
      );
    }
  }

  if (!stopped) {
    try {
      for (const group of groups.values()) {
        await input.budget.checkpoint();
        group.aliases.sort(
          (left, right) =>
            compareCodePoints(left.physicalPath, right.physicalPath) ||
            compareCodePoints(left.lexicalPath, right.lexicalPath),
        );
        const registry = input.identities.get(group.identityKey);
        if (registry === undefined) continue;
        const ownership = await classifyOwnershipBounded(
          (function* () {
            yield* registry.physicalPaths;
            yield* registry.lexicalAliases;
          })(),
          input.config.scope,
          input.metadata.paths,
          input.budget,
        );
        const selectedAliases: SourceAlias[] = [];
        const eligibleAliases: SourceAlias[] = [];
        for (const alias of group.aliases) {
          await input.budget.checkpoint();
          if (!alias.selected) continue;
          selectedAliases.push(alias);
          if (!alias.excluded) eligibleAliases.push(alias);
        }
        const selected = selectedAliases.length > 0;
        const eligible = eligibleAliases.length > 0;
        const pathDecisions: AliasObservation['pathDecisions'][number][] = [];
        for (const alias of group.aliases) {
          await input.budget.checkpoint();
          const aliasOwnership = classifyOwnership(
            [alias.physicalPath, alias.lexicalPath],
            input.config.scope,
            input.metadata.paths,
          );
          pathDecisions.push({
            lexicalPath: alias.lexicalPath,
            physicalPath: alias.physicalPath,
            selected: alias.selected,
            selectionRule: alias.selectionRule,
            lexicalExclusionRule: alias.lexicalExclusionRule,
            physicalExclusionRule: alias.physicalExclusionRule,
            ownership: aliasOwnership.ownership,
            ownershipRule: aliasOwnership.rule,
          });
        }
        aliases.push({
          identityKey: group.identityKey,
          representativePath: registry.representativePath,
          physicalPaths: registry.physicalPaths,
          lexicalAliases: registry.lexicalAliases,
          ownership: ownership.ownership,
          rule: ownership.rule,
          pathDecisions,
        });
        for (let aliasIndex = 0; aliasIndex < group.aliases.length; aliasIndex += 1) {
          await input.budget.checkpoint();
          const alias = group.aliases[aliasIndex];
          const decision = pathDecisions[aliasIndex];
          if (alias === undefined || decision === undefined) continue;
          if (alias.excluded) {
            candidates.push({
              path: alias.lexicalPath,
              reason: 'excluded',
              ownership: decision?.ownership ?? ownership.ownership,
              rule: alias.lexicalExclusionRule ?? alias.physicalExclusionRule ?? 'excluded',
              physicalIdentity: group.identityKey,
            });
          }
          if (alias.selected) {
            rules.push({
              path: alias.lexicalPath,
              rule: alias.selectionRule,
              source: alias.selectionRule.startsWith('literal-')
                ? 'target'
                : alias.selectionRule.startsWith('include[')
                  ? 'config'
                  : rootSource === 'metadata'
                    ? 'metadata'
                    : rootSource === 'default'
                      ? 'default'
                      : 'config',
            });
          }
          rules.push({
            path: alias.lexicalPath,
            rule: decision?.ownershipRule ?? ownership.rule,
            source: 'ownership',
          });
        }
        if (!selected) continue;
        if (!eligible) continue;
        if (ownership.ownership === 'third-party') {
          for (const alias of eligibleAliases) {
            await input.budget.checkpoint();
            candidates.push({
              path: alias.lexicalPath,
              reason: 'third-party',
              ownership: 'third-party',
              rule: ownership.rule,
              physicalIdentity: group.identityKey,
            });
          }
          addDiagnostic(
            diagnostics,
            'OWNERSHIP_UNKNOWN',
            'info',
            'Selected source is a known dependency; add a first-party override to include it.',
            registry.representativePath,
            ownership.rule,
          );
          continue;
        }
        if (ownership.ownership === 'unknown') {
          complete = false;
          for (const alias of eligibleAliases) {
            await input.budget.checkpoint();
            candidates.push({
              path: alias.lexicalPath,
              reason: 'unknown-ownership',
              ownership: 'unknown',
              rule: ownership.rule,
              physicalIdentity: group.identityKey,
            });
          }
          addDiagnostic(
            diagnostics,
            'OWNERSHIP_UNKNOWN',
            'warning',
            'Selected source ownership is ambiguous; add a first-party override to include it.',
            registry.representativePath,
            ownership.rule,
          );
          continue;
        }

        const frozenIdentity = input.identities.freeze(group.identityKey);
        const selectedAlias = eligibleAliases[0];
        if (selectedAlias === undefined) continue;
        try {
          const snapshot = await readSource(
            {
              pathContext: context,
              budget: input.budget,
              identities: input.identities,
              ...(input.readAdapter === undefined ? {} : { adapter: input.readAdapter }),
            },
            selectedAlias.lexicalPath,
          );
          const representative = frozenIdentity?.representativePath ?? snapshot.canonicalPath;
          const id = fileIdentity(representative);
          entries.push({
            fileId: id,
            path: representative,
            role: 'scoped',
            ownership: 'first-party',
            ownershipEvidence: [],
            physicalIdentity: representative,
            byteHash: snapshot.byteHash,
          });
          snapshots.push(snapshot);
        } catch (error: unknown) {
          complete = false;
          if (error instanceof BudgetError) {
            stopped = true;
            addDiagnostic(
              diagnostics,
              'LIMIT_EXCEEDED',
              'error',
              'Discovery stopped at an analysis limit.',
              registry.representativePath,
              error.budget ?? error.kind,
            );
            break;
          }
          const failure = safePathFailure(error);
          candidates.push({
            path: registry.representativePath,
            reason: 'read-failed',
            ownership: 'first-party',
            rule: failure.reason,
            physicalIdentity: group.identityKey,
          });
          addDiagnostic(
            diagnostics,
            failure.code,
            'warning',
            'A selected source could not be read safely.',
            registry.representativePath,
            failure.reason,
          );
        }
      }
    } catch (error: unknown) {
      if (!(error instanceof BudgetError)) throw error;
      complete = false;
      stopped = true;
      addDiagnostic(
        diagnostics,
        'LIMIT_EXCEEDED',
        'error',
        'Discovery stopped while finalizing observed file identities.',
        '.',
        error.budget ?? error.kind,
      );
    }
  }

  if (input.budget.counters.failedSourceReads > 0) complete = false;
  if (diagnostics.some((item) => item.code === 'LIMIT_EXCEEDED')) complete = false;
  if (entries.length === 0 && complete) {
    diagnostics.push(
      diagnostic('EMPTY_SCOPE', 'warning', 'No eligible first-party Solidity sources were found.'),
    );
  }
  const sortedDiagnostics = [...diagnostics].sort(
    (left, right) =>
      compareCodePoints(left.code, right.code) ||
      compareCodePoints(
        left.details?.[0]?.value?.toString() ?? '',
        right.details?.[0]?.value?.toString() ?? '',
      ),
  );
  return {
    manifest: entries.length === 0 ? emptyScopeManifest() : makeManifest(entries),
    snapshots: snapshots.sort((left, right) =>
      compareCodePoints(left.canonicalPath, right.canonicalPath),
    ),
    diagnostics: sortedDiagnostics,
    observations: {
      rootDecision,
      candidates: sortCandidates(candidates),
      prunedDirectories: prunedDirectories.sort(
        (left, right) =>
          compareCodePoints(left.path, right.path) || compareCodePoints(left.rule, right.rule),
      ),
      aliases: aliases.sort((left, right) =>
        compareCodePoints(left.representativePath, right.representativePath),
      ),
      rules: rules.sort(
        (left, right) =>
          compareCodePoints(left.path, right.path) || compareCodePoints(left.rule, right.rule),
      ),
      testDirectories: testDirectories.sort((left, right) =>
        compareCodePoints(left.path, right.path),
      ),
      counters: input.budget.counters,
    },
    complete,
  };
}
