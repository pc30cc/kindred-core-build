// @vitest-environment node
/**
 * A channel customer's message that raced an inactivity close (migration 286),
 * through the REAL processInboundMessage (services/channels/inboundProcessing.ts)
 * against the shared in-memory data layer, with the SQL functions modelled:
 *
 *   - the close committed before the message: a Telegram, Bale, WhatsApp,
 *     Instagram or X message within the channel grace (600 s, the queue's
 *     wait) brings back the conversation it would have gone to, as it was:
 *     the same conversation, no `created` event, the lifecycle, the AI and
 *     routing from the restored status;
 *   - the close committed while the message was being inserted: the touch
 *     reads `closed`, and the conversation comes back with the message's id;
 *   - past the grace, after an operator's close, or with a newer live
 *     conversation on the thread: as before (a new conversation, or that one);
 *   - a menu tap never brings anything back; a duplicate delivery, or two
 *     messages at once, bring it back once.
 *
 * The SQL of the reopen itself: src/test/integration/conversationIdleClose284.pg.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from '../conversations/fakeServiceDb';

const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  installation: null as { id: string; settings: Record<string, unknown> } | null,
  events: [] as Array<Record<string, unknown>>,
  operatorEvents: [] as Array<Record<string, unknown>>,
  lifecycle: [] as Array<Record<string, unknown>>,
  aiRuns: [] as Array<Record<string, unknown>>,
  routed: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/services/plugins/state.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/plugins/state.js')>()),
  getInstallation: async () => state.installation,
}));
vi.mock('../../../server/services/channels/telegram/settings.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/channels/telegram/settings.js')>()),
  resolveTelegramHandlingMode: async () => ({ mode: 'human_only', aiAvailable: false }),
}));
// The bot's own flow (screens, the away notice, the department picker) is not
// the subject: it reads a slash command as the real one does. The check made
// before a conversation is chosen (isTelegramMenuInput) runs for real.
vi.mock('../../../server/services/channels/telegram/runtime.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/channels/telegram/runtime.js')>();
  const { commandKeyFromText, parseTelegramSettings } = await import('../../../server/services/channels/telegram/settings.js');
  const { matchReplyKeyboardCommand } = await import('../../../server/services/channels/telegram/menu.js');
  return {
    ...real,
    handleTelegramInboundFlow: async (_c: unknown, input: { text: string }) => ({
      aiAllowed: true,
      handled: false,
      locale: 'fa',
      command: state.installation
        ? commandKeyFromText(input.text) ?? matchReplyKeyboardCommand(parseTelegramSettings(state.installation.settings), input.text)
        : null,
    }),
  };
});
vi.mock('../../../server/services/channels/telegram/avatarSync.js', () => ({ syncTelegramContactAvatar: async () => undefined }));
vi.mock('../../../server/services/channels/telegram/mediaIngest.js', () => ({
  requestTelegramMediaFetch: async (_c: unknown, a: { attachments: unknown[] }) => ({ outcomes: a.attachments }),
}));
vi.mock('../../../server/services/conversationEvents.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/conversationEvents.js')>()),
  recordConversationEvent: async (_c: unknown, e: Record<string, unknown>) => { state.events.push(e); return { ok: true }; },
}));
vi.mock('../../../server/services/conversationLifecycle.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/conversationLifecycle.js')>()),
  applyInboundConversationLifecycle: async (_c: unknown, a: Record<string, unknown>) => {
    state.lifecycle.push(a);
    return { transition: a.knownStatus === 'resolved' ? 'reopened_resolved' : a.knownStatus === 'pending' ? 'resumed_pending' : 'none', reason: 'test' };
  },
}));
vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async () => ({ ok: true }),
  publishOperatorEvent: async (_c: unknown, p: Record<string, unknown>) => { state.operatorEvents.push(p); },
}));
vi.mock('../../../server/services/push/index.js', () => ({ notifyInboundMessage: async () => undefined }));
vi.mock('../../../server/services/ai-agent/engine.js', () => ({
  maybeRunAiAssistantAfterVisitorMessage: async (_c: unknown, a: Record<string, unknown>) => { state.aiRuns.push(a); return { action: 'skipped' }; },
}));
vi.mock('../../../server/services/chatRouting.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/chatRouting.js')>()),
  routeHumanBoundConversation: async (_c: unknown, a: Record<string, unknown>) => { state.routed.push(a); return null; },
}));

const { processInboundMessage } = await import('../../../server/services/channels/inboundProcessing.js');
const { justClosedForInactivity } = await import('../../../server/services/idleCloseRace.js');
const { INACTIVITY_CLOSE_CHANNEL_RACE_GRACE_SECONDS, INACTIVITY_CLOSE_RACE_GRACE_SECONDS } = await import('../../../shared/inactivityClose.js');

const config = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } as never;
const WS = '11111111-1111-4111-8111-111111111111';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const INTEGRATION = 'int-1';
const CHAT = 'chat-1';

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const threadKey = (provider: string) => `${provider}:${INTEGRATION}:${CHAT}`;

let eventSeq = 0;
function inbound(over: Partial<Parameters<typeof processInboundMessage>[1]> = {}): Parameters<typeof processInboundMessage>[1] {
  return {
    provider: 'telegram', workspaceId: WS, integrationId: INTEGRATION, providerEventId: `ev-${++eventSeq}`,
    externalChatId: CHAT, externalUserId: 'u-1', senderName: 'Ali', senderUsername: null, senderLanguage: 'fa',
    text: 'سلام، هنوز جواب نگرفتم', sentAt: null, ...over,
  };
}

/** A conversation of the thread, for the contact. */
function conversation(provider: string, fields: Row = {}): Row {
  const row: Row = {
    id: randomUUID(), workspace_id: WS, contact_id: CONTACT, status: 'open', assigned_to: null, updated_at: iso(25 * 3600_000),
    ...fields,
    metadata: { channel: provider, channel_thread_key: threadKey(provider), channel_integration_id: INTEGRATION, channel_chat_id: CHAT, ...(fields.metadata as Row) },
  };
  (state.db.tables.conversations ||= []).push(row);
  return row;
}
/** The timer's close, `secondsAgo` before now, of a conversation that was `from` (updated_at untouched). */
const idleClosed = (secondsAgo: number, from = 'open'): Row => ({
  status: 'closed',
  metadata: { closed_reason: 'inactivity', closed_by: 'system', closed_from: from, closed_source: 'inactivity_timer', closed_at: iso(secondsAgo * 1000) },
});
const operatorClosed = (): Row => ({
  status: 'closed', updated_at: iso(30_000),
  metadata: { closed_reason: 'operator', closed_by: 'agent', closed_from: 'open', closed_at: iso(30_000) },
});

