// ============================================================================
// BILLING V2 — CUSTOMER ACTIONS (Phase D)
//
// Every financial decision in this module is made from SERVER data:
//
//   * prices come from `billing_plans`,
//   * proration comes from the same primitive the invoice issuer uses,
//   * the AI cycle delta mirrors the SQL cycle planner (migration 119),
//   * an invoice, once opened, is the only pricing authority.
//
// The client sends intent ("upgrade to plan X, immediately") plus the exact
// amount it was shown; a mismatch is rejected as stale instead of charged.
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { computeUpgradeProration } from '../proration.js';
import { issueSubscriptionInvoice } from '../invoice/issue.js';
import { isV2Active } from '../rollout.js';
import type { InvoiceRow } from '../invoice/types.js';

export type PlanChangeMode = 'immediate' | 'next_cycle';

export class BillingActionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BillingActionError';
  }
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function planPriceIrr(plan: any, interval: 'monthly' | 'yearly'): number {
  const raw = plan?.prices?.IRR?.[interval] ?? (interval === 'yearly' ? plan?.price_yearly : plan?.price_monthly);
  const value = Math.round(num(raw));
  if (value < 0) throw new BillingActionError('plan price invalid', 500, 'PLAN_PRICE_INVALID');
  return value;
}

function monthlyAllowanceIrr(plan: any): number {
  return Math.max(0, Math.round(num(plan?.limits?.ai_credits_per_month)));
}

export interface PlanChangePreview {
  mode: PlanChangeMode;
  allowedModes: PlanChangeMode[];
  direction: 'upgrade' | 'downgrade' | 'same';
  currentPlan: { id: string | null; name: string | null; interval: 'monthly' | 'yearly' | null };
  targetPlan: { id: string; name: string; interval: 'monthly' | 'yearly'; fullPriceIrr: number };
  /** What the customer pays NOW (0 for a next-cycle change). */
  amountIrr: number;
  /** Extra AI allowance released into the running cycle by an immediate upgrade. */
  aiCycleDeltaIrr: number;
  /** Full monthly allowance of the target plan, from the next cycle on. */
  aiMonthlyAfterIrr: number;
  remainingMs: number;
  remainingDays: number;
  effectiveAt: string;
  periodEnd: string | null;
  annualMonthlyAllowance: boolean;
}

async function loadContext(config: ServerConfig, workspaceId: string) {
  const sb = getServiceClient(config);
  const { data: sub } = await sb
    .from('workspace_subscriptions')
    .select(
      'id, status, plan_id, billing_interval, current_period_start, current_period_end, pending_change_type, next_plan_id',
    )
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  const { data: period } = await sb
    .from('billing_subscription_periods')
    .select('id, period_start, period_end, billing_interval, plan_id')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .maybeSingle();
  const { data: cycle } = await sb.rpc('billing_v2_current_entitlement_cycle', {
    p_workspace_id: workspaceId,
  });
  return { sub: sub as any, period: period as any, cycle: (cycle as any) ?? null };
}

