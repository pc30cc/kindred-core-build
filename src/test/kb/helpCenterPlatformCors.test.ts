// @vitest-environment node
/**
 * The platform's own help center read from the platform's own app host,
 * through the REAL widget CORS layer, KB routes, origin resolver and
 * platform hosts (middleware/widgetCors.ts, routes/kb.ts,
 * services/widget/public.ts, services/platformHosts.ts).
 *
 * Production's shape: the platform workspace holds the apex verified, and
 * its widget allow-list is empty ("any site") with subdomains on, so its
 * origin rules fall back to same-origin, and app.<brand>/help, which calls
 * api.<brand> (src/lib/kb-api.ts), got no Access-Control-Allow-Origin and
 * stayed blank. The platform's own site origins (app, public, help center
 * and canonical URLs, CORS_ORIGINS) now read the platform workspace's help
 * center; another origin, a subdomain, another scheme or port, another
 * workspace and the widget's other routes are as before.
 *
 * The two reads that answer for the request's own host (/help-host,
 * /category-articles) take the workspace their CORS is read for from that
 * host only: a workspace_id or a widget token sent along names another
 * workspace, whose allowed origins must not read this host's answer.
 *
 * The data layer is an in-memory double.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

type Row = Record<string, unknown>;
type Failure = { message: string; code?: string } | null;
type Result = { data: Row[] | null; error: Failure };
const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));

vi.mock('../../../server/supabase.js', () => {
  /** A query over one table: eq and in filter, every other call (order, limit, or, range…) chains. */
  function query(rows: () => Row[], failure: Failure = null): object {
    const filters: Array<(r: Row) => boolean> = [];
    const run = (): Result => (failure ? { data: null, error: failure } : { data: rows().filter((r) => filters.every((f) => f(r))), error: null });
    const builder: object = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject);
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; };
        }
        if (prop === 'eq') return (col: string, val: unknown) => { filters.push((r) => r[col] === val); return builder; };
        if (prop === 'in') return (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return builder; };
        return () => builder;
      },
    });
    return builder;
  }
  return {
    getServiceClient: () => ({
      from: (table: string) => query(() => db.tables[table] ?? []),
      // A database before migration 280a: the search runs the plain ILIKE.
      rpc: () => query(() => [], { code: '42883', message: 'function kb_search_folded does not exist' }),
    }),
  };
});
vi.mock('../../../server/services/widget/entitlements.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/widget/entitlements.js')>()),
  resolveWidgetEntitlements: async () => ({ features: { widget_domain_allowlist: true } }),
}));

const { widgetCorsMiddleware } = await import('../../../server/middleware/widgetCors.js');
const { widgetKbRouter } = await import('../../../server/routes/kb.js');
const { __resetPlatformHostsCache } = await import('../../../server/services/platformHosts.js');
const { __resetWidgetOriginCaches } = await import('../../../server/services/widget/public.js');
const { createSessionToken } = await import('../../../server/services/widget/security.js');

const PLATFORM = '00000000-0000-4000-8000-0000000000f1';
const CUSTOMER = '00000000-0000-4000-8000-0000000000c1';
/** Only in CORS_ORIGINS, not in Super Admin → Domains. */
const ENV_ORIGIN = 'https://console.example.net';
// Billing locks off (the KB lock reads nothing): not what is under test.
const config = { corsOrigins: [ENV_ORIGIN], selfHostBillingUnlimited: true };

const app = express();
app.use((req, _res, next) => { (req as unknown as { serverConfig: object }).serverConfig = config; next(); });
// As server/index.ts mounts them (rate limiters aside); the widget's other routes are a stand-in.
app.use('/api/widget/kb', widgetCorsMiddleware(), widgetKbRouter);
app.use('/api/widget', widgetCorsMiddleware(), (_req, res) => { res.json({ ok: true }); });

/** Every read the SPA's /help pages make (src/lib/kb-api.ts, HelpCategoryPage). */
const reads = (workspaceId: string) => [
  '/api/widget/kb/help-host',
  '/api/widget/kb/category-articles?locale=fa&slug=start',
  `/api/widget/kb/categories?workspace_id=${workspaceId}&locale=fa`,
  `/api/widget/kb/articles?workspace_id=${workspaceId}`,
  `/api/widget/kb/article?workspace_id=${workspaceId}&slug=hello`,
  `/api/widget/kb/search?workspace_id=${workspaceId}&q=hello`,
];
const ACAO = 'access-control-allow-origin';

