/**
 * The operator in the visitor's call room (owner request, 2026-10-19): the
 * visitor's browser must not learn the operator's user id, or any part of
 * their e-mail, from the LiveKit room. Everything a room shows of a
 * participant comes from that participant's token (identity, name, metadata,
 * attributes), so the tests read the tokens the real routes mint:
 *
 *   - the call-center console's accept (the widget's calls), and the token
 *     endpoint the dashboard's chat-call console and the installed apps use
 *     (`/api/calls/:id/token`, also their rejoin): `operator:<ref>`, where
 *     <ref> is the status endpoint's `call.assigned_agent_id` (so the widget can
 *     tell the operator in the room is the one the status names), under the
 *     operator's own name or none, whatever name a client asks for;
 *   - the transfer's answer names the identity the colleague will join under
 *     (what the desktop apps wait for before stepping out);
 *   - the webhook finds the user again from that identity;
 *   - the engine treats the old (`operator:<uuid>`, a call from before the
 *     deploy) and the new form alike.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, fakeClient } from './fakeDb';
import { startTestServer, type TestServer } from './callWidgetHttp';
import { callRoutes, closeCallWidgets, fakeApi, mountCallWidget, settle, type CallServerState, type Engine } from './mountCallWidget';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

type Row = Record<string, unknown>;
type Dict = Record<string, unknown>;

/** The service client: ./fakeDb.ts, and the role RPC the call-center routes ask, answered from workspace_members. */
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
// The media server's room is made on its API (a network call): here it is named; tokens are minted for real.
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
vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async (req: { authUser?: { id: string } }) => ({ userId: req.authUser?.id, isAdmin: false, role: 'member' }),
}));
vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => false }));

const WS = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://shop.example';
/** Operators: A and B by name; C has no full name, only an e-mail. */
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const DEPT = '33333333-3333-4333-8333-333333333333';
const MEMBERS = [A, B, C];
const EMAILS = ['sara@shop.example', 'reza@shop.example', 'c.agent@shop.example'];
const CONFIG = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY' };

const { callWidgetRouter } = await import('../../../server/routes/callWidget.js');
const { callCenterRouter } = await import('../../../server/routes/callCenter.js');
const { callsRouter } = await import('../../../server/routes/calls.js');
const { applyEvent } = await import('../../../server/routes/livekitWebhook.js');
const { signWidgetSession } = await import('../../../server/services/callCenter/widgetSession.js');

const site = startTestServer('/api/call-widget', callWidgetRouter, CONFIG, { origin: ORIGIN });
const servers = new Map<string, TestServer>();
/** An operator's console: the call-center API, or the calls API, as that user. */
function as(user: string, api: 'call-center' | 'calls'): TestServer {
  const key = `${api}:${user}`;
  if (!servers.has(key)) servers.set(key, startTestServer(`/api/${api}`, api === 'calls' ? callsRouter : callCenterRouter, CONFIG, { authUserId: user }));
  return servers.get(key)!;
}
afterAll(() => { site.close(); for (const s of servers.values()) s.close(); });

/** Every claim of a LiveKit token: what the room shows of its participant (identity = sub, name, metadata, attributes). */
function claims(token: string): Dict {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Dict;
}

/** Nothing of any member: no user id (or its first block), no e-mail or local part of one. */
function expectNoMember(text: string) {
  for (const id of MEMBERS) expect(text).not.toContain(id);
  for (const e of EMAILS) {
    expect(text).not.toContain(e);
    expect(text).not.toContain(e.split('@')[0]);
  }
  expect(text).not.toContain('@');
}

