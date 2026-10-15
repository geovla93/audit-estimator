import { createHash } from 'node:crypto';
import {
  callableIdentity,
  contractIdentity,
  edgeIdentity,
  fileIdentity,
} from '../domain/canonical.ts';
import type { CallableId, ContractId, Diagnostic, FileId, SourceRange } from '../domain/types.ts';
import { Parser } from '@nomicfoundation/slang/parser';
import { LanguageFacts } from '@nomicfoundation/slang/utils';
import { TerminalKindExtensions } from '@nomicfoundation/slang/cst';
import type { ParseOutput } from '@nomicfoundation/slang/parser';
import type { TextRange } from '@nomicfoundation/slang/cst';
import { isValidDomainRange, parserSourceView, SourceCoordinateIndex } from './ranges.ts';
import type { LanguageVersionAuthority, LanguageVersionEvidence } from './version-policy.ts';
import { selectLanguageVersion } from './version-policy.ts';
import type {
  ParseFileResult,
  ParserAttribute,
  ParserDeclaration,
  ParserEvent,
  ParserImport,
  ParserToken,
  ParserVersionRecord,
  ParserWorkerRequest,
} from './protocol.ts';
import {
  MAX_DECLARATION_NAME_CODE_UNITS,
  MAX_DIAGNOSTICS_PER_FILE,
  MAX_IMPORT_SPECIFIER_CODE_UNITS,
} from './protocol.ts';

const MAX_TOKENS_PER_FILE: number = 2_000_000;
const MAX_ATTRIBUTES_PER_RECORD: number = 32;

interface WorkCounter {
  readonly maximum: number;
  readonly maximumImports: number;
  used: number;
  imports: number;
}

interface PragmaProbe {
  readonly hasVersionPragma: boolean;
  readonly malformed: boolean;
  readonly versionRanges: readonly SourceRange[];
  readonly directiveRanges: readonly SourceRange[];
}

interface ExtractedSyntax {
  readonly tokens: readonly ParserToken[];
  readonly declarations: readonly ParserDeclaration[];
  readonly imports: readonly ParserImport[];
  readonly events: readonly ParserEvent[];
}

class TraversalLimit extends Error {
  public constructor() {
    super('Parser traversal allowance exhausted.');
    this.name = 'TraversalLimit';
  }
}

function charge(work: WorkCounter): void {
  if (work.used >= work.maximum) throw new TraversalLimit();
  work.used += 1;
}

function failure(
  fileId: FileId,
  code: 'LANGUAGE_UNSUPPORTED' | 'PARSE_INVALID' | 'LIMIT_EXCEEDED' | 'INTERNAL_ERROR',
  message: string,
  range?: SourceRange,
): ParseFileResult {
  const diagnostic: Diagnostic = {
    code,
    severity: code === 'PARSE_INVALID' || code === 'INTERNAL_ERROR' ? 'error' : 'warning',
    phase: 'parse',
    message,
    fileId,
    ...(range === undefined ? {} : { range }),
  };
  return { status: 'failed', fileId, code, diagnostics: [diagnostic] };
}

function warning(fileId: FileId, message: string): Diagnostic {
  return {
    code: 'LANGUAGE_UNSUPPORTED',
    severity: 'warning',
    phase: 'parse',
    message,
    fileId,
  };
}

function mapRange(
  range: TextRange,
  parserIndex: SourceCoordinateIndex,
  hasLeadingBom: boolean,
  originalIndex: SourceCoordinateIndex,
): SourceRange {
  const mapped = parserIndex.toOriginalRange(range, hasLeadingBom);
  if (!isValidDomainRange(mapped, originalIndex)) {
    throw new TypeError('Slang returned a source range outside the original snapshot.');
  }
  return mapped;
}

function rangesTouch(left: TextRange, right: TextRange): boolean {
  return left.start.utf16 <= right.end.utf16 && right.start.utf16 <= left.end.utf16;
}

