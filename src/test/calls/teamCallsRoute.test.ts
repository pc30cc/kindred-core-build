// @vitest-environment node
/**
 * Colleague calls over the API (docs/operations/TEAM_CALLS.md): who may
 * place one and when, what rings, how each move stops the phones, and that
 * only the call's two members ever see it.
 *
 * The routes, the lifecycle, the ring and the busy check run for real
 * against an in-memory database; the plan, the call composer, the limits,
 * the media provider and the transports are stand-ins that record.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createFakeDb, type FakeDb, type Row } from './teamCallTestDb';

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  plan: { allowed: true, reason: 'plan' } as { allowed: boolean; reason?: string },
  eff: null as unknown as Record<string, unknown>,
  concurrency: { allowed: true } as Record<string, unknown>,
  minutes: { allowed: true } as Record<string, unknown>,
  seatLocked: new Set<string>(),
  voip: [] as Array<{ token: string; payload: Record<string, unknown>; collapseId?: string; expirationSeconds?: number }>,
  fcm: [] as Array<{ token: string; data: Record<string, string>; ttlSeconds: number; collapseKey?: string }>,
  missed: [] as Array<Record<string, unknown>>,
  published: [] as Array<{ users: readonly string[]; payload: Record<string, unknown> }>,
  roomsCreated: [] as Array<Record<string, unknown>>,
  roomsClosed: [] as string[],
  tokens: [] as Array<Record<string, unknown>>,
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
  isSeatLocked: async (_c: unknown, _w: string, userId: string) => h.seatLocked.has(userId),
}));
vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkEntitlementFromDB: async (_u: string, _k: string, _w: string, feature: string) =>
    (feature === 'team_calls' ? h.plan : { allowed: true }),
}));
vi.mock('../../../server/services/calls/entitlementComposer.js', () => ({
  loadEffectiveCallEntitlements: async () => h.eff,
}));
vi.mock('../../../server/services/calls/concurrencyLimit.js', () => ({
  checkPlanConcurrencyCeiling: async () => h.concurrency,
  planConcurrencyDenialBody: () => ({}),
}));
vi.mock('../../../server/services/calls/monthlyMinutesLimit.js', () => ({
  checkPlanMonthlyMinutesCeiling: async () => h.minutes,
  planMinutesDenialBody: () => ({}),
}));
vi.mock('../../../server/services/calls/providerResolver.js', () => {
  const provider = {
    createRoom: async (_c: unknown, input: Record<string, unknown>) => {
      h.roomsCreated.push(input);
      return { providerRoomId: `room-${String(input.callSessionId)}`, metadata: {} };
    },
    closeRoom: async (_c: unknown, id: string) => { h.roomsClosed.push(id); },
    createParticipantToken: async (_c: unknown, input: Record<string, unknown>) => {
      h.tokens.push(input);
      return { token: 'lk-token', expiresAt: 1_900_000_000, identity: 'internal:0123456789abcdef' };
    },
    getRoomState: async () => null,
    supportsRecording: () => false,
  };
  return {
    resolveEffectiveCallProvider: async () => ({ id: 'livekit', provider }),
    resolveCallProvider: () => provider,
    resolveCallProviderOrder: async () => ['livekit'],
  };
});
vi.mock('../../../server/services/calls/rtcResolver.js', () => ({
  getCallNetworkBundle: async () => ({
    rtc_url: 'wss://livekit.example', ws_url: 'wss://livekit.example', recording_url: null,
    turn: { urls: [], username: null, credential: null, credential_type: 'password', static_secret_present: false },
    ice_policy: 'all', region: null, provider: 'livekit',
  }),
  normalizeClientWsUrl: (u: string) => u,
}));
vi.mock('../../../server/services/calls/livekitConfig.js', () => ({
  loadLiveKitConfig: async () => ({}),
  providesOwnRelay: () => true,
  isMinimallyConfigured: () => true,
}));
vi.mock('../../../server/services/calls/metrics.js', () => ({ emitCallMetric: () => {} }));
vi.mock('../../../server/services/push/apnsVoip.js', () => ({
  isVoipConfigured: () => true,
  sendVoipPush: async (m: (typeof h.voip)[number]) => { h.voip.push(m); return { ok: true }; },
}));
vi.mock('../../../server/services/push/fcm.js', () => ({
  isPushConfigured: () => true,
  sendFcmData: async (m: (typeof h.fcm)[number]) => { h.fcm.push(m); return { ok: true }; },
}));
vi.mock('../../../server/services/push/dispatch.js', () => ({
  notifyTeamCallMissed: async (_c: unknown, input: Record<string, unknown>) => { h.missed.push(input); },
}));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishTeamEvent: async (_c: unknown, users: readonly string[], payload: Record<string, unknown>) => {
    h.published.push({ users, payload });
  },
  publishConversationEvent: async () => {},
  publishOperatorEvent: async () => {},
  buildMessageEnvelope: () => ({}),
}));
vi.mock('../../../server/services/storage/urlResolver.js', () => ({
  hydrateUserAvatars: async (_c: unknown, rows: Array<Record<string, unknown>>) => {
    for (const r of rows) {
      r.avatar_url = r.avatar_storage_key ? `https://cdn.example/${String(r.avatar_storage_key)}` : null;
      delete r.avatar_storage_key;
    }
    return rows;
  },
}));

const { teamCallsRouter, __resetTeamCallRateLimitsForTests } = await import('../../../server/routes/teamCalls.js');
const { callsRouter } = await import('../../../server/routes/calls.js');

const WS = '11111111-1111-4111-8111-111111111111';
const CALLER = '22222222-2222-4222-8222-222222222222';
const CALLEE = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';
const SUSPENDED = '66666666-6666-4666-8666-666666666666';
const THIRD = '77777777-7777-4777-8777-777777777777';

const config = { supabaseUrl: 'http://db.test', supabaseServiceRoleKey: 'service-key', signingSecret: 'signing-secret' };
const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = config;
  next();
});
app.use(express.json());
app.use('/api/team-calls', teamCallsRouter);
app.use('/api/calls', callsRouter);

const fullEff = () => ({
  voice_enabled: true, video_enabled: true,
  visitor_voice_enabled: true, visitor_video_enabled: true,
  recording_enabled: false, queue_enabled: false, callbacks_enabled: false, call_center_enabled: false,
  plan: { voice_video: true, voice: true, video: true, call_center: false, call_recording: false, call_queue: false, call_callbacks: false },
  runtime: {},
});

function device(row: Row): Row {
  return { enabled: true, voip_token: null, push_token: null, transport: 'fcm', ...row };
}

beforeEach(() => {
  h.db = createFakeDb();
  h.db.tables.workspace_members = [
    { workspace_id: WS, user_id: CALLER, role: 'agent', suspended_at: null },
    { workspace_id: WS, user_id: CALLEE, role: 'agent', suspended_at: null },
    { workspace_id: WS, user_id: OTHER, role: 'admin', suspended_at: null },
    { workspace_id: WS, user_id: THIRD, role: 'agent', suspended_at: null },
    { workspace_id: WS, user_id: SUSPENDED, role: 'agent', suspended_at: '2026-10-01T00:00:00.000Z' },
  ];
  h.db.tables.profiles = [
    { id: CALLER, full_name: 'Sara Ahmadi', email: 'sara@example.com', avatar_storage_key: 'avatars/sara.jpg' },
    { id: CALLEE, full_name: 'Daniel Carter', email: 'daniel@example.com', avatar_storage_key: null },
    { id: THIRD, full_name: '  ', email: 'third@example.com', avatar_storage_key: null },
  ];
  h.db.tables.workspaces = [{ id: WS, name: 'Acme' }];
  h.db.tables.mobile_push_devices = [
    device({ id: 'row-ios', user_id: CALLEE, platform: 'ios', transport: 'apns', push_token: 'apns-callee', voip_token: 'voip-callee', device_id: 'ios-install' }),
    device({ id: 'row-and-1', user_id: CALLEE, platform: 'android', push_token: 'fcm-callee-1', device_id: 'android-install-1' }),
    device({ id: 'row-and-2', user_id: CALLEE, platform: 'android', push_token: 'fcm-callee-2', device_id: 'android-install-2' }),
    device({ id: 'row-and-off', user_id: CALLEE, platform: 'android', push_token: 'fcm-callee-off', device_id: 'android-install-off', enabled: false }),
    device({ id: 'row-caller-ios', user_id: CALLER, platform: 'ios', transport: 'apns', push_token: 'apns-caller', voip_token: 'voip-caller', device_id: 'caller-ios' }),
    device({ id: 'row-caller-and', user_id: CALLER, platform: 'android', push_token: 'fcm-caller', device_id: 'caller-android' }),
  ];
  h.db.tables.operator_call_availability = [];
  h.db.tables.call_sessions = [];
  h.plan = { allowed: true, reason: 'plan' };
  h.eff = fullEff();
  h.concurrency = { allowed: true, limit: -1 };
  h.minutes = { allowed: true, limit: -1 };
  h.seatLocked.clear();
  for (const list of [h.voip, h.fcm, h.missed, h.published, h.roomsCreated, h.roomsClosed, h.tokens]) list.length = 0;
  __resetTeamCallRateLimitsForTests([CALLER, CALLEE, OTHER, THIRD]);
});

/** Notices are fire-and-forget: let them land before looking. */
const settle = () => new Promise((r) => setTimeout(r, 25));

