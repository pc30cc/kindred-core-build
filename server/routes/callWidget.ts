/**
 * Call Center — public visitor-facing routes for the standalone call widget.
 * Mounted at /api/call-widget/*. CORS is dynamic per workspace allowed_domains.
 * No service tokens leak to visitors. Visitors get short-lived HMAC sessions.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  findWorkspaceByPublicKey,
  getOrCreateWorkspaceSettings,
  getPlatformCallCenterSettings,
  computeEffectiveCallCenterCaps,
  originAllowed,
  type WorkspaceCallCenterSettings,
} from '../services/callCenter/settings.js';
import { signWidgetSession, verifyWidgetSession } from '../services/callCenter/widgetSession.js';
import { resolveEffectiveCallProvider } from '../services/calls/providerResolver.js';
import { publishQueueEvent, publishCallEvent } from '../services/callCenter/realtime.js';
import { buildClientConnectInfo } from '../services/callCenter/connectInfo.js';

export const callWidgetRouter = Router();

// Dynamic CORS per workspace allowed_domains
callWidgetRouter.use(async (req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  if (origin) {
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-cc-session');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function getOrigin(req: any): string | null {
  return (req.headers.origin as string) || null;
}

/**
 * Strict widget-session guard for sensitive routes.
 *
 *   - 401 invalid_session     — token missing / forged / expired
 *   - 403 origin_mismatch     — request Origin header missing or differs from session.origin
 *
 * CORS headers are not enough: a stolen session token replayed from another
 * origin (server-to-server, curl, malicious page) would otherwise pass.
 */
function requireWidgetSession(req: any, config: ServerConfig) {
  const session = getSession(req, config);
  if (!session) return { ok: false as const, status: 401, error: 'invalid_session' };
  const reqOrigin = getOrigin(req);
  if (session.origin) {
    if (!reqOrigin) return { ok: false as const, status: 403, error: 'origin_mismatch' };
    if (session.origin !== reqOrigin) return { ok: false as const, status: 403, error: 'origin_mismatch' };
  }
  return { ok: true as const, session };
}

async function resolveWorkspace(
  config: ServerConfig,
  query: { workspaceId?: string; publicKey?: string },
): Promise<WorkspaceCallCenterSettings | null> {
  if (query.publicKey) {
    return findWorkspaceByPublicKey(config, query.publicKey);
  }
  if (query.workspaceId) {
    return getOrCreateWorkspaceSettings(config, query.workspaceId);
  }
  return null;
}

function disabledResponse(reason: string, message?: Record<string, unknown>) {
  return { status: 'disabled', reason, message: message || null };
}

// ── Bootstrap ─────────────────────────────────────────────────────────────
callWidgetRouter.get('/bootstrap', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const ws = await resolveWorkspace(config, {
    workspaceId: req.query.workspaceId ? String(req.query.workspaceId) : undefined,
    publicKey: req.query.publicKey ? String(req.query.publicKey) : undefined,
  });
  if (!ws) return res.status(404).json({ error: 'workspace_not_found' });
  const platform = await getPlatformCallCenterSettings(config);
  if (!platform.call_center_enabled) {
    return res.json(disabledResponse('call_center_disabled', platform.disabled_message));
  }
  if (!ws.enabled) {
    return res.json(disabledResponse('workspace_disabled'));
  }
  const origin = getOrigin(req);
  if (!originAllowed(ws, origin)) {
    return res.status(403).json({ status: 'error', reason: 'origin_denied' });
  }
  const effective = computeEffectiveCallCenterCaps(platform, ws);
  // Provider readiness check (don't block bootstrap; reflect in payload)
  let provider_ready = false;
  try {
    await resolveEffectiveCallProvider(config, ws.workspace_id);
    provider_ready = true;
  } catch {/* not configured */}
  const session = signWidgetSession(config, {
    workspace_id: ws.workspace_id,
    public_key: ws.public_key,
    origin,
  });
  res.json({
    status: 'ok',
    session,
    workspace_id: ws.workspace_id,
    config: {
      display_name: ws.display_name,
      avatar_url: ws.avatar_url,
      widget_position: ws.widget_position,
      widget_theme: ws.widget_theme,
      pre_call_form_enabled: ws.pre_call_form_enabled,
      pre_call_form_schema: ws.pre_call_form_schema,
      offline_behavior: ws.offline_behavior,
      recording_consent_required: ws.recording_consent_required,
    },
    capabilities: {
      voice: effective.voice_enabled,
      video: effective.video_enabled,
      callback: effective.callback_enabled,
      recording: effective.recording_enabled,
    },
    provider_ready,
  });
});

// Helper: extract widget session
function getSession(req: any, config: ServerConfig) {
  const tok = (req.headers['x-cc-session'] as string) || '';
  return verifyWidgetSession(config, tok);
}

