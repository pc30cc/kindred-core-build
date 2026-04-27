/**
 * Phase 8A — Voice/Video signaling routes.
 *
 * Workspace-scoped, auth required. All provider-specific work flows
 * through `resolveEffectiveCallProvider()` — these handlers contain ZERO
 * provider branching.
 *
 * Routes:
 *   POST /api/calls/create
 *   POST /api/calls/:id/invite
 *   POST /api/calls/:id/accept
 *   POST /api/calls/:id/reject
 *   POST /api/calls/:id/hangup
 *   POST /api/calls/:id/token
 *   GET  /api/calls/:id/state
 *   POST /api/calls/:id/recording/start
 *   POST /api/calls/:id/recording/stop
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  resolveEffectiveCallProvider,
  resolveCallProvider,
  resolveCallProviderOrder,
} from '../services/calls/providerResolver.js';
import {
  loadCallControlPlane,
  loadWorkspaceCallOverrides,
} from '../services/calls/controlPlane.js';
import {
  getCallNetworkBundle,
  normalizeClientWsUrl,
} from '../services/calls/rtcResolver.js';
import { CallProviderNotReadyError } from '../services/calls/providers/types.js';
import { mintTurnCreds } from '../services/calls/turnAuth.js';
import { emitCallMetric } from '../services/calls/metrics.js';
import { publishConversationEvent } from '../services/realtime/publish.js';
import { markInCall, clearInCall } from '../services/calls/availability.js';
import {
  CALL_ERROR_CODES,
  CALL_ERROR_HTTP_STATUS,
  callErrorBody,
  callErrorFromUnknown,
} from '../services/calls/errorCodes.js';
import { getLiveKitReadinessState } from '../services/calls/providers/livekitProvider.js';
import { getManifestDiagnostics } from '../services/widget/manifest.js';
import { loadLiveKitConfig, isMinimallyConfigured } from '../services/calls/livekitConfig.js';

export const callsRouter = Router();

// ─── auth helper (mirrors conversations.ts) ───────────────────────────────
async function requireWorkspaceMember(
  req: any,
  res: any,
  config: ServerConfig,
  workspaceId: string,
): Promise<{ userId: string } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization' });
    return null;
  }
  const token = authHeader.replace('Bearer ', '');
  const sb = getServiceClient(config);
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }
  const { data: isMember, error: memErr } = await sb.rpc('is_workspace_member', {
    _workspace_id: workspaceId,
    _user_id: user.id,
  });
  if (memErr) {
    res.status(500).json({ error: 'Membership check failed' });
    return null;
  }
  if (!isMember) {
    res.status(403).json({ error: 'Not a workspace member' });
    return null;
  }
  return { userId: user.id };
}

async function loadSessionWithMembership(
  req: any,
  res: any,
  config: ServerConfig,
  callId: string,
) {
  const sb = getServiceClient(config);
  const { data: session, error } = await sb
    .from('call_sessions')
    .select('*')
    .eq('id', callId)
    .maybeSingle();
  if (error || !session) {
    res.status(404).json({ error: 'Call session not found' });
    return null;
  }
  const auth = await requireWorkspaceMember(req, res, config, session.workspace_id);
  if (!auth) return null;
  return { session, userId: auth.userId, sb };
}

function recordEvent(
  sb: ReturnType<typeof getServiceClient>,
  callId: string,
  eventType: string,
  actorType: 'visitor' | 'operator' | 'admin' | 'internal',
  actorId: string | null,
  payload: Record<string, unknown> = {},
) {
  return sb.from('call_events').insert({
    call_session_id: callId,
    event_type: eventType,
    actor_type: actorType,
    actor_id: actorId,
    payload,
  });
}

function handleProviderError(res: any, err: unknown) {
  if (err instanceof CallProviderNotReadyError) {
    return res.status(CALL_ERROR_HTTP_STATUS.provider_not_ready).json(
      callErrorBody(
        CALL_ERROR_CODES.PROVIDER_NOT_READY,
        err.message,
        { provider: err.providerId },
      ),
    );
  }
  console.error('[calls] provider error:', (err as any)?.message || err);
  return res.status(500).json({ error: 'internal_error' });
}

/**
 * Mint a visitor-scoped participant token (NEVER reused for operators) and
 * publish a `type: 'call:incoming'` envelope on the per-conversation channel
 * so the widget rings instantly. Fully best-effort — if the publish fails,
 * the visitor's polling fallback picks up state=ringing within 2s.
 */