const as = (userId: string) => ({ 'x-test-user': userId });

async function place(body: Record<string, unknown> = {}, userId = CALLER) {
  return request(app).post('/api/team-calls').set(as(userId))
    .send({ workspace_id: WS, callee_id: CALLEE, channel: 'video', ...body });
}

const callRow = (id: string) => h.db.tables.call_sessions.find((r) => r.id === id) as Row;
const teamMeta = (id: string) => (callRow(id).metadata as Record<string, Record<string, unknown>>).team_call;

/** A colleague call placed [secondsAgo] ago, still ringing. */
function ringingCall(secondsAgo: number, caller = CALLER, callee = CALLEE): string {
  const id = crypto.randomUUID();
  h.db.tables.call_sessions.push({
    id, workspace_id: WS, provider: 'livekit', provider_room_id: `room-${id}`, call_type: 'audio',
    state: 'ringing', entry_source: 'team_call', context_type: 'internal', context_id: null, initiated_by: caller,
    created_at: new Date(Date.now() - secondsAgo * 1000).toISOString(), connected_at: null, ended_at: null,
    metadata: { team_call: {
      caller_user_id: caller, callee_user_id: callee, channel: 'audio', outcome: null,
      answered_device_id: null, answered_at: null,
      rung_android_device_ids: ['android-install-1', 'android-install-2'], rung_ios_device_ids: ['ios-install'],
    } },
  });
  return id;
}

