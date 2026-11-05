/**
 * The call state machine's guards, through the real routes (audit
 * 2026-11-04, the calls findings). A call that is over never comes back or
 * ends twice (calls-1, -9), an abandoned widget call is missed (calls-2), a
 * call-centre call is operated only by whoever holds it (calls-3, -8), one
 * accept wins (calls-5), the operator's active call count follows the calls
 * they hold (calls-6), the queue is per workspace (calls-7), a recording stop
 * names this call's egress (calls-10), and a visitor's call requests have
 * limits of their own (calls-4).
 *
 * The database is ./fakeDb.ts (filters applied for real); LiveKit is a
 * provider whose rooms and tokens are local, with closeRoom recorded.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, fakeClient } from '../callWidget/fakeDb';
import { startTestServer, type TestServer } from '../callWidget/callWidgetHttp';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

type Row = Record<string, unknown>;
type Dict = Record<string, unknown>;

const h = vi.hoisted(() => ({ closed: [] as string[], rung: [] as string[], stopped: [] as string[] }));

/** One read of call_sessions answered with an older copy: the moment two accepts both read the call unassigned. */
const stale: { row: Row | null } = { row: null };
const client = {
  from: (table: string) => {
    const q = fakeClient.from(table);
    if (table === 'call_sessions' && stale.row) {
      const row = stale.row;
      const real = q.maybeSingle.bind(q);
      let used = false;
      q.maybeSingle = async () => {
        if (!used && stale.row === row) { used = true; stale.row = null; return { data: { ...row }, error: null }; }
        return real();
      };
    }
    return q;
  },
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
  ringOperators: async (_c: unknown, args: { callSessionId: string }) => { h.rung.push(args.callSessionId); },
  cancelRing: async () => {},
}));
vi.mock('../../../server/services/calls/providerResolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../server/services/calls/providerResolver.js')>();
  const wrap = <P extends object>(p: P) => ({
    ...p,
    createRoom: async (_c: unknown, input: { callSessionId: string }) => ({ providerRoomId: `room-${input.callSessionId}` }),
    closeRoom: async (_c: unknown, room: string) => { h.closed.push(room); },
    stopRecording: async (_c: unknown, id: string) => { h.stopped.push(id); return { recordingId: id, status: 'stopping' }; },
  });
  return {
    ...real,
    resolveCallProvider: (id: Parameters<typeof real.resolveCallProvider>[0]) => wrap(real.resolveCallProvider(id)),
    resolveEffectiveCallProvider: async (...args: Parameters<typeof real.resolveEffectiveCallProvider>) => {
      const r = await real.resolveEffectiveCallProvider(...args);
      return { ...r, provider: wrap(r.provider) };
    },
  };
});
vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async (req: { authUser?: { id: string } }) => ({ userId: req.authUser?.id, isAdmin: false, role: 'member' }),
}));
vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => false }));
// The plan allows every call (its gates are tested elsewhere).
vi.mock('../../../server/services/calls/entitlementComposer.js', () => ({
  loadEffectiveCallEntitlements: async () => ({
    voice_enabled: true, video_enabled: true, visitor_voice_enabled: true, visitor_video_enabled: true,
    recording_enabled: true, queue_enabled: true, callbacks_enabled: true, call_center_enabled: true, plan: {}, runtime: {},
  }),
}));
type FakeInsertClient = {
  from: (t: string) => { insert: (r: unknown) => { select: (c: string) => { maybeSingle: () => Promise<{ data: unknown; error: { message?: string } | null }> } } };
};
vi.mock('../../../server/services/calls/concurrencyLimit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/calls/concurrencyLimit.js')>()),
  checkPlanConcurrencyCeiling: async () => ({ allowed: true, limit: -1 }),
  // The guarded insert (migration 302) is proven on a real database in
  // serverRowCaps.pg.test.ts; here it writes through the fake client.
  insertCallSessionWithinCeiling: async (sb: FakeInsertClient, row: Record<string, unknown>) => {
    const r = await sb.from('call_sessions').insert(row).select('*').maybeSingle();
    return r.data ? { verdict: 'created', call: r.data } : { verdict: 'error', message: r.error?.message || 'insert_returned_no_row' };
  },
}));
vi.mock('../../../server/services/calls/monthlyMinutesLimit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/calls/monthlyMinutesLimit.js')>()),
  checkPlanMonthlyMinutesCeiling: async () => ({ allowed: true, limit: -1 }),
}));

