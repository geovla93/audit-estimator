import { createHash } from 'node:crypto';
import { CompilationBuilder } from '@nomicfoundation/slang/compilation';
import type { CompilationUnit } from '@nomicfoundation/slang/compilation';
import { Parser } from '@nomicfoundation/slang/parser';
import { TerminalKindExtensions } from '@nomicfoundation/slang/cst';
import type { Cursor } from '@nomicfoundation/slang/cst';
import { fileIdentity } from '../domain/canonical.ts';
import type { FileId, SourceRange } from '../domain/types.ts';
import {
  MAX_SEMANTIC_DEFINITIONS_PER_REFERENCE,
  MAX_SEMANTIC_ORDINAL,
  MAX_DECLARATION_NAME_CODE_UNITS,
} from './protocol.ts';
import type {
  SemanticBaseSite,
  SemanticCallSite,
  SemanticCalleeKind,
  SemanticComponentResult,
  SemanticDefinition,
  SemanticReceiverKind,
  SemanticUnavailableReason,
  SemanticWorkerRequest,
} from './protocol.ts';
import { isValidDomainRange, parserSourceView, SourceCoordinateIndex } from './ranges.ts';

/*
 * Worker-only semantic binding extraction. Slang objects (cursors, references, definitions)
 * never leave this module: the job returns plain site records. Slang's lazy binding engine has no
 * internal node counter, so it is bounded by the component inputs, the request's record allowance
 * and the parent's killable wall-clock deadline. Every explicit CST visit below is counted.
 */

const CONTRACT_KINDS: ReadonlySet<string> = new Set([
  'ContractDefinition',
  'InterfaceDefinition',
  'LibraryDefinition',
]);
const DEFINIENS_PATTERN: RegExp = /^[A-Za-z]{1,64}$/u;

class SemanticReject extends Error {
  public readonly reason: SemanticUnavailableReason;

  public constructor(reason: SemanticUnavailableReason) {
    super('Semantic component analysis was rejected.');
    this.name = 'SemanticReject';
    this.reason = reason;
  }
}

interface MemberView {
  readonly fileId: FileId;
  readonly parserText: string;
  readonly hasLeadingBom: boolean;
  readonly parserIndex: SourceCoordinateIndex;
  readonly originalIndex: SourceCoordinateIndex;
}

/** Counts explicit CST visits against the job total and the per-file cap. */
class NodeBudget {
  readonly #total: number;
  readonly #perFile: number;
  #used = 0;
  #fileUsed = 0;

  public constructor(total: number, perFile: number) {
    this.#total = total;
    this.#perFile = perFile;
  }

  public get used(): number {
    return this.#used;
  }

  public beginFile(): void {
    this.#fileUsed = 0;
  }

  public charge(): void {
    if (this.#used >= this.#total || this.#fileUsed >= this.#perFile) {
      throw new SemanticReject('limit');
    }
    this.#used += 1;
    this.#fileUsed += 1;
  }
}

class RecordBudget {
  #remaining: number;

  public constructor(maximum: number) {
    this.#remaining = maximum;
  }

