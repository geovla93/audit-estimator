import { readFile } from 'node:fs/promises';
import { LanguageFacts } from '@nomicfoundation/slang/utils';
import { describe, expect, it } from 'vitest';
import { analyzeProject } from '../../src/index.ts';
import { parseLcovBatches } from '../../src/indicators/lcov.ts';
import { fileIdentity } from '../../src/domain/canonical.ts';
import type { Measurement } from '../../src/domain/types.ts';
import type { LcovParseResult } from '../../src/indicators/lcov.ts';
import fixtureManifest from '../fixtures/manifest.json' with { type: 'json' };
import { createProject, removeProject, writeProjectFile } from '../helpers/filesystem.ts';

const fixtureRoot = new URL('../fixtures/', import.meta.url);

function measured<T>(measurement: Measurement<T>): T {
  if (measurement.status !== 'measured') {
    throw new Error(`Expected a measured value, received ${measurement.status}.`);
  }
  return measurement.value;
}

function ordered<T extends string>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.localeCompare(right));
}

async function analyzeOracle(
  oracle: (typeof fixtureManifest.measurementOracles)[number],
): Promise<Awaited<ReturnType<typeof analyzeProject>>> {
  const root = await createProject('audit-estimator-measurement-oracle-');
  try {
    for (const file of oracle.files) {
      const source = await readFile(new URL(file.file, fixtureRoot));
      await writeProjectFile(root, file.projectPath, source);
    }
    return await analyzeProject({
      command: 'inspect',
      input: root,
      noConfig: true,
      allowPartial: false,
    });
  } finally {
    await removeProject(root);
  }
}

