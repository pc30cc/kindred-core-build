/**
 * Realtime Node Router.
 *
 * Picks ONE Centrifugo node for a new client connection in
 * `app_routed_redis` mode. Contract (plan §C):
 *   • no PostgreSQL write per selection
 *   • no global counter
 *   • disabled / draining / not-accepting / down nodes are never selected
 *   • weights are honoured
 *   • deterministic under an injected RNG, so it is fully testable
 *
 * Algorithm: weighted power-of-two-choices. Two candidates are drawn with
 * probability proportional to `weight`; the one with the lower reported live
 * connection count wins (ties → higher weight → stable id order). This
 * spreads load without a shared counter and without herding every new
 * connection onto whichever node last looked idle.
 */

/**
 * Least-connections is APPROXIMATE by design.
 *
 * Verified against real Centrifugo v5.4.5 + Redis (see
 * scripts/realtime/cross-node-integration.ts): per-node client counts in the
 * `info` reply are gossiped over the engine on an interval (~3s), so they lag
 * reality by up to one gossip window. The router therefore uses them as a
 * balancing HINT only — never as an admission-control authority. Correctness
 * (drain / disable / health exclusion) comes from administrative node state
 * and the health status, both of which are authoritative.
 */
import type { CentrifugoNode } from './types.js';
import type { NodeHealthSnapshot } from './nodeHealth.js';

export type NodeHealthMap = Record<string, NodeHealthSnapshot | undefined>;

export interface NodeSelectionResult {
  node: CentrifugoNode | null;
  reason:
    | 'selected'
    | 'no_nodes_configured'
    | 'no_enabled_nodes'
    | 'no_accepting_nodes'
    | 'no_healthy_nodes';
  eligible_count: number;
}

/** Nodes an admin has not taken out of rotation. */
export function eligibleNodes(nodes: CentrifugoNode[]): CentrifugoNode[] {
  return nodes.filter((n) => n.enabled && !n.draining && n.accepting_new_connections && n.weight > 0);
}

function isSelectableHealth(h: NodeHealthSnapshot | undefined): boolean {
  // `unknown` is allowed only as a last resort (handled by the caller below):
  // here we accept anything that is not proven bad.
  return h?.status === 'healthy' || h?.status === 'degraded';
}

function weightedPick(pool: CentrifugoNode[], rand: () => number): CentrifugoNode {
  const total = pool.reduce((sum, n) => sum + n.weight, 0);
  if (total <= 0) return pool[0];
  let r = rand() * total;
  for (const n of pool) {
    r -= n.weight;
    if (r <= 0) return n;
  }
  return pool[pool.length - 1];
}

function better(a: CentrifugoNode, b: CentrifugoNode, health: NodeHealthMap): CentrifugoNode {
  const ca = health[a.id]?.connections;
  const cb = health[b.id]?.connections;
  if (typeof ca === 'number' && typeof cb === 'number' && ca !== cb) return ca < cb ? a : b;
  if (a.weight !== b.weight) return a.weight > b.weight ? a : b;
  return a.id <= b.id ? a : b;
}

/**
 * Select a node for a NEW connection. Pure — no I/O, no clock dependency
 * beyond what the caller already resolved into `health`.
 */
export function selectNode(
  nodes: CentrifugoNode[],
  health: NodeHealthMap = {},
  rand: () => number = Math.random
): NodeSelectionResult {
  if (!nodes.length) return { node: null, reason: 'no_nodes_configured', eligible_count: 0 };

  const enabled = nodes.filter((n) => n.enabled);
  if (!enabled.length) return { node: null, reason: 'no_enabled_nodes', eligible_count: 0 };

  const accepting = eligibleNodes(nodes);
  if (!accepting.length) return { node: null, reason: 'no_accepting_nodes', eligible_count: 0 };

  // Prefer nodes with positive health evidence. Only if NONE of the
  // accepting nodes has been probed yet do we fall back to `unknown` ones —
  // a cold process must still be able to serve traffic, but a node that is
  // proven down is never chosen while a provably-usable one exists.
  const proven = accepting.filter((n) => isSelectableHealth(health[n.id]));
  // Two kinds of `unknown` exist and they are NOT interchangeable:
  //   never_probed_unknown — no cache entry at all (cold process start).
  //                          Selectable as a last resort, otherwise a fresh
  //                          process could serve nothing.
  //   stale_unknown        — probed before, evidence aged out (`stale: true`).
  //                          NEVER selectable: a stalled health refresher must
  //                          not put a node that may be down back in rotation.
  const unknownOnly = accepting.filter((n) => {
    const h = health[n.id];
    if (h && h.status === 'unknown' && h.stale) return false;
    return (h?.status ?? 'unknown') === 'unknown';
  });
  const pool = proven.length ? proven : unknownOnly;
  if (!pool.length) return { node: null, reason: 'no_healthy_nodes', eligible_count: accepting.length };

  if (pool.length === 1) return { node: pool[0], reason: 'selected', eligible_count: pool.length };

  const first = weightedPick(pool, rand);
  const rest = pool.filter((n) => n.id !== first.id);
  const second = weightedPick(rest, rand);
  return { node: better(first, second, health), reason: 'selected', eligible_count: pool.length };
}
