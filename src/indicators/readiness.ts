import { opendir as nodeOpendir } from 'node:fs/promises';
import { join } from 'node:path';
import { BudgetError } from '../discovery/budget.ts';
import type { DiscoveryBudget } from '../discovery/budget.ts';
import type { DiscoveryDirectoryAdapter, ProjectMetadataPaths } from '../discovery/scope.ts';
import { readCoverageFile, SafeReadError } from '../discovery/safe-read.ts';
import type { SafeReadAdapter } from '../discovery/safe-read.ts';
import { resolveSafePath, SafePathError } from '../discovery/safe-path.ts';
import type { SafePath, SafePathContext } from '../discovery/safe-path.ts';
import type {
  Analysis,
  Diagnostic,
  FileId,
  Measurement,
  ResolvedConfig,
  ScopeManifest,
} from '../domain/types.ts';
import { compareCodePoints } from './catalog.ts';
import { parseLcovBatches } from './lcov.ts';
import type { LcovParseResult, LcovRecordStatus, LcovTarget } from './lcov.ts';

/**
 * Bounded, data-only readiness inspection: test-directory presence (filenames only) and one
 * optional LCOV artifact. Nothing here executes target code, opens test bodies or opens paths that
 * a coverage artifact names. Optional failures never rewrite required-analysis completeness.
 */

const DIRECTORY_BUFFER_SIZE = 32;
const PROVENANCE = 'unverified-existing-artifact' as const;
/** Dependency and output trees are never entered, even below a test root. */
const PRUNED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'lib',
  'vendor',
  'deps',
  'out',
  'artifacts',
  'cache',
  'coverage',
  'dist',
  'build',
]);
const TEST_SCRIPT_PATTERN = /\.(?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/u;

const defaultDirectoryAdapter: DiscoveryDirectoryAdapter = {
  opendir: async (path, options) => nodeOpendir(path, options),
};

export interface ScopedPhysicalLines {
  readonly fileId: FileId;
  readonly physicalLines: Measurement<number>;
}

/** A safe alias already observed by discovery or a context read, never searched for here. */
export interface ObservedAlias {
  readonly fileId: FileId;
  /** Root-relative `/` path. */
  readonly path: string;
}

export interface ReadinessInput {
  /** Root-only containment. Any selected-target boundary is ignored for metadata artifacts. */
  readonly pathContext: SafePathContext;
  readonly budget: DiscoveryBudget;
  readonly metadataPaths: ProjectMetadataPaths;
  readonly coverage: ResolvedConfig['coverage'];
  readonly manifest: ScopeManifest;
  readonly physicalLines: readonly ScopedPhysicalLines[];
  readonly aliases: readonly ObservedAlias[];
  readonly directoryAdapter?: DiscoveryDirectoryAdapter | undefined;
  readonly readAdapter?: SafeReadAdapter | undefined;
}

export type TestRootSummary =
  | {
      readonly path: string;
      readonly status: 'directory';
      readonly traversal: 'complete' | 'incomplete';
      /** Exact only when traversal completed; otherwise a lower bound with `exact: null`. */
      readonly testFiles: { readonly exact: number | null; readonly observed: number };
      readonly unrelatedFiles: number;
      readonly emptyDirectories: number;
      readonly directories: number;
      readonly prunedDirectories: number;
      readonly blockedEntries: number;
      readonly stoppedBy: 'limit' | 'depth' | 'read-error' | null;
    }
  | {
      readonly path: string;
      readonly status: 'missing' | 'not-directory' | 'blocked' | 'unreadable' | 'not-representable';
    };

export type CoverageStatus =
  | { readonly kind: 'not-requested' }
  | {
      readonly kind: 'unreadable';
      readonly reason: 'missing' | 'blocked' | 'unreadable' | 'oversized' | 'changed';
    }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'no-matched-source' }
  | { readonly kind: 'matched-subset' };

export type CoverageFileStatus =
  | {
      readonly kind: 'matched';
      readonly path: string;
      readonly fileId: FileId;
      readonly coveredLines: number;
      readonly totalLines: number;
    }
  | { readonly kind: 'context-record'; readonly path: string; readonly fileId: FileId }
  | { readonly kind: 'unmatched-record'; readonly path: string }
  | {
      readonly kind: 'excluded-record';
      readonly path: string;
      readonly fileId: FileId;
      readonly reason: 'line-mismatch' | 'physical-lines-unavailable';
    }
  | { readonly kind: 'absent-from-artifact'; readonly fileId: FileId };

