/**
 * Phase 8H Completion — Workspace-scoped department management.
 *
 * Mounted under /api/workspace-departments. Workspace owner/admin only.
 * All mutating endpoints invalidate the per-workspace department cache so
 * routing, widget visibility, and diagnostics see fresh state immediately.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  invalidateDepartmentCache,
  resolveDepartments,
  resolveDepartmentMembers,
  resolveGeneralPool,
  resolveWidgetVisibleDepartments,
  buildDepartmentDiagnostics,
  loadFallbackPolicy,
  saveFallbackPolicy,
} from '../services/calls/departments.js';
import { loadGlobalAdvancedRouting, ownerFallbackAllowedGlobal } from '../services/calls/globalAdvancedRouting.js';
import { authorizeWorkspaceAccess, serverConfigOf } from '../lib/workspaceAuth.js';
import { publishCacheInvalidation } from '../lib/cacheBus.js';
import { canUseInbox } from '../../shared/chatRoles.js';

export const workspaceDepartmentsRouter = Router();

async function requireWorkspaceAdmin(
  req: Parameters<typeof authorizeWorkspaceAccess>[0],
  res: Parameters<typeof authorizeWorkspaceAccess>[1],
  workspaceId: string,
): Promise<{ userId: string } | null> {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return null;
  return { userId: auth.userId };
}

// ---------------------------------------------------------------------------
// Departments CRUD
// ---------------------------------------------------------------------------

// GET /api/workspace-departments/:workspaceId
workspaceDepartmentsRouter.get('/:workspaceId', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await requireWorkspaceAdmin(req, res, workspaceId);
  if (!auth) return;
  const config: ServerConfig = serverConfigOf(req);
  const sb = getServiceClient(config);
  // Admin view shows ALL departments (including disabled), so we bypass the
  // enabled-only resolver.
  const { data, error } = await sb
    .from('workspace_departments')
    .select('id, workspace_id, name, enabled, chat_enabled, audio_enabled, video_enabled, tickets_enabled, cc_voice_enabled, cc_video_enabled, cc_callback_enabled, cc_routing_mode, cc_fallback_department_id, sort_order, created_at, updated_at')
    .eq('workspace_id', workspaceId)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ departments: data ?? [] });
});

const createSchema = z.object({
  name: z.string().min(1).max(64),
  enabled: z.boolean().optional(),
  chat_enabled: z.boolean().optional(),
  audio_enabled: z.boolean().optional(),
  video_enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  // CC-2G-UI-Architecture-Fix — unified channel flags managed here.
  tickets_enabled: z.boolean().optional(),
  cc_voice_enabled: z.boolean().optional(),
  cc_video_enabled: z.boolean().optional(),
  cc_callback_enabled: z.boolean().optional(),
  cc_routing_mode: z.enum(['broadcast', 'round_robin', 'least_busy']).nullable().optional(),
  cc_fallback_department_id: z.string().uuid().nullable().optional(),
});

// POST /api/workspace-departments/:workspaceId
workspaceDepartmentsRouter.post('/:workspaceId', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await requireWorkspaceAdmin(req, res, workspaceId);
  if (!auth) return;
  try {
    const body = createSchema.parse(req.body);
    const config: ServerConfig = serverConfigOf(req);
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('workspace_departments')
      .insert({
        workspace_id: workspaceId,
        name: body.name.trim(),
        enabled: body.enabled ?? true,
        chat_enabled: body.chat_enabled ?? true,
        audio_enabled: body.audio_enabled ?? false,
        video_enabled: body.video_enabled ?? false,
        sort_order: body.sort_order ?? 0,
        tickets_enabled: body.tickets_enabled ?? false,
        cc_voice_enabled: body.cc_voice_enabled ?? false,
        cc_video_enabled: body.cc_video_enabled ?? false,
        cc_callback_enabled: body.cc_callback_enabled ?? false,
        cc_routing_mode: body.cc_routing_mode ?? null,
        cc_fallback_department_id: body.cc_fallback_department_id ?? null,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    invalidateDepartmentCache(workspaceId);
    // The call widget bootstrap lists the departments (every process).
    publishCacheInvalidation([`widget:${workspaceId}`]);
    res.status(201).json({ department: data });
  } catch (err: unknown) {
    res.status(400).json({ error: (err instanceof Error && err.message) || 'invalid_request' });
  }
});

const updateSchema = createSchema.partial();

// PATCH /api/workspace-departments/:workspaceId/:id
workspaceDepartmentsRouter.patch('/:workspaceId/:id', async (req, res) => {
  const { workspaceId, id } = req.params;
  const auth = await requireWorkspaceAdmin(req, res, workspaceId);
  if (!auth) return;
  try {
    const body = updateSchema.parse(req.body);
    const config: ServerConfig = serverConfigOf(req);
    const sb = getServiceClient(config);
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.chat_enabled !== undefined) patch.chat_enabled = body.chat_enabled;
    if (body.audio_enabled !== undefined) patch.audio_enabled = body.audio_enabled;
    if (body.video_enabled !== undefined) patch.video_enabled = body.video_enabled;
    if (body.sort_order !== undefined) patch.sort_order = body.sort_order;
    if (body.tickets_enabled !== undefined) patch.tickets_enabled = body.tickets_enabled;
    if (body.cc_voice_enabled !== undefined) patch.cc_voice_enabled = body.cc_voice_enabled;
    if (body.cc_video_enabled !== undefined) patch.cc_video_enabled = body.cc_video_enabled;
    if (body.cc_callback_enabled !== undefined) patch.cc_callback_enabled = body.cc_callback_enabled;
    if (body.cc_routing_mode !== undefined) patch.cc_routing_mode = body.cc_routing_mode;
    if (body.cc_fallback_department_id !== undefined) patch.cc_fallback_department_id = body.cc_fallback_department_id;
    const { data, error } = await sb
      .from('workspace_departments')
      .update(patch)
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    invalidateDepartmentCache(workspaceId);
    publishCacheInvalidation([`widget:${workspaceId}`]);
    res.json({ department: data });
  } catch (err: unknown) {
    res.status(400).json({ error: (err instanceof Error && err.message) || 'invalid_request' });
  }
});

// DELETE /api/workspace-departments/:workspaceId/:id
workspaceDepartmentsRouter.delete('/:workspaceId/:id', async (req, res) => {
  const { workspaceId, id } = req.params;
  const auth = await requireWorkspaceAdmin(req, res, workspaceId);
  if (!auth) return;
  const config: ServerConfig = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('workspace_departments')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  if (error) return res.status(500).json({ error: error.message });
  invalidateDepartmentCache(workspaceId);
  publishCacheInvalidation([`widget:${workspaceId}`]);
  res.json({ ok: true });
});

// GET /api/workspace-departments/:workspaceId/directory
// The departments as the Inbox shows them — a conversation's department, the
// list's department filter and "Transfer to a department" — with who is in
// each. Read-only, for every member who has the Inbox (shared/chatRoles.ts):
// an operator handing their own chat to Sales must be able to name Sales,
// while the rest of this router is the owner's and admins' management API.
// Names and member ids only, nothing the member list does not already show.
workspaceDepartmentsRouter.get('/:workspaceId/directory', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!auth.isAdmin && !canUseInbox(auth.role)) {
    return res.status(403).json({ error: 'inbox_not_allowed' });
  }
  const config: ServerConfig = serverConfigOf(req);
  const sb = getServiceClient(config);
  const [{ data: depts, error }, { data: links, error: linkErr }] = await Promise.all([
    sb
      .from('workspace_departments')
      .select('id, name, enabled, chat_enabled, sort_order')
      .eq('workspace_id', workspaceId)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true }),
    sb
      .from('workspace_department_members')
      .select('department_id, user_id')
      .eq('workspace_id', workspaceId),
  ]);
  if (error || linkErr) return res.status(500).json({ error: (error || linkErr)?.message });
  const membersByDept = new Map<string, string[]>();
  for (const link of (links ?? []) as Array<{ department_id: string; user_id: string }>) {
    const list = membersByDept.get(link.department_id) ?? [];
    list.push(link.user_id);
    membersByDept.set(link.department_id, list);
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    departments: ((depts ?? []) as Array<{ id: string; name: string; enabled: boolean; chat_enabled: boolean }>).map((d) => ({
      id: d.id,
      name: d.name,
      enabled: d.enabled !== false,
      chat_enabled: d.chat_enabled !== false,
      member_ids: membersByDept.get(d.id) ?? [],
    })),
  });
});

// ---------------------------------------------------------------------------
// Department members
// ---------------------------------------------------------------------------

// GET /api/workspace-departments/:workspaceId/:id/members
workspaceDepartmentsRouter.get('/:workspaceId/:id/members', async (req, res) => {
  const { workspaceId, id } = req.params;
  const auth = await requireWorkspaceAdmin(req, res, workspaceId);
  if (!auth) return;
  const config: ServerConfig = serverConfigOf(req);
  const userIds = await resolveDepartmentMembers(config, id);
  res.json({ user_ids: userIds });
});

const setMembersSchema = z.object({
  user_ids: z.array(z.string().uuid()),
});

// PUT /api/workspace-departments/:workspaceId/:id/members
// Replace the full member set for a department.
workspaceDepartmentsRouter.put('/:workspaceId/:id/members', async (req, res) => {
  const { workspaceId, id } = req.params;
  const auth = await requireWorkspaceAdmin(req, res, workspaceId);
  if (!auth) return;
  try {
    const body = setMembersSchema.parse(req.body);
    const config: ServerConfig = serverConfigOf(req);
    const sb = getServiceClient(config);
    // Validate all user_ids are workspace members.
    if (body.user_ids.length > 0) {
      const { data: valid } = await sb
        .from('workspace_members')
        .select('user_id')
        .eq('workspace_id', workspaceId)
        .in('user_id', body.user_ids);
      const validSet = new Set((valid ?? []).map((r: { user_id: string }) => r.user_id));
      const invalid = body.user_ids.filter((u) => !validSet.has(u));
      if (invalid.length > 0) {
        return res.status(400).json({ error: 'not_workspace_members', invalid });
      }
    }
    // Replace set: delete + insert in a small batch.
    const { error: delErr } = await sb
      .from('workspace_department_members')
      .delete()
      .eq('department_id', id)
      .eq('workspace_id', workspaceId);
    if (delErr) return res.status(500).json({ error: delErr.message });
    if (body.user_ids.length > 0) {
      const rows = body.user_ids.map((uid) => ({
        department_id: id,
        workspace_id: workspaceId,
        user_id: uid,
      }));
      const { error: insErr } = await sb
        .from('workspace_department_members')
        .insert(rows);
      if (insErr) return res.status(500).json({ error: insErr.message });
    }
    invalidateDepartmentCache(workspaceId);
    res.json({ ok: true, count: body.user_ids.length });
  } catch (err: unknown) {
    res.status(400).json({ error: (err instanceof Error && err.message) || 'invalid_request' });
  }
});

// ---------------------------------------------------------------------------
// Fallback policy
// ---------------------------------------------------------------------------

const fallbackSchema = z.object({
  owner_fallback_enabled: z.boolean().optional(),
  owner_fallback_for_chat: z.boolean().optional(),
  owner_fallback_for_audio: z.boolean().optional(),
  owner_fallback_for_video: z.boolean().optional(),
  general_pool_enabled: z.boolean().optional(),
});

// GET /api/workspace-departments/:workspaceId/fallback
workspaceDepartmentsRouter.get('/:workspaceId/fallback', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await requireWorkspaceAdmin(req, res, workspaceId);
  if (!auth) return;
  const config: ServerConfig = serverConfigOf(req);
  const policy = await loadFallbackPolicy(config, workspaceId);
  res.json({ policy });
});

// PUT /api/workspace-departments/:workspaceId/fallback
workspaceDepartmentsRouter.put('/:workspaceId/fallback', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await requireWorkspaceAdmin(req, res, workspaceId);
  if (!auth) return;
  try {
    const body = fallbackSchema.parse(req.body);
    const config: ServerConfig = serverConfigOf(req);
    const policy = await saveFallbackPolicy(config, workspaceId, body);
    res.json({ policy });
  } catch (err: unknown) {
    res.status(400).json({ error: (err instanceof Error && err.message) || 'invalid_request' });
  }
});

// GET /api/workspace-departments/:workspaceId/routing-policy
// The Super Admin's platform rules as they apply to this workspace's chats
// (globalAdvancedRouting.ts), read only, so the panel says what routing
// really does: whether a department's chats fall back to the whole team,
// whether returning visitors may go back to their operator at all, and
// whether the owner is the last resort. (The per-workspace /fallback record
// above is legacy: chat routing does not read it.)
workspaceDepartmentsRouter.get('/:workspaceId/routing-policy', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await requireWorkspaceAdmin(req, res, workspaceId);
  if (!auth) return;
  const global = await loadGlobalAdvancedRouting(serverConfigOf(req));
  res.json({
    policy: {
      general_pool_enabled: global.general_pool_enabled,
      last_agent_routing_enabled: global.last_agent_routing_enabled,
      owner_fallback_for_chat: ownerFallbackAllowedGlobal(global, 'chat'),
    },
  });
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

// GET /api/workspace-departments/:workspaceId/diagnostics?channel=chat|audio|video
workspaceDepartmentsRouter.get('/:workspaceId/diagnostics', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await requireWorkspaceAdmin(req, res, workspaceId);
  if (!auth) return;
  const channelRaw = String(req.query.channel || 'chat');
  const channel = (['chat', 'audio', 'video'].includes(channelRaw)
    ? channelRaw
    : 'chat') as 'chat' | 'audio' | 'video';
  const config: ServerConfig = serverConfigOf(req);
  const diag = await buildDepartmentDiagnostics(config, workspaceId, channel);
  res.json({ diagnostics: diag });
});

// ---------------------------------------------------------------------------
// Widget-visible read endpoint (workspace-internal, admin only — used by
// admin diagnostics UI to preview the visitor experience). Public widget
// uses /api/widget/departments/visible instead.
// ---------------------------------------------------------------------------

workspaceDepartmentsRouter.get('/:workspaceId/visible', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await requireWorkspaceAdmin(req, res, workspaceId);
  if (!auth) return;
  const channelRaw = String(req.query.channel || 'chat');
  const channel = (['chat', 'audio', 'video'].includes(channelRaw)
    ? channelRaw
    : 'chat') as 'chat' | 'audio' | 'video';
  const config: ServerConfig = serverConfigOf(req);
  const visible = await resolveWidgetVisibleDepartments(config, workspaceId, channel);
  res.json({ channel, visible });
});