describe('POST /api/team-calls — placing a call', () => {
  it('creates the row and the room, rings every phone of the callee and answers 201 { call }', async () => {
    const res = await place();
    expect(res.status).toBe(201);
    const call = res.body.call;
    expect(call).toMatchObject({
      workspace_id: WS, channel: 'video', state: 'ringing', outcome: null, role: 'caller',
      peer: { user_id: CALLEE, name: 'Daniel Carter', avatar_url: null },
      answered_device_id: null, answered_at: null, ended_at: null,
    });
    expect(Date.parse(call.expires_at) - Date.parse(call.created_at)).toBe(45_000);

    const row = callRow(call.id);
    expect(row).toMatchObject({
      entry_source: 'team_call', context_type: 'internal', context_id: null, state: 'ringing',
      initiated_by: CALLER, call_type: 'video', provider_room_id: `room-${call.id}`, connected_at: null,
    });
    expect(teamMeta(call.id)).toEqual({
      caller_user_id: CALLER, callee_user_id: CALLEE, channel: 'video', outcome: null,
      answered_device_id: null, answered_at: null,
      rung_android_device_ids: ['android-install-1', 'android-install-2'],
      rung_ios_device_ids: ['ios-install'],
    });
    // The room carries no one: no metadata of the route's own, no user id.
    expect(h.roomsCreated).toHaveLength(1);
    expect(h.roomsCreated[0].metadata).toBeUndefined();
    expect(JSON.stringify(h.roomsCreated[0])).not.toContain(CALLER);

    await settle();
    // iOS: one VoIP ring, to the callee's iPhone only — never the caller's.
    expect(h.voip.map((v) => v.token)).toEqual(['voip-callee']);
    expect(h.voip[0].payload).toEqual({
      kind: 'team_call', event: 'incoming', call_id: call.id, workspace_id: WS, workspace_name: 'Acme',
      channel: 'video', caller_name: 'Sara Ahmadi', caller_avatar_url: 'https://cdn.example/avatars/sara.jpg',
      caller_user_id: CALLER, expires_at: Math.floor(Date.parse(call.expires_at) / 1000),
    });
    expect(h.voip[0].expirationSeconds).toBe(45);
    expect(JSON.stringify(h.voip[0].payload)).not.toContain('@');
    // Android: the enabled phones of the callee, data-only, collapsed on the call.
    expect(h.fcm.map((m) => m.token).sort()).toEqual(['fcm-callee-1', 'fcm-callee-2']);
    for (const m of h.fcm) {
      expect(m.data).toEqual({
        type: 'team_call_incoming', callId: call.id, workspaceId: WS, workspaceName: 'Acme', channel: 'video',
        callerName: 'Sara Ahmadi', callerAvatarUrl: 'https://cdn.example/avatars/sara.jpg', callerUserId: CALLER,
        expiresAt: String(Math.floor(Date.parse(call.expires_at) / 1000)),
      });
      expect(m.ttlSeconds).toBe(45);
      expect(m.collapseKey).toBe(call.id);
    }
    expect(h.published).toEqual([{ users: [CALLER, CALLEE], payload: { kind: 'team_call', workspace_id: WS, call_id: call.id, state: 'ringing', outcome: null } }]);
  });

  it('a caller without a name rings as nobody in particular, never by their e-mail', async () => {
    const res = await place({ callee_id: CALLEE }, THIRD);
    expect(res.status).toBe(201);
    await settle();
    expect(h.voip[0].payload.caller_name).toBe('');
    expect(h.fcm[0].data.callerName).toBe('');
    expect(JSON.stringify([h.voip, h.fcm])).not.toContain('third@example.com');
  });

  it('refuses a malformed request, or a call to oneself', async () => {
    expect((await place({ channel: 'screenshare' })).body).toEqual({ error: 'invalid_params' });
    expect((await place({ callee_id: 'not-a-uuid' })).status).toBe(400);
    const self = await place({ callee_id: CALLER });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe('invalid_params');
    expect(h.db.tables.call_sessions).toHaveLength(0);
  });

  it('needs a session', async () => {
    const res = await request(app).post('/api/team-calls').send({ workspace_id: WS, callee_id: CALLEE, channel: 'audio' });
    expect(res.status).toBe(401);
  });

  it('only between two active members of the workspace', async () => {
    for (const [callee, caller] of [[STRANGER, CALLER], [SUSPENDED, CALLER], [CALLEE, STRANGER]]) {
      const res = await place({ callee_id: callee }, caller);
      expect(res.status, `${caller} → ${callee}`).toBe(403);
      expect(res.body.error).toBe('not_a_member');
    }
    h.seatLocked.add(CALLEE);
    expect((await place()).body.error).toBe('not_a_member');
    expect(h.db.tables.call_sessions).toHaveLength(0);
  });

  it('needs team_calls in the plan', async () => {
    h.plan = { allowed: false, reason: 'feature_not_in_plan' };
    const res = await place();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'upgrade_required', feature: 'team_calls' });
    expect(h.db.tables.call_sessions).toHaveLength(0);
  });

  it('an unreadable plan is an outage, not an upgrade', async () => {
    h.plan = { allowed: false, reason: 'rpc_error' };
    const res = await place();
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('entitlement_status_unavailable');
  });

  it('needs the call composer to allow the channel: the plan, or the runtime switches', async () => {
    h.eff = { ...fullEff(), voice_enabled: false, plan: { ...fullEff().plan, voice: false } };
    const plan = await place({ channel: 'audio' });
    expect(plan.status).toBe(403);
    expect(plan.body).toMatchObject({ error: 'upgrade_required', feature: 'team_calls', capability: 'voice_video.voice', reason: 'plan', upgrade_required: true });

    h.eff = { ...fullEff(), video_enabled: false };
    const runtime = await place({ channel: 'video' });
    expect(runtime.status).toBe(403);
    expect(runtime.body).toMatchObject({ capability: 'voice_video.video', reason: 'runtime', upgrade_required: false });
    expect(h.db.tables.call_sessions).toHaveLength(0);
  });

  it('counts in the plan’s concurrency and minutes, like every call', async () => {
    h.concurrency = { allowed: false, reason: 'plan_limit_reached', limit: 2, used: 2 };
    const concurrent = await place();
    expect(concurrent.status).toBe(422);
    expect(concurrent.body).toMatchObject({ error: 'limit_reached', limit: 'max_concurrent_calls', max: 2, used: 2 });

    h.concurrency = { allowed: true, limit: -1 };
    h.minutes = { allowed: false, reason: 'plan_limit_reached', limit: 100, used: 100 };
    const minutes = await place();
    expect(minutes.status).toBe(422);
    expect(minutes.body).toMatchObject({ error: 'limit_reached', limit: 'max_call_minutes_per_month' });
    expect(h.db.tables.call_sessions).toHaveLength(0);
  });

  it('a callee already in a colleague call is busy, and so is a caller', async () => {
    ringingCall(5, OTHER, CALLEE);
    const calleeBusy = await place();
    expect(calleeBusy.status).toBe(409);
    expect(calleeBusy.body.error).toBe('callee_busy');

    h.db.tables.call_sessions = [];
    ringingCall(5, CALLER, OTHER);
    const callerBusy = await place();
    expect(callerBusy.status).toBe(409);
    expect(callerBusy.body.error).toBe('caller_busy');
  });

  /**
   * Holds every placement until [count] of them are waiting, so that each
   * request has passed the early busy read before any row is written: the
   * moment two phones press "call" together.
   */
  function placeTogether(count = 2): void {
    const rpc = h.db.rpc;
    let waiting: Array<() => void> = [];
    h.db.rpc = async (name, args) => {
      if (name === 'team_call_place') {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (waiting.length >= count) {
            for (const release of waiting) release();
            waiting = [];
          }
        });
      }
      return rpc(name, args);
    };
  }

  it('two members calling each other at the same moment: one call rings, the other caller is busy', async () => {
    placeTogether();
    const [ab, ba] = await Promise.all([place({}, CALLER), place({ callee_id: CALLER }, CALLEE)]);
    expect([ab.status, ba.status].sort()).toEqual([201, 409]);
    expect([ab.body.error, ba.body.error].filter(Boolean)).toEqual(['caller_busy']);
    expect(h.db.tables.call_sessions.filter((r) => r.state === 'ringing')).toHaveLength(1);
  });

  it('two colleagues calling the same member at the same moment ring them once', async () => {
    placeTogether();
    const [first, second] = await Promise.all([place({}, OTHER), place({}, THIRD)]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect([first.body.error, second.body.error].filter(Boolean)).toEqual(['callee_busy']);
    await settle();
    expect(h.voip).toHaveLength(1);
    expect(h.db.tables.call_sessions).toHaveLength(1);
  });

  it('a placement the database cannot make is an error, and rings nobody', async () => {
    h.db.failNext('rpc:team_call_place');
    const res = await place();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal_error');
    await settle();
    expect(h.voip).toHaveLength(0);
    expect(h.fcm).toHaveLength(0);
    expect(h.roomsCreated).toHaveLength(0);
    expect(h.db.tables.call_sessions).toHaveLength(0);
  });

  it('a ring that ran out does not make anyone busy', async () => {
    ringingCall(60, OTHER, CALLEE);
    expect((await place()).status).toBe(201);
  });

  it('a member in another live call is busy; a manual "busy" status is not a call', async () => {
    h.db.tables.call_sessions.push({ id: 'cc-1', workspace_id: WS, state: 'active', entry_source: 'call_widget', created_at: new Date().toISOString() });
    h.db.tables.operator_call_availability = [
      { workspace_id: WS, user_id: CALLEE, status: 'busy', in_call: true, active_call_session_id: 'cc-1' },
    ];
    expect((await place()).body.error).toBe('callee_busy');

    h.db.tables.operator_call_availability = [
      { workspace_id: WS, user_id: CALLEE, status: 'busy', in_call: false, active_call_session_id: null },
    ];
    expect((await place()).status).toBe(201);
  });

  it('a member who took a call-centre call is busy', async () => {
    h.db.tables.call_sessions.push({
      id: 'cc-2', workspace_id: WS, state: 'active', entry_source: 'call_widget', assigned_agent_id: CALLEE,
      created_at: new Date().toISOString(),
    });
    expect((await place()).body.error).toBe('callee_busy');
  });

  it('a caller rings at most 10 times a minute', async () => {
    for (let i = 0; i < 10; i++) expect((await place({ channel: 'fax' })).status).toBe(400);
    const res = await place();
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('too_many_calls');
  });

  it('a callee is rung at most 6 times a minute', async () => {
    for (let i = 0; i < 6; i++) {
      const placed = await place({}, i % 2 ? OTHER : CALLER);
      expect(placed.status).toBe(201);
      const caller = i % 2 ? OTHER : CALLER;
      expect((await request(app).post(`/api/team-calls/${placed.body.call.id}/cancel`).set(as(caller))).status).toBe(200);
    }
    const res = await place({}, THIRD);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('too_many_calls');
  });

  it('an attempt that never rang gives the callee’s ring back: a burst racing the busy check cannot use up their share', async () => {
    // Six calls from one caller at once all pass the early busy read; the
    // placement rings one and answers caller_busy to the rest.
    const rpc = h.db.rpc;
    placeTogether(6);
    const burst = await Promise.all(Array.from({ length: 6 }, () => place({}, CALLER)));
    h.db.rpc = rpc;
    expect(burst.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    const placed = burst.find((r) => r.status === 201)!;
    expect((await request(app).post(`/api/team-calls/${placed.body.call.id}/cancel`).set(as(CALLER))).status).toBe(200);
    // Only that one ring counted: five more callers' rings still reach the callee.
    for (let i = 0; i < 5; i++) {
      const caller = i % 2 ? OTHER : THIRD;
      const next = await place({}, caller);
      expect(next.status).toBe(201);
      expect((await request(app).post(`/api/team-calls/${next.body.call.id}/cancel`).set(as(caller))).status).toBe(200);
    }
    expect((await place({}, OTHER)).body.error).toBe('too_many_calls');
  });

  it('a placement that fails gives the callee’s ring back', async () => {
    for (let i = 0; i < 6; i++) {
      h.db.failNext('rpc:team_call_place');
      expect((await place({}, i % 2 ? OTHER : CALLER)).status).toBe(500);
    }
    expect((await place({}, THIRD)).status).toBe(201);
  });

  it('a room that cannot be made closes the row as failed', async () => {
    const { resolveCallProvider } = await import('../../../server/services/calls/providerResolver.js');
    const provider = resolveCallProvider('livekit');
    const original = provider.createRoom;
    provider.createRoom = async () => { throw new Error('twirp down'); };
    try {
      const res = await place();
      expect(res.status).toBe(500);
      await settle();
      const row = h.db.tables.call_sessions[0];
      expect(row.state).toBe('ended');
      expect((row.metadata as Record<string, Record<string, unknown>>).team_call.outcome).toBe('failed');
      expect(h.voip).toHaveLength(0);
      expect(h.fcm).toHaveLength(0);
    } finally {
      provider.createRoom = original;
    }
  });
});