export interface ReadinessResult {
  readonly testObservations: Analysis['testObservations'];
  readonly coverageObservation: Analysis['coverageObservation'];
  readonly testRoots: readonly TestRootSummary[];
  readonly coverageStatus: CoverageStatus;
  readonly coverageFiles: readonly CoverageFileStatus[];
  /** Readiness inspection only; never a statement about required Solidity analysis. */
  readonly complete: boolean;
  readonly provenance: typeof PROVENANCE | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly limitations: readonly string[];
}

function unavailable(reason: string): Measurement<never> {
  return { status: 'unavailable', reason };
}

function diagnostic(
  code: Diagnostic['code'],
  severity: Diagnostic['severity'],
  phase: Diagnostic['phase'],
  message: string,
  details: readonly { readonly key: string; readonly value: string | number }[] = [],
): Diagnostic {
  return { code, severity, phase, message, ...(details.length === 0 ? {} : { details }) };
}

function projectAbsolute(context: SafePathContext, projectPath: string): string {
  return projectPath === '.'
    ? context.lexicalRoot
    : join(context.lexicalRoot, ...projectPath.split('/'));
}

function isTestFileName(name: string): boolean {
  return name.endsWith('.t.sol') || TEST_SCRIPT_PATTERN.test(name);
}

interface TraversalState {
  readonly seenDirectories: Set<string>;
  readonly seenFiles: Set<string>;
  budgetStopped: boolean;
}

async function closeQuietly(handle: { close(): Promise<void> }): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Preserve the original bounded-read or budget failure.
  }
}

async function inspectTestRoot(
  input: ReadinessInput,
  context: SafePathContext,
  projectPath: string,
  state: TraversalState,
  diagnostics: Diagnostic[],
): Promise<TestRootSummary> {
  if (projectPath === '.') return { path: projectPath, status: 'not-representable' };
  const resolve = input.readAdapter?.resolve ?? resolveSafePath;
  const adapter = input.directoryAdapter ?? defaultDirectoryAdapter;
  const budget = input.budget;
  let root: SafePath;
  try {
    root = await resolve(context, projectAbsolute(context, projectPath));
  } catch (error: unknown) {
    if (error instanceof BudgetError) throw error;
    if (error instanceof SafePathError) {
      if (error.reason === 'missing') return { path: projectPath, status: 'missing' };
      const status = error.code === 'PATH_BLOCKED' ? 'blocked' : 'unreadable';
      diagnostics.push(
        diagnostic(
          error.code,
          'warning',
          'discovery',
          'A test directory could not be inspected safely.',
          [
            { key: 'path', value: projectPath },
            { key: 'reason', value: error.reason },
          ],
        ),
      );
      return { path: projectPath, status };
    }
    diagnostics.push(
      diagnostic(
        'TARGET_UNREADABLE',
        'warning',
        'discovery',
        'A test directory could not be inspected safely.',
        [{ key: 'path', value: projectPath }],
      ),
    );
    return { path: projectPath, status: 'unreadable' };
  }
  if (root.kind !== 'directory') return { path: projectPath, status: 'not-directory' };

  let testFiles = 0;
  let unrelatedFiles = 0;
  let emptyDirectories = 0;
  let directories = 0;
  let prunedDirectories = 0;
  let blockedEntries = 0;
  let incomplete = false;
  let stoppedBy: 'limit' | 'depth' | 'read-error' | null = null;
  const maxDepth = budget.limits.maxDirectoryDepth;

  const stack: SafePath[] = [];
  if (!state.seenDirectories.has(root.identityKey)) {
    state.seenDirectories.add(root.identityKey);
    stack.push(root);
  }
  if (state.budgetStopped) {
    incomplete = true;
    stoppedBy = 'limit';
    stack.length = 0;
  }

  while (stack.length > 0) {
    const directory = stack.pop();
    if (directory === undefined) break;
    budget.check();
    directories += 1;
    const names: { readonly name: string }[] = [];
    let handle: Awaited<ReturnType<DiscoveryDirectoryAdapter['opendir']>> | undefined;
    try {
      handle = await adapter.opendir(directory.physicalPath, { bufferSize: DIRECTORY_BUFFER_SIZE });
      for (;;) {
        await budget.checkpoint();
        const entry = await handle.read();
        if (entry === null) break;
        budget.chargeFilesystemEntry();
        names.push({ name: entry.name });
      }
    } catch (error: unknown) {
      if (handle !== undefined) await closeQuietly(handle);
      handle = undefined;
      if (error instanceof BudgetError) {
        if (error.kind !== 'limit') throw error;
        state.budgetStopped = true;
        incomplete = true;
        stoppedBy = 'limit';
        diagnostics.push(
          diagnostic(
            'LIMIT_EXCEEDED',
            'warning',
            'discovery',
            'Test directory enumeration stopped at an analysis limit.',
            [{ key: 'path', value: projectPath }],
          ),
        );
        break;
      }
      incomplete = true;
      stoppedBy = 'read-error';
      blockedEntries += 1;
      continue;
    }
    await handle.close();
    names.sort((left, right) => compareCodePoints(left.name, right.name));
    if (names.length === 0) emptyDirectories += 1;

    for (const { name } of names) {
      await budget.checkpoint();
      if (name.includes('\\') || name.includes('\0')) {
        blockedEntries += 1;
        incomplete = true;
        continue;
      }
      let child: SafePath;
      try {
        child = await resolve(context, join(directory.lexicalPath, name));
      } catch (error: unknown) {
        if (error instanceof BudgetError) throw error;
        if (error instanceof SafePathError && error.reason === 'hard-excluded') continue;
        blockedEntries += 1;
        incomplete = true;
        continue;
      }
      if (child.kind === 'directory') {
        if (PRUNED_DIRECTORY_NAMES.has(name)) {
          prunedDirectories += 1;
          continue;
        }
        if (state.seenDirectories.has(child.identityKey)) continue;
        if (child.physicalRelativePath.split('/').length > maxDepth) {
          incomplete = true;
          stoppedBy ??= 'depth';
          continue;
        }
        state.seenDirectories.add(child.identityKey);
        stack.push(child);
      } else if (child.kind === 'file') {
        if (state.seenFiles.has(child.identityKey)) continue;
        state.seenFiles.add(child.identityKey);
        if (isTestFileName(name)) testFiles += 1;
        else unrelatedFiles += 1;
      }
    }
  }

  if (incomplete && stoppedBy !== 'limit') {
    diagnostics.push(
      diagnostic(
        'PARTIAL_ANALYSIS',
        'warning',
        'discovery',
        'Test directory enumeration was incomplete.',
        [
          { key: 'path', value: projectPath },
          { key: 'observedTestFiles', value: testFiles },
        ],
      ),
    );
  }
  return {
    path: projectPath,
    status: 'directory',
    traversal: incomplete ? 'incomplete' : 'complete',
    testFiles: { exact: incomplete ? null : testFiles, observed: testFiles },
    unrelatedFiles,
    emptyDirectories,
    directories,
    prunedDirectories,
    blockedEntries,
    stoppedBy,
  };
}

