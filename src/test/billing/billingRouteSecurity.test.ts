import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import http from 'node:http';
import express from 'express';

// ── Mocks ────────────────────────────────────────────────────────────────
const processWebhookEvent = vi.fn().mockResolvedValue(undefined);
const stripeVerify = vi.fn();

vi.mock('../../../server/services/billing/index.js', () => ({
  resolveBillingConfig: vi.fn().mockResolvedValue(null),
  getProvider: (name: string) =>
    name === 'stripe'
      ? { name: 'stripe', capabilities: {}, verifyWebhook: stripeVerify }
      : name === 'zarinpal'
        ? { name: 'zarinpal', capabilities: {}, verifyWebhook: vi.fn() }
        : null,
  getAllProviders: () => ({}),
  processWebhookEvent: (...a: unknown[]) => processWebhookEvent(...a),
  logBillingEvent: vi.fn().mockResolvedValue(undefined),
  checkEntitlement: vi.fn().mockResolvedValue({ allowed: false }),
}));

let wsConfigRows: Array<{ workspace_id: string | null; config: unknown }> = [];
let globalConfigValue: unknown = null;

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        limit: async () => ({ data: table === 'provider_configs' ? wsConfigRows : [] }),
        maybeSingle: async () => ({
          data: table === 'app_runtime_config' ? { value: globalConfigValue } : null,
        }),
      };
      return builder;
    },
  }),
}));

let authUser: { id: string } | null = null;
let memberOf: Record<string, string> = {};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    auth: { getUser: async () => ({ data: { user: authUser }, error: authUser ? null : new Error('bad') }) },
    rpc: async (_fn: string, args: any) => ({ data: Boolean(memberOf[args._workspace_id]) }),
    from: () => {
      const b: any = {
        select: () => b,
        eq: (_c: string, v: string) => {
          if (!b._ws) b._ws = v;
          return b;
        },
        maybeSingle: async () => ({ data: b._ws && memberOf[b._ws] ? { role: memberOf[b._ws] } : null }),
      };
      return b;
    },
  }),
}));

let globalAdmin = false;
vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async () => globalAdmin,
}));

const { billingRouter, billingWebhookRouter } = await import('../../../server/routes/billing.js');

// ── Test server ──────────────────────────────────────────────────────────
const serverConfig = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseAnonKey: 'ANON_KEY',
  supabaseServiceRoleKey: 'SERVICE_KEY',
};

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = serverConfig;
  next();
});
app.use('/api/billing/webhook', billingWebhookRouter);
app.use(express.json());
app.use('/api/billing', billingRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: port(), path, method, headers: opts.headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  authUser = null;
  memberOf = {};
  globalAdmin = false;
  wsConfigRows = [];
  globalConfigValue = null;
  processWebhookEvent.mockClear();
  stripeVerify.mockReset();
});

// ── Route protection ─────────────────────────────────────────────────────
const protectedRoutes: Array<[string, string, unknown]> = [
  ['POST', '/api/billing/checkout', { workspaceId: WS, planId: 'p', interval: 'monthly', currency: 'USD', callbackUrl: 'https://a/b' }],
  ['POST', '/api/billing/subscription/cancel', { workspaceId: WS }],
  ['POST', '/api/billing/subscription/resume', { workspaceId: WS }],
  ['POST', '/api/billing/portal', { workspaceId: WS, returnUrl: 'https://a/b' }],
  ['GET', `/api/billing/status/${WS}`, null],
  ['GET', `/api/billing/events/${WS}`, null],
  ['GET', '/api/billing/admin/overview', null],
  ['POST', '/api/billing/admin/grant', { workspaceId: WS, planId: 'p' }],
  ['POST', '/api/billing/test', { provider: 'stripe', config: {} }],
];

