/* eslint-disable @typescript-eslint/no-explicit-any -- Express test doubles are intentionally untyped. */
/**
 * V-37: a blocked address on the widget's paths gets an answer the
 * customer's page can read (the IP block runs before the widget's CORS
 * middleware, so it used to be a bare 403: a CORS failure, retries, and a
 * broken launcher). The bootstrap says the widget is off, so the loader takes
 * the launcher away; every other widget path answers 403 IP_BLOCKED with CORS;
 * the preflight passes. Paths that are not the widget's keep the plain 403.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: () => {
      const b: any = {
        select: () => b, or: () => b, order: () => b,
        range: () => Promise.resolve({ data: [{ ip_address: '203.0.113.9', blocked_until: null }], error: null, count: 1 }),
      };
      return b;
    },
  }),
}));

const { ipBlockMiddleware, __resetIpBlocklistForTests } = await import('../../../server/middleware/security.js');

function makeRes() {
  const state: any = { code: 200, body: null, headers: {} as Record<string, string>, ended: false };
  const res: any = {
    state,
    status(c: number) { state.code = c; return res; },
    json(b: any) { state.body = b; return res; },
    end() { state.ended = true; return res; },
    setHeader(k: string, v: string) { state.headers[k.toLowerCase()] = v; },
  };
  return res;
}

async function run(path: string, opts: { method?: string; origin?: string; ip?: string } = {}) {
  const req: any = {
    ip: opts.ip || '203.0.113.9', socket: {}, serverConfig: {}, method: opts.method || 'POST',
    originalUrl: path, url: path, headers: opts.origin ? { origin: opts.origin } : {},
  };
  const res = makeRes();
  const next = vi.fn();
  await ipBlockMiddleware()(req, res, next);
  return { ...res.state, passed: next.mock.calls.length === 1 };
}

describe('V-37: a blocked visitor gets an answer, not a broken widget', () => {
  beforeEach(() => { __resetIpBlocklistForTests(); });

  it('the bootstrap (both paths) says the widget is off, readable by the page', async () => {
    for (const path of ['/api/widget/boot', '/api/widget/bootstrap']) {
      const r = await run(path, { origin: 'https://shop.example' });
      expect(r.passed).toBe(false);
      expect(r.code).toBe(200);
      expect(r.body).toMatchObject({ disabled: true, protocol: 3 });
      expect(r.headers['access-control-allow-origin']).toBe('https://shop.example');
      expect(r.headers['access-control-allow-credentials']).toBe('true');
    }
  });

  it('another widget path: 403 IP_BLOCKED with CORS; its preflight passes', async () => {
    const r = await run('/api/widget/message?workspace_id=x', { origin: 'https://shop.example' });
    expect(r.code).toBe(403);
    expect(r.body).toMatchObject({ code: 'IP_BLOCKED' });
    expect(r.headers['access-control-allow-origin']).toBe('https://shop.example');
    const pre = await run('/api/widget/message', { method: 'OPTIONS', origin: 'https://shop.example' });
    expect(pre.code).toBe(204);
    expect(pre.ended).toBe(true);
    expect(pre.headers['access-control-allow-origin']).toBe('https://shop.example');
    const presence = await run('/api/realtime/visitor-presence', { origin: 'https://shop.example' });
    expect(presence.headers['access-control-allow-origin']).toBe('https://shop.example');
  });

  it('a path that is not the widget\'s keeps the plain 403 (no CORS)', async () => {
    const r = await run('/api/conversations/send-message', { origin: 'https://evil.example' });
    expect(r.code).toBe(403);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('an address that is not blocked passes', async () => {
    const r = await run('/api/widget/boot', { ip: '198.51.100.1', origin: 'https://shop.example' });
    expect(r.passed).toBe(true);
  });
});
