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
const tables = vi.hoisted(() => ({
  platform_domains: null as Row,
  widget_platform_settings: null as Row,
  fail: false,
  reads: 0,
}));

vi.mock('../supabase.js', () => ({
  getServiceClient: () => ({
    from(table: 'platform_domains' | 'widget_platform_settings') {
      const builder = {
        select: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          tables.reads += 1;
          if (tables.fail) return { data: null, error: { message: 'database unavailable' } };
          return { data: tables[table], error: null };
        },
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

  it('protects nothing while nothing is configured, so customers are untouched', async () => {
    expect(await isPlatformHost(config(), 'api.webyar.ai')).toBe(false);
    expect(await isPlatformHost(config(), 'shop.example')).toBe(false);
  });

  it('keeps the environment hosts when the database cannot be read', async () => {
    tables.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await isPlatformHost(config({ corsOrigins: ['https://app.webyar.ai'] }), 'https://app.webyar.ai')).toBe(true);
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