function publicTestObservation(
  summary: TestRootSummary,
): Analysis['testObservations'][number] | null {
  if (summary.status === 'not-representable') return null;
  if (summary.status === 'directory') {
    return { path: summary.path, present: { status: 'measured', value: true, evidence: [] } };
  }
  if (summary.status === 'missing') {
    return { path: summary.path, present: { status: 'measured', value: false, evidence: [] } };
  }
  return { path: summary.path, present: unavailable(`test-path-${summary.status}`) };
}

function coverageObservation(
  source: string,
  reason: string,
): NonNullable<Analysis['coverageObservation']> {
  return { source, coveredLines: unavailable(reason), totalLines: unavailable(reason) };
}

function buildTargets(input: ReadinessInput): LcovTarget[] {
  const lines = new Map<FileId, Measurement<number>>();
  for (const item of input.physicalLines) lines.set(item.fileId, item.physicalLines);
  const paths = new Map<FileId, Set<string>>();
  for (const entry of input.manifest.entries) {
    if (entry.role === 'excluded') continue;
    paths.set(entry.fileId, new Set([entry.path]));
  }
  for (const alias of input.aliases) {
    paths.get(alias.fileId)?.add(alias.path);
  }
  const targets: LcovTarget[] = [];
  for (const entry of input.manifest.entries) {
    if (entry.role === 'excluded') continue;
    targets.push({
      fileId: entry.fileId,
      role: entry.role,
      paths: [...(paths.get(entry.fileId) ?? [])].sort(compareCodePoints),
      physicalLines:
        entry.role === 'scoped'
          ? (lines.get(entry.fileId) ?? unavailable('physical-lines-unavailable'))
          : unavailable('context-file'),
    });
  }
  return targets;
}

