/**
 * The customer's card checkout routes (server/routes/billingCustomer.ts).
 *
 *  - A Lemon Squeezy store sells in the single currency it was created with:
 *    it is offered, and used, for that currency only.
 *  - Opening a new checkout for an invoice supersedes the previous attempt;
 *    the previous provider checkout is closed (best effort), so it cannot be
 *    paid behind the new one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';

// These tests pin today's Iranian-edition behaviour (shared/edition.ts); the
// International edition has its own suite (src/test/edition/*).
vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/platformRegion.js')>()),
  getPlatformEdition: async () => 'iran',
}));

const WS = '11111111-1111-4111-8111-111111111111';
const INVOICE = 'inv-1';

let gatewayRows: Array<Record<string, unknown>> = [];
let lemonStoreCurrency = 'USD';
const closeCheckout = vi.fn();
const createCheckout = vi.fn();
const beginCollection = vi.fn();
let pendingIntentRows: Array<Record<string, unknown>> = [];
let supersededRows: Array<Record<string, unknown>> = [];
/** Active `billing_plans` rows the catalogue reads. */
let planRows: Array<Record<string, unknown>> = [];

vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async () => ({ userId: 'u1', isAdmin: false, role: 'owner' }),
  serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
}));
vi.mock('../../../server/services/billing/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/config/index.js')>()),
  listPayableGateways: async () => gatewayRows,
}));
vi.mock('../../../server/services/billing/callbackUrl.js', () => ({
  isAllowedBillingCallbackUrl: () => true,
  resolvePublicApiOrigin: async () => 'https://api.test',
}));
vi.mock('../../../server/services/billing/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/billing/index.js')>();
  const resolve = async (_u: string, _k: string, _ws: string, name: string) => {
    const real = actual.getProvider(name)!;
    const provider = {
      ...real,
      createCheckoutSession: (...a: unknown[]) => createCheckout(name, ...a),
      ...(real.closeCheckout ? { closeCheckout: (...a: unknown[]) => closeCheckout(name, ...a) } : {}),
    };
    const config = name === 'lemon_squeezy' ? { provider: name, currency: lemonStoreCurrency } : { provider: name };
    return { provider, config };
  };
  return {
    ...actual,
    resolveNamedBillingConfig: resolve,
    resolveBillingConfig: async () => null,
    logBillingEvent: async () => undefined,
  };
});
vi.mock('../../../server/services/billing/invoice/settle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/invoice/settle.js')>()),
  getInvoice: async () => ({
    id: INVOICE, workspace_id: WS, status: 'open', amount_due_irr: 2900, currency: 'USD',
    invoice_number: 'AB12345678', plan_id: 'plan-pro', billing_interval: 'monthly', plan_name_snapshot: 'Pro',
    effect_snapshot: { action_type: 'plan_new' },
  }),
  beginCollection: (...a: unknown[]) => beginCollection(...a),
  releaseCollection: async () => undefined,
}));
vi.mock('../../../server/services/billing/paymentIntent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/paymentIntent.js')>()),
  createInvoiceIntent: async () => ({ id: 'pi-new', metadata: { currency: 'USD' } }),
  setPaymentIntentProviderRef: async () => undefined,
  markPaymentIntentFailed: async () => undefined,
}));
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.update = () => b;
      b.order = () => b;
      b.eq = (column: string, value: unknown) => {
        filters.push([column, value]);
        return b;
      };
      b.in = () => {
        filters.push(['id', 'in']);
        return b;
      };
      b.maybeSingle = async () => ({ data: table === 'profiles' ? { email: 'owner@example.com' } : null, error: null });
      b.then = (resolve: (v: unknown) => void) => {
        let data: unknown = table === 'billing_plans' ? planRows : null;
        if (table === 'billing_payment_intents') {
          // openCheckoutAttempts reads pending attempts; closeSupersededCheckouts re-reads them by id.
          data = filters.some(([c]) => c === 'id') ? supersededRows : pendingIntentRows;
        }
        resolve({ data, error: null });
      };
      return b;
    },
  }),
}));