describe('GET /api/team-calls/:id', () => {
  it('shows the call to its callee, with the caller as the peer', async () => {
    const { body } = await place();
    const res = await request(app).get(`/api/team-calls/${body.call.id}`).set(as(CALLEE));
    expect(res.status).toBe(200);
    expect(res.body.call).toMatchObject({
      id: body.call.id, role: 'callee', state: 'ringing',
      peer: { user_id: CALLER, name: 'Sara Ahmadi', avatar_url: 'https://cdn.example/avatars/sara.jpg' },
    });
  });

  it('is 404 for anyone else, for a malformed id and for any other kind of call', async () => {
    const { body } = await place();
    expect((await request(app).get(`/api/team-calls/${body.call.id}`).set(as(OTHER))).status).toBe(404);
    expect((await request(app).get('/api/team-calls/not-a-uuid').set(as(CALLER))).status).toBe(404);
    const chatCall = crypto.randomUUID();
    h.db.tables.call_sessions.push({ id: chatCall, workspace_id: WS, state: 'active', entry_source: 'chat', initiated_by: CALLER, metadata: {} });
    expect((await request(app).get(`/api/team-calls/${chatCall}`).set(as(CALLER))).status).toBe(404);
  });

  it('a call still ringing past its ring is missed when read', async () => {
    const id = ringingCall(50);
    const res = await request(app).get(`/api/team-calls/${id}`).set(as(CALLEE));
    expect(res.body.call).toMatchObject({ state: 'missed', outcome: 'missed' });
    await settle();
    expect(h.missed).toEqual([{ workspaceId: WS, callerId: CALLER, calleeId: CALLEE, callId: id, channel: 'audio' }]);
    expect(h.fcm.map((m) => m.data)).toEqual([
      { type: 'team_call_cancel', callId: id, reason: 'missed' },
      { type: 'team_call_cancel', callId: id, reason: 'missed' },
    ]);
  });
});

