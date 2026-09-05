/**
 * Centrifugo Node Registry.
 *
 * Durable, shared between every app instance: nodes live inside the SAME
 * `app_runtime_config` record as the rest of the realtime provider config
 * (key `default_realtime_provider`), so no new schema is introduced and the
 * existing cache-invalidation path already covers it.
 *
 * State that must be shared (enabled / draining / weight / maintenance) is
 * therefore never process-local. Only the ephemeral health cache is local.
 *
 * Secrets are cluster-level (CentrifugoConfig.api_key + token_hmac_secret)
 * and are NOT duplicated per node. Redis credentials are never stored here.
 */

import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { loadRealtimeConfig, saveRealtimeConfig } from './store.js';
import { invalidateNodeHealth } from './nodeHealth.js';
import {
  normalizeNodes,
  resolveDeploymentMode,
  type CentrifugoDeploymentMode,
  type CentrifugoNode,
} from './types.js';

export interface NodeInput {
  id?: string;
  name?: string;
  /** Runtime Centrifugo node name (CENTRIFUGO_NAME). Defaults to the id. */
  node_name?: string;
  ws_url: string;
  api_url: string;
  enabled?: boolean;
  accepting_new_connections?: boolean;
  draining?: boolean;
  weight?: number;
  region?: string;
}

export async function listNodes(config: ServerConfig): Promise<CentrifugoNode[]> {
  const cfg = await loadRealtimeConfig(config);
  return normalizeNodes(cfg.centrifugo?.nodes);
}

export async function getDeploymentMode(config: ServerConfig): Promise<CentrifugoDeploymentMode> {
  const cfg = await loadRealtimeConfig(config);
  return resolveDeploymentMode(cfg.centrifugo);
}

async function writeNodes(config: ServerConfig, nodes: CentrifugoNode[]): Promise<CentrifugoNode[]> {
  const cfg = await loadRealtimeConfig(config, true);
  await saveRealtimeConfig(config, {
    ...cfg,
    centrifugo: { ...(cfg.centrifugo || {}), nodes },
  });
  invalidateNodeHealth();
  return nodes;
}

function slugId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return base || `rt-node-${randomUUID().slice(0, 8)}`;
}

export async function addNode(config: ServerConfig, input: NodeInput): Promise<CentrifugoNode[]> {
  const nodes = await listNodes(config);
  const id = (input.id?.trim() || slugId(input.name?.trim() || `rt-node-${nodes.length + 1}`));
  if (nodes.some((n) => n.id === id)) throw new Error(`Node id "${id}" already exists`);
  const now = new Date().toISOString();
  const node: CentrifugoNode = {
    id,
    name: input.name?.trim() || id,
    node_name: input.node_name?.trim() || id,
    ws_url: input.ws_url.trim(),
    api_url: input.api_url.trim(),
    enabled: input.enabled !== false,
    accepting_new_connections: input.accepting_new_connections !== false,
    draining: input.draining === true,
    weight: Number.isFinite(input.weight) && (input.weight as number) >= 0 ? (input.weight as number) : 1,
    region: input.region?.trim() || undefined,
    created_at: now,
    updated_at: now,
  };
  return writeNodes(config, [...nodes, node]);
}

export async function updateNode(
  config: ServerConfig,
  id: string,
  patch: Partial<NodeInput>
): Promise<CentrifugoNode[]> {
  const nodes = await listNodes(config);
  const idx = nodes.findIndex((n) => n.id === id);
  if (idx === -1) throw new Error(`Node "${id}" not found`);
  const prev = nodes[idx];
  const next: CentrifugoNode = {
    ...prev,
    name: patch.name?.trim() || prev.name,
    node_name: patch.node_name?.trim() || prev.node_name || prev.id,
    ws_url: patch.ws_url?.trim() || prev.ws_url,
    api_url: patch.api_url?.trim() || prev.api_url,
    enabled: patch.enabled === undefined ? prev.enabled : patch.enabled,
    accepting_new_connections:
      patch.accepting_new_connections === undefined
        ? prev.accepting_new_connections
        : patch.accepting_new_connections,
    draining: patch.draining === undefined ? prev.draining : patch.draining,
    weight:
      patch.weight === undefined || !Number.isFinite(patch.weight) || (patch.weight as number) < 0
        ? prev.weight
        : (patch.weight as number),
    region: patch.region === undefined ? prev.region : patch.region.trim() || undefined,
    updated_at: new Date().toISOString(),
  };
  const copy = [...nodes];
  copy[idx] = next;
  invalidateNodeHealth(id);
  return writeNodes(config, copy);
}

export async function removeNode(config: ServerConfig, id: string): Promise<CentrifugoNode[]> {
  const nodes = await listNodes(config);
  if (!nodes.some((n) => n.id === id)) throw new Error(`Node "${id}" not found`);
  invalidateNodeHealth(id);
  return writeNodes(config, nodes.filter((n) => n.id !== id));
}

/**
 * Drain / resume. Draining removes a node from NEW connection selection but
 * NEVER disconnects the clients already attached to it — they migrate on
 * their own natural reconnect.
 */
export async function setNodeDraining(
  config: ServerConfig,
  id: string,
  draining: boolean
): Promise<CentrifugoNode[]> {
  return updateNode(config, id, { draining, accepting_new_connections: !draining });
}
