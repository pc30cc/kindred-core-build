/**
 * Billing Engine V2 — Phase D0 invariants against real PostgreSQL.
 *
 * A yearly subscription is ONE service period the customer paid for, but the
 * plan's AI allowance is a MONTHLY entitlement. The properties below are the
 * ones that decide whether a customer gets a year of AI credit on day one, or
 * whether two months of downtime silently hand them a triple allowance:
 *
 *   - monthly period  → one entitlement cycle → one grant
 *   - yearly period   → twelve anchored, calendar-safe cycles, funded ONE at
 *                       a time, never 12× up front
 *   - expired cycles never become spendable retroactively
 *   - exactly one grant per cycle under replay and concurrency
 *   - purchased AI credit is untouched by cycle boundaries
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
    'REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — Billing Engine V2 Phase D0 database tests are mandatory in CI.',
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

async function makeSubscription(
  ws: string,
  o: { planId: string; interval?: 'monthly' | 'yearly'; periodStart: string; periodEnd: string },
): Promise<any> {
  return one(
    `INSERT INTO public.workspace_subscriptions
       (workspace_id, plan_id, status, billing_interval, current_period_start, current_period_end,
        next_invoice_at, billing_engine_version)
     VALUES ($1,$2,'active',$3,$4,$5,$5,'v2')
     ON CONFLICT (workspace_id) DO UPDATE SET plan_id = EXCLUDED.plan_id
     RETURNING *`,
    [ws, o.planId, o.interval ?? 'monthly', o.periodStart, o.periodEnd],
  );
}

interface PeriodOpts {
  planId: string;
  interval: 'monthly' | 'yearly';
  start: string;
  /** Omit to derive a calendar-exact window (what the real engine issues). */
  end?: string;
  monthlyAllowance: number;
  source?: string;
}

