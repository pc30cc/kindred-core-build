/**
 * Per-node Centrifugo health, with a short TTL cache and a BACKGROUND
 * refresher.
 *
 * Rules:
 *  • A client connection assignment must NEVER trigger an HTTP call, not even
 *    the first one after the TTL expires. `snapshotClusterHealth()` is pure
 *    cache reads; refreshing is the background ticker's job (and the admin
 *    Test/Preflight buttons', which force-probe explicitly).
 *  • Correctness never depends on stale process-local state for longer than
 *    HARD_STALE_MS: older entries are reported as `unknown`.
 *  • Failure is safe: a node we cannot prove healthy is not selected when any
 *    healthy node exists (see nodeRouter).
 *
 * Connection counts come from Centrifugo's own `info` reply and are attributed
 * to the node whose runtime name matches `node.node_name`. The cluster total is
 * kept separately and is never presented as a single node's load. Nothing here
 * writes to PostgreSQL.
 */

import { CentrifugoDriver } from './centrifugo.js';
import type { CentrifugoNode, CentrifugoNodeHealthStatus } from './types.js';

export interface NodeHealthSnapshot {
  node_id: string;
  status: CentrifugoNodeHealthStatus;
  message?: string;
  latency_ms?: number;
  /** Live client count OF THIS NODE, when its runtime name was found. */
  connections?: number;
  /** Cluster-wide client count as reported by this node's `info`. */
  cluster_connections?: number;
  /** Number of nodes this node sees through the shared engine. */
  cluster_nodes?: number;
  /** False when `node_name` was not present in the cluster info reply. */
  node_name_matched?: boolean;
  checked_at?: number;
  /**
   * True when this snapshot is `unknown` ONLY because previously collected
   * evidence aged past NODE_HEALTH_HARD_STALE_MS (`stale_unknown`).
   *
   * A stale-unknown node MUST NOT be handed new connections: it was probed
   * before, so a broken health refresher (rather than a cold start) is the
   * reason we have no fresh evidence, and re-admitting it would silently put
   * a down node back into rotation. Absence of any cache entry — the genuine
   * cold-start case (`never_probed_unknown`) — is still selectable as a last
   * resort.
   */
  stale?: boolean;
}

/** Health cache TTL — short enough to react, long enough to avoid fan-out. */
export const NODE_HEALTH_TTL_MS = 10_000;
/** Beyond this age a cached entry is no longer trusted as evidence. */
export const NODE_HEALTH_HARD_STALE_MS = 60_000;

const cache = new Map<string, NodeHealthSnapshot>();
const inflight = new Map<string, Promise<NodeHealthSnapshot>>();

/** Number of health HTTP probes issued by this process (test/metric hook). */
let probeCount = 0;
export function getHealthProbeCount(): number {
  return probeCount;
}
export function resetHealthProbeCount(): void {
  probeCount = 0;
}

export function invalidateNodeHealth(nodeId?: string): void {
  if (nodeId) cache.delete(nodeId);
  else cache.clear();
}

function staleToUnknown(hit: NodeHealthSnapshot): NodeHealthSnapshot {
  const age = Date.now() - (hit.checked_at ?? 0);
  if (age > NODE_HEALTH_HARD_STALE_MS) {
    return {
      node_id: hit.node_id,
      status: 'unknown',
      message: 'health evidence stale',
      stale: true,
      checked_at: hit.checked_at,
    };
  }
  return hit;
}

/** Cached snapshot without triggering any network call. */
export function peekNodeHealth(nodeId: string): NodeHealthSnapshot | null {
  const hit = cache.get(nodeId);
  return hit ? staleToUnknown(hit) : null;
}

/**
 * Cache-only cluster view. Guaranteed network-free — this is what the hot
 * `/connect` and `/operator-connect` assignment path uses.
 */
export function snapshotClusterHealth(nodes: CentrifugoNode[]): Record<string, NodeHealthSnapshot> {
  const map: Record<string, NodeHealthSnapshot> = {};
  for (const n of nodes) {
    const hit = peekNodeHealth(n.id);
    if (hit) map[n.id] = hit;
  }
  return map;
}

async function probe(node: CentrifugoNode, apiKey: string): Promise<NodeHealthSnapshot> {
  const started = Date.now();
  probeCount += 1;
  const driver = new CentrifugoDriver({
    ws_url: node.ws_url,
    api_url: node.api_url,
    api_key: apiKey,
    token_hmac_secret: 'unused-for-health',
  });
  const info = await driver.info({ nodeName: node.node_name || node.id });
  const snapshot: NodeHealthSnapshot = {
    node_id: node.id,
    status: info.status,
    message: info.message,
    latency_ms: Date.now() - started,
    // Per-node only. `undefined` when the runtime node name was not found —
    // the router treats an unknown load as unknown instead of using the
    // cluster total.
    connections: info.num_clients,
    cluster_connections: info.cluster_num_clients,
    cluster_nodes: info.num_nodes,
    node_name_matched: info.node_name_matched,
    checked_at: Date.now(),
  };
  cache.set(node.id, snapshot);
  return snapshot;
}

/**
 * Health of a single node. Returns the cached value when fresh; otherwise
 * probes (deduplicated across concurrent callers).
 *
 * NOT for the client assignment path — admin actions, preflight and the
 * background refresher only.
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

/**
 * Health of every node, with BOUNDED concurrency. Probing path — admin
 * actions, preflight and the background refresher.
 */
export async function getClusterHealth(
  nodes: CentrifugoNode[],
  apiKey: string,
  options: { force?: boolean; concurrency?: number } = {}
): Promise<Record<string, NodeHealthSnapshot>> {
  const limit = Math.max(1, options.concurrency ?? 4);
  const map: Record<string, NodeHealthSnapshot> = {};
  const queue = [...nodes];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const node = queue.shift();
      if (!node) return;
      const r = await getNodeHealth(node, apiKey, { force: options.force });
      map[r.node_id] = r;
    }
  });
  await Promise.all(workers);
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
