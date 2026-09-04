/**
 * server/services/jobs/queue.ts — lock-expiry crash recovery and the
 * "two workers can never both claim the same job" invariant, proven against
 * the same generic fake Postgres used by the e2e smoke test (this is a
 * focused unit-level companion to that broader test).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeSupabase, type FakeTables } from './testUtils/fakeSupabase.js';

const WORKSPACE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

let tables: FakeTables;
let fakeSb: ReturnType<typeof makeFakeSupabase>;
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));

const { claimNextJob, enqueueJob } = await import('../../../server/services/jobs/queue.js');

const config = {} as any;

describe('claimNextJob — concurrency and crash recovery', () => {
  beforeEach(() => {
    tables = { background_jobs: [] };
    fakeSb = makeFakeSupabase(tables);
  });

  it('a second worker cannot claim a job another worker already holds a live lock on', async () => {
    await enqueueJob(config, { workspaceId: WORKSPACE, jobType: 'seo_crawl', subjectType: 'seo_site', subjectId: WORKSPACE });
    const first = await claimNextJob(config, { jobTypes: ['seo_crawl'], workerId: 'worker-A', lockTtlSeconds: 300 });
    expect(first).toBeTruthy();

    const second = await claimNextJob(config, { jobTypes: ['seo_crawl'], workerId: 'worker-B', lockTtlSeconds: 300 });
    expect(second).toBeNull();
  });

  it('reclaims a job whose lock has expired (crashed worker recovery)', async () => {
    const job = await enqueueJob(config, { workspaceId: WORKSPACE, jobType: 'seo_crawl', subjectType: 'seo_site', subjectId: WORKSPACE });
    const first = await claimNextJob(config, { jobTypes: ['seo_crawl'], workerId: 'worker-A', lockTtlSeconds: 300 });
    expect(first).toBeTruthy();

    // Simulate worker-A crashing: its lock has already expired.
    const row = tables.background_jobs.find((r) => r.id === job.id)!;
    row.lock_expires_at = new Date(Date.now() - 60_000).toISOString();

    const reclaimed = await claimNextJob(config, { jobTypes: ['seo_crawl'], workerId: 'worker-B', lockTtlSeconds: 300 });
    expect(reclaimed).toBeTruthy();
    expect(reclaimed!.locked_by).toBe('worker-B');
    expect(reclaimed!.attempts).toBe(2); // crash-recovery counts as a new attempt
  });

  it('does NOT reclaim a job whose lock has not yet expired', async () => {
    await enqueueJob(config, { workspaceId: WORKSPACE, jobType: 'seo_crawl', subjectType: 'seo_site', subjectId: WORKSPACE });
    await claimNextJob(config, { jobTypes: ['seo_crawl'], workerId: 'worker-A', lockTtlSeconds: 300 });

    const stillLocked = await claimNextJob(config, { jobTypes: ['seo_crawl'], workerId: 'worker-B', lockTtlSeconds: 300 });
    expect(stillLocked).toBeNull();
  });

  it('burns out a job that has exhausted max_attempts instead of handing it out again', async () => {
    const job = await enqueueJob(config, { workspaceId: WORKSPACE, jobType: 'seo_crawl', subjectType: 'seo_site', subjectId: WORKSPACE, maxAttempts: 1 });
    await claimNextJob(config, { jobTypes: ['seo_crawl'], workerId: 'worker-A', lockTtlSeconds: 300 });
    const row = tables.background_jobs.find((r) => r.id === job.id)!;
    row.lock_expires_at = new Date(Date.now() - 60_000).toISOString(); // simulate crash before max_attempts=1 is used up

    const result = await claimNextJob(config, { jobTypes: ['seo_crawl'], workerId: 'worker-B', lockTtlSeconds: 300 });
    expect(result).toBeNull();
    expect(row.status).toBe('failed');
    expect(row.error_category).toBe('limit_exceeded');
  });
});
