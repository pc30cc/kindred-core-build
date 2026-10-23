/**
 * The chat routing engine around its SQL pick (DECISIONS §3–§4): who it asks
 * chat_route_claim() for, in which order, and what it does with the answer.
 * The pick itself (load, capacity, rotation, the lock) is proven on a real
 * database in src/test/integration/chatRouting278.pg.test.ts; here the data
 * layer is an in-memory fake and chat_route_claim a stand-in that records
 * each call.
 *
 *   R-01  a conversation no AI will answer is routed at the visitor's
 *         message (AI off, suggest-only, auto-reply-when-offline with the
 *         team online); one the AI answers is left to the AI's handoff.
 *   R-12  only the owner and team roles, receiving chats, not suspended.
 *   R-11  active first; away only when idle under 30 minutes.
 *   R-13  the department, then the whole team — unless the general pool is
 *         off.
 *   R-14  a plan without automatic assignment queues.
 *   R-18  a round-robin rotation per pool.
 *   R-27  a resolved conversation written into again may be told again.
 *   R-08  the AI's hand-over line says "connecting you" only when routing
 *         can give the visitor someone now.
 *   the ticker hands each due row to the right step.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from '../conversations/fakeServiceDb';

const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  presence: new Map<string, { state: string; lastActivityAt: number | null }>(),
  planAllows: true,
  /** The plan read fails (resolveWidgetCapability's onUnreadable). */
  planUnreadable: false,
  handoffs: [] as Array<Record<string, unknown>>,
  /** chat_route_claim answers with an error (a timeout, a blip). */
  claimFails: false,
  platformAllowed: true,
  teamOffline: false,
  leased: true,
  claims: [] as Array<Record<string, unknown>>,
  /** The stand-in's answer per call (default: the first candidate). */
  claimAnswer: null as null | ((args: Record<string, unknown>) => { outcome: string; picked_user_id: string | null }),
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/services/widget/operatorPresence.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/operatorPresence.js')>()),
  readRoutingPresence: async (_c: unknown, _ws: string, ids: string[]) =>
    new Map(ids.filter((id) => state.presence.has(id)).map((id) => [id, state.presence.get(id)!])),
}));
vi.mock('../../../server/services/widget/entitlements.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/entitlements.js')>()),
  resolveWidgetCapability: async (_c: unknown, _w: unknown, _k: unknown, onUnreadable?: () => void) => {
    if (state.planUnreadable) { onUnreadable?.(); return false; }
    return state.planAllows;
  },
}));
vi.mock('../../../server/services/ai-agent/platformGuards.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/ai-agent/platformGuards.js')>()),
  isAutoAnswerAllowedForWorkspace: async () => (state.platformAllowed ? { allowed: true } : { allowed: false, reason: 'platform_ai_disabled' }),
}));
vi.mock('../../../server/services/ai-agent/availability.js', () => ({
  getOperatorAvailability: async () => ({ state: state.teamOffline ? 'offline' : 'online', reason: 'test', source: 'widget_resolver', schedule: null }),
}));
vi.mock('../../../server/services/billing/locks/state.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/billing/locks/state.js')>()),
  resolveLockState: async () => ({ enabled: false, kb: null, contact: null, member: null, conversation: null }),
}));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishOperatorEvent: async () => {},
  publishConversationEvent: async () => {},
  buildMessageEnvelope: (m: unknown) => m,
}));
vi.mock('../../../server/services/channels/outbound.js', () => ({ dispatchOutboundIfChannelConversation: async () => {} }));
vi.mock('../../../server/services/push/index.js', () => ({
  notifyAssignment: async () => {},
  notifyHandoff: async (_c: unknown, a: Record<string, unknown>) => { state.handoffs.push(a); },
}));
vi.mock('../../../server/services/platformSupport/changes.js', () => ({ onSupportConversationChanged: async () => {} }));
vi.mock('../../../server/services/conversationEvents.js', () => ({
  recordConversationEvent: async (_c: unknown, e: Record<string, unknown>) => { state.events.push(e); return { ok: true }; },
}));
vi.mock('../../../server/services/observability/tickerLease.js', () => ({
  acquireTickerLease: async () => state.leased,
  releaseTickerLease: async () => {},
}));

const routing = await import('../../../server/services/chatRouting.js');
const { runChatRoutingOnce } = await import('../../../server/services/chatRoutingTicker.js');
const { invalidateDepartmentCache } = await import('../../../server/services/calls/departments.js');
const { __resetGlobalAdvancedRoutingCache } = await import('../../../server/services/calls/globalAdvancedRouting.js');

