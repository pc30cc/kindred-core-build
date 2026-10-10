// @vitest-environment node
/**
 * 261 — the simple billing's plan purchase, renewal, upgrade and changes at
 * the end of a period, against real PostgreSQL built by the whole migration
 * chain (docs/billing/SIMPLE_BILLING.md).
 *
 *   - a plan is bought from the balance (full price, period starts now);
 *   - an upgrade is immediate: monthly the price difference, yearly the
 *     difference × whole months left / 12; the month's AI credit difference
 *     is added; the due date does not move;
 *   - a renewal before the due date prepays the next period; at the due
 *     moment a prepaid period starts, auto-renew pays from the balance, and
 *     otherwise the workspace moves to Free at once;
 *   - a downgrade or interval change waits for the period end and can be
 *     cancelled; a prepaid next period is re-priced;
 *   - a gateway payment made for a purpose is spent on it in the same
 *     transaction, or stays in the balance when it can no longer be done;
 *   - each month of a period gets the plan's AI credit once, never twice;
 *   - billing v2's subscription triggers are gone; the billing emails exist
 *     for both editions in fa/en/tr; only service_role reaches any of it.
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
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the simple billing renewal tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `simplebilling261_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '261_simple_billing_renewals.sql';

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];
const fn = async (sql: string, params: unknown[] = []): Promise<Row> => (await one(sql, params)).r as Row;

const PRO = { monthly: 2900, yearly: 29000 };
const BIZ = { monthly: 9900, yearly: 99000 };
let proId = '';
let bizId = '';
let freeId = '';

async function makePlan(slug: string, usd: { monthly: number; yearly: number }, aiIrr: number, extra: Row = {}): Promise<string> {
  const row = await one(
    `INSERT INTO public.billing_plans (name, slug, prices, limits, is_active, is_free, is_hidden, sort_order)
     VALUES ($1, $2, $3, $4, true, false, $5, $6) RETURNING id`,
    [slug, slug, JSON.stringify({ USD: usd }), JSON.stringify({ included_ai_allowance_irr: aiIrr, max_agents: 5 }),
      extra.is_hidden ?? false, extra.sort_order ?? 10],
  );
  return String(row.id);
}

async function makeWorkspace(): Promise<string> {
  const id = randomUUID();
  const owner = randomUUID();
  await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
  await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
  return id;
}

let keySeq = 0;
const credit = async (ws: string, amount: number) =>
  q(`SELECT public.billing_account_admin_adjust($1, $2, 'USD', 'test credit', NULL, $3)`, [ws, amount, `test-${++keySeq}`]);
const balanceOf = async (ws: string): Promise<number> =>
  Number((await one(`SELECT balance_minor FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).balance_minor);
const account = (ws: string) => one(`SELECT * FROM public.billing_accounts WHERE workspace_id = $1`, [ws]);
const sub = (ws: string) => one(`SELECT * FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws]);
const ledger = (ws: string) => q(`SELECT kind, amount_minor, balance_after, plan_id, period_start, period_end FROM public.billing_account_ledger WHERE workspace_id = $1 ORDER BY created_at, id`, [ws]);
const lots = (ws: string) => q(
  `SELECT billing_cycle_id, allowance_source, original_amount::float AS amount, expires_at
     FROM public.workspace_ai_balance_lots WHERE workspace_id = $1 AND source_type = 'PLAN_ALLOWANCE' ORDER BY created_at, billing_cycle_id`, [ws]);

const purchase = (ws: string, plan: string, interval = 'monthly', key = randomUUID()) =>
  fn(`SELECT public.billing_account_purchase_plan($1, $2, $3, $4) AS r`, [ws, plan, interval, key]);
/** Moves the current period so it started `startDaysAgo` days ago and lasts `interval`. */
const shiftPeriod = async (ws: string, startDaysAgo: number, interval: 'monthly' | 'yearly' = 'monthly') => {
  await q(
    `UPDATE public.workspace_subscriptions
        SET current_period_start = now() - make_interval(days => $2),
            current_period_end = public.billing_period_end(now() - make_interval(days => $2), $3),
            billing_interval = $3
      WHERE workspace_id = $1`, [ws, startDaysAgo, interval]);
};
/** Moves only the running period into the past (a prepayment stays for the old one). */
const makeDueWithoutPrepaid = async (ws: string) => {
  await q(
    `UPDATE public.workspace_subscriptions
        SET current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 hour'
      WHERE workspace_id = $1`, [ws]);
};
/** Moves the running period into the past (and a prepayment made for the next one with it). */
const makeDue = async (ws: string) => {
  await q(
    `UPDATE public.workspace_subscriptions
        SET current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 hour'
      WHERE workspace_id = $1`, [ws]);
  await q(
    `UPDATE public.billing_accounts a SET next_period_start = s.current_period_end
       FROM public.workspace_subscriptions s
      WHERE a.workspace_id = $1 AND s.workspace_id = a.workspace_id AND a.next_period_prepaid_minor IS NOT NULL`, [ws]);
};

