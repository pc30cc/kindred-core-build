/**
 * Colleague calls in the web panel — the ring and the call
 * (docs/operations/TEAM_CALLS.md, "Web panel"; the API is
 * server/routes/teamCalls.ts):
 *
 *  - a realtime `team_call` event on the member's own channel, confirmed
 *    with GET /api/team-calls/:id, rings: the card above everything with the
 *    colleague's name, voice or video, the person silhouette (never a
 *    letter), the ringtone, and the system notification when the tab is
 *    hidden;
 *  - Answer sends this tab's device id and joins with the call's own token;
 *    Decline declines; the caller's own other tab does not ring;
 *  - the first answer wins: a tab stops when the call was answered
 *    elsewhere, also when its own answer lost the race;
 *  - a ring that ends unanswered leaves a missed-call toast;
 *  - every refusal is said in words, in the panel's language;
 *  - the per-tab device id lives in sessionStorage;
 *  - the ringing card never takes the focus (a key meant for the composer
 *    must not answer), the caller's ringback is the colleague call's own
 *    (a visitor call never silences it, nor it a visitor's), and a channel
 *    join that failed on its way is tried again.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({
  channels: new Map<string, { onEvent?: (p: unknown) => void; onStatus?: (s: string) => void }>(),
  /** How many of the next subscribes fail on their way (they say 'error', then answer a handle). */
  failJoins: 0,
  subscribes: 0,
  requests: [] as Array<{ method: string; path: string; body: Record<string, unknown> }>,
  planOn: true,
  route: (() => ({ status: 404, body: { error: 'not_found' } })) as (req: { method: string; path: string; body: Record<string, unknown> }) => { status: number; body: unknown },
}));
const sound = vi.hoisted(() => ({
  startRingtone: vi.fn(), stopRingtone: vi.fn(), startRingback: vi.fn(), stopRingback: vi.fn(),
  startTeamRingback: vi.fn(), stopTeamRingback: vi.fn(),
}));
const toastSpy = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
const live = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  state: 'idle' as string,
  opts: null as unknown,
}));

vi.mock('@/lib/apiBase', () => ({ API_BASE: '' }));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ allowedLocales: ['en', 'fa'], canSwitchLanguage: false }),
  usePanelLanguages: () => ({ locales: ['en', 'fa'], defaultLocale: 'en', switcher: false, ready: true }),
}));
vi.mock('@/realtime', () => ({
  resolveClientRealtimeProvider: async () => ({
    vendor: 'centrifugo',
    subscribe: async (channel: string, handlers: { onStatus?: (s: string) => void }) => {
      h.subscribes += 1;
      if (h.failJoins > 0) {
        // As the Centrifugo provider does when no token comes: it says so,
        // and answers with a handle all the same.
        h.failJoins -= 1;
        handlers.onStatus?.('error');
        return { unsubscribe: () => { /* nothing joined */ } };
      }
      h.channels.set(channel, handlers);
      handlers.onStatus?.('open');
      return { unsubscribe: () => { h.channels.delete(channel); } };
    },
  }),
}));
vi.mock('@/features/calls/callSound', () => sound);
vi.mock('@/hooks/useEntitlements', () => ({
  usePlanAccess: () => ({ status: h.planOn ? 'ready' : 'loading', feature: (k: string) => h.planOn && k === 'team_calls', module: () => h.planOn, channel: () => h.planOn, limit: () => null }),
}));
vi.mock('@/lib/toast', () => ({ toast: toastSpy }));
vi.mock('@/hooks/useLiveKitCall', () => ({
  useLiveKitCall: (opts: unknown) => (live.opts = opts, {
    state: live.state, error: null, remote: [], localVideoTrack: null, micEnabled: true, cameraEnabled: false,
    connect: live.connect, disconnect: live.disconnect, toggleMic: vi.fn(), toggleCamera: vi.fn(),
    switchCamera: vi.fn(), canSwitchCamera: false, switchingCamera: false, setVideoQuality: vi.fn(),
    videoQuality: 'auto', setAudioOutput: vi.fn(async () => true),
  }),
}));

