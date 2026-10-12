/**
 * The Paddle sandbox gateway through the HTTP routes: Finance → Gateways
 * listing, the Providers screen's credential check and its own webhook
 * endpoint. (Billing v2's payment page and finance report, which this suite
 * also covered, were removed in phase 7A; simple billing's own checkout
 * offers it through billingAccount.ts.)
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';

const state = vi.hoisted(() => ({
  edition: 'international' as 'iran' | 'international',
  isPlatformAdmin: false,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/platformRegion.js')>();
  return { ...actual, getPlatformEdition: async () => state.edition };
});

/** A tiny PostgREST-shaped fake over `state.tables`. */
function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      let upserted: Record<string, unknown> | null = null;
      const rows = () => (state.tables[table] || []).filter((r) => filters.every((f) => f(r)));
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'limit', 'range', 'gte', 'ilike', 'update', 'insert']) b[m] = () => b;
      b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
      b.neq = (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b);
      b.in = (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b);
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
  authorizeWorkspaceAccess: async () =>
    state.isPlatformAdmin ? { userId: 'admin-1', isAdmin: true, role: null } : { userId: 'u1', isAdmin: false, role: 'owner' },
  requirePlatformAdmin: async () => 'admin-1',
  requireUser: async () => 'u1',
  serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
}));
vi.mock('../../../server/services/billing/callbackUrl.js', () => ({
  isAllowedBillingCallbackUrl: () => true,
  resolvePublicApiOrigin: async () => 'https://api.test',
}));

const { billingWebhookRouter } = await import('../../../server/routes/billing.js');
const { adminBillingRouter } = await import('../../../server/routes/adminBilling.js');

const SANDBOX_CREDENTIALS = {
  api_key: 'pdl_sdbx_apikey_mock_not_real',
  client_token: 'test_mock_client_token',
  webhook_secret: 'pdl_ntfset_sandbox_secret',
};
const LIVE_CREDENTIALS = {
  api_key: 'pdl_live_apikey_mock_not_real',
  client_token: 'live_mock_client_token',
  webhook_secret: 'pdl_ntfset_live_secret',
};

beforeEach(() => {
  state.edition = 'international';
  state.isPlatformAdmin = false;
  state.upserts = [];
  state.tables = {
    billing_gateways: [
      { provider_name: 'stripe', is_active: true, is_test: false, currencies: ['USD'], countries: [], sort_order: 1, display_name: { en: 'Stripe' }, config: {} },
      { provider_name: 'paddle', is_active: true, is_test: false, currencies: ['USD', 'EUR'], countries: [], sort_order: 2, display_name: { en: 'Paddle' }, config: {} },
      // Switched on in Finance → Gateways with the test marker left off: it is a test gateway anyway.
      { provider_name: 'paddle_sandbox', is_active: true, is_test: false, currencies: ['USD'], countries: [], sort_order: 3, display_name: { en: 'Paddle — Sandbox (test)' }, config: {} },
    ],
    billing_provider_credentials: [
      { provider_name: 'paddle_sandbox', config: { ...SANDBOX_CREDENTIALS } },
      { provider_name: 'paddle', config: { ...LIVE_CREDENTIALS } },
    ],
    app_runtime_config: [],
    provider_configs: [],
    billing_plans: [],
    workspace_subscriptions: [],
    workspaces: [{ id: WS, name: 'Acme' }],
  };
});

// ─── HTTP harness ─────────────────────────────────────────────────────────
const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' };
  next();
});
app.use('/api/billing/webhook', billingWebhookRouter);
app.use(express.json());
app.use('/api/admin/billing', adminBillingRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

// Response bodies are free-form JSON read field by field below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: (server.address() as { port: number }).port,
        path,
        method,
        headers: { 'content-type': 'application/json', connection: 'close', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data ? JSON.parse(data) : {} }));
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const names = (rows: Array<{ provider_name: string }>) => rows.map((g) => g.provider_name);

