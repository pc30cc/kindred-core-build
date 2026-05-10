/**
 * Call Center — operator/admin HTTP routes (workspace-scoped).
 * Mounted at /api/call-center/*.
 * Uses existing call_sessions / call_queue_entries / callback_requests tables.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  getOrCreateWorkspaceSettings,
  updateWorkspaceSettings,
  getPlatformCallCenterSettings,
  computeEffectiveCallCenterCaps,
  updatePlatformCallCenterSettings,
  invalidatePlatformCallCenterCache,
} from '../services/callCenter/settings.js';
import { isGlobalAdmin } from '../middleware/adminBypass.js';
import { resolveEffectiveCallProvider } from '../services/calls/providerResolver.js';
import { publishQueueEvent, publishCallEvent } from '../services/callCenter/realtime.js';
import { uploadFile } from '../services/storage/index.js';
import crypto from 'crypto';

export const callCenterRouter = Router();

// ── auth helpers ───────────────────────────────────────────────────────────
async function getUser(req: any, config: ServerConfig) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const sb = getServiceClient(config);
  const { data: { user } } = await sb.auth.getUser(auth.replace('Bearer ', ''));
  return user || null;
}

async function requireMember(req: any, res: any, workspaceId: string) {
  const config = (req as any).serverConfig as ServerConfig;
  const user = await getUser(req, config);
  if (!user) { res.status(401).json({ error: 'unauthenticated' }); return null; }
  const sb = getServiceClient(config);
  const { data: ok } = await sb.rpc('is_workspace_member', {
    _workspace_id: workspaceId, _user_id: user.id,
  });
  if (!ok) { res.status(403).json({ error: 'not_member' }); return null; }
  return { userId: user.id, config };
}

async function requireWorkspaceAdmin(req: any, res: any, workspaceId: string) {
  const ctx = await requireMember(req, res, workspaceId);
  if (!ctx) return null;
  const sb = getServiceClient(ctx.config);
  const { data: role } = await sb.rpc('get_workspace_role', {
    _workspace_id: workspaceId, _user_id: ctx.userId,
  });
  if (!['owner', 'admin'].includes(String(role))) {
    res.status(403).json({ error: 'forbidden' }); return null;
  }
  return ctx;
}

async function requireGlobalAdmin(req: any, res: any) {
  const config = (req as any).serverConfig as ServerConfig;
  const user = await getUser(req, config);
  if (!user) { res.status(401).json({ error: 'unauthenticated' }); return null; }
  const ok = await isGlobalAdmin(config, user.id);
  if (!ok) { res.status(403).json({ error: 'forbidden' }); return null; }
  return { userId: user.id, config };
}

// ── Workspace settings ─────────────────────────────────────────────────────
callCenterRouter.get('/settings', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const settings = await getOrCreateWorkspaceSettings(ctx.config, wid);
  const platform = await getPlatformCallCenterSettings(ctx.config);
  const effective = computeEffectiveCallCenterCaps(platform, settings);
  res.json({ settings, platform, effective });
});

const settingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  allowed_domains: z.array(z.string()).optional(),
  widget_position: z.string().optional(),
  widget_theme: z.record(z.unknown()).optional(),
  display_name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  avatar_storage_path: z.string().nullable().optional(),
  voice_enabled: z.boolean().optional(),
  video_enabled: z.boolean().optional(),
  callback_enabled: z.boolean().optional(),
  pre_call_form_enabled: z.boolean().optional(),
  pre_call_form_schema: z.array(z.unknown()).optional(),
  business_hours: z.record(z.unknown()).optional(),
  offline_behavior: z.string().optional(),
  recording_enabled: z.boolean().optional(),
  recording_consent_required: z.boolean().optional(),
  routing_mode: z.string().optional(),
  default_department_id: z.string().uuid().nullable().optional(),
});

callCenterRouter.put('/settings', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireWorkspaceAdmin(req, res, wid);
  if (!ctx) return;
  const parsed = settingsPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  const settings = await updateWorkspaceSettings(ctx.config, wid, parsed.data as any);
  res.json({ settings });
});

// ── Avatar upload (owner/admin only) ──────────────────────────────────────
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_AVATAR_MIME = ['image/png', 'image/jpeg', 'image/webp'];

callCenterRouter.post('/settings/avatar', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireWorkspaceAdmin(req, res, wid);
  if (!ctx) return;
  const { fileName, contentType, data } = req.body || {};
  if (!fileName || !contentType || !data) return res.status(400).json({ error: 'fileName_contentType_data_required' });
  if (!ALLOWED_AVATAR_MIME.includes(String(contentType))) return res.status(415).json({ error: 'unsupported_media_type' });
  let buffer: Buffer;
  try { buffer = Buffer.from(String(data), 'base64'); } catch { return res.status(400).json({ error: 'invalid_data' }); }
  if (buffer.length === 0 || buffer.length > MAX_AVATAR_BYTES) return res.status(413).json({ error: 'file_too_large' });
  const safe = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const fileKey = `workspace/${wid}/call-center/avatar/${crypto.randomUUID()}-${safe}`;
  const result = await uploadFile(ctx.config, {
    workspaceId: wid, fileKey, data: buffer, contentType: String(contentType),
  });
  if (!result.success || !result.url) return res.status(500).json({ error: 'upload_failed', details: (result as any).error });
  const updated = await updateWorkspaceSettings(ctx.config, wid, {
    avatar_url: result.url, avatar_storage_path: fileKey,
  } as any);
  res.json({ avatar_url: updated.avatar_url, avatar_storage_path: updated.avatar_storage_path });
});

// ── Overview / metrics ────────────────────────────────────────────────────
callCenterRouter.get('/overview', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const sb = getServiceClient(ctx.config);
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [todayCalls, waitingQ, activeCalls, missedToday, callbacks, providerInfo] = await Promise.all([
    sb.from('call_sessions').select('id', { count: 'exact', head: true })
      .eq('workspace_id', wid).eq('entry_source', 'call_widget').gte('created_at', startOfDay.toISOString()),
    sb.from('call_queue_entries').select('id', { count: 'exact', head: true })
      .eq('workspace_id', wid).eq('entry_source', 'call_widget').in('state', ['queued', 'offered']),
    sb.from('call_sessions').select('id', { count: 'exact', head: true })
      .eq('workspace_id', wid).eq('entry_source', 'call_widget').in('state', ['active', 'ringing', 'connecting']),
    sb.from('call_sessions').select('id', { count: 'exact', head: true })
      .eq('workspace_id', wid).eq('entry_source', 'call_widget').eq('state', 'missed').gte('created_at', startOfDay.toISOString()),
    sb.from('callback_requests').select('id', { count: 'exact', head: true })
      .eq('workspace_id', wid).in('status', ['pending', 'requested', 'open']),
    resolveEffectiveCallProvider(ctx.config, wid).then(p => ({ provider: p.id, ready: true })).catch(e => ({ provider: 'none', ready: false, error: String(e?.message || e) })),
  ]);
  res.json({
    today_calls: todayCalls.count || 0,
    waiting_calls: waitingQ.count || 0,
    active_calls: activeCalls.count || 0,
    missed_today: missedToday.count || 0,
    callbacks_pending: callbacks.count || 0,
    provider: providerInfo,
  });
});

// ── Calls list / detail ───────────────────────────────────────────────────
callCenterRouter.get('/calls', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const sb = getServiceClient(ctx.config);
  const status = req.query.status ? String(req.query.status) : null;
  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
  const offset = parseInt(String(req.query.offset || '0'), 10) || 0;
  let q = sb.from('call_sessions').select('*').eq('workspace_id', wid)
    .eq('entry_source', 'call_widget')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (status) q = q.eq('state', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ calls: data || [] });
});

callCenterRouter.get('/calls/:id', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const sb = getServiceClient(ctx.config);
  const { data: call } = await sb.from('call_sessions').select('*').eq('id', req.params.id).eq('workspace_id', wid).maybeSingle();
  if (!call) return res.status(404).json({ error: 'not_found' });
  const { data: events } = await sb.from('call_events').select('*').eq('call_session_id', req.params.id).order('created_at', { ascending: true });
  res.json({ call, events: events || [] });
});

// ── Live queue ────────────────────────────────────────────────────────────
callCenterRouter.get('/queue', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const sb = getServiceClient(ctx.config);
  const { data: queue } = await sb.from('call_queue_entries')
    .select('*, call_session:call_session_id(*)')
    .eq('workspace_id', wid).eq('entry_source', 'call_widget')
    .in('state', ['queued', 'offered'])
    .order('priority', { ascending: false }).order('created_at', { ascending: true });
  res.json({ queue: queue || [] });
});

// ── Accept / reject / end ─────────────────────────────────────────────────
async function transitionCall(
  config: ServerConfig,
  wid: string,
  callId: string,
  patch: Record<string, unknown>,
  eventType: 'call_accepted' | 'call_rejected' | 'call_ended',
  actorId: string,
) {
  const sb = getServiceClient(config);
  const { data: updated, error } = await sb.from('call_sessions')
    .update(patch).eq('id', callId).eq('workspace_id', wid).select('*').maybeSingle();
  if (error) throw error;
  await sb.from('call_events').insert({
    call_session_id: callId, event_type: eventType, actor_type: 'operator', actor_id: actorId, payload: patch,
  });
  await publishQueueEvent(config, wid, eventType, { call_id: callId });
  await publishCallEvent(config, wid, callId, eventType, { call_id: callId });
  return updated;
}

callCenterRouter.post('/calls/:id/accept', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  try {
    const sb = getServiceClient(ctx.config);
    // Resolve provider and create room if needed
    const { id: providerId, provider } = await resolveEffectiveCallProvider(ctx.config, wid);
    const { data: call } = await sb.from('call_sessions').select('*').eq('id', req.params.id).eq('workspace_id', wid).maybeSingle();
    if (!call) return res.status(404).json({ error: 'not_found' });
    let providerRoomId = (call as any).provider_room_id as string | null;
    if (!providerRoomId) {
      const room = await provider.createRoom(ctx.config, {
        workspaceId: wid,
        callSessionId: req.params.id,
        callType: ((call as any).call_type === 'video' ? 'video' : 'audio'),
        maxParticipants: 4,
        recordingEnabled: false,
      });
      providerRoomId = room.providerRoomId;
    }
    const tok = await provider.createParticipantToken(ctx.config, {
      callSessionId: req.params.id,
      providerRoomId,
      participantId: ctx.userId,
      participantType: 'operator',
      canPublish: true, canSubscribe: true, canPublishData: true,
      ttlSeconds: 60 * 60,
    });
    await transitionCall(ctx.config, wid, req.params.id, {
      state: 'active',
      connected_at: new Date().toISOString(),
      provider: providerId,
      provider_room_id: providerRoomId,
    }, 'call_accepted', ctx.userId);
    // Update queue entry
    await sb.from('call_queue_entries').update({
      state: 'accepted', accepted_at: new Date().toISOString(), offered_to_user_id: ctx.userId,
    }).eq('call_session_id', req.params.id).eq('workspace_id', wid);
    res.json({ ok: true, provider: providerId, provider_room_id: providerRoomId, token: tok.token, expires_at: tok.expiresAt });
  } catch (e: any) {
    res.status(500).json({ error: 'accept_failed', message: String(e?.message || e) });
  }
});

callCenterRouter.post('/calls/:id/reject', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  try {
    const sb = getServiceClient(ctx.config);
    await transitionCall(ctx.config, wid, req.params.id, {
      state: 'cancelled', ended_at: new Date().toISOString(), end_reason: 'agent_rejected',
    }, 'call_rejected', ctx.userId);
    await sb.from('call_queue_entries').update({
      state: 'cancelled', ended_at: new Date().toISOString(), ended_reason: 'rejected',
    }).eq('call_session_id', req.params.id).eq('workspace_id', wid);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: 'reject_failed', message: String(e?.message || e) });
  }
});

callCenterRouter.post('/calls/:id/end', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  try {
    const sb = getServiceClient(ctx.config);
    const { data: call } = await sb.from('call_sessions').select('*').eq('id', req.params.id).eq('workspace_id', wid).maybeSingle();
    if (!call) return res.status(404).json({ error: 'not_found' });
    const startedAt = (call as any).connected_at || (call as any).started_at || (call as any).created_at;
    const duration = startedAt ? Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)) : 0;
    if ((call as any).provider && (call as any).provider_room_id) {
      try {
        const { provider } = await resolveEffectiveCallProvider(ctx.config, wid);
        await provider.closeRoom(ctx.config, (call as any).provider_room_id);
      } catch {/* best effort */}
    }
    await transitionCall(ctx.config, wid, req.params.id, {
      state: 'ended', ended_at: new Date().toISOString(),
      duration_seconds: duration, end_reason: 'agent_ended',
    }, 'call_ended', ctx.userId);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: 'end_failed', message: String(e?.message || e) });
  }
});

