/**
 * The sidebar's call invite (SidebarCallCard): POST /api/call-invitations
 * now refuses at the plan's concurrent call limit up front (429
 * plan_limit_reached), as /api/calls/create does. The card must say so, in
 * the panel's own words for that limit, never "invite sent"; an invite that
 * went says "sent" once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const h = vi.hoisted(() => ({
  sendInvite: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/hooks/use-toast', () => ({ toast: h.toast, useToast: () => ({ toast: h.toast, toasts: [] }) }));
vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (key: string) => key, language: 'en' }) }));
vi.mock('@/hooks/useWorkspace', () => ({ useWorkspacePath: () => (path: string) => path }));
vi.mock('@/themes/usePanelTheme', () => ({ usePanelTheme: () => ({ theme: 'default' }) }));
vi.mock('@/hooks/useLocalMediaPreview', () => ({ useLocalMediaPreview: () => ({ stream: null, state: 'idle' }) }));
vi.mock('@/features/calls/CallStage', () => ({ VideoCallStage: () => null, AudioCallStage: () => null }));
vi.mock('@/hooks/useEntitlements', () => ({
  usePlanAccess: () => ({ status: 'ready', module: () => true, channel: () => true, limit: () => -1 }),
}));
vi.mock('@/lib/entitlements-api', () => ({ fetchLimitUsage: async () => ({ usage: {} }) }));
vi.mock('@/components/inbox/InviteWaitDialog', () => ({
  InviteWaitDialog: ({ open, onConfirm }: { open: boolean; onConfirm: (s: number) => void }) =>
    (open ? <button type="button" onClick={() => onConfirm(60)}>confirm-wait</button> : null),
}));
vi.mock('@/features/calls/OperatorCallContext', () => ({
  useOperatorCall: () => ({
    surface: { phase: 'idle', conversationId: null, channel: 'audio', invitation: null, terminalStatus: null, errorMessage: null },
    creating: null,
    loading: false,
    live: null,
    preview: { stream: null, state: 'idle' },
    floatingMode: 'docked',
    setFloatingMode: () => {},
    latestForConversation: () => null,
    sendInvite: h.sendInvite,
    cancelInvite: async () => {},
    hangup: async () => {},
    closeTerminal: () => {},
    refreshLatest: async () => {},
    lastEnded: null,
  }),
}));

import { SidebarCallCard } from '@/components/inbox/SidebarCallCard';

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SidebarCallCard workspaceId="ws-1" conversationId="conv-1" contactName="Sara" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function invite() {
  renderCard();
  fireEvent.click(screen.getByLabelText('Invite visitor to an audio call'));
  fireEvent.click(await screen.findByText('confirm-wait'));
}

describe('SidebarCallCard: the invite answer', () => {
  beforeEach(() => {
    h.sendInvite.mockReset();
    h.toast.mockReset();
  });
  afterEach(cleanup);

  it('refused at the plan\'s concurrent call limit: the limit, never "sent"', async () => {
    h.sendInvite.mockResolvedValue({ ok: false, code: 'plan_limit_reached' });
    await invite();
    await waitFor(() => expect(h.toast).toHaveBeenCalledTimes(1));
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Concurrent call limit reached on your plan',
      variant: 'destructive',
    }));
    expect(screen.queryByText('confirm-wait')).toBeNull();
  });

  it('another failure: the context told the operator; the card adds no "sent"', async () => {
    h.sendInvite.mockResolvedValue({ ok: false, code: 'plan_forbidden' });
    await invite();
    await waitFor(() => expect(h.sendInvite).toHaveBeenCalled());
    await Promise.resolve();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('sent: "sent", once', async () => {
    h.sendInvite.mockResolvedValue({ ok: true });
    await invite();
    await waitFor(() => expect(h.toast).toHaveBeenCalledTimes(1));
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Audio invite sent' }));
  });
});
