/**
 * A DROPPED ANALYTICS TABLE MUST STOP BEING QUERIED.
 *
 * `operator_activity_samples` is removed by the Live Monitoring cleanup. The
 * coarse fallback read has a latch meant to notice that and stop asking, but
 * it only armed on Postgres 42P01 and explicitly refused PostgREST's PGRST205.
 * PostgREST resolves an unknown relation from its schema cache and never
 * issues the statement, so 42P01 can never arrive — the latch could never arm
 * and the read 404'd forever (~104 requests/day observed in production).
 *
 * These tests pin the corrected contract:
 *   - PGRST205 twice in a row  → latched (the real dropped-table case)
 *   - PGRST205 once, then fine → NOT latched (transient stale schema cache)
 *   - 42P01                    → latched immediately
 *   - unrelated errors         → never latch
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let bucketReads = 0;
let nextError: { code?: string; message?: string; details?: string } | null = null;

// No Redis ⇒ the exact index cannot answer, so the coarse fallback always runs.
vi.mock('../../../server/lib/redisClient.js', () => ({ getRedisClient: () => null }));
vi.mock('../../../server/lib/redisClient', () => ({ getRedisClient: () => null }));

const fakeClient = {
  from() {
    const api: any = {
      select: () => api,
      eq: () => api,
      in: () => api,
      gte: async () => {
        bucketReads += 1;
        return { data: null, error: nextError };
      },
    };
    return api;
  },
};
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient }));
vi.mock('../../../server/supabase', () => ({ getServiceClient: () => fakeClient }));

const mod = await import('../../../server/services/widget/operatorActivity');
const { getOperatorLastActivity, resetOperatorActivity } = mod as any;

const PGRST205 = {
  code: 'PGRST205',
  message: "Could not find the table 'public.operator_activity_samples' in the schema cache",
};
const UNDEFINED_TABLE = {
  code: '42P01',
  message: 'relation "public.operator_activity_samples" does not exist',
};

/** One coarse read for a user the local map knows nothing about. */
const read = () => getOperatorLastActivity({} as any, 'ws', ['u1'], new Date());

describe('operator_activity_samples missing-table latch', () => {
  beforeEach(() => {
    resetOperatorActivity();
    bucketReads = 0;
    nextError = null;
  });

  it('latches after two consecutive PGRST205 answers and stops querying', async () => {
    nextError = PGRST205;
    await read();
    await read();
    expect(bucketReads).toBe(2);

    // Latched — no further requests, however many times it is asked.
    await read();
    await read();
    expect(bucketReads).toBe(2);
  });

  it('does not latch on a single PGRST205 followed by a healthy read', async () => {
    nextError = PGRST205;
    await read();
    nextError = null; // schema cache settled; the table really does exist
    await read();
    expect(bucketReads).toBe(2);

    // Still enabled: the blip must not have disabled the read.
    await read();
    expect(bucketReads).toBe(3);
  });

  it('latches immediately on 42P01, which is definitive', async () => {
    nextError = UNDEFINED_TABLE;
    await read();
    expect(bucketReads).toBe(1);

    await read();
    expect(bucketReads).toBe(1);
  });

  it('never latches on errors that are not about this relation', async () => {
    nextError = { code: '42P01', message: 'relation "public.something_else" does not exist' };
    await read();
    nextError = { code: 'PGRST205', message: "Could not find the table 'public.other' in the schema cache" };
    await read();
    nextError = { code: '42501', message: 'permission denied for table operator_activity_samples' };
    await read();
    nextError = { code: '42703', message: 'column "bucket" of operator_activity_samples does not exist' };
    await read();
    expect(bucketReads).toBe(4);

    await read();
    expect(bucketReads).toBe(5);
  });
});
