/**
 * Phone normalization. Canonical storage format is always E.164.
 *
 * Only Iran (+98) is enabled in this phase because the active SMS vendors are
 * Iranian; the country table below is the extension point — adding an entry is
 * enough to support a new country.
 */

export const SUPPORTED_COUNTRIES = ['IR'] as const;
export type SupportedCountry = (typeof SUPPORTED_COUNTRIES)[number];

export function isSupportedCountry(value: unknown): value is SupportedCountry {
  return typeof value === 'string' && (SUPPORTED_COUNTRIES as readonly string[]).includes(value);
}

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Converts Persian/Arabic-Indic digits to ASCII and strips separators. */
export function toAsciiDigits(input: string): string {
  let out = '';
  for (const ch of String(input ?? '')) {
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p >= 0) { out += String(p); continue; }
    const a = ARABIC_DIGITS.indexOf(ch);
    if (a >= 0) { out += String(a); continue; }
    out += ch;
  }
  return out;
}

export type NormalizeResult =
  | { ok: true; e164: string; country: SupportedCountry }
  | { ok: false; reason: 'phone_invalid' | 'phone_country_not_supported' };

const IR_MOBILE_RE = /^9\d{9}$/;

/**
 * Accepts `09121234567`, `9121234567`, `989121234567`, `+989121234567` and the
 * Persian/Arabic digit variants of each. Landlines are rejected.
 */
export function normalizePhoneToE164(input: unknown, country: unknown): NormalizeResult {
  if (!isSupportedCountry(country)) return { ok: false, reason: 'phone_country_not_supported' };
  if (typeof input !== 'string') return { ok: false, reason: 'phone_invalid' };

  let raw = toAsciiDigits(input).trim();
  const hadPlus = raw.startsWith('+');
  raw = raw.replace(/[\s\-().]/g, '');
  if (hadPlus) raw = raw.slice(1);
  if (!/^\d+$/.test(raw)) return { ok: false, reason: 'phone_invalid' };

  // Iran: strip the country prefix / trunk zero, then require a 10-digit
  // national number that starts with 9.
  let national = raw;
  if (national.startsWith('0098')) national = national.slice(4);
  else if (national.startsWith('98') && national.length > 10) national = national.slice(2);
  if (national.startsWith('0')) national = national.slice(1);

  if (!IR_MOBILE_RE.test(national)) return { ok: false, reason: 'phone_invalid' };
  return { ok: true, e164: `+98${national}`, country: 'IR' };
}

/** `+989121234567` → `+98912*****67`. Used everywhere a phone is displayed. */
export function maskE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length <= 7) return null;
  const head = digits.slice(0, 5);
  const tail = digits.slice(-2);
  return `+${head}${'*'.repeat(digits.length - 7)}${tail}`;
}

/** Adapter-facing local format. The database always keeps E.164. */
export function toProviderFormat(e164: string): string {
  return e164.startsWith('+98') ? `0${e164.slice(3)}` : e164;
}