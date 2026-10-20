/**
 * The engine's fixes of the brief's §11 (contract §3: E2–E9 and E21), each
 * driven end to end: the runtime and the presentation in jsdom, a fake server
 * (`fakeApi`, which records every request) and a fake media client
 * (`liveKit`), the ringback observed through the audio facade the engine
 * lends the presentation. Also the round-2 gate's finding: the facade's
 * methods keep working when the presentation calls them on the facade.
 *
 * Timers are faked (the engine polls every 5 s and ticks every second), so a
 * test moves time itself; `settle()` lets the promise chains run.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callRoutes, closeCallWidgets, fakeApi, mountCallWidget, settle,
  type ApiAnswer, type ApiRequest, type CallServerState, type Engine, type MountOptions,
} from './mountCallWidget';

const NOW = Date.parse('2026-10-22T07:30:00Z');
const iso = (t: number) => new Date(t).toISOString();
type Route = (req: ApiRequest) => ApiAnswer | Promise<ApiAnswer> | undefined;

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); });
afterEach(() => { closeCallWidgets(); vi.useRealTimers(); });

/** The engine with a fake server and media client, English, the ringback on. */
function engine(route: Route = () => undefined, opts: MountOptions = {}) {
  const api = fakeApi(route);
  const m = mountCallWidget({
    locale: 'en', now: NOW, liveKit: true, ...opts, fetch: api.fetch,
    bootstrap: { queue_experience: { ringback_enabled: true }, ...opts.bootstrap },
  });
  return { m, api, c: m.ctrl as unknown as Engine };
}

/** A call the visitor had before this page view (bootstrap `active_call`), answered by `s`. */
function resumed(s: CallServerState, opts: MountOptions & { more?: Route; id?: string } = {}) {
  const id = opts.id ?? 'c1';
  return engine(callRoutes(s, opts.more), {
    ...opts,
    bootstrap: {
      active_call: { call_id: id, state: s.state, session: 'S1', call_type: s.type ?? 'audio', created_at: iso(NOW - 60_000), queue_position: s.position ?? null },
      ...opts.bootstrap,
    },
  });
}