const config = {} as never;
const WS = 'ws-1';
const OWNER = 'u-owner';
const ALI = 'u-ali';
const BAHAR = 'u-bahar';
const CYRUS = 'u-cyrus';
const ADMIN = 'u-admin';
const SEO = 'u-seo';
const NOW = Date.now();

const here = (msAgo = 60_000) => ({ state: 'active', lastActivityAt: NOW - msAgo });
const away = (idleMs: number) => ({ state: 'away', lastActivityAt: NOW - idleMs });

function conversation(meta: Row = {}, fields: Row = {}): Row {
  const row: Row = { id: `c-${Math.random().toString(36).slice(2, 8)}`, workspace_id: WS, status: 'open', assigned_to: null, is_spam: false, contact_id: null, metadata: meta, ...fields };
  (state.db.tables.conversations ||= []).push(row);
  return row;
}
const conv = (id: unknown) => state.db.tables.conversations!.find((c) => c.id === id)!;
const notices = (id: unknown) => (state.db.tables.conversation_messages || [])
  .filter((m) => m.conversation_id === id && m.sender_type === 'system').map((m) => (m.metadata as Row).kind);

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.presence.clear();
  state.planAllows = true;
  state.planUnreadable = false;
  state.handoffs = [];
  state.claimFails = false;
  state.platformAllowed = true;
  state.teamOffline = false;
  state.leased = true;
  state.claims = [];
  state.claimAnswer = null;
  state.events = [];
  invalidateDepartmentCache(WS);
  __resetGlobalAdvancedRoutingCache();
  state.db.tables.workspaces = [{ id: WS, owner_id: OWNER }];
  state.db.tables.workspace_members = [
    { workspace_id: WS, user_id: OWNER, role: 'owner', suspended_at: null, receives_chats: true },
    { workspace_id: WS, user_id: ALI, role: 'support_agent', suspended_at: null, receives_chats: true },
    { workspace_id: WS, user_id: BAHAR, role: 'agent', suspended_at: null, receives_chats: true },
    { workspace_id: WS, user_id: CYRUS, role: 'sales_agent', suspended_at: null, receives_chats: true },
    { workspace_id: WS, user_id: ADMIN, role: 'admin', suspended_at: null, receives_chats: true },
    { workspace_id: WS, user_id: SEO, role: 'seo_manager', suspended_at: null, receives_chats: true },
  ];
  state.db.tables.widget_settings = [{ workspace_id: WS, assignment_mode: 'auto', last_agent_routing_enabled: true, last_agent_window_days: 30 }];
  // No pre-chat form (routing would wait for it: see the pre-chat cases).
  state.db.tables.widget_prechat_settings = [{ workspace_id: WS, ask_name: false, ask_email: false, ask_phone: false, prechat_timing: 'never' }];
  state.db.tables.profiles = [{ id: ALI, full_name: 'Ali' }, { id: BAHAR, full_name: 'Bahar' }, { id: CYRUS, full_name: 'Cyrus' }, { id: OWNER, full_name: 'Owner' }];
  state.db.rpc = (fn, args) => {
    if (fn === 'patch_conversation_metadata') {
      const row = conv(args.p_conversation_id);
      row.metadata = { ...(row.metadata as Row), ...(args.p_patch as Row) };
      return { data: true, error: null };
    }
    if (fn === 'chat_route_claim') {
      state.claims.push(args);
      if (state.claimFails) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
      const answer = state.claimAnswer?.(args)
        ?? { outcome: 'assigned', picked_user_id: (args.p_candidates as string[])[0] ?? null };
      if (answer.outcome === 'assigned') conv(args.p_conversation_id).assigned_to = answer.picked_user_id;
      return { data: [answer], error: null };
    }
    if (fn === 'chat_routing_release') {
      const row = conv(args.p_conversation_id);
      if (row.assigned_to !== args.p_from) return { data: false, error: null };
      row.assigned_to = null;
      return { data: true, error: null };
    }
    return { data: null, error: null };
  };
});

