/**
 * Super Admin's assign-plan dialog: the "expires at" date field keeps the
 * running period's exact end (review fix, phase 7A). Truncating it to the
 * day's 00:00 UTC made an end later today a moment already past (the route
 * answers 400 INVALID_EXPIRES_AT) and shortened every other end by up to a day.
 */
import { describe, expect, it } from 'vitest';
import { assignExpiresAt, assignExpiryPrefill } from '@/pages/admin/assignPlanExpiry';

const NOW = Date.parse('2026-10-12T10:00:00.000Z');

describe('assign-plan dialog expiry', () => {
  it('an end later today is sent back exactly, in the future (not today 00:00Z)', () => {
    const prefill = assignExpiryPrefill('2026-10-12T18:00:00.000Z', NOW);
    expect(prefill).toEqual({ date: '2026-10-12', iso: '2026-10-12T18:00:00.000Z' });
    const sent = assignExpiresAt(prefill!.date, prefill);
    expect(sent).toBe('2026-10-12T18:00:00.000Z');
    expect(Date.parse(sent!)).toBeGreaterThan(NOW);
  });

  it('an untouched end on another day is not shortened', () => {
    const prefill = assignExpiryPrefill('2026-11-03T21:45:10.000Z', NOW);
    expect(assignExpiresAt(prefill!.date, prefill)).toBe('2026-11-03T21:45:10.000Z');
  });

  it('a past or missing end is not offered; an empty field sends nothing', () => {
    expect(assignExpiryPrefill('2026-10-12T09:59:59.000Z', NOW)).toBeNull();
    expect(assignExpiryPrefill(null, NOW)).toBeNull();
    expect(assignExpiryPrefill('not a date', NOW)).toBeNull();
    expect(assignExpiresAt('', null)).toBeUndefined();
  });

  it('a day the admin chose is that day at 00:00 UTC', () => {
    const prefill = assignExpiryPrefill('2026-10-12T18:00:00.000Z', NOW);
    expect(assignExpiresAt('2026-12-01', prefill)).toBe('2026-12-01T00:00:00.000Z');
    expect(assignExpiresAt('2026-12-01', null)).toBe('2026-12-01T00:00:00.000Z');
  });
});
