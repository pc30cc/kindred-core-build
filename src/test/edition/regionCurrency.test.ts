/**
 * Region currency (shared/edition.ts editionCurrencyFor), the owner's rule:
 *   - iran   → IRR (Toman), exactly as before;
 *   - turkey → TRY (a Turkish-only site sells in Turkish Lira);
 *   - multi, global → USD for EVERY language, Turkish and Persian included.
 * Covers the public plan list and the billing currency of each edition, for
 * all four region modes. (Billing v2's workspace catalogue, checkout and
 * finance report were removed in phase 7A.)
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';

const state = vi.hoisted(() => ({
  mode: 'iran' as 'iran' | 'turkey' | 'multi' | 'global',
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
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
vi.mock('../../../server/services/billing/callbackUrl.js', () => ({
  isAllowedBillingCallbackUrl: () => true,
  resolvePublicApiOrigin: async () => 'https://api.test',
}));

const { billingRouter } = await import('../../../server/routes/billing.js');
const { billingEditionCurrency } = await import('../../../server/services/billing/edition.js');
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

describe('billing defaults to the region currency', () => {
  it.each([
    ['iran', 'IRR'],
    ['turkey', 'TRY'],
    ['multi', 'USD'],
    ['global', 'USD'],
  ] as const)('%s → %s', async (mode, currency) => {
    state.mode = mode;
    expect(await billingEditionCurrency(cfg)).toBe(currency);
  });
});
