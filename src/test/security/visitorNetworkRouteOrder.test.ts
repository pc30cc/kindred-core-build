/**
 * Route-order regression: GET /:id was registered BEFORE GET /network in
 * server/routes/visitors.ts. Express matches routes in registration order,
 * and /:id matches a bare `/network` request too (with id === 'network'),
 * so the /:id handler's own defensive guard (`id === 'network' → 404`) was
 * the ONLY thing a caller ever actually saw — the real GET /network handler
 * below it was permanently unreachable.
 *
 * This test exercises the REAL router (not a re-implementation of the
 * ordering) mounted on a real HTTP server, so it fails exactly the way the
 * bug manifested: a 404 { error: 'Not found' } — the /:id guard's literal
 * response — instead of ever reaching the network handler.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user-1';
const CONTACT_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const CONV_ID = '44444444-4444-4444-8444-444444444444';
const CALL_SESSION_ID = '55555555-5555-4555-8555-555555555555';
const CALLBACK_ID = '66666666-6666-4666-8666-666666666666';

vi.mock('../../../server/services/auth/sessions.js', () => ({
  validateSessionToken: async () => ({ sessionId: 'test-session', userId: USER_ID, email: 'test@example.com' }),
  SESSION_COOKIE_NAME: 'gs_session',
  verifyOriginForMutation: () => true,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
    rpc: async () => ({ data: true }),
    from(table: string) {
      const b: any = {
        select: () => b,
        eq(_c: string, v: string) { b._lastEq = v; return b; },
        maybeSingle: async () => {
          if (table === 'workspace_members') return { data: { role: 'owner' } };
          if (table === 'conversations' && b._lastEq === CONV_ID) return { data: { visitor_session_id: 'sess-from-conv' } };
          if (table === 'call_sessions' && b._lastEq === CALL_SESSION_ID) return { data: { visitor_session_id: 'sess-from-call' } };
          if (table === 'callback_requests' && b._lastEq === CALLBACK_ID) return { data: { visitor_session_id: 'sess-from-cb' } };
          return { data: null };
        },
      };
      return b;
    },
  }),
}));

const resolveContactNetworkProfile = vi.fn(async (..._a: unknown[]) => ({ profile: 'by-contact' }));
const resolveNetworkProfile = vi.fn(async (_cfg: unknown, _ws: string, sessionId: string) => ({ profile: 'by-session', sessionId }));
const resolveConversationNetworkProfiles = vi.fn(async (..._a: unknown[]) => new Map());
const resolveNetworkProfiles = vi.fn(async (..._a: unknown[]) => new Map());
const resolveContactsNetworkProfiles = vi.fn(async (..._a: unknown[]) => new Map());
const resolveIpVisibilityPolicy = vi.fn(async (..._a: unknown[]) => ({ entitled: false, canViewRaw: false }));

vi.mock('../../../server/services/visitors/networkProfile.js', () => ({
  resolveIpVisibilityPolicy: (...a: unknown[]) => resolveIpVisibilityPolicy(...a),
  resolveNetworkProfile: (...a: unknown[]) => resolveNetworkProfile(...a as [unknown, string, string]),
  resolveConversationNetworkProfiles: (...a: unknown[]) => resolveConversationNetworkProfiles(...a),
  resolveNetworkProfiles: (...a: unknown[]) => resolveNetworkProfiles(...a),
  resolveContactNetworkProfile: (...a: unknown[]) => resolveContactNetworkProfile(...a),
  resolveContactsNetworkProfiles: (...a: unknown[]) => resolveContactsNetworkProfiles(...a),
}));

// Not exercised by these routes, but visitors.ts imports them at module load.
vi.mock('../../../server/services/visitors/intelligence.js', () => ({
  listVisitorIntelligence: vi.fn(),
  getVisitorIntelligence: vi.fn(),
}));
vi.mock('../../../server/services/maptiles/index.js', () => ({ resolveMapTilesConfig: vi.fn() }));
vi.mock('../../../server/services/realtime/publish.js', () => ({ publishVisitorEvent: vi.fn() }));
vi.mock('../../../server/services/geo/index.js', () => ({
  resolveVisitorGeo: vi.fn(), getActiveGeoProvider: vi.fn(), enrichVisitorSessionGeo: vi.fn(),
}));
vi.mock('../../../server/services/billing/visitorLimit.js', () => ({ enforceMaxVisitorsLimitIfNewThisMonth: vi.fn() }));
vi.mock('../../../server/services/widget/public.js', () => ({ isWorkspaceOriginAllowed: vi.fn() }));

let server: http.Server;
let port: number;

beforeAll(async () => {
  const { visitorsAdminRouter } = await import('../../../server/routes/visitors.js');
  const app = express();
  app.use((req, _res, next) => {
    (req as any).serverConfig = { supabaseUrl: 'https://example.supabase.co', supabaseServiceRoleKey: 'k' };
    next();
  });
  app.use(express.json());
  app.use('/api/visitor-intel', visitorsAdminRouter);
  server = http.createServer(app).listen(0);
  port = (server.address() as any).port;
});

afterAll(() => { server.close(); });

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(
      { host: '127.0.0.1', port, path, headers: { Authorization: 'Bearer token' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let body: any = null;
          try { body = JSON.parse(data); } catch { /* not json */ }
          resolve({ status: res.statusCode || 0, body });
        });
      },
    ).on('error', reject);
  });
}

