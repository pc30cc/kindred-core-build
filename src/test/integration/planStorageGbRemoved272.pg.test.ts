// @vitest-environment node
/**
 * 272 — the storage limit in megabytes only. Against real PostgreSQL built
 * by the chain up to 271, with plans shaped like production's after 271
 * (both editions: storage_gb next to storage_mb):
 *
 *   - storage_gb leaves every plan; no plan's storage limit changes (a plan
 *     whose storage_mb is missing or unreadable gets storage_gb × 1024 first);
 *   - a storage_gb workspace override goes; one without a storage_mb row
 *     becomes one (× 1024, too large = unlimited);
 *   - billing_storage_limit_mb reads storage_mb only, the downgrade report
 *     answers storage in MB only (what 445e227's code reads), and the App
 *     Review plan is seeded in MB;
 *   - a second run changes nothing; a dry run (BEGIN … ROLLBACK) leaves no
 *     trace; only service_role reaches the functions.
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
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the 272 tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `plan_storage_gb_removed_272_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '272_plan_storage_gb_removed.sql';
const SQL = () => readFileSync(resolve(DIR, FILE), 'utf8');

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

/** Production's plans after 271 (2026-10-16), plus shapes older code could leave behind. */
const PLANS: Array<{ slug: string; limits: Row; mb: number | null }> = [
  { slug: 't272-trial', limits: { storage_gb: 1, storage_mb: 1024, max_agents: 2 }, mb: 1024 },
  { slug: 't272-free', limits: { storage_gb: 0, storage_mb: 0 }, mb: 0 },
  { slug: 't272-startup', limits: { storage_gb: 0, storage_mb: 0 }, mb: 0 },
  { slug: 't272-enterprise', limits: { storage_gb: 50, storage_mb: 51200 }, mb: 51200 },
  { slug: 't272-app-review', limits: { storage_gb: 20, storage_mb: 20480 }, mb: 20480 },
  // Saved by older code after 271: storage_gb only.
  { slug: 't272-gb-only', limits: { storage_gb: 2.5 }, mb: 2560 },
  // Unlimited in GB only.
  { slug: 't272-gb-unlimited', limits: { storage_gb: -1 }, mb: -1 },
  // storage_mb unreadable: the fallback read storage_gb.
  { slug: 't272-mb-unreadable', limits: { storage_gb: 3, storage_mb: 'lots' }, mb: 3072 },
  // storage_gb unreadable, no storage_mb: no limit either way.
  { slug: 't272-gb-unreadable', limits: { storage_gb: 'lots', max_agents: 1 }, mb: null },
  // Already MB only (saved by the new editor).
  { slug: 't272-mb', limits: { storage_mb: 700 }, mb: 700 },
];

const planRow = async (slug: string): Promise<Row> =>
  one(`SELECT id, limits, updated_at FROM public.billing_plans WHERE slug = $1`, [slug]);
const id = async (slug: string) => String((await planRow(slug)).id);

/** The storage limit in MB as SQL reads it (-1 for unlimited/absent). */
const sqlLimit = async (ws: string, slug: string): Promise<number | null> => {
  const r = (await one(`SELECT public.billing_storage_limit_mb($1, $2::uuid) AS r`, [ws, await id(slug)])).r;
  return r === null ? null : Number(r);
};

let plain = ''; // no overrides
let wsBoth = ''; // storage_gb 3 and its 271 copy storage_mb 3072
let wsGbOnly = ''; // storage_gb 5 only
let wsHuge = ''; // storage_gb too large for × 1024
const before = new Map<string, number | null>();

