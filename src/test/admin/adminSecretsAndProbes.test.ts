/**
 * Super Admin routes that read stored settings or reach out on the admin's
 * behalf:
 *   admin-4 — a billing gateway's credentials never reach the browser, and a
 *             save that leaves one blank keeps it;
 *   admin-5 — the workspaces' provider configs come back without credentials;
 *   admin-6 — the JSON backup is written page by page and stays valid JSON;
 *   admin-8 — the widget URL test reaches only public https hosts, at every
 *             redirect.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const ADMIN = '99999999-9999-4999-8999-999999999999';

const store: {
  credentials: Record<string, Record<string, unknown>>;
  providerConfigs: Array<Record<string, unknown>>;
  tables: Record<string, unknown[]>;
} = { credentials: {}, providerConfigs: [], tables: {} };

function fakeClient() {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b;
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === 'provider_configs' ? store.providerConfigs : [], error: null });
      return b;
    },
    rpc: async (name: string, args: { _table: string; _limit: number; _offset: number }) => {
      if (name !== 'admin_export_table') return { data: null, error: null };
      const rows = store.tables[args._table] ?? [];
      return { data: rows.slice(args._offset, args._offset + args._limit), error: null };
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/lib/serviceClient.js', () => ({ serviceClientFor: () => fakeClient() }));
vi.mock('../../../server/lib/workspaceAuth.js', () => ({ requirePlatformAdmin: async () => ADMIN }));
vi.mock('../../../server/services/database/archiveExport.js', () => ({
  listBackupTables: async () => Object.keys(store.tables),
}));
vi.mock('../../../server/services/billing/edition.js', () => ({
  assertCurrencyAllowed: () => undefined,
  assertProviderAllowed: () => undefined,
  editionErrorResponse: () => null,
  getPlatformEdition: async () => 'iran',
}));
vi.mock('../../../server/services/billing/config/index.js', () => ({
  BillingConfigError: class extends Error {},
  listGateways: async () => [],
  upsertGateway: async () => ({}),
  getProviderCredentials: async (_c: unknown, name: string) =>
    store.credentials[name] ? { provider_name: name, config: store.credentials[name] } : null,
  upsertProviderCredentials: async (_c: unknown, name: string, config: Record<string, unknown>) => {
    store.credentials[name] = config;
    return { provider_name: name, config };
  },
}));
vi.mock('../../../server/services/billing/index.js', () => ({
  getProvider: () => ({ validateConfig: (c: Record<string, unknown>) => (c.merchant_id ? null : 'merchant_id is required') }),
  resolveNamedBillingConfig: async () => null,
}));

const { adminBillingRouter } = await import('../../../server/routes/adminBilling.js');
const { adminManagementRouter } = await import('../../../server/routes/adminManagement.js');
const { adminDatabaseRouter } = await import('../../../server/routes/adminDatabase.js');
const { adminWidgetRouter } = await import('../../../server/routes/adminWidget.js');

const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } }); next(); });
app.use(express.json());
app.use('/api/admin/billing', adminBillingRouter);
app.use('/api/admin/management', adminManagementRouter);
app.use('/api/admin/database', adminDatabaseRouter);
app.use('/api/admin/widget', adminWidgetRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

/** The answers these routes give, as far as the tests read them. */
interface Json {
  status?: string;
  http_status?: number;
  config?: Record<string, unknown>;
  secretKeysSet?: string[];
  configs?: Array<{ config: unknown; secretKeysSet: string[] } & Record<string, unknown>>;
  tables?: Record<string, unknown[]>;
  __error__?: string;
}

