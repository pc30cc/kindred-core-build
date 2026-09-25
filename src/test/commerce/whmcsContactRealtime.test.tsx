// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { RealtimeHandlers } from '@/realtime/types';

const state = vi.hoisted(() => ({ handlers: null as RealtimeHandlers | null, unsubscribe: vi.fn(), list: vi.fn() }));
vi.mock('@/realtime', () => ({ resolveClientRealtimeProvider: async () => ({
  subscribe: async (_channel: string, handlers: RealtimeHandlers) => {
    state.handlers = handlers;
    return { unsubscribe: state.unsubscribe };
  },
}) }));
vi.mock('@/lib/contacts-api', () => ({ contactsApi: { list: state.list } }));
import { useContacts } from '@/hooks/useContacts';

beforeEach(() => {
  state.handlers = null;
  state.unsubscribe.mockClear();
  state.list.mockReset().mockResolvedValue([{ id: 'contact', name: null }]);
});

describe('WHMCS contact change in the operator app', () => {
  it('refreshes an open list immediately, ignores other workspaces and releases its subscription', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const hook = renderHook(() => useContacts('workspace'), { wrapper });
    await waitFor(() => expect(hook.result.current.data).toEqual([{ id: 'contact', name: null }]));
    await waitFor(() => expect(state.handlers).not.toBeNull());
    state.list.mockResolvedValue([{ id: 'contact', name: 'Alice' }]);
    act(() => state.handlers?.onEvent?.({ kind: 'contact_updated', workspace_id: 'other', conversation_id: '', contact_id: 'contact' }));
    expect(state.list).toHaveBeenCalledTimes(1);
    act(() => state.handlers?.onEvent?.({ kind: 'contact_updated', workspace_id: 'workspace', conversation_id: '', contact_id: 'contact' }));
    await waitFor(() => expect(hook.result.current.data).toEqual([{ id: 'contact', name: 'Alice' }]));
    hook.unmount();
    expect(state.unsubscribe).toHaveBeenCalledOnce();
    client.clear();
  });
});
