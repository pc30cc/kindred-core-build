/**
 * FINAL SECURITY HARDENING PASS — stable session lineage + complete
 * per-session rate-limit coverage across the chat widget's route graph.
 *
 * Covers:
 *   R1-R5  — /session/refresh preserves a stable rate-limit session lineage
 *            (the nonce) across rotations, and cannot be used to reset an
 *            already-consumed session quota.
 *   S1-S13 — every token-secured route group receives the canonical
 *            widgetSessionRateLimiter structurally (mounted once, on the
 *            whole /api/widget prefix), not by each route opting in.
 *   O1-O2  — early-mounted sub-routers (identity/attachments/callback/
 *            departments/call-invitations) enforce BOTH token and Origin
 *            binding themselves, since they're mounted before the parent
 *            widgetRouter's own enforceWidgetToken/enforceOrigin.
 *   C1-C3  — the call-widget's public signWidgetSession() can never be
 *            made to emit rl:'workspace', even if a caller tries.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

/** Recursively lists .ts files under a server/ subdirectory (no deps on git). */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-widget-security';

const VICTIM_WS = '55555555-5555-4555-8555-555555555555';
const VICTIM_DOMAIN = 'lineage.example';
const VICTIM_ORIGIN = `https://${VICTIM_DOMAIN}`;

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
        insert: async () => ({ data: null, error: null }),
        maybeSingle: async () => {
          if (table === 'workspaces') return { data: { id: filterId, name: 'Lineage Co' }, error: null };
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
const { widgetSessionRateLimiter } = await import('../../../server/middleware/security.js');
const { verifySessionToken } = await import('../../../server/services/widget/security.js');

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
// Mirrors server/index.ts's real /api/widget mount chain.
app.use('/api/widget', widgetSessionRateLimiter, widgetRouter);

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

async function bootstrap() {
  return call('POST', '/api/widget/bootstrap', { headers: { origin: VICTIM_ORIGIN }, body: { workspace_id: VICTIM_WS } });
}

async function refresh(token: string) {
  return call('POST', '/api/widget/session/refresh', { headers: { origin: VICTIM_ORIGIN, 'x-widget-token': token }, body: {} });
}

describe('R1-R5 — refresh preserves a stable session rate-limit lineage', () => {
  it('R1: bootstrap -> refresh -> refresh keeps the SAME nonce (sessionRateLimitId) across every token instance', async () => {
    const boot = await bootstrap();
    const tokenA = boot.body.session_token as string;
    const nonceA = verifySessionToken(tokenA).nonce;

    const r1 = await refresh(tokenA);
    const tokenB = r1.body.session_token as string;
    const nonceB = verifySessionToken(tokenB).nonce;

    const r2 = await refresh(tokenB);
    const tokenC = r2.body.session_token as string;
    const nonceC = verifySessionToken(tokenC).nonce;

    // Note: token A/B/C may be byte-identical if issued within the same
    // second (iat/exp/nonce/workspace/origin/trust all match) — that's
    // harmless, not a security property. The property that matters is the
    // stable rate-limit lineage:
    expect(nonceA).toBeTruthy();
    expect(nonceB).toBe(nonceA);
    expect(nonceC).toBe(nonceA);
  });

  it('R2: rateLimitTrust stays "public" across every refresh in the chain', async () => {
    const boot = await bootstrap();
    let token = boot.body.session_token as string;
    for (let i = 0; i < 3; i++) {
      expect(verifySessionToken(token).rateLimitTrust).toBe('public');
      const r = await refresh(token);
      token = r.body.session_token as string;
    }
    expect(verifySessionToken(token).rateLimitTrust).toBe('public');
  });

  it('R4: refresh cannot reset an already-consumed session rate-limit quota', async () => {
    const boot = await bootstrap();
    let token = boot.body.session_token as string;

    // widgetSessionRateLimiter is ONE shared 300/min counter for the whole
    // session lineage across EVERY route (poll, refresh, everything) — drive
    // it to exactly one slot below the cap.
    for (let i = 0; i < 299; i++) {
      const res = await call('GET', `/api/widget/poll?workspace_id=${VICTIM_WS}`, {
        headers: { origin: VICTIM_ORIGIN, 'x-widget-token': token, 'x-forwarded-for': `45.4.${Math.floor(i / 250)}.${i % 250}` },
      });
      expect(res.status).toBe(200);
    }

    // Refresh consumes the LAST remaining slot (request #300) on the SAME
    // bucket — if refresh reset the quota instead, the very next request
    // below would still succeed. It must not.
    const r = await refresh(token);
    expect(r.status).toBe(200);
    const newToken = r.body.session_token as string;

    const afterRefresh = await call('GET', `/api/widget/poll?workspace_id=${VICTIM_WS}`, {
      headers: { origin: VICTIM_ORIGIN, 'x-widget-token': newToken, 'x-forwarded-for': '45.4.9.9' },
    });
    expect(afterRefresh.status).toBe(429);
  }, 30_000);

  it('R5: multiple refreshes in a row do not each create a fresh bucket', async () => {
    const boot = await bootstrap();
    let token = boot.body.session_token as string;
    const nonces = new Set<string>();
    for (let i = 0; i < 5; i++) {
      nonces.add(verifySessionToken(token).nonce!);
      const r = await refresh(token);
      token = r.body.session_token as string;
    }
    expect(nonces.size).toBe(1);
  });
});

describe('S1-S13 — every token-secured route group receives structural per-session protection', () => {
  const widgetSrc = readFileSync('server/routes/widget.ts', 'utf8');
  const indexSrc = readFileSync('server/index.ts', 'utf8');

  it('S-mount: widgetSessionRateLimiter is mounted on the whole /api/widget prefix, before widgetRouter runs', () => {
    const mountIdx = indexSrc.indexOf("app.use('/api/widget', widgetCorsMiddleware()");
    expect(mountIdx).toBeGreaterThan(-1);
    const mountLine = indexSrc.slice(mountIdx, indexSrc.indexOf('\n', mountIdx));
    expect(mountLine).toContain('widgetSessionRateLimiter');
    expect(mountLine).toContain('widgetRouter');
  });

  it('S6/S7/S8 — /config, /poll, /message are registered after the parent token+origin gate', () => {
    const gateIdx = widgetSrc.indexOf('widgetRouter.use(enforceWidgetToken)');
    for (const route of ["get('/config'", "get('/poll'", "post('/message'"]) {
      expect(widgetSrc.indexOf(`widgetRouter.${route}`)).toBeGreaterThan(gateIdx);
    }
  });

  it('S9-S13 — sub-routers mounted before the parent gate self-enforce enforceWidgetToken', () => {
    for (const f of [
      'server/routes/widgetIdentity.ts',   // S9  /identity/*
      'server/routes/widgetAttachments.ts', // S10 /attachments/*
      'server/routes/widgetCallbacks.ts',   // S11 /callback/*
      'server/routes/widgetDepartments.ts', // S12 /departments/*
      'server/routes/widgetCallInvitations.ts', // S13 /call-invitations/*
    ]) {
      expect(readFileSync(f, 'utf8')).toContain('enforceWidgetToken');
    }
  });

  // Runtime proof (not just static grep) that the structural limiter really
  // does apply to an early-mounted sub-router's traffic: attachments is the
  // one that had ZERO rate limiting before this pass.
  it('S10 runtime: a valid token replayed past the session cap on /attachments/:id is rejected with 429', async () => {
    const boot = await bootstrap();
    const token = boot.body.session_token as string;
    let sawLimited = false;
    for (let i = 0; i < 305; i++) {
      const res = await call('GET', `/api/widget/attachments/00000000-0000-4000-8000-000000000000`, {
        headers: { origin: VICTIM_ORIGIN, 'x-widget-token': token, 'x-forwarded-for': `45.5.${Math.floor(i / 250)}.${i % 250}` },
      });
      if (res.status === 429) { sawLimited = true; break; }
    }
    expect(sawLimited).toBe(true);
  }, 30_000);
});

describe('O1-O2 — early-mounted sub-routers enforce Origin binding, not just token validity', () => {
  it('O1: a token bound to the real Origin, replayed with a mismatched Origin, is rejected on /attachments/:id BEFORE any DB/storage side effect', async () => {
    const boot = await bootstrap();
    const token = boot.body.session_token as string;
    const res = await call('GET', '/api/widget/attachments/00000000-0000-4000-8000-000000000000', {
      headers: { origin: 'https://evil.example', 'x-widget-token': token },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORIGIN_MISMATCH');
  });

  it('O2: every early-mounted sub-router calls BOTH enforceWidgetToken and enforceOrigin', () => {
    for (const f of [
      'server/routes/widgetIdentity.ts',
      'server/routes/widgetAttachments.ts',
      'server/routes/widgetCallbacks.ts',
      'server/routes/widgetDepartments.ts',
      'server/routes/widgetCallInvitations.ts',
    ]) {
      const src = readFileSync(f, 'utf8');
      expect(src).toContain('enforceWidgetToken');
      expect(src).toContain('enforceOrigin');
    }
  });
});

describe('C1-C3 — call-widget public signer cannot be made to issue rl:"workspace"', () => {
  it('C1/C2: signWidgetSession always produces rl "public", even if a caller tries to override it', async () => {
    const { signWidgetSession, verifyWidgetSession } = await import('../../../server/services/callCenter/widgetSession.js');
    const config: any = { widgetTokenSecret: 'cc-secret' };

    const bootstrapSession = signWidgetSession(config, { workspace_id: 'WS1', public_key: 'pk_1' });
    expect((verifyWidgetSession(config, bootstrapSession) as any)?.rl).toBe('public');

    // Attempt to override via a type-system bypass — must still come out 'public'.
    const attemptedOverride = signWidgetSession(config, { workspace_id: 'WS1', public_key: 'pk_1', rl: 'workspace' } as any);
    expect((verifyWidgetSession(config, attemptedOverride) as any)?.rl).toBe('public');

    // Resumed-call session (buildActiveCallPayload's shape) also stays 'public'.
    const resumedSession = signWidgetSession(config, { workspace_id: 'WS1', public_key: 'pk_1', call_id: 'call-1', visitor_id: 'v1', origin: 'https://real.example' });
    expect((verifyWidgetSession(config, resumedSession) as any)?.rl).toBe('public');
  });

  it('C3: no production route calls signWidgetSession with an rl override', () => {
    const src = readFileSync('server/routes/callWidget.ts', 'utf8');
    // Every real call site should be a plain object literal with no `rl:` key.
    const calls = src.match(/signWidgetSession\(config,\s*\{[^}]*\}/gs) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c).not.toMatch(/rl\s*:/);
    }
    // The escape hatch used only by tests must not be imported here.
    expect(src).not.toContain('signWidgetSessionWithTrust');
  });

  it('T5: no exported trusted call signer exists in the production module at all', async () => {
    const mod = await import('../../../server/services/callCenter/widgetSession.js');
    expect((mod as any).signWidgetSessionWithTrust).toBeUndefined();
    expect(Object.keys(mod).some((k) => /workspaceTrust|withTrust|trustedSign/i.test(k))).toBe(false);
  });
});

describe('T1-T3 — chat-widget public signer cannot be made to issue rl:"workspace"', () => {
  it('T1: createSessionToken always produces rl "public" — the function takes no trust argument at all', async () => {
    const { createSessionToken, verifySessionToken } = await import('../../../server/services/widget/security.js');
    const token = createSessionToken('WS1', 'https://shop.example');
    expect(verifySessionToken(token).rateLimitTrust).toBe('public');
  });

  it('T2: a stale 3-arg trust-class call would be a compile error, not silently reinterpreted — verified by source shape', () => {
    const src = readFileSync('server/services/widget/security.ts', 'utf8');
    const sigMatch = src.match(/export function createSessionToken\(([\s\S]*?)\): string \{/);
    expect(sigMatch).toBeTruthy();
    const sig = sigMatch![1];
    expect(sig).toContain('options?: { sessionNonce?: string }');
    expect(sig).not.toMatch(/rateLimitTrust/);
  });

  it('T3: bootstrap -> refresh keeps rl "public" and the same session lineage (nonce)', async () => {
    const boot = await bootstrap();
    const tokenA = boot.body.session_token as string;
    const nonceA = verifySessionToken(tokenA).nonce;
    expect(verifySessionToken(tokenA).rateLimitTrust).toBe('public');

    const r = await refresh(tokenA);
    const tokenB = r.body.session_token as string;
    expect(verifySessionToken(tokenB).rateLimitTrust).toBe('public');
    expect(verifySessionToken(tokenB).nonce).toBe(nonceA);
  });
});

describe('T6 — resolver still supports a future rl:"workspace" issuer (capability not removed)', () => {
  it('T6: a synthetic rl:"workspace" chat token still resolves to ws:REAL', async () => {
    const { resolveRateLimitWorkspaceKey } = await import('../../../server/middleware/security.js');
    const { makeWorkspaceTrustedWidgetTokenForTest } = await import('./helpers/widgetSessionTokens.js');
    const token = makeWorkspaceTrustedWidgetTokenForTest('REAL-WS', 'https://shop.example');
    const key = resolveRateLimitWorkspaceKey({
      ip: '198.51.100.50',
      headers: { 'x-widget-token': token },
      body: {},
      query: {},
      originalUrl: '/api/widget/poll',
    } as any);
    expect(key).toBe('ws:REAL-WS');
  });

  it('T6: a synthetic rl:"workspace" call-widget session still resolves to ws:REAL-CC', async () => {
    const { resolveRateLimitWorkspaceKey } = await import('../../../server/middleware/security.js');
    const { makeWorkspaceTrustedCallWidgetSessionForTest } = await import('./helpers/widgetSessionTokens.js');
    const config: any = { widgetTokenSecret: 'cc-secret' };
    const session = makeWorkspaceTrustedCallWidgetSessionForTest(config, { workspace_id: 'REAL-CC', public_key: 'pk_1' });
    const key = resolveRateLimitWorkspaceKey({
      ip: '198.51.100.51',
      serverConfig: config,
      headers: { 'x-cc-session': session },
      body: {},
      query: {},
      originalUrl: '/api/call-widget/state',
    } as any);
    expect(key).toBe('ws:REAL-CC');
  });
});

describe('T7 — production grep guard: zero rl:"workspace" issuance capability under server/', () => {
  it('no server/ file (excluding comments) contains a signing call literally passing rl: "workspace"', () => {
    const RL_WORKSPACE = /rl:\s*['"]workspace['"]/;
    const offenders: string[] = [];
    for (const file of listTsFiles('server')) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!RL_WORKSPACE.test(line)) return;
        // Every hit must be a comment/doc-string, never a live object
        // literal passed to a signing function.
        const trimmed = line.trim();
        const isCommentOnly = trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
        if (!isCommentOnly) offenders.push(`${file}:${i + 1}: ${line}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('no production module exports a function whose name suggests a trust-override signer', () => {
    const files = [
      'server/services/widget/security.ts',
      'server/services/callCenter/widgetSession.ts',
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const exportedFns = [...src.matchAll(/export function (\w+)/g)].map((m) => m[1]);
      for (const name of exportedFns) {
        expect(/workspaceTrust|withTrust|trustedSign|createWorkspaceTrusted/i.test(name)).toBe(false);
      }
    }
  });
});
