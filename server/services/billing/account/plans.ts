// ============================================================================
// SIMPLE BILLING — plans: buy, renew, upgrade, change at the period end
// (docs/billing/SIMPLE_BILLING.md, migration 261).
//
// The money rules live in SQL (one transaction each); this module lists the
// plans a workspace can choose, quotes what a choice costs, calls the SQL,
// and after a change refreshes entitlements and sends the billing mail.
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { handleWorkspaceEntitlementChanged } from '../entitlementChange.js';
import { getBillingRegion } from '../edition.js';
import { AccountBillingError, readAccount } from './index.js';
import { localizedPlanName, planNamesFor, sendBillingEmail } from './notify.js';

export type BillingInterval = 'monthly' | 'yearly';

export interface PlanOption {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  localized: Record<string, unknown>;
  is_free: boolean;
  sort_order: number;
  limits: Record<string, unknown>;
  entitlements: Record<string, unknown>;
  /** Price per period in minor units of the account currency; null = not sold that way. */
  price_monthly_minor: number | null;
  price_yearly_minor: number | null;
}

const RESERVED_SLUGS = new Set(['trial']);

function priceOf(prices: unknown, currency: string, interval: BillingInterval): number | null {
  const byCurrency = (prices as Record<string, Record<string, unknown>> | null)?.[currency.toUpperCase()];
  const raw = Number(byCurrency?.[interval]);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
}

/** The plans a workspace can choose: active, shown, and sold in its currency (Free always). */
export async function listPlanOptions(config: ServerConfig, currency: string): Promise<PlanOption[]> {
  const { data, error } = await getServiceClient(config)
    .from('billing_plans')
    .select('id, slug, name, description, localized, is_free, is_hidden, is_active, sort_order, limits, entitlements, prices')
    .eq('is_active', true)
    .eq('is_hidden', false)
    .order('sort_order', { ascending: true });
  if (error) throw new Error(error.message || 'plans read failed');
  const out: PlanOption[] = [];
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const slug = String(row.slug ?? '');
    if (RESERVED_SLUGS.has(slug)) continue;
    const isFree = row.is_free === true;
    const monthly = isFree ? 0 : priceOf(row.prices, currency, 'monthly');
    const yearly = isFree ? 0 : priceOf(row.prices, currency, 'yearly');
    if (!isFree && monthly === null && yearly === null) continue;
    out.push({
      id: String(row.id),
      slug,
      name: String(row.name ?? ''),
      description: (row.description as string | null) ?? null,
      localized: (row.localized as Record<string, unknown>) ?? {},
      is_free: isFree,
      sort_order: Number(row.sort_order ?? 0),
      limits: (row.limits as Record<string, unknown>) ?? {},
      entitlements: (row.entitlements as Record<string, unknown>) ?? {},
      price_monthly_minor: monthly,
      price_yearly_minor: yearly,
    });
  }
  return out;
}

// ─── The workspace's paid period ──────────────────────────────────────────

export interface PaidPeriod {
  plan_id: string;
  billing_interval: BillingInterval;
  current_period_start: string;
  current_period_end: string;
}

interface SubscriptionRow {
  plan_id: string | null;
  status: string | null;
  billing_interval: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_end: string | null;
}

async function readSubscription(config: ServerConfig, workspaceId: string): Promise<SubscriptionRow | null> {
  const { data, error } = await getServiceClient(config)
    .from('workspace_subscriptions')
    .select('plan_id, status, billing_interval, current_period_start, current_period_end, trial_end')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'subscription read failed');
  return (data as SubscriptionRow | null) ?? null;
}

async function readPlan(config: ServerConfig, planId: string) {
  const { data, error } = await getServiceClient(config)
    .from('billing_plans')
    .select('id, slug, name, localized, is_free, is_hidden, is_active, prices')
    .eq('id', planId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'plan read failed');
  return (data as {
    id: string; slug: string; name: string; localized: Record<string, unknown>;
    is_free: boolean; is_hidden: boolean; is_active: boolean; prices: unknown;
  } | null) ?? null;
}

