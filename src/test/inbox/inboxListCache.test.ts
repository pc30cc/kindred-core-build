import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

const listMock = vi.fn();
const networkMock = vi.fn();

vi.mock('@/lib/conversations-api', () => ({
  conversationsApi: { list: (...a: unknown[]) => listMock(...a) },
}));
vi.mock('@/hooks/useVisitorNetwork', () => ({
  fetchVisitorNetworkForConversations: (...a: unknown[]) => networkMock(...a),
}));

import { mergeRows, refreshConversations, isConversationCached, FLUSH_DELAY_MS } from '@/hooks/inboxListCache';

const WS = 'ws-1';
const KEY = ['conversations', WS, 'main', 'open', false, null, 'mine'];

function row(id: string, updated: string, extra: Record<string, unknown> = {}) {
  return { id, updated_at: updated, ...extra };
}

function clientWithList(rows: unknown[], observed = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(KEY, rows);
  if (observed) {
    // An observer stands for the Inbox showing this list.
    new QueryObserver(qc, { queryKey: KEY, queryFn: () => rows, enabled: false }).subscribe(() => {});
  }
  return qc;
}

describe('mergeRows', () => {
  const list = [row('a', '2026-01-03'), row('b', '2026-01-02'), row('c', '2026-01-01')];

  it('moves an updated row to its place by updated_at', () => {
    const out = mergeRows(list, ['c'], [row('c', '2026-01-04', { unread_count: 1 })]);
    expect(out!.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect((out![0] as { unread_count?: number }).unread_count).toBe(1);
  });

  it('inserts a new row and removes one the server no longer lists', () => {
    const out = mergeRows(list, ['b', 'n'], [row('n', '2026-01-02T12:00')]);
    expect(out!.map((r) => r.id)).toEqual(['a', 'n', 'c']);
  });

  it('leaves the array untouched when nothing requested is present or returned', () => {
    expect(mergeRows(list, ['zzz'], [])).toBe(list);
  });
});

describe('refreshConversations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listMock.mockReset();
    networkMock.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('coalesces a burst into one narrowed read and upserts the row, reusing its network profile', async () => {
    const qc = clientWithList([row('a', '2026-01-02', { visitor_network: { geo: 'kept' } }), row('b', '2026-01-01')]);
    listMock.mockResolvedValue({ ids: ['b'], conversations: [row('b', '2026-01-03', { unread_count: 2 })] });

    refreshConversations(qc, WS, ['b']);
    refreshConversations(qc, WS, ['b']);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS + 1);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock.mock.calls[0][0]).toMatchObject({ workspace_id: WS, queue: 'main', status: 'open', scope: 'mine', ids: ['b'] });
    const rows = qc.getQueryData<Array<{ id: string; unread_count?: number; visitor_network?: unknown }>>(KEY)!;
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(rows[0].unread_count).toBe(2);
    // b had no network profile cached before → looked up once, just for b.
    expect(networkMock).toHaveBeenCalledWith(WS, ['b']);
  });

  it('removes a row the narrowed read no longer returns (moved out of this list)', async () => {
    const qc = clientWithList([row('a', '2026-01-02'), row('b', '2026-01-01', { visitor_network: null })]);
    listMock.mockResolvedValue({ ids: ['b'], conversations: [] });
    refreshConversations(qc, WS, ['b']);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS + 1);
    expect(qc.getQueryData<Array<{ id: string }>>(KEY)!.map((r) => r.id)).toEqual(['a']);
    expect(networkMock).not.toHaveBeenCalled();
  });

  it('falls back to a full refetch when the server ignores ids', async () => {
    const qc = clientWithList([row('a', '2026-01-01')]);
    listMock.mockResolvedValue({ conversations: [row('a', '2026-01-01'), row('x', '2026-01-01')] });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    refreshConversations(qc, WS, ['a']);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS + 1);
    expect(spy).toHaveBeenCalledWith({ queryKey: KEY });
    expect(qc.getQueryData<Array<{ id: string }>>(KEY)!.map((r) => r.id)).toEqual(['a']);
  });

  it('only marks a list nobody is showing as stale', async () => {
    const qc = clientWithList([row('a', '2026-01-01')], false);
    refreshConversations(qc, WS, ['a']);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS + 1);
    expect(listMock).not.toHaveBeenCalled();
    expect(qc.getQueryState(KEY)!.isInvalidated).toBe(true);
  });

  it('knows which conversations the cached lists hold', () => {
    const qc = clientWithList([row('a', '2026-01-01')], false);
    expect(isConversationCached(qc, WS, 'a')).toBe(true);
    expect(isConversationCached(qc, WS, 'b')).toBe(false);
  });
});
