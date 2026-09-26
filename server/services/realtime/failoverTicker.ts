/**
 * Phase 6B — In-process ticker that runs the failover engine.
 *
 * Every 30s:
 *   1. Load control-plane policy + persisted state.
 *   2. Build per-provider health snapshot.
 *   3. Run decideFailover().
 *   4. If there is anything to commit — a transition, a material change
 *      against the stored row, or the 15-minute stored heartbeat — take the
 *      cluster lease, re-read the state and decide again under it, then
 *      persist.
 *   5. If a transition occurred, write an audit row into
 *      `realtime_provider_audit` and invalidate the publisher cache so the
 *      resolver immediately picks up the new effective provider.
 *
 * Steps 1-3 are read-only and decideFailover() is pure, so they need no
 * lease. The lease is a database write (acquire + release), and taking it
 * first cost two writes every 30s — ~5,760 a day, the single largest periodic
 * writer — to reach "nothing changed" almost every time. Every decision that
 * DOES change something is still made and committed under the lease, exactly
 * as before.
 *
 * Best-effort. Never throws. Uses unref() so it won't block shutdown.
 */

import type { ServerConfig } from '../../config.js';
import { loadControlPlane } from './controlPlane.js';
import { evaluateProviderHealth, type HealthSnapshot } from './failoverHealth.js';
import {
  loadFailoverState,
  saveFailoverState,
  invalidateFailoverStateCache,
  needsFailoverPersist,
  rememberFailoverState,
} from './failoverState.js';
import { decideFailover } from './failoverEngine.js';
import { recordRealtimeProviderAudit } from './providerAudit.js';
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
  try {
    // Evaluate without the lease: reads, the health probe and a pure
    // decision. Most ticks end here with nothing to commit.
    let health: HealthSnapshot;
    try {
      const [policy, stored] = await Promise.all([
        loadControlPlane(config, false),
        loadFailoverState(config, true),
      ]);
      health = await evaluateProviderHealth(config, policy);
      const decision = decideFailover(policy, health, stored);
      if (!decision.transition && !needsFailoverPersist(stored, decision.next)) {
        rememberFailoverState(decision.next);
        return;
      }
    } catch (err) {
      emitLog(config, 'warn', 'realtime_failover_tick_failed', {
        error: err?.message || 'unknown',
      });
      return;
    }
    await commitUnderLease(config, health);
  } finally {
    running = false;
  }
}

/**
 * The commit half, unchanged in substance: under the cluster lease, re-read
 * policy and state (another replica may have committed since the lease-free
 * evaluation) and decide again against them with the same health snapshot.
 */
async function commitUnderLease(config: ServerConfig, health: HealthSnapshot): Promise<void> {
  let leased = false;
  try {
    leased = await acquireTickerLease(config, LEASE_NAME);
  } catch (err) {
    emitLog(config, 'warn', 'failover_ticker_lease_unavailable', { error: err?.message || 'unknown' });
    return; // fail-closed: skip this cycle rather than risk conflicting failover decisions across replicas
  }
  if (!leased) return; // another replica already owns this cycle
  try {
    const [policy, prev] = await Promise.all([
      loadControlPlane(config, false),
      loadFailoverState(config, true),
    ]);
    const decision = decideFailover(policy, health, prev);
    const next = decision.next;

    // Persist on a transition, a material change or the stored heartbeat.
    // `force`: the need was judged against the stored row just above, which
    // saveFailoverState's own per-process memory cannot see (another replica
    // may have written in between).
    if (decision.transition || needsFailoverPersist(prev, next)) {
      await saveFailoverState(config, next, { force: true });
    } else {
      rememberFailoverState(next);
    }

    if (decision.transition) {
      const t = decision.transition;
      try {
        await recordRealtimeProviderAudit(config, {
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
      } catch (err) {
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
  } catch (err) {
    emitLog(config, 'warn', 'realtime_failover_tick_failed', {
      error: err?.message || 'unknown',
    });
  } finally {
    await releaseTickerLease(config, LEASE_NAME);
  }
}

export function startFailoverTicker(config: ServerConfig): void {
  if (timer) return;
  // First tick after a short delay so we don't race the perf collector
  // and immediately classify everything as 'unknown'.
  setTimeout(() => void runFailoverTickOnce(config), 10_000);
  timer = setInterval(() => void runFailoverTickOnce(config), TICK_MS);
  (timer as { unref?: () => void }).unref?.();
}

export function __stopFailoverTickerForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}