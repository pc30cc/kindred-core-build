/**
 * Background Centrifugo node-health refresher.
 *
 * Why it exists: the client connection assignment path must be network-free.
 * Without a background refresher, the FIRST /connect after the cache TTL
 * expires would pay an HTTP fan-out to every registered node. Here the ticker
 * owns all probing and the hot path only reads the cache snapshot.
 *
 * Properties:
 *   • jittered interval — app instances never probe in lockstep
 *   • bounded concurrency + per-request timeout (inside the driver)
 *   • no PostgreSQL write per cycle (config read is served from its own cache)
 *   • no-op unless the deployment mode actually has registered nodes
 */

import type { ServerConfig } from '../../config.js';
import { loadRealtimeConfig } from './store.js';
import { getClusterHealth } from './nodeHealth.js';
import { normalizeNodes, resolveDeploymentMode } from './types.js';

/** Base cadence; the effective delay is BASE ± JITTER_PCT. */
export const HEALTH_REFRESH_BASE_MS = 8_000;
export const HEALTH_REFRESH_JITTER_PCT = 0.35;
const PROBE_CONCURRENCY = 4;

let timer: NodeJS.Timeout | null = null;
let running = false;

export function nextRefreshDelay(
  rand: () => number = Math.random,
  base = HEALTH_REFRESH_BASE_MS,
  jitterPct = HEALTH_REFRESH_JITTER_PCT
): number {
  const spread = base * jitterPct;
  return Math.max(1_000, Math.round(base - spread + rand() * 2 * spread));
}

/**
 * One refresh cycle.
 *
 * The realtime config is re-read with `forceRefresh` so that administrative
 * node state (drain / disable / weight / add / remove) converges on EVERY app
 * instance within one cycle (~8s) without the hot /connect path ever touching
 * PostgreSQL. On the instance that performed the admin action the change is
 * already immediate, because saveRealtimeConfig() invalidates the cache inline.
 */
export async function refreshNodeHealthOnce(config: ServerConfig): Promise<number> {
  const cfg = await loadRealtimeConfig(config, true);
  if (cfg.vendor !== 'centrifugo' || !cfg.enabled) return 0;
  const mode = resolveDeploymentMode(cfg.centrifugo);
  if (mode === 'single_memory') return 0;
  const nodes = normalizeNodes(cfg.centrifugo?.nodes).filter((n) => n.enabled);
  const apiKey = cfg.centrifugo?.api_key || '';
  if (!nodes.length || !apiKey) return 0;
  // force: the whole point is to keep the cache warm ahead of the TTL.
  await getClusterHealth(nodes, apiKey, { force: true, concurrency: PROBE_CONCURRENCY });
  return nodes.length;
}

/** Start the ticker. Idempotent. */
export function startNodeHealthRefresher(config: ServerConfig): void {
  if (running) return;
  running = true;
  const loop = async () => {
    try {
      await refreshNodeHealthOnce(config);
    } catch (err: any) {
      console.warn('[realtime/healthRefresher]', err?.message || err);
    }
    if (!running) return;
    timer = setTimeout(loop, nextRefreshDelay());
    timer.unref?.();
  };
  timer = setTimeout(loop, nextRefreshDelay());
  timer.unref?.();
}

export function stopNodeHealthRefresher(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

export function isNodeHealthRefresherRunning(): boolean {
  return running;
}
