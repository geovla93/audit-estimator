import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ProjectMetadataHints } from '../config/merge.ts';
import { fileIdentity } from '../domain/canonical.ts';
import type {
  Diagnostic,
  FileId,
  Ownership,
  ResolvedConfig,
  ScopeManifest,
  ScopeSettings,
  SourceSnapshot,
} from '../domain/types.ts';
import type { BudgetCounters, DiscoveryBudget } from './budget.ts';
import { BudgetError } from './budget.ts';
import type { IdentityRegistry } from './identity.ts';
import type { SafeReadAdapter } from './safe-read.ts';
import {
  isPathInside,
  resolveSafePath,
  SafePathError,
  type SafePath,
  type SafePathContext,
} from './safe-path.ts';

export interface DiscoveryDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface DiscoveryDirectoryHandle {
  read(): Promise<DiscoveryDirectoryEntry | null>;
  close(): Promise<void>;
}

export interface DiscoveryDirectoryAdapter {
  readonly opendir: (
    path: string,
    options: { readonly bufferSize: number },
  ) => Promise<DiscoveryDirectoryHandle>;
}

export interface ProjectMetadataPaths {
  readonly libs: readonly string[];
  readonly test: string | null;
  readonly script: string | null;
  readonly out: string | null;
}

export interface ProjectMetadataObservation {
  readonly path: string;
  readonly status: 'absent' | 'read' | 'invalid' | 'blocked' | 'oversized' | 'unreadable';
  readonly reason: string | null;
}

