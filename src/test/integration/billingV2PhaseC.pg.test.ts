/**
 * Billing Engine V2 — Phase C invariants against real PostgreSQL.
 *
 * Renewal invoice scheduler, wallet auto-pay and the period activation engine
 * decide, unattended, whether a customer is billed twice, served for free or
 * granted AI credit twice. Every property below therefore runs against a live
 * database with the real migration chain applied — never a mock:
 *
 *   - an invoice is issued exactly once per (subscription, window), at the
 *     policy lead time, with catch-up for missed runs
 *   - a pending plan change is reflected; a PAID invoice is never rewritten
 *   - wallet auto-pay is all-or-nothing, due-gated, and loses every race with
 *     a live gateway collection
 *   - a period activates at its start, exactly once, and grants exactly one
 *     plan AI allowance from its frozen snapshot
 *
 * CI-MANDATORY: REQUIRE_BILLING_DB=1 makes a missing TEST_DATABASE_URL a
 * FAILURE, never a skip.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const REQUIRED = process.env.REQUIRE_BILLING_DB === '1';

if (REQUIRED && !DSN) {
  throw new Error(
    'REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — Billing Engine V2 Phase C database tests are mandatory in CI.',
  );
}

const suite = DSN ? describe : describe.skip;

const CHAIN = [
  'database/migrations/016a_selfhost_product_parity_base_tables.sql',
  'database/migrations/073_ai_usage_billing.sql',
  'database/migrations/074_ai_billing_pricing_append_only.sql',
  'database/migrations/103_billing_payment_intents.sql',
  'database/migrations/105_billing_payment_state_machine.sql',
  'database/migrations/106_billing_subscription_applications.sql',
  'database/migrations/107_billing_invoice_numbers.sql',
  'database/migrations/108_billing_proforma_snapshot.sql',
  'database/migrations/109_financial_function_acl_convergence.sql',
  'database/migrations/113_billing_v2_core.sql',
  'database/migrations/114_billing_v2_wallet.sql',
  'database/migrations/115_billing_v2_rpcs.sql',
  'database/migrations/116_billing_v2_backfill.sql',
  'database/migrations/117_billing_v2_rollout.sql',
  'database/migrations/118_billing_v2_schedulers.sql',
];

let client: any;
const q = async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows;
const one = async (sql: string, params?: unknown[]) => (await q(sql, params))[0];

function uuid(): string {
  const h = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${h()}${h()}-${h()}-4${h().slice(1)}-8${h().slice(1)}-${h()}${h()}${h()}`;
}

let hasOwner: boolean | null = null;
async function makeWorkspace(): Promise<string> {
  const id = uuid();
  if (hasOwner === null) {
    hasOwner = Boolean(
      await one(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='workspaces' AND column_name='owner_id'`,
      ),
    );
  }
  if (!hasOwner) {
    await client.query(`INSERT INTO public.workspaces (id, name, slug) VALUES ($1,$2,$3)`, [
      id, `ws-${id.slice(0, 8)}`, `ws-${id.slice(0, 8)}`,
    ]);
  } else {
    const owner = uuid();
    await client.query(`INSERT INTO public.profiles (id, email) VALUES ($1,$2)`, [
      owner, `owner-${owner.slice(0, 8)}@test.local`,
    ]);
    await client.query(
      `INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1,$2,$3,$4)`,
      [id, `ws-${id.slice(0, 8)}`, `ws-${id.slice(0, 8)}`, owner],
    );
  }
  // Phase C only ever acts on workspaces whose authority is V2.
  await client.query(
    `INSERT INTO public.billing_v2_rollout (workspace_id, state, region, activated_at)
     VALUES ($1,'v2_active','IR',now())
     ON CONFLICT (workspace_id) DO UPDATE SET state='v2_active'`,
    [id],
  );
  return id;
}

async function makePlan(opts: { monthly?: number; yearly?: number; allowance?: number }): Promise<string> {
  const id = uuid();
  await client.query(
    `INSERT INTO public.billing_plans (id, name, slug, prices, limits, default_currency, is_free)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'IRR',$6)`,
    [
      id, `plan-${id.slice(0, 6)}`, `plan-${id.slice(0, 6)}`,
      JSON.stringify({ IRR: { monthly: opts.monthly ?? 0, yearly: opts.yearly ?? 0 } }),
      JSON.stringify({ ai_credits_per_month: opts.allowance ?? 0 }),
      (opts.monthly ?? 0) === 0 && (opts.yearly ?? 0) === 0,
    ],
  );
  return id;
}

interface SubOpts {
  planId: string;
  interval?: 'monthly' | 'yearly';
  periodStart: string;
  periodEnd: string;
  status?: string;
  nextInvoiceAt?: string | null;
  pendingChange?: 'upgrade' | 'downgrade' | 'cancel' | null;
  nextPlanId?: string | null;
}

async function makeSubscription(ws: string, o: SubOpts): Promise<any> {
  return one(
    `INSERT INTO public.workspace_subscriptions
       (workspace_id, plan_id, status, billing_interval, current_period_start, current_period_end,
        next_invoice_at, pending_change_type, next_plan_id, billing_engine_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'v2')
     ON CONFLICT (workspace_id) DO UPDATE SET plan_id = EXCLUDED.plan_id
     RETURNING *`,
    [
      ws, o.planId, o.status ?? 'active', o.interval ?? 'monthly',
      o.periodStart, o.periodEnd, o.nextInvoiceAt === undefined ? o.periodEnd : o.nextInvoiceAt,
      o.pendingChange ?? null, o.nextPlanId ?? null,
    ],
  );
}

/** Days from now as an ISO timestamp — every test is relative, never DST-bound. */
function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

