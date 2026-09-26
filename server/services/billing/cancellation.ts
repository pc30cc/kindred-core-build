// ============================================================
// CANCEL AT PERIOD END — the customer keeps what they paid for.
//
// Cancelling a subscription is a request to stop RENEWING it, not to take
// away the remainder of a period that has already been paid. So:
//
//   * a cancel request while the period is still running only marks the
//     subscription `cancel_at_period_end` (+ `canceled_at`); the status stays
//     `active` / `trialing` and every entitlement check keeps passing;
//   * the billing tick (`expireCanceledSubscriptions`) moves the row to
//     `canceled` once `current_period_end` has passed — that is the moment
//     access actually ends;
//   * `resume` is only possible while that paid period is still running.
//
// The pure helpers below are what the V1 route and the provider webhook use,
// so both paths make the same decision.
// ============================================================

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { handleWorkspaceEntitlementChanged } from './entitlementChange.js';

export interface CancelableSubscription {
  status?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean | null;
}

/** Statuses that still hold a paid (or trial) period worth preserving. */
const LIVE_STATUSES = ['active', 'trialing', 'past_due'] as const;

function periodEndMs(sub: CancelableSubscription | null | undefined): number {
  const raw = sub?.current_period_end;
  if (!raw) return Number.NaN;
  return new Date(raw).getTime();
}

/** True while the paid window has not ended yet. */
export function periodStillRunning(sub: CancelableSubscription | null | undefined, now: Date = new Date()): boolean {
  const end = periodEndMs(sub);
  return Number.isFinite(end) && end > now.getTime();
}

/**
 * The row update for "cancel at the end of the current period".
 *
 * Keeps the status untouched while the paid window is running; only when
 * there is no remaining window (already ended, or unknown) does the
 * subscription become `canceled` immediately.
 */
export function buildCancelAtPeriodEndPatch(
  sub: CancelableSubscription | null | undefined,
  now: Date = new Date(),
): Record<string, unknown> {
  const at = now.toISOString();
  const patch: Record<string, unknown> = {
    cancel_at_period_end: true,
    canceled_at: at,
    updated_at: at,
  };
  if (!periodStillRunning(sub, now)) patch.status = 'canceled';
  return patch;
}

export type ResumeDecision =
  | { ok: true; patch: Record<string, unknown>; statusChanged: boolean }
  | { ok: false; code: 'SUBSCRIPTION_PERIOD_ENDED' | 'SUBSCRIPTION_NOT_RESUMABLE'; message: string };

/**
 * Whether a cancel-at-period-end subscription can be resumed, and how.
 *
 * Resuming is only meaningful while the paid period is still running: once it
 * has ended there is nothing to resume and the customer must start a new
 * subscription (which is paid for). A row that an older build marked
 * `canceled` together with `cancel_at_period_end` while its period was still
 * running is restored to `active`; any other status is kept as it is.
 */
export function decideResume(
  sub: CancelableSubscription | null | undefined,
  now: Date = new Date(),
): ResumeDecision {
  if (!periodStillRunning(sub, now)) {
    return {
      ok: false,
      code: 'SUBSCRIPTION_PERIOD_ENDED',
      message: 'The subscription period has already ended; start a new subscription instead',
    };
  }
  const status = String(sub?.status ?? '');
  const scheduledCancel = sub?.cancel_at_period_end === true;
  let nextStatus: string;
  if ((LIVE_STATUSES as readonly string[]).includes(status)) {
    nextStatus = status;
  } else if (status === 'canceled' && scheduledCancel) {
    nextStatus = 'active';
  } else {
    return {
      ok: false,
      code: 'SUBSCRIPTION_NOT_RESUMABLE',
      message: `Subscription in status "${status || 'unknown'}" cannot be resumed`,
    };
  }
  const at = now.toISOString();
  return {
    ok: true,
    patch: { status: nextStatus, cancel_at_period_end: false, canceled_at: null, updated_at: at },
    statusChanged: nextStatus !== status,
  };
}

/**
 * Ends every subscription whose cancellation was scheduled for the end of a
 * period that has now passed. Idempotent: a row is only matched while it is
 * still live, so a re-run is a no-op. Run from the billing tick.
 */
export async function expireCanceledSubscriptions(
  config: ServerConfig,
  now: Date = new Date(),
): Promise<{ expired: number }> {
  const sb = getServiceClient(config);
  const at = now.toISOString();
  const { data, error } = await sb
    .from('workspace_subscriptions')
    .update({ status: 'canceled', updated_at: at })
    .eq('cancel_at_period_end', true)
    .in('status', [...LIVE_STATUSES])
    .lte('current_period_end', at)
    .select('workspace_id');
  if (error) throw new Error(`cancel-at-period-end expiry failed: ${error.message}`);

  const rows = (data ?? []) as Array<{ workspace_id: string }>;
  for (const row of rows) {
    await handleWorkspaceEntitlementChanged(config, {
      workspaceId: row.workspace_id,
      source: 'subscription_canceled',
    });
  }
  return { expired: rows.length };
}
