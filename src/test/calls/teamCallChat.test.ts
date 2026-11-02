// @vitest-environment node
/**
 * The call in the chat (owner, 2026-11-02; docs/operations/TEAM_CALLS.md,
 * "The call in the chat"): every colleague call leaves one line in the two
 * members' team chat, and the team-chat reads say which call a line is.
 *
 *   - the line is written once, at the call's end, whichever path ended it
 *     (decline, cancel, hang-up, the ring running out, a failure), from the
 *     caller to the callee, where the call rang, unread for the callee only
 *     when they missed it, with a body the older apps can read;
 *   - never while the call is live; a second attempt writes nothing and
 *     nudges no one; a database without migration 294 only logs, and the
 *     call's own move stands;
 *   - both members get the `team_message` nudge, and no team-message push;
 *   - GET /thread and /colleagues carry `call` (id, channel, outcome,
 *     duration, caller and nothing else), null for every other message and
 *     for a line whose call does not match it, and still answer without the
 *     column; POST /messages cannot set it.
 *
 * The routes, the lifecycle and the line's writer run for real against the
 * in-memory database of the other colleague-call suites; the plan, the
 * provider and the transports are stand-ins that record.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createFakeDb, type FakeDb, type Row } from './teamCallTestDb';

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  missed: [] as Array<Record<string, unknown> & { lineWritten: boolean }>,
  published: [] as Array<{ users: readonly string[]; payload: Record<string, unknown> }>,
  teamPushes: [] as Array<Record<string, unknown>>,
  roomFails: false,
  /** A realtime server that takes its time: the line's nudge never settles. */
  holdNudges: false,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => h.db }));
vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  requireUser: async (req: { headers: Record<string, string | undefined> }, res: { status(c: number): { json(b: unknown): unknown } }) => {
    const id = req.headers['x-test-user'];
    if (!id) {
      res.status(401).json({ error: 'Not authenticated' });
      return null;
    }
    return id;
  },
  authorizeWorkspaceAccess: async (req: { headers: Record<string, string | undefined> }) => ({ userId: req.headers['x-test-user'], isAdmin: false, role: 'agent' }),
  serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
  isSeatLocked: async () => false,
}));
vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkEntitlementFromDB: async () => ({ allowed: true, reason: 'plan' }),
}));
vi.mock('../../../server/services/calls/entitlementComposer.js', () => ({
  loadEffectiveCallEntitlements: async () => ({
    voice_enabled: true, video_enabled: true,
    plan: { voice_video: true, voice: true, video: true },
    runtime: {},
  }),
}));
vi.mock('../../../server/services/calls/concurrencyLimit.js', () => ({
  checkPlanConcurrencyCeiling: async () => ({ allowed: true, limit: -1 }),
  planConcurrencyDenialBody: () => ({}),
}));
vi.mock('../../../server/services/calls/monthlyMinutesLimit.js', () => ({
  checkPlanMonthlyMinutesCeiling: async () => ({ allowed: true, limit: -1 }),
  planMinutesDenialBody: () => ({}),
}));
vi.mock('../../../server/services/calls/providerResolver.js', () => {
  const provider = {
    createRoom: async (_c: unknown, input: Record<string, unknown>) => {
      if (h.roomFails) throw new Error('twirp down');
      return { providerRoomId: `room-${String(input.callSessionId)}`, metadata: {} };
    },
    closeRoom: async () => {},
    createParticipantToken: async () => ({ token: 'lk-token', expiresAt: 1_900_000_000, identity: 'internal:0123456789abcdef' }),
    getRoomState: async () => null,
    supportsRecording: () => false,
  };
  return {
    resolveEffectiveCallProvider: async () => ({ id: 'livekit', provider }),
    resolveCallProvider: () => provider,
    resolveCallProviderOrder: async () => ['livekit'],
  };
});
vi.mock('../../../server/services/calls/metrics.js', () => ({ emitCallMetric: () => {} }));
vi.mock('../../../server/services/push/apnsVoip.js', () => ({
  isVoipConfigured: () => true,
  sendVoipPush: async () => ({ ok: true }),
}));
vi.mock('../../../server/services/push/fcm.js', () => ({
  isPushConfigured: () => true,
  sendFcmData: async () => ({ ok: true }),
}));
vi.mock('../../../server/services/push/dispatch.js', () => ({
  // Records whether the call's line was there when the alert left: its badge counts it.
  notifyTeamCallMissed: async (_c: unknown, input: Record<string, unknown>) => {
    const lineWritten = (h.db.tables.team_messages ?? []).some((m) => m.call_session_id === input.callId);
    h.missed.push({ ...input, lineWritten });
  },
}));
vi.mock('../../../server/services/push/index.js', () => ({
  notifyTeamMessage: async (_c: unknown, input: Record<string, unknown>) => { h.teamPushes.push(input); },
}));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishTeamEvent: (_c: unknown, users: readonly string[], payload: Record<string, unknown>) => {
    h.published.push({ users, payload });
    return h.holdNudges && payload.kind === 'team_message' ? new Promise<void>(() => {}) : Promise.resolve();
  },
  publishConversationEvent: async () => {},
  publishOperatorEvent: async () => {},
  buildMessageEnvelope: () => ({}),
}));
vi.mock('../../../server/services/storage/urlResolver.js', () => ({
  hydrateUserAvatars: async (_c: unknown, rows: Array<Record<string, unknown>>) => {
    for (const r of rows) {
      r.avatar_url = null;
      delete r.avatar_storage_key;
    }
    return rows;
  },
}));

