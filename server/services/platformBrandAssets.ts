/**
 * The platform's logo and icons, from one place (owner, 2026-10-30: read the
 * logo from one place, for WebYar and RESPOK alike, so changing it once
 * changes it everywhere).
 *
 * The Super Admin uploads them in Branding → Visual identity (migration 290,
 * POST /api/admin/management/platform-branding/assets/:variant); without an
 * upload each edition keeps its kit (shared/webyarBrand.ts WEBYAR_BRAND in
 * the Iranian edition, shared/internationalMode.ts INTL_BRAND in the
 * International one), so every surface looks exactly as before.
 *
 * Only storage keys are stored. Their URLs are derived here, for whichever
 * provider is primary, when the platform public config is built
 * (server/services/platformPublicConfig.ts): that memo (30 s, dropped by
 * every Super Admin write and by the `platform` cache bus on every replica)
 * is this module's memo too, and its `brand_assets` is what browsers read
 * (custom URLs only; the kits are in the bundle).
 *
 * The lockup is one pair: its dark file and both PNG copies count only with
 * a light one (an upload refuses them without it, a reset of the light one
 * clears them). The symbol and its PNGs go together the same way.
 */
import type { ServerConfig } from '../config.js';
import { parseEdition, type Edition } from '../../shared/edition.js';
import { WEBYAR_BRAND } from '../../shared/webyarBrand.js';
import { INTL_BRAND } from '../../shared/internationalMode.js';
import { createStorageUrlResolver } from './storage/urlResolver.js';
import { getPlatformBrandSource } from './platformPublicConfig.js';

export interface BrandAssets {
  /** 'custom' when the Super Admin uploaded the logo (the lockup), else 'kit'. */
  source: 'custom' | 'kit';
  /** Absolute URLs (SVG or raster): for light and for dark surfaces. */
  logo: { light: string; dark: string };
  /** Absolute PNG URLs (email), and the light PNG's natural size in pixels. */
  logoPng: { light: string; dark: string; width: number; height: number };
  /** The square mark, absolute. */
  symbol: string;
  /** PNGs of the square mark: the home-screen icon (opaque), the web app's icons. */
  icons: { appleTouch180: string; png192: string; png512: string };
}

/**
 * What the Super Admin uploaded, as URLs: the public config's `brand_assets`
 * (null when nothing was uploaded). A field is null where nothing stands for
 * it; the kit fills it in.
 */
export interface CustomBrandAssets {
  logo_light: string | null;
  logo_dark: string | null;
  logo_png_light: string | null;
  logo_png_dark: string | null;
  logo_png_width: number | null;
  logo_png_height: number | null;
  symbol: string | null;
  apple_touch_180: string | null;
  icon_192: string | null;
  icon_512: string | null;
}

/** The columns of platform_branding (migration 290) that hold the keys. */
export const BRAND_ASSET_KEY_COLUMNS = [
  'logo_light_storage_key',
  'logo_dark_storage_key',
  'logo_email_light_storage_key',
  'logo_email_dark_storage_key',
  'symbol_storage_key',
  'symbol_apple_touch_storage_key',
  'symbol_png_192_storage_key',
  'symbol_png_512_storage_key',
] as const;

export type BrandAssetKeyColumn = (typeof BRAND_ASSET_KEY_COLUMNS)[number];

function keyOf(row: Record<string, unknown> | null | undefined, column: BrandAssetKeyColumn): string | null {
  const value = row?.[column];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sizeOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * A platform_branding row's uploads as URLs, or null when it has none (or none
 * of them can be served right now). One provider lookup, and none at all
 * without an upload, so a platform that never uploaded pays nothing for this.
 */
export async function customBrandAssetsFromRow(
  config: ServerConfig,
  row: Record<string, unknown> | null | undefined,
): Promise<CustomBrandAssets | null> {
  if (!BRAND_ASSET_KEY_COLUMNS.some((column) => keyOf(row, column))) return null;
  const resolver = createStorageUrlResolver(config);
  const url = (column: BrandAssetKeyColumn) => resolver.platform(keyOf(row, column));
  const logoLight = await url('logo_light_storage_key');
  const symbol = await url('symbol_storage_key');
  if (!logoLight && !symbol) return null;
  const pngLight = logoLight ? await url('logo_email_light_storage_key') : null;
  return {
    logo_light: logoLight,
    logo_dark: logoLight ? await url('logo_dark_storage_key') : null,
    logo_png_light: pngLight,
    logo_png_dark: pngLight ? await url('logo_email_dark_storage_key') : null,
    logo_png_width: pngLight ? sizeOf(row?.logo_email_width) : null,
    logo_png_height: pngLight ? sizeOf(row?.logo_email_height) : null,
    symbol,
    apple_touch_180: symbol ? await url('symbol_apple_touch_storage_key') : null,
    icon_192: symbol ? await url('symbol_png_192_storage_key') : null,
    icon_512: symbol ? await url('symbol_png_512_storage_key') : null,
  };
}

