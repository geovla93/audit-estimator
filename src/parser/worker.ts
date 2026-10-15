import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  FrameDecoder,
  ParserProtocolError,
  decodeJsonFrame,
  decodeSemanticRequest,
  encodeFrame,
  maxRequestFrameBytes,
  MAX_RESPONSE_BYTES,
  PARSER_PROTOCOL_VERSION,
  strictRecord,
} from './protocol.ts';
import type {
  ParseFileResult,
  ParserWorkerRequest,
  SemanticWorkerReply,
  SemanticWorkerRequest,
  WorkerReady,
  WorkerReply,
} from './protocol.ts';
import { analyzeSemanticComponent } from './bindings.ts';
import { analyzeSource } from './extract-syntax.ts';
import { LanguageFacts } from '@nomicfoundation/slang/utils';

const MAX_CONFIGURED_FILE_BYTES: number = 20 * 1024 * 1024;
const MAX_CONFIGURED_NODES: number = 2_000_000;
const MAX_CONFIGURED_IMPORTS: number = 200_000;
const MAX_REQUEST_BYTES: number = maxRequestFrameBytes(MAX_CONFIGURED_FILE_BYTES);
/**
 * The frame header ceiling must admit the largest semantic component the parent may derive. The
 * parent computes and enforces the effective, tighter ceiling before encoding; the child still
 * applies per-kind size, count and byte checks before building any map or invoking Slang.
 */
const MAX_FRAME_BYTES: number = 0xffff_ffff;
const decoder = new FrameDecoder(MAX_FRAME_BYTES);
const require = createRequire(import.meta.url);

async function packageVersion(): Promise<string> {
  const slangEntry = require.resolve('@nomicfoundation/slang');
  const packagePath = fileURLToPath(new URL('../package.json', pathToFileURL(slangEntry)));
  const packageValue: unknown = JSON.parse(await readFile(packagePath, 'utf8')) as unknown;
  if (
    typeof packageValue !== 'object' ||
    packageValue === null ||
    !('version' in packageValue) ||
    typeof packageValue.version !== 'string' ||
    packageValue.version.length > 128
  ) {
    throw new Error('Trusted parser package metadata is invalid.');
  }
  return packageValue.version;
}

async function writeFrame(value: unknown, maximumBytes: number): Promise<number> {
  const frame = encodeFrame(value, maximumBytes);
  if (!process.stdout.write(frame)) {
    await new Promise<void>((resolve, reject) => {
      process.stdout.once('drain', resolve);
      process.stdout.once('error', reject);
    });
  }
  return frame.byteLength - 4;
}

function validCount(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function decodeRequest(value: unknown): ParserWorkerRequest {
  const record = strictRecord(value, [
    'protocolVersion',
    'requestId',
    'kind',
    'fileId',
    'canonicalPath',
    'originalText',
    'byteHash',
    'maxFileBytes',
    'maxAstNodesPerFile',
    'maxAstNodesRemaining',
    'maxImportsRemaining',
    'versionAuthority',
    'version',
  ]);
  if (
    record.protocolVersion !== PARSER_PROTOCOL_VERSION ||
    !validCount(record.requestId, 1, Number.MAX_SAFE_INTEGER) ||
    record.kind !== 'parse-file' ||
    typeof record.fileId !== 'string' ||
    typeof record.canonicalPath !== 'string' ||
    record.canonicalPath.length === 0 ||
    record.canonicalPath.length > 4096 ||
    typeof record.originalText !== 'string' ||
    typeof record.byteHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.byteHash) ||
    !validCount(record.maxFileBytes, 0, MAX_CONFIGURED_FILE_BYTES) ||
    !validCount(record.maxAstNodesPerFile, 0, MAX_CONFIGURED_NODES) ||
    !validCount(record.maxAstNodesRemaining, 0, MAX_CONFIGURED_NODES) ||
    !validCount(record.maxImportsRemaining, 0, MAX_CONFIGURED_IMPORTS) ||
    !['cli', 'config', 'metadata', 'default'].includes(String(record.versionAuthority)) ||
    typeof record.version !== 'string' ||
    record.version.length === 0 ||
    record.version.length > 128
  ) {
    throw new ParserProtocolError('protocol');
  }
  return record as unknown as ParserWorkerRequest;
}

