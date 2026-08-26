/**
 * POST /api/account/resend-verification checked
 * `user.user_metadata.app_email_verified === true` to decide "already
 * verified, don't send another token" — but the accountRouter's own
 * requireUser middleware never populates that property (it builds
 * `req.authUser` from `identity.emailVerifiedAt`, exposed as
 * `email_confirmed_at`). The check was therefore always false: an
 * already-verified caller could keep hitting this endpoint and mint a
 * fresh verification token/email indefinitely. Fixed to read the
 * canonical `email_confirmed_at` field the middleware actually sets.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

const issueVerificationEmail = vi.fn(async () => ({ success: true }));
vi.mock('../../../server/services/auth-email.js', () => ({ issueVerificationEmail }));

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

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
        is(col: string, val: null) { filters.push((r: Row) => r[col] === val); return builder; },
        order(col: string, opts?: { ascending?: boolean }) { orderCol = col; orderAsc = opts?.ascending ?? true; return builder; },
        limit: () => builder,
        maybeSingle: async () => {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (orderCol) {
            const c = orderCol;
            matched = [...matched].sort((a, b) => (a[c] === b[c] ? 0 : (a[c] > b[c] ? 1 : -1) * (orderAsc ? 1 : -1)));
          }
          return { data: matched[0] ?? null, error: null };
        },
      };
      return builder;
    },
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

function post(path: string, token: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: port(), path, method: 'POST', headers: { cookie: `gs_session=${token}`, 'content-type': 'application/json', 'content-length': 2 } },
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
    req.write('{}');
    req.end();
  });
}

const USER_ID = crypto.randomUUID();
const RAW_TOKEN = 'resend-verification-token';

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  issueVerificationEmail.mockClear();

  db.profiles = [{ id: USER_ID, email: 'resend@example.com', full_name: 'Resend User', phone: null, created_at: '2026-01-01' }];
  db.auth_sessions = [
    {
      id: crypto.randomUUID(),
      token_hash: hashToken(RAW_TOKEN),
      user_id: USER_ID,
      email: 'resend@example.com',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      revoked_at: null,
    },
  ];
  db.auth_verify_tokens = [];
});

describe('POST /api/account/resend-verification — canonical verification check', () => {
  it('an ALREADY-VERIFIED user gets already_verified:true and NO new token/email is issued', async () => {
    db.user_credentials = [{ user_id: USER_ID, email_verified_at: '2026-01-02T00:00:00Z', status: 'active' }];

    const res = await post('/api/account/resend-verification', RAW_TOKEN);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: true, already_verified: true });
    expect(issueVerificationEmail).not.toHaveBeenCalled();
  });

  it('an UNVERIFIED user proceeds and a verification email IS issued', async () => {
    db.user_credentials = [{ user_id: USER_ID, email_verified_at: null, status: 'active' }];

    const res = await post('/api/account/resend-verification', RAW_TOKEN);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: true, sent: true });
    expect(issueVerificationEmail).toHaveBeenCalledTimes(1);
    expect(issueVerificationEmail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: USER_ID, email: 'resend@example.com' }));
  });

  it('a user with NO user_credentials row (migrated, no verification state yet) is treated as unverified, not already-verified', async () => {
    db.user_credentials = [];

    const res = await post('/api/account/resend-verification', RAW_TOKEN);
    expect(res.status).toBe(200);
    expect(res.json.already_verified).toBeUndefined();
    expect(issueVerificationEmail).toHaveBeenCalledTimes(1);
  });
});
