/**
 * Card gateways (Stripe, PayPal, Paddle, Lemon Squeezy) on the invoice engine.
 *
 * A confirmed card payment must settle exactly the invoice its payment intent
 * was created for — in the invoice's currency, for the invoice's amount — and
 * money that cannot do that must be recorded for review, never applied and
 * never dropped. The return callback and the webhook may both arrive, in any
 * order, more than once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const claim = vi.fn();
const claimLapsed = vi.fn();
const readIntent = vi.fn();
const resolveNamed = vi.fn();
const markSucceeded = vi.fn().mockResolvedValue(undefined);
const markFailed = vi.fn().mockResolvedValue(undefined);
const noteFailure = vi.fn().mockResolvedValue(undefined);
const recordPayment = vi.fn();
const settleAndApply = vi.fn();
const releaseCollection = vi.fn().mockResolvedValue(undefined);
const recordRefund = vi.fn().mockResolvedValue(true);
const entitlementChanged = vi.fn().mockResolvedValue({ ok: true, cacheCleared: true, catchupEnqueued: 0 });
const updates: Array<{ table: string; patch: Record<string, unknown>; filters: Array<[string, string, unknown]> }> = [];
/** Rows the fake database answers with. */
let invoiceRow: Record<string, unknown> | null = null;
let intentPaymentRow: Record<string, unknown> | null = null;
let unappliedRows: Array<Record<string, unknown>> = [];
let intentRows: Array<Record<string, unknown>> = [];
const orFilters: string[] = [];

vi.mock('../../../server/services/billing/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/index.js')>()),
  resolveNamedBillingConfig: (...a: unknown[]) => resolveNamed(...a),
}));
vi.mock('../../../server/services/billing/paymentIntent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/paymentIntent.js')>()),
  claimIntentForProcessing: (...a: unknown[]) => claim(...a),
  claimLapsedIntentForProcessing: (...a: unknown[]) => claimLapsed(...a),
  getPaymentIntent: (...a: unknown[]) => readIntent(...a),
  markIntentSucceeded: (...a: unknown[]) => markSucceeded(...a),
  markPaymentIntentFailed: (...a: unknown[]) => markFailed(...a),
  noteIntentFailureAttempt: (...a: unknown[]) => noteFailure(...a),
}));
vi.mock('../../../server/services/billing/applyPayment.js', () => ({
  recordCustomerPayment: (...a: unknown[]) => recordPayment(...a),
}));
vi.mock('../../../server/services/billing/invoice/settle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/invoice/settle.js')>()),
  settleAndApply: (...a: unknown[]) => settleAndApply(...a),
  releaseCollection: (...a: unknown[]) => releaseCollection(...a),
}));
vi.mock('../../../server/services/billing/refunds.js', () => ({
  recordProviderRefund: (...a: unknown[]) => recordRefund(...a),
}));
vi.mock('../../../server/services/billing/entitlementChange.js', () => ({
  handleWorkspaceEntitlementChanged: (...a: unknown[]) => entitlementChanged(...a),
}));
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      let update: (typeof updates)[number] | null = null;
      const filter = (op: string) => (column: string, value: unknown) => {
        update?.filters.push([op, column, value]);
        return b;
      };
      b.select = () => b;
      b.eq = filter('eq');
      b.is = filter('is');
      b.in = filter('in');
      b.or = (expr: string) => {
        orFilters.push(expr);
        return b;
      };
      b.limit = () => b;
      b.update = (patch: Record<string, unknown>) => {
        update = { table, patch, filters: [] };
        updates.push(update);
        return b;
      };
      b.maybeSingle = async () => ({
        data: table === 'billing_invoices' ? invoiceRow : table === 'billing_payments' ? intentPaymentRow : null,
        error: null,
      });
      // Active collections of an intent: one reservation to release.
      b.then = (resolve: (v: unknown) => void) =>
        resolve({
          data:
            table === 'billing_invoice_collections'
              ? [{ id: 'col-1' }]
              : table === 'billing_payments'
                ? unappliedRows
                : table === 'billing_payment_intents'
                  ? intentRows
                  : null,
          error: null,
        });
      return b;
    },
  }),
}));

