import { describe, expect, it } from 'vitest';
import { FileIdSchema } from '../../src/domain/schemas.ts';
import {
  FrameDecoder,
  MAX_RESPONSE_BYTES,
  MAX_READY_VERSIONS,
  MAX_DIAGNOSTIC_MESSAGE_CODE_UNITS,
  MAX_DIAGNOSTIC_MESSAGE_BYTES,
  MAX_SEMANTIC_BYTES_CEILING,
  MAX_SEMANTIC_DEFINITIONS_PER_REFERENCE,
  MAX_SEMANTIC_FILES_CEILING,
  MAX_SEMANTIC_LOOKUPS_CEILING,
  MAX_SEMANTIC_ORDINAL,
  MAX_SEMANTIC_RECORDS_CEILING,
  PARSER_PROTOCOL_VERSION,
  ParserProtocolError,
  REQUEST_FRAME_OVERHEAD_BYTES,
  SEMANTIC_FILE_FRAME_OVERHEAD_BYTES,
  SEMANTIC_LOOKUP_FRAME_OVERHEAD_BYTES,
  decodeJsonFrame,
  decodeSemanticRequest,
  encodeFrame,
  maxRequestFrameBytes,
  maxSemanticRequestFrameBytes,
  validateParseFileResult,
  validateReady,
  validateSemanticReply,
  validateWorkerReply,
} from '../../src/parser/protocol.ts';

const fileId = FileIdSchema.parse('file:Root.sol');

describe('parser protocol framing', () => {
  it('encodes an exact-bound frame and rejects a payload one byte over', () => {
    const payload = { x: 'ok' };
    const exactBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    expect(encodeFrame(payload, exactBytes).readUInt32BE(0)).toBe(exactBytes);
    expect(() => encodeFrame(payload, exactBytes - 1)).toThrow(ParserProtocolError);
    expect(maxRequestFrameBytes(10)).toBe(6 * 10 + 64 * 1024);
  });

  it('reassembles fragmented headers and payloads and emits coalesced frames', () => {
    const first = encodeFrame({ id: 1 }, 32);
    const second = encodeFrame({ id: 2 }, 32);
    const decoder = new FrameDecoder(32);
    expect(decoder.push(first.subarray(0, 2))).toEqual([]);
    expect(decoder.push(first.subarray(2, 7))).toEqual([]);
    const coalesced = Buffer.concat([first.subarray(7), second]);
    const frames = decoder.push(coalesced);
    expect(frames.map(decodeJsonFrame)).toEqual([{ id: 1 }, { id: 2 }]);
    decoder.finish();
  });

  it('rejects oversized advertised frames before payload allocation and detects truncation', () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(33, 0);
    expect(() => new FrameDecoder(32).push(oversized)).toThrow(ParserProtocolError);

    const truncated = encodeFrame({ id: 1 }, 32);
    const decoder = new FrameDecoder(32);
    decoder.push(truncated.subarray(0, truncated.length - 1));
    expect(() => decoder.finish()).toThrow(ParserProtocolError);
  });

  it('rejects invalid UTF-8 and malformed JSON payloads', () => {
    expect(() => decodeJsonFrame(Uint8Array.from([0xc3, 0x28]))).toThrow(ParserProtocolError);
    expect(() => decodeJsonFrame(Buffer.from('{', 'utf8'))).toThrow(ParserProtocolError);
  });
});

