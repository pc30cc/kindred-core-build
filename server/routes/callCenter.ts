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
import { buildClientConnectInfo } from '../services/callCenter/connectInfo.js';
import { computeRecordingCapability, disabledRecordingCapability } from '../services/callCenter/recording.js';
import {
  startCallCenterRecording,
  stopCallCenterRecording,
  getCallCenterRecordingStatus,
  RecordingControlException,
} from '../services/callCenter/recordingControl.js';
import { uploadFile, deleteFile, resolveStorageConfig } from '../services/storage/index.js';
import {
  listDepartments, getDepartment, createDepartment, updateDepartment, deleteDepartment,
  listDepartmentAgents, addDepartmentAgent, updateDepartmentAgent, removeDepartmentAgent,
  getAgentPresence, updateMyAgentPresence,
  incrementAgentActiveCallCount, decrementAgentActiveCallCount,
  DepartmentException,
} from '../services/callCenter/departments.js';
import {
  assignCallToAgent, transferCall, RoutingException,
} from '../services/callCenter/routing.js';
import crypto from 'crypto';

export const callCenterRouter = Router();

function handleDeptErr(e: any, res: any, fallbackCode: string): boolean {
  if (e instanceof DepartmentException) {
    if (e.code === 'management_moved') {
      res.status(410).json({
        error: 'department_management_moved',
        manage_url: '/settings/team-departments',
      });
    } else {
      res.status(e.httpStatus).json({ error: e.code });
    }
    return true;
  }
  return false;
}

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

// Roles allowed to operate calls (accept/reject/end/availability).
// Viewer/analyst/billing/seo/marketing are explicitly denied.
const OPERATOR_ROLES = new Set([
  'owner', 'admin', 'agent', 'support_agent', 'team_lead',
]);

// Roles allowed to take over / force-end a call already assigned to another
// operator. Keep this strictly conservative.
const ELEVATED_CALL_ROLES = new Set(['owner', 'admin', 'team_lead']);

async function getWorkspaceRole(
  config: ServerConfig, workspaceId: string, userId: string,
): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb.rpc('get_workspace_role', {
    _workspace_id: workspaceId, _user_id: userId,
  });
  return data ? String(data) : null;
}

/**
 * Decide whether the current user can perform a call action on a standalone
 * call. Returns the resolved role and whether this is an elevated takeover.
 * Throws an HTTP-shaped error code that callers translate into a response.
 */
type CallAction = 'accept' | 'reject' | 'end';
interface OwnershipDecision {
  role: string | null;
  isElevated: boolean;
  isAssignedToMe: boolean;
  isTakeover: boolean;
}
async function canOperateCall(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
  call: any,
  action: CallAction,
  queueRow?: { offered_to_user_id?: string | null } | null,
): Promise<OwnershipDecision> {
  const role = await getWorkspaceRole(config, workspaceId, userId);
  const isElevated = !!role && ELEVATED_CALL_ROLES.has(role);
  const assigned = (call?.assigned_agent_id as string | null) || null;
  const isAssignedToMe = !!assigned && assigned === userId;

  if (assigned && assigned !== userId) {
    if (!isElevated) {
      const err: any = new Error('call_assigned_to_another_operator');
      err.httpStatus = 403;
      throw err;
    }
    return { role, isElevated, isAssignedToMe: false, isTakeover: true };
  }

  if (!assigned) {
    if (action === 'accept') {
      // Any operator may accept an unassigned call.
      return { role, isElevated, isAssignedToMe: false, isTakeover: false };
    }
    // reject/end on an unassigned call: elevated, OR the user is the one
    // currently being offered the call in the queue.
    const offeredToMe = !!queueRow && queueRow.offered_to_user_id === userId;
    if (!isElevated && !offeredToMe) {
      const err: any = new Error('operator_permission_required');
      err.httpStatus = 403;
      throw err;
    }
  }
  return { role, isElevated, isAssignedToMe, isTakeover: false };
}

