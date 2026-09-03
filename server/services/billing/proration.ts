// ============================================================
// PRORATION — exact integer IRR, time-based, deterministic.
//
// Rules this module encodes (V1 policy, approved):
//
//   * UPGRADE is immediate and prorated: the customer pays the difference for
//     the REMAINING time of the period they already paid for.
//   * DOWNGRADE is next-cycle only. No refund, no proration, no credit note —
//     the customer keeps the paid plan until the period ends and the lower
//     plan starts at the next period.
//
// Money is BIGINT rial. There are no floats and no fractional rial: every
// intermediate value is an integer, division rounds ONCE, at the end, in a
// stated direction. Rounding direction is a financial decision, not an
// accident of `Math.round`:
//
//   - the credit for unused time rounds DOWN (never over-credit the customer
//     against the business by a rial),
//   - the resulting payable amount is floored at 0 (an "upgrade" that computes
//     negative is a downgrade and must not produce a refund).
// ============================================================

import type { BillingInterval } from './periods.js';

export interface ProrationInput {
  /** Reference "now" (injectable for tests). */
  now: Date;
  /** Window the customer already paid for. */
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  /** Full-interval price of the plan currently being served, in IRR. */
  currentPlanPriceIrr: number;
  /** Full-interval price of the target plan, in IRR. */
  targetPlanPriceIrr: number;
  interval: BillingInterval;
}

export interface ProrationResult {
  /** Total milliseconds in the paid window. */
  totalMs: number;
  /** Milliseconds still unused at `now`. */
  remainingMs: number;
  /** Unused value of the current plan, rounded DOWN. */
  unusedCreditIrr: number;
  /** Value of the target plan for the same remaining window, rounded DOWN. */
  targetRemainingIrr: number;
  /** What the customer must pay now. Never negative. */
  payableIrr: number;
  /**
   * True when the target plan is worth less than the credit — i.e. this is a
   * downgrade dressed as an upgrade. The caller must route it to next-cycle
   * instead of charging or refunding.
   */
  isDowngrade: boolean;
}

function assertInteger(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`proration_invalid_amount:${name}`);
  }
}

/**
 * Prorated upgrade amount for the remaining part of an already-paid period.
 *
 * Deliberately time-based (milliseconds), not day-based: a day-based formula
 * silently mis-prices 28/29/30/31-day months and yearly periods.
 */
export function computeUpgradeProration(input: ProrationInput): ProrationResult {
  assertInteger('currentPlanPriceIrr', input.currentPlanPriceIrr);
  assertInteger('targetPlanPriceIrr', input.targetPlanPriceIrr);

  const start = input.currentPeriodStart.getTime();
  const end = input.currentPeriodEnd.getTime();
  const now = input.now.getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('proration_invalid_period');
  }

  const totalMs = end - start;
  const remainingMs = Math.max(0, Math.min(totalMs, end - now));

  // Round DOWN on both sides; the ratio is applied to an integer price.
  const unusedCreditIrr = Math.floor((input.currentPlanPriceIrr * remainingMs) / totalMs);
  const targetRemainingIrr = Math.floor((input.targetPlanPriceIrr * remainingMs) / totalMs);

  const difference = targetRemainingIrr - unusedCreditIrr;

  return {
    totalMs,
    remainingMs,
    unusedCreditIrr,
    targetRemainingIrr,
    payableIrr: Math.max(0, difference),
    isDowngrade: difference < 0,
  };
}

/**
 * A downgrade never produces money movement in V1. This helper exists so the
 * intent is explicit at the call site (and so nobody "temporarily" adds a
 * refund path here).
 */
export function computeDowngradeEffect(): { payableIrr: 0; refundIrr: 0; appliesAt: 'next_cycle' } {
  return { payableIrr: 0, refundIrr: 0, appliesAt: 'next_cycle' };
}
