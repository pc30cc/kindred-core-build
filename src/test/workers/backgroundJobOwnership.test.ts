/**
 * server/services/jobs/queue.ts — a worker's terminal writes on
 * background_jobs are scoped to the lease it holds (`locked_by`). A worker
 * whose lease lapsed has had the job reclaimed by another; its late failure
 * used to re-queue (or fail, or complete) the run the other worker owned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
let rows: Record<string, Row> = {};

function makeSb() {
  return {
    from: () => {
      const filters: Record<string, unknown> = {};
      const read: Record<string, unknown> = {
        select: () => read,
        eq: (col: string, val: unknown) => { filters[col] = val; return read; },
        maybeSingle: async () => ({ data: rows[filters.id as string] || null, error: null }),
        update: (patch: Row) => {
          let targetId: string | undefined;
          let ok = true;
          const chain: Record<string, unknown> = {
            eq: (col: string, val: unknown) => {
              if (col === 'id') targetId = val as string;
              else if (!targetId || rows[targetId]?.[col] !== val) ok = false;
              return chain;
            },
            in: (col: string, vals: unknown[]) => {
              if (!targetId || !vals.includes(rows[targetId]?.[col])) ok = false;
              return chain;
            },
            select: () => chain,
            maybeSingle: async () => {
              const hit = ok && targetId && rows[targetId];
              if (hit) Object.assign(rows[targetId as string], patch);
              return { data: hit ? rows[targetId as string] : null, error: null };
            },
          };
          return chain;
        },
      };
      return read;
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => makeSb() }));

const { failJob, completeJob, heartbeatJob } = await import('../../../server/services/jobs/queue.js');
const CONFIG = {} as Parameters<typeof failJob>[0];

beforeEach(() => {
  // worker-a's lease lapsed and worker-b reclaimed the job.
  rows = { 'job-1': { id: 'job-1', status: 'processing', attempts: 2, max_attempts: 3, locked_by: 'worker-b' } };
});

describe('background_jobs terminal writes are scoped to the lease holder', () => {
  it("a worker that lost the lease cannot re-queue the new holder's run", async () => {
    const res = await failJob(CONFIG, { jobId: 'job-1', errorMessage: 'timed out', errorCategory: 'timeout', retryable: true, workerId: 'worker-a' });
    expect(res).toEqual({ updated: false, finalStatus: undefined });
    expect(rows['job-1']).toMatchObject({ status: 'processing', locked_by: 'worker-b' });
  });

  it("a worker that lost the lease cannot complete the new holder's run", async () => {
    expect((await completeJob(CONFIG, { jobId: 'job-1', workerId: 'worker-a' })).updated).toBe(false);
    expect(rows['job-1'].status).toBe('processing');
  });

  it('the holder completes, and fails, its own job', async () => {
    expect((await completeJob(CONFIG, { jobId: 'job-1', workerId: 'worker-b' })).updated).toBe(true);
    expect(rows['job-1'].status).toBe('completed');
    rows['job-1'] = { id: 'job-1', status: 'processing', attempts: 2, max_attempts: 3, locked_by: 'worker-b' };
    const res = await failJob(CONFIG, { jobId: 'job-1', errorMessage: 'timed out', errorCategory: 'timeout', retryable: true, workerId: 'worker-b' });
    expect(res.finalStatus).toBe('queued');
  });

  it('a heartbeat of a lost lease reports it, so a crawl stops', async () => {
    const hb = await heartbeatJob(CONFIG, { jobId: 'job-1', workerId: 'worker-a', lockTtlSeconds: 120 });
    expect(hb).toMatchObject({ ok: false, leaseLost: true });
    const mine = await heartbeatJob(CONFIG, { jobId: 'job-1', workerId: 'worker-b', lockTtlSeconds: 120 });
    expect(mine.ok).toBe(true);
  });
});
