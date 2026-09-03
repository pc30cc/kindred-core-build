// ============================================================
// V2 WORKSPACE BILLING READ MODEL — a STABLE backend contract.
//
// Strictly read-only. Phase D's UI will consume this shape, so it must not
// change semantics later; and — per the "no hidden GET mutations" rule — for a
// V2-owned workspace nothing here grants, settles or activates anything. It
// only reports what the financial tables already say.
// ============================================================

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getRolloutState, type RolloutState } from './rollout.js';

/**
 * How long before a period ends the renewal invoice becomes issuable.
 * Phase C's scheduler issues it; Phase B only decides eligibility.
 */
export const INVOICE_LEAD_TIME_DAYS = 10;

export interface V2ReadModel {
  engine: 'v1' | 'v2';
  rolloutState: RolloutState;
  subscriptionStatus: string | null;
  currentPeriod: {
    id: string;
    planId: string | null;
    source: string;
    interval: string;
    periodStart: string;
    periodEnd: string;
    aiAllowanceIrr: number;
    engineVersion: string;
  } | null;
  nextInvoiceAt: string | null;
  /**
   * Lead-time catch-up (Phase B rule 25): true when the current period ends
   * within the lead time and no renewal invoice exists yet — including the
   * case where cutover happened INSIDE the lead-time window, which must not
   * silently skip a billing cycle.
   */
  renewalInvoiceEligible: boolean;
  pendingPlanChange: { type: string; nextPlanId: string | null } | null;
  wallet: { availableBalanceIrr: number; frozen: boolean };
  ai: { allowanceIrr: number; periodBound: boolean };
  openInvoices: Array<{ id: string; invoiceNumber: string; status: string; amountDueIrr: number }>;
}

export async function buildWorkspaceBillingReadModel(
  config: ServerConfig,
  workspaceId: string,
): Promise<V2ReadModel> {
  const sb = getServiceClient(config);
  const rolloutState = await getRolloutState(config, workspaceId);

  const { data: sub } = await sb
    .from('workspace_subscriptions')
    .select(
      'status, plan_id, billing_interval, current_period_id, current_period_end, next_invoice_at, next_plan_id, pending_change_type, billing_engine_version, v2_allowance_effective_period_id',
    )
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  const { data: period } = await sb
    .from('billing_subscription_periods')
    .select('id, plan_id, source, billing_interval, period_start, period_end, ai_allowance_irr, billing_engine_version')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .maybeSingle();

  const { data: wallet } = await sb
    .from('billing_wallet_accounts')
    .select('available_balance_irr, frozen')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  const { data: openInvoices } = await sb
    .from('billing_invoices')
    .select('id, invoice_number, status, amount_due_irr, period_start')
    .eq('workspace_id', workspaceId)
    .in('status', ['open', 'partially_paid', 'past_due'])
    .order('created_at', { ascending: false })
    .limit(20);

  const periodEnd = (period?.period_end as string | undefined) || (sub?.current_period_end as string | undefined) || null;
  const nextInvoiceAt = (sub?.next_invoice_at as string | undefined) || periodEnd;

  let renewalInvoiceEligible = false;
  if (periodEnd) {
    const msLeft = new Date(periodEnd).getTime() - Date.now();
    const inWindow = msLeft <= INVOICE_LEAD_TIME_DAYS * 86_400_000;
    const hasFutureInvoice = (openInvoices || []).some(
      (i: any) => i.period_start && new Date(i.period_start).getTime() >= new Date(periodEnd).getTime(),
    );
    renewalInvoiceEligible = inWindow && !hasFutureInvoice;
  }

  return {
    engine: rolloutState === 'v2_active' ? 'v2' : 'v1',
    rolloutState,
    subscriptionStatus: (sub?.status as string | undefined) ?? null,
    currentPeriod: period
      ? {
          id: period.id as string,
          planId: (period.plan_id as string | null) ?? null,
          source: period.source as string,
          interval: period.billing_interval as string,
          periodStart: period.period_start as string,
          periodEnd: period.period_end as string,
          aiAllowanceIrr: Number(period.ai_allowance_irr ?? 0),
          engineVersion: (period.billing_engine_version as string) || 'v2',
        }
      : null,
    nextInvoiceAt: nextInvoiceAt ?? null,
    renewalInvoiceEligible,
    pendingPlanChange: sub?.pending_change_type
      ? { type: sub.pending_change_type as string, nextPlanId: (sub.next_plan_id as string | null) ?? null }
      : null,
    wallet: {
      availableBalanceIrr: Number(wallet?.available_balance_irr ?? 0),
      frozen: Boolean(wallet?.frozen),
    },
    ai: {
      allowanceIrr: Number(period?.ai_allowance_irr ?? 0),
      periodBound: Boolean(sub?.v2_allowance_effective_period_id),
    },
    openInvoices: (openInvoices || []).map((i: any) => ({
      id: i.id,
      invoiceNumber: i.invoice_number,
      status: i.status,
      amountDueIrr: Number(i.amount_due_irr ?? 0),
    })),
  };
}
