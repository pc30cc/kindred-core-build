import type { ServerConfig } from '../../server/config.js';
import { getServiceClient } from '../../server/supabase.js';
import { loadRealtimeConfig } from '../../server/services/realtime/store.js';
import {
  normalizeNodes,
  resolveDeploymentMode,
} from '../../server/services/realtime/types.js';
import { CentrifugoDriver } from '../../server/services/realtime/centrifugo.js';
import { getRedisClient } from '../../server/lib/redisClient.js';
import { AI_RUNTIME_ROUTES } from '../../shared/ai/internalRoutes.js';

export interface OpsSnapshot {
  captured_at: string;
  database: {
    read_ok: boolean;
    latency_ms: number;
  };
  ai_runtime: {
    configured: boolean;
    healthy: boolean | null;
    latency_ms: number | null;
  };
  realtime: {
    enabled: boolean;
    vendor: string;
    deployment_mode: string;
    presence_enabled: boolean;
    fallback_policy: string | null;
    nodes: Array<{
      id: string;
      name: string;
      enabled: boolean;
      draining: boolean;
      accepting_new_connections: boolean;
      health: string;
      clients: number | null;
      users: number | null;
      channels: number | null;
      cluster_nodes_seen: number | null;
    }>;
    cluster_clients: number | null;
  };
  redis: {
    configured: boolean;
    healthy: boolean | null;
    latency_ms: number | null;
    used_memory_bytes: number | null;
    used_memory_human: string | null;
    connected_clients: number | null;
    ops_per_sec: number | null;
    evicted_keys: number | null;
    rejected_connections: number | null;
    endpoint: string | null;
  };
}

