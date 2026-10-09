/**
 * GET /api/platform/public/config — the platform-wide settings every page
 * needs before anyone signs in: visual branding, per-locale branding text,
 * the region / language policy, the dashboard UI defaults, and the realtime
 * client's tuning values.
 *
 * The browser used to read these straight from Supabase with the anon key
 * (src/integrations/supabase/client.ts, hard-wired to one hosted project).
 * That tied every build to that project, and on a database built from
 * database/migrations it failed anyway — the self-host chain grants anon
 * nothing on platform_branding or platform_settings. Served from here, the
 * dashboard needs no Supabase URL or key at all and works the same on any
 * database.
 *
 * Public, unauthenticated, read-only. Only presentational columns leave the
 * server: no platform_settings field beyond the three the language picker
 * needs, and the realtime values come from get_widget_platform_settings(),
 * the sanitized projection that already existed for anon callers. Built and
 * cached in server/services/platformPublicConfig.ts.
 */
import { Router } from 'express';
import type { ServerConfig } from '../config.js';
import { getPlatformPublicConfig } from '../services/platformPublicConfig.js';

export const platformPublicRouter = Router();

platformPublicRouter.get('/config', async (req, res) => {
  const config = (req as unknown as { serverConfig: ServerConfig }).serverConfig;
  const body = await getPlatformPublicConfig(config);
  if (!body) return res.status(503).json({ error: 'platform_config_unavailable' });
  // The browser keeps no copy: a Super Admin change must show on its next
  // read. The server keeps one (server/services/platformPublicConfig.ts),
  // dropped by every write to the settings it is built from.
  res.set('Cache-Control', 'no-store');
  return res.json(body);
});

/**
 * GET /api/platform/public/boot.js — what index.html needs before the app's
 * bundle runs, as a tiny script: the edition (shared/edition.ts), the
 * platform's name and browser title per language, its site and support
 * address, and its default language. index.html loads it synchronously only
 * when the browser has never seen the platform (no cached edition), so the
 * very first paint already wears the right brand — WebYar's in the Iranian
 * edition, the platform's own in the International one — without the
 * deployment rewriting the bundle. Browsers that have seen the platform use
 * their cache and never wait for it.
 *
 * Never fails the page: an unreadable configuration answers an empty boot
 * object (the page then behaves as it always did).
 */
platformPublicRouter.get('/boot.js', async (req, res) => {
  const config = (req as unknown as { serverConfig: ServerConfig }).serverConfig;
  let boot: Record<string, unknown> = {};
  try {
    const body = await getPlatformPublicConfig(config);
    if (body) {
      const names: Record<string, string> = {};
      const titles: Record<string, string> = {};
      for (const row of body.localized) {
        const locale = typeof row?.locale === 'string' ? row.locale : '';
        if (!locale) continue;
        const name = typeof row?.platform_name === 'string' ? row.platform_name.trim() : '';
        const title = typeof row?.meta_title === 'string' && row.meta_title.trim() ? row.meta_title.trim() : name;
        if (name) names[locale] = name;
        if (title) titles[locale] = title;
      }
      const region = (body.region ?? {}) as Record<string, unknown>;
      boot = {
        edition: body.brand.edition,
        regionMode: typeof region.region_mode === 'string' ? region.region_mode : null,
        defaultLocale: typeof region.default_locale === 'string' ? region.default_locale : null,
        names,
        titles,
        siteUrl: body.brand.site_url,
        supportEmail: body.brand.support_email,
      };
    }
  } catch {
    boot = {};
  }
  res.type('application/javascript');
  // Short-lived: a Super Admin change shows within a minute, and a browser
  // only asks for it until it has cached the edition anyway.
  res.set('Cache-Control', 'public, max-age=60');
  // The dashboard may live on another origin than the API (app. vs api.).
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  // JSON is a JavaScript expression; `<` is escaped so the text can never
  // close a script element.
  const json = JSON.stringify(boot).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return res.send(`window.__PLATFORM_BOOT__=${json};`);
});
