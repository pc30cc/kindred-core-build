/**
 * P0 — robots.txt must go through the same hardened outbound transport as page
 * fetches: no redirect to private/loopback/metadata addresses, no cross-origin
 * redirect, DNS answers validated, graceful degradation on timeout.
 */
import { describe, it, expect } from 'vitest';
import { getRobotsRules, isPathAllowedByRobots } from '../../../server/services/ai-agent/crawler/robots.js';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }] as any;
const privateDns = async () => [{ address: '10.1.2.3', family: 4 }] as any;

function text(body: string, init: ResponseInit = {}) {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' }, ...init });
}
function redirect(location: string, status = 302) {
  return new Response(null, { status, headers: { location } });
}

const UA = 'AiAgentDataHubBot/1.0';

describe('getRobotsRules — hardened transport', () => {
  it('parses a normal robots.txt', async () => {
    const rules = await getRobotsRules('https://example.com/', UA, {
      noCache: true,
      lookupImpl: publicDns,
      fetchImpl: (async () => text('User-agent: *\nDisallow: /admin\nAllow: /admin/public\n')) as any,
    });
    expect(rules.disallow).toContain('/admin');
    expect(isPathAllowedByRobots('/admin/secret', rules)).toBe(false);
    expect(isPathAllowedByRobots('/admin/public', rules)).toBe(true);
    expect(isPathAllowedByRobots('/pricing', rules)).toBe(true);
  });

  it('blocks a redirect to a private address', async () => {
    let hops = 0;
    const rules = await getRobotsRules('https://example.com/', UA, {
      noCache: true,
      lookupImpl: publicDns,
      fetchImpl: (async (url: any) => {
        hops++;
        expect(String(url)).not.toContain('10.0.0.5');
        return redirect('http://10.0.0.5/robots.txt');
      }) as any,
    });
    expect(hops).toBe(1);
    expect(rules).toEqual({ allow: [], disallow: [] });
  });

  it('blocks a redirect to localhost', async () => {
    const seen: string[] = [];
    const rules = await getRobotsRules('https://example.com/', UA, {
      noCache: true,
      lookupImpl: publicDns,
      fetchImpl: (async (url: any) => {
        seen.push(String(url));
        return redirect('http://127.0.0.1:8080/robots.txt');
      }) as any,
    });
    expect(seen).toEqual(['https://example.com/robots.txt']);
    expect(rules.disallow).toEqual([]);
  });

  it('blocks a redirect to the cloud metadata endpoint', async () => {
    const rules = await getRobotsRules('https://example.com/', UA, {
      noCache: true,
      lookupImpl: publicDns,
      fetchImpl: (async () => redirect('http://169.254.169.254/latest/meta-data/', 307)) as any,
    });
    expect(rules).toEqual({ allow: [], disallow: [] });
  });

  it('blocks a hostname whose DNS answer resolves to a private IP', async () => {
    let fetched = false;
    const rules = await getRobotsRules('https://intranet.example.com/', UA, {
      noCache: true,
      lookupImpl: privateDns,
      fetchImpl: (async () => { fetched = true; return text('User-agent: *\nDisallow: /'); }) as any,
    });
    expect(fetched).toBe(false);
    expect(rules).toEqual({ allow: [], disallow: [] });
  });

  it('blocks a cross-domain redirect', async () => {
    const seen: string[] = [];
    const rules = await getRobotsRules('https://example.com/', UA, {
      noCache: true,
      lookupImpl: publicDns,
      fetchImpl: (async (url: any) => {
        seen.push(String(url));
        return redirect('https://evil.test/robots.txt', 301);
      }) as any,
    });
    expect(seen).toEqual(['https://example.com/robots.txt']);
    expect(rules).toEqual({ allow: [], disallow: [] });
  });

  it('degrades gracefully when robots.txt times out', async () => {
    const rules = await getRobotsRules('https://slow.example.com/', UA, {
      noCache: true,
      lookupImpl: publicDns,
      fetchImpl: (async (_url: any, init: any) => {
        await new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
        return text('');
      }) as any,
    });
    expect(rules).toEqual({ allow: [], disallow: [] });
    expect(isPathAllowedByRobots('/anything', rules)).toBe(true);
  }, 20000);

  it('degrades gracefully on a 404', async () => {
    const rules = await getRobotsRules('https://example.com/', UA, {
      noCache: true,
      lookupImpl: publicDns,
      fetchImpl: (async () => new Response('nope', { status: 404 })) as any,
    });
    expect(rules).toEqual({ allow: [], disallow: [] });
  });
});
