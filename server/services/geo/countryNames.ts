/**
 * ISO-3166-1 alpha-2 → English country name, and flag emoji.
 *
 * Deterministic and fully offline: uses the ICU data already bundled with
 * Node via `Intl.DisplayNames`. No external API is ever called. When ICU is
 * unavailable (small-icu builds) we fall back to a small map of the codes
 * this deployment actually sees, then to the raw code.
 */

const FALLBACK: Record<string, string> = {
  IR: 'Iran', TR: 'Turkey', US: 'United States', GB: 'United Kingdom',
  DE: 'Germany', FR: 'France', NL: 'Netherlands', IT: 'Italy', ES: 'Spain',
  CA: 'Canada', AU: 'Australia', AE: 'United Arab Emirates', SA: 'Saudi Arabia',
  IQ: 'Iraq', AZ: 'Azerbaijan', RU: 'Russia', IN: 'India', CN: 'China',
  SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland', PL: 'Poland',
  BR: 'Brazil', JP: 'Japan', KR: 'South Korea', AF: 'Afghanistan',
};

let display: Intl.DisplayNames | null | undefined;
function getDisplay(): Intl.DisplayNames | null {
  if (display !== undefined) return display;
  try {
    display = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    display = null;
  }
  return display;
}

/** Normalize any country-ish input to an uppercase alpha-2 code, or null. */
export function toCountryCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = String(input).trim();
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  return null;
}

/** 'TR' → 'Turkey'. Returns null for a non-code input. */
export function countryNameFromCode(code: string | null | undefined): string | null {
  const cc = toCountryCode(code);
  if (!cc) return null;
  try {
    const name = getDisplay()?.of(cc);
    if (name && name !== cc) return name;
  } catch { /* fall through */ }
  return FALLBACK[cc] ?? cc;
}

/** 'TR' → '🇹🇷'. Returns null when the code is not a valid alpha-2. */
export function flagEmojiFromCountryCode(code: string | null | undefined): string | null {
  const cc = toCountryCode(code);
  if (!cc) return null;
  const A = 0x1f1e6;
  const base = 'A'.charCodeAt(0);
  return (
    String.fromCodePoint(A + cc.charCodeAt(0) - base) +
    String.fromCodePoint(A + cc.charCodeAt(1) - base)
  );
}

/** Precision ranking — higher wins. Used so a coarse pass never clobbers a fine one. */
export const GEO_PRECISION_RANK: Record<string, number> = {
  city: 4,
  region: 3,
  country: 2,
  centroid: 1,
};

export function precisionRank(level: string | null | undefined): number {
  if (!level) return 0;
  return GEO_PRECISION_RANK[String(level)] ?? 0;
}
