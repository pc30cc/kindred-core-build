/**
 * The owner's rule in the web panel (2026-10-24, permanent): an operator or
 * a team member without a photo never shows initials or a letter, and a
 * workspace without a logo never shows its first letter. They wear the
 * platform's two glyphs (shared/avatarGlyphs.ts: the person silhouette, the
 * workspace icon) on the tile the letter had, aria-hidden, the name staying
 * in the text beside it. Visitors and contacts keep their own look
 * (ContactAvatar), and so does the AI agent.
 *
 *   - the glyph components draw the shared paths, sized to their tile;
 *   - OperatorAvatar / OperatorAvatarFallback / WorkspaceMark: the photo or
 *     logo when there is one, the glyph without (and when the logo fails);
 *   - the surfaces themselves, without photos or logos: Operator Activity,
 *     the classic sidebar's workspace mark and menu, Art's workspace
 *     switcher; no element's text is a name's first letter;
 *   - a guard over the panel's source: no first-letter avatar comes back,
 *     outside the visitor/contact and non-avatar uses listed here.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { ReactNode } from 'react';
import { planAccessOf, sectionVisible, type AppSection } from '@/lib/planAccess';
import { inboxAllowed } from '@/lib/inboxAccess';
import { PERSON_SILHOUETTE, WORKSPACE_MARK } from '../../../shared/avatarGlyphs';

const state = vi.hoisted(() => ({
  workspace: { id: 'ws-1', slug: 'kavir', name: 'Kavir Shop', owner_id: 'owner', logo_url: null as string | null },
  workspaces: [] as Array<{ id: string; slug: string; name: string; owner_id: string; logo_url?: string | null }>,
  brandingLogo: null as string | null,
  stats: null as unknown,
}));

vi.mock('@/hooks/usePlatformRegion', () => ({ usePlatformRegion: () => ({ allowedLocales: ['en'], canSwitchLanguage: false }) }));
vi.mock('@/features/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me', email: 'me@example.com' }, signOut: async () => {} }) }));
vi.mock('@/hooks/useAdmin', () => ({ useIsGlobalAdmin: () => ({ data: false }) }));
vi.mock('@/features/branding/BrandingContext', () => ({ useBrandingContext: () => ({ platformName: 'Platform' }) }));
vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: state.workspace, workspaces: state.workspaces }),
  useCurrentWorkspace: () => state.workspace,
  useWorkspacePath: () => (p: string) => `/kavir${p}`,
}));
vi.mock('@/hooks/useWorkspaceRole', () => ({ useWorkspaceRole: () => ({ data: 'owner' }), isWorkspaceAdmin: () => true }));
vi.mock('@/hooks/useProfile', () => ({ useProfile: () => ({ data: null }) }));
vi.mock('@/hooks/useBranding', () => ({ useBranding: () => ({ data: state.brandingLogo ? { logo_url: state.brandingLogo } : null }) }));
vi.mock('@/features/workspace/useWorkspaceCapacity', () => ({ useWorkspaceCapacity: () => ({ data: null, isLoading: false }) }));
vi.mock('@/features/workspace/CreateWorkspaceDialog', () => ({ CreateWorkspaceDialog: () => null }));
vi.mock('@/components/layout/PlanStatusBanner', () => ({ PlanStatusBanner: () => null }));
vi.mock('@/features/widget-bridge/hooks', () => ({ useBridgeSettings: () => ({ data: undefined, error: null }) }));
vi.mock('@/hooks/useTeamChat', () => ({ useColleagues: () => ({ data: undefined }) }));
vi.mock('@/hooks/useConversations', () => ({
  useInboxCounts: () => ({ data: undefined }),
  useInboxUnread: () => ({ data: undefined }),
}));
vi.mock('@/hooks/useWorkspaceSections', () => ({
  useWorkspaceSections: () => {
    const ctx = {
      plan: planAccessOf(null, false),
      isAdmin: true,
      inboxAllowed: inboxAllowed('owner'),
      aiSurface: null,
      aiAutoAnswer: null,
      callCenterEnabled: null,
    };
    return { ...ctx, ready: true, roleKnown: true, workspaceId: 'ws-1', visible: (s: AppSection) => sectionVisible(s, ctx) };
  },
}));
vi.mock('@/lib/operator-activity-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/operator-activity-api')>()),
  fetchOperatorActivity: async () => state.stats,
}));

const { OperatorSilhouette, WorkspaceGlyph } = await import('@/components/ui/avatar-glyphs');
const { OperatorAvatar } = await import('@/components/ui/operator-avatar');
const { OperatorAvatarFallback } = await import('@/components/ui/operator-avatar-fallback');
const { WorkspaceMark } = await import('@/components/ui/workspace-mark');
const { Avatar } = await import('@/components/ui/avatar');
const { AppSidebar } = await import('@/components/layout/AppSidebar');
const { ArtWorkspaceSwitcher } = await import('@/themes/art/shell/ArtWorkspaceSwitcher');
const { default: OperatorActivityPage } = await import('@/pages/app/settings/OperatorActivityPage');
const { I18nProvider } = await import('@/i18n');
const { default: en } = await import('@/i18n/locales/en');

function wrap(node: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider initialLocale="en" initialTranslations={en}>
        <MemoryRouter initialEntries={['/kavir']}>{node}</MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** A name's letters as a letter tile would show them: its first, upper or not, and its first two words' initials. */
