/**
 * Staff who do not answer chats (marketing, SEO, analysts, developers,
 * billing, viewers) have no Inbox: it is not offered in the navigation, and
 * its route explains why instead of mounting a page whose every request the
 * server refuses (403 inbox_not_allowed). Owners, admins and the chat team
 * keep it. Staff keep the team chat (direct messages between members): on
 * a page of its own (`/team-chat`), where an old link to the Inbox's
 * Colleagues tab takes them. A role that could not be read is no answer:
 * the Inbox shows, as the navigation offers it then. The Inbox tab's badge
 * is its unread number (useInboxUnread), asked for once the role is known
 * and never for staff.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { planAccessOf, sectionVisible, teamChatPageVisible, type AppSection } from '@/lib/planAccess';
import { inboxAllowed } from '@/lib/inboxAccess';

const who = vi.hoisted(() => ({
  role: 'agent' as string | null,
  pending: false,
  /** The role request failed (react-query's error state). */
  failed: false,
  /** The plan has the team chat (`inbox_team_chat`). */
  teamChat: false,
  unreadFor: [] as Array<string | undefined>,
  colleaguesFor: [] as Array<string | undefined>,
}));
const TEAM_CHAT_PLAN = { features: { inbox_team_chat: { value: true } } } as unknown as Parameters<typeof planAccessOf>[0];

vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (k: string) => k, dir: 'ltr', locale: 'en' }) }));
vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', slug: 'acme' } }),
  useCurrentWorkspace: () => ({ id: 'ws-1', slug: 'acme' }),
  useWorkspacePath: () => (p: string) => `/acme${p}`,
}));
vi.mock('@/hooks/useWorkspaceRole', () => ({
  useWorkspaceRole: () => (who.failed
    ? { data: undefined, isPending: false, isSuccess: false, isError: true }
    : { data: who.role, isPending: who.pending, isSuccess: !who.pending }),
}));
vi.mock('@/hooks/useConversations', () => ({
  useInboxUnread: (ws: string | undefined) => { who.unreadFor.push(ws); return { data: ws ? { conversations: 3, ids: [] } : undefined }; },
}));
vi.mock('@/hooks/useTeamChat', () => ({
  useColleagues: (ws: string | undefined) => { who.colleaguesFor.push(ws); return { data: ws ? { colleagues: [], total_unread: 2, me: 'u-1' } : undefined }; },
}));
// The sections the nav reads, built by the real rules from the role.
vi.mock('@/hooks/useWorkspaceSections', () => ({
  useWorkspaceSections: () => {
    const known = !who.pending && !who.failed;
    const ctx = {
      plan: planAccessOf(who.teamChat ? TEAM_CHAT_PLAN : null, false),
      isAdmin: who.role === 'owner' || who.role === 'admin',
      inboxAllowed: inboxAllowed(known ? who.role : undefined),
      aiSurface: null,
      aiAutoAnswer: null,
      callCenterEnabled: null,
    };
    return { ...ctx, ready: true, roleKnown: known, workspaceId: 'ws-1', visible: (s: AppSection) => sectionVisible(s, ctx) };
  },
}));

const { MobileBottomNav } = await import('@/components/layout/MobileBottomNav');
const { RequireInboxAccess } = await import('@/components/inbox/RequireInboxAccess');

beforeEach(() => { who.pending = false; who.failed = false; who.teamChat = false; who.unreadFor = []; who.colleaguesFor = []; });
afterEach(cleanup);

function bottomNav() {
  render(<MemoryRouter><MobileBottomNav onMenuClick={() => {}} /></MemoryRouter>);
  return [...document.querySelectorAll('nav a')].map((a) => a.getAttribute('href'));
}

describe('the navigation', () => {
  it('offers the Inbox to the chat team, with its unread number', () => {
    who.role = 'support_agent';
    expect(bottomNav()).toContain('/acme/inbox');
    expect(who.unreadFor.at(-1)).toBe('ws-1');
    expect(document.querySelector('a[href="/acme/inbox"] [data-nav-count]')!.textContent).toBe('3');
  });

  it('shows it while the role loads, but asks for its unread number only once the role is known', () => {
    who.pending = true;
    who.role = undefined as unknown as string;
    expect(bottomNav()).toContain('/acme/inbox');
    expect(who.unreadFor.every((ws) => ws === undefined)).toBe(true);
    expect(document.querySelector('a[href="/acme/inbox"] [data-nav-count]')).toBeNull();
  });

  it('does not offer it to staff, and does not ask for its unread number', () => {
    for (const role of ['analyst', 'billing', 'seo_manager', 'viewer']) {
      cleanup();
      who.role = role;
      who.unreadFor = [];
      expect(bottomNav(), role).not.toContain('/acme/inbox');
      expect(who.unreadFor.every((ws) => ws === undefined), role).toBe(true);
    }
  });
});

