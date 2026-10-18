/**
 * The open thread keeps hearing every operator event after they left the
 * visitor's channel (contract §6a).
 *
 * useInboxRealtime subscribes to the conversation channel for messages,
 * typing and seen, and to the workspace inbox channel for its conversation's
 * operator-only `event` envelopes (notes, status, tags, assignee, timeline,
 * AI suggestions, calls). The conversation channel's `event` envelopes are
 * the visitor's cut-down copies of ones the inbox channel delivers whole, so
 * they are not handled twice.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RealtimeHandlers } from '@/realtime/types';

const subs = vi.hoisted(() => [] as Array<{ channel: string; handlers: RealtimeHandlers; closed: boolean }>);
vi.mock('@/realtime', () => ({
  resolveClientRealtimeProvider: async () => ({
    vendor: 'centrifugo',
    async subscribe(channel: string, handlers: RealtimeHandlers) {
      const entry = { channel, handlers, closed: false };
      subs.push(entry);
      return { unsubscribe: () => { entry.closed = true; } };
    },
  }),
}));

const { useInboxRealtime } = await import('@/hooks/useInboxRealtime');

const WS = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

function mount(conversationId: string) {
  const qc = new QueryClient();
  const invalidated: string[] = [];
  vi.spyOn(qc, 'invalidateQueries').mockImplementation(async (filters?: { queryKey?: readonly unknown[] }) => {
    invalidated.push(JSON.stringify(filters?.queryKey));
  });
  const onEvent = vi.fn();
  const onMessage = vi.fn();
  const onTyping = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
  const hook = renderHook(
    ({ cid }: { cid: string }) => useInboxRealtime({ workspaceId: WS, conversationId: cid, onEvent, onMessage, onTyping }),
    { wrapper, initialProps: { cid: conversationId } },
  );
  return { hook, invalidated, onEvent, onMessage, onTyping };
}

const live = (channel: string) => subs.find((s) => s.channel === channel && !s.closed);

afterEach(() => { subs.length = 0; vi.restoreAllMocks(); });

describe('useInboxRealtime', () => {
  it('subscribes to the conversation channel and to the inbox channel', async () => {
    mount(CID);
    await waitFor(() => expect(subs.map((s) => s.channel)).toEqual([`ws:${WS}:conv:${CID}`, `ws:${WS}:inbox`]));
  });

  it('takes this conversation\'s operator events from the inbox channel', async () => {
    const m = mount(CID);
    await waitFor(() => expect(live(`ws:${WS}:inbox`)).toBeTruthy());
    const inbox = live(`ws:${WS}:inbox`)!.handlers;

    inbox.onEvent!({ kind: 'note_added', conversation_id: CID, workspace_id: WS, note_id: 'n1' });
    expect(m.onEvent).toHaveBeenCalledTimes(1);
    expect(m.invalidated).toContain(JSON.stringify(['conversation-notes', CID, WS]));
    expect(m.invalidated).toContain(JSON.stringify(['conversation-timeline', CID, WS]));

    inbox.onEvent!({ kind: 'conversation_updated', conversation_id: CID, workspace_id: WS, changes: { tags: { added: ['vip'], removed: [] } } });
    inbox.onEvent!({ kind: 'call_invitation_changed' as never, conversation_id: CID, workspace_id: WS, invitation_id: 'i1' });
    inbox.onEvent!({ kind: 'call:ended' as never, conversation_id: CID, workspace_id: WS, call_session_id: 'c1' });
    inbox.onEvent!({ kind: 'ai_suggestion_created' as never, conversation_id: CID, workspace_id: WS, suggestion_id: 's1' });
    expect(m.onEvent.mock.calls.map(([p]) => p.kind)).toEqual(['note_added', 'conversation_updated', 'call_invitation_changed', 'call:ended', 'ai_suggestion_created']);
    expect(m.invalidated).toContain(JSON.stringify(['messages', CID]));
    expect(m.invalidated).toContain(JSON.stringify(['ai-agent', 'conv-suggestions', CID]));
  });

  it('ignores another conversation\'s events, and another workspace\'s', async () => {
    const m = mount(CID);
    await waitFor(() => expect(live(`ws:${WS}:inbox`)).toBeTruthy());
    const inbox = live(`ws:${WS}:inbox`)!.handlers;
    inbox.onEvent!({ kind: 'note_added', conversation_id: OTHER, workspace_id: WS });
    inbox.onEvent!({ kind: 'note_added', conversation_id: CID, workspace_id: OTHER });
    expect(m.onEvent).not.toHaveBeenCalled();
    expect(m.invalidated).toEqual([]);
  });

  it('does not handle the conversation channel\'s events (the visitor\'s copies), only its messages and typing', async () => {
    const m = mount(CID);
    await waitFor(() => expect(live(`ws:${WS}:conv:${CID}`)).toBeTruthy());
    const conv = live(`ws:${WS}:conv:${CID}`)!.handlers;
    expect(conv.onEvent).toBeUndefined();
    conv.onTyping!({ actor: 'visitor', conversation_id: CID });
    expect(m.onTyping).toHaveBeenCalledWith({ actor: 'visitor', conversation_id: CID });
    conv.onMessage!({ id: 'm1', conversation_id: CID, role: 'visitor', sender_type: 'contact', text: 'hi', body: 'hi', time: null, created_at: null, seen_at: null });
    expect(m.onMessage).toHaveBeenCalledTimes(1);
    expect(m.invalidated).toContain(JSON.stringify(['messages', CID]));
  });

  it('leaves both channels when the thread changes or closes', async () => {
    const m = mount(CID);
    await waitFor(() => expect(subs).toHaveLength(2));
    m.hook.rerender({ cid: OTHER });
    await waitFor(() => expect(subs).toHaveLength(4));
    expect(subs.slice(0, 2).every((s) => s.closed)).toBe(true);
    expect(subs.slice(2).map((s) => s.channel)).toEqual([`ws:${WS}:conv:${OTHER}`, `ws:${WS}:inbox`]);
    m.hook.unmount();
    expect(subs.every((s) => s.closed)).toBe(true);
  });
});
