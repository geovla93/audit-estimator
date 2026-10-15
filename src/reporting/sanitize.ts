function controlEscape(codePoint: number): string {
  return `\\u${codePoint.toString(16).padStart(4, '0')}`;
}

function visibleControls(value: string): string {
  let output = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0x0a) output += '\\n';
    else if (codePoint === 0x0d) output += '\\r';
    else if (codePoint === 0x09) output += '\\t';
    else if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      output += controlEscape(codePoint);
    } else {
      output += character;
    }
  }
  return output;
}

const MARKDOWN_PUNCTUATION: ReadonlySet<string> = new Set(
  Array.from('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'),
);

/** Makes terminal control characters visible while preserving ordinary Unicode text. */
export function sanitizeTerminalText(value: string): string {
  return visibleControls(value);
}

/** Escapes untrusted Markdown as plain text, including link and table delimiters. */
export function sanitizeMarkdownText(value: string): string {
  let output = '';
  for (const character of visibleControls(value)) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === '&') output += '&amp;';
    else if (codePoint >= 0x21 && codePoint <= 0x7e && MARKDOWN_PUNCTUATION.has(character)) {
      output += `&#x${codePoint.toString(16)};`;
    } else {
      output += character;
    }
  }
  return output;
}
