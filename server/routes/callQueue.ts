/**
 * Phase 8C — Call queue HTTP routes (operator surfaces).
 *
 * Workspace-scoped, JWT-authenticated. Visitor-side enqueue happens
 * through the widget router (server/routes/widget.ts) using the signed
 * visitor cookie — separate from these routes by design so we never
 * mix auth contexts.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  listActive,
  getEntry,
  offerEntry,
  acceptEntry,
  cancelEntry,
  type QueueChannel,
} from '../services/calls/queue.js';
import { resolveUserCallPermissions } from '../services/calls/permissions.js';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';

export const callQueueRouter = Router();

async function requireWorkspaceMember(
  req: any,
  res: any,
  _config: ServerConfig,
  workspaceId: string,
): Promise<{ userId: string } | null> {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return null;
  return { userId: auth.userId };
}

// GET /api/call-queue/:workspaceId?channel=audio|video
callQueueRouter.get('/:workspaceId', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const workspaceId = req.params.workspaceId;
  const auth = await requireWorkspaceMember(req, res, config, workspaceId);
  if (!auth) return;
  const channel = (req.query.channel as QueueChannel | undefined) || undefined;
  const entries = await listActive(config, workspaceId, channel);
  res.json({ entries });
});

// POST /api/call-queue/:workspaceId/:entryId/offer
callQueueRouter.post('/:workspaceId/:entryId/offer', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const { workspaceId, entryId } = req.params;
  const auth = await requireWorkspaceMember(req, res, config, workspaceId);
  if (!auth) return;
  const perms = await resolveUserCallPermissions(config, workspaceId, auth.userId);
  if (!perms.can_join_queue_calls) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const entry = await getEntry(config, workspaceId, entryId);
  if (!entry) return res.status(404).json({ error: 'not_found' });
  try {
    const updated = await offerEntry(config, entryId, auth.userId);
    res.json({ entry: updated });
  } catch (e: any) {
    res.status(409).json({ error: e?.message || 'offer_failed' });
  }
});

// POST /api/call-queue/:workspaceId/:entryId/accept   { call_session_id? }
callQueueRouter.post('/:workspaceId/:entryId/accept', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const { workspaceId, entryId } = req.params;
  const auth = await requireWorkspaceMember(req, res, config, workspaceId);
  if (!auth) return;
  const body = z.object({ call_session_id: z.string().uuid().optional() }).safeParse(req.body || {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body' });
  try {
    const updated = await acceptEntry(config, entryId, body.data.call_session_id ?? null);
    res.json({ entry: updated });
  } catch (e: any) {
    res.status(409).json({ error: e?.message || 'accept_failed' });
  }
});

// POST /api/call-queue/:workspaceId/:entryId/cancel   { reason? }
callQueueRouter.post('/:workspaceId/:entryId/cancel', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const { workspaceId, entryId } = req.params;
  const auth = await requireWorkspaceMember(req, res, config, workspaceId);
  if (!auth) return;
  const reason = String((req.body && req.body.reason) || 'operator_cancelled');
  const updated = await cancelEntry(config, entryId, reason);
  if (!updated) return res.status(404).json({ error: 'not_found_or_inactive' });
  res.json({ entry: updated });
});

// GET /api/call-queue/:workspaceId/me/permissions
callQueueRouter.get('/:workspaceId/me/permissions', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const workspaceId = req.params.workspaceId;
  const auth = await requireWorkspaceMember(req, res, config, workspaceId);
  if (!auth) return;
  const perms = await resolveUserCallPermissions(config, workspaceId, auth.userId);
  res.json(perms);
});