suite('261 — simple billing renewals, upgrades and changes (real PostgreSQL, whole chain)', () => {
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
    proId = await makePlan('t-pro', PRO, 300_000);
    bizId = await makePlan('t-biz', BIZ, 600_000);
    freeId = String((await one(`SELECT id FROM public.billing_plans WHERE slug = 'free'`)).id);
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('billing v2 no longer guards or mails workspace_subscriptions', async () => {
    const triggers = await q(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.workspace_subscriptions'::regclass AND NOT tgisinternal ORDER BY 1`,
    );
    expect(triggers.map((t) => t.tgname)).toEqual(['update_workspace_subscriptions_updated_at']);
  });

  it('a plan is bought from the balance: full price, the period starts now, the month\'s AI credit', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2000);
    await expect(purchase(ws, proId)).rejects.toThrow(/billing_insufficient_balance/);

    await credit(ws, 1000);
    const key = randomUUID();
    const r = await purchase(ws, proId, 'monthly', key);
    expect(r).toMatchObject({ action: 'purchase', amount_minor: PRO.monthly, balance_minor: 100 });
    const s = await sub(ws);
    expect(s).toMatchObject({ plan_id: proId, status: 'active', billing_interval: 'monthly', provider_name: 'account' });
    const days = (new Date(s.current_period_end as string).getTime() - new Date(s.current_period_start as string).getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(28);
    expect(days).toBeLessThanOrEqual(31);
    expect((await lots(ws)).map((l) => [l.allowance_source, l.amount])).toEqual([['plan', 300_000]]);
    expect(await q(`SELECT change_type FROM public.plan_change_log WHERE workspace_id = $1`, [ws])).toEqual([{ change_type: 'purchase' }]);

    // A replay charges nothing.
    expect(await purchase(ws, proId, 'monthly', key)).toMatchObject({ replayed: true });
    expect(await balanceOf(ws)).toBe(100);
    // While a paid period runs, a plan is changed, not bought again.
    await credit(ws, 10_000);
    await expect(purchase(ws, bizId)).rejects.toThrow(/billing_plan_active/);
  });

  it('hidden, free and inactive plans cannot be bought; a trial can buy one', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 100_000);
    const hidden = await makePlan('t-hidden', PRO, 0, { is_hidden: true });
    await expect(purchase(ws, hidden)).rejects.toThrow(/billing_plan_not_available/);
    await expect(purchase(ws, freeId)).rejects.toThrow(/billing_plan_not_available/);

    const trial = String((await one(`SELECT id FROM public.billing_plans WHERE slug = 'trial'`)).id);
    await q(
      `INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status, trial_end, current_period_start, current_period_end)
       VALUES ($1, $2, 'trialing', now() + interval '5 days', now() - interval '2 days', now() + interval '5 days')`, [ws, trial]);
    expect(await purchase(ws, proId, 'yearly')).toMatchObject({ action: 'purchase', amount_minor: PRO.yearly });
    expect(await sub(ws)).toMatchObject({ status: 'active', plan_id: proId, billing_interval: 'yearly' });
  });

  it('a monthly upgrade costs the price difference, at once, and adds the AI credit difference', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900 + 7000);
    await purchase(ws, proId);
    const before = await sub(ws);
    const r = await fn(`SELECT public.billing_account_upgrade($1, $2) AS r`, [ws, bizId]);
    expect(r).toMatchObject({ action: 'upgraded', amount_minor: BIZ.monthly - PRO.monthly, balance_minor: 0 });
    const after = await sub(ws);
    expect(after.plan_id).toBe(bizId);
    expect(after.current_period_end).toEqual(before.current_period_end);
    expect((await lots(ws)).map((l) => [l.allowance_source, l.amount]))
      .toEqual([['plan', 300_000], [`upgrade:${bizId}`, 300_000]]);
    // Retried: nothing more.
    expect(await fn(`SELECT public.billing_account_upgrade($1, $2) AS r`, [ws, bizId])).toMatchObject({ replayed: true });
    expect(await balanceOf(ws)).toBe(0);
    // Down is not an upgrade.
    await expect(fn(`SELECT public.billing_account_upgrade($1, $2) AS r`, [ws, proId])).rejects.toThrow(/billing_not_an_upgrade/);
  });

  it('a yearly upgrade costs the difference × whole months left / 12', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 29000 + 60_000);
    await purchase(ws, proId, 'yearly');
    // 2 months and 1 day into the year: 9 whole months left.
    await q(
      `UPDATE public.workspace_subscriptions
          SET current_period_start = public.billing_add_months(now() - interval '1 day', -2),
              current_period_end = public.billing_add_months(public.billing_add_months(now() - interval '1 day', -2), 12)
        WHERE workspace_id = $1`, [ws]);
    const quote = await fn(`SELECT public.billing_account_upgrade_cost($1, $2) AS r`, [ws, bizId]);
    expect(quote).toMatchObject({ upgrade: true, months_left: 9, cost_minor: Math.round((BIZ.yearly - PRO.yearly) * 9 / 12) });
    const r = await fn(`SELECT public.billing_account_upgrade($1, $2) AS r`, [ws, bizId]);
    expect(r).toMatchObject({ amount_minor: 52_500, months_left: 9 });
    expect(await balanceOf(ws)).toBe(60_000 - 52_500);
  });

  it('an early renewal prepays the next period, which starts at the due moment without a second charge', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900 * 2);
    await purchase(ws, proId);
    const s = await sub(ws);
    const r = await fn(`SELECT public.billing_account_renew($1) AS r`, [ws]);
    expect(r).toMatchObject({ action: 'prepaid', amount_minor: 2900, balance_minor: 0 });
    expect(new Date(r.period_start as string).getTime()).toBe(new Date(s.current_period_end as string).getTime());
    expect(Number((await account(ws)).next_period_prepaid_minor)).toBe(2900);
    await expect(fn(`SELECT public.billing_account_renew($1) AS r`, [ws])).rejects.toThrow(/billing_already_renewed/);

    await makeDue(ws);
    const due = await sub(ws);
    const done = await fn(`SELECT public.billing_account_process_due($1) AS r`, [ws]);
    expect(done).toMatchObject({ action: 'renewed', prepaid: true, plan_id: proId });
    const next = await sub(ws);
    expect(new Date(next.current_period_start as string).getTime()).toBe(new Date(due.current_period_end as string).getTime());
    expect(next.status).toBe('active');
    expect((await account(ws)).next_period_prepaid_minor).toBeNull();
    expect((await ledger(ws)).filter((l) => l.kind === 'renewal')).toHaveLength(1);
    // Processing again does nothing.
    expect(await fn(`SELECT public.billing_account_process_due($1) AS r`, [ws])).toEqual({ action: 'none' });
  });

  it('at the due moment auto-renew pays from the balance; otherwise the workspace moves to Free at once', async () => {
    const renewing = await makeWorkspace();
    await credit(renewing, 2900 * 2);
    await purchase(renewing, proId);
    await q(`UPDATE public.billing_accounts SET auto_renew = true WHERE workspace_id = $1`, [renewing]);
    await makeDue(renewing);
    expect(await fn(`SELECT public.billing_account_process_due($1) AS r`, [renewing]))
      .toMatchObject({ action: 'renewed', auto_renew: true, amount_minor: 2900, balance_minor: 0 });
    expect((await sub(renewing)).status).toBe('active');

    const broke = await makeWorkspace();
    await credit(broke, 2900);
    await purchase(broke, proId);
    await q(`UPDATE public.billing_accounts SET auto_renew = true WHERE workspace_id = $1`, [broke]);
    await makeDue(broke);
    expect(await fn(`SELECT public.billing_account_process_due($1) AS r`, [broke]))
      .toMatchObject({ action: 'expired', reason: 'insufficient_balance', plan_id: proId });
    expect(await sub(broke)).toMatchObject({ status: 'expired', plan_id: proId });

    const manual = await makeWorkspace();
    await credit(manual, 2900 * 3);
    await purchase(manual, proId);
    await makeDue(manual);
    expect(await fn(`SELECT public.billing_account_process_due($1) AS r`, [manual]))
      .toMatchObject({ action: 'expired', reason: 'not_renewed' });
    expect(await balanceOf(manual)).toBe(2900 * 2);
    // Buying again after it ran out starts a new period now.
    expect(await purchase(manual, proId)).toMatchObject({ action: 'purchase' });
  });

  it('a downgrade waits for the period end, re-prices a prepaid period, and can be cancelled', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 9900 * 2);
    await purchase(ws, bizId);
    await fn(`SELECT public.billing_account_renew($1) AS r`, [ws]);
    expect(await balanceOf(ws)).toBe(0);

    const r = await fn(`SELECT public.billing_account_schedule_change($1, $2, 'monthly') AS r`, [ws, proId]);
    expect(r).toMatchObject({ action: 'change_scheduled', plan_id: proId, price_minor: 2900, next_period_prepaid_minor: 2900 });
    expect(await balanceOf(ws)).toBe(9900 - 2900);
    expect((await sub(ws)).plan_id).toBe(bizId);
    expect((await ledger(ws)).at(-1)).toMatchObject({ kind: 'prepaid_return', amount_minor: '7000' });

    // Cancelled: back to the current plan, the prepaid period re-priced up from the balance.
    const back = await fn(`SELECT public.billing_account_schedule_change($1, $2, 'monthly') AS r`, [ws, bizId]);
    expect(back).toMatchObject({ action: 'change_cancelled', next_period_prepaid_minor: 9900 });
    expect(await balanceOf(ws)).toBe(0);

    await fn(`SELECT public.billing_account_schedule_change($1, $2, 'monthly') AS r`, [ws, proId]);
    await makeDue(ws);
    expect(await fn(`SELECT public.billing_account_process_due($1) AS r`, [ws]))
      .toMatchObject({ action: 'renewed', prepaid: true, plan_id: proId, previous_plan_id: bizId });
    expect((await sub(ws)).plan_id).toBe(proId);
  });

  it('a change to the free plan returns a prepaid period and ends the plan at the due moment', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900 * 2);
    await purchase(ws, proId);
    await fn(`SELECT public.billing_account_renew($1) AS r`, [ws]);
    await fn(`SELECT public.billing_account_schedule_change($1, $2, NULL) AS r`, [ws, freeId]);
    expect(await balanceOf(ws)).toBe(2900);
    expect((await account(ws)).next_period_prepaid_minor).toBeNull();
    await expect(fn(`SELECT public.billing_account_renew($1) AS r`, [ws])).rejects.toThrow(/billing_renewal_to_free/);
    await q(`UPDATE public.billing_accounts SET auto_renew = true WHERE workspace_id = $1`, [ws]);
    await makeDue(ws);
    expect(await fn(`SELECT public.billing_account_process_due($1) AS r`, [ws]))
      .toMatchObject({ action: 'expired', reason: 'changed_to_free' });
    expect(await balanceOf(ws)).toBe(2900);
  });

  it('monthly → yearly takes effect at the period end at the yearly price', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900 + 29000);
    await purchase(ws, proId);
    await fn(`SELECT public.billing_account_schedule_change($1, $2, 'yearly') AS r`, [ws, proId]);
    expect((await account(ws))).toMatchObject({ scheduled_plan_id: null, scheduled_interval: 'yearly' });
    expect(await fn(`SELECT public.billing_account_renew($1) AS r`, [ws])).toMatchObject({ action: 'prepaid', amount_minor: 29000, billing_interval: 'yearly' });
    await makeDue(ws);
    await fn(`SELECT public.billing_account_process_due($1) AS r`, [ws]);
    const s = await sub(ws);
    expect(s.billing_interval).toBe('yearly');
    const days = (new Date(s.current_period_end as string).getTime() - new Date(s.current_period_start as string).getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(365);
  });

  it('an upgrade drops a scheduled downgrade and keeps a prepaid next period paid, at the new price', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900 * 2 + 7000 + 7000);
    await purchase(ws, proId);
    await fn(`SELECT public.billing_account_renew($1) AS r`, [ws]);
    await fn(`SELECT public.billing_account_schedule_change($1, $2, 'monthly') AS r`, [ws, freeId]);
    // To Free, the prepayment came back; renewing again pays for it again.
    expect((await account(ws)).next_period_prepaid_minor).toBeNull();
    await fn(`SELECT public.billing_account_schedule_change($1, $2, 'monthly') AS r`, [ws, proId]);
    await fn(`SELECT public.billing_account_renew($1) AS r`, [ws]);
    expect(await balanceOf(ws)).toBe(14_000);

    const quote = await fn(`SELECT public.billing_account_upgrade_cost($1, $2) AS r`, [ws, bizId]);
    expect(quote).toMatchObject({ cost_minor: 7000, prepaid_minor: 2900, next_price_minor: 9900, reprice_minor: 7000 });
    const r = await fn(`SELECT public.billing_account_upgrade($1, $2) AS r`, [ws, bizId]);
    expect(r).toMatchObject({ amount_minor: 7000, reprice_minor: 7000, next_period_prepaid_minor: 9900, balance_minor: 0 });
    expect(await account(ws)).toMatchObject({ scheduled_plan_id: null, next_period_prepaid_minor: '9900' });
  });

  it('a renewal is never free: returning a prepayment and renewing again charges again, and no loop makes balance', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900 * 2);
    await purchase(ws, proId);
    await fn(`SELECT public.billing_account_renew($1) AS r`, [ws]);
    for (let i = 0; i < 3; i += 1) {
      await fn(`SELECT public.billing_account_schedule_change($1, $2, NULL) AS r`, [ws, freeId]);
      await fn(`SELECT public.billing_account_schedule_change($1, $2, 'monthly') AS r`, [ws, proId]);
      await fn(`SELECT public.billing_account_renew($1) AS r`, [ws]);
      expect(await balanceOf(ws)).toBe(0);
      expect(Number((await account(ws)).next_period_prepaid_minor)).toBe(2900);
    }
    const renewals = await q(`SELECT count(*)::int AS n FROM public.billing_account_ledger WHERE workspace_id = $1 AND kind = 'renewal'`, [ws]);
    expect(renewals[0].n).toBe(4);
  });

  it('a renewal is for the period it was asked for: a retry after that period changed renews nothing', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900 * 3);
    await purchase(ws, proId);
    const seen = (await sub(ws)).current_period_end as string;
    await makeDue(ws);
    await expect(fn(`SELECT public.billing_account_renew($1, NULL, $2) AS r`, [ws, seen])).rejects.toThrow(/billing_period_changed/);
    const due = (await sub(ws)).current_period_end as string;
    expect(await fn(`SELECT public.billing_account_renew($1, NULL, $2) AS r`, [ws, due])).toMatchObject({ action: 'renewed' });
    await expect(fn(`SELECT public.billing_account_renew($1, NULL, $2) AS r`, [ws, due])).rejects.toThrow(/billing_period_changed/);
    expect(await balanceOf(ws)).toBe(2900);
  });

  it('a replayed key must be the same charge', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 5000);
    await q(`SELECT public.billing_account_debit($1, 'renewal', 1000, NULL, NULL, NULL, NULL, '{}', NULL, 'k-same')`, [ws]);
    await q(`SELECT public.billing_account_debit($1, 'renewal', 1000, NULL, NULL, NULL, NULL, '{}', NULL, 'k-same')`, [ws]);
    expect(await balanceOf(ws)).toBe(4000);
    await expect(q(`SELECT public.billing_account_debit($1, 'renewal', 2000, NULL, NULL, NULL, NULL, '{}', NULL, 'k-same')`, [ws]))
      .rejects.toThrow(/billing_idempotency_conflict/);
  });

  it('buying a plan between the due moment and the job first starts the prepaid next period; nothing paid is lost', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900 * 2 + 9900);
    await purchase(ws, proId);
    await fn(`SELECT public.billing_account_renew($1) AS r`, [ws]);
    await makeDue(ws);
    // The prepaid period is the plan now: the purchase is refused and changes
    // nothing (the refusal rolls back), and the next pass starts that period.
    await expect(purchase(ws, bizId)).rejects.toThrow(/billing_plan_active/);
    expect(Number((await account(ws)).next_period_prepaid_minor)).toBe(2900);
    expect(await balanceOf(ws)).toBe(9900);
    expect(await fn(`SELECT public.billing_account_process_due($1) AS r`, [ws])).toMatchObject({ action: 'renewed' });
    expect(await sub(ws)).toMatchObject({ status: 'active', plan_id: proId });
    expect((await account(ws)).next_period_prepaid_minor).toBeNull();
    expect(await balanceOf(ws)).toBe(9900);
  });

  it('a prepayment made for a period that was replaced (Super Admin) returns to the balance', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900 * 2);
    await purchase(ws, proId);
    await fn(`SELECT public.billing_account_renew($1) AS r`, [ws]);
    // A Super Admin assignment writes a new period.
    await q(`UPDATE public.workspace_subscriptions SET plan_id = $2, current_period_start = now(),
               current_period_end = now() + interval '90 days' WHERE workspace_id = $1`, [ws, bizId]);
    await makeDueWithoutPrepaid(ws);
    expect(await fn(`SELECT public.billing_account_process_due($1) AS r`, [ws])).toMatchObject({ action: 'expired' });
    expect(await balanceOf(ws)).toBe(2900);
  });

  it('a refund of an online renewal takes the prepaid next period back first', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900);
    await purchase(ws, proId);
    const end = (await sub(ws)).current_period_end as string;
    const p = await one(
      `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, purpose, purpose_detail)
       VALUES ($1, 'paddle_sandbox', 'USD', 2900, 2900, 'renewal', $2) RETURNING id`,
      [ws, JSON.stringify({ plan_id: proId, billing_interval: 'monthly', period_end: end })]);
    await q(`SELECT public.billing_account_record_verification($1, 2900, 'USD', $2)`, [p.id, `txn_${randomUUID()}`]);
    const settled = await fn(`SELECT public.billing_account_settle_payment($1) AS r`, [p.id]);
    expect(settled.purpose_result).toMatchObject({ action: 'prepaid' });
    expect((await one(`SELECT purpose_result FROM public.billing_account_payments WHERE id = $1`, [p.id])).purpose_result)
      .toMatchObject({ action: 'prepaid' });
    const refund = await fn(`SELECT public.billing_account_refund_payment($1, 're_1', 2900) AS r`, [p.id]);
    expect(refund).toMatchObject({ debited_minor: 2900, shortfall_minor: 0, released_prepaid_minor: 2900 });
    expect(await balanceOf(ws)).toBe(0);
    expect((await account(ws)).next_period_prepaid_minor).toBeNull();
  });

  it('an online renewal paid after the plan ran out buys that plan again', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900);
    await purchase(ws, proId);
    const end = (await sub(ws)).current_period_end as string;
    await makeDue(ws);
    await fn(`SELECT public.billing_account_process_due($1) AS r`, [ws]);
    expect((await sub(ws)).status).toBe('expired');
    const p = await one(
      `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, purpose, purpose_detail)
       VALUES ($1, 'paddle_sandbox', 'USD', 2900, 2900, 'renewal', $2) RETURNING id`,
      [ws, JSON.stringify({ plan_id: proId, billing_interval: 'monthly', period_end: end })]);
    await q(`SELECT public.billing_account_record_verification($1, 2900, 'USD', $2)`, [p.id, `txn_${randomUUID()}`]);
    const settled = await fn(`SELECT public.billing_account_settle_payment($1) AS r`, [p.id]);
    expect(settled.purpose_result).toMatchObject({ action: 'purchase', plan_id: proId });
    expect(await sub(ws)).toMatchObject({ status: 'active', plan_id: proId });
  });

  it('a paid period waiting in billing v2 starts at the due moment', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900);
    await purchase(ws, proId);
    await makeDue(ws);
    const s = await sub(ws);
    await q(
      `INSERT INTO public.billing_subscription_periods (workspace_id, plan_id, status, period_start, period_end, billing_interval, source)
       VALUES ($1, $2, 'scheduled', $3, $3::timestamptz + interval '1 month', 'monthly', 'admin')`,
      [ws, proId, s.current_period_end]);
    expect(await fn(`SELECT public.billing_account_process_due($1) AS r`, [ws])).toMatchObject({ action: 'renewed', source: 'billing_v2' });
    expect((await sub(ws)).status).toBe('active');
    expect(Date.parse(String((await sub(ws)).current_period_end))).toBeGreaterThan(Date.now());
  });

  it('a next period already paid through billing v2 is renewed: no reminder, no second renewal, and a prepayment returns', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900 * 2);
    await purchase(ws, proId);
    await fn(`SELECT public.billing_account_renew($1) AS r`, [ws]);
    expect(await balanceOf(ws)).toBe(0);
    await makeDue(ws);
    const s = await sub(ws);
    await q(
      `INSERT INTO public.billing_subscription_periods (workspace_id, plan_id, status, period_start, period_end, billing_interval, source)
       VALUES ($1, $2, 'scheduled', $3, $3::timestamptz + interval '1 month', 'monthly', 'admin')`,
      [ws, proId, s.current_period_end]);
    expect(await fn(`SELECT public.billing_account_process_due($1) AS r`, [ws])).toMatchObject({ action: 'renewed', source: 'billing_v2' });
    // The account prepayment for the same next period comes back.
    expect(await balanceOf(ws)).toBe(2900);
    expect((await account(ws)).next_period_prepaid_minor).toBeNull();

    const other = await makeWorkspace();
    await credit(other, 2900 * 2);
    await purchase(other, proId);
    const o = await sub(other);
    await q(
      `INSERT INTO public.billing_subscription_periods (workspace_id, plan_id, status, period_start, period_end, billing_interval, source)
       VALUES ($1, $2, 'scheduled', $3, $3::timestamptz + interval '1 month', 'monthly', 'admin')`,
      [other, proId, o.current_period_end]);
    expect((await q(`SELECT workspace_id FROM public.billing_account_reminder_candidates(40)`)).map((r) => r.workspace_id)).not.toContain(other);
    await expect(fn(`SELECT public.billing_account_renew($1) AS r`, [other])).rejects.toThrow(/billing_already_renewed/);
    expect(await balanceOf(other)).toBe(2900);
  });

  it('a renewal is charged only at the price the customer was shown', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900 + 9900 * 2);
    await purchase(ws, proId);
    // Another tab schedules Biz after the page showed the Pro renewal.
    await fn(`SELECT public.billing_account_schedule_change($1, $2, 'monthly') AS r`, [ws, bizId]);
    const before = await balanceOf(ws);
    await expect(fn(`SELECT public.billing_account_renew($1, NULL, NULL, 2900) AS r`, [ws])).rejects.toThrow(/billing_quote_changed/);
    expect(await balanceOf(ws)).toBe(before);
    expect(await fn(`SELECT public.billing_account_renew($1, NULL, NULL, 9900) AS r`, [ws])).toMatchObject({ action: 'prepaid', amount_minor: 9900 });
  });

  it('a Super Admin assignment returns a prepayment and drops a scheduled change, even with the same end date', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900 * 2);
    await purchase(ws, proId);
    await fn(`SELECT public.billing_account_renew($1) AS r`, [ws]);
    await fn(`SELECT public.billing_account_schedule_change($1, $2, 'yearly') AS r`, [ws, proId]).catch(() => null);
    // The admin keeps the end date and changes the plan.
    await q(`UPDATE public.workspace_subscriptions SET plan_id = $2 WHERE workspace_id = $1`, [ws, bizId]);
    const prepaid = Number((await account(ws)).next_period_prepaid_minor);
    const balance = await balanceOf(ws);
    expect(Number((await one(`SELECT public.billing_account_admin_replaced($1) AS n`, [ws])).n)).toBe(prepaid);
    expect(await balanceOf(ws)).toBe(balance + prepaid);
    expect(await account(ws)).toMatchObject({ next_period_prepaid_minor: null, next_period_start: null, scheduled_plan_id: null, scheduled_interval: null });
    // The return names the prepaid period it came from.
    const back = (await ledger(ws)).filter((r) => r.kind === 'prepaid_return').at(-1)!;
    expect(back.plan_id).toBeTruthy();
    expect(back.period_start).toBeTruthy();
    expect(back.period_end).toBeTruthy();
  });

  it('a monthly upgrade over a longer window names the months it pays for', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900);
    await purchase(ws, proId);
    await q(`UPDATE public.workspace_subscriptions SET current_period_end = now() + interval '95 days' WHERE workspace_id = $1`, [ws]);
    const cost = await fn(`SELECT public.billing_account_upgrade_cost($1, $2) AS r`, [ws, bizId]);
    expect(cost).toMatchObject({ upgrade: true, months_left: 3, cost_minor: 7000 * 3 });
  });

  it('the old calendar AI grant made in this month of a running period counts; a new period retires what is left of it', async () => {
    const month = String((await one(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') AS m`)).m);
    const calendarLot = (ws: string, amount: number) =>
      q(`SELECT public.ai_grant_allowance($1, $2, $3, 'plan', now() + interval '20 days', $4)`, [ws, amount, month, `legacy-${ws}`]);
    const accountLots = async (ws: string) => (await lots(ws)).filter((l) => String(l.billing_cycle_id).startsWith('cycle:account:'));

    // A paid period running since before the calendar grant: no second allowance.
    const paid = await makeWorkspace();
    await q(
      `INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status, billing_interval, current_period_start, current_period_end)
       VALUES ($1, $2, 'active', 'monthly', now() - interval '1 day', public.billing_period_end(now() - interval '1 day', 'monthly'))`,
      [paid, proId]);
    await calendarLot(paid, 300_000);
    await q(`SELECT public.billing_account_grant_due_allowances()`);
    expect(await accountLots(paid)).toHaveLength(0);

    // A trial that got the calendar grant: no second allowance either.
    const trial = await makeWorkspace();
    await q(
      `INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status, trial_start, trial_end, current_period_start, current_period_end)
       VALUES ($1, $2, 'trialing', now() - interval '1 day', now() + interval '6 days', now() - interval '1 day', now() + interval '6 days')`,
      [trial, proId]);
    await calendarLot(trial, 300_000);
    await q(`SELECT public.billing_account_grant_due_allowances()`);
    expect(await accountLots(trial)).toHaveLength(0);

    // That trial buys a plan: its first month is granted in full, and what was
    // left of the trial's calendar lot expires instead of adding up.
    await credit(trial, 2900);
    await purchase(trial, proId);
    expect(await accountLots(trial)).toHaveLength(1);
    expect((await one(
      `SELECT state FROM public.workspace_ai_balance_lots WHERE workspace_id = $1 AND billing_cycle_id = $2`, [trial, month])).state)
      .toBe('EXPIRED');
  });

  it('a change can always be cancelled, even when the current plan is no longer sold', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 2900);
    await purchase(ws, proId);
    await fn(`SELECT public.billing_account_schedule_change($1, $2, NULL) AS r`, [ws, freeId]);
    await q(`UPDATE public.billing_plans SET prices = '{}' WHERE id = $1`, [proId]);
    try {
      expect(await fn(`SELECT public.billing_account_schedule_change($1, $2, 'monthly') AS r`, [ws, proId]))
        .toMatchObject({ action: 'change_cancelled' });
    } finally {
      await q(`UPDATE public.billing_plans SET prices = $2 WHERE id = $1`, [proId, JSON.stringify({ USD: PRO })]);
    }
  });

  it('a gateway payment for a purpose is spent on it; if it can no longer be done, the money stays', async () => {
    const ws = await makeWorkspace();
    const pay = async (purpose: string, detail: Row, net: number) => {
      const p = await one(
        `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, purpose, purpose_detail)
         VALUES ($1, 'paddle_sandbox', 'USD', $2, $2, $3, $4) RETURNING id`, [ws, net, purpose, JSON.stringify(detail)]);
      await q(`SELECT public.billing_account_record_verification($1, $2, 'USD', $3)`, [p.id, net, `txn_${randomUUID()}`]);
      return fn(`SELECT public.billing_account_settle_payment($1) AS r`, [p.id]);
    };
    const bought = await pay('plan', { plan_id: proId, billing_interval: 'monthly' }, 2900);
    expect(bought.purpose_result).toMatchObject({ action: 'purchase', plan_id: proId });
    expect(bought.balance_minor).toBe(0);
    expect((await sub(ws)).plan_id).toBe(proId);
    expect((await ledger(ws)).map((l) => l.kind)).toEqual(['topup', 'plan']);

    const upgraded = await pay('upgrade', { plan_id: bizId }, 7000);
    expect(upgraded.purpose_result).toMatchObject({ action: 'upgraded', plan_id: bizId });

    // Upgrading to the plan it already has: the money stays in the balance.
    const stale = await pay('upgrade', { plan_id: proId }, 1000);
    expect(String((stale.purpose_result as Row).error)).toMatch(/billing_not_an_upgrade/);
    expect(await balanceOf(ws)).toBe(1000);
    expect((await sub(ws)).plan_id).toBe(bizId);
  });

  it('every month of a yearly period gets the plan\'s AI credit once, never twice', async () => {
    const ws = await makeWorkspace();
    await credit(ws, 29000);
    await purchase(ws, proId, 'yearly');
    expect(await lots(ws)).toHaveLength(1);
    // Three months and a day into the year: month 3 is funded by the job.
    await shiftPeriod(ws, 0, 'yearly');
    await q(
      `UPDATE public.workspace_subscriptions
          SET current_period_start = public.billing_add_months(now() - interval '1 day', -3),
              current_period_end = public.billing_add_months(public.billing_add_months(now() - interval '1 day', -3), 12)
        WHERE workspace_id = $1`, [ws]);
    // The first lot covered a different month; drop it out of the way.
    await q(`UPDATE public.workspace_ai_balance_lots SET expires_at = now() - interval '40 days' WHERE workspace_id = $1`, [ws]);
    expect(await one(`SELECT public.billing_account_grant_due_allowances() AS n`).then((r) => Number(r.n))).toBeGreaterThanOrEqual(1);
    const granted = (await lots(ws)).filter((l) => new Date(l.expires_at as string).getTime() > Date.now());
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({ allowance_source: 'plan', amount: 300_000 });
    // The job again: nothing new.
    await one(`SELECT public.billing_account_grant_due_allowances() AS n`);
    expect((await lots(ws)).filter((l) => new Date(l.expires_at as string).getTime() > Date.now())).toHaveLength(1);
  });

  it('a month another path already funded (billing v2\'s own cycle) is not funded again', async () => {
    const ws = await makeWorkspace();
    const start = new Date(Date.now() - 5 * 86_400_000).toISOString();
    await q(
      `INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status, billing_interval, current_period_start, current_period_end)
       VALUES ($1, $2, 'active', 'monthly', $3, public.billing_period_end($3::timestamptz, 'monthly'))`, [ws, proId, start]);
    await q(`SELECT public.ai_grant_allowance($1, 300000, 'cycle:v2-own', 'plan', now() + interval '25 days', $2)`, [ws, `v2-${ws}`]);
    expect(Number((await one(
      `SELECT public.billing_account_grant_month($1, $2, $3::timestamptz, public.billing_period_end($3::timestamptz, 'monthly')) AS n`,
      [ws, proId, start])).n)).toBe(0);
    expect(await lots(ws)).toHaveLength(1);
  });

  it('the billing emails exist for both editions in fa/en/tr, and a second apply adds or changes nothing', async () => {
    const slugs = ['billing_renewal_reminder', 'billing_renewed', 'billing_expired', 'billing_plan_changed', 'billing_change_scheduled',
      'billing_payment_receipt', 'billing_plan_activated', 'billing_trial_ending', 'billing_trial_ended'];
    const rows = await q(
      `SELECT edition, slug, locale, html_body FROM public.email_templates WHERE workspace_id IS NULL AND slug = ANY($1) ORDER BY 1, 2, 3`, [slugs]);
    expect(rows).toHaveLength(slugs.length * 2 * 3);
    expect(rows.filter((r) => r.locale === 'fa').every((r) => String(r.html_body).includes('dir="rtl"'))).toBe(true);

    await q(`UPDATE public.email_templates SET subject = 'EDITED' WHERE workspace_id IS NULL AND edition = 'iran' AND slug = 'billing_renewed' AND locale = 'fa'`);
    const before = Number((await one(`SELECT count(*) AS n FROM public.email_templates`)).n);
    await applyMigrationSql(db, readFileSync(resolve(DIR, FILE), 'utf8'));
    expect(Number((await one(`SELECT count(*) AS n FROM public.email_templates`)).n)).toBe(before);
    expect((await one(
      `SELECT subject FROM public.email_templates WHERE workspace_id IS NULL AND edition = 'iran' AND slug = 'billing_renewed' AND locale = 'fa'`,
    )).subject).toBe('EDITED');
  });

  it('only service_role reaches the billing functions', async () => {
    for (const f of [
      'public.billing_account_purchase_plan(uuid, uuid, text, text, uuid)',
      'public.billing_account_renew(uuid, uuid, timestamptz, bigint)',
      'public.billing_account_v2_next_period(uuid)',
      'public.billing_account_admin_replaced(uuid)',
      'public.billing_account_refund_payment(uuid, text, bigint)',
      'public.billing_account_upgrade(uuid, uuid, uuid)',
      'public.billing_account_schedule_change(uuid, uuid, text, uuid)',
      'public.billing_account_process_due(uuid)',
      'public.billing_account_grant_due_allowances()',
      'public.billing_account_write_subscription(uuid, uuid, text, timestamptz, timestamptz, text, text, uuid, jsonb)',
    ]) {
      const r = await one(
        `SELECT has_function_privilege('anon', $1, 'execute') AS anon,
                has_function_privilege('authenticated', $1, 'execute') AS auth,
                has_function_privilege('service_role', $1, 'execute') AS svc`, [f]);
      expect(r, f).toEqual({ anon: false, auth: false, svc: true });
    }
  });
});