const WS = '22222222-2222-4222-8222-222222222222';
const OTHER_WS = '99999999-9999-4999-8999-999999999999';
const ORIGIN = 'https://shop.example';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const LEAD = '00000000-0000-4000-8000-00000000000c';
const VIEWER = '00000000-0000-4000-8000-00000000000d';
const CONFIG = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY' };

const { callWidgetRouter } = await import('../../../server/routes/callWidget.js');
const { callCenterRouter } = await import('../../../server/routes/callCenter.js');
const { callsRouter } = await import('../../../server/routes/calls.js');
const { callQueueRouter } = await import('../../../server/routes/callQueue.js');
const { applyEvent } = await import('../../../server/routes/livekitWebhook.js');
const { signWidgetSession } = await import('../../../server/services/callCenter/widgetSession.js');
const queue = await import('../../../server/services/calls/queue.js');
const { endCallSession } = await import('../../../server/services/calls/endSession.js');
const limiter = await import('../../../server/services/calls/callRequestLimiter.js');
const { invalidatePlatformCallCenterCache } = await import('../../../server/services/callCenter/settings.js');

const site = startTestServer('/api/call-widget', callWidgetRouter, CONFIG, { origin: ORIGIN });
const servers = new Map<string, TestServer>();
function as(user: string, api: 'call-center' | 'calls' | 'call-queue'): TestServer {
  const key = `${api}:${user}`;
  if (!servers.has(key)) {
    const router = api === 'calls' ? callsRouter : api === 'call-queue' ? callQueueRouter : callCenterRouter;
    servers.set(key, startTestServer(`/api/${api}`, router, CONFIG, { authUserId: user }));
  }
  return servers.get(key)!;
}
afterAll(() => { site.close(); for (const s of servers.values()) s.close(); });

