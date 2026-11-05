// @vitest-environment node
/**
 * Colleague calls and the mobile app as a plan feature
 * (docs/operations/MOBILE_APP_PLAN.md "Server", docs/operations/TEAM_CALLS.md
 * "Web panel"):
 *
 *  - a call to a member of a workspace whose plan has the mobile app off is
 *    placed all the same, rings none of their phones (no VoIP, no FCM, none
 *    recorded to stop) and still tells both members over realtime, which is
 *    what rings the callee's open web panel;
 *  - a web panel tab answers with its own device id (`web-<random>`) like
 *    any phone: the first answer wins, every rung Android phone is told it
 *    was answered elsewhere, an iPhone is sent nothing (it reads the state).
 *
 * The routes, the lifecycle, the ring and the plan read run for real against
 * an in-memory database; the team_calls gate, the call composer, the limits,
 * the media provider and the transports are stand-ins that record, as in
 * teamCallsRoute.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createFakeDb, type FakeDb, type Row } from './teamCallTestDb';

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  voip: [] as Array<{ token: string; payload: Record<string, unknown> }>,
  fcm: [] as Array<{ token: string; data: Record<string, string> }>,
  published: [] as Array<{ users: readonly string[]; payload: Record<string, unknown> }>,
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
  serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
  isSeatLocked: async () => false,
}));
// team_calls itself is allowed; the plan read the mobile-app gate makes is the real one.
vi.mock('../../../server/middleware/featureGating.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/middleware/featureGating.js')>()),
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
}));
vi.mock('../../../server/services/calls/monthlyMinutesLimit.js', () => ({
  checkPlanMonthlyMinutesCeiling: async () => ({ allowed: true, limit: -1 }),
}));
vi.mock('../../../server/services/calls/providerResolver.js', () => {
  const provider = {
    createRoom: async (_c: unknown, input: Record<string, unknown>) => ({ providerRoomId: `room-${String(input.callSessionId)}`, metadata: {} }),
    closeRoom: async () => {},
  };
  return {
    resolveEffectiveCallProvider: async () => ({ id: 'livekit', provider }),
    resolveCallProvider: () => provider,
  };
});
vi.mock('../../../server/services/calls/metrics.js', () => ({ emitCallMetric: () => {} }));
vi.mock('../../../server/services/push/apnsVoip.js', () => ({
  isVoipConfigured: () => true,
  sendVoipPush: async (m: (typeof h.voip)[number]) => { h.voip.push(m); return { ok: true }; },
}));
vi.mock('../../../server/services/push/fcm.js', () => ({
  isPushConfigured: () => true,
  sendFcmData: async (m: (typeof h.fcm)[number]) => { h.fcm.push(m); return { ok: true }; },
}));
vi.mock('../../../server/services/push/dispatch.js', () => ({ notifyTeamCallMissed: async () => {} }));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishTeamEvent: async (_c: unknown, users: readonly string[], payload: Record<string, unknown>) => {
    h.published.push({ users, payload });
  },
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
const { clearMobileAppGateCache } = await import('../../../server/services/mobileApp/planGate.js');

const WS = '11111111-1111-4111-8111-111111111111';
const CALLER = '22222222-2222-4222-8222-222222222222';
const CALLEE = '33333333-3333-4333-8333-333333333333';
/** What a panel tab sends as its device id (sessionStorage, `web-<random>`). */
const WEB_TAB = 'web-3f9c2a7b1e4d8c6a';

const config = { supabaseUrl: 'http://db.test', supabaseServiceRoleKey: 'service-key', signingSecret: 'signing-secret' };
const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = config;
  next();
});
app.use(express.json());
app.use('/api/team-calls', teamCallsRouter);

