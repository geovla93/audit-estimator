import type { FileId, SourceLineSet, SourceRange } from '../domain/types.ts';
import type { ParserToken } from '../parser/protocol.ts';
import { TRIVIA_TOKEN_KINDS } from './definitions.ts';

const BOM_BYTES: number = 3;
const lineStartCache: WeakMap<Uint8Array, readonly number[]> = new WeakMap();

/**
 * ADR 002 physical lines: CRLF, LF and lone CR terminate lines, a leading BOM is ignored and no
 * terminal empty segment is counted. U+2028 and U+2029 are ordinary characters here.
 */
export function countPhysicalLines(text: string): number {
  const content = text.startsWith('\uFEFF') ? text.slice(1) : text;
  if (content.length === 0) return 0;
  let terminators = 0;
  let endsWithTerminator = false;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code === 0x0d) {
      if (content.charCodeAt(index + 1) === 0x0a) index += 1;
      terminators += 1;
      endsWithTerminator = index === content.length - 1;
    } else if (code === 0x0a) {
      terminators += 1;
      endsWithTerminator = index === content.length - 1;
    } else {
      endsWithTerminator = false;
    }
  }
  return 1 + terminators - (endsWithTerminator ? 1 : 0);
}

/**
 * End-of-text position in the parser's domain coordinates (ADR 005), for evidence ranges. These
 * deliberately differ from ADR 002 line counting: U+2028 and U+2029 also start a line here.
 */
export function endOfTextPosition(text: string): {
  readonly byte: number;
  readonly line: number;
  readonly column: number;
} {
  let line = 1;
  let scalars = 0;
  let previousWasCarriageReturn = false;
  for (const scalar of text) {
    if (scalar === '\r') {
      line += 1;
      scalars = 0;
      previousWasCarriageReturn = true;
    } else if (scalar === '\n') {
      if (!previousWasCarriageReturn) line += 1;
      scalars = 0;
      previousWasCarriageReturn = false;
    } else if (scalar === '\u2028' || scalar === '\u2029') {
      line += 1;
      scalars = 0;
      previousWasCarriageReturn = false;
    } else {
      scalars += 1;
      previousWasCarriageReturn = false;
    }
  }
  return { byte: Buffer.byteLength(text, 'utf8'), line, column: scalars + 1 };
}

/** Sorted absolute byte offsets at which each ADR 002 physical line starts. */
export function buildLineStartIndex(originalBytes: Uint8Array): readonly number[] {
  const cached = lineStartCache.get(originalBytes);
  if (cached !== undefined) return cached;
  const hasBom =
    originalBytes[0] === 0xef && originalBytes[1] === 0xbb && originalBytes[2] === 0xbf;
  const first = hasBom ? BOM_BYTES : 0;
  const starts: number[] = [first];
  for (let index = first; index < originalBytes.length; index += 1) {
    const byte = originalBytes[index];
    if (byte === 0x0d) {
      if (originalBytes[index + 1] === 0x0a) index += 1;
      if (index + 1 < originalBytes.length) starts.push(index + 1);
    } else if (byte === 0x0a) {
      if (index + 1 < originalBytes.length) starts.push(index + 1);
    }
  }
  lineStartCache.set(originalBytes, starts);
  return starts;
}

/** One-based physical line containing `byte`. */
export function physicalLineAt(lineStarts: readonly number[], byte: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const start = lineStarts[middle] ?? 0;
    if (start <= byte) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found + 1;
}

function addTokenLines(
  lines: Set<number>,
  originalBytes: Uint8Array,
  lineStarts: readonly number[],
  decoder: TextDecoder,
  token: ParserToken,
): void {
  const text = decoder.decode(originalBytes.subarray(token.range.startByte, token.range.endByte));
  const firstLine = physicalLineAt(lineStarts, token.range.startByte);
  const pieces = text.split(/\r\n|\r|\n/u);
  for (let index = 0; index < pieces.length; index += 1) {
    if (/\S/u.test(pieces[index] ?? '')) lines.add(firstLine + index);
  }
}

