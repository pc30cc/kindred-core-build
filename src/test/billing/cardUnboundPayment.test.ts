/**
 * A second payment for one card intent is never lost.
 *
 * Money that cannot settle its intent is recorded as an unapplied payment.
 * When the intent's own payment slot is taken (a second charge for a paid
 * intent, or a claim lost to another finalization), the payment is recorded
 * UNBOUND — and then it must not take the intent's document number either:
 * billing_payments.invoice_number is unique (uq_billing_payments_invoice_number,
 * migration 108), the bound payment holds it, and the insert failed with a
 * unique violation that recordCustomerPayment's replay lookup could not
 * resolve (payment_replay_lookup_failed:not_found) — the webhook answered 500
 * on every retry and the money was never recorded.
 *
 * The fake billing_payments below enforces all three unique indexes the real
 * table has, and recordCustomerPayment is the real one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
let payments: Row[] = [];
let nextId = 1;

/** The unique indexes of public.billing_payments (105, 108), each partial on NOT NULL. */
const UNIQUE: Array<{ name: string; cols: string[] }> = [
  { name: 'uq_billing_payments_intent', cols: ['payment_intent_id'] },
  { name: 'uq_billing_payments_provider_ref', cols: ['provider_name', 'provider_payment_id'] },
  { name: 'uq_billing_payments_invoice_number', cols: ['invoice_number'] },
];

function insertPayment(row: Row): { data: Row | null; error: { code: string; message: string } | null } {
  for (const idx of UNIQUE) {
    const key = idx.cols.at(-1)!;
    if (row[key] === null || row[key] === undefined) continue;
    if (payments.some((p) => idx.cols.every((c) => p[c] === row[c]))) {
      return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${idx.name}"` } };
    }
  }
  const stored = { id: `pay-${nextId++}`, invoice_id: null, reconciliation_state: null, ...row };
  payments.push(stored);
  return { data: { id: stored.id }, error: null };
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = [];
      let inserted: ReturnType<typeof insertPayment> | null = null;
      let patch: Row | null = null;
      const rows = () => (table === 'billing_payments' ? payments : []).filter((r) => filters.every((f) => f(r)));
      const b: Record<string, unknown> = {};
      b.insert = (row: Row) => {
        inserted = insertPayment(row);
        return b;
      };
      b.select = () => b;
      b.update = (p: Row) => {
        patch = p;
        return b;
      };
      b.eq = (c: string, v: unknown) => {
        filters.push((r) => r[c] === v);
        return b;
      };
      b.is = (c: string, v: unknown) => {
        filters.push((r) => (r[c] ?? null) === v);
        return b;
      };
      b.maybeSingle = async () => {
        if (inserted) return inserted;
        const found = rows();
        if (found.length > 1) return { data: null, error: { message: 'multiple rows' } };
        return { data: found[0] ?? null, error: null };
      };
      b.then = (resolve: (v: unknown) => void) => {
        if (patch) for (const r of rows()) Object.assign(r, patch);
        resolve({ data: patch ? null : rows(), error: null });
      };
      return b;
    },
  }),
}));

const claim = vi.fn();
const readIntent = vi.fn();
vi.mock('../../../server/services/billing/paymentIntent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/paymentIntent.js')>()),
  claimIntentForProcessing: (...a: unknown[]) => claim(...a),
  claimLapsedIntentForProcessing: async () => false,
  readPaymentIntent: (...a: unknown[]) => readIntent(...a),
  markIntentSucceeded: async () => undefined,
  markPaymentIntentFailed: async () => undefined,
  noteIntentFailureAttempt: async () => undefined,
}));
vi.mock('../../../server/services/billing/invoice/settle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/invoice/settle.js')>()),
  settleAndApply: async (_cfg: unknown, input: { paymentId: string; invoiceId: string }) => {
    const p = payments.find((r) => r.id === input.paymentId);
    if (p) p.invoice_id = input.invoiceId;
    return { settlement: { status: 'paid' }, application: {} };
  },
  releaseCollection: async () => undefined,
}));
vi.mock('../../../server/services/billing/entitlementChange.js', () => ({
  handleWorkspaceEntitlementChanged: async () => ({ ok: true }),
}));

const { settleVerifiedCardPayment } = await import('../../../server/services/billing/cardInvoice.js');

