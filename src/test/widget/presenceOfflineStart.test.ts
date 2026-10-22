/**
 * A widget that starts while the team is away (`availability.state:
 * 'offline'` from /config) publishes its presence once, like any other
 * start (issue #340, g5-3a; the owner approved the change to `default`):
 *
 *   - the workspace's offline_mode reaches Core, so a new visitor without
 *     the AI and without a thread gets the leave-a-message form
 *     (`capture_message`, the server's default) instead of a composer that
 *     ignored the setting; `show_offline_message` shows the owner's offline
 *     message alone, with no form and no composer (V-10);
 *   - an existing thread and an AI chat keep their composer (the leave-a-
 *     message form owns only a fresh human thread);
 *   - the screen reader's presence label says "away" instead of nothing.
 *
 * Before the fix createPresence() published only when the status differed
 * from the store's initial 'offline', so an offline start never published:
 * the store kept its initial `offlineMode: 'accept_messages'` and an empty
 * label.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot, flush, resetWindow, type BootOptions } from './coreFeaturesHarness';

const runtime = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');

/** The source of `function <name>(…) { … }` in runtime.js (balanced braces). */
function fnSource(name: string): string {
  const start = runtime.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = runtime.indexOf('{', start); i < runtime.length; i++) {
    if (runtime[i] === '{') depth++;
    else if (runtime[i] === '}' && --depth === 0) return runtime.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

type Presence = { status: string; label: string; offlineMode: string; liveChatEnabled: boolean; lastChange: number };
type PresenceApi = { wire: () => void; publish: () => void };

/** createPresence() with runtime.js's initial store, a transport without presence and a key-echo t(). */
function presence(availability: Record<string, unknown>) {
  let state: Presence = { status: 'offline', label: '', offlineMode: 'accept_messages', liveChatEnabled: true, lastChange: 0 };
  const sets: Presence[] = [];
  const store = {
    get: () => state,
    set: (p: Partial<Presence>) => { state = { ...state, ...p }; sets.push(state); },
    subscribe: () => () => {},
  };
  const transport = { hasCapability: () => false, on: () => {} };
  const create = new Function(`${fnSource('createPresence')}; return createPresence;`)() as (
    ctx: unknown, store: unknown, transport: unknown, transportStore: unknown, t: (k: string) => string,
  ) => PresenceApi;
  const api = create({ config: { availability } }, store, transport, {}, (k) => k);
  return { api, sets, state: () => state };
}

describe('createPresence: the first publish always lands, later ticks stay silent', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('offline from the start: the status, its label and the workspace\'s mode', () => {
    const p = presence({ state: 'offline', offline_mode: 'capture_message', labels: { offline: 'Away' } });
    p.api.wire();
    expect(p.sets).toHaveLength(1);
    expect(p.state()).toMatchObject({ status: 'offline', label: 'Away', offlineMode: 'capture_message', liveChatEnabled: true });
    p.api.publish();
    vi.advanceTimersByTime(60_000);
    expect(p.sets).toHaveLength(1);
  });

  it('offline with the platform\'s own words; the legacy mode reads as a capture', () => {
    const p = presence({ state: 'offline', offline_mode: 'contact_fallback' });
    p.api.wire();
    expect(p.state()).toMatchObject({ status: 'offline', label: 'availOffline', offlineMode: 'capture_message' });
  });

  it('an older backend (no server state): its conservative "offline" guess publishes nothing, as before', () => {
    const p = presence({ offline_mode: 'capture_message' });
    p.api.wire();
    expect(p.sets).toHaveLength(0);
    expect(p.state().offlineMode).toBe('accept_messages');
  });

  it('online, unavailable: published once each, as before', () => {
    const on = presence({ state: 'online', offline_mode: 'show_offline_message' });
    on.api.wire();
    on.api.publish();
    expect(on.sets).toHaveLength(1);
    expect(on.state()).toMatchObject({ status: 'online', label: 'availOnline', offlineMode: 'show_offline_message' });
    const off = presence({ state: 'online', liveChatEnabled: false });
    off.api.wire();
    expect(off.state()).toMatchObject({ status: 'unavailable', label: 'availUnavailable', liveChatEnabled: false });
  });
});

// ─── The default template, booted offline ───────────────────────────────────

const AWAY = { state: 'offline', offline_mode: 'capture_message', labels: { offline: 'تیم در دسترس نیست' }, next_open_at: null };