  public spend(count: number): void {
    if (count > this.#remaining) throw new SemanticReject('limit');
    this.#remaining -= count;
  }
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

function rangeKey(fileId: string, startByte: number, endByte: number): string {
  return `${fileId}\u0000${startByte}\u0000${endByte}`;
}

function mapRange(
  range: Parameters<SourceCoordinateIndex['toOriginalRange']>[0],
  view: MemberView,
): SourceRange {
  const mapped = view.parserIndex.toOriginalRange(range, view.hasLeadingBom);
  if (!isValidDomainRange(mapped, view.originalIndex)) {
    throw new SemanticReject('binding-failed');
  }
  return mapped;
}

/** First non-trivia child, or null. Every visited child is charged. */
function firstChild(cursor: Cursor, budget: NodeBudget): Cursor | null {
  const child = cursor.clone();
  if (!child.goToFirstChild()) return null;
  let next = true;
  while (next) {
    budget.charge();
    const node = child.node;
    if (!(node.isTerminalNode() && TerminalKindExtensions.isTrivia(node.kind))) return child;
    next = child.goToNextSibling();
  }
  return null;
}

/** First direct child with `label`, or null. Every visited child is charged. */
function childWithLabel(cursor: Cursor, label: string, budget: NodeBudget): Cursor | null {
  const child = cursor.clone();
  if (!child.goToFirstChild()) return null;
  let next = true;
  while (next) {
    budget.charge();
    if (String(child.label) === label) return child;
    next = child.goToNextSibling();
  }
  return null;
}

/** Slang wraps operands in `Expression`; returns the wrapped node, or the node itself. */
function unwrapExpression(cursor: Cursor, budget: NodeBudget): Cursor | null {
  if (String(cursor.node.kind) !== 'Expression') return cursor;
  return firstChild(cursor, budget);
}

interface ExtractionContext {
  readonly views: ReadonlyMap<string, MemberView>;
  readonly graph: CompilationUnit['bindingGraph'];
  readonly budget: NodeBudget;
  readonly records: RecordBudget;
  readonly baseSites: SemanticBaseSite[];
  readonly callSites: SemanticCallSite[];
}

function definitionsAt(cursor: Cursor, context: ExtractionContext): SemanticDefinition[] {
  const reference = context.graph.referenceAt(cursor);
  if (reference === undefined) return [];
  const definitions = reference.definitions();
  if (definitions.length > MAX_SEMANTIC_DEFINITIONS_PER_REFERENCE) {
    throw new SemanticReject('limit');
  }
  context.records.spend(definitions.length);
  const result: SemanticDefinition[] = [];
  for (const definition of definitions) {
    const nameLocation = definition.nameLocation.asUserFileLocation();
    if (nameLocation === undefined) {
      result.push({ kind: 'builtin' });
      continue;
    }
    const view = context.views.get(nameLocation.fileId);
    if (view === undefined) throw new SemanticReject('binding-failed');
    const definiensLocation = definition.definiensLocation.asUserFileLocation();
    const label =
      definiensLocation === undefined ? 'Unknown' : String(definiensLocation.cursor.node.kind);
    result.push({
      kind: 'user',
      fileId: view.fileId,
      nameRange: mapRange(nameLocation.cursor.textRange, view),
      definiens: DEFINIENS_PATTERN.test(label) ? label : 'Unknown',
    });
  }
  return result;
}

function receiverOf(
  access: Cursor,
  context: ExtractionContext,
): { readonly kind: SemanticReceiverKind; readonly definitions: SemanticDefinition[] } {
  const object = childWithLabel(access, 'Operand', context.budget);
  const receiver = object === null ? null : unwrapExpression(object, context.budget);
  if (receiver === null) return { kind: 'other', definitions: [] };
  const node = receiver.node;
  if (node.isTerminalNode()) {
    const kind = String(node.kind);
    if (kind === 'ThisKeyword') return { kind: 'this', definitions: [] };
    if (kind === 'SuperKeyword') return { kind: 'super', definitions: [] };
    if (kind === 'Identifier') {
      return { kind: 'identifier', definitions: definitionsAt(receiver, context) };
    }
  }
  return { kind: 'other', definitions: [] };
}

function callSiteAt(cursor: Cursor, view: MemberView, context: ExtractionContext): void {
  const range = mapRange(cursor.textRange, view);
  context.records.spend(1);
  const operand = childWithLabel(cursor, 'Operand', context.budget);
  let target = operand === null ? null : unwrapExpression(operand, context.budget);
  if (target !== null && String(target.node.kind) === 'CallOptionsExpression') {
    const inner = childWithLabel(target, 'Operand', context.budget);
    target = inner === null ? null : unwrapExpression(inner, context.budget);
  }
  let callee: SemanticCalleeKind = 'other';
  let definitions: SemanticDefinition[] = [];
  let receiverKind: SemanticReceiverKind = 'none';
  let receiverDefinitions: SemanticDefinition[] = [];
  if (target !== null) {
    const kind = String(target.node.kind);
    if (kind === 'MemberAccessExpression') {
      const member = childWithLabel(target, 'Member', context.budget);
      if (member !== null && member.node.isTerminalNode()) {
        if (member.node.unparse().length > MAX_DECLARATION_NAME_CODE_UNITS) {
          throw new SemanticReject('limit');
        }
        callee = 'member';
        definitions = definitionsAt(member, context);
        const receiver = receiverOf(target, context);
        receiverKind = receiver.kind;
        receiverDefinitions = receiver.definitions;
      }
    } else if (kind === 'Identifier' && target.node.isTerminalNode()) {
      callee = 'identifier';
      definitions = definitionsAt(target, context);
    } else if (kind === 'NewExpression') {
      callee = 'new';
    } else if (kind === 'ElementaryType') {
      callee = 'elementary-type';
    }
  }
  context.callSites.push({
    fileId: view.fileId,
    range,
    callee,
    definitions,
    receiver: receiverKind,
    receiverDefinitions,
  });
}

function baseSiteAt(
  cursor: Cursor,
  view: MemberView,
  contract: { readonly startByte: number; ordinal: number },
  context: ExtractionContext,
): void {
  const path = childWithLabel(cursor, 'TypeName', context.budget);
  if (path === null) throw new SemanticReject('binding-failed');
  let last: Cursor | null = null;
  const child = path.clone();
  if (child.goToFirstChild()) {
    let next = true;
    while (next) {
      context.budget.charge();
      if (child.node.isTerminalNode() && String(child.node.kind) === 'Identifier') {
        last = child.clone();
      }
      next = child.goToNextSibling();
    }
  }
  if (last === null) throw new SemanticReject('binding-failed');
  if (contract.ordinal > MAX_SEMANTIC_ORDINAL) throw new SemanticReject('limit');
  context.records.spend(1);
  context.baseSites.push({
    fileId: view.fileId,
    contractStartByte: contract.startByte,
    ordinal: contract.ordinal,
    reference: mapRange(last.textRange, view),
    definitions: definitionsAt(last, context),
  });
  contract.ordinal += 1;
}

/** Traverses one file, returning the original-byte ranges of its import path literals. */
function extractFile(
  view: MemberView,
  unit: CompilationUnit,
  context: ExtractionContext,
): SourceRange[] {
  const file = unit.file(view.fileId);
  if (file === undefined) throw new SemanticReject('binding-failed');
  const cursor = file.createTreeCursor();
  context.budget.beginFile();
  const contracts: { readonly depth: number; readonly startByte: number; ordinal: number }[] = [];
  const importFrames: { readonly depth: number; literal: SourceRange | null }[] = [];
  const literals: SourceRange[] = [];
  const closeImport = (): void => {
    const frame = importFrames.pop();
    if (frame === undefined) return;
    if (frame.literal === null) throw new SemanticReject('import-mapping');
    literals.push(frame.literal);
  };
  let next = true;
  while (next) {
    context.budget.charge();
    const depth = cursor.depth;
    while (contracts.length > 0 && (contracts.at(-1)?.depth ?? -1) >= depth) contracts.pop();
    while (importFrames.length > 0 && (importFrames.at(-1)?.depth ?? -1) >= depth) closeImport();
    const node = cursor.node;
    if (node.isTerminalNode()) {
      const frame = importFrames.at(-1);
      if (
        frame !== undefined &&
        frame.literal === null &&
        String(node.kind).includes('StringLiteral')
      ) {
        frame.literal = mapRange(cursor.textRange, view);
      }
    } else {
      const kind = String(node.kind);
      if (kind === 'ImportDirective') {
        importFrames.push({ depth, literal: null });
      } else if (CONTRACT_KINDS.has(kind)) {
        contracts.push({
          depth,
          startByte: mapRange(cursor.textRange, view).startByte,
          ordinal: 0,
        });
      } else if (kind === 'InheritanceType') {
        const contract = contracts.at(-1);
        if (contract !== undefined) baseSiteAt(cursor, view, contract, context);
      } else if (kind === 'FunctionCallExpression') {
        callSiteAt(cursor, view, context);
      }
    }
    next = cursor.goToNext();
  }
  while (importFrames.length > 0) closeImport();
  return literals;
}

function validateRequest(
  request: SemanticWorkerRequest,
  installedVersions: readonly string[],
): { readonly views: Map<string, MemberView>; readonly lookups: Map<string, FileId> } {
  if (!installedVersions.includes(request.grammar)) throw new SemanticReject('grammar-unavailable');
  if (request.files.length === 0 || request.files.length > request.maxFiles) {
    throw new SemanticReject('invalid-request');
  }
  const first = request.files[0];
  if (first === undefined || first.fileId !== request.componentId) {
    throw new SemanticReject('invalid-request');
  }
  const views = new Map<string, MemberView>();
  let totalBytes = 0;
  let previous: string | null = null;
  for (const file of request.files) {
    if (previous !== null && compareCodePoints(previous, file.fileId) >= 0) {
      throw new SemanticReject('invalid-request');
    }
    previous = file.fileId;
    let expectedId: FileId;
    try {
      expectedId = fileIdentity(file.canonicalPath);
    } catch {
      throw new SemanticReject('invalid-request');
    }
    if (expectedId !== file.fileId) throw new SemanticReject('invalid-request');
    const bytes = Buffer.from(file.originalText, 'utf8');
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > request.maxFileBytes || totalBytes > request.maxBytes) {
      throw new SemanticReject('limit');
    }
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new SemanticReject('source-mismatch');
    }
    if (
      decoded !== file.originalText ||
      createHash('sha256').update(bytes).digest('hex') !== file.byteHash
    ) {
      throw new SemanticReject('source-mismatch');
    }
    const view = parserSourceView(file.originalText);
    views.set(file.fileId, {
      fileId: file.fileId,
      parserText: view.parserText,
      hasLeadingBom: view.hasLeadingBom,
      parserIndex: new SourceCoordinateIndex(view.parserText),
      originalIndex: new SourceCoordinateIndex(file.originalText),
    });
  }
  const lookups = new Map<string, FileId>();
  for (const lookup of request.imports) {
    const importer = views.get(lookup.importerFileId);
    if (importer === undefined || !views.has(lookup.targetFileId)) {
      throw new SemanticReject('invalid-request');
    }
    if (!isValidDomainRange(lookup.specifierRange, importer.originalIndex)) {
      throw new SemanticReject('invalid-request');
    }
    const key = rangeKey(
      lookup.importerFileId,
      lookup.specifierRange.startByte,
      lookup.specifierRange.endByte,
    );
    if (lookups.has(key)) throw new SemanticReject('import-mapping');
    lookups.set(key, lookup.targetFileId);
  }
  return { views, lookups };
}

