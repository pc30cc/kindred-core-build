/**
 * The visitor credential (server/services/widget/visitorIdentity.ts): the
 * fallback identity for browsers that drop the HttpOnly `dvsid` cookie
 * (Safari, Brave), run through the REAL widget router, CORS middleware,
 * body parser and session token gate, with only the database faked.
 *
 *   - the bootstrap returns it (and whether the cookie came), and a later
 *     bootstrap that carries it but no cookie is the SAME visitor;
 *   - the cookie always wins over it; a credential of another workspace,
 *     an expired, a tampered one, or a cookie value passed as one, is no
 *     identity; a fresh visitor (`fresh_visitor`) never inherits it;
 *   - on a token-gated route the `X-Widget-Visitor` header proves the
 *     visitor's ownership of their conversation exactly as the cookie does;
 *   - the CORS preflight allows the header.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createFakeDb, allowAllRpc, widgetScenarioTables, WS, SHOP_ORIGIN, type FakeDb } from './widgetConfigFakeDb';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-visitor-credential';
const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => holder.db.client.from(t),
    rpc: (f: string, a?: Record<string, unknown>) => holder.db.client.rpc(f, a),
  }),
}));
vi.mock('../../../server/services/widget/manifest.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/widget/manifest.js')>();
  const hashed = (n: string) => n.replace(/\.(js|css)$/, (m) => `.abcdef12${m}`);
  return {
    ...real,
    getWidgetAssetName: (n: string) => hashed(n),
    getOptionalWidgetAssetName: (n: string) => (n.includes('fonts') || n.includes('intl') ? hashed(n) : null),
    getLoaderVersion: () => 'lv123456789a',
  };
});
vi.mock('../../../server/services/email/index.js', () => ({ sendEmail: vi.fn() }));
vi.mock('../../../server/services/geo/index.js', () => ({ enrichVisitorSessionGeo: vi.fn() }));

const { widgetRouter } = await import('../../../server/routes/widget.js');
const { jsonBodyParser } = await import('../../../server/middleware/bodyParsers.js');
const { widgetCorsMiddleware } = await import('../../../server/middleware/widgetCors.js');
const sec = await import('../../../server/middleware/security.js');
const snapshotMod = await import('../../../server/services/widget/configSnapshot.js');
const identity = await import('../../../server/services/widget/visitorIdentity.js');

const OTHER_WS = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { serverConfig: unknown }).serverConfig = {
      supabaseUrl: 'https://x.supabase.co',
      supabaseAnonKey: 'a',
      supabaseServiceRoleKey: 'SERVICE_KEY',
    };
    next();
  });
  // server/index.ts: the body parser, then cookies, then the widget mounts.
  app.use(jsonBodyParser());
  app.use(cookieParser());
  app.use(['/api/widget/bootstrap', '/api/widget/boot'], widgetCorsMiddleware(), sec.widgetBootstrapGlobalCeiling, sec.widgetBootstrapRateLimiter);
  app.use('/api/widget', widgetCorsMiddleware(), sec.widgetRateLimiter, sec.widgetWorkspaceRateLimiter, sec.widgetSessionRateLimiter, widgetRouter);
  return app;
}
const app = buildApp();

let clock = new Date('2026-10-21T10:00:00Z').getTime();

async function scenario(edit?: (t: ReturnType<typeof widgetScenarioTables>) => void) {
  clock += 61_000;
  vi.setSystemTime(clock);
  const tables = widgetScenarioTables({ edition: 'iran', ai: false, smart: false });
  edit?.(tables);
  holder.db = createFakeDb(tables, { rpc: allowAllRpc });
  snapshotMod.__resetWidgetConfigCachesForTests();
  (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
  (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
  (await import('../../../server/services/billing/locks/state.js')).clearLockStateCache();
  (await import('../../../server/services/widget/public.js')).__resetWidgetOriginCaches();
}

/** The loader's CORS-simple bootstrap: JSON labelled text/plain, no custom header. */
function boot(body: Record<string, unknown>, cookie?: string) {
  const r = request(app).post('/api/widget/boot').set('Host', 'api.test').set('Origin', SHOP_ORIGIN)
    .set('Content-Type', 'text/plain;charset=UTF-8');
  if (cookie) r.set('Cookie', cookie);
  return r.send(JSON.stringify({ workspace_id: WS, ...body }));
}

