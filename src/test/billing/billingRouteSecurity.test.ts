import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';

// ── Mocks ────────────────────────────────────────────────────────────────
const processWebhookEvent = vi.fn().mockResolvedValue(undefined);
const stripeVerify = vi.fn();

// In-memory stand-in for the `(provider_name, provider_event_id)` unique index.
let claimedKeys = new Set<string>();
let claimShouldThrow = false;
const claimSpy = vi.fn();
const finalizeSpy = vi.fn();

async function fakeClaim(_url: string, _key: string, input: any) {
  claimSpy(input);
  if (claimShouldThrow) throw new Error('billing event claim failed');
  const k = `${input.providerName}:${input.providerEventId}`;
  if (claimedKeys.has(k)) return { claimed: false, duplicate: true };
  claimedKeys.add(k);
  return { claimed: true, eventRowId: `row_${claimedKeys.size}` };
}

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
  claimBillingWebhookEvent: (...a: any[]) => fakeClaim(a[0], a[1], a[2]),
  finalizeBillingWebhookEvent: async (...a: unknown[]) => {
    finalizeSpy(...a);
  },
}));

let wsConfigRows: Array<{ workspace_id: string | null; config: unknown }> = [];
let globalConfigValue: unknown = null;

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      // R7.3 — the builder must terminate for EVERY chain the routes use.
      // Previously only `limit`/`maybeSingle` resolved, so a route reaching
      // `.insert(...)` or `.single()` returned a builder object the route
      // awaited forever — surfacing as a 5s timeout and an unhandled
      // rejection, i.e. a flaky suite rather than a real authorization result.
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        neq: () => builder,
        gte: () => builder,
        lte: () => builder,
        order: () => builder,
        range: () => builder,
        insert: () => builder,
        update: () => builder,
        upsert: () => builder,
        delete: () => builder,
        single: async () => ({ data: null, error: null }),
        then: undefined as unknown,
        limit: async () => ({ data: table === 'provider_configs' ? wsConfigRows : [] }),
        maybeSingle: async () => ({
          data: table === 'app_runtime_config' ? { value: globalConfigValue } : null,
          error: null,
        }),
      };
      // Make a bare `await supabase.from(x).insert(...)` resolve too.
      builder.then = (resolve: (v: unknown) => void) =>
        resolve({ data: [], error: null });
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

