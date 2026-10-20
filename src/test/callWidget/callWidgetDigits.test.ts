/**
 * Digits, clocks and dates (contract §2.9): every printed number in Persian
 * digits in fa, typed input as typed; m:ss clocks (h:mm:ss from an hour);
 * days and times in the bootstrap's calendar and zone (Iran: Jalali in
 * Tehran; International: Gregorian in the visitor's zone); callback slots
 * grouped by the visitor-local day, the first four days that have one (D16).
 *
 * The page's clock: Thursday 2026-10-22 11:00 in Tehran.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closeCallWidgets, mountCallWidget, type Mounted } from './mountCallWidget';

afterEach(() => closeCallWidgets());

const NOW = Date.parse('2026-10-22T11:00:00+03:30');
const nb = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ');
function opened(opts: Parameters<typeof mountCallWidget>[0] = {}): Mounted {
  const m = mountCallWidget({ now: NOW, ...opts });
  m.open();
  return m;
}
/** The screen's text outside Latin islands (codes, e-mail and phone fields). */
function visibleText(node: Element): string {
  const clone = node.cloneNode(true) as Element;
  for (const x of clone.querySelectorAll('.code, [dir="ltr"], input, textarea, select, option')) x.remove();
  return clone.textContent ?? '';
}

describe('digits and clocks', () => {
  it('Persian digits in fa, Latin in en and tr', () => {
    expect(opened().H()!.dig('Step 1 of 2: 10:30')).toBe('Step ۱ of ۲: ۱۰:۳۰');
    expect(opened({ locale: 'en' }).H()!.dig('10:30')).toBe('10:30');
    expect(opened({ locale: 'tr' }).H()!.dig('10:30')).toBe('10:30');
  });

  it('clocks: m:ss, h:mm:ss from an hour, never negative', () => {
    const fa = opened().H()!;
    expect(fa.fmtClock(0)).toBe('۰:۰۰');
    expect(fa.fmtClock(47_000)).toBe('۰:۴۷');
    expect(fa.fmtClock(254_000)).toBe('۴:۱۴');
    expect(fa.fmtClock(3_725_000)).toBe('۱:۰۲:۰۵');
    expect(fa.fmtClock(-5_000)).toBe('۰:۰۰');
    expect(opened({ locale: 'en' }).H()!.fmtClock(134_000)).toBe('2:14');
  });
});

describe('days and times', () => {
  const tomorrow = '2026-10-23T16:30:00+03:30';
  const saturday = '2026-10-24T10:00:00+03:30';

  it('Iran in fa: today, tomorrow, Jalali weekdays in Tehran, 24 h Persian times', () => {
    const H = opened().H()!;
    expect(H.fmtDay(NOW)).toBe('امروز');
    expect(H.fmtDay(tomorrow)).toBe('فردا');
    expect(H.fmtDay(saturday)).toBe('شنبه');
    expect(H.fmtTime(tomorrow)).toBe('۱۶:۳۰');
    expect(H.fmtWhen(tomorrow)).toBe('فردا ساعت ۱۶:۳۰');
  });

  it('a day is the zone\'s: 00:30 Tehran on Friday is tomorrow even though it is still Thursday in UTC', () => {
    const H = opened().H()!;
    expect(H.fmtDay('2026-10-23T00:30:00+03:30')).toBe('فردا');
    expect(H.fmtDay('2026-10-22T23:59:00+03:30')).toBe('امروز');
  });

  it('English: short weekdays, 12 h times, a lower-case day inside the sentence', () => {
    const H = opened({ locale: 'en' }).H()!;
    expect(H.fmtDay(tomorrow)).toBe('Tomorrow');
    expect(H.fmtDay(saturday)).toBe('Sat');
    expect(nb(H.fmtTime(tomorrow))).toBe('4:30 PM');
    expect(nb(H.fmtWhen(tomorrow))).toBe('tomorrow at 4:30 PM');
  });

  it('Turkish: 24 h times, its own words', () => {
    const H = opened({ locale: 'tr' }).H()!;
    expect(H.fmtDay(tomorrow)).toBe('Yarın');
    expect(H.fmtTime(tomorrow)).toBe('16:30');
    expect(H.fmtWhen(tomorrow)).toBe('yarın saat 16:30');
  });

  it('today and tomorrow do not hang on a locale\'s own date order (an ICU whose dates print 22.10.2026)', () => {
    const m = mountCallWidget({ now: NOW });
    // The page's Intl formats every numeric date day-first; its parts stay true.
    const win = m.win as unknown as { Intl: { DateTimeFormat: unknown } };
    const Real = win.Intl.DateTimeFormat as new (tag?: string, opts?: Intl.DateTimeFormatOptions) => Intl.DateTimeFormat;
    win.Intl.DateTimeFormat = function (tag?: string, opts?: Intl.DateTimeFormatOptions) {
      const real = new Real(tag, opts);
      return {
        format: (d?: Date | number) => (opts?.year && !opts.weekday
          ? real.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => p.value).reverse().join('.')
          : real.format(d)),
        formatToParts: (d?: Date | number) => real.formatToParts(d),
        resolvedOptions: () => real.resolvedOptions(),
      };
    };
    m.open();
    const H = m.H()!;
    expect(H.fmtDay(NOW)).toBe('امروز');
    expect(H.fmtDay(tomorrow)).toBe('فردا');
    expect(H.fmtDay(saturday)).toBe('شنبه');
  });

  it('International in fa: Gregorian weekdays in the bootstrap\'s zone, still Persian digits (D19)', () => {
    const H = opened({ edition: 'international', bootstrap: { config: { widget_template_id: 'intl' }, time_zone: 'Asia/Tehran' } }).H()!;
    expect(H.fmtDay(saturday)).toBe('شنبه');
    expect(H.fmtTime(tomorrow)).toBe('۱۶:۳۰');
  });
});

