/**
 * The call widget's behaviour in a real browser (build contract 00-contract
 * §8.4): the live widget through the real l.js on a customer's page, the
 * real engine (runtime.js) against an in-memory call server and a fake
 * LiveKit room (e2e/harness/callSession.ts), media as real <video>/<audio>
 * elements. Numbers in the test titles are §8.4's items:
 *
 *   1 no rebuild per tick          6 reduced motion           11 the §11 fixes with media
 *   2 minimise and restore         7 digits, dates, no emoji  12 docks in view, short screens
 *   3 forms                        8 network and fonts        13 transfer (E19)
 *   4 the ring's sound toggle      9 phones                   14 an outcome while minimised (D35)
 *   5 accessibility               10 the lazy panel           15 accessibility extras
 *
 * Local gate (not in CI): npx playwright test e2e/callWidgetBehaviour.spec.ts --workers=1
 * Every test ends with no page error, no console error and no request to a
 * host other than the store and the platform.
 */
import { test, expect, type Browser } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  ACTIVE_SESSION_KEY, openCallSession, openFixtureState,
  type CallSession, type CallWin, type ServerCall, type SessionOptions,
} from './harness/callSession';
import { buildCallWidgetScratch } from './harness/callScreens';
import {
  BRANDS, CALL_ID, DEMO, PIXEL_KINDS, callStates, frozenNow, type Brand,
} from './harness/callScreensFixture';
import { resolveCallChromium } from './harness/callReference';

test.use({
  launchOptions: {
    executablePath: resolveCallChromium(),
    // The ring and the operator's voice play without a gesture (the engine's Ringback, the fake room's tracks).
    args: ['--autoplay-policy=no-user-gesture-required'],
  },
});

const ROOT = process.cwd();
const CALL_AGO_MS = 134_000;

// ─── sessions ────────────────────────────────────────────────────────────
/**
 * Runs `fn` on a fresh session; the page must end without errors or foreign
 * requests (`expected`: console errors the test causes on purpose, such as
 * the browser's own line for a file it answered 404).
 */
async function withSession(browser: Browser, opts: SessionOptions, fn: (s: CallSession) => Promise<void>, expected?: RegExp): Promise<void> {
  const s = await openCallSession(browser, opts);
  try {
    await fn(s);
    expect(s.log.errors.filter((e) => !expected || !expected.test(e)), 'page errors and console errors').toEqual([]);
    expect(s.log.foreign, 'requests to other hosts').toEqual([]);
  } finally {
    await s.close();
  }
}

const iso = (brand: Brand, agoMs: number) => new Date(frozenNow(brand) - agoMs).toISOString();

/** A call in progress the page resumes (bootstrap.active_call), its operator already in the room. */
function inCall(brand: Brand, type: 'voice' | 'video', more: Partial<SessionOptions> = {}): SessionOptions {
  const call: ServerCall = {
    state: 'active', call_type: type, agent: 'ref-a', name: DEMO[brand].operatorName, started_at: iso(brand, CALL_AGO_MS),
    position: null, eta: null, recording_state: 'recording',
  };
  return {
    brand,
    boot: { active_call: { call_id: CALL_ID, session: 'sess-call', call_type: type, state: 'active', created_at: iso(brand, CALL_AGO_MS + 30_000) } },
    sessionStorage: { [ACTIVE_SESSION_KEY]: 'sess-call' },
    liveKit: { present: [{ id: 'op-a', video: type === 'video' }] },
    call,
    ...more,
  };
}

/** A queued call the page resumes, `position` in line. */
function inQueue(brand: Brand, position: number, more: Partial<SessionOptions> = {}): SessionOptions {
  return {
    brand,
    boot: { active_call: { call_id: CALL_ID, session: 'sess-call', call_type: 'voice', state: 'queued', created_at: iso(brand, 47_000), queue_position: position } },
    sessionStorage: { [ACTIVE_SESSION_KEY]: 'sess-call' },
    liveKit: { present: [] },
    call: { state: 'queued', call_type: 'voice', agent: null, name: null, started_at: null, position, eta: 60 * position, recording_state: null },
    ...more,
  };
}

/** Until the live call screen shows with its media playing. */
async function live(s: CallSession, screen: 'voice' | 'video'): Promise<void> {
  await s.waitScreen(screen, 10_000);
  await s.page.waitForFunction((want) => {
    const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
    const audio = sr.querySelector('.ccw-media audio') as HTMLAudioElement | null;
    if (!audio || audio.paused) return false;
    if (want !== 'video') return true;
    const v = sr.querySelector('.scr.on .feed video') as HTMLVideoElement | null;
    const me = sr.querySelector('.scr.on .pip video') as HTMLVideoElement | null;
    return !!v && !v.paused && v.readyState >= 2 && !!me && !me.paused;
  }, screen, { timeout: 10_000 });
}

/** The panel's minimise button (the header's; the dock has one too). */
async function minimise(s: CallSession): Promise<void> {
  await s.w('.scr.on [data-action=minimize]').first().click();
  await s.waitOpen(false);
}

/** Clicks the launcher (any style) the way a visitor does. */
async function clickLauncher(s: CallSession): Promise<void> {
  await s.w('.ccw-launcher-wrap .ccw-launcher-btn').first().click();
}

// ─── 1 · no rebuild per tick ─────────────────────────────────────────────
interface TickReport {
  sameScreen: boolean; nodesKept: number; nodesLost: number; removed: string[]; focusKept: boolean; focused: string;
  infinite: number; animsKept: number; animsAdvanced: number; timerBefore: string | null; timerAfter: string | null;
  media: Array<{ tag: string; same: boolean; playing: boolean; advanced: boolean; transform: string; mark: string }>;
}

/** Records the panel, lets five seconds of ticks pass (page.clock), and reports what changed. */
async function fiveTicks(s: CallSession, focusSel: string): Promise<TickReport> {
  await s.page.evaluate((sel) => {
    const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
    const panel = sr.querySelector('.ccw-panel')!;
    const scr = panel.querySelector('.scr.on')!;
    const removed: string[] = [];
    const mo = new MutationObserver((ms) => {
      for (const m of ms) m.removedNodes.forEach((n) => removed.push(`${n.nodeName} from ${(m.target as Element).className || m.target.nodeName}`));
    });
    mo.observe(panel, { childList: true, subtree: true });
    (scr.querySelector(sel) as HTMLElement | null)?.focus();
    const anims = sr.getAnimations().filter((a) => a.effect?.getTiming().iterations === Infinity);
    const media = [...sr.querySelectorAll('video, audio')] as HTMLMediaElement[];
    (window as unknown as { __tick: unknown }).__tick = {
      mo, removed, scr, nodes: [...scr.querySelectorAll('*')], focus: sr.activeElement, anims,
      times: anims.map((a) => Number(a.currentTime) || 0), media, mediaTimes: media.map((m) => m.currentTime),
      timer: scr.querySelector('[role=timer], .vtop .num')?.textContent ?? null,
    };
  }, focusSel);
  await s.page.clock.runFor(5_000);
  await s.page.waitForTimeout(500);
  return s.page.evaluate(() => {
    const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
    const T = (window as unknown as { __tick: {
      mo: MutationObserver; removed: string[]; scr: Element; nodes: Element[]; focus: Element | null; anims: Animation[];
      times: number[]; media: HTMLMediaElement[]; mediaTimes: number[]; timer: string | null;
    } }).__tick;
    T.mo.disconnect();
    const now = sr.getAnimations();
    const kept = T.nodes.filter((n) => n.isConnected && T.scr.contains(n)).length;
    return {
      sameScreen: sr.querySelector('.ccw-panel .scr.on') === T.scr,
      nodesKept: kept, nodesLost: T.nodes.length - kept, removed: T.removed.slice(0, 8),
      focusKept: !!T.focus && sr.activeElement === T.focus, focused: T.focus ? `${T.focus.nodeName}[data-action=${T.focus.getAttribute('data-action')}]` : 'none',
      infinite: T.anims.length,
      animsKept: T.anims.filter((a) => now.includes(a) && a.playState === 'running').length,
      animsAdvanced: T.anims.filter((a, i) => (Number(a.currentTime) || 0) > T.times[i]).length,
      timerBefore: T.timer, timerAfter: T.scr.querySelector('[role=timer], .vtop .num')?.textContent ?? null,
      media: T.media.map((m, i) => ({
        tag: m.tagName.toLowerCase() + (m.hasAttribute('data-local-video') ? '.self' : m.hasAttribute('data-remote-video') ? '.remote' : ''),
        same: m.isConnected && sr.contains(m), playing: !m.paused, advanced: m.currentTime > T.mediaTimes[i],
        transform: getComputedStyle(m).transform,
        mark: [m.getAttribute('data-track-sid') ? 'sid' : 'no-sid', m.getAttribute('data-orientation-correction') || ''].join(' '),
      })),
    };
  });
}

function expectNoRebuild(r: TickReport, label: string): void {
  expect(r.sameScreen, `${label}: the same screen element`).toBe(true);
  expect(r.nodesLost, `${label}: nodes replaced by a tick`).toBe(0);
  expect(r.removed, `${label}: childList removals under .ccw-panel`).toEqual([]);
  expect(r.focusKept, `${label}: focus kept on ${r.focused}`).toBe(true);
  expect(r.timerAfter, `${label}: the timer ticked in place`).not.toBe(r.timerBefore);
  expect(r.infinite, `${label}: running animations to follow`).toBeGreaterThan(0);
  expect(r.animsKept, `${label}: the same Animation objects`).toBe(r.infinite);
  expect(r.animsAdvanced, `${label}: animations advancing`).toBe(r.infinite);
  for (const m of r.media) {
    expect(m.same, `${label}: ${m.tag} still in the widget`).toBe(true);
    expect(m.playing, `${label}: ${m.tag} still playing`).toBe(true);
  }
}