function post(path: string, payload: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let parsed: any = null;
          try { parsed = JSON.parse(body); } catch { /* not json */ }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('GET /api/visitor-intel/network route order', () => {
  it('reaches the network handler for contact_id — does NOT get captured by GET /:id (the exact regression)', async () => {
    const { status, body } = await get(`/api/visitor-intel/network?workspace_id=${WS}&contact_id=${CONTACT_ID}`);
    // The bug's exact signature: /:id's guard returns 404 { error: 'Not found' }
    // for id === 'network'. Any response OTHER than that proves /network was
    // matched by its own route, not swallowed by /:id.
    expect({ status, error: body?.error }).not.toEqual({ status: 404, error: 'Not found' });
    expect(status).toBe(200);
    expect(resolveContactNetworkProfile).toHaveBeenCalledWith(expect.anything(), WS, CONTACT_ID, expect.anything());
    expect(body.profile).toEqual({ profile: 'by-contact' });
  });

  it('session_id still routes correctly', async () => {
    const { status, body } = await get(`/api/visitor-intel/network?workspace_id=${WS}&session_id=${SESSION_ID}`);
    expect(status).toBe(200);
    expect(resolveNetworkProfile).toHaveBeenCalledWith(expect.anything(), WS, SESSION_ID, expect.anything());
    expect(body.profile.sessionId).toBe(SESSION_ID);
  });

  it('conversation_id still resolves via the canonical session lookup', async () => {
    const { status, body } = await get(`/api/visitor-intel/network?workspace_id=${WS}&conversation_id=${CONV_ID}`);
    expect(status).toBe(200);
    expect(resolveNetworkProfile).toHaveBeenCalledWith(expect.anything(), WS, 'sess-from-conv', expect.anything());
    expect(body.profile.sessionId).toBe('sess-from-conv');
  });

  it('call_session_id still resolves via the canonical session lookup', async () => {
    const { status, body } = await get(`/api/visitor-intel/network?workspace_id=${WS}&call_session_id=${CALL_SESSION_ID}`);
    expect(status).toBe(200);
    expect(body.profile.sessionId).toBe('sess-from-call');
  });

  it('callback_id still resolves via the canonical session lookup', async () => {
    const { status, body } = await get(`/api/visitor-intel/network?workspace_id=${WS}&callback_id=${CALLBACK_ID}`);
    expect(status).toBe(200);
    expect(body.profile.sessionId).toBe('sess-from-cb');
  });
});

describe('POST /api/visitor-intel/network/batch', () => {
  it('continues working (was never actually shadowed — different HTTP method — but must keep working after the reorder)', async () => {
    const { status, body } = await post('/api/visitor-intel/network/batch', {
      workspace_id: WS,
      contact_ids: [CONTACT_ID],
      session_ids: [SESSION_ID],
      conversation_ids: [CONV_ID],
    });
    expect(status).toBe(200);
    expect(body).toHaveProperty('by_conversation');
    expect(body).toHaveProperty('by_session');
    expect(body).toHaveProperty('by_contact');
    expect(resolveContactsNetworkProfiles).toHaveBeenCalledWith(expect.anything(), WS, [CONTACT_ID], expect.anything());
    expect(resolveNetworkProfiles).toHaveBeenCalledWith(expect.anything(), WS, [SESSION_ID], expect.anything());
    expect(resolveConversationNetworkProfiles).toHaveBeenCalledWith(expect.anything(), WS, [CONV_ID], expect.anything());
  });
});

describe('GET /network with no handle at all', () => {
  it('reaches the real handler and returns { profile: null } — not the /:id guard\'s 404', async () => {
    const { status, body } = await get(`/api/visitor-intel/network?workspace_id=${WS}`);
    expect(status).toBe(200);
    expect(body).toEqual({ profile: null });
  });
});
