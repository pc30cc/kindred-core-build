/**
 * Finished commerce sync jobs are pruned.
 *
 * Every reconciliation pass enqueues one job per connected store — 96 a day
 * each — and nothing removed them. Succeeded jobs now go after a week,
 * dead-lettered ones (listed by the admin diagnostics) after a month; queued
 * and running jobs are never touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface JobRow { id: string; status: string; updated_at: string }

let jobs: JobRow[] = [];
let failDeletes = false;

function table() {
  const filters: Array<(r: JobRow) => boolean> = [];
  let limit = Infinity;
  let deleting = false;
  const q = {
    select: () => q,
    delete: () => {
      deleting = true;
      return q;
    },
    eq: (col: keyof JobRow, v: string) => {
      filters.push((r) => r[col] === v);
      return q;
    },
    lt: (col: keyof JobRow, v: string) => {
      filters.push((r) => r[col] < v);
      return q;
    },
    in: (col: keyof JobRow, vs: string[]) => {
      filters.push((r) => vs.includes(r[col]));
      return q;
    },
    limit: (n: number) => {
      limit = n;
      return q;
    },
    then: (resolve: (v: unknown) => unknown) => {
      const hit = jobs.filter((r) => filters.every((f) => f(r)));
      if (deleting) {
        if (failDeletes) return resolve({ data: null, error: { message: 'boom' } });
        jobs = jobs.filter((r) => !hit.includes(r));
        return resolve({ data: null, error: null });
      }
      return resolve({ data: hit.slice(0, limit).map((r) => ({ id: r.id })), error: null });
    },
  };
  return q;
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => ({ from: () => table() }) }));
vi.mock('../../../server/services/commerce/credentials.js', () => ({ readInstallationSecret: async () => 'secret' }));

const { pruneFinishedSyncJobs } = await import('../../../server/services/commerce/sync.js');
const config = {} as Parameters<typeof pruneFinishedSyncJobs>[0];

const NOW = Date.parse('2026-09-26T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

beforeEach(() => {
  failDeletes = false;
  jobs = [
    { id: 'ok-old', status: 'succeeded', updated_at: daysAgo(8) },
    { id: 'ok-new', status: 'succeeded', updated_at: daysAgo(2) },
    { id: 'dead-old', status: 'dead_letter', updated_at: daysAgo(31) },
    { id: 'dead-new', status: 'dead_letter', updated_at: daysAgo(10) },
    { id: 'queued-old', status: 'queued', updated_at: daysAgo(90) },
    { id: 'running-old', status: 'running', updated_at: daysAgo(90) },
  ];
});

describe('pruneFinishedSyncJobs', () => {
  it('removes succeeded jobs after a week and dead letters after a month, nothing active', async () => {
    const removed = await pruneFinishedSyncJobs(config, NOW);
    expect(removed).toBe(2);
    expect(jobs.map((j) => j.id).sort()).toEqual(['dead-new', 'ok-new', 'queued-old', 'running-old']);
  });

  it('works through a backlog in bounded batches', async () => {
    jobs = Array.from({ length: 1200 }, (_, i) => ({ id: `j${i}`, status: 'succeeded', updated_at: daysAgo(20) }));
    const removed = await pruneFinishedSyncJobs(config, NOW);
    expect(removed).toBe(1200);
    expect(jobs).toHaveLength(0);
  });

  it('stops quietly when a delete fails', async () => {
    failDeletes = true;
    await expect(pruneFinishedSyncJobs(config, NOW)).resolves.toBe(0);
    expect(jobs).toHaveLength(6);
  });
});
