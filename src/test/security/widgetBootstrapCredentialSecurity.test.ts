/**
 * Route-level attack tests for the chat-widget credential-issuance trust
 * boundary, run against the REAL widgetRouter (server/routes/widget.ts) —
 * not a fake handler that calls createSessionToken directly. Mounted on a
 * real express() app with a mocked Supabase client, exercised via real
 * http.request calls so the actual bootstrap → token → poll pipeline an
 * attacker would hit is what's under test.
 *
 * Threat model: a non-browser attacker knows a victim workspace's UUID and
 * its real allowed_domains entry, and can set arbitrary Origin/Referer
 * headers and rotate source IPs. None of those are authentication proof.
 */
import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-widget-security';

const VICTIM_WS = '11111111-1111-4111-8111-111111111111';
const FARM_WS = '33333333-3333-4333-8333-333333333333';
const VICTIM_DOMAIN = 'victim.example';
const VICTIM_ORIGIN = `https://${VICTIM_DOMAIN}`;

// Any workspace id used by a test resolves to a workspace whose
// widget_settings.allowed_domains includes VICTIM_DOMAIN.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      let filterId: string | undefined;
      const b: any = {
        select: () => b,
        eq: (col: string, val: any) => {
          if (col === 'id' || col === 'workspace_id') filterId = val;
          return b;
        },
        in: () => b,
        contains: () => b,
        order: () => b,
        limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => {
          if (table === 'workspaces') return { data: { id: filterId, name: 'Victim Co' }, error: null };
          if (table === 'widget_settings') {
            return { data: { enabled: true, allowed_domains: [VICTIM_DOMAIN], allow_subdomains: false }, error: null };
          }
          return { data: null, error: null };
        },
      };
      b.then = undefined;
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

vi.mock('../../../server/supabase.js', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const client = (createClient as any)();
  return { getServiceClient: () => client };
});

vi.mock('../../../server/services/email/index.js', () => ({ sendEmail: vi.fn() }));
vi.mock('../../../server/services/geo/index.js', () => ({ enrichVisitorSessionGeo: vi.fn() }));

