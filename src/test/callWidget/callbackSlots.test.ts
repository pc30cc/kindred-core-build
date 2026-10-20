/**
 * shared/callbackSlots.ts: the callback slots a visitor may book (screen 17's
 * day chips and slot row), from the workspace's callback hours (migration 277).
 */
import { describe, it, expect } from 'vitest';
import {
  CALLBACK_BOOKING_MAX_AHEAD_MS,
  MAX_CALLBACK_SLOTS,
  MAX_CALLBACK_SLOTS_PER_DAY,
  callbackHoursHaveInterval,
  computeCallbackSlots,
  isBookableSlot,
  isoWithOffset,
  type BusinessHours,
} from '../../../shared/callbackSlots';

// Monday 19 October 2026, 09:30 in Tehran (UTC+03:30, no daylight saving).
const NOW = Date.parse('2026-10-19T06:00:00Z');
const MORNINGS = [{ from: '09:00', to: '12:00' }];
const TEHRAN: BusinessHours = {
  enabled: true,
  timezone: 'Asia/Tehran',
  weekly: { sat: MORNINGS, sun: MORNINGS, mon: MORNINGS, tue: MORNINGS, wed: MORNINGS },
};
const slots = (hours: BusinessHours | null, extra: Partial<Parameters<typeof computeCallbackSlots>[0]> = {}) =>
  computeCallbackSlots({ hours, slotMinutes: 30, daysAhead: 4, now: NOW, ...extra });
const dayOf = (at: string) => at.slice(0, 10);

