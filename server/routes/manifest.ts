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
 */
import { Router } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { clampLocaleToPlatformRegion } from '../services/platformRegion.js';

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
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);

  const locale = await clampLocaleToPlatformRegion(config, typeof req.query.locale === 'string' ? req.query.locale : undefined);
  const effectiveLocale = locale || 'en';

  const [{ data: branding }, { data: localizedRows }] = await Promise.all([
    sb.from('platform_branding').select('*').limit(1).maybeSingle(),
    sb.from('platform_branding_localized').select('locale, platform_name, meta_description').in('locale', [effectiveLocale, 'en']),
  ]);

  const rows = (localizedRows || []) as { locale: string; platform_name: string | null; meta_description: string | null }[];
  const locRow = rows.find((r) => r.locale === effectiveLocale) || rows.find((r) => r.locale === 'en') || null;

  const b = (branding || {}) as Record<string, unknown>;
  const name = (locRow?.platform_name || '').trim() || 'App';
  const shortNameRaw = (b.pwa_short_name as string | null) || name;
  const shortName = shortNameRaw.slice(0, 30);
  const iconUrl = (b.pwa_icon_url as string | null) || (b.favicon_url as string | null) || (b.logo_url as string | null) || '/favicon.png';
  const themeColor = (b.primary_color as string | null) || '#3B82F6';
  const backgroundColor = (b.pwa_background_color as string | null) || '#ffffff';

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
  const icon = iconUrl.startsWith('/') && base !== '/' ? base.replace(/\/$/, '') + iconUrl : iconUrl;

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
    icons: [
      { src: icon, sizes: '192x192', type: guessMimeType(iconUrl), purpose: 'any' },
      { src: icon, sizes: '512x512', type: guessMimeType(iconUrl), purpose: 'any' },
      { src: icon, sizes: '512x512', type: guessMimeType(iconUrl), purpose: 'maskable' },
    ],
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
