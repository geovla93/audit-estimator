import { fileIdentity } from '../domain/canonical.ts';
import type {
  Diagnostic,
  FileId,
  FileScopeEntry,
  ImportReference,
  Ownership,
  Remapping,
  ResolvedConfig,
  ScopeManifest,
  ScopeRole,
  SourceSnapshot,
} from '../domain/types.ts';
import { BudgetError } from '../discovery/budget.ts';
import type { DiscoveryBudget } from '../discovery/budget.ts';
import type { IdentityRegistry } from '../discovery/identity.ts';
import { resolveSafePath, SafePathError } from '../discovery/safe-path.ts';
import type { SafePath, SafePathContext } from '../discovery/safe-path.ts';
import { readMetadataFile, readSource, SafeReadError } from '../discovery/safe-read.ts';
import type { SafeReadAdapter } from '../discovery/safe-read.ts';
import { reevaluateIdentityOwnership } from '../discovery/scope.ts';
import type { DiscoveryResult, ProjectMetadataResult } from '../discovery/scope.ts';
import type { createParserSession } from '../parser/adapter.ts';
import type {
  ParseFileResult,
  ParserBatch,
  ParserImport,
  ParserSource,
} from '../parser/protocol.ts';
import { compareCodePoints, cyclicComponents, dedupeDiagnostics } from './graph.ts';
import { planImportLookup, selectRemappingArray } from './imports.ts';
import type { LookupCandidate } from './imports.ts';
import { MAX_REMAPPINGS_FILE_BYTES, parseRemappingsText } from './remappings.ts';
import type { RemappingCandidate, RemappingSourceKind } from './remappings.ts';
import type {
  AppliedRemappingProvenance,
  ImportClosureResult,
  ImportFailureReason,
  ImportObservation,
  ImportProbe,
} from './types.ts';

export type ParserSessionHandle = ReturnType<typeof createParserSession>;

/** Input shared by the closure phase and the full relationship pipeline. */
export interface RelationshipInput {
  readonly discovery: DiscoveryResult;
  /** The captured reader context. Optional target confinement is preserved, never removed. */
  readonly pathContext: SafePathContext;
  readonly identities: IdentityRegistry;
  readonly budget: DiscoveryBudget;
  readonly config: ResolvedConfig;
  readonly metadata: ProjectMetadataResult;
  /** The same parser session that produced `initialSyntax`; the caller closes it. */
  readonly session: ParserSessionHandle;
  readonly initialSyntax: ParserBatch;
  readonly readAdapter?: SafeReadAdapter | undefined;
}

export type ImportClosureInput = RelationshipInput;

interface FileRecord {
  readonly fileId: FileId;
  readonly snapshot: SourceSnapshot;
  readonly identityKey: string;
  readonly originalEntry: FileScopeEntry | null;
  syntax: ParseFileResult | undefined;
}

type StopReason = 'limit' | 'deadline';

interface ClosureContext {
  readonly input: RelationshipInput;
  readonly remappings: readonly Remapping[];
  readonly remappingSource: RemappingSourceKind;
  readonly remappingsInvalid: boolean;
  readonly libs: readonly string[];
  readonly probeContext: SafePathContext;
  readonly byFileId: Map<FileId, FileRecord>;
  readonly byIdentity: Map<string, FileRecord>;
  readonly originalEntries: ReadonlyMap<FileId, FileScopeEntry>;
  stop: StopReason | null;
}

const FIXED_MESSAGES = {
  importUnresolved: 'A local import could not be resolved uniquely.',
  remappingsInvalid:
    'Active remapping metadata was invalid; imports were looked up without remappings.',
  limit: 'Import closure stopped at an analysis limit before all imports were resolved.',
  omittedDependency:
    'A first-party source outside the audit scope was analyzed as an omitted audit dependency.',
  invalidated: 'A scoped source has conflicting alias ownership and is no longer scope-eligible.',
} as const;

function details(
  ...items: readonly (readonly [string, string | number | boolean | null])[]
): NonNullable<Diagnostic['details']> {
  return items.map(([key, value]) => ({ key, value }));
}

