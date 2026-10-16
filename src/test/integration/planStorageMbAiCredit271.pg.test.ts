// @vitest-environment node
/**
 * 271 — plans: storage in megabytes, one monthly AI credit. Against real
 * PostgreSQL built by the chain up to 270, with plans shaped like
 * production's (both editions hold the same shape):
 *
 *   - storage_mb = storage_gb × 1024 on every plan (-1 stays unlimited, a
 *     fraction becomes whole MB), storage_gb kept for the code still running;
 *   - a storage_gb workspace override gets a storage_mb copy;
 *   - every plan names its granted monthly AI credit in ai_allowance.IRR,
 *     the limits mirror it and the legacy ai_credits_per_month goes — and
 *     billing_plan_ai_allowance grants exactly what it granted before;
 *   - billing_storage_limit_mb and the downgrade report answer in MB (and
 *     keep 265's GB fields);
 *   - a second run changes nothing; a dry run (BEGIN … ROLLBACK) leaves no
 *     trace; only service_role reaches the new function.
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
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the 271 tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `plan_storage_mb_271_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '271_plan_storage_mb_ai_credit.sql';
const SQL = () => readFileSync(resolve(DIR, FILE), 'utf8');

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

/** Production's plans (2026-10-16), plus two shapes older code could leave behind. */
const PLANS: Array<{ slug: string; limits: Row; ai: Row; hidden?: boolean }> = [
  { slug: 't271-trial', limits: { storage_gb: 1, ai_credits_per_month: 1000 }, ai: { IRR: 5000 } },
  { slug: 't271-free', limits: { storage_gb: 0, ai_credits_per_month: 0 }, ai: { IRR: 0 } },
  { slug: 't271-startup', limits: { storage_gb: 0, ai_credits_per_month: 0 }, ai: { IRR: 300000 } },
  { slug: 't271-enterprise', limits: { storage_gb: 50, ai_credits_per_month: 600000 }, ai: { IRR: 600000 } },
  { slug: 't271-app-review', limits: { storage_gb: 20, ai_credits_per_month: 600000 }, ai: { IRR: 600000 }, hidden: true },
  // Only the legacy count names its credit; unlimited storage.
  { slug: 't271-legacy-count', limits: { storage_gb: -1, ai_credits_per_month: 7000 }, ai: {} },
  // A fraction of a GB; the credit only in the older limit.
  { slug: 't271-fraction', limits: { storage_gb: 2.5, included_ai_allowance_irr: 1234 }, ai: {} },
  // Already in MB (a plan saved by the new editor): left as it is.
  { slug: 't271-mb', limits: { storage_mb: 700, included_ai_allowance_irr: 10 }, ai: { IRR: 10 } },
];

const plan = async (slug: string): Promise<Row> =>
  one(`SELECT id, limits, ai_allowance, updated_at, public.billing_plan_ai_allowance(id, NULL)::numeric AS granted
         FROM public.billing_plans WHERE slug = $1`, [slug]);

let ws = '';
const granted = new Map<string, number>();