function inspectPragmas(
  output: ParseOutput,
  work: WorkCounter,
  parserIndex: SourceCoordinateIndex,
  originalIndex: SourceCoordinateIndex,
  hasLeadingBom: boolean,
): PragmaProbe {
  const versionRanges: SourceRange[] = [];
  const directiveRanges: SourceRange[] = [];
  const directiveTextRanges: TextRange[] = [];
  const frames: {
    readonly depth: number;
    hasClause: boolean;
    malformed: boolean;
  }[] = [];
  let directiveCount = 0;
  let keywordCount = 0;
  let malformed = false;
  const cursor = output.createTreeCursor();
  let next = true;
  while (next) {
    charge(work);
    const depth = cursor.depth;
    while (frames.length > 0 && (frames.at(-1)?.depth ?? -1) >= depth) {
      const frame = frames.pop();
      if (frame !== undefined && (!frame.hasClause || frame.malformed)) malformed = true;
    }
    const node = cursor.node;
    const kind = node.isTerminalNode() ? String(node.kind) : String(node.kind);
    if (!node.isTerminalNode() && kind === 'PragmaDirective') {
      directiveCount += 1;
      const range = cursor.textRange;
      frames.push({
        depth,
        hasClause: false,
        malformed: false,
      });
      directiveRanges.push(mapRange(range, parserIndex, hasLeadingBom, originalIndex));
      directiveTextRanges.push(range);
    } else {
      const frame = frames.at(-1);
      if (frame !== undefined && depth > frame.depth && !node.isTerminalNode()) {
        if (kind === 'VersionPragma') {
          frame.hasClause = true;
          versionRanges.push(mapRange(cursor.textRange, parserIndex, hasLeadingBom, originalIndex));
        } else if (kind.endsWith('Pragma') && kind !== 'Pragma') {
          frame.hasClause = true;
        }
      }
      if (node.isTerminalNode()) {
        if (kind === 'PragmaKeyword') {
          keywordCount += 1;
          if (frame === undefined || depth <= frame.depth) malformed = true;
        }
        if (
          frame !== undefined &&
          depth > frame.depth &&
          (kind === 'Missing' || kind === 'Unrecognized')
        ) {
          frame.malformed = true;
        }
      }
    }
    next = cursor.goToNext();
  }
  while (frames.length > 0) {
    const frame = frames.pop();
    if (frame !== undefined && (!frame.hasClause || frame.malformed)) malformed = true;
  }

  if (keywordCount !== directiveCount) malformed = true;
  const errors = output.errors();
  if (errors.length > MAX_DIAGNOSTICS_PER_FILE) throw new TraversalLimit();
  for (const error of errors) {
    for (const range of directiveTextRanges) {
      if (rangesTouch(error.textRange, range)) malformed = true;
    }
  }
  return {
    hasVersionPragma: versionRanges.length > 0,
    malformed,
    versionRanges,
    directiveRanges,
  };
}

function diagnosticRanges(
  output: ParseOutput,
  fileId: FileId,
  parserIndex: SourceCoordinateIndex,
  originalIndex: SourceCoordinateIndex,
  hasLeadingBom: boolean,
): readonly Diagnostic[] {
  const errors = output.errors();
  if (errors.length > MAX_DIAGNOSTICS_PER_FILE) throw new TraversalLimit();
  const diagnostics: Diagnostic[] = [];
  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index];
    if (error === undefined) continue;
    const range = mapRange(error.textRange, parserIndex, hasLeadingBom, originalIndex);
    diagnostics.push({
      code: 'PARSE_INVALID',
      severity: 'error',
      phase: 'parse',
      message: 'The Solidity file contains invalid syntax.',
      fileId,
      range,
    });
  }
  if (diagnostics.length === 0) {
    diagnostics.push({
      code: 'PARSE_INVALID',
      severity: 'error',
      phase: 'parse',
      message: 'The Solidity file contains invalid syntax.',
      fileId,
    });
  }
  return diagnostics;
}

interface ActiveContract {
  readonly depth: number;
  readonly id: ContractId;
}

interface PendingDeclaration {
  readonly depth: number;
  readonly kind: string;
  readonly id: ContractId | CallableId;
  readonly contractId: ContractId | null;
  readonly callableId: CallableId | null;
  readonly startRange: SourceRange;
  name: string | null;
  nameRange: SourceRange | null;
  bodyRange: SourceRange | null;
  bodyStartRange: SourceRange | null;
  hasBody: boolean;
  explicitVisibility: string | null;
  explicitMutability: string | null;
  attributeContainerDepth: number | null;
  attributeItemDepth: number | null;
  functionBodyDepth: number | null;
  isAbstract: boolean;
}

type ImportSpecifierDecode =
  | { readonly status: 'decoded'; readonly value: string }
  | { readonly status: 'invalid-literal' }
  | { readonly status: 'invalid-utf8' }
  | { readonly status: 'too-long' };

class UnsupportedImportEncoding extends Error {
  public constructor() {
    super('The parser could not represent an import path as UTF-8.');
    this.name = 'UnsupportedImportEncoding';
  }
}