for (const brand of BRANDS) {
  test.describe(`${brand}: 1 no rebuild per tick`, () => {
    test('queue', async ({ browser }) => {
      await withSession(browser, { ...inQueue(brand, 3), motion: true }, async (s) => {
        await s.waitScreen('queue');
        await s.page.waitForFunction(() => !!document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-root.ccw-is-open'));
        expectNoRebuild(await fiveTicks(s, '[data-action=sound]'), 'queue');
      });
    });

    test('voice call: nodes, focus, animations, the remote audio', async ({ browser }) => {
      await withSession(browser, { ...inCall(brand, 'voice'), motion: true }, async (s) => {
        await live(s, 'voice');
        const r = await fiveTicks(s, '[data-action=mute]');
        expectNoRebuild(r, 'voice');
        expect(r.media.map((m) => m.tag)).toEqual(['audio']);
      });
    });

    test('video call: the same videos playing, the operator never mirrored, the self-view mirrored', async ({ browser }) => {
      await withSession(browser, { ...inCall(brand, 'video'), motion: true }, async (s) => {
        await live(s, 'video');
        const r = await fiveTicks(s, '[data-action=mute]');
        expect(r.sameScreen && r.nodesLost === 0 && r.focusKept, JSON.stringify(r)).toBe(true);
        expect(r.removed).toEqual([]);
        expect(r.timerAfter).not.toBe(r.timerBefore);
        const remote = r.media.find((m) => m.tag === 'video.remote')!;
        const self = r.media.find((m) => m.tag === 'video.self')!;
        expect(remote, 'the operator\'s video').toBeTruthy();
        expect(self, 'the self-view').toBeTruthy();
        for (const m of [remote, self]) expect([m.same, m.playing, m.advanced], `${m.tag}: kept, playing, advancing`).toEqual([true, true, true]);
        expect(remote.transform, 'remote not mirrored').toBe('none');
        expect(self.transform, 'self-view mirrored').toBe('matrix(-1, 0, 0, 1, 0, 0)');
        expect(self.mark).toBe('sid scaleX(-1)');
        expect(remote.mark).toBe('sid ');
      });
    });
  });
}

// ─── 2 · minimise and restore ────────────────────────────────────────────
test.describe('2 minimise and restore', () => {
  test('queue: Se with the place in line, restored to the queue, nothing cancelled, the ring goes on', async ({ browser }) => {
    await withSession(browser, inQueue('webyar', 3), async (s) => {
      await s.waitScreen('queue');
      await minimise(s);
      await expect(s.w('.ccw-launcher-wrap .mc')).toBeVisible();
      await expect(s.w('.ccw-launcher-wrap .mc b')).toHaveText('نفر ۳ صف');
      expect((await s.audio()).active, 'the hold ring plays on while minimised').toBe(true);
      await s.w('.ccw-launcher-wrap [data-action=restore]').click();
      await s.waitOpen(true);
      expect(await s.screen()).toBe('queue');
      expect(s.server.calls('POST', /\/cancel$/), 'no cancel').toEqual([]);
      expect(await s.field('state')).toBe('queue_waiting');
    });
  });

  test('voice call: Sf mutes and the same audio plays; restored on the call screen still muted', async ({ browser }) => {
    await withSession(browser, inCall('webyar', 'voice'), async (s) => {
      await live(s, 'voice');
      await s.page.evaluate(() => { (window as unknown as { __a: unknown }).__a = document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-media audio'); });
      await minimise(s);
      const bar = s.w('.ccw-launcher-wrap .mc');
      await expect(bar).toBeVisible();
      await expect(bar.locator('b')).toHaveText(DEMO.webyar.operatorFirst);
      await bar.locator('[data-action=mute]').click();
      await expect(bar.locator('[data-action=mute]')).toHaveAttribute('aria-pressed', 'true');
      expect(await s.field('micOn')).toBe(false);
      await bar.locator('[data-action=restore]').click();
      await s.waitOpen(true);
      expect(await s.screen()).toBe('voice');
      await expect(s.w('.scr.on .dock [data-action=mute]')).toHaveAttribute('aria-pressed', 'true');
      const same = await s.page.evaluate(() => {
        const a = document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-media audio') as HTMLAudioElement;
        return a === (window as unknown as { __a: unknown }).__a && !a.paused;
      });
      expect(same, 'the same remote audio, playing').toBe(true);
      expect(s.server.calls('POST', /\/cancel$/), 'no cancel').toEqual([]);
      const room = await s.page.evaluate(() => (window as unknown as CallWin).__lk.room()!.micCalls);
      expect(room, 'the microphone switched off once, from the bar').toEqual([true, false]);
    });
  });

  test('video call: Sg holds the same playing video; restored, it is back in the feed', async ({ browser }) => {
    await withSession(browser, inCall('webyar', 'video'), async (s) => {
      await live(s, 'video');
      await s.page.evaluate(() => { (window as unknown as { __v: unknown }).__v = document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.scr.on .feed video'); });
      await s.w('.scr.on .vdock [data-action=minimize]').click();
      await s.waitOpen(false);
      await expect(s.w('.ccw-launcher-wrap .mvid')).toBeVisible();
      const inBar = await s.page.evaluate(() => {
        const v = document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-launcher-wrap .mvid .feed video') as HTMLVideoElement;
        return { same: v === (window as unknown as { __v: unknown }).__v, playing: !!v && !v.paused };
      });
      expect(inBar).toEqual({ same: true, playing: true });
      await s.w('.ccw-launcher-wrap .mvid [data-action=restore]').click();
      await s.waitOpen(true);
      expect(await s.screen()).toBe('video');
      const back = await s.page.evaluate(() => {
        const v = document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.scr.on .feed video') as HTMLVideoElement;
        return { same: v === (window as unknown as { __v: unknown }).__v, playing: !!v && !v.paused };
      });
      expect(back).toEqual({ same: true, playing: true });
      expect(s.server.calls('POST', /\/cancel$/)).toEqual([]);
    });
  });

  test('startCall runs inside the click: the home tiles, the split launcher\'s halves, the phone\'s bottom bar', async ({ browser }) => {
    for (const style of ['round_label', 'split', 'mobile_bar']) {
      await withSession(browser, { brand: 'webyar', mobile: style === 'mobile_bar', boot: { config: { launcher_style: style } } }, async (s) => {
        await s.page.evaluate(() => {
          const c = (window as unknown as CallWin).CallCenterWidget as unknown as Record<string, unknown> & { startCall: (t: string) => void };
          const real = c.startCall;
          const seen: Array<{ type: string; inClick: boolean }> = [];
          // Inside a click's dispatch: from its capture on the document to its bubble on the window
          // (window.event is undefined for a target in a shadow tree).
          let inClick = false;
          document.addEventListener('click', () => { inClick = true; setTimeout(() => { inClick = false; }, 0); }, true);
          window.addEventListener('click', () => { inClick = false; });
          (window as unknown as { __starts: unknown }).__starts = seen;
          c.startCall = function (t: string) {
            seen.push({ type: t, inClick: inClick && navigator.userActivation.isActive });
            return real.call(this, t);
          };
        });
        if (style === 'split') await s.w('.ccw-launcher-wrap .ln-s [data-action=video]').click();
        else if (style === 'mobile_bar') await s.w('.ccw-launcher-wrap .mbar [data-action=voice]').click();
        else {
          await clickLauncher(s);
          await s.waitOpen(true);
          await s.w('.scr.on [data-action=voice]').click();
        }
        const starts = await s.page.evaluate(() => (window as unknown as { __starts: unknown }).__starts);
        expect(starts, style).toEqual([{ type: style === 'split' ? 'video' : 'voice', inClick: true }]);
      });
    }
  });
});

// ─── 3 · forms ───────────────────────────────────────────────────────────
test.describe('3 forms', () => {
  const schema = [
    { id: 'name', label: 'نام', type: 'text', required: true },
    { id: 'order_no', label: 'شماره سفارش', type: 'text', required: true },
    { id: 'note', label: 'توضیح', type: 'textarea', required: false },
  ];

  test('pre-call form: required markers, button types, submit through the form, the error slot names the field', async ({ browser }) => {
    await withSession(browser, { brand: 'webyar', boot: { config: { pre_call_form_schema: schema } } }, async (s) => {
      await s.open();
      await s.w('.scr.on [data-action=voice]').click();
      await s.waitScreen('precall');
      const marks = await s.page.evaluate(() => [...document.getElementById('call-center-widget-host')!.shadowRoot!.querySelectorAll('.scr.on label')]
        .map((l) => [l.textContent!.replace(/\s+/g, ' ').trim(), !!l.querySelector('i')]));
      expect(marks).toEqual([['نام *', true], ['شماره سفارش *', true], ['توضیح', false]]);
      const types = await s.page.evaluate(() => {
        const panel = document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-panel')!;
        return [...panel.querySelectorAll('button')].map((b) => `${b.getAttribute('data-action')}:${b.type}:${!!b.closest('form')}`)
          .filter((x) => x.includes(':submit:'));
      });
      expect(types, 'the only submit button is the form\'s own').toEqual(['submit:submit:true']);
      await s.w('.scr.on [data-action=consent]').click();
      await s.w('.scr.on input').first().fill('علی');
      // Enter in a field submits through the <form> (the engine validates the schema).
      await s.w('.scr.on input').first().press('Enter');
      const err = s.w('.scr.on p.msg.err[role=alert][data-error]');
      await expect(err).toBeVisible();
      await expect(err).toContainText('شماره سفارش');
      const bad = await s.page.evaluate(() => {
        const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
        const slot = sr.querySelector('.scr.on p.msg.err')!;
        return [...sr.querySelectorAll('.scr.on input')].map((i) => [i.getAttribute('aria-invalid'), i.getAttribute('aria-describedby') === slot.id]);
      });
      expect(bad, 'only the field the error names is marked').toEqual([[null, false], ['true', true]]);
      expect(s.server.calls('POST', /\/calls\/request$/), 'nothing sent').toEqual([]);
    });
  });

  test('callback form: the honeypot off screen (never display:none), submit through the form, the time trap sent', async ({ browser }) => {
    await withSession(browser, { brand: 'webyar' }, async (s) => {
      await s.open();
      await s.w('.scr.on [data-action=callback]').click();
      await s.waitScreen('callback');
      await s.w('.scr.on [data-action=continue]').click();
      const hp = await s.page.evaluate(() => {
        const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
        const i = sr.querySelector('.scr.on input[name=company_website]') as HTMLInputElement | null;
        if (!i) return null;
        const r = i.getBoundingClientRect();
        return {
          attrs: [i.tabIndex, i.getAttribute('aria-hidden'), i.getAttribute('autocomplete'), i.type],
          display: getComputedStyle(i).display,
          offScreen: r.right <= 0 || r.left >= innerWidth || r.bottom <= 0 || r.top >= innerHeight,
          inForm: !!i.closest('form'),
        };
      });
      expect(hp).toEqual({ attrs: [-1, 'true', 'off', 'text'], display: expect.not.stringMatching(/^none$/), offScreen: true, inForm: true });
      // Contact required: the error slot first, then a real submit.
      await s.w('.scr.on [data-action=submit]').click();
      await expect(s.w('.scr.on p.msg.err[role=alert][data-error]')).toBeVisible();
      expect(s.server.calls('POST', /\/callbacks\/request$/)).toEqual([]);
      await s.w('.scr.on input[type=tel]').fill('09121234567');
      await s.w('.scr.on input[type=tel]').press('Enter');
      await s.waitScreen('scheduled');
      const sent = s.server.calls('POST', /\/callbacks\/request$/);
      expect(sent.length, 'one request').toBe(1);
      const body = sent[0].body as Record<string, unknown>;
      expect(body.hp_company).toBe('');
      expect(typeof body.form_opened_at, 'the time trap').toBe('number');
    });
  });
});

// ─── 4 · the ring's sound toggle ─────────────────────────────────────────
test.describe('4 the ring\'s sound toggle', () => {
  test('mutes and unmutes the real ring; the click never reaches the page', async ({ browser }) => {
    await withSession(browser, inQueue('webyar', 3), async (s) => {
      await s.waitScreen('queue');
      expect((await s.audio()).active).toBe(true);
      await s.page.evaluate(() => {
        const root = document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-root')!;
        (window as unknown as { __bubbled: number }).__bubbled = 0;
        root.addEventListener('click', () => { (window as unknown as { __bubbled: number }).__bubbled++; });
      });
      const b = s.w('.scr.on .dock [data-action=sound]');
      await expect(b).toHaveAttribute('aria-pressed', 'false');
      const on = await b.getAttribute('aria-label');
      await b.click();
      expect((await s.audio()).muted).toBe(true);
      await expect(b).toHaveAttribute('aria-pressed', 'true');
      expect(await b.getAttribute('aria-label')).not.toBe(on);
      await b.click();
      expect((await s.audio()).muted).toBe(false);
      await expect(b).toHaveAttribute('aria-pressed', 'false');
      expect(await s.page.evaluate(() => (window as unknown as { __bubbled: number }).__bubbled), 'stopPropagation').toBe(0);
    });
  });

  test('a ring that needs a gesture: the hint shows, and unmuting starts it inside the click', async ({ browser }) => {
    await withSession(browser, inQueue('webyar', 3), async (s) => {
      await s.waitScreen('queue');
      // The renderer's audio facade as autoplay leaves it: blocked until a gesture.
      await s.page.evaluate(() => {
        const c = (window as unknown as CallWin).CallCenterWidget as unknown as { presentation: { update(i: unknown, ctx: Record<string, unknown>): void }; render(): void };
        const log: Array<[string, unknown, boolean]> = [];
        const state = { gesture: true, muted: false };
        let inClick = false;
        document.addEventListener('click', () => { inClick = true; setTimeout(() => { inClick = false; }, 0); }, true);
        const facade = Object.freeze({
          isActive: () => true, isMuted: () => state.muted, needsGesture: () => state.gesture,
          setMuted: (m: boolean) => { log.push(['setMuted', m, navigator.userActivation.isActive]); state.muted = m; },
          startFromGesture: (cfg: unknown) => { log.push(['startFromGesture', !!cfg, inClick]); state.gesture = false; },
        });
        const impl = c.presentation;
        c.presentation = { ...impl, update(i: unknown, ctx: Record<string, unknown>) { impl.update(i, { ...ctx, audio: facade }); } };
        (window as unknown as { __log: unknown }).__log = log;
        c.render();
      });
      await expect(s.w('.scr.on .hint')).toBeVisible();
      const b = s.w('.scr.on .dock [data-action=sound]');
      await expect(b).toHaveAttribute('aria-pressed', 'true');
      await b.click();
      const log = await s.page.evaluate(() => (window as unknown as { __log: unknown }).__log);
      expect(log).toEqual([['setMuted', false, true], ['startFromGesture', true, true]]);
      await expect(s.w('.scr.on .hint')).toBeHidden();
      await expect(b).toHaveAttribute('aria-pressed', 'false');
    });
  });
});

// ─── 5 · accessibility ───────────────────────────────────────────────────
interface FocusStop {
  what: string; ring: boolean; w: number; h: number; hit: number;
  /** The minimum target (D41): 44px under the phone layout or a coarse pointer, 24px on a desktop with a fine pointer. */
  min: number;
  /** Another control that a press on this one's box would reach instead (its hit area overlaps this control). */
  stolenBy: string | null;
}

/**
 * Tabs through the open panel (at most `max` stops) and reports each stop's
 * ring, target size and whether another control's hit area (a `::before`
 * grown past its box) covers any part of it.
 */
async function tabStops(s: CallSession, max = 25): Promise<FocusStop[]> {
  const stops: FocusStop[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < max; i++) {
    await s.page.keyboard.press('Tab');
    const stop = await s.page.evaluate(() => {
      const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
      const a = sr.activeElement as HTMLElement | null;
      if (!a || !sr.querySelector('.ccw-panel')!.contains(a)) return null;
      const ringOf = (el: Element | null) => {
        if (!el) return false;
        const cs = getComputedStyle(el);
        return (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || cs.boxShadow !== 'none';
      };
      // A field's ring is its box's halo (.fr, .inp, the language pill).
      const ring = ringOf(a) || ringOf(a.closest('.fr, .inp, .lang'));
      // A field's target is its whole box (the row's label is its label: a press anywhere focuses it).
      const r = (a.closest('.fr, .inp') || a).getBoundingClientRect();
      const b = getComputedStyle(a, '::before');
      const pseudo = b.content !== 'none' && b.position === 'absolute' ? Math.min(parseFloat(b.width) || 0, parseFloat(b.height) || 0) : 0;
      const key = `${a.tagName}.${a.className}[${a.getAttribute('data-action') || ''}=${a.getAttribute('data-value') || ''}]`;
      // D41: touch targets (phone layout, coarse pointer) 44px; a desktop's fine pointer 24px (WCAG 2.5.8) without overlap.
      const touch = matchMedia('(pointer: coarse)').matches || !!sr.querySelector('.ccw-root.is-mobile');
      const control = (n: Element | null) => n && n.closest('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
      const own = a.closest('.fr, .inp') || a;
      let stolenBy: string | null = null;
      for (const fx of [0.08, 0.5, 0.92]) {
        for (const fy of [0.08, 0.5, 0.92]) {
          const hit = control(sr.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy));
          if (hit && hit !== a && !own.contains(hit) && !hit.contains(a)) stolenBy = `${hit.tagName}.${hit.className}[${hit.getAttribute('data-action') || ''}]`;
        }
      }
      return { what: key, ring, w: Math.round(r.width), h: Math.round(r.height), hit: Math.max(Math.min(r.width, r.height), pseudo), min: touch ? 44 : 24, stolenBy };
    });
    if (!stop || seen.has(stop.what)) break;
    seen.add(stop.what);
    stops.push(stop);
  }
  return stops;
}

test.describe('5 accessibility', () => {
  test('launcher and panel: expanded, controls, dialog, inert while closed, Escape collapses and focus returns', async ({ browser }) => {
    await withSession(browser, { brand: 'webyar' }, async (s) => {
      const btn = s.w('.ccw-launcher-wrap .ccw-launcher-btn');
      await expect(btn).toHaveAttribute('aria-expanded', 'false');
      await expect(btn).toHaveAttribute('aria-controls', 'ccw-panel');
      await expect(s.w('#ccw-panel')).toHaveAttribute('role', 'dialog');
      await expect(s.w('#ccw-panel')).toHaveAttribute('aria-label', DEMO.webyar.displayName);
      expect(await s.w('#ccw-panel').getAttribute('inert')).not.toBeNull();
      await btn.focus();
      await s.page.keyboard.press('Enter');
      await s.waitOpen(true);
      await expect(btn).toHaveAttribute('aria-expanded', 'true');
      expect(await s.w('#ccw-panel').getAttribute('inert')).toBeNull();
      expect(await s.w('#ccw-panel').getAttribute('aria-modal'), 'non-modal on a desktop').toBeNull();
      await s.page.keyboard.press('Escape');
      await s.waitOpen(false);
      const back = await s.page.evaluate(() => document.getElementById('call-center-widget-host')!.shadowRoot!.activeElement?.classList.contains('ccw-launcher-btn'));
      expect(back, 'focus back on the launcher').toBe(true);
    });
  });

  // Every panel screen the fixture drives without the reference's video frames (light and stage), and the phone's.
  const states = [
    '05-01-home', '05-02-precall-error', '05-03-returning', '06-04-connecting', '06-05-queue-third', '06-06-queue-next-offer',
    '07-07-joining', '07-08-voice', '08-10-transfer', '08-11-reconnect', '08-12-mic-blocked', '09-13-rating', '09-14-thanks',
    '09-15-error', '10-16-offline', '10-17-callback-step1', '10-18-callback-step2', '10-19-scheduled', '11-21-sheet', '11-22-queue',
  ];
  for (const brand of BRANDS) {
    test(`${brand}: Tab reaches every control with a visible ring and a large enough target that nothing else covers, in each state`, async ({ browser }, info) => {
      test.setTimeout(360_000);
      const small: string[] = [];
      const noRing: string[] = [];
      const covered: string[] = [];
      const desktopUnder44: string[] = [];
      for (const id of states) {
        const st = callStates(brand).find((x) => x.id === id)!;
        const s = await openFixtureState(browser, brand, st, { clock: 'install' });
        try {
          await s.page.evaluate(() => (document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-panel') as HTMLElement).focus());
          const stops = await tabStops(s);
          expect(stops.length, `${id}: focusable controls`).toBeGreaterThan(0);
          for (const x of stops) {
            if (!x.ring) noRing.push(`${id} ${x.what}`);
            if (x.hit < x.min) small.push(`${id} ${x.what} ${x.w}×${x.h} (minimum ${x.min}px)`);
            else if (x.hit < 44) desktopUnder44.push(`${id} ${x.what} ${x.w}×${x.h}`);
            if (x.stolenBy) covered.push(`${id} ${x.what}: a press reaches ${x.stolenBy}`);
          }
          expect(s.log.errors).toEqual([]);
        } finally {
          await s.close();
        }
      }
      // D41: on a desktop with a fine pointer the credit link may stay 40px tall (it cannot grow over the action row).
      info.annotations.push({ type: 'desktop targets between 24px and 44px (D41)', description: desktopUnder44.join('; ') || 'none' });
      expect(noRing, 'controls without a visible focus ring').toEqual([]);
      expect(small, 'controls whose hit area is under the minimum (44px touch, 24px fine pointer)').toEqual([]);
      expect(covered, 'controls part of whose box another control\'s hit area covers').toEqual([]);
    });
  }

  // D41's coarse pointer outside the phone layout: a tablet gets the desktop panel and needs 44px targets all the same
  // (the credit link of the light and stage screens included, with the action row right above it).
  const tablet = { width: 1024, height: 768 };
  const tabletStates = ['05-01-home', '06-05-queue-third', '07-08-voice', '09-13-rating', '10-17-callback-step1', '10-19-scheduled'];
  for (const brand of BRANDS) {
    test(`${brand}: on a tablet (coarse pointer, desktop layout) Tab reaches every control with a 44px target that nothing else covers`, async ({ browser }) => {
      test.setTimeout(240_000);
      const problems: string[] = [];
      for (const id of tabletStates) {
        const st = callStates(brand).find((x) => x.id === id)!;
        const s = await openFixtureState(browser, brand, st, { clock: 'install', mobile: true, viewport: tablet });
        try {
          const layout = await s.page.evaluate(() => ({
            coarse: matchMedia('(pointer: coarse)').matches,
            phone: !!document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-root.is-mobile'),
          }));
          expect(layout, `${id}: a coarse pointer on the desktop layout`).toEqual({ coarse: true, phone: false });
          await s.page.evaluate(() => (document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-panel') as HTMLElement).focus());
          const stops = await tabStops(s);
          expect(stops.length, `${id}: focusable controls`).toBeGreaterThan(0);
          for (const x of stops) {
            if (!x.ring) problems.push(`${id} ${x.what}: no visible focus ring`);
            if (x.min !== 44 || x.hit < 44) problems.push(`${id} ${x.what} ${x.w}×${x.h}: hit area ${x.hit}px (minimum ${x.min}px, 44px expected)`);
            if (x.stolenBy) problems.push(`${id} ${x.what}: a press reaches ${x.stolenBy}`);
          }
          expect(s.log.errors).toEqual([]);
        } finally {
          await s.close();
        }
      }
      expect(problems).toEqual([]);
    });
  }
});

// ─── 6 · reduced motion ──────────────────────────────────────────────────
test.describe('6 reduced motion', () => {
  for (const brand of BRANDS) {
    test(`${brand}: every running animation is opacity only (launcher, open, queue, call, minimised)`, async ({ browser }) => {
      const props = new Set<string>();
      const check = async (s: CallSession, where: string) => {
        const keys = await s.page.evaluate(() => {
          const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
          const out: string[] = [];
          for (const a of sr.getAnimations()) {
            if (a.playState !== 'running') continue;
            const kf = (a.effect as KeyframeEffect | null)?.getKeyframes() || [];
            for (const f of kf) for (const k of Object.keys(f)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(k)) out.push(`${(a as CSSAnimation).animationName || (a as CSSTransition).transitionProperty || 'script'}:${k}`);
          }
          return out;
        });
        for (const k of keys) props.add(`${where} ${k}`);
      };
      await withSession(browser, inQueue(brand, 2), async (s) => {
        await s.waitScreen('queue');
        await check(s, 'queue');
        await s.w('.scr.on [data-action=minimize]').first().click();
        await s.page.waitForTimeout(50);
        await check(s, 'minimising');
        await s.page.waitForTimeout(400);
        await check(s, 'Se');
      });
      await withSession(browser, { brand }, async (s) => {
        await s.w('.ccw-launcher-wrap .ccw-launcher-btn').hover();
        await check(s, 'hover');
        await s.w('.ccw-launcher-wrap .ccw-launcher-btn').click();
        await s.page.waitForTimeout(30);
        await check(s, 'opening');
      });
      await withSession(browser, inCall(brand, 'voice'), async (s) => {
        await live(s, 'voice');
        await check(s, 'voice');
      });
      // Fades only; visibility is a discrete switch at the fade's end, not motion.
      expect([...props].filter((p) => !/:(opacity|visibility)$/.test(p)), 'non-opacity motion under reduce').toEqual([]);
    });
  }
});

// ─── 7 · digits, dates, no emoji ─────────────────────────────────────────
/** The visible text of the widget (launcher and panel), without the LTR isolates (codes, e-mails, hosts) and fields. */
async function visibleText(s: CallSession): Promise<string> {
  return s.page.evaluate(() => {
    const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
    const root = sr.querySelector('.ccw-root')!;
    const out: string[] = [];
    // An LTR isolate: dir=ltr, .ltr, <bdi>, or isolated left-to-right in CSS (the reference code).
    const isolated = (el: Element) => {
      for (let e: Element | null = el; e && e !== root; e = e.parentElement) {
        if (e.matches('[dir=ltr], .ltr, bdi')) return true;
        const cs = getComputedStyle(e);
        if (cs.direction === 'ltr' && /isolate|plaintext/.test(cs.unicodeBidi)) return true;
      }
      return false;
    };
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement!;
      if (!n.textContent!.trim() || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      if (el.closest('input, textarea, select, option, .sr-only') || isolated(el)) continue;
      out.push(n.textContent!.trim());
    }
    return out.join(' | ');
  });
}

test.describe('7 digits, dates and no emoji', () => {
  for (const brand of BRANDS) {
    test(`${brand}: every state's text${brand === 'webyar' ? ' in Persian digits outside LTR isolates' : ''}, and no emoji`, async ({ browser }) => {
      test.setTimeout(240_000);
      const latin: string[] = [];
      const emoji: string[] = [];
      for (const st of callStates(brand)) {
        if (!PIXEL_KINDS.has(st.kind) || st.live.media === 'video') continue;
        const s = await openFixtureState(browser, brand, st);
        try {
          const text = await visibleText(s);
          if (brand === 'webyar' && /[0-9]/.test(text)) latin.push(`${st.id}: ${text.split(' | ').filter((x) => /[0-9]/.test(x)).join(' / ')}`);
          if (/\p{Extended_Pictographic}/u.test(text)) emoji.push(`${st.id}: ${text}`);
          if (st.id === '10-17-callback-step1') {
            const days = await s.page.evaluate(() => [...document.getElementById('call-center-widget-host')!.shadowRoot!.querySelectorAll('.scr.on [data-action=day]')].map((d) => d.textContent!.trim()));
            expect(days, 'day chips from the frozen Thursday').toEqual(brand === 'webyar' ? ['امروز', 'فردا', 'شنبه', 'یکشنبه'] : ['Today', 'Tomorrow', 'Sat', 'Sun']);
          }
          expect(s.log.errors, st.id).toEqual([]);
        } finally {
          await s.close();
        }
      }
      expect(latin, 'Latin digits in Persian text').toEqual([]);
      expect(emoji, 'emoji').toEqual([]);
    });
  }

  test('respok in Persian: Persian digits too (queue, call, callback), outside the LTR isolates', async ({ browser }) => {
    const fa = { i18n: { default_locale: 'fa', available_locales: ['fa'] } };
    const latin: string[] = [];
    const scan = async (s: CallSession, where: string) => {
      const text = await visibleText(s);
      expect(text, `${where}: Persian text`).toMatch(/[\u0600-\u06FF]/);
      if (/[0-9]/.test(text)) latin.push(`${where}: ${text.split(' | ').filter((x) => /[0-9]/.test(x)).join(' / ')}`);
    };
    await withSession(browser, { ...inQueue('respok', 3), boot: { ...inQueue('respok', 3).boot, ...fa } }, async (s) => {
      await s.waitScreen('queue');
      await s.page.clock.runFor(2_000);
      await scan(s, 'queue');
      await minimise(s);
      await scan(s, 'Se');
    });
    await withSession(browser, { ...inCall('respok', 'voice'), boot: { ...inCall('respok', 'voice').boot, ...fa } }, async (s) => {
      await live(s, 'voice');
      await scan(s, 'voice');
      await minimise(s);
      await scan(s, 'Sf');
    });
    await withSession(browser, { brand: 'respok', boot: fa }, async (s) => {
      await s.open();
      await s.w('.scr.on [data-action=callback]').click();
      await s.waitScreen('callback');
      await scan(s, 'callback step 1');
    });
    expect(latin, 'Latin digits in Persian text').toEqual([]);
  });

  test('webyar: dates in the Jalali calendar, times in Tehran, on the booked callback (19) and the launcher (Sh)', async ({ browser }) => {
    const st = callStates('webyar').find((x) => x.id === '10-19-scheduled')!;
    const s = await openFixtureState(browser, 'webyar', st);
    try {
      await expect(s.w('.scr.on .kv')).toContainText('فردا، ۱۶:۳۰');
      // A booking past tomorrow prints its weekday (Persian calendar's week).
      await s.set({ callbackBooking: { callbackId: 'cb-2', scheduled_for: '2026-10-25T13:00:00Z', channel: 'audio', urgency: 'normal' } });
      await s.page.evaluate(() => { const c = (window as unknown as CallWin).CallCenterWidget; c.toggleOpen(); });
      await s.waitOpen(false);
      await expect(s.w('.ccw-launcher-wrap .sched small')).toHaveText('یکشنبه ۱۶:۳۰');
    } finally {
      await s.close();
    }
  });
});

// ─── 8 · network and fonts ───────────────────────────────────────────────
const FONT_BYTES = (name: string) => readFileSync(path.join(ROOT, 'public/widget/fonts', name)).length;

test.describe('8 network and fonts', () => {
  const cases: Array<{ brand: Brand; locale: 'fa' | 'en' | 'tr'; pageLoad: string[]; firstOpen: RegExp; cap: number }> = [
    { brand: 'webyar', locale: 'fa', pageLoad: ['iransans-400.woff2', 'iransans-700.woff2'], firstOpen: /^iransans-(400|500|700)\.woff2$/, cap: 120_000 },
    { brand: 'webyar', locale: 'en', pageLoad: ['inter-500-latin.woff2'], firstOpen: /^inter-500-latin\.woff2$/, cap: 50_000 },
    // InterWY's Latin file holds the Turkish letters (ğ ı İ ş): no latin-ext file for Turkish.
    { brand: 'webyar', locale: 'tr', pageLoad: ['inter-500-latin.woff2'], firstOpen: /^inter-500-latin\.woff2$/, cap: 50_000 },
    { brand: 'respok', locale: 'en', pageLoad: ['figtree-latin.woff2'], firstOpen: /^figtree-latin\.woff2$/, cap: 50_000 },
    { brand: 'respok', locale: 'tr', pageLoad: ['figtree-latin.woff2', 'figtree-tr.woff2'], firstOpen: /^figtree-(latin|tr)\.woff2$/, cap: 50_000 },
    { brand: 'respok', locale: 'fa', pageLoad: ['iransans-400.woff2', 'iransans-700.woff2'], firstOpen: /^iransans-(400|500|700)\.woff2$/, cap: 120_000 },
  ];
  // The business's name in the page's language (a Persian name is Persian text in an English panel too).
  const names = { fa: DEMO.webyar.displayName, en: DEMO.respok.displayName, tr: DEMO.respok.displayName };
  for (const c of cases) {
    test(`${c.brand} ${c.locale}: page load and first open fetch only the faces their text needs`, async ({ browser }) => {
      await withSession(browser, { brand: c.brand, boot: { config: { display_name: names[c.locale] }, i18n: { default_locale: c.locale, available_locales: [c.locale] } } }, async (s) => {
        const fonts = () => [...new Set(s.log.requests.filter((r) => r.startsWith('/widget/fonts/')).map((r) => r.split('?')[0].slice('/widget/fonts/'.length)))].sort();
        await s.page.evaluate(() => document.fonts.ready.then(() => undefined));
        expect(fonts(), 'page load').toEqual([...c.pageLoad].sort());
        expect(s.panelRequests(), 'no panel file at page load').toEqual([]);
        await clickLauncher(s);
        await s.waitOpen(true);
        await s.page.evaluate(() => document.fonts.ready.then(() => undefined));
        await s.page.waitForTimeout(300);
        const open = fonts();
        expect(open.filter((f) => !c.firstOpen.test(f)), 'unexpected faces').toEqual([]);
        expect(open.reduce((n, f) => n + FONT_BYTES(f), 0), 'first panel paint fonts (bytes)').toBeLessThanOrEqual(c.cap);
        expect(s.log.requests.some((r) => /vazir|dm-?mono|figtree-\d|googleapis|jsdelivr|unpkg/i.test(r))).toBe(false);
      });
    });
  }
});

// ─── 9 · phones ──────────────────────────────────────────────────────────
test.describe('9 phones', () => {
  test('home is a modal bottom sheet over a scrim; the page behind is held and given back where it was', async ({ browser }) => {
    await withSession(browser, { brand: 'webyar', mobile: true, tall: true }, async (s) => {
      await s.page.evaluate(() => window.scrollTo(0, 900));
      await clickLauncher(s);
      await s.waitOpen(true);
      const g = await s.page.evaluate(() => {
        const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
        const p = sr.querySelector('#ccw-panel')!;
        const r = p.getBoundingClientRect();
        return {
          sheet: p.classList.contains('sheet'), modal: p.getAttribute('aria-modal'), scrim: !(sr.querySelector('.scrim') as HTMLElement).hidden,
          left: r.left, right: innerWidth - r.right, bottom: Math.round(innerHeight - r.bottom), body: [document.body.style.position, document.body.style.top],
        };
      });
      expect(g).toEqual({ sheet: true, modal: 'true', scrim: true, left: 0, right: 0, bottom: 0, body: ['fixed', '-900px'] });
      await s.w('.scrim').click({ position: { x: 20, y: 40 } });
      await s.waitOpen(false);
      expect(await s.page.evaluate(() => [document.body.style.position, Math.round(scrollY)])).toEqual(['', 900]);
    });
  });

  test('queue and call take the whole screen with the dock in view', async ({ browser }) => {
    await withSession(browser, { ...inQueue('webyar', 2), mobile: true }, async (s) => {
      await s.waitScreen('queue');
      await s.waitOpen(true);
      const q = await s.rect('#ccw-panel');
      expect([q!.x, q!.y, q!.width, q!.height]).toEqual([0, 0, 390, 844]);
      const d = await s.rect('.scr.on .dock');
      expect(d!.bottom).toBeLessThanOrEqual(844);
      expect(d!.y).toBeGreaterThan(0);
    });
    await withSession(browser, { ...inCall('webyar', 'video'), mobile: true }, async (s) => {
      await live(s, 'video');
      const p = await s.rect('#ccw-panel');
      expect([p!.x, p!.y, p!.width, p!.height]).toEqual([0, 0, 390, 844]);
      const d = await s.rect('.scr.on .vdock');
      expect(d!.bottom).toBeLessThanOrEqual(844);
    });
  });

  test('a keyboard (visual viewport 500px over the 844px page) lifts the sheet above it and keeps the field being typed in visible', async ({ browser }) => {
    await withSession(browser, { brand: 'webyar', mobile: true }, async (s) => {
      // No on-screen keyboard in this browser: a visual viewport the test shrinks as a keyboard does, while the
      // layout viewport (innerHeight, 100dvh) stays 844px. The sheet must follow the visual viewport, not the layout.
      await s.page.evaluate(() => {
        const t = new EventTarget();
        const vv = {
          width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1,
          addEventListener: t.addEventListener.bind(t), removeEventListener: t.removeEventListener.bind(t), dispatchEvent: t.dispatchEvent.bind(t),
        };
        Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
        (window as unknown as { __vv: typeof vv }).__vv = vv;
      });
      await clickLauncher(s);
      await s.waitOpen(true);
      await s.w('.scr.on [data-action=callback]').click();
      await s.w('.scr.on [data-action=continue]').click();
      const ta = s.w('.scr.on textarea');
      await ta.focus();
      await s.page.evaluate(() => {
        const vv = (window as unknown as { __vv: { height: number; dispatchEvent(e: Event): boolean } }).__vv;
        vv.height = 500;
        vv.dispatchEvent(new Event('resize'));
      });
      await s.page.waitForTimeout(400);
      expect(await s.page.evaluate(() => innerHeight), 'the layout viewport stays').toBe(844);
      const p = await s.rect('#ccw-panel');
      expect(p!.bottom, 'the sheet stands on the keyboard').toBeLessThanOrEqual(500.5);
      expect(p!.y, 'and inside the visible part').toBeGreaterThanOrEqual(-0.5);
      const r = await s.rect('.scr.on textarea');
      expect(r!.y, 'top in view').toBeGreaterThanOrEqual(0);
      expect(r!.bottom, 'bottom in view').toBeLessThanOrEqual(500);
      const focused = await s.page.evaluate(() => document.getElementById('call-center-widget-host')!.shadowRoot!.activeElement?.tagName);
      expect(focused).toBe('TEXTAREA');
      // The keyboard goes: the sheet is back on the bottom edge.
      await s.page.evaluate(() => {
        const vv = (window as unknown as { __vv: { height: number; dispatchEvent(e: Event): boolean } }).__vv;
        vv.height = 844;
        vv.dispatchEvent(new Event('resize'));
      });
      await s.page.waitForTimeout(400);
      expect(Math.round((await s.rect('#ccw-panel'))!.bottom), 'back on the bottom edge').toBe(844);
    });
  });

  test('the phone sheet is modal: Tab and Shift+Tab go round inside it, never to the page', async ({ browser }) => {
    await withSession(browser, { brand: 'webyar', mobile: true, tall: true }, async (s) => {
      await clickLauncher(s);
      await s.waitOpen(true);
      const where = () => s.page.evaluate(() => {
        const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
        const a = sr.activeElement;
        if (!a || document.activeElement !== sr.host) return `page:${document.activeElement?.tagName}`;
        return sr.querySelector('#ccw-panel')!.contains(a) ? `${a.tagName}[${a.getAttribute('data-action') || ''}]` : `widget:${a.className}`;
      });
      for (const key of ['Tab', 'Shift+Tab']) {
        const seen: string[] = [];
        for (let i = 0; i < 30; i++) {
          await s.page.keyboard.press(key);
          seen.push(await where());
        }
        expect(seen.filter((x) => !/^[A-Z]+\[/.test(x)), `${key}: every stop inside the panel`).toEqual([]);
        expect(new Set(seen).size, `${key}: it goes round (30 presses, fewer controls)`).toBeLessThan(30);
      }
    });
  });

  test('rotation: landscape keeps the phone layout and the same playing video; back to portrait', async ({ browser }) => {
    await withSession(browser, { ...inCall('webyar', 'video'), mobile: true }, async (s) => {
      await live(s, 'video');
      await s.page.evaluate(() => { (window as unknown as { __v: unknown }).__v = document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.scr.on .feed video'); });
      for (const vp of [{ width: 844, height: 390 }, { width: 390, height: 844 }]) {
        await s.page.setViewportSize(vp);
        await s.page.waitForTimeout(500);
        const g = await s.page.evaluate(() => {
          const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
          const p = sr.querySelector('#ccw-panel')!.getBoundingClientRect();
          const v = sr.querySelector('.scr.on .feed video') as HTMLVideoElement;
          return { mobile: sr.querySelector('.ccw-root')!.classList.contains('is-mobile'), w: p.width, h: p.height, same: v === (window as unknown as { __v: unknown }).__v, playing: !v.paused };
        });
        expect(g, `${vp.width}×${vp.height}`).toEqual({ mobile: true, w: vp.width, h: vp.height, same: true, playing: true });
        const d = await s.rect('.scr.on .vdock');
        expect(d!.bottom, `${vp.width}×${vp.height}: dock in view`).toBeLessThanOrEqual(vp.height);
      }
    });
  });
});

// ─── 10 · the lazy panel ─────────────────────────────────────────────────
const SLOW_4G = { latencyMs: 562.5, bytesPerSecond: 1.44e6 / 8 };

test.describe('10 the lazy panel', () => {
  for (const brand of BRANDS) {
    test.describe(`${brand} (built: hashed names)`, () => {
      let build: { dist: string; cleanup: () => void };
      test.beforeAll(() => { build = buildCallWidgetScratch(brand); });
      test.afterAll(() => build?.cleanup());
      const hashed = /^\/call-widget\/presentation-default-panel\.[0-9a-f]{12}\.(js|css)$/;

      test('page load requests exactly the core set; the first hover the panel pair, once, by hashed name', async ({ browser }) => {
        await withSession(browser, { brand, mode: 'built', dist: build.dist }, async (s) => {
          await s.page.evaluate(() => document.fonts.ready.then(() => undefined));
          await s.page.waitForTimeout(300);
          const files = s.log.requests.map((r) => r.split('?')[0].replace(/\.[0-9a-f]{12}\./, '.#.'));
          // The fonts stylesheet is the chat build's (hashed there; this scratch build is the call widget's alone).
          expect(files.filter((f) => !f.startsWith('/widget/fonts/')).map((f) => f.replace('fonts.#.css', 'fonts.css')).sort()).toEqual([
            '/api/call-widget/bootstrap', '/call-widget/l.js', '/call-widget/presentation-default.#.js', '/call-widget/presentation-registry.#.js',
            `/call-widget/${brand === 'webyar' ? 'presentation-default' : 'presentation-intl'}.#.css`, '/call-widget/runtime.#.css', '/call-widget/runtime.#.js',
            '/widget/presentation-default-fonts.css',
          ].sort());
          await s.w('.ccw-launcher-wrap .ccw-launcher-btn').hover();
          await s.page.waitForFunction(() => !!(window as unknown as { __ccw_panel?: unknown }).__ccw_panel);
          await s.page.waitForTimeout(200);
          expect(s.panelRequests().map((r) => r.split('?')[0]).every((p) => hashed.test(p)), s.panelRequests().join()).toBe(true);
          expect(s.panelRequests().length).toBe(2);
          await clickLauncher(s);
          await s.waitOpen(true);
          await s.w('.scr.on [data-action=minimize]').first().click();
          await s.w('.ccw-launcher-wrap .ccw-launcher-btn').hover();
          await clickLauncher(s);
          await s.waitOpen(true);
          expect(s.panelRequests().length, 'requested once').toBe(2);
        });
      });

      test('keyboard focus on the launcher, or a press on it, asks for the pair as a hover does (once each)', async ({ browser }) => {
        for (const intent of ['focus', 'pointerdown'] as const) {
          await withSession(browser, { brand, mode: 'built', dist: build.dist }, async (s) => {
            await s.page.waitForTimeout(300);
            expect(s.panelRequests(), `${intent}: nothing before the intent`).toEqual([]);
            if (intent === 'focus') {
              // Tab from the page into the launcher (the only focusable things on the page are the widget's).
              await s.page.keyboard.press('Tab');
              const on = await s.page.evaluate(() => {
                const a = document.getElementById('call-center-widget-host')!.shadowRoot!.activeElement;
                return a ? `${a.tagName}.${a.className}${a.closest('.ccw-launcher-wrap') ? ' in the launcher' : ''}` : 'none';
              });
              expect(on, 'Tab reached the launcher').toMatch(/ in the launcher$/);
            } else {
              // A press without a hover first (a touch screen's tap, a pen): pointerdown alone.
              await s.w('.ccw-launcher-wrap .ccw-launcher-btn').dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true });
            }
            const got = await s.page.waitForFunction(() => !!(window as unknown as { __ccw_panel?: unknown }).__ccw_panel, undefined, { timeout: 5_000 })
              .then(() => true, () => false);
            expect(got, `${intent}: the panel module came`).toBe(true);
            await s.page.waitForTimeout(200);
            const asked = s.panelRequests().map((r) => r.split('?')[0]);
            expect(asked.length, `${intent}: ${asked.join()}`).toBe(2);
            expect(asked.every((p) => hashed.test(p)), `${intent}: hashed names`).toBe(true);
            expect(await s.isOpen(), `${intent}: an intent alone opens nothing`).toBe(false);
          });
        }
      });

      test('a touch screen without hover fetches the pair while idle, once, and the panel\'s faces only with the tap', async ({ browser }, info) => {
        await withSession(browser, { brand, mode: 'built', dist: build.dist, mobile: true }, async (s) => {
          expect(await s.page.evaluate(() => matchMedia('(hover: none)').matches), 'the phone has no hover').toBe(true);
          const fonts = () => [...new Set(s.log.requests.filter((r) => r.startsWith('/widget/fonts/')).map((r) => r.split('?')[0].replace('/widget/fonts/', '')))].sort();
          await s.page.waitForFunction(() => !!(window as unknown as { __ccw_panel?: unknown }).__ccw_panel, undefined, { timeout: 8_000 });
          await s.page.waitForTimeout(500);
          expect(s.panelRequests().length, 'the pair, with no intent').toBe(2);
          const idle = fonts();
          expect(await s.isOpen()).toBe(false);
          await clickLauncher(s);
          await s.waitOpen(true);
          await s.page.evaluate(() => document.fonts.ready.then(() => undefined));
          expect(s.panelRequests().length, 'not again on the tap').toBe(2);
          // Idle brings the files only: no panel is painted before an intent (a laid-out hidden panel would fetch
          // its faces), so a page view that never opens pays no panel face. The tap warms the first paint's.
          const after = fonts();
          info.annotations.push({ type: 'faces', description: `idle: ${idle.join(', ')}; after the tap: ${after.join(', ')}` });
          expect(idle, 'before the tap: the launcher\'s faces only').toEqual(brand === 'webyar' ? ['iransans-400.woff2', 'iransans-700.woff2'] : ['figtree-latin.woff2']);
          expect(after.filter((f) => !idle.includes(f)), 'the tap: the panel\'s first paint').toEqual(brand === 'webyar' ? ['iransans-500.woff2'] : []);
          expect(after.reduce((n, f) => n + FONT_BYTES(f), 0), 'first panel paint fonts (bytes)').toBeLessThanOrEqual(brand === 'webyar' ? 120_000 : 50_000);
        });
      });

      test('a hashed name the server lacks is asked once more by its fixed name', async ({ browser }) => {
        await withSession(browser, {
          brand, mode: 'built', dist: build.dist,
          intercept: (r) => (hashed.test(r.path) ? { status: 404, body: '' } : undefined),
        }, async (s) => {
          await clickLauncher(s);
          await s.waitOpen(true);
          const asked = s.panelRequests().map((r) => r.replace(/\.[0-9a-f]{12}\./, '.#.').replace(/\?.*$/, '?…'));
          expect(asked.sort()).toEqual([
            '/call-widget/presentation-default-panel.#.css', '/call-widget/presentation-default-panel.#.js',
            '/call-widget/presentation-default-panel.css?…', '/call-widget/presentation-default-panel.js?…',
          ].sort());
        }, /Failed to load resource: the server responded with a status of 404/);
      });

      test('a call being restored asks for the pair with the page-load files and opens', async ({ browser }) => {
        await withSession(browser, { ...inQueue(brand, 3), mode: 'built', dist: build.dist }, async (s) => {
          await s.waitScreen('queue');
          await s.waitOpen(true);
          const at = (re: RegExp) => s.log.requests.findIndex((r) => re.test(r));
          const mod = at(/presentation-default-panel\.[0-9a-f]{12}\.js/);
          expect(mod, 'the module, with no intent').toBeGreaterThan(-1);
          // In the loader's page-load pass, not on the visitor's intent nor at the mount (runtime.css is the mount's).
          expect(mod, 'requested with the page-load scripts').toBeGreaterThan(at(/\/runtime\.[0-9a-f]{12}\.js/));
          expect(mod, 'before the mount').toBeLessThan(at(/\/runtime\.[0-9a-f]{12}\.css/));
        });
      });

      test('no unstyled frame: the panel shows only once its stylesheet is in; the launcher is busy meanwhile (Slow 4G timing reported)', async ({ browser }, info) => {
        const gz = (f: string) => gzipSync(readFileSync(path.join(build.dist, 'call-widget', f)), { level: 5 }).length;
        const delays: Record<string, number> = {};
        const timings: string[] = [];
        for (const warm of [false, true]) {
          await withSession(browser, {
            brand, mode: 'built', dist: build.dist, clock: 'real',
            intercept: async (r) => {
              const m = /\/call-widget\/(presentation-default-panel\.[0-9a-f]{12}\.(js|css))$/.exec(r.path);
              if (m) {
                const ms = SLOW_4G.latencyMs + (gz(m[1]) / SLOW_4G.bytesPerSecond) * 1000 + (m[2] === 'css' ? 600 : 0);
                delays[m[2]] = Math.round(ms);
                await new Promise((res) => setTimeout(res, ms));
              }
              return undefined;
            },
          }, async (s) => {
            await s.page.evaluate(() => {
              const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
              const frames: Array<{ open: boolean; shown: boolean; radius: number; bg: string; busy: string | null }> = [];
              (window as unknown as { __frames: unknown }).__frames = frames;
              const sample = () => {
                const root = sr.querySelector('.ccw-root')!;
                const p = sr.querySelector('#ccw-panel') as HTMLElement;
                const cs = getComputedStyle(p);
                const r = p.getBoundingClientRect();
                frames.push({
                  open: root.classList.contains('ccw-is-open'),
                  shown: cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0 && r.width > 0 && r.height > 0 && !p.hasAttribute('hidden'),
                  radius: parseFloat(cs.borderTopLeftRadius), bg: cs.backgroundColor,
                  busy: sr.querySelector('.ccw-launcher-btn')?.getAttribute('aria-busy') ?? null,
                });
                if (frames.length < 600) requestAnimationFrame(sample);
              };
              requestAnimationFrame(sample);
            });
            const btn = s.w('.ccw-launcher-wrap .ccw-launcher-btn');
            if (warm) { await btn.hover(); await s.page.waitForTimeout(300); }
            const t0 = Date.now();
            await btn.click();
            await s.waitOpen(true, 15_000);
            timings.push(`${warm ? 'hover 300 ms before the click' : 'cold click'}: ${Date.now() - t0} ms`);
            await s.page.waitForTimeout(100);
            const frames = await s.page.evaluate(() => (window as unknown as { __frames: Array<{ open: boolean; shown: boolean; radius: number; bg: string; busy: string | null }> }).__frames);
            const firstShown = frames.findIndex((f) => f.open && f.shown);
            expect(firstShown, 'the panel showed').toBeGreaterThan(-1);
            expect(frames.slice(0, firstShown).filter((f) => f.shown && f.open), 'no frame shows the panel early').toEqual([]);
            const f = frames[firstShown];
            expect(f.radius, 'its first visible frame is styled (rounded)').toBeGreaterThanOrEqual(16);
            expect(f.bg, 'and has its ground').not.toBe('rgba(0, 0, 0, 0)');
            if (!warm) expect(frames.some((x) => x.busy === 'true'), 'the launcher said it was busy').toBe(true);
            expect(frames[frames.length - 1].busy).toBeNull();
          });
        }
        info.annotations.push({ type: 'Slow 4G (simulated per file)', description: `${timings.join('; ')} (panel js ${delays.js} ms, css ${delays.css} ms incl. 600 ms extra on the css)` });
        console.log(`${brand} Slow 4G: ${timings.join('; ')}`);
      });

      test('a module of another contract version is refused, the launcher keeps working, the next intent retries', async ({ browser }) => {
        let served = 0;
        const real = (f: string) => readFileSync(path.join(build.dist, 'call-widget', f), 'utf8');
        await withSession(browser, {
          brand, mode: 'built', dist: build.dist,
          intercept: (r) => {
            const m = /\/call-widget\/(presentation-default-panel\.[0-9a-f]{12}\.js)$/.exec(r.path);
            if (!m || served++ > 0) return undefined;
            return { body: real(m[1]).replace(/\{\s*v:\s*1\s*,/, '{ v: 2,'), contentType: 'application/javascript' };
          },
        }, async (s) => {
          await clickLauncher(s);
          await s.page.waitForTimeout(600);
          expect(await s.isOpen(), 'refused: not opened').toBe(false);
          expect(await s.field('open'), 'the open was put back').toBe(false);
          await expect(s.w('.ccw-launcher-wrap .ccw-launcher-btn')).not.toHaveAttribute('aria-busy', 'true');
          await clickLauncher(s);
          await s.waitOpen(true);
          expect(served).toBe(2);
        });
      });
    });
  }

  test('an old loader (no loadPanel in the render context) leaves the launcher working, without an error', async ({ browser }) => {
    await withSession(browser, {
      brand: 'webyar',
      intercept: (r) => (r.path === '/call-widget/l.js'
        ? { body: readFileSync(path.join(ROOT, 'public/call-widget/l.js'), 'utf8').replace('loadPanel: ensurePanel,', ''), contentType: 'application/javascript' }
        : undefined),
    }, async (s) => {
      await clickLauncher(s);
      await s.page.waitForTimeout(500);
      expect(await s.isOpen()).toBe(false);
      expect(await s.field('open')).toBe(false);
      await expect(s.w('.ccw-launcher-wrap .ccw-launcher-btn')).toBeVisible();
      await expect(s.w('.ccw-launcher-wrap .ccw-launcher-btn')).not.toHaveAttribute('aria-busy', 'true');
      expect(s.panelRequests().filter((r) => r.includes('.js')), 'no module fetched by the presentation itself').toEqual([]);
    });
  });
});

// ─── 11 · the §11 fixes that need media ─────────────────────────────────
test.describe('11 the §11 fixes with media', () => {
  test('the resumed call\'s ring stops when the operator joins (E6)', async ({ browser }) => {
    await withSession(browser, { ...inCall('webyar', 'voice'), liveKit: { present: [] } }, async (s) => {
      await s.waitScreen('joining');
      await expect.poll(async () => (await s.audio()).active, { message: 'the ring plays while nobody is in' }).toBe(true);
      await s.page.evaluate(() => { (window as unknown as CallWin).__lk.join('op-a'); });
      await expect.poll(async () => (await s.audio()).active, { message: 'the ring stops on the join' }).toBe(false);
      await live(s, 'voice');
    });
  });

  test('camera refused: the call goes on with the microphone, the banner shows, mute works (E7, D23)', async ({ browser }) => {
    await withSession(browser, { ...inCall('webyar', 'video'), liveKit: { present: [{ id: 'op-a' }], camDenials: 1 } }, async (s) => {
      await s.waitScreen('video');
      await expect(s.w('.scr.on .bnr')).toBeVisible();
      await expect(s.w('.scr.on .bnr')).toContainText(await s.page.evaluate(() => (window as unknown as CallWin).CallCenterWidget.t('camera_denied')));
      expect([await s.field('cameraDenied'), await s.field('micOn'), await s.field('connectStatus')]).toEqual([true, true, 'in_call']);
      const mute = s.w('.scr.on .dock [data-action=mute]');
      await mute.click();
      await expect(mute).toHaveAttribute('aria-pressed', 'true');
      expect(await s.field('micOn')).toBe(false);
    });
  });
});

// ─── 12 · docks in view on short screens ─────────────────────────────────
test.describe('12 docks in view on short screens', () => {
  const sizes: Array<{ vp: { width: number; height: number }; mobile: boolean }> = [
    { vp: { width: 1280, height: 720 }, mobile: false },
    { vp: { width: 390, height: 600 }, mobile: true },
  ];
  for (const { vp, mobile } of sizes) {
    test(`${vp.width}×${vp.height}: the queue dock, the call dock and the video dock inside the screen; the self-view never on the dock`, async ({ browser }) => {
      const inView = async (s: CallSession, sel: string) => {
        const r = await s.rect(sel);
        expect(r, sel).not.toBeNull();
        expect([r!.x >= 0, r!.y >= 0, r!.right <= vp.width + 0.5, r!.bottom <= vp.height + 0.5], `${sel} ${JSON.stringify(r)}`).toEqual([true, true, true, true]);
      };
      await withSession(browser, { ...inQueue('webyar', 3), viewport: vp, mobile }, async (s) => {
        await s.waitScreen('queue');
        await s.waitOpen(true);
        if (!mobile) expect((await s.rect('#ccw-panel'))!.height, 'the panel is shorter than 660').toBeLessThan(660);
        await inView(s, '.scr.on .dock');
      });
      await withSession(browser, { ...inCall('webyar', 'voice'), viewport: vp, mobile }, async (s) => {
        await live(s, 'voice');
        await inView(s, '.scr.on .dock');
      });
      await withSession(browser, { ...inCall('webyar', 'video'), viewport: vp, mobile }, async (s) => {
        await live(s, 'video');
        await inView(s, '.scr.on .vdock');
        const pip = await s.rect('.scr.on .pip');
        const dock = await s.rect('.scr.on .vdock');
        const meet = pip!.x < dock!.right && dock!.x < pip!.right && pip!.y < dock!.bottom && dock!.y < pip!.bottom;
        expect(meet, `pip ${JSON.stringify(pip)} vdock ${JSON.stringify(dock)}`).toBe(false);
      });
    });
  }
});

// ─── 13 · transfer (E19) ─────────────────────────────────────────────────
test.describe('13 transfer', () => {
  for (const to of ['ref-b', null] as const) {
    test(`agent reference A → ${to ? 'B' : 'none (a department) → B'}: screen 10 until the next operator joins, no failure, the time runs on`, async ({ browser }) => {
      await withSession(browser, inCall('webyar', 'voice'), async (s) => {
        await live(s, 'voice');
        const startedAt = await s.field<number>('callStartedAt');
        s.server.call!.agent = to;
        s.server.call!.name = to ? 'رضا احمدی' : null;
        await s.page.clock.runFor(5_000);
        await s.waitScreen('transfer');
        expect((await s.audio()).active, 'the hold plays').toBe(true);
        await s.page.evaluate(() => { (window as unknown as CallWin).__lk.leave('op-a'); });
        await s.page.clock.runFor(1_000);
        expect(await s.screen(), 'the old operator leaving is part of the transfer').toBe('transfer');
        if (!to) {
          s.server.call!.agent = 'ref-b';
          s.server.call!.name = 'رضا احمدی';
          await s.page.clock.runFor(5_000);
          expect(await s.screen()).toBe('transfer');
        }
        await s.page.evaluate(() => { (window as unknown as CallWin).__lk.join('op-b'); });
        await s.waitScreen('voice');
        expect(await s.field('operatorName')).toBe('رضا احمدی');
        expect(await s.field('callStartedAt'), 'the call\'s start is kept').toBe(startedAt);
        // The time since the call's own start (read between two clock reads: a tick may fall between them).
        const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`
          .replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
        const since = () => s.page.evaluate((at) => Date.now() - at, startedAt);
        const before = await since();
        const shown = (await s.w('.scr.on .ctm').textContent())!.replace(/\s/g, '');
        const after = await since();
        expect([clock(before), clock(after)].some((w) => shown.includes(w)), `${shown} shows ${clock(before)} or ${clock(after)}`).toBe(true);
        expect((await s.audio()).active, 'the hold stops on the join').toBe(false);
      });
    });
  }
});

// ─── 14 · an outcome while minimised (D35) ───────────────────────────────
test.describe('14 an outcome while minimised', () => {
  test('ending the call from Sf opens the rating; focus goes to its heading, never the page', async ({ browser }) => {
    await withSession(browser, inCall('webyar', 'voice'), async (s) => {
      await live(s, 'voice');
      await minimise(s);
      await s.w('.ccw-launcher-wrap .mc [data-action=end]').click();
      await s.waitOpen(true);
      await s.waitScreen('rating');
      const f = await s.page.evaluate(() => {
        const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
        const a = sr.activeElement;
        return { body: document.activeElement === document.body, inRating: !!a && !!a.closest('.scr[data-screen=rating]') };
      });
      expect(f).toEqual({ body: false, inRating: true });
      expect(s.server.calls('POST', /\/cancel$/).length).toBe(1);
    });
  });

  test('the operator ends the call while minimised: the rating opens, focus stays where the visitor is typing, the outcome is announced', async ({ browser }) => {
    await withSession(browser, { ...inCall('webyar', 'voice'), tall: true }, async (s) => {
      await live(s, 'voice');
      await minimise(s);
      await s.page.locator('#site-search').focus();
      s.server.call!.state = 'ended';
      await s.page.clock.runFor(5_000);
      await s.waitOpen(true);
      await s.waitScreen('rating');
      expect(await s.page.evaluate(() => document.activeElement?.id)).toBe('site-search');
      await expect(s.w('.ccw-live')).toHaveText(await s.page.evaluate(() => (window as unknown as CallWin).CallCenterWidget.t('call_ended')));
    });
  });
});

// ─── 15 · accessibility extras ───────────────────────────────────────────
test.describe('15 accessibility extras', () => {
  test('a new place in line is announced while minimised, through a live region that is not inert', async ({ browser }) => {
    await withSession(browser, inQueue('webyar', 3), async (s) => {
      await s.waitScreen('queue');
      await minimise(s);
      s.server.call!.position = 2;
      await s.page.clock.runFor(5_000);
      await expect(s.w('.ccw-live')).toHaveText(/۲/);
      const live = await s.page.evaluate(() => {
        const l = document.getElementById('call-center-widget-host')!.shadowRoot!.querySelector('.ccw-live')!;
        return { inert: !!l.closest('[inert]'), hidden: !!l.closest('[aria-hidden=true]'), polite: l.getAttribute('aria-live') };
      });
      expect(live).toEqual({ inert: false, hidden: false, polite: 'polite' });
    });
  });

  test('no ticking node sits under a live region or role=status (queue, call, Se, Sf)', async ({ browser }) => {
    const check = (s: CallSession) => s.page.evaluate(() => {
      const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
      const ticking = [...sr.querySelectorAll('[role=timer], .tmr b, .ctm, .mc small, .mvid .t, .vtop .num')];
      return ticking.filter((n) => !!n.closest('[aria-live], [role=status], [role=log], [role=alert]')).map((n) => n.className || n.nodeName);
    });
    await withSession(browser, inQueue('webyar', 3), async (s) => {
      await s.waitScreen('queue');
      expect(await check(s)).toEqual([]);
      await minimise(s);
      expect(await check(s)).toEqual([]);
    });
    await withSession(browser, inCall('webyar', 'voice'), async (s) => {
      await live(s, 'voice');
      expect(await check(s)).toEqual([]);
      await minimise(s);
      expect(await check(s)).toEqual([]);
    });
  });

  for (const brand of BRANDS) {
    test(`${brand}: radio groups move with the arrow keys (${brand === 'webyar' ? 'mirrored in RTL' : 'LTR'}); focus lands on the next screen's heading after Continue`, async ({ browser }) => {
      await withSession(browser, { brand }, async (s) => {
        await clickLauncher(s);
        await s.waitOpen(true);
        await s.w('.scr.on [data-action=callback]').click();
        await s.waitScreen('callback');
        const group = s.w('.scr.on [role=radiogroup]').first();
        const checked = () => group.locator('[role=radio][aria-checked=true]').getAttribute('data-value');
        const first = await checked();
        await group.locator('[role=radio][aria-checked=true]').focus();
        const next = brand === 'webyar' ? 'ArrowLeft' : 'ArrowRight';
        await s.page.keyboard.press(next);
        const second = await checked();
        expect(second, `${next} picks the next item`).not.toBe(first);
        const order = await group.locator('[role=radio]').evaluateAll((els) => els.map((e) => e.getAttribute('data-value')));
        expect(order.indexOf(second), 'the next one in reading order').toBe(order.indexOf(first) + 1);
        const focusedValue = await s.page.evaluate(() => document.getElementById('call-center-widget-host')!.shadowRoot!.activeElement?.getAttribute('data-value'));
        expect(focusedValue, 'focus moves with the choice').toBe(second);
        await s.page.keyboard.press(brand === 'webyar' ? 'ArrowRight' : 'ArrowLeft');
        expect(await checked(), 'and back').toBe(first);
        await s.w('.scr.on [data-action=continue]').click();
        const f = await s.page.evaluate(() => {
          const a = document.getElementById('call-center-widget-host')!.shadowRoot!.activeElement;
          return a ? { tag: a.tagName, inScreen: !!a.closest('.scr.on'), heading: /^H[1-6]$/.test(a.tagName) || a.hasAttribute('data-focus') } : null;
        });
        expect(f, 'focus on the step\'s heading').toEqual({ tag: expect.any(String), inScreen: true, heading: true });
      });
    });
  }

  test('focus lands on the next screen\'s heading after the pre-call form is sent', async ({ browser }) => {
    await withSession(browser, { brand: 'webyar', liveKit: { present: [] } }, async (s) => {
      await clickLauncher(s);
      await s.waitOpen(true);
      await s.w('.scr.on [data-action=voice]').click();
      await s.waitScreen('precall');
      await s.w('.scr.on [data-action=consent]').click();
      await s.w('.scr.on [data-action=submit]').focus();
      await s.page.keyboard.press('Enter');
      await s.waitScreen('queue');
      const f = await s.page.evaluate(() => {
        const a = document.getElementById('call-center-widget-host')!.shadowRoot!.activeElement;
        return a ? { inScreen: !!a.closest('.scr.on'), heading: /^H[1-6]$/.test(a.tagName) || a.hasAttribute('data-focus') } : null;
      });
      expect(f).toEqual({ inScreen: true, heading: true });
    });
  });

  test('aria-modal on phones only', async ({ browser }) => {
    for (const mobile of [false, true]) {
      await withSession(browser, { brand: 'respok', mobile }, async (s) => {
        await clickLauncher(s);
        await s.waitOpen(true);
        expect(await s.w('#ccw-panel').getAttribute('aria-modal'), mobile ? 'phone' : 'desktop').toBe(mobile ? 'true' : null);
      });
    }
  });
});

