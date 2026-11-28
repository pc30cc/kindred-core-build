/**
 * Where the call widget runs, and how many sites (owner, 2026-11-28):
 * the registered website (verified workspace_domains) and the call center's
 * own list only, at most the plan's max_call_widget_domains in all (registry
 * default 1 = the registered website, -1 = unlimited). Only a save that adds
 * a site is held to the number; the chat widget's rule (an empty chat list
 * lets any site in) no longer opens the call widget.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer } from './callWidgetHttp';

const WS = '77777777-7777-4777-8777-777777777777';
const PLATFORM_WS = '11111111-1111-4111-8111-111111111111';
type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  domains: [] as Array<{ domain: string; verified: boolean }>,
  domainsFail: false,
  domainReads: 0,
  row: {} as Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
  limit: { allowed: true, limit: 1, limitValid: true, reason: undefined as string | undefined },
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit', 'in', 'is', 'insert', 'update']) b[m] = () => b;
      b.maybeSingle = async () => ({ data: null, error: null });
      b.single = async () => ({ data: null, error: null });
      b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        if (table === 'workspace_domains') {
          state.domainReads++;
          if (state.domainsFail) return Promise.resolve({ data: null, error: new Error('down') }).then(ok, bad);
          return Promise.resolve({ data: state.domains.filter((d) => d.verified), error: null }).then(ok, bad);
        }
        return Promise.resolve({ data: [], error: null }).then(ok, bad);
      };
      return b;
    },
    rpc: async (fn: string) => ({ data: fn === 'get_workspace_role' ? 'owner' : null, error: null }),
  }),
}));
vi.mock('../../../server/services/platformHosts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/platformHosts.js')>()),
  getPlatformHosts: async () => ({ apex: 'webyar.ai', hosts: new Set(['app.webyar.ai', 'api.webyar.ai']), workspaceId: PLATFORM_WS, origins: new Set() }),
}));
vi.mock('../../../server/middleware/featureGating.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/middleware/featureGating.js')>()),
  checkEntitlementFromDB: async (_u: string, _k: string, _w: string, key: string) => {
    expect(key).toBe('max_call_widget_domains');
    return { ...state.limit, plan: 'pro' };
  },
}));
vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: 'u1', isAdmin: true, role: 'owner' }),
}));
vi.mock('../../../server/services/callCenter/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/callCenter/settings.js')>();
  return {
    ...actual,
    getOrCreateWorkspaceSettings: async () => ({ ...state.row }),
    updateWorkspaceSettings: async (_c: unknown, _w: string, patch: Row) => {
      state.updates.push({ ...patch });
      Object.assign(state.row, patch);
      return { ...state.row };
    },
    getPlatformCallCenterSettings: async () => ({ call_center_enabled: true }),
    computeEffectiveCallCenterCaps: () => ({}),
  };
});
vi.mock('../../../server/services/callCenter/recording.js', () => ({
  computeRecordingCapability: async () => ({ enabled: false }),
  disabledRecordingCapability: () => ({ enabled: false }),
}));
vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/platformRegion.js')>()),
  getPlatformEditionOrNull: async () => 'iran',
}));
vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => true }));

const shared = await import('../../../shared/callCenter/callWidgetDomains');
const domains = await import('../../../server/services/callCenter/callWidgetDomains.js');
const { callCenterRouter } = await import('../../../server/routes/callCenter.js');
const server = startTestServer('/api/call-center', callCenterRouter, { supabaseUrl: 'x', supabaseServiceRoleKey: 'z' }, { authUserId: 'u1' });
afterAll(() => { server.close(); });

const config = { supabaseUrl: 'x', supabaseServiceRoleKey: 'z' } as never;
const ws = (allowed: string[] = [], workspace_id = WS) => ({ workspace_id, allowed_domains: allowed } as never);
const allowed = (origin: string | null, list: string[] = [], workspace = WS) => domains.callWidgetOriginAllowed(config, ws(list, workspace), origin);

beforeEach(() => {
  state.domains = [{ domain: 'mywebsite.com', verified: true }];
  state.domainsFail = false;
  state.domainReads = 0;
  state.row = { id: 'cc-1', workspace_id: WS, enabled: true, public_key: 'cck_x', allowed_domains: [] };
  state.updates = [];
  state.limit = { allowed: true, limit: 1, limitValid: true, reason: undefined };
  domains.invalidateRegisteredWebsiteCache();
});

describe('counting the sites', () => {
  it('the registered website is one slot, a spelling of it none, every other entry one', () => {
    expect(shared.domainSlotsUsed(['mywebsite.com'], [])).toBe(1);
    expect(shared.domainSlotsUsed(['mywebsite.com'], ['www.mywebsite.com', 'MyWebsite.com '])).toBe(1);
    expect(shared.domainSlotsUsed(['mywebsite.com'], ['shop.com', '*.mywebsite.com'])).toBe(3);
    expect(shared.domainSlotsUsed([], ['shop.com'])).toBe(1);
    expect(shared.domainSlotsUsed(['a.com', 'b.com'], [])).toBe(1);
  });

  it('Add is offered only while a slot is free, always when unlimited, never while unknown', () => {
    expect(shared.canAddDomain(['mywebsite.com'], [], 1)).toBe(false);
    expect(shared.canAddDomain([], [], 1)).toBe(true);
    expect(shared.canAddDomain(['mywebsite.com'], [], 2)).toBe(true);
    expect(shared.canAddDomain(['mywebsite.com'], ['shop.com'], 2)).toBe(false);
    expect(shared.canAddDomain(['mywebsite.com'], ['a.com', 'b.com', 'c.com'], -1)).toBe(true);
    expect(shared.canAddDomain([], [], null)).toBe(false);
  });

  it('a save past the number is refused only when it adds a site', () => {
    const save = (next: string[], stored: string[], max: number, registered = ['mywebsite.com']) =>
      domains.checkDomainListSave({ next, stored, registered, max }).kind;
    expect(save(['shop.com'], [], 1)).toBe('plan_limit');
    expect(save(['www.mywebsite.com'], [], 1)).toBe('ok');
    expect(save(['shop.com'], [], 1, [])).toBe('ok');
    expect(save(['shop.com'], [], 2)).toBe('ok');
    expect(save(['a.com', 'b.com'], [], 2)).toBe('plan_limit');
    expect(save(['a.com', 'b.com', 'c.com'], [], -1)).toBe('ok');
    // A list stored past the number (a downgrade, or before the number): resent or shortened, never cut.
    expect(save(['a.com', 'b.com'], ['a.com', 'b.com'], 1)).toBe('ok');
    expect(save(['a.com'], ['a.com', 'b.com'], 1)).toBe('ok');
    expect(save(['a.com', 'c.com'], ['a.com', 'b.com'], 1)).toBe('plan_limit');
  });

  it('an added entry must be a domain; one already stored is kept as it is', () => {
    expect(domains.checkDomainListSave({ next: ['https://x.com'], stored: [], registered: [], max: -1 })).toEqual({ kind: 'invalid_domain', entry: 'https://x.com' });
    expect(domains.checkDomainListSave({ next: ['x.com/path'], stored: ['x.com/path'], registered: [], max: -1 }).kind).toBe('ok');
    expect(domains.checkDomainListSave({ next: [' Shop.COM ', 'shop.com', ''], stored: [], registered: [], max: -1 })).toEqual({ kind: 'ok', list: ['shop.com'] });
  });
});

describe('where the call widget runs', () => {
  it('on the registered website and its www twin, not its other subdomains or other sites', async () => {
    expect(await allowed('https://mywebsite.com')).toBe(true);
    expect(await allowed('https://www.mywebsite.com')).toBe(true);
    expect(await allowed('https://blog.mywebsite.com')).toBe(false);
    expect(await allowed('https://evil.example')).toBe(false);
  });

  it('on the call center list: an entry, its www twin, and a *. entry with its apex and subdomains', async () => {
    state.domains = [];
    expect(await allowed('https://www.shop.example', ['shop.example'])).toBe(true);
    expect(await allowed('https://shop.example', ['*.shop.example'])).toBe(true);
    expect(await allowed('https://a.b.shop.example', ['*.shop.example'])).toBe(true);
    expect(await allowed('https://other.example', ['shop.example'])).toBe(false);
  });

  it('nowhere without a registered website or a list (the chat widget\'s empty list no longer opens it)', async () => {
    state.domains = [];
    expect(await allowed('https://anything.example')).toBe(false);
  });

  it('never without an Origin, nor after a failed read of the registered website', async () => {
    expect(await allowed(null, ['shop.example'])).toBe(false);
    state.domainsFail = true;
    expect(await allowed('https://mywebsite.com')).toBe(false);
  });

  it('an unverified row is no registered website', async () => {
    state.domains = [{ domain: 'notmine.example', verified: false }];
    expect(await allowed('https://notmine.example')).toBe(false);
  });

  it('a platform host counts only for the platform\'s own workspace', async () => {
    state.domains = [{ domain: 'app.webyar.ai', verified: true }];
    expect(await allowed('https://app.webyar.ai')).toBe(false);
    domains.invalidateRegisteredWebsiteCache();
    state.domains = [{ domain: 'webyar.ai', verified: true }];
    expect(await allowed('https://www.webyar.ai', [], PLATFORM_WS)).toBe(true);
  });

  it('the registered website is read once a minute per workspace, and again after an invalidation', async () => {
    await allowed('https://mywebsite.com');
    await allowed('https://www.mywebsite.com');
    expect(state.domainReads).toBe(1);
    domains.invalidateRegisteredWebsiteCache(WS);
    await allowed('https://mywebsite.com');
    expect(state.domainReads).toBe(2);
  });

  it('every gated call widget route asks this rule, and nothing of the chat widget\'s', () => {
    const src = readFileSync(join(process.cwd(), 'server/routes/callWidget.ts'), 'utf8');
    expect(src).not.toContain('isWorkspaceOriginAllowed');
    expect(src).toContain('return callWidgetOriginAllowed(config, ws, origin);');
    expect((src.match(/await callOriginAllowed\(/g) || []).length).toBe(4);
  });
});

describe('PUT and GET /api/call-center/settings', () => {
  const put = (body: Row) => server.put<{ error?: string; max?: number; settings?: Row }>(`/api/call-center/settings?workspaceId=${WS}`, body);

  it('refuses a site past the plan\'s number (403 plan_limit) and writes nothing', async () => {
    const res = await put({ allowed_domains: ['shop.com'] });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'plan_limit', max: 1 });
    expect(state.updates).toEqual([]);
  });

  it('stores a site within the number, cleaned', async () => {
    state.limit = { allowed: true, limit: 3, limitValid: true, reason: undefined };
    const res = await put({ allowed_domains: [' Shop.com ', 'shop.com', 'blog.shop.com'] });
    expect(res.status).toBe(200);
    expect(state.row.allowed_domains).toEqual(['shop.com', 'blog.shop.com']);
  });

  it('a plan that never names the number gets the registry default, 1', async () => {
    state.limit = { allowed: false, limit: undefined as never, limitValid: false, reason: 'feature_not_in_plan' };
    expect((await put({ allowed_domains: ['shop.com'] })).status).toBe(403);
    state.domains = [];
    domains.invalidateRegisteredWebsiteCache();
    expect((await put({ allowed_domains: ['shop.com'] })).status).toBe(200);
  });

  it('refuses an added entry that is no domain (400)', async () => {
    state.limit = { allowed: true, limit: -1, limitValid: true, reason: undefined };
    const res = await put({ allowed_domains: ['https://shop.com/'] });
    expect(res.status).toBe(400);
    expect(state.updates).toEqual([]);
  });

  it('GET answers the registered website beside the settings', async () => {
    const res = await server.get<{ registered_domains?: string[] }>(`/api/call-center/settings?workspaceId=${WS}`);
    expect(res.status).toBe(200);
    expect(res.body.registered_domains).toEqual(['mywebsite.com']);
  });
});