const { billingCustomerRouter } = await import('../../../server/routes/billingCustomer.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' };
  next();
});
app.use(express.json());
app.use('/api/billing', billingCustomerRouter);
const server = http.createServer(app).listen(0);
const port = () => (server.address() as { port: number }).port;

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: port(), path, method, headers: { 'content-type': 'application/json', connection: 'close' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data ? JSON.parse(data) : {} }));
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const gateway = (provider_name: string) => ({ provider_name, display_name: provider_name, is_test: false, currencies: ['USD', 'EUR'] });

beforeEach(() => {
  gatewayRows = [];
  lemonStoreCurrency = 'USD';
  pendingIntentRows = [];
  supersededRows = [];
  planRows = [];
  closeCheckout.mockReset();
  createCheckout.mockReset();
  beginCollection.mockReset();
  beginCollection.mockResolvedValue({ collection_id: 'col-new', channel: 'gateway', amount_irr: 2900, expires_at: '', replayed: false });
  createCheckout.mockResolvedValue({ paymentUrl: 'https://checkout.stripe.com/x', sessionId: 'cs_new' });
});

describe('gateways offered for an invoice currency', () => {
  it('offers Lemon Squeezy only in the currency its store sells in', async () => {
    gatewayRows = [gateway('stripe'), gateway('lemon_squeezy')];
    const usd = await call('GET', `/api/billing/workspaces/${WS}/gateways?currency=USD`);
    expect((usd.body.gateways as Array<{ provider_name: string }>).map((g) => g.provider_name)).toEqual(['stripe', 'lemon_squeezy']);
    const eur = await call('GET', `/api/billing/workspaces/${WS}/gateways?currency=EUR`);
    expect((eur.body.gateways as Array<{ provider_name: string }>).map((g) => g.provider_name)).toEqual(['stripe']);

    lemonStoreCurrency = 'EUR';
    const eurStore = await call('GET', `/api/billing/workspaces/${WS}/gateways?currency=EUR`);
    expect((eurStore.body.gateways as Array<{ provider_name: string }>).map((g) => g.provider_name)).toEqual(['stripe', 'lemon_squeezy']);
  });

  it('refuses a Lemon Squeezy checkout for an invoice in another currency than its store’s', async () => {
    gatewayRows = [gateway('lemon_squeezy')];
    lemonStoreCurrency = 'EUR';
    const res = await call('POST', `/api/billing/workspaces/${WS}/invoices/${INVOICE}/checkout`, {
      callbackUrl: 'https://app.test/acme/billing/pay/invoice/inv-1',
      providerName: 'lemon_squeezy',
    });
    expect(res.status).toBe(400);
    expect(createCheckout).not.toHaveBeenCalled();
  });
});

