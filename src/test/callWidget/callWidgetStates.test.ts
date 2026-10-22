/**
 * Every engine state and sub-state draws its screen (contract §2.12, the D36
 * order inside a call), in Persian and in English, with today's bootstrap
 * and with the one a 6f8af41 server sends. Nothing becomes a new engine
 * state: the screen is the presentation's reading of the controller.
 *
 * The light screens (01–03, 13–19) and the call stage (04–12, the failure
 * family) with what each draws; the minimised call (Se, Sf, Sg) the panel
 * module lends the launcher; the media (one element per track, moved, never
 * cloned); D23, D32, D34, D35. Phones (D14, board 11): the light screens in
 * a bottom sheet over a scrim, the call full screen, the page held still, the
 * visual viewport of an on-screen keyboard, a rotation (#343). And the
 * engine's round-3 fields end to end, with the real runtime.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callRoutes, closeCallWidgets, fakeApi, flush, mountCallWidget, settle, widgetSource,
  type ApiAnswer, type ApiRequest, type CallServerState, type Engine, type FakeAudioContext, type Mounted, type MountOptions,
} from './mountCallWidget';

afterEach(() => closeCallWidgets());

const NOW = Date.parse('2026-10-22T11:00:00+03:30');
type Variant = { locale: 'fa' | 'en'; legacy: boolean };
const VARIANTS: Variant[] = [
  { locale: 'fa', legacy: false }, { locale: 'en', legacy: false },
  { locale: 'fa', legacy: true }, { locale: 'en', legacy: true },
];
const label = (v: Variant) => `${v.locale}${v.legacy ? ', 6f8af41 bootstrap' : ''}`;
/** The declarations of a rule written at the start of a line of a call stylesheet (`selector { … }`). */
const cssRule = (file: string, sel: string) => {
  const m = widgetSource(file).match(new RegExp(`(?:^|\\n)${sel.replace(/[.()[\]*+?^$|\\]/g, '\\$&')} \\{([^}]*)\\}`));
  expect(m, `${file}: ${sel}`).not.toBeNull();
  return m![1];
};
const panelRule = (sel: string) => cssRule('presentation-default-panel.css', sel);

function opened(v: Variant, bootstrap: Record<string, unknown> = {}): Mounted {
  const m = mountCallWidget({ now: NOW, locale: v.locale, legacy: v.legacy, bootstrap });
  m.open();
  return m;
}

const FAILURES = [
  'operator_left', 'media_disconnected', 'token_expired', 'room_connect_failed', 'rtc_v1_unsupported', 'media_client_missing',
  'media_client_invalid', 'provider_client_not_configured', 'provider_client_not_supported', 'media_not_configured',
];
const JOINING = [null, 'pending', 'token_ready', 'loading_media_client', 'connecting_media', 'waiting_for_operator'];
const voice = { call: { call_type: 'audio' } };
const video = { call: { call_type: 'video' } };

for (const v of VARIANTS) {
  describe(`state → screen (${label(v)})`, () => {
    it('loading → connecting', () => { const m = opened(v); m.set({ state: 'loading' }); expect(m.screenId()).toBe('connecting'); });
    it('online_available → home', () => { const m = opened(v); expect(m.screenId()).toBe('home'); expect(m.root.dataset.state).toBe('online_available'); });
    it('offline → offline', () => {
      const m = opened(v, { capabilities: { voice: false, video: false } });
      expect(m.ctrl.state).toBe('offline');
      expect(m.screenId()).toBe('offline');
    });
    it('pre_call_form → precall', () => { const m = opened(v); m.set({ state: 'pre_call_form' }); expect(m.screenId()).toBe('precall'); });
    it('queue_waiting → queue', () => {
      const m = opened(v);
      m.set({ state: 'queue_waiting', queuePosition: 3, queueStartedAt: NOW - 47_000 });
      expect(m.screenId()).toBe('queue');
      m.set({ queuePosition: 1 });
      expect(m.screenId()).toBe('queue');
    });
    it.each(JOINING)('in_call %s → joining', (status) => {
      const m = opened(v);
      m.set({ state: 'in_call', connectStatus: status, ...voice });
      expect(m.screenId()).toBe('joining');
    });
    it.each(['in_call', 'operator_connected', 'camera_permission_denied'])('in_call %s → voice / video', (status) => {
      const m = opened(v);
      m.set({ state: 'in_call', connectStatus: status, ...voice });
      expect(m.screenId()).toBe('voice');
      m.set({ ...video });
      expect(m.screenId()).toBe('video');
    });
    it('in_call + transferring → transfer; media_reconnecting → reconnect; microphone denied → mic', () => {
      const m = opened(v);
      m.set({ state: 'in_call', connectStatus: 'in_call', transferring: true, ...voice });
      expect(m.screenId()).toBe('transfer');
      m.set({ connectStatus: 'media_reconnecting' });
      expect(m.screenId()).toBe('reconnect');
      m.set({ connectStatus: 'microphone_permission_denied' });
      expect(m.screenId()).toBe('mic');
    });
    it.each(FAILURES)('in_call %s → fail (first in the D36 order)', (status) => {
      const m = opened(v);
      m.set({ state: 'in_call', connectStatus: status, transferring: true, ...voice });
      expect(m.screenId()).toBe('fail');
    });
    it('ended: callback → scheduled; a call to rate → rating; rated → thanks; else → thanks without stars', () => {
      const m = opened(v);
      m.set({ state: 'ended', callbackId: 'a1b2c3d4-0000', endedCallId: 'c1' });
      expect(m.screenId()).toBe('scheduled');
      m.set({ callbackId: null });
      expect(m.screenId()).toBe('rating');
      m.set({ ratingSubmitted: true, ratingValue: 4 });
      expect(m.screenId()).toBe('thanks');
      expect(m.q('[data-screen="thanks"] .mini-stars')).not.toBeNull();
      m.set({ ratingSubmitted: false, endedCallId: null, ratingValue: 0 });
      expect(m.screenId()).toBe('thanks');
      expect(m.q('[data-screen="thanks"] .mini-stars')).toBeNull();
    });
    it('callback_form → callback, step 1 then 2', () => {
      const m = opened(v);
      m.click('[data-action="callback"]');
      expect(m.screenId()).toBe('callback');
      expect(m.q('[data-screen="callback"] .stp .bars .on:last-child')).toBeNull();
      m.click('[data-action="continue"]');
      expect(m.screenId()).toBe('callback');
      expect(m.qa('[data-screen="callback"] .stp .bars .on')).toHaveLength(2);
    });
    it('error → error, its title the error itself (D33)', () => {
      const m = opened(v);
      m.set({ state: 'error', error: 'Boom' });
      expect(m.screenId()).toBe('error');
      expect(m.q('[data-screen="error"] h3[data-error]')!.textContent).toBe('Boom');
      m.set({ error: null });
      expect(m.q('[data-screen="error"] h3[data-error]')!.textContent).toBe(m.ctrl.t('unknown'));
    });
    it('a booked callback shown from the launcher (any state) → scheduled', () => {
      const m = opened(v);
      m.set({ callbackBooking: { callbackId: 'b1c2d3e4-1', scheduled_for: '2026-10-23T16:30:00+03:30', channel: 'video', urgency: 'urgent' } });
      (m.H()!.ui as { bookingView: boolean }).bookingView = true;
      m.ctrl.render();
      expect(m.screenId()).toBe('scheduled');
      expect(m.q('[data-screen="scheduled"] .code')!.textContent).toBe('B1C2D3E4');
    });
    it('one screen is shown; the others are inert', () => {
      const m = opened(v);
      m.set({ state: 'pre_call_form' });
      expect(m.qa('.scr.on')).toHaveLength(1);
      for (const s of m.qa('.scr:not(.on)')) expect(s.hasAttribute('inert')).toBe(true);
      expect(m.screen()!.hasAttribute('inert')).toBe(false);
    });
  });
}

describe('offline behaviours', () => {
  const off = { capabilities: { voice: false, video: false } };
  it('show_callback: the offline screen with its button and note; the launcher asks for a callback', () => {
    const m = mountCallWidget({ bootstrap: { ...off, config: { offline_behavior: 'show_callback' } } });
    expect(m.q('.ccw-launcher-btn')!.classList.contains('off')).toBe(true);
    expect(m.q('.ccw-launcher-btn')!.getAttribute('aria-label')).toBe(m.ctrl.t('callback'));
    expect(m.q('.lbl b')!.textContent).toBe(m.ctrl.t('callback'));
    expect(m.q('.lbl .x')).toBeNull();
    m.open();
    expect(m.q('[data-screen="offline"] [data-action="callback"]')).not.toBeNull();
    expect(m.q('[data-screen="offline"] .inl')).not.toBeNull();
    m.click('[data-screen="offline"] [data-action="callback"]');
    expect(m.screenId()).toBe('callback');
  });
  it('show_message: the same screen without the button; the launcher\'s offline words', () => {
    const m = mountCallWidget({ bootstrap: { ...off, config: { offline_behavior: 'show_message' } } });
    expect(m.q('.lbl b')!.textContent).toBe(m.ctrl.t('support'));
    m.open();
    expect(m.screenId()).toBe('offline');
    expect(m.q('[data-screen="offline"] [data-action="callback"]')).toBeNull();
    // The offline message, never the callback request's words.
    expect(m.q('[data-screen="offline"] h3')!.textContent).toBe(m.ctrl.t('offline_title'));
    expect(m.q('[data-screen="offline"] p')!.textContent).toBe(m.ctrl.t('offline_message'));
    expect(m.q('.hd .st')!.textContent).toBe(m.ctrl.t('offline'));
  });
  it('show_callback with callbacks switched off: no callback offered anywhere', () => {
    const m = mountCallWidget({ bootstrap: { capabilities: { voice: false, video: false, callback: false }, config: { offline_behavior: 'show_callback' } } });
    expect(m.q('.lbl b')!.textContent).toBe(m.ctrl.t('support'));
    expect(m.q('.ccw-launcher-btn')!.getAttribute('aria-label')).not.toBe(m.ctrl.t('callback'));
    m.open();
    expect(m.q('[data-screen="offline"] [data-action="callback"]')).toBeNull();
    expect(m.q('[data-screen="offline"] h3')!.textContent).toBe(m.ctrl.t('offline_title'));
  });
  it('the offline message is the owner\'s own words when set', () => {
    const m = mountCallWidget({ locale: 'fa', bootstrap: { ...off, config: { offline_behavior: 'show_message', custom_texts: { fa: { offline_title: 'تعطیل هستیم', offline_message: 'ساعت کاری ۹ تا ۱۷' } } } } });
    m.open();
    expect(m.q('[data-screen="offline"] h3')!.textContent).toBe('تعطیل هستیم');
    expect(m.q('[data-screen="offline"] p')!.textContent).toBe('ساعت کاری ۹ تا ۱۷');
  });
  it('hide: launcher and panel hidden while offline only', () => {
    const m = mountCallWidget({ bootstrap: { ...off, config: { offline_behavior: 'hide' } } });
    expect((m.q('.ccw-launcher-wrap') as HTMLElement).hidden).toBe(true);
    expect((m.q('#ccw-panel') as HTMLElement).hidden).toBe(true);
    m.set({ state: 'in_call', connectStatus: 'in_call' });
    expect((m.q('.ccw-launcher-wrap') as HTMLElement).hidden).toBe(false);
  });
});