function sendOwnershipError(res: any, e: any): boolean {
  if (e && typeof e.httpStatus === 'number' && typeof e.message === 'string') {
    res.status(e.httpStatus).json({ error: e.message });
    return true;
  }
  return false;
}

async function requireCallOperator(req: any, res: any, workspaceId: string) {
  const ctx = await requireMember(req, res, workspaceId);
  if (!ctx) return null;
  // Global admin bypass
  if (await isGlobalAdmin(ctx.config, ctx.userId)) return ctx;
  const sb = getServiceClient(ctx.config);
  const { data: role } = await sb.rpc('get_workspace_role', {
    _workspace_id: workspaceId, _user_id: ctx.userId,
  });
  if (!OPERATOR_ROLES.has(String(role))) {
    res.status(403).json({ error: 'operator_permission_required' });
    return null;
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
// Lightweight capabilities endpoint — does NOT create a settings row.
// Used by sidebar to decide whether to show the Call Center entry.
callCenterRouter.get('/capabilities', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const sb = getServiceClient(ctx.config);
  const platform = await getPlatformCallCenterSettings(ctx.config);
  const { data: row } = await sb
    .from('call_center_settings')
    .select('*')
    .eq('workspace_id', wid)
    .maybeSingle();
  const wsEnabled = !!row?.enabled;
  const effective = row
    ? computeEffectiveCallCenterCaps(platform, row as any)
    : {
        call_center_enabled: false,
        workspace_call_center_visible: platform.call_center_enabled,
        voice_enabled: false,
        video_enabled: false,
        callback_enabled: false,
        recording_enabled: false,
        max_concurrent_calls: platform.max_concurrent_calls_per_workspace,
        max_monthly_call_minutes: platform.max_monthly_call_minutes_per_workspace,
        max_queue_size: platform.max_queue_size_per_workspace,
      };
  res.json({
    platform_enabled: platform.call_center_enabled,
    workspace_enabled: wsEnabled,
    workspace_call_center_visible: effective.workspace_call_center_visible,
    settings_exists: !!row,
    effective,
    recording: row
      ? await computeRecordingCapability(ctx.config, wid, platform, row as any)
      : disabledRecordingCapability(),
  });
});

callCenterRouter.get('/settings', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const settingsRaw = await getOrCreateWorkspaceSettings(ctx.config, wid);
  const platform = await getPlatformCallCenterSettings(ctx.config);
  const effective = computeEffectiveCallCenterCaps(platform, settingsRaw);
  const recording = await computeRecordingCapability(ctx.config, wid, platform, settingsRaw);
  // Sanitize: never expose avatar_storage_path to clients
  const { avatar_storage_path: _, ...settings } = settingsRaw;
  res.json({ settings, platform, effective, recording });
});

const settingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  allowed_domains: z.array(z.string()).optional(),
  widget_position: z.string().optional(),
  widget_theme: z.record(z.unknown()).optional(),
  display_name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  // avatar_storage_path is intentionally NOT settable from clients.
  // It is only written by the avatar upload route to prevent path injection.
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
  const settingsRaw = await updateWorkspaceSettings(ctx.config, wid, parsed.data as any);
  // Sanitize: never expose avatar_storage_path to clients
  const { avatar_storage_path: _, ...settings } = settingsRaw;
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
  // Verify a storage provider is actually configured. uploadFile would
  // otherwise silently fall back to local + fail with publicUrl errors.
  const storageConfig = await resolveStorageConfig(ctx.config, wid);
  if (!storageConfig) return res.status(500).json({ error: 'storage_not_configured' });
  // Read previous avatar path (so we can best-effort delete the old file
  // through the same active storage provider after a successful upload).
  const sb0 = getServiceClient(ctx.config);
  const { data: prevRow } = await sb0
    .from('call_center_settings')
    .select('avatar_storage_path')
    .eq('workspace_id', wid)
    .maybeSingle();
  const previousPath = (prevRow as any)?.avatar_storage_path as string | null;
  const safe = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const fileKey = `workspace/${wid}/call-center/avatar/${crypto.randomUUID()}-${safe}`;
  const result = await uploadFile(ctx.config, {
    workspaceId: wid, fileKey, data: buffer, contentType: String(contentType),
  });
  if (!result.success || !result.url) {
    return res.status(500).json({ error: 'avatar_upload_failed' });
  }
  const updated = await updateWorkspaceSettings(ctx.config, wid, {
    avatar_url: result.url, avatar_storage_path: fileKey,
  } as any);
  // Best-effort cleanup of the previous avatar; failures must not fail the
  // upload and must not be exposed to the client.
  if (previousPath && previousPath !== fileKey) {
    try { await deleteFile(ctx.config, wid, previousPath); } catch { /* best-effort */ }
  }
  res.json({ avatar_url: updated.avatar_url });
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
      .eq('workspace_id', wid).in('status', ['requested', 'scheduled']),
    resolveEffectiveCallProvider(ctx.config, wid).then(p => ({ provider: p.id, ready: true })).catch(e => ({ provider: 'none', ready: false, error: String(e?.message || e) })),
  ]);
  const platform = await getPlatformCallCenterSettings(ctx.config);
  const wsRow = await getOrCreateWorkspaceSettings(ctx.config, wid);
  const recording = await computeRecordingCapability(ctx.config, wid, platform, wsRow);
  res.json({
    today_calls: todayCalls.count || 0,
    waiting_calls: waitingQ.count || 0,
    active_calls: activeCalls.count || 0,
    missed_today: missedToday.count || 0,
    callbacks_pending: callbacks.count || 0,
    provider: providerInfo,
    recording,
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
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  try {
    const sb = getServiceClient(ctx.config);
    const { data: call } = await sb.from('call_sessions').select('*')
      .eq('id', req.params.id).eq('workspace_id', wid)
      .eq('entry_source', 'call_widget').maybeSingle();
    if (!call) return res.status(404).json({ error: 'not_found' });
    const prevState = String((call as any).state || '');
    if (['ended', 'cancelled', 'failed', 'missed'].includes(prevState)) {
      return res.status(409).json({ error: 'call_not_active' });
    }
    const { data: queueRow } = await sb.from('call_queue_entries')
      .select('id, offered_to_user_id, accepted_at')
      .eq('call_session_id', req.params.id).eq('workspace_id', wid).maybeSingle();
    let decision: OwnershipDecision;
    try {
      decision = await canOperateCall(ctx.config, wid, ctx.userId, call, 'accept', queueRow as any);
    } catch (e: any) {
      if (sendOwnershipError(res, e)) return;
      throw e;
    }
    const previousAssigned = ((call as any).assigned_agent_id as string | null) || null;
    const wasAlreadyActiveForMe =
      previousAssigned === ctx.userId &&
      ['active', 'ringing', 'connecting'].includes(prevState);

    // Resolve provider and create room if needed
    const { id: providerId, provider } = await resolveEffectiveCallProvider(ctx.config, wid);
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
    // Build accept patch — keep connected_at if already set (idempotent).
    const acceptPatch: Record<string, unknown> = {
      state: 'active',
      provider: providerId,
      provider_room_id: providerRoomId,
      assigned_agent_id: ctx.userId,
    };
    if (!(call as any).connected_at) {
      acceptPatch.connected_at = new Date().toISOString();
    }
    await transitionCall(ctx.config, wid, req.params.id, acceptPatch, 'call_accepted', ctx.userId);

    // Keep queue + session assignment consistent.
    const queuePatch: Record<string, unknown> = {
      state: 'accepted',
      offered_to_user_id: ctx.userId,
      assigned_agent_id: ctx.userId,
    };
    if (queueRow && !(queueRow as any).accepted_at) {
      queuePatch.accepted_at = new Date().toISOString();
    }
    await sb.from('call_queue_entries').update(queuePatch)
      .eq('call_session_id', req.params.id).eq('workspace_id', wid);

    // Ownership change events.
    if (decision.isTakeover && previousAssigned && previousAssigned !== ctx.userId) {
      await sb.from('call_events').insert({
        call_session_id: req.params.id,
        event_type: 'call_takeover',
        actor_type: 'operator',
        actor_id: ctx.userId,
        payload: {
          previous_agent_id: previousAssigned,
          new_agent_id: ctx.userId,
          reason: 'operator_takeover_accept',
        },
      });
      // TODO: do not decrement previous agent's active_call_count here —
      // we cannot reliably detect whether their session was actually active.
      // A later pass with LiveKit participant-kick will handle handoff.
    } else if (!previousAssigned) {
      await sb.from('call_events').insert({
        call_session_id: req.params.id,
        event_type: 'call_assigned_on_accept',
        actor_type: 'operator',
        actor_id: ctx.userId,
        payload: { agent_id: ctx.userId },
      });
    }

    // Maintain presence counter for least_busy/max_concurrent_calls — only
    // when this accept actually moves the call into ownership for this user.
    if (!wasAlreadyActiveForMe) {
      try { await incrementAgentActiveCallCount(ctx.config, wid, ctx.userId); }
      catch {/* best-effort */}
    }
    const identity = `operator:${ctx.userId}`;
    const connect = await buildClientConnectInfo(ctx.config, providerId, providerRoomId, identity);
    res.json({
      ok: true,
      provider: providerId,
      provider_room_id: providerRoomId,
      token: tok.token,
      expires_at: tok.expiresAt,
      connect,
      idempotent: wasAlreadyActiveForMe,
      takeover: decision.isTakeover,
    });
  } catch (e: any) {
    if (sendOwnershipError(res, e)) return;
    res.status(500).json({ error: 'accept_failed', message: String(e?.message || e) });
  }
});

