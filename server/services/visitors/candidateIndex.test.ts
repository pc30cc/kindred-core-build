/**
 * Ephemeral candidate index — unit tests.
 *
 * The invariant under test is architectural: discovery of silent-but-connected
 * visitors must never touch PostgreSQL, and reads must stay bounded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';

import {
  resolveCandidateIndexBackend,
  touchVisitorCandidate,
  listVisitorCandidates,
  removeVisitorCandidate,
  getCandidateIndexMetrics,
  resetCandidateIndex,
  candidateIndexKey,
} from './candidateIndex.js';
import { resetRedisClients } from '../../lib/redisClient.js';

const WS = '11111111-1111-4111-8111-111111111111';
const S1 = '22222222-2222-4222-8222-222222222222';
const S2 = '33333333-3333-4333-8333-333333333333';

/* ───────────────────── tiny in-process RESP2 server ───────────────────── */

interface FakeRedis {
  port: number;
  commands: string[][];
  zset: Map<string, Map<string, number>>;
  close(): Promise<void>;
}

async function startFakeRedis(): Promise<FakeRedis> {
  const zset = new Map<string, Map<string, number>>();
  const commands: string[][] = [];

  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // Parse as many complete RESP arrays of bulk strings as available.
      for (;;) {
        if (!buf.startsWith('*')) return;
        const lines = buf.split('\r\n');
        const argc = Number(lines[0].slice(1));
        const needed = 1 + argc * 2;
        if (lines.length < needed + 1) return;
        const args: string[] = [];
        for (let i = 0; i < argc; i += 1) args.push(lines[2 + i * 2]);
        buf = lines.slice(needed).join('\r\n');
        commands.push(args);
        socket.write(reply(args));
      }
    });
  });

  function reply(args: string[]): string {
    const cmd = args[0].toUpperCase();
    const key = args[1];
    if (cmd === 'ZADD') {
      const set = zset.get(key) ?? new Map<string, number>();
      zset.set(key, set);
      const existed = set.has(args[3]);
      set.set(args[3], Number(args[2]));
      return `:${existed ? 0 : 1}\r\n`;
    }
    if (cmd === 'ZREM') {
      zset.get(key)?.delete(args[2]);
      return ':1\r\n';
    }
    if (cmd === 'EXPIRE') return ':1\r\n';
    if (cmd === 'ZREMRANGEBYSCORE') {
      const set = zset.get(key);
      if (!set) return ':0\r\n';
      const max = Number(args[3].replace('(', ''));
      let n = 0;
      for (const [member, score] of [...set]) {
        if (score < max) {
          set.delete(member);
          n += 1;
        }
      }
      return `:${n}\r\n`;
    }
    if (cmd === 'ZRANGEBYSCORE') {
      const set = zset.get(key) ?? new Map<string, number>();
      const min = Number(args[2]);
      const members = [...set.entries()]
        .filter(([, score]) => score >= min)
        .sort((a, b) => a[1] - b[1])
        .map(([m]) => m);
      const parts = [`*${members.length}\r\n`];
      for (const m of members) parts.push(`$${m.length}\r\n${m}\r\n`);
      return parts.join('');
    }
    return '+OK\r\n';
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    commands,
    zset,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/* ─────────────────────────────── harness ──────────────────────────────── */

const supabaseCalls: string[] = [];
vi.mock('../../supabase.js', () => ({
  getServiceClient: () => {
    supabaseCalls.push('getServiceClient');
    throw new Error('candidate index must never touch PostgreSQL');
  },
}));

let deploymentMode = 'app_routed_redis';
vi.mock('../realtime/store.js', () => ({
  loadRealtimeConfig: async () => ({
    enabled: true,
    vendor: 'centrifugo',
    centrifugo: { deployment_mode: deploymentMode, presence_enabled: true },
  }),
}));

let channelsReply: string[] | null = null;
const channelsCalls: string[] = [];
vi.mock('../realtime/apiEndpoints.js', () => ({
  PRESENCE_READ_MAX_ENDPOINTS: 2,
  resolveCentrifugoApiEndpoints: async () => [
    {
      id: 'cluster',
      api_url: 'http://centrifugo/api',
      driver: {
        channels: async (pattern: string) => {
          channelsCalls.push(pattern);
          return channelsReply;
        },
      },
    },
  ],
}));

const config = {} as any;
let redis: FakeRedis;

beforeEach(async () => {
  redis = await startFakeRedis();
  process.env.VISITOR_CANDIDATE_INDEX_REDIS_URL = `redis://127.0.0.1:${redis.port}`;
  deploymentMode = 'app_routed_redis';
  channelsReply = null;
  channelsCalls.length = 0;
  supabaseCalls.length = 0;
  resetCandidateIndex();
  resetRedisClients();
});

afterEach(async () => {
  resetRedisClients();
  await redis.close();
  delete process.env.VISITOR_CANDIDATE_INDEX_REDIS_URL;
});

/* ──────────────────────────────── tests ───────────────────────────────── */

describe('candidate index — Redis backend (Mode 2/3)', () => {
  it('writes candidacy to Redis and never to PostgreSQL', async () => {
    const exp = Date.now() + 180_000;
    await touchVisitorCandidate(config, WS, S1, exp);

    expect(redis.zset.get(candidateIndexKey(WS))?.get(S1)).toBe(Math.floor(exp));
    expect(supabaseCalls).toEqual([]);
    expect(getCandidateIndexMetrics().touches).toBe(1);
  });

  it('lists live candidates and prunes expired leases by score', async () => {
    const now = Date.now();
    await touchVisitorCandidate(config, WS, S1, now + 120_000, now);
    await touchVisitorCandidate(config, WS, S2, now - 60_000, now);

    const result = await listVisitorCandidates(config, WS, 100, now);
    expect(result.backend).toBe('redis');
    expect(result.authoritative).toBe(true);
    expect(result.session_ids).toEqual([S1]);
    expect(redis.zset.get(candidateIndexKey(WS))?.has(S2)).toBe(false);
  });

  it('de-dupes repeated negotiations instead of re-writing', async () => {
    const now = Date.now();
    await touchVisitorCandidate(config, WS, S1, now + 180_000, now);
    await touchVisitorCandidate(config, WS, S1, now + 180_000, now + 1_000);
    const m = getCandidateIndexMetrics();
    expect(m.touches).toBe(1);
    expect(m.touches_deduped).toBe(1);
  });

  it('removes a candidate explicitly', async () => {
    await touchVisitorCandidate(config, WS, S1, Date.now() + 180_000);
    await removeVisitorCandidate(config, WS, S1);
    expect(redis.zset.get(candidateIndexKey(WS))?.has(S1)).toBe(false);
  });

  it('caps the page it asks Redis for', async () => {
    const now = Date.now();
    await listVisitorCandidates(config, WS, 25, now);
    const range = redis.commands.find((c) => c[0].toUpperCase() === 'ZRANGEBYSCORE');
    expect(range?.slice(-2)).toEqual(['0', '25']);
  });

  it('degrades to a non-authoritative empty list when Redis is unreachable', async () => {
    process.env.VISITOR_CANDIDATE_INDEX_REDIS_URL = 'redis://127.0.0.1:1';
    resetCandidateIndex();
    resetRedisClients();
    const result = await listVisitorCandidates(config, WS, 50);
    expect(result.session_ids).toEqual([]);
    expect(result.authoritative).toBe(false);
    expect(supabaseCalls).toEqual([]);
  });
});

describe('candidate index — backend selection', () => {
  it('uses Centrifugo active channels only in single_memory without Redis', async () => {
    delete process.env.VISITOR_CANDIDATE_INDEX_REDIS_URL;
    deploymentMode = 'single_memory';
    resetCandidateIndex();

    channelsReply = [`vp:v2:${WS}:${S1}`, `vp:v2:${WS}:${S2}`, 'ws:other:operators'];
    const result = await listVisitorCandidates(config, WS, 50);

    expect(result.backend).toBe('centrifugo_channels');
    expect(result.session_ids.sort()).toEqual([S1, S2].sort());
    expect(channelsCalls[0]).toBe(`vp:v2:${WS}:*`);
  });

  it('never uses the unbounded channels scan in multi-node mode', async () => {
    delete process.env.VISITOR_CANDIDATE_INDEX_REDIS_URL;
    deploymentMode = 'load_balanced_redis';
    resetCandidateIndex();

    const { backend } = await resolveCandidateIndexBackend(config);
    expect(backend).toBe('none');

    const result = await listVisitorCandidates(config, WS, 50);
    expect(result.backend).toBe('none');
    expect(result.authoritative).toBe(false);
    expect(channelsCalls).toEqual([]);
  });

  it('prefers Redis over the channels scan even in single_memory', async () => {
    deploymentMode = 'single_memory';
    resetCandidateIndex();
    const { backend } = await resolveCandidateIndexBackend(config);
    expect(backend).toBe('redis');
  });
});
