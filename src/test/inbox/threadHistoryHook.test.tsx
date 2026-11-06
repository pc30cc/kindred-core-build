/**
 * useConversationMessages pages the thread (audit 2026-11-06, section 4),
 * with the real React Query client and a fake server that answers as
 * GET /api/conversations/:id/messages does (`limit`, `before`/`before_id`,
 * `older`, rows of one instant ordered by id):
 *
 *   · the thread opens on its newest page; `loadOlder` adds the page before
 *     until the first message, then `hasOlder` is false;
 *   · a refresh (a new message) keeps every page loaded; a row deleted in
 *     the newest page goes;
 *   · an older page landing while a refresh is out is not lost;
 *   · more new messages than a page start the run again, without a hole.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { compareThreadRows, THREAD_PAGE_SIZE } from '@/lib/threadPages';

const { useConversationMessages, applyReactionsToThread } = await import('@/hooks/useConversations');

const CID = '22222222-2222-4222-8222-222222222222';
type Row = { id: string; conversation_id: string; sender_type: string; body: string; created_at: string };

let thread: Row[] = [];
let gets = 0;
let delayNewest = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (n: number) => new Date(Date.UTC(2026, 10, 6, 10, 0, 0) + Math.floor(n / 2) * 1000).toISOString().replace('Z', '000+00:00');
const make = (n: number): Row => ({ id: idOf(n), conversation_id: CID, sender_type: 'contact', body: `m${n}`, created_at: at(n) });

function serve(url: URL): { messages: Row[]; older: { before: string; before_id: string } | null } {
  const limit = Number(url.searchParams.get('limit') || 1000);
  const before = url.searchParams.get('before');
  const beforeId = url.searchParams.get('before_id');
  const sorted = [...thread].sort(compareThreadRows);
  const eligible = before ? sorted.filter((r) => compareThreadRows(r, { id: beforeId!, created_at: before }) < 0) : sorted;
  const page = eligible.slice(-limit);
  const first = page[0];
  const older = first && eligible.indexOf(first) > 0 ? { before: first.created_at, before_id: first.id } : null;
  return { messages: page, older };
}

beforeEach(() => {
  thread = Array.from({ length: 250 }, (_, i) => make(i));
  gets = 0;
  delayNewest = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(String(input), 'http://localhost');
    gets += 1;
    if (!url.searchParams.get('before') && delayNewest) await sleep(delayNewest);
    const body = serve(url);
    return new Response(JSON.stringify({ ...body, sync: { mode: 'full', cursor: null } }), { status: 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
  const hook = renderHook(({ cid }: { cid: string }) => useConversationMessages(cid), { wrapper, initialProps: { cid: CID } });
  return { qc, hook };
}
const bodies = (rows: Row[] | undefined) => (rows || []).map((r) => Number(r.body.slice(1)));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('useConversationMessages: the thread page by page', () => {
  it('opens on the newest page, loads older ones to the first message', async () => {
    const { hook } = mount();
    await waitFor(() => expect(hook.result.current.data?.length).toBe(THREAD_PAGE_SIZE));
    expect(bodies(hook.result.current.data as Row[])).toEqual(range(150, 249));
    expect(hook.result.current.hasOlder).toBe(true);
    await act(async () => { await hook.result.current.loadOlder(); });
    expect(bodies(hook.result.current.data as Row[])).toEqual(range(50, 249));
    await act(async () => { await hook.result.current.loadOlder(); });
    expect(bodies(hook.result.current.data as Row[])).toEqual(range(0, 249));
    await waitFor(() => expect(hook.result.current.hasOlder).toBe(false));
  });

  it('a refresh keeps every page loaded and takes the newest page as the server has it', async () => {
    const { qc, hook } = mount();
    await waitFor(() => expect(hook.result.current.data?.length).toBe(THREAD_PAGE_SIZE));
    await act(async () => { await hook.result.current.loadOlder(); });
    thread.push(make(250));
    thread = thread.filter((r) => r.body !== 'm240');
    await act(async () => { await qc.invalidateQueries({ queryKey: ['messages', CID] }); });
    await waitFor(() => expect(bodies(hook.result.current.data as Row[])).toContain(250));
    expect(bodies(hook.result.current.data as Row[])).toEqual(range(50, 250).filter((n) => n !== 240));
    expect(hook.result.current.hasOlder).toBe(true);
  });

  it('an older page landing while a refresh is out is kept', async () => {
    const { qc, hook } = mount();
    await waitFor(() => expect(hook.result.current.data?.length).toBe(THREAD_PAGE_SIZE));
    thread.push(make(250));
    delayNewest = 150;
    await act(async () => {
      void qc.invalidateQueries({ queryKey: ['messages', CID] });
      await sleep(10);
      await hook.result.current.loadOlder();
      await sleep(400);
    });
    await waitFor(() => expect(bodies(hook.result.current.data as Row[])).toContain(250));
    expect(bodies(hook.result.current.data as Row[])).toEqual(range(50, 250));
  });

  it('a page still loading for the thread left behind never blocks the one opened now', async () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    const { hook } = mount();
    await waitFor(() => expect(hook.result.current.data?.length).toBe(THREAD_PAGE_SIZE));
    // The older page of the first thread is slow.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.includes(CID) && url.searchParams.get('before')) await gate;
      if (url.pathname.includes(OTHER)) {
        // The other thread: the same 250 rows under its id.
        const body = serve(url);
        return new Response(JSON.stringify({ ...body, messages: body.messages.map((m) => ({ ...m, conversation_id: OTHER })), sync: null }), { status: 200 });
      }
      return (realFetch as (i: string, n?: RequestInit) => Promise<Response>)(input, init);
    }));
    let first!: Promise<boolean>;
    act(() => { first = hook.result.current.loadOlder(); });
    await waitFor(() => expect(hook.result.current.loadingOlder).toBe(true));
    hook.rerender({ cid: OTHER });
    await waitFor(() => expect(hook.result.current.data?.length).toBe(THREAD_PAGE_SIZE));
    expect(hook.result.current.loadingOlder).toBe(false);
    await act(async () => { expect(await hook.result.current.loadOlder()).toBe(true); });
    expect(hook.result.current.data?.length).toBe(2 * THREAD_PAGE_SIZE);
    release();
    await act(async () => { await first; });
  });

  it('a reaction on a message of an older page lands on it (the refresh reads only the newest page)', async () => {
    const { qc, hook } = mount();
    await waitFor(() => expect(hook.result.current.data?.length).toBe(THREAD_PAGE_SIZE));
    await act(async () => { await hook.result.current.loadOlder(); });
    const old = idOf(60);
    act(() => {
      applyReactionsToThread(qc, CID, { message_id: old, reactions: [{ emoji: '👍', count: 2, visitor: false }] });
    });
    const reactionsOf = () => (hook.result.current.data as Array<{ id: string; reactions?: unknown }>).find((r) => r.id === old)?.reactions;
    await waitFor(() => expect(reactionsOf()).toEqual([{ emoji: '👍', count: 2, visitor: false, mine: false }]));
    // Taken back: none left.
    act(() => { applyReactionsToThread(qc, CID, { message_id: old, reactions: [] }); });
    await waitFor(() => expect(reactionsOf()).toBeUndefined());
    // A message the thread does not hold: nothing to do.
    expect(applyReactionsToThread(qc, CID, { message_id: idOf(5), reactions: [] })).toBe(false);
  });

  it('a newest page with nothing visible (hidden menu taps) is read past: the thread never opens empty', async () => {
    // The server hides the newest 120 rows (menu taps): its newest page answers none of them.
    const hidden = new Set(thread.slice(-120).map((r) => r.id));
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(String(input), 'http://localhost');
      const body = serve(url);
      return new Response(JSON.stringify({ ...body, messages: body.messages.filter((m) => !hidden.has(m.id)), sync: null }), { status: 200 });
    }));
    const { hook } = mount();
    await waitFor(() => expect((hook.result.current.data || []).length).toBeGreaterThan(0));
    expect(bodies(hook.result.current.data as Row[])).toEqual(range(50, 129));
    expect(hook.result.current.hasOlder).toBe(true);
  });

  it('more new messages than one page: the run starts again from the newest page, never with a hole', async () => {
    const { qc, hook } = mount();
    await waitFor(() => expect(hook.result.current.data?.length).toBe(THREAD_PAGE_SIZE));
    for (let n = 250; n < 400; n++) thread.push(make(n));
    await act(async () => { await qc.invalidateQueries({ queryKey: ['messages', CID] }); });
    await waitFor(() => expect(bodies(hook.result.current.data as Row[])).toEqual(range(300, 399)));
    expect(hook.result.current.hasOlder).toBe(true);
    await act(async () => { await hook.result.current.loadOlder(); });
    expect(bodies(hook.result.current.data as Row[])).toEqual(range(200, 399));
  });
});
