/**
 * SEO crawler SSRF hardening — seoFetch.ts wraps the same hardened
 * primitives as the Data Hub crawler (assertHopAllowed/pinnedFetch/
 * readCapped), so these tests prove the SEO-specific wrapper preserves
 * every guarantee: private/loopback/metadata targets blocked, every
 * redirect hop re-validated (including a same-domain-allowed page
 * redirecting to a private IP), byte caps enforced, and redirect loops
 * bounded.
 */
import { describe, it, expect, vi } from 'vitest';
import { seoFetch } from '../../../server/services/seo/crawler/seoFetch.js';
import { isSameDomain } from '../../../server/services/ai-agent/crawler/urlRules.js';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }] as any;

function htmlResponse(body: string, init: ResponseInit = {}) {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
}

const baseOpts = {
  userAgent: 'seo-test-bot',
  timeoutMs: 5000,
  maxBytes: 4096,
  isUrlAllowed: (u: string) => isSameDomain(u, 'example.com'),
};

describe('seoFetch SSRF hardening', () => {
  it('blocks a localhost target outright', async () => {
    const res = await seoFetch('http://localhost/', {
      ...baseOpts,
      isUrlAllowed: () => true,
      lookupImpl: publicDns,
      fetchImpl: (async () => htmlResponse('secret')) as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('blocked_host');
  });

  it('blocks a private IPv4 target resolved via DNS', async () => {
    const privateDns = async () => [{ address: '10.0.0.5', family: 4 }] as any;
    const res = await seoFetch('https://internal.example.com/', {
      ...baseOpts,
      isUrlAllowed: () => true,
      lookupImpl: privateDns,
      fetchImpl: (async () => htmlResponse('secret')) as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('blocked_host');
  });

  it('blocks the cloud metadata endpoint even as a redirect target', async () => {
    const res = await seoFetch('https://example.com/a', {
      ...baseOpts,
      lookupImpl: publicDns,
      fetchImpl: (async () =>
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })) as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('redirect_blocked');
    expect(res.redirectChain).toEqual([{ url: 'https://example.com/a', status: 302 }]);
  });

  it('blocks a registered-domain page that 302s to a private IP (the exact spec example)', async () => {
    const res = await seoFetch('https://example.com/', {
      ...baseOpts,
      lookupImpl: publicDns,
      fetchImpl: (async () =>
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } })) as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('redirect_blocked');
  });

  it('rejects a redirect that leaves the authorized domain (external domain, not a private IP)', async () => {
    const res = await seoFetch('https://example.com/a', {
      ...baseOpts,
      lookupImpl: publicDns,
      fetchImpl: (async () =>
        new Response(null, { status: 302, headers: { location: 'https://evil-external.test/x' } })) as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('redirect_blocked');
  });

  it('rejects a redirect from the registered root domain to an unregistered subdomain', async () => {
    // example.com is registered/authorized; admin.example.com is NOT — even
    // though it shares the root domain, isSameDomain requires an exact host
    // match (after only a www. strip), so this must be blocked exactly like
    // any other cross-domain redirect.
    const res = await seoFetch('https://example.com/a', {
      ...baseOpts,
      lookupImpl: publicDns,
      fetchImpl: (async () =>
        new Response(null, { status: 302, headers: { location: 'https://admin.example.com/secret' } })) as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('redirect_blocked');
  });

  it('allows the www <-> apex alias through a redirect', async () => {
    const res = await seoFetch('https://example.com/a', {
      ...baseOpts,
      lookupImpl: publicDns,
      fetchImpl: (async (url: any) => {
        if (String(url) === 'https://example.com/a') {
          return new Response(null, { status: 301, headers: { location: 'https://www.example.com/a' } });
        }
        return htmlResponse('<html>ok</html>');
      }) as any,
    });
    expect(res.ok).toBe(true);
    expect(res.redirectChain).toEqual([{ url: 'https://example.com/a', status: 301 }]);
  });

  it('enforces the byte cap and reports the response size seen so far', async () => {
    const res = await seoFetch('https://example.com/big', {
      ...baseOpts,
      maxBytes: 16,
      lookupImpl: publicDns,
      fetchImpl: (async () => htmlResponse('x'.repeat(5000))) as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('page_too_large');
  });

  it('bounds redirect loops', async () => {
    const res = await seoFetch('https://example.com/loop', {
      ...baseOpts,
      lookupImpl: publicDns,
      fetchImpl: (async () =>
        new Response(null, { status: 302, headers: { location: 'https://example.com/loop' } })) as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('too_many_redirects');
    expect(res.redirectChain.length).toBeGreaterThan(1);
  });

  it('a DNS lookup failure fails CLOSED, not open (no fetch is ever attempted)', async () => {
    const failingDns = async () => { throw new Error('ENOTFOUND'); };
    const fetchImpl = vi.fn(async () => htmlResponse('should never be reached'));
    const res = await seoFetch('https://example.com/', {
      ...baseOpts,
      lookupImpl: failingDns,
      fetchImpl: fetchImpl as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('dns_failure');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a DNS lookup returning zero answers fails CLOSED', async () => {
    const emptyDns = async () => [] as any[];
    const fetchImpl = vi.fn(async () => htmlResponse('should never be reached'));
    const res = await seoFetch('https://example.com/', {
      ...baseOpts,
      lookupImpl: emptyDns,
      fetchImpl: fetchImpl as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('dns_failure');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('an IPv6 private/unique-local address (fc00::/7) is blocked', async () => {
    const res = await seoFetch('https://internal.example.com/', {
      ...baseOpts,
      isUrlAllowed: () => true,
      lookupImpl: async () => [{ address: 'fd12:3456:789a::1', family: 6 }] as any,
      fetchImpl: (async () => htmlResponse('secret')) as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('blocked_host');
  });

  it('captures response timing and headers on success', async () => {
    const res = await seoFetch('https://example.com/', {
      ...baseOpts,
      lookupImpl: publicDns,
      fetchImpl: (async () => htmlResponse('<html>ok</html>', { headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' } })) as any,
    });
    expect(res.ok).toBe(true);
    expect(res.responseTimeMs).toBeGreaterThanOrEqual(0);
    expect(res.headers?.['x-robots-tag']).toBe('noindex');
  });
});
