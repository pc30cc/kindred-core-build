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
