/**
 * GOTRUE CUTOVER — workspace-scoped usage/provider-selection routes
 * (`/api/workspaces/:id/usage/*`, `/api/workspaces/:id/provider-selection`)
 * replace browser-direct reads of `ai_usage_logs`, `storage_usage_logs` and
 * `provider_configs`. Workspace isolation must come from the server-side
 * membership check on the first-party principal, never from a client-chosen
 * workspace_id.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

function fakeClient() {
  return {
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r: Row) => r[col] === val); return builder; },
        is(col: string, val: null) { filters.push((r: Row) => r[col] === val); return builder; },
        gte: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
        then(resolve: any) {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
    rpc: async (fn: string, params: Record<string, any>) => {
      if (fn === 'is_workspace_member') {
        return {
          data: (db.workspace_members || []).some(
            (m) => m.workspace_id === params._workspace_id && m.user_id === params._user_id,
          ),
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => false }));
vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_c: unknown, token: string | undefined) => {
    if (!token) return null;
    const s = db.__sessions?.find((x) => x.token === token);
    return s ? { sessionId: 's1', userId: s.userId, email: 'x@example.com' } : null;
  },
  verifyOriginForMutation: () => true,
}));

const { workspacesRouter } = await import('../../../server/routes/workspaces.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/workspaces', workspacesRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(p: string, token: string | null): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `gs_session=${token}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port(), path: p, method: 'GET', headers }, (res) => {
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

const WS_A = crypto.randomUUID();
const WS_B = crypto.randomUUID();
const USER_A = crypto.randomUUID();

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.__sessions = [{ token: 'a-token', userId: USER_A }];
  db.workspace_members = [{ workspace_id: WS_A, user_id: USER_A, role: 'owner' }];
  db.ai_usage_logs = [
    { id: '1', workspace_id: WS_A, provider_name: 'openai', total_tokens: 10, success: true },
    { id: '2', workspace_id: WS_B, provider_name: 'openai', total_tokens: 99, success: true },
  ];
  db.storage_usage_logs = [{ id: 's1', workspace_id: WS_B, provider_name: 'bunny' }];
  db.provider_configs = [
    { workspace_id: WS_A, provider_type: 'realtime', provider_name: 'centrifugo', is_active: true, config: { secret: 'nope' } },
    { workspace_id: WS_B, provider_type: 'realtime', provider_name: 'supabase', is_active: true, config: { secret: 'nope' } },
  ];
});

describe('workspace usage/provider routes — isolation', () => {
  it('a member reads only their own workspace usage', async () => {
    const res = await call(`/api/workspaces/${WS_A}/usage/ai`, 'a-token');
    expect(res.status).toBe(200);
    expect(res.json.logs.map((l: any) => l.id)).toEqual(['1']);
  });

  it('a member of workspace A cannot read workspace B usage', async () => {
    expect((await call(`/api/workspaces/${WS_B}/usage/ai`, 'a-token')).status).toBe(403);
    expect((await call(`/api/workspaces/${WS_B}/usage/storage`, 'a-token')).status).toBe(403);
    expect((await call(`/api/workspaces/${WS_B}/provider-selection`, 'a-token')).status).toBe(403);
  });

  it('an unauthenticated caller is rejected', async () => {
    expect((await call(`/api/workspaces/${WS_A}/usage/ai`, null)).status).toBe(401);
    expect((await call(`/api/workspaces/${WS_A}/provider-selection`, null)).status).toBe(401);
  });

  it('provider selection never returns the secret config column', async () => {
    const res = await call(`/api/workspaces/${WS_A}/provider-selection`, 'a-token');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.json)).not.toContain('secret');
  });
});