describe('the light screens draw what their state holds', () => {
  it('home: the enabled channels, a single channel spans both columns, the callback row by policy', () => {
    const m = opened({ locale: 'en', legacy: false });
    expect(m.q('.badge .chn')!.textContent).toBe('Voice · Video · Callback');
    expect(m.qa('.opts .opt')).toHaveLength(2);
    const one = opened({ locale: 'en', legacy: false }, { capabilities: { video: false }, callback_policy: { show_when_online: false } });
    expect(one.q('.badge .chn')!.textContent).toBe('Voice · Callback');
    expect(one.q('.opts')!.classList.contains('one')).toBe(true);
    expect(one.q('[data-screen="home"] [data-action="callback"]')).toBeNull();
  });

  it('home: the channel line\'s dots sit in <b>: weight 400 in Persian (the shipped Persian 500 face has no U+00B7, so no Latin face is fetched for them), at the design dot\'s advance; a Latin line keeps its 500 dot', () => {
    const m = opened({ locale: 'fa', legacy: false });
    expect(m.qa('.badge .chn b').map((b) => b.textContent)).toEqual(['·', '·']);
    expect(m.q('.badge .chn')!.textContent).toBe('صوتی · تصویری · درخواست تماس');
    const css = widgetSource('presentation-default-panel.css');
    // `<b>` is bold by default: the dot must not turn 700 anywhere.
    expect(css).toMatch(/(^|\n)\.badge \.chn b \{ font-weight: inherit; \}/);
    // The 400 dot is 0.45px narrower than the reference's at 12px (Tier A box probe of `.badge`, ±0.5px for two dots).
    expect(css).toMatch(/\n\[dir="rtl"\] \.badge \.chn b \{ font-weight: 400; margin-inline: \.01875em; \}/);
  });

  it('channels on but nobody available: the widget is offline, and the workspace\'s offline behaviour applies (D17, owner 2026-10-21)', () => {
    const none = { presence: { any_available: false } };
    const m = opened({ locale: 'en', legacy: false }, none);
    expect(m.ctrl.state).toBe('offline');
    expect(m.screenId()).toBe('offline');
    expect(m.q('.ccw-launcher-btn')!.classList.contains('off')).toBe(true);
    expect(m.qa('[data-action="voice"], [data-action="video"]')).toHaveLength(0);
    const hidden = mountCallWidget({ bootstrap: { ...none, config: { offline_behavior: 'hide' } } });
    expect((hidden.q('.ccw-launcher-wrap') as HTMLElement).hidden).toBe(true);
    const message = opened({ locale: 'en', legacy: false }, { ...none, config: { offline_behavior: 'show_message' } });
    expect(message.q('[data-screen="offline"] h3')!.textContent).toBe(message.ctrl.t('offline_title'));
    // A server from before presence: the channels alone decide, as before.
    expect(opened({ locale: 'en', legacy: true }).ctrl.state).not.toBe('offline');
  });

  it('offline because nobody is available: asks again each minute and comes online when an operator does (never in the preview)', async () => {
    const ticks: Array<() => void> = [];
    const setup = (win: Mounted['win']) => {
      const real = win.setInterval.bind(win);
      (win as unknown as { setInterval: (f: () => void, ms: number) => number }).setInterval = (f, ms) => (ms === 60000 ? (ticks.push(f), ticks.length) : real(f, ms));
    };
    let answer = { status: 'ok', presence: { any_available: false } };
    const urls: string[] = [];
    const fetch = async (url: string) => { urls.push(url); return { ok: true, status: 200, json: async () => answer, headers: { get: () => null } }; };
    const m = mountCallWidget({ bootstrap: { presence: { any_available: false } }, setup, fetch });
    expect(m.ctrl.state).toBe('offline');
    expect(ticks).toHaveLength(1);
    ticks[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(urls.filter((u) => u.includes('/api/call-widget/bootstrap?workspaceId='))).toHaveLength(1);
    expect(m.ctrl.state).toBe('offline');
    answer = { status: 'ok', presence: { any_available: true } };
    ticks[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.ctrl.state).toBe('online_available');
    m.open();
    expect(m.screenId()).toBe('home');
    // The dashboard's preview never asks.
    ticks.length = 0;
    mountCallWidget({ bootstrap: { presence: { any_available: false } }, setup });
    expect(ticks).toHaveLength(0);
  });

  it('pre-call with the form switched off: only the consent, no contact or schema field', () => {
    const m = opened({ locale: 'en', legacy: false }, {
      config: { pre_call_form_enabled: false, pre_call_form_schema: [{ id: 'account_id', type: 'text', label: 'Account ID', required: true }] },
      recording: { effective_enabled: true, consent_required: true },
    });
    m.click('[data-action="voice"]');
    expect(m.screenId()).toBe('precall');
    expect(m.qa('[data-screen="precall"] input:not([type="checkbox"]):not([tabindex="-1"])')).toHaveLength(0);
    expect(m.q('[data-screen="precall"]')!.textContent).not.toContain('Account ID');
    expect(m.q('[data-screen="precall"]')!.textContent).toContain('being recorded');
  });

  it('pre-call: an identified visitor sees the saved contact; Edit shows the fields', () => {
    const m = opened({ locale: 'en', legacy: false }, { config: { pre_call_form_enabled: true }, visitor: { contact: { id: 'k1', name: 'Ali Rezaei', email: 'ali@example.com' } }, recording: { effective_enabled: true, consent_required: true } });
    m.click('[data-action="video"]');
    expect(m.screenId()).toBe('precall');
    expect(m.q('[data-screen="precall"] .known b')!.textContent).toBe('Ali Rezaei');
    expect(m.q('[data-screen="precall"] .grp')).toBeNull();
    expect(m.q('[data-screen="precall"] .permit')).not.toBeNull();
    m.click('[data-action="edit-contact"]');
    expect(m.q('[data-screen="precall"] .known')).toBeNull();
    expect((m.q('[data-screen="precall"] input[type="email"]') as HTMLInputElement).value).toBe('ali@example.com');
  });

  it('pre-call: a custom schema with its required marker and its field error (named by the label)', () => {
    const m = opened({ locale: 'en', legacy: false }, {
      config: { pre_call_form_enabled: true, pre_call_form_schema: [{ id: 'account_id', type: 'text', label: 'Account ID', required: true }, { id: 'notes', type: 'textarea', label: 'Notes' }] },
    });
    m.click('[data-action="voice"]');
    expect(m.screen()!.textContent).toContain('Account ID');
    expect(m.screen()!.textContent).not.toContain('Full name');
    expect(m.q('[data-screen="precall"] .fr label i')!.textContent).toBe('*');
    m.q('[data-screen="precall"] form')!.dispatchEvent(new m.win.Event('submit', { bubbles: true, cancelable: true }));
    expect(m.ctrl.error).toBe('Account ID: Required');
    const input = m.q('[data-screen="precall"] .fr input') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(m.q('[data-screen="precall"] [data-error]')!.id);
    expect(m.q('[data-screen="precall"] [data-error]')!.textContent).toBe('Account ID: Required');
  });

  it('the D34 name: no operator name → the role, a headset in place of an initial', () => {
    const m = opened({ locale: 'en', legacy: false });
    m.set({ state: 'ended', endedCallId: 'c1', endedDuration: 0, operatorName: null });
    expect(m.q('[data-screen="rating"] .sumc small')!.textContent).toBe('Operator');
    expect(m.q('[data-screen="rating"] .sumc .av svg')).not.toBeNull();
  });

  it('compact density is the root\'s', () => {
    const m = mountCallWidget({ bootstrap: { config: { widget_theme: { density: 'compact' } } } });
    expect(m.root.dataset.density).toBe('compact');
  });
});

describe('D38: an error on a screen that draws no field of its own', () => {
  it('home, offline and both callback steps show it in their one slot', () => {
    const m = opened({ locale: 'en', legacy: false });
    m.set({ error: 'A schema field failed' });
    expect(m.q('[data-screen="home"] [data-error]')!.hidden).toBe(false);
    m.set({ error: null });
    expect(m.q('[data-screen="home"] [data-error]')!.hidden).toBe(true);
    m.click('[data-action="callback"]');
    m.set({ error: 'Please wait 5s before sending another request.' });
    expect(m.q('[data-screen="callback"] [data-error]')!.textContent).toBe('Please wait 5s before sending another request.');
    m.set({ state: 'offline', error: 'Failed.' });
    expect(m.q('[data-screen="offline"] [data-error]')!.textContent).toBe('Failed.');
  });

  it('a refused time sends step 2 back to step 1 (E15)', () => {
    const m = opened({ locale: 'en', legacy: false });
    m.click('[data-action="callback"]');
    m.click('[data-action="continue"]');
    m.set({ error: m.ctrl.t('err_future_time') });
    expect(m.qa('[data-screen="callback"] .stp .bars .on')).toHaveLength(1);
    expect(m.q('[data-screen="callback"] [data-error]')!.textContent).toBe(m.ctrl.t('err_future_time'));
  });
});

describe('D26: closing an ended screen goes home after the close', () => {
  it('thanks, closed: home 420 ms later', async () => {
    const m = opened({ locale: 'en', legacy: false });
    m.set({ state: 'ended', endedCallId: 'c1', ratingSubmitted: true, ratingValue: 5 });
    m.click('[data-screen="thanks"] [data-action="minimize"]');
    expect(m.ctrl.state).toBe('ended');
    await new Promise((r) => m.win.setTimeout(r, 450));
    expect(m.ctrl.state).toBe('online_available');
  });
});

// ─── the call stage (04–12) ─────────────────────────────────────────────
const SARA = 'سارا محمدی';
const text = (el: Element | null) => (el ? el.textContent : null);
const shown = (el: Element | null) => !!el && !(el as HTMLElement).hidden && !el.closest('[hidden]');
function staged(locale: 'fa' | 'en' = 'fa', bootstrap: Record<string, unknown> = {}): Mounted {
  const m = mountCallWidget({ now: NOW, locale, bootstrap });
  m.open();
  return m;
}
/** A live call (the board's demo: Sara, 2:14, recording). */
function live(m: Mounted, extra: Record<string, unknown> = {}) {
  m.set({
    state: 'in_call', callId: 'c1', connectStatus: 'in_call', operatorName: SARA, callStartedAt: NOW - 134_000,
    micOn: true, camOn: false, call: { id: 'c1', call_type: 'audio', state: 'active', recording_state: 'recording' }, ...extra,
  });
}
const videoCall = { camOn: true, call: { id: 'c1', call_type: 'video', state: 'active', recording_state: 'recording' } };

describe('04 connecting', () => {
  it('the spinning orb, «connecting» with its dots, the channel and department, a skeleton card, sound and cancel', () => {
    const m = staged('fa', { departments: { voice: [{ id: 'd1', name: 'فروش' }, { id: 'd2', name: 'مالی' }] } });
    m.ctrl.formData.department_id = 'd1';
    m.set({ state: 'loading' });
    const s = m.screen()!;
    expect(m.screenId()).toBe('connecting');
    expect(s.classList.contains('stage')).toBe(true);
    expect(m.root.classList.contains('dark')).toBe(true);
    expect(s.querySelector('.sb .orb.spin .core svg')).not.toBeNull();
    expect(text(s.querySelector('h2.sh'))).toBe('در حال اتصال');
    expect(s.querySelectorAll('h2.sh .ldots i')).toHaveLength(3);
    expect(text(s.querySelector('.sp.ctxl'))).toBe('تماس صوتی · فروش');
    expect(s.querySelectorAll('.qc .gsk')).toHaveLength(2);
    expect(s.querySelector('.qc')!.getAttribute('aria-hidden')).toBe('true');
    expect(s.querySelector('.dock.q .gbtn[data-action="sound"]')).not.toBeNull();
    expect(text(s.querySelector('.dock.q .xbtn[data-action="cancel"]'))).toBe('لغو تماس');
  });

  it('no department chosen: the channel alone; a video call names video', () => {
    const m = staged('en');
    m.ctrl.formData.call_type = 'video';
    m.set({ state: 'loading' });
    expect(text(m.q('[data-screen="connecting"] .sp.ctxl'))).toBe('Video call');
  });

  it('D40: Cancel is live while the request is in flight (no call id yet): back home', () => {
    const m = staged('en');
    m.set({ state: 'loading' });
    m.click('[data-screen="connecting"] [data-action="cancel"]');
    expect(m.ctrl.state).toBe('online_available');
    expect(m.screenId()).toBe('home');
  });
});

describe('05 / 06 the queue', () => {
  const queue = (m: Mounted, position: number, ago: number, eta: number | null = 180) =>
    m.set({ state: 'queue_waiting', callId: 'c1', queuePosition: position, queueEta: eta, queueStartedAt: NOW - ago });

  it('third in line: the ringing pill, the orb, the title and copy by position, the waiting time, the line and the stats', () => {
    const m = staged('fa');
    const audio = m.fakeAudio({ active: true });
    queue(m, 3, 47_000);
    const s = m.screen()!;
    expect(m.screenId()).toBe('queue');
    expect(text(s.querySelector('.pill'))).toBe('در حال زنگ زدن به اپراتور');
    expect(shown(s.querySelector('.pill .eq'))).toBe(true);
    const orb = s.querySelector('.orb')!;
    expect([...orb.classList].sort()).toEqual(['lvq', 'orb', 'ringing', 'sm']);
    expect(orb.querySelectorAll('.rg')).toHaveLength(3);
    expect(text(s.querySelector('h2.sh'))).toBe('جای شما محفوظ است');
    expect(text(s.querySelector('.sp'))).toBe(m.ctrl.t('queue_copy_many'));
    expect(s.querySelector('.tmr')!.getAttribute('role')).toBe('timer');
    expect(text(s.querySelector('.tmr .tl'))).toBe('زمان انتظار');
    expect(text(s.querySelector('.tmr b'))).toBe('۰:۴۷');
    expect(shown(s.querySelector('.qc'))).toBe(true);
    expect(s.querySelector('.qc .ql2')!.getAttribute('aria-hidden')).toBe('true');
    expect(s.querySelectorAll('.qc .ql2 .pp')).toHaveLength(2);
    expect(text(s.querySelector('.qc .ql2 .me'))).toBe('شما');
    expect([...s.querySelectorAll('.qs > span')].filter(shown).map((x) => [text(x.querySelector('small')), text(x.querySelector('b'))]))
      .toEqual([['جایگاه در صف', '۳'], ['زمان تقریبی', 'حدود ۳ دقیقه']]);
    expect(shown(s.querySelector('.offer'))).toBe(false);
    expect(m.root.classList.contains('q1') || m.root.classList.contains('q2')).toBe(false);
    // The pill's level bars move only while the ringback plays.
    audio.active = false;
    m.ctrl.render();
    expect(shown(s.querySelector('.pill .eq'))).toBe(false);
  });

  it('second: q2; first: q1, the fast rings, «you are next», no line card; the ETA under a minute', () => {
    const m = staged('en');
    queue(m, 2, 60_000);
    expect(m.root.classList.contains('q2')).toBe(true);
    queue(m, 1, 95_000, 40);
    const s = m.screen()!;
    expect(m.root.classList.contains('q1')).toBe(true);
    expect(m.root.classList.contains('q2')).toBe(false);
    expect(s.querySelector('.orb')!.classList.contains('fast')).toBe(true);
    expect(text(s.querySelector('h2.sh'))).toBe('You are next');
    expect(text(s.querySelector('.sp'))).toBe('We are ringing the next available operator now.');
    expect(shown(s.querySelector('.qc'))).toBe(false);
    queue(m, 4, 95_000, 40);
    expect(text(s.querySelector('.qs > span:last-child b'))).toBe('Under 1 minute');
    expect(m.root.classList.contains('q1')).toBe(false);
  });

  it('the stats follow show_position / show_eta and hide what is unknown', () => {
    const m = staged('en', { queue_experience: { show_position: false } });
    queue(m, 3, 47_000, null);
    const stats = m.qa('[data-screen="queue"] .qs > span');
    expect(stats.map(shown)).toEqual([false, false]);
    expect(shown(m.q('[data-screen="queue"] .qs'))).toBe(false);
    queue(m, 3, 47_000, 300);
    expect(stats.map(shown)).toEqual([false, true]);
    expect(text(stats[1].querySelector('b'))).toBe('~5 minutes');
  });

  it('the callback offer after the threshold: Cancel, then the callback form once the cancel has answered (E5)', async () => {
    const m = staged('fa', { queue_experience: { offer_callback_after_seconds: 30 } });
    queue(m, 1, 20_000);
    expect(shown(m.q('[data-screen="queue"] .offer'))).toBe(false);
    queue(m, 1, 95_000);
    const offer = m.q('[data-screen="queue"] .offer')!;
    expect(shown(offer)).toBe(true);
    expect(text(offer.querySelector('p'))).toBe('از انتظار خسته شدید؟ می‌توانیم با شما تماس بگیریم.');
    let answer: () => void = () => undefined;
    const order: string[] = [];
    Object.assign(m.ctrl, {
      cancelCall: () => { order.push('cancel'); return new Promise<void>((r) => { answer = r; }); },
      openCallback: () => { order.push('callback'); },
    });
    m.click('[data-screen="queue"] .offer [data-action="offer-callback"]');
    await flush(m.win);
    expect(order).toEqual(['cancel']);
    answer();
    await flush(m.win);
    expect(order).toEqual(['cancel', 'callback']);
  });

  it('the offer takes the line card\'s room at any position (as 06 draws it), so the stage never grows over the dock', () => {
    const m = staged('en', { queue_experience: { offer_callback_after_seconds: 30 } });
    queue(m, 3, 20_000);
    const qc = m.q('[data-screen="queue"] .qc')!;
    const offer = m.q('[data-screen="queue"] .offer')!;
    expect([shown(qc), shown(offer)]).toEqual([true, false]);
    queue(m, 3, 95_000);
    expect([shown(qc), shown(offer)]).toEqual([false, true]);
    // The position is still said (and Se still shows it).
    expect((m.q('.ccw-live')!.textContent || '').replace(/\u200b/g, '')).toBe('#3 in line');
    // Whatever else is taller than the stage (the tap hint, a longer language) scrolls inside it;
    // the queue's stage may reach into the dock's 14px of air above its buttons, as board 05 draws.
    expect(m.q('[data-screen="queue"] .sb')!.classList.contains('q')).toBe(true);
    expect(m.q('[data-screen="queue"] .dock.q')).not.toBeNull();
    const css = widgetSource('presentation-default-panel.css');
    expect(css).toMatch(/\n\.sb \{[^}]* overflow: hidden auto; scrollbar-width: none;[^}]*\}/);
    expect(css).toContain('.sb > * { flex-shrink: 0; }');
    expect(css).toContain('.sb.q { margin-bottom: -14px; }');
    // The failures' buttons sit at the stage's bottom: their focus ring is not clipped.
    expect(css).toContain('.sb.dn { margin-bottom: -4px; padding-bottom: 4px; }');
  });

  it('the offer without a call to cancel (an engine whose cancel answers nothing) goes to the form at once', () => {
    const m = staged('en', { queue_experience: { offer_callback_after_seconds: 30 } });
    m.set({ state: 'queue_waiting', callId: null, queuePosition: 1, queueEta: 40, queueStartedAt: NOW - 95_000 });
    // The engine's own cancel answers a promise (E4; callWidgetFixes covers E5 with it): an older one answers nothing.
    Object.assign(m.ctrl, { cancelCall: () => undefined });
    m.click('[data-screen="queue"] [data-action="offer-callback"]');
    expect(m.ctrl.state).toBe('callback_form');
  });

  it('the sound toggle: muted ↔ playing through the facade; a refused autoplay starts from the click; the tap hint meanwhile', () => {
    const m = staged('en');
    const audio = m.fakeAudio({ active: true });
    queue(m, 3, 47_000);
    const sound = m.q<HTMLButtonElement>('[data-screen="queue"] .dock.q .gbtn')!;
    expect(sound.getAttribute('aria-label')).toBe('Mute sound');
    expect(sound.getAttribute('aria-pressed')).toBe('false');
    let bubbled = 0;
    m.root.addEventListener('click', () => { bubbled += 1; });
    sound.click();
    expect(audio.calls).toEqual(['setMuted:true']);
    expect(bubbled).toBe(0);
    expect(sound.getAttribute('aria-label')).toBe('Unmute sound');
    expect(sound.getAttribute('aria-pressed')).toBe('true');
    sound.click();
    expect(audio.calls).toEqual(['setMuted:true', 'setMuted:false']);
    expect(sound.getAttribute('aria-pressed')).toBe('false');
    // Autoplay refused: the hint shows, the toggle reads «off», a click starts the sound from the gesture.
    audio.gesture = true;
    m.ctrl.render();
    const hint = m.q('[data-screen="queue"] .hint')!;
    expect(shown(hint)).toBe(true);
    expect(text(hint)).toBe('Tap to enable sound');
    expect(sound.getAttribute('aria-label')).toBe('Unmute sound');
    sound.click();
    expect(audio.calls.slice(2)).toEqual(['setMuted:false', 'startFromGesture']);
    expect(audio.cfg).toEqual(expect.objectContaining({ show_position: true }));
    expect(shown(hint)).toBe(false);
  });

  it('a tick writes the time in place: the same nodes, the same screen', () => {
    const m = staged('fa');
    queue(m, 3, 47_000);
    const scr = m.screen();
    const b = m.q('[data-screen="queue"] .tmr b')!;
    const tn = b.firstChild;
    m.setNow(NOW + 5000);
    m.ctrl.render();
    expect(m.screen()).toBe(scr);
    expect(m.q('[data-screen="queue"] .tmr b')).toBe(b);
    expect(b.firstChild).toBe(tn);
    expect(text(b)).toBe('۰:۵۲');
  });
});

