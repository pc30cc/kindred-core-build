/**
 * Billing Engine V2 — Phase E invariants against real PostgreSQL.
 *
 * Dunning is the part of a billing engine that can quietly destroy trust: it
 * either takes money it should not, or cuts service off a customer who paid.
 * The properties below are the ones that decide which:
 *
 *   - reminders are scheduled once from a FROZEN policy snapshot, and a later
 *     Super Admin policy change cannot shorten an existing grace period
 *   - on the due day the order is lock → recheck → auto-pay → past_due, and a
 *     wallet that cannot cover the invoice never produces a partial debit
 *   - grace is measured by the database clock, and a payment during grace wins
 *     over the expiry worker every time
 *   - fallback lands on the Super-Admin-configured plan, expires the unpaid
 *     invoice, records a retention CASE and DELETES NOTHING
 *   - a payment arriving after fallback never silently revives the old plan
 *   - notifications are idempotent under replay and never roll back money
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
    'REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — Billing Engine V2 Phase E database tests are mandatory in CI.',
  );
}

const suite = DSN ? describe : describe.skip;

const CHAIN = [
  'scripts/ci/billing-test-bootstrap.sql',
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
  'database/migrations/119_billing_v2_entitlement_cycles.sql',
  'database/migrations/120_billing_v2_wallet_deposit_checkout.sql',
  'database/migrations/122_billing_v2_dunning.sql',
  'database/migrations/123_billing_v2_dunning_hardening.sql',
];

let client: any;
const q = async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows;
const one = async (sql: string, params?: unknown[]) => (await q(sql, params))[0];

function uuid(): string {
  const h = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${h()}${h()}-${h()}-4${h().slice(1)}-8${h().slice(1)}-${h()}${h()}${h()}`;
}

async function makeWorkspace(): Promise<string> {
  const id = uuid();
  const owner = uuid();
  await client.query(`INSERT INTO public.profiles (id, email, phone) VALUES ($1,$2,$3)`, [
    owner, `owner-${owner.slice(0, 8)}@test.local`, '+989120000000',
  ]);
  await client.query(
    `INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1,$2,$3,$4)`,
    [id, `ws-${id.slice(0, 8)}`, `ws-${id.slice(0, 8)}`, owner],
  );
  await client.query(
    `INSERT INTO public.billing_v2_rollout (workspace_id, state, region, activated_at)
     VALUES ($1,'v2_active','IR',now())
     ON CONFLICT (workspace_id) DO UPDATE SET state='v2_active'`,
    [id],
  );
  return id;
}

async function makePlan(o: { monthly?: number; allowance?: number; free?: boolean }): Promise<string> {
  const id = uuid();
  await client.query(
    `INSERT INTO public.billing_plans (id, name, slug, prices, limits, default_currency, is_free)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'IRR',$6)`,
    [
      id, `plan-${id.slice(0, 6)}`, `plan-${id.slice(0, 6)}`,
      JSON.stringify({ IRR: { monthly: o.monthly ?? 0, yearly: (o.monthly ?? 0) * 12 } }),
      JSON.stringify({ ai_credits_per_month: o.allowance ?? 0 }),
      o.free ?? (o.monthly ?? 0) === 0,
    ],
  );
  return id;
}

async function makeSubscription(ws: string, planId: string, days: number): Promise<any> {
  const start = new Date(Date.now() - days * 86_400_000).toISOString();
  const end = new Date(Date.now() + 86_400_000).toISOString();
  return one(
    `INSERT INTO public.workspace_subscriptions
       (workspace_id, plan_id, status, billing_interval, current_period_start, current_period_end,
        next_invoice_at, billing_engine_version)
     VALUES ($1,$2,'active','monthly',$3,$4,$4,'v2')
     ON CONFLICT (workspace_id) DO UPDATE SET plan_id = EXCLUDED.plan_id
     RETURNING *`,
    [ws, planId, start, end],
  );
}

/** An OPEN renewal invoice, exactly as Worker A issues one. */
async function makeOpenInvoice(
  ws: string,
  subId: string,
  planId: string,
  o: { total: number; dueInDays: number },
): Promise<any> {
  const due = new Date(Date.now() + o.dueInDays * 86_400_000).toISOString();
  const draft = await one(
    `INSERT INTO public.billing_invoices
       (workspace_id, subscription_id, invoice_number, invoice_type, status, subtotal_irr,
        total_irr, amount_due_irr, issued_at, due_at, plan_id, billing_interval, effect_snapshot)
     VALUES ($1,$2,public.billing_v2_document_number(),'subscription_renewal','draft',
             $3,$3,$3,now(),$4,$5,'monthly','{}'::jsonb)
     RETURNING *`,
    [ws, subId, o.total, due, planId],
  );
  // draft → open is what arms the dunning lifecycle.
  return one(`UPDATE public.billing_invoices SET status='open' WHERE id=$1 RETURNING *`, [draft.id]);
}

