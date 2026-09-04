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
import { getClusterHealth } from './nodeHealth.js';
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

  // app_routed_redis
  const nodes = normalizeNodes(c?.nodes);
  const health = await getClusterHealth(nodes, c?.api_key || '');
  const picked = selectNode(nodes, health);
  if (picked.node) {
    return { mode, ws_url: picked.node.ws_url, node_id: picked.node.id, reason: 'node_router' };
  }
  // No usable node — fall back to the legacy single ws_url when one is still
  // configured (typical during a Mode 1 → Mode 2 migration), else signal
  // "no endpoint" so the caller degrades to polling instead of handing out a
  // dead socket URL.
  if (c?.ws_url) {
    return { mode, ws_url: c.ws_url, reason: `${picked.reason}:legacy_ws_url` };
  }
  return { mode, ws_url: null, reason: picked.reason };
}
