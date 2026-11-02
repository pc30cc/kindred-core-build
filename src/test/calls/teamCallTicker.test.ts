// @vitest-environment node
/**
 * The colleague calls' clock (server/services/teamCallTicker.ts).
 *
 * The ring's end: a colleague call still ringing 45 s after it was placed is
 * missed — the rung Android phones stop, both members hear it, the callee
 * gets the missed-call notification — and nothing else is touched, nor
 * anything missed twice.
 *
 * The room check: an answered call whose end never reached the server (both
 * apps gone, the webhook lost) is held against its room as the provider lists
 * it, and ends when a member or the room is gone; one the provider cannot be
 * asked about is left alone, unless it never got past connecting.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb, type FakeDb } from './teamCallTestDb';

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  leased: true,
  fcm: [] as Array<{ token: string; data: Record<string, string> }>,
  voip: [] as unknown[],
  missed: [] as Array<Record<string, unknown>>,
  published: [] as Array<{ users: readonly string[]; payload: Record<string, unknown> }>,
  closed: [] as string[],
  /** The identities each room lists; a room missing here is gone. */
  rooms: {} as Record<string, string[]>,
  listed: [] as string[],
  listFails: false,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => h.db }));
vi.mock('../../../server/services/observability/tickerLease.js', () => ({
  acquireTickerLease: async () => h.leased,
  releaseTickerLease: async () => {},
}));
vi.mock('../../../server/services/calls/providerResolver.js', () => ({
  resolveCallProvider: () => ({
    closeRoom: async (_c: unknown, id: string) => { h.closed.push(id); },
    listRoomIdentities: async (_c: unknown, room: string) => {
      h.listed.push(room);
      if (h.listFails) throw new Error('LiveKit Twirp request timed out');
      return h.rooms[room] ?? [];
    },
  }),
}));
vi.mock('../../../server/services/push/fcm.js', () => ({
  isPushConfigured: () => true,
  sendFcmData: async (m: { token: string; data: Record<string, string> }) => { h.fcm.push(m); return { ok: true }; },
}));
vi.mock('../../../server/services/push/apnsVoip.js', () => ({
  isVoipConfigured: () => true,
  sendVoipPush: async (m: unknown) => { h.voip.push(m); return { ok: true }; },
}));
vi.mock('../../../server/services/push/dispatch.js', () => ({
  notifyTeamCallMissed: async (_c: unknown, input: Record<string, unknown>) => { h.missed.push(input); },
}));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishTeamEvent: async (_c: unknown, users: readonly string[], payload: Record<string, unknown>) => { h.published.push({ users, payload }); },
}));

const { runTeamCallTickOnce, runTeamCallRoomCheckOnce } = await import('../../../server/services/teamCallTicker.js');
const { operatorReference } = await import('../../../server/services/calls/operatorIdentity.js');

const config = { supabaseUrl: 'http://db.test', supabaseServiceRoleKey: 'service-key', signingSecret: 'signing-secret' } as never;
const WS = '11111111-1111-4111-8111-111111111111';
const CALLER = '22222222-2222-4222-8222-222222222222';
const CALLEE = '33333333-3333-4333-8333-333333333333';

function call(id: string, state: string, secondsAgo: number, entrySource = 'team_call') {
  h.db.tables.call_sessions.push({
    id, workspace_id: WS, provider: 'livekit', provider_room_id: `room-${id}`, call_type: 'video', state,
    entry_source: entrySource, initiated_by: CALLER, context_type: 'internal', context_id: null,
    created_at: new Date(Date.now() - secondsAgo * 1000).toISOString(), connected_at: null, ended_at: null,
    metadata: { team_call: {
      caller_user_id: CALLER, callee_user_id: CALLEE, channel: 'video', outcome: null,
      answered_device_id: null, answered_at: null,
      rung_android_device_ids: ['android-install-1'], rung_ios_device_ids: ['ios-install'],
    } },
  });
}
const byId = (id: string) => h.db.tables.call_sessions.find((r) => r.id === id) as Record<string, unknown>;

