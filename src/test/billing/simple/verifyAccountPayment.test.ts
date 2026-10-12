/**
 * verifyAccountPayment (server/services/billing/account): what a gateway's
 * answer may settle.
 *
 *   - "already verified" never settles an attempt with no recorded
 *     confirmation of its own (SEP verifies by an unbound reference);
 *   - a gateway transaction already recorded for another payment is refused;
 *   - an attempt whose confirmation was recorded is settled from that record,
 *     without asking the gateway again;
 *   - a card return carrying no reference is looked up by the stored one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
const verifyPayment = vi.fn();
vi.mock('../../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'update', 'insert']) b[m] = () => b;
      b.maybeSingle = async () => ({ data: { receipt_number: 'R2026-000001', balance_after: 100 }, error: null });
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
      return b;
    },
  }),
}));
vi.mock('../../../../server/services/billing/index.js', () => ({
  getProvider: () => ({ name: 'x', verifyPayment: (...a: unknown[]) => verifyPayment(...a) }),
}));

const { verifyAccountPayment } = await import('../../../../server/services/billing/account/index.js');

function payment(over: Record<string, unknown> = {}) {
  return {
    id: 'p1', workspace_id: 'w1', provider: 'sep_shaparak', currency: 'IRR',
    amount_minor: 1_100_000, net_minor: 1_000_000, tax_minor: 100_000, tax_percent: 10,
    purpose: 'topup', purpose_detail: {}, status: 'pending', provider_ref: 'TOKEN-B',
    provider_payment_id: null, failure_reason: null, ledger_id: null, return_url: null, created_by: null,
    created_at: new Date().toISOString(), updated_at: '', completed_at: null,
    verified_amount_minor: null, verified_at: null, refunded_minor: 0, closed_at: null,
    ...over,
  } as never;
}

beforeEach(() => {
  rpc.mockReset();
  verifyPayment.mockReset();
});

describe('verifyAccountPayment', () => {
  it('an "already verified" answer never settles an attempt without its own confirmation', async () => {
    verifyPayment.mockResolvedValue({ verified: true, providerRef: 'RefNum-1', amount: 1_100_000, status: 'already_verified' });
    const out = await verifyAccountPayment({} as never, {
      payment: payment(), providerConfig: {} as never, params: { Token: 'TOKEN-B', RefNum: 'RefNum-1' },
    });
    expect(out.status).toBe('pending');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a gateway transaction already used by another payment is refused', async () => {
    verifyPayment.mockResolvedValue({ verified: true, providerRef: 'RefNum-1', amount: 1_100_000, status: 'success' });
    rpc.mockImplementation(async (fn: string) =>
      fn === 'billing_account_record_verification'
        ? { data: null, error: { message: 'billing_payment_reference_reused' } }
        : { data: {}, error: null });
    const out = await verifyAccountPayment({} as never, {
      payment: payment(), providerConfig: {} as never, params: { Token: 'TOKEN-B', RefNum: 'RefNum-1' },
    });
    expect(out).toMatchObject({ status: 'failed', reason: 'PAYMENT_REFERENCE_REUSED' });
    expect(rpc).not.toHaveBeenCalledWith('billing_account_settle_payment', expect.anything());
  });

  it('records the confirmation first, then settles', async () => {
    verifyPayment.mockResolvedValue({ verified: true, providerRef: 'RefNum-9', amount: 1_100_000, status: 'success' });
    rpc.mockResolvedValue({ data: { replayed: false, ledger_id: 'l1', receipt_number: 'R1', balance_minor: 1_000_000 }, error: null });
    const out = await verifyAccountPayment({} as never, {
      payment: payment(), providerConfig: {} as never, params: { Token: 'TOKEN-B', RefNum: 'RefNum-9' },
    });
    expect(out).toMatchObject({ status: 'succeeded', ledgerId: 'l1' });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['billing_account_record_verification', 'billing_account_settle_payment']);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_amount_minor: 1_100_000, p_currency: 'IRR', p_provider_payment_id: 'RefNum-9' });
  });

  it('a recorded confirmation is settled without asking the gateway again', async () => {
    rpc.mockResolvedValue({ data: { replayed: false, ledger_id: 'l2' }, error: null });
    const out = await verifyAccountPayment({} as never, {
      payment: payment({ verified_at: new Date().toISOString(), verified_amount_minor: 1_100_000, provider_payment_id: 'RefNum-9' }),
      providerConfig: {} as never,
      params: {},
    });
    expect(out.status).toBe('succeeded');
    expect(verifyPayment).not.toHaveBeenCalled();
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['billing_account_settle_payment']);
  });

  it('a card return without any reference is looked up by the stored one', async () => {
    verifyPayment.mockResolvedValue({ verified: false, providerRef: 'cs_1', status: 'canceled' });
    rpc.mockResolvedValue({ data: null, error: null });
    const out = await verifyAccountPayment({} as never, {
      payment: payment({ provider: 'stripe', currency: 'USD', amount_minor: 500, net_minor: 500, tax_minor: 0, provider_ref: 'cs_1' }),
      providerConfig: {} as never,
      params: { canceled: '1' },
    });
    expect(verifyPayment).toHaveBeenCalledWith({}, expect.objectContaining({ session_id: 'cs_1' }));
    expect(out).toMatchObject({ status: 'failed', reason: 'gateway_canceled' });
  });

  it('an Iranian return naming another checkout settles nothing', async () => {
    const out = await verifyAccountPayment({} as never, {
      payment: payment(), providerConfig: {} as never, params: { Token: 'TOKEN-OTHER', RefNum: 'RefNum-1' },
    });
    expect(out).toMatchObject({ status: 'failed', reason: 'REFERENCE_MISMATCH' });
    expect(verifyPayment).not.toHaveBeenCalled();
  });

  // ZarinPal took the money on the first verify (code 100) but the answer was
  // lost; every retry gets 101. Its verify is keyed by this payment's own bound
  // authority, so the 101 settles it (it used to stay pending, then expire).
  describe('ZarinPal "already verified" (101) after a lost first answer', () => {
    const zarinpal = (over: Record<string, unknown> = {}) =>
      payment({ provider: 'zarinpal', provider_ref: 'A000000000000000000000000000000AUTH', ...over });
    const params = { Authority: 'A000000000000000000000000000000AUTH', Status: 'OK' };

    it.each([['zarinpal'], ['zarinpal_test']])('%s: settles a pending payment with ZarinPal\'s ref_id', async (provider) => {
      verifyPayment.mockResolvedValue({ verified: true, providerRef: '987654321', amount: 1_100_000, status: 'already_verified' });
      rpc.mockResolvedValue({ data: { replayed: false, ledger_id: 'l9', receipt_number: 'R9', balance_minor: 1_000_000 }, error: null });
      const out = await verifyAccountPayment({} as never, { payment: zarinpal({ provider }), providerConfig: {} as never, params });
      expect(out).toMatchObject({ status: 'succeeded', ledgerId: 'l9' });
      expect(verifyPayment).toHaveBeenCalledWith({}, expect.objectContaining({ Authority: 'A000000000000000000000000000000AUTH', amount: '1100000' }));
      expect(rpc.mock.calls.map((c) => c[0])).toEqual(['billing_account_record_verification', 'billing_account_settle_payment']);
      expect(rpc.mock.calls[0][1]).toMatchObject({ p_amount_minor: 1_100_000, p_currency: 'IRR', p_provider_payment_id: '987654321' });
    });

    it('still refuses a ref_id another payment already settled', async () => {
      verifyPayment.mockResolvedValue({ verified: true, providerRef: '987654321', amount: 1_100_000, status: 'already_verified' });
      rpc.mockResolvedValue({ data: null, error: { message: 'billing_payment_reference_reused' } });
      const out = await verifyAccountPayment({} as never, { payment: zarinpal(), providerConfig: {} as never, params });
      expect(out).toMatchObject({ status: 'failed', reason: 'PAYMENT_REFERENCE_REUSED' });
    });

    it('a payment that is no longer pending is not settled by a 101', async () => {
      verifyPayment.mockResolvedValue({ verified: true, providerRef: '987654321', amount: 1_100_000, status: 'already_verified' });
      const out = await verifyAccountPayment({} as never, { payment: zarinpal({ status: 'expired' }), providerConfig: {} as never, params });
      expect(out.status).toBe('pending');
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  // Part C: Zibal, NextPay, IDPay and PayPing verify by this payment's own
  // bound reference too; their "already verified" answers (201, -49,
  // 101 / 200, 409 code 110) settle a pending payment the same way. SEP
  // (RefNum, unbound) keeps the strict rule (first test above).
  describe('"already verified" from the other authority-keyed gateways', () => {
    it.each([
      ['zibal', '3714061657', { trackId: '3714061657', success: '1', status: '2' }],
      ['nextpay', 'tx-1', { trans_id: 'tx-1', order_id: 'p1' }],
      ['idpay', 'idp-1', { id: 'idp-1', order_id: 'p1', status: '10' }],
      ['payping', 'pc-1', { paymentCode: 'pc-1', paymentRefId: '555', status: '1' }],
    ])('%s: settles a pending payment', async (provider, ref, params) => {
      verifyPayment.mockResolvedValue({ verified: true, providerRef: 'REF-9', amount: 1_100_000, status: 'already_verified' });
      rpc.mockResolvedValue({ data: { replayed: false, ledger_id: 'l7', receipt_number: 'R7', balance_minor: 1_000_000 }, error: null });
      const out = await verifyAccountPayment({} as never, { payment: payment({ provider, provider_ref: ref }), providerConfig: {} as never, params });
      expect(out).toMatchObject({ status: 'succeeded', ledgerId: 'l7' });
      expect(rpc.mock.calls[0][1]).toMatchObject({ p_amount_minor: 1_100_000, p_provider_payment_id: 'REF-9' });
    });

    it('an "already verified" answer without an amount stays pending for review (the money is not failed)', async () => {
      verifyPayment.mockResolvedValue({ verified: true, providerRef: 'REF-9', status: 'already_verified' });
      const out = await verifyAccountPayment({} as never, {
        payment: payment({ provider: 'zibal', provider_ref: '3714061657' }), providerConfig: {} as never, params: { trackId: '3714061657' },
      });
      expect(out).toEqual({ status: 'pending', reason: 'gateway_already_verified' });
      expect(rpc).not.toHaveBeenCalled();
    });
  });
});
