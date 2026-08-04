/**
 * Centralized Font Configuration
 * 
 * All font loading is managed here. To self-host fonts later:
 * 1. Download the font files (.woff2) and place them in /public/fonts/
 * 2. Change `source` from 'google' to 'local'
 * 3. Update `localPaths` with the correct file paths
 * 4. The loadFonts() function will use @font-face instead of Google Fonts
 */

export interface FontConfig {
  family: string;
  /** Google Fonts family name (used for URL building) */
  googleFamily: string;
  /** Weights to load */
  weights: number[];
  /** 'google' = load from Google CDN, 'local' = use @font-face with local files */
  source: 'google' | 'local';
  /** Base path for local font files (e.g., '/fonts/inter/') */
  localBasePath?: string;
  /** CSS font-display value */
  display: 'swap' | 'block' | 'fallback' | 'optional';
}

export interface LocaleFontSet {
  /** Primary UI font */
  primary: FontConfig;
  /** Optional heading font (falls back to primary if not set) */
  heading?: FontConfig;
  /** CSS fallback stack */
  fallbackStack: string;
}

// ─── Font Definitions ────────────────────────────────────────────

/** Body / UI font — Manrope (Latin) */
const manropeFont: FontConfig = {
  family: 'Manrope',
  googleFamily: 'Manrope',
  weights: [400, 500, 600, 700, 800],
  source: 'google',
  localBasePath: '/fonts/manrope/',
  display: 'swap',
};

/** Display / heading font — Sora (Latin) */
const soraFont: FontConfig = {
  family: 'Sora',
  googleFamily: 'Sora',
  weights: [500, 600, 700],
  source: 'google',
  localBasePath: '/fonts/sora/',
  display: 'swap',
};

const vazirmatnFont: FontConfig = {
  family: 'Vazirmatn',
  googleFamily: 'Vazirmatn',
  weights: [400, 500, 600, 700],
  source: 'google',
  localBasePath: '/fonts/vazirmatn/',
  display: 'swap',
};

const notoSansTurkishFont: FontConfig = {
  family: 'Noto Sans',
  googleFamily: 'Noto+Sans',
  weights: [400, 500, 600, 700],
  source: 'google',
  localBasePath: '/fonts/noto-sans/',
  display: 'swap',
};

// ─── Locale → Font Mapping ───────────────────────────────────────

export const LOCALE_FONTS: Record<string, LocaleFontSet> = {
  en: {
    primary: manropeFont,
    heading: soraFont,
    fallbackStack: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  },
  fa: {
    primary: vazirmatnFont,
    // Persian headings stay in Vazirmatn so the script never breaks.
    fallbackStack: "'Manrope', system-ui, -apple-system, sans-serif",
  },
  tr: {
    primary: notoSansTurkishFont,
    heading: soraFont,
    fallbackStack: "'Manrope', system-ui, -apple-system, sans-serif",
  },
};

// Always load Manrope as the base/fallback UI font for all locales
const BASE_FONTS: FontConfig[] = [manropeFont];

// ─── Google Fonts URL Builder ────────────────────────────────────

function buildGoogleFontsUrl(fonts: FontConfig[]): string {
  const families = fonts
    .filter(f => f.source === 'google')
    .map(f => {
      const weights = f.weights.join(';');
      return `family=${f.googleFamily}:wght@${weights}`;
    });

  if (families.length === 0) return '';
  return `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`;
}

// ─── @font-face Builder (for self-hosted) ────────────────────────

function buildFontFaceCSS(font: FontConfig): string {
  if (font.source !== 'local' || !font.localBasePath) return '';

  return font.weights
    .map(
      w => `
@font-face {
  font-family: '${font.family}';
  font-style: normal;
  font-weight: ${w};
  font-display: ${font.display};
  src: url('${font.localBasePath}${font.family.toLowerCase().replace(/\s+/g, '-')}-${w}.woff2') format('woff2');
}`
    )
    .join('\n');
}

// ─── Font Loader ─────────────────────────────────────────────────

let currentLinkEl: HTMLLinkElement | null = null;
let currentStyleEl: HTMLStyleElement | null = null;

/**
 * Load fonts for a given locale. Call this when locale changes.
 * Manages a single <link> for Google Fonts or <style> for local fonts.
 */
export function loadFontsForLocale(locale: string): void {
  const fontSet = LOCALE_FONTS[locale] || LOCALE_FONTS.en;
  const allFonts = [...BASE_FONTS];

  // Add locale-specific font if different from base
  if (!BASE_FONTS.some(bf => bf.family === fontSet.primary.family)) {
    allFonts.push(fontSet.primary);
  }
  if (fontSet.heading && !allFonts.some(f => f.family === fontSet.heading!.family)) {
    allFonts.push(fontSet.heading);
  }

  const googleFonts = allFonts.filter(f => f.source === 'google');
  const localFonts = allFonts.filter(f => f.source === 'local');

  // Handle Google Fonts
  if (googleFonts.length > 0) {
    const url = buildGoogleFontsUrl(googleFonts);
    if (url) {
      if (!currentLinkEl) {
        // Add preconnect hints
        const preconnect = document.createElement('link');
        preconnect.rel = 'preconnect';
        preconnect.href = 'https://fonts.googleapis.com';
        document.head.appendChild(preconnect);

        const preconnectStatic = document.createElement('link');
        preconnectStatic.rel = 'preconnect';
        preconnectStatic.href = 'https://fonts.gstatic.com';
        preconnectStatic.crossOrigin = 'anonymous';
        document.head.appendChild(preconnectStatic);

        currentLinkEl = document.createElement('link');
        currentLinkEl.rel = 'stylesheet';
        document.head.appendChild(currentLinkEl);
      }
      currentLinkEl.href = url;
    }
  } else if (currentLinkEl) {
    currentLinkEl.remove();
    currentLinkEl = null;
  }

  // Handle local fonts
  if (localFonts.length > 0) {
    const css = localFonts.map(buildFontFaceCSS).join('\n');
    if (!currentStyleEl) {
      currentStyleEl = document.createElement('style');
      currentStyleEl.id = 'app-local-fonts';
      document.head.appendChild(currentStyleEl);
    }
    currentStyleEl.textContent = css;
  } else if (currentStyleEl) {
    currentStyleEl.textContent = '';
  }

  // Set CSS custom properties for the current font pair
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
  const fontSet = LOCALE_FONTS[locale] || LOCALE_FONTS.en;
  return `'${fontSet.primary.family}', ${fontSet.fallbackStack}`;
}
