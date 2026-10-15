import { createHash } from 'node:crypto';
import { CallableIdSchema, ContractIdSchema, EdgeIdSchema, FileIdSchema } from './schemas.ts';
import type { CallableId, ContractId, EdgeId, FileId } from './types.ts';

function codePointCompare(left: string, right: string): number {
  const a = Array.from(left, (scalar) => scalar.codePointAt(0) ?? 0);
  const b = Array.from(right, (scalar) => scalar.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const leftPoint = a[index] ?? 0;
    const rightPoint = b[index] ?? 0;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/** Rejects aliases and native absolute paths; the discovery layer resolves physical files. */
export function normalizeProjectPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes('\0')
  ) {
    throw new Error('Expected a project-relative path');
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Path contains an empty or traversal segment');
  }
  return normalized;
}

export function fileIdentity(canonicalPath: string): FileId {
  return FileIdSchema.parse(`file:${normalizeProjectPath(canonicalPath)}`);
}

export function declarationIdentity(
  canonicalPath: string,
  kind: string,
  startByte: number,
): string {
  if (!Number.isSafeInteger(startByte) || startByte < 0 || !/^[a-z][a-z-]*$/.test(kind)) {
    throw new Error('Invalid declaration identity input');
  }
  return `decl:${normalizeProjectPath(canonicalPath)}:${kind}:${startByte}`;
}

export function edgeIdentity(
  canonicalPath: string,
  kind: string,
  startByte: number,
  ordinal: number,
): EdgeId {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error('Invalid edge ordinal');
  }
  return EdgeIdSchema.parse(`${declarationIdentity(canonicalPath, kind, startByte)}:${ordinal}`);
}

export function contractIdentity(
  canonicalPath: string,
  kind: string,
  startByte: number,
): ContractId {
  return ContractIdSchema.parse(declarationIdentity(canonicalPath, kind, startByte));
}

export function callableIdentity(
  canonicalPath: string,
  kind: string,
  startByte: number,
): CallableId {
  return CallableIdSchema.parse(declarationIdentity(canonicalPath, kind, startByte));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite canonical number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new Error('Sparse canonical array');
    }
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Non-plain canonical object');
    }
    const entries = Object.entries(value).sort(([a], [b]) => codePointCompare(a, b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  throw new Error('Non-JSON canonical value');
}

/** Length framing prevents ambiguous concatenations across source and config components. */
export function fingerprint(parts: readonly (string | Uint8Array)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

/** Only explicit ID-bearing collections get stable ordering. Ledger order remains meaningful. */
export function sortById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => codePointCompare(a.id, b.id));
}