const { teamCallsRouter, __resetTeamCallRateLimitsForTests } = await import('../../../server/routes/teamCalls.js');
const { teamChatRouter } = await import('../../../server/routes/teamChat.js');
const { announceTeamCall, loadTeamCall } = await import('../../../server/services/calls/teamCallLifecycle.js');
const { recordTeamCallInChat, formatTeamCallDuration, teamCallChatBody } = await import('../../../server/services/calls/teamCallChat.js');

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '99999999-9999-4999-8999-999999999999';
const CALLER = '22222222-2222-4222-8222-222222222222';
const CALLEE = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const THIRD = '77777777-7777-4777-8777-777777777777';

const VOICE = '\u{1F4DE}';
const VIDEO = '\u{1F4F9}';

const config = { supabaseUrl: 'http://db.test', supabaseServiceRoleKey: 'service-key', signingSecret: 'signing-secret' };
const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = config;
  next();
});
app.use(express.json());
app.use('/api/team-calls', teamCallsRouter);
app.use('/api/team-chat', teamChatRouter);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.db = createFakeDb();
  h.db.tables.workspace_members = [CALLER, CALLEE, OTHER, THIRD].map((user_id) => ({ workspace_id: WS, user_id, role: 'agent', suspended_at: null }));
  h.db.tables.profiles = [
    { id: CALLER, full_name: 'Sara Ahmadi', email: 'sara@example.com', avatar_storage_key: null },
    { id: CALLEE, full_name: 'Daniel Carter', email: 'daniel@example.com', avatar_storage_key: null },
  ];
  h.db.tables.workspaces = [{ id: WS, name: 'Acme' }];
  h.db.tables.mobile_push_devices = [
    { id: 'row-and', user_id: CALLEE, platform: 'android', transport: 'fcm', enabled: true, push_token: 'fcm-callee', voip_token: null, device_id: 'android-install' },
  ];
  h.db.tables.operator_call_availability = [];
  h.db.tables.call_sessions = [];
  h.db.tables.team_messages = [];
  h.roomFails = false;
  h.holdNudges = false;
  for (const list of [h.missed, h.published, h.teamPushes]) list.length = 0;
  __resetTeamCallRateLimitsForTests([CALLER, CALLEE, OTHER, THIRD]);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

