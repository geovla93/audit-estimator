import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConfigInputSchema,
  ModelProfileSchema,
  ReportEnvelopeSchema,
} from '../../src/domain/schemas.ts';
import { createProject, removeProject } from '../helpers/filesystem.ts';
import { repositoryRoot, runCli } from '../helpers/run-cli.ts';

const expectedOutputFileSchema = z.strictObject({
  path: z.string(),
  seed: z.string().nullable(),
  reportStatus: z.enum(['complete', 'partial', 'error']).nullable(),
});
const documentationCaseSchema = z.strictObject({
  id: z.string(),
  group: z.enum([
    'quickstart and scope',
    'schema and formula examples',
    'help and contracts',
    'governance and claims',
  ]),
  fixture: z.string().nullable(),
  cwd: z.enum(['repository', 'fixture']),
  argv: z.array(z.string()),
  documentMarkers: z.array(z.object({ file: z.string(), id: z.string() })),
  expected: z.strictObject({
    kind: z.enum(['report', 'text']),
    exitCode: z.number().int(),
    status: z.enum(['complete', 'partial', 'error']).nullable(),
    coverage: z.enum(['full', 'analyzed-subset']).nullable(),
    scopedPaths: z.array(z.string()),
    contextPaths: z.array(z.string()),
    ownership: z.array(
      z.strictObject({
        path: z.string(),
        value: z.enum(['first-party', 'third-party', 'unknown']),
      }),
    ),
    sourceLines: z.number().int().nullable(),
    estimate: z.enum(['full', 'subset', 'null', 'not-asserted']),
    stdoutEmpty: z.boolean(),
    stdoutIncludes: z.array(z.string()),
    stderrIncludes: z.array(z.string()),
    outputFile: expectedOutputFileSchema.nullable(),
  }),
});
const manifestSchema = z.object({
  cases: z.array(documentationCaseSchema),
  jsonExamples: z.array(
    z.object({ id: z.string(), file: z.string(), schema: z.enum(['config', 'model', 'result']) }),
  ),
  help: z.object({
    commands: z.array(z.string()),
    rootOptions: z.array(z.string()),
    commonOptions: z.array(z.string()),
    deferredTerms: z.array(z.string()),
  }),
  formulaOracle: z.object({
    sourceFile: z.string(),
    sourceLines: z.number().int(),
    projectHours: z.object({ low: z.number(), high: z.number() }),
    slocHours: z.object({ low: z.number(), high: z.number() }),
    hoursPerDay: z.number(),
    defaultHours: z.object({ low: z.number(), high: z.number() }),
    defaultDays: z.object({ low: z.number(), high: z.number() }),
    defaultLedger: z.array(
      z.object({
        category: z.string(),
        lowMicrohours: z.number().int(),
        highMicrohours: z.number().int(),
        inputStatus: z.enum(['measured', 'unavailable', 'manual']),
      }),
    ),
    manualAdjustment: z.object({
      id: z.string(),
      lowHours: z.number(),
      highHours: z.number(),
      adjustedHours: z.object({ low: z.number(), high: z.number() }),
      adjustedDays: z.object({ low: z.number(), high: z.number() }),
      ledger: z.object({
        category: z.string(),
        lowMicrohours: z.number().int(),
        highMicrohours: z.number().int(),
        inputStatus: z.enum(['measured', 'unavailable', 'manual']),
      }),
    }),
  }),
  libraryExample: z.object({
    document: z.string(),
    marker: z.string(),
    fixture: z.string(),
    sourceLines: z.number().int(),
  }),
});

type DocumentationCase = z.infer<typeof documentationCaseSchema>;
type Manifest = z.infer<typeof manifestSchema>;
type CaseWorkspace = { readonly root: string | null; readonly cwd: string };

const manifestPath = join(repositoryRoot, 'examples', 'manifest.json');
const manifest: Manifest = manifestSchema.parse(
  JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown,
);
const documentsPath = join(repositoryRoot, 'docs', 'cli.md');
const sourceFile = 'src/Vault.sol';
const configFile = 'audit-estimator.config.json';

