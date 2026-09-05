/**
 * REAL cross-node Centrifugo integration test.
 *
 * Starts, as real processes:
 *   • one Redis            (engine coordination, password-protected, noeviction)
 *   • Centrifugo rt-node-01 (redis engine)
 *   • Centrifugo rt-node-02 (redis engine)
 *
 * and then proves, over real WebSocket/HTTP traffic and through the SAME
 * application code paths used in production (`CentrifugoDriver`,
 * `getClusterHealth`, `selectNode`):
 *
 *   1. cross-node publish   — subscriber on node 2 receives a publish issued
 *                             through node 1's HTTP API
 *   2. cross-node presence  — a presence query on node 1 sees the client
 *                             attached to node 2
 *   3. per-node counts      — each node reports its OWN client count, and the
 *                             cluster total is kept separate
 *   4. drain                — a drained node gets no NEW assignment while its
 *                             existing connection stays alive
 *   5. node failure         — with node 2 stopped, assignment never returns it
 *   6. Redis outage         — presence becomes UNKNOWN (never a false
 *                             "offline"), and recovers when Redis returns
 *
 * Usage:
 *   CENTRIFUGO_BIN=/path/centrifugo REDIS_SERVER_BIN=/path/redis-server \
 *     bun run scripts/realtime/cross-node-integration.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';

import { CentrifugoDriver } from '../../server/services/realtime/centrifugo.js';
import { getClusterHealth, invalidateNodeHealth } from '../../server/services/realtime/nodeHealth.js';
import { selectNode } from '../../server/services/realtime/nodeRouter.js';
import {
  buildVisitorPresenceChannelName,
  buildVisitorPresenceSubject,
  normalizeNodes,
  type CentrifugoNode,
} from '../../server/services/realtime/types.js';

const CENTRIFUGO_BIN = process.env.CENTRIFUGO_BIN || 'centrifugo';
const REDIS_BIN = process.env.REDIS_SERVER_BIN || 'redis-server';
const REDIS_PORT = Number(process.env.RT_TEST_REDIS_PORT || 6399);
const REDIS_PASSWORD = 'rt-test-password';
const HMAC = 'rt-test-hmac-secret-rt-test-hmac-secret';
const API_KEY = 'rt-test-api-key';
const WORKSPACE = 'ws-test-0001';

const NAMESPACES = JSON.stringify([
  {
    name: 'ws',
    presence: true,
    join_leave: true,
    force_push_join_leave: false,
    history_size: 50,
    history_ttl: '300s',
    force_recovery: true,
    allow_subscribe_for_client: false,
    allow_publish_for_client: false,
    allow_presence_for_client: true,
    allow_history_for_client: true,
    subscribe_for_anonymous: false,
  },
  {
    // Visitor presence (scheme v2): one channel per session, backend-only
    // presence reads. Mirrors the production namespace contract documented in
    // server/services/realtime/types.ts.
    name: 'vp',
    presence: true,
    join_leave: false,
    history_size: 0,
    allow_subscribe_for_client: false,
    allow_publish_for_client: false,
    allow_presence_for_client: false,
    allow_history_for_client: false,
    subscribe_for_anonymous: false,
  },
]);

const children: ChildProcess[] = [];
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
let failures = 0;

function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

function startRedis(): ChildProcess {
  const p = spawn(
    REDIS_BIN,
    [
      '--port', String(REDIS_PORT),
      '--requirepass', REDIS_PASSWORD,
      '--save', '',
      '--appendonly', 'no',
      '--maxmemory', '128mb',
      '--maxmemory-policy', 'noeviction',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  children.push(p);
  return p;
}

function startNode(name: string, port: number): ChildProcess {
  const p = spawn(CENTRIFUGO_BIN, ['centrifugo'].slice(1), {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      CENTRIFUGO_NAME: name,
      CENTRIFUGO_ADDRESS: '127.0.0.1',
      CENTRIFUGO_PORT: String(port),
      CENTRIFUGO_ENGINE: 'redis',
      CENTRIFUGO_REDIS_ADDRESS: `redis://:${REDIS_PASSWORD}@127.0.0.1:${REDIS_PORT}`,
      CENTRIFUGO_REDIS_PREFIX: 'kindred-realtime-test',
      CENTRIFUGO_TOKEN_HMAC_SECRET_KEY: HMAC,
      CENTRIFUGO_API_KEY: API_KEY,
      CENTRIFUGO_API_INSECURE: 'false',
      CENTRIFUGO_ALLOWED_ORIGINS: '*',
      CENTRIFUGO_CLIENT_ANONYMOUS: 'false',
      CENTRIFUGO_NAMESPACES: NAMESPACES,
      CENTRIFUGO_HEALTH: 'true',
      CENTRIFUGO_LOG_LEVEL: 'error',
      CENTRIFUGO_ADMIN: 'false',
    },
  });
  children.push(p);
  return p;
}

async function waitHttp(url: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

function driverFor(port: number): CentrifugoDriver {
  return new CentrifugoDriver({
    ws_url: `ws://127.0.0.1:${port}/connection/websocket`,
    api_url: `http://127.0.0.1:${port}/api`,
    api_key: API_KEY,
    token_hmac_secret: HMAC,
  });
}

function registryNode(id: string, port: number, over: Partial<CentrifugoNode> = {}): CentrifugoNode {
  return normalizeNodes([
    {
      id,
      name: id,
      node_name: id,
      ws_url: `ws://127.0.0.1:${port}/connection/websocket`,
      api_url: `http://127.0.0.1:${port}/api`,
      ...over,
    },
  ])[0];
}

function connToken(sub: string): string {
  return jwt.sign({ sub, info: { workspace_id: WORKSPACE } }, HMAC, {
    algorithm: 'HS256',
    expiresIn: 600,
  });
}

function subToken(sub: string, channel: string): string {
  return jwt.sign({ sub, channel, info: { workspace_id: WORKSPACE } }, HMAC, {
    algorithm: 'HS256',
    expiresIn: 600,
  });
}

/** Minimal Centrifugo v5 JSON-protocol client (no SDK needed). */
class RawClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (v: any) => void>();
  readonly publications: any[] = [];

  constructor(private readonly port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/connection/websocket`);
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      for (const line of String(raw).split('\n')) {
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        } else if (msg.push?.pub) {
          this.publications.push({ channel: msg.push.channel, data: msg.push.pub.data });
        }
      }
    });
  }

  private send(payload: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout on ${JSON.stringify(payload)}`)), 8000);
      this.pending.set(id, (v) => {
        clearTimeout(t);
        resolve(v);
      });
      this.ws.send(JSON.stringify({ id, ...payload }));
    });
  }

  connect(token: string) {
    return this.send({ connect: { token } });
  }

  subscribe(channel: string, token: string) {
    return this.send({ subscribe: { channel, token } });
  }

  presence(channel: string) {
    return this.send({ presence: { channel } });
  }

  get isOpen() {
    return this.ws.readyState === WebSocket.OPEN;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function cleanup() {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  console.log('# starting redis + rt-node-01 + rt-node-02 (real processes)');
  startRedis();
  await sleep(700);
  const n1 = startNode('rt-node-01', 8001);
  const n2 = startNode('rt-node-02', 8002);
  const up1 = await waitHttp('http://127.0.0.1:8001/health');
  const up2 = await waitHttp('http://127.0.0.1:8002/health');
  record('nodes_started', up1 && up2, `node1=${up1} node2=${up2}`);
  if (!up1 || !up2) return;

  const d1 = driverFor(8001);
  const d2 = driverFor(8002);

  // ── shared engine discovery ──────────────────────────────────────────
  const i1 = await d1.info({ nodeName: 'rt-node-01' });
  const i2 = await d2.info({ nodeName: 'rt-node-02' });
  record(
    'redis_shared_engine',
    (i1.num_nodes ?? 0) >= 2 && (i2.num_nodes ?? 0) >= 2,
    `node1 sees ${i1.num_nodes} node(s), node2 sees ${i2.num_nodes} node(s)`,
  );

  // ── 1. cross-node publish ────────────────────────────────────────────
  const convChannel = `ws:${WORKSPACE}:conv:c1`;
  const subscriber = new RawClient(8002);
  await subscriber.open();
  const conn = await subscriber.connect(connToken('visitor-1'));
  const sub = await subscriber.subscribe(convChannel, subToken('visitor-1', convChannel));
  record(
    'subscriber_attached_node2',
    !!conn.connect && !!sub.subscribe,
    `connect=${!!conn.connect} subscribe=${!!sub.subscribe}`,
  );
  const payload = { kind: 'integration', nonce: Date.now() };
  const pub = await d1.publish(convChannel, payload);
  let received: any = null;
  for (let i = 0; i < 40 && !received; i += 1) {
    await sleep(100);
    received = subscriber.publications.find((p) => p.data?.nonce === payload.nonce) ?? null;
  }
  record(
    'cross_node_publish',
    pub.ok && !!received,
    `published via node1 (${pub.ok}), received on node2 subscriber: ${JSON.stringify(received?.data ?? null)}`,
  );

  // ── 2. cross-node presence ───────────────────────────────────────────
  const opChannel = `ws:${WORKSPACE}:operators`;
  const opA = new RawClient(8001);
  await opA.open();
  await opA.connect(connToken('operator-A'));
  await opA.subscribe(opChannel, subToken('operator-A', opChannel));
  const opB = new RawClient(8002);
  await opB.open();
  await opB.connect(connToken('operator-B'));
  await opB.subscribe(opChannel, subToken('operator-B', opChannel));
  await sleep(500);
  const presenceViaNode1 = await d1.presenceUsers(opChannel);
  const presenceViaNode2 = await d2.presenceUsers(opChannel);
  const bothOn1 = !!presenceViaNode1 && ['operator-A', 'operator-B'].every((u) => presenceViaNode1.includes(u));
  const bothOn2 = !!presenceViaNode2 && ['operator-A', 'operator-B'].every((u) => presenceViaNode2.includes(u));
  record(
    'cross_node_presence',
    bothOn1 && bothOn2,
    `node1 sees [${presenceViaNode1?.sort().join(', ')}], node2 sees [${presenceViaNode2?.sort().join(', ')}]`,
  );

  // ── 2b. cross-node VISITOR presence (vp:v2, batched stats) ───────────
  // Proves the real production read path: a visitor subscribed through node 2
  // is counted by a `presence_stats` batch issued against node 1.
  const sessionOn2 = '11111111-1111-4111-8111-111111111111';
  const sessionAbsent = '22222222-2222-4222-8222-222222222222';
  const vpChannel = buildVisitorPresenceChannelName(WORKSPACE, sessionOn2);
  const vpAbsentChannel = buildVisitorPresenceChannelName(WORKSPACE, sessionAbsent);
  const vpSub = buildVisitorPresenceSubject(sessionOn2);
  const vpClient = new RawClient(8002);
  await vpClient.open();
  await vpClient.connect(connToken(vpSub));
  const vpSubReply = await vpClient.subscribe(vpChannel, subToken(vpSub, vpChannel));
  await sleep(500);
  const statsViaNode1 = await d1.presenceStatsBatch([vpChannel, vpAbsentChannel]);
  const statsViaNode2 = await d2.presenceStatsBatch([vpChannel, vpAbsentChannel]);
  record(
    'cross_node_visitor_presence_v2',
    !!vpSubReply.subscribe &&
      statsViaNode1?.get(vpChannel) === 1 &&
      statsViaNode2?.get(vpChannel) === 1 &&
      statsViaNode1?.get(vpAbsentChannel) === 0,
    `subscribe=${!!vpSubReply.subscribe}; node1 sees ${statsViaNode1?.get(vpChannel)} client(s), ` +
      `node2 sees ${statsViaNode2?.get(vpChannel)}, absent session=${statsViaNode1?.get(vpAbsentChannel)}`,
  );

  // A visitor must never be able to read presence itself — the namespace
  // forbids it, so shard-mates (and everyone else) stay unobservable.
  const clientPresence: any = await vpClient
    .presence(vpChannel)
    .catch((e: any) => ({ error: { message: String(e?.message || e) } }));
  record(
    'visitor_cannot_read_presence',
    !!clientPresence?.error,
    `client presence call rejected: ${JSON.stringify(clientPresence?.error ?? clientPresence)}`,
  );

  vpClient.close();
  await sleep(300);
  const statsAfterClose = await d1.presenceStatsBatch([vpChannel]);
  record(
    'visitor_presence_clears_on_disconnect',
    statsAfterClose?.get(vpChannel) === 0,
    `after close node1 sees ${statsAfterClose?.get(vpChannel)} client(s)`,
  );

  // ── 3. per-node connection counts ────────────────────────────────────
  // Centrifugo gossips per-node info over the engine on an interval (~3s),
  // so `info` counts are eventually consistent by design. We wait one gossip
  // window before asserting — and the router treats these counts as
  // approximate for exactly this reason (see nodeRouter.ts).
  await sleep(6000);
  invalidateNodeHealth();
  const reg = [registryNode('rt-node-01', 8001), registryNode('rt-node-02', 8002)];
  const health = await getClusterHealth(reg, API_KEY, { force: true });
  const c1 = health['rt-node-01']?.connections;
  const c2 = health['rt-node-02']?.connections;
  const clusterTotal = health['rt-node-01']?.cluster_connections;
  // node1: operator-A. node2: visitor-1 + operator-B.
  record(
    'per_node_connection_counts',
    c1 === 1 && c2 === 2 && clusterTotal === 3,
    `rt-node-01=${c1}, rt-node-02=${c2}, cluster total=${clusterTotal}`,
  );

  // ── 4. drain ─────────────────────────────────────────────────────────
  const drainedReg = [
    registryNode('rt-node-01', 8001),
    registryNode('rt-node-02', 8002, { draining: true, accepting_new_connections: false }),
  ];
  const picks = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const r = selectNode(drainedReg, await Promise.resolve(health));
    if (r.node) picks.add(r.node.id);
  }
  const drainOk = picks.size === 1 && picks.has('rt-node-01') && subscriber.isOpen;
  record(
    'drain_no_new_connections_existing_alive',
    drainOk,
    `200 assignments → [${[...picks].join(', ')}]; existing node2 socket still open: ${subscriber.isOpen}`,
  );

  // ── 5. node failure ──────────────────────────────────────────────────
  n2.kill('SIGKILL');
  await sleep(1500);
  invalidateNodeHealth();
  const healthAfterKill = await getClusterHealth(reg, API_KEY, { force: true });
  const picksAfterKill = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const r = selectNode(reg, healthAfterKill);
    if (r.node) picksAfterKill.add(r.node.id);
  }
  record(
    'node_failure_excluded_from_assignment',
    healthAfterKill['rt-node-02']?.status === 'down' && !picksAfterKill.has('rt-node-02'),
    `node2 status=${healthAfterKill['rt-node-02']?.status}; 200 assignments → [${[...picksAfterKill].join(', ')}]`,
  );

  // ── 6. Redis outage + recovery ───────────────────────────────────────
  const redisProc = children[0];
  redisProc.kill('SIGKILL');
  await sleep(2000);
  const presenceDuringOutage = await d1.presenceUsers(opChannel);
  record(
    'redis_outage_no_false_offline',
    presenceDuringOutage === null || presenceDuringOutage.length > 0,
    `presence during outage = ${presenceDuringOutage === null ? 'UNKNOWN (null → callers fall back)' : JSON.stringify(presenceDuringOutage)}`,
  );

  startRedis();
  await sleep(3000);
  const recoveredChannel = `ws:${WORKSPACE}:conv:c2`;
  const recoverSub = new RawClient(8001);
  await recoverSub.open();
  await recoverSub.connect(connToken('visitor-2'));
  await recoverSub.subscribe(recoveredChannel, subToken('visitor-2', recoveredChannel));
  const nonce2 = Date.now();
  const pub2 = await d1.publish(recoveredChannel, { kind: 'recovery', nonce: nonce2 });
  let got2: any = null;
  for (let i = 0; i < 50 && !got2; i += 1) {
    await sleep(100);
    got2 = recoverSub.publications.find((p) => p.data?.nonce === nonce2) ?? null;
  }
  record('redis_recovery', pub2.ok && !!got2, `publish ok=${pub2.ok}, delivered=${!!got2}`);

  subscriber.close();
  opA.close();
  opB.close();
  recoverSub.close();
  void n1;
}

main()
  .catch((err) => {
    console.error('integration run failed:', err);
    failures += 1;
  })
  .finally(async () => {
    cleanup();
    await sleep(300);
    console.log('\n# summary');
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
    process.exit(failures ? 1 : 0);
  });
