/**
 * server/services/cdn/ownerPurge.ts — after an owner is deleted, the CDN in
 * front of storage must stop serving the deleted files. Before this, a
 * deleted user's avatar and attachments stayed downloadable from the Bunny
 * pull zone's cache (max-age ≈ 296 days) although storage no longer had them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { resolveCDNConfigMock } = vi.hoisted(() => ({ resolveCDNConfigMock: vi.fn() }));
vi.mock('../../../server/services/cdn/index.js', () => ({ resolveCDNConfig: resolveCDNConfigMock }));

const { purgeOwnerFromCdn, resolveOwnerCdn } = await import('../../../server/services/cdn/ownerPurge');

const BUNNY = { provider: 'bunny', apiKey: 'acct-key', hostname: 'cdn.example.com' };
let calls: Array<{ url: string; init?: RequestInit }>;
let respond: () => Response;
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  calls = [];
  respond = () => new Response('', { status: 200 });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  }) as typeof globalThis.fetch;
  resolveCDNConfigMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('purgeOwnerFromCdn', () => {
  it('wildcard-purges everything under the owner prefix through the Bunny API', async () => {
    const result = await purgeOwnerFromCdn(BUNNY, 'workspace/ws-1/');

    expect(result).toEqual({ ok: true, url: 'https://cdn.example.com/workspace/ws-1/*' });
    expect(calls).toHaveLength(1);
    const api = new URL(calls[0].url);
    expect(api.origin + api.pathname).toBe('https://api.bunny.net/purge');
    expect(api.searchParams.get('url')).toBe('https://cdn.example.com/workspace/ws-1/*');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).AccessKey).toBe('acct-key');
  });

  it('accepts a hostname entered with a scheme or trailing slash, or only as the domain', async () => {
    await purgeOwnerFromCdn({ ...BUNNY, hostname: 'https://cdn.example.com/' }, 'users/u-1/');
    await purgeOwnerFromCdn({ provider: 'bunny', apiKey: 'k', domain: 'cdn.example.com' }, 'users/u-1/');

    for (const call of calls) {
      expect(new URL(call.url).searchParams.get('url')).toBe('https://cdn.example.com/users/u-1/*');
    }
  });

  it('reports a failed purge instead of claiming success', async () => {
    respond = () => new Response('unauthorized', { status: 401 });

    const result = await purgeOwnerFromCdn(BUNNY, 'workspace/ws-1/');

    expect(result).toEqual({ ok: false, skipped: false, error: 'Bunny purge failed: 401 unauthorized' });
  });

  it('never throws on a network error', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as typeof globalThis.fetch;

    const result = await purgeOwnerFromCdn(BUNNY, 'workspace/ws-1/');

    expect(result).toEqual({ ok: false, skipped: false, error: 'Bunny purge failed: ECONNRESET' });
  });

  it('skips, without calling anything, when no CDN is configured or it cannot purge by prefix', async () => {
    expect(await purgeOwnerFromCdn(null, 'workspace/ws-1/')).toMatchObject({ ok: false, skipped: true });
    expect(await purgeOwnerFromCdn({ provider: 'cloudflare', apiKey: 'k' }, 'workspace/ws-1/')).toMatchObject({ ok: false, skipped: true });
    expect(await purgeOwnerFromCdn({ provider: 'bunny', hostname: 'cdn.example.com' }, 'workspace/ws-1/')).toMatchObject({ ok: false, skipped: true });
    expect(calls).toHaveLength(0);
  });
});

describe('resolveOwnerCdn', () => {
  it('uses the workspace override lookup for a workspace, and only the global config for an account', async () => {
    resolveCDNConfigMock.mockResolvedValue(BUNNY);

    expect(await resolveOwnerCdn({} as never, 'ws-1')).toBe(BUNNY);
    expect(await resolveOwnerCdn({} as never)).toBe(BUNNY);

    expect(resolveCDNConfigMock.mock.calls[0][1]).toBe('ws-1');
    expect(resolveCDNConfigMock.mock.calls[1][1]).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('returns null instead of throwing when the lookup fails', async () => {
    resolveCDNConfigMock.mockRejectedValue(new Error('db down'));

    expect(await resolveOwnerCdn({} as never, 'ws-1')).toBeNull();
  });
});
