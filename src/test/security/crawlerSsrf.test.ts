/**
 * P0 — crawler SSRF: redirects must be validated per hop, private/metadata
 * targets blocked, and oversized bodies aborted mid-stream.
 */
import { describe, it, expect } from 'vitest';
import { safeCrawlFetch } from '../../../server/services/ai-agent/crawler/safeCrawlFetch.js';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }] as any;
const privateDns = async () => [{ address: '169.254.169.254', family: 4 }] as any;

function htmlResponse(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...init,
  });
}

const baseOpts = {
  userAgent: 'test-bot',
  timeoutMs: 5000,
  maxBytes: 1024,
  isUrlAllowed: () => true,
};

describe('safeCrawlFetch', () => {
  it('follows a same-origin redirect and returns the final HTML', async () => {
    const seen: string[] = [];
    const res = await safeCrawlFetch('https://example.com/a', {
      ...baseOpts,
      lookupImpl: publicDns,
      fetchImpl: (async (url: any) => {
        seen.push(String(url));
        if (String(url).endsWith('/a')) {
          return new Response(null, { status: 301, headers: { location: 'https://example.com/b' } });
        }
        return htmlResponse('<html>ok</html>');
      }) as any,
    });
    expect(res.ok).toBe(true);
    expect(res.html).toContain('ok');
    expect(seen).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('blocks a redirect to the cloud metadata endpoint', async () => {
    const res = await safeCrawlFetch('https://example.com/a', {
      ...baseOpts,
      lookupImpl: publicDns,
      fetchImpl: (async () =>
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })) as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('redirect_blocked');
  });

  it('blocks a host whose DNS answer resolves to a private address', async () => {
    const res = await safeCrawlFetch('https://internal.example.com/', {
      ...baseOpts,
      lookupImpl: privateDns,
      fetchImpl: (async () => htmlResponse('<html>secret</html>')) as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('blocked_host');
  });

  it('rejects a redirect that leaves the allowed domain', async () => {
    const res = await safeCrawlFetch('https://example.com/a', {
      ...baseOpts,
      isUrlAllowed: (u) => new URL(u).hostname === 'example.com',
      lookupImpl: publicDns,
      fetchImpl: (async () =>
        new Response(null, { status: 307, headers: { location: 'https://evil.test/x' } })) as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('redirect_blocked');
  });

  it('aborts bodies over the byte cap', async () => {
    const res = await safeCrawlFetch('https://example.com/big', {
      ...baseOpts,
      maxBytes: 16,
      lookupImpl: publicDns,
      fetchImpl: (async () => htmlResponse('x'.repeat(5000))) as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('page_too_large');
  });

  it('stops after too many redirects', async () => {
    const res = await safeCrawlFetch('https://example.com/loop', {
      ...baseOpts,
      lookupImpl: publicDns,
      fetchImpl: (async () =>
        new Response(null, { status: 302, headers: { location: 'https://example.com/loop' } })) as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('too_many_redirects');
  });
});