/**
 * "Seen" on the operator's side (I-03, operator half).
 *
 * The Inbox showed "Seen" from a message's `seen_at`, which only marks the
 * VISITOR's messages as read by an operator, so an operator never learnt
 * that their reply was read. The widget's read marker
 * (widget_conversation_reads) now reaches the Inbox as the conversation's
 * `visitor_last_read_at` and as a `visitor_read` event on the operators'
 * inbox channel; the thread shows "Seen" under the newest team message sent
 * at or before it, and the phone shell's ticks follow it too.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RealtimeHandlers } from '@/realtime/types';
import { isReadByVisitor, lastSeenTeamMessageId, laterReadMarker } from '@/lib/inboxSeen';

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

const { useInboxListRealtime, patchVisitorReadInCache } = await import('@/hooks/useInboxListRealtime');

const WS = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';

afterEach(() => { subs.length = 0; });

const thread = [
  { id: 'v1', sender_type: 'contact', created_at: '2026-10-21T10:00:00Z' },
  { id: 'a1', sender_type: 'agent', created_at: '2026-10-21T10:01:00Z' },
  { id: 'ai1', sender_type: 'ai', created_at: '2026-10-21T10:02:00Z' },
  { id: 'sys', sender_type: 'system', created_at: '2026-10-21T10:03:00Z' },
  { id: 'a2', sender_type: 'agent', created_at: '2026-10-21T10:05:00Z' },
];

describe('which reply the visitor has seen', () => {
  it('the newest team message sent at or before their last read', () => {
    expect(lastSeenTeamMessageId(thread, '2026-10-21T10:04:00Z')).toBe('ai1');
    expect(lastSeenTeamMessageId(thread, '2026-10-21T10:05:00Z')).toBe('a2');
    expect(lastSeenTeamMessageId(thread, '2026-10-21T10:01:30Z')).toBe('a1');
  });

  it('none before the visitor ever read, or before the first reply', () => {
    expect(lastSeenTeamMessageId(thread, null)).toBeNull();
    expect(lastSeenTeamMessageId(thread, '2026-10-21T10:00:30Z')).toBeNull();
    expect(lastSeenTeamMessageId([], '2026-10-21T10:05:00Z')).toBeNull();
    expect(lastSeenTeamMessageId(thread, 'not a date')).toBeNull();
  });

  it('a visitor\'s own message read by an operator (seen_at) is not a "Seen" for the operator', () => {
    const own = [{ id: 'v1', sender_type: 'contact', created_at: '2026-10-21T10:00:00Z', seen_at: '2026-10-21T10:00:05Z' }];
    expect(lastSeenTeamMessageId(own, null)).toBeNull();
  });

  it('per message, for the phone shell\'s ticks', () => {
    expect(isReadByVisitor({ created_at: '2026-10-21T10:01:00Z' }, '2026-10-21T10:04:00Z')).toBe(true);
    expect(isReadByVisitor({ created_at: '2026-10-21T10:05:00Z' }, '2026-10-21T10:04:00Z')).toBe(false);
    expect(isReadByVisitor({ created_at: '2026-10-21T10:05:00Z' }, null)).toBe(false);
  });

  it('a read marker never moves back, whichever arrives first', () => {
    expect(laterReadMarker('2026-10-21T10:04:00Z', '2026-10-21T10:02:00Z')).toBe('2026-10-21T10:04:00Z');
    expect(laterReadMarker('2026-10-21T10:02:00Z', '2026-10-21T10:04:00Z')).toBe('2026-10-21T10:04:00Z');
    expect(laterReadMarker(null, '2026-10-21T10:04:00Z')).toBe('2026-10-21T10:04:00Z');
    expect(laterReadMarker('2026-10-21T10:04:00Z', 'junk')).toBe('2026-10-21T10:04:00Z');
    expect(laterReadMarker(undefined, null)).toBeNull();
  });
});

describe('a visitor_read event', () => {
  it('moves the conversation\'s marker in every cached list, and leaves the others alone', () => {
    const rows = [{ id: CID, visitor_last_read_at: '2026-10-21T10:00:00Z' }, { id: 'other' }];
    const patched = patchVisitorReadInCache(rows, CID, '2026-10-21T10:04:00Z')!;
    expect(patched[0].visitor_last_read_at).toBe('2026-10-21T10:04:00Z');
    expect(patched[1]).toBe(rows[1]);
    // An older marker, or a conversation the list does not hold: the same array.
    expect(patchVisitorReadInCache(patched, CID, '2026-10-21T09:00:00Z')).toBe(patched);
    expect(patchVisitorReadInCache(rows, 'missing', '2026-10-21T10:04:00Z')).toBe(rows);
  });

  it('reaches the cached lists through the inbox channel, without re-reading anything', async () => {
    const qc = new QueryClient();
    const key = ['conversations', WS, 'main', 'open'];
    qc.setQueryData(key, [{ id: CID, status: 'open', visitor_last_read_at: null }]);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    renderHook(() => useInboxListRealtime(WS), { wrapper });
    await waitFor(() => expect(subs.find((s) => s.channel === `ws:${WS}:inbox`)).toBeTruthy());

    subs[0].handlers.onEvent!({
      kind: 'visitor_read', conversation_id: CID, workspace_id: WS, actor_id: null,
      visitor_last_read_at: '2026-10-21T10:04:00Z',
    });
    const rows = qc.getQueryData<Array<{ id: string; visitor_last_read_at?: string | null }>>(key)!;
    expect(rows[0].visitor_last_read_at).toBe('2026-10-21T10:04:00Z');
    expect(lastSeenTeamMessageId(thread, rows[0].visitor_last_read_at)).toBe('ai1');
    expect(invalidate).not.toHaveBeenCalled();
  });
});