beforeEach(() => { resetWindow(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function chat(opts: BootOptions = {}) {
  const h = boot({ renderer: 'default', ...opts });
  await flush(30);
  h.runtime.setTab('chat');
  await flush(30);
  h.runtime.__test.setConnectionState('online');
  await flush(10);
  return h;
}
const composer = (h: Awaited<ReturnType<typeof chat>>) => h.q<HTMLTextAreaElement>('[data-msg-input]')!;
const inputBar = (h: Awaited<ReturnType<typeof chat>>) => h.q<HTMLElement>('[data-input-bar]')!;
const drewForm = (h: Awaited<ReturnType<typeof chat>>) => h.calls.some((c) => c.surface === 'contactFallbackHtml');

describe('default, the team away at load', () => {
  it('a new visitor without the AI gets the leave-a-message form (capture_message), told the team is away', async () => {
    const h = await chat({ config: { availability: AWAY } });
    expect(drewForm(h)).toBe(true);
    expect(h.q('[data-fb="message"]')).not.toBeNull();
    // The form replaces the chat frame and its composer.
    expect(h.q('[data-input-bar]')).toBeNull();
    expect(h.lastCall('contactFallbackHtml')![3]).toMatchObject({ status: 'offline', label: 'تیم در دسترس نیست', offlineMode: 'capture_message' });
  });

  it('show_offline_message: the owner\'s offline message alone, no form and no composer', async () => {
    const h = await chat({ config: { availability: { ...AWAY, offline_mode: 'show_offline_message', labels: {}, offline_message: 'ساعت ۹ صبح برمی‌گردیم.' } } });
    expect(drewForm(h)).toBe(false);
    expect(inputBar(h).style.display).toBe('none');
    expect(h.q('[data-chat-messages]')!.textContent).toContain('ساعت ۹ صبح برمی‌گردیم.');
    // The workspace's own welcome is untouched for the home view.
    expect((h.env().config as { welcomeMessage?: unknown }).welcomeMessage).not.toBe('ساعت ۹ صبح برمی‌گردیم.');
  });

  it('show_offline_message without a written message: the widget\'s own words, never a form', async () => {
    const h = await chat({ config: { availability: { ...AWAY, offline_mode: 'show_offline_message', labels: {} } } });
    expect(drewForm(h)).toBe(false);
    expect(inputBar(h).style.display).toBe('none');
    expect(h.q('[data-chat-messages]')!.textContent).toContain('در حال حاضر آفلاین هستیم');
  });

  it('capture_message: the owner\'s offline message is the form\'s intro', async () => {
    const h = await chat({ config: { availability: { ...AWAY, offline_message: 'فعلاً در دسترس نیستیم، ساعت ۹ برمی‌گردیم.' } } });
    expect(drewForm(h)).toBe(true);
    expect(h.lastCall('contactFallbackHtml')![3]).toMatchObject({ introLabel: 'فعلاً در دسترس نیستیم، ساعت ۹ برمی‌گردیم.' });
  });

  it('an AI answering away keeps the AI chat and its composer', async () => {
    const h = await chat({
      config: {
        availability: AWAY,
        aiAgent: { visitorFacing: true, providerReady: true, introCapable: false, suppressGreeting: true },
      },
    });
    expect(drewForm(h)).toBe(false);
    expect(composer(h).disabled).toBe(false);
    expect(inputBar(h).style.display).not.toBe('none');
  });

  it('an existing thread keeps its composer', async () => {
    const h = boot({
      renderer: 'default',
      config: { availability: AWAY },
      conversations: [{ id: 'c1' }],
      history: { c1: [{ id: 'm1', role: 'visitor', sender_type: 'contact', text: 'سلام', time: new Date().toISOString(), conversation_id: 'c1' }] },
    });
    await flush(20);
    h.runtime.__test.openConversation('c1');
    await flush(30);
    h.runtime.__test.setConnectionState('online');
    await flush(10);
    expect(drewForm(h)).toBe(false);
    expect(composer(h).disabled).toBe(false);
    expect(inputBar(h).style.display).not.toBe('none');
  });

  it('the team online: nothing changes (the composer, no form)', async () => {
    const h = await chat({ config: { availability: { state: 'online', offline_mode: 'capture_message' } } });
    expect(drewForm(h)).toBe(false);
    expect(composer(h).disabled).toBe(false);
  });

  // The label lives in the chat frame, which Core builds detached and
  // mounts later: it was looked up in the panel, found nothing and stayed
  // empty (issue #340: "the presence label stays empty").
  it('the screen reader\'s presence label says the team is away, still hidden', async () => {
    const h = await chat({ config: { availability: { ...AWAY, offline_mode: 'show_offline_message' } } });
    expect(h.q('[data-presence]')!.className).toBe('presence sr-only status-offline');
    expect(h.q('[data-presence-label]')!.textContent).toBe('تیم در دسترس نیست');
  });
});

describe('default: the presence label follows every change', () => {
  it('online in the opening hours, away after them (the visitor\'s clock, a backend without the server\'s state)', async () => {
    const opening = new Date(2026, 9, 19, 10, 0);
    vi.useFakeTimers({ toFake: ['Date'], now: opening });
    // createPresence's 60 s re-check, run by hand.
    let recheck: (() => void) | null = null;
    const realInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 60_000 && /resolveStatus\(\)|publish\(\)/.test(String(fn))) { recheck = fn; return 0; }
      return realInterval(fn, ms, ...rest);
    }) as unknown as typeof setInterval);
    const h = await chat({
      config: {
        onlineOperators: 1,
        availability: {
          offline_mode: 'show_offline_message',
          businessHours: { enabled: true, timezone: 'UTC', schedule: [{ day: opening.getDay(), open: '09:00', close: '17:00' }] },
          labels: { online: 'در خدمتیم', offline: 'تیم در دسترس نیست' },
        },
      },
    });
    const wrap = h.q('[data-presence]')!;
    const label = h.q('[data-presence-label]')!;
    expect(wrap.className).toBe('presence sr-only status-online');
    expect(label.textContent).toBe('در خدمتیم');
    vi.setSystemTime(new Date(2026, 9, 19, 18, 0));
    recheck!();
    expect(wrap.className).toBe('presence sr-only status-offline');
    expect(label.textContent).toBe('تیم در دسترس نیست');
    // The chat frame stays; with no thread yet, show_offline_message now
    // shows the offline message alone, without the composer.
    expect(h.q('[data-presence-label]')).toBe(label);
    expect(inputBar(h).style.display).toBe('none');
  });
});

