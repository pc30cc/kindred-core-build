/**
 * Commerce Gateway SSRF protection (spec §48/§71). The Gateway reuses
 * shared/net/hostGuard.ts unmodified (already covered by other SSRF and
 * crawler tests elsewhere in this repo) — this file proves the
 * Gateway's OWN httpClient wraps it correctly: private-IP targets are
 * rejected before any request is attempted, and a redirect response from
 * an otherwise-safe origin is treated as a hard failure, never followed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { commerceHttpRequest } from '../../../server/services/commerce/httpClient.js';
import { CommerceError } from '../../../shared/commerce/types.js';

describe('Commerce Gateway SSRF / HTTP resilience', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('rejects a request to a loopback address before any network call is made', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    await expect(
      commerceHttpRequest({ url: 'https://127.0.0.1/wp-json/webyar/v1/health', method: 'GET', headers: {} }),
    ).rejects.toThrow(CommerceError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a request to a private RFC1918 address', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    await expect(
      commerceHttpRequest({ url: 'https://192.168.1.50/wp-json/webyar/v1/health', method: 'GET', headers: {} }),
    ).rejects.toThrow(CommerceError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a cloud metadata endpoint', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    await expect(
      commerceHttpRequest({ url: 'https://169.254.169.254/latest/meta-data/', method: 'GET', headers: {} }),
    ).rejects.toThrow(CommerceError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects plain http (only https is permitted to a merchant origin)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    await expect(
      commerceHttpRequest({ url: 'http://store.example.com/wp-json/webyar/v1/health', method: 'GET', headers: {} }),
    ).rejects.toThrow(CommerceError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats a redirect response as a hard failure rather than following it', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 302,
      headers: { get: () => 'application/json' },
      body: null,
    }) as any;

    // A public IP literal — avoids a live DNS lookup so this test exercises
    // ONLY the redirect-handling logic, not name resolution.
    await expect(
      commerceHttpRequest({ url: 'https://93.184.216.34/wp-json/webyar/v1/health', method: 'GET', headers: {} }),
    ).rejects.toThrow(CommerceError);
  });

  it('rejects a non-JSON content-type response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: () => 'text/html' },
      body: null,
    }) as any;

    await expect(
      commerceHttpRequest({ url: 'https://93.184.216.34/wp-json/webyar/v1/health', method: 'GET', headers: {} }),
    ).rejects.toThrow(CommerceError);
  });
});
