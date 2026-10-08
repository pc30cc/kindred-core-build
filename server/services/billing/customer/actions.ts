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
import { computeUpgradeProration, resolvePaidInterval } from '../proration.js';
import { issueSubscriptionInvoice } from '../invoice/issue.js';
import { isV2Active } from '../rollout.js';
import type { InvoiceRow } from '../invoice/types.js';
import { assertEditionFeature, resolveEditionCurrency } from '../edition.js';

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

/** The `billing_plans` columns this module reads. */
interface PlanRow {
  id: string;
  name: string;
  is_active?: boolean | null;
  /** `{ CURRENCY: { monthly, yearly } }` — minor units, whole Rial for IRR. */
  prices?: Record<string, { monthly?: unknown; yearly?: unknown } | null> | null;
  price_monthly?: unknown;
  price_yearly?: unknown;
  limits?: { ai_credits_per_month?: unknown } | null;
}

interface SubscriptionContextRow {
  id: string;
  status: string | null;
  plan_id: string | null;
  billing_interval: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  pending_change_type: string | null;
  next_plan_id: string | null;
}

interface PeriodContextRow {
  id: string;
  period_start: string | null;
  period_end: string | null;
  billing_interval: string | null;
  plan_id: string | null;
  invoice_id?: string | null;
}

interface EntitlementCycleRow {
  cycle_id?: string | null;
  start: string;
  end: string;
}

/**
 * A billing currency code from the client, normalised; `fallback` when absent
 * (IRR by default — callers that know the edition pass its currency, which is
 * IRR in the Iranian edition and USD in the International one).
 */
export function billingCurrencyOf(raw: unknown, fallback = 'IRR'): string {
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : fallback;
}

/**
 * What a scheduled plan change records as its currency
 * (`workspace_subscriptions.pending_change_currency`): the currency the
 * customer chose, or null when the request named none — the renewal then
 * stays in the currency the running period was paid in, never Rial by default.
 */
export function pendingChangeCurrency(requested: unknown, previewCurrency: string): string | null {
  const code = typeof requested === 'string' ? requested.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? previewCurrency : null;
}

/** The price columns of `billing_plans` that pricing reads. */
export type PricedPlan = Pick<PlanRow, 'prices' | 'price_monthly' | 'price_yearly'>;

/** Whether the plan has a per-currency price map at all (`billing_plans.prices` with any entry). */
function hasPriceMap(plan: PricedPlan | null | undefined): boolean {
  return Boolean(plan?.prices && typeof plan.prices === 'object' && Object.keys(plan.prices).length > 0);
}

/**
 * The plan's price in `currency` for one interval (minor units; whole Rial
 * for IRR), or null when the plan is not sold in that currency at that
 * interval. Not validated: a negative value is returned as it is.
 *
 *   - A plan with a price map is sold in a currency only at a POSITIVE price
 *     set in it. A missing or zero price is never read from another currency
 *     or from the legacy flat columns: a plan priced only in USD/EUR was
 *     offered (and charged) in IRR at its stale flat Rial column, or at 0.
 *     A plan with no positive price anywhere (Free, Trial) is 0 in every
 *     currency.
 *   - A plan without any price map (a legacy row) keeps its historic reading:
 *     IRR from the flat columns (missing = 0), no other currency.
 */
export function planPriceInCurrency(
  plan: PricedPlan | null | undefined,
  interval: 'monthly' | 'yearly',
  currency: string,
): number | null {
  if (!hasPriceMap(plan)) {
    if (currency !== 'IRR') return null;
    return Math.round(num(interval === 'yearly' ? plan?.price_yearly : plan?.price_monthly));
  }
  const raw = plan?.prices?.[currency]?.[interval];
  const value = raw === null || raw === undefined || raw === '' ? null : Math.round(num(raw));
  if (value !== null && value !== 0) return value;
  return planIsFree(plan) ? 0 : null;
}

/** planPriceInCurrency, refusing a negative price. */
function planPrice(
  plan: PlanRow | null | undefined,
  interval: 'monthly' | 'yearly',
  currency: string,
): number | null {
  const value = planPriceInCurrency(plan, interval, currency);
  if (value !== null && value < 0) throw new BillingActionError('plan price invalid', 500, 'PLAN_PRICE_INVALID');
  return value;
}

/**
 * The currency the running paid period was bought in: the currency of the
 * invoice that created the active period. Null for a free / legacy period.
 */
async function paidPeriodCurrency(config: ServerConfig, period: PeriodContextRow | null): Promise<string | null> {
  if (!period?.invoice_id) return null;
  const { data } = await getServiceClient(config)
    .from('billing_invoices')
    .select('currency')
    .eq('id', period.invoice_id)
    .maybeSingle();
  const code = (data as { currency?: string | null } | null)?.currency;
  return typeof code === 'string' && code ? code.toUpperCase() : null;
}