export interface SemanticJobOutcome {
  readonly consumedNodes: number;
  readonly result: SemanticComponentResult;
}

/**
 * Binds one import-connected component under one common grammar. Callbacks read only the supplied
 * in-memory map; unknown callbacks return unavailable and the job reports a fixed reason.
 */
export async function analyzeSemanticComponent(
  request: SemanticWorkerRequest,
  installedVersions: readonly string[],
): Promise<SemanticJobOutcome> {
  const budget = new NodeBudget(request.maxAstNodesRemaining, request.maxAstNodesPerFile);
  try {
    const { views, lookups } = validateRequest(request, installedVersions);
    const parser = Parser.create(request.grammar);
    for (const file of request.files) {
      const view = views.get(file.fileId);
      if (view === undefined) throw new SemanticReject('invalid-request');
      const output = parser.parseFileContents(view.parserText);
      if (!output.isValid()) throw new SemanticReject('syntax-invalid');
      const reconstructed = `${view.hasLeadingBom ? '﻿' : ''}${output.tree.unparse()}`;
      if (reconstructed !== file.originalText) throw new SemanticReject('source-mismatch');
    }

    const used = new Set<string>();
    let misses = 0;
    const builder = CompilationBuilder.create({
      languageVersion: request.grammar,
      readFile: async (fileId) => views.get(fileId)?.parserText,
      resolveImport: async (sourceFileId, importPath) => {
        const view = views.get(sourceFileId);
        if (view === undefined) {
          misses += 1;
          return undefined;
        }
        try {
          const range = mapRange(importPath.textRange, view);
          const key = rangeKey(sourceFileId, range.startByte, range.endByte);
          const target = lookups.get(key);
          if (target === undefined) {
            misses += 1;
            return undefined;
          }
          used.add(key);
          return target;
        } catch {
          misses += 1;
          return undefined;
        }
      },
    });
    for (const file of request.files) await builder.addFile(file.fileId);
    const unit = builder.build();
    const unitFiles = unit.files();
    if (unitFiles.length !== request.files.length) throw new SemanticReject('binding-failed');
    for (const file of unitFiles) {
      if (!views.has(file.id) || file.errors().length > 0) {
        throw new SemanticReject('syntax-invalid');
      }
    }

    const context: ExtractionContext = {
      views,
      graph: unit.bindingGraph,
      budget,
      records: new RecordBudget(request.maxRecords),
      baseSites: [],
      callSites: [],
    };
    const literalKeys = new Set<string>();
    for (const file of request.files) {
      const view = views.get(file.fileId);
      if (view === undefined) throw new SemanticReject('invalid-request');
      for (const literal of extractFile(view, unit, context)) {
        const key = rangeKey(file.fileId, literal.startByte, literal.endByte);
        if (literalKeys.has(key)) throw new SemanticReject('import-mapping');
        literalKeys.add(key);
      }
    }
    if (
      misses > 0 ||
      literalKeys.size !== lookups.size ||
      used.size !== lookups.size ||
      [...lookups.keys()].some((key) => !literalKeys.has(key))
    ) {
      throw new SemanticReject('import-mapping');
    }

    const baseSites = context.baseSites.sort(
      (left, right) =>
        compareCodePoints(left.fileId, right.fileId) ||
        left.contractStartByte - right.contractStartByte ||
        left.ordinal - right.ordinal,
    );
    const callSites = context.callSites.sort(
      (left, right) =>
        compareCodePoints(left.fileId, right.fileId) ||
        left.range.startByte - right.range.startByte ||
        left.range.endByte - right.range.endByte,
    );
    return {
      consumedNodes: budget.used,
      result: { status: 'bound', grammar: request.grammar, baseSites, callSites },
    };
  } catch (error: unknown) {
    const reason: SemanticUnavailableReason =
      error instanceof SemanticReject ? error.reason : 'binding-failed';
    return { consumedNodes: budget.used, result: { status: 'unavailable', reason } };
  }
}