function call(method: string, path: string, body?: unknown): Promise<{ status: number; raw: string; json: Json }> {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json: Json = {};
        try { json = JSON.parse(raw); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, raw, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeEach(() => {
  store.credentials = {};
  store.providerConfigs = [];
  store.tables = {};
});

describe('billing gateway credentials (admin-4)', () => {
  const ZARINPAL = { merchant_id: 'zp-merchant-secret', currency: 'IRT' };
  const PADDLE = { api_key: 'pdl_live_apikey_x', webhook_secret: 'whsec_1', client_token: 'live_public', product_id: 'pro_1' };

  it('GET names the credentials instead of returning them', async () => {
    store.credentials.zarinpal = ZARINPAL;
    store.credentials.paddle = PADDLE;
    const zp = await call('GET', '/api/admin/billing/providers/zarinpal');
    expect(zp.status).toBe(200);
    expect(zp.raw).not.toContain('zp-merchant-secret');
    expect(zp.json).toEqual({ provider_name: 'zarinpal', config: { currency: 'IRT' }, secretKeysSet: ['merchant_id'] });
    const paddle = await call('GET', '/api/admin/billing/providers/paddle');
    expect(paddle.raw).not.toMatch(/pdl_live_apikey_x|whsec_1/);
    expect(paddle.json.secretKeysSet?.sort()).toEqual(['api_key', 'webhook_secret']);
    expect(paddle.json.config).toMatchObject({ client_token: 'live_public', product_id: 'pro_1' });
  });

  it('a save with the credential blank keeps the stored one, and answers without it', async () => {
    store.credentials.zarinpal = ZARINPAL;
    const saved = await call('PUT', '/api/admin/billing/providers/zarinpal', { config: { merchant_id: '', currency: 'IRR' } });
    expect(saved.status).toBe(200);
    expect(store.credentials.zarinpal).toEqual({ merchant_id: 'zp-merchant-secret', currency: 'IRR' });
    expect(saved.raw).not.toContain('zp-merchant-secret');
  });

  it('a new value replaces it; validation sees the merged config', async () => {
    store.credentials.zarinpal = ZARINPAL;
    await call('PUT', '/api/admin/billing/providers/zarinpal', { config: { merchant_id: 'new-merchant', currency: 'IRT' } });
    expect(store.credentials.zarinpal.merchant_id).toBe('new-merchant');
    const refused = await call('PUT', '/api/admin/billing/providers/idpay', { config: { merchant_id: '' } });
    expect(refused.status).toBe(400);
  });
});

describe('workspaces\' provider configs (admin-5)', () => {
  it('comes back without credentials', async () => {
    store.providerConfigs = [{
      id: 'p1', workspace_id: 'w1', provider_type: 'storage', provider_name: 's3', is_active: true,
      config: { bucket: 'b', access_key_id: 'AKIA-secret', secret_access_key: 'shh', region: 'eu' },
    }];
    const res = await call('GET', '/api/admin/management/provider-configs');
    expect(res.status).toBe(200);
    expect(res.raw).not.toMatch(/AKIA-secret|shh/);
    expect(res.json.configs?.[0]).toMatchObject({ is_active: true, config: { bucket: 'b', region: 'eu' } });
    expect(res.json.configs?.[0].secretKeysSet.sort()).toEqual(['access_key_id', 'secret_access_key']);
  });
});

describe('JSON backup (admin-6)', () => {
  it('writes every page of every table and stays valid JSON', async () => {
    store.tables = {
      big: Array.from({ length: 2501 }, (_, i) => ({ id: i })),
      empty: [],
      small: [{ id: 'a' }],
    };
    const res = await call('GET', '/api/admin/database/backup');
    expect(res.status).toBe(200);
    expect(res.json.tables?.big).toHaveLength(2501);
    expect(res.json.tables?.big[2500]).toEqual({ id: 2500 });
    expect(res.json.tables?.empty).toEqual([]);
    expect(res.json.tables?.small).toEqual([{ id: 'a' }]);
    expect(res.json.__error__).toBeUndefined();
  });
});

describe('widget URL test (admin-8)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['https://127.0.0.1:8000/', 'http://93.184.215.14/x.js', 'https://10.0.0.5/loader.js', 'https://169.254.169.254/latest'])(
    'refuses %s without a request',
    async (url) => {
      const res = await call('POST', '/api/admin/widget/test-url', { kind: 'loader', url });
      expect(res.status).toBe(200);
      expect(res.json.status).toBe('failed');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('checks every redirect target and never follows one by itself', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'https://10.0.0.5/secret' } }));
    const res = await call('POST', '/api/admin/widget/test-url', { kind: 'loader', url: 'https://93.184.215.14/loader.js' });
    expect(res.json.status).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('a public URL is tested', async () => {
    fetchMock.mockResolvedValueOnce(new Response('function x(){}', { status: 200, headers: { 'content-type': 'application/javascript' } }));
    const res = await call('POST', '/api/admin/widget/test-url', { kind: 'loader', url: 'https://93.184.215.14/loader.js' });
    expect(res.json.http_status).toBe(200);
  });
});
