/**
 * Platform-admin database maintenance: JSON backup / restore / purge.
 *
 * Mounted under adminRouter (server/routes/admin.ts), which already gates
 * every route behind `requirePlatformAdmin`. All heavy lifting happens in
 * SECURITY DEFINER SQL functions added by
 * database/migrations/110_admin_data_reset.sql, which re-check the actor's
 * admin role explicitly (service_role has no auth.uid()).
 *
 * No edge functions — this is Express-only, per project architecture rules.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';

export const adminDatabaseRouter = Router();

function serverConfigOf(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

const scopeSchema = z.object({
  scope: z.enum(['data', 'full']).default('data'),
});

// ─── Backup (export as downloadable JSON) ────────────────────────────────
adminDatabaseRouter.get('/backup', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('admin_export_database', {
    _actor_user_id: actorId,
    _scope: 'all',
  });
  if (error) return res.status(500).json({ error: error.message });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="backup_${stamp}.json"`);
  res.send(JSON.stringify(data));
});

// ─── Restore ─────────────────────────────────────────────────────────────
adminDatabaseRouter.post('/restore', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const payload = req.body?.payload;
  if (!payload || typeof payload !== 'object' || !payload.tables) {
    return res.status(400).json({ error: 'Invalid backup payload' });
  }
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('admin_restore_database', {
    _actor_user_id: actorId,
    _payload: payload,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, result: data });
});

// ─── Purge ───────────────────────────────────────────────────────────────
adminDatabaseRouter.post('/purge', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = scopeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid scope' });
  if (req.body?.confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Confirmation required' });
  }
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('admin_purge_database', {
    _actor_user_id: actorId,
    _scope: parsed.data.scope,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, result: data });
});
