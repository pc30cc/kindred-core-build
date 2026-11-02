/**
 * Colleague calls in the web panel — the gate (docs/operations/TEAM_CALLS.md,
 * "Web panel"): the call buttons in the colleague thread's header follow the
 * plan's one rule (`team_calls` + the Voice & Video module + the call's own
 * channel, each exactly true; src/lib/planAccess.ts `teamCallAllowed`), are
 * never offered for oneself, and exist only inside the app shell's call
 * controls. The member's own realtime channel goes through the endpoint that
 * mints it for the session's user only.
 *
 * Also: the plan key `mobile_app` (MOBILE_APP_PLAN.md, "Plan") is named in
 * every panel language and on the customer plan card.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkspaceEffectiveEntitlements } from '@/lib/entitlements-api';
import { planAccessOf, teamCallAllowed } from '@/lib/planAccess';

const h = vi.hoisted(() => ({
  snapshot: null as unknown,
  teamCall: null as null | { session: unknown; placeCall: ReturnType<typeof vi.fn> },
  colleagues: [] as unknown[],
}));

vi.mock('@/lib/apiBase', () => ({ API_BASE: '' }));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ allowedLocales: ['en'], canSwitchLanguage: false }),
  usePanelLanguages: () => ({ locales: ['en'], defaultLocale: 'en', switcher: false, ready: true }),
}));
vi.mock('@/features/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me', email: 'me@example.com' } }) }));
vi.mock('@/hooks/useWorkspace', () => ({ useCurrentWorkspace: () => ({ id: 'ws-1', slug: 'kavir', name: 'Kavir' }) }));
vi.mock('@/hooks/useTeamPresence', () => ({ useTeamPresence: () => ({ data: undefined }), presenceMap: () => new Map() }));
vi.mock('@/hooks/useVoiceRecorder', () => ({
  useVoiceRecorder: () => ({ recording: false, seconds: 0, error: null, start: vi.fn(), stop: vi.fn(), cancel: vi.fn() }),
}));
vi.mock('@/components/inbox/EmojiPicker', () => ({ EmojiPicker: () => null }));
vi.mock('@/hooks/useTeamChat', () => ({
  useColleagues: () => ({ data: { colleagues: h.colleagues, total_unread: 0, me: 'me' }, isLoading: false }),
  useTeamThread: () => ({ data: { messages: [], me: 'me' }, isLoading: false }),
  useSendTeamMessage: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useMarkTeamThreadRead: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/hooks/useEntitlements', () => ({
  usePlanAccess: () => planAccessOf(h.snapshot as WorkspaceEffectiveEntitlements | null, false),
}));
vi.mock('@/features/teamCalls/TeamCallContext', () => ({ useTeamCall: () => h.teamCall }));

const { default: TeamChatPanel } = await import('@/components/inbox/TeamChatPanel');
const { I18nProvider } = await import('@/i18n');
const { default: en } = await import('@/i18n/locales/en');

const on = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, { value: true }]));

function snapshot(opts: { features?: string[]; modules?: string[]; channels?: string[] }) {
  return {
    features: on(opts.features ?? []),
    modules: on(opts.modules ?? []),
    channels: on(opts.channels ?? []),
    limits: {},
  };
}

const FULL = { features: ['team_calls'], modules: ['voice_video'], channels: ['voice', 'video'] };
const DANIEL = {
  user_id: 'peer-1', role: 'agent', full_name: 'Daniel Carter', email: 'daniel@example.com',
  avatar_url: null, unread: 0, last_message: null,
};

describe('teamCallAllowed — the one rule', () => {
  it('needs team_calls, the Voice & Video module and the call\'s own channel, each exactly true', () => {
    const plan = (s: unknown) => planAccessOf(s as WorkspaceEffectiveEntitlements, false);
    expect(teamCallAllowed(plan(snapshot(FULL)), 'audio')).toBe(true);
    expect(teamCallAllowed(plan(snapshot(FULL)), 'video')).toBe(true);
    const voiceOnly = snapshot({ ...FULL, channels: ['voice'] });
    expect(teamCallAllowed(plan(voiceOnly), 'audio')).toBe(true);
    expect(teamCallAllowed(plan(voiceOnly), 'video')).toBe(false);
    expect(teamCallAllowed(plan(snapshot({ ...FULL, features: [] })), 'audio')).toBe(false);
    expect(teamCallAllowed(plan(snapshot({ ...FULL, modules: [] })), 'audio')).toBe(false);
    // "true" is not true.
    const loose = { ...snapshot(FULL), features: { team_calls: { value: 'true' } } };
    expect(teamCallAllowed(plan(loose), 'audio')).toBe(false);
  });

  it('offers nothing while the plan is loading or cannot be read', () => {
    expect(teamCallAllowed(planAccessOf(null, false), 'audio')).toBe(false);
    expect(teamCallAllowed(planAccessOf(null, true), 'video')).toBe(false);
  });
});

describe('the colleague thread header', () => {
  beforeEach(() => {
    // jsdom draws no layout: the thread's scroll-to-end has nothing to do.
    Element.prototype.scrollIntoView = vi.fn();
    h.snapshot = snapshot(FULL);
    h.teamCall = { session: null, placeCall: vi.fn(async () => undefined) };
    h.colleagues = [DANIEL];
  });
  afterEach(() => cleanup());

  function openThread() {
    render(
      <I18nProvider initialLocale="en" initialTranslations={en}>
        <TeamChatPanel />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByText('Daniel Carter'));
  }

  it('shows the voice and video buttons when the plan allows both, and places the call from them', () => {
    openThread();
    const voice = screen.getByRole('button', { name: 'Voice call with Daniel Carter' });
    expect(screen.getByRole('button', { name: 'Video call with Daniel Carter' })).toBeInTheDocument();
    fireEvent.click(voice);
    expect(h.teamCall!.placeCall).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      peer: { user_id: 'peer-1', name: 'Daniel Carter', avatar_url: null },
      channel: 'audio',
    });
    // The colleague's e-mail is never what the call carries.
    expect(JSON.stringify(h.teamCall!.placeCall.mock.calls)).not.toContain('daniel@example.com');
  });

  it('shows only the kind the plan\'s channels allow', () => {
    h.snapshot = snapshot({ ...FULL, channels: ['video'] });
    openThread();
    expect(screen.queryByRole('button', { name: 'Voice call with Daniel Carter' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Video call with Daniel Carter' })).toBeInTheDocument();
  });

  it('shows none without team_calls, without the module, while loading, or outside the app shell', () => {
    for (const s of [snapshot({ ...FULL, features: [] }), snapshot({ ...FULL, modules: [] }), null]) {
      h.snapshot = s;
      openThread();
      expect(document.querySelector('[data-team-call-buttons]')).toBeNull();
      cleanup();
    }
    h.snapshot = snapshot(FULL);
    h.teamCall = null;
    openThread();
    expect(document.querySelector('[data-team-call-buttons]')).toBeNull();
  });

  it('never offers a call to oneself', () => {
    h.colleagues = [{ ...DANIEL, user_id: 'me' }];
    openThread();
    expect(document.querySelector('[data-team-call-buttons]')).toBeNull();
  });

  it('is disabled while a call is on', () => {
    h.teamCall = { session: { phase: 'outgoing' }, placeCall: vi.fn() };
    openThread();
    expect(screen.getByRole('button', { name: 'Voice call with Daniel Carter' })).toBeDisabled();
  });
});

describe('the member\'s own realtime channel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is a channel kind of its own, authorized by operator-user-subscribe with no user id sent', async () => {
    vi.doMock('@/realtime/providers/supabaseConnection', () => ({ getSupabaseRealtimeClient: async () => null }));
    const { parseSupabaseChannel, fetchSupabaseTopic } = await import('@/realtime/providers/supabase');
    expect(parseSupabaseChannel('ws:W:user:U')).toEqual({ kind: 'user', workspaceId: 'W', userId: 'U' });
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ vendor: 'supabase', channel: 'ws:W:user:U', topic: 'ws:W:user:U:mac' }) };
    });
    expect(await fetchSupabaseTopic('ws:W:user:U')).toBe('ws:W:user:U:mac');
    expect(calls).toEqual([{ url: '/api/realtime/operator-user-subscribe', body: { workspace_id: 'W', transport: 'supabase' } }]);
  });
});

describe('the plan key mobile_app', () => {
  it('is named in en/fa/tr and on the plan card', async () => {
    const { capabilityLabel, capabilityDescription } = await import('@/lib/capability-i18n');
    expect(capabilityLabel('mobile_app', 'en')).toBe('Mobile App');
    expect(capabilityLabel('mobile_app', 'fa')).toBe('اپ موبایل (آیفون و اندروید)');
    expect(capabilityLabel('mobile_app', 'tr')).toBe('Mobil uygulamalar (iPhone ve Android)');
    expect(capabilityDescription('mobile_app', 'fa')).toMatch(/[؀-ۿ]/);
    expect(capabilityDescription('mobile_app', 'tr')).toBeTruthy();
    const [{ default: enL }, { default: faL }, { default: trL }] = await Promise.all([
      import('@/i18n/locales/en'), import('@/i18n/locales/fa'), import('@/i18n/locales/tr'),
    ]);
    expect(enL.billing.plans.feat.mobile_app).toBe('Mobile apps (iPhone and Android)');
    expect(faL.billing.plans.feat.mobile_app).toBe('اپ موبایل (آیفون و اندروید)');
    expect(trL.billing.plans.feat.mobile_app).toBe('Mobil uygulamalar (iPhone ve Android)');
  });
});
