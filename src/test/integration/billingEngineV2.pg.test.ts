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

/** Creates a workspace row through whatever minimal shape the base chain has. */
async function makeWorkspace(): Promise<string> {
  const id = uuid();
  await client.query(
    `INSERT INTO public.workspaces (id, name, slug) VALUES ($1, $2, $3)`,
    [id, `ws-${id.slice(0, 8)}`, `ws-${id.slice(0, 8)}`],
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
  const r = await one(
    `INSERT INTO public.billing_payments (workspace_id, amount_irr, status)
     VALUES ($1, $2, 'succeeded') RETURNING id`,
    [ws, amount],
  );
  return r.id;
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
    await client.query(`SELECT public.billing_settle_invoice($1,$2,'gateway',$3,NULL,NULL)`, [
      inv.id, 100_000, `cmd:${uuid()}`,
    ]);
    await client.query(`SELECT public.billing_apply_invoice_effects($1)`, [inv.id]);
    await expect(
      client.query(`DELETE FROM public.billing_invoice_applications WHERE invoice_id=$1`, [inv.id]),
    ).rejects.toThrow(/append_only/);
  });

  // ── Effects: exactly once ───────────────────────────────────────────────

  it('grants purchased AI credit exactly once per invoice, even on replay', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, { total: 300_000, type: 'ai_credit_purchase' });
    await client.query(`SELECT public.billing_settle_invoice($1,$2,'gateway',$3,NULL,NULL)`, [
      inv.id, 300_000, `cmd:${uuid()}`,
    ]);

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

    await client.query(`SELECT public.billing_settle_invoice($1,$2,'gateway',$3,NULL,NULL)`, [
      inv.id, 1_000_000, `cmd:${uuid()}`,
    ]);
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

    await client.query(`SELECT public.billing_settle_invoice($1,$2,'gateway',$3,NULL,NULL)`, [
      inv.id, 1_000_000, `cmd:${uuid()}`,
    ]);
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
      await client.query(`SELECT public.billing_settle_invoice($1,$2,'gateway',$3,NULL,NULL)`, [
        inv.id, 1_000_000, `cmd:${uuid()}`,
      ]);
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
    await client.query(`SELECT public.billing_settle_invoice($1,$2,'gateway',$3,NULL,NULL)`, [
      inv.id, 900_000, `cmd:${uuid()}`,
    ]);
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
});
