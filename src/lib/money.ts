/**
 * Money presentation. In the Iranian edition the platform STORES Iranian Rial
 * (IRR) and DISPLAYS Toman everywhere. In the International edition
 * (src/lib/edition.ts) money is USD in minor units (cents) and Toman is never
 * shown — formatAmountForEdition is the one formatter that knows both.
 *
 * Rial stays the storage/settlement unit because every financial function,
 * ledger row and FX snapshot is denominated in it, and changing the stored
 * unit would rewrite history. Toman (1 Toman = 10 Rial) is what customers and
 * operators actually read, so the conversion happens ONLY at the presentation
 * boundary — never in the ledger.
 */

import { currentEdition, knownRegionModeOrNull, type Edition } from '@/lib/edition';
import { currencyForEditionRegion, isRialCurrency } from '../../shared/edition';

/** The currency an amount with none named is in: IRR in Iran, else the region's (TRY / USD). */
export function defaultCurrencyFor(edition: Edition): string {
  return currencyForEditionRegion(edition, knownRegionModeOrNull() ?? 'multi');
}

export const RIAL_PER_TOMAN = 10;

export function irrToToman(irr: number | string | null | undefined): number {
  const n = Number(irr ?? 0);
  if (!Number.isFinite(n)) return 0;
  return n / RIAL_PER_TOMAN;
}

export function tomanLabel(locale?: string): string {
  if ((locale || '').startsWith('fa')) return 'تومان';
  if ((locale || '').startsWith('tr')) return 'Tümen';
  return 'Toman';
}

/** Formats a stored IRR amount as a Toman string, e.g. "۱٬۲۵۰ تومان". */
export function formatToman(
  irr: number | string | null | undefined,
  locale?: string,
  opts: { withLabel?: boolean; maximumFractionDigits?: number } = {},
): string {
  const { withLabel = true, maximumFractionDigits = 0 } = opts;
  const value = irrToToman(irr);
  const formatted = new Intl.NumberFormat(locale || undefined, {
    maximumFractionDigits,
  }).format(value);
  return withLabel ? `${formatted} ${tomanLabel(locale)}` : formatted;
}

/**
 * Display formatter for any stored amount + currency code.
 *
 * IRR is the STORAGE unit of the platform but Iranian customers and operators
 * read Toman, so an IRR amount is divided by 10 and labelled Toman. Every other
 * currency is shown as-is with its own code.
 */
export function formatMoney(
  amount: number | string | null | undefined,
  currency: string | null | undefined,
  locale?: string,
): string {
  // The International edition: USD by default, minor units, never Toman.
  const edition = currentEdition();
  if (edition !== 'iran') return formatAmountForEdition(amount, currency, locale, edition);
  const code = (currency || 'IRR').toUpperCase();
  if (code === 'IRR' || code === 'IRT' || code === 'TOMAN') return formatToman(amount, locale);
  const n = Number(amount ?? 0);
  const value = Number.isFinite(n) ? n : 0;
  return `${new Intl.NumberFormat(locale || undefined).format(value)} ${code}`;
}

/** A minor-unit amount (cents) of `code` as people read it, e.g. "$29.00". */
function formatMinorUnits(amount: number | string | null | undefined, code: string, locale?: string): string {
  const n = Number(amount ?? 0);
  const value = (Number.isFinite(n) ? n : 0) / 100;
  try {
    return new Intl.NumberFormat(locale || undefined, { style: 'currency', currency: code }).format(value);
  } catch {
    return `${new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: 2 }).format(value)} ${code}`;
  }
}

/**
 * The edition-aware formatter for any stored amount.
 *
 *   - Iranian edition: IRR (whole Rial) reads as Toman, exactly as before;
 *     no currency means IRR.
 *   - International edition: no currency means the region's (USD, or TRY on
 *     a Turkish-only site); every non-Rial amount is
 *     minor units ("$29.00"). A Rial amount (legacy data) is shown as plain
 *     IRR — never relabelled as dollars, never as Toman.
 */
export function formatAmountForEdition(
  amount: number | string | null | undefined,
  currency: string | null | undefined,
  locale?: string,
  edition: Edition = currentEdition(),
): string {
  const code = (currency || defaultCurrencyFor(edition)).toUpperCase();
  if (isRialCurrency(code)) {
    if (edition === 'iran') return formatToman(amount, locale);
    const n = Number(amount ?? 0);
    return `${new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: 0 }).format(Number.isFinite(n) ? n : 0)} IRR`;
  }
  return formatMinorUnits(amount, code, locale);
}
