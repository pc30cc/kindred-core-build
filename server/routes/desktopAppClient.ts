/**
 * WINDOWS APP — signed-in endpoints beyond the public config.
 *
 *   GET  /api/desktop-app/campaigns?workspace_id=&locale=
 *        → { campaigns: ClientCampaign[] }  ads + announcements for this
 *          workspace's plan, already in one locale. Never an error state:
 *          a failure is an empty list.
 *
 *   POST /api/desktop-app/heartbeat
 *        { session_id, workspace_id?, version?, os?, after_seq? }
 *        → { interval_seconds, broadcasts: [...], latest_seq }
 *        Counts this copy as running (in memory, see services/desktopApp/
 *        live.ts) and hands back any Super Admin broadcast it has not seen.
 *
 *   POST /api/desktop-app/goodbye { session_id }   the app is closing.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { authorizeWorkspaceAccess, requireUser } from '../lib/workspaceAuth.js';
import { getWorkspacePlanInfo } from '../middleware/featureGating.js';
import { loadLiveCampaigns, pickLocale, targetsPlan, toClient } from '../services/desktopApp/campaigns.js';
import { broadcastsAfter, goodbye, heartbeat, HEARTBEAT_SECONDS } from '../services/desktopApp/live.js';

export const desktopAppClientRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as unknown as Request & { serverConfig: ServerConfig }).serverConfig;
}

desktopAppClientRouter.get('/campaigns', async (req, res) => {
  const workspaceId = String(req.query.workspace_id || '');
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  try {
    const config = serverConfigOf(req);
    const rows = await loadLiveCampaigns(config);
    if (rows.length === 0) return res.json({ campaigns: [] });
    let planSlug: string | null = null;
    try {
      const info = await getWorkspacePlanInfo(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
      planSlug = (info?.plan?.slug as string | undefined) ?? null;
    } catch {
      planSlug = null;
    }
    const locale = pickLocale(req.query.locale);
    const campaigns = rows
      .filter((r) => targetsPlan(r, planSlug))
      .map((r) => toClient(r, locale))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    return res.json({ campaigns });
  } catch {
    return res.json({ campaigns: [] });
  }
});

const heartbeatSchema = z.object({
  session_id: z.string().trim().min(8).max(80),
  workspace_id: z.string().uuid().nullable().optional(),
  version: z.string().trim().max(40).nullable().optional(),
  os: z.string().trim().max(80).nullable().optional(),
  after_seq: z.coerce.number().int().optional(),
});

desktopAppClientRouter.post('/heartbeat', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const parsed = heartbeatSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const b = parsed.data;
  heartbeat({
    sessionId: b.session_id,
    userId,
    workspaceId: b.workspace_id ?? null,
    version: b.version ?? null,
    os: b.os ?? null,
  });
  const { items, latest } = broadcastsAfter(b.after_seq ?? -1);
  return res.json({
    interval_seconds: HEARTBEAT_SECONDS,
    latest_seq: latest,
    broadcasts: items.map((x) => ({
      id: x.id,
      seq: x.seq,
      title: x.title,
      body: x.body,
      severity: x.severity,
      url: x.url,
      created_at: x.createdAt,
    })),
  });
});

desktopAppClientRouter.post('/goodbye', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const sessionId = String(req.body?.session_id ?? '');
  if (sessionId) goodbye(sessionId, userId);
  return res.json({ ok: true });
});
