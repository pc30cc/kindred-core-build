/**
 * Apirone's callback on the webhook route (server/routes/billing.ts). It is
 * NOT signed, so it is accepted as a lookup-verified provider, never as a
 * signed one:
 *
 *   - a callback for another Apirone account is refused (400) without
 *     touching the account payments;
 *   - a callback whose invoice is not final is acknowledged `*ok*` and
 *     nothing is claimed or handled;
 *   - a final invoice is claimed once (invoice:status) and handed to the
 *     account code WITH the configuration it was verified with (the account
 *     code then binds and looks the stored invoice up again), and answered
 *     `*ok*` (text/plain, 200), which stops Apirone's retries;
 *   - an invoice naming no payment of ours is acknowledged, never credited;
 *   - outside the Iranian edition (RESPOK) it is an unknown provider (404),
 *     refused before anything is read or fetched.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';
const PAY = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = 'apr-0123456789abcdef0123456789abcdef';
const CONFIG = { provider: 'apirone', account: ACCOUNT, fee_percent: '1' };

const h = vi.hoisted(() => ({
  claim: vi.fn(),
  finalize: vi.fn(async (..._a: unknown[]) => undefined),
  accountWebhook: vi.fn(async (..._a: unknown[]) => 'settled'),
  readAccountPayment: vi.fn(async (..._a: unknown[]) => null as unknown),
  platformConfig: null as Record<string, unknown> | null,
  edition: 'iran' as 'iran' | 'international' | null,
  dbReads: 0,
}));

function fakeClient() {
  return {
    from() {
      h.dbReads += 1;
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'limit', 'in', 'eq']) b[m] = () => b;
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/lib/serviceClient.js', () => ({ serviceClientFor: () => fakeClient() }));
vi.mock('../../../server/services/billing/edition.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/edition.js')>()),
  getPlatformEdition: async () => {
    if (!h.edition) throw new Error('edition unavailable');
    return h.edition;
  },
}));
vi.mock('../../../server/services/billing/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/index.js')>()),
  resolvePlatformBillingConfig: async () => h.platformConfig,
  claimBillingWebhookEvent: h.claim,
  finalizeBillingWebhookEvent: h.finalize,
}));
vi.mock('../../../server/services/billing/account/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/account/index.js')>()),
  readAccountPayment: h.readAccountPayment,
  findAccountPaymentByProviderPayment: async () => null,
  handleAccountPaymentWebhook: h.accountWebhook,
}));

const { billingWebhookRouter } = await import('../../../server/routes/billing.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' };
  next();
});
app.use('/api/billing/webhook', billingWebhookRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

/** POSTs as Apirone does (JSON); real HTTP to our own server, so `fetch` stays free for the Apirone stub. */
function post(body: unknown): Promise<{ status: number; type: string; text: string }> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/billing/webhook/apirone', method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, type: String(res.headers['content-type'] || ''), text: data }));
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function invoiceAnswer(status: string, over: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    invoice: 'inv0001',
    currency: 'usdt@trx',
    amount: 29_290_000,
    status,
    history: status === 'created' ? [] : [{ status: 'paid', txid: 'tx-1', amount: 29_290_000 }],
    linkback: `https://app.webyar.ai/acme/billing?payment=${PAY}&provider=apirone`,
    'invoice-url': 'https://apirone.com/invoice?id=inv0001',
    ...over,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const ACCOUNT_PAYMENT = { id: PAY, workspace_id: WS, provider: 'apirone', provider_ref: 'inv0001', status: 'pending' };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.claim.mockReset().mockResolvedValue({ claimed: true, eventRowId: 'row-1' });
  h.finalize.mockClear();
  h.accountWebhook.mockReset().mockResolvedValue('settled');
  h.readAccountPayment.mockReset().mockResolvedValue(ACCOUNT_PAYMENT);
  h.platformConfig = { ...CONFIG };
  h.edition = 'iran';
  h.dbReads = 0;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /api/billing/webhook/apirone', () => {
  it('a final invoice is claimed once and handed over with its verifying config; answered *ok*', async () => {
    fetchMock.mockResolvedValue(invoiceAnswer('completed'));
    const res = await post({ account: ACCOUNT, invoice: 'inv0001', status: 'completed' });
    expect(res).toMatchObject({ status: 200, text: '*ok*' });
    expect(res.type).toMatch(/^text\/plain/);
    expect(fetchMock.mock.calls[0][0]).toBe('https://apirone.com/api/v2/invoices/inv0001');
    expect(h.readAccountPayment.mock.calls.map((c) => c[1])).toContain(PAY);
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.claim.mock.calls[0][2]).toMatchObject({ providerName: 'apirone', providerEventId: 'inv0001:completed', workspaceId: WS });
    expect(h.accountWebhook).toHaveBeenCalledTimes(1);
    const input = h.accountWebhook.mock.calls[0][1] as Record<string, unknown>;
    expect(input).toMatchObject({ providerName: 'apirone', workspaceId: WS, payment: ACCOUNT_PAYMENT });
    expect(input.providerConfig).toMatchObject({ provider: 'apirone', account: ACCOUNT });
    expect(input.event).toMatchObject({ type: 'payment_succeeded', providerRef: 'inv0001', intentId: PAY });
    expect(h.finalize).toHaveBeenCalledWith('http://db', 'k', 'row-1', 'success');
  });

  it('another account is refused, nothing is fetched or handled', async () => {
    const res = await post({ account: 'apr-ffffffffffffffffffffffffffffffff', invoice: 'inv0001', status: 'completed' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.accountWebhook).not.toHaveBeenCalled();
  });

  it('an invoice that is not final yet (the callback says completed, Apirone says paid) is acknowledged, not handled', async () => {
    fetchMock.mockResolvedValue(invoiceAnswer('paid'));
    const res = await post({ account: ACCOUNT, invoice: 'inv0001', status: 'completed' });
    expect(res).toMatchObject({ status: 200, text: '*ok*' });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.accountWebhook).not.toHaveBeenCalled();
  });

  it('an invoice whose linkback names no payment of ours is acknowledged and never credited', async () => {
    h.readAccountPayment.mockResolvedValue(null);
    fetchMock.mockResolvedValue(invoiceAnswer('completed'));
    const res = await post({ account: ACCOUNT, invoice: 'inv0001', status: 'completed' });
    expect(res).toMatchObject({ status: 200, text: '*ok*' });
    expect(h.accountWebhook).not.toHaveBeenCalled();
  });

  it('a failure while handling answers 500 (Apirone sends it again)', async () => {
    fetchMock.mockResolvedValue(invoiceAnswer('completed'));
    h.accountWebhook.mockRejectedValue(new Error('lookup failed'));
    const res = await post({ account: ACCOUNT, invoice: 'inv0001', status: 'completed' });
    expect(res.status).toBe(500);
    expect(h.finalize).toHaveBeenCalledWith('http://db', 'k', 'row-1', 'failed');
  });

  it('outside the Iranian edition (RESPOK) it is an unknown provider: nothing is read, fetched or handled', async () => {
    h.edition = 'international';
    const res = await post({ account: ACCOUNT, invoice: 'inv0001', status: 'completed' });
    expect(res.status).toBe(404);
    expect(h.dbReads).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.accountWebhook).not.toHaveBeenCalled();
  });

  it('an edition that cannot be read answers 503 (Apirone sends it again)', async () => {
    h.edition = null;
    const res = await post({ account: ACCOUNT, invoice: 'inv0001', status: 'completed' });
    expect(res.status).toBe(503);
    expect(h.dbReads).toBe(0);
    expect(h.accountWebhook).not.toHaveBeenCalled();
  });

  it('without Apirone settings nothing verifies (400)', async () => {
    h.platformConfig = null;
    const res = await post({ account: ACCOUNT, invoice: 'inv0001', status: 'completed' });
    expect(res.status).toBe(400);
    expect(h.accountWebhook).not.toHaveBeenCalled();
  });
});
