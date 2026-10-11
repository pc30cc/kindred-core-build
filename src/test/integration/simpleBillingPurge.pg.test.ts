// @vitest-environment node
/**
 * 263 — the workspace and user purge gets through the simple billing ledger,
 * against real PostgreSQL built by the whole migration chain.
 *
 * Before 263, admin_purge_workspaces deleted billing_account_ledger directly
 * and 259's append-only trigger aborted the whole purge, so a workspace (or a
 * user owning one) whose balance ever moved could not be deleted.
 *
 *   - admin_delete_workspace and admin_purge_workspaces remove a workspace
 *     with ledger rows, payments and a saved card; a card not cancelled yet
 *     stays, marked canceling, for the job to cancel at Paddle;
 *   - one transaction purging in several calls keeps every workspace in the
 *     list;
 *   - admin_delete_user removes the user's own workspace, and a workspace the
 *     user topped up (owned by someone else) keeps its ledger and payments;
 *   - outside a purge the ledger is still append-only (DELETE and UPDATE),
 *     UPDATE is refused inside a purge too, a plain workspace delete still
 *     cascades, and a payment can still be deleted outside a purge;
 *   - access, and running 263 again.
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
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the billing purge SQL tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `simplebilling263_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '263_billing_purge_ledger.sql';

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

const PRO = { monthly: 2900, yearly: 29000 };
let proId = '';
let adminUser = '';

async function makeUser(admin = false): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [id, `u-${id.slice(0, 8)}@test.local`]);
  if (admin) await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [id]);
  return id;
}

async function makeWorkspace(owner?: string): Promise<string> {
  const id = randomUUID();
  const ownerId = owner ?? (await makeUser());
  await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, ownerId]);
  return id;
}

let keySeq = 0;
const credit = async (ws: string, amount: number, actor: string | null = null) =>
  q(`SELECT public.billing_account_admin_adjust($1, $2, 'USD', 'test credit', $3, $4)`, [ws, amount, actor, `purge-test-${++keySeq}`]);
const purchase = (ws: string, plan: string) =>
  q(`SELECT public.billing_account_purchase_plan($1, $2, 'monthly', $3)`, [ws, plan, randomUUID()]);

let txnSeq = 0;
const txn = (prefix = 'txn') => `${prefix}_${++txnSeq}_${randomUUID().slice(0, 8)}`;

/** A gateway top-up started by `by`, verified and settled: a payment and its ledger row. */
async function topup(ws: string, amount: number, by: string | null = null): Promise<string> {
  const pay = String((await one(
    `INSERT INTO public.billing_account_payments
       (workspace_id, provider, currency, amount_minor, net_minor, purpose, created_by, provider_ref)
     VALUES ($1, 'paddle_sandbox', 'USD', $2, $2, 'topup', $3, $4) RETURNING id`,
    [ws, amount, by, txn('txn_topup')],
  )).id);
  await q(`SELECT public.billing_account_record_verification($1, $2, 'USD', $3)`, [pay, amount, txn('ref')]);
  await q(`SELECT public.billing_account_settle_payment($1)`, [pay]);
  return pay;
}

/** A checkout payment that saves a card, and the card. */
async function saveCard(ws: string): Promise<string> {
  const pay = String((await one(
    `INSERT INTO public.billing_account_payments
       (workspace_id, provider, currency, amount_minor, net_minor, purpose, purpose_detail, source, provider_ref)
     VALUES ($1, 'paddle_sandbox', 'USD', $2, $2, 'plan', $3, 'card_setup', $4) RETURNING id`,
    [ws, PRO.monthly, JSON.stringify({ plan_id: proId, billing_interval: 'monthly' }), txn('txn_setup')],
  )).id);
  const r = await one(
    `SELECT public.billing_card_register('paddle_sandbox', $1, 'ctm_1', 'USD', $2) AS r`,
    [`sub_${randomUUID().slice(0, 13)}`, pay],
  );
  return String((r.r as Row).card_id);
}

