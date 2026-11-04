// @vitest-environment node
/**
 * 299 — the billing audit fixes, against real PostgreSQL built by the whole
 * migration chain.
 *
 *   R1 two partial refunds reported as running totals (300, then 500) and
 *      processed at the same time take back 500, not 800: the second waits
 *      for the payment's lock and takes only the difference (the pre-299
 *      way, a difference computed from a row read before the lock, is shown
 *      taking 800);
 *      two payments refunded to the same total are two refunds (the old
 *      id, total:<n>, made their ledger keys collide);
 *   R2 a total again is a replay, an earlier total takes nothing, a total
 *      counts refunds recorded under the provider's own ids too, an invalid
 *      total is refused;
 *   S1 a plan paid online is bought at its quoted price only: a price raised
 *      meanwhile leaves the money in the balance (billing_quote_changed),
 *      and the rest of the balance is never spent on the difference;
 *   S2 a renewal paid online the same (its quoted price goes to
 *      billing_account_renew), also through the "bought again" fallback;
 *   S3 an upgrade paid online at most at its quoted charge (less is fine);
 *   S4 a payment opened before 299 (no quoted key) settles as before;
 *   A  only service_role reaches the functions; both pin search_path; 299
 *      runs twice.
 *
 * Its own database (CREATE DATABASE on the TEST_DATABASE_URL server); skipped
 * without TEST_DATABASE_URL; REQUIRE_BILLING_DB=1 makes that a failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_BILLING_DB === '1' && !DSN) {
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the 299 billing SQL tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `billingaudit299_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '299_billing_audit_fixes.sql';

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
let dbUrl = '';
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];
const fn = async (sql: string, params: unknown[] = []): Promise<Row> => (await one(sql, params)).r as Row;

const PRO = { monthly: 2900, yearly: 29000 };
const BIZ = { monthly: 9900, yearly: 99000 };
let proId = '';
let bizId = '';

async function makeWorkspace(): Promise<string> {
  const id = randomUUID();
  const owner = randomUUID();
  await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
  await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
  await q(`SELECT public.billing_account_ensure($1, 'USD')`, [id]);
  return id;
}

async function makePlan(slug: string, usd: { monthly: number; yearly: number }): Promise<string> {
  const row = await one(
    `INSERT INTO public.billing_plans (name, slug, prices, limits, is_active, is_free, is_hidden, sort_order)
     VALUES ($1, $2, $3, $4, true, false, false, 10) RETURNING id`,
    [slug, slug, JSON.stringify({ USD: usd }), JSON.stringify({ max_agents: 5 })],
  );
  return String(row.id);
}

const setPrice = (plan: string, monthly: number) =>
  q(`UPDATE public.billing_plans SET prices = jsonb_set(prices, '{USD,monthly}', to_jsonb($2::bigint)) WHERE id = $1`, [plan, monthly]);

const credit = (ws: string, amount: number) =>
  q(`SELECT public.billing_account_admin_adjust($1, $2, 'USD', 'test', NULL, $3)`, [ws, amount, `k-${randomUUID()}`]);

const balanceOf = async (ws: string): Promise<number> =>
  Number((await one(`SELECT balance_minor FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).balance_minor);

const planOf = async (ws: string): Promise<string | null> =>
  ((await q(
    `SELECT s.plan_id FROM public.workspace_subscriptions s JOIN public.billing_plans p ON p.id = s.plan_id
      WHERE s.workspace_id = $1 AND s.status = 'active' AND NOT p.is_free`, [ws]))[0]?.plan_id as string | undefined) ?? null;

/** A gateway payment for a purpose, confirmed and settled; returns its id and the settlement. */
async function paid(ws: string, net: number, purpose: string, detail: Row): Promise<{ id: string; settled: Row }> {
  const row = await one(
    `INSERT INTO public.billing_account_payments
       (workspace_id, provider, currency, amount_minor, net_minor, tax_minor, purpose, purpose_detail, provider_ref)
     VALUES ($1, 'stripe', 'USD', $2, $2, 0, $3, $4, $5) RETURNING id`,
    [ws, net, purpose, JSON.stringify(detail), `cs_${randomUUID().slice(0, 12)}`],
  );
  const id = String(row.id);
  await q(`SELECT public.billing_account_record_verification($1, $2, 'USD', $3)`, [id, net, `pi_${randomUUID().slice(0, 12)}`]);
  return { id, settled: await fn(`SELECT public.billing_account_settle_payment($1) AS r`, [id]) };
}