const { TeamCallProvider, useTeamCall } = await import('@/features/teamCalls/TeamCallContext');
const { teamCallDeviceId, __resetTeamCallDeviceIdForTests } = await import('@/features/teamCalls/deviceId');
const { teamCallErrorKey } = await import('@/features/teamCalls/teamCallErrors');
const { TeamCallApiError } = await import('@/lib/team-calls-api');
const { I18nProvider } = await import('@/i18n');
const { default: en } = await import('@/i18n/locales/en');
const { default: fa } = await import('@/i18n/locales/fa');

const CHANNEL = 'ws:ws-1:user:me';
const PEER = { user_id: 'peer-1', name: 'Daniel Carter', avatar_url: null };

function call(over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'c1', workspace_id: 'ws-1', channel: 'audio', state: 'ringing', outcome: null, role: 'callee',
    peer: PEER, answered_device_id: null, created_at: new Date(now).toISOString(), answered_at: null,
    ended_at: null, expires_at: new Date(now + 45_000).toISOString(), ...over,
  };
}

const TOKEN = {
  token: 'lk-token', expires_at: 0, provider: 'livekit', rtc_url: null, ws_url: 'wss://lk.example.test',
  turn: { urls: [], username: null, credential: null }, ice_policy: 'all',
  network: { rtc_url: null, ws_url: null, region: null, provider: null },
};

function Probe() {
  const ctx = useTeamCall();
  return (
    <button
      type="button"
      data-testid="place"
      onClick={() => { void ctx?.placeCall({ workspaceId: 'ws-1', peer: PEER, channel: 'audio' }); }}
    >
      {ctx?.session?.phase ?? 'none'}
    </button>
  );
}

function mount(locale: 'en' | 'fa' = 'en', extra?: ReactNode) {
  return render(
    <I18nProvider initialLocale={locale} initialTranslations={locale === 'fa' ? fa : en}>
      <TeamCallProvider workspaceId="ws-1" userId="me">
        <Probe />
        {extra}
      </TeamCallProvider>
    </I18nProvider>,
  );
}

async function emit(state: string, callId = 'c1') {
  await waitFor(() => expect(h.channels.has(CHANNEL)).toBe(true));
  act(() => {
    h.channels.get(CHANNEL)!.onEvent?.({ kind: 'team_call', workspace_id: 'ws-1', call_id: callId, state, outcome: null });
  });
}

const sent = (method: string, path: string) => h.requests.filter((r) => r.method === method && r.path === path);

