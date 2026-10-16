// @vitest-environment node
/**
 * POST /api/widget/bootstrap with `include_config`, sent as text/plain (the
 * loader's CORS-simple request), through the middleware chain server/index.ts
 * mounts for the widget: the JSON body parser (middleware/bodyParsers.ts),
 * cookies, widgetCorsMiddleware, the pre-auth and per-IP limiters, and the
 * real widgetRouter — over an in-memory database that counts every read.
 *
 *   - text/plain JSON is parsed on /api/widget/bootstrap (16 KB) and not on
 *     other widget paths (/track and /visitor-presence: widgetBodyToken.test.ts);
 *   - `config` is exactly the GET /config body (same JSON text), for both
 *     editions, AI on/off and smart rules on/off, under a fixed clock;
 *   - no `config` without the flag, or when GET /config would not be a 200;
 *   - disabled / not found / ORIGIN_DENIED / ORIGIN_REQUIRED / MISSING_WORKSPACE
 *     answer exactly as before, `protocol` (3) only on what the handler answers;
 *   - a second page view (bootstrap + GET /config) reads nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { STATUS_CODES } from 'node:http';
import { createFakeDb, allowAllRpc, widgetScenarioTables, WS, SHOP_ORIGIN, type FakeDb } from './widgetConfigFakeDb';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-inline-config';
const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => holder.db.client.from(t),
    rpc: (f: string, a?: Record<string, unknown>) => holder.db.client.rpc(f, a),
  }),
}));
// A built manifest: every asset content-hashed.
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
  app.use('/api/widget/bootstrap', widgetCorsMiddleware(), sec.widgetBootstrapGlobalCeiling, sec.widgetBootstrapRateLimiter);
  app.post('/api/widget/track-probe', (req, res) => res.json({ body: req.body ?? null }));
  app.use('/api/widget', widgetCorsMiddleware(), sec.widgetRateLimiter, sec.widgetWorkspaceRateLimiter, sec.widgetSessionRateLimiter, widgetRouter);
  // server/index.ts's error handler: body-parser's 4xx keep their status.
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const status = Number(err.status);
    if (res.headersSent) return next(err);
    if (status >= 400 && status < 500) return res.status(status).json({ error: STATUS_CODES[status] || 'Bad Request' });
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
const app = buildApp();

const T0 = new Date('2026-10-14T10:00:00Z').getTime();
let clock = T0;

async function resetCaches() {
  snapshotMod.__resetWidgetConfigCachesForTests();
  (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
  (await import('../../../server/services/ai-agent/platformSettings.js')).__resetPlatformAiAgentSettingsCache();
  (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
  (await import('../../../server/services/billing/locks/state.js')).clearLockStateCache();
  (await import('../../../server/services/widget/public.js')).__resetWidgetOriginCaches();
}

/** A fresh database and caches; the clock moves past every rate-limit window. */
async function scenario(opts: Parameters<typeof widgetScenarioTables>[0], edit?: (t: ReturnType<typeof widgetScenarioTables>) => void) {
  clock += 61_000;
  vi.setSystemTime(clock);
  const tables = widgetScenarioTables(opts);
  edit?.(tables);
  holder.db = createFakeDb(tables, { rpc: allowAllRpc });
  await resetCaches();
}

/** The loader's bootstrap: a CORS-simple POST, the JSON body labelled text/plain. */
function bootstrapTextPlain(body: Record<string, unknown>, origin: string | null = SHOP_ORIGIN) {
  const r = request(app).post('/api/widget/bootstrap').set('Host', 'api.test').set('Content-Type', 'text/plain;charset=UTF-8');
  if (origin) r.set('Origin', origin);
  return r.send(JSON.stringify(body));
}

function getConfig(token: string) {
  return request(app).get(`/api/widget/config?workspace_id=${WS}`)
    .set('Host', 'api.test').set('Origin', SHOP_ORIGIN).set('X-Widget-Token', token);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: clock });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('body parsing', () => {
  it('parses a text/plain JSON body on /api/widget/bootstrap, and not on an arbitrary widget path', async () => {
    await scenario({ edition: 'international', ai: true, smart: true });
    const boot = await bootstrapTextPlain({ workspace_id: WS });
    expect(boot.status).toBe(200);
    expect(typeof boot.body.session_token).toBe('string');
    expect(boot.body.workspace_id).toBe(WS);

    const probe = await request(app).post('/api/widget/track-probe').set('Content-Type', 'text/plain').send(JSON.stringify({ a: 1 }));
    expect(probe.body.body).toEqual({});
    const probeJson = await request(app).post('/api/widget/track-probe').set('Content-Type', 'application/json').send(JSON.stringify({ a: 1 }));
    expect(probeJson.body.body).toEqual({ a: 1 });
  });

  it('a malformed text/plain body is a 400; a body over 16 KB is a 413', async () => {
    await scenario({ edition: 'international', ai: true, smart: true });
    const bad = await request(app).post('/api/widget/bootstrap').set('Origin', SHOP_ORIGIN).set('Content-Type', 'text/plain').send('{"workspace_id":');
    expect(bad.status).toBe(400);
    const big = await bootstrapTextPlain({ workspace_id: WS, pad: 'x'.repeat(17 * 1024) });
    expect(big.status).toBe(413);
  });
});