describe('POST /api/team-calls/:id/accept', () => {
  it('the first answer wins: connecting, answered on that phone, the others stop', async () => {
    const { body } = await place();
    await settle();
    h.fcm.length = 0;
    const res = await request(app).post(`/api/team-calls/${body.call.id}/accept`).set(as(CALLEE)).send({ device_id: 'android-install-1' });
    expect(res.status).toBe(200);
    expect(res.body.call).toMatchObject({ state: 'connecting', answered_device_id: 'android-install-1', role: 'callee' });
    expect(res.body.call.answered_at).toBeTruthy();
    const row = callRow(body.call.id);
    expect(row.connected_at).toBe(res.body.call.answered_at);

    await settle();
    // Only the other rung Android phone; the answering one is in the call.
    expect(h.fcm.map((m) => [m.token, m.data])).toEqual([
      ['fcm-callee-2', { type: 'team_call_cancel', callId: body.call.id, reason: 'answered_elsewhere' }],
    ]);
    expect(h.published.at(-1)?.payload).toMatchObject({ state: 'connecting', outcome: null });

    const late = await request(app).post(`/api/team-calls/${body.call.id}/accept`).set(as(CALLEE)).send({ device_id: 'ios-install' });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ error: 'not_ringing', call: { state: 'connecting', answered_device_id: 'android-install-1' } });
  });

  it('an answer on the iPhone stops every rung Android phone', async () => {
    const { body } = await place();
    await settle();
    h.fcm.length = 0;
    await request(app).post(`/api/team-calls/${body.call.id}/accept`).set(as(CALLEE)).send({ device_id: 'ios-install' });
    await settle();
    expect(h.fcm.map((m) => m.token).sort()).toEqual(['fcm-callee-1', 'fcm-callee-2']);
  });

  it('only the callee answers', async () => {
    const { body } = await place();
    const res = await request(app).post(`/api/team-calls/${body.call.id}/accept`).set(as(CALLER)).send({});
    expect(res.status).toBe(403);
    expect(callRow(body.call.id).state).toBe('ringing');
  });

  it('a ring that ran out cannot be answered', async () => {
    const id = ringingCall(46);
    const res = await request(app).post(`/api/team-calls/${id}/accept`).set(as(CALLEE)).send({ device_id: 'android-install-1' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'not_ringing', call: { state: 'missed', outcome: 'missed' } });
    expect(callRow(id).connected_at).toBeNull();
  });
});

