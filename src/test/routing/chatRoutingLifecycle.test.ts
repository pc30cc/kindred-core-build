/**
 * What a visitor's message changes about who has the conversation, and what
 * happens to a member's chats when they leave (chatRouting.ts
 * routeHumanBoundConversation, afterMemberReleased; DECISIONS §4):
 *
 *   R-02  a thread the AI holds but will not answer (suggest-only,
 *         auto-reply-when-offline while the team is online) leaves the AI's
 *         queue for the team's and is routed; one the AI answers stays.
 *   R-03  an operator who left, was suspended, lost the Inbox or whose seat
 *         the plan paused no longer holds it: released, routed.
 *   R-17  a resolved thread the visitor starts again keeps its operator only
 *         when they could take it as a new chat now: last-agent routing on,
 *         within its window, receiving chats, active (not away), under
 *         capacity. The stamp the resolve left counts as a reopen too (the
 *         widget's own "reopen" sends no lifecycle flag).
 *   R-03  released together (offboarding, suspension): announced, and only
 *         the recently active ones routed at once.
 *
 * The data layer is an in-memory fake; chat_route_claim a stand-in that
 * gives the conversation to the first candidate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from '../conversations/fakeServiceDb';

const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  presence: new Map<string, { state: string; lastActivityAt: number | null }>(),
  teamOffline: false,
  lockedMembers: [] as string[],
  /** Members chat_route_claim's stand-in finds at capacity. */
  full: new Set<string>(),
  claims: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  operatorEvents: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/services/widget/operatorPresence.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/operatorPresence.js')>()),
  readRoutingPresence: async (_c: unknown, _ws: string, ids: string[]) =>
    new Map(ids.filter((id) => state.presence.has(id)).map((id) => [id, state.presence.get(id)!])),
}));
vi.mock('../../../server/services/widget/entitlements.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/entitlements.js')>()),
  resolveWidgetCapability: async () => true,
}));
vi.mock('../../../server/services/ai-agent/platformGuards.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/ai-agent/platformGuards.js')>()),
  isAutoAnswerAllowedForWorkspace: async () => ({ allowed: true }),
}));
vi.mock('../../../server/services/ai-agent/availability.js', () => ({
  getOperatorAvailability: async () => ({ state: state.teamOffline ? 'offline' : 'online', reason: 'test', source: 'widget_resolver', schedule: null }),
}));
vi.mock('../../../server/services/billing/locks/state.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/billing/locks/state.js')>()),
  resolveLockState: async () => ({ enabled: true, kb: null, contact: null, conversation: null, member: state.lockedMembers.length ? { locked: true, lockedUserIds: state.lockedMembers } : null }),
}));
vi.mock('../../../server/services/billing/locks/predicates.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/billing/locks/predicates.js')>()),
  isMemberLocked: (_s: unknown, userId: string) => state.lockedMembers.includes(userId),
}));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishOperatorEvent: async (_c: unknown, e: Record<string, unknown>) => { state.operatorEvents.push(e); },
  publishConversationEvent: async () => {},
  buildMessageEnvelope: (m: unknown) => m,
}));
vi.mock('../../../server/services/channels/outbound.js', () => ({ dispatchOutboundIfChannelConversation: async () => {} }));
vi.mock('../../../server/services/push/index.js', () => ({ notifyAssignment: async () => {}, notifyHandoff: async () => {} }));
vi.mock('../../../server/services/platformSupport/changes.js', () => ({ onSupportConversationChanged: async () => {} }));
vi.mock('../../../server/services/conversationEvents.js', () => ({
  recordConversationEvent: async (_c: unknown, e: Record<string, unknown>) => { state.events.push(e); return { ok: true }; },
}));

const routing = await import('../../../server/services/chatRouting.js');
const { invalidateDepartmentCache } = await import('../../../server/services/calls/departments.js');
const { __resetGlobalAdvancedRoutingCache } = await import('../../../server/services/calls/globalAdvancedRouting.js');

const config = {} as never;
const WS = 'ws-1';
const OWNER = 'u-owner';
const ALI = 'u-ali';
const BAHAR = 'u-bahar';
const SEO = 'u-seo';
const GONE = 'u-gone';
const NOW = Date.now();
const here = () => ({ state: 'active', lastActivityAt: NOW - 60_000 });
const away = () => ({ state: 'away', lastActivityAt: NOW - 10 * 60_000 });