describe('billing route protection', () => {
  it.each(protectedRoutes)('%s %s rejects unauthenticated callers', async (method, path, body) => {
    const res = await call(method, path, {
      body: body ? JSON.stringify(body) : undefined,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });

  it.each(protectedRoutes)('%s %s rejects the anon publishable key as identity', async (method, path, body) => {
    const res = await call(method, path, {
      body: body ? JSON.stringify(body) : undefined,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ANON_KEY' },
    });
    expect(res.status).toBe(401);
  });

  it.each(protectedRoutes)('%s %s rejects the service-role key as identity', async (method, path, body) => {
    const res = await call(method, path, {
      body: body ? JSON.stringify(body) : undefined,
      headers: { 'content-type': 'application/json', authorization: 'Bearer SERVICE_KEY' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a member of a different workspace (cross-tenant)', async () => {
    authUser = { id: 'u1' };
    memberOf = { [OTHER_WS]: 'owner' };
    const res = await call('GET', `/api/billing/status/${WS}`, { headers: { authorization: 'Bearer good' } });
    expect(res.status).toBe(403);
  });

  it('rejects a viewer attempting a billing mutation', async () => {
    authUser = { id: 'u1' };
    memberOf = { [WS]: 'viewer' };
    const res = await call('POST', '/api/billing/subscription/cancel', {
      body: JSON.stringify({ workspaceId: WS }),
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a malformed workspaceId before any lookup', async () => {
    authUser = { id: 'u1' };
    const res = await call('GET', '/api/billing/status/not-a-uuid', {
      headers: { authorization: 'Bearer good' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-admin on admin routes', async () => {
    authUser = { id: 'u1' };
    memberOf = { [WS]: 'owner' };
    const res = await call('GET', '/api/billing/admin/overview', {
      headers: { authorization: 'Bearer good' },
    });
    expect(res.status).toBe(403);
  });
});

// ── Webhook ──────────────────────────────────────────────────────────────
const BODY = JSON.stringify({ id: 'evt_1' });

describe('billing webhooks', () => {
  it('rejects unknown providers', async () => {
    const res = await call('POST', '/api/billing/webhook/nope', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(404);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects providers without a signed webhook contract', async () => {
    const res = await call('POST', '/api/billing/webhook/zarinpal', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects an empty body', async () => {
    const res = await call('POST', '/api/billing/webhook/stripe');
    expect(res.status).toBe(400);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects when no config verifies the signature', async () => {
    wsConfigRows = [{ workspace_id: WS, config: { webhook_secret: 'a' } }];
    stripeVerify.mockRejectedValue(new Error('Invalid Stripe webhook signature'));
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  it('passes the exact raw bytes to verifyWebhook', async () => {
    const raw = '{"id":"evt_1",   "spaced":true}';
    wsConfigRows = [{ workspace_id: WS, config: { webhook_secret: 'a' } }];
    stripeVerify.mockResolvedValue({ type: 'invoice_paid', providerEventId: 'evt_1', raw: {} });
    await call('POST', '/api/billing/webhook/stripe', { body: raw, headers: { 'content-type': 'application/json' } });
    expect(stripeVerify.mock.calls[0][2]).toBe(raw);
  });

  it('binds the event to the workspace that owns the verifying config', async () => {
    wsConfigRows = [{ workspace_id: WS, config: { webhook_secret: 'a' } }];
    stripeVerify.mockResolvedValue({ type: 'invoice_paid', providerEventId: 'evt_1', raw: {} });
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(processWebhookEvent.mock.calls[0][3].workspaceId).toBe(WS);
  });

  it('rejects a payload claiming a workspace other than the config owner', async () => {
    wsConfigRows = [{ workspace_id: WS, config: { webhook_secret: 'a' } }];
    stripeVerify.mockResolvedValue({ type: 'invoice_paid', providerEventId: 'evt_1', workspaceId: OTHER_WS, raw: {} });
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects a platform-config event with no workspace in the signed payload', async () => {
    globalConfigValue = { provider: 'stripe', webhook_secret: 'a' };
    stripeVerify.mockResolvedValue({ type: 'invoice_paid', providerEventId: 'evt_1', raw: {} });
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  it('accepts a platform-config event whose signed payload carries the workspace', async () => {
    globalConfigValue = { provider: 'stripe', webhook_secret: 'a' };
    stripeVerify.mockResolvedValue({ type: 'invoice_paid', providerEventId: 'evt_1', workspaceId: WS, raw: {} });
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(processWebhookEvent.mock.calls[0][3].workspaceId).toBe(WS);
  });

  it('requires no authentication header but never trusts one', async () => {
    wsConfigRows = [{ workspace_id: WS, config: { webhook_secret: 'a' } }];
    stripeVerify.mockRejectedValue(new Error('Invalid Stripe webhook signature'));
    const res = await call('POST', '/api/billing/webhook/stripe', {
      body: BODY,
      headers: { 'content-type': 'application/json', authorization: 'Bearer SERVICE_KEY' },
    });
    expect(res.status).toBe(400);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });
});