function declarationKind(kind: string, abstract: boolean): string | null {
  if (kind === 'ContractDefinition') return abstract ? 'abstract-contract' : 'contract';
  if (kind === 'LibraryDefinition') return 'library';
  if (kind === 'InterfaceDefinition') return 'interface';
  if (kind === 'FunctionDefinition' || kind === 'FreeFunctionDefinition') return 'function';
  if (kind === 'ConstructorDefinition') return 'constructor';
  if (kind === 'FallbackFunctionDefinition' || kind === 'UnnamedFunctionDefinition')
    return 'fallback';
  if (kind === 'ReceiveFunctionDefinition') return 'receive';
  if (kind === 'ModifierDefinition') return 'modifier';
  return null;
}

function directHasLabel(
  cursor: ReturnType<ParseOutput['createTreeCursor']>,
  label: string,
  work: WorkCounter,
): boolean {
  const child = cursor.clone();
  if (!child.goToFirstChild()) return false;
  let next = true;
  while (next) {
    charge(work);
    if (String(child.label) === label) return true;
    next = child.goToNextSibling();
  }
  return false;
}

function terminalTokenKind(
  kind: string,
  text: string,
  nodeKind: Parameters<typeof TerminalKindExtensions.isTrivia>[0],
): ParserToken['kind'] {
  if (TerminalKindExtensions.isTrivia(nodeKind)) {
    if (text.startsWith('///') || text.startsWith('/**')) return 'natspec';
    if (text.startsWith('//') || text.startsWith('/*')) return 'comment';
    return 'whitespace';
  }
  if (kind === 'Missing' || kind === 'Unrecognized') return 'unknown';
  if (TerminalKindExtensions.isIdentifier(nodeKind)) return 'identifier';
  if (kind.includes('StringLiteral')) return 'string';
  if (kind.endsWith('Keyword')) return 'keyword';
  if (/^[+\-*/%<>=!&|^~?:]+$/u.test(text)) return 'operator';
  if (/^[{}()[\].,;]$/u.test(text)) return 'punctuation';
  return 'unknown';
}

function decodeImportSpecifier(raw: string): ImportSpecifierDecode {
  if (raw.length < 2) return { status: 'invalid-literal' };
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw.at(-1) !== quote)
    return { status: 'invalid-literal' };
  const bytes: number[] = [];
  const maximumBytes = MAX_IMPORT_SPECIFIER_CODE_UNITS * 4;
  const appendBytes = (content: Uint8Array): boolean => {
    if (bytes.length + content.byteLength > maximumBytes) return false;
    for (const byte of content) bytes.push(byte);
    return true;
  };
  const appendByte = (byte: number): boolean => {
    if (bytes.length >= maximumBytes) return false;
    bytes.push(byte);
    return true;
  };
  for (let index = 1; index < raw.length - 1; index += 1) {
    const character = raw[index];
    if (character !== '\\') {
      if (character === undefined) return { status: 'invalid-literal' };
      const codePoint = raw.codePointAt(index);
      if (codePoint === undefined) return { status: 'invalid-literal' };
      const literal = String.fromCodePoint(codePoint);
      if (!appendBytes(Buffer.from(literal, 'utf8'))) return { status: 'too-long' };
      if (codePoint > 0xffff) index += 1;
      continue;
    }
    index += 1;
    const escaped = raw[index];
    if (escaped === undefined) return { status: 'invalid-literal' };
    if (escaped === '\n') continue;
    if (escaped === '\r') {
      if (raw[index + 1] === '\n') index += 1;
      continue;
    }
    if (escaped === 'n') {
      if (!appendByte(0x0a)) return { status: 'too-long' };
    } else if (escaped === 'r') {
      if (!appendByte(0x0d)) return { status: 'too-long' };
    } else if (escaped === 't') {
      if (!appendByte(0x09)) return { status: 'too-long' };
    } else if (escaped === 'b') {
      if (!appendByte(0x08)) return { status: 'too-long' };
    } else if (escaped === 'f') {
      if (!appendByte(0x0c)) return { status: 'too-long' };
    } else if (escaped === 'v') {
      if (!appendByte(0x0b)) return { status: 'too-long' };
    } else if (escaped === '\\' || escaped === '"' || escaped === "'" || escaped === '/') {
      if (!appendByte(escaped.charCodeAt(0))) return { status: 'too-long' };
    } else if (escaped === 'x' || escaped === 'u') {
      const digits = escaped === 'x' ? 2 : 4;
      const value = raw.slice(index + 1, index + 1 + digits);
      if (value.length !== digits || !/^[0-9a-fA-F]+$/u.test(value))
        return { status: 'invalid-literal' };
      const codePoint = Number.parseInt(value, 16);
      if (escaped === 'x') {
        if (!appendByte(codePoint)) return { status: 'too-long' };
      } else {
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
          return { status: 'invalid-utf8' };
        }
        if (!appendBytes(Buffer.from(String.fromCodePoint(codePoint), 'utf8')))
          return { status: 'too-long' };
      }
      index += digits;
    } else {
      return { status: 'invalid-literal' };
    }
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    return { status: 'invalid-utf8' };
  }
  if (decoded.length > MAX_IMPORT_SPECIFIER_CODE_UNITS) return { status: 'too-long' };
  return { status: 'decoded', value: decoded };
}