describe('parser protocol envelopes', () => {
  it('validates the bounded ready message and exact supported-version values', () => {
    expect(
      validateReady({
        protocolVersion: PARSER_PROTOCOL_VERSION,
        kind: 'ready',
        parserVersion: '1.3.9',
        supportedVersions: ['0.8.37', '0.8.36'],
      }).supportedVersions,
    ).toEqual(['0.8.37', '0.8.36']);
    expect(() =>
      validateReady({
        protocolVersion: PARSER_PROTOCOL_VERSION,
        kind: 'ready',
        parserVersion: '1.3.9',
        supportedVersions: ['0.8.1', '0.8.1'],
      }),
    ).toThrow(ParserProtocolError);

    const maximumVersions = Array.from(
      { length: MAX_READY_VERSIONS },
      (_unused, index) => `0.0.${index}`,
    );
    expect(
      validateReady({
        protocolVersion: PARSER_PROTOCOL_VERSION,
        kind: 'ready',
        parserVersion: '1.3.9',
        supportedVersions: maximumVersions,
      }).supportedVersions,
    ).toHaveLength(MAX_READY_VERSIONS);
    expect(() =>
      validateReady({
        protocolVersion: PARSER_PROTOCOL_VERSION,
        kind: 'ready',
        parserVersion: '1.3.9',
        supportedVersions: [...maximumVersions, '1.0.0'],
      }),
    ).toThrow(ParserProtocolError);
  });

  it('enforces exact diagnostic count, code-unit, and UTF-8 byte ceilings', () => {
    const failure = (messages: readonly string[]) => ({
      status: 'failed',
      fileId,
      code: 'PARSE_INVALID',
      diagnostics: messages.map((message) => ({
        code: 'PARSE_INVALID',
        severity: 'error',
        phase: 'parse',
        message,
        fileId,
      })),
    });

    const exactCodeUnits = 'x'.repeat(MAX_DIAGNOSTIC_MESSAGE_CODE_UNITS);
    const exactByteBoundary = '€'.repeat(Math.floor(MAX_DIAGNOSTIC_MESSAGE_BYTES / 3));
    expect(Buffer.byteLength(exactByteBoundary, 'utf8')).toBe(1_023);
    expect(() => validateParseFileResult(failure([exactCodeUnits]), fileId)).not.toThrow();
    expect(() => validateParseFileResult(failure([exactByteBoundary]), fileId)).not.toThrow();
    expect(() =>
      validateParseFileResult(failure(['x'.repeat(MAX_DIAGNOSTIC_MESSAGE_CODE_UNITS + 1)]), fileId),
    ).toThrow(ParserProtocolError);
    expect(() => validateParseFileResult(failure(['€'.repeat(342)]), fileId)).toThrow(
      ParserProtocolError,
    );
    expect(() =>
      validateParseFileResult(failure(Array.from({ length: 256 }, () => 'x')), fileId),
    ).not.toThrow();
    expect(() =>
      validateParseFileResult(failure(Array.from({ length: 257 }, () => 'x')), fileId),
    ).toThrow(ParserProtocolError);
  });

  it('rejects wrong, duplicate, unknown-kind and unknown-key replies', () => {
    const reply = {
      protocolVersion: PARSER_PROTOCOL_VERSION,
      requestId: 2,
      kind: 'result',
      jobKind: 'parse-file',
      fileId,
      consumedNodes: 0,
      consumedImports: 0,
      result: {
        status: 'failed',
        fileId,
        code: 'PARSE_INVALID',
        diagnostics: [],
      },
    };
    expect(() => validateWorkerReply(reply, { requestId: 1, fileId })).toThrow(ParserProtocolError);
    expect(() =>
      validateWorkerReply({ ...reply, jobKind: 'semantic-component' }, { requestId: 2, fileId }),
    ).toThrow(ParserProtocolError);
    expect(() => validateWorkerReply({ ...reply, extra: true }, { requestId: 2, fileId })).toThrow(
      ParserProtocolError,
    );
    expect(() => validateParseFileResult({ ...reply.result, recovered: [] }, fileId)).toThrow(
      ParserProtocolError,
    );
    expect(MAX_RESPONSE_BYTES).toBe(32 * 1024 * 1024);
  });
});

const emptyRange = {
  startByte: 0,
  endByte: 4,
  start: { line: 1, column: 1 },
  end: { line: 1, column: 5 },
};
const otherId = FileIdSchema.parse('file:Other.sol');

function semanticRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: PARSER_PROTOCOL_VERSION,
    requestId: 3,
    kind: 'semantic-component',
    componentId: fileId,
    grammar: '0.8.37',
    maxFiles: 2,
    maxBytes: 1024,
    maxFileBytes: 512,
    maxAstNodesPerFile: 100,
    maxAstNodesRemaining: 200,
    maxRecords: 50,
    files: [
      {
        fileId,
        canonicalPath: 'Root.sol',
        originalText: 'contract Root {}',
        byteHash: 'a'.repeat(64),
      },
    ],
    imports: [
      {
        importerFileId: fileId,
        importId: 'decl:Root.sol:import:0:0',
        specifier: './Other.sol',
        specifierRange: emptyRange,
        targetFileId: otherId,
      },
    ],
    ...overrides,
  };
}

function semanticReply(result: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PARSER_PROTOCOL_VERSION,
    requestId: 3,
    kind: 'result',
    jobKind: 'semantic-component',
    componentId: fileId,
    consumedNodes: 5,
    result,
    ...overrides,
  };
}

