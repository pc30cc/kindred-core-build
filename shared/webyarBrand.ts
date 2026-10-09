/**
 * WebYar's official brand kit (v1, Mehr 1405), worn ONLY by the Iranian
 * edition: `platform_settings.region_mode = 'iran'` (shared/edition.ts). Every
 * other region mode (multi, global, turkey) — the International edition,
 * RESPOK — never uses any of it, and neither does an edition that is not known
 * yet: that keeps exactly what it showed before the kit existed.
 *
 * The Iranian edition is Persian-only, so only the Persian (fa) logotype is
 * shipped and used.
 *
 * Served by the frontend from public/brand/webyar/ (paths relative to the
 * app's origin). Shared by the client (index.html's boot script mirrors these
 * paths, BrandLogo, BrandLoader, PlatformBrandingGate, the widget preview) and
 * the server (the PWA manifest, the widgets' "powered by" logo).
 *
 * Kit colours: turquoise #16C7A8, deep #0B7D6C, ink #12141F, saffron #FFB423
 * (unread badge), mist #E3E6EB, paper #F4F6F8. Minimum sizes: the logotype
 * 80px wide, the symbol 16px.
 */
import { parseEdition } from './edition.js';

const WEBYAR_BRAND_BASE = '/brand/webyar';

export const WEBYAR_BRAND = {
  /** WebYar's name as its logotype reads (the kit's own alt text). */
  name: 'وب‌یار',
  /** The Persian logotype «وب‌یار»: "color" for light surfaces, "onDark" for dark ones. */
  logo: {
    light: `${WEBYAR_BRAND_BASE}/webyar-logo-fa-color.svg`,
    dark: `${WEBYAR_BRAND_BASE}/webyar-logo-fa-on-dark.svg`,
  },
  /** The bubble symbol alone (turquoise): square marks. */
  symbol: `${WEBYAR_BRAND_BASE}/webyar-symbol-turquoise.svg`,
  /** Browser tab icon (lightens itself in a dark browser theme). */
  favicon: `${WEBYAR_BRAND_BASE}/favicon.svg`,
  appleTouchIcon: `${WEBYAR_BRAND_BASE}/apple-touch-icon.png`,
  maskIcon: `${WEBYAR_BRAND_BASE}/safari-pinned-tab.svg`,
  ogImage: `${WEBYAR_BRAND_BASE}/og-image-1200x630.png`,
  /** The PWA's icons (server/routes/manifest.ts). */
  pwa192: `${WEBYAR_BRAND_BASE}/icon-192.png`,
  pwa512: `${WEBYAR_BRAND_BASE}/icon-512.png`,
  pwaMaskable: `${WEBYAR_BRAND_BASE}/icon-maskable-512.png`,
  /** Deep turquoise: theme-color, the mask icon's colour. */
  themeColor: '#0B7D6C',
} as const;

/**
 * True only in the Iranian edition. `edition` is an Edition or a raw value; an
 * unknown edition (null, a failed read) is NOT the kit's — it keeps the look
 * it had before.
 */
export function isWebyarKitEdition(edition: unknown): boolean {
  return parseEdition(edition) === 'iran';
}

/**
 * The platform colour every deployment was seeded with (Super Admin →
 * Branding's default, widget_settings' default). A theme or launcher colour
 * equal to it — or none — was never chosen, so the Iranian edition shows the
 * kit's colour there instead.
 */
export const UNCUSTOMISED_PRIMARY_COLOR = '#3B82F6';

export function isUncustomisedColor(value: unknown): boolean {
  const v = typeof value === 'string' ? value.trim() : '';
  return !v || v.toLowerCase() === UNCUSTOMISED_PRIMARY_COLOR.toLowerCase();
}