function lettersOf(name: string): string[] {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = Array.from(words[0] || '')[0] || '';
  const two = words.length > 1 ? first + (Array.from(words[1])[0] || '') : Array.from(words[0] || '').slice(0, 2).join('');
  return [first, first.toUpperCase(), two, two.toUpperCase()].filter(Boolean);
}

/** The elements whose whole text is one of those names' letters. */
function letterTiles(root: ParentNode, names: string[]): Element[] {
  const letters = new Set(names.flatMap(lettersOf));
  return [...root.querySelectorAll('*')].filter((el) => el.children.length === 0 && letters.has((el.textContent || '').trim()));
}

beforeEach(() => {
  state.workspace = { id: 'ws-1', slug: 'kavir', name: 'Kavir Shop', owner_id: 'owner', logo_url: null };
  state.workspaces = [];
  state.brandingLogo = null;
  // The workspace's domain is read over the network: no answer here.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('the two glyphs', () => {
  it('draw the platform\'s paths, filled with the text colour, hidden from screen readers, sized to their tile', () => {
    const { container } = render(<><OperatorSilhouette /><WorkspaceGlyph /></>);
    const [person, shop] = [...container.querySelectorAll('svg')];
    expect(person.getAttribute('data-glyph')).toBe('person');
    expect(person.querySelector('path')!.getAttribute('d')).toBe(PERSON_SILHOUETTE);
    expect(shop.getAttribute('data-glyph')).toBe('workspace');
    expect(shop.querySelector('path')!.getAttribute('d')).toBe(WORKSPACE_MARK);
    for (const svg of [person, shop]) {
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('fill')).toBe('currentColor');
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('focusable')).toBe('false');
      expect(svg.querySelectorAll('path')).toHaveLength(1);
    }
    // 62% of the avatar for the person, 58% for the workspace (icons.md).
    expect(person.getAttribute('class')).toContain('h-[62%] w-[62%]');
    expect(shop.getAttribute('class')).toContain('h-[58%] w-[58%]');
  });

  it('take a size from the caller (an inline label, a 20-24px chip)', () => {
    const { container } = render(<><OperatorSilhouette className="h-[68%] w-[68%]" /><WorkspaceGlyph className="h-3.5 w-3.5" /></>);
    const [person, shop] = [...container.querySelectorAll('svg')];
    expect(person.getAttribute('class')).toContain('h-[68%] w-[68%]');
    expect(person.getAttribute('class')).not.toContain('62%');
    expect(shop.getAttribute('class')).toContain('h-3.5 w-3.5');
    expect(shop.getAttribute('class')).not.toContain('58%');
  });
});