function provenance(
  source: RemappingSourceKind,
  candidate: RemappingCandidate,
): AppliedRemappingProvenance {
  const context = candidate.remapping.context;
  return {
    source,
    context: context === undefined || context === '.' ? null : context,
    prefix: candidate.remapping.prefix,
    target: candidate.remapping.target,
    resolvedName: candidate.resolvedName,
  };
}

async function loadRemappings(
  input: RelationshipInput,
  diagnostics: Diagnostic[],
): Promise<{
  readonly list: readonly Remapping[];
  readonly source: RemappingSourceKind;
  readonly invalid: boolean;
}> {
  const decision = selectRemappingArray(input.config);
  if (!decision.needsFile) {
    return { list: decision.remappings, source: decision.source, invalid: false };
  }
  // `remappings.txt` is root-local metadata: read it without the source target boundary, as the
  // other metadata readers do, through the same budget and symlink-rejecting reader.
  const metadataContext: SafePathContext = {
    root: input.pathContext.root,
    lexicalRoot: input.pathContext.lexicalRoot,
    followSymlinks: false,
    budget: input.budget,
  };
  let bytes: Uint8Array;
  try {
    bytes = await readMetadataFile(
      {
        pathContext: metadataContext,
        budget: input.budget,
        adapter: input.readAdapter,
        maximumBytes: MAX_REMAPPINGS_FILE_BYTES,
      },
      'remappings.txt',
    );
  } catch (error: unknown) {
    if (error instanceof SafePathError && error.reason === 'missing') {
      return { list: decision.remappings, source: 'default', invalid: false };
    }
    if (error instanceof BudgetError && error.kind !== 'limit') throw error;
    diagnostics.push({
      code: 'IMPORT_UNRESOLVED',
      severity: 'warning',
      phase: 'semantics',
      message: FIXED_MESSAGES.remappingsInvalid,
      details: details(['metadata', 'remappings.txt'], ['reason', metadataFailureReason(error)]),
    });
    return { list: [], source: 'remappings-txt', invalid: true };
  }
  const parsed = parseRemappingsText(bytes);
  if (!parsed.ok) {
    diagnostics.push({
      code: 'IMPORT_UNRESOLVED',
      severity: 'warning',
      phase: 'semantics',
      message: FIXED_MESSAGES.remappingsInvalid,
      details: details(['metadata', 'remappings.txt'], ['reason', parsed.reason]),
    });
    return { list: [], source: 'remappings-txt', invalid: true };
  }
  return { list: parsed.remappings, source: 'remappings-txt', invalid: false };
}

function metadataFailureReason(error: unknown): string {
  if (error instanceof BudgetError) return 'metadata-limit';
  if (error instanceof SafePathError) return error.reason;
  if (error instanceof SafeReadError) return error.reason;
  return 'unreadable';
}

function fileIdFor(path: string): FileId {
  return fileIdentity(path);
}

function provisionalEntry(snapshot: SourceSnapshot, fileId: FileId): FileScopeEntry {
  return {
    fileId,
    path: snapshot.canonicalPath,
    role: 'context',
    ownership: 'unknown',
    ownershipEvidence: [],
    physicalIdentity: snapshot.canonicalPath,
    byteHash: snapshot.byteHash,
  };
}

function toParserSource(record: FileRecord, entry: FileScopeEntry): ParserSource {
  return { fileId: record.fileId, snapshot: record.snapshot, manifestEntry: entry };
}

