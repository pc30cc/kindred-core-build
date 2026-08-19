/**
 * BLOCKER 3 — proves `verifyOriginForMutation` is actually WIRED into the
 * authenticated request path, not just unit-tested in isolation as dead
 * code. Before this fix, grepping the whole server tree for its name
 * turned up exactly one hit: its own definition in sessions.ts — nothing
 * ever called it.
 *
 * This exercises the REAL `requireUser` (server/lib/workspaceAuth.ts) and
 * the REAL `verifyOriginForMutation`/`validateSessionToken`
 * (server/services/auth/sessions.ts) together, with only the Supabase
 * service client faked (an in-memory `auth_sessions` table), so a passing
 * test here means the actual code path — not a mock of it — rejects a
 * forged-origin mutation.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

const sessionRows: Array<Record<string, any>> = [];

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return builder; },
        async maybeSingle() {
          if (table !== 'auth_sessions') return { data: null, error: null };
          const matched = sessionRows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
      };
      return builder;
    },
  }),
}));

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async () => false,
}));

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function makeReqRes(opts: { method: string; origin?: string; token?: string }) {
  const req: any = {
    method: opts.method,
    headers: opts.origin ? { origin: opts.origin } : {},
    cookies: opts.token ? { gs_session: opts.token } : {},
    serverConfig: { corsOrigins: ['https://app.example.com'] },
  };
  let statusCode = 0;
  let body: any;
  const res: any = {
    status(c: number) { statusCode = c; return res; },
    json(b: any) { body = b; return res; },
  };
  return { req, res, get: () => ({ statusCode, body }) };
}

const USER_ID = '22222222-2222-2222-2222-222222222222';
const TOKEN = 'a-real-looking-session-token';

beforeEach(() => {
  sessionRows.length = 0;
  sessionRows.push({
    id: crypto.randomUUID(),
    user_id: USER_ID,
    email: 'user@example.com',
    token_hash: hashToken(TOKEN),
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    revoked_at: null,
  });
});

describe('requireUser — CSRF Origin enforcement on mutations', () => {
  it('allows a same-origin (configured, trusted) mutation', async () => {
    const { requireUser } = await import('../../../server/lib/workspaceAuth.js');
    const { req, res, get } = makeReqRes({ method: 'POST', origin: 'https://app.example.com', token: TOKEN });
    const userId = await requireUser(req, res);
    expect(userId).toBe(USER_ID);
    expect(get().statusCode).toBe(0);
  });

  it('rejects a mutation from an untrusted cross-site origin', async () => {
    const { requireUser } = await import('../../../server/lib/workspaceAuth.js');
    const { req, res, get } = makeReqRes({ method: 'POST', origin: 'https://evil.attacker.example', token: TOKEN });
    const userId = await requireUser(req, res);
    expect(userId).toBeNull();
    expect(get().statusCode).toBe(403);
  });

  it('allows a GET (non-mutating) request from an untrusted origin — CSRF only gates state changes', async () => {
    const { requireUser } = await import('../../../server/lib/workspaceAuth.js');
    const { req, res, get } = makeReqRes({ method: 'GET', origin: 'https://evil.attacker.example', token: TOKEN });
    const userId = await requireUser(req, res);
    expect(userId).toBe(USER_ID);
    expect(get().statusCode).toBe(0);
  });

  it('allows a mutation with no Origin header at all (defined, documented behavior)', async () => {
    const { requireUser } = await import('../../../server/lib/workspaceAuth.js');
    const { req, res, get } = makeReqRes({ method: 'DELETE', token: TOKEN });
    const userId = await requireUser(req, res);
    expect(userId).toBe(USER_ID);
    expect(get().statusCode).toBe(0);
  });

  it('rejects a mutation with an Origin header when corsOrigins is wildcarded/unconfigured — wildcard never silently disables CSRF', async () => {
    const { requireUser } = await import('../../../server/lib/workspaceAuth.js');
    const { req, res, get } = makeReqRes({ method: 'PUT', origin: 'https://anyone.example', token: TOKEN });
    req.serverConfig.corsOrigins = ['*'];
    const userId = await requireUser(req, res);
    expect(userId).toBeNull();
    expect(get().statusCode).toBe(403);
  });

  it('still checks auth first — an unauthenticated forged-origin mutation gets 401, not 403 (no origin oracle before auth)', async () => {
    const { requireUser } = await import('../../../server/lib/workspaceAuth.js');
    const { req, res, get } = makeReqRes({ method: 'POST', origin: 'https://evil.attacker.example', token: 'wrong-token' });
    const userId = await requireUser(req, res);
    expect(userId).toBeNull();
    expect(get().statusCode).toBe(401);
  });

  it('PATCH and PUT are gated the same as POST/DELETE', async () => {
    const { requireUser } = await import('../../../server/lib/workspaceAuth.js');
    for (const method of ['PATCH', 'PUT']) {
      const { req, res, get } = makeReqRes({ method, origin: 'https://evil.attacker.example', token: TOKEN });
      const userId = await requireUser(req, res);
      expect(userId).toBeNull();
      expect(get().statusCode).toBe(403);
    }
  });
});

describe('verifyOriginForMutation — pure policy function', () => {
  it('a second explicitly configured trusted origin is also allowed (multi-origin allow-list)', async () => {
    const { verifyOriginForMutation } = await import('../../../server/services/auth/sessions.js');
    const req = { headers: { origin: 'https://staging.example.com' } };
    expect(verifyOriginForMutation(req, ['https://app.example.com', 'https://staging.example.com'])).toBe(true);
  });

  it('wildcard CORS config never approves a mutation that presents an Origin header', async () => {
    const { verifyOriginForMutation } = await import('../../../server/services/auth/sessions.js');
    const req = { headers: { origin: 'https://literally-anyone.example' } };
    expect(verifyOriginForMutation(req, ['*'])).toBe(false);
  });
});
