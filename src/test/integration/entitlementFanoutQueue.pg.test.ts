/**
 * Phase 6-S5-R6 — REAL integration proof for the durable fan-out queue.
 *
 * Runs the actual `database/migrations/007_entitlement_fanout_jobs.sql`
 * against a live PostgreSQL instance and exercises the concurrency contract
 * that unit tests cannot prove: lease exclusivity, lease expiry reclaim,
 * non-owner rejection and idempotent enqueue.
 *
 * Enabled by TEST_DATABASE_URL (CI provides a postgres service). Skipped —
 * never failed — when no database is available locally.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

let client: any;

suite('entitlement fan-out queue (PostgreSQL)', () => {
  beforeAll(async () => {
    const { Client } = await import('pg');
    client = new Client({ connectionString: DSN });
    await client.connect();
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query(
      readFileSync(
        resolve(process.cwd(), 'database/migrations/007_entitlement_fanout_jobs.sql'),
        'utf8',
      ),
    );
    await client.query('DELETE FROM public.entitlement_fanout_jobs');
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.query('DELETE FROM public.entitlement_fanout_jobs').catch(() => {});
      await client.end();
    }
  });

  const enqueue = async (scope: string, source: string, planId: string | null) =>
    (await client.query('SELECT public.enqueue_entitlement_fanout($1,$2,$3) AS id',
      [scope, source, planId])).rows[0].id as string;

  const claim = async (worker: string, lease = 300) =>
    (await client.query(
      'SELECT * FROM public.claim_entitlement_fanout_jobs($1, 5, $2)', [worker, lease],
    )).rows as Array<Record<string, any>>;

  it('enqueue is idempotent per active scope', async () => {
    await client.query('DELETE FROM public.entitlement_fanout_jobs');
    const plan = '11111111-1111-1111-1111-111111111111';
    const a = await enqueue('plan', 'plan_definition_updated', plan);
    const b = await enqueue('plan', 'plan_definition_updated', plan);
    expect(b).toBe(a);

    const p1 = await enqueue('platform', 'platform_ai_toggle', null);
    const p2 = await enqueue('platform', 'platform_ai_toggle', null);
    expect(p2).toBe(p1);

    const other = await enqueue('plan', 'plan_definition_updated',
      '22222222-2222-2222-2222-222222222222');
    expect(other).not.toBe(a);
  });

  it('a claimed job is invisible to a second worker until the lease expires', async () => {
    await client.query('DELETE FROM public.entitlement_fanout_jobs');
    await enqueue('platform', 'platform_ai_toggle', null);

    const first = await claim('worker-a', 300);
    expect(first).toHaveLength(1);
    expect(first[0].claim_token).toBeTruthy();

    const second = await claim('worker-b', 300);
    expect(second).toHaveLength(0);

    // Force the lease to expire; the job becomes claimable again.
    await client.query(
      "UPDATE public.entitlement_fanout_jobs SET claim_expires_at = now() - interval '1 second'",
    );
    const third = await claim('worker-b', 300);
    expect(third).toHaveLength(1);
    expect(third[0].claim_token).not.toBe(first[0].claim_token);
    expect(Number(third[0].attempts)).toBe(2);
  });

  it('rejects advance/complete/fail from a non-owner or an expired lease', async () => {
    await client.query('DELETE FROM public.entitlement_fanout_jobs');
    await enqueue('platform', 'platform_ai_toggle', null);
    const [job] = await claim('worker-a', 300);

    const wrongToken = await client.query(
      'SELECT public.advance_entitlement_fanout($1,$2,$3,$4,1,0,300) AS ok',
      [job.id, '33333333-3333-3333-3333-333333333333', 'worker-a', null],
    );
    expect(wrongToken.rows[0].ok).toBe(false);

    const wrongWorker = await client.query(
      'SELECT public.complete_entitlement_fanout($1,$2,$3,0,0) AS ok',
      [job.id, job.claim_token, 'worker-b'],
    );
    expect(wrongWorker.rows[0].ok).toBe(false);

    const owner = await client.query(
      'SELECT public.advance_entitlement_fanout($1,$2,$3,$4,3,1,300) AS ok',
      [job.id, job.claim_token, 'worker-a', '44444444-4444-4444-4444-444444444444'],
    );
    expect(owner.rows[0].ok).toBe(true);

    const row = (await client.query(
      'SELECT cursor_workspace_id, processed_count, failed_count FROM public.entitlement_fanout_jobs WHERE id = $1',
      [job.id],
    )).rows[0];
    expect(row.cursor_workspace_id).toBe('44444444-4444-4444-4444-444444444444');
    expect(Number(row.processed_count)).toBe(3);
    expect(Number(row.failed_count)).toBe(1);

    // Expired lease: even the true owner loses the right to transition.
    await client.query(
      "UPDATE public.entitlement_fanout_jobs SET claim_expires_at = now() - interval '1 second' WHERE id = $1",
      [job.id],
    );
    const expired = await client.query(
      'SELECT public.complete_entitlement_fanout($1,$2,$3,0,0) AS ok',
      [job.id, job.claim_token, 'worker-a'],
    );
    expect(expired.rows[0].ok).toBe(false);
  });

  it('completes exactly once and frees the active-scope slot', async () => {
    await client.query('DELETE FROM public.entitlement_fanout_jobs');
    await enqueue('platform', 'platform_ai_toggle', null);
    const [job] = await claim('worker-a', 300);

    const first = await client.query(
      'SELECT public.complete_entitlement_fanout($1,$2,$3,5,0) AS ok',
      [job.id, job.claim_token, 'worker-a'],
    );
    expect(first.rows[0].ok).toBe(true);

    const again = await client.query(
      'SELECT public.complete_entitlement_fanout($1,$2,$3,5,0) AS ok',
      [job.id, job.claim_token, 'worker-a'],
    );
    expect(again.rows[0].ok).toBe(false);

    // The unique active-scope index no longer blocks a new job.
    const next = await enqueue('platform', 'platform_ai_toggle', null);
    expect(next).not.toBe(job.id);
  });

  it('fail applies backoff and dead-letters only past max attempts', async () => {
    await client.query('DELETE FROM public.entitlement_fanout_jobs');
    await enqueue('platform', 'platform_ai_toggle', null);
    const [job] = await claim('worker-a', 300);

    const retry = await client.query(
      'SELECT public.fail_entitlement_fanout($1,$2,$3,$4,300,10) AS ok',
      [job.id, job.claim_token, 'worker-a', 'fanout_lookup_failed'],
    );
    expect(retry.rows[0].ok).toBe(true);

    const row = (await client.query(
      'SELECT status, last_error_code, next_attempt_at > now() AS deferred FROM public.entitlement_fanout_jobs WHERE id = $1',
      [job.id],
    )).rows[0];
    expect(row.status).toBe('pending');
    expect(row.last_error_code).toBe('fanout_lookup_failed');
    expect(row.deferred).toBe(true);

    // Backoff is honoured: the job is not immediately re-claimable.
    expect(await claim('worker-c', 300)).toHaveLength(0);

    // Past max attempts it is dead-lettered instead of looping forever.
    await client.query(
      'UPDATE public.entitlement_fanout_jobs SET next_attempt_at = now() WHERE id = $1',
      [job.id],
    );
    const [again] = await claim('worker-a', 300);
    const dead = await client.query(
      'SELECT public.fail_entitlement_fanout($1,$2,$3,$4,60,1) AS ok',
      [again.id, again.claim_token, 'worker-a', 'fanout_lookup_failed'],
    );
    expect(dead.rows[0].ok).toBe(true);
    const final = (await client.query(
      'SELECT status FROM public.entitlement_fanout_jobs WHERE id = $1', [job.id],
    )).rows[0];
    expect(final.status).toBe('failed');
  });
});