function initialRecords(input: RelationshipInput): {
  readonly byFileId: Map<FileId, FileRecord>;
  readonly byIdentity: Map<string, FileRecord>;
  readonly originalEntries: ReadonlyMap<FileId, FileScopeEntry>;
} {
  const { discovery, identities, session, initialSyntax } = input;
  const originalEntries = new Map<FileId, FileScopeEntry>();
  for (const entry of discovery.manifest.entries) {
    if (originalEntries.has(entry.fileId)) {
      throw new TypeError('Discovery manifest contains a duplicate file identity.');
    }
    originalEntries.set(entry.fileId, entry);
  }
  const byFileId = new Map<FileId, FileRecord>();
  const byIdentity = new Map<string, FileRecord>();
  const snapshots = [...discovery.snapshots].sort((left, right) =>
    compareCodePoints(left.canonicalPath, right.canonicalPath),
  );
  for (const snapshot of snapshots) {
    const fileId = fileIdFor(snapshot.canonicalPath);
    const entry = originalEntries.get(fileId);
    if (
      entry === undefined ||
      entry.path !== snapshot.canonicalPath ||
      entry.byteHash !== snapshot.byteHash ||
      byFileId.has(fileId)
    ) {
      throw new TypeError('A discovery snapshot does not match its manifest entry.');
    }
    const identityKey = identities.identityForPhysicalPath(snapshot.canonicalPath);
    if (
      identityKey === undefined ||
      identities.snapshotForIdentity(identityKey)?.byteHash !== snapshot.byteHash
    ) {
      throw new TypeError('A discovery snapshot is not registered with the identity registry.');
    }
    const record: FileRecord = {
      fileId,
      snapshot,
      identityKey,
      originalEntry: entry,
      syntax: undefined,
    };
    byFileId.set(fileId, record);
    byIdentity.set(identityKey, record);
  }

  const outcomes = new Map<FileId, ParseFileResult>();
  for (const outcome of initialSyntax.files) {
    if (outcomes.has(outcome.fileId) || !byFileId.has(outcome.fileId)) {
      throw new TypeError('Initial syntax does not match the discovery snapshots.');
    }
    outcomes.set(outcome.fileId, outcome);
  }
  for (const record of byFileId.values()) {
    const outcome = outcomes.get(record.fileId);
    if (outcome === undefined) {
      if (record.originalEntry?.role === 'scoped') {
        throw new TypeError('Initial syntax is missing a scoped snapshot.');
      }
      continue;
    }
    const cached = session.cachedSyntax(record.fileId, record.snapshot.byteHash);
    if (cached !== undefined ? cached !== outcome : outcome.status !== 'failed') {
      throw new TypeError('Initial syntax was not produced by this session for these snapshots.');
    }
    record.syntax = outcome;
  }
  return { byFileId, byIdentity, originalEntries };
}

interface ProbeResult {
  readonly probe: ImportProbe;
  readonly safe: SafePath | null;
}

async function probeCandidate(
  context: ClosureContext,
  candidate: LookupCandidate,
): Promise<ProbeResult> {
  const { input } = context;
  await input.budget.checkpoint();
  const resolve = input.readAdapter?.resolve ?? resolveSafePath;
  try {
    const safe = await resolve({ ...context.probeContext, budget: input.budget }, candidate.path);
    if (safe.kind === 'directory') {
      return {
        probe: {
          path: candidate.path,
          origin: candidate.origin,
          outcome: 'missing',
          reason: null,
          fileId: null,
        },
        safe: null,
      };
    }
    if (safe.kind !== 'file') {
      return {
        probe: {
          path: candidate.path,
          origin: candidate.origin,
          outcome: 'blocked',
          reason: 'special-file',
          fileId: null,
        },
        safe: null,
      };
    }
    input.identities.observe(safe);
    const frozen = input.identities.freeze(safe.identityKey);
    const known = context.byIdentity.get(safe.identityKey);
    const canonical = known?.snapshot.canonicalPath ?? frozen?.representativePath;
    if (canonical === undefined) throw new SafePathError('PATH_BLOCKED', 'invalid-name');
    return {
      probe: {
        path: candidate.path,
        origin: candidate.origin,
        outcome: 'found',
        reason: null,
        fileId: fileIdFor(canonical),
      },
      safe,
    };
  } catch (error: unknown) {
    if (error instanceof BudgetError) throw error;
    if (error instanceof SafePathError && error.reason === 'missing') {
      return {
        probe: {
          path: candidate.path,
          origin: candidate.origin,
          outcome: 'missing',
          reason: null,
          fileId: null,
        },
        safe: null,
      };
    }
    return {
      probe: {
        path: candidate.path,
        origin: candidate.origin,
        outcome: 'blocked',
        reason: error instanceof SafePathError ? error.reason : 'unreadable',
        fileId: null,
      },
      safe: null,
    };
  }
}

