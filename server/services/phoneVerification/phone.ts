/**
 * Phone normalization. Canonical storage format is always E.164.
 *
 * Only Iran (+98) is enabled in this phase because the active SMS vendors are
 * Iranian; the country table below is the extension point — adding an entry is
 * enough to support a new country.
 */

/**
 * Country table — adding an entry is enough to support a new country.
 * `dial` is the E.164 prefix (no `+`), `national` validates the subscriber
 * number after the trunk zero / country prefix has been stripped.
 */
export const COUNTRY_TABLE = {
  IR: { dial: '98', national: /^9\d{9}$/ },
  TR: { dial: '90', national: /^5\d{9}$/ },
  AE: { dial: '971', national: /^5\d{8}$/ },
  IQ: { dial: '964', national: /^7\d{9}$/ },
  AF: { dial: '93', national: /^7\d{8}$/ },
  GB: { dial: '44', national: /^7\d{9}$/ },
  DE: { dial: '49', national: /^1[5-7]\d{8,9}$/ },
} as const;

export const SUPPORTED_COUNTRIES = Object.keys(COUNTRY_TABLE) as unknown as readonly (keyof typeof COUNTRY_TABLE)[];
export type SupportedCountry = keyof typeof COUNTRY_TABLE;

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

/**
 * Accepts `09121234567`, `9121234567`, `989121234567`, `+989121234567` and the
 * Persian/Arabic digit variants of each (same shapes for other countries).
 * Landlines are rejected.
 */
export function normalizePhoneToE164(input: unknown, country: unknown): NormalizeResult {
  if (!isSupportedCountry(country)) return { ok: false, reason: 'phone_country_not_supported' };
  if (typeof input !== 'string') return { ok: false, reason: 'phone_invalid' };

  let raw = toAsciiDigits(input).trim();
  const hadPlus = raw.startsWith('+');
  raw = raw.replace(/[\s\-().]/g, '');
  if (hadPlus) raw = raw.slice(1);
  if (!/^\d+$/.test(raw)) return { ok: false, reason: 'phone_invalid' };

  const entry = COUNTRY_TABLE[country];
  // Strip the international prefix / country code / trunk zero, then validate
  // the remaining national number for the selected country.
  let national = raw;
  if (national.startsWith('00' + entry.dial)) national = national.slice(2 + entry.dial.length);
  else if (national.startsWith(entry.dial) && national.length > entry.dial.length + 6) {
    national = national.slice(entry.dial.length);
  }
  if (national.startsWith('0')) national = national.slice(1);

  if (!entry.national.test(national)) return { ok: false, reason: 'phone_invalid' };
  return { ok: true, e164: `+${entry.dial}${national}`, country };
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