async function emitVisitorIncomingEnvelope(
  config: ServerConfig,
  sb: ReturnType<typeof getServiceClient>,
  session: any,
  inviterUserId: string,
): Promise<void> {
  if (!session.provider_room_id || !session.context_id) return;

  // Resolve visitor for token identity (so LiveKit identity is stable + auditable).
  let visitorIdentity = 'visitor:' + session.context_id;
  try {
    const { data: conv } = await sb
      .from('conversations')
      .select('visitor_session_id, contact_id')
      .eq('id', session.context_id)
      .maybeSingle();
    if (conv?.visitor_session_id) {
      const { data: vs } = await sb
        .from('visitor_sessions')
        .select('visitor_id')
        .eq('id', conv.visitor_session_id)
        .maybeSingle();
      if (vs?.visitor_id) visitorIdentity = 'visitor:' + vs.visitor_id;
    }
  } catch { /* fall through with conversation-based identity */ }

  // Operator display name (best-effort; non-blocking).
  let operatorName: string | null = null;
  try {
    const { data: prof } = await sb
      .from('profiles')
      .select('full_name')
      .eq('id', inviterUserId)
      .maybeSingle();
    operatorName = (prof as any)?.full_name || null;
  } catch { /* */ }

  // Mint a fresh visitor participant token.
  let visitorToken: { token: string; expiresAt: number } | null = null;
  try {
    const provider = resolveCallProvider(session.provider);
    const minted = await provider.createParticipantToken(config, {
      callSessionId: session.id,
      providerRoomId: session.provider_room_id,
      participantId: visitorIdentity,
      participantType: 'visitor',
      displayName: 'Visitor',
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      ttlSeconds: 600,
    });
    visitorToken = { token: minted.token, expiresAt: minted.expiresAt };
  } catch (err: any) {
    // Provider not ready → publish a degraded envelope so the widget can
    // surface the incoming call but the visitor will get token only via
    // the explicit accept path (state polling).
    console.warn('[calls] visitor token mint failed during invite:', err?.message || err);
  }

  const { network, turn } = await buildTokenNetworkBundle(config, session.id, 600);

  await publishConversationEvent(
    config,
    session.workspace_id,
    session.context_id,
    {
      type: 'event',
      payload: {
        kind: 'call:incoming',
        call_id: session.id,
        call_type: session.call_type,
        operator_name: operatorName,
        ws_url: network.ws_url,
        rtc_url: network.rtc_url,
        token: visitorToken?.token ?? null,
        expires_at: visitorToken?.expiresAt ?? null,
        turn: {
          urls: turn.urls,
          username: turn.username,
          credential: turn.credential,
        },
        ice_policy: network.ice_policy,
        recording: !!session.recording_enabled,
      },
    },
  );
}

/**
 * Build the network bundle for a token response, including dynamically-minted
 * RFC 7635-style TURN credentials when a static_secret is present. Shared by
 * the /token endpoint and the /invite envelope so visitors and operators see
 * an identical TURN/ICE shape. URLs always come from the resolver — no
 * hardcoded hostnames.
 */
async function buildTokenNetworkBundle(
  config: ServerConfig,
  callSessionId: string,
  ttlSeconds: number,
) {
  const network = await getCallNetworkBundle(config);
  const turn = { ...network.turn };
  if (turn.static_secret_present && turn.urls.length > 0) {
    try {
      const sb = getServiceClient(config);
      const { data: rtcRow } = await sb
        .from('app_runtime_config')
        .select('value')
        .eq('key', 'call_rtc_endpoints')
        .maybeSingle();
      const sharedSecret = (rtcRow?.value as any)?.turn?.shared_secret;
      if (typeof sharedSecret === 'string' && sharedSecret.length > 0) {
        const minted = mintTurnCreds({
          sharedSecret,
          identity: 'call:' + callSessionId,
          ttlSeconds: Math.min(ttlSeconds, 3600),
        });
        turn.username = minted.username;
        turn.credential = minted.credential;
        turn.credential_type = 'password';
      }
    } catch {
      /* fall back to static creds */
    }
  }
  return { network, turn };
}

