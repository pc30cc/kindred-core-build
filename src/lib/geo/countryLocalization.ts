/**
 * ISO-3166-1 alpha-2 → locale-aware country name.
 *
 * Deterministic and fully offline: uses the ICU data bundled with the JS
 * runtime via `Intl.DisplayNames`, resolved against whatever locale the
 * CALLER passes (the active product/UI locale) — never a hardcoded 'en'.
 * One `Intl.DisplayNames` instance is built and cached per locale (they are
 * not cheap to construct) rather than per lookup.
 *
 * This never touches canonical data: server-persisted `country`/
 * `country_code` fields are untouched by this module — it only produces a
 * PRESENTATION string from a code, on demand, for whichever locale the
 * current viewer has active. Two operators viewing the same visitor in two
 * different UI locales each get their own localized string from the same
 * canonical `country_code`.
 */
import type { Locale } from '@/i18n/config';
import { SUPPORTED_LOCALES } from '@/i18n/config';

/** Normalize 'fa-IR' / 'en-US' / 'tr-TR' / already-bare tags to our supported set. */
export function normalizeLocaleTag(locale: string | null | undefined): Locale {
  if (!locale) return 'en';
  const primary = locale.split(/[-_]/)[0]?.toLowerCase();
  return (SUPPORTED_LOCALES as string[]).includes(primary) ? (primary as Locale) : 'en';
}

const displayNamesCache = new Map<Locale, Intl.DisplayNames | null>();

function getDisplayNames(locale: Locale): Intl.DisplayNames | null {
  if (displayNamesCache.has(locale)) return displayNamesCache.get(locale) ?? null;
  let instance: Intl.DisplayNames | null;
  try {
    instance = new Intl.DisplayNames([locale], { type: 'region' });
  } catch {
    instance = null;
  }
  displayNamesCache.set(locale, instance);
  return instance;
}

/** Normalize any country-ish input to an uppercase alpha-2 code, or null. */
export function toCountryCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = String(input).trim();
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  return null;
}

/**
 * 'TR' + 'fa' → 'ترکیه'. Falls back to `canonicalName` (the value already
 * resolved/stored server-side, always English) when ICU is unavailable, the
 * locale isn't supported by the runtime's ICU data, or the code is unknown
 * — NEVER returns null when a canonical name is available, and never
 * silently drops to English when the requested locale genuinely resolves.
 */
export function localizedCountryName(
  code: string | null | undefined,
  locale: string,
  canonicalName?: string | null,
): string | null {
  const cc = toCountryCode(code);
  if (!cc) return canonicalName ?? null;
  const loc = normalizeLocaleTag(locale);
  try {
    const name = getDisplayNames(loc)?.of(cc);
    if (name && name !== cc) return name;
  } catch {
    /* fall through to canonical */
  }
  return canonicalName ?? cc;
}