describe('R-01 a conversation no AI will answer is routed at the visitor\'s message', () => {
  const settings = (row: Row | null) => { state.db.tables.ai_agent_settings = row ? [{ workspace_id: WS, ...row }] : []; };

  it('AI off (no settings, disabled, mode off), suggest-only, platform AI off: routed', async () => {
    state.presence.set(ALI, here());
    for (const [row, platformAiOff] of [
      [null, undefined], [{ enabled: false, mode: 'auto_reply_always' }, undefined], [{ enabled: true, mode: 'off' }, undefined],
      [{ enabled: true, mode: 'suggest_only' }, undefined], [{ enabled: true, mode: 'auto_reply_always' }, true],
    ] as Array<[Row | null, boolean | undefined]>) {
      settings(row);
      const c = conversation();
      const res = await routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: c.id as string, platformAiOff });
      expect(res, JSON.stringify(row)).toEqual({ outcome: 'assigned_auto', assignedTo: ALI });
    }
  });

  it('auto-reply when operators are offline: routed while the team is online, left to the AI while it is offline', async () => {
    state.presence.set(ALI, here());
    settings({ enabled: true, mode: 'auto_reply_when_offline' });
    const online = conversation();
    expect((await routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: online.id as string }))?.assignedTo).toBe(ALI);
    state.teamOffline = true;
    const offline = conversation();
    expect(await routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: offline.id as string })).toBeNull();
    expect(offline.assigned_to).toBeNull();
  });

  it('an AI that answers keeps it (its handoff routes it); a thread handed off or taken by a person is never the AI\'s', async () => {
    state.presence.set(ALI, here());
    settings({ enabled: true, mode: 'auto_reply_always' });
    const ai = conversation({ ai_state: 'ai_managed' });
    expect(await routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: ai.id as string })).toBeNull();
    expect(state.claims).toEqual([]);
    for (const aiState of ['needs_human', 'human_active']) {
      const c = conversation({ ai_state: aiState });
      expect((await routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: c.id as string }))?.assignedTo).toBe(ALI);
    }
    // The platform gate says no (channels pass no verdict of their own): routed.
    state.platformAllowed = false;
    const gated = conversation();
    expect((await routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: gated.id as string }))?.assignedTo).toBe(ALI);
  });

  it('an AI-held thread routing gives to a person leaves the AI\'s queue (it would be hidden from the Inbox)', async () => {
    state.presence.set(ALI, here());
    settings({ enabled: true, mode: 'auto_reply_when_offline' });
    const c = conversation({ ai_state: 'ai_managed' });
    await routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: c.id as string });
    // R-02: the AI will not answer it, so it is the team's before routing runs.
    expect(c.metadata).toMatchObject({ ai_state: null, managed_by_ai: false, routing_outcome: 'assigned_auto' });
    expect(state.events).toEqual([expect.objectContaining({ eventType: 'assigned', actorType: 'system', payload: { from: null, to: ALI, method: 'auto' } })]);
  });

  it('nothing to do: assigned, spam, resolved, or waiting for the pre-chat form', async () => {
    state.presence.set(ALI, here());
    for (const c of [
      conversation({}, { assigned_to: BAHAR }), conversation({}, { is_spam: true }),
      conversation({}, { status: 'resolved' }), conversation({ routing_pending: true, routing_pending_at: new Date().toISOString() }),
    ]) {
      expect(await routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: c.id as string, platformAiOff: true })).toBeNull();
    }
    expect(state.claims).toEqual([]);
  });

  it('R-27 a resolved conversation written into again is a new thread: its notices are given again', async () => {
    const c = conversation({ routing_notice_sent: true, routing_outcome: 'no_eligible_agent' });
    expect(await routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: c.id as string, platformAiOff: true, reopened: true }))
      .toEqual({ outcome: 'no_eligible_agent', assignedTo: null });
    expect(notices(c.id)).toEqual(['routing_no_agent_available']);
    // Without a reopen, the next message says nothing new.
    await routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: c.id as string, platformAiOff: true });
    expect(notices(c.id)).toEqual(['routing_no_agent_available']);
  });
});