let seq = 0;
/** A queued call of the widget, as `calls/request` makes it, and the visitor's session for it. */
function queuedCall(): { id: string; session: string } {
  const id = `c0ffee00-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  db.call_sessions.push({
    id, workspace_id: WS, entry_source: 'call_widget', state: 'queued', call_type: 'audio', provider: 'livekit', provider_room_id: null,
    assigned_agent_id: null, department_id: null, recording_enabled: false, recording_state: 'disabled', started_at: null,
    connected_at: null, ended_at: null, end_reason: null, duration_seconds: null, created_at: new Date().toISOString(), metadata: { call_center: true },
  });
  db.call_queue_entries.push({ workspace_id: WS, entry_source: 'call_widget', channel: 'audio', state: 'queued', call_session_id: id, priority: 100, created_at: new Date().toISOString() });
  return { id, session: signWidgetSession(CONFIG as never, { workspace_id: WS, public_key: 'cck_x', call_id: id, origin: ORIGIN }) };
}

async function accept(user: string, callId: string) {
  const r = await as(user, 'call-center').post<{ token: string; connect: Dict }>(`/api/call-center/calls/${callId}/accept?workspaceId=${WS}`, {});
  expect(r.status).toBe(200);
  return r;
}

async function statusRef(call: { id: string; session: string }): Promise<string | null> {
  const r = await site.get<{ call: Dict }>(`/api/call-widget/calls/${call.id}/status`, { 'x-cc-session': call.session });
  expect(r.status).toBe(200);
  return r.body.call.assigned_agent_id as string | null;
}

beforeEach(() => {
  db.platform_call_center_settings = [{ singleton: true, call_center_enabled: true, call_recording_enabled: false, queue_eta_seconds_per_position: 45 }];
  db.app_runtime_config = [
    { key: 'call_control_plane', value: { enabled: true, primary_provider: 'livekit' } },
    { key: 'call_livekit_config', value: { enabled: true, api_key: 'k', api_secret: 's', rtc_url: 'wss://lk.example', egress_enabled: false } },
  ];
  db.call_center_settings = [{ id: 'cc1', workspace_id: WS, enabled: true, public_key: 'cck_x', allowed_domains: ['shop.example'], recording_enabled: false, routing_mode: 'broadcast' }];
  db.workspace_members = MEMBERS.map((user_id, i) => ({ workspace_id: WS, user_id, role: 'agent', created_at: `2026-01-0${i + 1}T00:00:00Z` }));
  db.call_center_agent_presence = MEMBERS.map((user_id) => ({ workspace_id: WS, user_id, status: 'available', active_call_count: 0, last_seen_at: null }));
  db.profiles = [
    { id: A, full_name: 'Sara Ahmadi', email: EMAILS[0] },
    { id: B, full_name: ' Reza Karimi ', email: EMAILS[1] },
    { id: C, full_name: null, email: EMAILS[2] },
  ];
  db.workspace_departments = [];
  db.workspace_department_members = [];
  db.call_sessions = [];
  db.call_queue_entries = [];
  db.call_events = [];
  db.call_participants = [];
});

describe('the operator\'s token: what the visitor\'s room shows of them', () => {
  it('accept: operator:<the status\'s reference>, the operator\'s own name, no id or e-mail in any claim; the console\'s connect block agrees', async () => {
    const call = queuedCall();
    const accepted = await accept(A, call.id);
    const c = claims(accepted.body.token);
    const ref = await statusRef(call);
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    expect(c.sub).toBe(`operator:${ref}`);
    expect(c.name).toBe('Sara Ahmadi');
    expect(JSON.parse(String(c.metadata))).toEqual({ call_session_id: call.id, participant_type: 'operator' });
    expect(c.attributes ?? null).toBeNull();
    expectNoMember(JSON.stringify(c));
    expect(accepted.body.connect).toMatchObject({ supported: true, identity: c.sub });
  });

  it('an operator without a name of their own: an empty name (never the e-mail, never the id)', async () => {
    const call = queuedCall();
    const c = claims((await accept(C, call.id)).body.token);
    expect(c.sub).toBe(`operator:${await statusRef(call)}`);
    expect(c.name).toBe('');
    expectNoMember(JSON.stringify(c));
  });

  it('the visitor\'s own join token and its answer carry nothing of the operator', async () => {
    const call = queuedCall();
    await accept(A, call.id);
    const r = await site.post<{ token: string }>(`/api/call-widget/calls/${call.id}/join-token`, {}, { 'x-cc-session': call.session });
    expect(r.status).toBe(200);
    expectNoMember(r.text);
    expectNoMember(JSON.stringify(claims(r.body.token)));
    expect(claims(r.body.token).sub).toBe(`visitor:visitor:${call.id}`);
  });

  it('/api/calls/:id/token (the chat-call console, the apps, a rejoin): the same identity as the accept; the name a client asks for is not used (the desktop apps send the e-mail when there is no name)', async () => {
    const call = queuedCall();
    const fromAccept = claims((await accept(A, call.id)).body.token);
    const a = await as(A, 'calls').post<{ token: string }>(`/api/calls/${call.id}/token`, { participant_type: 'operator', display_name: 'sara@shop.example' });
    expect(a.status).toBe(200);
    const ca = claims(a.body.token);
    // One identity per operator and call: a second device (or a rejoin) replaces the older connection, as before.
    expect(ca.sub).toBe(fromAccept.sub);
    expect(ca.name).toBe('Sara Ahmadi');
    expectNoMember(JSON.stringify(ca));

    const c = await as(C, 'calls').post<{ token: string }>(`/api/calls/${call.id}/token`, { display_name: 'c.agent@shop.example' });
    expect(c.status).toBe(200);
    const cc = claims(c.body.token);
    expect(cc.sub).toMatch(/^operator:[0-9a-f]{16}$/);
    expect(cc.sub).not.toBe(ca.sub);
    expect(cc.name).toBe('');
    expectNoMember(JSON.stringify(cc));
  });

  it('a member token minted for someone else\'s id carries no name: the route never looks up another user\'s profile name for the caller', async () => {
    const call = queuedCall();
    await accept(A, call.id);
    // C asks for a token naming A (C has no name of their own): A's profile name must not come back in it.
    const r = await as(C, 'calls').post<{ token: string }>(`/api/calls/${call.id}/token`, { participant_type: 'operator', participant_id: A });
    expect(r.status).toBe(200);
    const c = claims(r.body.token);
    expect(c.name).toBe('');
    expect(r.text).not.toContain('Sara');
    expect(JSON.stringify(c)).not.toContain('Sara');
    expectNoMember(JSON.stringify(c));
  });

  it('a visitor token minted by a member keeps its form and the name given', async () => {
    const call = queuedCall();
    await accept(A, call.id);
    const visitorId = '44444444-4444-4444-8444-444444444444';
    const r = await as(A, 'calls').post<{ token: string }>(`/api/calls/${call.id}/token`, { participant_type: 'visitor', participant_id: visitorId, display_name: 'Guest' });
    expect(r.status).toBe(200);
    expect(claims(r.body.token)).toMatchObject({ sub: `visitor:${visitorId}`, name: 'Guest' });
  });
});

describe('transfers: the identity the colleague will join under', () => {
  it('to an operator by name: the answer names B\'s identity on this call, the one B\'s accept mints', async () => {
    const call = queuedCall();
    await accept(A, call.id);
    const t = await as(A, 'call-center').post<Dict>(`/api/call-center/calls/${call.id}/transfer?workspaceId=${WS}`, { to_agent_id: B });
    expect(t.status).toBe(200);
    expect(t.body.assigned_agent_id).toBe(B);
    const acceptedB = claims((await accept(B, call.id)).body.token);
    expect(t.body.assigned_participant_identity).toBe(acceptedB.sub);
    expect(acceptedB.sub).toBe(`operator:${await statusRef(call)}`);
  });

  it('to a department nobody has picked yet: no identity (any colleague who joins is the one)', async () => {
    db.workspace_departments = [{ id: DEPT, workspace_id: WS, name: 'Sales', enabled: true, cc_voice_enabled: true, cc_video_enabled: false, cc_callback_enabled: false, cc_routing_mode: 'broadcast', cc_fallback_department_id: null, cc_routing_state: null }];
    db.workspace_department_members = [A, C].map((user_id) => ({ workspace_id: WS, department_id: DEPT, user_id, call_center_enabled: true, call_center_priority: 100 }));
    const call = queuedCall();
    await accept(A, call.id);
    const t = await as(A, 'call-center').post<Dict>(`/api/call-center/calls/${call.id}/transfer?workspaceId=${WS}`, { to_department_id: DEPT });
    expect(t.status).toBe(200);
    expect(t.body.assigned_agent_id).toBeNull();
    expect(t.body.assigned_participant_identity).toBeNull();
  });
});

describe('the webhook, with the identities the routes mint', () => {
  it('A answers, transfers to B, B joins, A leaves: each row and each event names its user', async () => {
    const call = queuedCall();
    const idA = String(claims((await accept(A, call.id)).body.token).sub);
    const ev = (event: string, identity: string) => ({
      event, id: `${event}-${identity}`, room: { name: `room-${call.id}`, metadata: JSON.stringify({ call_session_id: call.id }) }, participant: { identity },
    });
    expect(await applyEvent(CONFIG as never, ev('participant_joined', idA))).toEqual({ applied: true });
    expect((await as(A, 'call-center').post(`/api/call-center/calls/${call.id}/transfer?workspaceId=${WS}`, { to_agent_id: B })).status).toBe(200);
    const idB = String(claims((await accept(B, call.id)).body.token).sub);
    await applyEvent(CONFIG as never, ev('participant_joined', idB));
    await applyEvent(CONFIG as never, ev('participant_left', idA));
    const rows = db.call_participants.filter((r) => r.call_session_id === call.id);
    expect(rows.map((r) => [r.provider_participant_id, r.participant_id, !!r.left_at])).toEqual([[idA, A, true], [idB, B, false]]);
    const lk = db.call_events.filter((e) => String(e.event_type).startsWith('lk.participant'));
    expect(lk.map((e) => [e.event_type, (e.payload as Row).user_id])).toEqual([
      ['lk.participant_joined', A], ['lk.participant_joined', B], ['lk.participant_left', A],
    ]);
  });
});

describe('the engine: an operator in the room, in either form', () => {
  const NOW = Date.parse('2026-10-22T07:30:00Z');
  const OLD = `operator:${A}`;
  const NEW = 'operator:0123456789abcdef';
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); });
  afterEach(() => { closeCallWidgets(); vi.useRealTimers(); });

  async function liveCall(s: CallServerState, present: string[]) {
    const api = fakeApi(callRoutes(s));
    const m = mountCallWidget({
      locale: 'en', now: NOW, fetch: api.fetch, liveKit: { present },
      mountExtra: { activeSessionKey: `ccw_active_call_session:${WS}:https://api.example` },
      bootstrap: { active_call: { call_id: 'c1', state: s.state, session: 'S1', call_type: 'audio', created_at: new Date(NOW - 60_000).toISOString() } },
    });
    await settle();
    m.loadLinks();
    return { m, c: m.ctrl as unknown as Engine, room: m.lk!.room() };
  }

  it.each([['a call from before the deploy', OLD, A], ['this release', NEW, '0123456789abcdef']])('%s: %s is the operator the call shows', async (_l, identity, ref) => {
    const { m, c } = await liveCall({ state: 'active', agent: ref, name: 'Sara' }, [identity]);
    expect(c.connectStatus).toBe('in_call');
    expect(m.screenId()).toBe('voice');
    expect(c.transferring).toBe(false);
  });

  it('the deploy during the call: the console rejoins under the new form while the status turns the id into the reference; same operator, no transfer, no failure', async () => {
    const s: CallServerState = { state: 'active', agent: A, name: 'Sara' };
    const { m, c, room } = await liveCall(s, [OLD]);
    s.agent = '0123456789abcdef';
    room.join(NEW);
    room.leave(OLD);
    c.pollOnce();
    await settle();
    expect(c.transferring).toBe(false);
    expect(c.connectStatus).not.toBe('operator_left');
    expect(m.screenId()).toBe('voice');
    expect(c.operatorName).toBe('Sara');
  });
});
