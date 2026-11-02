// @vitest-environment node
/**
 * A workspace whose plan has the mobile app off wakes no phone
 * (docs/operations/MOBILE_APP_PLAN.md, "Server"): no alert push of any kind
 * (messages, assignments, team chat, missed calls, support replies,
 * callbacks), no colleague ring (VoIP or FCM) and no call-centre ring (FCM)
 * to its members' phones, nor a call-centre stop for a ring none of them got
 * (one let through just before the plan changed is still stopped). The same members' other workspace, on a plan with
 * the app, is pushed and rung as before; a plan that cannot be read pushes as
 * before; Super Admin's test ring is not a workspace's and rings regardless.
 *
 * Everything runs for real over an in-memory database, the plan included
 * (server/services/mobileApp/planGate.ts); only the transports are stand-ins.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeDb, type FakeDb, type Row } from '../calls/teamCallTestDb';

interface Sent { token: string; title?: string; body?: string; data: Record<string, string> }

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  alerts: [] as Sent[],
  apns: [] as Sent[],
  data: [] as Sent[],
  voip: [] as Array<{ token: string; payload: Record<string, unknown> }>,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => h.db }));
vi.mock('../../../server/services/push/fcm.js', () => ({
  isPushConfigured: () => true,
  sendFcmMessage: async (msg: Sent) => { h.alerts.push(msg); return { ok: true }; },
  sendFcmData: async (msg: Sent) => { h.data.push(msg); return { ok: true }; },
}));
vi.mock('../../../server/services/push/apns.js', () => ({
  isApnsConfigured: () => true,
  nativeBundleId: () => 'com.webyar.ai',
  sendApnsAlert: async (msg: Sent) => { h.apns.push(msg); return { ok: true }; },
}));
vi.mock('../../../server/services/push/apnsVoip.js', () => ({
  isVoipConfigured: () => true,
  sendVoipPush: async (msg: { token: string; payload: Record<string, unknown> }) => { h.voip.push(msg); return { ok: true }; },
}));
vi.mock('../../../server/services/storage/urlResolver.js', () => ({
  createStorageUrlResolver: () => ({}),
  resolveContactAvatarUrl: async () => null,
}));
vi.mock('../../../server/services/widget/operatorPresenceSource.js', () => ({
  getConnectedOperators: async () => ({ mode: 'realtime', connected: new Set(), lastSeen: new Map(), degraded: false }),
}));
vi.mock('../../../server/services/billing/locks/state.js', () => ({
  resolveLockState: async () => ({ enabled: false }),
}));
vi.mock('../../../server/services/push/platformSettings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/push/platformSettings.js')>();
  return {
    ...actual,
    loadPushPlatformSettings: async () => ({ ...actual.PUSH_PLATFORM_DEFAULTS, badge_enabled: false }),
  };
});

const dispatch = await import('../../../server/services/push/dispatch.js');
const { resolveRecipients } = await import('../../../server/services/push/recipients.js');
const { ringOperators, cancelRing, ringTestDevice } = await import('../../../server/services/push/callRing.js');
const { teamCallRingTargets, ringTeamCall } = await import('../../../server/services/push/teamCallRing.js');
const { __resetMobileAppGateForTests } = await import('../../../server/services/mobileApp/planGate.js');
const { invalidateLocal } = await import('../../../server/lib/cacheBus.js');

const CONFIG = { supabaseUrl: 'http://db.test', supabaseServiceRoleKey: 'k' } as never;
/** On a plan with the mobile app off. */
const LOCKED = 'ws-locked';
/** On a plan that never mentions it: the default, on. */
const OPEN = 'ws-open';
const SARA = 'user-sara';
const REZA = 'user-reza';

