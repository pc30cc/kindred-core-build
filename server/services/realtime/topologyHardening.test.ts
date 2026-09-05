/**
 * Stabilization/Hardening pass — regression tests.
 *
 * These are UNIT tests. They prove the code-level invariants only; real
 * cross-node publish/presence behaviour is proven separately by the Redis +
 * two-node integration test (scripts/realtime/cross-node-integration.mjs).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { normalizeCentrifugoNodeInfo, CentrifugoDriver } from './centrifugo.js';
import {
  getClusterHealth,
  snapshotClusterHealth,
  invalidateNodeHealth,
  getHealthProbeCount,
  resetHealthProbeCount,
  peekNodeHealth,
} from './nodeHealth.js';
import { assignRealtimeEndpoint } from './assignment.js';

import { nextRefreshDelay } from './healthRefresher.js';
import { normalizeNodes, type CentrifugoNode } from './types.js';
import { isMissingRpcError } from '../widget/visitorLiveness.js';

// The realtime config store is the only I/O `assignRealtimeEndpoint` performs.
let storedConfig: any = null;
vi.mock('./store.js', () => ({
  loadRealtimeConfig: async () => storedConfig,
  saveRealtimeConfig: async () => {},
  invalidateRealtimeCache: () => {},
}));

const node = (id: string, over: Partial<CentrifugoNode> = {}): CentrifugoNode =>
  normalizeNodes([
    {
      id,
      name: id,
      ws_url: `wss://${id}.example.com/connection/websocket`,
      api_url: `http://${id}:8000/api`,
      ...over,
    },
  ])[0];

/** Fake Centrifugo `info` reply: the cluster view every node returns. */
function infoReply(nodes: Array<{ name: string; num_clients: number }>) {
  return {
    ok: true,
    json: async () => ({ result: { nodes: nodes.map((n) => ({ ...n, uid: `${n.name}-uid` })) } }),
  } as any;
}

const CLUSTER = [
  { name: 'rt-node-01', num_clients: 100 },
  { name: 'rt-node-02', num_clients: 300 },
];

describe('info(): per-node vs cluster connection counts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('attributes each node its OWN count and keeps the cluster total separate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => infoReply(CLUSTER)));
    const driver = new CentrifugoDriver({
      ws_url: 'wss://x/connection/websocket',
      api_url: 'http://x:8000/api',
      api_key: 'k',
      token_hmac_secret: 's',
    });
    const a = await driver.info({ nodeName: 'rt-node-01' });
    const b = await driver.info({ nodeName: 'rt-node-02' });
    expect(a.num_clients).toBe(100);
    expect(b.num_clients).toBe(300);
    expect(a.cluster_num_clients).toBe(400);
    expect(b.cluster_num_clients).toBe(400);
    expect(a.num_nodes).toBe(2);
  });

  it('reports an unknown count instead of faking the cluster total', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => infoReply(CLUSTER)));
    const driver = new CentrifugoDriver({
      ws_url: 'wss://x/connection/websocket',
      api_url: 'http://x:8000/api',
      api_key: 'k',
      token_hmac_secret: 's',
    });
    const r = await driver.info({ nodeName: 'rt-node-99' });
    expect(r.num_clients).toBeUndefined();
    expect(r.node_name_matched).toBe(false);
    expect(r.cluster_num_clients).toBe(400);
  });

  it('normalizes node info without inventing values', () => {
    expect(normalizeCentrifugoNodeInfo([{ name: ' n1 ', num_clients: 5 }, null, 3])).toEqual([
      { name: 'n1', uid: undefined, num_clients: 5, num_users: undefined, num_channels: undefined, version: undefined },
    ]);
    expect(normalizeCentrifugoNodeInfo(undefined)).toEqual([]);
  });
});

describe('node health cache: per-node counts', () => {
  beforeEach(() => {
    invalidateNodeHealth();
    resetHealthProbeCount();
  });
  afterEach(() => vi.restoreAllMocks());

  it('stores each node its own live count, not the cluster total', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => infoReply(CLUSTER)));
    const nodes = [node('rt-node-01'), node('rt-node-02')];
    const health = await getClusterHealth(nodes, 'key', { force: true });
    expect(health['rt-node-01'].connections).toBe(100);
    expect(health['rt-node-02'].connections).toBe(300);
    expect(health['rt-node-01'].cluster_connections).toBe(400);
    expect(health['rt-node-01'].cluster_nodes).toBe(2);
  });
});