function numberOrNull(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseRedisInfo(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function redisUrl(): string | null {
  return (
    process.env.VISITOR_CANDIDATE_INDEX_REDIS_URL ||
    process.env.REALTIME_REDIS_URL ||
    ''
  ).trim() || null;
}

function safeRedisEndpoint(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const db = u.pathname && u.pathname !== '/' ? u.pathname : '';
    return `${u.protocol}//${u.hostname}:${u.port || '6379'}${db}`;
  } catch {
    return null;
  }
}

async function collectDatabase(config: ServerConfig): Promise<OpsSnapshot['database']> {
  const started = Date.now();
  try {
    const sb = getServiceClient(config);
    const { error } = await sb.from('app_runtime_config').select('key').limit(1);
    return { read_ok: !error, latency_ms: Date.now() - started };
  } catch {
    return { read_ok: false, latency_ms: Date.now() - started };
  }
}

async function collectAiRuntime(config: ServerConfig): Promise<OpsSnapshot['ai_runtime']> {
  if (!config.aiRuntimeBaseUrl) {
    return { configured: false, healthy: null, latency_ms: null };
  }
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2_500);
  try {
    const res = await fetch(`${config.aiRuntimeBaseUrl}${AI_RUNTIME_ROUTES.health}`, { signal: ctrl.signal });
    return {
      configured: true,
      healthy: res.ok,
      latency_ms: Date.now() - started,
    };
  } catch {
    return {
      configured: true,
      healthy: false,
      latency_ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function collectRedis(): Promise<OpsSnapshot['redis']> {
  const url = redisUrl();
  if (!url) {
    return {
      configured: false,
      healthy: null,
      latency_ms: null,
      used_memory_bytes: null,
      used_memory_human: null,
      connected_clients: null,
      ops_per_sec: null,
      evicted_keys: null,
      rejected_connections: null,
      endpoint: null,
    };
  }
  const started = Date.now();
  try {
    const client = getRedisClient(url);
    const pong = await client.command('PING');
    const infoRaw = await client.command('INFO');
    const info = parseRedisInfo(typeof infoRaw === 'string' ? infoRaw : '');
    return {
      configured: true,
      healthy: pong === 'PONG',
      latency_ms: Date.now() - started,
      used_memory_bytes: numberOrNull(info.used_memory),
      used_memory_human: info.used_memory_human || null,
      connected_clients: numberOrNull(info.connected_clients),
      ops_per_sec: numberOrNull(info.instantaneous_ops_per_sec),
      evicted_keys: numberOrNull(info.evicted_keys),
      rejected_connections: numberOrNull(info.rejected_connections),
      endpoint: safeRedisEndpoint(url),
    };
  } catch {
    return {
      configured: true,
      healthy: false,
      latency_ms: Date.now() - started,
      used_memory_bytes: null,
      used_memory_human: null,
      connected_clients: null,
      ops_per_sec: null,
      evicted_keys: null,
      rejected_connections: null,
      endpoint: safeRedisEndpoint(url),
    };
  }
}

async function collectRealtime(config: ServerConfig): Promise<OpsSnapshot['realtime']> {
  try {
    const cfg = await loadRealtimeConfig(config);
    const c = cfg.centrifugo;
    const mode = resolveDeploymentMode(c);
    const nodes = normalizeNodes(c?.nodes);
    const result: OpsSnapshot['realtime'] = {
      enabled: !!cfg.enabled,
      vendor: cfg.vendor,
      deployment_mode: mode,
      presence_enabled: !!c?.presence_enabled,
      fallback_policy: cfg.fallback_policy ?? null,
      nodes: [],
      cluster_clients: null,
    };

    if (!cfg.enabled || cfg.vendor !== 'centrifugo' || !c?.api_url || !c?.api_key) return result;

    if (nodes.length > 0) {
      const checks = await Promise.all(
        nodes.map(async (node) => {
          const driver = new CentrifugoDriver({
            ...c,
            ws_url: node.ws_url,
            api_url: node.api_url,
          } as any);
          const info = await driver.info({ nodeName: node.node_name || node.id });
          const own = info.nodes.find((n) => n.name === (node.node_name || node.id));
          return {
            id: node.id,
            name: node.name || node.id,
            enabled: node.enabled,
            draining: node.draining,
            accepting_new_connections: node.accepting_new_connections,
            health: info.status,
            clients: info.num_clients ?? own?.num_clients ?? null,
            users: own?.num_users ?? null,
            channels: own?.num_channels ?? null,
            cluster_nodes_seen: info.num_nodes ?? null,
            clusterClients: info.cluster_num_clients ?? null,
          };
        }),
      );
      result.nodes = checks.map(({ clusterClients: _clusterClients, ...node }) => node);
      result.cluster_clients = checks.find((n) => n.clusterClients != null)?.clusterClients ?? null;
      return result;
    }

    const driver = new CentrifugoDriver(c as any);
    const info = await driver.info();
    const own = info.nodes[0];
    result.nodes = [{
      id: 'single',
      name: own?.name || 'single',
      enabled: true,
      draining: false,
      accepting_new_connections: true,
      health: info.status,
      clients: info.num_clients ?? own?.num_clients ?? info.cluster_num_clients ?? null,
      users: own?.num_users ?? null,
      channels: own?.num_channels ?? null,
      cluster_nodes_seen: info.num_nodes ?? 1,
    }];
    result.cluster_clients = info.cluster_num_clients ?? info.num_clients ?? null;
    return result;
  } catch {
    return {
      enabled: false,
      vendor: 'unknown',
      deployment_mode: 'unknown',
      presence_enabled: false,
      fallback_policy: null,
      nodes: [],
      cluster_clients: null,
    };
  }
}

export async function collectOpsSnapshot(config: ServerConfig): Promise<OpsSnapshot> {
  const [database, ai_runtime, realtime, redis] = await Promise.all([
    collectDatabase(config),
    collectAiRuntime(config),
    collectRealtime(config),
    collectRedis(),
  ]);
  return {
    captured_at: new Date().toISOString(),
    database,
    ai_runtime,
    realtime,
    redis,
  };
}

export function formatOpsStatus(snapshot: OpsSnapshot): string {
  const healthyNodes = snapshot.realtime.nodes.filter((n) => n.health === 'healthy').length;
  const lines = [
    'وضعیت فنی لحظه‌ای',
    '',
    `DB read: ${snapshot.database.read_ok ? 'OK' : 'DOWN'} (${snapshot.database.latency_ms}ms)`,
    `AI Runtime: ${snapshot.ai_runtime.configured ? (snapshot.ai_runtime.healthy ? 'OK' : 'DOWN') : 'NOT CONFIGURED'}${snapshot.ai_runtime.latency_ms == null ? '' : ` (${snapshot.ai_runtime.latency_ms}ms)`}`,
    `Realtime: ${snapshot.realtime.vendor} / ${snapshot.realtime.deployment_mode}`,
    `Centrifugo nodes: ${healthyNodes}/${snapshot.realtime.nodes.length} healthy`,
    `Cluster clients: ${snapshot.realtime.cluster_clients ?? 'unknown'}`,
    `Redis: ${snapshot.redis.configured ? (snapshot.redis.healthy ? 'OK' : 'DOWN') : 'NOT CONFIGURED'}${snapshot.redis.latency_ms == null ? '' : ` (${snapshot.redis.latency_ms}ms)`}`,
  ];
  if (snapshot.redis.used_memory_human) lines.push(`Redis memory: ${snapshot.redis.used_memory_human}`);
  if (snapshot.redis.ops_per_sec != null) lines.push(`Redis ops/s: ${snapshot.redis.ops_per_sec}`);
  if (snapshot.redis.evicted_keys != null) lines.push(`Redis evicted_keys: ${snapshot.redis.evicted_keys}`);
  return lines.join('\n');
}

export function formatRealtimeStatus(snapshot: OpsSnapshot): string {
  const lines = [
    `Realtime: ${snapshot.realtime.vendor}`,
    `Mode: ${snapshot.realtime.deployment_mode}`,
    `Presence: ${snapshot.realtime.presence_enabled ? 'enabled' : 'disabled'}`,
    `Cluster clients: ${snapshot.realtime.cluster_clients ?? 'unknown'}`,
    '',
  ];
  if (!snapshot.realtime.nodes.length) lines.push('No Centrifugo node information available.');
  for (const n of snapshot.realtime.nodes) {
    lines.push(
      `${n.name}: ${n.health}`,
      `  clients=${n.clients ?? '?'} users=${n.users ?? '?'} channels=${n.channels ?? '?'}`,
      `  enabled=${n.enabled} drain=${n.draining} accept_new=${n.accepting_new_connections}`,
    );
  }
  return lines.join('\n');
}

export function formatRedisStatus(snapshot: OpsSnapshot): string {
  if (!snapshot.redis.configured) return 'Redis/Valkey برای Realtime در env این worker تنظیم نشده است.';
  return [
    `Redis: ${snapshot.redis.healthy ? 'OK' : 'DOWN'}`,
    `Endpoint: ${snapshot.redis.endpoint ?? 'configured'}`,
    `Latency: ${snapshot.redis.latency_ms ?? '?'}ms`,
    `Memory: ${snapshot.redis.used_memory_human ?? snapshot.redis.used_memory_bytes ?? '?'}`,
    `Connected clients: ${snapshot.redis.connected_clients ?? '?'}`,
    `Ops/s: ${snapshot.redis.ops_per_sec ?? '?'}`,
    `Evicted keys: ${snapshot.redis.evicted_keys ?? '?'}`,
    `Rejected connections: ${snapshot.redis.rejected_connections ?? '?'}`,
  ].join('\n');
}