/** A colleague call answered on the callee's first Android phone [answeredSecondsAgo] ago. */
function answered(id: string, state: 'connecting' | 'active', answeredSecondsAgo: number): void {
  call(id, state, answeredSecondsAgo + 10);
  const row = byId(id);
  row.connected_at = new Date(Date.now() - answeredSecondsAgo * 1000).toISOString();
  (row.metadata as Record<string, Record<string, unknown>>).team_call.answered_device_id = 'android-install-1';
}
/** A member's identity in the room of call [id]: `internal:<opaque ref>`. */
const identity = (id: string, userId: string) => `internal:${operatorReference(config, id, userId)}`;
const both = (id: string) => [identity(id, CALLER), identity(id, CALLEE)];

beforeEach(() => {
  h.db = createFakeDb();
  h.db.tables.call_sessions = [];
  h.db.tables.mobile_push_devices = [
    { id: 'd1', user_id: CALLEE, platform: 'android', transport: 'fcm', push_token: 'fcm-1', device_id: 'android-install-1', enabled: true },
    { id: 'd2', user_id: CALLEE, platform: 'ios', transport: 'apns', push_token: 'apns-1', voip_token: 'voip-1', device_id: 'ios-install', enabled: true },
  ];
  h.leased = true;
  h.rooms = {};
  h.listFails = false;
  for (const list of [h.fcm, h.voip, h.missed, h.published, h.closed, h.listed]) list.length = 0;
});

describe('team call ticker', () => {
  it('misses a call that rang its whole ring, and only that one', async () => {
    call('expired', 'ringing', 46);
    call('fresh', 'ringing', 10);
    call('answered', 'connecting', 120);
    call('chat', 'ringing', 120, 'chat');

    const pass = await runTeamCallTickOnce(config);
    expect(pass).toEqual({ due: 1, missed: 1 });

    expect(byId('expired')).toMatchObject({ state: 'missed', ended_by: 'system', end_reason: 'system_ended', duration_seconds: 0 });
    expect((byId('expired').metadata as Record<string, Record<string, unknown>>).team_call.outcome).toBe('missed');
    expect(byId('expired').ended_at).toBeTruthy();
    expect(byId('fresh').state).toBe('ringing');
    expect(byId('answered').state).toBe('connecting');
    expect(byId('chat').state).toBe('ringing');

    // Its effects are done when the pass is.
    expect(h.fcm).toEqual([expect.objectContaining({ token: 'fcm-1', data: { type: 'team_call_cancel', callId: 'expired', reason: 'missed' } })]);
    expect(h.voip).toHaveLength(0);
    expect(h.missed).toEqual([{ workspaceId: WS, callerId: CALLER, calleeId: CALLEE, callId: 'expired', channel: 'video' }]);
    expect(h.published.filter((p) => p.payload.kind === 'team_call')).toEqual([{ users: [CALLER, CALLEE], payload: { kind: 'team_call', workspace_id: WS, call_id: 'expired', state: 'missed', outcome: 'missed' } }]);
    expect(h.closed).toEqual(['room-expired']);
    // Its line in the team chat, unread for the callee (teamCallChat.test.ts has the rest).
    expect(h.db.tables.team_messages).toEqual([expect.objectContaining({ call_session_id: 'expired', sender_id: CALLER, recipient_id: CALLEE, read_at: null })]);
    expect(h.published.filter((p) => p.payload.kind === 'team_message')).toHaveLength(1);
  });

  it('never misses a call twice', async () => {
    call('expired', 'ringing', 50);
    await runTeamCallTickOnce(config);
    expect(await runTeamCallTickOnce(config)).toEqual({ due: 0, missed: 0 });
    expect(h.missed).toHaveLength(1);
  });

  it('does nothing without the lease', async () => {
    call('expired', 'ringing', 50);
    h.leased = false;
    expect(await runTeamCallTickOnce(config)).toEqual({ due: 0, missed: 0 });
    expect(byId('expired').state).toBe('ringing');
  });

  it('survives an unreadable table', async () => {
    call('expired', 'ringing', 50);
    h.db.failNext('call_sessions');
    expect(await runTeamCallTickOnce(config)).toEqual({ due: 0, missed: 0 });
    expect(byId('expired').state).toBe('ringing');
  });
});

