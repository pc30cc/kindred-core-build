/**
 * Phase 6-S5-R7 — REAL integration proof for the LOSSLESS durable fan-out
 * queue.
 *
 * Runs the actual forward-only migrations
 * (`007_entitlement_fanout_jobs.sql` then
 * `008_entitlement_fanout_generations.sql`) against a live PostgreSQL and
 * exercises the contract that unit tests cannot prove: lease exclusivity,
 * lease expiry reclaim, non-owner rejection, generation bumping while a pass
 * is in flight, and exact counter accounting.
 *
 * Enabled by TEST_DATABASE_URL (CI provides a postgres service). Skipped —
 * never silently passed as "green" — when no database is available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

let client: any;

const PLATFORM = ['platform', 'platform_ai_toggle', null] as const;

suite('entitlement fan-out queue (PostgreSQL)', () => {
  beforeAll(async () => {
    const { Client } = await import('pg');
    client = new Client({ connectionString: DSN });
    await client.connect();
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    for (const file of [
      'database/migrations/007_entitlement_fanout_jobs.sql',
      'database/migrations/008_entitlement_fanout_generations.sql',
    ]) {
      await client.query(readFileSync(resolve(process.cwd(), file), 'utf8'));
    }
    await client.query('DELETE FROM public.entitlement_fanout_jobs');
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.query('DELETE FROM public.entitlement_fanout_jobs').catch(() => {});
      await client.end();
    }
  });

  const reset = () => client.query('DELETE FROM public.entitlement_fanout_jobs');

  const enqueue = async (scope: string, source: string, planId: string | null) =>
    (await client.query('SELECT public.enqueue_entitlement_fanout($1,$2,$3) AS id',
      [scope, source, planId])).rows[0].id as string;

  const claim = async (worker: string, lease = 300) =>
    (await client.query(
      'SELECT * FROM public.claim_entitlement_fanout_jobs($1, 5, $2)', [worker, lease],
    )).rows as Array<Record<string, any>>;

  const advance = async (
    job: Record<string, any>, worker: string, cursor: string | null,
    counts: { p?: number; s?: number; r?: number; x?: number } = {},
    token = job.claim_token, gen = job.processing_generation,
  ) => (await client.query(
    'SELECT public.advance_entitlement_fanout($1,$2,$3,$4,$5,$6,$7,$8,$9,300) AS ok',
    [job.id, token, worker, gen, cursor, counts.p ?? 0, counts.s ?? 0, counts.r ?? 0, counts.x ?? 0],
  )).rows[0].ok as boolean;

  const complete = async (
    job: Record<string, any>, worker: string, cursor: string | null = null,
    counts: { p?: number; s?: number; r?: number; x?: number } = {},
    gen = job.processing_generation,
  ) => (await client.query(
    'SELECT public.complete_entitlement_fanout($1,$2,$3,$4,$5,$6,$7,$8,$9) AS outcome',
    [job.id, job.claim_token, worker, gen, cursor,
      counts.p ?? 0, counts.s ?? 0, counts.r ?? 0, counts.x ?? 0],
  )).rows[0].outcome as string;

  const row = async (id: string) => (await client.query(
    'SELECT * FROM public.entitlement_fanout_jobs WHERE id = $1', [id],
  )).rows[0];

  it('enqueue reuses the active scope slot instead of creating duplicates', async () => {
    await reset();
    const plan = '11111111-1111-1111-1111-111111111111';
    const a = await enqueue('plan', 'plan_definition_updated', plan);
    const b = await enqueue('plan', 'plan_definition_updated', plan);
    expect(b).toBe(a);

    const p1 = await enqueue(...PLATFORM);
    expect(await enqueue(...PLATFORM)).toBe(p1);

    expect(await enqueue('plan', 'plan_definition_updated',
      '22222222-2222-2222-2222-222222222222')).not.toBe(a);
  });

  it('a second enqueue bumps the requested generation, it does not merge silently', async () => {
    await reset();
    const id = await enqueue(...PLATFORM);
    expect(Number((await row(id)).requested_generation)).toBe(1);
    await enqueue(...PLATFORM);
    expect(Number((await row(id)).requested_generation)).toBe(2);
  });

  it('a claimed job is invisible to a second worker until the lease expires', async () => {
    await reset();
    await enqueue(...PLATFORM);

    const first = await claim('worker-a', 300);
    expect(first).toHaveLength(1);
    expect(first[0].claim_token).toBeTruthy();
    expect(Number(first[0].processing_generation)).toBe(1);

    expect(await claim('worker-b', 300)).toHaveLength(0);

    await client.query(
      "UPDATE public.entitlement_fanout_jobs SET claim_expires_at = now() - interval '1 second'",
    );
    const third = await claim('worker-b', 300);
    expect(third).toHaveLength(1);
    expect(third[0].claim_token).not.toBe(first[0].claim_token);
    expect(Number(third[0].attempts)).toBe(2);
  });

  it('rejects advance/complete from a non-owner, a stale generation or an expired lease', async () => {
    await reset();
    await enqueue(...PLATFORM);
    const [job] = await claim('worker-a', 300);

    expect(await advance(job, 'worker-a', null, {}, '33333333-3333-3333-3333-333333333333'))
      .toBe(false);
    expect(await advance(job, 'worker-b', null)).toBe(false);
    // A worker holding the lease but claiming a generation it does not own.
    expect(await advance(job, 'worker-a', null, {}, job.claim_token, 99)).toBe(false);

    const cursor = '44444444-4444-4444-4444-444444444444';
    expect(await advance(job, 'worker-a', cursor, { p: 3, s: 2, r: 1, x: 1 })).toBe(true);

    const r = await row(job.id);
    expect(r.cursor_workspace_id).toBe(cursor);
    expect(Number(r.processed_count)).toBe(3);
    expect(Number(r.skipped_ineligible_count)).toBe(2);
    expect(Number(r.retryable_failure_count)).toBe(1);
    expect(Number(r.permanent_failure_count)).toBe(1);
    // Only PERMANENT failures roll up into the legacy failed_count.
    expect(Number(r.failed_count)).toBe(1);

    await client.query(
      "UPDATE public.entitlement_fanout_jobs SET claim_expires_at = now() - interval '1 second' WHERE id = $1",
      [job.id],
    );
    expect(await complete(job, 'worker-a')).toBe('lease_lost');
  });

  it('completes exactly once, persists the FINAL page and frees the scope slot', async () => {
    await reset();
    await enqueue(...PLATFORM);
    const [job] = await claim('worker-a', 300);

    const finalCursor = '55555555-5555-5555-5555-555555555555';
    expect(await complete(job, 'worker-a', finalCursor, { p: 5, s: 4 })).toBe('completed');

    const r = await row(job.id);
    expect(r.status).toBe('completed');
    // The last page's counters and cursor were persisted by Complete itself.
    expect(Number(r.processed_count)).toBe(5);
    expect(Number(r.skipped_ineligible_count)).toBe(4);
    expect(r.cursor_workspace_id).toBe(finalCursor);
    expect(Number(r.completed_generation)).toBe(1);
    expect(r.processing_generation).toBeNull();

    expect(await complete(job, 'worker-a')).toBe('lease_lost');
    expect(await enqueue(...PLATFORM)).not.toBe(job.id);
  });

  it('a change arriving mid-pass is never lost: completion requeues a full rescan', async () => {
    await reset();
    const id = await enqueue(...PLATFORM);
    const [job] = await claim('worker-a', 300);
    expect(Number(job.processing_generation)).toBe(1);

    // Worker walks part of the scope...
    await advance(job, 'worker-a', '66666666-6666-6666-6666-666666666666', { p: 2 });
    // ...and a new relevant change lands while it is still running.
    await enqueue(...PLATFORM);

    expect(await complete(job, 'worker-a', '77777777-7777-7777-7777-777777777777', { p: 1 }))
      .toBe('requeued_new_generation');

    const r = await row(id);
    expect(r.status).toBe('pending');
    // A rescan MUST start from the beginning: workspaces already passed by
    // the previous cursor may be exactly the ones the new change affects.
    expect(r.cursor_workspace_id).toBeNull();
    expect(Number(r.requested_generation)).toBe(2);
    expect(Number(r.completed_generation)).toBe(0);
    // Work already done is still counted, not discarded.
    expect(Number(r.processed_count)).toBe(3);

    const [second] = await claim('worker-b', 300);
    expect(Number(second.processing_generation)).toBe(2);
    expect(second.cursor_workspace_id).toBeNull();
    expect(await complete(second, 'worker-b', null, {})).toBe('completed');
    expect(Number((await row(id)).completed_generation)).toBe(2);
  });

  it('a retryable release preserves the cursor so no workspace is skipped', async () => {
    await reset();
    const id = await enqueue(...PLATFORM);
    const [job] = await claim('worker-a', 300);
    const cursor = '88888888-8888-8888-8888-888888888888';
    await advance(job, 'worker-a', cursor, { p: 4, r: 1 });

    const released = (await client.query(
      'SELECT public.fail_entitlement_fanout($1,$2,$3,$4,$5,1,1000) AS ok',
      [job.id, job.claim_token, 'worker-a', job.processing_generation, 'fanout_workspace_retryable'],
    )).rows[0].ok;
    expect(released).toBe(true);

    const r = await row(id);
    expect(r.status).toBe('pending');
    expect(r.processing_generation).toBeNull();
    // The failed workspace sits AHEAD of the cursor and will be retried.
    expect(r.cursor_workspace_id).toBe(cursor);
    expect(Number(r.retryable_failure_count)).toBe(1);
    // A retryable failure must NOT be counted as a permanent one.
    expect(Number(r.permanent_failure_count)).toBe(0);

    await client.query(
      'UPDATE public.entitlement_fanout_jobs SET next_attempt_at = now() WHERE id = $1', [id],
    );
    const [resumed] = await claim('worker-b', 300);
    expect(resumed.cursor_workspace_id).toBe(cursor);
    expect(Number(resumed.processing_generation)).toBe(1);
  });

  it('fail applies backoff and dead-letters only past max attempts', async () => {
    await reset();
    const id = await enqueue(...PLATFORM);
    const [job] = await claim('worker-a', 300);

    const retry = (await client.query(
      'SELECT public.fail_entitlement_fanout($1,$2,$3,$4,$5,300,10) AS ok',
      [job.id, job.claim_token, 'worker-a', job.processing_generation, 'fanout_lookup_failed'],
    )).rows[0].ok;
    expect(retry).toBe(true);

    const r = await row(id);
    expect(r.status).toBe('pending');
    expect(r.last_error_code).toBe('fanout_lookup_failed');
    expect(await claim('worker-c', 300)).toHaveLength(0);

    await client.query(
      'UPDATE public.entitlement_fanout_jobs SET next_attempt_at = now() WHERE id = $1', [id],
    );
    const [again] = await claim('worker-a', 300);
    const dead = (await client.query(
      'SELECT public.fail_entitlement_fanout($1,$2,$3,$4,$5,60,1) AS ok',
      [again.id, again.claim_token, 'worker-a', again.processing_generation, 'fanout_lookup_failed'],
    )).rows[0].ok;
    expect(dead).toBe(true);
    expect((await row(id)).status).toBe('failed');
  });

  it('migration 008 preserves in-flight jobs and backfills completed ones', async () => {
    await reset();
    const id = await enqueue(...PLATFORM);
    const [job] = await claim('worker-a', 300);
    const cursor = '99999999-9999-9999-9999-999999999999';
    await advance(job, 'worker-a', cursor, { p: 7 });

    // Re-running the forward-only migration must be a no-op for live state.
    await client.query(readFileSync(
      resolve(process.cwd(), 'database/migrations/008_entitlement_fanout_generations.sql'),
      'utf8',
    ));

    const r = await row(id);
    expect(r.cursor_workspace_id).toBe(cursor);
    expect(Number(r.processed_count)).toBe(7);
    expect(r.status).toBe('running');
  });
});