/** A workspace with everything the simple billing keeps: ledger rows, payments, a live and a cancelled card. */
async function billedWorkspace(owner?: string): Promise<{ ws: string; card: string; oldCard: string }> {
  const ws = await makeWorkspace(owner);
  await credit(ws, PRO.monthly);
  await topup(ws, 500);
  await purchase(ws, proId);
  const card = await saveCard(ws);
  const oldCard = String((await one(
    `INSERT INTO public.billing_account_cards (workspace_id, provider, subscription_id, currency, status, cancel_reason)
     VALUES ($1, 'paddle_sandbox', $2, 'USD', 'canceled', 'removed') RETURNING id`,
    [ws, `sub_old_${randomUUID()}`],
  )).id);
  expect(Number((await one(`SELECT count(*) AS n FROM public.billing_account_ledger WHERE workspace_id = $1`, [ws])).n)).toBeGreaterThanOrEqual(3);
  expect(Number((await one(`SELECT count(*) AS n FROM public.billing_account_payments WHERE workspace_id = $1`, [ws])).n)).toBe(2);
  return { ws, card, oldCard };
}

const left = async (ws: string) => ({
  workspace: (await q(`SELECT 1 FROM public.workspaces WHERE id = $1`, [ws])).length,
  ledger: (await q(`SELECT 1 FROM public.billing_account_ledger WHERE workspace_id = $1`, [ws])).length,
  payments: (await q(`SELECT 1 FROM public.billing_account_payments WHERE workspace_id = $1`, [ws])).length,
  account: (await q(`SELECT 1 FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).length,
  subscription: (await q(`SELECT 1 FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws])).length,
});
const GONE = { workspace: 0, ledger: 0, payments: 0, account: 0, subscription: 0 };

/** The card a purged workspace leaves behind: canceling, for the job to cancel at Paddle; a cancelled one is gone. */
async function expectCardsLeftForTheJob(card: string, oldCard: string): Promise<void> {
  expect(await one(`SELECT status, cancel_reason, setup_payment_id FROM public.billing_account_cards WHERE id = $1`, [card]))
    .toEqual({ status: 'canceling', cancel_reason: 'workspace_deleted', setup_payment_id: null });
  expect((await q(`SELECT id FROM public.billing_card_sync_candidates(1000)`)).map((r) => r.id)).toContain(card);
  expect(await q(`SELECT 1 FROM public.billing_account_cards WHERE id = $1`, [oldCard])).toHaveLength(0);
}

const ledgerOf = (ws: string) =>
  q(`SELECT id, kind, amount_minor, balance_after, actor_id, payment_id FROM public.billing_account_ledger
      WHERE workspace_id = $1 ORDER BY created_at, id`, [ws]);

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

