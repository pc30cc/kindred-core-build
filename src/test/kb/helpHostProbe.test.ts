// @vitest-environment node
/**
 * The help center's host probe, end to end of what was broken on production:
 * src/lib/kb-api.ts asked `/api/widget/help-host`, which no route serves
 * (the widget router answered 401 MISSING_TOKEN), while the handler is
 * routes/kb.ts `/help-host` under `/api/widget/kb`. And from app.<brand>
 * the call is cross-origin (to api.<brand>), so the widget CORS layer must
 * expose the answer to the origins of the workspace it names: the request's
 * own host's (middleware/widgetCors.ts), through the guarded resolver.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const resolver = vi.hoisted(() => ({
  byHost: {} as Record<string, string>,
  rules: {} as Record<string, { domains: string[]; allowSubdomains: boolean }>,
  asked: [] as Array<string | null>,
}));

vi.mock('../../../server/services/widget/public.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/widget/public.js')>()),
  resolveWorkspaceIdFromOrigin: async (_config: unknown, origin: string | null) => {
    resolver.asked.push(origin);
    const host = origin ? new URL(origin).hostname : '';
    return resolver.byHost[host] ?? null;
  },
  getWorkspaceOriginRules: async (_config: unknown, workspaceId: string) =>
    resolver.rules[workspaceId] ?? { domains: [], allowSubdomains: false },
}));

vi.mock('../../../server/services/platformHosts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/platformHosts.js')>()),
  isPlatformWorkspace: async (_config: unknown, id: string) => id === '00000000-0000-4000-8000-0000000000f1',
}));

const { widgetCorsMiddleware } = await import('../../../server/middleware/widgetCors.js');
const { widgetKbRouter } = await import('../../../server/routes/kb.js');

const PLATFORM_WS = '00000000-0000-4000-8000-0000000000f1';
const app = express();
app.use((req, _res, next) => { (req as unknown as { serverConfig: object }).serverConfig = {}; next(); });
// As server/index.ts mounts it (rate limiters aside).
app.use('/api/widget/kb', widgetCorsMiddleware(), widgetKbRouter);

const probe = (origin: string, host = 'api.webyar.ai') =>
  request(app).get('/api/widget/kb/help-host').set('Host', host).set('Origin', origin);

beforeEach(() => {
  resolver.byHost = { 'api.webyar.ai': PLATFORM_WS };
  resolver.rules = { [PLATFORM_WS]: { domains: ['webyar.ai'], allowSubdomains: true } };
  resolver.asked = [];
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('GET /api/widget/kb/help-host from app.<brand>', () => {
  it('answers with the workspace of the API host, readable by app.<brand>', async () => {
    const res = await probe('https://app.webyar.ai');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ workspace_id: PLATFORM_WS, platform: true });
    expect(res.headers['access-control-allow-origin']).toBe('https://app.webyar.ai');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    // CORS resolved the request's own host, never the caller's Origin.
    expect(resolver.asked.every((origin) => origin && new URL(origin).hostname === 'api.webyar.ai')).toBe(true);
  });

  it('exposes nothing to an origin that workspace does not allow', async () => {
    resolver.byHost['customer.example'] = 'ws-customer';
    resolver.rules['ws-customer'] = { domains: ['customer.example'], allowSubdomains: true };
    const res = await probe('https://customer.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a host bound to no workspace: 404, and no CORS for a third party', async () => {
    const res = await probe('https://app.webyar.ai', 'unbound.example');
    expect(res.status).toBe(404);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('the SPA calls the mounted path', () => {
  it('kb-api asks /api/widget/kb/help-host, the path server/index.ts serves', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return { ok: url.endsWith('/help-host'), json: async () => (url.endsWith('/help-host') ? { workspace_id: PLATFORM_WS } : { categories: [] }) };
    }));
    const { fetchKbCategories } = await import('@/lib/kb-api');
    await fetchKbCategories('en');
    expect(urls[0]).toMatch(/\/api\/widget\/kb\/help-host$/);
    expect(urls[1]).toContain(`/api/widget/kb/categories?workspace_id=${PLATFORM_WS}`);
    expect(readFileSync('server/index.ts', 'utf8')).toMatch(/app\.use\('\/api\/widget\/kb', [^\n]*widgetKbRouter\)/);
  });
});