function device(row: Row): Row {
  // Builds that say `rang` themselves: no ring stamps the call for them
  // (teamCallRingbackFallback.test.ts covers old ones).
  const appVersion = row.platform === 'ios' ? '1.0.0 (6)' : '1.9 (30)';
  return { enabled: true, voip_token: null, push_token: null, transport: 'fcm', app_version: appVersion, ...row };
}

/** The workspace's plan: with the mobile app off, or one that never mentions it. */
function plan(mobileApp: boolean | undefined) {
  const entitlements: Row = { team_calls: true, voice_video: true };
  if (mobileApp !== undefined) entitlements.mobile_app = mobileApp;
  h.db.tables.billing_plans = [
    { id: 'plan-free', slug: 'free', name: 'Free', is_active: true, entitlements: {}, limits: {} },
    { id: 'plan-team', slug: 'team', name: 'Team', is_active: true, entitlements, limits: {} },
  ];
  clearMobileAppGateCache();
}

beforeEach(() => {
  h.db = createFakeDb();
  h.db.tables.workspace_members = [
    { workspace_id: WS, user_id: CALLER, role: 'agent', suspended_at: null },
    { workspace_id: WS, user_id: CALLEE, role: 'agent', suspended_at: null },
  ];
  h.db.tables.profiles = [
    { id: CALLER, full_name: 'Sara Ahmadi', email: 'sara@example.com', avatar_storage_key: null },
    { id: CALLEE, full_name: 'Daniel Carter', email: 'daniel@example.com', avatar_storage_key: null },
  ];
  h.db.tables.workspaces = [{ id: WS, name: 'Acme' }];
  h.db.tables.workspace_subscriptions = [{ workspace_id: WS, plan_id: 'plan-team', status: 'active' }];
  h.db.tables.workspace_limit_overrides = [];
  h.db.tables.mobile_push_devices = [
    device({ id: 'row-ios', user_id: CALLEE, platform: 'ios', transport: 'apns', push_token: 'apns-callee', voip_token: 'voip-callee', device_id: 'ios-install' }),
    device({ id: 'row-and-1', user_id: CALLEE, platform: 'android', push_token: 'fcm-callee-1', device_id: 'android-install-1' }),
    device({ id: 'row-and-2', user_id: CALLEE, platform: 'android', push_token: 'fcm-callee-2', device_id: 'android-install-2' }),
  ];
  h.db.tables.operator_call_availability = [];
  h.db.tables.call_sessions = [];
  for (const list of [h.voip, h.fcm, h.published]) list.length = 0;
  plan(undefined);
  __resetTeamCallRateLimitsForTests([CALLER, CALLEE]);
});

/** Notices are fire-and-forget: let them land before looking. */
const settle = () => new Promise((r) => setTimeout(r, 25));
const as = (userId: string) => ({ 'x-test-user': userId });
const teamMeta = (id: string) =>
  ((h.db.tables.call_sessions.find((r) => r.id === id) as Row).metadata as Record<string, Record<string, unknown>>).team_call;

async function place(channel: 'audio' | 'video' = 'audio') {
  return request(app).post('/api/team-calls').set(as(CALLER)).send({ workspace_id: WS, callee_id: CALLEE, channel });
}