/** Every phone of a member, an iPhone (alerts and VoIP) and an Android phone. */
function phones(userId: string): Row[] {
  return [
    { id: `ios-${userId}`, user_id: userId, platform: 'ios', transport: 'apns', push_token: `apns-${userId}`, voip_token: `voip-${userId}`, device_id: `ios-install-${userId}`, enabled: true },
    { id: `and-${userId}`, user_id: userId, platform: 'android', transport: 'fcm', push_token: `fcm-${userId}`, voip_token: null, device_id: `android-install-${userId}`, enabled: true },
  ];
}

const sentAnything = () => h.alerts.length + h.apns.length + h.data.length + h.voip.length;

beforeEach(() => {
  h.db = createFakeDb();
  const t = h.db.tables;
  t.billing_plans = [
    { id: 'plan-free', slug: 'free', name: 'Free', is_active: true, entitlements: {}, limits: {} },
    { id: 'plan-no-app', slug: 'no-app', name: 'No App', is_active: true, entitlements: { mobile_app: false, team_calls: true }, limits: {} },
    { id: 'plan-pro', slug: 'pro', name: 'Pro', is_active: true, entitlements: { team_calls: true }, limits: {} },
  ];
  t.workspace_subscriptions = [
    { workspace_id: LOCKED, plan_id: 'plan-no-app', status: 'active' },
    { workspace_id: OPEN, plan_id: 'plan-pro', status: 'active' },
  ];
  t.workspace_limit_overrides = [];
  // The same two people in both workspaces: what decides is the event's workspace.
  t.workspace_members = [LOCKED, OPEN].flatMap((ws) => [
    { workspace_id: ws, user_id: SARA, role: 'owner', suspended_at: null },
    { workspace_id: ws, user_id: REZA, role: 'agent', suspended_at: null },
  ]);
  t.profiles = [
    { id: SARA, full_name: 'Sara', preferred_locale: 'en' },
    { id: REZA, full_name: 'Reza', preferred_locale: 'fa' },
  ];
  t.workspaces = [{ id: LOCKED, name: 'Locked Co' }, { id: OPEN, name: 'Open Co' }];
  t.conversations = [LOCKED, OPEN].map((ws) => ({
    id: `conv-${ws}`, workspace_id: ws, assigned_to: REZA, status: 'open', contact_id: null, is_spam: false, ai_state: null,
  }));
  t.call_center_agent_presence = [LOCKED, OPEN].map((ws) => ({ workspace_id: ws, user_id: REZA, status: 'available' }));
  t.call_sessions = [];
  t.user_notification_prefs = [];
  t.push_dispatch_log = [];
  t.mobile_push_devices = [...phones(SARA), ...phones(REZA)];
  for (const list of [h.alerts, h.apns, h.data, h.voip]) list.length = 0;
  __resetMobileAppGateForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every alert push, as its caller sends it, for [ws]: each addressed to Reza. */
const ALERTS: Array<[string, (ws: string) => Promise<void>]> = [
  ['a customer\'s message', (ws) => dispatch.notifyInboundMessage(CONFIG, {
    workspaceId: ws, conversationId: `conv-${ws}`, messageId: `m-${ws}`, text: 'Hello',
  })],
  ['a conversation handed over', (ws) => dispatch.notifyAssignment(CONFIG, {
    workspaceId: ws, conversationId: `conv-${ws}`, assigneeId: REZA, actorId: SARA, stamp: '2026-11-02T00:00:00Z',
  })],
  ['a colleague\'s message', (ws) => dispatch.notifyTeamMessage(CONFIG, {
    workspaceId: ws, senderId: SARA, recipientId: REZA, messageId: `tm-${ws}`, text: 'Hi',
  })],
  ['a missed colleague call', (ws) => dispatch.notifyTeamCallMissed(CONFIG, {
    workspaceId: ws, callerId: SARA, calleeId: REZA, callId: `call-${ws}`, channel: 'audio',
  })],
  ['a support reply', (ws) => dispatch.notifySupportReply(CONFIG, {
    userId: REZA, workspaceId: ws, threadId: `thread-${ws}`, messageId: `sm-${ws}`, text: 'We fixed it',
  })],
  ['a callback request', (ws) => dispatch.notifyCallbackRequest(CONFIG, { workspaceId: ws, callbackId: `cb-${ws}` })],
];

describe('alert pushes', () => {
  it.each(ALERTS)('%s: none from a locked workspace, as before from the other', async (_name, send) => {
    await send(LOCKED);
    expect(sentAnything()).toBe(0);
    expect(h.db.tables.push_dispatch_log).toHaveLength(0);

    await send(OPEN);
    expect(h.alerts.length + h.apns.length).toBeGreaterThan(0);
    expect([...h.alerts, ...h.apns].every((m) => m.data?.workspaceId === OPEN || !m.data?.workspaceId)).toBe(true);
  });

  it('no event of a locked workspace has a recipient at all', async () => {
    const events = ['new_message', 'internal_note', 'mention', 'team_message', 'assignment', 'email_message',
      'callback_request', 'handoff', 'support_reply', 'team_call_missed'] as const;
    for (const eventType of events) {
      const ctx = {
        conversationId: 'conv-x', assignedTo: REZA, eventType, actorId: null,
        mentionedUserIds: [REZA], userIds: [REZA],
      };
      expect(await resolveRecipients(CONFIG, { ...ctx, workspaceId: LOCKED }), eventType).toEqual([]);
      expect((await resolveRecipients(CONFIG, { ...ctx, workspaceId: OPEN })).map((r) => r.userId), eventType).toEqual([REZA]);
    }
  });

  it('a plan that cannot be read pushes as before', async () => {
    h.db.failNext('workspace_subscriptions');
    await dispatch.notifyTeamMessage(CONFIG, { workspaceId: LOCKED, senderId: SARA, recipientId: REZA, messageId: 'tm-1', text: 'Hi' });
    expect(h.alerts.map((m) => m.token)).toEqual([`fcm-${REZA}`]);
    expect(h.apns.map((m) => m.token)).toEqual([`apns-${REZA}`]);
  });
});

describe('a colleague\'s ring', () => {
  const ring = (ws: string) => ({
    callId: `call-${ws}`, workspaceId: ws, workspaceName: null, channel: 'video' as const,
    callerUserId: SARA, callerName: 'Sara', callerAvatarUrl: null, expiresAt: Math.floor(Date.now() / 1000) + 45,
  });

  it('a locked workspace has no phone to ring: no VoIP, no FCM', async () => {
    const targets = await teamCallRingTargets(CONFIG, REZA, LOCKED);
    expect(targets).toEqual({ ios: [], android: [] });
    h.db.tables.call_sessions = [{ id: `call-${LOCKED}`, state: 'ringing' }];
    expect(await ringTeamCall(CONFIG, ring(LOCKED), targets)).toEqual({ sent: 0, devices: 0 });
    expect(sentAnything()).toBe(0);
  });

  it('the other workspace rings every phone of the callee', async () => {
    const targets = await teamCallRingTargets(CONFIG, REZA, OPEN);
    expect(targets.ios.map((d) => d.deviceId)).toEqual([`ios-install-${REZA}`]);
    expect(targets.android.map((d) => d.deviceId)).toEqual([`android-install-${REZA}`]);
    h.db.tables.call_sessions = [{ id: `call-${OPEN}`, state: 'ringing' }];
    expect(await ringTeamCall(CONFIG, ring(OPEN), targets)).toEqual({ sent: 2, devices: 2 });
  });

  it('a plan that cannot be read rings as before', async () => {
    h.db.failNext('workspace_subscriptions');
    const targets = await teamCallRingTargets(CONFIG, REZA, LOCKED);
    expect(targets.ios).toHaveLength(1);
    expect(targets.android).toHaveLength(1);
  });
});

describe('a call-centre ring', () => {
  it('a locked workspace rings no Android phone, assigned or broadcast', async () => {
    expect(await ringOperators(CONFIG, { workspaceId: LOCKED, callSessionId: 'cc-1', agentId: REZA, channel: 'audio' }))
      .toEqual({ sent: 0, devices: 0 });
    expect(await ringOperators(CONFIG, { workspaceId: LOCKED, callSessionId: 'cc-2', agentId: null, channel: 'video' }))
      .toEqual({ sent: 0, devices: 0 });
    expect(sentAnything()).toBe(0);
  });

  it('the other workspace rings as before', async () => {
    expect(await ringOperators(CONFIG, { workspaceId: OPEN, callSessionId: 'cc-3', agentId: REZA, channel: 'audio' }))
      .toEqual({ sent: 1, devices: 1 });
    expect(h.data.map((m) => [m.token, m.data.type])).toEqual([[`fcm-${REZA}`, 'call_incoming']]);
    expect(h.voip).toHaveLength(0);
  });

  it('its stop wakes no phone either: nothing of a locked workspace rang', async () => {
    await cancelRing(CONFIG, { workspaceId: LOCKED, callSessionId: 'cc-1', reason: 'answered' });
    await cancelRing(CONFIG, { workspaceId: LOCKED, callSessionId: 'cc-1', reason: 'declined', onlyUserId: REZA });
    expect(sentAnything()).toBe(0);
  });

  it('a ring let through just before the plan turned the app off is still stopped, while it can ring', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    h.db.tables.workspace_subscriptions = h.db.tables.workspace_subscriptions
      .map((s) => (s.workspace_id === LOCKED ? { ...s, plan_id: 'plan-pro' } : s));
    expect(await ringOperators(CONFIG, { workspaceId: LOCKED, callSessionId: 'cc-4', agentId: REZA, channel: 'audio' }))
      .toEqual({ sent: 1, devices: 1 });

    // The Super Admin turns the app off in the workspace's plan.
    h.db.tables.workspace_subscriptions = h.db.tables.workspace_subscriptions
      .map((s) => (s.workspace_id === LOCKED ? { ...s, plan_id: 'plan-no-app' } : s));
    invalidateLocal([`entitlements:${LOCKED}`]);
    clock.mockReturnValue(now + 20_000);
    expect(await ringOperators(CONFIG, { workspaceId: LOCKED, callSessionId: 'cc-5', agentId: REZA, channel: 'audio' }))
      .toEqual({ sent: 0, devices: 0 });
    h.data.length = 0;
    await cancelRing(CONFIG, { workspaceId: LOCKED, callSessionId: 'cc-4', reason: 'answered' });
    expect(h.data.map((m) => [m.token, m.data.type, m.data.callId]).sort()).toEqual([
      [`fcm-${REZA}`, 'call_cancel', 'cc-4'],
      [`fcm-${SARA}`, 'call_cancel', 'cc-4'],
    ]);

    // Past any ring's life (45 s, and a margin for the phone's clock): nothing left to stop.
    h.data.length = 0;
    clock.mockReturnValue(now + 61_000);
    await cancelRing(CONFIG, { workspaceId: LOCKED, callSessionId: 'cc-4', reason: 'ended' });
    expect(sentAnything()).toBe(0);
  });

  it('a plan that cannot be read stops as before', async () => {
    h.db.failNext('workspace_subscriptions');
    await cancelRing(CONFIG, { workspaceId: LOCKED, callSessionId: 'cc-1', reason: 'cancelled' });
    expect(h.data.map((m) => m.data.type)).toEqual(['call_cancel', 'call_cancel']);
  });
});

describe('Super Admin\'s test ring', () => {
  it('belongs to no workspace and rings the admin\'s own phones regardless', async () => {
    h.db.tables.workspace_subscriptions = [{ workspace_id: OPEN, plan_id: 'plan-no-app', status: 'active' }];
    const result = await ringTestDevice(CONFIG, { userId: SARA, callerName: 'Test', channel: 'audio' });
    expect(result).toMatchObject({ devices: 2, sent: 2 });
  });
});
