// @vitest-environment node
/**
 * 264 — AI credit packs bought from the balance or paid online, against real
 * PostgreSQL built by the whole migration chain (docs/billing/SIMPLE_BILLING.md,
 * phase 5).
 *
 *   A1  a pack from the balance: an `ai_pack` ledger row (−price, with the
 *       rate and the wallet amount), a PURCHASED lot that never expires, the
 *       AI ledger PURCHASE and its command;
 *   A2  a replay returns the same lot, also after the pack was edited or
 *       removed;
 *   A3  the same key on another workspace is refused;
 *   A4  too little balance writes nothing;
 *   A5  a changed price, an inactive / missing / malformed pack, a currency
 *       without packs are refused;
 *   A6  the credit is converted with the meter's rates (USD→IRR, TRY→USD ×
 *       USD→IRR, IRR 1); no rate: refused, nothing debited;
 *   A7  purchased credit survives every plan path (month grant, upgrade,
 *       downgrade to Free at the due moment, end of trial, lot expiry), and
 *       plan credit is spent first;
 *   A8  a payment for a pack is credited with its receipt and spent on it; a
 *       pack whose price or credit changed meanwhile (A8b), or one
 *       removed, leaves the money in the balance;
 *   A9  a refund reverses the pack's unused credit first (capped, never what
 *       is reserved), returns its price share, and takes the refund;
 *   A10 only service_role reaches the functions; every one pins search_path;
 *   A11 the ledger accepts `ai_pack_return` and stays append-only; 264 runs
 *       twice; the email exists for both editions in fa/en/tr;
 *   A12 the purge removes a workspace with a pack.
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
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the AI credit pack SQL tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `simplebilling264_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '264_simple_billing_ai_packs.sql';

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];
const fn = async (sql: string, params: unknown[] = []): Promise<Row> => (await one(sql, params)).r as Row;

const PRO = { monthly: 2900, yearly: 29000 };
const BIZ = { monthly: 9900, yearly: 99000 };
const USD_IRR = 600_000;
let proId = '';
let bizId = '';
let freeId = '';

/** The international packs most tests use: $5 → $5, $20 → $22. */
const USD_PACKS = [
  { id: 's', price_minor: 500, credit_minor: 500, label: { en: 'Small', fa: 'کوچک' } },
  { id: 'm', price_minor: 2000, credit_minor: 2200 },
];

async function makeWorkspace(): Promise<string> {
  const id = randomUUID();
  const owner = randomUUID();
  await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
  await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
  return id;
}

async function makePlan(slug: string, usd: { monthly: number; yearly: number }, aiIrr: number): Promise<string> {
  const row = await one(
    `INSERT INTO public.billing_plans (name, slug, prices, limits, is_active, is_free, is_hidden, sort_order)
     VALUES ($1, $2, $3, $4, true, false, false, 10) RETURNING id`,
    [slug, slug, JSON.stringify({ USD: usd }), JSON.stringify({ included_ai_allowance_irr: aiIrr, max_agents: 5 })],
  );
  return String(row.id);
}

const setPacks = async (edition: 'iran' | 'international', packs: Row) =>
  q(
    `INSERT INTO public.billing_settings (edition, ai_packs) VALUES ($1, $2)
     ON CONFLICT (edition) DO UPDATE SET ai_packs = EXCLUDED.ai_packs`,
    [edition, JSON.stringify(packs)],
  );
const resetPacks = () => setPacks('international', { USD: USD_PACKS });

let keySeq = 0;
const credit = async (ws: string, amount: number, currency = 'USD') =>
  q(`SELECT public.billing_account_admin_adjust($1, $2, $3, 'test credit', NULL, $4)`, [ws, amount, currency, `p5-${++keySeq}`]);