describe('who routing asks chat_route_claim for', () => {
  const route = async (meta: Row = {}) => {
    const c = conversation(meta);
    const res = await routing.routeConversationToOperator(config, { workspaceId: WS, conversationId: c.id as string });
    return { c, res };
  };

  it('R-12 the owner and team roles only: staff, a member not receiving chats and a suspended one are never candidates', async () => {
    for (const id of [OWNER, ALI, BAHAR, CYRUS, ADMIN, SEO]) state.presence.set(id, here());
    state.db.tables.workspace_members!.find((m) => m.user_id === BAHAR)!.receives_chats = false;
    state.db.tables.workspace_members!.find((m) => m.user_id === CYRUS)!.suspended_at = '2026-10-01T00:00:00Z';
    await route();
    expect(state.claims).toHaveLength(1);
    expect(new Set(state.claims[0].p_candidates as string[])).toEqual(new Set([OWNER, ALI]));
    expect(state.claims[0]).toMatchObject({ p_order: 'least_busy', p_pool_key: 'team', p_method: 'auto', p_expected_assignee: null });
  });

  it('R-11 active first; away only if nobody active could take it, and only when idle under 30 minutes', async () => {
    state.presence.set(ALI, here());
    state.presence.set(BAHAR, away(10 * 60_000));
    state.presence.set(CYRUS, away(45 * 60_000));
    state.presence.set(OWNER, { state: 'disconnected', lastActivityAt: NOW });
    state.claimAnswer = (args) => ((args.p_candidates as string[]).includes(ALI)
      ? { outcome: 'all_busy', picked_user_id: null }
      : { outcome: 'assigned', picked_user_id: (args.p_candidates as string[])[0] });
    const { res } = await route();
    expect(state.claims.map((x) => x.p_candidates)).toEqual([[ALI], [BAHAR]]);
    expect(res).toEqual({ outcome: 'assigned_auto', assignedTo: BAHAR });
  });

  it('R-13 the department first, then the whole team; with the general pool off, the department only', async () => {
    state.db.tables.workspace_departments = [{ id: 'd-sales', workspace_id: WS, name: 'Sales', enabled: true, chat_enabled: true, sort_order: 0 }];
    state.db.tables.workspace_department_members = [{ workspace_id: WS, department_id: 'd-sales', user_id: CYRUS }];
    state.presence.set(ALI, here());
    // Cyrus (the department) is not here: the team.
    const first = await route({ department_id: 'd-sales' });
    expect(state.claims.map((x) => x.p_pool_key)).toEqual(['team']);
    expect(first.res.assignedTo).toBe(ALI);
    // Here, but at capacity: the department is tried first, then the team.
    state.claims = [];
    state.presence.set(CYRUS, here());
    state.claimAnswer = (args) => (args.p_pool_key === 'd-sales'
      ? { outcome: 'all_busy', picked_user_id: null }
      : { outcome: 'assigned', picked_user_id: ALI });
    await route({ department_id: 'd-sales' });
    expect(state.claims.map((x) => [x.p_pool_key, x.p_candidates])).toEqual([['d-sales', [CYRUS]], ['team', expect.arrayContaining([ALI, CYRUS])]]);
    // The Super Admin turned the general pool off: it waits, and says so.
    state.claims = [];
    state.db.tables.app_runtime_config = [{ key: 'global_advanced_routing', value: { general_pool_enabled: false, owner_fallback_enabled: false } }];
    __resetGlobalAdvancedRoutingCache();
    const waits = await route({ department_id: 'd-sales' });
    expect(state.claims.map((x) => x.p_pool_key)).toEqual(['d-sales']);
    expect(waits.res).toEqual({ outcome: 'all_agents_busy', assignedTo: null });
    expect(notices(waits.c.id)).toEqual(['routing_in_queue']);
    expect(state.db.rpcs.find((r) => r.fn === 'chat_routing_wait' && r.args.p_conversation_id === waits.c.id)?.args.p_reason).toBe('all_busy');
  });

  it('R-18 round robin: the rotation of the pool asked for (one cursor per department, one for the team)', async () => {
    state.db.tables.widget_settings![0].assignment_mode = 'round_robin';
    state.db.tables.workspace_departments = [{ id: 'd-support', workspace_id: WS, name: 'Support', enabled: true, chat_enabled: true, sort_order: 0 }];
    state.db.tables.workspace_department_members = [{ workspace_id: WS, department_id: 'd-support', user_id: BAHAR }];
    state.presence.set(BAHAR, here());
    state.presence.set(ALI, here());
    const viaDept = await route({ department_id: 'd-support' });
    const viaTeam = await route();
    expect(state.claims.map((x) => [x.p_order, x.p_pool_key, x.p_method])).toEqual([
      ['round_robin', 'd-support', 'round_robin'], ['round_robin', 'team', 'round_robin'],
    ]);
    expect(viaDept.res.outcome).toBe('assigned_round_robin');
    expect(viaTeam.res.outcome).toBe('assigned_round_robin');
  });

  it('R-14 a plan without automatic assignment queues, whatever the stored mode', async () => {
    state.planAllows = false;
    state.presence.set(ALI, here());
    const { c, res } = await route();
    expect(res).toEqual({ outcome: 'manual_queue', assignedTo: null });
    expect(state.claims).toEqual([]);
    expect(notices(c.id)).toEqual(['routing_in_queue']);
  });

  it('the returning visitor\'s operator is asked first, alone; the window and the switches decide whether to look', async () => {
    for (const id of [ALI, BAHAR]) state.presence.set(id, here());
    const previous = conversation({}, { contact_id: 'ct-1', assigned_to: BAHAR, status: 'resolved', updated_at: new Date(NOW - 3 * 86400_000).toISOString() });
    void previous;
    const c = conversation({}, { contact_id: 'ct-1' });
    const res = await routing.routeConversationToOperator(config, { workspaceId: WS, conversationId: c.id as string });
    expect(state.claims[0]).toMatchObject({ p_candidates: [BAHAR], p_order: 'given', p_method: 'last_agent' });
    expect(res).toEqual({ outcome: 'assigned_last_agent', assignedTo: BAHAR });
    // Switched off by the Super Admin: the normal distribution.
    state.claims = [];
    state.db.tables.app_runtime_config = [{ key: 'global_advanced_routing', value: { last_agent_routing_enabled: false } }];
    __resetGlobalAdvancedRoutingCache();
    const again = conversation({}, { contact_id: 'ct-1' });
    await routing.routeConversationToOperator(config, { workspaceId: WS, conversationId: again.id as string });
    expect(state.claims[0]).toMatchObject({ p_order: 'least_busy', p_method: 'auto' });
  });

  it('a first-response timeout asks for anyone but the holder, only while they still hold it', async () => {
    for (const id of [ALI, BAHAR]) state.presence.set(id, here());
    const c = conversation({}, { assigned_to: ALI });
    const res = await routing.reassignAfterFirstResponseTimeout(config, { workspaceId: WS, conversationId: c.id as string, from: ALI });
    expect(state.claims).toEqual([expect.objectContaining({ p_candidates: [BAHAR], p_expected_assignee: ALI, p_method: 'timeout_reassign' })]);
    expect(res).toEqual({ outcome: 'assigned_auto', assignedTo: BAHAR });
    expect(state.events).toEqual([expect.objectContaining({ payload: { from: ALI, to: BAHAR, method: 'timeout_reassign' } })]);
    // Nothing for the visitor yet: Bahar is introduced when she first writes.
    expect(notices(c.id)).toEqual([]);
    // Nobody else can: it leaves Ali all the same and waits for the next
    // operator (in everyone's Unassigned list), and the visitor is told so.
    state.claims = [];
    state.events = [];
    state.presence.delete(BAHAR);
    const lone = conversation({}, { assigned_to: ALI });
    expect(await routing.reassignAfterFirstResponseTimeout(config, { workspaceId: WS, conversationId: lone.id as string, from: ALI }))
      .toEqual({ outcome: 'no_eligible_agent', assignedTo: null });
    expect(lone.assigned_to).toBeNull();
    expect(state.db.rpcs.find((r) => r.fn === 'chat_routing_release')?.args).toEqual({
      p_workspace_id: WS, p_conversation_id: lone.id, p_from: ALI, p_reason: 'nobody_online',
    });
    expect(notices(lone.id)).toEqual(['routing_no_agent_available']);
    expect(state.events).toEqual([expect.objectContaining({ eventType: 'unassigned', payload: { from: ALI, to: null, method: 'timeout_release' } })]);
    // Someone took it meanwhile: nothing is released, nothing said.
    const taken = conversation({}, { assigned_to: BAHAR });
    expect((await routing.reassignAfterFirstResponseTimeout(config, { workspaceId: WS, conversationId: taken.id as string, from: ALI })).outcome)
      .toBe('not_routable');
    expect(notices(taken.id)).toEqual([]);
  });
});

