/**
 * Customer-facing availability must depend ONLY on manual status + personal
 * schedule. These tests are the regression guard against ever re-merging
 * connection state (tab, socket, Centrifugo) back into what visitors see.
 */
import { describe, it, expect } from 'vitest';
import {
  computeCustomerAvailability,
  manualAvailabilityOf,
  partsInTz,
  type AvailabilityPrefsRow,
} from '../../../server/services/widget/customerAvailability';

const tz = 'Europe/Istanbul';
/** Wednesday 2026-01-07, at a given Istanbul wall-clock time. */
const at = (hhmm: string) => new Date(`2026-01-07T${hhmm}:00+03:00`);

const scheduled = (overrides: Record<string, unknown> = {}) => ({
  user_id: 'u1',
  force_offline: false,
  available_when_using_app: true,
  schedule_enabled: true,
  timezone: tz,
  weekly_schedule: {
    wed: { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] },
    thu: { enabled: false, intervals: [] },
  },
  ...overrides,
});

describe('customer-facing availability', () => {
  it('is available inside the personal schedule', () => {
    expect(computeCustomerAvailability(scheduled(), at('10:00')).availability).toBe('available');
  });

  it('is available at the exact boundary 17:59 and unavailable at 18:00', () => {
    expect(computeCustomerAvailability(scheduled(), at('17:59')).availability).toBe('available');
    const end = computeCustomerAvailability(scheduled(), at('18:00'));
    expect(end.availability).toBe('unavailable');
    expect(end.reason).toBe('outside_schedule');
  });

  it('is unavailable on a disabled day', () => {
    const thu = new Date('2026-01-08T10:00:00+03:00');
    const r = computeCustomerAvailability(scheduled(), thu);
    expect(r.availability).toBe('unavailable');
    expect(r.reason).toBe('day_disabled');
  });

  it('treats force_offline as manual offline regardless of schedule', () => {
    const r = computeCustomerAvailability(scheduled({ force_offline: true }), at('10:00'));
    expect(r.manual).toBe('offline');
    expect(r.availability).toBe('unavailable');
  });

  it('treats available_when_using_app=false as invisible', () => {
    const r = computeCustomerAvailability(
      scheduled({ available_when_using_app: false }),
      at('10:00'),
    );
    expect(r.manual).toBe('invisible');
    expect(r.availability).toBe('unavailable');
  });

  it('is always available when no schedule is enabled', () => {
    const r = computeCustomerAvailability(scheduled({ schedule_enabled: false }), at('03:00'));
    expect(r.availability).toBe('available');
    expect(r.reason).toBe('always_available');
  });

  it('maps manual status from the existing columns', () => {
    // Rows as the database may return them: only some columns set.
    const partial = (row: Partial<AvailabilityPrefsRow>) => row as AvailabilityPrefsRow;
    expect(manualAvailabilityOf(partial({ force_offline: true }))).toBe('offline');
    expect(manualAvailabilityOf(partial({ available_when_using_app: false }))).toBe('invisible');
    expect(manualAvailabilityOf(partial({}))).toBe('online');
  });

  it('never accepts a connection signal: identical prefs give identical results', () => {
    // There is deliberately no parameter for tab/socket/Centrifugo state.
    const prefs = scheduled();
    const a = computeCustomerAvailability(prefs, at('12:00'));
    const b = computeCustomerAvailability(prefs, at('12:00'));
    expect(a).toEqual(b);
    expect(a.availability).toBe('available');
  });
});

describe('partsInTz — one formatter per zone, same answers', () => {
  /** What partsInTz answered before it cached its formatters. */
  function reference(date: Date, zone: string) {
    const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' };
    let parts: Intl.DateTimeFormatPart[];
    try {
      parts = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: zone }).formatToParts(date);
    } catch {
      parts = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).formatToParts(date);
    }
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
    const dows: Record<string, string> = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' };
    return { h: Number(get('hour') === '24' ? '0' : get('hour')), m: Number(get('minute')), dow: dows[get('weekday')] ?? 'mon' };
  }

  it('matches the uncached computation across zones, midnight and invalid zones (→ UTC)', () => {
    const zones = ['UTC', 'Asia/Tehran', 'Europe/Istanbul', 'America/Los_Angeles', 'Asia/Kolkata', 'Not/AZone', ''];
    const dates = ['2026-01-07T00:00:00Z', '2026-03-21T20:30:00Z', '2026-06-30T23:59:00Z', '2026-10-14T10:00:00Z'].map((d) => new Date(d));
    for (const zone of zones) {
      for (const date of dates) {
        expect(partsInTz(date, zone), `${zone} @ ${date.toISOString()}`).toEqual(reference(date, zone));
        expect(partsInTz(date, zone)).toEqual(reference(date, zone));
      }
    }
  });
});
