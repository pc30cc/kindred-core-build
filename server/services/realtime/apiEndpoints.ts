/**
 * Topology-aware Centrifugo API endpoints.
 *
 * Reads (presence, info) must talk to a node that is actually up. In a
 * multi-node deployment the cluster-level `api_url` points at ONE node, so a
 * single dead node would make every presence read fail and push every
 * workspace into database fallback even though the cluster is healthy.
 *
 * This resolver returns an ORDERED, BOUNDED list of endpoints:
 *   1. the cluster-level API url (Mode 1, and the admin/LB entry in Mode 3),
 *   2. registered nodes that are enabled and not known-down.
 *
 * It never probes: it only peeks at the cache the background health refresher
 * fills, so resolving endpoints costs zero network calls. Callers try at most
 * two endpoints and then fall back to PostgreSQL — a presence read must never
 * fan out across the cluster.
 */
import type { ServerConfig } from '../../config.js';
import { CentrifugoDriver } from './centrifugo.js';
import { loadRealtimeConfig } from './store.js';
import { normalizeNodes } from './types.js';
import { peekNodeHealth } from './nodeHealth.js';

export interface CentrifugoApiEndpoint {
  /** Registry node id, or `cluster` for the configured cluster-level url. */
  id: string;
  api_url: string;
  driver: CentrifugoDriver;
}

/** Max endpoints a single read may try (primary + one alternate). */
export const PRESENCE_READ_MAX_ENDPOINTS = 2;

export async function resolveCentrifugoApiEndpoints(
  config: ServerConfig,
): Promise<CentrifugoApiEndpoint[]> {
  let cfg: Awaited<ReturnType<typeof loadRealtimeConfig>>;
  try {
    cfg = await loadRealtimeConfig(config);
  } catch {
    return [];
  }
  const c = cfg.centrifugo;
  if (!c?.api_key) return [];

  const secret = c.token_hmac_secret ?? '';
  const seen = new Set<string>();
  const out: CentrifugoApiEndpoint[] = [];

  const push = (id: string, apiUrl: string | undefined | null) => {
    const url = (apiUrl || '').trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({
      id,
      api_url: url,
      driver: new CentrifugoDriver({
        ws_url: c.ws_url ?? '',
        api_url: url,
        api_key: c.api_key!,
        token_hmac_secret: secret,
      }),
    });
  };

  push('cluster', c.api_url);

  for (const node of normalizeNodes(c.nodes)) {
    if (!node.enabled) continue;
    // `draining` only blocks NEW client connections; the node still holds
    // connections whose presence we must be able to read.
    const health = peekNodeHealth(node.id);
    if (health && health.status === 'down') continue;
    push(node.id, node.api_url);
  }

  return out;
}
