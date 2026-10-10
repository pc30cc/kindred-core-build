/**
 * verifyAccountPayment (server/services/billing/account): what a gateway's
 * answer may settle.
 *
 *   - "already verified" never settles an attempt with no recorded
 *     confirmation of its own (SEP / PayPing verify by an unbound reference);
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
});