describe.each([
  ['WebYar', 'webyar.ai'],
  ['RESPOK', 'respok.app'],
])('%s', (_brand, apex) => {
  const get = (path: string, origin: string, host = `api.${apex}`) => request(app).get(path).set('Host', host).set('Origin', origin);

  beforeEach(() => {
    db.tables = {
      platform_domains: [{
        primary_domain: apex,
        canonical_base_url: `https://${apex}`,
        public_base_url: `https://${apex}`,
        app_base_url: `https://app.${apex}`,
        api_base_url: `https://api.${apex}`,
        help_center_base_url: null,
        email_base_url: null,
      }],
      widget_platform_settings: [],
      workspace_domains: [
        { workspace_id: PLATFORM, domain: apex, normalized_domain: apex, verified: true },
        { workspace_id: CUSTOMER, domain: 'ninisite.com', normalized_domain: 'ninisite.com', verified: true },
      ],
      // The platform widget as production has it: allowed_domains {} ("any site"), subdomains on.
      widget_settings: [
        { workspace_id: PLATFORM, allowed_domains: [], allow_subdomains: true },
        { workspace_id: CUSTOMER, allowed_domains: ['ninisite.com'], allow_subdomains: true },
      ],
      knowledge_base_categories: [
        { id: 'cat-p', workspace_id: PLATFORM, name: 'Start', slug: 'start', sort_order: 0 },
        { id: 'cat-c', workspace_id: CUSTOMER, name: 'Start', slug: 'start', sort_order: 0 },
      ],
      knowledge_base_articles: [PLATFORM, CUSTOMER].map((ws) => ({
        id: `art-${ws}`, workspace_id: ws, status: 'published', title: 'Hello', slug: 'hello',
        excerpt: 'hello', content: 'hello', locale: 'fa', updated_at: null, category_id: ws === PLATFORM ? 'cat-p' : 'cat-c',
      })),
    };
    __resetPlatformHostsCache();
    __resetWidgetOriginCaches();
  });

  it(`app.${apex}/help reads the platform workspace's help center on api.${apex}`, async () => {
    const probe = await get('/api/widget/kb/help-host', `https://app.${apex}`);
    expect(probe.status).toBe(200);
    expect(probe.body).toEqual({ workspace_id: PLATFORM });
    for (const path of reads(PLATFORM)) {
      const res = await get(path, `https://app.${apex}`);
      expect(res.status, path).toBe(200);
      expect(res.headers[ACAO], path).toBe(`https://app.${apex}`);
      expect(res.headers['access-control-allow-credentials'], path).toBe('true');
    }
    expect((await get(`/api/widget/kb/article?workspace_id=${PLATFORM}&slug=hello`, `https://app.${apex}`)).body.article.title).toBe('Hello');
  });

  it('so do its public site and CORS_ORIGINS, exactly', async () => {
    for (const origin of [`https://${apex}`, ENV_ORIGIN]) {
      for (const path of reads(PLATFORM)) expect((await get(path, origin)).headers[ACAO], `${origin} ${path}`).toBe(origin);
    }
  });

  it('no other origin: not a subdomain, another scheme or port, a customer\'s site, a stranger', async () => {
    for (const origin of [`https://shop.${apex}`, `https://www.${apex}`, `https://help.${apex}`, `http://app.${apex}`, `https://app.${apex}:8443`, 'https://ninisite.com', 'https://evil.example']) {
      for (const path of reads(PLATFORM)) expect((await get(path, origin)).headers[ACAO], `${origin} ${path}`).toBeUndefined();
    }
  });

  it('a customer workspace\'s help center is unchanged: its own sites read it, the platform\'s app does not', async () => {
    for (const path of reads(CUSTOMER)) {
      // Host-scoped reads resolve the customer on its own help host.
      const host = path.includes('workspace_id') ? `api.${apex}` : 'help.ninisite.com';
      expect((await get(path, 'https://ninisite.com', host)).headers[ACAO], path).toBe('https://ninisite.com');
      expect((await get(path, 'https://shop.ninisite.com', host)).headers[ACAO], path).toBe('https://shop.ninisite.com');
      expect((await get(path, `https://app.${apex}`, host)).headers[ACAO], path).toBeUndefined();
      expect((await get(path, 'https://evil.example', host)).headers[ACAO], path).toBeUndefined();
    }
    expect((await get('/api/widget/kb/help-host', 'https://ninisite.com', 'help.ninisite.com')).body).toEqual({ workspace_id: CUSTOMER });
  });

  it('a host-scoped read answers for its host: a workspace_id or a token sent along lends no other workspace\'s origins', async () => {
    const token = createSessionToken(CUSTOMER, 'https://ninisite.com');
    // Spelled as the router still serves them: another case, a trailing slash.
    for (const path of ['/api/widget/kb/help-host', '/api/widget/kb/help-host/', '/api/widget/kb/HELP-HOST', '/API/Widget/KB/help-host', '/api/widget/kb/category-articles']) {
      const query = `?locale=fa&slug=start&workspace_id=${CUSTOMER}`;
      const named = await get(`${path}${query}`, 'https://ninisite.com');
      expect(named.status, path).toBe(200);
      expect(named.headers[ACAO], path).toBeUndefined();
      expect((await get(path, 'https://ninisite.com').set('X-Widget-Token', token)).headers[ACAO], path).toBeUndefined();
      // The host's own workspace decides, whatever is sent along.
      expect((await get(`${path}${query}`, `https://app.${apex}`).set('X-Widget-Token', token)).headers[ACAO], path).toBe(`https://app.${apex}`);
    }
    expect((await get(`/api/widget/kb/help-host?workspace_id=${CUSTOMER}`, 'https://ninisite.com')).body).toEqual({ workspace_id: PLATFORM });
    // The reads that name their workspace keep reading it from the request.
    const listed = await get(`/api/widget/kb/categories?workspace_id=${CUSTOMER}&locale=fa`, 'https://ninisite.com');
    expect(listed.headers[ACAO]).toBe('https://ninisite.com');
  });

  it('the widget\'s other routes for the platform workspace gain nothing', async () => {
    for (const path of [`/api/widget/config?workspace_id=${PLATFORM}`, `/api/widget/search?workspace_id=${PLATFORM}&q=x`, '/api/widget/help-host']) {
      const res = await get(path, `https://app.${apex}`);
      expect(res.body, path).toEqual({ ok: true });
      expect(res.headers[ACAO], path).toBeUndefined();
    }
  });
});
