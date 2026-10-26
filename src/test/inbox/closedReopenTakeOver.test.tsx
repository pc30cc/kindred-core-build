/**
 * Reopen from the Inbox's Closed tab, on a conversation the AI held with
 * nobody on it (migration 284: the system's inactivity close leaves the AI's
 * hold as it was, and only the Closed tab lists such a row). Reopened as it
 * was, it went back to the AI, unassigned, and the "all" list the Inbox
 * switches to never shows an AI-managed row, so the selection was dropped
 * under the operator's hands. Now the Inbox takes it over first, as the
 * header's Take over does: it lands with the operator and stays selected.
 *
 * The list is a fake of the server's filter (server/routes/conversations.ts,
 * queue main): AI-managed rows only when the status asked for is `closed`.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';

type Row = {
  id: string; workspace_id: string; status: string; channel: string; subject: string;
  assigned_to: string | null; metadata: Record<string, unknown>; contacts: { name: string } | null;
  contact_id: string | null; created_at: string; updated_at: string; last_message_at: string; unread_count: number;
};

const db = vi.hoisted(() => ({
  rows: [] as Row[],
  version: 0,
  listeners: new Set<() => void>(),
  calls: [] as string[],
  takeOverFails: false,
}));
function changed() {
  db.version += 1;
  for (const l of db.listeners) l();
}
const toastSpy = vi.hoisted(() => vi.fn());

vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (k: string) => k, dir: 'ltr', locale: 'en' }) }));
vi.mock('@/features/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));
vi.mock('@/hooks/useWorkspace', () => ({ useCurrentWorkspace: () => ({ id: 'ws-1', slug: 'shop', name: 'Shop', owner_id: 'me' }) }));
vi.mock('@/hooks/useBranding', () => ({ useBranding: () => ({ data: undefined }) }));
vi.mock('@/hooks/useInboxRealtime', () => ({ useInboxRealtime: () => undefined }));
vi.mock('@/hooks/useGeoEnrichmentRealtime', () => ({ useGeoEnrichmentRealtime: () => undefined }));
vi.mock('@/hooks/useVisitorPresence', () => ({ useVisitorPresenceForConversation: () => ({ data: undefined }) }));
vi.mock('@/hooks/useAdmin', () => ({ useIsGlobalAdmin: () => ({ data: false }) }));
vi.mock('@/hooks/useWorkspaceRole', () => ({ useWorkspaceRole: () => ({ data: 'owner', isSuccess: true }) }));
vi.mock('@/hooks/useInboxDepartments', () => ({ useInboxDepartments: () => ({ data: [] }) }));
vi.mock('@/hooks/useCannedResponses', () => ({ useTrackCannedResponseUse: () => ({ mutate: () => undefined }) }));
vi.mock('@/hooks/useProfile', () => ({ useProfile: () => ({ data: null }) }));
vi.mock('@/hooks/useTeamChat', () => ({ useColleagues: () => ({ data: [] }) }));
vi.mock('@/hooks/useStickToBottom', () => ({ useStickToBottom: () => undefined }));
vi.mock('@/themes/usePanelTheme', () => ({ usePanelTheme: () => ({ theme: 'default' }) }));
vi.mock('@/hooks/use-toast', () => ({ toast: toastSpy, useToast: () => ({ toast: toastSpy, toasts: [] }) }));
vi.mock('@/hooks/useWorkspaceSections', () => ({
  useWorkspaceSections: () => ({ ready: true, plan: { status: 'ready', feature: () => false }, visible: () => false }),
}));
vi.mock('@/lib/planAccess', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  aiQueueVisible: () => false,
  colleaguesQueueVisible: () => false,
  needsHumanQueueVisible: () => false,
}));
// The panels around the thread read their own data; none is under test.
vi.mock('@/components/inbox/ConversationActionPanel', () => ({ ConversationActionPanel: () => null }));
vi.mock('@/components/inbox/AiGuidancePanel', () => ({ AiGuidancePanel: () => null }));
vi.mock('@/components/inbox/GuidanceComposer', () => ({ GuidanceComposer: () => null }));
vi.mock('@/components/inbox/ConversationActivityPanel', () => ({ ConversationActivityPanel: () => null }));
vi.mock('@/components/inbox/AiSuggestionCard', () => ({ AiSuggestionCard: () => null }));
vi.mock('@/components/inbox/OperatorAssistPanel', () => ({ OperatorAssistPanel: () => null }));
vi.mock('@/components/inbox/SidebarCallCard', () => ({ SidebarCallCard: () => null }));
vi.mock('@/components/inbox/TeamChatPanel', () => ({ default: () => null }));
vi.mock('@/components/canned-responses/CannedResponsePicker', async () => {
  const { forwardRef } = await import('react');
  return { CannedResponsePicker: forwardRef(() => null) };
});
vi.mock('@/features/contacts/ContactDrawer', () => ({ ContactDrawer: () => null }));
vi.mock('@/features/visitors/VisitorNetworkCard', () => ({ VisitorNetworkCard: () => null }));

// The take-over (POST …/take-over): the operator has it, the AI stops.
vi.mock('@/lib/ai-agent-api', () => ({
  aiAgentApi: {
    takeOverConversation: async (_ws: string, id: string) => {
      db.calls.push(`take-over ${id}`);
      if (db.takeOverFails) throw Object.assign(new Error('already_assigned'), { status: 409, body: { error: 'already_assigned' } });
      const row = db.rows.find((r) => r.id === id)!;
      row.assigned_to = 'me';
      row.metadata = { ...row.metadata, ai_state: 'human_active' };
      changed();
      return { ok: true };
    },
  },
}));

vi.mock('@/hooks/useConversations', () => ({
  // The server's list (queue main): an AI-managed row only when the status
  // asked for is exactly `closed`.
  useConversations: (_ws: string, status?: string) => {
    const version = useSyncExternalStore(
      (l: () => void) => { db.listeners.add(l); return () => db.listeners.delete(l); },
      () => db.version,
    );
    const data = useMemo(() => db.rows
      .filter((r) => (status ? status.split(',').includes(r.status) : true))
      .filter((r) => status === 'closed' || r.metadata.ai_state !== 'ai_managed')
      .map((r) => ({ ...r })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, status]);
    return { data, isLoading: false, isPlaceholderData: false };
  },
  useConversationMessages: () => ({ data: [] }),
  useSendMessage: () => ({ mutate: () => undefined, isPending: false }),
  // PATCH status: a move out of closed takes over only when someone has it.
  useUpdateConversation: () => ({
    mutate: () => undefined,
    isPending: false,
    mutateAsync: async (vars: { id: string; status?: string }) => {
      db.calls.push(`patch ${vars.id} ${vars.status}`);
      const row = db.rows.find((r) => r.id === vars.id)!;
      if (vars.status) row.status = vars.status;
      if (row.assigned_to) row.metadata = { ...row.metadata, ai_state: 'human_active' };
      changed();
      return row;
    },
  }),
  useDeleteAllConversations: () => ({ mutateAsync: async () => ({ deleted: 0 }), isPending: false }),
  useMarkConversationSeen: () => ({ mutate: () => undefined }),
  useInboxTabCounts: () => ({ data: undefined }),
  useInboxCounts: () => ({ data: undefined }),
  useMessageReaction: () => ({ mutate: () => undefined }),
}));

const { default: InboxPage } = await import('@/pages/app/InboxPage');

function row(id: string, over: Partial<Row>): Row {
  return {
    id, workspace_id: 'ws-1', status: 'closed', channel: 'website', subject: `Chat ${id}`,
    assigned_to: null, metadata: {}, contacts: { name: `Visitor ${id}` }, contact_id: null,
    created_at: '2026-10-25T08:00:00Z', updated_at: '2026-10-25T09:00:00Z', last_message_at: '2026-10-25T09:00:00Z', unread_count: 0,
    ...over,
  };
}

const where = { search: '' };
function Where() {
  where.search = useLocation().search;
  return null;
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/shop/inbox?status=closed']}>
        <Routes><Route path="/:slug/inbox" element={<><InboxPage /><Where /></>} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function selectAndReopen(container: HTMLElement, id: string) {
  const item = container.querySelector(`[data-conv-id="${id}"]`) as HTMLElement;
  expect(item).toBeTruthy();
  fireEvent.click(item);
  await waitFor(() => expect(container.querySelector(`[data-conv-id="${id}"][data-state="selected"]`)).toBeTruthy());
  const reopen = container.querySelector('button[aria-label="inbox.reopen"]') as HTMLButtonElement;
  expect(reopen).toBeTruthy();
  await act(async () => { fireEvent.click(reopen); });
}

afterEach(() => {
  cleanup();
  db.rows = [];
  db.calls = [];
  db.takeOverFails = false;
  toastSpy.mockClear();
});

describe('Inbox Reopen on a closed conversation the AI held with nobody on it', () => {
  it('takes it over first, so it lands with the operator and stays selected in the "all" list', async () => {
    db.rows = [row('c-ai', { metadata: { ai_state: 'ai_managed' } })];
    const { container } = mount();
    await selectAndReopen(container, 'c-ai');
    await waitFor(() => expect(where.search).toContain('status=all'));
    // Still in the list the Inbox switched to, still the one open.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(container.querySelector('[data-conv-id="c-ai"][data-state="selected"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="inbox.reopen"]')).toBeNull();
    expect(db.calls).toEqual(['take-over c-ai', 'patch c-ai open']);
    expect(db.rows[0]).toMatchObject({ status: 'open', assigned_to: 'me', metadata: { ai_state: 'human_active' } });
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('a failed take-over sends no reopen and says so', async () => {
    db.rows = [row('c-ai', { metadata: { ai_state: 'ai_managed' } })];
    db.takeOverFails = true;
    const { container } = mount();
    await selectAndReopen(container, 'c-ai');
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    expect(toastSpy.mock.calls[0][0]).toMatchObject({ title: 'inbox.takeOverFailed', variant: 'destructive' });
    expect(db.calls).toEqual(['take-over c-ai']);
    expect(db.rows[0]).toMatchObject({ status: 'closed', assigned_to: null });
    expect(where.search).toContain('status=closed');
    expect(container.querySelector('[data-conv-id="c-ai"][data-state="selected"]')).toBeTruthy();
  });

  it('a closed conversation someone has, or the AI never held, is only reopened', async () => {
    db.rows = [
      row('c-mine', { assigned_to: 'me', metadata: { ai_state: 'ai_managed' } }),
      row('c-plain', {}),
    ];
    const { container } = mount();
    await selectAndReopen(container, 'c-mine');
    await waitFor(() => expect(where.search).toContain('status=all'));
    await waitFor(() => expect(container.querySelector('[data-conv-id="c-plain"]')).toBeTruthy());
    fireEvent.click(container.querySelector('[data-conv-id="c-plain"]') as HTMLElement);
    await waitFor(() => expect(container.querySelector('[data-conv-id="c-plain"][data-state="selected"]')).toBeTruthy());
    await act(async () => { fireEvent.click(container.querySelector('button[aria-label="inbox.reopen"]') as HTMLButtonElement); });
    await waitFor(() => expect(db.calls).toEqual(['patch c-mine open', 'patch c-plain open']));
    expect(container.querySelector('[data-conv-id="c-plain"][data-state="selected"]')).toBeTruthy();
  });
});