/** The dvsid cookie a response set, as a Cookie header. */
function dvsidOf(res: request.Response): string {
  const set = ([] as string[]).concat(res.headers['set-cookie'] || []);
  const c = set.find((v) => v.startsWith('dvsid=') && !v.startsWith('dvsid=;'));
  if (!c) throw new Error('no dvsid cookie set');
  return c.split(';')[0];
}

const nowS = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: clock });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the bootstrap: the credential, and the same visitor without the cookie', () => {
  it('a first bootstrap returns the credential and says the cookie did not come', async () => {
    await scenario();
    const first = await boot({});
    expect(first.status).toBe(200);
    expect(typeof first.body.visitor_credential).toBe('string');
    expect(first.body.visitor_credential.length).toBeGreaterThan(40);
    expect(first.body.visitor_cookie).toBe(false);
    expect(first.body.is_new_visitor).toBe(true);
    // The cookie stays the primary identity: it is still set.
    expect(dvsidOf(first)).toMatch(/^dvsid=/);
  });

  it('a browser that dropped the cookie but sends the credential is the SAME visitor', async () => {
    await scenario();
    const first = await boot({});
    const again = await boot({ visitor_credential: first.body.visitor_credential });
    expect(again.status).toBe(200);
    expect(again.body.visitor_id).toBe(first.body.visitor_id);
    expect(again.body.is_new_visitor).toBe(false);
    expect(again.body.visitor_cookie).toBe(false);
  });

  it('a browser that keeps the cookie is told so (the loader then stores nothing)', async () => {
    await scenario();
    const first = await boot({});
    const again = await boot({}, dvsidOf(first));
    expect(again.body.visitor_id).toBe(first.body.visitor_id);
    expect(again.body.visitor_cookie).toBe(true);
    // Nor is it handed a credential: whoever made the browser send the
    // cookie gets no token to replay without it.
    expect(again.body.visitor_credential).toBe('');
  });

  it('the cookie wins over a credential of another visitor', async () => {
    await scenario();
    const a = await boot({});
    const b = await boot({});
    expect(b.body.visitor_id).not.toBe(a.body.visitor_id);
    const both = await boot({ visitor_credential: b.body.visitor_credential }, dvsidOf(a));
    expect(both.body.visitor_id).toBe(a.body.visitor_id);
  });

  it('is no identity when it names another workspace, has expired, was tampered with, or is a cookie value', async () => {
    await scenario();
    const first = await boot({});
    const v = first.body.visitor_id as string;
    const otherWs = identity.issueVisitorCredential({ v, w: OTHER_WS, iat: nowS(), exp: nowS() + 3600 });
    const expired = identity.issueVisitorCredential({ v, w: WS, iat: nowS() - 7200, exp: nowS() - 60 });
    const [payload, sig] = String(first.body.visitor_credential).split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ v: '99999999-9999-4999-8999-999999999999', w: WS, iat: nowS(), exp: nowS() + 3600 })).toString('base64url');
    const tampered = `${forgedPayload}.${sig}`;
    const cookieValue = decodeURIComponent(dvsidOf(first).slice('dvsid='.length));
    expect(payload).toBeTruthy();
    for (const credential of [otherWs, expired, tampered, cookieValue]) {
      const res = await boot({ visitor_credential: credential });
      expect(res.body.visitor_id, credential.slice(0, 16)).not.toBe(v);
      expect(res.body.is_new_visitor).toBe(true);
    }
  });

  it('a new signed-in person on this browser (`fresh_visitor`) never inherits it', async () => {
    await scenario();
    const first = await boot({});
    const fresh = await boot({ visitor_credential: first.body.visitor_credential, fresh_visitor: true });
    expect(fresh.body.visitor_id).not.toBe(first.body.visitor_id);
    expect(fresh.body.is_new_visitor).toBe(true);
  });

  it('carries the same lifetime as the cookie and is renewed with it near the end', async () => {
    await scenario();
    const v = '11111111-2222-4333-8444-555555555555';
    // 10 days left (under the 30-day rotation threshold).
    const old = identity.issueVisitorCredential({ v, w: WS, iat: nowS() - 355 * 86400, exp: nowS() + 10 * 86400 });
    const res = await boot({ visitor_credential: old });
    expect(res.body.visitor_id).toBe(v);
    const renewed = JSON.parse(Buffer.from(String(res.body.visitor_credential).split('.')[0], 'base64url').toString());
    expect(renewed.v).toBe(v);
    expect(renewed.w).toBe(WS);
    expect(renewed.exp - nowS()).toBeGreaterThan(360 * 86400);
  });
});

