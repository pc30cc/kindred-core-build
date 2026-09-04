/**
 * Realtime Provider Configuration Store.
 * Reads/writes the global realtime provider config from `app_runtime_config`.
 * Key: `default_realtime_provider`
 *
 * Caches in-memory for 30s to avoid hitting DB on every connection request.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type { RealtimeProviderConfig } from './types.js';

const CACHE_TTL_MS = 30_000;
const RUNTIME_KEY = 'default_realtime_provider';

let cache: { value: RealtimeProviderConfig | null; loadedAt: number } | null = null;

const DEFAULT_CONFIG: RealtimeProviderConfig = {
  vendor: 'polling_builtin',
  enabled: true,
  fallback_policy: 'lenient',
  fallback_vendor: 'polling_builtin',
};

export async function loadRealtimeConfig(
  config: ServerConfig,
  forceRefresh = false
): Promise<RealtimeProviderConfig> {
  if (!forceRefresh && cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.value ?? DEFAULT_CONFIG;
  }

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', RUNTIME_KEY)
    .maybeSingle();

  if (error) {
    console.warn('[Realtime] failed to load config:', error.message);
    cache = { value: null, loadedAt: Date.now() };
    return DEFAULT_CONFIG;
  }

  if (!data || !data.value) {
    cache = { value: null, loadedAt: Date.now() };
    return DEFAULT_CONFIG;
  }

  // Stored shape from existing setGlobalDefaultProvider(): { provider_name, config }
  const raw = data.value as { provider_name?: string; config?: Partial<RealtimeProviderConfig> & { centrifugo?: any } } | RealtimeProviderConfig;
  const merged = normalize(raw);
  cache = { value: merged, loadedAt: Date.now() };
  return merged;
}

export function invalidateRealtimeCache(): void {
  cache = null;
  // Lazy import to avoid a circular dep between store <-> resolvePublisher.
  void import('./resolvePublisher.js')
    .then((m) => m.invalidatePublisherCache())
    .catch(() => {
      /* noop — cache stays warm one extra cycle, harmless */
    });
}

export async function saveRealtimeConfig(
  config: ServerConfig,
  next: RealtimeProviderConfig
): Promise<void> {
  const sb = getServiceClient(config);
  // Persist using the same shape as setGlobalDefaultProvider for forward compatibility.
  const value = {
    provider_name: next.vendor,
    config: next,
  };
  const { error } = await sb
    .from('app_runtime_config')
    .upsert({ key: RUNTIME_KEY, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  invalidateRealtimeCache();
}

function normalize(
  raw: { provider_name?: string; config?: any } | RealtimeProviderConfig
): RealtimeProviderConfig {
  // Two possible shapes:
  //   (a) modern: { vendor, enabled, fallback_policy, ... }
  //   (b) legacy: { provider_name, config: { ... } }
  let src: any = raw;
  if (src && 'provider_name' in src) {
    src = { vendor: src.provider_name, ...(src.config || {}) };
  }
  const vendor = (src?.vendor === 'centrifugo' || src?.vendor === 'supabase' || src?.vendor === 'disabled' || src?.vendor === 'polling_builtin')
    ? src.vendor
    : 'polling_builtin';
  return {
    vendor,
    enabled: src?.enabled !== false,
    fallback_policy: src?.fallback_policy === 'strict' ? 'strict' : 'lenient',
    fallback_vendor: src?.fallback_vendor === null ? null : 'polling_builtin',
    centrifugo: normalizeCentrifugo(src?.centrifugo),
  };
}

/**
 * Topology normalization + backward compatibility.
 * A config written before deployment modes existed has no `deployment_mode`
 * and no `nodes` — it normalizes to `single_memory` with an empty registry,
 * so every existing installation keeps working with zero manual changes.
 */
function normalizeCentrifugo(raw: any): RealtimeProviderConfig['centrifugo'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const nodes = normalizeNodes(raw.nodes);
  return {
    ...raw,
    deployment_mode: resolveDeploymentMode(raw),
    nodes,
    load_balancer_ws_url:
      typeof raw.load_balancer_ws_url === 'string' && raw.load_balancer_ws_url.trim()
        ? raw.load_balancer_ws_url.trim()
        : undefined,
  };
}


/** Returns a copy of the config with all secret fields masked. Safe to send to UI. */
export function maskedConfig(cfg: RealtimeProviderConfig): RealtimeProviderConfig {
  if (!cfg.centrifugo) return cfg;
  return {
    ...cfg,
    centrifugo: {
      ...cfg.centrifugo,
      api_key: cfg.centrifugo.api_key ? mask(cfg.centrifugo.api_key) : undefined,
      token_hmac_secret: cfg.centrifugo.token_hmac_secret ? mask(cfg.centrifugo.token_hmac_secret) : undefined,
    },
  };
}

function mask(s: string): string {
  if (!s) return '';
  if (s.length <= 4) return '••••••••';
  return s.slice(0, 4) + '••••••••';
}