suite('271 — storage in MB and one monthly AI credit (real PostgreSQL, whole chain)', () => {
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
    for (const p of PLANS) {
      await q(`INSERT INTO public.billing_plans (name, slug, prices, limits, ai_allowance, is_active, is_hidden)
               VALUES ($1, $1, '{}', $2, $3, true, $4)`, [p.slug, JSON.stringify(p.limits), JSON.stringify(p.ai), p.hidden === true]);
      granted.set(p.slug, Number((await plan(p.slug)).granted));
    }
    const owner = randomUUID();
    ws = randomUUID();
    await q(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value)
             VALUES ($1, 'storage_gb', 3), ($1, 'ai_credits_per_month', 99)`, [ws]);
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('a dry run (BEGIN … ROLLBACK) leaves nothing behind', async () => {
    await db.query('BEGIN');
    try {
      await db.query(SQL());
      expect(((await plan('t271-enterprise')).limits as Row).storage_mb).toBe(51200);
    } finally {
      await db.query('ROLLBACK');
    }
    expect((await plan('t271-enterprise')).limits).not.toHaveProperty('storage_mb');
    expect((await q(`SELECT 1 FROM public.workspace_limit_overrides WHERE limit_key = 'storage_mb'`)).length).toBe(0);
    expect((await one(`SELECT to_regprocedure('public.billing_storage_limit_mb(uuid, uuid)') AS f`)).f).toBeNull();
  });

  it('applies: storage in MB on every plan, storage_gb kept for the old code', async () => {
    await applyMigrationSql(db, SQL());
    const expected: Record<string, number> = {
      't271-trial': 1024, 't271-free': 0, 't271-startup': 0, 't271-enterprise': 51200,
      't271-app-review': 20480, 't271-legacy-count': -1, 't271-fraction': 2560, 't271-mb': 700,
    };
    for (const [slug, mb] of Object.entries(expected)) {
      const limits = (await plan(slug)).limits as Row;
      expect(limits.storage_mb, slug).toBe(mb);
    }
    expect(((await plan('t271-enterprise')).limits as Row).storage_gb).toBe(50);
    expect((await plan('t271-mb')).limits).not.toHaveProperty('storage_gb');
  });

  it('one monthly AI credit: ai_allowance.IRR, mirrored, no legacy count — and every grant is unchanged', async () => {
    const expected: Record<string, number> = {
      't271-trial': 5000, 't271-free': 0, 't271-startup': 300000, 't271-enterprise': 600000,
      't271-app-review': 600000, 't271-legacy-count': 7000, 't271-fraction': 1234, 't271-mb': 10,
    };
    for (const [slug, irr] of Object.entries(expected)) {
      const p = await plan(slug);
      expect((p.ai_allowance as Row).IRR, slug).toBe(irr);
      expect((p.limits as Row).included_ai_allowance_irr, slug).toBe(irr);
      expect(p.limits, slug).not.toHaveProperty('ai_credits_per_month');
      expect(Number(p.granted), slug).toBe(granted.get(slug));
      expect(Number(p.granted), slug).toBe(irr);
    }
  });

  it('a storage_gb override gets its storage_mb copy; an ai_credits_per_month override is left alone', async () => {
    const rows = await q(`SELECT limit_key, limit_value FROM public.workspace_limit_overrides WHERE workspace_id = $1 ORDER BY limit_key`, [ws]);
    expect(rows).toEqual([
      { limit_key: 'ai_credits_per_month', limit_value: 99 },
      { limit_key: 'storage_gb', limit_value: 3 },
      { limit_key: 'storage_mb', limit_value: 3072 },
    ]);
  });

  it('the storage limit that blocks uploads, and the downgrade report, are in MB', async () => {
    const id = async (slug: string) => String((await plan(slug)).id);
    const lim = async (slug: string) => (await one(`SELECT public.billing_storage_limit_mb($1, $2::uuid) AS r`, [ws, await id(slug)])).r;
    // The workspace override applies first (3 GB → 3072 MB).
    expect(Number(await lim('t271-free'))).toBe(3072);
    await q(`DELETE FROM public.workspace_limit_overrides WHERE workspace_id = $1 AND limit_key LIKE 'storage%'`, [ws]);
    expect(Number(await lim('t271-free'))).toBe(0);
    expect(Number(await lim('t271-enterprise'))).toBe(51200);
    expect(await lim('t271-legacy-count')).toBeNull(); // unlimited
    // A plan that names only storage_gb (old code saved it meanwhile): × 1024.
    await q(`UPDATE public.billing_plans SET limits = (limits - 'storage_mb') || '{"storage_gb": 2}' WHERE slug = 't271-mb'`);
    expect(Number(await lim('t271-mb'))).toBe(2048);

    await q(`INSERT INTO public.workspace_usage_counters (workspace_id, period, storage_bytes)
             VALUES ($1, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), $2)
             ON CONFLICT (workspace_id, period) DO UPDATE SET storage_bytes = EXCLUDED.storage_bytes`, [ws, 5 * 1024 * 1024]);
    const report = async (slug: string) =>
      ((await one(`SELECT public.billing_lock_report($1, $2::uuid) AS r`, [ws, await id(slug)])).r as Row).storage as Row;
    // Free: no file storage — uploads blocked, nothing deleted.
    expect(await report('t271-free')).toMatchObject({ limit_mb: 0, used_mb: 5, uploads_blocked: true, limit_gb: 0 });
    expect(await report('t271-enterprise')).toMatchObject({ limit_mb: 51200, used_mb: 5, uploads_blocked: false, limit_gb: 50 });
    expect(await report('t271-legacy-count')).toMatchObject({ limit_mb: null, uploads_blocked: false });
  });

  it('runs twice: the second run changes nothing', async () => {
    await q(`UPDATE public.billing_plans SET limits = (limits - 'storage_gb') || '{"storage_mb": 700}' WHERE slug = 't271-mb'`);
    const before = await q(`SELECT slug, limits, ai_allowance, updated_at FROM public.billing_plans ORDER BY slug`);
    const overrides = await q(`SELECT workspace_id, limit_key, limit_value, updated_at FROM public.workspace_limit_overrides ORDER BY 1, 2`);
    await applyMigrationSql(db, SQL());
    expect(await q(`SELECT slug, limits, ai_allowance, updated_at FROM public.billing_plans ORDER BY slug`)).toEqual(before);
    expect(await q(`SELECT workspace_id, limit_key, limit_value, updated_at FROM public.workspace_limit_overrides ORDER BY 1, 2`)).toEqual(overrides);
  });

  it('a plan the Super Admin later sets in MB is never converted back from a stale storage_gb', async () => {
    // The new editor drops storage_gb when it saves storage_mb; the migration only converts plans that still name storage_gb.
    await q(`UPDATE public.billing_plans SET limits = (limits - 'storage_gb') || '{"storage_mb": 300}' WHERE slug = 't271-enterprise'`);
    await applyMigrationSql(db, SQL());
    expect(((await plan('t271-enterprise')).limits as Row).storage_mb).toBe(300);
  });

  it('only service_role reaches the new function', async () => {
    for (const role of ['anon', 'authenticated']) {
      const r = await one(`SELECT has_function_privilege($1, 'public.billing_storage_limit_mb(uuid, uuid)', 'EXECUTE') AS ok`, [role]);
      expect(r.ok, role).toBe(false);
    }
    expect((await one(`SELECT has_function_privilege('service_role', 'public.billing_storage_limit_mb(uuid, uuid)', 'EXECUTE') AS ok`)).ok).toBe(true);
    expect((await one(`SELECT has_function_privilege('authenticated', 'public.billing_lock_report(uuid, uuid)', 'EXECUTE') AS ok`)).ok).toBe(false);
  });
});
