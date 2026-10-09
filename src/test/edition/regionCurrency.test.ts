/**
 * Region currency (shared/edition.ts editionCurrencyFor), the owner's rule:
 *   - iran   → IRR (Toman), exactly as before;
 *   - turkey → TRY (a Turkish-only site sells in Turkish Lira);
 *   - multi, global → USD for EVERY language, Turkish and Persian included.
 * Covers the plan catalogue (and its currency picking), the public plan list,
 * checkout defaults and the finance report, for all four region modes.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';

const state = vi.hoisted(() => ({
  mode: 'iran' as 'iran' | 'turkey' | 'multi' | 'global',
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  invoice: null as Record<string, unknown> | null,
}));

vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/platformRegion.js')>();
  return {
    ...actual,
    getPlatformEdition: async () => (state.mode === 'iran' ? 'iran' : 'international'),
    getPlatformRegionMode: async () => state.mode,
  };
});

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

const { pickCatalogCurrency, catalogOffersCurrency, billingCustomerRouter } = await import('../../../server/routes/billingCustomer.js');
const { billingRouter } = await import('../../../server/routes/billing.js');
const { resolveEditionCurrency, billingEditionCurrency } = await import('../../../server/services/billing/edition.js');
const { editionCurrencyFor, currencyForEditionRegion, regionPinsCurrency } = await import('../../../shared/edition.js');

const cfg = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' } as never;

const PLANS = [
  { id: 'p-pro', name: 'Pro', slug: 'pro', is_active: true, is_hidden: false, sort_order: 1,
    prices: { IRR: { monthly: 15_000_000, yearly: 150_000_000 }, USD: { monthly: 2900, yearly: 29000 }, TRY: { monthly: 99_900, yearly: 999_000 } },
    limits: { ai_credits_per_month: 5000 } },
  { id: 'p-rial', name: 'Rial only', slug: 'rial', is_active: true, is_hidden: false, sort_order: 2,
    prices: { IRR: { monthly: 5_000_000, yearly: 50_000_000 } }, limits: {} },
];

beforeEach(() => {
  state.mode = 'iran';
  state.inserts = [];
  state.invoice = null;
  state.tables = {
    billing_gateways: [
      { provider_name: 'zarinpal', is_active: true, is_test: false, currencies: ['IRR'], countries: [], sort_order: 1, display_name: { fa: 'زرین‌پال' }, config: {} },
      { provider_name: 'internal_test', is_active: true, is_test: true, currencies: ['IRR'], countries: [], sort_order: 2, display_name: {}, config: {} },
      { provider_name: 'stripe', is_active: true, is_test: false, currencies: ['USD', 'EUR', 'TRY'], countries: [], sort_order: 3, display_name: { en: 'Stripe' }, config: {} },
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
      { id: 'pay-try', status: 'succeeded', amount: 99_900, currency: 'TRY', provider_name: 'stripe', plan_id: 'p-pro', created_at: new Date().toISOString(), paid_at: new Date().toISOString(), workspace_id: WS },
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

const MODES = ['iran', 'turkey', 'multi', 'global'] as const;
const LOCALES = ['fa', 'en', 'tr'] as const;

// ─── The shared rule ──────────────────────────────────────────────────────

describe('shared/edition.ts — the currency of each region', () => {
  it('iran IRR, turkey TRY, multi and global USD; unknown or missing reads as multi', () => {
    expect(MODES.map((m) => editionCurrencyFor(m))).toEqual(['IRR', 'TRY', 'USD', 'USD']);
    expect(editionCurrencyFor(null)).toBe('USD');
    expect(editionCurrencyFor('mars')).toBe('USD');
  });

  it('the edition wins: never IRR outside Iran, always IRR in it', () => {
    expect(currencyForEditionRegion('international', 'iran')).toBe('USD');
    expect(currencyForEditionRegion('international', 'turkey')).toBe('TRY');
    expect(currencyForEditionRegion('iran', 'multi')).toBe('IRR');
  });

  it('only multi and global pin the catalogue to their currency', () => {
    expect(MODES.map((m) => regionPinsCurrency(m))).toEqual([false, false, true, true]);
  });
});

describe('pickCatalogCurrency × region × locale', () => {
  const sellable = ['IRR', 'USD', 'TRY'];
  it.each(LOCALES)('locale %s: iran → its locale rule (Persian Rial), turkey → TRY, multi/global → USD', (locale) => {
    expect(pickCatalogCurrency(sellable, { locale, edition: 'iran', regionMode: 'iran' })).toBe(
      locale === 'fa' ? 'IRR' : locale === 'tr' ? 'TRY' : 'USD',
    );
    const intl = sellable.filter((c) => c !== 'IRR');
    expect(pickCatalogCurrency(intl, { locale, edition: 'international', regionMode: 'turkey' })).toBe('TRY');
    expect(pickCatalogCurrency(intl, { locale, edition: 'international', regionMode: 'multi' })).toBe('USD');
    expect(pickCatalogCurrency(intl, { locale, edition: 'international', regionMode: 'global' })).toBe('USD');
  });

  it('Iran without a region mode: exactly the rule from before editions', () => {
    expect(pickCatalogCurrency(['IRR', 'USD', 'TRY'], { locale: 'tr' })).toBe('TRY');
    expect(pickCatalogCurrency(['IRR', 'USD'], { locale: 'fa' })).toBe('IRR');
    expect(pickCatalogCurrency([], {})).toBe('IRR');
  });

  it('an explicit choice or a running subscription still wins when offered', () => {
    expect(pickCatalogCurrency(['USD', 'TRY'], { requested: 'TRY', edition: 'international', regionMode: 'multi' })).toBe('TRY');
    expect(pickCatalogCurrency(['USD', 'TRY'], { subscription: 'TRY', edition: 'international', regionMode: 'multi' })).toBe('TRY');
  });

  it('catalogOffersCurrency: multi/global offer USD (plus a running subscription currency) only', () => {
    for (const regionMode of ['multi', 'global'] as const) {
      expect(catalogOffersCurrency('USD', { edition: 'international', regionMode })).toBe(true);
      expect(catalogOffersCurrency('TRY', { edition: 'international', regionMode })).toBe(false);
      expect(catalogOffersCurrency('EUR', { edition: 'international', regionMode })).toBe(false);
      expect(catalogOffersCurrency('TRY', { edition: 'international', regionMode, subscription: 'TRY' })).toBe(true);
    }
    expect(catalogOffersCurrency('USD', { edition: 'international', regionMode: 'turkey' })).toBe(true);
    expect(catalogOffersCurrency('TRY', { edition: 'international', regionMode: 'turkey' })).toBe(true);
    expect(catalogOffersCurrency('IRR', { edition: 'iran', regionMode: 'iran' })).toBe(true);
    expect(catalogOffersCurrency('TRY', { edition: 'iran', regionMode: 'iran' })).toBe(true);
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────

describe('GET /workspaces/:id/plans — the plan catalogue, every region × locale', () => {
  const expected = {
    iran: { fa: 'IRR', en: 'USD', tr: 'TRY' },
    turkey: { fa: 'TRY', en: 'TRY', tr: 'TRY' },
    multi: { fa: 'USD', en: 'USD', tr: 'USD' },
    global: { fa: 'USD', en: 'USD', tr: 'USD' },
  } as const;
  const offered = {
    iran: ['IRR', 'USD', 'TRY'],
    turkey: ['TRY', 'USD'],
    multi: ['USD'],
    global: ['USD'],
  } as const;

  for (const mode of MODES) {
    for (const locale of LOCALES) {
      it(`${mode} / ${locale} → ${expected[mode][locale]}`, async () => {
        state.mode = mode;
        const r = await call('GET', `/api/billing/workspaces/${WS}/plans?locale=${locale}`);
        expect(r.status).toBe(200);
        expect(r.body.currency).toBe(expected[mode][locale]);
        expect([...r.body.currencies].sort()).toEqual([...offered[mode]].sort());
        expect(r.body.plans.every((p: { currency: string }) => p.currency === expected[mode][locale])).toBe(true);
      });
    }
  }

  it('Multi Region: a request for Lira is not honoured (USD for every language)', async () => {
    state.mode = 'multi';
    const r = await call('GET', `/api/billing/workspaces/${WS}/plans?locale=tr&currency=TRY`);
    expect(r.body).toMatchObject({ currency: 'USD', currencies: ['USD'] });
  });

  it('Turkey: the customer may still switch to another sellable non-Rial currency', async () => {
    state.mode = 'turkey';
    const r = await call('GET', `/api/billing/workspaces/${WS}/plans?locale=tr&currency=USD`);
    expect(r.body.currency).toBe('USD');
  });

  it('Iran: the Persian catalogue is Rial with every sellable currency — exactly as before', async () => {
    const r = await call('GET', `/api/billing/workspaces/${WS}/plans?locale=fa`);
    expect(r.body.currency).toBe('IRR');
    expect(r.body.currencies).toEqual(['IRR', 'USD', 'TRY']);
    expect(r.body.plans.map((p: { id: string; monthlyPriceIrr: number }) => [p.id, p.monthlyPriceIrr])).toEqual([
      ['p-pro', 15_000_000],
      ['p-rial', 5_000_000],
    ]);
  });
});

describe('GET /workspaces/:id/gateways — default currency per region', () => {
  it.each([
    ['iran', 'IRR'],
    ['turkey', 'TRY'],
    ['multi', 'USD'],
    ['global', 'USD'],
  ] as const)('%s → %s', async (mode, currency) => {
    state.mode = mode;
    const r = await call('GET', `/api/billing/workspaces/${WS}/gateways`);
    expect(r.body.currency).toBe(currency);
  });
});

describe('GET /plans — the public plan list, every region × locale', () => {
  it.each(MODES)('%s', async (mode) => {
    state.mode = mode;
    for (const locale of LOCALES) {
      const r = await call('GET', `/api/billing/plans?locale=${locale}`);
      expect(r.status).toBe(200);
      const pro = r.body.plans.find((p: { id: string }) => p.id === 'p-pro');
      const want =
        mode === 'iran' ? (locale === 'fa' ? 'IRR' : locale === 'tr' ? 'TRY' : 'USD') : mode === 'turkey' ? 'TRY' : 'USD';
      expect(pro.displayCurrency, `${mode}/${locale}`).toBe(want);
      expect(pro.displayPrice, `${mode}/${locale}`).toEqual(PLANS[0].prices[want as 'IRR' | 'USD' | 'TRY']);
    }
  });
});

describe('documents and checkout default to the region currency', () => {
  it.each([
    ['iran', 'IRR'],
    ['turkey', 'TRY'],
    ['multi', 'USD'],
    ['global', 'USD'],
  ] as const)('%s → %s', async (mode, currency) => {
    state.mode = mode;
    expect(await billingEditionCurrency(cfg)).toBe(currency);
    expect(await resolveEditionCurrency(cfg, null)).toBe(currency);
    // An explicit, edition-allowed currency is kept.
    expect(await resolveEditionCurrency(cfg, 'eur')).toBe('EUR');
  });
});

describe('the finance report is in the region currency', () => {
  it.each([
    ['iran', 'IRR'],
    ['turkey', 'TRY'],
    ['multi', 'USD'],
    ['global', 'USD'],
  ] as const)('%s → %s', async (mode, currency) => {
    state.mode = mode;
    state.tables.workspace_subscriptions = [{ workspace_id: WS, plan_id: 'p-pro', status: 'active', billing_interval: 'monthly' }];
    const r = await call('GET', '/api/billing/admin/finance-report');
    expect(r.status).toBe(200);
    expect(r.body.currency).toBe(currency);
    const price = PLANS[0].prices[currency as 'IRR' | 'USD' | 'TRY'].monthly;
    expect(r.body.totals.mrrIrr).toBe(price);
    if (mode === 'iran') {
      // As before: every payment counted.
      expect(r.body.totals.paymentCount).toBe(3);
    } else {
      expect(r.body.totals.grossRevenue).toBe(currency === 'TRY' ? 99_900 : 2900);
      expect(r.body.totals.paymentCount).toBe(1);
    }
  });
});