// ── Agent status ──────────────────────────────────────────────────────────
callCenterRouter.get('/agent-status', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const sb = getServiceClient(ctx.config);
  const { data } = await sb.from('operator_call_availability').select('*').eq('workspace_id', wid);
  res.json({ agents: data || [] });
});

callCenterRouter.post('/agent-status', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const status = String(req.body?.status || 'available');
  const sb = getServiceClient(ctx.config);
  await sb.from('operator_call_availability').upsert({
    workspace_id: wid, user_id: ctx.userId, status, updated_at: new Date().toISOString(),
  }, { onConflict: 'workspace_id,user_id' });
  await publishQueueEvent(ctx.config, wid, 'agent_status_changed', { user_id: ctx.userId, status });
  res.json({ ok: true });
});

// ── Callbacks ─────────────────────────────────────────────────────────────
callCenterRouter.get('/callbacks', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const status = req.query.status ? String(req.query.status) : null;
  const sb = getServiceClient(ctx.config);
  let q = sb.from('callback_requests').select('*').eq('workspace_id', wid).order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data } = await q;
  res.json({ callbacks: data || [] });
});

callCenterRouter.post('/callbacks/:id/assign', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const sb = getServiceClient(ctx.config);
  await sb.from('callback_requests').update({
    status: 'assigned', assigned_agent_id: ctx.userId, updated_at: new Date().toISOString(),
  }).eq('id', req.params.id).eq('workspace_id', wid);
  res.json({ ok: true });
});