callCenterRouter.post('/calls/:id/reject', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  try {
    const sb = getServiceClient(ctx.config);
    const { data: existing } = await sb.from('call_sessions')
      .select('id, entry_source, assigned_agent_id, state')
      .eq('id', req.params.id).eq('workspace_id', wid)
      .eq('entry_source', 'call_widget').maybeSingle();
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const prevState = String((existing as any).state || '');
    if (['ended', 'cancelled', 'failed'].includes(prevState)) {
      return res.status(409).json({ error: 'call_not_active' });
    }
    const { data: qRow } = await sb.from('call_queue_entries')
      .select('id, offered_to_user_id')
      .eq('call_session_id', req.params.id).eq('workspace_id', wid).maybeSingle();
    try {
      await canOperateCall(ctx.config, wid, ctx.userId, existing, 'reject', qRow as any);
    } catch (e: any) {
      if (sendOwnershipError(res, e)) return;
      throw e;
    }
    await transitionCall(ctx.config, wid, req.params.id, {
      state: 'cancelled',
      ended_at: new Date().toISOString(),
      end_reason: 'operator_ended',
      ended_by: 'operator',
      ended_by_user_id: ctx.userId,
    }, 'call_rejected', ctx.userId);
    // Annotate detailed reason in metadata (constraint allows 4 canonical values only).
    try {
      const { data: prev } = await sb.from('call_sessions').select('metadata').eq('id', req.params.id).maybeSingle();
      const meta = (prev?.metadata as any) || {};
      await sb.from('call_sessions').update({
        metadata: { ...meta, call_center_reason: 'operator_rejected' },
      }).eq('id', req.params.id);
    } catch {/* best-effort */}
    await sb.from('call_queue_entries').update({
      state: 'cancelled', ended_at: new Date().toISOString(), ended_reason: 'rejected',
    }).eq('call_session_id', req.params.id).eq('workspace_id', wid);
    // Reject only decrements active_call_count if this operator had actually
    // accepted the call previously (call was in active/connecting/ringing
    // and assigned to them). Pre-accept reject does NOT touch the counter.
    const assigned = ((existing as any).assigned_agent_id as string | null) || null;
    if (assigned === ctx.userId && ['active', 'connecting', 'ringing'].includes(prevState)) {
      try { await decrementAgentActiveCallCount(ctx.config, wid, ctx.userId); }
      catch {/* best-effort */}
    }
    res.json({ ok: true });
  } catch (e: any) {
    if (sendOwnershipError(res, e)) return;
    res.status(500).json({ error: 'reject_failed', message: String(e?.message || e) });
  }
});

