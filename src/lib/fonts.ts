/**
 * Centralized Font Configuration — Main App (React panel) only.
 *
 * The whole panel uses IRANSans with InterWY as the Latin companion.
 *
 * Ownership contract:
 *  - `@font-face` declarations live in the bundled `src/index.css`.
 *  - The physical `.woff2` files live in `src/assets/fonts/` and are emitted
 *    as content-hashed assets by Vite's own asset pipeline.
 *  - This module ONLY resolves CSS custom properties per locale. It never
 *    injects a `<link>`/`<style>`, never builds a font URL at runtime, and has
 *    no dependency on the widget font delivery (`/widget/fonts/*`,
 *    the widget manifest or the presentation registry).
 */

export interface FontConfig {
  family: string;
  /** Real, declared weights (see the @font-face block in src/index.css). */
  weights: number[];
  /** Self-hosted, bundled by Vite */
  source: 'local';
  display: 'swap' | 'block' | 'fallback' | 'optional';
}

export interface LocaleFontSet {
  primary: FontConfig;
  heading?: FontConfig;
  fallbackStack: string;
}

// ─── Font Definitions ────────────────────────────────────────────

/**
 * Primary UI font — IRANSans, backed by three real files:
 * 400 → Regular, 500 → Medium, 600/700/800 → Bold.
 */
const iranSansFont: FontConfig = {
  family: 'IRANSans',
  weights: [400, 500, 600, 700, 800],
  source: 'local',
  display: 'swap',
};

/** Latin companion — Inter (self-hosted, single variable file, 400–700) */
const interFont: FontConfig = {
  family: 'InterWY',
  weights: [400, 500, 600, 700],
  source: 'local',
  display: 'swap',
};

const FALLBACK_STACK = "'InterWY', system-ui, -apple-system, sans-serif";

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