function documentationCase(id: string): DocumentationCase {
  const found = manifest.cases.find((item) => item.id === id);
  if (found === undefined) throw new Error(`Missing documentation case ${id}`);
  return found;
}

function casesIn(group: DocumentationCase['group']): readonly DocumentationCase[] {
  return manifest.cases.filter((item) => item.group === group);
}

function parseEnvelope(text: string) {
  return ReportEnvelopeSchema.parse(JSON.parse(text) as unknown);
}

function assertReportCase(
  run: Awaited<ReturnType<typeof runCli>>,
  item: DocumentationCase,
  report: ReturnType<typeof parseEnvelope>,
): void {
  const expected = item.expected;
  expect(run.status).toBe(expected.exitCode);
  expect(run.stdout.length === 0).toBe(expected.stdoutEmpty);
  for (const value of expected.stdoutIncludes) expect(run.stdout).toContain(value);
  for (const value of expected.stderrIncludes) expect(run.stderr).toContain(value);
  expect(report.command).toBe(item.argv[1]);
  expect(report.status).toBe(expected.status);

  const scoped = report.scope.entries
    .filter((entry) => entry.role === 'scoped')
    .map((entry) => entry.path);
  const context = report.scope.entries
    .filter((entry) => entry.role === 'context')
    .map((entry) => entry.path);
  expect(scoped).toEqual(expected.scopedPaths);
  expect(context).toEqual(expected.contextPaths);

  if (expected.ownership.length > 0) {
    const ownership = report.scope.entries
      .filter((entry) => expected.ownership.some((assertion) => assertion.path === entry.path))
      .map((entry) => ({ path: entry.path, value: entry.ownership }))
      .sort((left, right) => left.path.localeCompare(right.path));
    expect(ownership).toEqual(
      [...expected.ownership].sort((left, right) => left.path.localeCompare(right.path)),
    );
  }
  if (expected.sourceLines !== null) {
    expect(report.analysis?.aggregates.sourceLines).toMatchObject({
      status: 'measured',
      value: expected.sourceLines,
    });
  }
  if (expected.estimate === 'null') {
    expect(report.estimate).toBeNull();
    expect(report.fullScopeEstimate).toBeNull();
  } else if (expected.estimate === 'full') {
    expect(report.estimate?.coverage).toBe('full');
    expect(report.fullScopeEstimate).toEqual(report.estimate);
  } else if (expected.estimate === 'subset') {
    expect(report.estimate?.coverage).toBe('analyzed-subset');
    expect(report.fullScopeEstimate).toBeNull();
  }
  if (expected.coverage !== null) expect(report.estimate?.coverage).toBe(expected.coverage);
}

function assertTextCase(run: Awaited<ReturnType<typeof runCli>>, item: DocumentationCase): void {
  expect(run.status).toBe(item.expected.exitCode);
  expect(run.stdout.length === 0).toBe(item.expected.stdoutEmpty);
  for (const value of item.expected.stdoutIncludes) expect(run.stdout).toContain(value);
  for (const value of item.expected.stderrIncludes) expect(run.stderr).toContain(value);
}

function assertWrittenOutput(
  text: string,
  output: NonNullable<DocumentationCase['expected']['outputFile']>,
): void {
  const actual = output.reportStatus === null ? text : parseEnvelope(text).status;
  const expected = output.reportStatus === null ? output.seed : output.reportStatus;
  expect(actual).toBe(expected);
}

async function withRegisteredCase<T>(
  item: DocumentationCase,
  verify: (run: Awaited<ReturnType<typeof runCli>>, workspace: CaseWorkspace) => Promise<T> | T,
): Promise<T> {
  if (item.fixture === null) {
    const run = await runCli(item.argv.slice(1));
    return await verify(run, { root: null, cwd: repositoryRoot });
  }

  const root = await createProject('audit-estimator-docs-e2e-');
  try {
    const fixtureSource = resolve(repositoryRoot, item.fixture);
    const cwd = root;
    if (item.cwd === 'repository') {
      const fixtureTarget = join(root, item.fixture);
      await mkdir(join(root, 'examples', 'projects'), { recursive: true });
      await cp(fixtureSource, fixtureTarget, { recursive: true });
    } else {
      await cp(fixtureSource, root, { recursive: true });
    }

    const output = item.expected.outputFile;
    if (output?.seed !== null && output?.seed !== undefined) {
      await writeFile(join(cwd, output.path), output.seed, 'utf8');
    }
    const protectedSnapshots = item.id.startsWith('output-')
      ? await Promise.all(
          [sourceFile, configFile].map(
            async (path) => [path, await readFile(join(root, path))] as const,
          ),
        )
      : [];
    const run = await runCli(item.argv.slice(1), { cwd });
    const result = await verify(run, { root, cwd });
    for (const [path, original] of protectedSnapshots) {
      expect(await readFile(join(root, path))).toEqual(original);
    }
    return result;
  } finally {
    await removeProject(root);
  }
}