const rowOf = (id: unknown) => (state.db.tables.conversations || []).find((c) => c.id === id)!;
const conversations = () => state.db.tables.conversations || [];
const messagesOf = (id: unknown) => (state.db.tables.conversation_messages || []).filter((m) => m.conversation_id === id);
const reopens = () => state.db.rpcs.filter((r) => r.fn === 'conversation_reopen_after_idle_close');
const created = () => state.events.filter((e) => e.eventType === 'created');

/** ensure_active_conversation (072): the thread key among live statuses, the newest by updated_at; else a new open one. */
function ensureActiveConversation(args: Record<string, unknown>) {
  const live = conversations()
    .filter((c) => c.workspace_id === args.p_workspace_id && ['open', 'pending', 'resolved'].includes(String(c.status))
      && (c.metadata as Row)?.channel_thread_key === args.p_match_thread_key)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  if (live[0]) return { data: [{ id: live[0].id, created: false, matched_by: 'thread_key' }], error: null };
  const row: Row = {
    id: randomUUID(), workspace_id: args.p_workspace_id, contact_id: args.p_contact_id ?? null, status: 'open', assigned_to: null,
    metadata: (args.p_metadata as Row) || {}, updated_at: new Date().toISOString(),
  };
  conversations().push(row);
  return { data: [{ id: row.id, created: true, matched_by: 'created' }], error: null };
}

