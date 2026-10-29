// @vitest-environment node
/**
 * The platform-host predicate (platformHosts.ts): every spelling of a
 * platform host that the website trigger, SQL normalize_domain and the
 * generated normalized_domain could turn into `api.<brand>` is caught, for
 * each brand from its own platform_domains row, and no customer domain is.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../config.js';

type Row = Record<string, unknown> | null;
type DomainRow = { workspace_id: string; normalized_domain: string; verified: boolean };
const tables = vi.hoisted(() => ({
  platform_domains: null as Row,
  widget_platform_settings: null as Row,
  workspace_domains: [] as DomainRow[],
  fail: false,
  reads: 0,
}));

vi.mock('../supabase.js', () => ({
  getServiceClient: () => ({
    from(table: 'platform_domains' | 'widget_platform_settings' | 'workspace_domains') {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const builder = {
        select: () => builder,
        limit: () => builder,
        eq: (col: string, val: unknown) => { filters.push((row) => row[col] === val); return builder; },
        in: (col: string, vals: unknown[]) => { filters.push((row) => vals.includes(row[col])); return builder; },
        maybeSingle: async () => {
          tables.reads += 1;
          if (tables.fail) return { data: null, error: { message: 'database unavailable' } };
          return { data: tables[table as 'platform_domains' | 'widget_platform_settings'], error: null };
        },
        // The platform workspace's probe: verified workspace_domains rows.
        then: (resolve: (value: { data: DomainRow[]; error: null }) => unknown) =>
          Promise.resolve({ data: tables.workspace_domains.filter((row) => filters.every((f) => f(row))), error: null }).then(resolve),
      };
      return builder;
    },
  }),
}));

const {
  __resetPlatformHostsCache,
  canonicalHost,
  getPlatformHosts,
  hostCandidates,
  isPlatformHost,
  isPlatformHostIn,
  isPlatformSiteOrigin,
  isPlatformWorkspace,
} = await import('./platformHosts.js');

const config = (extra: Partial<ServerConfig> = {}) => ({ corsOrigins: ['*'], ...extra }) as ServerConfig;

/** Each brand's row as Super Admin → Domains holds it (shapes, not live values). */
const WEBYAR = {
  primary_domain: 'webyar.ai',
  canonical_base_url: 'https://webyar.ai',
  public_base_url: 'https://webyar.ai',
  app_base_url: 'https://app.webyar.ai',
  api_base_url: 'https://api.webyar.ai',
  help_center_base_url: null,
  email_base_url: 'https://app.webyar.ai',
};
const RESPOK = {
  primary_domain: 'respok.app',
  canonical_base_url: 'https://respok.app',
  public_base_url: 'https://respok.app',
  app_base_url: 'https://app.respok.app',
  api_base_url: 'https://api.respok.app',
  help_center_base_url: null,
  email_base_url: null,
};

/** The payloads of the finding, and the spellings SQL reduces to the same host. */
const spellings = (apex: string) => [
  `api.${apex}`.toUpperCase(),
  `api.${apex}.`,
  `https://api.${apex}/x`,
  `api.${apex}:443`,
  ` api.${apex} `,
  `user@api.${apex}`,
  `app.${apex}`,
  apex,
  `foo.${apex}`,
  `HTTP://api.${apex}/`,
  `https://user:pw@API.${apex}:8443/path?q#f`,
  `api.${apex}?x`,
  `api.${apex}#x`,
  `www.api.${apex}`,
  `www.www.api.${apex}`,
  `api.${apex} /x`,
  `api.${apex}:99999`,
  `api.${apex}:x@shop.example`,
  `\tapi.${apex}\n`,
  `api.${apex}\u00a0`,
  `//api.${apex}`,
  `https://https://api.${apex}`,
  `api.${apex}\\x`,
  `%61pi.${apex}`,
  `channels.${apex}`,
  `ai.${apex}`,
  `livekit.${apex}`,
  `turn.${apex}`,
  `x.y.api.${apex}`,
];