function observation(
  record: FileRecord,
  imp: ParserImport,
  fields: Partial<
    Pick<
      ImportObservation,
      | 'lookupName'
      | 'strategy'
      | 'remapping'
      | 'conflictingRemappings'
      | 'probes'
      | 'candidateFileIds'
      | 'status'
      | 'targetFileId'
      | 'reason'
    >
  >,
): ImportObservation {
  return {
    importId: imp.id,
    importerFileId: record.fileId,
    specifier: imp.specifier,
    range: imp.range,
    specifierRange: imp.specifierRange,
    lookupName: fields.lookupName ?? null,
    strategy: fields.strategy ?? null,
    remapping: fields.remapping ?? null,
    conflictingRemappings: fields.conflictingRemappings ?? [],
    probes: fields.probes ?? [],
    candidateFileIds: fields.candidateFileIds ?? [],
    status: fields.status ?? 'unresolved',
    targetFileId: fields.targetFileId ?? null,
    reason: fields.reason ?? null,
  };
}

function sortedUnique(ids: readonly FileId[]): FileId[] {
  return [...new Set(ids)].sort(compareCodePoints) as FileId[];
}

async function resolveOneImport(
  context: ClosureContext,
  record: FileRecord,
  imp: ParserImport,
  created: FileRecord[],
): Promise<ImportObservation> {
  const { input } = context;
  if (context.stop !== null) {
    return observation(record, imp, { reason: context.stop });
  }
  const importerPath = record.snapshot.canonicalPath;
  const plan = planImportLookup(importerPath, imp.specifier, context.remappings, context.libs);
  if (!plan.ok) {
    if (plan.reason !== 'remapping-conflict') {
      return observation(record, imp, { reason: plan.reason });
    }
    // Equal-ranked conflicts are never decided by order. Probe each conflicting target only to
    // disclose candidate identities; nothing is read or bound.
    const conflictProbes: ImportProbe[] = [];
    const candidateIds: FileId[] = [];
    const conflicts = plan.conflicts;
    for (const conflict of conflicts) {
      if (conflict.resolvedName === null) continue;
      const result = await probeCandidate(context, {
        path: conflict.resolvedName,
        origin: 'remapped',
      });
      conflictProbes.push(result.probe);
      if (result.probe.fileId !== null) candidateIds.push(result.probe.fileId);
    }
    return observation(record, imp, {
      lookupName: plan.name,
      strategy: 'remapped',
      conflictingRemappings: conflicts.map((conflict) =>
        provenance(context.remappingSource, conflict),
      ),
      probes: conflictProbes,
      candidateFileIds: sortedUnique(candidateIds),
      status: 'ambiguous',
      reason: 'remapping-conflict',
    });
  }

  const probes: ImportProbe[] = [];
  const foundByIdentity = new Map<string, { readonly safe: SafePath; readonly fileId: FileId }>();
  let blocked = 0;
  for (const candidate of plan.candidates) {
    const result = await probeCandidate(context, candidate);
    probes.push(result.probe);
    if (result.probe.outcome === 'blocked') blocked += 1;
    if (result.safe !== null && result.probe.fileId !== null) {
      if (!foundByIdentity.has(result.safe.identityKey)) {
        foundByIdentity.set(result.safe.identityKey, {
          safe: result.safe,
          fileId: result.probe.fileId,
        });
      }
    }
  }
  const base = {
    lookupName: plan.name,
    strategy: plan.strategy,
    remapping: plan.remapping === null ? null : provenance(context.remappingSource, plan.remapping),
    probes,
  } as const;
  const found = [...foundByIdentity.values()].sort((left, right) =>
    compareCodePoints(left.fileId, right.fileId),
  );
  const candidateFileIds = sortedUnique(found.map((item) => item.fileId));

  if (found.length > 1) {
    return observation(record, imp, {
      ...base,
      candidateFileIds,
      status: 'ambiguous',
      reason: 'ambiguous-candidates',
    });
  }
  const only = found[0];
  if (only === undefined) {
    const reason: ImportFailureReason =
      blocked > 0
        ? 'blocked-candidate'
        : plan.strategy === 'remapped'
          ? 'remapped-target-missing'
          : 'not-found';
    return observation(record, imp, { ...base, reason });
  }
  if (blocked > 0 && plan.strategy === 'direct') {
    return observation(record, imp, { ...base, candidateFileIds, reason: 'blocked-candidate' });
  }

  const known = context.byIdentity.get(only.safe.identityKey);
  if (known !== undefined) {
    return observation(record, imp, {
      ...base,
      candidateFileIds,
      status: 'resolved',
      targetFileId: known.fileId,
    });
  }
  const aliasPath = plan.candidates.find(
    (candidate) => probes.find((probe) => probe.path === candidate.path)?.fileId === only.fileId,
  )?.path;
  if (aliasPath === undefined) {
    return observation(record, imp, { ...base, candidateFileIds, reason: 'unreadable' });
  }
  try {
    const snapshot = await readSource(
      {
        pathContext: context.input.pathContext,
        budget: input.budget,
        identities: input.identities,
        adapter: input.readAdapter,
      },
      aliasPath,
    );
    const fileId = fileIdFor(snapshot.canonicalPath);
    const created1: FileRecord = {
      fileId,
      snapshot,
      identityKey: only.safe.identityKey,
      originalEntry: context.originalEntries.get(fileId) ?? null,
      syntax: undefined,
    };
    const existing = context.byFileId.get(fileId);
    if (existing === undefined) {
      context.byFileId.set(fileId, created1);
      context.byIdentity.set(only.safe.identityKey, created1);
      created.push(created1);
    }
    return observation(record, imp, {
      ...base,
      candidateFileIds: sortedUnique([...candidateFileIds, fileId]),
      status: 'resolved',
      targetFileId: fileId,
    });
  } catch (error: unknown) {
    if (error instanceof BudgetError) {
      if (error.kind === 'cancelled') throw error;
      if (error.kind === 'deadline') {
        context.stop = 'deadline';
        return observation(record, imp, { ...base, candidateFileIds, reason: 'deadline' });
      }
      if (Number(only.safe.stats.size) > input.config.analysis.limits.maxFileBytes) {
        return observation(record, imp, { ...base, candidateFileIds, reason: 'limit' });
      }
      context.stop = 'limit';
      return observation(record, imp, { ...base, candidateFileIds, reason: 'limit' });
    }
    if (error instanceof SafeReadError && error.reason === 'changed') {
      return observation(record, imp, { ...base, candidateFileIds, reason: 'source-changed' });
    }
    if (error instanceof SafePathError) {
      return observation(record, imp, {
        ...base,
        candidateFileIds,
        reason: error.reason === 'missing' ? 'not-found' : 'blocked-candidate',
      });
    }
    return observation(record, imp, { ...base, candidateFileIds, reason: 'unreadable' });
  }
}

