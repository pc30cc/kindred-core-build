/**
 * Staff who do not answer chats (marketing, SEO, analysts, developers,
 * billing, viewers) have no Inbox: it is not offered in the navigation, and
 * its route explains why instead of mounting a page whose every request the
 * server refuses (403 inbox_not_allowed). Owners, admins and the chat team
 * keep it.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { planAccessOf, sectionVisible, type AppSection } from '@/lib/planAccess';
import { inboxAllowed } from '@/lib/inboxAccess';

const who = vi.hoisted(() => ({ role: 'agent' as string | null, pending: false, countsFor: [] as Array<string | undefined> }));

vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (k: string) => k, dir: 'ltr', locale: 'en' }) }));
vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', slug: 'acme' } }),
  useCurrentWorkspace: () => ({ id: 'ws-1', slug: 'acme' }),
  useWorkspacePath: () => (p: string) => `/acme${p}`,
}));
vi.mock('@/hooks/useWorkspaceRole', () => ({
  useWorkspaceRole: () => ({ data: who.role, isPending: who.pending, isSuccess: !who.pending }),
}));
vi.mock('@/hooks/useConversations', () => ({
  useInboxCounts: (ws: string | undefined) => { who.countsFor.push(ws); return { data: { needs_human: 3 } }; },
}));
// The sections the nav reads, built by the real rules from the role.
vi.mock('@/hooks/useWorkspaceSections', () => ({
  useWorkspaceSections: () => {
    const ctx = {
      plan: planAccessOf(null, false),
      isAdmin: who.role === 'owner' || who.role === 'admin',
      inboxAllowed: inboxAllowed(who.pending ? undefined : who.role),
      aiSurface: null,
      aiAutoAnswer: null,
      callCenterEnabled: null,
    };
    return { ...ctx, ready: true, roleKnown: !who.pending, workspaceId: 'ws-1', visible: (s: AppSection) => sectionVisible(s, ctx) };
  },
}));

const { MobileBottomNav } = await import('@/components/layout/MobileBottomNav');
const { RequireInboxAccess } = await import('@/components/inbox/RequireInboxAccess');

beforeEach(() => { who.pending = false; who.countsFor = []; });
afterEach(cleanup);

function bottomNav() {
  render(<MemoryRouter><MobileBottomNav onMenuClick={() => {}} /></MemoryRouter>);
  return [...document.querySelectorAll('nav a')].map((a) => a.getAttribute('href'));
}

describe('the navigation', () => {
  it('offers the Inbox to the chat team, with its count', () => {
    who.role = 'support_agent';
    expect(bottomNav()).toContain('/acme/inbox');
    expect(who.countsFor.at(-1)).toBe('ws-1');
  });

  it('shows it while the role loads, but asks for its counts only once the role is known', () => {
    who.pending = true;
    who.role = undefined as unknown as string;
    expect(bottomNav()).toContain('/acme/inbox');
    expect(who.countsFor.every((ws) => ws === undefined)).toBe(true);
  });

  it('does not offer it to staff, and does not ask for its counts', () => {
    for (const role of ['analyst', 'billing', 'seo_manager', 'viewer']) {
      cleanup();
      who.role = role;
      who.countsFor = [];
      expect(bottomNav(), role).not.toContain('/acme/inbox');
      expect(who.countsFor.every((ws) => ws === undefined), role).toBe(true);
    }
  });
});

describe('the Inbox route', () => {
  const page = () => render(
    <MemoryRouter>
      <RequireInboxAccess><div data-testid="inbox-page" /></RequireInboxAccess>
    </MemoryRouter>,
  );

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
