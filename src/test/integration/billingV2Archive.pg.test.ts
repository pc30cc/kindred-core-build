// @vitest-environment node
/**
 * 268 — billing v2 archived (docs/billing/SIMPLE_BILLING.md, phase 7, PR 7B),
 * against real PostgreSQL built by the whole migration chain up to 267, with
 * v2 rows written after 267 the way the code from before 7A still could.
 *
 *   A1  blocking: an open needs_review item stops 268 (billing_v2_unmigrated,
 *       naming it); nothing changes — the v2 tables stay in public, the move's
 *       credit made on the way is rolled back;
 *   A2  after a waive, a dry run (inside BEGIN … ROLLBACK) leaves the database
 *       as it was and reaches exactly the state the real run then reaches; a
 *       third run changes nothing;
 *   A3  the move ran once more first: a v2 wallet written after 267 is
 *       credited, a past_due subscription normalised;
 *   A4  the 28 tables are in billing_v2_archive with every row; no policy,
 *       trigger or foreign key to public is left on them; the 9 columns, the
 *       v2 functions and billing_account_v2_next_period are gone; the
 *       survivors no longer ask about v2;
 *   A5  only the owner and the backup role read the archive: service_role is
 *       refused; webyar_backup is given the schema unless it already reads
 *       everything through pg_read_all_data;
 *   A6  purge and delete: admin_purge_workspaces and admin_delete_user succeed
 *       for workspaces with archived rows, which stay; a plan only archived
 *       rows name can be deleted;
 *   A7  data: ai_allowance.IRR backfilled from limits (and nothing else), the
 *       archived tables' retention policies gone, the five legacy email
 *       templates archived with every column;
 *   A8  simple billing end to end after 268 (Iran, IRR): buy, renew (prepaid),
 *       process_due, upgrade, schedule a change, the reminders, the
 *       subscription writer; and a saved card's renewal (Multi Region, USD);
 *   A9  the post-checks: a function still naming an archived table or a
 *       removed function (in any letter case), a view on a dropped column, a
 *       missing 267 and a log row without its ledger row each stop 268 with
 *       nothing changed;
 *   A10 Super Admin's JSON backup, SQL dump and one-click migration carry
 *       the archive's rows (server/services/database/);
 *   A11 a request that holds workspaces and then reads
 *       workspace_subscriptions while 268 runs: no deadlock, both finish.
 *
 * Its own databases (CREATE DATABASE on the TEST_DATABASE_URL server). It
 * creates the cluster role webyar_backup when the server has none, and drops
 * it again. Skipped without TEST_DATABASE_URL; REQUIRE_BILLING_DB=1 makes that
 * a failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { applyMigrationSql } from './pgMigrationChain';
import { listBackupTables } from '../../../server/services/database/archiveExport';
import { generateSqlDump } from '../../../server/services/database/sqlDump';
import { runSelfhostMigration } from '../../../server/services/database/selfhostMigration';

const DSN = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_BILLING_DB === '1' && !DSN) {
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the billing v2 archive SQL tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const STAMP = Date.now();
const BASE = `v2archive_base_${STAMP}`;
const MAIN = `v2archive_main_${STAMP}`;
const CHECKS = `v2archive_checks_${STAMP}`;
const TARGET = `v2archive_target_${STAMP}`;
const LOCKS = `v2archive_locks_${STAMP}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '268_billing_v2_archive.sql';
const SQL_268 = readFileSync(resolve(DIR, FILE), 'utf8');
/** 268 without its own BEGIN/COMMIT, to run inside a test's transaction. */
const BODY_268 = SQL_268.replace(/^BEGIN;[ \t]*$/m, '').replace(/^COMMIT;[ \t]*$/m, '');

const V2_TABLES = [
  'billing_payments', 'billing_payment_intents', 'billing_subscription_applications', 'billing_invoices',
  'billing_invoice_lines', 'billing_subscription_periods', 'billing_invoice_applications', 'billing_invoice_collections',
  'billing_wallet_accounts', 'billing_wallet_ledger', 'billing_wallet_deposits', 'billing_payment_allocations',
  'billing_v2_audit', 'billing_v2_rollout', 'billing_v2_policy', 'billing_v2_workspace_policy', 'billing_v2_jobs',
  'billing_v2_worker_health', 'billing_period_allowance_grants', 'billing_entitlement_cycles',
  'billing_notification_jobs', 'billing_retention_signals', 'billing_currencies', 'billing_exchange_rates',
  'billing_tax_rates', 'billing_coupons', 'billing_coupon_redemptions', 'billing_usage_items',
] as const;
const V2_COLUMNS = [
  'current_period_id', 'v2_allowance_effective_period_id', 'billing_engine_version', 'billing_v2_effective_at',
  'billing_anchor_at', 'next_invoice_at', 'next_plan_id', 'pending_change_type', 'pending_change_currency',
] as const;
const LEGACY_TEMPLATES = ['subscription_activated', 'wallet_deposit_received', 'ai_credit_purchased', 'trial_ending_soon', 'trial_expired'];
const BACKUP_ROLE = 'webyar_backup';

type Row = Record<string, unknown>;

let admin: pg.Client;
let createdBackupRole = false;

function urlFor(db: string): string {
  const url = new URL(DSN!);
  url.pathname = `/${db}`;
  return url.toString();
}

async function connect(db: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urlFor(db) });
  await c.connect();
  await c.query('SET client_min_messages = notice');
  return c;
}

