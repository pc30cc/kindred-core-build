/**
 * In-panel call surface — real-browser layout.
 *
 * Core builds the whole call UI (`renderCallSurface`) but the stylesheet half
 * was never written: 29 of the 31 `gs-call-*` classes it emits had no rule at
 * all, so a visitor whose operator started a call got unstyled markup —
 * square default buttons, no dark stage, no picture-in-picture, the surface
 * collapsed to content height in the middle of a light panel.
 *
 * None of that is measurable in jsdom, which has no layout. A hermetic test
 * can also never reach a LiveKit server, so the phases the engine would drive
 * are set straight on the store through the test-only `callSurface` hook —
 * the real store, the real renderer, the real stylesheet.
 */
import { test, expect, type Page } from '@playwright/test';
import { boot, resolveChromium, routeAll, thread } from './harness/widgetHarness';

test.use({ launchOptions: { executablePath: resolveChromium() } });

type CallState = Record<string, unknown>;

async function openCall(page: Page, state: CallState) {
  await routeAll(page, { threads: { c1: thread('c1') } });
  await boot(page, { resumeCid: 'c1' });
  await drive(page, state);
}

async function drive(page: Page, state: CallState) {
  await page.evaluate(
    (s) => (window as unknown as { __inst: { __test: { callSurface: (x: unknown) => void } } })
      .__inst.__test.callSurface(s),
    state,
  );
  // One frame for the store subscriber to re-render and lay out.
  await page.waitForTimeout(120);
}

/** Geometry of the surface relative to the body it is supposed to own. */
const geometry = (page: Page) => page.evaluate(() => {
  const surf = document.querySelector('[data-call-surface]') as HTMLElement | null;
  if (!surf) return null;
  const body = surf.parentElement as HTMLElement;
  const s = surf.getBoundingClientRect();
  const b = body.getBoundingClientRect();
  const box = (sel: string) => {
    const el = surf.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      top: Math.round(r.top - s.top), left: Math.round(r.left - s.left),
      right: Math.round(s.right - r.right), bottom: Math.round(s.bottom - r.bottom),
      radius: cs.borderRadius, bg: cs.backgroundColor, display: cs.display,
    };
  };
  return {
    phase: surf.getAttribute('data-phase'),
    channel: surf.getAttribute('data-channel'),
    // The surface must own the body exactly — no light strip on any edge.
    inset: {
      top: Math.round(s.top - b.top), left: Math.round(s.left - b.left),
      right: Math.round(b.right - s.right), bottom: Math.round(b.bottom - s.bottom),
    },
    bg: getComputedStyle(surf).backgroundColor,
    bgImage: getComputedStyle(surf).backgroundImage,
    /** A call surface never scrolls — everything has to fit the panel. */
    overflowPx: surf.scrollHeight - surf.clientHeight,
    buttons: Array.from(surf.querySelectorAll('.gs-call-btn')).map((el) => {
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return {
        action: el.getAttribute('data-call-action'),
        w: Math.round(r.width), h: Math.round(r.height),
        radius: cs.borderRadius, bg: cs.backgroundColor,
      };
    }),
    stage: box('.gs-call-stage'), controls: box('.gs-call-controls'),
    topbar: box('.gs-call-topbar'), pip: box('.gs-call-pip'),
    remoteVideo: box('.gs-call-remote-video'),
    voiceStage: box('.gs-call-voice-stage'), orb: box('.gs-call-voice-orb'),
    eqBars: Array.from(surf.querySelectorAll('.gs-call-eq-bar'))
      .map((el) => Math.round(el.getBoundingClientRect().height)),
    back: box('.gs-call-btn-back'),
  };
});