describe('a workspace whose plan has the mobile app off', () => {
  beforeEach(() => plan(false));

  it('the call is placed, rings no phone, and both members are told it rings', async () => {
    const res = await place('video');
    expect(res.status).toBe(201);
    expect(res.body.call).toMatchObject({ state: 'ringing', role: 'caller', peer: { user_id: CALLEE, name: 'Daniel Carter' } });
    const id = res.body.call.id as string;
    expect(teamMeta(id)).toMatchObject({ rung_android_device_ids: [], rung_ios_device_ids: [] });

    await settle();
    expect(h.voip).toHaveLength(0);
    expect(h.fcm).toHaveLength(0);
    // The callee's own user channel (and the caller's): what rings the web panel.
    expect(h.published).toEqual([{
      users: [CALLER, CALLEE],
      payload: { kind: 'team_call', workspace_id: WS, call_id: id, state: 'ringing', outcome: null, rang_at: null },
    }]);
  });

  it('answered from the web panel: connecting, on that tab, with nothing to stop', async () => {
    const id = (await place()).body.call.id as string;
    await settle();
    const res = await request(app).post(`/api/team-calls/${id}/accept`).set(as(CALLEE)).send({ device_id: WEB_TAB });
    expect(res.status).toBe(200);
    expect(res.body.call).toMatchObject({ state: 'connecting', answered_device_id: WEB_TAB, role: 'callee' });
    await settle();
    expect(h.fcm).toHaveLength(0);
    expect(h.voip).toHaveLength(0);
    expect(h.published.at(-1)?.payload).toMatchObject({ call_id: id, state: 'connecting' });
  });

  it('a plan that cannot be read rings the phones as before', async () => {
    h.db.failNext('workspace_subscriptions');
    const id = (await place()).body.call.id as string;
    expect(teamMeta(id)).toMatchObject({
      rung_android_device_ids: ['android-install-1', 'android-install-2'],
      rung_ios_device_ids: ['ios-install'],
    });
    await settle();
    expect(h.voip.map((v) => v.token)).toEqual(['voip-callee']);
    expect(h.fcm.map((m) => m.token).sort()).toEqual(['fcm-callee-1', 'fcm-callee-2']);
  });
});

describe('a web panel tab answers like a phone (the app on)', () => {
  it('every phone rings; the tab\'s answer wins and stops every rung Android phone, the iPhone reads it', async () => {
    const id = (await place()).body.call.id as string;
    await settle();
    expect(h.voip.map((v) => v.token)).toEqual(['voip-callee']);
    expect(h.fcm.map((m) => m.data.type)).toEqual(['team_call_incoming', 'team_call_incoming']);
    h.fcm.length = 0;
    h.voip.length = 0;

    const res = await request(app).post(`/api/team-calls/${id}/accept`).set(as(CALLEE)).send({ device_id: WEB_TAB });
    expect(res.status).toBe(200);
    expect(res.body.call).toMatchObject({ state: 'connecting', answered_device_id: WEB_TAB });
    await settle();
    expect(h.fcm.map((m) => [m.token, m.data]).sort()).toEqual([
      ['fcm-callee-1', { type: 'team_call_cancel', callId: id, reason: 'answered_elsewhere' }],
      ['fcm-callee-2', { type: 'team_call_cancel', callId: id, reason: 'answered_elsewhere' }],
    ]);
    // Never a VoIP push but the ring: the iPhone ends its CallKit call on the state.
    expect(h.voip).toHaveLength(0);
    expect(h.published.at(-1)).toEqual({
      users: [CALLER, CALLEE],
      payload: { kind: 'team_call', workspace_id: WS, call_id: id, state: 'connecting', outcome: null, rang_at: null },
    });
    const read = await request(app).get(`/api/team-calls/${id}`).set(as(CALLEE));
    expect(read.body.call).toMatchObject({ state: 'connecting', answered_device_id: WEB_TAB });

    // A phone answering after the tab did is told it lost.
    const late = await request(app).post(`/api/team-calls/${id}/accept`).set(as(CALLEE)).send({ device_id: 'android-install-1' });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ error: 'not_ringing', call: { answered_device_id: WEB_TAB } });
  });

  it('another tab of the callee loses to the first the same way', async () => {
    const id = (await place()).body.call.id as string;
    await request(app).post(`/api/team-calls/${id}/accept`).set(as(CALLEE)).send({ device_id: WEB_TAB });
    const second = await request(app).post(`/api/team-calls/${id}/accept`).set(as(CALLEE)).send({ device_id: 'web-0a1b2c3d4e5f6a7b' });
    expect(second.status).toBe(409);
    expect(second.body.call.answered_device_id).toBe(WEB_TAB);
  });
});
