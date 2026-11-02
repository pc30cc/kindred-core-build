/**
 * The call in the chat — the web panel's side (docs/operations/TEAM_CALLS.md,
 * "The call in the chat"): every colleague call leaves one line in the two
 * members' team chat, which the panel draws as a call bubble on the caller's
 * side (the phone or video-camera icon, an arrow out ↗ / in ↙ mirrored in
 * RTL, the title for the member looking at it, the time and a completed
 * call's duration; missed, and cancelled for the callee, in the danger
 * colour), never its body. Clicking it calls back with the same channel
 * through the thread header's gate (the plan's one rule, never while a call
 * is on); without the gate it is plain text. The colleagues list previews it
 * by its icon and title.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkspaceEffectiveEntitlements } from '@/lib/entitlements-api';
import { planAccessOf } from '@/lib/planAccess';
import {
  formatTeamCallDuration,
  teamCallLogDuration,
  teamCallLogIsMissed,
  teamCallLogTitleKey,
  teamChatCallOf,
} from '@/features/teamCalls/teamCallLog';

const h = vi.hoisted(() => ({
  snapshot: null as unknown,
  teamCall: null as null | { session: unknown; placeCall: ReturnType<typeof vi.fn> },
  colleagues: [] as unknown[],
  messages: [] as unknown[],
}));

vi.mock('@/lib/apiBase', () => ({ API_BASE: '' }));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ allowedLocales: ['en', 'fa'], canSwitchLanguage: false }),
  usePanelLanguages: () => ({ locales: ['en', 'fa'], defaultLocale: 'en', switcher: false, ready: true }),
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
  useTeamThread: () => ({ data: { messages: h.messages, me: 'me' }, isLoading: false }),
  useSendTeamMessage: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useMarkTeamThreadRead: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/hooks/useEntitlements', () => ({
  usePlanAccess: () => planAccessOf(h.snapshot as WorkspaceEffectiveEntitlements | null, false),
}));
vi.mock('@/features/teamCalls/teamCallState', () => ({ useTeamCall: () => h.teamCall }));

const { default: TeamChatPanel } = await import('@/components/inbox/TeamChatPanel');
const { I18nProvider } = await import('@/i18n');
const { default: en } = await import('@/i18n/locales/en');
const { default: fa } = await import('@/i18n/locales/fa');
const { default: tr } = await import('@/i18n/locales/tr');
const { formatTime } = await import('@/lib/date');

const on = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, { value: true }]));
function snapshot(opts: { features?: string[]; modules?: string[]; channels?: string[] }) {
  return { features: on(opts.features ?? []), modules: on(opts.modules ?? []), channels: on(opts.channels ?? []), limits: {} };
}
const FULL = { features: ['team_calls'], modules: ['voice_video'], channels: ['voice', 'video'] };

const DANIEL = {
  user_id: 'peer-1', role: 'agent', full_name: 'Daniel Carter', email: 'daniel@example.com',
  avatar_url: null, unread: 0, last_message: null as unknown,
};

const AT = '2026-11-02T10:42:00.000Z';
let seq = 0;
/** A call's line as the server writes it: the caller sends it, the body is the old apps' fallback. */
function line(opts: {
  outcome: string; channel?: 'audio' | 'video'; caller?: 'me' | 'peer-1'; duration?: number | null; at?: string;
}) {
  seq += 1;
  const caller = opts.caller ?? 'me';
  const channel = opts.channel ?? 'audio';
  const duration = opts.outcome === 'completed' ? (opts.duration ?? 151) : null;
  return {
    id: `m${seq}`,
    sender_id: caller,
    recipient_id: caller === 'me' ? 'peer-1' : 'me',
    body: `${channel === 'video' ? '📹' : '📞'}${duration != null ? ` ${formatTeamCallDuration(duration)}` : ''}`,
    attachment_id: null,
    attachment: null,
    read_at: null,
    created_at: opts.at ?? AT,
    call: { id: `call-${seq}`, channel, outcome: opts.outcome, duration_seconds: duration, caller_id: caller },
  };
}

function openThread(locale: 'en' | 'fa' = 'en') {
  render(
    <I18nProvider initialLocale={locale} initialTranslations={locale === 'fa' ? fa : en}>
      <TeamChatPanel />
    </I18nProvider>,
  );
  fireEvent.click(screen.getByText('Daniel Carter'));
  return document.querySelector('[data-inbox="thread"]') as HTMLElement;
}

const bubbles = (thread: HTMLElement) => Array.from(thread.querySelectorAll<HTMLElement>('[data-team-call-log]'));

