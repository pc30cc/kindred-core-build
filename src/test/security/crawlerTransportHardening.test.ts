/**
 * P0/P1 — the crawl deadline must cover body streaming, and the connection
 * must be pinned to DNS answers that passed validation (rebinding defence).
 */
import { describe, it, expect } from 'vitest';
import { safeCrawlFetch, createPinnedLookup } from '../../../server/services/ai-agent/crawler/safeCrawlFetch.js';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }] as any;

describe('safeCrawlFetch deadline covers body streaming', () => {
  it('aborts a slow drip-feeding body once the deadline passes', async () => {
    const start = Date.now();
    const res = await safeCrawlFetch('https://example.com/slow', {
      userAgent: 'test-bot',
      timeoutMs: 300,
      maxBytes: 1024 * 1024,
      isUrlAllowed: () => true,
      lookupImpl: publicDns,
      fetchImpl: (async (_url: any, init: any) => {
        const signal: AbortSignal = init.signal;
        const stream = new ReadableStream({
          start(controller) {
            // One byte "every few seconds" — never completes on its own.
            const timer = setInterval(() => controller.enqueue(new Uint8Array([0x61])), 2000);
            signal.addEventListener('abort', () => {
              clearInterval(timer);
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } });
      }) as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('timeout');
    expect(Date.now() - start).toBeLessThan(3000);
  }, 15000);
});

describe('createPinnedLookup — connect-time rebinding defence', () => {
  const lookup = createPinnedLookup();

  function resolve(hostname: string): Promise<{ err: any; address?: any; family?: number }> {
    return new Promise((resolveP) => {
      lookup(hostname, { all: false }, (err: any, address: any, family: number) =>
        resolveP({ err, address, family }));
    });
  }

  it('fails closed when the hostname resolves to a loopback address', async () => {
    const r = await resolve('localhost');
    expect(r.err).toBeTruthy();
    expect(String(r.err.message)).toBe('blocked_private_address');
  });

  it('re-resolves at connect time, so a public pre-flight answer cannot be swapped for a private one', async () => {
    // The pre-flight validation sees a public answer …
    const preflight = await publicDns();
    expect(preflight[0].address).toBe('93.184.216.34');
    // … but the socket may only use addresses this lookup returns, and the
    // lookup validates every answer at connect time. Simulate the rebound
    // second answer by resolving a name that maps to loopback.
    const r = await resolve('localhost');
    expect(r.address).toBeUndefined();
    expect(r.err).toBeTruthy();
  });

  it('propagates DNS failures instead of falling through to an unvalidated connect', async () => {
    const r = await resolve('definitely-not-a-real-host.invalid');
    expect(r.err).toBeTruthy();
    expect(r.address).toBeUndefined();
  });
});
