import { link } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { analyzeProject } from '../../src/index.ts';
import type { Measurement, ReportEnvelope } from '../../src/domain/types.ts';
import { serializeJson } from '../../src/reporting/json.ts';
import { formatTerminal } from '../../src/reporting/terminal.ts';
import {
  absoluteProjectPath,
  createProject,
  removeProject,
  writeProjectFile,
} from '../helpers/filesystem.ts';

const CORE_SOURCE = `pragma solidity 0.8.37;
library Double {
    function twice(uint256 value) internal pure returns (uint256) {
        return value * 2;
    }
}
contract Store {
    uint256 value;
    function set(uint256 next) external {
        if (next > 0) { value = Double.twice(next); }
    }
}
`;

function metric<T>(value: Measurement<T>): unknown {
  return value.status === 'measured'
    ? { status: value.status, value: value.value }
    : { status: value.status, reason: value.reason };
}

function measuredValue<T>(value: Measurement<T>): T {
  if (value.status !== 'measured')
    throw new Error(`Expected a measured value; got ${value.status}.`);
  return value.value;
}

function ordered<T>(values: readonly T[], project: (value: T) => string): T[] {
  return [...values].sort((left, right) => project(left).localeCompare(project(right)));
}

function analysisOf(envelope: ReportEnvelope) {
  if (envelope.analysis === null) throw new Error('Expected a complete analysis envelope.');
  return envelope.analysis;
}

