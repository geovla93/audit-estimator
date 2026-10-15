import type { EstimateInput, StateVariables } from '../domain/types.ts';
import { ONE, ZERO, fromCount, minimum, rational } from './fixed-point.ts';
import type { Rational } from './fixed-point.ts';
import { EstimationError } from './model.ts';

export type Channel =
  | { readonly status: 'measured'; readonly factor: Rational }
  | { readonly status: 'unavailable' };

export interface FileFacts {
  readonly fileId: string;
  readonly sourceLines: bigint;
  readonly control: Channel;
  readonly storage: Channel;
  readonly evm: Channel;
  /** True when this file's own unavailable measurements require the high reserve. */
  readonly unknown: boolean;
}

type EligibleFile = EstimateInput['eligibleFiles'][number];

/** Returns the coverage label, or null when no estimate is eligible. Inputs are schema-valid. */
export function eligibleCoverage(input: EstimateInput): 'full' | 'analyzed-subset' | null {
  if (!input.requiredAnalysisComplete && !input.allowPartial) return null;
  if (input.eligibleFiles.length === 0) return null;
  let positive = false;
  for (const file of input.eligibleFiles) {
    if (file.sourceLines.status !== 'measured') return null;
    if (file.sourceLines.value > 0) positive = true;
  }
  if (!positive) return null;
  return input.requiredAnalysisComplete ? 'full' : 'analyzed-subset';
}

function inconsistent(): never {
  throw new EstimationError('inconsistent-measurements');
}

const COMPLEX_SHAPES: ReadonlySet<string> = new Set(['mapping', 'array', 'struct']);
const UNCLASSIFIABLE_SHAPES: ReadonlySet<string> = new Set(['user-defined', 'unknown']);

function storageChannel(state: StateVariables): { channel: Channel; unknown: boolean } {
  const total = state.count.status === 'measured' ? state.count.value : null;
  const mutable = state.mutableCount.status === 'measured' ? state.mutableCount.value : null;
  const shapes = state.typeShapes.status === 'measured' ? state.typeShapes.value : null;
  const complex =
    state.complexMutableDeclarationIds.status === 'measured'
      ? state.complexMutableDeclarationIds.value
      : null;

  if (total !== null && mutable !== null && mutable > total) inconsistent();
  if (shapes !== null) {
    const byId = new Map<string, (typeof shapes)[number]>();
    for (const shape of shapes) {
      if (byId.has(shape.declarationId)) inconsistent();
      byId.set(shape.declarationId, shape);
    }
    if (total !== null && shapes.length !== total) inconsistent();
    const mutableShapes = shapes.filter((shape) => shape.mutable);
    if (mutable !== null && mutableShapes.length !== mutable) inconsistent();
    if (complex !== null) {
      for (const id of complex) {
        const shape = byId.get(id);
        if (shape === undefined || !shape.mutable || shape.shape === 'elementary') inconsistent();
      }
    }
  }
  if (complex !== null) {
    if (new Set(complex).size !== complex.length) inconsistent();
    if (mutable !== null && complex.length > mutable) inconsistent();
  }
  const classifiable =
    shapes !== null &&
    !shapes.some((shape) => shape.mutable && UNCLASSIFIABLE_SHAPES.has(shape.shape));
  if (shapes !== null && complex !== null && classifiable) {
    const expected = new Set(
      shapes
        .filter((shape) => shape.mutable && COMPLEX_SHAPES.has(shape.shape))
        .map((shape) => shape.declarationId),
    );
    if (expected.size !== complex.length || complex.some((id) => !expected.has(id))) {
      inconsistent();
    }
  }

  if (mutable === 0) return { channel: { status: 'measured', factor: ZERO }, unknown: false };
  if (mutable === null || shapes === null || complex === null || !classifiable) {
    return { channel: { status: 'unavailable' }, unknown: true };
  }
  return {
    channel: {
      status: 'measured',
      factor: minimum(ONE, rational(BigInt(complex.length), BigInt(mutable))),
    },
    unknown: false,
  };
}

function controlChannel(file: EligibleFile, lines: bigint): Channel {
  if (file.decisions.status !== 'measured') return { status: 'unavailable' };
  const decisions = fromCount(file.decisions.value);
  const density = lines <= 10n ? decisions : rational(decisions.numerator * 10n, lines);
  return { status: 'measured', factor: minimum(ONE, density) };
}

function evmChannel(file: EligibleFile): Channel {
  const assembly = file.assemblyBlocks;
  const calls = file.confirmedBuiltinLowLevelCalls;
  if (assembly.status !== 'measured') return { status: 'unavailable' };
  if (assembly.value > 0) return { status: 'measured', factor: ONE };
  if (calls.status !== 'measured') return { status: 'unavailable' };
  return { status: 'measured', factor: calls.value > 0 ? rational(1n, 2n) : ZERO };
}

/** Validates measured storage facts and derives each file's channels. Throws on contradictions. */
export function classifyFile(file: EligibleFile): FileFacts {
  if (file.sourceLines.status !== 'measured') throw new EstimationError('invalid-input');
  const lines = BigInt(file.sourceLines.value);
  const storage = storageChannel(file.stateVariables);
  const control = controlChannel(file, lines);
  const evm = evmChannel(file);
  const unknown =
    storage.unknown ||
    file.decisions.status !== 'measured' ||
    file.assemblyBlocks.status !== 'measured' ||
    file.confirmedBuiltinLowLevelCalls.status !== 'measured';
  return {
    fileId: file.fileId,
    sourceLines: lines,
    control,
    storage: storage.channel,
    evm,
    unknown,
  };
}
