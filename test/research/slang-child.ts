import { createInterface } from 'node:readline';
import { CompilationBuilder } from '@nomicfoundation/slang/compilation';
import { TerminalKind } from '@nomicfoundation/slang/cst';
import { Parser } from '@nomicfoundation/slang/parser';

type ChildRequest =
  | {
      readonly action: 'parse';
      readonly id: number;
      readonly source: string;
      readonly version: string;
    }
  | {
      readonly action: 'serialize';
      readonly id: number;
      readonly source: string;
      readonly version: string;
    }
  | {
      readonly action: 'measure';
      readonly id: number;
      readonly declarations: number;
      readonly iterations: number;
    }
  | {
      readonly action: 'binding';
      readonly id: number;
      readonly root: string;
      readonly dependency: string;
    }
  | { readonly action: 'stall'; readonly id: number };

const lineReader = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lineReader) {
  try {
    const request = decodeRequest(line);
    if (request.action === 'stall') {
      await writeResult({ id: request.id, stalled: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0);
    }
    const result = await handleRequest(request);
    await writeResult(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown child error';
    await writeResult({ error: message });
  }
}

function decodeRequest(line: string): ChildRequest {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed) || typeof parsed.action !== 'string' || typeof parsed.id !== 'number') {
    throw new Error('Invalid child request envelope.');
  }
  const { action, id } = parsed;
  if (action === 'parse' || action === 'serialize') {
    return {
      action,
      id,
      source: stringField(parsed, 'source'),
      version: stringField(parsed, 'version'),
    };
  }
  if (action === 'measure') {
    return {
      action,
      id,
      declarations: numberField(parsed, 'declarations'),
      iterations: numberField(parsed, 'iterations'),
    };
  }
  if (action === 'binding') {
    return {
      action,
      id,
      root: stringField(parsed, 'root'),
      dependency: stringField(parsed, 'dependency'),
    };
  }
  if (action === 'stall') return { action, id };
  throw new Error(`Unsupported child request action: ${action}`);
}

async function handleRequest(request: ChildRequest): Promise<unknown> {
  if (request.action === 'parse') {
    const output = Parser.create(request.version).parseFileContents(request.source);
    return {
      id: request.id,
      valid: output.isValid(),
      diagnostics: output
        .errors()
        .map((error) => ({ message: error.message, range: error.textRange })),
      unparse: output.tree.unparse(),
    };
  }

  if (request.action === 'serialize') {
    const parser = Parser.create(request.version);
    const output = parser.parseFileContents(request.source);
    const serialized = JSON.stringify({ parser, output });
    if (serialized === undefined)
      throw new Error('Slang parser objects did not serialize to JSON.');
    const rehydrated: unknown = JSON.parse(serialized);
    const rehydratedRecord = asRecord(rehydrated);
    const rehydratedOutput = asRecord(rehydratedRecord.output);
    let structuredCloneResult: string;
    try {
      const clone: unknown = structuredClone(output);
      structuredCloneResult = isRecord(clone) ? 'plain-object' : typeof clone;
    } catch (error: unknown) {
      structuredCloneResult = error instanceof Error ? `throws:${error.name}` : 'throws:unknown';
    }
    return {
      id: request.id,
      jsonBytes: Buffer.byteLength(serialized, 'utf8'),
      serializedOutputHasIsValid: typeof rehydratedOutput.isValid === 'function',
      structuredCloneResult,
    };
  }

  if (request.action === 'measure') {
    const declarations = Array.from(
      { length: request.declarations },
      (_unused, index) => `    uint value${index};`,
    ).join('\n');
    const source = `pragma solidity 0.8.37;\ncontract Synthetic {\n${declarations}\n}\n`;
    const before = process.memoryUsage();
    const start = performance.now();
    let errors = 0;
    for (let iteration = 0; iteration < request.iterations; iteration += 1) {
      errors += Parser.create('0.8.37').parseFileContents(source).errors().length;
    }
    const elapsedMs = performance.now() - start;
    const after = process.memoryUsage();
    return {
      id: request.id,
      advisory: true,
      declarations: request.declarations,
      iterations: request.iterations,
      sourceBytes: Buffer.byteLength(source, 'utf8'),
      elapsedMs,
      errors,
      heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
      rssDeltaBytes: after.rss - before.rss,
      arrayBuffersDeltaBytes: after.arrayBuffers - before.arrayBuffers,
    };
  }

  if (request.action === 'binding') {
    const rootId = '/trusted/root.sol';
    const dependencyId = '/trusted/dependency.sol';
    const sources = new Map([
      [rootId, request.root],
      [dependencyId, request.dependency],
    ]);
    const builder = CompilationBuilder.create({
      languageVersion: '0.8.37',
      readFile: async (fileId) => sources.get(fileId),
      resolveImport: async (_sourceFileId, importPath) =>
        importPath.node.unparse() === '"./dependency.sol"' ? dependencyId : undefined,
    });
    await builder.addFile(rootId);
    const unit = builder.build();
    const fileDiagnostics = unit.files().map((file) => ({
      id: file.id,
      messages: file.errors().map((error) => error.message),
    }));
    const rootFile = unit.file(rootId);
    if (rootFile === undefined) throw new Error('The trusted root fixture was not loaded.');
    const cursor = rootFile.createTreeCursor();
    let hasNext = true;
    let missingTarget = false;
    let targetOffset: number | undefined;
    const graph = unit.bindingGraph;
    while (hasNext) {
      const node = cursor.node;
      if (
        node.isTerminalNode() &&
        node.kind === TerminalKind.Identifier &&
        node.unparse() === 'Broken'
      ) {
        const reference = graph.referenceAt(cursor);
        targetOffset = cursor.textRange.start.utf8;
        missingTarget = reference === undefined || reference.definitions().length === 0;
        break;
      }
      hasNext = cursor.goToNext();
    }
    return {
      id: request.id,
      files: unit.files().map((file) => file.id),
      fileDiagnostics,
      targetOffset,
      unresolvedBrokenReference: missingTarget,
      graphAccess: 'completed',
    };
  }

  return { id: request.id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected a JSON object.');
  return value;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Expected string field ${key}.`);
  return value;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Expected nonnegative integer field ${key}.`);
  }
  return value;
}

async function writeResult(result: unknown): Promise<void> {
  const line = `${JSON.stringify(result)}\n`;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(line, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