function helpers(c: pg.Client) {
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await c.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];
  const num = async (sql: string, params: unknown[] = []): Promise<number> => Number((await one(sql, params)).n);
  const fn = async (sql: string, params: unknown[] = []): Promise<Row> => (await one(sql, params)).r as Row;
  const planId = async (slug: string) => String((await one(`SELECT id FROM public.billing_plans WHERE slug = $1`, [slug])).id);

  async function user(isAdmin = false): Promise<string> {
    const id = randomUUID();
    await c.query(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [id, `u-${id.slice(0, 8)}@test.local`]);
    if (isAdmin) await c.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [id]);
    return id;
  }
  async function workspace(owner?: string): Promise<string> {
    const id = randomUUID();
    await c.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Archive Co', $2, $3)`,
      [id, `v2a-${id.slice(0, 8)}`, owner ?? (await user())]);
    return id;
  }

  /** Where a table is now: 'public', 'billing_v2_archive' or null. */
  const schemaOf = async (table: string): Promise<string | null> =>
    ((await one(`SELECT n.nspname AS s FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE c.relname = $1 AND c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'billing_v2_archive')`, [table]))?.s as string) ?? null;
  /** Rows of every v2 table, wherever it is. */
  async function v2Counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of V2_TABLES) {
      const s = await schemaOf(t);
      out[t] = s ? await num(`SELECT count(*) AS n FROM ${s}.${t}`) : -1;
    }
    return out;
  }
  /** What 268 changes, without ids or times: compared between the dry run and the real one. */
  async function snapshot(): Promise<Row> {
    return one(`
      SELECT
        (SELECT jsonb_object_agg(c.relname, n.nspname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r' AND n.nspname IN ('public', 'billing_v2_archive')
            AND c.relname = ANY ($1::text[] || ARRAY['email_templates', 'migration_log'])) AS tables,
        (SELECT array_agg(attname ORDER BY attname) FROM pg_attribute
          WHERE attrelid = 'public.workspace_subscriptions'::regclass AND attnum > 0 AND NOT attisdropped) AS sub_columns,
        (SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'billing%') AS billing_functions,
        (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
          WHERE c.relnamespace = 'billing_v2_archive'::regnamespace) AS archive_policies,
        (SELECT array_agg(kind || ':' || amount_minor || ':' || idempotency_key ORDER BY idempotency_key)
           FROM public.billing_account_ledger) AS ledger,
        (SELECT array_agg(source_table || ':' || source_id || ':' || action ORDER BY source_table, source_id)
           FROM billing_v2_archive.migration_log) AS log,
        (SELECT jsonb_object_agg(slug, ai_allowance) FROM public.billing_plans) AS allowances,
        (SELECT count(*) FROM public.email_templates WHERE slug = ANY ($2::text[])) AS public_templates,
        (SELECT array_agg(table_name ORDER BY table_name) FROM public.data_retention_policies) AS retention,
        (SELECT array_agg(workspace_id || ':' || status ORDER BY workspace_id) FROM public.workspace_subscriptions) AS subs`,
      [V2_TABLES, LEGACY_TEMPLATES]);
  }

  return { q, one, num, fn, planId, user, workspace, schemaOf, v2Counts, snapshot };
}

/**
 * The service client the exports use, over a plain connection: each rpc() is
 * the SQL function called as the table owner (the migrations' role), which is
 * what the SECURITY DEFINER functions run as anyway.
 */