beforeEach(() => {
  __resetPlatformHostsCache();
  tables.platform_domains = null;
  tables.widget_platform_settings = null;
  tables.workspace_domains = [];
  tables.fail = false;
  tables.reads = 0;
});

describe('canonical host', () => {
  it('reads a configured URL or domain as a bare ASCII host', () => {
    expect(canonicalHost('https://App.WebYar.ai/')).toBe('app.webyar.ai');
    expect(canonicalHost('www.webyar.ai')).toBe('webyar.ai');
    expect(canonicalHost('webyar.ai.')).toBe('webyar.ai');
    expect(canonicalHost('*')).toBeNull();
    expect(canonicalHost('')).toBeNull();
    expect(canonicalHost(42)).toBeNull();
  });

  it('turns IDN, fullwidth and ideographic dots into what a browser sends', () => {
    expect(hostCandidates('ａｐｉ.ｗｅｂｙａｒ.ａｉ')).toContain('api.webyar.ai');
    expect(hostCandidates('api。webyar。ai')).toContain('api.webyar.ai');
    expect(hostCandidates('آپی.webyar.ai').some((h) => h.startsWith('xn--') && h.endsWith('.webyar.ai'))).toBe(true);
  });
});

describe.each([
  ['WebYar', WEBYAR, 'webyar.ai'],
  ['RESPOK', RESPOK, 'respok.app'],
])('%s: its own hosts, from its own platform_domains row', (_brand, row, apex) => {
  beforeEach(() => { tables.platform_domains = row; });

  it('names the apex', async () => {
    expect((await getPlatformHosts(config())).apex).toBe(apex);
  });

  it.each(spellings(apex))('refuses %j', async (value) => {
    expect(await isPlatformHost(config(), value)).toBe(true);
  });

  it('refuses an IDN spelling of the API host', async () => {
    const fullwidth = `ａｐｉ.${apex}`;
    expect(await isPlatformHost(config(), fullwidth)).toBe(true);
    expect(await isPlatformHost(config(), `api。${apex.replace('.', '。')}`)).toBe(true);
  });

  it.each([
    'shop.example',
    'ninisite.com',
    'https://www.ninisite.com/',
    'asdadas.com',
    `${apex}.shop.example`,
    `not${apex}`,
    `${apex}x`,
    `api-${apex.replace('.', '-')}.com`,
  ])('lets the customer domain %j through', async (value) => {
    expect(await isPlatformHost(config(), value)).toBe(false);
  });

  it('is nothing for an empty or non-string value', async () => {
    for (const value of ['', '   ', null, undefined, 7, {}]) {
      expect(await isPlatformHost(config(), value)).toBe(false);
    }
  });

  it.each([
    ['primary empty, canonical on app., public on the apex', { ...row, primary_domain: null, canonical_base_url: `https://app.${apex}` }],
    ['primary on app.', { ...row, primary_domain: `app.${apex}` }],
    ['the API on another domain', { ...row, api_base_url: 'https://api-host.example.net' }],
  ])('names the brand the apex with %s', async (_case, domains) => {
    tables.platform_domains = domains;
    expect((await getPlatformHosts(config())).apex).toBe(apex);
  });
});

describe('the letters Postgres lower() folds apart from JavaScript', () => {
  it('reads U+0130 (dotted capital I) as the database stores it: a plain i', async () => {
    tables.platform_domains = WEBYAR;
    expect(hostCandidates('app.webyar.a\u0130')).toContain('app.webyar.ai');
    for (const value of ['app.webyar.a\u0130', 'API.WEBYAR.A\u0130', 'webyar.a\u0130', 'https://LIVEKIT.WEBYAR.A\u0130/x', '\u0130\u0130.webyar.ai']) {
      expect(await isPlatformHost(config(), value)).toBe(true);
    }
  });

  it('and the Kelvin sign as k, which JavaScript already does', async () => {
    tables.platform_domains = RESPOK;
    expect(await isPlatformHost(config(), 'api.respo\u212a.app')).toBe(true);
  });
});

