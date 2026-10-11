/**
 * Super Admin "Login as User" (server/routes/auth.ts):
 *  - POST /api/auth/impersonate redeems the one-time token only in the
 *    browser of the admin who created it, parks the admin's session in
 *    `gs_impersonator` and makes `gs_session` an 8-hour session of the user;
 *  - GET /api/auth/session then reports the impersonator (the panel's banner);
 *  - POST /api/auth/impersonate/stop ends the user's session and puts the
 *    admin's session back.
 * Sessions, identities, tokens and the admin check are in-memory fakes; the
 * routes and the cookie handling are the real ones.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';

type FakeSession = {
  sessionId: string;
  userId: string;
  email: string;
  expiresAt: Date;
  revoked: boolean;
  ttlMs?: number;
};
const sessions = new Map<string, FakeSession>();
const identities = new Map<string, { id: string; email: string; status: string; fullName: string | null }>();
const tokens = new Map<string, { targetUserId: string; createdBy: string; used: boolean }>();
const admins = new Set<string>();
let nextId = 1;

function addSession(token: string, userId: string, email: string) {
  sessions.set(token, {
    sessionId: `s${nextId++}`,
    userId,
    email,
    expiresAt: new Date(Date.now() + 86_400_000),
    revoked: false,
  });
}

vi.mock('../../../server/services/auth/sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../server/services/auth/sessions.js')>();
  return {
    ...real,
    validateSessionToken: vi.fn(async (_c: unknown, token: string | null | undefined) => {
      const s = token ? sessions.get(token) : undefined;
      if (!s || s.revoked) return null;
      return {
        sessionId: s.sessionId,
        userId: s.userId,
        email: s.email,
        clientType: 'web',
        expiresAt: s.expiresAt,
        absoluteExpiresAt: null,
        lastRenewedAt: null,
      };
    }),
    createSession: vi.fn(async (_c: unknown, input: { userId: string; email: string; ttlMs?: number }) => {
      const token = `tok-${nextId++}`;
      addSession(token, input.userId, input.email);
      const s = sessions.get(token)!;
      s.ttlMs = input.ttlMs;
      return { token, sessionId: s.sessionId, expiresAt: s.expiresAt, clientType: 'web' };
    }),
    revokeSession: vi.fn(async (_c: unknown, sessionId: string) => {
      for (const s of sessions.values()) if (s.sessionId === sessionId) s.revoked = true;
    }),
  };
});

vi.mock('../../../server/services/auth/identity.js', () => ({
  findIdentityById: vi.fn(async (_c: unknown, id: string) => identities.get(id) ?? null),
  findIdentityByEmail: vi.fn(async () => null),
}));

vi.mock('../../../server/services/auth/impersonation.js', () => ({
  redeemImpersonationToken: vi.fn(async (_c: unknown, raw: string | null | undefined) => {
    const t = raw ? tokens.get(raw) : undefined;
    if (!t || t.used) return null;
    t.used = true;
    return { targetUserId: t.targetUserId, createdBy: t.createdBy };
  }),
}));

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: vi.fn(async (_c: unknown, userId: string) => admins.has(userId)),
}));

vi.mock('../../../server/middleware/security.js', () => ({
  authRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  checkBruteForce: async () => ({ blocked: false, failCount: 0 }),
  recordLoginAttempt: vi.fn(),
  verifyCaptcha: async () => ({ success: true }),
  logSecurityEvent: vi.fn(async () => {}),
}));

vi.mock('../../../server/services/auth-email.js', () => ({
  issueVerificationEmail: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({}),
}));

const { authSecurityRouter } = await import('../../../server/routes/auth.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { corsOrigins: ['https://app.example.com'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/auth', authSecurityRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

type Jar = Record<string, string>;

function call(method: string, path: string, jar: Jar, body?: unknown): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: (server.address() as { port: number }).port,
        path,
        method,
        headers: {
          origin: 'https://app.example.com',
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(cookie ? { cookie } : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          // Apply Set-Cookie to the jar like a browser would.
          for (const line of res.headers['set-cookie'] ?? []) {
            const [pair, ...attrs] = line.split(';');
            const [name, value] = pair.split('=');
            const expired = attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a.trim()));
            if (expired || !value) delete jar[name.trim()];
            else jar[name.trim()] = value;
          }
          let json: any = {};
          try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
          resolve({ status: res.statusCode || 0, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const ADMIN = 'admin-1';
const USER = 'user-1';
const OTHER = 'user-2';

beforeEach(() => {
  sessions.clear();
  identities.clear();
  tokens.clear();
  admins.clear();
  admins.add(ADMIN);
  identities.set(ADMIN, { id: ADMIN, email: 'admin@example.com', status: 'active', fullName: 'Admin' });
  identities.set(USER, { id: USER, email: 'user@example.com', status: 'active', fullName: 'User One' });
  identities.set(OTHER, { id: OTHER, email: 'other@example.com', status: 'active', fullName: null });
  addSession('admin-token', ADMIN, 'admin@example.com');
});

describe('login as user', () => {
  it('signs the admin in as the user, shows who is behind it, and goes back', async () => {
    tokens.set('t1', { targetUserId: USER, createdBy: ADMIN, used: false });
    const jar: Jar = { gs_session: 'admin-token' };

    const start = await call('POST', '/api/auth/impersonate', jar, { token: 't1' });
    expect(start.status).toBe(200);
    expect(start.json.redirect).toBe('/app');
    expect(jar.gs_impersonator).toBe('admin-token');
    expect(jar.gs_session).not.toBe('admin-token');
    expect(sessions.get(jar.gs_session)?.userId).toBe(USER);
    expect(sessions.get(jar.gs_session)?.ttlMs).toBe(8 * 60 * 60 * 1000);

    const during = await call('GET', '/api/auth/session', jar);
    expect(during.json.user.email).toBe('user@example.com');
    expect(during.json.impersonator).toEqual({ id: ADMIN, email: 'admin@example.com' });

    const userToken = jar.gs_session;
    const stop = await call('POST', '/api/auth/impersonate/stop', jar, {});
    expect(stop.status).toBe(200);
    expect(stop.json).toMatchObject({ restored: true, redirect: '/admin/users' });
    expect(jar.gs_session).toBe('admin-token');
    expect(jar.gs_impersonator).toBeUndefined();
    expect(sessions.get(userToken)?.revoked).toBe(true);

    const after = await call('GET', '/api/auth/session', jar);
    expect(after.json.user.id).toBe(ADMIN);
    expect(after.json.impersonator).toBeUndefined();
  });

  it('does not work in a browser that is not the creating admin', async () => {
    tokens.set('t2', { targetUserId: USER, createdBy: ADMIN, used: false });
    addSession('other-token', OTHER, 'other@example.com');
    const jar: Jar = { gs_session: 'other-token' };
    const res = await call('POST', '/api/auth/impersonate', jar, { token: 't2' });
    expect(res.status).toBe(403);
    expect(jar.gs_session).toBe('other-token');
    expect(jar.gs_impersonator).toBeUndefined();

    const anonymous: Jar = {};
    tokens.set('t3', { targetUserId: USER, createdBy: ADMIN, used: false });
    expect((await call('POST', '/api/auth/impersonate', anonymous, { token: 't3' })).status).toBe(403);
    expect(anonymous.gs_session).toBeUndefined();
  });

  it('rejects a used or unknown token, and a disabled user', async () => {
    const jar: Jar = { gs_session: 'admin-token' };
    expect((await call('POST', '/api/auth/impersonate', jar, { token: 'nope' })).status).toBe(400);
    identities.get(USER)!.status = 'disabled';
    tokens.set('t4', { targetUserId: USER, createdBy: ADMIN, used: false });
    expect((await call('POST', '/api/auth/impersonate', jar, { token: 't4' })).status).toBe(403);
    expect(jar.gs_session).toBe('admin-token');
  });

  it('switches from one user to another and still returns to the admin', async () => {
    const jar: Jar = { gs_session: 'admin-token' };
    tokens.set('a', { targetUserId: USER, createdBy: ADMIN, used: false });
    await call('POST', '/api/auth/impersonate', jar, { token: 'a' });
    const first = jar.gs_session;
    tokens.set('b', { targetUserId: OTHER, createdBy: ADMIN, used: false });
    const res = await call('POST', '/api/auth/impersonate', jar, { token: 'b' });
    expect(res.status).toBe(200);
    expect(sessions.get(first)?.revoked).toBe(true);
    expect(sessions.get(jar.gs_session)?.userId).toBe(OTHER);
    expect(jar.gs_impersonator).toBe('admin-token');
    await call('POST', '/api/auth/impersonate/stop', jar, {});
    expect(jar.gs_session).toBe('admin-token');
  });

  it('sends the browser to login when the admin session is gone', async () => {
    const jar: Jar = { gs_session: 'admin-token' };
    tokens.set('t5', { targetUserId: USER, createdBy: ADMIN, used: false });
    await call('POST', '/api/auth/impersonate', jar, { token: 't5' });
    sessions.get('admin-token')!.revoked = true;
    const userToken = jar.gs_session;

    expect((await call('GET', '/api/auth/session', jar)).json.impersonator).toBeUndefined();
    const stop = await call('POST', '/api/auth/impersonate/stop', jar, {});
    expect(stop.json).toMatchObject({ restored: false, redirect: '/auth/login' });
    expect(jar.gs_session).toBeUndefined();
    expect(jar.gs_impersonator).toBeUndefined();
    expect(sessions.get(userToken)?.revoked).toBe(true);
  });

  it('stop without an impersonation leaves a normal session alone', async () => {
    const jar: Jar = { gs_session: 'admin-token' };
    expect((await call('POST', '/api/auth/impersonate/stop', jar, {})).status).toBe(400);
    expect(sessions.get('admin-token')?.revoked).toBe(false);
  });

  it('logout also drops the parked admin session cookie', async () => {
    const jar: Jar = { gs_session: 'admin-token' };
    tokens.set('t6', { targetUserId: USER, createdBy: ADMIN, used: false });
    await call('POST', '/api/auth/impersonate', jar, { token: 't6' });
    await call('POST', '/api/auth/logout', jar, {});
    expect(jar.gs_session).toBeUndefined();
    expect(jar.gs_impersonator).toBeUndefined();
  });
});
