// @vitest-environment node
/**
 * 292 — a WebYar account in US dollars, paid with Apirone, against real
 * PostgreSQL built by the whole migration chain.
 *
 *   billing_account_choose_currency
 *     - the Iranian edition only, IRR or USD;
 *     - creates the account in the chosen currency; switches an open one;
 *     - refuses once money moved (a balance or a ledger row) and while a
 *       payment may still be credited or a card-to-card request waits;
 *   billing_account_set_received_amount
 *     - Apirone only, before the confirmation, without VAT, amount > 0;
 *     - keeps the quoted amount; the settle then credits what arrived and
 *       buys the plan only when the balance covers it (underpaid: the money
 *       stays; overpaid: the plan and the rest);
 *   both are executable by service_role only.
 *
 * Its own database (CREATE DATABASE on the TEST_DATABASE_URL server); skipped
 * without TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const DB = `cryptousd292_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '292_billing_crypto_usd_accounts.sql';

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

const PRO = { monthly: 2900, yearly: 29000 };
let proId = '';

async function makeWorkspace(): Promise<string> {
  const id = randomUUID();
  const owner = randomUUID();
  await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
  await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
  return id;
}

const choose = (ws: string, currency: string) => one(`SELECT (public.billing_account_choose_currency($1, $2)).*`, [ws, currency]);
const chooseError = (ws: string, currency: string) => choose(ws, currency).then(() => '', (e: Error) => e.message);

async function apironePayment(ws: string, o: { amount?: number; tax?: number; provider?: string; createdHoursAgo?: number; purpose?: string } = {}): Promise<string> {
  const net = o.amount ?? PRO.monthly;
  const tax = o.tax ?? 0;
  const row = await one(
    `INSERT INTO public.billing_account_payments
       (workspace_id, provider, currency, amount_minor, net_minor, tax_minor, purpose, purpose_detail, provider_ref, created_at)
     VALUES ($1, $2, 'USD', $3, $4, $5, $6, $7, $8, now() - make_interval(hours => $9)) RETURNING id`,
    [ws, o.provider ?? 'apirone', net + tax, net, tax, o.purpose ?? 'plan',
      JSON.stringify({ plan_id: proId, billing_interval: 'monthly' }), `inv_${randomUUID().slice(0, 12)}`, o.createdHoursAgo ?? 0],
  );
  return String(row.id);
}

const setReceived = (payment: string, amount: number) =>
  one(`SELECT (public.billing_account_set_received_amount($1, $2)).*`, [payment, amount]);
const setReceivedError = (payment: string, amount: number) => setReceived(payment, amount).then(() => '', (e: Error) => e.message);

async function confirmAndSettle(payment: string, amount: number): Promise<Row> {
  await q(`SELECT public.billing_account_record_verification($1, $2, 'USD', $3)`, [payment, amount, `inv_${randomUUID().slice(0, 8)}`]);
  return (await one(`SELECT public.billing_account_settle_payment($1) AS r`, [payment])).r as Row;
}

const balanceOf = async (ws: string): Promise<number> =>
  Number((await one(`SELECT balance_minor FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).balance_minor);

suite('292 — USD accounts paid with Apirone (real PostgreSQL, whole chain)', () => {
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
    // Re-runnable.
    await applyMigrationSql(db, readFileSync(resolve(DIR, FILE), 'utf8'));
    await db.query(`UPDATE public.platform_settings SET region_mode = 'iran'`);
    const plan = await one(
      `INSERT INTO public.billing_plans (name, slug, prices, limits, is_active, is_free, is_hidden, sort_order)
       VALUES ('Pro', 'x-pro', $1, $2, true, false, false, 10) RETURNING id`,
      [JSON.stringify({ USD: PRO, IRR: { monthly: 29_000_000, yearly: 290_000_000 } }), JSON.stringify({ max_agents: 5 })],
    );
    proId = String(plan.id);
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('creates the account in the chosen currency and switches an open one', async () => {
    const ws = await makeWorkspace();
    expect((await choose(ws, 'usd')).currency).toBe('USD');
    expect((await choose(ws, 'USD')).currency).toBe('USD');
    expect((await choose(ws, 'IRR')).currency).toBe('IRR');
    expect((await choose(ws, 'USD')).currency).toBe('USD');
  });

  it('IRR or USD in the Iranian edition only', async () => {
    const ws = await makeWorkspace();
    expect(await chooseError(ws, 'TRY')).toMatch(/billing_account_currency_not_allowed/);
    await db.query(`UPDATE public.platform_settings SET region_mode = 'multi'`);
    try {
      expect(await chooseError(ws, 'USD')).toMatch(/billing_account_currency_not_allowed/);
    } finally {
      await db.query(`UPDATE public.platform_settings SET region_mode = 'iran'`);
    }
    expect(await one(`SELECT count(*)::int AS n FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).toEqual({ n: 0 });
  });

  it('once money moved the currency stays', async () => {
    const ws = await makeWorkspace();
    await choose(ws, 'IRR');
    await q(`SELECT public.billing_account_admin_adjust($1, 100000, 'IRR', 'test', NULL, $2)`, [ws, `k-${randomUUID()}`]);
    expect(await chooseError(ws, 'USD')).toMatch(/billing_account_currency_locked/);
    // A ledger row is enough, even with the balance back at zero.
    await q(`SELECT public.billing_account_admin_adjust($1, -100000, 'IRR', 'test', NULL, $2)`, [ws, `k-${randomUUID()}`]);
    expect(await balanceOf(ws)).toBe(0);
    expect(await chooseError(ws, 'USD')).toMatch(/billing_account_currency_locked/);
    expect(await chooseError(ws, 'IRR')).toBe('');
  });

  it('waits while a payment may still be credited or a card-to-card request is pending', async () => {
    const ws = await makeWorkspace();
    await choose(ws, 'USD');
    const recent = await apironePayment(ws);
    expect(await chooseError(ws, 'IRR')).toMatch(/billing_account_payment_pending/);
    // An Apirone invoice may be paid at the end of its hour and confirmed
    // after it: past the hour, and whatever its status, it still holds the
    // currency for two hours from its creation.
    await q(`UPDATE public.billing_account_payments SET created_at = now() - interval '90 minutes' WHERE id = $1`, [recent]);
    expect(await chooseError(ws, 'IRR')).toMatch(/billing_account_payment_pending/);
    await q(`UPDATE public.billing_account_payments SET status = 'expired' WHERE id = $1`, [recent]);
    expect(await chooseError(ws, 'IRR')).toMatch(/billing_account_payment_pending/);
    await q(`UPDATE public.billing_account_payments SET status = 'pending', created_at = now() - interval '3 hours' WHERE id = $1`, [recent]);
    expect(await chooseError(ws, 'IRR')).toBe('');
    await choose(ws, 'USD');
    // Another gateway's pending checkout holds it for its hour only.
    const zibal = await apironePayment(ws, { provider: 'zibal' });
    await q(`UPDATE public.billing_account_payments SET created_at = now() - interval '90 minutes' WHERE id = $1`, [zibal]);
    expect(await chooseError(ws, 'IRR')).toBe('');
    await choose(ws, 'USD');
    await q(`DELETE FROM public.billing_account_payments WHERE id = $1`, [zibal]);
    // A recorded confirmation not settled yet holds it whatever its age or status.
    await q(`UPDATE public.billing_account_payments SET status = 'expired', verified_at = now(), verified_amount_minor = amount_minor,
               provider_payment_id = 'inv-confirmed' WHERE id = $1`, [recent]);
    expect(await chooseError(ws, 'IRR')).toMatch(/billing_account_payment_pending/);
    await q(`DELETE FROM public.billing_account_payments WHERE id = $1`, [recent]);
    await q(
      `INSERT INTO public.billing_card_transfers (workspace_id, net_minor, amount_minor, receipt_key, receipt_mime, receipt_size)
       VALUES ($1, 1000000, 1000000, 'k', 'image/png', 1)`, [ws]);
    expect(await chooseError(ws, 'IRR')).toMatch(/billing_account_payment_pending/);
  });

  it('what arrived replaces the amount once, the quoted amount is kept', async () => {
    const ws = await makeWorkspace();
    await choose(ws, 'USD');
    const p = await apironePayment(ws);
    const row = await setReceived(p, 1450);
    expect(Number(row.amount_minor)).toBe(1450);
    expect(Number(row.net_minor)).toBe(1450);
    expect((row.purpose_detail as Row).quoted_amount_minor).toBe(2900);
    expect(row.purpose).toBe('plan');
    const again = await setReceived(p, 1500);
    expect((again.purpose_detail as Row).quoted_amount_minor).toBe(2900);
  });

  it('refuses another gateway, a confirmed or settled payment, VAT and a non-positive amount', async () => {
    const ws = await makeWorkspace();
    await choose(ws, 'USD');
    expect(await setReceivedError(await apironePayment(ws, { provider: 'stripe' }), 1450)).toMatch(/billing_payment_amount_fixed/);
    expect(await setReceivedError(await apironePayment(ws, { tax: 290 }), 1450)).toMatch(/billing_payment_has_tax/);
    expect(await setReceivedError(await apironePayment(ws), 0)).toMatch(/billing_payment_bad_amount/);
    const confirmed = await apironePayment(ws);
    await q(`SELECT public.billing_account_record_verification($1, 2900, 'USD', 'inv-x')`, [confirmed]);
    expect(await setReceivedError(confirmed, 1450)).toMatch(/billing_payment_already_verified/);
  });

  it('underpaid: what arrived is in the balance and the plan is not bought', async () => {
    const ws = await makeWorkspace();
    await choose(ws, 'USD');
    const p = await apironePayment(ws);
    await setReceived(p, 1450);
    const settled = await confirmAndSettle(p, 1450);
    expect(settled.replayed).toBe(false);
    expect(settled.purpose_result).toHaveProperty('error');
    expect(await balanceOf(ws)).toBe(1450);
  });

  it('overpaid: the plan is bought and the rest stays in the balance', async () => {
    const ws = await makeWorkspace();
    await choose(ws, 'USD');
    const p = await apironePayment(ws);
    await setReceived(p, 4950);
    const settled = await confirmAndSettle(p, 4950);
    expect(settled.purpose_result).not.toHaveProperty('error');
    expect(await balanceOf(ws)).toBe(4950 - PRO.monthly);
    const sub = await one(`SELECT plan_id FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws]);
    expect(sub.plan_id).toBe(proId);
  });

  it('service_role only', async () => {
    for (const sig of ['public.billing_account_choose_currency(uuid, text)', 'public.billing_account_set_received_amount(uuid, bigint)']) {
      const row = await one(
        `SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS service,
                has_function_privilege('anon', $1, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') AS auth`,
        [sig],
      );
      expect(row).toEqual({ service: true, anon: false, auth: false });
    }
  });
});
