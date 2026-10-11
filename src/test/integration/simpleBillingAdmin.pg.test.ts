// @vitest-environment node
/**
 * 266 — the Super Admin's billing functions, against real PostgreSQL built by
 * the whole migration chain (docs/billing/SIMPLE_BILLING.md, phase 6).
 *
 *   M1  credit and debit: a debit to exactly zero works, one below zero is
 *       refused; the reason and category are stored; an account that did not
 *       exist is created in the given currency; a currency mismatch is
 *       refused;
 *   M2  a command key is bound to its charge: a true replay replays (also
 *       with a stale expected balance), the same key with another amount,
 *       direction or workspace is refused;
 *   M3  the balance the admin saw: a stale one is refused, nothing written;
 *   M4  category, reason (3-500, trimmed) and the size cap per currency;
 *   M5  259's 6-argument call still resolves, with category `other`;
 *   M6  refunds are stamped with their own time; a later update keeps it;
 *   M7  the backfill took the ledger's time (else the payment's), and left
 *       updated_at alone;
 *   M8  revenue per local day: both sides of a Tehran midnight, refunds on
 *       their own day with their tax share, only succeeded payments, a card
 *       renewal's net and tax from its row;
 *   M9  balance movements per kind and currency; the outstanding balance;
 *   M10 the accounts list: every filter and sort, search by name, slug,
 *       email and id, workspaces without an account, an owner's workspaces,
 *       paging;
 *   M11 an account's payments: every status, newest first, with refunds;
 *   M12 only service_role reaches the functions; every one pins search_path;
 *       266 runs twice.
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
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the Super Admin billing SQL tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `simplebilling266_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '266_simple_billing_admin.sql';
const SQL_266 = readFileSync(resolve(DIR, FILE), 'utf8');

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];
const fn = async (sql: string, params: unknown[] = []): Promise<Row> => (await one(sql, params)).r as Row;

let proId = '';
let freeId = '';

async function makeOwner(email?: string): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [id, email ?? `o-${id.slice(0, 8)}@test.local`]);
  return id;
}

async function makeWorkspace(o: { name?: string; slug?: string; owner?: string } = {}): Promise<string> {
  const id = randomUUID();
  const owner = o.owner ?? (await makeOwner());
  await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)`, [
    id, o.name ?? 'Acme', o.slug ?? `ws-${id.slice(0, 8)}`, owner,
  ]);
  return id;
}

/** 266's adjust with every argument. */
const adjust = (
  ws: string, amount: number, o: { currency?: string; reason?: string | null; key?: string; category?: string | null; expected?: number | null; actor?: string | null } = {},
) =>
  fn(`SELECT public.billing_account_admin_adjust($1, $2, $3, $4, $5, $6, $7, $8) AS r`, [
    ws, amount, o.currency ?? 'USD', o.reason === undefined ? 'test credit' : o.reason, o.actor ?? null,
    o.key ?? randomUUID(), o.category === undefined ? 'test' : o.category, o.expected ?? null,
  ]);

const balanceOf = async (ws: string): Promise<number> =>
  Number((await one(`SELECT balance_minor FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).balance_minor);
const ledger = (ws: string) =>
  q(`SELECT kind, amount_minor::bigint::int AS amount, balance_after::bigint::int AS balance_after, currency, description, actor_id
       FROM public.billing_account_ledger WHERE workspace_id = $1 ORDER BY created_at, id`, [ws]);

/** A payment row written directly (the report tests need exact times and states). */
async function rawPayment(ws: string, o: {
  provider: string; currency?: string; net: number; tax?: number; status?: string; completedAt?: string | null;
  source?: string; purpose?: string; createdAt?: string;
}): Promise<string> {
  const tax = o.tax ?? 0;
  const row = await one(
    `INSERT INTO public.billing_account_payments
       (workspace_id, provider, currency, amount_minor, net_minor, tax_minor, status, completed_at, source, purpose, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11::timestamptz, now())) RETURNING id`,
    [ws, o.provider, o.currency ?? 'USD', o.net + tax, o.net, tax, o.status ?? 'succeeded',
      o.completedAt === undefined ? new Date().toISOString() : o.completedAt, o.source ?? 'checkout', o.purpose ?? 'topup',
      o.createdAt ?? null],
  );
  return String(row.id);
}

let refSeq = 0;
/** A gateway payment confirmed and settled through 259's functions. */
async function settledPayment(ws: string, o: { provider: string; currency: string; net: number; tax?: number }): Promise<string> {
  const tax = o.tax ?? 0;
  const row = await one(
    `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, tax_minor)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [ws, o.provider, o.currency, o.net + tax, o.net, tax],
  );
  await q(`SELECT public.billing_account_record_verification($1, $2, $3, $4)`, [row.id, o.net + tax, o.currency, `txn_${++refSeq}_${randomUUID()}`]);
  await q(`SELECT public.billing_account_settle_payment($1)`, [row.id]);
  return String(row.id);
}
const refund = (pay: string, refundId: string, amount: number) =>
  fn(`SELECT public.billing_account_refund_payment($1, $2, $3) AS r`, [pay, refundId, amount]);
const refundsOf = async (pay: string): Promise<Row> =>
  ((await one(`SELECT purpose_detail -> 'refunds' AS r FROM public.billing_account_payments WHERE id = $1`, [pay])).r ?? {}) as Row;
const refundedAt = async (pay: string, refundId: string): Promise<string> =>
  String((await one(`SELECT purpose_detail -> 'refunds' -> $2 ->> 'refunded_at' AS t FROM public.billing_account_payments WHERE id = $1`, [pay, refundId])).t);

