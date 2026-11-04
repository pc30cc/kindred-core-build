/**
 * Switching colleagues in the team chat never shows the previous colleague's
 * thread under the new one's name (its call lines would call back the new
 * one): the new thread starts empty and loading until its own messages come.
 * The same holds wherever a kept-previous placeholder spans entities.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useTeamThread } from '@/hooks/useTeamChat';
import { keepPreviousForSame } from '@/lib/keepPreviousForSame';

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('useTeamThread', () => {
  it('a new colleague shows no messages but the loader until theirs arrive', async () => {
    let releaseB: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const peer = new URL(url, 'http://x').searchParams.get('peer_id');
      const body = { me: 'me', messages: [{ id: `${peer}-1`, sender_id: peer, body: `from ${peer}` }] };
      const res = { ok: true, json: async () => body };
      if (peer === 'B') return new Promise((r) => { releaseB = () => r(res); });
      return Promise.resolve(res);
    }));
    const { result, rerender } = renderHook(({ peer }) => useTeamThread('ws1', peer), {
      wrapper: wrapper(), initialProps: { peer: 'A' as string | null },
    });
    await waitFor(() => expect(result.current.data?.messages[0].id).toBe('A-1'));

    rerender({ peer: 'B' });
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);

    await act(async () => { releaseB!(); });
    await waitFor(() => expect(result.current.data?.messages[0].id).toBe('B-1'));
  });
});

describe('keepPreviousForSame', () => {
  function useList(key: readonly unknown[], fetcher: () => Promise<string>) {
    return useQuery({ queryKey: key, queryFn: fetcher, placeholderData: keepPreviousForSame(key, 2) });
  }

  it('keeps the previous rows for another page of the same entity only', async () => {
    const pending: Record<string, (v: string) => void> = {};
    const fetcher = (k: string) => () => (k === 'ws1|1' ? Promise.resolve('ws1 page 1') : new Promise<string>((r) => { pending[k] = r; }));
    const { result, rerender } = renderHook(({ ws, page }) => useList(['rows', ws, page], fetcher(`${ws}|${page}`)), {
      wrapper: wrapper(), initialProps: { ws: 'ws1', page: 1 },
    });
    await waitFor(() => expect(result.current.data).toBe('ws1 page 1'));

    rerender({ ws: 'ws1', page: 2 });
    expect(result.current.data).toBe('ws1 page 1');
    expect(result.current.isPlaceholderData).toBe(true);

    rerender({ ws: 'ws2', page: 2 });
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });
});