/** The unique physical lines that intersect non-trivia tokens. */
export function buildSourceLineSet(
  fileId: FileId,
  originalBytes: Uint8Array,
  tokens: readonly ParserToken[],
): SourceLineSet {
  const lineStarts = buildLineStartIndex(originalBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const lines = new Set<number>();
  for (const token of tokens) {
    if (TRIVIA_TOKEN_KINDS.has(token.kind)) continue;
    addTokenLines(lines, originalBytes, lineStarts, decoder, token);
  }
  return { fileId, oneBasedLines: lines };
}

/** Lines contributed only by non-trivia tokens whose byte range lies within `range`. */
export function linesWithin(
  originalBytes: Uint8Array,
  tokens: readonly ParserToken[],
  range: SourceRange,
): ReadonlySet<number> {
  const lineStarts = buildLineStartIndex(originalBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const lines = new Set<number>();
  for (const token of tokens) {
    if (TRIVIA_TOKEN_KINDS.has(token.kind)) continue;
    if (token.range.startByte < range.startByte || token.range.endByte > range.endByte) continue;
    addTokenLines(lines, originalBytes, lineStarts, decoder, token);
  }
  return lines;
}

/** Largest byte slice decoded between two checkpoints of the bounded line counter. */
export const BOUNDED_CHUNK_BYTES: number = 64 * 1024;
/** Records (tokens) visited between two checkpoints of the bounded line counter. */
export const BOUNDED_RECORD_INTERVAL: number = 256;

/** Equivalent of the ECMAScript `\s` class for one UTF-16 code unit. */
function isWhitespaceUnit(code: number): boolean {
  if (code > 0x20 && code < 0x7f) return false;
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/**
 * Incremental counterpart of the private token-line rule: the physical lines (CRLF, CR and LF
 * terminate pieces) of one token that contain a non-whitespace character. The token is decoded in
 * slices of at most `BOUNDED_CHUNK_BYTES`; a UTF-8 scalar or CRLF pair split across slices is
 * handled, and `checkpoint` runs between slices so one huge literal cannot monopolize the thread.
 */
async function addTokenLinesBounded(
  lines: Set<number>,
  originalBytes: Uint8Array,
  lineStarts: readonly number[],
  token: ParserToken,
  checkpoint: () => Promise<void>,
): Promise<void> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const firstLine = physicalLineAt(lineStarts, token.range.startByte);
  let lineIndex = 0;
  let hasContent = false;
  let pendingCarriageReturn = false;
  const finishPiece = (): void => {
    if (hasContent) lines.add(firstLine + lineIndex);
    lineIndex += 1;
    hasContent = false;
  };
  for (let offset = token.range.startByte; ; offset += BOUNDED_CHUNK_BYTES) {
    const end = Math.min(offset + BOUNDED_CHUNK_BYTES, token.range.endByte);
    const last = end >= token.range.endByte;
    const text = decoder.decode(originalBytes.subarray(offset, end), { stream: !last });
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (pendingCarriageReturn) {
        pendingCarriageReturn = false;
        if (code === 0x0a) continue;
      }
      if (code === 0x0d) {
        finishPiece();
        pendingCarriageReturn = true;
      } else if (code === 0x0a) {
        finishPiece();
      } else if (!hasContent && !isWhitespaceUnit(code)) {
        hasContent = true;
      }
    }
    if (last) break;
    await checkpoint();
  }
  finishPiece();
}

/**
 * Bounded derived-line path: the unique physical lines touched by non-trivia tokens accepted by
 * `retain`. Same line semantics as `buildSourceLineSet`, which remains the synchronous raw API.
 * Work is checkpointed every `BOUNDED_RECORD_INTERVAL` tokens and between byte slices.
 */
export async function buildRetainedLineSet(
  originalBytes: Uint8Array,
  tokens: readonly ParserToken[],
  retain: (token: ParserToken) => boolean,
  checkpoint: () => Promise<void>,
): Promise<ReadonlySet<number>> {
  const lineStarts = buildLineStartIndex(originalBytes);
  const lines = new Set<number>();
  let visited = 0;
  for (const token of tokens) {
    visited += 1;
    if (visited % BOUNDED_RECORD_INTERVAL === 0) await checkpoint();
    if (TRIVIA_TOKEN_KINDS.has(token.kind) || !retain(token)) continue;
    await addTokenLinesBounded(lines, originalBytes, lineStarts, token, checkpoint);
  }
  return lines;
}
