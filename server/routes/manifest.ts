/**
 * Dynamic web app manifest (PWA) — reflects live platform_branding /
 * platform_branding_localized instead of a static build-time file, so an
 * operator's Super Admin → Branding edits (icon, colors, app name) take
 * effect immediately, the same way PlatformBrandingGate already updates the
 * document title/favicon live on the client. Public, unauthenticated,
 * read-only.
 *
 * Mounted at /api/manifest.webmanifest (see server/index.ts). The frontend
 * links to it as `/api/manifest.webmanifest?locale=<current i18n locale>`
 * from PlatformBrandingGate.
 *
 * In the International edition (platform_settings.region_mode is not 'iran';
 * shared/edition.ts, shared/internationalMode.ts) the icons are the RESPOK
 * brand kit's (public/brand/intl/), over the operator's own, in every
 * language. When the edition cannot be read the operator's own icons stay.
 *
 * In the Iranian edition (region_mode = 'iran' only; shared/webyarBrand.ts)
 * a deployment without its own icon (pwa_icon_url / favicon_url / logo_url,
 * in that order, as before) gets WebYar's brand kit icons instead of the old
 * /favicon.png, and the kit's theme colour #0B7D6C unless the operator chose
 * a colour (the seeded #3B82F6 was never a choice).
 */
import { Router } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { clampLocaleToPlatformRegion, getPlatformEditionOrNull } from '../services/platformRegion.js';
import { INTL_BRAND, isInternationalMode } from '../../shared/internationalMode.js';
import { WEBYAR_BRAND, isUncustomisedColor, isWebyarKitEdition } from '../../shared/webyarBrand.js';

export const manifestRouter = Router();

const RTL_LOCALES = new Set(['fa', 'ar']);

function guessMimeType(url: string): string {
  const clean = url.split('?')[0].toLowerCase();
  if (clean.endsWith('.svg')) return 'image/svg+xml';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.ico')) return 'image/x-icon';
  return 'image/png';
}

manifestRouter.get('/', async (req, res) => {
  const config = (req as unknown as { serverConfig: ServerConfig }).serverConfig;
  const sb = getServiceClient(config);

  const locale = await clampLocaleToPlatformRegion(config, typeof req.query.locale === 'string' ? req.query.locale : undefined);
  const effectiveLocale = locale || 'en';

  const [{ data: branding }, { data: localizedRows }, edition] = await Promise.all([
    sb.from('platform_branding').select('*').limit(1).maybeSingle(),
    sb.from('platform_branding_localized').select('locale, platform_name, meta_description').in('locale', [effectiveLocale, 'en']),
    getPlatformEditionOrNull(config),
  ]);
  const international = isInternationalMode(edition, effectiveLocale);

  const rows = (localizedRows || []) as { locale: string; platform_name: string | null; meta_description: string | null }[];
  const locRow = rows.find((r) => r.locale === effectiveLocale) || rows.find((r) => r.locale === 'en') || null;

  const b = (branding || {}) as Record<string, unknown>;
  const name = (locRow?.platform_name || '').trim() || 'App';
  const shortNameRaw = (b.pwa_short_name as string | null) || name;
  const shortName = shortNameRaw.slice(0, 30);
  const operatorIcon = (b.pwa_icon_url as string | null) || (b.favicon_url as string | null) || (b.logo_url as string | null) || null;
  const iconUrl = operatorIcon || '/favicon.png';
  const webyarKit = isWebyarKitEdition(edition);
  const themeColor = webyarKit && isUncustomisedColor(b.primary_color)
    ? WEBYAR_BRAND.themeColor
    : (b.primary_color as string | null) || '#3B82F6';
  const backgroundColor = (b.pwa_background_color as string | null) || '#F4F6F9';

  // The app may be served from a different host than this API
  // (app.example.com vs api.example.com). A manifest is only usable when its
  // start_url/scope are same-origin with the document, so the caller's origin
  // is honoured when it is a well-formed absolute http(s) origin.
  let base = '/';
  const rawOrigin = typeof req.query.origin === 'string' ? req.query.origin : '';
  if (rawOrigin) {
    try {
      const u = new URL(rawOrigin);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && u.origin === rawOrigin.replace(/\/+$/, '')) {
        base = `${u.origin}/`;
      }
    } catch { /* ignore malformed origin */ }
  }

  // Relative icon paths belong to the APP origin, not this API host.
  const onApp = (url: string) => (url.startsWith('/') && base !== '/' ? base.replace(/\/$/, '') + url : url);
  const icon = onApp(iconUrl);
  const icons = international
    ? [
        { src: onApp(INTL_BRAND.pwa192), sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: onApp(INTL_BRAND.pwa512), sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: onApp(INTL_BRAND.pwaMaskable), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ]
    : webyarKit && !operatorIcon
    ? [
        { src: onApp(WEBYAR_BRAND.pwa192), sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: onApp(WEBYAR_BRAND.pwa512), sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: onApp(WEBYAR_BRAND.pwaMaskable), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ]
    : [
        { src: icon, sizes: '192x192', type: guessMimeType(iconUrl), purpose: 'any' },
        { src: icon, sizes: '512x512', type: guessMimeType(iconUrl), purpose: 'any' },
        { src: icon, sizes: '512x512', type: guessMimeType(iconUrl), purpose: 'maskable' },
      ];

  const manifest = {
    name,
    short_name: shortName,
    description: locRow?.meta_description || undefined,
    start_url: base,
    scope: base,
    display: 'standalone',
    lang: effectiveLocale,
    dir: RTL_LOCALES.has(effectiveLocale) ? 'rtl' : 'ltr',
    theme_color: themeColor,
    background_color: backgroundColor,
    icons,
  };

  // Cross-origin manifests are fetched with CORS (the <link> carries
  // crossorigin="anonymous"), so the response must opt in explicitly.
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Vary', 'Origin');
  res.set('Content-Type', 'application/manifest+json; charset=utf-8');
  // Branding edits should propagate quickly without hammering the DB on
  // every page load — 5 minutes mirrors PlatformBrandingGate's own
  // client-side staleTime for the same underlying data.
  res.set('Cache-Control', 'public, max-age=300');
  res.json(manifest);
});
