/**
 * Platform-admin self-check and first-run bootstrap — deliberately mounted
 * OUTSIDE the `requireAdmin`-gated /api/admin/* prefix (server/index.ts),
 * because both routes here must be reachable by someone who is NOT (yet)
 * a platform admin: `/is-admin` answers "am I one" for the frontend's own
 * admin-detection check, and `/bootstrap` is how the very first admin gets
 * created on a fresh install — requiring an existing admin to call it
 * would make it permanently uncallable.
 *
 * Both routes still require a valid gs_session (requireUser) — this is
 * "any authenticated user may ask/attempt," not "anyone at all." The real
 * self-promotion guard is bootstrap_admin's own internal check (only
 * succeeds while zero platform admins exist anywhere), which this route
 * does not weaken or bypass.
 */
import { Router } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requireUser } from '../lib/workspaceAuth.js';
import { isGlobalAdmin } from '../middleware/adminBypass.js';

export const adminBootstrapRouter = Router();

adminBootstrapRouter.get('/is-admin', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const config: ServerConfig = (req as any).serverConfig;
  return res.json({ isAdmin: await isGlobalAdmin(config, userId) });
});

adminBootstrapRouter.post('/bootstrap', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('bootstrap_admin', { _user_id: userId });
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ promoted: data as boolean });
});
