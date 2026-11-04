/**
 * server/services/ai-agent/sourceWorker.ts — a claimed Data Hub job renews
 * its lock while it runs, scoped to the worker holding it. The claim locks a
 * job for 180 s and claimNextSourceSyncJob reclaims a running job whose lock
 * expired, so a longer crawl was otherwise started a second time.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const updates: Array<{ table: string; patch: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let patch: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        update: (p: Record<string, unknown>) => { patch = p; return b; },
        eq: (c: string, v: unknown) => { filters.push([c, v]); return b; },
        then: (resolve: (r: unknown) => unknown) => { updates.push({ table, patch, filters }); return resolve({ data: null, error: null }); },
      });
      return b;
    },
  }),
}));

const { holdSourceJobLease } = await import('../../../server/services/ai-agent/sourceWorker.js');

afterEach(() => { vi.useRealTimers(); updates.length = 0; });

describe('source-sync job lease', () => {
  it('renews the lock every third of the TTL, only for the holder', async () => {
    vi.useFakeTimers();
    const lease = holdSourceJobLease({} as never, 'job-1', 'worker-a', 180);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(updates).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe('ai_source_sync_jobs');
    expect(updates[0].filters).toEqual([['id', 'job-1'], ['status', 'running'], ['locked_by', 'worker-a']]);
    const until = Date.parse(String(updates[0].patch.lock_expires_at));
    expect(until - Date.now()).toBe(180_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(updates).toHaveLength(3);
    lease.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(updates).toHaveLength(3);
  });
});