const CFG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;
const intent = (overrides: Row = {}) =>
  ({
    id: 'pi-1', workspace_id: 'ws-1', purchase_type: 'subscription', action_type: 'plan_new', plan_id: 'plan-pro',
    billing_interval: 'monthly', provider_name: 'stripe', provider_ref: 'cs_1', amount_irr: 2900,
    expected_amount_irr: 2900, invoice_id: 'inv-1', invoice_number: 'WY12345678', plan_name_snapshot: 'Pro',
    status: 'pending', metadata: { currency: 'USD' }, attempt_count: 0, ...overrides,
  }) as never;
const first = { providerName: 'stripe', providerRef: 'cs_1', paymentId: 'pi_stripe_1', amount: 2900, currency: 'USD' };
const second = { ...first, paymentId: 'pi_stripe_2' };

beforeEach(() => {
  payments = [];
  nextId = 1;
  claim.mockReset().mockResolvedValue({ claimed: true, resumed: false });
  readIntent.mockReset();
});

describe('a second payment for one intent', () => {
  it('after the intent succeeded: recorded as its own unapplied payment, the first untouched', async () => {
    expect(await settleVerifiedCardPayment(CFG, { intent: intent(), ...first })).toEqual({ outcome: 'succeeded' });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ payment_intent_id: 'pi-1', invoice_number: 'WY12345678', invoice_id: 'inv-1' });

    const out = await settleVerifiedCardPayment(CFG, { intent: intent({ status: 'succeeded' }), ...second });
    expect(out).toEqual({ outcome: 'parked', reason: 'second_payment_for_paid_intent' });
    expect(payments).toHaveLength(2);
    expect(payments[1]).toMatchObject({
      payment_intent_id: null,
      provider_payment_id: 'pi_stripe_2',
      invoice_number: null,
      amount: 2900,
      currency: 'USD',
      reconciliation_state: 'unapplied',
      reconciliation_reason: 'second_payment_for_paid_intent',
      metadata: expect.objectContaining({ intentId: 'pi-1', invoiceId: 'inv-1', invoiceNumber: 'WY12345678' }),
    });
    expect(payments[0]).toMatchObject({ invoice_number: 'WY12345678', reconciliation_state: null });
  });

  it('a replay of that second payment (webhook retry) resolves to the same row: no 500, no third row', async () => {
    await settleVerifiedCardPayment(CFG, { intent: intent(), ...first });
    await settleVerifiedCardPayment(CFG, { intent: intent({ status: 'succeeded' }), ...second });
    const replay = await settleVerifiedCardPayment(CFG, { intent: intent({ status: 'succeeded' }), ...second });
    expect(replay).toEqual({ outcome: 'parked', reason: 'second_payment_for_paid_intent' });
    expect(payments).toHaveLength(2);
    // And the first payment's own replay is still a duplicate.
    expect(await settleVerifiedCardPayment(CFG, { intent: intent({ status: 'succeeded' }), ...first })).toEqual({ outcome: 'duplicate' });
    expect(payments).toHaveLength(2);
  });

  it('a claim lost to a finalization by another payment: this one is recorded unbound, never lost', async () => {
    await settleVerifiedCardPayment(CFG, { intent: intent(), ...first });
    claim.mockResolvedValue({ claimed: false, reason: 'already_finalized' });
    readIntent.mockResolvedValue(intent({ status: 'succeeded' }));
    const out = await settleVerifiedCardPayment(CFG, { intent: intent(), ...second });
    expect(out).toEqual({ outcome: 'parked', reason: 'second_payment_for_paid_intent' });
    expect(payments).toHaveLength(2);
    expect(payments[1]).toMatchObject({ payment_intent_id: null, invoice_number: null, reconciliation_state: 'unapplied' });
  });

  it('a payment parked while the intent slot is free still carries the document number (bound, as before)', async () => {
    const out = await settleVerifiedCardPayment(CFG, { intent: intent(), ...first, currency: 'EUR' });
    expect(out).toEqual({ outcome: 'parked', reason: 'gateway_currency_mismatch' });
    expect(payments[0]).toMatchObject({ payment_intent_id: 'pi-1', invoice_number: 'WY12345678', reconciliation_state: 'unapplied' });
  });
});