function expectedAttributeContainer(declarationKind: string, cstKind: string): boolean {
  if (declarationKind === 'function') return cstKind === 'FunctionAttributes';
  if (declarationKind === 'constructor') return cstKind === 'ConstructorAttributes';
  if (declarationKind === 'fallback') {
    return cstKind === 'FallbackFunctionAttributes' || cstKind === 'UnnamedFunctionAttributes';
  }
  if (declarationKind === 'receive') return cstKind === 'ReceiveFunctionAttributes';
  if (declarationKind === 'modifier') return cstKind === 'ModifierAttributes';
  return false;
}

function expectedAttributeItem(declarationKind: string, cstKind: string): boolean {
  if (declarationKind === 'function') return cstKind === 'FunctionAttribute';
  if (declarationKind === 'constructor') return cstKind === 'ConstructorAttribute';
  if (declarationKind === 'fallback') {
    return cstKind === 'FallbackFunctionAttribute' || cstKind === 'UnnamedFunctionAttribute';
  }
  if (declarationKind === 'receive') return cstKind === 'ReceiveFunctionAttribute';
  if (declarationKind === 'modifier') return cstKind === 'ModifierAttribute';
  return false;
}

function extractSyntax(
  output: ParseOutput,
  request: ParserWorkerRequest,
  work: WorkCounter,
  parserIndex: SourceCoordinateIndex,
  originalIndex: SourceCoordinateIndex,
  hasLeadingBom: boolean,
  maximumImports: number,
): ExtractedSyntax {
  const tokens: ParserToken[] = [];
  const declarations: ParserDeclaration[] = [];
  const imports: ParserImport[] = [];
  const events: ParserEvent[] = [];
  const contracts: ActiveContract[] = [];
  const pending: PendingDeclaration[] = [];
  const labelAtDepth: string[] = [];
  const pragmaFrames: {
    readonly depth: number;
    readonly start: SourceRange;
    kind: 'solidity' | 'other';
  }[] = [];
  const importFrames: {
    readonly depth: number;
    readonly range: SourceRange;
    aliasForm: ParserImport['aliasForm'];
    literal: {
      readonly raw: string;
      readonly range: SourceRange;
      readonly startUtf16: number;
    } | null;
  }[] = [];
  let importOrdinal = 0;

  const cursor = output.createTreeCursor();
  let next = true;
  while (next) {
    charge(work);
    const depth = cursor.depth;
    labelAtDepth[depth] = String(cursor.label);
    labelAtDepth.length = depth + 1;
    while (contracts.length > 0 && (contracts.at(-1)?.depth ?? -1) >= depth) contracts.pop();
    while (pending.length > 0 && (pending.at(-1)?.depth ?? -1) >= depth) {
      const item = pending.pop();
      if (item !== undefined) finalizeDeclaration(item, declarations, events, request.fileId);
    }
    while (pragmaFrames.length > 0 && (pragmaFrames.at(-1)?.depth ?? -1) >= depth) {
      const pragma = pragmaFrames.pop();
      if (pragma !== undefined) {
        events.push({
          fileId: request.fileId,
          kind: 'pragma',
          contractId: null,
          callableId: null,
          range: pragma.start,
          attributes: [{ key: 'pragma-kind', value: pragma.kind }],
        });
      }
    }
    while (importFrames.length > 0 && (importFrames.at(-1)?.depth ?? -1) >= depth) {
      const item = importFrames.pop();
      if (item !== undefined) {
        if (item.literal === null) throw new TypeError('A valid import has no path literal.');
        if (imports.length >= maximumImports) {
          throw new TraversalLimit();
        }
        const decoded = decodeImportSpecifier(item.literal.raw);
        if (decoded.status === 'too-long') throw new TraversalLimit();
        if (decoded.status !== 'decoded') throw new UnsupportedImportEncoding();
        const aliasForm = item.aliasForm;
        const id = edgeIdentity(
          request.canonicalPath,
          'import',
          item.range.startByte,
          importOrdinal,
        );
        importOrdinal += 1;
        const record: ParserImport = {
          id,
          specifier: decoded.value,
          range: item.range,
          specifierRange: item.literal.range,
          aliasForm,
        };
        imports.push(record);
        events.push({
          fileId: request.fileId,
          kind: 'import',
          contractId: null,
          callableId: null,
          range: item.range,
          attributes: [{ key: 'alias-form', value: aliasForm }],
        });
      }
    }

    const node = cursor.node;
    const kind = String(node.kind);
    const currentDeclaration = pending.at(-1);
    if (currentDeclaration !== undefined) {
      if (
        currentDeclaration.attributeItemDepth !== null &&
        depth <= currentDeclaration.attributeItemDepth
      ) {
        currentDeclaration.attributeItemDepth = null;
      }
      if (
        currentDeclaration.attributeContainerDepth !== null &&
        depth <= currentDeclaration.attributeContainerDepth
      ) {
        currentDeclaration.attributeContainerDepth = null;
      }
      if (
        currentDeclaration.functionBodyDepth !== null &&
        depth <= currentDeclaration.functionBodyDepth
      ) {
        currentDeclaration.functionBodyDepth = null;
      }
    }
    if (!node.isTerminalNode()) {
      if (kind === 'PragmaDirective') {
        const frame: {
          readonly depth: number;
          readonly start: SourceRange;
          kind: 'solidity' | 'other';
        } = {
          depth,
          start: mapRange(cursor.textRange, parserIndex, hasLeadingBom, originalIndex),
          kind: 'other',
        };
        pragmaFrames.push(frame);
      } else if (kind === 'VersionPragma') {
        const frame = pragmaFrames.at(-1);
        if (frame !== undefined) frame.kind = 'solidity';
      }

      if (kind === 'ImportDirective') {
        if (work.imports >= work.maximumImports) throw new TraversalLimit();
        work.imports += 1;
        importFrames.push({
          depth,
          range: mapRange(cursor.textRange, parserIndex, hasLeadingBom, originalIndex),
          aliasForm: 'bare',
          literal: null,
        });
      }
      const importFrame = importFrames.at(-1);
      if (importFrame !== undefined) {
        if (kind === 'NamedImport') importFrame.aliasForm = 'namespace';
        if (kind === 'ImportDeconstruction') importFrame.aliasForm = 'named';
        if (String(cursor.label) === 'Alias' && importFrame.aliasForm === 'bare') {
          importFrame.aliasForm = 'namespace';
        }
      }

      const parentContract = contracts.at(-1)?.id ?? null;
      const declaredKind = declarationKind(
        kind,
        kind === 'ContractDefinition' && directHasLabel(cursor, 'AbstractKeyword', work),
      );
      if (declaredKind !== null) {
        const range = mapRange(cursor.textRange, parserIndex, hasLeadingBom, originalIndex);
        if (
          declaredKind === 'contract' ||
          declaredKind === 'abstract-contract' ||
          declaredKind === 'library' ||
          declaredKind === 'interface'
        ) {
          const id = contractIdentity(request.canonicalPath, declaredKind, range.startByte);
          const item: PendingDeclaration = {
            depth,
            kind: declaredKind,
            id,
            contractId: id,
            callableId: null,
            startRange: range,
            name: null,
            nameRange: null,
            bodyRange: null,
            bodyStartRange: null,
            hasBody: false,
            explicitVisibility: null,
            explicitMutability: null,
            attributeContainerDepth: null,
            attributeItemDepth: null,
            functionBodyDepth: null,
            isAbstract: declaredKind === 'abstract-contract',
          };
          pending.push(item);
          contracts.push({ depth, id });
        } else {
          const id = callableIdentity(request.canonicalPath, declaredKind, range.startByte);
          pending.push({
            depth,
            kind: declaredKind,
            id,
            contractId: parentContract,
            callableId: id,
            startRange: range,
            name: null,
            nameRange: null,
            bodyRange: null,
            bodyStartRange: null,
            hasBody: false,
            explicitVisibility: null,
            explicitMutability: null,
            attributeContainerDepth: null,
            attributeItemDepth: null,
            functionBodyDepth: null,
            isAbstract: false,
          });
        }
      }

      const active = pending.at(-1);
      if (active !== undefined && depth > active.depth) {
        if (expectedAttributeContainer(active.kind, kind)) {
          active.attributeContainerDepth = depth;
        } else if (
          active.attributeContainerDepth !== null &&
          depth === active.attributeContainerDepth + 1 &&
          expectedAttributeItem(active.kind, kind)
        ) {
          active.attributeItemDepth = depth;
        }
        if (
          active.callableId !== null &&
          (kind === 'FunctionBody' ||
            (active.kind === 'constructor' &&
              kind === 'Block' &&
              String(cursor.label) === 'Body' &&
              depth === active.depth + 1))
        ) {
          active.functionBodyDepth = depth;
        } else if (
          kind === 'Block' &&
          active.callableId !== null &&
          active.functionBodyDepth === depth - 1
        ) {
          active.functionBodyDepth = depth;
        }
      }
    } else {
      const text = node.unparse();
      const range = mapRange(cursor.textRange, parserIndex, hasLeadingBom, originalIndex);
      if (tokens.length >= MAX_TOKENS_PER_FILE) throw new TraversalLimit();
      tokens.push({
        fileId: request.fileId,
        kind: terminalTokenKind(kind, text, node.kind),
        range,
      });

      const declaration = pending.at(-1);
      if (declaration !== undefined) {
        if (
          declaration.attributeItemDepth !== null &&
          depth === declaration.attributeItemDepth + 1
        ) {
          const visibility = new Map([
            ['PublicKeyword', 'public'],
            ['PrivateKeyword', 'private'],
            ['InternalKeyword', 'internal'],
            ['ExternalKeyword', 'external'],
          ]).get(kind);
          const mutability = new Map([
            ['PureKeyword', 'pure'],
            ['ViewKeyword', 'view'],
            ['PayableKeyword', 'payable'],
          ]).get(kind);
          if (visibility !== undefined) declaration.explicitVisibility = visibility;
          if (mutability !== undefined) declaration.explicitMutability = mutability;
        }
      }
      if (
        declaration !== undefined &&
        declaration.name === null &&
        TerminalKindExtensions.isIdentifier(node.kind) &&
        labelAtDepth.slice(declaration.depth + 1, depth + 1).includes('Name')
      ) {
        if (text.length > MAX_DECLARATION_NAME_CODE_UNITS) throw new TraversalLimit();
        declaration.name = text;
        declaration.nameRange = range;
      }

      const importFrame = importFrames.at(-1);
      if (
        importFrame !== undefined &&
        importFrame.literal === null &&
        kind.includes('StringLiteral')
      ) {
        importFrame.literal = { raw: text, range, startUtf16: cursor.textRange.start.utf16 };
      }
      const active = pending.at(-1);
      if (
        active !== undefined &&
        active.callableId !== null &&
        active.functionBodyDepth !== null &&
        depth === active.functionBodyDepth + 1
      ) {
        if (String(cursor.label) === 'OpenBrace' && active.bodyStartRange === null) {
          active.bodyStartRange = range;
        } else if (String(cursor.label) === 'CloseBrace' && active.bodyStartRange !== null) {
          active.bodyRange = {
            startByte: active.bodyStartRange.startByte,
            endByte: range.endByte,
            start: active.bodyStartRange.start,
            end: range.end,
          };
          active.hasBody = true;
          active.functionBodyDepth = null;
        }
      }
      if (active !== undefined && active.contractId !== null && active.callableId === null) {
        if (String(cursor.label) === 'OpenBrace' && active.bodyStartRange === null) {
          active.bodyStartRange = range;
        } else if (String(cursor.label) === 'CloseBrace' && active.bodyStartRange !== null) {
          active.bodyRange = {
            startByte: active.bodyStartRange.startByte,
            endByte: range.endByte,
            start: active.bodyStartRange.start,
            end: range.end,
          };
          active.hasBody = true;
        }
      }
    }
    next = cursor.goToNext();
  }
  while (pending.length > 0) {
    const item = pending.pop();
    if (item !== undefined) finalizeDeclaration(item, declarations, events, request.fileId);
  }
  while (pragmaFrames.length > 0) {
    const pragma = pragmaFrames.pop();
    if (pragma !== undefined) {
      events.push({
        fileId: request.fileId,
        kind: 'pragma',
        contractId: null,
        callableId: null,
        range: pragma.start,
        attributes: [{ key: 'pragma-kind', value: pragma.kind }],
      });
    }
  }
  while (importFrames.length > 0) {
    const item = importFrames.pop();
    if (item !== undefined) throw new TypeError('Import traversal did not close its directive.');
  }

  tokens.sort(compareRanges);
  declarations.sort(compareRanges);
  imports.sort(compareRanges);
  events.sort(compareRanges);
  return { tokens, declarations, imports, events };
}

