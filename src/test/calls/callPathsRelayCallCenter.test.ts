/**
 * The call centre's two token answers and the Iran relay (2026-11-04): the
 * visitor's join token (`POST /api/call-widget/calls/:id/join-token`) and the
 * operator's accept (`POST /api/call-center/calls/:id/accept`, also the
 * console's Reconnect) carry `turn` and `ice_policy` from
 * buildTokenNetworkBundle, given THIS request, so the relay's countries gate
 * is decided on the caller's own country (the visitor's on the join token,
 * the operator's on the accept).
 *
 * The builder itself (the gate, the mint, the secret) has its own tests; here
 * it is a stand-in that records what it was asked, so these pin the wiring:
 *   - the call id and the request reach it;
 *   - what it answers is what the client gets, the three ICE fields only
 *     (nothing of the stored row: no secret, countries or lifetime);
 *   - the accept puts the relay in `connect` too, the one object the queue
 *     page hands the console (first accept and Reconnect alike);
 *   - a caller the gate leaves out, and a builder that throws, get no `turn`
 *     or `ice_policy` at all: both clients hand LiveKit ICE servers only for
 *     a non-empty list, so this keeps LiveKit's own TURN as `urls: []` would,
 *     and the answer is byte for byte what it was before the relay existed
 *     (RESPOK, which has no relay, answers as it always has);
 *   - so does every caller while the stored relay names no countries (no
 *     list, WebYar's row until it is first saved with one, or `*`): these two
 *     answers had no relay before the list existed, and a relay for every
 *     caller would take LiveKit's own TURN from all of them;
 *   - a builder that throws keeps nobody out: the visitor still joins, the
 *     operator's accept still goes through.
 *
 * The real routers run on a real express app over the in-memory database
 * the call-widget tests use; tokens are minted for real.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, fakeClient } from '../callWidget/fakeDb';
import { startTestServer } from '../callWidget/callWidgetHttp';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

type Dict = Record<string, unknown>;
type Turn = { urls: string[]; username: string | null; credential: string | null };

const relay = vi.hoisted(() => ({
  /** What buildTokenNetworkBundle was asked: the call, the TTL and the request's probe header. */
  asked: [] as Array<{ callId: string; ttl: number; probe: string | null; hasReq: boolean }>,
  turn: { urls: [] as string[], username: null as string | null, credential: null as string | null },
  icePolicy: 'all' as string,
  /** The builder's `countryLimited`: the stored relay names its countries. */
  countryLimited: true,
  fail: false,
}));

const client = {
  from: (table: string) => fakeClient.from(table),
  rpc: async (fn: string, args: Record<string, unknown> = {}) => {
    if (fn === 'get_workspace_role') {
      const m = (db.workspace_members || []).find((r) => r.workspace_id === args._workspace_id && r.user_id === args._user_id);
      return { data: m ? m.role : null, error: null };
    }
    return fakeClient.rpc(fn);
  },
};
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client }));
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => client }));
vi.mock('../../../server/services/geo/index.js', () => ({ enrichVisitorSessionGeo: async () => {} }));
vi.mock('../../../server/services/callCenter/realtime.js', () => ({ publishQueueEvent: async () => {}, publishCallEvent: async () => {} }));
vi.mock('../../../server/services/push/callRing.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/push/callRing.js')>()),
  ringOperators: async () => {},
  cancelRing: async () => {},
}));
vi.mock('../../../server/services/calls/providerResolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../server/services/calls/providerResolver.js')>();
  return {
    ...real,
    resolveEffectiveCallProvider: async (...args: Parameters<typeof real.resolveEffectiveCallProvider>) => {
      const r = await real.resolveEffectiveCallProvider(...args);
      return { ...r, provider: { ...r.provider, createRoom: async (_c: unknown, input: { callSessionId: string }) => ({ providerRoomId: `room-${input.callSessionId}` }) } };
    },
  };
});
vi.mock('../../../server/services/calls/participantToken.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/calls/participantToken.js')>()),
  buildTokenNetworkBundle: async (_config: unknown, callId: string, ttl: number, req?: { headers?: Dict } | null) => {
    relay.asked.push({ callId, ttl, probe: (req?.headers?.['x-relay-probe'] as string | undefined) ?? null, hasReq: !!req });
    if (relay.fail) throw new Error('call_rtc_endpoints unreadable');
    // As the builder answers: the stored row's other fields ride on `turn`.
    const turn = {
      ...relay.turn,
      credential_type: 'password',
      static_secret_present: relay.turn.urls.length > 0,
      countries: ['IR'],
      credential_ttl_seconds: 21_600,
    };
    return {
      network: { rtc_url: 'wss://livekit.example', ws_url: 'wss://rt.example', ice_policy: relay.icePolicy, turn },
      turn,
      withheld: false,
      countryLimited: relay.countryLimited,
    };
  },
}));
vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async (req: { authUser?: { id: string } }) => ({ userId: req.authUser?.id, isAdmin: false, role: 'member' }),
}));
vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => false }));

