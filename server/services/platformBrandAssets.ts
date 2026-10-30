/**
 * The platform's brand images, as absolute URLs: the one place the server
 * reads a logo from.
 *
 * This is the kit-only version: every edition gets its official kit (WebYar's
 * in the Iranian edition, RESPOK's in the International one), made absolute
 * against the app's own address. The Super Admin's own upload (Branding →
 * Visual identity) is resolved here too once it exists, under the same
 * contract, so every caller (the email layout first) follows a logo changed
 * in one place.
 *
 * Email clients do not show SVG, so `logoPng` names PNG renders of the
 * lockup, 3× a 40 px display height: light for light backgrounds, dark for
 * dark ones, and the light one's natural size.
 */
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { getPlatformEditionOrNull } from './platformRegion.js';
import { parseEdition, type Edition } from '../../shared/edition.js';
import { WEBYAR_BRAND } from '../../shared/webyarBrand.js';
import { INTL_BRAND } from '../../shared/internationalMode.js';

export interface BrandAssets {
  source: 'custom' | 'kit';
  /** Absolute URLs (SVG or raster). */
  logo: { light: string; dark: string };
  /** Absolute PNG URLs, and the natural size of the light PNG. */
  logoPng: { light: string; dark: string; width: number; height: number };
  /** Absolute URL. */
  symbol: string;
  icons: { appleTouch180: string; png192: string; png512: string };
}

/** Each edition's kit, as paths on the app's own origin. */
const KIT: Readonly<Record<Edition, Omit<BrandAssets, 'source'>>> = {
  iran: {
    logo: { light: WEBYAR_BRAND.logo.light, dark: WEBYAR_BRAND.logo.dark },
    logoPng: { light: '/brand/webyar/email/webyar-logo.png', dark: '/brand/webyar/email/webyar-logo-dark.png', width: 360, height: 139 },
    symbol: WEBYAR_BRAND.symbol,
    icons: { appleTouch180: WEBYAR_BRAND.appleTouchIcon, png192: WEBYAR_BRAND.pwa192, png512: WEBYAR_BRAND.pwa512 },
  },
  international: {
    logo: { light: INTL_BRAND.horizontal.light, dark: INTL_BRAND.horizontal.dark },
    logoPng: { light: '/brand/intl/email/respok-logo.png', dark: '/brand/intl/email/respok-logo-dark.png', width: 400, height: 92 },
    symbol: INTL_BRAND.appIcon,
    icons: { appleTouch180: INTL_BRAND.appleTouchIcon, png192: INTL_BRAND.pwa192, png512: INTL_BRAND.pwa512 },
  },
};

/** An absolute http(s) address without its trailing slash, or null. */
function httpBase(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? raw.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

async function appBaseUrl(config: ServerConfig): Promise<string | null> {
  try {
    const { data } = await getServiceClient(config).from('platform_domains').select('app_base_url').limit(1).maybeSingle();
    return httpBase((data as { app_base_url?: unknown } | null)?.app_base_url) ?? httpBase(process.env.APP_BASE_URL);
  } catch {
    return httpBase(process.env.APP_BASE_URL);
  }
}

/**
 * The brand's images for an edition (default: the running one), absolute
 * against `base` (default: `platform_domains.app_base_url`). Null for an
 * edition that cannot be told, or when no absolute base is known: a relative
 * image URL means nothing in a mail.
 */
export async function resolveBrandAssets(
  config: ServerConfig,
  opts?: { edition?: Edition; base?: string },
): Promise<BrandAssets | null> {
  const edition = opts?.edition ? parseEdition(opts.edition) : await getPlatformEditionOrNull(config);
  if (!edition || !KIT[edition]) return null;
  const base = opts?.base !== undefined ? httpBase(opts.base) : await appBaseUrl(config);
  if (!base) return null;
  const kit = KIT[edition];
  const at = (path: string) => `${base}${path}`;
  return {
    source: 'kit',
    logo: { light: at(kit.logo.light), dark: at(kit.logo.dark) },
    logoPng: { light: at(kit.logoPng.light), dark: at(kit.logoPng.dark), width: kit.logoPng.width, height: kit.logoPng.height },
    symbol: at(kit.symbol),
    icons: { appleTouch180: at(kit.icons.appleTouch180), png192: at(kit.icons.png192), png512: at(kit.icons.png512) },
  };
}
