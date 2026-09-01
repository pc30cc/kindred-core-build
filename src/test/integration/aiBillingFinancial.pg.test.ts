/**
 * AI Usage Billing — REAL financial invariants against PostgreSQL.
 *
 * Money correctness lives in SQL (advisory locks, ON CONFLICT identity,
 * append-only triggers, lot allocation ordering). Mocking it in TypeScript
 * would prove nothing, so this suite applies the actual billing migration to a
 * live database and exercises the invariants end-to-end:
 *
 *   - duplicate beginAiRun (same key + same hash → resume; different hash → conflict)
 *   - duplicate identical usage ingestion → NOOP; conflicting → CONFLICT + UNRESOLVED
 *   - duplicate settlement → replayed, charged once
 *   - concurrent reservations never over-reserve a lot
 *   - top-up, insufficient balance, no negative balance
 *   - multi-lot ordering, expiration, refund routing and REFUND_COMPENSATION
 *   - duplicate commands/grants are idempotent
 *   - rate card / FX / sell policy immutability (append-only)
 *   - ledger + usage events append-only
 *   - ACL: anon/authenticated cannot execute financial functions
 *   - wallet reconciliation and stale reservation release
 *
 * Enabled by TEST_DATABASE_URL; skipped (never silently green) without a DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const BILLING_MIGRATIONS = [
  'supabase/migrations/20260901094824_28a01e28-0db2-446d-9ca2-424187cd82dc.sql',
  'supabase/migrations/20260901103902_7a77e604-f85d-42c2-b0d9-94e51cff0dfb.sql',
];

let client: any;
const WS = '11111111-1111-1111-1111-111111111111';

const q = async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows;
const one = async (sql: string, params?: unknown[]) => (await q(sql, params))[0];
const num = (v: unknown) => Number(v);

/** Fresh workspace id per test so lots/wallets never leak between cases. */
function wsId(): string {
  const h = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${h()}${h()}-${h()}-4${h().slice(1)}-8${h().slice(1)}-${h()}${h()}${h()}`;
}

async function beginRun(ws: string, key: string, hash: string, extra: Partial<Record<string, any>> = {}) {
  return one(
    `SELECT * FROM public.ai_begin_run($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      ws, key, hash,
      extra.entryPoint ?? 'test',
      extra.channel ?? null,
      extra.conversationId ?? null,
      extra.mode ?? 'METER_ONLY',
      null, extra.sellMultiplier ?? 1.5,
      null, extra.fxRate ?? 600000,
      extra.overage ?? 'CAP_AND_ABSORB',
    ],
  );
}

async function openStep(runId: string, seq = 1, kind = 'COMPLETION', attempt = 1) {
  const r = await one(`SELECT public.ai_open_step($1,$2,$3,$4,$5,$6) AS id`, [
    runId, kind, seq, attempt, 'openai', 'gpt-test',
  ]);
  return r.id as string;
}

async function ingest(stepId: string, key: string, payload: Record<string, unknown>) {
  const r = await one(`SELECT public.ai_ingest_usage_event($1,$2,$3,$4::jsonb) AS result`, [
    stepId, 'COMPLETION_TOKENS', key, JSON.stringify(payload),
  ]);
  return r.result as string;
}

