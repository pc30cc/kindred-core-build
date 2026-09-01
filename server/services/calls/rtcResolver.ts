/**
 * Phase 8A — RTC / Call Domain & Network Resolver
 * ------------------------------------------------------------------
 * Single source of truth for every URL the call layer needs.
 *
 * STRICT RULES (non-negotiable):
 *   - NO hardcoded hostnames, schemes, ports, or origins.
 *   - All values resolve dynamically from:
 *       1. app_runtime_config.call_rtc_endpoints (admin-managed)
 *       2. platform_domains (canonical multi-tenant URLs)
 *       3. APP_BASE_URL / RTC_BASE_URL env (self-host fallback)
 *       4. The incoming request (last-resort fallback for app/api only)
 *
 * Returning `null` from any helper is preferred over guessing — callers
 * MUST surface a "RTC endpoint not configured" error in that case so an
 * operator can fix the admin config rather than silently degrading.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

const RUNTIME_KEY = 'call_rtc_endpoints';
const CACHE_TTL_MS = 15_000;

export interface CallTurnConfig {
  /** Array of stun:/turn:/turns: URLs. Never empty when used. */
  urls: string[];
  username: string | null;
  credential: string | null;
  credential_type: 'password' | 'oauth';
  /** True if admin configured a static shared secret (handled server-side). */
  static_secret_present: boolean;
}

export interface CallRtcConfig {
  /** WebRTC SFU base (e.g. LiveKit `wss://...`). Null when unconfigured. */
  rtc_url: string | null;
  /** Signaling WebSocket. Defaults to rtc_url for LiveKit. */
  ws_url: string | null;
  /** Optional separate egress / recording endpoint. */
  recording_url: string | null;
  turn: CallTurnConfig;
  ice_policy: 'all' | 'relay';
  region: string | null;
  /** Provider id selected by the resolver (informational; not a lock). */
  provider: string | null;
}

const SAFE_DEFAULT: CallRtcConfig = {
  rtc_url: null,
  ws_url: null,
  recording_url: null,
  turn: { urls: [], username: null, credential: null, credential_type: 'password', static_secret_present: false },
  ice_policy: 'all',
  region: null,
  provider: null,
};

let cache: { value: CallRtcConfig; loadedAt: number } | null = null;

export function invalidateRtcCache(): void {
  cache = null;
}

function stripTrailingSlash(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;
  return t.replace(/\/+$/, '');
}

/**
 * Pass 1 — Strict client WS URL normalization.
 *
 * LiveKit's JS SDK expects an origin-only `wss://host[:port]` URL when
 * calling `Room.connect()`. Operators frequently misconfigure the value as
 * `https://...` (wrong scheme), `wss://host/rtc` (path the SDK then
 * duplicates), or with a trailing slash. Past failures included the
 * client trying to connect to `wss://host/rtc/rtc` which immediately
 * disconnects with `CLIENT_REQUEST_LEAVE`.
 *
 * Rules:
 *   - http:// / https:// → ws:// / wss:// (preserve loopback http for dev)
 *   - strip any path segment (LiveKit appends its own internally)
 *   - strip trailing slashes / whitespace
 *   - keep host + port intact
 * Returns null if the input is empty / unparseable.
 */
export function normalizeClientWsUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  // Map http(s) to ws(s). Preserve plain ws/wss as-is.
  let protocol = parsed.protocol;
  if (protocol === 'http:') protocol = 'ws:';
  else if (protocol === 'https:') protocol = 'wss:';
  if (protocol !== 'ws:' && protocol !== 'wss:') return null;
  const host = parsed.host; // includes port
  if (!host) return null;
  // Origin-only: drop pathname / search / hash. LiveKit constructs its own
  // `/rtc` internally — including it here causes duplicated path bugs.
  return `${protocol}//${host}`;
}

/**
 * Pass 1 — Normalize the RTC base used by the LiveKit Twirp REST client.
 * Twirp uses HTTP(S), not WebSocket. We accept either scheme and map to
 * https://, dropping any path so the Twirp client appends its own
 * `/twirp/...` route deterministically.
 */
export function normalizeRtcBaseUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  let protocol = parsed.protocol;
  if (protocol === 'ws:') protocol = 'http:';
  else if (protocol === 'wss:') protocol = 'https:';
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  const host = parsed.host;
  if (!host) return null;
  return `${protocol}//${host}`;
}

/**
 * Read the raw RTC endpoint config from app_runtime_config. Never throws.
 */
