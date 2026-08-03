/**
 * Platform region / country mode.
 *
 * A single switch that decides which languages the platform exposes and which
 * currency every money amount is rendered in:
 *   - iran   → Persian only, Toman
 *   - turkey → Turkish only, Turkish Lira
 *   - global → English only, US Dollar
 *   - multi  → every active language, currency follows the active language
 */
import type { Locale } from '@/i18n/config';
import { SUPPORTED_LOCALES } from '@/i18n/config';

export type RegionMode = 'multi' | 'iran' | 'turkey' | 'global';

export const REGION_MODES: RegionMode[] = ['multi', 'iran', 'turkey', 'global'];

export const REGION_LOCALES: Record<RegionMode, Locale[]> = {
  multi: ['en', 'fa', 'tr'],
  iran: ['fa'],
  turkey: ['tr'],
  global: ['en'],
};

/** Currency used when the region pins one. `multi` follows the active locale. */
export const REGION_CURRENCY: Record<RegionMode, string | null> = {
  multi: null,
  iran: 'IRT',
  turkey: 'TRY',
  global: 'USD',
};

export const LOCALE_CURRENCY: Record<Locale, string> = {
  fa: 'IRT',
  tr: 'TRY',
  en: 'USD',
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

/** The currency every amount should be displayed in. */
export function displayCurrency(mode: RegionMode, locale: Locale): string {
  return REGION_CURRENCY[mode] ?? LOCALE_CURRENCY[locale] ?? 'USD';
}

export function intlLocaleFor(locale: Locale): string {
  return locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US';
}

export interface FormatMoneyOptions {
  /** Amount is stored in minor units (cents / rial). Defaults to true. */
  minor?: boolean;
  /** Currency stored on the record. Ignored when the region pins a currency. */
  currency?: string | null;
}

/**
 * Renders a money amount in the region's currency. No currency symbols/icons —
 * a localized number plus the localized currency word.
 */
export function formatMoney(
  amount: number | null | undefined,
  locale: Locale,
  mode: RegionMode,
  options: FormatMoneyOptions = {},
): string {
  const { minor = true, currency } = options;
  // Region pins the currency; otherwise the active language decides it.
  const pinned = REGION_CURRENCY[mode];
  const code = (pinned ?? LOCALE_CURRENCY[locale] ?? currency ?? 'USD').toUpperCase();
  let value = (amount ?? 0) / (minor ? 100 : 1);

  const isRial = RIAL_FAMILY.includes(code);
  // Amounts stored in Rial are shown in Toman (1 Toman = 10 Rial).
  const source = (currency || code).toUpperCase();
  if (isRial && (source === 'IRR' || source === 'RIAL' || code === 'IRR' || code === 'RIAL')) {
    value = value / 10;
  }

  const nf = new Intl.NumberFormat(intlLocaleFor(locale), {
    minimumFractionDigits: 0,
    maximumFractionDigits: isRial ? 0 : 2,
  });
  const label = CURRENCY_LABELS[locale]?.[code] ?? code;
  return `${nf.format(isRial ? Math.round(value) : value)} ${label}`;
}
