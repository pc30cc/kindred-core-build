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