/** Notices are fire-and-forget: let them land before looking. */
const settle = () => new Promise((r) => setTimeout(r, 25));
const as = (userId: string) => ({ 'x-test-user': userId });
const callRow = (id: string) => h.db.tables.call_sessions.find((r) => r.id === id) as Row;
const lines = () => h.db.tables.team_messages.filter((m) => m.call_session_id);
const nudges = () => h.published.filter((p) => p.payload.kind === 'team_message');

async function place(channel: 'audio' | 'video' = 'video', caller = CALLER, callee = CALLEE): Promise<string> {
  const res = await request(app).post('/api/team-calls').set(as(caller))
    .send({ workspace_id: WS, callee_id: callee, channel });
  expect(res.status).toBe(201);
  return res.body.call.id as string;
}

/** Answered, then connected [seconds] before the hang-up. */
async function completedCall(seconds: number, channel: 'audio' | 'video' = 'video'): Promise<string> {
  const id = await place(channel);
  expect((await request(app).post(`/api/team-calls/${id}/accept`).set(as(CALLEE)).send({ device_id: 'android-install' })).status).toBe(200);
  callRow(id).connected_at = new Date(Date.now() - seconds * 1000).toISOString();
  expect((await request(app).post(`/api/team-calls/${id}/hangup`).set(as(CALLER))).body.call.outcome).toBe('completed');
  await settle();
  return id;
}

function thread(viewer: string, peer: string) {
  return request(app).get(`/api/team-chat/thread?workspace_id=${WS}&peer_id=${peer}`).set(as(viewer));
}

function colleagues(viewer: string) {
  return request(app).get(`/api/team-chat/colleagues?workspace_id=${WS}`).set(as(viewer));
}

