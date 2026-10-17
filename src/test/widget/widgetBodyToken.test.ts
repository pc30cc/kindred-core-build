// @vitest-environment node
/**
 * The last preflight of a page view: POST /api/widget/track and POST
 * /api/realtime/visitor-presence may carry the widget session token as
 * `widget_token` in a text/plain JSON body (a CORS-simple request) instead of
 * the X-Widget-Token header — on exactly those two paths, through the same
 * verifier, the same Origin binding, the same CORS decision and the same
 * per-session bucket as the header. Never from the query string, never on
 * any other path. The bootstrap says `protocol: 3` to tell the loader.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Request } from 'express';
import { createFakeDb, allowAllRpc, widgetScenarioTables, WS, SHOP_ORIGIN, type FakeDb } from './widgetConfigFakeDb';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-body-token';
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
const { realtimeRouter } = await import('../../../server/routes/realtime.js');
const { jsonBodyParser } = await import('../../../server/middleware/bodyParsers.js');
const { widgetCorsMiddleware } = await import('../../../server/middleware/widgetCors.js');
const sec = await import('../../../server/middleware/security.js');
const { createSessionToken, readWidgetToken, __resetWidgetRateLimitsForTests } = await import('../../../server/services/widget/security.js');
const snapshotMod = await import('../../../server/services/widget/configSnapshot.js');

function buildApp() {
  const app = express();
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use((req, _res, next) => {
    (req as unknown as { serverConfig: unknown }).serverConfig = {
      supabaseUrl: 'https://x.supabase.co',
      supabaseAnonKey: 'a',
      supabaseServiceRoleKey: 'SERVICE_KEY',
    };
    next();
  });
  // server/index.ts, in order.
  app.use(jsonBodyParser());
  app.use(cookieParser());
  app.post('/api/widget/body-probe', (req, res) => res.json({ body: req.body ?? null }));
  app.use('/api/widget/bootstrap', widgetCorsMiddleware(), sec.widgetBootstrapGlobalCeiling, sec.widgetBootstrapRateLimiter);
  app.use('/api/widget', widgetCorsMiddleware(), sec.widgetRateLimiter, sec.widgetWorkspaceRateLimiter, sec.widgetSessionRateLimiter, widgetRouter);
  app.use(['/api/realtime/visitor-presence'], widgetCorsMiddleware());
  app.use('/api/realtime', realtimeRouter);
  return app;
}
const app = buildApp();

async function resetCaches() {
  snapshotMod.__resetWidgetConfigCachesForTests();
  (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
  (await import('../../../server/services/ai-agent/platformSettings.js')).__resetPlatformAiAgentSettingsCache();
  (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
  (await import('../../../server/services/billing/locks/state.js')).clearLockStateCache();
  (await import('../../../server/services/widget/public.js')).__resetWidgetOriginCaches();
}

let ipSeq = 1;
const freshIp = () => `45.60.${ipSeq++ % 250}.${Math.floor(ipSeq / 250) + 1}`;

/** The CORS-simple form the loader sends to a protocol-3 backend: no header at all. */
function simplePost(path: string, body: Record<string, unknown>, opts: { origin?: string; ip?: string; query?: string } = {}) {
  return request(app).post(path + (opts.query ? `?${opts.query}` : ''))
    .set('Host', 'api.test')
    .set('X-Forwarded-For', opts.ip ?? freshIp())
    .set('Origin', opts.origin ?? SHOP_ORIGIN)
    .set('Content-Type', 'text/plain;charset=UTF-8')
    .send(JSON.stringify(body));
}

const trackBody = (extra: Record<string, unknown> = {}) => ({
  workspace_id: WS, event: 'page_view', current_page: 'https://shop.example/p', visitor_id: 'aaaaaaaa-0000-4000-8000-000000000001', ...extra,
});

