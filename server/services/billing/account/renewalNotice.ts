// ============================================================================
// SIMPLE BILLING — the renewal notice (docs/billing/SIMPLE_BILLING.md,
// "Renewal"): a paid period that will not renew moves the workspace to Free
// at the due moment, with no grace, so from 7 days before it the panel shows
// a banner and the alerts bell warns.
//
// "Will not renew" is billing_account_reminder_candidates' rule (migration
// 261): no next period is prepaid for this period, and auto-renew is off or
// the balance cannot pay the next period. A change scheduled to Free is due
// too (the reminder mails skip it); the notice then says the plan ends.
//
// With a saved card (phase 3b, migration 262) the card renews, never the
// balance: an active card with auto-renew on and a next period that is sold
// shows nothing; a card whose renewal payment failed (past_due) shows the
// notice, marked card_past_due, whatever the balance.
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { LEGACY_BILLING_ENABLED } from '../../../../shared/billingMode.js';

const DAY_MS = 86_400_000;

/** How long before the due date the notice shows (the first reminder mail's). */
export const RENEWAL_NOTICE_DAYS = 7;

export interface RenewalDueNotice {
  /** Whole days left, counted up (at least 1 while the period runs). */
  days_left: number;
  period_end: string;
  plan_id: string;
  /** A change to Free is scheduled: the workspace moves to Free whatever the balance. */
  ends_on_free: boolean;
  /** The saved card's renewal payment failed: it must be paid (or the card changed) before the due date. */
  card_past_due: boolean;
}

interface PlanRow {
  id: string;
  is_free: boolean;
  prices: unknown;
}

function priceOf(prices: unknown, currency: string, interval: string): number | null {
  const byCurrency = (prices as Record<string, Record<string, unknown>> | null)?.[currency.toUpperCase()];
  const raw = Number(byCurrency?.[interval]);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
}

async function readPlan(config: ServerConfig, planId: string): Promise<PlanRow | null> {
  const { data, error } = await getServiceClient(config)
    .from('billing_plans')
    .select('id, is_free, prices')
    .eq('id', planId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'plan read failed');
  return (data as PlanRow | null) ?? null;
}

/** A next period already paid through billing v2 (billing_account_v2_next_period); false when unknown. */
export async function v2NextPeriodPaid(config: ServerConfig, workspaceId: string): Promise<boolean> {
  try {
    const { data, error } = await getServiceClient(config).rpc('billing_account_v2_next_period', { p_workspace_id: workspaceId });
    return !error && typeof data === 'string' && data.length > 0;
  } catch {
    return false;
  }
}

/**
 * The paid period that ends within RENEWAL_NOTICE_DAYS and will not renew,
 * or null (nothing to warn of, or billing v2 still runs). Throws on a failed
 * read; callers that only decorate a response catch it.
 */
export async function renewalDueNotice(
  config: ServerConfig,
  workspaceId: string,
  now = Date.now(),
): Promise<RenewalDueNotice | null> {
  if (LEGACY_BILLING_ENABLED) return null;
  const sb = getServiceClient(config);
  const { data: sub, error: subError } = await sb
    .from('workspace_subscriptions')
    .select('plan_id, status, billing_interval, current_period_end')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (subError) throw new Error(subError.message || 'subscription read failed');
  const s = sub as { plan_id: string | null; status: string | null; billing_interval: string | null; current_period_end: string | null } | null;
  if (!s?.plan_id || s.status !== 'active' || !s.current_period_end) return null;
  const end = Date.parse(s.current_period_end);
  if (!Number.isFinite(end) || end <= now || end - now > RENEWAL_NOTICE_DAYS * DAY_MS) return null;

  const [plan, accountRead] = await Promise.all([
    readPlan(config, s.plan_id),
    sb
      .from('billing_accounts')
      .select('currency, balance_minor, auto_renew, scheduled_plan_id, scheduled_interval, next_period_prepaid_minor, next_period_start')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
  ]);
  if (accountRead.error) throw new Error(accountRead.error.message || 'billing account read failed');
  if (!plan || plan.is_free) return null;
  const account = accountRead.data as {
    currency: string; balance_minor: number | string; auto_renew: boolean;
    scheduled_plan_id: string | null; scheduled_interval: string | null;
    next_period_prepaid_minor: number | string | null; next_period_start: string | null;
  } | null;

  const notice = {
    days_left: Math.max(1, Math.ceil((end - now) / DAY_MS)),
    period_end: s.current_period_end,
    plan_id: s.plan_id,
  };
  // The next period's plan: a change scheduled to Free ends on Free at the
  // due moment, prepaid or not (billing_account_process_due).
  const targetId = account?.scheduled_plan_id ?? s.plan_id;
  const target = targetId === plan.id ? plan : await readPlan(config, targetId);
  if (!target || target.is_free) return { ...notice, ends_on_free: true, card_past_due: false };

  // The next period is paid for already (a prepayment made for an earlier,
  // replaced period does not count: it returns to the balance).
  const prepaidStart = account?.next_period_start ? Date.parse(account.next_period_start) : NaN;
  if (account?.next_period_prepaid_minor != null && Math.abs(prepaidStart - end) < 1000) return null;
  // ...or through billing v2 (a scheduled period the due moment starts).
  if (await v2NextPeriodPaid(config, workspaceId)) return null;

  const interval = account?.scheduled_interval ?? s.billing_interval ?? 'monthly';
  const price = account ? priceOf(target.prices, account.currency, interval) : null;
  // A saved card renews (the due moment never spends the balance then).
  const card = account ? await liveCardStatus(config, workspaceId) : null;
  if (card === 'past_due') return { ...notice, ends_on_free: false, card_past_due: true };
  if (card === 'active') {
    if (account?.auto_renew && price !== null) return null;
    return { ...notice, ends_on_free: false, card_past_due: false };
  }

  // Auto-renew pays from the balance (an account always has its currency).
  if (account?.auto_renew && price !== null && Number(account.balance_minor) >= price) return null;
  return { ...notice, ends_on_free: false, card_past_due: false };
}

/** The status of the workspace's live saved card (active or past_due), or null without one. */
async function liveCardStatus(config: ServerConfig, workspaceId: string): Promise<'active' | 'past_due' | null> {
  const { data, error } = await getServiceClient(config)
    .from('billing_account_cards')
    .select('status')
    .eq('workspace_id', workspaceId)
    .in('status', ['active', 'past_due'])
    .maybeSingle();
  if (error) throw new Error(error.message || 'card read failed');
  const status = (data as { status?: string } | null)?.status;
  return status === 'active' || status === 'past_due' ? status : null;
}