async function verifyRegisteredCase(
  item: DocumentationCase,
  run: Awaited<ReturnType<typeof runCli>>,
  workspace: CaseWorkspace,
): Promise<void> {
  if (item.expected.kind === 'text') {
    assertTextCase(run, item);
    return;
  }

  const output = item.expected.outputFile;
  const reportText =
    output?.reportStatus !== null && output?.reportStatus !== undefined
      ? await readFile(join(workspace.cwd, output.path), 'utf8')
      : run.stdout;
  const report = parseEnvelope(reportText);
  assertReportCase(run, item, report);
  if (output !== null && output !== undefined) {
    const written = await readFile(join(workspace.cwd, output.path), 'utf8');
    assertWrittenOutput(written, output);
  }
}

function manualAdjustmentLedger(
  estimate: NonNullable<ReturnType<typeof parseEnvelope>['estimate']>,
): readonly {
  readonly id: string;
  readonly category: string;
  readonly inputStatus: string;
  readonly lowMicrohours: number;
  readonly highMicrohours: number;
}[] {
  return estimate.contributions.map(
    ({ id, category, inputStatus, lowMicrohours, highMicrohours }) => ({
      id,
      category,
      inputStatus,
      lowMicrohours,
      highMicrohours,
    }),
  );
}

function helpTableFirstColumn(text: string, markerId: string): readonly string[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const marker = `<!-- docs:help ${markerId} -->`;
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start < 0) throw new Error(`Missing help table marker ${markerId}`);
  const table: string[] = [];
  let tableStart = start + 1;
  while (tableStart < lines.length && (lines[tableStart] ?? '').trim() === '') tableStart += 1;
  for (
    let index = tableStart;
    index < lines.length && (lines[index] ?? '').trim().startsWith('|');
    index += 1
  ) {
    table.push(lines[index] ?? '');
  }
  return table
    .slice(2)
    .map((line) => (line.split('|')[1]?.trim() ?? '').replace(/^`|`$/gu, ''))
    .filter(Boolean);
}

function commandInventory(help: string): readonly string[] {
  const lines = help.replace(/\r\n?/gu, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === 'Commands:');
  if (start < 0) throw new Error('Root help has no Commands section');
  return lines.slice(start + 1).flatMap((line) => {
    const match = /^\s{2}([a-z][a-z-]*)(?:\s|$)/u.exec(line);
    return match === null ? [] : [match[1] ?? ''];
  });
}

function optionInventory(help: string): readonly string[] {
  const lines = help.replace(/\r\n?/gu, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === 'Options:');
  if (start < 0) throw new Error('Help has no Options section');
  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break;
    const match =
      /^\s{2}(-{1,2}[A-Za-z0-9][A-Za-z0-9-]*(?:,\s+-{1,2}[A-Za-z0-9][A-Za-z0-9-]*)?(?:\s+<[^>]+>)?)/u.exec(
        line,
      );
    if (match !== null) rows.push((match[1] ?? '').replace(/\s+/gu, ' '));
  }
  return rows;
}

