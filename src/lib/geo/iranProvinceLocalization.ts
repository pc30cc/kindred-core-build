/**
 * Iran (IR) region/province localization — Persian display names for
 * Iran's 31 provinces, replacing the earlier city-level localization
 * system entirely (see git history for that removed ~4.9MB dataset).
 *
 * Product decision: Iranian anonymous visitor identity now uses the
 * visitor's PROVINCE (`geo.region`), never `geo.city` — see
 * src/lib/contact-display.ts. `geo.city` remains untouched as canonical
 * metadata for Visitor Intelligence/Map/analytics; it's just no longer
 * part of the anonymous-identity string for Iran.
 *
 * ── Source ───────────────────────────────────────────────────────────────
 * This is a small (31-entry), hand-maintained table, not a generated
 * dataset — Iran's provinces are a fixed, uncontroversial administrative
 * fact (last changed in 2010, when Alborz split from Tehran province; no
 * changes since). The alias keys were cross-checked against GeoNames'
 * `alternateNames` table (isolanguage="en") for Iran's 31 ADM1-level
 * records — e.g. confirming "East Azarbaijan" (one word, no middle "e") is
 * a real, GeoNames-attested English spelling alongside "East Azerbaijan",
 * not a guess. See the alias comments below for which ones are
 * GeoNames-confirmed vs. common/well-known additional spellings.
 *
 * canonical `region` comes from MaxMind Local's `subdivisions[0].names.en`
 * (server/services/geo/maxmindLocal.ts) or an equivalent provider field —
 * always the English admin1 name, never translated at the source.
 */

/** Fold to a stable lookup key: lowercase, trim, strip diacritics/punctuation. Same normalization contract as the rest of the geo module. */
function normalizeRegionKey(region: string): string {
  return region
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** English alias -> Persian province name. Each province lists its primary expected value first. */
const IRAN_PROVINCES: ReadonlyArray<{ fa: string; aliases: string[] }> = [
  { fa: 'تهران', aliases: ['Tehran'] },
  { fa: 'البرز', aliases: ['Alborz'] }, // GeoNames fa alt "البرز" confirms; en well-known, split from Tehran province in 2010
  { fa: 'قم', aliases: ['Qom', 'Qum'] },
  { fa: 'مرکزی', aliases: ['Markazi'] }, // GeoNames en (isPreferredName)
  { fa: 'قزوین', aliases: ['Qazvin'] },
  { fa: 'گیلان', aliases: ['Gilan', 'Guilan'] },
  { fa: 'اردبیل', aliases: ['Ardabil', 'Ardebil'] },
  { fa: 'زنجان', aliases: ['Zanjan'] }, // GeoNames en (isPreferredName)
  { fa: 'آذربایجان شرقی', aliases: ['East Azerbaijan', 'East Azarbaijan'] }, // "East Azarbaijan" is GeoNames en-tagged
  { fa: 'آذربایجان غربی', aliases: ['West Azerbaijan', 'West Azarbaijan'] },
  { fa: 'کردستان', aliases: ['Kurdistan', 'Kordestan'] },
  { fa: 'همدان', aliases: ['Hamadan', 'Hamedan'] },
  { fa: 'کرمانشاه', aliases: ['Kermanshah'] },
  { fa: 'ایلام', aliases: ['Ilam'] },
  { fa: 'لرستان', aliases: ['Lorestan', 'Luristan'] },
  { fa: 'خوزستان', aliases: ['Khuzestan'] },
  { fa: 'چهارمحال و بختیاری', aliases: ['Chaharmahal and Bakhtiari', 'Chahar Mahaal and Bakhtiari', 'Chahar Mahall and Bakhtiari'] },
  { fa: 'کهگیلویه و بویراحمد', aliases: ['Kohgiluyeh and Boyer-Ahmad', 'Kohgiluyeh and Buyer Ahmad', 'Kohgiluyeh va Bowyer Ahmad'] },
  { fa: 'بوشهر', aliases: ['Bushehr'] }, // GeoNames en (isPreferredName)
  { fa: 'فارس', aliases: ['Fars'] }, // GeoNames en (isPreferredName)
  { fa: 'هرمزگان', aliases: ['Hormozgan'] }, // GeoNames en (isPreferredName)
  { fa: 'سیستان و بلوچستان', aliases: ['Sistan and Baluchestan', 'Sistan va Baluchestan', 'Sistan-Baluchestan'] },
  { fa: 'کرمان', aliases: ['Kerman'] },
  { fa: 'یزد', aliases: ['Yazd'] },
  { fa: 'اصفهان', aliases: ['Isfahan', 'Esfahan'] },
  { fa: 'سمنان', aliases: ['Semnan'] }, // GeoNames en (isPreferredName)
  { fa: 'مازندران', aliases: ['Mazandaran'] }, // GeoNames en (isPreferredName)
  { fa: 'گلستان', aliases: ['Golestan'] },
  { fa: 'خراسان شمالی', aliases: ['North Khorasan', 'Khorasan-e Shomali', 'Northern Khorasan'] },
  { fa: 'خراسان رضوی', aliases: ['Razavi Khorasan', 'Khorasan-e Razavi'] }, // GeoNames en (isPreferredName)
  { fa: 'خراسان جنوبی', aliases: ['South Khorasan', 'Khorasan-e Jonubi', 'Southern Khorasan'] },
];

const REGION_LOOKUP: ReadonlyMap<string, string> = new Map(
  IRAN_PROVINCES.flatMap(({ fa, aliases }) => aliases.map((alias) => [normalizeRegionKey(alias), fa] as const)),
);

/**
 * Persian name for one of Iran's 31 provinces, or null when the region
 * string isn't recognized. Never guesses — callers fall back to the
 * canonical region name.
 */
export function curatedIranProvinceName(region: string | null | undefined): string | null {
  if (!region) return null;
  return REGION_LOOKUP.get(normalizeRegionKey(region)) ?? null;
}

/**
 * Localize a region/province name. Only ever translates when BOTH the
 * active locale is Persian AND the canonical country_code is IR — every
 * other (locale, country) combination returns the canonical region
 * unchanged. No new dataset for any other country.
 */
export function localizedIranProvince(
  region: string | null | undefined,
  countryCode: string | null | undefined,
  locale: string,
): string | null {
  if (!region) return null;
  if (!countryCode || countryCode.toUpperCase() !== 'IR') return region;
  const loc = locale.split(/[-_]/)[0]?.toLowerCase();
  if (loc !== 'fa') return region;
  return curatedIranProvinceName(region) ?? region;
}
