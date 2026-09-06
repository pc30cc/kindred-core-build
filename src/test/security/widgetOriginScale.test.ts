/**
 * Multi-tenant Widget origin architecture — security + scale regression suite.
 *
 * Covers the SaaS contract: any number of customer domains may be added as
 * DATA (no CORS_ORIGINS change, no redeploy), each request resolves to
 * exactly one `workspace_id + origin` pair, and origin resolution stays
 * bounded as the customer-domain table grows.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase/Express test doubles are intentionally untyped. */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── In-memory Supabase double ────────────────────────────────────────────
type DomainRow = { workspace_id: string; domain: string; normalized_domain: string; verified: boolean };
type SettingsRow = { workspace_id: string; allowed_domains: string[] | null; allow_subdomains: boolean };

const db = {
  workspace_domains: [] as DomainRow[],
  widget_settings: [] as SettingsRow[],
};

/** Every filter the production code applies, recorded per query. */
const queries: Array<{ table: string; filters: Record<string, any>; rowsScanned: number }> = [];

function makeQuery(table: string) {
  const filters: Record<string, any> = {};
  const builder: any = {
    select: () => builder,
    eq: (col: string, val: any) => { filters[col] = val; return builder; },
    in: (col: string, vals: any[]) => { filters[`${col}__in`] = vals; return builder; },
    limit: () => builder,
    maybeSingle: () => builder.then((r: any) => ({ data: r.data[0] ?? null, error: null })),
    then: (resolve: any, reject?: any) => {
      let rows: any[] = (db as any)[table] || [];
      // A real indexed lookup NEVER returns rows outside the requested keys —
      // we assert on the filters, and count what the DB had to consider.
      const considered = rows.length;
      for (const [key, val] of Object.entries(filters)) {
        if (key.endsWith('__in')) {
          const col = key.slice(0, -4);
          rows = rows.filter((r) => (val as any[]).includes(r[col]));
        } else {
          rows = rows.filter((r) => r[key] === val);
        }
      }
      queries.push({ table, filters, rowsScanned: considered });
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({ from: (table: string) => makeQuery(table) }),
}));

// Entitlements: allow-list feature granted for every workspace in these tests.
vi.mock('../../../server/services/widget/entitlements.js', () => ({
  resolveWidgetEntitlements: async () => ({ features: { widget_domain_allowlist: true } }),
}));

const {
  resolveWorkspaceIdFromOrigin,
  getWorkspaceOriginRules,
  hostSuffixCandidates,
  invalidateWorkspaceOriginCache,
  invalidateOriginHostCache,
  __resetWidgetOriginCaches,
} = await import('../../../server/services/widget/public.js');

const { isPublicWidgetApiPath, PUBLIC_WIDGET_REALTIME_ROUTES } = await import('../../../server/lib/routePrefix.js');
const { widgetCorsMiddleware } = await import('../../../server/middleware/widgetCors.js');

const config = { fake: true } as any;

function normalize(domain: string) {
  return domain.toLowerCase().replace(/^https?:\/\//, '').replace(/[:/?#].*$/, '').replace(/^www\./, '');
}

function addDomain(workspaceId: string, domain: string, verified = true) {
  db.workspace_domains.push({ workspace_id: workspaceId, domain, normalized_domain: normalize(domain), verified });
}

function setSettings(workspaceId: string, allowed: string[], allowSubdomains = false) {
  db.widget_settings = db.widget_settings.filter((r) => r.workspace_id !== workspaceId);
  db.widget_settings.push({ workspace_id: workspaceId, allowed_domains: allowed, allow_subdomains: allowSubdomains });
}

const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  db.workspace_domains = [];
  db.widget_settings = [];
  queries.length = 0;
  __resetWidgetOriginCaches();
});

