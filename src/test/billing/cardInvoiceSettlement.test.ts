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
const markSucceeded = vi.fn().mockResolvedValue(undefined);
const markFailed = vi.fn().mockResolvedValue(undefined);
const noteFailure = vi.fn().mockResolvedValue(undefined);
const recordPayment = vi.fn();
const settleAndApply = vi.fn();
const releaseCollection = vi.fn().mockResolvedValue(undefined);
const recordRefund = vi.fn().mockResolvedValue(true);
const entitlementChanged = vi.fn().mockResolvedValue({ ok: true, cacheCleared: true, catchupEnqueued: 0 });
const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];

vi.mock('../../../server/services/billing/paymentIntent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/paymentIntent.js')>()),
  claimIntentForProcessing: (...a: unknown[]) => claim(...a),
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
      b.select = () => b;
      b.eq = () => b;
      b.update = (patch: Record<string, unknown>) => {
        updates.push({ table, patch });
        return b;
      };
      // Active collections of an intent: one reservation to release.
      b.then = (resolve: (v: unknown) => void) =>
        resolve({ data: table === 'billing_invoice_collections' ? [{ id: 'col-1' }] : null, error: null });
      return b;
    },
  }),
}));

const {
  canCollectInvoice,
  cardCallbackRefConflicts,
  handleCardIntentWebhook,
  intentCurrency,
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
    expect(await settleVerifiedCardPayment(CFG, { intent: intent({ status: 'succeeded' }), ...paid })).toEqual({ outcome: 'duplicate' });
    expect(claim).not.toHaveBeenCalled();
    expect(recordPayment).not.toHaveBeenCalled();
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
    expect(updates).toContainEqual({
      table: 'billing_payments',
      patch: { reconciliation_state: 'unapplied', reconciliation_reason: reason },
    });
    expect(markFailed).toHaveBeenCalledWith(CFG, 'pi-1', reason);
  });

  it.each([['failed'], ['canceled'], ['expired']])('money for an intent that is %s is recorded for review', async (status) => {
    const out = await settleVerifiedCardPayment(CFG, { intent: intent({ status }), ...paid });
    expect(out).toEqual({ outcome: 'parked', reason: `payment_after_intent_${status}` });
    expect(settleAndApply).not.toHaveBeenCalled();
    expect(recordPayment.mock.calls[0][1]).toMatchObject({ amount: 2900, currency: 'USD' });
    // A terminal intent is not touched again.
    expect(markFailed).not.toHaveBeenCalled();
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

  it('a refund is recorded against the intent’s payment', async () => {
    await handleCardIntentWebhook(CFG, 'paypal', {
      type: 'refund_processed', providerEventId: 'e', providerPaymentId: 'CAPTURE-1', refundedTotal: 1000, raw: {},
    }, intent({ status: 'succeeded', provider_name: 'paypal' }));
    expect(recordRefund.mock.calls[0][1]).toBe('paypal');
    expect(recordRefund.mock.calls[0][2]).toMatchObject({ providerPaymentId: 'CAPTURE-1', refundedTotal: 1000, intentId: 'pi-1' });
  });
});