function importDiagnostic(item: ImportObservation): Diagnostic {
  return {
    code: 'IMPORT_UNRESOLVED',
    severity: 'warning',
    phase: 'semantics',
    message: FIXED_MESSAGES.importUnresolved,
    fileId: item.importerFileId,
    range: item.specifierRange,
    details: details(['status', item.status], ['reason', item.reason ?? 'unknown']),
  };
}

function publicImport(item: ImportObservation): ImportReference {
  const base = {
    id: item.importId,
    importerFileId: item.importerFileId,
    specifier: item.specifier,
    range: item.range,
    candidateFileIds: [...item.candidateFileIds],
  };
  if (item.status === 'resolved' && item.targetFileId !== null) {
    return { ...base, status: 'resolved', targetFileId: item.targetFileId };
  }
  if (item.status === 'ambiguous' && item.candidateFileIds.length > 0) {
    return { ...base, status: 'ambiguous', targetFileId: null };
  }
  return { ...base, status: 'unresolved', targetFileId: null };
}

function mergeSyntax(
  records: readonly FileRecord[],
  batches: readonly ParserBatch[],
  counters: { readonly syntaxNodes: number; readonly syntaxBytes: number },
): ParserBatch {
  const files = new Map<FileId, ParseFileResult>();
  for (const record of records) {
    if (record.syntax !== undefined) files.set(record.fileId, record.syntax);
  }
  const ordered = [...files.values()].sort((left, right) =>
    compareCodePoints(left.fileId, right.fileId),
  );
  const diagnostics = dedupeDiagnostics(batches.flatMap((batch) => batch.diagnostics));
  return {
    files: ordered,
    diagnostics,
    complete:
      ordered.length === records.length && ordered.every((outcome) => outcome.status === 'parsed'),
    visitedNodes: counters.syntaxNodes,
    processedBytes: counters.syntaxBytes,
  };
}

