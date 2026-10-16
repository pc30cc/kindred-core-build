// @vitest-environment node
/**
 * Widget rate limits that do not punish visitors behind one address
 * (carrier-grade NAT, an office), through the middleware chain server/index.ts
 * mounts — body parser, cookies, widgetCorsMiddleware, the per-IP / global
 * pre-auth limiters, the per-session limiter and the real widgetRouter — over
 * the in-memory database of the widget config tests.
 *
 *   - a request with a valid, workspace-bound visitor cookie (dvsid) is
 *     counted per VISITOR; one without is counted per (IP, workspace) at a
 *     larger anonymous cap, which also bounds how many cookies one address
 *     can mint; a forged or other-workspace cookie is no identity;
 *   - cookie-identified requests share a per-(IP, workspace) ceiling;
 *   - GET /config has its own bucket (`config`), not the bootstrap's;
 *   - a 429 says how long to wait (`retry_after`, `Retry-After`) and carries
 *     the CORS headers of a normal answer for an allowed origin (none for a
 *     refused one), with Retry-After exposed; the same for the call widget's
 *     pre-auth limiters;
 *   - the per-IP and per-process caps are read from the environment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createFakeDb, allowAllRpc, widgetScenarioTables, WS, SHOP_ORIGIN, type FakeDb } from '../widget/widgetConfigFakeDb';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-rate-identity';
process.env.WIDGET_VISITOR_SECRET = process.env.WIDGET_VISITOR_SECRET || 'test-visitor-secret-rate-identity';
const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => holder.db.client.from(t),
    rpc: (f: string, a?: Record<string, unknown>) => holder.db.client.rpc(f, a),
  }),
}));
vi.mock('../../../server/services/email/index.js', () => ({ sendEmail: vi.fn() }));
vi.mock('../../../server/services/geo/index.js', () => ({ enrichVisitorSessionGeo: vi.fn() }));

const { widgetRouter } = await import('../../../server/routes/widget.js');
const { callWidgetCors } = await import('../../../server/routes/callWidget.js');
const { jsonBodyParser } = await import('../../../server/middleware/bodyParsers.js');
const { widgetCorsMiddleware, applyWidgetCorsHeaders, WIDGET_CORS_MAX_AGE_SECONDS } = await import('../../../server/middleware/widgetCors.js');
const sec = await import('../../../server/middleware/security.js');
const { widgetRateLimit, __resetWidgetRateLimitsForTests } = await import('../../../server/services/widget/security.js');
const { setVisitorCookie } = await import('../../../server/services/widget/visitorIdentity.js');
const snapshotMod = await import('../../../server/services/widget/configSnapshot.js');

function buildApp() {
  const app = express();
  // server/index.ts: proxies on private networks are trusted, so the test
  // client (loopback) names its address in X-Forwarded-For.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use((req, _res, next) => {
    (req as unknown as { serverConfig: unknown }).serverConfig = {
      supabaseUrl: 'https://x.supabase.co',
      supabaseAnonKey: 'a',
      supabaseServiceRoleKey: 'SERVICE_KEY',
    };
    next();
  });
  app.use(jsonBodyParser());
  app.use(cookieParser());
  app.use('/api/widget/bootstrap', widgetCorsMiddleware(), sec.widgetBootstrapGlobalCeiling, sec.widgetBootstrapRateLimiter);
  app.use('/api/widget', widgetCorsMiddleware(), sec.widgetRateLimiter, sec.widgetWorkspaceRateLimiter, sec.widgetSessionRateLimiter, widgetRouter);
  app.use('/api/call-widget', callWidgetCors);
  app.use('/api/call-widget/bootstrap', sec.callWidgetBootstrapGlobalCeiling, sec.callWidgetBootstrapRateLimiter);
  app.use('/api/call-widget', sec.widgetRateLimiter, sec.widgetWorkspaceRateLimiter, sec.callWidgetSessionRateLimiter, (_req, res) => {
    res.json({ status: 'ok' });
  });
  return app;
}
const app = buildApp();

/** A signed dvsid cookie value, as bootstrap would have set it. */
function cookieValue(visitorId: string, workspaceId = WS): string {
  let header = '';
  const now = Math.floor(Date.now() / 1000);
  setVisitorCookie(
    { append: (_name: string, value: string) => { header = value; } } as unknown as Parameters<typeof setVisitorCookie>[0],
    { v: visitorId, w: workspaceId, iat: now, exp: now + 3600 },
  );
  return header.split(';')[0].slice('dvsid='.length);
}

