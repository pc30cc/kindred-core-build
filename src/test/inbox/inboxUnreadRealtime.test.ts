/**
 * The Inbox's unread number stays fresh without a poll (owner request of
 * 2026-10-23, R4). It is re-read on the realtime the panel already hears:
 * every visitor message (not only a conversation's first), a status,
 * assignee, AI or spam change, a reconnect. A read conversation
 * (`conversation_seen`, from any member's panel, or this operator opening it)
 * leaves the number and its row's unread count at once, without the lists
 * being read again.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RealtimeHandlers } from '@/realtime/types';

const subs = vi.hoisted(() => [] as Array<{ channel: string; handlers: RealtimeHandlers }>);
vi.mock('@/realtime', () => ({
  resolveClientRealtimeProvider: async () => ({
    vendor: 'centrifugo',
    async subscribe(channel: string, handlers: RealtimeHandlers) {
      subs.push({ channel, handlers });
      return { unsubscribe: () => {} };
    },
  }),
}));

const { useInboxListRealtime } = await import('@/hooks/useInboxListRealtime');
const { dropInboxUnread, useMarkConversationSeen } = await import('@/hooks/useConversations');

const WS = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const LIST = ['conversations', WS, 'main', 'open'];
const UNREAD = ['inbox-unread', WS];

afterEach(() => {
  subs.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(LIST, [{ id: CID, status: 'open', unread_count: 2 }, { id: OTHER, status: 'open', unread_count: 1 }]);
  qc.setQueryData(UNREAD, { conversations: 2, ids: [CID, OTHER] });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
  return { qc, wrapper };
}

async function listening(qc: QueryClient, wrapper: (p: { children: ReactNode }) => ReturnType<typeof createElement>) {
  renderHook(() => useInboxListRealtime(WS), { wrapper });
  await waitFor(() => expect(subs.find((s) => s.channel === `ws:${WS}:inbox`)).toBeTruthy());
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  return { handlers: subs[0].handlers, invalidate };
}

const asked = (invalidate: ReturnType<typeof vi.spyOn>, key: unknown[]) =>
  invalidate.mock.calls.some(([filters]) => JSON.stringify((filters as { queryKey?: unknown })?.queryKey) === JSON.stringify(key));

const message = (senderType: string, conversationId = CID) => ({
  id: crypto.randomUUID(), conversation_id: conversationId, role: senderType === 'contact' ? 'visitor' : 'agent',
  sender_type: senderType, text: 'hi', body: 'hi', time: null, created_at: null, seen_at: null,
}) as Parameters<NonNullable<RealtimeHandlers['onMessage']>>[0];

describe('the unread number, from realtime', () => {
  it('is read again for a visitor message on a conversation the lists already hold', async () => {
    const { qc, wrapper } = setup();
    const { handlers, invalidate } = await listening(qc, wrapper);
    handlers.onMessage!(message('contact'));
    expect(asked(invalidate, UNREAD)).toBe(true);
  });

  it('not for the team\'s, the AI\'s or the system\'s messages', async () => {
    const { qc, wrapper } = setup();
    const { handlers, invalidate } = await listening(qc, wrapper);
    for (const sender of ['agent', 'ai', 'system', 'bot']) handlers.onMessage!(message(sender));
    expect(asked(invalidate, UNREAD)).toBe(false);
  });

  it('is read again when a status or assignee change may move a chat in or out of it', async () => {
    const { qc, wrapper } = setup();
    const { handlers, invalidate } = await listening(qc, wrapper);
    handlers.onEvent!({
      kind: 'conversation_updated', conversation_id: CID, workspace_id: WS, actor_id: 'colleague',
      changes: { assigned_to: { from: null, to: 'colleague' } },
    });
    expect(asked(invalidate, UNREAD)).toBe(true);
  });

  it('a read conversation leaves it, and its row shows no unread count, without re-reading the lists', async () => {
    const { qc, wrapper } = setup();
    const { handlers, invalidate } = await listening(qc, wrapper);
    handlers.onEvent!({ kind: 'conversation_seen', conversation_id: CID, workspace_id: WS, actor_id: 'colleague', seen_at: '2026-10-23T10:00:00Z' });
    expect(qc.getQueryData(UNREAD)).toEqual({ conversations: 1, ids: [OTHER] });
    const rows = qc.getQueryData<Array<{ id: string; unread_count: number }>>(LIST)!;
    expect(rows.find((r) => r.id === CID)!.unread_count).toBe(0);
    expect(rows.find((r) => r.id === OTHER)!.unread_count).toBe(1);
    // The number is checked with the server; nothing else is read.
    expect(invalidate.mock.calls.map(([f]) => (f as { queryKey?: unknown[] })?.queryKey)).toEqual([UNREAD]);
  });

  it('is read again after a reconnect, as the lists and counters are', async () => {
    const { qc, wrapper } = setup();
    const { handlers, invalidate } = await listening(qc, wrapper);
    handlers.onStatus!('closed');
    expect(asked(invalidate, UNREAD)).toBe(false);
    handlers.onStatus!('open');
    expect(asked(invalidate, UNREAD)).toBe(true);
  });
});

describe('dropInboxUnread', () => {
  it('leaves alone a number that does not name the conversation, and never goes below zero', () => {
    const { qc } = setup();
    qc.setQueryData(['inbox-unread', 'ws-2'], { conversations: 0, ids: [CID] });
    dropInboxUnread(qc, 'not-there');
    expect(qc.getQueryData(UNREAD)).toEqual({ conversations: 2, ids: [CID, OTHER] });
    dropInboxUnread(qc, CID);
    expect(qc.getQueryData(UNREAD)).toEqual({ conversations: 1, ids: [OTHER] });
    expect(qc.getQueryData(['inbox-unread', 'ws-2'])).toEqual({ conversations: 0, ids: [] });
  });
});

describe('opening a conversation (useMarkConversationSeen)', () => {
  it('drops it from the number at once, then checks the number with the server', async () => {
    const { qc, wrapper } = setup();
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ ok: true, count: 2 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const cancel = vi.spyOn(qc, 'cancelQueries');
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useMarkConversationSeen(), { wrapper });
    result.current.mutate(CID);
    await waitFor(() => expect(qc.getQueryData(UNREAD)).toEqual({ conversations: 1, ids: [OTHER] }));
    // A read of the number in flight would put the chat back: cancelled first.
    expect(cancel.mock.calls.some(([f]) => JSON.stringify((f as { queryKey?: unknown })?.queryKey) === JSON.stringify(['inbox-unread']))).toBe(true);
    expect(qc.getQueryData<Array<{ id: string; unread_count: number }>>(LIST)!.find((r) => r.id === CID)!.unread_count).toBe(0);
    await waitFor(() => expect(asked(invalidate, ['inbox-unread'])).toBe(true));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/api/conversations/${CID}/seen`);
  });
});
