/**
 * Cluster-wide lease preventing DUPLICATE execution of the alerting and
 * failover-health tickers across replicas. This is narrower than "fleet-wide
 * monitoring correctness" — read the scope carefully:
 *
 * What this lease DOES: with N API replicas each running their own
 * in-memory Live Monitoring collector, it ensures exactly ONE replica runs
 * a given named ticker per cycle (same pattern as
 * server/services/ai-billing/recovery.ts's recovery lease, migration 075,
 * ai_billing_recovery_lease). Without it, every replica would evaluate
 * alert rules / failover health independently every tick, each writing its
 * own alert_events rows and reaching its own failover decision — this lease
 * stops that duplication and its associated write/flap noise.
 *
 * What this lease does NOT do: aggregate in-memory metrics across replicas.
 * The lease-holding replica evaluates against ONLY its own local collector
 * state — it has no visibility into traffic that landed on other replicas.
 * If a load balancer spreads traffic across replicas and lease ownership
 * later moves to a different replica, that replica's evaluation reflects
 * only the traffic IT personally observed, not fleet-wide traffic. In a
 * single-replica deployment (the common case today) this is a non-issue —
 * the one replica sees all traffic. In a genuine multi-replica deployment,
 * alert/failover decisions are correct with respect to whichever replica
 * currently holds the lease, not with respect to the whole fleet.
 *
 * Fleet-wide metric aggregation is intentionally out of scope here — it
 * belongs behind the MonitoringCollector interface (collector/types.ts) via
 * a future shared-state implementation (Redis, Prometheus federation,
 * OpenTelemetry Collector), not this lease. This lease only ever solves
 * "don't run the same ticker twice," never "see what every replica saw."
 *
 * The underlying ticker operations stay idempotent regardless — the lease
 * is a duplication guard, not the sole correctness mechanism, and expires
 * on its own if the holding replica dies mid-cycle.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

const LEASE_TTL_SECONDS = 120;

export const TICKER_INSTANCE_ID = `${process.env.HOSTNAME || 'node'}:${process.pid}:${Math.random()
  .toString(36)
  .slice(2, 8)}`;

export async function acquireTickerLease(
  config: ServerConfig,
  name: string,
  owner: string = TICKER_INSTANCE_ID,
): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('observability_try_acquire_ticker_lease', {
    _name: name,
    _owner: owner,
    _ttl_seconds: LEASE_TTL_SECONDS,
  });
  if (error) throw new Error(`ticker_lease_unavailable: ${error.message}`);
  return data === true;
}

export async function releaseTickerLease(
  config: ServerConfig,
  name: string,
  owner: string = TICKER_INSTANCE_ID,
): Promise<void> {
  try {
    const sb = getServiceClient(config);
    await sb.rpc('observability_release_ticker_lease', { _name: name, _owner: owner });
  } catch {
    // TTL expiry releases it anyway; never fail a completed pass on this.
  }
}
