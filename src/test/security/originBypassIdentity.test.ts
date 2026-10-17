// @vitest-environment node
/**
 * One client identity for every layer, whether the request came through
 * Cloudflare or straight to the origin's address (192.99.68.134) through
 * Traefik, as server/index.ts wires it: `trust proxy` as in production, then
 * installClientIpGetter, so `req.ip` (express-rate-limit, the IP blocklist,
 * brute force, audit rows) is server/utils/clientIp.ts getClientIp.
 *
 * supertest connects from loopback, which plays Traefik: it is a private
 * peer and names the hop it saw in X-Forwarded-For.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const blocked = new Set<string>();
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table !== 'ip_blocklist') return { insert: async () => ({}) };
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.or = () => b;
      b.order = () => b;
      b.range = async (from: number) => {
        const list = from === 0 ? [...blocked].map((ip) => ({ ip_address: ip, blocked_until: null })) : [];
        return { data: list, error: null, count: blocked.size };
      };
      return b;
    },
  }),
}));

const { installClientIpGetter, getClientIp, getClientCountry, resetTrustedProxyCache } = await import('../../../server/utils/clientIp.js');
const sec = await import('../../../server/middleware/security.js');

const CLIENT = '185.23.45.67';
const CF_EDGE = '172.70.1.1';

function buildApp() {
  const app = express();
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  installClientIpGetter(app);
  app.use((req, _res, next) => {
    (req as unknown as { serverConfig: unknown }).serverConfig = { complianceAuditLoggingEnabled: false };
    next();
  });
  app.use(sec.ipBlockMiddleware());
  app.get('/whoami', (req, res) => {
    res.json({ ip: req.ip, clientIp: getClientIp(req), country: getClientCountry(req) });
  });
  app.post('/login', sec.authRateLimiter, (_req, res) => res.json({ ok: true }));
  app.post('/logout', sec.sessionActionRateLimiter, (_req, res) => res.json({ ok: true }));
  app.get('/api/admin/stats', sec.adminRateLimiter, (_req, res) => res.json({ ok: true }));
  // A failed password check, as the login route records it.
  app.post('/login-fails', async (req, res) => {
    const state = await sec.checkBruteForce(req, 'owner@example.com');
    if (state.blocked) return res.status(429).json({ retryAfter: state.retryAfter });
    sec.recordLoginAttempt(req, 'owner@example.com', false);
    return res.status(401).json({ ok: false });
  });
  return app;
}

beforeEach(() => {
  delete process.env.CLOUDFLARE_IPS;
  delete process.env.TRUSTED_PROXY_IPS;
  resetTrustedProxyCache();
  blocked.clear();
  sec.__resetIpBlocklistForTests();
});

describe('req.ip is the canonical client address', () => {
  it('through Cloudflare: the visitor (cf-connecting-ip), with its country', async () => {
    const r = await request(buildApp()).get('/whoami')
      .set('X-Forwarded-For', CF_EDGE).set('CF-Connecting-IP', CLIENT).set('CF-IPCountry', 'TR');
    expect(r.body).toEqual({ ip: CLIENT, clientIp: CLIENT, country: 'TR' });
  });

  it('straight to the origin: the address Traefik saw, whatever cf-* it sends', async () => {
    const r = await request(buildApp()).get('/whoami')
      .set('X-Forwarded-For', `9.9.9.9, ${CF_EDGE}, ${CLIENT}`).set('CF-Connecting-IP', '9.9.9.9').set('CF-IPCountry', 'US');
    expect(r.body).toEqual({ ip: CLIENT, clientIp: CLIENT, country: null });
  });

  it('local dev (no forwarding headers): Express\'s own loopback address', async () => {
    const r = await request(buildApp()).get('/whoami');
    expect(r.body.clientIp).toBeNull();
    expect(r.body.ip).toMatch(/^(::ffff:)?127\.0\.0\.1$|^::1$/);
  });
});

describe('the express-rate-limit layers cannot be dodged by rotating cf-connecting-ip', () => {
  it('a direct client gets one bucket (authRateLimiter: 5 a minute)', async () => {
    const app = buildApp();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await request(app).post('/login')
        .set('X-Forwarded-For', '45.33.32.156').set('CF-Connecting-IP', `9.9.9.${i + 1}`);
      codes.push(r.status);
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
  });

  it('visitors behind one Cloudflare edge get their own buckets', async () => {
    const app = buildApp();
    for (let i = 0; i < 7; i++) {
      const r = await request(app).post('/login')
        .set('X-Forwarded-For', CF_EDGE).set('CF-Connecting-IP', `185.23.45.${i + 1}`);
      expect(r.status).toBe(200);
    }
  });
});

describe('the IP blocklist matches the visitor, not a Cloudflare edge', () => {
  it('blocks a listed visitor that comes through Cloudflare', async () => {
    blocked.add(CLIENT);
    const r = await request(buildApp()).get('/whoami').set('X-Forwarded-For', CF_EDGE).set('CF-Connecting-IP', CLIENT);
    expect(r.status).toBe(403);
  });

  it('a listed client cannot unblock itself by naming another address', async () => {
    blocked.add(CLIENT);
    const r = await request(buildApp()).get('/whoami').set('X-Forwarded-For', CLIENT).set('CF-Connecting-IP', '9.9.9.9');
    expect(r.status).toBe(403);
  });

  it('a direct client cannot get a visitor blocked... or pass as one', async () => {
    blocked.add('9.9.9.9');
    const r = await request(buildApp()).get('/whoami').set('X-Forwarded-For', CLIENT).set('CF-Connecting-IP', '9.9.9.9');
    expect(r.status).toBe(200);
    expect(r.body.ip).toBe(CLIENT);
  });
});

describe('limits sized for one person, now that one person is one bucket', () => {
  it('the admin dashboard (13 queries on load, again on focus, polls and retries) fits adminRateLimiter', async () => {
    const app = buildApp();
    const admin = '5.120.33.44';
    const edges = ['172.70.1.1', '162.158.127.231', '104.23.1.9', '172.71.4.2'];
    for (let i = 0; i < 60; i++) {
      const r = await request(app).get('/api/admin/stats')
        .set('X-Forwarded-For', edges[i % edges.length]).set('CF-Connecting-IP', admin);
      expect(r.status, `request ${i + 1}`).toBe(200);
    }
  });

  it('signing out and Super Admin impersonation do not spend the 5-a-minute login budget', async () => {
    const app = buildApp();
    const admin = '5.120.33.45';
    for (let i = 0; i < 8; i++) {
      const r = await request(app).post('/logout').set('X-Forwarded-For', CF_EDGE).set('CF-Connecting-IP', admin);
      expect(r.status).toBe(200);
    }
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post('/login').set('X-Forwarded-For', CF_EDGE).set('CF-Connecting-IP', admin);
      expect(r.status).toBe(200);
    }
  });

  it('the brute-force lock holds for an IPv6 client that rotates its address inside its /56', async () => {
    const app = buildApp();
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await request(app).post('/login-fails')
        .set('X-Forwarded-For', CF_EDGE).set('CF-Connecting-IP', `2a01:5ec0:1000:${i.toString(16)}::${i + 1}`);
      codes.push(r.status);
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
  });
});