beforeEach(async () => {
  holder.db = createFakeDb(widgetScenarioTables({ edition: 'international', ai: false, smart: false }), { rpc: allowAllRpc });
  await resetCaches();
  __resetWidgetRateLimitsForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('body parsing', () => {
  it('text/plain JSON is parsed on /track and /visitor-presence (64 KB), application/json as before, and not on other paths', async () => {
    const probe = await request(app).post('/api/widget/body-probe').set('Content-Type', 'text/plain').send('{"a":1}');
    expect(probe.body.body).toEqual({});
    const bad = await request(app).post('/api/widget/track').set('Origin', SHOP_ORIGIN).set('X-Forwarded-For', freshIp())
      .set('Content-Type', 'text/plain;charset=UTF-8').send('{"workspace_id":');
    expect(bad.status).toBe(400);
    const parsed = await simplePost('/api/widget/track', trackBody({ widget_token: createSessionToken(WS, SHOP_ORIGIN) }));
    expect(parsed.status).toBe(200);
    const big = await simplePost('/api/widget/track', trackBody({ widget_token: createSessionToken(WS, SHOP_ORIGIN), pad: 'x'.repeat(65 * 1024) }));
    expect(big.status).toBe(413);
    // A large JSON body (old loader) keeps the normal parser's limit.
    const json = await request(app).post('/api/widget/track').set('Origin', SHOP_ORIGIN).set('X-Forwarded-For', freshIp())
      .set('X-Widget-Token', createSessionToken(WS, SHOP_ORIGIN))
      .send(trackBody({ pad: 'x'.repeat(65 * 1024) }));
    expect(json.status).toBe(200);
  });
});

describe('readWidgetToken', () => {
  const req = (o: Partial<Record<string, unknown>>) => ({ method: 'POST', headers: {}, body: {}, originalUrl: '/api/widget/track', ...o }) as unknown as Request;
  it('the header wins; the body only for a POST to /api/widget/track or /api/realtime/visitor-presence; never the query', () => {
    expect(readWidgetToken(req({ headers: { 'x-widget-token': 'h' }, body: { widget_token: 'b' } }))).toBe('h');
    expect(readWidgetToken(req({ body: { widget_token: 'b' } }))).toBe('b');
    expect(readWidgetToken(req({ originalUrl: '/api/realtime/visitor-presence?x=1', body: { widget_token: 'b' } }))).toBe('b');
    expect(readWidgetToken(req({ method: 'GET', body: { widget_token: 'b' } }))).toBeNull();
    for (const path of ['/api/widget/event', '/api/widget/poll', '/api/widget/session/refresh', '/api/widget/track/x', '/api/realtime/connect']) {
      expect(readWidgetToken(req({ originalUrl: path, body: { widget_token: 'b' } })), path).toBeNull();
    }
    expect(readWidgetToken(req({ query: { widget_token: 'q' }, originalUrl: '/api/widget/track?widget_token=q' }))).toBeNull();
    expect(readWidgetToken(req({ body: { widget_token: { not: 'a string' } } }))).toBeNull();
  });
});

describe('POST /api/widget/track, CORS-simple', () => {
  it('the bootstrap says protocol 3; its token in the body is accepted and the answer is readable by the page (CORS)', async () => {
    const boot = await simplePost('/api/widget/bootstrap', { workspace_id: WS });
    expect(boot.status).toBe(200);
    expect(boot.body.protocol).toBe(3);
    const res = await simplePost('/api/widget/track', trackBody({ widget_token: boot.body.session_token }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('is held to the same token checks as the header: missing → 401, forged → 403, another origin → 403 ORIGIN_MISMATCH', async () => {
    expect((await simplePost('/api/widget/track', trackBody())).body.code).toBe('MISSING_TOKEN');
    const good = createSessionToken(WS, SHOP_ORIGIN);
    const forged = good.slice(0, -3) + (good.endsWith('aaa') ? 'bbb' : 'aaa');
    const f = await simplePost('/api/widget/track', trackBody({ widget_token: forged }));
    expect([f.status, f.body.code]).toEqual([403, 'INVALID_TOKEN']);
    const other = await simplePost('/api/widget/track', trackBody({ widget_token: createSessionToken(WS, 'https://other.example') }));
    expect([other.status, other.body.code]).toEqual([403, 'ORIGIN_MISMATCH']);
    // …exactly what the header form answers.
    const viaHeader = await request(app).post('/api/widget/track').set('Origin', SHOP_ORIGIN).set('X-Forwarded-For', freshIp())
      .set('X-Widget-Token', createSessionToken(WS, 'https://other.example')).send(trackBody());
    expect([viaHeader.status, viaHeader.body.code]).toEqual([403, 'ORIGIN_MISMATCH']);
  });

  it('never in the URL, and only on its two paths', async () => {
    const token = createSessionToken(WS, SHOP_ORIGIN);
    const q = await simplePost('/api/widget/track', trackBody(), { query: `widget_token=${encodeURIComponent(token)}` });
    expect(q.body.code).toBe('MISSING_TOKEN');
    const ev = await request(app).post('/api/widget/event').set('Origin', SHOP_ORIGIN).set('X-Forwarded-For', freshIp())
      .send({ workspace_id: WS, event_name: 'x', widget_token: token });
    expect(ev.status).toBe(401);
  });

  it('a workspace without an allow-list: CORS still follows the token’s own origin binding, from the body', async () => {
    holder.db.tables.widget_settings[0].allowed_domains = [];
    const token = createSessionToken(WS, 'https://unlisted.example');
    const res = await simplePost('/api/widget/track', trackBody({ widget_token: token }), { origin: 'https://unlisted.example' });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://unlisted.example');
    const other = await simplePost('/api/widget/track', trackBody({ widget_token: token }), { origin: 'https://elsewhere.example' });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('counts in the SAME per-session bucket as the header (one session layer, 300/min)', async () => {
    const token = createSessionToken(WS, SHOP_ORIGIN);
    for (let i = 0; i < 299; i++) {
      const r = await request(app).post('/api/widget/track').set('Origin', SHOP_ORIGIN)
        .set('X-Forwarded-For', `45.70.${Math.floor(i / 250)}.${(i % 250) + 1}`)
        .set('X-Widget-Token', token).send(trackBody());
      expect(r.status).toBe(200);
    }
    expect((await simplePost('/api/widget/track', trackBody({ widget_token: token }))).status).toBe(200); // #300
    const over = await simplePost('/api/widget/track', trackBody({ widget_token: token }));
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('SESSION_RATE_LIMITED');
  }, 60_000);
});

describe('POST /api/realtime/visitor-presence, CORS-simple', () => {
  const SESSION = 'bbbbbbbb-0000-4000-8000-000000000001';
  it('takes the body token like the header, and refuses a missing or other-workspace one', async () => {
    const ok = await simplePost('/api/realtime/visitor-presence', { workspace_id: WS, session_id: SESSION, widget_token: createSessionToken(WS, SHOP_ORIGIN) });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ vendor: 'database', presence: false });
    expect(ok.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
    const missing = await simplePost('/api/realtime/visitor-presence', { workspace_id: WS, session_id: SESSION });
    expect(missing.status).toBe(401);
    const otherWs = await simplePost('/api/realtime/visitor-presence', {
      workspace_id: WS, session_id: SESSION, widget_token: createSessionToken('99999999-9999-4999-8999-999999999999', SHOP_ORIGIN),
    });
    expect(otherWs.status).toBe(401);
  });
});
