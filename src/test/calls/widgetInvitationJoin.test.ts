/**
 * POST /api/widget/call-invitations/:id/join (audit 2026-11-04):
 *
 *   - widgetapi-4: the visitor proves they own the invitation's conversation
 *     with the signed visitor only (the visitor credential header, or the
 *     dvsid cookie); a visitor_id or session_id in the body proves nothing;
 *   - widgetapi-7: the invitation is claimed atomically, so a double click
 *     or two tabs make one call: the second join is "already joined", and
 *     the row it began is closed at once (it never counts as a live call).
 *
 * The real invitations service and the real ownership check, over
 * ../callWidget/fakeDb.ts; the provider makes local rooms and tokens.
 */
process.env.WIDGET_VISITOR_SECRET = process.env.WIDGET_VISITOR_SECRET || 'test-visitor-secret-invitation-join';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import cookieParser from 'cookie-parser';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, fakeClient } from '../callWidget/fakeDb';

type Dict = Record<string, unknown>;

const WS = '11111111-1111-4111-8111-111111111111';
const CONV = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';
const VISITOR = '66666666-6666-4666-8666-666666666666';

/** Reads of the invitation answered as it was before a join landed: two joins that both saw it pending. */
const stale: { reads: number; row: Record<string, unknown> | null } = { reads: 0, row: null };
const client = {
  ...fakeClient,
  from: (table: string) => {
    const q = fakeClient.from(table);
    if (table === 'call_invitations' && stale.reads > 0 && stale.row) {
      const real = q.maybeSingle.bind(q);
      const row = stale.row;
      q.maybeSingle = async () => {
        if (stale.reads > 0) { stale.reads--; return { data: { ...row }, error: null }; }
        return real();
      };
    }
    return q;
  },
};
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => client }));
vi.mock('../../../server/services/widget/security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/widget/security.js')>()),
  enforceWidgetToken: (req: { _widgetWorkspaceId?: string }, _res: unknown, next: () => void) => { req._widgetWorkspaceId = '11111111-1111-4111-8111-111111111111'; next(); },
  enforceOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
  widgetRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveWorkspaceId: () => '11111111-1111-4111-8111-111111111111',
}));
vi.mock('../../../server/services/realtime/publish.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async () => {},
}));
const fakeProvider = vi.hoisted(() => ({
  createRoom: async (_c: unknown, input: { callSessionId: string }) => ({ providerRoomId: `room-${input.callSessionId}` }),
  createParticipantToken: async (_c: unknown, input: { callSessionId: string }) => ({ token: `tok-${input.callSessionId}`, expiresAt: '2026-11-04T10:00:00.000Z' }),
  closeRoom: async () => {},
}));
vi.mock('../../../server/services/calls/providerResolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/calls/providerResolver.js')>()),
  resolveCallProvider: () => fakeProvider,
  resolveEffectiveCallProvider: async () => ({ id: 'livekit', provider: fakeProvider }),
}));
vi.mock('../../../server/services/calls/controlPlane.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/calls/controlPlane.js')>()),
  loadCallControlPlane: async () => ({ enabled: true, max_participants: 2 }),
  loadWorkspaceCallOverrides: async () => ({ allow_voice: true, allow_video: true }),
}));
vi.mock('../../../server/services/calls/participantToken.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/calls/participantToken.js')>()),
  buildTokenNetworkBundle: async () => {
    const turn = { urls: ['turn:relay.example:3478'], username: 'u', credential: 'c' };
    return { network: { rtc_url: 'wss://livekit.example', ws_url: 'wss://rt.example', ice_policy: 'all', turn }, turn, withheld: false };
  },
}));

const { widgetCallInvitationsRouter } = await import('../../../server/routes/widgetCallInvitations.js');
const { issueVisitorCredential, VISITOR_CREDENTIAL_HEADER } = await import('../../../server/services/widget/visitorIdentity.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: Dict }).serverConfig = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY' };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/widget/call-invitations', widgetCallInvitationsRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

