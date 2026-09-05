/**
 * Customer-facing availability must depend ONLY on manual status + personal
 * schedule. These tests are the regression guard against ever re-merging
 * connection state (tab, socket, Centrifugo) back into what visitors see.
 */
import { describe, it, expect } from 'vitest';
import {
  computeCustomerAvailability,
  manualAvailabilityOf,
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
    expect(manualAvailabilityOf({ force_offline: true } as any)).toBe('offline');
    expect(manualAvailabilityOf({ available_when_using_app: false } as any)).toBe('invisible');
    expect(manualAvailabilityOf({} as any)).toBe('online');
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