describe('the routing ticker', () => {
  const dueRows = (rows: Row[]) => {
    const base = state.db.rpc!;
    state.db.rpc = (fn, args) => (fn === 'chat_routing_due' ? { data: rows, error: null } : base(fn, args));
  };

  it('does nothing without the lease, or before migration 278', async () => {
    state.leased = false;
    expect(await runChatRoutingOnce(config)).toEqual({ prechat: 0, waiting: 0, timeout: 0, assigned: 0 });
    expect(state.db.rpcs).toEqual([]);
    state.leased = true;
    state.db.rpc = () => ({ data: null, error: { code: '42883', message: 'function public.chat_routing_due(integer) does not exist' } });
    expect(await runChatRoutingOnce(config)).toEqual({ prechat: 0, waiting: 0, timeout: 0, assigned: 0 });
  });

  it('routes pre-chat and waiting chats, reassigns timeouts, and skips a workspace where nobody is online', async () => {
    const pre = conversation({ routing_pending: true });
    const waiting1 = conversation({ routing_notice_sent: true });
    const waiting2 = conversation({ routing_notice_sent: true });
    const timedOut = conversation({}, { assigned_to: BAHAR });
    dueRows([
      { due_conversation_id: waiting1.id, due_workspace_id: WS, due_kind: 'waiting', due_assignee: null },
      { due_conversation_id: waiting2.id, due_workspace_id: WS, due_kind: 'waiting', due_assignee: null },
      { due_conversation_id: pre.id, due_workspace_id: WS, due_kind: 'prechat', due_assignee: null },
      { due_conversation_id: timedOut.id, due_workspace_id: WS, due_kind: 'timeout', due_assignee: BAHAR },
    ]);
    // Nobody online: the first wait finds nobody, the second is not even
    // tried this pass; the timed-out chat leaves Bahar and waits too.
    expect(await runChatRoutingOnce(config)).toEqual({ prechat: 1, waiting: 1, timeout: 1, assigned: 0 });
    expect(pre.metadata).toMatchObject({ routing_pending: false });
    expect(timedOut.assigned_to).toBeNull();
    // The ticker's own retry is not activity (the wait backs off, and is
    // forgotten after a day); the pre-chat row's first routing is.
    const waitOf = (id: unknown) => state.db.rpcs.find((r) => r.fn === 'chat_routing_wait' && r.args.p_conversation_id === id)?.args;
    expect(waitOf(waiting1.id)).toMatchObject({ p_reason: 'nobody_online', p_from_ticker: true });
    expect(waitOf(pre.id)).toMatchObject({ p_from_ticker: false });
    timedOut.assigned_to = BAHAR; // (as if Bahar had taken it back by hand)
    // Someone is here now (the database hands the pre-chat row out once).
    state.presence.set(ALI, here());
    dueRows([
      { due_conversation_id: waiting1.id, due_workspace_id: WS, due_kind: 'waiting', due_assignee: null },
      { due_conversation_id: waiting2.id, due_workspace_id: WS, due_kind: 'waiting', due_assignee: null },
      { due_conversation_id: timedOut.id, due_workspace_id: WS, due_kind: 'timeout', due_assignee: BAHAR },
    ]);
    expect(await runChatRoutingOnce(config)).toEqual({ prechat: 0, waiting: 2, timeout: 1, assigned: 3 });
    expect(waiting1.assigned_to).toBe(ALI);
    expect(waiting2.assigned_to).toBe(ALI);
    expect(timedOut.assigned_to).toBe(ALI);
  });
});