function assertDefaultFormula(run: Awaited<ReturnType<typeof runCli>>): void {
  const envelope = parseEnvelope(run.stdout);
  const estimate = envelope.estimate;
  if (estimate === null)
    throw new Error('The registered complete example did not produce an estimate');
  const oracle = manifest.formulaOracle;
  expect(envelope.analysis?.aggregates.sourceLines).toMatchObject({
    status: 'measured',
    value: 7,
  });
  expect(envelope.analysis?.aggregates.sourceLines).toMatchObject({
    status: 'measured',
    value: oracle.sourceLines,
  });

  const rows = manualAdjustmentLedger(estimate);
  const byCategory = new Map(rows.map((row) => [row.category, row]));
  expect(rows.map(({ category }) => category).sort()).toEqual([
    'baseline',
    'control',
    'evm',
    'project',
    'reserve',
    'storage',
  ]);
  expect(byCategory.get('project')).toEqual({
    id: 'project',
    category: 'project',
    inputStatus: 'measured',
    lowMicrohours: 4_000_000,
    highMicrohours: 12_000_000,
  });
  expect(byCategory.get('baseline')).toMatchObject({
    id: expect.stringMatching(/^baseline:[a-f0-9]{64}$/u),
    inputStatus: 'measured',
    lowMicrohours: 280_000,
    highMicrohours: 840_000,
  });
  expect(byCategory.get('control')).toMatchObject({
    inputStatus: 'measured',
    lowMicrohours: 0,
    highMicrohours: 0,
  });
  expect(byCategory.get('storage')).toMatchObject({
    inputStatus: 'measured',
    lowMicrohours: 0,
    highMicrohours: 0,
  });
  expect(byCategory.get('evm')).toMatchObject({
    inputStatus: 'measured',
    lowMicrohours: 0,
    highMicrohours: 0,
  });
  expect(byCategory.get('reserve')).toEqual({
    id: 'reserve',
    category: 'reserve',
    inputStatus: 'measured',
    lowMicrohours: 0,
    highMicrohours: 0,
  });

  const literalLedger = oracle.defaultLedger
    .map((entry) => ({
      category: entry.category,
      inputStatus: entry.inputStatus,
      lowMicrohours: entry.lowMicrohours,
      highMicrohours: entry.highMicrohours,
    }))
    .sort((left, right) => left.category.localeCompare(right.category));
  const actualLedger = rows
    .map(({ category, inputStatus, lowMicrohours, highMicrohours }) => ({
      category,
      inputStatus,
      lowMicrohours,
      highMicrohours,
    }))
    .sort((left, right) => left.category.localeCompare(right.category));
  expect(actualLedger).toEqual(literalLedger);
  const lowTotalMicrohours = rows.reduce((total, row) => total + row.lowMicrohours, 0);
  const highTotalMicrohours = rows.reduce((total, row) => total + row.highMicrohours, 0);
  expect(lowTotalMicrohours).toBe(4_280_000);
  expect(highTotalMicrohours).toBe(12_840_000);
  expect(estimate.auditorHours).toEqual({ low: 4, high: 13 });
  expect(estimate.auditorDays).toEqual({ low: 0.5, high: 1.7 });
  expect(estimate.auditorHours).toEqual(oracle.defaultHours);
  expect(estimate.auditorDays).toEqual(oracle.defaultDays);
}

describe('quickstart and scope', () => {
  const quickstartCases = casesIn('quickstart and scope').filter(
    (item) => item.id !== 'quickstart-estimate' && item.id !== 'quickstart-explain',
  );

  it.each(quickstartCases)('runs registered CLI case $id', async (item) => {
    expect(item.documentMarkers.length).toBeGreaterThan(0);
    await withRegisteredCase(item, async (run, workspace) => {
      await verifyRegisteredCase(item, run, workspace);
    });
  });

  it('runs registered estimate and explain examples with matching effort', async () => {
    const estimateCase = documentationCase('quickstart-estimate');
    const explainCase = documentationCase('quickstart-explain');
    const estimate = await withRegisteredCase(estimateCase, async (run, workspace) => {
      await verifyRegisteredCase(estimateCase, run, workspace);
      assertDefaultFormula(run);
      return parseEnvelope(run.stdout).estimate;
    });
    const explained = await withRegisteredCase(explainCase, async (run, workspace) => {
      await verifyRegisteredCase(explainCase, run, workspace);
      return parseEnvelope(run.stdout).estimate;
    });
    expect(explained).toEqual(estimate);
  });
});

