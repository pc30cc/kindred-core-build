/**
 * Call Center — operator/admin HTTP routes (workspace-scoped).
 * Mounted at /api/call-center/*.
 * Uses existing call_sessions / call_queue_entries / callback_requests tables.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
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
import type { WorkspaceCallCenterSettings, PlatformCallCenterSettings } from '../services/callCenter/settings.js';
import { isGlobalAdmin } from '../middleware/adminBypass.js';
import { resolveEffectiveCallProvider } from '../services/calls/providerResolver.js';
import { publishQueueEvent, publishCallEvent } from '../services/callCenter/realtime.js';
import { buildClientConnectInfo } from '../services/callCenter/connectInfo.js';
import {
  loadLiveKitConfig,
  getLiveKitClientWsUrl,
} from '../services/calls/livekitConfig.js';
import { normalizeClientWsUrl } from '../services/calls/rtcResolver.js';
import { computeRecordingCapability, disabledRecordingCapability } from '../services/callCenter/recording.js';
import {
  startCallCenterRecording,
  stopCallCenterRecording,
  getCallCenterRecordingStatus,
  RecordingControlException,
} from '../services/callCenter/recordingControl.js';
import { mintPlaybackToken } from '../services/calls/recordingPlaybackToken.js';
import { loadEffectiveCallEntitlements } from '../services/calls/entitlementComposer.js';
import { uploadFile, deleteFile, resolveStorageConfig, resolveGlobalStorageConfig, uploadWithConfig, deleteWithConfig, getFileUrlWithConfig, downloadWithConfig } from '../services/storage/index.js';
import { callCenterAvatarKey, platformCallCenterRingbackKey } from '../services/storage/keys.js';
import { createStorageUrlResolver } from '../services/storage/urlResolver.js';
import { resolveRecordingStorageConfig, RecordingStorageNotConfigured } from '../services/calls/recordingStorageResolver.js';
import { buildStoreZip, safeArchiveName } from '../services/calls/zipStore.js';
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
import { authorizeWorkspaceAccess, requirePlatformAdmin } from '../lib/workspaceAuth.js';
import { validateSessionToken, SESSION_COOKIE_NAME } from '../services/auth/sessions.js';
import { readSessionToken } from '../lib/sessionTransport.js';
import {
  callWidgetFormSchema,
  callWidgetOfflineBehaviorSchema,
  callWidgetThemeSchema,
  normalizeCallWidgetFormSchema,
  normalizeCallWidgetOfflineBehavior,
  normalizeCallWidgetTheme,
  resolveCallWidgetTemplateId,
} from '../services/callCenter/presentation.js';

export const callCenterRouter = Router();

type ReqWithConfig = Request & { serverConfig: ServerConfig };

// ── Shared row shapes (narrow — only the fields this file reads/writes) ────
interface CallRatingRow {
  call_session_id: string;
  rating: number;
  comment: string | null;
  created_at: string;
}
interface CallSessionRow {
  id?: string;
  state?: string | null;
  assigned_agent_id?: string | null;
  provider?: string | null;
  provider_room_id?: string | null;
  call_type?: string | null;
  connected_at?: string | null;
  started_at?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
}
interface QueueEntryRow {
  id?: string;
  offered_to_user_id?: string | null;
  accepted_at?: string | null;
}
interface RecordingWithSessionRow {
  id: string;
  call_session_id: string;
  storage_path: string | null;
  recording_type?: string | null;
  created_at?: string | null;
  call_sessions?: { workspace_id: string } | null;
}
interface CallRecordingListRow {
  id: string;
  recording_type: string | null;
  duration_seconds: number | null;
  size_bytes: number | null;
  storage_path: string | null;
  created_at: string | null;
}
interface WorkspaceRecordingListRow {
  id: string;
  call_session_id: string;
  recording_type: string | null;
  duration_seconds: number | null;
  size_bytes: number | null;
  storage_path: string | null;
  created_at: string | null;
  call_sessions: {
    visitor_name: string | null;
    visitor_email: string | null;
    call_type: string | null;
    created_at: string | null;
    ended_at: string | null;
    duration_seconds: number | null;
  } | null;
}

function handleDeptErr(e: unknown, res: Response, fallbackCode: string): boolean {
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
// Identity comes from the first-party gs_session cookie (server/lib/
// workspaceAuth.ts) — a local, indexed database lookup, not an external
// auth provider call. The retry/"unreachable" classification this file
// used to need for Supabase Auth network failures no longer applies, so
// it's been dropped rather than ported.
interface AuthLookup {
  user: { id: string } | null;
}
async function lookupUser(req: Request, config: ServerConfig): Promise<AuthLookup> {
  const token = readSessionToken(req).token;
  const session = await validateSessionToken(config, token);
  return { user: session ? { id: session.userId } : null };
}

async function getUser(req: Request, config: ServerConfig) {
  const r = await lookupUser(req, config);
  return r.user;
}

async function requireMember(req: Request, res: Response, workspaceId: string) {
  const config = (req as ReqWithConfig).serverConfig;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return null;
  return { userId: auth.userId, config };
}

async function requireWorkspaceAdmin(req: Request, res: Response, workspaceId: string) {
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
interface HttpStatusError extends Error {
  httpStatus: number;
}
function isHttpStatusError(e: unknown): e is HttpStatusError {
  return e instanceof Error && typeof (e as { httpStatus?: unknown }).httpStatus === 'number';
}
function makeHttpStatusError(message: string, httpStatus: number): HttpStatusError {
  const err = new Error(message) as HttpStatusError;
  err.httpStatus = httpStatus;
  return err;
}

async function canOperateCall(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
  call: { assigned_agent_id?: string | null } | null | undefined,
  action: CallAction,
  queueRow?: { offered_to_user_id?: string | null } | null,
): Promise<OwnershipDecision> {
  const role = await getWorkspaceRole(config, workspaceId, userId);
  const isElevated = !!role && ELEVATED_CALL_ROLES.has(role);
  const assigned = (call?.assigned_agent_id as string | null) || null;
  const isAssignedToMe = !!assigned && assigned === userId;

  if (assigned && assigned !== userId) {
    if (!isElevated) {
      throw makeHttpStatusError('call_assigned_to_another_operator', 403);
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
      throw makeHttpStatusError('operator_permission_required', 403);
    }
  }
  return { role, isElevated, isAssignedToMe, isTakeover: false };
}

function sendOwnershipError(res: Response, e: unknown): boolean {
  if (isHttpStatusError(e)) {
    res.status(e.httpStatus).json({ error: e.message });
    return true;
  }
  return false;
}

async function requireCallOperator(req: Request, res: Response, workspaceId: string) {
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

async function requireGlobalAdmin(req: Request, res: Response) {
  const config = (req as ReqWithConfig).serverConfig;
  const userId = await requirePlatformAdmin(req, res);
  if (!userId) return null;
  return { userId, config };
}

/**
 * The call-centre widget avatar's public link, derived from its stored key.
 *
 * `avatar_storage_path` is the only supported record of the object: the
 * upload route writes it and clears `avatar_url`, and the settings PATCH
 * schema has no avatar field at all.
 *
 * @deprecated LEGACY READ FALLBACK — the `avatar_url` branch exists only so
 * rows written before this change keep rendering during rollout. Read-only:
 * nothing creates a new value for it. Remove it with the column.
 */
async function resolveCallCenterAvatarUrl(
  config: ServerConfig,
  workspaceId: string,
  row: { avatar_storage_path?: string | null; avatar_url?: string | null },
): Promise<string | null> {
  if (row?.avatar_storage_path) {
    return createStorageUrlResolver(config).workspace(workspaceId, row.avatar_storage_path);
  }
  return row?.avatar_url ?? null;
}

/**
 * Ringback audio is platform-owned (`platform/...`), so its links come from
 * the app-wide provider. Nothing here reads a stored URL: the paths are the
 * record, the URLs are derived for whichever provider is primary now.
 */