suite('263 — the purge gets through the simple billing ledger (real PostgreSQL, whole chain)', () => {
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
    await db.query(`UPDATE public.platform_settings SET region_mode = 'multi'`);
    await db.query(
      `INSERT INTO public.billing_settings (edition, vat_percent, receipt_prefix) VALUES ('international', '{}', 'RS')
       ON CONFLICT (edition) DO NOTHING`,
    );
    proId = String((await one(
      `INSERT INTO public.billing_plans (name, slug, prices, limits, is_active, is_free, is_hidden, sort_order)
       VALUES ('p-pro', 'p-pro', $1, $2, true, false, false, 10) RETURNING id`,
      [JSON.stringify({ USD: PRO }), JSON.stringify({ included_ai_allowance_irr: 0, max_agents: 5 })],
    )).id);
    adminUser = await makeUser(true);
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('admin_delete_workspace removes a workspace with ledger rows, payments and a card; the card stays for the job', async () => {
    const { ws, card, oldCard } = await billedWorkspace();
    const other = await makeWorkspace();
    await credit(other, 700);
    const otherLedger = await ledgerOf(other);

    await asService(() => q(`SELECT public.admin_delete_workspace($1, $2)`, [adminUser, ws]));

    expect(await left(ws)).toEqual(GONE);
    await expectCardsLeftForTheJob(card, oldCard);
    expect(await ledgerOf(other)).toEqual(otherLedger);
    // The purge's settings were transaction-local.
    expect((await one(`SELECT coalesce(current_setting('app.billing_purge_workspaces', true), '') AS s`)).s).toBe('');
  });

  it('admin_purge_workspaces removes several workspaces, also when one transaction purges them in several calls', async () => {
    const a = await billedWorkspace();
    const b = await billedWorkspace();
    expect(Number((await one(`SELECT public.admin_purge_workspaces(ARRAY[$1, $2]::uuid[]) AS n`, [a.ws, b.ws])).n)).toBeGreaterThan(0);
    expect(await left(a.ws)).toEqual(GONE);
    expect(await left(b.ws)).toEqual(GONE);
    await expectCardsLeftForTheJob(a.card, a.oldCard);
    await expectCardsLeftForTheJob(b.card, b.oldCard);

    const c = await billedWorkspace();
    const d = await billedWorkspace();
    const listed = await asService(async () => {
      await q(`SELECT public.admin_purge_workspaces(ARRAY[$1]::uuid[])`, [c.ws]);
      await q(`SELECT public.admin_purge_workspaces(ARRAY[$1]::uuid[])`, [d.ws]);
      return String((await one(`SELECT current_setting('app.billing_purge_workspaces', true) AS s`)).s);
    });
    expect(listed.split(',')).toEqual([c.ws, d.ws]);
    expect(await left(c.ws)).toEqual(GONE);
    expect(await left(d.ws)).toEqual(GONE);

    // Nothing to purge is a no-op.
    expect(Number((await one(`SELECT public.admin_purge_workspaces('{}'::uuid[]) AS n`)).n)).toBe(0);
  });

  it('admin_delete_user removes the user\'s workspace; a workspace the user topped up keeps its ledger and payments', async () => {
    const user = await makeUser();
    const own = await billedWorkspace(user);
    const theirs = await makeWorkspace(); // owned by someone else
    await credit(theirs, 1000);
    const pay = await topup(theirs, 300, user);
    await credit(theirs, 200, user); // an adjustment the user is the actor of
    const ledger = await ledgerOf(theirs);
    expect(ledger.filter((r) => r.actor_id === user)).toHaveLength(2);
    const payments = await q(`SELECT * FROM public.billing_account_payments WHERE workspace_id = $1 ORDER BY id`, [theirs]);
    const balance = (await one(`SELECT balance_minor FROM public.billing_accounts WHERE workspace_id = $1`, [theirs])).balance_minor;

    const r = (await asService(() => one(`SELECT public.admin_delete_user($1, $2) AS r`, [adminUser, user]))).r as Row;
    expect(r).toMatchObject({ deleted_user_id: user, workspaces_deleted: 1 });

    expect(await q(`SELECT 1 FROM public.profiles WHERE id = $1`, [user])).toHaveLength(0);
    expect(await left(own.ws)).toEqual(GONE);
    await expectCardsLeftForTheJob(own.card, own.oldCard);
    // The other workspace: ledger (and its balance_after chain), payments and balance unchanged.
    expect(await ledgerOf(theirs)).toEqual(ledger);
    expect(await q(`SELECT * FROM public.billing_account_payments WHERE workspace_id = $1 ORDER BY id`, [theirs])).toEqual(payments);
    expect((await one(`SELECT created_by FROM public.billing_account_payments WHERE id = $1`, [pay])).created_by).toBe(user);
    expect((await one(`SELECT balance_minor FROM public.billing_accounts WHERE workspace_id = $1`, [theirs])).balance_minor).toBe(balance);
  });

  it('outside a purge the ledger is append-only; UPDATE is refused inside a purge too', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 400);
    const id = String((await ledgerOf(ws))[0].id);

    await expect(q(`DELETE FROM public.billing_account_ledger WHERE id = $1`, [id])).rejects.toThrow(/billing_account_ledger is append-only/);
    await expect(q(`UPDATE public.billing_account_ledger SET description = '{}' WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(asService(() => q(`DELETE FROM public.billing_account_ledger WHERE id = $1`, [id]))).rejects.toThrow(/append-only|permission denied/);

    // A purge of this very workspace still may not change a row.
    await q('BEGIN');
    try {
      await q(`SELECT set_config('app.billing_purge', 'on', true), set_config('app.billing_purge_workspaces', $1, true)`, [ws]);
      await expect(q(`UPDATE public.billing_account_ledger SET description = '{}' WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
    } finally {
      await q('ROLLBACK');
    }
    // A purge of something else deletes nothing of it.
    await q('BEGIN');
    try {
      await q(`SELECT set_config('app.billing_purge', 'on', true), set_config('app.billing_purge_workspaces', $1, true)`, [randomUUID()]);
      expect((await db.query(`DELETE FROM public.billing_account_ledger WHERE workspace_id = $1`, [ws])).rowCount).toBe(0);
    } finally {
      await q('ROLLBACK');
    }
    expect(await ledgerOf(ws)).toHaveLength(1);

    // A plain workspace delete still cascades, as in 259.
    await q(`DELETE FROM public.workspaces WHERE id = $1`, [ws]);
    expect(await ledgerOf(ws)).toHaveLength(0);
  });

  it('a payment can still be deleted outside a purge (the pruning job)', async () => {
    const ws = await makeWorkspace();
    const pay = String((await one(
      `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, purpose, status)
       VALUES ($1, 'paddle_sandbox', 'USD', 100, 100, 'topup', 'expired') RETURNING id`, [ws],
    )).id);
    expect((await db.query(`DELETE FROM public.billing_account_payments WHERE id = $1`, [pay])).rowCount).toBe(1);
  });

  it('access: the purge and its body are service_role only', async () => {
    for (const f of [
      'public.admin_purge_workspaces(uuid[])',
      'public.admin_purge_workspaces_core(uuid[])',
      'public.admin_delete_workspace(uuid, uuid)',
      'public.admin_delete_user(uuid, uuid)',
      'public.billing_purge_includes(uuid)',
      'public.billing_account_ledger_immutable()',
      'public.billing_account_payments_keep_on_purge()',
    ]) {
      const r = await one(
        `SELECT has_function_privilege('anon', $1, 'execute') AS anon,
                has_function_privilege('authenticated', $1, 'execute') AS auth,
                has_function_privilege('service_role', $1, 'execute') AS svc`, [f]);
      expect(r, f).toEqual({ anon: false, auth: false, svc: true });
    }
    expect(await one(
      `SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'public.admin_purge_workspaces(uuid[])'::regprocedure`,
    )).toEqual({ prosecdef: true, proconfig: ['search_path=public'] });
  });

  it('running 263 again changes nothing', async () => {
    const snapshot = async () => ({
      functions: await q(
        `SELECT p.oid::regprocedure::text AS f, md5(pg_get_functiondef(p.oid)) AS h, p.proacl::text AS acl FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace
            AND (p.proname LIKE 'admin_%' OR p.proname LIKE 'billing_purge%' OR p.proname LIKE 'billing_account%')
          ORDER BY 1`),
      triggers: await q(`SELECT tgrelid::regclass::text AS t, tgname, md5(pg_get_triggerdef(oid)) AS h FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`),
    });
    const before = await snapshot();
    expect(before.functions.map((r) => r.f)).toContain('admin_purge_workspaces_core(uuid[])');
    await applyMigrationSql(db, readFileSync(resolve(DIR, FILE), 'utf8'));
    expect(await snapshot()).toEqual(before);

    // And the purge still works after it.
    const { ws } = await billedWorkspace();
    await q(`SELECT public.admin_purge_workspaces(ARRAY[$1]::uuid[])`, [ws]);
    expect(await left(ws)).toEqual(GONE);
  });
});