async function loadRawRtcConfig(config: ServerConfig): Promise<CallRtcConfig> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.value;

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', RUNTIME_KEY)
    .maybeSingle();

  if (error || !data?.value) {
    cache = { value: { ...SAFE_DEFAULT }, loadedAt: Date.now() };
    return cache.value;
  }

  const raw = data.value as Record<string, unknown>;
  const turnRaw = (raw.turn ?? {}) as Record<string, unknown>;
  const turnUrlsRaw = Array.isArray(turnRaw.urls) ? (turnRaw.urls as unknown[]) : [];
  const turn: CallTurnConfig = {
    urls: turnUrlsRaw.filter((u): u is string => typeof u === 'string' && u.trim().length > 0),
    username: typeof turnRaw.username === 'string' ? turnRaw.username : null,
    credential: typeof turnRaw.credential === 'string' ? turnRaw.credential : null,
    credential_type:
      turnRaw.credential_type === 'oauth' ? 'oauth' : 'password',
    static_secret_present: !!turnRaw.static_secret_present,
  };

  const value: CallRtcConfig = {
    rtc_url: stripTrailingSlash(raw.rtc_url as string | null),
    ws_url: stripTrailingSlash(raw.ws_url as string | null),
    recording_url: stripTrailingSlash(raw.recording_url as string | null),
    turn,
    ice_policy: raw.ice_policy === 'relay' ? 'relay' : 'all',
    region: typeof raw.region === 'string' ? raw.region : null,
    provider: typeof raw.provider === 'string' ? raw.provider : null,
  };

  cache = { value, loadedAt: Date.now() };
  return value;
}

/**
 * Resolve the canonical app base URL. Mirrors the helper in routes/admin.ts
 * but lives in the calls layer so it never falls back to localhost — calls
 * MUST refuse to start without an explicitly configured base.
 */
export async function resolveAppBaseUrl(
  config: ServerConfig,
  req?: { headers?: Record<string, unknown>; protocol?: string },
): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('platform_domains')
    .select('app_base_url, api_base_url, public_base_url')
    .limit(1)
    .maybeSingle();

  const fromDb = stripTrailingSlash(data?.app_base_url ?? null);
  if (fromDb) return fromDb;

  const fromEnv = stripTrailingSlash(process.env.APP_BASE_URL ?? null);
  if (fromEnv) return fromEnv;

  const explicit = (config.corsOrigins || []).find((o) => o && o !== '*');
  const fromCors = stripTrailingSlash(explicit ?? null);
  if (fromCors) return fromCors;

  if (req?.headers) {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
    const host = (req.headers['x-forwarded-host'] as string) || (req.headers.host as string);
    if (proto && host) return `${proto}://${host}`;
  }
  return null;
}

/**
 * Derive the base URL of THIS api process from the incoming request.
 * Zero-config and always correct for the running deployment, so it survives
 * domain changes even when `platform_domains` still holds a stale value.
 */
export function requestBaseUrl(
  req?: { headers?: Record<string, unknown>; protocol?: string },
): string | null {
  if (!req?.headers) return null;
  const proto =
    String((req.headers['x-forwarded-proto'] as string) || req.protocol || 'https')
      .split(',')[0]
      .trim();
  const host = String(
    (req.headers['x-forwarded-host'] as string) || (req.headers.host as string) || '',
  )
    .split(',')[0]
    .trim();
  if (!proto || !host) return null;
  return stripTrailingSlash(`${proto}://${host}`);
}

/**
 * Resolve the canonical API base URL.
 * Order: platform_domains.api_base_url → API_BASE_URL env → app base.
 */
export async function resolveApiBaseUrl(
  config: ServerConfig,
  req?: { headers?: Record<string, unknown>; protocol?: string },
): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('platform_domains')
    .select('api_base_url')
    .limit(1)
    .maybeSingle();

  const fromDb = stripTrailingSlash(data?.api_base_url ?? null);
  if (fromDb) return fromDb;

  const fromEnv = stripTrailingSlash(process.env.API_BASE_URL ?? null);
  if (fromEnv) return fromEnv;

  return resolveAppBaseUrl(config, req);
}

/**
 * Resolve an API base URL that is guaranteed to actually serve this API.
 *
 * Used for machine-to-machine callbacks (signed media URLs fetched by the
 * channels worker / external providers). Prefers the live request origin —
 * the request demonstrably reached this process through it — and only then
 * falls back to configured values. This makes media delivery immune to a
 * stale or wrong `platform_domains.api_base_url` after a domain change.
 */
export async function resolveSelfApiBaseUrl(
  config: ServerConfig,
  req?: { headers?: Record<string, unknown>; protocol?: string },
): Promise<string | null> {
  return requestBaseUrl(req) ?? (await resolveApiBaseUrl(config, req));
}


/**
 * Resolve the public widget/marketing base URL.
 * Order: platform_domains.public_base_url → PUBLIC_BASE_URL env → app base.
 */
