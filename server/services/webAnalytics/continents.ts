/**
 * ISO 3166-1 alpha-2 country code -> continent. Static reference data (not a
 * live lookup, never changes at runtime) used to derive the "Continents"
 * geography report from the country code Web Analytics already has —
 * MaxMind geo enrichment resolves country/city per session
 * (server/services/geo/index.ts); this is the one extra step to roll that
 * up to continent without a second geo provider call.
 */

const CONTINENT_BY_COUNTRY: Record<string, string> = {
  // Africa
  DZ: 'AF', AO: 'AF', BJ: 'AF', BW: 'AF', BF: 'AF', BI: 'AF', CM: 'AF', CV: 'AF',
  CF: 'AF', TD: 'AF', KM: 'AF', CG: 'AF', CD: 'AF', CI: 'AF', DJ: 'AF', EG: 'AF',
  GQ: 'AF', ER: 'AF', SZ: 'AF', ET: 'AF', GA: 'AF', GM: 'AF', GH: 'AF', GN: 'AF',
  GW: 'AF', KE: 'AF', LS: 'AF', LR: 'AF', LY: 'AF', MG: 'AF', MW: 'AF', ML: 'AF',
  MR: 'AF', MU: 'AF', YT: 'AF', MA: 'AF', MZ: 'AF', NA: 'AF', NE: 'AF', NG: 'AF',
  RE: 'AF', RW: 'AF', SH: 'AF', ST: 'AF', SN: 'AF', SC: 'AF', SL: 'AF', SO: 'AF',
  ZA: 'AF', SS: 'AF', SD: 'AF', TZ: 'AF', TG: 'AF', TN: 'AF', UG: 'AF', EH: 'AF',
  ZM: 'AF', ZW: 'AF',
  // Asia
  AF: 'AS', AM: 'AS', AZ: 'AS', BH: 'AS', BD: 'AS', BT: 'AS', BN: 'AS', KH: 'AS',
  CN: 'AS', CY: 'AS', GE: 'AS', HK: 'AS', IN: 'AS', ID: 'AS', IR: 'AS', IQ: 'AS',
  IL: 'AS', JP: 'AS', JO: 'AS', KZ: 'AS', KW: 'AS', KG: 'AS', LA: 'AS', LB: 'AS',
  MO: 'AS', MY: 'AS', MV: 'AS', MN: 'AS', MM: 'AS', NP: 'AS', KP: 'AS', OM: 'AS',
  PK: 'AS', PS: 'AS', PH: 'AS', QA: 'AS', SA: 'AS', SG: 'AS', KR: 'AS', LK: 'AS',
  SY: 'AS', TW: 'AS', TJ: 'AS', TH: 'AS', TL: 'AS', TR: 'AS', TM: 'AS', AE: 'AS',
  UZ: 'AS', VN: 'AS', YE: 'AS',
  // Europe
  AL: 'EU', AD: 'EU', AT: 'EU', BY: 'EU', BE: 'EU', BA: 'EU', BG: 'EU', HR: 'EU',
  CZ: 'EU', DK: 'EU', EE: 'EU', FO: 'EU', FI: 'EU', FR: 'EU', DE: 'EU', GI: 'EU',
  GR: 'EU', HU: 'EU', IS: 'EU', IE: 'EU', IM: 'EU', IT: 'EU', XK: 'EU', LV: 'EU',
  LI: 'EU', LT: 'EU', LU: 'EU', MT: 'EU', MD: 'EU', MC: 'EU', ME: 'EU', NL: 'EU',
  MK: 'EU', NO: 'EU', PL: 'EU', PT: 'EU', RO: 'EU', RU: 'EU', SM: 'EU', RS: 'EU',
  SK: 'EU', SI: 'EU', ES: 'EU', SE: 'EU', CH: 'EU', UA: 'EU', GB: 'EU', VA: 'EU',
  AX: 'EU', JE: 'EU', GG: 'EU',
  // North America
  AI: 'NA', AG: 'NA', AW: 'NA', BS: 'NA', BB: 'NA', BZ: 'NA', BM: 'NA', VG: 'NA',
  CA: 'NA', KY: 'NA', CR: 'NA', CU: 'NA', CW: 'NA', DM: 'NA', DO: 'NA', SV: 'NA',
  GL: 'NA', GD: 'NA', GP: 'NA', GT: 'NA', HT: 'NA', HN: 'NA', JM: 'NA', MQ: 'NA',
  MX: 'NA', MS: 'NA', NI: 'NA', PA: 'NA', PR: 'NA', BL: 'NA', KN: 'NA', LC: 'NA',
  MF: 'NA', PM: 'NA', VC: 'NA', TT: 'NA', TC: 'NA', US: 'NA', VI: 'NA',
  // South America
  AR: 'SA', BO: 'SA', BR: 'SA', CL: 'SA', CO: 'SA', EC: 'SA', FK: 'SA', GF: 'SA',
  GY: 'SA', PY: 'SA', PE: 'SA', SR: 'SA', UY: 'SA', VE: 'SA',
  // Oceania
  AS: 'OC', AU: 'OC', CK: 'OC', FJ: 'OC', PF: 'OC', GU: 'OC', KI: 'OC', MH: 'OC',
  FM: 'OC', NR: 'OC', NC: 'OC', NZ: 'OC', NU: 'OC', NF: 'OC', MP: 'OC', PW: 'OC',
  PG: 'OC', WS: 'OC', SB: 'OC', TO: 'OC', TV: 'OC', VU: 'OC', WF: 'OC',
  // Antarctica
  AQ: 'AN', TF: 'AN', GS: 'AN', BV: 'AN', HM: 'AN',
};

export const CONTINENT_NAMES: Record<string, string> = {
  AF: 'Africa',
  AS: 'Asia',
  EU: 'Europe',
  NA: 'North America',
  SA: 'South America',
  OC: 'Oceania',
  AN: 'Antarctica',
};

/** Returns the continent code (AF/AS/EU/NA/SA/OC/AN), or null when the country code is unknown/missing. */
export function continentForCountry(countryCode: string | null | undefined): string | null {
  if (!countryCode) return null;
  const code = countryCode.trim().toUpperCase();
  return CONTINENT_BY_COUNTRY[code] || null;
}