describe('computeCallbackSlots', () => {
  it('gives every slot start in the business zone with its offset (Tehran +03:30)', () => {
    const list = slots(TEHRAN, { daysAhead: 1 });
    expect(list.map((s) => s.at)).toEqual([
      '2026-10-19T09:00:00+03:30', '2026-10-19T09:30:00+03:30', '2026-10-19T10:00:00+03:30',
      '2026-10-19T10:30:00+03:30', '2026-10-19T11:00:00+03:30', '2026-10-19T11:30:00+03:30',
    ]);
    expect(Date.parse(list[2].at)).toBe(Date.parse('2026-10-19T06:30:00Z'));
  });

  it('keeps today\'s past slots, unavailable, and any slot sooner than five minutes', () => {
    const today = slots(TEHRAN, { daysAhead: 1 });
    expect(today.map((s) => s.available)).toEqual([false, false, true, true, true, true]);
    // 09:56 in Tehran: 10:00 is four minutes away.
    const late = slots(TEHRAN, { daysAhead: 1, now: Date.parse('2026-10-19T06:26:00Z') });
    expect(late.find((s) => s.at === '2026-10-19T10:00:00+03:30')?.available).toBe(false);
    // 09:55: exactly five minutes away is still bookable.
    const edge = slots(TEHRAN, { daysAhead: 1, now: Date.parse('2026-10-19T06:25:00Z') });
    expect(edge.find((s) => s.at === '2026-10-19T10:00:00+03:30')?.available).toBe(true);
  });

  it('counts open days only, today included, and skips closed days', () => {
    // Open Monday, Tuesday and Thursday.
    const hours: BusinessHours = { timezone: 'Asia/Tehran', weekly: { mon: MORNINGS, tue: MORNINGS, thu: MORNINGS } };
    const days = [...new Set(slots(hours, { daysAhead: 3 }).map((s) => dayOf(s.at)))];
    expect(days).toEqual(['2026-10-19', '2026-10-20', '2026-10-22']);
  });

  it('follows the overrides: a closed date is skipped, a date with its own intervals is open', () => {
    const hours: BusinessHours = {
      timezone: 'Asia/Tehran',
      weekly: TEHRAN.weekly,
      overrides: [
        { date: '2026-10-20', closed: true },
        { date: '2026-10-22', intervals: [{ from: '16:00', to: '17:00' }] }, // a Thursday, normally closed
      ],
    };
    const list = slots(hours, { daysAhead: 3 });
    expect([...new Set(list.map((s) => dayOf(s.at)))]).toEqual(['2026-10-19', '2026-10-21', '2026-10-22']);
    expect(list.filter((s) => dayOf(s.at) === '2026-10-22').map((s) => s.at)).toEqual([
      '2026-10-22T16:00:00+03:30', '2026-10-22T16:30:00+03:30',
    ]);
  });

  it('marks a slot whose bookings reached the capacity unavailable, and ignores bookings without one', () => {
    const tuesdayTen = '2026-10-20T06:30:00.000Z'; // 10:00 in Tehran
    const at = '2026-10-20T10:00:00+03:30';
    const full = slots(TEHRAN, { capacity: 1, booked: [tuesdayTen] });
    expect(full.find((s) => s.at === at)?.available).toBe(false);
    expect(full.find((s) => s.at === '2026-10-20T10:30:00+03:30')?.available).toBe(true);
    expect(slots(TEHRAN, { capacity: 2, booked: [tuesdayTen] }).find((s) => s.at === at)?.available).toBe(true);
    expect(slots(TEHRAN, { capacity: 2, booked: [tuesdayTen, '2026-10-20T06:40:00Z'] }).find((s) => s.at === at)?.available).toBe(false);
    expect(slots(TEHRAN, { capacity: null, booked: [tuesdayTen] }).find((s) => s.at === at)?.available).toBe(true);
  });

  it('caps a day at 32 slots and the list at 128 (four full days)', () => {
    const allDay = [{ from: '00:00', to: '23:30' }];
    const hours: BusinessHours = {
      timezone: 'UTC',
      weekly: { sun: allDay, mon: allDay, tue: allDay, wed: allDay, thu: allDay, fri: allDay, sat: allDay },
    };
    const list = computeCallbackSlots({ hours, slotMinutes: 10, daysAhead: 14, now: NOW });
    expect(list).toHaveLength(MAX_CALLBACK_SLOTS);
    const perDay = new Map<string, number>();
    for (const s of list) perDay.set(dayOf(s.at), (perDay.get(dayOf(s.at)) || 0) + 1);
    expect([...perDay.values()]).toEqual([MAX_CALLBACK_SLOTS_PER_DAY, 32, 32, 32]);
    expect(list[0].at).toBe('2026-10-19T00:00:00+00:00');
  });

  it('merges overlapping intervals and keeps the list in order', () => {
    const hours: BusinessHours = {
      timezone: 'Asia/Tehran',
      weekly: { mon: [{ from: '10:00', to: '11:00' }, { from: '09:00', to: '10:30' }] },
    };
    expect(slots(hours, { daysAhead: 1 }).map((s) => s.at.slice(11, 16))).toEqual(['09:00', '09:30', '10:00', '10:30']);
  });

  it('skips the wall times a daylight-saving gap removes', () => {
    // Berlin, Sunday 29 March 2026: 02:00 → 03:00.
    const hours: BusinessHours = { timezone: 'Europe/Berlin', weekly: { sun: [{ from: '01:00', to: '04:00' }] } };
    const list = computeCallbackSlots({ hours, slotMinutes: 30, daysAhead: 1, now: Date.parse('2026-03-28T23:00:00Z') });
    expect(list.map((s) => s.at)).toEqual([
      '2026-03-29T01:00:00+01:00', '2026-03-29T01:30:00+01:00', '2026-03-29T03:00:00+02:00', '2026-03-29T03:30:00+02:00',
    ]);
  });

  it('uses the default zone when the hours name none or an unknown one, else UTC', () => {
    const noZone: BusinessHours = { weekly: { mon: MORNINGS } };
    expect(slots(noZone, { daysAhead: 1, defaultTimeZone: 'Asia/Tehran' })[0].at).toBe('2026-10-19T09:00:00+03:30');
    expect(slots({ ...noZone, timezone: 'Mars/Olympus' }, { daysAhead: 1, defaultTimeZone: 'Asia/Tehran' })[0].at)
      .toBe('2026-10-19T09:00:00+03:30');
    expect(slots(noZone, { daysAhead: 1, defaultTimeZone: 'Nowhere/Else' })[0].at).toBe('2026-10-19T09:00:00+00:00');
  });

  it('offers no slot the booking would refuse: none more than 30 days ahead', () => {
    // Open one Monday a month: the fourth open day is three months away.
    const hours: BusinessHours = {
      timezone: 'Asia/Tehran',
      weekly: {},
      overrides: ['2026-10-26', '2026-11-16', '2026-12-14', '2027-01-11'].map((date) => ({ date, intervals: MORNINGS })),
    };
    const list = slots(hours, { daysAhead: 4 });
    expect([...new Set(list.map((s) => dayOf(s.at)))]).toEqual(['2026-10-26', '2026-11-16']);
    expect(list.every((s) => Date.parse(s.at) <= NOW + CALLBACK_BOOKING_MAX_AHEAD_MS)).toBe(true);
    // The same rule as POST /callbacks/request's window.
    expect(CALLBACK_BOOKING_MAX_AHEAD_MS).toBe(30 * 24 * 60 * 60_000);
  });

  it('has no slot without hours or intervals, and keeps unusable lengths in range', () => {
    expect(slots(null)).toEqual([]);
    expect(slots({})).toEqual([]);
    expect(slots({ timezone: 'UTC', weekly: { mon: [{ from: '12:00', to: '09:00' }] } })).toEqual([]);
    // 5 minutes is read as the 10-minute minimum.
    const short = computeCallbackSlots({ hours: TEHRAN, slotMinutes: 5, daysAhead: 1, now: NOW });
    expect(short.slice(0, 2).map((s) => s.at.slice(11, 16))).toEqual(['09:00', '09:10']);
  });
});