async function drainLcov(
  bytes: Uint8Array,
  input: ReadinessInput,
  targets: readonly LcovTarget[],
): Promise<LcovParseResult> {
  const generator = parseLcovBatches(bytes, {
    byteLimit: input.budget.limits.maxLcovBytes,
    roots: [input.pathContext.root, input.pathContext.lexicalRoot],
    targets,
  });
  try {
    for (;;) {
      await input.budget.checkpoint(true);
      const next = generator.next();
      if (next.done === true) return next.value;
    }
  } finally {
    generator.return({ status: 'unavailable', reason: 'empty' });
  }
}

const READ_FAILURE_TEXT = 'The coverage artifact could not be read.';

async function inspectCoverage(
  input: ReadinessInput,
  context: SafePathContext,
  diagnostics: Diagnostic[],
  limitations: Set<string>,
): Promise<{
  readonly observation: Analysis['coverageObservation'];
  readonly status: CoverageStatus;
  readonly files: readonly CoverageFileStatus[];
  readonly provenance: typeof PROVENANCE | null;
}> {
  const lcovPath = input.coverage.lcovPath;
  if (lcovPath === null) {
    return { observation: null, status: { kind: 'not-requested' }, files: [], provenance: null };
  }
  const details = (reason: string) => [
    { key: 'path', value: lcovPath },
    { key: 'reason', value: reason },
  ];
  const failed = (
    reason: 'missing' | 'blocked' | 'unreadable' | 'oversized' | 'changed',
    code: Diagnostic['code'],
    detail: string,
  ) => {
    diagnostics.push(diagnostic(code, 'warning', 'discovery', READ_FAILURE_TEXT, details(detail)));
    return {
      observation: coverageObservation(lcovPath, `coverage-${reason}`),
      status: { kind: 'unreadable', reason } as const,
      files: [] as readonly CoverageFileStatus[],
      provenance: null,
    };
  };

  let bytes: Uint8Array;
  try {
    bytes = await readCoverageFile(
      {
        pathContext: context,
        budget: input.budget,
        ...(input.readAdapter === undefined ? {} : { adapter: input.readAdapter }),
      },
      projectAbsolute(context, lcovPath),
    );
  } catch (error: unknown) {
    if (error instanceof BudgetError) {
      if (error.kind !== 'limit') throw error;
      return failed('oversized', 'LIMIT_EXCEEDED', 'oversized');
    }
    if (error instanceof SafePathError) {
      if (error.reason === 'missing') return failed('missing', 'TARGET_UNREADABLE', 'missing');
      return failed(
        error.code === 'PATH_BLOCKED' ? 'blocked' : 'unreadable',
        error.code,
        error.reason,
      );
    }
    if (error instanceof SafeReadError) {
      if (error.code === 'SOURCE_CHANGED') return failed('changed', 'SOURCE_CHANGED', error.reason);
      return failed('unreadable', 'TARGET_UNREADABLE', error.reason);
    }
    throw error;
  }

  limitations.add(
    'Coverage comes from a supplied artifact that was not generated or checked for freshness here. Its totals describe only the matched supplied subset, not branch or project-wide coverage.',
  );
  const targets = buildTargets(input);
  const parsed = await drainLcov(bytes, input, targets);
  if (parsed.status === 'unavailable') {
    diagnostics.push(
      diagnostic(
        parsed.reason === 'limit-exceeded' ? 'LIMIT_EXCEEDED' : 'SEMANTICS_UNAVAILABLE',
        'warning',
        'metrics',
        'The coverage artifact is malformed or outside the supported line-coverage subset.',
        details(parsed.reason),
      ),
    );
    return {
      observation: coverageObservation(lcovPath, `lcov-${parsed.reason}`),
      status: { kind: 'invalid', reason: parsed.reason },
      files: [],
      provenance: PROVENANCE,
    };
  }

  const files: CoverageFileStatus[] = parsed.records.map((record) => recordStatus(record));
  for (const fileId of parsed.absentScopedFileIds)
    files.push({ kind: 'absent-from-artifact', fileId });
  const count = (kind: CoverageFileStatus['kind']): number =>
    files.filter((item) => item.kind === kind).length;
  const matched = count('matched');
  const unmatched = count('unmatched-record');
  const context_ = count('context-record');
  const absent = count('absent-from-artifact');
  const excluded = count('excluded-record');
  limitations.add(
    `Coverage matching: ${matched} matched scoped files, ${unmatched + context_} unmatched artifact records (${context_} context), ${absent} scoped files absent from the artifact, ${excluded} excluded for line mismatch or unavailable line counts.`,
  );
  if (matched === 0) {
    diagnostics.push(
      diagnostic(
        'SEMANTICS_UNAVAILABLE',
        'warning',
        'metrics',
        'No coverage record matched a scoped source file.',
        details('no-matched-source'),
      ),
    );
    return {
      observation: coverageObservation(lcovPath, 'no-matched-source'),
      status: { kind: 'no-matched-source' },
      files,
      provenance: PROVENANCE,
    };
  }
  if (unmatched + context_ + absent + excluded > 0) {
    diagnostics.push(
      diagnostic(
        'PARTIAL_ANALYSIS',
        'info',
        'metrics',
        'Coverage totals describe the matched supplied subset only.',
        [
          { key: 'matched', value: matched },
          { key: 'unmatched', value: unmatched + context_ },
          { key: 'absent', value: absent },
          { key: 'excluded', value: excluded },
        ],
      ),
    );
  }
  return {
    observation: {
      source: lcovPath,
      coveredLines: { status: 'measured', value: parsed.coveredLines, evidence: [] },
      totalLines: { status: 'measured', value: parsed.totalLines, evidence: [] },
    },
    status: { kind: 'matched-subset' },
    files,
    provenance: PROVENANCE,
  };
}