callCenterRouter.post('/calls/:id/end', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  try {
    const sb = getServiceClient(ctx.config);
    const { data: call } = await sb.from('call_sessions').select('*')
      .eq('id', req.params.id).eq('workspace_id', wid)
      .eq('entry_source', 'call_widget').maybeSingle();
    if (!call) return res.status(404).json({ error: 'not_found' });
    const prevState = String((call as any).state || '');
    if (['ended', 'cancelled', 'failed'].includes(prevState)) {
      return res.status(409).json({ error: 'call_not_active' });
    }
    const { data: qRow } = await sb.from('call_queue_entries')
      .select('id, offered_to_user_id')
      .eq('call_session_id', req.params.id).eq('workspace_id', wid).maybeSingle();
    try {
      await canOperateCall(ctx.config, wid, ctx.userId, call, 'end', qRow as any);
    } catch (e: any) {
      if (sendOwnershipError(res, e)) return;
      throw e;
    }
    const startedAt = (call as any).connected_at || (call as any).started_at || (call as any).created_at;
    const duration = startedAt ? Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)) : 0;
    if ((call as any).provider && (call as any).provider_room_id) {
      try {
        const { provider } = await resolveEffectiveCallProvider(ctx.config, wid);
        await provider.closeRoom(ctx.config, (call as any).provider_room_id);
      } catch {/* best effort */}
    }
    await transitionCall(ctx.config, wid, req.params.id, {
      state: 'ended',
      ended_at: new Date().toISOString(),
      duration_seconds: duration,
      end_reason: 'operator_ended',
      ended_by: 'operator',
      ended_by_user_id: ctx.userId,
    }, 'call_ended', ctx.userId);
    // Decrement presence counter only for an operator who actually owned an
    // active call. Floor-at-zero is enforced inside the helper.
    const assigned = ((call as any).assigned_agent_id as string | null) || null;
    const wasActive = ['active', 'connecting', 'ringing'].includes(prevState);
    let owner: string | null = null;
    if (assigned && wasActive) owner = assigned;
    else if (!assigned && wasActive) owner = ctx.userId;
    if (owner) {
      try { await decrementAgentActiveCallCount(ctx.config, wid, owner); }
      catch {/* best-effort */}
    }
    res.json({ ok: true });
  } catch (e: any) {
    if (sendOwnershipError(res, e)) return;
    res.status(500).json({ error: 'end_failed', message: String(e?.message || e) });
  }
});

// ── Recording start/stop/status (CC-2F) ────────────────────────────────────
const recordingTypeSchema = z.enum(['composite', 'individual', 'audio_only']).optional();

callCenterRouter.post('/calls/:id/recording/start', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  const recType = recordingTypeSchema.safeParse(req.body?.recording_type);
  if (!recType.success) return res.status(400).json({ error: 'invalid_recording_type' });
  try {
    const r = await startCallCenterRecording(ctx.config, {
      workspaceId: wid,
      callId: req.params.id,
      actorUserId: ctx.userId,
      recordingType: recType.data,
    });
    res.json(r);
  } catch (e: any) {
    if (e instanceof RecordingControlException) {
      return res.status(e.httpStatus).json({ error: e.code });
    }
    res.status(500).json({ error: 'recording_start_failed', message: String(e?.message || e) });
  }
});

callCenterRouter.post('/calls/:id/recording/stop', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  try {
    const r = await stopCallCenterRecording(ctx.config, {
      workspaceId: wid,
      callId: req.params.id,
      actorUserId: ctx.userId,
    });
    res.json(r);
  } catch (e: any) {
    if (e instanceof RecordingControlException) {
      return res.status(e.httpStatus).json({ error: e.code });
    }
    res.status(500).json({ error: 'recording_stop_failed', message: String(e?.message || e) });
  }
});