beforeEach(() => {
  h.channels.clear();
  h.failJoins = 0;
  h.subscribes = 0;
  h.requests = [];
  h.route = () => ({ status: 404, body: { error: 'not_found' } });
  h.planOn = true;
  live.state = 'idle';
  live.opts = null;
  live.connect.mockClear();
  live.disconnect.mockClear();
  for (const fn of Object.values(sound)) fn.mockClear();
  toastSpy.info.mockClear();
  toastSpy.error.mockClear();
  sessionStorage.clear();
  __resetTeamCallDeviceIdForTests();
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input);
    const req = { method: (init.method || 'GET').toUpperCase(), path, body: init.body ? JSON.parse(String(init.body)) : {} };
    h.requests.push(req);
    const { status, body } = h.route(req);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the ring', () => {
  it('listens on the member\'s own channel and rings from a confirmed team_call event', async () => {
    h.route = (r) => (r.method === 'GET' && r.path === '/api/team-calls/c1' ? { status: 200, body: { call: call() } } : { status: 404, body: {} });
    mount();
    await emit('ringing');
    const card = await screen.findByRole('alertdialog');
    expect(card).toHaveTextContent('Daniel Carter');
    expect(card).toHaveTextContent('Incoming voice call');
    expect(sent('GET', '/api/team-calls/c1').length).toBeGreaterThan(0);
    expect(sound.startRingtone).toHaveBeenCalled();
    // The person silhouette, never a letter of the name.
    const glyph = card.querySelector('[data-team-call-avatar] svg[data-glyph="person"]');
    expect(glyph).not.toBeNull();
    for (const el of card.querySelectorAll('*')) {
      if (el.children.length === 0) expect(['D', 'DC', 'Da']).not.toContain((el.textContent || '').trim());
    }
  });

  it('does not listen while the workspace\'s plan has no colleague calls', async () => {
    h.planOn = false;
    mount();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.channels.has(CHANNEL)).toBe(false);
  });

  it('a video ring offers Answer with video and without', async () => {
    h.route = () => ({ status: 200, body: { call: call({ channel: 'video' }) } });
    mount();
    await emit('ringing');
    expect(await screen.findByRole('button', { name: 'Answer with video' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Answer without video' })).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Incoming video call');
  });

  it('does not ring for the member\'s own call placed in another tab', async () => {
    h.route = () => ({ status: 200, body: { call: call({ role: 'caller' }) } });
    mount();
    await emit('ringing');
    await waitFor(() => expect(sent('GET', '/api/team-calls/c1')).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sound.startRingtone).not.toHaveBeenCalled();
  });

  it('shows a system notification while the tab is hidden, when allowed, and closes it with the ring', async () => {
    const shown: Array<{ title: string; opts: NotificationOptions; close: ReturnType<typeof vi.fn> }> = [];
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = vi.fn();
      onclick: (() => void) | null = null;
      close = vi.fn();
      constructor(title: string, opts: NotificationOptions) { shown.push({ title, opts, close: this.close }); }
    }
    vi.stubGlobal('Notification', FakeNotification);
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    h.route = (r) => (r.path.endsWith('/decline') ? { status: 200, body: { call: call({ state: 'ended', outcome: 'declined' }) } } : { status: 200, body: { call: call() } });
    mount();
    await emit('ringing');
    await screen.findByRole('alertdialog');
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('Daniel Carter');
    expect(shown[0].opts).toMatchObject({ body: 'Incoming voice call', tag: 'team-call-c1' });
    // Permission is never asked by a ring.
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(shown[0].close).toHaveBeenCalled());
    vis.mockRestore();
  });

  it('is in Persian, right to left, for a Persian panel', async () => {
    h.route = () => ({ status: 200, body: { call: call() } });
    mount('fa');
    await emit('ringing');
    const card = await screen.findByRole('alertdialog');
    expect(card).toHaveAttribute('dir', 'rtl');
    expect(card).toHaveTextContent('تماس صوتی ورودی');
    expect(screen.getByRole('button', { name: 'رد تماس' })).toBeInTheDocument();
  });
});