const WS = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://shop.example';
const A = '00000000-0000-4000-8000-00000000000a';
const CONFIG = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY' };
const RELAY: Turn = {
  urls: ['turn:relay.example:3478?transport=udp'],
  username: '1762321600:r0011223344556677',
  credential: 'c2VlLXRoZS1idWlsZGVy',
};

const { callWidgetRouter } = await import('../../../server/routes/callWidget.js');
const { callCenterRouter } = await import('../../../server/routes/callCenter.js');
const { signWidgetSession } = await import('../../../server/services/callCenter/widgetSession.js');

const site = startTestServer('/api/call-widget', callWidgetRouter, CONFIG, { origin: ORIGIN });
const desk = startTestServer('/api/call-center', callCenterRouter, CONFIG, { authUserId: A });
afterAll(() => { site.close(); desk.close(); });

let seq = 0;
function queuedCall(): { id: string; session: string } {
  const id = `c0ffee00-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  db.call_sessions.push({
    id, workspace_id: WS, entry_source: 'call_widget', state: 'pending', call_type: 'audio', provider: 'livekit', provider_room_id: null,
    assigned_agent_id: null, department_id: null, recording_enabled: false, recording_state: 'disabled', started_at: null,
    connected_at: null, ended_at: null, end_reason: null, duration_seconds: null, created_at: new Date().toISOString(), metadata: { call_center: true },
  });
  db.call_queue_entries.push({ workspace_id: WS, entry_source: 'call_widget', channel: 'audio', state: 'queued', call_session_id: id, priority: 100, created_at: new Date().toISOString() });
  return { id, session: signWidgetSession(CONFIG as never, { workspace_id: WS, public_key: 'cck_x', call_id: id, origin: ORIGIN }) };
}

type AcceptBody = { token: string; connect: Dict & { turn?: Turn; ice_policy?: string }; turn?: Turn; ice_policy?: string };
async function accept(callId: string, probe = 'operator') {
  return desk.post<AcceptBody>(`/api/call-center/calls/${callId}/accept?workspaceId=${WS}`, {}, { 'x-relay-probe': probe });
}
type JoinBody = { token: string; connect: Dict; turn?: Turn; ice_policy?: string };
async function join(call: { id: string; session: string }, probe = 'visitor') {
  return site.post<JoinBody>(`/api/call-widget/calls/${call.id}/join-token`, {}, { 'x-cc-session': call.session, 'x-relay-probe': probe });
}

beforeEach(() => {
  relay.asked = [];
  relay.turn = { ...RELAY };
  relay.icePolicy = 'all';
  relay.countryLimited = true;
  relay.fail = false;
  db.platform_call_center_settings = [{ singleton: true, call_center_enabled: true, call_recording_enabled: false, queue_eta_seconds_per_position: 45 }];
  db.app_runtime_config = [
    { key: 'call_control_plane', value: { enabled: true, primary_provider: 'livekit' } },
    { key: 'call_livekit_config', value: { enabled: true, api_key: 'k', api_secret: 's', rtc_url: 'wss://lk.example', egress_enabled: false } },
  ];
  db.call_center_settings = [{ id: 'cc1', workspace_id: WS, enabled: true, public_key: 'cck_x', allowed_domains: ['shop.example'], recording_enabled: false, routing_mode: 'broadcast' }];
  db.workspace_members = [{ workspace_id: WS, user_id: A, role: 'agent', created_at: '2026-01-01T00:00:00Z' }];
  db.call_center_agent_presence = [{ workspace_id: WS, user_id: A, status: 'available', active_call_count: 0, last_seen_at: null }];
  db.profiles = [{ id: A, full_name: 'Sara Ahmadi', email: 'sara@shop.example' }];
  db.workspace_departments = [];
  db.workspace_department_members = [];
  db.call_sessions = [];
  db.call_queue_entries = [];
  db.call_events = [];
  db.call_participants = [];
});

describe('the visitor\'s join token', () => {
  it('carries the relay the builder gave for this call and this visitor\'s request', async () => {
    const call = queuedCall();
    expect((await accept(call.id)).status).toBe(200);
    relay.asked = [];
    const r = await join(call, 'visitor-in-iran');
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.connect).toMatchObject({ supported: true, provider: 'livekit' });
    expect(r.body.turn).toEqual(RELAY);
    expect(r.body.ice_policy).toBe('all');
    expect(relay.asked).toEqual([{ callId: call.id, ttl: 3600, probe: 'visitor-in-iran', hasReq: true }]);
  });

  it('answers the three ICE fields only: nothing else of the stored relay reaches the visitor', async () => {
    const call = queuedCall();
    await accept(call.id);
    const r = await join(call);
    expect(Object.keys(r.body.turn!).sort()).toEqual(['credential', 'urls', 'username']);
    expect(r.text).not.toContain('countries');
    expect(r.text).not.toContain('credential_ttl_seconds');
    expect(r.text).not.toContain('static_secret_present');
    expect(r.text).not.toContain('shared_secret');
  });

  it('passes the policy on (relay)', async () => {
    relay.icePolicy = 'relay';
    const call = queuedCall();
    await accept(call.id);
    expect((await join(call)).body.ice_policy).toBe('relay');
  });

  it('a visitor the gate leaves out gets the answer as before the relay: no turn, so the engine keeps LiveKit\'s own TURN', async () => {
    relay.turn = { urls: [], username: null, credential: null };
    const call = queuedCall();
    await accept(call.id);
    const r = await join(call, 'visitor-in-turkey');
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(Object.keys(r.body).sort()).toEqual(['connect', 'expires_at', 'provider', 'provider_room_id', 'token']);
  });

  it('a relay that names no countries (no list yet, or *) is not given to call-widget visitors: the answer is as before the relay', async () => {
    relay.countryLimited = false;
    const call = queuedCall();
    await accept(call.id);
    relay.asked = [];
    const r = await join(call, 'visitor-in-turkey');
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(Object.keys(r.body).sort()).toEqual(['connect', 'expires_at', 'provider', 'provider_room_id', 'token']);
    expect(relay.asked).toHaveLength(1);
  });

  it('a builder that throws keeps nobody out: the visitor joins, without a relay, and the call starts', async () => {
    const call = queuedCall();
    await accept(call.id);
    relay.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await join(call);
    warn.mockRestore();
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body).not.toHaveProperty('turn');
    expect(r.body).not.toHaveProperty('ice_policy');
    expect(db.call_sessions.find((c) => c.id === call.id)?.connected_at).toBeTruthy();
  });
});

describe('the operator\'s accept (and the console\'s Reconnect, which accepts again)', () => {
  it('carries the relay at the top and inside connect, from the operator\'s own request', async () => {
    const call = queuedCall();
    const r = await accept(call.id, 'operator-in-iran');
    expect(r.status).toBe(200);
    expect(r.body.turn).toEqual(RELAY);
    expect(r.body.ice_policy).toBe('all');
    expect(r.body.connect).toMatchObject({ supported: true, provider: 'livekit', turn: RELAY, ice_policy: 'all' });
    expect(relay.asked).toEqual([{ callId: call.id, ttl: 3600, probe: 'operator-in-iran', hasReq: true }]);
    expect(Object.keys(r.body.turn!).sort()).toEqual(['credential', 'urls', 'username']);
    expect(r.text).not.toContain('countries');
    expect(r.text).not.toContain('static_secret_present');
  });

  it('a second accept of the same call (Reconnect) asks again and answers the relay again', async () => {
    const call = queuedCall();
    await accept(call.id, 'first');
    const again = await accept(call.id, 'reconnect');
    expect(again.status).toBe(200);
    expect(again.body.connect.turn).toEqual(RELAY);
    expect(relay.asked.map((a) => a.probe)).toEqual(['first', 'reconnect']);
  });

  it('an operator the gate leaves out gets the accept as before the relay: no turn in either place', async () => {
    relay.turn = { urls: [], username: null, credential: null };
    const call = queuedCall();
    const r = await accept(call.id);
    expect(r.status).toBe(200);
    for (const body of [r.body, r.body.connect]) {
      expect(body).not.toHaveProperty('turn');
      expect(body).not.toHaveProperty('ice_policy');
    }
  });

  it('a relay that names no countries (no list yet, or *) is not given to the console: the accept is as before the relay', async () => {
    relay.countryLimited = false;
    const call = queuedCall();
    const r = await accept(call.id, 'operator-in-turkey');
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    for (const body of [r.body, r.body.connect]) {
      expect(body).not.toHaveProperty('turn');
      expect(body).not.toHaveProperty('ice_policy');
    }
  });

  it('a builder that throws does not fail the accept: the call is the operator\'s, without a relay', async () => {
    relay.fail = true;
    const call = queuedCall();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await accept(call.id);
    warn.mockRestore();
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body).not.toHaveProperty('turn');
    expect(r.body.connect).not.toHaveProperty('turn');
    const row = db.call_sessions.find((c) => c.id === call.id)!;
    expect(row.state).toBe('active');
    expect(row.assigned_agent_id).toBe(A);
  });
});
