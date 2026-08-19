/**
 * Admin security dashboard routes (security_events / ip_blocklist /
 * admin_security_stats) — proves the whole surface requires a real
 * gs_session-authenticated platform admin, not a workspace owner/admin and
 * not a bare Supabase JWT-shaped Bearer token without a session cookie.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';

const ADMIN_TOKEN = 'admin-token';
const OWNER_TOKEN = 'owner-token'; // workspace owner, NOT platform admin
const USER_TOKEN = 'user-token';

interface EventRow {
  id: string;
  event_type: string;
  severity: string;
  resolved: boolean;
  resolved_at: string | null;
  created_at: string;
}
interface IpRow {
  id: string;
  ip_address: string;
  reason: string;
  blocked_by: string | null;
  created_at: string;
}

const db: { events: EventRow[]; ips: IpRow[] } = { events: [], ips: [] };

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: async (fn: string, args: any) => {
      if (fn === 'has_role') return { data: args._user_id === 'admin-id', error: null };
      if (fn === 'admin_security_stats') {
        return {
          data: {
            total_events_24h: db.events.length,
            unresolved_events: db.events.filter((e) => !e.resolved).length,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    from: (table: 'security_events' | 'ip_blocklist') => {
      const rows = table === 'security_events' ? db.events : db.ips;
      return {
        select: () => ({
          order: () => ({
            limit: async (n: number) => ({ data: rows.slice(0, n), error: null }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, id: string) => {
            const row = rows.find((r: any) => r.id === id);
            if (row) Object.assign(row, patch);
            return Promise.resolve({ error: null });
          },
        }),
        insert: (row: Record<string, unknown>) => {
          db.ips.push({ id: `ip-${db.ips.length + 1}`, created_at: new Date().toISOString(), ...row } as IpRow);
          return Promise.resolve({ error: null });
        },
        delete: () => ({
          eq: (_col: string, id: string) => {
            const idx = rows.findIndex((r: any) => r.id === id);
            if (idx >= 0) rows.splice(idx, 1);
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  }),
}));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (token === ADMIN_TOKEN) return { sessionId: 's1', userId: 'admin-id', email: 'admin@example.com' };
    if (token === OWNER_TOKEN) return { sessionId: 's2', userId: 'owner-id', email: 'owner@example.com' };
    if (token === USER_TOKEN) return { sessionId: 's3', userId: 'user-id', email: 'user@example.com' };
    return null;
  },
  verifyOriginForMutation: () => true,
}));

const { adminRouter } = await import('../../../server/routes/admin.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = {
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'ANON',
    supabaseServiceRoleKey: 'SERVICE',
    corsOrigins: [],
  };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/admin', adminRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as { port: number }).port;

function call(
  method: string,
  path: string,
  opts: { cookieToken?: string; bearerOnly?: string; body?: unknown } = {},
) {
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  const headers: Record<string, string> = {};
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  if (opts.cookieToken) headers.cookie = `gs_session=${opts.cookieToken}`;
  if (opts.bearerOnly) headers.authorization = `Bearer ${opts.bearerOnly}`;
  return new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port(), path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(d || '{}'); } catch { parsed = { raw: d }; }
        resolve({ status: res.statusCode ?? 0, json: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeEach(() => {
  db.events.length = 0;
  db.ips.length = 0;
  db.events.push(
    { id: 'e1', event_type: 'login_failed', severity: 'warn', resolved: false, resolved_at: null, created_at: new Date().toISOString() },
  );
});

describe('admin security dashboard — authorization', () => {
  it('rejects anonymous (no cookie) reads', async () => {
    expect((await call('GET', '/api/admin/security/stats')).status).toBe(401);
    expect((await call('GET', '/api/admin/security/events')).status).toBe(401);
    expect((await call('GET', '/api/admin/security/blocked-ips')).status).toBe(401);
  });

  it('rejects a bare Bearer token with no gs_session cookie — old Supabase JWT cannot authenticate', async () => {
    const res = await call('GET', '/api/admin/security/stats', { bearerOnly: ADMIN_TOKEN });
    expect(res.status).toBe(401);
  });

  it('rejects an ordinary signed-in user (not a workspace anything, not platform admin)', async () => {
    expect((await call('GET', '/api/admin/security/stats', { cookieToken: USER_TOKEN })).status).toBe(403);
    expect((await call('GET', '/api/admin/security/events', { cookieToken: USER_TOKEN })).status).toBe(403);
  });

  it('rejects a workspace owner who is not a platform admin', async () => {
    expect((await call('GET', '/api/admin/security/stats', { cookieToken: OWNER_TOKEN })).status).toBe(403);
    expect(
      (await call('POST', '/api/admin/security/blocked-ips', {
        cookieToken: OWNER_TOKEN,
        body: { ip: '1.2.3.4', reason: 'test' },
      })).status,
    ).toBe(403);
  });

  it('allows a platform admin to read stats, events and blocked IPs', async () => {
    const stats = await call('GET', '/api/admin/security/stats', { cookieToken: ADMIN_TOKEN });
    expect(stats.status).toBe(200);
    expect(stats.json.total_events_24h).toBe(1);

    const events = await call('GET', '/api/admin/security/events', { cookieToken: ADMIN_TOKEN });
    expect(events.status).toBe(200);
    expect((events.json.events as EventRow[])).toHaveLength(1);

    const ips = await call('GET', '/api/admin/security/blocked-ips', { cookieToken: ADMIN_TOKEN });
    expect(ips.status).toBe(200);
  });

  it('allows a platform admin to block/unblock an IP and resolve an event', async () => {
    const block = await call('POST', '/api/admin/security/blocked-ips', {
      cookieToken: ADMIN_TOKEN,
      body: { ip: '9.9.9.9', reason: 'abuse' },
    });
    expect(block.status).toBe(200);
    expect(db.ips).toHaveLength(1);

    const unblock = await call('DELETE', `/api/admin/security/blocked-ips/${db.ips[0].id}`, {
      cookieToken: ADMIN_TOKEN,
    });
    expect(unblock.status).toBe(200);
    expect(db.ips).toHaveLength(0);

    const resolve = await call('POST', '/api/admin/security/events/e1/resolve', { cookieToken: ADMIN_TOKEN });
    expect(resolve.status).toBe(200);
    expect(db.events[0].resolved).toBe(true);
  });

  it('rejects a non-admin block/resolve write even with a well-formed body', async () => {
    const block = await call('POST', '/api/admin/security/blocked-ips', {
      cookieToken: USER_TOKEN,
      body: { ip: '9.9.9.9', reason: 'abuse' },
    });
    expect(block.status).toBe(403);
    expect(db.ips).toHaveLength(0);
  });
});
