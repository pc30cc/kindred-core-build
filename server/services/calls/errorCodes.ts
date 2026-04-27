/**
 * Pass 1 — Canonical server-side error codes for the call domain.
 *
 * Single source of truth for every error string surfaced to the widget,
 * operator UI, admin diagnostics, and probe responses. Keeping these in
 * one module guarantees:
 *
 *   - the widget can switch on a stable code (no "did the server reword
 *     the message?" drift)
 *   - admin diagnostics + probes always return the same vocabulary
 *   - a future UI translation layer only has to map ONE list
 *
 * STRICT: do not invent ad-hoc strings in routes — import from here.
 */

export const CALL_ERROR_CODES = {
  /** Resolver could not pick a ready provider. */
  PROVIDER_NOT_READY: 'provider_not_ready',
  /** Provider room create failed (LiveKit Twirp / equivalent). */
  ROOM_CREATE_FAILED: 'room_create_failed',
  /** Provider rejected token mint (bad creds, room missing, etc.). */
  TOKEN_MINT_FAILED: 'token_mint_failed',
  /** TURN urls list is empty — visitor will likely fail behind NAT. */
  TURN_MISSING: 'turn_missing',
  /** LiveKit JS SDK could not connect to ws_url. (Surfaced by widget UI; */
  /*  also returned in diagnostics when probe fails connect-time.) */
  LIVEKIT_CONNECT_FAILED: 'livekit_connect_failed',
  /** Origin not in the allow-list for this workspace. */
  ORIGIN_DENIED: 'origin_denied',
  /** Visitor doesn't own the conversation/invitation they're claiming. */
  INVITATION_ACCESS_DENIED: 'invitation_access_denied',
  /** Invitation past its TTL (server flips status='expired'). */
  INVITATION_EXPIRED: 'invitation_expired',
  /** Invitation already joined (visitor double-clicked or reload race). */
  INVITATION_ALREADY_JOINED: 'invitation_already_joined',
  /** Vendor SDK URL not in manifest — widget can't lazy-load LiveKit. */
  SDK_URL_MISSING: 'sdk_url_missing',
} as const;

export type CallErrorCode = typeof CALL_ERROR_CODES[keyof typeof CALL_ERROR_CODES];

/** Canonical HTTP status for each code. */
export const CALL_ERROR_HTTP_STATUS: Record<CallErrorCode, number> = {
  provider_not_ready: 503,
  room_create_failed: 502,
  token_mint_failed: 502,
  turn_missing: 503,
  livekit_connect_failed: 502,
  origin_denied: 403,
  invitation_access_denied: 403,
  invitation_expired: 410,
  invitation_already_joined: 409,
  sdk_url_missing: 503,
};

export interface CallErrorBody {
  error: CallErrorCode;
  message: string;
  /** Optional provider id (e.g. 'livekit') for diagnostics. */
  provider?: string | null;
  /** Optional debug details (NEVER include secrets). */
  details?: Record<string, unknown>;
}

export function callErrorBody(
  code: CallErrorCode,
  message: string,
  extra?: { provider?: string | null; details?: Record<string, unknown> },
): CallErrorBody {
  return {
    error: code,
    message,
    ...(extra?.provider !== undefined ? { provider: extra.provider } : {}),
    ...(extra?.details ? { details: extra.details } : {}),
  };
}

/**
 * Map an unknown thrown error into a canonical body. Use this in route
 * catch blocks so a single helper handles CallProviderNotReadyError +
 * generic provider failures uniformly.
 */
export function callErrorFromUnknown(
  err: unknown,
  fallback: { code: CallErrorCode; message: string; provider?: string | null },
): { status: number; body: CallErrorBody } {
  // CallProviderNotReadyError shape: { providerId, message, name }
  const anyErr = err as { providerId?: string; message?: string; name?: string };
  if (anyErr?.name === 'CallProviderNotReadyError') {
    return {
      status: CALL_ERROR_HTTP_STATUS.provider_not_ready,
      body: callErrorBody(
        CALL_ERROR_CODES.PROVIDER_NOT_READY,
        anyErr.message || 'Call provider is not ready.',
        { provider: anyErr.providerId ?? null },
      ),
    };
  }
  return {
    status: CALL_ERROR_HTTP_STATUS[fallback.code],
    body: callErrorBody(fallback.code, fallback.message, { provider: fallback.provider ?? null }),
  };
}