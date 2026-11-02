/**
 * A participant's join token for a call's provider room, and everything the
 * client needs to reach that room with it: one answer for every route that
 * hands a member a token.
 *
 * It used to live inside `POST /api/calls/:id/token`. Colleague calls
 * (`POST /api/team-calls/:id/token`, docs/operations/TEAM_CALLS.md) answer in
 * the same shape, because the apps join both kinds of call with the same code
 * (`callToken` on iOS, `CallSession` on Android): a second copy of this would
 * drift the first time one of them learnt about a new relay rule.
 *
 * What the caller decides and this does not: who the participant is and what
 * the room may call them. The routes resolve that from the session (a member's
 * own profile name, never one a client asks for), and the provider turns a
 * member into the opaque `<type>:<ref>` identity (operatorIdentity.ts), so no
 * user id reaches the room either way.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getCallNetworkBundle } from './rtcResolver.js';
import { mintTurnCreds } from './turnAuth.js';
import { resolveCallProvider } from './providerResolver.js';
import { loadLiveKitConfig, providesOwnRelay } from './livekitConfig.js';
import { emitCallMetric } from './metrics.js';
import { CALL_ERROR_CODES, callErrorBody, callErrorFromUnknown } from './errorCodes.js';
import type { CallProviderId } from './providers/types.js';
import type { ParticipantType } from './operatorIdentity.js';

/**
 * Build the network bundle for a token response, including dynamically-minted
 * RFC 7635-style TURN credentials when a static_secret is present. Shared by
 * the token endpoints and the /invite envelope so visitors and operators see
 * an identical TURN/ICE shape. URLs always come from the resolver — no
 * hardcoded hostnames.
 */
export async function buildTokenNetworkBundle(
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
      const rtcValue = rtcRow?.value as Record<string, unknown> | undefined;
      const sharedSecret = (rtcValue?.turn as Record<string, unknown> | undefined)?.shared_secret;
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

/** The call row columns a token needs. */
export interface TokenCallSession {
  id: string;
  workspace_id: string;
  provider: CallProviderId;
  provider_room_id: string | null;
}

export interface ParticipantTokenRequest {
  participantType: ParticipantType;
  /** A member's user id (the provider makes it opaque), or a visitor's id. */
  participantId: string;
  /** What the room shows; for a member, their own profile name or empty. */
  displayName: string | undefined;
  ttlSeconds?: number;
}

/** An HTTP answer, ready for `res.status(status).json(body)`. */
export interface ParticipantTokenAnswer {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Mints the token and assembles the answer: `token`, `expires_at`,
 * `provider`, `rtc_url`, `ws_url`, `turn`, `ice_policy`, `network` and
 * `warnings` (`turn_missing` when there is no relay on either side).
 *
 * A room that is not ready or a mint the provider refuses is an answer too
 * (409 / 5xx with the canonical call error body), never a throw. What can
 * still throw is the provider registry itself (an unknown provider, a provider
 * that is not ready) — the routes answer that with their own provider-error
 * handler, as they always have.
 */
export async function issueParticipantToken(
  config: ServerConfig,
  session: TokenCallSession,
  request: ParticipantTokenRequest,
): Promise<ParticipantTokenAnswer> {
  const t0 = Date.now();
  if (!session.provider_room_id) {
    return {
      status: 409,
      body: callErrorBody(
        CALL_ERROR_CODES.ROOM_CREATE_FAILED,
        'Provider room is not ready for this call session.',
        { provider: session.provider },
      ) as unknown as Record<string, unknown>,
    };
  }
  const provider = resolveCallProvider(session.provider);
  let token;
  try {
    token = await provider.createParticipantToken(config, {
      callSessionId: session.id,
      providerRoomId: session.provider_room_id,
      participantId: request.participantId,
      participantType: request.participantType,
      displayName: request.displayName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      ttlSeconds: request.ttlSeconds,
    });
  } catch (mintErr) {
    const mapped = callErrorFromUnknown(mintErr, {
      code: CALL_ERROR_CODES.TOKEN_MINT_FAILED,
      message: 'Failed to mint participant token.',
      provider: session.provider,
    });
    try {
      emitCallMetric(config, {
        metric: 'call.token.failure',
        workspaceId: session.workspace_id,
        provider: session.provider,
        callId: session.id,
        reason: mapped.body.error,
      });
    } catch { /* */ }
    return { status: mapped.status, body: mapped.body as unknown as Record<string, unknown> };
  }
  const { network, turn } = await buildTokenNetworkBundle(
    config,
    session.id,
    request.ttlSeconds ?? 600,
  );
  // A relay can come from either side. LiveKit's built-in TURN mints its
  // own per-participant credentials and delivers them over signalling, so
  // a deployment with it switched on has a relay even though this response
  // carries no TURN of its own — and must not be told otherwise. It also
  // must not be handed one here: an ICE server pointing at LiveKit's TURN
  // without credentials is a broken route, not a spare one.
  const relayMissing =
    turn.urls.length === 0 &&
    !(
      session.provider === 'livekit' &&
      providesOwnRelay(await loadLiveKitConfig(config))
    );
  if (relayMissing) {
    emitCallMetric(config, {
      metric: 'call.turn.missing',
      workspaceId: session.workspace_id,
      provider: session.provider,
      callId: session.id,
    });
  }

  emitCallMetric(config, {
    metric: 'call.token.success',
    workspaceId: session.workspace_id,
    provider: session.provider,
    callId: session.id,
  });
  emitCallMetric(config, {
    metric: 'call.setup.latency',
    workspaceId: session.workspace_id,
    provider: session.provider,
    callId: session.id,
    value: Date.now() - t0,
  });

  return {
    status: 200,
    body: {
      token: token.token,
      expires_at: token.expiresAt,
      provider: session.provider,
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
        ...(relayMissing ? [CALL_ERROR_CODES.TURN_MISSING] : []),
      ],
    },
  };
}