describe('no node is added or removed by a tick (§2.5): text changes in place', () => {
  /** Child-list changes under the panel and the launcher during one tick five seconds on. */
  async function tickMutations(m: Mounted): Promise<string[]> {
    const seen: string[] = [];
    const mo = new m.win.MutationObserver((ms) => ms.forEach((r) => {
      if (r.type === 'childList' && (r.addedNodes.length || r.removedNodes.length)) seen.push((r.target as Element).className || r.target.nodeName);
    }));
    mo.observe(m.q('#ccw-panel')!, { childList: true, subtree: true });
    mo.observe(m.q('.ccw-launcher-wrap')!, { childList: true, subtree: true });
    m.setNow(NOW + 5000);
    m.ctrl.render();
    await flush(m.win);
    mo.disconnect();
    return seen;
  }

  it.each([
    ['queue', (m: Mounted) => m.set({ state: 'queue_waiting', callId: 'c1', queuePosition: 3, queueEta: 180, queueStartedAt: NOW - 47_000 })],
    ['voice', (m: Mounted) => live(m)],
    ['video', (m: Mounted) => { m.media({ video: true, self: true }); live(m, videoCall); }],
    ['transfer', (m: Mounted) => { live(m); m.set({ transferring: true, operatorName: null }); }],
    ['reconnect', (m: Mounted) => live(m, { connectStatus: 'media_reconnecting' })],
  ])('%s, open', async (id, drive) => {
    const m = staged('fa');
    drive(m);
    expect(m.screenId()).toBe(id);
    expect(await tickMutations(m)).toEqual([]);
  });

  it.each([
    ['Se', (m: Mounted) => m.set({ state: 'queue_waiting', callId: 'c1', queuePosition: 3, queueEta: 180, queueStartedAt: NOW - 47_000 })],
    ['Sf', (m: Mounted) => live(m)],
    ['Sg', (m: Mounted) => { m.media({ video: true, self: true }); live(m, videoCall); }],
  ])('%s, minimised', async (_id, drive) => {
    const m = staged('fa');
    drive(m);
    m.click('.scr.on [data-action="minimize"]');
    expect(m.ctrl.open).toBe(false);
    expect(await tickMutations(m)).toEqual([]);
  });
});