describe('team call room check', () => {
  it('leaves a call both members are in, and makes one still connecting active', async () => {
    answered('talking', 'active', 600);
    answered('joining', 'connecting', 120);
    h.rooms = { 'room-talking': both('talking'), 'room-joining': [...both('joining'), 'visitor:someone-else'] };

    expect(await runTeamCallRoomCheckOnce(config)).toEqual({ checked: 2, activated: 1, ended: 0 });
    expect(byId('talking').state).toBe('active');
    expect(byId('joining').state).toBe('active');
    expect(h.published).toEqual([{ users: [CALLER, CALLEE], payload: { kind: 'team_call', workspace_id: WS, call_id: 'joining', state: 'active', outcome: null } }]);
    expect(h.fcm).toHaveLength(0);
  });

  it('ends a call a member left, or whose room is gone, for both (completed)', async () => {
    answered('alone', 'active', 600);
    answered('gone', 'connecting', 120);
    h.rooms = { 'room-alone': [identity('alone', CALLER)] };

    expect(await runTeamCallRoomCheckOnce(config)).toEqual({ checked: 2, activated: 0, ended: 2 });
    for (const id of ['alone', 'gone']) {
      expect(byId(id)).toMatchObject({ state: 'ended', ended_by: 'system', end_reason: 'system_ended' });
      expect((byId(id).metadata as Record<string, Record<string, unknown>>).team_call.outcome).toBe('completed');
      expect(byId(id).duration_seconds as number).toBeGreaterThan(0);
    }
    expect(h.closed.sort()).toEqual(['room-alone', 'room-gone']);
    // The one Android phone rung is the one that answered: no stop to send. No missed alert.
    expect(h.fcm).toEqual([]);
    expect(h.missed).toHaveLength(0);
    expect(h.published.filter((p) => p.payload.kind === 'team_call').map((p) => p.payload.state)).toEqual(['ended', 'ended']);
    expect((h.db.tables.team_messages ?? []).map((m) => m.call_session_id).sort()).toEqual(['alone', 'gone']);
  });

  it('does not look at an answer younger than the grace, nor at a call that is not answered or not a colleague call', async () => {
    answered('fresh', 'connecting', 30);
    call('ringing', 'ringing', 10);
    answered('chat', 'active', 600);
    byId('chat').entry_source = 'chat';
    expect(await runTeamCallRoomCheckOnce(config)).toEqual({ checked: 0, activated: 0, ended: 0 });
    expect(h.listed).toEqual([]);
    expect(byId('fresh').state).toBe('connecting');
  });

  it('a provider that cannot be asked decides nothing, but a call that never got past connecting ends', async () => {
    answered('talking', 'active', 3600);
    answered('waiting', 'connecting', 120);
    answered('stuck', 'connecting', 6 * 60);
    h.listFails = true;

    expect(await runTeamCallRoomCheckOnce(config)).toEqual({ checked: 3, activated: 0, ended: 1 });
    // Asked once in the pass, not once per call.
    expect(h.listed).toHaveLength(1);
    expect(byId('talking').state).toBe('active');
    expect(byId('waiting').state).toBe('connecting');
    expect(byId('stuck')).toMatchObject({ state: 'ended', end_reason: 'system_ended' });
  });

  it('never ends a call twice, and does nothing without the lease', async () => {
    answered('alone', 'active', 600);
    h.leased = false;
    expect(await runTeamCallRoomCheckOnce(config)).toEqual({ checked: 0, activated: 0, ended: 0 });
    expect(byId('alone').state).toBe('active');
    h.leased = true;
    await runTeamCallRoomCheckOnce(config);
    expect(await runTeamCallRoomCheckOnce(config)).toEqual({ checked: 0, activated: 0, ended: 0 });
    expect(h.closed).toEqual(['room-alone']);
  });

  it('survives an unreadable table', async () => {
    answered('alone', 'active', 600);
    h.db.failNext('call_sessions');
    expect(await runTeamCallRoomCheckOnce(config)).toEqual({ checked: 0, activated: 0, ended: 0 });
    expect(byId('alone').state).toBe('active');
  });
});
