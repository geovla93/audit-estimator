import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeProject } from '../../src/index.ts';
import { fileIdentity } from '../../src/domain/canonical.ts';
import type { SourceSnapshot } from '../../src/domain/types.ts';
import { createParserSessionForTests } from '../../src/parser/adapter.ts';
import type { SemanticComponentInput } from '../../src/parser/adapter.ts';
import type { ParserSource } from '../../src/parser/protocol.ts';
import { makeDiscoveryInput } from '../helpers/discovery-input.ts';
import {
  createProject,
  removeProject,
  testLimits,
  writeProjectFile,
} from '../helpers/filesystem.ts';

function realWorkerFactory(
  launches: number[],
  children: ChildProcessWithoutNullStreams[],
): () => ChildProcessWithoutNullStreams {
  const packageEntry = new URL(import.meta.resolve('audit-estimator'));
  const workerPath = fileURLToPath(new URL('./parser/worker.js', packageEntry));
  const packageRoot = resolve(fileURLToPath(new URL('../', packageEntry)));
  return () => {
    launches.push(launches.length + 1);
    const child = spawn(process.execPath, ['--max-old-space-size=64', workerPath], {
      cwd: packageRoot,
      env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    return child;
  };
}

async function assertChildrenReaped(
  children: readonly ChildProcessWithoutNullStreams[],
): Promise<void> {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
      expect(child.pid).toBeDefined();
      let alive = false;
      try {
        process.kill(child.pid as number, 0);
        alive = true;
      } catch (error: unknown) {
        alive = !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
      }
      expect(alive).toBe(false);
    }),
  );
}

function semanticInput(
  sources: readonly ParserSource[],
  syntax: Awaited<ReturnType<ReturnType<typeof createParserSessionForTests>['analyzeSources']>>,
): SemanticComponentInput {
  const members = sources.map((source) => {
    const parsed = syntax.files.find((item) => item.fileId === source.fileId);
    if (parsed?.status !== 'parsed')
      throw new Error(`Expected parsed syntax for ${source.fileId}.`);
    return { source, syntax: parsed };
  });
  const memberA = members[0];
  const memberB = members[1];
  if (memberA === undefined || memberB === undefined)
    throw new Error('Expected two component members.');
  const imported = memberA.syntax.imports[0];
  if (imported === undefined) throw new Error('Expected A.sol to contain one import.');
  return {
    componentId: memberA.source.fileId,
    grammar: memberA.syntax.version.selectedVersion,
    members,
    lookups: [
      {
        importerFileId: memberA.source.fileId,
        importId: imported.id,
        specifier: imported.specifier,
        specifierRange: imported.specifierRange,
        targetFileId: memberB.source.fileId,
      },
    ],
    maxRecords: 100,
  };
}

function parserSource(root: string, path: string, text: string): ParserSource {
  const fileId = fileIdentity(path);
  const originalBytes = Buffer.from(text, 'utf8');
  const byteHash = createHash('sha256').update(originalBytes).digest('hex');
  const snapshot: SourceSnapshot = {
    canonicalPath: path,
    absolutePath: resolve(root, path),
    originalBytes,
    originalText: text,
    byteHash,
  };
  return {
    fileId,
    snapshot,
    manifestEntry: {
      fileId,
      path,
      role: 'scoped',
      ownership: 'first-party',
      ownershipEvidence: [],
      physicalIdentity: `fixture:${path}`,
      byteHash,
    },
  };
}

