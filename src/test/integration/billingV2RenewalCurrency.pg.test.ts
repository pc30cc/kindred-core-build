// @vitest-environment node
/**
 * 255 — renewals in the currency the customer pays in, and no paid plan
 * renewed for free, on a database built by the whole chain.
 *
 * The chain is applied up to 254 first. Every IRR scenario below runs there,
 * against the renewal issuer, free-period path and wallet functions as 118 and
 * 115 left them, and its complete effect is recorded: the issuer's result,
 * the invoice rows, their lines, the service periods, the subscription, the
 * audit rows and the wallet. Then 255 is applied (twice) and every scenario
 * runs again on fresh, identical fixtures: the record must be identical,
 * value for value, ids and wall-clock stamps aside.
 *
 * After that, what 255 changes:
 *   - a renewal is priced in, and records, the currency of the invoice behind
 *     the active period, or the one chosen for a pending plan change; its
 *     line is in English;
 *   - a paid plan with no price (or a zero price) in that currency gets no
 *     invoice and no free period: the issuer fails loudly and the scheduler
 *     records the failure, and picks the renewal up once the price is set;
 *   - billing_v2_ensure_free_period serves only a plan free in every
 *     currency, and the plan the next period is for;
 *   - an unpaid renewal invoice in the wrong currency is voided and reissued;
 *   - the Rial wallet never pays an invoice in another currency;
 *   - same signatures, security, search_path and grants; 255 runs twice.
 *
 * Its own database (CREATE DATABASE on the TEST_DATABASE_URL server), as
 * productionParity251.pg.test.ts. Skipped without TEST_DATABASE_URL;
 * REQUIRE_BILLING_DB=1 makes that a failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_BILLING_DB === '1' && !DSN) {
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the 255 renewal currency tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `renewal255_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '255_billing_v2_renewal_currency.sql';
const DAY = 86_400_000;
// Every fixture is placed relative to ONE instant, so that the run before 255
// and the run after it produce the same timestamps.
const BASE = Math.floor(Date.now() / 1000) * 1000;
const at = (days: number): string => new Date(BASE + days * DAY).toISOString();

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

// ── Fixtures ────────────────────────────────────────────────────────────────

const planLabels = new Map<string, string>();

async function makeWorkspace(): Promise<string> {
  const id = randomUUID();
  const owner = randomUUID();
  await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
  await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, $2, $2, $3)`, [
    id, `ws-${id.slice(0, 8)}`, owner,
  ]);
  await db.query(
    `INSERT INTO public.billing_v2_rollout (workspace_id, state, region, activated_at)
     VALUES ($1, 'v2_active', 'IR', now())
     ON CONFLICT (workspace_id) DO UPDATE SET state = 'v2_active'`,
    [id],
  );
  return id;
}

type Prices = Record<string, { monthly?: number; yearly?: number }>;

async function makePlan(name: string, prices: Prices, o: { isFree?: boolean; allowance?: number } = {}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO public.billing_plans (id, name, slug, prices, limits, default_currency, is_free)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'IRR', $6)`,
    [id, name, `${name.toLowerCase()}-${id.slice(0, 8)}`, JSON.stringify(prices),
      JSON.stringify({ ai_credits_per_month: o.allowance ?? 0 }), o.isFree ?? false],
  );
  planLabels.set(id, `PLAN:${name}`);
  return id;
}

interface Sub { id: string; workspace_id: string }

async function makeSubscription(
  ws: string, planId: string, o: { start: string; end: string; interval?: 'monthly' | 'yearly' },
): Promise<Sub> {
  return (await one(
    `INSERT INTO public.workspace_subscriptions
       (workspace_id, plan_id, status, billing_interval, current_period_start, current_period_end,
        next_invoice_at, billing_engine_version)
     VALUES ($1, $2, 'active', $3, $4, $5, $5, 'v2') RETURNING id, workspace_id`,
    [ws, planId, o.interval ?? 'monthly', o.start, o.end],
  )) as unknown as Sub;
}

/** Pays an open invoice through a gateway, the way a verified callback does, and applies it. */
async function payAndApply(ws: string, invoiceId: string): Promise<void> {
  const inv = await one(`SELECT amount_due_irr, currency FROM public.billing_invoices WHERE id = $1`, [invoiceId]);
  const pay = await one(
    `INSERT INTO public.billing_payments (workspace_id, amount, currency, status, provider_name)
     VALUES ($1, $2, $3, 'succeeded', 'test') RETURNING id`,
    [ws, inv.amount_due_irr, inv.currency],
  );
  await db.query(`SELECT public.billing_settle_invoice($1, $2, 'gateway', $3, $4, NULL)`, [
    invoiceId, inv.amount_due_irr, `cmd:${randomUUID()}`, pay.id,
  ]);
  await db.query(`SELECT public.billing_apply_invoice_effects($1)`, [invoiceId]);
}

