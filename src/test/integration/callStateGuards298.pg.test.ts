// @vitest-environment node
/**
 * 298 — the call state machine's guards in the database (audit 2026-11-04,
 * calls-1 and sql-3). Against real PostgreSQL built by the chain up to 297:
 *
 *   - a call that is over ('ended', 'failed', 'cancelled', 'missed') never
 *     moves to another state, whoever writes: the update skips that row, so
 *     the billing trigger (016a's tg_call_sessions_bill_minutes) adds a
 *     call's minutes once — the room of an ended call started again and
 *     finished again bills nothing more; an update that keeps the state
 *     still passes, and a live call ends as before;
 *   - team_call_place() with the plan's concurrency limit counts the
 *     workspace's live calls under a workspace lock: at the limit it answers
 *     limit_reached with nothing written, and two placements by two pairs at
 *     limit − 1 run one after the other, so only one gets through; no limit
 *     (NULL, −1) places as 293's function does;
 *   - a dry run (BEGIN … ROLLBACK) leaves no trace, a second run changes
 *     nothing, and only service_role reaches the new function.
 *
 * Its own database (CREATE DATABASE on the TEST_DATABASE_URL server).
 * Skipped without TEST_DATABASE_URL; REQUIRE_BILLING_DB=1 makes that a failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_BILLING_DB === '1' && !DSN) {
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the 298 tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `call_state_guards_298_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '298_call_state_guards.sql';
const SQL = () => readFileSync(resolve(DIR, FILE), 'utf8');

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];
const PLACE9 = 'public.team_call_place(uuid, uuid, uuid, text, text, jsonb, timestamptz, timestamptz, integer)';
const exists = async () => (await one(`
  SELECT to_regprocedure($1) IS NOT NULL AS fn,
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_call_sessions_keep_finished_state') AS trg,
         to_regclass('public.call_sessions_unanswered_created_idx') IS NOT NULL AS idx`, [PLACE9]));

suite('298 — an over call keeps its state, and colleague calls within the plan (real PostgreSQL, whole chain)', () => {
  let ws = '';

  beforeAll(async () => {
    const adminUrl = new URL(DSN!);
    adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    const url = new URL(DSN!);
    url.pathname = `/${DB}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    await db.query('SET client_min_messages = warning');
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql') && f < FILE).sort()) {
      await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
    }
    const owner = randomUUID();
    await q(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
    ws = randomUUID();
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  /** A call-centre call as the widget makes it, in `state`. */
  const call = async (state: string, extra: Row = {}): Promise<string> => {
    const id = randomUUID();
    await q(
      `INSERT INTO public.call_sessions (id, workspace_id, provider, call_type, context_type, entry_source, state, connected_at)
       VALUES ($1, $2, 'livekit', 'audio', 'internal', 'call_widget', $3::public.call_state, $4)`,
      [id, ws, state, extra.connected_at ?? null],
    );
    return id;
  };
  const minutes = async (): Promise<number> =>
    Number((await one(`SELECT coalesce(sum(call_minutes_used), 0) AS m FROM public.workspace_usage_counters WHERE workspace_id = $1`, [ws])).m);
  const stateOf = async (id: string) => (await one(`SELECT state, ended_at, started_at FROM public.call_sessions WHERE id = $1`, [id]));

  it('before 298, an ended call can come back and be billed again (the defect)', async () => {
    const id = await call('active', { connected_at: new Date(Date.now() - 125_000).toISOString() });
    const before = await minutes();
    await q(`UPDATE public.call_sessions SET state = 'ended', ended_at = now() WHERE id = $1`, [id]);
    expect(await minutes()).toBe(before + 3);
    await q(`UPDATE public.call_sessions SET state = 'active', started_at = now() WHERE id = $1`, [id]);
    await q(`UPDATE public.call_sessions SET state = 'ended', ended_at = now() WHERE id = $1`, [id]);
    expect(await minutes()).toBe(before + 6);
  });

  it('a dry run (BEGIN … ROLLBACK) leaves nothing behind', async () => {
    await db.query('BEGIN');
    try {
      await db.query(SQL());
      expect(await exists()).toEqual({ fn: true, trg: true, idx: true });
    } finally {
      await db.query('ROLLBACK');
    }
    expect(await exists()).toEqual({ fn: false, trg: false, idx: false });
  });

  it('applies, and a second run changes nothing', async () => {
    await applyMigrationSql(db, SQL());
    expect(await exists()).toEqual({ fn: true, trg: true, idx: true });
    const defs = async () => (await q(`
      SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('team_call_place', 'call_sessions_keep_finished_state') ORDER BY 1`)).map((r) => r.d);
    const before = await defs();
    await applyMigrationSql(db, SQL());
    expect(await defs()).toEqual(before);
    expect((await q(`SELECT 1 FROM pg_trigger WHERE tgname = 'trg_call_sessions_keep_finished_state'`)).length).toBe(1);
  });

  it('an ended call keeps its state: its room started and finished again bills nothing more', async () => {
    const id = await call('active', { connected_at: new Date(Date.now() - 125_000).toISOString() });
    const before = await minutes();
    await q(`UPDATE public.call_sessions SET state = 'ended', ended_at = now() WHERE id = $1`, [id]);
    expect(await minutes()).toBe(before + 3);
    const ended = await stateOf(id);
    // room_started of a kept token, as the old webhook wrote it: nothing moves.
    const revived = await db.query(`UPDATE public.call_sessions SET state = 'active', started_at = now() WHERE id = $1`, [id]);
    expect(revived.rowCount).toBe(0);
    expect(await stateOf(id)).toEqual(ended);
    // room_finished again: still ended, still billed once.
    await q(`UPDATE public.call_sessions SET state = 'ended', ended_at = now() + interval '1 hour' WHERE id = $1`, [id]);
    expect(await minutes()).toBe(before + 3);
  });

  it('missed, cancelled and failed calls never become ended (or live) either', async () => {
    for (const s of ['missed', 'cancelled', 'failed']) {
      const id = await call(s, { connected_at: new Date(Date.now() - 600_000).toISOString() });
      const before = await minutes();
      for (const to of ['ended', 'pending', 'active']) {
        const r = await db.query(`UPDATE public.call_sessions SET state = $2::public.call_state, ended_at = now() WHERE id = $1`, [id, to]);
        expect(r.rowCount, `${s} → ${to}`).toBe(0);
      }
      expect((await stateOf(id)).state).toBe(s);
      expect(await minutes()).toBe(before);
    }
  });

  it('an update that keeps the state passes, and a live call moves and ends as before', async () => {
    const over = await call('ended');
    const r = await db.query(`UPDATE public.call_sessions SET recording_state = 'finalizing', metadata = '{"a":1}' WHERE id = $1`, [over]);
    expect(r.rowCount).toBe(1);
    const live = await call('pending');
    for (const to of ['ringing', 'connecting', 'active']) {
      expect((await db.query(`UPDATE public.call_sessions SET state = $2::public.call_state WHERE id = $1`, [live, to])).rowCount).toBe(1);
    }
    await q(`UPDATE public.call_sessions SET connected_at = now() - interval '61 seconds' WHERE id = $1`, [live]);
    const before = await minutes();
    expect((await db.query(`UPDATE public.call_sessions SET state = 'ended', ended_at = now() WHERE id = $1`, [live])).rowCount).toBe(1);
    expect(await minutes()).toBe(before + 2);
  });

  describe('team_call_place() with the plan\'s concurrency limit', () => {
    const cutoffs = () => [
      new Date(Date.now() - 45_000).toISOString(),
      new Date(Date.now() - 12 * 3600_000).toISOString(),
    ];
    const place = async (caller: string, callee: string, max: number | null, client: pg.Client = db) =>
      (await client.query(
        `SELECT public.team_call_place($1, $2, $3, 'audio', 'livekit', $4::jsonb, $5, $6, $7) AS r`,
        [ws, caller, callee, JSON.stringify({ team_call: { caller_user_id: caller, callee_user_id: callee, channel: 'audio' } }), ...cutoffs(), max],
      )).rows[0].r as { verdict: string; call?: Row; used?: number; max?: number };
    const liveCount = async () => Number((await one(
      `SELECT count(*) AS n FROM public.call_sessions WHERE workspace_id = $1 AND state IN ('pending', 'ringing', 'connecting', 'active')`, [ws])).n);

    beforeAll(async () => {
      await q(`UPDATE public.call_sessions SET state = 'ended' WHERE workspace_id = $1 AND state IN ('pending', 'ringing', 'connecting', 'active')`, [ws]);
    });

    it('at the limit: limit_reached, with the count, and nothing written', async () => {
      await call('pending');
      expect(await liveCount()).toBe(1);
      const r = await place(randomUUID(), randomUUID(), 1);
      expect(r).toEqual({ verdict: 'limit_reached', used: 1, max: 1 });
      expect(await liveCount()).toBe(1);
    });

    it('under the limit, or with none, it places as 293 does', async () => {
      const a = await place(randomUUID(), randomUUID(), 2);
      expect(a.verdict).toBe('placed');
      expect(a.call).toMatchObject({ entry_source: 'team_call', state: 'ringing', workspace_id: ws });
      for (const max of [null, -1]) {
        expect((await place(randomUUID(), randomUUID(), max)).verdict, String(max)).toBe('placed');
      }
      // 293's busy rule still holds under it.
      const A = randomUUID();
      expect((await place(A, randomUUID(), null)).verdict).toBe('placed');
      expect((await place(randomUUID(), A, 100)).verdict).toBe('callee_busy');
    });

    it('two pairs placing at limit − 1 run one after the other: only one gets through', async () => {
      const limit = (await liveCount()) + 1;
      const url = new URL(DSN!);
      url.pathname = `/${DB}`;
      const other = new pg.Client({ connectionString: url.toString() });
      await other.connect();
      try {
        await db.query('BEGIN');
        const first = await place(randomUUID(), randomUUID(), limit);
        expect(first.verdict).toBe('placed');
        let settled = false;
        const second = place(randomUUID(), randomUUID(), limit, other).finally(() => { settled = true; });
        await new Promise((r) => setTimeout(r, 300));
        expect(settled, 'the second waits for the workspace lock').toBe(false);
        await db.query('COMMIT');
        expect(await second).toEqual({ verdict: 'limit_reached', used: limit, max: limit });
        expect(await liveCount()).toBe(limit);
      } finally {
        await db.query('ROLLBACK').catch(() => {});
        await other.end();
      }
    });
  });

  it('only service_role reaches the new placement', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect((await one(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, PLACE9])).ok, role).toBe(false);
    }
    expect((await one(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [PLACE9])).ok).toBe(true);
  });
});
