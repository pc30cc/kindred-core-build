/**
 * The name customers see for a payment gateway is the Super Admin's
 * (Finance → Gateways → edit name; owner, 2026-10-30): PUT
 * /api/admin/billing/gateways stores it normalized, refuses one a customer
 * could not read, and GET lists it; `zibal_test` has a name before its row.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import { GATEWAY_NAME_MAX, normalizeGatewayDisplayName } from '../../../shared/simpleBillingAdmin';

const state = vi.hoisted(() => ({
  edition: 'iran' as 'iran' | 'international',
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/platformRegion.js')>();
  return { ...actual, getPlatformEdition: async () => state.edition };
});

function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      let upserted: Record<string, unknown> | null = null;
      const rows = () => (state.tables[table] || []).filter((r) => filters.every((f) => f(r)));
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'limit']) b[m] = () => b;
      b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
      b.upsert = (row: Record<string, unknown>) => {
        upserted = row;
        state.upserts.push({ table, row });
        return b;
      };
      b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      b.single = async () => ({ data: upserted ?? rows()[0] ?? null, error: null });
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
  requirePlatformAdmin: async () => 'admin-1',
}));

const { adminBillingRouter } = await import('../../../server/routes/adminBilling.js');

beforeEach(() => {
  state.edition = 'iran';
  state.upserts = [];
  state.tables = {
    billing_gateways: [
      { provider_name: 'zarinpal', is_active: true, is_test: false, currencies: ['IRR'], countries: [], sort_order: 1, display_name: { fa: 'زرین‌پال', en: 'ZarinPal', tr: 'ZarinPal' }, config: {} },
      { provider_name: 'zibal', is_active: false, is_test: false, currencies: ['IRR'], countries: [], sort_order: 3, display_name: { fa: 'زیبال', en: 'Zibal', tr: 'Zibal' }, config: {} },
    ],
    app_runtime_config: [],
  };
});

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' };
  next();
});
app.use(express.json());
app.use('/api/admin/billing', adminBillingRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request(
      { host: '127.0.0.1', port: (server.address() as { port: number }).port, path, method, headers: { 'content-type': 'application/json', connection: 'close' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data ? JSON.parse(data) : {} }));
      },
    );
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

describe('normalizeGatewayDisplayName', () => {
  it('trims, collapses white space and control characters, drops empty names, keeps ZWNJ', () => {
    expect(normalizeGatewayDisplayName({ fa: '  پرداخت‌آنلاین \n امن ', en: ' Online\tpayment ', tr: '   ' })).toEqual({
      names: { fa: 'پرداخت‌آنلاین امن', en: 'Online payment' },
    });
  });

  it('refuses no name at all, a name over the limit, and a language the panel does not have', () => {
    expect(normalizeGatewayDisplayName({ fa: ' ', en: '', tr: '\u0000' })).toEqual({ problem: 'GATEWAY_NAME_REQUIRED' });
    expect(normalizeGatewayDisplayName({})).toEqual({ problem: 'GATEWAY_NAME_REQUIRED' });
    expect(normalizeGatewayDisplayName(null)).toEqual({ problem: 'GATEWAY_NAME_REQUIRED' });
    expect(normalizeGatewayDisplayName(['Zibal'])).toEqual({ problem: 'GATEWAY_NAME_REQUIRED' });
    expect(normalizeGatewayDisplayName({ fa: 5 })).toEqual({ problem: 'GATEWAY_NAME_REQUIRED' });
    expect(normalizeGatewayDisplayName({ fa: 'x'.repeat(GATEWAY_NAME_MAX) })).toEqual({ names: { fa: 'x'.repeat(GATEWAY_NAME_MAX) } });
    expect(normalizeGatewayDisplayName({ fa: 'x'.repeat(GATEWAY_NAME_MAX + 1) })).toEqual({ problem: 'GATEWAY_NAME_TOO_LONG' });
    expect(normalizeGatewayDisplayName({ fa: 'زیبال', de: 'Zibal' })).toEqual({ problem: 'GATEWAY_NAME_LOCALE' });
  });
});

describe('PUT /api/admin/billing/gateways: display_name', () => {
  it('stores the Super Admin\'s name, normalized, and nothing else it was not sent', async () => {
    const r = await call('PUT', '/api/admin/billing/gateways', { provider_name: 'zibal', display_name: { fa: '  پرداخت آنلاین ', en: 'Online payment', tr: '' } });
    expect(r.status).toBe(200);
    expect(state.upserts).toEqual([{ table: 'billing_gateways', row: { provider_name: 'zibal', display_name: { fa: 'پرداخت آنلاین', en: 'Online payment' } } }]);
  });

  it('refuses a name a customer could not read, and writes nothing', async () => {
    for (const [display_name, error] of [
      [{ fa: '', en: ' ', tr: '' }, 'GATEWAY_NAME_REQUIRED'],
      [{ fa: 'x'.repeat(GATEWAY_NAME_MAX + 1) }, 'GATEWAY_NAME_TOO_LONG'],
      [{ ru: 'Zibal' }, 'GATEWAY_NAME_LOCALE'],
    ] as const) {
      const r = await call('PUT', '/api/admin/billing/gateways', { provider_name: 'zibal', display_name });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(error);
    }
    expect(state.upserts).toEqual([]);
  });

  it('a switch or currency change leaves the name alone', async () => {
    expect((await call('PUT', '/api/admin/billing/gateways', { provider_name: 'zibal', is_active: true })).status).toBe(200);
    expect(state.upserts[0].row).toEqual({ provider_name: 'zibal', is_active: true });
  });

  it('an Iranian gateway\'s name cannot be set in the International edition', async () => {
    state.edition = 'international';
    expect((await call('PUT', '/api/admin/billing/gateways', { provider_name: 'zibal', display_name: { en: 'Pay' } })).status).toBe(400);
    expect(state.upserts).toEqual([]);
  });
});

describe('GET /api/admin/billing/gateways', () => {
  it('lists the stored names, and zibal_test (no row yet) with its own name and the test marker', async () => {
    state.tables.billing_gateways[1].display_name = { fa: 'پرداخت آنلاین' };
    const r = await call('GET', '/api/admin/billing/gateways');
    expect(r.status).toBe(200);
    const byName = Object.fromEntries((r.body.gateways as Array<{ provider_name: string }>).map((g) => [g.provider_name, g]));
    expect(byName.zibal).toMatchObject({ display_name: { fa: 'پرداخت آنلاین' } });
    expect(byName.zibal_test).toMatchObject({ is_active: false, is_test: true, implemented: true, display_name: { fa: 'زیبال (تست)', en: 'Zibal (test)' } });
  });

  it('zibal_test switched on (its row has no name and no test marker) keeps both', async () => {
    state.tables.billing_gateways.push({ provider_name: 'zibal_test', is_active: true, is_test: false, currencies: [], countries: [], sort_order: 30, display_name: {}, config: {} });
    const r = await call('GET', '/api/admin/billing/gateways');
    const row = (r.body.gateways as Array<{ provider_name: string }>).find((g) => g.provider_name === 'zibal_test');
    expect(row).toMatchObject({ is_active: true, is_test: true, display_name: { en: 'Zibal (test)' } });
  });
});