// ── Request a call ────────────────────────────────────────────────────────
const requestSchema = z.object({
  call_type: z.enum(['voice', 'video']),
  visitor_name: z.string().max(120).optional().nullable(),
  visitor_email: z.string().email().max(200).optional().nullable(),
  visitor_phone: z.string().max(40).optional().nullable(),
  subject: z.string().max(500).optional().nullable(),
  page_url: z.string().max(2000).optional().nullable(),
  page_title: z.string().max(500).optional().nullable(),
  consent_recording: z.boolean().optional(),
  form_data: z.record(z.unknown()).optional(),
});

callWidgetRouter.post('/calls/request', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const guard = requireWidgetSession(req, config);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
  const session = guard.session;
  const ws = await getOrCreateWorkspaceSettings(config, session.workspace_id);
  const platform = await getPlatformCallCenterSettings(config);
  if (!platform.call_center_enabled) return res.status(403).json({ error: 'call_center_disabled' });
  if (!ws.enabled) return res.status(403).json({ error: 'workspace_disabled' });
  const effective = computeEffectiveCallCenterCaps(platform, ws);
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  if (parsed.data.call_type === 'voice' && !effective.voice_enabled) return res.status(403).json({ error: 'feature_not_available' });
  if (parsed.data.call_type === 'video' && !effective.video_enabled) return res.status(403).json({ error: 'feature_not_available' });
  if (!originAllowed(ws, getOrigin(req))) return res.status(403).json({ error: 'origin_denied' });
  // Provider check (fail closed)
  let providerId: string;
  try {
    const r = await resolveEffectiveCallProvider(config, ws.workspace_id);
    providerId = r.id;
  } catch (e: any) {
    return res.status(503).json({ error: 'provider_not_configured', message: String(e?.message || e) });
  }
  // Concurrency / queue limit
  const sb = getServiceClient(config);
  const [{ count: active }, { count: queued }] = await Promise.all([
    sb.from('call_sessions').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ws.workspace_id).eq('entry_source', 'call_widget').in('state', ['active', 'ringing', 'connecting']),
    sb.from('call_queue_entries').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ws.workspace_id).eq('entry_source', 'call_widget').in('state', ['queued', 'offered']),
  ]);
  if ((active || 0) >= effective.max_concurrent_calls) return res.status(429).json({ error: 'limit_reached', kind: 'concurrent' });
  if ((queued || 0) >= effective.max_queue_size) return res.status(429).json({ error: 'limit_reached', kind: 'queue' });

  // Create call session + queue entry
  const dbCallType = parsed.data.call_type === 'voice' ? 'audio' : 'video';
  const { data: call, error: callErr } = await sb.from('call_sessions').insert({
    workspace_id: ws.workspace_id,
    entry_source: 'call_widget',
    direction: 'inbound',
    call_type: dbCallType,
    context_type: 'internal',
    context_id: null,
    state: 'pending',
    initiated_by_type: 'visitor',
    visitor_name: parsed.data.visitor_name || null,
    visitor_email: parsed.data.visitor_email || null,
    visitor_phone: parsed.data.visitor_phone || null,
    subject: parsed.data.subject || null,
    page_url: parsed.data.page_url || null,
    page_title: parsed.data.page_title || null,
    origin: getOrigin(req),
    provider: providerId,
    metadata: {
      call_center: true,
      form_data: parsed.data.form_data || null,
      consent_recording: !!parsed.data.consent_recording,
    },
  }).select('*').maybeSingle();
  if (callErr) return res.status(500).json({ error: 'call_create_failed', message: callErr.message });

  await sb.from('call_queue_entries').insert({
    workspace_id: ws.workspace_id,
    entry_source: 'call_widget',
    channel: dbCallType,
    state: 'queued',
    call_session_id: call!.id,
    requested_by: 'visitor',
    priority: 100,
  });

  await sb.from('call_events').insert({
    call_session_id: call!.id,
    event_type: 'call_requested',
    actor_type: 'visitor',
    payload: { call_type: parsed.data.call_type, page_url: parsed.data.page_url },
  });

  // Issue a fresh session bound to this call_id
  const newSession = signWidgetSession(config, {
    workspace_id: ws.workspace_id,
    public_key: ws.public_key,
    call_id: call!.id,
    origin: session.origin || null,
  });

  await publishQueueEvent(config, ws.workspace_id, 'call_requested', { call_id: call!.id });

  res.json({
    status: 'queued',
    call_id: call!.id,
    queue_position: (queued || 0) + 1,
    session: newSession,
  });
});