function conversation(meta: Row = {}, fields: Row = {}): Row {
  const row: Row = {
    id: `c-${Math.random().toString(36).slice(2, 8)}`, workspace_id: WS, status: 'open', assigned_to: null, is_spam: false,
    contact_id: null, metadata: meta, updated_at: new Date().toISOString(), ...fields,
  };
  (state.db.tables.conversations ||= []).push(row);
  return row;
}
const conv = (id: unknown) => state.db.tables.conversations!.find((c) => c.id === id)!;
const human = (id: unknown, args: { reopened?: boolean } = {}) =>
  routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: id as string, ...args });
const releasedEvents = () => state.events.filter((e) => e.eventType === 'unassigned');

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.presence.clear();
  state.teamOffline = false;
  state.lockedMembers = [];
  state.full.clear();
  state.claims = [];
  state.events = [];
  state.operatorEvents = [];
  invalidateDepartmentCache(WS);
  __resetGlobalAdvancedRoutingCache();
  state.db.tables.workspaces = [{ id: WS, owner_id: OWNER }];
  state.db.tables.workspace_members = [
    { workspace_id: WS, user_id: OWNER, role: 'owner', suspended_at: null, receives_chats: true },
    { workspace_id: WS, user_id: ALI, role: 'support_agent', suspended_at: null, receives_chats: true, max_concurrent_chats: null },
    { workspace_id: WS, user_id: BAHAR, role: 'agent', suspended_at: null, receives_chats: true },
    { workspace_id: WS, user_id: SEO, role: 'seo_manager', suspended_at: null, receives_chats: true },
  ];
  state.db.tables.widget_settings = [{ workspace_id: WS, assignment_mode: 'auto', last_agent_routing_enabled: true, last_agent_window_days: 30, default_max_concurrent_chats: 5 }];
  // No pre-chat form (routing would wait for it: chatRoutingEngine.test.ts).
  state.db.tables.widget_prechat_settings = [{ workspace_id: WS, ask_name: false, ask_email: false, ask_phone: false, prechat_timing: 'never' }];
  state.db.tables.ai_agent_settings = [];
  state.db.tables.profiles = [{ id: ALI, full_name: 'Ali' }, { id: BAHAR, full_name: 'Bahar' }];
  state.db.rpc = (fn, args) => {
    if (fn === 'patch_conversation_metadata') {
      const row = conv(args.p_conversation_id);
      row.metadata = { ...(row.metadata as Row), ...(args.p_patch as Row) };
      return { data: true, error: null };
    }
    if (fn === 'chat_route_claim') {
      state.claims.push(args);
      const pick = (args.p_candidates as string[]).find((id) => !state.full.has(id)) ?? null;
      if (!pick) return { data: [{ outcome: 'none', picked_user_id: null }], error: null };
      conv(args.p_conversation_id).assigned_to = pick;
      return { data: [{ outcome: 'assigned', picked_user_id: pick }], error: null };
    }
    if (fn === 'chat_routing_release_member') {
      const ids: Row[] = [];
      for (const c of state.db.tables.conversations || []) {
        if (c.assigned_to === args.p_user_id && ['open', 'pending'].includes(String(c.status))) {
          c.assigned_to = null;
          ids.push({ conversation_id: c.id });
        }
      }
      return { data: ids, error: null };
    }
    return { data: null, error: null };
  };
});

