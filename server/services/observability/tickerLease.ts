/**
 * Cluster-wide lease for the alerting and failover-health tickers.
 *
 * Same pattern as server/services/ai-billing/recovery.ts's recovery lease
 * (migration 075, ai_billing_recovery_lease): process-local single-flight
 * only protects one replica. With multiple API replicas, each running its
 * own in-memory Live Monitoring collector, letting every replica evaluate
 * alert rules / failover health independently every tick would produce
 * inconsistent alert_events rows and flapping failover decisions, since
 * each replica only sees its own local slice of traffic.
 *
 * This lease (migration 123 / observability_ticker_lease) makes exactly
 * ONE replica run a given named ticker per cycle, and expires on its own
 * if that replica dies mid-cycle. The underlying operations stay
 * idempotent regardless — the lease is an efficiency and consistency
 * guard, not the sole correctness mechanism.
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