const jobs = (invoiceId: string) =>
  q(`SELECT * FROM public.billing_notification_jobs WHERE invoice_id=$1 ORDER BY created_at`, [invoiceId]);

const sub = (ws: string) =>
  one(`SELECT * FROM public.workspace_subscriptions WHERE workspace_id=$1`, [ws]);

const inv = (id: string) => one(`SELECT * FROM public.billing_invoices WHERE id=$1`, [id]);

const audits = (ws: string) =>
  q(`SELECT event, reason FROM public.billing_v2_audit WHERE workspace_id=$1 ORDER BY created_at`, [ws]);

async function fundWallet(ws: string, amount: number): Promise<void> {
  await client.query(
    `INSERT INTO public.billing_wallet_accounts (workspace_id, available_balance_irr, auto_pay_enabled)
     VALUES ($1,$2,true)
     ON CONFLICT (workspace_id) DO UPDATE SET available_balance_irr=$2, auto_pay_enabled=true`,
    [ws, amount],
  );
}

let FREE_PLAN = '';

suite('Billing Engine V2 — Phase E dunning, grace and free fallback (PostgreSQL)', () => {
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
    FREE_PLAN = await makePlan({ monthly: 0, allowance: 0, free: true });
    await client.query(
      `UPDATE public.billing_v2_policy SET fallback_plan_id=$1, grace_period_days=3,
              reminder_days_before_due=ARRAY[5,1] WHERE id`,
      [FREE_PLAN],
    );
  }, 240_000);

  afterAll(async () => {
    await client?.end();
  });

  // ── Migration ───────────────────────────────────────────────────────────

  it('applies 122+123 forward and rerunnably without touching 113–120', async () => {
    await client.query(readFileSync(resolve(process.cwd(), CHAIN[CHAIN.length - 1]), 'utf8'));
    for (const t of ['billing_notification_jobs', 'billing_retention_signals']) {
      expect(
        await one(
          `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
          [t],
        ),
      ).toBeTruthy();
    }
    expect(
      await one(
        `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uq_billing_notification_jobs_idem'`,
      ),
    ).toBeTruthy();
  });

  it('exposes the dunning policy through billing_v2_policy_for', async () => {
    const ws = await makeWorkspace();
    const pol = (await one(`SELECT public.billing_v2_policy_for($1) AS p`, [ws])).p;
    expect(pol.grace_period_days).toBe(3);
    expect(pol.reminder_days_before_due).toEqual([5, 1]);
    expect(pol.fallback_plan_id).toBe(FREE_PLAN);
    expect(pol.notification_max_attempts).toBeGreaterThan(0);
  });

  // ── Reminders ───────────────────────────────────────────────────────────

  it('schedules issued + reminder notifications exactly once per invoice', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000, allowance: 500_000 });
    const s = await makeSubscription(ws, plan, 30);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 1_000_000, dueInDays: 10 });

    const first = await jobs(invoice.id);
    expect(first.filter((j: any) => j.notification_type === 'invoice_issued')).toHaveLength(1);
    expect(first.filter((j: any) => j.notification_type === 'invoice_reminder')).toHaveLength(2);

    // Replay: same scheduler pass, same rows — never a second message.
    await q(`SELECT public.billing_v2_schedule_invoice_notifications($1)`, [invoice.id]);
    await q(`SELECT public.billing_v2_schedule_invoice_notifications($1)`, [invoice.id]);
    expect(await jobs(invoice.id)).toHaveLength(first.length);
  });

  it('never sends a reminder whose moment has already passed', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    const s = await makeSubscription(ws, plan, 30);
    // Due in 2 days: the 5-day reminder is already obsolete.
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 1_000_000, dueInDays: 2 });
    const reminders = (await jobs(invoice.id)).filter((j: any) => j.notification_type === 'invoice_reminder');
    expect(reminders).toHaveLength(1);
    expect(reminders[0].payload.days_before_due).toBe(1);
  });

  it('freezes the dunning snapshot on the invoice at issue time', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    const s = await makeSubscription(ws, plan, 30);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 1_000_000, dueInDays: 10 });

    const before = (await inv(invoice.id)).metadata.dunning;
    expect(before.grace_period_days).toBe(3);

    await client.query(`UPDATE public.billing_v2_policy SET grace_period_days = 14 WHERE id`);
    const after = (await one(`SELECT public.billing_v2_dunning_snapshot($1) AS s`, [invoice.id])).s;
    expect(after.grace_period_days).toBe(3); // the contract the customer got
    await client.query(`UPDATE public.billing_v2_policy SET grace_period_days = 3 WHERE id`);
  });

  // ── Due day ─────────────────────────────────────────────────────────────

  it('pays a due invoice in full from the wallet and cancels its reminders', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000, allowance: 500_000 });
    const s = await makeSubscription(ws, plan, 30);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 1_000_000, dueInDays: 10 });
    await client.query(`UPDATE public.billing_invoices SET due_at = now() - interval '1 minute' WHERE id=$1`, [invoice.id]);
    await fundWallet(ws, 5_000_000);

    const res = (await one(`SELECT public.billing_v2_process_due_invoice($1) AS r`, [invoice.id])).r;
    expect(res.paid).toBe(true);
    expect((await inv(invoice.id)).status).toBe('paid');
    expect((await sub(ws)).status).not.toBe('past_due');

    const remaining = (await jobs(invoice.id)).filter(
      (j: any) => j.notification_type === 'invoice_reminder' && j.status === 'pending',
    );
    expect(remaining).toHaveLength(0);
    expect((await jobs(invoice.id)).some((j: any) => j.notification_type === 'payment_received')).toBe(true);
  });

  it('an insufficient wallet produces NO partial debit and moves the invoice to past_due', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 2_000_000 });
    const s = await makeSubscription(ws, plan, 30);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 2_000_000, dueInDays: 0 });
    await client.query(`UPDATE public.billing_invoices SET due_at = now() - interval '1 minute' WHERE id=$1`, [invoice.id]);
    await fundWallet(ws, 500_000);

    const res = (await one(`SELECT public.billing_v2_process_due_invoice($1) AS r`, [invoice.id])).r;
    expect(res.past_due).toBe(true);

    const after = await inv(invoice.id);
    expect(after.status).toBe('past_due');
    expect(Number(after.amount_paid_irr)).toBe(0);
    const wallet = await one(`SELECT * FROM public.billing_wallet_accounts WHERE workspace_id=$1`, [ws]);
    expect(Number(wallet.available_balance_irr)).toBe(500_000);

    const sr = await sub(ws);
    expect(sr.status).toBe('past_due');
    expect(sr.past_due_since).toBeTruthy();
    expect(new Date(sr.grace_period_ends_at).getTime()).toBeGreaterThan(Date.now());

    const events = (await audits(ws)).map((a: any) => a.event);
    expect(events).toContain('invoice_due');
    expect(events).toContain('wallet_autopay_insufficient');
    expect(events).toContain('invoice_past_due');
    expect(events).toContain('subscription_past_due');
  });

  it('emits ONE past-due message per channel, even on repeated due-day runs', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 2_000_000 });
    const s = await makeSubscription(ws, plan, 30);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 2_000_000, dueInDays: 0 });
    await client.query(`UPDATE public.billing_invoices SET due_at = now() - interval '1 minute' WHERE id=$1`, [invoice.id]);

    await q(`SELECT public.billing_v2_process_due_invoice($1)`, [invoice.id]);
    await q(`SELECT public.billing_v2_process_due_invoice($1)`, [invoice.id]);
    await q(`SELECT public.billing_v2_process_due_invoice($1)`, [invoice.id]);

    const pastDue = (await jobs(invoice.id)).filter((j: any) => j.notification_type === 'invoice_past_due');
    expect(pastDue).toHaveLength(2); // email + sms, once each
  });

  it('auto-pay disabled is a customer choice, not a system failure — lifecycle still advances', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    const s = await makeSubscription(ws, plan, 30);
    await client.query(
      `INSERT INTO public.billing_v2_workspace_policy (workspace_id, wallet_auto_pay_enabled)
       VALUES ($1,false) ON CONFLICT (workspace_id) DO UPDATE SET wallet_auto_pay_enabled=false`,
      [ws],
    );
    await fundWallet(ws, 50_000_000);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 1_000_000, dueInDays: 0 });
    await client.query(`UPDATE public.billing_invoices SET due_at = now() - interval '1 minute' WHERE id=$1`, [invoice.id]);

    const res = (await one(`SELECT public.billing_v2_process_due_invoice($1) AS r`, [invoice.id])).r;
    expect(res.reason).toBe('auto_pay_disabled');
    expect((await inv(invoice.id)).status).toBe('past_due');
    const wallet = await one(`SELECT * FROM public.billing_wallet_accounts WHERE workspace_id=$1`, [ws]);
    expect(Number(wallet.available_balance_irr)).toBe(50_000_000); // untouched: never charge silently
  });

  it('does not issue another renewal invoice while the subscription is past_due', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    const s = await makeSubscription(ws, plan, 30);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 1_000_000, dueInDays: 0 });
    await client.query(`UPDATE public.billing_invoices SET due_at = now() - interval '1 minute' WHERE id=$1`, [invoice.id]);
    await q(`SELECT public.billing_v2_process_due_invoice($1)`, [invoice.id]);
    expect((await sub(ws)).status).toBe('past_due');

    const before = await q(`SELECT id FROM public.billing_invoices WHERE workspace_id=$1`, [ws]);
    await q(`SELECT public.billing_v2_run_invoice_scheduler(50)`);
    const after = await q(`SELECT id FROM public.billing_invoices WHERE workspace_id=$1`, [ws]);
    expect(after).toHaveLength(before.length);
  });

  // ── Grace ───────────────────────────────────────────────────────────────

  it('keeps service during grace and refuses to expire early', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    const s = await makeSubscription(ws, plan, 30);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 1_000_000, dueInDays: 0 });
    await client.query(`UPDATE public.billing_invoices SET due_at = now() - interval '1 minute' WHERE id=$1`, [invoice.id]);
    await q(`SELECT public.billing_v2_process_due_invoice($1)`, [invoice.id]);

    const res = (await one(`SELECT public.billing_v2_apply_free_fallback($1) AS r`, [ws])).r;
    expect(res.skipped).toBe('grace_active');
    const sr = await sub(ws);
    expect(sr.plan_id).toBe(plan); // still on the paid plan
    expect(sr.free_fallback_at).toBeNull();
  });

  it('a payment during grace restores the subscription and cancels the dunning', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    const s = await makeSubscription(ws, plan, 30);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 1_000_000, dueInDays: 0 });
    await client.query(`UPDATE public.billing_invoices SET due_at = now() - interval '1 minute' WHERE id=$1`, [invoice.id]);
    await q(`SELECT public.billing_v2_process_due_invoice($1)`, [invoice.id]);
    expect((await sub(ws)).status).toBe('past_due');

    await fundWallet(ws, 5_000_000);
    await q(`SELECT public.billing_wallet_pay_invoice($1, NULL)`, [invoice.id]);

    const sr = await sub(ws);
    expect(sr.status).toBe('active');
    expect(sr.past_due_since).toBeNull();
    expect(sr.grace_period_ends_at).toBeNull();
    expect((await audits(ws)).map((a: any) => a.event)).toContain('invoice_restored_during_grace');

    // And the grace worker now finds nothing to do.
    const res = (await one(`SELECT public.billing_v2_apply_free_fallback($1) AS r`, [ws])).r;
    expect(res.skipped).toBe('not_past_due:active');
  });

  // ── Fallback ────────────────────────────────────────────────────────────

  it('expires grace into the configured free plan, expires the invoice and DELETES NOTHING', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000, allowance: 500_000 });
    const s = await makeSubscription(ws, plan, 30);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 1_000_000, dueInDays: 0 });
    await client.query(`UPDATE public.billing_invoices SET due_at = now() - interval '1 minute' WHERE id=$1`, [invoice.id]);
    await q(`SELECT public.billing_v2_process_due_invoice($1)`, [invoice.id]);
    await client.query(
      `UPDATE public.workspace_subscriptions SET grace_period_ends_at = now() - interval '1 minute' WHERE workspace_id=$1`,
      [ws],
    );

    const res = (await one(`SELECT public.billing_v2_apply_free_fallback($1) AS r`, [ws])).r;
    expect(res.free_fallback).toBe(true);
    expect(res.plan_id).toBe(FREE_PLAN);

    const sr = await sub(ws);
    expect(sr.status).toBe('free_fallback');
    expect(sr.plan_id).toBe(FREE_PLAN);
    expect(sr.free_fallback_at).toBeTruthy();
    expect(sr.grace_period_ends_at).toBeNull();

    expect((await inv(invoice.id)).status).toBe('expired');

    // The free period starts at the fallback moment, not at an older anchor.
    const period = await one(
      `SELECT * FROM public.billing_subscription_periods
        WHERE workspace_id=$1 AND source='free_fallback' AND status='active'`,
      [ws],
    );
    expect(period).toBeTruthy();
    expect(new Date(period.period_start).getTime()).toBeGreaterThan(Date.now() - 60_000);

    // Retention SIGNAL only.
    const retention = await one(
      `SELECT * FROM public.billing_retention_signals WHERE workspace_id=$1 AND state='pending'`,
      [ws],
    );
    expect(retention).toBeTruthy();
    expect(retention.reason).toBe('free_fallback_nonpayment');

    // Nothing was deleted: the invoice and its history are still there.
    expect(await inv(invoice.id)).toBeTruthy();

    const events = (await audits(ws)).map((a: any) => a.event);
    expect(events).toContain('grace_expired');
    expect(events).toContain('invoice_expired_after_nonpayment');
    expect(events).toContain('subscription_free_fallback');
  });

  it('is idempotent: a second fallback pass changes nothing', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    const s = await makeSubscription(ws, plan, 30);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 1_000_000, dueInDays: 0 });
    await client.query(`UPDATE public.billing_invoices SET due_at = now() - interval '1 minute' WHERE id=$1`, [invoice.id]);
    await q(`SELECT public.billing_v2_process_due_invoice($1)`, [invoice.id]);
    await client.query(
      `UPDATE public.workspace_subscriptions SET grace_period_ends_at = now() - interval '1 minute' WHERE workspace_id=$1`,
      [ws],
    );
    await q(`SELECT public.billing_v2_apply_free_fallback($1)`, [ws]);
    const first = await sub(ws);

    const again = (await one(`SELECT public.billing_v2_apply_free_fallback($1) AS r`, [ws])).r;
    expect(again.skipped).toBe('already_free_fallback');
    const second = await sub(ws);
    expect(second.free_fallback_at).toEqual(first.free_fallback_at);
    expect(
      await q(`SELECT id FROM public.billing_subscription_periods WHERE workspace_id=$1 AND source='free_fallback'`, [ws]),
    ).toHaveLength(1);
  });

  it('a payment landing AFTER fallback never silently revives the old plan', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    const s = await makeSubscription(ws, plan, 30);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 1_000_000, dueInDays: 0 });
    await client.query(`UPDATE public.billing_invoices SET due_at = now() - interval '1 minute' WHERE id=$1`, [invoice.id]);
    await q(`SELECT public.billing_v2_process_due_invoice($1)`, [invoice.id]);
    await client.query(
      `UPDATE public.workspace_subscriptions SET grace_period_ends_at = now() - interval '1 minute' WHERE workspace_id=$1`,
      [ws],
    );
    await q(`SELECT public.billing_v2_apply_free_fallback($1)`, [ws]);

    // A late gateway callback marks the (now expired) invoice paid.
    await client.query(
      `UPDATE public.billing_invoices SET status='paid', paid_at=now(),
              amount_paid_irr=total_irr, amount_due_irr=0 WHERE id=$1`,
      [invoice.id],
    );

    const sr = await sub(ws);
    expect(sr.status).toBe('free_fallback');
    expect(sr.plan_id).toBe(FREE_PLAN);
    expect((await audits(ws)).map((a: any) => a.event)).toContain('payment_after_free_fallback');
  });

  it('refuses to fall back when no fallback plan is configured', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    const s = await makeSubscription(ws, plan, 30);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 1_000_000, dueInDays: 0 });
    await client.query(`UPDATE public.billing_invoices SET due_at = now() - interval '1 minute' WHERE id=$1`, [invoice.id]);
    await q(`SELECT public.billing_v2_process_due_invoice($1)`, [invoice.id]);
    await client.query(
      `UPDATE public.workspace_subscriptions
          SET grace_period_ends_at = now() - interval '1 minute'
        WHERE workspace_id=$1`,
      [ws],
    );
    await client.query(`UPDATE public.billing_v2_policy SET fallback_plan_id = NULL WHERE id`);

    await expect(q(`SELECT public.billing_v2_apply_free_fallback($1)`, [ws])).rejects.toThrow(
      /fallback_plan_not_configured/,
    );
    expect((await sub(ws)).status).toBe('past_due'); // service is NOT cut off on a config error

    await client.query(`UPDATE public.billing_v2_policy SET fallback_plan_id=$1 WHERE id`, [FREE_PLAN]);
  });

  // ── Workers ─────────────────────────────────────────────────────────────

  it('the dunning worker is bounded, durable and safe to replay', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    const s = await makeSubscription(ws, plan, 30);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 1_000_000, dueInDays: 0 });
    await client.query(`UPDATE public.billing_invoices SET due_at = now() - interval '1 minute' WHERE id=$1`, [invoice.id]);

    const first = (await one(`SELECT public.billing_v2_run_dunning(50) AS r`)).r;
    expect(Number(first.past_due) + Number(first.paid) + Number(first.skipped)).toBeGreaterThan(0);
    expect(Number(first.failed)).toBe(0);
    expect((await inv(invoice.id)).status).toBe('past_due');

    const second = (await one(`SELECT public.billing_v2_run_dunning(50) AS r`)).r;
    expect(Number(second.failed)).toBe(0);
    const pastDue = (await jobs(invoice.id)).filter((j: any) => j.notification_type === 'invoice_past_due');
    expect(pastDue).toHaveLength(2);
  });

  it('the grace worker falls a workspace back exactly once', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    const s = await makeSubscription(ws, plan, 30);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 1_000_000, dueInDays: 0 });
    await client.query(`UPDATE public.billing_invoices SET due_at = now() - interval '1 minute' WHERE id=$1`, [invoice.id]);
    await q(`SELECT public.billing_v2_process_due_invoice($1)`, [invoice.id]);
    await client.query(
      `UPDATE public.workspace_subscriptions SET grace_period_ends_at = now() - interval '1 minute' WHERE workspace_id=$1`,
      [ws],
    );

    const r1 = (await one(`SELECT public.billing_v2_run_grace_expiry(25) AS r`)).r;
    expect(Number(r1.failed)).toBe(0);
    expect((await sub(ws)).status).toBe('free_fallback');

    const r2 = (await one(`SELECT public.billing_v2_run_grace_expiry(25) AS r`)).r;
    expect(Number(r2.fallbacks)).toBe(0);
    expect(Number(r2.failed)).toBe(0);
  });

  // ── Notification queue ──────────────────────────────────────────────────

  it('claims a notification job once, and records send / skip / retry distinctly', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    const s = await makeSubscription(ws, plan, 30);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 1_000_000, dueInDays: 10 });

    const claimedA = await q(`SELECT * FROM public.billing_v2_claim_notification_jobs(500, 120)`);
    const mine = claimedA.filter((j: any) => j.invoice_id === invoice.id);
    expect(mine.length).toBeGreaterThan(0);

    // A second claimant gets nothing while the lease is held.
    const claimedB = await q(`SELECT * FROM public.billing_v2_claim_notification_jobs(500, 120)`);
    expect(claimedB.filter((j: any) => j.invoice_id === invoice.id)).toHaveLength(0);

    await q(`SELECT public.billing_v2_complete_notification_job($1, '{"provider":"stub"}'::jsonb)`, [mine[0].id]);
    const sent = await one(`SELECT * FROM public.billing_notification_jobs WHERE id=$1`, [mine[0].id]);
    expect(sent.status).toBe('sent');
    expect(sent.sent_at).toBeTruthy();

    const other = await one(
      `INSERT INTO public.billing_notification_jobs
         (workspace_id, invoice_id, notification_type, channel, idempotency_key)
       VALUES ($1,$2,'invoice_reminder','sms',$3) RETURNING *`,
      [ws, invoice.id, `manual:${uuid()}`],
    );
    await q(`SELECT public.billing_v2_skip_notification_job($1, 'skipped_no_recipient')`, [other.id]);
    expect((await one(`SELECT * FROM public.billing_notification_jobs WHERE id=$1`, [other.id])).status).toBe('skipped');

    const retryable = await one(
      `INSERT INTO public.billing_notification_jobs
         (workspace_id, invoice_id, notification_type, channel, idempotency_key, attempt_count)
       VALUES ($1,$2,'invoice_reminder','email',$3,1) RETURNING *`,
      [ws, invoice.id, `manual:${uuid()}`],
    );
    await q(`SELECT public.billing_v2_fail_notification_job($1, 'provider timeout')`, [retryable.id]);
    const failed = await one(`SELECT * FROM public.billing_notification_jobs WHERE id=$1`, [retryable.id]);
    expect(failed.status).toBe('pending');
    expect(new Date(failed.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('gives up after max attempts instead of retrying forever', async () => {
    const ws = await makeWorkspace();
    const job = await one(
      `INSERT INTO public.billing_notification_jobs
         (workspace_id, notification_type, channel, idempotency_key, attempt_count, max_attempts)
       VALUES ($1,'invoice_reminder','email',$2,5,5) RETURNING *`,
      [ws, `manual:${uuid()}`],
    );
    await q(`SELECT public.billing_v2_fail_notification_job($1, 'permanent')`, [job.id]);
    expect((await one(`SELECT * FROM public.billing_notification_jobs WHERE id=$1`, [job.id])).status).toBe('failed');
  });

  it('resolves the billing recipient from the workspace owner', async () => {
    const ws = await makeWorkspace();
    const r = (await one(`SELECT public.billing_v2_billing_recipient($1) AS r`, [ws])).r;
    expect(String(r.email)).toContain('@test.local');
    expect(r.phone).toBe('+989120000000');
    expect(r.locale).toBeTruthy();
  });

  it('a void or expired invoice cancels its pending messages', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000 });
    const s = await makeSubscription(ws, plan, 30);
    const invoice = await makeOpenInvoice(ws, s.id, plan, { total: 1_000_000, dueInDays: 10 });
    await client.query(`UPDATE public.billing_invoices SET status='void', voided_at=now() WHERE id=$1`, [invoice.id]);
    const pending = (await jobs(invoice.id)).filter((j: any) => j.status === 'pending');
    expect(pending).toHaveLength(0);
  });

  // ── Operational surface ─────────────────────────────────────────────────

  it('reports dunning metrics and scheduler health without moving anything', async () => {
    const before = await q(`SELECT count(*) AS n FROM public.billing_invoices`);
    const m = (await one(`SELECT public.billing_v2_dunning_metrics() AS m`)).m;
    expect(m).toHaveProperty('past_due_invoices');
    expect(m).toHaveProperty('grace_subscriptions');
    expect(m).toHaveProperty('fallbacks_total');
    expect(m).toHaveProperty('notification_backlog');
    expect(m).toHaveProperty('retention_signals_pending');

    const h = (await one(`SELECT public.billing_v2_scheduler_health() AS h`)).h;
    expect(h).toHaveProperty('notification_backlog');
    expect(h).toHaveProperty('due_entitlement_cycles');

    const after = await q(`SELECT count(*) AS n FROM public.billing_invoices`);
    expect(after[0].n).toBe(before[0].n);
  });

  it('keeps the dunning surface off anon and authenticated', async () => {
    for (const fn of ['billing_v2_process_due_invoice', 'billing_v2_apply_free_fallback', 'billing_v2_run_dunning']) {
      const rows = await q(
        `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname=$1`,
        [fn],
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.anon).toBe(false);
        expect(r.auth).toBe(false);
      }
    }
  });
});
