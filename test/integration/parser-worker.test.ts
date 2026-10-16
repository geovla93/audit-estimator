import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/load.ts';
import { DEFAULT_ANALYSIS_LIMITS, DEFAULT_SCOPE_SETTINGS } from '../../src/config/defaults.ts';
import { fileIdentity } from '../../src/domain/canonical.ts';
import type {
  AnalysisLimits,
  FileScopeEntry,
  ModelProfile,
  ResolvedConfig,
  SourceSnapshot,
} from '../../src/domain/types.ts';
import { createDiscoveryBudget, BudgetError } from '../../src/discovery/budget.ts';
import { createParserSession, createParserSessionForTests } from '../../src/parser/adapter.ts';
import type { SemanticComponentInput, SemanticComponentMember } from '../../src/parser/adapter.ts';
import {
  encodeFrame,
  maxRequestFrameBytes,
  PARSER_PROTOCOL_VERSION,
} from '../../src/parser/protocol.ts';
import type {
  ParseFileResult,
  ParserSource,
  ParserWorkerRequest,
  SemanticBaseSite,
} from '../../src/parser/protocol.ts';
import { testLimits } from '../helpers/filesystem.ts';

const repositoryRoot = resolve(new URL('../../', import.meta.url).pathname);
const helperPath = resolve(repositoryRoot, '.vitest/parser/parser-child.mjs');
const parserFixtures = new URL('../fixtures/parser/', import.meta.url);

interface TestContext {
  readonly root: string;
  readonly config: ResolvedConfig;
  readonly budget: ReturnType<typeof createDiscoveryBudget>;
  readonly remove: () => Promise<void>;
}

function trustedDefaults(limits: AnalysisLimits) {
  const model: ModelProfile = {
    profile: 'heuristic-v1',
    modelVersion: '1.0.0',
    parameters: {
      projectHours: { low: 0.5, high: 1 },
      slocHours: { low: 0.001, high: 0.002 },
      controlPremium: { low: 0.1, high: 0.2 },
      storagePremium: { low: 0.1, high: 0.2 },
      evmPremium: { low: 0.1, high: 0.2 },
      interactionHours: { low: 0.25, high: 0.5 },
      boundaryHours: { low: 0.25, high: 0.5 },
      unknownReserveHigh: 0.5,
      hoursPerDay: 8,
    },
  };
  return {
    scope: { ...DEFAULT_SCOPE_SETTINGS },
    imports: { remappings: [] },
    solidity: { version: '0.8.28' },
    analysis: { limits },
    model,
    manualAdjustments: [],
    coverage: { lcovPath: null },
  };
}

async function makeContext(
  options: {
    readonly limits?: AnalysisLimits;
    readonly metadata?: { readonly solidity?: { readonly version: string } };
    readonly cliVersion?: string;
    readonly signal?: AbortSignal;
    readonly deadlineAt?: number;
  } = {},
): Promise<TestContext> {
  const root = await mkdtemp(join(tmpdir(), 'audit-estimator-parser-'));
  const limits = options.limits ?? testLimits();
  const resolved = await resolveConfig({
    root,
    noConfig: true,
    defaults: trustedDefaults(limits),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    ...(options.cliVersion === undefined ? {} : { cli: { solidityVersion: options.cliVersion } }),
  });
  const budget = createDiscoveryBudget(
    resolved.config.analysis.limits,
    options.signal,
    options.deadlineAt,
  );
  return {
    root,
    config: resolved.config,
    budget,
    remove: async () => await rm(root, { recursive: true, force: true }),
  };
}

function parserSource(root: string, canonicalPath: string, source: string): ParserSource {
  const fileId = fileIdentity(canonicalPath);
  const originalBytes = Buffer.from(source, 'utf8');
  const byteHash = createHash('sha256').update(originalBytes).digest('hex');
  const snapshot: SourceSnapshot = {
    canonicalPath,
    absolutePath: resolve(root, canonicalPath),
    originalBytes,
    originalText: source,
    byteHash,
  };
  const manifestEntry: FileScopeEntry = {
    fileId,
    path: canonicalPath,
    role: 'scoped',
    ownership: 'first-party',
    ownershipEvidence: [],
    physicalIdentity: `fixture:${canonicalPath}`,
    byteHash,
  };
  return { fileId, snapshot, manifestEntry };
}

async function fixture(name: string): Promise<string> {
  return await readFile(new URL(name, parserFixtures), 'utf8');
}

function requireParsed(
  result: ParseFileResult | undefined,
): Extract<ParseFileResult, { status: 'parsed' }> {
  if (result?.status !== 'parsed') throw new Error('Expected a parsed parser result.');
  return result;
}

function requireFailed(
  result: ParseFileResult | undefined,
): Extract<ParseFileResult, { status: 'failed' }> {
  if (result?.status !== 'failed') throw new Error('Expected a failed parser result.');
  return result;
}

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a value.');
  return value;
}

function processExists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code !== 'ESRCH';
  }
}

