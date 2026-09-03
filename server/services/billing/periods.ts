// ============================================================
// BILLING PERIOD ARITHMETIC — calendar-safe, renewal-safe.
//
// Two bugs this module exists to prevent:
//
//  1. `d.setUTCMonth(d.getUTCMonth() + 1)` overflows: 31 January + 1 month
//     becomes 3 March (or 2 March in a leap year) instead of the last day of
//     February. Same class of bug for 29 February + 1 year.
//     Rule here: if the target day-of-month does not exist in the target
//     month, CLAMP to the last real day of that month.
//
//  2. Early renewal burned the customer's remaining days: a renewal always
//     started the new period at `now`. For a renewal of the SAME plan the new
//     period must start at `max(now, current_period_end)` so nothing paid for
//     is lost.
// ============================================================

export type BillingInterval = 'monthly' | 'yearly';

/** What a paid checkout does to the subscription. */
export type PlanActionType =
  | 'plan_new'
  | 'plan_renewal'
  | 'plan_upgrade'
  | 'plan_downgrade';

export type PurchaseActionType = PlanActionType | 'ai_credit_topup' | 'wallet_deposit';

/** Days in a given UTC (year, monthIndex) pair — leap-year correct. */
export function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Adds `count` calendar months to `from`, clamping the day-of-month to the
 * last real day of the target month.
 *
 *   2026-01-31 +1m → 2026-02-28
 *   2028-01-31 +1m → 2028-02-29 (leap)
 *   2026-01-30 +1m → 2026-02-28
 *   2026-08-31 +1m → 2026-09-30
 */
export function addUtcMonths(from: Date, count: number): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();
  const targetMonthAbsolute = m + count;
  const targetYear = y + Math.floor(targetMonthAbsolute / 12);
  const targetMonth = ((targetMonthAbsolute % 12) + 12) % 12;
  const day = Math.min(d, daysInUtcMonth(targetYear, targetMonth));
  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    day,
    from.getUTCHours(),
    from.getUTCMinutes(),
    from.getUTCSeconds(),
    from.getUTCMilliseconds(),
  ));
}

/**
 * Adds `count` years, clamping 29 February in a non-leap target year to
 * 28 February.
 */
export function addUtcYears(from: Date, count: number): Date {
  return addUtcMonths(from, count * 12);
}

/** Adds exactly one billing interval, calendar- and leap-safe. */
export function addBillingInterval(from: Date, interval: BillingInterval): Date {
  return interval === 'yearly' ? addUtcYears(from, 1) : addUtcMonths(from, 1);
}

export interface SubscriptionWindowInput {
  /** Reference "now" (injectable for tests). */
  now: Date;
  interval: BillingInterval;
  action: PlanActionType;
  /** Existing `current_period_end`, if the workspace already has a period. */
  currentPeriodEnd?: Date | null;
}

export interface SubscriptionWindow {
  start: Date;
  end: Date;
  /** True when the new period was stacked on top of unused paid time. */
  stacked: boolean;
}

/**
 * The period a successful payment produces.
 *
 *  - `plan_renewal` (same plan, period still running) stacks:
 *    start = max(now, current_period_end) → no paid day is ever burned.
 *  - `plan_new`, `plan_upgrade`, `plan_downgrade` start immediately at `now`.
 *    There is no proration in the product today, and none is faked here: an
 *    upgrade replaces the period, it does not credit the unused remainder.
 */
export function computeSubscriptionWindow(input: SubscriptionWindowInput): SubscriptionWindow {
  const { now, interval, action, currentPeriodEnd } = input;
  const stack =
    action === 'plan_renewal' &&
    currentPeriodEnd instanceof Date &&
    !Number.isNaN(currentPeriodEnd.getTime()) &&
    currentPeriodEnd.getTime() > now.getTime();
  const start = stack ? new Date((currentPeriodEnd as Date).getTime()) : new Date(now.getTime());
  return { start, end: addBillingInterval(start, interval), stacked: stack };
}

/**
 * Classifies a paid plan checkout against the workspace's current
 * subscription. Ranking comes from the plan's own ordering data, never from a
 * hardcoded plan list.
 */
export function classifyPlanAction(input: {
  currentPlanId: string | null | undefined;
  currentPlanRank: number | null | undefined;
  currentStatus: string | null | undefined;
  nextPlanId: string;
  nextPlanRank: number | null | undefined;
}): PlanActionType {
  const active = input.currentStatus === 'active' || input.currentStatus === 'trialing';
  if (!input.currentPlanId || !active) return 'plan_new';
  if (input.currentPlanId === input.nextPlanId) return 'plan_renewal';
  const a = typeof input.currentPlanRank === 'number' ? input.currentPlanRank : null;
  const b = typeof input.nextPlanRank === 'number' ? input.nextPlanRank : null;
  if (a === null || b === null) return 'plan_new';
  if (b > a) return 'plan_upgrade';
  if (b < a) return 'plan_downgrade';
  return 'plan_renewal';
}