callCenterRouter.get('/calls/:id/recording/status', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  try {
    const s = await getCallCenterRecordingStatus(ctx.config, {
      workspaceId: wid,
      callId: req.params.id,
    });
    res.json(s);
  } catch (e: any) {
    if (e instanceof RecordingControlException) {
      return res.status(e.httpStatus).json({ error: e.code });
    }
    res.status(500).json({ error: 'recording_status_failed', message: String(e?.message || e) });
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
  const ctx = await requireCallOperator(req, res, wid);
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
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  const sb = getServiceClient(ctx.config);
  await sb.from('callback_requests').update({
    status: 'in_progress', handled_by: ctx.userId, updated_at: new Date().toISOString(),
  }).eq('id', req.params.id).eq('workspace_id', wid);
  res.json({ ok: true });
});

callCenterRouter.post('/callbacks/:id/complete', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  const sb = getServiceClient(ctx.config);
  const now = new Date().toISOString();
  await sb.from('callback_requests').update({
    status: 'completed', completed_at: now, handled_by: ctx.userId, updated_at: now,
  }).eq('id', req.params.id).eq('workspace_id', wid);
  res.json({ ok: true });
});

callCenterRouter.post('/callbacks/:id/cancel', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  const sb = getServiceClient(ctx.config);
  const now = new Date().toISOString();
  await sb.from('callback_requests').update({
    status: 'cancelled', cancelled_at: now, updated_at: now,
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
// ── Departments (CC-2G) ────────────────────────────────────────────────────
const departmentInputSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().max(60).optional(),
  description: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  routing_mode: z.enum(['broadcast', 'round_robin', 'least_busy']).optional(),
  fallback_department_id: z.string().uuid().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const departmentPatchSchema = departmentInputSchema.partial();

callCenterRouter.get('/departments', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  try {
    const departments = await listDepartments(ctx.config, wid);
    res.json({ departments });
  } catch (e: any) {
    res.status(500).json({ error: 'list_failed', message: String(e?.message || e) });
  }
});

callCenterRouter.post('/departments', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireWorkspaceAdmin(req, res, wid);
  if (!ctx) return;
  const parsed = departmentInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  try {
    const department = await createDepartment(ctx.config, wid, parsed.data as any);
    res.status(201).json({ department });
  } catch (e: any) {
    if (handleDeptErr(e, res, 'create_failed')) return;
    res.status(500).json({ error: 'create_failed', message: String(e?.message || e) });
  }
});

callCenterRouter.get('/departments/:id', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const department = await getDepartment(ctx.config, wid, req.params.id);
  if (!department) return res.status(404).json({ error: 'department_not_found' });
  res.json({ department });
});

callCenterRouter.patch('/departments/:id', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireWorkspaceAdmin(req, res, wid);
  if (!ctx) return;
  const parsed = departmentPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  try {
    const department = await updateDepartment(ctx.config, wid, req.params.id, parsed.data);
    if (!department) return res.status(404).json({ error: 'department_not_found' });
    res.json({ department });
  } catch (e: any) {
    if (handleDeptErr(e, res, 'update_failed')) return;
    res.status(500).json({ error: 'update_failed', message: String(e?.message || e) });
  }
});

callCenterRouter.delete('/departments/:id', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireWorkspaceAdmin(req, res, wid);
  if (!ctx) return;
  try {
    await deleteDepartment(ctx.config, wid, req.params.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: 'delete_failed', message: String(e?.message || e) });
  }
});