describe('isBookableSlot', () => {
  const list = slots(TEHRAN, { daysAhead: 2 });
  it('accepts an available slot\'s instant in any spelling, within a minute', () => {
    expect(isBookableSlot(list, '2026-10-20T06:30:00.000Z')).toBe(true);
    expect(isBookableSlot(list, '2026-10-20T10:00:00+03:30')).toBe(true);
    expect(isBookableSlot(list, '2026-10-20T06:31:00Z')).toBe(true);
  });
  it('refuses an off-grid time, a past slot and junk', () => {
    expect(isBookableSlot(list, '2026-10-20T06:31:01Z')).toBe(false);
    expect(isBookableSlot(list, '2026-10-20T06:45:00Z')).toBe(false);
    expect(isBookableSlot(list, '2026-10-19T05:30:00Z')).toBe(false); // today 09:00, past
    expect(isBookableSlot(list, 'tomorrow')).toBe(false);
    expect(isBookableSlot(list, null)).toBe(false);
  });
});

describe('helpers', () => {
  it('writes an instant with a zone\'s offset', () => {
    expect(isoWithOffset(new Date('2026-10-23T13:00:00Z'), 'Asia/Tehran')).toBe('2026-10-23T16:30:00+03:30');
    expect(isoWithOffset(new Date('2026-07-01T12:00:00Z'), 'America/New_York')).toBe('2026-07-01T08:00:00-04:00');
  });
  it('knows when hours have an interval', () => {
    expect(callbackHoursHaveInterval(TEHRAN)).toBe(true);
    expect(callbackHoursHaveInterval({})).toBe(false);
    expect(callbackHoursHaveInterval({ weekly: { mon: [] }, overrides: [{ date: '2026-10-20', intervals: [{ from: '09:00', to: '10:00' }] }] })).toBe(true);
    expect(callbackHoursHaveInterval({ overrides: [{ date: '2026-10-20', closed: true, intervals: MORNINGS }] })).toBe(false);
  });
});
