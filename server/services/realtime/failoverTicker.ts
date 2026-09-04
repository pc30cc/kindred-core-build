/**
 * Phase 6B — In-process ticker that runs the failover engine.
 *
 * Every 30s:
 *   1. Load control-plane policy + persisted state.
 *   2. Build per-provider health snapshot.
 *   3. Run decideFailover().
 *   4. Persist next state.
 *   5. If a transition occurred, write an audit row into
 *      `realtime_provider_audit` and invalidate the publisher cache so the
 *      resolver immediately picks up the new effective provider.
 *
 * Best-effort. Never throws. Uses unref() so it won't block shutdown.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { loadControlPlane } from './controlPlane.js';
import { evaluateProviderHealth } from './failoverHealth.js';
import {
  loadFailoverState,
  saveFailoverState,
  invalidateFailoverStateCache,
} from './failoverState.js';
import { decideFailover } from './failoverEngine.js';
import { invalidatePublisherCache } from './resolvePublisher.js';
import { emitLog } from '../observability/metrics.js';
import { acquireTickerLease, releaseTickerLease } from '../observability/tickerLease.js';

const TICK_MS = 30_000;
const LEASE_NAME = 'failover_health';
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function runFailoverTickOnce(config: ServerConfig): Promise<void> {
  if (running) return;
  running = true;
  let leased = false;
  try {
    leased = await acquireTickerLease(config, LEASE_NAME);
  } catch (err: any) {
    emitLog(config, 'warn', 'failover_ticker_lease_unavailable', { error: err?.message || 'unknown' });
    running = false;
    return; // fail-closed: skip this cycle rather than risk conflicting failover decisions across replicas
  }
  if (!leased) {
    running = false;
    return; // another replica already owns this cycle
  }
  try {
    const [policy, prev] = await Promise.all([
      loadControlPlane(config, false),
      loadFailoverState(config, true),
    ]);
    const health = await evaluateProviderHealth(config, policy);
    const decision = decideFailover(policy, health, prev);
    const next = decision.next;

    // Always persist the latest health + last_evaluated_at (even on no-op).
    await saveFailoverState(config, next);

    if (decision.transition) {
      const t = decision.transition;
      try {
        const sb = getServiceClient(config);
        await sb.from('realtime_provider_audit').insert({
          changed_by: null,
          action: `failover_engine:${t.kind}`,
          prev_vendor: t.from_provider,
          vendor: t.to_provider,
          config_diff: {
            transition: {
              kind: t.kind,
              reason: t.reason,
              evidence: t.evidence,
            },
          },
          result: 'success',
          ip_address: null,
        });
      } catch (err: any) {
        emitLog(config, 'warn', 'realtime_failover_audit_write_failed', {
          error: err?.message || 'unknown',
        });
      }
      // Force the publisher cache to refresh so the next /connect call
      // resolves to the new provider immediately.
      invalidatePublisherCache();
      invalidateFailoverStateCache();
      emitLog(config, 'info', 'realtime_failover_transition', {
        kind: t.kind,
        from: t.from_provider,
        to: t.to_provider,
        reason: t.reason,
      });
    }
  } catch (err: any) {
    emitLog(config, 'warn', 'realtime_failover_tick_failed', {
      error: err?.message || 'unknown',
    });
  } finally {
    running = false;
    await releaseTickerLease(config, LEASE_NAME);
  }
}

export function startFailoverTicker(config: ServerConfig): void {
  if (timer) return;
  // First tick after a short delay so we don't race the perf collector
  // and immediately classify everything as 'unknown'.
  setTimeout(() => void runFailoverTickOnce(config), 10_000);
  timer = setInterval(() => void runFailoverTickOnce(config), TICK_MS);
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
}

export function __stopFailoverTickerForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}