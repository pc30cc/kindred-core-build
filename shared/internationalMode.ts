/**
 * "International mode": the platform is the International edition
 * (shared/edition.ts: `platform_settings.region_mode` is anything but
 * `'iran'`, RESPOK). There the app wears the RESPOK brand kit (its logos,
 * icons and the Art colour scheme `respok`) in EVERY language, Persian
 * included: Persian in the International edition is only right-to-left
 * Persian text, never the Iranian look. The Iranian edition (WebYar) never
 * wears it.
 *
 * Shared by the client (src/lib/internationalMode.ts, index.html's boot
 * script) and the server (the PWA manifest's icons).
 */
import { parseEdition, type Edition } from './edition.js';

export const SITE_MODES = ['single_language', 'multi_language'] as const;
export type SiteMode = (typeof SITE_MODES)[number];

/** A missing or unknown site mode is single_language. */
export function resolveSiteMode(value: unknown): SiteMode {
  return value === 'multi_language' ? 'multi_language' : 'single_language';
}

/**
 * True in the International edition, whatever the UI language. `edition` is
 * an Edition (`'iran'` / `'international'`); anything else — an unknown
 * edition before the platform settings are known — is not international, so
 * an unknown first paint looks exactly as it always did. The locale argument
 * is kept for the existing call sites and no longer changes the answer.
 */
export function isInternationalMode(edition: Edition | null | undefined | unknown, _locale?: unknown): boolean {
  return parseEdition(edition) === 'international';
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