async function resolvePlatformRingbackUrls(
  config: ServerConfig,
  platform: {
    ringback_music_path?: string | null;
    ringback_announcement_audio_path?: string | null;
    ringback_queue_audio_paths?: Record<string, string> | null;
  },
): Promise<{ music_url: string | null; announcement_url: string | null; queue_urls: Record<string, string> }> {
  const resolver = createStorageUrlResolver(config);
  const queuePaths = (platform?.ringback_queue_audio_paths || {}) as Record<string, string>;
  const [music_url, announcement_url, queueEntries] = await Promise.all([
    resolver.platform(platform?.ringback_music_path ?? null),
    resolver.platform(platform?.ringback_announcement_audio_path ?? null),
    Promise.all(
      Object.entries(queuePaths).map(async ([pos, key]) => [pos, await resolver.platform(key)] as const),
    ),
  ]);
  const queue_urls: Record<string, string> = {};
  for (const [pos, url] of queueEntries) if (url) queue_urls[pos] = url;
  return { music_url, announcement_url, queue_urls };
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
  // Operators (non owner/admin) must not see the Call Center surfaces at all
  // when the workspace master switch is off. Owners/admins keep visibility so
  // they can still reach the settings and turn it back on.
  const viewerRole = await getWorkspaceRole(ctx.config, wid, ctx.userId);
  const viewerManages = ['owner', 'admin'].includes(String(viewerRole));
  const effective = row
    ? computeEffectiveCallCenterCaps(platform, row as WorkspaceCallCenterSettings)
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
    workspace_call_center_visible:
      effective.workspace_call_center_visible && (wsEnabled || viewerManages),
    platform_callback_enabled: platform.callback_requests_enabled,
    settings_exists: !!row,
    effective,
    recording: row
      ? await computeRecordingCapability(ctx.config, wid, platform, row as WorkspaceCallCenterSettings)
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
  // Sanitize: never expose avatar_storage_path to clients. `avatar_url` is
  // not read from the row — it is DERIVED from the key for whatever provider
  // is primary right now, so a promotion needs no row rewritten.
  const { avatar_storage_path: _, ...storedSettings } = settingsRaw;
  const settings = {
    ...storedSettings,
    avatar_url: await resolveCallCenterAvatarUrl(ctx.config, wid, settingsRaw),
    widget_template_id: resolveCallWidgetTemplateId(settingsRaw.widget_template_id),
    widget_theme: normalizeCallWidgetTheme(settingsRaw.widget_theme),
    pre_call_form_schema: normalizeCallWidgetFormSchema(settingsRaw.pre_call_form_schema),
    offline_behavior: normalizeCallWidgetOfflineBehavior(settingsRaw.offline_behavior),
  };
  res.json({ settings, platform, effective, recording });
});

const settingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  allowed_domains: z.array(z.string()).optional(),
  widget_position: z.string().optional(),
  widget_template_id: z.literal('default').optional(),
  widget_theme: callWidgetThemeSchema.optional(),
  display_name: z.string().nullable().optional(),
  // NO AVATAR FIELD. The call-centre avatar has exactly two mutations —
  // POST /settings/avatar and DELETE /settings/avatar — which store the
  // bytes in WebYar storage and record `avatar_storage_path`; the link is
  // derived from that key on every read. Neither `avatar_url` (a manually
  // typed link, which cannot follow a provider promotion and is not ours to
  // serve) nor `avatar_storage_path` (path injection) is settable here.
  voice_enabled: z.boolean().optional(),
  video_enabled: z.boolean().optional(),
  callback_enabled: z.boolean().optional(),
  pre_call_form_enabled: z.boolean().optional(),
  pre_call_form_schema: callWidgetFormSchema.optional(),
  business_hours: z.record(z.unknown()).optional(),
  offline_behavior: callWidgetOfflineBehaviorSchema.optional(),
  recording_enabled: z.boolean().optional(),
  recording_consent_required: z.boolean().optional(),
  operator_video_visible_to_visitor: z.boolean().optional(),
  routing_mode: z.string().optional(),
  default_department_id: z.string().uuid().nullable().optional(),
  widget_default_locale: z.enum(['en', 'fa', 'tr']).nullable().optional(),
  widget_enabled_locales: z.array(z.enum(['en', 'fa', 'tr'])).nullable().optional(),
  widget_custom_texts: z.record(z.record(z.string().max(200))).nullable().optional(),
}).strict();

callCenterRouter.put('/settings', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireWorkspaceAdmin(req, res, wid);
  if (!ctx) return;
  const parsed = settingsPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  const settingsRaw = await updateWorkspaceSettings(ctx.config, wid, parsed.data);
  // Sanitize: never expose avatar_storage_path to clients; derive the link.
  const { avatar_storage_path: _, ...rest } = settingsRaw;
  const settings = { ...rest, avatar_url: await resolveCallCenterAvatarUrl(ctx.config, wid, settingsRaw) };
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
  const previousPath = (prevRow?.avatar_storage_path as string | null | undefined) ?? null;
  const safe = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  // Workspace-first storage finalization: now routed through the central
  // callCenterAvatarKey() builder (server/services/storage/keys.ts) —
  // supabase/migrations/20260915091500_call_center_settings_avatar_scope.sql's
  // CHECK constraint already accepts this shape alongside the prior
  // ad-hoc one, specifically anticipating this fix.
  const fileKey = callCenterAvatarKey({ workspaceId: wid, fileName: safe });
  const result = await uploadFile(ctx.config, {
    workspaceId: wid, fileKey, data: buffer, contentType: String(contentType),
  });
  if (!result.success || !result.url) {
    return res.status(500).json({ error: 'avatar_upload_failed' });
  }
  // KEY ONLY: the stored URL is cleared, and the link handed back is
  // derived from the key through the one resolver every read path uses.
  await updateWorkspaceSettings(ctx.config, wid, {
    avatar_url: null, avatar_storage_path: fileKey,
  });
  // Best-effort cleanup of the previous avatar; failures must not fail the
  // upload and must not be exposed to the client.
  if (previousPath && previousPath !== fileKey) {
    try { await deleteFile(ctx.config, wid, previousPath); } catch { /* best-effort */ }
  }
  res.json({ avatar_url: await createStorageUrlResolver(ctx.config).workspace(wid, fileKey) });
});

// Remove the current avatar: clears both the public URL and the storage path,
// and best-effort deletes the stored file through the active provider.
callCenterRouter.delete('/settings/avatar', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireWorkspaceAdmin(req, res, wid);
  if (!ctx) return;
  const sb0 = getServiceClient(ctx.config);
  const { data: prevRow } = await sb0
    .from('call_center_settings')
    .select('avatar_storage_path')
    .eq('workspace_id', wid)
    .maybeSingle();
  const previousPath = (prevRow?.avatar_storage_path as string | null | undefined) ?? null;
  await updateWorkspaceSettings(ctx.config, wid, {
    avatar_url: null, avatar_storage_path: null,
  });
  if (previousPath) {
    try { await deleteFile(ctx.config, wid, previousPath); } catch { /* best-effort */ }
  }
  res.json({ avatar_url: null });
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
  // Attach the latest visitor rating per call (best-effort, single roundtrip)
  const calls = data || [];
  if (calls.length > 0) {
    const ids = calls.map((c) => c.id);
    const { data: ratings } = await sb.from('call_ratings')
      .select('call_session_id, rating, comment, created_at')
      .eq('workspace_id', wid)
      .in('call_session_id', ids);
    const map = new Map<string, CallRatingRow>();
    for (const r of (ratings || []) as CallRatingRow[]) {
      const prev = map.get(r.call_session_id);
      if (!prev || new Date(r.created_at) > new Date(prev.created_at)) {
        map.set(r.call_session_id, r);
      }
    }
    for (const c of calls) {
      const r = map.get(c.id);
      c.rating = r ? { rating: r.rating, comment: r.comment, created_at: r.created_at } : null;
    }
  }
  res.json({ calls });
});