describe('schema and formula examples', () => {
  it('validates every registered JSON example with its runtime schema', () => {
    const validatedIds: string[] = [];
    for (const example of manifest.jsonExamples) {
      const input = JSON.parse(readFileSync(join(repositoryRoot, example.file), 'utf8')) as unknown;
      if (example.schema === 'config') ConfigInputSchema.parse(input);
      else if (example.schema === 'model') ModelProfileSchema.parse(input);
      else ReportEnvelopeSchema.parse(input);
      validatedIds.push(example.id);
    }
    expect(validatedIds).toEqual(manifest.jsonExamples.map((example) => example.id));
  });

  it('applies the signed adjustment only as a manual ledger row and total change', async () => {
    await withRegisteredCase(documentationCase('manual-adjustment'), async (run) => {
      const envelope = parseEnvelope(run.stdout);
      const estimate = envelope.estimate;
      if (estimate === null)
        throw new Error('Manual adjustment fixture did not produce an estimate');
      const actualRows = manualAdjustmentLedger(estimate);
      const oracle = manifest.formulaOracle.manualAdjustment;
      const manualRows = actualRows.filter((row) => row.category === 'manual');
      expect(manualRows).toHaveLength(1);
      expect(manualRows[0]).toMatchObject({
        id: expect.stringMatching(/^manual:[a-f0-9]{64}$/u),
        inputStatus: 'manual',
        lowMicrohours: -500_000,
        highMicrohours: -250_000,
      });
      expect(manualRows[0]).toMatchObject({
        category: oracle.ledger.category,
        inputStatus: oracle.ledger.inputStatus,
        lowMicrohours: oracle.ledger.lowMicrohours,
        highMicrohours: oracle.ledger.highMicrohours,
      });
      const unchangedRows = actualRows
        .filter((row) => row.category !== 'manual')
        .map(({ category, inputStatus, lowMicrohours, highMicrohours }) => ({
          category,
          inputStatus,
          lowMicrohours,
          highMicrohours,
        }))
        .sort((left, right) => left.category.localeCompare(right.category));
      const literalDefaultRows = manifest.formulaOracle.defaultLedger
        .map(({ category, inputStatus, lowMicrohours, highMicrohours }) => ({
          category,
          inputStatus,
          lowMicrohours,
          highMicrohours,
        }))
        .sort((left, right) => left.category.localeCompare(right.category));
      expect(unchangedRows).toEqual(literalDefaultRows);
      expect(estimate.manualAdjustments).toEqual([
        {
          id: oracle.id,
          reason: 'Remove time for deployment work excluded from this review.',
          category: 'scope correction',
          lowHours: oracle.lowHours,
          highHours: oracle.highHours,
        },
      ]);
      expect(estimate.auditorHours).toEqual({ low: 3, high: 13 });
      expect(estimate.auditorDays).toEqual({ low: 0.3, high: 1.7 });
      expect(estimate.auditorHours).toEqual(oracle.adjustedHours);
      expect(estimate.auditorDays).toEqual(oracle.adjustedDays);
    });
  });
});