describe('adversarial semantic component ceilings', () => {
  it('accepts exact configured file/byte caps and rejects one-over before spawning a semantic child', async () => {
    const root = await createProject('audit-estimator-adversarial-semantic-');
    const sourceA = ['pragma solidity ^0.8.20;', 'import "./B.sol";', 'contract A is B {}'].join(
      '\n',
    );
    const sourceB = 'pragma solidity ^0.8.20; contract B {}\n';
    const totalBytes = Buffer.byteLength(sourceA, 'utf8') + Buffer.byteLength(sourceB, 'utf8');
    let exactSession: ReturnType<typeof createParserSessionForTests> | undefined;
    const exactLaunches: number[] = [];
    const exactChildren: ChildProcessWithoutNullStreams[] = [];
    try {
      await writeProjectFile(root, 'contracts/A.sol', sourceA);
      await writeProjectFile(root, 'contracts/B.sol', sourceB);
      const exactContext = await makeDiscoveryInput(
        root,
        '.',
        testLimits({ maxSemanticFiles: 2, maxSemanticBytes: totalBytes }),
      );
      exactSession = createParserSessionForTests(
        { budget: exactContext.budget, config: exactContext.config },
        realWorkerFactory(exactLaunches, exactChildren),
      );
      const sources = [
        parserSource(root, 'contracts/A.sol', sourceA),
        parserSource(root, 'contracts/B.sol', sourceB),
      ] as const;
      const syntax = await exactSession.analyzeSources(sources);
      const input = semanticInput(sources, syntax);
      expect(input.grammar).toBe('0.8.37');

      const exact = await exactSession.analyzeSemanticComponent(input);
      expect(exact).toMatchObject({ status: 'bound', grammar: '0.8.37' });
      expect(exactLaunches).toHaveLength(2);
      await exactSession.close();
      exactSession = undefined;
      await assertChildrenReaped(exactChildren);

      for (const limits of [
        testLimits({ maxSemanticFiles: 1, maxSemanticBytes: totalBytes }),
        testLimits({ maxSemanticFiles: 2, maxSemanticBytes: totalBytes - 1 }),
      ]) {
        const limitedContext = await makeDiscoveryInput(root, '.', limits);
        const launches: number[] = [];
        const children: ChildProcessWithoutNullStreams[] = [];
        const session = createParserSessionForTests(
          { budget: limitedContext.budget, config: limitedContext.config },
          realWorkerFactory(launches, children),
        );
        try {
          const limitedSyntax = await session.analyzeSources(sources);
          const limitedInput = semanticInput(sources, limitedSyntax);
          expect(launches).toHaveLength(1);
          await expect(session.analyzeSemanticComponent(limitedInput)).resolves.toMatchObject({
            status: 'unavailable',
            reason: 'limit',
            consumedNodes: 0,
          });
          expect(launches).toHaveLength(1);
        } finally {
          await session.close();
        }
        await assertChildrenReaped(children);
      }
    } finally {
      await exactSession?.close();
      await removeProject(root);
    }
  }, 60_000);
});

describe('adversarial application estimate handoff', () => {
  it('preserves unavailable storage and confirmed builtin facts while accepting internal dynamic calls', async () => {
    const root = await createProject('audit-estimator-adversarial-estimate-');
    // Parser/semantic uncertainty fixture; this source is not validated by a Solidity compiler.
    const source = [
      'pragma solidity ^0.8.20;',
      'struct Item { uint256 amount; }',
      'contract Mixed {',
      '    Item private item;',
      '    function review(uint256 value) external {',
      '        this.call("");',
      '        _internal(value);',
      '    }',
      '    function _internal(uint256 value) internal pure {',
      '        if (value > 0) { }',
      '    }',
      '}',
    ].join('\n');
    try {
      await writeProjectFile(root, 'src/Mixed.sol', source);
      const result = await analyzeProject({
        command: 'estimate',
        input: root,
        noConfig: true,
        allowPartial: false,
      });
      const analysis = result.envelope.analysis;
      expect(result.outcome).toBe('complete');
      expect(result.envelope.status).toBe('complete');
      expect(analysis?.completeness).toMatchObject({
        requiredAnalysisComplete: true,
        unavailableFileIds: [],
      });
      expect(analysis?.completeness.hasUnknownSemantics).toBe(true);

      const file = analysis?.files.find((item) => item.fileId === 'file:src/Mixed.sol');
      expect(file?.stateVariables.typeShapes).toMatchObject({
        status: 'measured',
        value: [expect.objectContaining({ shape: 'user-defined', mutable: true })],
      });
      const internalCallable = analysis?.callables.find((item) => item.name === '_internal');
      const reviewCallable = analysis?.callables.find((item) => item.name === 'review');
      expect(internalCallable).toBeDefined();
      if (internalCallable === undefined) throw new Error('Missing _internal callable.');
      expect(reviewCallable).toBeDefined();
      if (reviewCallable === undefined) throw new Error('Missing review callable.');
      expect(analysis?.graphs).toContainEqual(
        expect.objectContaining({
          kind: 'call',
          from: reviewCallable.id,
          resolution: 'unsupported',
          candidateTargets: [internalCallable.id],
        }),
      );
      expect(analysis?.graphs).toContainEqual(
        expect.objectContaining({ kind: 'call', resolution: 'unsupported' }),
      );
      expect(result.envelope.estimate?.coverage).toBe('full');
      expect(result.envelope.fullScopeEstimate).toEqual(result.envelope.estimate);
      expect(result.envelope.estimate?.contributions).toContainEqual(
        expect.objectContaining({ category: 'storage', inputStatus: 'unavailable' }),
      );
      expect(result.envelope.estimate?.contributions).toContainEqual(
        expect.objectContaining({ category: 'evm', inputStatus: 'unavailable' }),
      );
      const reserve = result.envelope.estimate?.contributions.find(
        (item) => item.category === 'reserve',
      );
      expect(reserve?.highMicrohours).toBeGreaterThan(0);
    } finally {
      await removeProject(root);
    }
  }, 60_000);
});
