/**
 * THE single resolver for turning canonical (English, provider-sourced) geo
 * fields into a locale-aware display string. Country, Contacts, Contact
 * Detail/Drawer, Visitors, Visitor Intelligence, Map & Geo and Inbox's
 * anonymous-visitor label all go through this — see
 * src/lib/contact-display.ts (visitor label) and the call sites in
 * src/pages/app/{ContactsPage,ContactDetailPage,VisitorsPage}.tsx,
 * src/features/contacts/ContactDrawer.tsx,
 * src/features/visitors/VisitorNetworkCard.tsx,
 * src/components/visitors/{VisitorDetailPanel,VisitorDrawer,VisitorMap}.tsx.
 *
 * ── Canonical data is never touched ───────────────────────────────────────
 * Every function here is pure and presentation-only: given a canonical
 * `{ country_code, country, region, city }` (exactly what the API already
 * returns — see VisitorNetworkGeo in server/services/visitors/
 * networkProfile.ts) plus the viewer's active UI locale, it returns a
 * DISPLAY string. It never writes anywhere, never changes what's stored,
 * and two operators in the same workspace viewing the same visitor in two
 * different UI locales each get their own string from the same canonical
 * row.
 *
 * ── Localization policy ────────────────────────────────────────────────────
 *   - country: Intl.DisplayNames, every locale, every country (unchanged).
 *   - region:  Persian province name for country_code=IR + fa locale only
 *     (see ./iranProvinceLocalization.ts, a small 31-entry table) — every
 *     other (locale, country) combination stays canonical.
 *   - city:    ALWAYS canonical, in every locale, for every country. There
 *     is no city-level translation dataset (the earlier ~4.9MB Iran city
 *     dataset was removed — Iranian anonymous identity uses province, not
 *     city; see src/lib/contact-display.ts). `city` remains available here
 *     purely as canonical pass-through metadata for detail/analytics
 *     surfaces that still want to display it.
 */
import { normalizeLocaleTag, localizedCountryName } from './countryLocalization';
import { localizedIranProvince } from './iranProvinceLocalization';
import type { Locale } from '@/i18n/config';

export interface CanonicalGeoLike {
  city?: string | null;
  region?: string | null;
  country?: string | null;
  country_code?: string | null;
}

export interface LocalizedGeoNames {
  city: string | null;
  region: string | null;
  country: string | null;
}

/**
 * Resolve all three localizable fields at once. `city` always passes
 * through canonically (no translation source exists or is planned — see
 * the module doc comment). `region` localizes only for country_code=IR +
 * the fa locale.
 */
export function resolveLocalizedGeoName(geo: CanonicalGeoLike, locale: string): LocalizedGeoNames {
  const loc = normalizeLocaleTag(locale);
  return {
    city: geo.city ?? null,
    region: localizedIranProvince(geo.region ?? null, geo.country_code, loc),
    country: localizedCountryName(geo.country_code, loc, geo.country),
  };
}

const LOCALE_JOINERS: Record<Locale, string> = {
  fa: '، ',
  en: ', ',
  tr: ', ',
};

/**
 * Compose a localized "City, Country" (or "City, Region, Country") label —
 * e.g. `Istanbul، ترکیه` / `Istanbul, Turkey` / `İstanbul, Türkiye`, or for
 * an Iranian visitor `تهران، استان تهران، ایران` — using the locale's own
 * list separator (Persian's is "، ", not a plain comma). Returns null only
 * when every part is empty.
 */
export function localizedLocationLabel(
  geo: CanonicalGeoLike,
  locale: string,
  parts: Array<'city' | 'region' | 'country'> = ['city', 'country'],
): string | null {
  const loc = normalizeLocaleTag(locale);
  const localized = resolveLocalizedGeoName(geo, loc);
  const joiner = LOCALE_JOINERS[loc] ?? ', ';
  const ordered = parts.map((p) => localized[p]).filter((v): v is string => !!v && v.trim().length > 0);
  return ordered.length ? ordered.join(joiner) : null;
}
