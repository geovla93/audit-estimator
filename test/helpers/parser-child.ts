import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createParserSession } from '../../src/parser/adapter.ts';
import { createDiscoveryBudget } from '../../src/discovery/budget.ts';
import { contractIdentity, fileIdentity } from '../../src/domain/canonical.ts';
import { DEFAULT_ANALYSIS_LIMITS, DEFAULT_SCOPE_SETTINGS } from '../../src/config/defaults.ts';
import { resolveConfig } from '../../src/config/load.ts';
import type {
  AnalysisLimits,
  FileScopeEntry,
  ModelProfile,
  SourceSnapshot,
} from '../../src/domain/types.ts';

const scenario = process.argv[2];

if (scenario === 'fake-worker') {
  await runFakeWorker(process.argv[3] ?? 'valid-failure');
} else if (scenario === 'bridge') {
  await runBridge();
}

async function runBridge(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const request: unknown = JSON.parse(line) as unknown;
    if (
      !isRecord(request) ||
      typeof request.source !== 'string' ||
      typeof request.loaderUrl !== 'string' ||
      typeof request.loaderPath !== 'string'
    ) {
      process.exitCode = 2;
      return;
    }
    process.env.NODE_OPTIONS = `--import=${request.loaderUrl}`;
    process.env.NODE_PATH = request.loaderPath;
    process.env.NODE_V8_COVERAGE = request.loaderPath;
    const limits: AnalysisLimits = { ...DEFAULT_ANALYSIS_LIMITS };
    const resolved = await resolveConfig({
      root: process.cwd(),
      noConfig: true,
      defaults: trustedDefaults(limits),
    });
    const canonicalPath = 'contracts/NativeBridge.sol';
    const fileId = fileIdentity(canonicalPath);
    const originalText = request.source;
    const originalBytes = Buffer.from(originalText, 'utf8');
    const byteHash = createHash('sha256').update(originalBytes).digest('hex');
    const snapshot: SourceSnapshot = {
      canonicalPath,
      absolutePath: resolve(process.cwd(), canonicalPath),
      originalBytes,
      originalText,
      byteHash,
    };
    const manifestEntry: FileScopeEntry = {
      fileId,
      path: canonicalPath,
      role: 'scoped',
      ownership: 'first-party',
      ownershipEvidence: [],
      physicalIdentity: 'native-bridge-fixture',
      byteHash,
    };
    const session = createParserSession({
      budget: createDiscoveryBudget(resolved.config.analysis.limits),
      config: resolved.config,
    });
    try {
      const batch = await session.analyzeSources([{ fileId, snapshot, manifestEntry }]);
      process.stdout.write(JSON.stringify(batch));
    } finally {
      await session.close();
    }
    return;
  }
}

async function runFakeWorker(mode: string): Promise<void> {
  if (mode === 'stall-ready') {
    markStage('startup');
    stall();
  }
  if (mode === 'crash-ready') process.exit(19);
  if (mode === 'bad-ready') {
    writeBytes(Buffer.from([0, 0, 0, 1, 0xff]));
    return;
  }
  const ready = {
    protocolVersion: 1,
    kind: 'ready',
    parserVersion: '1.3.9',
    supportedVersions: ['0.8.37'],
  };
  writeFrame(ready);
  if (mode === 'duplicate-ready') writeFrame(ready);
  if (mode === 'delayed-read') {
    markStage('stdin-backpressure');
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 150));
  }

  let input = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    input = Buffer.concat([input, chunk]);
    while (input.byteLength >= 4) {
      const length = input.readUInt32BE(0);
      if (input.byteLength < length + 4) break;
      const payload = input.subarray(4, length + 4);
      input = input.subarray(length + 4);
      const request: unknown = JSON.parse(payload.toString('utf8')) as unknown;
      if (
        !isRecord(request) ||
        typeof request.requestId !== 'number' ||
        typeof request.fileId !== 'string' ||
        typeof request.canonicalPath !== 'string'
      ) {
        process.exit(20);
      }
      if (mode.startsWith('stall-')) {
        markStage(mode.slice('stall-'.length));
        stall();
      }
      if (mode === 'crash-request') process.exit(21);
      if (mode === 'late-reply') {
        markStage('late-reply');
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 250));
      }
      if (mode === 'stderr-flood') process.stderr.write('x'.repeat(70 * 1024));
      const reply = makeReply(request.requestId, request.fileId, request.canonicalPath, mode);
      if (mode === 'large-validation') {
        const payload = Buffer.from(JSON.stringify(reply), 'utf8');
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
        markStage('validation-ready');
        writePayload(payload);
      } else writeFrame(reply);
      if (mode === 'duplicate-reply') writeFrame(reply);
    }
  }
}

