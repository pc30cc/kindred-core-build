/**
 * Platform region / country mode.
 *
 * A single switch that decides which languages the platform exposes and which
 * currency every money amount is rendered in:
 *   - iran   → Persian only, Toman
 *   - turkey → Turkish only, Turkish Lira
 *   - global → English only, US Dollar
 *   - multi  → every active language, US Dollar for every one of them
 *
 * Only `iran` is the Iranian edition (shared/edition.ts). Every other mode is
 * the International edition, where Persian is just Persian text and Turkish
 * just Turkish text: the language never picks the currency (shared/edition.ts
 * editionCurrencyFor — Lira only on a Turkish-only site).
 */
import type { Locale } from '@/i18n/config';
import { SUPPORTED_LOCALES } from '@/i18n/config';
import { editionCurrencyFor, isRialCurrency } from '../../shared/edition';

export type RegionMode = 'multi' | 'iran' | 'turkey' | 'global';

export const REGION_MODES: RegionMode[] = ['multi', 'iran', 'turkey', 'global'];

export const REGION_LOCALES: Record<RegionMode, Locale[]> = {
  multi: ['en', 'fa', 'tr'],
  iran: ['fa'],
  turkey: ['tr'],
  global: ['en'],
};

/**
 * The value BrandingPage stores as `platform_settings.region_currency` (kept
 * as it was: `multi` stores none). What money actually shows is
 * displayCurrency below.
 */
export const REGION_CURRENCY: Record<RegionMode, string | null> = {
  multi: null,
  iran: 'IRT',
  turkey: 'TRY',
  global: 'USD',
};

const RIAL_FAMILY = ['IRR', 'IRT', 'RIAL', 'TOMAN', 'TMN'];

const CURRENCY_LABELS: Record<Locale, Record<string, string>> = {
  fa: { IRT: 'تومان', IRR: 'تومان', RIAL: 'تومان', TOMAN: 'تومان', TMN: 'تومان', USD: 'دلار', EUR: 'یورو', TRY: 'لیر' },
  tr: { IRT: 'Tümen', IRR: 'Tümen', RIAL: 'Tümen', TOMAN: 'Tümen', TMN: 'Tümen', USD: 'USD', EUR: 'EUR', TRY: 'TL' },
  en: { IRT: 'Toman', IRR: 'Toman', RIAL: 'Toman', TOMAN: 'Toman', TMN: 'Toman', USD: 'USD', EUR: 'EUR', TRY: 'TRY' },
};

const CACHE_KEY = 'platform-region-mode';

export function isRegionMode(v: unknown): v is RegionMode {
  return typeof v === 'string' && (REGION_MODES as string[]).includes(v);
}

/** Synchronous best-effort read (used before the settings query resolves). */
export function getCachedRegionMode(): RegionMode {
  if (typeof window === 'undefined') return 'multi';
  const v = window.localStorage.getItem(CACHE_KEY);
  return isRegionMode(v) ? v : 'multi';
}

export function setCachedRegionMode(mode: RegionMode) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CACHE_KEY, mode);
}

/** Languages the platform is allowed to expose for a region mode. */
export function allowedLocalesFor(mode: RegionMode, activeLocales?: string[] | null): Locale[] {
  const pinned = REGION_LOCALES[mode] ?? REGION_LOCALES.multi;
  if (mode !== 'multi') return pinned;
  const active = (activeLocales ?? []).filter((l): l is Locale => (SUPPORTED_LOCALES as string[]).includes(l));
  return active.length ? active : SUPPORTED_LOCALES;
}

/**
 * The currency every amount should be displayed in: Toman in `iran`, Lira in
 * `turkey`, USD in `multi` and `global` — whatever the language (`_locale` is
 * kept for callers; it no longer decides anything).
 */
export function displayCurrency(mode: RegionMode, _locale?: Locale): string {
  return mode === 'iran' ? 'IRT' : editionCurrencyFor(mode);
}

export function intlLocaleFor(locale: Locale): string {
  return locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US';
}

export interface FormatMoneyOptions {
  /** Amount is stored in minor units (cents / rial). Defaults to true. */
  minor?: boolean;
  /** Currency stored on the record. Ignored only in the Iranian region (always Toman). */
  currency?: string | null;
}

/**
 * Renders a money amount: in the Iranian region always as Toman (as before);
 * elsewhere in the record's own currency, else the region's. No currency symbols/icons —
 * a localized number plus the localized currency word.
 */
export function formatMoney(
  amount: number | null | undefined,
  locale: Locale,
  mode: RegionMode,
  options: FormatMoneyOptions = {},
): string {
  const { minor = true, currency } = options;
  // The Iranian region pins Toman (as before). Elsewhere a record keeps its
  // own currency (never relabelled); one with none reads the region's.
  const code = (
    mode === 'iran' ? REGION_CURRENCY.iran! : currency || displayCurrency(mode, locale)
  ).toUpperCase();

  // Outside Iran a Rial amount (legacy data) is plain IRR, never Toman.
  if (mode !== 'iran' && isRialCurrency(code)) {
    const nf = new Intl.NumberFormat(intlLocaleFor(locale), { maximumFractionDigits: 0 });
    return `${nf.format(Math.round(amount ?? 0))} IRR`;
  }

  const isRial = RIAL_FAMILY.includes(code);
  // Rial-family amounts are ALWAYS stored as a plain whole-Rial integer
  // (never minor units) — see src/lib/money.ts. Applying the generic
  // `minor`/100 step on top of the Rial→Toman /10 step would silently
  // divide by 1000 instead of 10 (a 100x display error), so Rial-family
  // currencies skip the minor-units step entirely and go straight to the
  // Rial→Toman conversion. USD/EUR/TRY keep the normal minor-units (cents)
  // behavior.
  const value = isRial ? (amount ?? 0) / 10 : (amount ?? 0) / (minor ? 100 : 1);

  const nf = new Intl.NumberFormat(intlLocaleFor(locale), {
    minimumFractionDigits: 0,
    maximumFractionDigits: isRial ? 0 : 2,
  });
  const label = CURRENCY_LABELS[locale]?.[code] ?? code;
  return `${nf.format(isRial ? Math.round(value) : value)} ${label}`;
}