/** conversation_reopen_after_idle_close (284) in brief: an inactivity close within the grace goes back to closed_from, once. */
function reopenAfterIdleClose(args: Record<string, unknown>) {
  const none = { data: [{ restored_status: null, updated_at: null, event_id: null, event_created_at: null, retracted_line_id: null }], error: null };
  const row = conversations().find((c) => c.id === args.p_conversation_id && c.workspace_id === args.p_workspace_id);
  const meta = (row?.metadata || {}) as Row;
  if (!row || row.status !== 'closed' || meta.closed_reason !== 'inactivity') return none;
  if (Date.now() - Date.parse(String(meta.closed_at)) > Math.min(Number(args.p_grace_seconds), 600) * 1000) return none;
  const restored = String(meta.closed_from || 'open');
  row.status = restored;
  row.updated_at = new Date().toISOString();
  row.metadata = { ...Object.fromEntries(Object.entries(meta).filter(([k]) => !k.startsWith('closed_'))), idle_close_undone_at: row.updated_at };
  return { data: [{ restored_status: restored, updated_at: row.updated_at, event_id: randomUUID(), event_created_at: row.updated_at, retracted_line_id: null }], error: null };
}

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.db.rpc = (fn, args) => {
    if (fn === 'ensure_active_conversation') return ensureActiveConversation(args);
    if (fn === 'conversation_reopen_after_idle_close') return reopenAfterIdleClose(args);
    return { data: null, error: null };
  };
  state.installation = { id: 'inst-1', settings: {} };
  state.events = [];
  state.operatorEvents = [];
  state.lifecycle = [];
  state.aiRuns = [];
  state.routed = [];
  // The sender, known on each channel (one id, so each thread's conversations are theirs).
  state.db.tables.contacts = ['telegram', 'bale', 'whatsapp', 'instagram', 'x'].map((provider) => ({
    id: CONTACT, workspace_id: WS, name: 'Ali', metadata: { channel_identity: `${provider}:u-1` },
  }));
});

describe('the grace', () => {
  it('is ten minutes on channels (the queue\'s wait), within the SQL\'s cap; the widget keeps its minute', () => {
    expect(INACTIVITY_CLOSE_CHANNEL_RACE_GRACE_SECONDS).toBe(600);
    expect(INACTIVITY_CLOSE_RACE_GRACE_SECONDS).toBe(60);
    const now = Date.parse('2026-10-26T12:00:00.000Z');
    const closed = (msAgo: number) => ({ status: 'closed', metadata: { closed_reason: 'inactivity', closed_at: new Date(now - msAgo).toISOString() } });
    expect(justClosedForInactivity(closed(600_000), now, INACTIVITY_CLOSE_CHANNEL_RACE_GRACE_SECONDS)).toBe(true);
    expect(justClosedForInactivity(closed(600_001), now, INACTIVITY_CLOSE_CHANNEL_RACE_GRACE_SECONDS)).toBe(false);
    expect(justClosedForInactivity(closed(61_000), now)).toBe(false);
    expect(justClosedForInactivity(closed(61_000), now, INACTIVITY_CLOSE_CHANNEL_RACE_GRACE_SECONDS)).toBe(true);
  });
});

