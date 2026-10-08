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
/** Another delivery of the event holds the claim (billing_events row still `received`). */
let claimInFlight = false;
const claimSpy = vi.fn();
const finalizeSpy = vi.fn();

interface ClaimInput {
  providerName: string;
  providerEventId: string;
  workspaceId?: string;
}

async function fakeClaim(_url: string, _key: string, input: ClaimInput) {
  claimSpy(input);
  if (claimShouldThrow) throw new Error('billing event claim failed');
  if (claimInFlight) return { claimed: false, inFlight: true };
  const k = `${input.providerName}:${input.providerEventId}`;
  if (claimedKeys.has(k)) return { claimed: false, duplicate: true };
  claimedKeys.add(k);
  return { claimed: true, eventRowId: `row_${claimedKeys.size}` };
}

const paytrVerify = vi.fn();
const stripeVerifyPayment = vi.fn();
const paypalVerifyPayment = vi.fn();
const cardIntentWebhook = vi.fn().mockResolvedValue(undefined);
const cardSettle = vi.fn();
let intentRows: Record<string, Record<string, unknown>> = {};

vi.mock('../../../server/services/billing/index.js', () => ({
  resolveBillingConfig: vi.fn().mockResolvedValue(null),
  // The platform-wide config of one provider (canonical credentials over the
  // legacy layers) — stood in for by the legacy runtime-config value here.
  resolvePlatformBillingConfig: async (_url: string, _key: string, name: string) => {
    const v = globalConfigValue as Record<string, unknown> | null;
    if (!v || (v.provider_name || v.provider) !== name) return null;
    return { ...v, provider: name };
  },
  resolveNamedBillingConfig: async (_url: string, _key: string, _ws: string, name: string) => ({
    provider: { name },
    config: { provider: name },
  }),
  getProvider: (name: string) =>
    name === 'stripe'
      ? { name: 'stripe', capabilities: {}, verifyWebhook: stripeVerify, verifyPayment: stripeVerifyPayment }
      : name === 'zarinpal'
        ? { name: 'zarinpal', capabilities: {}, verifyWebhook: vi.fn() }
        : name === 'paytr'
          ? { name: 'paytr', capabilities: {}, webhookAckBody: 'OK', verifyWebhook: paytrVerify }
          : name === 'lemon_squeezy'
            ? { name: 'lemon_squeezy', capabilities: {}, verifyWebhook: vi.fn() }
            : name === 'paypal'
              ? { name: 'paypal', capabilities: {}, verifyWebhook: vi.fn(), verifyPayment: paypalVerifyPayment, verifyPaymentCaptures: true }
              : null,
  getAllProviders: () => ({}),
  processWebhookEvent: (...a: unknown[]) => processWebhookEvent(...a),
  logBillingEvent: vi.fn().mockResolvedValue(undefined),
  checkEntitlement: vi.fn().mockResolvedValue({ allowed: false }),
  claimBillingWebhookEvent: (...a: unknown[]) => fakeClaim(a[0] as string, a[1] as string, a[2] as ClaimInput),
  finalizeBillingWebhookEvent: async (...a: unknown[]) => {
    finalizeSpy(...a);
  },
}));

// Card-gateway events that name a payment intent are settled by
// cardInvoice.handleCardIntentWebhook; the intent rows come from here.
vi.mock('../../../server/services/billing/cardInvoice.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/cardInvoice.js')>()),
  handleCardIntentWebhook: (...a: unknown[]) => cardIntentWebhook(...a),
  settleVerifiedCardPayment: (...a: unknown[]) => cardSettle(...a),
}));
vi.mock('../../../server/services/billing/paymentIntent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/paymentIntent.js')>()),
  getPaymentIntent: async (_cfg: unknown, id: string) => intentRows[id] ?? null,
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
      const builder: Record<string, unknown> = {
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
      // The webhook route now reads the platform default config with
      // `.select().in('key', [...])` and awaits the builder directly, so this
      // terminator must serve `app_runtime_config` rows as well.
      builder.then = (resolve: (v: unknown) => void) =>
        resolve({
          data:
            table === 'app_runtime_config' && globalConfigValue
              ? [{ key: 'default_billing_provider', value: globalConfigValue }]
              : [],
          error: null,
        });
      return builder;
    },
  }),
}));

