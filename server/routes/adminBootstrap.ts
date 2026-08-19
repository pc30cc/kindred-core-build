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
 * "any authenticated user may ask/attempt," not "anyone at all."
 *
 * `bootstrap_admin`'s own internal check (only succeeds while zero
 * platform admins exist anywhere) is real defense in depth, but on its
 * own it means "first authenticated user to call this endpoint wins" —
 * a race any signed-up visitor can enter on a fresh, publicly reachable
 * install. This route adds the actual promotion boundary in front of
 * that RPC: the caller's first-party email must be verified AND must
 * exactly match the deployment-configured INITIAL_ADMIN_EMAIL server env
 * var. Unset by default — bootstrap fails closed (nobody can bootstrap)
 * rather than silently reopening the any-user race, so an operator must
 * deliberately configure it to enable the very first admin promotion.
 */
import { Router } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requireUser } from '../lib/workspaceAuth.js';
import { isGlobalAdmin } from '../middleware/adminBypass.js';
import { findIdentityById } from '../services/auth/identity.js';

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

  if (!config.initialAdminEmail) {
    return res.status(403).json({
      error: 'bootstrap_not_configured',
      message: 'Platform admin bootstrap is disabled until INITIAL_ADMIN_EMAIL is set in the server environment.',
    });
  }

  const identity = await findIdentityById(config, userId);
  if (!identity) {
    return res.status(403).json({ error: 'not_authorized' });
  }
  if (!identity.emailVerifiedAt) {
    return res.status(403).json({ error: 'email_verification_required' });
  }
  if (identity.email.trim().toLowerCase() !== config.initialAdminEmail) {
    return res.status(403).json({ error: 'not_authorized' });
  }

  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('bootstrap_admin', { _user_id: userId });
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ promoted: data as boolean });
});
