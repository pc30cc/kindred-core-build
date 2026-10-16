/**
 * Plan values every surface reads the same way (server, browser, reports).
 * Pure: no I/O.
 *
 * Storage is counted in megabytes: the plan limit is `limits.storage_mb`
 * (-1 = unlimited). Plans written before migration 271 carry `storage_gb`
 * instead; until a plan is saved again (the plan editor then writes only
 * `storage_mb`), `storage_gb × 1024` stands in for a missing `storage_mb`.
 * Workspace overrides follow the same rule.
 *
 * The monthly AI credit of a plan is `ai_allowance.IRR`, in the AI wallet's
 * unit (Rial), as `billing_plan_ai_allowance` (migration 261) reads it: a
 * workspace override of `included_ai_allowance_irr` first (SQL only), then
 * `ai_allowance.IRR`, then the older `limits.included_ai_allowance_irr` and
 * `limits.ai_credits_per_month`. Migration 271 writes `ai_allowance.IRR` on
 * every plan, so the fallbacks only matter for a plan saved by older code.
 */

/** The canonical storage limit key (megabytes). */
export const STORAGE_LIMIT_KEY = 'storage_mb';
/** The storage limit key before migration 271 (gigabytes). */
export const LEGACY_STORAGE_LIMIT_KEY = 'storage_gb';
/** Megabytes in one gigabyte of the old key. */
export const MB_PER_GB = 1024;
/** Bytes in one megabyte (the usage counter counts bytes). */
export const BYTES_PER_MB = 1024 * 1024;

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** A gigabyte limit in megabytes (negative stays -1: unlimited). */
export function gbToMb(gb: number): number {
  return gb < 0 ? -1 : Math.round(gb * MB_PER_GB);
}

/**
 * The storage limit in MB a limits object names: `storage_mb`, else
 * `storage_gb × 1024`; null when it names neither.
 */
export function storageLimitMb(limits: Record<string, unknown> | null | undefined): number | null {
  const mb = finite(limits?.[STORAGE_LIMIT_KEY]);
  if (mb !== null) return mb < 0 ? -1 : mb;
  const gb = finite(limits?.[LEGACY_STORAGE_LIMIT_KEY]);
  return gb === null ? null : gbToMb(gb);
}

/**
 * The same limits with `storage_mb` filled in from `storage_gb` when only the
 * old key is there. Never changes a `storage_mb` that is set; returns the
 * input itself when there is nothing to add.
 */
export function withStorageMb<T extends Record<string, unknown>>(limits: T | null | undefined): T {
  const base = (limits ?? {}) as T;
  if (finite(base[STORAGE_LIMIT_KEY]) !== null) return base;
  const mb = storageLimitMb(base);
  return mb === null ? base : ({ ...base, [STORAGE_LIMIT_KEY]: mb } as T);
}

/**
 * The same limits with `storage_gb` (storage_mb / 1024; -1 stays unlimited)
 * added where only `storage_mb` is there: for public readers outside this
 * repository that still read GB. Never stored.
 */
export function withLegacyStorageGb<T extends Record<string, unknown>>(limits: T | null | undefined): T {
  const base = (limits ?? {}) as T;
  if (finite(base[LEGACY_STORAGE_LIMIT_KEY]) !== null) return base;
  const mb = finite(base[STORAGE_LIMIT_KEY]);
  if (mb === null) return base;
  return { ...base, [LEGACY_STORAGE_LIMIT_KEY]: mb < 0 ? -1 : mb / MB_PER_GB } as T;
}

/**
 * A plan's limits as the plan editor saves them: `storage_mb` only. A body
 * that still sends `storage_gb` alone (a page built before 271) has it
 * converted; once `storage_mb` is there the old key is dropped.
 */
export function storageLimitsForSave(limits: Record<string, unknown>): Record<string, unknown> {
  const out = withStorageMb(limits);
  if (finite(out[STORAGE_LIMIT_KEY]) === null) return out;
  const { [LEGACY_STORAGE_LIMIT_KEY]: _dropped, ...rest } = out;
  return rest;
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