const expectedReply = { requestId: 3, componentId: fileId, maxNodes: 10, maxRecords: 4 };
const shapeReply = { ...expectedReply, maxRecords: 100 };

describe('semantic component protocol', () => {
  it('uses protocol version 2 and keeps both request kinds distinct', () => {
    expect(PARSER_PROTOCOL_VERSION).toBe(2);
    expect(decodeSemanticRequest(semanticRequest()).kind).toBe('semantic-component');
    expect(() => decodeSemanticRequest({ ...semanticRequest(), kind: 'parse-file' })).toThrow(
      ParserProtocolError,
    );
    expect(() => decodeSemanticRequest(semanticRequest({ protocolVersion: 1 }))).toThrow(
      ParserProtocolError,
    );
    // The parse-file reply keeps its content and rejects the new job kind.
    const parseReply = {
      protocolVersion: PARSER_PROTOCOL_VERSION,
      requestId: 3,
      kind: 'result',
      jobKind: 'parse-file',
      fileId,
      consumedNodes: 0,
      consumedImports: 0,
      result: { status: 'failed', fileId, code: 'PARSE_INVALID', diagnostics: [] },
    };
    expect(validateWorkerReply(parseReply, { requestId: 3, fileId }).jobKind).toBe('parse-file');
    expect(() => validateSemanticReply(parseReply, expectedReply)).toThrow(ParserProtocolError);
  });

  it('derives an exact semantic frame ceiling and rejects overflow before decoding', () => {
    const sizes = { textBytes: 10, metadataCodeUnits: 3, files: 2, lookups: 1 };
    const expected =
      6 * 10 +
      6 * 3 +
      SEMANTIC_FILE_FRAME_OVERHEAD_BYTES * 2 +
      SEMANTIC_LOOKUP_FRAME_OVERHEAD_BYTES +
      REQUEST_FRAME_OVERHEAD_BYTES;
    expect(maxSemanticRequestFrameBytes(sizes)).toBe(expected);
    const request = semanticRequest();
    const exact = Buffer.byteLength(JSON.stringify(request), 'utf8');
    expect(encodeFrame(request, exact).readUInt32BE(0)).toBe(exact);
    expect(() => encodeFrame(request, exact - 1)).toThrow(ParserProtocolError);
    expect(
      maxSemanticRequestFrameBytes({
        textBytes: MAX_SEMANTIC_BYTES_CEILING,
        metadataCodeUnits: 0,
        files: 0,
        lookups: 0,
      }),
    ).toBeLessThanOrEqual(0xffff_ffff);
    expect(() =>
      maxSemanticRequestFrameBytes({
        textBytes: 0xffff_ffff,
        metadataCodeUnits: 0,
        files: 0,
        lookups: 0,
      }),
    ).toThrow(ParserProtocolError);
    expect(() =>
      maxSemanticRequestFrameBytes({ ...sizes, files: Number.MAX_SAFE_INTEGER }),
    ).toThrow(ParserProtocolError);
    expect(() => maxSemanticRequestFrameBytes({ ...sizes, lookups: -1 })).toThrow(TypeError);
  });

  it('rejects count-invalid and malformed components before any map is built', () => {
    expect(() => decodeSemanticRequest(semanticRequest({ extra: 1 }))).toThrow(ParserProtocolError);
    expect(() => decodeSemanticRequest(semanticRequest({ maxFiles: 0 }))).toThrow(
      ParserProtocolError,
    );
    expect(() =>
      decodeSemanticRequest(semanticRequest({ maxFiles: MAX_SEMANTIC_FILES_CEILING + 1 })),
    ).toThrow(ParserProtocolError);
    expect(() =>
      decodeSemanticRequest(semanticRequest({ maxBytes: MAX_SEMANTIC_BYTES_CEILING + 1 })),
    ).toThrow(ParserProtocolError);
    expect(() =>
      decodeSemanticRequest(semanticRequest({ maxRecords: MAX_SEMANTIC_RECORDS_CEILING + 1 })),
    ).toThrow(ParserProtocolError);
    expect(() =>
      decodeSemanticRequest(
        semanticRequest({
          files: [{ fileId, canonicalPath: 'Root.sol', originalText: '', byteHash: 'not-a-hash' }],
        }),
      ),
    ).toThrow(ParserProtocolError);
    const imports = Array.from({ length: MAX_SEMANTIC_LOOKUPS_CEILING + 1 }, () => ({}));
    expect(() => decodeSemanticRequest(semanticRequest({ imports }))).toThrow(ParserProtocolError);
    expect(() =>
      decodeSemanticRequest(
        semanticRequest({
          imports: [
            {
              importerFileId: fileId,
              importId: 'x',
              specifier: 's',
              specifierRange: { ...emptyRange, startByte: -1 },
              targetFileId: otherId,
            },
          ],
        }),
      ),
    ).toThrow(ParserProtocolError);
  });

  it('validates bound and unavailable replies with strict keys and bounded counters', () => {
    const user = { kind: 'user', fileId, nameRange: emptyRange, definiens: 'FunctionDefinition' };
    const bound = {
      status: 'bound',
      grammar: '0.8.37',
      baseSites: [
        { fileId, contractStartByte: 0, ordinal: 0, reference: emptyRange, definitions: [user] },
      ],
      callSites: [
        {
          fileId,
          range: emptyRange,
          callee: 'member',
          definitions: [{ kind: 'builtin' }],
          receiver: 'identifier',
          receiverDefinitions: [user],
        },
      ],
    };
    expect(validateSemanticReply(semanticReply(bound), shapeReply).consumedNodes).toBe(5);
    expect(
      validateSemanticReply(
        semanticReply({ status: 'unavailable', reason: 'binding-failed' }),
        shapeReply,
      ).result.status,
    ).toBe('unavailable');

    const bad = (result: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
      expect(() => validateSemanticReply(semanticReply(result, overrides), shapeReply)).toThrow(
        ParserProtocolError,
      );
    bad({ status: 'unavailable', reason: 'made-up' });
    bad({ ...bound, extra: [] });
    bad(bound, { consumedNodes: expectedReply.maxNodes + 1 });
    bad(bound, { requestId: 4 });
    bad(bound, { componentId: otherId });
    bad(bound, { jobKind: 'parse-file' });
    bad({ ...bound, baseSites: [{ ...bound.baseSites[0], ordinal: MAX_SEMANTIC_ORDINAL + 1 }] });
    bad({ ...bound, callSites: [{ ...bound.callSites[0], callee: 'call-expression' }] });
    bad({ ...bound, callSites: [{ ...bound.callSites[0], receiver: 'global' }] });
    bad({
      ...bound,
      callSites: [{ ...bound.callSites[0], definitions: [{ ...user, definiens: 'bad kind!' }] }],
    });
    bad({
      ...bound,
      callSites: [{ ...bound.callSites[0], definitions: [{ kind: 'builtin', fileId }] }],
    });
    bad({ ...bound, callSites: [{ ...bound.callSites[0], definitions: [{ ...user, extra: 1 }] }] });
  });

  it('bounds records and definitions per reference with exact and one-over cases', () => {
    const site = (definitions: readonly unknown[]) => ({
      fileId,
      range: emptyRange,
      callee: 'identifier',
      definitions,
      receiver: 'none',
      receiverDefinitions: [],
    });
    const builtins = (count: number) => Array.from({ length: count }, () => ({ kind: 'builtin' }));
    const bound = (callSites: readonly unknown[]) => ({
      status: 'bound',
      grammar: '0.8.37',
      baseSites: [],
      callSites,
    });
    const roomy = { ...expectedReply, maxRecords: 100_000 };
    expect(() =>
      validateSemanticReply(
        semanticReply(bound([site(builtins(MAX_SEMANTIC_DEFINITIONS_PER_REFERENCE))])),
        roomy,
      ),
    ).not.toThrow();
    expect(() =>
      validateSemanticReply(
        semanticReply(bound([site(builtins(MAX_SEMANTIC_DEFINITIONS_PER_REFERENCE + 1))])),
        roomy,
      ),
    ).toThrow(ParserProtocolError);
    // Four records are allowed: one site plus three definition references.
    expect(() =>
      validateSemanticReply(semanticReply(bound([site(builtins(3))])), expectedReply),
    ).not.toThrow();
    expect(() =>
      validateSemanticReply(semanticReply(bound([site(builtins(4))])), expectedReply),
    ).toThrow(ParserProtocolError);
    expect(() =>
      validateSemanticReply(
        semanticReply(bound(Array.from({ length: 5 }, () => site([])))),
        expectedReply,
      ),
    ).toThrow(ParserProtocolError);
  });
});
