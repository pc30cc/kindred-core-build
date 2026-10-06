/**
 * Fixed-point decimal helpers for the AI billing financial path.
 *
 * Money NEVER round-trips through a JS float. Every amount is carried as a
 * decimal string and internally as a BigInt scaled by 10^SCALE. Rounding to a
 * presentation unit (تومان) happens only in the UI formatter, never here.
 */

export const SCALE = 12;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

export type Dec = bigint;

const PLAIN = /^-?\d*(\.\d*)?$/;
const EXPONENT = /^(-?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/;
// A double's decimal exponent stays within ±324; this only bounds the string
// built below for input that did not come from a number.
const MAX_EXPONENT = 400;

/**
 * Database numerics reach the server as JSON numbers, and String() prints a
 * number below 1e-6 (or from 1e21) in exponent notation: 0.000000880000
 * arrives as "8.8e-7". Rewrite that as the same digits in plain notation,
 * moving the decimal point in the string (no float arithmetic), so it adds no
 * rounding of its own. Returns null for anything else.
 */
function expandExponent(s: string): string | null {
  const m = EXPONENT.exec(s);
  if (!m) return null;
  const [, sign, intPart, frac = '', expRaw] = m;
  const exp = Number(expRaw);
  if (Math.abs(exp) > MAX_EXPONENT) return null;
  const digits = intPart + frac;
  const point = intPart.length + exp;
  let plain: string;
  if (point <= 0) plain = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) plain = digits + '0'.repeat(point - digits.length);
  else plain = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return sign + plain;
}

export function fromString(value: string | number | null | undefined): Dec {
  if (value === null || value === undefined || value === '') return 0n;
  let s = String(value).trim();
  if (!PLAIN.test(s)) {
    const plain = expandExponent(s);
    if (plain === null) throw new Error(`invalid_decimal:${s}`);
    s = plain;
  }
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [intPart = '0', fracRaw = ''] = body.split('.');
  const frac = (fracRaw + '0'.repeat(SCALE)).slice(0, SCALE);
  const v = BigInt(intPart || '0') * SCALE_FACTOR + BigInt(frac || '0');
  return neg ? -v : v;
}

export function toString(value: Dec): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const int = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

export function add(a: Dec, b: Dec): Dec {
  return a + b;
}

export function sub(a: Dec, b: Dec): Dec {
  return a - b;
}

export function mul(a: Dec, b: Dec): Dec {
  return (a * b) / SCALE_FACTOR;
}

export function div(a: Dec, b: Dec): Dec {
  if (b === 0n) throw new Error('division_by_zero');
  return (a * SCALE_FACTOR) / b;
}

export function max(a: Dec, b: Dec): Dec {
  return a > b ? a : b;
}

export function isZero(a: Dec): boolean {
  return a === 0n;
}

/** Round HALF-UP to `places` decimals. Presentation only. */
export function round(value: Dec, places: number): Dec {
  if (places >= SCALE) return value;
  const factor = 10n ** BigInt(SCALE - places);
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const rounded = ((abs + factor / 2n) / factor) * factor;
  return neg ? -rounded : rounded;
}

/** Ledger storage precision is NUMERIC(24,6). */
export function toStoredIrr(value: Dec): string {
  return toString(round(value, 6));
}
