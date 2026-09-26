/**
 * H1 + C8 — route-level tests against the REAL realtimeRouter.
 *
 * H1: POST /api/realtime/subscribe used to mint a subscription for ANY
 *     conversation in the widget token's workspace. It must now require that
 *     the visitor identified by the signed HttpOnly `dvsid` cookie owns the
 *     conversation — client-supplied visitor ids are ignored.
 * C8: with `transport: 'supabase'` the endpoint hands out the unguessable
 *     visitor topic (never an operator topic, never the canonical name), and
 *     the operator topic endpoints refuse unauthenticated callers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-realtime-subscribe';
process.env.REALTIME_CHANNEL_SECRET = 'realtime-channel-secret-for-tests-0123456789';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '99999999-9999-4999-8999-999999999999';
const CONV = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const STRANGER = '44444444-4444-4444-8444-444444444444';

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (col: string, val: unknown) => { filters.push([col, val]); return b; };
      b.is = () => b;
      b.in = () => b;
      b.order = () => b;
      b.limit = () => b;
      b.maybeSingle = async () => {
        const rows = (tables[table] || []).filter((r) => filters.every(([c, v]) => r[c] === v));
        return { data: rows[0] ?? null, error: null };
      };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock('../../../server/supabase.js', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const client = (createClient as unknown as () => unknown)();
  return { getServiceClient: () => client };
});

const { realtimeRouter } = await import('../../../server/routes/realtime.js');
const { createSessionToken } = await import('../../../server/services/widget/security.js');
const { setVisitorCookie } = await import('../../../server/services/widget/visitorIdentity.js');
const { deriveSupabaseTopic } = await import('../../../server/services/realtime/channelTopic.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = {
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'ANON_KEY',
    supabaseServiceRoleKey: 'SERVICE_KEY',
    corsOrigins: [],
  };
  next();
});
app.use(express.json());
app.use(cookieParser());
app.use('/api/realtime', realtimeRouter);

function visitorCookie(visitorId: string, workspaceId = WS): string {
  let header = '';
  const fakeRes = { append: (_k: string, v: string) => { header = v; } };
  const now = Math.floor(Date.now() / 1000);
  setVisitorCookie(fakeRes as never, { v: visitorId, w: workspaceId, iat: now, exp: now + 3600 });
  return header.split(';')[0];
}

interface Reply { status: number; body: Record<string, unknown> | null }

function request(path: string, headers: Record<string, string>, body: unknown): Promise<Reply> {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      const payload = JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close();
            let parsed: Record<string, unknown> | null = null;
            try { parsed = JSON.parse(data); } catch { /* noop */ }
            resolve({ status: res.statusCode || 0, body: parsed });
          });
        },
      );
      req.on('error', (err) => { server.close(); reject(err); });
      req.write(payload);
      req.end();
    });
  });
}

const widgetToken = () => createSessionToken(WS, '');

beforeEach(() => {
  tables.conversations = [{
    id: CONV,
    workspace_id: WS,
    status: 'open',
    contact_id: null,
    visitor_session_id: null,
    metadata: { visitor_id: OWNER },
  }];
  tables.widget_platform_settings = [];
});

describe('POST /api/realtime/subscribe — visitor ownership (H1)', () => {
  it('rejects a visitor with no dvsid cookie even with a valid widget token', async () => {
    const res = await request('/api/realtime/subscribe', { 'X-Widget-Token': widgetToken() }, { workspace_id: WS, conversation_id: CONV });
    expect(res.status).toBe(403);
    expect(res.body?.token).toBeUndefined();
  });

  it('rejects a different visitor of the same workspace', async () => {
    const res = await request(
      '/api/realtime/subscribe',
      { 'X-Widget-Token': widgetToken(), Cookie: visitorCookie(STRANGER) },
      { workspace_id: WS, conversation_id: CONV },
    );
    expect(res.status).toBe(403);
  });

  it('ignores a client-supplied visitor_id claiming ownership', async () => {
    const res = await request(
      '/api/realtime/subscribe',
      { 'X-Widget-Token': widgetToken(), Cookie: visitorCookie(STRANGER) },
      { workspace_id: WS, conversation_id: CONV, visitor_id: OWNER, transport: 'supabase' },
    );
    expect(res.status).toBe(403);
    expect(res.body?.topic).toBeUndefined();
  });

  it('rejects a conversation from another workspace', async () => {
    tables.conversations[0].workspace_id = OTHER_WS;
    const res = await request(
      '/api/realtime/subscribe',
      { 'X-Widget-Token': widgetToken(), Cookie: visitorCookie(OWNER) },
      { workspace_id: WS, conversation_id: CONV, transport: 'supabase' },
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /api/realtime/subscribe — Supabase topic hand-out (C8)', () => {
  it('gives the owning visitor the VISITOR topic only', async () => {
    const res = await request(
      '/api/realtime/subscribe',
      { 'X-Widget-Token': widgetToken(), Cookie: visitorCookie(OWNER) },
      { workspace_id: WS, conversation_id: CONV, transport: 'supabase' },
    );
    const channel = `ws:${WS}:conv:${CONV}`;
    expect(res.status).toBe(200);
    expect(res.body?.vendor).toBe('supabase');
    expect(res.body?.channel).toBe(channel);
    expect(res.body?.topic).toBe(deriveSupabaseTopic(channel, 'visitor'));
    expect(res.body?.topic).not.toBe(deriveSupabaseTopic(channel, 'operator'));
    expect(res.body?.topic).not.toBe(channel);
  });

  it('fails closed (503) when no channel secret is configured', async () => {
    const savedSecret = process.env.REALTIME_CHANNEL_SECRET;
    const savedService = process.env.SUPABASE_SERVICE_ROLE_KEY;
    // Cookie must be minted while the visitor-cookie secret still exists.
    const cookie = visitorCookie(OWNER);
    process.env.REALTIME_CHANNEL_SECRET = 'too-short';
    try {
      const res = await request(
        '/api/realtime/subscribe',
        { 'X-Widget-Token': widgetToken(), Cookie: cookie },
        { workspace_id: WS, conversation_id: CONV, transport: 'supabase' },
      );
      expect(res.status).toBe(503);
      expect(res.body?.topic).toBeUndefined();
    } finally {
      process.env.REALTIME_CHANNEL_SECRET = savedSecret;
      process.env.SUPABASE_SERVICE_ROLE_KEY = savedService;
    }
  });
});

describe('operator topic endpoints refuse unauthenticated callers (C8)', () => {
  for (const [path, extra] of [
    ['/api/realtime/operator-inbox-subscribe', {}],
    ['/api/realtime/operator-visitors-subscribe', {}],
    ['/api/realtime/operator-presence-subscribe', {}],
    ['/api/realtime/operator-subscribe', { conversation_id: CONV }],
  ] as const) {
    it(`${path} with transport=supabase and no session → 401, no topic`, async () => {
      const res = await request(path, {}, { workspace_id: WS, transport: 'supabase', ...extra });
      expect(res.status).toBe(401);
      expect(res.body?.topic).toBeUndefined();
    });
  }
});
