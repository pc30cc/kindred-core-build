/**
 * Billing Engine V2 — Phase A financial invariants against real PostgreSQL.
 *
 * These are the properties that decide whether the platform loses money, grants
 * free service or charges twice. They live in SQL (locks, unique indexes,
 * append-only triggers, frozen snapshots), so they are tested against a live
 * database, never mocked:
 *
 *   - a paid invoice applies its effects exactly once, even when applied
 *     concurrently or replayed
 *   - a gateway settlement must match the invoice amount EXACTLY (fail closed)
 *   - an invoice becomes immutable the moment it is issued
 *   - a service period grants exactly one plan AI allowance, bound to the
 *     period id — not to a calendar month
 *   - paying early schedules the period, it does not start service early
 *   - one active period per workspace at any time
 *   - wallet: no negative balance, append-only ledger, no double credit under
 *     concurrent deposits, cache always equals the ledger
 *   - ACL: anon/authenticated cannot execute any V2 financial function
 *
 * CI-MANDATORY: the billing-db job sets REQUIRE_BILLING_DB=1; a missing
 * TEST_DATABASE_URL then FAILS the job rather than skipping — money invariants
 * must never pass by absence.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const REQUIRED = process.env.REQUIRE_BILLING_DB === '1';

if (REQUIRED && !DSN) {
  throw new Error(
    'REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — Billing Engine V2 database tests are mandatory in CI.',
  );
}

const suite = DSN ? describe : describe.skip;

/**
 * Prerequisite chain, in production order. Phase A adds 113–115 on top of the
 * already-shipped financial chain; the suite proves the chain applies FORWARD
 * from that state, exactly as production will.
 */
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
];

let client: any;

const q = async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows;
const one = async (sql: string, params?: unknown[]) => (await q(sql, params))[0];

