/**
 * Phase 6-S5-R7.1 §8 — the CONSUMER LOOP driven against a REAL PostgreSQL.
 *
 * The mocked consumer suite proves the worker's decisions. This one proves
 * that those decisions survive the actual RPC contract: generation binding,
 * cursor ownership, retry semantics and lease loss are executed by the same
 * SQL that ships.
 *
 * A minimal postgrest-shaped adapter sits over `pg` so the shipped worker
 * code runs unmodified.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

let db: any;

/** postgrest-like builder over raw SQL — only what the worker actually uses. */
function makeClient(client: any) {
  return {
    async rpc(fn: string, args: Record<string, unknown>) {
      const keys = Object.keys(args);
      const params = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
      try {
        const r = await client.query(
          `SELECT * FROM public.${fn}(${params}) AS out`,
          keys.map((k) => (args as any)[k]),
        );
        if (fn === 'claim_entitlement_fanout_jobs') return { data: r.rows, error: null };
        const first = r.rows[0];
        return { data: first ? first[Object.keys(first)[0]] : null, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
    from(table: string) {
      const state: any = { table, columns: '*', wheres: [] as string[], params: [] as any[], order: '', limit: '' };
      const q: any = {
        select(cols: string) { state.columns = cols; return q; },
        eq(col: string, val: any) {
          state.params.push(val);
          state.wheres.push(`${col} = $${state.params.length}`); return q;
        },
        gt(col: string, val: any) {
          state.params.push(val);
          state.wheres.push(`${col} > $${state.params.length}`); return q;
        },
        order(col: string) { state.order = ` ORDER BY ${col} ASC`; return q; },
        limit(n: number) { state.limit = ` LIMIT ${Number(n)}`; return q; },
        then(resolveFn: any, rejectFn: any) {
          const where = state.wheres.length ? ` WHERE ${state.wheres.join(' AND ')}` : '';
          const sql = `SELECT ${state.columns} FROM public.${state.table}${where}${state.order}${state.limit}`;
          return client.query(sql, state.params)
            .then((r: any) => ({ data: r.rows, error: null }))
            .catch((error: any) => ({ data: null, error }))
            .then(resolveFn, rejectFn);
        },
      };
      return q;
    },
  };
}

vi.mock('../../../server/supabase', () => ({
  getServiceClient: () => makeClient(db),
}));
vi.mock('../../../server/middleware/featureGating', () => ({
  clearEntitlementCache: () => {},
  checkModuleAccess: async () => ({ allowed: true }),
}));
vi.mock('../../../server/services/ai-agent/knowledgeIndex/kbEvents', () => ({
  enqueueKnowledgeBaseCatchup: async () => ({ ok: true, enqueued: 1 }),
}));

import { drainEntitlementFanoutJobs } from '../../../server/services/billing/entitlementFanout';

const config: any = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' };
const ws = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

suite('entitlement fan-out consumer (PostgreSQL)', () => {
  beforeAll(async () => {
    const { Client } = await import('pg');
    db = new Client({ connectionString: DSN });
    await db.connect();
    await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    // Start from a clean install so the forward-only chain is proven in
    // order, not against functions left by a previous run.
    await db.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT oid::regprocedure AS sig FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND proname IN (
              'enqueue_entitlement_fanout', 'claim_entitlement_fanout_jobs',
              'advance_entitlement_fanout', 'complete_entitlement_fanout',
              'fail_entitlement_fanout', 'entitlement_fanout_touch')
        LOOP
          EXECUTE 'DROP FUNCTION ' || r.sig || ' CASCADE';
        END LOOP;
      END $$;
    `);
    await db.query('DROP TABLE IF EXISTS public.entitlement_fanout_jobs CASCADE');
    await db.query('DROP TABLE IF EXISTS public.workspaces CASCADE');
    await db.query('CREATE TABLE public.workspaces (id uuid PRIMARY KEY)');
    for (const file of [
      'database/migrations/007_entitlement_fanout_jobs.sql',
      'database/migrations/008_entitlement_fanout_generations.sql',
      'database/migrations/009_fanout_cursor_generation_and_ai_kb_tx.sql',
    ]) {
      await db.query(readFileSync(resolve(process.cwd(), file), 'utf8'));
    }
  }, 120_000);

  afterAll(async () => { if (db) await db.end(); });

  beforeEach(async () => {
    await db.query('DELETE FROM public.entitlement_fanout_jobs');
    await db.query('DELETE FROM public.workspaces');
    for (let i = 1; i <= 5; i += 1) {
      await db.query('INSERT INTO public.workspaces (id) VALUES ($1)', [ws(i)]);
    }
  });

  const enqueue = () => db.query(
    "SELECT public.enqueue_entitlement_fanout('platform','platform_ai_toggle',NULL) AS id",
  ).then((r: any) => r.rows[0].id as string);

  const row = (id: string) => db.query(
    'SELECT * FROM public.entitlement_fanout_jobs WHERE id = $1', [id],
  ).then((r: any) => r.rows[0]);

  it('drains a whole scope and completes it against the real queue', async () => {
    const id = await enqueue();
    const s = await drainEntitlementFanoutJobs(config, { workerId: 'w1', pageSize: 2 });
    expect(s.processed).toBe(5);
    expect(s.completed).toBe(1);
    const r = await row(id);
    expect(r.status).toBe('completed');
    expect(Number(r.processed_count)).toBe(5);
    expect(r.cursor_workspace_id).toBe(ws(5));
    expect(Number(r.cursor_generation)).toBe(1);
  });

  it('a retryable failure stops at the boundary and the retry resumes there', async () => {
    const id = await enqueue();
    const first = await drainEntitlementFanoutJobs(config, {
      workerId: 'w1', pageSize: 10,
      enqueueCatchup: async (w) => ({ ok: w !== ws(3) }),
    });
    expect(first.processed).toBe(2);
    expect(first.retryableFailures).toBe(1);
    expect(first.completed).toBe(0);

    const held = await row(id);
    expect(held.status).toBe('pending');
    expect(held.cursor_workspace_id).toBe(ws(2));
    expect(Number(held.cursor_generation)).toBe(1);

    await db.query('UPDATE public.entitlement_fanout_jobs SET next_attempt_at = now()');
    const seen: string[] = [];
    const second = await drainEntitlementFanoutJobs(config, {
      workerId: 'w2', pageSize: 10,
      enqueueCatchup: async (w) => { seen.push(w); return { ok: true }; },
    });
    // Resumes exactly at the failure boundary — 1 and 2 are not redone.
    expect(seen).toEqual([ws(3), ws(4), ws(5)]);
    expect(second.completed).toBe(1);
  });

  it('a change arriving mid-pass forces a full rescan, losing nothing', async () => {
    const id = await enqueue();
    const s = await drainEntitlementFanoutJobs(config, {
      workerId: 'w1', pageSize: 10,
      enqueueCatchup: async (w) => {
        // The relevant change lands while the pass is still walking.
        if (w === ws(2)) await enqueue();
        return { ok: true };
      },
    });
    expect(s.requeuedNewGeneration).toBe(1);
    expect(s.completed).toBe(0);

    const r = await row(id);
    expect(r.status).toBe('pending');
    expect(r.cursor_workspace_id).toBeNull();
    expect(r.cursor_generation).toBeNull();
    expect(Number(r.requested_generation)).toBe(2);

    const seen: string[] = [];
    const rescan = await drainEntitlementFanoutJobs(config, {
      workerId: 'w2', pageSize: 10,
      enqueueCatchup: async (w) => { seen.push(w); return { ok: true }; },
    });
    // The whole scope is walked again under generation 2.
    expect(seen).toHaveLength(5);
    expect(rescan.completed).toBe(1);
  });

  it('a stale cursor from an older generation is never reused after a crash', async () => {
    const id = await enqueue();
    // Simulate a crashed worker that advanced under generation 1.
    await db.query(
      `UPDATE public.entitlement_fanout_jobs
       SET status='running', claim_token=gen_random_uuid(), worker_id='dead',
           processing_generation=1, cursor_workspace_id=$1, cursor_generation=1,
           claim_expires_at = now() - interval '1 second', requested_generation = 2`,
      [ws(3)],
    );
    const seen: string[] = [];
    await drainEntitlementFanoutJobs(config, {
      workerId: 'w2', pageSize: 10,
      enqueueCatchup: async (w) => { seen.push(w); return { ok: true }; },
    });
    expect(seen[0]).toBe(ws(1));
    expect(seen).toHaveLength(5);
    expect(Number((await row(id)).completed_generation)).toBe(2);
  });

  it('a worker that lost its lease cannot report progress', async () => {
    await enqueue();
    const s = await drainEntitlementFanoutJobs(config, {
      workerId: 'w1', pageSize: 2,
      enqueueCatchup: async (w) => {
        if (w === ws(1)) {
          // Another worker steals the job mid-page.
          await db.query(
            "UPDATE public.entitlement_fanout_jobs SET claim_token = gen_random_uuid(), worker_id='thief'",
          );
        }
        return { ok: true };
      },
    });
    expect(s.completed).toBe(0);
    expect(s.leaseLost).toBe(1);
  });
});