/**
 * The period [start, end) bought with a first-purchase invoice in `currency`,
 * as server/services/billing/invoice/issue.ts writes one, paid and applied:
 * it becomes the active period.
 */
async function buyPeriod(
  ws: string, sub: Sub, planId: string, currency: string, amount: number,
  o: { start: string; end: string; interval?: 'monthly' | 'yearly' },
): Promise<string> {
  const plan = (await one(`SELECT to_jsonb(p) AS j FROM public.billing_plans p WHERE id = $1`, [planId])).j as Row;
  const interval = o.interval ?? 'monthly';
  const snapshot = {
    action_type: 'plan_new', source_plan_id: null, target_plan_id: planId, billing_interval: interval,
    effective_at: o.start, period_start: o.start, period_end: o.end,
    plan_snapshot: plan, limits_snapshot: plan.limits ?? {}, ai_allowance_irr: 0, proration: null,
  };
  const inv = await one(
    `INSERT INTO public.billing_invoices
       (workspace_id, subscription_id, invoice_number, invoice_type, status, currency,
        subtotal_irr, total_irr, amount_due_irr, plan_id, plan_name_snapshot, billing_interval,
        period_start, period_end, effect_snapshot, metadata)
     VALUES ($1, $2, public.billing_v2_document_number(), 'new_subscription', 'draft', $3,
             $4, $4, $4, $5, $6, $7, $8, $9, $10::jsonb, '{"origin":"test"}'::jsonb)
     RETURNING id`,
    [ws, sub.id, currency, amount, planId, plan.name, interval, o.start, o.end, JSON.stringify(snapshot)],
  );
  await db.query(`UPDATE public.billing_invoices SET status = 'open', issued_at = now() WHERE id = $1`, [inv.id]);
  await payAndApply(ws, inv.id as string);
  return inv.id as string;
}

async function fundWallet(ws: string, amount: number): Promise<void> {
  await db.query(
    `INSERT INTO public.billing_wallet_accounts (workspace_id) VALUES ($1) ON CONFLICT (workspace_id) DO NOTHING`, [ws],
  );
  await db.query(`SELECT public.billing_wallet_append($1, 'deposit', $2, $3, 'test', NULL, NULL, NULL, NULL)`, [
    ws, amount, `fund:${randomUUID()}`,
  ]);
}

const issue = async (ws: string, force = false): Promise<unknown> =>
  (await one(`SELECT public.billing_v2_issue_renewal_invoice($1, $2) AS r`, [ws, force])).r;

const renewals = (ws: string): Promise<Row[]> =>
  q(`SELECT * FROM public.billing_invoices
      WHERE workspace_id = $1 AND invoice_type = 'subscription_renewal' ORDER BY created_at`, [ws]);

const linesOf = (invoiceId: string): Promise<Row[]> =>
  q(`SELECT * FROM public.billing_invoice_lines WHERE invoice_id = $1 ORDER BY sort_order`, [invoiceId]);

// ── Record of everything a scenario did ─────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Identity and wall-clock columns: they differ between any two runs.
const VOLATILE = new Set([
  'id', 'created_at', 'updated_at', 'issued_at', 'voided_at', 'paid_at', 'activated_at', 'completed_at',
  'frozen_at', 'invoice_number', 'slug', 'past_due_at', 'past_due_since', 'grace_period_ends_at',
  'free_fallback_at', 'billing_v2_effective_at', 'command_key', 'applied_at', 'granted_at',
]);

function normalize(value: unknown, labels: Map<string, string>, key?: string): unknown {
  if (key && VOLATILE.has(key)) return '<volatile>';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    if (labels.has(value)) return labels.get(value);
    return UUID.test(value) ? '<uuid>' : value;
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, labels));
  if (value && typeof value === 'object') {
    const obj = value as Row;
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, normalize(obj[k], labels, k)]));
  }
  return value;
}