function monthlyAllowanceIrr(plan: PlanRow | null | undefined): number {
  return Math.max(0, Math.round(num(plan?.limits?.ai_credits_per_month)));
}

export interface PlanChangePreview {
  mode: PlanChangeMode;
  allowedModes: PlanChangeMode[];
  direction: 'upgrade' | 'downgrade' | 'same';
  currentPlan: { id: string | null; name: string | null; interval: 'monthly' | 'yearly' | null };
  targetPlan: { id: string; name: string; interval: 'monthly' | 'yearly'; fullPriceIrr: number };
  /** Currency of every amount in this preview (`*Irr` fields are minor units of it; AI fields stay IRR). */
  currency: string;
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
  /**
   * True when an "upgrade" is really a new purchase: there is no paid time to
   * credit (a zero-priced current plan) and the interval changes, so the new
   * plan starts a fresh full period now at its full price.
   */
  freshPurchase: boolean;
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
    .select('id, period_start, period_end, billing_interval, plan_id, invoice_id')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .maybeSingle();
  const { data: cycle } = await sb.rpc('billing_v2_current_entitlement_cycle', {
    p_workspace_id: workspaceId,
  });
  return {
    sub: sub as SubscriptionContextRow | null,
    period: period as PeriodContextRow | null,
    cycle: (cycle as EntitlementCycleRow | null) ?? null,
  };
}

/** A plan with no positive price in any currency (the Free and Trial tiers). */
function planIsFree(plan: PricedPlan | null | undefined): boolean {
  if (!plan) return true;
  for (const byInterval of Object.values(plan.prices ?? {})) {
    if (byInterval && (num(byInterval.monthly) > 0 || num(byInterval.yearly) > 0)) return false;
  }
  return num(plan.price_monthly) <= 0 && num(plan.price_yearly) <= 0;
}

