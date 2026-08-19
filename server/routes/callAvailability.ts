/**
 * Phase 8D — Operator call availability HTTP routes.
 * Workspace-scoped, JWT-auth. Operators write only their own row.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  listWorkspaceAvailability,
  getMyAvailability,
  setMyAvailability,
  type AvailabilityStatus,
} from '../services/calls/availability.js';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';

export const callAvailabilityRouter = Router();

async function requireMember(req: any, res: any, _config: ServerConfig, workspaceId: string) {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return null;
  return { userId: auth.userId };
}

// GET /api/call-availability/:workspaceId  → all operators in workspace
callAvailabilityRouter.get('/:workspaceId', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const auth = await requireMember(req, res, config, req.params.workspaceId);
  if (!auth) return;
  const rows = await listWorkspaceAvailability(config, req.params.workspaceId);
  res.json({ rows });
});

// GET /api/call-availability/:workspaceId/me
callAvailabilityRouter.get('/:workspaceId/me', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const auth = await requireMember(req, res, config, req.params.workspaceId);
  if (!auth) return;
  const row = await getMyAvailability(config, req.params.workspaceId, auth.userId);
  res.json({ availability: row });
});

// PUT /api/call-availability/:workspaceId/me  { status }
callAvailabilityRouter.put('/:workspaceId/me', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const auth = await requireMember(req, res, config, req.params.workspaceId);
  if (!auth) return;
  const parsed = z.object({
    status: z.enum(['unavailable', 'available_audio', 'available_video', 'available_both', 'busy']),
  }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  try {
    const row = await setMyAvailability(config, req.params.workspaceId, auth.userId, parsed.data.status as AvailabilityStatus);
    res.json({ availability: row });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'failed' });
  }
});
