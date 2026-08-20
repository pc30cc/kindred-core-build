/**
 * POST /api/account/change-password must revoke every OTHER active
 * first-party session for the caller while leaving their own current
 * session valid — a session stolen before the change must not survive it.
 * The write and the revocation happen inside one
 * `change_password_and_revoke_sessions` SECURITY DEFINER call
 * (database/migrations/031_change_password_revoke_sessions.sql), mocked
 * here at the RPC boundary with an in-memory implementation of the same
 * claim-then-write semantics.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import { hashPassword } from '../../../server/services/auth/password';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
let forceRpcFailure = false;

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r: Row) => r[col] === val); return builder; },
        maybeSingle: async () => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
      };
      return builder;
    },
    rpc: async (name: string, args: any) => {
      if (name === 'change_password_and_revoke_sessions') {
        if (forceRpcFailure) return { data: null, error: { message: 'simulated DB failure' } };
        const cred = (db.user_credentials || []).find((c) => c.user_id === args._user_id);
        if (!cred) return { data: null, error: { message: `no user_credentials row for ${args._user_id}` } };
        cred.password_hash = args._new_password_hash;
        cred.password_algo = 'argon2id';
        let revoked = 0;
        for (const s of db.auth_sessions || []) {
          if (s.user_id === args._user_id && !s.revoked_at && s.id !== args._except_session_id) {
            s.revoked_at = new Date().toISOString();
            s.revoke_reason = 'password_changed';
            revoked += 1;
          }
        }
        return { data: revoked, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  requireUser: async (req: any, res: any) => {
    const token = req.cookies?.gs_session;
    const session = (db.__sessions || []).find((s) => s.token === token);
    if (!session) {
      res.status(401).json({ error: 'Not authenticated' });
      return null;
    }
    return session.userId;
  },
}));

vi.mock('../../../server/services/auth/identity.js', () => ({
  findIdentityById: async (_config: unknown, userId: string) => {
    const profile = (db.profiles || []).find((p) => p.id === userId);
    if (!profile) return null;
    return {
      id: profile.id,
      email: profile.email,
      phone: null,
      fullName: profile.full_name ?? null,
      createdAt: profile.created_at ?? null,
    };
  },
}));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    const session = (db.__sessions || []).find((s) => s.token === token);
    return session ? { sessionId: session.sessionId, userId: session.userId, email: 'x@example.com' } : null;
  },
  revokeSession: vi.fn(),
  revokeAllSessions: vi.fn(),
  listActiveSessions: vi.fn(async () => []),
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

function call(path: string, token: string, body: unknown): Promise<{ status: number; json: any }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: port(),
        path,
        method: 'POST',
        headers: {
          cookie: `gs_session=${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json: any = {};
          try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
          resolve({ status: res.statusCode || 0, json });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const USER_A = crypto.randomUUID();
const USER_B = crypto.randomUUID();
const CURRENT_SESSION_ID = crypto.randomUUID();
const OTHER_SESSION_ID = crypto.randomUUID();
const USER_B_SESSION_ID = crypto.randomUUID();

const CURRENT_PASSWORD = 'CorrectHorseBattery1';
let currentPasswordHash: string;

beforeEach(async () => {
  for (const key of Object.keys(db)) delete db[key];
  forceRpcFailure = false;
  currentPasswordHash = await hashPassword(CURRENT_PASSWORD);

  db.profiles = [
    { id: USER_A, email: 'user-a@example.com', full_name: 'User A', created_at: '2026-01-01' },
    { id: USER_B, email: 'user-b@example.com', full_name: 'User B', created_at: '2026-01-01' },
  ];
  db.user_credentials = [
    { user_id: USER_A, password_hash: currentPasswordHash },
    { user_id: USER_B, password_hash: 'B_ORIGINAL_HASH' },
  ];
  db.auth_sessions = [
    { id: CURRENT_SESSION_ID, user_id: USER_A, revoked_at: null, revoke_reason: null },
    { id: OTHER_SESSION_ID, user_id: USER_A, revoked_at: null, revoke_reason: null },
    { id: USER_B_SESSION_ID, user_id: USER_B, revoked_at: null, revoke_reason: null },
  ];
  db.__sessions = [
    { token: 'current-token', userId: USER_A, sessionId: CURRENT_SESSION_ID },
    { token: 'other-token', userId: USER_A, sessionId: OTHER_SESSION_ID },
    { token: 'user-b-token', userId: USER_B, sessionId: USER_B_SESSION_ID },
  ];
});

describe('POST /api/account/change-password — session revocation', () => {
  it('secondary session is valid before the password change', () => {
    const session = db.auth_sessions.find((s) => s.id === OTHER_SESSION_ID);
    expect(session!.revoked_at).toBeNull();
  });

  it('after a successful change: the CALLER\'S current session remains valid', async () => {
    const res = await call('/api/account/change-password', 'current-token', {
      currentPassword: CURRENT_PASSWORD,
      newPassword: 'BrandNewPassword1',
    });
    expect(res.status).toBe(200);
    const current = db.auth_sessions.find((s) => s.id === CURRENT_SESSION_ID);
    expect(current!.revoked_at).toBeNull();
  });

  it('after a successful change: the secondary session is revoked (rejected going forward)', async () => {
    const res = await call('/api/account/change-password', 'current-token', {
      currentPassword: CURRENT_PASSWORD,
      newPassword: 'BrandNewPassword1',
    });
    expect(res.status).toBe(200);
    const other = db.auth_sessions.find((s) => s.id === OTHER_SESSION_ID);
    expect(other!.revoked_at).not.toBeNull();
    expect(other!.revoke_reason).toBe('password_changed');
  });

  it('another user\'s sessions are completely untouched', async () => {
    await call('/api/account/change-password', 'current-token', {
      currentPassword: CURRENT_PASSWORD,
      newPassword: 'BrandNewPassword1',
    });
    const bSession = db.auth_sessions.find((s) => s.id === USER_B_SESSION_ID);
    expect(bSession!.revoked_at).toBeNull();
    const bCred = db.user_credentials.find((c) => c.user_id === USER_B);
    expect(bCred!.password_hash).toBe('B_ORIGINAL_HASH');
  });

  it('wrong current password: changes nothing, no session revoked', async () => {
    const res = await call('/api/account/change-password', 'current-token', {
      currentPassword: 'TotallyWrongPassword1',
      newPassword: 'BrandNewPassword1',
    });
    expect(res.status).toBe(400);
    const cred = db.user_credentials.find((c) => c.user_id === USER_A);
    expect(cred!.password_hash).toBe(currentPasswordHash);
    const other = db.auth_sessions.find((s) => s.id === OTHER_SESSION_ID);
    expect(other!.revoked_at).toBeNull();
  });

  it('a failed DB password update (RPC error) revokes nothing', async () => {
    // Current-password verification (in Node, before the RPC call) still
    // succeeds — this isolates the scenario to the RPC/DB write itself
    // failing, proving that failure alone revokes no sessions.
    forceRpcFailure = true;
    const res = await call('/api/account/change-password', 'current-token', {
      currentPassword: CURRENT_PASSWORD,
      newPassword: 'BrandNewPassword1',
    });
    expect(res.status).toBe(500);
    const cred = db.user_credentials.find((c) => c.user_id === USER_A);
    expect(cred!.password_hash).toBe(currentPasswordHash);
    const other = db.auth_sessions.find((s) => s.id === OTHER_SESSION_ID);
    expect(other!.revoked_at).toBeNull();
  });
});