describe('the close committed before the message', () => {
  for (const provider of ['telegram', 'bale', 'whatsapp', 'instagram', 'x']) {
    it(`${provider}: a message within the grace goes back into the same conversation, as it was`, async () => {
      // Nine minutes after the close: past the widget's minute, a queued message.
      const old = conversation(provider, idleClosed(540));
      const result = await processInboundMessage(config, inbound({ provider }));

      expect(result).toMatchObject({ status: 'processed', conversationId: old.id });
      expect(conversations()).toHaveLength(1);
      expect(created()).toEqual([]);
      expect(rowOf(old.id).status).toBe('open');
      expect(Object.keys(rowOf(old.id).metadata as Row).filter((k) => k.startsWith('closed_'))).toEqual([]);
      expect(messagesOf(old.id)).toHaveLength(1);
      expect(reopens().map((r) => r.args)).toEqual([{ p_workspace_id: WS, p_conversation_id: old.id, p_message_id: null, p_grace_seconds: 600 }]);
      expect(state.operatorEvents.map((e) => [e.kind, e.reason ?? null])).toContainEqual(['conversation_reopened', 'customer_replied_after_inactivity_close']);
      // The lifecycle, the AI and routing run on the restored conversation.
      expect(state.lifecycle.map((l) => [l.conversationId, l.knownStatus])).toEqual([[old.id, 'open']]);
      expect(state.aiRuns.map((r) => r.conversationId)).toEqual([old.id]);
      expect(state.routed.map((r) => r.conversationId)).toEqual([old.id]);
    });
  }

  it('pending and resolved come back as they were, and the lifecycle takes it from there', async () => {
    const pending = conversation('telegram', idleClosed(30, 'pending'));
    await processInboundMessage(config, inbound());
    expect(rowOf(pending.id).status).toBe('pending');
    expect(state.lifecycle.map((l) => l.knownStatus)).toEqual(['pending']);

    state.lifecycle = [];
    state.routed = [];
    pending.status = 'closed';
    pending.metadata = { ...(pending.metadata as Row), ...(idleClosed(30, 'resolved').metadata as Row) };
    await processInboundMessage(config, inbound());
    expect(rowOf(pending.id).status).toBe('resolved');
    expect(state.lifecycle.map((l) => l.knownStatus)).toEqual(['resolved']);
    expect(state.routed).toEqual([expect.objectContaining({ conversationId: pending.id, reopened: true })]);
    expect(conversations()).toHaveLength(1);
  });

  it('a media-only message (a voice note, a photo without a caption) brings it back too', async () => {
    const old = conversation('telegram', idleClosed(120));
    await processInboundMessage(config, inbound({ text: '', attachments: [{ fileId: 'f-1', kind: 'voice' }] }));
    expect(rowOf(old.id).status).toBe('open');
    expect(messagesOf(old.id)).toHaveLength(1);
  });

  it('past the grace, or after an operator\'s close, the message starts a new conversation, as before', async () => {
    const late = conversation('telegram', idleClosed(601));
    const first = await processInboundMessage(config, inbound());
    expect(first.conversationId).not.toBe(late.id);
    expect(rowOf(late.id).status).toBe('closed');
    expect(created()).toHaveLength(1);

    state.db.tables.conversations = [];
    state.events = [];
    const byOperator = conversation('telegram', operatorClosed());
    const second = await processInboundMessage(config, inbound());
    expect(second.conversationId).not.toBe(byOperator.id);
    expect(rowOf(byOperator.id).status).toBe('closed');
    expect(created()).toHaveLength(1);
    // Neither was even asked for: the decision is the close's, not a guess.
    expect(reopens()).toEqual([]);
  });

  it('a newer live conversation on the thread wins: nothing is reopened', async () => {
    const closed = conversation('telegram', { ...idleClosed(30), updated_at: iso(25 * 3600_000) });
    const live = conversation('telegram', { status: 'open', updated_at: iso(10_000) });
    const result = await processInboundMessage(config, inbound());
    expect(result.conversationId).toBe(live.id);
    expect(rowOf(closed.id).status).toBe('closed');
    expect(reopens()).toEqual([]);
  });

  it('a menu tap (a slash command) brings nothing back: navigation, not content', async () => {
    const old = conversation('telegram', idleClosed(30));
    const result = await processInboundMessage(config, inbound({ text: '/start' }));
    expect(result.conversationId).not.toBe(old.id);
    expect(rowOf(old.id).status).toBe('closed');
    expect(reopens()).toEqual([]);
    // A reply-keyboard label is a tap too.
    const { matchReplyKeyboardCommand } = await import('../../../server/services/channels/telegram/menu.js');
    const { parseTelegramSettings, resolveCommandLabel } = await import('../../../server/services/channels/telegram/settings.js');
    const label = resolveCommandLabel(parseTelegramSettings({}), 'fa', 'new', 'fa');
    expect(matchReplyKeyboardCommand(parseTelegramSettings({}), label)).toBe('new');
    state.db.tables.conversations = [old];
    await processInboundMessage(config, inbound({ text: label }));
    expect(rowOf(old.id).status).toBe('closed');
    expect(reopens()).toEqual([]);
  });

  it('a duplicate delivery brings it back once, with one message; two messages at once bring it back once', async () => {
    const old = conversation('telegram', idleClosed(30));
    const event = inbound();
    expect(await processInboundMessage(config, event)).toMatchObject({ status: 'processed', conversationId: old.id });
    expect(await processInboundMessage(config, { ...event })).toEqual({ status: 'duplicate' });
    expect(messagesOf(old.id)).toHaveLength(1);
    expect(reopens()).toHaveLength(1);

    old.status = 'closed';
    old.metadata = { ...(old.metadata as Row), ...(idleClosed(30).metadata as Row) };
    state.operatorEvents = [];
    const [a, b] = await Promise.all([processInboundMessage(config, inbound({ text: 'A' })), processInboundMessage(config, inbound({ text: 'B' }))]);
    expect([a.conversationId, b.conversationId]).toEqual([old.id, old.id]);
    expect(conversations()).toHaveLength(1);
    expect(created()).toEqual([]);
    expect(messagesOf(old.id)).toHaveLength(3);
    expect(state.operatorEvents.filter((e) => e.kind === 'conversation_reopened')).toHaveLength(1);
  });
});

