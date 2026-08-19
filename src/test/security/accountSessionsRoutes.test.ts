/**
 * GoTrue-off closure — first-party active session management.
 *
 * GET/DELETE /api/account/security/sessions* used to describe/manage
 * Supabase's own `auth.sessions` (via account_list_auth_sessions /
 * account_revoke_auth_sessions RPCs + Bearer-JWT payload decoding for
 * "current session" detection) — a table this app's users never populate
 * under first-party auth. Now backed by `public.auth_sessions`, the actual
 * store `requireUser` authenticates every request against.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let orderCol: string | null = null;
      let orderAsc = true;
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r: Row) => r[col] === val); return builder; },
        neq(col: string, val: any) { filters.push((r: Row) => r[col] !== val); return builder; },
        is(col: string, val: null) { filters.push((r: Row) => r[col] === val); return builder; },
        gt(col: string, val: any) { filters.push((r: Row) => r[col] > val); return builder; },
        order(col: string, opts?: { ascending?: boolean }) { orderCol = col; orderAsc = opts?.ascending ?? true; return builder; },
        insert(payload: Row) {
          const inserted = { id: payload.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), ...payload };
          rows.push(inserted);
          return { select: () => ({ single: async () => ({ data: inserted, error: null }) }) };
        },
        update(patch: Row) {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const updateBuilder: any = {
            eq(col: string, val: any) { scoped.push((r: Row) => r[col] === val); return updateBuilder; },
            neq(col: string, val: any) { scoped.push((r: Row) => r[col] !== val); return updateBuilder; },
            is(col: string, val: null) { scoped.push((r: Row) => r[col] === val); return updateBuilder; },
            select: (_cols?: string) => ({
              then: (resolve: any) => {
                const matched = rows.filter((r) => scoped.every((f) => f(r)));
                for (const r of matched) Object.assign(r, patch);
                return resolve({ data: matched, error: null });
              },
            }),
            then: (resolve: any) => {
              const matched = rows.filter((r) => scoped.every((f) => f(r)));
              for (const r of matched) Object.assign(r, patch);
              return resolve({ data: null, error: null });
            },
          };
          return updateBuilder;
        },
        maybeSingle: async () => {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (orderCol) {
            const c = orderCol;
            matched = [...matched].sort((a, b) => (a[c] === b[c] ? 0 : (a[c] > b[c] ? 1 : -1) * (orderAsc ? 1 : -1)));
          }
          return { data: matched[0] ?? null, error: null };
        },
        then(resolve: any) {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (orderCol) {
            const c = orderCol;
            matched = [...matched].sort((a, b) => (a[c] === b[c] ? 0 : (a[c] > b[c] ? 1 : -1) * (orderAsc ? 1 : -1)));
          }
          return resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

const { accountRouter } = await import('../../../server/routes/account.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/account', accountRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(method: string, path: string, token: string | null): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `gs_session=${token}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port(), path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let json: any = {};
        try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const USER_A = crypto.randomUUID();
const USER_B = crypto.randomUUID();
let sessionA1: string, sessionA2: string, sessionB1: string, revokedA: string, expiredA: string;

// Real hashToken() (sha256, matches sessions.ts) so the fake auth_sessions
// rows are addressable the same way validateSessionToken looks them up.
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  sessionA1 = crypto.randomUUID();
  sessionA2 = crypto.randomUUID();
  sessionB1 = crypto.randomUUID();
  revokedA = crypto.randomUUID();
  expiredA = crypto.randomUUID();

  db.profiles = [
    { id: USER_A, email: 'a@example.com', full_name: 'User A', phone: null, created_at: '2026-01-01' },
    { id: USER_B, email: 'b@example.com', full_name: 'User B', phone: null, created_at: '2026-01-01' },
  ];
  db.user_credentials = [];

  const future = new Date(Date.now() + 3600_000).toISOString();
  const past = new Date(Date.now() - 3600_000).toISOString();

  db.auth_sessions = [
    { id: sessionA1, token_hash: hashToken('token-a1'), user_id: USER_A, email: 'a@example.com', created_at: '2026-01-01T00:00:00Z', expires_at: future, revoked_at: null, revoke_reason: null, ip_address: '1.1.1.1', user_agent: 'Mozilla/5.0 Chrome/1' },
    { id: sessionA2, token_hash: hashToken('token-a2'), user_id: USER_A, email: 'a@example.com', created_at: '2026-01-02T00:00:00Z', expires_at: future, revoked_at: null, revoke_reason: null, ip_address: '2.2.2.2', user_agent: 'Mozilla/5.0 Firefox/1' },
    { id: revokedA, token_hash: hashToken('token-a-revoked'), user_id: USER_A, email: 'a@example.com', created_at: '2025-12-01T00:00:00Z', expires_at: future, revoked_at: '2025-12-15T00:00:00Z', revoke_reason: 'logout', ip_address: '3.3.3.3', user_agent: null },
    { id: expiredA, token_hash: hashToken('token-a-expired'), user_id: USER_A, email: 'a@example.com', created_at: '2020-01-01T00:00:00Z', expires_at: past, revoked_at: null, revoke_reason: null, ip_address: '4.4.4.4', user_agent: null },
    { id: sessionB1, token_hash: hashToken('token-b1'), user_id: USER_B, email: 'b@example.com', created_at: '2026-01-01T00:00:00Z', expires_at: future, revoked_at: null, revoke_reason: null, ip_address: '5.5.5.5', user_agent: null },
  ];
});

// server/services/auth/sessions.js is deliberately NOT mocked — this test
// exercises its real validateSessionToken/revokeSession/revokeAllSessions/
// listActiveSessions implementations against the fake auth_sessions table
// above (only getServiceClient is mocked), so it proves the actual session
// lifecycle, not a stand-in for it.

describe('GET /api/account/security/sessions', () => {
  it('a user sees only their own active sessions', async () => {
    const res = await call('GET', '/api/account/security/sessions', 'token-a1');
    expect(res.status).toBe(200);
    const ids = res.json.sessions.map((s: any) => s.id);
    expect(ids.sort()).toEqual([sessionA1, sessionA2].sort());
  });

  it('revoked and expired sessions are excluded from the list', async () => {
    const res = await call('GET', '/api/account/security/sessions', 'token-a1');
    const ids = res.json.sessions.map((s: any) => s.id);
    expect(ids).not.toContain(revokedA);
    expect(ids).not.toContain(expiredA);
  });

  it('cannot see another user\'s sessions', async () => {
    const res = await call('GET', '/api/account/security/sessions', 'token-a1');
    const ids = res.json.sessions.map((s: any) => s.id);
    expect(ids).not.toContain(sessionB1);
  });

  it('the current session is identified from the validated cookie, not a decoded token payload', async () => {
    const res = await call('GET', '/api/account/security/sessions', 'token-a1');
    expect(res.json.current_session_id).toBe(sessionA1);
    const current = res.json.sessions.find((s: any) => s.id === sessionA1);
    const other = res.json.sessions.find((s: any) => s.id === sessionA2);
    expect(current.is_current).toBe(true);
    expect(other.is_current).toBe(false);
  });

  it('never exposes token_hash or any raw token/cookie material', async () => {
    const res = await call('GET', '/api/account/security/sessions', 'token-a1');
    const raw = JSON.stringify(res.json);
    expect(raw).not.toMatch(/token_hash/);
    expect(raw).not.toMatch(/token-a1/);
  });

  it('an expired session cannot authenticate a request at all', async () => {
    const res = await call('GET', '/api/account/security/sessions', 'token-a-expired');
    expect(res.status).toBe(401);
  });

  it('a revoked session cannot authenticate a request at all', async () => {
    const res = await call('GET', '/api/account/security/sessions', 'token-a-revoked');
    expect(res.status).toBe(401);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await call('GET', '/api/account/security/sessions', null);
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/account/security/sessions/:id', () => {
  it('a user can revoke their own secondary session', async () => {
    const res = await call('DELETE', `/api/account/security/sessions/${sessionA2}`, 'token-a1');
    expect(res.status).toBe(200);
    expect(db.auth_sessions.find((s) => s.id === sessionA2)?.revoked_at).toBeTruthy();
  });

  it('a revoked session immediately stops authenticating', async () => {
    await call('DELETE', `/api/account/security/sessions/${sessionA2}`, 'token-a1');
    const res = await call('GET', '/api/account/security/sessions', 'token-a2');
    expect(res.status).toBe(401);
  });

  it('cannot revoke another user\'s session (404, not silently ignored)', async () => {
    const res = await call('DELETE', `/api/account/security/sessions/${sessionB1}`, 'token-a1');
    expect(res.status).toBe(404);
    expect(db.auth_sessions.find((s) => s.id === sessionB1)?.revoked_at).toBeFalsy();
  });

  it('revoking a nonexistent session id returns 404', async () => {
    const res = await call('DELETE', `/api/account/security/sessions/${crypto.randomUUID()}`, 'token-a1');
    expect(res.status).toBe(404);
  });

  it('revoke-all-except-current leaves the caller\'s own session alive', async () => {
    const res = await call('DELETE', '/api/account/security/sessions/x?all=1', 'token-a1');
    expect(res.status).toBe(200);
    expect(db.auth_sessions.find((s) => s.id === sessionA1)?.revoked_at).toBeFalsy();
    expect(db.auth_sessions.find((s) => s.id === sessionA2)?.revoked_at).toBeTruthy();
  });

  it('revoke-all-except-current never touches another user\'s sessions', async () => {
    await call('DELETE', '/api/account/security/sessions/x?all=1', 'token-a1');
    expect(db.auth_sessions.find((s) => s.id === sessionB1)?.revoked_at).toBeFalsy();
  });

  it('rejects an unauthenticated revoke request', async () => {
    const res = await call('DELETE', `/api/account/security/sessions/${sessionA2}`, null);
    expect(res.status).toBe(401);
  });
});
