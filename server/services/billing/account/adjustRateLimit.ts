// ============================================================================
// SIMPLE BILLING — the Super Admin credit/debit rate limit
// (docs/billing/SIMPLE_BILLING.md, phase 6 "Credit and debit").
//
// At most ADJUST_RATE_LIMIT.max changes per admin per window, counted from the
// database, so every backend process sees the same count: the admin's own
// `admin_credit` / `admin_debit` ledger rows (actor_id) of the last window.
// A refused attempt (409, 400) books no row and so does not count. A replay
// of a command key that already booked a row is not a new change: it goes
// through at the limit too (the SQL answers it with the first row).
//
// This read is the fast answer (and lets a replay through at the limit).
// The limit itself is enforced where the row is booked:
// billing_account_admin_adjust (migration 270) takes a per-admin lock,
// counts again and refuses the change past the limit
// (`billing_adjust_rate_limited`, mapped to 429 TOO_MANY_ADJUSTMENTS by
// adminReports.ts), so requests sent at the same time, each for another
// workspace, cannot get past it either. Keep max and window in step with 270.
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { ADJUST_RATE_LIMIT } from '../../../../shared/simpleBillingAdmin.js';

/** The ledger kinds a Super Admin change books (billing_account_admin_adjust, migration 266). */
export const ADMIN_ADJUST_KINDS = ['admin_credit', 'admin_debit'] as const;

/** The idempotency key billing_account_admin_adjust stores for a command key. */
export function adminAdjustLedgerKey(commandKey: string): string {
  return `admin:${commandKey}`;
}

/** How many changes `adminId` booked since `now - windowMs`. Throws when the database cannot answer (the route then fails closed). */
export async function countRecentAdminAdjusts(config: ServerConfig, adminId: string, now = Date.now()): Promise<number> {
  const since = new Date(now - ADJUST_RATE_LIMIT.windowMs).toISOString();
  const { count, error } = await getServiceClient(config)
    .from('billing_account_ledger')
    .select('id', { count: 'exact', head: true })
    .eq('actor_id', adminId)
    .in('kind', [...ADMIN_ADJUST_KINDS])
    .gte('created_at', since);
  if (error) throw new Error(`adjust rate count failed: ${error.message}`);
  return count ?? 0;
}

/** Whether the command key already booked a ledger row (so the call can only replay it, or be refused as KEY_REUSED). */
export async function adminAdjustKeyBooked(config: ServerConfig, commandKey: string): Promise<boolean> {
  const { data, error } = await getServiceClient(config)
    .from('billing_account_ledger')
    .select('id')
    .eq('idempotency_key', adminAdjustLedgerKey(commandKey))
    .maybeSingle();
  if (error) throw new Error(`adjust key lookup failed: ${error.message}`);
  return Boolean(data);
}

/**
 * Whether `adminId` may make the change with `commandKey` now: under the
 * limit, or a replay of a key that already booked (never a new change).
 */
export async function adjustAllowed(config: ServerConfig, adminId: string, commandKey: string, now = Date.now()): Promise<boolean> {
  if ((await countRecentAdminAdjusts(config, adminId, now)) < ADJUST_RATE_LIMIT.max) return true;
  return adminAdjustKeyBooked(config, commandKey);
}
