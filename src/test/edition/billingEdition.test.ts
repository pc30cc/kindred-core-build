/**
 * Billing × edition (server/services/billing/edition.ts and its callers).
 *
 * International edition (RESPOK, region_mode multi): no Iranian gateway is
 * listed, resolved or charged; nothing is priced or collected in Rial; the
 * Rial wallet and AI-credit top-up answer "not available"; the finance
 * report is USD. Iranian edition (WebYar, region_mode iran): unchanged.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';

const state = vi.hoisted(() => ({
  edition: 'iran' as 'iran' | 'international' | 'unavailable',
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  invoice: null as Record<string, unknown> | null,
}));

vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/platformRegion.js')>();
  return {
    ...actual,
    getPlatformEdition: async () => {
      if (state.edition === 'unavailable') throw new actual.EditionUnavailableError();
      return state.edition;
    },
  };
});

// Billing v2's customer mutations answer 410 while v2 is retired
// (server/middleware/billingV2Retired.ts); this suite covers them with v2 on.
vi.mock('../../../shared/billingMode.js', () => ({ LEGACY_BILLING_ENABLED: true }));

/** A tiny PostgREST-shaped fake: filters by eq/in/neq over `state.tables`. */
function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      let pendingInsert: Record<string, unknown> | null = null;
      const rows = () => (state.tables[table] || []).filter((r) => filters.every((f) => f(r)));
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'limit', 'range', 'gte', 'ilike', 'update']) b[m] = () => b;
      b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
      b.neq = (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b);
      b.in = (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b);
      b.insert = (row: Record<string, unknown>) => {
        pendingInsert = row;
        state.inserts.push({ table, row });
        return b;
      };
      b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      b.single = async () => ({ data: pendingInsert ? { id: 'new-row', ...pendingInsert } : rows()[0] ?? null, error: null });
      b.then = (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null, count: rows().length });
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/lib/serviceClient.js', () => ({ serviceClientFor: () => fakeClient() }));
vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: 'u1', isAdmin: false, role: 'owner' }),
  requirePlatformAdmin: async () => 'admin-1',
  requireUser: async () => 'u1',
  serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
}));
vi.mock('../../../server/services/billing/invoice/settle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/invoice/settle.js')>()),
  getInvoice: async () => state.invoice,
  beginCollection: async () => ({ collection_id: 'col-1' }),
  releaseCollection: async () => undefined,
}));
vi.mock('../../../server/services/billing/callbackUrl.js', () => ({
  isAllowedBillingCallbackUrl: () => true,
  resolvePublicApiOrigin: async () => 'https://api.test',
}));

const { listPayableGateways } = await import('../../../server/services/billing/config/index.js');
const { resolveBillingConfig, resolveNamedBillingConfig, getAllProviders } = await import('../../../server/services/billing/index.js');
const { createInvoiceIntent, createWalletDepositIntent, createAiCreditTopupIntent } = await import('../../../server/services/billing/paymentIntent.js');
const { pickCatalogCurrency, billingCustomerRouter } = await import('../../../server/routes/billingCustomer.js');
const { billingRouter } = await import('../../../server/routes/billing.js');
const { adminBillingRouter } = await import('../../../server/routes/adminBilling.js');
const { aiBillingRouter } = await import('../../../server/routes/aiBilling.js');

const cfg = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' } as never;

const PLANS = [
  { id: 'p-pro', name: 'Pro', slug: 'pro', is_active: true, is_hidden: false, sort_order: 1,
    prices: { IRR: { monthly: 15_000_000, yearly: 150_000_000 }, USD: { monthly: 2900, yearly: 29000 } },
    limits: { ai_credits_per_month: 5000 } },
  { id: 'p-rial', name: 'Rial only', slug: 'rial', is_active: true, is_hidden: false, sort_order: 2,
    prices: { IRR: { monthly: 5_000_000, yearly: 50_000_000 } }, limits: {} },
];