/** A promise the test resolves (a request still on its way). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const cancels = (api: ReturnType<typeof fakeApi>) => api.requests.filter((r) => r.method === 'POST' && /\/cancel$/.test(r.path));

describe('E2: skipRating', () => {
  it('leaves the rating without a request and goes home', async () => {
    const { m, api, c } = engine();
    m.open();
    m.set({ state: 'ended', endedCallId: 'c1', endedDuration: 42, ratingSubmitted: false });
    expect(m.screenId()).toBe('rating');
    expect(typeof c.skipRating).toBe('function');
    const before = api.requests.length;
    m.click('[data-screen="rating"] [data-action="rate-skip"]');
    await settle();
    expect(api.requests.length).toBe(before);
    expect(c.state).toBe('online_available');
    expect(c.endedCallId).toBeNull();
  });
});

describe('E3: reset() forgets the last callback (and the call\'s own flags)', () => {
  it('a callback request, then a call: the call ends on the rating, not on "callback scheduled"', async () => {
    const { m, c } = engine((req) => {
      if (req.path === '/api/call-widget/callbacks/request') return { body: { ok: true, callback_id: 'cb-1' } };
      if (req.path === '/api/call-widget/calls/request') return { body: { status: 'queued', call_id: 'c2', session: 'S2', queue_position: 1 } };
      if (req.path === '/api/call-widget/calls/c2/status') return { body: { call: { state: 'ended' } } };
      return undefined;
    });
    m.open();
    c.openCallback();
    c.submitCallback();
    await settle();
    expect(c.callbackId).toBe('cb-1');
    expect(m.screenId()).toBe('scheduled');
    c.reset();
    expect(c.callbackId).toBeNull();
    c.startCall('voice');
    await settle();
    expect(c.state).toBe('ended');
    expect(c.endedCallId).toBe('c2');
    expect(m.screenId()).toBe('rating');
  });

  it('clears cameraDenied, connectionQuality and errorKey; keeps the booked callback', () => {
    const { c } = engine();
    const booking = { callbackId: 'cb-2', scheduled_for: iso(NOW + 86_400_000), channel: 'audio', urgency: 'normal' };
    Object.assign(c, { cameraDenied: true, connectionQuality: 'poor', errorKey: 'err_future_time', callbackBooking: booking });
    c.reset();
    expect(c.cameraDenied).toBe(false);
    expect(c.connectionQuality).toBeNull();
    expect(c.errorKey).toBeNull();
    expect(c.callbackBooking).toEqual(booking);
  });
});

describe('E4: cancelCall() returns a promise and survives a failed answer', () => {
  it('without a call: resolves at once and goes home', async () => {
    const { c } = engine();
    c.state = 'pre_call_form';
    const p = c.cancelCall() as Promise<void>;
    expect(typeof p?.then).toBe('function');
    await p;
    expect(c.state).toBe('online_available');
  });

  it('the cancel never reaches the server: home, no rejection, one retry 1.5 s later with the call\'s own session', async () => {
    const { api, c } = resumed({ state: 'queued', position: 2 }, { more: (req) => (/\/cancel$/.test(req.path) ? 'network' : undefined) });
    await settle();
    expect(c.state).toBe('queue_waiting');
    const p = c.cancelCall() as Promise<void>;
    expect(typeof p?.then).toBe('function');
    await expect(p).resolves.toBeUndefined();
    expect(c.state).toBe('online_available');
    expect(cancels(api)).toHaveLength(1);
    // The visitor starts again at once: the retry still names the old call and its session.
    Object.assign(c, { session: 'S-new' });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(cancels(api)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    const sent = cancels(api);
    expect(sent).toHaveLength(2);
    expect(sent[1].path).toBe('/api/call-widget/calls/c1/cancel');
    expect(sent[1].headers['x-cc-session']).toBe('S1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cancels(api)).toHaveLength(2);
  });

  it('an answer that is not JSON (a proxy\'s 503 page) counts as answered and is retried once', async () => {
    let first = true;
    const { api, c } = resumed({ state: 'queued', position: 2 }, {
      more: (req) => {
        if (!/\/cancel$/.test(req.path)) return undefined;
        const a: ApiAnswer = first ? 'html' : { body: { ok: true } };
        first = false;
        return a;
      },
    });
    await settle();
    await (c.cancelCall() as Promise<void>);
    expect(c.state).toBe('online_available');
    await vi.advanceTimersByTimeAsync(1_500);
    await settle();
    expect(cancels(api)).toHaveLength(2);
  });

  it('an answered cancel of a connected call ends on the rating and is not sent again', async () => {
    const { m, api, c } = resumed({ state: 'active', agent: 'A', name: 'Sara', startedAt: iso(NOW - 134_000) }, { liveKit: { present: ['op-a'] } });
    await settle();
    m.loadLinks();
    expect(c.callStartedAt).toBe(NOW - 134_000);
    await (c.cancelCall() as Promise<void>);
    expect(c.state).toBe('ended');
    expect(c.endedCallId).toBe('c1');
    expect(c.endedDuration).toBe(134);
    expect(m.screenId()).toBe('rating');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cancels(api)).toHaveLength(1);
  });

  it('a second press while the cancel is on its way leaves at once and sends nothing more', async () => {
    const answer = deferred<ApiAnswer>();
    const restart = deferred<ApiAnswer>();
    const { api, c } = resumed({ state: 'queued', position: 2 }, {
      more: (req) => (/\/cancel$/.test(req.path) ? answer.promise : /\/calls\/request$/.test(req.path) ? restart.promise : undefined),
    });
    await settle();
    const p1 = c.cancelCall() as Promise<void>;
    expect(c.state).toBe('queue_waiting');
    const p2 = c.cancelCall() as Promise<void>;
    expect(c.state).toBe('online_available');
    await p2;
    expect(cancels(api)).toHaveLength(1);
    // The visitor starts again before the first answer: it changes nothing.
    c.startCall('voice');
    expect(c.state).toBe('loading');
    answer.resolve({ body: { ok: true } });
    await p1;
    expect(c.state).toBe('loading');
    expect(cancels(api)).toHaveLength(1);
  });

  it('a second press on a connected call leaves for its rating at once', async () => {
    const answer = deferred<ApiAnswer>();
    const { api, c } = resumed({ state: 'active', agent: 'A', name: 'Sara', startedAt: iso(NOW - 134_000) }, {
      liveKit: { present: ['op-a'] },
      more: (req) => (/\/cancel$/.test(req.path) ? answer.promise : undefined),
    });
    await settle();
    void c.cancelCall();
    expect(c.state).toBe('in_call');
    await (c.cancelCall() as Promise<void>);
    expect(c.state).toBe('ended');
    expect(c.endedCallId).toBe('c1');
    expect(c.endedDuration).toBe(134);
    answer.resolve({ body: { ok: true } });
    await settle();
    expect(c.state).toBe('ended');
    expect(cancels(api)).toHaveLength(1);
  });

  it('the hung-up room\'s late events change nothing on the widget', async () => {
    const { m, c } = resumed({ state: 'active', agent: 'A', name: 'Sara' }, { liveKit: { present: ['op-a'] } });
    await settle();
    expect(c.connectStatus).toBe('in_call');
    const room = m.lk!.room();
    await (c.cancelCall() as Promise<void>);
    await settle();
    expect(room.disconnected).toBe(true);
    // LiveKit says "disconnected" after the hang-up; then the operator's leave arrives.
    room.emit('participantDisconnected', {});
    room.emit('connectionQualityChanged', 'poor', room.localParticipant);
    expect(c.connectStatus).toBeNull();
    expect(c.connectionQuality ?? null).toBeNull();
  });
});

describe('E5: the queue\'s callback offer opens the form once the cancel has answered', () => {
  it('the form comes after the cancel answer, and nothing resets it afterwards', async () => {
    const answer = deferred<ApiAnswer>();
    const { m, api, c } = resumed({ state: 'queued', position: 3 }, {
      bootstrap: { queue_experience: { ringback_enabled: true, offer_callback_after_seconds: 30 } },
      more: (req) => (/\/cancel$/.test(req.path) ? answer.promise : undefined),
    });
    await settle();
    m.loadLinks();
    expect(m.screenId()).toBe('queue');
    const offer = m.q('[data-screen="queue"] [data-action="offer-callback"]')!;
    expect(offer.closest('.offer')!.hasAttribute('hidden')).toBe(false);
    offer.click();
    await settle();
    expect(cancels(api)).toHaveLength(1);
    expect(c.state).not.toBe('callback_form');
    answer.resolve({ body: { ok: true } });
    await settle();
    expect(c.state).toBe('callback_form');
    expect(m.screenId()).toBe('callback');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(c.state).toBe('callback_form');
  });
});

describe('E6: the ring stops once the operator is in the room', () => {
  it('a resumed call rings until the operator joins', async () => {
    const { m, c } = resumed({ state: 'active', agent: 'A', name: 'Sara' });
    await settle();
    expect(c.connectStatus).toBe('waiting_for_operator');
    expect(m.context().audio.isActive()).toBe(true);
    m.lk!.room().join('op-a');
    expect(c.connectStatus).toBe('operator_connected');
    expect(m.context().audio.isActive()).toBe(false);
  });

  it('an operator already in the room when the visitor connects stops it at once', async () => {
    const { m, c } = resumed({ state: 'active', agent: 'A', name: 'Sara' }, { liveKit: { present: ['op-a'] } });
    await settle();
    expect(c.connectStatus).toBe('in_call');
    expect(m.context().audio.isActive()).toBe(false);
  });

  it('a polled call state does not start ringing again once the operator is in', async () => {
    const { m, c } = resumed({ state: 'active', agent: 'A', name: 'Sara' }, { liveKit: { present: ['op-a'] } });
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(c.state).toBe('in_call');
    expect(m.context().audio.isActive()).toBe(false);
  });

  it('the transfer hold plays until the next operator joins', async () => {
    const s: CallServerState = { state: 'active', agent: 'A', name: 'Sara' };
    const { m, c } = resumed(s, { liveKit: { present: ['op-a'] } });
    await settle();
    Object.assign(s, { agent: 'B', name: 'Reza' });
    c.pollOnce();
    await settle();
    expect(c.transferring).toBe(true);
    expect(m.context().audio.isActive()).toBe(true);
    m.lk!.room().leave('op-a');
    m.lk!.room().join('op-b');
    expect(c.transferring).toBe(false);
    expect(m.context().audio.isActive()).toBe(false);
  });
});

describe('E7: a refused camera keeps the call going with the microphone', () => {
  it('cameraDenied, the microphone on, the operator detected, the mute control drawn', async () => {
    const { m, c } = resumed({ state: 'active', type: 'video', agent: 'A', name: 'Sara' }, { liveKit: { camDenials: 1, present: ['op-a'] } });
    await settle();
    m.loadLinks();
    expect(c.cameraDenied).toBe(true);
    expect(c.error).toBe(c.t('camera_denied'));
    expect(c.micOn).toBe(true);
    expect(c.camOn).toBe(false);
    expect(c.connectStatus).toBe('in_call');
    expect(m.lk!.room().localParticipant.micCalls).toEqual([true]);
    expect(m.screenId()).toBe('video');
    expect(m.q('.scr.on [data-action="mute"]')).not.toBeNull();
    expect(m.q('.scr.on .bnr')!.hasAttribute('hidden')).toBe(false);
  });

  it('without an operator yet: waiting for one, not stuck', async () => {
    const { c } = resumed({ state: 'active', type: 'video', agent: 'A', name: 'Sara' }, { liveKit: { camDenials: 1 } });
    await settle();
    expect(c.cameraDenied).toBe(true);
    expect(c.connectStatus).toBe('waiting_for_operator');
  });

  it('turning the camera on later clears it', async () => {
    const { c } = resumed({ state: 'active', type: 'video', agent: 'A', name: 'Sara' }, { liveKit: { camDenials: 1, present: ['op-a'] } });
    await settle();
    c.toggleCam();
    await settle();
    expect(c.camOn).toBe(true);
    expect(c.cameraDenied).toBe(false);
    expect(c.error).toBeNull();
  });
});

describe('E8: a workspace\'s text is used only in its own language', () => {
  it('an English override does not leak into Persian or Turkish', () => {
    const custom = { config: { custom_texts: { en: { talk_now: 'Ring us', live_support: 'Help desk' }, fa: { live_support: 'پشتیبان ما' } } } };
    for (const [locale, talk, live] of [
      ['en', 'Ring us', 'Help desk'],
      ['fa', 'همین حالا تماس بگیرید', 'پشتیبان ما'],
      ['tr', 'Şimdi konuş', 'Canlı destek'],
    ] as const) {
      const { c } = engine(undefined, { locale, bootstrap: custom });
      expect(c.t('talk_now'), locale).toBe(talk);
      expect(c.t('live_support'), locale).toBe(live);
    }
  });
});

describe('E9: a media server without the v1 path', () => {
  it('has its own title in every language', () => {
    for (const [locale, title] of [['en', 'Calls can\'t connect right now'], ['fa', 'فعلاً امکان برقراری تماس نیست'], ['tr', 'Arama şu anda bağlanamıyor']] as const) {
      expect(engine(undefined, { locale }).c.t('rtc_unsupported')).toBe(title);
    }
  });

  it('a room that refuses the client shows the failure screen with it and the engine\'s reason', async () => {
    const { m, c } = resumed({ state: 'active', agent: 'A', name: 'Sara' }, { liveKit: { connectError: 'could not establish signal connection: v1 RTC path not found' } });
    await settle();
    m.loadLinks();
    expect(c.connectStatus).toBe('rtc_v1_unsupported');
    expect(c.error).toBe(c.t('err_media_rtc_v1'));
    expect(m.screenId()).toBe('fail');
    expect(m.q('[data-screen="fail"] .sh')!.textContent).toBe('Calls can\'t connect right now');
  });
});

describe('E21: Cancel while the start request is on its way', () => {
  function starting(more?: Route) {
    const start = deferred<ApiAnswer>();
    const env = engine((req) => (req.path === '/api/call-widget/calls/request' ? start.promise : callRoutes({ state: 'queued' }, more)(req)));
    env.m.open();
    env.c.startCall('voice');
    return { ...env, start };
  }

  it('home at once; the answer\'s call is cancelled with its own session; no queue, no ring, no poll', async () => {
    const { m, api, c, start } = starting();
    expect(c.state).toBe('loading');
    expect(m.context().audio.isActive()).toBe(true);
    await (c.cancelCall() as Promise<void>);
    expect(c.state).toBe('online_available');
    expect(m.context().audio.isActive()).toBe(false);
    start.resolve({ body: { status: 'queued', call_id: 'c7', session: 'S7', queue_position: 3 } });
    await settle();
    expect(c.state).toBe('online_available');
    expect(c.callId).toBeNull();
    const sent = cancels(api);
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe('/api/call-widget/calls/c7/cancel');
    expect(sent[0].headers['x-cc-session']).toBe('S7');
    expect(m.context().audio.isActive()).toBe(false);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(api.log().filter((r) => r.includes('/status'))).toEqual([]);
    expect(c.state).toBe('online_available');
  });

  it('a start that then fails says nothing: the visitor already left', async () => {
    const { c, start } = starting();
    await (c.cancelCall() as Promise<void>);
    start.resolve('network');
    await settle();
    expect(c.state).toBe('online_available');
    expect(c.error).toBeNull();
  });

  it('that cancel, when it fails, is sent once more 1.5 s later (E4: no server reaps an abandoned queued call)', async () => {
    let refused = true;
    const { api, c, start } = starting((req) => {
      if (!/\/cancel$/.test(req.path)) return undefined;
      const a: ApiAnswer = refused ? 'network' : { body: { ok: true } };
      refused = false;
      return a;
    });
    await (c.cancelCall() as Promise<void>);
    start.resolve({ body: { status: 'queued', call_id: 'c8', session: 'S8', queue_position: 1 } });
    await settle();
    expect(cancels(api)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    await settle();
    const sent = cancels(api);
    expect(sent).toHaveLength(2);
    expect(sent[1].path).toBe('/api/call-widget/calls/c8/cancel');
    expect(sent[1].headers['x-cc-session']).toBe('S8');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cancels(api)).toHaveLength(2);
    expect(c.state).toBe('online_available');
  });
});

describe('the audio facade (round-2 gate)', () => {
  it('its methods work when called on the facade (the sound toggle starts the ring from the click)', () => {
    const { m } = engine();
    const audio = m.context().audio;
    expect(() => audio.startFromGesture({ ringback_enabled: true })).not.toThrow();
    expect(audio.isActive()).toBe(true);
    audio.setMuted(true);
    expect(audio.isMuted()).toBe(true);
  });
});

describe('as each brand ships the engine (minified, kits stripped)', () => {
  it.each(['iran', 'respok'] as const)('%s: the cancel\'s promise and retry, a transfer until the next operator joins', async (brand) => {
    const s: CallServerState = { state: 'active', agent: 'A', name: 'Sara' };
    let refused = true;
    const { m, api, c } = resumed(s, {
      shipped: brand,
      liveKit: { present: ['op-a'] },
      more: (req) => {
        if (!/\/cancel$/.test(req.path)) return undefined;
        const a: ApiAnswer = refused ? 'network' : { body: { ok: true } };
        refused = false;
        return a;
      },
    });
    await settle();
    Object.assign(s, { agent: 'B', name: 'Reza' });
    c.pollOnce();
    await settle();
    expect(c.transferring).toBe(true);
    m.lk!.room().leave('op-a');
    expect(c.connectStatus).toBe('in_call');
    m.lk!.room().join('op-b');
    expect(c.transferring).toBe(false);
    expect(c.operatorName).toBe('Reza');
    await (c.cancelCall() as Promise<void>);
    expect(c.state).toBe('online_available');
    await vi.advanceTimersByTimeAsync(1_500);
    await settle();
    expect(cancels(api)).toHaveLength(2);
    expect(() => m.context().audio.startFromGesture({ ringback_enabled: true })).not.toThrow();
  }, 30_000);
});
