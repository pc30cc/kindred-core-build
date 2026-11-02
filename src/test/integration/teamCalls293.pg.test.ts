// @vitest-environment node
/**
 * 293 — colleague calls: the App Review plan carries `team_calls`
 * (docs/operations/TEAM_CALLS.md, "Plan"). Against real PostgreSQL built by
 * the chain up to 292:
 *
 *   - the App Review plan gains `team_calls: true` and nothing else; no other
 *     plan is touched;
 *   - app_review_seed_plan() keeps it on a reseed, and is otherwise 272's;
 *   - team_call_place() places a ringing colleague call only while neither
 *     member is in a live one (as caller or callee, in any workspace), and
 *     two placements that share a member run one after the other, so the
 *     second sees the first: two calls placed at the same moment never both
 *     ring;
 *   - a dry run (BEGIN … ROLLBACK) leaves no trace, a second run changes
 *     nothing, and only service_role reaches the functions.
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
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the 293 tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `team_calls_293_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '293_team_calls.sql';
const SQL = () => readFileSync(resolve(DIR, FILE), 'utf8');

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];
const plans = () => q(`SELECT slug, entitlements, limits, updated_at FROM public.billing_plans ORDER BY slug`);
const entitlements = async (slug: string) =>
  (await one(`SELECT entitlements FROM public.billing_plans WHERE slug = $1`, [slug])).entitlements as Row;
const seedSource = async () =>
  (await one(`SELECT pg_get_functiondef('public.app_review_seed_plan()'::regprocedure) AS d`)).d as string;
const PLACE_SIG = 'public.team_call_place(uuid, uuid, uuid, text, text, jsonb, timestamptz, timestamptz)';
const placeExists = async () => (await one(`SELECT to_regprocedure($1) IS NOT NULL AS ok`, [PLACE_SIG])).ok as boolean;

suite('293 — colleague calls on the App Review plan (real PostgreSQL, whole chain)', () => {
  let appReviewBefore: Row = {};

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
    await q(`INSERT INTO public.billing_plans (name, slug, prices, entitlements, limits, is_active)
             VALUES ('t293-pro', 't293-pro', '{}', '{"chat": true, "voice_video": true}', '{"max_agents": 5}', true)`);
    // The App Review plan as production has it before 293.
    await q(`SELECT public.app_review_seed_plan()`);
    appReviewBefore = await entitlements('app-review');
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('starts without the key anywhere', async () => {
    expect(appReviewBefore).not.toHaveProperty('team_calls');
    expect((await q(`SELECT slug FROM public.billing_plans WHERE entitlements ? 'team_calls'`)).length).toBe(0);
  });

  it('a dry run (BEGIN … ROLLBACK) leaves nothing behind', async () => {
    const before = await plans();
    const fn = await seedSource();
    await db.query('BEGIN');
    try {
      await db.query(SQL());
      expect((await entitlements('app-review')).team_calls).toBe(true);
    } finally {
      await db.query('ROLLBACK');
    }
    expect(await plans()).toEqual(before);
    expect(await seedSource()).toBe(fn);
    expect(await placeExists()).toBe(false);
  });

  it('applies: the App Review plan gains team_calls and nothing else changes', async () => {
    const before = await plans();
    await applyMigrationSql(db, SQL());
    expect(await entitlements('app-review')).toEqual({ ...appReviewBefore, team_calls: true });
    const after = await plans();
    expect(after.filter((p) => p.slug !== 'app-review')).toEqual(before.filter((p) => p.slug !== 'app-review'));
    expect(after.find((p) => p.slug === 'app-review')!.limits).toEqual(before.find((p) => p.slug === 'app-review')!.limits);
  });

  it('a reseed keeps it on, and keeps every other key as 272 seeded it', async () => {
    await q(`SELECT public.app_review_seed_plan()`);
    expect(await entitlements('app-review')).toEqual({ ...appReviewBefore, team_calls: true });
  });

  it('runs twice: the second run changes nothing', async () => {
    const before = await plans();
    await applyMigrationSql(db, SQL());
    expect(await plans()).toEqual(before);
  });

  it('only service_role reaches the seed and the placement', async () => {
    for (const sig of ['public.app_review_seed_plan()', PLACE_SIG]) {
      for (const role of ['anon', 'authenticated']) {
        expect((await one(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, sig])).ok, `${role} ${sig}`).toBe(false);
      }
      expect((await one(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [sig])).ok, sig).toBe(true);
    }
  });

  describe('team_call_place(): the busy check and the row, one member at a time', () => {
    const A = randomUUID();
    const B = randomUUID();
    const C = randomUUID();
    let ws = '';
    let otherWs = '';

    /** The instants the API passes: a ring is 45 s, a live row at most 12 h old. */
    const cutoffs = () => [
      new Date(Date.now() - 45_000).toISOString(),
      new Date(Date.now() - 12 * 3600_000).toISOString(),
    ];
    const place = async (caller: string, callee: string, client: pg.Client = db, workspace = ws) =>
      (await client.query(
        `SELECT public.team_call_place($1, $2, $3, 'audio', 'livekit', $4::jsonb, $5, $6) AS r`,
        [workspace, caller, callee, JSON.stringify({ team_call: { caller_user_id: caller, callee_user_id: callee, channel: 'audio' } }), ...cutoffs()],
      )).rows[0].r as { verdict: string; call?: Row };
    const live = () => q(`SELECT id, state, initiated_by FROM public.call_sessions WHERE entry_source = 'team_call' AND state IN ('ringing', 'connecting', 'active')`);

    beforeAll(async () => {
      const owner = randomUUID();
      await q(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
      ws = randomUUID();
      otherWs = randomUUID();
      for (const id of [ws, otherWs]) {
        await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
      }
    });

    it('places a ringing colleague call, as the API reads one', async () => {
      const placed = await place(A, B);
      expect(placed.verdict).toBe('placed');
      const row = await one(`SELECT * FROM public.call_sessions WHERE id = $1`, [placed.call!.id]);
      // The row comes back whole, as a read of it would give it.
      expect(placed.call).toEqual((await one(`SELECT to_jsonb(s) AS j FROM public.call_sessions s WHERE id = $1`, [placed.call!.id])).j);
      expect(row).toMatchObject({
        workspace_id: ws, provider: 'livekit', call_type: 'audio', context_type: 'internal', context_id: null,
        entry_source: 'team_call', state: 'ringing', initiated_by: A, initiated_by_type: 'internal',
        recording_enabled: false, recording_state: 'disabled', connected_at: null,
      });
      expect((row.metadata as Row).team_call).toEqual({ caller_user_id: A, callee_user_id: B, channel: 'audio' });
    });

    it('a member in a live colleague call cannot ring, nor be rung, in any workspace', async () => {
      expect((await place(C, B)).verdict).toBe('callee_busy');
      expect((await place(B, C)).verdict).toBe('caller_busy');
      expect((await place(C, A)).verdict).toBe('callee_busy');
      expect((await place(A, C)).verdict).toBe('caller_busy');
      expect((await place(C, A, db, otherWs)).verdict).toBe('callee_busy');
      expect(await live()).toHaveLength(1);

      for (const state of ['connecting', 'active']) {
        await q(`UPDATE public.call_sessions SET state = $1::public.call_state WHERE entry_source = 'team_call'`, [state]);
        expect((await place(C, B)).verdict, state).toBe('callee_busy');
      }
    });

    it('a ring that ran out, a call that is over and a row past the live window hold nobody', async () => {
      await q(`UPDATE public.call_sessions SET state = 'ringing', created_at = now() - interval '46 seconds' WHERE entry_source = 'team_call'`);
      const afterRing = await place(C, B);
      expect(afterRing.verdict).toBe('placed');

      await q(`UPDATE public.call_sessions SET state = 'ended' WHERE id = $1`, [afterRing.call!.id]);
      await q(`UPDATE public.call_sessions SET state = 'active', created_at = now() - interval '13 hours' WHERE initiated_by = $1`, [A]);
      const afterOld = await place(B, C);
      expect(afterOld.verdict).toBe('placed');
      await q(`UPDATE public.call_sessions SET state = 'ended' WHERE entry_source = 'team_call'`);
    });

    it('two placements that share a member run one after the other: the second sees the first', async () => {
      const url = new URL(DSN!);
      url.pathname = `/${DB}`;
      const other = new pg.Client({ connectionString: url.toString() });
      await other.connect();
      try {
        // A and B call each other at the same moment.
        await db.query('BEGIN');
        const first = await place(A, B);
        expect(first.verdict).toBe('placed');
        let settled = false;
        const second = place(B, A, other).finally(() => { settled = true; });
        await new Promise((r) => setTimeout(r, 300));
        expect(settled, 'the second waits for the first member lock').toBe(false);
        await db.query('COMMIT');
        expect((await second).verdict).toBe('caller_busy');
        expect(await live()).toEqual([expect.objectContaining({ id: first.call!.id, initiated_by: A })]);
      } finally {
        await db.query('ROLLBACK').catch(() => {});
        await other.end();
      }
    });

    it('refuses a call to oneself and a channel that is not a call', async () => {
      await expect(place(C, C)).rejects.toMatchObject({ code: '22023' });
      await expect(q(
        `SELECT public.team_call_place($1, $2, $3, 'screenshare', 'livekit', '{}'::jsonb, now(), now())`,
        [ws, C, randomUUID()],
      )).rejects.toMatchObject({ code: '22023' });
    });
  });
});