function effortProjection(estimate: ReportEnvelope['estimate']): unknown {
  if (estimate === null) return null;
  return {
    profile: estimate.profile,
    modelVersion: estimate.modelVersion,
    label: estimate.label,
    coverage: estimate.coverage,
    auditorHours: estimate.auditorHours,
    auditorDays: estimate.auditorDays,
    contributions: [...estimate.contributions]
      .map(({ category, lowMicrohours, highMicrohours, inputStatus }) => ({
        category,
        lowMicrohours,
        highMicrohours,
        inputStatus,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    assumptions: estimate.assumptions,
    parameters: estimate.parameters,
  };
}

function stableFacts(envelope: ReportEnvelope): unknown {
  const analysis = analysisOf(envelope);
  const paths = new Map<string, string>(
    analysis.files.map((file) => [file.fileId, file.fileId.slice('file:'.length)]),
  );
  const contractLabels = new Map<string, string>();
  for (const contract of analysis.contracts) {
    const path = paths.get(contract.fileId) ?? '';
    contractLabels.set(contract.id, `${path}:contract:${contract.kind}:${contract.name}`);
  }
  const callableLabels = new Map<string, string>();
  for (const callable of analysis.callables) {
    const path = paths.get(callable.fileId) ?? '';
    const owner =
      callable.contractId === null
        ? `${path}:free`
        : (contractLabels.get(callable.contractId) ?? `${path}:unknown-owner`);
    callableLabels.set(callable.id, `${owner}:callable:${callable.kind}:${callable.name}`);
  }
  const endpoint = (id: string): string => {
    const label = contractLabels.get(id) ?? callableLabels.get(id) ?? paths.get(id);
    if (label === undefined) throw new Error(`Unknown relationship endpoint ${id}.`);
    return label;
  };
  const stateFacts = (state: {
    readonly count: Measurement<number>;
    readonly mutableCount: Measurement<number>;
    readonly complexMutableDeclarationIds: Measurement<readonly string[]>;
    readonly typeShapes: Measurement<
      readonly { readonly shape: string; readonly mutable: boolean }[]
    >;
  }) => ({
    count: metric(state.count),
    mutableCount: metric(state.mutableCount),
    complexCount:
      state.complexMutableDeclarationIds.status === 'measured'
        ? state.complexMutableDeclarationIds.value.length
        : {
            status: state.complexMutableDeclarationIds.status,
            reason: state.complexMutableDeclarationIds.reason,
          },
    typeShapes:
      state.typeShapes.status === 'measured'
        ? ordered(state.typeShapes.value, (shape) => `${shape.shape}:${shape.mutable}`).map(
            (shape) => ({ shape: shape.shape, mutable: shape.mutable }),
          )
        : { status: state.typeShapes.status, reason: state.typeShapes.reason },
  });
  const edges = analysis.graphs
    .map((edge) => ({
      kind: edge.kind,
      from: endpoint(edge.from),
      to: 'to' in edge ? endpoint(edge.to) : null,
      resolution: edge.resolution,
      candidates: ordered(edge.candidateTargets.map(endpoint), (candidate) => candidate),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const files = [...analysis.files].sort((left, right) =>
    (paths.get(left.fileId) ?? '').localeCompare(paths.get(right.fileId) ?? ''),
  );
  const contracts = [...analysis.contracts].sort((left, right) =>
    (contractLabels.get(left.id) ?? '').localeCompare(contractLabels.get(right.id) ?? ''),
  );
  const callables = [...analysis.callables].sort((left, right) =>
    (callableLabels.get(left.id) ?? '').localeCompare(callableLabels.get(right.id) ?? ''),
  );

  return {
    files: files.map((file) => ({
      path: paths.get(file.fileId),
      role: file.role,
      ownership: file.ownership,
      sourceLines: metric(file.sourceLines),
      declarationCounts: {
        contracts: metric(file.declarationCounts.contracts),
        abstractContracts: metric(file.declarationCounts.abstractContracts),
        libraries: metric(file.declarationCounts.libraries),
        interfaces: metric(file.declarationCounts.interfaces),
      },
      stateVariables: stateFacts(file.stateVariables),
      decisions: metric(file.decisions),
      loops: metric(file.loops),
      assemblyBlocks: metric(file.assemblyBlocks),
      lowLevelCallCandidates: metric(file.lowLevelCallCandidates),
    })),
    contracts: contracts.map((contract) => ({
      label: contractLabels.get(contract.id),
      kind: contract.kind,
      sourceLines: metric(contract.sourceLines),
      stateVariables: stateFacts(contract.stateVariables),
    })),
    callables: callables.map((callable) => ({
      label: callableLabels.get(callable.id),
      visibilityExplicit: metric(callable.visibilityExplicit),
      visibilityEffective: metric(callable.visibilityEffective),
      mutabilityExplicit: metric(callable.mutabilityExplicit),
      mutabilityEffective: metric(callable.mutabilityEffective),
      hasBody: metric(callable.hasBody),
      decisions: metric(callable.decisions),
      loops: metric(callable.loops),
      maxLoopDepth: metric(callable.maxLoopDepth),
      assemblyBlocks: metric(callable.assemblyBlocks),
      yulStatements: metric(callable.yulStatements),
      yulCalls: metric(callable.yulCalls),
      yulControlFlow: metric(callable.yulControlFlow),
      lowLevelCallCandidates: metric(callable.lowLevelCallCandidates),
    })),
    edges,
    aggregates: {
      scopedFiles: metric(analysis.aggregates.scopedFiles),
      sourceLines: metric(analysis.aggregates.sourceLines),
      contracts: metric(analysis.aggregates.contracts),
      callables: metric(analysis.aggregates.callables),
    },
    completeness: analysis.completeness,
    estimate: effortProjection(envelope.estimate),
    fullScopeEstimate: effortProjection(envelope.fullScopeEstimate),
  };
}

function coordinateSnapshot(envelope: ReportEnvelope): unknown {
  const analysis = analysisOf(envelope);
  const paths = new Map<string, string>(
    analysis.files.map((file) => [file.fileId, file.fileId.slice('file:'.length)]),
  );
  return {
    contracts: analysis.contracts.map((contract) => ({
      id: contract.id,
      path: paths.get(contract.fileId),
      range: contract.range,
    })),
    callables: analysis.callables.map((callable) => ({
      id: callable.id,
      path: paths.get(callable.fileId),
      range: callable.range,
    })),
    edges: analysis.graphs.map((edge) => ({
      id: edge.id,
      evidence: edge.evidence.map((item) => ({ path: paths.get(item.fileId), range: item.range })),
    })),
  };
}

function byteHashes(
  envelope: ReportEnvelope,
): readonly { readonly path: string; readonly hash: string }[] {
  return envelope.scope.entries
    .map((entry) => ({ path: entry.path, hash: entry.byteHash }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function withAnalyzedSources<T>(
  sources: Readonly<Record<string, string | Uint8Array>>,
  options: { readonly format?: 'terminal' | 'json' | 'markdown'; readonly noConfig?: boolean } = {},
  inspect: (root: string, envelope: ReportEnvelope) => T,
): Promise<T> {
  const root = await createProject('audit-estimator-stability-');
  try {
    for (const [path, source] of Object.entries(sources)) {
      await writeProjectFile(root, path, source);
    }
    const result = await analyzeProject({
      command: 'estimate',
      input: root,
      noConfig: options.noConfig ?? true,
      allowPartial: false,
      ...(options.format === undefined ? {} : { format: options.format }),
    });
    expect(result.outcome).toBe('complete');
    return inspect(root, result.envelope);
  } finally {
    await removeProject(root);
  }
}

async function analyzeSources(
  sources: Readonly<Record<string, string | Uint8Array>>,
  options: { readonly format?: 'terminal' | 'json' | 'markdown'; readonly noConfig?: boolean } = {},
): Promise<ReportEnvelope> {
  return withAnalyzedSources(sources, options, (_root, envelope) => envelope);
}

describe('analysis stability projections', () => {
  it('preserves structural facts and effort across comments, blank lines and LF/CRLF', async () => {
    const lf = await analyzeSources({ 'src/Core.sol': CORE_SOURCE });
    const commented = await analyzeSources({
      'src/Core.sol': `// Leading review note.\n\n${CORE_SOURCE.replace(
        '    uint256 value;',
        '    // State used by this example.\n    uint256 value;',
      )}`,
    });
    expect(stableFacts(commented)).toEqual(stableFacts(lf));
    expect(commented.fingerprints.semanticConfig).toBe(lf.fingerprints.semanticConfig);
    expect(commented.fingerprints.sources).not.toBe(lf.fingerprints.sources);
    expect(commented.fingerprints.analysis).not.toBe(lf.fingerprints.analysis);
    expect(byteHashes(commented)).not.toEqual(byteHashes(lf));
    expect(coordinateSnapshot(commented)).not.toEqual(coordinateSnapshot(lf));
    const lfFile = analysisOf(lf).files[0];
    const commentedFile = analysisOf(commented).files[0];
    if (lfFile === undefined || commentedFile === undefined)
      throw new Error('Missing core file metrics.');
    expect(measuredValue(commentedFile.physicalLines)).toBe(
      measuredValue(lfFile.physicalLines) + 3,
    );

    const crlf = await analyzeSources({ 'src/Core.sol': CORE_SOURCE.replace(/\n/gu, '\r\n') });
    expect(stableFacts(crlf)).toEqual(stableFacts(lf));
    expect(crlf.fingerprints.semanticConfig).toBe(lf.fingerprints.semanticConfig);
    expect(crlf.fingerprints.sources).not.toBe(lf.fingerprints.sources);
    expect(crlf.fingerprints.analysis).not.toBe(lf.fingerprints.analysis);
    expect(byteHashes(crlf)).not.toEqual(byteHashes(lf));
    expect(coordinateSnapshot(crlf)).not.toEqual(coordinateSnapshot(lf));
    const crlfFile = analysisOf(crlf).files[0];
    if (crlfFile === undefined) throw new Error('Missing CRLF file metrics.');
    expect(metric(crlfFile.physicalLines)).toEqual(metric(lfFile.physicalLines));
  });

  it('preserves structural facts across a plain state identifier rename', async () => {
    const original = await analyzeSources({ 'src/Core.sol': CORE_SOURCE });
    const renamed = await analyzeSources({
      'src/Core.sol': CORE_SOURCE.replaceAll('value', 'amount'),
    });
    expect(stableFacts(renamed)).toEqual(stableFacts(original));
    expect(renamed.fingerprints.semanticConfig).toBe(original.fingerprints.semanticConfig);
    expect(renamed.fingerprints.sources).not.toBe(original.fingerprints.sources);
    expect(renamed.fingerprints.analysis).not.toBe(original.fingerprints.analysis);
    expect(byteHashes(renamed)).not.toEqual(byteHashes(original));
    expect(coordinateSnapshot(renamed)).not.toEqual(coordinateSnapshot(original));
  });

  it('serializes identically across relocation and reversed file creation order', async () => {
    const files = {
      'src/Alpha.sol': 'pragma solidity 0.8.37; contract Alpha { function a() external {} }\n',
      'src/Beta.sol': 'pragma solidity 0.8.37; contract Beta { function b() external {} }\n',
    };
    const forward = await withAnalyzedSources(files, {}, (root, envelope) => ({
      root,
      json: serializeJson(envelope),
    }));
    const backward = await withAnalyzedSources(
      Object.fromEntries(Object.entries(files).reverse()),
      {},
      (root, envelope) => ({ root, json: serializeJson(envelope) }),
    );
    expect(backward.json).toBe(forward.json);
    expect(forward.json).not.toContain(forward.root);
    expect(backward.json).not.toContain(backward.root);
    expect(forward.json).not.toContain(backward.root);
    expect(backward.json).not.toContain(forward.root);
  });

  it('preserves required analysis and effort across report formats', async () => {
    const sources = { 'src/Core.sol': CORE_SOURCE };
    const terminal = await analyzeSources(sources, { format: 'terminal' });
    const json = await analyzeSources(sources, { format: 'json' });
    const markdown = await analyzeSources(sources, { format: 'markdown' });
    for (const formatted of [json, markdown]) {
      expect(formatted.fingerprints.semanticConfig).toBe(terminal.fingerprints.semanticConfig);
      expect(formatted.fingerprints.analysis).toBe(terminal.fingerprints.analysis);
      expect(stableFacts(formatted)).toEqual(stableFacts(terminal));
    }
    const plain = formatTerminal(terminal, { color: false });
    const colored = formatTerminal(terminal, { color: true });
    expect(stripVTControlCharacters(colored)).toBe(plain);
  });

  it('keeps required analysis and effort stable when the optional LCOV path changes', async () => {
    const lcov = [
      'TN:Plan014',
      'SF:src/Core.sol',
      'DA:1,1',
      'DA:3,0',
      'LF:2',
      'LH:1',
      'end_of_record',
      '',
    ].join('\n');
    const withCoveragePath = (path: string) => ({
      'src/Core.sol': CORE_SOURCE,
      'audit-estimator.config.json': JSON.stringify({
        configVersion: '1.0.0',
        coverage: { lcovPath: path },
      }),
      'coverage/one.info': lcov,
      'coverage/two.info': lcov,
    });
    const one = await analyzeSources(withCoveragePath('coverage/one.info'), { noConfig: false });
    const two = await analyzeSources(withCoveragePath('coverage/two.info'), { noConfig: false });
    expect(one.fingerprints.semanticConfig).not.toBe(two.fingerprints.semanticConfig);
    expect(analysisOf(two).completeness).toEqual(analysisOf(one).completeness);
    expect(effortProjection(two.estimate)).toEqual(effortProjection(one.estimate));
    expect(effortProjection(two.fullScopeEstimate)).toEqual(
      effortProjection(one.fullScopeEstimate),
    );

    const changedContents = withCoveragePath('coverage/one.info');
    changedContents['coverage/one.info'] = lcov.replace('DA:1,1', 'DA:1,0');
    const contentVariant = await analyzeSources(changedContents, { noConfig: false });
    expect(contentVariant.fingerprints.semanticConfig).toBe(one.fingerprints.semanticConfig);
    expect(analysisOf(contentVariant).completeness).toEqual(analysisOf(one).completeness);
    expect(effortProjection(contentVariant.estimate)).toEqual(effortProjection(one.estimate));
    expect(effortProjection(contentVariant.fullScopeEstimate)).toEqual(
      effortProjection(one.fullScopeEstimate),
    );
  });

  it('counts a hardlink alias once and retains only the two source import sites', async () => {
    const shared = `pragma solidity 0.8.37;\nlibrary Shared {\n    function twice(uint256 x) internal pure returns (uint256) { return x * 2; }\n}\n`;
    const sources = {
      'src/Shared.sol': shared,
      'src/A.sol':
        'pragma solidity 0.8.37;\nimport "./Shared.sol";\ncontract A { function go(uint256 x) external pure returns (uint256) { return Shared.twice(x); } }\n',
      'src/B.sol':
        'pragma solidity 0.8.37;\nimport "./Shared.sol";\ncontract B { function go(uint256 x) external pure returns (uint256) { return Shared.twice(x); } }\n',
    };
    const baseline = await analyzeSources(sources);
    const root = await createProject('audit-estimator-stability-hardlink-');
    try {
      const sharedPath = await writeProjectFile(root, 'src/Shared.sol', shared);
      await link(sharedPath, absoluteProjectPath(root, 'src/SharedAlias.sol'));
      await writeProjectFile(root, 'src/A.sol', sources['src/A.sol']);
      await writeProjectFile(root, 'src/B.sol', sources['src/B.sol']);
      const result = await analyzeProject({
        command: 'estimate',
        input: root,
        noConfig: true,
        allowPartial: false,
      });
      expect(result.outcome).toBe('complete');
      expect(stableFacts(result.envelope)).toEqual(stableFacts(baseline));
      const analysis = analysisOf(result.envelope);
      const sharedRows = result.envelope.scope.entries.filter((entry) =>
        entry.path.startsWith('src/Shared'),
      );
      expect(sharedRows.map((entry) => entry.path)).toEqual(['src/Shared.sol']);
      expect(analysis.files.filter((file) => file.fileId.endsWith('Shared.sol'))).toHaveLength(1);
      const importEdges = analysis.graphs.filter((edge) => edge.kind === 'import');
      expect(importEdges).toHaveLength(2);
      expect(new Set(importEdges.map((edge) => edge.id)).size).toBe(2);
      const sharedCallEdges = analysis.graphs.filter(
        (edge) =>
          edge.kind === 'call' && edge.candidateTargets.some((target) => target.includes('Shared')),
      );
      expect(sharedCallEdges).toHaveLength(2);
      expect(new Set(sharedCallEdges.map((edge) => edge.id)).size).toBe(2);
    } finally {
      await removeProject(root);
    }
  });

  it('counts identical bytes at distinct physical paths independently', async () => {
    const shared = `pragma solidity 0.8.37;\nlibrary Shared {\n    function twice(uint256 x) internal pure returns (uint256) { return x * 2; }\n}\n`;
    const one = await analyzeSources({
      'src/Shared.sol': shared,
      'src/A.sol': 'pragma solidity 0.8.37; contract A {}\n',
    });
    const two = await analyzeSources({
      'src/Shared.sol': shared,
      'src/SharedCopy.sol': shared,
      'src/A.sol': 'pragma solidity 0.8.37; contract A {}\n',
    });
    const oneAnalysis = analysisOf(one);
    const twoAnalysis = analysisOf(two);
    expect(
      two.scope.entries.filter(
        (entry) =>
          entry.byteHash ===
          one.scope.entries.find((item) => item.path === 'src/Shared.sol')?.byteHash,
      ),
    ).toHaveLength(2);
    expect(measuredValue(twoAnalysis.aggregates.sourceLines)).toBe(
      measuredValue(oneAnalysis.aggregates.sourceLines) +
        measuredValue(
          twoAnalysis.files.find((file) => file.fileId.endsWith('SharedCopy.sol'))?.sourceLines ?? {
            status: 'unavailable',
            reason: 'missing',
          },
        ),
    );
  });

  it('counts a shared physical source line once in file SLOC', async () => {
    const envelope = await analyzeSources({
      'src/SharedLine.sol': 'pragma solidity 0.8.37; contract First {} contract Second {}\n',
    });
    const analysis = analysisOf(envelope);
    const file = analysis.files.find((item) => item.fileId.endsWith('SharedLine.sol'));
    if (file === undefined) throw new Error('Missing shared-line fixture metrics.');
    expect(measuredValue(file.sourceLines)).toBe(1);
    expect(analysis.contracts).toHaveLength(2);
    expect(analysis.contracts.map((contract) => measuredValue(contract.sourceLines))).toEqual([
      1, 1,
    ]);
    expect(measuredValue(analysis.aggregates.sourceLines)).toBe(1);
  });
});
