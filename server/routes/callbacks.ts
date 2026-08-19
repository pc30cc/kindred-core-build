/**
 * Phase 8D — Callback request HTTP routes (operator-side).
 * Visitor-side creation goes through the widget router (separate auth).
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  listCallbacks,
  updateCallbackStatus,
  getCallbackCounts,
  type CallbackStatus,
} from '../services/calls/callbacks.js';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';

export const callbacksRouter = Router();

async function requireMember(req: any, res: any, _config: ServerConfig, workspaceId: string) {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return null;
  return { userId: auth.userId };
}

// GET /api/callbacks/:workspaceId?status=open|requested|...
callbacksRouter.get('/:workspaceId', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const auth = await requireMember(req, res, config, req.params.workspaceId);
  if (!auth) return;
  const status = (req.query.status as string | undefined) as any;
  const rows = await listCallbacks(config, req.params.workspaceId, status);
  res.json({ callbacks: rows });
});

// GET /api/callbacks/:workspaceId/counts
callbacksRouter.get('/:workspaceId/counts', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const auth = await requireMember(req, res, config, req.params.workspaceId);
  if (!auth) return;
  const counts = await getCallbackCounts(config, req.params.workspaceId);
  res.json(counts);
});

// PATCH /api/callbacks/:workspaceId/:id  { status }
callbacksRouter.patch('/:workspaceId/:id', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const auth = await requireMember(req, res, config, req.params.workspaceId);
  if (!auth) return;
  const parsed = z.object({
    status: z.enum(['requested', 'scheduled', 'in_progress', 'completed', 'cancelled']),
  }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  try {
    const row = await updateCallbackStatus(
      config,
      req.params.workspaceId,
      req.params.id,
      parsed.data.status as CallbackStatus,
      auth.userId,
    );
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ callback: row });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'failed' });
  }
});
