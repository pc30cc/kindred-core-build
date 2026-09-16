/**
 * Account avatar ownership — POST/DELETE /api/account/avatar.
 *
 * Proves the migration described in docs/STORAGE_ARCHITECTURE_AUDIT.md
 * §4/§9: the avatar is a global, user-owned asset that no longer depends
 * on the user's "primary workspace" for storage provider routing, is
 * written under the canonical `users/<userId>/avatar/<uuid>.<ext>` key via
 * the owner-scoped storage primitives, and correctly cleans up both new
 * (avatar_storage_key-tracked) and legacy (avatar_url-parsed) prior
 * objects on replace/delete.
 *
 * server/supabase.js is faked with an in-memory table store (same harness
 * as accountSessionsRoutes.test.ts) so requireUser's real
 * findIdentityById/validateSessionToken path is exercised unmocked.
 * server/services/storage/index.js is mocked so no real bytes move —
 * assertions are on which storage primitive was called, with what owner,
 * and with what key.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

type Row = Record<string, unknown>;

interface UpdateBuilder {
  eq: (col: string, val: unknown) => UpdateBuilder;
  select: () => { maybeSingle: () => Promise<{ data: Row | null; error: null }> };
  then: (resolve: (v: { data: null; error: null }) => void) => void;
}

interface MockQueryBuilder {
  select: () => MockQueryBuilder;
  eq: (col: string, val: unknown) => MockQueryBuilder;
  is: (col: string, val: null) => MockQueryBuilder;
  order: (col: string, opts?: { ascending?: boolean }) => MockQueryBuilder;
  limit: () => MockQueryBuilder;
  upsert: (payload: Row) => { select: () => { maybeSingle: () => Promise<{ data: Row; error: null }> } };
  update: (patch: Row) => UpdateBuilder;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  then: (resolve: (v: { data: Row[]; error: null }) => void) => void;
}

const db: Record<string, Row[]> = {};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let orderCol: string | null = null;
      let orderAsc = true;
      const builder: MockQueryBuilder = {
        select: () => builder,
        eq(col, val) { filters.push((r) => r[col] === val); return builder; },
        is(col, val) { filters.push((r) => r[col] === val); return builder; },
        order(col, opts) { orderCol = col; orderAsc = opts?.ascending ?? true; return builder; },
        limit: () => builder,
        upsert(payload) {
          const idx = rows.findIndex((r) => r.id === payload.id);
          if (idx >= 0) Object.assign(rows[idx], payload);
          else rows.push({ ...payload });
          const saved = rows.find((r) => r.id === payload.id)!;
          return { select: () => ({ maybeSingle: async () => ({ data: saved, error: null }) }) };
        },
        update(patch) {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const updateBuilder: UpdateBuilder = {
            eq(col, val) { scoped.push((r) => r[col] === val); return updateBuilder; },
            select: () => ({
              maybeSingle: async () => {
                const matched = rows.filter((r) => scoped.every((f) => f(r)));
                for (const r of matched) Object.assign(r, patch);
                return { data: matched[0] ?? null, error: null };
              },
            }),
            then: (resolve) => {
              const matched = rows.filter((r) => scoped.every((f) => f(r)));
              for (const r of matched) Object.assign(r, patch);
              resolve({ data: null, error: null });
            },
          };
          return updateBuilder;
        },
        maybeSingle: async () => {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (orderCol) {
            const c = orderCol;
            matched = [...matched].sort((a, b) => (a[c] === b[c] ? 0 : ((a[c] as string) > (b[c] as string) ? 1 : -1) * (orderAsc ? 1 : -1)));
          }
          return { data: matched[0] ?? null, error: null };
        },
        then(resolve) {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

const { uploadForOwnerMock, deleteForOwnerMock, uploadFileMock, deleteFileMock } = vi.hoisted(() => ({
  uploadForOwnerMock: vi.fn(async (_config: unknown, req: { fileKey: string }) => ({
    success: true,
    url: `https://cdn.example/${req.fileKey}`,
    fileKey: req.fileKey,
  })),
  deleteForOwnerMock: vi.fn(async (..._args: unknown[]) => ({ success: true })),
  uploadFileMock: vi.fn(async () => ({ success: true, url: 'https://cdn.example/x', fileKey: 'x' })),
  deleteFileMock: vi.fn(async (..._args: unknown[]) => ({ success: true })),
}));

vi.mock('../../../server/services/storage/index.js', () => ({
  uploadForOwner: uploadForOwnerMock,
  deleteForOwner: deleteForOwnerMock,
  uploadFile: uploadFileMock,
  deleteFile: deleteFileMock,
  // The row persists only the key; the link is derived from it at read
  // time for whichever provider is primary, so the route needs the
  // platform-wide resolver and the pure URL builder.
  resolveGlobalStorageConfig: async () => ({ provider: 'bunny_storage', cdnUrl: 'https://cdn.example' }),
  getFileUrlWithConfig: (_config: unknown, key: string) => `https://cdn.example/${key}`,
}));

const { accountRouter } = await import('../../../server/routes/account.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json({ limit: '15mb' }));
app.use('/api/account', accountRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as { port: number }).port;

interface AvatarResponse {
  success?: boolean;
  error?: string;
  url?: string;
  fileKey?: string;
  provider?: string;
}

function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; json: AvatarResponse }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.cookie = `gs_session=${token}`;
  const payload = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port(), path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let json: AvatarResponse = {};
        try { json = JSON.parse(d || '{}'); } catch { json = {}; }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function profileRow(): Row {
  const row = db.profiles.find((p) => p.id === USER_A);
  if (!row) throw new Error('profile row not seeded');
  return row;
}

const USER_A = crypto.randomUUID();
let sessionA: string;

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  uploadForOwnerMock.mockClear();
  deleteForOwnerMock.mockClear();
  uploadFileMock.mockClear();
  deleteFileMock.mockClear();

  sessionA = crypto.randomUUID();
  const future = new Date(Date.now() + 3600_000).toISOString();

  // Deliberately NO workspace_members row for USER_A — proves avatar
  // upload/delete no longer depends on any workspace membership.
  db.profiles = [
    { id: USER_A, email: 'a@example.com', full_name: 'User A', phone: null, avatar_url: null, avatar_storage_key: null, created_at: '2026-01-01' },
  ];
  db.user_credentials = [];
  db.workspace_members = [];
  db.auth_sessions = [
    { id: crypto.randomUUID(), token_hash: hashToken('token-a'), user_id: USER_A, email: 'a@example.com', created_at: '2026-01-01T00:00:00Z', expires_at: future, revoked_at: null, revoke_reason: null, ip_address: '1.1.1.1', user_agent: 'Mozilla/5.0' },
  ];
  void sessionA;
});

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

describe('POST /api/account/avatar', () => {
  it('uploads via the user-owned storage primitive, with a canonical users/<userId>/avatar/... key, no workspace routing', async () => {
    const res = await call('POST', '/api/account/avatar', 'token-a', { data: PNG_B64, contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(uploadForOwnerMock).toHaveBeenCalledTimes(1);
    const uploadReq = uploadForOwnerMock.mock.calls[0][1] as { owner: unknown; fileKey: string };
    expect(uploadReq.owner).toEqual({ kind: 'user', userId: USER_A });
    expect(uploadReq.fileKey).toMatch(new RegExp(`^users/${USER_A}/avatar/[0-9a-f-]{36}\\.png$`));
    // No workspace-resolved upload path was used at all.
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it('persists ONLY the storage key, and clears any URL a previous provider left', async () => {
    profileRow().avatar_url = 'https://old-vendor.example/users/x/avatar/stale.png';

    const res = await call('POST', '/api/account/avatar', 'token-a', { data: PNG_B64, contentType: 'image/png' });
    expect(res.status).toBe(200);

    const profile = profileRow();
    expect(profile.avatar_storage_key).toBe(res.json.fileKey);
    // A URL names one vendor, so no row keeps one — it is derived per read.
    expect(profile.avatar_url).toBeNull();
  });

  it('returns a link DERIVED from the key for the provider that is primary now', async () => {
    const res = await call('POST', '/api/account/avatar', 'token-a', { data: PNG_B64, contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.json.url).toBe(`https://cdn.example/${res.json.fileKey}`);
  });

  it('succeeds even when the user belongs to zero workspaces (routing no longer depends on primary workspace membership)', async () => {
    expect(db.workspace_members.length).toBe(0);
    const res = await call('POST', '/api/account/avatar', 'token-a', { data: PNG_B64, contentType: 'image/png' });
    expect(res.status).toBe(200);
  });

  it('replacing an avatar deletes the previous NEW object via deleteForOwner (user-owned), not deleteFile', async () => {
    const first = await call('POST', '/api/account/avatar', 'token-a', { data: PNG_B64, contentType: 'image/png' });
    expect(first.status).toBe(200);
    const firstKey = first.json.fileKey;

    const second = await call('POST', '/api/account/avatar', 'token-a', { data: PNG_B64, contentType: 'image/png' });
    expect(second.status).toBe(200);

    expect(deleteForOwnerMock).toHaveBeenCalledTimes(1);
    const [, owner, key] = deleteForOwnerMock.mock.calls[0];
    expect(owner).toEqual({ kind: 'user', userId: USER_A });
    expect(key).toBe(firstKey);
    expect(deleteFileMock).not.toHaveBeenCalled();
  });

  it('replacing a LEGACY avatar (no avatar_storage_key, old avatars/<userId>/... URL) falls back to deleteFile with allowLegacyKey, scoped by primary workspace', async () => {
    const WS = crypto.randomUUID();
    db.workspace_members = [{ user_id: USER_A, workspace_id: WS, created_at: '2025-01-01' }];
    const legacyKey = `avatars/${USER_A}/old-123.png`;
    profileRow().avatar_url = `https://cdn.example/${legacyKey}`;
    profileRow().avatar_storage_key = null;

    const res = await call('POST', '/api/account/avatar', 'token-a', { data: PNG_B64, contentType: 'image/png' });
    expect(res.status).toBe(200);

    expect(deleteFileMock).toHaveBeenCalledTimes(1);
    const [, workspaceId, key, opts] = deleteFileMock.mock.calls[0];
    expect(workspaceId).toBe(WS);
    expect(key).toBe(legacyKey);
    expect(opts).toEqual({ allowLegacyKey: true });
    expect(deleteForOwnerMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/account/avatar', () => {
  it('clears both avatar_url and avatar_storage_key and deletes the NEW object via deleteForOwner', async () => {
    profileRow().avatar_url = 'https://cdn.example/users/x/avatar/y.png';
    profileRow().avatar_storage_key = `users/${USER_A}/avatar/y.png`;

    const res = await call('DELETE', '/api/account/avatar', 'token-a');
    expect(res.status).toBe(200);

    expect(deleteForOwnerMock).toHaveBeenCalledTimes(1);
    const [, owner, key] = deleteForOwnerMock.mock.calls[0];
    expect(owner).toEqual({ kind: 'user', userId: USER_A });
    expect(key).toBe(`users/${USER_A}/avatar/y.png`);

    const profile = profileRow();
    expect(profile.avatar_url).toBeNull();
    expect(profile.avatar_storage_key).toBeNull();
  });

  it('deleting a LEGACY avatar falls back to deleteFile with allowLegacyKey, scoped by primary workspace', async () => {
    const WS = crypto.randomUUID();
    db.workspace_members = [{ user_id: USER_A, workspace_id: WS, created_at: '2025-01-01' }];
    const legacyKey = `avatars/${USER_A}/old-456.png`;
    profileRow().avatar_url = `https://cdn.example/${legacyKey}`;
    profileRow().avatar_storage_key = null;

    const res = await call('DELETE', '/api/account/avatar', 'token-a');
    expect(res.status).toBe(200);

    expect(deleteFileMock).toHaveBeenCalledTimes(1);
    const [, workspaceId, key, opts] = deleteFileMock.mock.calls[0];
    expect(workspaceId).toBe(WS);
    expect(key).toBe(legacyKey);
    expect(opts).toEqual({ allowLegacyKey: true });
  });

  it('a legacy avatar with no primary workspace is left as a best-effort no-op (no crash), and the DB is still cleared', async () => {
    const legacyKey = `avatars/${USER_A}/orphan.png`;
    profileRow().avatar_url = `https://cdn.example/${legacyKey}`;
    profileRow().avatar_storage_key = null;
    expect(db.workspace_members.length).toBe(0);

    const res = await call('DELETE', '/api/account/avatar', 'token-a');
    expect(res.status).toBe(200);
    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(deleteForOwnerMock).not.toHaveBeenCalled();

    const profile = profileRow();
    expect(profile.avatar_url).toBeNull();
  });
});