function limitedReply(
  request: ParserWorkerRequest,
  consumedNodes: number,
  consumedImports: number,
): WorkerReply {
  const result: ParseFileResult = {
    status: 'failed',
    fileId: request.fileId,
    code: 'LIMIT_EXCEEDED',
    diagnostics: [
      {
        code: 'LIMIT_EXCEEDED',
        severity: 'warning',
        phase: 'parse',
        message: 'Parser output exceeded the configured response ceiling.',
        fileId: request.fileId,
      },
    ],
  };
  return {
    protocolVersion: PARSER_PROTOCOL_VERSION,
    requestId: request.requestId,
    kind: 'result',
    jobKind: 'parse-file',
    fileId: request.fileId,
    consumedNodes,
    consumedImports,
    result,
  };
}

async function handleRequest(
  request: ParserWorkerRequest,
  parserVersion: string,
  installedVersions: readonly string[],
): Promise<void> {
  const analyzed = analyzeSource(request, parserVersion, installedVersions);
  const reply: WorkerReply = {
    protocolVersion: PARSER_PROTOCOL_VERSION,
    requestId: request.requestId,
    kind: 'result',
    jobKind: 'parse-file',
    fileId: request.fileId,
    consumedNodes: analyzed.consumedNodes,
    consumedImports: analyzed.consumedImports,
    result: analyzed.result,
  };
  try {
    await writeFrame(reply, MAX_RESPONSE_BYTES);
  } catch (error: unknown) {
    if (!(error instanceof ParserProtocolError) || error.failure !== 'limit') throw error;
    await writeFrame(
      limitedReply(request, analyzed.consumedNodes, analyzed.consumedImports),
      MAX_RESPONSE_BYTES,
    );
  }
}

const parserVersion = await packageVersion();
const supportedVersions = LanguageFacts.allVersions();
const ready: WorkerReady = {
  protocolVersion: PARSER_PROTOCOL_VERSION,
  kind: 'ready',
  parserVersion,
  supportedVersions,
};
await writeFrame(ready, 64 * 1024);

function semanticLimitedReply(
  request: SemanticWorkerRequest,
  consumedNodes: number,
): SemanticWorkerReply {
  return {
    protocolVersion: PARSER_PROTOCOL_VERSION,
    requestId: request.requestId,
    kind: 'result',
    jobKind: 'semantic-component',
    componentId: request.componentId,
    consumedNodes,
    result: { status: 'unavailable', reason: 'limit' },
  };
}

async function handleSemanticRequest(
  request: SemanticWorkerRequest,
  installedVersions: readonly string[],
): Promise<void> {
  const analyzed = await analyzeSemanticComponent(request, installedVersions);
  const reply: SemanticWorkerReply = {
    protocolVersion: PARSER_PROTOCOL_VERSION,
    requestId: request.requestId,
    kind: 'result',
    jobKind: 'semantic-component',
    componentId: request.componentId,
    consumedNodes: analyzed.consumedNodes,
    result: analyzed.result,
  };
  try {
    await writeFrame(reply, MAX_RESPONSE_BYTES);
  } catch (error: unknown) {
    if (!(error instanceof ParserProtocolError) || error.failure !== 'limit') throw error;
    await writeFrame(semanticLimitedReply(request, analyzed.consumedNodes), MAX_RESPONSE_BYTES);
  }
}

function requestKind(value: unknown): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'kind' in value
    ? value.kind
    : undefined;
}

let lastRequestId = 0;
for await (const chunk of process.stdin) {
  const frames = decoder.push(chunk);
  for (const frame of frames) {
    const value = decodeJsonFrame(frame);
    if (requestKind(value) === 'semantic-component') {
      const semantic = decodeSemanticRequest(value);
      if (semantic.requestId <= lastRequestId) throw new ParserProtocolError('protocol');
      lastRequestId = semantic.requestId;
      await handleSemanticRequest(semantic, supportedVersions);
      continue;
    }
    if (frame.byteLength > MAX_REQUEST_BYTES) throw new ParserProtocolError('limit');
    const request = decodeRequest(value);
    if (request.requestId <= lastRequestId) throw new ParserProtocolError('protocol');
    lastRequestId = request.requestId;
    await handleRequest(request, parserVersion, supportedVersions);
  }
}
decoder.finish();
