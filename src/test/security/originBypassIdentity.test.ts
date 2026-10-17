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