function finalizeDeclaration(
  item: PendingDeclaration,
  declarations: ParserDeclaration[],
  events: ParserEvent[],
  fileId: FileId,
): void {
  const name = item.name ?? (item.kind === 'constructor' ? 'constructor' : item.kind);
  if (name.length > MAX_DECLARATION_NAME_CODE_UNITS) throw new TraversalLimit();
  const hasBody = item.hasBody;
  const attributes = makeAttributes(item, hasBody);
  const eventAttributes = attributes.filter(
    (attribute) => attribute.key === 'declaration-kind' || attribute.key === 'has-body',
  );
  declarations.push({
    id: item.id,
    kind: item.kind,
    name,
    contractId: item.contractId,
    callableId: item.callableId,
    declarationRange: item.startRange,
    nameRange: item.nameRange ?? item.startRange,
    bodyRange: hasBody ? item.bodyRange : null,
    hasBody,
    attributes,
  });
  events.push({
    fileId,
    kind: 'declaration',
    contractId: item.contractId,
    callableId: item.callableId,
    range: item.startRange,
    attributes: eventAttributes,
  });
}

function makeAttributes(item: PendingDeclaration, hasBody: boolean): readonly ParserAttribute[] {
  const attributes: ParserAttribute[] = [
    { key: 'declaration-kind', value: item.kind },
    { key: 'has-body', value: hasBody },
  ];
  if (item.explicitVisibility !== null) {
    attributes.push({ key: 'visibility', value: item.explicitVisibility });
  }
  if (item.explicitMutability !== null) {
    attributes.push({ key: 'mutability', value: item.explicitMutability });
  }
  if (item.isAbstract) attributes.push({ key: 'abstract', value: true });
  if (attributes.length > MAX_ATTRIBUTES_PER_RECORD)
    throw new TypeError('Too many parser attributes.');
  return attributes;
}