describe('R-08 the AI\'s hand-over line follows who routing can give the visitor', () => {
  it('"connecting you" only while a member who receives chats is here; staff being here does not count', async () => {
    const { resolveHandoffAckMessage } = await import('../../../server/services/ai-agent/engine/helpers.js');
    // Business hours off and nobody set a status: the widget reads online.
    state.presence.set(ADMIN, here());
    state.presence.set(SEO, here());
    expect(await routing.anyChatOperatorPresent(config, WS)).toBe(false);
    const offline = await resolveHandoffAckMessage(config, WS, 'en', false, 'CONNECTING', null);
    expect(offline).not.toBe('CONNECTING');
    state.presence.set(BAHAR, away(5 * 60_000 + 1));
    expect(await routing.anyChatOperatorPresent(config, WS)).toBe(true);
    expect(await resolveHandoffAckMessage(config, WS, 'en', false, 'CONNECTING', null)).toBe('CONNECTING');
  });
});

describe('what a routing run leaves behind', () => {
  const rpcsOf = (fn: string, id: unknown) => state.db.rpcs.filter((r) => r.fn === fn && r.args.p_conversation_id === id);

  it('no "The AI handed this conversation to your team" push for a chat the AI never had; one when the AI lets go of one', async () => {
    // AI off, Manual: queued, no handoff push (the message push already went).
    state.db.tables.widget_settings![0].assignment_mode = 'manual';
    const queued = conversation();
    expect((await routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: queued.id as string, platformAiOff: true }))?.outcome)
      .toBe('manual_queue');
    // AI off, Auto, nobody online: it waits, no handoff push either.
    state.db.tables.widget_settings![0].assignment_mode = 'auto';
    const waiting = conversation();
    expect((await routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: waiting.id as string, platformAiOff: true }))?.outcome)
      .toBe('no_eligible_agent');
    expect(state.handoffs).toEqual([]);
    // A thread the AI held but will not answer: the team's now, told once.
    state.db.tables.ai_agent_settings = [{ workspace_id: WS, enabled: true, mode: 'suggest_only' }];
    const held = conversation({ ai_state: 'ai_managed' });
    await routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: held.id as string });
    await routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: held.id as string });
    expect(state.handoffs).toEqual([expect.objectContaining({ conversationId: held.id, handoffAt: (held.metadata as Row).ai_handoff_at })]);
  });

  it('the ticker retrying a waiting chat with the same answer writes nothing (its updated_at stays)', async () => {
    const c = conversation({ routing_notice_sent: true, routing_outcome: 'no_eligible_agent' });
    const before = state.db.rpcs.length;
    expect(await routing.routeConversationToOperator(config, { workspaceId: WS, conversationId: c.id as string }, { fromTicker: true }))
      .toEqual({ outcome: 'no_eligible_agent', assignedTo: null });
    expect(state.db.rpcs.slice(before).filter((r) => r.fn === 'patch_conversation_metadata')).toEqual([]);
    // A changed answer (someone is here now, but at capacity) is tagged.
    state.presence.set(ALI, here());
    state.claimAnswer = () => ({ outcome: 'all_busy', picked_user_id: null });
    expect((await routing.routeConversationToOperator(config, { workspaceId: WS, conversationId: c.id as string }, { fromTicker: true })).outcome)
      .toBe('all_agents_busy');
    expect(c.metadata).toMatchObject({ routing_outcome: 'all_agents_busy' });
  });

  it('a pre-chat wait with no start, or past its grace, no longer holds routing; a fresh one does', async () => {
    state.presence.set(ALI, here());
    const fresh = conversation({ routing_pending: true, routing_pending_at: new Date().toISOString() });
    const stale = conversation({ routing_pending: true, routing_pending_at: new Date(Date.now() - 3 * 60_000).toISOString() });
    const legacy = conversation({ routing_pending: true });
    expect(await routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: fresh.id as string, platformAiOff: true })).toBeNull();
    for (const c of [stale, legacy]) {
      expect(await routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: c.id as string, platformAiOff: true }))
        .toEqual({ outcome: 'assigned_auto', assignedTo: ALI });
      expect(c.metadata).toMatchObject({ routing_pending: false });
    }
    expect(routing.prechatWaitOver({ routing_pending_at: new Date().toISOString() })).toBe(false);
    expect(routing.prechatWaitOver({})).toBe(true);
  });

  it('a claim that fails waits for the ticker (nothing told, nothing tagged, a pre-chat flag kept)', async () => {
    state.presence.set(ALI, here());
    state.claimFails = true;
    const c = conversation({ routing_pending: true });
    expect(await routing.routeConversationToOperator(config, { workspaceId: WS, conversationId: c.id as string }))
      .toEqual({ outcome: 'error', assignedTo: null });
    expect(rpcsOf('chat_routing_wait', c.id).map((r) => r.args.p_reason)).toEqual(['all_busy']);
    expect(notices(c.id)).toEqual([]);
    expect(c.metadata).toEqual({ routing_pending: true });
  });

  it('a plan that cannot be read keeps the stored mode for the run (not Manual); a plan without routing is Manual', async () => {
    state.presence.set(ALI, here());
    state.planUnreadable = true;
    expect((await routing.routeConversationToOperator(config, { workspaceId: WS, conversationId: conversation().id as string })).outcome)
      .toBe('assigned_auto');
    state.planUnreadable = false;
    state.planAllows = false;
    expect((await routing.routeConversationToOperator(config, { workspaceId: WS, conversationId: conversation().id as string })).outcome)
      .toBe('manual_queue');
  });

  it('a chat transferred to a department stays inside it: not the team, not the owner; nobody there = it waits', async () => {
    state.db.tables.workspace_departments = [{ id: 'd-sales', workspace_id: WS, name: 'Sales', enabled: true, chat_enabled: true, sort_order: 0 }];
    state.db.tables.workspace_department_members = [{ workspace_id: WS, department_id: 'd-sales', user_id: CYRUS }];
    state.presence.set(ALI, here());
    state.presence.set(OWNER, here());
    const c = conversation({ department_id: 'd-sales', routing_department_only: true });
    expect(await routing.routeConversationToOperator(config, { workspaceId: WS, conversationId: c.id as string }))
      .toEqual({ outcome: 'no_eligible_agent', assignedTo: null });
    expect(state.claims).toEqual([]);
    state.presence.set(CYRUS, here());
    expect(await routing.routeConversationToOperator(config, { workspaceId: WS, conversationId: c.id as string }))
      .toEqual({ outcome: 'assigned_auto', assignedTo: CYRUS });
    expect(state.claims.map((x) => x.p_pool_key)).toEqual(['d-sales']);
    // A visitor's own department choice still falls back to the team.
    state.claims = [];
    state.presence.delete(CYRUS);
    const picked = conversation({ department_id: 'd-sales' });
    expect((await routing.routeConversationToOperator(config, { workspaceId: WS, conversationId: picked.id as string })).assignedTo).not.toBeNull();
    expect(state.claims.map((x) => x.p_pool_key)).toEqual(['team']);
  });

  it('a message left in the leave-a-message form is routed, without a visitor notice', async () => {
    const nobody = conversation();
    expect(await routing.routeOfflineCapture(config, { workspaceId: WS, conversationId: nobody.id as string }))
      .toEqual({ outcome: 'no_eligible_agent', assignedTo: null });
    expect(rpcsOf('chat_routing_wait', nobody.id).map((r) => r.args.p_reason)).toEqual(['nobody_online']);
    expect(notices(nobody.id)).toEqual([]);
    state.presence.set(BAHAR, here());
    const someone = conversation();
    expect(await routing.routeOfflineCapture(config, { workspaceId: WS, conversationId: someone.id as string }))
      .toEqual({ outcome: 'assigned_auto', assignedTo: BAHAR });
  });
});

