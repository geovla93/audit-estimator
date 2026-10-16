import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsdown';
import { z } from 'zod';

const repositoryRoot = resolve(import.meta.dirname, '..');
const idSchema = z.string().regex(/^[a-z][a-z0-9-]*$/u);
const relativePathSchema = z
  .string()
  .min(1)
  .refine(isRepoRelative, 'must be a confined repository-relative path');

function isRepoRelative(value) {
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

const markerSchema = z.strictObject({ file: relativePathSchema, id: idSchema });
const provenanceSchema = z.strictObject({
  status: z.enum(['PENDING_OWNER_APPROVAL', 'APPROVED']),
  author: z.string().min(1),
  licenseStatus: z.enum(['PENDING_OWNER_APPROVAL', 'APPROVED']),
  licenseNote: z.string().min(1),
});
const versionFactSchema = z.strictObject({
  id: idSchema,
  sourceFile: z.enum(['package.json', 'src/version.ts', 'src/domain/versions.ts']),
  selector: z.string().min(1),
  value: z.string().min(1),
  document: relativePathSchema,
});
const schemaFileSchema = z.strictObject({
  id: idSchema,
  file: relativePathSchema,
  urn: z.string().regex(/^urn:audit-estimator:[a-z0-9-]+\.schema\.json$/u),
  document: relativePathSchema,
});
const jsonExampleSchema = z.strictObject({
  id: idSchema,
  file: relativePathSchema,
  document: relativePathSchema,
  schema: z.enum(['config', 'model', 'result']),
});
const expectedOutputFileSchema = z.strictObject({
  path: relativePathSchema,
  seed: z.string().nullable(),
  reportStatus: z.enum(['complete', 'partial', 'error']).nullable(),
});
const caseExpectedSchema = z.strictObject({
  kind: z.enum(['report', 'text']),
  exitCode: z.number().int().min(0).max(255),
  status: z.enum(['complete', 'partial', 'error']).nullable(),
  coverage: z.enum(['full', 'analyzed-subset']).nullable(),
  scopedPaths: z.array(relativePathSchema),
  contextPaths: z.array(relativePathSchema),
  ownership: z.array(
    z.strictObject({
      path: relativePathSchema,
      value: z.enum(['first-party', 'third-party', 'unknown']),
    }),
  ),
  sourceLines: z.number().int().min(0).nullable(),
  estimate: z.enum(['full', 'subset', 'null', 'not-asserted']),
  stdoutEmpty: z.boolean(),
  stdoutIncludes: z.array(z.string()),
  stderrIncludes: z.array(z.string()),
  outputFile: expectedOutputFileSchema.nullable(),
});
const commandCaseSchema = z
  .strictObject({
    id: idSchema,
    group: z.enum([
      'quickstart and scope',
      'schema and formula examples',
      'help and contracts',
      'governance and claims',
    ]),
    fixture: relativePathSchema.nullable(),
    cwd: z.enum(['repository', 'fixture']),
    argv: z.array(z.string().min(1)).min(2),
    documentMarkers: z.array(markerSchema),
    expected: caseExpectedSchema,
  })
  .superRefine((entry, context) => {
    if (entry.argv[0] !== 'audit-estimator') {
      context.addIssue({
        code: 'custom',
        path: ['argv', 0],
        message: 'must start with audit-estimator',
      });
    }
    if (entry.fixture === null && entry.cwd === 'fixture') {
      context.addIssue({
        code: 'custom',
        path: ['fixture'],
        message: 'fixture cwd requires a fixture root',
      });
    }
    if (entry.fixture !== null && !entry.fixture.startsWith('examples/projects/')) {
      context.addIssue({
        code: 'custom',
        path: ['fixture'],
        message: 'fixture must live under examples/projects/',
      });
    }
    for (const [index, token] of entry.argv.entries()) {
      if (hasForbiddenCommandCharacter(token)) {
        context.addIssue({
          code: 'custom',
          path: ['argv', index],
          message: 'contains a shell token or control character',
        });
      }
    }
  });
const formulaOracleSchema = z.strictObject({
  fixture: relativePathSchema,
  sourceFile: relativePathSchema,
  sourceLines: z.number().int().positive(),
  countingNote: z.string().min(1),
  projectHours: z.strictObject({ low: z.number().nonnegative(), high: z.number().nonnegative() }),
  slocHours: z.strictObject({ low: z.number().nonnegative(), high: z.number().nonnegative() }),
  hoursPerDay: z.number().positive(),
  defaultHours: z.strictObject({ low: z.number().nonnegative(), high: z.number().nonnegative() }),
  defaultDays: z.strictObject({ low: z.number().nonnegative(), high: z.number().nonnegative() }),
  defaultLedger: z
    .array(
      z.strictObject({
        category: z.string().min(1),
        lowMicrohours: z.number().int(),
        highMicrohours: z.number().int(),
        inputStatus: z.enum(['measured', 'unavailable', 'manual']),
      }),
    )
    .min(1),
  manualAdjustment: z.strictObject({
    id: idSchema,
    lowHours: z.number(),
    highHours: z.number(),
    adjustedHours: z.strictObject({
      low: z.number().nonnegative(),
      high: z.number().nonnegative(),
    }),
    adjustedDays: z.strictObject({ low: z.number().nonnegative(), high: z.number().nonnegative() }),
    ledger: z.strictObject({
      category: z.string().min(1),
      lowMicrohours: z.number().int(),
      highMicrohours: z.number().int(),
      inputStatus: z.enum(['measured', 'unavailable', 'manual']),
    }),
    calculationNote: z.string().min(1),
  }),
});
const helpSchema = z.strictObject({
  commands: z.array(z.string().min(1)).min(1),
  rootOptions: z.array(z.string().min(1)).min(1),
  commonOptions: z.array(z.string().min(1)).min(1),
  deferredTerms: z.array(z.string().min(1)).min(1),
});
const libraryExampleSchema = z.strictObject({
  document: relativePathSchema,
  marker: idSchema,
  fixture: relativePathSchema,
  sourceLines: z.number().int().positive(),
});

const manifestSchema = z
  .strictObject({
    manifestVersion: z.literal(1),
    documents: z.array(relativePathSchema).min(1),
    provenance: provenanceSchema,
    versionFacts: z.array(versionFactSchema).min(1),
    schemas: z.array(schemaFileSchema).min(1),
    jsonExamples: z.array(jsonExampleSchema).min(1),
    formulaOracle: formulaOracleSchema,
    help: helpSchema,
    cases: z.array(commandCaseSchema).min(1),
    libraryExample: libraryExampleSchema,
  })
  .superRefine((manifest, context) => {
    for (const [field, values] of [
      ['documents', manifest.documents],
      ['versionFacts', manifest.versionFacts.map((item) => item.id)],
      ['schemas', manifest.schemas.map((item) => item.id)],
      ['jsonExamples', manifest.jsonExamples.map((item) => item.id)],
      ['cases', manifest.cases.map((item) => item.id)],
      ['commands', manifest.help.commands],
      ['rootOptions', manifest.help.rootOptions],
      ['commonOptions', manifest.help.commonOptions],
    ]) {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: 'custom', path: [field], message: 'values must be unique' });
      }
    }
    const documents = new Set(manifest.documents);
    for (const [field, entries] of [
      ['versionFacts', manifest.versionFacts.map((item) => item.document)],
      ['schemas', manifest.schemas.map((item) => item.document)],
      ['jsonExamples', manifest.jsonExamples.map((item) => item.document)],
      ['libraryExample', [manifest.libraryExample.document]],
      [
        'caseMarkers',
        manifest.cases.flatMap((item) => item.documentMarkers.map((marker) => marker.file)),
      ],
    ]) {
      for (const file of entries) {
        if (!documents.has(file)) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: `document is not registered: ${file}`,
          });
        }
      }
    }
    const markerKeys = manifest.cases.flatMap((item) =>
      item.documentMarkers.map((marker) => `${marker.file}\0${marker.id}`),
    );
    if (new Set(markerKeys).size !== markerKeys.length) {
      context.addIssue({
        code: 'custom',
        path: ['cases'],
        message: 'document markers must be unique',
      });
    }
    const caseIds = new Set(manifest.cases.map((item) => item.id));
    const referencedMarkers = manifest.cases.flatMap((item) =>
      item.documentMarkers.map((marker) => marker.id),
    );
    if (referencedMarkers.some((id) => !caseIds.has(id))) {
      context.addIssue({
        code: 'custom',
        path: ['cases'],
        message: 'document marker must name its registered case',
      });
    }
  });

