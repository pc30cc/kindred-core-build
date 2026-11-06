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
import { createHash } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { onInvalidate, publishCacheInvalidation } from '../../lib/cacheBus.js';
import {
  PLUGIN_SECRET_ALGORITHM,
  decryptPluginSecret,
  encryptPluginSecret,
  isPluginCryptoConfigured,
} from '../../lib/pluginCrypto.js';

const RUNTIME_KEY = 'call_rtc_endpoints';
const CACHE_TTL_MS = 15_000;

/**
 * How long minted relay credentials last when the row does not say.
 *
 * Not the LiveKit token's TTL: every client freezes its ICE servers for the
 * whole call and reuses them on each reconnect, and coturn refuses a new
 * allocation once the username's expiry has passed. A call that outlives its
 * credentials loses the relay at its first network change, which is exactly
 * when a phone in Iran needs it.
 */
export const TURN_CREDENTIAL_TTL_DEFAULT_SECONDS = 6 * 3600;
const TURN_CREDENTIAL_TTL_MIN_SECONDS = 600;
const TURN_CREDENTIAL_TTL_MAX_SECONDS = 24 * 3600;

export interface CallTurnConfig {
  /** Array of stun:/turn:/turns: URLs. Never empty when used. */
  urls: string[];
  username: string | null;
  credential: string | null;
  credential_type: 'password' | 'oauth';
  /**
   * True when a shared secret is stored to mint credentials from. Derived
   * on save, never taken from a client. This object goes to browsers and
   * into token bodies, so the secret itself (and its envelope) never
   * travels in it: getTurnSharedSecret reads it from the row when minting.
   */
  static_secret_present: boolean;
  /**
   * Who gets these URLs in their token: ISO 3166-1 alpha-2 codes, upper
   * case. Empty or `['*']` is everyone, as before the field existed.
   * Otherwise only a caller whose Cloudflare country is listed; everyone
   * else gets no URLs and keeps LiveKit's own TURN (a client that is handed
   * URLs replaces LiveKit's ICE servers with them).
   */
  countries: string[];
  /** Lifetime of minted relay credentials, 600..86400 s. */
  credential_ttl_seconds: number;
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
  turn: {
    urls: [],
    username: null,
    credential: null,
    credential_type: 'password',
    static_secret_present: false,
    countries: [],
    credential_ttl_seconds: TURN_CREDENTIAL_TTL_DEFAULT_SECONDS,
  },
  ice_policy: 'all',
  region: null,
  provider: null,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * The relay's country list as the gate reads it: trimmed, upper case, each
 * code once, and only two-letter codes or `*`. Anything else is dropped
 * rather than refused here: a hand-edited row must not take calls down, and
 * the admin route refuses a bad code before it gets this far.
 */
export function normalizeTurnCountries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const code = item.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code) && code !== '*') continue;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/** A credential lifetime inside 600..86400 s; anything unreadable is the default. */
export function clampTurnCredentialTtl(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return TURN_CREDENTIAL_TTL_DEFAULT_SECONDS;
  return Math.max(TURN_CREDENTIAL_TTL_MIN_SECONDS, Math.min(Math.round(n), TURN_CREDENTIAL_TTL_MAX_SECONDS));
}

/** The encrypted shared secret as stored: the email store's envelope fields. */
interface StoredTurnSecret {
  algorithm: string;
  key_version: number;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
}

function isStoredTurnSecret(value: unknown): value is StoredTurnSecret {
  const v = value as Partial<StoredTurnSecret> | null;
  return !!v && typeof v === 'object' && typeof v.algorithm === 'string' && typeof v.nonce === 'string'
    && typeof v.ciphertext === 'string' && typeof v.auth_tag === 'string';
}

/**
 * Whether a stored `turn` block holds a secret: the envelope, or the plain
 * text older rows carry (put there by hand before the field was encrypted).
 */
function holdsTurnSecret(turnRaw: Record<string, unknown>): boolean {
  return isStoredTurnSecret(turnRaw.shared_secret_enc)
    || (typeof turnRaw.shared_secret === 'string' && turnRaw.shared_secret.length > 0);
}

let cache: { value: CallRtcConfig; loadedAt: number } | null = null;

export function invalidateRtcCache(): void {
  cache = null;
}

