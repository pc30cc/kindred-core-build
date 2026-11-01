/**
 * Apirone in the account code (server/services/billing/account/index.ts):
 *
 *   - what finally arrived is credited: an amount that differs from the
 *     payment (an under- or overpayment) first becomes the payment's amount
 *     (billing_account_set_received_amount, migration 292), then the
 *     confirmation is recorded and settled as usual; the purpose is bought
 *     only when the balance covers it (the settle SQL decides);
 *   - only Apirone's final received amount: any other gateway's different
 *     amount still fails as a mismatch;
 *   - the lookup always maps against the quoted amount, so a retry after a
 *     received amount was recorded is not scaled twice;
 *   - its unsigned callback credits nothing by itself: the invoice it names
 *     must be the payment's stored reference, and the stored reference is
 *     looked up with the configuration the event was verified with.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  verifyPayment: vi.fn(),
  gatewayRows: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: (...a: unknown[]) => h.rpc(...a),
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'update', 'insert', 'order']) b[m] = () => b;
      b.maybeSingle = async () => ({ data: { receipt_number: 'R2026-000001', balance_after: 100 }, error: null });
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: table === 'billing_gateways' ? h.gatewayRows : null, error: null });
      return b;
    },
  }),
}));
vi.mock('../../../server/services/billing/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/index.js')>()),
  getProvider: (name: string) => ({ name, verifyPayment: (...a: unknown[]) => h.verifyPayment(...a) }),
}));

const { verifyAccountPayment, handleAccountPaymentWebhook, isAccountPaymentLapsed } = await import('../../../server/services/billing/account/index.js');
const { listGateways } = await import('../../../server/services/billing/config/index.js');

const CONFIG = { provider: 'apirone', account: 'apr-0123456789abcdef0123456789abcdef' };

function payment(over: Record<string, unknown> = {}) {
  return {
    id: 'p1', workspace_id: 'w1', provider: 'apirone', currency: 'USD',
    amount_minor: 2900, net_minor: 2900, tax_minor: 0, tax_percent: null,
    purpose: 'plan', purpose_detail: { plan_id: 'plan-pro', billing_interval: 'monthly' }, purpose_result: null,
    status: 'pending', provider_ref: 'inv0001', provider_payment_id: null, failure_reason: null, ledger_id: null,
    return_url: null, created_by: null, created_at: new Date().toISOString(), updated_at: '', completed_at: null,
    verified_amount_minor: null, verified_at: null, refunded_minor: 0, closed_at: null, source: 'checkout',
    card_id: null, charge_requested_at: null, review: null,
    ...over,
  } as never;
}

const verified = (amount: number, over: Record<string, unknown> = {}) => ({
  verified: true, providerRef: 'inv0001', paymentId: 'inv0001', amount, currency: 'USD', status: 'success', receivedFinal: true, ...over,
});

const SETTLED = { data: { replayed: false, ledger_id: 'l1', receipt_number: 'R1', balance_minor: 0 }, error: null };

beforeEach(() => {
  h.rpc.mockReset().mockImplementation(async (fn: string, args: Record<string, unknown>) =>
    fn === 'billing_account_set_received_amount' ? { data: { amount_minor: args.p_amount_minor }, error: null } : SETTLED);
  h.verifyPayment.mockReset();
  h.gatewayRows = [];
});

describe('the received amount (Apirone)', () => {
  it('a full payment settles as usual: no amount is changed', async () => {
    h.verifyPayment.mockResolvedValue(verified(2900));
    const out = await verifyAccountPayment({} as never, { payment: payment(), providerConfig: CONFIG, params: {} });
    expect(out.status).toBe('succeeded');
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(['billing_account_record_verification', 'billing_account_settle_payment']);
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_amount_minor: 2900, p_currency: 'USD', p_provider_payment_id: 'inv0001' });
    // Looked up by the stored invoice, for the server's amount (the return carried no reference).
    expect(h.verifyPayment).toHaveBeenCalledWith(CONFIG, expect.objectContaining({ invoice: 'inv0001', amount: '2900' }));
  });

  it('an underpayment is credited as it came: the amount becomes what arrived, then it is settled', async () => {
    h.verifyPayment.mockResolvedValue(verified(1450));
    const out = await verifyAccountPayment({} as never, { payment: payment(), providerConfig: CONFIG, params: {} });
    expect(out.status).toBe('succeeded');
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual([
      'billing_account_set_received_amount',
      'billing_account_record_verification',
      'billing_account_settle_payment',
    ]);
    expect(h.rpc.mock.calls[0][1]).toEqual({ p_payment_id: 'p1', p_amount_minor: 1450 });
    expect(h.rpc.mock.calls[1][1]).toMatchObject({ p_amount_minor: 1450, p_provider_payment_id: 'inv0001' });
  });

  it('an overpayment too (the plan is bought and the rest stays in the balance, by the settle SQL)', async () => {
    h.verifyPayment.mockResolvedValue(verified(4950));
    await verifyAccountPayment({} as never, { payment: payment(), providerConfig: CONFIG, params: {} });
    expect(h.rpc.mock.calls[0]).toEqual(['billing_account_set_received_amount', { p_payment_id: 'p1', p_amount_minor: 4950 }]);
    expect(h.rpc.mock.calls[1][1]).toMatchObject({ p_amount_minor: 4950 });
  });

  it('a retry maps against the quoted amount, not the amount already set to what arrived', async () => {
    h.verifyPayment.mockResolvedValue(verified(1450));
    const out = await verifyAccountPayment({} as never, {
      payment: payment({ amount_minor: 1450, net_minor: 1450, purpose_detail: { plan_id: 'plan-pro', quoted_amount_minor: 2900 } }),
      providerConfig: CONFIG,
      params: {},
    });
    expect(out.status).toBe('succeeded');
    expect(h.verifyPayment).toHaveBeenCalledWith(CONFIG, expect.objectContaining({ amount: '2900' }));
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(['billing_account_record_verification', 'billing_account_settle_payment']);
  });

  it.each(['billing_payment_has_tax', 'canceling statement due to lock timeout', 'Connection terminated unexpectedly'])(
    'a received amount the database does not record (%s) is thrown: nothing settled or failed, and asked again',
    async (message) => {
      h.verifyPayment.mockResolvedValue(verified(1450));
      h.rpc.mockImplementation(async (fn: string) =>
        fn === 'billing_account_set_received_amount' ? { data: null, error: { message } } : SETTLED);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await expect(verifyAccountPayment({} as never, { payment: payment(), providerConfig: CONFIG, params: {} })).rejects.toThrow(message);
      expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(['billing_account_set_received_amount']);
      expect(error.mock.calls.join(' ')).toMatch(/REVIEW payment=p1/);
      error.mockRestore();
    },
  );

  it('a confirmation another check recorded meanwhile stays pending: the next check settles it from that record', async () => {
    h.verifyPayment.mockResolvedValue(verified(1450));
    h.rpc.mockImplementation(async (fn: string) =>
      fn === 'billing_account_set_received_amount' ? { data: null, error: { message: 'billing_payment_already_verified' } } : SETTLED);
    const out = await verifyAccountPayment({} as never, { payment: payment(), providerConfig: CONFIG, params: {} });
    expect(out).toEqual({ status: 'pending', reason: 'confirmation_recorded' });
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(['billing_account_set_received_amount']);
  });

  it('nothing arrived worth a cent: a mismatch, never a zero credit', async () => {
    h.verifyPayment.mockResolvedValue(verified(0));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = await verifyAccountPayment({} as never, { payment: payment(), providerConfig: CONFIG, params: {} });
    expect(out).toMatchObject({ status: 'failed', reason: 'PAYMENT_AMOUNT_MISMATCH' });
    expect(h.rpc.mock.calls.map((c) => c[0])).not.toContain('billing_account_set_received_amount');
    error.mockRestore();
  });

  it('another gateway\'s different amount is still a mismatch, received or not', async () => {
    h.verifyPayment.mockResolvedValue(verified(1450, { paymentId: 'cs_1', providerRef: 'cs_1' }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = await verifyAccountPayment({} as never, {
      payment: payment({ provider: 'stripe', provider_ref: 'cs_1' }),
      providerConfig: { provider: 'stripe' },
      params: {},
    });
    expect(out).toMatchObject({ status: 'failed', reason: 'PAYMENT_AMOUNT_MISMATCH' });
    expect(h.rpc.mock.calls.map((c) => c[0])).not.toContain('billing_account_set_received_amount');
    error.mockRestore();
  });

  it('a lookup that is not final yet stays pending', async () => {
    h.verifyPayment.mockResolvedValue({ verified: false, providerRef: 'inv0001', status: 'pending' });
    expect(await verifyAccountPayment({} as never, { payment: payment(), providerConfig: CONFIG, params: {} })).toEqual({ status: 'pending' });
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe('an Apirone invoice is ended by Apirone, never by our clock', () => {
  it('past the hour, another gateway\'s checkout lapses; an Apirone one does not (it may be paid at the end and confirmed after)', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    const created_at = '2026-11-01T10:30:00Z';
    expect(isAccountPaymentLapsed({ provider: 'zibal', created_at }, now)).toBe(true);
    expect(isAccountPaymentLapsed({ provider: 'apirone', created_at }, now)).toBe(false);
    expect(isAccountPaymentLapsed({ provider: 'zibal', created_at: '2026-11-01T11:30:00Z' }, now)).toBe(false);
  });

  it('a lookup that says expired (nothing arrived) ends it', async () => {
    h.verifyPayment.mockResolvedValue({ verified: false, providerRef: 'inv0001', status: 'expired' });
    const out = await verifyAccountPayment({} as never, { payment: payment(), providerConfig: CONFIG, params: {} });
    expect(out).toEqual({ status: 'failed', reason: 'gateway_expired' });
  });
});

describe('the unsigned callback credits nothing by itself', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    type: 'payment_succeeded', providerEventId: 'inv0001:completed', providerRef: 'inv0001', providerPaymentId: 'inv0001',
    intentId: 'p1', currency: 'USD', raw: {}, ...over,
  }) as never;

  it('an invoice that is not the payment\'s own (someone\'s invoice carrying our payment id) is a mismatch: nothing is looked up or credited', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = await handleAccountPaymentWebhook({} as never, {
      providerName: 'apirone', workspaceId: 'w1', payment: payment(), providerConfig: CONFIG,
      event: event({ providerRef: 'inv-foreign', providerPaymentId: 'inv-foreign', amount: 2900 }),
    });
    expect(out).toBe('mismatch');
    expect(h.verifyPayment).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('the payment\'s own invoice is looked up again (stored reference, accepted config), never the event\'s amount', async () => {
    h.verifyPayment.mockResolvedValue(verified(2900));
    const out = await handleAccountPaymentWebhook({} as never, {
      providerName: 'apirone', workspaceId: 'w1', payment: payment(), providerConfig: CONFIG,
      event: event({ amount: 999_999 }),
    });
    expect(out).toBe('settled');
    expect(h.verifyPayment).toHaveBeenCalledWith(CONFIG, expect.objectContaining({ invoice: 'inv0001', amount: '2900' }));
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_amount_minor: 2900 });
  });

  it('a final callback whose lookup is not final yet credits nothing and is thrown (the route answers 500, Apirone retries)', async () => {
    h.verifyPayment.mockResolvedValue({ verified: false, providerRef: 'inv0001', status: 'pending' });
    await expect(handleAccountPaymentWebhook({} as never, {
      providerName: 'apirone', workspaceId: 'w1', payment: payment(), providerConfig: CONFIG, event: event(),
    })).rejects.toThrow(/still pending/);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('a received amount the database could not record is thrown too, never acknowledged as ignored', async () => {
    h.verifyPayment.mockResolvedValue(verified(1450));
    h.rpc.mockImplementation(async (fn: string) =>
      fn === 'billing_account_set_received_amount' ? { data: null, error: { message: 'canceling statement due to lock timeout' } } : SETTLED);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handleAccountPaymentWebhook({} as never, {
      providerName: 'apirone', workspaceId: 'w1', payment: payment(), providerConfig: CONFIG, event: event(),
    })).rejects.toThrow(/lock timeout/);
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(['billing_account_set_received_amount']);
    error.mockRestore();
  });

  it('without the verifying configuration it refuses (the route answers 500 and Apirone retries)', async () => {
    await expect(handleAccountPaymentWebhook({} as never, {
      providerName: 'apirone', workspaceId: 'w1', payment: payment(), event: event(),
    })).rejects.toThrow(/configuration is missing/);
  });
});

describe('Finance → Gateways lists Apirone with its names before it has a row', () => {
  it('fa / en / tr', async () => {
    const rows = await listGateways({} as never);
    const apirone = rows.find((g) => g.provider_name === 'apirone');
    expect(apirone?.display_name).toEqual({ en: 'Crypto (USDT on TRON)', fa: 'پرداخت با تتر (ترون)', tr: 'Kripto (TRON üzerinde USDT)' });
    expect(apirone?.is_active).toBe(false);
    expect(apirone?.is_test).toBe(false);
  });
});