function post(path: string, body: Dict, headers: Record<string, string> = {}): Promise<{ status: number; body: Dict }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : {} }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const signedAs = (visitorId: string) => {
  const now = Math.floor(Date.now() / 1000);
  return { [VISITOR_CREDENTIAL_HEADER]: issueVisitorCredential({ v: visitorId, w: WS, iat: now, exp: now + 3600 }) };
};
const join = (headers: Record<string, string>, body: Dict = { workspace_id: WS }) =>
  post('/api/widget/call-invitations/inv-1/join', body, headers);

beforeEach(() => {
  db.call_invitations = [{
    id: 'inv-1', workspace_id: WS, conversation_id: CONV, visitor_session_id: SESSION, channel: 'audio', status: 'pending',
    created_by_user_id: 'op-1', expires_at: new Date(Date.now() + 60_000).toISOString(), system_message_id: null, call_session_id: null,
  }];
  db.conversations = [{ id: CONV, workspace_id: WS, visitor_session_id: SESSION, contact_id: null, status: 'open', metadata: { visitor_id: VISITOR } }];
  db.visitor_sessions = [{ id: SESSION, workspace_id: WS, visitor_id: VISITOR }];
  db.call_sessions = [];
  db.conversation_events = [];
});

describe('widgetapi-4: only the signed visitor proves the conversation is theirs', () => {
  it('a body naming the visitor (or their session) without their signed credential is refused, and nothing is made', async () => {
    const r = await join({}, { workspace_id: WS, visitor_id: VISITOR, session_id: SESSION });
    expect(r.status).toBe(403);
    expect(db.call_sessions).toHaveLength(0);
    expect(db.call_invitations[0].status).toBe('pending');
  });

  it('another visitor\'s signed credential is refused, whatever the body says', async () => {
    const r = await join(signedAs('77777777-7777-4777-8777-777777777777'), { workspace_id: WS, visitor_id: VISITOR, session_id: SESSION });
    expect(r.status).toBe(403);
    expect(db.call_sessions).toHaveLength(0);
  });

  it('the visitor\'s own signed credential joins', async () => {
    const r = await join(signedAs(VISITOR));
    expect(r.status).toBe(200);
    expect(r.body.call_id).toBeTruthy();
    expect(db.call_invitations[0]).toMatchObject({ status: 'joined', call_session_id: r.body.call_id });
  });
});

describe('widgetapi-7: one invitation, one call', () => {
  it('two joins that both saw it pending: one call; the other is "already joined" and its row is closed at once', async () => {
    const pending = { ...db.call_invitations[0] };
    const a = await join(signedAs(VISITOR));
    // The second tab's reads (ownership, then the pending check) happened before the first join's claim.
    stale.row = pending;
    stale.reads = 2;
    const b = await join(signedAs(VISITOR));
    expect(stale.reads).toBe(0);
    expect(b.body.error ?? b.body.code).toBeTruthy();
    const ok = [a, b].filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    const other = a.status === 200 ? b : a;
    expect(other.status).not.toBe(200);
    expect(other.body.token).toBeUndefined();
    const live = db.call_sessions.filter((s) => ['pending', 'ringing', 'connecting', 'active'].includes(String(s.state)));
    expect(live.map((s) => s.id)).toEqual([ok[0].body.call_id]);
    expect(db.call_invitations[0].call_session_id).toBe(ok[0].body.call_id);
    // Both got past the pending check (the race happened): the loser's row is closed, never live.
    expect(db.call_sessions.map((s) => s.state).sort()).toEqual(['connecting', 'failed']);
  });

  it('a join after the invitation was joined makes nothing', async () => {
    expect((await join(signedAs(VISITOR))).status).toBe(200);
    const again = await join(signedAs(VISITOR));
    expect(again.status).not.toBe(200);
    expect(db.call_sessions).toHaveLength(1);
  });

  it('a room that cannot be made gives the invitation back: the visitor can try again', async () => {
    const real = fakeProvider.createRoom;
    fakeProvider.createRoom = async () => { throw new Error('livekit down'); };
    try {
      const r = await join(signedAs(VISITOR));
      expect(r.status).not.toBe(200);
    } finally {
      fakeProvider.createRoom = real;
    }
    expect(db.call_invitations[0]).toMatchObject({ status: 'pending', call_session_id: null });
    expect(db.call_sessions.every((s) => s.state === 'failed')).toBe(true);
    expect((await join(signedAs(VISITOR))).status).toBe(200);
  });
});