beforeEach(() => {
  state.edition = 'iran';
  state.inserts = [];
  state.invoice = null;
  state.tables = {
    billing_gateways: [
      { provider_name: 'zarinpal', is_active: true, is_test: false, currencies: ['IRR'], countries: [], sort_order: 1, display_name: { fa: 'زرین‌پال' }, config: {} },
      { provider_name: 'internal_test', is_active: true, is_test: true, currencies: ['IRR'], countries: [], sort_order: 2, display_name: {}, config: {} },
      { provider_name: 'stripe', is_active: true, is_test: false, currencies: ['USD', 'EUR'], countries: [], sort_order: 3, display_name: { en: 'Stripe' }, config: {} },
    ],
    app_runtime_config: [{ key: 'default_billing_provider', value: { provider_name: 'zarinpal', config: { merchant_id: 'm' } }, updated_at: '2026-01-01' }],
    provider_configs: [],
    billing_provider_credentials: [],
    billing_plans: PLANS,
    workspace_subscriptions: [],
    billing_subscription_periods: [],
    billing_payments: [
      { id: 'pay-irr', status: 'succeeded', amount: 15_000_000, currency: 'IRR', provider_name: 'zarinpal', plan_id: 'p-pro', created_at: new Date().toISOString(), paid_at: new Date().toISOString(), workspace_id: WS },
      { id: 'pay-usd', status: 'succeeded', amount: 2900, currency: 'USD', provider_name: 'stripe', plan_id: 'p-pro', created_at: new Date().toISOString(), paid_at: new Date().toISOString(), workspace_id: WS },
    ],
    billing_payment_intents: [
      { id: 'pi-1', status: 'succeeded', metadata: { currency: 'IRR' }, created_at: new Date().toISOString() },
      { id: 'pi-2', status: 'succeeded', metadata: { currency: 'USD' }, created_at: new Date().toISOString() },
    ],
    billing_events: [
      { id: 'ev-1', provider_name: 'zarinpal', currency: 'IRR', amount: 1 },
      { id: 'ev-2', provider_name: 'stripe', currency: null, amount: null },
    ],
    billing_currencies: [
      { code: 'IRR', is_base: true, is_active: true, sort_order: 1 },
      { code: 'USD', is_base: false, is_active: true, sort_order: 2 },
    ],
    workspaces: [{ id: WS, name: 'Acme' }],
  };
});

