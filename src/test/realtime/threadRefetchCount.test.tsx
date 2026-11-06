/**
 * How many times the open thread is read for one visitor message (audit
 * 2026-11-06, section 6), with the real React Query client, the real
 * throttle and a stubbed fetch that counts every GET of the thread.
 *
 * A visitor message reached the thread three ways: the message itself
 * (useInboxRealtime), the success of the operator's POST /seen
 * (useMarkConversationSeen), and the server's `seen` news that POST sends
 * back on the conversation channel. Each read the whole thread again: three
 * full GETs per message per operator watching. Now:
 *
 *   · one GET for an isolated message, the POST and its news included; the
 *     news' seen_at lands in the cache without a read;
 *   · a burst stays within one GET per 500 ms window;
 *   · a socket that comes back reads the thread once (messages pushed while
 *     it was down are lost), and only once;
 *   · a news without ids (an older server) still reads the thread.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
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

const { useConversationMessages, useMarkConversationSeen } = await import('@/hooks/useConversations');
const { useInboxRealtime } = await import('@/hooks/useInboxRealtime');

const WS = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';
const M1 = '33333333-3333-4333-8333-333333333331';
const M2 = '33333333-3333-4333-8333-333333333332';
const SEEN_AT = '2026-11-06T10:00:05.123456+00:00';

let gets = 0;
let rows: Array<Record<string, unknown>> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  gets = 0;
  rows = [{ id: M1, conversation_id: CID, sender_type: 'contact', body: 'hi', created_at: '2026-11-06T10:00:00.000000+00:00', seen_at: SEEN_AT }];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes(`/api/conversations/${CID}/messages`) && (!init?.method || init.method === 'GET')) {
      gets += 1;
      await sleep(80);
      return new Response(JSON.stringify({ messages: rows, sync: { mode: 'full', cursor: null }, older: null }), { status: 200 });
    }
    if (u.includes(`/api/conversations/${CID}/seen`)) {
      // The POST answers after the thread's GET.
      await sleep(150);
      return new Response(JSON.stringify({ ok: true, count: 1 }), { status: 200 });
    }
    return new Response(JSON.stringify({ conversations: 0, ids: [] }), { status: 200 });
  }));
});

afterEach(() => {
  subs.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
  const hook = renderHook(() => ({
    thread: useConversationMessages(CID),
    seen: useMarkConversationSeen(),
    rt: useInboxRealtime({ workspaceId: WS, conversationId: CID }),
  }), { wrapper });
  return { qc, hook };
}

const conv = () => subs.find((s) => s.channel === `ws:${WS}:conv:${CID}` && !s.closed)!.handlers;

async function opened() {
  const m = mount();
  await waitFor(() => expect(m.hook.result.current.thread.data?.length).toBe(1));
  await waitFor(() => expect(subs.some((s) => s.channel === `ws:${WS}:conv:${CID}`)).toBe(true));
  gets = 0;
  return m;
}

/** A visitor message on a watched thread: the event, the operator's mark, the server's news. */
async function visitorMessage(m: Awaited<ReturnType<typeof opened>>) {
  rows = [...rows, { id: M2, conversation_id: CID, sender_type: 'contact', body: 'again', created_at: '2026-11-06T10:00:04.000000+00:00', seen_at: null }];
  await act(async () => {
    conv().onMessage!({ id: M2, sender_type: 'contact' } as never);
    await m.hook.result.current.seen.mutateAsync(CID);
    conv().onSeen!({ conversation_id: CID, seen_at: SEEN_AT, message_ids: [M2] });
    await sleep(900);
  });
}

describe('the open thread\'s reads for one visitor message', () => {
  it('one GET: the POST /seen and its news read nothing more; the news\' seen_at is in the cache', async () => {
    const m = await opened();
    await visitorMessage(m);
    expect(gets).toBe(1);
    const row = m.hook.result.current.thread.data?.find((r) => r.id === M2);
    expect(row?.seen_at).toBe(SEEN_AT);
  });

  it('a burst of 10 messages over a second stays within one GET per 500 ms window', async () => {
    await opened();
    await act(async () => {
      for (let i = 0; i < 10; i++) {
        conv().onMessage!({ id: `m${i}`, sender_type: 'contact' } as never);
        await sleep(100);
      }
      await sleep(900);
    });
    expect(gets).toBeGreaterThanOrEqual(1);
    expect(gets).toBeLessThanOrEqual(4);
  });

  it('a socket that comes back reads the thread once; a news without ids still reads it', async () => {
    await opened();
    await act(async () => {
      conv().onStatus!('open');
      await sleep(700);
    });
    expect(gets).toBe(0);
    await act(async () => {
      conv().onStatus!('closed');
      conv().onStatus!('connecting');
      conv().onStatus!('open');
      await sleep(700);
      conv().onStatus!('open');
      await sleep(700);
    });
    expect(gets).toBe(1);
    await act(async () => {
      conv().onSeen!({ conversation_id: CID });
      await sleep(700);
    });
    expect(gets).toBe(2);
  });
});
