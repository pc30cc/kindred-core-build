/**
 * Plan prices — the units `billing_plans.prices` is stored in, and the
 * amounts people read.
 *
 * `billing_plans.prices` is `{ USD: { monthly, yearly }, EUR: …, TRY: …, IRR: … }`.
 * Every reader of it (checkout, the payment providers' webhooks and refunds,
 * the Super Admin billing overview, the public landing site) treats:
 *
 *   - USD / EUR / TRY as MINOR units (cents, kuruş): 2900 is $29.00;
 *   - IRR as whole Rial, which people read as Toman (÷10, see `money.ts`).
 *
 * The plan editor takes the amount people read — 29 or 29.99 dollars, Toman
 * for Iran — and stores it in those units, so an admin never has to know them.
 */
import { RIAL_PER_TOMAN, formatToman, tomanLabel } from '@/lib/money';

export const PLAN_PRICE_CURRENCIES = ['USD', 'EUR', 'TRY', 'IRR'] as const;

const MINOR_PER_MAJOR = 100;

/** Stored units per unit people read: 100 cents per dollar, 10 Rial per Toman. */
export function planPriceFactor(currency: string): number {
  return currency.toUpperCase() === 'IRR' ? RIAL_PER_TOMAN : MINOR_PER_MAJOR;
}

/** Decimal places people may type: cents for USD/EUR/TRY, none for Toman. */
export function planPriceDecimals(currency: string): number {
  return currency.toUpperCase() === 'IRR' ? 0 : 2;
}

/** A stored amount (minor units / Rial) as the number people read (major units / Toman). */
export function planPriceToDisplay(stored: number | string | null | undefined, currency: string): number {
  const n = Number(stored ?? 0);
  if (!Number.isFinite(n)) return 0;
  return n / planPriceFactor(currency);
}

/** An amount people read (major units / Toman) as the stored integer (minor units / Rial). */
export function planPriceFromDisplay(value: number, currency: string): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * planPriceFactor(currency));
}

/** Persian (U+06F0–06F9) and Arabic-Indic (U+0660–0669) digits. */
const EASTERN_DIGITS = /[\u06f0-\u06f9\u0660-\u0669]/g;

function toAsciiDigits(text: string): string {
  return text.replace(EASTERN_DIGITS, (d) => {
    const code = d.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/**
 * Parses what an admin typed into a price field: `29`, `29.99`, `29,99`,
 * `1,500,000`, `۱٬۵۰۰٬۰۰۰`. A `.` or `,` followed by one or two final digits is
 * the decimal separator; any other is a thousands separator. Returns `null`
 * for anything that is not a non-negative amount; an empty field is 0.
 */
export function parsePlanPriceInput(raw: string): number | null {
  let text = toAsciiDigits(String(raw ?? ''))
    // Spaces (incl. no-break), underscores, apostrophes and the Arabic thousands separator.
    .replace(/[\s\u00a0\u202f_'\u066c]/g, '')
    // The Arabic decimal separator.
    .replace(/\u066b/g, '.');
  if (text === '') return 0;
  if (!/^[0-9.,]+$/.test(text)) return null;
  const decimal = /[.,](\d{1,2})$/.exec(text);
  if (decimal) {
    const whole = text.slice(0, decimal.index).replace(/[.,]/g, '');
    text = `${whole || '0'}.${decimal[1]}`;
  } else {
    text = text.replace(/[.,]/g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** The text a price field starts with for a stored amount (no grouping, so it stays editable). */
export function planPriceInputValue(stored: number | string | null | undefined, currency: string): string {
  const value = planPriceToDisplay(stored, currency);
  if (!value) return '0';
  return String(Math.round(value * 100) / 100);
}

function intlLocale(locale: string): string {
  if (locale === 'fa') return 'fa-IR';
  if (locale === 'tr') return 'tr-TR';
  if (locale === 'en') return 'en-US';
  return locale || 'en-US';
}

/** A stored plan price as people read it, e.g. "$29.00", "۱٬۵۰۰٬۰۰۰ تومان". */
export function formatPlanPrice(stored: number | string | null | undefined, currency: string, locale: string): string {
  const code = currency.toUpperCase();
  const tag = intlLocale(locale);
  if (code === 'IRR') return formatToman(stored, tag);
  const value = planPriceToDisplay(stored, code);
  try {
    return new Intl.NumberFormat(tag, { style: 'currency', currency: code }).format(value);
  } catch {
    return `${new Intl.NumberFormat(tag).format(value)} ${code}`;
  }
}

/** The unit shown beside a price field: "$", "€", "₺", or Toman's name. */
export function planPriceUnitLabel(currency: string, locale: string): string {
  const code = currency.toUpperCase();
  if (code === 'IRR') return tomanLabel(locale);
  try {
    const parts = new Intl.NumberFormat(intlLocale(locale), {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
    }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value || code;
  } catch {
    return code;
  }
}