async function payInvoiceByGateway(ws: string, invoiceId: string): Promise<any> {
  const inv = await one(`SELECT amount_due_irr FROM public.billing_invoices WHERE id=$1`, [invoiceId]);
  const amount = Number(inv.amount_due_irr);
  const pay = await one(
    `INSERT INTO public.billing_payments (workspace_id, amount, status, provider_name)
     VALUES ($1,$2,'succeeded','test') RETURNING id`,
    [ws, amount],
  );
  return (await one(`SELECT public.billing_settle_invoice($1,$2,'gateway',$3,$4,NULL) AS r`, [
    invoiceId, amount, `cmd:${uuid()}`, pay.id,
  ])).r;
}

async function fundWallet(ws: string, amount: number): Promise<void> {
  await client.query(
    `INSERT INTO public.billing_wallet_accounts (workspace_id) VALUES ($1)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [ws],
  );
  await client.query(`SELECT public.billing_wallet_append($1,'deposit',$2,$3,'test',NULL,NULL,NULL,NULL)`, [
    ws, amount, `fund:${uuid()}`,
  ]);
}

const renewalInvoices = (ws: string) =>
  q(
    `SELECT * FROM public.billing_invoices
      WHERE workspace_id=$1 AND invoice_type='subscription_renewal' AND status <> 'void'
      ORDER BY created_at`,
    [ws],
  );

suite('Billing Engine V2 — Phase C schedulers (PostgreSQL)', () => {
  beforeAll(async () => {
    const { Client } = await import('pg');
    client = new Client({ connectionString: DSN });
    await client.connect();
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await client.query(
        `DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
      );
    }
    for (const file of CHAIN) {
      await client.query(readFileSync(resolve(process.cwd(), file), 'utf8'));
    }
  }, 240_000);

  afterAll(async () => {
    await client?.end();
  });

  // ── Migration ───────────────────────────────────────────────────────────

  it('applies 118 forward and rerunnably', async () => {
    await client.query(readFileSync(resolve(process.cwd(), CHAIN[CHAIN.length - 1]), 'utf8'));
    const tables = await q(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name = ANY($1)`,
      [[
        'billing_v2_policy', 'billing_v2_workspace_policy', 'billing_v2_jobs',
        'billing_v2_worker_health', 'billing_period_allowance_grants',
      ]],
    );
    expect(tables).toHaveLength(5);
  });

  it('keeps the invoice lead time in ONE canonical place, defaulting to 10 days', async () => {
    const ws = await makeWorkspace();
    const pol = (await one(`SELECT public.billing_v2_policy_for($1) AS p`, [ws])).p;
    expect(pol.invoice_lead_time_days).toBe(10);

    await client.query(
      `INSERT INTO public.billing_v2_workspace_policy (workspace_id, invoice_lead_time_days)
       VALUES ($1, 3)`,
      [ws],
    );
    const overridden = (await one(`SELECT public.billing_v2_policy_for($1) AS p`, [ws])).p;
    expect(overridden.invoice_lead_time_days).toBe(3);
  });

  // ── Worker A: renewal invoice scheduler ─────────────────────────────────

  it('issues NO invoice 11 days before the period ends', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000, allowance: 500_000 });
    await makeSubscription(ws, { planId: plan, periodStart: inDays(-19), periodEnd: inDays(11) });

    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    expect(await renewalInvoices(ws)).toHaveLength(0);
  });

  it('issues EXACTLY ONE invoice 10 days before the period ends', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000, allowance: 500_000 });
    await makeSubscription(ws, { planId: plan, periodStart: inDays(-20), periodEnd: inDays(9.5) });

    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    const invoices = await renewalInvoices(ws);
    expect(invoices).toHaveLength(1);
    expect(Number(invoices[0].total_irr)).toBe(1_000_000);
    expect(invoices[0].status).toBe('open');
    expect(invoices[0].effect_snapshot.ai_allowance_irr).toBe(500_000);
  });

  it('catches up a missed run (T-3) without issuing a second document', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 800_000 });
    await makeSubscription(ws, { planId: plan, periodStart: inDays(-27), periodEnd: inDays(3) });

    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    expect(await renewalInvoices(ws)).toHaveLength(1);
  });

  it('is idempotent across five sequential runs', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 900_000 });
    await makeSubscription(ws, { planId: plan, periodStart: inDays(-25), periodEnd: inDays(5) });

    for (let i = 0; i < 5; i += 1) {
      await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    }
    expect(await renewalInvoices(ws)).toHaveLength(1);
  });

  it('issues one invoice under three CONCURRENT scheduler runs', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 700_000 });
    await makeSubscription(ws, { planId: plan, periodStart: inDays(-25), periodEnd: inDays(5) });

    const { Client } = await import('pg');
    const clients = await Promise.all(
      [0, 1, 2].map(async () => {
        const c = new Client({ connectionString: DSN });
        await c.connect();
        return c;
      }),
    );
    const results = await Promise.allSettled(
      clients.map((c) => c.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`)),
    );
    await Promise.all(clients.map((c) => c.end()));

    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(await renewalInvoices(ws)).toHaveLength(1);
  });

  it('uses calendar-safe month math (Jan 31 → Feb 28/29, never +30 days)', async () => {
    const start = await one(
      `SELECT public.billing_v2_add_interval(timestamptz '2025-01-31 00:00:00+00','monthly',1) AS e`,
    );
    expect(new Date(start.e).toISOString().slice(0, 10)).toBe('2025-02-28');

    const leap = await one(
      `SELECT public.billing_v2_add_interval(timestamptz '2024-02-29 00:00:00+00','yearly',1) AS e`,
    );
    expect(new Date(leap.e).toISOString().slice(0, 10)).toBe('2025-02-28');
  });

  it('bills a yearly subscription for the yearly price and a full-year allowance', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000, yearly: 10_000_000, allowance: 300_000 });
    await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(-360), periodEnd: inDays(5),
    });

    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    const [inv] = await renewalInvoices(ws);
    expect(Number(inv.total_irr)).toBe(10_000_000);
    // Documented existing contract: a yearly period carries 12 × monthly
    // allowance, granted ONCE and expiring at period_end.
    expect(inv.effect_snapshot.ai_allowance_irr).toBe(3_600_000);
    const months = (new Date(inv.period_end).getTime() - new Date(inv.period_start).getTime()) / 86_400_000;
    expect(months).toBeGreaterThan(360);
  });

  it('bills the PENDING plan (downgrade) rather than the current one', async () => {
    const ws = await makeWorkspace();
    const big = await makePlan({ monthly: 3_000_000, allowance: 900_000 });
    const small = await makePlan({ monthly: 1_000_000, allowance: 100_000 });
    await makeSubscription(ws, {
      planId: big, periodStart: inDays(-25), periodEnd: inDays(5),
      pendingChange: 'downgrade', nextPlanId: small,
    });

    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    const [inv] = await renewalInvoices(ws);
    expect(Number(inv.total_irr)).toBe(1_000_000);
    expect(inv.effect_snapshot.target_plan_id).toBe(small);
    expect(inv.effect_snapshot.ai_allowance_irr).toBe(100_000);
  });

  it('voids an UNPAID renewal invoice and reissues when the pending plan changes', async () => {
    const ws = await makeWorkspace();
    const a = await makePlan({ monthly: 2_000_000 });
    const b = await makePlan({ monthly: 5_000_000 });
    await makeSubscription(ws, { planId: a, periodStart: inDays(-25), periodEnd: inDays(5) });

    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    const [first] = await renewalInvoices(ws);

    // The customer picks a different plan before paying; the anchor is unchanged.
    await client.query(
      `UPDATE public.workspace_subscriptions
          SET pending_change_type='upgrade', next_plan_id=$2, next_invoice_at=current_period_end
        WHERE workspace_id=$1`,
      [ws, b],
    );
    await client.query(`SELECT public.billing_v2_issue_renewal_invoice($1, true)`, [ws]);

    const live = await renewalInvoices(ws);
    expect(live).toHaveLength(1);
    expect(Number(live[0].total_irr)).toBe(5_000_000);
    const voided = await one(`SELECT status FROM public.billing_invoices WHERE id=$1`, [first.id]);
    expect(voided.status).toBe('void');
  });

  it('never rewrites or voids a PAID renewal invoice', async () => {
    const ws = await makeWorkspace();
    const a = await makePlan({ monthly: 2_000_000 });
    const b = await makePlan({ monthly: 9_000_000 });
    await makeSubscription(ws, { planId: a, periodStart: inDays(-25), periodEnd: inDays(5) });

    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    const [inv] = await renewalInvoices(ws);
    await payInvoiceByGateway(ws, inv.id);

    await client.query(
      `UPDATE public.workspace_subscriptions
          SET pending_change_type='upgrade', next_plan_id=$2, next_invoice_at=current_period_end
        WHERE workspace_id=$1`,
      [ws, b],
    );
    const res = (await one(`SELECT public.billing_v2_issue_renewal_invoice($1, true) AS r`, [ws])).r;
    expect(res.replayed).toBe(true);
    const after = await one(`SELECT status, total_irr FROM public.billing_invoices WHERE id=$1`, [inv.id]);
    expect(after.status).toBe('paid');
    expect(Number(after.total_irr)).toBe(2_000_000);
  });

  it('does not mutate an issued invoice when the plan price changes afterwards', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_500_000 });
    await makeSubscription(ws, { planId: plan, periodStart: inDays(-25), periodEnd: inDays(5) });
    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    const [inv] = await renewalInvoices(ws);

    await client.query(
      `UPDATE public.billing_plans SET prices = '{"IRR":{"monthly":99000000,"yearly":0}}'::jsonb WHERE id=$1`,
      [plan],
    );
    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);

    const after = await one(`SELECT total_irr FROM public.billing_invoices WHERE id=$1`, [inv.id]);
    expect(Number(after.total_irr)).toBe(1_500_000);
    expect(await renewalInvoices(ws)).toHaveLength(1);
  });

  it('issues no renewal invoice for a trialing subscription', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    await makeSubscription(ws, {
      planId: plan, periodStart: inDays(-10), periodEnd: inDays(4), status: 'trialing',
    });
    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    expect(await renewalInvoices(ws)).toHaveLength(0);
  });

  it('ignores workspaces that are not v2_active (mixed population safety)', async () => {
    const ws = await makeWorkspace();
    await client.query(`UPDATE public.billing_v2_rollout SET state='shadow' WHERE workspace_id=$1`, [ws]);
    const plan = await makePlan({ monthly: 1_000_000 });
    await makeSubscription(ws, { planId: plan, periodStart: inDays(-25), periodEnd: inDays(5) });

    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    expect(await renewalInvoices(ws)).toHaveLength(0);

    const direct = (await one(`SELECT public.billing_v2_issue_renewal_invoice($1, true) AS r`, [ws])).r;
    expect(direct.skipped).toBe('not_v2_active');
  });

  // ── Early payment → scheduled period ────────────────────────────────────

  it('schedules (does not start) the period when the renewal invoice is paid early', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000, allowance: 400_000 });
    const sub = await makeSubscription(ws, { planId: plan, periodStart: inDays(-25), periodEnd: inDays(5) });
    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    const [inv] = await renewalInvoices(ws);
    await payInvoiceByGateway(ws, inv.id);
    await client.query(`SELECT public.billing_apply_invoice_effects($1)`, [inv.id]);

    const period = await one(
      `SELECT * FROM public.billing_subscription_periods WHERE invoice_id=$1`, [inv.id],
    );
    expect(period.status).toBe('scheduled');

    const after = await one(`SELECT * FROM public.workspace_subscriptions WHERE workspace_id=$1`, [ws]);
    expect(after.current_period_id).not.toBe(period.id);
    expect(new Date(after.current_period_end).toISOString()).toBe(
      new Date(sub.current_period_end).toISOString(),
    );
    const lots = await q(
      `SELECT id FROM public.workspace_ai_balance_lots WHERE workspace_id=$1 AND allowance_source='plan'`,
      [ws],
    );
    expect(lots).toHaveLength(0);
  });

  it('keeps at most one scheduled future period per workspace', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    const sub = await makeSubscription(ws, { planId: plan, periodStart: inDays(-25), periodEnd: inDays(5) });
    const mk = (start: string, end: string) =>
      client.query(
        `INSERT INTO public.billing_subscription_periods
           (workspace_id, subscription_id, plan_id, billing_interval, period_start, period_end, status, source)
         VALUES ($1,$2,$3,'monthly',$4,$5,'scheduled','admin')`,
        [ws, sub.id, plan, start, end],
      );
    await mk(inDays(5), inDays(35));
    await expect(mk(inDays(35), inDays(65))).rejects.toThrow(/multiple_scheduled_periods/);
  });

  // ── Worker B: wallet auto-pay ───────────────────────────────────────────

  async function dueInvoiceWorkspace(price = 1_000_000, allowance = 200_000) {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: price, allowance });
    await makeSubscription(ws, { planId: plan, periodStart: inDays(-30), periodEnd: inDays(-0.01) });
    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    const [inv] = await renewalInvoices(ws);
    return { ws, plan, inv };
  }

  it('pays a DUE invoice in full from a sufficient wallet', async () => {
    const { ws, inv } = await dueInvoiceWorkspace();
    await fundWallet(ws, 2_000_000);

    await client.query(`SELECT public.billing_v2_run_wallet_autopay(50)`);
    const after = await one(`SELECT status, amount_due_irr FROM public.billing_invoices WHERE id=$1`, [inv.id]);
    expect(after.status).toBe('paid');
    expect(Number(after.amount_due_irr)).toBe(0);
    const wallet = await one(
      `SELECT available_balance_irr FROM public.billing_wallet_accounts WHERE workspace_id=$1`, [ws],
    );
    expect(Number(wallet.available_balance_irr)).toBe(1_000_000);
  });

  it('makes NO partial debit when the wallet is short', async () => {
    const { ws, inv } = await dueInvoiceWorkspace();
    await fundWallet(ws, 400_000);

    await client.query(`SELECT public.billing_v2_run_wallet_autopay(50)`);
    const after = await one(`SELECT status, amount_paid_irr FROM public.billing_invoices WHERE id=$1`, [inv.id]);
    expect(after.status).toBe('open');
    expect(Number(after.amount_paid_irr)).toBe(0);
    const wallet = await one(
      `SELECT available_balance_irr FROM public.billing_wallet_accounts WHERE workspace_id=$1`, [ws],
    );
    expect(Number(wallet.available_balance_irr)).toBe(400_000);
    const audit = await q(
      `SELECT event FROM public.billing_v2_audit WHERE workspace_id=$1 AND event='wallet_autopay_skipped_insufficient'`,
      [ws],
    );
    expect(audit.length).toBeGreaterThan(0);
  });

  it('does not pay an invoice that is not due yet', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    await makeSubscription(ws, { planId: plan, periodStart: inDays(-25), periodEnd: inDays(5) });
    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    const [inv] = await renewalInvoices(ws);
    await fundWallet(ws, 5_000_000);

    await client.query(`SELECT public.billing_v2_run_wallet_autopay(50)`);
    const after = await one(`SELECT status FROM public.billing_invoices WHERE id=$1`, [inv.id]);
    expect(after.status).toBe('open');
  });

  it('does not pay when auto-pay is disabled for the workspace', async () => {
    const { ws, inv } = await dueInvoiceWorkspace();
    await fundWallet(ws, 5_000_000);
    await client.query(
      `INSERT INTO public.billing_v2_workspace_policy (workspace_id, wallet_auto_pay_enabled)
       VALUES ($1,false) ON CONFLICT (workspace_id) DO UPDATE SET wallet_auto_pay_enabled=false`,
      [ws],
    );

    await client.query(`SELECT public.billing_v2_run_wallet_autopay(50)`);
    expect((await one(`SELECT status FROM public.billing_invoices WHERE id=$1`, [inv.id])).status).toBe('open');
  });

  it('loses the race with an ACTIVE gateway collection, and wins once it expires', async () => {
    const { ws, inv } = await dueInvoiceWorkspace();
    await fundWallet(ws, 5_000_000);
    await client.query(`SELECT public.billing_begin_collection($1,'gateway',$2,$3,NULL,60)`, [
      inv.id, Number(inv.amount_due_irr), `gw:${uuid()}`,
    ]);

    await client.query(`SELECT public.billing_v2_run_wallet_autopay(50)`);
    expect((await one(`SELECT status FROM public.billing_invoices WHERE id=$1`, [inv.id])).status).toBe('open');
    expect(
      (await q(`SELECT 1 FROM public.billing_v2_audit
                 WHERE workspace_id=$1 AND event='wallet_autopay_skipped_collection_active'`, [ws])).length,
    ).toBeGreaterThan(0);

    // A stale reservation must not block collection forever.
    await client.query(
      `UPDATE public.billing_invoice_collections SET expires_at = now() - interval '1 minute'
        WHERE invoice_id=$1 AND status='active'`,
      [inv.id],
    );
    await client.query(`SELECT public.billing_v2_run_wallet_autopay(50)`);
    expect((await one(`SELECT status FROM public.billing_invoices WHERE id=$1`, [inv.id])).status).toBe('paid');
  });

  it('debits exactly once across five replays and three concurrent runs', async () => {
    const { ws, inv } = await dueInvoiceWorkspace(1_200_000);
    await fundWallet(ws, 5_000_000);

    for (let i = 0; i < 5; i += 1) {
      await client.query(`UPDATE public.billing_v2_jobs SET next_attempt_at=now(), lease_until=NULL
                           WHERE job_type='wallet_autopay'`);
      await client.query(`SELECT public.billing_v2_run_wallet_autopay(50)`);
    }

    const { Client } = await import('pg');
    const clients = await Promise.all([0, 1, 2].map(async () => {
      const c = new Client({ connectionString: DSN });
      await c.connect();
      return c;
    }));
    await Promise.allSettled(clients.map((c) => c.query(`SELECT public.billing_v2_run_wallet_autopay(50)`)));
    await Promise.all(clients.map((c) => c.end()));

    const debits = await q(
      `SELECT id FROM public.billing_wallet_ledger WHERE workspace_id=$1 AND entry_type='invoice_payment'`, [ws],
    );
    expect(debits).toHaveLength(1);
    const wallet = await one(
      `SELECT available_balance_irr FROM public.billing_wallet_accounts WHERE workspace_id=$1`, [ws],
    );
    expect(Number(wallet.available_balance_irr)).toBe(3_800_000);
    expect((await one(`SELECT status FROM public.billing_invoices WHERE id=$1`, [inv.id])).status).toBe('paid');
  });

  it('skips an invoice a manual wallet payment already settled (manual vs auto race)', async () => {
    const { ws, inv } = await dueInvoiceWorkspace(600_000);
    await fundWallet(ws, 5_000_000);
    await client.query(`SELECT public.billing_wallet_pay_invoice($1, NULL)`, [inv.id]);

    await client.query(`SELECT public.billing_v2_run_wallet_autopay(50)`);
    const debits = await q(
      `SELECT id FROM public.billing_wallet_ledger WHERE workspace_id=$1 AND entry_type='invoice_payment'`, [ws],
    );
    expect(debits).toHaveLength(1);
  });

  it('skips an invoice a gateway callback already settled (gateway vs auto race)', async () => {
    const { ws, inv } = await dueInvoiceWorkspace(750_000);
    await fundWallet(ws, 5_000_000);
    await payInvoiceByGateway(ws, inv.id);

    await client.query(`SELECT public.billing_v2_run_wallet_autopay(50)`);
    const debits = await q(
      `SELECT id FROM public.billing_wallet_ledger WHERE workspace_id=$1 AND entry_type='invoice_payment'`, [ws],
    );
    expect(debits).toHaveLength(0);
    const wallet = await one(
      `SELECT available_balance_irr FROM public.billing_wallet_accounts WHERE workspace_id=$1`, [ws],
    );
    expect(Number(wallet.available_balance_irr)).toBe(5_000_000);
  });

  // ── Worker C: period activation ─────────────────────────────────────────

  async function paidScheduledPeriod(allowance = 350_000) {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000, allowance });
    const sub = await makeSubscription(ws, { planId: plan, periodStart: inDays(-25), periodEnd: inDays(5) });
    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    const [inv] = await renewalInvoices(ws);
    await payInvoiceByGateway(ws, inv.id);
    await client.query(`SELECT public.billing_apply_invoice_effects($1)`, [inv.id]);
    const period = await one(`SELECT * FROM public.billing_subscription_periods WHERE invoice_id=$1`, [inv.id]);
    return { ws, plan, sub, inv, period };
  }

  it('does not activate a scheduled period before its start', async () => {
    const { period } = await paidScheduledPeriod();
    await client.query(`SELECT public.billing_v2_run_period_activation(50)`);
    expect((await one(`SELECT status FROM public.billing_subscription_periods WHERE id=$1`, [period.id])).status)
      .toBe('scheduled');
  });

  it('refuses to activate a period whose invoice is not paid', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    const sub = await makeSubscription(ws, { planId: plan, periodStart: inDays(-25), periodEnd: inDays(5) });
    const inv = await one(
      `INSERT INTO public.billing_invoices
         (workspace_id, subscription_id, invoice_number, invoice_type, status,
          subtotal_irr, total_irr, amount_due_irr, period_start, period_end)
       VALUES ($1,$2,$3,'subscription_renewal','open',1000000,1000000,1000000,$4,$5) RETURNING *`,
      [ws, sub.id, `ZZ${String(10_000_000 + Math.floor(Math.random() * 8_000_000))}`, inDays(-1), inDays(29)],
    );
    const period = await one(
      `INSERT INTO public.billing_subscription_periods
         (workspace_id, subscription_id, plan_id, invoice_id, billing_interval, period_start, period_end, status, source)
       VALUES ($1,$2,$3,$4,'monthly',$5,$6,'scheduled','invoice') RETURNING *`,
      [ws, sub.id, plan, inv.id, inDays(-1), inDays(29)],
    );
    await expect(
      client.query(`SELECT public.billing_activate_period($1)`, [period.id]),
    ).rejects.toThrow(/period_invoice_not_paid/);
  });

  it('activates at the period start: pointer moves, old period completes, allowance granted once', async () => {
    const { ws, period, sub } = await paidScheduledPeriod(350_000);
    // Time travel by moving the window backwards — the row is frozen, so this
    // is done through a direct system-level shift of the schedule.
    await client.query(
      `ALTER TABLE public.billing_subscription_periods DISABLE TRIGGER trg_billing_period_freeze`,
    );
    await client.query(
      `UPDATE public.billing_subscription_periods SET period_start = now() - interval '1 minute' WHERE id=$1`,
      [period.id],
    );
    await client.query(
      `ALTER TABLE public.billing_subscription_periods ENABLE TRIGGER trg_billing_period_freeze`,
    );

    await client.query(`SELECT public.billing_v2_run_period_activation(50)`);

    const activated = await one(`SELECT * FROM public.billing_subscription_periods WHERE id=$1`, [period.id]);
    expect(activated.status).toBe('active');

    const after = await one(`SELECT * FROM public.workspace_subscriptions WHERE workspace_id=$1`, [ws]);
    expect(after.current_period_id).toBe(period.id);
    expect(after.plan_id).toBe(period.plan_id);
    expect(after.pending_change_type).toBeNull();
    expect(after.next_plan_id).toBeNull();
    expect(new Date(after.current_period_end).toISOString())
      .toBe(new Date(period.period_end).toISOString());
    expect(sub.id).toBeTruthy();

    const lots = await q(
      `SELECT * FROM public.workspace_ai_balance_lots
        WHERE workspace_id=$1 AND allowance_source='plan'`, [ws],
    );
    expect(lots).toHaveLength(1);
    expect(Number(lots[0].original_amount)).toBe(350_000);

    const grant = await one(
      `SELECT * FROM public.billing_period_allowance_grants WHERE period_id=$1`, [period.id],
    );
    expect(grant.status).toBe('granted');
  });

  it('grants exactly one allowance under five replays and three concurrent activation runs', async () => {
    const { ws, period } = await paidScheduledPeriod(250_000);
    await client.query(`ALTER TABLE public.billing_subscription_periods DISABLE TRIGGER trg_billing_period_freeze`);
    await client.query(
      `UPDATE public.billing_subscription_periods SET period_start = now() - interval '1 minute' WHERE id=$1`,
      [period.id],
    );
    await client.query(`ALTER TABLE public.billing_subscription_periods ENABLE TRIGGER trg_billing_period_freeze`);

    for (let i = 0; i < 5; i += 1) {
      await client.query(`UPDATE public.billing_v2_jobs SET next_attempt_at=now(), lease_until=NULL
                           WHERE job_type='period_activation'`);
      await client.query(`SELECT public.billing_v2_run_period_activation(50)`);
    }

    const { Client } = await import('pg');
    const clients = await Promise.all([0, 1, 2].map(async () => {
      const c = new Client({ connectionString: DSN });
      await c.connect();
      return c;
    }));
    await Promise.allSettled(clients.map((c) => c.query(`SELECT public.billing_v2_run_period_activation(50)`)));
    await Promise.all(clients.map((c) => c.end()));

    const lots = await q(
      `SELECT id FROM public.workspace_ai_balance_lots WHERE workspace_id=$1 AND allowance_source='plan'`, [ws],
    );
    expect(lots).toHaveLength(1);
  });

  it('recovers a crash between activation and the allowance grant', async () => {
    const { ws, period } = await paidScheduledPeriod(500_000);
    await client.query(`ALTER TABLE public.billing_subscription_periods DISABLE TRIGGER trg_billing_period_freeze`);
    await client.query(
      `UPDATE public.billing_subscription_periods
          SET period_start = now() - interval '1 minute', status='active', activated_at=now() WHERE id=$1`,
      [period.id],
    );
    await client.query(`ALTER TABLE public.billing_subscription_periods ENABLE TRIGGER trg_billing_period_freeze`);
    // The crash: the period is active but no allowance work item was completed.
    await client.query(
      `INSERT INTO public.billing_period_allowance_grants (period_id, workspace_id, allowance_irr, status)
       VALUES ($1,$2,500000,'pending') ON CONFLICT (period_id) DO UPDATE SET status='pending'`,
      [period.id, ws],
    );

    await client.query(`SELECT public.billing_v2_run_period_activation(50)`);

    const grant = await one(`SELECT * FROM public.billing_period_allowance_grants WHERE period_id=$1`, [period.id]);
    expect(grant.status).toBe('granted');
    const lots = await q(
      `SELECT id FROM public.workspace_ai_balance_lots WHERE workspace_id=$1 AND allowance_source='plan'`, [ws],
    );
    expect(lots).toHaveLength(1);
  });

  it('uses the FROZEN snapshot, not the live plan row, for the allowance', async () => {
    const { ws, plan, period } = await paidScheduledPeriod(120_000);
    await client.query(
      `UPDATE public.billing_plans SET limits = '{"ai_credits_per_month": 99000000}'::jsonb WHERE id=$1`, [plan],
    );
    await client.query(`ALTER TABLE public.billing_subscription_periods DISABLE TRIGGER trg_billing_period_freeze`);
    await client.query(
      `UPDATE public.billing_subscription_periods SET period_start = now() - interval '1 minute' WHERE id=$1`,
      [period.id],
    );
    await client.query(`ALTER TABLE public.billing_subscription_periods ENABLE TRIGGER trg_billing_period_freeze`);

    await client.query(`SELECT public.billing_v2_run_period_activation(50)`);
    const lots = await q(
      `SELECT original_amount FROM public.workspace_ai_balance_lots
        WHERE workspace_id=$1 AND allowance_source='plan'`, [ws],
    );
    expect(lots).toHaveLength(1);
    expect(Number(lots[0].original_amount)).toBe(120_000);
  });

  // ── Free contract ───────────────────────────────────────────────────────

  it('rolls a FREE subscription forward with no invoice and one allowance', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 0, allowance: 50_000 });
    await makeSubscription(ws, { planId: plan, periodStart: inDays(-31), periodEnd: inDays(-0.01) });

    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    await client.query(`SELECT public.billing_v2_run_invoice_scheduler(50)`);

    const invoices = await q(`SELECT id FROM public.billing_invoices WHERE workspace_id=$1`, [ws]);
    expect(invoices).toHaveLength(0);

    const periods = await q(
      `SELECT * FROM public.billing_subscription_periods WHERE workspace_id=$1 AND source='free_plan'`, [ws],
    );
    expect(periods).toHaveLength(1);
    expect(periods[0].status).toBe('active');

    const lots = await q(
      `SELECT id FROM public.workspace_ai_balance_lots WHERE workspace_id=$1 AND allowance_source='plan'`, [ws],
    );
    expect(lots).toHaveLength(1);
  });

  // ── Health / observability ──────────────────────────────────────────────

  it('exposes a read-only scheduler health surface', async () => {
    const health = (await one(`SELECT public.billing_v2_scheduler_health() AS h`)).h;
    expect(health).toHaveProperty('due_invoices');
    expect(health).toHaveProperty('scheduled_periods_pending');
    expect(health).toHaveProperty('unapplied_active_periods');
    expect(Array.isArray(health.workers)).toBe(true);
  });

  it('denies every Phase C function to anon and authenticated', async () => {
    const funcs = [
      'billing_v2_issue_renewal_invoice(uuid, boolean)',
      'billing_v2_run_invoice_scheduler(integer)',
      'billing_v2_wallet_autopay_invoice(uuid)',
      'billing_v2_run_wallet_autopay(integer)',
      'billing_v2_apply_period_allowance(uuid)',
      'billing_v2_run_period_activation(integer)',
    ];
    for (const f of funcs) {
      for (const role of ['anon', 'authenticated']) {
        const row = await one(
          `SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, `public.${f}`],
        );
        expect(`${role}:${f}:${row.ok}`).toBe(`${role}:${f}:false`);
      }
    }
  });
});
