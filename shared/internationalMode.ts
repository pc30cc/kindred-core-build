/**
 * "International mode": the platform runs several languages
 * (`platform_settings.site_mode = 'multi_language'`, RESPOK) and the UI is in
 * one other than Persian. Only there does the app wear the RESPOK brand kit
 * (its logos, icons and the Art colour scheme `respok`). In Persian, and on a
 * single-language site (WebYar), it never does.
 *
 * Shared by the client (src/lib/internationalMode.ts) and the server (the PWA
 * manifest's icons).
 */

export const SITE_MODES = ['single_language', 'multi_language'] as const;
export type SiteMode = (typeof SITE_MODES)[number];

/** A missing or unknown site mode is single_language: nothing changes. */
export function resolveSiteMode(value: unknown): SiteMode {
  return value === 'multi_language' ? 'multi_language' : 'single_language';
}

export function isInternationalMode(siteMode: unknown, locale: unknown): boolean {
  return resolveSiteMode(siteMode) === 'multi_language' && typeof locale === 'string' && locale !== '' && locale !== 'fa';
}

/**
 * The RESPOK brand kit's files worn in international mode, served by the
 * frontend from public/brand/intl/ (paths relative to the app's origin).
 * "color" is drawn for light backgrounds, "reversed" for dark ones; the app
 * icon (the Signal tile) reads on both.
 */
const INTL_BRAND_BASE = '/brand/intl';

export const INTL_BRAND = {
  /** Symbol and wordmark side by side: auth headers, the launch screen. */
  horizontal: {
    light: `${INTL_BRAND_BASE}/respok-thread-horizontal-color.svg`,
    dark: `${INTL_BRAND_BASE}/respok-thread-horizontal-reversed.svg`,
  },
  /** The wordmark alone: the small mark under the auth cards. */
  wordmark: {
    light: `${INTL_BRAND_BASE}/respok-thread-wordmark-color.svg`,
    dark: `${INTL_BRAND_BASE}/respok-thread-wordmark-reversed.svg`,
  },
  /** The app icon: square marks (BrandLogo) and the favicon. */
  appIcon: `${INTL_BRAND_BASE}/favicon.svg`,
  appleTouchIcon: `${INTL_BRAND_BASE}/apple-touch-icon.png`,
  /** The PWA's icons (server/routes/manifest.ts). */
  pwa192: `${INTL_BRAND_BASE}/android-chrome-192x192.png`,
  pwa512: `${INTL_BRAND_BASE}/android-chrome-512x512.png`,
  pwaMaskable: `${INTL_BRAND_BASE}/maskable-icon-512.png`,
} as const;