export interface ProjectMetadataResult {
  readonly hints: ProjectMetadataHints;
  readonly paths: ProjectMetadataPaths;
  readonly observation: ProjectMetadataObservation;
  readonly valid: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface RootDecisionIssue {
  readonly code: 'PATH_BLOCKED' | 'TARGET_UNREADABLE';
  readonly path: string;
  readonly reason: string;
}

export interface SourceRootDecision {
  readonly mode: 'literal-file' | 'include' | 'configured-roots' | 'conventional-roots' | 'target';
  readonly candidateBasePaths: readonly string[];
  readonly configuredRootSource: 'default' | 'metadata' | 'config' | 'cli';
  readonly targetMismatch: boolean;
  readonly issues: readonly RootDecisionIssue[];
}

export interface CandidateObservation {
  readonly path: string;
  readonly reason:
    | 'not-solidity'
    | 'not-selected'
    | 'excluded'
    | 'third-party'
    | 'unknown-ownership'
    | 'unsafe'
    | 'read-failed';
  readonly ownership: Ownership | null;
  readonly rule: string;
  readonly physicalIdentity: string | null;
}

export interface PrunedDirectoryObservation {
  readonly path: string;
  readonly rule: string;
  readonly descendants: 'not-enumerated';
}

export interface AliasObservation {
  readonly identityKey: string;
  readonly representativePath: string;
  readonly physicalPaths: readonly string[];
  readonly lexicalAliases: readonly string[];
  readonly ownership: Ownership;
  readonly rule: string;
  readonly pathDecisions: readonly AliasPathDecision[];
}

export interface AliasPathDecision {
  readonly lexicalPath: string;
  readonly physicalPath: string;
  readonly selected: boolean;
  readonly selectionRule: string;
  readonly lexicalExclusionRule: string | null;
  readonly physicalExclusionRule: string | null;
  readonly ownership: Ownership;
  readonly ownershipRule: string;
}

export interface RuleObservation {
  readonly path: string;
  readonly rule: string;
  readonly source: 'hard-exclusion' | 'default' | 'config' | 'metadata' | 'ownership' | 'target';
}

export interface DiscoveryObservations {
  readonly rootDecision: SourceRootDecision;
  readonly candidates: readonly CandidateObservation[];
  readonly prunedDirectories: readonly PrunedDirectoryObservation[];
  readonly aliases: readonly AliasObservation[];
  readonly rules: readonly RuleObservation[];
  readonly testDirectories: readonly { readonly path: string; readonly present: boolean }[];
  readonly counters: BudgetCounters;
}

export interface DiscoveryResult {
  readonly manifest: ScopeManifest;
  readonly snapshots: readonly SourceSnapshot[];
  readonly diagnostics: readonly Diagnostic[];
  readonly observations: DiscoveryObservations;
  readonly complete: boolean;
}

export interface DiscoveryInput {
  readonly root: string;
  readonly lexicalRoot: string;
  readonly target: SafePath;
  readonly lexicalTarget: string;
  readonly config: ResolvedConfig;
  readonly metadata: ProjectMetadataResult;
  readonly budget: DiscoveryBudget;
  readonly identities: IdentityRegistry;
  readonly directoryAdapter?: DiscoveryDirectoryAdapter | undefined;
  readonly readAdapter?: SafeReadAdapter | undefined;
}

export interface OwnershipDecision {
  readonly ownership: Ownership;
  readonly rule: string;
  readonly conflicted: boolean;
}

export interface IdentityOwnershipReevaluation extends OwnershipDecision {
  readonly identityKey: string;
  readonly representativePath: string;
  readonly invalidatedScopedFileIds: readonly FileId[];
  readonly complete: boolean;
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

function sourceRootProvenance(config: ResolvedConfig): SourceRootDecision['configuredRootSource'] {
  return config.provenance.find((item) => item.field === 'scope.sourceRoots')?.source ?? 'default';
}

function rootPath(lexicalRoot: string, projectPath: string): string {
  if (projectPath === '.') return lexicalRoot;
  return resolve(lexicalRoot, ...projectPath.split('/'));
}

function intersectionPath(left: string, right: string): string | null {
  if (isPathInside(left, right)) return right;
  if (isPathInside(right, left)) return left;
  return null;
}

function physicalProjectPath(root: string, absolutePath: string): string {
  const relativePath = relative(root, absolutePath);
  if (relativePath === '') return '.';
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new SafePathError('PATH_BLOCKED', 'outside-root');
  }
  return relativePath.split(/[\\/]+/u).join('/');
}

/** Resolves configured or conventional roots and intersects them with a directory target. */
export async function selectSourceRoots(options: {
  readonly pathContext: SafePathContext;
  readonly target: SafePath;
  readonly scope: ScopeSettings;
  readonly config: ResolvedConfig;
  readonly budget: DiscoveryBudget;
}): Promise<SourceRootDecision> {
  const { target, scope, config, budget } = options;
  const pathContext: SafePathContext = {
    root: options.pathContext.root,
    lexicalRoot: options.pathContext.lexicalRoot,
    followSymlinks: options.pathContext.followSymlinks,
    budget,
  };
  const configuredRootSource = sourceRootProvenance(config);
  const targetRelative = target.physicalRelativePath;
  if (target.kind === 'file') {
    return {
      mode: 'literal-file',
      candidateBasePaths: [targetRelative],
      configuredRootSource,
      targetMismatch: false,
      issues: [],
    };
  }
  if (scope.include.length > 0) {
    return {
      mode: 'include',
      candidateBasePaths: [targetRelative],
      configuredRootSource,
      targetMismatch: false,
      issues: [],
    };
  }

  const issues: RootDecisionIssue[] = [];
  let roots: { readonly path: string; readonly physical: string }[] = [];
  let mode: SourceRootDecision['mode'] = 'configured-roots';
  if (scope.sourceRoots.length > 0) {
    for (const configured of scope.sourceRoots) {
      budget.check();
      try {
        const safePath = await resolveSafePath(
          pathContext,
          rootPath(pathContext.lexicalRoot, configured),
        );
        if (safePath.kind !== 'directory') {
          issues.push({ code: 'TARGET_UNREADABLE', path: configured, reason: 'not-directory' });
          continue;
        }
        roots.push({ path: safePath.physicalRelativePath, physical: safePath.physicalPath });
      } catch (error: unknown) {
        if (error instanceof BudgetError) throw error;
        const safeError = error instanceof SafePathError ? error : undefined;
        issues.push({
          code: safeError?.code ?? 'TARGET_UNREADABLE',
          path: configured,
          reason: safeError?.reason ?? 'unreadable',
        });
      }
    }
  } else {
    mode = 'conventional-roots';
    for (const conventional of ['src', 'contracts']) {
      budget.check();
      try {
        const safePath = await resolveSafePath(
          pathContext,
          rootPath(pathContext.lexicalRoot, conventional),
        );
        if (safePath.kind === 'directory') {
          roots.push({ path: safePath.physicalRelativePath, physical: safePath.physicalPath });
        }
      } catch (error: unknown) {
        if (error instanceof BudgetError) throw error;
        if (!(error instanceof SafePathError && error.reason === 'missing')) {
          const safeError = error instanceof SafePathError ? error : undefined;
          issues.push({
            code: safeError?.code ?? 'TARGET_UNREADABLE',
            path: conventional,
            reason: safeError?.reason ?? 'unreadable',
          });
        }
      }
    }
  }

  if (roots.length === 0) {
    if (scope.sourceRoots.length > 0) {
      return {
        mode,
        candidateBasePaths: [],
        configuredRootSource,
        targetMismatch: false,
        issues,
      };
    }
    if (mode === 'conventional-roots' && issues.length === 0) {
      return {
        mode: 'target',
        candidateBasePaths: [targetRelative],
        configuredRootSource,
        targetMismatch: false,
        issues,
      };
    }
    return {
      mode,
      candidateBasePaths: [],
      configuredRootSource,
      targetMismatch: false,
      issues,
    };
  }

  const selected = new Set<string>();
  for (const root of roots) {
    const overlap = intersectionPath(root.physical, target.physicalPath);
    if (overlap !== null) selected.add(physicalProjectPath(pathContext.root, overlap));
  }
  const targetMismatch = selected.size === 0;
  return {
    mode,
    candidateBasePaths: [...selected].sort(compareCodePoints),
    configuredRootSource,
    targetMismatch,
    issues,
  };
}

function underRoot(path: string, root: string): boolean {
  return root === '.' || path === root || path.startsWith(`${root}/`);
}

function pathSegments(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function classifyOwnershipPath(
  path: string,
  scope: ScopeSettings,
  metadataPaths: ProjectMetadataPaths,
): { readonly ownership: 'first-party' | 'third-party'; readonly rule: string } {
  const override = scope.firstPartyOverrides.find((root) => underRoot(path, root));
  if (override !== undefined) {
    return { ownership: 'first-party', rule: `first-party-override:${override}` };
  }
  const dependencySegment = pathSegments(path).find((segment) =>
    ['node_modules', 'lib', 'vendor', 'deps'].includes(segment),
  );
  if (dependencySegment !== undefined) {
    return { ownership: 'third-party', rule: `dependency-segment:${dependencySegment}` };
  }
  const dependencyRoot =
    scope.thirdPartyRoots.find((root) => underRoot(path, root)) ??
    metadataPaths.libs.find((root) => underRoot(path, root));
  if (dependencyRoot !== undefined) {
    return { ownership: 'third-party', rule: `third-party-root:${dependencyRoot}` };
  }
  return { ownership: 'first-party', rule: 'ordinary-project-path' };
}

export function classifyOwnership(
  paths: readonly string[],
  scope: ScopeSettings,
  metadataPaths: ProjectMetadataPaths,
): OwnershipDecision {
  const allPaths = [...new Set(paths)];
  const classified = allPaths.map((path) => classifyOwnershipPath(path, scope, metadataPaths));
  const sawFirstParty = classified.some((item) => item.ownership === 'first-party');
  const sawThirdParty = classified.some((item) => item.ownership === 'third-party');
  if (sawFirstParty && sawThirdParty) {
    return { ownership: 'unknown', rule: 'conflicting-alias-ownership', conflicted: true };
  }
  const first = classified[0];
  if (first === undefined)
    return { ownership: 'unknown', rule: 'no-observed-path', conflicted: false };
  return { ownership: first.ownership, rule: first.rule, conflicted: false };
}

export async function classifyOwnershipBounded(
  paths: Iterable<string>,
  scope: ScopeSettings,
  metadataPaths: ProjectMetadataPaths,
  budget: DiscoveryBudget,
): Promise<OwnershipDecision> {
  const seen = new Set<string>();
  let first: ReturnType<typeof classifyOwnershipPath> | undefined;
  let sawFirstParty = false;
  let sawThirdParty = false;
  for (const path of paths) {
    await budget.checkpoint();
    if (seen.has(path)) continue;
    seen.add(path);
    const classified = classifyOwnershipPath(path, scope, metadataPaths);
    first ??= classified;
    sawFirstParty ||= classified.ownership === 'first-party';
    sawThirdParty ||= classified.ownership === 'third-party';
  }
  if (sawFirstParty && sawThirdParty)
    return { ownership: 'unknown', rule: 'conflicting-alias-ownership', conflicted: true };
  return first === undefined
    ? { ownership: 'unknown', rule: 'no-observed-path', conflicted: false }
    : { ...first, conflicted: false };
}

/**
 * Reclassifies all aliases observed after a snapshot was published. A returned invalidated ID
 * keeps its original snapshot identity but must no longer be treated as eligible first-party scope.
 */
export async function reevaluateIdentityOwnership(options: {
  readonly identities: IdentityRegistry;
  readonly identityKey: string;
  readonly scope: ScopeSettings;
  readonly metadataPaths: ProjectMetadataPaths;
  readonly scopedFileIds: readonly FileId[];
  readonly budget: DiscoveryBudget;
}): Promise<IdentityOwnershipReevaluation | null> {
  const identity = options.identities.get(options.identityKey);
  if (identity === undefined) return null;
  const ownership = await classifyOwnershipBounded(
    (function* () {
      yield* identity.physicalPaths;
      yield* identity.lexicalAliases;
    })(),
    options.scope,
    options.metadataPaths,
    options.budget,
  );
  const fileId = identity.snapshot === null ? null : fileIdentity(identity.snapshot.canonicalPath);
  const invalidatedScopedFileIds =
    fileId !== null &&
    ownership.ownership !== 'first-party' &&
    options.scopedFileIds.includes(fileId)
      ? [fileId]
      : [];
  return {
    identityKey: identity.identityKey,
    representativePath: identity.representativePath,
    ...ownership,
    invalidatedScopedFileIds,
    complete: invalidatedScopedFileIds.length === 0,
  };
}

export function isUnderSelectedRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => underRoot(path, root));
}

export function emptyScopeManifest(): ScopeManifest {
  return { entries: [], scopedFileIds: [], contextFileIds: [], excludedFileIds: [] };
}

export function diagnostic(
  code: Diagnostic['code'],
  severity: Diagnostic['severity'],
  message: string,
  details?: Diagnostic['details'],
): Diagnostic {
  return {
    code,
    severity,
    phase: 'discovery',
    message,
    ...(details === undefined ? {} : { details }),
  };
}