test.describe('the call surface owns the panel', () => {
  for (const channel of ['audio', 'video'] as const) {
    test(`a ${channel} call fills the body on every edge, in every phase`, async ({ page }) => {
      await openCall(page, { phase: 'connecting', channel });
      for (const state of [
        { phase: 'connecting' },
        { phase: 'connected', connectedAt: Date.now() - 65_000, micEnabled: true },
        { phase: 'reconnecting' },
        { phase: 'ended', endedDuration: 65 },
        { phase: 'failed', error: { code: 'livekit_connect_failed', message: 'nope' } },
      ]) {
        await drive(page, { ...state, channel });
        const g = (await geometry(page))!;
        expect(g, `phase ${state.phase}`).not.toBeNull();
        // Before the stylesheet existed the body kept `padding: 14px 16px 4px`
        // and `.wy-scroll` reserved a 10px scrollbar gutter on each edge, so
        // the dark surface floated inside a light frame.
        expect(g.inset, `phase ${state.phase}`).toEqual({ top: 0, left: 0, right: 0, bottom: 0 });
        expect(g.overflowPx, `phase ${state.phase}`).toBe(0);
      }
    });
  }

  test('the stage is dark and takes every pixel the controls do not', async ({ page }) => {
    await openCall(page, { phase: 'connected', channel: 'video', connectedAt: Date.now() });
    const g = (await geometry(page))!;
    // A call is a distinct mode: the stage goes dark so white controls read.
    expect(g.bg).toBe('rgb(20, 22, 26)');
    expect(g.stage!.bg).toBe('rgb(13, 13, 15)');
    expect(g.stage!.w).toBe(g.controls!.w);
    expect(g.stage!.top).toBe(0);
    // Stage + control bar account for the whole panel, with no gap between
    // them and nothing left over.
    expect(g.stage!.h + g.controls!.h).toBe(680);
    expect(g.controls!.top).toBe(g.stage!.h);
    expect(g.controls!.bottom).toBe(0);
    expect(g.stage!.h).toBeGreaterThan(g.controls!.h * 3);
    // The remote video covers the stage rather than sitting in it.
    expect(g.remoteVideo!.w).toBe(g.stage!.w);
    expect(g.remoteVideo!.h).toBe(g.stage!.h);
  });

  test('an audio call gets its own gradient, a centred orb and a live equaliser', async ({ page }) => {
    await openCall(page, { phase: 'connected', channel: 'audio', connectedAt: Date.now() });
    const g = (await geometry(page))!;
    expect(g.bgImage).toContain('linear-gradient');
    expect(g.stage).toBeNull();
    expect(g.voiceStage!.w).toBe(420);
    // The orb is a real circle, horizontally centred in the panel.
    expect(g.orb!.w).toBe(g.orb!.h);
    expect(Math.abs(g.orb!.left - g.orb!.right)).toBeLessThanOrEqual(1);
    // Seven bars, each with a real resting height (they animate height, so a
    // missing base height left them 0px tall and invisible).
    expect(g.eqBars).toHaveLength(7);
    for (const h of g.eqBars) expect(h).toBeGreaterThan(0);
  });
});