let ipSeq = 10;
/** A fresh public client address per test: the limiter stores are per process. */
const freshIp = () => `45.33.${ipSeq++}.7`;

function bootstrap(ip: string, opts: { cookie?: string; origin?: string; workspaceId?: string } = {}) {
  const r = request(app).post('/api/widget/bootstrap')
    .set('Host', 'api.test')
    .set('X-Forwarded-For', ip)
    .set('Content-Type', 'text/plain;charset=UTF-8')
    .set('Origin', opts.origin ?? SHOP_ORIGIN);
  if (opts.cookie) r.set('Cookie', `dvsid=${opts.cookie}`);
  return r.send(JSON.stringify({ workspace_id: opts.workspaceId ?? WS }));
}

async function resetCaches() {
  snapshotMod.__resetWidgetConfigCachesForTests();
  (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
  (await import('../../../server/services/ai-agent/platformSettings.js')).__resetPlatformAiAgentSettingsCache();
  (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
  (await import('../../../server/services/billing/locks/state.js')).clearLockStateCache();
  (await import('../../../server/services/widget/public.js')).__resetWidgetOriginCaches();
}

beforeEach(async () => {
  holder.db = createFakeDb(widgetScenarioTables({ edition: 'international', ai: false, smart: false }), { rpc: allowAllRpc });
  await resetCaches();
  __resetWidgetRateLimitsForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('identity: per visitor with a verified cookie, per (IP, workspace) without', () => {
  it('400 page views from ONE address, each its own visitor, all succeed (past the 300 anonymous cap)', async () => {
    const ip = freshIp();
    for (let i = 0; i < 400; i++) {
      const res = await bootstrap(ip, { cookie: cookieValue(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) });
      expect(res.status, `page view ${i + 1}`).toBe(200);
    }
  }, 60_000);

  it('without a cookie the address gets 300 per workspace; a forged or other-workspace cookie counts as none; a valid one still passes', async () => {
    const ip = freshIp();
    for (let i = 0; i < 300; i++) {
      expect((await bootstrap(ip)).status, `anonymous ${i + 1}`).toBe(200);
    }
    const over = await bootstrap(ip);
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('RATE_LIMITED');

    const good = cookieValue('11111111-1111-4111-8111-111111111111');
    const forged = good.slice(0, -4) + (good.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect((await bootstrap(ip, { cookie: forged })).status).toBe(429);
    const otherWs = cookieValue('11111111-1111-4111-8111-111111111111', '99999999-9999-4999-8999-999999999999');
    expect((await bootstrap(ip, { cookie: otherWs })).status).toBe(429);
    expect((await bootstrap(ip, { cookie: good })).status).toBe(200);
  }, 60_000);

  it("one visitor's 31st bootstrap in a minute is a 429 that says how long to wait (and its CORS lets the loader read it)", async () => {
    // Forward from the real clock (a clock running backwards would starve the
    // snapshot's rebuild budget, which is not what this test is about).
    const t0 = Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000;
    vi.useFakeTimers({ toFake: ['Date'], now: t0 });
    const ip = freshIp();
    const cookie = cookieValue('22222222-2222-4222-8222-222222222222');
    for (let i = 0; i < 30; i++) expect((await bootstrap(ip, { cookie })).status).toBe(200);
    vi.setSystemTime(t0 + 45_000);
    const res = await bootstrap(ip, { cookie });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'RATE_LIMITED', retry_after: 15 });
    expect(res.headers['retry-after']).toBe('15');
    expect(res.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-expose-headers']).toMatch(/Retry-After/);
    // Another visitor on the same address is not affected.
    expect((await bootstrap(ip, { cookie: cookieValue('33333333-3333-4333-8333-333333333333') })).status).toBe(200);
  });

  it('a refused origin gets its 429 without any CORS header', async () => {
    const ip = freshIp();
    const cookie = cookieValue('44444444-4444-4444-8444-444444444444');
    for (let i = 0; i < 30; i++) {
      expect((await bootstrap(ip, { cookie, origin: 'https://evil.example' })).body.code).toBe('ORIGIN_DENIED');
    }
    const res = await bootstrap(ip, { cookie, origin: 'https://evil.example' });
    expect(res.status).toBe(429);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-expose-headers']).toBeUndefined();
  });

  it('GET /config no longer drains the bootstrap bucket (its own `config` category)', async () => {
    const ip = freshIp();
    const cookie = cookieValue('55555555-5555-4555-8555-555555555555');
    let token = '';
    for (let i = 0; i < 20; i++) {
      const boot = await bootstrap(ip, { cookie });
      expect(boot.status).toBe(200);
      token = boot.body.session_token;
      const cfg = await request(app).get(`/api/widget/config?workspace_id=${WS}`)
        .set('Host', 'api.test').set('X-Forwarded-For', ip).set('Origin', SHOP_ORIGIN)
        .set('X-Widget-Token', token).set('Cookie', `dvsid=${cookie}`);
      expect(cfg.status, `config ${i + 1}`).toBe(200);
    }
    // 20 old-loader page views (bootstrap + config) used 20 of 30 bootstraps.
    for (let i = 0; i < 10; i++) expect((await bootstrap(ip, { cookie })).status).toBe(200);
    expect((await bootstrap(ip, { cookie })).status).toBe(429);
    const cfg = await request(app).get(`/api/widget/config?workspace_id=${WS}`)
      .set('Host', 'api.test').set('X-Forwarded-For', ip).set('Origin', SHOP_ORIGIN)
      .set('X-Widget-Token', token).set('Cookie', `dvsid=${cookie}`);
    expect(cfg.status).toBe(429); // the config bucket's own visitor cap is 20
  });
});

describe('widgetRateLimit bucket arithmetic', () => {
  const run = (category: string, opts: { ip: string; cookie?: string; workspaceId?: unknown }) => {
    const req = {
      headers: {}, socket: { remoteAddress: opts.ip }, ip: opts.ip,
      body: { workspace_id: opts.workspaceId ?? WS },
      cookies: opts.cookie ? { dvsid: opts.cookie } : {},
    };
    let status = 0;
    const res = { setHeader: vi.fn(), status(c: number) { status = c; return res; }, json: vi.fn(() => res) };
    const next = vi.fn();
    widgetRateLimit(category)(req as never, res as never, next);
    return next.mock.calls.length ? 200 : status;
  };

  it('message: 15 per visitor, 240 for all identified visitors of one address and workspace, 60 without a cookie', () => {
    const ip = '45.1.1.1';
    let passed = 0;
    for (let v = 0; v < 20; v++) {
      const cookie = cookieValue(`66666666-0000-4000-8000-${String(v).padStart(12, '0')}`);
      for (let i = 0; i < 16; i++) if (run('message', { ip, cookie }) === 200) passed++;
    }
    expect(passed).toBe(240);
    let anonymous = 0;
    for (let i = 0; i < 70; i++) if (run('message', { ip }) === 200) anonymous++;
    expect(anonymous).toBe(60);
  });

  it('a refused request is not counted in the other bucket', () => {
    const ip = '45.1.1.2';
    const cookie = cookieValue('77777777-7777-4777-8777-777777777777');
    for (let i = 0; i < 15; i++) expect(run('message', { ip, cookie })).toBe(200);
    for (let i = 0; i < 50; i++) expect(run('message', { ip, cookie })).toBe(429);
    // The 50 refusals did not eat the address's shared allowance.
    let others = 0;
    for (let v = 0; v < 15; v++) {
      const c = cookieValue(`88888888-0000-4000-8000-${String(v).padStart(12, '0')}`);
      for (let i = 0; i < 15; i++) if (run('message', { ip, cookie: c }) === 200) others++;
    }
    expect(others).toBe(225); // 240 - 15
  });

  it('an oversized or non-string workspace_id is bucketed as "unknown", never as a key of its own', () => {
    const ip = '45.1.1.3';
    for (let i = 0; i < 300; i++) {
      expect(run('default', { ip, workspaceId: i % 2 ? 'x'.repeat(5000 + i) : { evil: i } })).toBe(200);
    }
    expect(run('default', { ip, workspaceId: 'y'.repeat(9000) })).toBe(429);
  });
});

describe('pre-auth and per-IP caps: environment, 429 body, CORS', () => {
  afterEach(() => {
    delete process.env.WIDGET_BOOTSTRAP_PER_IP_PER_MIN;
    delete process.env.WIDGET_BOOTSTRAP_GLOBAL_PER_MIN;
    delete process.env.CALL_WIDGET_BOOTSTRAP_PER_IP_PER_MIN;
    delete process.env.CALL_WIDGET_BOOTSTRAP_GLOBAL_PER_MIN;
    delete process.env.WIDGET_PER_IP_PER_MIN;
  });

  it('defaults: 1200 per IP for the widget API', () => {
    expect(sec.widgetPerIpPerMin()).toBe(1200);
    process.env.WIDGET_PER_IP_PER_MIN = '5000';
    expect(sec.widgetPerIpPerMin()).toBe(5000);
    process.env.WIDGET_PER_IP_PER_MIN = 'garbage';
    expect(sec.widgetPerIpPerMin()).toBe(1200);
  });

  it('WIDGET_BOOTSTRAP_PER_IP_PER_MIN: the per-IP 429 carries retry_after, Retry-After and the CORS of an allowed origin', async () => {
    process.env.WIDGET_BOOTSTRAP_PER_IP_PER_MIN = '3';
    const ip = freshIp();
    for (let i = 0; i < 3; i++) expect((await bootstrap(ip, { cookie: cookieValue(`99999999-0000-4000-8000-00000000000${i}`) })).status).toBe(200);
    const res = await bootstrap(ip, { cookie: cookieValue('99999999-0000-4000-8000-000000000009') });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('PREAUTH_RATE_LIMITED');
    expect(res.body.retry_after).toBeGreaterThanOrEqual(1);
    expect(res.body.retry_after).toBeLessThanOrEqual(60);
    expect(res.headers['retry-after']).toBe(String(res.body.retry_after));
    expect(res.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
    expect(res.headers['access-control-expose-headers']).toMatch(/Retry-After/);
  });

  it('WIDGET_BOOTSTRAP_GLOBAL_PER_MIN: the per-process ceiling answers 429 with retry_after and CORS', async () => {
    process.env.WIDGET_BOOTSTRAP_GLOBAL_PER_MIN = '1';
    const res = await bootstrap(freshIp());
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'PREAUTH_GLOBAL_LIMIT', scope: 'widget-bootstrap' });
    expect(res.headers['retry-after']).toBe(String(res.body.retry_after));
    expect(res.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
  });

  it('call widget: its pre-auth 429s now pass through its CORS first (readable by l.js), Retry-After exposed', async () => {
    process.env.CALL_WIDGET_BOOTSTRAP_PER_IP_PER_MIN = '2';
    const ip = freshIp();
    const get = () => request(app).get('/api/call-widget/bootstrap?publicKey=pk_test')
      .set('X-Forwarded-For', ip).set('Origin', 'https://calls.example');
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('PREAUTH_RATE_LIMITED');
    expect(res.headers['retry-after']).toBe(String(res.body.retry_after));
    expect(res.headers['access-control-allow-origin']).toBe('https://calls.example');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-expose-headers']).toMatch(/Retry-After/);

    process.env.CALL_WIDGET_BOOTSTRAP_GLOBAL_PER_MIN = '1';
    const busy = await request(app).get('/api/call-widget/bootstrap?publicKey=pk_test')
      .set('X-Forwarded-For', freshIp()).set('Origin', 'https://calls.example');
    expect(busy.status).toBe(429);
    expect(busy.body.code).toBe('PREAUTH_GLOBAL_LIMIT');
    expect(busy.headers['access-control-allow-origin']).toBe('https://calls.example');
  });
});

describe('preflight lifetime: one constant for both widgets', () => {
  it('is 7200 s (Chromium’s cap) on the chat widget and the call widget preflights', async () => {
    expect(WIDGET_CORS_MAX_AGE_SECONDS).toBe(7200);
    const chat = await request(app).options('/api/widget/poll').set('Origin', SHOP_ORIGIN)
      .set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'x-widget-token');
    expect(chat.status).toBe(204);
    expect(chat.headers['access-control-max-age']).toBe('7200');
    const call = await request(app).options('/api/call-widget/calls/x/status').set('Origin', 'https://calls.example')
      .set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'x-cc-session');
    expect(call.status).toBe(204);
    expect(call.headers['access-control-max-age']).toBe('7200');

    const headers: Record<string, string> = {};
    applyWidgetCorsHeaders({ setHeader: (k: string, v: string) => { headers[k] = v; } } as never, SHOP_ORIGIN);
    expect(headers['Access-Control-Max-Age']).toBe('7200');
    expect(headers['Access-Control-Expose-Headers']).toBe('Retry-After');
    expect(headers['Access-Control-Allow-Origin']).not.toBe('*');
  });
});
