/**
 * Connection assignment — the ONLY place that decides which public
 * WebSocket URL a client is handed.
 *
 * The backend contract is unchanged in every mode: the backend authorizes,
 * mints a short-lived JWT and returns a ws_url. The browser then connects
 * DIRECTLY to Centrifugo. WebSocket traffic never flows through Express.
 *
 *   single_memory        → the single configured ws_url
 *   app_routed_redis     → ws_url of the node picked by the node router
 *   load_balanced_redis  → the load balancer ws_url (single public entry)
 *
 * No PostgreSQL write happens on this path.
 */

import type { ServerConfig } from '../../config.js';
import { loadRealtimeConfig } from './store.js';
import { snapshotClusterHealth } from './nodeHealth.js';
import { selectNode } from './nodeRouter.js';
import {
  normalizeNodes,
  resolveDeploymentMode,
  type CentrifugoDeploymentMode,
} from './types.js';

export interface RealtimeAssignment {
  mode: CentrifugoDeploymentMode;
  ws_url: string | null;
  node_id?: string;
  reason: string;
}

export async function assignRealtimeEndpoint(config: ServerConfig): Promise<RealtimeAssignment> {
  const cfg = await loadRealtimeConfig(config);
  const c = cfg.centrifugo;
  const mode = resolveDeploymentMode(c);

  if (mode === 'single_memory') {
    return { mode, ws_url: c?.ws_url ?? null, reason: 'single_node' };
  }

  if (mode === 'load_balanced_redis') {
    const lb = c?.load_balancer_ws_url?.trim() || c?.ws_url?.trim() || null;
    return { mode, ws_url: lb, reason: lb ? 'load_balancer' : 'load_balancer_not_configured' };
  }

  // app_routed_redis — ONLY nodes registered in the Node Registry (i.e. proven
  // members of the same Redis-backed cluster) may be assigned.
  //
  // The legacy single `ws_url` is NEVER used as a fallback here: it typically
  // points at a Mode 1 memory-engine Centrifugo, and sending a client there
  // would split-brain presence, publish and cross-node coordination. When no
  // registered node is usable we return `ws_url: null` and let the existing
  // provider-level degradation (Centrifugo → polling/database fallback) decide.
  // A legacy endpoint can only ever be handed out once it is explicitly
  // registered as a node of this cluster.
  //
  // Health is read from the cache snapshot only — no HTTP fan-out on this path.
  const nodes = normalizeNodes(c?.nodes);
  const health = snapshotClusterHealth(nodes);
  const picked = selectNode(nodes, health);
  if (picked.node) {
    return { mode, ws_url: picked.node.ws_url, node_id: picked.node.id, reason: 'node_router' };
  }
  return { mode, ws_url: null, reason: picked.reason };
}