test.describe('controls', () => {
  test('every control is a 52px circle and the mute state inverts it', async ({ page }) => {
    await openCall(page, { phase: 'connected', channel: 'video', micEnabled: true, cameraEnabled: true });
    let g = (await geometry(page))!;
    expect(g.buttons.map((b) => b.action)).toEqual(['mic', 'cam', 'hangup']);
    for (const b of g.buttons) {
      expect(b.w, b.action!).toBe(52);
      expect(b.h, b.action!).toBe(52);
      expect(b.radius, b.action!).toBe('50%');
    }
    // Live: translucent over the stage. Hang up: always red.
    expect(g.buttons[0].bg).toBe('rgba(255, 255, 255, 0.14)');
    expect(g.buttons[2].bg).toBe('rgb(229, 72, 77)');

    // Muted / camera stopped inverts to solid white, the way every call app
    // signals "this input is off".
    await drive(page, { phase: 'connected', channel: 'video', micEnabled: false, cameraEnabled: false });
    g = (await geometry(page))!;
    expect(g.buttons[0].bg).toBe('rgb(255, 255, 255)');
    expect(g.buttons[1].bg).toBe('rgb(255, 255, 255)');
  });

  test('a fourth control still fits without scrolling or shrinking', async ({ page }) => {
    await openCall(page, {
      phase: 'connected', channel: 'video', cameras: [{ id: 'a' }, { id: 'b' }],
    });
    const g = (await geometry(page))!;
    expect(g.buttons.map((b) => b.action)).toEqual(['mic', 'cam', 'switch-cam', 'hangup']);
    for (const b of g.buttons) expect(b.w).toBe(52);
    expect(g.overflowPx).toBe(0);
  });

  test('ended and failed swap the controls for a labelled way back to chat', async ({ page }) => {
    await openCall(page, { phase: 'ended', channel: 'audio', endedDuration: 65 });
    let g = (await geometry(page))!;
    expect(g.buttons).toHaveLength(0);
    expect(g.back!.h).toBeGreaterThan(30);
    expect(g.back!.w).toBeGreaterThan(80);

    await drive(page, { phase: 'failed', channel: 'video', error: { code: 'x', message: 'nope' } });
    g = (await geometry(page))!;
    expect(g.buttons).toHaveLength(0);
    expect(g.back).not.toBeNull();
  });
});

test.describe('overlays sit inside the stage', () => {
  test('the status bar and the picture-in-picture stay within the video', async ({ page }) => {
    await openCall(page, { phase: 'connected', channel: 'video', connectedAt: Date.now(), cameraEnabled: true });
    const g = (await geometry(page))!;
    // Both are absolutely positioned; an unstyled build stacked them in flow
    // and pushed the control bar off the bottom of the panel.
    expect(g.topbar!.top).toBe(12);
    expect(g.topbar!.left).toBe(12);
    expect(g.topbar!.right).toBe(12);
    expect(g.pip!.w).toBe(92);
    expect(g.pip!.h).toBe(124);
    expect(g.pip!.radius).not.toBe('0px');
    // Inside the stage, clear of the control bar below it.
    expect(g.pip!.top + g.pip!.h).toBeLessThanOrEqual(g.stage!.h);
    expect(g.overflowPx).toBe(0);
  });

  test('the picture-in-picture follows the writing direction', async ({ page }) => {
    // Persian is the widget's first language, so RTL is the default: the
    // self-view belongs on the left, mirroring the trailing edge.
    await openCall(page, { phase: 'connected', channel: 'video', cameraEnabled: true });
    const rtl = (await geometry(page))!;
    expect(rtl.pip!.left).toBe(14);
    expect(rtl.pip!.right).toBeGreaterThan(14);
  });

  test('a stopped camera shows the camera-off tile instead of the self-view', async ({ page }) => {
    await openCall(page, { phase: 'connected', channel: 'video', cameraEnabled: true });
    expect(await page.locator('.gs-call-pip-off').isVisible()).toBe(false);
    expect(await page.locator('.gs-call-local-video').isVisible()).toBe(true);

    await drive(page, { phase: 'connected', channel: 'video', cameraEnabled: false });
    expect(await page.locator('.gs-call-pip-off').isVisible()).toBe(true);
    expect(await page.locator('.gs-call-local-video').isVisible()).toBe(false);
  });
});

test('the composer and the tab bar step aside for a call', async ({ page }) => {
  await openCall(page, { phase: 'connected', channel: 'video' });
  const chrome = await page.evaluate(() => {
    const vis = (el: Element | null) => !!el && getComputedStyle(el as HTMLElement).display !== 'none';
    return {
      composer: vis(document.querySelector('.composer-zone')),
      tabs: Array.from(document.querySelectorAll('.tab')).some(vis),
    };
  });
  expect(chrome).toEqual({ composer: false, tabs: false });
});
