// @vitest-environment node
/**
 * The inactivity close's ticker (server/services/conversationIdleCloseTicker.ts,
 * migration 284), one pass at a time against an in-memory data layer with the
 * SQL functions stubbed (the SQL itself: src/test/integration/
 * conversationIdleClose284.pg.test.ts):
 *
 *   - the Super Admin's switch off (or unreadable, or before 284): no lease,
 *     no RPC, a `[idle-close] pass off` log;
 *   - before 284 (42883) a pass is a quiet no-op;
 *   - the visitor's line is prepared only when they ever wrote, and a failed
 *     preparation leaves the conversation for the next pass (never closed
 *     without its line);
 *   - a close the database refused ('changed', a guard) publishes nothing
 *     and is counted;
 *   - a close is published as the PATCH publishes one: conversation_resolved
 *     from open or pending, conversation_updated from resolved, actor null,
 *     the unchanged updated_at, the timeline echo, and the line's envelope
 *     only when a line was written, once the race grace is over and only
 *     while the close stands (a racing message's reopen retracted it);
 *   - nothing else: no transcript, no push, no notification e-mail, no
 *     audit row;
 *   - a throw still releases the lease.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from './fakeServiceDb';

const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  operatorEvents: [] as Array<Record<string, unknown>>,
  conversationEvents: [] as Array<{ ws: string; cid: string; envelope: Record<string, unknown> }>,
  prepared: [] as Array<Record<string, unknown>>,
  line: null as { body: string; metadata: Record<string, unknown> } | null,
  prepareFails: new Set<string>(),
  forbidden: [] as string[],
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishOperatorEvent: async (_c: unknown, p: Record<string, unknown>) => { state.operatorEvents.push(p); },
  publishConversationEvent: async (_c: unknown, ws: string, cid: string, envelope: Record<string, unknown>) => {
    state.conversationEvents.push({ ws, cid, envelope });
    return { ok: true };
  },
  buildMessageEnvelope: (m: Record<string, unknown>) => ({ type: 'message', payload: m }),
}));
vi.mock('../../../server/services/conversationClosedNotice.js', () => ({
  prepareClosedLine: async (_c: unknown, input: Record<string, unknown>) => {
    state.prepared.push(input);
    if (state.prepareFails.has(String(input.conversationId))) throw new Error('conversation_messages unavailable');
    return state.line;
  },
}));
// What a close must never reach (the ticker does not import them; were it
// to, these would count).
vi.mock('../../../server/services/notificationEmail/producers.js', () => ({
  queueTranscript: async () => { state.forbidden.push('queueTranscript'); },
}));
vi.mock('../../../server/services/push/index.js', () => ({
  notifyInboundMessage: async () => { state.forbidden.push('push'); },
  notifyAssignment: async () => { state.forbidden.push('push'); },
}));
vi.mock('../../../server/services/conversationEvents.js', () => ({
  recordConversationEvent: async () => { state.forbidden.push('recordConversationEvent'); return { ok: true }; },
  recordAuditAndEvent: async () => { state.forbidden.push('recordAuditAndEvent'); },
}));

const { runConversationIdleCloseOnce, __setIdleCloseLineDelayForTests } = await import('../../../server/services/conversationIdleCloseTicker.js');
const { __resetInactivityCloseSettingsCache } = await import('../../../server/services/widget/platformSettings.js');

const config = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } as never;
const WS = '11111111-1111-4111-8111-111111111111';
const UPDATED = '2026-10-24T08:00:00.123456+00:00';

type Rpc = (args: Record<string, unknown>) => { data: unknown; error: unknown };
let dueRpc: Rpc;
let closeRpc: Rpc;

const dueRow = (over: Row = {}): Row => ({
  due_conversation_id: crypto.randomUUID(), due_workspace_id: WS, due_status: 'open', due_updated_at: UPDATED,
  due_last_exchange_at: '2026-10-23T08:00:00Z', due_has_visitor_turn: true, due_idle_hours: 24, due_closed_outcome: 'human', ...over,
});
const closedAnswer = (over: Row = {}): Row => ({
  closed: true, outcome: 'closed', workspace_id: WS, from_status: 'open', closed_at: '2026-10-25T08:00:00Z',
  event_id: 'ev-1', event_type: 'resolved', event_created_at: '2026-10-25T08:00:00Z', line_id: null, line_created_at: null,
  closed_outcome: 'human', ...over,
});
const calls = (fn: string) => state.db.rpcs.filter((r) => r.fn === fn);

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.db.tables.widget_platform_settings = [{ id: 'p', inactivity_close_enabled: true, inactivity_close_default_hours: 24 }];
  state.operatorEvents = [];
  state.conversationEvents = [];
  state.prepared = [];
  state.line = { body: 'The conversation was closed', metadata: { kind: 'conversation_closed', by: 'system', closed_reason: 'inactivity' } };
  state.forbidden = [];
  state.prepareFails = new Set();
  __setIdleCloseLineDelayForTests(0);
  dueRpc = () => ({ data: [], error: null });
  closeRpc = () => ({ data: [closedAnswer()], error: null });
  state.db.rpc = (fn, args) => {
    if (fn === 'observability_try_acquire_ticker_lease') return { data: true, error: null };
    if (fn === 'observability_release_ticker_lease') return { data: null, error: null };
    if (fn === 'conversation_idle_due') return dueRpc(args);
    if (fn === 'conversation_close_if_idle') return closeRpc(args);
    return { data: null, error: null };
  };
  __resetInactivityCloseSettingsCache();
});

describe('switched off', () => {
  it('takes no lease and calls nothing, and says so', async () => {
    state.db.tables.widget_platform_settings = [{ id: 'p', inactivity_close_enabled: false, inactivity_close_default_hours: 24 }];
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    expect(await runConversationIdleCloseOnce(config)).toEqual({ due: 0, closed: 0, skipped: {} });
    expect(state.db.rpcs).toEqual([]);
    expect(log).toHaveBeenCalledWith('[idle-close] pass off');
    log.mockRestore();
  });

  it('an unreadable platform row, or one before 284 (no such columns), reads off', async () => {
    state.db.failing.add('widget_platform_settings');
    expect(await runConversationIdleCloseOnce(config)).toMatchObject({ due: 0 });
    __resetInactivityCloseSettingsCache();
    state.db.failing.clear();
    state.db.tables.widget_platform_settings = [{ id: 'p' }];
    expect(await runConversationIdleCloseOnce(config)).toMatchObject({ due: 0 });
    expect(state.db.rpcs).toEqual([]);
  });
});

describe('a pass', () => {
  it('before 284 (42883) is a quiet no-op, and releases the lease', async () => {
    dueRpc = () => ({ data: null, error: { code: '42883', message: 'function public.conversation_idle_due(integer) does not exist' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await runConversationIdleCloseOnce(config)).toEqual({ due: 0, closed: 0, skipped: {} });
    expect(warn).not.toHaveBeenCalled();
    expect(calls('observability_release_ticker_lease')).toHaveLength(1);
    expect(calls('conversation_close_if_idle')).toEqual([]);
    warn.mockRestore();
  });

  it('asks for at most 50 due rows, and nothing when another replica holds the lease', async () => {
    await runConversationIdleCloseOnce(config);
    expect(calls('conversation_idle_due')).toEqual([{ fn: 'conversation_idle_due', args: { p_limit: 50 } }]);
    state.db.rpcs.length = 0;
    const rpc = state.db.rpc!;
    state.db.rpc = (fn, args) => (fn === 'observability_try_acquire_ticker_lease' ? { data: false, error: null } : rpc(fn, args));
    await runConversationIdleCloseOnce(config);
    expect(calls('conversation_idle_due')).toEqual([]);
  });

  it('prepares the visitor\'s line only when they ever wrote, and hands it to the close with the updated_at it read', async () => {
    const talked = dueRow();
    const greeting = dueRow({ due_has_visitor_turn: false, due_closed_outcome: 'no_visitor_message' });
    dueRpc = () => ({ data: [talked, greeting], error: null });
    expect(await runConversationIdleCloseOnce(config)).toEqual({ due: 2, closed: 2, skipped: {} });
    expect(state.prepared).toEqual([{ workspaceId: WS, conversationId: talked.due_conversation_id, by: 'system' }]);
    expect(calls('conversation_close_if_idle').map((c) => c.args)).toEqual([
      { p_conversation_id: talked.due_conversation_id, p_expected_updated_at: UPDATED, p_source: 'timer', p_line_body: state.line!.body, p_line_metadata: state.line!.metadata },
      { p_conversation_id: greeting.due_conversation_id, p_expected_updated_at: UPDATED, p_source: 'timer', p_line_body: null, p_line_metadata: null },
    ]);
  });

  it('a close the database refused publishes nothing and is counted by why', async () => {
    dueRpc = () => ({ data: [dueRow(), dueRow(), dueRow()], error: null });
    const outcomes = ['changed', 'needs_reply', 'changed'];
    closeRpc = () => ({ data: [closedAnswer({ closed: false, outcome: outcomes.shift(), event_id: null, event_type: null })], error: null });
    expect(await runConversationIdleCloseOnce(config)).toEqual({ due: 3, closed: 0, skipped: { changed: 2, needs_reply: 1 } });
    expect(state.operatorEvents).toEqual([]);
    expect(state.conversationEvents).toEqual([]);
  });

  it('publishes a close as the PATCH does: conversation_resolved from open or pending, conversation_updated from resolved; actor null; the timeline echo', async () => {
    const open = dueRow({ due_status: 'open' });
    const pending = dueRow({ due_status: 'pending' });
    const resolved = dueRow({ due_status: 'resolved' });
    dueRpc = () => ({ data: [open, pending, resolved], error: null });
    closeRpc = (args) => {
      const row = [open, pending, resolved].find((r) => r.due_conversation_id === args.p_conversation_id)!;
      const from = String(row.due_status);
      return { data: [closedAnswer({ from_status: from, event_id: `ev-${from}`, event_type: from === 'resolved' ? 'status_changed' : 'resolved' })], error: null };
    };
    expect(await runConversationIdleCloseOnce(config)).toMatchObject({ closed: 3 });
    const lists = state.operatorEvents.filter((e) => e.kind !== 'timeline_event');
    expect(lists).toEqual([open, pending, resolved].map((r) => ({
      kind: r.due_status === 'resolved' ? 'conversation_updated' : 'conversation_resolved',
      conversation_id: r.due_conversation_id,
      workspace_id: WS,
      actor_id: null,
      changes: { status: { from: r.due_status, to: 'closed' } },
      reason: 'inactivity',
      updated_at: UPDATED,
    })));
    expect(state.operatorEvents.filter((e) => e.kind === 'timeline_event')).toEqual([open, pending, resolved].map((r) => ({
      kind: 'timeline_event',
      conversation_id: r.due_conversation_id,
      workspace_id: WS,
      actor_id: null,
      event_id: `ev-${r.due_status}`,
      event_type: r.due_status === 'resolved' ? 'status_changed' : 'resolved',
      actor_type: 'system',
      created_at: '2026-10-25T08:00:00Z',
    })));
    // No line was written: nothing for the visitor's channel.
    expect(state.conversationEvents).toEqual([]);
  });

  /** A due row whose close wrote the line `line-1` (the conversation closed, naming it). */
  const closedWithLine = () => {
    const row = dueRow();
    dueRpc = () => ({ data: [row], error: null });
    state.db.tables.conversations = [{
      id: row.due_conversation_id, workspace_id: WS, status: 'closed',
      metadata: { closed_reason: 'inactivity', closed_line_id: 'line-1' },
    }];
    state.db.tables.conversation_messages = [{
      id: 'line-1', conversation_id: row.due_conversation_id, sender_type: 'system', body: 'The conversation was closed',
      metadata: { kind: 'conversation_closed', by: 'system', agent_name: null }, created_at: '2026-10-25T08:00:00Z', seen_at: null,
    }];
    closeRpc = () => ({ data: [closedAnswer({ line_id: 'line-1', line_created_at: '2026-10-25T08:00:00Z' })], error: null });
    return row;
  };

  it('the visitor\'s line, once written, goes out as a message envelope', async () => {
    const row = closedWithLine();
    await runConversationIdleCloseOnce(config);
    await vi.waitFor(() => expect(state.conversationEvents).toHaveLength(1));
    expect(state.conversationEvents[0]).toMatchObject({
      ws: WS, cid: row.due_conversation_id,
      envelope: { type: 'message', payload: { id: 'line-1', sender_type: 'system', body: 'The conversation was closed', metadata: { kind: 'conversation_closed', by: 'system' } } },
    });
  });

  it('the line waits for the race grace (60 s), and never goes out once a racing message or a reply reopened the conversation', async () => {
    __setIdleCloseLineDelayForTests(null);
    vi.useFakeTimers();
    try {
      closedWithLine();
      await runConversationIdleCloseOnce(config);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(state.conversationEvents).toEqual([]);
      // The Inbox heard at once.
      expect(state.operatorEvents.map((e) => e.kind)).toEqual(['conversation_resolved', 'timeline_event']);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(state.conversationEvents).toHaveLength(1));

      // The visitor's message in flight at the close reopened it and
      // retracted the line (conversation_reopen_after_idle_close).
      state.conversationEvents.length = 0;
      closedWithLine();
      await runConversationIdleCloseOnce(config);
      state.db.tables.conversation_messages![0].metadata = { kind: 'conversation_closed', by: 'system', internal: true };
      state.db.tables.conversations![0].status = 'open';
      state.db.tables.conversations![0].metadata = { idle_close_undone_at: '2026-10-25T08:00:01Z' };
      await vi.advanceTimersByTimeAsync(61_000);
      // A person's reply reopened it (the markers cleared, the line not retracted).
      closedWithLine();
      await runConversationIdleCloseOnce(config);
      state.db.tables.conversations![0].status = 'open';
      state.db.tables.conversations![0].metadata = { closed_reason: null, closed_line_id: null };
      await vi.advanceTimersByTimeAsync(61_000);
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 10));
      expect(state.conversationEvents).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a line that could not be prepared leaves the conversation for the next pass: no close, counted, the others go on', async () => {
    const failing = dueRow();
    const fine = dueRow();
    dueRpc = () => ({ data: [failing, fine], error: null });
    state.prepareFails.add(String(failing.due_conversation_id));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await runConversationIdleCloseOnce(config)).toEqual({ due: 2, closed: 1, skipped: { error: 1 } });
    expect(calls('conversation_close_if_idle').map((c) => c.args.p_conversation_id)).toEqual([fine.due_conversation_id]);
    expect(state.operatorEvents.map((e) => e.conversation_id)).not.toContain(failing.due_conversation_id);
    expect(warn).toHaveBeenCalledWith('[idle-close] line not prepared, left for the next pass:', 'conversation_messages unavailable');
    warn.mockRestore();
  });

  it('never reaches a transcript, a push, a notification e-mail, an audit row or the AI', async () => {
    dueRpc = () => ({ data: [dueRow(), dueRow({ due_status: 'resolved' })], error: null });
    await runConversationIdleCloseOnce(config);
    await new Promise((r) => setTimeout(r, 10));
    expect(state.forbidden).toEqual([]);
    const src = readFileSync('server/services/conversationIdleCloseTicker.ts', 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.filter((m) => /push|notificationEmail|conversationEvents|ai-agent|platformSupport|transcript/i.test(m))).toEqual([]);
  });

  it('a throw still releases the lease, and the pass answers', async () => {
    dueRpc = () => { throw new Error('connection reset'); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(runConversationIdleCloseOnce(config)).resolves.toEqual({ due: 0, closed: 0, skipped: {} });
    expect(calls('observability_release_ticker_lease')).toHaveLength(1);
    // A close that throws is counted and the pass goes on.
    dueRpc = () => ({ data: [dueRow(), dueRow()], error: null });
    let n = 0;
    closeRpc = () => { if (n++ === 0) throw new Error('boom'); return { data: [closedAnswer()], error: null }; };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await runConversationIdleCloseOnce(config)).toEqual({ due: 2, closed: 1, skipped: { error: 1 } });
    expect(calls('observability_release_ticker_lease')).toHaveLength(2);
    err.mockRestore();
    warn.mockRestore();
  });
});