async function subscribe(ws: string, plan: string, o: { endsInDays?: number | null; interval?: string | null; status?: string } = {}) {
  const ends = o.endsInDays === undefined ? 30 : o.endsInDays;
  await q(
    `INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status, billing_interval, current_period_start, current_period_end)
     VALUES ($1, $2, $3, $4, now(), CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5::int) END)`,
    [ws, plan, o.status ?? 'active', o.interval === undefined ? 'monthly' : o.interval, ends],
  );
}

const accounts = (o: { search?: string | null; filter?: string | null; currency?: string | null; sort?: string | null; limit?: number | null; offset?: number | null } = {}) =>
  fn(`SELECT public.billing_admin_accounts($1, $2, $3, $4, $5, $6) AS r`, [
    o.search ?? null, o.filter ?? null, o.currency ?? null, o.sort ?? null, o.limit ?? null, o.offset ?? null,
  ]) as Promise<{ total: number; items: Row[] }>;
const names = (r: { items: Row[] }) => r.items.map((i) => i.name);

// Fixtures written before 266 exists, for the backfill (M7).
const pre: { ledgerPay: string; noLedgerPay: string; stampedPay: string } = { ledgerPay: '', noLedgerPay: '', stampedPay: '' };

suite('266 — Super Admin billing functions (real PostgreSQL, whole chain)', () => {
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
    for (const file of files.filter((f) => f < FILE)) {
      await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
    }

    // Refunds recorded before 266: one whose refund wrote a ledger row, one
    // that found the balance empty (no ledger row), one already stamped.
    const ws1 = await makeWorkspace();
    pre.ledgerPay = await settledPayment(ws1, { provider: 'pre266', currency: 'USD', net: 1000 });
    await refund(pre.ledgerPay, 'old1', 400);
    const ws2 = await makeWorkspace();
    pre.noLedgerPay = await settledPayment(ws2, { provider: 'pre266', currency: 'USD', net: 1000 });
    await q(`SELECT public.billing_account_admin_adjust($1, -1000, 'USD', 'spent all', NULL, $2)`, [ws2, randomUUID()]);
    await refund(pre.noLedgerPay, 'old2', 300);
    const ws3 = await makeWorkspace();
    pre.stampedPay = await settledPayment(ws3, { provider: 'pre266', currency: 'USD', net: 1000 });
    await q(
      `UPDATE public.billing_account_payments
          SET purpose_detail = jsonb_build_object('refunds', jsonb_build_object('old3',
                jsonb_build_object('amount_minor', 100, 'credit_minor', 100, 'refunded_at', '2021-05-05T05:05:05+00:00')))
        WHERE id = $1`, [pre.stampedPay]);
    // The payments' last change, far from the ledger's time.
    await q(`UPDATE public.billing_account_payments SET updated_at = '2020-01-01T00:00:00Z' WHERE id = ANY ($1::uuid[])`,
      [[pre.ledgerPay, pre.noLedgerPay, pre.stampedPay]]);

    await applyMigrationSql(db, SQL_266);

    proId = String((await one(`SELECT id FROM public.billing_plans WHERE slug = 'pro'`)).id);
    freeId = String((await one(`SELECT id FROM public.billing_plans WHERE slug = 'free'`)).id);
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  // ─── Adjust ──────────────────────────────────────────────────────────────

  it('M1 credit and debit: down to exactly zero, never below; reason, category and actor stored', async () => {
    const ws = await makeWorkspace();
    const actor = randomUUID();
    const c = await adjust(ws, 1000, { reason: '  goodwill for outage  ', category: 'compensation', actor, expected: null });
    expect(c).toMatchObject({ replayed: false, balance_minor: 1000 });
    expect(await balanceOf(ws)).toBe(1000);
    await expect(adjust(ws, -1001, { category: 'correction' })).rejects.toThrow(/billing_insufficient_balance/);
    const d = await adjust(ws, -1000, { category: 'correction', reason: 'wrong top-up', expected: 1000 });
    expect(d).toMatchObject({ replayed: false, balance_minor: 0 });
    expect(await balanceOf(ws)).toBe(0);

    const rows = await ledger(ws);
    expect(rows.map((r) => [r.kind, r.amount, r.balance_after, r.currency])).toEqual([
      ['admin_credit', 1000, 1000, 'USD'], ['admin_debit', -1000, 0, 'USD'],
    ]);
    expect(rows[0].description).toEqual({ reason: 'goodwill for outage', category: 'compensation' });
    expect(rows[0].actor_id).toBe(actor);
    expect(rows[1].description).toEqual({ reason: 'wrong top-up', category: 'correction' });
    expect(String(c.ledger_id)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('M1b an account that did not exist is created in the given currency; another currency is refused', async () => {
    const ws = await makeWorkspace();
    await adjust(ws, 50_000, { currency: 'try' });
    expect(await one(`SELECT currency, balance_minor::int AS b FROM public.billing_accounts WHERE workspace_id = $1`, [ws]))
      .toEqual({ currency: 'TRY', b: 50_000 });
    await expect(adjust(ws, 100, { currency: 'USD' })).rejects.toThrow(/billing_account_currency_mismatch/);
    expect(await balanceOf(ws)).toBe(50_000);
    expect(await ledger(ws)).toHaveLength(1);
  });

  it('M2 a command key is bound to its charge', async () => {
    const ws = await makeWorkspace();
    const other = await makeWorkspace();
    const key = randomUUID();
    const first = await adjust(ws, 700, { key, expected: 0 });
    // A true replay, also with the (now stale) balance the admin saw.
    const again = await adjust(ws, 700, { key, expected: 0 });
    expect(again).toEqual({ replayed: true, ledger_id: first.ledger_id, balance_minor: 700 });
    expect(await adjust(ws, 700, { key, reason: 'other words', category: 'other' }))
      .toMatchObject({ replayed: true, ledger_id: first.ledger_id });
    // Another amount, another direction, another workspace.
    await expect(adjust(ws, 701, { key })).rejects.toThrow(/billing_adjust_key_reused/);
    await expect(adjust(ws, -700, { key })).rejects.toThrow(/billing_adjust_key_reused/);
    await expect(adjust(other, 700, { key })).rejects.toThrow(/billing_adjust_key_reused/);
    expect(await balanceOf(ws)).toBe(700);
    expect(await ledger(ws)).toHaveLength(1);
    expect(await ledger(other)).toHaveLength(0);
    // The refused call on the other workspace left no account behind.
    expect(await q(`SELECT 1 FROM public.billing_accounts WHERE workspace_id = $1`, [other])).toHaveLength(0);
  });

  it('M3 a stale expected balance is refused and writes nothing', async () => {
    const ws = await makeWorkspace();
    await adjust(ws, 500);
    await expect(adjust(ws, 100, { expected: 400 })).rejects.toThrow(/billing_adjust_balance_changed/);
    await expect(adjust(ws, -100, { expected: 0 })).rejects.toThrow(/billing_adjust_balance_changed/);
    expect(await balanceOf(ws)).toBe(500);
    expect(await adjust(ws, -100, { expected: 500 })).toMatchObject({ balance_minor: 400 });
    // A new account starts at zero.
    const fresh = await makeWorkspace();
    await expect(adjust(fresh, 100, { expected: 5 })).rejects.toThrow(/billing_adjust_balance_changed/);
    expect(await adjust(fresh, 100, { expected: 0 })).toMatchObject({ balance_minor: 100 });
  });

  it('M4 category, reason and the size cap per currency are checked', async () => {
    const ws = await makeWorkspace();
    for (const category of ['goodwill', 'compensation', 'correction', 'migration', 'test', 'other']) {
      await adjust(ws, 1, { category });
    }
    expect((await ledger(ws)).map((r) => (r.description as Row).category))
      .toEqual(['goodwill', 'compensation', 'correction', 'migration', 'test', 'other']);
    await expect(adjust(ws, 1, { category: 'bonus' })).rejects.toThrow(/billing_adjust_bad_category/);
    await expect(adjust(ws, 1, { category: null })).rejects.toThrow(/billing_adjust_bad_category/);

    for (const reason of [null, '', '  ab  ', 'x'.repeat(501)]) {
      await expect(adjust(ws, 1, { reason })).rejects.toThrow(/billing_adjust_reason_required/);
    }
    await adjust(ws, 1, { reason: 'x'.repeat(500) });
    await adjust(ws, 1, { reason: 'خطا' });

    await expect(adjust(ws, 0)).rejects.toThrow(/billing_adjust_zero/);
    await expect(fn(`SELECT public.billing_account_admin_adjust($1, 1, 'USD', 'reason', NULL, '', 'test', NULL) AS r`, [ws]))
      .rejects.toThrow(/billing_adjust_missing_key/);

    // TOPUP_LIMITS.max: USD $50,000; IRR 1,000,000,000 Toman; TRY 2,000,000 TL.
    await expect(adjust(ws, 5_000_001)).rejects.toThrow(/billing_adjust_too_large/);
    await expect(adjust(ws, -5_000_001)).rejects.toThrow(/billing_adjust_too_large/);
    await adjust(ws, 5_000_000);
    const irr = await makeWorkspace();
    await expect(adjust(irr, 10_000_000_001, { currency: 'IRR' })).rejects.toThrow(/billing_adjust_too_large/);
    expect(await adjust(irr, 10_000_000_000, { currency: 'IRR' })).toMatchObject({ balance_minor: 10_000_000_000 });
    const tr = await makeWorkspace();
    await expect(adjust(tr, 200_000_001, { currency: 'TRY' })).rejects.toThrow(/billing_adjust_too_large/);
    await adjust(tr, 200_000_000, { currency: 'TRY' });
    expect(await balanceOf(tr)).toBe(200_000_000);
  });

  it('M5 259\'s 6-argument call still resolves, with category other', async () => {
    const ws = await makeWorkspace();
    const r = await fn(`SELECT public.billing_account_admin_adjust($1, 300, 'USD', 'legacy call', NULL, $2) AS r`, [ws, randomUUID()]);
    expect(r).toMatchObject({ replayed: false, balance_minor: 300 });
    expect((await ledger(ws))[0].description).toEqual({ reason: 'legacy call', category: 'other' });
    // Named arguments, as the server's RPC client sends them.
    await q(
      `SELECT public.billing_account_admin_adjust(p_workspace_id => $1, p_amount_minor => -100, p_currency => 'USD',
         p_reason => 'named call', p_actor_id => NULL, p_command_key => $2, p_category => 'correction', p_expected_balance_minor => 300)`,
      [ws, randomUUID()],
    );
    expect(await balanceOf(ws)).toBe(200);
    expect(await q(`SELECT oid::regprocedure::text AS sig FROM pg_proc WHERE proname = 'billing_account_admin_adjust'`))
      .toEqual([{ sig: 'billing_account_admin_adjust(uuid,bigint,text,text,uuid,text,text,bigint)' }]);
  });

  // ─── Refund timestamps ───────────────────────────────────────────────────

  it('M6 each refund gets its own refunded_at; later updates keep it', async () => {
    const ws = await makeWorkspace();
    const pay = await settledPayment(ws, { provider: 'stamp', currency: 'USD', net: 1000, tax: 100 });
    await refund(pay, 'r1', 220);
    await new Promise((r) => setTimeout(r, 20));
    await refund(pay, 'r2', 330);
    const r1 = await refundedAt(pay, 'r1');
    const r2 = await refundedAt(pay, 'r2');
    expect(Date.parse(r1)).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(r2)).toBeGreaterThan(Date.parse(r1));
    expect(await refundsOf(pay)).toMatchObject({
      r1: { amount_minor: 220, credit_minor: 200 }, r2: { amount_minor: 330, credit_minor: 300 },
    });
    // The refund's ledger row and its stamp are the same moment, near enough.
    const led = await one(`SELECT created_at FROM public.billing_account_ledger WHERE idempotency_key = 'refund:stamp:r1'`);
    expect(Math.abs(Date.parse(r1) - (led.created_at as Date).getTime())).toBeLessThan(5_000);

    // Other updates, a merge into purpose_detail, a rewrite without the stamps.
    await q(`UPDATE public.billing_account_payments SET review = 'checked', updated_at = now() WHERE id = $1`, [pay]);
    await q(`UPDATE public.billing_account_payments SET purpose_detail = purpose_detail || '{"note": 1}' WHERE id = $1`, [pay]);
    await q(
      `UPDATE public.billing_account_payments
          SET purpose_detail = jsonb_set(purpose_detail, '{refunds}',
                (SELECT jsonb_object_agg(key, value - 'refunded_at') FROM jsonb_each(purpose_detail -> 'refunds')))
        WHERE id = $1`, [pay]);
    expect(await refundedAt(pay, 'r1')).toBe(r1);
    expect(await refundedAt(pay, 'r2')).toBe(r2);
    // A replayed refund changes nothing.
    expect(await refund(pay, 'r1', 220)).toMatchObject({ replayed: true });
    expect(await refundedAt(pay, 'r1')).toBe(r1);
    // A time written with the entry is kept.
    await q(
      `UPDATE public.billing_account_payments
          SET purpose_detail = jsonb_set(purpose_detail, '{refunds,r3}', '{"amount_minor": 1, "credit_minor": 1, "refunded_at": "2022-02-02T00:00:00+00:00"}')
        WHERE id = $1`, [pay]);
    expect(await refundedAt(pay, 'r3')).toBe('2022-02-02T00:00:00+00:00');
  });

  it('M7 the backfill took the ledger\'s time, else the payment\'s, and kept updated_at', async () => {
    const led = await one(`SELECT created_at FROM public.billing_account_ledger WHERE idempotency_key = 'refund:pre266:old1'`);
    const withLedger = await refundedAt(pre.ledgerPay, 'old1');
    expect(Date.parse(withLedger)).toBe((led.created_at as Date).getTime());
    // No ledger row (the balance was empty): the payment's last change.
    expect(await q(`SELECT 1 FROM public.billing_account_ledger WHERE idempotency_key = 'refund:pre266:old2'`)).toHaveLength(0);
    expect(Date.parse(await refundedAt(pre.noLedgerPay, 'old2'))).toBe(Date.parse('2020-01-01T00:00:00Z'));
    // Already stamped: untouched.
    expect(await refundedAt(pre.stampedPay, 'old3')).toBe('2021-05-05T05:05:05+00:00');
    const updated = await q(`SELECT updated_at FROM public.billing_account_payments WHERE id = ANY ($1::uuid[])`,
      [[pre.ledgerPay, pre.noLedgerPay, pre.stampedPay]]);
    for (const row of updated) expect((row.updated_at as Date).toISOString()).toBe('2020-01-01T00:00:00.000Z');
    // The rest of each entry is as the refund wrote it.
    expect(await refundsOf(pre.noLedgerPay)).toMatchObject({ old2: { amount_minor: 300, credit_minor: 300, shortfall_minor: 300 } });
  });

  // ─── Revenue ─────────────────────────────────────────────────────────────

  const revenue = (from: string, to: string, tz: string, provider: string) =>
    q(`SELECT day::text, metric, currency, provider, source, purpose, count::int, gross_minor::int AS gross,
              tax_minor::int AS tax, net_minor::int AS net
         FROM public.billing_admin_revenue_days($1, $2, $3) WHERE provider = $4
        ORDER BY day, metric, source, purpose`, [from, to, tz, provider]);

  it('M8 payments fall on their local day: both sides of a Tehran midnight', async () => {
    const ws = await makeWorkspace();
    // 23:30 and 00:15 in Tehran (UTC+3:30); the same UTC day.
    await rawPayment(ws, { provider: 'rv_tz', currency: 'IRR', net: 1_000_000, tax: 100_000, completedAt: '2025-03-20T20:00:00Z' });
    await rawPayment(ws, { provider: 'rv_tz', currency: 'IRR', net: 2_000_000, tax: 200_000, completedAt: '2025-03-20T20:45:00Z' });
    expect(await revenue('2025-03-19T00:00:00Z', '2025-03-23T00:00:00Z', 'Asia/Tehran', 'rv_tz')).toEqual([
      { day: '2025-03-20', metric: 'payment', currency: 'IRR', provider: 'rv_tz', source: 'checkout', purpose: 'topup', count: 1, gross: 1_100_000, tax: 100_000, net: 1_000_000 },
      { day: '2025-03-21', metric: 'payment', currency: 'IRR', provider: 'rv_tz', source: 'checkout', purpose: 'topup', count: 1, gross: 2_200_000, tax: 200_000, net: 2_000_000 },
    ]);
    expect(await revenue('2025-03-19T00:00:00Z', '2025-03-23T00:00:00Z', 'UTC', 'rv_tz')).toEqual([
      { day: '2025-03-20', metric: 'payment', currency: 'IRR', provider: 'rv_tz', source: 'checkout', purpose: 'topup', count: 2, gross: 3_300_000, tax: 300_000, net: 3_000_000 },
    ]);
    // The window is [from, to) on completed_at.
    expect(await revenue('2025-03-20T20:00:00.001Z', '2025-03-20T20:45:00Z', 'UTC', 'rv_tz')).toEqual([]);
    expect(await revenue('2025-03-20T20:00:00Z', '2025-03-20T20:45:00Z', 'UTC', 'rv_tz')).toHaveLength(1);
  });

  it('M8b only succeeded payments count; split by source and purpose; a card renewal\'s net and tax come from its row', async () => {
    const ws = await makeWorkspace();
    const at = '2025-04-10T12:00:00Z';
    await rawPayment(ws, { provider: 'rv_mix', net: 1000, completedAt: at });
    await rawPayment(ws, { provider: 'rv_mix', net: 2900, tax: 580, source: 'card_renewal', purpose: 'renewal', completedAt: at });
    await rawPayment(ws, { provider: 'rv_mix', net: 2900, tax: 0, source: 'card_renewal', purpose: 'renewal', completedAt: at });
    await rawPayment(ws, { provider: 'rv_mix', net: 500, purpose: 'ai_pack', completedAt: at });
    for (const status of ['pending', 'failed', 'canceled', 'expired']) {
      await rawPayment(ws, { provider: 'rv_mix', net: 9999, status, completedAt: at });
    }
    expect(await revenue('2025-04-01T00:00:00Z', '2025-05-01T00:00:00Z', 'UTC', 'rv_mix')).toEqual([
      { day: '2025-04-10', metric: 'payment', currency: 'USD', provider: 'rv_mix', source: 'card_renewal', purpose: 'renewal', count: 2, gross: 6380, tax: 580, net: 5800 },
      { day: '2025-04-10', metric: 'payment', currency: 'USD', provider: 'rv_mix', source: 'checkout', purpose: 'ai_pack', count: 1, gross: 500, tax: 0, net: 500 },
      { day: '2025-04-10', metric: 'payment', currency: 'USD', provider: 'rv_mix', source: 'checkout', purpose: 'topup', count: 1, gross: 1000, tax: 0, net: 1000 },
    ]);
  });

  it('M8c refunds land on their own day and currency, with their tax share', async () => {
    const ws = await makeWorkspace();
    const pay = await settledPayment(ws, { provider: 'rv_ref', currency: 'IRR', net: 1_000_000, tax: 100_000 });
    await q(`UPDATE public.billing_account_payments SET completed_at = '2025-06-01T10:00:00Z' WHERE id = $1`, [pay]);
    await refund(pay, 'rf1', 550_000);
    await refund(pay, 'rf2', 110_000);
    const day = String((await one(
      `SELECT (((purpose_detail -> 'refunds' -> 'rf1' ->> 'refunded_at')::timestamptz) AT TIME ZONE 'Asia/Tehran')::date::text AS d
         FROM public.billing_account_payments WHERE id = $1`, [pay])).d);
    const rows = await revenue('2025-05-01T00:00:00Z', new Date(Date.now() + 86_400_000).toISOString(), 'Asia/Tehran', 'rv_ref');
    expect(rows).toEqual([
      { day: '2025-06-01', metric: 'payment', currency: 'IRR', provider: 'rv_ref', source: 'checkout', purpose: 'topup', count: 1, gross: 1_100_000, tax: 100_000, net: 1_000_000 },
      { day, metric: 'refund', currency: 'IRR', provider: 'rv_ref', source: 'checkout', purpose: 'topup', count: 2, gross: 660_000, tax: 60_000, net: 600_000 },
    ]);
    // A window that ends before the refunds holds only the payment.
    expect(await revenue('2025-05-01T00:00:00Z', '2025-07-01T00:00:00Z', 'Asia/Tehran', 'rv_ref')).toHaveLength(1);
  });

  // ─── Balance movements and the outstanding balance ───────────────────────

  it('M9 balance movements per kind and currency, and what is owed per currency', async () => {
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    await adjust(a, 1000, { currency: 'GBP' });
    await adjust(a, -300, { currency: 'GBP', category: 'correction' });
    await adjust(a, 200, { currency: 'GBP' });
    await q(`SELECT public.billing_account_ensure($1, 'GBP')`, [b]);
    await q(`UPDATE public.billing_accounts SET next_period_prepaid_minor = 500 WHERE workspace_id = $1`, [b]);
    const to = new Date(Date.now() + 3_600_000).toISOString();

    const moves = await q(
      `SELECT currency, kind, sum(count)::int AS count, sum(in_minor)::int AS in_minor, sum(out_minor)::int AS out_minor
         FROM public.billing_admin_ledger_days($1, $2, 'UTC') WHERE currency = 'GBP'
        GROUP BY 1, 2 ORDER BY 2`, [from, to]);
    expect(moves).toEqual([
      { currency: 'GBP', kind: 'admin_credit', count: 2, in_minor: 1200, out_minor: 0 },
      { currency: 'GBP', kind: 'admin_debit', count: 1, in_minor: 0, out_minor: 300 },
    ]);
    const days = await q(`SELECT DISTINCT day::text AS d FROM public.billing_admin_ledger_days($1, $2, 'Asia/Tehran') WHERE currency = 'GBP'`, [from, to]);
    expect(days.length).toBeGreaterThanOrEqual(1);

    const owed = await q(
      `SELECT currency, accounts::int, positive_accounts::int, balance_minor::int, prepaid_minor::int
         FROM public.billing_admin_liability() WHERE currency = 'GBP'`);
    expect(owed).toEqual([{ currency: 'GBP', accounts: 2, positive_accounts: 1, balance_minor: 900, prepaid_minor: 500 }]);
    const all = await q(`SELECT currency FROM public.billing_admin_liability()`);
    expect(all.map((r) => r.currency)).toEqual([...all.map((r) => r.currency)].sort());
    expect(all.map((r) => r.currency)).toEqual(expect.arrayContaining(['GBP', 'USD', 'IRR', 'TRY']));
  });

  // ─── The accounts list ───────────────────────────────────────────────────

  describe('M10 the accounts list', () => {
    const T = `zq${randomUUID().slice(0, 6)}`;
    const EMAIL = `em${randomUUID().slice(0, 6)}`;
    const SLUG = `sl${randomUUID().slice(0, 6)}`;
    const ws: Record<'alpha' | 'beta' | 'gamma' | 'delta' | 'extra', string> = { alpha: '', beta: '', gamma: '', delta: '', extra: '' };
    let alphaOwner = '';

    beforeAll(async () => {
      const tick = () => new Promise((r) => setTimeout(r, 5));
      alphaOwner = await makeOwner(`${EMAIL}@example.test`);
      // Alpha: USD 5000, auto-renew, Pro due in 3 days, a live card, paid 2 days ago.
      ws.alpha = await makeWorkspace({ name: `${T} Alpha`, owner: alphaOwner });
      await adjust(ws.alpha, 5000);
      await q(`UPDATE public.billing_accounts SET auto_renew = true WHERE workspace_id = $1`, [ws.alpha]);
      await subscribe(ws.alpha, proId, { endsInDays: 3 });
      await q(`INSERT INTO public.billing_account_cards (workspace_id, provider, subscription_id, currency, status)
               VALUES ($1, 'paddle_sandbox', $2, 'USD', 'active')`, [ws.alpha, `sub_${randomUUID()}`]);
      await rawPayment(ws.alpha, { provider: 'acct', net: 5000, completedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() });
      await tick();
      // Beta: USD 0 with the next period prepaid, Pro due in 20 days, paid yesterday.
      ws.beta = await makeWorkspace({ name: `${T} Beta`, slug: `${SLUG}-beta` });
      await q(`SELECT public.billing_account_ensure($1, 'USD')`, [ws.beta]);
      await q(`UPDATE public.billing_accounts SET next_period_prepaid_minor = 2900 WHERE workspace_id = $1`, [ws.beta]);
      await subscribe(ws.beta, proId, { endsInDays: 20, interval: 'yearly' });
      await rawPayment(ws.beta, { provider: 'acct', net: 2900, completedAt: new Date(Date.now() - 86_400_000).toISOString() });
      await rawPayment(ws.beta, { provider: 'acct', net: 100, status: 'failed', completedAt: null });
      await tick();
      // Gamma: no account.
      ws.gamma = await makeWorkspace({ name: `${T} Gamma` });
      await tick();
      // Delta: TRY 100 on Free, whose period "ends" tomorrow (never due).
      ws.delta = await makeWorkspace({ name: `${T} Delta` });
      await adjust(ws.delta, 100, { currency: 'TRY' });
      await subscribe(ws.delta, freeId, { endsInDays: 1, interval: null });
      // Alpha's owner has another workspace, without an account and without the token.
      ws.extra = await makeWorkspace({ name: 'Elsewhere', owner: alphaOwner });
    });

    it('filters: with an account by default, all, positive balance, auto-renew, card, prepaid, due within 7 days, currency', async () => {
      const by = async (filter: string | null, currency: string | null = null) => {
        const r = await accounts({ search: T, filter, currency, sort: 'name_asc' });
        expect(r.total).toBe(r.items.length);
        return names(r);
      };
      expect(await by(null)).toEqual([`${T} Alpha`, `${T} Beta`, `${T} Delta`]);
      expect(await by('with_account')).toEqual([`${T} Alpha`, `${T} Beta`, `${T} Delta`]);
      expect(await by('all')).toEqual([`${T} Alpha`, `${T} Beta`, `${T} Delta`, `${T} Gamma`]);
      expect(await by('positive_balance')).toEqual([`${T} Alpha`, `${T} Delta`]);
      expect(await by('auto_renew')).toEqual([`${T} Alpha`]);
      expect(await by('card')).toEqual([`${T} Alpha`]);
      expect(await by('prepaid')).toEqual([`${T} Beta`]);
      expect(await by('due_7d')).toEqual([`${T} Alpha`]);
      expect(await by('all', 'TRY')).toEqual([`${T} Delta`]);
      expect(await by('all', 'usd')).toEqual([`${T} Alpha`, `${T} Beta`]);
    });

    it('an owner\'s workspaces, with or without an account', async () => {
      const r = await accounts({ filter: `owner:${alphaOwner}`, sort: 'name_asc' });
      expect(r.total).toBe(2);
      expect(names(r)).toEqual(['Elsewhere', `${T} Alpha`]);
      expect(r.items.map((i) => i.has_account)).toEqual([false, true]);
      await expect(accounts({ filter: 'owner:not-a-uuid' })).rejects.toThrow(/billing_admin_bad_filter/);
    });

    it('sorts, with stable ties', async () => {
      const by = async (sort: string) => names(await accounts({ search: T, filter: 'all', sort }));
      expect(await by('balance_desc')).toEqual([`${T} Alpha`, `${T} Delta`, `${T} Beta`, `${T} Gamma`]);
      expect(await by('period_end_asc')).toEqual([`${T} Delta`, `${T} Alpha`, `${T} Beta`, `${T} Gamma`]);
      expect((await by('last_payment_desc')).slice(0, 2)).toEqual([`${T} Beta`, `${T} Alpha`]);
      expect(await by('created_desc')).toEqual([`${T} Delta`, `${T} Gamma`, `${T} Beta`, `${T} Alpha`]);
      expect(await by('name_asc')).toEqual([`${T} Alpha`, `${T} Beta`, `${T} Delta`, `${T} Gamma`]);
      // The default is balance_desc.
      expect(names(await accounts({ search: T, filter: 'all' }))).toEqual(await by('balance_desc'));
    });

    it('searches name, slug, owner email (any case) and ids (exact); % and _ are literal', async () => {
      expect(names(await accounts({ search: T.toUpperCase(), filter: 'all', sort: 'name_asc' }))).toHaveLength(4);
      expect(names(await accounts({ search: SLUG, filter: 'all' }))).toEqual([`${T} Beta`]);
      expect(names(await accounts({ search: EMAIL.toUpperCase(), filter: 'all', sort: 'name_asc' }))).toEqual(['Elsewhere', `${T} Alpha`]);
      expect(names(await accounts({ search: ws.gamma, filter: 'all' }))).toEqual([`${T} Gamma`]);
      expect(names(await accounts({ search: ` ${ws.gamma.toUpperCase()} `, filter: 'all' }))).toEqual([`${T} Gamma`]);
      // Gamma has no account: the default filter hides it.
      expect((await accounts({ search: ws.gamma })).total).toBe(0);
      expect(names(await accounts({ search: alphaOwner, filter: 'all', sort: 'name_asc' }))).toEqual(['Elsewhere', `${T} Alpha`]);
      expect((await accounts({ search: `${T}%`, filter: 'all' })).total).toBe(0);
      expect((await accounts({ search: `${T.slice(0, 2)}_${T.slice(3)}`, filter: 'all' })).total).toBe(0);
    });

    it('pages with the total, clamps the page size', async () => {
      const p1 = await accounts({ search: T, filter: 'all', sort: 'name_asc', limit: 2, offset: 0 });
      const p2 = await accounts({ search: T, filter: 'all', sort: 'name_asc', limit: 2, offset: 2 });
      const p3 = await accounts({ search: T, filter: 'all', sort: 'name_asc', limit: 2, offset: 4 });
      expect([p1.total, p2.total, p3.total]).toEqual([4, 4, 4]);
      expect([...names(p1), ...names(p2)]).toEqual([`${T} Alpha`, `${T} Beta`, `${T} Delta`, `${T} Gamma`]);
      expect(p3.items).toEqual([]);
      expect((await accounts({ search: T, filter: 'all', limit: 0 })).items).toHaveLength(1);
      expect((await accounts({ search: T, filter: 'all', limit: -5, offset: -3 })).items).toHaveLength(1);
      expect((await accounts({ filter: 'all', limit: 1000 })).items.length).toBeLessThanOrEqual(100);
    });

    it('an item carries the account, the plan, the card and the last payment', async () => {
      const [alpha] = (await accounts({ search: ws.alpha })).items;
      expect(alpha).toMatchObject({
        workspace_id: ws.alpha, name: `${T} Alpha`, owner_id: alphaOwner, owner_email: `${EMAIL}@example.test`,
        workspace_status: 'active', has_account: true, currency: 'USD', balance_minor: 5000, auto_renew: true,
        next_period_prepaid_minor: null, scheduled_plan_id: null, plan_id: proId, plan_name: 'Pro', is_free: false,
        status: 'active', billing_interval: 'monthly', card_status: 'active', ledger_count: 1,
      });
      expect(Date.parse(String(alpha.current_period_end))).toBeGreaterThan(Date.now() + 2 * 86_400_000);
      expect(Date.parse(String(alpha.last_payment_at))).toBeLessThan(Date.now() - 86_400_000);
      expect(alpha.account_created_at).toEqual(expect.any(String));
      // Beta's failed attempt is not its last payment.
      const [beta] = (await accounts({ search: ws.beta })).items;
      expect(Date.parse(String(beta.last_payment_at))).toBeLessThan(Date.now() - 86_000_000);
      expect(beta).toMatchObject({ next_period_prepaid_minor: 2900, billing_interval: 'yearly', card_status: null, ledger_count: 0 });
      const [gamma] = (await accounts({ search: ws.gamma, filter: 'all' })).items;
      expect(gamma).toMatchObject({
        has_account: false, currency: null, balance_minor: null, plan_id: null, card_status: null, last_payment_at: null, ledger_count: 0,
      });
    });

    it('refuses an unknown filter, sort or currency', async () => {
      await expect(accounts({ filter: 'everything' })).rejects.toThrow(/billing_admin_bad_filter/);
      await expect(accounts({ sort: 'random' })).rejects.toThrow(/billing_admin_bad_sort/);
      await expect(accounts({ currency: 'US' })).rejects.toThrow(/billing_admin_bad_currency/);
    });
  });

  // ─── An account's payments ───────────────────────────────────────────────

  it('M11 an account\'s payments: every status, newest first, refunds with their time, paged', async () => {
    const ws = await makeWorkspace();
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    await rawPayment(ws, { provider: 'list', net: 100, status: 'expired', completedAt: null, createdAt: day(5) });
    await rawPayment(ws, { provider: 'list', net: 100, status: 'canceled', completedAt: null, createdAt: day(4) });
    await rawPayment(ws, { provider: 'list', net: 100, status: 'failed', completedAt: null, createdAt: day(3) });
    await rawPayment(ws, { provider: 'list', net: 100, status: 'pending', completedAt: null, createdAt: day(2) });
    const paid = await settledPayment(ws, { provider: 'list', currency: 'USD', net: 1000, tax: 100 });
    await refund(paid, 'a', 110);
    await new Promise((r) => setTimeout(r, 10));
    await refund(paid, 'b', 220);

    const all = await fn(`SELECT public.billing_admin_account_payments($1, 25, 0) AS r`, [ws]) as { total: number; items: Row[] };
    expect(all.total).toBe(5);
    expect(all.items.map((i) => i.status)).toEqual(['succeeded', 'pending', 'failed', 'canceled', 'expired']);
    const top = all.items[0];
    expect(top).toMatchObject({
      id: paid, provider: 'list', source: 'checkout', purpose: 'topup', status: 'succeeded', currency: 'USD',
      amount_minor: 1100, net_minor: 1000, tax_minor: 100, refunded_minor: 300, review: null, card_id: null,
    });
    expect(top.ledger_id).toEqual(expect.any(String));
    expect(top.completed_at).toEqual(expect.any(String));
    const refunds = top.refunds as Row[];
    expect(refunds.map((r) => [r.refund_id, r.amount_minor, r.credit_minor, r.shortfall_minor])).toEqual([['a', 110, 100, 0], ['b', 220, 200, 0]]);
    expect(Date.parse(String(refunds[1].refunded_at))).toBeGreaterThan(Date.parse(String(refunds[0].refunded_at)));
    expect(all.items[1].refunds).toEqual([]);

    const page = await fn(`SELECT public.billing_admin_account_payments($1, 2, 2) AS r`, [ws]) as { total: number; items: Row[] };
    expect(page.total).toBe(5);
    expect(page.items.map((i) => i.status)).toEqual(['failed', 'canceled']);
    expect(await fn(`SELECT public.billing_admin_account_payments($1, 25, 0) AS r`, [randomUUID()])).toEqual({ total: 0, items: [] });
  });

  // ─── Access and re-run ───────────────────────────────────────────────────

  const FUNCTIONS = [
    'public.billing_account_admin_adjust(uuid, bigint, text, text, uuid, text, text, bigint)',
    'public.billing_account_payments_stamp_refunds()',
    'public.billing_admin_accounts(text, text, text, text, integer, integer)',
    'public.billing_admin_account_payments(uuid, integer, integer)',
    'public.billing_admin_revenue_days(timestamptz, timestamptz, text)',
    'public.billing_admin_ledger_days(timestamptz, timestamptz, text)',
    'public.billing_admin_liability()',
  ];

  it('M12 only service_role reaches the functions; every one pins search_path', async () => {
    for (const f of FUNCTIONS) {
      const row = await one(
        `SELECT has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS auth,
                has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS service,
                p.proconfig, p.prosecdef
           FROM pg_proc p WHERE p.oid = $1::regprocedure`, [f]);
      expect({ f, anon: row.anon, auth: row.auth, service: row.service }).toEqual({ f, anon: false, auth: false, service: true });
      expect((row.proconfig as string[]).join(',')).toMatch(/search_path=/);
      if (!f.includes('stamp_refunds')) expect(row.prosecdef).toBe(true);
    }
    const ws = await makeWorkspace();
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE authenticated');
      await expect(db.query(`SELECT public.billing_account_admin_adjust($1, 100, 'USD', 'sneaky', NULL, 'k-auth')`, [ws]))
        .rejects.toThrow(/permission denied/);
    } finally {
      await db.query('ROLLBACK');
    }
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE authenticated');
      await expect(db.query(`SELECT public.billing_admin_accounts()`)).rejects.toThrow(/permission denied/);
    } finally {
      await db.query('ROLLBACK');
    }
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE service_role');
      const r = await db.query(`SELECT public.billing_account_admin_adjust($1, 100, 'USD', 'as the server', NULL, $2, 'test', 0) AS r`, [ws, randomUUID()]);
      expect(r.rows[0].r).toMatchObject({ replayed: false, balance_minor: 100 });
      await db.query(`SELECT public.billing_admin_accounts($1)`, [ws]);
      await db.query(`SELECT * FROM public.billing_admin_revenue_days(now() - interval '1 day', now(), 'Asia/Tehran')`);
      await db.query(`SELECT * FROM public.billing_admin_ledger_days(now() - interval '1 day', now(), 'UTC')`);
      await db.query(`SELECT * FROM public.billing_admin_liability()`);
      await db.query(`SELECT public.billing_admin_account_payments($1, 10, 0)`, [ws]);
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('M12b 266 runs twice: one adjust function, one trigger, stamps unchanged', async () => {
    const before = await refundedAt(pre.ledgerPay, 'old1');
    await applyMigrationSql(db, SQL_266);
    expect(await q(`SELECT 1 FROM pg_proc WHERE proname = 'billing_account_admin_adjust'`)).toHaveLength(1);
    expect(await q(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.billing_account_payments'::regclass AND tgname = 'trg_billing_account_payments_stamp_refunds'`,
    )).toHaveLength(1);
    expect(await refundedAt(pre.ledgerPay, 'old1')).toBe(before);
    expect(await q(
      `SELECT indexname FROM pg_indexes WHERE indexname IN ('billing_account_payments_succeeded_idx', 'billing_account_ledger_created_idx') ORDER BY 1`,
    )).toEqual([{ indexname: 'billing_account_ledger_created_idx' }, { indexname: 'billing_account_payments_succeeded_idx' }]);
  });
});
