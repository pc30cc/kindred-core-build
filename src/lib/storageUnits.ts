/**
 * Storage amounts as every page shows them: in megabytes (migration 271
 * made `storage_mb` the plan limit). "512 MB", "1,024 MB"; Persian
 * "۵۱۲ مگابایت". A negative limit is unlimited: the caller passes the
 * label it shows for that ("Unlimited" / "نامحدود" / "Sınırsız").
 */
import { BYTES_PER_MB } from '../../shared/planLimits';

function numberLocale(locale: string): string {
  return locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : locale === 'en' ? 'en-US' : locale;
}

/** The unit after the number, in the page language. */
export function mbUnit(locale: string): string {
  return locale.toLowerCase().startsWith('fa') ? 'مگابایت' : 'MB';
}

/** A number of megabytes; an amount under 10 MB keeps one decimal ("0.4 MB"). */
export function formatMb(mb: number, locale: string, unlimitedLabel?: string): string {
  if (mb < 0 && unlimitedLabel !== undefined) return unlimitedLabel;
  const value = Math.max(mb, 0);
  const nf = new Intl.NumberFormat(numberLocale(locale), { maximumFractionDigits: 1 });
  // A few kilobytes are not "0 MB" of nothing.
  if (value > 0 && value < 0.1) return `< ${nf.format(0.1)} ${mbUnit(locale)}`;
  const digits = value > 0 && value < 10 && !Number.isInteger(value) ? 1 : 0;
  const n = new Intl.NumberFormat(numberLocale(locale), { maximumFractionDigits: digits }).format(value);
  return `${n} ${mbUnit(locale)}`;
}

/** Bytes used, in megabytes. */
export function formatBytesAsMb(bytes: number, locale: string): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return formatMb(safe / BYTES_PER_MB, locale);
}
