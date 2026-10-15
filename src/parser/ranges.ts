import type { SourceRange } from '../domain/types.ts';

const INVALID_OFFSET: number = 0xffff_ffff;

export interface SlangTextPosition {
  readonly utf8: number;
  readonly utf16: number;
  readonly line: number;
  readonly column: number;
}

export interface SlangTextRange {
  readonly start: SlangTextPosition;
  readonly end: SlangTextPosition;
}

export interface ParserSourceView {
  readonly parserText: string;
  readonly hasLeadingBom: boolean;
}

/** Precomputes byte, UTF-16, line, and scalar-column coordinates in one pass. */
export class SourceCoordinateIndex {
  readonly #text: string;
  readonly #utf8AtUtf16: Uint32Array;
  readonly #lineAtUtf16: Uint32Array;
  readonly #columnAtUtf16: Uint32Array;
  readonly #utf16AtUtf8: Uint32Array;
  readonly byteLength: number;

  public constructor(text: string) {
    this.#text = text;
    this.#utf8AtUtf16 = new Uint32Array(text.length + 1);
    this.#lineAtUtf16 = new Uint32Array(text.length + 1);
    this.#columnAtUtf16 = new Uint32Array(text.length + 1);
    this.#utf16AtUtf8 = new Uint32Array(Buffer.byteLength(text, 'utf8') + 1);
    this.#utf16AtUtf8.fill(INVALID_OFFSET);

    let utf16 = 0;
    let utf8 = 0;
    let line = 0;
    let column = 0;
    let previousWasCarriageReturn = false;
    this.#utf16AtUtf8[0] = 0;
    while (utf16 < text.length) {
      const first = text.charCodeAt(utf16);
      const second = text.charCodeAt(utf16 + 1);
      const scalarLength =
        first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? 2 : 1;
      const scalar = text.slice(utf16, utf16 + scalarLength);
      const byteLength = Buffer.byteLength(scalar, 'utf8');
      this.#utf8AtUtf16[utf16] = utf8;
      this.#lineAtUtf16[utf16] = line;
      this.#columnAtUtf16[utf16] = column;
      if (scalarLength === 2) {
        this.#utf8AtUtf16[utf16 + 1] = INVALID_OFFSET;
        this.#lineAtUtf16[utf16 + 1] = INVALID_OFFSET;
        this.#columnAtUtf16[utf16 + 1] = INVALID_OFFSET;
      }

      utf16 += scalarLength;
      utf8 += byteLength;
      if (scalar === '\r') {
        line += 1;
        column = 0;
        previousWasCarriageReturn = true;
      } else if (scalar === '\n') {
        if (!previousWasCarriageReturn) line += 1;
        column = 0;
        previousWasCarriageReturn = false;
      } else if (scalar === '\u2028' || scalar === '\u2029') {
        line += 1;
        column = 0;
        previousWasCarriageReturn = false;
      } else {
        column += 1;
        previousWasCarriageReturn = false;
      }
      this.#utf8AtUtf16[utf16] = utf8;
      this.#lineAtUtf16[utf16] = line;
      this.#columnAtUtf16[utf16] = column;
      this.#utf16AtUtf8[utf8] = utf16;
    }
    this.byteLength = utf8;
  }

  public matchesSlangPosition(position: SlangTextPosition): boolean {
    if (!validOffset(position.utf16, this.#text.length)) return false;
    return (
      this.#utf8AtUtf16[position.utf16] === position.utf8 &&
      this.#lineAtUtf16[position.utf16] === position.line &&
      this.#columnAtUtf16[position.utf16] === position.column
    );
  }

  public mapsDomainPosition(byte: number, line: number, column: number): boolean {
    if (!validOffset(byte, this.byteLength)) return false;
    const utf16 = this.#utf16AtUtf8[byte];
    if (utf16 === undefined || utf16 === INVALID_OFFSET) return false;
    const indexedLine = this.#lineAtUtf16[utf16];
    const indexedColumn = this.#columnAtUtf16[utf16];
    return (
      indexedLine !== undefined &&
      indexedColumn !== undefined &&
      indexedLine + 1 === line &&
      indexedColumn + 1 === column
    );
  }

  public toOriginalRange(range: SlangTextRange, hasLeadingBom: boolean): SourceRange {
    if (!this.matchesSlangPosition(range.start) || !this.matchesSlangPosition(range.end)) {
      throw new TypeError('Slang returned an invalid source coordinate.');
    }
    if (comparePosition(range.start, range.end) > 0) {
      throw new TypeError('Slang returned a reversed source range.');
    }

    const bomBytes = hasLeadingBom ? 3 : 0;
    const bomUtf16 = hasLeadingBom ? 1 : 0;
    const map = (position: SlangTextPosition) => ({
      byte: position.utf8 + bomBytes,
      line: position.line + 1,
      column: position.column + 1 + (hasLeadingBom && position.line === 0 ? 1 : 0),
      utf16: position.utf16 + bomUtf16,
    });
    const start = map(range.start);
    const end = map(range.end);
    if (
      start.byte > this.byteLength + bomBytes ||
      end.byte > this.byteLength + bomBytes ||
      start.utf16 > end.utf16
    ) {
      throw new TypeError('Slang coordinates do not map to the original source.');
    }
    return {
      startByte: start.byte,
      endByte: end.byte,
      start: { line: start.line, column: start.column },
      end: { line: end.line, column: end.column },
    };
  }
}

export function parserSourceView(originalText: string): ParserSourceView {
  const hasLeadingBom = originalText.startsWith('\uFEFF');
  return {
    parserText: hasLeadingBom ? originalText.slice(1) : originalText,
    hasLeadingBom,
  };
}

export function isValidDomainRange(range: SourceRange, index: SourceCoordinateIndex): boolean {
  return (
    Number.isSafeInteger(range.startByte) &&
    Number.isSafeInteger(range.endByte) &&
    range.startByte <= range.endByte &&
    index.mapsDomainPosition(range.startByte, range.start.line, range.start.column) &&
    index.mapsDomainPosition(range.endByte, range.end.line, range.end.column)
  );
}

function validOffset(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function comparePosition(left: SlangTextPosition, right: SlangTextPosition): number {
  if (left.utf16 !== right.utf16) return left.utf16 < right.utf16 ? -1 : 1;
  return 0;
}
