/**
 * The presence surfaces tell the truth (R-25 UI, R-26).
 *
 * R-25 — Operator Activity promised "accurate online time" and showed zero
 * for everyone (online time is no longer recorded, migration 223); its
 * "online now" came from the settings alone, not from an open panel. The AI
 * activation page read `status`, which the server never sent (`state`), so
 * it always said "Unknown" and, in "auto-reply when operators are offline",
 * that the AI answers now.
 *
 * R-26 — the account menu's status dot was always green; its only control
 * was "invisible mode", and its toasts were English in every panel. The menu
 * now offers Online / Away from desk / Offline (migration 282).
 *
 * The Overview's "Resolved or closed" counted every closed conversation; a
 * conversation the inactivity timer closed while it was open or pending
 * (migration 284) is no resolve: it has a neutral pill of its own, drawn
 * only while there is one. A timer close of a resolved one stays a resolve.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import type { AvailabilityResponse, OperatorPresence } from '@/lib/availability-api';
import type { OperatorActivityStats } from '@/lib/operator-activity-api';

const state = vi.hoisted(() => ({
  stats: null as unknown,
  role: 'agent' as string | null,
  availability: null as unknown,
  presence: [] as unknown[],
  updates: [] as unknown[],
  toasts: [] as Array<{ title?: string; description?: string }>,
  conversations: [] as unknown[],
}));

vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1' } }),
  useCurrentWorkspace: () => ({ id: 'ws-1', slug: 'acme' }),
  useWorkspacePath: () => (p: string) => `/acme${p}`,
}));
vi.mock('@/hooks/useWorkspaceRole', () => ({
  useWorkspaceRole: () => ({ data: state.role }),
  isWorkspaceAdmin: (r: string | null | undefined) => r === 'owner' || r === 'admin',
}));
vi.mock('@/lib/operator-activity-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/operator-activity-api')>()),
  fetchOperatorActivity: async () => state.stats,
}));
vi.mock('@/features/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me', email: 'me@acme.test' }, signOut: () => {} }) }));
vi.mock('@/hooks/useProfile', () => ({ useProfile: () => ({ data: { full_name: 'Sara', avatar_url: null } }) }));
vi.mock('@/features/branding/BrandingContext', () => ({ useBrandingContext: () => ({ platformName: 'WebYar' }) }));
vi.mock('@/hooks/useTeamPresence', () => ({ useTeamPresence: (ws: string | undefined) => ({ data: ws ? { presence: state.presence } : undefined }) }));
vi.mock('@/lib/availability-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/availability-api')>()),
  fetchAvailability: async () => state.availability,
  updateAvailability: async (patch: Record<string, unknown>) => {
    state.updates.push(patch);
    const prev = state.availability as AvailabilityResponse;
    return { ...prev, prefs: { ...prev.prefs, ...patch } };
  },
}));
vi.mock('@/hooks/use-toast', () => ({ toast: (t: { title?: string; description?: string }) => { state.toasts.push(t); } }));
// The Overview's other data: an Inbox-only member of a plan without the
// visitor or contact sections.
vi.mock('@/hooks/useConversations', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useConversations')>()),
  useConversations: (ws: string | undefined) => ({ data: ws ? state.conversations : undefined, isPending: false }),
}));
vi.mock('@/hooks/useWorkspaceSections', () => ({
  useWorkspaceSections: () => ({ visible: (section: string) => section === 'inbox', roleKnown: true, ready: true, workspaceId: 'ws-1' }),
}));
vi.mock('@/hooks/useKnowledgeBase', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useKnowledgeBase')>()),
  useKBArticles: () => ({ data: [] }),
}));
vi.mock('@/hooks/useWorkspaceMembers', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useWorkspaceMembers')>()),
  useWorkspaceMembers: () => ({ data: [], isPending: false }),
}));
vi.mock('@/hooks/usePlans', async (orig) => ({ ...(await orig<typeof import('@/hooks/usePlans')>()), useWorkspaceUsage: () => ({ data: null }) }));
vi.mock('@/hooks/useEntitlements', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useEntitlements')>()),
  useWorkspaceEffectiveEntitlements: () => ({ data: null }),
}));
vi.mock('@/hooks/useAiWalletSummary', () => ({ useAiWalletSummary: () => ({ data: null }) }));
vi.mock('@/hooks/useEdition', async (orig) => ({ ...(await orig<typeof import('@/hooks/useEdition')>()), useEdition: () => ({ isIran: true }) }));
vi.mock('@/themes/art/charts/useArtCharts', () => ({ useArtCharts: () => null }));
vi.mock('@/components/magic/NumberTicker', () => ({
  NumberTicker: ({ value, format }: { value: number; format: (n: number) => string }) => <span>{format(value)}</span>,
}));

const { default: OperatorActivityPage } = await import('@/pages/app/settings/OperatorActivityPage');
const { default: OverviewPage } = await import('@/pages/app/OverviewPage');
const { UserMenu } = await import('@/components/layout/UserMenu');
const { I18nProvider } = await import('@/i18n');
const { summaryRows } = await import('@/lib/operator-activity-export');
const { operatorAvailabilityStatus } = await import('@/lib/ai-agent/assistant');
const { myOperatorStatus, manualChoiceOf } = await import('@/lib/myOperatorStatus');

afterEach(() => { cleanup(); state.updates = []; state.toasts = []; });

function mountWith(node: React.ReactNode, locale: 'en' | 'fa' = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider initialLocale={locale} initialTranslations={locale === 'fa' ? fa : en}>
        <MemoryRouter>{node}</MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const op = (user_id: string, name: string, extra: Record<string, unknown> = {}) => ({
  user_id, role: 'agent', profile: { id: user_id, full_name: name, email: null, avatar_url: null },
  online_minutes: 0, present_minutes: 0, active_days: 0, avg_minutes_per_active_day: 0, last_seen: null, daily: {},
  conversations_assigned: 3, conversations_resolved: 2, replies_sent: 5, current_state: 'online', current_reason: '', ...extra,
});

function report(extra: Partial<OperatorActivityStats> = {}): OperatorActivityStats {
  return {
    days: 7, since: '2026-10-14T00:00:00Z', online_time_tracked: false,
    totals: { operators: 3, online_minutes: 0, replies_sent: 15, conversations_assigned: 9, online_now: 2, available_now: 3 },
    operators: [
      op('sara', 'Sara', { presence_state: 'active' }),
      op('reza', 'Reza', { presence_state: 'away' }),
      op('nima', 'Nima', { presence_state: 'disconnected' }),
    ] as OperatorActivityStats['operators'],
    ...extra,
  };
}

describe('Operator Activity', () => {
  it('without recorded online time: no online-time tile or columns, live presence per operator, "online now" from open panels', async () => {
    state.role = 'owner';
    state.stats = report();
    mountWith(<OperatorActivityPage />);
    await screen.findByText('Sara');
    expect(document.body.textContent).not.toContain('Accurate online time');
    // The column label and its zeros are gone; the note says why.
    expect(screen.queryByText('Online time')).toBeNull();
    expect(screen.queryByText('Avg / day')).toBeNull();
    expect(document.body.textContent).toContain('Online time is not recorded.');
    expect(document.querySelector('[data-kpi="totalOnline"]')).toBeNull();
    expect(document.querySelector('[data-kpi="onlineNow"]')!.textContent).toContain('2');
    expect(document.querySelector('[data-kpi="availableNow"]')!.textContent).toContain('3');
    expect([...document.querySelectorAll('[data-presence]')].map((b) => b.getAttribute('data-presence')))
      .toEqual(['active', 'away', 'disconnected']);
  });

  it('with recorded online time the columns come back', async () => {
    state.role = 'owner';
    state.stats = report({ online_time_tracked: true });
    mountWith(<OperatorActivityPage />);
    await screen.findByText('Sara');
    expect(document.querySelector('[data-kpi="totalOnline"]')).not.toBeNull();
    expect(screen.getAllByText('Online time').length).toBeGreaterThan(0);
  });

  it('an older server (no live presence) does not claim who is online', async () => {
    state.role = 'owner';
    state.stats = report({
      online_time_tracked: undefined,
      operators: [op('sara', 'Sara')] as OperatorActivityStats['operators'],
    });
    mountWith(<OperatorActivityPage />);
    await screen.findByText('Sara');
    expect(document.querySelector('[data-kpi="onlineNow"]')!.textContent).toContain('—');
  });

  it('its CSV leaves the online-time columns out while they are not recorded', () => {
    const [head, first] = summaryRows(report());
    expect(head).not.toContain('online_minutes');
    expect(head).toContain('presence_state');
    expect(first[head.indexOf('presence_state')]).toBe('active');
    expect(summaryRows(report({ online_time_tracked: true }))[0]).toContain('online_minutes');
  });
});

describe('the AI activation page\'s availability', () => {
  it('reads `status`, or the `state` the server always sent; anything else is unknown', () => {
    expect(operatorAvailabilityStatus({ state: 'offline' })).toBe('offline');
    expect(operatorAvailabilityStatus({ status: 'online', state: 'online' })).toBe('online');
    expect(operatorAvailabilityStatus({ status: 'unavailable' })).toBe('unknown');
    expect(operatorAvailabilityStatus(null)).toBe('unknown');
  });
});

const availability = (prefs: Partial<AvailabilityResponse['prefs']> = {}, status: AvailabilityResponse['status'] = { state: 'online', reason: 'available_when_using_app' }): AvailabilityResponse => ({
  prefs: {
    force_offline: false, available_when_using_app: true, schedule_enabled: false, timezone: 'UTC',
    weekly_schedule: {} as AvailabilityResponse['prefs']['weekly_schedule'], ...prefs,
  },
  status,
});
const me = (presence_state: OperatorPresence['presence_state']): OperatorPresence => ({ user_id: 'me', state: 'online', presence_state, reason: '' });

describe('the operator\'s own status', () => {
  it('is what is true: offline by hand, outside their hours, away, not connected, online', () => {
    expect(myOperatorStatus(availability({ force_offline: true }), me('active'))).toBe('offline');
    expect(myOperatorStatus(availability({ available_when_using_app: false }), me('active'))).toBe('offline');
    expect(myOperatorStatus(availability({ schedule_enabled: true }, { state: 'offline', reason: 'outside_schedule' }), me('active'))).toBe('outside_schedule');
    expect(myOperatorStatus(availability(), me('away'))).toBe('away');
    expect(myOperatorStatus(availability(), me('disconnected'))).toBe('disconnected');
    expect(myOperatorStatus(availability(), me('active'))).toBe('online');
    expect(myOperatorStatus(undefined, me('active'))).toBe('unknown');
  });

  it('the menu\'s dot follows it, never a constant green', async () => {
    state.role = 'agent';
    state.presence = [me('active')];
    state.availability = availability({ force_offline: true });
    mountWith(<UserMenu />);
    await waitFor(() => expect(document.querySelector('[data-my-status]')?.getAttribute('data-my-status')).toBe('offline'));
    expect(document.querySelector('[data-my-status]')!.getAttribute('aria-label')).toBe('Offline');
    cleanup();
    state.availability = availability({ schedule_enabled: true }, { state: 'offline', reason: 'outside_schedule' });
    mountWith(<UserMenu />, 'fa');
    await waitFor(() => expect(document.querySelector('[data-my-status]')?.getAttribute('data-my-status')).toBe('outside_schedule'));
    expect(document.querySelector('[data-my-status]')!.getAttribute('aria-label')).toBe('بیرون از ساعت حضور شما');
  });

  it('a status choice writes the real switches and says so in the panel\'s language', async () => {
    state.role = 'support_agent';
    state.presence = [me('active')];
    state.availability = availability();
    mountWith(<UserMenu />, 'fa');
    await waitFor(() => expect(document.querySelector('[data-my-status]')?.getAttribute('data-my-status')).toBe('online'));
    fireEvent.click(document.querySelector('button')!);
    fireEvent.click(document.querySelector('[data-status-choice="offline"]')!);
    await waitFor(() => expect(state.updates).toEqual([{ force_offline: true, manual_away: false }]));
    await waitFor(() => expect(state.toasts[0]?.title).toBe('اکنون آفلاین هستید'));
    expect(JSON.stringify(state.toasts)).not.toMatch(/Invisible mode|Error/);
    await waitFor(() => expect(document.querySelector('[data-status-choice="offline"]')!.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(document.querySelector('[data-status-choice="online"]')!);
    // Online makes them available again, whichever switch had turned them off.
    await waitFor(() => expect(state.updates[1]).toEqual({ force_offline: false, available_when_using_app: true, manual_away: false }));
  });

  it('"Away from desk" is a choice of its own: stored, marked, explained, and the dot says so', async () => {
    state.role = 'owner';
    state.presence = [me('active')];
    state.availability = availability();
    mountWith(<UserMenu />, 'fa');
    await waitFor(() => expect(document.querySelector('[data-my-status]')?.getAttribute('data-my-status')).toBe('online'));
    fireEvent.click(document.querySelector('button')!);
    expect([...document.querySelectorAll('[data-status-choice]')].map((b) => b.getAttribute('data-status-choice'))).toEqual(['online', 'away', 'offline']);
    expect(document.querySelector('[data-status-choice="away"]')!.textContent).toBe('دور از میز');
    fireEvent.click(document.querySelector('[data-status-choice="away"]')!);
    await waitFor(() => expect(state.updates).toEqual([{ force_offline: false, available_when_using_app: true, manual_away: true }]));
    await waitFor(() => expect(state.toasts[0]?.title).toBe('اکنون دور از میز هستید'));
    expect(state.toasts[0]?.description).toBe(fa.nav.statusManualAwayHint);
    await waitFor(() => expect(document.querySelector('[data-status-choice="away"]')!.getAttribute('aria-checked')).toBe('true'));
    // Active in the panel, away by choice: the dot follows the choice.
    expect(document.querySelector('[data-my-status]')!.getAttribute('data-my-status')).toBe('manual_away');
    expect(document.querySelector('[data-my-status-menu]')!.textContent).toContain(fa.nav.statusManualAwayHint);
    expect(document.querySelector('[data-status-choice="online"]')!.getAttribute('aria-checked')).toBe('false');
  });

  it('"Appear offline" wins over an away choice; an older server (no manual_away) is online or offline only', () => {
    expect(myOperatorStatus(availability({ manual_away: true }), me('active'))).toBe('manual_away');
    expect(myOperatorStatus(availability({ manual_away: true, force_offline: true }), me('active'))).toBe('offline');
    expect(myOperatorStatus(availability({ manual_away: true }, { state: 'offline', reason: 'manual_away' }), me('away'))).toBe('manual_away');
    expect(manualChoiceOf(availability({ manual_away: true }))).toBe('away');
    expect(manualChoiceOf(availability({ manual_away: true, available_when_using_app: false }))).toBe('offline');
    expect(manualChoiceOf(availability())).toBe('online');
  });

  it('staff, who are never given chats, have no status', async () => {
    state.role = 'seo_manager';
    state.availability = availability();
    mountWith(<UserMenu />);
    await screen.findByText('Sara');
    expect(document.querySelector('[data-my-status]')).toBeNull();
    fireEvent.click(document.querySelector('button')!);
    expect(document.querySelector('[data-my-status-menu]')).toBeNull();
  });
});

describe('the Overview\'s conversation pills', () => {
  const conv = (id: string, status: string, metadata: Record<string, unknown> | null = null) =>
    ({ id, status, metadata, created_at: '2026-10-20T10:00:00Z', contacts: null, visitor_name: 'Visitor' });
  const pill = (attr: string) => document.querySelector(`[${attr}]`) as HTMLElement | null;
  // The activity chart measures its box.
  beforeAll(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  });

  it('an automatic close of an open or pending conversation is no resolve; it has its own pill', async () => {
    state.role = 'agent';
    state.conversations = [
      conv('a', 'resolved'),
      conv('b', 'closed', { closed_reason: 'operator', closed_from: 'open' }),
      conv('c', 'closed'), // a close from before 284: the operator's
      conv('d', 'closed', { closed_reason: 'inactivity', closed_from: 'resolved' }), // stays the resolve
      conv('e', 'closed', { closed_reason: 'inactivity', closed_from: 'open' }),
      conv('f', 'closed', { closed_reason: 'inactivity', closed_from: 'pending' }),
      conv('g', 'open'),
      conv('h', 'pending'),
    ];
    mountWith(<OverviewPage />);
    await waitFor(() => expect(pill('data-resolved')).not.toBeNull());
    expect(pill('data-resolved')!.textContent).toBe('Resolved or closed: 4');
    expect(pill('data-auto-closed')!.textContent).toBe('Closed automatically: 2');
    expect(pill('data-auto-closed')!.getAttribute('title')).toContain('Not counted as resolved');
  });

  it('no automatic close: no pill', async () => {
    state.role = 'agent';
    state.conversations = [conv('a', 'resolved'), conv('b', 'closed'), conv('d', 'closed', { closed_reason: 'inactivity', closed_from: 'resolved' })];
    mountWith(<OverviewPage />);
    await waitFor(() => expect(pill('data-resolved')!.textContent).toBe('Resolved or closed: 3'));
    expect(pill('data-auto-closed')).toBeNull();
  });

  it('in Persian', async () => {
    state.role = 'agent';
    state.conversations = [conv('e', 'closed', { closed_reason: 'inactivity', closed_from: 'open' })];
    mountWith(<OverviewPage />, 'fa');
    await waitFor(() => expect(pill('data-auto-closed')).not.toBeNull());
    expect(pill('data-auto-closed')!.textContent).toBe('بسته‌شدهٔ خودکار: ۱');
    expect(pill('data-resolved')!.textContent).toBe('حل‌شده یا بسته: ۰');
  });
});