/** The paid period running now (an active subscription on a plan that is not free). */
export async function paidPeriodOf(config: ServerConfig, workspaceId: string, now = Date.now()): Promise<PaidPeriod | null> {
  const sub = await readSubscription(config, workspaceId);
  if (!sub?.plan_id || sub.status !== 'active' || !sub.current_period_end) return null;
  if (Date.parse(sub.current_period_end) <= now) return null;
  const plan = await readPlan(config, sub.plan_id);
  if (!plan || plan.is_free) return null;
  return {
    plan_id: sub.plan_id,
    billing_interval: sub.billing_interval === 'yearly' ? 'yearly' : 'monthly',
    current_period_start: String(sub.current_period_start),
    current_period_end: sub.current_period_end,
  };
}

// ─── Quote ────────────────────────────────────────────────────────────────

export type QuoteKind = 'purchase' | 'upgrade' | 'schedule' | 'cancel_change' | 'current' | 'unavailable';

export interface PlanQuote {
  kind: QuoteKind;
  plan_id: string;
  billing_interval: BillingInterval;
  currency: string;
  /** Charged now from the balance (purchase, upgrade; a re-priced prepaid next period). */
  amount_minor: number;
  /** Returned to the balance now (a prepaid next period that becomes cheaper). */
  returned_minor: number;
  /** The price of each following period of the chosen plan. */
  period_price_minor: number | null;
  /** When it takes effect: now, or the end of the current period. */
  effective_at: string | null;
  months_left: number | null;
  balance_minor: number;
  shortfall_minor: number;
  /** Fewer than 7 days left: an upgrade may also start with the next period. */
  next_period_option: boolean;
  reason?: string;
}

const DAY_MS = 86_400_000;

/** What choosing `planId` (with `interval`) would do now and cost. */
export async function quotePlanChange(
  config: ServerConfig,
  workspaceId: string,
  planId: string,
  interval: BillingInterval,
): Promise<PlanQuote> {
  const [account, region, plan, paid] = await Promise.all([
    readAccount(config, workspaceId),
    getBillingRegion(config),
    readPlan(config, planId),
    paidPeriodOf(config, workspaceId),
  ]);
  const currency = account?.currency ?? region.currency;
  const balance = account?.balance_minor ?? 0;
  const base: PlanQuote = {
    kind: 'unavailable',
    plan_id: planId,
    billing_interval: interval,
    currency,
    amount_minor: 0,
    returned_minor: 0,
    period_price_minor: null,
    effective_at: null,
    months_left: null,
    balance_minor: balance,
    shortfall_minor: 0,
    next_period_option: false,
  };
  if (!plan || !plan.is_active) return { ...base, reason: 'plan_not_available' };
  const price = plan.is_free ? 0 : priceOf(plan.prices, currency, interval);
  const withShortfall = (q: PlanQuote): PlanQuote => ({ ...q, shortfall_minor: Math.max(q.amount_minor - q.balance_minor, 0) });

  if (!paid) {
    if (plan.is_free) return { ...base, kind: 'current', period_price_minor: 0 };
    if (plan.is_hidden) return { ...base, reason: 'plan_not_available' };
    if (price === null) return { ...base, reason: 'price_unavailable' };
    return withShortfall({ ...base, kind: 'purchase', amount_minor: price, period_price_minor: price, effective_at: new Date().toISOString() });
  }

  const sameInterval = interval === paid.billing_interval;
  const scheduled = account && (account.scheduled_plan_id || account.scheduled_interval);
  if (planId === paid.plan_id && (sameInterval || plan.is_free)) {
    return { ...base, kind: scheduled ? 'cancel_change' : 'current', period_price_minor: price, effective_at: paid.current_period_end };
  }
  if (plan.is_hidden && planId !== paid.plan_id) return { ...base, reason: 'plan_not_available' };
  if (price === null) return { ...base, reason: 'price_unavailable' };

  const daysLeft = (Date.parse(paid.current_period_end) - Date.now()) / DAY_MS;
  if (sameInterval && !plan.is_free) {
    const { data, error } = await getServiceClient(config).rpc('billing_account_upgrade_cost', {
      p_workspace_id: workspaceId,
      p_plan_id: planId,
    });
    if (error) throw new Error(error.message || 'upgrade quote failed');
    const cost = (data ?? {}) as { upgrade?: boolean; cost_minor?: number; months_left?: number | null };
    if (cost.upgrade) {
      return withShortfall({
        ...base,
        kind: 'upgrade',
        amount_minor: Number(cost.cost_minor ?? 0),
        period_price_minor: price,
        effective_at: new Date().toISOString(),
        months_left: cost.months_left ?? null,
        next_period_option: daysLeft < 7,
      });
    }
  }

  // At the period end. A prepaid next period is re-priced now.
  let amount = 0;
  let returned = 0;
  if (account?.next_period_prepaid_minor !== null && account?.next_period_prepaid_minor !== undefined) {
    const delta = price - account.next_period_prepaid_minor;
    if (delta > 0) amount = delta;
    else returned = -delta;
  }
  return withShortfall({
    ...base,
    kind: 'schedule',
    amount_minor: amount,
    returned_minor: returned,
    period_price_minor: price,
    effective_at: paid.current_period_end,
  });
}

