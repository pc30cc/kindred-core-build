/**
 * BACKEND INSTANCE CENSUS — how many processes are buffering analytics rows?
 *
 * ── Why this has to exist ────────────────────────────────────────
 *
 * The durable spool (./spool.ts) is LOCAL to one process's filesystem. That
 * makes a single instance safe across every process-level failure, and it
 * says nothing about a fleet: two backends behind a load balancer each hold
 * their own un-flushed rows, and if one loses its volume nobody can recover
 * them.
 *
 * Under `dual_write` that is harmless, because PostgreSQL holds everything.
 * Under `s3_only` it is the difference between "durable" and "durable on
 * whichever node happens to survive". So before that cutover, someone has to
 * answer: is this deployment one backend, or several?
 *
 * Asking the operator to remember is not good enough — the answer changes
 * when someone scales a service, and a readiness card that reports a stale
 * hand-entered answer is worse than one that reports nothing.
 *
 * ── How it is measured ───────────────────────────────────────────
 *
 * The analytics FLUSH ticker is the one ticker in this codebase that
 * deliberately takes no cross-replica lease: every process must drain its
 * own buffer, so every process runs it. That makes it an exact census of the
 * processes that can hold un-flushed analytics rows — which is precisely the
 * population this question is about.
 *
 * Each instance stamps `hostname -> lastSeenAt` into one `app_runtime_config`
 * key, at most every HEARTBEAT_INTERVAL_MS. Instances not seen within
 * INSTANCE_STALE_MS have gone away and are pruned, so a rolling deploy does
 * not leave a permanent phantom.
 *
 * Grouped by HOSTNAME, not by pid: two processes on one host share that
 * host's filesystem, so they share a spool directory and a volume. It is
 * distinct HOSTS that each need their own durable volume, and hosts are what
 * this counts.
 *
 * ── What it deliberately does NOT do ─────────────────────────────
 *
 * It cannot verify that each instance's volume is actually durable — that a
 * mount exists, survives redeployment, and is reattached to the same node.
 * Nothing inside the container can know that. So a multi-instance deployment
 * needs an explicit operator acknowledgement, recorded with the hostnames it
 * was made for; scaling out afterwards invalidates it, because the
 * acknowledgement was about a fleet that no longer exists.
 */

import * as os from 'os';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { emitLog } from '../observability/metrics.js';

export const ANALYTICS_INSTANCES_KEY = 'analytics_instance_census';

/** At most one write per instance per interval — this is bookkeeping, not telemetry. */
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/** Not seen this long => gone. Comfortably longer than a rolling deploy. */
const INSTANCE_STALE_MS = 30 * 60 * 1000;

export interface InstanceCensus {
  /** Hostnames seen within the staleness window. */
  hosts: string[];
  count: number;
  /** True when more than one host is buffering analytics rows. */
  multiInstance: boolean;
  /**
   * The operator's acknowledgement that every instance has its own durable
   * volume, and the exact fleet it was made for. An acknowledgement made for
   * a different set of hosts does not carry over.
   */
  acknowledgedHosts: string[] | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  /** Acknowledgement covers the CURRENT fleet. */
  acknowledged: boolean;
}

interface StoredCensus {
  seen?: Record<string, string>;
  ackHosts?: string[];
  ackAt?: string;
  ackBy?: string;
}

function hostId(): string {
  return process.env.ANALYTICS_INSTANCE_ID || process.env.HOSTNAME || os.hostname() || 'unknown';
}

let lastHeartbeatAt = 0;

async function readStored(config: ServerConfig): Promise<StoredCensus> {
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('app_runtime_config').select('value')
      .eq('key', ANALYTICS_INSTANCES_KEY).maybeSingle();
    const value = (data as { value?: unknown } | null)?.value;
    return value && typeof value === 'object' ? (value as StoredCensus) : {};
  } catch {
    return {};
  }
}

function freshHosts(seen: Record<string, string>, now: number): string[] {
  return Object.entries(seen)
    .filter(([, at]) => {
      const ts = Date.parse(at);
      return Number.isFinite(ts) && now - ts <= INSTANCE_STALE_MS;
    })
    .map(([host]) => host)
    .sort();
}

/**
 * Record that this process is alive and buffering.
 *
 * Called from the flush ticker. Never throws and never blocks the flush:
 * a census that fails to write costs a readiness warning, and a census that
 * broke ingestion would be a far worse trade.
 */
export async function recordAnalyticsInstance(config: ServerConfig): Promise<void> {
  const now = Date.now();
  if (now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeatAt = now;

  try {
    const stored = await readStored(config);
    const seen = { ...(stored.seen ?? {}) };
    seen[hostId()] = new Date(now).toISOString();

    // Prune before writing, so a fleet that shrank stops being reported as
    // multi-instance without anyone having to clear anything by hand.
    const pruned: Record<string, string> = {};
    for (const host of freshHosts(seen, now)) pruned[host] = seen[host]!;

    const sb = getServiceClient(config);
    await sb.from('app_runtime_config').upsert({
      key: ANALYTICS_INSTANCES_KEY,
      value: { ...stored, seen: pruned },
      updated_at: new Date(now).toISOString(),
    }, { onConflict: 'key' });
  } catch (err: unknown) {
    emitLog(config, 'warn', 'analytics_instance_census_failed', {
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

export async function readAnalyticsInstances(config: ServerConfig): Promise<InstanceCensus> {
  const stored = await readStored(config);
  const now = Date.now();
  const hosts = freshHosts(stored.seen ?? {}, now);

  // A census that has never been written yet reports the process answering
  // this request, which is true and is the single-instance case.
  const effective = hosts.length > 0 ? hosts : [hostId()];
  const ackHosts = Array.isArray(stored.ackHosts) ? [...stored.ackHosts].sort() : null;

  return {
    hosts: effective,
    count: effective.length,
    multiInstance: effective.length > 1,
    acknowledgedHosts: ackHosts,
    acknowledgedAt: stored.ackAt ?? null,
    acknowledgedBy: stored.ackBy ?? null,
    // Only counts when it was made for exactly this fleet.
    acknowledged: !!ackHosts
      && ackHosts.length === effective.length
      && ackHosts.every((h, i) => h === effective[i]),
  };
}

/**
 * Record the operator's statement that every current instance has its own
 * durable volume.
 *
 * Stored WITH the hostnames it was made for. Scaling out later produces a
 * different fleet and silently invalidates it, which is the point: the
 * acknowledgement is about specific machines with specific mounts, not a
 * permanent opinion about the architecture.
 */
export async function acknowledgeMultiInstanceDurability(
  config: ServerConfig,
  adminId: string,
): Promise<InstanceCensus> {
  const census = await readAnalyticsInstances(config);
  const stored = await readStored(config);
  const sb = getServiceClient(config);
  await sb.from('app_runtime_config').upsert({
    key: ANALYTICS_INSTANCES_KEY,
    value: {
      ...stored,
      ackHosts: census.hosts,
      ackAt: new Date().toISOString(),
      ackBy: adminId,
    },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });

  emitLog(config, 'info', 'analytics_multi_instance_acknowledged', {
    hosts: census.hosts.length,
    admin_id: adminId,
  });

  return readAnalyticsInstances(config);
}

export function __resetInstanceHeartbeatForTests(): void {
  lastHeartbeatAt = 0;
}
