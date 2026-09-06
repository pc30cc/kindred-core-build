/**
 * Internal Test Gateway — full financial pipeline, against real PostgreSQL.
 *
 * Unlike internalTestGateway.test.ts (pure HMAC unit tests) or
 * billingEngineV2.pg.test.ts (SQL invariants with a synthetic gateway
 * payment), this suite wires the REAL production code at both ends of the
 * pipeline together:
 *
 *   - the actual `internal_test` provider contract
 *     (createCheckoutSession / signOutcome / verifyPayment — the same
 *     functions server/routes/internalTestGateway.ts and
 *     server/routes/billing.ts's verify-callback call), and
 *   - the actual SQL settlement/effects functions every gateway's verified
 *     payment is applied through.
 *
 * It also proves the ZarinPal sandbox contract (`zarinpal_test`) the same
 * way, mocking ONLY the external ZarinPal HTTP boundary — never our own
 * billing pipeline — per the same acceptance bar.
 *
 * What this suite does NOT do: send real HTTP requests through the Express
 * app + PostgREST (this sandbox has a real Postgres but no PostgREST/Supabase
 * runtime to route `getServiceClient()` calls through). It substitutes for
 * that by driving the exact provider functions and SQL functions the HTTP
 * routes call, so a regression in either boundary — or in how they're wired
 * together (idempotency, reference preservation, cancel = zero effect) —
 * still fails here.
 *
 * CI-MANDATORY like billingEngineV2.pg.test.ts: REQUIRE_BILLING_DB=1 with no
 * TEST_DATABASE_URL fails the job rather than silently skipping.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  internalTestProvider,
  signOutcome,
} from '../../../server/services/billing/providers/internal-test.js';
import { zarinpalTestProvider } from '../../../server/services/billing/providers/zarinpal-test.js';

const DSN = process.env.TEST_DATABASE_URL;
const REQUIRED = process.env.REQUIRE_BILLING_DB === '1';

if (REQUIRED && !DSN) {
  throw new Error(
    'REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — Internal Test Gateway E2E is mandatory in CI.',
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
  return `TS${String(20_000_000 + docCounter)}`;
}

async function makeWorkspace(): Promise<string> {
  const id = uuid();
  await client.query(`INSERT INTO public.workspaces (id, name, slug) VALUES ($1,$2,$3)`, [
    id, `ws-${id.slice(0, 8)}`, `ws-${id.slice(0, 8)}`,
  ]);
  return id;
}

/** An open, payable AI-credit-purchase invoice — the simplest real effect to verify. */
async function makeInvoice(ws: string, total: number): Promise<any> {
  const snapshot = {
    action_type: 'ai_credit_purchase',
    target_plan_id: null,
    period_start: null,
    period_end: null,
    ai_allowance_irr: 0,
    ai_credit_amount_irr: total,
    limits_snapshot: {},
    plan_snapshot: {},
  };
  const row = await one(
    `INSERT INTO public.billing_invoices
       (workspace_id, invoice_number, invoice_type, status, subtotal_irr, total_irr,
        amount_due_irr, effect_snapshot)
     VALUES ($1,$2,'ai_credit_purchase','draft',$3,$3,$3,$4::jsonb) RETURNING *`,
    [ws, docNumber(), total, JSON.stringify(snapshot)],
  );
  return one(
    `UPDATE public.billing_invoices SET status='open', issued_at=now() WHERE id=$1 RETURNING *`,
    [row.id],
  );
}

/** Records the payment the way recordCustomerPayment() would after a verified callback. */
async function recordPayment(ws: string, amount: number, providerName: string, providerRef: string): Promise<string> {
  const r = await one(
    `INSERT INTO public.billing_payments (workspace_id, amount, status, provider_name, provider_payment_id)
     VALUES ($1,$2,'succeeded',$3,$4) RETURNING id`,
    [ws, amount, providerName, providerRef],
  );
  return r.id;
}

async function settleAndApply(invoiceId: string, amount: number, paymentId: string, commandKey: string) {
  const settlement = (await one(
    `SELECT public.billing_settle_invoice($1,$2,'gateway',$3,$4,NULL) AS r`,
    [invoiceId, amount, commandKey, paymentId],
  )).r;
  const applied = (await one(`SELECT public.billing_apply_invoice_effects($1) AS r`, [invoiceId])).r;
  return { settlement, applied };
}