// Identity now comes from the gs_session cookie, not a Bearer JWT. The
// `call()` helper below translates each test's `authorization: 'Bearer X'`
// header into a `gs_session=X` cookie so every existing call site keeps
// working unchanged. The well-known ANON_KEY/SERVICE_KEY/'broken' string
// values are still rejected outright — same security property the old
// mock enforced, just via "never matches a real session" instead of a
// literal token-equality check.
vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token || token === 'ANON_KEY' || token === 'SERVICE_KEY' || token === 'broken') return null;
    if (!authUser) return null;
    return { sessionId: 'test-session', userId: authUser.id, email: 'test@example.com' };
  },
  verifyOriginForMutation: () => true,
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
app.use(cookieParser());
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
  const headers = { ...opts.headers, connection: 'close' };
  const authMatch = /^Bearer (.+)$/.exec(headers.authorization || '');
  if (authMatch) headers.cookie = `gs_session=${authMatch[1]}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: port(), path, method, headers },
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
  claimedKeys = new Set();
  claimShouldThrow = false;
  claimSpy.mockClear();
  finalizeSpy.mockClear();
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

// ── Positive authorization paths ─────────────────────────────────────────
describe('billing authorization — allowed callers', () => {
  const ownerRoutes: Array<[string, string, unknown]> = [
    ['POST', '/api/billing/checkout', { workspaceId: WS, planId: 'p', interval: 'monthly', currency: 'USD', callbackUrl: 'https://a/b' }],
    ['POST', '/api/billing/subscription/cancel', { workspaceId: WS }],
    ['POST', '/api/billing/subscription/resume', { workspaceId: WS }],
    ['POST', '/api/billing/portal', { workspaceId: WS, returnUrl: 'https://a/b' }],
    ['GET', `/api/billing/events/${WS}`, null],
  ];

  it.each(ownerRoutes)('%s %s passes authorization for a workspace owner', async (method, path, body) => {
    authUser = { id: 'u1' };
    memberOf = { [WS]: 'owner' };
    const res = await call(method, path, {
      body: body ? JSON.stringify(body) : undefined,
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
    });
    expect([401, 403]).not.toContain(res.status);
  });

  it.each(ownerRoutes)('%s %s passes authorization for a workspace admin', async (method, path, body) => {
    authUser = { id: 'u1' };
    memberOf = { [WS]: 'admin' };
    const res = await call(method, path, {
      body: body ? JSON.stringify(body) : undefined,
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
    });
    expect([401, 403]).not.toContain(res.status);
  });

  it('lets a plain member read status of their own workspace', async () => {
    authUser = { id: 'u1' };
    memberOf = { [WS]: 'agent' };
    const res = await call('GET', `/api/billing/status/${WS}`, {
      headers: { authorization: 'Bearer good' },
    });
    expect([401, 403]).not.toContain(res.status);
  });

  it('denies a plain member every management route', async () => {
    authUser = { id: 'u1' };
    memberOf = { [WS]: 'agent' };
    for (const [method, path, body] of ownerRoutes) {
      const res = await call(method, path, {
        body: body ? JSON.stringify(body) : undefined,
        headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
      });
      expect(res.status).toBe(403);
    }
  });

  it.each([
    ['GET', '/api/billing/admin/overview', null],
    ['POST', '/api/billing/admin/grant', { workspaceId: WS, planId: 'p' }],
    ['POST', '/api/billing/test', { provider: 'stripe', config: {} }],
  ] as Array<[string, string, unknown]>)('%s %s passes for a super admin', async (method, path, body) => {
    authUser = { id: 'root' };
    globalAdmin = true;
    const res = await call(method, path, {
      body: body ? JSON.stringify(body) : undefined,
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
    });
    expect([401, 403]).not.toContain(res.status);
  });

  it('rejects an auth-service failure as unauthenticated', async () => {
    authUser = null;
    const res = await call('GET', `/api/billing/status/${WS}`, {
      headers: { authorization: 'Bearer broken' },
    });
    expect(res.status).toBe(401);
  });
});

// ── Webhook idempotency / replay ─────────────────────────────────────────
describe('billing webhook idempotency', () => {
  const signedEvent = (id: string) => ({ type: 'invoice_paid', providerEventId: id, raw: {} });

  beforeEach(() => {
    wsConfigRows = [{ workspace_id: WS, config: { webhook_secret: 'a' } }];
  });

  it.each(['stripe'])('claims before any financial side effect (%s)', async (p) => {
    stripeVerify.mockResolvedValue(signedEvent('evt_1'));
    const res = await call('POST', `/api/billing/webhook/${p}`, { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(processWebhookEvent).toHaveBeenCalledTimes(1);
    expect(claimSpy.mock.invocationCallOrder[0]).toBeLessThan(processWebhookEvent.mock.invocationCallOrder[0]);
    expect(processWebhookEvent.mock.calls[0][4]).toEqual({ alreadyClaimed: true });
  });

  it('acknowledges a replay without re-applying side effects', async () => {
    stripeVerify.mockResolvedValue(signedEvent('evt_dup'));
    const first = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    const second = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body)).toEqual({ received: true, duplicate: true });
    expect(processWebhookEvent).toHaveBeenCalledTimes(1);
    expect(claimedKeys.size).toBe(1);
  });

  it('applies exactly one side effect under a concurrent double delivery', async () => {
    stripeVerify.mockResolvedValue(signedEvent('evt_race'));
    const [a, b] = await Promise.all([
      call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } }),
      call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const dupes = [a, b].filter((r) => JSON.parse(r.body).duplicate === true);
    expect(dupes).toHaveLength(1);
    expect(processWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects a verified event with no stable provider event id', async () => {
    stripeVerify.mockResolvedValue({ type: 'invoice_paid', providerEventId: '   ', raw: {} });
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  it('fails closed with a generic 500 when the claim errors', async () => {
    claimShouldThrow = true;
    stripeVerify.mockResolvedValue(signedEvent('evt_err'));
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Webhook processing failed' });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  it('marks the claimed event failed when processing throws, without processed_at', async () => {
    stripeVerify.mockResolvedValue(signedEvent('evt_fail'));
    processWebhookEvent.mockRejectedValueOnce(new Error('boom'));
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(500);
    expect(finalizeSpy.mock.calls[0][3]).toBe('failed');
  });

  it('marks the claimed event successful after processing', async () => {
    stripeVerify.mockResolvedValue(signedEvent('evt_ok'));
    await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(finalizeSpy.mock.calls[0][3]).toBe('success');
  });

  it('rejects ambiguous candidates that both verify the signature', async () => {
    wsConfigRows = [
      { workspace_id: WS, config: { webhook_secret: 'a' } },
      { workspace_id: OTHER_WS, config: { webhook_secret: 'a' } },
    ];
    stripeVerify.mockResolvedValue(signedEvent('evt_ambiguous'));
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(processWebhookEvent).not.toHaveBeenCalled();
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it('still accepts a later matching candidate after an earlier mismatch', async () => {
    wsConfigRows = [
      { workspace_id: OTHER_WS, config: { webhook_secret: 'a' } },
      { workspace_id: WS, config: { webhook_secret: 'b' } },
    ];
    stripeVerify.mockImplementation(async (cfg: any) => {
      if (cfg.webhook_secret !== 'b') throw new Error('Invalid signature');
      return { type: 'invoice_paid', providerEventId: 'evt_late', workspaceId: WS, raw: {} };
    });
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(processWebhookEvent.mock.calls[0][3].workspaceId).toBe(WS);
  });
});
