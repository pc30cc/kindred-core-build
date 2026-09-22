/**
 * Phase 8B — LiveKit credentials & runtime config store.
 *
 * STRICT:
 *   - Secrets (api_secret, webhook_secret, S3 keys) NEVER leave the server.
 *   - The admin UI receives only presence flags via toPublicView().
 *   - URLs are NOT hardcoded; admin-supplied values are persisted as-is, and
 *     the rtcResolver / call routes consume them through getRtcBaseUrl(),
 *     getRtcWsUrl(), getRecordingBaseUrl().
 *   - All loads go through a 30s in-process cache to keep the call
 *     create / token hot path off the database.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getRtcWsUrl, normalizeClientWsUrl } from './rtcResolver.js';

const RUNTIME_KEY = 'call_livekit_config';
const CACHE_TTL_MS = 30_000;

export interface LiveKitRecordingStorage {
  vendor: 's3' | 's3_compatible' | null;
  bucket: string | null;
  region: string | null;
  endpoint: string | null;
  force_path_style: boolean;
  access_key: string | null;
  secret_key: string | null;
}

export interface LiveKitConfig {
  enabled: boolean;
  api_key: string | null;
  api_secret: string | null;
  rtc_url: string | null;
  ws_url: string | null;
  egress_enabled: boolean;
  egress_url: string | null;
  region: string | null;
  webhook_secret: string | null;
  /**
   * The hostname LiveKit's own TURN server answers on, when it is switched
   * on in the deployment (`LIVEKIT_TURN_DOMAIN`).
   *
   * Set, it means the SFU relays for itself: it mints a TURN credential per
   * participant and hands it over the signalling connection, so the client
   * gets a relay without this app supplying one. That is why it is worth
   * recording here even though nothing sends it to a client — the "no relay
   * configured" warning is otherwise raised about a deployment that has one.
   */
  turn_domain: string | null;
  recording_storage: LiveKitRecordingStorage;
}

export interface LiveKitRecordingStoragePublic {
  vendor: 's3' | 's3_compatible' | null;
  bucket: string | null;
  region: string | null;
  endpoint: string | null;
  force_path_style: boolean;
  access_key_present: boolean;
  secret_key_present: boolean;
}

export interface LiveKitConfigPublicView {
  enabled: boolean;
  api_key_present: boolean;
  api_secret_present: boolean;
  rtc_url: string | null;
  ws_url: string | null;
  egress_enabled: boolean;
  egress_url: string | null;
  region: string | null;
  webhook_secret_present: boolean;
  turn_domain: string | null;
  recording_storage: LiveKitRecordingStoragePublic;
}

const DEFAULT_RECORDING_STORAGE: LiveKitRecordingStorage = {
  vendor: null,
  bucket: null,
  region: null,
  endpoint: null,
  force_path_style: false,
  access_key: null,
  secret_key: null,
};

const DEFAULT_LIVEKIT_CONFIG: LiveKitConfig = {
  enabled: false,
  api_key: null,
  api_secret: null,
  rtc_url: null,
  ws_url: null,
  egress_enabled: false,
  egress_url: null,
  region: null,
  webhook_secret: null,
  turn_domain: null,
  recording_storage: DEFAULT_RECORDING_STORAGE,
};

let cache: { value: LiveKitConfig; loadedAt: number } | null = null;

export function invalidateLiveKitConfigCache(): void {
  cache = null;
}

function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

function normalizeRecordingStorage(raw: unknown): LiveKitRecordingStorage {
  const r = (raw as Record<string, unknown>) || {};
  const vendorRaw = asString(r.vendor);
  const vendor: LiveKitRecordingStorage['vendor'] =
    vendorRaw === 's3' || vendorRaw === 's3_compatible' ? vendorRaw : null;
  return {
    vendor,
    bucket: asString(r.bucket),
    region: asString(r.region),
    endpoint: asString(r.endpoint),
    force_path_style: r.force_path_style === true,
    access_key: asString(r.access_key),
    secret_key: asString(r.secret_key),
  };
}

function normalizeConfig(raw: unknown): LiveKitConfig {
  const r = (raw as Record<string, unknown>) || {};
  return {
    enabled: r.enabled === true,
    api_key: asString(r.api_key),
    api_secret: asString(r.api_secret),
    rtc_url: asString(r.rtc_url),
    ws_url: asString(r.ws_url),
    egress_enabled: r.egress_enabled === true,
    egress_url: asString(r.egress_url),
    region: asString(r.region),
    webhook_secret: asString(r.webhook_secret),
    turn_domain: asString(r.turn_domain),
    recording_storage: normalizeRecordingStorage(r.recording_storage),
  };
}

/**
 * Whether the SFU relays for itself.
 *
 * LiveKit's built-in TURN server issues its own per-participant credentials
 * over the signalling connection. So when it is on, the client already has a
 * relay and the app must NOT also advertise one: an ICE server pointing at
 * LiveKit's TURN with no credentials is not a spare route, it is a broken
 * one. It is also why "no relay is configured" has to ask this before it
 * says anything — otherwise it says it about a deployment that relays fine.
 */
export function providesOwnRelay(cfg: LiveKitConfig): boolean {
  return cfg.enabled && cfg.turn_domain !== null;
}