function fail(message) {
  throw new Error(message);
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function hasForbiddenCommandCharacter(value) {
  const shellCharacters = new Set(['\\', "'", '`', '$', ';', '|', '&', '<', '>']);
  return (
    hasControlCharacter(value) || [...value].some((character) => shellCharacters.has(character))
  );
}

function readFileInside(root, relativePath) {
  const absolutePath = resolve(root, relativePath);
  const relativePathFromRoot = relative(root, absolutePath);
  if (
    relativePathFromRoot === '' ||
    relativePathFromRoot === '..' ||
    relativePathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relativePathFromRoot)
  ) {
    fail(`Path escapes repository root: ${relativePath}`);
  }
  const stat = assertPathComponents(root, relativePathFromRoot, relativePath);
  if (!stat.isFile()) fail(`Expected a regular file: ${relativePath}`);
  return readFileSync(absolutePath, 'utf8');
}

function assertPathComponents(root, relativePath, label) {
  let cursor = root;
  const parts = relativePath === '.' ? [] : relativePath.split(/[\\/]/u);
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) fail(`Missing local path: ${label}`);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink())
      fail(`Symbolic-link path components are not followed by docs:check: ${label}`);
    if (index < parts.length - 1 && !stat.isDirectory())
      fail(`Non-directory path component in ${label}`);
  }
  return lstatSync(cursor);
}