// ─── Actions ──────────────────────────────────────────────────────────────

const RPC_ERRORS: Array<[RegExp, string, number]> = [
  [/billing_insufficient_balance/, 'INSUFFICIENT_BALANCE', 409],
  [/billing_plan_active/, 'PLAN_ACTIVE', 409],
  [/billing_plan_not_available/, 'PLAN_NOT_AVAILABLE', 400],
  [/billing_plan_price_unavailable/, 'PLAN_PRICE_UNAVAILABLE', 400],
  [/billing_interval_invalid/, 'INVALID_INTERVAL', 400],
  [/billing_no_paid_plan/, 'NO_PAID_PLAN', 409],
  [/billing_already_renewed/, 'ALREADY_RENEWED', 409],
  [/billing_renewal_to_free/, 'RENEWAL_TO_FREE', 409],
  [/billing_not_an_upgrade/, 'NOT_AN_UPGRADE', 409],
  [/billing_account_currency_mismatch/, 'CURRENCY_CHANGED', 409],
];

export function billingRpcError(error: { message?: string } | null | undefined): never {
  const message = error?.message || '';
  for (const [pattern, code, status] of RPC_ERRORS) {
    if (pattern.test(message)) throw new AccountBillingError(code, status);
  }
  throw new Error(message || 'billing operation failed');
}

async function rpc(config: ServerConfig, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await getServiceClient(config).rpc(name, args);
  if (error) billingRpcError(error);
  return (data ?? {}) as Record<string, unknown>;
}

/** After a plan or period changed: entitlements now, and the mail. Never throws. */
export async function afterPlanChange(
  config: ServerConfig,
  workspaceId: string,
  result: Record<string, unknown>,
  source: 'payment_succeeded' | 'subscription_renewed' | 'subscription_created' | 'subscription_canceled' = 'subscription_renewed',
): Promise<void> {
  const action = String(result.action ?? '');
  try {
    if (['purchase', 'upgraded', 'renewed', 'expired'].includes(action)) {
      await handleWorkspaceEntitlementChanged(config, {
        workspaceId,
        source: action === 'expired' ? 'subscription_canceled' : source,
      });
    }
    const currency = (await readAccount(config, workspaceId))?.currency ?? (await getBillingRegion(config)).currency;
    const plans = await planNamesFor(config, [result.plan_id as string, result.previous_plan_id as string]);
    const planName = (locale: string) => localizedPlanName(plans.get(String(result.plan_id ?? '')), locale);
    if (action === 'purchase' || action === 'upgraded') {
      await sendBillingEmail(config, workspaceId, 'billing_plan_activated', (ctx) => ({
        plan_name: planName(ctx.locale),
        period_end: ctx.date(result.period_end as string),
        amount: ctx.money(Number(result.amount_minor ?? 0), currency),
        balance: ctx.money(Number(result.balance_minor ?? 0), currency),
      }));
    } else if (action === 'renewed' || action === 'prepaid') {
      const changed = action === 'renewed' && result.previous_plan_id && result.previous_plan_id !== result.plan_id;
      await sendBillingEmail(config, workspaceId, changed ? 'billing_plan_changed' : 'billing_renewed', (ctx) => ({
        plan_name: planName(ctx.locale),
        old_plan_name: localizedPlanName(plans.get(String(result.previous_plan_id ?? '')), ctx.locale),
        amount: ctx.money(Number(result.amount_minor ?? 0), currency),
        balance: ctx.money(Number(result.balance_minor ?? 0), currency),
        period_start: ctx.date(result.period_start as string),
        period_end: ctx.date(result.period_end as string),
      }));
    } else if (action === 'expired') {
      await sendBillingEmail(config, workspaceId, 'billing_expired', (ctx) => ({
        plan_name: planName(ctx.locale),
        expired_at: ctx.date(result.expired_at as string),
      }));
    } else if (action === 'change_scheduled') {
      const paid = await paidPeriodOf(config, workspaceId);
      const current = await planNamesFor(config, [paid?.plan_id]);
      await sendBillingEmail(config, workspaceId, 'billing_change_scheduled', (ctx) => ({
        plan_name: localizedPlanName(current.get(String(paid?.plan_id ?? '')), ctx.locale),
        new_plan_name: planName(ctx.locale),
        effective_at: ctx.date(result.effective_at as string),
      }));
    }
  } catch (e) {
    console.warn('[billing-account] after plan change:', e instanceof Error ? e.message : e);
  }
}