/** A scheduled service period with a frozen snapshot, exactly as V2 issues it. */
async function makePeriod(ws: string, subId: string, o: PeriodOpts): Promise<any> {
  const total = o.interval === 'yearly' ? o.monthlyAllowance * 12 : o.monthlyAllowance;
  return one(
    `INSERT INTO public.billing_subscription_periods
       (workspace_id, subscription_id, plan_id, invoice_id, billing_interval,
        period_start, period_end, status, source, plan_snapshot, limits_snapshot, ai_allowance_irr)
     VALUES ($1,$2,$3,NULL,$4,$5,
             COALESCE($6::timestamptz, public.billing_v2_add_interval($5::timestamptz, $4, 1)),
             'scheduled',$7,'{}'::jsonb,$8::jsonb,$9)
     RETURNING *`,
    [
      ws, subId, o.planId, o.interval, o.start, o.end ?? null, o.source ?? 'admin',
      JSON.stringify({ ai_credits_per_month: o.monthlyAllowance }), total,
    ],
  );
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

const cycles = (ws: string) =>
  q(`SELECT * FROM public.billing_entitlement_cycles WHERE workspace_id=$1 ORDER BY cycle_index`, [ws]);

const planLots = (ws: string) =>
  q(
    `SELECT * FROM public.workspace_ai_balance_lots
      WHERE workspace_id=$1 AND source_type='PLAN_ALLOWANCE' ORDER BY created_at`,
    [ws],
  );

const grantedTotal = async (ws: string) =>
  (await planLots(ws)).reduce((s: number, l: any) => s + Number(l.original_amount), 0);

suite('Billing Engine V2 — Phase D0 entitlement cycles (PostgreSQL)', () => {
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

  it('applies 119 forward and rerunnably, and leaves 113–118 untouched', async () => {
    await client.query(readFileSync(resolve(process.cwd(), CHAIN[CHAIN.length - 1]), 'utf8'));
    const t = await one(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='billing_entitlement_cycles'`,
    );
    expect(t).toBeTruthy();
    const uniques = await q(
      `SELECT conname FROM pg_constraint
        WHERE conrelid='public.billing_entitlement_cycles'::regclass AND contype='u'`,
    );
    expect(uniques.map((r: any) => r.conname).sort()).toEqual([
      'uq_billing_entitlement_cycles_index',
      'uq_billing_entitlement_cycles_start',
    ]);
  });

  it('freezes the financial columns of a created cycle', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000, allowance: 300_000 });
    const sub = await makeSubscription(ws, { planId: plan, periodStart: inDays(-1), periodEnd: inDays(29) });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'monthly', start: inDays(-1), end: inDays(29), monthlyAllowance: 300_000,
    });
    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);
    const [c] = await cycles(ws);
    await expect(
      client.query(`UPDATE public.billing_entitlement_cycles SET ai_allowance_irr = 1 WHERE id=$1`, [c.id]),
    ).rejects.toThrow(/billing_entitlement_cycle_immutable/);
  });

  // ── Monthly subscription ────────────────────────────────────────────────

  it('monthly period → ONE cycle spanning it, ONE grant', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000, allowance: 500_000 });
    const sub = await makeSubscription(ws, { planId: plan, periodStart: inDays(0), periodEnd: inDays(30) });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'monthly', start: inDays(-0.01), monthlyAllowance: 500_000,
    });

    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);

    const cs = await cycles(ws);
    expect(cs).toHaveLength(1);
    expect(cs[0].status).toBe('active');
    expect(Number(cs[0].ai_allowance_irr)).toBe(500_000);
    expect(cs[0].allowance_state).toBe('granted');
    expect(await grantedTotal(ws)).toBe(500_000);
  });

  it('monthly and yearly share ONE implementation: same table, same authority', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ yearly: 10_000_000, allowance: 400_000 });
    const sub = await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(0), periodEnd: inDays(365),
    });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'yearly', start: inDays(-0.01), monthlyAllowance: 400_000,
    });
    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);
    const cs = await cycles(ws);
    expect(cs.every((c: any) => c.subscription_period_id === period.id)).toBe(true);
  });

  // ── Annual subscription ─────────────────────────────────────────────────

  it('yearly period → TWELVE monthly cycles, only the first one funded', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ yearly: 10_000_000, allowance: 400_000 });
    const sub = await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(0), periodEnd: inDays(365),
    });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'yearly', start: inDays(-0.01), monthlyAllowance: 400_000,
    });

    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);

    const cs = await cycles(ws);
    expect(cs).toHaveLength(12);
    expect(cs.filter((c: any) => c.status === 'active')).toHaveLength(1);
    expect(cs.filter((c: any) => c.status === 'scheduled')).toHaveLength(11);
    expect(cs.every((c: any) => Number(c.ai_allowance_irr) === 400_000)).toBe(true);

    // The whole point of D0: one month, not twelve.
    expect(await grantedTotal(ws)).toBe(400_000);
    expect(await planLots(ws)).toHaveLength(1);
  });

  it('the annual allowance lot expires at the CYCLE end, not the period end', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ yearly: 10_000_000, allowance: 400_000 });
    const sub = await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(0), periodEnd: inDays(365),
    });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'yearly', start: inDays(-0.01), monthlyAllowance: 400_000,
    });
    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);

    const [lot] = await planLots(ws);
    const [c0] = await cycles(ws);
    expect(new Date(lot.expires_at).toISOString()).toBe(new Date(c0.cycle_end).toISOString());
    expect(new Date(lot.expires_at).getTime()).toBeLessThan(new Date(period.period_end).getTime());
  });

  it('grants the SECOND month with no new invoice and no new payment', async () => {
    // A yearly period that started 40 days ago: cycle 0 is over, cycle 1 is live.
    const ws = await makeWorkspace();
    const plan = await makePlan({ yearly: 10_000_000, allowance: 400_000 });
    const sub = await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(-40), periodEnd: inDays(325),
    });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'yearly', start: inDays(-40), monthlyAllowance: 400_000,
    });

    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);

    const cs = await cycles(ws);
    const active = cs.filter((c: any) => c.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].cycle_index).toBe(1);
    expect(await grantedTotal(ws)).toBe(400_000);

    const invoices = await q(`SELECT id FROM public.billing_invoices WHERE workspace_id=$1`, [ws]);
    expect(invoices).toHaveLength(0);
  });

  // ── Downtime — the critical invariant ───────────────────────────────────

  it('two months of worker downtime NEVER stack allowance retroactively', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ yearly: 10_000_000, allowance: 400_000 });
    const sub = await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(-70), periodEnd: inDays(295),
    });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'yearly', start: inDays(-70), monthlyAllowance: 400_000,
    });

    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);
    await client.query(`SELECT public.billing_v2_run_entitlement_cycles(50)`);

    const cs = await cycles(ws);
    const expired = cs.filter((c: any) => new Date(c.cycle_end).getTime() <= Date.now());
    expect(expired.length).toBeGreaterThanOrEqual(2);
    expect(expired.every((c: any) => c.status === 'completed')).toBe(true);
    expect(expired.every((c: any) => c.allowance_state !== 'granted')).toBe(true);

    // Exactly ONE spendable month, and it is the current one.
    expect(await planLots(ws)).toHaveLength(1);
    expect(await grantedTotal(ws)).toBe(400_000);
  });

  it('a late activation still funds the FULL cycle, expiring at the same cycle end', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000, allowance: 600_000 });
    const sub = await makeSubscription(ws, { planId: plan, periodStart: inDays(-10), periodEnd: inDays(20) });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'monthly', start: inDays(-10), end: inDays(20), monthlyAllowance: 600_000,
    });

    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);
    const [c] = await cycles(ws);
    expect(Number(c.ai_allowance_irr)).toBe(600_000);
    const [lot] = await planLots(ws);
    expect(new Date(lot.expires_at).toISOString()).toBe(new Date(c.cycle_end).toISOString());
  });

  // ── Calendar-safe anchoring ─────────────────────────────────────────────

  it('anchors cycles calendar-safely from 31 Jan (28 Feb, 31 Mar, 30 Apr…)', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ yearly: 10_000_000, allowance: 100_000 });
    const sub = await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(1), periodEnd: inDays(366),
    });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'yearly',
      start: '2026-01-31T00:00:00Z', end: '2027-01-31T00:00:00Z', monthlyAllowance: 100_000,
    });

    await client.query(`SELECT public.billing_v2_ensure_period_cycles($1)`, [period.id]);
    const cs = await q(
      `SELECT cycle_index, cycle_start, cycle_end FROM public.billing_entitlement_cycles
        WHERE subscription_period_id=$1 ORDER BY cycle_index`,
      [period.id],
    );
    expect(cs).toHaveLength(12);
    const starts = cs.map((c: any) => new Date(c.cycle_start).toISOString().slice(0, 10));
    expect(starts.slice(0, 5)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    expect(new Date(cs[11].cycle_end).toISOString().slice(0, 10)).toBe('2027-01-31');
    // Every cycle is contiguous: no gap, no overlap.
    for (let i = 1; i < cs.length; i++) {
      expect(new Date(cs[i].cycle_start).getTime()).toBe(new Date(cs[i - 1].cycle_end).getTime());
    }
  });

  it('handles the leap day (29 Feb 2028) without a 30-day approximation', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ yearly: 10_000_000, allowance: 100_000 });
    const sub = await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(1), periodEnd: inDays(366),
    });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'yearly',
      start: '2028-01-31T00:00:00Z', end: '2029-01-31T00:00:00Z', monthlyAllowance: 100_000,
    });
    await client.query(`SELECT public.billing_v2_ensure_period_cycles($1)`, [period.id]);
    const cs = await q(
      `SELECT cycle_start FROM public.billing_entitlement_cycles
        WHERE subscription_period_id=$1 ORDER BY cycle_index`,
      [period.id],
    );
    expect(new Date(cs[1].cycle_start).toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  it('creates future cycles as scheduled with ZERO grant before their start', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ yearly: 10_000_000, allowance: 250_000 });
    const sub = await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(5), periodEnd: inDays(370),
    });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'yearly', start: inDays(5), monthlyAllowance: 250_000,
    });

    await client.query(`SELECT public.billing_v2_ensure_period_cycles($1)`, [period.id]);
    await client.query(`SELECT public.billing_v2_run_entitlement_cycles(50)`);

    const cs = await cycles(ws);
    expect(cs).toHaveLength(12);
    expect(cs.every((c: any) => c.status === 'scheduled')).toBe(true);
    expect(await planLots(ws)).toHaveLength(0);
  });

  // ── Exactly once ────────────────────────────────────────────────────────

  it('grants exactly once across five sequential activations/worker passes', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ yearly: 10_000_000, allowance: 400_000 });
    const sub = await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(0), periodEnd: inDays(365),
    });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'yearly', start: inDays(-0.01), monthlyAllowance: 400_000,
    });

    for (let i = 0; i < 5; i++) {
      await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);
      await client.query(`SELECT public.billing_v2_run_entitlement_cycles(50)`);
      await client.query(`SELECT public.billing_v2_apply_period_allowance($1)`, [period.id]);
    }

    expect(await planLots(ws)).toHaveLength(1);
    expect(await grantedTotal(ws)).toBe(400_000);
    expect((await cycles(ws)).filter((c: any) => c.allowance_state === 'granted')).toHaveLength(1);
  });

  it('grants exactly once when three workers run concurrently', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ yearly: 10_000_000, allowance: 400_000 });
    const sub = await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(0), periodEnd: inDays(365),
    });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'yearly', start: inDays(-0.01), monthlyAllowance: 400_000,
    });
    await client.query(`SELECT public.billing_v2_ensure_period_cycles($1)`, [period.id]);
    await client.query(
      `UPDATE public.billing_subscription_periods SET status='active', activated_at=now() WHERE id=$1`,
      [period.id],
    );

    const { Client } = await import('pg');
    const workers = await Promise.all([0, 1, 2].map(async () => {
      const c = new Client({ connectionString: DSN });
      await c.connect();
      return c;
    }));
    await Promise.allSettled(
      workers.map((c) => c.query(`SELECT public.billing_v2_sync_period_cycles($1)`, [period.id])),
    );
    await Promise.all(workers.map((c) => c.end()));

    expect(await planLots(ws)).toHaveLength(1);
    expect(await grantedTotal(ws)).toBe(400_000);
  });

  it('recovers from a crash between cycle activation and the grant', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ yearly: 10_000_000, allowance: 400_000 });
    const sub = await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(0), periodEnd: inDays(365),
    });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'yearly', start: inDays(-0.01), monthlyAllowance: 400_000,
    });
    await client.query(`SELECT public.billing_v2_ensure_period_cycles($1)`, [period.id]);
    await client.query(
      `UPDATE public.billing_subscription_periods SET status='active', activated_at=now() WHERE id=$1`,
      [period.id],
    );
    // The crash: cycle marked active, allowance never granted.
    await client.query(
      `UPDATE public.billing_entitlement_cycles SET status='active', activated_at=now()
        WHERE subscription_period_id=$1 AND cycle_index=0`,
      [period.id],
    );
    expect(await planLots(ws)).toHaveLength(0);

    await client.query(`SELECT public.billing_v2_run_entitlement_cycles(50)`);
    await client.query(`SELECT public.billing_v2_run_entitlement_cycles(50)`);

    expect(await planLots(ws)).toHaveLength(1);
    expect(await grantedTotal(ws)).toBe(400_000);
  });

  // ── Annual immediate upgrade ────────────────────────────────────────────

  it('annual upgrade funds only a PRORATED delta now and full months later', async () => {
    const ws = await makeWorkspace();
    const small = await makePlan({ yearly: 10_000_000, allowance: 300_000 });
    const big = await makePlan({ yearly: 20_000_000, allowance: 900_000 });
    const sub = await makeSubscription(ws, {
      planId: small, interval: 'yearly', periodStart: inDays(-10), periodEnd: inDays(355),
    });
    const first = await makePeriod(ws, sub.id, {
      planId: small, interval: 'yearly', start: inDays(-10), monthlyAllowance: 300_000,
    });
    await client.query(`SELECT public.billing_activate_period($1)`, [first.id]);
    expect(await grantedTotal(ws)).toBe(300_000);

    // Immediate upgrade: same service window end, new plan snapshot.
    const upgrade = await makePeriod(ws, sub.id, {
      planId: big, interval: 'yearly', start: inDays(-0.01),
      end: new Date(first.period_end).toISOString(), monthlyAllowance: 900_000,
    });

    await client.query(`SELECT public.billing_activate_period($1)`, [upgrade.id]);

    const cs = await q(
      `SELECT * FROM public.billing_entitlement_cycles
        WHERE subscription_period_id=$1 ORDER BY cycle_index`,
      [upgrade.id],
    );
    // First cycle: remainder of the running month, delta only (600k × ~20/30).
    expect(cs[0].snapshot.kind).toBe('prorated_upgrade_delta');
    expect(Number(cs[0].ai_allowance_irr)).toBeGreaterThan(0);
    expect(Number(cs[0].ai_allowance_irr)).toBeLessThan(600_000);
    // Every later cycle carries the TARGET plan's full monthly allowance.
    expect(cs.slice(1).every((c: any) => Number(c.ai_allowance_irr) === 900_000)).toBe(true);

    // Nothing was granted for the remaining months on upgrade day.
    const total = await grantedTotal(ws);
    expect(total).toBeLessThan(300_000 + 600_000);
    expect(total).toBeGreaterThan(300_000);

    // Completed cycles of the previous period are immutable history.
    const old = await q(
      `SELECT status FROM public.billing_entitlement_cycles WHERE subscription_period_id=$1`,
      [first.id],
    );
    expect(old.every((c: any) => ['completed', 'canceled'].includes(c.status))).toBe(true);
    expect(old.filter((c: any) => c.status === 'completed')).toHaveLength(1);
  });

  it('monthly upgrade keeps the Phase C behaviour: prorated delta, cycle-end expiry', async () => {
    const ws = await makeWorkspace();
    const small = await makePlan({ monthly: 1_000_000, allowance: 300_000 });
    const big = await makePlan({ monthly: 2_000_000, allowance: 900_000 });
    const sub = await makeSubscription(ws, { planId: small, periodStart: inDays(-15), periodEnd: inDays(15) });
    const first = await makePeriod(ws, sub.id, {
      planId: small, interval: 'monthly', start: inDays(-15), end: inDays(15), monthlyAllowance: 300_000,
    });
    await client.query(`SELECT public.billing_activate_period($1)`, [first.id]);
    const upgrade = await makePeriod(ws, sub.id, {
      planId: big, interval: 'monthly', start: inDays(-0.01), end: inDays(15), monthlyAllowance: 900_000,
    });
    await client.query(`SELECT public.billing_activate_period($1)`, [upgrade.id]);

    const [c] = await q(
      `SELECT * FROM public.billing_entitlement_cycles WHERE subscription_period_id=$1`,
      [upgrade.id],
    );
    expect(c.snapshot.kind).toBe('prorated_upgrade_delta');
    const lot = await one(`SELECT * FROM public.workspace_ai_balance_lots WHERE id=$1`, [c.allowance_lot_id]);
    expect(new Date(lot.expires_at).toISOString()).toBe(new Date(c.cycle_end).toISOString());
  });

  // ── Snapshot authority ──────────────────────────────────────────────────

  it('ignores a later super-admin plan edit for a paid service period', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ yearly: 10_000_000, allowance: 400_000 });
    const sub = await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(0), periodEnd: inDays(365),
    });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'yearly', start: inDays(-0.01), monthlyAllowance: 400_000,
    });
    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);

    await client.query(
      `UPDATE public.billing_plans SET limits = jsonb_build_object('ai_credits_per_month', 9_000_000)
        WHERE id=$1`,
      [plan],
    );
    await client.query(`SELECT public.billing_v2_run_entitlement_cycles(50)`);

    const cs = await cycles(ws);
    expect(cs.every((c: any) => Number(c.ai_allowance_irr) === 400_000)).toBe(true);
    expect(await grantedTotal(ws)).toBe(400_000);
  });

  // ── Purchased credit ────────────────────────────────────────────────────

  it('leaves purchased AI credit untouched across a cycle reset', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ yearly: 10_000_000, allowance: 400_000 });
    const sub = await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(-40), periodEnd: inDays(325),
    });
    await client.query(`SELECT public.ai_purchase_credit($1, 400000, $2, 'test')`, [ws, `buy:${uuid()}`]);
    const purchasedBefore = await one(
      `SELECT SUM(remaining_amount)::bigint AS s FROM public.workspace_ai_balance_lots
        WHERE workspace_id=$1 AND source_type='PURCHASED'`,
      [ws],
    );

    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'yearly', start: inDays(-40), monthlyAllowance: 400_000,
    });
    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);

    const purchasedAfter = await one(
      `SELECT SUM(remaining_amount)::bigint AS s FROM public.workspace_ai_balance_lots
        WHERE workspace_id=$1 AND source_type='PURCHASED'`,
      [ws],
    );
    expect(Number(purchasedAfter.s)).toBe(Number(purchasedBefore.s));
    expect(Number(purchasedAfter.s)).toBe(400_000);
  });

  it('consumes the expiring plan allowance BEFORE non-expiring purchased credit', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000, allowance: 300_000 });
    const sub = await makeSubscription(ws, { planId: plan, periodStart: inDays(0), periodEnd: inDays(30) });
    await client.query(`SELECT public.ai_purchase_credit($1, 500000, $2, 'test')`, [ws, `buy:${uuid()}`]);
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'monthly', start: inDays(-0.01), monthlyAllowance: 300_000,
    });
    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);

    // The ledger's canonical allocation order: expiring lots first.
    const order = await q(
      `SELECT source_type FROM public.workspace_ai_balance_lots
        WHERE workspace_id=$1 AND remaining_amount > 0
        ORDER BY (expires_at IS NULL), expires_at ASC, created_at ASC`,
      [ws],
    );
    expect(order[0].source_type).toBe('PLAN_ALLOWANCE');
    expect(order[order.length - 1].source_type).toBe('PURCHASED');
  });

  it('reconciles the wallet: active plan lots + purchased lots = available balance', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000, allowance: 300_000 });
    const sub = await makeSubscription(ws, { planId: plan, periodStart: inDays(0), periodEnd: inDays(30) });
    await client.query(`SELECT public.ai_purchase_credit($1, 500000, $2, 'test')`, [ws, `buy:${uuid()}`]);
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'monthly', start: inDays(-0.01), monthlyAllowance: 300_000,
    });
    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);

    const lots = await one(
      `SELECT COALESCE(SUM(remaining_amount),0)::bigint AS s FROM public.workspace_ai_balance_lots
        WHERE workspace_id=$1 AND (expires_at IS NULL OR expires_at > now())`,
      [ws],
    );
    const bal = await one(`SELECT public.ai_available_balance($1) AS b`, [ws]);
    expect(Number(bal.b)).toBe(Number(lots.s));
    expect(Number(bal.b)).toBe(800_000);
  });

  // ── Free & trial ────────────────────────────────────────────────────────

  it('free plan with zero allowance: a cycle exists, nothing is granted', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ allowance: 0 });
    const sub = await makeSubscription(ws, { planId: plan, periodStart: inDays(0), periodEnd: inDays(30) });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'monthly', start: inDays(-0.01),
      monthlyAllowance: 0, source: 'free_plan',
    });
    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);

    const cs = await cycles(ws);
    expect(cs).toHaveLength(1);
    expect(cs[0].status).toBe('active');
    expect(cs[0].allowance_state).toBe('skipped');
    expect(await planLots(ws)).toHaveLength(0);
  });

  it('free plan with an allowance grants exactly one, idempotently', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ allowance: 50_000 });
    const sub = await makeSubscription(ws, { planId: plan, periodStart: inDays(0), periodEnd: inDays(30) });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'monthly', start: inDays(-0.01),
      monthlyAllowance: 50_000, source: 'free_plan',
    });
    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);
    await client.query(`SELECT public.billing_v2_run_entitlement_cycles(50)`);
    expect(await planLots(ws)).toHaveLength(1);
    expect(await grantedTotal(ws)).toBe(50_000);
  });

  it('trial period: one cycle, its own allowance, no invoice', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000, allowance: 100_000 });
    const sub = await makeSubscription(ws, { planId: plan, periodStart: inDays(0), periodEnd: inDays(14) });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'monthly', start: inDays(-0.01), end: inDays(14),
      monthlyAllowance: 100_000, source: 'trial',
    });
    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);

    const cs = await cycles(ws);
    expect(cs).toHaveLength(1);
    expect(await grantedTotal(ws)).toBe(100_000);
    expect(await q(`SELECT id FROM public.billing_invoices WHERE workspace_id=$1`, [ws])).toHaveLength(0);
  });

  // ── Legacy handover & guards ────────────────────────────────────────────

  it('never double-funds a period that already received a period-level grant', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ yearly: 10_000_000, allowance: 400_000 });
    const sub = await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(0), periodEnd: inDays(365),
    });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'yearly', start: inDays(-0.01), monthlyAllowance: 400_000,
    });
    // Pre-D0 state: the period already granted 12× once.
    await client.query(
      `INSERT INTO public.billing_period_allowance_grants (period_id, workspace_id, allowance_irr, status, granted_at)
       VALUES ($1,$2,$3,'granted',now())`,
      [period.id, ws, 4_800_000],
    );
    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);

    const cs = await cycles(ws);
    expect(cs).toHaveLength(12);
    expect(cs.every((c: any) => Number(c.ai_allowance_irr) === 0)).toBe(true);
    expect(cs.every((c: any) => c.allowance_state === 'skipped')).toBe(true);
    expect(await planLots(ws)).toHaveLength(0);
  });

  it('leaves a legacy_migration period under legacy ownership', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000, allowance: 400_000 });
    const sub = await makeSubscription(ws, { planId: plan, periodStart: inDays(0), periodEnd: inDays(30) });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'monthly', start: inDays(-0.01),
      monthlyAllowance: 400_000, source: 'legacy_migration',
    });
    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);
    expect(await planLots(ws)).toHaveLength(0);
    expect((await cycles(ws))[0].snapshot.grant_authority).toBe('legacy_period');
  });

  it('forbids a NEW period-keyed grant once the period has cycles', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ monthly: 1_000_000, allowance: 400_000 });
    const sub = await makeSubscription(ws, { planId: plan, periodStart: inDays(0), periodEnd: inDays(30) });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'monthly', start: inDays(-0.01), monthlyAllowance: 400_000,
    });
    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);

    await expect(
      client.query(
        `UPDATE public.billing_period_allowance_grants SET status='granted' WHERE period_id=$1`,
        [period.id],
      ),
    ).rejects.toThrow(/billing_v2_period_keyed_grant_forbidden/);
  });

  // ── Read model ──────────────────────────────────────────────────────────

  it('the read model exposes the AI cycle separately from the service period', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ yearly: 12_000_000, allowance: 500_000 });
    const sub = await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(0), periodEnd: inDays(365),
    });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'yearly', start: inDays(-0.01), monthlyAllowance: 500_000,
    });
    await client.query(`SELECT public.billing_activate_period($1)`, [period.id]);

    const cycle = (await one(`SELECT public.billing_v2_current_entitlement_cycle($1) AS c`, [ws])).c;
    expect(Number(cycle.allowance_irr)).toBe(500_000);
    expect(Number(cycle.remaining_irr)).toBe(500_000);
    expect(new Date(cycle.end).getTime()).toBeLessThan(new Date(period.period_end).getTime());
  });

  it('a read NEVER grants: the read model is financially inert', async () => {
    const ws = await makeWorkspace();
    const plan = await makePlan({ yearly: 12_000_000, allowance: 500_000 });
    const sub = await makeSubscription(ws, {
      planId: plan, interval: 'yearly', periodStart: inDays(5), periodEnd: inDays(370),
    });
    const period = await makePeriod(ws, sub.id, {
      planId: plan, interval: 'yearly', start: inDays(5), monthlyAllowance: 500_000,
    });
    await client.query(`SELECT public.billing_v2_ensure_period_cycles($1)`, [period.id]);

    for (let i = 0; i < 5; i++) {
      await one(`SELECT public.billing_v2_current_entitlement_cycle($1) AS c`, [ws]);
      await one(`SELECT public.billing_v2_scheduler_health() AS h`);
    }
    expect(await planLots(ws)).toHaveLength(0);
  });

  it('reports cycle health for the readiness surface', async () => {
    const health = (await one(`SELECT public.billing_v2_scheduler_health() AS h`)).h;
    expect(health).toHaveProperty('due_entitlement_cycles');
    expect(health).toHaveProperty('unfunded_active_cycles');
  });

  // ── Mixed population ────────────────────────────────────────────────────

  it('serves monthly, annual and free workspaces side by side without cross-effect', async () => {
    const monthlyWs = await makeWorkspace();
    const annualWs = await makeWorkspace();
    const freeWs = await makeWorkspace();

    const mPlan = await makePlan({ monthly: 1_000_000, allowance: 200_000 });
    const yPlan = await makePlan({ yearly: 10_000_000, allowance: 300_000 });
    const fPlan = await makePlan({ allowance: 0 });

    const mSub = await makeSubscription(monthlyWs, { planId: mPlan, periodStart: inDays(0), periodEnd: inDays(30) });
    const ySub = await makeSubscription(annualWs, {
      planId: yPlan, interval: 'yearly', periodStart: inDays(0), periodEnd: inDays(365),
    });
    const fSub = await makeSubscription(freeWs, { planId: fPlan, periodStart: inDays(0), periodEnd: inDays(30) });

    const mP = await makePeriod(monthlyWs, mSub.id, {
      planId: mPlan, interval: 'monthly', start: inDays(-0.01), monthlyAllowance: 200_000,
    });
    const yP = await makePeriod(annualWs, ySub.id, {
      planId: yPlan, interval: 'yearly', start: inDays(-0.01), monthlyAllowance: 300_000,
    });
    const fP = await makePeriod(freeWs, fSub.id, {
      planId: fPlan, interval: 'monthly', start: inDays(-0.01),
      monthlyAllowance: 0, source: 'free_plan',
    });

    for (const p of [mP, yP, fP]) {
      await client.query(`SELECT public.billing_activate_period($1)`, [p.id]);
    }
    await client.query(`SELECT public.billing_v2_run_entitlement_cycles(50)`);

    expect(await cycles(monthlyWs)).toHaveLength(1);
    expect(await cycles(annualWs)).toHaveLength(12);
    expect(await grantedTotal(monthlyWs)).toBe(200_000);
    expect(await grantedTotal(annualWs)).toBe(300_000);
    expect(await grantedTotal(freeWs)).toBe(0);
  });
});