function fakeWorker(
  context: TestContext,
  mode: string,
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void,
) {
  return createParserSessionForTests({ budget: context.budget, config: context.config }, () => {
    const child = spawn(process.execPath, [helperPath, 'fake-worker', mode], {
      cwd: context.root,
      env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    onSpawn?.(child);
    return child;
  });
}

function coalesceDuplicateReplyFrames(child: ChildProcessWithoutNullStreams): {
  readonly framesSeen: () => number;
  readonly coalescedWrites: () => number;
  readonly failure: () => Error | undefined;
  readonly close: () => void;
} {
  const originalStdout = child.stdout;
  const controlledStdout = new PassThrough();
  child.stdout = controlledStdout;
  const maxFrameBytes = 1024 * 1024;
  const maxBufferedBytes = 2 * maxFrameBytes;
  const maxFrames = 3;
  let pending = Buffer.alloc(0);
  let framesSeen = 0;
  let coalescedWrites = 0;
  let replies: Buffer[] = [];
  let failure: Error | undefined;
  originalStdout.on('data', (chunk: Buffer) => {
    if (failure !== undefined) return;
    pending = Buffer.concat([pending, chunk]);
    if (pending.byteLength > maxBufferedBytes) {
      failure = new Error('duplicate-frame observer exceeded its bounded buffer');
      controlledStdout.destroy(failure);
      return;
    }
    while (pending.byteLength >= 4) {
      const payloadBytes = pending.readUInt32BE(0);
      if (payloadBytes > maxFrameBytes) {
        failure = new Error('duplicate-frame observer received an oversized frame');
        controlledStdout.destroy(failure);
        return;
      }
      const frameBytes = payloadBytes + 4;
      if (pending.byteLength < frameBytes) break;
      const frame = pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
      framesSeen += 1;
      if (framesSeen > maxFrames) {
        failure = new Error('duplicate-frame observer received an unexpected extra frame');
        controlledStdout.destroy(failure);
        return;
      }
      if (framesSeen === 1) {
        controlledStdout.write(frame);
      } else {
        replies.push(frame);
        if (replies.length === 2) {
          coalescedWrites += 1;
          controlledStdout.write(Buffer.concat(replies));
          replies = [];
        }
      }
    }
  });
  originalStdout.on('error', (error: Error) => controlledStdout.destroy(error));
  originalStdout.on('end', () => controlledStdout.end());
  return {
    framesSeen: () => framesSeen,
    coalescedWrites: () => coalescedWrites,
    failure: () => failure,
    close: () => controlledStdout.destroy(),
  };
}

async function waitForClose(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
}

function waitForStage(child: ChildProcessWithoutNullStreams, stage: string): Promise<void> {
  return new Promise<void>((resolveStage, rejectStage) => {
    let buffered = '';
    const cleanup = () => {
      clearTimeout(timeout);
      child.stderr.off('data', onData);
      child.off('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      if (buffered.includes(`stage:${stage}\n`)) {
        cleanup();
        resolveStage();
      }
    };
    const onClose = () => {
      cleanup();
      rejectStage(new Error(`Child closed before stage ${stage}.`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      rejectStage(new Error(`Timed out waiting for child stage ${stage}.`));
    }, 2_000);
    child.stderr.on('data', onData);
    child.once('close', onClose);
  });
}

function stageBarrier(stage: string): {
  readonly reached: Promise<void>;
  readonly attach: (child: ChildProcessWithoutNullStreams) => void;
} {
  let resolveReached: () => void = () => undefined;
  let rejectReached: (error: Error) => void = () => undefined;
  const reached = new Promise<void>((resolve, reject) => {
    resolveReached = resolve;
    rejectReached = reject;
  });
  return {
    reached,
    attach: (child) => {
      void waitForStage(child, stage).then(resolveReached, rejectReached);
    },
  };
}

describe('isolated parser worker', () => {
  beforeAll(() => {
    execFileSync(
      'pnpm',
      [
        'exec',
        'tsdown',
        'test/helpers/parser-child.ts',
        '--out-dir',
        '.vitest/parser',
        '--no-config',
        '--format',
        'esm',
        '--deps.never-bundle',
        '@nomicfoundation/slang',
      ],
      { cwd: repositoryRoot, stdio: 'pipe' },
    );
  });

  it('parses one file and maps declaration bodies, attributes, and UTF-8 ranges', async () => {
    const context = await makeContext();
    const source = await fixture('contract-body.sol');
    const input = parserSource(context.root, 'contracts/Body.sol', source);
    const session = createParserSession({ budget: context.budget, config: context.config });
    try {
      const batch = await session.analyzeSources([input]);
      expect(batch.complete).toBe(true);
      expect(batch.files).toHaveLength(1);
      const result = batch.files[0];
      expect(result?.status).toBe('parsed');
      if (result?.status !== 'parsed') throw new Error('Expected a parsed fixture.');
      expect(result.version.selectionSource).toBe('inferred');
      expect(result.version.selectedVersion).toBe('0.8.37');
      const contract = result.declarations.find((declaration) => declaration.kind === 'contract');
      const callable = result.declarations.find((declaration) => declaration.kind === 'function');
      expect(contract).toBeDefined();
      expect(callable).toBeDefined();
      const contractOpen = source.indexOf('{', source.indexOf('contract A'));
      const contractClose = source.lastIndexOf('}') + 1;
      expect(contract?.hasBody).toBe(true);
      expect(contract?.bodyRange).toEqual({
        startByte: Buffer.byteLength(source.slice(0, contractOpen), 'utf8'),
        endByte: Buffer.byteLength(source.slice(0, contractClose), 'utf8'),
        start: { line: 1, column: contractOpen + 1 },
        end: { line: 1, column: contractClose + 1 },
      });
      expect(callable?.attributes).toContainEqual({ key: 'visibility', value: 'public' });
      expect(callable?.attributes).toContainEqual({ key: 'mutability', value: 'pure' });
      expect(callable?.hasBody).toBe(true);
      expect(
        result.events.some(
          (event) => event.kind === 'declaration' && event.contractId === contract?.id,
        ),
      ).toBe(true);
      expect(result.diagnostics).toEqual([]);
    } finally {
      await session.close();
      await context.remove();
    }
  });

  it('preserves explicitly declared abstract, visibility, and mutability attributes only', async () => {
    const context = await makeContext();
    const source =
      'pragma solidity ^0.8.0; abstract contract AbstractA { function f() external view; }';
    const session = createParserSession({ budget: context.budget, config: context.config });
    try {
      const batch = await session.analyzeSources([
        parserSource(context.root, 'contracts/Abstract.sol', source),
      ]);
      const result = batch.files[0];
      expect(result?.status).toBe('parsed');
      if (result?.status !== 'parsed') throw new Error('Expected abstract fixture to parse.');
      const contract = result.declarations.find(
        (declaration) => declaration.kind === 'abstract-contract',
      );
      const callable = result.declarations.find((declaration) => declaration.kind === 'function');
      expect(contract?.attributes).toContainEqual({ key: 'abstract', value: true });
      expect(callable?.attributes).toContainEqual({ key: 'visibility', value: 'external' });
      expect(callable?.attributes).toContainEqual({ key: 'mutability', value: 'view' });
      expect(callable?.hasBody).toBe(false);
      expect(callable?.bodyRange).toBeNull();
      expect(callable?.attributes).not.toContainEqual({ key: 'abstract', value: true });
    } finally {
      await session.close();
      await context.remove();
    }
  });

  it('limits declaration attributes and body ranges to the declaration header and block', async () => {
    const context = await makeContext();
    const source = [
      'pragma solidity ^0.8.0;',
      'contract C {',
      '  uint public value;',
      '  function f(function() external view returns (uint) cb) internal pure returns (uint) {',
      '    address payable receiver;',
      '    if (true) { for (uint i; i < 1; i++) {} }',
      '    return 1;',
      '  }',
      '}',
    ].join('\n');
    const session = createParserSession({ budget: context.budget, config: context.config });
    try {
      const batch = await session.analyzeSources([
        parserSource(context.root, 'contracts/AttributeBoundaries.sol', source),
      ]);
      const parsed = requireParsed(batch.files[0]);
      const contract = requireValue(
        parsed.declarations.find((declaration) => declaration.kind === 'contract'),
      );
      const callable = requireValue(
        parsed.declarations.find((declaration) => declaration.kind === 'function'),
      );
      expect(contract.attributes).not.toContainEqual({ key: 'visibility', value: 'public' });
      expect(callable.attributes).toContainEqual({ key: 'visibility', value: 'internal' });
      expect(callable.attributes).toContainEqual({ key: 'mutability', value: 'pure' });
      expect(callable.attributes).not.toContainEqual({ key: 'visibility', value: 'external' });
      expect(callable.attributes).not.toContainEqual({ key: 'mutability', value: 'view' });
      const functionOpen = source.indexOf('{', source.indexOf('function f'));
      const functionClose = source.indexOf('\n  }\n}', functionOpen) + 4;
      expect(callable.hasBody).toBe(true);
      expect(callable.bodyRange?.startByte).toBe(
        Buffer.byteLength(source.slice(0, functionOpen), 'utf8'),
      );
      expect(callable.bodyRange?.endByte).toBe(
        Buffer.byteLength(source.slice(0, functionClose), 'utf8'),
      );
    } finally {
      await session.close();
      await context.remove();
    }

    const interfaceContext = await makeContext();
    const interfaceSession = createParserSession({
      budget: interfaceContext.budget,
      config: interfaceContext.config,
    });
    try {
      const batch = await interfaceSession.analyzeSources([
        parserSource(
          interfaceContext.root,
          'contracts/Bodyless.sol',
          'pragma solidity ^0.8.0; interface I { function f() external view; }',
        ),
      ]);
      const parsed = requireParsed(batch.files[0]);
      const interfaceDeclaration = requireValue(
        parsed.declarations.find((declaration) => declaration.kind === 'interface'),
      );
      const bodyless = requireValue(
        parsed.declarations.find((declaration) => declaration.kind === 'function'),
      );
      expect(interfaceDeclaration.hasBody).toBe(true);
      expect(interfaceDeclaration.bodyRange).not.toBeNull();
      expect(bodyless.hasBody).toBe(false);
      expect(bodyless.bodyRange).toBeNull();
    } finally {
      await interfaceSession.close();
      await interfaceContext.remove();
    }
  });

  it('captures explicit attributes and body braces for every callable declaration kind', async () => {
    const context = await makeContext();
    const source = [
      'pragma solidity ^0.8.0;',
      'contract CallableKinds {',
      '  uint public value;',
      '  constructor() payable { address payable receiver; }',
      '  modifier guarded() { _; }',
      '  fallback() external payable {}',
      '  receive() external payable {}',
      '  function f() internal pure { }',
      '}',
    ].join('\n');
    const session = createParserSession({ budget: context.budget, config: context.config });
    try {
      const batch = await session.analyzeSources([
        parserSource(context.root, 'contracts/CallableKinds.sol', source),
      ]);
      const parsed = requireParsed(batch.files[0]);
      const callables = new Map(
        parsed.declarations
          .filter((declaration) => declaration.callableId !== null)
          .map((declaration) => [declaration.kind, declaration] as const),
      );
      const expected = [
        ['constructor', [{ key: 'mutability', value: 'payable' }]],
        ['modifier', []],
        [
          'fallback',
          [
            { key: 'visibility', value: 'external' },
            { key: 'mutability', value: 'payable' },
          ],
        ],
        [
          'receive',
          [
            { key: 'visibility', value: 'external' },
            { key: 'mutability', value: 'payable' },
          ],
        ],
        [
          'function',
          [
            { key: 'visibility', value: 'internal' },
            { key: 'mutability', value: 'pure' },
          ],
        ],
      ] as const;
      for (const [kind, attributes] of expected) {
        const declaration = requireValue(callables.get(kind));
        expect(declaration.hasBody).toBe(true);
        expect(declaration.bodyRange).not.toBeNull();
        expect(
          declaration.attributes.filter(
            (attribute) => attribute.key === 'visibility' || attribute.key === 'mutability',
          ),
        ).toEqual(attributes);
      }
      const constructor = requireValue(callables.get('constructor'));
      const constructorOpen = source.indexOf('{', source.indexOf('constructor'));
      const constructorClose = source.indexOf('}', constructorOpen) + 1;
      expect(constructor.bodyRange?.startByte).toBe(
        Buffer.byteLength(source.slice(0, constructorOpen), 'utf8'),
      );
      expect(constructor.bodyRange?.endByte).toBe(
        Buffer.byteLength(source.slice(0, constructorClose), 'utf8'),
      );
    } finally {
      await session.close();
      await context.remove();
    }
  });

  it('runs real extraction across each supported grammar fixture', async () => {
    const versions = ['0.4.11', '0.5.17', '0.6.12', '0.7.6', '0.8.4', '0.8.28', '0.8.37'];
    const context = await makeContext({
      limits: testLimits({ maxAstNodesPerFile: 500_000, maxAstNodesTotal: 4_000_000 }),
    });
    const session = createParserSession({ budget: context.budget, config: context.config });
    try {
      const inputs = await Promise.all(
        versions.map(async (version) =>
          parserSource(
            context.root,
            `contracts/Solidity-${version}.sol`,
            await fixture(`solidity-${version}.sol`),
          ),
        ),
      );
      const batch = await session.analyzeSources(inputs);
      const byPath = new Map(batch.files.map((result) => [result.fileId, result] as const));
      for (const [index, version] of versions.entries()) {
        const input = requireValue(inputs[index]);
        const parsed = requireParsed(byPath.get(input.fileId));
        expect(parsed.version.selectedVersion).toBe(version);
        expect(parsed.declarations.length).toBeGreaterThan(0);
      }
    } finally {
      await session.close();
      await context.remove();
    }
  });

  it('distinguishes absent, broad, multiple, malformed, and legacy version evidence', async () => {
    const context = await makeContext();
    const sources = [
      parserSource(context.root, 'contracts/NoPragma.sol', await fixture('no-pragma.sol')),
      parserSource(context.root, 'contracts/Broad.sol', await fixture('pragma-broad.sol')),
      parserSource(context.root, 'contracts/Multiple.sol', await fixture('pragma-multiple.sol')),
      parserSource(context.root, 'contracts/Malformed.sol', await fixture('pragma-malformed.sol')),
      parserSource(context.root, 'contracts/Legacy.sol', await fixture('solidity-0.4.11.sol')),
    ];
    const session = createParserSession({ budget: context.budget, config: context.config });
    try {
      const batch = await session.analyzeSources(sources);
      expect(batch.files.map((result) => result.fileId)).toEqual(
        sources.map((source) => source.fileId).sort(),
      );
      const byName = new Map(batch.files.map((result) => [String(result.fileId), result]));
      const absent = byName.get('file:contracts/NoPragma.sol');
      const broad = byName.get('file:contracts/Broad.sol');
      const multiple = byName.get('file:contracts/Multiple.sol');
      const malformed = byName.get('file:contracts/Malformed.sol');
      const legacy = byName.get('file:contracts/Legacy.sol');
      const parsedAbsent = requireParsed(absent);
      const parsedBroad = requireParsed(broad);
      const parsedMultiple = requireParsed(multiple);
      const failedMalformed = requireFailed(malformed);
      const parsedLegacy = requireParsed(legacy);
      expect(parsedAbsent.version.selectionSource).toBe('latest-no-pragma');
      expect(parsedAbsent.diagnostics.map((item) => item.message)).toContain(
        'No Solidity version pragma is present; grammar selection used configured evidence.',
      );
      expect(parsedBroad.version.pragmaRanges).toHaveLength(1);
      expect(parsedBroad.version.compatibleVersions).toHaveLength(
        parsedBroad.version.installedVersions.length,
      );
      expect(parsedBroad.version.selectionSource).toBe('inferred');
      expect(parsedBroad.diagnostics).toEqual([]);
      expect(parsedMultiple.version.pragmaRanges).toHaveLength(2);
      expect(failedMalformed.code).toBe('PARSE_INVALID');
      expect(failedMalformed).not.toHaveProperty('declarations');
      expect(parsedLegacy.version.selectedVersion).toBe('0.4.11');
      expect(parsedLegacy.declarations.some((declaration) => declaration.kind === 'fallback')).toBe(
        true,
      );
    } finally {
      await session.close();
      await context.remove();
    }
  });

  it('warns about absent constraints when explicit CLI or metadata versions are selected', async () => {
    const sourceName = 'contracts/NoPragmaAuthority.sol';
    for (const context of [
      await makeContext({ cliVersion: '0.8.37' }),
      await makeContext({ metadata: { solidity: { version: '0.8.36' } } }),
    ]) {
      const session = createParserSession({ budget: context.budget, config: context.config });
      try {
        const batch = await session.analyzeSources([
          parserSource(context.root, sourceName, await fixture('no-pragma.sol')),
        ]);
        const result = batch.files[0];
        const parsed = requireParsed(result);
        expect(parsed.version.selectedVersion).toBe(context.config.solidity.version);
        expect(parsed.version.selectionSource).toBe(
          context.config.provenance.find((item) => item.field === 'solidity.version')?.source,
        );
        expect(parsed.diagnostics.map((item) => item.message)).toContain(
          'No Solidity version pragma is present; grammar selection used configured evidence.',
        );
      } finally {
        await session.close();
        await context.remove();
      }
    }
  });

  it('retains BOM bytes and reports one-based scalar positions without losing legacy syntax', async () => {
    const context = await makeContext();
    const source = await fixture('bom-crlf-unicode.sol');
    const input = parserSource(context.root, 'contracts/Bom.sol', source);
    const malformedSource = '\uFEFFcontract';
    const session = createParserSession({ budget: context.budget, config: context.config });
    try {
      const batch = await session.analyzeSources([
        input,
        parserSource(context.root, 'contracts/BadBom.sol', malformedSource),
        parserSource(context.root, 'contracts/Empty.sol', ''),
        parserSource(context.root, 'contracts/BomOnly.sol', '\uFEFF'),
      ]);
      const bom = batch.files.find((result) => result.fileId === input.fileId);
      const parsedBom = requireParsed(bom);
      const name = source.indexOf('BomUnicode');
      const token = parsedBom.tokens.find(
        (item) => item.range.startByte === Buffer.byteLength(source.slice(0, name), 'utf8'),
      );
      expect(token?.range.start).toEqual({ line: 3, column: 10 });
      const bad = batch.files.find((result) => result.fileId === 'file:contracts/BadBom.sol');
      const failedBadBom = requireFailed(bad);
      expect(failedBadBom.diagnostics[0]?.range).toEqual({
        startByte: 11,
        endByte: 11,
        start: { line: 1, column: 10 },
        end: { line: 1, column: 10 },
      });
      expect(
        batch.files.find((result) => result.fileId === 'file:contracts/Empty.sol')?.status,
      ).toBe('parsed');
      expect(
        batch.files.find((result) => result.fileId === 'file:contracts/BomOnly.sol')?.status,
      ).toBe('parsed');
    } finally {
      await session.close();
      await context.remove();
    }
  });

  it('preserves import aliases from CST nodes and enforces per-file limits independently', async () => {
    const context = await makeContext({ limits: testLimits({ maxAstNodesPerFile: 5_000 }) });
    const source = await fixture('import-aliases.sol');
    const input = parserSource(context.root, 'contracts/Imports.sol', source);
    const session = createParserSession({ budget: context.budget, config: context.config });
    try {
      const batch = await session.analyzeSources([input]);
      const parsed = requireParsed(batch.files[0]);
      expect(parsed.imports.map((item) => item.aliasForm)).toEqual(['bare', 'namespace', 'named']);
    } finally {
      await session.close();
      await context.remove();
    }

    const limitedContext = await makeContext({ limits: testLimits({ maxAstNodesPerFile: 64 }) });
    const limitedSession = createParserSession({
      budget: limitedContext.budget,
      config: limitedContext.config,
    });
    try {
      const limited = await limitedSession.analyzeSources([
        parserSource(
          limitedContext.root,
          'contracts/First.sol',
          `contract First { ${Array.from(
            { length: 8 },
            (_, index) => `function f${index}() public pure returns (uint) { return ${index}; }`,
          ).join(' ')} }`,
        ),
        parserSource(limitedContext.root, 'contracts/Second.sol', 'contract Second {}'),
      ]);
      expect(limited.files).toHaveLength(2);
      expect(
        limited.files.find((result) => result.fileId === 'file:contracts/First.sol'),
      ).toMatchObject({
        status: 'failed',
        code: 'LIMIT_EXCEEDED',
      });
      expect(
        limited.files.find((result) => result.fileId === 'file:contracts/Second.sol'),
      ).toMatchObject({ status: 'parsed' });
    } finally {
      await limitedSession.close();
      await limitedContext.remove();
    }
  });

  it('decodes Solidity import escapes as bytes and fails closed on invalid UTF-8', async () => {
    const context = await makeContext();
    const source = [
      'pragma solidity ^0.8.0;',
      'import "\\x66oo.sol";',
      'import "\\xe2\\x82\\xac.sol";',
      'import "\\u20ac.sol";',
      'import "line\\',
      'continued.sol";',
      'contract ImportEscapes {}',
    ].join('\n');
    const invalidSource = 'pragma solidity ^0.8.0; import "\\xff.sol"; contract InvalidPath {}';
    const session = createParserSession({ budget: context.budget, config: context.config });
    try {
      const batch = await session.analyzeSources([
        parserSource(context.root, 'contracts/ImportEscapes.sol', source),
        parserSource(context.root, 'contracts/InvalidImportUtf8.sol', invalidSource),
      ]);
      const parsed = requireParsed(
        batch.files.find((result) => result.fileId === 'file:contracts/ImportEscapes.sol'),
      );
      expect(parsed.imports.map((item) => item.specifier)).toEqual([
        'foo.sol',
        '€.sol',
        '€.sol',
        'linecontinued.sol',
      ]);
      const invalid = requireFailed(
        batch.files.find((result) => result.fileId === 'file:contracts/InvalidImportUtf8.sol'),
      );
      expect(invalid.code).toBe('INTERNAL_ERROR');
      expect(invalid.diagnostics.map((item) => item.message)).toEqual([
        'The parser could not represent an import path as UTF-8.',
      ]);
      expect(invalid).not.toHaveProperty('imports');
    } finally {
      await session.close();
      await context.remove();
    }
  });

  it('loads the native adapter from another cwd and excludes hostile loader variables', async () => {
    const context = await makeContext();
    const source = 'pragma solidity ^0.8.0; import "./target-marker.mjs"; contract Bridge {}';
    const markerPath = join(context.root, 'loader-marker');
    const markerModule = join(context.root, 'loader-marker.mjs');
    const targetMarkerPath = join(context.root, 'target-marker');
    const targetMarkerModule = join(context.root, 'target-marker.mjs');
    await writeFile(
      markerModule,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'loaded');`,
    );
    await writeFile(
      targetMarkerModule,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(targetMarkerPath)}, 'loaded');`,
    );

    const bridge = spawn(process.execPath, [helperPath, 'bridge'], {
      cwd: context.root,
      env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const outputChunks: Buffer[] = [];
    bridge.stdout.on('data', (chunk: Buffer) => outputChunks.push(chunk));
    bridge.stdin.end(
      `${JSON.stringify({
        source,
        loaderUrl: pathToFileURL(markerModule).href,
        loaderPath: context.root,
      })}\n`,
    );
    try {
      await waitForClose(bridge);
      expect(bridge.exitCode).toBe(0);
      const batch: unknown = JSON.parse(Buffer.concat(outputChunks).toString('utf8')) as unknown;
      expect(batch).toMatchObject({ complete: true, files: [{ status: 'parsed' }] });
      await expect(access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(targetMarkerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it('binds a component from another cwd without inheriting hostile loader variables', async () => {
    const context = await makeContext();
    const markerPath = join(context.root, 'loader-marker');
    const markerModule = join(context.root, 'loader-marker.mjs');
    await writeFile(
      markerModule,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'loaded');`,
    );
    const bridge = spawn(process.execPath, [helperPath, 'bridge'], {
      cwd: context.root,
      env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const outputChunks: Buffer[] = [];
    bridge.stdout.on('data', (chunk: Buffer) => outputChunks.push(chunk));
    bridge.stdin.end(
      `${JSON.stringify({
        source:
          'pragma solidity 0.8.37;\nimport "./NativeDependency.sol";\ncontract Root is Dep {}\n',
        dependency: 'pragma solidity 0.8.37;\ncontract Dep {}\n',
        loaderUrl: pathToFileURL(markerModule).href,
        loaderPath: context.root,
      })}\n`,
    );
    try {
      await waitForClose(bridge);
      expect(bridge.exitCode).toBe(0);
      const output: unknown = JSON.parse(Buffer.concat(outputChunks).toString('utf8')) as unknown;
      expect(output).toMatchObject({
        batch: { complete: true },
        semantic: {
          status: 'bound',
          grammar: '0.8.37',
          baseSites: [
            { ordinal: 0, definitions: [{ kind: 'user', definiens: 'ContractDefinition' }] },
          ],
          callSites: [],
        },
      });
      await expect(access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it('has the isolated worker reject source hash mismatches and unpaired surrogates', async () => {
    const packageEntry = new URL(import.meta.resolve('audit-estimator'));
    const workerPath = fileURLToPath(new URL('./parser/worker.js', packageEntry));
    const packageRoot = dirname(dirname(dirname(workerPath)));
    const maxFileBytes = DEFAULT_ANALYSIS_LIMITS.maxFileBytes;
    const cases = [
      {
        source: 'contract HashMismatch {}',
        byteHash: '0'.repeat(64),
      },
      {
        source: '\ud800',
        byteHash: createHash('sha256').update(Buffer.from('\ud800', 'utf8')).digest('hex'),
      },
    ];
    for (const [index, item] of cases.entries()) {
      const canonicalPath = `contracts/Raw${index}.sol`;
      const request: ParserWorkerRequest = {
        protocolVersion: PARSER_PROTOCOL_VERSION,
        requestId: 1,
        kind: 'parse-file',
        fileId: fileIdentity(canonicalPath),
        canonicalPath,
        originalText: item.source,
        byteHash: item.byteHash,
        maxFileBytes,
        maxAstNodesPerFile: DEFAULT_ANALYSIS_LIMITS.maxAstNodesPerFile,
        maxAstNodesRemaining: DEFAULT_ANALYSIS_LIMITS.maxAstNodesPerFile,
        maxImportsRemaining: DEFAULT_ANALYSIS_LIMITS.maxImports,
        versionAuthority: 'default',
        version: '0.8.28',
      };
      const child = spawn(process.execPath, [workerPath], {
        cwd: packageRoot,
        env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const outputChunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => outputChunks.push(chunk));
      child.stdin.end(encodeFrame(request, maxRequestFrameBytes(maxFileBytes)));
      await waitForClose(child);
      expect(child.exitCode).not.toBe(0);
      expect(Buffer.concat(outputChunks).byteLength).toBeGreaterThan(0);
    }
  });

  it('isolation and deadlines: kills and reaps stalled children on timeout, cancellation, and close', async () => {
    const timeoutContext = await makeContext({ limits: testLimits({ parseTimeoutMs: 100 }) });
    let timedChild: ChildProcessWithoutNullStreams | undefined;
    const timedSession = fakeWorker(timeoutContext, 'stall-ready', (started) => {
      timedChild = started;
    });
    try {
      const cutoffStartedAt = performance.now();
      const pending = timedSession.analyzeSources([
        parserSource(timeoutContext.root, 'contracts/Timed.sol', 'contract Timed {}'),
      ]);
      const timed = await pending;
      expect(performance.now() - cutoffStartedAt).toBeLessThan(5_000);
      expect(timed.files[0]).toMatchObject({ status: 'failed', code: 'LIMIT_EXCEEDED' });
      expect(timed.visitedNodes).toBe(timeoutContext.config.analysis.limits.maxAstNodesPerFile);
      const timedProcess = requireValue(timedChild);
      await waitForClose(timedProcess);
      expect(['SIGTERM', 'SIGKILL']).toContain(timedProcess.signalCode);
      expect(processExists(timedProcess.pid)).toBe(false);
    } finally {
      await timedSession.close();
      await timeoutContext.remove();
    }

    for (const stage of ['inference', 'traversal']) {
      const stageContext = await makeContext({ limits: testLimits({ parseTimeoutMs: 250 }) });
      let stageChild: ChildProcessWithoutNullStreams | undefined;
      const stageWait = stageBarrier(stage);
      const stageSession = fakeWorker(stageContext, `stall-${stage}`, (started) => {
        stageChild = started;
        stageWait.attach(started);
      });
      try {
        const pending = stageSession.analyzeSources([
          parserSource(stageContext.root, `contracts/${stage}.sol`, 'contract Stage {}'),
        ]);
        await stageWait.reached;
        const batch = await pending;
        expect(batch.files[0]).toMatchObject({ status: 'failed', code: 'LIMIT_EXCEEDED' });
        const stageProcess = requireValue(stageChild);
        await waitForClose(stageProcess);
        expect(processExists(stageProcess.pid)).toBe(false);
      } finally {
        await stageSession.close();
        await stageContext.remove();
      }
    }

    const abortController = new AbortController();
    const context = await makeContext({
      limits: testLimits({ parseTimeoutMs: 2_000 }),
      signal: abortController.signal,
    });
    let child: ChildProcessWithoutNullStreams | undefined;
    const requestStage = stageBarrier('request');
    const session = fakeWorker(context, 'stall-request', (started) => {
      child = started;
      requestStage.attach(started);
    });
    const input = parserSource(context.root, 'contracts/Stalled.sol', 'contract Stalled {}');
    try {
      const pending = session.analyzeSources([input]);
      await requestStage.reached;
      await expect(session.analyzeSources([input])).rejects.toThrow('active analysis batch');
      abortController.abort();
      await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
      const cancelledProcess = requireValue(child);
      await waitForClose(cancelledProcess);
      expect(cancelledProcess.exitCode !== null || cancelledProcess.signalCode !== null).toBe(true);
      expect(processExists(cancelledProcess.pid)).toBe(false);
    } finally {
      await session.close();
      await context.remove();
    }

    const closeContext = await makeContext({ limits: testLimits({ parseTimeoutMs: 2_000 }) });
    let closeChild: ChildProcessWithoutNullStreams | undefined;
    const closeStage = stageBarrier('request');
    const closeSession = fakeWorker(closeContext, 'stall-request', (started) => {
      closeChild = started;
      closeStage.attach(started);
    });
    try {
      const pending = closeSession.analyzeSources([
        parserSource(closeContext.root, 'contracts/Closed.sol', 'contract Closed {}'),
      ]);
      await closeStage.reached;
      const closing = closeSession.close();
      await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
      await closing;
      const closedProcess = requireValue(closeChild);
      await waitForClose(closedProcess);
      expect(processExists(closedProcess.pid)).toBe(false);
    } finally {
      await closeSession.close();
      await closeContext.remove();
    }
  });

  it('checks cancellation before returning cached results in later batches', async () => {
    const controller = new AbortController();
    const context = await makeContext({ signal: controller.signal });
    let spawnCount = 0;
    const session = createParserSessionForTests(
      { budget: context.budget, config: context.config },
      () => {
        spawnCount += 1;
        const child = spawn(process.execPath, [helperPath, 'fake-worker', 'valid-failure'], {
          cwd: context.root,
          env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return child;
      },
    );
    const input = parserSource(context.root, 'contracts/Cached.sol', 'contract Cached {}');
    try {
      expect((await session.analyzeSources([input])).files[0]?.status).toBe('failed');
      expect(spawnCount).toBe(1);
      controller.abort();
      await expect(session.analyzeSources([input])).rejects.toMatchObject({ kind: 'cancelled' });
      expect(spawnCount).toBe(1);
    } finally {
      await session.close();
      await context.remove();
    }
  });

  it('preflights per-file and remaining session byte caps before worker spawn', async () => {
    const fileContext = await makeContext({ limits: testLimits({ maxFileBytes: 64 }) });
    let fileSpawnCount = 0;
    const fileSession = createParserSessionForTests(
      { budget: fileContext.budget, config: fileContext.config },
      () => {
        fileSpawnCount += 1;
        throw new Error('An oversized source must not start a worker.');
      },
    );
    try {
      const oversized = await fileSession.analyzeSources([
        parserSource(fileContext.root, 'contracts/Oversized.sol', ' '.repeat(1_024)),
      ]);
      expect(oversized.files[0]).toMatchObject({ status: 'failed', code: 'LIMIT_EXCEEDED' });
      expect(fileSpawnCount).toBe(0);
    } finally {
      await fileSession.close();
      await fileContext.remove();
    }

    const acceptedText = 'contract A {}';
    const totalContext = await makeContext({
      limits: testLimits({ maxTotalSourceBytes: Buffer.byteLength(acceptedText, 'utf8') }),
    });
    let totalSpawnCount = 0;
    const totalSession = createParserSessionForTests(
      { budget: totalContext.budget, config: totalContext.config },
      () => {
        totalSpawnCount += 1;
        return spawn(process.execPath, [helperPath, 'fake-worker', 'valid-failure'], {
          cwd: totalContext.root,
          env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      },
    );
    try {
      await totalSession.analyzeSources([
        parserSource(totalContext.root, 'contracts/A.sol', acceptedText),
      ]);
      const beyond = await totalSession.analyzeSources([
        parserSource(totalContext.root, 'contracts/Beyond.sol', 'contract BeyondTheByteCap {}'),
      ]);
      expect(beyond.files[0]).toMatchObject({ status: 'failed', code: 'LIMIT_EXCEEDED' });
      expect(totalSpawnCount).toBe(1);
    } finally {
      await totalSession.close();
      await totalContext.remove();
    }
  });

  it('rejects parent source text, byte-hash, and manifest-hash mismatches before spawn', async () => {
    const context = await makeContext();
    let spawnCount = 0;
    const session = createParserSessionForTests(
      { budget: context.budget, config: context.config },
      () => {
        spawnCount += 1;
        throw new Error('Invalid source identity must not start a worker.');
      },
    );
    try {
      const base = parserSource(context.root, 'contracts/TextMismatch.sol', 'contract A {}');
      const wrongHash = '0'.repeat(64);
      const cases: readonly ParserSource[] = [
        {
          ...base,
          snapshot: { ...base.snapshot, originalText: 'contract Different {}' },
        },
        {
          ...base,
          snapshot: { ...base.snapshot, byteHash: wrongHash },
        },
        {
          ...base,
          manifestEntry: { ...base.manifestEntry, byteHash: wrongHash },
        },
      ];
      for (const source of cases) {
        const batch = await session.analyzeSources([source]);
        expect(batch.files[0]).toMatchObject({ status: 'failed', code: 'INTERNAL_ERROR' });
      }
      expect(spawnCount).toBe(0);
    } finally {
      await session.close();
      await context.remove();
    }
  });

  it('reuses an identical cached snapshot and rejects a changed byte hash for its identity', async () => {
    const context = await makeContext();
    const original = parserSource(context.root, 'contracts/CachedIdentity.sol', '');
    let spawnCount = 0;
    const session = createParserSessionForTests(
      { budget: context.budget, config: context.config },
      () => {
        spawnCount += 1;
        return spawn(process.execPath, [helperPath, 'fake-worker', 'valid-empty'], {
          cwd: context.root,
          env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      },
    );
    try {
      expect((await session.analyzeSources([original])).files[0]?.status).toBe('parsed');
      const changed = parserSource(
        context.root,
        'contracts/CachedIdentity.sol',
        'contract Changed {}',
      );
      expect((await session.analyzeSources([changed])).files[0]).toMatchObject({
        status: 'failed',
        code: 'INTERNAL_ERROR',
      });
      expect((await session.analyzeSources([original])).files[0]?.status).toBe('parsed');
      expect(spawnCount).toBe(1);
    } finally {
      await session.close();
      await context.remove();
    }
  });

  it('reaps initialization failures, rejects duplicate frames, and does not retry late replies', async () => {
    for (const mode of ['crash-ready', 'bad-ready', 'duplicate-ready']) {
      const context = await makeContext({ limits: testLimits({ parseTimeoutMs: 1_000 }) });
      let child: ChildProcessWithoutNullStreams | undefined;
      const session = fakeWorker(context, mode, (started) => (child = started));
      try {
        const batch = await session.analyzeSources([
          parserSource(context.root, `contracts/${mode}.sol`, 'contract C {}'),
        ]);
        expect(batch.files[0]).toMatchObject({ status: 'failed', code: 'INTERNAL_ERROR' });
        const failedInitProcess = requireValue(child);
        await waitForClose(failedInitProcess);
        expect(processExists(failedInitProcess.pid)).toBe(false);
      } finally {
        await session.close();
        await context.remove();
      }
    }

    const missingContext = await makeContext();
    const missingSession = createParserSessionForTests(
      { budget: missingContext.budget, config: missingContext.config },
      () => {
        throw new Error('simulated missing worker');
      },
    );
    try {
      const missing = await missingSession.analyzeSources([
        parserSource(missingContext.root, 'contracts/Missing.sol', 'contract Missing {}'),
      ]);
      expect(missing.files[0]).toMatchObject({ status: 'failed', code: 'INTERNAL_ERROR' });
    } finally {
      await missingSession.close();
      await missingContext.remove();
    }

    const lateContext = await makeContext({ limits: testLimits({ parseTimeoutMs: 150 }) });
    let lateChild: ChildProcessWithoutNullStreams | undefined;
    const lateStage = stageBarrier('late-reply');
    const lateSession = fakeWorker(lateContext, 'late-reply', (started) => {
      lateChild = started;
      lateStage.attach(started);
    });
    try {
      const pending = lateSession.analyzeSources([
        parserSource(lateContext.root, 'contracts/Late.sol', 'contract Late {}'),
      ]);
      await lateStage.reached;
      const late = await pending;
      expect(late.files[0]).toMatchObject({ status: 'failed', code: 'LIMIT_EXCEEDED' });
      const lateProcess = requireValue(lateChild);
      await waitForClose(lateProcess);
      expect(processExists(lateProcess.pid)).toBe(false);
    } finally {
      await lateSession.close();
      await lateContext.remove();
    }

    const duplicateContext = await makeContext({ limits: testLimits({ parseTimeoutMs: 1_000 }) });
    let duplicateSpawns = 0;
    const duplicateSession = createParserSessionForTests(
      { budget: duplicateContext.budget, config: duplicateContext.config },
      () => {
        duplicateSpawns += 1;
        return spawn(process.execPath, [helperPath, 'fake-worker', 'duplicate-reply'], {
          cwd: duplicateContext.root,
          env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      },
    );
    try {
      const duplicate = await duplicateSession.analyzeSources([
        parserSource(duplicateContext.root, 'contracts/DuplicateA.sol', 'contract A {}'),
        parserSource(duplicateContext.root, 'contracts/DuplicateB.sol', 'contract B {}'),
      ]);
      expect(duplicate.files).toHaveLength(2);
      expect(duplicateSpawns).toBeLessThanOrEqual(2);
    } finally {
      await duplicateSession.close();
      await duplicateContext.remove();
    }
  });

  it('rejects forged ranges, event owners, duplicate attributes, and drains noisy stderr', async () => {
    for (const mode of [
      'forged-range',
      'forged-owner',
      'forged-attributes',
      'forged-pragma-range',
      'forged-version',
    ]) {
      const context = await makeContext();
      const session = fakeWorker(context, mode);
      try {
        const batch = await session.analyzeSources([
          parserSource(context.root, 'contracts/Empty.sol', ''),
        ]);
        expect(batch.files[0]).toMatchObject({ status: 'failed', code: 'INTERNAL_ERROR' });
      } finally {
        await session.close();
        await context.remove();
      }
    }

    const noisyContext = await makeContext();
    const noisySession = fakeWorker(noisyContext, 'stderr-flood');
    try {
      const noisy = await noisySession.analyzeSources([
        parserSource(noisyContext.root, 'contracts/Noisy.sol', 'contract Noisy {}'),
      ]);
      expect(noisy.files[0]).toMatchObject({ status: 'failed', code: 'INTERNAL_ERROR' });
    } finally {
      await noisySession.close();
      await noisyContext.remove();
    }
  });

  it('waits for stdin backpressure before the child accepts a bounded source job', async () => {
    const context = await makeContext({ limits: testLimits({ parseTimeoutMs: 5_000 }) });
    let child: ChildProcessWithoutNullStreams | undefined;
    const blockedRead = stageBarrier('stdin-backpressure');
    const session = fakeWorker(context, 'delayed-read', (started) => {
      child = started;
      blockedRead.attach(started);
    });
    try {
      const pending = session.analyzeSources([
        parserSource(context.root, 'contracts/Backpressure.sol', ' '.repeat(512 * 1024)),
      ]);
      await blockedRead.reached;
      const batch = await pending;
      expect(batch.files[0]).toMatchObject({ status: 'failed', code: 'INTERNAL_ERROR' });
      expect(requireValue(child).pid).toBeGreaterThan(0);
    } finally {
      await session.close();
      const backpressureProcess = requireValue(child);
      await waitForClose(backpressureProcess);
      expect(processExists(backpressureProcess.pid)).toBe(false);
      await context.remove();
    }
  });

  it('enforces exact per-file/session node limits and persistent file, byte, and import caps', async () => {
    const source = 'contract Boundary { function f() public pure { return; } }';
    const baselineContext = await makeContext();
    const baselineSession = createParserSession({
      budget: baselineContext.budget,
      config: baselineContext.config,
    });
    let nodeCount = 0;
    try {
      const baseline = await baselineSession.analyzeSources([
        parserSource(baselineContext.root, 'contracts/NodeLimit.sol', source),
      ]);
      const result = requireParsed(baseline.files[0]);
      nodeCount = result.visitedNodes;
    } finally {
      await baselineSession.close();
      await baselineContext.remove();
    }
    expect(nodeCount).toBeGreaterThan(1);

    const exactContext = await makeContext({
      limits: testLimits({ maxAstNodesPerFile: nodeCount, maxAstNodesTotal: nodeCount }),
    });
    const exactSession = createParserSession({
      budget: exactContext.budget,
      config: exactContext.config,
    });
    const nodeInput = parserSource(exactContext.root, 'contracts/NodeLimit.sol', source);
    try {
      expect((await exactSession.analyzeSources([nodeInput])).files[0]?.status).toBe('parsed');
      const totalLimited = await exactSession.analyzeSources([
        parserSource(exactContext.root, 'contracts/AfterNodeLimit.sol', 'contract After {}'),
      ]);
      expect(totalLimited.files[0]).toMatchObject({ status: 'failed', code: 'LIMIT_EXCEEDED' });
    } finally {
      await exactSession.close();
      await exactContext.remove();
    }

    const belowContext = await makeContext({
      limits: testLimits({ maxAstNodesPerFile: nodeCount - 1 }),
    });
    const belowSession = createParserSession({
      budget: belowContext.budget,
      config: belowContext.config,
    });
    try {
      const oneOver = await belowSession.analyzeSources([
        parserSource(belowContext.root, 'contracts/NodeLimit.sol', source),
      ]);
      expect(oneOver.files[0]).toMatchObject({ status: 'failed', code: 'LIMIT_EXCEEDED' });
    } finally {
      await belowSession.close();
      await belowContext.remove();
    }

    const fileContext = await makeContext({ limits: testLimits({ maxFiles: 33 }) });
    const fileSession = createParserSession({
      budget: fileContext.budget,
      config: fileContext.config,
    });
    try {
      const thirtyThree = Array.from({ length: 33 }, (_, index) =>
        parserSource(fileContext.root, `contracts/Recycle${index}.sol`, `contract C${index} {}`),
      );
      const firstBatch = await fileSession.analyzeSources(thirtyThree);
      expect(firstBatch.files).toHaveLength(33);
      expect(firstBatch.files.every((result) => result.status === 'parsed')).toBe(true);
      const afterRecycle = await fileSession.analyzeSources([
        parserSource(fileContext.root, 'contracts/AfterRecycle.sol', 'contract AfterRecycle {}'),
      ]);
      expect(afterRecycle.files[0]).toMatchObject({ status: 'failed', code: 'LIMIT_EXCEEDED' });
    } finally {
      await fileSession.close();
      await fileContext.remove();
    }

    const bytesSource = 'contract Bytes {}';
    const bytesContext = await makeContext({
      limits: testLimits({ maxTotalSourceBytes: Buffer.byteLength(bytesSource, 'utf8') }),
    });
    const bytesSession = createParserSession({
      budget: bytesContext.budget,
      config: bytesContext.config,
    });
    try {
      expect(
        (
          await bytesSession.analyzeSources([
            parserSource(bytesContext.root, 'contracts/Bytes.sol', bytesSource),
          ])
        ).files[0]?.status,
      ).toBe('parsed');
      expect(
        (
          await bytesSession.analyzeSources([
            parserSource(bytesContext.root, 'contracts/MoreBytes.sol', 'contract MoreBytes {}'),
          ])
        ).files[0],
      ).toMatchObject({ status: 'failed', code: 'LIMIT_EXCEEDED' });
    } finally {
      await bytesSession.close();
      await bytesContext.remove();
    }

    const importsContext = await makeContext({ limits: testLimits({ maxImports: 3 }) });
    const importsSession = createParserSession({
      budget: importsContext.budget,
      config: importsContext.config,
    });
    const importsInput = parserSource(
      importsContext.root,
      'contracts/Imports.sol',
      await fixture('import-aliases.sol'),
    );
    try {
      const imports = await importsSession.analyzeSources([importsInput]);
      const parsedImports = requireParsed(imports.files[0]);
      expect(parsedImports.imports).toHaveLength(3);
      expect(
        (
          await importsSession.analyzeSources([
            parserSource(importsContext.root, 'contracts/MoreImports.sol', 'import "more.sol";'),
          ])
        ).files[0],
      ).toMatchObject({ status: 'failed', code: 'LIMIT_EXCEEDED' });
      expect((await importsSession.analyzeSources([importsInput])).files[0]?.status).toBe('parsed');
    } finally {
      await importsSession.close();
      await importsContext.remove();
    }
  });

  it('recycles after 8 MiB without resetting session counters or the request path', async () => {
    const context = await makeContext({
      limits: testLimits({
        maxFileBytes: 9 * 1024 * 1024,
        maxTotalSourceBytes: 16 * 1024 * 1024,
      }),
    });
    const children: ChildProcessWithoutNullStreams[] = [];
    const session = createParserSessionForTests(
      { budget: context.budget, config: context.config },
      () => {
        const child = spawn(process.execPath, [helperPath, 'fake-worker', 'valid-failure'], {
          cwd: context.root,
          env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.push(child);
        return child;
      },
    );
    try {
      const large = await session.analyzeSources([
        parserSource(context.root, 'contracts/EightMiB.sol', ' '.repeat(8 * 1024 * 1024 + 1)),
      ]);
      expect(large.files[0]?.status).toBe('failed');
      expect(children).toHaveLength(1);
      const firstPid = requireValue(children[0]?.pid);
      expect(processExists(firstPid)).toBe(false);

      const afterRecycle = await session.analyzeSources([
        parserSource(context.root, 'contracts/AfterEightMiB.sol', 'contract Small {}'),
      ]);
      expect(afterRecycle.files[0]?.status).toBe('failed');
      expect(children).toHaveLength(2);
      expect(children[0]?.pid).not.toBe(children[1]?.pid);
    } finally {
      await session.close();
      await context.remove();
    }
  });

  it('bounds cumulative worker output across individually valid frames', async () => {
    const context = await makeContext({ limits: testLimits({ parseTimeoutMs: 10_000 }) });
    let spawnCount = 0;
    const session = createParserSessionForTests(
      { budget: context.budget, config: context.config },
      () => {
        spawnCount += 1;
        return spawn(process.execPath, [helperPath, 'fake-worker', 'large-invalid'], {
          cwd: context.root,
          env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      },
    );
    try {
      const batch = await session.analyzeSources([
        parserSource(context.root, 'contracts/OutputA.sol', 'contract A {}'),
        parserSource(context.root, 'contracts/OutputB.sol', 'contract B {}'),
        parserSource(context.root, 'contracts/OutputC.sol', 'contract C {}'),
      ]);
      expect(batch.files).toHaveLength(3);
      expect(batch.files[0]).toMatchObject({ status: 'failed', code: 'INTERNAL_ERROR' });
      expect(batch.files[1]).toMatchObject({ status: 'failed', code: 'INTERNAL_ERROR' });
      expect(batch.files[2]).toMatchObject({ status: 'failed', code: 'LIMIT_EXCEEDED' });
      expect(spawnCount).toBeLessThanOrEqual(3);
    } finally {
      await session.close();
      await context.remove();
    }
  });

  it('rejects parent validation that crosses the per-file cutoff while the session budget remains live', async () => {
    const nodeAllowance = 180_000;
    const context = await makeContext({
      limits: testLimits({
        maxAstNodesPerFile: nodeAllowance,
        maxAstNodesTotal: 400_000,
        parseTimeoutMs: 2_000,
      }),
    });
    const children: ChildProcessWithoutNullStreams[] = [];
    let markValidationEntered: () => void = () => undefined;
    const validationEntered = new Promise<void>((resolveReached) => {
      markValidationEntered = resolveReached;
    });
    let spawnIndex = 0;
    const session = createParserSessionForTests(
      { budget: context.budget, config: context.config },
      () => {
        const mode = spawnIndex === 0 ? 'large-validation' : 'valid-empty';
        spawnIndex += 1;
        const child = spawn(process.execPath, [helperPath, 'fake-worker', mode], {
          cwd: context.root,
          env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.push(child);
        return child;
      },
      async (checkpoint) => {
        if (
          checkpoint.fileId === fileIdentity('contracts/AValidation.sol') &&
          checkpoint.phase === 'tokens' &&
          checkpoint.index === 0
        ) {
          markValidationEntered();
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 2_100));
        }
      },
    );
    try {
      expect(context.config.analysis.limits.maxAstNodesPerFile).toBe(nodeAllowance);
      const pending = session.analyzeSources([
        parserSource(context.root, 'contracts/AValidation.sol', ''),
        parserSource(context.root, 'contracts/BAfterValidation.sol', ''),
      ]);
      await validationEntered;
      const batch = await pending;
      const timedValidation = batch.files.find(
        (result) => result.fileId === fileIdentity('contracts/AValidation.sol'),
      );
      const independent = batch.files.find(
        (result) => result.fileId === fileIdentity('contracts/BAfterValidation.sol'),
      );
      expect(timedValidation).toMatchObject({ status: 'failed', code: 'LIMIT_EXCEEDED' });
      expect(independent?.status).toBe('parsed');
      expect(batch.visitedNodes).toBe(nodeAllowance);
      expect(() => context.budget.check()).not.toThrow();
    } finally {
      await session.close();
      for (const child of children) {
        await waitForClose(child);
        expect(processExists(child.pid)).toBe(false);
      }
      await context.remove();
    }
  }, 10_000);

  it('accounts per-file failures without stopping independent files or retrying replies', async () => {
    const context = await makeContext({ limits: testLimits({ parseTimeoutMs: 1_000 }) });
    const spawned: ChildProcessWithoutNullStreams[] = [];
    let index = 0;
    const session = createParserSessionForTests(
      { budget: context.budget, config: context.config },
      () => {
        const mode = index === 0 ? 'wrong-request-id' : 'valid-empty';
        index += 1;
        const child = spawn(process.execPath, [helperPath, 'fake-worker', mode], {
          cwd: context.root,
          env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        spawned.push(child);
        return child;
      },
    );
    try {
      const batch = await session.analyzeSources([
        parserSource(context.root, 'contracts/FailureA.sol', 'contract FailureA {}'),
        parserSource(context.root, 'contracts/FailureB.sol', 'contract FailureB {}'),
      ]);
      expect(batch.files).toHaveLength(2);
      expect(index).toBe(2);
      expect(batch.files[0]).toMatchObject({ status: 'failed', code: 'INTERNAL_ERROR' });
      expect(batch.files[1]?.status).toBe('parsed');
      expect(batch.visitedNodes).toBeGreaterThan(0);
      await session.close();
      for (const child of spawned) {
        await waitForClose(child);
        expect(processExists(child.pid)).toBe(false);
      }
    } finally {
      await session.close();
      await context.remove();
    }
  });

  it('does not spawn for an already-aborted or expired budget', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortedContext = await makeContext({ signal: controller.signal });
    let spawnCount = 0;
    const abortedSession = createParserSessionForTests(
      { budget: abortedContext.budget, config: abortedContext.config },
      () => {
        spawnCount += 1;
        throw new Error('Unexpected worker spawn.');
      },
    );
    try {
      await expect(
        abortedSession.analyzeSources([
          parserSource(abortedContext.root, 'contracts/Aborted.sol', 'contract Aborted {}'),
        ]),
      ).rejects.toBeInstanceOf(BudgetError);
      expect(spawnCount).toBe(0);
    } finally {
      await abortedSession.close();
      await abortedContext.remove();
    }

    const expiredContext = await makeContext({ deadlineAt: performance.now() - 1 });
    const expiredSession = createParserSessionForTests(
      { budget: expiredContext.budget, config: expiredContext.config },
      () => {
        spawnCount += 1;
        throw new Error('Unexpected worker spawn.');
      },
    );
    try {
      const batch = await expiredSession.analyzeSources([
        parserSource(expiredContext.root, 'contracts/Expired.sol', 'contract Expired {}'),
      ]);
      expect(batch.complete).toBe(false);
      expect(spawnCount).toBe(0);
    } finally {
      await expiredSession.close();
      await expiredContext.remove();
    }
  });

  describe('hostile semantic-component child', () => {
    it('accepts an exact valid reply and charges semantic nodes and response bytes', async () => {
      const fixture = await semanticFixture();
      try {
        const session = fixture.open('sem-reply', {
          result: fixture.validResult(),
          consumedNodes: 7,
        });
        try {
          await fixture.prepare(session);
          const before = session.counters;
          const outcome = await session.analyzeSemanticComponent(fixture.input());
          expect(outcome).toMatchObject({ status: 'bound', consumedNodes: 7, grammar: '0.8.37' });
          const after = session.counters;
          expect(after.semanticNodes).toBe(7);
          expect(after.syntaxNodes).toBe(before.syntaxNodes);
          expect(after.responseBytes).toBeGreaterThan(before.responseBytes);
          await fixture.expectNoLiveChildren(session);
        } finally {
          await session.close();
        }
      } finally {
        await fixture.context.remove();
      }
    });

    it('rejects forged candidates, ownership, coverage, identities and counters', async () => {
      const fixture = await semanticFixture();
      try {
        const valid = fixture.validResult();
        const [site] = valid.baseSites;
        if (site === undefined) throw new Error('Expected a valid base site.');
        const [definition] = site.definitions;
        if (definition === undefined || definition.kind !== 'user') {
          throw new Error('Expected a user definition.');
        }
        const withSite = (patch: Record<string, unknown>) => ({
          ...valid,
          baseSites: [{ ...site, ...patch }],
        });
        const withDefinition = (patch: Record<string, unknown>) =>
          withSite({ definitions: [{ ...definition, ...patch }] });
        const grant = fixture.context.config.analysis.limits.maxAstNodesPerFile * 2;
        const cases: readonly [string, Record<string, unknown>][] = [
          [
            'definition outside the component',
            { result: withDefinition({ fileId: fileIdentity('contracts/x.sol') }) },
          ],
          [
            'declaration kind forged',
            { result: withDefinition({ definiens: 'FunctionDefinition' }) },
          ],
          [
            'declaration kind claimed where none exists',
            { result: withDefinition({ nameRange: site.reference }) },
          ],
          ['unknown contract start', { result: withSite({ contractStartByte: 1 }) }],
          ['duplicate base site', { result: { ...valid, baseSites: [site, site] } }],
          ['ordinal gap', { result: withSite({ ordinal: 1 }) }],
          [
            'reference outside the declaration',
            {
              result: withSite({
                reference: {
                  ...site.reference,
                  startByte: 0,
                  endByte: 1,
                  start: { line: 1, column: 1 },
                  end: { line: 1, column: 2 },
                },
              }),
            },
          ],
          [
            'call site without a syntax event',
            {
              result: {
                ...valid,
                callSites: [
                  {
                    fileId: site.fileId,
                    range: site.reference,
                    callee: 'identifier',
                    definitions: [],
                    receiver: 'none',
                    receiverDefinitions: [],
                  },
                ],
              },
            },
          ],
          ['forged counters', { result: valid, consumedNodes: grant + 1 }],
          ['wrong component', { result: valid, componentId: fileIdentity('contracts/x.sol') }],
          ['wrong request id', { result: valid, requestId: 99 }],
          ['grammar mismatch', { result: { ...valid, grammar: '0.8.28' } }],
          ['unknown key', { result: { ...valid, recovered: [] } }],
          ['unknown reason', { result: { status: 'unavailable', reason: 'timeout' } }],
        ];
        for (const [name, script] of cases) {
          const session = fixture.open('sem-reply', script);
          try {
            await fixture.prepare(session);
            const outcome = await session.analyzeSemanticComponent(fixture.input());
            expect({ name, outcome }).toMatchObject({
              name,
              outcome: { status: 'unavailable', reason: 'protocol', consumedNodes: grant },
            });
            expect(session.counters.semanticNodes).toBe(grant);
            // Original syntax survives a rejected semantic result.
            expect(
              session.cachedSyntax(
                fixture.members[0]?.source.fileId ?? fileIdentity('contracts/a.sol'),
                fixture.members[0]?.source.snapshot.byteHash ?? '',
              ),
            ).toBeDefined();
            await fixture.expectNoLiveChildren(session);
          } finally {
            await session.close();
          }
        }
      } finally {
        await fixture.context.remove();
      }
    }, 60_000);

    it('rejects malformed, oversized, duplicate and crashing child behavior', async () => {
      const fixture = await semanticFixture();
      try {
        const cases: readonly [string, string, Record<string, unknown>, string][] = [
          ['malformed JSON', 'sem-reply', { raw: '{not json' }, 'protocol'],
          [
            'oversized frame',
            'sem-reply',
            { result: fixture.validResult(), paddingBytes: 33 * 1024 * 1024 },
            'limit',
          ],
          ['crash on request', 'crash-request', {}, 'protocol'],
          ['crash on startup', 'crash-ready', {}, 'protocol'],
          ['malformed startup', 'bad-ready', {}, 'protocol'],
          ['duplicate startup', 'duplicate-ready', {}, 'protocol'],
        ];
        for (const [name, mode, script, reason] of cases) {
          const session = fixture.open(mode, script);
          try {
            await fixture.prepare(session);
            const outcome = await session.analyzeSemanticComponent(fixture.input());
            expect({ name, status: outcome.status }).toEqual({ name, status: 'unavailable' });
            expect({
              name,
              reason: outcome.status === 'unavailable' ? outcome.reason : null,
            }).toEqual({ name, reason });
            await fixture.expectNoLiveChildren(session);
          } finally {
            await session.close();
          }
        }

        let child: ChildProcessWithoutNullStreams | undefined;
        let frameControl: ReturnType<typeof coalesceDuplicateReplyFrames> | undefined;
        const duplicateSession = fixture.open(
          'sem-reply',
          { result: fixture.validResult(), duplicate: true },
          (started) => {
            child = started;
            frameControl = coalesceDuplicateReplyFrames(started);
          },
        );
        try {
          await fixture.prepare(duplicateSession);
          const outcome = await duplicateSession.analyzeSemanticComponent(fixture.input());
          expect(outcome).toMatchObject({ status: 'unavailable', reason: 'protocol' });
          expect(frameControl?.framesSeen()).toBe(3);
          expect(frameControl?.coalescedWrites()).toBe(1);
          expect(frameControl?.failure()).toBeUndefined();
          await fixture.expectNoLiveChildren(duplicateSession);
          const duplicateChild = requireValue(child);
          expect(processExists(duplicateChild.pid)).toBe(false);
        } finally {
          await duplicateSession.close();
          frameControl?.close();
        }
      } finally {
        await fixture.context.remove();
      }
    });

    it('kills stalled startup and binding children at the job cutoff and reaps them', async () => {
      const fixture = await semanticFixture({ semanticTimeoutMs: 150 });
      try {
        for (const [mode, script] of [
          ['stall-ready', {}],
          ['sem-stall', { stage: 'semantic-binding' }],
          ['sem-reply', { result: fixture.validResult(), delayMs: 1_000 }],
        ] as const) {
          const session = fixture.open(mode, script);
          try {
            await fixture.prepare(session);
            const outcome = await session.analyzeSemanticComponent(fixture.input());
            expect({ mode, outcome }).toMatchObject({
              mode,
              outcome: { status: 'unavailable', reason: 'limit' },
            });
            // A killed job is charged its full granted traversal allowance.
            expect(session.counters.semanticNodes).toBeGreaterThan(0);
            await fixture.expectNoLiveChildren(session);
          } finally {
            await session.close();
          }
        }
      } finally {
        await fixture.context.remove();
      }
    });

    it('propagates cancellation during a binding stall and reaps the child', async () => {
      const controller = new AbortController();
      const fixture = await semanticFixture({ signal: controller.signal });
      try {
        const barrier = stageBarrier('semantic-binding');
        const session = fixture.open('sem-stall', { stage: 'semantic-binding' }, barrier.attach);
        try {
          await fixture.prepare(session);
          const pending = session.analyzeSemanticComponent(fixture.input()).then(
            () => null,
            (error: unknown) => error,
          );
          await barrier.reached;
          controller.abort();
          expect(await pending).toMatchObject({ kind: 'cancelled' });
          await fixture.expectNoLiveChildren(session);
        } finally {
          await session.close();
        }
      } finally {
        await fixture.context.remove();
      }
    });

    it('applies the job cutoff and abort to parent-side validation', async () => {
      const controller = new AbortController();
      const fixture = await semanticFixture({ signal: controller.signal, semanticTimeoutMs: 200 });
      try {
        const aborting = fixture.open(
          'sem-reply',
          { result: fixture.validResult() },
          undefined,
          (checkpoint) => {
            if (checkpoint.phase === 'semantic-base-sites') controller.abort();
          },
        );
        try {
          await fixture.prepare(aborting);
          await expect(aborting.analyzeSemanticComponent(fixture.input())).rejects.toMatchObject({
            kind: 'cancelled',
          });
          await fixture.expectNoLiveChildren(aborting);
        } finally {
          await aborting.close();
        }
      } finally {
        await fixture.context.remove();
      }

      const slowFixture = await semanticFixture({ semanticTimeoutMs: 150 });
      try {
        let observed = 0;
        const slow = slowFixture.open(
          'sem-reply',
          { result: slowFixture.validResult() },
          undefined,
          async (checkpoint) => {
            if (checkpoint.phase !== 'semantic-base-sites') return;
            observed += 1;
            await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 400));
          },
        );
        try {
          await slowFixture.prepare(slow);
          const outcome = await slow.analyzeSemanticComponent(slowFixture.input());
          expect(outcome).toMatchObject({ status: 'unavailable', reason: 'limit' });
          expect(observed).toBe(1);
          await slowFixture.expectNoLiveChildren(slow);
        } finally {
          await slow.close();
        }
      } finally {
        await slowFixture.context.remove();
      }
    });

    it('counts startup and reply frames against the cumulative session response ceiling', async () => {
      const fixture = await semanticFixture();
      try {
        const session = fixture.open('sem-reply', {
          result: fixture.validResult(),
          paddingBytes: 30 * 1024 * 1024,
        });
        try {
          await fixture.prepare(session);
          const start = session.counters.responseBytes;
          const first = await session.analyzeSemanticComponent(fixture.input());
          expect(first).toMatchObject({ status: 'unavailable', reason: 'protocol' });
          const afterFirst = session.counters.responseBytes;
          expect(afterFirst - start).toBeGreaterThan(30 * 1024 * 1024);
          const second = await session.analyzeSemanticComponent(fixture.input());
          expect(second).toMatchObject({ status: 'unavailable', reason: 'protocol' });
          expect(session.counters.responseBytes).toBeGreaterThan(afterFirst + 30 * 1024 * 1024);
          // The third padded reply would cross the 64 MiB ceiling and is a limit, not a raise.
          const third = await session.analyzeSemanticComponent(fixture.input());
          expect(third).toMatchObject({ status: 'unavailable', reason: 'limit' });
          // Syntax work after the ceiling is refused instead of resetting the accounting.
          const extra = parserSource(
            fixture.context.root,
            'contracts/c.sol',
            'pragma solidity 0.8.37;\ncontract C {}\n',
          );
          const batch = await session.analyzeSources([extra]);
          expect(batch.files[0]).toMatchObject({ status: 'failed', code: 'LIMIT_EXCEEDED' });
          await fixture.expectNoLiveChildren(session);
        } finally {
          await session.close();
        }
      } finally {
        await fixture.context.remove();
      }
    }, 60_000);
  });
});

const SEMANTIC_PAIR = [
  {
    path: 'contracts/a.sol',
    text: 'pragma solidity 0.8.37;\nimport "./b.sol";\ncontract A is B {}\n',
  },
  { path: 'contracts/b.sol', text: 'pragma solidity 0.8.37;\ncontract B {}\n' },
] as const;

function asciiRange(text: string, needle: string, offset = 0) {
  const startByte = text.indexOf(needle) + offset;
  const lineStart = text.lastIndexOf('\n', startByte - 1) + 1;
  const line = text.slice(0, startByte).split('\n').length;
  const column = startByte - lineStart + 1;
  const length = needle.length - offset;
  return {
    startByte,
    endByte: startByte + length,
    start: { line, column },
    end: { line, column: column + length },
  };
}

async function analyzeBatch(
  session: ReturnType<typeof createParserSession>,
  sources: readonly ParserSource[],
) {
  return await session.analyzeSources(sources);
}

interface SemanticFixtureHandle {
  readonly context: TestContext;
  readonly members: readonly SemanticComponentMember[];
  readonly open: (
    mode: string,
    script: Record<string, unknown>,
    onSpawn?: (child: ChildProcessWithoutNullStreams) => void,
    observer?: (checkpoint: { readonly phase: string }) => void | Promise<void>,
  ) => ReturnType<typeof createParserSessionForTests>;
  readonly prepare: (session: ReturnType<typeof createParserSessionForTests>) => Promise<void>;
  readonly input: () => SemanticComponentInput;
  readonly validResult: () => {
    readonly status: 'bound';
    readonly grammar: string;
    readonly baseSites: readonly SemanticBaseSite[];
    readonly callSites: readonly never[];
  };
  readonly expectNoLiveChildren: (
    session: ReturnType<typeof createParserSessionForTests>,
  ) => Promise<void>;
}

async function semanticFixture(
  options: { readonly semanticTimeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<SemanticFixtureHandle> {
  const context = await makeContext({
    limits: testLimits(
      options.semanticTimeoutMs === undefined
        ? {}
        : { semanticTimeoutMs: options.semanticTimeoutMs },
    ),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const sources = SEMANTIC_PAIR.map((item) => parserSource(context.root, item.path, item.text));
  const membersFrom = (
    batch: Awaited<ReturnType<typeof analyzeBatch>>,
  ): SemanticComponentMember[] =>
    sources.map((source) => {
      const syntax = batch.files.find((file) => file.fileId === source.fileId);
      if (syntax?.status !== 'parsed') throw new Error('Expected parsed fixture syntax.');
      return { source, syntax };
    });
  // A throwaway session yields the (deterministic) syntax facts that scripted replies refer to.
  const probe = createParserSession({ budget: context.budget, config: context.config });
  let members: SemanticComponentMember[];
  try {
    members = membersFrom(await analyzeBatch(probe, sources));
  } finally {
    await probe.close();
  }
  let spawned: ChildProcessWithoutNullStreams[] = [];
  const packageEntry = new URL(import.meta.resolve('audit-estimator'));
  const workerPath = fileURLToPath(new URL('./parser/worker.js', packageEntry));
  const packageRoot = resolve(fileURLToPath(new URL('../', packageEntry)));

  const validResult = () => {
    const [aSource, bSource] = sources;
    const [a, b] = members;
    if (aSource === undefined || bSource === undefined || a === undefined || b === undefined) {
      throw new Error('Fixture is not prepared.');
    }
    const aText = SEMANTIC_PAIR[0].text;
    const contractA = a.syntax.declarations.find((declaration) => declaration.name === 'A');
    const contractB = b.syntax.declarations.find((declaration) => declaration.name === 'B');
    if (contractA === undefined || contractB === undefined) throw new Error('Missing contracts.');
    return {
      status: 'bound' as const,
      grammar: '0.8.37',
      baseSites: [
        {
          fileId: aSource.fileId,
          contractStartByte: contractA.declarationRange.startByte,
          ordinal: 0,
          reference: asciiRange(aText, ' is B', 4),
          definitions: [
            {
              kind: 'user' as const,
              fileId: bSource.fileId,
              nameRange: contractB.nameRange,
              definiens: 'ContractDefinition',
            },
          ],
        },
      ],
      callSites: [] as never[],
    };
  };

  return {
    context,
    get members() {
      return members;
    },
    open: (mode, script, onSpawn, observer) => {
      let count = 0;
      spawned = [];
      return createParserSessionForTests(
        { budget: context.budget, config: context.config },
        () => {
          count += 1;
          const child =
            count === 1
              ? spawn(process.execPath, ['--max-old-space-size=64', workerPath], {
                  cwd: packageRoot,
                  env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
                  shell: false,
                  stdio: ['pipe', 'pipe', 'pipe'],
                })
              : spawn(process.execPath, [helperPath, 'fake-worker', mode, JSON.stringify(script)], {
                  cwd: context.root,
                  env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
                  shell: false,
                  stdio: ['pipe', 'pipe', 'pipe'],
                });
          spawned.push(child);
          if (count > 1) onSpawn?.(child);
          return child;
        },
        observer === undefined ? undefined : (checkpoint) => observer({ phase: checkpoint.phase }),
      );
    },
    prepare: async (session) => {
      members = membersFrom(await analyzeBatch(session, sources));
    },
    input: () => {
      const [a, b] = members;
      if (a === undefined || b === undefined) throw new Error('Fixture is not prepared.');
      const imported = a.syntax.imports[0];
      if (imported === undefined) throw new Error('Expected an import.');
      return {
        componentId: a.source.fileId,
        grammar: '0.8.37',
        members,
        lookups: [
          {
            importerFileId: a.source.fileId,
            importId: imported.id,
            specifier: imported.specifier,
            specifierRange: imported.specifierRange,
            targetFileId: b.source.fileId,
          },
        ],
        maxRecords: 100_000,
      };
    },
    validResult,
    expectNoLiveChildren: async (session) => {
      // Only the long-lived syntax child may remain until the session is closed.
      for (const child of spawned.slice(1)) {
        await waitForClose(child);
        expect(processExists(child.pid)).toBe(false);
      }
      expect(spawned.length).toBeGreaterThan(1);
      void session;
    },
  };
}
