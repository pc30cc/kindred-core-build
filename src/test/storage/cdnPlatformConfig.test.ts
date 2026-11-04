/**
 * The platform CDN setting as Super Admin → Providers → CDN stores it, read
 * by the real resolveCDNConfig (admin-1), and the limits on a workspace's
 * purge (admin-2). Only the database client and fetch are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';

const db: {
  override: { provider_name: string; config: Record<string, unknown> } | null;
  runtime: unknown;
} = { override: null, runtime: null };

function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b;
  b.maybeSingle = async () => {
    if (table === 'provider_configs') return { data: db.override, error: null };
    if (table === 'app_runtime_config') return { data: db.runtime === null ? null : { value: db.runtime }, error: null };
    return { data: null, error: null };
  };
  b.single = b.maybeSingle;
  return b;
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => ({ from: (t: string) => builder(t) }) }));

const { resolveCDNConfig, resolveCDNConfigWithSource, purgeCDN, purgePathsError, cdnUrlFor, getCDNAssetUrl, CDNPathError } =
  await import('../../../server/services/cdn/index.js');
const { resolveOwnerCdn, purgeOwnerFromCdn } = await import('../../../server/services/cdn/ownerPurge.js');

const serverConfig = {} as never;

/** Exactly what src/providers/sync.ts setGlobalDefaultProvider PUTs for Bunny. */
const STORED_BUNNY = {
  provider_name: 'bunny',
  config: { api_key: 'bunny-secret', pull_zone_id: '12345', hostname: 'https://cdn.webyar.example/' },
};

const fetchMock = vi.fn();

beforeEach(() => {
  db.override = null;
  db.runtime = null;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveCDNConfig reads the stored platform setting (admin-1)', () => {
  it('unwraps { provider_name, config } as the Super Admin screen saves it', async () => {
    db.runtime = STORED_BUNNY;
    const cdn = await resolveCDNConfig(serverConfig, WS);
    expect(cdn).toMatchObject({ provider: 'bunny', apiKey: 'bunny-secret', pullZoneId: '12345', hostname: 'cdn.webyar.example' });
    expect(getCDNAssetUrl(cdn!, '/workspace/x/a.png')).toBe('https://cdn.webyar.example/workspace/x/a.png');
  });

  it('still reads an older flat row', async () => {
    db.runtime = { provider: 'cloudflare', api_token: 't', zone_id: 'z', custom_domain: 'assets.example.com' };
    expect(await resolveCDNConfig(serverConfig, WS)).toMatchObject({ provider: 'cloudflare', apiToken: 't', zoneId: 'z', domain: 'assets.example.com' });
  });

  it('a workspace override wins and says so', async () => {
    db.runtime = STORED_BUNNY;
    db.override = { provider_name: 'fastly', config: { api_token: 'f', service_id: 's', domain: 'own.example.com' } };
    const resolved = await resolveCDNConfigWithSource(serverConfig, WS);
    expect(resolved?.source).toBe('workspace');
    expect(resolved?.config).toMatchObject({ provider: 'fastly', domain: 'own.example.com' });
  });

  it('nothing stored is null', async () => {
    expect(await resolveCDNConfig(serverConfig, WS)).toBeNull();
  });

  it('a deleted owner is purged from the platform CDN with the stored credentials', async () => {
    db.runtime = STORED_BUNNY;
    const result = await purgeOwnerFromCdn(await resolveOwnerCdn(serverConfig, WS), `workspace/${WS}/`);
    expect(result).toMatchObject({ ok: true, url: `https://cdn.webyar.example/workspace/${WS}/*` });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('api.bunny.net/purge');
    expect((init as RequestInit).headers).toMatchObject({ AccessKey: 'bunny-secret' });
  });
});

describe('a workspace purges only its own files on the platform CDN (admin-2)', () => {
  beforeEach(() => { db.runtime = STORED_BUNNY; });

  it('refuses a purge of everything', async () => {
    const result = await purgeCDN(serverConfig, WS, []);
    expect(result).toMatchObject({ success: false, invalidRequest: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['/'],
    [`/workspace/${OTHER_WS}/logo.png`],
    [`/workspace/${WS}/../${OTHER_WS}/x`],
    [`/workspace/${WS}/%2e%2e/%2e%2e/x`],
    ['//evil.example/x'],
    ['@evil.example/x'],
    [`/workspace/${WS}\\..\\x`],
  ])('refuses %s', async (path) => {
    const result = await purgeCDN(serverConfig, WS, [path]);
    expect(result).toMatchObject({ success: false, invalidRequest: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses more than the limit of paths', () => {
    const many = Array.from({ length: 101 }, (_, i) => `/workspace/${WS}/${i}.png`);
    expect(purgePathsError(WS, 'platform', many)).toMatch(/at most/);
  });

  it('purges its own paths, and reports a provider refusal as a failure', async () => {
    expect(await purgeCDN(serverConfig, WS, [`/workspace/${WS}/a.png`])).toMatchObject({ success: true });
    fetchMock.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    const failed = await purgeCDN(serverConfig, WS, [`/workspace/${WS}/a.png`]);
    expect(failed.success).toBe(false);
    expect(failed.error).toMatch(/401/);
  });

  it('on its own CDN a workspace may purge everything', async () => {
    db.override = { provider_name: 'bunny', config: { api_key: 'own', pull_zone_id: '9', hostname: 'own.b-cdn.net' } };
    expect(await purgeCDN(serverConfig, WS, [])).toMatchObject({ success: true });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/pullzone/9/purgeCache');
  });
});

describe('CDN URLs never leave the CDN host', () => {
  it('builds a URL on the host', () => {
    expect(cdnUrlFor('cdn.example.com', '/a/b.png')).toBe('https://cdn.example.com/a/b.png');
    expect(cdnUrlFor('https://cdn.example.com/', '/a')).toBe('https://cdn.example.com/a');
  });

  it.each(['@evil.example/x', '//evil.example/x', 'x', ''])('refuses %j', (path) => {
    expect(() => cdnUrlFor('cdn.example.com', path)).toThrow(CDNPathError);
  });

  it('a Fastly key is never sent to another host', async () => {
    db.override = { provider_name: 'fastly', config: { api_token: 'fastly-key', service_id: 's', domain: 'own.example.com' } };
    const result = await purgeCDN(serverConfig, WS, ['@evil.example/x']);
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the Test probe refuses an internal host', async () => {
    const { testCDNConnection } = await import('../../../server/services/cdn/index.js');
    const result = await testCDNConnection({ provider: 'iranserver_cdn', domain: '127.0.0.1:8000' });
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
