/**
 * Billing v2's customer mutations are retired while the simple billing owns
 * plans and money (shared/billingMode.ts, server/middleware/billingV2Retired.ts):
 * each answers 410 BILLING_V2_RETIRED before authorization or any database
 * access. Reads, gateway returns and the webhook (which also settles the
 * simple billing's account payments) stay open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';
const PLAN = '22222222-2222-4222-8222-222222222222';
const DEPOSIT = '33333333-3333-4333-8333-333333333333';
const CALLBACK = 'https://app.test/acme/billing';

const spies = vi.hoisted(() => ({
  /** Every table / RPC either database client was asked for. */
  db: [] as string[],
  authorize: vi.fn(async (..._a: unknown[]) => ({ userId: 'u1', isAdmin: false, role: 'owner' as string | null })),
  verifyWebhook: vi.fn(),
  accountWebhook: vi.fn(async (..._a: unknown[]) => undefined),
}));

/** A PostgREST-shaped client that records what it is asked for and finds nothing. */
function fakeClient() {
  const builder: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
        if (prop === 'maybeSingle' || prop === 'single') return async () => ({ data: null, error: null });
        return () => builder;
      },
    },
  );
  return {
    from(table: string) {
      spies.db.push(table);
      return builder;
    },
    rpc: async (name: string) => {
      spies.db.push(`rpc:${name}`);
      return { data: null, error: null };
    },
  };
}

vi.mock('../../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../../server/lib/serviceClient.js', () => ({ serviceClientFor: () => fakeClient() }));
vi.mock('../../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: spies.authorize,
}));
vi.mock('../../../../server/services/billing/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/index.js')>()),
  getProvider: (name: string) => (name === 'stripe' ? { name, capabilities: {}, verifyWebhook: spies.verifyWebhook } : null),
  resolvePlatformBillingConfig: async () => ({ provider: 'stripe', webhook_secret: 'whsec' }),
  claimBillingWebhookEvent: async () => ({ claimed: true, eventRowId: 'row-1' }),
  finalizeBillingWebhookEvent: async () => undefined,
}));
// A simple-billing account payment travels in the provider's signed metadata
// where an invoice checkout's intent id would.
vi.mock('../../../../server/services/billing/account/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/account/index.js')>()),
  readAccountPayment: async (_cfg: unknown, id: string) =>
    id === 'acct-pay-1' ? { id, workspace_id: WS, provider: 'stripe', status: 'pending' } : null,
  findAccountPaymentByProviderPayment: async () => null,
  handleAccountPaymentWebhook: spies.accountWebhook,
}));

const { LEGACY_BILLING_ENABLED } = await import('../../../../shared/billingMode.js');
const { billingCustomerRouter } = await import('../../../../server/routes/billingCustomer.js');
const { billingRouter, billingWebhookRouter } = await import('../../../../server/routes/billing.js');

// Mounted as server/index.ts mounts them: the webhook (raw body) first.
const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' };
  next();
});
app.use('/api/billing/webhook', billingWebhookRouter);
app.use(express.json());
app.use('/api/billing', billingCustomerRouter);
app.use('/api/billing', billingRouter);
const server = http.createServer(app).listen(0);
const port = () => (server.address() as { port: number }).port;

function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: port(), path, method, headers: { 'content-type': 'application/json', connection: 'close' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, text: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

beforeEach(() => {
  spies.db.length = 0;
  spies.authorize.mockClear();
  spies.verifyWebhook.mockReset();
  spies.accountWebhook.mockClear();
});

/** Every v2 customer route that changes a plan or moves money, with a body it would accept. */
const RETIRED: Array<[method: string, path: string, body?: unknown]> = [
  ['POST', `/api/billing/workspaces/${WS}/invoices/inv-1/pay-wallet`],
  ['POST', `/api/billing/workspaces/${WS}/invoices/inv-1/checkout`, { callbackUrl: CALLBACK }],
  ['POST', `/api/billing/workspaces/${WS}/plan-change`, { planId: PLAN, interval: 'monthly', mode: 'immediate', expectedAmountIrr: 0 }],
  ['POST', `/api/billing/workspaces/${WS}/plan-change/cancel`],
  ['PUT', `/api/billing/workspaces/${WS}/wallet/auto-pay`, { enabled: true }],
  ['POST', `/api/billing/workspaces/${WS}/wallet/deposit/invoice`, { amountIrr: 1_000_000 }],
  ['POST', `/api/billing/workspaces/${WS}/wallet/deposit/preview`, { amountIrr: 1_000_000 }],
  ['POST', `/api/billing/workspaces/${WS}/wallet/deposit/checkout`, { depositId: DEPOSIT, callbackUrl: CALLBACK }],
  ['POST', `/api/billing/workspaces/${WS}/ai-credit/invoice`, { amountIrr: 1_000_000 }],
  ['POST', '/api/billing/invoice-preview', { workspaceId: WS, planId: PLAN }],
  ['POST', '/api/billing/checkout', { workspaceId: WS, planId: PLAN, callbackUrl: CALLBACK }],
  ['POST', '/api/billing/subscription/cancel', { workspaceId: WS }],
  ['POST', '/api/billing/subscription/resume', { workspaceId: WS }],
];

describe('billing v2 customer mutations are retired', () => {
  it('the flag is off', () => {
    expect(LEGACY_BILLING_ENABLED).toBe(false);
  });

  it.each(RETIRED)('%s %s answers 410 without authorizing or touching the database', async (method, path, body) => {
    const res = await call(method, path, body);
    expect(res.status).toBe(410);
    expect(JSON.parse(res.text)).toEqual({ error: 'BILLING_V2_RETIRED' });
    expect(spies.authorize).not.toHaveBeenCalled();
    expect(spies.db).toEqual([]);
  });
});

describe('what stays open', () => {
  it('read-only GETs still answer', async () => {
    const transactions = await call('GET', `/api/billing/workspaces/${WS}/transactions`);
    expect(transactions.status).toBe(200);
    expect(JSON.parse(transactions.text)).toMatchObject({ transactions: [], total: 0 });
    const events = await call('GET', `/api/billing/events/${WS}`);
    expect(events.status).toBe(200);
    expect(JSON.parse(events.text)).toEqual({ events: [] });
    expect(spies.authorize).toHaveBeenCalledTimes(2);
  });

  it('gateway returns and callbacks of payments already started still land', async () => {
    const back = await call('GET', '/api/billing/return');
    expect(back.status).toBe(400);
    const verify = await call('POST', '/api/billing/verify-callback', {});
    expect(verify.status).toBe(400);
    expect(JSON.parse(verify.text)).toEqual({ error: 'Missing workspaceId or provider' });
  });

  it('the webhook still settles a simple-billing account payment', async () => {
    const event = {
      type: 'payment_succeeded',
      providerEventId: 'evt_1',
      intentId: 'acct-pay-1',
      workspaceId: WS,
      amount: 2900,
      currency: 'USD',
      raw: {},
    };
    spies.verifyWebhook.mockResolvedValue(event);
    const res = await call('POST', '/api/billing/webhook/stripe', { id: 'evt_1' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ received: true });
    expect(spies.accountWebhook).toHaveBeenCalledTimes(1);
    expect(spies.accountWebhook.mock.calls[0][1]).toMatchObject({
      providerName: 'stripe',
      workspaceId: WS,
      payment: { id: 'acct-pay-1' },
    });
  });
});
