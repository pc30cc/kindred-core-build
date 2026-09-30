/**
 * /api/admin/platform-support — Super Admin's switch for platform support.
 *
 * Mounted under adminRouter, which already gates `/api/admin/*` behind
 * `requirePlatformAdmin`; each handler still asks for the actor's id.
 *
 *   GET /settings           { settings, workspace: { id, name } | null, suggestions }
 *   PUT /settings           { enabled?, workspaceId?, ticketsEnabled?, notifyEmails? }
 *   GET /workspaces?search= { workspaces: [{ id, name, slug }] } — for the picker
 */
import { Router } from 'express';
import { z } from 'zod';
import { getServiceClient } from '../supabase.js';
import { requirePlatformAdmin, serverConfigOf } from '../lib/workspaceAuth.js';
import {
  loadPlatformSupportSettings,
  savePlatformSupportSettings,
  invalidatePlatformSupportSettings,
} from '../services/platformSupport/settings.js';

export const adminPlatformSupportRouter = Router();

const settingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    workspaceId: z.string().uuid().nullable().optional(),
    ticketsEnabled: z.boolean().optional(),
    notifyEmails: z.array(z.string().max(254)).max(20).optional(),
  })
  .strict();

type Workspace = { id: string; name: string | null; slug: string | null };

adminPlatformSupportRouter.get('/settings', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  try {
    const config = serverConfigOf(req);
    const sb = getServiceClient(config);
    invalidatePlatformSupportSettings();
    const settings = await loadPlatformSupportSettings(config);
    let workspace: Workspace | null = null;
    if (settings.workspaceId) {
      const { data } = await sb.from('workspaces').select('id, name, slug').eq('id', settings.workspaceId).maybeSingle();
      workspace = (data as Workspace | null) ?? null;
    }
    // The workspaces this Super Admin runs are the likely answer.
    const { data: memberships } = await sb
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', actorId)
      .in('role', ['owner', 'admin'])
      .limit(20);
    const ids = ((memberships ?? []) as Array<{ workspace_id: string }>).map((m) => m.workspace_id);
    let suggestions: Workspace[] = [];
    if (ids.length) {
      const { data } = await sb.from('workspaces').select('id, name, slug').in('id', ids).order('name');
      suggestions = (data ?? []) as Workspace[];
    }
    return res.json({ settings, workspace, suggestions });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

adminPlatformSupportRouter.put('/settings', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues.map((i) => i.path.join('.')) });
  }
  try {
    const config = serverConfigOf(req);
    if (parsed.data.workspaceId) {
      const { data } = await getServiceClient(config)
        .from('workspaces')
        .select('id')
        .eq('id', parsed.data.workspaceId)
        .maybeSingle();
      if (!data) return res.status(404).json({ error: 'workspace_not_found' });
    }
    const settings = await savePlatformSupportSettings(config, parsed.data, actorId);
    if (settings.enabled && !settings.workspaceId) {
      return res.json({ success: true, settings, warning: 'no_workspace' });
    }
    return res.json({ success: true, settings });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

adminPlatformSupportRouter.get('/workspaces', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  // Commas and parentheses would end PostgREST's `or` filter early.
  const search = typeof req.query.search === 'string'
    ? req.query.search.replace(/[,()]/g, ' ').trim().slice(0, 80)
    : '';
  try {
    let query = getServiceClient(serverConfigOf(req)).from('workspaces').select('id, name, slug').order('name').limit(20);
    if (search) {
      // `%` and `_` typed by the admin are literal characters, not wildcards.
      const pattern = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.or(`name.ilike.${pattern},slug.ilike.${pattern}`);
    }
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ workspaces: (data ?? []) as Workspace[] });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});