/** Buys a plan from the balance (on Free, a trial, or after a plan ran out). */
export async function buyPlan(
  config: ServerConfig,
  workspaceId: string,
  input: { planId: string; interval: BillingInterval; key: string; actorId: string | null },
): Promise<Record<string, unknown>> {
  const result = await rpc(config, 'billing_account_purchase_plan', {
    p_workspace_id: workspaceId,
    p_plan_id: input.planId,
    p_interval: input.interval,
    p_key: input.key,
    p_actor: input.actorId,
  });
  if (!result.replayed) await afterPlanChange(config, workspaceId, result, 'subscription_created');
  return result;
}

/** Pays the next period from the balance (early: kept as the prepaid next period). */
export async function renewPlan(config: ServerConfig, workspaceId: string, actorId: string | null): Promise<Record<string, unknown>> {
  const result = await rpc(config, 'billing_account_renew', { p_workspace_id: workspaceId, p_actor: actorId });
  await afterPlanChange(config, workspaceId, result);
  return result;
}

/** Upgrades now, paying the difference from the balance. */
export async function upgradePlan(
  config: ServerConfig,
  workspaceId: string,
  input: { planId: string; actorId: string | null },
): Promise<Record<string, unknown>> {
  const result = await rpc(config, 'billing_account_upgrade', {
    p_workspace_id: workspaceId,
    p_plan_id: input.planId,
    p_actor: input.actorId,
  });
  if (!result.replayed) await afterPlanChange(config, workspaceId, result);
  return result;
}

/** Schedules (or with the current plan and interval, cancels) a change at the period end. */
export async function scheduleChange(
  config: ServerConfig,
  workspaceId: string,
  input: { planId: string; interval: BillingInterval | null; actorId: string | null },
): Promise<Record<string, unknown>> {
  const result = await rpc(config, 'billing_account_schedule_change', {
    p_workspace_id: workspaceId,
    p_plan_id: input.planId,
    p_interval: input.interval,
    p_actor: input.actorId,
  });
  await afterPlanChange(config, workspaceId, result);
  return result;
}

