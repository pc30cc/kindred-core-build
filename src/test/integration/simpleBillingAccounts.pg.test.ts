// @vitest-environment node
/**
 * 259 — the simple billing's prepaid accounts, against real PostgreSQL built
 * by the whole migration chain (docs/billing/SIMPLE_BILLING.md).
 *
 *   - an account is created once, in one currency that never changes;
 *   - a verified gateway payment credits its net amount exactly once, with a
 *     numbered receipt carrying the seller and buyer of that moment; a replay
 *     credits nothing, and a wrong amount or currency credits nothing;
 *   - money confirmed for an attempt already given up on is still credited;
 *   - the balance never goes below zero, and the ledger is append-only;
 *   - Super Admin adjustments are idempotent per command key;
 *   - unfinished attempts are pruned after 30 days, settled ones never;
 *   - only service_role reaches any of it.
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
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the simple billing account tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `simplebilling259_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '259_simple_billing_accounts.sql';

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

async function makeWorkspace(name = 'Acme'): Promise<string> {
  const id = randomUUID();
  const owner = randomUUID();
  await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
  await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)`, [
    id, name, `ws-${id.slice(0, 8)}`, owner,
  ]);
  return id;
}

async function makePayment(
  ws: string,
  o: { net: number; tax?: number; currency?: string; status?: string; createdDaysAgo?: number; provider?: string },
): Promise<string> {
  const tax = o.tax ?? 0;
  const row = await one(
    `INSERT INTO public.billing_account_payments
       (workspace_id, provider, currency, amount_minor, net_minor, tax_minor, tax_percent, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - make_interval(days => $9))
     RETURNING id`,
    [ws, o.provider ?? 'paddle_sandbox', o.currency ?? 'USD', o.net + tax, o.net, tax, tax ? 10 : null,
      o.status ?? 'pending', o.createdDaysAgo ?? 0],
  );
  return String(row.id);
}

let refSeq = 0;
/** The gateway confirmed the payment (recorded first), then it is settled. */
const settle = async (paymentId: string, amount: number, currency: string, ref: string | null = null) => {
  await q(`SELECT public.billing_account_record_verification($1, $2, $3, $4)`, [paymentId, amount, currency, ref ?? `txn_${++refSeq}`]);
  return one(`SELECT public.billing_account_settle_payment($1) AS r`, [paymentId]).then((row) => row.r as Row);
};

