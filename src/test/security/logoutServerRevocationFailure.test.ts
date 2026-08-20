/**
 * revokeSession() (server/services/auth/sessions.ts) previously ignored the
 * `{ error }` PostgREST/Supabase returns on a failed UPDATE — a database
 * failure during POST /api/auth/logout would silently no-op the DB write,
 * clear the browser's cookie anyway, and still answer 200, leaving the
 * server-side session row fully valid while the client believes it is
 * signed out. This exercises the REAL revokeSession() and the REAL
 * /api/auth/logout route (only `server/supabase.js`'s DB client is
 * mocked, at the row level) to prove the server-side DB-error path, not
 * just a frontend fetch failure — a forced update failure must produce a
 * 5xx, an uncleared cookie, and a session that is still valid afterward.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
let forceSessionsUpdateError = false;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let patch: Record<string, unknown> | null = null;
      const builder: any = {
        select: () => builder,
        insert: async (row: Row) => {
          rows.push(row);
          return { error: null };
        },
        update: (p: Record<string, unknown>) => {
          patch = p;
          return builder;
        },
        eq(col: string, val: any) {
          filters.push((r: Row) => r[col] === val);
          return builder;
        },
        is(col: string, val: any) {
          filters.push((r: Row) => (val === null ? r[col] == null : r[col] === val));
          return builder;
        },
        maybeSingle: async () => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
        // Reached only when the chain is awaited directly with no terminal
        // method (matches revokeSession's real `await sb.from(...).update
        // (...).eq(...).is(...)` shape — no .select()/.maybeSingle()).
        then(resolve: (v: any) => void) {
          if (table === 'auth_sessions' && patch && forceSessionsUpdateError) {
            resolve({ error: { message: 'simulated DB failure' } });
            return;
          }
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          if (patch) matched.forEach((r) => Object.assign(r, patch));
          resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  }),
}));

const { authSecurityRouter } = await import('../../../server/routes/auth.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/auth', authSecurityRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function post(path: string, token?: string): Promise<{ status: number; json: any; setCookie: string[] }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: port(),
        path,
        method: 'POST',
        headers: {
          ...(token ? { cookie: `gs_session=${token}` } : {}),
          'content-type': 'application/json',
          'content-length': 0,
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json: any = {};
          try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
          resolve({ status: res.statusCode || 0, json, setCookie: (res.headers['set-cookie'] as string[]) || [] });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const USER_ID = crypto.randomUUID();
const RAW_TOKEN = 'a-real-session-token';
let SESSION_ID: string;

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  forceSessionsUpdateError = false;
  SESSION_ID = crypto.randomUUID();
  db.auth_sessions = [
    {
      id: SESSION_ID,
      user_id: USER_ID,
      email: 'user@example.com',
      token_hash: hashToken(RAW_TOKEN),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      revoked_at: null,
      revoke_reason: null,
    },
  ];
});

describe('revokeSession() — real server-side DB error path', () => {
  it('1. valid session + successful DB revoke -> 200 + cookie cleared', async () => {
    const res = await post('/api/auth/logout', RAW_TOKEN);
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.setCookie.some((c) => c.startsWith('gs_session=;'))).toBe(true);
    expect(db.auth_sessions[0].revoked_at).not.toBeNull();
    expect(db.auth_sessions[0].revoke_reason).toBe('logout');
  });

  it('2. missing/invalid session -> idempotent 200 + cookie cleared', async () => {
    const res = await post('/api/auth/logout', 'not-a-real-token');
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.setCookie.some((c) => c.startsWith('gs_session=;'))).toBe(true);
    // The one real session in the DB was never touched.
    expect(db.auth_sessions[0].revoked_at).toBeNull();
  });

  it('3. valid session + PostgREST update { error } -> 5xx, no success, no cookie clear', async () => {
    forceSessionsUpdateError = true;
    const res = await post('/api/auth/logout', RAW_TOKEN);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.json.success).toBeUndefined();
    expect(res.setCookie.some((c) => c.startsWith('gs_session=;'))).toBe(false);
  });

  it('4. a failed revoke leaves the session still valid', async () => {
    forceSessionsUpdateError = true;
    await post('/api/auth/logout', RAW_TOKEN);
    expect(db.auth_sessions[0].revoked_at).toBeNull();
    expect(db.auth_sessions[0].revoke_reason).toBeNull();

    // Prove it, don't just infer it: turn off the forced failure and use
    // the SAME raw token again — a genuinely revoked session would now be
    // rejected (idempotent 200, nothing to revoke); this one is still a
    // real, live session that gets actually revoked for the first time.
    forceSessionsUpdateError = false;
    const res = await post('/api/auth/logout', RAW_TOKEN);
    expect(res.status).toBe(200);
    expect(db.auth_sessions[0].revoked_at).not.toBeNull();
    expect(db.auth_sessions[0].revoke_reason).toBe('logout');
  });
});

describe('DELETE /api/account/security/sessions/:id — same DB-error path via revokeSession()', () => {
  it('5. a forced DB failure on the underlying revoke surfaces as a 5xx, not a false success', async () => {
    // Exercises revokeSession() directly (the same function /logout and the
    // account "revoke one session" route both call) to prove the fix is in
    // the shared primitive, not duplicated per-caller.
    const { revokeSession } = await import('../../../server/services/auth/sessions.js');
    forceSessionsUpdateError = true;
    await expect(
      revokeSession({ supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as any, SESSION_ID, 'logout'),
    ).rejects.toThrow(/Failed to revoke session/);
    expect(db.auth_sessions[0].revoked_at).toBeNull();
  });
});