beforeEach(() => {
  // jsdom draws no layout: the thread's scroll-to-end has nothing to do.
  Element.prototype.scrollIntoView = vi.fn();
  h.snapshot = snapshot(FULL);
  h.teamCall = { session: null, placeCall: vi.fn(async () => undefined) };
  h.colleagues = [DANIEL];
  h.messages = [];
  seq = 0;
});
afterEach(() => cleanup());

describe('the rules (teamCallLog.ts)', () => {
  it('titles the line by outcome and by who is looking (the contract\'s table)', () => {
    const title = (outcome: string, channel: 'audio' | 'video', viewerIsCaller: boolean) =>
      teamCallLogTitleKey({ outcome: outcome as never, channel }, viewerIsCaller);
    expect(title('completed', 'audio', true)).toBe('teamCalls.log.voice');
    expect(title('completed', 'audio', false)).toBe('teamCalls.log.voice');
    expect(title('completed', 'video', true)).toBe('teamCalls.log.video');
    expect(title('completed', 'video', false)).toBe('teamCalls.log.video');
    expect(title('missed', 'audio', true)).toBe('teamCalls.log.noAnswer');
    expect(title('missed', 'video', true)).toBe('teamCalls.log.noAnswer');
    expect(title('missed', 'audio', false)).toBe('teamCalls.log.missedVoice');
    expect(title('missed', 'video', false)).toBe('teamCalls.log.missedVideo');
    expect(title('cancelled', 'audio', true)).toBe('teamCalls.log.cancelled');
    expect(title('cancelled', 'audio', false)).toBe('teamCalls.log.missedVoice');
    expect(title('cancelled', 'video', false)).toBe('teamCalls.log.missedVideo');
    for (const viewer of [true, false]) {
      expect(title('declined', 'audio', viewer)).toBe('teamCalls.log.declined');
      expect(title('failed', 'video', viewer)).toBe('teamCalls.log.failed');
    }
  });

  it('draws missed, and cancelled for the callee, in the danger colour', () => {
    const missed = (outcome: string, viewerIsCaller: boolean) => teamCallLogIsMissed({ outcome: outcome as never }, viewerIsCaller);
    expect(missed('missed', false)).toBe(true);
    expect(missed('missed', true)).toBe(true);
    expect(missed('cancelled', false)).toBe(true);
    expect(missed('cancelled', true)).toBe(false);
    for (const outcome of ['completed', 'declined', 'failed']) {
      expect(missed(outcome, false)).toBe(false);
      expect(missed(outcome, true)).toBe(false);
    }
  });

  it('writes a duration as m:ss, or h:mm:ss from an hour on, for a completed call only', () => {
    expect(formatTeamCallDuration(0)).toBe('0:00');
    expect(formatTeamCallDuration(5)).toBe('0:05');
    expect(formatTeamCallDuration(151.9)).toBe('2:31');
    expect(formatTeamCallDuration(3600)).toBe('1:00:00');
    expect(formatTeamCallDuration(3725)).toBe('1:02:05');
    expect(teamCallLogDuration({ outcome: 'completed', duration_seconds: 65 })).toBe('1:05');
    expect(teamCallLogDuration({ outcome: 'completed', duration_seconds: null })).toBeNull();
    expect(teamCallLogDuration({ outcome: 'missed', duration_seconds: 65 })).toBeNull();
  });

  it('reads a call only in the contract\'s shape (anything else is an ordinary line)', () => {
    const good = { id: 'c1', channel: 'video', outcome: 'missed', duration_seconds: null, caller_id: 'u1' };
    expect(teamChatCallOf(good)).toEqual(good);
    expect(teamChatCallOf(null)).toBeNull();
    expect(teamChatCallOf(undefined)).toBeNull();
    expect(teamChatCallOf({ ...good, outcome: 'busy' })).toBeNull();
    expect(teamChatCallOf({ ...good, channel: 'screen' })).toBeNull();
    expect(teamChatCallOf({ ...good, id: '' })).toBeNull();
    expect(teamChatCallOf({ ...good, caller_id: undefined })).toBeNull();
    expect(teamChatCallOf({ ...good, outcome: 'completed', duration_seconds: -3 })?.duration_seconds).toBeNull();
    expect(teamChatCallOf({ ...good, outcome: 'completed', duration_seconds: '12' })?.duration_seconds).toBeNull();
  });

  it('has its words in every panel language, as the contract writes them', () => {
    expect(en.teamCalls.log).toMatchObject({
      voice: 'Voice call', video: 'Video call', missedVoice: 'Missed voice call', missedVideo: 'Missed video call',
      noAnswer: 'No answer', declined: 'Declined', cancelled: 'Cancelled', failed: 'Call failed', callBack: 'Call back',
    });
    expect(fa.teamCalls.log).toMatchObject({
      voice: 'تماس صوتی', video: 'تماس تصویری', missedVoice: 'تماس صوتی بی‌پاسخ', missedVideo: 'تماس تصویری بی‌پاسخ',
      noAnswer: 'بی‌پاسخ', declined: 'رد شد', cancelled: 'لغو شد', failed: 'تماس برقرار نشد', callBack: 'تماس دوباره',
    });
    expect(tr.teamCalls.log).toMatchObject({
      voice: 'Sesli arama', video: 'Görüntülü arama', missedVoice: 'Cevapsız sesli arama', missedVideo: 'Cevapsız görüntülü arama',
      noAnswer: 'Cevap yok', declined: 'Reddedildi', cancelled: 'İptal edildi', failed: 'Arama başarısız', callBack: 'Geri ara',
    });
    for (const locale of [en, fa, tr]) {
      expect(Object.keys(locale.teamCalls.log).sort()).toEqual(Object.keys(en.teamCalls.log).sort());
      expect(locale.teamCalls.log.outgoing).toBeTruthy();
      expect(locale.teamCalls.log.incoming).toBeTruthy();
    }
  });
});