describe('the close committed while the message was being inserted', () => {
  /** The close commits between the conversation's match and the message's insert. */
  const closeOnInsert = (row: Row, close: Row) => {
    state.db.beforeInsert = (table) => {
      if (table !== 'conversation_messages') return;
      Object.assign(row, close);
      state.db.beforeInsert = undefined;
    };
  };

  it('the touch reads closed: the conversation comes back with the message\'s id, and the rest runs from there', async () => {
    const conv = conversation('whatsapp', { status: 'open' });
    closeOnInsert(conv, { ...idleClosed(0), metadata: { ...(conv.metadata as Row), ...(idleClosed(0).metadata as Row) } });
    const result = await processInboundMessage(config, inbound({ provider: 'whatsapp' }));
    expect(result.conversationId).toBe(conv.id);
    expect(rowOf(conv.id).status).toBe('open');
    expect(reopens().map((r) => r.args)).toEqual([{ p_workspace_id: WS, p_conversation_id: conv.id, p_message_id: result.messageId, p_grace_seconds: 600 }]);
    expect(state.lifecycle.map((l) => l.knownStatus)).toEqual(['open']);
    expect(state.aiRuns.map((r) => r.conversationId)).toEqual([conv.id]);
    expect(state.routed.map((r) => r.conversationId)).toEqual([conv.id]);
  });

  it('an operator\'s close in the meantime stays closed, as before', async () => {
    const conv = conversation('telegram', { status: 'open' });
    closeOnInsert(conv, { ...operatorClosed(), metadata: { ...(conv.metadata as Row), ...(operatorClosed().metadata as Row) } });
    await processInboundMessage(config, inbound());
    expect(rowOf(conv.id).status).toBe('closed');
    expect(state.lifecycle.map((l) => l.knownStatus)).toEqual(['closed']);
  });

  it('a menu tap does no touch and brings nothing back', async () => {
    const conv = conversation('telegram', { status: 'open' });
    closeOnInsert(conv, { ...idleClosed(0), metadata: { ...(conv.metadata as Row), ...(idleClosed(0).metadata as Row) } });
    await processInboundMessage(config, inbound({ text: '/start' }));
    expect(rowOf(conv.id).status).toBe('closed');
    expect(reopens()).toEqual([]);
  });
});
