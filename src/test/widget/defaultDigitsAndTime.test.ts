/**
 * V-39 in the default template (presentation-default.js): every number is in
 * the visitor's digits (a call's duration, an invitation's countdown, a file's
 * size, with its unit in words), and a message's time is in the same zone as
 * the day divider above it (Tehran for Persian, as the dividers), so a time
 * and its day never disagree.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

type Fmt = { msgTime: (d: unknown) => string; callDuration: (s: number) => string; invitationRemaining: (iso: string) => string; humanSize: (b: number) => string };
const SRC = readFileSync('public/widget/presentation-default.js', 'utf8');
const T: Record<string, Record<string, string>> = {
  fa: { ciSeconds: '{s} ثانیه', ciMinutes: '{m} دقیقه', ciMinutesSeconds: '{m} دقیقه و {s} ثانیه', ciTimeLeft: '{time} مانده', sizeB: 'بایت', sizeKB: 'کیلوبایت', sizeMB: 'مگابایت' },
  en: { ciSeconds: '{s}s', ciMinutes: '{m}m', ciMinutesSeconds: '{m}m {s}s', ciTimeLeft: '{time} left', sizeB: 'B', sizeKB: 'KB', sizeMB: 'MB' },
};

function fmt(locale: 'fa' | 'en', config: Record<string, unknown> = {}): Fmt {
  new Function(SRC).call(window);
  const mod = (window as unknown as Record<string, { create: (env: unknown) => { format: Fmt } }>).__gs_presentation_default;
  return mod.create({ t: (k: string) => T[locale][k] ?? k, config, locale, primaryColor: '#3B82F6' }).format;
}

afterEach(() => { vi.useRealTimers(); });

describe('default: digits, words and one time zone', () => {
  it('a call\'s duration and an invitation\'s countdown in Persian digits (Latin in English)', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-18T06:00:00Z') });
    const fa = fmt('fa');
    expect(fa.callDuration(75)).toBe('۰۱:۱۵');
    expect(fa.callDuration(3725)).toBe('۰۱:۰۲:۰۵');
    expect(fa.invitationRemaining('2026-10-18T06:01:30Z')).toBe('۱ دقیقه و ۳۰ ثانیه مانده');
    expect(fa.invitationRemaining('2026-10-18T06:00:45Z')).toBe('۴۵ ثانیه مانده');
    const en = fmt('en');
    expect(en.callDuration(75)).toBe('01:15');
    expect(en.invitationRemaining('2026-10-18T06:02:00Z')).toBe('2m left');
  });

  it('a file\'s size in the visitor\'s digits and words', () => {
    expect(fmt('fa').humanSize(240 * 1024)).toBe('۲۴۰ کیلوبایت');
    expect(fmt('fa').humanSize(Math.round(2.5 * 1024 * 1024))).toBe('۲٫۵ مگابایت');
    expect(fmt('fa').humanSize(900)).toBe('۹۰۰ بایت');
    expect(fmt('en').humanSize(240 * 1024)).toBe('240 KB');
  });

  it('a Persian message\'s time is Tehran\'s, as its day divider (one zone for both)', () => {
    // 21:00 UTC is 00:30 the next day in Tehran: the time agrees with the
    // divider's day, whatever the visitor's device zone.
    const fa = fmt('fa');
    expect(fa.msgTime('2026-10-18T21:00:00Z')).toBe(new Date('2026-10-18T21:00:00Z').toLocaleTimeString('fa', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }));
    expect(fa.msgTime('2026-10-18T21:00:00Z')).toContain('۰۰:۳۰');
    // The International edition's Gregorian Persian: the visitor's zone (or the one given), as its dividers.
    expect(fmt('fa', { calendar: 'gregorian', timeZone: 'Europe/Istanbul' }).msgTime('2026-10-18T21:00:00Z')).toContain('۰۰:۰۰');
  });
});
