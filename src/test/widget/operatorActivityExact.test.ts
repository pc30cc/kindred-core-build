/**
 * CROSS-NODE ACTIVITY MUST BE EXACT — AND MUST NEVER TOUCH POSTGRESQL.
 *
 * A coarse 5-minute analytics fallback used to sit behind this module and
 * could keep an operator "active" for up to ~10 minutes when the beat landed
 * on another node. It was removed with the `operator_activity_samples` table.
 * With the exact ephemeral index configured, `away` must trigger at exactly
 * 5 minutes; without one, the module must degrade to the process-local map
 * rather than read the database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const zset = new Map<string, Map<string, number>>();
let dbReads = 0;

// Set to false to emulate a Redis/Valkey older than 6.2 (no ZADD GT).
export let supportsGt = true;
export const setSupportsGt = (v: boolean) => { supportsGt = v; };

const redis = {
  async command(cmd: string, key: string, ...rest: any[]) {
    const set = zset.get(key) || new Map<string, number>();
    zset.set(key, set);
    if (cmd === 'ZADD') {
      const flags = rest.filter(r => typeof r === 'string' && /^(GT|LT|CH|NX|XX)$/i.test(String(r)));
      if (flags.length && !supportsGt) throw new Error("ERR syntax error");
      const args = rest.slice(flags.length);
      const score = Number(args[0]);
      const member = String(args[1]);
      const cur = set.get(member);
      const gt = flags.some(f => String(f).toUpperCase() === 'GT');
      if (gt && cur !== undefined && score <= cur) return 0;
      set.set(member, score);
      return 1;
    }
    if (cmd === 'EVAL') {
      // numkeys, key, score, member
      const indexKey = String(rest[1]);
      const s2 = zset.get(indexKey) || new Map<string, number>();
      zset.set(indexKey, s2);
      const score = Number(rest[2]);
      const member = String(rest[3]);
      const cur = s2.get(member);
      if (cur === undefined || cur < score) { s2.set(member, score); return 1; }
      return 0;
    }
    if (cmd === 'ZSCORE') { const v = set.get(String(rest[0])); return v === undefined ? null : String(v); }
    if (cmd === 'ZREMRANGEBYSCORE' || cmd === 'EXPIRE') return 1;
    return null;
  },
};

vi.mock('../../../server/lib/redisClient.js', () => ({ getRedisClient: () => redis }));
vi.mock('../../../server/lib/redisClient', () => ({ getRedisClient: () => redis }));

const fakeClient = {
  from() {
    const api: any = {
      select: () => api,
      eq: () => api,
      in: () => api,
      gte: async () => { dbReads += 1; return { data: [] }; },
    };
    return api;
  },
};
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient }));
vi.mock('../../../server/supabase', () => ({ getServiceClient: () => fakeClient }));

const mod = await import('../../../server/services/widget/operatorActivity');
const {
  publishOperatorActivity,
  getOperatorLastActivity,
  resetOperatorActivity,
  flushOperatorActivityWrites,
  __evictActivityCoalesceState,
  OPERATOR_ACTIVITY_ACTIVE_MS,
} = mod as any;

const T0 = Date.parse('2026-01-07T12:00:01Z');

describe('exact cross-node operator activity', () => {
  beforeEach(() => {
    zset.clear();
    dbReads = 0;
    setSupportsGt(true);
    resetOperatorActivity();
    process.env.OPERATOR_ACTIVITY_REDIS_URL = 'redis://127.0.0.1:6379';
  });
  afterEach(() => { delete process.env.OPERATOR_ACTIVITY_REDIS_URL; });

  it('stores the exact interaction timestamp, not a 5-minute bucket', async () => {
    await publishOperatorActivity('ws', 'u1', T0);
    const got = await getOperatorLastActivity({} as any, 'ws', ['u1'], new Date(T0 + 60_000));
    expect(got.get('u1')).toBe(T0);
  });

  it('is still active at 4m59s and away at exactly 5m — never ~10m', async () => {
    await publishOperatorActivity('ws', 'u1', T0);
    const at = async (ms: number) => {
      const now = new Date(T0 + ms);
      const m = await getOperatorLastActivity({} as any, 'ws', ['u1'], now);
      return now.getTime() - (m.get('u1') || 0) < OPERATOR_ACTIVITY_ACTIVE_MS;
    };
    expect(await at(OPERATOR_ACTIVITY_ACTIVE_MS - 1_000)).toBe(true);
    expect(await at(OPERATOR_ACTIVITY_ACTIVE_MS)).toBe(false);
    expect(await at(OPERATOR_ACTIVITY_ACTIVE_MS + 60_000)).toBe(false);
  });

  it('reads no database row when the exact index answers', async () => {
    await publishOperatorActivity('ws', 'u1', T0);
    await getOperatorLastActivity({} as any, 'ws', ['u1'], new Date(T0 + 10 * 60_000));
    expect(dbReads).toBe(0);
  });

  it('coalesces repeated writes into at most one command per window', async () => {
    await publishOperatorActivity('ws', 'u1', T0);
    await publishOperatorActivity('ws', 'u1', T0 + 1_000);
    await publishOperatorActivity('ws', 'u1', T0 + 5_000);
    expect(zset.get('op:activity:ws')!.get('u1')).toBe(T0);
  });

  it('degrades to the local map — never a database read — with no exact index', async () => {
    delete process.env.OPERATOR_ACTIVITY_REDIS_URL;
    delete process.env.REALTIME_REDIS_URL;
    await getOperatorLastActivity({} as any, 'ws', ['u1'], new Date(T0));
    // The analytics-bucket fallback was removed with its table: this path must
    // now issue ZERO PostgreSQL reads, whatever the Redis configuration.
    expect(dbReads).toBe(0);
  });
});

/**
 * TRAILING-EDGE FLUSH — coalescing must never lose the LAST real interaction
 * of a window, otherwise another node flips the operator to `away` up to
 * ACTIVITY_WRITE_COALESCE_MS too early.
 */
