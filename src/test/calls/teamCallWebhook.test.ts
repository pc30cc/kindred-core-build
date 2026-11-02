// @vitest-environment node
/**
 * The LiveKit webhook's rules for colleague calls (docs/operations/
 * TEAM_CALLS.md): its room is made while it rings, so `room_started` changes
 * nothing; it is active once both members are in; a member leaving after the
 * answer ends it — but not a connection the same member's rejoin replaced —
 * even when it races the call becoming active; and the room finishing never
 * rewrites a call that is over.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb, type FakeDb, type Row } from './teamCallTestDb';

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  fcm: [] as Array<{ token: string; data: Record<string, string> }>,
  voip: [] as unknown[],
  missed: [] as unknown[],
  published: [] as Array<Record<string, unknown>>,
  closed: [] as string[],
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => h.db }));
vi.mock('../../../server/services/calls/availability.js', () => ({ markInCall: async () => {}, clearInCall: async () => {} }));
vi.mock('../../../server/services/calls/metrics.js', () => ({ emitCallMetric: () => {} }));
vi.mock('../../../server/services/calls/providerResolver.js', () => ({
  resolveCallProvider: () => ({ closeRoom: async (_c: unknown, id: string) => { h.closed.push(id); } }),
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
  notifyTeamCallMissed: async (_c: unknown, input: unknown) => { h.missed.push(input); },
}));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishTeamEvent: async (_c: unknown, _users: unknown, payload: Record<string, unknown>) => { h.published.push(payload); },
}));

const { applyEvent } = await import('../../../server/routes/livekitWebhook.js');
const { operatorReference } = await import('../../../server/services/calls/operatorIdentity.js');

const config = { supabaseUrl: 'http://db.test', supabaseServiceRoleKey: 'service-key', signingSecret: 'signing-secret' } as never;
const WS = '11111111-1111-4111-8111-111111111111';
const CALLER = '22222222-2222-4222-8222-222222222222';
const CALLEE = '33333333-3333-4333-8333-333333333333';
const CALL = '99999999-9999-4999-8999-999999999999';
const ROOM = `ws_${WS}_call_${CALL}`;

function teamCall(state: string, extra: Row = {}): void {
  h.db.tables.call_sessions = [{
    id: CALL, workspace_id: WS, provider: 'livekit', provider_room_id: ROOM, call_type: 'audio', state,
    entry_source: 'team_call', context_type: 'internal', context_id: null, initiated_by: CALLER,
    created_at: new Date(Date.now() - 20_000).toISOString(),
    connected_at: state === 'ringing' ? null : new Date(Date.now() - 10_000).toISOString(),
    ended_at: null, started_at: null,
    metadata: { team_call: {
      caller_user_id: CALLER, callee_user_id: CALLEE, channel: 'audio', outcome: null,
      answered_device_id: state === 'ringing' ? null : 'android-install-1', answered_at: null,
      rung_android_device_ids: ['android-install-1', 'android-install-2'], rung_ios_device_ids: [],
    } },
    ...extra,
  }];
}

const identity = (userId: string) => `internal:${operatorReference(config, CALL, userId)}`;
const event = (name: string, userId?: string, participant: Record<string, unknown> = {}) => ({
  event: name,
  id: `${name}-${userId ?? 'room'}-${Math.random()}`,
  room: { name: ROOM, metadata: JSON.stringify({ workspace_id: WS, call_session_id: CALL }), creationTime: Math.floor(Date.now() / 1000) },
  ...(userId ? { participant: { identity: identity(userId), sid: `PA_${userId.slice(0, 4)}`, ...participant } } : {}),
});
const row = () => h.db.tables.call_sessions[0];
const outcome = () => ((row().metadata as Record<string, Record<string, unknown>>).team_call.outcome);

beforeEach(() => {
  h.db = createFakeDb();
  h.db.tables.workspace_members = [
    { workspace_id: WS, user_id: CALLER, suspended_at: null },
    { workspace_id: WS, user_id: CALLEE, suspended_at: null },
  ];
  h.db.tables.mobile_push_devices = [
    { id: 'd1', user_id: CALLEE, platform: 'android', transport: 'fcm', push_token: 'fcm-1', device_id: 'android-install-1', enabled: true },
    { id: 'd2', user_id: CALLEE, platform: 'android', transport: 'fcm', push_token: 'fcm-2', device_id: 'android-install-2', enabled: true },
  ];
  for (const list of [h.fcm, h.voip, h.missed, h.published, h.closed]) list.length = 0;
});

describe('LiveKit webhook — colleague calls', () => {
  it('room_started changes nothing: the room exists while it rings', async () => {
    teamCall('ringing');
    expect(await applyEvent(config, event('room_started'))).toEqual({ applied: true });
    expect(row().state).toBe('ringing');
    expect(row().started_at).toBeNull();
  });

  it('participant_joined makes an answered call active once both members are in', async () => {
    teamCall('connecting');
    await applyEvent(config, event('participant_joined', CALLEE));
    expect(row().state).toBe('connecting');
    // The member is recorded, resolved back from the opaque identity.
    expect(h.db.tables.call_participants).toEqual([expect.objectContaining({ participant_id: CALLEE, provider_participant_id: identity(CALLEE) })]);
    await applyEvent(config, event('participant_joined', CALLER));
    expect(row().state).toBe('active');
    expect(h.published.at(-1)).toMatchObject({ kind: 'team_call', call_id: CALL, state: 'active' });
  });

  it('participant_left after the answer ends the call for both (completed)', async () => {
    teamCall('active');
    await applyEvent(config, event('participant_joined', CALLER));
    await applyEvent(config, event('participant_left', CALLER));
    expect(row().state).toBe('ended');
    expect(outcome()).toBe('completed');
    expect(row()).toMatchObject({ ended_by: 'system', end_reason: 'system_ended' });
    // The rung phones but the one that answered are told once more; no VoIP.
    expect(h.fcm.map((m) => [m.token, m.data.reason])).toEqual([['fcm-2', 'ended']]);
    expect(h.voip).toHaveLength(0);
    expect(h.published.filter((p) => p.kind === 'team_call').at(-1)).toMatchObject({ state: 'ended', outcome: 'completed' });
    expect(h.missed).toHaveLength(0);
    // The call's one line in the team chat.
    expect(h.db.tables.team_messages).toEqual([expect.objectContaining({ call_session_id: CALL, sender_id: CALLER, recipient_id: CALLEE })]);
  });

  it('a connection replaced by the same member rejoining is not the member leaving', async () => {
    teamCall('active');
    await applyEvent(config, event('participant_joined', CALLER));
    await applyEvent(config, event('participant_joined', CALLEE));
    // The callee's phone reconnected in full: LiveKit drops the old connection
    // of the same identity, possibly after the new one's join was seen.
    for (const disconnectReason of ['DUPLICATE_IDENTITY', 2]) {
      expect(await applyEvent(config, event('participant_left', CALLEE, { sid: 'PA_old', disconnectReason }))).toEqual({ applied: true });
      expect(row().state).toBe('active');
      expect(h.db.tables.call_participants.find((p) => p.participant_id === CALLEE)?.left_at ?? null).toBeNull();
    }
    expect(h.fcm).toHaveLength(0);
    expect(h.closed).toHaveLength(0);
    // Logged all the same.
    expect(h.db.tables.call_events.filter((e) => e.event_type === 'lk.participant_left')).toHaveLength(2);

    // Any other reason is the member leaving.
    await applyEvent(config, event('participant_left', CALLEE, { disconnectReason: 'CLIENT_INITIATED' }));
    expect(row().state).toBe('ended');
  });

  it('a member leaving at the moment the call became active still ends it', async () => {
    teamCall('connecting');
    // The other member's participant_joined wins the race: the row turns
    // active between the end's read and its compare-and-set.
    const from = h.db.from.bind(h.db);
    let raced = false;
    h.db.from = (table: string) => {
      const builder = from(table) as Record<string, (...args: unknown[]) => unknown>;
      if (table !== 'call_sessions' || raced) return builder;
      const update = builder.update;
      builder.update = (values: unknown) => {
        if ((values as Row).state === 'ended') {
          raced = true;
          row().state = 'active';
        }
        return update(values);
      };
      return builder;
    };
    await applyEvent(config, event('participant_left', CALLER));
    expect(raced).toBe(true);
    expect(row().state).toBe('ended');
    expect(outcome()).toBe('completed');
    expect(h.published.filter((p) => p.kind === 'team_call').at(-1)).toMatchObject({ state: 'ended', outcome: 'completed' });
  });

  it('participant_left before the answer changes nothing', async () => {
    teamCall('ringing');
    await applyEvent(config, event('participant_left', CALLER));
    expect(row().state).toBe('ringing');
  });

  it('room_finished completes an answered call and never rewrites an ended one', async () => {
    teamCall('connecting');
    await applyEvent(config, event('room_finished'));
    expect(row().state).toBe('ended');
    expect(outcome()).toBe('completed');

    for (const [state, kept] of [['missed', 'missed'], ['cancelled', 'cancelled']] as const) {
      teamCall(state, { ended_at: '2026-11-01T10:00:00.000Z', metadata: { team_call: { caller_user_id: CALLER, callee_user_id: CALLEE, channel: 'audio', outcome: kept } } });
      await applyEvent(config, event('room_finished'));
      expect(row().state).toBe(state);
      expect(row().ended_at).toBe('2026-11-01T10:00:00.000Z');
      expect(outcome()).toBe(kept);
    }

    teamCall('ringing');
    await applyEvent(config, event('room_finished'));
    expect(row().state).toBe('ringing');
  });

  it('a room that comes back after its call is over is closed at once, and counts nothing', async () => {
    // A member kept a token and joined again: LiveKit made the room anew.
    for (const state of ['ended', 'missed', 'cancelled']) {
      teamCall(state, { ended_at: '2026-11-01T10:00:00.000Z' });
      h.closed.length = 0;
      await applyEvent(config, event('room_started'));
      expect(h.closed).toEqual([ROOM]);
      h.closed.length = 0;
      await applyEvent(config, event('participant_joined', CALLER));
      expect(h.closed).toEqual([ROOM]);
      expect(row().state).toBe(state);
      expect(row().ended_at).toBe('2026-11-01T10:00:00.000Z');
    }
    // A live call keeps its room.
    for (const state of ['ringing', 'connecting', 'active']) {
      teamCall(state);
      h.closed.length = 0;
      await applyEvent(config, event('room_started'));
      await applyEvent(config, event('participant_joined', CALLER));
      expect(h.closed).toEqual([]);
    }
  });

  it('any other call keeps the generic rules', async () => {
    teamCall('ringing', { entry_source: 'chat' });
    await applyEvent(config, event('room_started'));
    expect(row().state).toBe('active');
  });
});
