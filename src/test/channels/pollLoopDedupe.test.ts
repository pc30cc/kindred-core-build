/**
 * X and Yahoo poll loops stay one loop per integration.
 *
 * Neither provider pushes, so each poll run asks Core to enqueue the next.
 * Two things forked a loop for good: a reconnect seeded a new first run while
 * the old loop lived on (still carrying the previous account's address or bot
 * id), and a worker that died after enqueueing its successor but before
 * completing its own job ran that job again. Every fork then polled the
 * provider and wrote job rows forever.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { enqueueNextPoll, seedPollLoop } from '../../../server/services/channels/jobs';

type SupabaseClient = Parameters<typeof enqueueNextPoll>[0];

type JobRow = { id: string; integration_id: string; job_type: string; status: string; payload: Record<string, unknown> };

let rows: JobRow[] = [];
let failReads = false;

/** In-memory channel_jobs: just the query shapes jobs.ts uses. */
function fakeClient(): SupabaseClient {
  const from = () => {
    const filters: Array<[string, unknown]> = [];
    let patch: Partial<JobRow> | null = null;
    let inserted: JobRow | null = null;
    const matching = () => rows.filter((r) => filters.every(([col, v]) => (r as Record<string, unknown>)[col] === v));
    const q = {
      select: () => q,
      eq: (col: string, v: unknown) => {
        filters.push([col, v]);
        return q;
      },
      limit: () => q,
      update: (p: Partial<JobRow>) => {
        patch = p;
        return q;
      },
      insert: (row: Record<string, unknown>) => {
        inserted = {
          id: `job-${rows.length + 1}`,
          integration_id: String(row.integration_id),
          job_type: String(row.job_type),
          status: 'pending',
          payload: (row.payload as Record<string, unknown>) ?? {},
        };
        rows.push(inserted);
        return q;
      },
      single: async () => ({ data: inserted ? { id: inserted.id } : null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        if (patch) {
          for (const r of matching()) Object.assign(r, patch);
          return resolve({ data: null, error: null });
        }
        if (failReads) return resolve({ data: null, error: { message: 'unavailable' } });
        return resolve({ data: matching().map((r) => ({ id: r.id })), error: null });
      },
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const xRun = (integrationId = 'int-1', selfUserId = 'bot-1') => ({
  provider: 'x',
  jobType: 'x_poll_dm_events' as const,
  workspaceId: 'ws-1',
  integrationId,
  payload: { self_user_id: selfUserId },
});

const pending = (integrationId = 'int-1', jobType = 'x_poll_dm_events') =>
  rows.filter((r) => r.integration_id === integrationId && r.job_type === jobType && r.status === 'pending');

beforeEach(() => {
  rows = [];
  failReads = false;
});

describe('enqueueNextPoll', () => {
  it('enqueues the next run when none is waiting', async () => {
    const res = await enqueueNextPoll(fakeClient(), xRun());
    expect(res).toEqual({ enqueued: true });
    expect(pending()).toHaveLength(1);
  });

  it('a forked loop finds the waiting run and ends there', async () => {
    const sb = fakeClient();
    await enqueueNextPoll(sb, xRun()); // loop A schedules its successor
    const res = await enqueueNextPoll(sb, xRun()); // the fork (a re-run) asks too
    expect(res).toEqual({ enqueued: false });
    expect(pending()).toHaveLength(1);
  });

  it('only a waiting run of the same integration and type counts', async () => {
    const sb = fakeClient();
    await enqueueNextPoll(sb, xRun('int-2'));
    await enqueueNextPoll(sb, { ...xRun(), jobType: 'yahoo_poll_inbox', provider: 'yahoo' });
    const res = await enqueueNextPoll(sb, xRun('int-1'));
    expect(res).toEqual({ enqueued: true });
  });

  it('a run already claimed (running) does not block its own successor', async () => {
    rows.push({ id: 'job-running', integration_id: 'int-1', job_type: 'x_poll_dm_events', status: 'running', payload: {} });
    const res = await enqueueNextPoll(fakeClient(), xRun());
    expect(res).toEqual({ enqueued: true });
  });

  it('fails open: if the check cannot be read, the run is enqueued as before', async () => {
    failReads = true;
    const res = await enqueueNextPoll(fakeClient(), xRun());
    expect(res).toEqual({ enqueued: true });
  });
});

describe('seedPollLoop', () => {
  it('a reconnect replaces the waiting run instead of adding a second loop', async () => {
    const sb = fakeClient();
    await enqueueNextPoll(sb, xRun('int-1', 'old-bot'));

    await seedPollLoop(sb, xRun('int-1', 'new-bot'));

    expect(pending()).toHaveLength(1);
    expect(pending()[0].payload).toEqual({ self_user_id: 'new-bot' });
    expect(rows.filter((r) => r.status === 'cancelled').map((r) => r.payload)).toEqual([{ self_user_id: 'old-bot' }]);
  });

  it('an old run that was mid-flight during the reconnect ends at its next reschedule', async () => {
    const sb = fakeClient();
    rows.push({ id: 'job-old', integration_id: 'int-1', job_type: 'x_poll_dm_events', status: 'running', payload: { self_user_id: 'old-bot' } });

    await seedPollLoop(sb, xRun('int-1', 'new-bot'));
    const res = await enqueueNextPoll(sb, xRun('int-1', 'old-bot'));

    expect(res).toEqual({ enqueued: false });
    expect(pending().map((r) => r.payload)).toEqual([{ self_user_id: 'new-bot' }]);
  });

  it('leaves other integrations’ loops alone', async () => {
    const sb = fakeClient();
    await enqueueNextPoll(sb, xRun('int-2'));
    await seedPollLoop(sb, xRun('int-1'));
    expect(pending('int-2')).toHaveLength(1);
  });
});