describe('R-02 a thread the AI holds but will not answer is the team\'s', () => {
  it('suggest-only, or auto-reply-when-offline while the team is online: out of the AI\'s queue, routed', async () => {
    state.presence.set(ALI, here());
    for (const mode of ['suggest_only', 'auto_reply_when_offline']) {
      state.db.tables.ai_agent_settings = [{ workspace_id: WS, enabled: true, mode }];
      const c = conversation({ ai_state: 'ai_managed', managed_by_ai: true });
      expect(await human(c.id), mode).toEqual({ outcome: 'assigned_auto', assignedTo: ALI });
      expect(c.metadata, mode).toMatchObject({ ai_state: null, managed_by_ai: false });
      expect(state.operatorEvents).toContainEqual(expect.objectContaining({ conversation_id: c.id, reason: 'ai_not_answering' }));
    }
  });

  it('nobody can take it now: it still leaves the AI\'s queue (the ticker never retries an AI-held chat) and waits', async () => {
    state.db.tables.ai_agent_settings = [{ workspace_id: WS, enabled: true, mode: 'auto_reply_when_offline' }];
    const c = conversation({ ai_state: 'ai_managed' });
    expect(await human(c.id)).toEqual({ outcome: 'no_eligible_agent', assignedTo: null });
    expect((c.metadata as Row).ai_state).toBeNull();
  });

  it('the AI answers it (auto-reply always, or offline in when-offline): it stays the AI\'s', async () => {
    state.presence.set(ALI, here());
    state.db.tables.ai_agent_settings = [{ workspace_id: WS, enabled: true, mode: 'auto_reply_always' }];
    const always = conversation({ ai_state: 'ai_managed' });
    expect(await human(always.id)).toBeNull();
    state.db.tables.ai_agent_settings = [{ workspace_id: WS, enabled: true, mode: 'auto_reply_when_offline' }];
    state.teamOffline = true;
    const night = conversation({ ai_state: 'ai_managed' });
    expect(await human(night.id)).toBeNull();
    for (const c of [always, night]) expect((c.metadata as Row).ai_state).toBe('ai_managed');
    expect(state.claims).toEqual([]);
  });
});

describe('R-03 an operator who may not hold it any more loses it at the visitor\'s next message', () => {
  it('removed, suspended, staff without an Inbox, or a paused seat: released (system, with the method) and routed', async () => {
    state.presence.set(BAHAR, here());
    state.db.tables.workspace_members!.push({ workspace_id: WS, user_id: 'u-susp', role: 'agent', suspended_at: '2026-10-01T00:00:00Z', receives_chats: true });
    state.lockedMembers = ['u-paused'];
    state.db.tables.workspace_members!.push({ workspace_id: WS, user_id: 'u-paused', role: 'agent', suspended_at: null, receives_chats: true });
    for (const holder of [GONE, 'u-susp', SEO, 'u-paused']) {
      state.events = [];
      const c = conversation({}, { assigned_to: holder });
      expect(await human(c.id), holder).toEqual({ outcome: 'assigned_auto', assignedTo: BAHAR });
      expect(releasedEvents(), holder).toEqual([expect.objectContaining({ actorType: 'system', payload: { from: holder, to: null, method: 'assignee_unavailable' } })]);
    }
  });

  it('a member who may hold it keeps it, here or not (only a reopened thread asks more)', async () => {
    for (const holder of [ALI, OWNER]) {
      const c = conversation({}, { assigned_to: holder });
      expect(await human(c.id)).toBeNull();
      expect(c.assigned_to).toBe(holder);
    }
    expect(releasedEvents()).toEqual([]);
  });
});