const balanceOf = async (ws: string): Promise<number> =>
  Number((await one(`SELECT balance_minor FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).balance_minor);

suite('259 — simple billing accounts (real PostgreSQL, whole chain)', () => {
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
    // Re-runnable: a second apply changes nothing and fails on nothing.
    await applyMigrationSql(db, readFileSync(resolve(DIR, FILE), 'utf8'));

    await db.query(
      `INSERT INTO public.billing_settings (edition, seller, vat_percent, receipt_prefix)
       VALUES ('international', '{"legal_name":"Respok Ltd","vat_id":"GB123"}', '{"USD":null}', 'RS')`,
    );
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
      await admin.end();
    }
  });

  it('creates an account once, in a currency that never changes', async () => {
    const ws = await makeWorkspace();
    const first = await one(`SELECT (public.billing_account_ensure($1, 'usd')).*`, [ws]);
    expect(first.currency).toBe('USD');
    expect(Number(first.balance_minor)).toBe(0);
    expect(first.auto_renew).toBe(false);
    const again = await one(`SELECT (public.billing_account_ensure($1, 'IRR')).*`, [ws]);
    expect(again.currency).toBe('USD');
    await expect(q(`SELECT public.billing_account_ensure($1, 'US')`, [ws])).rejects.toThrow(/billing_account_bad_currency/);
  });

  it('credits a verified payment once, with a numbered receipt of that moment', async () => {
    const ws = await makeWorkspace('Contoso');
    await q(`SELECT public.billing_account_ensure($1, 'USD')`, [ws]);
    await q(`UPDATE public.billing_accounts SET billing_profile = '{"company":"Contoso Inc","vat_id":"DE999"}' WHERE workspace_id = $1`, [ws]);
    const pay = await makePayment(ws, { net: 2500 });

    const r = await settle(pay, 2500, 'usd', 'txn_abc');
    expect(r.replayed).toBe(false);
    expect(r.receipt_number).toMatch(/^RS\d{4}-\d{6}$/);
    expect(Number(r.balance_minor)).toBe(2500);
    expect(await balanceOf(ws)).toBe(2500);

    const entry = await one(`SELECT * FROM public.billing_account_ledger WHERE id = $1`, [r.ledger_id]);
    expect(entry.kind).toBe('topup');
    expect(Number(entry.amount_minor)).toBe(2500);
    expect(Number(entry.balance_after)).toBe(2500);
    expect(entry.currency).toBe('USD');
    expect(entry.receipt_number).toBe(r.receipt_number);
    expect(entry.seller).toEqual({ legal_name: 'Respok Ltd', vat_id: 'GB123' });
    expect(entry.buyer).toEqual({ workspace_name: 'Contoso', company: 'Contoso Inc', vat_id: 'DE999' });

    const payment = await one(`SELECT * FROM public.billing_account_payments WHERE id = $1`, [pay]);
    expect(payment.status).toBe('succeeded');
    expect(payment.ledger_id).toBe(r.ledger_id);
    expect(payment.provider_payment_id).toBe('txn_abc');

    // A replay (second callback, the webhook after the return) credits nothing.
    const replay = await settle(pay, 2500, 'USD', 'txn_abc');
    expect(replay.replayed).toBe(true);
    expect(replay.ledger_id).toBe(r.ledger_id);
    expect(await balanceOf(ws)).toBe(2500);
    expect((await q(`SELECT 1 FROM public.billing_account_ledger WHERE workspace_id = $1`, [ws])).length).toBe(1);
  });

  it('credits the net amount; the tax is on the receipt only', async () => {
    const ws = await makeWorkspace();
    const pay = await makePayment(ws, { net: 1_000_000, tax: 100_000, currency: 'IRR', provider: 'zarinpal' });
    const r = await settle(pay, 1_100_000, 'IRR');
    expect(await balanceOf(ws)).toBe(1_000_000);
    const entry = await one(`SELECT net_minor, tax_minor, tax_percent FROM public.billing_account_ledger WHERE id = $1`, [r.ledger_id]);
    expect(Number(entry.net_minor)).toBe(1_000_000);
    expect(Number(entry.tax_minor)).toBe(100_000);
    expect(Number(entry.tax_percent)).toBe(10);
  });

  it('credits nothing for a wrong amount or currency', async () => {
    const ws = await makeWorkspace();
    const pay = await makePayment(ws, { net: 900 });
    await expect(settle(pay, 899, 'USD')).rejects.toThrow(/billing_payment_amount_mismatch/);
    await expect(settle(pay, 900, 'EUR')).rejects.toThrow(/billing_payment_currency_mismatch/);
    expect((await one(`SELECT verified_at FROM public.billing_account_payments WHERE id = $1`, [pay])).verified_at).toBeNull();
    expect((await one(`SELECT status FROM public.billing_account_payments WHERE id = $1`, [pay])).status).toBe('pending');
    expect(await q(`SELECT 1 FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).toHaveLength(0);
  });

  it('never mixes currencies in one account; an account that never moved money takes the first payment\'s', async () => {
    const ws = await makeWorkspace();
    await q(`SELECT public.billing_account_ensure($1, 'TRY')`, [ws]);
    const usd = await makePayment(ws, { net: 500, currency: 'USD' });
    await settle(usd, 500, 'USD');
    expect((await one(`SELECT currency FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).currency).toBe('USD');
    expect(await balanceOf(ws)).toBe(500);

    const tl = await makePayment(ws, { net: 10_000, currency: 'TRY' });
    await q(`SELECT public.billing_account_record_verification($1, 10000, 'TRY', 'txn_try')`, [tl]);
    await expect(q(`SELECT public.billing_account_settle_payment($1)`, [tl])).rejects.toThrow(/billing_account_currency_mismatch/);
    expect(await balanceOf(ws)).toBe(500);
  });

  it('settles nothing the gateway did not confirm', async () => {
    const ws = await makeWorkspace();
    const pay = await makePayment(ws, { net: 800 });
    await expect(q(`SELECT public.billing_account_settle_payment($1)`, [pay])).rejects.toThrow(/billing_payment_not_verified/);
    expect(await q(`SELECT 1 FROM public.billing_account_ledger WHERE workspace_id = $1`, [ws])).toHaveLength(0);
  });

  it('one gateway transaction settles one payment, never a second', async () => {
    const ws = await makeWorkspace();
    const a = await makePayment(ws, { net: 1_000_000, currency: 'IRR', provider: 'sep_shaparak' });
    const b = await makePayment(ws, { net: 1_000_000, currency: 'IRR', provider: 'sep_shaparak' });
    await settle(a, 1_000_000, 'IRR', 'RefNum-1');
    await expect(q(`SELECT public.billing_account_record_verification($1, 1000000, 'IRR', 'RefNum-1')`, [b]))
      .rejects.toThrow(/billing_payment_reference_reused/);
    // A confirmed payment cannot be re-confirmed with another transaction either.
    await expect(q(`SELECT public.billing_account_record_verification($1, 1000000, 'IRR', 'RefNum-2')`, [a]))
      .rejects.toThrow(/billing_payment_reference_reused/);
    expect(await balanceOf(ws)).toBe(1_000_000);
    // The same transaction again is a no-op.
    await q(`SELECT public.billing_account_record_verification($1, 1000000, 'IRR', 'RefNum-1')`, [a]);
  });

  it('a confirmation whose settlement failed is settled later from the record, without the gateway', async () => {
    const ws = await makeWorkspace();
    const pay = await makePayment(ws, { net: 300 });
    await q(`SELECT public.billing_account_record_verification($1, 300, 'USD', 'txn_late')`, [pay]);
    // ... the settle call never happened (crash). Later:
    const r = (await one(`SELECT public.billing_account_settle_payment($1) AS r`, [pay])).r as Row;
    expect(r.replayed).toBe(false);
    expect(await balanceOf(ws)).toBe(300);
  });

  it('a refund takes the credit back in proportion, never below zero, once per refund id', async () => {
    const ws = await makeWorkspace();
    const pay = await makePayment(ws, { net: 1_000_000, tax: 100_000, currency: 'IRR', provider: 'zarinpal' });
    await settle(pay, 1_100_000, 'IRR');
    // Half refunded (gross 550,000 = net 500,000).
    const half = (await one(`SELECT public.billing_account_refund_payment($1, 'rf1', 550000) AS r`, [pay])).r as Row;
    expect(Number(half.debited_minor)).toBe(500_000);
    expect(Number(half.shortfall_minor)).toBe(0);
    expect(await balanceOf(ws)).toBe(500_000);
    const again = (await one(`SELECT public.billing_account_refund_payment($1, 'rf1', 550000) AS r`, [pay])).r as Row;
    expect(again.replayed).toBe(true);
    expect(await balanceOf(ws)).toBe(500_000);
    // Spend some of it, then the rest is refunded: what was spent is a shortfall.
    await q(`SELECT public.billing_account_admin_adjust($1, -300000, 'IRR', 'spent', NULL, $2)`, [ws, randomUUID()]);
    const rest = (await one(`SELECT public.billing_account_refund_payment($1, 'rf2', 550000) AS r`, [pay])).r as Row;
    expect(Number(rest.debited_minor)).toBe(200_000);
    expect(Number(rest.shortfall_minor)).toBe(300_000);
    expect(await balanceOf(ws)).toBe(0);
    // Nothing more can be refunded than was credited.
    const over = (await one(`SELECT public.billing_account_refund_payment($1, 'rf3', 550000) AS r`, [pay])).r as Row;
    expect(over.ledger_id).toBeNull();
    expect(await balanceOf(ws)).toBe(0);
  });

  it('receipt numbers keep growing past six digits', async () => {
    await q(`SELECT setval('public.billing_receipt_seq', 999999)`);
    const ws = await makeWorkspace();
    const p1 = await makePayment(ws, { net: 600 });
    const p2 = await makePayment(ws, { net: 600 });
    const r1 = await settle(p1, 600, 'USD');
    const r2 = await settle(p2, 600, 'USD');
    expect(r1.receipt_number).toMatch(/^RS\d{4}-1000000$/);
    expect(r2.receipt_number).toMatch(/^RS\d{4}-1000001$/);
  });

  it('the ledger cannot be deleted directly, only with its workspace', async () => {
    const ws = await makeWorkspace();
    const pay = await makePayment(ws, { net: 700 });
    const r = await settle(pay, 700, 'USD');
    await expect(q(`DELETE FROM public.billing_account_ledger WHERE id = $1`, [r.ledger_id])).rejects.toThrow(/append-only/);
    await q(`DELETE FROM public.workspaces WHERE id = $1`, [ws]);
    expect(await q(`SELECT 1 FROM public.billing_account_ledger WHERE workspace_id = $1`, [ws])).toHaveLength(0);
  });

  it('still credits money confirmed for an attempt that was given up on', async () => {
    const ws = await makeWorkspace();
    const pay = await makePayment(ws, { net: 700, status: 'expired' });
    const r = await settle(pay, 700, 'USD');
    expect(r.replayed).toBe(false);
    expect(await balanceOf(ws)).toBe(700);
  });

  it('settles one payment once under concurrent callbacks', async () => {
    const ws = await makeWorkspace();
    const pay = await makePayment(ws, { net: 1200 });
    const url = new URL(DSN!);
    url.pathname = `/${DB}`;
    const others = await Promise.all([0, 1, 2].map(async () => {
      const c = new pg.Client({ connectionString: url.toString() });
      await c.connect();
      return c;
    }));
    try {
      await q(`SELECT public.billing_account_record_verification($1, 1200, 'USD', 'txn_conc')`, [pay]);
      const results = await Promise.all(others.map((c) =>
        c.query(`SELECT public.billing_account_settle_payment($1) AS r`, [pay])
          .then((res) => res.rows[0].r as Row)));
      expect(results.filter((r) => r.replayed === false)).toHaveLength(1);
      expect(await balanceOf(ws)).toBe(1200);
    } finally {
      await Promise.all(others.map((c) => c.end()));
    }
  });

  it('keeps the balance at zero or above, and the ledger append-only', async () => {
    const ws = await makeWorkspace();
    await q(`SELECT public.billing_account_ensure($1, 'USD')`, [ws]);
    await expect(q(`UPDATE public.billing_accounts SET balance_minor = -1 WHERE workspace_id = $1`, [ws]))
      .rejects.toThrow(/billing_accounts_balance_check/);
    const r = await one(`SELECT public.billing_account_admin_adjust($1, 300, 'USD', 'goodwill', NULL, $2) AS r`, [ws, randomUUID()]);
    const ledgerId = (r.r as Row).ledger_id;
    await expect(q(`UPDATE public.billing_account_ledger SET amount_minor = 1 WHERE id = $1`, [ledgerId]))
      .rejects.toThrow(/append-only/);
  });

  it('applies Super Admin adjustments once per command key, never below zero', async () => {
    const ws = await makeWorkspace();
    const key = randomUUID();
    const credit = (await one(`SELECT public.billing_account_admin_adjust($1, 1000, 'USD', 'gift', NULL, $2) AS r`, [ws, key])).r as Row;
    expect(credit.replayed).toBe(false);
    const again = (await one(`SELECT public.billing_account_admin_adjust($1, 1000, 'USD', 'gift', NULL, $2) AS r`, [ws, key])).r as Row;
    expect(again.replayed).toBe(true);
    expect(await balanceOf(ws)).toBe(1000);

    await expect(q(`SELECT public.billing_account_admin_adjust($1, -1001, 'USD', 'fix', NULL, $2)`, [ws, randomUUID()]))
      .rejects.toThrow(/billing_insufficient_balance/);
    await q(`SELECT public.billing_account_admin_adjust($1, -400, 'USD', 'fix', NULL, $2)`, [ws, randomUUID()]);
    expect(await balanceOf(ws)).toBe(600);
    const kinds = await q(`SELECT kind FROM public.billing_account_ledger WHERE workspace_id = $1 ORDER BY created_at`, [ws]);
    expect(kinds.map((k) => k.kind)).toEqual(['admin_credit', 'admin_debit']);
    await expect(q(`SELECT public.billing_account_admin_adjust($1, 0, 'USD', 'x', NULL, $2)`, [ws, randomUUID()]))
      .rejects.toThrow(/billing_adjust_zero/);
  });

  it('prunes unfinished attempts older than 30 days, never settled ones', async () => {
    const ws = await makeWorkspace();
    const oldPending = await makePayment(ws, { net: 100, createdDaysAgo: 31 });
    const oldFailed = await makePayment(ws, { net: 100, status: 'failed', createdDaysAgo: 40 });
    const recent = await makePayment(ws, { net: 100, createdDaysAgo: 2 });
    const settled = await makePayment(ws, { net: 100, createdDaysAgo: 31 });
    await settle(settled, 100, 'USD');
    await q(`UPDATE public.billing_account_payments SET created_at = now() - interval '45 days' WHERE id = $1`, [settled]);

    const openCard = await makePayment(ws, { net: 100, status: 'expired', createdDaysAgo: 40 });
    await q(`UPDATE public.billing_account_payments SET provider_ref = 'txn_open' WHERE id = $1`, [openCard]);
    const iranOld = await makePayment(ws, { net: 100, status: 'expired', createdDaysAgo: 40, provider: 'zarinpal' });
    await q(`UPDATE public.billing_account_payments SET provider_ref = 'A0001' WHERE id = $1`, [iranOld]);
    const confirmed = await makePayment(ws, { net: 100, createdDaysAgo: 40 });
    await q(`SELECT public.billing_account_record_verification($1, 100, 'USD', 'txn_confirmed')`, [confirmed]);

    await q(`SELECT public.billing_account_prune_payments(30, ARRAY['zarinpal'])`);
    const left = (await q(`SELECT id FROM public.billing_account_payments WHERE workspace_id = $1`, [ws])).map((r) => r.id);
    expect(left).toContain(recent);
    expect(left).toContain(settled);
    expect(left).not.toContain(oldPending);
    expect(left).not.toContain(oldFailed);
    expect(left).not.toContain(iranOld);
    // A card checkout that may still be paid, and a confirmed payment, stay.
    expect(left).toContain(openCard);
    expect(left).toContain(confirmed);
  });

  it('is reachable by service_role only', async () => {
    const tables = await q(
      `SELECT c.relname, c.relrowsecurity,
              has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select,
              has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
              has_table_privilege('service_role', c.oid, 'SELECT') AS service_select
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN ('billing_settings', 'billing_accounts', 'billing_account_ledger', 'billing_account_payments')
        ORDER BY 1`,
    );
    expect(tables).toHaveLength(4);
    for (const t of tables) {
      expect(t.relrowsecurity).toBe(true);
      expect(t.auth_select).toBe(false);
      expect(t.anon_select).toBe(false);
      expect(t.service_select).toBe(true);
    }
    const fns = await q(
      `SELECT p.oid::regprocedure::text AS fn,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'billing_account_%'`,
    );
    expect(fns.length).toBeGreaterThanOrEqual(7);
    for (const f of fns) {
      expect(f.auth_exec).toBe(false);
      expect(f.anon_exec).toBe(false);
      expect(f.service_exec).toBe(true);
    }
  });

  it('gives plans a locked-data retention (null = never) and an AI allowance per currency', async () => {
    const cols = await q(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'billing_plans'
          AND column_name IN ('locked_data_retention_days', 'ai_allowance') ORDER BY 1`,
    );
    expect(cols).toEqual([
      { column_name: 'ai_allowance', data_type: 'jsonb', is_nullable: 'NO' },
      { column_name: 'locked_data_retention_days', data_type: 'integer', is_nullable: 'YES' },
    ]);
  });
});