/** The kit's paths, relative to the frontend's origin. */
function kitPaths(edition: Edition) {
  if (edition === 'iran') {
    return {
      logo: WEBYAR_BRAND.logo,
      logoPng: WEBYAR_BRAND.emailLogo,
      symbol: WEBYAR_BRAND.symbol,
      icons: { appleTouch180: WEBYAR_BRAND.appleTouchIcon, png192: WEBYAR_BRAND.pwa192, png512: WEBYAR_BRAND.pwa512 },
    };
  }
  return {
    logo: INTL_BRAND.horizontal,
    logoPng: INTL_BRAND.emailLogo,
    symbol: INTL_BRAND.appIcon,
    icons: { appleTouch180: INTL_BRAND.appleTouchIcon, png192: INTL_BRAND.pwa192, png512: INTL_BRAND.pwa512 },
  };
}

/**
 * The edition's assets: what was uploaded, the kit's for the rest. Pure.
 * `base` is the origin the kit's paths are served from (the frontend's, or
 * the widgets' asset origin), without a trailing slash; '' leaves them
 * relative.
 */
export function brandAssetsFor(edition: Edition, custom: CustomBrandAssets | null, base: string): BrandAssets {
  const kit = kitPaths(edition);
  const at = (path: string) => `${base}${path}`;
  const light = custom?.logo_light ?? null;
  const pngLight = light ? custom?.logo_png_light ?? null : null;
  const symbol = custom?.symbol ?? null;
  // A PNG without its size (an older row) is drawn at the kit's height.
  const width = pngLight ? custom?.logo_png_width ?? null : null;
  const height = pngLight ? custom?.logo_png_height ?? null : null;
  return {
    source: light ? 'custom' : 'kit',
    logo: light
      ? { light, dark: custom?.logo_dark || light }
      : { light: at(kit.logo.light), dark: at(kit.logo.dark) },
    logoPng: pngLight && width && height
      ? { light: pngLight, dark: custom?.logo_png_dark || pngLight, width, height }
      : { light: at(kit.logoPng.light), dark: at(kit.logoPng.dark), width: kit.logoPng.width, height: kit.logoPng.height },
    symbol: symbol ?? at(kit.symbol),
    icons: symbol && custom?.apple_touch_180 && custom.icon_192 && custom.icon_512
      ? { appleTouch180: custom.apple_touch_180, png192: custom.icon_192, png512: custom.icon_512 }
      : { appleTouch180: at(kit.icons.appleTouch180), png192: at(kit.icons.png192), png512: at(kit.icons.png512) },
  };
}

function httpBaseOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? `${url.origin}${url.pathname}`.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

/**
 * Where the kit's files are served when the caller names no base: the app's
 * address (platform_domains.app_base_url), else APP_BASE_URL, else a
 * configured CORS origin — the order auth-email.ts builds its links in.
 */
function defaultBase(config: ServerConfig, appBaseUrl: string | null): string {
  return httpBaseOf(appBaseUrl)
    ?? httpBaseOf(process.env.APP_BASE_URL)
    ?? (config.corsOrigins || []).map(httpBaseOf).find((o): o is string => !!o)
    ?? '';
}

/**
 * The platform's logo and icons for an edition: what the Super Admin
 * uploaded, else the edition's kit made absolute against `base` (default: the
 * app's address). `edition` defaults to the platform's own; an unknown one
 * (null, or a platform whose settings cannot be read) answers null, so the
 * caller keeps what it showed before. A failed read of the uploads answers
 * the kit.
 */
export async function resolveBrandAssets(
  config: ServerConfig,
  opts?: { edition?: Edition | null; base?: string | null },
): Promise<BrandAssets | null> {
  const source = await getPlatformBrandSource(config).catch(() => null);
  const edition = opts && 'edition' in opts ? parseEdition(opts.edition) : source?.edition ?? null;
  if (!edition) return null;
  const base = typeof opts?.base === 'string' && opts.base
    ? opts.base.replace(/\/+$/, '')
    : defaultBase(config, source?.appBaseUrl ?? null);
  return brandAssetsFor(edition, source?.custom ?? null, base);
}

/** What the Super Admin uploaded, as URLs (the public config's `brand_assets`); null without an upload or on a failed read. */
export async function readCustomBrandAssets(config: ServerConfig): Promise<CustomBrandAssets | null> {
  const source = await getPlatformBrandSource(config).catch(() => null);
  return source?.custom ?? null;
}
