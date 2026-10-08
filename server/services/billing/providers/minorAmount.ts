/**
 * Unit contract for the non-Iranian card gateways: `req.metadata.amount` is the
 * plan price exactly as `billing_plans.prices` stores it, in MINOR units
 * (cents / kuruş, 2900 = 29.00). It is the same unit these providers use for
 * refunds (`amount / 100`) and report back from webhooks (`paidPrice * 100`).
 * Gateways whose API takes a decimal major amount convert here, once.
 */

/** A minor-unit amount as a two-decimal major-unit string: '14990' → '149.90'. Missing or invalid → '0'. */
export function minorToMajorString(raw: string | number | null | undefined): string {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0';
  return (Math.round(n) / 100).toFixed(2);
}

/**
 * A decimal major-unit amount a provider reports ('149.90', 19.99) as integer
 * minor units (14990, 1999). Rounded, never truncated: `19.99 * 100` is
 * 1998.9999… in floating point. Missing, negative or unreadable → undefined.
 */
export function majorToMinor(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
}

/**
 * An amount a provider already reports in minor units, as a string ('2900',
 * Paddle) or a number (2900, Stripe / Lemon Squeezy). Anything that is not a
 * non-negative integer → undefined.
 */
export function minorFromProvider(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return undefined;
  return n;
}

/** Upper-case ISO 4217 code, or undefined for anything that is not a 3-letter code. */
export function normalizeCurrencyCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

/**
 * The currency a gateway is asked to charge. Throws instead of relabelling:
 * an amount priced in one currency must never be sent under another code.
 */
export function requireSupportedCurrency(
  provider: string,
  requested: string,
  supported: readonly string[],
): string {
  const code = normalizeCurrencyCode(requested);
  if (!code || !supported.includes(code)) {
    throw new Error(`${provider} cannot charge ${code || 'this currency'}`);
  }
  return code;
}