describe('Finance → Gateways (Super Admin)', () => {
  it('International: listed, always marked as a test gateway', async () => {
    const r = await call('GET', '/api/admin/billing/gateways');
    const sandbox = r.body.gateways.find((g: { provider_name: string }) => g.provider_name === 'paddle_sandbox');
    expect(sandbox).toMatchObject({ is_test: true, implemented: true });
  });

  it('International: a row created by switching it on (no name yet) still shows its name', async () => {
    state.tables.billing_gateways[2].display_name = {};
    const r = await call('GET', '/api/admin/billing/gateways');
    const sandbox = r.body.gateways.find((g: { provider_name: string }) => g.provider_name === 'paddle_sandbox');
    expect(sandbox.display_name).toMatchObject({ en: 'Paddle — Sandbox (test)' });
  });

  it('International: listed with its own name before it has a row', async () => {
    state.tables.billing_gateways = state.tables.billing_gateways.filter((g) => g.provider_name !== 'paddle_sandbox');
    const r = await call('GET', '/api/admin/billing/gateways');
    const sandbox = r.body.gateways.find((g: { provider_name: string }) => g.provider_name === 'paddle_sandbox');
    expect(sandbox).toMatchObject({ is_active: false, is_test: true, display_name: { en: 'Paddle — Sandbox (test)' } });
  });

  it('Iran: neither listed nor switchable on, and its credentials are not reachable', async () => {
    state.edition = 'iran';
    const r = await call('GET', '/api/admin/billing/gateways');
    expect(names(r.body.gateways)).not.toContain('paddle_sandbox');
    expect(names(r.body.gateways)).toContain('paddle');
    expect((await call('PUT', '/api/admin/billing/gateways', { provider_name: 'paddle_sandbox', is_active: true })).status).toBe(400);
    expect((await call('GET', '/api/admin/billing/providers/paddle_sandbox')).status).toBe(400);
  });
});

describe('Providers screen: credentials of the wrong environment are refused', () => {
  it('paddle_sandbox refuses a live API key / token with a readable message, and saves sandbox ones', async () => {
    const live = await call('PUT', '/api/admin/billing/providers/paddle_sandbox', { config: { ...SANDBOX_CREDENTIALS, api_key: LIVE_CREDENTIALS.api_key } });
    expect(live.status).toBe(400);
    expect(live.body).toMatchObject({ code: 'invalid_provider_credentials', error: expect.stringContaining('_sdbx') });
    const token = await call('PUT', '/api/admin/billing/providers/paddle_sandbox', { config: { ...SANDBOX_CREDENTIALS, client_token: LIVE_CREDENTIALS.client_token } });
    expect(token.status).toBe(400);
    expect(token.body.error).toContain('test_');
    expect(state.upserts).toEqual([]);

    const ok = await call('PUT', '/api/admin/billing/providers/paddle_sandbox', { config: SANDBOX_CREDENTIALS });
    expect(ok.status).toBe(200);
    expect(state.upserts).toEqual([{ table: 'billing_provider_credentials', row: expect.objectContaining({ provider_name: 'paddle_sandbox', config: SANDBOX_CREDENTIALS }) }]);
  });

  it('live paddle refuses sandbox credentials unless its Sandbox Mode is on', async () => {
    const sdbx = await call('PUT', '/api/admin/billing/providers/paddle', { config: { ...LIVE_CREDENTIALS, api_key: SANDBOX_CREDENTIALS.api_key, sandbox: 'false' } });
    expect(sdbx.status).toBe(400);
    expect(sdbx.body.error).toContain('Paddle — Sandbox (test)');
    expect((await call('PUT', '/api/admin/billing/providers/paddle', { config: { ...SANDBOX_CREDENTIALS, sandbox: 'true' } })).status).toBe(200);
    expect((await call('PUT', '/api/admin/billing/providers/paddle', { config: LIVE_CREDENTIALS })).status).toBe(200);
  });
});

describe('webhook /api/billing/webhook/paddle_sandbox — its own secret', () => {
  function signed(secret: string, event: unknown) {
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const h1 = crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
    return { body, headers: { 'paddle-signature': `ts=${ts};h1=${h1}` } };
  }
  const event = { event_id: 'evt_1', event_type: 'transaction.created', data: { id: 'txn_1' } };

  it('accepts a notification signed with the sandbox secret', async () => {
    const { body, headers } = signed(SANDBOX_CREDENTIALS.webhook_secret, event);
    const r = await call('POST', '/api/billing/webhook/paddle_sandbox', body, headers);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ received: true, ignored: true });
  });

  it('refuses one signed with the live secret, and the live endpoint refuses the sandbox’s', async () => {
    const live = signed(LIVE_CREDENTIALS.webhook_secret, event);
    expect((await call('POST', '/api/billing/webhook/paddle_sandbox', live.body, live.headers)).status).toBe(400);
    const sandbox = signed(SANDBOX_CREDENTIALS.webhook_secret, event);
    expect((await call('POST', '/api/billing/webhook/paddle', sandbox.body, sandbox.headers)).status).toBe(400);
  });
});
