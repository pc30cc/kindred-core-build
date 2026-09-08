/**
 * ADMIN — SEO GSC INSIGHTS STATUS
 *
 * Unlike the other SEO admin provider routes (adminSeoBacklinksProvider.ts
 * etc.) there is nothing to configure here — GSC has no stored platform
 * credential (server/services/seo/gsc/oauthConfig.ts reads
 * GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI straight from the server
 * environment, deployment-time only). This route only reports whether that
 * environment is set (a boolean, never the secret itself) and platform-wide
 * adoption stats. Mounted under the admin router, so `requireAdmin` already
 * gates every route here.
 */
import { Router, type Request, type Response } from 'express';
import type { ServerConfig } from '../config.js';
import { isGscPlatformConfigured } from '../services/seo/gsc/index.js';
import { getGscPlatformStats, listRecentGscConnectionsAcrossWorkspaces } from '../services/seo/gscAdminStats.js';

export const adminSeoGscProviderRouter = Router();

function config(req: Request): ServerConfig {
  return (req as any).serverConfig;
}

// ─── GET — whether the platform OAuth client is configured (no secrets) ──
adminSeoGscProviderRouter.get('/', async (req: Request, res: Response) => {
  res.json({ configured: isGscPlatformConfigured() });
});

// ─── GET /stats — platform-wide usage, across every workspace ────────────
adminSeoGscProviderRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await getGscPlatformStats(config(req));
    res.json(stats);
  } catch {
    res.status(500).json({ error: 'gsc_stats_failed' });
  }
});

// ─── GET /connections — most recent connections across every workspace ───
adminSeoGscProviderRouter.get('/connections', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(String(req.query.limit || '20'), 10) || 20;
    const connections = await listRecentGscConnectionsAcrossWorkspaces(config(req), limit);
    res.json({ connections });
  } catch {
    res.status(500).json({ error: 'gsc_connections_failed' });
  }
});
