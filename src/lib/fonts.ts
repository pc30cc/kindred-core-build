/**
 * Centralized Font Configuration — fully self-hosted.
 *
 * The whole panel uses IRANSans (fa/ar/all locales) with InterWY as the
 * Latin companion. Both are served from `/widget/fonts/*.woff2` inside this
 * project — no Google Fonts, no third-party CDN, no Vazirmatn.
 *
 * The @font-face declarations live in `src/index.css` so they are part of the
 * bundled stylesheet (no FOUT from a runtime <style> injection). This module
 * only resolves the CSS custom properties per locale.
 */

export interface FontConfig {
  family: string;
  weights: number[];
  /** Self-hosted files only */
  source: 'local';
  display: 'swap' | 'block' | 'fallback' | 'optional';
}

export interface LocaleFontSet {
  primary: FontConfig;
  heading?: FontConfig;
  fallbackStack: string;
}

// ─── Font Definitions ────────────────────────────────────────────

/** Primary UI font — IRANSans (300/400/500/600/700/800 mapped to 3 real files) */
const iranSansFont: FontConfig = {
  family: 'IRANSans',
  weights: [300, 400, 500, 600, 700, 800],
  source: 'local',
  display: 'swap',
};

/** Latin companion — Inter (self-hosted, variable-ish single file) */
const interFont: FontConfig = {
  family: 'InterWY',
  weights: [400, 500, 600, 700],
  source: 'local',
  display: 'swap',
};

const FALLBACK_STACK = "'InterWY', system-ui, -apple-system, 'Segoe UI', sans-serif";

// ─── Locale → Font Mapping ───────────────────────────────────────

const DEFAULT_SET: LocaleFontSet = {
  primary: iranSansFont,
  heading: iranSansFont,
  fallbackStack: FALLBACK_STACK,
};

export const LOCALE_FONTS: Record<string, LocaleFontSet> = {
  en: DEFAULT_SET,
  fa: DEFAULT_SET,
  tr: DEFAULT_SET,
};

export const SELF_HOSTED_FONTS: FontConfig[] = [iranSansFont, interFont];

// ─── Font Loader ─────────────────────────────────────────────────

/**
 * Apply the font tokens for a given locale. Fonts themselves are already
 * declared in the bundled CSS, so this is a cheap variable update.
 */
export function loadFontsForLocale(locale: string): void {
  const fontSet = LOCALE_FONTS[locale] || DEFAULT_SET;
  const primaryFamily = `'${fontSet.primary.family}', ${fontSet.fallbackStack}`;
  const headingFamily = fontSet.heading
    ? `'${fontSet.heading.family}', ${primaryFamily}`
    : primaryFamily;
  document.documentElement.style.setProperty('--font-primary', primaryFamily);
  document.documentElement.style.setProperty('--font-heading', headingFamily);
}

/**
 * Get the CSS font-family value for a locale (for SSR or static use).
 */
export function getFontFamily(locale: string): string {
  const fontSet = LOCALE_FONTS[locale] || DEFAULT_SET;
  return `'${fontSet.primary.family}', ${fontSet.fallbackStack}`;
}
