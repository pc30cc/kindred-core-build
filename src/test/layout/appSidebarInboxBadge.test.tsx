/**
 * The badge on Inbox in the classic sidebar (owner request of 2026-10-23,
 * R4): the number of conversations with a visitor message nobody has read
 * (useInboxUnread). Expanded, a count after "Inbox", "99+" past 99; on a
 * collapsed rail, a dot on its chip. Nothing at zero. The link's name says
 * the number, for a screen reader and the collapsed rail's tooltip. Staff
 * without an Inbox see no Inbox and ask for no number.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planAccessOf, sectionVisible, type AppSection } from '@/lib/planAccess';
import { inboxAllowed } from '@/lib/inboxAccess';

const nav = vi.hoisted(() => ({
  role: 'agent' as string,
  unread: 0,
  unreadFor: [] as Array<string | undefined>,
}));

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => k, dir: 'ltr', locale: 'en' }),
  useI18n: () => ({ locale: 'en', setLocale: () => {} }),
}));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ allowedLocales: ['en'], canSwitchLanguage: false }),
  usePanelLanguages: () => ({ locales: ['en'], defaultLocale: 'en', switcher: false, ready: true }),
}));
vi.mock('@/features/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me', email: 'me@example.com' }, signOut: async () => {} }) }));
vi.mock('@/hooks/useAdmin', () => ({ useIsGlobalAdmin: () => ({ data: false }) }));
vi.mock('@/features/branding/BrandingContext', () => ({ useBrandingContext: () => ({ platformName: 'Platform' }) }));
vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', slug: 'acme', name: 'Acme', owner_id: 'owner' }, workspaces: [] }),
  useWorkspacePath: () => (p: string) => `/acme${p}`,
}));
vi.mock('@/hooks/useProfile', () => ({ useProfile: () => ({ data: null }) }));
vi.mock('@/hooks/useBranding', () => ({ useBranding: () => ({ data: null }) }));
vi.mock('@/features/workspace/useWorkspaceCapacity', () => ({ useWorkspaceCapacity: () => ({ data: null, isLoading: false }) }));
vi.mock('@/features/workspace/CreateWorkspaceDialog', () => ({ CreateWorkspaceDialog: () => null }));
vi.mock('@/components/layout/PlanStatusBanner', () => ({ PlanStatusBanner: () => null }));
vi.mock('@/features/widget-bridge/hooks', () => ({ useBridgeSettings: () => ({ data: undefined, error: null }) }));
vi.mock('@/hooks/useTeamChat', () => ({ useColleagues: () => ({ data: undefined }) }));
vi.mock('@/hooks/useConversations', () => ({
  useInboxCounts: () => ({ data: undefined }),
  useInboxUnread: (ws: string | undefined) => {
    nav.unreadFor.push(ws);
    return { data: ws ? { conversations: nav.unread, ids: [] } : undefined };
  },
}));
// The sections the sidebar reads, built by the real rules from the role.
vi.mock('@/hooks/useWorkspaceSections', () => ({
  useWorkspaceSections: () => {
    const ctx = {
      plan: planAccessOf(null, false),
      isAdmin: nav.role === 'owner' || nav.role === 'admin',
      inboxAllowed: inboxAllowed(nav.role),
      aiSurface: null,
      aiAutoAnswer: null,
      callCenterEnabled: null,
    };
    return { ...ctx, ready: true, roleKnown: true, workspaceId: 'ws-1', visible: (s: AppSection) => sectionVisible(s, ctx) };
  },
}));

const { AppSidebar } = await import('@/components/layout/AppSidebar');

function sidebar({ collapsed = false }: { collapsed?: boolean } = {}) {
  localStorage.setItem('sidebar_collapsed', collapsed ? '1' : '0');
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/acme']}>
        <AppSidebar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return document.querySelector<HTMLAnchorElement>('a[data-nav-key="inbox"]');
}

beforeEach(() => {
  nav.role = 'agent';
  nav.unread = 0;
  nav.unreadFor = [];
  // The workspace's domain is read over the network: no answer here.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('the sidebar\'s Inbox badge', () => {
  it('shows the count after "Inbox" when the sidebar is open', () => {
    nav.unread = 3;
    const inbox = sidebar()!;
    expect(inbox.querySelector('[data-nav-count]')!.textContent).toBe('3');
    expect(inbox.querySelector('[data-nav-dot]')).toBeNull();
    expect(nav.unreadFor.at(-1)).toBe('ws-1');
  });

  it('caps it at 99+', () => {
    nav.unread = 120;
    expect(sidebar()!.querySelector('[data-nav-count]')!.textContent).toBe('99+');
  });

  it('is a dot on the chip when the rail is collapsed', () => {
    nav.unread = 2;
    const inbox = sidebar({ collapsed: true })!;
    expect(inbox.querySelector('[data-nav-dot]')).not.toBeNull();
    expect(inbox.querySelector('[data-nav-count]')).toBeNull();
  });

  it('shows nothing at zero, open or collapsed', () => {
    let inbox = sidebar()!;
    expect(inbox.querySelector('[data-nav-count]')).toBeNull();
    expect(inbox.getAttribute('aria-label')).toBeNull();
    cleanup();
    inbox = sidebar({ collapsed: true })!;
    expect(inbox.querySelector('[data-nav-dot]')).toBeNull();
  });

  it('names the number in the link\'s label', () => {
    nav.unread = 4;
    expect(sidebar()!.getAttribute('aria-label')).toBe('nav.inbox (4 inbox.unread)');
    cleanup();
    expect(sidebar({ collapsed: true })!.getAttribute('aria-label')).toBe('nav.inbox (4 inbox.unread)');
  });

  it('is not there for staff, who have no Inbox, and nothing is asked for them', () => {
    for (const role of ['analyst', 'marketing_manager', 'viewer']) {
      cleanup();
      nav.role = role;
      nav.unread = 5;
      nav.unreadFor = [];
      expect(sidebar(), role).toBeNull();
      expect(nav.unreadFor.every((ws) => ws === undefined), role).toBe(true);
    }
  });
});
