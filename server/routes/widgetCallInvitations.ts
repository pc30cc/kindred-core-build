/**
 * Phase 9 — Widget-side Call Invitation routes.
 *
 * Mounted under /api/widget/call-invitations. Inherits widget CORS from the
 * parent router and enforces its own widget token + origin.
 *
 *   POST /:id/join     visitor accepts a pending invitation. Mints a real
 *                      call_session via the existing provider stack and
 *                      returns the LiveKit token + TURN bundle so the widget
 *                      runtime-call module can connect immediately.
 *   POST /:id/decline  visitor declines a pending invitation; flips status
 *                      and patches the system card.
 *
 * Strict rules:
 *   - Workspace + conversation ownership are verified via the existing
 *     widget security helpers. We never trust workspace_id from the body.
 *   - Tokens are minted via the existing provider resolver — there is NO
 *     second media path here.
 */
import { Router, Request, Response } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  enforceWidgetToken,
  enforceOrigin,
  resolveWorkspaceId,
  verifyConversationOwnership,
  widgetRateLimit,
} from '../services/widget/security.js';
import {
  validateInvitationForJoin,
  declineInvitation,
  markInvitationJoined,
  getInvitationById,
} from '../services/calls/invitations.js';
import {
  resolveEffectiveCallProvider,
  resolveCallProvider,
} from '../services/calls/providerResolver.js';
import { getCallNetworkBundle } from '../services/calls/rtcResolver.js';
import { mintTurnCreds } from '../services/calls/turnAuth.js';
import { CallProviderNotReadyError } from '../services/calls/providers/types.js';
import {
  loadCallControlPlane,
  loadWorkspaceCallOverrides,
} from '../services/calls/controlPlane.js';

export const widgetCallInvitationsRouter = Router();

// Sub-router needs its own token + origin enforcement (the parent applies
// widgetSecurityCors before mounting, then enforceWidgetToken globally only
// AFTER sub-routers — same pattern as widgetIdentityRouter).
widgetCallInvitationsRouter.use(enforceWidgetToken);
widgetCallInvitationsRouter.use(enforceOrigin);

async function loadOwnedInvitation(
  config: ServerConfig,
  req: Request,
  res: Response,
): Promise<{ invitationId: string; workspaceId: string } | null> {
  const invitationId = req.params.id;
  const workspaceId = resolveWorkspaceId(req, res, req.body?.workspace_id);
  if (res.headersSent) return null;
  if (!workspaceId) {
    res.status(400).json({ error: 'workspace_id required' });
    return null;
  }

  const inv = await getInvitationById(config, invitationId);
  if (!inv) {
    res.status(404).json({ error: 'invitation_not_found' });
    return null;
  }
  if (inv.workspace_id !== workspaceId) {
    res.status(403).json({ error: 'workspace_mismatch' });
    return null;
  }

  // Visitor must own the conversation the invitation belongs to.
  const visitorId = (req.body?.visitor_id as string) || null;
  const sessionId = (req.body?.session_id as string) || null;
  const ownership = await verifyConversationOwnership(
    config,
    inv.conversation_id,
    workspaceId,
    visitorId,
    sessionId,
    req,
  );
  if (!ownership.valid) {
    res.status(403).json({ error: 'invitation_access_denied' });
    return null;
  }

  return { invitationId, workspaceId };
}

// ─── POST /:id/decline ──────────────────────────────────────────────────
widgetCallInvitationsRouter.post(
  '/:id/decline',
  widgetRateLimit('default'),
  async (req: Request, res: Response) => {
    const config = (req as any).serverConfig as ServerConfig;
    const owned = await loadOwnedInvitation(config, req, res);
    if (!owned) return;

    const result = await declineInvitation(config, owned.invitationId);
    if (!result.ok) {
      return res.status(409).json({ error: result.reason || 'decline_failed' });
    }
    return res.json({
      invitation: result.invitation,
      status: result.invitation?.status,
    });
  },
);

