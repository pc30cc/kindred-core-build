/**
 * Accessibility of the call widget (contract §2.14, brief §7): the launcher
 * names and controls the panel; the panel is a dialog, inert while closed;
 * every announcement goes through one polite region OUTSIDE the panel (an
 * inert subtree is hidden from assistive technology); single-choice groups
 * are radio groups whose arrows follow the reading direction; switches,
 * fields and errors are wired; focus never drops when a screen changes.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closeCallWidgets, flush, mountCallWidget, widgetSource, type Mounted } from './mountCallWidget';

afterEach(() => closeCallWidgets());

const key = (m: Mounted, el: Element, k: string) => el.dispatchEvent(new m.win.KeyboardEvent('keydown', { key: k, bubbles: true }));

describe('launcher and panel', () => {
  it('the launcher names the widget, controls the panel and says whether it is open', async () => {
    const m = mountCallWidget({ locale: 'en' });
    const btn = m.q('.ccw-launcher-btn')!;
    expect(btn.getAttribute('aria-label')).toBe('Open the call widget');
    expect(btn.getAttribute('aria-controls')).toBe('ccw-panel');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(m.q('.lbl .x')!.getAttribute('aria-label')).toBe('Close');
    m.open();
    await flush();
    expect(m.q('.ccw-launcher-btn')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('the panel is a dialog named after the workspace, inert while closed, not modal on a desktop', async () => {
    const m = mountCallWidget({ locale: 'en' });
    const panel = m.q('#ccw-panel')!;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-label')).toBe('Nilufar');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.hasAttribute('aria-modal')).toBe(false);
    m.open();
    await flush();
    expect(panel.hasAttribute('inert')).toBe(false);
  });

  it('the header\'s chevron minimises (not "back"); the language picker has its name', () => {
    const m = mountCallWidget({ locale: 'en', bootstrap: { i18n: { default_locale: 'en', available_locales: ['en', 'fa'] } } });
    m.open();
    expect(m.q('[data-screen="home"] [data-action="minimize"]')!.getAttribute('aria-label')).toBe('Minimize');
    const lang = m.q<HTMLSelectElement>('[data-screen="home"] select[data-action="lang"]')!;
    expect(lang.getAttribute('aria-label')).toBe('Widget language');
    lang.value = 'fa';
    lang.dispatchEvent(new m.win.Event('change'));
    expect(m.root.getAttribute('dir')).toBe('rtl');
    expect(m.q('[data-screen="home"] [data-action="minimize"]')!.getAttribute('aria-label')).toBe('کوچک کردن');
  });

  it('a dismissed label stays dismissed for the page (no engine method yet: the presentation hides it)', () => {
    const m = mountCallWidget({ locale: 'en' });
    m.click('.lbl .x');
    // D6: a dismissed round_label behaves as round: at most the hover label, without its x, hidden from assistive technology.
    expect(m.q('.lbl .x')).toBeNull();
    for (const l of m.qa('.lbl')) expect(l.getAttribute('aria-hidden')).toBe('true');
    expect(m.q('.ccw-launcher-btn')).not.toBeNull();
    expect(m.ctrl.open).toBe(false);
  });

  it('closing the label from the keyboard leaves focus on the launcher, not the page', () => {
    const m = mountCallWidget({ locale: 'en' });
    const x = m.q<HTMLButtonElement>('.lbl .x')!;
    x.focus();
    x.click();
    expect(x.isConnected).toBe(false);
    expect(m.shadow.activeElement).toBe(m.q('.ccw-launcher-btn'));
  });
});

describe('the live region', () => {
  it('one polite region, outside the panel', () => {
    const m = mountCallWidget();
    const live = m.qa('[aria-live]');
    expect(live).toHaveLength(1);
    expect(live[0].classList.contains('ccw-live')).toBe(true);
    expect(live[0].getAttribute('aria-live')).toBe('polite');
    expect(m.q('#ccw-panel')!.contains(live[0])).toBe(false);
  });

  it('nothing in the panel is a status or a live region (timers must never be announced)', () => {
    const m = mountCallWidget();
    m.open();
    for (const st of ['home', 'pre_call_form', 'callback_form', 'error']) {
      m.set({ state: st });
      expect(m.q('#ccw-panel [role="status"], #ccw-panel [aria-live]')).toBeNull();
    }
  });

  it('a copied reference is announced there', async () => {
    const m = mountCallWidget({ locale: 'en' });
    Object.defineProperty(m.win.navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true });
    m.open();
    m.set({ state: 'ended', callbackId: 'a1b2c3d4-0000' });
    m.click('[data-action="copy-code"]');
    await flush();
    expect(m.q('.ccw-live')!.textContent).toBe('Copied');
  });
});

describe('radio groups', () => {
  it('stars: a radio group named Rating; arrows pick, mirrored in Persian', () => {
    const m = mountCallWidget({ locale: 'fa' });
    m.open();
    m.set({ state: 'ended', endedCallId: 'c1' });
    const group = m.q('[data-screen="rating"] .stars')!;
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(group.getAttribute('aria-label')).toBe('امتیاز');
    const stars = m.qa('[data-screen="rating"] .star');
    expect(stars.every((s) => s.getAttribute('role') === 'radio')).toBe(true);
    expect(stars.map((s) => s.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    stars[2].click();
    expect(m.ctrl.ratingValue).toBe(3);
    expect(stars.map((s) => s.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false', 'false']);
    expect(stars.map((s) => s.classList.contains('on'))).toEqual([true, true, true, false, false]);
    expect((m.q('[data-action="rate-submit"]') as HTMLButtonElement).disabled).toBe(false);
    key(m, stars[2], 'ArrowLeft'); // RTL: left is the next star
    expect(m.ctrl.ratingValue).toBe(4);
    key(m, stars[3], 'ArrowRight');
    expect(m.ctrl.ratingValue).toBe(3);
  });

  it('in English, right is next', () => {
    const m = mountCallWidget({ locale: 'en' });
    m.open();
    m.set({ state: 'ended', endedCallId: 'c1', ratingValue: 2 });
    const stars = m.qa('[data-screen="rating"] .star');
    expect(stars[1].tabIndex).toBe(0);
    key(m, stars[1], 'ArrowRight');
    expect(m.ctrl.ratingValue).toBe(3);
    expect(m.shadow.activeElement).toBe(stars[2]);
  });

  it('segments, departments, days and slots are radio groups; disabled slots are skipped', () => {
    const at = (d: number, hm: string) => `2026-10-${d}T${hm}:00+03:30`;
    const m = mountCallWidget({
      locale: 'en', now: Date.parse('2026-10-22T11:00:00+03:30'),
      bootstrap: {
        departments: { callback: [{ id: 'd1', name: 'Sales' }, { id: 'd2', name: 'Support' }] },
        callback_policy: { slots: [{ at: at(23, '10:00'), available: true }, { at: at(23, '12:00'), available: false }, { at: at(23, '14:00'), available: true }] },
      },
    });
    m.open();
    m.click('[data-action="callback"]');
    for (const g of m.qa('[data-screen="callback"] .seg')) expect(g.getAttribute('role')).toBe('radiogroup');
    m.click('[data-field="callback_when"][data-value="later"]');
    expect(m.ctrl.formData.callback_when).toBe('later');
    expect(m.q('[data-screen="callback"] .days')!.getAttribute('role')).toBe('radiogroup');
    const slots = m.qa<HTMLButtonElement>('[data-screen="callback"] .slots [role="radio"]');
    slots[0].click();
    key(m, slots[0], 'ArrowRight');
    expect(m.ctrl.formData.callback_scheduled_for).toBe(at(23, '14:00'));
    m.click('[data-action="continue"]');
    const depts = m.q('[data-screen="callback"] .chips')!;
    expect(depts.getAttribute('role')).toBe('radiogroup');
    m.click('[data-action="dept"][data-value="d2"]');
    expect(m.ctrl.formData.department_id).toBe('d2');
    expect(m.q('[data-action="dept"][data-value="d2"]')!.getAttribute('aria-checked')).toBe('true');
  });
});

describe('forms', () => {
  it('fields have labels, autocomplete, the consent a labelled switch, the honeypot off screen', () => {
    const m = mountCallWidget({ locale: 'en', bootstrap: { recording: { effective_enabled: true, consent_required: true }, callback_policy: { require_contact: true } } });
    m.open();
    m.click('[data-action="voice"]');
    for (const input of m.qa<HTMLInputElement>('[data-screen="precall"] .fr input')) {
      expect(m.q(`label[for="${input.id}"]`)).not.toBeNull();
    }
    expect(m.qa('[data-screen="precall"] .fr input').map((i) => i.getAttribute('autocomplete'))).toEqual(['name', 'email', 'tel']);
    // Names, addresses and numbers are not words: no spelling marks under them (none are drawn).
    expect(m.qa('[data-screen="precall"] .fr input').map((i) => i.getAttribute('spellcheck'))).toEqual(['false', 'false', 'false']);
    const sw = m.q('[data-screen="precall"] [role="switch"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(m.q(`#${sw.getAttribute('aria-labelledby')}`)!.textContent).toContain('I consent');
    sw.click();
    expect(m.ctrl.formData.consent).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    m.click('[data-screen="precall"] [data-action="back"]');
    m.click('[data-action="callback"]');
    m.click('[data-action="continue"]');
    const hp = m.q<HTMLInputElement>('[data-screen="callback"] input[name="company_website"]')!;
    expect(hp.getAttribute('tabindex')).toBe('-1');
    expect(hp.getAttribute('aria-hidden')).toBe('true');
    expect(hp.getAttribute('autocomplete')).toBe('off');
    expect(hp.classList.contains('hp')).toBe(true);
    // Off screen on the start side: a physical `left` would open a 10,000px scroll range in a Persian (RTL) form body.
    const hpRule = /\n\.hp \{[^}]*\}/.exec(widgetSource('presentation-default-panel.css'))![0];
    expect(hpRule).toContain('inset-inline-start: -10000px');
    expect(hpRule).not.toMatch(/[\s;{](left|right|display):/);
    expect(m.qa('[data-screen="callback"] .fr label i').map((i) => i.textContent)).toEqual(['*', '*']);
  });

  it('every button that is not the form\'s submit is type=button', () => {
    const m = mountCallWidget({ locale: 'en' });
    m.open();
    m.click('[data-action="voice"]');
    m.set({ state: 'pre_call_form' });
    const buttons = m.qa<HTMLButtonElement>('[data-screen="precall"] button');
    expect(buttons.filter((b) => b.type === 'submit').map((b) => b.getAttribute('data-action'))).toEqual(['submit']);
  });

  it('focus moves to the next step\'s heading, never to the page', async () => {
    const m = mountCallWidget({ locale: 'en' });
    m.open();
    await flush();
    m.click('[data-action="callback"]');
    const cont = m.q<HTMLButtonElement>('[data-action="continue"]')!;
    cont.focus();
    cont.click();
    expect(m.shadow.activeElement).toBe(m.q('[data-screen="callback"] .ct'));
    m.q<HTMLButtonElement>('[data-screen="callback"] .acts [data-action="back"]')!.focus();
    m.click('[data-screen="callback"] .acts [data-action="back"]');
    expect(m.shadow.activeElement).toBe(m.q('[data-screen="callback"] .ct'));
  });

  it('a new screen is shown before focus moves into it (a browser cannot focus inside a still-hidden screen)', async () => {
    const m = mountCallWidget({ locale: 'en' });
    m.open();
    await flush();
    // jsdom applies no stylesheet: record, at each focus(), whether the target's screen was already the shown one.
    const seen: Array<{ on: boolean; inert: boolean }> = [];
    const proto = m.win.HTMLElement.prototype;
    const focus = proto.focus;
    proto.focus = function (this: HTMLElement, ...args: [FocusOptions?]) {
      const scr = this.closest('.scr');
      if (scr) seen.push({ on: scr.classList.contains('on'), inert: scr.hasAttribute('inert') });
      return focus.apply(this, args);
    };
    m.q<HTMLButtonElement>('[data-screen="home"] [data-action="callback"]')!.focus();
    seen.length = 0;
    m.click('[data-screen="home"] [data-action="callback"]');
    expect(m.shadow.activeElement).toBe(m.q('[data-screen="callback"] .ct'));
    expect(seen).toEqual([{ on: true, inert: false }]);
    expect(m.q('[data-screen="home"]')!.hasAttribute('inert')).toBe(true);
  });
});

describe('targets', () => {
  it('controls drawn smaller than 44px get a 44px target from a transparent ::before', () => {
    const css = widgetSource('presentation-default-panel.css');
    // The form's back button (36px; grown downwards, the header is drawn over what reaches into it).
    expect(css).toContain('.ctx .ib { width: 36px; height: 36px;');
    expect(css).toContain('.ctx .ib::before { inset: 0 -4px -8px; }');
    // The summary's "Change" (a 12.5px word in a 52px row) and the 40px segments.
    expect(css).toContain('.sumchip .chg::before { content: ""; position: absolute; inset: -12px -10px; }');
    expect(css).toMatch(/\.seg button \{ position: relative;[^}]*height: 40px;/);
    expect(css).toContain('.seg button::before { content: ""; position: absolute; inset: -2px 0; }');
    // A one-letter chip still 44px wide.
    expect(css).toMatch(/\.chip \{[^}]*min-width: 44px; height: 36px;/);
  });
});

describe('the call stage', () => {
  const NOW = Date.parse('2026-10-22T11:00:00+03:30');
  const call = (m: Mounted, extra: Record<string, unknown> = {}) => m.set({
    state: 'in_call', callId: 'c1', connectStatus: 'in_call', operatorName: 'Sara Mohammadi', callStartedAt: NOW - 134_000,
    micOn: true, camOn: true, call: { id: 'c1', call_type: 'audio', state: 'active', recording_state: 'recording' }, ...extra,
  });
  const STAGE: Array<[string, Record<string, unknown>]> = [
    ['connecting', { state: 'loading' }],
    ['queue', { state: 'queue_waiting', callId: 'c1', queuePosition: 3, queueEta: 180, queueStartedAt: NOW - 47_000 }],
    ['joining', { state: 'in_call', connectStatus: 'waiting_for_operator', operatorName: 'Sara' }],
    ['voice', {}],
    ['video', { call: { id: 'c1', call_type: 'video', recording_state: 'recording' } }],
    ['transfer', { transferring: true }],
    ['reconnect', { connectStatus: 'media_reconnecting' }],
    ['mic', { connectStatus: 'microphone_permission_denied' }],
    ['fail', { connectStatus: 'operator_left' }],
  ];

  it.each(STAGE)('%s: no status or live region in the panel; its timers are role=timer outside any live region', (id, fields) => {
    const m = mountCallWidget({ locale: 'en', now: NOW });
    m.open();
    m.media({ video: true, self: true });
    if (id === 'connecting' || id === 'queue') m.set(fields);
    else call(m, fields);
    expect(m.screenId()).toBe(id);
    expect(m.q('#ccw-panel [role="status"], #ccw-panel [aria-live]')).toBeNull();
    for (const timer of m.qa('[role="timer"]')) expect(timer.closest('[aria-live], [role="status"], [role="log"]')).toBeNull();
    // Everything that ticks each second is a timer or sits in one (joining's chip is a status, it does not tick).
    const tickers = m.qa('.scr.on .tmr b, .scr.on:not([data-screen="joining"]) .ctm, .scr.on .vtop .num');
    for (const n of tickers) expect(n.closest('[role="timer"]') || n.closest('.vtop')).not.toBeNull();
  });

  it('the minimised bars tick outside any live region too', () => {
    const m = mountCallWidget({ locale: 'en', now: NOW });
    m.open();
    call(m);
    m.click('.scr.on [data-action="minimize"]');
    const sf = m.q('.ccw-launcher-wrap .mc')!;
    expect(sf.closest('[aria-live], [role="status"]')).toBeNull();
    expect(sf.querySelector('[aria-live], [role="status"]')).toBeNull();
    expect(sf.getAttribute('role')).toBe('group');
    expect(sf.getAttribute('aria-label')).toBe('In call');
  });

  it('toggles say what they do and whether they are on: the microphone, the camera, the ring', () => {
    const m = mountCallWidget({ locale: 'en', now: NOW });
    m.open();
    m.media({ video: true, self: true });
    call(m, { call: { id: 'c1', call_type: 'video', recording_state: null } });
    const mic = m.q('[data-screen="video"] [data-action="mute"]')!;
    const cam = m.q('[data-screen="video"] [data-action="cam"]')!;
    expect([mic.getAttribute('aria-label'), mic.getAttribute('aria-pressed')]).toEqual(['Mute', 'false']);
    expect([cam.getAttribute('aria-label'), cam.getAttribute('aria-pressed')]).toEqual(['Camera off', 'false']);
    m.set({ micOn: false, camOn: false });
    expect([mic.getAttribute('aria-label'), mic.getAttribute('aria-pressed')]).toEqual(['Unmute', 'true']);
    expect([cam.getAttribute('aria-label'), cam.getAttribute('aria-pressed')]).toEqual(['Camera on', 'true']);
    expect(m.q('[data-screen="video"] [data-action="end"]')!.getAttribute('aria-label')).toBe('End call');
    expect(m.q('[data-screen="video"] .vdock [data-action="minimize"]')!.getAttribute('aria-label')).toBe('Minimize');
    const audio = m.fakeAudio({ active: true, muted: true });
    m.set({ state: 'queue_waiting', queuePosition: 2, queueStartedAt: NOW - 1000 });
    const sound = m.q('[data-screen="queue"] [data-action="sound"]')!;
    expect([sound.getAttribute('aria-label'), sound.getAttribute('aria-pressed')]).toEqual(['Unmute sound', 'true']);
    audio.muted = false;
    m.ctrl.render();
    expect([sound.getAttribute('aria-label'), sound.getAttribute('aria-pressed')]).toEqual(['Mute sound', 'false']);
  });

  it('decorative drawings are hidden from assistive technology; the self-view is named', () => {
    const m = mountCallWidget({ locale: 'en', now: NOW });
    m.open();
    m.media({ video: true, self: true });
    call(m, { call: { id: 'c1', call_type: 'video', recording_state: 'recording' } });
    expect(m.q('[data-screen="video"] .feed')!.getAttribute('aria-hidden')).toBe('true');
    const pip = m.q('[data-screen="video"] .pip')!;
    expect(pip.getAttribute('role')).toBe('img');
    expect(pip.getAttribute('aria-label')).toBe('You');
    call(m, { transferring: true });
    expect(m.q('[data-screen="transfer"] .xf')!.getAttribute('aria-hidden')).toBe('true');
    m.set({ state: 'queue_waiting', transferring: false, queuePosition: 3, queueStartedAt: NOW - 1000 });
    for (const sel of ['.orb', '.ql2', '.pill .eq']) expect(m.q(`[data-screen="queue"] ${sel}`)!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('announcements of the call', () => {
  const NOW = Date.parse('2026-10-22T11:00:00+03:30');
  const said = (m: Mounted) => (m.q('.ccw-live')!.textContent || '').replace(/\u200b/g, '');

  it('a queue position change is announced, also while minimised (the region is outside the inert panel); the timer never is', () => {
    const m = mountCallWidget({ locale: 'en', now: NOW });
    m.open();
    m.set({ state: 'queue_waiting', callId: 'c1', queuePosition: 3, queueStartedAt: NOW - 47_000 });
    expect(said(m)).toBe('#3 in line');
    m.click('[data-screen="queue"] [data-action="minimize"]');
    expect(m.q('#ccw-panel')!.hasAttribute('inert')).toBe(true);
    m.set({ queuePosition: 2 });
    expect(said(m)).toBe('#2 in line');
    m.set({ queuePosition: 1 });
    expect(said(m)).toBe('You are next');
    const before = m.q('.ccw-live')!.textContent;
    m.setNow(NOW + 5000);
    m.ctrl.render();
    expect(m.q('.ccw-live')!.textContent).toBe(before);
  });

  it('an outcome on the open panel is said when focus is elsewhere; when focus moved to its heading, the heading says it', () => {
    const m = mountCallWidget({ locale: 'en', now: NOW });
    m.open();
    const call = { state: 'in_call', callId: 'c1', connectStatus: 'in_call', operatorName: 'Sara', callStartedAt: NOW, micOn: true, call: { call_type: 'audio' } };
    m.set(call);
    expect(said(m)).toBe('In call');
    // The visitor reads the page: the panel stays open, nothing in it has focus.
    (m.shadow.activeElement as HTMLElement | null)?.blur();
    expect(m.shadow.activeElement).toBeNull();
    m.set({ connectStatus: 'operator_left' });
    expect(m.screenId()).toBe('fail');
    expect(said(m)).toBe(m.ctrl.t('operator_left'));
    // Focus in the panel follows the screen change to the failure's heading: no second reading.
    const m2 = mountCallWidget({ locale: 'en', now: NOW });
    m2.open();
    m2.set(call);
    m2.q<HTMLButtonElement>('[data-screen="voice"] [data-action="mute"]')!.focus();
    m2.set({ connectStatus: 'media_disconnected' });
    expect(m2.screen()!.contains(m2.shadow.activeElement)).toBe(true);
    expect(said(m2)).toBe('In call');
  });

  it('call status changes are announced: in call, transferring, reconnecting', () => {
    const m = mountCallWidget({ locale: 'en', now: NOW });
    m.open();
    m.set({ state: 'in_call', callId: 'c1', connectStatus: 'in_call', operatorName: 'Sara', callStartedAt: NOW, call: { call_type: 'audio' } });
    expect(said(m)).toBe('In call');
    m.set({ transferring: true });
    expect(said(m)).toBe('Transferring to another operator…');
    m.set({ transferring: false, connectStatus: 'media_reconnecting' });
    expect(said(m)).toBe('Reconnecting media…');
  });
});

describe('the minimised call\'s controls', () => {
  const NOW = Date.parse('2026-10-22T11:00:00+03:30');
  it('Se, Sf and Sg name every control; the video window is a named group', () => {
    const m = mountCallWidget({ locale: 'en', now: NOW });
    m.open();
    m.set({ state: 'queue_waiting', callId: 'c1', queuePosition: 3, queueStartedAt: NOW - 47_000 });
    m.click('.scr.on [data-action="minimize"]');
    const names = () => m.qa('.ccw-launcher-wrap button').map((b) => [b.getAttribute('data-action'), b.getAttribute('aria-label'), b.getAttribute('type')]);
    expect(m.q('.ccw-launcher-wrap .mc')!.getAttribute('aria-label')).toBe('#3 in line');
    expect(names()).toEqual([['restore', 'Open the call', 'button'], ['cancel', 'Cancel call', 'button']]);
    m.media({ video: true });
    m.set({ state: 'in_call', connectStatus: 'in_call', operatorName: 'Sara', callStartedAt: NOW, micOn: true, call: { call_type: 'audio' } });
    expect(names()).toEqual([['restore', 'Open the call', 'button'], ['mute', 'Mute', 'button'], ['end', 'End call', 'button']]);
    m.set({ call: { call_type: 'video' } });
    expect(m.q('.ccw-launcher-wrap .mvid')!.getAttribute('role')).toBe('group');
    expect(names()).toEqual([['restore', 'Open the call', 'button'], ['mute', 'Mute', 'button'], ['end', 'End call', 'button']]);
  });

  it('controls drawn smaller than 44px get a 44px target', () => {
    const css = widgetSource('presentation-default-panel.css');
    // The bars' 40px buttons, the video window's 30px buttons and its 26px restore.
    expect(css).toMatch(/\.mc \.mbt::before \{ content: ""; position: absolute; inset: -2px; \}/);
    expect(css).toMatch(/\.mvid \.bar3 button::before \{ content: ""; position: absolute; inset: -7px; \}/);
    // The 26px restore sits 6px from the window's corner, which clips: its 44px grow inwards.
    expect(css).toMatch(/\.mvid \.exp::before \{ content: ""; position: absolute; inset-block: -6px -12px; inset-inline: -12px -6px; \}/);
    // The timer row's 34px sound toggle.
    expect(css).toMatch(/\.sbt::before \{ content: ""; position: absolute; inset: -5px; \}/);
  });

  it('their focus ring is white on the dark bars in both skins (the International skin\'s Signal ring is for light surfaces)', () => {
    const css = widgetSource('presentation-default-panel.css');
    // (0,4,0) and (0,3,1) beat the skin's `.ccw-presentation-intl :is(button, …):focus-visible`
    // (0,3,0), which comes later in the cascade.
    expect(css).toContain('.ccw-launcher-wrap .mc .mbt:focus-visible, .ccw-launcher-wrap .mvid button:focus-visible { outline-color: #fff; }');
  });
});

describe('phones: the sheet and the full-screen panel are modal (D14)', () => {
  const tab = (m: Mounted, shift = false) => {
    const from = (m.shadow.activeElement || m.q('#ccw-panel')!) as HTMLElement;
    const ev = new m.win.KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
    from.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  /** What Tab reaches inside the shown screen, in order. */
  const reachable = (m: Mounted) => m.qa('.scr.on :is(button, a[href], input, select, textarea)')
    .filter((el) => (el as HTMLElement).tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !el.closest('[hidden]'));

  it('aria-modal on a phone only, in the sheet and in the full screen; the scrim is not announced', () => {
    const m = mountCallWidget({ locale: 'en', device: 'phone' });
    m.open();
    const panel = m.q('#ccw-panel')!;
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(m.q('.scrim')!.getAttribute('aria-hidden')).toBe('true');
    m.set({ state: 'queue_waiting', callId: 'c1', queuePosition: 3, queueStartedAt: Date.now() - 47_000 });
    expect(panel.getAttribute('aria-modal')).toBe('true');
    const desk = mountCallWidget({ locale: 'en' });
    desk.open();
    expect(desk.q('#ccw-panel')!.hasAttribute('aria-modal')).toBe(false);
  });

  it('Tab stays inside: from the last control to the first, Shift+Tab from the first to the last; a desktop lets Tab go on', () => {
    const m = mountCallWidget({ locale: 'en', device: 'phone' });
    m.open();
    const list = reachable(m);
    expect(list.length).toBeGreaterThan(2);
    list[list.length - 1].focus();
    expect(tab(m)).toBe(true);
    expect(m.shadow.activeElement).toBe(list[0]);
    expect(tab(m, true)).toBe(true);
    expect(m.shadow.activeElement).toBe(list[list.length - 1]);
    // In between, the browser moves on its own.
    list[0].focus();
    expect(tab(m)).toBe(false);
    // From the panel itself (focus on open): Tab enters at its first control on its own; Shift+Tab goes round to the last.
    (m.q('#ccw-panel') as HTMLElement).focus();
    expect(tab(m)).toBe(false);
    expect(tab(m, true)).toBe(true);
    expect(m.shadow.activeElement).toBe(list[list.length - 1]);
    const desk = mountCallWidget({ locale: 'en' });
    desk.open();
    const dl = reachable(desk);
    dl[dl.length - 1].focus();
    expect(tab(desk)).toBe(false);
  });

  it('from a new screen\'s heading (where a screen change puts focus) Tab and Shift+Tab keep the reading order: only the ends go round', () => {
    const m = mountCallWidget({ locale: 'en', device: 'phone' });
    m.open();
    m.click('[data-action="callback"]');
    const head = m.q<HTMLElement>('.scr.on :is([data-focus], h2, h3)')!;
    const list = reachable(m);
    // Controls on both sides of it: the header's and the back button before, the form after.
    expect(list.some((x) => x.compareDocumentPosition(head) & 4)).toBe(true);
    expect(list.some((x) => x.compareDocumentPosition(head) & 2)).toBe(true);
    head.setAttribute('tabindex', '-1');
    head.focus();
    expect(m.shadow.activeElement).toBe(head);
    expect(tab(m)).toBe(false);
    expect(m.shadow.activeElement).toBe(head);
    expect(tab(m, true)).toBe(false);
    expect(m.shadow.activeElement).toBe(head);
  });

  it('a tap on the scrim moves no focus (it would drop to the page): the close gives it back to the launcher', () => {
    const m = mountCallWidget({ locale: 'en', device: 'phone' });
    m.open();
    m.q<HTMLElement>('.scr.on [data-action="voice"]')!.focus();
    const scrim = m.q<HTMLElement>('.scrim')!;
    const down = new m.win.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    scrim.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    scrim.click();
    expect(m.ctrl.open).toBe(false);
    expect(m.shadow.activeElement).toBe(m.q('.ccw-launcher-btn'));
  });

  it('the inert screens, hidden parts and roving radios stay out of the loop', () => {
    const m = mountCallWidget({ locale: 'en', device: 'phone' });
    m.open();
    m.click('[data-action="callback"]');
    const list = reachable(m);
    const radios = list.filter((el) => el.getAttribute('role') === 'radio');
    // One stop per radio group.
    for (const g of m.qa('.scr.on [role="radiogroup"]')) expect(radios.filter((r) => g.contains(r))).toHaveLength(1);
    list[list.length - 1].focus();
    tab(m);
    expect(m.shadow.activeElement).toBe(list[0]);
    expect(m.screen()!.contains(m.shadow.activeElement)).toBe(true);
  });
});