describe('hand-counted measurement oracles', () => {
  it('preserves fixture registries and records literal sites with consistent totals', async () => {
    expect(Object.keys(fixtureManifest)).toEqual(
      expect.arrayContaining(['fixtures', 'readinessFixtures', 'discoveryFixtures']),
    );
    expect(fixtureManifest.fixtures.every((fixture) => fixture.file.endsWith('.sol'))).toBe(true);

    const versions = LanguageFacts.allVersions();
    expect(LanguageFacts.earliestVersion()).toBe('0.4.11');
    expect(LanguageFacts.latestVersion()).toBe('0.8.37');
    expect(versions).toHaveLength(92);
    expect(versions).toContain(LanguageFacts.latestVersion());

    const fixturePaths = fixtureManifest.fixtures.map((fixture) => fixture.file);
    expect(new Set(fixturePaths).size).toBe(fixturePaths.length);
    const fixtureByPath = new Map(
      fixtureManifest.fixtures.map((fixture) => [fixture.file, fixture]),
    );
    const measurementFixtures = fixtureManifest.fixtures.filter((fixture) =>
      fixture.file.startsWith('measurement/'),
    );
    expect(measurementFixtures).toHaveLength(9);

    for (const fixture of measurementFixtures) {
      expect(fixture.origin).toBe('original');
      expect(fixture.author).toBe(
        'Original in-repository fixture; individual author not identified',
      );
      expect(fixture.authoredFor).toBe('Plan 014');
      expect(fixture.license).toBe('MIT (proposed)');
      expect(fixture.grammarVersion).toBe(fixture.intendedVersion);
      expect(versions).toContain(fixture.grammarVersion);
      const source = await readFile(new URL(fixture.file, fixtureRoot));
      const text = source.toString('utf8');
      const lineBreaks = text.match(/\r\n|\r|\n|\u2028|\u2029/g)?.length ?? 0;
      const hasFinalLineBreak = /(?:\r\n|\r|\n|\u2028|\u2029)$/.test(text);
      expect(source.byteLength).toBe(fixture.physicalBytes);
      expect(lineBreaks + (hasFinalLineBreak ? 0 : 1)).toBe(fixture.physicalLines);
    }

    const oracleIds = fixtureManifest.measurementOracles.map((oracle) => oracle.id);
    expect(new Set(oracleIds).size).toBe(oracleIds.length);
    const oraclePaths = fixtureManifest.measurementOracles.flatMap((oracle) =>
      oracle.files.map((file) => file.file),
    );
    expect(ordered(oraclePaths)).toEqual(
      ordered(measurementFixtures.map((fixture) => fixture.file)),
    );

    const sourceSiteChecks: boolean[] = [];
    for (const oracle of fixtureManifest.measurementOracles) {
      expect(oracle.files.length).toBeGreaterThan(0);
      for (const file of oracle.files) {
        const unavailableMeasurement =
          'unavailableMeasurement' in file ? file.unavailableMeasurement : undefined;
        expect(fixtureByPath.has(file.file)).toBe(true);
        expect(file.projectPath.startsWith('/')).toBe(false);
        expect(file.sourceLineSites === null).toBe(unavailableMeasurement !== undefined);
        expect(file.declarationSites === null).toBe(unavailableMeasurement !== undefined);
        expect(file.decisionSites === null).toBe(unavailableMeasurement !== undefined);
        if (unavailableMeasurement !== undefined) {
          sourceSiteChecks.push(oracle.expectedParse?.code === unavailableMeasurement);
          sourceSiteChecks.push(oracle.totals.sourceLines === null);
          sourceSiteChecks.push(oracle.totals.declarations === null);
          sourceSiteChecks.push(oracle.totals.decisions === null);
        } else {
          const registered = fixtureByPath.get(file.file);
          if (registered === undefined) throw new Error(`Unregistered fixture ${file.file}.`);
          const text = (await readFile(new URL(file.file, fixtureRoot))).toString('utf8');
          const physicalSourceLines = text.split(/\r\n|\r|\n|\u2028|\u2029/);
          if (file.sourceLineSites === null) {
            throw new Error(`Valid fixture ${file.file} has unavailable source-line sites.`);
          }
          sourceSiteChecks.push(new Set(file.sourceLineSites).size === file.sourceLineSites.length);
          sourceSiteChecks.push(file.sourceLineSites.every((line) => line > 0));
          for (const line of file.sourceLineSites) {
            const sourceLine = physicalSourceLines[line - 1];
            sourceSiteChecks.push(line <= registered.physicalLines);
            sourceSiteChecks.push(sourceLine?.trim() !== '');
            sourceSiteChecks.push(!/^\s*(?:\/\/|\/\*|\*)/u.test(sourceLine ?? ''));
          }
        }
      }

      const measuredTotals = {
        sourceLines: oracle.files.reduce(
          (total, file) => total + (file.sourceLineSites?.length ?? 0),
          0,
        ),
        declarations: oracle.files.reduce(
          (total, file) => total + (file.declarationSites?.length ?? 0),
          0,
        ),
        decisions: oracle.files.reduce(
          (total, file) => total + (file.decisionSites?.length ?? 0),
          0,
        ),
        edges: oracle.edgeSites.length,
      };
      const expectedTotals =
        oracle.expectedParse === undefined
          ? measuredTotals
          : { sourceLines: null, declarations: null, decisions: null, edges: null };
      expect(oracle.totals).toEqual(expectedTotals);
      sourceSiteChecks.push(
        oracle.expectedParse === undefined ||
          (oracle.expectedParse.status === 'failed' &&
            oracle.expectedParse.code === 'PARSE_INVALID'),
      );
    }
    expect(sourceSiteChecks.every(Boolean)).toBe(true);

    const artifact = fixtureManifest.measurementArtifacts.find(
      (fixture) => fixture.file === 'readiness-data/hand-authored.info',
    );
    expect(artifact).toBeDefined();
    if (artifact === undefined) throw new Error('Missing Plan 014 measurement artifact.');
    expect(
      fixtureManifest.readinessFixtures.some((fixture) => fixture.file === artifact.file),
    ).toBe(false);
    expect(artifact.origin).toBe('original');
    expect(artifact.author).toBe(
      'Original in-repository fixture; individual author not identified',
    );
    expect(artifact.authoredFor).toBe('Plan 014');
    expect(artifact.license).toBe('MIT (proposed)');
    const lcovBytes = await readFile(new URL(artifact.file, fixtureRoot));
    expect(lcovBytes.byteLength).toBe(artifact.physicalBytes);
    expect(lcovBytes.toString('utf8').split('\n').length - 1).toBe(artifact.physicalLines);
    const parser = parseLcovBatches(lcovBytes, {
      byteLimit: 1024,
      roots: [],
      targets: [
        {
          fileId: fileIdentity('src/A.sol'),
          role: 'scoped',
          paths: ['src/A.sol'],
          physicalLines: { status: 'measured', value: 3, evidence: [] },
        },
      ],
    });
    let lcovResult: LcovParseResult | undefined;
    for (;;) {
      const step = parser.next();
      if (step.done) {
        lcovResult = step.value;
        break;
      }
    }
    expect(lcovResult).toMatchObject({ status: 'parsed', coveredLines: 1, totalLines: 2 });
  });

  it.each(
    fixtureManifest.measurementOracles.filter((oracle) => oracle.expectedParse === undefined),
  )(
    'matches source lines, declaration sites, decisions and every emitted graph edge for $id',
    async (oracle) => {
      const result = await analyzeOracle(oracle);
      const analysis = result.envelope.analysis;
      expect(analysis).not.toBeNull();
      if (analysis === null) throw new Error(`Oracle ${oracle.id} returned no analysis.`);

      expect(result.envelope.status).toBe(oracle.expectedStatus);
      expect(ordered(result.envelope.diagnostics.map((item) => item.code))).toEqual(
        ordered(oracle.expectedDiagnosticCodes),
      );

      let sourceLineTotal = 0;
      let declarationTotal = 0;
      let decisionTotal = 0;
      for (const expectedFile of oracle.files) {
        const entry = result.envelope.scope.entries.find(
          (candidate) => candidate.path === expectedFile.projectPath,
        );
        expect(entry).toBeDefined();
        if (entry === undefined)
          throw new Error(`Missing scope entry ${expectedFile.projectPath}.`);
        const actualFile = analysis.files.find((candidate) => candidate.fileId === entry.fileId);
        expect(actualFile).toBeDefined();
        if (actualFile === undefined)
          throw new Error(`Missing file analysis ${expectedFile.projectPath}.`);

        const expectedLines = expectedFile.sourceLineSites?.length ?? 0;
        const sourceLines = measured(actualFile.sourceLines);
        expect(sourceLines).toBe(expectedLines);
        sourceLineTotal += sourceLines;

        const actualDeclarations = [
          ...analysis.contracts
            .filter((item) => item.fileId === actualFile.fileId)
            .map((item) => `${item.kind}:${item.name}`),
          ...analysis.callables
            .filter((item) => item.fileId === actualFile.fileId)
            .map((item) => `${item.kind}:${item.name ?? 'null'}`),
        ];
        const expectedDeclarations = (expectedFile.declarationSites ?? [])
          .filter((site) => site.kind !== 'state-variable')
          .map((site) => `${site.kind}:${site.name ?? 'null'}`);
        expect(ordered(actualDeclarations)).toEqual(ordered(expectedDeclarations));
        const expectedStateVariables = (expectedFile.declarationSites ?? []).filter(
          (site) => site.kind === 'state-variable',
        ).length;
        expect(measured(actualFile.stateVariables.count)).toBe(expectedStateVariables);
        declarationTotal += actualDeclarations.length + expectedStateVariables;

        const decisions = measured(actualFile.decisions);
        expect(decisions).toBe(expectedFile.decisionSites?.length ?? 0);
        decisionTotal += decisions;
        for (const site of expectedFile.decisionSites ?? []) {
          expect(site.kind).toBe('if');
          const sourceText = (await readFile(new URL(expectedFile.file, fixtureRoot))).toString(
            'utf8',
          );
          const sourceLine = sourceText.split(/\r\n|\r|\n|\u2028|\u2029/)[site.line - 1];
          expect(sourceLine).toMatch(/^\s*if\s*\(/u);
          const owner = analysis.callables.find(
            (callable) => callable.fileId === actualFile.fileId && callable.name === site.owner,
          );
          expect(owner).toBeDefined();
          if (owner === undefined) throw new Error(`Missing decision owner ${site.owner}.`);
          expect(measured(owner.decisions)).toBeGreaterThan(0);
        }
      }

      expect(sourceLineTotal).toBe(oracle.totals.sourceLines);
      expect(declarationTotal).toBe(oracle.totals.declarations);
      expect(decisionTotal).toBe(oracle.totals.decisions);
      expect(analysis.graphs).toHaveLength(oracle.totals.edges);

      const labels = new Map<string, string>();
      for (const entry of result.envelope.scope.entries) labels.set(entry.fileId, entry.path);
      for (const contract of analysis.contracts) labels.set(contract.id, contract.name);
      for (const callable of analysis.callables) {
        const contract = analysis.contracts.find(
          (candidate) => candidate.id === callable.contractId,
        );
        const name = callable.name ?? 'null';
        labels.set(callable.id, contract === undefined ? name : `${contract.name}.${name}`);
      }
      const label = (id: string): string => {
        const value = labels.get(id);
        if (value === undefined)
          throw new Error(`Graph endpoint ${id} is not a declared oracle endpoint.`);
        return value;
      };
      const actualEdges = analysis.graphs
        .map((edge) => ({
          kind: edge.kind,
          from: label(edge.from),
          to: 'to' in edge ? label(edge.to) : null,
          resolution: edge.resolution,
          candidateTargets: ordered(edge.candidateTargets.map(label)),
        }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const expectedEdges = oracle.edgeSites
        .map((edge) => {
          const to = edge.to ?? null;
          const candidateTargets =
            'candidateTargets' in edge ? edge.candidateTargets : typeof to === 'string' ? [to] : [];
          return {
            kind: edge.kind,
            from: edge.from,
            to,
            resolution: 'resolution' in edge ? edge.resolution : 'resolved-unique',
            candidateTargets: ordered(candidateTargets),
          };
        })
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      expect(actualEdges).toEqual(expectedEdges);
    },
  );

  it('keeps malformed source measurements unavailable while reporting the parse failure', async () => {
    const oracle = fixtureManifest.measurementOracles.find(
      (candidate) => candidate.id === 'partial-source',
    );
    expect(oracle).toBeDefined();
    if (oracle === undefined) throw new Error('Missing partial-source measurement oracle.');
    const result = await analyzeOracle(oracle);
    expect(result.envelope.status).toBe('partial');
    expect(ordered(result.envelope.diagnostics.map((item) => item.code))).toEqual(
      ordered(oracle.expectedDiagnosticCodes),
    );
    const file = result.envelope.analysis?.files[0];
    expect(file?.syntaxComplete).toBe(false);
    expect(file?.physicalLines.status).toBe('measured');
    expect(file?.physicalLines.status === 'measured' ? file.physicalLines.value : null).toBe(7);
    expect(file?.sourceLines).toEqual({ status: 'unavailable', reason: 'parse-invalid' });
    expect(result.envelope.analysis?.completeness.requiredAnalysisComplete).toBe(false);
  });
});