describe('decline, cancel and hang-up', () => {
  it('the callee declines: the caller’s call ends at once, the phones stop, nothing is missed', async () => {
    const { body } = await place();
    await settle();
    h.fcm.length = 0;
    const res = await request(app).post(`/api/team-calls/${body.call.id}/decline`).set(as(CALLEE));
    expect(res.status).toBe(200);
    expect(res.body.call).toMatchObject({ state: 'ended', outcome: 'declined' });
    expect(callRow(body.call.id).ended_at).toBeTruthy();
    await settle();
    expect(h.fcm.map((m) => m.data.reason)).toEqual(['declined', 'declined']);
    expect(h.missed).toHaveLength(0);
    expect(h.roomsClosed).toEqual([`room-${body.call.id}`]);
    expect(h.published.filter((p) => p.payload.kind === 'team_call').at(-1)).toEqual({ users: [CALLER, CALLEE], payload: { kind: 'team_call', workspace_id: WS, call_id: body.call.id, state: 'ended', outcome: 'declined' } });

    const again = await request(app).post(`/api/team-calls/${body.call.id}/decline`).set(as(CALLEE));
    expect(again.status).toBe(200);
    expect(again.body.call).toMatchObject({ state: 'ended', outcome: 'declined' });
  });

  it('a decline from another phone never ends a call already answered', async () => {
    const { body } = await place();
    await request(app).post(`/api/team-calls/${body.call.id}/accept`).set(as(CALLEE)).send({ device_id: 'ios-install' });
    const res = await request(app).post(`/api/team-calls/${body.call.id}/decline`).set(as(CALLEE));
    expect(res.status).toBe(200);
    expect(res.body.call.state).toBe('connecting');
  });

  it('the caller cancels: cancelled, the phones stop, the callee is told they missed it', async () => {
    const { body } = await place({ channel: 'audio' });
    await settle();
    h.fcm.length = 0;
    expect((await request(app).post(`/api/team-calls/${body.call.id}/cancel`).set(as(CALLEE))).status).toBe(403);
    const res = await request(app).post(`/api/team-calls/${body.call.id}/cancel`).set(as(CALLER));
    expect(res.body.call).toMatchObject({ state: 'cancelled', outcome: 'cancelled', role: 'caller' });
    await settle();
    expect(h.fcm.map((m) => m.data.reason)).toEqual(['cancelled', 'cancelled']);
    expect(h.missed).toEqual([{ workspaceId: WS, callerId: CALLER, calleeId: CALLEE, callId: body.call.id, channel: 'audio' }]);

    await request(app).post(`/api/team-calls/${body.call.id}/cancel`).set(as(CALLER));
    await settle();
    expect(h.missed).toHaveLength(1);
  });

  it('a hang-up after the answer ends the call for both (completed), once', async () => {
    const { body } = await place();
    await request(app).post(`/api/team-calls/${body.call.id}/accept`).set(as(CALLEE)).send({ device_id: 'android-install-1' });
    await settle();
    h.fcm.length = 0;
    const res = await request(app).post(`/api/team-calls/${body.call.id}/hangup`).set(as(CALLER));
    expect(res.body.call).toMatchObject({ state: 'ended', outcome: 'completed' });
    const row = callRow(body.call.id);
    expect(row).toMatchObject({ ended_by: 'operator', ended_by_user_id: CALLER, end_reason: 'operator_ended' });
    expect(typeof row.duration_seconds).toBe('number');
    await settle();
    expect(h.fcm.map((m) => [m.token, m.data.reason])).toEqual([['fcm-callee-2', 'ended']]);
    expect(h.roomsClosed).toEqual([`room-${body.call.id}`]);

    const again = await request(app).post(`/api/team-calls/${body.call.id}/hangup`).set(as(CALLEE));
    expect(again.body.call).toMatchObject({ state: 'ended', outcome: 'completed', role: 'callee' });
    expect(callRow(body.call.id).ended_by_user_id).toBe(CALLER);
  });

  it('a hang-up while it rings is the caller’s cancel or the callee’s decline', async () => {
    const first = (await place()).body.call.id;
    expect((await request(app).post(`/api/team-calls/${first}/hangup`).set(as(CALLER))).body.call.outcome).toBe('cancelled');
    const second = (await place()).body.call.id;
    expect((await request(app).post(`/api/team-calls/${second}/hangup`).set(as(CALLEE))).body.call.outcome).toBe('declined');
  });

  it('an iPhone is never sent a VoIP push but the ring', async () => {
    const a = (await place()).body.call.id;
    await request(app).post(`/api/team-calls/${a}/decline`).set(as(CALLEE));
    const b = (await place()).body.call.id;
    await request(app).post(`/api/team-calls/${b}/accept`).set(as(CALLEE)).send({ device_id: 'android-install-2' });
    await request(app).post(`/api/team-calls/${b}/hangup`).set(as(CALLEE));
    const c = (await place()).body.call.id;
    await request(app).post(`/api/team-calls/${c}/cancel`).set(as(CALLER));
    await settle();
    expect(h.voip.map((v) => v.payload.event)).toEqual(['incoming', 'incoming', 'incoming']);
  });
});