describe('assignment path is network-free', () => {
  const config = {} as any;

  beforeEach(() => {
    invalidateNodeHealth();
    resetHealthProbeCount();
  });
  afterEach(() => vi.restoreAllMocks());

  async function withConfig(centrifugo: any) {
    storedConfig = {
      vendor: 'centrifugo',
      enabled: true,
      fallback_policy: 'lenient',
      fallback_vendor: 'polling_builtin',
      centrifugo,
    };
  }

  it('Mode 2 with all nodes down NEVER returns the legacy memory ws_url', async () => {
    const nodes = [node('rt-node-01'), node('rt-node-02')];
    await withConfig({
      deployment_mode: 'app_routed_redis',
      // A leftover Mode 1 / memory-engine endpoint.
      ws_url: 'wss://legacy-memory.example.com/connection/websocket',
      api_key: 'key',
      token_hmac_secret: 's',
      nodes,
    });
    // Prove the nodes are down in the cache.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }) as any));
    await getClusterHealth(nodes, 'key', { force: true });

    const a = await assignRealtimeEndpoint(config);
    expect(a.mode).toBe('app_routed_redis');
    expect(a.ws_url).toBeNull();
    expect(a.reason).toBe('no_healthy_nodes');
  });

  it('1000 assignments issue ZERO health HTTP probes after warmup', async () => {
    const nodes = [node('rt-node-01'), node('rt-node-02')];
    await withConfig({
      deployment_mode: 'app_routed_redis',
      api_key: 'key',
      token_hmac_secret: 's',
      nodes,
    });
    const fetchMock = vi.fn(async () => infoReply(CLUSTER));
    vi.stubGlobal('fetch', fetchMock);

    // Warmup = what the BACKGROUND refresher does.
    await getClusterHealth(nodes, 'key', { force: true });
    const probesAfterWarmup = getHealthProbeCount();
    fetchMock.mockClear();

    for (let i = 0; i < 1000; i += 1) {
      const a = await assignRealtimeEndpoint(config);
      expect(a.ws_url).toBeTruthy();
    }
    expect(getHealthProbeCount()).toBe(probesAfterWarmup);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('a node drained right now is not handed out any more (no stale reuse)', async () => {
    const nodes = [node('rt-node-01', { enabled: false }), node('rt-node-02')];
    await withConfig({ deployment_mode: 'app_routed_redis', api_key: 'key', token_hmac_secret: 's', nodes });
    vi.stubGlobal('fetch', vi.fn(async () => infoReply(CLUSTER)));
    await getClusterHealth(nodes, 'key', { force: true });
    const first = await assignRealtimeEndpoint(config);
    expect(first.node_id).toBe('rt-node-02');

    // Drain node 2 — the health cache still says "healthy" for it.
    const drained = [node('rt-node-01', { enabled: false }), node('rt-node-02', { draining: true, accepting_new_connections: false })];
    await withConfig({ deployment_mode: 'app_routed_redis', api_key: 'key', token_hmac_secret: 's', nodes: drained });
    const after = await assignRealtimeEndpoint(config);
    expect(after.node_id).toBeUndefined();
    expect(after.ws_url).toBeNull();
  });

  it('Mode 1 keeps returning the single ws_url (regression-free)', async () => {
    await withConfig({ ws_url: 'wss://rt.example.com/connection/websocket', api_key: 'k', token_hmac_secret: 's' });
    const a = await assignRealtimeEndpoint(config);
    expect(a.mode).toBe('single_memory');
    expect(a.ws_url).toBe('wss://rt.example.com/connection/websocket');
  });
});

describe('health snapshot semantics', () => {
  beforeEach(() => invalidateNodeHealth());

  it('snapshotClusterHealth performs no probing and omits unknown nodes', () => {
    const snap = snapshotClusterHealth([node('rt-node-01')]);
    expect(snap).toEqual({});
    expect(peekNodeHealth('rt-node-01')).toBeNull();
  });
});

describe('health refresher jitter', () => {
  it('spreads the cadence so instances never probe in lockstep', () => {
    expect(nextRefreshDelay(() => 0)).toBeLessThan(nextRefreshDelay(() => 1));
    expect(nextRefreshDelay(() => 0.5)).toBe(8000);
  });
});

describe('visitor liveness RPC fallback is missing-function only', () => {
  it('does NOT fall back on a generic 404', () => {
    expect(isMissingRpcError({ code: '404', message: 'Not Found' })).toBe(false);
    expect(isMissingRpcError({ status: 404, message: 'not found' })).toBe(false);
  });

  it('falls back only for a genuinely missing visitor_touch_liveness', () => {
    expect(isMissingRpcError({ code: '42883' })).toBe(true);
    expect(isMissingRpcError({ code: 'PGRST202' })).toBe(true);
    expect(
      isMissingRpcError({ message: 'Could not find the function public.visitor_touch_liveness in the schema cache' }),
    ).toBe(true);
    expect(isMissingRpcError({ message: 'permission denied for function visitor_touch_liveness' })).toBe(false);
    expect(isMissingRpcError({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(false);
  });
});