async function workspace(owner: string, name: string): Promise<string> {
  const ws = randomUUID();
  await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)`, [ws, name, `ws-${ws.slice(0, 8)}`, owner]);
  return ws;
}

suite('272 — storage in MB only (real PostgreSQL, whole chain)', () => {
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
      await q(`INSERT INTO public.billing_plans (name, slug, prices, limits, is_active) VALUES ($1, $1, '{}', $2, true)`,
        [p.slug, JSON.stringify(p.limits)]);
    }
    const owner = randomUUID();
    await q(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
    plain = await workspace(owner, 'Plain');
    wsBoth = await workspace(owner, 'Both');
    wsGbOnly = await workspace(owner, 'GB only');
    wsHuge = await workspace(owner, 'Huge');
    await q(`INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value, admin_notes) VALUES
               ($1, 'storage_gb', 3, 'three'), ($1, 'storage_mb', 3072, 'three'),
               ($2, 'storage_gb', 5, 'five'),
               ($3, 'storage_gb', 3000000, NULL),
               ($1, 'max_agents', 4, NULL)`, [wsBoth, wsGbOnly, wsHuge]);
    // What 271's function answers for each plan, before 272.
    for (const p of PLANS) before.set(p.slug, await sqlLimit(plain, p.slug));
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('a dry run (BEGIN … ROLLBACK) leaves nothing behind', async () => {
    const plans = await q(`SELECT slug, limits, updated_at FROM public.billing_plans ORDER BY slug`);
    const overrides = await q(`SELECT workspace_id, limit_key, limit_value, updated_at FROM public.workspace_limit_overrides ORDER BY 1, 2`);
    await db.query('BEGIN');
    try {
      await db.query(SQL());
      expect((await planRow('t272-enterprise')).limits).not.toHaveProperty('storage_gb');
    } finally {
      await db.query('ROLLBACK');
    }
    expect(await q(`SELECT slug, limits, updated_at FROM public.billing_plans ORDER BY slug`)).toEqual(plans);
    expect(await q(`SELECT workspace_id, limit_key, limit_value, updated_at FROM public.workspace_limit_overrides ORDER BY 1, 2`)).toEqual(overrides);
    expect(((await planRow('t272-enterprise')).limits as Row).storage_gb).toBe(50);
  });

  it('applies: storage_gb leaves every plan, and every plan keeps its storage limit in MB', async () => {
    await applyMigrationSql(db, SQL());
    expect((await q(`SELECT slug FROM public.billing_plans WHERE limits ? 'storage_gb'`)).length).toBe(0);
    for (const p of PLANS) {
      const limits = (await planRow(p.slug)).limits as Row;
      if (p.mb === null) expect(limits, p.slug).not.toHaveProperty('storage_mb');
      else expect(limits.storage_mb, p.slug).toBe(p.mb);
      // What blocks uploads is what it was before 272.
      expect(await sqlLimit(plain, p.slug), p.slug).toBe(before.get(p.slug));
    }
    expect(((await planRow('t272-trial')).limits as Row).max_agents).toBe(2);
    expect(((await planRow('t272-gb-unreadable')).limits as Row).max_agents).toBe(1);
  });

  it('workspace overrides: storage_gb goes; one without a storage_mb row becomes one', async () => {
    const rows = await q(`SELECT workspace_id, limit_key, limit_value, admin_notes FROM public.workspace_limit_overrides
                           WHERE workspace_id = ANY($1::uuid[]) ORDER BY workspace_id, limit_key`, [[wsBoth, wsGbOnly, wsHuge]]);
    const of = (ws: string) => rows.filter((r) => r.workspace_id === ws).map(({ workspace_id: _w, ...r }) => r);
    expect(of(wsBoth)).toEqual([
      { limit_key: 'max_agents', limit_value: 4, admin_notes: null },
      { limit_key: 'storage_mb', limit_value: 3072, admin_notes: 'three' },
    ]);
    expect(of(wsGbOnly)).toEqual([{ limit_key: 'storage_mb', limit_value: 5120, admin_notes: 'five' }]);
    // Too large for an integer in MB: it allowed more than any upload, so unlimited.
    expect(of(wsHuge)).toEqual([{ limit_key: 'storage_mb', limit_value: -1, admin_notes: null }]);
    expect((await q(`SELECT 1 FROM public.workspace_limit_overrides WHERE limit_key = 'storage_gb'`)).length).toBe(0);
    expect(await sqlLimit(wsGbOnly, 't272-free')).toBe(5120);
    expect(await sqlLimit(wsHuge, 't272-free')).toBeNull();
  });

  it('billing_storage_limit_mb reads storage_mb only', async () => {
    await q(`UPDATE public.billing_plans SET limits = limits || '{"storage_gb": 9}' WHERE slug = 't272-gb-unreadable'`);
    try {
      expect(await sqlLimit(plain, 't272-gb-unreadable')).toBeNull();
    } finally {
      await q(`UPDATE public.billing_plans SET limits = limits - 'storage_gb' WHERE slug = 't272-gb-unreadable'`);
    }
  });

  it('the downgrade report answers storage in MB only', async () => {
    await q(`INSERT INTO public.workspace_usage_counters (workspace_id, period, storage_bytes)
             VALUES ($1, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), $2)
             ON CONFLICT (workspace_id, period) DO UPDATE SET storage_bytes = EXCLUDED.storage_bytes`, [plain, 5 * 1024 * 1024]);
    const report = async (slug: string) =>
      ((await one(`SELECT public.billing_lock_report($1, $2::uuid) AS r`, [plain, await id(slug)])).r as Row).storage as Row;
    expect(await report('t272-free')).toEqual({ limit_mb: 0, used_mb: 5, uploads_blocked: true });
    expect(await report('t272-enterprise')).toEqual({ limit_mb: 51200, used_mb: 5, uploads_blocked: false });
    expect(await report('t272-gb-unlimited')).toEqual({ limit_mb: null, used_mb: 5, uploads_blocked: false });
  });

  it('the App Review plan is seeded in MB', async () => {
    // On top of the chain's own Enterprise plan (239's seed, 50 GB → 51200 MB by 271).
    expect(((await planRow('enterprise')).limits as Row).storage_mb).toBe(51200);
    const planId = (await one(`SELECT public.app_review_seed_plan() AS id`)).id;
    const limits = (await one(`SELECT limits FROM public.billing_plans WHERE id = $1`, [planId])).limits as Row;
    expect(limits.storage_mb).toBe(20480);
    expect(limits).not.toHaveProperty('storage_gb');
  });

  it('runs twice: the second run changes nothing', async () => {
    const plans = await q(`SELECT slug, limits, updated_at FROM public.billing_plans ORDER BY slug`);
    const overrides = await q(`SELECT workspace_id, limit_key, limit_value, updated_at FROM public.workspace_limit_overrides ORDER BY 1, 2`);
    await applyMigrationSql(db, SQL());
    expect(await q(`SELECT slug, limits, updated_at FROM public.billing_plans ORDER BY slug`)).toEqual(plans);
    expect(await q(`SELECT workspace_id, limit_key, limit_value, updated_at FROM public.workspace_limit_overrides ORDER BY 1, 2`)).toEqual(overrides);
  });

  it('only service_role reaches the functions', async () => {
    for (const fn of ['public.billing_storage_limit_mb(uuid, uuid)', 'public.billing_lock_report(uuid, uuid)', 'public.app_review_seed_plan()']) {
      for (const role of ['anon', 'authenticated']) {
        const r = await one(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
        expect(r.ok, `${role} ${fn}`).toBe(false);
      }
      expect((await one(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [fn])).ok, fn).toBe(true);
    }
  });
});