// A save in any backend process (another replica, another cluster worker)
// reaches this one through the cache bus's 'calls' scope; 'calls:<ws>' is a
// workspace's own call settings and leaves this platform-wide cache alone.
onInvalidate('calls', (key) => { if (key === null) invalidateRtcCache(); });

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
    // The stored flag, read as it always was: every save works it out from
    // whether a secret is stored, and a token answer of a row no save has
    // touched since (RESPOK's) must stay what it was. A flag left on by hand
    // over no secret mints nothing, and Super Admin shows it as stored but
    // unreadable (no fingerprint), which a save of the secret puts right.
    static_secret_present: !!turnRaw.static_secret_present,
    countries: normalizeTurnCountries(turnRaw.countries),
    credential_ttl_seconds: clampTurnCredentialTtl(turnRaw.credential_ttl_seconds),
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

  const raw = (data?.value as { url?: unknown } | null | undefined)?.url;
  return typeof raw === 'string' ? stripTrailingSlash(raw) : null;
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

/**
 * An ICE server URL, which is not a URL in the everyday sense.
 *
 * RFC 7064/7065: a scheme, then host[:port], then at most `?transport=`.
 * No `//`, no path. `new URL()` accepts far more than this and browsers
 * accept far less, so the check is written out rather than delegated.
 */