// ─── POST /api/calls/create ───────────────────────────────────────────────
const createSchema = z.object({
  workspace_id: z.string().uuid(),
  call_type: z.enum(['audio', 'video', 'screenshare', 'meeting']),
  context_type: z.enum(['conversation', 'internal', 'verification']),
  context_id: z.string().uuid().nullable().optional(),
  recording_enabled: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

callsRouter.post('/create', async (req, res) => {
  try {
    const body = createSchema.parse(req.body);
    const config: ServerConfig = (req as any).serverConfig;
    const auth = await requireWorkspaceMember(req, res, config, body.workspace_id);
    if (!auth) return;

    const cp = await loadCallControlPlane(config);
    if (!cp.enabled) {
      return res.status(409).json({ error: 'calls_disabled', message: 'Voice/Video disabled by admin.' });
    }
    const overrides = await loadWorkspaceCallOverrides(config, body.workspace_id);
    if (body.call_type === 'video' && !overrides.allow_video) {
      return res.status(409).json({ error: 'video_disabled_for_workspace' });
    }
    if (body.call_type === 'audio' && !overrides.allow_voice) {
      return res.status(409).json({ error: 'voice_disabled_for_workspace' });
    }
    const recordingRequested = body.recording_enabled ?? cp.recording_default_enabled;
    if (recordingRequested && !overrides.allow_recording) {
      return res.status(409).json({ error: 'recording_disabled_for_workspace' });
    }

    const { id: providerId, provider } = await resolveEffectiveCallProvider(
      config,
      body.workspace_id,
    );

    const sb = getServiceClient(config);
    const { data: inserted, error: insErr } = await sb
      .from('call_sessions')
      .insert({
        workspace_id: body.workspace_id,
        provider: providerId,
        call_type: body.call_type,
        context_type: body.context_type,
        context_id: body.context_id ?? null,
        state: 'pending',
        initiated_by: auth.userId,
        initiated_by_type: 'operator',
        recording_enabled: recordingRequested,
        recording_state: recordingRequested ? 'pending' : 'disabled',
        metadata: body.metadata ?? {},
      })
      .select('*')
      .single();
    if (insErr || !inserted) {
      return res.status(500).json({ error: insErr?.message || 'insert_failed' });
    }

    const room = await provider.createRoom(config, {
      workspaceId: body.workspace_id,
      callSessionId: inserted.id,
      callType: body.call_type,
      maxParticipants: cp.max_participants,
      recordingEnabled: recordingRequested,
      metadata: body.metadata,
    });

    await sb
      .from('call_sessions')
      .update({ provider_room_id: room.providerRoomId })
      .eq('id', inserted.id);

    await recordEvent(sb, inserted.id, 'created', 'operator', auth.userId, {
      provider: providerId,
      call_type: body.call_type,
    });

    emitCallMetric(config, {
      metric: 'call.create.success',
      workspaceId: body.workspace_id,
      provider: providerId,
      callId: inserted.id,
      callType: body.call_type,
    });

    res.json({
      id: inserted.id,
      provider: providerId,
      provider_room_id: room.providerRoomId,
      state: inserted.state,
    });
  } catch (err) {
    const reason = (err as any)?.message || 'unknown';
    try {
      const cfg: ServerConfig = (req as any).serverConfig;
      emitCallMetric(cfg, {
        metric: err instanceof CallProviderNotReadyError ? 'call.provider.not_ready' : 'call.create.failure',
        provider: err instanceof CallProviderNotReadyError ? err.providerId : null,
        reason: String(reason).slice(0, 120),
      });
    } catch { /* never break the response */ }
    return handleProviderError(res, err);
  }
});

// ─── POST /api/calls/:id/invite ───────────────────────────────────────────
const inviteSchema = z.object({
  participant_type: z.enum(['visitor', 'operator', 'admin', 'internal']),
  participant_id: z.string().uuid().nullable().optional(),
});
callsRouter.post('/:id/invite', async (req, res) => {
  const ctx = await loadSessionWithMembership(req, res, (req as any).serverConfig, req.params.id);
  if (!ctx) return;
  try {
    const body = inviteSchema.parse(req.body);
    const { error } = await ctx.sb.from('call_participants').insert({
      call_session_id: ctx.session.id,
      participant_type: body.participant_type,
      participant_id: body.participant_id ?? null,
    });
    if (error) return res.status(500).json({ error: error.message });
    await ctx.sb.from('call_sessions').update({ state: 'ringing' }).eq('id', ctx.session.id);
    await recordEvent(ctx.sb, ctx.session.id, 'invited', 'operator', ctx.userId, {
      participant_type: body.participant_type,
      participant_id: body.participant_id ?? null,
    });

    // ── Visitor invite → push call:incoming envelope to the widget ──────
    // Fire-and-forget: the route always returns ok:true so the operator UI
    // never stalls on a transport hiccup. The widget's polling fallback
    // (GET /api/widget/calls/:id/state) covers cases where realtime is
    // disabled or briefly down.
    if (
      body.participant_type === 'visitor' &&
      ctx.session.context_type === 'conversation' &&
      ctx.session.context_id
    ) {
      void emitVisitorIncomingEnvelope(
        (req as any).serverConfig,
        ctx.sb,
        ctx.session,
        ctx.userId,
      ).catch((err) => {
        console.warn('[calls] incoming envelope publish failed:', err?.message || err);
      });
    }

    res.json({ ok: true });
  } catch (err) {
    return handleProviderError(res, err);
  }
});

// ─── POST /api/calls/:id/accept ───────────────────────────────────────────
callsRouter.post('/:id/accept', async (req, res) => {
  const ctx = await loadSessionWithMembership(req, res, (req as any).serverConfig, req.params.id);
  if (!ctx) return;
  await ctx.sb
    .from('call_sessions')
    .update({ state: 'connecting', started_at: new Date().toISOString() })
    .eq('id', ctx.session.id);
  await recordEvent(ctx.sb, ctx.session.id, 'accepted', 'operator', ctx.userId);
  // Phase 8D — operator becomes busy automatically.
  void markInCall((req as any).serverConfig, ctx.session.workspace_id, ctx.userId, ctx.session.id)
    .catch(() => {/* never block accept on availability bookkeeping */});
  res.json({ ok: true });
});

// ─── POST /api/calls/:id/reject ───────────────────────────────────────────
callsRouter.post('/:id/reject', async (req, res) => {
  const ctx = await loadSessionWithMembership(req, res, (req as any).serverConfig, req.params.id);
  if (!ctx) return;
  await ctx.sb
    .from('call_sessions')
    .update({ state: 'ended', ended_at: new Date().toISOString() })
    .eq('id', ctx.session.id);
  await recordEvent(ctx.sb, ctx.session.id, 'rejected', 'operator', ctx.userId);
  res.json({ ok: true });
});

// ─── POST /api/calls/:id/hangup ───────────────────────────────────────────
callsRouter.post('/:id/hangup', async (req, res) => {
  const ctx = await loadSessionWithMembership(req, res, (req as any).serverConfig, req.params.id);
  if (!ctx) return;
  try {
    if (ctx.session.provider_room_id) {
      const provider = resolveCallProvider(ctx.session.provider);
      try { await provider.closeRoom((req as any).serverConfig, ctx.session.provider_room_id); } catch { /* idempotent */ }
    }
    const startedAt = ctx.session.started_at ? new Date(ctx.session.started_at).getTime() : null;
    const duration = startedAt ? Math.round((Date.now() - startedAt) / 1000) : null;
    await ctx.sb
      .from('call_sessions')
      .update({ state: 'ended', ended_at: new Date().toISOString(), duration_seconds: duration })
      .eq('id', ctx.session.id);
    await recordEvent(ctx.sb, ctx.session.id, 'hangup', 'operator', ctx.userId);
    // Phase 8D — release the operator's busy lock.
    void clearInCall((req as any).serverConfig, ctx.session.workspace_id, ctx.userId)
      .catch(() => {/* never block hangup */});
    res.json({ ok: true });
  } catch (err) {
    return handleProviderError(res, err);
  }
});

// ─── POST /api/calls/:id/token ────────────────────────────────────────────
const tokenSchema = z.object({
  participant_type: z.enum(['visitor', 'operator', 'admin', 'internal']).default('operator'),
  participant_id: z.string().uuid().optional(),
  display_name: z.string().max(100).optional(),
  ttl_seconds: z.number().int().min(60).max(3600).optional(),
});
callsRouter.post('/:id/token', async (req, res) => {
  const ctx = await loadSessionWithMembership(req, res, (req as any).serverConfig, req.params.id);
  if (!ctx) return;
  const t0 = Date.now();
  try {
    const body = tokenSchema.parse(req.body ?? {});
    if (!ctx.session.provider_room_id) {
      return res.status(409).json(
        callErrorBody(
          CALL_ERROR_CODES.ROOM_CREATE_FAILED,
          'Provider room is not ready for this call session.',
          { provider: ctx.session.provider },
        ),
      );
    }
    const provider = resolveCallProvider(ctx.session.provider);
    let token;
    try {
      token = await provider.createParticipantToken((req as any).serverConfig, {
        callSessionId: ctx.session.id,
        providerRoomId: ctx.session.provider_room_id,
        participantId: body.participant_id ?? ctx.userId,
        participantType: body.participant_type,
        displayName: body.display_name,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        ttlSeconds: body.ttl_seconds,
      });
    } catch (mintErr) {
      const mapped = callErrorFromUnknown(mintErr, {
        code: CALL_ERROR_CODES.TOKEN_MINT_FAILED,
        message: 'Failed to mint participant token.',
        provider: ctx.session.provider,
      });
      try {
        emitCallMetric((req as any).serverConfig, {
          metric: 'call.token.failure',
          workspaceId: ctx.session.workspace_id,
          provider: ctx.session.provider,
          callId: ctx.session.id,
          reason: mapped.body.error,
        });
      } catch { /* */ }
      return res.status(mapped.status).json(mapped.body);
    }
    const config: ServerConfig = (req as any).serverConfig;
    const { network, turn } = await buildTokenNetworkBundle(
      config,
      ctx.session.id,
      body.ttl_seconds ?? 600,
    );
    if (turn.urls.length === 0) {
      emitCallMetric(config, {
        metric: 'call.turn.missing',
        workspaceId: ctx.session.workspace_id,
        provider: ctx.session.provider,
        callId: ctx.session.id,
      });
    }

    emitCallMetric(config, {
      metric: 'call.token.success',
      workspaceId: ctx.session.workspace_id,
      provider: ctx.session.provider,
      callId: ctx.session.id,
    });
    emitCallMetric(config, {
      metric: 'call.setup.latency',
      workspaceId: ctx.session.workspace_id,
      provider: ctx.session.provider,
      callId: ctx.session.id,
      value: Date.now() - t0,
    });

    res.json({
      token: token.token,
      expires_at: token.expiresAt,
      provider: ctx.session.provider,
      rtc_url: network.rtc_url,
      ws_url: network.ws_url,
      turn: {
        urls: turn.urls,
        username: turn.username,
        credential: turn.credential,
      },
      ice_policy: network.ice_policy,
      network,
      // Pass 1 — surface non-fatal warnings the widget can show as a hint
      // before the LiveKit SDK actually tries to connect.
      warnings: [
        ...(turn.urls.length === 0 ? [CALL_ERROR_CODES.TURN_MISSING] : []),
      ],
    });
  } catch (err) {
    try {
      emitCallMetric((req as any).serverConfig, {
        metric: 'call.token.failure',
        workspaceId: ctx.session.workspace_id,
        provider: ctx.session.provider,
        callId: ctx.session.id,
        reason: String((err as any)?.message || 'unknown').slice(0, 120),
      });
    } catch { /* */ }
    return handleProviderError(res, err);
  }
});

// ─── GET /api/calls/:id/state ─────────────────────────────────────────────
callsRouter.get('/:id/state', async (req, res) => {
  const ctx = await loadSessionWithMembership(req, res, (req as any).serverConfig, req.params.id);
  if (!ctx) return;
  try {
    let providerState = null;
    if (ctx.session.provider_room_id) {
      try {
        const provider = resolveCallProvider(ctx.session.provider);
        providerState = await provider.getRoomState((req as any).serverConfig, ctx.session.provider_room_id);
      } catch {
        providerState = null;
      }
    }
    const { data: participants } = await ctx.sb
      .from('call_participants').select('*').eq('call_session_id', ctx.session.id);
    res.json({ session: ctx.session, participants: participants ?? [], provider_state: providerState });
  } catch (err) {
    return handleProviderError(res, err);
  }
});

// ─── POST /api/calls/:id/recording/start ──────────────────────────────────
callsRouter.post('/:id/recording/start', async (req, res) => {
  const ctx = await loadSessionWithMembership(req, res, (req as any).serverConfig, req.params.id);
  if (!ctx) return;
  try {
    const overrides = await loadWorkspaceCallOverrides((req as any).serverConfig, ctx.session.workspace_id);
    if (!overrides.allow_recording) {
      return res.status(409).json({ error: 'recording_disabled_for_workspace' });
    }
    if (!ctx.session.provider_room_id) return res.status(409).json({ error: 'room_not_ready' });
    const provider = resolveCallProvider(ctx.session.provider);
    if (!provider.supportsRecording()) {
      return res.status(409).json({ error: 'provider_no_recording' });
    }
    const cp = await loadCallControlPlane((req as any).serverConfig);
    const handle = await provider.startRecording((req as any).serverConfig, ctx.session.provider_room_id, {
      recordingType: cp.recording_default_type,
    });
    await ctx.sb.from('call_sessions').update({ recording_enabled: true, recording_state: 'recording' })
      .eq('id', ctx.session.id);
    await recordEvent(ctx.sb, ctx.session.id, 'recording_start', 'operator', ctx.userId, { recording_id: handle.recordingId });
    emitCallMetric((req as any).serverConfig, {
      metric: 'call.recording.start.success',
      workspaceId: ctx.session.workspace_id,
      provider: ctx.session.provider,
      callId: ctx.session.id,
    });
    res.json({ recording_id: handle.recordingId, status: handle.status });
  } catch (err) {
    try {
      emitCallMetric((req as any).serverConfig, {
        metric: 'call.recording.start.failure',
        workspaceId: ctx.session.workspace_id,
        provider: ctx.session.provider,
        callId: ctx.session.id,
        reason: String((err as any)?.message || 'unknown').slice(0, 120),
      });
    } catch { /* */ }
    return handleProviderError(res, err);
  }
});

// ─── POST /api/calls/:id/recording/stop ───────────────────────────────────
const stopSchema = z.object({ recording_id: z.string().min(1) });
callsRouter.post('/:id/recording/stop', async (req, res) => {
  const ctx = await loadSessionWithMembership(req, res, (req as any).serverConfig, req.params.id);
  if (!ctx) return;
  try {
    const body = stopSchema.parse(req.body);
    const provider = resolveCallProvider(ctx.session.provider);
    const handle = await provider.stopRecording((req as any).serverConfig, body.recording_id);
    await ctx.sb.from('call_sessions').update({ recording_state: 'finalizing' })
      .eq('id', ctx.session.id);
    await recordEvent(ctx.sb, ctx.session.id, 'recording_stop', 'operator', ctx.userId, { recording_id: body.recording_id });
    emitCallMetric((req as any).serverConfig, {
      metric: 'call.recording.stop.success',
      workspaceId: ctx.session.workspace_id,
      provider: ctx.session.provider,
      callId: ctx.session.id,
    });
    res.json({ recording_id: handle.recordingId, status: handle.status });
  } catch (err) {
    try {
      emitCallMetric((req as any).serverConfig, {
        metric: 'call.recording.stop.failure',
        workspaceId: ctx.session.workspace_id,
        provider: ctx.session.provider,
        callId: ctx.session.id,
        reason: String((err as any)?.message || 'unknown').slice(0, 120),
      });
    } catch { /* */ }
    return handleProviderError(res, err);
  }
});