const { widgetRouter } = await import('../../../server/routes/widget.js');
const { resolveRateLimitWorkspaceKey } = await import('../../../server/middleware/security.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = {
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'ANON_KEY',
    supabaseServiceRoleKey: 'SERVICE_KEY',
  };
  next();
});
app.use(express.json());
app.use('/api/widget', widgetRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers = { ...(opts.headers || {}) };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload).toString();
    }
    const req = http.request({ host: '127.0.0.1', port: port(), path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let parsed: any = d;
        try { parsed = JSON.parse(d); } catch { /* leave raw */ }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function bootstrap(headers: Record<string, string>, body: unknown = { workspace_id: VICTIM_WS }) {
  return call('POST', '/api/widget/bootstrap', { headers, body });
}

describe('chat widget bootstrap — real route, credential trust boundary', () => {
  // TEST 2 — spoofed victim Origin + victim workspace_id still yields a
  // functional token (product contract; not itself a vulnerability), but
  // it must decode to rateLimitTrust:'public' and the resolver must NOT
  // select ws:VICTIM for it.
  it('TEST 2: spoofed victim-matching Origin + victim workspace_id yields a token; that token cannot select ws:VICTIM', async () => {
    const res = await bootstrap({ origin: VICTIM_ORIGIN });
    expect(res.status).toBe(200);
    expect(typeof res.body.session_token).toBe('string');
    expect(res.body.session_token.startsWith('wss_')).toBe(true);

    const key = resolveRateLimitWorkspaceKey({
      ip: '203.0.113.9',
      headers: { 'x-widget-token': res.body.session_token },
      body: {},
      query: {},
      originalUrl: '/api/widget/poll',
    } as any);
    expect(key).not.toBe(`ws:${VICTIM_WS}`);
    expect(key).toBe('ip:203.0.113.9');
  });

  it('TEST 2 cont.: that token still works functionally on GET /poll with the same spoofed Origin', async () => {
    const boot = await bootstrap({ origin: VICTIM_ORIGIN });
    const token = boot.body.session_token as string;
    const poll = await call('GET', `/api/widget/poll?workspace_id=${VICTIM_WS}`, {
      headers: { origin: VICTIM_ORIGIN, 'x-widget-token': token },
    });
    expect(poll.status).toBe(200);
  });

  // TEST 5 — no Origin, no Referer
  it('TEST 5: missing Origin AND Referer is rejected outright — no credential issued at all', async () => {
    const res = await bootstrap({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORIGIN_REQUIRED');
    expect(res.body.session_token).toBeUndefined();
  });

  // TEST 4 — token farming via IP rotation against one victim workspace:
  // bounded by the existing pre-auth per-IP limiter (60/min/IP) and global
  // ceiling (1200/min) mounted in server/index.ts — NOT by any per-workspace
  // bootstrap ceiling (which would itself be an attacker-targetable DoS
  // vector keyed on a public workspace UUID). This test exercises the
  // route directly (no server/index.ts pre-auth limiter attached here, by
  // design — that layer is proven separately in
  // preAuthWorkspaceTrustBoundary.test.ts / widgetRateLimit.test.ts) and
  // instead proves the RESULT that matters: none of the tokens farmed this
  // way can ever select ws:VICTIM.
  it('TEST 4: many bootstrap tokens farmed via rotating IPs against one victim workspace still cannot collectively select ws:VICTIM', async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await bootstrap({ origin: VICTIM_ORIGIN, 'x-forwarded-for': `45.9.${i}.1` }, { workspace_id: FARM_WS });
      expect(res.status).toBe(200);
      tokens.push(res.body.session_token);
    }
    for (const token of tokens) {
      const key = resolveRateLimitWorkspaceKey({
        ip: '203.0.113.10',
        headers: { 'x-widget-token': token },
        body: {},
        query: {},
        originalUrl: '/api/widget/poll',
      } as any);
      expect(key).not.toBe(`ws:${FARM_WS}`);
    }
  });

  // Real legitimate flow keeps working end to end.
  it('legitimate widget flow: bootstrap -> poll works with zero UX regression', async () => {
    const boot = await bootstrap({ origin: VICTIM_ORIGIN }, { workspace_id: VICTIM_WS });
    expect(boot.status).toBe(200);
    const token = boot.body.session_token as string;
    const poll = await call('GET', `/api/widget/poll?workspace_id=${VICTIM_WS}`, {
      headers: { origin: VICTIM_ORIGIN, 'x-widget-token': token },
    });
    expect(poll.status).toBe(200);
  });

  // TEST 9 — forged token
  it('TEST 9: a forged/invalid token is never trusted and never selects ws:VICTIM', async () => {
    const res = await call('GET', `/api/widget/poll?workspace_id=${VICTIM_WS}`, {
      headers: { origin: VICTIM_ORIGIN, 'x-widget-token': 'wss_forged.invalidsignature' },
    });
    expect(res.status).toBe(403);
    const key = resolveRateLimitWorkspaceKey({
      ip: '203.0.113.11',
      headers: { 'x-widget-token': 'wss_forged.invalidsignature' },
      body: {},
      query: {},
      originalUrl: '/api/widget/poll',
    } as any);
    expect(key).not.toBe(`ws:${VICTIM_WS}`);
  });

  // TEST 7 — refresh never escalates trust class
  it('TEST 7: refresh keeps rateLimitTrust "public" -> "public"; resolver never selects ws:VICTIM either side', async () => {
    const boot = await bootstrap({ origin: VICTIM_ORIGIN });
    const token = boot.body.session_token as string;
    const refreshed = await call('POST', '/api/widget/session/refresh', {
      headers: { origin: VICTIM_ORIGIN, 'x-widget-token': token },
      body: {},
    });
    expect(refreshed.status).toBe(200);
    expect(typeof refreshed.body.session_token).toBe('string');
    const poll = await call('GET', `/api/widget/poll?workspace_id=${VICTIM_WS}`, {
      headers: { origin: VICTIM_ORIGIN, 'x-widget-token': refreshed.body.session_token },
    });
    expect(poll.status).toBe(200);
    const key = resolveRateLimitWorkspaceKey({
      ip: '203.0.113.12',
      headers: { 'x-widget-token': refreshed.body.session_token },
      body: {},
      query: {},
      originalUrl: '/api/widget/poll',
    } as any);
    expect(key).not.toBe(`ws:${VICTIM_WS}`);
  });

  // TEST 3 — per-session nonce limiter: same token replayed from rotating
  // IPs shares one bucket; a different token gets a different bucket.
  it('TEST 3: the same token replayed from rotating IPs shares one session bucket; a different token gets its own', async () => {
    const bootA = await bootstrap({ origin: VICTIM_ORIGIN });
    const tokenA = bootA.body.session_token as string;
    const bootB = await bootstrap({ origin: VICTIM_ORIGIN });
    const tokenB = bootB.body.session_token as string;
    expect(tokenA).not.toBe(tokenB);

    let limitedForA = 0;
    for (let i = 0; i < 70; i++) {
      const res = await call('GET', `/api/widget/poll?workspace_id=${VICTIM_WS}`, {
        headers: { origin: VICTIM_ORIGIN, 'x-widget-token': tokenA, 'x-forwarded-for': `45.1.${i}.1` },
      });
      if (res.status === 429) limitedForA++;
    }
    expect(limitedForA).toBeGreaterThan(0);

    const freshRes = await call('GET', `/api/widget/poll?workspace_id=${VICTIM_WS}`, {
      headers: { origin: VICTIM_ORIGIN, 'x-widget-token': tokenB, 'x-forwarded-for': '45.1.255.1' },
    });
    expect(freshRes.status).toBe(200);
  }, 30_000);
});

// TEST 6 — backward compatibility: a token signed before the `rl` claim
// existed must parse as 'public' (fail to lower trust), never escalate.
describe('backward compatibility — pre-trust-claim tokens', () => {
  it('TEST 6: a token signed before the rl claim existed parses as rateLimitTrust "public" and never selects ws:VICTIM', async () => {
    const crypto = await import('node:crypto');
    const { verifySessionToken } = await import('../../../server/services/widget/security.js');

    function legacySigningSecret(): Buffer {
      const base = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.WIDGET_SIGNING_SECRET || '';
      return crypto.createHash('sha256').update('widget-session:' + base).digest();
    }

    const now = Math.floor(Date.now() / 1000);
    const legacyPayload = {
      w: VICTIM_WS,
      o: VICTIM_ORIGIN,
      n: crypto.randomBytes(8).toString('hex'),
      iat: now,
      exp: now + 900,
      // no `rl` field — this is what every pre-migration token looks like
    };
    const payloadB64 = Buffer.from(JSON.stringify(legacyPayload)).toString('base64url');
    const sig = crypto.createHmac('sha256', legacySigningSecret()).update(payloadB64).digest('base64url');
    const legacyToken = `wss_${payloadB64}.${sig}`;

    const result = verifySessionToken(legacyToken);
    expect(result.valid).toBe(true);
    expect(result.rateLimitTrust).toBe('public');

    const key = resolveRateLimitWorkspaceKey({
      ip: '203.0.113.13',
      headers: { 'x-widget-token': legacyToken },
      body: {},
      query: {},
      originalUrl: '/api/widget/poll',
    } as any);
    expect(key).not.toBe(`ws:${VICTIM_WS}`);
  });
});