let seq = 0;
/** A widget call waiting in the line, as `calls/request` makes it, and the visitor's session for it. */
function waitingCall(extra: Row = {}): { id: string; session: string; row: Row } {
  const id = `c0ffee00-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const row: Row = {
    id, workspace_id: WS, entry_source: 'call_widget', state: 'pending', call_type: 'audio', provider: 'livekit', provider_room_id: null,
    assigned_agent_id: null, department_id: null, recording_enabled: false, recording_state: 'disabled', started_at: null,
    connected_at: null, ended_at: null, end_reason: null, duration_seconds: null, created_at: new Date().toISOString(),
    metadata: { call_center: true }, ...extra,
  };
  db.call_sessions.push(row);
  db.call_queue_entries.push({
    id: `qe-${id}`, workspace_id: WS, entry_source: 'call_widget', channel: 'audio', state: 'queued', call_session_id: id, priority: 100,
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  return { id, row, session: signWidgetSession(CONFIG as never, { workspace_id: WS, public_key: 'cck_x', call_id: id, origin: ORIGIN }) };
}
const callRow = (id: string) => db.call_sessions.find((r) => r.id === id)!;
const countOf = (user: string) => Number(db.call_center_agent_presence.find((p) => p.user_id === user)?.active_call_count ?? -1);
const accept = (user: string, id: string) => as(user, 'call-center').post<Dict>(`/api/call-center/calls/${id}/accept?workspaceId=${WS}`, {});
const lk = (event: string, call: { id: string }, extra: Dict = {}) => applyEvent(CONFIG as never, {
  event, id: `ev-${++seq}`, room: { name: `room-${call.id}`, sid: 'RM_1' }, ...extra,
} as never);

beforeEach(() => {
  h.closed.length = 0; h.rung.length = 0; h.stopped.length = 0;
  limiter.resetCallRequestLimiter();
  db.platform_call_center_settings = [{ singleton: true, call_center_enabled: true, call_recording_enabled: false, queue_eta_seconds_per_position: 45 }];
  db.app_runtime_config = [
    { key: 'call_control_plane', value: { enabled: true, primary_provider: 'livekit' } },
    { key: 'call_livekit_config', value: { enabled: true, api_key: 'k', api_secret: 's', rtc_url: 'wss://lk.example', egress_enabled: false } },
  ];
  db.call_center_settings = [{ id: 'cc1', workspace_id: WS, enabled: true, public_key: 'cck_x', allowed_domains: ['shop.example'], recording_enabled: false, routing_mode: 'broadcast' }];
  db.workspace_members = [
    { workspace_id: WS, user_id: A, role: 'agent' },
    { workspace_id: WS, user_id: B, role: 'agent' },
    { workspace_id: WS, user_id: LEAD, role: 'team_lead' },
    { workspace_id: WS, user_id: VIEWER, role: 'viewer' },
  ];
  db.call_center_agent_presence = [A, B, LEAD].map((user_id) => ({ workspace_id: WS, user_id, status: 'available', active_call_count: 0, last_seen_at: null }));
  db.profiles = [{ id: A, full_name: 'Sara' }, { id: B, full_name: 'Reza' }, { id: LEAD, full_name: 'Lead' }];
  db.workspace_departments = [];
  db.workspace_department_members = [];
  db.call_sessions = [];
  db.call_queue_entries = [];
  db.call_events = [];
  db.call_participants = [];
  db.call_recordings = [];
  db.operator_availability = [];
});

describe('calls-1: an ended call never comes back (and is never billed twice)', () => {
  it('room_started of an ended call (a kept token, auto_create) leaves it ended and closes the room', async () => {
    const call = waitingCall();
    expect((await accept(A, call.id)).status).toBe(200);
    expect((await as(A, 'call-center').post(`/api/call-center/calls/${call.id}/end?workspaceId=${WS}`, {})).status).toBe(200);
    const ended = { ...callRow(call.id) };
    expect(ended.state).toBe('ended');
    h.closed.length = 0;

    expect(await lk('room_started', call, { room: { name: `room-${call.id}`, sid: 'RM_2', creationTime: Math.floor(Date.now() / 1000) } })).toEqual({ applied: true });
    expect(callRow(call.id)).toMatchObject({ state: 'ended', started_at: ended.started_at, ended_at: ended.ended_at });
    expect(h.closed).toEqual([`room-${call.id}`]);

    // Its room_finished moves nothing either: the end stays the first one.
    await lk('room_finished', call);
    expect(callRow(call.id)).toMatchObject({ state: 'ended', ended_at: ended.ended_at, ended_by: 'operator', end_reason: 'operator_ended' });
  });

  it('someone joining the room of an ended call is put out with it; the call is not stamped connected', async () => {
    const call = waitingCall({ state: 'ended', provider_room_id: null, ended_at: '2026-11-04T08:00:00Z' });
    callRow(call.id).provider_room_id = `room-${call.id}`;
    await lk('participant_joined', call, { participant: { identity: 'visitor:v-1', sid: 'PA_1' } });
    expect(callRow(call.id)).toMatchObject({ state: 'ended', connected_at: null });
    expect(h.closed).toEqual([`room-${call.id}`]);
  });

  it('a live call: room_started makes it active, room_finished ends it once, from the time the visitor was in it', async () => {
    const call = waitingCall();
    expect((await accept(A, call.id)).status).toBe(200);
    callRow(call.id).connected_at = new Date(Date.now() - 90_000).toISOString();
    await lk('room_finished', call);
    const row = callRow(call.id);
    expect(row).toMatchObject({ state: 'ended', ended_by: 'system', end_reason: 'system_ended' });
    expect(Number(row.duration_seconds)).toBeGreaterThanOrEqual(89);
    expect(countOf(A)).toBe(0);
  });

  it('endCallSession never ends a missed or cancelled call (which would bill it)', async () => {
    for (const state of ['missed', 'cancelled']) {
      const call = waitingCall({ state, connected_at: '2026-11-04T08:00:00Z', ended_at: '2026-11-04T08:05:00Z' });
      const r = await endCallSession(CONFIG as never, { callId: call.id, reason: 'operator_ended', endedBy: 'operator', endedByUserId: A });
      expect(r).toMatchObject({ ok: true, was_active: false });
      expect(callRow(call.id)).toMatchObject({ state, ended_at: '2026-11-04T08:05:00Z' });
    }
  });
});

describe('calls-2: an abandoned widget call is missed, not pending for ever', () => {
  it('the queue entry expiring misses the call waiting behind it', async () => {
    const call = waitingCall();
    db.call_queue_entries.find((e) => e.call_session_id === call.id)!.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await queue.expireStaleEntries(CONFIG as never)).toBe(1);
    expect(callRow(call.id)).toMatchObject({ state: 'missed', ended_by: 'system', end_reason: 'system_ended' });
    expect(callRow(call.id).ended_at).toBeTruthy();
  });

  it('an entry missed after its offers misses its call; an answered call is never touched', async () => {
    const missed = waitingCall();
    const answered = waitingCall({ state: 'active', assigned_agent_id: A, connected_at: new Date().toISOString() });
    for (const c of [missed, answered]) {
      Object.assign(db.call_queue_entries.find((e) => e.call_session_id === c.id)!, {
        state: 'offered', last_offer_expires_at: new Date(Date.now() - 1000).toISOString(), missed_offer_count: 2,
      });
    }
    const r = await queue.reapStaleOffers(CONFIG as never);
    expect(r.missed).toBe(2);
    expect(callRow(missed.id).state).toBe('missed');
    expect(callRow(answered.id).state).toBe('active');
  });

  it('the sweep misses call-centre calls left pending for an hour, and leaves chat calls and fresh ones alone', async () => {
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    const stale = waitingCall({ created_at: old });
    const fresh = waitingCall();
    const chat = waitingCall({ created_at: old, entry_source: 'chat' });
    expect(await queue.sweepStalePendingCalls(CONFIG as never)).toBe(1);
    expect(callRow(stale.id).state).toBe('missed');
    expect(callRow(fresh.id).state).toBe('pending');
    expect(callRow(chat.id).state).toBe('pending');
  });

  it('a missed call no longer resumes: the visitor\'s status reads it as over', async () => {
    const call = waitingCall();
    await queue.missUnansweredCalls(CONFIG as never, { callIds: [call.id], reason: 'test' });
    const r = await site.get<{ call: Dict }>(`/api/call-widget/calls/${call.id}/status`, { 'x-cc-session': call.session });
    expect(r.status).toBe(200);
    expect(r.body.call.state).toBe('missed');
  });
});

describe('calls-3: /api/calls/:id/* on a call-centre call', () => {
  it('a viewer operates nothing (token, end, reject, accept)', async () => {
    const call = waitingCall();
    expect((await accept(A, call.id)).status).toBe(200);
    for (const path of ['token', 'end', 'hangup', 'reject', 'accept', 'invite']) {
      const r = await as(VIEWER, 'calls').post<Dict>(`/api/calls/${call.id}/${path}`, path === 'invite' ? { participant_type: 'operator' } : {});
      expect(r.status, path).toBe(403);
      expect(r.body.error, path).toBe('operator_permission_required');
    }
    expect(callRow(call.id).state).toBe('active');
  });

  it('another agent cannot end or reject a call A holds; a team lead can', async () => {
    const call = waitingCall();
    expect((await accept(A, call.id)).status).toBe(200);
    for (const path of ['end', 'reject']) {
      const r = await as(B, 'calls').post<Dict>(`/api/calls/${call.id}/${path}`, {});
      expect(r.status, path).toBe(403);
      expect(r.body.error, path).toBe('call_assigned_to_another_operator');
    }
    expect(callRow(call.id).state).toBe('active');
    expect((await as(LEAD, 'calls').post(`/api/calls/${call.id}/end`, {})).status).toBe(200);
    expect(callRow(call.id).state).toBe('ended');
  });

  it('accept and invite never revive an ended call; reject of it is refused and rewrites nothing', async () => {
    const call = waitingCall();
    expect((await accept(A, call.id)).status).toBe(200);
    expect((await as(A, 'calls').post(`/api/calls/${call.id}/end`, {})).status).toBe(200);
    const ended = { ...callRow(call.id) };
    for (const path of ['accept', 'invite', 'reject']) {
      const r = await as(A, 'calls').post<Dict>(`/api/calls/${call.id}/${path}`, path === 'invite' ? { participant_type: 'operator' } : {});
      expect(r.status, path).toBe(409);
    }
    expect(callRow(call.id)).toMatchObject({ state: 'ended', ended_at: ended.ended_at, started_at: ended.started_at });
  });

  it('calls-10: a recording stop names an egress of this call only', async () => {
    const call = waitingCall();
    expect((await accept(A, call.id)).status).toBe(200);
    callRow(call.id).metadata = { recording: { recording_id: 'EG_mine' } };
    db.call_recordings.push({ id: 'rec-1', call_session_id: 'another-call', provider_recording_id: 'EG_theirs' });
    const foreign = await as(A, 'calls').post<Dict>(`/api/calls/${call.id}/recording/stop`, { recording_id: 'EG_theirs' });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe('recording_not_found');
    expect(h.stopped).toEqual([]);
    const mine = await as(A, 'calls').post<Dict>(`/api/calls/${call.id}/recording/stop`, { recording_id: 'EG_mine' });
    expect(mine.status).toBe(200);
    expect(h.stopped).toEqual(['EG_mine']);
  });
});

describe('calls-5: two operators accepting the same call', () => {
  it('both read it unassigned: the second claim loses (409, no token), and the call stays the first one\'s', async () => {
    const call = waitingCall();
    const before = { ...callRow(call.id) };
    expect((await accept(A, call.id)).status).toBe(200);
    // B's accept read the call before A's claim landed.
    stale.row = before;
    const b = await accept(B, call.id);
    expect(b.status).toBe(409);
    expect(b.body.error).toBe('call_already_accepted');
    expect(b.text).not.toContain('token');
    expect(callRow(call.id)).toMatchObject({ state: 'active', assigned_agent_id: A });
    expect(countOf(A)).toBe(1);
    expect(countOf(B)).toBe(0);
  });

  it('at the same moment: one gets it, the other is refused without a token', async () => {
    const call = waitingCall();
    const [a, b] = await Promise.all([accept(A, call.id), accept(B, call.id)]);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    const winner = a.status === 200 ? A : B;
    const loser = a.status === 200 ? b : a;
    expect([403, 409]).toContain(loser.status);
    expect(loser.text).not.toContain('token');
    expect(callRow(call.id)).toMatchObject({ state: 'active', assigned_agent_id: winner });
  });

  it('the same operator accepting again (Reconnect) still gets the call', async () => {
    const call = waitingCall();
    expect((await accept(A, call.id)).status).toBe(200);
    expect((await accept(A, call.id)).status).toBe(200);
    expect(countOf(A)).toBe(1);
  });
});

describe('calls-6: the active call count follows the calls an operator holds', () => {
  it('the visitor hanging up releases the operator, and the console\'s late /end (409) leaves them released', async () => {
    const call = waitingCall();
    expect((await accept(A, call.id)).status).toBe(200);
    expect(countOf(A)).toBe(1);
    expect((await site.post(`/api/call-widget/calls/${call.id}/cancel`, {}, { 'x-cc-session': call.session })).status).toBe(200);
    expect(countOf(A)).toBe(0);
    const late = await as(A, 'call-center').post<Dict>(`/api/call-center/calls/${call.id}/end?workspaceId=${WS}`, {});
    expect(late.status).toBe(409);
    expect(countOf(A)).toBe(0);
  });

  it('a count that drifted is put right on the operator\'s next call', async () => {
    db.call_center_agent_presence.find((p) => p.user_id === A)!.active_call_count = 7;
    const call = waitingCall();
    expect((await accept(A, call.id)).status).toBe(200);
    expect(countOf(A)).toBe(1);
  });
});

describe('calls-8: assign and transfer follow the takeover rule', () => {
  it('a plain agent cannot take or move a call another operator holds; a team lead can', async () => {
    const call = waitingCall();
    expect((await accept(A, call.id)).status).toBe(200);
    const assign = await as(B, 'call-center').post<Dict>(`/api/call-center/calls/${call.id}/assign?workspaceId=${WS}`, { agent_id: B });
    expect(assign.status).toBe(403);
    const transfer = await as(B, 'call-center').post<Dict>(`/api/call-center/calls/${call.id}/transfer?workspaceId=${WS}`, { to_agent_id: B });
    expect(transfer.status).toBe(403);
    expect(callRow(call.id).assigned_agent_id).toBe(A);
    const byLead = await as(LEAD, 'call-center').post<Dict>(`/api/call-center/calls/${call.id}/transfer?workspaceId=${WS}`, { to_agent_id: B });
    expect(byLead.status).toBe(200);
    expect(callRow(call.id).assigned_agent_id).toBe(B);
    expect(countOf(A)).toBe(0);
    expect(countOf(B)).toBe(1);
  });

  it('the operator holding the call may transfer it, and anyone may route an unassigned one', async () => {
    const held = waitingCall();
    expect((await accept(A, held.id)).status).toBe(200);
    expect((await as(A, 'call-center').post(`/api/call-center/calls/${held.id}/transfer?workspaceId=${WS}`, { to_agent_id: B })).status).toBe(200);
    const open = waitingCall();
    expect((await as(B, 'call-center').post(`/api/call-center/calls/${open.id}/assign?workspaceId=${WS}`, { agent_id: B })).status).toBe(200);
  });
});

describe('calls-9: the visitor\'s cancel ends the call properly, once', () => {
  it('closes the room, frees the operator, and a second cancel moves nothing', async () => {
    const call = waitingCall();
    expect((await accept(A, call.id)).status).toBe(200);
    callRow(call.id).connected_at = new Date(Date.now() - 30_000).toISOString();
    h.closed.length = 0;
    const first = await site.post<Dict>(`/api/call-widget/calls/${call.id}/cancel`, {}, { 'x-cc-session': call.session });
    expect(first.status).toBe(200);
    const ended = { ...callRow(call.id) };
    expect(ended).toMatchObject({ state: 'ended', ended_by: 'visitor', end_reason: 'visitor_ended' });
    expect(h.closed).toEqual([`room-${call.id}`]);
    await new Promise((r) => setTimeout(r, 5));
    const again = await site.post<Dict>(`/api/call-widget/calls/${call.id}/cancel`, {}, { 'x-cc-session': call.session });
    expect(again.status).toBe(200);
    expect(again.body.already).toBe(true);
    expect(callRow(call.id)).toMatchObject({ ended_at: ended.ended_at, duration_seconds: ended.duration_seconds });
  });

  it('a cancel after the operator ended the call keeps the operator\'s end', async () => {
    const call = waitingCall();
    expect((await accept(A, call.id)).status).toBe(200);
    expect((await as(A, 'call-center').post(`/api/call-center/calls/${call.id}/end?workspaceId=${WS}`, {})).status).toBe(200);
    const ended = { ...callRow(call.id) };
    expect((await site.post(`/api/call-widget/calls/${call.id}/cancel`, {}, { 'x-cc-session': call.session })).status).toBe(200);
    expect(callRow(call.id)).toMatchObject({ state: 'ended', ended_by: 'operator', ended_at: ended.ended_at });
  });
});

describe('calls-7: the queue routes act on their own workspace only', () => {
  beforeEach(() => {
    db.role_permissions = [
      { workspace_id: null, role_slug: 'agent', permission_key: 'can_join_queue_calls', granted: true },
      { workspace_id: null, role_slug: 'agent', permission_key: 'can_manage_call_queue', granted: false },
      { workspace_id: null, role_slug: 'viewer', permission_key: 'can_join_queue_calls', granted: false },
    ];
  });

  it('an entry of another workspace is not found, and stays as it was', async () => {
    db.call_queue_entries.push({ id: 'qe-other', workspace_id: OTHER_WS, state: 'queued', channel: 'audio', expires_at: new Date(Date.now() + 60_000).toISOString() });
    for (const path of ['accept', 'cancel']) {
      const r = await as(A, 'call-queue').post<Dict>(`/api/call-queue/${WS}/qe-other/${path}`, {});
      expect(r.status, path).toBe(404);
    }
    expect(db.call_queue_entries.find((e) => e.id === 'qe-other')!.state).toBe('queued');
  });

  it('a role without queue permissions accepts and cancels nothing', async () => {
    const call = waitingCall();
    const entry = `qe-${call.id}`;
    expect((await as(VIEWER, 'call-queue').post(`/api/call-queue/${WS}/${entry}/accept`, {})).status).toBe(403);
    // An agent may not dismiss an entry that is not offered to them.
    expect((await as(A, 'call-queue').post(`/api/call-queue/${WS}/${entry}/cancel`, {})).status).toBe(403);
    expect(db.call_queue_entries.find((e) => e.id === entry)!.state).toBe('queued');
  });

  it('markEntryAsCallback ends only the visitor\'s own entry of the token\'s workspace', async () => {
    db.call_queue_entries.push(
      { id: 'qe-cb-other-ws', workspace_id: OTHER_WS, state: 'queued', visitor_session_id: 'vs-1' },
      { id: 'qe-cb-other-visitor', workspace_id: WS, state: 'queued', visitor_session_id: 'vs-2' },
      { id: 'qe-cb-mine', workspace_id: WS, state: 'queued', visitor_session_id: 'vs-1' },
    );
    for (const id of ['qe-cb-other-ws', 'qe-cb-other-visitor', 'qe-cb-mine']) {
      await queue.markEntryAsCallback(CONFIG as never, id, 'cb-1', { workspaceId: WS, visitorSessionIds: ['vs-1'] });
    }
    const states = Object.fromEntries(db.call_queue_entries.filter((e) => String(e.id).startsWith('qe-cb-')).map((e) => [e.id, e.state]));
    expect(states).toEqual({ 'qe-cb-other-ws': 'queued', 'qe-cb-other-visitor': 'queued', 'qe-cb-mine': 'callback_requested' });
  });
});

describe('calls-4: a visitor\'s call requests have limits of their own', () => {
  it('per visitor: no second new call within the gap, at most the hourly cap', () => {
    const t0 = Date.parse('2026-11-04T10:00:00Z');
    expect(limiter.takeCallRequest('ws:v1', null, t0).ok).toBe(true);
    const tooSoon = limiter.takeCallRequest('ws:v1', null, t0 + 1000);
    expect(tooSoon.ok).toBe(false);
    let t = t0;
    let made = 1;
    for (let i = 0; i < 20; i++) {
      t += limiter.VISITOR_MIN_GAP_MS;
      if (limiter.takeCallRequest('ws:v1', null, t).ok) made++;
    }
    expect(made).toBe(limiter.VISITOR_PER_HOUR);
    // An hour after the first, there is room again.
    expect(limiter.takeCallRequest('ws:v1', null, t0 + 3600_000 + 1).ok).toBe(true);
  });

  it('per address, whatever visitor ids it shows', () => {
    const t0 = Date.parse('2026-11-04T10:00:00Z');
    let made = 0;
    for (let i = 0; i < 20; i++) if (limiter.takeCallRequest(`ws:v${i}`, '203.0.113.9', t0 + i).ok) made++;
    expect(made).toBe(limiter.IP_PER_10_MIN);
    expect(limiter.takeCallRequest('ws:fresh', '198.51.100.1', t0).ok).toBe(true);
  });

  it('a request given back does not count; phones ring once per visitor within the quiet window', () => {
    const t0 = Date.parse('2026-11-04T10:00:00Z');
    const first = limiter.takeCallRequest('ws:v1', '203.0.113.9', t0);
    if (!first.ok) throw new Error('expected a share');
    limiter.giveBackCallRequest(first.ticket);
    expect(limiter.takeCallRequest('ws:v1', '203.0.113.9', t0 + 10).ok).toBe(true);
    expect(limiter.mayRingForVisitor('ws:v1', t0)).toBe(true);
    expect(limiter.mayRingForVisitor('ws:v1', t0 + 30_000)).toBe(false);
    expect(limiter.mayRingForVisitor('ws:v1', t0 + limiter.RING_QUIET_MS + 1)).toBe(true);
    expect(limiter.mayRingForVisitor(null, t0)).toBe(true);
  });
});

describe('calls-4: through POST /api/call-widget/calls/request', () => {
  const visitorSession = () => signWidgetSession(CONFIG as never, { workspace_id: WS, public_key: 'cck_x', origin: ORIGIN });
  const request = () => site.post<Dict>('/api/call-widget/calls/request', { call_type: 'voice' }, { 'x-cc-session': visitorSession() });

  beforeEach(() => {
    Object.assign(db.platform_call_center_settings[0], {
      voice_calls_enabled: true, video_calls_enabled: true, max_concurrent_calls_per_workspace: 50, max_queue_size_per_workspace: 50,
    });
    Object.assign(db.call_center_settings[0], { voice_enabled: true, video_enabled: true });
    invalidatePlatformCallCenterCache();
  });

  it('the same visitor calling, cancelling and calling again rings the phones once; past the limits, 429 and nothing made', async () => {
    site.clearCookies();
    const first = await request();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.status).toBe('queued');
    const firstCall = String(first.body.call_id);
    await site.post(`/api/call-widget/calls/${firstCall}/cancel`, {}, { 'x-cc-session': String(first.body.session) });

    await new Promise((r) => setTimeout(r, limiter.VISITOR_MIN_GAP_MS + 50));
    const second = await request();
    expect(second.status).toBe(200);
    expect(second.body.call_id).not.toBe(firstCall);
    // Queued (the console shows it), but the phones rang for the first one only.
    expect(h.rung).toEqual([firstCall]);

    // Straight away again: too soon for this visitor.
    await site.post(`/api/call-widget/calls/${String(second.body.call_id)}/cancel`, {}, { 'x-cc-session': String(second.body.session) });
    const made = db.call_sessions.length;
    const third = await request();
    expect(third.status).toBe(429);
    expect(third.body.error).toBe('too_many_call_requests');
    expect(Number(third.body.retry_after)).toBeGreaterThan(0);
    expect(db.call_sessions.length).toBe(made);
  }, 15_000);
});