describe('a token-gated route: the header proves the visitor like the cookie', () => {
  const CONV = 'c0ffee00-0000-4000-8000-000000000001';

  async function seeded() {
    let visitorId = '';
    await scenario((t) => {
      t.conversations = [{ id: CONV, workspace_id: WS, status: 'open', assigned_to: null, contact_id: null, visitor_session_id: null, metadata: { visitor_id: '__set_below__' }, updated_at: new Date().toISOString() }];
      t.conversation_messages = [{ id: 'm0000000-0000-4000-8000-000000000001', conversation_id: CONV, sender_type: 'agent', sender_id: null, body: 'Hello from the team', created_at: new Date().toISOString(), metadata: {}, seen_at: null, reply_to_message_id: null }];
    });
    const first = await boot({});
    visitorId = first.body.visitor_id;
    (holder.db.tables.conversations[0].metadata as Record<string, unknown>).visitor_id = visitorId;
    return { token: first.body.session_token as string, credential: first.body.visitor_credential as string };
  }

  function poll(token: string, headers: Record<string, string> = {}) {
    const r = request(app).get(`/api/widget/poll?workspace_id=${WS}&conversation_id=${CONV}`)
      .set('Host', 'api.test').set('Origin', SHOP_ORIGIN).set('X-Widget-Token', token);
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return r;
  }

  it('without the cookie, the X-Widget-Visitor header reads the visitor\'s own conversation', async () => {
    const { token, credential } = await seeded();
    const res = await poll(token, { 'X-Widget-Visitor': credential });
    expect(res.status).toBe(200);
    expect(res.body.conversation_id).toBe(CONV);
    expect((res.body.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(['Hello from the team']);
  });

  it('without either, or with another visitor\'s credential, the conversation is not theirs', async () => {
    const { token } = await seeded();
    const none = await poll(token);
    expect(none.body.conversation_id).toBeNull();
    expect(none.body.messages).toEqual([]);
    const stranger = identity.issueVisitorCredential({ v: '22222222-3333-4444-8555-666666666666', w: WS, iat: nowS(), exp: nowS() + 3600 });
    const other = await poll(token, { 'X-Widget-Visitor': stranger });
    expect(other.body.conversation_id).toBeNull();
  });
});

describe('CORS', () => {
  it('the preflight allows the X-Widget-Visitor header', async () => {
    await scenario();
    const res = await request(app).options('/api/widget/message').set('Host', 'api.test').set('Origin', SHOP_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-widget-token,x-widget-visitor');
    expect(res.status).toBe(204);
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('x-widget-visitor');
  });
});

describe('readVisitorCookie: the credential only where a workspace is checked', () => {
  it('reads the header when no cookie identifies a visitor of the workspace, and never without a workspace', () => {
    const v = '33333333-4444-4555-8666-777777777777';
    const credential = identity.issueVisitorCredential({ v, w: WS, iat: nowS(), exp: nowS() + 3600 });
    const req = { headers: { 'x-widget-visitor': credential }, cookies: {}, method: 'GET', originalUrl: '/api/widget/poll' } as unknown as Parameters<typeof identity.readVisitorCookie>[0];
    expect(identity.readVisitorCookie(req, WS)?.v).toBe(v);
    expect(identity.readVisitorCookie(req, OTHER_WS)).toBeNull();
    expect(identity.readVisitorCookie(req)).toBeNull();
  });

  it('takes the body field only on the CORS-simple paths (bootstrap, /track, /visitor-presence)', () => {
    const v = '44444444-5555-4666-8777-888888888888';
    const credential = identity.issueVisitorCredential({ v, w: WS, iat: nowS(), exp: nowS() + 3600 });
    const on = (path: string) => ({ headers: {}, cookies: {}, method: 'POST', originalUrl: path, body: { visitor_credential: credential } }) as unknown as Parameters<typeof identity.readVisitorCookie>[0];
    expect(identity.readVisitorCookie(on('/api/widget/track'), WS)?.v).toBe(v);
    expect(identity.readVisitorCookie(on('/api/realtime/visitor-presence'), WS)?.v).toBe(v);
    expect(identity.readVisitorCookie(on('/api/widget/boot'), WS)?.v).toBe(v);
    expect(identity.readVisitorCookie(on('/api/widget/message'), WS)).toBeNull();
  });
});
