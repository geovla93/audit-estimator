import type { TextRange } from '@nomicfoundation/slang/cst';

const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf]);

export interface SourceView {
  readonly originalBytes: Uint8Array;
  readonly originalText: string;
  readonly parserText: string;
  readonly hasLeadingBom: boolean;
}

export function decodeSource(bytes: Uint8Array): SourceView {
  const originalBytes = Uint8Array.from(bytes);
  const originalText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    originalBytes,
  );
  const hasLeadingBom = startsWithBom(originalBytes);
  return {
    originalBytes,
    originalText,
    parserText: hasLeadingBom ? originalText.slice(1) : originalText,
    hasLeadingBom,
  };
}

export function parserTextForCallback(originalText: string): string {
  return originalText.startsWith('\uFEFF') ? originalText.slice(1) : originalText;
}

export function mapRangeToOriginal(range: TextRange, hasLeadingBom: boolean): TextRange {
  if (!hasLeadingBom) return range;
  const mapIndex = (index: TextRange['start']): TextRange['start'] => ({
    utf8: index.utf8 + 3,
    utf16: index.utf16 + 1,
    line: index.line,
    column: index.column + (index.line === 0 ? 1 : 0),
  });
  return { start: mapIndex(range.start), end: mapIndex(range.end) };
}

export function reconstructOriginalText(parserUnparse: string, hasLeadingBom: boolean): string {
  return hasLeadingBom ? `\uFEFF${parserUnparse}` : parserUnparse;
}

function startsWithBom(bytes: Uint8Array): boolean {
  return bytes.length >= utf8Bom.length && utf8Bom.every((byte, index) => bytes[index] === byte);
}