// ─── POST /:id/join ─────────────────────────────────────────────────────
//
// Validates that the invitation is still pending + not expired, then mints
// the actual call_session via the existing provider stack and returns the
// LiveKit bundle the widget runtime-call module needs to connect.
widgetCallInvitationsRouter.post(
  '/:id/join',
  widgetRateLimit('default'),
  async (req: Request, res: Response) => {
    const config = (req as any).serverConfig as ServerConfig;
    const owned = await loadOwnedInvitation(config, req, res);
    if (!owned) return;

    // Validate invitation lifecycle (also flips to 'expired' if past TTL).
    const v = await validateInvitationForJoin(config, owned.invitationId);
    if (!v.ok) {
      return res.status(409).json({ error: (v as { ok: false; reason: string }).reason });
    }
    const invitation = v.invitation;

    // Verify calls are enabled for this workspace + channel.
    try {
      const cp = await loadCallControlPlane(config);
      if (!cp.enabled) {
        return res.status(409).json({ error: 'calls_disabled' });
      }
      const overrides = await loadWorkspaceCallOverrides(config, invitation.workspace_id);
      if (invitation.channel === 'video' && !overrides.allow_video) {
        return res.status(409).json({ error: 'video_disabled_for_workspace' });
      }
      if (invitation.channel === 'audio' && !overrides.allow_voice) {
        return res.status(409).json({ error: 'voice_disabled_for_workspace' });
      }

      // Resolve the configured call provider for this workspace.
      const { id: providerId, provider } = await resolveEffectiveCallProvider(
        config,
        invitation.workspace_id,
      );

      const sb = getServiceClient(config);
      // Insert the active call_session. Provider remains the resolved one.
      const { data: inserted, error: insErr } = await sb
        .from('call_sessions')
        .insert({
          workspace_id: invitation.workspace_id,
          provider: providerId,
          call_type: invitation.channel,
          context_type: 'conversation',
          context_id: invitation.conversation_id,
          state: 'connecting',
          initiated_by: invitation.created_by_user_id,
          initiated_by_type: 'operator',
          recording_enabled: false,
          recording_state: 'disabled',
          metadata: { invitation_id: invitation.id },
          started_at: new Date().toISOString(),
        })
        .select('*')
        .single();
      if (insErr || !inserted) {
        console.warn('[widget-invitations/join] insert call_session failed:', insErr?.message);
        return res.status(500).json({ error: 'call_session_create_failed' });
      }

      // Provision the provider room.
      const room = await provider.createRoom(config, {
        workspaceId: invitation.workspace_id,
        callSessionId: inserted.id,
        callType: invitation.channel,
        maxParticipants: cp.max_participants,
        recordingEnabled: false,
      });
      await sb
        .from('call_sessions')
        .update({ provider_room_id: room.providerRoomId })
        .eq('id', inserted.id);

      // Resolve visitor identity for token (same shape as /visitor-token).
      let visitorIdentity = 'visitor:' + invitation.conversation_id;
      try {
        if (invitation.visitor_session_id) {
          const { data: vs } = await sb
            .from('visitor_sessions')
            .select('visitor_id')
            .eq('id', invitation.visitor_session_id)
            .maybeSingle();
          if ((vs as any)?.visitor_id) visitorIdentity = 'visitor:' + (vs as any).visitor_id;
        }
      } catch { /* fall through */ }

      // Mint the visitor participant token.
      const minted = await provider.createParticipantToken(config, {
        callSessionId: inserted.id,
        providerRoomId: room.providerRoomId,
        participantId: visitorIdentity,
        participantType: 'visitor',
        displayName: 'Visitor',
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        ttlSeconds: 600,
      });

      // Network bundle (URLs from resolver) + dynamic TURN creds.
      const network = await getCallNetworkBundle(config);
      const turn = { ...network.turn };
      if (turn.static_secret_present && turn.urls.length > 0) {
        try {
          const { data: rtcRow } = await sb
            .from('app_runtime_config')
            .select('value')
            .eq('key', 'call_rtc_endpoints')
            .maybeSingle();
          const sharedSecret = (rtcRow?.value as any)?.turn?.shared_secret;
          if (typeof sharedSecret === 'string' && sharedSecret.length > 0) {
            const m = mintTurnCreds({
              sharedSecret,
              identity: 'call:' + inserted.id,
              ttlSeconds: 600,
            });
            turn.username = m.username;
            turn.credential = m.credential;
          }
        } catch { /* fallback to static creds */ }
      }

      // Mark invitation joined + link to the new call_session. This also
      // patches the system card so other UIs see the terminal state.
      await markInvitationJoined(config, invitation.id, inserted.id);

      return res.json({
        invitation_id: invitation.id,
        call_id: inserted.id,
        call_type: invitation.channel,
        token: minted.token,
        expires_at: minted.expiresAt,
        ws_url: network.ws_url,
        rtc_url: network.rtc_url,
        turn: { urls: turn.urls, username: turn.username, credential: turn.credential },
        ice_policy: network.ice_policy,
      });
    } catch (err: any) {
      if (err instanceof CallProviderNotReadyError) {
        return res.status(503).json({
          error: 'call_provider_not_ready',
          provider: err.providerId,
          message: err.message,
        });
      }
      console.error('[widget-invitations/join] error:', err?.message || err);
      return res.status(500).json({ error: 'internal_error' });
    }
  },
);