function compareRanges(
  left: {
    readonly range?: SourceRange;
    readonly declarationRange?: SourceRange;
    readonly startRange?: SourceRange;
  },
  right: {
    readonly range?: SourceRange;
    readonly declarationRange?: SourceRange;
    readonly startRange?: SourceRange;
  },
): number {
  const a = left.range ?? left.declarationRange ?? left.startRange;
  const b = right.range ?? right.declarationRange ?? right.startRange;
  if (a === undefined || b === undefined) return 0;
  if (a.startByte !== b.startByte) return a.startByte < b.startByte ? -1 : 1;
  if (a.endByte !== b.endByte) return a.endByte < b.endByte ? -1 : 1;
  return 0;
}

export interface AnalysisResult {
  readonly result: ParseFileResult;
  readonly consumedNodes: number;
  readonly consumedImports: number;
}

export function analyzeSource(
  request: ParserWorkerRequest,
  parserVersion: string,
  installedVersions: readonly string[],
): AnalysisResult {
  const fileId = fileIdentity(request.canonicalPath);
  if (fileId !== request.fileId) throw new TypeError('Parser file identity mismatch.');
  const originalBytes = Buffer.from(request.originalText, 'utf8');
  let decodedText: string;
  try {
    decodedText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(originalBytes);
  } catch {
    throw new TypeError('Parser input is not well-formed UTF-8.');
  }
  if (
    decodedText !== request.originalText ||
    originalBytes.byteLength > request.maxFileBytes ||
    createHash('sha256').update(originalBytes).digest('hex') !== request.byteHash
  ) {
    throw new TypeError('Parser source snapshot mismatch.');
  }
  const sourceView = parserSourceView(request.originalText);
  const parserIndex = new SourceCoordinateIndex(sourceView.parserText);
  const originalIndex = new SourceCoordinateIndex(request.originalText);
  const maximum = Math.min(request.maxAstNodesPerFile, request.maxAstNodesRemaining);
  const work: WorkCounter = {
    maximum,
    maximumImports: request.maxImportsRemaining,
    used: 0,
    imports: 0,
  };

  try {
    const installed = LanguageFacts.allVersions();
    if (
      installed.length !== installedVersions.length ||
      installed.some((version, index) => version !== installedVersions[index])
    ) {
      throw new TypeError('Parser grammar inventory changed after worker startup.');
    }
    const latest = LanguageFacts.latestVersion();
    const probeOutput = Parser.create(latest).parseFileContents(sourceView.parserText);
    const probe = inspectPragmas(
      probeOutput,
      work,
      parserIndex,
      originalIndex,
      sourceView.hasLeadingBom,
    );
    if (probe.malformed) {
      return {
        consumedNodes: work.used,
        consumedImports: work.imports,
        result: {
          status: 'failed',
          fileId,
          code: 'PARSE_INVALID',
          diagnostics: [
            {
              code: 'PARSE_INVALID',
              severity: 'error',
              phase: 'parse',
              message: 'The Solidity pragma is malformed.',
              fileId,
              ...(probe.versionRanges[0] === undefined ? {} : { range: probe.versionRanges[0] }),
            },
          ],
        },
      };
    }

    const compatibleVersions = LanguageFacts.inferLanguageVersions(sourceView.parserText);
    const authority: LanguageVersionAuthority = {
      source: request.versionAuthority,
      version: request.version,
    };
    const evidence: LanguageVersionEvidence = {
      installedVersions: installed,
      compatibleVersions,
      pragma: probe.hasVersionPragma ? 'valid' : 'absent',
    };
    const selection = selectLanguageVersion(evidence, authority);
    if (selection.status === 'invalid') {
      return {
        consumedNodes: work.used,
        consumedImports: work.imports,
        result: failure(fileId, 'PARSE_INVALID', 'The Solidity pragma is malformed.'),
      };
    }
    if (selection.status === 'unsupported' || selection.version === null) {
      return {
        consumedNodes: work.used,
        consumedImports: work.imports,
        result: failure(
          fileId,
          'LANGUAGE_UNSUPPORTED',
          'No installed Solidity grammar satisfies this file.',
        ),
      };
    }

    const output =
      selection.version === latest
        ? probeOutput
        : Parser.create(selection.version).parseFileContents(sourceView.parserText);
    if (!output.isValid()) {
      if (output !== probeOutput) countTree(output, work);
      return {
        consumedNodes: work.used,
        consumedImports: work.imports,
        result: {
          status: 'failed',
          fileId,
          code: 'PARSE_INVALID',
          diagnostics: diagnosticRanges(
            output,
            fileId,
            parserIndex,
            originalIndex,
            sourceView.hasLeadingBom,
          ),
        },
      };
    }

    const reconstructed = `${sourceView.hasLeadingBom ? '\uFEFF' : ''}${output.tree.unparse()}`;
    const reconstructedBytes = Buffer.from(reconstructed, 'utf8');
    if (
      !reconstructedBytes.equals(originalBytes) ||
      createHash('sha256').update(reconstructedBytes).digest('hex') !== request.byteHash
    ) {
      return {
        consumedNodes: work.used,
        consumedImports: work.imports,
        result: failure(
          fileId,
          'INTERNAL_ERROR',
          'The parser did not preserve the original source bytes.',
        ),
      };
    }

    const syntax = extractSyntax(
      output,
      request,
      work,
      parserIndex,
      originalIndex,
      sourceView.hasLeadingBom,
      work.maximumImports,
    );
    const diagnostics: Diagnostic[] = [];
    for (const item of selection.warnings) {
      if (item === 'no-version-pragma') {
        diagnostics.push(
          warning(
            fileId,
            'No Solidity version pragma is present; grammar selection used configured evidence.',
          ),
        );
      } else {
        diagnostics.push(
          warning(
            fileId,
            'The metadata Solidity version hint is unsupported or incompatible and was ignored.',
          ),
        );
      }
    }
    const version: ParserVersionRecord = {
      selectedVersion: selection.version,
      selectionSource: selection.source,
      ignoredHint: selection.ignoredHint,
      compatibleVersions: selection.compatibleVersions,
      installedVersions: installed,
      pragmaRanges: probe.versionRanges,
      parserVersion,
    };
    const result: ParseFileResult = {
      status: 'parsed',
      fileId,
      version,
      tokens: syntax.tokens,
      declarations: syntax.declarations,
      imports: syntax.imports,
      events: syntax.events,
      diagnostics,
      visitedNodes: work.used,
    };
    return { result, consumedNodes: work.used, consumedImports: work.imports };
  } catch (error: unknown) {
    if (error instanceof TraversalLimit) {
      return {
        consumedNodes: Math.min(work.used, maximum),
        consumedImports: work.imports,
        result: failure(
          fileId,
          'LIMIT_EXCEEDED',
          'Parser traversal or record limits were exceeded.',
        ),
      };
    }
    if (error instanceof UnsupportedImportEncoding) {
      return {
        consumedNodes: work.used,
        consumedImports: work.imports,
        result: failure(
          fileId,
          'INTERNAL_ERROR',
          'The parser could not represent an import path as UTF-8.',
        ),
      };
    }
    return {
      consumedNodes: work.used,
      consumedImports: work.imports,
      result: failure(
        fileId,
        'INTERNAL_ERROR',
        'The parser worker could not validate its syntax result.',
      ),
    };
  }
}

function countTree(output: ParseOutput, work: WorkCounter): void {
  const cursor = output.createTreeCursor();
  let next = true;
  while (next) {
    charge(work);
    next = cursor.goToNext();
  }
}