suite('AI billing financial invariants (PostgreSQL)', () => {
  beforeAll(async () => {
    const { Client } = await import('pg');
    client = new Client({ connectionString: DSN });
    await client.connect();
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query(`
      DO $$ BEGIN
        CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await client.query(`
      DO $$ BEGIN
        CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await client.query(`
      DO $$ BEGIN
        CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    for (const file of BILLING_MIGRATIONS) {
      await client.query(readFileSync(resolve(process.cwd(), file), 'utf8'));
    }
  }, 120_000);

  afterAll(async () => {
    await client?.end();
  });

  // ── Run identity / idempotency ──────────────────────────────────────────

  it('resumes the SAME run for the same idempotency key + same canonical hash', async () => {
    const ws = wsId();
    const a = await beginRun(ws, `k:${ws}`, 'hash-A');
    const b = await beginRun(ws, `k:${ws}`, 'hash-A');
    expect(b.id).toBe(a.id);
    const { rows } = await client.query(`SELECT count(*)::int c FROM public.ai_runs WHERE workspace_id=$1`, [ws]);
    expect(rows[0].c).toBe(1);
  });

  it('raises idempotency_conflict (never silently reuses) for same key + different hash', async () => {
    const ws = wsId();
    await beginRun(ws, `k:${ws}`, 'hash-A');
    await expect(beginRun(ws, `k:${ws}`, 'hash-B')).rejects.toThrow(/idempotency_conflict/);
    // The run is NOT mutated by the rejected attempt.
    const run = await one(`SELECT operation_request_hash FROM public.ai_runs WHERE workspace_id=$1`, [ws]);
    expect(run.operation_request_hash).toBe('hash-A');
    // The durable audit record is written by the server layer (the SQL insert
    // is rolled back together with the RAISE), see runContext.beginAiRun.
  });

  // ── Usage ingestion immutability ────────────────────────────────────────

  const usage = (overrides: Record<string, unknown> = {}) => ({
    provider: 'openai',
    actual_model: 'gpt-test',
    quantity: 1000,
    unit: 'TOKEN',
    provider_cost_amount: '0.002',
    provider_cost_currency: 'USD',
    provider_cost_usd: '0.002',
    internal_cost_irr: '1200',
    ...overrides,
  });

  it('ingests once, treats an identical replay as NOOP and never mutates the stored event', async () => {
    const ws = wsId();
    const run = await beginRun(ws, `k:${ws}`, 'h');
    const step = await openStep(run.id);
    expect(await ingest(step, 'u1', usage())).toBe('INSERTED');
    expect(await ingest(step, 'u1', usage())).toBe('NOOP');
    const events = await q(`SELECT * FROM public.ai_usage_events WHERE step_id=$1`, [step]);
    expect(events.length).toBe(1);
    expect(num(events[0].internal_cost_irr)).toBe(1200);
  });

  it('flags a conflicting replay of the same key as CONFLICT and marks the run UNRESOLVED', async () => {
    const ws = wsId();
    const run = await beginRun(ws, `k:${ws}`, 'h');
    const step = await openStep(run.id);
    await ingest(step, 'u1', usage());
    expect(await ingest(step, 'u1', usage({ internal_cost_irr: '9999' }))).toBe('CONFLICT');
    const events = await q(`SELECT * FROM public.ai_usage_events WHERE step_id=$1`, [step]);
    expect(events.length).toBe(1);
    expect(num(events[0].internal_cost_irr)).toBe(1200); // historical value untouched
    const conflicts = await q(`SELECT * FROM public.ai_usage_event_conflicts WHERE step_id=$1`, [step]);
    expect(conflicts.length).toBe(1);
    const after = await one(`SELECT billing_quality, unresolved_reason FROM public.ai_runs WHERE id=$1`, [run.id]);
    expect(after.billing_quality).toBe('UNRESOLVED');
    expect(after.unresolved_reason).toBe('INGESTION_CONFLICT');
  });

  it('records multi-provider / multi-currency usage under one run without collapsing events', async () => {
    const ws = wsId();
    const run = await beginRun(ws, `k:${ws}`, 'h');
    const s1 = await openStep(run.id, 1, 'EMBEDDING');
    const s2 = await openStep(run.id, 2, 'COMPLETION');
    await ingest(s1, 'e1', usage({ provider: 'openai', provider_cost_currency: 'USD', internal_cost_irr: '300' }));
    await ingest(s2, 'c1', usage({ provider: 'anthropic', provider_cost_currency: 'EUR', internal_cost_irr: '700' }));
    const total = await one(
      `SELECT SUM(internal_cost_irr) t FROM public.ai_usage_events WHERE run_id=$1`, [run.id]);
    expect(num(total.t)).toBe(1000);
  });

  it('keeps EVERY component of one multi-step business operation under the SAME run', async () => {
    const ws = wsId();
    const run = await beginRun(ws, `k:${ws}`, 'h', { entryPoint: 'agent_turn' });
    // retrieval embedding → main completion → retry of that completion →
    // fallback provider completion → tool call. One business operation.
    const steps = [
      await openStep(run.id, 1, 'EMBEDDING', 1),
      await openStep(run.id, 2, 'COMPLETION', 1),
      await openStep(run.id, 2, 'COMPLETION', 2), // retry, same logical step
      await openStep(run.id, 3, 'COMPLETION', 1), // fallback provider
      await openStep(run.id, 4, 'TOOL', 1),
    ];
    expect(new Set(steps).size).toBe(5);
    for (const [i, step] of steps.entries()) {
      await ingest(step, `u${i}`, usage({ internal_cost_irr: '100' }));
    }
    const agg = await one(
      `SELECT count(*)::int c, SUM(internal_cost_irr) t FROM public.ai_usage_events WHERE run_id=$1`, [run.id]);
    expect(agg.c).toBe(5);
    expect(num(agg.t)).toBe(500);
    // No usage escaped into another run for this workspace.
    const orphan = await one(
      `SELECT count(*)::int c FROM public.ai_usage_events WHERE workspace_id=$1 AND run_id <> $2`, [ws, run.id]);
    expect(orphan.c).toBe(0);
  });

  it('rejects UPDATE/DELETE on usage events (append-only)', async () => {
    const ws = wsId();
    const run = await beginRun(ws, `k:${ws}`, 'h');
    const step = await openStep(run.id);
    await ingest(step, 'u1', usage());
    await expect(client.query(`UPDATE public.ai_usage_events SET quantity = 1 WHERE step_id=$1`, [step]))
      .rejects.toThrow();
    await expect(client.query(`DELETE FROM public.ai_usage_events WHERE step_id=$1`, [step])).rejects.toThrow();
  });

  // ── Balance, reservations, concurrency ──────────────────────────────────

  it('grants and purchases idempotently by command key', async () => {
    const ws = wsId();
    const l1 = await one(`SELECT public.ai_grant_allowance($1,$2,$3,$4,$5,$6) id`,
      [ws, 100000, '2026-01', 'plan', new Date(Date.now() + 86400000), `grant:${ws}`]);
    const l2 = await one(`SELECT public.ai_grant_allowance($1,$2,$3,$4,$5,$6) id`,
      [ws, 100000, '2026-01', 'plan', new Date(Date.now() + 86400000), `grant:${ws}`]);
    expect(l2.id).toBe(l1.id);
    const p1 = await one(`SELECT public.ai_purchase_credit($1,$2,$3,$4) id`, [ws, 50000, `buy:${ws}`, 'topup']);
    const p2 = await one(`SELECT public.ai_purchase_credit($1,$2,$3,$4) id`, [ws, 50000, `buy:${ws}`, 'topup']);
    expect(p2.id).toBe(p1.id);
    const bal = await one(`SELECT public.ai_available_balance($1) b`, [ws]);
    expect(num(bal.b)).toBe(150000);
  });

  it('never over-reserves under concurrent reservations and never goes negative', async () => {
    const ws = wsId();
    await q(`SELECT public.ai_purchase_credit($1,$2,$3,$4)`, [ws, 1000, `buy:${ws}`, 'x']);
    const r1 = await beginRun(ws, `k1:${ws}`, 'h');
    const r2 = await beginRun(ws, `k2:${ws}`, 'h');

    const { Client } = await import('pg');
    const other = new Client({ connectionString: DSN });
    await other.connect();
    const [a, b] = await Promise.all([
      client.query(`SELECT public.ai_reserve($1,$2,$3,$4) r`, [ws, r1.id, 800, `res1:${ws}`]),
      other.query(`SELECT public.ai_reserve($1,$2,$3,$4) r`, [ws, r2.id, 800, `res2:${ws}`]),
    ]);
    await other.end();
    const reserved = num(a.rows[0].r.reserved) + num(b.rows[0].r.reserved);
    expect(reserved).toBe(1000); // exactly the funded amount, never 1600
    const bal = await one(`SELECT public.ai_available_balance($1) b`, [ws]);
    expect(num(bal.b)).toBe(0);
    const lot = await one(`SELECT remaining_amount, reserved_amount FROM public.workspace_ai_balance_lots WHERE workspace_id=$1`, [ws]);
    expect(num(lot.reserved_amount)).toBeLessThanOrEqual(num(lot.remaining_amount));
  });

  it('reports a shortfall instead of reserving unfunded amounts, and tops up when credit arrives', async () => {
    const ws = wsId();
    await q(`SELECT public.ai_purchase_credit($1,$2,$3,$4)`, [ws, 100, `buy:${ws}`, 'x']);
    const run = await beginRun(ws, `k:${ws}`, 'h');
    const res = await one(`SELECT public.ai_reserve($1,$2,$3,$4) r`, [ws, run.id, 500, `res:${ws}`]);
    expect(num(res.r.reserved)).toBe(100);
    expect(num(res.r.shortfall)).toBe(400);
    await q(`SELECT public.ai_purchase_credit($1,$2,$3,$4)`, [ws, 400, `buy2:${ws}`, 'x']);
    const added = await one(`SELECT public.ai_topup_reservation($1,$2) a`, [run.id, 400]);
    expect(num(added.a)).toBe(400);
  });

  it('replays an identical reservation command instead of double-reserving', async () => {
    const ws = wsId();
    await q(`SELECT public.ai_purchase_credit($1,$2,$3,$4)`, [ws, 1000, `buy:${ws}`, 'x']);
    const run = await beginRun(ws, `k:${ws}`, 'h');
    const a = await one(`SELECT public.ai_reserve($1,$2,$3,$4) r`, [ws, run.id, 500, `res:${ws}`]);
    const b = await one(`SELECT public.ai_reserve($1,$2,$3,$4) r`, [ws, run.id, 500, `res:${ws}`]);
    expect(b.r.reservation_id).toBe(a.r.reservation_id);
    expect(b.r.replayed).toBe(true);
    expect(num((await one(`SELECT public.ai_available_balance($1) b`, [ws])).b)).toBe(500);
  });

  it('releases a stale reservation so a crashed run can never lock the balance forever', async () => {
    const ws = wsId();
    await q(`SELECT public.ai_purchase_credit($1,$2,$3,$4)`, [ws, 1000, `buy:${ws}`, 'x']);
    const run = await beginRun(ws, `k:${ws}`, 'h');
    const res = await one(`SELECT public.ai_reserve($1,$2,$3,$4) r`, [ws, run.id, 1000, `res:${ws}`]);
    await q(`UPDATE public.workspace_ai_reservations SET expires_at = now() - interval '1 hour' WHERE id=$1`,
      [res.r.reservation_id]);
    await q(`SELECT public.ai_release_reservation($1)`, [res.r.reservation_id]);
    expect(num((await one(`SELECT public.ai_available_balance($1) b`, [ws])).b)).toBe(1000);
    const state = await one(`SELECT state FROM public.workspace_ai_reservations WHERE id=$1`, [res.r.reservation_id]);
    expect(state.state).toBe('RELEASED');
  });

  // ── Settlement ──────────────────────────────────────────────────────────

  it('settles once and replays a duplicate settlement without charging twice', async () => {
    const ws = wsId();
    await q(`SELECT public.ai_purchase_credit($1,$2,$3,$4)`, [ws, 5000, `buy:${ws}`, 'x']);
    const run = await beginRun(ws, `k:${ws}`, 'h', { mode: 'ENFORCED' });
    await q(`SELECT public.ai_reserve($1,$2,$3,$4)`, [ws, run.id, 2000, `res:${ws}`]);
    const a = await one(`SELECT public.ai_settle_run($1,$2,$3,$4,$5,$6) s`,
      [run.id, `settle:${ws}`, 0.002, 1200, 1800, '2026-01']);
    const b = await one(`SELECT public.ai_settle_run($1,$2,$3,$4,$5,$6) s`,
      [run.id, `settle:${ws}`, 0.002, 1200, 1800, '2026-01']);
    expect(b.s.replayed).toBe(true);
    expect(num((await one(`SELECT count(*)::int c FROM public.ai_run_settlements WHERE run_id=$1`, [run.id])).c)).toBe(1);
    expect(num((await one(`SELECT public.ai_available_balance($1) b`, [ws])).b)).toBe(3200);
    expect(a.s).toBeTruthy();
  });

  it('caps the charge at the funded balance (CAP_AND_ABSORB) and never drives the wallet negative', async () => {
    const ws = wsId();
    await q(`SELECT public.ai_purchase_credit($1,$2,$3,$4)`, [ws, 500, `buy:${ws}`, 'x']);
    const run = await beginRun(ws, `k:${ws}`, 'h', { mode: 'ENFORCED', overage: 'CAP_AND_ABSORB' });
    await q(`SELECT public.ai_reserve($1,$2,$3,$4)`, [ws, run.id, 500, `res:${ws}`]);
    await q(`SELECT public.ai_settle_run($1,$2,$3,$4,$5,$6)`, [run.id, `settle:${ws}`, 0.01, 5000, 5000, '2026-01']);
    const bal = num((await one(`SELECT public.ai_available_balance($1) b`, [ws])).b);
    expect(bal).toBeGreaterThanOrEqual(0);
    const s = await one(
      `SELECT customer_charge_irr, platform_absorbed_amount FROM public.ai_run_settlements WHERE run_id=$1`, [run.id]);
    expect(num(s.customer_charge_irr) + num(s.platform_absorbed_amount)).toBe(5000);
    expect(num(s.customer_charge_irr)).toBeLessThanOrEqual(500);
  });

  // ── Refunds & expiration ────────────────────────────────────────────────

  it('refunds purchased consumption back to purchased balance, idempotently', async () => {
    const ws = wsId();
    await q(`SELECT public.ai_purchase_credit($1,$2,$3,$4)`, [ws, 5000, `buy:${ws}`, 'x']);
    const run = await beginRun(ws, `k:${ws}`, 'h', { mode: 'ENFORCED' });
    await q(`SELECT public.ai_reserve($1,$2,$3,$4)`, [ws, run.id, 2000, `res:${ws}`]);
    await q(`SELECT public.ai_settle_run($1,$2,$3,$4,$5,$6)`, [run.id, `settle:${ws}`, 0.002, 1200, 1800, '2026-01']);
    const r1 = await one(`SELECT public.ai_refund_run($1,$2,$3,$4,$5) r`, [run.id, 1800, 'test', `ref:${ws}`, null]);
    const r2 = await one(`SELECT public.ai_refund_run($1,$2,$3,$4,$5) r`, [run.id, 1800, 'test', `ref:${ws}`, null]);
    expect(r2.r.replayed).toBe(true);
    expect(r2.r.ledger_entry_id).toBe(r1.r.ledger_entry_id);
    expect(num((await one(`SELECT public.ai_available_balance($1) b`, [ws])).b)).toBe(5000);
    await expect(client.query(`SELECT public.ai_refund_run($1,$2,$3,$4,$5)`, [run.id, 1, 'again', `ref2:${ws}`, null]))
      .rejects.toThrow(/refund_cap_exceeded/);
  });

  it('routes a refund of expired plan allowance to a cycle-bound compensation lot, not to permanent credit', async () => {
    const ws = wsId();
    await q(`SELECT public.ai_grant_allowance($1,$2,$3,$4,$5,$6)`,
      [ws, 3000, '2026-01', 'plan', new Date(Date.now() + 3600_000), `grant:${ws}`]);
    const run = await beginRun(ws, `k:${ws}`, 'h', { mode: 'ENFORCED' });
    await q(`SELECT public.ai_reserve($1,$2,$3,$4)`, [ws, run.id, 2000, `res:${ws}`]);
    await q(`SELECT public.ai_settle_run($1,$2,$3,$4,$5,$6)`, [run.id, `settle:${ws}`, 0.002, 1000, 2000, '2026-01']);
    // The plan lot expires before the refund arrives.
    await q(`UPDATE public.workspace_ai_balance_lots SET expires_at = now() - interval '1 minute'
             WHERE workspace_id=$1 AND source_type='PLAN_ALLOWANCE'`, [ws]);
    await q(`SELECT public.ai_expire_lots()`);
    await q(`SELECT public.ai_refund_run($1,$2,$3,$4,$5)`, [run.id, 2000, 'expired-refund', `ref:${ws}`, null]);
    const lots = await q(`SELECT source_type, remaining_amount, expires_at FROM public.workspace_ai_balance_lots
                          WHERE workspace_id=$1 AND remaining_amount > 0`, [ws]);
    expect(lots.length).toBe(1);
    expect(lots[0].source_type).toBe('REFUND_COMPENSATION');
    expect(lots[0].expires_at).not.toBeNull(); // never becomes non-expiring purchased credit
  });

  it('expires lots deterministically and consumes the earliest-expiring lot first', async () => {
    const ws = wsId();
    await q(`SELECT public.ai_grant_allowance($1,$2,$3,$4,$5,$6)`,
      [ws, 1000, '2026-01', 'plan', new Date(Date.now() + 3600_000), `grant:${ws}`]);
    await q(`SELECT public.ai_purchase_credit($1,$2,$3,$4)`, [ws, 1000, `buy:${ws}`, 'x']);
    const run = await beginRun(ws, `k:${ws}`, 'h');
    const res = await one(`SELECT public.ai_reserve($1,$2,$3,$4) r`, [ws, run.id, 1000, `res:${ws}`]);
    expect(num(res.r.reserved)).toBe(1000);
    const planLot = await one(`SELECT reserved_amount FROM public.workspace_ai_balance_lots
                               WHERE workspace_id=$1 AND source_type='PLAN_ALLOWANCE'`, [ws]);
    expect(num(planLot.reserved_amount)).toBe(1000); // expiring lot consumed first
  });

  // ── Pricing/FX/policy immutability ──────────────────────────────────────

  it('charges nothing in METER_ONLY but still records the metered settlement', async () => {
    const ws = wsId();
    await q(`SELECT public.ai_purchase_credit($1,$2,$3,$4)`, [ws, 5000, `buy:${ws}`, 'x']);
    const run = await beginRun(ws, `k:${ws}`, 'h', { mode: 'METER_ONLY' });
    await q(`SELECT public.ai_reserve($1,$2,$3,$4)`, [ws, run.id, 2000, `res:${ws}`]);
    await q(`SELECT public.ai_settle_run($1,$2,$3,$4,$5,$6)`, [run.id, `settle:${ws}`, 0.002, 1200, 1800, '2026-01']);
    expect(num((await one(`SELECT public.ai_available_balance($1) b`, [ws])).b)).toBe(5000);
    const s = await one(`SELECT internal_cost_irr, customer_charge_irr FROM public.ai_run_settlements WHERE run_id=$1`, [run.id]);
    expect(num(s.internal_cost_irr)).toBe(1200);
    expect(num(s.customer_charge_irr)).toBe(0);
  });

  it('keeps published rate cards, FX rates and sell policies append-only', async () => {
    const card = await one(
      `INSERT INTO public.ai_rate_cards(provider, model_key) VALUES ('openai', $1) RETURNING id`,
      [`m-${Date.now()}-${Math.random()}`]);
    await expect(client.query(`UPDATE public.ai_rate_cards SET provider='tampered' WHERE id=$1`, [card.id]))
      .rejects.toThrow(/append_only_pricing/);
    await expect(client.query(`DELETE FROM public.ai_rate_cards WHERE id=$1`, [card.id]))
      .rejects.toThrow(/append_only_pricing/);
    // Superseding an OPEN version by closing its window stays legal.
    await client.query(`UPDATE public.ai_rate_cards SET effective_to = now() + interval '1 day' WHERE id=$1`, [card.id]);

    const fx = await one(
      `INSERT INTO public.ai_exchange_rates(from_currency, to_currency, rate)
       VALUES ('USD', $1, 600000) RETURNING id`, [`X${Math.floor(Math.random() * 1e6)}`]);
    await expect(client.query(`UPDATE public.ai_exchange_rates SET rate=1 WHERE id=$1`, [fx.id]))
      .rejects.toThrow(/append_only_pricing/);

    const pol = await one(
      `INSERT INTO public.ai_sell_policies(scope, workspace_id, multiplier)
       VALUES ('WORKSPACE', $1, 1.5) RETURNING id`, [wsId()]);
    await expect(client.query(`UPDATE public.ai_sell_policies SET multiplier=99 WHERE id=$1`, [pol.id]))
      .rejects.toThrow(/append_only_pricing/);
  });

  it('keeps the ledger append-only', async () => {
    const ws = wsId();
    await q(`SELECT public.ai_purchase_credit($1,$2,$3,$4)`, [ws, 100, `buy:${ws}`, 'x']);
    await expect(client.query(`UPDATE public.workspace_ai_ledger SET amount = 1 WHERE workspace_id=$1`, [ws]))
      .rejects.toThrow();
    await expect(client.query(`DELETE FROM public.workspace_ai_ledger WHERE workspace_id=$1`, [ws]))
      .rejects.toThrow();
  });

  // ── Wallet reconciliation ───────────────────────────────────────────────

  it('reconciles the wallet projection back to the lot truth after drift', async () => {
    const ws = wsId();
    await q(`SELECT public.ai_purchase_credit($1,$2,$3,$4)`, [ws, 2500, `buy:${ws}`, 'x']);
    await q(`UPDATE public.workspace_ai_wallets SET available_amount = 999999 WHERE workspace_id=$1`, [ws]);
    const rec = await one(`SELECT public.ai_reconcile_wallet($1) r`, [ws]);
    expect(rec).toBeTruthy();
    const wallet = await one(`SELECT available_amount FROM public.workspace_ai_wallets WHERE workspace_id=$1`, [ws]);
    expect(num(wallet.available_amount)).toBe(2500);
  });

  // ── Security / ACL ──────────────────────────────────────────────────────

  it('denies anon and authenticated EXECUTE on every financial function', async () => {
    const rows = await q(`
      SELECT p.oid::regprocedure::text AS sig,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_can
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('ai_begin_run','ai_open_step','ai_ingest_usage_event','ai_reserve',
                           'ai_topup_reservation','ai_release_reservation','ai_settle_run',
                           'ai_grant_allowance','ai_purchase_credit','ai_refund_run',
                           'ai_adjust_balance','ai_expire_lots')`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(`${r.sig}:anon=${r.anon_can}`).toBe(`${r.sig}:anon=false`);
      expect(`${r.sig}:auth=${r.auth_can}`).toBe(`${r.sig}:auth=false`);
      expect(`${r.sig}:svc=${r.svc_can}`).toBe(`${r.sig}:svc=true`);
    }
  });

  it('pins search_path of every SECURITY DEFINER financial function to trusted schemas only', async () => {
    const rows = await q(`
      SELECT p.proname, p.proconfig
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.prosecdef
         AND p.proname LIKE 'ai\\_%'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const cfg = (r.proconfig || []).join(',');
      expect(`${r.proname}:${cfg}`).toMatch(/search_path=(public|public, pg_temp|public,pg_temp)/);
      expect(cfg).not.toMatch(/\$user/);
    }
  });

  it('isolates tenants: a run/usage/settlement always carries its own workspace', async () => {
    const wsA = wsId();
    const wsB = wsId();
    const runA = await beginRun(wsA, `k:${wsA}`, 'h');
    const stepA = await openStep(runA.id);
    await ingest(stepA, 'u1', usage());
    const leaked = await q(`SELECT 1 FROM public.ai_usage_events WHERE workspace_id=$1`, [wsB]);
    expect(leaked.length).toBe(0);
    const owned = await q(`SELECT 1 FROM public.ai_usage_events WHERE workspace_id=$1`, [wsA]);
    expect(owned.length).toBe(1);
    expect(WS).toBeTruthy();
  });
});