// ─── HTTP harness ─────────────────────────────────────────────────────────
const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' };
  next();
});
app.use(express.json());
app.use('/api/billing', billingCustomerRouter);
app.use('/api/billing', billingRouter);
app.use('/api/admin/billing', adminBillingRouter);
app.use('/api/ai-billing', aiBillingRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

// Response bodies are free-form JSON read field by field below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: (server.address() as { port: number }).port, path, method, headers: { 'content-type': 'application/json', connection: 'close' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data ? JSON.parse(data) : {} }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Services ─────────────────────────────────────────────────────────────

describe('payable gateways', () => {
  it('Iran: unchanged — Iranian gateways collect IRR', async () => {
    expect((await listPayableGateways(cfg, 'IRR')).map((g) => g.provider_name)).toEqual(['zarinpal', 'internal_test']);
    expect((await listPayableGateways(cfg, 'USD')).map((g) => g.provider_name)).toEqual(['stripe']);
  });

  it('International: no Iranian gateway, and nothing is payable in Rial', async () => {
    state.edition = 'international';
    expect(await listPayableGateways(cfg, 'IRR')).toEqual([]);
    expect((await listPayableGateways(cfg, 'USD')).map((g) => g.provider_name)).toEqual(['stripe']);
    state.tables.billing_gateways[0].currencies = []; // "any currency" still is not Rial-capable here
    expect((await listPayableGateways(cfg, 'USD')).map((g) => g.provider_name)).toEqual(['stripe']);
  });

  it('fails (503) rather than guess when the edition is unknown', async () => {
    state.edition = 'unavailable';
    await expect(listPayableGateways(cfg, 'USD')).rejects.toMatchObject({ status: 503 });
  });

  it('lists providers per edition', () => {
    expect(Object.keys(getAllProviders('iran'))).toContain('zarinpal');
    expect(Object.keys(getAllProviders())).toContain('zarinpal');
    const intl = Object.keys(getAllProviders('international'));
    expect(intl).toEqual(expect.arrayContaining(['stripe', 'paypal', 'paddle', 'lemon_squeezy']));
    for (const name of ['zarinpal', 'idpay', 'sep_shaparak', 'internal_test', 'payping', 'zibal', 'nextpay']) expect(intl).not.toContain(name);
  });
});

describe('provider resolution', () => {
  it('Iran: the Iranian default still resolves', async () => {
    expect((await resolveBillingConfig('u', 'k', WS))?.provider.name).toBe('zarinpal');
    expect((await resolveNamedBillingConfig('u', 'k', WS, 'zarinpal'))?.provider.name).toBe('zarinpal');
  });

  it('International: an Iranian default or named gateway never resolves', async () => {
    state.edition = 'international';
    expect(await resolveBillingConfig('u', 'k', WS)).toBeNull();
    expect(await resolveNamedBillingConfig('u', 'k', WS, 'zarinpal')).toBeNull();
    expect(await resolveNamedBillingConfig('u', 'k', WS, 'internal_test')).toBeNull();
    expect((await resolveNamedBillingConfig('u', 'k', WS, 'stripe'))?.provider.name).toBe('stripe');
  });
});

describe('payment intents', () => {
  const base = { workspaceId: WS, invoiceId: 'inv-1', amountIrr: 2900 };

  it('International: refuses an Iranian gateway or Rial with a clear 4xx error', async () => {
    state.edition = 'international';
    await expect(createInvoiceIntent(cfg, { ...base, providerName: 'stripe', currency: 'IRR' })).rejects.toMatchObject({
      status: 400, code: 'CURRENCY_NOT_AVAILABLE_IN_EDITION',
    });
    await expect(createInvoiceIntent(cfg, { ...base, providerName: 'zarinpal', currency: 'USD' })).rejects.toMatchObject({
      status: 400, code: 'PROVIDER_NOT_AVAILABLE_IN_EDITION',
    });
    await expect(
      createWalletDepositIntent(cfg, { workspaceId: WS, depositId: 'd', documentNumber: 'n', amountIrr: 1, providerName: 'zarinpal' }),
    ).rejects.toMatchObject({ status: 403, code: 'FEATURE_NOT_AVAILABLE_IN_EDITION' });
    await expect(
      createAiCreditTopupIntent(cfg, { workspaceId: WS, amountIrr: 1, providerName: 'zarinpal' }),
    ).rejects.toMatchObject({ status: 403, code: 'FEATURE_NOT_AVAILABLE_IN_EDITION' });
    expect(state.inserts).toEqual([]);
  });

  it('International: an invoice intent without a currency is USD', async () => {
    state.edition = 'international';
    await createInvoiceIntent(cfg, { ...base, providerName: 'stripe' });
    expect(state.inserts[0].row.metadata).toMatchObject({ currency: 'USD' });
  });

  it('Iran: unchanged — no currency means IRR and Iranian gateways are accepted', async () => {
    await createInvoiceIntent(cfg, { ...base, providerName: 'zarinpal' });
    expect(state.inserts[0].row.metadata).toMatchObject({ currency: 'IRR' });
    await createWalletDepositIntent(cfg, { workspaceId: WS, depositId: 'd', documentNumber: 'n', amountIrr: 1, providerName: 'zarinpal' });
    expect(state.inserts.map((i) => i.table)).toEqual(['billing_payment_intents', 'billing_payment_intents']);
  });
});

describe('pickCatalogCurrency', () => {
  it('Iran (the default): Persian reads Rial, the fallback is Rial — as before', () => {
    expect(pickCatalogCurrency(['IRR', 'USD'], { locale: 'fa' })).toBe('IRR');
    expect(pickCatalogCurrency(['IRR', 'USD'], { locale: 'fa', edition: 'iran' })).toBe('IRR');
    expect(pickCatalogCurrency([], {})).toBe('IRR');
  });

  it('International: Persian reads USD, the fallback is USD', () => {
    expect(pickCatalogCurrency(['USD', 'TRY'], { locale: 'fa', edition: 'international' })).toBe('USD');
    expect(pickCatalogCurrency([], { edition: 'international' })).toBe('USD');
  });
});

// ─── Customer routes ──────────────────────────────────────────────────────

describe('customer billing routes', () => {
  it('Iran: the gateway list defaults to IRR and lists the Iranian gateways', async () => {
    const r = await call('GET', `/api/billing/workspaces/${WS}/gateways`);
    expect(r.status).toBe(200);
    expect(r.body.currency).toBe('IRR');
    expect(r.body.gateways.map((g: { provider_name: string }) => g.provider_name)).toEqual(['zarinpal', 'internal_test']);
  });

  it('International: the gateway list defaults to USD and never lists an Iranian gateway', async () => {
    state.edition = 'international';
    const r = await call('GET', `/api/billing/workspaces/${WS}/gateways`);
    expect(r.body).toMatchObject({ currency: 'USD' });
    expect(r.body.gateways.map((g: { provider_name: string }) => g.provider_name)).toEqual(['stripe']);
    const rial = await call('GET', `/api/billing/workspaces/${WS}/gateways?currency=IRR`);
    expect(rial.body.gateways).toEqual([]);
  });

  it('503 when the edition cannot be read', async () => {
    state.edition = 'unavailable';
    const r = await call('GET', `/api/billing/workspaces/${WS}/gateways`);
    expect(r).toMatchObject({ status: 503, body: { error: 'EDITION_UNAVAILABLE' } });
  });

  it('Iran: the plan catalogue in Persian is Rial, with every sellable currency', async () => {
    const r = await call('GET', `/api/billing/workspaces/${WS}/plans?locale=fa`);
    expect(r.status).toBe(200);
    expect(r.body.currency).toBe('IRR');
    expect(r.body.currencies).toEqual(['IRR', 'USD']);
    expect(r.body.plans.map((p: { id: string }) => p.id)).toEqual(['p-pro', 'p-rial']);
  });

  it('International: the plan catalogue in Persian is USD; Rial is never offered', async () => {
    state.edition = 'international';
    for (const query of ['locale=fa', 'locale=fa&currency=IRR', 'locale=en']) {
      const r = await call('GET', `/api/billing/workspaces/${WS}/plans?${query}`);
      expect(r.status, query).toBe(200);
      expect(r.body.currency, query).toBe('USD');
      expect(r.body.currencies, query).toEqual(['USD']);
      expect(r.body.plans.map((p: { id: string; monthlyPriceIrr: number }) => [p.id, p.monthlyPriceIrr]), query).toEqual([['p-pro', 2900]]);
    }
  });

  it('International: a Rial invoice or an Iranian gateway cannot be checked out', async () => {
    state.edition = 'international';
    state.invoice = { id: 'inv-1', workspace_id: WS, status: 'open', amount_due_irr: 15_000_000, currency: 'IRR', invoice_number: 'A1' };
    const rial = await call('POST', `/api/billing/workspaces/${WS}/invoices/inv-1/checkout`, { callbackUrl: 'https://app.test/pay' });
    expect(rial).toMatchObject({ status: 400, body: { error: 'CURRENCY_NOT_AVAILABLE_IN_EDITION' } });

    state.invoice = { ...state.invoice, amount_due_irr: 2900, currency: 'USD' };
    const iranian = await call('POST', `/api/billing/workspaces/${WS}/invoices/inv-1/checkout`, {
      callbackUrl: 'https://app.test/pay', providerName: 'zarinpal',
    });
    expect(iranian).toMatchObject({ status: 400, body: { error: 'PROVIDER_NOT_AVAILABLE_IN_EDITION' } });
    expect(state.inserts).toEqual([]);
  });

  it('International: the Rial wallet and AI-credit top-up are not available', async () => {
    state.edition = 'international';
    const paths: Array<[string, string, unknown?]> = [
      ['GET', `/api/billing/workspaces/${WS}/wallet`],
      ['PUT', `/api/billing/workspaces/${WS}/wallet/auto-pay`, { enabled: true }],
      ['POST', `/api/billing/workspaces/${WS}/wallet/deposit/invoice`, { amountIrr: 5_000_000 }],
      ['POST', `/api/billing/workspaces/${WS}/wallet/deposit/preview`, { amountIrr: 5_000_000 }],
      ['POST', `/api/billing/workspaces/${WS}/invoices/inv-1/pay-wallet`],
      ['POST', `/api/billing/workspaces/${WS}/ai-credit/invoice`, { amountIrr: 1_000_000 }],
      ['GET', `/api/ai-billing/workspaces/${WS}/topup/config`],
      ['POST', `/api/ai-billing/workspaces/${WS}/topup/preview`, { amountToman: 100_000 }],
      ['POST', `/api/ai-billing/workspaces/${WS}/topup/checkout`, { amountToman: 100_000, callbackUrl: 'https://app.test/x' }],
    ];
    for (const [method, path, body] of paths) {
      const r = await call(method, path, body);
      expect(r.status, path).toBe(403);
      expect(r.body.error, path).toBe('FEATURE_NOT_AVAILABLE_IN_EDITION');
    }
    expect(state.inserts).toEqual([]);
  });

  it('Iran: the AI top-up config still answers in Toman', async () => {
    const r = await call('GET', `/api/ai-billing/workspaces/${WS}/topup/config`);
    expect(r).toMatchObject({ status: 200, body: { currency: 'IRR', displayCurrency: 'TOMAN' } });
  });
});

// ─── Super Admin ──────────────────────────────────────────────────────────

describe('Super Admin finance', () => {
  it('Iran: the finance report is Rial, MRR from the IRR price, every payment counted — as before', async () => {
    state.tables.workspace_subscriptions = [{ workspace_id: WS, plan_id: 'p-pro', status: 'active', billing_interval: 'monthly' }];
    const r = await call('GET', '/api/billing/admin/finance-report');
    expect(r.status).toBe(200);
    expect(r.body.currency).toBe('IRR');
    expect(r.body.totals).toMatchObject({ grossRevenue: 15_002_900, paymentCount: 2, attempts: 2, mrrIrr: 15_000_000 });
  });

  it('International: the finance report is USD — USD prices and USD money only', async () => {
    state.edition = 'international';
    state.tables.workspace_subscriptions = [{ workspace_id: WS, plan_id: 'p-pro', status: 'active', billing_interval: 'yearly' }];
    const r = await call('GET', '/api/billing/admin/finance-report');
    expect(r.status).toBe(200);
    expect(r.body.currency).toBe('USD');
    expect(r.body.totals).toMatchObject({ grossRevenue: 2900, paymentCount: 1, attempts: 1, mrrIrr: Math.round(29000 / 12), arrIrr: Math.round(29000 / 12) * 12 });
    expect(r.body.byProvider.map((p: { provider: string }) => p.provider)).toEqual(['stripe']);
    expect(r.body.recentPayments.map((p: { id: string }) => p.id)).toEqual(['pay-usd']);
  });

  it('International: the billing overview hides Rial payments and Iranian gateway events', async () => {
    state.edition = 'international';
    const r = await call('GET', '/api/billing/admin/overview');
    expect(r.body.recentPayments.map((p: { id: string }) => p.id)).toEqual(['pay-usd']);
    expect(r.body.recentEvents.map((e: { id: string }) => e.id)).toEqual(['ev-2']);
    state.edition = 'iran';
    const iran = await call('GET', '/api/billing/admin/overview');
    expect(iran.body.recentPayments).toHaveLength(2);
    expect(iran.body.recentEvents).toHaveLength(2);
  });

  it('International: gateways, providers, currencies hide Iran; writes naming them are refused', async () => {
    state.edition = 'international';
    const gw = await call('GET', '/api/admin/billing/gateways');
    const names = gw.body.gateways.map((g: { provider_name: string }) => g.provider_name);
    expect(names).toContain('stripe');
    for (const n of ['zarinpal', 'internal_test', 'idpay', 'sep_shaparak']) expect(names).not.toContain(n);
    const cur = await call('GET', '/api/admin/billing/currencies');
    expect(cur.body.currencies.map((c: { code: string }) => c.code)).toEqual(['USD']);
    expect((await call('PUT', '/api/admin/billing/gateways', { provider_name: 'zarinpal', is_active: true })).status).toBe(400);
    expect((await call('PUT', '/api/admin/billing/gateways', { provider_name: 'stripe', currencies: ['IRR'] })).status).toBe(400);
    expect((await call('GET', '/api/admin/billing/providers/zarinpal')).status).toBe(400);
    expect((await call('PUT', '/api/admin/billing/currencies', { code: 'IRR', is_active: true })).status).toBe(400);
    const providers = await call('GET', '/api/billing/providers');
    expect(Object.keys(providers.body.providers)).not.toContain('zarinpal');
  });

  it('Iran: gateways and currencies are listed as before', async () => {
    const gw = await call('GET', '/api/admin/billing/gateways');
    expect(gw.body.gateways.map((g: { provider_name: string }) => g.provider_name)).toEqual(
      expect.arrayContaining(['zarinpal', 'internal_test', 'stripe']),
    );
    const cur = await call('GET', '/api/admin/billing/currencies');
    expect(cur.body.currencies.map((c: { code: string }) => c.code)).toEqual(['IRR', 'USD']);
    const providers = await call('GET', '/api/billing/providers');
    expect(Object.keys(providers.body.providers)).toContain('zarinpal');
  });
});