describe('a new checkout supersedes the previous one', () => {
  it('closes the previous provider checkout once the new one holds the invoice', async () => {
    gatewayRows = [gateway('stripe')];
    pendingIntentRows = [{ id: 'pi-old', provider_ref: 'cs_old' }, { id: 'pi-unbound', provider_ref: null }];
    supersededRows = [
      { id: 'pi-old', provider_name: 'stripe', provider_ref: 'cs_old', status: 'canceled', failure_reason: 'superseded_by_new_checkout' },
    ];
    closeCheckout.mockResolvedValue(true);
    const res = await call('POST', `/api/billing/workspaces/${WS}/invoices/${INVOICE}/checkout`, {
      callbackUrl: 'https://app.test/acme/billing/pay/invoice/inv-1',
      providerName: 'stripe',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, intentId: 'pi-new' });
    await vi.waitFor(() => expect(closeCheckout).toHaveBeenCalledTimes(1));
    expect(closeCheckout.mock.calls[0][0]).toBe('stripe');
    expect(closeCheckout.mock.calls[0][2]).toBe('cs_old');
    // Closed only after the new attempt held the invoice (which is what supersedes the old one).
    expect(beginCollection.mock.invocationCallOrder[0]).toBeLessThan(closeCheckout.mock.invocationCallOrder[0]);
  });

  it('a provider that cannot close the old checkout never fails the new one', async () => {
    gatewayRows = [gateway('stripe')];
    pendingIntentRows = [{ id: 'pi-old', provider_ref: 'cs_old' }];
    supersededRows = [
      { id: 'pi-old', provider_name: 'stripe', provider_ref: 'cs_old', status: 'canceled', failure_reason: 'superseded_by_new_checkout' },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    closeCheckout.mockRejectedValue(new Error('stripe down'));
    const res = await call('POST', `/api/billing/workspaces/${WS}/invoices/${INVOICE}/checkout`, {
      callbackUrl: 'https://app.test/acme/billing/pay/invoice/inv-1',
      providerName: 'stripe',
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('a checkout that could not reserve the invoice closes nothing', async () => {
    gatewayRows = [gateway('stripe')];
    pendingIntentRows = [{ id: 'pi-old', provider_ref: 'cs_old' }];
    const { InvoiceSettlementError } = await import('../../../server/services/billing/invoice/settle.js');
    beginCollection.mockRejectedValue(new InvoiceSettlementError('collection_locked', 'invoice_collection_locked', 409));
    const res = await call('POST', `/api/billing/workspaces/${WS}/invoices/${INVOICE}/checkout`, {
      callbackUrl: 'https://app.test/acme/billing/pay/invoice/inv-1',
      providerName: 'stripe',
    });
    expect(res.status).toBe(409);
    expect(closeCheckout).not.toHaveBeenCalled();
  });
});

describe('the plan catalogue offers a plan only in a currency it is priced in', () => {
  type CatalogBody = {
    currency: string;
    currencies: string[];
    plans: Array<{ id: string; monthlyPriceIrr: number; yearlyPriceIrr: number }>;
  };
  const rows = (body: unknown) =>
    (body as CatalogBody).plans.map((p) => [p.id, p.monthlyPriceIrr, p.yearlyPriceIrr]);

  beforeEach(() => {
    gatewayRows = [gateway('zarinpal'), gateway('stripe')];
    planRows = [
      // Priced in USD only, with stale legacy Rial columns: never offered in IRR.
      { id: 'usd-only', name: 'Team', slug: 'team', prices: { USD: { monthly: 4900, yearly: 49000 } },
        price_monthly: 1_500_000, price_yearly: 15_000_000 },
      // A zero IRR price is no IRR price.
      { id: 'usd-irr0', name: 'Studio', slug: 'studio', prices: { IRR: { monthly: 0 }, USD: { monthly: 2900 } } },
      { id: 'both', name: 'Pro', slug: 'pro', prices: { IRR: { monthly: 3_000_000 }, USD: { monthly: 2900, yearly: 29000 } } },
      // A legacy row with no price map keeps its Rial flat columns.
      { id: 'legacy', name: 'Old', slug: 'old', prices: null, price_monthly: 700_000, price_yearly: 0 },
    ];
  });

  it('IRR: only the plans with an IRR price (or a legacy row), at that price', async () => {
    const res = await call('GET', `/api/billing/workspaces/${WS}/plans?currency=IRR`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ currency: 'IRR', currencies: ['IRR', 'USD'] });
    expect(rows(res.body)).toEqual([
      ['both', 3_000_000, 0],
      ['legacy', 700_000, 0],
    ]);
  });

  it('USD: the plans priced in USD, never a legacy row', async () => {
    const res = await call('GET', `/api/billing/workspaces/${WS}/plans?currency=USD`);
    expect(rows(res.body)).toEqual([
      ['usd-only', 4900, 49000],
      ['usd-irr0', 2900, 0],
      ['both', 2900, 29000],
    ]);
  });

  it('a currency no plan is priced in is not offered at all', async () => {
    planRows = planRows.filter((p) => p.id === 'usd-only');
    const res = await call('GET', `/api/billing/workspaces/${WS}/plans?currency=IRR`);
    expect(res.body).toMatchObject({ currency: 'USD', currencies: ['USD'] });
  });
});
