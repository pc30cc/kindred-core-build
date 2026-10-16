/**
 * Plan values every surface reads the same way (server, browser, reports).
 * Pure: no I/O.
 *
 * Storage is counted in megabytes: the plan limit (and its workspace
 * override) is `limits.storage_mb` (-1 = unlimited, 0 = no file storage).
 * Migration 272 removed the gigabyte key that came before it.
 *
 * The monthly AI credit of a plan is `ai_allowance.IRR`, in the AI wallet's
 * unit (Rial), as `billing_plan_ai_allowance` (migration 261) reads it: a
 * workspace override of `included_ai_allowance_irr` first (SQL only), then
 * `ai_allowance.IRR`, then the older `limits.included_ai_allowance_irr` and
 * `limits.ai_credits_per_month`. Migration 271 writes `ai_allowance.IRR` on
 * every plan, so the fallbacks only matter for a plan saved by older code.
 */

/** The storage limit key (megabytes). */
export const STORAGE_LIMIT_KEY = 'storage_mb';
/** Megabytes in one gigabyte (for compatibility values computed from MB). */
export const MB_PER_GB = 1024;
/** Bytes in one megabyte (the usage counter counts bytes). */
export const BYTES_PER_MB = 1024 * 1024;

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** The storage limit in MB a limits object names (-1 = unlimited); null when it names none. */
export function storageLimitMb(limits: Record<string, unknown> | null | undefined): number | null {
  const mb = finite(limits?.[STORAGE_LIMIT_KEY]);
  return mb === null ? null : mb < 0 ? -1 : mb;
}

/** A limit in MB as gigabytes (-1 stays unlimited), for readers outside this repository that read GB. */
export function mbToGb(mb: number): number {
  return mb < 0 ? -1 : mb / MB_PER_GB;
}

/** Bytes in megabytes (fractional; 0 for nothing or an unreadable value). */
export function bytesToMb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return bytes / BYTES_PER_MB;
}

/** The AI wallet's unit: monthly AI credit and every lot count in it. */
export const AI_WALLET_UNIT = 'IRR';

/**
 * A plan's monthly AI credit in the AI wallet's unit, as
 * billing_plan_ai_allowance reads it without a workspace override. Never
 * negative; 0 when the plan names none.
 */
export function planAiAllowance(plan: {
  ai_allowance?: Record<string, unknown> | null;
  limits?: Record<string, unknown> | null;
} | null | undefined): number {
  const value =
    finite(plan?.ai_allowance?.[AI_WALLET_UNIT])
    ?? finite(plan?.limits?.included_ai_allowance_irr)
    ?? finite(plan?.limits?.ai_credits_per_month)
    ?? 0;
  return Math.max(value, 0);
}
