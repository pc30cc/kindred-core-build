/**
 * Global Advanced Routing — platform-level fallback policy.
 *
 * Stored as a single JSON blob under
 *   `app_runtime_config.key = 'global_advanced_routing'`
 *
 * This is the new source of truth for owner-fallback behavior. The legacy
 * per-workspace `workspace_provider_settings.department_routing` record is
 * still readable (for diagnostics) but is no longer the active policy used
 * by the routing engine.
 *
 * Cached in-memory for 30s. Fail-open with safe defaults if the row is
 * missing or unreadable.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  DEFAULT_FALLBACK_POLICY,
  type FallbackPolicy,
  type DepartmentChannel,
} from './departments.js';

const RUNTIME_KEY = 'global_advanced_routing';
const CACHE_TTL_MS = 30_000;

let cache: { value: FallbackPolicy; ts: number } | null = null;

function freshCache(): boolean {
  return !!cache && Date.now() - cache.ts < CACHE_TTL_MS;
}

function normalize(raw: any): FallbackPolicy {
  const v = (raw && typeof raw === 'object') ? raw : {};
  return {
    owner_fallback_enabled: v.owner_fallback_enabled !== false,
    owner_fallback_for_chat: v.owner_fallback_for_chat !== false,
    owner_fallback_for_audio: v.owner_fallback_for_audio !== false,
    owner_fallback_for_video: v.owner_fallback_for_video !== false,
    general_pool_enabled: v.general_pool_enabled !== false,
  };
}

/** Read the global advanced-routing policy, with caching + safe defaults. */
export async function loadGlobalAdvancedRouting(
  config: ServerConfig,
): Promise<FallbackPolicy> {
  if (freshCache()) return cache!.value;
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('app_runtime_config')
      .select('value')
      .eq('key', RUNTIME_KEY)
      .maybeSingle();
    const value = normalize(data?.value);
    cache = { value, ts: Date.now() };
    return value;
  } catch {
    const value = { ...DEFAULT_FALLBACK_POLICY };
    cache = { value, ts: Date.now() };
    return value;
  }
}

/** Persist a partial patch and return the merged effective policy. */
export async function saveGlobalAdvancedRouting(
  config: ServerConfig,
  patch: Partial<FallbackPolicy>,
): Promise<FallbackPolicy> {
  const sb = getServiceClient(config);
  const current = await loadGlobalAdvancedRouting(config);
  const merged = normalize({ ...current, ...patch });
  const { error } = await sb
    .from('app_runtime_config')
    .upsert(
      { key: RUNTIME_KEY, value: merged as any, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) throw new Error(error.message);
  cache = { value: merged, ts: Date.now() };
  return merged;
}

/** Channel-aware owner-fallback gate, sourced from the global config. */
export function ownerFallbackAllowedGlobal(
  policy: FallbackPolicy,
  channel: DepartmentChannel,
): boolean {
  if (!policy.owner_fallback_enabled) return false;
  if (channel === 'chat') return policy.owner_fallback_for_chat;
  if (channel === 'audio') return policy.owner_fallback_for_audio;
  if (channel === 'video') return policy.owner_fallback_for_video;
  return false;
}

/** Test-only — drop the in-memory cache. */
export function __resetGlobalAdvancedRoutingCache(): void {
  cache = null;
}