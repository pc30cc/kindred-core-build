/**
 * claimNextJob — two workers can never both win a reclaimed job.
 *
 * A job whose lease expired is `running` before the claim and `running` after
 * it, so a claim UPDATE conditioned on (id, status) alone matched for every
 * worker that had read the same candidate: both ran it. The claim now also
 * matches the `attempts` it read, which every claim increments.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type JobRow = Record<string, unknown> & { id: string; status: string; attempts: number; max_attempts: number };

let rows: Record<string, JobRow> = {};

/** Candidate reads return a snapshot; updates apply AND-ed equality filters. */
function makeSb() {
  return {
    from: () => {
      const candidate = {
        select: () => candidate,
        in: () => candidate,
        or: () => candidate,
        order: () => candidate,
        limit: () => candidate,
        maybeSingle: async () => ({ data: { ...Object.values(rows)[0] }, error: null }),
        update: (patch: Record<string, unknown>) => {
          const filters: Array<[string, unknown]> = [];
          const chain = {
            eq: (col: string, val: unknown) => {
              filters.push([col, val]);
              return chain;
            },
            in: () => chain,
            select: () => chain,
            maybeSingle: async () => {
              const target = Object.values(rows).find((r) => filters.every(([c, v]) => r[c] === v));
              if (!target) return { data: null, error: null };
              Object.assign(target, patch);
              return { data: { ...target }, error: null };
            },
          };
          return chain;
        },
      };
      return candidate;
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => makeSb() }));

const { claimNextJob } = await import('../../../server/services/jobs/queue.js');
const config = {} as Parameters<typeof claimNextJob>[0];
const args = (workerId: string) => ({ jobTypes: ['seo_crawl'], workerId, lockTtlSeconds: 120 });

beforeEach(() => {
  rows = {
    'job-1': {
      id: 'job-1',
      status: 'running',
      attempts: 1,
      max_attempts: 3,
      locked_by: 'crashed-worker',
      lock_expires_at: new Date(Date.now() - 60_000).toISOString(),
    },
  };
});

describe('claimNextJob — reclaiming an expired lease', () => {
  it('only one of two workers that read the same candidate wins', async () => {
    const [a, b] = await Promise.all([claimNextJob(config, args('worker-a')), claimNextJob(config, args('worker-b'))]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(rows['job-1'].attempts).toBe(2);
    expect(rows['job-1'].locked_by).toBe(winners[0]?.locked_by);
  });

  it('a queued job is still claimed normally', async () => {
    rows['job-1'] = { id: 'job-1', status: 'queued', attempts: 0, max_attempts: 3 };
    const job = await claimNextJob(config, args('worker-a'));
    expect(job?.status).toBe('running');
    expect(rows['job-1'].attempts).toBe(1);
  });
});