callCenterRouter.post('/callbacks/:id/complete', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const sb = getServiceClient(ctx.config);
  await sb.from('callback_requests').update({
    status: 'called', updated_at: new Date().toISOString(),
  }).eq('id', req.params.id).eq('workspace_id', wid);
  res.json({ ok: true });
});

callCenterRouter.post('/callbacks/:id/cancel', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const sb = getServiceClient(ctx.config);
  await sb.from('callback_requests').update({
    status: 'cancelled', updated_at: new Date().toISOString(),
  }).eq('id', req.params.id).eq('workspace_id', wid);
  res.json({ ok: true });
});

// ── Super Admin: Platform Call Center settings ────────────────────────────
callCenterRouter.get('/admin/platform', async (req, res) => {
  const ctx = await requireGlobalAdmin(req, res);
  if (!ctx) return;
  const settings = await getPlatformCallCenterSettings(ctx.config);
  // Provider readiness summary + workspace counts
  const sb = getServiceClient(ctx.config);
  const [{ count: enabledWorkspaces }, { count: activeCalls }, { count: waitingCalls }] = await Promise.all([
    sb.from('call_center_settings').select('id', { count: 'exact', head: true }).eq('enabled', true),
    sb.from('call_sessions').select('id', { count: 'exact', head: true }).eq('entry_source', 'call_widget').in('state', ['active', 'ringing', 'connecting']),
    sb.from('call_queue_entries').select('id', { count: 'exact', head: true }).eq('entry_source', 'call_widget').in('state', ['queued', 'offered']),
  ]);
  res.json({
    settings,
    stats: {
      enabled_workspaces: enabledWorkspaces || 0,
      active_calls: activeCalls || 0,
      waiting_calls: waitingCalls || 0,
    },
  });
});

