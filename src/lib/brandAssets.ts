/**
 * The platform's logo on the client, from one place (owner, 2026-10-30): the
 * logo and symbol the Super Admin uploaded (Super Admin → Branding → Visual
 * identity; `brand_assets` in GET /api/platform/public/config,
 * server/services/platformBrandAssets.ts), else the edition's bundled kit
 * through the gates the marks always used:
 *
 *   - a build without the Iranian kit (SHIPS_IRAN_KIT false: RESPOK's), and
 *     the International edition: RESPOK's kit (INTL_BRAND);
 *   - the Iranian edition: WebYar's kit (src/lib/webyarBrand.ts, empty in
 *     the RESPOK build);
 *   - an edition not known yet: nothing, and each mark keeps the look it had
 *     before (the bitmap, "WEBYAR AI", the name).
 *
 * An upload wins in both editions. The uploads are kept in localStorage
 * (`wy-brand-assets`) so the first paint — and index.html's boot splash,
 * which reads the same key — already wears them; without an upload the key
 * is removed and every surface draws exactly what it drew before.
 */
import { useEffect } from 'react';
import { usePlatformPublicConfig, type PlatformPublicBrandAssets } from '@/lib/platformPublicConfig';
import { useKnownEdition } from '@/hooks/useEdition';
import { knownEdition } from '@/lib/edition';
import { INTL_BRAND } from '../../shared/internationalMode';
import { WEBYAR_BRAND } from '@/lib/webyarBrand';
import { parseEdition, type Edition } from '../../shared/edition';
import { SHIPS_IRAN_KIT } from '../../shared/buildBrand';

/** Read by index.html's boot script too: keep the name in step. */
export const BRAND_ASSETS_CACHE_KEY = 'wy-brand-assets';

export type BrandPair = { light: string; dark: string };

export interface BrandAssetsView {
  /** 'custom': the Super Admin's lockup; 'kit': the edition's kit; 'none': no edition known yet. */
  source: 'custom' | 'kit' | 'none';
  /** The kit that stands in for what was not uploaded (null before the edition is known). */
  kit: Edition | null;
  /** Whether the square mark is the Super Admin's own. */
  customSymbol: boolean;
  /** The lockup (mark and name), for light and dark surfaces; null keeps the caller's old mark. */
  lockup: BrandPair | null;
  /** The small mark under the auth cards: RESPOK's wordmark, WebYar's logotype, or the uploaded lockup. */
  wordmark: BrandPair | null;
  /** The square mark; null keeps the caller's old mark. */
  symbol: string | null;
  /** The uploaded symbol's PNGs (home screen, web app, notifications); null: the kit's, as before. */
  icons: { appleTouch180: string; png192: string; png512: string } | null;
}

/** A URL the page may show: absolute http(s) or a path on this origin. */
function usable(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return /^https?:\/\//i.test(v) || (v.startsWith('/') && !v.startsWith('//')) ? v : null;
}

/** The uploads as the server sent (or this browser kept) them, every URL checked; null when none. */
export function normalizeBrandAssets(raw: unknown): PlatformPublicBrandAssets | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const logoLight = usable(r.logo_light);
  const symbol = usable(r.symbol);
  if (!logoLight && !symbol) return null;
  const size = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
  return {
    logo_light: logoLight,
    logo_dark: logoLight ? usable(r.logo_dark) : null,
    logo_png_light: logoLight ? usable(r.logo_png_light) : null,
    logo_png_dark: logoLight ? usable(r.logo_png_dark) : null,
    logo_png_width: logoLight ? size(r.logo_png_width) : null,
    logo_png_height: logoLight ? size(r.logo_png_height) : null,
    symbol,
    apple_touch_180: symbol ? usable(r.apple_touch_180) : null,
    icon_192: symbol ? usable(r.icon_192) : null,
    icon_512: symbol ? usable(r.icon_512) : null,
  };
}

/** The uploads this browser last saw (null when none, or never). */
export function cachedBrandAssets(): PlatformPublicBrandAssets | null {
  try {
    return normalizeBrandAssets(JSON.parse(window.localStorage.getItem(BRAND_ASSETS_CACHE_KEY) || 'null'));
  } catch {
    return null;
  }
}

function rememberBrandAssets(assets: PlatformPublicBrandAssets | null): void {
  try {
    if (assets) window.localStorage.setItem(BRAND_ASSETS_CACHE_KEY, JSON.stringify(assets));
    else window.localStorage.removeItem(BRAND_ASSETS_CACHE_KEY);
  } catch {
    /* storage unavailable: the next first paint just does not know them yet */
  }
}

/**
 * What every mark draws, for these uploads and this edition. Pure: the hook
 * below and the code outside React (notifications) share it.
 */
export function brandAssetsView(custom: PlatformPublicBrandAssets | null, edition: Edition | null): BrandAssetsView {
  const international = !SHIPS_IRAN_KIT || parseEdition(edition) === 'international';
  const iran = SHIPS_IRAN_KIT && !international && parseEdition(edition) === 'iran';
  const kitLockup: BrandPair | null = international ? INTL_BRAND.horizontal : iran ? WEBYAR_BRAND.logo : null;
  const kitWordmark: BrandPair | null = international ? INTL_BRAND.wordmark : iran ? WEBYAR_BRAND.logo : null;
  const kitSymbol = international ? INTL_BRAND.appIcon : iran ? WEBYAR_BRAND.symbol : null;
  const uploadedLockup = custom?.logo_light ? { light: custom.logo_light, dark: custom.logo_dark || custom.logo_light } : null;
  const icons = custom?.symbol && custom.apple_touch_180 && custom.icon_192 && custom.icon_512
    ? { appleTouch180: custom.apple_touch_180, png192: custom.icon_192, png512: custom.icon_512 }
    : null;
  return {
    source: uploadedLockup ? 'custom' : kitLockup ? 'kit' : 'none',
    kit: international ? 'international' : iran ? 'iran' : null,
    customSymbol: !!custom?.symbol,
    lockup: uploadedLockup ?? kitLockup,
    wordmark: uploadedLockup ?? kitWordmark,
    symbol: custom?.symbol ?? kitSymbol,
    icons,
  };
}

/** The same outside React: the cached uploads and the edition as far as this page knows it. */
export function currentBrandAssets(): BrandAssetsView {
  return brandAssetsView(cachedBrandAssets(), knownEdition());
}

/**
 * The platform's logo for this page: the public config's uploads once it has
 * arrived (and kept for the next first paint), the cached ones before.
 */
export function useBrandAssets(): BrandAssetsView {
  const { data } = usePlatformPublicConfig();
  const edition = useKnownEdition();
  const fromConfig = data ? normalizeBrandAssets(data.brand_assets) : undefined;
  const serialized = fromConfig === undefined ? undefined : JSON.stringify(fromConfig);
  useEffect(() => {
    if (serialized !== undefined) rememberBrandAssets(serialized ? (JSON.parse(serialized) as PlatformPublicBrandAssets | null) : null);
  }, [serialized]);
  return brandAssetsView(fromConfig !== undefined ? fromConfig : cachedBrandAssets(), edition);
}