describe('where the hosts come from', () => {
  it("does not mix brands: WebYar's row says nothing about respok.app", async () => {
    tables.platform_domains = WEBYAR;
    expect(await isPlatformHost(config(), 'api.respok.app')).toBe(false);
  });

  it('falls back to the canonical, then the public URL, for the apex', async () => {
    tables.platform_domains = { ...WEBYAR, primary_domain: null };
    expect((await getPlatformHosts(config())).apex).toBe('webyar.ai');
    __resetPlatformHostsCache();
    tables.platform_domains = { primary_domain: '  ', canonical_base_url: null, public_base_url: 'https://www.respok.app/' };
    expect((await getPlatformHosts(config())).apex).toBe('respok.app');
  });

  it('never takes a single label or an IP as the apex (it would cover customers)', async () => {
    tables.platform_domains = { primary_domain: 'ai', canonical_base_url: 'http://10.0.0.1:3000', public_base_url: null };
    const platform = await getPlatformHosts(config());
    expect(platform.apex).toBeNull();
    expect(isPlatformHostIn(platform, 'shop.ai')).toBe(false);
  });

  it('counts the exact hosts of services off the apex: Super Admin URLs, widget URLs, env', async () => {
    tables.platform_domains = { ...WEBYAR, api_base_url: 'https://api-host.example.net' };
    tables.widget_platform_settings = { widget_loader_base_url: 'https://cdn.widgets.example.org/widget' };
    const platform = await getPlatformHosts(config({
      corsOrigins: ['https://panel.example.com'],
      publicChannelsBaseUrl: 'https://hooks.example.com',
      aiRuntimeBaseUrl: 'https://runtime.example.com',
    }));
    for (const host of ['api-host.example.net', 'cdn.widgets.example.org', 'panel.example.com', 'hooks.example.com', 'runtime.example.com']) {
      expect(isPlatformHostIn(platform, `https://${host.toUpperCase()}/`)).toBe(true);
    }
    // Exact, not their siblings: example.com is not the platform's.
    expect(isPlatformHostIn(platform, 'shop.example.com')).toBe(false);
    expect(isPlatformHostIn(platform, 'example.net')).toBe(false);
  });

  it('protects nothing while platform_domains names no apex, not even the environment hosts', async () => {
    // A self-host whose frontend is its own site (CORS_ORIGINS=https://example.com,
    // COOLIFY_DEPLOY.md) and nothing in Super Admin → Domains: its first
    // workspace verifies example.com as before, and the platform workspace
    // cannot be told from a customer's.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = config({ corsOrigins: ['https://example.com'], publicChannelsBaseUrl: 'https://hooks.example.com' });
    for (const value of ['example.com', 'hooks.example.com', 'api.webyar.ai', 'shop.example']) {
      expect(await isPlatformHost(env, value)).toBe(false);
    }
    expect(await getPlatformHosts(env)).toEqual({ apex: null, hosts: new Set(), workspaceId: null, origins: new Set() });
    warn.mockRestore();
  });

  it('keeps the environment hosts on write when the database cannot be read, with no platform workspace', async () => {
    tables.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = config({ corsOrigins: ['https://app.webyar.ai'] });
    expect(await isPlatformHost(env, 'https://app.webyar.ai')).toBe(true);
    expect((await getPlatformHosts(env)).workspaceId).toBeNull();
    warn.mockRestore();
  });

  it('never counts a single label or loopback host (localhost, a docker service name)', async () => {
    tables.platform_domains = { ...WEBYAR, help_center_base_url: 'http://127.0.0.1:8080' };
    const env = config({ corsOrigins: ['http://localhost:5173'], aiRuntimeBaseUrl: 'http://ai-runtime:8000' });
    for (const value of ['localhost', 'localhost:3000', 'ai-runtime', '127.0.0.1']) {
      expect(await isPlatformHost(env, value)).toBe(false);
    }
    tables.fail = true;
    __resetPlatformHostsCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await isPlatformHost(env, 'localhost')).toBe(false);
    warn.mockRestore();
  });

  it('reads the database once a minute, not per call', async () => {
    tables.platform_domains = WEBYAR;
    await isPlatformHost(config(), 'api.webyar.ai');
    const reads = tables.reads;
    for (let i = 0; i < 20; i += 1) await isPlatformHost(config(), `x${i}.webyar.ai`);
    expect(tables.reads).toBe(reads);
  });
});