describe('the team chat, for staff', () => {
  const staff = ['marketing_manager', 'seo_manager', 'analyst', 'developer', 'billing', 'viewer'];

  it('has a tab of its own, with its unread count, when the plan has it', () => {
    who.teamChat = true;
    for (const role of staff) {
      cleanup();
      who.role = role;
      who.colleaguesFor = [];
      expect(bottomNav(), role).toContain('/acme/team-chat');
      expect(who.colleaguesFor.at(-1), role).toBe('ws-1');
    }
    expect(document.querySelector('a[href="/acme/team-chat"] [data-nav-count]')!.textContent).toBe('2');
  });

  it('not for the Inbox\'s people (its Colleagues tab is theirs), nor while the role loads, nor without the plan', () => {
    who.teamChat = true;
    who.role = 'support_agent';
    expect(bottomNav()).not.toContain('/acme/team-chat');
    cleanup();
    who.pending = true;
    who.role = undefined as unknown as string;
    expect(bottomNav()).not.toContain('/acme/team-chat');
    cleanup();
    who.pending = false;
    who.teamChat = false;
    who.role = 'analyst';
    expect(bottomNav()).not.toContain('/acme/team-chat');
    expect(who.colleaguesFor.every((ws) => ws === undefined)).toBe(true);
  });

  it('the rule itself', () => {
    const plan = planAccessOf(TEAM_CHAT_PLAN, false);
    expect(teamChatPageVisible({ plan, inboxAllowed: false, roleKnown: true })).toBe(true);
    expect(teamChatPageVisible({ plan, inboxAllowed: true, roleKnown: true })).toBe(false);
    expect(teamChatPageVisible({ plan, inboxAllowed: false, roleKnown: false })).toBe(false);
    expect(teamChatPageVisible({ plan: planAccessOf(null, true), inboxAllowed: false, roleKnown: true })).toBe(false);
  });

  it('an old link to the Inbox\'s Colleagues tab goes to the team chat\'s page', () => {
    who.role = 'developer';
    function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname}</div>; }
    render(
      <MemoryRouter initialEntries={['/acme/inbox?filter=colleagues']}>
        <Routes>
          <Route path="/acme/inbox" element={<RequireInboxAccess><div data-testid="inbox-page" /></RequireInboxAccess>} />
          <Route path="/acme/team-chat" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('where').textContent).toBe('/acme/team-chat');
  });

  it('the phone app, which has no such page, explains instead', () => {
    who.role = 'developer';
    render(
      <MemoryRouter initialEntries={['/acme/inbox?filter=colleagues']}>
        <RequireInboxAccess showBack={false} teamChatPage={false}><div data-testid="inbox-page" /></RequireInboxAccess>
      </MemoryRouter>,
    );
    expect(document.querySelector('[data-inbox="not-allowed"]')).not.toBeNull();
  });
});

describe('the Inbox route', () => {
  const page = () => render(
    <MemoryRouter>
      <RequireInboxAccess><div data-testid="inbox-page" /></RequireInboxAccess>
    </MemoryRouter>,
  );

  it('a role that could not be read is no answer: the Inbox shows (the server still refuses staff)', () => {
    who.failed = true;
    who.role = 'owner';
    page();
    expect(screen.queryByTestId('inbox-page')).not.toBeNull();
    expect(document.querySelector('[data-inbox="not-allowed"]')).toBeNull();
  });

  it('opens for the owner, admins and the chat team', () => {
    for (const role of ['owner', 'admin', 'team_lead', 'agent']) {
      cleanup();
      who.role = role;
      page();
      expect(screen.queryByTestId('inbox-page'), role).not.toBeNull();
    }
  });

  it('explains instead of mounting the page for staff', () => {
    who.role = 'marketing_manager';
    page();
    expect(screen.queryByTestId('inbox-page')).toBeNull();
    expect(document.querySelector('[data-inbox="not-allowed"]')).not.toBeNull();
    expect(screen.getByText('inbox.noAccessTitle')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'inbox.noAccessBack' }).getAttribute('href')).toBe('/acme');
  });

  it('mounts nothing while the role is still loading', () => {
    who.pending = true;
    who.role = undefined as unknown as string;
    page();
    expect(screen.queryByTestId('inbox-page')).toBeNull();
    expect(document.querySelector('[data-inbox="not-allowed"]')).toBeNull();
  });
});