describe('help and contracts', () => {
  const helpCases = casesIn('help and contracts');

  it('matches documented help rows to built-bin root and command help', async () => {
    const docs = await readFile(documentsPath, 'utf8');
    expect(helpTableFirstColumn(docs, 'commands')).toEqual(manifest.help.commands);
    expect(helpTableFirstColumn(docs, 'root-options')).toEqual(manifest.help.rootOptions);
    expect(helpTableFirstColumn(docs, 'common-options')).toEqual(manifest.help.commonOptions);

    const rootHelp = await runCli(['--help']);
    const commandHelp = await Promise.all(
      ['estimate', 'inspect', 'explain'].map((command) => runCli([command, '--help'])),
    );
    const helpRuns = new Map([
      ['help-root', rootHelp],
      ...['estimate', 'inspect', 'explain'].map(
        (command, index) => [`help-${command}`, commandHelp[index]] as const,
      ),
    ]);
    expect(helpCases.map((item) => item.id)).toEqual([
      'help-root',
      'help-estimate',
      'help-inspect',
      'help-explain',
    ]);
    for (const item of helpCases) {
      const run = helpRuns.get(item.id);
      if (run === undefined) throw new Error(`No built-bin help output for ${item.id}`);
      await verifyRegisteredCase(item, run, { root: null, cwd: repositoryRoot });
    }
    expect(rootHelp.status).toBe(0);
    expect(commandInventory(rootHelp.stdout)).toEqual(manifest.help.commands);
    expect(optionInventory(rootHelp.stdout)).toEqual(manifest.help.rootOptions);
    for (const run of commandHelp) {
      expect(run.status).toBe(0);
      expect(optionInventory(run.stdout)).toEqual(manifest.help.commonOptions);
    }
    const allHelp = [rootHelp.stdout, ...commandHelp.map((run) => run.stdout)]
      .join('\n')
      .toLowerCase();
    for (const deferred of ['explorer', 'archive', 'slither', 'pricing', 'price', 'confidence']) {
      expect(allHelp).not.toContain(deferred);
    }
  });

  it('runs the public-root library example with native Node', async () => {
    const libraryExample = resolve(repositoryRoot, manifest.libraryExample.document);
    const text = await readFile(libraryExample, 'utf8');
    const markerPattern = manifest.libraryExample.marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = new RegExp(
      `<!-- docs:library ${markerPattern} -->\\r?\\n(?:[ \\t]*\\r?\\n)*[ \\t]*\\x60\\x60\\x60js\\r?\\n([\\s\\S]*?)\\r?\\n\\x60\\x60\\x60`,
      'u',
    ).exec(text);
    if (match === null) throw new Error('Missing public library example fence');
    const code = match[1] ?? '';
    const workspace = await createProject('audit-estimator-library-e2e-');
    const target = join(workspace, manifest.libraryExample.fixture);
    await mkdir(join(repositoryRoot, '.vitest'), { recursive: true });
    const tempDirectory = await mkdtemp(join(repositoryRoot, '.vitest', 'plan016-library-'));
    const tempScript = join(tempDirectory, 'library-example.mjs');
    try {
      await mkdir(join(workspace, 'examples', 'projects'), { recursive: true });
      await cp(resolve(repositoryRoot, manifest.libraryExample.fixture), target, {
        recursive: true,
      });
      await writeFile(tempScript, code, 'utf8');
      const child = spawnSync(process.execPath, [tempScript], {
        cwd: target,
        encoding: 'utf8',
        shell: false,
        timeout: 60_000,
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      const output = z
        .strictObject({ status: z.literal('complete'), sourceLines: z.number().int() })
        .parse(JSON.parse(child.stdout) as unknown);
      expect(output.sourceLines).toBe(manifest.libraryExample.sourceLines);
      expect(child.stderr).toBe('');
    } finally {
      await removeProject(workspace);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});

describe('governance and claims', () => {
  it('keeps licensing, contact and calibration claims explicitly pending', async () => {
    const fullManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      provenance: { status: string; licenseStatus: string; licenseNote: string };
      help: { deferredTerms: readonly string[] };
    };
    expect(fullManifest.provenance.status).toBe('PENDING_OWNER_APPROVAL');
    expect(fullManifest.provenance.licenseStatus).toBe('PENDING_OWNER_APPROVAL');
    expect(await readFile(join(repositoryRoot, 'examples', 'README.md'), 'utf8')).toContain(
      fullManifest.provenance.licenseNote,
    );
    expect(await readFile(join(repositoryRoot, 'README.md'), 'utf8')).toContain(
      'uncalibrated heuristic',
    );
    expect(await readFile(join(repositoryRoot, 'README.md'), 'utf8')).toContain(
      'planning scenario',
    );
    expect(await readFile(join(repositoryRoot, 'SECURITY.md'), 'utf8')).toContain(
      'PENDING OWNER DECISION',
    );
    expect(await readFile(join(repositoryRoot, 'docs', 'roadmap.md'), 'utf8')).toContain(
      'consented calibration',
    );
    expect(
      (await readFile(join(repositoryRoot, 'docs', 'roadmap.md'), 'utf8')).toLowerCase(),
    ).toContain('safe remote acquisition');
    expect(fullManifest.help.deferredTerms).toContain('explorer');
  });
});
