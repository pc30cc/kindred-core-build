import { describe, it, expect } from 'vitest';
import {
  addUtcMonths,
  addUtcYears,
  addBillingInterval,
  computeSubscriptionWindow,
  classifyPlanAction,
} from './periods.js';

const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('calendar-safe period arithmetic', () => {
  it('clamps a month-end start instead of overflowing into the next month', () => {
    expect(iso(addUtcMonths(new Date('2026-01-31T10:00:00Z'), 1))).toBe('2026-02-28');
    expect(iso(addUtcMonths(new Date('2028-01-31T10:00:00Z'), 1))).toBe('2028-02-29');
    expect(iso(addUtcMonths(new Date('2026-08-31T10:00:00Z'), 1))).toBe('2026-09-30');
  });

  it('keeps the time-of-day so a period never drifts', () => {
    expect(addUtcMonths(new Date('2026-03-15T09:30:45.123Z'), 1).toISOString())
      .toBe('2026-04-15T09:30:45.123Z');
  });

  it('clamps 29 February when the target year is not a leap year', () => {
    expect(iso(addUtcYears(new Date('2028-02-29T00:00:00Z'), 1))).toBe('2029-02-28');
  });

  it('handles yearly intervals across the year boundary', () => {
    expect(iso(addBillingInterval(new Date('2026-12-31T00:00:00Z'), 'yearly'))).toBe('2027-12-31');
  });
});

describe('early renewal must not burn paid days', () => {
  const now = new Date('2026-03-10T00:00:00Z');

  it('stacks a same-plan renewal on top of the running period', () => {
    const w = computeSubscriptionWindow({
      now,
      interval: 'monthly',
      action: 'plan_renewal',
      currentPeriodEnd: new Date('2026-03-25T00:00:00Z'),
    });
    expect(w.stacked).toBe(true);
    expect(iso(w.start)).toBe('2026-03-25');
    expect(iso(w.end)).toBe('2026-04-25');
  });

  it('starts at now when the previous period already lapsed', () => {
    const w = computeSubscriptionWindow({
      now,
      interval: 'monthly',
      action: 'plan_renewal',
      currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
    });
    expect(w.stacked).toBe(false);
    expect(iso(w.start)).toBe('2026-03-10');
  });

  it('does not stack for upgrades, downgrades or new plans', () => {
    for (const action of ['plan_new', 'plan_upgrade', 'plan_downgrade'] as const) {
      const w = computeSubscriptionWindow({
        now,
        interval: 'monthly',
        action,
        currentPeriodEnd: new Date('2026-03-25T00:00:00Z'),
      });
      expect(w.stacked).toBe(false);
      expect(iso(w.start)).toBe('2026-03-10');
    }
  });
});

describe('purchase classification', () => {
  const base = { currentPlanRank: 1, currentStatus: 'active', nextPlanRank: 2 };

  it('is plan_new without an active subscription', () => {
    expect(classifyPlanAction({ ...base, currentPlanId: null, nextPlanId: 'pro' })).toBe('plan_new');
    expect(classifyPlanAction({ ...base, currentPlanId: 'basic', currentStatus: 'canceled', nextPlanId: 'pro' }))
      .toBe('plan_new');
  });

  it('detects renewal, upgrade and downgrade from plan ranking', () => {
    expect(classifyPlanAction({ ...base, currentPlanId: 'pro', nextPlanId: 'pro' })).toBe('plan_renewal');
    expect(classifyPlanAction({ ...base, currentPlanId: 'basic', nextPlanId: 'pro' })).toBe('plan_upgrade');
    expect(classifyPlanAction({ ...base, currentPlanId: 'pro', currentPlanRank: 3, nextPlanRank: 1, nextPlanId: 'basic' }))
      .toBe('plan_downgrade');
  });
});