// ── Origin → workspace resolution ────────────────────────────────────────
describe('origin → workspace resolution', () => {
  it('resolves an exact verified domain to its own workspace only', async () => {
    addDomain(WS_A, 'site-a.com');
    addDomain(WS_B, 'site-b.com');
    setSettings(WS_A, []);
    setSettings(WS_B, []);

    expect(await resolveWorkspaceIdFromOrigin(config, 'https://site-a.com')).toBe(WS_A);
    __resetWidgetOriginCaches();
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://site-b.com')).toBe(WS_B);
  });

  it('treats www and non-www as the same host', async () => {
    addDomain(WS_A, 'https://www.site-a.com/');
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://site-a.com')).toBe(WS_A);
  });

  it('ignores unverified domains', async () => {
    addDomain(WS_A, 'pending.com', false);
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://pending.com')).toBeNull();
  });

  it('matches an allowed subdomain when allow_subdomains is on', async () => {
    addDomain(WS_A, 'example.com');
    setSettings(WS_A, [], true);
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://store.eu.example.com')).toBe(WS_A);
  });

  it('rejects the subdomain when allow_subdomains is off', async () => {
    addDomain(WS_A, 'example.com');
    setSettings(WS_A, [], false);
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://store.example.com')).toBeNull();
  });

  it('never leaks one workspace origin into another workspace', async () => {
    addDomain(WS_A, 'site-a.com');
    addDomain(WS_B, 'site-b.com');
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://site-b.com')).not.toBe(WS_A);
  });
});

// ── Bounded lookup / scale ───────────────────────────────────────────────
describe('lookup is bounded, not O(total customer domains)', () => {
  it('generates a bounded, most-specific-first candidate list', () => {
    expect(hostSuffixCandidates('store.eu.example.com')).toEqual([
      'store.eu.example.com',
      'eu.example.com',
      'example.com',
    ]);
    expect(hostSuffixCandidates('a.b.c.d.e.f.g.h.i.example.com').length).toBeLessThanOrEqual(6);
  });

  it('queries only the candidate hostnames — never the full table', async () => {
    for (let i = 0; i < 5000; i += 1) addDomain(`ws-${i}`, `customer-${i}.com`);
    addDomain(WS_A, 'site-a.com');

    await resolveWorkspaceIdFromOrigin(config, 'https://site-a.com');

    const domainQueries = queries.filter((q) => q.table === 'workspace_domains');
    expect(domainQueries).toHaveLength(1);
    expect(domainQueries[0].filters.verified).toBe(true);
    expect(domainQueries[0].filters.normalized_domain__in).toEqual(['site-a.com']);
  });

  it('issues the same bounded work at 100 and at 100_000 unrelated domains', async () => {
    const probe = async (total: number) => {
      db.workspace_domains = [];
      queries.length = 0;
      __resetWidgetOriginCaches();
      for (let i = 0; i < total; i += 1) addDomain(`ws-${i}`, `noise-${i}.com`);
      addDomain(WS_A, 'store.eu.example.com');
      await resolveWorkspaceIdFromOrigin(config, 'https://store.eu.example.com');
      const q = queries.filter((x) => x.table === 'workspace_domains');
      return { count: q.length, keys: q[0].filters.normalized_domain__in.length };
    };

    const small = await probe(100);
    const huge = await probe(100_000);
    expect(huge).toEqual(small);
    expect(huge.keys).toBeLessThanOrEqual(6);
  });
});

// ── Workspace origin rules ───────────────────────────────────────────────
describe('workspace origin rules', () => {
  it('unions verified domains with the widget allow-list, scoped per workspace', async () => {
    addDomain(WS_A, 'site-a.com');
    setSettings(WS_A, ['extra-a.com'], false);
    addDomain(WS_B, 'site-b.com');
    setSettings(WS_B, ['extra-b.com'], false);

    const a = await getWorkspaceOriginRules(config, WS_A);
    const b = await getWorkspaceOriginRules(config, WS_B);
    expect(a.domains.sort()).toEqual(['extra-a.com', 'site-a.com']);
    expect(b.domains.sort()).toEqual(['extra-b.com', 'site-b.com']);
  });

  it('supports one workspace embedded on multiple allowed domains', async () => {
    addDomain(WS_A, 'shop-one.com');
    addDomain(WS_A, 'shop-two.com');
    setSettings(WS_A, []);
    const rules = await getWorkspaceOriginRules(config, WS_A);
    expect(rules.domains.sort()).toEqual(['shop-one.com', 'shop-two.com']);
  });
});

