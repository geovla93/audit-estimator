import { fileIdentity } from '../domain/canonical.ts';
import type {
  CallableId,
  ContractId,
  Diagnostic,
  FileId,
  FileScopeEntry,
  ImportReference,
  Ownership,
  Remapping,
  RelationshipResult,
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
import type {
  ParsedSyntax,
  SemanticComponentMember,
  createParserSession,
} from '../parser/adapter.ts';
import { MAX_SEMANTIC_BYTES_CEILING, MAX_SEMANTIC_FILES_CEILING } from '../parser/protocol.ts';
import type {
  ParseFileResult,
  ParserBatch,
  ParserImport,
  ParserSource,
  SemanticBaseSite,
  SemanticCallSite,
} from '../parser/protocol.ts';
import { buildCallFacts, countConfirmedBuiltins } from './calls.ts';
import { planComponents } from './components.ts';
import type { ComponentAuthority } from './components.ts';
import {
  compareCodePoints,
  cyclicComponents,
  dedupeDiagnostics,
  derivePairs,
  GraphAllowance,
  MAX_EDGE_FANOUT,
  MAX_PUBLIC_ROWS,
  relationshipFingerprint,
  rowFits,
  summarizeCompleteness,
} from './graph.ts';
import type { PairClaim } from './graph.ts';
import { planImportLookup, selectRemappingArray } from './imports.ts';
import type { LookupCandidate } from './imports.ts';
import { buildInheritance, toBaseSiteFacts } from './inheritance.ts';
import type { InheritanceContract } from './inheritance.ts';
import { MAX_REMAPPINGS_FILE_BYTES, parseRemappingsText } from './remappings.ts';
import type { RemappingCandidate, RemappingSourceKind } from './remappings.ts';
import type {
  AppliedRemappingProvenance,
  ComponentObservation,
  ImportClosureResult,
  ImportFailureReason,
  ImportObservation,
  ImportProbe,
  RelationshipAnalysis,
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
  componentUnavailable: 'Semantic binding is unavailable for an import-connected component.',
  inheritanceUnavailable:
    'Transitive inheritance measurements are unavailable for a scoped contract.',
  graphLimit: 'The relationship graph exceeded its allowance or a public schema bound.',
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

function versionAuthority(config: ResolvedConfig): ComponentAuthority {
  const source =
    config.provenance.find((item) => item.field === 'solidity.version')?.source ?? 'default';
  return { source, version: config.solidity.version };
}

function importRow(item: ImportObservation): RelationshipResult {
  const common = {
    id: item.importId,
    kind: 'import' as const,
    from: item.importerFileId,
    candidateTargets: [...item.candidateFileIds],
    evidence: [{ fileId: item.importerFileId, range: item.specifierRange }],
  };
  if (item.status === 'resolved' && item.targetFileId !== null) {
    return { ...common, resolution: 'resolved-unique', to: item.targetFileId };
  }
  return {
    ...common,
    resolution:
      item.status === 'ambiguous' && item.candidateFileIds.length > 0 ? 'ambiguous' : 'unresolved',
  };
}

const MUTABLE_UNKNOWN_SHAPES: ReadonlySet<string> = new Set(['user-defined', 'unknown']);

function hasUnresolvedMutableStorage(syntax: ParsedSyntax): boolean {
  return syntax.events.some((event) => {
    if (event.kind !== 'state-variable') return false;
    const value = (key: string) => event.attributes.find((item) => item.key === key)?.value;
    const shape = value('type-shape');
    return (
      typeof shape === 'string' &&
      MUTABLE_UNKNOWN_SHAPES.has(shape) &&
      value('constant') !== true &&
      value('immutable') !== true
    );
  });
}

/**
 * Full internal relationship pipeline: import closure, import-connected components, semantic jobs,
 * inheritance and call facts, deduplicated contract pairs, completion flags and fingerprint. It
 * never creates its own budget or parser session and never replaces earlier syntax evidence. The
 * caller owns closing the session; cancellation propagates as the established cancelled error.
 */
export async function resolveRelationships(
  input: RelationshipInput,
): Promise<RelationshipAnalysis> {
  const closure = await resolveImportClosure(input);
  const limits = input.config.analysis.limits;
  const allowance = new GraphAllowance(limits.maxGraphEdges);
  const diagnostics: Diagnostic[] = [
    ...input.discovery.diagnostics,
    ...input.initialSyntax.diagnostics,
    ...closure.diagnostics,
  ];
  let relationshipIncomplete = !closure.closureComplete;
  let graphLimited = false;
  let schemaOverflow = false;

  const syntaxById = new Map<FileId, ParseFileResult>(
    closure.syntax.files.map((outcome) => [outcome.fileId, outcome]),
  );
  const sourceById = new Map<FileId, ParserSource>(
    closure.sources.map((source) => [source.fileId, source]),
  );
  const eligibleScoped = new Set<FileId>(
    closure.manifest.entries
      .filter((entry) => entry.role === 'scoped' && entry.ownership === 'first-party')
      .map((entry) => entry.fileId),
  );

  // Public import rows, charged before they are retained.
  const imports: ImportReference[] = [];
  const graphs: RelationshipResult[] = [];
  const observationsInOrder = [...closure.importObservations];
  for (let index = 0; index < observationsInOrder.length; index += 1) {
    const observed = observationsInOrder[index];
    const reference = closure.imports[index];
    if (observed === undefined || reference === undefined) continue;
    const row = importRow(observed);
    if (
      imports.length >= MAX_PUBLIC_ROWS ||
      reference.candidateFileIds.length > MAX_EDGE_FANOUT ||
      !rowFits(row)
    ) {
      schemaOverflow = true;
      continue;
    }
    if (
      !allowance.tryCharge(
        1 + reference.candidateFileIds.length + 1 + row.candidateTargets.length + 1,
      )
    ) {
      graphLimited = true;
      break;
    }
    imports.push(reference);
    graphs.push(row);
  }

  // Components and semantic jobs through the same parser session.
  const plans = planComponents({
    files: closure.sources.map((source) => ({
      fileId: source.fileId,
      syntax: syntaxById.get(source.fileId),
      byteLength: source.snapshot.originalBytes.byteLength,
    })),
    observations: closure.importObservations,
    authority: versionAuthority(input.config),
    scopedFileIds: eligibleScoped,
    maxFiles: Math.min(limits.maxSemanticFiles, MAX_SEMANTIC_FILES_CEILING),
    maxBytes: Math.min(limits.maxSemanticBytes, MAX_SEMANTIC_BYTES_CEILING),
  });
  const components: ComponentObservation[] = [];
  const baseSites: SemanticBaseSite[] = [];
  const callSites: SemanticCallSite[] = [];
  const boundFiles = new Set<FileId>();
  for (const plan of plans) {
    let status: ComponentObservation['status'] = plan.status;
    let reason: ComponentObservation['reason'] = plan.reason;
    if (plan.status === 'available' && plan.grammar !== null) {
      const memberSet = new Set<FileId>(plan.members);
      const members: SemanticComponentMember[] = [];
      for (const memberId of plan.members) {
        const source = sourceById.get(memberId);
        const syntax = syntaxById.get(memberId);
        if (source === undefined || syntax?.status !== 'parsed') {
          throw new TypeError('A planned component member has no accepted syntax.');
        }
        members.push({ source, syntax });
      }
      const lookups = closure.importObservations.flatMap((item) =>
        memberSet.has(item.importerFileId) &&
        item.status === 'resolved' &&
        item.targetFileId !== null
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
      const outcome = await input.session.analyzeSemanticComponent({
        componentId: plan.id,
        grammar: plan.grammar,
        members,
        lookups,
        maxRecords: allowance.remaining,
      });
      if (outcome.status === 'bound') {
        baseSites.push(...outcome.baseSites);
        callSites.push(...outcome.callSites);
        for (const memberId of plan.members) boundFiles.add(memberId);
      } else {
        status = 'unavailable';
        reason = outcome.reason === 'limit' ? 'semantics-limit' : 'semantics-failed';
      }
    }
    components.push({ id: plan.id, members: plan.members, grammar: plan.grammar, status, reason });
    if (status === 'unavailable' && reason !== 'no-scoped-member') {
      relationshipIncomplete = true;
      diagnostics.push({
        code:
          reason === 'semantics-limit' || reason === 'component-too-large'
            ? 'LIMIT_EXCEEDED'
            : 'SEMANTICS_UNAVAILABLE',
        severity: 'warning',
        phase: 'semantics',
        message: FIXED_MESSAGES.componentUnavailable,
        fileId: plan.id,
        details: details(['reason', reason ?? 'unknown'], ['members', plan.members.length]),
      });
    }
  }

  // Facts from accepted semantic sites only.
  const parsedFiles = closure.sources.flatMap((source) => {
    const syntax = syntaxById.get(source.fileId);
    return syntax?.status === 'parsed'
      ? [{ fileId: source.fileId, canonicalPath: source.snapshot.canonicalPath, syntax }]
      : [];
  });
  const contracts: InheritanceContract[] = parsedFiles.flatMap((file) =>
    file.syntax.declarations
      .filter(
        (declaration) =>
          declaration.callableId === null && declaration.contractId === declaration.id,
      )
      .map((declaration) => ({
        id: declaration.id as ContractId,
        fileId: file.fileId,
        callableIds: file.syntax.declarations
          .filter((item) => item.contractId === declaration.id && item.callableId !== null)
          .map((item) => item.callableId as CallableId),
        semantics: boundFiles.has(file.fileId) ? ('bound' as const) : ('unavailable' as const),
      })),
  );
  const inheritance = buildInheritance({
    contracts,
    sites: toBaseSiteFacts(
      parsedFiles.filter((file) => boundFiles.has(file.fileId)),
      baseSites,
    ),
    allowance,
  });
  const callResult = buildCallFacts({
    files: parsedFiles.map((file) => ({
      ...file,
      semantics: boundFiles.has(file.fileId) ? ('bound' as const) : ('unavailable' as const),
    })),
    sites: callSites,
    allowance,
  });
  graphLimited = graphLimited || inheritance.limited || callResult.limited;
  for (const row of [...inheritance.graphs, ...callResult.graphs]) {
    if (graphs.length >= MAX_PUBLIC_ROWS || !rowFits(row)) {
      schemaOverflow = true;
      continue;
    }
    graphs.push(row);
  }

  const confirmed = countConfirmedBuiltins({
    files: closure.sources.map((source) => ({
      fileId: source.fileId,
      syntax: syntaxById.get(source.fileId),
      semantics: boundFiles.has(source.fileId) ? ('bound' as const) : ('unavailable' as const),
    })),
    facts: callResult.facts,
  });

  // Pairs only from direct resolved inheritance and dispatch-proven cross-contract calls.
  const fileOf = new Map<ContractId, FileId>(contracts.map((item) => [item.id, item.fileId]));
  const contractOfCallable = new Map<CallableId, ContractId>();
  for (const file of parsedFiles) {
    for (const declaration of file.syntax.declarations) {
      if (declaration.callableId !== null && declaration.contractId !== null) {
        contractOfCallable.set(declaration.callableId, declaration.contractId);
      }
    }
  }
  const claims: PairClaim[] = [];
  for (const edge of inheritance.edges) {
    if (edge.resolution === 'resolved-unique' && edge.baseContractId !== null) {
      claims.push({
        leftId: edge.contractId,
        rightId: edge.baseContractId,
        kind: 'inheritance',
        evidence: edge.evidence,
      });
    }
  }
  for (const fact of callResult.facts) {
    if (
      fact.symbol !== 'unique' ||
      fact.dispatch !== 'static' ||
      fact.symbolTarget === null ||
      fact.ownerContractId === null
    ) {
      continue;
    }
    const target = contractOfCallable.get(fact.symbolTarget);
    if (target === undefined) continue;
    claims.push({
      leftId: fact.ownerContractId,
      rightId: target,
      kind: 'call',
      evidence: fact.evidence,
    });
  }
  const pairs = derivePairs(
    claims,
    {
      fileOf,
      entries: new Map(
        closure.manifest.entries.map((entry) => [
          entry.fileId,
          { role: entry.role, ownership: entry.ownership },
        ]),
      ),
    },
    allowance,
  );
  graphLimited = graphLimited || pairs.limited;

  // Completion and unknown-semantics flags.
  const scopedContracts = inheritance.inheritance.filter((item) => eligibleScoped.has(item.fileId));
  const unavailableAncestry = new Map<string, FileId>();
  for (const item of scopedContracts) {
    if (item.ancestorIds.status === 'unavailable') {
      unavailableAncestry.set(`${item.fileId}\u0000${item.ancestorIds.reason}`, item.fileId);
    }
  }
  for (const [key, fileId] of unavailableAncestry) {
    relationshipIncomplete = true;
    diagnostics.push({
      code: 'SEMANTICS_UNAVAILABLE',
      severity: 'warning',
      phase: 'semantics',
      message: FIXED_MESSAGES.inheritanceUnavailable,
      fileId,
      details: details(
        ['measurement', 'inheritance'],
        ['reason', key.split('\u0000')[1] ?? 'unknown'],
      ),
    });
  }
  if (graphLimited || schemaOverflow) {
    relationshipIncomplete = true;
    diagnostics.push({
      code: 'LIMIT_EXCEEDED',
      severity: 'warning',
      phase: 'semantics',
      message: FIXED_MESSAGES.graphLimit,
      details: details(['rule', schemaOverflow ? 'schema-bound' : 'maxGraphEdges']),
    });
  }
  const unknownCall = callResult.facts.some(
    (fact) =>
      eligibleScoped.has(fact.fileId) &&
      (fact.limitation === 'external-receiver-unproven' ||
        fact.symbol === 'candidates' ||
        fact.symbol === 'non-callable' ||
        fact.symbol === 'none' ||
        fact.builtin === 'unknown'),
  );
  const unknownStorage = parsedFiles.some(
    (file) => eligibleScoped.has(file.fileId) && hasUnresolvedMutableStorage(file.syntax),
  );
  const completeness = summarizeCompleteness({
    prerequisiteComplete: input.discovery.complete && input.initialSyntax.complete,
    relationshipIncomplete,
    unknownEvidence: unknownCall || unknownStorage,
  });

  const fingerprintValue = relationshipFingerprint({
    entries: closure.manifest.entries.map((entry) => ({
      fileId: entry.fileId,
      byteHash: entry.byteHash,
      role: entry.role,
      ownership: entry.ownership,
    })),
    imports: closure.importObservations.map((item) => ({
      importId: item.importId,
      status: item.status,
      targetFileId: item.targetFileId,
      candidateFileIds: item.candidateFileIds,
      strategy: item.strategy,
      lookupName: item.lookupName,
      reason: item.reason,
      remapping: item.remapping === null ? null : { ...item.remapping },
    })),
    semanticConfig: {
      remappingSource: closure.remappingSource,
      remappings: closure.activeRemappings,
      libs: input.metadata.paths.libs,
      solidity: versionAuthority(input.config),
      limits: {
        maxFiles: limits.maxFiles,
        maxFileBytes: limits.maxFileBytes,
        maxTotalSourceBytes: limits.maxTotalSourceBytes,
        maxImports: limits.maxImports,
        maxGraphEdges: limits.maxGraphEdges,
        maxAstNodesPerFile: limits.maxAstNodesPerFile,
        maxAstNodesTotal: limits.maxAstNodesTotal,
        maxSemanticFiles: limits.maxSemanticFiles,
        maxSemanticBytes: limits.maxSemanticBytes,
      },
    },
    parserVersion:
      parsedFiles[0] === undefined ? null : parsedFiles[0].syntax.version.parserVersion,
    fileVersions: parsedFiles.map((file) => ({
      fileId: file.fileId,
      version: file.syntax.version.selectedVersion,
    })),
    components: components.map((item) => ({
      id: item.id,
      members: item.members,
      grammar: item.grammar,
      status: item.status,
      reason: item.reason,
    })),
    invalidated: closure.invalidatedScopedFileIds,
  });

  return {
    manifest: closure.manifest,
    sources: closure.sources,
    syntax: closure.syntax,
    imports,
    graphs: graphs.sort((left, right) => compareCodePoints(left.id, right.id)),
    importObservations: closure.importObservations,
    importCycles: closure.importCycles,
    components,
    inheritance: inheritance.inheritance,
    directBaseEdges: inheritance.edges,
    callSites: callResult.facts,
    scopedPairs: pairs.scopedPairs,
    contextPairs: pairs.contextPairs,
    confirmedBuiltinLowLevelCalls: confirmed,
    invalidatedScopedFileIds: closure.invalidatedScopedFileIds,
    diagnostics: dedupeDiagnostics(diagnostics),
    requiredAnalysisComplete: completeness.requiredAnalysisComplete,
    hasUnknownSemantics: completeness.hasUnknownSemantics,
    fingerprint: fingerprintValue,
  };
}