let authUser: { id: string } | null = null;
let memberOf: Record<string, string> = {};
/** `billing_invoices` rows by id, and the unapplied `billing_payments` rows any lookup finds. */
let invoiceRows: Record<string, Record<string, unknown>> = {};
let unappliedPayments: Array<Record<string, unknown>> = [];

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    auth: { getUser: async () => ({ data: { user: authUser }, error: authUser ? null : new Error('bad') }) },
    rpc: async (_fn: string, args: { _workspace_id: string }) => ({ data: Boolean(memberOf[args._workspace_id]) }),
    from: (table: string) => {
      const b: Record<string, unknown> & { _ws?: string } = {
        select: () => b,
        eq: (_c: string, v: string) => {
          if (!b._ws) b._ws = v;
          return b;
        },
        maybeSingle: async () => (table === 'billing_invoices'
          ? { data: (b._ws && invoiceRows[b._ws]) || null, error: null }
          : { data: b._ws && memberOf[b._ws] ? { role: memberOf[b._ws] } : null }),
        // "Money recorded for review" lookups (unapplied payments of an intent).
        or: () => b,
        limit: () => b,
        // getRolloutState self-heals a missing billing_v2_rollout row before
        // any legacy-path check runs, so the very first authorized request
        // reaches this. Without it the call rejected outside the request's
        // own promise chain: an unhandled rejection and a 5s timeout rather
        // than the authorization result the case is actually about.
        upsert: () => b,
        // Intent state transitions (markPaymentIntentFailed) and the
        // collection release on the card return path.
        update: () => b,
        in: () => b,
        then: (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) =>
          Promise.resolve({ data: table === 'billing_payments' ? unappliedPayments : null, error: null }).then(onOk, onErr),
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
  (req as unknown as { serverConfig: typeof serverConfig }).serverConfig = serverConfig;
  next();
});
app.use(cookieParser());
app.use('/api/billing/webhook', billingWebhookRouter);
app.use(express.json());
app.use('/api/billing', billingRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as { port: number }).port;

function call(
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { ...opts.headers, connection: 'close' };
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
  paytrVerify.mockReset();
  stripeVerifyPayment.mockReset();
  paypalVerifyPayment.mockReset();
  invoiceRows = {};
  unappliedPayments = [];
  claimInFlight = false;
  cardIntentWebhook.mockClear();
  cardSettle.mockReset();
  intentRows = {};
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
    stripeVerify.mockImplementation(async (cfg: { webhook_secret?: string }) => {
      if (cfg.webhook_secret !== 'b') throw new Error('Invalid signature');
      return { type: 'invoice_paid', providerEventId: 'evt_late', workspaceId: WS, raw: {} };
    });
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(processWebhookEvent.mock.calls[0][3].workspaceId).toBe(WS);
  });
});

