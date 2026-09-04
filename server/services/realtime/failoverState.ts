/**
 * Phase 6B — Persisted state for the realtime failover engine.
 *
 * Single-row table `realtime_failover_state`. Provides:
 *   • read with a 10s in-memory cache (hot path: resolver consults the
 *     state on every connect).
 *   • write that updates the row + invalidates the cache atomically.
 *
 * No business decisions live here — the engine module owns those.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type { RealtimeProviderId } from './controlPlane.js';

export interface FailoverState {
  effective_provider: RealtimeProviderId;
  last_failover_at: string | null;
  last_failover_reason: string | null;
  candidate_recovery_provider: RealtimeProviderId | null;
  candidate_recovery_since: string | null;
  failback_eligible_at: string | null;
  cooldown_until: string | null;
  last_health: Record<string, unknown>;
  last_evaluated_at: string | null;
  updated_at: string;
}

const CACHE_TTL_MS = 10_000;
let cache: { value: FailoverState; loadedAt: number } | null = null;

const FALLBACK_STATE: FailoverState = {
  effective_provider: 'centrifugo',
  last_failover_at: null,
  last_failover_reason: null,
  candidate_recovery_provider: null,
  candidate_recovery_since: null,
  failback_eligible_at: null,
  cooldown_until: null,
  last_health: {},
  last_evaluated_at: null,
  updated_at: new Date().toISOString(),
};

function isProvider(v: unknown): v is RealtimeProviderId {
  return v === 'centrifugo' || v === 'supabase_realtime' || v === 'polling_builtin';
}

function normalize(row: any): FailoverState {
  if (!row) return { ...FALLBACK_STATE };
  const ep = isProvider(row.effective_provider) ? row.effective_provider : 'centrifugo';
  const cand = isProvider(row.candidate_recovery_provider)
    ? row.candidate_recovery_provider
    : null;
  return {
    effective_provider: ep,
    last_failover_at: row.last_failover_at ?? null,
    last_failover_reason: row.last_failover_reason ?? null,
    candidate_recovery_provider: cand,
    candidate_recovery_since: row.candidate_recovery_since ?? null,
    failback_eligible_at: row.failback_eligible_at ?? null,
    cooldown_until: row.cooldown_until ?? null,
    last_health: (row.last_health && typeof row.last_health === 'object') ? row.last_health : {},
    last_evaluated_at: row.last_evaluated_at ?? null,
    updated_at: row.updated_at ?? new Date().toISOString(),
  };
}

export function invalidateFailoverStateCache(): void {
  cache = null;
}

export async function loadFailoverState(
  config: ServerConfig,
  forceRefresh = false,
): Promise<FailoverState> {
  if (!forceRefresh && cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.value;
  }
  try {
    const sb = getServiceClient(config);
    const { data, error } = await (sb.from as any)('realtime_failover_state')
      .select('*')
      .eq('id', 'singleton')
      .maybeSingle();
    if (error) {
      console.warn('[realtime/failoverState] load failed:', error.message);
      cache = { value: { ...FALLBACK_STATE }, loadedAt: Date.now() };
      return cache.value;
    }
    const value = normalize(data);
    cache = { value, loadedAt: Date.now() };
    return value;
  } catch (err: any) {
    console.warn('[realtime/failoverState] load threw:', err?.message);
    cache = { value: { ...FALLBACK_STATE }, loadedAt: Date.now() };
    return cache.value;
  }
}

/**
 * Write-on-change persistence.
 *
 * The failover ticker runs every 30s and previously UPSERTed this single row
 * on every tick, even when nothing changed — ~2 writes/minute forever. We now
 * only touch Postgres when a *material* field changed (effective provider,
 * failover/failback bookkeeping, cooldown, or a per-provider health status
 * transition), plus a slow heartbeat write so `last_evaluated_at` never goes
 * stale for operators watching the admin panel.
 *
 * Latency/error-rate numbers inside `last_health` are deliberately NOT part of
 * the signature: they jitter on every sample and would defeat the whole point.
 * The in-memory cache always holds the freshest values regardless.
 */
const HEARTBEAT_PERSIST_MS = 15 * 60 * 1000;
let lastPersistedAt = 0;
let lastPersistedSignature: string | null = null;

function healthStatusSignature(health: Record<string, unknown>): string {
  const providers = (health as any)?.providers;
  if (!providers || typeof providers !== 'object') return '';
  return Object.keys(providers)
    .sort()
    .map((k) => `${k}=${(providers as any)[k]?.status ?? 'unknown'}`)
    .join(',');
}

function materialSignature(s: FailoverState): string {
  return [
    s.effective_provider,
    s.last_failover_at ?? '',
    s.last_failover_reason ?? '',
    s.candidate_recovery_provider ?? '',
    s.candidate_recovery_since ?? '',
    s.failback_eligible_at ?? '',
    s.cooldown_until ?? '',
    healthStatusSignature(s.last_health),
  ].join('|');
}

export async function saveFailoverState(
  config: ServerConfig,
  patch: Partial<FailoverState>,
  options: { force?: boolean } = {},
): Promise<FailoverState> {
  const prev = await loadFailoverState(config, true);
  const merged: FailoverState = {
    ...prev,
    ...patch,
    updated_at: new Date().toISOString(),
  };

  const signature = materialSignature(merged);
  const now = Date.now();
  const unchanged = lastPersistedSignature !== null && signature === lastPersistedSignature;
  const heartbeatDue = now - lastPersistedAt >= HEARTBEAT_PERSIST_MS;

  if (!options.force && unchanged && !heartbeatDue) {
    // No state change worth a write. Keep the fresh values in memory only.
    cache = { value: merged, loadedAt: now };
    return merged;
  }

  const sb = getServiceClient(config);
  const { error } = await (sb.from as any)('realtime_failover_state').upsert(
    {
      id: 'singleton',
      effective_provider: merged.effective_provider,
      last_failover_at: merged.last_failover_at,
      last_failover_reason: merged.last_failover_reason,
      candidate_recovery_provider: merged.candidate_recovery_provider,
      candidate_recovery_since: merged.candidate_recovery_since,
      failback_eligible_at: merged.failback_eligible_at,
      cooldown_until: merged.cooldown_until,
      last_health: merged.last_health,
      last_evaluated_at: merged.last_evaluated_at,
      updated_at: merged.updated_at,
    },
    { onConflict: 'id' },
  );
  if (error) throw new Error(error.message);
  lastPersistedAt = now;
  lastPersistedSignature = signature;
  cache = { value: merged, loadedAt: now };
  return merged;
}

export function __resetFailoverStateCacheForTests(): void {
  cache = null;
  lastPersistedAt = 0;
  lastPersistedSignature = null;
}
