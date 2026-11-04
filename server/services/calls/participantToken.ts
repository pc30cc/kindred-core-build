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
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import type { ServerConfig } from '../../config.js';
import { getClientCountry } from '../../utils/clientIp.js';
import {
  getCallNetworkBundle,
  getTurnSharedSecret,
  type CallRtcConfig,
  type CallTurnConfig,
} from './rtcResolver.js';
import { mintTurnCreds } from './turnAuth.js';
import { resolveCallProvider } from './providerResolver.js';
import { loadLiveKitConfig, providesOwnRelay } from './livekitConfig.js';
import { emitCallMetric } from './metrics.js';
import { CALL_ERROR_CODES, callErrorBody, callErrorFromUnknown } from './errorCodes.js';
import type { CallProviderId } from './providers/types.js';
import type { ParticipantType } from './operatorIdentity.js';

/** The stored relay names the countries it is for: a list, without `*`. */
function limitedToCountries(countries: readonly string[] | undefined): boolean {
  return Array.isArray(countries) && countries.length > 0 && !countries.includes('*');
}

/**
 * Whether this caller is one the relay is for. An empty list or `*` is
 * everyone (every row written before the list existed). Otherwise the
 * caller's country as Cloudflare saw it (server/utils/clientIp.ts believes
 * the header only from a Cloudflare hop), and an unknown country, or no
 * request at all, is not on any list.
 */
function relayServesCaller(countries: readonly string[] | undefined, req: Request | null | undefined): boolean {
  if (!limitedToCountries(countries)) return true;
  const country = req ? getClientCountry(req) : null;
  return country !== null && countries.includes(country);
}

/** The relay withheld: the client then keeps LiveKit's own ICE servers, its TURN among them. */
function withoutRelay(turn: CallTurnConfig): CallTurnConfig {
  return { ...turn, urls: [], username: null, credential: null, static_secret_present: false };
}

/**
 * The `turn` a client is handed: the fields a token carried before the relay
 * settings existed, in the same order. The country list and the lifetime are
 * the server's own settings: no client reads them, the list would tell a
 * caller who the relay is for, and leaving them out keeps every token answer
 * of a deployment without a relay (RESPOK) exactly what it was.
 */
export type ClientTurnConfig = Pick<
  CallTurnConfig,
  'urls' | 'username' | 'credential' | 'credential_type' | 'static_secret_present'
>;

function clientTurn(turn: CallTurnConfig): ClientTurnConfig {
  return {
    urls: turn.urls,
    username: turn.username,
    credential: turn.credential,
    credential_type: turn.credential_type,
    static_secret_present: turn.static_secret_present,
  };
}

export interface TokenNetworkBundle {
  /** The resolver's bundle, with `turn` replaced by what this caller got. */
  network: Omit<CallRtcConfig, 'turn'> & { turn: ClientTurnConfig };
  turn: ClientTurnConfig;
  /**
   * A relay is stored but this caller is not handed it (outside its
   * countries, or no credentials to give). The caller is then on LiveKit's
   * own TURN, which is what decides whether a `turn_missing` is true.
   */
  withheld: boolean;
  /**
   * The stored relay names the countries it is for (a list without `*`).
   * The call centre's two answers (the call widget's join token, the
   * operator's accept) carry a relay only then. They had none before the
   * list existed, and their callers are anywhere: a row without a list
   * (WebYar's until the list is first saved) or one meant for everyone
   * would take LiveKit's own TURN, its TLS port among it, away from all of
   * them for a UDP relay that only some of them need.
   */
  countryLimited: boolean;
}

/**
 * Build the network bundle for a token response, including dynamically-minted
 * RFC 7635-style TURN credentials when a shared secret is stored. Shared by
 * the token endpoints and the /invite envelope so visitors and operators see
 * an identical TURN/ICE shape. URLs always come from the resolver — no
 * hardcoded hostnames.
 *
 * What a client does with `turn` decides who may get it: every client hands
 * a non-empty `turn.urls` to LiveKit as its ICE servers, which REPLACES the
 * servers LiveKit offers (its own TURN included), and leaves them alone for
 * an empty list. So the relay goes only to the callers its country list
 * names, everyone else gets no URLs, and `network.turn` is always what the
 * caller got: a client reading either sees the same thing.
 *
 * `req` is the caller's request, for the country; without it a relay limited
 * to some countries is withheld. `callSessionId` and `ttlSeconds` no longer
 * shape the credentials (see below); they stay for the routes that pass them.
 */
export async function buildTokenNetworkBundle(
  config: ServerConfig,
  callSessionId: string,
  ttlSeconds: number,
  req?: Request | null,
): Promise<TokenNetworkBundle> {
  const network = await getCallNetworkBundle(config);
  let turn: CallTurnConfig = { ...network.turn };
  if (turn.urls.length > 0 && !relayServesCaller(turn.countries, req)) turn = withoutRelay(turn);
  if (turn.urls.length > 0 && turn.static_secret_present) {
    try {
      const sharedSecret = await getTurnSharedSecret(config);
      if (sharedSecret) {
        // The username is all the relay logs and all a packet capture shows,
        // so it names nothing: not the call, not the member. Its lifetime is
        // the relay setting's, not the LiveKit token's: clients keep these
        // credentials for the whole call and reuse them on every reconnect.
        const minted = mintTurnCreds({
          sharedSecret,
          identity: 'r' + randomBytes(8).toString('hex'),
          ttlSeconds: turn.credential_ttl_seconds,
        });
        turn.username = minted.username;
        turn.credential = minted.credential;
        turn.credential_type = 'password';
      }
    } catch {
      /* fall back to static creds */
    }
  }
  // A turn: URL nobody can sign in to is not a spare route: the browser
  // refuses it while building the peer connection and the call never starts
  // (assertUsableTurn). It is what a stored secret that cannot be read (the
  // master key missing or changed) would hand out, so the relay is withheld
  // instead and LiveKit's own TURN stays in place.
  if (
    turn.urls.some((u) => /^turns?:/i.test(u)) &&
    !(typeof turn.username === 'string' && turn.username.length > 0 &&
      typeof turn.credential === 'string' && turn.credential.length > 0)
  ) {
    turn = withoutRelay(turn);
  }
  const handed = clientTurn(turn);
  return {
    network: { ...network, turn: handed },
    turn: handed,
    withheld: network.turn.urls.length > 0 && handed.urls.length === 0,
    countryLimited: limitedToCountries(network.turn.countries),
  };
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
  /** The caller's own request: its country decides whether the relay is in the answer. */
  req?: Request;
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
    request.req,
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