function collectMarkdown(root, directory) {
  const absoluteDirectory = resolve(root, directory);
  if (!existsSync(absoluteDirectory)) return [];
  const files = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const child = join(absoluteDirectory, entry.name);
    const repoPath = relative(root, child).split(/\\/u).join('/');
    if (entry.isSymbolicLink()) fail(`Symbolic links are not allowed in public docs: ${repoPath}`);
    if (entry.isDirectory()) files.push(...collectMarkdown(root, repoPath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(repoPath);
  }
  return files;
}

function publicDocuments(root) {
  const rootDocuments = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md'].filter((file) =>
    existsSync(join(root, file)),
  );
  return [
    ...rootDocuments,
    ...collectMarkdown(root, 'docs'),
    ...collectMarkdown(root, 'examples'),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeReference(value) {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function normalizeHeading(text) {
  const decoded = text
    .replace(/<[^>]*>/gu, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/gu, '$1')
    .replace(/`+/gu, '')
    .replace(/&amp;/giu, '&')
    .replace(/&#(\d+);/gu, (_match, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, number) =>
      String.fromCodePoint(Number.parseInt(number, 16)),
    );
  return decoded
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/gu, '-');
}

function parseMarkdown(text, file) {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const fences = [];
  const prose = [];
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (current === null) {
      const opening = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/u.exec(line);
      if (opening === null) {
        prose.push({ line: index + 1, text: line });
        continue;
      }
      const marker = opening[1] ?? '';
      const info = (opening[2] ?? '').trim();
      current = {
        marker,
        info,
        openLine: index + 1,
        content: [],
      };
      continue;
    }
    const closing = new RegExp(`^ {0,3}${current.marker[0]}{${current.marker.length},}\\s*$`, 'u');
    if (closing.test(line)) {
      let markerIndex = current.openLine - 2;
      while (markerIndex >= 0 && (lines[markerIndex] ?? '').trim() === '') markerIndex -= 1;
      fences.push({
        file,
        line: current.openLine,
        language: (current.info.split(/\s+/u)[0] ?? '').toLowerCase(),
        info: current.info,
        markerLine: (lines[markerIndex] ?? '').trim(),
        body: current.content.length === 0 ? '' : `${current.content.join('\n')}\n`,
      });
      current = null;
    } else {
      current.content.push(line);
    }
  }
  if (current !== null) fail(`${file}:${current.openLine}: unclosed fenced code block`);
  return { lines, prose, fences };
}

function headingAnchors(text) {
  const { prose } = parseMarkdown(text, '<heading scan>');
  const used = new Set();
  const anchors = new Set();
  for (let index = 0; index < prose.length; index += 1) {
    const line = prose[index]?.text ?? '';
    const atx = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    const setext =
      index + 1 < prose.length && /^ {0,3}(=+|-+)\s*$/u.test(prose[index + 1]?.text ?? '');
    const rawHeading = atx?.[1] ?? (setext ? line.trim() : null);
    if (rawHeading === null) continue;
    const base = normalizeHeading(rawHeading) || 'section';
    let candidate = base;
    let suffix = 0;
    while (used.has(candidate)) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    used.add(candidate);
    anchors.add(candidate);
  }
  return anchors;
}

function destinationFromMarkdown(match) {
  const raw = match.trim();
  if (raw.startsWith('<')) {
    const end = raw.indexOf('>');
    if (end < 0) fail(`Unsupported local link destination: ${raw}`);
    return raw.slice(1, end);
  }
  return raw.split(/\s+/u)[0] ?? '';
}

function localLinkTarget(target, file, line) {
  const label = `${file}:${line}`;
  if (target === '') fail(`${label}: empty local link target`);
  if (/^(?:https?:|mailto:|tel:)/iu.test(target)) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target))
    fail(`${label}: unsupported link scheme in ${target}`);
  if (target.startsWith('//')) fail(`${label}: protocol-relative links are unsupported`);
  if (
    target.includes('\\') ||
    [...target].some((character) => character.trim() === '' || hasControlCharacter(character))
  ) {
    fail(`${label}: unsupported whitespace or backslash in link target`);
  }
  const hash = target.indexOf('#');
  const rawPath = hash < 0 ? target : target.slice(0, hash);
  const rawFragment = hash < 0 ? '' : target.slice(hash + 1);
  if (rawPath.includes('?')) fail(`${label}: local query links are unsupported`);
  let decodedPath;
  let fragment;
  try {
    decodedPath = decodeURIComponent(rawPath);
    fragment = rawFragment === '' ? '' : decodeURIComponent(rawFragment);
  } catch {
    fail(`${label}: malformed percent-encoding in link target`);
  }
  if ((decodedPath ?? '').includes('\\') || (decodedPath ?? '').includes('\0')) {
    fail(`${label}: encoded separator or control character in local path`);
  }
  const resolved =
    decodedPath === ''
      ? file
      : decodedPath.startsWith('/')
        ? posix.normalize(decodedPath.slice(1))
        : posix.normalize(posix.join(posix.dirname(file), decodedPath));
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) {
    fail(`${label}: local link escapes repository root: ${target}`);
  }
  if (resolved.split('/').includes('..'))
    fail(`${label}: local link escapes repository root: ${target}`);
  return { path: resolved, fragment: fragment ?? '' };
}

function linksInDocument(parsed, file) {
  const references = new Map();
  const links = [];
  for (const item of parsed.prose) {
    const definition = /^ {0,3}\[([^\]]+)\]:\s*(.+?)\s*$/u.exec(item.text);
    if (definition !== null) {
      const key = normalizeReference(definition[1] ?? '');
      if (references.has(key))
        fail(`${file}:${item.line}: duplicate link reference definition [${key}]`);
      references.set(key, {
        target: destinationFromMarkdown(definition[2] ?? ''),
        line: item.line,
      });
    }
  }
  for (const item of parsed.prose) {
    if (/^ {0,3}\[[^\]]+\]:\s*/u.test(item.text)) continue;
    const inlinePattern = /!?\[[^\]]*\]\(([^)]*)\)/gu;
    for (const match of item.text.matchAll(inlinePattern)) {
      links.push({ target: destinationFromMarkdown(match[1] ?? ''), line: item.line });
    }
    const referencePattern = /!?\[([^\]]+)\](?:\[([^\]]*)\])?/gu;
    for (const match of item.text.matchAll(referencePattern)) {
      const end = (match.index ?? 0) + match[0].length;
      if (item.text[end] === '(') continue;
      const explicit = match[2] !== undefined;
      const referenceKey = normalizeReference((match[2] || match[1]) ?? '');
      const definition = references.get(referenceKey);
      if (explicit && definition === undefined) {
        fail(`${file}:${item.line}: missing link reference definition [${referenceKey}]`);
      }
      if (definition !== undefined) links.push({ target: definition.target, line: item.line });
    }
    for (const match of item.text.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/giu)) {
      links.push({ target: match[2] ?? '', line: item.line });
    }
    if (/<(?:\.{1,2}\/|\/|#)[^>\s]+>/u.test(item.text)) {
      fail(
        `${file}:${item.line}: autolink syntax for local paths is unsupported; use Markdown links`,
      );
    }
    if (/\]\([^)]*\]\(/u.test(item.text)) {
      fail(`${file}:${item.line}: nested link syntax is unsupported`);
    }
  }
  return links;
}

function validateLocalLinks(root, documentPaths) {
  const textByPath = new Map(documentPaths.map((file) => [file, readFileInside(root, file)]));
  for (const [file, text] of textByPath) {
    const parsed = parseMarkdown(text, file);
    for (const link of linksInDocument(parsed, file)) {
      const local = localLinkTarget(link.target, file, link.line);
      if (local === null) continue;
      if (!existsSync(resolve(root, local.path)))
        fail(`${file}:${link.line}: missing local link target ${link.target}`);
      const absolute = resolve(root, local.path);
      const resolvedRelative = relative(root, absolute);
      if (
        resolvedRelative === '..' ||
        resolvedRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        isAbsolute(resolvedRelative)
      ) {
        fail(`${file}:${link.line}: local link escapes repository root: ${link.target}`);
      }
      const stat = assertPathComponents(root, local.path, `${file}:${link.line}: ${link.target}`);
      if (local.fragment !== '') {
        if (!stat.isFile() || !local.path.toLowerCase().endsWith('.md')) {
          fail(`${file}:${link.line}: fragment target is not a Markdown document: ${link.target}`);
        }
        const targetText = textByPath.get(local.path) ?? readFileInside(root, local.path);
        if (!headingAnchors(targetText).has(normalizeHeading(local.fragment))) {
          fail(`${file}:${link.line}: missing heading fragment ${local.fragment} in ${local.path}`);
        }
      }
    }
  }
}

function tokenizeAuditCommand(command, label) {
  if (hasForbiddenCommandCharacter(command)) {
    fail(`${label}: unsupported shell syntax; use simple tokens or double-quoted arguments`);
  }
  const tokens = [];
  let index = 0;
  while (index < command.length) {
    while (/\s/u.test(command[index] ?? '')) index += 1;
    if (index >= command.length) break;
    let token = '';
    if (command[index] === '"') {
      index += 1;
      const start = index;
      while (index < command.length && command[index] !== '"') index += 1;
      if (index >= command.length) fail(`${label}: unclosed double quote`);
      token = command.slice(start, index);
      index += 1;
      if (index < command.length && !/\s/u.test(command[index] ?? '')) {
        fail(`${label}: quoted arguments must be separate tokens`);
      }
      if (token.length === 0) fail(`${label}: empty arguments are unsupported`);
    } else {
      const start = index;
      while (index < command.length && !/\s/u.test(command[index] ?? '')) index += 1;
      token = command.slice(start, index);
      if (!/^[-A-Za-z0-9_./:@*?{}!,+=%\x5B\x5D]+$/u.test(token)) {
        fail(`${label}: unsupported token ${token}`);
      }
    }
    if (hasForbiddenCommandCharacter(token) || token.includes('"'))
      fail(`${label}: unsupported shell token`);
    tokens.push(token);
  }
  if (tokens[0] !== 'audit-estimator')
    fail(`${label}: runnable CLI commands must start with audit-estimator`);
  return tokens;
}

function assertSameArgv(expected, actual, label) {
  if (
    expected.length !== actual.length ||
    expected.some((token, index) => token !== actual[index])
  ) {
    fail(`${label}: command argv differs from examples/manifest.json`);
  }
}

function precedingMarker(text, marker, type) {
  const expected = `<!-- docs:${type} ${marker} -->`;
  return text.trim() === expected;
}

function validateCommandFences(documentPaths, root, manifest) {
  const casesById = new Map(manifest.cases.map((item) => [item.id, item]));
  const seenMarkers = new Map();
  for (const file of documentPaths) {
    const source = readFileInside(root, file);
    const parsed = parseMarkdown(source, file);
    for (const fence of parsed.fences) {
      const caseMatch = /^<!-- docs:case ([a-z][a-z0-9-]*) -->$/u.exec(fence.markerLine);
      const illustrative = /^<!-- docs:(?:illustrative|pending) -->$/u.test(fence.markerLine);
      const prerequisite = /^<!-- docs:prerequisite -->$/u.test(fence.markerLine);
      const productLines = fence.body
        .replace(/\n$/u, '')
        .split('\n')
        .filter((line) =>
          /(?:^|\s)audit-estimator\s+(?:estimate|inspect|explain|--help|--version)\b/u.test(line),
        );
      if (caseMatch !== null) {
        const id = caseMatch[1] ?? '';
        const registered = casesById.get(id);
        if (registered === undefined)
          fail(`${file}:${fence.line}: unregistered runnable command case ${id}`);
        if (fence.language !== 'sh')
          fail(`${file}:${fence.line}: canonical command cases must use an sh fence`);
        const markerKey = `${file}\0${id}`;
        seenMarkers.set(markerKey, (seenMarkers.get(markerKey) ?? 0) + 1);
        if (!registered.documentMarkers.some((item) => item.file === file && item.id === id)) {
          fail(`${file}:${fence.line}: command marker ${id} is not registered for this document`);
        }
        if (productLines.length !== 1)
          fail(
            `${file}:${fence.line}: registered command fence must contain one product invocation`,
          );
        const lines = fence.body
          .replace(/\n$/u, '')
          .split('\n')
          .filter((line) => line.trim() !== '');
        if (lines.length !== 1)
          fail(
            `${file}:${fence.line}: a registered command fence must contain exactly one invocation`,
          );
        const argv = tokenizeAuditCommand(lines[0] ?? '', `${file}:${fence.line}`);
        assertSameArgv(registered.argv, argv, `${file}:${fence.line}`);
      } else {
        const hasProductCommand = productLines.length > 0;
        if (hasProductCommand && !illustrative) {
          fail(
            `${file}:${fence.line}: product invocation needs a docs:case marker or explicit illustrative/pending label`,
          );
        }
        if (
          ['sh', 'bash', 'zsh', 'powershell', 'pwsh', 'cmd'].includes(fence.language) &&
          !hasProductCommand &&
          !prerequisite &&
          !illustrative &&
          !fence.markerLine.startsWith('<!-- docs:json')
        ) {
          fail(
            `${file}:${fence.line}: shell fence needs a docs:prerequisite, docs:illustrative, or docs:pending label`,
          );
        }
        if (prerequisite && hasProductCommand) {
          fail(`${file}:${fence.line}: prerequisite shell fences cannot contain product commands`);
        }
      }
    }
  }
  for (const item of manifest.cases) {
    for (const marker of item.documentMarkers) {
      const key = `${marker.file}\0${marker.id}`;
      if (seenMarkers.get(key) !== 1)
        fail(`${marker.file}: expected exactly one runnable fence for docs:case ${marker.id}`);
    }
  }
}

function findMarkedFence(root, document, markerType, markerId, language) {
  const source = readFileInside(root, document);
  const parsed = parseMarkdown(source, document);
  const matches = parsed.fences.filter(
    (fence) =>
      fence.language === language && precedingMarker(fence.markerLine, markerId, markerType),
  );
  if (matches.length !== 1)
    fail(`${document}: expected one ${markerType} fence marked ${markerId}`);
  return matches[0];
}

function validateJsonFences(root, documentPaths, manifest) {
  const examples = new Map(manifest.jsonExamples.map((entry) => [entry.id, entry]));
  const seen = new Set();
  for (const document of documentPaths) {
    const source = readFileInside(root, document);
    const parsed = parseMarkdown(source, document);
    for (const fence of parsed.fences) {
      if (fence.language !== 'json') continue;
      if (fence.markerLine === '<!-- docs:fragment -->') continue;
      const marker = /^<!-- docs:json ([a-z][a-z0-9-]*) -->$/u.exec(fence.markerLine);
      if (marker === null) {
        let parsed;
        try {
          parsed = JSON.parse(fence.body);
        } catch {
          fail(`${document}:${fence.line}: illustrative JSON must remain valid JSON`);
        }
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          ('schemaVersion' in parsed || ('$schema' in parsed && 'status' in parsed))
        ) {
          fail(
            `${document}:${fence.line}: report-like JSON must be registered as a complete example or labelled docs:fragment`,
          );
        }
        continue;
      }
      const id = marker[1] ?? '';
      const example = examples.get(id);
      if (example === undefined || example.document !== document)
        fail(`${document}:${fence.line}: unregistered JSON example ${id}`);
      const expected = readFileInside(root, example.file).replace(/\r\n?/gu, '\n');
      if (fence.body !== expected)
        fail(`${document}:${fence.line}: fenced JSON differs from ${example.file}`);
      seen.add(id);
    }
  }
  for (const example of manifest.jsonExamples) {
    if (!seen.has(example.id))
      fail(`${example.document}: missing registered JSON fence ${example.id}`);
  }
}

function versionSourceValue(root, fact) {
  const source = readFileInside(root, fact.sourceFile);
  if (fact.sourceFile === 'package.json') {
    const value = JSON.parse(source);
    const pointer = fact.selector.split('/').slice(1);
    let current = value;
    for (const key of pointer) current = current?.[key.replaceAll('~1', '/').replaceAll('~0', '~')];
    if (typeof current !== 'string')
      fail(`${fact.sourceFile}: version fact ${fact.id} did not resolve to a string`);
    return current;
  }
  const escaped = fact.selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`export const ${escaped}(?:: string)? = ['"]([^'"]+)['"]`, 'u').exec(
    source,
  );
  if (match === null)
    fail(`${fact.sourceFile}: cannot read source value for version fact ${fact.id}`);
  return match[1] ?? '';
}

function assertVersionFact(root, fact) {
  const actual = versionSourceValue(root, fact);
  if (actual !== fact.value)
    fail(`${fact.sourceFile}: ${fact.selector} is ${actual}, manifest records ${fact.value}`);
  const source = readFileInside(root, fact.document);
  const marker = `<!-- docs:fact ${fact.id} -->`;
  const annotationIndex = source.indexOf(marker);
  const suffix =
    annotationIndex < 0 ? '' : source.slice(annotationIndex + marker.length).trimStart();
  const quoted = suffix.startsWith('`');
  const valueText = quoted ? suffix.slice(1) : suffix;
  const afterValue = valueText.slice(fact.value.length);
  const hasBoundary =
    afterValue.length === 0 ||
    (quoted ? afterValue.startsWith('`') : /^[\s.,;:)}<]/u.test(afterValue));
  if (
    annotationIndex < 0 ||
    source.indexOf(marker, annotationIndex + marker.length) >= 0 ||
    !valueText.startsWith(fact.value) ||
    !hasBoundary
  ) {
    fail(`${fact.document}: expected one docs:fact ${fact.id} annotation equal to ${fact.value}`);
  }
}

function validateVersionFacts(root, manifest) {
  for (const fact of manifest.versionFacts) assertVersionFact(root, fact);
}

function assertSchemaFile(root, schema) {
  const parsed = JSON.parse(readFileInside(root, schema.file));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('$id' in parsed) ||
    parsed.$id !== schema.urn
  ) {
    fail(`${schema.file}: expected schema identifier ${schema.urn}`);
  }
  const text = readFileInside(root, schema.document);
  const links = linksInDocument(parseMarkdown(text, schema.document), schema.document);
  const linked = links.some(
    (link) => localLinkTarget(link.target, schema.document, link.line)?.path === schema.file,
  );
  if (!linked) {
    fail(`${schema.document}: schema file ${schema.file} must be linked from its guide`);
  }
}

function validateSchemaFiles(root, manifest) {
  for (const schema of manifest.schemas) assertSchemaFile(root, schema);
}

async function loadInternalSchemas(root) {
  const tempBase = join(root, '.vitest');
  await mkdir(tempBase, { recursive: true });
  const temporary = await mkdtemp(join(tempBase, 'docs-schemas-'));
  try {
    await build({
      config: false,
      entry: {
        'domain-schemas': join(root, 'src/domain/schemas.ts'),
        'domain-versions': join(root, 'src/domain/versions.ts'),
      },
      outDir: temporary,
      format: 'esm',
      platform: 'node',
      clean: false,
      dts: false,
      deps: { neverBundle: true },
    });
    const [schemaModule, versionsModule] = await Promise.all([
      import(pathToFileURL(join(temporary, 'domain-schemas.mjs')).href),
      import(pathToFileURL(join(temporary, 'domain-versions.mjs')).href),
    ]);
    return { temporary, schemas: schemaModule, versions: versionsModule };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function runtimeSchemaFor(example, schemas) {
  if (example.schema === 'config') return schemas.ConfigInputSchema;
  if (example.schema === 'model') return schemas.ModelProfileSchema;
  return schemas.ReportEnvelopeSchema;
}

function validateRuntimeExamples(root, manifest, schemas) {
  for (const example of manifest.jsonExamples) {
    const input = JSON.parse(readFileInside(root, example.file));
    const schema = runtimeSchemaFor(example, schemas);
    const result = schema.safeParse(input);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      fail(`${example.file}: runtime schema validation failed: ${issues}`);
    }
  }
}

function markdownTableFirstColumn(text, document, markerId) {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const marker = `<!-- docs:help ${markerId} -->`;
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start < 0) fail(`${document}: missing help table marker ${markerId}`);
  const table = [];
  let tableStart = start + 1;
  while (tableStart < lines.length && (lines[tableStart] ?? '').trim() === '') tableStart += 1;
  for (
    let index = tableStart;
    index < lines.length && (lines[index] ?? '').trim().startsWith('|');
    index += 1
  ) {
    table.push(lines[index] ?? '');
  }
  const rows = table.slice(2).map((line) => {
    const cell = line.split('|')[1]?.trim() ?? '';
    return cell.replace(/^`|`$/gu, '');
  });
  return rows.filter((value) => value !== '');
}

function validateHelpTables(root, manifest) {
  const document = 'docs/cli.md';
  const text = readFileInside(root, document);
  for (const [marker, expected] of [
    ['commands', manifest.help.commands],
    ['root-options', manifest.help.rootOptions],
    ['common-options', manifest.help.commonOptions],
  ]) {
    const actual = markdownTableFirstColumn(text, document, marker);
    if (
      actual.length !== expected.length ||
      actual.some((value, index) => value !== expected[index])
    ) {
      fail(`${document}: ${marker} table does not match examples/manifest.json`);
    }
  }
}

function validateReadiness(root, manifest, documents) {
  const required = [
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'docs/configuration.md',
    'docs/cli.md',
    'docs/architecture.md',
    'docs/limitations.md',
    'docs/roadmap.md',
    'docs/release-readiness.md',
  ];
  for (const file of required)
    if (!documents.includes(file)) fail(`Required public document is missing: ${file}`);
  const readme = readFileInside(root, 'README.md').toLowerCase();
  if (!readme.includes('uncalibrated heuristic') || !readme.includes('planning scenario')) {
    fail('README.md must identify the uncalibrated planning scenario');
  }
  const security = readFileInside(root, 'SECURITY.md');
  if (!security.includes('PENDING OWNER DECISION'))
    fail('SECURITY.md must show the pending reporting-channel decision');
  if (
    manifest.provenance.status === 'PENDING_OWNER_APPROVAL' &&
    manifest.provenance.licenseStatus !== 'PENDING_OWNER_APPROVAL'
  ) {
    fail('Fixture provenance and license states disagree');
  }
  if (manifest.provenance.licenseStatus !== 'APPROVED' && existsSync(join(root, 'LICENSE'))) {
    fail('LICENSE exists without an approved owner grant in the manifest');
  }
  const readiness = readFileInside(root, 'docs/release-readiness.md');
  const allowedStatuses = new Set(['PASS', 'FAIL', 'PENDING', 'NOT_RUN', 'NOT_APPLICABLE']);
  const headings = ['## Implementation verification', '## Public release gates'];
  for (const heading of headings) {
    const lines = readiness.split(/\r?\n/u);
    const headingIndex = lines.findIndex((line) => line.trim() === heading);
    if (headingIndex < 0) fail(`docs/release-readiness.md is missing ${heading}`);
    const tableLines = [];
    let tableStart = headingIndex + 1;
    while (tableStart < lines.length && (lines[tableStart] ?? '').trim() === '') tableStart += 1;
    for (
      let index = tableStart;
      index < lines.length && (lines[index] ?? '').trim().startsWith('|');
      index += 1
    ) {
      tableLines.push(lines[index] ?? '');
    }
    const cells = tableLines.map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
    const header = cells[0] ?? [];
    if (
      header.join(' | ') !==
      'gate | status | revision | date (UTC) | environment | command/evidence | pending reason'
    ) {
      fail(`docs/release-readiness.md has an invalid table header under ${heading}`);
    }
    const dataRows = cells.slice(2);
    if (dataRows.length === 0)
      fail(`docs/release-readiness.md has no evidence rows under ${heading}`);
    const gateIds = dataRows.map((row) => row[0] ?? '');
    if (gateIds.some((id) => id.length === 0) || new Set(gateIds).size !== gateIds.length) {
      fail(`docs/release-readiness.md gate IDs must be nonempty and unique under ${heading}`);
    }
    for (const row of dataRows) {
      const status = row[1] ?? '';
      if (!allowedStatuses.has(status))
        fail(`docs/release-readiness.md has unsupported status ${status}`);
      const pendingReason = row[6] ?? '';
      if (status === 'PASS') {
        if (
          [row[2], row[3], row[4], row[5]].some(
            (value) => value === undefined || value === '' || value === '—',
          )
        ) {
          fail(
            `docs/release-readiness.md PASS row ${row[0] ?? ''} needs revision, UTC date, environment and evidence`,
          );
        }
      } else if (pendingReason === '' || pendingReason === '—') {
        fail(`docs/release-readiness.md ${status} row ${row[0] ?? ''} needs a reason`);
      }
    }
  }
}

function validateGovernanceClaims(root, manifest, documents) {
  const text = documents.map((file) => readFileInside(root, file)).join('\n');
  if (manifest.provenance.status !== 'PENDING_OWNER_APPROVAL')
    fail('Example provenance must remain owner-pending until a grant is recorded');
  if (!text.includes(manifest.provenance.licenseNote))
    fail('Public docs must state the exact fixture licensing note from the manifest');
  if (!readFileInside(root, 'docs/roadmap.md').includes('consented calibration'))
    fail('Roadmap must defer empirical claims until consented calibration');
  const security = readFileInside(root, 'SECURITY.md');
  if (
    /confidential reports? (?:can|may) be sent to|private reporting is available/iu.test(security)
  ) {
    fail('SECURITY.md claims an unconfirmed confidential reporting channel');
  }
}

function validateLibraryFence(root, manifest) {
  findMarkedFence(
    root,
    manifest.libraryExample.document,
    'library',
    manifest.libraryExample.marker,
    'js',
  );
}

function checkRepository(root) {
  const manifestText = readFileInside(root, 'examples/manifest.json');
  const manifest = manifestSchema.parse(JSON.parse(manifestText));
  const foundDocuments = publicDocuments(root);
  const registeredDocuments = [...manifest.documents].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    foundDocuments.length !== registeredDocuments.length ||
    foundDocuments.some((file, index) => file !== registeredDocuments[index])
  ) {
    fail(
      `examples/manifest.json document inventory differs from public Markdown files. Found: ${foundDocuments.join(', ')}`,
    );
  }
  for (const file of manifest.documents) readFileInside(root, file);
  validateReadiness(root, manifest, foundDocuments);
  validateLocalLinks(root, foundDocuments);
  validateVersionFacts(root, manifest);
  validateSchemaFiles(root, manifest);
  validateCommandFences(foundDocuments, root, manifest);
  validateJsonFences(root, foundDocuments, manifest);
  validateHelpTables(root, manifest);
  validateGovernanceClaims(root, manifest, foundDocuments);
  validateLibraryFence(root, manifest);
  return manifest;
}

