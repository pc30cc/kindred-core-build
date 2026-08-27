/**
 * Operator + platform-admin widget configuration routes.
 *
 * Replaces direct browser `supabase.from('widget_settings' | 'widget_prechat_settings'
 * | 'widget_platform_settings')` calls, which relied on RLS evaluating
 * `auth.uid()` against a Supabase Auth JWT the browser no longer holds
 * (first-party auth uses the `gs_session` cookie instead). Authorization here
 * mirrors the RLS policies being replaced exactly, including the
 * `workspace_owner_phone_verified` gate on workspace-level writes
 * (supabase/migrations/20260801214300_...sql).
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { authorizeWorkspaceAccess, requirePlatformAdmin } from '../lib/workspaceAuth.js';
import { assertPhoneVerificationSatisfied } from '../services/phoneVerification/index.js';
import { PhoneVerificationError } from '../services/phoneVerification/types.js';

export const widgetSettingsRouter = Router();

function serverConfigOf(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

async function requireManageWithPhoneVerified(
  req: any,
  res: any,
  workspaceId: string,
): Promise<{ userId: string } | null> {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return null;
  try {
    await assertPhoneVerificationSatisfied(serverConfigOf(req), {
      actorUserId: auth.userId,
      purpose: 'widget_access',
      workspaceId,
    });
  } catch (err) {
    if (err instanceof PhoneVerificationError) {
      res.status(err.status).json({ error: err.code });
      return null;
    }
    throw err;
  }
  return { userId: auth.userId };
}

// ── widget_settings (per workspace) ───────────────────────────────

widgetSettingsRouter.get('/:workspaceId', async (req, res) => {
  const config = serverConfigOf(req);
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('widget_settings')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ settings: data });
});

const widgetSettingsUpdateSchema = z.object({}).passthrough();

widgetSettingsRouter.patch('/:workspaceId', async (req, res) => {
  const config = serverConfigOf(req);
  const workspaceId = req.params.workspaceId;
  const parsed = widgetSettingsUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const auth = await requireManageWithPhoneVerified(req, res, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('widget_settings')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ settings: data });
});

// ── widget_prechat_settings (per workspace) ───────────────────────

widgetSettingsRouter.get('/:workspaceId/prechat', async (req, res) => {
  const config = serverConfigOf(req);
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('widget_prechat_settings')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ settings: data });
});

widgetSettingsRouter.put('/:workspaceId/prechat', async (req, res) => {
  const config = serverConfigOf(req);
  const workspaceId = req.params.workspaceId;
  const parsed = widgetSettingsUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const auth = await requireManageWithPhoneVerified(req, res, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('widget_prechat_settings')
    .upsert({ ...parsed.data, workspace_id: workspaceId }, { onConflict: 'workspace_id' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ settings: data });
});

// ── widget_platform_settings (global singleton, platform admin only) ──

widgetSettingsRouter.get('/platform/config', async (req, res) => {
  const config = serverConfigOf(req);
  if (!(await requirePlatformAdmin(req, res))) return;
  const sb = getServiceClient(config);

  const fail = (stage: string, error: any) =>
    res.status(500).json({
      error: `widget_platform_settings ${stage} failed: ${error?.message || 'unknown error'}`,
      detail: error?.details || undefined,
      hint:
        error?.code === '42P01'
          ? 'Table public.widget_platform_settings is missing — run database/migrations/044_widget_platform_settings.sql (and 046) against your database.'
          : error?.code === '42501'
            ? 'Permission denied — the backend must use the Supabase service_role key (SUPABASE_SERVICE_ROLE_KEY).'
            : error?.hint || undefined,
      code: error?.code || undefined,
    });

  const { data, error } = await sb
    .from('widget_platform_settings')
    .select('*')
    .limit(1)
    .maybeSingle();
  if (error) return fail('read', error);
  if (data) return res.json({ settings: data });

  // Self-host installs may have the table without the seeded singleton row
  // (or the row was deleted). Create it on demand — the table enforces a
  // singleton unique index, so concurrent seeds are safe.
  const seed = await sb.from('widget_platform_settings').insert({}).select().single();
  if (seed.error) {
    const retry = await sb.from('widget_platform_settings').select('*').limit(1).maybeSingle();
    if (retry.data) return res.json({ settings: retry.data });
    return fail('seed', seed.error);
  }
  return res.json({ settings: seed.data });
});



widgetSettingsRouter.patch('/platform/config', async (req, res) => {
  const config = serverConfigOf(req);
  const parsed = widgetSettingsUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const userId = await requirePlatformAdmin(req, res);
  if (!userId) return;
  const id = typeof req.body?.id === 'string' ? req.body.id : undefined;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const { id: _drop, ...updates } = parsed.data as Record<string, unknown>;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('widget_platform_settings')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ settings: data });
});
