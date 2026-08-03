/**
 * Phase 6-S5-R7 — REAL integration proof for the LOSSLESS durable fan-out
 * queue.
 *
 * Runs the actual forward-only migrations
 * (`007` → `008` → `009`) against a live PostgreSQL and
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
    // Start from a clean install so the forward-only migration chain is
    // proven in its real order (007 then 008), not against leftovers.
    await client.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT oid::regprocedure AS sig FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND proname IN (
              'enqueue_entitlement_fanout', 'claim_entitlement_fanout_jobs',
              'advance_entitlement_fanout', 'complete_entitlement_fanout',
              'fail_entitlement_fanout', 'entitlement_fanout_touch',
              '_ai_kb_apply_generated', 'accept_ai_kb_generated_article',
              'publish_ai_kb_generated_article', 'reject_ai_kb_generated_article')
        LOOP
          EXECUTE 'DROP FUNCTION ' || r.sig || ' CASCADE';
        END LOOP;
      END $$;
    `);
    await client.query('DROP TABLE IF EXISTS public.entitlement_fanout_jobs CASCADE');
    for (const file of [
      'database/migrations/007_entitlement_fanout_jobs.sql',
      'database/migrations/008_entitlement_fanout_generations.sql',
      'database/migrations/009_fanout_cursor_generation_and_ai_kb_tx.sql',
      'database/migrations/010_fanout_rpc_security_and_kb_state_machine.sql',
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

  const fail = async (
    job: Record<string, any>, worker: string, code: string,
    retry = 300, maxAttempts = 10, gen = job.processing_generation,
  ) => (await client.query(
    'SELECT public.fail_entitlement_fanout($1,$2,$3,$4,$5,$6,$7) AS outcome',
    [job.id, job.claim_token, worker, gen, code, retry, maxAttempts],
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

    expect(await fail(job, 'worker-a', 'fanout_workspace_retryable', 1, 1000))
      .toBe('retry_same_generation');

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

    expect(await fail(job, 'worker-a', 'fanout_lookup_failed', 300, 10))
      .toBe('retry_same_generation');

    const r = await row(id);
    expect(r.status).toBe('pending');
    expect(r.last_error_code).toBe('fanout_lookup_failed');
    expect(await claim('worker-c', 300)).toHaveLength(0);

    await client.query(
      'UPDATE public.entitlement_fanout_jobs SET next_attempt_at = now() WHERE id = $1', [id],
    );
    const [again] = await claim('worker-a', 300);
    expect(await fail(again, 'worker-a', 'fanout_lookup_failed', 60, 1)).toBe('dead_lettered');
    expect((await row(id)).status).toBe('failed');
  });

  it('re-running the migration head preserves in-flight jobs', async () => {
    await reset();
    const id = await enqueue(...PLATFORM);
    const [job] = await claim('worker-a', 300);
    const cursor = '99999999-9999-9999-9999-999999999999';
    await advance(job, 'worker-a', cursor, { p: 7 });

    // Re-running the forward-only migration must be a no-op for live state.
    await client.query(readFileSync(
      resolve(process.cwd(), 'database/migrations/009_fanout_cursor_generation_and_ai_kb_tx.sql'),
      'utf8',
    ));

    const r = await row(id);
    expect(r.cursor_workspace_id).toBe(cursor);
    expect(Number(r.processed_count)).toBe(7);
    expect(r.status).toBe('running');
  });

  // ── R7.1 §1-§7 — generation-bound cursor, generation-safe retry and
  //    concurrency-safe enqueue.

  it('A: a cursor produced by an older generation is discarded on claim', async () => {
    await reset();
    const id = await enqueue(...PLATFORM);
    const [job] = await claim('worker-a', 300);
    const cursor = 'aaaaaaaa-0000-4000-8000-000000000000';
    await advance(job, 'worker-a', cursor, { p: 4 });
    expect(Number((await row(id)).cursor_generation)).toBe(1);

    // A newer change lands, then the lease simply expires (worker crash):
    // no complete, no fail. The cursor row is still populated.
    await enqueue(...PLATFORM);
    await client.query(
      "UPDATE public.entitlement_fanout_jobs SET claim_expires_at = now() - interval '1 second' WHERE id = $1",
      [id],
    );

    const [resumed] = await claim('worker-b', 300);
    expect(Number(resumed.processing_generation)).toBe(2);
    // The stale cursor must NOT be reused for generation 2.
    expect(resumed.cursor_workspace_id).toBeNull();
    expect(resumed.cursor_generation).toBeNull();
  });

  it('B: a same-generation retry keeps the cursor bound to that generation', async () => {
    await reset();
    const id = await enqueue(...PLATFORM);
    const [job] = await claim('worker-a', 300);
    const cursor = 'bbbbbbbb-0000-4000-8000-000000000000';
    await advance(job, 'worker-a', cursor, { p: 2 });
    expect(await fail(job, 'worker-a', 'fanout_workspace_retryable', 1, 1000))
      .toBe('retry_same_generation');

    const r = await row(id);
    expect(r.cursor_workspace_id).toBe(cursor);
    expect(Number(r.cursor_generation)).toBe(1);

    await client.query(
      'UPDATE public.entitlement_fanout_jobs SET next_attempt_at = now() WHERE id = $1', [id],
    );
    const [resumed] = await claim('worker-b', 300);
    expect(resumed.cursor_workspace_id).toBe(cursor);
  });

  it('C: a failure under a superseded generation requeues immediately, without backoff', async () => {
    await reset();
    const id = await enqueue(...PLATFORM);
    const [job] = await claim('worker-a', 300);
    await advance(job, 'worker-a', 'cccccccc-0000-4000-8000-000000000000', { p: 1 });
    await enqueue(...PLATFORM);

    // A long backoff is requested — it must be ignored, this is fresh work.
    expect(await fail(job, 'worker-a', 'fanout_workspace_retryable', 3600, 1000))
      .toBe('requeued_new_generation');

    const r = await row(id);
    expect(r.status).toBe('pending');
    expect(r.cursor_workspace_id).toBeNull();
    expect(r.cursor_generation).toBeNull();
    // Claimable right now, with no next_attempt_at penalty.
    const [next] = await claim('worker-b', 300);
    expect(next).toBeTruthy();
    expect(Number(next.processing_generation)).toBe(2);
  });

  it('C2: a dead-lettered job keeps its cursor generation for a later resume', async () => {
    await reset();
    const id = await enqueue(...PLATFORM);
    const [job] = await claim('worker-a', 300);
    const cursor = 'dddddddd-0000-4000-8000-000000000000';
    await advance(job, 'worker-a', cursor, { p: 1 });
    expect(await fail(job, 'worker-a', 'fanout_lookup_failed', 5, 1)).toBe('dead_lettered');
    const r = await row(id);
    expect(r.status).toBe('failed');
    expect(r.cursor_workspace_id).toBe(cursor);
    expect(Number(r.cursor_generation)).toBe(1);
  });

  it('D: concurrent first enqueues create exactly one job and lose no change', async () => {
    await reset();
    const { Client } = await import('pg');
    const conns: any[] = [];
    for (let i = 0; i < 8; i += 1) {
      const c = new Client({ connectionString: DSN });
      await c.connect();
      conns.push(c);
    }
    try {
      const ids = await Promise.all(conns.map((c) =>
        c.query('SELECT public.enqueue_entitlement_fanout($1,$2,$3) AS id',
          ['platform', 'platform_ai_toggle', null]).then((r: any) => r.rows[0].id as string)));

      const distinct = new Set(ids);
      expect(distinct.size).toBe(1);

      const all = (await client.query(
        "SELECT * FROM public.entitlement_fanout_jobs WHERE scope = 'platform'")).rows;
      expect(all).toHaveLength(1);
      // Eight concurrent changes: one creation + seven bumps. No change is
      // silently merged away.
      expect(Number(all[0].requested_generation)).toBe(conns.length);
    } finally {
      await Promise.all(conns.map((c) => c.end()));
    }
  });
});

// ──────────────────────────────────────────────────────────────
//  R7.1 §12 — AI-KB accept/publish are ONE transaction.
// ──────────────────────────────────────────────────────────────
suite('AI-KB transactional draft mutations (PostgreSQL)', () => {
  let db: any;
  const WS = '0000ffff-0000-4000-8000-000000000001';
  const OTHER_WS = '0000ffff-0000-4000-8000-000000000002';
  const REVIEWER = '0000ffff-0000-4000-8000-0000000000ff';

  beforeAll(async () => {
    const { Client } = await import('pg');
    db = new Client({ connectionString: DSN });
    await db.connect();
    await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await db.query('DROP TABLE IF EXISTS public.ai_kb_generated_articles CASCADE');
    await db.query('DROP TABLE IF EXISTS public.knowledge_base_articles CASCADE');
    await db.query(`
      CREATE TABLE public.knowledge_base_articles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL,
        slug text NOT NULL,
        locale text NOT NULL,
        title text NOT NULL,
        content text,
        excerpt text,
        status text NOT NULL DEFAULT 'draft',
        UNIQUE (workspace_id, locale, slug)
      );
      CREATE TABLE public.ai_kb_generated_articles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id uuid,
        workspace_id uuid NOT NULL,
        title text NOT NULL,
        slug text,
        excerpt text,
        content_md text,
        locale text NOT NULL DEFAULT 'en',
        status text NOT NULL DEFAULT 'pending',
        kb_article_id uuid,
        reviewed_by uuid,
        reviewed_at timestamptz
      );
    `);
    await db.query(readFileSync(resolve(
      process.cwd(), 'database/migrations/009_fanout_cursor_generation_and_ai_kb_tx.sql'), 'utf8'));
  }, 120_000);

  afterAll(async () => { if (db) await db.end(); });

  const seed = async (over: Record<string, any> = {}) => {
    const r = await db.query(
      `INSERT INTO public.ai_kb_generated_articles
         (workspace_id, title, slug, excerpt, content_md, locale)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [over.workspace_id ?? WS, over.title ?? 'How to reset a password',
        over.slug ?? 'reset-password', 'summary', '<p>body</p>', over.locale ?? 'en'],
    );
    return r.rows[0];
  };

  it('publish links the article and the draft in a single transaction', async () => {
    const gen = await seed();
    const out = (await db.query(
      'SELECT public.publish_ai_kb_generated_article($1,$2,$3,$4) AS r',
      [gen.id, WS, REVIEWER, '<p>normalized</p>'],
    )).rows[0].r;
    expect(out.ok).toBe(true);
    expect(out.status).toBe('published');

    const art = (await db.query(
      'SELECT * FROM public.knowledge_base_articles WHERE id = $1', [out.kb_article_id])).rows[0];
    expect(art.workspace_id).toBe(WS);
    expect(art.content).toBe('<p>normalized</p>');

    const after = (await db.query(
      'SELECT * FROM public.ai_kb_generated_articles WHERE id = $1', [gen.id])).rows[0];
    // The back-link cannot be missing: it is written by the same call.
    expect(after.kb_article_id).toBe(out.kb_article_id);
    expect(after.status).toBe('published');
    expect(after.reviewed_by).toBe(REVIEWER);
  });

  it('re-publishing reuses the linked article instead of duplicating it', async () => {
    const gen = await seed({ slug: 'idempotent' });
    const first = (await db.query(
      'SELECT public.publish_ai_kb_generated_article($1,$2,$3,$4) AS r',
      [gen.id, WS, REVIEWER, '<p>v1</p>'])).rows[0].r;
    const second = (await db.query(
      'SELECT public.publish_ai_kb_generated_article($1,$2,$3,$4) AS r',
      [gen.id, WS, REVIEWER, '<p>v2</p>'])).rows[0].r;
    expect(second.kb_article_id).toBe(first.kb_article_id);

    const count = (await db.query(
      "SELECT count(*)::int AS n FROM public.knowledge_base_articles WHERE slug LIKE 'idempotent%'",
    )).rows[0].n;
    expect(count).toBe(1);
  });

  it('de-duplicates the slug per (workspace, locale)', async () => {
    await db.query(
      `INSERT INTO public.knowledge_base_articles (workspace_id, slug, locale, title)
       VALUES ($1,'taken','en','existing')`, [WS]);
    const gen = await seed({ slug: 'taken' });
    const out = (await db.query(
      'SELECT public.accept_ai_kb_generated_article($1,$2,$3,$4) AS r',
      [gen.id, WS, REVIEWER, '<p>x</p>'])).rows[0].r;
    expect(out.ok).toBe(true);
    expect(out.slug).toBe('taken-2');
    expect(out.status).toBe('draft');
  });

  it('refuses a cross-workspace mutation without leaking existence', async () => {
    const gen = await seed({ slug: 'cross-ws' });
    const out = (await db.query(
      'SELECT public.publish_ai_kb_generated_article($1,$2,$3,$4) AS r',
      [gen.id, OTHER_WS, REVIEWER, '<p>x</p>'])).rows[0].r;
    expect(out.ok).toBe(false);
    expect(out.error).toBe('not_found');

    const untouched = (await db.query(
      'SELECT status FROM public.ai_kb_generated_articles WHERE id = $1', [gen.id])).rows[0];
    expect(untouched.status).toBe('pending');
  });

  it('reject reports not_found instead of a silent no-op', async () => {
    const missing = (await db.query(
      'SELECT public.reject_ai_kb_generated_article($1,$2,$3) AS r',
      ['0000ffff-0000-4000-8000-00000000dead', WS, REVIEWER])).rows[0].r;
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe('not_found');

    const gen = await seed({ slug: 'rejectable' });
    const ok = (await db.query(
      'SELECT public.reject_ai_kb_generated_article($1,$2,$3) AS r',
      [gen.id, WS, REVIEWER])).rows[0].r;
    expect(ok.ok).toBe(true);
    expect((await db.query(
      'SELECT status FROM public.ai_kb_generated_articles WHERE id = $1', [gen.id])).rows[0].status)
      .toBe('rejected');
  });
});
