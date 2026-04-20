/**
 * Country centroid table (lat/lng) — used as the offline fallback when
 * no `geo_enrichment` provider is configured or the provider call fails.
 *
 * Coordinates are intentionally *coarse* (country-level) for privacy.
 * City-level coordinates only appear when an external provider supplies them.
 *
 * Source: derived from public-domain geographic centroids; values rounded.
 */
export interface Centroid { lat: number; lng: number; }

export const COUNTRY_CENTROIDS: Record<string, Centroid> = {
  US: { lat: 39.5,  lng: -98.35 },
  CA: { lat: 56.13, lng: -106.35 },
  MX: { lat: 23.63, lng: -102.55 },
  BR: { lat: -14.24, lng: -51.93 },
  AR: { lat: -38.42, lng: -63.62 },
  GB: { lat: 55.38, lng: -3.44 },
  IE: { lat: 53.14, lng: -7.69 },
  FR: { lat: 46.23, lng: 2.21 },
  DE: { lat: 51.17, lng: 10.45 },
  ES: { lat: 40.46, lng: -3.75 },
  PT: { lat: 39.40, lng: -8.22 },
  IT: { lat: 41.87, lng: 12.57 },
  NL: { lat: 52.13, lng: 5.29 },
  BE: { lat: 50.50, lng: 4.47 },
  CH: { lat: 46.82, lng: 8.23 },
  AT: { lat: 47.52, lng: 14.55 },
  SE: { lat: 60.13, lng: 18.64 },
  NO: { lat: 60.47, lng: 8.47 },
  FI: { lat: 61.92, lng: 25.75 },
  DK: { lat: 56.26, lng: 9.50 },
  PL: { lat: 51.92, lng: 19.15 },
  CZ: { lat: 49.82, lng: 15.47 },
  HU: { lat: 47.16, lng: 19.50 },
  RO: { lat: 45.94, lng: 24.97 },
  GR: { lat: 39.07, lng: 21.82 },
  BG: { lat: 42.73, lng: 25.49 },
  RS: { lat: 44.02, lng: 21.01 },
  HR: { lat: 45.10, lng: 15.20 },
  UA: { lat: 48.38, lng: 31.17 },
  RU: { lat: 61.52, lng: 105.32 },
  TR: { lat: 38.96, lng: 35.24 },
  IL: { lat: 31.05, lng: 34.85 },
  SA: { lat: 23.89, lng: 45.08 },
  AE: { lat: 23.42, lng: 53.85 },
  EG: { lat: 26.82, lng: 30.80 },
  ZA: { lat: -30.56, lng: 22.94 },
  NG: { lat: 9.08, lng: 8.68 },
  KE: { lat: -0.02, lng: 37.91 },
  MA: { lat: 31.79, lng: -7.09 },
  IR: { lat: 32.43, lng: 53.69 },
  IQ: { lat: 33.22, lng: 43.68 },
  PK: { lat: 30.38, lng: 69.35 },
  IN: { lat: 20.59, lng: 78.96 },
  BD: { lat: 23.68, lng: 90.36 },
  LK: { lat: 7.87, lng: 80.77 },
  CN: { lat: 35.86, lng: 104.20 },
  JP: { lat: 36.20, lng: 138.25 },
  KR: { lat: 35.91, lng: 127.77 },
  TW: { lat: 23.70, lng: 120.96 },
  HK: { lat: 22.32, lng: 114.17 },
  SG: { lat: 1.35, lng: 103.82 },
  MY: { lat: 4.21, lng: 101.98 },
  TH: { lat: 15.87, lng: 100.99 },
  VN: { lat: 14.06, lng: 108.28 },
  ID: { lat: -0.79, lng: 113.92 },
  PH: { lat: 12.88, lng: 121.77 },
  AU: { lat: -25.27, lng: 133.77 },
  NZ: { lat: -40.90, lng: 174.89 },
  CL: { lat: -35.68, lng: -71.54 },
  CO: { lat: 4.57, lng: -74.30 },
  PE: { lat: -9.19, lng: -75.02 },
  VE: { lat: 6.42, lng: -66.59 },
};

/**
 * Best-effort lookup. Accepts ISO country code (US) or full country name
 * via a small alias table. Returns null when no centroid is known.
 */
const NAME_TO_CODE: Record<string, string> = {
  'united states': 'US', 'usa': 'US',
  'united kingdom': 'GB', 'uk': 'GB', 'england': 'GB',
  'iran': 'IR', 'islamic republic of iran': 'IR',
  'turkey': 'TR', 'türkiye': 'TR', 'turkiye': 'TR',
  'germany': 'DE', 'france': 'FR', 'spain': 'ES', 'italy': 'IT',
  'canada': 'CA', 'mexico': 'MX', 'brazil': 'BR', 'argentina': 'AR',
  'china': 'CN', 'india': 'IN', 'japan': 'JP', 'south korea': 'KR',
  'australia': 'AU', 'new zealand': 'NZ',
  'south africa': 'ZA', 'egypt': 'EG', 'nigeria': 'NG',
  'russia': 'RU', 'russian federation': 'RU',
  'ukraine': 'UA', 'poland': 'PL',
};

export function lookupCentroid(input: string | null | undefined): Centroid | null {
  if (!input) return null;
  const v = input.trim();
  if (!v) return null;
  if (v.length === 2) {
    return COUNTRY_CENTROIDS[v.toUpperCase()] ?? null;
  }
  const code = NAME_TO_CODE[v.toLowerCase()];
  return code ? COUNTRY_CENTROIDS[code] ?? null : null;
}