describe('07 joining and the connecting family', () => {
  it('waiting for the operator: the pill, the operator\'s face breathing, name and role, «joining» with dots, the recording note, the dock', () => {
    const m = staged('fa', { recording: { effective_enabled: true, consent_required: false } });
    live(m, { connectStatus: 'waiting_for_operator', callStartedAt: null, call: { id: 'c1', call_type: 'audio', recording_state: null } });
    const s = m.screen()!;
    expect(m.screenId()).toBe('joining');
    expect(s.querySelector('.pill .gd')).not.toBeNull();
    expect(text(s.querySelector('.pill'))).toBe('متصل، در انتظار اپراتور');
    expect(s.querySelector('.orb')!.classList.contains('op')).toBe(true);
    expect(s.querySelector('.orb')!.classList.contains('breathe')).toBe(true);
    expect(text(s.querySelector('.orb .core'))).toBe('س');
    expect(text(s.querySelector('.who-c .nm'))).toBe(SARA);
    expect(text(s.querySelector('.who-c .rl'))).toBe('اپراتور');
    const ctm = s.querySelector('.who-c .ctm.mut')!;
    expect(text(ctm)).toBe('اپراتور در حال ورود است');
    expect(ctm.querySelectorAll('.ldots i')).toHaveLength(3);
    expect(shown(s.querySelector('.rnote'))).toBe(true);
    expect(text(s.querySelector('.rnote'))).toBe(m.ctrl.t('recording_may_start'));
    expect(m.qa('[data-screen="joining"] .dock .cbn').map((b) => b.getAttribute('data-action'))).toEqual(['mute', 'end', 'minimize']);
  });

  it.each([
    [null, 'call_accepted_connecting'], ['pending', 'call_accepted_connecting'], ['token_ready', 'call_accepted_connecting'],
    ['loading_media_client', 'loading_media_client'], ['connecting_media', 'connecting_av'],
  ])('%s: the spinning orb until a name is known, the status in the chip', (status, key) => {
    const m = staged('en');
    live(m, { connectStatus: status, operatorName: null, micOn: false, callStartedAt: null });
    const s = m.screen()!;
    expect(m.screenId()).toBe('joining');
    expect(s.querySelector('.orb')!.classList.contains('spin')).toBe(true);
    expect(s.querySelector('.orb .core svg')).not.toBeNull();
    expect(text(s.querySelector('.ctm.mut'))).toBe(m.ctrl.t(key).replace(/…$/, ''));
    // Nothing is muted before the microphone was ever asked for.
    expect(s.querySelector('[data-action="mute"]')!.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('08 voice', () => {
  it('the recording pill, the halo, the time with the connection quality; a tick keeps the nodes', () => {
    const m = staged('fa');
    live(m, { connectionQuality: 'good' });
    const s = m.screen()!;
    expect(m.screenId()).toBe('voice');
    expect(s.querySelector('.pill.rec .rd')).not.toBeNull();
    expect(text(s.querySelector('.pill'))).toBe('ضبط در حال انجام است');
    expect(s.querySelector('.orb.op.halo')).not.toBeNull();
    expect(s.querySelectorAll('.orb .halo')).toHaveLength(2);
    expect(text(s.querySelector('.who-c .nm'))).toBe(SARA);
    const ctm = s.querySelector('.who-c .ctm')!;
    expect(ctm.getAttribute('role')).toBe('timer');
    expect(text(ctm)).toBe('۲:۱۴');
    const net = ctm.querySelector('.net')!;
    expect(shown(net)).toBe(true);
    expect(net.getAttribute('title')).toBe('کیفیت اتصال خوب است');
    m.setNow(NOW + 3000);
    m.ctrl.render();
    expect(m.q('[data-screen="voice"] .who-c .ctm')).toBe(ctm);
    expect(text(ctm)).toBe('۲:۱۷');
    m.set({ connectionQuality: null });
    expect(shown(net)).toBe(false);
  });

  it('not recording (recording on): the in-call pill and the note', () => {
    const m = staged('en', { recording: { effective_enabled: true, consent_required: false } });
    live(m, { call: { id: 'c1', call_type: 'audio', recording_state: null } });
    const s = m.screen()!;
    expect(s.querySelector('.pill.rec')).toBeNull();
    expect(text(s.querySelector('.pill'))).toBe('In call');
    expect(shown(s.querySelector('.rnote'))).toBe(true);
  });

  it('the dock: mute follows micOn (label, aria-pressed, look), end and minimise call the engine', () => {
    const m = staged('fa');
    live(m);
    const calls: string[] = [];
    Object.assign(m.ctrl, { toggleMic: () => calls.push('mic'), cancelCall: () => { calls.push('end'); } });
    const mic = m.q<HTMLButtonElement>('[data-screen="voice"] .dock [data-action="mute"]')!;
    expect(text(mic)).toBe('بی‌صدا');
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    mic.click();
    m.set({ micOn: false });
    expect(text(mic)).toBe('صدا');
    expect(mic.getAttribute('aria-pressed')).toBe('true');
    expect(mic.classList.contains('on')).toBe(true);
    const end = m.q('[data-screen="voice"] .dock [data-action="end"]')!;
    expect(end.getAttribute('aria-label')).toBe('پایان تماس');
    expect(text(end)).toBe('پایان');
    (end as HTMLElement).click();
    expect(calls).toEqual(['mic', 'end']);
    m.click('[data-screen="voice"] .dock [data-action="minimize"]');
    expect(m.ctrl.open).toBe(false);
  });

  it('D7: the sound toggle beside the time only while the ringback plays (a resumed ring, a transfer hold)', () => {
    const m = staged('en');
    const audio = m.fakeAudio({ active: false });
    live(m);
    const sbt = m.q('[data-screen="voice"] .ctw .sbt')!;
    expect(shown(sbt)).toBe(false);
    audio.active = true;
    m.ctrl.render();
    expect(shown(sbt)).toBe(true);
    expect(sbt.getAttribute('aria-label')).toBe('Mute sound');
    (sbt as HTMLElement).click();
    expect(audio.calls).toEqual(['setMuted:true']);
  });

  it('the remote audio plays from the persistent sink, open or closed', () => {
    const m = staged('en');
    const { audio } = m.media();
    live(m);
    expect(audio.parentElement!.classList.contains('ccw-media')).toBe(true);
    expect(audio.getAttribute('data-track-sid')).toBe('TR_a');
  });
});

describe('09 video and D32', () => {
  it('the remote video fills the feed (the engine\'s element, not mirrored); the self-view is mirrored, shown while the camera is on', () => {
    const m = staged('fa');
    const { video, self } = m.media({ video: true, self: true });
    live(m, videoCall);
    const s = m.screen()!;
    expect(m.screenId()).toBe('video');
    expect(s.classList.contains('vid')).toBe(true);
    expect(s.querySelector('.feed video')).toBe(video);
    expect(video!.getAttribute('data-remote-video')).toBe('true');
    expect(video!.getAttribute('data-track-sid')).toBe('TR_v');
    expect(video!.hasAttribute('data-orientation-correction')).toBe(false);
    expect(video!.style.transform).toBe('');
    const pip = s.querySelector('.pip')!;
    expect(shown(pip)).toBe(true);
    expect(pip.querySelector('video')).toBe(self);
    expect(self!.getAttribute('data-local-video')).toBe('true');
    expect(self!.getAttribute('data-orientation-correction')).toBe('scaleX(-1)');
    expect(self!.style.transform).toBe('scaleX(-1)');
    expect(self!.getAttribute('data-track-sid')).toBe('TR_self');
    expect(text(pip.querySelector('.me-l'))).toBe('شما');
    expect([...s.querySelector('.vtop')!.childNodes].map((n) => n.textContent).filter(Boolean)).toEqual(['ضبط', SARA, '۲:۱۴']);
    expect(m.qa('[data-screen="video"] .vdock .bt').map((b) => [b.getAttribute('data-action'), b.getAttribute('aria-label')])).toEqual([
      ['mute', 'بی‌صدا'], ['cam', 'خاموش کردن دوربین'], ['end', 'پایان تماس'], ['minimize', 'کوچک کردن'],
    ]);
    // A tick: nothing moves.
    m.setNow(NOW + 1000);
    m.ctrl.render();
    expect(s.querySelector('.feed video')).toBe(video);
    expect(text(s.querySelector('.vtop .num'))).toBe('۲:۱۵');
    // Camera off: no self-view; the toggle says so.
    m.set({ camOn: false });
    expect(shown(pip)).toBe(false);
    const cam = m.q('[data-screen="video"] [data-action="cam"]')!;
    expect(cam.getAttribute('aria-label')).toBe('روشن کردن دوربین');
    expect(cam.getAttribute('aria-pressed')).toBe('true');
    // Not recording: no «rec» in the top bar.
    m.set({ call: { id: 'c1', call_type: 'video', recording_state: null } });
    expect([...s.querySelector('.vtop')!.childNodes].filter((n) => shown(n as Element) && n.textContent).map((n) => n.textContent)).toEqual([SARA, '۲:۱۵']);
  });

  it('D32: a video call with no picture yet: the voice layout, the self-view, four buttons; the picture then takes the panel', () => {
    const m = staged('en');
    const { self } = m.media({ self: true });
    live(m, videoCall);
    const s = m.screen()!;
    expect(m.screenId()).toBe('video');
    expect(s.classList.contains('vid')).toBe(false);
    expect(s.querySelector('.orb.op.halo')).not.toBeNull();
    expect(s.querySelector('.pip video')).toBe(self);
    expect(m.qa('[data-screen="video"] .dock .cbn').map((b) => b.getAttribute('data-action'))).toEqual(['mute', 'cam', 'end', 'minimize']);
    const video = m.win.document.createElement('video');
    (m.ctrl._attachedTracks as Record<string, unknown>).TR_v = video;
    m.ctrl.render();
    const v = m.screen()!;
    expect(v.classList.contains('vid')).toBe(true);
    expect(v.querySelector('.feed video')).toBe(video);
    expect(v.querySelector('.pip video')).toBe(self);
  });
});

describe('10 transfer · 11 reconnect · 12 microphone · the failures', () => {
  it('10: the previous operator (remembered when the transfer began), the arrows, the hold copy, the time running on', () => {
    const m = staged('fa');
    live(m, { callStartedAt: NOW - 185_000 });
    m.set({ transferring: true, operatorName: null });
    const s = m.screen()!;
    expect(m.screenId()).toBe('transfer');
    expect(text(s.querySelector('.pill'))).toBe('در تماس');
    expect(text(s.querySelector('.xf .av'))).toBe('س');
    expect(s.querySelector('.xf')!.getAttribute('aria-hidden')).toBe('true');
    expect([...s.querySelectorAll('.xf .ar svg')].every((x) => x.classList.contains('dirf'))).toBe(true);
    expect(s.querySelectorAll('.xf .ar svg')).toHaveLength(3);
    expect(s.querySelector('.xf .to svg')).not.toBeNull();
    expect(text(s.querySelector('h2.sh'))).toBe('در حال انتقال به اپراتور دیگر…');
    expect(text(s.querySelector('.sp'))).toBe('لطفاً پشت خط بمانید.');
    expect(text(s.querySelector('.ctm'))).toBe('۳:۰۵');
    m.set({ transferring: false, operatorName: 'رضا احمدی' });
    expect(m.screenId()).toBe('voice');
    expect(text(m.q('[data-screen="voice"] .orb .core'))).toBe('ر');
  });

  it('11: the reconnecting banner, the dimmed face, the time running in the muted chip', () => {
    const m = staged('fa');
    live(m, { connectStatus: 'media_reconnecting', callStartedAt: NOW - 168_000 });
    const s = m.screen()!;
    expect(m.screenId()).toBe('reconnect');
    expect(s.querySelector('.bnr .spn')).not.toBeNull();
    expect(text(s.querySelector('.bnr'))).toBe('در حال اتصال مجدد رسانه…');
    expect(s.querySelector('.orb.op.dim .dash')).not.toBeNull();
    expect(text(s.querySelector('.who-c .ctm.mut'))).toBe('۲:۴۸');
    expect(s.querySelector('.who-c .ctm.mut svg')).not.toBeNull();
    expect(s.querySelector('.dock')).not.toBeNull();
  });

  it('12: the microphone blocked: the page\'s host in an LTR bar, the steps, End; Try again only when the engine can retry', () => {
    const m = staged('fa');
    live(m, { connectStatus: 'microphone_permission_denied', micOn: false, error: 'x' });
    const s = m.screen()!;
    expect(m.screenId()).toBe('mic');
    expect(s.querySelector('.sb.dn .ei svg')).not.toBeNull();
    expect(text(s.querySelector('h2.sh'))).toBe('دسترسی میکروفون رد شد');
    expect(text(s.querySelector('.sp'))).toBe('لطفاً اجازه دسترسی بدهید و دوباره تلاش کنید.');
    expect(s.querySelector('.addr')!.getAttribute('aria-hidden')).toBe('true');
    expect(text(s.querySelector('.addr .bar'))).toBe('customer.example');
    expect(s.querySelector('.addr .bar')!.getAttribute('dir')).toBe('ltr');
    expect(text(s.querySelector('.addr .pop'))).toBe('میکروفون');
    expect(text(s.querySelector('.how'))).toBe(m.ctrl.t('mic_denied_how'));
    expect(s.querySelector('.dock')).toBeNull();
    // The engine can retry since E13; an older one cannot.
    expect(m.qa('[data-screen="mic"] .row2 .btn').filter(shown).map((b) => b.getAttribute('data-action'))).toEqual(['end', 'retry-mic']);
    m.set({ retryMicrophone: undefined });
    expect(m.qa('[data-screen="mic"] .row2 .btn').filter(shown).map((b) => b.getAttribute('data-action'))).toEqual(['end']);
    let retried = 0;
    m.set({ retryMicrophone: () => { retried += 1; } });
    const retry = m.qa('[data-screen="mic"] .row2 .btn').filter(shown);
    expect(retry.map((b) => b.getAttribute('data-action'))).toEqual(['end', 'retry-mic']);
    expect(text(retry[1])).toBe('تلاش دوباره');
    (retry[1] as HTMLElement).click();
    expect(retried).toBe(1);
  });

  const FAIL_TITLES: Array<[string, string]> = [
    ['operator_left', 'operator_left'], ['media_disconnected', 'media_disconnected'], ['token_expired', 'token_expired'],
    ['rtc_v1_unsupported', 'rtc_unsupported'], ['media_client_missing', 'media_client_missing'], ['media_client_invalid', 'media_client_invalid'],
    ['provider_client_not_configured', 'provider_not_configured'], ['provider_client_not_supported', 'provider_not_supported'],
    ['media_not_configured', 'media_not_configured'],
  ];
  it.each(FAIL_TITLES)('fail %s: the 12 layout titled by the status, End and Request callback', async (status, key) => {
    const m = staged('en');
    live(m, { connectStatus: status, error: status === 'rtc_v1_unsupported' ? m.ctrl.t('err_media_rtc_v1') : null });
    const s = m.screen()!;
    expect(m.screenId()).toBe('fail');
    expect(s.querySelector('.sb.dn .ei svg')).not.toBeNull();
    expect(text(s.querySelector('h2.sh'))).toBe(m.ctrl.t(key));
    expect(shown(s.querySelector('.sp'))).toBe(status === 'rtc_v1_unsupported');
    if (status === 'rtc_v1_unsupported') expect(text(s.querySelector('.sp'))).toBe(m.ctrl.t('err_media_rtc_v1'));
    const order: string[] = [];
    Object.assign(m.ctrl, { cancelCall: () => { order.push('cancel'); return Promise.resolve(); }, openCallback: () => { order.push('callback'); } });
    expect(m.qa('[data-screen="fail"] .row2 .btn').map((b) => b.getAttribute('data-action'))).toEqual(['end', 'callback']);
    m.click('[data-screen="fail"] .row2 [data-action="callback"]');
    await flush(m.win);
    expect(order).toEqual(['cancel', 'callback']);
  });

  it('room_connect_failed: the room failure as the title, the engine\'s error below; no callback capability, no callback button', () => {
    const m = staged('en', { capabilities: { callback: false } });
    live(m, { connectStatus: 'room_connect_failed', error: 'Please try again.' });
    const s = m.screen()!;
    expect(text(s.querySelector('h2.sh'))).toBe('Failed to connect to the call room');
    expect(text(s.querySelector('.sp'))).toBe('Please try again.');
    expect(m.qa('[data-screen="fail"] .row2 .btn').map((b) => b.getAttribute('data-action'))).toEqual(['end']);
  });
});

describe('D23 · D34 on the stage', () => {
  it('D23: camera refused: the banner on the voice layout, under the top bar on video, until the camera is on', () => {
    const m = staged('en');
    live(m, { connectStatus: 'camera_permission_denied', camOn: false, call: { id: 'c1', call_type: 'video', recording_state: null } });
    expect(m.screenId()).toBe('video');
    const bnr = m.q('[data-screen="video"] .sb > .bnr')!;
    expect(shown(bnr)).toBe(true);
    expect(text(bnr)).toBe(m.ctrl.t('camera_denied'));
    expect(m.q('[data-screen="video"] .sb')!.firstElementChild).toBe(bnr);
    m.media({ video: true });
    m.set({ connectStatus: 'in_call', cameraDenied: true });
    const glass = m.q('[data-screen="video"].vid .bnr.gl')!;
    expect(shown(glass)).toBe(true);
    m.set({ cameraDenied: false, camOn: true });
    expect(shown(glass)).toBe(false);
    const v = mountCallWidget({ now: NOW, locale: 'en' });
    v.open();
    live(v, { cameraDenied: true });
    expect(shown(v.q('[data-screen="voice"] .bnr'))).toBe(true);
  });

  it('D34: no operator name: a headset in the face, no name line, the role in the top bar', () => {
    const m = staged('en');
    live(m, { operatorName: null });
    const s = m.screen()!;
    expect(s.querySelector('.orb .core svg')).not.toBeNull();
    expect(shown(s.querySelector('.who-c .nm'))).toBe(false);
    expect(text(s.querySelector('.who-c .rl'))).toBe('Operator');
    m.media({ video: true });
    m.set({ ...videoCall });
    expect(text(m.q('[data-screen="video"] .vtop'))).toContain('Operator');
    m.set({ ...videoCall, transferring: true });
    expect(m.q('[data-screen="transfer"] .xf .av svg')).not.toBeNull();
  });
});

describe('the stage spreads, folds and hands over', () => {
  it('dark on stage screens; incall during a call; toRate when the call ends on the rating; q classes only in the queue', () => {
    const m = staged('en');
    m.set({ state: 'queue_waiting', callId: 'c1', queuePosition: 2, queueStartedAt: NOW - 1000 });
    expect(m.root.classList.contains('dark')).toBe(true);
    expect(m.root.classList.contains('incall')).toBe(false);
    expect(m.q('[data-screen="queue"] .orb.lvq')).not.toBeNull();
    live(m);
    expect(m.root.classList.contains('incall')).toBe(true);
    expect(m.root.classList.contains('q2')).toBe(false);
    m.set({ state: 'ended', endedCallId: 'c1', endedDuration: 134 });
    expect(m.screenId()).toBe('rating');
    expect(m.root.classList.contains('dark')).toBe(false);
    expect(m.root.classList.contains('incall')).toBe(false);
    expect(m.root.classList.contains('toRate')).toBe(true);
    m.ctrl.reset();
    expect(m.root.classList.contains('toRate')).toBe(false);
    // The rating's fold point wins over the origin a pressed button left inline.
    const css = widgetSource('presentation-default-panel.css');
    expect(css).toMatch(/\.toRate \.lv \.dk \{ --cx: 50% !important; --cy: 88% !important; \}/);
  });
});

// ─── digits and dates in every state (§2.9) ─────────────────────────────
describe('digits and dates: no Latin digit printed or announced in fa, in any state', () => {
  /** What a reader sees or hears: text and names, without the LTR islands (codes, hosts, typed values). */
  const latin = (node: Element) => {
    const clone = node.cloneNode(true) as Element;
    for (const x of clone.querySelectorAll('.code, [dir="ltr"], input, textarea, select, option, .ccw-powered')) x.remove();
    const names = [clone, ...clone.querySelectorAll('*')].map((e) => [e.getAttribute('aria-label'), e.getAttribute('title')].join(' '));
    return `${clone.textContent} ${names.join(' ')}`.match(/[0-9]+/g) || [];
  };
  const T = 'fa';
  const fail = (m: Mounted) => m.ctrl.t('err_wait_seconds', { n: 12 });
  const STATES: Array<[string, (m: Mounted) => void]> = [
    ['home', () => undefined],
    ['precall', (m) => m.set({ state: 'pre_call_form', formData: { call_type: 'audio' }, error: fail(m) })],
    ['connecting', (m) => m.set({ state: 'loading' })],
    ['queue', (m) => m.set({ state: 'queue_waiting', callId: 'c1', queuePosition: 3, queueEta: 180, queueStartedAt: NOW - 47_000 })],
    ['queue', (m) => m.set({ state: 'queue_waiting', callId: 'c1', queuePosition: 1, queueEta: 30, queueStartedAt: NOW - 3_700_000 })],
    ['joining', (m) => live(m, { connectStatus: 'waiting_for_operator' })],
    ['voice', (m) => live(m, { connectionQuality: 'good', callStartedAt: NOW - 3_754_000 })],
    ['video', (m) => { m.media({ video: true, self: true }); live(m, videoCall); }],
    ['transfer', (m) => live(m, { transferring: true })],
    ['reconnect', (m) => live(m, { connectStatus: 'media_reconnecting' })],
    ['mic', (m) => live(m, { connectStatus: 'microphone_permission_denied' })],
    ['fail', (m) => live(m, { connectStatus: 'room_connect_failed', error: fail(m) })],
    ['rating', (m) => m.set({ state: 'ended', endedCallId: 'c1', endedDuration: 254, operatorName: SARA })],
    ['thanks', (m) => m.set({ state: 'ended', endedCallId: 'c1', endedDuration: 254, ratingValue: 4, ratingSubmitted: true })],
    ['error', (m) => m.set({ state: 'error', error: fail(m) })],
    ['callback', (m) => m.set({ state: 'callback_form', error: fail(m) })],
    ['scheduled', (m) => m.set({ state: 'ended', callbackId: 'a1b2c3d4-0000', formData: { callback_when: 'later', callback_scheduled_for: '2026-10-23T16:30:00+03:30', callback_channel: 'video', callback_urgency: 'urgent' } })],
  ];
  it.each(STATES)('%s', (id, drive) => {
    const m = mountCallWidget({ now: NOW, locale: T, bootstrap: { queue_experience: { offer_callback_after_seconds: 60 }, callback_policy: { slots: [{ at: '2026-10-23T16:30:00+03:30', available: true }, { at: '2026-10-24T10:00:00+03:30', available: false }] } } });
    m.open();
    drive(m);
    expect(m.screenId()).toBe(id);
    if (id === 'callback') {
      m.click('[data-action="seg"][data-field="callback_when"][data-value="later"]');
      expect(latin(m.screen()!)).toEqual([]);
      m.click('[data-action="continue"]');
    }
    expect(latin(m.screen()!)).toEqual([]);
    // Closed: the launcher, or the bar the call goes on in (Se, Sf, Sg).
    if (m.ctrl.open) m.ctrl.toggleOpen();
    expect(latin(m.q('.ccw-launcher-wrap')!)).toEqual([]);
  });

  it('the booked callback on the button (Sh): the day and time in Persian digits and the Jalali calendar\'s words', () => {
    const m = mountCallWidget({ now: NOW, locale: T, bootstrap: { capabilities: { voice: true, video: true, callback: true } } });
    m.set({ callbackBooking: { callbackId: 'cb1', scheduled_for: '2026-10-23T16:30:00+03:30', channel: 'audio', urgency: 'normal' } });
    const sched = m.q('.ccw-launcher-wrap .sched')!;
    expect(latin(sched)).toEqual([]);
    expect(sched.querySelector('small')!.textContent).toBe('فردا ۱۶:۳۰');
    m.setNow(NOW + 3 * 86_400_000);
    m.set({ callbackBooking: { callbackId: 'cb1', scheduled_for: '2026-10-27T09:05:00+03:30', channel: 'audio', urgency: 'normal' } });
    // Sunday 25th: the 27th is a weekday away (Tuesday), in the Persian calendar's own words.
    expect(m.q('.ccw-launcher-wrap .sched small')!.textContent).toBe('سه\u200cشنبه ۹:۰۵');
  });
});

// ─── motion (DW §9, §13; cc.css timings) ─────────────────────────────────
describe('motion: entrances once per show, the stars, reduced motion', () => {
  it('the stars a pick adds fill one after another, 80 ms apart, with the pick\'s bounce; the ones already on stay as they are', () => {
    const m = mountCallWidget({ now: NOW, locale: 'en' });
    m.open();
    m.set({ state: 'ended', endedCallId: 'c1', endedDuration: 134 });
    const stars = m.qa('[data-screen="rating"] .star');
    const nw = () => stars.map((s) => s.classList.contains('nw'));
    const d = (from: number, to: number) => stars.slice(from, to).map((s) => s.style.getPropertyValue('--d'));
    expect(nw()).toEqual([false, false, false, false, false]);
    stars[2].click();
    expect(nw()).toEqual([true, true, true, false, false]);
    expect(d(0, 3)).toEqual(['0', '1', '2']);
    stars[4].click();
    // Only the two it adds, from 0 again; the first three keep theirs (no replay).
    expect(nw()).toEqual([true, true, true, true, true]);
    expect(d(3, 5)).toEqual(['0', '1']);
    expect(d(0, 3)).toEqual(['0', '1', '2']);
    stars[1].click();
    expect(stars.map((s) => s.classList.contains('on'))).toEqual([true, true, false, false, false]);
    expect(nw()).toEqual([true, true, false, false, false]);
    // From the keyboard too (a radio group picks with the arrows).
    stars[1].focus();
    stars[1].dispatchEvent(new m.win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(m.ctrl.ratingValue).toBe(3);
    expect(nw()).toEqual([true, true, true, false, false]);
    expect(d(2, 3)).toEqual(['0']);
  });

  it('a screen shown for the first time fades in as the cached ones do (its hidden style is resolved before `.on`, so the transition runs)', () => {
    const seen: string[] = [];
    const m = mountCallWidget({
      now: NOW, locale: 'en',
      setup: (w) => {
        const real = w.getComputedStyle.bind(w);
        (w as unknown as { getComputedStyle: unknown }).getComputedStyle = (el: Element, p?: string | null) => {
          if (el.classList && el.classList.contains('scr')) seen.push(`${el.getAttribute('data-screen')}:${el.classList.contains('on') ? 'on' : 'off'}`);
          return real(el, p);
        };
      },
    });
    m.open();
    m.set({ state: 'pre_call_form', formData: { call_type: 'audio' } });
    expect(m.screenId()).toBe('precall');
    expect(seen).toContain('precall:off');
    // A screen already drawn has its style: nothing to resolve.
    seen.length = 0;
    m.set({ state: 'online_available' });
    expect(seen).toEqual([]);
  });

  it('a rating drawn with a value already chosen plays the entry cascade (cc-star), not the pick', () => {
    const m = mountCallWidget({ now: NOW, locale: 'en' });
    m.open();
    m.set({ state: 'ended', endedCallId: 'c1', endedDuration: 134, ratingValue: 4 });
    const stars = m.qa('[data-screen="rating"] .star');
    expect(stars.map((s) => s.classList.contains('on'))).toEqual([true, true, true, true, false]);
    expect(stars.some((s) => s.classList.contains('nw'))).toBe(false);
    expect(stars.map((s) => s.style.getPropertyValue('--i'))).toEqual(['0', '1', '2', '3', '4']);
  });

  it('the cascade and the other entrances play when the panel shows the screen (each open and each screen change), never while it is closed or on a tick', () => {
    // The module draws home as soon as it comes (the intent before the click): keyed on `.scr.on` alone the cascade
    // played, unseen, behind the closed panel and never when the visitor opened it.
    const m = mountCallWidget({ now: NOW, locale: 'en' });
    m.q('.ccw-launcher-wrap')!.dispatchEvent(new m.win.Event('pointerenter'));
    expect(m.q('[data-screen="home"]')!.classList.contains('on')).toBe(true);
    expect(m.root.classList.contains('ccw-is-open')).toBe(false);
    const css = widgetSource('presentation-default-panel.css');
    expect(panelRule('.ccw-is-open .scr.on .cz')).toBe(' animation: cc-rise .6s var(--ease) calc(.15s + var(--i, 0) * 70ms) backwards; ');
    expect(panelRule('.ccw-is-open .scr.on .stars .star.on')).toBe(' animation: cc-star .55s var(--bounce) calc(.35s + var(--i, 0) * 80ms) backwards; ');
    expect(panelRule('.ccw-is-open .scr.on .stars .star.on.nw')).toBe(' animation: none; ');
    // cc.css's cc-starpick on each star at its turn; until then it keeps the empty star's look (cc-starfill, backwards).
    expect(panelRule('.ccw-is-open .scr.on .stars .star.on.nw svg')).toBe(' animation: cc-starfill .2s ease calc(var(--d, 0) * 80ms) backwards, cc-starpick .45s var(--bounce) calc(var(--d, 0) * 80ms); ');
    expect(css).toContain('@keyframes cc-starpick { 0% { transform: scale(.6); } 60% { transform: scale(1.25); } 100% { transform: none; } }');
    expect(css).toContain('@keyframes cc-starfill { from { color: var(--line-2); fill-opacity: 0; } }');
    expect(panelRule('.ccw-is-open .scr.on .okc .in')).toBe(' animation: cc-pop .6s var(--bounce) .15s backwards; ');
    expect(panelRule('.ccw-is-open .scr.on .okc .in path')).toBe(' animation: cc-draw .5s var(--ease) .5s backwards; ');
    expect(panelRule('.ccw-is-open .scr.on .okc .bdg')).toBe(' animation: cc-pop .5s var(--bounce) .7s backwards; ');
    expect(panelRule('.ccw-is-open .scr.on .offer')).toBe(' animation: cc-rise .6s var(--spring) .5s backwards; ');
    expect(panelRule('.ccw-is-open .scr.on .pip')).toBe(' animation: cc-pip .6s var(--spring) .5s backwards; ');
    // No one-shot entrance left on a rule that also matches a closed panel.
    for (const line of css.split('\n')) {
      if (/animation: cc-(rise|star|pop|draw|pip)\b/.test(line)) expect(line, line).toMatch(/^\.ccw-is-open \.scr\.on /);
    }
  });

  it('reduced motion: opacity only; the launcher, the panel (a phone\'s sheet too), a screen, the stage and the scrim fade where they stand, hidden once faded, shown at once', () => {
    const block = (file: string) => {
      const css = widgetSource(file);
      return css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    };
    const rt = block('runtime.css');
    expect(rt).toContain('.ccw-root *, .ccw-root *::before, .ccw-root *::after { animation: none !important; transition: opacity .15s ease !important; }');
    expect(rt).toContain('.ccw-root .ccw-launcher-wrap { transform: none !important; transition: opacity .15s ease, visibility 0s !important; }');
    expect(rt).toContain('.ccw-root.ccw-is-open .ccw-launcher-wrap { opacity: 0; transition: opacity .15s ease, visibility 0s linear .15s !important; }');
    expect(rt).toContain('.ccw-root .ln-h .lbl { transform: none !important; transition: opacity .15s ease, visibility 0s linear .15s !important; }');
    expect(rt).toContain('.ccw-root .ln-h:hover .lbl, .ccw-root .ln-h .ln-c:focus-visible + .lbl { transition: opacity .15s ease, visibility 0s !important; }');
    const pn = block('presentation-default-panel.css');
    expect(pn).toContain('.ccw-root .ccw-panel { transform: none !important; }');
    expect(pn).toContain('.ccw-root .ccw-panel, .ccw-root .lv .scr, .ccw-root .lv .dk, .ccw-root .scrim { transition: opacity .15s ease, visibility 0s linear .15s !important; }');
    expect(pn).toContain('.ccw-root.ccw-is-open .ccw-panel, .ccw-root .lv .scr.on, .ccw-root.dark .lv .dk, .ccw-root.ccw-is-open .scrim { transition: opacity .15s ease, visibility 0s !important; }');
    // The stage appears by opacity, never by its circle.
    expect(pn).toContain('.lv .dk, .dark .lv .dk { clip-path: none; }');
  });
});

// ─── minimised (Se, Sf, Sg) and D35 ─────────────────────────────────────
describe('the minimised call', () => {
  const wrap = (m: Mounted) => m.q('.ccw-launcher-wrap')!;

  it('Se: the queue in the launcher: place, waiting time, restore and cancel; while connecting: no time', () => {
    const m = staged('fa');
    m.set({ state: 'queue_waiting', callId: 'c1', queuePosition: 3, queueEta: 180, queueStartedAt: NOW - 47_000 });
    m.click('[data-screen="queue"] [data-action="minimize"]');
    const se = wrap(m).querySelector('.mc')!;
    expect(wrap(m).children).toHaveLength(1);
    expect(se.classList.contains('stage-bg')).toBe(true);
    expect(se.querySelector('.mo svg')).not.toBeNull();
    expect(text(se.querySelector('.tx b'))).toBe('نفر ۳ صف');
    expect(text(se.querySelector('.tx small'))).toBe('زمان انتظار ۰:۴۷');
    m.set({ queuePosition: 1, queueStartedAt: NOW - 95_000 });
    expect(wrap(m).querySelector('.mc')).toBe(se);
    expect(text(se.querySelector('.tx b'))).toBe('نفر بعدی');
    expect(text(se.querySelector('.tx small'))).toBe('زمان انتظار ۱:۳۵');
    let cancelled = 0;
    Object.assign(m.ctrl, { cancelCall: () => { cancelled += 1; } });
    (se.querySelector('[data-action="cancel"]') as HTMLElement).click();
    expect(cancelled).toBe(1);
    expect(se.querySelector('[data-action="cancel"]')!.getAttribute('aria-label')).toBe('لغو تماس');
    (se.querySelector('[data-action="restore"]') as HTMLElement).click();
    expect(m.ctrl.open).toBe(true);
    expect(m.screenId()).toBe('queue');
    // Connecting (D10): no call id, no position yet.
    m.click('[data-screen="queue"] [data-action="minimize"]');
    m.set({ state: 'loading', callId: null, queuePosition: null });
    const se2 = wrap(m).querySelector('.mc')!;
    expect(text(se2.querySelector('.tx b'))).toBe('در حال اتصال');
    expect(shown(se2.querySelector('.tx small'))).toBe(false);
  });

  it('Sf: a voice call in the launcher: initial, first name, time, mute and end; its level bars are the engine\'s, every render', () => {
    const m = staged('fa');
    live(m);
    m.click('[data-screen="voice"] .dock [data-action="minimize"]');
    const sf = wrap(m).querySelector('.mc')!;
    expect(text(sf.querySelector('.av'))).toBe('س');
    expect(text(sf.querySelector('.tx b'))).toBe('سارا');
    expect(text(sf.querySelector('.tx small'))).toBe('۲:۱۴');
    const bars = [...sf.querySelectorAll('.wvs i')];
    expect(bars).toHaveLength(5);
    const same = () => { const w = m.ctrl._waveBars as Element[] | null; return !!w && w.length === 5 && w.every((b, i) => b === bars[i]); };
    expect(same()).toBe(true);
    // The engine drops them when it re-subscribes a track; the next render hands them back.
    m.ctrl._waveBars = null;
    m.ctrl.render();
    expect(same()).toBe(true);
    // The bars keep their CSS motion until the meter is really live (E20).
    expect(sf.querySelector('.wvs')!.classList.contains('live')).toBe(false);
    m.set({ audioMeterLive: true });
    expect(sf.querySelector('.wvs')!.classList.contains('live')).toBe(true);
    const calls: string[] = [];
    Object.assign(m.ctrl, { toggleMic: () => calls.push('mic'), cancelCall: () => { calls.push('end'); } });
    const mic = sf.querySelector('[data-action="mute"]')!;
    expect(mic.getAttribute('aria-label')).toBe('بی‌صدا');
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    (mic as HTMLElement).click();
    m.set({ micOn: false });
    expect(mic.getAttribute('aria-label')).toBe('صدا');
    expect(mic.getAttribute('aria-pressed')).toBe('true');
    (sf.querySelector('[data-action="end"]') as HTMLElement).click();
    expect(calls).toEqual(['mic', 'end']);
    // The bar's body restores the panel; the bars go back to nobody.
    (sf.querySelector('[data-action="restore"]') as HTMLElement).click();
    expect(m.ctrl.open).toBe(true);
    expect(m.ctrl._waveBars).toBeNull();
  });

  it('Sf without a name: the role and a headset', () => {
    const m = staged('en');
    live(m, { operatorName: null });
    m.click('[data-screen="voice"] .dock [data-action="minimize"]');
    const sf = wrap(m).querySelector('.mc')!;
    expect(text(sf.querySelector('.tx b'))).toBe('Operator');
    expect(sf.querySelector('.av svg')).not.toBeNull();
  });

  it('Sg: the same remote video moves into the window and back, never cloned; restore and the bar\'s controls', () => {
    const m = staged('en');
    const { video } = m.media({ video: true, self: true });
    live(m, videoCall);
    expect(m.q('[data-screen="video"] .feed video')).toBe(video);
    m.click('[data-screen="video"] .vdock [data-action="minimize"]');
    const sg = wrap(m).querySelector('.mvid')!;
    expect(sg.getAttribute('aria-label')).toBe('Video call, minimized');
    expect(sg.querySelector('.feed video')).toBe(video);
    expect(m.qa('video').filter((v) => v === video)).toHaveLength(1);
    expect(text(sg.querySelector('.bar3 .t'))).toBe('2:14');
    expect(sg.querySelector('.exp')!.tagName).toBe('BUTTON');
    expect([...sg.querySelectorAll('button')].map((b) => b.getAttribute('data-action'))).toEqual(['restore', 'mute', 'end']);
    (sg.querySelector('[data-action="restore"]') as HTMLElement).click();
    expect(m.ctrl.open).toBe(true);
    expect(m.q('[data-screen="video"] .feed video')).toBe(video);
    expect(video!.isConnected).toBe(true);
  });

  it('a voice video call (no picture) minimises to Sf; the picture arriving turns it into Sg', () => {
    const m = staged('en');
    live(m, videoCall);
    m.click('[data-screen="video"] .dock [data-action="minimize"]');
    expect(wrap(m).querySelector('.mc')).not.toBeNull();
    m.media({ video: true });
    m.ctrl.render();
    expect(wrap(m).querySelector('.mvid')).not.toBeNull();
    expect(wrap(m).querySelector('.mc')).toBeNull();
  });

  it('a bar replaced by another keeps the focus it held: Se → Sf when the operator answers, Sf → Sg when the picture comes', async () => {
    const m = staged('en');
    m.set({ state: 'queue_waiting', callId: 'c1', queuePosition: 2, queueStartedAt: NOW - 47_000 });
    m.click('[data-screen="queue"] [data-action="minimize"]');
    m.q<HTMLButtonElement>('.ccw-launcher-wrap [data-action="restore"]')!.focus();
    live(m, { operatorName: 'Sara' });
    await flush(m.win);
    const sf = wrap(m).querySelector('.mc')!;
    expect(sf.querySelector('.wvs')).not.toBeNull();
    expect(m.shadow.activeElement).toBe(sf.querySelector('[data-action="restore"]'));
    sf.querySelector<HTMLButtonElement>('[data-action="mute"]')!.focus();
    m.media({ video: true });
    m.set({ call: { id: 'c1', call_type: 'video', state: 'active' } });
    await flush(m.win);
    const sg = wrap(m).querySelector('.mvid')!;
    expect(m.shadow.activeElement).toBe(sg.querySelector('[data-action="mute"]'));
    expect(m.ctrl.open).toBe(false);
  });

  it('a cancel from the bar gives the focus to the launcher that comes back', async () => {
    const m = staged('en');
    m.set({ state: 'queue_waiting', callId: null, queuePosition: 2, queueStartedAt: NOW - 47_000 });
    m.click('[data-screen="queue"] [data-action="minimize"]');
    const cancel = m.q<HTMLButtonElement>('.ccw-launcher-wrap [data-action="cancel"]')!;
    cancel.focus();
    cancel.click();
    await flush(m.win);
    expect(m.ctrl.state).toBe('online_available');
    expect(m.ctrl.open).toBe(false);
    expect(m.shadow.activeElement).toBe(m.q('.ccw-launcher-wrap .ccw-launcher-btn'));
  });

  it('restoring from the bar moves focus into the panel (the bar\'s button is gone)', () => {
    const m = staged('en');
    m.set({ state: 'queue_waiting', callId: 'c1', queuePosition: 3, queueStartedAt: NOW - 47_000 });
    m.click('[data-screen="queue"] [data-action="minimize"]');
    const restore = m.q<HTMLButtonElement>('.ccw-launcher-wrap [data-action="restore"]')!;
    restore.focus();
    restore.click();
    expect(m.ctrl.open).toBe(true);
    const a = m.shadow.activeElement;
    expect(a).not.toBeNull();
    expect(m.q('#ccw-panel')!.contains(a)).toBe(true);
  });
});

describe('D35: an outcome while minimised', () => {
  const minimised = (m: Mounted) => { m.click('.scr.on [data-action="minimize"]'); expect(m.ctrl.open).toBe(false); };

  it('a failure opens the panel once, without moving focus, and is announced; closing it again keeps it closed', async () => {
    const m = staged('fa');
    live(m);
    minimised(m);
    // The visitor went back to the page (the bar does not hold the focus).
    (m.shadow.activeElement as HTMLElement | null)?.blur();
    m.set({ connectStatus: 'operator_left' });
    await flush(m.win);
    expect(m.ctrl.open).toBe(true);
    expect(m.screenId()).toBe('fail');
    expect(m.shadow.activeElement).toBeNull();
    expect(text(m.q('.ccw-live'))!.replace(/\u200b/g, '')).toBe('اپراتور تماس را ترک کرد.');
    minimised(m);
    m.ctrl.render();
    await flush(m.win);
    expect(m.ctrl.open).toBe(false);
  });

  it('the call ending (the visitor\'s own end from the bar too) opens the panel on the rating', async () => {
    const m = staged('en');
    live(m);
    minimised(m);
    m.set({ state: 'ended', endedCallId: 'c1', endedDuration: 134, callId: null });
    await flush(m.win);
    expect(m.ctrl.open).toBe(true);
    expect(m.screenId()).toBe('rating');
    expect(text(m.q('.ccw-live'))!.replace(/\u200b/g, '')).toBe('Call ended.');
  });

  it('the microphone refused opens it; a transfer and a reconnect keep the bar', async () => {
    const m = staged('en');
    live(m);
    minimised(m);
    m.set({ transferring: true, operatorName: null });
    await flush(m.win);
    expect(m.ctrl.open).toBe(false);
    m.set({ transferring: false, operatorName: SARA, connectStatus: 'media_reconnecting' });
    await flush(m.win);
    expect(m.ctrl.open).toBe(false);
    expect(m.q('.ccw-launcher-wrap .mc')).not.toBeNull();
    m.set({ connectStatus: 'microphone_permission_denied' });
    await flush(m.win);
    expect(m.ctrl.open).toBe(true);
    expect(m.screenId()).toBe('mic');
  });

  it('a bar that held the focus hands it to the outcome\'s screen (the bar goes; focus never drops to the page)', async () => {
    const m = staged('en');
    live(m);
    minimised(m);
    m.q<HTMLButtonElement>('.ccw-launcher-wrap [data-action="mute"]')!.focus();
    m.set({ connectStatus: 'operator_left' });
    await flush(m.win);
    expect(m.ctrl.open).toBe(true);
    expect(m.screenId()).toBe('fail');
    const a = m.shadow.activeElement;
    expect(a).not.toBeNull();
    expect(m.screen()!.contains(a)).toBe(true);
    // The visitor's own end from the bar: the rating takes the focus.
    const m2 = staged('en');
    live(m2);
    minimised(m2);
    const end = m2.q<HTMLButtonElement>('.ccw-launcher-wrap [data-action="end"]')!;
    end.focus();
    Object.assign(m2.ctrl, { cancelCall: () => m2.set({ state: 'ended', endedCallId: 'c1', endedDuration: 134, callId: null }) });
    end.click();
    await flush(m2.win);
    expect(m2.screenId()).toBe('rating');
    expect(m2.screen()!.contains(m2.shadow.activeElement)).toBe(true);
  });

  it('an outcome seen with the panel open never re-opens it after the visitor closes it', async () => {
    const m = staged('en');
    live(m, { connectStatus: 'operator_left' });
    expect(m.screenId()).toBe('fail');
    minimised(m);
    m.ctrl.render();
    await flush(m.win);
    expect(m.ctrl.open).toBe(false);
  });
});

describe('phones (D14, §2.11, board 11): the light screens in a bottom sheet, the call full screen', () => {
  const phone = (locale: 'fa' | 'en' = 'fa', bootstrap: Record<string, unknown> = {}) => {
    const m = mountCallWidget({ now: NOW, locale, device: 'phone', bootstrap });
    m.open();
    return m;
  };
  const queued = { state: 'queue_waiting', callId: 'c1', queuePosition: 3, queueStartedAt: NOW - 47_000, queueEta: 180 };

  it('home rises as a sheet over a scrim, its grabber above the header; the queue and the call take the whole screen, the queue with the full orb', () => {
    const m = phone();
    const panel = m.q('#ccw-panel')!;
    expect(m.root.classList.contains('is-mobile')).toBe(true);
    expect(m.screenId()).toBe('home');
    expect(panel.classList.contains('sheet')).toBe(true);
    const scrim = m.q<HTMLElement>('.scrim')!;
    expect(scrim.hidden).toBe(false);
    expect(scrim.getAttribute('aria-hidden')).toBe('true');
    const grab = m.screen()!.firstElementChild!;
    expect(grab.matches('i.grab[aria-hidden="true"]')).toBe(true);
    expect(grab.nextElementSibling!.matches('header.hd')).toBe(true);
    m.set(queued);
    expect(m.screenId()).toBe('queue');
    expect(panel.classList.contains('sheet')).toBe(false);
    expect(m.root.classList.contains('dark')).toBe(true);
    expect(m.screen()!.querySelector('.grab')).toBeNull();
    const orb = m.screen()!.querySelector('.orb')!;
    expect(orb.classList.contains('ringing')).toBe(true);
    expect(orb.classList.contains('sm')).toBe(false);
    m.set({ state: 'ended', endedCallId: 'c1', endedDuration: 134, callId: null });
    expect(m.screenId()).toBe('rating');
    expect(panel.classList.contains('sheet')).toBe(true);
    expect(m.screen()!.firstElementChild!.classList.contains('grab')).toBe(true);
  });

  it('a desktop has none of it: the floating panel, no scrim, no grabber, the queue\'s smaller orb', () => {
    const m = mountCallWidget({ now: NOW, locale: 'fa' });
    m.open();
    expect(m.root.classList.contains('is-mobile')).toBe(false);
    expect(m.q('#ccw-panel')!.classList.contains('sheet')).toBe(false);
    expect(m.q<HTMLElement>('.scrim')!.hidden).toBe(true);
    expect(m.q('.grab')).toBeNull();
    m.set(queued);
    expect(m.screen()!.querySelector('.orb')!.classList.contains('sm')).toBe(true);
  });

  it('a tap on the scrim collapses the sheet; the scrim fades out with the sheet\'s 260 ms fold instead of vanishing', () => {
    const m = phone('en');
    m.click('.scrim');
    expect(m.ctrl.open).toBe(false);
    expect(m.root.classList.contains('ccw-is-open')).toBe(false);
    // Still in the page: the stylesheet fades it over the fold, then hides it (and its taps) once faded.
    expect(m.q<HTMLElement>('.scrim')!.hidden).toBe(false);
    expect(panelRule('.scrim')).toMatch(/opacity: 0; visibility: hidden; transition: opacity \.26s ease, visibility 0s linear \.26s;/);
    // It comes in as drawn (cc-fade .4s ease .2s), as a transition now, so that it can go the other way.
    expect(panelRule('.ccw-is-open .scrim')).toMatch(/^ opacity: 1; visibility: visible; transition: opacity \.4s ease \.2s, visibility 0s; $/);
    expect(panelRule('.scrim')).not.toMatch(/animation/);
  });

  it('the page behind stays put while the sheet or the call is open (scroll lock), and comes back where it was', () => {
    const m = mountCallWidget({ now: NOW, locale: 'en', device: 'phone' });
    const { body } = m.win.document;
    body.style.overflow = 'auto';
    Object.defineProperty(m.win, 'scrollY', { configurable: true, value: 300 });
    const scrolled: Array<[number, number]> = [];
    (m.win as unknown as { scrollTo: unknown }).scrollTo = (x: number, y: number) => { scrolled.push([x, y]); };
    const look = () => [body.style.position, body.style.top, body.style.width, body.style.overflow];
    m.open();
    expect(look()).toEqual(['fixed', '-300px', '100%', 'hidden']);
    m.set(queued);
    expect(look()).toEqual(['fixed', '-300px', '100%', 'hidden']);
    m.click('.scr.on [data-action="minimize"]');
    expect(look()).toEqual(['', '', '', 'auto']);
    expect(scrolled).toEqual([[0, 300]]);
  });

  it('a page another widget already holds (the chat\'s phone panel) is left to it: closing the call never puts that lock back', () => {
    const m = mountCallWidget({ now: NOW, locale: 'en', device: 'phone' });
    const { body } = m.win.document;
    const scrolled: Array<[number, number]> = [];
    (m.win as unknown as { scrollTo: unknown }).scrollTo = (x: number, y: number) => { scrolled.push([x, y]); };
    const look = () => [body.style.position, body.style.top, body.style.width, body.style.overflow];
    // The chat panel opened first: the page is fixed where the visitor had scrolled to.
    Object.assign(body.style, { position: 'fixed', top: '-300px', width: '100%', overflow: 'hidden' });
    m.open();
    expect(look()).toEqual(['fixed', '-300px', '100%', 'hidden']);
    // The chat closes first and lets the page go.
    Object.assign(body.style, { position: '', top: '', width: '', overflow: '' });
    m.click('.scr.on [data-action="minimize"]');
    expect(look()).toEqual(['', '', '', '']);
    expect(scrolled).toEqual([]);
    // The next open on a free page takes its own lock again.
    m.open();
    expect(body.style.position).toBe('fixed');
  });

  it('a panel hidden while open (offline, hide) lets the page go too', () => {
    const m = mountCallWidget({ now: NOW, locale: 'en', device: 'phone', bootstrap: { config: { offline_behavior: 'hide' } } });
    m.open();
    expect(m.win.document.body.style.position).toBe('fixed');
    m.set({ state: 'offline' });
    expect((m.q('#ccw-panel') as HTMLElement).hidden).toBe(true);
    expect(m.win.document.body.style.position).toBe('');
    expect(m.q<HTMLElement>('.scrim')!.hidden).toBe(true);
  });

  it('a desktop never locks the page', () => {
    const m = mountCallWidget({ now: NOW, locale: 'en' });
    m.open();
    expect(m.win.document.body.style.position).toBe('');
    expect(m.win.document.body.style.overflow).toBe('');
  });

  it('when the other widget lets the page go while the call panel stays open, the call holds it from its next render, and gives it back on close', () => {
    const m = mountCallWidget({ now: NOW, locale: 'en', device: 'phone' });
    const { body } = m.win.document;
    const scrolled: Array<[number, number]> = [];
    (m.win as unknown as { scrollTo: unknown }).scrollTo = (x: number, y: number) => { scrolled.push([x, y]); };
    const look = () => [body.style.position, body.style.top, body.style.width, body.style.overflow];
    Object.assign(body.style, { position: 'fixed', top: '-300px', width: '100%', overflow: 'hidden' });
    m.open();
    m.set(queued);
    // The chat closes and puts the page back where it was.
    Object.assign(body.style, { position: '', top: '', width: '', overflow: '' });
    Object.defineProperty(m.win, 'scrollY', { configurable: true, value: 300 });
    m.ctrl.render();
    expect(look()).toEqual(['fixed', '-300px', '100%', 'hidden']);
    m.click('.scr.on [data-action="minimize"]');
    expect(look()).toEqual(['', '', '', '']);
    expect(scrolled).toEqual([[0, 300]]);
  });

  it('the moment the other widget lets the page go while the call panel stays open, the call holds it (no render needed)', async () => {
    const m = mountCallWidget({ now: NOW, locale: 'en', device: 'phone' });
    const { body } = m.win.document;
    const scrolled: Array<[number, number]> = [];
    (m.win as unknown as { scrollTo: unknown }).scrollTo = (x: number, y: number) => { scrolled.push([x, y]); };
    const look = () => [body.style.position, body.style.top, body.style.width, body.style.overflow];
    Object.assign(body.style, { position: 'fixed', top: '-300px', width: '100%', overflow: 'hidden' });
    m.open();
    // The chat closes first and puts the page back where it was; nothing renders the call meanwhile (a sheet does not tick).
    Object.defineProperty(m.win, 'scrollY', { configurable: true, value: 300 });
    Object.assign(body.style, { position: '', top: '', width: '', overflow: '' });
    await Promise.resolve();
    expect(look()).toEqual(['fixed', '-300px', '100%', 'hidden']);
    m.ctrl.toggleOpen();
    expect(look()).toEqual(['', '', '', '']);
    expect(scrolled).toEqual([[0, 300]]);
    // Closed, the page is not watched any more: another widget's lock is left alone.
    Object.assign(body.style, { position: 'fixed', top: '-40px' });
    await Promise.resolve();
    Object.assign(body.style, { position: '', top: '' });
    await Promise.resolve();
    expect(look()).toEqual(['', '', '', '']);
  });

  it('an on-screen keyboard: the sheet follows the visual viewport, and the focused field stays in view; closed, it folds where it stood', async () => {
    const m = mountCallWidget({ now: NOW, locale: 'en', device: 'phone' });
    const idle = m.viewport.listeners('resize');
    m.open();
    expect(m.viewport.listeners('resize')).toBeGreaterThan(idle);
    expect(m.q<HTMLElement>('#ccw-panel')!.style.getPropertyValue('--ccw-vvh')).toBe('844px');
    m.click('[data-action="callback"]');
    m.click('[data-screen="callback"] [data-action="continue"]');
    const email = m.q<HTMLInputElement>('.scr.on input[type="email"]')!;
    email.focus();
    m.viewport.set({ height: 500 });
    expect(m.q<HTMLElement>('#ccw-panel')!.style.getPropertyValue('--ccw-vvh')).toBe('500px');
    expect(m.q<HTMLElement>('#ccw-panel')!.style.getPropertyValue('--ccw-vvb')).toBe('344px');
    expect(m.scrolledIntoView).toContain(email);
    m.viewport.set({ offsetTop: 120 });
    expect(m.q<HTMLElement>('#ccw-panel')!.style.getPropertyValue('--ccw-vvt')).toBe('120px');
    expect(m.q<HTMLElement>('#ccw-panel')!.style.getPropertyValue('--ccw-vvb')).toBe('224px');
    m.ctrl.toggleOpen();
    // The 260 ms fold starts where the sheet stood (above the keyboard; dropping the viewport at once made it jump to
    // the bottom of the screen and grow), following the keyboard as it goes down; only then the viewport is let go.
    const panel = m.q<HTMLElement>('#ccw-panel')!;
    expect(m.root.classList.contains('ccw-is-open')).toBe(false);
    expect([panel.style.getPropertyValue('--ccw-vvh'), panel.style.getPropertyValue('--ccw-vvb')]).toEqual(['500px', '224px']);
    m.viewport.set({ height: 844, offsetTop: 0 });
    expect([panel.style.getPropertyValue('--ccw-vvh'), panel.style.getPropertyValue('--ccw-vvb')]).toEqual(['844px', '0px']);
    await new Promise((r) => setTimeout(r, 350));
    expect(m.viewport.listeners('resize')).toBe(idle);
    expect(m.viewport.listeners('scroll')).toBe(0);
    expect(panel.style.getPropertyValue('--ccw-vvh')).toBe('');
    expect(panel.style.getPropertyValue('--ccw-vvb')).toBe('');
  });

  it('a panel opened again during the fold keeps following the viewport (one listener each, not two)', async () => {
    const m = mountCallWidget({ now: NOW, locale: 'en', device: 'phone' });
    const idle = m.viewport.listeners('resize');
    m.open();
    const open = m.viewport.listeners('resize');
    m.ctrl.toggleOpen();
    m.ctrl.toggleOpen();
    await new Promise((r) => setTimeout(r, 350));
    expect(m.viewport.listeners('resize')).toBe(open);
    expect(m.q<HTMLElement>('#ccw-panel')!.style.getPropertyValue('--ccw-vvh')).toBe('844px');
    m.ctrl.toggleOpen();
    await new Promise((r) => setTimeout(r, 350));
    expect(m.viewport.listeners('resize')).toBe(idle);
  });

  it('a rotation (#343): turned to landscape a phone is still a phone; on a wide screen the open sheet becomes the desktop panel, and back again', () => {
    const m = phone('en');
    const panel = m.q('#ccw-panel')!;
    const body = m.win.document.body;
    m.device('landscape');
    expect(m.root.classList.contains('is-mobile')).toBe(true);
    expect(panel.classList.contains('sheet')).toBe(true);
    expect(body.style.position).toBe('fixed');
    expect(m.q<HTMLElement>('#ccw-panel')!.style.getPropertyValue('--ccw-vvh')).toBe('390px');
    m.device('desktop');
    expect(m.root.classList.contains('is-mobile')).toBe(false);
    expect(panel.classList.contains('sheet')).toBe(false);
    expect(panel.hasAttribute('aria-modal')).toBe(false);
    expect(m.q<HTMLElement>('.scrim')!.hidden).toBe(true);
    expect(body.style.position).toBe('');
    expect(m.q('.scr.on .grab')).toBeNull();
    m.device('phone');
    expect(m.root.classList.contains('is-mobile')).toBe(true);
    expect(panel.classList.contains('sheet')).toBe(true);
    expect(body.style.position).toBe('fixed');
    expect(m.q('.scr.on > .grab')).not.toBeNull();
  });

  it('without a visual viewport (an older browser) the panel takes the window\'s height, again after a rotation', () => {
    const m = mountCallWidget({ now: NOW, locale: 'en', device: 'phone', setup: (w) => { delete (w as unknown as { visualViewport?: unknown }).visualViewport; } });
    m.open();
    expect(m.q<HTMLElement>('#ccw-panel')!.style.getPropertyValue('--ccw-vvh')).toBe('844px');
    expect(m.q<HTMLElement>('#ccw-panel')!.style.getPropertyValue('--ccw-vvb')).toBe('0px');
    m.device('landscape');
    expect(m.q<HTMLElement>('#ccw-panel')!.style.getPropertyValue('--ccw-vvh')).toBe('390px');
  });

  it('a phone keeps the launcher in its corner: every corner placement comes down to it, and the panel takes no placement corner', () => {
    for (const position of ['top_right', 'top_left']) {
      const m = mountCallWidget({ now: NOW, locale: 'en', device: 'phone', bootstrap: { config: { widget_position: position } } });
      const side = position === 'top_right' ? 'right' : 'left';
      expect(m.q('.ccw-launcher-wrap')!.className).toBe(`ccw-launcher-wrap ${side}`);
      expect(m.q('#ccw-panel')!.classList.contains('top')).toBe(false);
    }
  });

  it('the sheet and the full screen as drawn: at most 654 high, header 68, the call\'s header below the notch, the dock and the footer above the home bar, the video\'s controls with the safe areas', () => {
    const css = widgetSource('presentation-default-panel.css');
    const rule = (sel: string) => {
      const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.()[\]]/g, '\\$&')} \\{([^}]*)\\}`));
      expect(m, sel).not.toBeNull();
      return m![1];
    };
    expect(rule('.is-mobile .ccw-panel.cp.lv')).toMatch(/height: min\(654px, var\(--ccw-vvh, 100dvh\)\);/);
    expect(rule('.is-mobile .ccw-panel.cp.lv')).toMatch(/border-radius: 30px 30px 0 0;/);
    expect(rule('.is-mobile.dark .ccw-panel.cp.lv')).toMatch(/height: var\(--ccw-vvh, 100dvh\);[^]*border-radius: 0;/);
    expect(rule('.scrim')).toMatch(/background: rgba\(6,10,12,\.46\);/);
    expect(rule('.grab')).toMatch(/width: 40px; height: 5px; margin: 8px auto 0; border-radius: 3px; background: var\(--line-2\);/);
    expect(rule('.is-mobile .ly .hd')).toMatch(/height: 68px;/);
    expect(rule('.is-mobile .dk .hd')).toMatch(/padding-block: calc\(env\(safe-area-inset-top\) \+ 16px\) 12px;/);
    expect(rule('.is-mobile .sb')).toMatch(/padding-inline: calc\(26px \+ var\(--sa-s\)\) calc\(26px \+ var\(--sa-e\)\);/);
    expect(rule('.is-mobile .dock')).toMatch(/padding-bottom: 28px;/);
    expect(rule('.is-mobile .pw')).toMatch(/margin-bottom: max\(env\(safe-area-inset-bottom\), 8px\);/);
    expect(rule('.is-mobile .vtop')).toMatch(/top: calc\(env\(safe-area-inset-top\) \+ 62px\);/);
    expect(rule('.is-mobile .pip')).toMatch(/bottom: calc\(128px \+ env\(safe-area-inset-bottom\)\);[^}]* width: 108px; height: 150px;/);
    expect(rule('.is-mobile .vdock')).toMatch(/bottom: calc\(52px \+ env\(safe-area-inset-bottom\)\);/);
  });

  it('turned to landscape (the notch at a side), the header, the stage, the docks, the forms and the self-view keep clear of the side safe areas, mirrored with the direction', () => {
    // The start and end insets follow the reading direction (env() names physical sides).
    expect(panelRule('.ccw-root.is-mobile')).toMatch(/^ --sa-s: env\(safe-area-inset-left, 0px\); --sa-e: env\(safe-area-inset-right, 0px\); $/);
    expect(panelRule('.ccw-root.is-mobile[dir="rtl"]')).toMatch(/^ --sa-s: env\(safe-area-inset-right, 0px\); --sa-e: env\(safe-area-inset-left, 0px\); $/);
    const pads: Array<[string, number, number]> = [['.is-mobile .hd', 18, 14], ['.is-mobile .bd', 18, 18], ['.is-mobile .ctx', 14, 14],
      ['.is-mobile .acts', 18, 18], ['.is-mobile .sb', 26, 26], ['.is-mobile .dock', 20, 20]];
    for (const [sel, s, e] of pads) {
      expect(panelRule(sel), sel).toContain(`padding-inline: calc(${s}px + var(--sa-s)) calc(${e}px + var(--sa-e));`);
    }
    expect(panelRule('.is-mobile .pip')).toContain('inset-inline-end: calc(16px + var(--sa-e));');
    expect(panelRule('.is-mobile .bnr.gl')).toContain('inset-inline: calc(22px + var(--sa-s)) calc(22px + var(--sa-e));');
    // Compact density's narrower body (a more specific rule) keeps the insets too; off a phone they are 0.
    expect(panelRule('.ccw-root[data-density="compact"] .bd')).toBe(' padding-inline: calc(10px + var(--sa-s, 0px)) calc(10px + var(--sa-e, 0px)); ');
    // An upright phone has no side insets: nothing moves on the boards' 390×844 frames.
    expect(widgetSource('presentation-default-panel.css')).not.toMatch(/safe-area-inset-(left|right)\)/);
  });
});

describe('the engine\'s round-3 fields, end to end (the real runtime, a fake server and media client)', () => {
  const T0 = Date.parse('2026-10-22T07:30:00Z');
  const SESSION_KEY = 'ccw_active_call_session:22222222-2222-4222-8222-222222222222:https://api.example';
  type Route = (req: ApiRequest) => ApiAnswer | Promise<ApiAnswer> | undefined;
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); });
  afterEach(() => { closeCallWidgets(); vi.useRealTimers(); });

  function engine(route: Route = () => undefined, opts: MountOptions = {}) {
    const api = fakeApi(route);
    const m = mountCallWidget({ locale: 'en', now: T0, liveKit: true, ...opts, fetch: api.fetch, mountExtra: { activeSessionKey: SESSION_KEY }, bootstrap: { queue_experience: { ringback_enabled: true }, ...opts.bootstrap } });
    return { m, api, c: m.ctrl as unknown as Engine };
  }
  /** A call restored on this page view, an operator ("Sara", agent reference A) in the room. */
  async function liveCall(over: Partial<CallServerState> = {}, opts: MountOptions = {}) {
    const s: CallServerState = { state: 'active', agent: 'A', name: 'Sara', startedAt: new Date(T0 - 134_000).toISOString(), ...over };
    const env = engine(callRoutes(s), {
      liveKit: { present: ['op-a'] }, ...opts,
      bootstrap: { active_call: { call_id: 'c1', state: 'active', session: 'S1', call_type: 'audio', created_at: new Date(T0 - 140_000).toISOString() } },
    });
    await settle();
    env.m.loadLinks();
    return { ...env, s, room: env.m.lk!.room() };
  }

  it('E12: the visitor\'s own connection quality on the voice screen\'s time chip (bars and words); another participant\'s is not the visitor\'s', async () => {
    const { m, room } = await liveCall();
    expect(m.screenId()).toBe('voice');
    const net = m.q<HTMLElement>('[data-screen="voice"] .net')!;
    expect(net.hidden).toBe(true);
    room.emit('connectionQualityChanged', 'poor', room.localParticipant);
    expect(net.hidden).toBe(false);
    expect(net.getAttribute('title')).toBe('Poor connection');
    expect([...net.querySelectorAll('path')].map((p) => p.getAttribute('opacity'))).toEqual([null, null, '.35', '.35']);
    room.emit('connectionQualityChanged', 'excellent', { identity: 'op-a', isLocal: false });
    expect(net.getAttribute('title')).toBe('Poor connection');
    room.emit('connectionQualityChanged', 'excellent', room.localParticipant);
    expect([...net.querySelectorAll('path')].map((p) => p.getAttribute('opacity'))).toEqual([null, null, null, null]);
    room.emit('connectionQualityChanged', 'unknown', room.localParticipant);
    expect(net.hidden).toBe(true);
  });

  it('E20: minimised, Sf\'s bars are the engine\'s meter only while its AudioContext runs (a suspended one would freeze them)', async () => {
    const { m, c } = await liveCall({}, { liveKit: { present: ['op-a'], audioState: 'suspended', resumeWorks: false } });
    if (m.ctrl.open) m.click('.scr.on [data-action="minimize"]');
    const wvs = m.q('.ccw-launcher-wrap .mc .wvs')!;
    expect(wvs.classList.contains('live')).toBe(false);
    expect((c as unknown as { _waveBars: unknown })._waveBars).toEqual([...wvs.children]);
    (c._audioCtx as FakeAudioContext).set('running');
    expect(m.q('.ccw-launcher-wrap .mc .wvs')!.classList.contains('live')).toBe(true);
    (c._audioCtx as FakeAudioContext).set('suspended');
    expect(m.q('.ccw-launcher-wrap .mc .wvs')!.classList.contains('live')).toBe(false);
  });

  it('E19: a transfer shows screen 10 with the operator who handed over, the call time running on; the next operator\'s call after the join', async () => {
    const { m, c, s, room } = await liveCall();
    Object.assign(s, { agent: 'B', name: 'Reza' });
    c.pollOnce();
    await settle();
    expect(m.screenId()).toBe('transfer');
    expect(m.q('[data-screen="transfer"] .xf .av')!.textContent).toBe('S');
    expect(m.q('[data-screen="transfer"] .ctm')!.textContent).toBe('2:14');
    room.leave('op-a');
    await settle();
    expect(m.screenId()).toBe('transfer');
    room.join('op-b');
    expect(m.screenId()).toBe('voice');
    expect(m.q('[data-screen="voice"] .who-c .nm')!.textContent).toBe('Reza');
    expect(m.q('[data-screen="voice"] .ctm')!.textContent).toBe('2:14');
  });

  it('E11 · D15: a slot booked stays on the button until its time (Sh); its press shows the booking (19); Done closes the panel, the booking stays', async () => {
    const slot = '2026-10-23T16:30:00+03:30';
    const { m, c, api } = engine((req) => (req.path === '/api/call-widget/callbacks/request'
      ? { body: { ok: true, callback_id: 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d', scheduled_for: slot, channel: 'video' } } : undefined), {
      bootstrap: { callback_policy: { slots: [{ at: '2026-10-23T12:30:00+03:30', available: true }, { at: slot, available: true }] } },
    });
    m.open();
    m.click('[data-screen="home"] [data-action="callback"]');
    m.click('[data-action="seg"][data-field="callback_channel"][data-value="video"]');
    m.click('[data-action="seg"][data-field="callback_when"][data-value="later"]');
    m.click(`[data-action="slot"][data-value="${slot}"]`);
    m.click('[data-screen="callback"] [data-action="continue"]');
    m.click('[data-screen="callback"] [data-action="submit"]');
    await settle();
    const sent = api.requests.find((r) => r.path === '/api/call-widget/callbacks/request')!;
    expect(sent.body!.scheduled_for).toBe(new Date(slot).toISOString());
    expect(m.screenId()).toBe('scheduled');
    expect(c.callbackBooking).toMatchObject({ callbackId: 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d', scheduled_for: slot, channel: 'video' });
    m.click('[data-screen="scheduled"] [data-action="done"]');
    expect(c.state).toBe('online_available');
    m.ctrl.toggleOpen();
    const sched = m.q<HTMLButtonElement>('.ccw-launcher-wrap .sched')!;
    expect(sched.querySelector('small')!.textContent).toMatch(/^Tomorrow 4:30\sPM$/);
    sched.click();
    m.loadLinks();
    expect(m.screenId()).toBe('scheduled');
    expect(m.q('[data-screen="scheduled"] .code')!.textContent).toBe('A1B2C3D4');
    m.click('[data-screen="scheduled"] [data-action="done"]');
    expect(m.ctrl.open).toBe(false);
    expect(c.callbackBooking).not.toBeNull();
    expect(m.q('.ccw-launcher-wrap .sched')).not.toBeNull();
  });

  it('E2: Skip on the rating sends nothing and goes home', async () => {
    const { m, c, api } = engine();
    m.open();
    expect(m.qa('[data-screen="home"] .opt')).toHaveLength(2);
    m.set({ state: 'ended', endedCallId: 'c1', endedDuration: 134 });
    expect(m.screenId()).toBe('rating');
    m.click('[data-screen="rating"] [data-action="rate-skip"]');
    await settle();
    expect(c.state).toBe('online_available');
    expect(api.log().filter((l) => /rate/.test(l))).toEqual([]);
  });
});