describe('the call bubble in the thread', () => {
  it('draws the caller\'s own lines on their side, outgoing, titled for the caller, without the body', () => {
    h.messages = [
      line({ outcome: 'completed', duration: 151 }),
      line({ outcome: 'missed', channel: 'video' }),
      line({ outcome: 'cancelled' }),
      line({ outcome: 'declined', channel: 'video' }),
      line({ outcome: 'failed' }),
    ];
    const thread = openThread();
    const all = bubbles(thread);
    expect(all.map((b) => b.getAttribute('data-team-call-log'))).toEqual(['completed', 'missed', 'cancelled', 'declined', 'failed']);
    const titles = all.map((b) => b.querySelector('[data-team-call-log-title]')!.textContent);
    expect(titles).toEqual(['Voice call', 'No answer', 'Cancelled', 'Declined', 'Call failed']);
    for (const b of all) {
      expect(b.getAttribute('data-direction')).toBe('outgoing');
      expect(b.getAttribute('data-from')).toBe('agent');
      expect(b.parentElement!.className).toContain('justify-end');
      expect(b.querySelector('[data-team-call-log-arrow]')!.getAttribute('data-team-call-log-arrow')).toBe('out');
      // Never quoted or copied: nothing to select, no menu.
      expect(b.className).toContain('select-none');
    }
    // The completed call shows its time and its duration; the others no duration.
    expect(all[0].querySelector('[data-team-call-log-duration]')!.textContent).toBe('2:31');
    expect(all[0]).toHaveTextContent(formatTime(AT));
    for (const b of all.slice(1)) expect(b.querySelector('[data-team-call-log-duration]')).toBeNull();
    // Missed is drawn in the danger colour, for the caller too; cancelled is not, for the caller.
    expect(all[1].hasAttribute('data-missed')).toBe(true);
    expect(all[1].querySelector('[data-team-call-log-title]')!.className).toContain('text-destructive');
    expect(all[2].hasAttribute('data-missed')).toBe(false);
    expect(all[0].hasAttribute('data-missed')).toBe(false);
    // The fallback body (📞 2:31) is for the older apps only.
    expect(thread.textContent).not.toMatch(/📞|📹/);
    // The voice and the video icon.
    expect(all[0].querySelector('svg.lucide-phone')).not.toBeNull();
    expect(all[1].querySelector('svg.lucide-video')).not.toBeNull();
  });

  it('draws the colleague\'s lines on their side, incoming, titled for the callee', () => {
    h.messages = [
      line({ outcome: 'missed', caller: 'peer-1' }),
      line({ outcome: 'cancelled', channel: 'video', caller: 'peer-1' }),
      line({ outcome: 'completed', channel: 'video', caller: 'peer-1', duration: 3725 }),
      line({ outcome: 'declined', caller: 'peer-1' }),
      line({ outcome: 'failed', channel: 'video', caller: 'peer-1' }),
    ];
    const thread = openThread();
    const all = bubbles(thread);
    const titles = all.map((b) => b.querySelector('[data-team-call-log-title]')!.textContent);
    expect(titles).toEqual(['Missed voice call', 'Missed video call', 'Video call', 'Declined', 'Call failed']);
    for (const b of all) {
      expect(b.getAttribute('data-direction')).toBe('incoming');
      expect(b.getAttribute('data-from')).toBe('contact');
      expect(b.parentElement!.className).toContain('justify-start');
      expect(b.querySelector('[data-team-call-log-arrow]')!.getAttribute('data-team-call-log-arrow')).toBe('in');
    }
    expect(all.map((b) => b.hasAttribute('data-missed'))).toEqual([true, true, false, false, false]);
    expect(all[2].querySelector('[data-team-call-log-duration]')!.textContent).toBe('1:02:05');
  });

  it('calls back with the same channel; its label is the title, the direction and the time', () => {
    h.messages = [
      line({ outcome: 'missed', caller: 'peer-1' }),
      line({ outcome: 'completed', channel: 'video', duration: 151 }),
    ];
    const thread = openThread();
    const time = formatTime(AT);
    const missed = within(thread).getByRole('button', { name: `Missed voice call, Incoming, ${time}` });
    expect(missed).toHaveAttribute('title', 'Call back');
    fireEvent.click(missed);
    expect(h.teamCall!.placeCall).toHaveBeenLastCalledWith({
      workspaceId: 'ws-1',
      peer: { user_id: 'peer-1', name: 'Daniel Carter', avatar_url: null },
      channel: 'audio',
    });
    fireEvent.click(within(thread).getByRole('button', { name: `Video call, 2:31, Outgoing, ${time}` }));
    expect(h.teamCall!.placeCall).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'video' }));
    expect(h.teamCall!.placeCall).toHaveBeenCalledTimes(2);
    // The colleague's e-mail is never what the call carries.
    expect(JSON.stringify(h.teamCall!.placeCall.mock.calls)).not.toContain('daniel@example.com');
  });

  it('is disabled while a call is on', () => {
    h.teamCall = { session: { phase: 'active' }, placeCall: vi.fn() };
    h.messages = [line({ outcome: 'missed', caller: 'peer-1' })];
    const thread = openThread();
    const bubble = within(thread).getByRole('button', { name: /^Missed voice call, Incoming, / });
    expect(bubble).toBeDisabled();
    fireEvent.click(bubble);
    expect(h.teamCall.placeCall).not.toHaveBeenCalled();
  });

  it('calls back again once the call is over', () => {
    h.teamCall = { session: { phase: 'ended' }, placeCall: vi.fn(async () => undefined) };
    h.messages = [line({ outcome: 'declined' })];
    const thread = openThread();
    const bubble = within(thread).getByRole('button', { name: /^Declined, Outgoing, / });
    expect(bubble).toBeEnabled();
    fireEvent.click(bubble);
    expect(h.teamCall.placeCall).toHaveBeenCalledTimes(1);
  });

  it('is plain text, with its direction still read out, when the plan offers no call', () => {
    for (const s of [snapshot({ ...FULL, features: [] }), snapshot({ ...FULL, modules: [] }), null]) {
      h.snapshot = s;
      h.messages = [line({ outcome: 'missed', caller: 'peer-1' })];
      const thread = openThread();
      expect(within(thread).queryByRole('button', { name: /Missed voice call/ })).toBeNull();
      const [bubble] = bubbles(thread);
      expect(bubble.tagName).toBe('DIV');
      expect(bubble).toHaveTextContent('Missed voice call');
      expect(bubble.querySelector('.sr-only')!.textContent).toBe('Incoming');
      cleanup();
    }
  });

  it('calls back only the kind the plan\'s channels allow', () => {
    h.snapshot = snapshot({ ...FULL, channels: ['voice'] });
    h.messages = [line({ outcome: 'missed', caller: 'peer-1' }), line({ outcome: 'missed', channel: 'video', caller: 'peer-1' })];
    const thread = openThread();
    const [voice, video] = bubbles(thread);
    expect(voice.tagName).toBe('BUTTON');
    expect(video.tagName).toBe('DIV');
  });

  it('is plain text outside the app shell\'s call controls', () => {
    h.teamCall = null;
    h.messages = [line({ outcome: 'completed' })];
    const thread = openThread();
    const [bubble] = bubbles(thread);
    expect(bubble.tagName).toBe('DIV');
    expect(bubble).toHaveTextContent('Voice call');
  });

  it('reads an ordinary message (or a call it does not understand) as before', () => {
    h.messages = [
      { id: 'x1', sender_id: 'peer-1', recipient_id: 'me', body: 'Hello there', read_at: null, created_at: AT, call: null },
      { ...line({ outcome: 'busy', caller: 'peer-1' }), body: '📞' },
    ];
    const thread = openThread();
    expect(bubbles(thread)).toHaveLength(0);
    expect(thread).toHaveTextContent('Hello there');
    expect(thread).toHaveTextContent('📞');
  });

  it('is right to left in Persian: the Persian title, the arrow mirrored, the label in Persian', () => {
    h.messages = [line({ outcome: 'missed', caller: 'peer-1' }), line({ outcome: 'completed', channel: 'video' })];
    const thread = openThread('fa');
    const [missed, done] = bubbles(thread);
    expect(missed.querySelector('[data-team-call-log-title]')!.textContent).toBe('تماس صوتی بی‌پاسخ');
    expect(done.querySelector('[data-team-call-log-title]')!.textContent).toBe('تماس تصویری');
    for (const b of [missed, done]) {
      expect(b.querySelector('[data-team-call-log-arrow]')!.getAttribute('class')).toContain('-scale-x-100');
    }
    expect(missed.getAttribute('aria-label')).toMatch(/^تماس صوتی بی‌پاسخ، ورودی، /);
    expect(done.getAttribute('aria-label')).toMatch(/^تماس تصویری، ۲:۳۱، خروجی، /);
    expect(done.getAttribute('aria-label')).not.toMatch(/[0-9]/);
    expect(missed).toHaveAttribute('title', 'تماس دوباره');
    expect(thread.closest('[dir]')!.getAttribute('dir')).toBe('rtl');
  });
});