const ICE_URL = /^(?:stun|stuns|turn|turns):[^\s/?#]+(?:\?transport=(?:udp|tcp))?$/i;

/**
 * Refuses a TURN block the browser will refuse.
 *
 * Both of these failures are total and silent until somebody places a call:
 * `RTCPeerConnection` throws while it is being CONSTRUCTED, so the widget
 * never reaches signalling and every call fails for every visitor — a far
 * worse outcome than the "no relay configured" warning that tempts an
 * operator to fill this in.
 *
 * It has happened: a hostname pasted here with no scheme took every call
 * down with `'turn.example.com' is not a valid URL`. The field took it
 * because the only rule was "not empty".
 */
export function assertUsableTurn(turn: Partial<CallTurnConfig> & { shared_secret?: unknown }): void {
  const urls = (turn.urls ?? []).map((u) => String(u).trim()).filter((u) => u.length > 0);

  const malformed = urls.filter((u) => !ICE_URL.test(u));
  if (malformed.length > 0) {
    throw new Error(
      `Not ICE server URLs: ${malformed.join(', ')}. Use turn:host:3478, ` +
        'turns:host:5349?transport=tcp or stun:host:3478 — a bare hostname is ' +
        'rejected by every browser and takes every call with it.',
    );
  }

  // A relay you cannot authenticate to is not a spare route. Chrome throws
  // `InvalidAccessError` on a turn: URL with no credentials, in the same
  // constructor and with the same blast radius.
  const needsCredentials = urls.some((u) => /^turns?:/i.test(u));
  const hasPair =
    typeof turn.username === 'string' && turn.username.length > 0 &&
    typeof turn.credential === 'string' && turn.credential.length > 0;
  const hasSecret = typeof turn.shared_secret === 'string' && turn.shared_secret.length > 0;
  if (needsCredentials && !hasPair && !hasSecret) {
    throw new Error(
      'A turn: URL needs a username and credential, or a shared secret to mint ' +
        'them from. Without either the browser refuses the ICE server and every ' +
        'call fails. LiveKit\'s own TURN issues its credentials over signalling ' +
        'and must NOT be listed here — record it as the LiveKit provider\'s TURN ' +
        'domain instead.',
    );
  }
}

/**
 * The stored row itself, uncached and unparsed. Throws when it cannot be
 * read: a save that went ahead over an unread row would write the defaults
 * over it, the relay's secret and the signalling URL included.
 */
async function readStoredRtcRow(config: ServerConfig): Promise<Record<string, unknown> | null> {
  const { data, error } = await getServiceClient(config)
    .from('app_runtime_config')
    .select('value')
    .eq('key', RUNTIME_KEY)
    .maybeSingle();
  if (error) throw new Error(`The call network settings could not be read: ${error.message}`);
  const value = (data as { value?: unknown } | null)?.value;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * The encrypted form of the secret, in the email store's envelope. The
 * envelope's own fingerprint (an unsalted hash) is left out, as it is there:
 * nothing reads it, and a dump of the row should not carry one.
 */
function sealTurnSecret(plaintext: string, masterKey: string | undefined): StoredTurnSecret {
  const { algorithm, key_version, nonce, ciphertext, auth_tag } = encryptPluginSecret(plaintext, masterKey);
  return { algorithm, key_version, nonce, ciphertext, auth_tag };
}

/**
 * The secret in a stored `turn` block: the envelope decrypted, else the
 * plain text an older row carries, else none. An envelope that cannot be
 * opened (PLUGIN_SECRETS_MASTER_KEY missing or changed) is none, never the
 * plain text beside it: the envelope is the one a save wrote last.
 */
function openTurnSecret(turnRaw: Record<string, unknown>, masterKey: string | undefined): string | null {
  const sealed = turnRaw.shared_secret_enc;
  if (isStoredTurnSecret(sealed)) {
    try {
      const plain = sealed.algorithm === PLUGIN_SECRET_ALGORITHM ? decryptPluginSecret(sealed, masterKey) : '';
      if (plain.length > 0) return plain;
    } catch { /* reported below */ }
    console.warn('[calls] the stored TURN shared secret cannot be decrypted (PLUGIN_SECRETS_MASTER_KEY missing or changed); relay credentials are not minted');
    return null;
  }
  const legacy = turnRaw.shared_secret;
  return typeof legacy === 'string' && legacy.length > 0 ? legacy : null;
}

/**
 * The relay's shared secret, for minting per-call credentials. Read from the
 * row every time, past the 15 s cache: the cached view goes to browsers and
 * into token bodies, so it never holds the secret. Null when there is none
 * or it cannot be read; never throws.
 */
export async function getTurnSharedSecret(config: ServerConfig): Promise<string | null> {
  try {
    const row = await readStoredRtcRow(config);
    return openTurnSecret(asRecord(row?.turn), config.pluginSecretsMasterKey);
  } catch (err) {
    console.warn('[calls] TURN shared secret lookup failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * What Super Admin shows for the stored secret: the first 12 hex digits of
 * its SHA-256, which the owner can compare with the relay's own file
 * (`printf %s "$(cat /etc/webyar-turn/secret)" | sha256sum`). Never the
 * secret. Null when there is none.
 */
export async function turnSecretFingerprint(config: ServerConfig): Promise<string | null> {
  return (await turnSecretStatus(config)).fingerprint;
}

/**
 * Super Admin's view of the secret in one read of the row: whether one is
 * stored at all (the envelope or an older row's plain text), and the
 * fingerprint of the one that can be read. Stored with no fingerprint is a
 * secret the server cannot decrypt. Never throws.
 */
export async function turnSecretStatus(config: ServerConfig): Promise<{ stored: boolean; fingerprint: string | null }> {
  try {
    const turnRaw = asRecord((await readStoredRtcRow(config))?.turn);
    const secret = openTurnSecret(turnRaw, config.pluginSecretsMasterKey);
    return {
      stored: holdsTurnSecret(turnRaw),
      fingerprint: secret ? createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12) : null,
    };
  } catch (err) {
    console.warn('[calls] TURN shared secret lookup failed:', err instanceof Error ? err.message : String(err));
    return { stored: false, fingerprint: null };
  }
}

/**
 * A save from Super Admin → Voice & Video → network. `turn.shared_secret` is
 * write-only: absent keeps the stored one, '' removes it, text replaces it.
 * `turn.static_secret_present` is accepted and ignored: the save works it
 * out from what is stored.
 */
export interface RtcEndpointsPatch extends Partial<Omit<CallRtcConfig, 'turn'>> {
  turn?: Partial<CallTurnConfig> & { shared_secret?: string };
}

export interface RtcEndpointsSaveResult {
  /** What the save changed, by path (`ws_url`, `turn.urls`, `turn.shared_secret`); never a value. */
  changed_fields: string[];
}

/**
 * Keys of the stored `turn` block a patch never writes as given: the flag is
 * derived, the secret goes through the rules below, and the admin view's own
 * presence fields are not part of the row.
 */
const TURN_KEYS_NOT_PATCHED = new Set([
  'static_secret_present',
  'shared_secret',
  'shared_secret_enc',
  'shared_secret_present',
  'shared_secret_fingerprint',
]);

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merges a patch onto the STORED row and writes it.
 *
 * The stored row, read uncached, not the parsed view: the view drops every
 * key it does not know and the secret's envelope, and writing it back would
 * erase both. So a turn-only patch leaves ws_url as it is, and a key a later
 * release adds survives a save from this one.
 *
 * The secret is never stored in clear from here: a typed one is encrypted
 * under PLUGIN_SECRETS_MASTER_KEY (refused without it), and a plain one an
 * older row carries is encrypted by the next save that can.
 */
export async function saveRtcEndpoints(
  config: ServerConfig,
  next: RtcEndpointsPatch,
): Promise<RtcEndpointsSaveResult> {
  const sb = getServiceClient(config);
  const stored = (await readStoredRtcRow(config)) ?? {};
  const storedTurn = asRecord(stored.turn);
  const masterKey = config.pluginSecretsMasterKey;

  const merged: Record<string, unknown> = { ...stored };
  for (const [field, value] of Object.entries(next ?? {})) {
    if (field === 'turn' || value === undefined) continue;
    merged[field] = value;
  }
  const patchTurn = asRecord(next?.turn);
  const turn: Record<string, unknown> = { ...storedTurn };
  for (const [field, value] of Object.entries(patchTurn)) {
    if (TURN_KEYS_NOT_PATCHED.has(field) || value === undefined) continue;
    turn[field] = value;
  }

  const typed = patchTurn.shared_secret;
  let secretTyped = false;
  let secretSealed = false;
  if (typeof typed === 'string' && typed === '') {
    secretTyped = holdsTurnSecret(storedTurn);
    delete turn.shared_secret_enc;
    delete turn.shared_secret;
  } else if (typeof typed === 'string') {
    if (!typed.trim()) throw new Error('The TURN shared secret is only spaces. Send an empty value to remove it.');
    if (!isPluginCryptoConfigured(masterKey)) throw new Error('TURN shared secret needs PLUGIN_SECRETS_MASTER_KEY');
    turn.shared_secret_enc = sealTurnSecret(typed, masterKey);
    delete turn.shared_secret;
    secretTyped = true;
  } else if (typeof turn.shared_secret === 'string' && turn.shared_secret.length > 0) {
    // Kept. An envelope already wins over the plain text on every read, so
    // the plain text goes; without one it is sealed now when the key is
    // there, and kept as it is when not (an unrelated save is no reason to
    // lose the relay).
    if (isStoredTurnSecret(turn.shared_secret_enc)) {
      delete turn.shared_secret;
      secretSealed = true;
    } else if (isPluginCryptoConfigured(masterKey)) {
      turn.shared_secret_enc = sealTurnSecret(turn.shared_secret, masterKey);
      delete turn.shared_secret;
      secretSealed = true;
    }
  }

  const secretStored = holdsTurnSecret(turn);
  turn.static_secret_present = secretStored;
  if ('countries' in turn) turn.countries = normalizeTurnCountries(turn.countries);
  if ('credential_ttl_seconds' in turn) turn.credential_ttl_seconds = clampTurnCredentialTtl(turn.credential_ttl_seconds);

  // Validated on the MERGED value, not the patch: credentials already stored
  // still count, and a patch that adds only a URL must be judged against what
  // the row will actually hold. It asks only whether there is a secret to
  // mint from, so a stored one is not decrypted for it.
  assertUsableTurn({
    urls: Array.isArray(turn.urls) ? (turn.urls as unknown[]).map((u) => String(u)) : [],
    username: typeof turn.username === 'string' ? turn.username : null,
    credential: typeof turn.credential === 'string' ? turn.credential : null,
    shared_secret: secretStored ? 'stored' : undefined,
  });

  const value: Record<string, unknown> = { ...merged, turn };
  const changed: string[] = [];
  for (const field of new Set([...Object.keys(stored), ...Object.keys(value)])) {
    if (field !== 'turn' && !sameValue(stored[field], value[field])) changed.push(field);
  }
  for (const field of new Set([...Object.keys(storedTurn), ...Object.keys(turn)])) {
    if (field === 'shared_secret' || field === 'shared_secret_enc') continue;
    if (!sameValue(storedTurn[field], turn[field])) changed.push(`turn.${field}`);
  }
  if (secretTyped) changed.push('turn.shared_secret');
  else if (secretSealed) changed.push('turn.shared_secret_encrypted');

  const { error } = await sb
    .from('app_runtime_config')
    .upsert(
      { key: RUNTIME_KEY, value, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) throw new Error(error.message);
  publishCacheInvalidation(['calls']);
  return { changed_fields: changed };
}
