// @vitest-environment node
/**
 * 269 — revenue survives a workspace purge, against real PostgreSQL built by
 * the whole migration chain (docs/billing/SIMPLE_BILLING.md, phase 6 "Known
 * limits").
 *
 *   A1  a workspace with payments in two months and refunds is purged
 *       (admin_purge_workspaces, as service_role): the revenue and ledger
 *       reports over the window are identical before and after; the archive
 *       holds its succeeded payments (with the refunds, their times and the
 *       workspace's name) and every ledger row; a failed attempt is not kept;
 *   A2  admin_delete_user: the user's own workspace is archived; a workspace
 *       the user topped up survives with its rows, which are not archived;
 *   A3  a plain workspace delete (ON DELETE CASCADE) archives too (no name);
 *       the pruning job's delete of an unpaid attempt does not;
 *   A4  a payment restored into the live table after its archive is counted
 *       once;
 *   A5  nobody writes the archives directly: service_role cannot INSERT,
 *       UPDATE, DELETE or TRUNCATE (it may SELECT), anon and authenticated
 *       cannot read, the owner's UPDATE and DELETE are refused by a trigger,
 *       and the trigger functions cannot be called;
 *   A6  running 269 again changes nothing (functions, triggers, ACLs, the
 *       archived rows, the reports);
 *   A7  a restored payment that gets a new refund and is deleted again keeps
 *       that refund: its archive row gains it (append-merge, the only
 *       change the archive accepts), and the closed month does not change;
 *   A8  a second run never takes ACCESS EXCLUSIVE on the source tables (it
 *       would deadlock with a settle or a refund in flight).
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
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the revenue archive SQL tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `simplebilling269_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '269_billing_revenue_archive.sql';
const SQL_269 = readFileSync(resolve(DIR, FILE), 'utf8');

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

let adminUser = '';

async function makeUser(isAdmin = false): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [id, `u-${id.slice(0, 8)}@test.local`]);
  if (isAdmin) await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [id]);
  return id;
}

async function makeWorkspace(name: string, owner?: string): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)`, [
    id, name, `ws-${id.slice(0, 8)}`, owner ?? (await makeUser()),
  ]);
  return id;
}

let seq = 0;
/** A gateway payment confirmed and settled through 259's functions, completed at `completedAt`. */
async function paid(ws: string, o: { provider: string; currency: string; net: number; tax?: number; completedAt: string; by?: string | null }): Promise<string> {
  const tax = o.tax ?? 0;
  const id = String((await one(
    `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, tax_minor, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [ws, o.provider, o.currency, o.net + tax, o.net, tax, o.by ?? null],
  )).id);
  await q(`SELECT public.billing_account_record_verification($1, $2, $3, $4)`, [id, o.net + tax, o.currency, `txn_${++seq}_${randomUUID()}`]);
  await q(`SELECT public.billing_account_settle_payment($1)`, [id]);
  await q(`UPDATE public.billing_account_payments SET completed_at = $2 WHERE id = $1`, [id, o.completedAt]);
  return id;
}

/** A provider refund (259), then its time moved to `at` (266's stamp keeps a time that is there). */
async function refund(pay: string, refundId: string, amount: number, at: string): Promise<void> {
  await q(`SELECT public.billing_account_refund_payment($1, $2, $3)`, [pay, refundId, amount]);
  await q(
    `UPDATE public.billing_account_payments
        SET purpose_detail = jsonb_set(purpose_detail, ARRAY['refunds', $2::text, 'refunded_at'], to_jsonb($3::text))
      WHERE id = $1`, [pay, refundId, at]);
}

const WINDOW = { from: '2026-01-01T00:00:00Z', tz: 'Asia/Tehran' };
const to = () => new Date(Date.now() + 2 * 86_400_000).toISOString();

/** Both reports over the window, as the backend reads them (service_role). */
async function reports(): Promise<{ revenue: unknown; ledger: unknown }> {
  return asService(async () => ({
    revenue: (await one(`SELECT public.billing_admin_revenue_days($1, $2, $3) AS r`, [WINDOW.from, to(), WINDOW.tz])).r,
    ledger: (await one(`SELECT public.billing_admin_ledger_days($1, $2, $3) AS r`, [WINDOW.from, to(), WINDOW.tz])).r,
  }));
}

/** As the backend calls it: as service_role, in its own transaction. */
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await q('BEGIN');
  try {
    await q('SET LOCAL ROLE service_role');
    const r = await fn();
    await q('COMMIT');
    return r;
  } catch (e) {
    await q('ROLLBACK');
    throw e;
  }
}

const archivedPayments = (ws: string) =>
  q(`SELECT payment_id, workspace_name, provider, status, currency, amount_minor::int AS amount, net_minor::int AS net,
            tax_minor::int AS tax, refunded_minor::int AS refunded, refunds, completed_at
       FROM public.billing_revenue_archive WHERE purged_workspace_id = $1 ORDER BY completed_at`, [ws]);
const archivedLedger = (ws: string) =>
  q(`SELECT ledger_id AS id, kind, amount_minor::int AS amount, currency, created_at
       FROM public.billing_ledger_archive WHERE purged_workspace_id = $1 ORDER BY created_at, ledger_id`, [ws]);
const liveLedger = (ws: string) =>
  q(`SELECT id, kind, amount_minor::int AS amount, currency, created_at
       FROM public.billing_account_ledger WHERE workspace_id = $1 ORDER BY created_at, id`, [ws]);

suite('269 — revenue survives a workspace purge (real PostgreSQL, whole chain)', () => {
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

    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files.filter((f) => f <= FILE)) {
      await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
    }
    adminUser = await makeUser(true);
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('A1 a purge leaves the revenue and ledger reports of every month as they were', async () => {
    const ws = await makeWorkspace('Gone Ltd');
    const july = await paid(ws, { provider: 'rv_arch', currency: 'IRR', net: 1_000_000, tax: 100_000, completedAt: '2026-07-14T08:00:00Z' });
    const aug = await paid(ws, { provider: 'rv_arch', currency: 'IRR', net: 2_000_000, tax: 200_000, completedAt: '2026-08-20T21:30:00Z' });
    await refund(july, 'rf_a', 550_000, '2026-08-02T10:00:00Z');
    await refund(aug, 'rf_b', 220_000, '2026-09-01T10:00:00Z');
    await refund(aug, 'rf_c', 110_000, '2026-09-03T10:00:00Z');
    // A failed attempt: not revenue, not archived.
    const failed = String((await one(
      `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, status)
       VALUES ($1, 'rv_arch', 'IRR', 5000, 5000, 'failed') RETURNING id`, [ws],
    )).id);
    // A workspace that stays, so the report is not only the purged one.
    const stays = await makeWorkspace('Stays Ltd');
    await paid(stays, { provider: 'rv_arch', currency: 'IRR', net: 700_000, completedAt: '2026-07-20T08:00:00Z' });

    const ledgerBefore = await liveLedger(ws);
    expect(ledgerBefore.length).toBeGreaterThanOrEqual(5); // two top-ups, three refunds
    const before = await reports();
    expect((before.revenue as Row[]).filter((r) => r.provider === 'rv_arch').length).toBeGreaterThanOrEqual(4);

    await asService(() => q(`SELECT public.admin_purge_workspaces(ARRAY[$1]::uuid[])`, [ws]));

    expect(await q(`SELECT 1 FROM public.workspaces WHERE id = $1`, [ws])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM public.billing_account_payments WHERE workspace_id = $1`, [ws])).toHaveLength(0);
    expect(await liveLedger(ws)).toHaveLength(0);
    expect(await reports()).toEqual(before);

    const archived = await archivedPayments(ws);
    expect(archived.map((r) => r.payment_id)).toEqual([july, aug]);
    expect(archived.map((r) => r.payment_id)).not.toContain(failed);
    expect(archived[0]).toMatchObject({
      workspace_name: 'Gone Ltd', provider: 'rv_arch', status: 'succeeded', currency: 'IRR',
      amount: 1_100_000, net: 1_000_000, tax: 100_000,
    });
    expect((archived[0].refunds as Row).rf_a).toMatchObject({ amount_minor: 550_000, refunded_at: '2026-08-02T10:00:00Z' });
    expect(Object.keys(archived[1].refunds as Row).sort()).toEqual(['rf_b', 'rf_c']);
    expect(await archivedLedger(ws)).toEqual(ledgerBefore);
  });

  it('A2 admin_delete_user archives the user\'s workspace; a workspace the user topped up keeps its rows, unarchived', async () => {
    const user = await makeUser();
    const own = await makeWorkspace('Own Ltd', user);
    const ownPay = await paid(own, { provider: 'rv_user', currency: 'USD', net: 900, completedAt: '2026-06-10T08:00:00Z' });
    const theirs = await makeWorkspace('Theirs Ltd');
    const theirPay = await paid(theirs, { provider: 'rv_user', currency: 'USD', net: 300, completedAt: '2026-06-11T08:00:00Z', by: user });
    const before = await reports();

    await asService(() => q(`SELECT public.admin_delete_user($1, $2)`, [adminUser, user]));

    expect(await reports()).toEqual(before);
    expect((await archivedPayments(own)).map((r) => r.payment_id)).toEqual([ownPay]);
    expect(await q(`SELECT 1 FROM public.billing_account_payments WHERE id = $1`, [theirPay])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM public.billing_revenue_archive WHERE purged_workspace_id = $1`, [theirs])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM public.billing_ledger_archive WHERE purged_workspace_id = $1`, [theirs])).toHaveLength(0);
  });

  it('A3 a plain workspace delete archives too; the pruning job\'s delete of an unpaid attempt does not', async () => {
    const ws = await makeWorkspace('Cascade Ltd');
    const pay = await paid(ws, { provider: 'rv_cascade', currency: 'USD', net: 400, completedAt: '2026-05-05T08:00:00Z' });
    const before = await reports();
    await q(`DELETE FROM public.workspaces WHERE id = $1`, [ws]);
    expect(await reports()).toEqual(before);
    // The cascade runs after the workspace row is gone: no name to copy.
    expect(await archivedPayments(ws)).toEqual([expect.objectContaining({ payment_id: pay, workspace_name: null })]);
    expect(await archivedLedger(ws)).toHaveLength(1);

    const other = await makeWorkspace('Prune Ltd');
    await q(
      `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, status, created_at)
       VALUES ($1, 'rv_prune', 'USD', 100, 100, 'expired', now() - interval '90 days')`, [other]);
    const pruned = await asService(async () => Number((await one(`SELECT public.billing_account_prune_payments(30) AS n`)).n));
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(await q(`SELECT 1 FROM public.billing_revenue_archive WHERE provider = 'rv_prune'`)).toHaveLength(0);
  });

  it('A4 a payment restored after its archive is counted once', async () => {
    const ws = await makeWorkspace('Restored Ltd');
    const pay = await paid(ws, { provider: 'rv_restore', currency: 'USD', net: 1200, completedAt: '2026-04-04T08:00:00Z' });
    const row = await one(`SELECT * FROM public.billing_account_payments WHERE id = $1`, [pay]);
    const before = await reports();
    await asService(() => q(`SELECT public.admin_purge_workspaces(ARRAY[$1]::uuid[])`, [ws]));
    // Brought back by hand (from a backup): the workspace, then the payment with its id.
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Restored Ltd', $2, $3)`, [ws, `ws-r-${ws.slice(0, 8)}`, await makeUser()]);
    await q(
      `INSERT INTO public.billing_account_payments
         (id, workspace_id, provider, currency, amount_minor, net_minor, tax_minor, status, completed_at, purpose, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [pay, ws, row.provider, row.currency, row.amount_minor, row.net_minor, row.tax_minor, row.status, row.completed_at, row.purpose, row.source]);
    expect(await reports()).toEqual(before);
  });

  it('A5 nobody writes the archives directly', async () => {
    const id = String((await one(`SELECT payment_id FROM public.billing_revenue_archive LIMIT 1`)).payment_id);
    const ledgerId = String((await one(`SELECT ledger_id FROM public.billing_ledger_archive LIMIT 1`)).ledger_id);
    for (const sql of [
      `INSERT INTO public.billing_revenue_archive (payment_id, purged_workspace_id, provider, source, purpose, status, currency,
         amount_minor, net_minor, tax_minor, refunded_minor, refunds, created_at, updated_at, completed_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), 'fake', 'checkout', 'topup', 'succeeded', 'USD', 1, 1, 0, 0, '{}', now(), now(), now())`,
      `UPDATE public.billing_revenue_archive SET amount_minor = 0 WHERE payment_id = '${id}'`,
      `DELETE FROM public.billing_revenue_archive WHERE payment_id = '${id}'`,
      `TRUNCATE public.billing_revenue_archive`,
      `INSERT INTO public.billing_ledger_archive (ledger_id, purged_workspace_id, kind, amount_minor, currency, created_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), 'topup', 1, 'USD', now())`,
      `DELETE FROM public.billing_ledger_archive WHERE ledger_id = '${ledgerId}'`,
      `TRUNCATE public.billing_ledger_archive`,
    ]) {
      await expect(asService(() => q(sql)), sql).rejects.toThrow(/permission denied/);
    }
    // service_role reads them (RLS on, one read policy).
    expect(Number((await asService(() => one(`SELECT count(*) AS n FROM public.billing_revenue_archive`))).n)).toBeGreaterThan(0);
    for (const role of ['anon', 'authenticated']) {
      for (const t of ['billing_revenue_archive', 'billing_ledger_archive']) {
        expect((await one(`SELECT has_table_privilege($1, $2, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') AS p`, [role, `public.${t}`])).p).toBe(false);
      }
    }
    // The owner too: append-only.
    await expect(q(`UPDATE public.billing_revenue_archive SET amount_minor = 0 WHERE payment_id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM public.billing_revenue_archive WHERE payment_id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM public.billing_ledger_archive WHERE ledger_id = $1`, [ledgerId])).rejects.toThrow(/append-only/);
    // The copy is a trigger function: not callable.
    await expect(asService(() => q(`SELECT public.billing_account_payments_archive()`))).rejects.toThrow(/trigger functions can only be called as triggers/);
    for (const f of [
      'public.billing_account_payments_archive()',
      'public.billing_account_ledger_archive()',
      'public.billing_archive_immutable()',
      'public.billing_admin_revenue_days(timestamptz, timestamptz, text)',
      'public.billing_admin_ledger_days(timestamptz, timestamptz, text)',
    ]) {
      const r = await one(
        `SELECT has_function_privilege('anon', $1, 'execute') AS anon,
                has_function_privilege('authenticated', $1, 'execute') AS auth,
                (SELECT proconfig FROM pg_proc WHERE oid = $1::regprocedure) AS cfg`, [f]);
      expect(r.anon, f).toBe(false);
      expect(r.auth, f).toBe(false);
      expect(String(r.cfg), f).toMatch(/search_path=/);
    }
  });

  it('A6 running 269 again changes nothing', async () => {
    const snapshot = async () => ({
      functions: await q(
        `SELECT p.oid::regprocedure::text AS f, md5(pg_get_functiondef(p.oid)) AS h, p.proacl::text AS acl FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace
            AND (p.proname LIKE 'billing_%' OR p.proname LIKE 'admin_purge%')
          ORDER BY 1`),
      triggers: await q(`SELECT tgrelid::regclass::text AS t, tgname, md5(pg_get_triggerdef(oid)) AS h FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`),
      tables: await q(
        `SELECT c.relname, c.relacl::text AS acl, c.relrowsecurity AS rls,
                (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
           FROM pg_class c WHERE c.oid IN ('public.billing_revenue_archive'::regclass, 'public.billing_ledger_archive'::regclass)
          ORDER BY 1`),
      payments: await q(`SELECT * FROM public.billing_revenue_archive ORDER BY payment_id`),
      ledger: await q(`SELECT * FROM public.billing_ledger_archive ORDER BY ledger_id`),
      reports: await reports(),
    });
    const before = await snapshot();
    await applyMigrationSql(db, SQL_269);
    expect(await snapshot()).toEqual(before);
  });

  it('A7 a restored payment refunded and deleted again keeps the new refund in the report', async () => {
    const ws = await makeWorkspace('Twice Ltd');
    const pay = await paid(ws, { provider: 'rv_twice', currency: 'USD', net: 2000, completedAt: '2026-02-04T08:00:00Z' });
    const row = await one(`SELECT * FROM public.billing_account_payments WHERE id = $1`, [pay]);
    await asService(() => q(`SELECT public.admin_purge_workspaces(ARRAY[$1]::uuid[])`, [ws]));
    expect((await archivedPayments(ws))[0]).toMatchObject({ refunded: 0, refunds: {} });
    // Restored by hand (as A4), then the provider reports a refund on it.
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Twice Ltd', $2, $3)`, [ws, `ws-t-${ws.slice(0, 8)}`, await makeUser()]);
    await q(
      `INSERT INTO public.billing_account_payments
         (id, workspace_id, provider, currency, amount_minor, net_minor, tax_minor, status, completed_at, purpose, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [pay, ws, row.provider, row.currency, row.amount_minor, row.net_minor, row.tax_minor, row.status, row.completed_at, row.purpose, row.source,
       row.created_at, row.updated_at]);
    await q(`SELECT public.billing_account_ensure($1, 'USD')`, [ws]);
    await q(`UPDATE public.billing_accounts SET balance_minor = 2000 WHERE workspace_id = $1`, [ws]);
    await refund(pay, 're_twice_1', 500, '2026-03-10T09:00:00Z');
    const withRefund = await reports();
    expect(withRefund.revenue).toEqual(expect.arrayContaining([
      expect.objectContaining({ day: '2026-03-10', metric: 'refund', provider: 'rv_twice', gross_minor: 500 }),
    ]));
    await asService(() => q(`SELECT public.admin_purge_workspaces(ARRAY[$1]::uuid[])`, [ws]));
    const archived = (await archivedPayments(ws))[0];
    expect(archived.refunded).toBe(500);
    expect(Object.keys(archived.refunds as object)).toEqual(['re_twice_1']);
    expect((await reports()).revenue).toEqual(withRefund.revenue);
    // Still nothing else may change: an UPDATE of any other column, or one that drops a refund, is refused.
    await expect(q(`UPDATE public.billing_revenue_archive SET amount_minor = 1 WHERE payment_id = $1`, [pay])).rejects.toThrow(/append-only/);
    await expect(q(`UPDATE public.billing_revenue_archive SET refunds = '{}' WHERE payment_id = $1`, [pay])).rejects.toThrow(/append-only/);
    await expect(q(`UPDATE public.billing_revenue_archive SET refunded_minor = 0 WHERE payment_id = $1`, [pay])).rejects.toThrow(/append-only/);
  });

  it('A8 running 269 again takes no ACCESS EXCLUSIVE lock on the source tables', async () => {
    const body = SQL_269.replace(/COMMIT;\s*$/, '');
    expect(body).not.toBe(SQL_269);
    await q(body);
    try {
      const locks = await q(
        `SELECT c.relname, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
          WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation'
            AND c.relname IN ('billing_account_payments', 'billing_account_ledger')
          ORDER BY 1, 2`);
      expect(locks.filter((l) => l.mode === 'AccessExclusiveLock')).toEqual([]);
      expect(locks.map((l) => `${l.relname}:${l.mode}`)).toContain('billing_account_payments:ShareRowExclusiveLock');
    } finally {
      await q('ROLLBACK');
    }
  });
});
