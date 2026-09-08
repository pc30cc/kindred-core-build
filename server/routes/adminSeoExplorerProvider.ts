/**
 * ADMIN — SEO SITE EXPLORER STATS
 *
 * Site Explorer has no credential of its own to configure — it reuses the
 * SAME DataForSEO account already configured for Backlinks (backlinks
 * lookups) and Keyword Research (organic-keywords lookups); see
 * server/services/seo/siteExplorerService.ts. This route only reports
 * platform-wide adoption/usage stats. Mounted under the admin router, so
 * `requireAdmin` already gates every route here.
 */
import { Router, type Request, type Response } from 'express';
import type { ServerConfig } from '../config.js';
import { getExplorerPlatformStats, listRecentExplorerLookupsAcrossWorkspaces } from '../services/seo/explorerAdminStats.js';

export const adminSeoExplorerProviderRouter = Router();

function config(req: Request): ServerConfig {
  return (req as any).serverConfig;
}

// ─── GET /stats — platform-wide usage, across every workspace ────────────
adminSeoExplorerProviderRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await getExplorerPlatformStats(config(req));
    res.json(stats);
  } catch {
    res.status(500).json({ error: 'explorer_stats_failed' });
  }
});

// ─── GET /lookups — most recent lookups across every workspace ───────────
adminSeoExplorerProviderRouter.get('/lookups', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(String(req.query.limit || '20'), 10) || 20;
    const lookups = await listRecentExplorerLookupsAcrossWorkspaces(config(req), limit);
    res.json({ lookups });
  } catch {
    res.status(500).json({ error: 'explorer_lookups_failed' });
  }
});
