/**
 * Phase 8A.1 — Agora external provider configuration store.
 *
 * Stored in `app_runtime_config` under key `call_agora_config`.
 * NO endpoints/domains are hardcoded — Agora SDK uses its own SaaS
 * endpoints, but every configurable value (App ID, certificate, region,
 * webhook URL) is admin-managed.
 *
 * Secrets (`app_certificate`, `token_secret`) are stored server-side
 * and never leak to the client. The admin GET endpoint returns only
 * presence flags, not the secret values themselves.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

const RUNTIME_KEY = 'call_agora_config';
const CACHE_TTL_MS = 30_000;

export interface AgoraConfig {
  /** Master switch — must be explicitly enabled by an admin. */
  enabled: boolean;
  /** Agora App ID (public-ish identifier). */
  app_id: string | null;
  /** Agora App Certificate (server-only secret) used to mint tokens. */
  app_certificate: string | null;
  /**
   * Optional alternative token signing secret if the deployment uses
   * a custom token broker rather than App Certificate.
   */
  token_secret: string | null;
  /** Optional Agora project region hint (e.g. 'GLOBAL', 'CN', 'EU'). Free-form. */
  region: string | null;
  /** Optional webhook URL Agora calls back into for events. Admin-supplied. */
  webhook_url: string | null;
  /** Optional cloud recording config blob. Admin-supplied. */
  recording_config: {
    enabled: boolean;
    storage_vendor: string | null;
    storage_bucket: string | null;
  };
}

const SAFE_DEFAULT: AgoraConfig = {
  enabled: false,
  app_id: null,
  app_certificate: null,
  token_secret: null,
  region: null,
  webhook_url: null,
  recording_config: { enabled: false, storage_vendor: null, storage_bucket: null },
};

let cache: { value: AgoraConfig; loadedAt: number } | null = null;

export function invalidateAgoraConfigCache(): void {
  cache = null;
}

export async function loadAgoraConfig(
  config: ServerConfig,
  forceRefresh = false,
): Promise<AgoraConfig> {
  if (!forceRefresh && cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.value;

  const sb = getServiceClient(config);
  const { data } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', RUNTIME_KEY)
    .maybeSingle();

  const raw = (data?.value as Partial<AgoraConfig>) || {};
  const merged: AgoraConfig = {
    ...SAFE_DEFAULT,
    ...raw,
    recording_config: { ...SAFE_DEFAULT.recording_config, ...(raw.recording_config || {}) },
  };

  cache = { value: merged, loadedAt: Date.now() };
  return merged;
}

export async function saveAgoraConfig(
  config: ServerConfig,
  next: Partial<AgoraConfig>,
): Promise<AgoraConfig> {
  const sb = getServiceClient(config);
  const current = await loadAgoraConfig(config, true);
  const merged: AgoraConfig = {
    ...current,
    ...next,
    recording_config: { ...current.recording_config, ...(next.recording_config || {}) },
  };
  const { error } = await sb
    .from('app_runtime_config')
    .upsert(
      { key: RUNTIME_KEY, value: merged as any, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) throw new Error(error.message);
  invalidateAgoraConfigCache();
  return merged;
}

/**
 * Public-safe shape returned to the admin UI: secrets are replaced with
 * presence flags (true if a value is set, false otherwise).
 */
export interface AgoraConfigPublicView {
  enabled: boolean;
  app_id: string | null;
  app_certificate_present: boolean;
  token_secret_present: boolean;
  region: string | null;
  webhook_url: string | null;
  recording_config: AgoraConfig['recording_config'];
}

export function toPublicView(cfg: AgoraConfig): AgoraConfigPublicView {
  return {
    enabled: cfg.enabled,
    app_id: cfg.app_id,
    app_certificate_present: !!cfg.app_certificate,
    token_secret_present: !!cfg.token_secret,
    region: cfg.region,
    webhook_url: cfg.webhook_url,
    recording_config: cfg.recording_config,
  };
}