/**
 * Expands the local import closure through the existing safe readers and the existing parser
 * session. Newly reached files are context, never automatically scoped. An unresolved target is a
 * result; nothing falls back to a global name search.
 */
export async function resolveImportClosure(input: RelationshipInput): Promise<ImportClosureResult> {
  const diagnostics: Diagnostic[] = [];
  const { byFileId, byIdentity, originalEntries } = initialRecords(input);
  const remapping = await loadRemappings(input, diagnostics);
  const originalScopedIds = new Set<FileId>(input.discovery.manifest.scopedFileIds);
  const context: ClosureContext = {
    input,
    remappings: remapping.list,
    remappingSource: remapping.source,
    remappingsInvalid: remapping.invalid,
    libs: input.metadata.paths.libs,
    probeContext: input.pathContext,
    byFileId,
    byIdentity,
    originalEntries,
    stop: null,
  };

  const batches: ParserBatch[] = [input.initialSyntax];
  const observations: ImportObservation[] = [];
  const processed = new Set<FileId>();

  // Original files without an initial outcome (non-scoped snapshots) are parsed first.
  const unparsed = [...byFileId.values()].filter((record) => record.syntax === undefined);
  if (unparsed.length > 0) {
    const batch = await input.session.analyzeSources(
      unparsed.map((record) =>
        toParserSource(
          record,
          record.originalEntry ?? provisionalEntry(record.snapshot, record.fileId),
        ),
      ),
    );
    batches.push(batch);
    for (const outcome of batch.files) {
      const record = byFileId.get(outcome.fileId);
      if (record !== undefined) record.syntax = outcome;
    }
  }

  let frontier = [...byFileId.values()].sort((left, right) =>
    compareCodePoints(left.fileId, right.fileId),
  );
  while (frontier.length > 0) {
    const created: FileRecord[] = [];
    for (const record of frontier) {
      if (processed.has(record.fileId)) continue;
      processed.add(record.fileId);
      await input.budget.checkpoint();
      const syntax = record.syntax;
      if (syntax?.status !== 'parsed') continue;
      const imports = [...syntax.imports].sort(
        (left, right) =>
          left.range.startByte - right.range.startByte || compareCodePoints(left.id, right.id),
      );
      for (const imp of imports) {
        observations.push(await resolveOneImport(context, record, imp, created));
      }
    }
    if (created.length === 0) break;
    const ordered = created.sort((left, right) => compareCodePoints(left.fileId, right.fileId));
    const batch = await input.session.analyzeSources(
      ordered.map((record) =>
        toParserSource(
          record,
          record.originalEntry ?? provisionalEntry(record.snapshot, record.fileId),
        ),
      ),
    );
    batches.push(batch);
    for (const outcome of batch.files) {
      const record = byFileId.get(outcome.fileId);
      if (record !== undefined) record.syntax = outcome;
    }
    frontier = ordered;
  }

  // Final alias reclassification: every alias observed while probing counts, even for files that
  // were already visited. Original IDs and snapshots are preserved; only eligibility changes.
  const records = [...byFileId.values()].sort((left, right) =>
    compareCodePoints(left.fileId, right.fileId),
  );
  const invalidated = new Set<FileId>();
  const ownershipByFile = new Map<FileId, Ownership>();
  for (const record of records) {
    const reevaluation = await reevaluateIdentityOwnership({
      identities: input.identities,
      identityKey: record.identityKey,
      scope: input.config.scope,
      metadataPaths: input.metadata.paths,
      scopedFileIds: [...originalScopedIds],
      budget: input.budget,
    });
    ownershipByFile.set(record.fileId, reevaluation?.ownership ?? 'unknown');
    for (const id of reevaluation?.invalidatedScopedFileIds ?? []) invalidated.add(id);
  }

  const entries: FileScopeEntry[] = [];
  for (const [fileId, entry] of originalEntries) {
    const record = byFileId.get(fileId);
    if (record === undefined) {
      entries.push(entry);
    } else if (invalidated.has(fileId)) {
      entries.push({
        ...entry,
        role: 'context',
        ownership: ownershipByFile.get(fileId) ?? 'unknown',
      });
    } else {
      entries.push(entry);
    }
  }
  for (const record of records) {
    if (originalEntries.has(record.fileId)) continue;
    entries.push({
      fileId: record.fileId,
      path: record.snapshot.canonicalPath,
      role: 'context',
      ownership: ownershipByFile.get(record.fileId) ?? 'unknown',
      ownershipEvidence: [],
      physicalIdentity: record.snapshot.canonicalPath,
      byteHash: record.snapshot.byteHash,
    });
  }
  const orderedEntries = entries.sort((left, right) => compareCodePoints(left.path, right.path));
  const roleIds = (role: ScopeRole): FileId[] =>
    orderedEntries.filter((entry) => entry.role === role).map((entry) => entry.fileId);
  const manifest: ScopeManifest = {
    entries: orderedEntries,
    scopedFileIds: roleIds('scoped'),
    contextFileIds: roleIds('context'),
    excludedFileIds: roleIds('excluded'),
  };
  const entryById = new Map(orderedEntries.map((entry) => [entry.fileId, entry]));
  const sources = records.map((record) => {
    const entry = entryById.get(record.fileId);
    if (entry === undefined) throw new TypeError('Closure file is missing its manifest entry.');
    return toParserSource(record, entry);
  });

  const sortedObservations = observations.sort((left, right) =>
    compareCodePoints(left.importId, right.importId),
  );
  const resolvedEdges = new Map<string, string[]>();
  for (const item of sortedObservations) {
    if (item.status !== 'resolved' || item.targetFileId === null) continue;
    const targets = resolvedEdges.get(item.importerFileId) ?? [];
    targets.push(item.targetFileId);
    resolvedEdges.set(item.importerFileId, targets);
  }
  const importCycles = cyclicComponents(
    records.map((record) => record.fileId),
    resolvedEdges,
  ) as FileId[][];

  for (const item of sortedObservations) {
    if (item.status !== 'resolved') diagnostics.push(importDiagnostic(item));
  }
  if (context.stop !== null) {
    diagnostics.push({
      code: 'LIMIT_EXCEEDED',
      severity: 'warning',
      phase: 'semantics',
      message: FIXED_MESSAGES.limit,
      details: details(['rule', context.stop]),
    });
  }
  for (const fileId of [...invalidated].sort(compareCodePoints)) {
    diagnostics.push({
      code: 'OWNERSHIP_UNKNOWN',
      severity: 'warning',
      phase: 'semantics',
      message: FIXED_MESSAGES.invalidated,
      fileId: fileId as FileId,
    });
  }
  for (const entry of orderedEntries) {
    if (
      entry.role === 'context' &&
      entry.ownership === 'first-party' &&
      !invalidated.has(entry.fileId)
    ) {
      diagnostics.push({
        code: 'PARTIAL_ANALYSIS',
        severity: 'info',
        phase: 'semantics',
        message: FIXED_MESSAGES.omittedDependency,
        fileId: entry.fileId,
        details: details(['role', 'context'], ['ownership', 'first-party']),
      });
    }
  }

  const counters = input.session.counters;
  const syntax = mergeSyntax(records, batches, counters);
  for (const batchDiagnostic of syntax.diagnostics) diagnostics.push(batchDiagnostic);

  const closureComplete =
    syntax.complete &&
    context.stop === null &&
    !remapping.invalid &&
    sortedObservations.every((item) => item.status === 'resolved') &&
    invalidated.size === 0;

  return {
    manifest,
    sources,
    syntax,
    imports: sortedObservations.map(publicImport),
    importObservations: sortedObservations,
    importCycles,
    invalidatedScopedFileIds: [...invalidated].sort(compareCodePoints) as FileId[],
    diagnostics: dedupeDiagnostics(diagnostics),
    closureComplete,
    stopped: context.stop !== null,
    remappingSource: remapping.source,
    activeRemappings: remapping.list.map((item) => ({
      context: item.context === undefined || item.context === '.' ? null : item.context,
      prefix: item.prefix,
      target: item.target,
    })),
  };
}
