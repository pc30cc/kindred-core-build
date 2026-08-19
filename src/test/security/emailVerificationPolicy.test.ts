/**
 * GoTrue-off closure — new-signup email verification policy.
 *
 * Decision: login itself stays non-blocking (see server/routes/auth.ts's
 * policy comment), but an unverified account cannot become a workspace
 * owner (POST /api/workspaces) or pull other people into a workspace it
 * controls (POST /api/workspace-members/invitations) — enforced
 * server-side via isEmailVerified() (server/services/auth/identity.ts),
 * not just a UI banner.
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
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r: Row) => r[col] === val); return builder; },
        insert(payload: Row) {
          const inserted = { id: payload.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), ...payload };
          rows.push(inserted);
          return { select: () => ({ single: async () => ({ data: inserted, error: null }) }) };
        },
        maybeSingle: async () => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
      };
      return builder;
    },
    rpc: async (name: string, args: any) => {
      if (name === 'is_workspace_member') {
        const member = (db.workspace_members || []).find(
          (m) => m.workspace_id === args._workspace_id && m.user_id === args._user_id,
        );
        return { data: !!member, error: null };
      }
      if (name === 'create_workspace_atomic') {
        const id = crypto.randomUUID();
        (db.workspaces ||= []).push({ id, owner_id: args._user_id, name: args._name });
        return { data: id, error: null };
      }
      if (name === 'provision_account_on_signup') {
        (db.workspaces ||= []).push({ id: crypto.randomUUID(), owner_id: args._user_id, name: 'Provisioned WS' });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => false }));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    const user = db.__sessions?.find((s) => s.token === token);
    return user ? { sessionId: 'test-session', userId: user.userId, email: 'test@example.com' } : null;
  },
  verifyOriginForMutation: () => true,
}));

const { workspacesRouter } = await import('../../../server/routes/workspaces.js');
const { workspaceMembersRouter } = await import('../../../server/routes/workspaceMembers.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/workspaces', workspacesRouter);
app.use('/api/workspace-members', workspaceMembersRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers: Record<string, string> = { cookie: `gs_session=${token}` };
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
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
    if (payload) req.write(payload);
    req.end();
  });
}

const VERIFIED_USER = crypto.randomUUID();
const UNVERIFIED_USER = crypto.randomUUID();
const LEGACY_BACKFILLED_USER = crypto.randomUUID();
const ACCOUNT = crypto.randomUUID();
const WS = crypto.randomUUID();

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  db.__sessions = [
    { token: 'verified-token', userId: VERIFIED_USER },
    { token: 'unverified-token', userId: UNVERIFIED_USER },
    { token: 'legacy-token', userId: LEGACY_BACKFILLED_USER },
  ];
  db.profiles = [
    { id: VERIFIED_USER, email: 'verified@example.com', full_name: 'Verified', phone: null, created_at: '2026-01-01' },
    { id: UNVERIFIED_USER, email: 'unverified@example.com', full_name: 'Unverified', phone: null, created_at: '2026-01-01' },
    { id: LEGACY_BACKFILLED_USER, email: 'legacy@example.com', full_name: 'Legacy', phone: null, created_at: '2020-01-01' },
  ];
  db.user_credentials = [
    { user_id: VERIFIED_USER, email_verified_at: '2026-01-01T00:00:00Z' },
    // UNVERIFIED_USER: deliberately no row — matches a brand-new signup
    // that hasn't clicked its verification link yet.
    // LEGACY_BACKFILLED_USER: row exists with a value populated by
    // 029_backfill_legacy_email_verification.sql, proving the backfill
    // (not a special-case) is what makes a legacy user pass this gate.
    { user_id: LEGACY_BACKFILLED_USER, email_verified_at: '2019-06-01T00:00:00Z' },
  ];
  db.workspaces = [{ id: WS, owner_id: VERIFIED_USER, name: 'Existing WS' }];
  db.workspace_members = [
    { workspace_id: WS, user_id: VERIFIED_USER, role: 'owner' },
    { workspace_id: WS, user_id: UNVERIFIED_USER, role: 'admin' },
  ];
});

describe('email verification policy — workspace creation', () => {
  it('an unverified new signup cannot create (and become owner of) a workspace', async () => {
    const res = await call('POST', '/api/workspaces', 'unverified-token', { accountId: ACCOUNT, name: 'Squatter WS' });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('email_verification_required');
  });

  it('a verified user can create a workspace', async () => {
    const res = await call('POST', '/api/workspaces', 'verified-token', { accountId: ACCOUNT, name: 'New WS' });
    expect(res.status).toBe(200);
    expect(res.json.workspaceId).toBeTruthy();
  });

  it('a legacy user whose verification was backfilled from auth.users can create a workspace', async () => {
    const res = await call('POST', '/api/workspaces', 'legacy-token', { accountId: ACCOUNT, name: 'Legacy WS' });
    expect(res.status).toBe(200);
  });
});

describe('email verification policy — provision-account (first-run auto-provision)', () => {
  it('unverified new user: POST /api/workspaces AND POST /api/workspaces/provision-account both 403, no account/workspace created', async () => {
    const before = (db.workspaces ?? []).length;

    const createRes = await call('POST', '/api/workspaces', 'unverified-token', { accountId: ACCOUNT, name: 'Squatter WS' });
    expect(createRes.status).toBe(403);
    expect(createRes.json.error).toBe('email_verification_required');

    const provisionRes = await call('POST', '/api/workspaces/provision-account', 'unverified-token');
    expect(provisionRes.status).toBe(403);
    expect(provisionRes.json.error).toBe('email_verification_required');

    expect((db.workspaces ?? []).length).toBe(before);
  });

  it('a verified user can provision their first-run account/workspace', async () => {
    const res = await call('POST', '/api/workspaces/provision-account', 'verified-token');
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });
});

describe('email verification policy — invitations', () => {
  it('an unverified admin cannot invite someone into a workspace they manage', async () => {
    const res = await call('POST', '/api/workspace-members/invitations', 'unverified-token', {
      workspaceId: WS,
      role: 'agent',
      invitedEmail: 'victim@example.com',
    });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('email_verification_required');
    expect(db.workspace_invitations ?? []).toHaveLength(0);
  });

  it('a verified owner can invite normally', async () => {
    const res = await call('POST', '/api/workspace-members/invitations', 'verified-token', {
      workspaceId: WS,
      role: 'agent',
      invitedEmail: 'teammate@example.com',
    });
    expect(res.status).toBe(201);
  });
});