async function record(ws: string, result: unknown): Promise<unknown> {
  const labels = new Map<string, string>([[ws, 'WS'], ...planLabels]);
  const sub = await one(
    `SELECT id, plan_id, status, billing_interval, current_period_id, current_period_start, current_period_end,
            next_invoice_at, pending_change_type, next_plan_id
       FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws],
  );
  if (sub) labels.set(sub.id as string, 'SUB');
  const invoices = await q(`SELECT * FROM public.billing_invoices WHERE workspace_id = $1 ORDER BY created_at, period_start`, [ws]);
  invoices.forEach((inv, i) => labels.set(inv.id as string, `INV${i + 1}`));
  const periods = await q(`SELECT * FROM public.billing_subscription_periods WHERE workspace_id = $1 ORDER BY period_start, created_at`, [ws]);
  periods.forEach((p, i) => labels.set(p.id as string, `PER${i + 1}`));
  const lines = await q(
    `SELECT invoice_id, line_type, description, quantity, unit_amount_irr, amount_irr, plan_id, sort_order, metadata
       FROM public.billing_invoice_lines WHERE invoice_id = ANY($1::uuid[])`,
    [invoices.map((i) => i.id)],
  );
  const audit = await q(`SELECT event, reason, details FROM public.billing_v2_audit WHERE workspace_id = $1`, [ws]);
  const wallet = await q(`SELECT currency, available_balance_irr FROM public.billing_wallet_accounts WHERE workspace_id = $1`, [ws]);
  const ledger = await q(
    `SELECT entry_type, amount_irr, balance_after_irr, invoice_id, reason FROM public.billing_wallet_ledger WHERE workspace_id = $1`, [ws],
  );
  const sorted = (rows: Row[]) => rows.map((r) => normalize(r, labels)).sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    result: normalize(result, labels),
    subscription: normalize(sub, labels),
    invoices: invoices.map((r) => normalize(r, labels)),
    lines: sorted(lines),
    periods: periods.map((r) => normalize(r, labels)),
    audit: sorted(audit),
    wallet: { accounts: sorted(wallet), ledger: sorted(ledger) },
  };
}

// ── IRR: the same before 255 and after it ───────────────────────────────────

interface Scenario { name: string; run: () => Promise<unknown> }

const IRR_SCENARIOS: Scenario[] = [
  {
    name: 'monthly renewal of a subscription with no bought period',
    run: async () => {
      const ws = await makeWorkspace();
      const plan = await makePlan('Pro', { IRR: { monthly: 1_500_000, yearly: 15_000_000 } }, { allowance: 400_000 });
      await makeSubscription(ws, plan, { start: at(-25), end: at(5) });
      return record(ws, await issue(ws));
    },
  },
  {
    name: 'renewal after a period bought in IRR, on a plan also priced in USD',
    run: async () => {
      const ws = await makeWorkspace();
      const plan = await makePlan('Dual', { IRR: { monthly: 2_000_000, yearly: 20_000_000 }, USD: { monthly: 2900, yearly: 29000 } });
      const sub = await makeSubscription(ws, plan, { start: at(-25), end: at(5) });
      await buyPeriod(ws, sub, plan, 'IRR', 2_000_000, { start: at(-25), end: at(5) });
      return record(ws, await issue(ws));
    },
  },
  {
    name: 'yearly renewal',
    run: async () => {
      const ws = await makeWorkspace();
      const plan = await makePlan('Yearly', { IRR: { monthly: 1_000_000, yearly: 10_000_000 } }, { allowance: 300_000 });
      await makeSubscription(ws, plan, { start: at(-360), end: at(5), interval: 'yearly' });
      return record(ws, await issue(ws));
    },
  },
  {
    name: 'a pending downgrade between two IRR plans',
    run: async () => {
      const ws = await makeWorkspace();
      const big = await makePlan('Big', { IRR: { monthly: 3_000_000 } }, { allowance: 900_000 });
      const small = await makePlan('Small', { IRR: { monthly: 1_000_000 } }, { allowance: 100_000 });
      await makeSubscription(ws, big, { start: at(-25), end: at(5) });
      await db.query(`UPDATE public.workspace_subscriptions SET pending_change_type = 'downgrade', next_plan_id = $2 WHERE workspace_id = $1`, [ws, small]);
      return record(ws, await issue(ws, true));
    },
  },
  {
    name: 'a plan change before payment voids and reissues, then replays',
    run: async () => {
      const ws = await makeWorkspace();
      const a = await makePlan('A', { IRR: { monthly: 2_000_000 } });
      const b = await makePlan('B', { IRR: { monthly: 5_000_000 } });
      await makeSubscription(ws, a, { start: at(-25), end: at(5) });
      const first = await issue(ws);
      await db.query(
        `UPDATE public.workspace_subscriptions
            SET pending_change_type = 'upgrade', next_plan_id = $2, next_invoice_at = current_period_end
          WHERE workspace_id = $1`, [ws, b],
      );
      const second = await issue(ws, true);
      const third = await issue(ws, true);
      return record(ws, [first, second, third]);
    },
  },
  {
    name: 'a free plan rolls forward with no invoice',
    run: async () => {
      const ws = await makeWorkspace();
      const free = await makePlan('Free', { IRR: { monthly: 0, yearly: 0 }, USD: { monthly: 0, yearly: 0 } }, { isFree: true, allowance: 50_000 });
      await makeSubscription(ws, free, { start: at(-31), end: at(-1 / 24) });
      return record(ws, await issue(ws));
    },
  },
  {
    name: 'the wallet pays a due IRR renewal',
    run: async () => {
      const ws = await makeWorkspace();
      const plan = await makePlan('Due', { IRR: { monthly: 1_000_000 } });
      await makeSubscription(ws, plan, { start: at(-30), end: at(-1 / 24) });
      const issued = await issue(ws);
      await fundWallet(ws, 2_000_000);
      const [inv] = await renewals(ws);
      const paid = (await one(`SELECT public.billing_v2_wallet_autopay_invoice($1) AS r`, [inv.id])).r;
      return record(ws, [issued, paid]);
    },
  },
  {
    name: 'a due IRR renewal the wallet cannot cover goes past due',
    run: async () => {
      const ws = await makeWorkspace();
      const plan = await makePlan('Short', { IRR: { monthly: 1_000_000 } });
      await makeSubscription(ws, plan, { start: at(-30), end: at(-1 / 24) });
      const issued = await issue(ws);
      await fundWallet(ws, 100);
      const [inv] = await renewals(ws);
      const due = (await one(`SELECT public.billing_v2_process_due_invoice($1) AS r`, [inv.id])).r;
      return record(ws, [issued, due]);
    },
  },
  {
    name: 'a manual wallet payment of an IRR invoice',
    run: async () => {
      const ws = await makeWorkspace();
      const plan = await makePlan('Manual', { IRR: { monthly: 600_000 } });
      await makeSubscription(ws, plan, { start: at(-25), end: at(5) });
      const issued = await issue(ws);
      await fundWallet(ws, 5_000_000);
      const [inv] = await renewals(ws);
      const paid = (await one(`SELECT public.billing_wallet_pay_invoice($1, NULL) AS r`, [inv.id])).r;
      return record(ws, [issued, paid]);
    },
  },
];

const FUNCTIONS = [
  'public.billing_v2_issue_renewal_invoice(uuid,boolean)',
  'public.billing_v2_ensure_free_period(uuid)',
  'public.billing_v2_wallet_autopay_invoice(uuid)',
  'public.billing_v2_run_wallet_autopay(integer)',
  'public.billing_wallet_pay_invoice(uuid,uuid)',
];

const functionAttributes = (): Promise<Row[]> =>
  q(
    `SELECT p.oid::regprocedure::text AS fn, p.prosecdef, p.proconfig, p.provolatile, p.prorettype::regtype::text AS returns,
            pg_get_function_arguments(p.oid) AS args, pg_get_userbyid(p.proowner) AS owner,
            (SELECT array_agg(a ORDER BY a) FROM unnest(p.proacl::text[]) a) AS acl
       FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`,
    [FUNCTIONS],
  );

suite('255 — renewal currency and no free renewal of a paid plan (whole chain, PostgreSQL)', () => {
  const before = new Map<string, unknown>();
  let attributesBefore: Row[] = [];
  // Fixtures made before 255, carried across it.
  const old: Record<string, string> = {};

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

    for (const s of IRR_SCENARIOS) before.set(s.name, await s.run());
    attributesBefore = await functionAttributes();

    // What the chain did before 255, kept to show 255 changes it.
    {
      // A plan sold only in USD, on a subscription that never bought a period:
      // the missing IRR price read as 0 and opened a free period of the plan.
      const ws = await makeWorkspace();
      const plan = await makePlan('UsdOnlyOld', { USD: { monthly: 4900, yearly: 49000 } }, { allowance: 70_000 });
      await makeSubscription(ws, plan, { start: at(-31), end: at(-1 / 24) });
      old.giveawayResult = JSON.stringify(await issue(ws));
      old.giveawayWs = ws;
    }
    {
      // A period bought in USD on a plan also priced in IRR: renewed in IRR.
      const ws = await makeWorkspace();
      const plan = await makePlan('DualOld', { IRR: { monthly: 2_000_000 }, USD: { monthly: 2900 } });
      const sub = await makeSubscription(ws, plan, { start: at(-25), end: at(5) });
      await buyPeriod(ws, sub, plan, 'USD', 2900, { start: at(-25), end: at(5) });
      await issue(ws);
      old.wrongCurrencyWs = ws;
    }
    {
      // A scheduled downgrade from a paid plan to a free one.
      const ws = await makeWorkspace();
      const paid = await makePlan('PaidOld', { IRR: { monthly: 2_000_000 } });
      const free = await makePlan('FreeOld', { IRR: { monthly: 0, yearly: 0 } }, { isFree: true });
      await makeSubscription(ws, paid, { start: at(-31), end: at(-1 / 24) });
      await db.query(`UPDATE public.workspace_subscriptions SET pending_change_type = 'downgrade', next_plan_id = $2 WHERE workspace_id = $1`, [ws, free]);
      await issue(ws);
      old.downgradeWs = ws;
      old.downgradePaidPlan = paid;
    }

    const migration = readFileSync(resolve(DIR, FILE), 'utf8');
    await applyMigrationSql(db, migration);
    await applyMigrationSql(db, migration);
    for (const file of files.filter((f) => f > FILE)) {
      await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
    }
  }, 600_000);

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  // ── IRR is unchanged ──────────────────────────────────────────────────────

  it.each(IRR_SCENARIOS.map((s) => [s.name, s] as const))('IRR, the same as before 255: %s', async (_name, s) => {
    expect(await s.run()).toEqual(before.get(s.name));
  });

  it('the IRR record is a real one (invoice in IRR, Persian line, the IRR price)', () => {
    const rec = before.get(IRR_SCENARIOS[0].name) as { invoices: Row[]; lines: Row[]; result: Row };
    expect(rec.invoices).toHaveLength(1);
    expect(rec.invoices[0]).toMatchObject({ currency: 'IRR', total_irr: '1500000', status: 'open', invoice_type: 'subscription_renewal' });
    expect(rec.lines[0]).toMatchObject({ description: 'Pro — ماهانه', amount_irr: '1500000' });
    expect(rec.result).not.toHaveProperty('currency');
  });

  it('keeps every signature, SECURITY DEFINER, search_path, owner and grant', async () => {
    expect(await functionAttributes()).toEqual(attributesBefore);
    for (const fn of FUNCTIONS) {
      for (const role of ['anon', 'authenticated']) {
        const row = await one(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
        expect(`${role}:${fn}:${row.ok}`).toBe(`${role}:${fn}:false`);
      }
      expect((await one(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [fn])).ok).toBe(true);
    }
  });

  it('runs again without changing anything', async () => {
    const defs = async () => q(`SELECT md5(pg_get_functiondef(f::regprocedure)) AS h FROM unnest($1::text[]) f ORDER BY f`, [FUNCTIONS]);
    const first = await defs();
    await applyMigrationSql(db, readFileSync(resolve(DIR, FILE), 'utf8'));
    expect(await defs()).toEqual(first);
    const col = await q(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'workspace_subscriptions' AND column_name = 'pending_change_currency'`,
    );
    expect(col).toHaveLength(1);
    const chk = await q(`SELECT 1 FROM pg_constraint WHERE conname = 'workspace_subscriptions_pending_change_currency_chk'`);
    expect(chk).toHaveLength(1);
  });

  // ── A renewal in the currency the customer pays in ────────────────────────

  it('renews a USD-only plan in USD: the USD price, an English line, no free period', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan('Team', { USD: { monthly: 4900, yearly: 49000 } }, { allowance: 70_000 });
    const sub = await makeSubscription(ws, plan, { start: at(-25), end: at(5) });
    await buyPeriod(ws, sub, plan, 'USD', 4900, { start: at(-25), end: at(5) });

    const res = (await issue(ws)) as Row;
    expect(res).toMatchObject({ amount_irr: 4900, currency: 'USD', replayed: false });

    const [inv] = await renewals(ws);
    expect(inv).toMatchObject({
      currency: 'USD', status: 'open', subtotal_irr: '4900', total_irr: '4900', amount_due_irr: '4900',
      plan_id: plan, billing_interval: 'monthly',
    });
    expect(new Date(inv.period_start as string).toISOString()).toBe(at(5));
    expect(new Date(inv.due_at as string).toISOString()).toBe(at(5));
    expect((inv.effect_snapshot as Row).ai_allowance_irr).toBe(70_000);
    const [line] = await linesOf(inv.id as string);
    expect(line).toMatchObject({ description: 'Team — monthly', unit_amount_irr: '4900', amount_irr: '4900' });

    const free = await q(`SELECT 1 FROM public.billing_subscription_periods WHERE workspace_id = $1 AND source = 'free_plan'`, [ws]);
    expect(free).toHaveLength(0);
    const audit = await one(`SELECT details FROM public.billing_v2_audit WHERE workspace_id = $1 AND event = 'renewal_invoice_issued'`, [ws]);
    expect(audit.details).toMatchObject({ amount_irr: 4900, currency: 'USD' });
  });

  it('a plan priced in both currencies renews a USD period at its USD price, not its Rial price', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan('DualUsd', { IRR: { monthly: 2_000_000 }, USD: { monthly: 2900 } });
    const sub = await makeSubscription(ws, plan, { start: at(-25), end: at(5) });
    await buyPeriod(ws, sub, plan, 'USD', 2900, { start: at(-25), end: at(5) });
    await db.query(`SELECT public.billing_v2_run_invoice_scheduler(500)`);
    const [inv] = await renewals(ws);
    expect(inv).toMatchObject({ currency: 'USD', total_irr: '2900' });
  });

  it('renews a yearly EUR period in EUR at the yearly EUR price', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan('Euro', { IRR: { yearly: 90_000_000 }, EUR: { monthly: 2700, yearly: 27000 } });
    const sub = await makeSubscription(ws, plan, { start: at(-360), end: at(5), interval: 'yearly' });
    await buyPeriod(ws, sub, plan, 'EUR', 27000, { start: at(-360), end: at(5), interval: 'yearly' });
    await issue(ws);
    const [inv] = await renewals(ws);
    expect(inv).toMatchObject({ currency: 'EUR', total_irr: '27000', billing_interval: 'yearly' });
    expect((await linesOf(inv.id as string))[0].description).toBe('Euro — yearly');
  });

  // ── No price in that currency: no invoice, no free period ─────────────────

  async function usdPeriodOnPlan(prices: Prices) {
    const ws = await makeWorkspace();
    const plan = await makePlan('NoUsd', prices, { allowance: 60_000 });
    const sub = await makeSubscription(ws, plan, { start: at(-25), end: at(5) });
    await buyPeriod(ws, sub, plan, 'USD', 2900, { start: at(-25), end: at(5) });
    const periods = await q(`SELECT id FROM public.billing_subscription_periods WHERE workspace_id = $1`, [ws]);
    return { ws, plan, periods: periods.length };
  }

  it('a paid plan with no USD price: no invoice, no free period, the issuer fails loudly', async () => {
    const { ws, plan, periods } = await usdPeriodOnPlan({ IRR: { monthly: 2_000_000 } });
    await expect(issue(ws, true)).rejects.toThrow(`renewal_price_unavailable:USD:monthly:${plan}`);
    expect(await renewals(ws)).toHaveLength(0);
    expect(await q(`SELECT 1 FROM public.billing_subscription_periods WHERE workspace_id = $1`, [ws])).toHaveLength(periods);

    // Nothing is raised before the window is due.
    const early = await makeWorkspace();
    const earlyPlan = await makePlan('NoUsdEarly', { IRR: { monthly: 2_000_000 } });
    const earlySub = await makeSubscription(early, earlyPlan, { start: at(-10), end: at(20) });
    await buyPeriod(early, earlySub, earlyPlan, 'USD', 2900, { start: at(-10), end: at(20) });
    expect(await issue(early, false)).toMatchObject({ skipped: 'not_yet_eligible' });
  });

  it('a USD price of 0 on a paid plan is the same as none', async () => {
    const { ws, plan } = await usdPeriodOnPlan({ IRR: { monthly: 2_000_000 }, USD: { monthly: 0 } });
    await expect(issue(ws, true)).rejects.toThrow(`renewal_price_unavailable:USD:monthly:${plan}`);
    expect(await q(`SELECT 1 FROM public.billing_subscription_periods WHERE workspace_id = $1 AND source = 'free_plan'`, [ws]))
      .toHaveLength(0);
  });

  it('the scheduler records the failure, retries it, and issues the invoice once the price is set', async () => {
    const { ws, plan } = await usdPeriodOnPlan({ IRR: { monthly: 2_000_000 } });
    await db.query(`SELECT public.billing_v2_run_invoice_scheduler(500)`);

    const failed = await q(`SELECT reason FROM public.billing_v2_audit WHERE workspace_id = $1 AND event = 'renewal_invoice_failed'`, [ws]);
    expect(failed.map((r) => r.reason)).toEqual([`renewal_price_unavailable:USD:monthly:${plan}`]);
    const job = await one(`SELECT status, last_error FROM public.billing_v2_jobs WHERE job_type = 'renewal_invoice' AND workspace_id = $1`, [ws]);
    expect(job).toMatchObject({ status: 'pending' });
    expect(job.last_error).toContain('renewal_price_unavailable');
    expect(await renewals(ws)).toHaveLength(0);

    await db.query(`UPDATE public.billing_plans SET prices = prices || '{"USD":{"monthly":3100}}'::jsonb WHERE id = $1`, [plan]);
    await db.query(`UPDATE public.billing_v2_jobs SET next_attempt_at = now() WHERE job_type = 'renewal_invoice' AND workspace_id = $1`, [ws]);
    await db.query(`SELECT public.billing_v2_run_invoice_scheduler(500)`);
    const [inv] = await renewals(ws);
    expect(inv).toMatchObject({ currency: 'USD', total_irr: '3100', status: 'open' });
  });

  it('IRR: a plan sold only in USD no longer rolls forward as a free period of itself', async () => {
    // Before 255 (recorded above):
    const oldPeriods = await q(
      `SELECT source, plan_id FROM public.billing_subscription_periods WHERE workspace_id = $1`, [old.giveawayWs],
    );
    expect(JSON.parse(old.giveawayResult)).toMatchObject({ free: true });
    expect(oldPeriods).toEqual([{ source: 'free_plan', plan_id: expect.any(String) }]);

    // After 255, the same subscription:
    const ws = await makeWorkspace();
    const plan = await makePlan('UsdOnly', { USD: { monthly: 4900, yearly: 49000 } }, { allowance: 70_000 });
    await makeSubscription(ws, plan, { start: at(-31), end: at(-1 / 24) });
    await expect(issue(ws)).rejects.toThrow(`renewal_price_unavailable:IRR:monthly:${plan}`);
    expect(await q(`SELECT 1 FROM public.billing_subscription_periods WHERE workspace_id = $1`, [ws])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM public.workspace_ai_balance_lots WHERE workspace_id = $1`, [ws])).toHaveLength(0);
  });

  it('billing_v2_ensure_free_period refuses a paid plan and writes nothing', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan('PaidDirect', { IRR: { monthly: 0 }, TRY: { monthly: 99900 } });
    await makeSubscription(ws, plan, { start: at(-31), end: at(-1 / 24) });
    const r = (await one(`SELECT public.billing_v2_ensure_free_period($1) AS r`, [ws])).r;
    expect(r).toEqual({ skipped: 'plan_not_free', plan_id: plan });
    expect(await q(`SELECT 1 FROM public.billing_subscription_periods WHERE workspace_id = $1`, [ws])).toHaveLength(0);
    // is_free says free: served free, as before.
    await db.query(`UPDATE public.billing_plans SET is_free = true WHERE id = $1`, [plan]);
    expect((await one(`SELECT public.billing_v2_ensure_free_period($1) AS r`, [ws])).r).toMatchObject({ free: true });
  });

  it('a scheduled downgrade to a free plan lands on the free plan, not on a free period of the paid one', async () => {
    // Before 255: the free period was of the PAID plan, and the downgrade was dropped.
    const oldSub = await one(`SELECT plan_id, pending_change_type FROM public.workspace_subscriptions WHERE workspace_id = $1`, [old.downgradeWs]);
    expect(oldSub).toEqual({ plan_id: old.downgradePaidPlan, pending_change_type: null });

    const ws = await makeWorkspace();
    const paid = await makePlan('PaidNow', { IRR: { monthly: 2_000_000 } });
    const free = await makePlan('FreeNow', { IRR: { monthly: 0, yearly: 0 } }, { isFree: true, allowance: 10_000 });
    await makeSubscription(ws, paid, { start: at(-31), end: at(-1 / 24) });
    await db.query(`UPDATE public.workspace_subscriptions SET pending_change_type = 'downgrade', next_plan_id = $2 WHERE workspace_id = $1`, [ws, free]);
    expect(await issue(ws)).toMatchObject({ free: true });
    const period = await one(`SELECT plan_id, source, status FROM public.billing_subscription_periods WHERE workspace_id = $1`, [ws]);
    expect(period).toEqual({ plan_id: free, source: 'free_plan', status: 'active' });
    const sub = await one(`SELECT plan_id, pending_change_type, next_plan_id FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws]);
    expect(sub).toEqual({ plan_id: free, pending_change_type: null, next_plan_id: null });
  });

  // ── A pending plan change keeps the currency chosen for it ────────────────

  async function usdProWithBasicDowngrade(currency: string | null) {
    const ws = await makeWorkspace();
    const pro = await makePlan('ProMulti', { IRR: { monthly: 3_000_000 }, USD: { monthly: 2900 }, EUR: { monthly: 2700 } });
    const basic = await makePlan('BasicMulti', { IRR: { monthly: 1_000_000 }, USD: { monthly: 900 }, EUR: { monthly: 800 } });
    const sub = await makeSubscription(ws, pro, { start: at(-25), end: at(5) });
    await buyPeriod(ws, sub, pro, 'USD', 2900, { start: at(-25), end: at(5) });
    // What applyPlanChange (next_cycle) records.
    await db.query(
      `UPDATE public.workspace_subscriptions
          SET pending_change_type = 'downgrade', next_plan_id = $2, pending_change_currency = $3
        WHERE workspace_id = $1`, [ws, basic, currency],
    );
    return { ws, pro, basic };
  }

  const liveRenewals = async (ws: string) => (await renewals(ws)).filter((i) => i.status !== 'void');

  it('a next-cycle change is invoiced in the currency chosen for it', async () => {
    const { ws, basic } = await usdProWithBasicDowngrade('EUR');
    await issue(ws);
    const [inv] = await liveRenewals(ws);
    expect(inv).toMatchObject({ currency: 'EUR', total_irr: '800', plan_id: basic });
    expect((inv.effect_snapshot as Row).action_type).toBe('plan_downgrade');
    expect((await linesOf(inv.id as string))[0].description).toBe('BasicMulti — monthly');
  });

  it('with no currency recorded, a next-cycle change is invoiced in the currency the period was paid in', async () => {
    const { ws, basic } = await usdProWithBasicDowngrade(null);
    await issue(ws);
    const [inv] = await liveRenewals(ws);
    expect(inv).toMatchObject({ currency: 'USD', total_irr: '900', plan_id: basic });
  });

  it('an unpaid renewal is voided and reissued when the change\'s currency changes, and when the change is cancelled', async () => {
    const { ws, pro, basic } = await usdProWithBasicDowngrade(null);
    await issue(ws);
    expect(await liveRenewals(ws)).toMatchObject([{ currency: 'USD', total_irr: '900' }]);

    // The issuer revisits a window while next_invoice_at points at it, as the
    // Phase C suite drives it.
    await db.query(
      `UPDATE public.workspace_subscriptions SET pending_change_currency = 'EUR', next_invoice_at = current_period_end
        WHERE workspace_id = $1`, [ws],
    );
    await issue(ws);
    expect(await liveRenewals(ws)).toMatchObject([{ currency: 'EUR', total_irr: '800', plan_id: basic }]);
    const voided = await one(
      `SELECT reason, details FROM public.billing_v2_audit WHERE workspace_id = $1 AND event = 'renewal_invoice_voided'`, [ws],
    );
    expect(voided).toMatchObject({
      reason: 'currency_change_before_payment',
      details: { from_currency: 'USD', to_currency: 'EUR' },
    });

    // Cancelled, as cancelPendingPlanChange clears it: back to Pro, in USD.
    await db.query(
      `UPDATE public.workspace_subscriptions
          SET pending_change_type = NULL, next_plan_id = NULL, pending_change_currency = NULL,
              next_invoice_at = current_period_end
        WHERE workspace_id = $1`, [ws],
    );
    await issue(ws);
    expect(await liveRenewals(ws)).toMatchObject([{ currency: 'USD', total_irr: '2900', plan_id: pro }]);
  });

  it('refuses a malformed pending currency', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan('Chk', { IRR: { monthly: 1 } });
    await makeSubscription(ws, plan, { start: at(-25), end: at(5) });
    await expect(
      db.query(`UPDATE public.workspace_subscriptions SET pending_change_currency = 'usd' WHERE workspace_id = $1`, [ws]),
    ).rejects.toThrow(/workspace_subscriptions_pending_change_currency_chk/);
  });

  it('an unpaid renewal issued in IRR for a USD period is voided and reissued in USD', async () => {
    const ws = old.wrongCurrencyWs;
    const [stale] = await renewals(ws);
    expect(stale).toMatchObject({ currency: 'IRR', total_irr: '2000000', status: 'open' });

    await db.query(`UPDATE public.workspace_subscriptions SET next_invoice_at = current_period_end WHERE workspace_id = $1`, [ws]);
    await issue(ws);
    const all = await renewals(ws);
    expect(all.map((i) => [i.currency, i.total_irr, i.status])).toEqual([
      ['IRR', '2000000', 'void'],
      ['USD', '2900', 'open'],
    ]);
    expect((all[0].metadata as Row).void_reason).toBe('currency_change_before_payment');
    // And the same window asked again replays it.
    await db.query(`UPDATE public.workspace_subscriptions SET next_invoice_at = current_period_end WHERE workspace_id = $1`, [ws]);
    expect(await issue(ws)).toMatchObject({ invoice_id: all[1].id, replayed: true });
  });

  // ── The Rial wallet never pays another currency ───────────────────────────

  it('the wallet never pays a USD renewal: auto-pay skips it, a wallet payment is refused, dunning moves it past due', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan('WalletUsd', { USD: { monthly: 2900 } });
    const sub = await makeSubscription(ws, plan, { start: at(-30), end: at(-1 / 24) });
    await buyPeriod(ws, sub, plan, 'USD', 2900, { start: at(-30), end: at(-1 / 24) });
    await issue(ws);
    const [inv] = await renewals(ws);
    expect(inv).toMatchObject({ currency: 'USD', total_irr: '2900', status: 'open' });
    expect(new Date(inv.due_at as string).getTime()).toBeLessThanOrEqual(Date.now());
    await fundWallet(ws, 10_000_000);

    expect((await one(`SELECT public.billing_v2_wallet_autopay_invoice($1) AS r`, [inv.id])).r)
      .toEqual({ skipped: 'currency_not_wallet:USD' });
    await expect(db.query(`SELECT public.billing_wallet_pay_invoice($1, NULL)`, [inv.id]))
      .rejects.toThrow(`invoice_currency_not_wallet:${inv.id}:USD`);

    await db.query(`SELECT public.billing_v2_run_wallet_autopay(500)`);
    const jobs = await q(`SELECT 1 FROM public.billing_v2_jobs WHERE job_type = 'wallet_autopay' AND payload->>'invoice_id' = $1`, [inv.id]);
    expect(jobs).toHaveLength(0);

    const due = (await one(`SELECT public.billing_v2_process_due_invoice($1) AS r`, [inv.id])).r as Row;
    expect(due).toMatchObject({ past_due: true, reason: 'unpaid' });
    expect((await one(`SELECT status FROM public.billing_invoices WHERE id = $1`, [inv.id])).status).toBe('past_due');
    expect((await one(`SELECT status FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws])).status).toBe('past_due');

    const wallet = await one(`SELECT available_balance_irr FROM public.billing_wallet_accounts WHERE workspace_id = $1`, [ws]);
    expect(wallet.available_balance_irr).toBe('10000000');
    expect(await q(`SELECT 1 FROM public.billing_wallet_ledger WHERE workspace_id = $1 AND entry_type = 'invoice_payment'`, [ws]))
      .toHaveLength(0);

    // A card gateway still settles it, in USD minor units.
    await payAndApply(ws, inv.id as string);
    expect((await one(`SELECT status FROM public.billing_invoices WHERE id = $1`, [inv.id])).status).toBe('paid');
  });
});