const {
  canCollectInvoice,
  cardCallbackRefConflicts,
  closeSupersededCheckouts,
  handleCardIntentWebhook,
  hasUnappliedPayment,
  intentCurrency,
  openCheckoutAttempts,
  settleVerifiedCardPayment,
} = await import('../../../server/services/billing/cardInvoice.js');
const { InvoiceSettlementError } = await import('../../../server/services/billing/invoice/settle.js');

const CFG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi-1',
    workspace_id: 'ws-1',
    purchase_type: 'subscription',
    action_type: 'plan_new',
    plan_id: 'plan-pro',
    billing_interval: 'monthly',
    provider_name: 'stripe',
    provider_ref: 'cs_1',
    amount_irr: 2900,
    expected_amount_irr: 2900,
    invoice_id: 'inv-1',
    invoice_number: 'WY12345678',
    plan_name_snapshot: 'Pro',
    status: 'pending',
    metadata: { currency: 'USD' },
    attempt_count: 0,
    ...overrides,
  } as never;
}

const paid = { providerName: 'stripe', providerRef: 'cs_1', paymentId: 'pi_stripe_1', amount: 2900, currency: 'USD' };

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  orFilters.length = 0;
  invoiceRow = null;
  intentPaymentRow = null;
  unappliedRows = [];
  intentRows = [];
  claimLapsed.mockResolvedValue(true);
  readIntent.mockResolvedValue(null);
  claim.mockResolvedValue({ claimed: true, resumed: false });
  recordPayment.mockResolvedValue({ id: 'pay-1', duplicate: false });
  settleAndApply.mockResolvedValue({ settlement: { status: 'paid' }, application: {} });
});

describe('which gateway can collect an invoice in which currency', () => {
  it.each([
    ['stripe', 'USD', true],
    ['stripe', 'eur', true],
    ['stripe', 'IRR', false],
    ['paypal', 'USD', true],
    ['paypal', 'TRY', false],
    ['paddle', 'EUR', true],
    ['lemon_squeezy', 'USD', true],
    ['zarinpal', 'IRR', true],
    ['zarinpal', 'USD', false],
    ['internal_test', 'IRR', true],
    // No server-side payment confirmation here yet: never collects an invoice.
    ['iyzico', 'TRY', false],
    ['paytr', 'TRY', false],
    ['unknown', 'USD', false],
  ])('%s / %s → %s', (provider, currency, expected) => {
    expect(canCollectInvoice(provider, currency)).toBe(expected);
  });

  it('a Lemon Squeezy store collects only the currency it was created with', () => {
    const store = (currency?: string) => ({ provider: 'lemon_squeezy', ...(currency ? { currency } : {}) });
    expect(canCollectInvoice('lemon_squeezy', 'USD', store())).toBe(true);
    expect(canCollectInvoice('lemon_squeezy', 'EUR', store())).toBe(false);
    expect(canCollectInvoice('lemon_squeezy', 'EUR', store('eur'))).toBe(true);
    expect(canCollectInvoice('lemon_squeezy', 'USD', store('EUR'))).toBe(false);
    // A currency no Lemon Squeezy store can sell in is never offered.
    expect(canCollectInvoice('lemon_squeezy', 'TRY', store('TRY'))).toBe(false);
    // Other card gateways are not narrowed by their account.
    expect(canCollectInvoice('stripe', 'EUR', { provider: 'stripe', currency: 'USD' })).toBe(true);
  });

  it('an intent collects in the currency recorded on it, IRR for the Iranian ones', () => {
    expect(intentCurrency({ metadata: { currency: 'usd' } } as never)).toBe('USD');
    expect(intentCurrency({ metadata: {} } as never)).toBe('IRR');
  });

  it('a return naming another checkout conflicts; one naming none or the stored one does not', () => {
    const i = { provider_name: 'stripe', provider_ref: 'cs_1' } as never;
    expect(cardCallbackRefConflicts(i, { session_id: 'cs_other' })).toBe(true);
    expect(cardCallbackRefConflicts(i, { session_id: 'cs_1' })).toBe(false);
    expect(cardCallbackRefConflicts(i, { canceled: '1' })).toBe(false);
  });
});

