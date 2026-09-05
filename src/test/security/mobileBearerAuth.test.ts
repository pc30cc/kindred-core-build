/**
 * Mobile (Capacitor) Bearer authentication on the EXISTING first-party
 * session infrastructure. Exercises the REAL `requireUser`
 * (server/lib/workspaceAuth.ts) and the REAL sessions service, with only
 * the Supabase service client faked by an in-memory `auth_sessions` table,
 * so a passing test means the actual code path behaves this way:
 *
 *  - web cookie auth is unchanged (including its CSRF Origin check),
 *  - `Authorization: Bearer <opaque session token>` resolves to the SAME
 *    userId through the same validateSessionToken,
 *  - revocation and expiry apply identically to both transports,
 *  - Bearer requests are not rejected by the browser-cookie CSRF rule,
 *  - mobile sessions renew their sliding window server-side, throttled,
 *    and never past the absolute cap.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';

const sessionRows: Array<Record<string, any>> = [];
/** Counts UPDATEs that actually matched a row — proves renewal write dedupe. */
export const updateStats = { writes: 0 };

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let updatePatch: Record<string, any> | null = null;
      const builder: any = {
        select: () => builder,
        update(patch: Record<string, any>) { updatePatch = patch; return builder; },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        lt(col: string, val: any) {
          filters.push((r) => r[col] != null && String(r[col]) < String(val));
          return builder;
        },
        is(col: string, val: any) {
          filters.push((r) => (val === null ? r[col] == null : r[col] === val));
          return builder;
        },
        async maybeSingle() {
          if (table !== 'auth_sessions') return { data: null, error: null };
          const matched = sessionRows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
        then(resolve: any) {
          // Awaiting the builder directly performs the pending update.
          if (updatePatch) {
            const matched = sessionRows.filter((r) => filters.every((f) => f(r)));
            updateStats.writes += matched.length;
            for (const row of matched) {
              Object.assign(row, updatePatch);
            }
          }
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  }),
}));

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async () => false,
}));

const {
  MOBILE_SESSION_IDLE_MS,
  MOBILE_SESSION_ABSOLUTE_MS,
  MOBILE_SESSION_RENEW_THROTTLE_MS,
  getRequestSessionToken,
  renewMobileSessionIfDue,
  validateSessionToken,
} = await import('../../../server/services/auth/sessions.js');
const { requireUser } = await import('../../../server/lib/workspaceAuth.js');

const config: any = { corsOrigins: ['https://app.example.com'] };

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function seedSession(opts: {
  token: string;
  userId?: string;
  clientType?: 'web' | 'mobile';
  expiresInMs?: number;
  absoluteInMs?: number | null;
  lastRenewedAgoMs?: number | null;
  revoked?: boolean;
}) {
  const row = {
    id: crypto.randomUUID(),
    user_id: opts.userId ?? 'user-1',
    email: 'user@example.com',
    token_hash: hashToken(opts.token),
    expires_at: new Date(Date.now() + (opts.expiresInMs ?? 60_000)).toISOString(),
    revoked_at: opts.revoked ? new Date().toISOString() : null,
    client_type: opts.clientType ?? 'web',
    absolute_expires_at:
      opts.absoluteInMs === null || opts.absoluteInMs === undefined
        ? null
        : new Date(Date.now() + opts.absoluteInMs).toISOString(),
    last_renewed_at:
      opts.lastRenewedAgoMs === null || opts.lastRenewedAgoMs === undefined
        ? null
        : new Date(Date.now() - opts.lastRenewedAgoMs).toISOString(),
  };
  sessionRows.push(row);
  return row;
}

function makeReqRes(opts: {
  method?: string;
  origin?: string;
  cookieToken?: string;
  bearerToken?: string;
}) {
  const headers: Record<string, unknown> = {};
  if (opts.origin) headers.origin = opts.origin;
  if (opts.bearerToken) headers.authorization = `Bearer ${opts.bearerToken}`;
  const req: any = {
    method: opts.method ?? 'GET',
    headers,
    cookies: opts.cookieToken ? { gs_session: opts.cookieToken } : {},
    serverConfig: config,
  };
  let statusCode = 0;
  let body: any;
  const res: any = {
    status(c: number) { statusCode = c; return res; },
    json(b: any) { body = b; return res; },
  };
  return { req, res, get: () => ({ statusCode, body }) };
}

beforeEach(() => {
  sessionRows.length = 0;
  updateStats.writes = 0;
});

describe('getRequestSessionToken — transport selection', () => {
  it('reads the gs_session cookie when no Authorization header is present', () => {
    expect(getRequestSessionToken({ headers: {}, cookies: { gs_session: 'cookie-token' } })).toEqual({
      token: 'cookie-token',
      transport: 'cookie',
    });
  });

  it('prefers an Authorization: Bearer token (native client)', () => {
    expect(
      getRequestSessionToken({
        headers: { authorization: 'Bearer mobile-token' },
        cookies: { gs_session: 'cookie-token' },
      }),
    ).toEqual({ token: 'mobile-token', transport: 'bearer' });
  });

  it('ignores a malformed Authorization header', () => {
    expect(getRequestSessionToken({ headers: { authorization: 'Basic abc' }, cookies: {} })).toEqual({
      token: null,
      transport: 'cookie',
    });
  });
});