export async function previewPlanChange(
  config: ServerConfig,
  workspaceId: string,
  input: { planId: string; interval: 'monthly' | 'yearly'; mode: PlanChangeMode; currency?: string },
): Promise<PlanChangePreview> {
  const sb = getServiceClient(config);
  if (!(await isV2Active(config, workspaceId))) {
    throw new BillingActionError('workspace is not on billing engine v2', 409, 'BILLING_V2_REQUIRED');
  }

  const { data: targetData } = await sb.from('billing_plans').select('*').eq('id', input.planId).maybeSingle();
  const target = targetData as PlanRow | null;
  if (!target || target.is_active === false) {
    throw new BillingActionError('unknown plan', 404, 'UNKNOWN_PLAN');
  }

  const { sub, period, cycle } = await loadContext(config, workspaceId);
  const currentPlanId = sub?.plan_id ?? null;
  const { data: currentData } = currentPlanId
    ? await sb.from('billing_plans').select('*').eq('id', currentPlanId).maybeSingle()
    : { data: null };
  const current = currentData as PlanRow | null;

  // Every amount below is in this currency (minor units; Rial for IRR). With
  // none requested it is the edition's (IRR in Iran, USD in International);
  // Rial is refused in the International edition.
  const currency = await resolveEditionCurrency(config, input.currency);
  const interval = input.interval;
  const pricedTarget = planPrice(target, interval, currency);
  if (pricedTarget === null) {
    throw new BillingActionError('this plan has no price in the selected currency', 409, 'PRICE_NOT_AVAILABLE', {
      currency,
    });
  }
  const targetPrice = pricedTarget;
  // Tier comparison: both plans priced at the SAME (requested) interval.
  const currentPrice = current ? planPrice(current, interval, currency) ?? 0 : 0;
  const direction: PlanChangePreview['direction'] =
    targetPrice > currentPrice ? 'upgrade' : targetPrice < currentPrice ? 'downgrade' : 'same';

  // Nothing paid to credit: no plan yet, a zero-priced tier (Free / Trial), or
  // a trial (running or ended). Buying a paid plan from here is a new
  // subscription — full price, a full period from now — never a prorated
  // slice of the free window (which charged for trial days and left the paid
  // period ending with the trial).
  const nothingToCredit =
    !currentPlanId || planIsFree(current) || sub?.status === 'trialing' || sub?.status === 'expired';

  const periodStart = period?.period_start ?? sub?.current_period_start ?? null;
  const periodEnd = period?.period_end ?? sub?.current_period_end ?? null;
  const now = new Date();

  // The interval the running period was actually paid at. Proration credits
  // the unused part of THAT period at THAT price; pricing it at the requested
  // interval would credit a monthly window at the yearly price (or vice versa).
  const currentInterval = currentPlanId
    ? resolvePaidInterval({
        storedIntervals: [period?.billing_interval, sub?.billing_interval],
        periodStart,
        periodEnd,
      })
    : null;
  const paidInterval = currentInterval ?? interval;
  const currentPaidInCurrency = current && !nothingToCredit ? planPrice(current, paidInterval, currency) : 0;
  const currentPaidPrice = currentPaidInCurrency ?? 0;
  const intervalChange = !!currentPlanId && paidInterval !== interval;

  // A paid period bought in one currency cannot be prorated into a charge in
  // another: there is no rate the customer agreed to. The currency of the
  // running period is the currency of the invoice that created it.
  const paidCurrency = nothingToCredit ? null : await paidPeriodCurrency(config, period);
  const currencyChange =
    !nothingToCredit && ((paidCurrency !== null && paidCurrency !== currency) || currentPaidInCurrency === null);

  // A downgrade is next-cycle only (V1 policy, no refunds). An upgrade may be
  // taken immediately only when there is a paid window left to prorate into.
  const isFirstPaidSubscription = nothingToCredit && targetPrice > 0;
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
  let freshPurchase = false;

  if (mode === 'immediate' && isFirstPaidSubscription) {
    // The first paid plan is a new subscription: the full plan price is due
    // now. (Treating it as a next-cycle change used to create a zero-amount
    // result and never established the subscription projection.)
    freshPurchase = Boolean(currentPlanId);
    amountIrr = targetPrice;
    effectiveAt = now.toISOString();
  } else if (mode === 'immediate' && currencyChange) {
    throw new BillingActionError(
      'the current period was paid in another currency; an immediate upgrade must use that currency',
      409,
      'CURRENCY_CHANGE_NOT_IMMEDIATE',
      { currentCurrency: paidCurrency, requestedCurrency: currency },
    );
  } else if (mode === 'immediate' && periodEnd && currentPlanId && intervalChange) {
    // An immediate upgrade keeps the current window, so it cannot also change
    // the interval: the window would be one interval long and billed as the
    // other. With nothing paid to credit (free plan) the change is simply a
    // new purchase: full price, fresh period from now. With paid time left,
    // it is refused rather than mispriced.
    if (currentPaidPrice === 0 && targetPrice > 0) {
      freshPurchase = true;
      amountIrr = targetPrice;
      effectiveAt = now.toISOString();
    } else {
      throw new BillingActionError(
        'the billing interval cannot change in an immediate upgrade; keep the current interval',
        409,
        'INTERVAL_CHANGE_NOT_IMMEDIATE',
        { currentInterval: paidInterval, requestedInterval: interval },
      );
    }
  } else if (mode === 'immediate' && periodEnd && currentPlanId) {
    // Same interval on both sides: credit the unused part of the current
    // period at the price actually paid for it, charge the target plan's
    // price for that same interval over the same remaining window.
    const proration = computeUpgradeProration({
      now,
      currentPeriodStart: new Date(periodStart ?? now.toISOString()),
      currentPeriodEnd: new Date(periodEnd),
      currentPlanPriceIrr: currentPaidPrice,
      targetPlanPriceIrr: targetPrice,
      interval: paidInterval,
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
  }

  return {
    mode,
    allowedModes,
    direction,
    currency,
    currentPlan: {
      id: currentPlanId,
      name: current?.name ?? null,
      interval: currentInterval ?? ((sub?.billing_interval as 'monthly' | 'yearly' | null | undefined) ?? null),
    },
    targetPlan: {
      id: target.id,
      name: target.name,
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
    freshPurchase,
  };
}

export interface PlanChangeResult {
  mode: PlanChangeMode;
  invoiceId: string | null;
  invoiceNumber: string | null;
  /** Minor units of `currency` (whole Rial for IRR). */
  amountIrr: number;
  currency: string;
  effectiveAt: string;
  pending: boolean;
}

/**
 * Clock-drift allowance between preview and confirmation, in minor units:
 * 0.5% of the shown amount, at least 10_000 IRR (1_000 Toman) for Rial and
 * 1 minor unit (one cent) for every other currency — a Rial floor read as
 * cents would let $100 slip through.
 */
export function stalePreviewTolerance(expected: number, currency: string): number {
  return Math.max(currency === 'IRR' ? 10_000 : 1, Math.round(expected * 0.005));
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
    /** Currency the customer was shown (ISO 4217, default IRR). */
    currency?: string;
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
  // when the recomputed amount exceeds the shown one beyond clock drift.
  const expected = Math.round(num(input.expectedAmountIrr));
  const tolerance = stalePreviewTolerance(expected, preview.currency);
  if (preview.amountIrr > expected + tolerance) {
    throw new BillingActionError('the amount changed, please review again', 409, 'STALE_PREVIEW', {
      amountIrr: preview.amountIrr,
    });
  }


  const { sub, period } = await loadContext(config, workspaceId);

  if (input.mode === 'immediate') {
    const action = sub?.plan_id && !preview.freshPurchase ? 'plan_upgrade' : 'plan_new';
    const invoice = await issueSubscriptionInvoice(config, {
      workspaceId,
      subscriptionId: sub?.id ?? null,
      targetPlanId: input.planId,
      interval: input.interval,
      action,
      currentPlanId: sub?.plan_id ?? null,
      currentInterval:
        preview.currentPlan.interval === 'monthly' || preview.currentPlan.interval === 'yearly'
          ? preview.currentPlan.interval
          : null,
      currentPeriodStart: period?.period_start ?? sub?.current_period_start ?? null,
      currentPeriodEnd: period?.period_end ?? sub?.current_period_end ?? null,
      currency: preview.currency,
      metadata: { origin: 'customer_immediate_upgrade' },
    });
    return {
      mode: 'immediate',
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      amountIrr: num(invoice.amount_due_irr),
      currency: preview.currency,
      effectiveAt: preview.effectiveAt,
      pending: false,
    };
  }

  // Next-cycle change: record the intent, then let the CANONICAL renewal
  // issuer re-derive the document (it voids and reissues an unpaid renewal
  // invoice itself — the client never edits an invoice).
  //
  // The currency goes with it: the renewal that starts the new plan is
  // invoiced in the currency the customer chose here (migration 255). With no
  // currency in the request, none is recorded and the renewal stays in the
  // currency the running period was paid in.
  const { error } = await sb
    .from('workspace_subscriptions')
    .update({
      pending_change_type: preview.direction === 'downgrade' ? 'downgrade' : 'upgrade',
      next_plan_id: input.planId,
      pending_change_currency: pendingChangeCurrency(input.currency, preview.currency),
    })
    .eq('workspace_id', workspaceId);
  if (error) throw new BillingActionError(error.message, 500, 'PLAN_CHANGE_FAILED');

  let invoiceId: string | null = null;
  let invoiceNumber: string | null = null;
  const { data: reissued } = await sb.rpc('billing_v2_issue_renewal_invoice', {
    p_workspace_id: workspaceId,
    p_force: false,
  });
  const reissuedRow = reissued as { invoice_id?: string | null } | null;
  if (reissuedRow?.invoice_id) {
    invoiceId = reissuedRow.invoice_id;
    const { data: inv } = await sb
      .from('billing_invoices')
      .select('invoice_number')
      .eq('id', invoiceId)
      .maybeSingle();
    invoiceNumber = (inv as { invoice_number: string | null } | null)?.invoice_number ?? null;
  }

  return {
    mode: 'next_cycle',
    invoiceId,
    invoiceNumber,
    amountIrr: 0,
    currency: preview.currency,
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
  if (!(sub as { pending_change_type: string | null } | null)?.pending_change_type) return { canceled: false };

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
    .update({ pending_change_type: null, next_plan_id: null, pending_change_currency: null })
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
  return { autoPayEnabled: Boolean((fresh as { auto_pay_enabled: boolean | null } | null)?.auto_pay_enabled) };
}

/** Server-validated AI credit purchase → an invoice, never a direct grant. */
export async function issueAiCreditPurchase(
  config: ServerConfig,
  workspaceId: string,
  amountIrr: number,
  bounds: { minIrr: number; maxIrr: number },
): Promise<InvoiceRow> {
  // Rial AI credit: an Iranian-edition feature only (no USD ledger yet).
  await assertEditionFeature(config, 'aiCreditTopup');
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

/** Server-validated wallet top-up → an invoice, on the same road as a plan. */
export async function issueWalletDepositPurchase(
  config: ServerConfig,
  workspaceId: string,
  amountIrr: number,
  bounds: { minIrr: number; maxIrr: number },
): Promise<InvoiceRow> {
  // The wallet holds Rial: an Iranian-edition feature only.
  await assertEditionFeature(config, 'wallet');
  const amount = Math.round(num(amountIrr));
  if (amount < bounds.minIrr || amount > bounds.maxIrr) {
    throw new BillingActionError('amount out of range', 400, 'AMOUNT_OUT_OF_RANGE', bounds);
  }
  const { issueWalletDepositInvoice } = await import('../invoice/issue.js');
  return issueWalletDepositInvoice(config, {
    workspaceId,
    amountIrr: amount,
    metadata: { origin: 'customer_wallet_deposit' },
  });
}