describe('an operator or a team member without a photo', () => {
  it('OperatorAvatar: the silhouette on the tile, no letter', () => {
    const { container } = render(<OperatorAvatar alt="Zahra Karimi" tone="tint" />);
    const avatar = container.querySelector('[data-avatar="operator"]')!;
    expect(avatar.querySelector('svg[data-glyph="person"]')).not.toBeNull();
    expect(avatar.textContent).toBe('');
    // The tile the letter had (the settings lists' primary tint).
    const tile = avatar.querySelector('[data-slot="avatar-fallback"]')!;
    expect(tile.className).toContain('bg-primary/10');
    expect(tile.className).toContain('text-primary');
    expect(letterTiles(container, ['Zahra Karimi'])).toEqual([]);
  });

  it('OperatorAvatarFallback keeps the classes Art re-tints it by (components.css)', () => {
    const { container } = render(<Avatar><OperatorAvatarFallback /></Avatar>);
    const tile = container.querySelector('[data-slot="avatar-fallback"]')!;
    for (const cls of ['bg-brand-violet/15', 'text-brand-violet', 'ring-brand-violet/30']) expect(tile.className).toContain(cls);
    expect(tile.querySelector('svg[data-glyph="person"] path')!.getAttribute('d')).toBe(PERSON_SILHOUETTE);
    expect(tile.textContent).toBe('');
  });

  it('Operator Activity: every operator\'s tile is the silhouette; the name stays in the row', async () => {
    const row = (user_id: string, name: string) => ({
      user_id, role: 'agent', profile: { id: user_id, full_name: name, email: `${user_id}@x.test`, avatar_url: null },
      online_minutes: 0, present_minutes: 0, active_days: 0, avg_minutes_per_active_day: 0, last_seen: null, daily: {},
      conversations_assigned: 0, conversations_resolved: 0, replies_sent: 0, current_state: 'online', current_reason: '', presence_state: 'active',
    });
    const names = ['Zahra Karimi', 'Qasem', 'Yalda Nouri'];
    state.stats = {
      days: 7, since: '2026-10-15T00:00:00Z', online_time_tracked: false,
      totals: { operators: 3, online_minutes: 0, replies_sent: 0, conversations_assigned: 0, online_now: 3, available_now: 3 },
      operators: names.map((n, i) => row(`u${i}`, n)),
    };
    const { container } = wrap(<OperatorActivityPage />);
    await screen.findAllByText('Qasem');
    const avatars = container.querySelectorAll('[data-avatar="operator"]');
    expect(avatars).toHaveLength(3);
    for (const a of avatars) {
      expect(a.querySelector('svg[data-glyph="person"]')).not.toBeNull();
      expect(a.textContent).toBe('');
    }
    expect(letterTiles(container, names)).toEqual([]);
  });
});