describe('requireUser — both transports resolve to the same user', () => {
  it('authenticates a web cookie session (unchanged)', async () => {
    seedSession({ token: 'web-token', userId: 'user-web' });
    const { req, res } = makeReqRes({ cookieToken: 'web-token' });
    expect(await requireUser(req, res)).toBe('user-web');
  });

  it('authenticates a mobile Bearer session as the same kind of user id', async () => {
    seedSession({ token: 'mob-token', userId: 'user-mob', clientType: 'mobile' });
    const { req, res } = makeReqRes({ bearerToken: 'mob-token' });
    expect(await requireUser(req, res)).toBe('user-mob');
  });

  it('rejects an unknown Bearer token', async () => {
    const { req, res, get } = makeReqRes({ bearerToken: 'not-a-session' });
    expect(await requireUser(req, res)).toBeNull();
    expect(get().statusCode).toBe(401);
  });

  it('rejects a REVOKED session on the Bearer transport (logout / logout-all / admin revoke)', async () => {
    seedSession({ token: 'revoked-token', clientType: 'mobile', revoked: true });
    const { req, res, get } = makeReqRes({ bearerToken: 'revoked-token' });
    expect(await requireUser(req, res)).toBeNull();
    expect(get().statusCode).toBe(401);
  });

  it('rejects an idle-expired mobile session', async () => {
    seedSession({ token: 'stale-token', clientType: 'mobile', expiresInMs: -1000 });
    const { req, res, get } = makeReqRes({ bearerToken: 'stale-token' });
    expect(await requireUser(req, res)).toBeNull();
    expect(get().statusCode).toBe(401);
  });

  it('rejects a mobile session past its ABSOLUTE cap even if the idle window is open', async () => {
    seedSession({
      token: 'ancient-token',
      clientType: 'mobile',
      expiresInMs: MOBILE_SESSION_IDLE_MS,
      absoluteInMs: -1000,
    });
    expect(await validateSessionToken(config, 'ancient-token')).toBeNull();
  });
});

describe('CSRF — cookie mutations checked, Bearer mutations not misjudged', () => {
  it('rejects a cookie mutation from a forged origin (unchanged web behaviour)', async () => {
    seedSession({ token: 'web-token' });
    const { req, res, get } = makeReqRes({
      method: 'POST',
      origin: 'https://evil.example.com',
      cookieToken: 'web-token',
    });
    expect(await requireUser(req, res)).toBeNull();
    expect(get().statusCode).toBe(403);
  });

  it('allows a cookie mutation from an allowed origin', async () => {
    seedSession({ token: 'web-token', userId: 'user-web' });
    const { req, res } = makeReqRes({
      method: 'POST',
      origin: 'https://app.example.com',
      cookieToken: 'web-token',
    });
    expect(await requireUser(req, res)).toBe('user-web');
  });

  it('allows a Bearer mutation from the native origin (no browser auto-attached credential)', async () => {
    seedSession({ token: 'mob-token', userId: 'user-mob', clientType: 'mobile' });
    const { req, res } = makeReqRes({
      method: 'POST',
      origin: 'capacitor://localhost',
      bearerToken: 'mob-token',
    });
    expect(await requireUser(req, res)).toBe('user-mob');
  });
});

describe('mobile sliding renewal', () => {
  it('does NOT write on every request (throttled to once per day)', async () => {
    const row = seedSession({
      token: 't1',
      clientType: 'mobile',
      expiresInMs: MOBILE_SESSION_IDLE_MS - 60_000,
      absoluteInMs: MOBILE_SESSION_ABSOLUTE_MS,
      lastRenewedAgoMs: 60_000,
    });
    const before = row.expires_at;
    const session = await validateSessionToken(config, 't1');
    await renewMobileSessionIfDue(config, session!);
    expect(row.expires_at).toBe(before);
  });

  it('renews the idle window after the throttle window without a password', async () => {
    const row = seedSession({
      token: 't2',
      clientType: 'mobile',
      expiresInMs: 10 * 24 * 60 * 60 * 1000,
      absoluteInMs: MOBILE_SESSION_ABSOLUTE_MS,
      lastRenewedAgoMs: MOBILE_SESSION_RENEW_THROTTLE_MS + 60_000,
    });
    const before = new Date(row.expires_at).getTime();
    const session = await validateSessionToken(config, 't2');
    await renewMobileSessionIfDue(config, session!);
    const after = new Date(row.expires_at).getTime();
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(Date.now() + MOBILE_SESSION_IDLE_MS + 1000);
  });

  it('never renews past the absolute cap', async () => {
    const cap = 5 * 24 * 60 * 60 * 1000;
    const row = seedSession({
      token: 't3',
      clientType: 'mobile',
      expiresInMs: 60_000,
      absoluteInMs: cap,
      lastRenewedAgoMs: MOBILE_SESSION_RENEW_THROTTLE_MS + 60_000,
    });
    const session = await validateSessionToken(config, 't3');
    await renewMobileSessionIfDue(config, session!);
    expect(new Date(row.expires_at).getTime()).toBeLessThanOrEqual(Date.now() + cap + 1000);
  });

  it('never renews a WEB session (30-day fixed lifetime is unchanged)', async () => {
    const row = seedSession({
      token: 't4',
      clientType: 'web',
      expiresInMs: 60_000,
      lastRenewedAgoMs: MOBILE_SESSION_RENEW_THROTTLE_MS * 10,
    });
    const before = row.expires_at;
    const session = await validateSessionToken(config, 't4');
    await renewMobileSessionIfDue(config, session!);
    expect(row.expires_at).toBe(before);
  });
});


