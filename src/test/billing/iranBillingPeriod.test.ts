/**
 * Phase 15 — subscription period correctness (Iran billing redesign).
 *
 * `computePeriodEnd` replaces the old hardcoded `now + 30 days` in
 * processWebhookEvent(): it must derive the real monthly/yearly period from
 * the payment intent's interval, using calendar month/year arithmetic, and
 * only fall back to 30 days when no interval is known (foreign providers
 * whose webhook payload carries none).
 */
import { describe, it, expect } from 'vitest';
import { computePeriodEnd } from '../../../server/services/billing/index';

describe('computePeriodEnd', () => {
  it('adds exactly one calendar month for a monthly interval', () => {
    const start = new Date('2026-01-15T10:00:00.000Z');
    const end = computePeriodEnd(start, 'monthly');
    expect(end.getUTCFullYear()).toBe(2026);
    expect(end.getUTCMonth()).toBe(1); // February (0-indexed)
    expect(end.getUTCDate()).toBe(15);
  });

  it('adds exactly one calendar year for a yearly interval', () => {
    const start = new Date('2026-03-20T10:00:00.000Z');
    const end = computePeriodEnd(start, 'yearly');
    expect(end.getUTCFullYear()).toBe(2027);
    expect(end.getUTCMonth()).toBe(2); // March
    expect(end.getUTCDate()).toBe(20);
  });

  it('falls back to 30 days ONLY when no interval is provided', () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    const end = computePeriodEnd(start, undefined);
    expect(end.getTime() - start.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('never silently truncates a yearly renewal to 30 days', () => {
    const start = new Date('2026-06-01T00:00:00.000Z');
    const end = computePeriodEnd(start, 'yearly');
    const daysDiff = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(daysDiff).toBeGreaterThan(300); // a real year, not 30 days
  });
});