const CONTROL_DETECTED = Symbol('control-detected');

function expectControl(name, action) {
  try {
    action();
  } catch (error) {
    if (error === CONTROL_DETECTED) return;
    throw error;
  }
  fail(`Documentation self-test did not detect the ${name} control`);
}

function expectValidatorFailure(action, expectedMessage) {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expectedMessage)) throw error;
    throw CONTROL_DETECTED;
  }
}

async function runSelfTests(root) {
  const sourceManifest = manifestSchema.parse(
    JSON.parse(readFileInside(root, 'examples/manifest.json')),
  );
  const temp = await mkdtemp(join(tmpdir(), 'audit-estimator-docs-controls-'));
  let positive = 0;
  let negative = 0;
  try {
    await mkdir(join(temp, 'docs'), { recursive: true });
    await mkdir(join(temp, 'assets'), { recursive: true });
    await writeFile(join(temp, 'assets', 'a b.png'), 'data');
    const goodMarkdown = [
      '# Duplicate',
      '# Duplicate',
      '',
      '[guide][target]',
      '![asset][image]',
      '[same-file](#duplicate-1)',
      '[encoded](../assets/a%20b.png)',
      '',
      '[target]: target.md#destination',
      '[image]: ../assets/a%20b.png',
      '',
    ].join('\n');
    const targetMarkdown = '# Destination\n';
    await writeFile(join(temp, 'docs', 'source.md'), goodMarkdown);
    await writeFile(join(temp, 'docs', 'target.md'), targetMarkdown);
    validateLocalLinks(temp, ['docs/source.md', 'docs/target.md']);
    const collisionHeadings = headingAnchors('# Duplicate\n# Duplicate\n# Duplicate-1\n# A -- B\n');
    if (
      !collisionHeadings.has('duplicate-1') ||
      !collisionHeadings.has('duplicate-1-1') ||
      !collisionHeadings.has('a----b')
    ) {
      fail('GitHub heading normalization and collision controls failed');
    }
    positive += 1;

    const outside = join(temp, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.md'), '# Outside\n');
    symlinkSync(
      outside,
      join(temp, 'docs', 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFile(join(temp, 'docs', 'symlink-ancestor.md'), '[outside](escape/secret.md)\n');
    expectControl('symlinked local-link ancestor', () =>
      expectValidatorFailure(
        () => validateLocalLinks(temp, ['docs/symlink-ancestor.md']),
        'Symbolic-link path components',
      ),
    );
    negative += 1;

    const firstCase = sourceManifest.cases.find((item) => item.id === 'quickstart-estimate');
    if (firstCase === undefined) fail('Missing registered command for positive self-test');
    const command = tokenizeAuditCommand(
      'audit-estimator estimate examples/projects/simple --format json --no-config',
      'positive self-test',
    );
    assertSameArgv(firstCase.argv, command, 'positive self-test');
    positive += 1;

    await writeFile(join(temp, 'docs', 'missing-target.md'), '[missing](absent.md)\n');
    expectControl('missing local link target', () =>
      expectValidatorFailure(
        () => validateLocalLinks(temp, ['docs/missing-target.md']),
        'missing local link target',
      ),
    );
    negative += 1;
    await writeFile(
      join(temp, 'docs', 'missing-fragment.md'),
      '[missing](target.md#no-such-heading)\n',
    );
    expectControl('missing heading fragment', () =>
      expectValidatorFailure(
        () => validateLocalLinks(temp, ['docs/missing-fragment.md', 'docs/target.md']),
        'missing heading fragment',
      ),
    );
    negative += 1;

    const duplicateManifest = structuredClone(sourceManifest);
    duplicateManifest.cases.push(structuredClone(duplicateManifest.cases[0]));
    expectControl('duplicate command case ID', () =>
      expectValidatorFailure(
        () => manifestSchema.parse(duplicateManifest),
        'values must be unique',
      ),
    );
    negative += 1;
    expectControl('changed command flag/argv', () =>
      expectValidatorFailure(() => {
        const changed = [...(firstCase.argv ?? [])];
        const formatIndex = changed.indexOf('--format');
        changed[formatIndex + 1] = 'terminal';
        assertSameArgv(firstCase.argv, changed, 'negative argv self-test');
      }, 'command argv differs'),
    );
    negative += 1;

    const { temporary, schemas } = await loadInternalSchemas(root);
    try {
      const invalidConfigRoot = join(temp, 'invalid-config');
      await mkdir(join(invalidConfigRoot, 'examples/projects/simple'), { recursive: true });
      const config = JSON.parse(
        readFileInside(root, 'examples/projects/simple/audit-estimator.config.json'),
      );
      config.manualAdjustments[0].lowHours = 2;
      config.manualAdjustments[0].highHours = 1;
      await writeFile(
        join(invalidConfigRoot, 'examples/projects/simple/audit-estimator.config.json'),
        JSON.stringify(config),
      );
      expectControl('invalid config range', () =>
        expectValidatorFailure(
          () =>
            validateRuntimeExamples(
              invalidConfigRoot,
              {
                jsonExamples: [
                  {
                    id: 'bad-config',
                    file: 'examples/projects/simple/audit-estimator.config.json',
                    schema: 'config',
                  },
                ],
              },
              schemas,
            ),
          'runtime schema validation failed',
        ),
      );
      negative += 1;
      const invalidResultRoot = join(temp, 'invalid-result');
      await mkdir(join(invalidResultRoot, 'examples/results'), { recursive: true });
      const resultExample = JSON.parse(
        readFileInside(root, 'examples/results/empty-scope-error.json'),
      );
      resultExample.status = 'partial';
      resultExample.failureCategory = null;
      await writeFile(
        join(invalidResultRoot, 'examples/results/invalid-report.json'),
        JSON.stringify(resultExample),
      );
      expectControl('report cross-field invariant', () =>
        expectValidatorFailure(
          () =>
            validateRuntimeExamples(
              invalidResultRoot,
              {
                jsonExamples: [
                  {
                    id: 'bad-report',
                    file: 'examples/results/invalid-report.json',
                    schema: 'result',
                  },
                ],
              },
              schemas,
            ),
          'runtime schema validation failed',
        ),
      );
      negative += 1;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }

    const staleVersionRoot = join(temp, 'stale-version');
    await mkdir(staleVersionRoot, { recursive: true });
    await writeFile(join(staleVersionRoot, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    await writeFile(join(staleVersionRoot, 'README.md'), '<!-- docs:fact tool-version -->9.9.9\n');
    const toolFact = sourceManifest.versionFacts.find((fact) => fact.id === 'tool-version');
    if (toolFact === undefined) fail('Missing version fact self-test fixture');
    expectControl('stale annotated version', () =>
      expectValidatorFailure(
        () => assertVersionFact(staleVersionRoot, toolFact),
        'expected one docs:fact tool-version annotation',
      ),
    );
    negative += 1;
    const staleSchemaRoot = join(temp, 'stale-schema');
    await mkdir(join(staleSchemaRoot, 'docs'), { recursive: true });
    await mkdir(join(staleSchemaRoot, 'schemas'), { recursive: true });
    await writeFile(
      join(staleSchemaRoot, 'docs/configuration.md'),
      '[schema](../schemas/config-v1.schema.json)\n',
    );
    await writeFile(
      join(staleSchemaRoot, 'schemas/config-v1.schema.json'),
      JSON.stringify({ $id: 'urn:audit-estimator:stale.schema.json' }),
    );
    const configSchema = sourceManifest.schemas.find((schema) => schema.id === 'config-schema');
    if (configSchema === undefined) fail('Missing schema file self-test fixture');
    expectControl('stale schema ID', () =>
      expectValidatorFailure(
        () => assertSchemaFile(staleSchemaRoot, configSchema),
        'expected schema identifier',
      ),
    );
    negative += 1;
    const unregisteredRoot = join(temp, 'unregistered-command');
    await mkdir(unregisteredRoot, { recursive: true });
    await writeFile(
      join(unregisteredRoot, 'README.md'),
      '<!-- docs:case no-such-case -->\n```console\naudit-estimator estimate .\n```\n',
    );
    expectControl('unregistered runnable fence', () =>
      expectValidatorFailure(
        () => validateCommandFences(['README.md'], unregisteredRoot, { cases: [] }),
        'unregistered runnable command case',
      ),
    );
    negative += 1;

    const badRoot = join(temp, 'bad-checker-root');
    await mkdir(join(badRoot, 'examples'), { recursive: true });
    await writeFile(join(badRoot, 'examples', 'manifest.json'), manifestTextForControl(root));
    const scriptPath = fileURLToPath(import.meta.url);
    const child = spawnSync(process.execPath, [scriptPath, '--check-root', badRoot], {
      cwd: badRoot,
      encoding: 'utf8',
      shell: false,
      timeout: 10_000,
      env: { PATH: process.env.PATH ?? '' },
    });
    if (child.error !== undefined || child.status === 0 || child.status === null) {
      fail(
        'Documentation checker self-test did not propagate a failing check as a nonzero process status',
      );
    }
    negative += 1;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  process.stdout.write(
    `docs:check self-test passed: ${positive} positive and ${negative} negative controls (${positive + negative} assertions).\n`,
  );
}

function manifestTextForControl(root) {
  return readFileSync(join(root, 'examples/manifest.json'), 'utf8');
}

async function run() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') {
    await runSelfTests(repositoryRoot);
    return;
  }
  let root = repositoryRoot;
  if (args.length === 2 && args[0] === '--check-root') {
    root = resolve(args[1] ?? '');
  } else if (args.length !== 0) {
    fail('Usage: node scripts/check-docs.mjs [--self-test]');
  }
  const manifest = checkRepository(root);
  await runSelfTests(root);
  const { temporary, schemas } = await loadInternalSchemas(root);
  try {
    validateRuntimeExamples(root, manifest, schemas);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  process.stdout.write(
    `docs:check passed: ${manifest.documents.length} documents, ${manifest.cases.filter((item) => item.documentMarkers.length > 0).length} registered command cases, ${manifest.jsonExamples.length} runtime-schema examples.\n`,
  );
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown documentation-check failure';
  process.stderr.write(`docs:check failed: ${message}\n`);
  process.exitCode = 1;
});