export async function loadLiveKitConfig(
  config: ServerConfig,
  forceRefresh = false,
): Promise<LiveKitConfig> {
  if (!forceRefresh && cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.value;
  }
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', RUNTIME_KEY)
    .maybeSingle();

  const value = normalizeConfig((data?.value as unknown) ?? DEFAULT_LIVEKIT_CONFIG);
  cache = { value, loadedAt: Date.now() };
  return value;
}

/**
 * Save a partial patch. Secret fields use presence-aware semantics:
 *   - field omitted    -> preserved
 *   - field === ''     -> cleared (set to null)
 *   - field === string -> set to value
 */
export async function saveLiveKitConfig(
  config: ServerConfig,
  patch: Partial<{
    enabled: boolean;
    api_key: string | null;
    api_secret: string | null;
    rtc_url: string | null;
    ws_url: string | null;
    egress_enabled: boolean;
    egress_url: string | null;
    region: string | null;
    webhook_secret: string | null;
    recording_storage: Partial<LiveKitRecordingStorage>;
  }>,
): Promise<LiveKitConfig> {
  const current = await loadLiveKitConfig(config, true);
  const next: LiveKitConfig = {
    ...current,
    ...('enabled' in patch ? { enabled: !!patch.enabled } : {}),
    ...('rtc_url' in patch ? { rtc_url: patch.rtc_url ?? null } : {}),
    ...('ws_url' in patch ? { ws_url: patch.ws_url ?? null } : {}),
    ...('egress_enabled' in patch ? { egress_enabled: !!patch.egress_enabled } : {}),
    ...('egress_url' in patch ? { egress_url: patch.egress_url ?? null } : {}),
    ...('region' in patch ? { region: patch.region ?? null } : {}),
  };
  if ('api_key' in patch) {
    next.api_key = patch.api_key === '' ? null : (patch.api_key ?? current.api_key);
  }
  if ('api_secret' in patch) {
    next.api_secret =
      patch.api_secret === '' ? null : (patch.api_secret ?? current.api_secret);
  }
  if ('webhook_secret' in patch) {
    next.webhook_secret =
      patch.webhook_secret === '' ? null : (patch.webhook_secret ?? current.webhook_secret);
  }
  if (patch.recording_storage) {
    const s = patch.recording_storage;
    next.recording_storage = {
      ...current.recording_storage,
      ...('vendor' in s ? { vendor: s.vendor ?? null } : {}),
      ...('bucket' in s ? { bucket: s.bucket ?? null } : {}),
      ...('region' in s ? { region: s.region ?? null } : {}),
      ...('endpoint' in s ? { endpoint: s.endpoint ?? null } : {}),
      ...('force_path_style' in s ? { force_path_style: !!s.force_path_style } : {}),
    };
    if ('access_key' in s) {
      next.recording_storage.access_key =
        s.access_key === '' ? null : (s.access_key ?? current.recording_storage.access_key);
    }
    if ('secret_key' in s) {
      next.recording_storage.secret_key =
        s.secret_key === '' ? null : (s.secret_key ?? current.recording_storage.secret_key);
    }
  }

  const sb = getServiceClient(config);
  const { error } = await sb
    .from('app_runtime_config')
    .upsert(
      {
        key: RUNTIME_KEY,
        value: next as unknown as Record<string, unknown>,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' },
    );
  if (error) throw new Error(error.message);
  invalidateLiveKitConfigCache();
  cache = { value: next, loadedAt: Date.now() };
  return next;
}

export function toPublicView(c: LiveKitConfig): LiveKitConfigPublicView {
  return {
    enabled: c.enabled,
    api_key_present: !!c.api_key,
    api_secret_present: !!c.api_secret,
    rtc_url: c.rtc_url,
    ws_url: c.ws_url,
    egress_enabled: c.egress_enabled,
    egress_url: c.egress_url,
    region: c.region,
    webhook_secret_present: !!c.webhook_secret,
    turn_domain: c.turn_domain,
    recording_storage: {
      vendor: c.recording_storage.vendor,
      bucket: c.recording_storage.bucket,
      region: c.recording_storage.region,
      endpoint: c.recording_storage.endpoint,
      force_path_style: c.recording_storage.force_path_style,
      access_key_present: !!c.recording_storage.access_key,
      secret_key_present: !!c.recording_storage.secret_key,
    },
  };
}

/**
 * Cheap, no-IO sanity check. Real readiness lives in livekitProvider.isReady().
 */
export function isMinimallyConfigured(c: LiveKitConfig): boolean {
  return c.enabled && !!c.api_key && !!c.api_secret && !!c.rtc_url;
}

/**
 * Resolve the client-safe LiveKit WebSocket URL using the SAME source-of-truth
 * the LiveKit provider uses to mint rooms. Order:
 *   1. livekit_config.ws_url (admin-configured signaling endpoint)
 *   2. livekit_config.rtc_url (LiveKit shares signaling+media on one wss)
 *   3. getRtcWsUrl(config) — generic RTC resolver / env fallback
 * Always normalized to `wss://host[:port]` (no path, no http scheme).
 * Returns null when no client-facing URL is configured. NEVER returns
 * api_key / api_secret / webhook_secret.
 */
export async function getLiveKitClientWsUrl(
  config: ServerConfig,
): Promise<string | null> {
  const lk = await loadLiveKitConfig(config);
  const candidate =
    lk.ws_url ||
    lk.rtc_url ||
    (await getRtcWsUrl(config));
  return normalizeClientWsUrl(candidate);
}
