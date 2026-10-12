/**
 * Billing × edition (server/services/billing/edition.ts and its callers).
 *
 * International edition (RESPOK, region_mode multi): no Iranian gateway is
 * listed, resolved or offered, and nothing is payable in Rial. Iranian
 * edition (WebYar, region_mode iran): unchanged. (Billing v2's checkout,
 * wallet and finance report were removed in phase 7A; simple billing's own
 * edition rules are covered by src/test/billing/simple.)
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';

const state = vi.hoisted(() => ({
  edition: 'iran' as 'iran' | 'international' | 'unavailable',
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
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
vi.mock('../../../server/services/billing/callbackUrl.js', () => ({
  isAllowedBillingCallbackUrl: () => true,
  resolvePublicApiOrigin: async () => 'https://api.test',
}));

const { listPayableGateways } = await import('../../../server/services/billing/config/index.js');
const { resolveBillingConfig, resolveNamedBillingConfig, getAllProviders } = await import('../../../server/services/billing/index.js');
const { adminBillingRouter } = await import('../../../server/routes/adminBilling.js');

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
    billing_events: [],
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
app.use('/api/admin/billing', adminBillingRouter);
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

// ─── Super Admin ──────────────────────────────────────────────────────────

describe('Super Admin gateways', () => {
  it('International: gateways and providers hide Iran; writes naming them are refused', async () => {
    state.edition = 'international';
    const gw = await call('GET', '/api/admin/billing/gateways');
    const names = gw.body.gateways.map((g: { provider_name: string }) => g.provider_name);
    expect(names).toContain('stripe');
    for (const n of ['zarinpal', 'internal_test', 'idpay', 'sep_shaparak']) expect(names).not.toContain(n);
    expect((await call('PUT', '/api/admin/billing/gateways', { provider_name: 'zarinpal', is_active: true })).status).toBe(400);
    expect((await call('PUT', '/api/admin/billing/gateways', { provider_name: 'stripe', currencies: ['IRR'] })).status).toBe(400);
    expect((await call('GET', '/api/admin/billing/providers/zarinpal')).status).toBe(400);
  });

  it('Iran: gateways are listed as before', async () => {
    const gw = await call('GET', '/api/admin/billing/gateways');
    expect(gw.body.gateways.map((g: { provider_name: string }) => g.provider_name)).toEqual(
      expect.arrayContaining(['zarinpal', 'internal_test', 'stripe']),
    );
  });
});