describe('callback slots (D16)', () => {
  const at = (day: number, hm: string) => `2026-10-${day}T${hm}:00+03:30`;
  const slots = [
    { at: at(22, '11:02'), available: true }, // within 5 minutes: not offered
    { at: at(22, '14:00'), available: true },
    { at: at(23, '00:30'), available: true }, // Friday in Tehran (Thursday in UTC)
    { at: at(23, '10:00'), available: false },
    { at: at(23, '16:30'), available: true },
    { at: at(24, '10:00'), available: true },
    { at: at(25, '10:00'), available: true },
    { at: at(26, '10:00'), available: true }, // a fifth day: not shown
  ];
  function step1() {
    const m = opened({ bootstrap: { callback_policy: { slots } } });
    m.click('[data-action="callback"]');
    m.click('[data-action="seg"][data-field="callback_when"][data-value="later"]');
    return m;
  }

  it('grouped by the visitor-local day, the first four days, labelled today/tomorrow/weekday', () => {
    const m = step1();
    const days = m.qa('.days [data-action="day"]');
    expect(days.map((d) => d.textContent)).toEqual(['امروز', 'فردا', 'شنبه', 'یکشنبه']);
    expect(days.map((d) => d.getAttribute('data-value'))).toEqual(['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  });

  it('a slot within five minutes or unavailable is disabled; times in Persian digits', () => {
    const m = step1();
    m.click('[data-action="day"][data-value="2026-10-22"]');
    const today = m.qa<HTMLButtonElement>('.slots [data-action="slot"]');
    expect(today.map((s) => [s.textContent, s.disabled])).toEqual([['۱۱:۰۲', true], ['۱۴:۰۰', false]]);
    m.click('[data-action="day"][data-value="2026-10-23"]');
    const friday = m.qa<HTMLButtonElement>('.slots [data-action="slot"]');
    expect(friday.map((s) => [s.textContent, s.disabled])).toEqual([['۰:۳۰', false], ['۱۰:۰۰', true], ['۱۶:۳۰', false]]);
    expect(friday[1].getAttribute('aria-disabled')).toBe('true');
  });

  it('a slot writes its own instant (with the zone\'s offset)', () => {
    const m = step1();
    m.click('[data-action="day"][data-value="2026-10-23"]');
    m.click(`[data-action="slot"][data-value="${at(23, '16:30')}"]`);
    expect(m.ctrl.formData.callback_scheduled_for).toBe(at(23, '16:30'));
  });

  it('without slots: the browser\'s own date and time field', () => {
    const m = opened();
    m.click('[data-action="callback"]');
    m.click('[data-action="seg"][data-field="callback_when"][data-value="later"]');
    expect(m.q('.days')).toBeNull();
    expect(m.q('input[type="datetime-local"]')).not.toBeNull();
  });
});

describe('no Latin digit printed in fa', () => {
  it('step counter, summaries, stars, durations and the booked time', () => {
    const m = opened({ bootstrap: { callback_policy: { slots: [{ at: '2026-10-23T16:30:00+03:30', available: true }], min_message_length: 10 } } });
    m.click('[data-action="callback"]');
    expect(m.screen()!.textContent).toContain('قدم ۱ از ۲');
    m.ctrl.formData.callback_when = 'later';
    m.ctrl.formData.callback_scheduled_for = '2026-10-23T16:30:00+03:30';
    m.click('[data-action="continue"]');
    expect(visibleText(m.screen()!)).not.toMatch(/[0-9]/);
    expect(m.q('.sumchip .tx')!.textContent).toBe('تماس تلفنی · فردا، ۱۶:۳۰ · عادی');
    m.set({ state: 'ended', endedCallId: 'c1', endedDuration: 254, operatorName: 'سارا' });
    expect(visibleText(m.screen()!)).not.toMatch(/[0-9]/);
    expect(m.qa('.star').map((s) => s.getAttribute('aria-label'))).toEqual(['۱', '۲', '۳', '۴', '۵']);
    m.set({ ratingValue: 4, ratingSubmitted: true });
    expect(m.q('.mini-stars')!.getAttribute('aria-label')).toBe('۴/۵');
    expect(m.screen()!.textContent).toContain('مدت مکالمه ۴:۱۴');
    m.set({ state: 'ended', ratingSubmitted: false, endedCallId: null, callbackId: 'a1b2c3d4-9999' });
    expect(visibleText(m.screen()!)).not.toMatch(/[0-9]/);
    expect(m.q('.code')!.textContent).toBe('A1B2C3D4');
  });
});