export async function previewPlanChange(
  config: ServerConfig,
  workspaceId: string,
  input: { planId: string; interval: 'monthly' | 'yearly'; mode: PlanChangeMode },
): Promise<PlanChangePreview> {
  const sb = getServiceClient(config);
  if (!(await isV2Active(config, workspaceId))) {
    throw new BillingActionError('workspace is not on billing engine v2', 409, 'BILLING_V2_REQUIRED');
  }

  const { data: target } = await sb.from('billing_plans').select('*').eq('id', input.planId).maybeSingle();
  if (!target || (target as any).is_active === false) {
    throw new BillingActionError('unknown plan', 404, 'UNKNOWN_PLAN');
  }

  const { sub, period, cycle } = await loadContext(config, workspaceId);
  const currentPlanId = sub?.plan_id ?? null;
  const { data: current } = currentPlanId
    ? await sb.from('billing_plans').select('*').eq('id', currentPlanId).maybeSingle()
    : { data: null };

  const interval = input.interval;
  const targetPrice = planPriceIrr(target, interval);
  const currentPrice = current ? planPriceIrr(current, interval) : 0;
  const direction: PlanChangePreview['direction'] =
    targetPrice > currentPrice ? 'upgrade' : targetPrice < currentPrice ? 'downgrade' : 'same';

  const periodStart = period?.period_start ?? sub?.current_period_start ?? null;
  const periodEnd = period?.period_end ?? sub?.current_period_end ?? null;
  const now = new Date();

  // A downgrade is next-cycle only (V1 policy, no refunds). An upgrade may be
  // taken immediately only when there is a paid window left to prorate into.
  const isFirstPaidSubscription = !currentPlanId && targetPrice > 0;
  const allowedModes: PlanChangeMode[] = isFirstPaidSubscription
    ? ['immediate']
    : direction === 'upgrade' && periodEnd && new Date(periodEnd).getTime() > now.getTime()
      ? ['immediate', 'next_cycle']
      : ['next_cycle'];

  const mode: PlanChangeMode = allowedModes.includes(input.mode) ? input.mode : 'next_cycle';

  let amountIrr = 0;
  let remainingMs = 0;
  let aiCycleDeltaIrr = 0;
  let effectiveAt = periodEnd ?? now.toISOString();

  if (mode === 'immediate' && periodEnd && currentPlanId) {
    const proration = computeUpgradeProration({
      now,
      currentPeriodStart: new Date(periodStart ?? now.toISOString()),
      currentPeriodEnd: new Date(periodEnd),
      currentPlanPriceIrr: currentPrice,
      targetPlanPriceIrr: targetPrice,
      interval,
    });
    if (proration.isDowngrade) {
      throw new BillingActionError('not an upgrade', 409, 'NOT_AN_UPGRADE');
    }
    amountIrr = proration.payableIrr;
    remainingMs = proration.remainingMs;
    effectiveAt = now.toISOString();

    // Mirrors migration 119: the running AI cycle is topped up with the
    // prorated DIFFERENCE of the monthly allowance, never the full amount.
    if (cycle?.cycle_id) {
      const cycleStart = new Date(cycle.start).getTime();
      const cycleEnd = new Date(cycle.end).getTime();
      const span = Math.max(1, cycleEnd - cycleStart);
      const left = Math.max(0, Math.min(span, cycleEnd - now.getTime()));
      const currentMonthly = current ? monthlyAllowanceIrr(current) : 0;
      const delta = Math.max(0, monthlyAllowanceIrr(target) - currentMonthly);
      aiCycleDeltaIrr = Math.round((delta * left) / span);
    }
  } else if (mode === 'immediate' && isFirstPaidSubscription) {
    // A workspace without a subscription has no existing period to prorate.
    // Its first paid plan is a new subscription and the full plan price is due
    // now. Treating it as a next-cycle change used to create a zero-amount
    // result and never established the subscription projection.
    amountIrr = targetPrice;
    effectiveAt = now.toISOString();
  }

  return {
    mode,
    allowedModes,
    direction,
    currentPlan: {
      id: currentPlanId,
      name: (current as any)?.name ?? null,
      interval: (sub?.billing_interval as any) ?? null,
    },
    targetPlan: {
      id: (target as any).id,
      name: (target as any).name,
      interval,
      fullPriceIrr: targetPrice,
    },
    amountIrr,
    aiCycleDeltaIrr,
    aiMonthlyAfterIrr: monthlyAllowanceIrr(target),
    remainingMs,
    remainingDays: Math.max(0, Math.ceil(remainingMs / 86_400_000)),
    effectiveAt,
    periodEnd,
    annualMonthlyAllowance: interval === 'yearly',
  };
}

export interface PlanChangeResult {
  mode: PlanChangeMode;
  invoiceId: string | null;
  invoiceNumber: string | null;
  amountIrr: number;
  effectiveAt: string;
  pending: boolean;
}