// ── Card gateways on the invoice engine ──────────────────────────────────
describe('billing webhooks — invoice intents and acknowledgements', () => {
  const INTENT = '33333333-3333-4333-8333-333333333333';
  const intentRow = (overrides: Record<string, unknown> = {}) => ({
    id: INTENT,
    workspace_id: WS,
    provider_name: 'stripe',
    invoice_id: 'inv-1',
    status: 'pending',
    metadata: { currency: 'USD' },
    ...overrides,
  });

  it('acknowledges a verified event that needs no action, without claiming or applying it', async () => {
    globalConfigValue = { provider_name: 'stripe', webhook_secret: 'a' };
    stripeVerify.mockResolvedValue({ type: 'ignored', providerEventId: 'evt_ign', raw: {} });
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true, ignored: true });
    expect(claimSpy).not.toHaveBeenCalled();
    expect(processWebhookEvent).not.toHaveBeenCalled();
    expect(cardIntentWebhook).not.toHaveBeenCalled();
  });

  it('verifies with the platform-wide credentials when no workspace config exists', async () => {
    globalConfigValue = { provider_name: 'stripe', webhook_secret: 'from-providers-screen' };
    stripeVerify.mockImplementation(async (cfg: { webhook_secret?: string }) => {
      if (cfg.webhook_secret !== 'from-providers-screen') throw new Error('Invalid signature');
      return { type: 'refund_processed', providerEventId: 'evt_cfg', workspaceId: WS, raw: {} };
    });
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(processWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it('settles a payment intent named in the signed metadata through the invoice engine', async () => {
    globalConfigValue = { provider_name: 'stripe', webhook_secret: 'a' };
    intentRows[INTENT] = intentRow();
    stripeVerify.mockResolvedValue({
      type: 'payment_succeeded', providerEventId: 'evt_pay', workspaceId: WS, intentId: INTENT,
      amount: 2900, currency: 'USD', providerRef: 'cs_1', raw: {},
    });
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(cardIntentWebhook).toHaveBeenCalledTimes(1);
    const [, provider, event, intent] = cardIntentWebhook.mock.calls[0];
    expect(provider).toBe('stripe');
    expect(event.intentId).toBe(INTENT);
    expect(intent.id).toBe(INTENT);
    // Never the legacy path, which may not touch the subscription.
    expect(processWebhookEvent).not.toHaveBeenCalled();
    expect(claimSpy.mock.invocationCallOrder[0]).toBeLessThan(cardIntentWebhook.mock.invocationCallOrder[0]);
  });

  it('pins a platform-level event without a workspace to the workspace of the intent it names', async () => {
    globalConfigValue = { provider_name: 'stripe', webhook_secret: 'a' };
    intentRows[INTENT] = intentRow();
    stripeVerify.mockResolvedValue({ type: 'payment_succeeded', providerEventId: 'evt_nows', intentId: INTENT, raw: {} });
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(claimSpy.mock.calls[0][0].workspaceId).toBe(WS);
    expect(cardIntentWebhook).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another workspace', { workspace_id: OTHER_WS }],
    ['another provider', { provider_name: 'paypal' }],
    ['no invoice', { invoice_id: null }],
  ])('rejects an event naming an intent of %s, before claiming anything', async (_label, overrides) => {
    wsConfigRows = [{ workspace_id: WS, config: { webhook_secret: 'a' } }];
    intentRows[INTENT] = intentRow(overrides);
    stripeVerify.mockResolvedValue({ type: 'payment_succeeded', providerEventId: 'evt_x', intentId: INTENT, raw: {} });
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(claimSpy).not.toHaveBeenCalled();
    expect(cardIntentWebhook).not.toHaveBeenCalled();
  });

  it('acknowledges an event for an intent this database never had (a shared provider account), touching nothing', async () => {
    globalConfigValue = { provider_name: 'stripe', webhook_secret: 'a' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stripeVerify.mockResolvedValue({
      type: 'payment_succeeded', providerEventId: 'evt_foreign', workspaceId: OTHER_WS, intentId: INTENT,
      amount: 2900, currency: 'USD', raw: {},
    });
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true, ignored: true });
    expect(claimSpy).not.toHaveBeenCalled();
    expect(cardIntentWebhook).not.toHaveBeenCalled();
    expect(processWebhookEvent).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('unknown_intent'))).toBe(true);
    warn.mockRestore();
  });

  it('also when the foreign event names no workspace at all', async () => {
    globalConfigValue = { provider_name: 'stripe', webhook_secret: 'a' };
    stripeVerify.mockResolvedValue({ type: 'refund_processed', providerEventId: 'evt_foreign_2', intentId: INTENT, raw: {} });
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true, ignored: true });
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it('a delivery another request is still processing is not acknowledged: the provider retries it later', async () => {
    globalConfigValue = { provider_name: 'stripe', webhook_secret: 'a' };
    intentRows[INTENT] = intentRow();
    claimInFlight = true;
    stripeVerify.mockResolvedValue({ type: 'payment_succeeded', providerEventId: 'evt_busy', workspaceId: WS, intentId: INTENT, raw: {} });
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(409);
    expect(cardIntentWebhook).not.toHaveBeenCalled();
    expect(finalizeSpy).not.toHaveBeenCalled();
  });

  it('answers 500 and marks the event failed when settling fails, so the retry re-processes it', async () => {
    globalConfigValue = { provider_name: 'stripe', webhook_secret: 'a' };
    intentRows[INTENT] = intentRow();
    stripeVerify.mockResolvedValue({ type: 'payment_succeeded', providerEventId: 'evt_retry', workspaceId: WS, intentId: INTENT, raw: {} });
    cardIntentWebhook.mockRejectedValueOnce(new Error('card_settlement_pending'));
    const res = await call('POST', '/api/billing/webhook/stripe', { body: BODY, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(500);
    expect(finalizeSpy.mock.calls[0][3]).toBe('failed');
  });

  it('answers PayTR with the plain-text OK it requires (ack)', async () => {
    wsConfigRows = [{ workspace_id: WS, config: { merchant_key: 'k', merchant_salt: 's' } }];
    paytrVerify.mockResolvedValue({ type: 'ignored', providerEventId: 'oid0', raw: {} });
    const res = await call('POST', '/api/billing/webhook/paytr', {
      body: 'merchant_oid=oid0&status=failed&total_amount=100&hash=x',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('OK');
  });

  it('answers PayTR with the plain-text OK it requires', async () => {
    wsConfigRows = [{ workspace_id: WS, config: { merchant_key: 'k', merchant_salt: 's' } }];
    paytrVerify.mockResolvedValue({ type: 'payment_failed', providerEventId: 'oid1', raw: {} });
    const res = await call('POST', '/api/billing/webhook/paytr', {
      body: 'merchant_oid=oid1&status=failed&total_amount=100&hash=x',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('OK');
  });
});

describe('verify-callback — the customer returns from a card gateway', () => {
  const INTENT = '44444444-4444-4444-8444-444444444444';
  const cardIntent = (overrides: Record<string, unknown> = {}) => ({
    id: INTENT,
    workspace_id: WS,
    provider_name: 'stripe',
    provider_ref: 'cs_1',
    invoice_id: 'inv-1',
    status: 'pending',
    purchase_type: 'subscription',
    amount_irr: 2900,
    expected_amount_irr: 2900,
    metadata: { currency: 'USD' },
    ...overrides,
  });
  const verify = (body: Record<string, unknown>) =>
    call('POST', '/api/billing/verify-callback', {
      body: JSON.stringify({ workspaceId: WS, provider: 'stripe', intentId: INTENT, ...body }),
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
    });

  beforeEach(() => {
    authUser = { id: 'u1' };
    memberOf = { [WS]: 'owner' };
  });

  it('asks Stripe about the STORED session and settles the invoice with Stripe’s amount and currency', async () => {
    intentRows[INTENT] = cardIntent();
    stripeVerifyPayment.mockResolvedValue({
      verified: true, providerRef: 'cs_1', amount: 2900, currency: 'USD', paymentId: 'pi_stripe_1', status: 'paid',
    });
    cardSettle.mockImplementation(async () => {
      intentRows[INTENT] = cardIntent({ status: 'succeeded' });
      return { outcome: 'succeeded' };
    });
    const res = await verify({ params: { session_id: 'cs_1' } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ success: true, verified: true });
    expect(stripeVerifyPayment.mock.calls[0][1]).toMatchObject({ session_id: 'cs_1', amount: '2900' });
    expect(cardSettle.mock.calls[0][1]).toMatchObject({
      providerName: 'stripe', providerRef: 'cs_1', paymentId: 'pi_stripe_1', amount: 2900, currency: 'USD',
    });
  });

  it('a return without a reference is still verified against the stored session', async () => {
    intentRows[INTENT] = cardIntent();
    stripeVerifyPayment.mockResolvedValue({ verified: false, providerRef: 'cs_1', status: 'pending' });
    await verify({ params: {} });
    expect(stripeVerifyPayment.mock.calls[0][1].session_id).toBe('cs_1');
  });

  it('"not paid yet" leaves the intent alone and tells the screen to keep polling', async () => {
    intentRows[INTENT] = cardIntent();
    stripeVerifyPayment.mockResolvedValue({ verified: false, providerRef: 'cs_1', status: 'pending' });
    const res = await verify({ params: { session_id: 'cs_1' } });
    expect(JSON.parse(res.body)).toEqual({ success: true, verified: false, pending: true });
    expect(cardSettle).not.toHaveBeenCalled();
  });

  it('a cancel return ends the attempt', async () => {
    intentRows[INTENT] = cardIntent();
    stripeVerifyPayment.mockResolvedValue({ verified: false, providerRef: 'cs_1', status: 'canceled' });
    const res = await verify({ params: { canceled: '1' } });
    expect(JSON.parse(res.body)).toEqual({ success: true, verified: false, status: 'canceled' });
    expect(stripeVerifyPayment.mock.calls[0][1]).toMatchObject({ canceled: '1', session_id: 'cs_1' });
  });

  it('a return naming another checkout is refused without asking the provider', async () => {
    intentRows[INTENT] = cardIntent();
    const res = await verify({ params: { session_id: 'cs_someone_else' } });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'REFERENCE_MISMATCH' });
    expect(stripeVerifyPayment).not.toHaveBeenCalled();
  });

  it('money that cannot settle the invoice is reported as under review, never as failed', async () => {
    intentRows[INTENT] = cardIntent();
    stripeVerifyPayment.mockResolvedValue({ verified: true, providerRef: 'cs_1', amount: 100, currency: 'USD' });
    cardSettle.mockResolvedValue({ outcome: 'parked', reason: 'gateway_amount_mismatch' });
    const res = await verify({ params: { session_id: 'cs_1' } });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'PAYMENT_UNDER_REVIEW' });
  });

  it('a finalization still running is pending (202), never failed', async () => {
    intentRows[INTENT] = cardIntent();
    stripeVerifyPayment.mockResolvedValue({ verified: true, providerRef: 'cs_1', amount: 2900, currency: 'USD' });
    cardSettle.mockResolvedValue({ outcome: 'pending', reason: 'finalization_pending' });
    const res = await verify({ params: { session_id: 'cs_1' } });
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ success: true, verified: true, pending: true });
  });

  it('Lemon Squeezy is confirmed by its webhook: the return only polls', async () => {
    intentRows[INTENT] = cardIntent({ provider_name: 'lemon_squeezy', provider_ref: 'co_1' });
    const res = await verify({ provider: 'lemon_squeezy', params: {} });
    expect(JSON.parse(res.body)).toEqual({ success: true, verified: false, pending: true });
  });

  it.each([
    ['of another workspace', { workspace_id: OTHER_WS }],
    ['of another provider', { provider_name: 'paypal' }],
    ['without an invoice', { invoice_id: null }],
  ])('refuses an intent %s', async (_label, overrides) => {
    intentRows[INTENT] = cardIntent(overrides);
    const res = await verify({ params: { session_id: 'cs_1' } });
    expect(res.status).toBe(400);
    expect(stripeVerifyPayment).not.toHaveBeenCalled();
  });

  it('money already recorded for review is reported as under review on a reload — never as a failed payment', async () => {
    intentRows[INTENT] = cardIntent({ status: 'failed', failure_reason: 'gateway_amount_mismatch' });
    unappliedPayments = [{ id: 'pay-parked' }];
    const res = await verify({ params: { session_id: 'cs_1' } });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'PAYMENT_UNDER_REVIEW' });
    expect(stripeVerifyPayment).not.toHaveBeenCalled();
  });

  it('a failed attempt with no money recorded is reported as it is', async () => {
    intentRows[INTENT] = cardIntent({ status: 'failed', failure_reason: 'gateway_canceled' });
    const res = await verify({ params: { session_id: 'cs_1' } });
    expect(JSON.parse(res.body)).toEqual({ success: true, verified: false, status: 'failed' });
    expect(stripeVerifyPayment).not.toHaveBeenCalled();
  });

  it('a checkout superseded by a newer one is still looked up, and its money settles the invoice', async () => {
    intentRows[INTENT] = cardIntent({ status: 'canceled', failure_reason: 'superseded_by_new_checkout' });
    stripeVerifyPayment.mockResolvedValue({
      verified: true, providerRef: 'cs_1', amount: 2900, currency: 'USD', paymentId: 'pi_stripe_1', status: 'paid',
    });
    cardSettle.mockImplementation(async () => {
      intentRows[INTENT] = cardIntent({ status: 'succeeded' });
      return { outcome: 'succeeded' };
    });
    const res = await verify({ params: { session_id: 'cs_1' } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ success: true, verified: true });
    expect(cardSettle.mock.calls[0][1].intent).toMatchObject({ status: 'canceled', failure_reason: 'superseded_by_new_checkout' });
  });

  it('an expired checkout that was never paid stays expired, untouched', async () => {
    intentRows[INTENT] = cardIntent({ status: 'expired', failure_reason: 'ttl_expired' });
    stripeVerifyPayment.mockResolvedValue({ verified: false, providerRef: 'cs_1', status: 'expired' });
    const res = await verify({ params: { session_id: 'cs_1' } });
    expect(JSON.parse(res.body)).toEqual({ success: true, verified: false, status: 'expired' });
    expect(cardSettle).not.toHaveBeenCalled();
  });

  it('an attempt the customer canceled before reaching the provider is never looked up', async () => {
    intentRows[INTENT] = cardIntent({ status: 'canceled', failure_reason: 'customer_canceled' });
    const res = await verify({ params: {} });
    expect(JSON.parse(res.body)).toEqual({ success: true, verified: false, status: 'canceled' });
    expect(stripeVerifyPayment).not.toHaveBeenCalled();
  });

  describe('PayPal: the lookup captures the money, so it only runs for an attempt that can still settle', () => {
    const FUTURE = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const PAST = new Date(Date.now() - 60 * 1000).toISOString();
    const paypalIntent = (overrides: Record<string, unknown> = {}) =>
      cardIntent({ provider_name: 'paypal', provider_ref: 'ORDER-1', expires_at: FUTURE, ...overrides });
    const verifyPayPal = () => verify({ provider: 'paypal', params: { token: 'ORDER-1', PayerID: 'P1' } });

    it('captures a live attempt for an invoice that still owes exactly its amount', async () => {
      intentRows[INTENT] = paypalIntent();
      invoiceRows['inv-1'] = { status: 'open', amount_due_irr: 2900, currency: 'USD' };
      paypalVerifyPayment.mockResolvedValue({ verified: false, providerRef: 'ORDER-1', status: 'pending' });
      await verifyPayPal();
      expect(paypalVerifyPayment).toHaveBeenCalledTimes(1);
    });

    it('captures nothing after the attempt’s deadline (the order lapses at PayPal)', async () => {
      intentRows[INTENT] = paypalIntent({ expires_at: PAST });
      invoiceRows['inv-1'] = { status: 'open', amount_due_irr: 2900, currency: 'USD' };
      const res = await verifyPayPal();
      expect(JSON.parse(res.body)).toEqual({ success: true, verified: false, status: 'expired' });
      expect(paypalVerifyPayment).not.toHaveBeenCalled();
    });

    it.each([
      ['paid meanwhile', { status: 'paid', amount_due_irr: 0, currency: 'USD' }],
      ['owing another amount', { status: 'partially_paid', amount_due_irr: 1000, currency: 'USD' }],
    ])('captures nothing for an invoice %s', async (_label, invoice) => {
      intentRows[INTENT] = paypalIntent();
      invoiceRows['inv-1'] = invoice;
      const res = await verifyPayPal();
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: 'INVOICE_NOT_PAYABLE' });
      expect(paypalVerifyPayment).not.toHaveBeenCalled();
    });

    it('never captures a superseded attempt', async () => {
      intentRows[INTENT] = paypalIntent({ status: 'canceled', failure_reason: 'superseded_by_new_checkout' });
      invoiceRows['inv-1'] = { status: 'open', amount_due_irr: 2900, currency: 'USD' };
      const res = await verifyPayPal();
      expect(JSON.parse(res.body)).toEqual({ success: true, verified: false, status: 'canceled' });
      expect(paypalVerifyPayment).not.toHaveBeenCalled();
    });
  });

  describe('status polling', () => {
    const poll = () => call('GET', `/api/billing/payment-intent/${INTENT}`, { headers: { authorization: 'Bearer good' } });

    it('reports an attempt whose money was recorded for review as PAYMENT_UNDER_REVIEW, not as its failure', async () => {
      intentRows[INTENT] = cardIntent({ status: 'failed', failure_reason: 'gateway_amount_mismatch' });
      unappliedPayments = [{ id: 'pay-parked' }];
      const res = await poll();
      expect(JSON.parse(res.body)).toMatchObject({ status: 'failed', pending: false, failureReason: 'PAYMENT_UNDER_REVIEW' });
    });

    it('reports any other ended attempt by its own reason', async () => {
      intentRows[INTENT] = cardIntent({ status: 'failed', failure_reason: 'gateway_canceled' });
      const res = await poll();
      expect(JSON.parse(res.body)).toMatchObject({ status: 'failed', failureReason: 'gateway_canceled' });
    });
  });

  it('an intent that already succeeded answers with its receipt and asks nothing', async () => {
    intentRows[INTENT] = cardIntent({ status: 'succeeded' });
    const res = await verify({ params: { session_id: 'cs_1' } });
    expect(JSON.parse(res.body)).toMatchObject({ success: true, verified: true, duplicate: true });
    expect(stripeVerifyPayment).not.toHaveBeenCalled();
  });
});
