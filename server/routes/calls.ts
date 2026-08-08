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
import { loadEffectiveCallEntitlements } from '../services/calls/entitlementComposer.js';
import {
  checkPlanConcurrencyCeiling,
  planConcurrencyDenialBody,
} from '../services/calls/concurrencyLimit.js';
import {
  checkPlanMonthlyMinutesCeiling,
  planMinutesDenialBody,
} from '../services/calls/monthlyMinutesLimit.js';
import { resolveConversationSessionId } from '../services/visitors/networkProfile.js';
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
import { endCallSession, type EndCallReason } from '../services/calls/endSession.js';

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

    // Phase: Operator Call Route Split + Selective Gating —
    // strict deny-on-create on the operator /create boundary. The handler
    // is mixed by call_type; we split branch-by-branch via the canonical
    // composer (audio → eff.voice_enabled, video → eff.video_enabled).
    // Cleanup/status/finalize/in-flight branches in this file
    // (accept/reject/hangup/end/token/state/recording stop) remain
    // intentionally ungated so existing calls can be drained after a
    // plan downgrade. Recording start retains its own composer gate.
    const eff = await loadEffectiveCallEntitlements(config, body.workspace_id);
    const callTypeAllowed =
      body.call_type === 'video' ? eff.video_enabled : eff.voice_enabled;
    if (!callTypeAllowed) {
      return res.status(403).json({
        error: 'plan_forbidden',
        capability: body.call_type === 'video' ? 'voice_video.video' : 'voice_video.voice',
        upgrade_required: true,
      });
    }

    // Phase: max_concurrent_calls — Dual-Knob Activation.
    // Workspace-wide plan ceiling. INDEPENDENT of the widget-scoped
    // platform-admin knob enforced inside server/routes/callWidget.ts —
    // both ceilings may apply; this is the plan-side one. Runs BEFORE
    // any provider resolution / DB insert so denial leaves no
    // half-created call_sessions row behind.
    const conc = await checkPlanConcurrencyCeiling(config, body.workspace_id);
    if (!conc.allowed) {
      return res.status(conc.reason === 'plan_limit_reached' ? 429 : 403).json(planConcurrencyDenialBody(conc));
    }

    // Phase: max_call_minutes_per_month — Final Activation.
    // Workspace-wide monthly billable-minutes ceiling. Same boundary
    // as the concurrency check above and the same denial discipline:
    // runs BEFORE any provider resolution / DB insert so denial
    // leaves no half-created call_sessions row behind. Single source
    // of truth is workspace_usage_counters.call_minutes_used, written
    // exclusively by the DB trigger tg_call_sessions_bill_minutes.
    const mins = await checkPlanMonthlyMinutesCeiling(config, body.workspace_id);
    if (!mins.allowed) {
      return res.status(mins.reason === 'plan_limit_reached' ? 429 : 403).json(planMinutesDenialBody(mins));
    }

    const { id: providerId, provider } = await resolveEffectiveCallProvider(
      config,
      body.workspace_id,
    );

    const sb = getServiceClient(config);
    // Canonical visitor-session link. Operator-initiated calls always start
    // from a conversation, so the exact session that produced that thread is
    // the same one Inbox/Visitors resolve — reuse that helper instead of
    // picking "the contact's newest session" here.
    const visitorSessionId =
      body.context_type === 'conversation' && body.context_id
        ? await resolveConversationSessionId(config, body.workspace_id, body.context_id)
        : null;
    const { data: inserted, error: insErr } = await sb
      .from('call_sessions')
      .insert({
        workspace_id: body.workspace_id,
        provider: providerId,
        call_type: body.call_type,
        context_type: body.context_type,
        context_id: body.context_id ?? null,
        visitor_session_id: visitorSessionId,
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
// Phase: /:id/invite Route-Shape Split + Selective Gating.
// The route was previously single-purpose in shape but mixed in semantics:
// the same handler served (a) genuinely new optional-participant adds and
// (b) reissue / recovery / re-ring against an already-allowed in-flight
// session. Per the deny-on-create / allow-on-continuity policy we split
// the handler by an explicit `reason` discriminator.
//
// Backward compatibility: callers that omit `reason` are treated as
// `'reissue'`. Rationale:
//   * `/api/calls/create` is the canonical deny-on-create boundary; an
//     existing call_session already passed plan gating at creation time.
//   * Re-inviting an existing participant on an in-flight session is
//     continuity behavior and MUST remain reachable after a downgrade.
//   * The only known internal caller (`callsApi.invite`) is migrated to
//     send `reason: 'new'` explicitly, so the legacy default does not
//     weaken gating for the known new-participant path.
const inviteSchema = z.object({
  participant_type: z.enum(['visitor', 'operator', 'admin', 'internal']),
  participant_id: z.string().uuid().nullable().optional(),
  reason: z.enum(['new', 'reissue']).optional(),
});
callsRouter.post('/:id/invite', async (req, res) => {
  const ctx = await loadSessionWithMembership(req, res, (req as any).serverConfig, req.params.id);
  if (!ctx) return;
  try {
    const body = inviteSchema.parse(req.body);
    // Compatibility default: missing `reason` → continuity-safe 'reissue'.
    const reason: 'new' | 'reissue' = body.reason ?? 'reissue';

    // Selective gating: ONLY the explicit new-participant branch consults
    // the canonical call entitlement composer. Reissue / recovery /
    // re-ring stays reachable so in-flight sessions are never stranded by
    // a plan downgrade. Mapping: session.call_type === 'video' →
    // eff.video_enabled, otherwise eff.voice_enabled. No new keys.
    if (reason === 'new') {
      const eff = await loadEffectiveCallEntitlements(
        (req as any).serverConfig,
        ctx.session.workspace_id,
      );
      const allowed =
        ctx.session.call_type === 'video' ? eff.video_enabled : eff.voice_enabled;
      if (!allowed) {
        return res.status(403).json({
          error: 'plan_forbidden',
          capability:
            ctx.session.call_type === 'video'
              ? 'voice_video.video'
              : 'voice_video.voice',
          upgrade_required: true,
        });
      }
    }

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
      reason,
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
  // Pass A — delegate to the centralized idempotent end helper. Existing
  // callers expecting `{ ok: true }` keep working; new callers can read
  // duration_seconds + ended_by from the same response shape returned by
  // /end below.
  const summary = await endCallSession((req as any).serverConfig, {
    callId: ctx.session.id,
    reason: 'operator_ended',
    endedBy: 'operator',
    endedByUserId: ctx.userId,
  });
  if (!summary.ok) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, ...summary });
});

// ─── POST /api/calls/:id/end ──────────────────────────────────────────────
// Pass A — Operator-side canonical end endpoint. Idempotent. Body is
// optional; default reason = 'operator_ended'. Returns the full ended
// summary so the client can render duration immediately without polling.
const endSchema = z.object({
  reason: z
    .enum(['operator_ended', 'visitor_ended', 'system_ended', 'failed'])
    .optional(),
});
callsRouter.post('/:id/end', async (req, res) => {
  const ctx = await loadSessionWithMembership(req, res, (req as any).serverConfig, req.params.id);
  if (!ctx) return;
  const parsed = endSchema.safeParse(req.body ?? {});
  const reason: EndCallReason = parsed.success && parsed.data.reason
    ? parsed.data.reason
    : 'operator_ended';
  // Operators may only attribute themselves or 'system_ended'/'failed'.
  const endedBy = reason === 'visitor_ended' ? 'visitor' :
    (reason === 'system_ended' || reason === 'failed') ? 'system' : 'operator';
  const summary = await endCallSession((req as any).serverConfig, {
    callId: ctx.session.id,
    reason,
    endedBy,
    endedByUserId: endedBy === 'operator' ? ctx.userId : null,
  });
  if (!summary.ok) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, ...summary });
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
    // Phase: Call Route Enforcement Expansion — strict deny-on-create.
    // Recording start is a pure new-action boundary; recording stop and
    // session read/cancel/end remain ungated so any in-flight recording
    // can still be finalized after a plan downgrade. Composes
    // voice_video ∧ call_recording ∧ runtime.recording_enabled via the
    // canonical composer.
    const eff = await loadEffectiveCallEntitlements(
      (req as any).serverConfig,
      ctx.session.workspace_id,
    );
    if (!eff.recording_enabled) {
      return res.status(403).json({
        error: 'plan_forbidden',
        capability: 'call_recording',
        upgrade_required: true,
      });
    }
    // Numeric ceilings — count + storage. Lifetime occupancy semantics;
    // -1 = unlimited. Enforced before any provider call.
    {
      const { checkEntitlementFromDB } = await import('../middleware/featureGating.js');
      const { resolveUsage } = await import('../services/billing/usageResolvers.js');
      const cfg = (req as any).serverConfig;
      const wsId = ctx.session.workspace_id;
      try {
        const countEnt = await checkEntitlementFromDB(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, wsId, 'max_call_recordings');
        if (countEnt.limit !== undefined && countEnt.limit !== -1) {
          const u = await resolveUsage(cfg, wsId, 'max_call_recordings');
          if (u.supported && u.value >= countEnt.limit) {
            return res.status(403).json({ error: 'recording_count_limit_reached', limit: countEnt.limit, used: u.value, upgrade_required: true });
          }
        }
        const sizeEnt = await checkEntitlementFromDB(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, wsId, 'max_call_recording_storage_mb');
        if (sizeEnt.limit !== undefined && sizeEnt.limit !== -1) {
          const u = await resolveUsage(cfg, wsId, 'max_call_recording_storage_mb');
          if (u.supported && u.value >= sizeEnt.limit) {
            return res.status(403).json({ error: 'recording_storage_limit_reached', limit_mb: sizeEnt.limit, used_mb: u.value, upgrade_required: true });
          }
        }
      } catch (e: any) {
        return res.status(403).json({ error: 'recording_disabled', message: `entitlement_check_failed:${String(e?.message || e)}` });
      }
    }
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

// ─── GET /api/calls/diagnostics ───────────────────────────────────────────
//
// Pass 1 — operator/admin readable end-to-end diagnostics for the call
// stack. Returns:
//   - selected provider order (workspace-scoped if workspace_id is given,
//     else global control-plane order)
//   - real LiveKit readiness from the cached probe (getLiveKitReadinessState)
//   - normalized rtc_url / ws_url
//   - turn presence + count (NEVER returns the credential)
//   - ice_policy
//   - livekitSdkUrl (manifest entry) + manifest source/version
//   - last LiveKit probe latency + error code (if any)
//
// Auth model: requires a valid Supabase user JWT. If `workspace_id` is
// passed via query string, we additionally enforce membership so a
// workspace-scoped diagnostic can't leak another workspace's provider
// override. Without `workspace_id` the response only reflects the global
// control plane state.
//
// Secrets are NEVER included. We only expose presence flags.
callsRouter.get('/diagnostics', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);

  // Verify the caller is at least a signed-in user.
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization' });
  }
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const workspaceId = (req.query.workspace_id as string | undefined)?.trim() || null;
  if (workspaceId) {
    const { data: isMember } = await sb.rpc('is_workspace_member', {
      _workspace_id: workspaceId,
      _user_id: user.id,
    });
    if (!isMember) {
      return res.status(403).json({ error: 'Not a workspace member' });
    }
  }

  // Selected provider order — global if no workspace, else workspace-scoped.
  const cp = await loadCallControlPlane(config);
  let providerOrder: string[] = [];
  let selectedProvider: string | null = null;
  if (workspaceId) {
    providerOrder = await resolveCallProviderOrder(config, workspaceId);
    selectedProvider = providerOrder[0] || null;
  } else {
    providerOrder = [cp.primary_provider];
    if (
      cp.fallback_policy === 'lenient' &&
      cp.secondary_provider !== 'disabled' &&
      !providerOrder.includes(cp.secondary_provider)
    ) {
      providerOrder.push(cp.secondary_provider);
    }
    providerOrder = providerOrder.filter((p) => p !== 'disabled');
    selectedProvider = providerOrder[0] || null;
  }

  // Network bundle (URLs from resolver) — strictly normalized for the
  // client. Never include credentials.
  const network = await getCallNetworkBundle(config);
  const wsNormalized = normalizeClientWsUrl(network.ws_url);

  // LiveKit real readiness — uses 30s cache so polling is cheap.
  let livekitReadiness: any = null;
  let livekitConfigured = false;
  try {
    const lk = await loadLiveKitConfig(config);
    livekitConfigured = isMinimallyConfigured(lk);
  } catch { livekitConfigured = false; }
  try {
    livekitReadiness = await getLiveKitReadinessState(config);
  } catch (err: any) {
    livekitReadiness = {
      ready: false,
      configured: livekitConfigured,
      errorCode: 'probe_failed',
      errorMessage: err?.message || 'Probe failed',
    };
  }

  // Manifest + SDK URL.
  const manifest = getManifestDiagnostics();
  const sdkAssetName = manifest.livekitSdk;
  const sdkUrlMissing = !sdkAssetName;

  // Aggregate config status without leaking secrets.
  const turnUrlsCount = network.turn?.urls?.length || 0;
  const turnMissing = turnUrlsCount === 0;

  // Surface canonical error codes the caller may want to react to.
  const errors: string[] = [];
  if (!cp.enabled) errors.push('calls_disabled');
  if (selectedProvider === 'livekit' && !livekitReadiness?.ready) {
    errors.push(CALL_ERROR_CODES.PROVIDER_NOT_READY);
  }
  if (turnMissing) errors.push(CALL_ERROR_CODES.TURN_MISSING);
  if (sdkUrlMissing) errors.push(CALL_ERROR_CODES.SDK_URL_MISSING);

  return res.json({
    workspace_id: workspaceId,
    control_plane: {
      enabled: cp.enabled,
      primary_provider: cp.primary_provider,
      secondary_provider: cp.secondary_provider,
      fallback_policy: cp.fallback_policy,
    },
    selected_provider: selectedProvider,
    provider_order: providerOrder,
    rtc_url: network.rtc_url,
    ws_url_raw: network.ws_url,
    ws_url_normalized: wsNormalized,
    ice_policy: network.ice_policy,
    region: network.region,
    turn: {
      urls_count: turnUrlsCount,
      present: !turnMissing,
      static_secret_present: !!network.turn?.static_secret_present,
      credential_type: network.turn?.credential_type ?? 'password',
    },
    livekit: {
      configured: livekitConfigured,
      ready: !!livekitReadiness?.ready,
      rtc_url: livekitReadiness?.rtcUrl ?? null,
      last_probe_at: livekitReadiness?.lastProbeAt
        ? new Date(livekitReadiness.lastProbeAt).toISOString()
        : null,
      latency_ms: livekitReadiness?.latencyMs ?? null,
      error_code: livekitReadiness?.errorCode ?? null,
      error_message: livekitReadiness?.errorMessage ?? null,
    },
    sdk: {
      livekit_sdk_url: sdkAssetName,
      manifest_source: manifest.source,
      manifest_loader_version: manifest.loaderVersion,
      manifest_is_fallback: manifest.isFallback,
      manifest_remote_status: manifest.remoteStatus,
    },
    errors,
  });
});