export async function resolvePublicBaseUrl(
  config: ServerConfig,
  req?: { headers?: Record<string, unknown>; protocol?: string },
): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('platform_domains')
    .select('public_base_url')
    .limit(1)
    .maybeSingle();

  const fromDb = stripTrailingSlash(data?.public_base_url ?? null);
  if (fromDb) return fromDb;

  const fromEnv = stripTrailingSlash(process.env.PUBLIC_BASE_URL ?? null);
  if (fromEnv) return fromEnv;

  return resolveAppBaseUrl(config, req);
}

/**
 * Resolve the realtime base URL (Centrifugo / Supabase realtime).
 * Reuses existing resolver patterns; falls back to env var. Never invents
 * a hostname.
 */
export async function resolveRealtimeBaseUrl(
  config: ServerConfig,
): Promise<string | null> {
  const fromEnv = stripTrailingSlash(process.env.REALTIME_BASE_URL ?? null);
  if (fromEnv) return fromEnv;

  // app_runtime_config.realtime_endpoint (optional) — admin override.
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', 'realtime_endpoint')
    .maybeSingle();

  const url =
    typeof (data?.value as any)?.url === 'string'
      ? stripTrailingSlash((data!.value as any).url)
      : null;
  return url;
}

/**
 * Resolve the RTC SFU base URL (WebRTC media server).
 * Order: app_runtime_config.call_rtc_endpoints.rtc_url → RTC_BASE_URL env.
 * Returns null when unconfigured — callers MUST refuse to issue tokens.
 */
export async function getRtcBaseUrl(config: ServerConfig): Promise<string | null> {
  const raw = await loadRawRtcConfig(config);
  if (raw.rtc_url) return raw.rtc_url;
  return stripTrailingSlash(process.env.RTC_BASE_URL ?? null);
}

/**
 * Resolve the RTC signaling WebSocket URL. Falls back to rtc_url for
 * providers (LiveKit) where signaling and media share the same wss.
 */
export async function getRtcWsUrl(config: ServerConfig): Promise<string | null> {
  const raw = await loadRawRtcConfig(config);
  if (raw.ws_url) return raw.ws_url;
  if (raw.rtc_url) return raw.rtc_url;
  return stripTrailingSlash(process.env.RTC_WS_URL ?? null);
}

/**
 * Resolve the recording / egress base URL. Optional — providers that
 * embed recording in their main RTC node will return null here, which
 * is fine.
 */
export async function getRecordingBaseUrl(config: ServerConfig): Promise<string | null> {
  const raw = await loadRawRtcConfig(config);
  if (raw.recording_url) return raw.recording_url;
  return stripTrailingSlash(process.env.RTC_RECORDING_URL ?? null);
}

/**
 * Resolve TURN/STUN config the client should use for WebRTC.
 * The credential is intentionally short-lived in production setups —
 * for now we return whatever the admin configured. Phase 8B will add
 * dynamic per-call TURN credential minting.
 */
export async function getTurnConfig(config: ServerConfig): Promise<CallTurnConfig> {
  const raw = await loadRawRtcConfig(config);
  return raw.turn;
}

/**
 * Bundle every endpoint a client needs to bootstrap a call.
 * Used by /api/calls/:id/token responses.
 */
export async function getCallNetworkBundle(config: ServerConfig): Promise<CallRtcConfig> {
  const raw = await loadRawRtcConfig(config);
  // Resolve the raw + env-fallback values first.
  const rtcRaw = raw.rtc_url ?? stripTrailingSlash(process.env.RTC_BASE_URL ?? null);
  const wsRaw = raw.ws_url ?? raw.rtc_url ?? stripTrailingSlash(process.env.RTC_WS_URL ?? null);
  // Pass 1 — strictly normalize the client-facing ws_url so the LiveKit
  // SDK never sees `https://...` or a duplicated `/rtc` path.
  const wsNormalized = normalizeClientWsUrl(wsRaw);
  return {
    ...raw,
    rtc_url: rtcRaw,
    // ws_url ALWAYS comes back normalized for the client. If normalization
    // fails (e.g. malformed URL), surface null so the caller can return a
    // clear `provider_not_ready` instead of handing the SDK a bad value.
    ws_url: wsNormalized,
    recording_url:
      raw.recording_url ?? stripTrailingSlash(process.env.RTC_RECORDING_URL ?? null),
  };
}

export async function saveRtcEndpoints(
  config: ServerConfig,
  next: Partial<CallRtcConfig>,
): Promise<void> {
  const sb = getServiceClient(config);
  const current = await loadRawRtcConfig(config);
  const merged: CallRtcConfig = { ...current, ...next, turn: { ...current.turn, ...(next.turn || {}) } };
  const { error } = await sb
    .from('app_runtime_config')
    .upsert(
      { key: RUNTIME_KEY, value: merged as any, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) throw new Error(error.message);
  invalidateRtcCache();
}