describe('mobile renewal concurrency — at most one write per 24h', () => {
  it('a burst of simultaneous authenticated requests produces ONE renewal write', async () => {
    const row = seedSession({
      token: 'burst',
      clientType: 'mobile',
      expiresInMs: 10 * 24 * 60 * 60 * 1000,
      absoluteInMs: MOBILE_SESSION_ABSOLUTE_MS,
      lastRenewedAgoMs: MOBILE_SESSION_RENEW_THROTTLE_MS + 60_000,
    });
    const sessions = await Promise.all(
      Array.from({ length: 25 }, () => validateSessionToken(config, 'burst')),
    );
    await Promise.all(sessions.map((s) => renewMobileSessionIfDue(config, s!)));
    expect(updateStats.writes).toBe(1);
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('a second (sequential) request inside the throttle window writes nothing more', async () => {
    seedSession({
      token: 'seq',
      clientType: 'mobile',
      expiresInMs: 10 * 24 * 60 * 60 * 1000,
      absoluteInMs: MOBILE_SESSION_ABSOLUTE_MS,
      lastRenewedAgoMs: MOBILE_SESSION_RENEW_THROTTLE_MS + 60_000,
    });
    const first = await validateSessionToken(config, 'seq');
    await renewMobileSessionIfDue(config, first!);
    const second = await validateSessionToken(config, 'seq');
    await renewMobileSessionIfDue(config, second!);
    expect(updateStats.writes).toBe(1);
  });

  it('a stale in-flight read racing a node that already renewed writes zero rows (compare-and-set)', async () => {
    const row = seedSession({
      token: 'cas',
      clientType: 'mobile',
      expiresInMs: 10 * 24 * 60 * 60 * 1000,
      absoluteInMs: MOBILE_SESSION_ABSOLUTE_MS,
      lastRenewedAgoMs: MOBILE_SESSION_RENEW_THROTTLE_MS + 60_000,
    });
    const stale = await validateSessionToken(config, 'cas');
    // Another node renews first.
    row.last_renewed_at = new Date().toISOString();
    updateStats.writes = 0;
    await renewMobileSessionIfDue(config, stale!);
    expect(updateStats.writes).toBe(0);
  });
});

describe('trust boundary — raw token issuance', () => {
  it('never issues a body token to a normal web origin, even with client: mobile', async () => {
    const { allowsMobileTokenIssuance } = await import('../../../server/services/platformOrigins.js');
    expect(allowsMobileTokenIssuance('https://app.example.com')).toBe(false);
    expect(allowsMobileTokenIssuance('http://localhost:5173')).toBe(false);
    expect(allowsMobileTokenIssuance('null')).toBe(false);
    expect(allowsMobileTokenIssuance('*')).toBe(false);
    expect(allowsMobileTokenIssuance('capacitor://evil.example.com')).toBe(false);
    expect(allowsMobileTokenIssuance('ionic://localhost')).toBe(false);
  });

  it('issues to the native shell origin and to non-browser clients only', async () => {
    const { allowsMobileTokenIssuance } = await import('../../../server/services/platformOrigins.js');
    expect(allowsMobileTokenIssuance('capacitor://localhost')).toBe(true);
    expect(allowsMobileTokenIssuance(undefined)).toBe(true);
    expect(allowsMobileTokenIssuance('')).toBe(true);
  });

  it('CORS native allow-list is exact-match and rejects null/wildcard/other schemes', async () => {
    const { isNativeAppOrigin } = await import('../../../server/services/platformOrigins.js');
    expect(isNativeAppOrigin('capacitor://localhost')).toBe(true);
    expect(isNativeAppOrigin('ionic://localhost')).toBe(false);
    expect(isNativeAppOrigin('null')).toBe(false);
    expect(isNativeAppOrigin('*')).toBe(false);
    expect(isNativeAppOrigin('capacitor://localhost.evil.com')).toBe(false);
    expect(isNativeAppOrigin('CAPACITOR://LOCALHOST')).toBe(false);
  });
});
