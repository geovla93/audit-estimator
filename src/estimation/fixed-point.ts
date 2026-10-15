import { EstimationError } from './model.ts';

/** Exact rational with a positive denominator. BigInt never leaves the estimation modules. */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const MICRO = 1_000_000n;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

export function rational(numerator: bigint, denominator: bigint = 1n): Rational {
  if (denominator === 0n) throw new EstimationError('unsafe-arithmetic');
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);
  const scale = divisor === 0n ? 1n : divisor;
  return { numerator: (sign * numerator) / scale, denominator: (sign * denominator) / scale };
}

export const ZERO: Rational = { numerator: 0n, denominator: 1n };
export const ONE: Rational = { numerator: 1n, denominator: 1n };

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/;

/** Interprets the number's canonical decimal or scientific spelling exactly. */
export function fromDecimal(value: number): Rational {
  if (!Number.isFinite(value)) throw new EstimationError('invalid-input');
  const match = DECIMAL.exec(value.toString());
  if (match === null) throw new EstimationError('invalid-input');
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? '0') - fraction.length;
  if (Math.abs(exponent) > 400) throw new EstimationError('unsafe-arithmetic');
  const digits = BigInt(`${match[2] ?? '0'}${fraction}`) * (match[1] === '-' ? -1n : 1n);
  return exponent >= 0
    ? rational(digits * 10n ** BigInt(exponent))
    : rational(digits, 10n ** BigInt(-exponent));
}

export function fromCount(value: number): Rational {
  if (!Number.isSafeInteger(value) || value < 0) throw new EstimationError('invalid-input');
  return rational(BigInt(value));
}

export function multiply(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

export function compare(left: Rational, right: Rational): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function minimum(left: Rational, right: Rational): Rational {
  return compare(left, right) <= 0 ? left : right;
}

export function floorDivide(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return numerator % denominator !== 0n && numerator < 0n !== denominator < 0n
    ? quotient - 1n
    : quotient;
}

export function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return -floorDivide(-numerator, denominator);
}

/** floor(value * 1e6): hours to microhours. */
export function floorMicro(value: Rational): bigint {
  return floorDivide(value.numerator * MICRO, value.denominator);
}

/** ceil(value * 1e6): hours to microhours. */
export function ceilMicro(value: Rational): bigint {
  return ceilDivide(value.numerator * MICRO, value.denominator);
}

/** ceil(integer * value) for an integer and a rational. */
export function ceilScaled(integer: bigint, value: Rational): bigint {
  return ceilDivide(integer * value.numerator, value.denominator);
}

export function toSafeNumber(value: bigint): number {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > limit || value < -limit) throw new EstimationError('unsafe-arithmetic');
  return Number(value);
}
