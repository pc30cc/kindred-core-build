/**
 * BLOCKER 1 — migrated-user account-takeover regression suite.
 *
 * POST /api/auth/signup used to upsert a caller-supplied password onto
 * ANY existing identity that didn't already have BOTH a password and a
 * verified email — which includes every migrated (pre-first-party) user,
 * since all of them start with password_hash = NULL. That meant anyone
 * who knew a victim's email could attach their own password to the
 * victim's account via a bare, unauthenticated POST and log in as them.
 *
 * These tests exercise the REAL route (server/routes/auth.ts) mounted on
 * a real HTTP server, against REAL password hashing (server/services/
 * auth/password.ts) and REAL identity/session lookups (identity.ts,
 * sessions.ts) — only the Supabase service client is faked, with an
 * in-memory store that enforces the same unique-email constraint the
 * real `profiles` table does. Security/email side effects (rate limiting,
 * captcha, verification emails) are stubbed to isolate the credential-
 * mutation behavior under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

// ── In-memory fake Supabase service client ─────────────────────────────
type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

function resetDb() {
  for (const key of Object.keys(db)) delete db[key];
  db.profiles = [];
  db.user_credentials = [];
  db.login_attempts = [];
  db.auth_sessions = [];
  db.app_runtime_config = [];
}

function matchesFilters(row: Row, filters: Array<(r: Row) => boolean>): boolean {
  return filters.every((f) => f(row));
}

function fakeClient() {
  return {
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let pendingInsert: Row[] | null = null;
      let pendingUpdate: Row | null = null;
      let pendingUpsert: { items: Row[]; onConflict?: string } | null = null;
      let pendingDelete = false;

      function applyInsert() {
        const inserted: Row[] = [];
        const errors: Array<{ message: string }> = [];
        for (const item of pendingInsert!) {
          if (table === 'profiles' && item.email && rows.some((r) => r.email === item.email)) {
            errors.push({ message: 'duplicate key value violates unique constraint "profiles_email_key"' });
            continue;
          }
          const row = { id: item.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), ...item };
          rows.push(row);
          inserted.push(row);
        }
        if (errors.length) return { data: null, error: errors[0] };
        return { data: inserted, error: null };
      }

      function applyUpdate() {
        const matched = rows.filter((r) => matchesFilters(r, filters));
        for (const r of matched) Object.assign(r, pendingUpdate);
        return { data: matched, error: null };
      }

      function applyUpsert() {
        const { items, onConflict } = pendingUpsert!;
        const result: Row[] = [];
        for (const item of items) {
          const key = onConflict || 'id';
          const idx = rows.findIndex((r) => r[key] === item[key]);
          if (idx >= 0) {
            rows[idx] = { ...rows[idx], ...item, updated_at: new Date().toISOString() };
            result.push(rows[idx]);
          } else {
            const row = { id: item.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), ...item };
            rows.push(row);
            result.push(row);
          }
        }
        return { data: result, error: null };
      }

      function applyDelete() {
        const toDelete = rows.filter((r) => matchesFilters(r, filters));
        db[table] = rows.filter((r) => !toDelete.includes(r));
        return { data: toDelete, error: null };
      }

      const builder: any = {
        select() { return builder; },
        insert(payload: Row | Row[]) { pendingInsert = Array.isArray(payload) ? payload : [payload]; return builder; },
        update(payload: Row) { pendingUpdate = payload; return builder; },
        upsert(payload: Row | Row[], opts?: { onConflict?: string }) {
          pendingUpsert = { items: Array.isArray(payload) ? payload : [payload], onConflict: opts?.onConflict };
          return builder;
        },
        delete() { pendingDelete = true; return builder; },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
        is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return builder; },
        order() { return builder; },
        limit() { return builder; },
        async maybeSingle() {
          if (pendingInsert) { const r = applyInsert(); return { data: r.data?.[0] ?? null, error: r.error }; }
          if (pendingUpsert) { const r = applyUpsert(); return { data: r.data[0] ?? null, error: r.error }; }
          const matched = rows.filter((r) => matchesFilters(r, filters));
          return { data: matched[0] ?? null, error: null };
        },
        async single() {
          if (pendingInsert) { const r = applyInsert(); return { data: r.data?.[0] ?? null, error: r.error }; }
          if (pendingUpsert) { const r = applyUpsert(); return { data: r.data[0] ?? null, error: r.error }; }
          const matched = rows.filter((r) => matchesFilters(r, filters));
          return { data: matched[0] ?? null, error: matched[0] ? null : { message: 'not found' } };
        },
        then(resolve: any, reject: any) {
          try {
            if (pendingInsert) return resolve(applyInsert());
            if (pendingUpdate) return resolve(applyUpdate());
            if (pendingUpsert) return resolve(applyUpsert());
            if (pendingDelete) return resolve(applyDelete());
            const matched = rows.filter((r) => matchesFilters(r, filters));
            return resolve({ data: matched, error: null });
          } catch (e) {
            return reject ? reject(e) : resolve({ data: null, error: e });
          }
        },
      };
      return builder;
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => fakeClient(),
}));

const logSecurityEventMock = vi.fn(async () => {});
vi.mock('../../../server/middleware/security.js', () => ({
  authRateLimiter: (_req: any, _res: any, next: any) => next(),
  checkBruteForce: async () => ({ blocked: false, failCount: 0 }),
  recordLoginAttempt: vi.fn(),
  verifyCaptcha: async () => ({ success: true }),
  logSecurityEvent: (...a: any[]) => (logSecurityEventMock as any)(...a),
}));

const issueVerificationEmailMock = vi.fn(async () => ({ success: true }));
vi.mock('../../../server/services/auth-email.js', () => ({
  issueVerificationEmail: (...a: any[]) => (issueVerificationEmailMock as any)(...a),
  issueRecoveryEmail: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../../server/services/auth/impersonation.js', () => ({
  redeemImpersonationToken: vi.fn(async () => null),
}));

vi.mock('../../../server/routes/admin.js', () => ({
  resolveAppBaseUrl: vi.fn(async () => 'http://localhost'),
}));

const { authSecurityRouter } = await import('../../../server/routes/auth.js');
const { authEmailRouter } = await import('../../../server/routes/auth-email.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = {
    supabaseUrl: 'http://x',
    supabaseServiceRoleKey: 'k',
    corsOrigins: ['http://localhost:5173'],
  };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/auth', authSecurityRouter);
app.use('/api/auth-email', authEmailRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<{ status: number; json: any; setCookie: string | undefined }> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: port(),
        path,
        method,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json: any = {};
          try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
          resolve({ status: res.statusCode || 0, json, setCookie: res.headers['set-cookie']?.[0] });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const VICTIM_EMAIL = 'victim@example.com';

beforeEach(() => {
  resetDb();
  logSecurityEventMock.mockClear();
  issueVerificationEmailMock.mockClear();
});

describe('A — migrated user (password_hash NULL) cannot be taken over via signup', () => {
  it('attacker signup for a victim email never sets a password, attacker cannot log in', async () => {
    const victimId = crypto.randomUUID();
    db.profiles.push({ id: victimId, email: VICTIM_EMAIL, full_name: 'Victim', created_at: new Date().toISOString() });
    // Deliberately NO row in user_credentials — exactly the migrated-user shape.

    const signupRes = await call('POST', '/api/auth/signup', {
      body: { email: VICTIM_EMAIL, password: 'AttackerPassword123', website: '' },
    });

    expect(signupRes.status).toBe(409);
    expect(db.user_credentials.find((c) => c.user_id === victimId)).toBeUndefined();

    const loginRes = await call('POST', '/api/auth/login', {
      body: { email: VICTIM_EMAIL, password: 'AttackerPassword123' },
    });
    // No credentials at all yet — this is the "needs password setup" branch,
    // never a successful login.
    expect(loginRes.status).toBe(403);
    expect(loginRes.json.passwordSetupRequired).toBe(true);
    expect(loginRes.setCookie).toBeUndefined();
    expect(db.auth_sessions).toHaveLength(0);
  });
});

describe('F — signup never reveals whether an existing account has a password set', () => {
  it('a migrated user (no password) and an active user (has a password) get an IDENTICAL signup response', async () => {
    const migratedId = crypto.randomUUID();
    db.profiles.push({ id: migratedId, email: VICTIM_EMAIL, full_name: 'Migrated', created_at: new Date().toISOString() });
    // No user_credentials row — migrated, passwordless.

    const activeEmail = 'active-user@example.com';
    const activeId = crypto.randomUUID();
    const { hashPassword } = await import('../../../server/services/auth/password.js');
    db.profiles.push({ id: activeId, email: activeEmail, full_name: 'Active', created_at: new Date().toISOString() });
    db.user_credentials.push({
      user_id: activeId,
      password_hash: await hashPassword('SomeExistingPassword1'),
      password_algo: 'argon2id',
      email_verified_at: new Date().toISOString(),
      status: 'active',
    });

    const migratedRes = await call('POST', '/api/auth/signup', {
      body: { email: VICTIM_EMAIL, password: 'ProbePassword123', website: '' },
    });
    const activeRes = await call('POST', '/api/auth/signup', {
      body: { email: activeEmail, password: 'ProbePassword123', website: '' },
    });

    expect(migratedRes.status).toBe(409);
    expect(activeRes.status).toBe(409);
    // Same status, same body shape, no field distinguishing the two states.
    expect(migratedRes.json).toEqual(activeRes.json);
    expect(migratedRes.json).not.toHaveProperty('passwordSetupRequired');
    expect(Object.keys(migratedRes.json)).toEqual(['error']);
  });
});

describe('B — existing active user with a password cannot be overwritten via signup', () => {
  it('second signup with a different password leaves the original password valid', async () => {
    const userId = crypto.randomUUID();
    const { hashPassword } = await import('../../../server/services/auth/password.js');
    const originalHash = await hashPassword('OriginalPassword1');
    db.profiles.push({ id: userId, email: VICTIM_EMAIL, full_name: 'Owner', created_at: new Date().toISOString() });
    db.user_credentials.push({
      user_id: userId,
      password_hash: originalHash,
      password_algo: 'argon2id',
      email_verified_at: new Date().toISOString(),
      status: 'active',
    });

    const signupRes = await call('POST', '/api/auth/signup', {
      body: { email: VICTIM_EMAIL, password: 'AttackerPassword123', website: '' },
    });
    expect(signupRes.status).toBe(409);

    const stored = db.user_credentials.find((c) => c.user_id === userId);
    expect(stored?.password_hash).toBe(originalHash);

    const oldPasswordLogin = await call('POST', '/api/auth/login', {
      body: { email: VICTIM_EMAIL, password: 'OriginalPassword1' },
    });
    expect(oldPasswordLogin.status).toBe(200);

    const attackerPasswordLogin = await call('POST', '/api/auth/login', {
      body: { email: VICTIM_EMAIL, password: 'AttackerPassword123' },
    });
    expect(attackerPasswordLogin.status).toBe(401);
  });
});

describe('C — existing unverified user with a password cannot be silently replaced', () => {
  it('a second signup attempt against an unverified account does not touch its password', async () => {
    const userId = crypto.randomUUID();
    const { hashPassword } = await import('../../../server/services/auth/password.js');
    const originalHash = await hashPassword('FirstSignupPassword1');
    db.profiles.push({ id: userId, email: VICTIM_EMAIL, full_name: null, created_at: new Date().toISOString() });
    db.user_credentials.push({
      user_id: userId,
      password_hash: originalHash,
      password_algo: 'argon2id',
      email_verified_at: null, // never verified
      status: 'active',
    });

    const secondSignup = await call('POST', '/api/auth/signup', {
      body: { email: VICTIM_EMAIL, password: 'ReplacementPassword1', website: '' },
    });
    expect(secondSignup.status).toBe(409);
    expect(db.user_credentials.find((c) => c.user_id === userId)?.password_hash).toBe(originalHash);
    // No signup-triggered email side effect for an existing identity.
    expect(issueVerificationEmailMock).not.toHaveBeenCalled();
  });
});

describe('D — password-setup token flow (existing reset infrastructure)', () => {
  it('a migrated user can only get a password via a valid, single-use token; replay fails; new password works', async () => {
    const userId = crypto.randomUUID();
    db.profiles.push({ id: userId, email: VICTIM_EMAIL, full_name: null, created_at: new Date().toISOString() });
    // No user_credentials row — migrated user, password_hash effectively NULL.

    const rawToken = 'a-very-high-entropy-token-value';
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    db.auth_reset_tokens = db.auth_reset_tokens || [];
    db.auth_reset_tokens.push({
      id: crypto.randomUUID(),
      user_id: userId,
      token_hash: tokenHash,
      used_at: null,
      revoked_at: null,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const setupRes = await call('POST', '/api/auth-email/reset-password', {
      body: { token: rawToken, newPassword: 'FreshlyChosenPassword1' },
    });
    expect(setupRes.status).toBe(200);
    expect(db.user_credentials.find((c) => c.user_id === userId)?.password_hash).toBeTruthy();

    // Token is single-use — replay must fail.
    const replay = await call('POST', '/api/auth-email/reset-password', {
      body: { token: rawToken, newPassword: 'AnotherPassword1' },
    });
    expect(replay.status).toBe(400);

    // The password set via the token now works to log in.
    const loginRes = await call('POST', '/api/auth/login', {
      body: { email: VICTIM_EMAIL, password: 'FreshlyChosenPassword1' },
    });
    expect(loginRes.status).toBe(200);
    expect(loginRes.setCookie).toContain('gs_session=');

    // The replayed password never got applied.
    const rejectedLogin = await call('POST', '/api/auth/login', {
      body: { email: VICTIM_EMAIL, password: 'AnotherPassword1' },
    });
    expect(rejectedLogin.status).toBe(401);
  });
});

describe('E — concurrent signups for the same not-yet-existing email', () => {
  it('only one profile is created; the loser gets a duplicate response, not a second credential set', async () => {
    const email = 'racer@example.com';
    const [first, second] = await Promise.all([
      call('POST', '/api/auth/signup', { body: { email, password: 'RacerPasswordOne1', website: '' } }),
      call('POST', '/api/auth/signup', { body: { email, password: 'RacerPasswordTwo2', website: '' } }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(db.profiles.filter((p) => p.email === email)).toHaveLength(1);
    expect(db.user_credentials.filter((c) => db.profiles.find((p) => p.id === c.user_id)?.email === email)).toHaveLength(1);
  });
});
