/**
 * Phase 8D — Widget-side callback request creation.
 * Mounted under the widget router so it inherits widget token + origin.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { createCallbackRequest } from '../services/calls/callbacks.js';
import { markEntryAsCallback } from '../services/calls/queue.js';

export const widgetCallbacksRouter = Router();

widgetCallbacksRouter.post('/request', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = (req as any)._widgetWorkspaceId as string | undefined;
  const visitorId = (req as any).visitorId as string | undefined;
  if (!workspaceId) return res.status(400).json({ error: 'missing_workspace' });
  const parsed = z.object({
    channel: z.enum(['audio', 'video']),
    conversation_id: z.string().uuid().optional(),
    contact_phone: z.string().max(64).optional(),
    contact_email: z.string().email().optional(),
    notes: z.string().max(2000).optional(),
    queue_entry_id: z.string().uuid().optional(),
  }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  try {
    const cb = await createCallbackRequest(config, {
      workspaceId,
      channel: parsed.data.channel,
      conversationId: parsed.data.conversation_id ?? null,
      visitorSessionId: visitorId ?? null,
      contactPhone: parsed.data.contact_phone ?? null,
      contactEmail: parsed.data.contact_email ?? null,
      notes: parsed.data.notes ?? null,
    });
    if (parsed.data.queue_entry_id) {
      await markEntryAsCallback(config, parsed.data.queue_entry_id, cb.id);
    }
    res.json({ callback: cb });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'callback_failed' });
  }
});