describe('include_config: the GET /config body inline', () => {
  const cases: Array<Parameters<typeof widgetScenarioTables>[0]> = [];
  for (const edition of ['iran', 'international'] as const) {
    for (const ai of [true, false]) {
      for (const smart of [true, false]) cases.push({ edition, ai, smart });
    }
  }

  it.each(cases)('is byte-identical to GET /config — %o', async (opts) => {
    await scenario(opts);
    const boot = await bootstrapTextPlain({ workspace_id: WS, include_config: true });
    expect(boot.status).toBe(200);
    expect(boot.body.protocol).toBe(3);
    expect(boot.body.config).toBeTypeOf('object');
    const cfg = await getConfig(boot.body.session_token);
    expect(cfg.status).toBe(200);
    expect(JSON.stringify(boot.body.config)).toBe(cfg.text);
    expect(boot.body.config).toEqual(cfg.body);
    // The edition / AI / smart branches really differ between the cases.
    expect(cfg.body.edition).toBe(opts.edition);
    expect(cfg.body.smart.enabled).toBe(opts.smart);
    expect(cfg.body.aiAgent.disabledByPlatform).toBe(!opts.ai);
    // Hashed assets carry no ?v=; the realtime modules are named.
    expect(cfg.body.runtimeUrl).toBe('https://app.test/widget/runtime.abcdef12.js');
    expect(cfg.body.modules.rt_centrifugo).toBe('https://app.test/widget/runtime-rt-centrifugo.abcdef12.js');
  });

  it('without the flag there is no config key (an old loader sees the old shape)', async () => {
    await scenario({ edition: 'iran', ai: true, smart: true });
    const boot = await request(app).post('/api/widget/bootstrap').set('Host', 'api.test').set('Origin', SHOP_ORIGIN)
      .set('Content-Type', 'application/json').send({ workspace_id: WS });
    expect(boot.status).toBe(200);
    expect(boot.body).not.toHaveProperty('config');
    expect(Object.keys(boot.body)).toEqual([
      'session_token', 'workspace_id', 'workspace_name', 'expires_at', 'platform_display_name', 'edition',
      'visitor_id', 'is_new_visitor', 'availability', 'effective_policy', 'version', 'protocol',
    ]);
  });

  it('no config when GET /config would not be a 200 (no widget_settings row): the loader then asks, and gets the same 404', async () => {
    await scenario({ edition: 'international', ai: true, smart: true }, (t) => { t.widget_settings = []; });
    const boot = await bootstrapTextPlain({ workspace_id: WS, include_config: true });
    expect(boot.status).toBe(200);
    expect(boot.body).not.toHaveProperty('config');
    const cfg = await getConfig(boot.body.session_token);
    expect(cfg.status).toBe(404);
    expect(cfg.body).toEqual({ error: 'Widget not found or not configured' });
  });

  it('a second page view reads nothing (bootstrap + GET /config)', async () => {
    await scenario({ edition: 'international', ai: true, smart: true });
    const first = await bootstrapTextPlain({ workspace_id: WS, include_config: true });
    await getConfig(first.body.session_token);
    holder.db.resetCalls();
    const second = await bootstrapTextPlain({ workspace_id: WS, include_config: true });
    expect(second.status).toBe(200);
    expect(second.body.config).toBeTypeOf('object');
    const cfg = await getConfig(second.body.session_token);
    expect(cfg.status).toBe(200);
    expect(holder.db.calls.log).toEqual([]);
  });
});

describe('unchanged answers', () => {
  it('disabled widget: {disabled, fallback} (+ protocol), no token, no config', async () => {
    await scenario({ edition: 'iran', ai: true, smart: true }, (t) => { t.widget_settings[0].enabled = false; });
    const boot = await bootstrapTextPlain({ workspace_id: WS, include_config: true });
    expect(boot.status).toBe(200);
    expect(boot.body).toEqual({ disabled: true, fallback: true, protocol: 3 });
  });

  it('unknown workspace: 404 {disabled, error} as before', async () => {
    await scenario({ edition: 'iran', ai: true, smart: true });
    const boot = await bootstrapTextPlain({ workspace_id: '99999999-9999-4999-8999-999999999999', include_config: true });
    expect(boot.status).toBe(404);
    expect(boot.body).toEqual({ disabled: true, error: 'Workspace not found' });
  });

  it('an origin outside the allow-list: 403 ORIGIN_DENIED, no credential, no CORS grant', async () => {
    await scenario({ edition: 'iran', ai: true, smart: true });
    const boot = await bootstrapTextPlain({ workspace_id: WS, include_config: true }, 'https://evil.example');
    expect(boot.status).toBe(403);
    expect(boot.body).toEqual({ error: 'Origin not authorized', code: 'ORIGIN_DENIED' });
    expect(boot.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('no Origin and no Referer: 403 ORIGIN_REQUIRED', async () => {
    await scenario({ edition: 'iran', ai: true, smart: true });
    const boot = await bootstrapTextPlain({ workspace_id: WS, include_config: true }, null);
    expect(boot.status).toBe(403);
    expect(boot.body.code).toBe('ORIGIN_REQUIRED');
    expect(boot.body.session_token).toBeUndefined();
  });

  it('no workspace_id and an unmapped origin: 400 MISSING_WORKSPACE', async () => {
    await scenario({ edition: 'iran', ai: true, smart: true });
    const boot = await bootstrapTextPlain({ include_config: true });
    expect(boot.status).toBe(400);
    expect(boot.body.code).toBe('MISSING_WORKSPACE');
  });

  it('the allowed origin gets the credentialed CORS contract and the visitor cookie', async () => {
    await scenario({ edition: 'iran', ai: true, smart: true });
    const boot = await bootstrapTextPlain({ workspace_id: WS, include_config: true });
    expect(boot.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
    expect(boot.headers['access-control-allow-credentials']).toBe('true');
    expect(String(boot.headers['set-cookie'] || '')).toContain('dvsid=');
    expect(boot.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
  });
});