export async function applyPlanChange(
  config: ServerConfig,
  workspaceId: string,
  input: {
    planId: string;
    interval: 'monthly' | 'yearly';
    mode: PlanChangeMode;
    /** Exactly what the confirmation dialog displayed. Guards against a stale preview. */
    expectedAmountIrr: number;
  },
): Promise<PlanChangeResult> {
  const sb = getServiceClient(config);
  const preview = await previewPlanChange(config, workspaceId, input);

  if (preview.mode !== input.mode) {
    throw new BillingActionError('plan change mode is no longer available', 409, 'STALE_PREVIEW', {
      allowedModes: preview.allowedModes,
    });
  }
  // The prorated amount is a function of the clock: between the preview call
  // and the confirmation click a few seconds of the paid window elapse, so an
  // exact equality check rejects perfectly honest upgrades. What actually needs
  // guarding is charging MORE than the customer agreed to, so we only reject
  // when the recomputed amount exceeds the shown one beyond clock drift
  // (0.5% of the shown amount, floor 10_000 IRR = 1_000 Toman).
  const expected = Math.round(num(input.expectedAmountIrr));
  const tolerance = Math.max(10_000, Math.round(expected * 0.005));
  if (preview.amountIrr > expected + tolerance) {
    throw new BillingActionError('the amount changed, please review again', 409, 'STALE_PREVIEW', {
      amountIrr: preview.amountIrr,
    });
  }


  const { sub, period } = await loadContext(config, workspaceId);

  if (input.mode === 'immediate') {
    const action = sub?.plan_id ? 'plan_upgrade' : 'plan_new';
    const invoice = await issueSubscriptionInvoice(config, {
      workspaceId,
      subscriptionId: sub?.id ?? null,
      targetPlanId: input.planId,
      interval: input.interval,
      action,
      currentPlanId: sub?.plan_id ?? null,
      currentPeriodStart: period?.period_start ?? sub?.current_period_start ?? null,
      currentPeriodEnd: period?.period_end ?? sub?.current_period_end ?? null,
      metadata: { origin: 'customer_immediate_upgrade' },
    });
    return {
      mode: 'immediate',
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      amountIrr: num((invoice as any).amount_due_irr),
      effectiveAt: preview.effectiveAt,
      pending: false,
    };
  }

  // Next-cycle change: record the intent, then let the CANONICAL renewal
  // issuer re-derive the document (it voids and reissues an unpaid renewal
  // invoice itself — the client never edits an invoice).
  const { error } = await sb
    .from('workspace_subscriptions')
    .update({
      pending_change_type: preview.direction === 'downgrade' ? 'downgrade' : 'upgrade',
      next_plan_id: input.planId,
    })
    .eq('workspace_id', workspaceId);
  if (error) throw new BillingActionError(error.message, 500, 'PLAN_CHANGE_FAILED');

  let invoiceId: string | null = null;
  let invoiceNumber: string | null = null;
  const { data: reissued } = await sb.rpc('billing_v2_issue_renewal_invoice', {
    p_workspace_id: workspaceId,
    p_force: false,
  });
  if ((reissued as any)?.invoice_id) {
    invoiceId = (reissued as any).invoice_id;
    const { data: inv } = await sb
      .from('billing_invoices')
      .select('invoice_number')
      .eq('id', invoiceId)
      .maybeSingle();
    invoiceNumber = (inv as any)?.invoice_number ?? null;
  }

  return {
    mode: 'next_cycle',
    invoiceId,
    invoiceNumber,
    amountIrr: 0,
    effectiveAt: preview.effectiveAt,
    pending: true,
  };
}

/**
 * Cancels a scheduled plan change. Refused once money has been taken for it —
 * a paid renewal invoice is a contract, not a draft.
 */
export async function cancelPendingPlanChange(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ canceled: boolean }> {
  const sb = getServiceClient(config);
  const { data: sub } = await sb
    .from('workspace_subscriptions')
    .select('id, pending_change_type')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!(sub as any)?.pending_change_type) return { canceled: false };

  const { data: paidFuture } = await sb
    .from('billing_invoices')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('invoice_type', 'subscription_renewal')
    .eq('status', 'paid')
    .gte('period_start', new Date().toISOString())
    .limit(1);
  if ((paidFuture || []).length) {
    throw new BillingActionError('the next period is already paid', 409, 'ALREADY_PAID');
  }

  await sb
    .from('workspace_subscriptions')
    .update({ pending_change_type: null, next_plan_id: null })
    .eq('workspace_id', workspaceId);

  // Re-derive the renewal document for the unchanged plan (void + reissue is
  // the issuer's job, and it refuses to touch anything paid).
  await sb.rpc('billing_v2_issue_renewal_invoice', { p_workspace_id: workspaceId, p_force: false });
  return { canceled: true };
}

/** Sets wallet auto-pay. Server-authoritative: the switch reflects THIS result. */
export async function setWalletAutoPay(
  config: ServerConfig,
  workspaceId: string,
  enabled: boolean,
): Promise<{ autoPayEnabled: boolean }> {
  const sb = getServiceClient(config);
  const { data: existing } = await sb
    .from('billing_wallet_accounts')
    .select('id')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (existing) {
    await sb.from('billing_wallet_accounts').update({ auto_pay_enabled: enabled }).eq('workspace_id', workspaceId);
  } else {
    await sb.from('billing_wallet_accounts').insert({ workspace_id: workspaceId, auto_pay_enabled: enabled });
  }
  const { data: fresh } = await sb
    .from('billing_wallet_accounts')
    .select('auto_pay_enabled')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  return { autoPayEnabled: Boolean((fresh as any)?.auto_pay_enabled) };
}

/** Server-validated AI credit purchase → an invoice, never a direct grant. */
export async function issueAiCreditPurchase(
  config: ServerConfig,
  workspaceId: string,
  amountIrr: number,
  bounds: { minIrr: number; maxIrr: number },
): Promise<InvoiceRow> {
  const amount = Math.round(num(amountIrr));
  if (amount < bounds.minIrr || amount > bounds.maxIrr) {
    throw new BillingActionError('amount out of range', 400, 'AMOUNT_OUT_OF_RANGE', bounds);
  }
  const { issueAiCreditInvoice } = await import('../invoice/issue.js');
  return issueAiCreditInvoice(config, {
    workspaceId,
    amountIrr: amount,
    metadata: { origin: 'customer_ai_credit_purchase' },
  });
}
