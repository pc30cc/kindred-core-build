/**
 * NOTIFICATION PREFERENCES — self-service for the authenticated user.
 *
 * Auth: first-party session cookie (server/lib/workspaceAuth.ts).
 * Storage: row-per-user (workspace_id NULL means "global default").
 * Backward-compatible: returns sensible defaults if no row exists yet.
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requireUser as requireSessionUser } from '../lib/workspaceAuth.js';

export const notificationsRouter = Router();

async function requireUser(req: any, res: any, next: any) {
  const userId = await requireSessionUser(req, res);
  if (!userId) return;
  req.authUser = { id: userId };
  next();
}

notificationsRouter.use(requireUser);

const DEFAULTS = {
  disable_all: false,
  push_when_online: true,
  push_when_offline: true,
  push_visitor_browsing: false,
  play_sound: true,
  email_unread_messages: true,
  email_transcripts: false,
  email_user_ratings: true,
  email_paid_invoices: true,
  email_weekly_summary: false,
  email_product_updates: false,
  quiet_hours_enabled: false,
  quiet_hours_start: null as string | null,
  quiet_hours_end: null as string | null,
  quiet_hours_timezone: null as string | null,
};

// GET /api/notifications/prefs
notificationsRouter.get('/prefs', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const user = (req as any).authUser;
    const sb = getServiceClient(config);

    const { data, error } = await sb
      .from('user_notification_prefs')
      .select('*')
      .eq('user_id', user.id)
      .is('workspace_id', null)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ prefs: { ...DEFAULTS, ...(data || {}) } });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to load preferences' });
  }
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const updateSchema = z.object({
  disable_all: z.boolean().optional(),
  push_when_online: z.boolean().optional(),
  push_when_offline: z.boolean().optional(),
  push_visitor_browsing: z.boolean().optional(),
  play_sound: z.boolean().optional(),
  email_unread_messages: z.boolean().optional(),
  email_transcripts: z.boolean().optional(),
  email_user_ratings: z.boolean().optional(),
  email_paid_invoices: z.boolean().optional(),
  email_weekly_summary: z.boolean().optional(),
  email_product_updates: z.boolean().optional(),
  quiet_hours_enabled: z.boolean().optional(),
  quiet_hours_start: z.string().regex(TIME_RE).nullable().optional(),
  quiet_hours_end: z.string().regex(TIME_RE).nullable().optional(),
  quiet_hours_timezone: z.string().max(60).nullable().optional(),
});

// PATCH /api/notifications/prefs — upsert by (user_id, workspace_id NULL)
notificationsRouter.patch('/prefs', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const user = (req as any).authUser;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid input',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const sb = getServiceClient(config);

    const { data: existing } = await sb
      .from('user_notification_prefs')
      .select('id')
      .eq('user_id', user.id)
      .is('workspace_id', null)
      .maybeSingle();

    if (existing?.id) {
      const { data, error } = await sb
        .from('user_notification_prefs')
        .update(parsed.data)
        .eq('id', existing.id)
        .select('*')
        .maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ prefs: { ...DEFAULTS, ...(data || {}) } });
    }

    const { data, error } = await sb
      .from('user_notification_prefs')
      .insert({ user_id: user.id, workspace_id: null, ...parsed.data })
      .select('*')
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ prefs: { ...DEFAULTS, ...(data || {}) } });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to update preferences' });
  }
});
