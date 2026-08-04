/**
 * Central date/time localization.
 *
 * Goal: every date rendered in the app follows the active UI locale —
 * for Persian (fa) that means the **Jalali (Shamsi) calendar** in the
 * **Asia/Tehran** timezone, everywhere, without touching each call site.
 *
 * How it works:
 *  1. `setAppDateLocale()` records the active locale (called from i18n).
 *  2. `installLocalizedDateDefaults()` patches `Intl.DateTimeFormat` and the
 *     `Date.prototype.toLocale*String` methods so that calls made **without an
 *     explicit locale** (the overwhelming majority in this codebase) resolve to
 *     the active locale, and any `fa*` locale is upgraded to the Persian
 *     calendar + Tehran timezone.
 *  3. `formatDate` / `formatDateTime` / `formatTime` / `formatPattern` are the
 *     explicit helpers to use in new code (and as a `date-fns` `format` swap).
 */

export type AppDateLocale = 'en' | 'fa' | 'tr';

export const TEHRAN_TIME_ZONE = 'Asia/Tehran';

const BCP47: Record<AppDateLocale, string> = {
  en: 'en-US',
  fa: 'fa-IR-u-ca-persian',
  tr: 'tr-TR',
};

let activeLocale: AppDateLocale = 'en';

export function setAppDateLocale(locale: AppDateLocale) {
  activeLocale = locale;
}

export function getAppDateLocale(): AppDateLocale {
  return activeLocale;
}

/** Map an app locale (or raw BCP47 tag) to a calendar-correct BCP47 tag. */
export function resolveDateLocale(locale?: string | string[] | null): string | string[] | undefined {
  if (locale == null) return BCP47[activeLocale];
  if (Array.isArray(locale)) return locale.map((l) => resolveDateLocale(l) as string);
  if (locale === 'fa' || locale.startsWith('fa-') || locale.startsWith('fa_')) {
    return locale.includes('ca-persian') ? locale : BCP47.fa;
  }
  if (locale === 'en') return BCP47.en;
  if (locale === 'tr') return BCP47.tr;
  return locale;
}

function isPersian(resolved: string | string[] | undefined): boolean {
  const tag = Array.isArray(resolved) ? resolved[0] : resolved;
  return typeof tag === 'string' && tag.startsWith('fa');
}

