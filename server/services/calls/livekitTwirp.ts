/**
 * Phase 8B - Minimal LiveKit Twirp REST client.
 *
 * LiveKit's server APIs are exposed as Twirp endpoints under
 *   {host}/twirp/livekit.RoomService/{Method}
 *   {host}/twirp/livekit.Egress/{Method}
 *
 * Each call is a POST with JSON body, an `Authorization: Bearer <jwt>` header
 * signed with the project's API secret (the same algo used for participant
 * tokens, but with `video.roomAdmin: true` / `video.roomCreate: true`).
 *
 * We avoid the official livekit-server-sdk to keep the server lean (no extra
 * undici/jose deps) and to keep this file fully auditable.
 *
 * STRICT:
 *   - No hostnames are hardcoded. The base URL must come from the caller
 *     (which itself reads from getRtcBaseUrl() / livekit_config.rtc_url).
 *   - HTTP timeouts are bounded (10s) so a misconfigured LiveKit can never
 *     hang the call routes.
 *   - Twirp errors are surfaced as typed exceptions with the LiveKit code.
 */
import jwt from 'jsonwebtoken';

export interface LiveKitAdminTokenInput {
  apiKey: string;
  apiSecret: string;
  /** Optional room scope (omitted = global admin token). */
  room?: string;
  ttlSeconds?: number;
}

/**
 * Mint a server-side admin JWT used for Twirp REST calls. This is NOT a
 * participant token; it's never returned to clients.
 */
export function mintAdminToken(input: LiveKitAdminTokenInput): string {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(60, Math.min(input.ttlSeconds ?? 600, 3600));
  const payload: Record<string, unknown> = {
    iss: input.apiKey,
    sub: input.apiKey,
    iat: now,
    nbf: now,
    exp: now + ttl,
    video: {
      roomCreate: true,
      roomList: true,
      roomAdmin: true,
      ...(input.room ? { room: input.room } : {}),
    },
  };
  return jwt.sign(payload, input.apiSecret, { algorithm: 'HS256' });
}

export interface LiveKitParticipantTokenInput {
  apiKey: string;
  apiSecret: string;
  identity: string;
  name?: string;
  room: string;
  ttlSeconds?: number;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  metadata?: string;
}

/**
 * Mint a participant join token returned to the operator/widget client.
 * The client passes this to the LiveKit JS SDK at room.connect() time.
 */
export function mintParticipantToken(input: LiveKitParticipantTokenInput): {
  token: string;
  expiresAt: number;
} {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(60, Math.min(input.ttlSeconds ?? 600, 3600));
  const expSec = now + ttl;
  const payload: Record<string, unknown> = {
    iss: input.apiKey,
    sub: input.identity,
    iat: now,
    nbf: now,
    exp: expSec,
    name: input.name,
    metadata: input.metadata,
    video: {
      room: input.room,
      roomJoin: true,
      canPublish: input.canPublish !== false,
      canSubscribe: input.canSubscribe !== false,
      canPublishData: input.canPublishData !== false,
    },
  };
  const token = jwt.sign(payload, input.apiSecret, { algorithm: 'HS256' });
  return { token, expiresAt: expSec * 1000 };
}

export class LiveKitTwirpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'LiveKitTwirpError';
  }
}

interface TwirpCallOpts {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  service: 'livekit.RoomService' | 'livekit.Egress';
  method: string;
  body: Record<string, unknown>;
  /** Optional room scope for the admin token. */
  room?: string;
  timeoutMs?: number;
}

/**
 * Translate the SFU base URL (which is wss://... for LiveKit clients) into
 * the HTTPS URL used for Twirp REST. wss:// -> https://, ws:// -> http://.
 */
export function rtcUrlToHttp(rtcUrl: string): string {
  const trimmed = rtcUrl.replace(/\/+$/, '');
  if (trimmed.startsWith('wss://')) return 'https://' + trimmed.slice('wss://'.length);
  if (trimmed.startsWith('ws://')) return 'http://' + trimmed.slice('ws://'.length);
  return trimmed;
}

export async function twirp<T = unknown>(opts: TwirpCallOpts): Promise<T> {
  const adminToken = mintAdminToken({
    apiKey: opts.apiKey,
    apiSecret: opts.apiSecret,
    room: opts.room,
    ttlSeconds: 600,
  });
  const httpBase = rtcUrlToHttp(opts.baseUrl);
  const url = httpBase + '/twirp/' + opts.service + '/' + opts.method;
  const ctrl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + adminToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(opts.body || {}),
      signal: ctrl.signal,
    });
  } catch (err: unknown) {
    const isAbort = (err as { name?: string })?.name === 'AbortError';
    throw new LiveKitTwirpError(
      isAbort ? 'deadline_exceeded' : 'unavailable',
      isAbort ? 'LiveKit Twirp request timed out' : 'LiveKit Twirp request failed: ' + ((err as Error)?.message || 'unknown'),
      0,
    );
  } finally {
    clearTimeout(t);
  }

  const text = await res.text();
  if (!res.ok) {
    let code = 'unknown';
    let msg = text || 'LiveKit Twirp error';
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.code === 'string') code = parsed.code;
      if (typeof parsed?.msg === 'string') msg = parsed.msg;
    } catch {
      /* keep raw text */
    }
    throw new LiveKitTwirpError(code, msg, res.status);
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}