// ── Department agents ─────────────────────────────────────────────────────
const departmentAgentInputSchema = z.object({
  user_id: z.string().uuid(),
  role: z.enum(['agent', 'supervisor']).optional(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
  max_concurrent_calls: z.number().int().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const departmentAgentPatchSchema = departmentAgentInputSchema.partial().omit({ user_id: true });

callCenterRouter.get('/departments/:id/agents', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  try {
    const agents = await listDepartmentAgents(ctx.config, wid, req.params.id);
    res.json({ agents });
  } catch (e: any) {
    if (handleDeptErr(e, res, 'list_failed')) return;
    res.status(500).json({ error: 'list_failed', message: String(e?.message || e) });
  }
});

callCenterRouter.post('/departments/:id/agents', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireWorkspaceAdmin(req, res, wid);
  if (!ctx) return;
  const parsed = departmentAgentInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  try {
    const agent = await addDepartmentAgent(
      ctx.config, wid, req.params.id, parsed.data.user_id, parsed.data,
    );
    res.status(201).json({ agent });
  } catch (e: any) {
    if (handleDeptErr(e, res, 'add_failed')) return;
    res.status(500).json({ error: 'add_failed', message: String(e?.message || e) });
  }
});

callCenterRouter.patch('/departments/:id/agents/:userId', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireWorkspaceAdmin(req, res, wid);
  if (!ctx) return;
  const parsed = departmentAgentPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  try {
    const agent = await updateDepartmentAgent(
      ctx.config, wid, req.params.id, req.params.userId, parsed.data,
    );
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });
    res.json({ agent });
  } catch (e: any) {
    if (handleDeptErr(e, res, 'update_failed')) return;
    res.status(500).json({ error: 'update_failed', message: String(e?.message || e) });
  }
});

callCenterRouter.delete('/departments/:id/agents/:userId', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireWorkspaceAdmin(req, res, wid);
  if (!ctx) return;
  try {
    await removeDepartmentAgent(ctx.config, wid, req.params.id, req.params.userId);
    res.json({ ok: true });
  } catch (e: any) {
    if (handleDeptErr(e, res, 'remove_failed')) return;
    res.status(500).json({ error: 'remove_failed', message: String(e?.message || e) });
  }
});

// ── Agent presence ────────────────────────────────────────────────────────
const presenceInputSchema = z.object({
  status: z.enum(['available', 'busy', 'away', 'offline']),
  status_message: z.string().nullable().optional(),
});

callCenterRouter.get('/agents/presence', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  try {
    const presence = await getAgentPresence(ctx.config, wid);
    res.json({ presence });
  } catch (e: any) {
    res.status(500).json({ error: 'list_failed', message: String(e?.message || e) });
  }
});

callCenterRouter.put('/agents/me/presence', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  const parsed = presenceInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  try {
    const presence = await updateMyAgentPresence(
      ctx.config, wid, ctx.userId, parsed.data.status, parsed.data.status_message,
    );
    res.json({ presence });
  } catch (e: any) {
    res.status(500).json({ error: 'update_failed', message: String(e?.message || e) });
  }
});

// ── Assignment + transfer ─────────────────────────────────────────────────
const assignSchema = z.object({
  agent_id: z.string().uuid().nullable(),
  reason: z.string().max(200).optional(),
});

callCenterRouter.post('/calls/:id/assign', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  try {
    const r = await assignCallToAgent(ctx.config, {
      workspaceId: wid,
      callSessionId: req.params.id,
      agentId: parsed.data.agent_id,
      reason: parsed.data.reason,
      actorId: ctx.userId,
    });
    res.json(r);
  } catch (e: any) {
    if (e instanceof RoutingException) return res.status(e.httpStatus).json({ error: e.code });
    res.status(500).json({ error: 'assign_failed', message: String(e?.message || e) });
  }
});

const transferSchema = z.object({
  to_agent_id: z.string().uuid().nullable().optional(),
  to_department_id: z.string().uuid().nullable().optional(),
  reason: z.string().max(200).nullable().optional(),
});

callCenterRouter.post('/calls/:id/transfer', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  if (!parsed.data.to_agent_id && !parsed.data.to_department_id) {
    return res.status(400).json({ error: 'transfer_target_required' });
  }
  try {
    const r = await transferCall(ctx.config, {
      workspaceId: wid,
      callSessionId: req.params.id,
      fromAgentId: ctx.userId,
      toAgentId: parsed.data.to_agent_id,
      toDepartmentId: parsed.data.to_department_id,
      reason: parsed.data.reason ?? null,
      actorId: ctx.userId,
    });
    res.json(r);
  } catch (e: any) {
    if (e instanceof RoutingException) return res.status(e.httpStatus).json({ error: e.code });
    res.status(500).json({ error: 'transfer_failed', message: String(e?.message || e) });
  }
});
