import { describe, expect, it } from 'vitest';
import { FileIdSchema } from '../../src/domain/schemas.ts';
import {
  FrameDecoder,
  MAX_RESPONSE_BYTES,
  MAX_READY_VERSIONS,
  MAX_DIAGNOSTIC_MESSAGE_CODE_UNITS,
  MAX_DIAGNOSTIC_MESSAGE_BYTES,
  PARSER_PROTOCOL_VERSION,
  ParserProtocolError,
  decodeJsonFrame,
  encodeFrame,
  maxRequestFrameBytes,
  validateParseFileResult,
  validateReady,
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
