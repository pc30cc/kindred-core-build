/**
 * Art's chart kit — the pure part: series colours, numbers, dates and ids.
 *
 * Nothing here reads React, the DOM or the active theme, so the rules are
 * easy to test (src/test/themes/artCharts.test.ts) and the same everywhere a
 * chart is drawn under Art:
 *   - series colours come from the active colour scheme, as
 *     `hsl(var(--art-chart-N))` (palettes.css; 1 = the scheme's main colour);
 *   - numbers wear the reader's digits (Persian digits in Persian), compact on
 *     axes (1.2K, ۱٫۲ هزار), exact in tooltips (1,234, ۱٬۲۳۴);
 *   - dates follow the reader's calendar (the Jalali calendar in Persian in
 *     the Iranian edition, Gregorian elsewhere — src/lib/date.ts),
 *     short on axes ("۲۳ شهریور", "Sep 14"), with the weekday in tooltips.
 */

import { getAppCalendar, type AppCalendar } from '@/lib/date';

/** The locales the panel speaks (src/i18n/config.ts). */
export type ArtChartLocale = 'en' | 'fa' | 'tr';

/** How many series colours a scheme defines (--art-chart-1 ... --art-chart-6). */
export const ART_SERIES_COUNT = 6;

/** A series number folded into 1 ... 6 (7 is 1 again, never a generated hue). */
export function artSeriesIndex(n: number): number {
  const whole = Number.isFinite(n) ? Math.floor(n) : 1;
  return ((((whole - 1) % ART_SERIES_COUNT) + ART_SERIES_COUNT) % ART_SERIES_COUNT) + 1;
}

/** Series `n`'s colour in the active scheme, optionally see-through (0 ... 1). */
export function artSeriesColor(n: number, alpha?: number): string {
  const token = `var(--art-chart-${artSeriesIndex(n)})`;
  if (alpha === undefined || alpha >= 1) return `hsl(${token})`;
  const a = Math.max(0, Math.round(alpha * 1000) / 1000);
  return `hsl(${token} / ${a})`;
}

/**
 * Series `n` at a strength (0 ... 1) as a solid tint: its colour mixed into the
 * card behind it, not made see-through, so a lighter step of an ordered
 * scale stays clean over a track and in dark mode (where a see-through clay
 * over the dark track turns muddy) and its legend key keeps its contrast.
 * Strength 1 (or more) is the series colour itself.
 */
export function artSeriesTint(n: number, strength = 1): string {
  if (!(strength < 1)) return artSeriesColor(n);
  const pct = Math.max(0, Math.round(strength * 1000) / 10);
  return `color-mix(in oklab, ${artSeriesColor(n)} ${pct}%, hsl(var(--card)))`;
}

/** The BCP 47 tag for a locale's digits and grouping. */
export function artNumberTag(locale: string): string {
  if (locale === 'fa') return 'fa-IR';
  if (locale === 'tr') return 'tr-TR';
  return 'en-US';
}

/**
 * The BCP 47 tag for a locale's calendar. Persian: the Jalali calendar in the
 * Iranian edition, the Gregorian one (Persian digits) in International.
 */
export function artDateTag(locale: string, calendar: AppCalendar = getAppCalendar()): string {
  if (locale === 'fa') return calendar === 'jalali' ? 'fa-IR-u-ca-persian' : 'fa-IR-u-ca-gregory';
  if (locale === 'tr') return 'tr-TR';
  return 'en-US';
}

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(artNumberTag(locale), options);
    numberFormats.set(key, format);
  }
  return format;
}

function finite(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** An exact value, grouped, with at most `digits` decimals ("1,234", "۱٬۲۳۴"). */
export function formatArtNumber(value: unknown, locale: string, digits = 1): string {
  const n = finite(value);
  if (n === null) return '—';
  return numberFormat(locale, { maximumFractionDigits: digits }).format(n);
}

/** A value for an axis or a summary: compact from a thousand up ("1.2K", "۱٫۲ هزار"). */
export function formatArtCompact(value: unknown, locale: string): string {
  const n = finite(value);
  if (n === null) return '—';
  if (Math.abs(n) < 1000) return numberFormat(locale, { maximumFractionDigits: Math.abs(n) < 10 ? 1 : 0 }).format(n);
  return numberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** A share (0 ... 1) as a percentage ("73%", "٪۷۳"). */
export function formatArtPercent(share: unknown, locale: string, digits = 0): string {
  const n = finite(share);
  if (n === null) return '—';
  return numberFormat(locale, { style: 'percent', maximumFractionDigits: digits }).format(n);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_DAY = /^(\d{2})-(\d{2})$/;

/**
 * A chart's date value as a Date. A bare day ("2026-09-14") is that day
 * whatever the reader's clock (read and written in UTC); "09-14" (a day in the
 * current year, as some reports send it) too.
 */
export function parseArtChartDate(value: unknown): { date: Date; utc: boolean } | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : { date: value, utc: false };
  if (typeof value === 'number') return Number.isFinite(value) ? { date: new Date(value), utc: false } : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const day = DATE_ONLY.exec(value);
  if (day) return { date: new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))), utc: true };
  const monthDay = MONTH_DAY.exec(value);
  if (monthDay) {
    const year = new Date().getUTCFullYear();
    return { date: new Date(Date.UTC(year, Number(monthDay[1]) - 1, Number(monthDay[2]))), utc: true };
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : { date: parsed, utc: false };
}

