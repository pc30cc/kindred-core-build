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
import { LEGACY_BILLING_ENABLED } from '../../../../shared/billingMode.js';
import { assignedPlanApplies } from '../planSelection.js';
import { AccountBillingError, readAccount, type AccountRow } from './index.js';
import { billingIntervalLabel, localizedPlanName, planNamesFor, sendBillingEmail } from './notify.js';
import { v2NextPeriodPaid } from './renewalNotice.js';
import { cancelCardNow, pullCardRenewal, readLiveCard, setCardAutoRenew } from './card.js';

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
  free_fallback_at: string | null;
  cancel_at_period_end: boolean | null;
}

async function readSubscription(config: ServerConfig, workspaceId: string): Promise<SubscriptionRow | null> {
  const { data, error } = await getServiceClient(config)
    .from('workspace_subscriptions')
    .select('plan_id, status, billing_interval, current_period_start, current_period_end, trial_end, free_fallback_at, cancel_at_period_end')
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

/**
 * A paid period that ended but that the hourly job has not processed yet is
 * processed now (its prepaid next period starts, auto-renew pays, or the
 * workspace moves to Free), so the page, a quote and a checkout never act on
 * a period that is over. Returns what happened; never throws.
 */
export async function processDueNow(
  config: ServerConfig,
  workspaceId: string,
  now = Date.now(),
): Promise<Record<string, unknown> | null> {
  if (LEGACY_BILLING_ENABLED) return null;
  try {
    const sub = await readSubscription(config, workspaceId);
    // A prepayment made for a period that was replaced (a Super Admin
    // assignment, billing v2) returns to the balance at once, so the page,
    // the quote and a checkout see the money where it is.
    const account = await readAccount(config, workspaceId);
    if (account?.next_period_prepaid_minor != null) {
      // The period it follows: the active one, ended or not (a prepayment
      // for a period that is due but not processed yet starts it below).
      const running = sub?.status === 'active' && sub.current_period_end
        ? { current_period_end: sub.current_period_end } as PaidPeriod
        : null;
      if (prepaidOf(account, running).stale > 0) {
        const { error } = await getServiceClient(config).rpc('billing_account_release_stale_prepaid', { p_workspace_id: workspaceId });
        if (error) throw new Error(error.message || 'prepayment release failed');
      }
    }
    if (!sub?.plan_id || sub.status !== 'active' || !sub.current_period_end) return null;
    if (Date.parse(sub.current_period_end) > now) return null;
    const plan = await readPlan(config, sub.plan_id);
    if (!plan || plan.is_free) return null;
    const result = await processDue(config, workspaceId);
    if (result.action && result.action !== 'none') await afterPlanChange(config, workspaceId, result);
    return result;
  } catch (e) {
    console.warn('[billing-account] due now:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * billing_account_process_due for one workspace whose paid period ended,
 * with its saved card around it (phase 3b): a renewal Paddle charged whose
 * event never reached us is settled first (pullCardRenewal), so the due
 * moment starts the period it paid; a card the due moment stopped
 * (card_cancel: nothing paid the next period) is cancelled at Paddle at once,
 * which ends Paddle's own retries (the job retries a cancel Paddle did not
 * confirm). Without a card it is the SQL alone. Throws when the SQL fails.
 */
export async function processDue(config: ServerConfig, workspaceId: string): Promise<Record<string, unknown>> {
  if (await readLiveCard(config, workspaceId)) await pullCardRenewal(config, workspaceId);
  const { data, error } = await getServiceClient(config).rpc('billing_account_process_due', { p_workspace_id: workspaceId });
  if (error) throw new Error(error.message || 'due processing failed');
  const result = (data ?? {}) as Record<string, unknown>;
  const stopped = result.card_cancel as { card_id?: unknown } | null | undefined;
  if (stopped && typeof stopped.card_id === 'string') await cancelCardNow(config, stopped.card_id);
  return result;
}

/**
 * The prepaid next period: `live` when it was paid for the period that runs
 * now; `stale` when it was paid for one that was replaced since (the SQL
 * returns it to the balance before anything else).
 */
function prepaidOf(account: AccountRow | null, paid: PaidPeriod | null): { live: number | null; stale: number } {
  const amount = account?.next_period_prepaid_minor ?? null;
  if (amount === null) return { live: null, stale: 0 };
  const start = account?.next_period_start ? Date.parse(account.next_period_start) : NaN;
  const same = paid !== null && Number.isFinite(start) && Math.abs(start - Date.parse(paid.current_period_end)) < 1000;
  return same ? { live: amount, stale: 0 } : { live: null, stale: amount };
}

// ─── Quote ────────────────────────────────────────────────────────────────

export type QuoteKind = 'purchase' | 'upgrade' | 'schedule' | 'cancel_change' | 'current' | 'unavailable';

export interface PlanQuote {
  kind: QuoteKind;
  plan_id: string;
  billing_interval: BillingInterval;
  currency: string;
  /** Taken from the balance now: the purchase or upgrade, and what a prepaid next period now costs more. */
  amount_minor: number;
  /** Returned to the balance now (first): what a prepaid next period now costs less, all of it when it can no longer be priced. */
  returned_minor: number;
  /** The price of each following period of the chosen plan. */
  period_price_minor: number | null;
  /** An upgrade: its own price for the rest of the period (amount_minor adds a prepaid next period's re-price). */
  upgrade_cost_minor: number | null;
  /** When it takes effect: now, or the end of the current period. */
  effective_at: string | null;
  /** The end of the running paid period, where a next period starts; null without one. */
  period_end: string | null;
  months_left: number | null;
  balance_minor: number;
  /** What the balance is missing: amount − returned − balance. */
  shortfall_minor: number;
  /** The next period already paid for, and what it costs after this choice (null = not prepaid). */
  prepaid_minor: number | null;
  next_period_price_minor: number | null;
  /** Without auto-renew a change at the period end applies only when the next period is paid. */
  auto_renew: boolean;
  /** Fewer than 7 days left: an upgrade may also start with the next period. */
  next_period_option: boolean;
  /** That option (a change at the period end): what it takes from and returns to the balance now. */
  next_period_amount_minor: number;
  next_period_returned_minor: number;
  reason?: string;
}

const DAY_MS = 86_400_000;

/** What choosing `planId` (with `interval`) would do now and cost: exactly what the SQL will do. */
export async function quotePlanChange(
  config: ServerConfig,
  workspaceId: string,
  planId: string,
  interval: BillingInterval,
): Promise<PlanQuote> {
  await processDueNow(config, workspaceId);
  const [account, region, plan, paid] = await Promise.all([
    readAccount(config, workspaceId),
    getBillingRegion(config),
    readPlan(config, planId),
    paidPeriodOf(config, workspaceId),
  ]);
  const currency = account?.currency ?? region.currency;
  const balance = account?.balance_minor ?? 0;
  const { live, stale } = prepaidOf(account, paid);
  const base: PlanQuote = {
    kind: 'unavailable',
    plan_id: planId,
    billing_interval: interval,
    currency,
    amount_minor: 0,
    returned_minor: stale,
    period_price_minor: null,
    upgrade_cost_minor: null,
    effective_at: null,
    period_end: paid?.current_period_end ?? null,
    months_left: null,
    balance_minor: balance,
    shortfall_minor: 0,
    prepaid_minor: live,
    next_period_price_minor: null,
    auto_renew: account?.auto_renew ?? false,
    next_period_option: false,
    next_period_amount_minor: 0,
    next_period_returned_minor: stale,
  };
  if (!plan) return { ...base, reason: 'plan_not_available' };
  const price = plan.is_free ? 0 : priceOf(plan.prices, currency, interval);
  const finish = (q: PlanQuote): PlanQuote => ({
    ...q,
    shortfall_minor: Math.max(q.amount_minor - q.returned_minor - q.balance_minor, 0),
  });
  // A prepaid next period re-priced to `next`: [taken now, returned now].
  const reprice = (next: number | null): [number, number] => {
    if (live === null) return [0, 0];
    if (next === null || next <= 0) return [0, live];
    return next > live ? [next - live, 0] : [0, live - next];
  };
  const nextPrice = (next: number | null) => (live === null || next === null || next <= 0 ? null : next);

  if (!paid) {
    if (!plan.is_active) return { ...base, reason: 'plan_not_available' };
    if (plan.is_free) {
      // During a trial the workspace is on the trial plan; Free comes after it.
      const sub = await readSubscription(config, workspaceId);
      const trialEnd = sub?.status === 'trialing' && sub.trial_end ? sub.trial_end : null;
      if (trialEnd && Date.parse(trialEnd) > Date.now()) {
        return { ...base, reason: 'trial_running', period_price_minor: 0, effective_at: trialEnd };
      }
      return { ...base, kind: 'current', period_price_minor: 0 };
    }
    if (plan.is_hidden) return { ...base, reason: 'plan_not_available' };
    if (price === null) return { ...base, reason: 'price_unavailable' };
    return finish({ ...base, kind: 'purchase', amount_minor: price, period_price_minor: price, effective_at: new Date().toISOString() });
  }

  const sameInterval = interval === paid.billing_interval;
  const scheduled = Boolean(account?.scheduled_plan_id || account?.scheduled_interval);
  if (planId === paid.plan_id && (sameInterval || plan.is_free)) {
    if (!scheduled) {
      return { ...base, kind: 'current', period_price_minor: price, next_period_price_minor: nextPrice(price), effective_at: paid.current_period_end };
    }
    // Cancelling the change: a prepaid next period goes back to this plan's price.
    const [taken, returned] = reprice(price);
    return finish({
      ...base,
      kind: 'cancel_change',
      amount_minor: taken,
      returned_minor: stale + returned,
      period_price_minor: price,
      next_period_price_minor: nextPrice(price),
      effective_at: paid.current_period_end,
    });
  }
  // Cancelling (above) always works; anything else needs a plan that is sold.
  if (!plan.is_active || (plan.is_hidden && planId !== paid.plan_id)) return { ...base, reason: 'plan_not_available' };
  if (price === null) return { ...base, reason: 'price_unavailable' };

  const daysLeft = (Date.parse(paid.current_period_end) - Date.now()) / DAY_MS;
  const [laterTaken, laterReturned] = reprice(price);
  if (sameInterval && !plan.is_free) {
    const { data, error } = await getServiceClient(config).rpc('billing_account_upgrade_cost', {
      p_workspace_id: workspaceId,
      p_plan_id: planId,
    });
    if (error) throw new Error(error.message || 'upgrade quote failed');
    const cost = (data ?? {}) as {
      upgrade?: boolean; cost_minor?: number; months_left?: number | null;
      reprice_minor?: number | null; next_price_minor?: number | null;
    };
    if (cost.upgrade) {
      const reprice = cost.reprice_minor === null || cost.reprice_minor === undefined ? 0 : Number(cost.reprice_minor);
      return finish({
        ...base,
        kind: 'upgrade',
        amount_minor: Number(cost.cost_minor ?? 0) + Math.max(reprice, 0),
        upgrade_cost_minor: Number(cost.cost_minor ?? 0),
        returned_minor: stale + Math.max(-reprice, 0),
        period_price_minor: price,
        next_period_price_minor: live === null ? null : nextPrice(cost.next_price_minor === undefined ? null : cost.next_price_minor),
        effective_at: new Date().toISOString(),
        months_left: cost.months_left ?? null,
        next_period_option: daysLeft < 7,
        next_period_amount_minor: laterTaken,
        next_period_returned_minor: stale + laterReturned,
      });
    }
  }

  // At the period end. A prepaid next period is re-priced now.
  return finish({
    ...base,
    kind: 'schedule',
    amount_minor: laterTaken,
    returned_minor: stale + laterReturned,
    period_price_minor: price,
    next_period_price_minor: nextPrice(price),
    effective_at: paid.current_period_end,
  });
}

/** What the action quoted takes from the balance now, net of what it returns first. */
export function quoteNetMinor(quote: PlanQuote, option: 'now' | 'next_period' = 'now'): number {
  return option === 'next_period' && quote.kind === 'upgrade'
    ? quote.next_period_amount_minor - quote.next_period_returned_minor
    : quote.amount_minor - quote.returned_minor;
}

/**
 * The amount the customer confirmed must still be what the action does now:
 * a price, a balance or the period changed since the quote → QUOTE_CHANGED
 * with the new quote, and nothing is charged.
 */
async function assertQuote(
  config: ServerConfig,
  workspaceId: string,
  input: { planId: string; interval: BillingInterval; kinds: QuoteKind[]; expectedNetMinor?: number; option?: 'now' | 'next_period' },
): Promise<void> {
  if (input.expectedNetMinor === undefined) return;
  const quote = await quotePlanChange(config, workspaceId, input.planId, input.interval);
  if (!input.kinds.includes(quote.kind) || quoteNetMinor(quote, input.option) !== input.expectedNetMinor) {
    throw new AccountBillingError('QUOTE_CHANGED', 409, { quote });
  }
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
  [/billing_period_changed/, 'PERIOD_CHANGED', 409],
  [/billing_idempotency_conflict/, 'IDEMPOTENCY_CONFLICT', 409],
  [/billing_quote_changed/, 'QUOTE_CHANGED', 409],
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

/**
 * After a plan or period changed: entitlements now, and the mail. Never throws.
 * `options.card` names the saved card that paid ("Visa •••• 4242"): a renewal
 * it paid is mailed as billing_card_renewed, with {card}.
 */
export async function afterPlanChange(
  config: ServerConfig,
  workspaceId: string,
  result: Record<string, unknown>,
  source: 'payment_succeeded' | 'subscription_renewed' | 'subscription_created' | 'subscription_canceled' = 'subscription_renewed',
  options: { card?: string } = {},
): Promise<void> {
  const action = String(result.action ?? '');
  try {
    if (['purchase', 'upgraded', 'renewed', 'expired'].includes(action)) {
      await handleWorkspaceEntitlementChanged(config, {
        workspaceId,
        source: action === 'expired' ? 'subscription_canceled' : source,
      });
    }
    // A next period the saved card paid starts: the card's payment was mailed
    // when it was settled (billing_renewed, and Paddle's own invoice).
    if (result.prepaid_card === true) return;
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
    } else if (action === 'renewed' && result.source === 'billing_v2') {
      // A next period paid through billing v2 started: it was billed and
      // mailed there; nothing was charged here.
    } else if (action === 'renewed' || action === 'prepaid') {
      const changed = action === 'renewed' && result.previous_plan_id && result.previous_plan_id !== result.plan_id;
      // A renewal the saved card paid has its own mail, naming the card.
      const slug = changed ? 'billing_plan_changed' : options.card ? 'billing_card_renewed' : 'billing_renewed';
      await sendBillingEmail(config, workspaceId, slug, (ctx) => ({
        plan_name: planName(ctx.locale),
        old_plan_name: localizedPlanName(plans.get(String(result.previous_plan_id ?? '')), ctx.locale),
        amount: ctx.money(Number(result.amount_minor ?? 0), currency),
        balance: ctx.money(Number(result.balance_minor ?? 0), currency),
        period_start: ctx.date(result.period_start as string),
        period_end: ctx.date(result.period_end as string),
        ...(options.card ? { card: options.card } : {}),
      }));
    } else if (action === 'expired') {
      await sendBillingEmail(config, workspaceId, 'billing_expired', (ctx) => ({
        plan_name: planName(ctx.locale),
        expired_at: ctx.date(result.expired_at as string),
      }));
    } else if (action === 'change_scheduled') {
      // One mail per change and period: choosing back and forth mails each target once.
      const { data: marked } = await getServiceClient(config).rpc('billing_account_mark_notice', {
        p_workspace_id: workspaceId,
        p_key: `change:${new Date(String(result.effective_at)).toISOString()}`,
        p_notices: [`${String(result.plan_id)}:${String(result.billing_interval)}`],
      });
      if (marked !== true) return;
      // An interval change names the interval too ("Pro (monthly)" → "Pro (yearly)").
      const withInterval = result.billing_interval !== result.previous_interval;
      const named = (planId: unknown, interval: unknown, locale: string) => {
        const name = localizedPlanName(plans.get(String(planId ?? '')), locale);
        return withInterval ? `${name} (${billingIntervalLabel(String(interval ?? ''), locale)})` : name;
      };
      await sendBillingEmail(config, workspaceId, 'billing_change_scheduled', (ctx) => ({
        plan_name: named(result.previous_plan_id, result.previous_interval, ctx.locale),
        new_plan_name: named(result.plan_id, result.billing_interval, ctx.locale),
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
  input: { planId: string; interval: BillingInterval; key: string; actorId: string | null; expectedNetMinor?: number },
): Promise<Record<string, unknown>> {
  await assertQuote(config, workspaceId, { planId: input.planId, interval: input.interval, kinds: ['purchase'], expectedNetMinor: input.expectedNetMinor });
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

/**
 * Pays the next period from the balance (early: kept as the prepaid next
 * period). With `expectedPeriodEnd` (the period the customer saw) a retry or
 * a second tab after that period was renewed renews nothing (PERIOD_CHANGED).
 */
export async function renewPlan(
  config: ServerConfig,
  workspaceId: string,
  actorId: string | null,
  expectedPeriodEnd: string | null = null,
  expectedPriceMinor: number | null = null,
): Promise<Record<string, unknown>> {
  const result = await rpc(config, 'billing_account_renew', {
    p_workspace_id: workspaceId,
    p_actor: actorId,
    p_expected_period_end: expectedPeriodEnd,
    p_expected_price_minor: expectedPriceMinor,
  });
  await afterPlanChange(config, workspaceId, result);
  return result;
}

/** Upgrades now, paying the difference from the balance. */
export async function upgradePlan(
  config: ServerConfig,
  workspaceId: string,
  input: { planId: string; actorId: string | null; expectedNetMinor?: number },
): Promise<Record<string, unknown>> {
  if (input.expectedNetMinor !== undefined) {
    const paid = await paidPeriodOf(config, workspaceId);
    if (!paid) throw new AccountBillingError('QUOTE_CHANGED', 409, { quote: null });
    await assertQuote(config, workspaceId, {
      planId: input.planId, interval: paid.billing_interval, kinds: ['upgrade'], expectedNetMinor: input.expectedNetMinor,
    });
  }
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
  input: { planId: string; interval: BillingInterval | null; actorId: string | null; expectedNetMinor?: number },
): Promise<Record<string, unknown>> {
  if (input.expectedNetMinor !== undefined) {
    const paid = await paidPeriodOf(config, workspaceId);
    if (!paid) throw new AccountBillingError('QUOTE_CHANGED', 409, { quote: null });
    await assertQuote(config, workspaceId, {
      planId: input.planId,
      interval: input.interval ?? paid.billing_interval,
      kinds: ['schedule', 'cancel_change', 'current', 'upgrade'],
      expectedNetMinor: input.expectedNetMinor,
      option: 'next_period',
    });
  }
  const result = await rpc(config, 'billing_account_schedule_change', {
    p_workspace_id: workspaceId,
    p_plan_id: input.planId,
    p_interval: input.interval,
    p_actor: input.actorId,
  });
  await afterPlanChange(config, workspaceId, result);
  return result;
}

/**
 * Auto-renew on or off (the account is created if it has none yet). With a
 * saved card Paddle is asked first (setCardAutoRenew: off cancels the card at
 * Paddle's period end, on undoes that).
 */
export async function setAutoRenew(config: ServerConfig, workspaceId: string, enabled: boolean): Promise<boolean> {
  if (await readLiveCard(config, workspaceId)) return setCardAutoRenew(config, workspaceId, enabled);
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

/**
 * What paying online for a purpose must charge: what the balance is missing
 * for exactly what the SQL will do (never below the top-up minimum, applied
 * by the route). The detail travels with the payment to its settlement.
 * `periodPriceMinor` is the full price of the period it buys (what a card
 * checkout charges). While a saved card is live it pays the renewal, so a
 * renewal paid online is refused (CARD_PAYS_RENEWAL), except for the checkout
 * that saves a card (`forCardSetup`; it then finds the card already saved).
 */
export async function amountNeededFor(
  config: ServerConfig,
  workspaceId: string,
  input: {
    purpose: 'plan' | 'renewal' | 'upgrade';
    planId?: string;
    interval?: BillingInterval;
    expectedNetMinor?: number;
    forCardSetup?: boolean;
  },
): Promise<{ needed: number; currency: string; balance: number; detail: Record<string, unknown>; periodPriceMinor: number | null }> {
  await processDueNow(config, workspaceId);
  const account = await readAccount(config, workspaceId);
  const region = await getBillingRegion(config);
  const currency = account?.currency ?? region.currency;
  const balance = account?.balance_minor ?? 0;
  if (input.purpose === 'renewal') {
    const paid = await paidPeriodOf(config, workspaceId);
    if (!paid) throw new AccountBillingError('NO_PAID_PLAN', 409);
    if (!input.forCardSetup && (await readLiveCard(config, workspaceId))) throw new AccountBillingError('CARD_PAYS_RENEWAL', 409);
    const { live, stale } = prepaidOf(account, paid);
    if (live !== null || (await v2NextPeriodPaid(config, workspaceId))) throw new AccountBillingError('ALREADY_RENEWED', 409);
    const target = account?.scheduled_plan_id ?? paid.plan_id;
    const interval = (account?.scheduled_interval as BillingInterval | null) ?? paid.billing_interval;
    const plan = await readPlan(config, target);
    if (!plan || plan.is_free) throw new AccountBillingError('RENEWAL_TO_FREE', 409);
    const price = priceOf(plan.prices, currency, interval);
    if (price === null) throw new AccountBillingError('PLAN_PRICE_UNAVAILABLE', 400);
    // The renewal price the page showed (the next period's plan may have
    // changed in another tab, or its price).
    if (input.expectedNetMinor !== undefined && input.expectedNetMinor !== price) {
      throw new AccountBillingError('QUOTE_CHANGED', 409, { price_minor: price });
    }
    return {
      needed: price - stale,
      currency,
      balance,
      // The renewal is for this period only: paid after it was renewed or
      // replaced, the money stays in the balance (billing_period_changed).
      detail: { plan_id: target, billing_interval: interval, period_end: paid.current_period_end },
      periodPriceMinor: price,
    };
  }
  if (!input.planId) throw new AccountBillingError('INVALID_REQUEST', 400);
  const quote = await quotePlanChange(config, workspaceId, input.planId, input.interval ?? 'monthly');
  const expected = input.purpose === 'plan' ? 'purchase' : 'upgrade';
  const net = quoteNetMinor(quote);
  if (quote.kind !== expected || (input.expectedNetMinor !== undefined && input.expectedNetMinor !== net)) {
    throw new AccountBillingError('QUOTE_CHANGED', 409, { kind: quote.kind, reason: quote.reason ?? null, quote });
  }
  return {
    needed: net,
    currency,
    balance,
    detail: { plan_id: input.planId, billing_interval: quote.billing_interval },
    periodPriceMinor: quote.period_price_minor,
  };
}

// ─── The plan part of the billing page ────────────────────────────────────

export interface PlanRef {
  plan_id: string;
  name: string;
  localized: Record<string, unknown>;
  billing_interval: BillingInterval;
  /** Its price per period in the account currency; null = not sold that way. */
  price_minor: number | null;
}

export interface AccountPlanState {
  /** The paid period running now; null on Free, a trial, or after a plan ran out. */
  paid_period: PaidPeriod | null;
  /** The change scheduled for the period end (plan and/or interval). */
  scheduled_plan: { id: string; name: string; localized: Record<string, unknown>; is_free: boolean } | null;
  scheduled_interval: BillingInterval | null;
  /** Already paid for the next period (early renewal). */
  next_period_prepaid_minor: number | null;
  /** The next period is paid for (here, or through billing v2). */
  next_period_paid: boolean;
  /** The next period: its plan, interval and price. */
  renewal: PlanRef | null;
  /** The paid plan that ran out (the row keeps it), still sold: "renew" buys it again. */
  lapsed: PlanRef | null;
  days_left: number | null;
}

export async function accountPlanState(config: ServerConfig, workspaceId: string): Promise<AccountPlanState> {
  const [account, region, paid, sub] = await Promise.all([
    readAccount(config, workspaceId),
    getBillingRegion(config),
    paidPeriodOf(config, workspaceId),
    readSubscription(config, workspaceId),
  ]);
  const currency = account?.currency ?? region.currency;
  const scheduledPlan = account?.scheduled_plan_id ? await readPlan(config, account.scheduled_plan_id) : null;
  const scheduledInterval = account?.scheduled_interval === 'yearly' || account?.scheduled_interval === 'monthly'
    ? (account.scheduled_interval as BillingInterval)
    : null;
  const ref = (plan: NonNullable<Awaited<ReturnType<typeof readPlan>>>, interval: BillingInterval): PlanRef => ({
    plan_id: plan.id,
    name: plan.name,
    localized: plan.localized ?? {},
    billing_interval: interval,
    price_minor: priceOf(plan.prices, currency, interval),
  });
  let renewal: PlanRef | null = null;
  let lapsed: PlanRef | null = null;
  if (paid) {
    const target = scheduledPlan ?? (await readPlan(config, paid.plan_id));
    renewal = target && !target.is_free ? ref(target, scheduledInterval ?? paid.billing_interval) : null;
  } else if (sub?.plan_id && !assignedPlanApplies(sub)) {
    const last = await readPlan(config, sub.plan_id);
    const interval: BillingInterval = sub.billing_interval === 'yearly' ? 'yearly' : 'monthly';
    if (last && !last.is_free && last.is_active && !last.is_hidden && !RESERVED_SLUGS.has(last.slug)) {
      const option = ref(last, interval);
      if (option.price_minor !== null) lapsed = option;
    }
  }
  const prepaid = prepaidOf(account, paid).live;
  return {
    paid_period: paid,
    scheduled_plan: scheduledPlan
      ? { id: scheduledPlan.id, name: scheduledPlan.name, localized: scheduledPlan.localized ?? {}, is_free: scheduledPlan.is_free }
      : null,
    scheduled_interval: scheduledInterval,
    next_period_prepaid_minor: prepaid,
    next_period_paid: prepaid !== null || (paid !== null && (await v2NextPeriodPaid(config, workspaceId))),
    renewal,
    lapsed,
    days_left: paid ? Math.max(Math.ceil((Date.parse(paid.current_period_end) - Date.now()) / DAY_MS), 0) : null,
  };
}

/**
 * After a Super Admin assigned or revoked a plan (which replaces the running
 * period directly): a prepayment for the old period's next one returns to the
 * balance and a scheduled change is dropped (billing_account_admin_replaced).
 * Never throws: the assignment itself is done.
 */
export async function afterAdminAssignment(config: ServerConfig, workspaceId: string): Promise<void> {
  if (LEGACY_BILLING_ENABLED) return;
  try {
    const { error } = await getServiceClient(config).rpc('billing_account_admin_replaced', { p_workspace_id: workspaceId });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn('[billing-account] after admin assignment:', e instanceof Error ? e.message : e);
  }
}
