/**
 * Phase 6A — Realtime Control Plane settings store.
 *
 * Stores degradation policy, provider failover thresholds, ordered provider
 * priority, and manual provider lock under a single `app_runtime_config` key.
 *
 * IMPORTANT — Phase 6A scope:
 *   This module ONLY reads/writes settings + exposes defaults. It does NOT
 *   refactor live realtime provider switching. The active provider decision
 *   today still flows through `resolveRealtimeProvider()` in
 *   `services/realtime/index.ts`. The failover engine that consumes these
 *   settings will be introduced in Phase 6B.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

const RUNTIME_KEY = 'realtime_control_plane';
const CACHE_TTL_MS = 30_000;

export type RealtimeProviderId = 'centrifugo' | 'supabase_realtime' | 'polling_builtin';

export interface RealtimeDegradationPolicy {
  realtime_degraded_mode_enabled: boolean;
  realtime_disable_typing_on_overload: boolean;
  realtime_force_polling_on_critical_degradation: boolean;
  realtime_reconnect_backoff_multiplier_on_overload: number;
  realtime_degraded_mode_ttl_seconds: number;
  realtime_degraded_mode_auto_recover: boolean;
  realtime_fail_open_if_control_plane_stale: boolean;
}

export interface RealtimeFailoverPolicy {
  realtime_failover_enabled: boolean;
  realtime_failback_enabled: boolean;
  realtime_failover_cooldown_seconds: number;
  realtime_failback_stable_window_seconds: number;
  realtime_failover_error_threshold: number;
  realtime_failover_latency_threshold_ms: number;
  realtime_failover_health_window_seconds: number;
  realtime_provider_order: RealtimeProviderId[];
  realtime_provider_lock: RealtimeProviderId | null;
}

export interface RealtimeControlPlaneConfig
  extends RealtimeDegradationPolicy,
    RealtimeFailoverPolicy {}

export const DEFAULT_CONTROL_PLANE: RealtimeControlPlaneConfig = {
  // Degradation
  realtime_degraded_mode_enabled: true,
  realtime_disable_typing_on_overload: true,
  realtime_force_polling_on_critical_degradation: false,
  realtime_reconnect_backoff_multiplier_on_overload: 2.0,
  realtime_degraded_mode_ttl_seconds: 600,
  realtime_degraded_mode_auto_recover: true,
  realtime_fail_open_if_control_plane_stale: true,
  // Failover
  realtime_failover_enabled: false,
  realtime_failback_enabled: true,
  realtime_failover_cooldown_seconds: 300,
  realtime_failback_stable_window_seconds: 600,
  realtime_failover_error_threshold: 0.05,
  realtime_failover_latency_threshold_ms: 2000,
  realtime_failover_health_window_seconds: 300,
  realtime_provider_order: ['centrifugo', 'supabase_realtime', 'polling_builtin'],
  realtime_provider_lock: null,
};

const VALID_PROVIDERS: ReadonlySet<RealtimeProviderId> = new Set([
  'centrifugo',
  'supabase_realtime',
  'polling_builtin',
]);

let cache: { value: RealtimeControlPlaneConfig; loadedAt: number } | null = null;

export function invalidateControlPlaneCache(): void {
  cache = null;
}

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalize(raw: unknown): RealtimeControlPlaneConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const orderRaw = Array.isArray(src.realtime_provider_order)
    ? (src.realtime_provider_order as unknown[])
    : DEFAULT_CONTROL_PLANE.realtime_provider_order;
  const order = orderRaw.filter(
    (p): p is RealtimeProviderId =>
      typeof p === 'string' && VALID_PROVIDERS.has(p as RealtimeProviderId),
  );
  // Always include polling_builtin as last-resort tail.
  if (!order.includes('polling_builtin')) order.push('polling_builtin');
  const lockRaw = src.realtime_provider_lock;
  const lock: RealtimeProviderId | null =
    typeof lockRaw === 'string' && VALID_PROVIDERS.has(lockRaw as RealtimeProviderId)
      ? (lockRaw as RealtimeProviderId)
      : null;
  return {
    realtime_degraded_mode_enabled:
      src.realtime_degraded_mode_enabled !== false,
    realtime_disable_typing_on_overload:
      src.realtime_disable_typing_on_overload !== false,
    realtime_force_polling_on_critical_degradation:
      src.realtime_force_polling_on_critical_degradation === true,
    realtime_reconnect_backoff_multiplier_on_overload: clampNumber(
      src.realtime_reconnect_backoff_multiplier_on_overload,
      1,
      10,
      DEFAULT_CONTROL_PLANE.realtime_reconnect_backoff_multiplier_on_overload,
    ),
    realtime_degraded_mode_ttl_seconds: clampNumber(
      src.realtime_degraded_mode_ttl_seconds,
      30,
      86_400,
      DEFAULT_CONTROL_PLANE.realtime_degraded_mode_ttl_seconds,
    ),
    realtime_degraded_mode_auto_recover:
      src.realtime_degraded_mode_auto_recover !== false,
    realtime_fail_open_if_control_plane_stale:
      src.realtime_fail_open_if_control_plane_stale !== false,
    realtime_failover_enabled: src.realtime_failover_enabled === true,
    realtime_failback_enabled: src.realtime_failback_enabled !== false,
    realtime_failover_cooldown_seconds: clampNumber(
      src.realtime_failover_cooldown_seconds,
      30,
      86_400,
      DEFAULT_CONTROL_PLANE.realtime_failover_cooldown_seconds,
    ),
    realtime_failback_stable_window_seconds: clampNumber(
      src.realtime_failback_stable_window_seconds,
      30,
      86_400,
      DEFAULT_CONTROL_PLANE.realtime_failback_stable_window_seconds,
    ),
    realtime_failover_error_threshold: clampNumber(
      src.realtime_failover_error_threshold,
      0,
      1,
      DEFAULT_CONTROL_PLANE.realtime_failover_error_threshold,
    ),
    realtime_failover_latency_threshold_ms: clampNumber(
      src.realtime_failover_latency_threshold_ms,
      50,
      60_000,
      DEFAULT_CONTROL_PLANE.realtime_failover_latency_threshold_ms,
    ),
    realtime_failover_health_window_seconds: clampNumber(
      src.realtime_failover_health_window_seconds,
      30,
      86_400,
      DEFAULT_CONTROL_PLANE.realtime_failover_health_window_seconds,
    ),
    realtime_provider_order: order,
    realtime_provider_lock: lock,
  };
}

export async function loadControlPlane(
  config: ServerConfig,
  forceRefresh = false,
): Promise<RealtimeControlPlaneConfig> {
  if (!forceRefresh && cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.value;
  }
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', RUNTIME_KEY)
    .maybeSingle();
  if (error) {
    console.warn('[realtime/control-plane] load failed:', error.message);
    cache = { value: DEFAULT_CONTROL_PLANE, loadedAt: Date.now() };
    return DEFAULT_CONTROL_PLANE;
  }
  const merged = normalize(data?.value ?? {});
  cache = { value: merged, loadedAt: Date.now() };
  return merged;
}

export async function saveControlPlane(
  config: ServerConfig,
  next: RealtimeControlPlaneConfig,
): Promise<RealtimeControlPlaneConfig> {
  const sb = getServiceClient(config);
  const normalized = normalize(next);
  const { error } = await sb
    .from('app_runtime_config')
    .upsert(
      { key: RUNTIME_KEY, value: normalized, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) throw new Error(error.message);
  invalidateControlPlaneCache();
  return normalized;
}

/** Diff helper for audit (whole-object diff, no secrets present). */
export function diffControlPlane(
  prev: RealtimeControlPlaneConfig,
  next: RealtimeControlPlaneConfig,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<
    keyof RealtimeControlPlaneConfig
  >;
  keys.forEach((k) => {
    const p = (prev as unknown as Record<string, unknown>)[k];
    const n = (next as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(p) !== JSON.stringify(n)) out[k] = { from: p, to: n };
  });
  return out;
}