describe('the line a call leaves', () => {
  it('a declined call: one line from the caller to the callee, where it rang, read; both members nudged, no push', async () => {
    const id = await place('video');
    const res = await request(app).post(`/api/team-calls/${id}/decline`).set(as(CALLEE));
    expect(res.body.call).toMatchObject({ state: 'ended', outcome: 'declined' });
    await settle();

    expect(lines()).toHaveLength(1);
    const line = lines()[0];
    expect(line).toMatchObject({
      workspace_id: WS,
      sender_id: CALLER,
      recipient_id: CALLEE,
      body: VIDEO,
      attachment_id: null,
      reply_to_id: null,
      call_session_id: id,
      created_at: callRow(id).created_at,
    });
    expect(typeof line.read_at).toBe('string');
    expect(nudges()).toEqual([{
      users: [CALLEE, CALLER],
      payload: { kind: 'team_message', workspace_id: WS, message_id: line.id, sender_id: CALLER, recipient_id: CALLEE },
    }]);
    expect(h.teamPushes).toHaveLength(0);
    expect(h.missed).toHaveLength(0);

    // Declined again (another phone, a retry): the call is over, nothing more.
    await request(app).post(`/api/team-calls/${id}/decline`).set(as(CALLEE));
    await request(app).post(`/api/team-calls/${id}/hangup`).set(as(CALLER));
    await settle();
    expect(lines()).toHaveLength(1);
    expect(nudges()).toHaveLength(1);
  });

  it('a cancelled call: unread for the callee, and their missed-call alert leaves after it (its badge counts it)', async () => {
    const id = await place('audio');
    expect((await request(app).post(`/api/team-calls/${id}/cancel`).set(as(CALLER))).body.call.outcome).toBe('cancelled');
    await settle();
    expect(lines()).toEqual([expect.objectContaining({ call_session_id: id, sender_id: CALLER, recipient_id: CALLEE, body: VOICE, read_at: null })]);
    expect(h.missed).toEqual([expect.objectContaining({ callId: id, lineWritten: true })]);
    expect(nudges()).toHaveLength(1);
  });

  it('the missed-call alert waits for the line to be written, not for its realtime nudge', async () => {
    h.holdNudges = true;
    const id = await place('video');
    expect((await request(app).post(`/api/team-calls/${id}/cancel`).set(as(CALLER))).status).toBe(200);
    await settle();
    expect(lines()).toEqual([expect.objectContaining({ call_session_id: id, read_at: null })]);
    expect(nudges()).toHaveLength(1);
    expect(h.missed).toEqual([expect.objectContaining({ callId: id, lineWritten: true })]);
  });

  it('a call that rang out: missed, unread for the callee', async () => {
    const id = await place('audio');
    callRow(id).created_at = new Date(Date.now() - 50_000).toISOString();
    expect((await request(app).get(`/api/team-calls/${id}`).set(as(CALLEE))).body.call).toMatchObject({ state: 'missed', outcome: 'missed' });
    await settle();
    expect(lines()).toEqual([expect.objectContaining({ call_session_id: id, body: VOICE, read_at: null, created_at: callRow(id).created_at })]);
    expect(h.missed).toEqual([expect.objectContaining({ callId: id, lineWritten: true })]);
  });

  it('a completed call: read, with its duration in the body (m:ss, from an hour h:mm:ss)', async () => {
    const short = await completedCall(75, 'video');
    const long = await completedCall(3725, 'audio');
    const byCall = new Map(lines().map((m) => [m.call_session_id, m]));
    expect(byCall.get(short)).toMatchObject({ body: `${VIDEO} 1:15`, sender_id: CALLER, recipient_id: CALLEE });
    expect(byCall.get(long)).toMatchObject({ body: `${VOICE} 1:02:05` });
    expect(typeof byCall.get(short)?.read_at).toBe('string');
    expect(h.missed).toHaveLength(0);
  });

  it('a call whose room could not be made: failed, read', async () => {
    h.roomFails = true;
    const res = await request(app).post('/api/team-calls').set(as(CALLER)).send({ workspace_id: WS, callee_id: CALLEE, channel: 'video' });
    expect(res.status).toBe(500);
    await settle();
    const row = h.db.tables.call_sessions[0];
    expect((row.metadata as Record<string, Record<string, unknown>>).team_call.outcome).toBe('failed');
    expect(lines()).toEqual([expect.objectContaining({ call_session_id: row.id, body: VIDEO })]);
    expect(typeof lines()[0].read_at).toBe('string');
  });

  it('nothing while the call is live: ringing, connecting, active', async () => {
    const id = await place();
    await request(app).post(`/api/team-calls/${id}/accept`).set(as(CALLEE)).send({ device_id: 'android-install' });
    await settle();
    const row = (await loadTeamCall(config as never, id))!;
    await announceTeamCall(config as never, { ...row, state: 'active' }, { actorId: null });
    expect(h.db.tables.team_messages).toEqual([]);
    expect(nudges()).toHaveLength(0);
  });

  it('written once: a second attempt, even at the same moment, writes nothing and nudges no one', async () => {
    const id = await place('audio');
    await request(app).post(`/api/team-calls/${id}/decline`).set(as(CALLEE));
    await settle();
    const row = (await loadTeamCall(config as never, id))!;
    await Promise.all([recordTeamCallInChat(config as never, row), recordTeamCallInChat(config as never, row)]);
    await announceTeamCall(config as never, row, { actorId: null });
    expect(lines()).toHaveLength(1);
    expect(nudges()).toHaveLength(1);
  });

  it('a database without migration 294: the end stands and is announced, the line only logs', async () => {
    const id = await place('audio');
    h.db.failNext('team_messages', { code: '42703', message: 'column "call_session_id" of relation "team_messages" does not exist' });
    const res = await request(app).post(`/api/team-calls/${id}/cancel`).set(as(CALLER));
    expect(res.status).toBe(200);
    expect(res.body.call).toMatchObject({ state: 'cancelled', outcome: 'cancelled' });
    await settle();
    expect(callRow(id).state).toBe('cancelled');
    expect(h.published.filter((p) => p.payload.kind === 'team_call').at(-1)?.payload).toMatchObject({ state: 'cancelled' });
    expect(h.missed).toEqual([expect.objectContaining({ callId: id, lineWritten: false })]);
    expect(h.db.tables.team_messages).toEqual([]);
    expect(nudges()).toHaveLength(0);
    expect(warn.mock.calls.flat().join(' ')).toContain('migration 294 not applied');
  });

  it('any other failed write only logs too', async () => {
    const id = await place('video');
    h.db.failNext('team_messages');
    expect((await request(app).post(`/api/team-calls/${id}/decline`).set(as(CALLEE))).status).toBe(200);
    await settle();
    expect(callRow(id).state).toBe('ended');
    expect(h.db.tables.team_messages).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('the body: the mark, and m:ss or h:mm:ss', () => {
    expect(teamCallChatBody('audio', null)).toBe(VOICE);
    expect(teamCallChatBody('video', 0)).toBe(`${VIDEO} 0:00`);
    expect(formatTeamCallDuration(59)).toBe('0:59');
    expect(formatTeamCallDuration(600)).toBe('10:00');
    expect(formatTeamCallDuration(3599)).toBe('59:59');
    expect(formatTeamCallDuration(3600)).toBe('1:00:00');
    expect(formatTeamCallDuration(36_061)).toBe('10:01:01');
  });
});

describe('the team chat reads: `call` on a line', () => {
  it('GET /thread: each line of a call carries its call, every other message `call: null`, for both members', async () => {
    const completed = await completedCall(75, 'video');
    const sent = await request(app).post('/api/team-chat/messages').set(as(CALLEE)).send({ workspace_id: WS, recipient_id: CALLER, body: 'hello' });
    expect(sent.status).toBe(200);
    expect(sent.body.message.call).toBeNull();
    const missed = await place('audio');
    await request(app).post(`/api/team-calls/${missed}/cancel`).set(as(CALLER));
    await settle();

    for (const [viewer, peer] of [[CALLER, CALLEE], [CALLEE, CALLER]]) {
      const res = await thread(viewer, peer);
      expect(res.status).toBe(200);
      const messages = res.body.messages as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(3);
      for (const m of messages) expect(m).not.toHaveProperty('call_session_id');
      const byCall = (callId: string) => messages.find((m) => (m.call as { id?: string } | null)?.id === callId);
      expect(byCall(completed)?.call).toEqual({ id: completed, channel: 'video', outcome: 'completed', duration_seconds: 75, caller_id: CALLER });
      expect(byCall(missed)?.call).toEqual({ id: missed, channel: 'audio', outcome: 'cancelled', duration_seconds: null, caller_id: CALLER });
      const text = messages.find((m) => m.body === 'hello');
      expect(text).toMatchObject({ call: null, attachment: null, sender_id: CALLEE });
    }
  });

  it('GET /colleagues: last_message carries the call, and a missed line counts as unread for the callee only', async () => {
    const id = await place('video');
    callRow(id).created_at = new Date(Date.now() - 50_000).toISOString();
    await request(app).get(`/api/team-calls/${id}`).set(as(CALLEE));
    await settle();

    const callee = await colleagues(CALLEE);
    expect(callee.status).toBe(200);
    const caller = (callee.body.colleagues as Array<Record<string, unknown>>).find((c) => c.user_id === CALLER)!;
    expect(caller.unread).toBe(1);
    expect(caller.last_message).toMatchObject({
      body: VIDEO,
      outgoing: false,
      attachment_kind: null,
      call: { id, channel: 'video', outcome: 'missed', duration_seconds: null, caller_id: CALLER },
    });
    const others = (callee.body.colleagues as Array<Record<string, unknown>>).filter((c) => c.user_id !== CALLER);
    for (const c of others) expect(c.last_message).toBeNull();

    const fromCaller = await colleagues(CALLER);
    const peer = (fromCaller.body.colleagues as Array<Record<string, unknown>>).find((c) => c.user_id === CALLEE)!;
    expect(peer.unread).toBe(0);
    expect(peer.last_message).toMatchObject({ outgoing: true, call: { id, outcome: 'missed' } });

    await request(app).post('/api/team-chat/read').set(as(CALLEE)).send({ workspace_id: WS, peer_id: CALLER });
    expect(((await colleagues(CALLEE)).body.colleagues as Array<Record<string, unknown>>).find((c) => c.user_id === CALLER)?.unread).toBe(0);
  });

  it('an ordinary last message has `call: null`', async () => {
    await request(app).post('/api/team-chat/messages').set(as(CALLER)).send({ workspace_id: WS, recipient_id: CALLEE, body: 'hi' });
    const res = await colleagues(CALLEE);
    expect((res.body.colleagues as Array<Record<string, unknown>>).find((c) => c.user_id === CALLER)?.last_message)
      .toMatchObject({ body: 'hi', call: null });
  });

  it('a line whose call is gone, of another pair or another workspace, or not over, shows no call', async () => {
    const otherPair = await place('audio', OTHER, THIRD);
    await request(app).post(`/api/team-calls/${otherPair}/decline`).set(as(THIRD));
    const elsewhere = await place('audio');
    await request(app).post(`/api/team-calls/${elsewhere}/decline`).set(as(CALLEE));
    await settle();
    callRow(elsewhere).workspace_id = OTHER_WS;
    const live = await place('video');
    const line = (call_session_id: string | null, body: string) => ({
      id: crypto.randomUUID(), workspace_id: WS, sender_id: CALLER, recipient_id: CALLEE, body,
      attachment_id: null, reply_to_id: null, read_at: null, created_at: new Date().toISOString(), call_session_id,
    });
    h.db.tables.team_messages.push(
      line(otherPair, 'forged: another pair'),
      line(crypto.randomUUID(), 'forged: no such call'),
      line(live, 'forged: a live call'),
    );

    const res = await thread(CALLER, CALLEE);
    expect(res.status).toBe(200);
    const messages = res.body.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBeGreaterThanOrEqual(4);
    for (const m of messages) expect(m.call).toBeNull();
  });

  it('an unreadable call table leaves every `call` null, and the thread still answers', async () => {
    await completedCall(10, 'audio');
    h.db.failNext('call_sessions');
    const res = await thread(CALLER, CALLEE);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([expect.objectContaining({ body: `${VOICE} 0:10`, call: null })]);
  });

  it('a database without migration 294: both reads fall back to the columns they had, every `call` null', async () => {
    await request(app).post('/api/team-chat/messages').set(as(CALLER)).send({ workspace_id: WS, recipient_id: CALLEE, body: 'before 294' });
    const missing = { code: '42703', message: 'column team_messages.call_session_id does not exist' };

    h.db.failNext('team_messages', missing);
    const t = await thread(CALLEE, CALLER);
    expect(t.status).toBe(200);
    expect(t.body.messages).toEqual([expect.objectContaining({ body: 'before 294', call: null })]);

    h.db.failNext('team_messages', missing);
    const c = await colleagues(CALLEE);
    expect(c.status).toBe(200);
    expect((c.body.colleagues as Array<Record<string, unknown>>).find((x) => x.user_id === CALLER)?.last_message)
      .toMatchObject({ body: 'before 294', call: null });
  });

  it('POST /messages cannot make a line of a call', async () => {
    const id = await completedCall(5);
    const res = await request(app).post('/api/team-chat/messages').set(as(CALLER))
      .send({ workspace_id: WS, recipient_id: CALLEE, body: 'not a call', call_session_id: id });
    expect(res.status).toBe(200);
    const stored = h.db.tables.team_messages.find((m) => m.id === res.body.message.id)!;
    expect(stored.call_session_id).toBeNull();
    expect(res.body.message.call).toBeNull();
    expect(lines()).toHaveLength(1);
    // A sent message is pushed, a call's line never is.
    expect(h.teamPushes).toEqual([expect.objectContaining({ messageId: res.body.message.id })]);
  });
});