describe('trailing-edge flush of coalesced activity', () => {
  beforeEach(() => {
    zset.clear();
    dbReads = 0;
    setSupportsGt(true);
    resetOperatorActivity();
    process.env.OPERATOR_ACTIVITY_REDIS_URL = 'redis://127.0.0.1:6379';
  });
  afterEach(() => { delete process.env.OPERATOR_ACTIVITY_REDIS_URL; });

  it('writes the last interaction of the window, not the first', async () => {
    await publishOperatorActivity('ws', 'u1', T0);
    await publishOperatorActivity('ws', 'u1', T0 + 19_000); // coalesced
    expect(zset.get('op:activity:ws')!.get('u1')).toBe(T0);

    await mod.flushOperatorActivityWrites();
    expect(zset.get('op:activity:ws')!.get('u1')).toBe(T0 + 19_000);
  });

  it('keeps the 5-minute threshold anchored on the real last interaction', async () => {
    await publishOperatorActivity('ws', 'u1', T0);
    await publishOperatorActivity('ws', 'u1', T0 + 19_000);
    await mod.flushOperatorActivityWrites();

    const activeAt = async (ms: number) => {
      const now = new Date(T0 + ms);
      const m = await getOperatorLastActivity({} as any, 'ws', ['u1'], now);
      return now.getTime() - (m.get('u1') || 0) < OPERATOR_ACTIVITY_ACTIVE_MS;
    };
    expect(await activeAt(OPERATOR_ACTIVITY_ACTIVE_MS)).toBe(true);
    expect(await activeAt(OPERATOR_ACTIVITY_ACTIVE_MS + 18_999)).toBe(true);
    expect(await activeAt(OPERATOR_ACTIVITY_ACTIVE_MS + 19_000)).toBe(false);
  });
});


/**
 * REGRESSION: the Redis score must be MONOTONIC.
 *
 * A trailing-flush timer armed before the coalescing map was evicted can fire
 * after a newer immediate write; the older timestamp must never win.
 */
describe('monotonic operator activity writes', () => {
  beforeEach(() => {
    zset.clear();
    resetOperatorActivity();
    setSupportsGt(true);
    process.env.OPERATOR_ACTIVITY_REDIS_URL = 'redis://127.0.0.1:6379';
  });
  afterEach(() => { delete process.env.OPERATOR_ACTIVITY_REDIS_URL; });

  const score = () => zset.get('op:activity:ws')?.get('u1');

  const raceScenario = async () => {
    await publishOperatorActivity('ws', 'u1', T0);              // immediate T0
    await publishOperatorActivity('ws', 'u1', T0 + 10_000);     // coalesced → pending
    __evictActivityCoalesceState();                             // MAX_ENTRIES clear
    await publishOperatorActivity('ws', 'u1', T0 + 15_000);     // immediate T0+15s
    await flushOperatorActivityWrites();                        // stale trailing T0+10s
  };

  it('keeps the newest timestamp when a stale trailing flush fires (ZADD GT)', async () => {
    await raceScenario();
    expect(score()).toBe(T0 + 15_000);
  });

  it('keeps the newest timestamp on servers without ZADD GT (Lua CAS fallback)', async () => {
    setSupportsGt(false);
    await raceScenario();
    expect(score()).toBe(T0 + 15_000);
  });
});