describe('a template whose chat header shows the presence line (t1), away at load', () => {
  it('the line says away (it stayed empty), the composer stays open with show_offline_message', async () => {
    const h = await chat({ renderer: 't1', late: 'fail', config: { availability: { ...AWAY, offline_mode: 'show_offline_message', labels: {} } } });
    expect(h.q('[data-chat-header] [data-presence-label]')!.textContent).toBe((h.env().t as (k: string) => string)('availOffline'));
    expect(composer(h).disabled).toBe(false);
  });
});

describe('V-17: the team\'s state is read again while the visitor has the panel open', () => {
  it('every few minutes the server is asked (GET /api/widget/availability); its answer moves the widget from the form to the chat, and the header\'s line with it', async () => {
    const start = new Date(2026, 9, 19, 8, 58);
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    let recheck: (() => void) | null = null;
    const realInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 60_000 && /publish\(\)/.test(String(fn))) { recheck = fn; return 0; }
      return realInterval(fn, ms, ...rest);
    }) as unknown as typeof setInterval);
    const asked: string[] = [];
    const h = await chat({
      config: { availability: AWAY, replyTimeText: null },
      api: (u) => {
        if (!u.includes('/api/widget/availability')) return undefined;
        asked.push(u);
        return { body: { availability: { state: 'online', reason: 'within_hours', offline_mode: 'capture_message', labels: { online: 'در خدمتیم' }, next_open_at: null } } };
      },
    });
    expect(drewForm(h)).toBe(true);
    // A minute on: not yet (the page's own answer is fresh).
    vi.setSystemTime(new Date(start.getTime() + 60_000));
    recheck!();
    await flush(10);
    expect(asked).toEqual([]);
    // Three minutes on, the team opened at 9:00.
    vi.setSystemTime(new Date(start.getTime() + 3 * 60_000 + 1000));
    recheck!();
    await flush(20);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('/api/widget/availability?workspace_id=');
    expect(asked[0]).toContain('&locale=');
    expect(h.q('[data-presence]')!.className).toBe('presence sr-only status-online');
    expect(h.q('[data-presence-label]')!.textContent).toBe('در خدمتیم');
    expect(h.q('[data-fb="message"]')).toBeNull();
    expect(inputBar(h).style.display).not.toBe('none');
    // The chat header carries both reply-time lines; its stylesheet shows the
    // away one while the header's presence says offline (no "replies in a
    // few minutes" over an away team any more).
    const env = h.env().t as (k: string) => string;
    expect(Array.from(h.shadow.querySelectorAll('.wy-head-chat .wy-head-sub')).map((e) => [e.className, e.textContent]))
      .toEqual([['wy-head-sub', env('homeReplyFast')], ['wy-head-sub wy-sub-off', env('homeReplySlow')]]);
  });

  it('a form being filled in is never repainted away under the visitor', async () => {
    const start = new Date(2026, 9, 19, 8, 58);
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    let recheck: (() => void) | null = null;
    const realInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 60_000 && /publish\(\)/.test(String(fn))) { recheck = fn; return 0; }
      return realInterval(fn, ms, ...rest);
    }) as unknown as typeof setInterval);
    const h = await chat({
      config: { availability: AWAY },
      api: (u) => (u.includes('/api/widget/availability')
        ? { body: { availability: { state: 'online', offline_mode: 'capture_message', labels: {}, next_open_at: null } } } : undefined),
    });
    const message = h.q<HTMLTextAreaElement>('[data-fb="message"]')!;
    message.value = 'نیمه‌کاره';
    vi.setSystemTime(new Date(start.getTime() + 4 * 60_000));
    recheck!();
    await flush(20);
    expect(h.q('[data-fb="message"]')).toBe(message);
    expect(message.value).toBe('نیمه‌کاره');
  });
});
