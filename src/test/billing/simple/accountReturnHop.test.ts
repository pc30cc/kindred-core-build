/**
 * The API's return hop (/api/billing/account-return, routes/billingAccount.ts)
 * for the gateways that post their result as a form (SEP, IDPay, PayPing v3):
 * the app's page cannot receive a POST (it answered 405 / lost the fields), so
 *   - their checkout callback is the hop on the API origin;
 *   - the hop accepts the POSTed form as well as a GET query, flattens
 *     PayPing's `data` JSON, and bounces (303) to the payment's stored return
 *     URL on this platform's own app, never anywhere else.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';
const PAY = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  payment: null as Record<string, unknown> | null,
  provider: 'sep_shaparak',
  createCheckoutSession: vi.fn(),
  vat: {} as Record<string, unknown>,
  created: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../../server/lib/workspaceAuth.js', () => ({
  serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
  authorizeWorkspaceAccess: async () => ({ userId: 'u1', isAdmin: false, role: 'owner' }),
}));
vi.mock('../../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gte']) b[m] = () => b;
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null, count: 0 });
      return b;
    },
  }),
}));
vi.mock('../../../../server/services/platformOrigins.js', () => ({ allowedOrigins: () => ['https://app.test'] }));
vi.mock('../../../../server/services/auth-email.js', () => ({ resolveAppBaseUrl: async () => 'https://app.test' }));
vi.mock('../../../../server/services/billing/index.js', () => ({
  logBillingEvent: async () => undefined,
  resolveNamedBillingConfig: async () => null,
}));
vi.mock('../../../../server/services/billing/callbackUrl.js', () => ({
  isAllowedBillingCallbackUrl: (_req: unknown, _cfg: unknown, url: string) => url.startsWith('https://app.test/'),
  resolvePublicApiOrigin: async () => 'https://api.test',
}));
vi.mock('../../../../server/services/billing/edition.js', () => ({
  editionErrorResponse: () => null,
  getBillingRegion: async () => ({ edition: 'iran', regionMode: 'iran', currency: 'IRR' }),
}));
vi.mock('../../../../server/services/billing/account/index.js', () => ({
  AccountBillingError: class extends Error {},
  accountCurrency: async () => 'IRR',
  accountPaymentNeedsBinding: () => true,
  createAccountPayment: async (_c: unknown, input: Record<string, unknown>) => {
    h.created.push(input);
    return { id: PAY, ...input };
  },
  failAccountPayment: async () => undefined,
  getBillingSettings: async () => ({ vat_percent: h.vat }),
  patchAccountPayment: async () => undefined,
  readAccountPayment: async (_c: unknown, id: string) => (h.payment && h.payment.id === id ? h.payment : null),
}));
vi.mock('../../../../server/services/billing/account/gateways.js', () => ({
  accountGateways: async () => [],
  isIranianGateway: () => true,
  resolveAccountGateway: async () => ({ provider: { name: h.provider, createCheckoutSession: h.createCheckoutSession }, config: {} }),
}));

const { billingAccountRouter, gatewayReturnFields } = await import('../../../../server/routes/billingAccount.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k', corsOrigins: [] };
  next();
});
app.use(express.json());
app.use('/api/billing', billingAccountRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

function send(method: string, path: string, body?: string, contentType = 'application/x-www-form-urlencoded') {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise<{ status: number; location: string | undefined; text: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { 'content-type': contentType, connection: 'close' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, location: res.headers.location, text: data }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

beforeEach(() => {
  h.provider = 'sep_shaparak';
  h.vat = {};
  h.created = [];
  h.payment = { id: PAY, workspace_id: WS, provider: 'sep_shaparak', return_url: `https://app.test/acme/billing?payment=${PAY}&provider=sep_shaparak` };
  h.createCheckoutSession.mockReset().mockResolvedValue({ paymentUrl: 'https://sep.shaparak.ir/OnlinePG/SendToken?token=T', sessionId: 'T' });
});

describe('gatewayReturnFields', () => {
  it('merges the query and the posted form (the form wins), and flattens a `data` JSON field', () => {
    expect(gatewayReturnFields(
      { payment: PAY, provider: 'payping', status: 'query' },
      { status: '1', data: JSON.stringify({ paymentCode: 'pc-1', paymentRefId: 555, amount: 25000, nested: { x: 1 } }) },
    )).toEqual({ payment: PAY, provider: 'payping', status: '1', paymentCode: 'pc-1', paymentRefId: '555', amount: '25000' });
  });

  it('keeps a `data` field that is not JSON, and never lets it overwrite a sent field', () => {
    expect(gatewayReturnFields({}, { data: 'plain' })).toEqual({ data: 'plain' });
    expect(gatewayReturnFields({ paymentCode: 'pc-real' }, { data: '{"paymentCode":"pc-other"}' })).toEqual({ paymentCode: 'pc-real' });
  });
});

describe('checkout callback of a form-posting gateway', () => {
  it.each([['sep_shaparak'], ['idpay'], ['payping']])('%s: the callback is the API hop, not the app page', async (provider) => {
    h.provider = provider;
    const res = await send('POST', `/api/billing/account/${WS}/topup`, JSON.stringify({ amountMinor: 1_000_000, callbackUrl: 'https://app.test/acme/billing' }), 'application/json');
    expect(res.status).toBe(200);
    expect(h.createCheckoutSession.mock.calls[0][1].callbackUrl).toBe(`https://api.test/api/billing/account-return?payment=${PAY}&provider=${provider}`);
  });

  it('zibal (GET callback): the app page, as before', async () => {
    h.provider = 'zibal';
    await send('POST', `/api/billing/account/${WS}/topup`, JSON.stringify({ amountMinor: 1_000_000, callbackUrl: 'https://app.test/acme/billing' }), 'application/json');
    expect(h.createCheckoutSession.mock.calls[0][1].callbackUrl).toBe(`https://app.test/acme/billing?payment=${PAY}&provider=zibal`);
  });
});

describe('PayPing charges whole Toman', () => {
  const topup = (amountMinor: number) => send('POST', `/api/billing/account/${WS}/topup`, JSON.stringify({ amountMinor, callbackUrl: 'https://app.test/acme/billing' }), 'application/json');

  it('a VAT total that is not whole Toman is rounded down in the tax, never refused at the gateway', async () => {
    h.provider = 'payping';
    h.vat = { IRR: 10 };
    // 123,450 net + 12,345 VAT = 135,795 Rial: PayPing would refuse it.
    const res = await topup(123_450);
    expect(res.status).toBe(200);
    expect(h.created[0]).toMatchObject({ netMinor: 123_450, taxMinor: 12_340 });
    expect(h.createCheckoutSession.mock.calls[0][1].metadata.amount).toBe('135790');
  });

  it('an amount without VAT that is not whole Toman is refused before a payment row exists', async () => {
    h.provider = 'payping';
    const res = await topup(123_455);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toMatchObject({ error: 'AMOUNT_NOT_WHOLE_TOMAN' });
    expect(h.created).toHaveLength(0);
    expect(h.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('the other gateways keep the exact VAT', async () => {
    h.provider = 'zibal';
    h.vat = { IRR: 10 };
    await topup(123_450);
    expect(h.created[0]).toMatchObject({ netMinor: 123_450, taxMinor: 12_345 });
    expect(h.createCheckoutSession.mock.calls[0][1].metadata.amount).toBe('135795');
  });
});

describe('POST /api/billing/account-return', () => {
  it('bounces SEP\'s posted form to the payment\'s page, fields in the query', async () => {
    const form = new URLSearchParams({ State: 'OK', Status: '2', RefNum: 'REF-1', ResNum: PAY, Token: 'T', Amount: '1000000' }).toString();
    const res = await send('POST', `/api/billing/account-return?payment=${PAY}&provider=sep_shaparak`, form);
    expect(res.status).toBe(303);
    const target = new URL(res.location!);
    expect(target.origin).toBe('https://app.test');
    expect(Object.fromEntries(target.searchParams)).toMatchObject({ payment: PAY, provider: 'sep_shaparak', State: 'OK', RefNum: 'REF-1', Token: 'T' });
  });

  it('a form cannot name another payment or provider than the query\'s payment row', async () => {
    const res = await send('POST', `/api/billing/account-return?payment=${PAY}&provider=sep_shaparak`, new URLSearchParams({ provider: 'zarinpal' }).toString());
    expect(res.status).toBe(400);
  });

  it('never bounces to an origin that is not this platform\'s app', async () => {
    h.payment = { ...h.payment!, return_url: 'https://evil.test/billing' };
    const res = await send('POST', `/api/billing/account-return?payment=${PAY}&provider=sep_shaparak`, 'State=OK');
    expect(res.status).toBe(400);
    expect(res.location).toBeUndefined();
  });

  it('GET still works (plain-http app origins)', async () => {
    const res = await send('GET', `/api/billing/account-return?payment=${PAY}&provider=sep_shaparak&RefNum=R`);
    expect(res.status).toBe(303);
    expect(new URL(res.location!).searchParams.get('RefNum')).toBe('R');
  });
});