function withTehran(
  resolved: string | string[] | undefined,
  options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormatOptions | undefined {
  if (!isPersian(resolved)) return options;
  if (options?.timeZone) return options;
  return { ...(options ?? {}), timeZone: TEHRAN_TIME_ZONE };
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmt(value: Date, options: Intl.DateTimeFormatOptions, locale?: string): string {
  const resolved = resolveDateLocale(locale);
  return new Intl.DateTimeFormat(resolved, withTehran(resolved, options)).format(value);
}

/** Date only, medium style. Jalali + Tehran for fa. */
export function formatDate(
  value: Date | string | number | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  const d = toDate(value);
  if (!d) return '—';
  return fmt(d, options ?? { year: 'numeric', month: 'short', day: 'numeric' }, locale);
}

/** Date + time. Jalali + Tehran for fa. */
export function formatDateTime(
  value: Date | string | number | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  const d = toDate(value);
  if (!d) return '—';
  return fmt(
    d,
    options ?? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
    locale,
  );
}

/** Time only. Tehran clock for fa. */
export function formatTime(
  value: Date | string | number | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  const d = toDate(value);
  if (!d) return '—';
  return fmt(d, options ?? { hour: '2-digit', minute: '2-digit' }, locale);
}

/**
 * Drop-in replacement for `date-fns`' `format` for the numeric patterns used in
 * this codebase (`yyyy`, `MM`, `dd`, `HH`, `mm`, `ss`). Renders Jalali values
 * with latin digits when the active locale is Persian, so table layouts stay
 * stable.
 */
export function formatPattern(
  value: Date | string | number | null | undefined,
  pattern = 'yyyy-MM-dd HH:mm',
  locale?: string,
): string {
  const d = toDate(value);
  if (!d) return '—';
  const resolved = resolveDateLocale(locale);
  const persian = isPersian(resolved);
  const tag = persian ? 'fa-IR-u-ca-persian-nu-latn' : (Array.isArray(resolved) ? resolved[0] : resolved) || 'en-US';
  const parts = new Intl.DateTimeFormat(tag, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...(persian ? { timeZone: TEHRAN_TIME_ZONE } : {}),
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value.padStart(2, '0') ?? '';
  const map: Record<string, string> = {
    yyyy: get('year'),
    yy: get('year').slice(-2),
    MM: get('month'),
    dd: get('day'),
    HH: get('hour') === '24' ? '00' : get('hour'),
    mm: get('minute'),
    ss: get('second'),
  };
  return pattern.replace(/yyyy|yy|MM|dd|HH|mm|ss/g, (m) => map[m] ?? m);
}

let installed = false;

/**
 * Long, human date with a stable word order: weekday, day, month, year.
 * (e.g. "سه‌شنبه ۱۳ مرداد ۱۴۰۵" / "Tuesday, August 4, 2026")
 */
export function formatLongDate(
  value: Date | string | number | null | undefined = new Date(),
  locale?: string,
): string {
  const d = toDate(value);
  if (!d) return '—';
  const resolved = resolveDateLocale(locale);
  const persian = isPersian(resolved);
  if (!persian) {
    return fmt(d, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }, locale);
  }
  const tag = (Array.isArray(resolved) ? resolved[0] : resolved) || BCP47.fa;
  const parts = new Intl.DateTimeFormat(tag, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: TEHRAN_TIME_ZONE,
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')} ${get('year')}`.trim();
}

/**
 * Locale-aware relative time ("۱ ماه پیش", "5m ago", "2 saat önce").
 * Uses Intl.RelativeTimeFormat with the active app locale.
 */
export function formatRelative(
  value: Date | string | number | null | undefined,
  locale?: string,
): string {
  const d = toDate(value);
  if (!d) return '—';
  const resolvedRaw = resolveDateLocale(locale);
  const tag = (Array.isArray(resolvedRaw) ? resolvedRaw[0] : resolvedRaw) || 'en-US';
  const rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
  const seconds = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, secs] of units) {
    if (abs >= secs) return rtf.format(Math.round(seconds / secs), unit);
  }
  return rtf.format(Math.round(seconds), 'second');
}

/** Patch global Intl/Date formatting so untagged calls follow the app locale. */
export function installLocalizedDateDefaults() {
  if (installed || typeof Intl === 'undefined') return;
  installed = true;

  const OriginalDTF = Intl.DateTimeFormat;

  const PatchedDTF = function (
    this: unknown,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    const resolved = resolveDateLocale(locales as string | string[] | undefined);
    return new OriginalDTF(resolved as string | string[] | undefined, withTehran(resolved, options));
  } as unknown as typeof Intl.DateTimeFormat;

  Object.defineProperty(PatchedDTF, 'prototype', { value: OriginalDTF.prototype });
  (PatchedDTF as { supportedLocalesOf: typeof OriginalDTF.supportedLocalesOf }).supportedLocalesOf =
    OriginalDTF.supportedLocalesOf.bind(OriginalDTF);
  (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = PatchedDTF;

  const DATE_DEFAULTS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' };
  const TIME_DEFAULTS: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: 'numeric', second: 'numeric' };

  const patch = (
    method: 'toLocaleDateString' | 'toLocaleTimeString' | 'toLocaleString',
    defaults: Intl.DateTimeFormatOptions,
  ) => {
    const original = Date.prototype[method];
    Date.prototype[method] = function (
      this: Date,
      locales?: string | string[],
      options?: Intl.DateTimeFormatOptions,
    ) {
      if (Number.isNaN(this.getTime())) return original.call(this, locales, options);
      try {
        return new Intl.DateTimeFormat(locales, options ?? defaults).format(this);
      } catch {
        return original.call(this, locales, options);
      }
    };
  };

  patch('toLocaleDateString', DATE_DEFAULTS);
  patch('toLocaleTimeString', TIME_DEFAULTS);
  patch('toLocaleString', { ...DATE_DEFAULTS, ...TIME_DEFAULTS });
}
