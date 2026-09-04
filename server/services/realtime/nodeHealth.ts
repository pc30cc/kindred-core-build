/**
 * Per-node Centrifugo health, with a short TTL cache.
 *
 * Rules (see plan §C):
 *  • A client connection assignment must NEVER trigger an HTTP fan-out to
 *    every node. Health is read from the cache; refreshes happen at most
 *    once per TTL per node and are shared by concurrent callers.
 *  • Correctness never depends on stale process-local state for longer than
 *    the TTL: an entry older than HARD_STALE_MS is treated as `unknown` and
 *    is refreshed in the background.
 *  • Failure is safe: a node we cannot prove healthy is not selected when
 *    any healthy node exists.
 *
 * Connection counts come from Centrifugo's own `info` reply — we never keep
 * live connection counters in PostgreSQL.
 */

import { CentrifugoDriver } from './centrifugo.js';
import type { CentrifugoNode, CentrifugoNodeHealthStatus } from './types.js';

export interface NodeHealthSnapshot {
  node_id: string;
  status: CentrifugoNodeHealthStatus;
  message?: string;
  latency_ms?: number;
  /** Live client count reported by Centrifugo `info`, when available. */
  connections?: number;
  checked_at?: number;
}

/** Health cache TTL — short enough to react, long enough to avoid fan-out. */
export const NODE_HEALTH_TTL_MS = 10_000;
/** Beyond this age a cached entry is no longer trusted as evidence. */
export const NODE_HEALTH_HARD_STALE_MS = 60_000;

const cache = new Map<string, NodeHealthSnapshot>();
const inflight = new Map<string, Promise<NodeHealthSnapshot>>();

export function invalidateNodeHealth(nodeId?: string): void {
  if (nodeId) cache.delete(nodeId);
  else cache.clear();
}

/** Cached snapshot without triggering any network call. */
export function peekNodeHealth(nodeId: string): NodeHealthSnapshot | null {
  const hit = cache.get(nodeId);
  if (!hit) return null;
  const age = Date.now() - (hit.checked_at ?? 0);
  if (age > NODE_HEALTH_HARD_STALE_MS) {
    return { node_id: nodeId, status: 'unknown', message: 'health evidence stale', checked_at: hit.checked_at };
  }
  return hit;
}

async function probe(node: CentrifugoNode, apiKey: string): Promise<NodeHealthSnapshot> {
  const started = Date.now();
  const driver = new CentrifugoDriver({
    ws_url: node.ws_url,
    api_url: node.api_url,
    api_key: apiKey,
    token_hmac_secret: 'unused-for-health',
  });
  const info = await driver.info();
  const snapshot: NodeHealthSnapshot = {
    node_id: node.id,
    status: info.status,
    message: info.message,
    latency_ms: Date.now() - started,
    connections: info.num_clients,
    checked_at: Date.now(),
  };
  cache.set(node.id, snapshot);
  return snapshot;
}

/**
 * Health of a single node. Returns the cached value when fresh; otherwise
 * probes (deduplicated across concurrent callers).
 */
export async function getNodeHealth(
  node: CentrifugoNode,
  apiKey: string,
  options: { force?: boolean } = {}
): Promise<NodeHealthSnapshot> {
  if (!options.force) {
    const hit = cache.get(node.id);
    if (hit && Date.now() - (hit.checked_at ?? 0) < NODE_HEALTH_TTL_MS) return hit;
  }
  const existing = inflight.get(node.id);
  if (existing && !options.force) return existing;

  const p = probe(node, apiKey)
    .catch((err): NodeHealthSnapshot => {
      const snapshot: NodeHealthSnapshot = {
        node_id: node.id,
        status: 'down',
        message: err?.message || 'probe failed',
        checked_at: Date.now(),
      };
      cache.set(node.id, snapshot);
      return snapshot;
    })
    .finally(() => {
      inflight.delete(node.id);
    });
  inflight.set(node.id, p);
  return p;
}

/** Health of every node (parallel, cache-respecting). */
export async function getClusterHealth(
  nodes: CentrifugoNode[],
  apiKey: string,
  options: { force?: boolean } = {}
): Promise<Record<string, NodeHealthSnapshot>> {
  const results = await Promise.all(nodes.map((n) => getNodeHealth(n, apiKey, options)));
  const map: Record<string, NodeHealthSnapshot> = {};
  results.forEach((r) => {
    map[r.node_id] = r;
  });
  return map;
}

/**
 * Effective operational status shown in the admin UI: administrative state
 * (disabled / draining) takes precedence over the transport probe.
 */
export function effectiveNodeStatus(
  node: CentrifugoNode,
  health: NodeHealthSnapshot | null | undefined
): CentrifugoNodeHealthStatus {
  if (!node.enabled) return 'maintenance';
  if (node.draining || !node.accepting_new_connections) return 'draining';
  return health?.status ?? 'unknown';
}