function makeReply(requestId: number, fileId: string, canonicalPath: string, mode: string) {
  if (mode === 'valid-empty') {
    return {
      protocolVersion: 1,
      requestId,
      kind: 'result',
      jobKind: 'parse-file',
      fileId,
      consumedNodes: 0,
      consumedImports: 0,
      result: {
        status: 'parsed',
        fileId,
        version: {
          selectedVersion: '0.8.37',
          selectionSource: 'latest-no-pragma',
          ignoredHint: 'not-applicable',
          compatibleVersions: ['0.8.37'],
          installedVersions: ['0.8.37'],
          pragmaRanges: [],
          parserVersion: '1.3.9',
        },
        tokens: [],
        declarations: [],
        imports: [],
        events: [],
        diagnostics: [
          {
            code: 'LANGUAGE_UNSUPPORTED',
            severity: 'warning',
            phase: 'parse',
            message:
              'No Solidity version pragma is present; grammar selection used configured evidence.',
            fileId,
          },
        ],
        visitedNodes: 0,
      },
    };
  }
  if (mode === 'large-validation') {
    const emptyRange = {
      startByte: 0,
      endByte: 0,
      start: { line: 1, column: 1 },
      end: { line: 1, column: 1 },
    };
    const tokens = Array.from({ length: 160_000 }, () => ({
      fileId,
      kind: 'whitespace',
      range: emptyRange,
    }));
    return {
      protocolVersion: 1,
      requestId,
      kind: 'result',
      jobKind: 'parse-file',
      fileId,
      consumedNodes: tokens.length,
      consumedImports: 0,
      result: {
        status: 'parsed',
        fileId,
        version: {
          selectedVersion: '0.8.37',
          selectionSource: 'latest-no-pragma',
          ignoredHint: 'not-applicable',
          compatibleVersions: ['0.8.37'],
          installedVersions: ['0.8.37'],
          pragmaRanges: [],
          parserVersion: '1.3.9',
        },
        tokens,
        declarations: [],
        imports: [],
        events: [],
        diagnostics: [
          {
            code: 'LANGUAGE_UNSUPPORTED',
            severity: 'warning',
            phase: 'parse',
            message:
              'No Solidity version pragma is present; grammar selection used configured evidence.',
            fileId,
          },
        ],
        visitedNodes: tokens.length,
      },
    };
  }
  if (
    mode === 'forged-range' ||
    mode === 'forged-owner' ||
    mode === 'forged-attributes' ||
    mode === 'forged-pragma-range' ||
    mode === 'forged-version'
  ) {
    const emptyRange = {
      startByte: 0,
      endByte: 0,
      start: { line: 1, column: 1 },
      end: { line: 1, column: 1 },
    };
    const result = {
      status: 'parsed',
      fileId,
      version: {
        selectedVersion: '0.8.37',
        selectionSource: mode === 'forged-version' ? 'config' : 'latest-no-pragma',
        ignoredHint: 'not-applicable',
        compatibleVersions: ['0.8.37'],
        installedVersions: ['0.8.37'],
        pragmaRanges: mode === 'forged-pragma-range' ? [{ ...emptyRange, endByte: 1 }] : [],
        parserVersion: '1.3.9',
      },
      tokens:
        mode === 'forged-range'
          ? [{ fileId, kind: 'identifier', range: { ...emptyRange, endByte: 1 } }]
          : [],
      declarations: [],
      imports: [],
      events:
        mode === 'forged-owner'
          ? [
              {
                fileId,
                kind: 'declaration',
                contractId: contractIdentity(canonicalPath, 'contract', 0),
                callableId: null,
                range: emptyRange,
                attributes: [],
              },
            ]
          : mode === 'forged-attributes'
            ? [
                {
                  fileId,
                  kind: 'declaration',
                  contractId: null,
                  callableId: null,
                  range: emptyRange,
                  attributes: [
                    { key: 'declaration-kind', value: 'contract' },
                    { key: 'declaration-kind', value: 'contract' },
                  ],
                },
              ]
            : [],
      diagnostics: [],
      visitedNodes: 1,
    };
    return {
      protocolVersion: 1,
      requestId,
      kind: 'result',
      jobKind: 'parse-file',
      fileId,
      consumedNodes: 1,
      consumedImports: 0,
      result,
    };
  }
  return {
    protocolVersion: 1,
    requestId: mode === 'wrong-request-id' ? requestId + 1 : requestId,
    kind: 'result',
    jobKind: 'parse-file',
    fileId,
    consumedNodes: 0,
    consumedImports: 0,
    result: {
      status: 'failed',
      fileId,
      code: 'INTERNAL_ERROR',
      diagnostics: [],
    },
    ...(mode === 'large-invalid' ? { padding: 'x'.repeat(22 * 1024 * 1024) } : {}),
  };
}

function markStage(stage: string): void {
  process.stderr.write(`stage:${stage}\n`);
}

function stall(): never {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0);
  throw new Error('Unreachable stall returned.');
}

function writeFrame(value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  writePayload(payload);
}

function writePayload(payload: Buffer): void {
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  writeBytes(frame);
}

function writeBytes(frame: Buffer): void {
  process.stdout.write(frame);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