describe('the failure screens say why when focus lands on their heading', () => {
  const NOW = Date.parse('2026-10-22T11:00:00+03:30');
  const call = (m: Mounted, extra: Record<string, unknown>) => m.set({
    state: 'in_call', callId: 'c1', connectStatus: 'in_call', operatorName: 'Sara', callStartedAt: NOW - 134_000,
    micOn: true, call: { id: 'c1', call_type: 'audio', state: 'active' }, ...extra,
  });
  /** The texts a heading's aria-describedby names, in order. */
  const described = (m: Mounted, h: Element) => (h.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
    .map((id) => (m.shadow.getElementById(id)?.textContent || '').trim());

  it('a failure: its title is described by the reason the engine gives', () => {
    const m = mountCallWidget({ locale: 'en', now: NOW });
    m.open();
    call(m, { connectStatus: 'room_connect_failed', error: 'The room refused the connection.' });
    expect(m.screenId()).toBe('fail');
    const h = m.q('.scr.on h2.sh')!;
    expect(described(m, h)).toEqual(['The room refused the connection.']);
  });

  it('the microphone blocked: what happened and how to allow it', () => {
    const m = mountCallWidget({ locale: 'en', now: NOW });
    m.open();
    call(m, { connectStatus: 'microphone_permission_denied' });
    const h = m.q('.scr.on h2.sh')!;
    expect(described(m, h)).toEqual([m.ctrl.t('mic_denied_body'), m.ctrl.t('mic_denied_how')]);
  });

  it('the error screen (its title is the error): described by what the visitor can do', () => {
    const m = mountCallWidget({ locale: 'en', now: NOW });
    m.open();
    m.set({ state: 'error', error: 'Something went wrong.' });
    const h = m.q('.scr.on h3[data-error]')!;
    expect(described(m, h)).toEqual([m.ctrl.t('error_callback_hint')]);
  });
});

describe('focus stays visible with any accent', () => {
  it('a light accent (Ink on it) draws the focus ring in Ink: a yellow ring on white would not show (1.4:1)', () => {
    const light = mountCallWidget({ locale: 'en', bootstrap: { config: { widget_theme: { primary: '#F5D90A' } } } });
    expect(light.root.style.getPropertyValue('--ring')).toBe('var(--ink)');
    const dark = mountCallWidget({ locale: 'en', bootstrap: { config: { widget_theme: { primary: '#2563EB' } } } });
    expect(dark.root.style.getPropertyValue('--ring')).toBe('');
    const css = widgetSource('runtime.css');
    expect(css).toContain('.ccw-root :is(button, a, select, [tabindex="0"]):focus-visible { outline: 2px solid var(--ring, var(--a)); outline-offset: 2px; }');
    expect(widgetSource('presentation-default-panel.css')).toContain('.lang:focus-within { outline: 2px solid var(--ring, var(--a)); outline-offset: 2px; }');
  });

  it('the credit\'s link (a 40px row at the panel\'s foot) never takes a press meant for the action row above it', () => {
    // Its row sits right under Submit, Continue, Done and the call dock: a target grown upwards took their bottom
    // 4px (a press there opened the credit's site; Chromium hit-test). On a phone it grows into the margin under it.
    const css = widgetSource('presentation-default-panel.css');
    const grown = [...css.matchAll(/(^|\n)([^{}\n]*\.pw::before) \{([^}]*)\}/g)].map((m) => [m[2], m[3]]);
    expect(grown).toEqual([['.is-mobile a.pw::before', ' content: ""; position: absolute; inset: 0 0 -4px; ']]);
    expect(css).toContain('.is-mobile a.pw { position: relative; }');
    expect(css).toContain('.is-mobile .pw { margin-bottom: max(env(safe-area-inset-bottom), 8px); }');
  });
});