callCenterRouter.get('/calls/:id', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const sb = getServiceClient(ctx.config);
  const { data: call } = await sb.from('call_sessions').select('*').eq('id', req.params.id).eq('workspace_id', wid).maybeSingle();
  if (!call) return res.status(404).json({ error: 'not_found' });
  const { data: events } = await sb.from('call_events').select('*').eq('call_session_id', req.params.id).order('created_at', { ascending: true });
  // Visitor rating + comment (optional — there may be no rating yet)
  const { data: rating } = await sb.from('call_ratings')
    .select('rating, comment, created_at')
    .eq('call_session_id', req.params.id)
    .eq('workspace_id', wid)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  res.json({ call, events: events || [], rating: rating || null });
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

/**
 * Start recording automatically when the operator answers.
 *
 * The workspace "Recording enabled" switch is documented as *"eligible calls
 * are recorded once consent has been satisfied"* — before this, nothing acted
 * on that promise: recording only ever began when an operator remembered to
 * press the button, so a workspace with recording switched on still ended up
 * with no recordings. This closes that gap the way a real call centre behaves:
 * recording follows the policy, and the toolbar button becomes a stop/restart
 * override rather than the only way to start.
 *
 * Deliberately best-effort and non-blocking:
 *   - Every gate (platform / plan / workspace / provider / consent /
 *     entitlement ceilings) is re-checked inside startCallCenterRecording,
 *     which fails closed. We pre-check the cheap ones so a workspace with
 *     recording off never pays for the entitlement RPCs.
 *   - It runs AFTER the accept response is written, so answering a call is
 *     never slowed down or failed by the recorder.
 *   - Only a clean `disabled` state auto-starts. A `failed` state is left
 *     alone so a broken egress config cannot turn every answer into a retry
 *     storm — the operator restarts it deliberately from the toolbar.
 */
async function autoStartRecordingOnAccept(
  config: ServerConfig,
  workspaceId: string,
  callId: string,
  actorUserId: string,
): Promise<void> {
  try {
    const sb = getServiceClient(config);
    const { data: row } = await sb
      .from('call_sessions')
      .select('recording_state, metadata')
      .eq('id', callId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (!row) return;
    if (String(row.recording_state || 'disabled') !== 'disabled') return;

    const platform = await getPlatformCallCenterSettings(config);
    if (!platform.call_recording_enabled) return;
    const ws = await getOrCreateWorkspaceSettings(config, workspaceId);
    if (!ws.recording_enabled) return;
    if (ws.recording_consent_required) {
      const meta = (row.metadata || {}) as Record<string, unknown>;
      const rec = (meta.recording as Record<string, unknown>) || {};
      if (!rec.consent_given) return;
    }

    await startCallCenterRecording(config, {
      workspaceId,
      callId,
      actorUserId,
      recordingType: 'composite',
    });
  } catch {
    // startCallCenterRecording already persists `recording_state: 'failed'`
    // and logs a `recording_failed` call event on the way out, so the
    // operator sees the reason in the console's recording strip. Nothing
    // here may surface to the accept response — it has already been sent.
  }
}

callCenterRouter.post('/calls/:id/accept', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  try {
    const sb = getServiceClient(ctx.config);
    const { data: callRaw } = await sb.from('call_sessions').select('*')
      .eq('id', req.params.id).eq('workspace_id', wid)
      .eq('entry_source', 'call_widget').maybeSingle();
    if (!callRaw) return res.status(404).json({ error: 'not_found' });
    const call = callRaw as CallSessionRow;
    const prevState = String(call.state || '');
    if (['ended', 'cancelled', 'failed', 'missed'].includes(prevState)) {
      return res.status(409).json({ error: 'call_not_active' });
    }
    const { data: queueRowRaw } = await sb.from('call_queue_entries')
      .select('id, offered_to_user_id, accepted_at')
      .eq('call_session_id', req.params.id).eq('workspace_id', wid).maybeSingle();
    const queueRow = queueRowRaw as QueueEntryRow | null;
    let decision: OwnershipDecision;
    try {
      decision = await canOperateCall(ctx.config, wid, ctx.userId, call, 'accept', queueRow);
    } catch (e) {
      if (sendOwnershipError(res, e)) return;
      throw e;
    }
    const previousAssigned = (call.assigned_agent_id as string | null) || null;
    const wasAlreadyActiveForMe =
      previousAssigned === ctx.userId &&
      ['active', 'ringing', 'connecting'].includes(prevState);

    // Resolve provider and create room if needed
    const { id: providerId, provider } = await resolveEffectiveCallProvider(ctx.config, wid);
    let providerRoomId = call.provider_room_id as string | null;
    if (!providerRoomId) {
      const room = await provider.createRoom(ctx.config, {
        workspaceId: wid,
        callSessionId: req.params.id,
        callType: (call.call_type === 'video' ? 'video' : 'audio'),
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
    if (!call.connected_at) {
      acceptPatch.connected_at = new Date().toISOString();
    }
    await transitionCall(ctx.config, wid, req.params.id, acceptPatch, 'call_accepted', ctx.userId);

    // Keep queue + session assignment consistent.
    const queuePatch: Record<string, unknown> = {
      state: 'accepted',
      offered_to_user_id: ctx.userId,
      assigned_agent_id: ctx.userId,
    };
    if (queueRow && !queueRow.accepted_at) {
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

    // Fire-and-forget: the response is already written, and the helper
    // swallows everything. A takeover re-entering an already-recording call
    // is a no-op because the state is no longer `disabled`.
    void autoStartRecordingOnAccept(ctx.config, wid, req.params.id, ctx.userId);
  } catch (e) {
    if (sendOwnershipError(res, e)) return;
    res.status(500).json({ error: 'accept_failed', message: e instanceof Error ? e.message : String(e) });
  }
});

callCenterRouter.post('/calls/:id/reject', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  try {
    const sb = getServiceClient(ctx.config);
    const { data: existingRaw } = await sb.from('call_sessions')
      .select('id, entry_source, assigned_agent_id, state')
      .eq('id', req.params.id).eq('workspace_id', wid)
      .eq('entry_source', 'call_widget').maybeSingle();
    if (!existingRaw) return res.status(404).json({ error: 'not_found' });
    const existing = existingRaw as CallSessionRow;
    const prevState = String(existing.state || '');
    if (['ended', 'cancelled', 'failed'].includes(prevState)) {
      return res.status(409).json({ error: 'call_not_active' });
    }
    const { data: qRowRaw } = await sb.from('call_queue_entries')
      .select('id, offered_to_user_id')
      .eq('call_session_id', req.params.id).eq('workspace_id', wid).maybeSingle();
    const qRow = qRowRaw as QueueEntryRow | null;
    try {
      await canOperateCall(ctx.config, wid, ctx.userId, existing, 'reject', qRow);
    } catch (e) {
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
      const meta = (prev?.metadata as Record<string, unknown> | null) || {};
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
    const assigned = (existing.assigned_agent_id as string | null) || null;
    if (assigned === ctx.userId && ['active', 'connecting', 'ringing'].includes(prevState)) {
      try { await decrementAgentActiveCallCount(ctx.config, wid, ctx.userId); }
      catch {/* best-effort */}
    }
    res.json({ ok: true });
  } catch (e) {
    if (sendOwnershipError(res, e)) return;
    res.status(500).json({ error: 'reject_failed', message: e instanceof Error ? e.message : String(e) });
  }
});

callCenterRouter.post('/calls/:id/end', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  try {
    const sb = getServiceClient(ctx.config);
    const { data: callRaw } = await sb.from('call_sessions').select('*')
      .eq('id', req.params.id).eq('workspace_id', wid)
      .eq('entry_source', 'call_widget').maybeSingle();
    if (!callRaw) return res.status(404).json({ error: 'not_found' });
    const call = callRaw as CallSessionRow;
    const prevState = String(call.state || '');
    if (['ended', 'cancelled', 'failed'].includes(prevState)) {
      return res.status(409).json({ error: 'call_not_active' });
    }
    const { data: qRowRaw } = await sb.from('call_queue_entries')
      .select('id, offered_to_user_id')
      .eq('call_session_id', req.params.id).eq('workspace_id', wid).maybeSingle();
    const qRow = qRowRaw as QueueEntryRow | null;
    try {
      await canOperateCall(ctx.config, wid, ctx.userId, call, 'end', qRow);
    } catch (e) {
      if (sendOwnershipError(res, e)) return;
      throw e;
    }
    const startedAt = call.connected_at || call.started_at || call.created_at;
    const duration = startedAt ? Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)) : 0;
    if (call.provider && call.provider_room_id) {
      try {
        const { provider } = await resolveEffectiveCallProvider(ctx.config, wid);
        await provider.closeRoom(ctx.config, call.provider_room_id);
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
    const assigned = (call.assigned_agent_id as string | null) || null;
    const wasActive = ['active', 'connecting', 'ringing'].includes(prevState);
    let owner: string | null = null;
    if (assigned && wasActive) owner = assigned;
    else if (!assigned && wasActive) owner = ctx.userId;
    if (owner) {
      try { await decrementAgentActiveCallCount(ctx.config, wid, owner); }
      catch {/* best-effort */}
    }
    res.json({ ok: true });
  } catch (e) {
    if (sendOwnershipError(res, e)) return;
    res.status(500).json({ error: 'end_failed', message: e instanceof Error ? e.message : String(e) });
  }
});

// ── Recording start/stop/status (CC-2F) ────────────────────────────────────
const recordingTypeSchema = z.enum(['composite', 'individual', 'audio_only']).optional();

callCenterRouter.post('/calls/:id/recording/start', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  // Phase: Call Route Enforcement Expansion — strict deny-on-create.
  // Recording start is a pure new-action boundary; recording stop/status
  // remain ungated so any in-flight recording can still be finalized
  // after a plan downgrade. Reuses the canonical composer
  // (voice_video ∧ call_recording ∧ runtime.recording_enabled).
  const eff = await loadEffectiveCallEntitlements(ctx.config, wid);
  if (!eff.recording_enabled) {
    return res.status(403).json({
      error: 'plan_forbidden',
      capability: 'call_recording',
      upgrade_required: true,
    });
  }
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
  } catch (e) {
    if (e instanceof RecordingControlException) {
      return res.status(e.httpStatus).json({ error: e.code });
    }
    res.status(500).json({ error: 'recording_start_failed', message: e instanceof Error ? e.message : String(e) });
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
  } catch (e) {
    if (e instanceof RecordingControlException) {
      return res.status(e.httpStatus).json({ error: e.code });
    }
    res.status(500).json({ error: 'recording_stop_failed', message: e instanceof Error ? e.message : String(e) });
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
  } catch (e) {
    if (e instanceof RecordingControlException) {
      return res.status(e.httpStatus).json({ error: e.code });
    }
    res.status(500).json({ error: 'recording_status_failed', message: e instanceof Error ? e.message : String(e) });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Operator-side recording visibility (read-only, workspace-scoped).
//
//   GET  /api/call-center/calls/:id/recordings?workspaceId=...
//   POST /api/call-center/calls/:id/recordings/:recordingId/playback-token
//
// Strictly read-only — does NOT expose retention/legal-hold/override
// controls, never returns storage_path or provider URLs, and never mutates
// call_recordings. The janitor remains the sole deletion path. The minted
// token is hard-coded to disposition='inline' so operators cannot use this
// surface to force a forced-download flow; super-admin-only attachment
// minting remains exclusive to /api/admin/calls/recordings/:id/playback-token.
// ─────────────────────────────────────────────────────────────────────────
callCenterRouter.get('/calls/:id/recordings', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const callId = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(callId)) return res.status(400).json({ error: 'invalid_call_id' });
  const sb = getServiceClient(ctx.config);
  // Confirm the call belongs to this workspace BEFORE touching call_recordings —
  // prevents cross-workspace enumeration via the recordings endpoint.
  const { data: session, error: sessErr } = await sb
    .from('call_sessions')
    .select('id, workspace_id')
    .eq('id', callId)
    .maybeSingle();
  if (sessErr) return res.status(500).json({ error: sessErr.message });
  const sessionRow = session as { id: string; workspace_id: string } | null;
  if (!sessionRow || sessionRow.workspace_id !== wid) {
    return res.status(404).json({ error: 'not_found' });
  }
  const { data: rows, error } = await sb
    .from('call_recordings')
    .select('id, recording_type, duration_seconds, size_bytes, storage_path, created_at')
    .eq('call_session_id', callId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  // Strip storage_path / provider metadata from the public shape — operators
  // only need to know whether the artifact is playable.
  const recordings = ((rows || []) as unknown as CallRecordingListRow[]).map((r) => ({
    id: r.id,
    recording_type: r.recording_type,
    duration_seconds: r.duration_seconds ?? null,
    size_bytes: r.size_bytes ?? null,
    created_at: r.created_at,
    has_storage: Boolean(r.storage_path),
  }));
  res.json({ recordings });
});

// ─────────────────────────────────────────────────────────────────────────
// Workspace-wide recordings listing (read-only, workspace-scoped).
//
//   GET /api/call-center/recordings?workspaceId=...&limit=...&offset=...
//
// Returns every recording artifact whose parent call_session belongs to the
// given workspace, joined with a minimal call snapshot for display. Storage
// paths and provider metadata are never returned. Mirrors the same gating
// model as the per-call endpoint — membership is enforced by requireMember
// and the cross-workspace filter is performed via the call_sessions inner
// join. Deletion / retention controls remain super-admin only.
callCenterRouter.get('/recordings', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const sb = getServiceClient(ctx.config);
  const { data, error } = await sb
    .from('call_recordings')
    .select(
      'id, recording_type, duration_seconds, size_bytes, storage_path, created_at, call_session_id, call_sessions!inner(workspace_id, visitor_name, visitor_email, call_type, created_at, ended_at, duration_seconds)',
    )
    .eq('call_sessions.workspace_id', wid)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: error.message });
  const recordings = ((data || []) as unknown as WorkspaceRecordingListRow[]).map((r) => ({
    id: r.id,
    call_id: r.call_session_id,
    recording_type: r.recording_type,
    duration_seconds: r.duration_seconds ?? null,
    size_bytes: r.size_bytes ?? null,
    created_at: r.created_at,
    has_storage: Boolean(r.storage_path),
    call: r.call_sessions
      ? {
          visitor_name: r.call_sessions.visitor_name ?? null,
          visitor_email: r.call_sessions.visitor_email ?? null,
          call_type: r.call_sessions.call_type ?? null,
          started_at: r.call_sessions.created_at ?? null,
          ended_at: r.call_sessions.ended_at ?? null,
          duration_seconds: r.call_sessions.duration_seconds ?? null,
        }
      : null,
  }));
  res.json({ recordings, limit, offset });
});

callCenterRouter.post('/calls/:id/recordings/:recordingId/playback-token', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const callId = String(req.params.id || '');
  const recordingId = String(req.params.recordingId || '');
  if (!/^[0-9a-f-]{36}$/i.test(callId)) return res.status(400).json({ error: 'invalid_call_id' });
  if (!/^[0-9a-f-]{36}$/i.test(recordingId)) return res.status(400).json({ error: 'invalid_recording_id' });

  const sb = getServiceClient(ctx.config);
  const { data: row, error } = await sb
    .from('call_recordings')
    .select('id, storage_path, call_session_id, call_sessions!inner(workspace_id)')
    .eq('id', recordingId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  // Uniform 404 for any workspace/session/recording mismatch — never leak
  // existence of a recording that belongs to another workspace.
  if (!row) return res.status(404).json({ error: 'not_found' });
  const recRow = row as unknown as RecordingWithSessionRow;
  if (recRow.call_session_id !== callId) return res.status(404).json({ error: 'not_found' });
  if (recRow.call_sessions?.workspace_id !== wid) return res.status(404).json({ error: 'not_found' });
  if (!recRow.storage_path) return res.status(410).json({ error: 'missing_storage_path' });

  // Operator surface is inline-only — attachment disposition is reserved
  // for super-admin tooling. The streaming route enforces the disposition
  // claim embedded in the token, so this cannot be widened client-side.
  const minted = mintPlaybackToken(ctx.config, { recordingId, disposition: 'inline' });
  const url =
    `/api/calls/recording-playback/${encodeURIComponent(recordingId)}` +
    `?token=${encodeURIComponent(minted.token)}` +
    `&disposition=${minted.disposition}`;
  res.json({
    recording_id: recordingId,
    url,
    token: minted.token,
    disposition: minted.disposition,
    expires_at: minted.expires_at,
    ttl_seconds: minted.ttl_seconds,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Operator-side download (read-only, workspace-scoped).
//
//   POST /api/call-center/calls/:id/recordings/:recordingId/download-token
//
// Mints a short-lived attachment-scoped playback token for a recording the
// operator can already view. Reuses the same canonical token model as the
// inline mint above — the only difference is `disposition: 'attachment'`.
//
// Gated by requireCallOperator (the same gate that protects every other
// operator write/action on this router). The streaming route enforces the
// disposition claim embedded in the token, so an attachment-scoped token
// cannot be widened or downgraded client-side. No retention/legal-hold
// surface is exposed here; the janitor remains the sole deletion path.
// ─────────────────────────────────────────────────────────────────────────
callCenterRouter.post('/calls/:id/recordings/:recordingId/download-token', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  const callId = String(req.params.id || '');
  const recordingId = String(req.params.recordingId || '');
  if (!/^[0-9a-f-]{36}$/i.test(callId)) return res.status(400).json({ error: 'invalid_call_id' });
  if (!/^[0-9a-f-]{36}$/i.test(recordingId)) return res.status(400).json({ error: 'invalid_recording_id' });

  const sb = getServiceClient(ctx.config);
  const { data: row, error } = await sb
    .from('call_recordings')
    .select('id, storage_path, call_session_id, call_sessions!inner(workspace_id)')
    .eq('id', recordingId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  // Same uniform 404 behavior as the inline mint — never leak existence of
  // a recording outside the caller's workspace or on a different call.
  if (!row) return res.status(404).json({ error: 'not_found' });
  const recRow = row as unknown as RecordingWithSessionRow;
  if (recRow.call_session_id !== callId) return res.status(404).json({ error: 'not_found' });
  if (recRow.call_sessions?.workspace_id !== wid) return res.status(404).json({ error: 'not_found' });
  if (!recRow.storage_path) return res.status(410).json({ error: 'missing_storage_path' });

  const minted = mintPlaybackToken(ctx.config, { recordingId, disposition: 'attachment' });
  const url =
    `/api/calls/recording-playback/${encodeURIComponent(recordingId)}` +
    `?token=${encodeURIComponent(minted.token)}` +
    `&disposition=${minted.disposition}`;
  res.json({
    recording_id: recordingId,
    url,
    token: minted.token,
    disposition: minted.disposition,
    expires_at: minted.expires_at,
    ttl_seconds: minted.ttl_seconds,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Operator-side bulk download (read-only, workspace-scoped).
//
//   POST /api/call-center/calls/:id/recordings/bulk-download-tokens
//
// Mints short-lived attachment-scoped playback tokens for up to
// BULK_DOWNLOAD_LIMIT recordings on a single call that the operator is
// already allowed to view. This is purely an orchestration helper around
// the per-row download-token mint above — same gate, same canonical
// token model, same streaming route underneath, same uniform 404 for
// any cross-workspace/cross-call mismatch.
//
// The response is a per-id result array (success or { error }) so a
// single bad id never poisons the whole batch. No archive is generated
// server-side and no provider URL/storage_path is ever returned.
// ─────────────────────────────────────────────────────────────────────────
const BULK_DOWNLOAD_LIMIT = 25;

callCenterRouter.post('/calls/:id/recordings/bulk-download-tokens', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  const callId = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(callId)) return res.status(400).json({ error: 'invalid_call_id' });

  const rawIds = Array.isArray(req.body?.recording_ids) ? req.body.recording_ids : null;
  if (!rawIds || rawIds.length === 0) {
    return res.status(400).json({ error: 'recording_ids_required' });
  }
  if (rawIds.length > BULK_DOWNLOAD_LIMIT) {
    return res.status(400).json({ error: 'too_many_recordings', limit: BULK_DOWNLOAD_LIMIT });
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawIds) {
    const id = String(raw || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ error: 'invalid_recording_id', recording_id: id });
    }
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }

  const sb = getServiceClient(ctx.config);
  const results: Array<
    | {
        recording_id: string;
        url: string;
        token: string;
        disposition: string;
        expires_at: string;
        ttl_seconds: number;
      }
    | { recording_id: string; error: string }
  > = [];

  for (const recordingId of ids) {
    const { data: row, error } = await sb
      .from('call_recordings')
      .select('id, storage_path, call_session_id, call_sessions!inner(workspace_id)')
      .eq('id', recordingId)
      .maybeSingle();
    if (error) { results.push({ recording_id: recordingId, error: 'lookup_failed' }); continue; }
    if (!row) { results.push({ recording_id: recordingId, error: 'not_found' }); continue; }
    const recRow = row as unknown as RecordingWithSessionRow;
    if (recRow.call_session_id !== callId) { results.push({ recording_id: recordingId, error: 'not_found' }); continue; }
    if (recRow.call_sessions?.workspace_id !== wid) { results.push({ recording_id: recordingId, error: 'not_found' }); continue; }
    if (!recRow.storage_path) { results.push({ recording_id: recordingId, error: 'missing_storage_path' }); continue; }

    const minted = mintPlaybackToken(ctx.config, { recordingId, disposition: 'attachment' });
    const url =
      `/api/calls/recording-playback/${encodeURIComponent(recordingId)}` +
      `?token=${encodeURIComponent(minted.token)}` +
      `&disposition=${minted.disposition}`;
    results.push({
      recording_id: recordingId,
      url,
      token: minted.token,
      disposition: minted.disposition,
      expires_at: minted.expires_at,
      ttl_seconds: minted.ttl_seconds,
    });
  }

  res.json({ limit: BULK_DOWNLOAD_LIMIT, count: results.length, results });
});

// ─────────────────────────────────────────────────────────────────────────
// Operator-side server-side ZIP archive export (read-only, workspace-scoped).
//
//   POST /api/call-center/calls/:id/recordings/archive
//   body: { workspaceId, recording_ids: string[] }
//
// Packages up to ARCHIVE_LIMIT recordings on a single call that the
// current operator is already allowed to bulk-download into one ZIP
// response. This is purely a packaging convenience around the same
// canonical access model used by `bulk-download-tokens`:
//
//   • same operator gate (requireCallOperator)
//   • same per-id workspace/call validation
//   • same uniform "not_found" semantics — cross-workspace or cross-call
//     ids never leak existence
//   • bytes are read through the canonical storage abstraction
//     (downloadFile), never via raw provider URLs/credentials
//
// Partial-failure model: any id that fails (missing, wrong workspace,
// wrong call, storage missing, download error) is omitted from the
// archive and recorded in an inline `manifest.txt` so the operator can
// see exactly what was excluded and why. The archive itself only fails
// the request if zero recordings could be packaged.
//
// Hard caps protect memory:
//   • ARCHIVE_LIMIT  — max ids per request (matches bulk download)
//   • ARCHIVE_MAX_TOTAL_BYTES — total uncompressed payload (per request)
//
// No persistent artifact is created on disk or in storage; the ZIP is
// built in memory and streamed in a single response. No retention,
// legal-hold, or deletion semantics change. The janitor remains the
// sole deletion path.
// ─────────────────────────────────────────────────────────────────────────
const ARCHIVE_LIMIT = 25;
const ARCHIVE_MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB

function archiveExtForContentType(row: RecordingWithSessionRow): string {
  const path = String(row?.storage_path || '').toLowerCase();
  const ext = path.includes('.') ? path.split('.').pop() || '' : '';
  const allowed = new Set(['mp4', 'webm', 'mkv', 'ogg', 'm4a', 'mp3', 'wav', 'opus']);
  if (ext && allowed.has(ext)) return ext;
  if (row?.recording_type === 'audio_only') return 'm4a';
  return 'mp4';
}

callCenterRouter.post('/calls/:id/recordings/archive', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  const callId = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(callId)) return res.status(400).json({ error: 'invalid_call_id' });

  const rawIds = Array.isArray(req.body?.recording_ids) ? req.body.recording_ids : null;
  if (!rawIds || rawIds.length === 0) {
    return res.status(400).json({ error: 'recording_ids_required' });
  }
  if (rawIds.length > ARCHIVE_LIMIT) {
    return res.status(400).json({ error: 'too_many_recordings', limit: ARCHIVE_LIMIT });
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawIds) {
    const id = String(raw || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ error: 'invalid_recording_id', recording_id: id });
    }
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }

  const sb = getServiceClient(ctx.config);
  let recordingStorageConfig;
  try {
    recordingStorageConfig = await resolveRecordingStorageConfig(ctx.config);
  } catch (err) {
    if (err instanceof RecordingStorageNotConfigured) return res.status(502).json({ error: 'recording_storage_not_configured' });
    throw err;
  }
  const entries: Array<{ name: string; data: Buffer }> = [];
  const manifest: string[] = [
    `# Call recording archive`,
    `call_id: ${callId}`,
    `workspace_id: ${wid}`,
    `generated_at: ${new Date().toISOString()}`,
    ``,
  ];
  let totalBytes = 0;
  let included = 0;
  let excluded = 0;

  for (const recordingId of ids) {
    const { data: row, error } = await sb
      .from('call_recordings')
      .select('id, storage_path, recording_type, created_at, call_session_id, call_sessions!inner(workspace_id)')
      .eq('id', recordingId)
      .maybeSingle();
    if (error) { manifest.push(`EXCLUDED ${recordingId}  reason=lookup_failed`); excluded++; continue; }
    if (!row) { manifest.push(`EXCLUDED ${recordingId}  reason=not_found`); excluded++; continue; }
    const recRow = row as unknown as RecordingWithSessionRow;
    if (recRow.call_session_id !== callId) {
      manifest.push(`EXCLUDED ${recordingId}  reason=not_found`); excluded++; continue;
    }
    if (recRow.call_sessions?.workspace_id !== wid) {
      manifest.push(`EXCLUDED ${recordingId}  reason=not_found`); excluded++; continue;
    }
    const storagePath = recRow.storage_path;
    if (!storagePath) {
      manifest.push(`EXCLUDED ${recordingId}  reason=missing_storage_path`); excluded++; continue;
    }

    const dl = await downloadWithConfig(recordingStorageConfig, storagePath);
    if (!dl.success || !dl.data) {
      manifest.push(`EXCLUDED ${recordingId}  reason=download_failed`);
      excluded++;
      continue;
    }
    if (totalBytes + dl.data.length > ARCHIVE_MAX_TOTAL_BYTES) {
      manifest.push(`EXCLUDED ${recordingId}  reason=archive_size_cap_exceeded`);
      excluded++;
      continue;
    }

    const ext = archiveExtForContentType(recRow);
    const ts = recRow.created_at
      ? new Date(recRow.created_at).toISOString().replace(/[:.]/g, '-')
      : 'recording';
    const base = safeArchiveName(
      `call-recording-${String(recRow.id || 'unknown').slice(0, 12)}-${ts}.${ext}`,
      `recording-${recordingId.slice(0, 8)}.${ext}`,
    );
    entries.push({ name: base, data: dl.data });
    manifest.push(`INCLUDED ${recordingId}  file=${base}  bytes=${dl.data.length}`);
    totalBytes += dl.data.length;
    included++;
  }

  if (included === 0) {
    // Nothing safely packageable — surface a structured error rather than
    // a misleading empty archive.
    return res.status(404).json({ error: 'no_recordings_available', excluded });
  }

  manifest.push(``, `summary: included=${included} excluded=${excluded} bytes=${totalBytes}`);
  entries.push({ name: 'manifest.txt', data: Buffer.from(manifest.join('\n') + '\n', 'utf8') });

  const zip = buildStoreZip(entries);
  const fname = `call-${callId.slice(0, 8)}-recordings-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.setHeader('Content-Length', String(zip.length));
  res.setHeader('X-Archive-Included', String(included));
  res.setHeader('X-Archive-Excluded', String(excluded));
  return res.status(200).send(zip);
});

// ─────────────────────────────────────────────────────────────────────────
// Operator-side workspace-scoped multi-call archive export (read-only).
//
//   POST /api/call-center/workspaces/recordings/archive
//   body: { workspaceId, items: Array<{ call_id, recording_id }> }
//
// Sibling of the single-call archive route above. Identical safety model:
//
//   • requireCallOperator gate on the supplied workspaceId
//   • each item validated independently against
//     call_recordings.id + call_session_id + call_sessions.workspace_id
//   • cross-workspace / cross-call items are silently excluded via the
//     manifest with a uniform `not_found` reason (no existence leak)
//   • bytes flow through the canonical storage abstraction (downloadFile),
//     never via raw provider URLs or credentials
//   • same ARCHIVE_LIMIT / ARCHIVE_MAX_TOTAL_BYTES caps apply to the
//     combined multi-call selection
//   • partial-failure model is identical: included entries are packaged,
//     excluded entries are listed in manifest.txt, zero successes returns
//     a structured 404 instead of an empty archive
//   • retention, legal-hold, override and deletion semantics are
//     unchanged — the janitor remains the sole deletion path
//
// Archive layout groups files by call to avoid filename collisions across
// calls:  `call-<call_id[:8]>/<safe-recording-name>.<ext>`
// ─────────────────────────────────────────────────────────────────────────
callCenterRouter.post('/workspaces/recordings/archive', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;

  const rawItems = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!rawItems || rawItems.length === 0) {
    return res.status(400).json({ error: 'items_required' });
  }
  if (rawItems.length > ARCHIVE_LIMIT) {
    return res.status(400).json({ error: 'too_many_recordings', limit: ARCHIVE_LIMIT });
  }

  type Item = { call_id: string; recording_id: string };
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    const callId = String(raw?.call_id || '');
    const recordingId = String(raw?.recording_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(callId)) {
      return res.status(400).json({ error: 'invalid_call_id', call_id: callId });
    }
    if (!/^[0-9a-f-]{36}$/i.test(recordingId)) {
      return res.status(400).json({ error: 'invalid_recording_id', recording_id: recordingId });
    }
    const key = `${callId}:${recordingId}`;
    if (!seen.has(key)) { seen.add(key); items.push({ call_id: callId, recording_id: recordingId }); }
  }

  const sb = getServiceClient(ctx.config);
  let recordingStorageConfig;
  try {
    recordingStorageConfig = await resolveRecordingStorageConfig(ctx.config);
  } catch (err) {
    if (err instanceof RecordingStorageNotConfigured) return res.status(502).json({ error: 'recording_storage_not_configured' });
    throw err;
  }
  const entries: Array<{ name: string; data: Buffer }> = [];
  const manifest: string[] = [
    `# Workspace recording archive`,
    `workspace_id: ${wid}`,
    `generated_at: ${new Date().toISOString()}`,
    ``,
  ];
  let totalBytes = 0;
  let included = 0;
  let excluded = 0;
  const callsTouched = new Set<string>();

  for (const { call_id: callId, recording_id: recordingId } of items) {
    const { data: row, error } = await sb
      .from('call_recordings')
      .select('id, storage_path, recording_type, created_at, call_session_id, call_sessions!inner(workspace_id)')
      .eq('id', recordingId)
      .maybeSingle();
    if (error) { manifest.push(`EXCLUDED call=${callId} rec=${recordingId}  reason=lookup_failed`); excluded++; continue; }
    if (!row) { manifest.push(`EXCLUDED call=${callId} rec=${recordingId}  reason=not_found`); excluded++; continue; }
    const recRow = row as unknown as RecordingWithSessionRow;
    if (recRow.call_session_id !== callId) {
      manifest.push(`EXCLUDED call=${callId} rec=${recordingId}  reason=not_found`); excluded++; continue;
    }
    if (recRow.call_sessions?.workspace_id !== wid) {
      manifest.push(`EXCLUDED call=${callId} rec=${recordingId}  reason=not_found`); excluded++; continue;
    }
    const storagePath = recRow.storage_path;
    if (!storagePath) {
      manifest.push(`EXCLUDED call=${callId} rec=${recordingId}  reason=missing_storage_path`); excluded++; continue;
    }

    const dl = await downloadWithConfig(recordingStorageConfig, storagePath);
    if (!dl.success || !dl.data) {
      manifest.push(`EXCLUDED call=${callId} rec=${recordingId}  reason=download_failed`);
      excluded++;
      continue;
    }
    if (totalBytes + dl.data.length > ARCHIVE_MAX_TOTAL_BYTES) {
      manifest.push(`EXCLUDED call=${callId} rec=${recordingId}  reason=archive_size_cap_exceeded`);
      excluded++;
      continue;
    }

    const ext = archiveExtForContentType(recRow);
    const ts = recRow.created_at
      ? new Date(recRow.created_at).toISOString().replace(/[:.]/g, '-')
      : 'recording';
    const base = safeArchiveName(
      `recording-${String(recRow.id || 'unknown').slice(0, 12)}-${ts}.${ext}`,
      `recording-${recordingId.slice(0, 8)}.${ext}`,
    );
    const dir = `call-${callId.slice(0, 8)}`;
    entries.push({ name: `${dir}/${base}`, data: dl.data });
    manifest.push(`INCLUDED call=${callId} rec=${recordingId}  file=${dir}/${base}  bytes=${dl.data.length}`);
    totalBytes += dl.data.length;
    included++;
    callsTouched.add(callId);
  }

  if (included === 0) {
    return res.status(404).json({ error: 'no_recordings_available', excluded });
  }

  manifest.push(``, `summary: calls=${callsTouched.size} included=${included} excluded=${excluded} bytes=${totalBytes}`);
  entries.push({ name: 'manifest.txt', data: Buffer.from(manifest.join('\n') + '\n', 'utf8') });

  const zip = buildStoreZip(entries);
  const fname = `workspace-${wid.slice(0, 8)}-recordings-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.setHeader('Content-Length', String(zip.length));
  res.setHeader('X-Archive-Included', String(included));
  res.setHeader('X-Archive-Excluded', String(excluded));
  res.setHeader('X-Archive-Calls', String(callsTouched.size));
  return res.status(200).send(zip);
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
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  const patch: Record<string, unknown> = {
    status: 'completed', completed_at: now, handled_by: ctx.userId, updated_at: now,
  };
  if (note) {
    // Read current row to merge notes + metadata.resolution_note
    const { data: existing } = await sb
      .from('callback_requests')
      .select('notes, metadata')
      .eq('id', req.params.id)
      .eq('workspace_id', wid)
      .maybeSingle();
    const prevNotes = (existing?.notes || '').trim();
    const stamp = new Date().toISOString();
    const line = `[${stamp}] (resolution) ${note}`;
    patch.notes = prevNotes ? `${prevNotes}\n${line}` : line;
    const meta = (existing?.metadata as Record<string, unknown> | null) || {};
    patch.metadata = {
      ...meta,
      resolution_note: note,
      resolved_at: stamp,
      resolved_by: ctx.userId,
    };
  }
  await sb.from('callback_requests').update(patch).eq('id', req.params.id).eq('workspace_id', wid);
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
  const storedSettings = await getPlatformCallCenterSettings(ctx.config);
  const ringback = await resolvePlatformRingbackUrls(ctx.config, storedSettings);
  const settings = { ...storedSettings, ringback_music_url: ringback.music_url };
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
  widget_default_locale: z.enum(['en', 'fa', 'tr']).optional(),
  widget_available_locales: z.array(z.enum(['en', 'fa', 'tr'])).min(1).optional(),
  // Ringback / queue experience (super-admin scope) — was missing from the
  // schema and silently dropped by z.object.strip() in the previous task.
  ringback_enabled: z.boolean().optional(),
  ringback_mode: z.enum(['tone', 'music', 'off']).optional(),
  ringback_music_path: z.string().nullable().optional(),
  // ringback_music_url is deliberately NOT settable: the link is derived
  // from ringback_music_path at read time, so persisting one could only
  // reintroduce a provider-pinned value.
  ringback_announcement_audio_path: z.string().nullable().optional(),
  ringback_queue_audio_paths: z.record(z.string()).nullable().optional(),
  queue_show_position: z.boolean().optional(),
  queue_show_eta: z.boolean().optional(),
  queue_eta_seconds_per_position: z.number().int().min(0).optional(),
  queue_offer_callback_after_seconds: z.number().int().min(0).optional(),
  operator_new_call_sound_enabled: z.boolean().optional(),
  callback_show_when_online: z.boolean().optional(),
  callback_min_seconds_between_requests: z.number().int().min(0).optional(),
  callback_max_per_ip_per_hour: z.number().int().min(0).optional(),
  callback_require_contact: z.boolean().optional(),
  callback_min_message_length: z.number().int().min(0).optional(),
  callback_honeypot_enabled: z.boolean().optional(),
  callback_min_form_seconds: z.number().int().min(0).optional(),
});

callCenterRouter.put('/admin/platform', async (req, res) => {
  const ctx = await requireGlobalAdmin(req, res);
  if (!ctx) return;
  const parsed = platformPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  const updated = await updatePlatformCallCenterSettings(ctx.config, parsed.data);
  // Audit-on-save (best-effort, no new audit system)
  try {
    const sb = getServiceClient(ctx.config);
    await sb.from('audit_logs').insert({
      user_id: ctx.userId,
      action: 'platform_call_center.update',
      entity_type: 'platform_call_center_settings',
      entity_id: (updated as unknown as { id?: string }).id ?? null,
      new_value: parsed.data,
    });
  } catch {/* audit_logs may not exist; ignore */}
  res.json({ settings: updated });
});

const MAX_RINGBACK_AUDIO_BYTES = 12 * 1024 * 1024;
const ALLOWED_RINGBACK_AUDIO_MIME = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac']);
const ringbackAudioUploadSchema = z.object({
  kind: z.enum(['music', 'announcement', 'queue']),
  queue_position: z.number().int().min(1).max(6).optional(),
  fileName: z.string().min(1).max(160),
  contentType: z.string().min(1).max(80),
  data: z.string().min(1),
});

callCenterRouter.post('/admin/platform/ringback-audio', async (req, res) => {
  const ctx = await requireGlobalAdmin(req, res);
  if (!ctx) return;
  const parsed = ringbackAudioUploadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  const input = parsed.data;
  if (input.kind === 'queue' && !input.queue_position) return res.status(400).json({ error: 'queue_position_required' });
  if (!ALLOWED_RINGBACK_AUDIO_MIME.has(input.contentType)) return res.status(415).json({ error: 'unsupported_audio_type' });
  let buffer: Buffer;
  try { buffer = Buffer.from(input.data, 'base64'); } catch { return res.status(400).json({ error: 'invalid_data' }); }
  if (buffer.length === 0 || buffer.length > MAX_RINGBACK_AUDIO_BYTES) return res.status(413).json({ error: 'file_too_large' });
  const storage = await resolveGlobalStorageConfig(ctx.config);
  if (!storage) return res.status(500).json({ error: 'global_storage_not_configured' });
  const safe = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 90);
  const slot = input.kind === 'queue' ? `queue-${input.queue_position}` : input.kind;
  // Workspace-first storage finalization: routed through the central
  // platformCallCenterRingbackKey() builder. This object is genuinely
  // platform-owned (a global admin setting, not tied to any workspace) —
  // the previous all-zero-UUID sentinel workspaceId was dead code
  // (uploadWithConfig() never reads it for key construction or scope
  // enforcement) and is removed rather than perpetuated.
  const fileKey = platformCallCenterRingbackKey({ slot, fileName: safe });
  const uploaded = await uploadWithConfig(storage, { fileKey, data: buffer, contentType: input.contentType });
  // The link is derived, never persisted — see resolvePlatformRingbackUrls.
  const url = getFileUrlWithConfig(storage, fileKey);
  if (!uploaded.success || !url) return res.status(500).json({ error: 'audio_upload_failed', details: uploaded.error });
  const current = await getPlatformCallCenterSettings(ctx.config);
  const patch: Partial<PlatformCallCenterSettings> = {};
  let previousPath: string | null = null;
  if (input.kind === 'music') {
    previousPath = current.ringback_music_path;
    patch.ringback_music_path = fileKey;
    // KEY ONLY: the legacy URL column is cleared so nothing can fall back to
    // a link that names the provider primary at upload time.
    patch.ringback_music_url = null;
    patch.ringback_mode = 'music';
    patch.ringback_enabled = true;
  } else if (input.kind === 'announcement') {
    previousPath = current.ringback_announcement_audio_path;
    patch.ringback_announcement_audio_path = fileKey;
  } else {
    const map = { ...((current.ringback_queue_audio_paths || {}) as Record<string, string>) };
    previousPath = map[String(input.queue_position)] || null;
    map[String(input.queue_position)] = fileKey;
    patch.ringback_queue_audio_paths = map;
  }
  const updated = await updatePlatformCallCenterSettings(ctx.config, patch);
  if (previousPath && previousPath !== fileKey) {
    try { await deleteWithConfig(storage, previousPath); } catch { /* best-effort */ }
  }
  res.json({ settings: { ...updated, ringback_music_url: (await resolvePlatformRingbackUrls(ctx.config, updated)).music_url }, url, file_key: fileKey });
});

callCenterRouter.get('/admin/workspaces', async (req, res) => {
  const ctx = await requireGlobalAdmin(req, res);
  if (!ctx) return;
  const sb = getServiceClient(ctx.config);
  const { data } = await sb.from('call_center_settings')
    .select('workspace_id, enabled, voice_enabled, video_enabled, callback_enabled, recording_enabled, public_key, updated_at, workspaces:workspace_id(name, slug)')
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
  } catch (e) {
    res.status(500).json({ error: 'list_failed', message: e instanceof Error ? e.message : String(e) });
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
    const department = await createDepartment(ctx.config, wid, parsed.data);
    res.status(201).json({ department });
  } catch (e) {
    if (handleDeptErr(e, res, 'create_failed')) return;
    res.status(500).json({ error: 'create_failed', message: e instanceof Error ? e.message : String(e) });
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
  } catch (e) {
    if (handleDeptErr(e, res, 'update_failed')) return;
    res.status(500).json({ error: 'update_failed', message: e instanceof Error ? e.message : String(e) });
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
  } catch (e) {
    res.status(500).json({ error: 'delete_failed', message: e instanceof Error ? e.message : String(e) });
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
  } catch (e) {
    if (handleDeptErr(e, res, 'list_failed')) return;
    res.status(500).json({ error: 'list_failed', message: e instanceof Error ? e.message : String(e) });
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
  } catch (e) {
    if (handleDeptErr(e, res, 'add_failed')) return;
    res.status(500).json({ error: 'add_failed', message: e instanceof Error ? e.message : String(e) });
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
  } catch (e) {
    if (handleDeptErr(e, res, 'update_failed')) return;
    res.status(500).json({ error: 'update_failed', message: e instanceof Error ? e.message : String(e) });
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
  } catch (e) {
    if (handleDeptErr(e, res, 'remove_failed')) return;
    res.status(500).json({ error: 'remove_failed', message: e instanceof Error ? e.message : String(e) });
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
    // Operator surfaces (transfer picker, wallboard) need a human label for
    // each agent. Presence rows only carry user_id, so resolve display names
    // in ONE batched read — never one request per agent.
    const ids = Array.from(
      new Set((presence as Array<{ user_id?: string }>).map((p) => p?.user_id).filter(Boolean) as string[]),
    );
    const names = new Map<string, { name: string | null; email: string | null }>();
    if (ids.length > 0) {
      const sb = getServiceClient(ctx.config);
      const { data: profiles } = await sb
        .from('profiles')
        .select('id, full_name, email')
        .in('id', ids);
      for (const p of profiles || []) {
        names.set(p.id, { name: p.full_name ?? null, email: p.email ?? null });
      }
    }
    res.json({
      presence: (presence as Array<Record<string, unknown>>).map((p) => {
        const label = names.get(String(p.user_id));
        return { ...p, full_name: label?.name ?? null, email: label?.email ?? null };
      }),
    });
  } catch (e) {
    res.status(500).json({ error: 'list_failed', message: e instanceof Error ? e.message : String(e) });
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
  } catch (e) {
    res.status(500).json({ error: 'update_failed', message: e instanceof Error ? e.message : String(e) });
  }
});

// ── Operator call notes ───────────────────────────────────────────────────
//
// Wrap-up notes an operator writes about a Call Center call. Stored on the
// call's own `metadata.operator_notes[]` (no schema migration needed) and
// mirrored into `call_events` so the timeline shows when a note was added.
//
// STRICT:
//   - Standalone Call Center only (entry_source = 'call_widget') — never
//     touches chat-call sessions.
//   - Notes are internal: the visitor-facing widget never reads metadata.
//   - The event payload carries only the note id + author, never the body,
//     so timeline fan-out cannot leak note text.
const OPERATOR_NOTE_MAX = 2000;
const OPERATOR_NOTES_MAX_PER_CALL = 100;

interface OperatorNote {
  id: string;
  note: string;
  author_id: string;
  author_name: string | null;
  created_at: string;
}

const callNoteSchema = z.object({
  note: z.string().trim().min(1).max(OPERATOR_NOTE_MAX),
});

function readOperatorNotes(metadata: unknown): OperatorNote[] {
  const m = (metadata || {}) as Record<string, unknown>;
  const raw = m.operator_notes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is OperatorNote =>
    !!n && typeof n === 'object'
    && typeof (n as OperatorNote).id === 'string'
    && typeof (n as OperatorNote).note === 'string');
}

callCenterRouter.get('/calls/:id/notes', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireMember(req, res, wid);
  if (!ctx) return;
  const sb = getServiceClient(ctx.config);
  const { data: call } = await sb
    .from('call_sessions')
    .select('id, entry_source, metadata')
    .eq('id', req.params.id)
    .eq('workspace_id', wid)
    .maybeSingle();
  if (!call) return res.status(404).json({ error: 'not_found' });
  if (call.entry_source !== 'call_widget') return res.status(403).json({ error: 'wrong_entry_source' });
  res.json({ notes: readOperatorNotes(call.metadata) });
});

callCenterRouter.post('/calls/:id/notes', async (req, res) => {
  const wid = String(req.query.workspaceId || req.body?.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const ctx = await requireCallOperator(req, res, wid);
  if (!ctx) return;
  const parsed = callNoteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });

  const sb = getServiceClient(ctx.config);
  const { data: profile } = await sb
    .from('profiles')
    .select('full_name, email')
    .eq('id', ctx.userId)
    .maybeSingle();

  const note: OperatorNote = {
    id: randomUUID(),
    note: parsed.data.note,
    author_id: ctx.userId,
    author_name: profile?.full_name || profile?.email || null,
    created_at: new Date().toISOString(),
  };

  // `metadata` is a single jsonb column shared with the recording pipeline
  // (`recordingControl.ts#patchRecordingMeta`), which now also writes at
  // accept time because recording auto-starts. A plain read-modify-write
  // would let whichever write landed second silently drop the other key —
  // a saved note vanishing, or worse, `recording.recording_id` being lost
  // while Egress is still running. `trg_call_sessions_updated_at` bumps
  // `updated_at` on every UPDATE, so it is a usable version stamp:
  // compare-and-set on it and re-read on a lost race.
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: call } = await sb
      .from('call_sessions')
      .select('id, entry_source, metadata, updated_at')
      .eq('id', req.params.id)
      .eq('workspace_id', wid)
      .maybeSingle();
    if (!call) return res.status(404).json({ error: 'not_found' });
    if (call.entry_source !== 'call_widget') return res.status(403).json({ error: 'wrong_entry_source' });

    const existing = readOperatorNotes(call.metadata);
    if (existing.length >= OPERATOR_NOTES_MAX_PER_CALL) {
      return res.status(409).json({ error: 'note_limit_reached' });
    }
    const notes = [...existing, note];
    const metadata = { ...((call.metadata || {}) as Record<string, unknown>), operator_notes: notes };

    const { data: updated, error } = await sb
      .from('call_sessions')
      .update({ metadata })
      .eq('id', req.params.id)
      .eq('workspace_id', wid)
      .eq('updated_at', call.updated_at)
      .select('id')
      .maybeSingle();
    if (error) {
      return res.status(500).json({ error: 'note_save_failed', message: error.message });
    }
    // No row matched — another writer touched `metadata` between the read
    // and the write. Re-read and merge onto the newer value.
    if (!updated) continue;

    // Timeline marker only — the note body stays in metadata.
    try {
      await sb.from('call_events').insert({
        call_session_id: req.params.id,
        event_type: 'operator_note_added',
        actor_type: 'operator',
        actor_id: ctx.userId,
        payload: { note_id: note.id, author_name: note.author_name },
      });
    } catch { /* best-effort: the note itself is already persisted */ }

    return res.json({ ok: true, note, notes });
  }

  return res.status(409).json({ error: 'note_write_conflict' });
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
  } catch (e) {
    if (e instanceof RoutingException) return res.status(e.httpStatus).json({ error: e.code });
    res.status(500).json({ error: 'assign_failed', message: e instanceof Error ? e.message : String(e) });
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
  } catch (e) {
    if (e instanceof RoutingException) return res.status(e.httpStatus).json({ error: e.code });
    res.status(500).json({ error: 'transfer_failed', message: e instanceof Error ? e.message : String(e) });
  }
});

