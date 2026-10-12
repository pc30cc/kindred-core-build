/**
 * Phase 4, paused seats in the app (design §5): the badge and the summary on
 * the team pages, and the page a paused member sees instead of the
 * workspace. Nothing is decided in the client: the server's `seat_locked`
 * (GET /api/workspace-members, GET /api/workspace-members/me) drives it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';

const i18n = vi.hoisted(() => ({
  t: (k: string, vars?: Record<string, string>) => (vars ? `${k} ${JSON.stringify(vars)}` : k),
  locale: 'en',
}));
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: i18n.t, locale: i18n.locale, dir: 'ltr' }),
}));
const ws = vi.hoisted(() => ({ list: [] as Array<{ id: string; slug: string }> }));
vi.mock('@/hooks/useWorkspace', () => ({
  useWorkspaces: () => ({ data: ws.list }),
}));

import { SeatLockedBadge, SeatLockedNotice, SeatLockedSummary } from '@/components/members/SeatLocked';
import { isSeatLocked } from '@/hooks/useOwnSeat';

function withQuery(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  i18n.locale = 'en';
});

describe('a paused seat on the team pages', () => {
  it('only the server flag pauses a member', () => {
    expect(isSeatLocked({ seat_locked: true })).toBe(true);
    expect(isSeatLocked({ seat_locked: false })).toBe(false);
    expect(isSeatLocked({})).toBe(false);
    expect(isSeatLocked(null)).toBe(false);
  });

  it('the badge says "paused by the plan" and explains it', () => {
    render(<SeatLockedBadge />);
    const badge = screen.getByTestId('seat-locked-badge');
    expect(badge.textContent).toContain('members.seatLocked.badge');
    expect(badge.getAttribute('title')).toBe('members.seatLocked.tooltip');
  });

  it('the summary counts paused members in the viewer\'s digits, and is absent at zero', () => {
    const { rerender } = render(<SeatLockedSummary count={0} />);
    expect(screen.queryByTestId('seat-locked-summary')).toBeNull();
    rerender(<SeatLockedSummary count={3} />);
    expect(screen.getByTestId('seat-locked-summary').textContent).toContain('members.seatLocked.summary {"count":"3"}');
    i18n.locale = 'fa';
    rerender(<SeatLockedSummary count={12} />);
    expect(screen.getByTestId('seat-locked-summary').textContent).toContain('۱۲');
  });
});

describe('what a paused member sees', () => {
  it('the paused page, from GET /api/workspace-members/me', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user_id: 'u1', role: 'agent', seat_locked: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    withQuery(<SeatLockedNotice workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByTestId('seat-locked-notice')).toBeTruthy());
    expect(screen.getByText('members.seatLocked.title')).toBeTruthy();
    expect(screen.getByText('members.seatLocked.desc')).toBeTruthy();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/api/workspace-members/me?workspaceId=ws-1');
  });

  it('"Switch workspace" leads to another workspace of the member\'s, never back to the paused one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user_id: 'u1', role: 'agent', seat_locked: true }), { status: 200 })));
    // The paused workspace is the first one: /app would open it again.
    ws.list = [{ id: 'ws-1', slug: 'paused' }, { id: 'ws-2', slug: 'other' }];
    const { unmount } = withQuery(<SeatLockedNotice workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByTestId('seat-locked-notice')).toBeTruthy());
    expect(screen.getByText('members.seatLocked.switchWorkspace').closest('a')?.getAttribute('href')).toBe('/other');
    unmount();
    // No other workspace: no button that would loop back.
    ws.list = [{ id: 'ws-1', slug: 'paused' }];
    withQuery(<SeatLockedNotice workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByTestId('seat-locked-notice')).toBeTruthy());
    expect(screen.queryByText('members.seatLocked.switchWorkspace')).toBeNull();
  });

  it('nothing for a member whose seat is not paused, or when the answer is unreadable', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user_id: 'u1', role: 'agent', seat_locked: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = withQuery(<SeatLockedNotice workspaceId="ws-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('seat-locked-notice')).toBeNull();
    unmount();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    withQuery(<SeatLockedNotice workspaceId="ws-1" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('seat-locked-notice')).toBeNull();
  });

  it('asks nothing without a workspace', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    withQuery(<SeatLockedNotice workspaceId={null} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the texts it uses', () => {
  it('exist in English and Persian (Persian letters only)', () => {
    for (const key of ['badge', 'tooltip', 'title', 'desc', 'summary', 'switchWorkspace'] as const) {
      expect(en.members.seatLocked[key]).toBeTruthy();
      expect(fa.members.seatLocked[key]).toBeTruthy();
      expect(fa.members.seatLocked[key]).not.toMatch(/[يك]/);
    }
    expect(en.members.seatLocked.summary).toContain('{{count}}');
    expect(fa.members.seatLocked.summary).toContain('{{count}}');
  });
});
