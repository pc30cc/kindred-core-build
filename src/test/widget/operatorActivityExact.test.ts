/**
 * CROSS-NODE ACTIVITY MUST BE EXACT.
 *
 * The coarse `operator_activity_samples` fallback (5-minute buckets) could
 * keep an operator "active" for up to ~10 minutes when the beat landed on
 * another node. With the exact ephemeral index configured, `away` must
 * trigger at exactly 5 minutes and the coarse fallback must NOT run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const zset = new Map<string, Map<string, number>>();
let bucketReads = 0;

const redis = {
  async command(cmd: string, key: string, a?: any, b?: any) {
    const set = zset.get(key) || new Map<string, number>();
    zset.set(key, set);
    if (cmd === 'ZADD') { set.set(String(b), Number(a)); return 1; }
    if (cmd === 'ZSCORE') { const v = set.get(String(a)); return v === undefined ? null : String(v); }
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
      gte: async () => { bucketReads += 1; return { data: [] }; },
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
  OPERATOR_ACTIVITY_ACTIVE_MS,
} = mod;

const T0 = Date.parse('2026-01-07T12:00:01Z');

describe('exact cross-node operator activity', () => {
  beforeEach(() => {
    zset.clear();
    bucketReads = 0;
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

  it('does not consult the coarse analytics buckets when the exact index answers', async () => {
    await publishOperatorActivity('ws', 'u1', T0);
    await getOperatorLastActivity({} as any, 'ws', ['u1'], new Date(T0 + 10 * 60_000));
    expect(bucketReads).toBe(0);
  });

  it('coalesces repeated writes into at most one command per window', async () => {
    await publishOperatorActivity('ws', 'u1', T0);
    await publishOperatorActivity('ws', 'u1', T0 + 1_000);
    await publishOperatorActivity('ws', 'u1', T0 + 5_000);
    expect(zset.get('op:activity:ws')!.get('u1')).toBe(T0);
  });

  it('falls back to the analytics buckets only when no exact index is configured', async () => {
    delete process.env.OPERATOR_ACTIVITY_REDIS_URL;
    delete process.env.REALTIME_REDIS_URL;
    await getOperatorLastActivity({} as any, 'ws', ['u1'], new Date(T0));
    expect(bucketReads).toBe(1);
  });
});