const balanceOf = async (ws: string): Promise<number> =>
  Number((await one(`SELECT balance_minor FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).balance_minor);
const ledger = (ws: string) =>
  q(`SELECT id, kind, amount_minor::int AS amount, balance_after::int AS balance_after, description
       FROM public.billing_account_ledger WHERE workspace_id = $1 ORDER BY created_at, id`, [ws]);
const buy = (ws: string, pack: string, expected: number | null = null, key: string = randomUUID()) =>
  fn(`SELECT public.billing_account_buy_ai_pack($1, $2, $3, $4, NULL) AS r`, [ws, pack, expected, `${ws}:${key}`]);
const lot = (id: unknown) =>
  one(`SELECT source_type, original_amount::float AS original, remaining_amount::float AS remaining,
              reserved_amount::float AS reserved, expires_at, state
         FROM public.workspace_ai_balance_lots WHERE id = $1`, [id]);
const purchasedLots = (ws: string) =>
  q(`SELECT id, original_amount::float AS original, remaining_amount::float AS remaining, expires_at, state
       FROM public.workspace_ai_balance_lots WHERE workspace_id = $1 AND source_type = 'PURCHASED' ORDER BY created_at`, [ws]);
const walletAvailable = async (ws: string): Promise<number> =>
  Number((await one(`SELECT available_amount::float AS a FROM public.workspace_ai_wallets WHERE workspace_id = $1`, [ws])).a);
const countRows = async (sql: string, params: unknown[]): Promise<number> => Number((await one(sql, params)).n);

/** A gateway payment for a pack, verified and settled. */
async function payOnline(ws: string, detail: Row, net: number, tax = 0): Promise<{ id: string; settled: Row }> {
  const p = await one(
    `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, tax_minor, purpose, purpose_detail)
     VALUES ($1, 'paddle_sandbox', 'USD', $2, $3, $4, 'ai_pack', $5) RETURNING id`,
    [ws, net + tax, net, tax, JSON.stringify(detail)],
  );
  await q(`SELECT public.billing_account_record_verification($1, $2, 'USD', $3)`, [p.id, net + tax, `txn_${randomUUID()}`]);
  const settled = await fn(`SELECT public.billing_account_settle_payment($1) AS r`, [p.id]);
  return { id: String(p.id), settled };
}
const packDetail = (id: string, price: number, creditMinor: number) =>
  ({ pack_id: id, price_minor: price, credit_minor: creditMinor, credit_currency: 'USD', label: null });
const refund = (pay: string, refundId: string, amount: number) =>
  fn(`SELECT public.billing_account_refund_payment($1, $2, $3) AS r`, [pay, refundId, amount]);

suite('264 — AI credit packs (real PostgreSQL, whole chain)', () => {
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
    await resetPacks();
    await q(`SELECT public.ai_publish_exchange_rate('USD', 'IRR', $1)`, [USD_IRR]);
    proId = await makePlan('t5-pro', PRO, 300_000);
    bizId = await makePlan('t5-biz', BIZ, 600_000);
    freeId = String((await one(`SELECT id FROM public.billing_plans WHERE slug = 'free'`)).id);
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('A1 a pack from the balance: the ledger row, a PURCHASED lot that never expires, the AI ledger and its command', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 700);
    const r = await buy(ws, 's', 500);
    expect(r).toMatchObject({
      action: 'ai_pack', replayed: false, pack_id: 's', price_minor: 500, credit_minor: 500,
      currency: 'USD', wallet_amount: 3_000_000, balance_minor: 200,
    });
    expect(await balanceOf(ws)).toBe(200);

    const rows = await ledger(ws);
    expect(rows.map((l) => [l.kind, l.amount, l.balance_after])).toEqual([['admin_credit', 700, 700], ['ai_pack', -500, 200]]);
    const pack = rows[1];
    expect(pack.id).toBe(r.pack_ledger_id);
    expect(pack.description).toEqual({
      pack_id: 's', credit_minor: 500, credit_currency: 'USD', label: { en: 'Small', fa: 'کوچک' },
      wallet_amount: 3_000_000, wallet_unit: 'IRR', fx_rate: USD_IRR,
    });
    const row = await one(`SELECT plan_id, period_start, receipt_number, idempotency_key FROM public.billing_account_ledger WHERE id = $1`, [pack.id]);
    expect(row.plan_id).toBeNull();
    expect(row.period_start).toBeNull();
    expect(row.receipt_number).toBeNull(); // from the balance: no receipt
    expect(String(row.idempotency_key)).toMatch(new RegExp(`^ai_pack:${ws}:`));

    expect(await lot(r.lot_id)).toMatchObject({
      source_type: 'PURCHASED', original: 3_000_000, remaining: 3_000_000, reserved: 0, expires_at: null, state: 'ACTIVE',
    });
    expect(await q(
      `SELECT l.entry_type, l.amount::float AS amount, l.reason, a.lot_id
         FROM public.workspace_ai_ledger l JOIN public.workspace_ai_ledger_allocations a ON a.ledger_entry_id = l.id
        WHERE l.workspace_id = $1`, [ws],
    )).toEqual([{ entry_type: 'PURCHASE', amount: 3_000_000, reason: 'ai_pack', lot_id: r.lot_id }]);
    expect(await one(
      `SELECT command_type, result_ref FROM public.ai_billing_commands WHERE idempotency_key = $1`, [`ai_pack_lot:${pack.id}`],
    )).toEqual({ command_type: 'PURCHASE', result_ref: r.lot_id });
    expect(await walletAvailable(ws)).toBe(3_000_000);
  });

  it('A2 a replay returns the same lot, also after the pack was edited or removed', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 5000);
    const key = randomUUID();
    const first = await buy(ws, 'm', 2000, key);
    expect(first).toMatchObject({ replayed: false, wallet_amount: 13_200_000, balance_minor: 3000 });

    const again = await buy(ws, 'm', 2000, key);
    expect(again).toMatchObject({
      action: 'ai_pack', replayed: true, pack_ledger_id: first.pack_ledger_id, lot_id: first.lot_id,
      pack_id: 'm', price_minor: 2000, credit_minor: 2200, currency: 'USD', wallet_amount: 13_200_000, balance_minor: 3000,
    });

    try {
      await setPacks('international', { USD: [{ id: 'm', price_minor: 2500, credit_minor: 2600 }] });
      expect(await buy(ws, 'm', 2000, key)).toMatchObject({ replayed: true, lot_id: first.lot_id, price_minor: 2000 });
      await setPacks('international', {});
      expect(await buy(ws, 'm', null, key)).toMatchObject({ replayed: true, lot_id: first.lot_id });
    } finally {
      await resetPacks();
    }
    expect(await balanceOf(ws)).toBe(3000);
    expect(await purchasedLots(ws)).toHaveLength(1);
    expect((await ledger(ws)).filter((l) => l.kind === 'ai_pack')).toHaveLength(1);
  });

  it('A3 the same key on another workspace is refused', async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    await credit(a, 500);
    await credit(b, 500);
    const key = `shared:${randomUUID()}`;
    await fn(`SELECT public.billing_account_buy_ai_pack($1, 's', 500, $2, NULL) AS r`, [a, key]);
    await expect(fn(`SELECT public.billing_account_buy_ai_pack($1, 's', 500, $2, NULL) AS r`, [b, key]))
      .rejects.toThrow(/billing_idempotency_conflict/);
    expect(await balanceOf(b)).toBe(500);
    expect(await purchasedLots(b)).toHaveLength(0);
    // A key is required.
    await expect(fn(`SELECT public.billing_account_buy_ai_pack($1, 's', 500, '', NULL) AS r`, [b]))
      .rejects.toThrow(/billing_key_required/);
  });

  it('A4 too little balance writes no ledger row and no lot', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 499);
    await expect(buy(ws, 's', 500)).rejects.toThrow(/billing_insufficient_balance/);
    expect(await balanceOf(ws)).toBe(499);
    expect((await ledger(ws)).map((l) => l.kind)).toEqual(['admin_credit']);
    expect(await purchasedLots(ws)).toHaveLength(0);
    expect(await countRows(`SELECT count(*) AS n FROM public.workspace_ai_ledger WHERE workspace_id = $1`, [ws])).toBe(0);
  });

  it('A5 a changed price, an inactive, missing or malformed pack, or a currency without packs is refused', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 10_000);
    await expect(buy(ws, 's', 400)).rejects.toThrow(/billing_quote_changed/);
    await expect(buy(ws, 'nope', null)).rejects.toThrow(/billing_ai_pack_not_available/);
    try {
      await setPacks('international', {
        USD: [
          { id: 'off', price_minor: 500, credit_minor: 500, active: false },
          { id: 'str', price_minor: '500', credit_minor: 500 },
          { id: 'frac', price_minor: 5.5, credit_minor: 500 },
          { id: 'neg', price_minor: -500, credit_minor: 500 },
          { id: 'zero', price_minor: 500, credit_minor: 0 },
          { id: 'nocredit', price_minor: 500 },
          'not-an-object',
          { id: 'on', price_minor: 500, credit_minor: 500, active: true },
        ],
        TRY: { id: 'x', price_minor: 500, credit_minor: 500 }, // not a list
      });
      for (const id of ['off', 'str', 'frac', 'neg', 'zero', 'nocredit']) {
        await expect(buy(ws, id), id).rejects.toThrow(/billing_ai_pack_not_available/);
      }
      expect(await buy(ws, 'on', 500)).toMatchObject({ replayed: false, pack_id: 'on' });
      expect(await one(`SELECT public.billing_ai_pack_find('international', 'TRY', 'x') AS p`)).toEqual({ p: null });
      expect(await one(`SELECT public.billing_ai_pack_find('iran', 'USD', 'on') AS p`)).toEqual({ p: null });
      expect((await one(`SELECT public.billing_ai_pack_find('international', 'usd', 'on') AS p`)).p).toMatchObject({ id: 'on' });
    } finally {
      await resetPacks();
    }
    // A TRY account in the international edition with no TRY packs.
    const tr = await makeWorkspace();
    await credit(tr, 10_000, 'TRY');
    await expect(buy(tr, 's')).rejects.toThrow(/billing_ai_pack_not_available/);
    expect(await balanceOf(ws)).toBe(9500);
  });

  it('A6 the credit is converted with the meter\'s rates; no rate: refused and nothing debited', async () => {
    expect(Number((await one(`SELECT public.billing_ai_wallet_rate('USD') AS r`)).r)).toBe(USD_IRR);
    expect(Number((await one(`SELECT public.billing_ai_wallet_rate('irr') AS r`)).r)).toBe(1);
    expect((await one(`SELECT public.billing_ai_wallet_rate('EUR') AS r`)).r).toBeNull();
    expect(await one(`SELECT public.billing_currency_exponent('IRR') AS i, public.billing_currency_exponent('try') AS t`))
      .toEqual({ i: 0, t: 2 });

    try {
      // TRY through TRY→USD × USD→IRR: 200.00 TL of credit at 0.03 = 3,600,000 Rial.
      await setPacks('international', { USD: USD_PACKS, TRY: [{ id: 't', price_minor: 20_000, credit_minor: 20_000 }], EUR: [{ id: 'e', price_minor: 500, credit_minor: 500 }] });
      const tr = await makeWorkspace();
      await credit(tr, 20_000, 'TRY');
      await expect(buy(tr, 't')).rejects.toThrow(/billing_ai_fx_unavailable/);
      await q(`SELECT public.ai_publish_exchange_rate('TRY', 'USD', 0.03)`);
      expect(await buy(tr, 't', 20_000)).toMatchObject({ currency: 'TRY', wallet_amount: 3_600_000, balance_minor: 0 });

      // A direct TRY→IRR rate wins over the cross rate.
      await q(`SELECT public.ai_publish_exchange_rate('TRY', 'IRR', 20000)`);
      expect(Number((await one(`SELECT public.billing_ai_wallet_rate('TRY') AS r`)).r)).toBe(20_000);

      // No rate at all: nothing is debited.
      const eu = await makeWorkspace();
      await credit(eu, 1000, 'EUR');
      await expect(buy(eu, 'e', 500)).rejects.toThrow(/billing_ai_fx_unavailable/);
      expect(await balanceOf(eu)).toBe(1000);
      expect(await purchasedLots(eu)).toHaveLength(0);
    } finally {
      await resetPacks();
    }

    // Iran: IRR at 1, packs from the iran row.
    await db.query(`UPDATE public.platform_settings SET region_mode = 'iran'`);
    try {
      await setPacks('iran', { IRR: [{ id: 'i', price_minor: 2_000_000, credit_minor: 2_500_000, label: { fa: 'بسته‌ی کوچک' } }] });
      const ir = await makeWorkspace();
      await credit(ir, 2_000_000, 'IRR');
      expect(await buy(ir, 'i', 2_000_000)).toMatchObject({ currency: 'IRR', wallet_amount: 2_500_000, balance_minor: 0 });
      expect((await purchasedLots(ir))[0]).toMatchObject({ original: 2_500_000, expires_at: null });
      // The international packs are not offered in Iran.
      const usd = await makeWorkspace();
      await credit(usd, 500, 'USD');
      await expect(buy(usd, 's', 500)).rejects.toThrow(/billing_ai_pack_not_available/);
    } finally {
      await db.query(`UPDATE public.platform_settings SET region_mode = 'multi'`);
    }
  });

  it('A7 purchased credit survives the plan paths, and plan credit is spent first', async () => {
    const ws = await makeWorkspace();
    await credit(ws, PRO.monthly + (BIZ.monthly - PRO.monthly) + 500);
    await fn(`SELECT public.billing_account_purchase_plan($1, $2, 'monthly', $3) AS r`, [ws, proId, randomUUID()]);
    const bought = await buy(ws, 's', 500);
    const snapshot = async () => {
      const l = await lot(bought.lot_id);
      return { remaining: l.remaining, reserved: l.reserved, original: l.original, expires_at: l.expires_at, state: l.state };
    };
    const untouched = { remaining: 3_000_000, reserved: 0, original: 3_000_000, expires_at: null, state: 'ACTIVE' };
    expect(await snapshot()).toEqual(untouched);

    // ai_reserve draws the plan lot (it expires) before the purchased one.
    const res = await fn(`SELECT public.ai_reserve($1, NULL, 100000, $2) AS r`, [ws, `res-${randomUUID()}`]);
    const drawn = await q(
      `SELECT l.source_type, a.amount::float AS amount FROM public.workspace_ai_reservation_allocations a
         JOIN public.workspace_ai_balance_lots l ON l.id = a.lot_id WHERE a.reservation_id = $1`, [res.reservation_id]);
    expect(drawn).toEqual([{ source_type: 'PLAN_ALLOWANCE', amount: 100_000 }]);
    // More than the plan lot holds: the rest comes from the purchased lot.
    const res2 = await fn(`SELECT public.ai_reserve($1, NULL, 250000, $2) AS r`, [ws, `res-${randomUUID()}`]);
    const drawn2 = await q(
      `SELECT l.source_type, a.amount::float AS amount FROM public.workspace_ai_reservation_allocations a
         JOIN public.workspace_ai_balance_lots l ON l.id = a.lot_id WHERE a.reservation_id = $1 ORDER BY a.created_at, l.source_type`,
      [res2.reservation_id]);
    expect(drawn2).toEqual([{ source_type: 'PLAN_ALLOWANCE', amount: 200_000 }, { source_type: 'PURCHASED', amount: 50_000 }]);
    await q(`SELECT public.ai_release_reservation($1)`, [res.reservation_id]);
    await q(`SELECT public.ai_release_reservation($1)`, [res2.reservation_id]);
    expect(await snapshot()).toEqual(untouched);

    // An upgrade (its AI credit difference) leaves it alone.
    expect(await fn(`SELECT public.billing_account_upgrade($1, $2) AS r`, [ws, bizId])).toMatchObject({ action: 'upgraded' });
    expect(await snapshot()).toEqual(untouched);

    // The next month's grant, and the job's.
    await q(
      `SELECT public.billing_account_grant_month($1, $2, now() - interval '40 days', now() + interval '20 days')`, [ws, bizId]);
    await q(`SELECT public.billing_account_grant_due_allowances()`);
    expect(await snapshot()).toEqual(untouched);

    // A downgrade to Free at the due moment.
    await fn(`SELECT public.billing_account_schedule_change($1, $2, NULL) AS r`, [ws, freeId]);
    await q(
      `UPDATE public.workspace_subscriptions
          SET current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 hour'
        WHERE workspace_id = $1`, [ws]);
    await fn(`SELECT public.billing_account_process_due($1) AS r`, [ws]);
    expect((await one(`SELECT status FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws])).status).toBe('expired');
    expect(await snapshot()).toEqual(untouched);

    // The end of a trial.
    const trial = String((await one(`SELECT id FROM public.billing_plans WHERE slug = 'trial'`)).id);
    await q(
      `UPDATE public.workspace_subscriptions
          SET plan_id = $2, status = 'trialing', trial_end = now() - interval '1 minute',
              current_period_start = now() - interval '7 days', current_period_end = now() - interval '1 minute'
        WHERE workspace_id = $1`, [ws, trial]);
    expect((await one(`SELECT public.billing_account_end_trial($1) AS ended`, [ws])).ended).toBe(true);
    expect(await snapshot()).toEqual(untouched);

    // Every plan lot runs out: the expiry job leaves the purchased lot.
    await q(
      `UPDATE public.workspace_ai_balance_lots SET expires_at = now() - interval '1 second'
        WHERE workspace_id = $1 AND source_type = 'PLAN_ALLOWANCE'`, [ws]);
    await q(`SELECT public.ai_expire_lots()`);
    expect(await countRows(
      `SELECT count(*) AS n FROM public.workspace_ai_balance_lots
        WHERE workspace_id = $1 AND source_type = 'PLAN_ALLOWANCE' AND state IN ('ACTIVE', 'EXPIRING')`, [ws])).toBe(0);
    expect(await snapshot()).toEqual(untouched);
    expect(await walletAvailable(ws)).toBe(3_000_000);
  });

  it('A8 a payment for a pack is credited with its receipt and spent on it; a changed pack leaves the money', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 200);
    // The shortfall (300) plus VAT is paid; the pack is bought in the same transaction.
    const { id, settled } = await payOnline(ws, packDetail('s', 500, 500), 300, 30);
    expect(settled).toMatchObject({ replayed: false, purpose: 'ai_pack', balance_minor: 0 });
    expect(settled.purpose_result).toMatchObject({ action: 'ai_pack', replayed: false, price_minor: 500, wallet_amount: 3_000_000 });
    const rows = await ledger(ws);
    expect(rows.map((l) => [l.kind, l.amount, l.balance_after])).toEqual([
      ['admin_credit', 200, 200], ['topup', 300, 500], ['ai_pack', -500, 0],
    ]);
    const receipt = await one(
      `SELECT receipt_number, tax_minor::int AS tax, description FROM public.billing_account_ledger
        WHERE workspace_id = $1 AND kind = 'topup'`, [ws]);
    expect(receipt.receipt_number).toBeTruthy();
    expect(receipt.tax).toBe(30);
    expect(receipt.description).toMatchObject({ purpose: 'ai_pack', pack_id: 's', price_minor: 500 });
    const pay = await one(`SELECT status, purpose_result FROM public.billing_account_payments WHERE id = $1`, [id]);
    expect(pay.status).toBe('succeeded');
    expect(pay.purpose_result).toMatchObject({ action: 'ai_pack', pack_ledger_id: rows[2].id });
    expect(String(rows[2].id)).toBe(String((settled.purpose_result as Row).pack_ledger_id));
    expect(await one(`SELECT idempotency_key FROM public.billing_account_ledger WHERE id = $1`, [rows[2].id]))
      .toEqual({ idempotency_key: `ai_pack:payment:${id}` });
    expect(await purchasedLots(ws)).toHaveLength(1);

    // A settle replay does nothing.
    expect(await fn(`SELECT public.billing_account_settle_payment($1) AS r`, [id])).toMatchObject({ replayed: true });
    expect(await ledger(ws)).toHaveLength(3);
    expect(await purchasedLots(ws)).toHaveLength(1);

    // The pack's price changed meanwhile: the money stays in the balance.
    try {
      await setPacks('international', { USD: [{ id: 's', price_minor: 600, credit_minor: 600 }] });
      const changed = await payOnline(ws, packDetail('s', 500, 500), 500);
      expect(String((changed.settled.purpose_result as Row).error)).toMatch(/billing_quote_changed/);
      expect(await balanceOf(ws)).toBe(500);
      // Removed: the same.
      await setPacks('international', {});
      const removed = await payOnline(ws, packDetail('s', 500, 500), 500);
      expect(String((removed.settled.purpose_result as Row).error)).toMatch(/billing_ai_pack_not_available/);
      expect(await balanceOf(ws)).toBe(1000);
    } finally {
      await resetPacks();
    }
    expect((await ledger(ws)).filter((l) => l.kind === 'ai_pack')).toHaveLength(1);
    expect(await purchasedLots(ws)).toHaveLength(1);
  });

  it('A8b a pack paid online whose credit changed (same price) is not bought with less credit; the money stays', async () => {
    const ws = await makeWorkspace();
    try {
      await setPacks('international', { USD: [{ id: 's', price_minor: 500, credit_minor: 400 }] });
      const { settled } = await payOnline(ws, packDetail('s', 500, 500), 500);
      expect(String((settled.purpose_result as Row).error)).toMatch(/billing_quote_changed/);
      expect(await balanceOf(ws)).toBe(500);
      expect(await purchasedLots(ws)).toHaveLength(0);
      // The credit the checkout showed: bought as usual.
      await setPacks('international', { USD: [{ id: 's', price_minor: 500, credit_minor: 500 }] });
      const same = await payOnline(ws, packDetail('s', 500, 500), 500);
      expect(same.settled.purpose_result).toMatchObject({ action: 'ai_pack', credit_minor: 500, wallet_amount: 3_000_000 });
    } finally {
      await resetPacks();
    }
  });

  it('A9 a refund reverses the pack first: unused credit back, price share returned, capped, never what is reserved', async () => {
    // Full refund of an unused pack bought online.
    {
      const ws = await makeWorkspace();
      const { id, settled } = await payOnline(ws, packDetail('s', 500, 500), 500);
      const lotId = (settled.purpose_result as Row).lot_id;
      const r = await refund(id, 'rf_full', 500);
      expect(r).toMatchObject({ replayed: false, debited_minor: 500, shortfall_minor: 0, pack_returned_minor: 500, pack_reclaimed_wallet: 3_000_000 });
      expect((await ledger(ws)).map((l) => [l.kind, l.amount, l.balance_after])).toEqual([
        ['topup', 500, 500], ['ai_pack', -500, 0], ['ai_pack_return', 500, 500], ['refund', -500, 0],
      ]);
      const ret = (await ledger(ws))[2];
      expect(ret.description).toMatchObject({
        pack_ledger_id: (settled.purpose_result as Row).pack_ledger_id, pack_id: 's', refund_id: 'rf_full',
        provider: 'paddle_sandbox', reclaimed_wallet: 3_000_000,
      });
      expect(await lot(lotId)).toMatchObject({ remaining: 0, state: 'DEPLETED' });
      expect(await walletAvailable(ws)).toBe(0);
      expect(await q(
        `SELECT l.entry_type, l.amount::float AS amount, l.reason, a.amount::float AS alloc
           FROM public.workspace_ai_ledger l JOIN public.workspace_ai_ledger_allocations a ON a.ledger_entry_id = l.id
          WHERE l.workspace_id = $1 AND l.entry_type = 'ADJUSTMENT'`, [ws],
      )).toEqual([{ entry_type: 'ADJUSTMENT', amount: -3_000_000, reason: 'ai_pack_refund', alloc: 3_000_000 }]);
      const pay = await one(`SELECT refunded_minor::int AS refunded, purpose_detail FROM public.billing_account_payments WHERE id = $1`, [id]);
      expect(pay.refunded).toBe(500);
      expect((pay.purpose_detail as Row).refunds).toMatchObject({
        rf_full: { credit_minor: 500, shortfall_minor: 0, pack_returned_minor: 500, pack_reclaimed_wallet: 3_000_000 },
      });

      // The same refund id again: nothing.
      expect(await refund(id, 'rf_full', 500)).toMatchObject({ replayed: true });
      expect(await ledger(ws)).toHaveLength(4);
    }

    // Half used: half the price returns, the other half is the shortfall.
    {
      const ws = await makeWorkspace();
      const { id, settled } = await payOnline(ws, packDetail('s', 500, 500), 500);
      const lotId = (settled.purpose_result as Row).lot_id;
      await q(`UPDATE public.workspace_ai_balance_lots SET remaining_amount = 1500000 WHERE id = $1`, [lotId]);
      const r = await refund(id, 'rf_half', 500);
      expect(r).toMatchObject({ debited_minor: 250, shortfall_minor: 250, pack_returned_minor: 250, pack_reclaimed_wallet: 1_500_000 });
      expect(await balanceOf(ws)).toBe(0);
      expect(await lot(lotId)).toMatchObject({ remaining: 0, state: 'DEPLETED' });
    }

    // A payment larger than the pack (the top-up minimum); two partial
    // refunds return the pack's price once in all.
    {
      const ws = await makeWorkspace();
      const { id, settled } = await payOnline(ws, packDetail('s', 500, 500), 1000);
      expect(await balanceOf(ws)).toBe(500);
      const lotId = (settled.purpose_result as Row).lot_id;
      expect(await refund(id, 'rf_a', 600)).toMatchObject({ debited_minor: 600, shortfall_minor: 0, pack_returned_minor: 500 });
      expect(await refund(id, 'rf_b', 600)).toMatchObject({ debited_minor: 400, shortfall_minor: 0, pack_returned_minor: 0 });
      expect(await refund(id, 'rf_c', 600)).toMatchObject({ debited_minor: 0, shortfall_minor: 0 });
      const returned = (await ledger(ws)).filter((l) => l.kind === 'ai_pack_return');
      expect(returned.map((l) => l.amount)).toEqual([500]);
      expect(await balanceOf(ws)).toBe(0);
      expect(await lot(lotId)).toMatchObject({ remaining: 0, state: 'DEPLETED' });
    }

    // Two partial refunds of a pack bought with exactly its price.
    {
      const ws = await makeWorkspace();
      const { id, settled } = await payOnline(ws, packDetail('s', 500, 500), 500);
      const lotId = (settled.purpose_result as Row).lot_id;
      expect(await refund(id, 'rf_1', 200)).toMatchObject({ pack_returned_minor: 200, pack_reclaimed_wallet: 1_200_000, debited_minor: 200 });
      expect(await lot(lotId)).toMatchObject({ remaining: 1_800_000, state: 'ACTIVE' });
      expect(await refund(id, 'rf_2', 300)).toMatchObject({ pack_returned_minor: 300, pack_reclaimed_wallet: 1_800_000, debited_minor: 300 });
      expect((await ledger(ws)).filter((l) => l.kind === 'ai_pack_return').reduce((s, l) => s + Number(l.amount), 0)).toBe(500);
      expect(await lot(lotId)).toMatchObject({ remaining: 0, state: 'DEPLETED' });
    }

    // What a reply in flight reserved is never taken back.
    {
      const ws = await makeWorkspace();
      const { id, settled } = await payOnline(ws, packDetail('s', 500, 500), 500);
      const lotId = (settled.purpose_result as Row).lot_id;
      await fn(`SELECT public.ai_reserve($1, NULL, 1000000, $2) AS r`, [ws, `res-${randomUUID()}`]);
      const r = await refund(id, 'rf_res', 500);
      expect(r).toMatchObject({ pack_returned_minor: 333, debited_minor: 333, shortfall_minor: 167 });
      expect(Number(r.pack_reclaimed_wallet)).toBe(1_998_000);
      expect(await lot(lotId)).toMatchObject({ remaining: 1_002_000, reserved: 1_000_000, state: 'ACTIVE' });
    }

    // A plain top-up whose money later bought a pack from the balance: the pack stays.
    {
      const ws = await makeWorkspace();
      const p = await one(
        `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, purpose)
         VALUES ($1, 'paddle_sandbox', 'USD', 500, 500, 'topup') RETURNING id`, [ws]);
      await q(`SELECT public.billing_account_record_verification($1, 500, 'USD', $2)`, [p.id, `txn_${randomUUID()}`]);
      await q(`SELECT public.billing_account_settle_payment($1)`, [p.id]);
      const bought = await buy(ws, 's', 500);
      const r = await refund(String(p.id), 'rf_topup', 500);
      expect(r).toMatchObject({ debited_minor: 0, shortfall_minor: 500, pack_returned_minor: 0 });
      expect(await lot(bought.lot_id)).toMatchObject({ remaining: 3_000_000, state: 'ACTIVE' });
    }

    // The reversal itself: a replay, and a key reused for another kind.
    {
      const ws = await makeWorkspace();
      await credit(ws, 500);
      const bought = await buy(ws, 's', 500);
      const rev = (key: string, max: number) => fn(
        `SELECT public.billing_ai_pack_reverse($1, $2, $3, $4, 'r', 'test') AS r`, [ws, bought.pack_ledger_id, max, key]);
      const first = await rev('ai_pack_return:test:1', 100);
      expect(first).toMatchObject({ replayed: false, returned_minor: 100, reclaimed_wallet: 600_000 });
      expect(await rev('ai_pack_return:test:1', 100)).toMatchObject({ replayed: true, returned_minor: 100, ledger_id: first.ledger_id });
      const other = await makeWorkspace();
      await expect(fn(`SELECT public.billing_ai_pack_reverse($1, $2, 100, 'ai_pack_return:test:1', 'r', 'test') AS r`,
        [other, bought.pack_ledger_id])).rejects.toThrow(/billing_idempotency_conflict/);
      await expect(fn(`SELECT public.billing_ai_pack_reverse($1, $2, 100, 'ai_pack_return:test:2', 'r', 'test') AS r`,
        [other, bought.pack_ledger_id])).rejects.toThrow(/billing_ai_pack_not_found/);
    }
  });

  it('A10 only service_role reaches the functions, and each pins its search_path', async () => {
    for (const f of [
      'public.billing_currency_exponent(text)',
      'public.billing_ai_wallet_rate(text)',
      'public.billing_ai_pack_find(text, text, text)',
      'public.billing_account_buy_ai_pack(uuid, text, bigint, text, uuid)',
      'public.billing_ai_pack_reverse(uuid, uuid, bigint, text, text, text)',
      'public.billing_account_settle_payment(uuid)',
      'public.billing_account_refund_payment(uuid, text, bigint)',
    ]) {
      const r = await one(
        `SELECT has_function_privilege('anon', $1, 'execute') AS anon,
                has_function_privilege('authenticated', $1, 'execute') AS auth,
                has_function_privilege('service_role', $1, 'execute') AS svc,
                (SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = $1::regprocedure) AS cfg`, [f]);
      expect({ anon: r.anon, auth: r.auth, svc: r.svc }, f).toEqual({ anon: false, auth: false, svc: true });
      expect(String(r.cfg), f).toMatch(/search_path=public, pg_temp/);
    }
  });

  it('A11 the ledger takes ai_pack_return and stays append-only; 264 runs twice; the email is seeded', async () => {
    const def = String((await one(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'billing_account_ledger_kind_check'`)).d);
    for (const k of ['topup', 'renewal', 'upgrade', 'plan', 'ai_pack', 'admin_credit', 'admin_debit', 'refund', 'prepaid_return', 'ai_pack_return']) {
      expect(def).toContain(`'${k}'`);
    }
    const ws = await makeWorkspace();
    await credit(ws, 100);
    await expect(q(
      `INSERT INTO public.billing_account_ledger (workspace_id, kind, amount_minor, balance_after, currency, idempotency_key)
       VALUES ($1, 'bogus', 1, 101, 'USD', $2)`, [ws, randomUUID()])).rejects.toThrow(/billing_account_ledger_kind_check/);
    const row = await one(
      `INSERT INTO public.billing_account_ledger (workspace_id, kind, amount_minor, balance_after, currency, idempotency_key)
       VALUES ($1, 'ai_pack_return', 1, 101, 'USD', $2) RETURNING id`, [ws, randomUUID()]);
    await expect(q(`UPDATE public.billing_account_ledger SET amount_minor = 2 WHERE id = $1`, [row.id])).rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM public.billing_account_ledger WHERE id = $1`, [row.id])).rejects.toThrow(/append-only/);

    // The email: both editions, fa/en/tr, never overwritten by a second apply.
    const mails = await q(
      `SELECT edition, locale, subject, html_body, text_body FROM public.email_templates
        WHERE workspace_id IS NULL AND slug = 'billing_ai_pack_purchased' ORDER BY 1, 2`);
    expect(mails.map((m) => `${m.edition}:${m.locale}`)).toEqual(
      ['international:en', 'international:fa', 'international:tr', 'iran:en', 'iran:fa', 'iran:tr']);
    for (const m of mails) {
      for (const v of ['{pack_name}', '{credit}', '{amount}', '{balance}', '{ai_balance}', '{billing_url}']) {
        expect(String(m.html_body), `${m.edition}:${m.locale} ${v}`).toContain(v);
      }
      expect(String(m.subject)).toContain('{brand}');
      expect(String(m.html_body).includes('dir="rtl"')).toBe(m.locale === 'fa');
      expect(`${m.subject}${m.html_body}${m.text_body}`).not.toMatch(/[يك]/); // Persian ی and ک only
    }
    expect(mails.find((m) => m.locale === 'en')?.subject).toBe('AI credit added: {credit} — {brand}');

    await q(`UPDATE public.email_templates SET subject = 'EDITED' WHERE workspace_id IS NULL AND edition = 'iran'
              AND slug = 'billing_ai_pack_purchased' AND locale = 'fa'`);
    const before = await countRows(`SELECT count(*) AS n FROM public.email_templates`, []);
    await applyMigrationSql(db, readFileSync(resolve(DIR, FILE), 'utf8'));
    expect(await countRows(`SELECT count(*) AS n FROM public.email_templates`, [])).toBe(before);
    expect((await one(
      `SELECT subject FROM public.email_templates WHERE workspace_id IS NULL AND edition = 'iran'
          AND slug = 'billing_ai_pack_purchased' AND locale = 'fa'`)).subject).toBe('EDITED');
    expect(String((await one(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'billing_account_ledger_kind_check'`)).d)).toBe(def);
    expect(String((await one(`SELECT col_description('public.billing_settings'::regclass,
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.billing_settings'::regclass AND attname = 'ai_packs')) AS c`)).c))
      .toMatch(/credit_minor/);
  });

  it('A12 the purge removes a workspace with a pack: its ledger rows, lots and allocations', async () => {
    const ws = await makeWorkspace();
    const { id } = await payOnline(ws, packDetail('s', 500, 500), 500);
    await refund(id, 'rf_purge', 200);
    const other = await makeWorkspace();
    await credit(other, 500);
    const otherBought = await buy(other, 's', 500);

    expect(await countRows(`SELECT count(*) AS n FROM public.billing_account_ledger WHERE workspace_id = $1`, [ws])).toBe(4);
    await q(`SELECT public.admin_purge_workspaces(ARRAY[$1]::uuid[])`, [ws]);
    for (const [table, col] of [
      ['billing_account_ledger', 'workspace_id'], ['billing_account_payments', 'workspace_id'],
      ['workspace_ai_balance_lots', 'workspace_id'], ['workspace_ai_ledger', 'workspace_id'],
    ]) {
      expect(await countRows(`SELECT count(*) AS n FROM public.${table} WHERE ${col} = $1`, [ws]), table).toBe(0);
    }
    expect(await countRows(
      `SELECT count(*) AS n FROM public.workspace_ai_ledger_allocations a
         LEFT JOIN public.workspace_ai_ledger l ON l.id = a.ledger_entry_id WHERE l.id IS NULL`, [])).toBe(0);
    // The other workspace's pack is untouched.
    expect(await lot(otherBought.lot_id)).toMatchObject({ remaining: 3_000_000, state: 'ACTIVE' });
    expect((await ledger(other)).map((l) => l.kind)).toEqual(['admin_credit', 'ai_pack']);
  });
});