describe('routing waits for the pre-chat form only while the visitor is asked one', () => {
  const visitorContact = (fields: Row = {}) => {
    const id = `ct-${Math.random().toString(36).slice(2, 8)}`;
    (state.db.tables.contacts ||= []).push({ id, workspace_id: WS, name: 'Visitor', email: null, phone: null, metadata: {}, ...fields });
    return id;
  };
  const first = (c: Row) => routing.routeHumanBoundConversation(config, { workspaceId: WS, conversationId: c.id as string, platformAiOff: true });
  beforeEach(() => { state.presence.set(ALI, here()); });

  it('a workspace that never saved its form asks the default one: routing waits, once per conversation', async () => {
    state.db.tables.widget_prechat_settings = [];
    const c = conversation({}, { contact_id: visitorContact() });
    expect(await first(c)).toEqual({ outcome: 'routing_deferred', assignedTo: null });
    expect(c.metadata).toMatchObject({ routing_pending: true });
    // The grace ran out (the ticker routed it, or not yet): the next message
    // routes it, and the conversation is never held for the form again.
    c.metadata = { ...(c.metadata as Row), routing_pending: false };
    expect(await first(c)).toEqual({ outcome: 'assigned_auto', assignedTo: ALI });
  });

  it('timing "never", nothing asked, a channel, a form already sent (even empty) or real details: routed at once', async () => {
    const cases: Array<[string, Row | null, Row, Row]> = [
      ['timing never', { ask_name: true, ask_email: true, prechat_timing: 'never' }, {}, {}],
      ['nothing asked', { ask_name: false, ask_email: false, ask_phone: false, prechat_timing: 'always' }, {}, {}],
      ['a channel', null, { channel: 'telegram' }, {}],
      ['form sent empty', null, {}, { metadata: { prechat_submitted_at: '2026-10-22T08:00:00Z' } }],
      ['real details', null, {}, { email: 'a@b.test' }],
    ];
    for (const [label, row, meta, contactFields] of cases) {
      state.db.tables.widget_prechat_settings = row ? [{ workspace_id: WS, ...row }] : [];
      const c = conversation(meta, { contact_id: visitorContact(contactFields) });
      expect(await first(c), label).toEqual({ outcome: 'assigned_auto', assignedTo: ALI });
    }
  });
});