// ── Cancel ────────────────────────────────────────────────────────────────
callWidgetRouter.post('/calls/:id/cancel', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const guard = requireWidgetSession(req, config);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
  const session = guard.session;
  if (session.call_id !== req.params.id) return res.status(403).json({ error: 'forbidden' });
  const sb = getServiceClient(config);
  // Preserve detailed reason in metadata; constraint allows only the four canonical end_reason values.
  const { data: prev } = await sb.from('call_sessions').select('metadata').eq('id', req.params.id).maybeSingle();
  const prevMeta = (prev?.metadata as any) || {};
  await sb.from('call_sessions').update({
    state: 'cancelled',
    ended_at: new Date().toISOString(),
    end_reason: 'visitor_ended',
    ended_by: 'visitor',
    metadata: { ...prevMeta, call_center_reason: 'visitor_cancelled' },
  }).eq('id', req.params.id).eq('workspace_id', session.workspace_id);
  await sb.from('call_queue_entries').update({
    state: 'cancelled', ended_at: new Date().toISOString(), ended_reason: 'visitor_cancelled',
  }).eq('call_session_id', req.params.id).eq('workspace_id', session.workspace_id);
  await sb.from('call_events').insert({
    call_session_id: req.params.id, event_type: 'call_cancelled', actor_type: 'visitor',
    payload: { reason: 'visitor_cancelled' },
  });
  await publishQueueEvent(config, session.workspace_id, 'call_cancelled', { call_id: req.params.id });
  await publishCallEvent(config, session.workspace_id, req.params.id, 'call_cancelled', {});
  res.json({ ok: true });
});

// ── Status poll ───────────────────────────────────────────────────────────
callWidgetRouter.get('/calls/:id/status', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const guard = requireWidgetSession(req, config);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
  const session = guard.session;
  if (session.call_id !== req.params.id) return res.status(403).json({ error: 'forbidden' });
  const sb = getServiceClient(config);
  const { data: call } = await sb.from('call_sessions').select('id,state,ended_at,end_reason,provider,provider_room_id,call_type').eq('id', req.params.id).maybeSingle();
  if (!call) return res.status(404).json({ error: 'not_found' });
  res.json({ call });
});

// ── Visitor join token (only after operator accepts) ──────────────────────
callWidgetRouter.post('/calls/:id/join-token', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const guard = requireWidgetSession(req, config);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
  const session = guard.session;
  if (session.call_id !== req.params.id) return res.status(403).json({ error: 'forbidden' });
  // Re-check workspace origin allow-list (in case allowed_domains changed
  // between bootstrap and now).
  const wsForOrigin = await getOrCreateWorkspaceSettings(config, session.workspace_id);
  if (!originAllowed(wsForOrigin, getOrigin(req))) {
    return res.status(403).json({ error: 'origin_denied' });
  }
  const sb = getServiceClient(config);
  const { data: call } = await sb.from('call_sessions').select('*').eq('id', req.params.id).maybeSingle();
  if (!call) return res.status(404).json({ error: 'not_found' });
  const c = call as any;
  if (!c.provider_room_id || !c.provider) {
    return res.status(409).json({ error: 'not_ready', reason: 'provider_room_not_ready' });
  }
  if (!['active', 'ringing', 'connecting'].includes(c.state)) {
    return res.status(409).json({ error: 'not_active', reason: 'call_not_active' });
  }
  const { provider } = await resolveEffectiveCallProvider(config, c.workspace_id);
  const tok = await provider.createParticipantToken(config, {
    callSessionId: c.id,
    providerRoomId: c.provider_room_id,
    participantId: `visitor:${c.id}`,
    participantType: 'visitor',
    canPublish: true, canSubscribe: true, canPublishData: true,
    ttlSeconds: 60 * 60,
  });
  // LiveKit identity is `<participantType>:<participantId>` (see livekitProvider).
  const identity = `visitor:visitor:${c.id}`;
  const connect = await buildClientConnectInfo(config, c.provider, c.provider_room_id, identity);
  res.json({
    token: tok.token,
    provider: c.provider,
    provider_room_id: c.provider_room_id,
    expires_at: tok.expiresAt,
    connect,
  });
});

// ── Callback request ──────────────────────────────────────────────────────
const callbackSchema = z.object({
  name: z.string().max(120).optional().nullable(),
  email: z.string().email().max(200).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  subject: z.string().max(500).optional().nullable(),
  scheduled_for: z.string().datetime().optional().nullable(),
  page_url: z.string().max(2000).optional().nullable(),
});

callWidgetRouter.post('/callbacks/request', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const guard = requireWidgetSession(req, config);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
  const session = guard.session;
  const ws = await getOrCreateWorkspaceSettings(config, session.workspace_id);
  if (!originAllowed(ws, getOrigin(req))) {
    return res.status(403).json({ error: 'origin_denied' });
  }
  const platform = await getPlatformCallCenterSettings(config);
  const effective = computeEffectiveCallCenterCaps(platform, ws);
  if (!effective.callback_enabled) return res.status(403).json({ error: 'feature_not_available' });
  const parsed = callbackSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('callback_requests').insert({
    workspace_id: ws.workspace_id,
    channel: 'audio',
    status: 'requested',
    contact_phone: parsed.data.phone || null,
    contact_email: parsed.data.email || null,
    notes: parsed.data.subject || null,
    scheduled_for: parsed.data.scheduled_for || null,
    metadata: {
      source: 'call_widget',
      name: parsed.data.name || null,
      subject: parsed.data.subject || null,
      page_url: parsed.data.page_url || null,
    },
  }).select('*').maybeSingle();
  if (error) return res.status(500).json({ error: 'callback_create_failed', message: error.message });
  await publishQueueEvent(config, ws.workspace_id, 'callback_requested', { callback_id: data!.id });
  res.json({ ok: true, callback_id: data!.id });
});