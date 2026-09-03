/**
 * Proration is money arithmetic, so it is tested as arithmetic: exact integer
 * rial in, exact integer rial out, no floats, no "close enough".
 */
import { describe, it, expect } from 'vitest';
import { computeUpgradeProration, computeDowngradeEffect } from '../../../server/services/billing/proration';

const START = new Date('2026-01-01T00:00:00.000Z');
const END = new Date('2026-02-01T00:00:00.000Z'); // 31 days

describe('upgrade proration', () => {
  it('charges the full difference when the whole period is unused', () => {
    const r = computeUpgradeProration({
      now: START,
      currentPeriodStart: START,
      currentPeriodEnd: END,
      currentPlanPriceIrr: 1_000_000,
      targetPlanPriceIrr: 3_000_000,
      interval: 'monthly',
    });
    expect(r.unusedCreditIrr).toBe(1_000_000);
    expect(r.targetRemainingIrr).toBe(3_000_000);
    expect(r.payableIrr).toBe(2_000_000);
  });

  it('charges nothing extra when the period is fully consumed', () => {
    const r = computeUpgradeProration({
      now: END,
      currentPeriodStart: START,
      currentPeriodEnd: END,
      currentPlanPriceIrr: 1_000_000,
      targetPlanPriceIrr: 3_000_000,
      interval: 'monthly',
    });
    expect(r.remainingMs).toBe(0);
    expect(r.payableIrr).toBe(0);
  });

  it('prorates the exact remaining time, not whole days', () => {
    // Half of a 31-day window, to the millisecond.
    const mid = new Date(START.getTime() + (END.getTime() - START.getTime()) / 2);
    const r = computeUpgradeProration({
      now: mid,
      currentPeriodStart: START,
      currentPeriodEnd: END,
      currentPlanPriceIrr: 1_000_000,
      targetPlanPriceIrr: 3_000_000,
      interval: 'monthly',
    });
    expect(r.unusedCreditIrr).toBe(500_000);
    expect(r.targetRemainingIrr).toBe(1_500_000);
    expect(r.payableIrr).toBe(1_000_000);
  });

  it('always returns whole rial, rounding the credit DOWN', () => {
    const r = computeUpgradeProration({
      now: new Date('2026-01-10T13:37:11.123Z'),
      currentPeriodStart: START,
      currentPeriodEnd: END,
      currentPlanPriceIrr: 1_234_567,
      targetPlanPriceIrr: 7_654_321,
      interval: 'monthly',
    });
    expect(Number.isInteger(r.unusedCreditIrr)).toBe(true);
    expect(Number.isInteger(r.targetRemainingIrr)).toBe(true);
    expect(Number.isInteger(r.payableIrr)).toBe(true);
    expect(r.payableIrr).toBe(r.targetRemainingIrr - r.unusedCreditIrr);
  });

  it('never produces a negative charge — a cheaper target is a downgrade', () => {
    const r = computeUpgradeProration({
      now: START,
      currentPeriodStart: START,
      currentPeriodEnd: END,
      currentPlanPriceIrr: 5_000_000,
      targetPlanPriceIrr: 1_000_000,
      interval: 'monthly',
    });
    expect(r.isDowngrade).toBe(true);
    expect(r.payableIrr).toBe(0);
  });

  it('rejects an invalid period instead of guessing', () => {
    expect(() =>
      computeUpgradeProration({
        now: START,
        currentPeriodStart: END,
        currentPeriodEnd: START,
        currentPlanPriceIrr: 1,
        targetPlanPriceIrr: 2,
        interval: 'monthly',
      }),
    ).toThrow(/proration_invalid_period/);
  });

  it('rejects non-integer money', () => {
    expect(() =>
      computeUpgradeProration({
        now: START,
        currentPeriodStart: START,
        currentPeriodEnd: END,
        currentPlanPriceIrr: 1000.5,
        targetPlanPriceIrr: 2000,
        interval: 'monthly',
      }),
    ).toThrow(/proration_invalid_amount/);
  });
});

describe('downgrade policy', () => {
  it('moves no money and applies next cycle', () => {
    expect(computeDowngradeEffect()).toEqual({ payableIrr: 0, refundIrr: 0, appliesAt: 'next_cycle' });
  });
});