describe('the ringing card and the listener', () => {
  it('never takes the focus from what the member is typing', async () => {
    h.route = () => ({ status: 200, body: { call: call({ channel: 'video' }) } });
    mount('en', <textarea aria-label="Reply" />);
    const composer = screen.getByRole('textbox', { name: 'Reply' });
    composer.focus();
    await emit('ringing');
    await screen.findByRole('button', { name: 'Answer with video' });
    expect(document.activeElement).toBe(composer);
    expect(sent('POST', '/api/team-calls/c1/accept')).toHaveLength(0);
  });

  it('rings even when the first confirming read failed (the event comes once)', async () => {
    let reads = 0;
    h.route = (r) => {
      if (r.method === 'GET' && r.path === '/api/team-calls/c1') {
        reads += 1;
        return reads === 1 ? { status: 503, body: { error: 'entitlement_status_unavailable' } } : { status: 200, body: { call: call() } };
      }
      return { status: 404, body: {} };
    };
    mount();
    await emit('ringing');
    expect(await screen.findByRole('alertdialog', {}, { timeout: 4_000 })).toHaveTextContent('Daniel Carter');
    expect(reads).toBe(2);
  });

  it('a 404 on the confirming read is final: no ring, no read again', async () => {
    h.route = () => ({ status: 404, body: { error: 'not_found' } });
    mount();
    await emit('ringing');
    await new Promise((r) => setTimeout(r, 1_800));
    expect(sent('GET', '/api/team-calls/c1')).toHaveLength(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('joins the member\'s channel again when a join failed on its way', async () => {
    h.failJoins = 1;
    h.route = () => ({ status: 200, body: { call: call() } });
    mount();
    // The first join said 'error' and answered a handle; the retry (2 s) joins.
    await waitFor(() => expect(h.subscribes).toBe(2), { timeout: 4_000 });
    await emit('ringing');
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Daniel Carter');
  });
});

describe('the ringback', () => {
  it('is the colleague call\'s own: a visitor call\'s stop never silences it, nor its stop a visitor\'s', async () => {
    const real = await vi.importActual<typeof import('@/features/calls/callSound')>('@/features/calls/callSound');
    real.startTeamRingback();
    expect(real.isTeamRingbackActive()).toBe(true);
    // The visitor call's surface stops its ringback on every phase change.
    real.stopRingback('phase:idle');
    expect(real.isTeamRingbackActive()).toBe(true);
    real.startRingback();
    real.stopTeamRingback('answered');
    expect(real.isTeamRingbackActive()).toBe(false);
    expect(real.isRingbackActive()).toBe(true);
    real.stopRingback('test_end');
  });
});

describe('answer and decline', () => {
  it('Answer sends this tab\'s device id, then joins with the call\'s own token', async () => {
    let answeredBy = '';
    h.route = (r) => {
      if (r.path === '/api/team-calls/c1/accept') {
        answeredBy = String(r.body.device_id);
        return { status: 200, body: { call: call({ state: 'connecting', answered_device_id: answeredBy }) } };
      }
      if (r.path === '/api/team-calls/c1/token') return { status: 200, body: TOKEN };
      if (r.path === '/api/team-calls/c1/hangup') return { status: 200, body: { call: call({ state: 'ended', outcome: 'completed' }) } };
      return { status: 200, body: { call: answeredBy ? call({ state: 'connecting', answered_device_id: answeredBy }) : call() } };
    };
    mount();
    await emit('ringing');
    fireEvent.click(await screen.findByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(sent('POST', '/api/team-calls/c1/accept')).toHaveLength(1));
    expect(answeredBy).toMatch(/^web-[a-z0-9]{8,}$/);
    expect(answeredBy).toBe(teamCallDeviceId());
    expect(sound.stopRingtone).toHaveBeenCalled();
    await waitFor(() => expect(live.connect).toHaveBeenCalledTimes(1));
    expect(sent('POST', '/api/team-calls/c1/token')).toHaveLength(1);
    expect(live.connect).toHaveBeenCalledWith(expect.objectContaining({ wsUrl: 'wss://lk.example.test', token: 'lk-token' }));
    // A camera that cannot open never fails the join (that would end the call for both).
    expect(live.opts).toMatchObject({ publishMic: true, cameraOptional: true });
    await waitFor(() => expect(document.querySelector('[data-team-call="window"]')).toHaveAttribute('data-team-call-phase', 'active'));
    // Hang up once the answer went through.
    fireEvent.click(screen.getByRole('button', { name: 'Hang up' }));
    await waitFor(() => expect(sent('POST', '/api/team-calls/c1/hangup')).toHaveLength(1));
  });

  it('Decline declines and stops the ring', async () => {
    h.route = (r) => (r.path.endsWith('/decline')
      ? { status: 200, body: { call: call({ state: 'ended', outcome: 'declined' }) } }
      : { status: 200, body: { call: call() } });
    mount();
    await emit('ringing');
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(sent('POST', '/api/team-calls/c1/decline')).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sound.stopRingtone).toHaveBeenCalled();
    expect(sent('POST', '/api/team-calls/c1/accept')).toHaveLength(0);
    expect(toastSpy.info).not.toHaveBeenCalled();
  });
});

describe('the first answer wins', () => {
  it('stops when the next change shows it answered on another device', async () => {
    let answered = false;
    h.route = () => ({ status: 200, body: { call: answered ? call({ state: 'connecting', answered_device_id: 'ios-7f3a' }) : call() } });
    mount();
    await emit('ringing');
    await screen.findByRole('alertdialog');
    answered = true;
    await emit('connecting');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(sound.stopRingtone).toHaveBeenCalled();
    expect(sent('POST', '/api/team-calls/c1/accept')).toHaveLength(0);
    expect(live.connect).not.toHaveBeenCalled();
    expect(toastSpy.info).not.toHaveBeenCalled();
  });

  it('stops when its own answer lost the race (409 not_ringing)', async () => {
    h.route = (r) => (r.path.endsWith('/accept')
      ? { status: 409, body: { error: 'not_ringing', call: call({ state: 'connecting', answered_device_id: 'android-9' }) } }
      : { status: 200, body: { call: call() } });
    mount();
    await emit('ringing');
    fireEvent.click(await screen.findByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(screen.getByTestId('place')).toHaveTextContent('none'));
    expect(document.querySelector('[data-team-call]')).toBeNull();
    expect(sent('POST', '/api/team-calls/c1/token')).toHaveLength(0);
    expect(live.connect).not.toHaveBeenCalled();
    expect(sent('POST', '/api/team-calls/c1/hangup')).toHaveLength(0);
  });

  it('a ring that ends unanswered leaves a missed-call toast, once', async () => {
    let over = false;
    h.route = () => ({ status: 200, body: { call: over ? call({ state: 'missed', outcome: 'missed' }) : call() } });
    mount();
    await emit('ringing');
    await screen.findByRole('alertdialog');
    over = true;
    await emit('missed');
    await waitFor(() => expect(toastSpy.info).toHaveBeenCalledWith('Missed voice call', { description: 'From Daniel Carter' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await emit('missed');
    await new Promise((r) => setTimeout(r, 30));
    expect(toastSpy.info).toHaveBeenCalledTimes(1);
  });
});

describe('placing a call', () => {
  it('rings the colleague with ringback and joins once answered', async () => {
    let answered = false;
    h.route = (r) => {
      if (r.method === 'POST' && r.path === '/api/team-calls') return { status: 201, body: { call: call({ role: 'caller' }) } };
      if (r.path === '/api/team-calls/c1/token') return { status: 200, body: TOKEN };
      return { status: 200, body: { call: call({ role: 'caller', ...(answered ? { state: 'connecting', answered_device_id: 'ios-1' } : {}) }) } };
    };
    mount();
    fireEvent.click(screen.getByTestId('place'));
    expect(sound.startTeamRingback).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('place')).toHaveTextContent('outgoing'));
    expect(sent('POST', '/api/team-calls')[0].body).toEqual({ workspace_id: 'ws-1', callee_id: 'peer-1', channel: 'audio' });
    expect(await screen.findByText('Ringing…')).toBeInTheDocument();
    answered = true;
    await emit('connecting');
    await waitFor(() => expect(live.connect).toHaveBeenCalledTimes(1));
    expect(sound.stopTeamRingback).toHaveBeenCalled();
    // The visitor call's ringback is never touched by a colleague call.
    expect(sound.startRingback).not.toHaveBeenCalled();
    expect(sound.stopRingback).not.toHaveBeenCalled();
  });

  it('says a refusal in words', async () => {
    h.route = () => ({ status: 409, body: { error: 'callee_busy' } });
    mount();
    fireEvent.click(screen.getByTestId('place'));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith('Daniel Carter is on another call right now.'));
    expect(screen.getByTestId('place')).toHaveTextContent('none');
    expect(sound.stopTeamRingback).toHaveBeenCalled();
    expect(sound.stopRingback).not.toHaveBeenCalled();
  });

  it('says a refusal in the panel\'s language', async () => {
    h.route = () => ({ status: 422, body: { error: 'limit_reached', limit: 'max_call_minutes_per_month', reason: 'limit', max: 100, used: 100 } });
    mount('fa');
    fireEvent.click(screen.getByTestId('place'));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith('دقیقه‌های تماس این ماه پلن شما تمام شده است.'));
  });
});

describe('the error words', () => {
  const err = (status: number, body: Record<string, unknown>) => new TeamCallApiError(status, String(body.error), body);
  const words = (e: unknown) => {
    const key = teamCallErrorKey(e).split('.');
    return key.reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], en) as string;
  };

  it('names every refusal of the API', () => {
    expect(words(err(409, { error: 'callee_busy' }))).toBe('{{name}} is on another call right now.');
    expect(words(err(409, { error: 'caller_busy' }))).toBe("You're already on a call.");
    expect(words(err(429, { error: 'too_many_calls' }))).toMatch(/Too many calls/);
    expect(words(err(422, { error: 'limit_reached', limit: 'max_concurrent_calls' }))).toMatch(/at the same time/);
    expect(words(err(422, { error: 'limit_reached', limit: 'max_call_minutes_per_month' }))).toMatch(/minutes for this month/);
    expect(words(err(422, { error: 'limit_reached', limit: 'max_concurrent_calls', reason: 'usage_unavailable' }))).toMatch(/can't be checked/);
    expect(words(err(403, { error: 'upgrade_required', feature: 'team_calls' }))).toBe("Colleague calls aren't in this workspace's plan.");
    expect(words(err(403, { error: 'upgrade_required', capability: 'voice_video.video', reason: 'plan' }))).toMatch(/This kind of call/);
    expect(words(err(403, { error: 'upgrade_required', capability: 'voice_video.voice', reason: 'runtime' }))).toMatch(/switched off/);
    expect(words(err(403, { error: 'not_a_member' }))).toMatch(/active member/);
    expect(words(err(503, { error: 'entitlement_status_unavailable' }))).toMatch(/plan can't be checked/);
    expect(words(err(503, { error: 'provider_not_ready' }))).toMatch(/aren't set up/);
    expect(words(err(0, { error: 'network' }))).toMatch(/No connection/);
    expect(words(err(500, { error: 'internal_error' }))).toBe("The call couldn't be placed. Try again.");
    expect(words(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }))).toMatch(/microphone/);
  });

  it('has every word in Persian and Turkish too', async () => {
    const { default: tr } = await import('@/i18n/locales/tr');
    const keys = Object.keys(en.teamCall.errors) as Array<keyof typeof en.teamCall.errors>;
    for (const k of keys) {
      expect(fa.teamCall.errors[k], `fa ${k}`).toMatch(/[؀-ۿ]/);
      expect(tr.teamCall.errors[k], `tr ${k}`).toBeTruthy();
      expect(tr.teamCall.errors[k], `tr ${k}`).not.toBe(en.teamCall.errors[k]);
    }
  });
});

describe('the device id', () => {
  it('is web-<random>, one per tab, kept in sessionStorage across a reload', () => {
    const id = teamCallDeviceId();
    expect(id).toMatch(/^web-[a-z0-9]{8,64}$/);
    expect(teamCallDeviceId()).toBe(id);
    expect(sessionStorage.getItem('team_call_device_id')).toBe(id);
    __resetTeamCallDeviceIdForTests(); // a reload: the module forgets, the tab's storage does not
    expect(teamCallDeviceId()).toBe(id);
    sessionStorage.clear();
    __resetTeamCallDeviceIdForTests(); // another tab
    expect(teamCallDeviceId()).not.toBe(id);
  });

  it('works without sessionStorage', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const id = teamCallDeviceId();
    expect(id).toMatch(/^web-/);
    expect(teamCallDeviceId()).toBe(id);
    spy.mockRestore();
  });
});