// ── Cache invalidation ───────────────────────────────────────────────────
describe('cache invalidation makes domain management a data operation', () => {
  it('a newly added domain works without waiting for the TTL', async () => {
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://fresh.com')).toBeNull();
    addDomain(WS_A, 'fresh.com');
    invalidateOriginHostCache('fresh.com');
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://fresh.com')).toBe(WS_A);
  });

  it('a removed domain stops working after invalidation', async () => {
    addDomain(WS_A, 'gone.com');
    setSettings(WS_A, []);
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://gone.com')).toBe(WS_A);
    db.workspace_domains = [];
    invalidateWorkspaceOriginCache(WS_A);
    invalidateOriginHostCache('gone.com');
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://gone.com')).toBeNull();
  });

  it('an allow-list change invalidates only that workspace', async () => {
    addDomain(WS_A, 'site-a.com');
    setSettings(WS_A, []);
    addDomain(WS_B, 'site-b.com');
    setSettings(WS_B, []);
    await getWorkspaceOriginRules(config, WS_A);
    await getWorkspaceOriginRules(config, WS_B);

    setSettings(WS_A, ['new-a.com']);
    invalidateWorkspaceOriginCache(WS_A);
    expect((await getWorkspaceOriginRules(config, WS_A)).domains).toContain('new-a.com');
  });

  it('serves repeat lookups from cache instead of re-querying', async () => {
    addDomain(WS_A, 'cached.com');
    await resolveWorkspaceIdFromOrigin(config, 'https://cached.com');
    const after = queries.length;
    await resolveWorkspaceIdFromOrigin(config, 'https://cached.com');
    expect(queries.length).toBe(after);
  });
});

// ── Route coverage ───────────────────────────────────────────────────────
describe('canonical widget CORS route coverage', () => {
  it('classifies every visitor-facing realtime route as widget CORS', () => {
    for (const route of PUBLIC_WIDGET_REALTIME_ROUTES) {
      expect(isPublicWidgetApiPath(route)).toBe(true);
    }
    expect(PUBLIC_WIDGET_REALTIME_ROUTES).toContain('/api/realtime/visitor-presence');
    expect(PUBLIC_WIDGET_REALTIME_ROUTES).toContain('/api/realtime/reconnect-signal');
  });

  it('keeps operator/admin realtime routes on first-party app CORS', () => {
    expect(isPublicWidgetApiPath('/api/realtime/operator-connect')).toBe(false);
    expect(isPublicWidgetApiPath('/api/realtime/admin/config')).toBe(false);
  });
});

// ── Middleware behaviour ─────────────────────────────────────────────────
function makeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 0,
    setHeader: (k: string, v: string) => { headers[k] = v; },
    status(code: number) { this.statusCode = code; return this; },
    end() { return this; },
  } as any;
}

async function runCors(req: any) {
  const res = makeRes();
  const next = vi.fn();
  await widgetCorsMiddleware()({
    method: 'POST',
    path: '/',
    query: {},
    body: {},
    headers: {},
    get: (k: string) => (k.toLowerCase() === 'host' ? 'api.webyar.app' : undefined),
    serverConfig: config,
    ...req,
  }, res, next);
  return { res, next };
}