describe('the colleagues list', () => {
  const row = () => screen.getByText('Daniel Carter').closest('button') as HTMLElement;

  it('previews a call line by its icon and title, not its body', () => {
    h.colleagues = [{
      ...DANIEL,
      last_message: {
        body: '📞', created_at: AT, outgoing: false, attachment_kind: null,
        call: { id: 'c1', channel: 'audio', outcome: 'missed', duration_seconds: null, caller_id: 'peer-1' },
      },
    }];
    render(
      <I18nProvider initialLocale="en" initialTranslations={en}>
        <TeamChatPanel />
      </I18nProvider>,
    );
    const preview = row().querySelector('[data-team-call-preview]') as HTMLElement;
    expect(preview).toHaveTextContent('Missed voice call');
    expect(preview.className).toContain('text-destructive');
    expect(preview.querySelector('svg.lucide-phone')).not.toBeNull();
    expect(row().textContent).not.toContain('📞');
  });

  it('titles the caller\'s own call for the caller, with a completed call\'s duration, without "You:"', () => {
    h.colleagues = [{
      ...DANIEL,
      last_message: {
        body: '📹 2:31', created_at: AT, outgoing: true, attachment_kind: null,
        call: { id: 'c2', channel: 'video', outcome: 'completed', duration_seconds: 151, caller_id: 'me' },
      },
    }, {
      ...DANIEL, user_id: 'peer-2', full_name: 'Sara Ahmadi',
      last_message: {
        body: '📞', created_at: AT, outgoing: true, attachment_kind: null,
        call: { id: 'c3', channel: 'audio', outcome: 'missed', duration_seconds: null, caller_id: 'me' },
      },
    }];
    render(
      <I18nProvider initialLocale="en" initialTranslations={en}>
        <TeamChatPanel />
      </I18nProvider>,
    );
    const preview = row().querySelector('[data-team-call-preview]') as HTMLElement;
    expect(preview).toHaveTextContent('Video call · 2:31');
    expect(preview.className).not.toContain('text-destructive');
    expect(preview.querySelector('svg.lucide-video')).not.toBeNull();
    expect(row().textContent).not.toMatch(/You:|📹/);
    const sara = screen.getByText('Sara Ahmadi').closest('button') as HTMLElement;
    expect(sara.querySelector('[data-team-call-preview]')).toHaveTextContent('No answer');
  });

  it('keeps an ordinary message\'s preview as before', () => {
    h.colleagues = [{ ...DANIEL, last_message: { body: 'See you', created_at: AT, outgoing: true, attachment_kind: null, call: null } }];
    render(
      <I18nProvider initialLocale="en" initialTranslations={en}>
        <TeamChatPanel />
      </I18nProvider>,
    );
    expect(row().querySelector('[data-team-call-preview]')).toBeNull();
    expect(row()).toHaveTextContent('You: See you');
  });
});
