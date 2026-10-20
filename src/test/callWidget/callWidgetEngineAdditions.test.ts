/**
 * The engine's §9 additions (contract §3). Round 1: E1, the five placements,
 * and the spellings stored before them (a stored `bottom-left` used to show
 * on the right), and E18, the loader's panel hook. The engine round: E10–E16,
 * E19 and E20, driven end to end like the fixes (`callWidgetFixes.test.ts`):
 * the runtime and the presentation in jsdom, a fake server (`fakeApi`) and a
 * fake media client (`liveKit`: participants, permissions, connection quality,
 * the AudioContext's state), timers faked.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callRoutes, closeCallWidgets, fakeApi, mountCallWidget, settle,
  type ApiAnswer, type ApiRequest, type CallServerState, type Engine, type FakeAudioContext, type MountOptions,
} from './mountCallWidget';

afterEach(() => closeCallWidgets());

describe('E1: position() and its aliases', () => {
  it.each([
    ['right', 'right', 'right'],
    ['bottom-right', 'right', 'right'],
    ['bottom_right', 'right', 'right'],
    ['left', 'left', 'left'],
    ['bottom-left', 'left', 'left'],
    ['bottom_left', 'left', 'left'],
    ['top_right', 'top_right', 'right top'],
    ['top-right', 'top_right', 'right top'],
    ['top_left', 'top_left', 'left top'],
    ['top-left', 'top_left', 'left top'],
    ['bottom_center', 'bottom_center', 'center'],
    ['bottom-center', 'bottom_center', 'center'],
    ['center', 'bottom_center', 'center'],
    ['middle', 'right', 'right'],
    ['', 'right', 'right'],
    [null, 'right', 'right'],
    [42, 'right', 'right'],
  ])('%j → %s', (stored, position, classes) => {
    const m = mountCallWidget({ bootstrap: { config: { widget_position: stored } } });
    expect(m.ctrl.position()).toBe(position);
    expect(m.q('.ccw-launcher-wrap')!.className).toBe(`ccw-launcher-wrap ${classes}`);
    expect(m.q('#ccw-panel')!.className).toBe(`ccw-panel cp lv ${classes}`);
  });

  it('a left placement turns the label to the page (the close button at its other end)', () => {
    expect(mountCallWidget({ bootstrap: { config: { widget_position: 'bottom-left' } } }).q('.ln-cl')!.classList.contains('at-l')).toBe(true);
    expect(mountCallWidget({ bootstrap: { config: { widget_position: 'top_left' } } }).q('.ln-cl')!.classList.contains('at-l')).toBe(true);
    expect(mountCallWidget({ bootstrap: { config: { widget_position: 'right' } } }).q('.ln-cl')!.classList.contains('at-l')).toBe(false);
  });
});

describe('E18: the loader\'s panel hook reaches the presentation', () => {
  it('kept from mount and passed in every render context; none = null, no throw', () => {
    const hook = () => {};
    const seen: unknown[] = [];
    const m = mountCallWidget({ loadPanel: hook });
    const pres = (m.ctrl as unknown as { presentation: { update: (i: unknown, c: { loadPanel: unknown }) => void } }).presentation;
    const update = pres.update;
    pres.update = (i, c) => { seen.push(c.loadPanel); update(i, c); };
    m.ctrl.render();
    expect((m.ctrl as unknown as { loadPanel: unknown }).loadPanel).toBe(hook);
    expect(seen).toEqual([hook]);
    const none = mountCallWidget();
    expect((none.ctrl as unknown as { loadPanel: unknown }).loadPanel).toBeNull();
    expect(() => none.ctrl.render()).not.toThrow();
  });
});

describe('the engine round (E10–E16, E19, E20)', () => {
  const NOW = Date.parse('2026-10-22T07:30:00Z');
  const DAY = 86_400_000;
  const iso = (t: number) => new Date(t).toISOString();
  const SESSION_KEY = 'ccw_active_call_session:22222222-2222-4222-8222-222222222222:https://api.example';
  const BOOKING_KEY = 'ccw_callback_booking:22222222-2222-4222-8222-222222222222:https://api.example';
  type Route = (req: ApiRequest) => ApiAnswer | Promise<ApiAnswer> | undefined;

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); });
  afterEach(() => { closeCallWidgets(); vi.useRealTimers(); });

  function engine(route: Route = () => undefined, opts: MountOptions = {}) {
    const api = fakeApi(route);
    const m = mountCallWidget({
      locale: 'en', now: NOW, liveKit: true, ...opts, fetch: api.fetch,
      mountExtra: { activeSessionKey: SESSION_KEY, ...opts.mountExtra },
      bootstrap: { queue_experience: { ringback_enabled: true }, ...opts.bootstrap },
    });
    return { m, api, c: m.ctrl as unknown as Engine };
  }
  function resumed(s: CallServerState, opts: MountOptions & { more?: Route } = {}) {
    return engine(callRoutes(s, opts.more), {
      ...opts,
      bootstrap: { active_call: { call_id: 'c1', state: s.state, session: 'S1', call_type: s.type ?? 'audio', created_at: iso(NOW - 60_000) }, ...opts.bootstrap },
    });
  }
  /** Counts the engine's renders from now on. */
  function renders(c: Engine) {
    const pres = (c as unknown as { presentation: { update: (i: unknown, ctx: unknown) => void } }).presentation;
    const update = pres.update;
    const n = { count: 0 };
    pres.update = (i, ctx) => { n.count += 1; update(i, ctx); };
    return n;
  }
  /** An operator in the room, on a call whose agent reference is A ("Sara"). */
  async function liveCall(over: Partial<CallServerState> = {}, opts: MountOptions = {}) {
    const s: CallServerState = { state: 'active', agent: 'A', name: 'Sara', startedAt: iso(NOW - 134_000), ...over };
    const env = resumed(s, { liveKit: { present: ['op-a'] }, ...opts });
    await settle();
    env.m.loadLinks();
    return { ...env, s, room: env.m.lk!.room() };
  }
  async function poll(c: Engine) { c.pollOnce(); await settle(); }

  describe('E10: the call time runs on across a transfer', () => {
    it('callStartedAt and its ticker are kept from the agent change to the next operator', async () => {
      const { c, s, room } = await liveCall();
      expect(c.callStartedAt).toBe(NOW - 134_000);
      const ticker = c.callTimer;
      expect(ticker).toBeTruthy();
      Object.assign(s, { agent: 'B', name: 'Reza' });
      await poll(c);
      expect(c.transferring).toBe(true);
      expect(c.callStartedAt).toBe(NOW - 134_000);
      expect(c.callTimer).toBe(ticker);
      room.leave('op-a');
      room.join('op-b');
      expect(c.transferring).toBe(false);
      expect(c.callStartedAt).toBe(NOW - 134_000);
      expect(c.callTimer).toBe(ticker);
    });
  });

  describe('E11: the booked callback (callbackBooking, kept in localStorage until its time)', () => {
    const later = (c: Engine, local: string, extra: Record<string, unknown> = {}) => {
      c.openCallback();
      Object.assign(c.formData, { callback_when: 'later', callback_scheduled_for: local, callback_channel: 'audio', callback_urgency: 'urgent', ...extra });
      c.submitCallback();
    };
    const stored = (m: { win: Window }) => {
      const raw = m.win.localStorage.getItem(BOOKING_KEY);
      return raw == null ? null : JSON.parse(raw) as unknown;
    };

    it('a scheduled request: the server\'s echo, stored under the loader\'s scope, kept through reset()', async () => {
      const { m, c } = engine((req) => (req.path === '/api/call-widget/callbacks/request'
        ? { body: { ok: true, callback_id: 'cb-9', scheduled_for: '2026-10-23T13:00:00.000Z', channel: 'video' } } : undefined));
      expect(c.callbackBooking ?? null).toBeNull();
      later(c, '2026-10-23T16:30');
      await settle();
      const booking = { callbackId: 'cb-9', scheduled_for: '2026-10-23T13:00:00.000Z', channel: 'video', urgency: 'urgent' };
      expect(c.callbackBooking).toEqual(booking);
      expect(stored(m)).toEqual(booking);
      c.reset();
      expect(c.callbackId).toBeNull();
      expect(c.callbackBooking).toEqual(booking);
      expect(stored(m)).toEqual(booking);
    });

    it('without an echo (an older server): what was sent', async () => {
      const { m, c } = engine((req) => (req.path === '/api/call-widget/callbacks/request' ? { body: { ok: true, callback_id: 'cb-3' } } : undefined));
      later(c, '2026-10-23T16:30', { callback_channel: 'audio', callback_urgency: 'normal' });
      await settle();
      const sent = new (m.win as unknown as { Date: DateConstructor }).Date('2026-10-23T16:30').toISOString();
      expect(c.callbackBooking).toEqual({ callbackId: 'cb-3', scheduled_for: sent, channel: 'audio', urgency: 'normal' });
    });

    it('read at mount; dropped, field and key, once its time has passed (at mount or reset)', () => {
      const ahead = { callbackId: 'cb-4', scheduled_for: iso(NOW + DAY), channel: 'audio', urgency: 'normal' };
      const seed = (v: unknown) => ({ setup: (w: Window) => w.localStorage.setItem(BOOKING_KEY, typeof v === 'string' ? v : JSON.stringify(v)) });
      const kept = engine(undefined, seed(ahead));
      expect(kept.c.callbackBooking).toEqual(ahead);
      const past = engine(undefined, seed({ ...ahead, scheduled_for: iso(NOW - 1) }));
      expect(past.c.callbackBooking ?? null).toBeNull();
      expect(past.m.win.localStorage.getItem(BOOKING_KEY)).toBeNull();
      kept.m.setNow(NOW + DAY + 1);
      kept.c.reset();
      expect(kept.c.callbackBooking ?? null).toBeNull();
      expect(kept.m.win.localStorage.getItem(BOOKING_KEY)).toBeNull();
      for (const junk of ['not json', '{"callbackId":1}', JSON.stringify({ ...ahead, scheduled_for: 'soon' })]) {
        const bad = engine(undefined, seed(junk));
        expect(bad.c.callbackBooking ?? null, junk).toBeNull();
        expect(bad.m.win.localStorage.getItem(BOOKING_KEY), junk).toBeNull();
      }
    });

    it('"as soon as possible" books nothing (an earlier booking stays); a new booking replaces it', async () => {
      let n = 0;
      const { m, c } = engine((req) => (req.path === '/api/call-widget/callbacks/request' ? { body: { ok: true, callback_id: `cb-${++n}` } } : undefined));
      c.openCallback();
      c.submitCallback();
      await settle();
      expect(c.callbackId).toBe('cb-1');
      expect(c.callbackBooking ?? null).toBeNull();
      expect(stored(m)).toBeNull();
      c.reset();
      later(c, '2026-10-23T10:00');
      await settle();
      expect(c.callbackBooking!.callbackId).toBe('cb-2');
      c.reset();
      c.openCallback();
      c.formData.callback_when = 'now';
      c.submitCallback();
      await settle();
      expect(c.callbackId).toBe('cb-3');
      expect(c.callbackBooking!.callbackId).toBe('cb-2');
      c.reset();
      later(c, '2026-10-24T10:00');
      await settle();
      expect(c.callbackBooking!.callbackId).toBe('cb-4');
      expect((stored(m) as { callbackId: string }).callbackId).toBe('cb-4');
    });

    it('a browser that refuses storage still books for the page view', async () => {
      const { c } = engine((req) => (req.path === '/api/call-widget/callbacks/request' ? { body: { ok: true, callback_id: 'cb-5' } } : undefined), {
        setup: (w) => Object.defineProperty(w, 'localStorage', { configurable: true, get() { throw new Error('denied'); } }),
      });
      later(c, '2026-10-23T16:30');
      await settle();
      expect(c.callbackBooking!.callbackId).toBe('cb-5');
      expect(() => c.reset()).not.toThrow();
    });
  });

  describe('E12: connectionQuality (the visitor\'s own connection)', () => {
    it('follows the local participant, renders once per change, unknown = none, cleared with the room', async () => {
      const { c, room } = await liveCall();
      expect(c.connectionQuality ?? null).toBeNull();
      const n = renders(c);
      room.emit('connectionQualityChanged', 'poor', room.localParticipant);
      expect(c.connectionQuality).toBe('poor');
      expect(n.count).toBe(1);
      room.emit('connectionQualityChanged', 'poor', room.localParticipant);
      expect(n.count).toBe(1);
      room.emit('connectionQualityChanged', 'excellent', room.remoteParticipants.get('op-a'));
      expect(c.connectionQuality).toBe('poor');
      expect(n.count).toBe(1);
      room.emit('connectionQualityChanged', 'unknown', room.localParticipant);
      expect(c.connectionQuality).toBeNull();
      expect(n.count).toBe(2);
      for (const q of ['lost', 'good', 'excellent']) {
        room.emit('connectionQualityChanged', q, room.localParticipant);
        expect(c.connectionQuality).toBe(q);
      }
      c.disconnectRoom();
      expect(c.connectionQuality).toBeNull();
    });
  });

  describe('E13: retryMicrophone()', () => {
    it('denied, then allowed: the call goes on (a video call turns its camera on too)', async () => {
      const { m, c, room } = await liveCall({ type: 'video' }, { liveKit: { micDenials: 1, present: ['op-a'] } });
      expect(c.connectStatus).toBe('microphone_permission_denied');
      expect(c.error).toBe(c.t('mic_denied'));
      expect(m.screenId()).toBe('mic');
      expect(typeof c.retryMicrophone).toBe('function');
      await c.retryMicrophone!();
      await settle();
      expect(room.localParticipant.micCalls).toEqual([true, true]);
      expect(room.localParticipant.camCalls).toEqual([true]);
      expect(c.micOn).toBe(true);
      expect(c.camOn).toBe(true);
      expect(c.error).toBeNull();
      expect(c.connectStatus).toBe('in_call');
      expect(m.screenId()).toBe('video');
    });

    it('denied again: stays on the microphone screen, never a rejection', async () => {
      const { m, c } = await liveCall({}, { liveKit: { micDenials: 2, present: ['op-a'] } });
      expect(c.connectStatus).toBe('microphone_permission_denied');
      await expect(Promise.resolve(c.retryMicrophone!())).resolves.toBeUndefined();
      await settle();
      expect(c.connectStatus).toBe('microphone_permission_denied');
      expect(c.micOn).toBeFalsy();
      expect(m.screenId()).toBe('mic');
    });

    it('without a room: nothing happens', () => {
      const { c } = engine();
      expect(() => c.retryMicrophone!()).not.toThrow();
      expect(c.state).toBe('online_available');
    });

    it('an operator who joins (or a reconnect) while it is refused keeps the microphone screen and its retry; the ring stops', async () => {
      const { m, c, room } = await liveCall({}, { liveKit: { micDenials: 1, present: [] } });
      expect(c.connectStatus).toBe('microphone_permission_denied');
      expect(m.context().audio.isActive()).toBe(true);
      room.join('op-a');
      expect(c.connectStatus).toBe('microphone_permission_denied');
      expect(m.screenId()).toBe('mic');
      expect(m.context().audio.isActive()).toBe(false);
      room.emit('reconnected');
      expect(c.connectStatus).toBe('microphone_permission_denied');
      await c.retryMicrophone!();
      await settle();
      expect(c.micOn).toBe(true);
      expect(c.connectStatus).toBe('in_call');
      expect(m.screenId()).toBe('voice');
    });
  });

  describe('E14: the dismissed label (sessionStorage ccw_label_dismissed)', () => {
    it('dismissLabel() keeps it for the session; the next page view of the session starts without it', () => {
      const { m, c } = engine();
      expect(c.labelDismissed).toBe(false);
      expect(m.q('.ln-cl')).not.toBeNull();
      m.click('.lbl .x[data-action="label-close"]');
      expect(c.labelDismissed).toBe(true);
      expect(m.win.sessionStorage.getItem('ccw_label_dismissed')).toBe('1');
      expect(m.q('.ln-cl')).toBeNull();
      const next = engine(undefined, { setup: (w) => w.sessionStorage.setItem('ccw_label_dismissed', '1') });
      expect(next.c.labelDismissed).toBe(true);
      expect(next.m.q('.ln-cl')).toBeNull();
    });

    it('the dashboard\'s preview neither reads nor writes it', () => {
      const preview = mountCallWidget({ locale: 'en', setup: (w) => w.sessionStorage.setItem('ccw_label_dismissed', '1') });
      const c = preview.ctrl as unknown as Engine;
      expect(c.labelDismissed).toBe(false);
      expect(preview.q('.ln-cl')).not.toBeNull();
      preview.win.sessionStorage.removeItem('ccw_label_dismissed');
      preview.click('.lbl .x[data-action="label-close"]');
      expect(c.labelDismissed).toBe(true);
      expect(preview.win.sessionStorage.getItem('ccw_label_dismissed')).toBeNull();
    });
  });

  describe('E15: errorKey (the key of the callback form\'s error)', () => {
    it.each([[409, 'slot_unavailable'], [400, 'invalid_scheduled_for']])('%i %s: "pick a valid future time", and the form goes back to the choice', async (status, error) => {
      const { m, c } = engine((req) => (req.path === '/api/call-widget/callbacks/request' ? { status, body: { error } } : undefined));
      m.open();
      c.openCallback();
      Object.assign(c.formData, { callback_when: 'later', callback_scheduled_for: '2026-10-23T16:30' });
      m.click('[data-screen="callback"] [data-action="continue"]');
      expect(m.q('.scr.on .stp')!.textContent).toContain('Step 2 of 2');
      c.submitCallback();
      await settle();
      expect(c.error).toBe(c.t('err_future_time'));
      expect(c.errorKey).toBe('err_future_time');
      expect(m.q('.scr.on .stp')!.textContent).toContain('Step 1 of 2');
    });

    it('client-side refusals name their key; other refusals theirs; a new attempt clears it', async () => {
      let answer: ApiAnswer = { status: 429, body: { error: 'rate_limited_ip' } };
      const { c } = engine((req) => (req.path === '/api/call-widget/callbacks/request' ? answer : undefined), {
        bootstrap: { callback_policy: { require_contact: true } },
      });
      c.openCallback();
      c.submitCallback();
      expect(c.errorKey).toBe('err_contact_required');
      expect(c.error).toBe(c.t('err_contact_required'));
      c.formData.email = 'a@b.example';
      c.submitCallback();
      expect(c.errorKey).toBeNull();
      await settle();
      expect(c.errorKey).toBe('err_rate_limited');
      answer = { body: { ok: true, callback_id: 'cb-1' } };
      c.submitCallback();
      await settle();
      expect(c.errorKey).toBeNull();
      expect(c.error).toBeNull();
    });
  });

  describe('E16: numbers in the engine\'s own sentences', () => {
    it('Persian digits in fa, as written elsewhere; text values untouched', () => {
      const fa = engine(undefined, { locale: 'fa' }).c;
      expect(fa.t('err_wait_seconds', { n: 30 })).toBe('لطفاً ۳۰ ثانیه قبل از ارسال درخواست بعدی صبر کنید.');
      expect(fa.t('err_message_short', { n: 12 })).toContain('۱۲');
      expect(fa.t('room_failed', { error: 'code 1006' })).toContain('code 1006');
      expect(engine(undefined, { locale: 'en' }).c.t('err_wait_seconds', { n: 30 })).toBe('Please wait 30s before sending another request.');
      expect(engine(undefined, { locale: 'tr' }).c.t('err_wait_seconds', { n: 30 })).toContain('30 sn');
    });

    it('a cooldown the server names, then the form\'s own guard, both in Persian digits', async () => {
      const { c } = engine((req) => (req.path === '/api/call-widget/callbacks/request' ? { status: 429, body: { error: 'cooldown_active', retry_after: 45 } } : undefined), { locale: 'fa' });
      c.openCallback();
      c.submitCallback();
      await settle();
      expect(c.error).toBe('قبلاً درخواست تماس ثبت کرده‌اید. لطفاً ۴۵ ثانیه صبر کنید.');
      c.submitCallback();
      expect(c.error).toBe('لطفاً ۴۵ ثانیه قبل از ارسال درخواست بعدی صبر کنید.');
      expect(c.error).not.toMatch(/[0-9]/);
    });
  });

  describe('E19: a transfer, from the agent change until the next operator is in the room', () => {
    it('A → B: screen 10 until B joins; A leaving meanwhile is no failure; then B\'s name', async () => {
      const { m, c, s, room } = await liveCall();
      expect(c.operatorName).toBe('Sara');
      expect(m.screenId()).toBe('voice');
      Object.assign(s, { agent: 'B', name: 'Reza' });
      await poll(c);
      expect(c.transferring).toBe(true);
      expect(c.operatorName).toBeNull();
      expect(m.screenId()).toBe('transfer');
      room.leave('op-a');
      await settle();
      expect(c.connectStatus).not.toBe('operator_left');
      expect(m.screenId()).toBe('transfer');
      await poll(c);
      expect(c.transferring).toBe(true);
      expect(c.operatorName).toBeNull();
      room.join('op-b');
      expect(c.transferring).toBe(false);
      expect(c.operatorName).toBe('Reza');
      expect(c.connectStatus).toBe('operator_connected');
      expect(m.screenId()).toBe('voice');
    });

    it('A → none → B (a department): detected at once; the name waits for the join', async () => {
      const { c, s, room } = await liveCall();
      Object.assign(s, { agent: null, name: null });
      await poll(c);
      expect(c.transferring).toBe(true);
      Object.assign(s, { agent: 'B', name: 'Reza' });
      await poll(c);
      expect(c.transferring).toBe(true);
      expect(c.operatorName).toBeNull();
      room.leave('op-a');
      room.join('op-b');
      expect(c.transferring).toBe(false);
      expect(c.operatorName).toBe('Reza');
    });

    it('before any operator was in the room, an assignment change is routing, not a transfer', async () => {
      const { c, s } = await liveCall({}, { liveKit: { present: [] } });
      expect(c.connectStatus).toBe('waiting_for_operator');
      Object.assign(s, { agent: 'B', name: 'Reza' });
      await poll(c);
      expect(c.transferring).toBe(false);
      expect(c.operatorName).toBe('Reza');
    });

    it('nobody joins within 120 s: operator_left, the failure screen with the callback way out, the hold stopped', async () => {
      const { m, c, s, room } = await liveCall();
      Object.assign(s, { agent: 'B', name: 'Reza' });
      await poll(c);
      room.leave('op-a');
      await vi.advanceTimersByTimeAsync(119_000);
      await settle();
      expect(c.transferring).toBe(true);
      expect(m.context().audio.isActive()).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
      expect(c.transferring).toBe(false);
      expect(c.connectStatus).toBe('operator_left');
      expect(m.screenId()).toBe('fail');
      expect(m.q('[data-screen="fail"] [data-action="callback"]')).not.toBeNull();
      expect(m.context().audio.isActive()).toBe(false);
    });

    it('nobody joins within 120 s while the old operator is still in the room (the hand-off is manual): the call goes on with them, never "operator left"', async () => {
      const { m, c, s } = await liveCall();
      Object.assign(s, { agent: 'B', name: 'Reza' });
      await poll(c);
      expect(c.transferring).toBe(true);
      await vi.advanceTimersByTimeAsync(120_000);
      await settle();
      expect(c.transferring).toBe(false);
      expect(c.connectStatus).toBe('in_call');
      expect(m.screenId()).toBe('voice');
      expect(m.context().audio.isActive()).toBe(false);
    });

    it('the old operator leaves before the poll sees the change: the transfer still shows, not the failure', async () => {
      const { m, c, s, room } = await liveCall();
      Object.assign(s, { agent: 'B', name: 'Reza' });
      room.leave('op-a');
      await settle();
      expect(c.transferring).toBe(true);
      expect(m.screenId()).toBe('transfer');
      room.join('op-b');
      expect(m.screenId()).toBe('voice');
      expect(c.operatorName).toBe('Reza');
    });

    it('the next operator is already in the room when the poll sees the change (the old one still there): no transfer, their name, no hold, no failure', async () => {
      const { m, c, s, room } = await liveCall();
      Object.assign(s, { agent: 'B', name: 'Reza' });
      room.join('op-b');
      await poll(c);
      expect(c.transferring).toBe(false);
      expect(c.operatorName).toBe('Reza');
      expect(m.screenId()).toBe('voice');
      expect(m.context().audio.isActive()).toBe(false);
      room.leave('op-a');
      await vi.advanceTimersByTimeAsync(125_000);
      await settle();
      expect(c.transferring).toBe(false);
      expect(c.connectStatus).toBe('operator_connected');
      expect(m.screenId()).toBe('voice');
      // A later transfer, with nobody new in the room meanwhile, still shows.
      Object.assign(s, { agent: 'C', name: 'Mina' });
      await poll(c);
      expect(c.transferring).toBe(true);
    });

    it('the operator leaves without a transfer: "operator left" once the server has answered (or could not)', async () => {
      const { m, c, room } = await liveCall();
      room.leave('op-a');
      expect(c.connectStatus).toBe('in_call');
      await settle();
      expect(c.connectStatus).toBe('operator_left');
      expect(m.screenId()).toBe('fail');
      let down = false;
      const offline = resumed({ state: 'active', agent: 'A', name: 'Sara' }, {
        liveKit: { present: ['op-a'] },
        more: (req) => (down && /\/status$/.test(req.path) ? 'network' : undefined),
      });
      await settle();
      down = true;
      offline.m.lk!.room().leave('op-a');
      await settle();
      expect(offline.c.connectStatus).toBe('operator_left');
    });

    it('the operator ended the call: the rating, never "operator left" first', async () => {
      const { m, c, s, room } = await liveCall();
      s.state = 'ended';
      room.leave('op-a');
      await settle();
      expect(c.state).toBe('ended');
      expect(c.connectStatus).not.toBe('operator_left');
      expect(m.screenId()).toBe('rating');
    });

    it('the reference comes back to the operator still in the room: the call simply goes on', async () => {
      const { m, c, s } = await liveCall();
      Object.assign(s, { agent: 'B', name: 'Reza' });
      await poll(c);
      expect(c.transferring).toBe(true);
      Object.assign(s, { agent: 'A', name: 'Sara' });
      await poll(c);
      expect(c.transferring).toBe(false);
      expect(c.operatorName).toBe('Sara');
      expect(m.context().audio.isActive()).toBe(false);
      await vi.advanceTimersByTimeAsync(125_000);
      expect(c.connectStatus).not.toBe('operator_left');
    });
  });

  describe('E20: audioMeterLive (the level bars move only while the meter runs)', () => {
    it('suspended (no gesture yet): false; running: true, rendered once; false when the meter stops', async () => {
      const { c } = await liveCall({}, { liveKit: { present: ['op-a'], audioState: 'suspended', resumeWorks: false } });
      expect(c._audioCtx).toBeTruthy();
      expect(c.audioMeterLive).toBe(false);
      const ctx = c._audioCtx as FakeAudioContext;
      const n = renders(c);
      ctx.set('running');
      expect(c.audioMeterLive).toBe(true);
      expect(n.count).toBe(1);
      ctx.set('running');
      expect(n.count).toBe(1);
      ctx.set('suspended');
      expect(c.audioMeterLive).toBe(false);
      ctx.set('running');
      c.disconnectRoom();
      expect(c.audioMeterLive).toBe(false);
    });

    it('a running context with a remote stream: true; before any remote audio: false', async () => {
      const waiting = await liveCall({}, { liveKit: { present: [] } });
      expect(waiting.c.audioMeterLive).toBe(false);
      waiting.room.join('op-a');
      expect(waiting.c.audioMeterLive).toBe(true);
    });
  });
});
