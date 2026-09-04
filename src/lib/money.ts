/**
 * Money presentation — the platform STORES Iranian Rial (IRR) and DISPLAYS
 * Toman everywhere.
 *
 * Rial stays the storage/settlement unit because every financial function,
 * ledger row and FX snapshot is denominated in it, and changing the stored
 * unit would rewrite history. Toman (1 Toman = 10 Rial) is what customers and
 * operators actually read, so the conversion happens ONLY at the presentation
 * boundary — never in the ledger.
 */

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
  const code = (currency || 'IRR').toUpperCase();
  if (code === 'IRR' || code === 'IRT' || code === 'TOMAN') return formatToman(amount, locale);
  const n = Number(amount ?? 0);
  const value = Number.isFinite(n) ? n : 0;
  return `${new Intl.NumberFormat(locale || undefined).format(value)} ${code}`;
}