/** Auto-renew on or off (the account is created if it has none yet). */
export async function setAutoRenew(config: ServerConfig, workspaceId: string, enabled: boolean): Promise<boolean> {
  const sb = getServiceClient(config);
  const region = await getBillingRegion(config);
  const { error: ensureError } = await sb.rpc('billing_account_ensure', { p_workspace_id: workspaceId, p_currency: region.currency });
  if (ensureError) throw new Error(ensureError.message || 'billing account create failed');
  const { data, error } = await sb
    .from('billing_accounts')
    .update({ auto_renew: enabled, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .select('auto_renew')
    .single();
  if (error) throw new Error(error.message || 'auto-renew update failed');
  return (data as { auto_renew: boolean }).auto_renew === true;
}

/** What paying online for a purpose must charge: what the balance is missing, never below the top-up minimum. */
export async function amountNeededFor(
  config: ServerConfig,
  workspaceId: string,
  input: { purpose: 'plan' | 'renewal' | 'upgrade'; planId?: string; interval?: BillingInterval },
): Promise<{ needed: number; currency: string; balance: number; detail: Record<string, unknown> }> {
  const account = await readAccount(config, workspaceId);
  const region = await getBillingRegion(config);
  const currency = account?.currency ?? region.currency;
  const balance = account?.balance_minor ?? 0;
  if (input.purpose === 'renewal') {
    const paid = await paidPeriodOf(config, workspaceId);
    if (!paid) throw new AccountBillingError('NO_PAID_PLAN', 409);
    if (account?.next_period_prepaid_minor !== null && account?.next_period_prepaid_minor !== undefined) {
      throw new AccountBillingError('ALREADY_RENEWED', 409);
    }
    const target = account?.scheduled_plan_id ?? paid.plan_id;
    const interval = (account?.scheduled_interval as BillingInterval | null) ?? paid.billing_interval;
    const plan = await readPlan(config, target);
    if (!plan || plan.is_free) throw new AccountBillingError('RENEWAL_TO_FREE', 409);
    const price = priceOf(plan.prices, currency, interval);
    if (price === null) throw new AccountBillingError('PLAN_PRICE_UNAVAILABLE', 400);
    return { needed: price, currency, balance, detail: { plan_id: target, billing_interval: interval } };
  }
  if (!input.planId) throw new AccountBillingError('INVALID_REQUEST', 400);
  const quote = await quotePlanChange(config, workspaceId, input.planId, input.interval ?? 'monthly');
  const expected = input.purpose === 'plan' ? 'purchase' : 'upgrade';
  if (quote.kind !== expected) {
    throw new AccountBillingError('QUOTE_CHANGED', 409, { kind: quote.kind, reason: quote.reason ?? null });
  }
  return {
    needed: quote.amount_minor,
    currency,
    balance,
    detail: { plan_id: input.planId, billing_interval: quote.billing_interval },
  };
}

// ─── The plan part of the billing page ────────────────────────────────────

export interface AccountPlanState {
  /** The paid period running now; null on Free, a trial, or after a plan ran out. */
  paid_period: PaidPeriod | null;
  /** The change scheduled for the period end (plan and/or interval). */
  scheduled_plan: { id: string; name: string; localized: Record<string, unknown>; is_free: boolean } | null;
  scheduled_interval: BillingInterval | null;
  /** Already paid for the next period (early renewal). */
  next_period_prepaid_minor: number | null;
  /** The next period: its plan, interval and price (null = not sold in this currency). */
  renewal: { plan_id: string; billing_interval: BillingInterval; price_minor: number | null } | null;
  days_left: number | null;
}

export async function accountPlanState(config: ServerConfig, workspaceId: string): Promise<AccountPlanState> {
  const [account, region, paid] = await Promise.all([
    readAccount(config, workspaceId),
    getBillingRegion(config),
    paidPeriodOf(config, workspaceId),
  ]);
  const currency = account?.currency ?? region.currency;
  const scheduledPlan = account?.scheduled_plan_id ? await readPlan(config, account.scheduled_plan_id) : null;
  const scheduledInterval = account?.scheduled_interval === 'yearly' || account?.scheduled_interval === 'monthly'
    ? (account.scheduled_interval as BillingInterval)
    : null;
  let renewal: AccountPlanState['renewal'] = null;
  if (paid) {
    const targetId = account?.scheduled_plan_id ?? paid.plan_id;
    const target = scheduledPlan ?? (await readPlan(config, paid.plan_id));
    const interval = scheduledInterval ?? paid.billing_interval;
    renewal = target && !target.is_free
      ? { plan_id: targetId, billing_interval: interval, price_minor: priceOf(target.prices, currency, interval) }
      : null;
  }
  return {
    paid_period: paid,
    scheduled_plan: scheduledPlan
      ? { id: scheduledPlan.id, name: scheduledPlan.name, localized: scheduledPlan.localized ?? {}, is_free: scheduledPlan.is_free }
      : null,
    scheduled_interval: scheduledInterval,
    next_period_prepaid_minor: account?.next_period_prepaid_minor ?? null,
    renewal,
    days_left: paid ? Math.max(Math.ceil((Date.parse(paid.current_period_end) - Date.now()) / DAY_MS), 0) : null,
  };
}