describe('workspace-aware widget CORS', () => {
  it('answers OPTIONS preflight with credentialed headers and never a wildcard', async () => {
    const { res } = await runCors({ method: 'OPTIONS', headers: { origin: 'https://site-a.com' } });
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://site-a.com');
    expect(res.headers['Access-Control-Allow-Origin']).not.toBe('*');
    expect(res.headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(res.statusCode).toBe(204);
  });

  it('echoes an allowed customer origin for its own workspace', async () => {
    addDomain(WS_A, 'site-a.com');
    setSettings(WS_A, []);
    const { res } = await runCors({ headers: { origin: 'https://site-a.com' }, body: { workspace_id: WS_A } });
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://site-a.com');
    expect(res.headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('refuses workspace A origin when the request targets workspace B', async () => {
    addDomain(WS_A, 'site-a.com');
    setSettings(WS_A, []);
    addDomain(WS_B, 'site-b.com');
    setSettings(WS_B, []);
    const { res } = await runCors({ headers: { origin: 'https://site-a.com' }, body: { workspace_id: WS_B } });
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('refuses an unknown origin entirely', async () => {
    addDomain(WS_A, 'site-a.com');
    setSettings(WS_A, []);
    const { res } = await runCors({ headers: { origin: 'https://evil.example' }, body: { workspace_id: WS_A } });
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('allows a permitted subdomain and refuses it when the policy is off', async () => {
    addDomain(WS_A, 'example.com');
    setSettings(WS_A, [], true);
    const allowed = await runCors({ headers: { origin: 'https://shop.example.com' }, body: { workspace_id: WS_A } });
    expect(allowed.res.headers['Access-Control-Allow-Origin']).toBe('https://shop.example.com');

    setSettings(WS_A, [], false);
    invalidateWorkspaceOriginCache(WS_A);
    const denied = await runCors({ headers: { origin: 'https://shop.example.com' }, body: { workspace_id: WS_A } });
    expect(denied.res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('covers visitor-presence and reconnect-signal with the same policy', async () => {
    addDomain(WS_A, 'site-a.com');
    setSettings(WS_A, []);
    for (const path of ['/api/realtime/visitor-presence', '/api/realtime/reconnect-signal']) {
      const { res } = await runCors({ path, originalUrl: path, headers: { origin: 'https://site-a.com' }, body: { workspace_id: WS_A } });
      expect(res.headers['Access-Control-Allow-Origin']).toBe('https://site-a.com');
      const denied = await runCors({ path, originalUrl: path, headers: { origin: 'https://evil.example' }, body: { workspace_id: WS_A } });
      expect(denied.res.headers['Access-Control-Allow-Origin']).toBeUndefined();
    }
  });
});

// ── Deep subdomains: the registered apex must never fall off the list ─────
describe('deep subdomain candidate correctness', () => {
  beforeEach(() => { db.workspace_domains = []; db.widget_settings = []; queries.length = 0; __resetWidgetOriginCaches(); });

  it('keeps the registered apex in the candidate set for a deeply nested host', () => {
    const candidates = hostSuffixCandidates('a.b.c.d.e.f.g.example.com');
    expect(candidates).toContain('example.com');
    expect(candidates).toContain('a.b.c.d.e.f.g.example.com');
    expect(candidates.length).toBeLessThanOrEqual(7);
  });

  it('resolves a deeply nested host to the workspace that owns the apex', async () => {
    addDomain(WS_A, 'example.com');
    setSettings(WS_A, [], true);
    const ws = await resolveWorkspaceIdFromOrigin(config, 'https://a.b.c.d.e.f.g.example.com');
    expect(ws).toBe(WS_A);
  });

  it('still refuses the deep host when the workspace disabled subdomains', async () => {
    addDomain(WS_A, 'example.com');
    setSettings(WS_A, [], false);
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://a.b.c.d.e.f.g.example.com')).toBeNull();
  });

  it('stays bounded for a pathological hostname', () => {
    const host = Array.from({ length: 80 }, (_, i) => `l${i}`).join('.') + '.example.com';
    expect(hostSuffixCandidates(host).length).toBeLessThanOrEqual(7);
  });

  it('prefers the most specific registered suffix across tenants', async () => {
    addDomain(WS_A, 'example.com');
    addDomain(WS_B, 'eu.example.com');
    setSettings(WS_A, [], true);
    setSettings(WS_B, [], true);
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://shop.eu.example.com')).toBe(WS_B);
  });
});

// ── Ambiguous ownership must fail closed, never pick a tenant ─────────────
describe('ambiguous domain ownership', () => {
  beforeEach(() => { db.workspace_domains = []; db.widget_settings = []; queries.length = 0; __resetWidgetOriginCaches(); });

  it('refuses origin-only resolution when two workspaces claim the same verified domain', async () => {
    addDomain(WS_A, 'shared.com');
    addDomain(WS_B, 'shared.com');
    setSettings(WS_A, []);
    setSettings(WS_B, []);
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://shared.com')).toBeNull();
  });

  it('refuses an ambiguous subdomain tie between two workspaces', async () => {
    addDomain(WS_A, 'tie.com');
    addDomain(WS_B, 'tie.com');
    setSettings(WS_A, [], true);
    setSettings(WS_B, [], true);
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://shop.tie.com')).toBeNull();
  });

  it('the explicit workspace_id + origin flow still works on an ambiguous domain', async () => {
    addDomain(WS_A, 'shared.com');
    addDomain(WS_B, 'shared.com');
    setSettings(WS_A, []);
    setSettings(WS_B, []);
    const { res } = await runCors({ headers: { origin: 'https://shared.com' }, body: { workspace_id: WS_A } });
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://shared.com');
  });

  it('duplicate rows for the SAME workspace are not treated as ambiguous', async () => {
    addDomain(WS_A, 'dup.com');
    addDomain(WS_A, 'www.dup.com');
    setSettings(WS_A, []);
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://dup.com')).toBe(WS_A);
  });
});