export type ArtDateStyle = 'axis' | 'tooltip';

/**
 * A date on an axis ("۲۳ شهریور", "Sep 14", "14 Eyl") or in a tooltip's
 * header, with the weekday ("دوشنبه ۲۳ شهریور", "Mon, Sep 14"). A value that
 * is not a date is returned as it is.
 */
export function formatArtDate(value: unknown, locale: string, style: ArtDateStyle = 'axis'): string {
  const parsed = parseArtChartDate(value);
  if (!parsed) return value == null ? '' : String(value);
  const zone = parsed.utc ? { timeZone: 'UTC' } : {};
  const tag = artDateTag(locale);
  if (style === 'axis') {
    return new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', ...zone }).format(parsed.date);
  }
  if (locale === 'fa') {
    // Persian's own order is weekday, day, month: "دوشنبه ۲۳ شهریور".
    const parts = new Intl.DateTimeFormat(tag, { weekday: 'long', day: 'numeric', month: 'long', ...zone }).formatToParts(parsed.date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('weekday')} ${part('day')} ${part('month')}`.trim();
  }
  return new Intl.DateTimeFormat(tag, { weekday: 'short', day: 'numeric', month: 'short', ...zone }).format(parsed.date);
}

/**
 * The id of a chart's gradient: unique per chart (`uid`, React's useId) and
 * per series, and safe inside `url(#...)` (useId's colons are not).
 */
export function artGradientId(scope: string, uid: string, series: number | string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '');
  return `art-${clean(scope) || 'chart'}-${clean(uid) || '0'}-${clean(String(series))}`;
}

const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
const WHOLE_STEPS = [1, 2, 3, 4, 5, 6, 8, 10];

/**
 * A round step for `span` split into `parts` (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8
 * times a power of ten; whole numbers only when `whole`).
 */
export function artNiceStep(span: number, parts = 4, whole = true): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / parts;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const steps = whole && power < 10 ? WHOLE_STEPS : NICE_STEPS;
  const step = (steps.find((s) => s * power >= raw - 1e-9) ?? 10) * power;
  return whole ? Math.max(1, Math.round(step)) : step;
}

/**
 * The top of a value axis: a round number just above the data (so the
 * labels read 0, 400, 800, 1.2K, 1.6K rather than stopping at 1,356), or
 * `floor` when there is no data, so a series of zeros sits on the baseline
 * under a few faint grid lines instead of in the middle of an empty plot.
 */
export function artAxisTop(dataMax: number, floor = 4, whole = true): number {
  if (!Number.isFinite(dataMax) || dataMax <= 0) return floor;
  const step = artNiceStep(dataMax, 4, whole);
  return Math.ceil(dataMax / step - 1e-9) * step;
}

/**
 * The ticks of a "lower is better" axis (a search position): 1 at the top,
 * then round steps down to a round number at or past the worst value.
 */
export function artRankTicks(worst: number): number[] {
  const top = Number.isFinite(worst) && worst > 1 ? worst : 10;
  // Positions read in fives and tens: 1, 5, 10, 15, 20 / 1, 10, 20, 30.
  const raw = top / 4;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = Math.max(1, Math.round(([1, 2, 5, 10].find((m) => m * power >= raw - 1e-9) ?? 10) * power));
  const last = Math.ceil(top / step) * step;
  const ticks = [1];
  for (let v = step; v <= last; v += step) if (v > 1) ticks.push(v);
  return ticks;
}

/**
 * How wide a value axis must be for its longest label (11px tabular figures,
 * plus the gap to the plot): Persian's compact numbers ("۲٫۷ هزار") need
 * about twice the room of "2.7K".
 */
export function artAxisWidth(labels: ReadonlyArray<string>): number {
  const longest = labels.reduce((m, l) => Math.max(m, [...l].length), 0);
  return Math.max(28, Math.min(76, Math.round(10 + longest * 6.4)));
}

/** True when a series has nothing to show (empty, or every value 0 or missing). */
export function isEmptySeries(values: ReadonlyArray<unknown>): boolean {
  return values.every((v) => {
    const n = finite(v);
    return n === null || n === 0;
  });
}

/** The share of points (0 ... 1) that are 0 or missing. */
export function zeroShare(values: ReadonlyArray<unknown>): number {
  if (values.length === 0) return 1;
  const zeros = values.filter((v) => {
    const n = finite(v);
    return n === null || n === 0;
  }).length;
  return zeros / values.length;
}

/** The sum of a series' finite values. */
export function seriesTotal(values: ReadonlyArray<unknown>): number {
  return values.reduce<number>((sum, v) => sum + (finite(v) ?? 0), 0);
}