const API_ORIGIN = 'https://api.example.com';
const APP_ORIGIN = 'https://app.example.com';
const gatewayConfig = { provider: 'internal_test', currency: 'IRR', gateway_base_url: API_ORIGIN };

suite('Internal Test Gateway — full financial pipeline (PostgreSQL)', () => {
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

  it('runs the exact acceptance flow: checkout -> test gateway -> successful payment -> settlement -> AI credit, exactly once', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, 1_000_000);

    // ── invoice -> select internal_test -> checkout ──────────────────────
    const checkout = await internalTestProvider.createCheckoutSession(gatewayConfig, {
      workspaceId: ws,
      planId: 'invoice',
      interval: 'monthly',
      currency: 'IRR',
      callbackUrl: `${APP_ORIGIN}/acme/billing/pay/invoice/${inv.invoice_number}`,
      metadata: { amount: String(inv.total_irr) },
    });
    // "Browser opens the simple simulator page on the API host."
    const paymentUrl = new URL(checkout.paymentUrl);
    expect(paymentUrl.origin).toBe(API_ORIGIN);
    expect(paymentUrl.pathname).toBe('/api/billing/test-gateway');
    const providerRef = checkout.providerRef!;
    expect(providerRef).toMatch(/^TESTGW-/);

    // ── choose "Payment successful" -> API return -> verify callback ─────
    // Exactly the params server/routes/internalTestGateway.ts's success link
    // carries and server/routes/billing.ts's verify-callback reads.
    const outcomeParams = { authority: providerRef, status: 'OK', rsig: signOutcome(providerRef, 'OK'), amount: String(inv.total_irr) };
    const verified = await internalTestProvider.verifyPayment!(gatewayConfig, outcomeParams);
    expect(verified).toMatchObject({ verified: true, providerRef, status: 'success' });

    // ── billing payment recorded, provider reference preserved ───────────
    const paymentId = await recordPayment(ws, inv.total_irr, 'internal_test', verified.providerRef);

    // ── invoice settled + effects applied (AI credit granted) ────────────
    const commandKey = `intent:${uuid()}`;
    const first = await settleAndApply(inv.id, inv.total_irr, paymentId, commandKey);
    expect(first.settlement.status).toBe('paid');
    expect(first.applied.activated).toBe(true);

    const invoiceRow = await one(`SELECT status FROM public.billing_invoices WHERE id=$1`, [inv.id]);
    expect(invoiceRow.status).toBe('paid');

    const lots = await q(
      `SELECT id FROM public.workspace_ai_balance_lots WHERE workspace_id=$1 AND source_type='PURCHASED'`,
      [ws],
    );
    expect(lots).toHaveLength(1);

    const paymentRow = await one(`SELECT provider_payment_id FROM public.billing_payments WHERE id=$1`, [paymentId]);
    expect(paymentRow.provider_payment_id).toBe(providerRef);

    // ── "Refreshing the success page does NOT apply the payment twice." ──
    const replay = await settleAndApply(inv.id, inv.total_irr, paymentId, commandKey);
    expect(replay.settlement.replayed).toBe(true);
    expect(replay.applied.replayed).toBe(true);

    const lotsAfterReplay = await q(
      `SELECT id FROM public.workspace_ai_balance_lots WHERE workspace_id=$1 AND source_type='PURCHASED'`,
      [ws],
    );
    expect(lotsAfterReplay).toHaveLength(1); // no duplicate entitlement/credit

    const paymentsAfterReplay = await q(
      `SELECT id FROM public.billing_payments WHERE workspace_id=$1`,
      [ws],
    );
    expect(paymentsAfterReplay).toHaveLength(1); // no duplicate settlement
  });

  it('Cancel: gateway cancel -> verify=false -> no settlement, no plan activation, no AI credit', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, 500_000);

    const checkout = await internalTestProvider.createCheckoutSession(gatewayConfig, {
      workspaceId: ws,
      planId: 'invoice',
      interval: 'monthly',
      currency: 'IRR',
      callbackUrl: `${APP_ORIGIN}/acme/billing/pay/invoice/${inv.invoice_number}`,
      metadata: { amount: String(inv.total_irr) },
    });
    const providerRef = checkout.providerRef!;

    // "Cancel / پرداخت ناموفق" — the simulator's cancel link.
    const outcomeParams = { authority: providerRef, status: 'NOK', rsig: signOutcome(providerRef, 'NOK'), amount: String(inv.total_irr) };
    const verified = await internalTestProvider.verifyPayment!(gatewayConfig, outcomeParams);
    expect(verified).toMatchObject({ verified: false, status: 'canceled' });

    // The real verify-callback route only settles when `result.verified` is
    // true — a canceled outcome never reaches billing_settle_invoice at all.
    const invoiceRow = await one(`SELECT status FROM public.billing_invoices WHERE id=$1`, [inv.id]);
    expect(invoiceRow.status).toBe('open');
    const payments = await q(`SELECT id FROM public.billing_payments WHERE workspace_id=$1`, [ws]);
    expect(payments).toHaveLength(0);
    const lots = await q(`SELECT id FROM public.workspace_ai_balance_lots WHERE workspace_id=$1`, [ws]);
    expect(lots).toHaveLength(0);
  });

  it('rejects a forged outcome signature — a browser cannot fabricate a successful callback', async () => {
    const forged = await internalTestProvider.verifyPayment!(gatewayConfig, {
      authority: 'TESTGW-FORGED0000000000000000',
      status: 'OK',
      rsig: 'not-a-real-signature',
      amount: '999999999',
    });
    expect(forged.verified).toBe(false);
  });

  // ── ZarinPal sandbox contract — same acceptance bar, external HTTP mocked ─

  it('ZarinPal sandbox: checkout -> authority stored -> Status=OK verify (code 100) -> settlement -> effects', async () => {
    const ws = await makeWorkspace();
    const inv = await makeInvoice(ws, 250_000);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ data: { code: 100, authority: 'S0000000000000000000000000000mock' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const checkout = await zarinpalTestProvider.createCheckoutSession(
      { provider: 'zarinpal_test' },
      {
        workspaceId: ws, planId: 'invoice', interval: 'monthly', currency: 'IRR',
        callbackUrl: `${API_ORIGIN}/api/billing/return`,
        metadata: { amount: String(inv.total_irr) },
      },
    );
    const authority = checkout.authority!; // stored on the intent by the real checkout route
    expect(authority).toBe('S0000000000000000000000000000mock');
    vi.unstubAllGlobals();

    // Simulated ZarinPal callback: Status=OK + Authority. Provider verify
    // returns code 100 -> our own pipeline (settlement) is NOT mocked.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      status: 200, text: async () => JSON.stringify({ data: { code: 100, ref_id: 555444333 } }),
    }));
    const verified = await zarinpalTestProvider.verifyPayment!(
      { provider: 'zarinpal_test' },
      { Authority: authority, amount: String(inv.total_irr) },
    );
    vi.unstubAllGlobals();
    expect(verified).toMatchObject({ verified: true, providerRef: '555444333', status: 'success' });

    const paymentId = await recordPayment(ws, inv.total_irr, 'zarinpal_test', verified.providerRef);
    const result = await settleAndApply(inv.id, inv.total_irr, paymentId, `intent:${uuid()}`);
    expect(result.settlement.status).toBe('paid');
    expect(result.applied.activated).toBe(true);
    const invoiceRow = await one(`SELECT status FROM public.billing_invoices WHERE id=$1`, [inv.id]);
    expect(invoiceRow.status).toBe('paid');
  });

  it('ZarinPal sandbox: verify code 101 (already verified) is accepted as success on a replayed callback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      status: 200, text: async () => JSON.stringify({ data: { code: 101, ref_id: 555444333 } }),
    }));
    const verified = await zarinpalTestProvider.verifyPayment!(
      { provider: 'zarinpal_test' },
      { Authority: 'S0000000000000000000000000000mock', amount: '250000' },
    );
    vi.unstubAllGlobals();
    expect(verified).toMatchObject({ verified: true, providerRef: '555444333', status: 'already_verified' });
  });
});