function fakeSupabase(c: pg.Client): SupabaseClient {
  return {
    rpc(name: string, args: Record<string, unknown>) {
      const keys = Object.keys(args);
      const call = `public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
      const setof = name === 'admin_list_export_tables';
      return c.query(setof ? `SELECT * FROM ${call}` : `SELECT ${call} AS r`, keys.map((k) => args[k])).then(
        (res) => ({ data: setof ? res.rows : res.rows[0].r, error: null }),
        (e: { message: string; code?: string }) => ({ data: null, error: { message: e.message, code: e.code } }),
      );
    },
  } as unknown as SupabaseClient;
}

/** Runs the file as the chain does (its own BEGIN/COMMIT); returns its NOTICEs. */
async function apply268(c: pg.Client, sql = SQL_268): Promise<string[]> {
  const notices: string[] = [];
  const onNotice = (m: { message?: string }) => { if (m.message) notices.push(m.message); };
  c.on('notice', onNotice);
  try {
    await applyMigrationSql(c, sql);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.removeListener('notice', onNotice);
  }
  return notices;
}

/** 268's body inside the test's own transaction, rolled back; returns what `inside` saw. */
async function dryRun<T>(c: pg.Client, inside: () => Promise<T>, before: () => Promise<unknown> = async () => undefined): Promise<T> {
  await c.query('BEGIN');
  try {
    await before();
    await applyMigrationSql(c, BODY_268);
    return await inside();
  } finally {
    await c.query('ROLLBACK');
  }
}

/** 268's body in a transaction that is rolled back; resolves to the error it raised. */
async function failure(c: pg.Client, before: () => Promise<unknown>): Promise<Error> {
  await c.query('BEGIN');
  try {
    await before();
    await applyMigrationSql(c, BODY_268);
  } catch (e) {
    return e as Error;
  } finally {
    await c.query('ROLLBACK');
  }
  throw new Error('268 applied, but it should have raised');
}

suite('268 — billing v2 archived (real PostgreSQL)', () => {
  beforeAll(async () => {
    const adminUrl = new URL(DSN!);
    adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    for (const db of [BASE, MAIN, CHECKS, TARGET, LOCKS]) await admin.query(`DROP DATABASE IF EXISTS ${db}`);
    if (!(await admin.query(`SELECT to_regrole($1) IS NOT NULL AS e`, [BACKUP_ROLE])).rows[0].e) {
      await admin.query(`CREATE ROLE ${BACKUP_ROLE} NOLOGIN BYPASSRLS`);
      createdBackupRole = true;
    }
    await admin.query(`CREATE DATABASE ${BASE}`);
    const base = await connect(BASE);
    await base.query('SET client_min_messages = warning');
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files.filter((f) => f < FILE)) {
      await applyMigrationSql(base, readFileSync(resolve(DIR, file), 'utf8'));
    }
    await base.query(`UPDATE public.platform_settings SET region_mode = 'iran'`);
    await base.end();
    await admin.query(`CREATE DATABASE ${MAIN} TEMPLATE ${BASE}`);
    await admin.query(`CREATE DATABASE ${CHECKS} TEMPLATE ${BASE}`);
  }, 900_000);

  afterAll(async () => {
    if (admin) {
      for (const db of [MAIN, CHECKS, TARGET, LOCKS, BASE]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      if (createdBackupRole) await admin.query(`DROP ROLE IF EXISTS ${BACKUP_ROLE}`);
      await admin.end();
    }
  });

  // ───────────────────────────── The archive ─────────────────────────────
  describe('on a database with billing v2 rows (Iran)', () => {
    let c: pg.Client;
    let h: ReturnType<typeof helpers>;
    let pro = '';
    let legacyPlan = '';
    let adminUser = '';
    const f = {
      wWallet: '', wallet: '',
      wReview: '', intent: '',
      wPastDue: '', pastDueOwner: '',
      wV2: '', period: '', invoice: '',
    };
    let countsBefore: Record<string, number> = {};
    let templatesBefore: Row[] = [];
    let dry: Row;
    let notices: string[] = [];

    beforeAll(async () => {
      c = await connect(MAIN);
      h = helpers(c);
      pro = await h.planId('pro');
      adminUser = await h.user(true);
      // A plan that only billing v2's rows name.
      legacyPlan = String((await h.one(
        `INSERT INTO public.billing_plans (name, slug, prices, limits, is_active, is_free, is_hidden, sort_order)
         VALUES ('Legacy v2', 'legacy-v2', '{}', '{}', false, false, true, 99) RETURNING id`)).id);
      // D14: a plan with the limits key and no ai_allowance.IRR, one with both, one with a value that is no amount.
      await h.q(`UPDATE public.billing_plans SET ai_allowance = '{}', limits = limits || '{"included_ai_allowance_irr": 2000000}' WHERE slug = 'pro'`);
      await h.q(`UPDATE public.billing_plans SET ai_allowance = '{"IRR": 7}', limits = limits || '{"included_ai_allowance_irr": 9000000}' WHERE slug = 'enterprise'`);
      await h.q(`UPDATE public.billing_plans SET ai_allowance = '{"USD": 3}', limits = limits || '{"included_ai_allowance_irr": "lots"}' WHERE slug = 'trial'`);

      // Written after 267 by code that still knew billing v2:
      // a wallet deposit (the move credits it when 268 runs it again),
      f.wWallet = await h.workspace();
      await h.q(`SELECT public.billing_wallet_append($1, 'deposit', 3000000, $2)`, [f.wWallet, `test:${randomUUID()}`]);
      f.wallet = String((await h.one(`SELECT id FROM public.billing_wallet_accounts WHERE workspace_id = $1`, [f.wWallet])).id);
      // a processing payment intent whose money v2 never recorded (needs_review),
      f.wReview = await h.workspace();
      f.intent = String((await h.one(
        `INSERT INTO public.billing_payment_intents
           (workspace_id, purchase_type, provider_name, amount_irr, status, billing_engine_version)
         VALUES ($1, 'wallet_deposit', 'zarinpal', 4000000, 'processing', 'v2') RETURNING id`, [f.wReview])).id);
      // a past_due subscription whose period ended (normalised to expired), with a void v2 invoice,
      f.pastDueOwner = await h.user();
      f.wPastDue = await h.workspace(f.pastDueOwner);
      await h.q(
        `INSERT INTO public.workspace_subscriptions
           (workspace_id, plan_id, status, billing_interval, current_period_start, current_period_end, billing_engine_version, past_due_since)
         VALUES ($1, $2, 'past_due', 'monthly', now() - interval '40 days', now() - interval '10 days', 'v2', now() - interval '10 days')`,
        [f.wPastDue, pro]);
      await h.q(
        `INSERT INTO public.billing_invoices (workspace_id, invoice_number, invoice_type, status, currency, subtotal_irr, total_irr, amount_due_irr)
         VALUES ($1, $2, 'subscription_renewal', 'void', 'IRR', 15000000, 15000000, 15000000)`, [f.wPastDue, `VOID${STAMP % 100000}`]);
      // and an active v2 subscription: its paid invoice, line, payment and period (on the legacy plan), its audit row.
      f.wV2 = await h.workspace();
      await h.q(
        `INSERT INTO public.workspace_subscriptions
           (workspace_id, plan_id, status, billing_interval, current_period_start, current_period_end, billing_engine_version,
            billing_anchor_at, next_invoice_at, pending_change_type, next_plan_id, pending_change_currency, billing_v2_effective_at)
         VALUES ($1, $2, 'active', 'monthly', now() - interval '5 days', now() + interval '25 days', 'v2',
                 now() - interval '5 days', now() + interval '20 days', 'upgrade', $3, 'IRR', now() - interval '5 days')`,
        [f.wV2, pro, legacyPlan]);
      // (lines go on a draft; an issued invoice's lines are frozen)
      f.invoice = String((await h.one(
        `INSERT INTO public.billing_invoices
           (workspace_id, invoice_number, invoice_type, status, currency, subtotal_irr, total_irr, amount_due_irr, plan_id)
         VALUES ($1, $2, 'new_subscription', 'draft', 'IRR', 15000000, 15000000, 15000000, $3) RETURNING id`,
        [f.wV2, `PAID${STAMP % 100000}`, legacyPlan])).id);
      await h.q(
        `INSERT INTO public.billing_invoice_lines (invoice_id, line_type, description, quantity, unit_amount_irr, amount_irr, plan_id)
         VALUES ($1, 'plan', 'Legacy v2', 1, 15000000, 15000000, $2)`, [f.invoice, legacyPlan]);
      await h.q(`UPDATE public.billing_invoices SET status = 'paid', amount_paid_irr = 15000000, amount_due_irr = 0, paid_at = now() WHERE id = $1`,
        [f.invoice]);
      await h.q(
        `INSERT INTO public.billing_payments (workspace_id, amount, currency, status, provider_name, invoice_id, reconciliation_state, paid_at)
         VALUES ($1, 15000000, 'IRR', 'succeeded', 'zarinpal', $2, 'settled', now())`, [f.wV2, f.invoice]);
      f.period = String((await h.one(
        `INSERT INTO public.billing_subscription_periods
           (workspace_id, subscription_id, plan_id, invoice_id, billing_interval, period_start, period_end, status, source)
         VALUES ($1, (SELECT id FROM public.workspace_subscriptions WHERE workspace_id = $1), $2, $3, 'monthly',
                 now() - interval '5 days', now() + interval '25 days', 'active', 'invoice') RETURNING id`,
        [f.wV2, legacyPlan, f.invoice])).id);
      await h.q(`UPDATE public.workspace_subscriptions SET current_period_id = $2, v2_allowance_effective_period_id = $2 WHERE workspace_id = $1`,
        [f.wV2, f.period]);
      await h.q(`INSERT INTO public.billing_v2_audit (workspace_id, event, details) VALUES ($1, 'test', '{}')`, [f.wV2]);

      countsBefore = await h.v2Counts();
      templatesBefore = await h.q(`SELECT * FROM public.email_templates WHERE slug = ANY ($1) ORDER BY id`, [LEGACY_TEMPLATES]);
    }, 120_000);

    afterAll(async () => {
      await c?.end();
    });

    it('fixtures: the v2 rows are where the code before 7A wrote them, and the legacy plan cannot be deleted yet', async () => {
      for (const t of V2_TABLES) expect(await h.schemaOf(t), t).toBe('public');
      expect(countsBefore).toMatchObject({ billing_invoices: 2, billing_invoice_lines: 1, billing_payments: 1, billing_subscription_periods: 1 });
      expect(countsBefore.billing_wallet_ledger).toBeGreaterThanOrEqual(1);
      expect(countsBefore.billing_v2_audit).toBeGreaterThanOrEqual(1);
      expect(templatesBefore.length).toBeGreaterThanOrEqual(LEGACY_TEMPLATES.length);
      await c.query('BEGIN');
      await expect(c.query(`DELETE FROM public.billing_plans WHERE id = $1`, [legacyPlan])).rejects.toThrow(/foreign key/);
      await c.query('ROLLBACK');
    });

    it('A1 an open needs_review item stops 268, and nothing changes', async () => {
      const before = await h.snapshot();
      await expect(apply268(c)).rejects.toThrow(
        new RegExp(`billing_v2_unmigrated: 1 item\\(s\\): billing_payment_intents ${f.intent} \\(workspace ${f.wReview}, intent_processing`),
      );
      for (const t of V2_TABLES) expect(await h.schemaOf(t), t).toBe('public');
      // The move's credit for the wallet, made on the way, went with the rollback.
      expect(await h.num(`SELECT count(*) AS n FROM public.billing_account_ledger WHERE workspace_id = $1`, [f.wWallet])).toBe(0);
      expect(await h.snapshot()).toEqual(before);
      expect(await h.v2Counts()).toEqual(countsBefore);
    });

    it('A2 after a waive, the dry run changes nothing and reaches what the real run reaches', async () => {
      await h.q(`SELECT public.billing_v2_migration_waive('billing_payment_intents', $1, 'checked at the gateway: never paid')`, [f.intent]);
      const before = await h.snapshot();
      dry = await dryRun(c, () => h.snapshot());
      expect(await h.snapshot()).toEqual(before);
      for (const t of V2_TABLES) expect(await h.schemaOf(t), t).toBe('public');

      notices = await apply268(c);
      expect(await h.snapshot()).toEqual(dry);
      expect(notices.some((n) => n.startsWith('billing v2 archive: 28 table(s) moved'))).toBe(true);
      expect(notices.some((n) => n.startsWith('billing v2 move before the archive:'))).toBe(true);
    });

    it('A2 a second run changes nothing', async () => {
      const again = await apply268(c);
      expect(await h.snapshot()).toEqual(dry);
      expect(again.some((n) => n.startsWith('billing v2 archive:'))).toBe(false);
      expect(again.some((n) => n.startsWith('billing v2 move'))).toBe(false);
    });

    it('A3 the move ran once more first: the wallet written after 267 is credited, the past_due subscription expired', async () => {
      const ledger = await h.q(`SELECT kind, amount_minor::bigint::float8 AS amount, currency, idempotency_key FROM public.billing_account_ledger WHERE workspace_id = $1`, [f.wWallet]);
      expect(ledger).toEqual([
        { kind: 'admin_credit', amount: 3_000_000, currency: 'IRR', idempotency_key: `admin:v2:billing_wallet_accounts:${f.wallet}` },
      ]);
      expect((await h.one(`SELECT status FROM public.workspace_subscriptions WHERE workspace_id = $1`, [f.wPastDue])).status).toBe('expired');
      const log = await h.q(`SELECT source_table, action FROM billing_v2_archive.migration_log ORDER BY source_table, action`);
      expect(log).toEqual(expect.arrayContaining([
        { source_table: 'billing_payment_intents', action: 'waived' },
        { source_table: 'billing_wallet_accounts', action: 'credit' },
        { source_table: 'workspace_subscriptions', action: 'normalize' },
      ]));
    });

    it('A4 the 28 tables are archived with every row, and nothing ties them to public', async () => {
      for (const t of V2_TABLES) expect(await h.schemaOf(t), t).toBe('billing_v2_archive');
      expect(await h.v2Counts()).toEqual(countsBefore);
      const ties = await h.one(`
        SELECT (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
                 WHERE c.relnamespace = 'billing_v2_archive'::regnamespace) AS policies,
               (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                 WHERE c.relnamespace = 'billing_v2_archive'::regnamespace AND NOT t.tgisinternal) AS triggers,
               (SELECT count(*) FROM pg_constraint k JOIN pg_class a ON a.oid = k.conrelid JOIN pg_class b ON b.oid = k.confrelid
                 WHERE k.contype = 'f' AND (a.relnamespace = 'billing_v2_archive'::regnamespace)
                                        <> (b.relnamespace = 'billing_v2_archive'::regnamespace)) AS edge_fks,
               (SELECT count(*) FROM pg_constraint k JOIN pg_class a ON a.oid = k.conrelid
                 WHERE k.contype = 'f' AND a.relnamespace = 'billing_v2_archive'::regnamespace) AS inner_fks,
               (SELECT bool_and(c.relrowsecurity) FROM pg_class c
                 WHERE c.relnamespace = 'billing_v2_archive'::regnamespace AND c.relkind = 'r') AS rls`);
      expect(ties).toMatchObject({ policies: '0', triggers: '0', edge_fks: '0', rls: true });
      expect(Number(ties.inner_fks)).toBeGreaterThan(0); // the ones between v2 tables moved with them
      // The period still points at its invoice: the archive is whole.
      expect((await h.one(`SELECT invoice_id FROM billing_v2_archive.billing_subscription_periods WHERE id = $1`, [f.period])).invoice_id).toBe(f.invoice);
    });

    it('A4 the v2 columns, functions and the v2 next period are gone; the survivors no longer ask about v2', async () => {
      const cols = (await h.q(`SELECT attname FROM pg_attribute WHERE attrelid = 'public.workspace_subscriptions'::regclass
                                 AND attnum > 0 AND NOT attisdropped`)).map((r) => r.attname);
      for (const col of V2_COLUMNS) expect(cols, col).not.toContain(col);
      for (const kept of ['billing_interval', 'trial_start', 'free_fallback_at', 'past_due_since', 'grace_period_ends_at', 'canceled_at']) {
        expect(cols, kept).toContain(kept);
      }
      expect(await h.num(`SELECT count(*) AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                           AND (proname LIKE 'billing\\_v2\\_%' OR proname IN ('billing_account_v2_next_period', 'billing_wallet_append',
                                'billing_activate_period', 'billing_settle_invoice', 'billing_enroll_workspace', 'admin_reset_billing_data',
                                'billing_notify_trial_ending', 'billing_legacy_allowance_active'))`)).toBe(0);
      for (const kept of ['billing_touch_updated_at', 'billing_purge_active', 'expire_stale_trials', 'billing_account_grant_month']) {
        expect(await h.num(`SELECT count(*) AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = $1`, [kept]), kept).toBeGreaterThan(0);
      }
      for (const name of ['billing_account_renew', 'billing_account_process_due', 'billing_card_apply_renewal',
        'billing_account_reminder_candidates', 'billing_account_write_subscription']) {
        const src = String((await h.one(`SELECT string_agg(prosrc, '') AS s FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = $1`, [name])).s);
        expect(src, name).not.toMatch(/billing_account_v2_next_period|v2_period_needs_review|current_period_id|next_plan_id|pending_change|next_invoice_at/);
        // Their grants stayed (CREATE OR REPLACE).
        const sig = String((await h.one(`SELECT oid::regprocedure::text AS s FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = $1`, [name])).s);
        expect(await h.one(`SELECT has_function_privilege('service_role', $1, 'execute') AS svc,
                                   has_function_privilege('authenticated', $1, 'execute') AS auth`, [sig]), name)
          .toEqual({ svc: true, auth: false });
      }
      expect((await h.one(`SELECT public.admin_reset_settings_tables() AS t`)).t).toEqual(
        expect.arrayContaining(['billing_gateways', 'billing_provider_credentials', 'billing_plans']));
      expect((await h.one(`SELECT public.admin_reset_settings_tables() AS t`)).t).not.toContain('billing_currencies');
      // The gateways' own trigger still works.
      expect(await h.num(`SELECT count(*) AS n FROM pg_trigger WHERE tgname = 'trg_billing_gateways_touch'`)).toBe(1);
    });

    it('A5 service_role is refused; the backup role reads the archive', async () => {
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE service_role');
        await expect(c.query('SELECT count(*) FROM billing_v2_archive.billing_invoices')).rejects.toThrow(/permission denied/);
      } finally {
        await c.query('ROLLBACK');
      }
      const member = (await h.one(`SELECT pg_has_role($1, 'pg_read_all_data', 'USAGE') AS m`, [BACKUP_ROLE])).m;
      const reads = await h.one(
        `SELECT has_schema_privilege($1, 'billing_v2_archive', 'USAGE') AS usage,
                bool_and(has_table_privilege($1, c.oid, 'SELECT')) AS sel,
                bool_or(has_table_privilege($1, c.oid, 'INSERT, UPDATE, DELETE')) AS writes
           FROM pg_class c WHERE c.relnamespace = 'billing_v2_archive'::regnamespace AND c.relkind = 'r'`, [BACKUP_ROLE]);
      expect(reads).toMatchObject({ usage: true, sel: true, writes: false });
      await c.query('BEGIN');
      try {
        await c.query(`SET LOCAL ROLE ${BACKUP_ROLE}`);
        expect(Number((await c.query('SELECT count(*) AS n FROM billing_v2_archive.billing_invoices')).rows[0].n)).toBe(2);
        expect(Number((await c.query('SELECT count(*) AS n FROM billing_v2_archive.migration_log')).rows[0].n)).toBeGreaterThanOrEqual(3);
      } finally {
        await c.query('ROLLBACK');
      }
      if (!member) {
        // Given explicitly, as 268 does for a backup role without pg_read_all_data.
        expect(await h.num(`SELECT count(*) AS n FROM pg_class c, aclexplode(c.relacl) a
                             WHERE c.relnamespace = 'billing_v2_archive'::regnamespace AND c.relkind = 'r'
                               AND a.grantee = to_regrole($1) AND a.privilege_type = 'SELECT'`, [BACKUP_ROLE])).toBe(30);
      }
    });

    it('A10 Super Admin\'s JSON backup, SQL dump and one-click migration carry the archive', async () => {
      const sb = fakeSupabase(c);
      // The JSON backup's tables: public's, then the archive's.
      const tables = await listBackupTables(sb, adminUser);
      expect(tables).toContain('workspaces');
      for (const t of [...V2_TABLES, 'migration_log', 'email_templates']) expect(tables).toContain(`billing_v2_archive.${t}`);
      const exported = await sb.rpc('admin_export_table', {
        _actor_user_id: adminUser, _table: 'billing_v2_archive.billing_invoices', _limit: 1000, _offset: 0,
      });
      expect(((exported.data as Row[]) ?? []).map((r) => r.id)).toContain(f.invoice);
      expect((await sb.rpc('admin_export_archive_tables', { _actor_user_id: await h.user() })).error?.message).toMatch(/forbidden/);
      expect((await sb.rpc('admin_export_table', {
        _actor_user_id: adminUser, _table: 'billing_v2_archive.no_such_table', _limit: 10, _offset: 0,
      })).error?.message).toMatch(/unknown table/);

      // The SQL dump.
      let dump = '';
      for await (const chunk of generateSqlDump(sb, adminUser, { includeSchema: false, includeData: true })) dump += chunk;
      expect(dump).toMatch(new RegExp(`INSERT INTO "billing_v2_archive"\\."billing_invoices" \\([^)]*\\) VALUES\\n[^;]*'${f.invoice}'`));
      expect(dump).toContain('INSERT INTO "billing_v2_archive"."billing_payments"');
      expect(dump).toContain('INSERT INTO "billing_v2_archive"."migration_log"');

      // The one-click migration, into a database whose migrations built the archive.
      await admin.query(`CREATE DATABASE ${TARGET} TEMPLATE ${BASE}`);
      const t = await connect(TARGET);
      try {
        await t.query('SET client_min_messages = warning');
        await applyMigrationSql(t, SQL_268);
        const url = new URL(urlFor(TARGET));
        url.searchParams.set('sslmode', 'disable');
        const events: Record<string, unknown>[] = [];
        await runSelfhostMigration(sb, adminUser, { connectionString: url.toString(), includeSchema: false, truncateTarget: false },
          (e) => events.push(e));
        expect(events.at(-1)).toMatchObject({ type: 'done' });
        expect(events).toContainEqual(expect.objectContaining({ type: 'tableDone', table: 'billing_v2_archive.billing_invoices', rows: 2 }));
        for (const table of ['billing_invoices', 'billing_invoice_lines', 'billing_payments', 'billing_subscription_periods', 'migration_log']) {
          const ids = async (x: pg.Client) => (await x.query(`SELECT id::text FROM billing_v2_archive.${table} ORDER BY 1`)).rows.map((r) => r.id);
          expect(await ids(t), table).toEqual(await ids(c));
        }
      } finally {
        await t.end();
      }
    }, 300_000);

    it('A6 a purge and a user delete succeed for workspaces with archived rows, which stay; a plan only the archive names can go', async () => {
      const archivedOf = async (ws: string) => {
        let n = 0;
        for (const t of ['billing_invoices', 'billing_invoice_lines', 'billing_payments', 'billing_subscription_periods', 'billing_v2_audit']) {
          n += t === 'billing_invoice_lines'
            ? await h.num(`SELECT count(*) AS n FROM billing_v2_archive.billing_invoice_lines l
                             JOIN billing_v2_archive.billing_invoices i ON i.id = l.invoice_id WHERE i.workspace_id = $1`, [ws])
            : await h.num(`SELECT count(*) AS n FROM billing_v2_archive.${t} WHERE workspace_id = $1`, [ws]);
        }
        return n;
      };
      const v2Rows = await archivedOf(f.wV2);
      expect(v2Rows).toBe(5);
      expect(Number((await h.one(`SELECT public.admin_purge_workspaces(ARRAY[$1]::uuid[]) AS n`, [f.wV2])).n)).toBeGreaterThan(0);
      expect(await h.num(`SELECT count(*) AS n FROM public.workspaces WHERE id = $1`, [f.wV2])).toBe(0);
      expect(await archivedOf(f.wV2)).toBe(v2Rows);

      const pastDueRows = await archivedOf(f.wPastDue);
      expect(pastDueRows).toBe(1);
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE service_role');
        const r = (await c.query(`SELECT public.admin_delete_user($1, $2) AS r`, [adminUser, f.pastDueOwner])).rows[0].r as Row;
        expect(r).toMatchObject({ deleted_user_id: f.pastDueOwner, workspaces_deleted: 1 });
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
      expect(await h.num(`SELECT count(*) AS n FROM public.workspaces WHERE id = $1`, [f.wPastDue])).toBe(0);
      expect(await archivedOf(f.wPastDue)).toBe(pastDueRows);

      await h.q(`DELETE FROM public.billing_plans WHERE id = $1`, [legacyPlan]);
      expect(await h.num(`SELECT count(*) AS n FROM billing_v2_archive.billing_invoices WHERE plan_id = $1`, [legacyPlan])).toBe(1);
    });

    it('A7 the AI allowance backfill, the retention policies and the legacy email templates', async () => {
      const plans = Object.fromEntries((await h.q(`SELECT slug, ai_allowance FROM public.billing_plans`)).map((r) => [r.slug, r.ai_allowance]));
      expect(plans.pro).toEqual({ IRR: 2_000_000 });
      expect(plans.enterprise).toEqual({ IRR: 7 }); // already had one: kept
      expect(plans.trial).toEqual({ USD: 3 }); // not an amount: untouched
      expect(plans.free).toEqual({}); // no limits key
      // Same month as before: billing_plan_ai_allowance read the limits key, now ai_allowance.IRR, both 2,000,000.
      expect(Number((await h.one(`SELECT public.billing_plan_ai_allowance($1, NULL) AS n`, [pro])).n)).toBe(2_000_000);

      expect(await h.num(`SELECT count(*) AS n FROM public.data_retention_policies WHERE table_name = ANY ($1)`, [V2_TABLES])).toBe(0);
      expect(await h.num(`SELECT count(*) AS n FROM public.data_retention_policies`)).toBeGreaterThan(0);

      expect(await h.num(`SELECT count(*) AS n FROM public.email_templates WHERE slug = ANY ($1)`, [LEGACY_TEMPLATES])).toBe(0);
      const archived = await h.q(`SELECT * FROM billing_v2_archive.email_templates ORDER BY id`);
      expect(archived.map(({ archived_at: _at, ...rest }) => rest)).toEqual(templatesBefore);
      expect(archived.every((r) => r.archived_at instanceof Date)).toBe(true);
      // The simple billing mails stay.
      expect(await h.num(`SELECT count(*) AS n FROM public.email_templates WHERE slug = 'billing_renewed'`)).toBeGreaterThan(0);
    });

    it('A8 simple billing end to end after 268, in IRR: buy, renew, process_due, upgrade, schedule, reminders, writer', async () => {
      const enterprise = await h.planId('enterprise');
      const ws = await h.workspace();
      const price = Number((await h.one(`SELECT public.billing_plan_price($1, 'IRR', 'monthly') AS p`, [pro])).p);
      expect(price).toBeGreaterThan(0);
      await h.q(`SELECT public.billing_account_admin_adjust($1, $2, 'IRR', 'test credit', NULL, $3)`, [ws, price * 5, `e2e-${randomUUID()}`]);
      expect(await h.fn(`SELECT public.billing_account_purchase_plan($1, $2, 'monthly', $3) AS r`, [ws, pro, randomUUID()]))
        .toMatchObject({ plan_id: pro });
      expect(await h.one(`SELECT status, plan_id FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws]))
        .toEqual({ status: 'active', plan_id: pro });
      // The month's AI credit, from the backfilled ai_allowance.IRR.
      expect(await h.num(`SELECT count(*) AS n FROM public.workspace_ai_balance_lots WHERE workspace_id = $1 AND source_type = 'PLAN_ALLOWANCE'`, [ws])).toBe(1);

      // Renew ahead: the prepaid next period; a second renewal is refused.
      expect(await h.fn(`SELECT public.billing_account_renew($1) AS r`, [ws])).toMatchObject({ action: 'prepaid', amount_minor: price });
      await expect(h.q(`SELECT public.billing_account_renew($1)`, [ws])).rejects.toThrow(/billing_already_renewed/);
      // Due: renewed from the prepayment.
      await h.q(`UPDATE public.workspace_subscriptions SET current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 hour' WHERE workspace_id = $1`, [ws]);
      await h.q(`UPDATE public.billing_accounts a SET next_period_start = s.current_period_end FROM public.workspace_subscriptions s
                  WHERE a.workspace_id = $1 AND s.workspace_id = a.workspace_id`, [ws]);
      expect(await h.fn(`SELECT public.billing_account_process_due($1) AS r`, [ws])).toMatchObject({ action: 'renewed', prepaid: true, plan_id: pro });

      // Upgrade, then a change scheduled for the period end.
      expect(await h.fn(`SELECT public.billing_account_upgrade($1, $2, NULL) AS r`, [ws, enterprise])).toMatchObject({ plan_id: enterprise });
      expect((await h.one(`SELECT plan_id FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws])).plan_id).toBe(enterprise);
      await h.fn(`SELECT public.billing_account_schedule_change($1, $2, 'monthly', NULL) AS r`, [ws, pro]);
      expect((await h.one(`SELECT scheduled_plan_id FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).scheduled_plan_id).toBe(pro);

      // A reminder for a period ending soon that is not paid for.
      const soon = await h.workspace();
      await h.q(`SELECT public.billing_account_write_subscription($1, $2, 'monthly', now() - interval '27 days', now() + interval '3 days', 'active', 'admin_grant', NULL, '{}')`, [soon, pro]);
      expect((await h.q(`SELECT workspace_id FROM public.billing_account_reminder_candidates(7)`)).map((r) => r.workspace_id)).toContain(soon);

      // The writer: its row and its plan_change_log row.
      const sub = await h.one(`SELECT status, plan_id, provider_name, cancel_at_period_end FROM public.workspace_subscriptions WHERE workspace_id = $1`, [soon]);
      expect(sub).toEqual({ status: 'active', plan_id: pro, provider_name: 'account', cancel_at_period_end: false });
      expect(await h.num(`SELECT count(*) AS n FROM public.plan_change_log WHERE workspace_id = $1 AND change_type = 'admin_grant'`, [soon])).toBe(1);

      // A new workspace gets no row in the archive.
      const before = await h.v2Counts();
      await h.workspace();
      expect(await h.v2Counts()).toEqual(before);
    });

    it('A8 a saved card\'s renewal after 268 (Multi Region, USD): prepaid, then started at the due moment', async () => {
      await h.q(`UPDATE public.platform_settings SET region_mode = 'multi'`);
      await h.q(`INSERT INTO public.billing_settings (edition, vat_percent, receipt_prefix) VALUES ('international', '{"USD": 0}', 'RS')
                 ON CONFLICT (edition) DO NOTHING`);
      try {
        const usd = Number((await h.one(`SELECT public.billing_plan_price($1, 'USD', 'monthly') AS p`, [pro])).p);
        const ws = await h.workspace();
        await h.q(`SELECT public.billing_account_admin_adjust($1, $2, 'USD', 'test credit', NULL, $3)`, [ws, usd, `card-${randomUUID()}`]);
        await h.fn(`SELECT public.billing_account_purchase_plan($1, $2, 'monthly', $3) AS r`, [ws, pro, randomUUID()]);
        const setup = String((await h.one(
          `INSERT INTO public.billing_account_payments
             (workspace_id, provider, currency, amount_minor, net_minor, purpose, purpose_detail, source, provider_ref)
           VALUES ($1, 'paddle_sandbox', 'USD', $2, $2, 'plan', $3, 'card_setup', $4) RETURNING id`,
          [ws, usd, JSON.stringify({ plan_id: pro, billing_interval: 'monthly' }), `txn_setup_${randomUUID()}`])).id);
        const card = String((await h.fn(`SELECT public.billing_card_register('paddle_sandbox', $1, 'ctm_1', 'USD', $2) AS r`,
          [`sub_${randomUUID().slice(0, 13)}`, setup])).card_id);
        const t = `txn_${randomUUID().slice(0, 12)}`;
        const recorded = await h.one(`SELECT * FROM public.billing_card_record_charge($1, $2, 'subscription_recurring', $3, 'USD', $4, NULL)`,
          [card, t, usd, JSON.stringify([{ plan_id: pro, interval: 'monthly', net_minor: usd, tax_minor: 0 }])]);
        const settled = await h.fn(`SELECT public.billing_card_settle($1, $2, 'USD', $3) AS r`, [recorded.id, usd, t]);
        expect(settled.purpose_result).toMatchObject({ action: 'prepaid', card: true, amount_minor: usd, plan_id: pro });
        await h.q(`UPDATE public.workspace_subscriptions SET current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 hour' WHERE workspace_id = $1`, [ws]);
        await h.q(`UPDATE public.billing_accounts a SET next_period_start = s.current_period_end FROM public.workspace_subscriptions s
                    WHERE a.workspace_id = $1 AND s.workspace_id = a.workspace_id`, [ws]);
        expect(await h.fn(`SELECT public.billing_account_process_due($1) AS r`, [ws]))
          .toMatchObject({ action: 'renewed', prepaid: true, prepaid_card: true, plan_id: pro });
      } finally {
        await h.q(`UPDATE public.platform_settings SET region_mode = 'iran'`);
      }
    });
  });

  // ───────────────────────────── The post-checks ─────────────────────────────
  describe('what stops 268 (each case rolled back)', () => {
    let c: pg.Client;
    let h: ReturnType<typeof helpers>;

    beforeAll(async () => {
      c = await connect(CHECKS);
      h = helpers(c);
    });

    afterAll(async () => {
      await c?.end();
    });

    it('on a fresh chain it applies inside a transaction (the baseline for the cases below)', async () => {
      const seen = await dryRun(c, async () => ({
        archived: await h.num(`SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'billing_v2_archive'`),
        inPublic: await h.num(`SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY ($1)`, [V2_TABLES]),
      }));
      expect(seen).toEqual({ archived: 30, inPublic: 0 });
      expect(await h.schemaOf('billing_invoices')).toBe('public');
    });

    it('a function still naming an archived table or a removed function', async () => {
      const e = await failure(c, async () => {
        await c.query(`CREATE FUNCTION public.leftover_reader() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM public.billing_invoices'`);
        await c.query(`CREATE FUNCTION public.leftover_caller(p uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM public.billing_wallet_lock(p); END $$`);
      });
      expect(e.message).toMatch(/billing_v2_archive_check_failed: .*functions naming billing v2: leftover_caller\(uuid\), leftover_reader\(\)/);
      expect(await h.schemaOf('billing_invoices')).toBe('public');
    });

    it('a function naming an archived table or a dropped column in upper case', async () => {
      const e = await failure(c, async () => {
        await c.query(`CREATE FUNCTION public.zz_upper() RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RETURN (SELECT count(*) FROM PUBLIC.BILLING_INVOICES); END $$`);
        await c.query(`CREATE FUNCTION public.zz_upper_col(p uuid) RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN RETURN (SELECT NEXT_PLAN_ID FROM public.workspace_subscriptions WHERE id = p); END $$`);
      });
      expect(e.message).toMatch(/billing_v2_archive_check_failed: .*functions naming billing v2: zz_upper\(\), zz_upper_col\(uuid\)/);
      expect(await h.schemaOf('billing_invoices')).toBe('public');
    });

    it('a view on a dropped column', async () => {
      const e = await failure(c, () =>
        c.query(`CREATE VIEW public.leftover_view AS SELECT workspace_id, next_plan_id FROM public.workspace_subscriptions`));
      expect(e.message).toMatch(/cannot drop column next_plan_id .* because other objects depend on it|depends on column "next_plan_id"/);
    });

    it('a missing 267', async () => {
      expect((await failure(c, () => c.query('DROP SCHEMA billing_v2_archive CASCADE'))).message)
        .toMatch(/268 needs 267_billing_v2_retire\.sql \(billing_v2_archive\.migration_log\)/);
      expect((await failure(c, () => c.query('DROP FUNCTION public.billing_v2_migrate_to_simple(boolean)'))).message)
        .toMatch(/268 needs 267_billing_v2_retire\.sql \(billing_v2_migrate_to_simple\): 28 v2 table\(s\) still in public/);
    });

    it('a money item in the log without its ledger row', async () => {
      const e = await failure(c, async () => {
        const ws = await h.workspace();
        await c.query(
          `INSERT INTO billing_v2_archive.migration_log (source_table, source_id, workspace_id, action, amount_minor, currency, ledger_ids)
           VALUES ('billing_wallet_accounts', $1, $2, 'credit', 500, 'IRR', ARRAY[$3]::uuid[])`, [randomUUID(), ws, randomUUID()]);
      });
      expect(e.message).toMatch(/billing_v2_log_ledger_mismatch: logged money items without their ledger rows: billing_wallet_accounts/);
    });

    it('a backup role that reads everything through pg_read_all_data is given nothing more', async () => {
      const explicit = await dryRun(
        c,
        () => h.num(`SELECT count(*) AS n FROM pg_class c, aclexplode(c.relacl) a
                      WHERE c.relnamespace = 'billing_v2_archive'::regnamespace AND a.grantee = to_regrole($1)`, [BACKUP_ROLE]),
        () => c.query(`GRANT pg_read_all_data TO ${BACKUP_ROLE}`),
      );
      expect(explicit).toBe(0);
      // The membership was granted inside the rolled-back transaction.
      expect((await h.one(`SELECT pg_has_role($1, 'pg_read_all_data', 'MEMBER') AS m`, [BACKUP_ROLE])).m).toBe(false);
    });
  });

  // ───────────────────────────── Locks ─────────────────────────────
  describe('a request running while 268 applies', () => {
    it('A11 one that holds workspaces and then reads workspace_subscriptions: no deadlock, both finish', async () => {
      await admin.query(`CREATE DATABASE ${LOCKS} TEMPLATE ${BASE}`);
      const a = await connect(LOCKS);
      const b = await connect(LOCKS);
      try {
        const ha = helpers(a);
        const ws = await ha.workspace();
        const pid = Number((await b.query('SELECT pg_backend_pid() AS p')).rows[0].p);
        await a.query('BEGIN');
        await a.query(`UPDATE public.workspaces SET name = 'Busy Co' WHERE id = $1`, [ws]);
        const applying = apply268(b).then(() => null, (e: Error) => e);
        // 268 is waiting for a lock the request holds.
        let waiting = false;
        for (let i = 0; i < 200 && !waiting; i += 1) {
          const r = await admin.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid]);
          waiting = r.rows[0]?.wait_event_type === 'Lock';
          if (!waiting) await new Promise((done) => setTimeout(done, 20));
        }
        expect(waiting).toBe(true);
        const read = await a.query('SELECT count(*) FROM public.workspace_subscriptions').then(() => null, (e: Error) => e);
        await a.query(read ? 'ROLLBACK' : 'COMMIT');
        const failed = await applying;
        expect(read?.message ?? null).toBeNull();
        expect(failed?.message ?? null).toBeNull();
        expect(await ha.schemaOf('billing_invoices')).toBe('billing_v2_archive');
        expect((await ha.one(`SELECT name FROM public.workspaces WHERE id = $1`, [ws])).name).toBe('Busy Co');
      } finally {
        await a.end();
        await b.end();
      }
    }, 120_000);
  });
});