describe('a workspace without a logo', () => {
  it('WorkspaceMark: the workspace icon; the logo when there is one, and the icon again when it fails', () => {
    const { container, rerender } = render(<WorkspaceMark className="h-8 w-8" />);
    expect(container.querySelector('svg[data-glyph="workspace"]')).not.toBeNull();
    expect(container.textContent).toBe('');
    rerender(<WorkspaceMark className="h-8 w-8" logoUrl="https://cdn.test/logo.png" />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://cdn.test/logo.png');
    expect(container.querySelector('svg[data-glyph="workspace"]')).toBeNull();
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg[data-glyph="workspace"]')).not.toBeNull();
    expect(container.querySelector('[data-workspace-mark]')!.getAttribute('data-workspace-mark')).toBe('glyph');
  });

  it('the classic sidebar: its mark and every workspace in its menu wear the icon, never a letter', () => {
    state.workspaces = [
      state.workspace,
      { id: 'ws-2', slug: 'yas', name: 'Yas Gallery', owner_id: 'owner', logo_url: null },
      { id: 'ws-3', slug: 'xenon', name: 'Xenon', owner_id: 'owner', logo_url: 'https://cdn.test/xenon.png' },
    ];
    localStorage.setItem('sidebar_collapsed', '0');
    const { container } = wrap(<AppSidebar />);
    const mark = container.querySelector('[data-shell="workspace-mark"]')!;
    expect(mark.querySelector('svg[data-glyph="workspace"]')).not.toBeNull();
    expect(mark.textContent).toBe('');
    fireEvent.click(mark.closest('button')!);
    const rows = [...container.querySelectorAll('[data-workspace-mark]')].slice(1);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.getAttribute('data-workspace-mark'))).toEqual(['glyph', 'glyph', 'logo']);
    expect(rows[2].querySelector('img')!.getAttribute('src')).toBe('https://cdn.test/xenon.png');
    expect(letterTiles(container, ['Kavir Shop', 'Yas Gallery', 'Xenon'])).toEqual([]);
  });

  it('the classic sidebar\'s mark shows the workspace\'s logo when it has one', () => {
    state.brandingLogo = 'https://cdn.test/kavir.png';
    localStorage.setItem('sidebar_collapsed', '0');
    const { container } = wrap(<AppSidebar />);
    const mark = container.querySelector('[data-shell="workspace-mark"]')!;
    expect(mark.querySelector('img')!.getAttribute('src')).toBe('https://cdn.test/kavir.png');
    expect(mark.querySelector('svg')).toBeNull();
  });

  it('Art\'s workspace switcher: its mark and its rows wear the icon (or the logo), never the first letter', async () => {
    state.workspaces = [
      state.workspace,
      { id: 'ws-2', slug: 'yas', name: 'Yas Gallery', owner_id: 'owner', logo_url: null },
      { id: 'ws-3', slug: 'xenon', name: 'Xenon', owner_id: 'owner', logo_url: 'https://cdn.test/xenon.png' },
    ];
    const { container } = wrap(<ArtWorkspaceSwitcher isWorkspaceAdmin={false} />);
    const trigger = container.querySelector('[data-shell="workspace-switcher"]')!;
    const mark = [...trigger.children].find((c) => c.getAttribute('data-shell') === 'workspace-mark')!;
    expect(mark.querySelector('svg[data-glyph="workspace"]')).not.toBeNull();
    expect(mark.textContent).toBe('');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await screen.findByText('Yas Gallery');
    const rows = [...document.querySelectorAll('[role="menuitem"] [data-workspace-mark]')];
    expect(rows.map((r) => r.getAttribute('data-workspace-mark'))).toEqual(['glyph', 'glyph', 'logo']);
    for (const r of rows.slice(0, 2)) expect(r.querySelector('svg[data-glyph="workspace"]')).not.toBeNull();
    expect(letterTiles(document.body, ['Kavir Shop', 'Yas Gallery', 'Xenon'])).toEqual([]);
  });
});

// ─── The guard over the panel's source ─────────────────────────────────────

const ROOT = resolve(__dirname, '../../..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'test' || name === 'node_modules') continue;
      out.push(...sources(path));
    } else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** What draws a letter from a name: a first character, or the first of two words. */
const LETTER = /charAt\(0\)|\.slice\(0,\s*[12]\)\.toUpperCase\(\)|\[0\]\[0\]|\[0\]\.toUpperCase\(\)|(?:name|Name|email|Email|title|Title)\??\.?\[0\]/;
/** "word" → "Word": capitalising a label, not an avatar. */
const CAPITALISE = /(?:charAt\(0\)|\[0\])\.toUpperCase\(\)(?:\s*\+\s*|\}\$\{)[\w.?]+\.slice\(1\)/;

/**
 * The letters that stay (file, the line's text): visitors and contacts, the
 * platform's own name (not a workspace's), and an e-mail correspondent.
 */
const ALLOWED: Array<[string, string]> = [
  ['src/components/inbox/ContactAvatar.tsx', "if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();"],
  ['src/components/inbox/ContactAvatar.tsx', "if (parts[0].length >= 2) return (parts[0][0] + parts[0][1]).toUpperCase();"],
  ['src/components/inbox/ContactAvatar.tsx', "return parts[0][0].toUpperCase();"],
  ['src/features/contacts/utils.ts', "if (email) return email.charAt(0).toUpperCase();"],
  ['src/pages/app/InboxPage.tsx', "if (name) return name.charAt(0).toUpperCase();"],
  ['src/pages/app/InboxPage.tsx', "if (email) return email.charAt(0).toUpperCase();"],
  ['src/components/call-center/OperatorMediaConsole.tsx', "{(visitorName || remoteIdentities[0] || 'V').slice(0, 1).toUpperCase()}"],
  ['src/pages/app/email/EmailInboxPage.tsx', "return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();"],
  ['src/mobile/MobileLoginPage.tsx', '{brandName.charAt(0)}'],
  ['src/components/admin/notifications/NotificationTemplatesTab.tsx', '{appName.slice(0, 2).toUpperCase()}'],
];