function uuid(): string {
  const h = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${h()}${h()}-${h()}-4${h().slice(1)}-8${h().slice(1)}-${h()}${h()}${h()}`;
}

let docCounter = 0;
function docNumber(): string {
  docCounter += 1;
  return `TS${String(10_000_000 + docCounter)}`;
}

/**
 * Creates a workspace through whatever minimal shape the applied chain has:
 * the self-host base chain has no owner, the hosted chain requires one. The
 * suite must prove the same invariants on both.
 */
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
    return id;
  }
  const owner = uuid();
  await client.query(`INSERT INTO public.profiles (id, email) VALUES ($1,$2)`, [
    owner, `owner-${owner.slice(0, 8)}@test.local`,
  ]);
  await client.query(
    `INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1,$2,$3,$4)`,
    [id, `ws-${id.slice(0, 8)}`, `ws-${id.slice(0, 8)}`, owner],
  );
  return id;
}

async function makeInvoice(
  ws: string,
  opts: {
    total: number;
    type?: string;
    periodStart?: string | null;
    periodEnd?: string | null;
    allowance?: number;
    open?: boolean;
  },
): Promise<any> {
  const snapshot = {
    action_type: opts.type === 'ai_credit_purchase' ? 'ai_credit_purchase' : 'plan_new',
    target_plan_id: null,
    period_start: opts.periodStart ?? null,
    period_end: opts.periodEnd ?? null,
    ai_allowance_irr: opts.allowance ?? 0,
    ai_credit_amount_irr: opts.total,
    limits_snapshot: {},
    plan_snapshot: {},
  };
  const row = await one(
    `INSERT INTO public.billing_invoices
       (workspace_id, invoice_number, invoice_type, status, subtotal_irr, total_irr,
        amount_due_irr, period_start, period_end, effect_snapshot)
     VALUES ($1,$2,$3,'draft',$4,$4,$4,$5,$6,$7::jsonb) RETURNING *`,
    [ws, docNumber(), opts.type ?? 'new_subscription', opts.total,
      opts.periodStart ?? null, opts.periodEnd ?? null, JSON.stringify(snapshot)],
  );
  if (opts.open === false) return row;
  return one(
    `UPDATE public.billing_invoices SET status='open', issued_at=now() WHERE id=$1 RETURNING *`,
    [row.id],
  );
}

async function makePayment(ws: string, amount: number): Promise<string> {
  // The shipped table calls the column `amount`; older self-host bases used
  // `amount_irr`. The invariants under test are identical on both.
  const col = (await one(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='billing_payments'
        AND column_name IN ('amount','amount_irr') ORDER BY column_name LIMIT 1`,
  ))?.column_name ?? 'amount';
  const hasProvider = Boolean(
    await one(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='billing_payments' AND column_name='provider_name'`,
    ),
  );
  const cols = ['workspace_id', col, 'status', ...(hasProvider ? ['provider_name'] : [])];
  const vals = [ws, amount, 'succeeded', ...(hasProvider ? ['test'] : [])];
  const r = await one(
    `INSERT INTO public.billing_payments (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    vals,
  );
  return r.id;
}

/** Settles an invoice with gateway money that has a real payment behind it. */
async function settleGateway(ws: string, invoiceId: string, amount: number): Promise<any> {
  const pay = await makePayment(ws, amount);
  return (await one(`SELECT public.billing_settle_invoice($1,$2,'gateway',$3,$4,NULL) AS r`, [
    invoiceId, amount, `cmd:${uuid()}`, pay,
  ])).r;
}

suite('Billing Engine V2 — financial invariants (PostgreSQL)', () => {
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
  }, 180_000);

  afterAll(async () => {
    await client?.end();
  });

  // ── Migration chain ─────────────────────────────────────────────────────

  it('applies 113–115 forward and rerunnably (a second apply is a no-op)', async () => {
    for (const file of CHAIN.slice(-3)) {
      await client.query(readFileSync(resolve(process.cwd(), file), 'utf8'));
    }
    const t = await q(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name = ANY($1)`,
      [[
        'billing_invoices', 'billing_invoice_lines', 'billing_subscription_periods',
        'billing_invoice_applications', 'billing_wallet_accounts', 'billing_wallet_ledger',
        'billing_wallet_deposits', 'billing_payment_allocations',
      ]],
    );
    expect(t).toHaveLength(8);
  });

  it('keeps every legacy subscription status valid after widening the constraint', async () => {
    const ws = await makeWorkspace();
    for (const status of ['trialing', 'active', 'past_due', 'canceled', 'unpaid', 'expired', 'incomplete', 'paused']) {
      await client.query(
        `INSERT INTO public.workspace_subscriptions (workspace_id, status)
         VALUES ($1,$2) ON CONFLICT (workspace_id) DO UPDATE SET status = EXCLUDED.status`,
        [ws, status],
      );
    }
    const row = await one(`SELECT status FROM public.workspace_subscriptions WHERE workspace_id=$1`, [ws]);
    expect(row.status).toBe('paused');
  });

  // ── Settlement ──────────────────────────────────────────────────────────

  it('refuses gateway money that does not match the invoice EXACTLY', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, { total: 1_000_000 });
    const pay = await makePayment(ws, 999_999);
    await expect(
      client.query(`SELECT public.billing_settle_invoice($1,$2,'gateway',$3,$4,NULL)`, [
        inv.id, 999_999, `cmd:${uuid()}`, pay,
      ]),
    ).rejects.toThrow(/invoice_amount_mismatch/);

    const after = await one(`SELECT status, amount_paid_irr FROM public.billing_invoices WHERE id=$1`, [inv.id]);
    expect(after.status).toBe('open');
    expect(Number(after.amount_paid_irr)).toBe(0);
  });

  it('settles an exact-amount payment once and replays without double-allocating', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, { total: 2_000_000 });
    const pay = await makePayment(ws, 2_000_000);
    const key = `cmd:${uuid()}`;

    const first = (await one(
      `SELECT public.billing_settle_invoice($1,$2,'gateway',$3,$4,NULL) AS r`,
      [inv.id, 2_000_000, key, pay],
    )).r;
    const second = (await one(
      `SELECT public.billing_settle_invoice($1,$2,'gateway',$3,$4,NULL) AS r`,
      [inv.id, 2_000_000, key, pay],
    )).r;

    expect(first.status).toBe('paid');
    expect(second.replayed).toBe(true);
    const allocations = await q(`SELECT id FROM public.billing_payment_allocations WHERE invoice_id=$1`, [inv.id]);
    expect(allocations).toHaveLength(1);
  });

  it('refuses to settle a voided invoice so the money is parked, not consumed', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, { total: 500_000 });
    await client.query(`UPDATE public.billing_invoices SET status='void', voided_at=now() WHERE id=$1`, [inv.id]);
    await expect(
      client.query(`SELECT public.billing_settle_invoice($1,$2,'gateway',$3,NULL,NULL)`, [
        inv.id, 500_000, `cmd:${uuid()}`,
      ]),
    ).rejects.toThrow(/invoice_not_payable/);
  });

  // ── Immutability ────────────────────────────────────────────────────────

  it('freezes the priced contract once the invoice is issued', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, { total: 1_000_000 });
    await expect(
      client.query(`UPDATE public.billing_invoices SET total_irr = 1 WHERE id=$1`, [inv.id]),
    ).rejects.toThrow(/invoice_immutable/);
    await expect(
      client.query(`UPDATE public.billing_invoices SET effect_snapshot='{}'::jsonb WHERE id=$1`, [inv.id]),
    ).rejects.toThrow(/invoice_immutable/);
  });

  it('keeps the invoice application ledger append-only', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, { total: 100_000, type: 'ai_credit_purchase' });
    await settleGateway(ws, inv.id, 100_000);
    await client.query(`SELECT public.billing_apply_invoice_effects($1)`, [inv.id]);
    await expect(
      client.query(`DELETE FROM public.billing_invoice_applications WHERE invoice_id=$1`, [inv.id]),
    ).rejects.toThrow(/append_only/);
  });

  // ── Effects: exactly once ───────────────────────────────────────────────

  it('grants purchased AI credit exactly once per invoice, even on replay', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, { total: 300_000, type: 'ai_credit_purchase' });
    await settleGateway(ws, inv.id, 300_000);

    const a = (await one(`SELECT public.billing_apply_invoice_effects($1) AS r`, [inv.id])).r;
    const b = (await one(`SELECT public.billing_apply_invoice_effects($1) AS r`, [inv.id])).r;
    expect(b.replayed).toBe(true);
    expect(a.application_id).toBe(b.application_id);

    const lots = await q(
      `SELECT id FROM public.workspace_ai_balance_lots WHERE workspace_id=$1 AND source_type='PURCHASED'`,
      [ws],
    );
    expect(lots).toHaveLength(1);
  });

  it('refuses to apply effects for an invoice that is not paid', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, { total: 100_000 });
    await expect(
      client.query(`SELECT public.billing_apply_invoice_effects($1)`, [inv.id]),
    ).rejects.toThrow(/invoice_not_paid/);
  });

  // ── Periods and AI allowance ────────────────────────────────────────────

  it('grants exactly one plan allowance per period and binds it to the period id', async () => {
    const ws = await makeWorkspace();
    await client.query(`INSERT INTO public.workspace_subscriptions (workspace_id, status) VALUES ($1,'active')`, [ws]);
    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const inv = await makeInvoice(ws, { total: 1_000_000, periodStart: start, periodEnd: end, allowance: 500_000 });

    await settleGateway(ws, inv.id, 1_000_000);
    const applied = (await one(`SELECT public.billing_apply_invoice_effects($1) AS r`, [inv.id])).r;
    expect(applied.activated).toBe(true);

    // Re-activating the same period must not grant a second allowance.
    await client.query(`SELECT public.billing_activate_period($1)`, [applied.period_id]);

    const lots = await q(
      `SELECT billing_cycle_id, original_amount FROM public.workspace_ai_balance_lots
        WHERE workspace_id=$1 AND source_type='PLAN_ALLOWANCE'`,
      [ws],
    );
    expect(lots).toHaveLength(1);
    expect(lots[0].billing_cycle_id).toBe(`period:${applied.period_id}`);
    expect(Number(lots[0].original_amount)).toBe(500_000);
  });

  it('schedules — never activates — a period paid for in advance', async () => {
    const ws = await makeWorkspace();
    await client.query(`INSERT INTO public.workspace_subscriptions (workspace_id, status) VALUES ($1,'active')`, [ws]);
    const start = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const end = new Date(Date.now() + 40 * 86_400_000).toISOString();
    const inv = await makeInvoice(ws, { total: 1_000_000, periodStart: start, periodEnd: end, allowance: 400_000 });

    await settleGateway(ws, inv.id, 1_000_000);
    const applied = (await one(`SELECT public.billing_apply_invoice_effects($1) AS r`, [inv.id])).r;
    expect(applied.activated).toBe(false);

    const period = await one(`SELECT status FROM public.billing_subscription_periods WHERE id=$1`, [applied.period_id]);
    expect(period.status).toBe('scheduled');

    // Paying early must NOT release the allowance early.
    const lots = await q(
      `SELECT id FROM public.workspace_ai_balance_lots WHERE workspace_id=$1 AND source_type='PLAN_ALLOWANCE'`,
      [ws],
    );
    expect(lots).toHaveLength(0);
  });

  it('keeps at most one active period per workspace', async () => {
    const ws = await makeWorkspace();
    await client.query(`INSERT INTO public.workspace_subscriptions (workspace_id, status) VALUES ($1,'active')`, [ws]);
    const mk = async (offsetDays: number) => {
      const start = new Date(Date.now() - 60_000).toISOString();
      const end = new Date(Date.now() + offsetDays * 86_400_000).toISOString();
      const inv = await makeInvoice(ws, { total: 1_000_000, periodStart: start, periodEnd: end });
      await settleGateway(ws, inv.id, 1_000_000);
      return (await one(`SELECT public.billing_apply_invoice_effects($1) AS r`, [inv.id])).r;
    };
    await mk(30);
    await mk(60);
    const active = await q(
      `SELECT id FROM public.billing_subscription_periods WHERE workspace_id=$1 AND status='active'`,
      [ws],
    );
    expect(active).toHaveLength(1);
  });

  it('never creates two service periods from one invoice', async () => {
    const ws = await makeWorkspace();
    await client.query(`INSERT INTO public.workspace_subscriptions (workspace_id, status) VALUES ($1,'active')`, [ws]);
    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const inv = await makeInvoice(ws, { total: 900_000, periodStart: start, periodEnd: end });
    await settleGateway(ws, inv.id, 900_000);
    await client.query(`SELECT public.billing_apply_invoice_effects($1)`, [inv.id]);
    await client.query(`SELECT public.billing_apply_invoice_effects($1)`, [inv.id]);
    const periods = await q(`SELECT id FROM public.billing_subscription_periods WHERE invoice_id=$1`, [inv.id]);
    expect(periods).toHaveLength(1);
  });

  // ── Wallet ──────────────────────────────────────────────────────────────

  it('credits a deposit once and rejects a replay as already applied', async () => {
    const ws = await makeWorkspace();
    const dep = await one(
      `INSERT INTO public.billing_wallet_deposits (workspace_id, document_number, amount_irr)
       VALUES ($1,$2,$3) RETURNING *`,
      [ws, docNumber(), 750_000],
    );
    const a = (await one(`SELECT public.billing_wallet_apply_deposit($1,$2,NULL) AS r`, [dep.id, 750_000])).r;
    const b = (await one(`SELECT public.billing_wallet_apply_deposit($1,$2,NULL) AS r`, [dep.id, 750_000])).r;
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);

    const rec = (await one(`SELECT public.billing_wallet_reconcile($1) AS r`, [ws])).r;
    expect(rec.ledger_balance_irr).toBe(750_000);
    expect(rec.consistent).toBe(true);
  });

  it('never lets the wallet go negative', async () => {
    const ws = await makeWorkspace();
    await expect(
      client.query(`SELECT public.billing_wallet_refund($1,$2,$3,'test',NULL)`, [ws, 1_000, `cmd:${uuid()}`]),
    ).rejects.toThrow(/wallet_insufficient_funds/);
  });

  it('pays an invoice from the wallet atomically (debit + settle)', async () => {
    const ws = await makeWorkspace();
    const dep = await one(
      `INSERT INTO public.billing_wallet_deposits (workspace_id, document_number, amount_irr)
       VALUES ($1,$2,$3) RETURNING *`,
      [ws, docNumber(), 1_000_000],
    );
    await client.query(`SELECT public.billing_wallet_apply_deposit($1,$2,NULL)`, [dep.id, 1_000_000]);

    const inv = await makeInvoice(ws, { total: 600_000, type: 'ai_credit_purchase' });
    const res = (await one(`SELECT public.billing_wallet_pay_invoice($1,NULL) AS r`, [inv.id])).r;
    expect(res.status).toBe('paid');

    const rec = (await one(`SELECT public.billing_wallet_reconcile($1) AS r`, [ws])).r;
    expect(rec.ledger_balance_irr).toBe(400_000);
    expect(rec.consistent).toBe(true);
  });

  it('keeps the wallet ledger append-only', async () => {
    const ws = await makeWorkspace();
    const dep = await one(
      `INSERT INTO public.billing_wallet_deposits (workspace_id, document_number, amount_irr)
       VALUES ($1,$2,$3) RETURNING *`,
      [ws, docNumber(), 100_000],
    );
    await client.query(`SELECT public.billing_wallet_apply_deposit($1,$2,NULL)`, [dep.id, 100_000]);
    await expect(
      client.query(`UPDATE public.billing_wallet_ledger SET amount_irr = 999 WHERE workspace_id=$1`, [ws]),
    ).rejects.toThrow(/append_only/);
  });

  it('does not double-credit under concurrent deposit application', async () => {
    const { Client } = await import('pg');
    const ws = await makeWorkspace();
    const dep = await one(
      `INSERT INTO public.billing_wallet_deposits (workspace_id, document_number, amount_irr)
       VALUES ($1,$2,$3) RETURNING *`,
      [ws, docNumber(), 250_000],
    );

    const clients = [new Client({ connectionString: DSN }), new Client({ connectionString: DSN })];
    await Promise.all(clients.map((c) => c.connect()));
    await Promise.allSettled(
      clients.map((c) => c.query(`SELECT public.billing_wallet_apply_deposit($1,$2,NULL)`, [dep.id, 250_000])),
    );
    await Promise.all(clients.map((c) => c.end()));

    const rec = (await one(`SELECT public.billing_wallet_reconcile($1) AS r`, [ws])).r;
    expect(rec.ledger_balance_irr).toBe(250_000);
    expect(rec.consistent).toBe(true);
  });

  it('requires an auditable reason for a manual admin adjustment', async () => {
    const ws = await makeWorkspace();
    await expect(
      client.query(`SELECT public.billing_wallet_admin_adjust($1,$2,$3,'',NULL)`, [ws, 1_000, `cmd:${uuid()}`]),
    ).rejects.toThrow(/admin_adjustment_reason_required/);
  });

  // ── ACL ─────────────────────────────────────────────────────────────────

  it('denies every V2 financial function to anon and authenticated', async () => {
    const functions = [
      'billing_settle_invoice', 'billing_apply_invoice_effects', 'billing_activate_period',
      'billing_activate_due_periods', 'billing_wallet_apply_deposit', 'billing_wallet_pay_invoice',
      'billing_wallet_refund', 'billing_wallet_admin_adjust', 'billing_wallet_reconcile',
      'billing_wallet_append', 'billing_wallet_lock',
    ];
    for (const role of ['anon', 'authenticated']) {
      const rows = await q(
        `SELECT p.proname FROM pg_proc p
          WHERE p.pronamespace='public'::regnamespace
            AND p.proname = ANY($1)
            AND has_function_privilege($2, p.oid, 'EXECUTE')`,
        [functions, role],
      );
      expect(rows.map((r: any) => r.proname)).toEqual([]);
    }
  });

  it('denies direct table access on every V2 financial table', async () => {
    const tables = [
      'billing_invoices', 'billing_invoice_lines', 'billing_subscription_periods',
      'billing_invoice_applications', 'billing_wallet_accounts', 'billing_wallet_ledger',
      'billing_wallet_deposits', 'billing_payment_allocations',
    ];
    for (const role of ['anon', 'authenticated']) {
      for (const table of tables) {
        for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          const r = await one(
            `SELECT has_table_privilege($1, format('public.%I', $2::text), $3) AS allowed`,
            [role, table, priv],
          );
          expect({ role, table, priv, allowed: r.allowed }).toEqual({ role, table, priv, allowed: false });
        }
      }
    }
  });

  // ── Collection reservation: gateway ↔ wallet exclusion ──────────────────

  it('lets only one channel hold an invoice at a time', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, { total: 500_000 });

    const held = (await one(
      `SELECT public.billing_begin_collection($1,'gateway',$2,$3,NULL,1800) AS r`,
      [inv.id, 500_000, `gw:${inv.id}`],
    )).r;
    expect(held.channel).toBe('gateway');

    // The wallet may not settle behind a live checkout.
    await expect(
      client.query(`SELECT public.billing_begin_collection($1,'wallet',$2,$3,NULL,300)`, [
        inv.id, 500_000, `w:${inv.id}`,
      ]),
    ).rejects.toThrow(/invoice_collection_locked/);

    // Same checkout, replayed: same reservation, no second lock.
    const again = (await one(
      `SELECT public.billing_begin_collection($1,'gateway',$2,$3,NULL,1800) AS r`,
      [inv.id, 500_000, `gw:${inv.id}`],
    )).r;
    expect(again.collection_id).toBe(held.collection_id);
    expect(again.replayed).toBe(true);

    // Releasing hands the invoice back.
    await client.query(`SELECT public.billing_release_collection($1,'abandoned')`, [held.collection_id]);
    const wallet = (await one(
      `SELECT public.billing_begin_collection($1,'wallet',$2,$3,NULL,300) AS r`,
      [inv.id, 500_000, `w:${inv.id}`],
    )).r;
    expect(wallet.channel).toBe('wallet');
  });

  it('never lets a dead checkout block an invoice forever', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, { total: 300_000 });
    const held = (await one(
      `SELECT public.billing_begin_collection($1,'gateway',$2,$3,NULL,30) AS r`,
      [inv.id, 300_000, `gw-exp:${inv.id}`],
    )).r;
    await client.query(
      `UPDATE public.billing_invoice_collections SET expires_at = now() - interval '1 minute' WHERE id=$1`,
      [held.collection_id],
    );
    const wallet = (await one(
      `SELECT public.billing_begin_collection($1,'wallet',$2,$3,NULL,300) AS r`,
      [inv.id, 300_000, `w-exp:${inv.id}`],
    )).r;
    expect(wallet.channel).toBe('wallet');
    const dead = await one(`SELECT status FROM public.billing_invoice_collections WHERE id=$1`, [held.collection_id]);
    expect(dead.status).toBe('expired');
  });

  it('refuses a settlement from a channel that does not hold the reservation', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, { total: 200_000 });
    await client.query(`SELECT public.billing_begin_collection($1,'wallet',$2,$3,NULL,300)`, [
      inv.id, 200_000, `w-conf:${inv.id}`,
    ]);
    const pay = await makePayment(ws, 200_000);
    await expect(
      client.query(`SELECT public.billing_settle_invoice($1,$2,'gateway',$3,$4,NULL)`, [
        inv.id, 200_000, `s-conf:${inv.id}`, pay,
      ]),
    ).rejects.toThrow(/invoice_collection_conflict/);
  });

  it('consumes the reservation when the settlement succeeds', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, { total: 250_000 });
    const held = (await one(
      `SELECT public.billing_begin_collection($1,'gateway',$2,$3,NULL,1800) AS r`,
      [inv.id, 250_000, `gw-ok:${inv.id}`],
    )).r;
    const pay = await makePayment(ws, 250_000);
    await client.query(`SELECT public.billing_settle_invoice($1,$2,'gateway',$3,$4,NULL)`, [
      inv.id, 250_000, `s-ok:${inv.id}`, pay,
    ]);
    const col = await one(`SELECT status FROM public.billing_invoice_collections WHERE id=$1`, [held.collection_id]);
    expect(col.status).toBe('consumed');
  });

  // ── Crash between settlement and effects ────────────────────────────────

  it('leaves a durable work item when the process dies after settlement', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, {
      total: 400_000,
      periodStart: new Date().toISOString(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      allowance: 90_000,
    });
    const pay = await makePayment(ws, 400_000);
    // Settlement only — the effects never ran (simulated crash).
    await client.query(`SELECT public.billing_settle_invoice($1,$2,'gateway',$3,$4,NULL)`, [
      inv.id, 400_000, `crash:${inv.id}`, pay,
    ]);

    const pending = await one(
      `SELECT application_status FROM public.billing_invoice_applications WHERE invoice_id=$1`, [inv.id],
    );
    expect(pending.application_status).toBe('pending');

    const rec = (await one(`SELECT public.billing_recover_unapplied_invoices(50) AS r`)).r;
    expect(rec.applied).toBeGreaterThanOrEqual(1);

    const done = await one(
      `SELECT application_status, period_id FROM public.billing_invoice_applications WHERE invoice_id=$1`, [inv.id],
    );
    expect(done.application_status).toBe('applied');
    expect(done.period_id).toBeTruthy();

    // Recovery is not a second grant.
    const before = await one(`SELECT count(*) c FROM public.workspace_ai_balance_lots WHERE workspace_id=$1`, [ws]);
    await client.query(`SELECT public.billing_recover_unapplied_invoices(50)`);
    const after = await one(`SELECT count(*) c FROM public.workspace_ai_balance_lots WHERE workspace_id=$1`, [ws]);
    expect(after.c).toBe(before.c);
  });

  it('keeps an applied effect frozen forever', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, { total: 120_000, type: 'ai_credit_purchase' });
    const pay = await makePayment(ws, 120_000);
    await client.query(`SELECT public.billing_settle_invoice($1,$2,'gateway',$3,$4,NULL)`, [
      inv.id, 120_000, `frz:${inv.id}`, pay,
    ]);
    await client.query(`SELECT public.billing_apply_invoice_effects($1)`, [inv.id]);
    await expect(
      client.query(
        `UPDATE public.billing_invoice_applications SET application_status='pending' WHERE invoice_id=$1`, [inv.id],
      ),
    ).rejects.toThrow(/invoice_application_append_only/);
  });

  // ── Legacy → V2 AI allowance handover ───────────────────────────────────

  it('keeps the legacy monthly allowance authoritative until a V2 period activates', async () => {
    const ws = await makeWorkspace();
    await client.query(
      `INSERT INTO public.workspace_subscriptions (workspace_id, status) VALUES ($1,'active')
       ON CONFLICT (workspace_id) DO UPDATE SET status='active'`, [ws],
    );
    const legacyActive = await one(`SELECT public.billing_legacy_allowance_active($1) AS a`, [ws]);
    expect(legacyActive.a).toBe(true);

    // The legacy calendar grant this month.
    await client.query(
      `SELECT public.ai_grant_allowance($1,$2,$3,'plan',$4,$5)`,
      [ws, 100_000, '2026-08', new Date(Date.now() + 10 * 86_400_000).toISOString(), `grant:${ws}:2026-08:plan`],
    );
    const legacyBalance = await one(
      `SELECT COALESCE(sum(remaining_amount),0) AS s FROM public.workspace_ai_balance_lots
        WHERE workspace_id=$1 AND state IN ('ACTIVE','EXPIRING')`, [ws],
    );
    expect(Number(legacyBalance.s)).toBe(100_000);

    // Mid-month upgrade: a real invoice period takes over.
    const inv = await makeInvoice(ws, {
      total: 900_000,
      periodStart: new Date().toISOString(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      allowance: 300_000,
    });
    const pay = await makePayment(ws, 900_000);
    await client.query(`SELECT public.billing_settle_invoice($1,$2,'gateway',$3,$4,NULL)`, [
      inv.id, 900_000, `up:${inv.id}`, pay,
    ]);
    await client.query(`SELECT public.billing_apply_invoice_effects($1)`, [inv.id]);

    // Exactly the new allowance — never legacy + V2 for the same days.
    const after = await one(
      `SELECT COALESCE(sum(remaining_amount),0) AS s FROM public.workspace_ai_balance_lots
        WHERE workspace_id=$1 AND state IN ('ACTIVE','EXPIRING')`, [ws],
    );
    expect(Number(after.s)).toBe(300_000);

    // And the legacy path is off for good.
    const now = await one(`SELECT public.billing_legacy_allowance_active($1) AS a`, [ws]);
    expect(now.a).toBe(false);
  });

  it('never invalidates an in-flight AI run when it retires the legacy allowance', async () => {
    const ws = await makeWorkspace();
    await client.query(
      `INSERT INTO public.workspace_subscriptions (workspace_id, status) VALUES ($1,'active')
       ON CONFLICT (workspace_id) DO UPDATE SET status='active'`, [ws],
    );
    await client.query(
      `SELECT public.ai_grant_allowance($1,$2,$3,'plan',$4,$5)`,
      [ws, 50_000, '2026-09', new Date(Date.now() + 10 * 86_400_000).toISOString(), `grant:${ws}:2026-09:plan`],
    );
    // 20_000 is reserved by a running job.
    await client.query(
      `UPDATE public.workspace_ai_balance_lots SET reserved_amount = 20000
        WHERE workspace_id=$1 AND source_type='PLAN_ALLOWANCE'`, [ws],
    );
    const retired = await one(`SELECT public.billing_retire_legacy_allowance($1) AS n`, [ws]);
    expect(Number(retired.n)).toBe(1);
    const lot = await one(
      `SELECT remaining_amount, reserved_amount, state FROM public.workspace_ai_balance_lots
        WHERE workspace_id=$1 AND source_type='PLAN_ALLOWANCE'`, [ws],
    );
    expect(Number(lot.remaining_amount)).toBe(20_000);
    expect(lot.state).toBe('EXPIRING');
  });

  // ── Backfill (116) ──────────────────────────────────────────────────────

  it('gives every live subscription a period without inventing money', async () => {
    const ws = await makeWorkspace();
    await client.query(
      `INSERT INTO public.workspace_subscriptions (workspace_id, status) VALUES ($1,'active')
       ON CONFLICT (workspace_id) DO UPDATE SET status='active'`, [ws],
    );
    const backfill = readFileSync(resolve(process.cwd(), 'database/migrations/116_billing_v2_backfill.sql'), 'utf8');
    await client.query(backfill);
    await client.query(backfill); // re-runnable

    const sub = await one(
      `SELECT current_period_id, billing_engine_version, v2_allowance_effective_period_id
         FROM public.workspace_subscriptions WHERE workspace_id=$1`, [ws],
    );
    expect(sub.current_period_id).toBeTruthy();
    expect(sub.billing_engine_version).toBe('v2');
    // The AI allowance stays on the legacy path until a real invoice period.
    expect(sub.v2_allowance_effective_period_id).toBeNull();

    const periods = await q(
      `SELECT source, ai_allowance_irr FROM public.billing_subscription_periods
        WHERE workspace_id=$1 AND status='active'`, [ws],
    );
    expect(periods).toHaveLength(1);
    expect(periods[0].source).toBe('legacy_migration');
    expect(Number(periods[0].ai_allowance_irr)).toBe(0);

    const invoices = await one(
      `SELECT count(*) c FROM public.billing_invoices WHERE workspace_id=$1`, [ws],
    );
    expect(Number(invoices.c)).toBe(0);
  });


  // ══════════════════════════════════════════════════════════════════════
  // PHASE B — rollout authority, legacy drain, runtime guards.
  // ══════════════════════════════════════════════════════════════════════

  describe('Phase B — rollout state machine', () => {
    it('defaults to legacy and moves legacy → shadow → v2_active monotonically', async () => {
      const ws = await makeWorkspace();
      expect((await one(`SELECT public.billing_v2_state($1) AS s`, [ws])).s).toBe('legacy');

      await q(`SELECT public.billing_v2_set_state($1,'shadow',NULL,'ramp',false)`, [ws]);
      expect((await one(`SELECT public.billing_v2_state($1) AS s`, [ws])).s).toBe('shadow');

      const r = (await one(`SELECT public.billing_v2_activate($1,NULL,'cutover') AS r`, [ws])).r;
      expect(r.state).toBe('v2_active');
      expect((await one(`SELECT public.billing_v2_state($1) AS s`, [ws])).s).toBe('v2_active');
    });

    it('refuses any rollback out of v2_active without break-glass', async () => {
      const ws = await makeWorkspace();
      await q(`SELECT public.billing_v2_activate($1,NULL,'cutover')`, [ws]);
      await expect(
        q(`SELECT public.billing_v2_set_state($1,'legacy',NULL,'oops',false)`, [ws]),
      ).rejects.toThrow(/billing_v2_rollback_forbidden/);
      await expect(
        q(`SELECT public.billing_v2_set_state($1,'shadow',NULL,'oops',false)`, [ws]),
      ).rejects.toThrow(/billing_v2_rollback_forbidden/);
      expect((await one(`SELECT public.billing_v2_state($1) AS s`, [ws])).s).toBe('v2_active');
    });

    it('activation is idempotent — replay never creates a second period', async () => {
      const ws = await makeWorkspace();
      await q(`SELECT public.billing_v2_activate($1,NULL,'first')`, [ws]);
      const first = await q(
        `SELECT id FROM public.billing_subscription_periods WHERE workspace_id=$1`, [ws]);
      const again = (await one(`SELECT public.billing_v2_activate($1,NULL,'again') AS r`, [ws])).r;
      expect(again.already_active).toBe(true);
      const after = await q(
        `SELECT id FROM public.billing_subscription_periods WHERE workspace_id=$1`, [ws]);
      expect(after.length).toBe(first.length);
    });
  });

  describe('Phase B — legacy payment intent drain', () => {
    it('BLOCKS cutover on a bound legacy intent and cancels unbound pending ones', async () => {
      const ws = await makeWorkspace();
      // bound = money may still land: processing, or pending with a provider ref
      await client.query(
        `INSERT INTO public.billing_payment_intents
           (workspace_id, invoice_number, amount_irr, status, provider_ref, purchase_type)
         VALUES ($1,$2,100000,'pending','REF-1','subscription')`, [ws, docNumber()]);
      const readiness = (await one(`SELECT public.billing_v2_evaluate_cutover($1) AS r`, [ws])).r;
      expect(readiness.ready).toBe(false);
      expect(JSON.stringify(readiness.blockers)).toContain('legacy_payment_intent');
      await expect(
        q(`SELECT public.billing_v2_activate($1,NULL,'x')`, [ws]),
      ).rejects.toThrow(/billing_v2_cutover_blocked/);

      // resolve the bound intent, leave an UNBOUND pending one behind
      await client.query(
        `UPDATE public.billing_payment_intents SET status='expired' WHERE workspace_id=$1`, [ws]);
      const unbound = await one(
        `INSERT INTO public.billing_payment_intents
           (workspace_id, invoice_number, amount_irr, status, purchase_type)
         VALUES ($1,$2,50000,'pending','subscription') RETURNING id`, [ws, docNumber()]);

      const r = (await one(`SELECT public.billing_v2_activate($1,NULL,'drain') AS r`, [ws])).r;
      expect(r.state).toBe('v2_active');
      const drained = await one(
        `SELECT status, failure_reason FROM public.billing_payment_intents WHERE id=$1`,
        [unbound.id]);
      expect(drained.status).toBe('canceled');
      expect(drained.failure_reason).toBe('billing_v2_cutover_drain');
    });
  });

  describe('Phase B — engine version stamping', () => {
    it('stamps and FREEZES billing_engine_version on financial objects', async () => {
      const ws = await makeWorkspace();
      const intent = await one(
        `INSERT INTO public.billing_payment_intents
           (workspace_id, invoice_number, amount_irr, status, purchase_type)
         VALUES ($1,$2,10000,'pending','subscription') RETURNING id, billing_engine_version`,
        [ws, docNumber()]);
      expect(intent.billing_engine_version).toBe('v1');
      await expect(
        q(`UPDATE public.billing_payment_intents SET billing_engine_version='v2' WHERE id=$1`,
          [intent.id]),
      ).rejects.toThrow(/immutable/i);

      const inv = await makeInvoice(ws, { total: 10000 });
      expect(inv.billing_engine_version).toBe('v2');
      await expect(
        q(`UPDATE public.billing_invoices SET billing_engine_version='v1' WHERE id=$1`, [inv.id]),
      ).rejects.toThrow(/immutable/i);
    });
  });

  describe('Phase B — database-level authority isolation', () => {
    it('blocks direct legacy subscription-window mutation once V2 owns the workspace', async () => {
      const ws = await makeWorkspace();
      await client.query(
        `INSERT INTO public.workspace_subscriptions (workspace_id, status) VALUES ($1,'active')`, [ws]);
      await q(`SELECT public.billing_v2_activate($1,NULL,'cutover')`, [ws]);
      await expect(
        q(`UPDATE public.workspace_subscriptions
              SET current_period_end = now() + interval '400 days'
            WHERE workspace_id=$1`, [ws]),
      ).rejects.toThrow(/billing_v2_direct_subscription_mutation_forbidden/);
      // non-financial columns stay writable
      await q(`UPDATE public.workspace_subscriptions SET updated_at=now() WHERE workspace_id=$1`, [ws]);
    });

    it('blocks a legacy AI plan allowance grant after the V2 handover', async () => {
      const ws = await makeWorkspace();
      await client.query(
        `INSERT INTO public.workspace_subscriptions (workspace_id, status) VALUES ($1,'active')`, [ws]);
      await q(`SELECT public.billing_v2_activate($1,NULL,'cutover')`, [ws]);
      const period = await one(
        `SELECT id FROM public.billing_subscription_periods
          WHERE workspace_id=$1 AND status='active'`, [ws]);
      await client.query(
        `UPDATE public.workspace_subscriptions SET v2_allowance_effective_period_id=$2
          WHERE workspace_id=$1`, [ws, period.id]);

      await expect(
        q(`INSERT INTO public.workspace_ai_balance_lots
             (workspace_id, source_type, billing_cycle_id, original_amount, remaining_amount, allowance_source)
           VALUES ($1,'PLAN_ALLOWANCE','2026-03',100000,100000,'plan')`, [ws]),
      ).rejects.toThrow(/billing_v2_legacy_allowance_blocked/);

      // the period-bound V2 grant is still allowed
      await q(
        `INSERT INTO public.workspace_ai_balance_lots
           (workspace_id, source_type, billing_cycle_id, original_amount, remaining_amount, allowance_source)
         VALUES ($1,'PLAN_ALLOWANCE',$2,100000,100000,'plan')`, [ws, `period:${period.id}`]);
    });
  });

  describe('Phase B — mixed population isolation', () => {
    it('keeps legacy, shadow and V2 workspaces free of cross-effects', async () => {
      const legacy = await makeWorkspace();
      const shadow = await makeWorkspace();
      const v2 = await makeWorkspace();
      for (const ws of [legacy, shadow, v2]) {
        await client.query(
          `INSERT INTO public.workspace_subscriptions (workspace_id, status) VALUES ($1,'active')`, [ws]);
      }
      await q(`SELECT public.billing_v2_set_state($1,'shadow',NULL,'ramp',false)`, [shadow]);
      await q(`SELECT public.billing_v2_activate($1,NULL,'cutover')`, [v2]);

      expect((await one(`SELECT public.billing_v2_state($1) AS s`, [legacy])).s).toBe('legacy');
      expect((await one(`SELECT public.billing_v2_state($1) AS s`, [shadow])).s).toBe('shadow');

      // shadow must have NO financial side effect: no period was created for it
      const shadowPeriods = await one(
        `SELECT count(*) c FROM public.billing_subscription_periods WHERE workspace_id=$1`, [shadow]);
      expect(Number(shadowPeriods.c)).toBe(0);

      // legacy and shadow keep their legacy write path
      for (const ws of [legacy, shadow]) {
        await q(`UPDATE public.workspace_subscriptions
                    SET current_period_end = now() + interval '30 days'
                  WHERE workspace_id=$1`, [ws]);
      }
      // the V2 workspace does not
      await expect(
        q(`UPDATE public.workspace_subscriptions
              SET current_period_end = now() + interval '30 days'
            WHERE workspace_id=$1`, [v2]),
      ).rejects.toThrow(/billing_v2_direct_subscription_mutation_forbidden/);
    });
  });

  describe('Phase B — rollout ACL', () => {
    it('denies anon and authenticated every rollout control function', async () => {
      for (const role of ['anon', 'authenticated']) {
        for (const fn of [
          `public.billing_v2_activate('00000000-0000-4000-8000-000000000000'::uuid,NULL,'x')`,
          `public.billing_v2_set_state('00000000-0000-4000-8000-000000000000'::uuid,'shadow',NULL,'x',false)`,
        ]) {
          await client.query(`SET LOCAL ROLE ${role}`).catch(() => {});
          await client.query('BEGIN');
          await client.query(`SET LOCAL ROLE ${role}`);
          await expect(client.query(`SELECT ${fn}`)).rejects.toThrow(/permission denied/i);
          await client.query('ROLLBACK');
        }
      }
    });
  });

});