const refundedOf = async (pay: string): Promise<number> =>
  Number((await one(`SELECT refunded_minor FROM public.billing_account_payments WHERE id = $1`, [pay])).refunded_minor);

suite('299 — billing audit fixes (real PostgreSQL, whole chain)', () => {
  beforeAll(async () => {
    const adminUrl = new URL(DSN!);
    adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    const url = new URL(DSN!);
    url.pathname = `/${DB}`;
    dbUrl = url.toString();
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query('SET client_min_messages = warning');

    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files.filter((f) => f <= FILE)) {
      await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
    }
    // Re-runnable.
    await applyMigrationSql(db, readFileSync(resolve(DIR, FILE), 'utf8'));
    await db.query(`UPDATE public.platform_settings SET region_mode = 'multi'`);
    proId = await makePlan('a299-pro', PRO);
    bizId = await makePlan('a299-biz', BIZ);
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('R1 two running-total refunds processed at once take back the refunded total only', async () => {
    const ws = await makeWorkspace();
    const { id: pay } = await paid(ws, 1000, 'topup', {});
    expect(await balanceOf(ws)).toBe(1000);

    const a = new pg.Client({ connectionString: dbUrl });
    const b = new pg.Client({ connectionString: dbUrl });
    await a.connect();
    await b.connect();
    try {
      await a.query('BEGIN');
      const first = (await a.query(`SELECT public.billing_account_refund_payment_to_total($1, 300) AS r`, [pay])).rows[0].r as Row;
      expect(first).toMatchObject({ replayed: false, refund_id: `total:${pay}:300`, amount_minor: 300, debited_minor: 300 });
      // The second event while the first holds the lock: it waits for it.
      const second = b.query(`SELECT public.billing_account_refund_payment_to_total($1, 500) AS r`, [pay]);
      await new Promise((r) => setTimeout(r, 300));
      const waiting = await one(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
      expect(waiting.n).toBe(1);
      await a.query('COMMIT');
      const r2 = (await second).rows[0].r as Row;
      expect(r2).toMatchObject({ replayed: false, refund_id: `total:${pay}:500`, amount_minor: 200, debited_minor: 200 });
    } finally {
      await a.end();
      await b.end();
    }
    expect(await refundedOf(pay)).toBe(500);
    expect(await balanceOf(ws)).toBe(500);
    const debits = await q(`SELECT amount_minor FROM public.billing_account_ledger WHERE payment_id = $1 AND kind = 'refund' ORDER BY created_at`, [pay]);
    expect(debits.map((r) => Number(r.amount_minor))).toEqual([-300, -200]);
  });

  it('R1 the pre-299 way (the difference from a row read before the lock) took 800 for 500', async () => {
    const ws = await makeWorkspace();
    const { id: pay } = await paid(ws, 1000, 'topup', {});
    // Both events computed their part from a row with no refund on it yet.
    await q(`SELECT public.billing_account_refund_payment($1, 'old:300', 300)`, [pay]);
    await q(`SELECT public.billing_account_refund_payment($1, 'old:500', 500)`, [pay]);
    expect(await refundedOf(pay)).toBe(800);
  });

  it('R1 two payments refunded to the same running total are two refunds (the old total:<n> id read as a replay)', async () => {
    const ws = await makeWorkspace();
    const { id: p1 } = await paid(ws, 1000, 'topup', {});
    const { id: p2 } = await paid(ws, 1000, 'topup', {});
    await q(`SELECT public.billing_account_refund_payment($1, 'total:250', 250)`, [p1]);
    expect(await fn(`SELECT public.billing_account_refund_payment($1, 'total:250', 250) AS r`, [p2])).toMatchObject({ replayed: true });
    expect(await refundedOf(p2)).toBe(0);
    // 299: scoped to the payment. p1's refund under the old id still counts.
    expect(await fn(`SELECT public.billing_account_refund_payment_to_total($1, 250) AS r`, [p2])).toMatchObject({ replayed: false, amount_minor: 250 });
    expect(await fn(`SELECT public.billing_account_refund_payment_to_total($1, 250) AS r`, [p1])).toMatchObject({ ignored: true, amount_minor: 0 });
    expect(await refundedOf(p1)).toBe(250);
    expect(await refundedOf(p2)).toBe(250);
    expect(await balanceOf(ws)).toBe(1500);
  });

  it('R2 a total again is a replay, an earlier total takes nothing, other refund ids count, invalid is refused', async () => {
    const ws = await makeWorkspace();
    const { id: pay } = await paid(ws, 1000, 'topup', {});
    expect(await fn(`SELECT public.billing_account_refund_payment_to_total($1, 500) AS r`, [pay])).toMatchObject({ amount_minor: 500 });
    expect(await fn(`SELECT public.billing_account_refund_payment_to_total($1, 500) AS r`, [pay])).toMatchObject({ replayed: true, amount_minor: 0 });
    expect(await fn(`SELECT public.billing_account_refund_payment_to_total($1, 300) AS r`, [pay])).toMatchObject({ ignored: true, amount_minor: 0 });
    // A refund recorded under the provider's own id counts toward the total.
    await q(`SELECT public.billing_account_refund_payment($1, 're_own', 100)`, [pay]);
    expect(await fn(`SELECT public.billing_account_refund_payment_to_total($1, 700) AS r`, [pay])).toMatchObject({ amount_minor: 100 });
    expect(await refundedOf(pay)).toBe(700);
    expect(await balanceOf(ws)).toBe(300);
    for (const bad of [0, -5]) {
      await expect(q(`SELECT public.billing_account_refund_payment_to_total($1, $2)`, [pay, bad])).rejects.toThrow(/billing_refund_invalid/);
    }
    await expect(q(`SELECT public.billing_account_refund_payment_to_total($1, 10)`, [randomUUID()])).rejects.toThrow(/billing_payment_not_found/);
  });

  it('S1 a plan paid online is bought at its quoted price only', async () => {
    // Price unchanged: bought.
    const ok = await makeWorkspace();
    const r1 = await paid(ok, PRO.monthly, 'plan', { plan_id: proId, billing_interval: 'monthly', quoted_price_minor: PRO.monthly });
    expect(r1.settled.purpose_result).toMatchObject({ action: 'purchase', amount_minor: PRO.monthly });
    expect(await planOf(ok)).toBe(proId);

    // Raised meanwhile, with other money in the balance: nothing spent on it.
    const ws = await makeWorkspace();
    await credit(ws, 5000);
    await setPrice(proId, 3500);
    try {
      const r = await paid(ws, PRO.monthly, 'plan', { plan_id: proId, billing_interval: 'monthly', quoted_price_minor: PRO.monthly });
      expect((r.settled.purpose_result as Row).error).toMatch(/billing_quote_changed/);
      expect(await balanceOf(ws)).toBe(5000 + PRO.monthly);
      expect(await planOf(ws)).toBeNull();
    } finally {
      await setPrice(proId, PRO.monthly);
    }
  });

  it('S2 a renewal paid online is renewed at its quoted price only, also when the plan ran out', async () => {
    const ws = await makeWorkspace();
    await credit(ws, PRO.monthly);
    await q(`SELECT public.billing_account_purchase_plan($1, $2, 'monthly', $3)`, [ws, proId, `k-${randomUUID()}`]);
    const end = (await one(`SELECT current_period_end FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws])).current_period_end;
    await credit(ws, 4000);
    await setPrice(proId, 3500);
    try {
      const r = await paid(ws, PRO.monthly, 'renewal',
        { plan_id: proId, billing_interval: 'monthly', period_end: end, quoted_price_minor: PRO.monthly });
      expect((r.settled.purpose_result as Row).error).toMatch(/billing_quote_changed/);
      expect(await balanceOf(ws)).toBe(4000 + PRO.monthly);
      expect((await one(`SELECT next_period_prepaid_minor FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).next_period_prepaid_minor).toBeNull();

      // The plan ran out before the money arrived: the "bought again" fallback keeps the quoted price too.
      await q(`UPDATE public.workspace_subscriptions SET current_period_end = now() - interval '2 days' WHERE workspace_id = $1`, [ws]);
      await q(`SELECT public.billing_account_process_due($1)`, [ws]);
      expect(await planOf(ws)).toBeNull();
      const before = await balanceOf(ws);
      const late = await paid(ws, PRO.monthly, 'renewal',
        { plan_id: proId, billing_interval: 'monthly', period_end: end, quoted_price_minor: PRO.monthly });
      expect((late.settled.purpose_result as Row).fallback_error).toMatch(/billing_quote_changed/);
      expect(await balanceOf(ws)).toBe(before + PRO.monthly);
      expect(await planOf(ws)).toBeNull();
    } finally {
      await setPrice(proId, PRO.monthly);
    }

    // At the quoted price: prepaid.
    const fine = await makeWorkspace();
    await credit(fine, PRO.monthly);
    await q(`SELECT public.billing_account_purchase_plan($1, $2, 'monthly', $3)`, [fine, proId, `k-${randomUUID()}`]);
    const fineEnd = (await one(`SELECT current_period_end FROM public.workspace_subscriptions WHERE workspace_id = $1`, [fine])).current_period_end;
    const r = await paid(fine, PRO.monthly, 'renewal',
      { plan_id: proId, billing_interval: 'monthly', period_end: fineEnd, quoted_price_minor: PRO.monthly });
    expect(r.settled.purpose_result).toMatchObject({ action: 'prepaid', amount_minor: PRO.monthly });
  });

  it('S3 an upgrade paid online takes at most its quoted charge', async () => {
    const quoted = BIZ.monthly - PRO.monthly;
    const start = async (): Promise<string> => {
      const ws = await makeWorkspace();
      await credit(ws, PRO.monthly);
      await q(`SELECT public.billing_account_purchase_plan($1, $2, 'monthly', $3)`, [ws, proId, `k-${randomUUID()}`]);
      return ws;
    };
    const ok = await start();
    const r1 = await paid(ok, quoted, 'upgrade', { plan_id: bizId, billing_interval: 'monthly', quoted_charge_minor: quoted });
    expect(r1.settled.purpose_result).toMatchObject({ action: 'upgraded', amount_minor: quoted });
    expect(await planOf(ok)).toBe(bizId);

    // The target's price raised meanwhile: the money stays, the plan too.
    const ws = await start();
    await credit(ws, 9000);
    await setPrice(bizId, 12_900);
    try {
      const r = await paid(ws, quoted, 'upgrade', { plan_id: bizId, billing_interval: 'monthly', quoted_charge_minor: quoted });
      expect((r.settled.purpose_result as Row).error).toMatch(/billing_quote_changed/);
      expect(await balanceOf(ws)).toBe(9000 + quoted);
      expect(await planOf(ws)).toBe(proId);
    } finally {
      await setPrice(bizId, BIZ.monthly);
    }

    // Cheaper than quoted: upgraded, at the lower cost.
    const cheaper = await start();
    await setPrice(bizId, 8900);
    try {
      const r = await paid(cheaper, quoted, 'upgrade', { plan_id: bizId, billing_interval: 'monthly', quoted_charge_minor: quoted });
      expect(r.settled.purpose_result).toMatchObject({ action: 'upgraded', amount_minor: 8900 - PRO.monthly });
      expect(await balanceOf(cheaper)).toBe(quoted - (8900 - PRO.monthly));
    } finally {
      await setPrice(bizId, BIZ.monthly);
    }
  });

  it('S4 a payment opened before 299 (no quoted key) settles as before', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 5000);
    await setPrice(proId, 3500);
    try {
      const r = await paid(ws, PRO.monthly, 'plan', { plan_id: proId, billing_interval: 'monthly' });
      expect(r.settled.purpose_result).toMatchObject({ action: 'purchase', amount_minor: 3500 });
      expect(await balanceOf(ws)).toBe(5000 + PRO.monthly - 3500);
    } finally {
      await setPrice(proId, PRO.monthly);
    }
  });

  it('A only service_role reaches the functions; both pin search_path', async () => {
    for (const f of [
      'public.billing_account_refund_payment_to_total(uuid, bigint)',
      'public.billing_account_settle_payment(uuid)',
    ]) {
      const row = await one(
        `SELECT p.prosecdef AS definer, p.proconfig AS config,
                has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS authed,
                has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS service,
                EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public_exec
           FROM pg_proc p WHERE p.oid = $1::regprocedure`, [f]);
      expect(row).toMatchObject({ definer: true, anon: false, authed: false, service: true, public_exec: false });
      expect(String(row.config)).toMatch(/search_path=public, pg_temp/);
    }
  });
});