function recordStatus(record: {
  readonly path: string;
  readonly status: LcovRecordStatus;
  readonly fileId: FileId | null;
  readonly coveredLines: number;
  readonly totalLines: number;
}): CoverageFileStatus {
  if (record.status === 'matched' && record.fileId !== null) {
    return {
      kind: 'matched',
      path: record.path,
      fileId: record.fileId,
      coveredLines: record.coveredLines,
      totalLines: record.totalLines,
    };
  }
  if (record.status === 'context' && record.fileId !== null) {
    return { kind: 'context-record', path: record.path, fileId: record.fileId };
  }
  if (
    (record.status === 'line-mismatch' || record.status === 'physical-lines-unavailable') &&
    record.fileId !== null
  ) {
    return {
      kind: 'excluded-record',
      path: record.path,
      fileId: record.fileId,
      reason: record.status,
    };
  }
  return { kind: 'unmatched-record', path: record.path };
}

/** Inspects test presence and the optional coverage artifact with bounded, data-only reads. */
export async function collectReadiness(input: ReadinessInput): Promise<ReadinessResult> {
  const context: SafePathContext = {
    ...input.pathContext,
    target: undefined,
    lexicalTarget: undefined,
    budget: input.budget,
  };
  const diagnostics: Diagnostic[] = [];
  const limitations = new Set<string>([
    'Test presence reports directory existence from filenames only. It does not establish test quality, test count, passing status or coverage.',
  ]);

  const probes = input.metadataPaths.test === null ? ['test', 'tests'] : [input.metadataPaths.test];
  const state: TraversalState = {
    seenDirectories: new Set(),
    seenFiles: new Set(),
    budgetStopped: false,
  };
  const testRoots: TestRootSummary[] = [];
  for (const path of probes) {
    input.budget.check();
    testRoots.push(await inspectTestRoot(input, context, path, state, diagnostics));
  }
  const testObservations: Analysis['testObservations'][number][] = [];
  for (const summary of testRoots) {
    const observation = publicTestObservation(summary);
    if (observation !== null) testObservations.push(observation);
    if (summary.status === 'directory' && summary.traversal === 'incomplete') {
      limitations.add(
        'Test file counts are incomplete lower bounds because enumeration stopped early.',
      );
    }
    if (summary.status === 'not-representable') {
      limitations.add(
        'The configured test path is the project root and cannot be reported as a test directory.',
      );
    }
  }

  const coverage = await inspectCoverage(input, context, diagnostics, limitations);
  const testsComplete = testRoots.every(
    (summary) =>
      summary.status === 'missing' ||
      (summary.status === 'directory' && summary.traversal === 'complete'),
  );
  const coverageComplete =
    coverage.status.kind === 'not-requested' || coverage.status.kind === 'matched-subset';
  return {
    testObservations,
    coverageObservation: coverage.observation,
    testRoots,
    coverageStatus: coverage.status,
    coverageFiles: coverage.files,
    complete: testsComplete && coverageComplete,
    provenance: coverage.provenance,
    diagnostics,
    limitations: [...limitations].sort(compareCodePoints),
  };
}