describe('settleVerifiedCardPayment', () => {
  it('claims, records the payment in the invoice currency, settles that invoice, then succeeds', async () => {
    const out = await settleVerifiedCardPayment(CFG, { intent: intent(), ...paid });
    expect(out).toEqual({ outcome: 'succeeded' });
    expect(claim.mock.calls[0][1]).toBe('pi-1');
    expect(claim.mock.calls[0][2].verification).toMatchObject({ provider_ref: 'cs_1', amount_irr: 2900 });
    expect(recordPayment.mock.calls[0][1]).toMatchObject({
      workspaceId: 'ws-1',
      providerName: 'stripe',
      providerPaymentId: 'pi_stripe_1',
      paymentIntentId: 'pi-1',
      amount: 2900,
      currency: 'USD',
      planId: 'plan-pro',
      billingInterval: 'monthly',
    });
    expect(settleAndApply.mock.calls[0][1]).toEqual({
      invoiceId: 'inv-1', paymentId: 'pay-1', amountIrr: 2900, commandKey: 'intent:pi-1',
    });
    expect(markSucceeded).toHaveBeenCalledWith(CFG, 'pi-1');
    expect(releaseCollection).toHaveBeenCalledWith(CFG, 'col-1', 'payment_completed');
    expect(recordPayment.mock.invocationCallOrder[0]).toBeLessThan(settleAndApply.mock.invocationCallOrder[0]);
    expect(settleAndApply.mock.invocationCallOrder[0]).toBeLessThan(markSucceeded.mock.invocationCallOrder[0]);
    // The new plan takes effect now, not when the entitlement cache expires.
    expect(entitlementChanged).toHaveBeenCalledWith(CFG, { workspaceId: 'ws-1', source: 'payment_succeeded' });
  });

  it('a paid renewal invoice is funnelled as a renewal', async () => {
    await settleVerifiedCardPayment(CFG, { intent: intent({ action_type: 'plan_renewal' }), ...paid });
    expect(entitlementChanged).toHaveBeenCalledWith(CFG, { workspaceId: 'ws-1', source: 'subscription_renewed' });
  });

  it('a repeat for an intent that already succeeded changes nothing', async () => {
    intentPaymentRow = { provider_payment_id: 'pi_stripe_1' };
    expect(await settleVerifiedCardPayment(CFG, { intent: intent({ status: 'succeeded' }), ...paid })).toEqual({ outcome: 'duplicate' });
    expect(claim).not.toHaveBeenCalled();
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it('a DIFFERENT payment for an intent that already succeeded is recorded for review, as its own payment', async () => {
    intentPaymentRow = { provider_payment_id: 'pi_stripe_1' };
    const out = await settleVerifiedCardPayment(CFG, {
      intent: intent({ status: 'succeeded' }), ...paid, providerRef: 'cs_1', paymentId: 'pi_stripe_2',
    });
    expect(out).toEqual({ outcome: 'parked', reason: 'second_payment_for_paid_intent' });
    expect(claim).not.toHaveBeenCalled();
    expect(settleAndApply).not.toHaveBeenCalled();
    // Off the intent's unique payment slot, or it would merge into the first payment.
    expect(recordPayment.mock.calls[0][1]).toMatchObject({
      paymentIntentId: null,
      providerPaymentId: 'pi_stripe_2',
      amount: 2900,
      currency: 'USD',
      metadata: { intentId: 'pi-1', parked: 'second_payment_for_paid_intent' },
    });
    const park = updates.find((u) => u.table === 'billing_payments');
    expect(park?.patch).toEqual({ reconciliation_state: 'unapplied', reconciliation_reason: 'second_payment_for_paid_intent' });
    // A payment that settled an invoice is never turned into an unapplied one.
    expect(park?.filters).toContainEqual(['is', 'invoice_id', null]);
    // The succeeded intent is not touched.
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('a repeat that carries no payment reference at all cannot be told apart: a duplicate', async () => {
    const out = await settleVerifiedCardPayment(CFG, {
      intent: intent({ status: 'succeeded' }), ...paid, providerRef: undefined, paymentId: undefined,
    });
    expect(out).toEqual({ outcome: 'duplicate' });
    expect(recordPayment).not.toHaveBeenCalled();
  });

  describe('a claim lost to a finalization that already happened', () => {
    beforeEach(() => claim.mockResolvedValue({ claimed: false, reason: 'already_finalized' }));

    it('is a duplicate only when THIS payment settled the intent', async () => {
      readIntent.mockResolvedValue(intent({ status: 'succeeded' }));
      intentPaymentRow = { provider_payment_id: 'pi_stripe_1' };
      expect(await settleVerifiedCardPayment(CFG, { intent: intent(), ...paid })).toEqual({ outcome: 'duplicate' });
      expect(recordPayment).not.toHaveBeenCalled();
    });

    it('another payment that settled it leaves this money recorded for review', async () => {
      readIntent.mockResolvedValue(intent({ status: 'succeeded' }));
      intentPaymentRow = { provider_payment_id: 'pi_stripe_OTHER' };
      const out = await settleVerifiedCardPayment(CFG, { intent: intent(), ...paid });
      expect(out).toEqual({ outcome: 'parked', reason: 'second_payment_for_paid_intent' });
      expect(recordPayment.mock.calls[0][1]).toMatchObject({ paymentIntentId: null, providerPaymentId: 'pi_stripe_1' });
    });

    it('an attempt that ended meanwhile (not succeeded) leaves this money recorded for review', async () => {
      readIntent.mockResolvedValue(intent({ status: 'failed', failure_reason: 'gateway_amount_mismatch' }));
      const out = await settleVerifiedCardPayment(CFG, { intent: intent(), ...paid });
      expect(out).toEqual({ outcome: 'parked', reason: 'payment_after_intent_failed' });
      expect(recordPayment.mock.calls[0][1]).toMatchObject({ paymentIntentId: null, providerPaymentId: 'pi_stripe_1' });
      expect(settleAndApply).not.toHaveBeenCalled();
      // The intent was already final: nothing is failed twice.
      expect(markFailed).not.toHaveBeenCalled();
    });
  });

  it('a concurrent finalization is reported in flight, not applied twice', async () => {
    claim.mockResolvedValue({ claimed: false, reason: 'in_flight' });
    expect(await settleVerifiedCardPayment(CFG, { intent: intent(), ...paid })).toEqual({ outcome: 'in_flight' });
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it.each([
    ['a different amount', { amount: 2800 }, 'gateway_amount_mismatch'],
    ['no amount', { amount: undefined }, 'gateway_amount_missing'],
    ['a different currency', { currency: 'EUR' }, 'gateway_currency_mismatch'],
    ['no currency', { currency: undefined }, 'gateway_currency_mismatch'],
  ])('money with %s is recorded as unapplied, never settles the invoice', async (_label, override, reason) => {
    const out = await settleVerifiedCardPayment(CFG, { intent: intent(), ...paid, ...override });
    expect(out).toEqual({ outcome: 'parked', reason });
    expect(settleAndApply).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(entitlementChanged).not.toHaveBeenCalled();
    expect(recordPayment).toHaveBeenCalledTimes(1);
    expect(updates).toContainEqual(expect.objectContaining({
      table: 'billing_payments',
      patch: { reconciliation_state: 'unapplied', reconciliation_reason: reason },
    }));
    expect(markFailed).toHaveBeenCalledWith(CFG, 'pi-1', reason);
  });

  it.each([
    ['failed', {}],
    ['canceled by the customer', { status: 'canceled', failure_reason: 'customer_canceled' }],
  ])('money for an intent that is %s is recorded for review', async (label, overrides) => {
    const status = label === 'failed' ? 'failed' : 'canceled';
    invoiceRow = { status: 'open', amount_due_irr: 2900, currency: 'USD' };
    const out = await settleVerifiedCardPayment(CFG, { intent: intent({ status, ...overrides }), ...paid });
    expect(out).toEqual({ outcome: 'parked', reason: `payment_after_intent_${status}` });
    expect(settleAndApply).not.toHaveBeenCalled();
    expect(claimLapsed).not.toHaveBeenCalled();
    expect(recordPayment.mock.calls[0][1]).toMatchObject({ amount: 2900, currency: 'USD', paymentIntentId: 'pi-1' });
    // A terminal intent is not touched again.
    expect(markFailed).not.toHaveBeenCalled();
  });

  describe('a checkout paid after its attempt was superseded or expired', () => {
    const superseded = () => intent({ status: 'canceled', failure_reason: 'superseded_by_new_checkout' });

    it.each([
      ['superseded by a newer checkout', superseded],
      ['expired', () => intent({ status: 'expired', failure_reason: 'ttl_expired' })],
    ])('%s: settles the invoice while it still owes exactly that amount in that currency', async (_label, make) => {
      invoiceRow = { status: 'open', amount_due_irr: 2900, currency: 'USD' };
      const lapsed = make();
      const out = await settleVerifiedCardPayment(CFG, { intent: lapsed, ...paid });
      expect(out).toEqual({ outcome: 'succeeded' });
      // Revived atomically from the exact state it was read in, with the verification.
      expect(claimLapsed.mock.calls[0][1]).toBe(lapsed);
      expect(claimLapsed.mock.calls[0][2].verification).toMatchObject({ provider_ref: 'cs_1', amount_irr: 2900 });
      expect(claim).not.toHaveBeenCalled();
      expect(settleAndApply.mock.calls[0][1]).toEqual({
        invoiceId: 'inv-1', paymentId: 'pay-1', amountIrr: 2900, commandKey: 'intent:pi-1',
      });
      expect(markSucceeded).toHaveBeenCalledWith(CFG, 'pi-1');
    });

    it.each([
      ['already paid', { status: 'paid', amount_due_irr: 0, currency: 'USD' }],
      ['voided', { status: 'void', amount_due_irr: 2900, currency: 'USD' }],
      ['owing another amount now', { status: 'partially_paid', amount_due_irr: 1500, currency: 'USD' }],
      ['in another currency', { status: 'open', amount_due_irr: 2900, currency: 'EUR' }],
      ['gone', null],
    ])('an invoice that is %s parks the money instead', async (_label, row) => {
      invoiceRow = row;
      const out = await settleVerifiedCardPayment(CFG, { intent: superseded(), ...paid });
      expect(out).toEqual({ outcome: 'parked', reason: 'payment_after_intent_canceled' });
      expect(claimLapsed).not.toHaveBeenCalled();
      expect(settleAndApply).not.toHaveBeenCalled();
      expect(recordPayment.mock.calls[0][1]).toMatchObject({ paymentIntentId: 'pi-1', amount: 2900 });
    });

    it('wrong money for a lapsed attempt is parked before the invoice is even consulted', async () => {
      invoiceRow = { status: 'open', amount_due_irr: 2900, currency: 'USD' };
      const out = await settleVerifiedCardPayment(CFG, { intent: superseded(), ...paid, amount: 2800 });
      expect(out).toEqual({ outcome: 'parked', reason: 'gateway_amount_mismatch' });
      expect(claimLapsed).not.toHaveBeenCalled();
    });

    it('a concurrent revival is reported in flight, never applied twice', async () => {
      invoiceRow = { status: 'open', amount_due_irr: 2900, currency: 'USD' };
      claimLapsed.mockResolvedValue(false);
      claim.mockResolvedValue({ claimed: false, reason: 'in_flight' });
      expect(await settleVerifiedCardPayment(CFG, { intent: superseded(), ...paid })).toEqual({ outcome: 'in_flight' });
      expect(recordPayment).not.toHaveBeenCalled();
    });

    it('settlement still refuses an overpayment (the newer checkout was paid too): the money is parked', async () => {
      invoiceRow = { status: 'open', amount_due_irr: 2900, currency: 'USD' };
      settleAndApply.mockRejectedValue(new InvoiceSettlementError('not_payable', 'invoice_not_payable', 409));
      const out = await settleVerifiedCardPayment(CFG, { intent: superseded(), ...paid });
      expect(out).toEqual({ outcome: 'parked', reason: 'settlement_refused:not_payable' });
      expect(markSucceeded).not.toHaveBeenCalled();
    });
  });

  it('an invoice that is no longer payable parks the money and ends the attempt', async () => {
    settleAndApply.mockRejectedValue(new InvoiceSettlementError('not_payable', 'invoice_not_payable', 409));
    const out = await settleVerifiedCardPayment(CFG, { intent: intent(), ...paid });
    expect(out).toEqual({ outcome: 'parked', reason: 'settlement_refused:not_payable' });
    expect(markFailed).toHaveBeenCalledWith(CFG, 'pi-1', 'settlement_refused:not_payable');
    expect(markSucceeded).not.toHaveBeenCalled();
  });

  it('a transient failure after the claim stays recoverable — never reported as failed', async () => {
    settleAndApply.mockRejectedValue(new Error('connection reset'));
    const out = await settleVerifiedCardPayment(CFG, { intent: intent(), ...paid });
    expect(out).toEqual({ outcome: 'pending', reason: 'finalization_pending' });
    expect(noteFailure).toHaveBeenCalledTimes(1);
    expect(markFailed).not.toHaveBeenCalled();
    expect(markSucceeded).not.toHaveBeenCalled();
  });
});

describe('closing checkouts a newer checkout superseded', () => {
  const closeStripe = vi.fn();
  beforeEach(() => {
    closeStripe.mockReset();
    resolveNamed.mockImplementation(async (_u: string, _k: string, _ws: string, name: string) => ({
      provider: { name, closeCheckout: closeStripe },
      config: { provider: name, secret_key: 'sk' },
    }));
  });

  it('remembers only the open attempts that hold a provider checkout', async () => {
    intentRows = [{ id: 'a', provider_ref: 'cs_a' }, { id: 'b', provider_ref: null }];
    expect(await openCheckoutAttempts(CFG, 'inv-1')).toEqual(['a']);
  });

  it('closes each superseded checkout at its provider, with that provider’s configuration', async () => {
    closeStripe.mockResolvedValue(true);
    intentRows = [
      { id: 'a', provider_name: 'stripe', provider_ref: 'cs_a', status: 'canceled', failure_reason: 'superseded_by_new_checkout' },
      { id: 'b', provider_name: 'paddle', provider_ref: 'txn_b', status: 'canceled', failure_reason: 'superseded_by_new_checkout' },
    ];
    expect(await closeSupersededCheckouts(CFG, 'ws-1', ['a', 'b'])).toBe(2);
    expect(resolveNamed.mock.calls.map((c) => [c[2], c[3]])).toEqual([['ws-1', 'stripe'], ['ws-1', 'paddle']]);
    expect(closeStripe.mock.calls).toEqual([
      [{ provider: 'stripe', secret_key: 'sk' }, 'cs_a'],
      [{ provider: 'paddle', secret_key: 'sk' }, 'txn_b'],
    ]);
  });

  it('leaves alone attempts that were not superseded, and providers that cannot close a checkout', async () => {
    intentRows = [
      // Paid / still collecting / canceled by the customer: not superseded.
      { id: 'a', provider_name: 'stripe', provider_ref: 'cs_a', status: 'pending', failure_reason: null },
      { id: 'b', provider_name: 'stripe', provider_ref: 'cs_b', status: 'canceled', failure_reason: 'customer_canceled' },
      // PayPal takes nothing until it is captured; Lemon Squeezy checkouts expire on their own.
      { id: 'c', provider_name: 'paypal', provider_ref: 'ORDER-1', status: 'canceled', failure_reason: 'superseded_by_new_checkout' },
      { id: 'd', provider_name: 'lemon_squeezy', provider_ref: 'co_1', status: 'canceled', failure_reason: 'superseded_by_new_checkout' },
    ];
    expect(await closeSupersededCheckouts(CFG, 'ws-1', ['a', 'b', 'c', 'd'])).toBe(0);
    expect(closeStripe).not.toHaveBeenCalled();
  });

  it('a provider that refuses or fails is logged and ignored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    closeStripe.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(false);
    intentRows = [
      { id: 'a', provider_name: 'stripe', provider_ref: 'cs_a', status: 'canceled', failure_reason: 'superseded_by_new_checkout' },
      { id: 'b', provider_name: 'stripe', provider_ref: 'cs_b', status: 'canceled', failure_reason: 'superseded_by_new_checkout' },
    ];
    await expect(closeSupersededCheckouts(CFG, 'ws-1', ['a', 'b'])).resolves.toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('nothing to close: no lookup', async () => {
    expect(await closeSupersededCheckouts(CFG, 'ws-1', [])).toBe(0);
    expect(resolveNamed).not.toHaveBeenCalled();
  });
});

describe('money recorded for review', () => {
  it('is found bound to the intent or naming it, in the intent’s workspace', async () => {
    unappliedRows = [{ id: 'pay-9' }];
    expect(await hasUnappliedPayment(CFG, { id: 'pi-1', workspace_id: 'ws-1' })).toBe(true);
    expect(orFilters).toEqual(['payment_intent_id.eq.pi-1,metadata->>intentId.eq.pi-1']);
    unappliedRows = [];
    expect(await hasUnappliedPayment(CFG, { id: 'pi-1', workspace_id: 'ws-1' })).toBe(false);
  });
});

describe('handleCardIntentWebhook', () => {
  it('a payment event settles the intent; a pending result makes the webhook fail so the provider retries', async () => {
    await handleCardIntentWebhook(CFG, 'stripe', {
      type: 'payment_succeeded', providerEventId: 'evt_1', amount: 2900, currency: 'USD', providerRef: 'cs_1', raw: {},
    }, intent());
    expect(markSucceeded).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    claim.mockResolvedValue({ claimed: true, resumed: false });
    recordPayment.mockResolvedValue({ id: 'pay-1', duplicate: false });
    settleAndApply.mockRejectedValue(new Error('db down'));
    await expect(handleCardIntentWebhook(CFG, 'stripe', {
      type: 'payment_succeeded', providerEventId: 'evt_2', amount: 2900, currency: 'USD', raw: {},
    }, intent())).rejects.toThrow('card_settlement_pending');
  });

  it('a definitive failure ends a waiting attempt only', async () => {
    await handleCardIntentWebhook(CFG, 'stripe', { type: 'payment_failed', status: 'expired', providerEventId: 'e', raw: {} }, intent());
    expect(markFailed).toHaveBeenCalledWith(CFG, 'pi-1', 'gateway_expired');

    vi.clearAllMocks();
    await handleCardIntentWebhook(CFG, 'stripe', { type: 'payment_failed', providerEventId: 'e', raw: {} }, intent({ status: 'succeeded' }));
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('records what the provider actually charged (tax on top) next to the settled payment', async () => {
    await handleCardIntentWebhook(CFG, 'lemon_squeezy', {
      type: 'payment_succeeded', providerEventId: 'order_created_1', amount: 2900, currency: 'USD',
      providerPaymentId: '1001', charge: { total: 3480, tax: 580, currency: 'USD' }, raw: {},
    }, intent({ provider_name: 'lemon_squeezy', provider_ref: 'co_1' }));
    expect(recordPayment.mock.calls[0][1]).toMatchObject({
      amount: 2900,
      metadata: { providerCharge: { total: 3480, tax: 580, currency: 'USD' } },
    });
    expect(markSucceeded).toHaveBeenCalledTimes(1);
  });

  it('a refund is recorded against the intent’s payment', async () => {
    await handleCardIntentWebhook(CFG, 'paypal', {
      type: 'refund_processed', providerEventId: 'e', providerPaymentId: 'CAPTURE-1', refundedTotal: 1000, raw: {},
    }, intent({ status: 'succeeded', provider_name: 'paypal' }));
    expect(recordRefund.mock.calls[0][1]).toBe('paypal');
    expect(recordRefund.mock.calls[0][2]).toMatchObject({ providerPaymentId: 'CAPTURE-1', refundedTotal: 1000, intentId: 'pi-1' });
  });
});