// ── CC-2H Phase 2 — LiveKit connectivity diagnostics ──────────────────────
//
// GET /api/call-center/diagnostics/livekit?workspaceId=...
// Returns a SAFE summary (no api_key/api_secret/webhook_secret/tokens) of
// LiveKit configuration + reachability. Restricted to workspace owners,
// admins, and team_leads. Used by the Super Admin Call Center page and the
// workspace install/settings readiness checks.
const DIAG_ROLES = new Set(['owner', 'admin', 'team_lead']);

async function probeUrl(url: string, timeoutMs = 3000): Promise<{ status: number | null; error: string | null }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'GET', signal: controller.signal });
    return { status: r.status, error: null };
  } catch (err) {
    const e = err as { code?: unknown; name?: unknown; message?: unknown } | undefined;
    return { status: null, error: String(e?.code || e?.name || e?.message || 'fetch_failed') };
  } finally {
    clearTimeout(t);
  }
}

callCenterRouter.get('/diagnostics/livekit', async (req, res) => {
  const wid = String(req.query.workspaceId || '');
  if (!wid) return res.status(400).json({ error: 'workspaceId_required' });
  const config = (req as ReqWithConfig).serverConfig;
  const auth = await authorizeWorkspaceAccess(req, res, wid);
  if (!auth) return;
  if (!auth.isAdmin && !(auth.role && DIAG_ROLES.has(auth.role))) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const lk = await loadLiveKitConfig(config);
  const wsUrl = await getLiveKitClientWsUrl(config);
  const normalized = normalizeClientWsUrl(wsUrl);

  const warnings: string[] = [];
  if (!lk.enabled) warnings.push('livekit_disabled');
  if (!lk.api_key) warnings.push('livekit_api_key_missing');
  if (!lk.api_secret) warnings.push('livekit_api_secret_missing');
  if (!normalized) warnings.push('livekit_url_missing');
  if (lk.recording_storage.vendor && (!lk.recording_storage.access_key || !lk.recording_storage.secret_key)) {
    warnings.push('recording_storage_credentials_missing');
  }

  // Build https origin from the wss URL for HTTP probes.
  let httpsOrigin: string | null = null;
  if (normalized) {
    try {
      const u = new URL(normalized);
      httpsOrigin = `https://${u.host}`;
    } catch { /* noop */ }
  }

  let rtcValidate: { status: number | null; error: string | null } = { status: null, error: null };
  let rtcV1Validate: { status: number | null; error: string | null } = { status: null, error: null };
  if (httpsOrigin) {
    [rtcValidate, rtcV1Validate] = await Promise.all([
      probeUrl(`${httpsOrigin}/rtc/validate`),
      probeUrl(`${httpsOrigin}/rtc/v1/validate`),
    ]);
    if (rtcV1Validate.status === 404) warnings.push('livekit_v1_rtc_path_not_supported');
    if (rtcValidate.status === null && rtcV1Validate.status === null) {
      warnings.push('livekit_server_unreachable');
    }
  }

  const connectSupported = !!normalized && lk.enabled && !!lk.api_key && !!lk.api_secret;
  const connectReason = !lk.enabled ? 'disabled'
    : !normalized ? 'livekit_url_missing'
    : (!lk.api_key || !lk.api_secret) ? 'credentials_missing'
    : null;

  res.json({
    provider: 'livekit',
    configured: lk.enabled && !!lk.api_key && !!lk.api_secret && !!normalized,
    server_url_public: wsUrl,
    server_url_public_normalized: normalized,
    rtc_url_present: !!lk.rtc_url,
    ws_url_present: !!lk.ws_url,
    api_key_present: !!lk.api_key,
    api_secret_present: !!lk.api_secret,
    connect_info_supported: connectSupported,
    connect_info_reason: connectReason,
    health: {
      twirp_create_room_ready: null,
      server_reachable: httpsOrigin
        ? rtcValidate.status !== null || rtcV1Validate.status !== null
        : null,
      rtc_validate_status: rtcValidate.status,
      rtc_v1_validate_status: rtcV1Validate.status,
      websocket_origin_hint: httpsOrigin,
    },
    warnings,
  });
});