const platformPatchSchema = z.object({
  call_center_enabled: z.boolean().optional(),
  voice_calls_enabled: z.boolean().optional(),
  video_calls_enabled: z.boolean().optional(),
  callback_requests_enabled: z.boolean().optional(),
  call_recording_enabled: z.boolean().optional(),
  screen_share_enabled: z.boolean().optional(),
  call_transfer_enabled: z.boolean().optional(),
  departments_enabled: z.boolean().optional(),
  advanced_routing_enabled: z.boolean().optional(),
  max_concurrent_calls_per_workspace: z.number().int().min(0).optional(),
  max_queue_size_per_workspace: z.number().int().min(0).optional(),
  max_monthly_call_minutes_per_workspace: z.number().int().min(0).optional(),
  max_callback_requests_per_month: z.number().int().min(0).optional(),
  max_recording_storage_mb: z.number().int().min(0).optional(),
  disabled_message: z.record(z.unknown()).optional(),
});

callCenterRouter.put('/admin/platform', async (req, res) => {
  const ctx = await requireGlobalAdmin(req, res);
  if (!ctx) return;
  const parsed = platformPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  const updated = await updatePlatformCallCenterSettings(ctx.config, parsed.data as any);
  // Audit-on-save (best-effort, no new audit system)
  try {
    const sb = getServiceClient(ctx.config);
    await sb.from('audit_logs').insert({
      user_id: ctx.userId,
      action: 'platform_call_center.update',
      entity_type: 'platform_call_center_settings',
      entity_id: (updated as any).id ?? null,
      new_value: parsed.data,
    } as any);
  } catch {/* audit_logs may not exist; ignore */}
  res.json({ settings: updated });
});

callCenterRouter.get('/admin/workspaces', async (req, res) => {
  const ctx = await requireGlobalAdmin(req, res);
  if (!ctx) return;
  const sb = getServiceClient(ctx.config);
  const { data } = await sb.from('call_center_settings')
    .select('workspace_id, enabled, voice_enabled, video_enabled, callback_enabled, public_key, updated_at, workspaces:workspace_id(name, slug)')
    .order('updated_at', { ascending: false });
  res.json({ workspaces: data || [] });
});

callCenterRouter.post('/admin/cache/invalidate', async (req, res) => {
  const ctx = await requireGlobalAdmin(req, res);
  if (!ctx) return;
  invalidatePlatformCallCenterCache();
  res.json({ ok: true });
});