describe('the platform\'s own workspace', () => {
  const PLATFORM = '00000000-0000-4000-8000-00000000000a';
  const OTHER = '00000000-0000-4000-8000-0000000000bb';
  const held = (workspace_id: string, normalized_domain: string, verified = true) =>
    tables.workspace_domains.push({ workspace_id, normalized_domain, verified });

  it('is the holder of the verified apex row, in any spelling of its id', async () => {
    tables.platform_domains = { ...WEBYAR, primary_domain: null, canonical_base_url: 'https://app.webyar.ai' };
    held(OTHER, 'webyar.ai', false);
    held(PLATFORM, 'webyar.ai');
    expect((await getPlatformHosts(config())).workspaceId).toBe(PLATFORM);
    expect(await isPlatformWorkspace(config(), PLATFORM.toUpperCase())).toBe(true);
    expect(await isPlatformWorkspace(config(), OTHER)).toBe(false);
  });

  it('else the holder of the shortest configured host', async () => {
    tables.platform_domains = { primary_domain: null, canonical_base_url: 'https://app.webyar.ai', public_base_url: null };
    held(OTHER, 'deep.help.webyar.ai');
    held(PLATFORM, 'webyar.ai');
    const env = config({ corsOrigins: ['https://webyar.ai', 'https://deep.help.webyar.ai'] });
    const platform = await getPlatformHosts(env);
    expect(platform.apex).toBe('app.webyar.ai');
    expect(platform.workspaceId).toBe(PLATFORM);
  });

  it('is nobody while nobody holds a platform host, or nothing is configured', async () => {
    tables.platform_domains = WEBYAR;
    held(OTHER, 'ninisite.com');
    expect(await isPlatformWorkspace(config(), OTHER)).toBe(false);
    __resetPlatformHostsCache();
    tables.platform_domains = null;
    held(PLATFORM, 'webyar.ai');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await isPlatformWorkspace(config(), PLATFORM)).toBe(false);
    warn.mockRestore();
  });

  it('is read by the platform\'s own site origins, exactly, and only for its own workspace', async () => {
    tables.platform_domains = { ...WEBYAR, help_center_base_url: 'https://help.webyar.ai/fa' };
    held(PLATFORM, 'webyar.ai');
    const env = config({ corsOrigins: ['*', 'https://panel.example.com'] });
    for (const origin of ['https://app.webyar.ai', 'https://APP.WebYar.ai/', 'https://webyar.ai', 'https://help.webyar.ai', 'https://panel.example.com']) {
      expect(await isPlatformSiteOrigin(env, PLATFORM.toUpperCase(), origin)).toBe(true);
    }
    // Not another scheme or port, not every subdomain, not the API, nothing else.
    for (const origin of ['http://app.webyar.ai', 'https://app.webyar.ai:8443', 'https://foo.webyar.ai', 'https://api.webyar.ai', 'https://evil.example', '*', 'null', 'app.webyar.ai']) {
      expect(await isPlatformSiteOrigin(env, PLATFORM, origin)).toBe(false);
    }
    expect(await isPlatformSiteOrigin(env, OTHER, 'https://app.webyar.ai')).toBe(false);
  });
});