describe('the guard: no letter avatar comes back in the panel', () => {
  it('every first-letter expression in src/ is a visitor\'s, a contact\'s, the platform\'s or a capitalised label', () => {
    const found: string[] = [];
    for (const file of sources(join(ROOT, 'src'))) {
      const rel = relative(ROOT, file).split('\\').join('/');
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!LETTER.test(line) || CAPITALISE.test(line)) return;
        const text = line.trim();
        if (ALLOWED.some(([f, l]) => f === rel && (l === '' ? false : text.includes(l)))) return;
        found.push(`${rel}:${i + 1}: ${text}`);
      });
    }
    // An operator, a team member or a workspace without a photo or logo
    // wears the glyph (src/components/ui/avatar-glyphs.tsx, operator-avatar,
    // workspace-mark), never a letter. A visitor's or contact's goes in ALLOWED.
    expect(found).toEqual([]);
  });

  it('the surfaces that drew letters draw the glyph components now', () => {
    const uses: Array<[string, RegExp]> = [
      ['src/pages/app/settings/TeamDepartmentsPage.tsx', /<OperatorAvatar\b[^]*<OperatorAvatar\b/],
      ['src/pages/app/settings/StaffAccessPage.tsx', /<OperatorAvatar\b/],
      ['src/pages/app/settings/OperatorActivityPage.tsx', /<OperatorAvatar\b/],
      ['src/pages/admin/UsersPage.tsx', /<OperatorAvatarFallback\b[^]*<OperatorAvatarFallback\b/],
      ['src/pages/admin/WorkspacesPage.tsx', /<OperatorAvatar\b[^]*<OperatorAvatar\b/],
      ['src/pages/admin/DashboardPage.tsx', /<OperatorAvatar\b[^]*<WorkspaceMark\b/],
      ['src/pages/app/OverviewPage.tsx', /<OperatorAvatar\b/],
      ['src/mobile/MobileSettingsPage.tsx', /<OperatorAvatar\b/],
      ['src/pages/app/InboxPage.tsx', /data-inbox="agent-avatar"[^]*<OperatorSilhouette \/>/],
      ['src/pages/app/InboxPage.tsx', /data-inbox="empty-tile"[^]*<WorkspaceGlyph \/>/],
      ['src/themes/art/shell/ArtWorkspaceSwitcher.tsx', /<WorkspaceMark logoUrl=\{ws\.logo_url\}/],
      ['src/components/layout/AppSidebar.tsx', /<WorkspaceMark[^]*logoUrl=\{ws\.logo_url\}/],
      ['src/components/app/widget/LauncherStylePicker.tsx', /<OperatorSilhouette \/>[^]*<OperatorSilhouette \/>/],
      ['src/components/app/call-center/CallLauncherStylePicker.tsx', /<OperatorSilhouette \/>/],
      ['src/pages/app/email/EmailInboxPage.tsx', /direction === 'outbound'[^]*<OperatorAvatarFallback \/>/],
    ];
    for (const [file, re] of uses) expect(readFileSync(join(ROOT, file), 'utf8'), file).toMatch(re);
    // OverviewPage keeps ContactAvatar for contacts only: its team list is operators.
    const overview = readFileSync(join(ROOT, 'src/pages/app/OverviewPage.tsx'), 'utf8');
    expect(overview.match(/<ContactAvatar\b/g)).toHaveLength(1);
    expect(readFileSync(join(ROOT, 'src/mobile/MobileSettingsPage.tsx'), 'utf8')).not.toMatch(/ContactAvatar/);
  });
});