describe('POST /api/team-calls/:id/token', () => {
  it('only once answered', async () => {
    const { body } = await place();
    const res = await request(app).post(`/api/team-calls/${body.call.id}/token`).set(as(CALLER));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'not_connected', call: { state: 'ringing' } });
    expect(h.tokens).toHaveLength(0);
  });

  it('answers as POST /api/calls/:id/token does, for this user under their own name', async () => {
    const { body } = await place();
    await request(app).post(`/api/team-calls/${body.call.id}/accept`).set(as(CALLEE)).send({});
    const res = await request(app).post(`/api/team-calls/${body.call.id}/token`).set(as(CALLER))
      .send({ participant_id: OTHER, participant_type: 'operator', display_name: 'sara@example.com' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['expires_at', 'ice_policy', 'network', 'provider', 'rtc_url', 'token', 'turn', 'warnings', 'ws_url']);
    expect(res.body).toMatchObject({ token: 'lk-token', provider: 'livekit', ws_url: 'wss://livekit.example', warnings: [] });
    expect(h.tokens).toEqual([expect.objectContaining({
      callSessionId: body.call.id, providerRoomId: `room-${body.call.id}`,
      participantType: 'internal', participantId: CALLER, displayName: 'Sara Ahmadi',
    })]);
  });

  it('is 404 for anyone but the two members', async () => {
    const { body } = await place();
    await request(app).post(`/api/team-calls/${body.call.id}/accept`).set(as(CALLEE)).send({});
    expect((await request(app).post(`/api/team-calls/${body.call.id}/token`).set(as(OTHER))).status).toBe(404);
  });

  it('a seat the plan paused mid-call does not cut the call: the member may rejoin', async () => {
    const { body } = await place();
    await request(app).post(`/api/team-calls/${body.call.id}/accept`).set(as(CALLEE)).send({});
    h.seatLocked.add(CALLEE);
    const res = await request(app).post(`/api/team-calls/${body.call.id}/token`).set(as(CALLEE));
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('lk-token');
  });

  it('a member suspended or removed since is out', async () => {
    const { body } = await place();
    await request(app).post(`/api/team-calls/${body.call.id}/accept`).set(as(CALLEE)).send({});
    h.db.tables.workspace_members.find((m) => m.user_id === CALLEE)!.suspended_at = new Date().toISOString();
    const suspended = await request(app).post(`/api/team-calls/${body.call.id}/token`).set(as(CALLEE));
    expect(suspended.status).toBe(403);
    expect(suspended.body.error).toBe('not_a_member');
    h.db.tables.workspace_members = h.db.tables.workspace_members.filter((m) => m.user_id !== CALLER);
    expect((await request(app).post(`/api/team-calls/${body.call.id}/token`).set(as(CALLER))).status).toBe(403);
    expect(h.tokens).toHaveLength(0);
  });
});

describe('the generic call routes', () => {
  it('answer 404 for a colleague call', async () => {
    const { body } = await place();
    await request(app).post(`/api/team-calls/${body.call.id}/accept`).set(as(CALLEE)).send({});
    const id = body.call.id;
    for (const [method, path] of [
      ['post', `/api/calls/${id}/token`], ['get', `/api/calls/${id}/state`], ['post', `/api/calls/${id}/invite`],
      ['post', `/api/calls/${id}/accept`], ['post', `/api/calls/${id}/reject`], ['post', `/api/calls/${id}/hangup`],
      ['post', `/api/calls/${id}/end`],
    ] as const) {
      const res = await request(app)[method](path).set(as(OTHER)).send({});
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(callRow(id).state).toBe('connecting');
    expect(h.tokens).toHaveLength(0);

    // The same route answers for any other call of the workspace.
    const chatCall = crypto.randomUUID();
    h.db.tables.call_sessions.push({ id: chatCall, workspace_id: WS, provider: 'livekit', provider_room_id: null, state: 'active', entry_source: 'chat', metadata: {} });
    expect((await request(app).get(`/api/calls/${chatCall}/state`).set(as(OTHER))).status).toBe(200);
  });
});