describe('R-17 a reopened thread keeps its operator only when they could take it now', () => {
  const reopened = (holder: string, meta: Row = {}) => conversation({ routing_notice_sent: true, ...meta }, { assigned_to: holder });

  it('active, under capacity, within the window: kept, and its notices may be given again', async () => {
    state.presence.set(ALI, here());
    const c = reopened(ALI, { routing_thread_ended_at: new Date(NOW - 2 * 86400_000).toISOString() });
    expect(await human(c.id)).toBeNull();
    expect(c.assigned_to).toBe(ALI);
    expect(c.metadata).toMatchObject({ routing_notice_sent: false, routing_thread_ended_at: null });
    // The stamp is spent: the next message keeps it without asking again.
    state.presence.set(ALI, away());
    expect(await human(c.id)).toBeNull();
    expect(c.assigned_to).toBe(ALI);
  });

  it('away, at capacity, not receiving chats, past the window, or last-agent routing off: routed afresh', async () => {
    state.presence.set(BAHAR, here());
    // Routed afresh: Bahar where Ali cannot take it now; otherwise whoever
    // the distribution picks (the stand-in: the first candidate, Ali).
    const cases: Array<[string, () => Row, string]> = [
      ['away', () => { state.presence.set(ALI, away()); return reopened(ALI); }, BAHAR],
      ['at capacity', () => {
        state.presence.set(ALI, here());
        state.db.tables.workspace_members!.find((m) => m.user_id === ALI)!.max_concurrent_chats = 1;
        conversation({}, { assigned_to: ALI });
        state.full.add(ALI);
        return reopened(ALI);
      }, BAHAR],
      ['not receiving chats', () => {
        state.presence.set(ALI, here());
        state.db.tables.workspace_members!.find((m) => m.user_id === ALI)!.receives_chats = false;
        return reopened(ALI);
      }, BAHAR],
      ['past the window', () => { state.presence.set(ALI, here()); return reopened(ALI, { routing_thread_ended_at: new Date(NOW - 31 * 86400_000).toISOString() }); }, ALI],
      ['last-agent off', () => {
        state.presence.set(ALI, here());
        state.db.tables.widget_settings![0].last_agent_routing_enabled = false;
        return reopened(ALI);
      }, ALI],
    ];
    for (const [label, make, expected] of cases) {
      state.full.clear();
      state.db.tables.workspace_members!.find((m) => m.user_id === ALI)!.max_concurrent_chats = null;
      state.db.tables.workspace_members!.find((m) => m.user_id === ALI)!.receives_chats = true;
      state.db.tables.widget_settings![0].last_agent_routing_enabled = true;
      invalidateDepartmentCache(WS);
      state.events = [];
      const c = make();
      invalidateDepartmentCache(WS);
      state.claims = [];
      const res = await human(c.id, { reopened: true });
      expect(res?.assignedTo, label).toBe(expected);
      expect(state.claims[0], label).toMatchObject({ p_method: 'auto', p_expected_assignee: null });
      expect(releasedEvents(), label).toEqual([expect.objectContaining({ payload: { from: ALI, to: null, method: 'reopen_release' } })]);
      // Nothing in the thread: whoever gets it is introduced when they first write.
      expect((state.db.tables.conversation_messages || []).filter((m) => m.conversation_id === c.id).map((m) => (m.metadata as Row).kind), label)
        .toEqual([]);
    }
  });

  it('the resolve\'s stamp counts as a reopen without the lifecycle\'s flag (the widget\'s own "reopen")', async () => {
    state.presence.set(BAHAR, here());
    state.presence.set(ALI, away());
    const c = reopened(ALI, { routing_thread_ended_at: new Date(NOW - 3600_000).toISOString() });
    expect((await human(c.id))?.assignedTo).toBe(BAHAR);
  });
});

describe('released together: a member removed or suspended', () => {
  it('announced (inboxes and timeline), and only the recently active routed at once', async () => {
    state.presence.set(BAHAR, here());
    const recent = conversation({}, { assigned_to: ALI });
    const pending = conversation({}, { assigned_to: ALI, status: 'pending' });
    const stale = conversation({}, { assigned_to: ALI, updated_at: new Date(NOW - 3 * 86400_000).toISOString() });
    const done = conversation({}, { assigned_to: ALI, status: 'resolved' });
    const ids = await routing.releaseMemberChats(config, { workspaceId: WS, userId: ALI, method: 'member_suspended' });
    expect(new Set(ids)).toEqual(new Set([recent.id, pending.id, stale.id]));
    expect(recent.assigned_to).toBe(BAHAR);
    expect(pending.assigned_to).toBe(BAHAR);
    expect(stale.assigned_to).toBeNull();
    expect(done.assigned_to).toBe(ALI);
    expect(releasedEvents().map((e) => [e.conversationId, (e.payload as Row).method])).toEqual(
      expect.arrayContaining([[recent.id, 'member_suspended'], [pending.id, 'member_suspended'], [stale.id, 'member_suspended']]),
    );
    expect(state.operatorEvents.filter((e) => e.reason === 'member_suspended').map((e) => e.conversation_id).sort())
      .toEqual([recent.id, pending.id, stale.id].sort());
  });

  it('before 278b (no function): nothing released, never a failure', async () => {
    state.db.rpc = () => ({ data: null, error: { code: '42883', message: 'function public.chat_routing_release_member(uuid, uuid) does not exist' } });
    const c = conversation({}, { assigned_to: ALI });
    expect(await routing.releaseMemberChats(config, { workspaceId: WS, userId: ALI, method: 'member_suspended' })).toEqual([]);
    expect(c.assigned_to).toBe(ALI);
  });
});
