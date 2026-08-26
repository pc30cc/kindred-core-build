/**
 * Phase 8C — Workspace-scoped call settings + role permission overrides.
 *
 * Mounted under /api/workspace-calls. Workspace owner/admin only.
 * Settings live in workspace_provider_settings (provider_type='call'),
 * permission overrides live in role_permissions (workspace_id=...).
 *
 * Effective state always = global AND workspace; the controlPlane
 * module owns that resolution so we never duplicate it here.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  loadCallControlPlane,
  loadWorkspaceCallOverrides,
  saveWorkspaceCallOverrides,
  loadEffectiveCallChannels,
} from '../services/calls/controlPlane.js';
import {
  ALL_CALL_PERMISSIONS,
  invalidatePermissionCache,
} from '../services/calls/permissions.js';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';

export const workspaceCallsRouter = Router();

const ROLES = ['owner', 'admin', 'agent', 'viewer'] as const;

async function requireWorkspaceAdmin(
  req: any,
  res: any,
  workspaceId: string,
): Promise<{ userId: string } | null> {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return null;
  return { userId: auth.userId };
}

// GET /api/workspace-calls/:workspaceId/settings
workspaceCallsRouter.get('/:workspaceId/settings', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await requireWorkspaceAdmin(req, res, workspaceId);
  if (!auth) return;
  const config: ServerConfig = (req as any).serverConfig;
  const [overrides, global, effective] = await Promise.all([
    loadWorkspaceCallOverrides(config, workspaceId),
    loadCallControlPlane(config),
    loadEffectiveCallChannels(config, workspaceId),
  ]);
  res.json({
    overrides,
    global_gates: {
      enabled: global.enabled,
      voice_calls_enabled_global: global.voice_calls_enabled_global,
      video_calls_enabled_global: global.video_calls_enabled_global,
      call_recording_enabled_global: global.call_recording_enabled_global,
      call_queue_enabled_global: global.call_queue_enabled_global,
      visitor_initiated_audio_enabled_global: global.visitor_initiated_audio_enabled_global,
      visitor_initiated_video_enabled_global: global.visitor_initiated_video_enabled_global,
    },
    effective,
  });
});

const overridesSchema = z.object({
  voice_calls_enabled: z.boolean().optional(),
  video_calls_enabled: z.boolean().optional(),
  call_recording_enabled: z.boolean().optional(),
  call_queue_enabled: z.boolean().optional(),
  visitor_initiated_audio_enabled: z.boolean().optional(),
  visitor_initiated_video_enabled: z.boolean().optional(),
  allow_voice: z.boolean().optional(),
  allow_video: z.boolean().optional(),
  allow_recording: z.boolean().optional(),
  default_video_quality: z.enum(['auto', 'low', 'medium', 'high', 'hd']).optional(),
});

// PUT /api/workspace-calls/:workspaceId/settings
workspaceCallsRouter.put('/:workspaceId/settings', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await requireWorkspaceAdmin(req, res, workspaceId);
  if (!auth) return;
  try {
    const patch = overridesSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    const merged = await saveWorkspaceCallOverrides(config, workspaceId, patch);
    const effective = await loadEffectiveCallChannels(config, workspaceId);
    res.json({ overrides: merged, effective });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'update_failed' });
  }
});

// GET /api/workspace-calls/:workspaceId/role-permissions
// Returns a dense matrix: roles × call permissions. Workspace overrides
// fully replace the platform default for that single (role, perm) pair.
workspaceCallsRouter.get('/:workspaceId/role-permissions', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await requireWorkspaceAdmin(req, res, workspaceId);
  if (!auth) return;
  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('role_permissions')
    .select('role_slug, permission_key, granted, workspace_id')
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`);
  if (error) return res.status(500).json({ error: error.message });

  const platform: Record<string, Record<string, boolean>> = {};
  const workspace: Record<string, Record<string, boolean | null>> = {};
  for (const r of ROLES) {
    platform[r] = {};
    workspace[r] = {};
    for (const p of ALL_CALL_PERMISSIONS) {
      platform[r][p] = false;
      workspace[r][p] = null; // null = inherit
    }
  }
  for (const row of data ?? []) {
    if (!(ALL_CALL_PERMISSIONS as string[]).includes(row.permission_key)) continue;
    if (!ROLES.includes(row.role_slug as any)) continue;
    if (row.workspace_id === null) {
      platform[row.role_slug][row.permission_key] = !!row.granted;
    } else {
      workspace[row.role_slug][row.permission_key] = !!row.granted;
    }
  }
  res.json({
    platform,
    workspace,
    roles: ROLES,
    permissions: ALL_CALL_PERMISSIONS,
  });
});

const wsRolePermSchema = z.object({
  role_slug: z.enum(ROLES),
  permission_key: z.enum(ALL_CALL_PERMISSIONS as unknown as [string, ...string[]]),
  // null = remove the workspace override (inherit platform default)
  granted: z.boolean().nullable(),
});

// PUT /api/workspace-calls/:workspaceId/role-permissions
workspaceCallsRouter.put('/:workspaceId/role-permissions', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await requireWorkspaceAdmin(req, res, workspaceId);
  if (!auth) return;
  try {
    const body = wsRolePermSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    // Always clear the existing override row first.
    const { error: delErr } = await sb
      .from('role_permissions')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('role_slug', body.role_slug)
      .eq('permission_key', body.permission_key);
    if (delErr) return res.status(500).json({ error: delErr.message });
    if (body.granted !== null) {
      const { error: insErr } = await sb.from('role_permissions').insert({
        workspace_id: workspaceId,
        role_slug: body.role_slug,
        permission_key: body.permission_key,
        granted: body.granted,
      });
      if (insErr) return res.status(500).json({ error: insErr.message });
    }
    invalidatePermissionCache(workspaceId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'update_failed' });
  }
});