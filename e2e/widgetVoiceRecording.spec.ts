/**
 * Voice recording lives inside the composer pill.
 *
 * It used to open a second strip ABOVE the composer (the attachment tray)
 * while the pill sat there unchanged underneath — two competing surfaces for
 * one action. Now the pill itself becomes the recording row, WhatsApp-style,
 * and its geometry does not move a pixel.
 *
 * Real browser on purpose: MediaRecorder and getUserMedia do not exist in
 * jsdom, and "the pill did not change size" is a layout claim.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  FAKE_MEDIA_ARGS, SECURE_ORIGIN, boot, resolveChromium, routeAll, thread,
} from './harness/widgetHarness';

test.use({
  launchOptions: { executablePath: resolveChromium(), args: FAKE_MEDIA_ARGS },
  permissions: ['microphone'],
  ignoreHTTPSErrors: true,
});

const pillBox = (page: Page) => page.evaluate(() => {
  const el = document.querySelector('.input-wrap') as HTMLElement;
  const r = el.getBoundingClientRect();
  return { h: Math.round(r.height), w: Math.round(r.width), y: Math.round(r.y) };
});

const state = (page: Page) => page.evaluate(() => {
  const pill = document.querySelector('.input-wrap') as HTMLElement;
  const bar = document.querySelector('[data-rec-bar]') as HTMLElement | null;
  const pr = pill.getBoundingClientRect();
  const br = bar?.getBoundingClientRect();
  const tray = document.querySelector('[data-attach-tray]') as HTMLElement | null;
  return {
    recording: document.querySelector('[data-input-bar]')?.classList.contains('is-recording') ?? false,
    barVisible: !!br && br.height > 0,
    barInsidePill: !!br && br.top >= pr.top - 1 && br.bottom <= pr.bottom + 1,
    textareaVisible: (document.querySelector('.input') as HTMLElement)?.offsetParent !== null,
    micVisible: (document.querySelector('.mic-btn') as HTMLElement)?.offsetParent !== null,
    trayVisible: !!tray && !tray.hidden,
    timer: document.querySelector('[data-rec-timer]')?.textContent ?? null,
    chips: document.querySelectorAll('.attach-chip').length,
  };
});

async function openChat(page: Page) {
  await routeAll(page, { threads: { c1: thread('c1') } });
  await boot(page, { resumeCid: 'c1', origin: SECURE_ORIGIN });
  await page.locator('[data-msg-input]').waitFor({ timeout: 15_000 });
  // The mic only renders where MediaRecorder + getUserMedia exist.
  await page.locator('.mic-btn').waitFor({ timeout: 15_000 });
}

test.describe('voice recording takes over the composer pill', () => {
  test('the recording row sits inside the pill and the pill does not move', async ({ page }) => {
    await openChat(page);
    const before = await pillBox(page);

    await page.locator('.mic-btn').click();
    await expect.poll(async () => (await state(page)).recording, { timeout: 10_000 }).toBe(true);

    const s = await state(page);
    const after = await pillBox(page);

    // Same box, to the pixel — no reflow of the composer, no jump.
    expect(after).toEqual(before);
    expect(s.barVisible).toBe(true);
    expect(s.barInsidePill).toBe(true);
    // The textarea and the mic step aside rather than sitting alongside it.
    expect(s.textareaVisible).toBe(false);
    expect(s.micVisible).toBe(false);
    // And nothing opens above the composer any more.
    expect(s.trayVisible).toBe(false);
  });

  test('the elapsed time ticks', async ({ page }) => {
    await openChat(page);
    await page.locator('.mic-btn').click();
    await expect.poll(async () => (await state(page)).recording, { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => (await state(page)).timer, { timeout: 10_000 })
      .not.toBe('00:00');
  });

  test('the live indicator is actually painted', async ({ page }) => {
    // Regression: the old markup had a `.rec-dot` with no stylesheet rule at
    // all, so the "recording" indicator was an invisible zero-size span.
    await openChat(page);
    await page.locator('.mic-btn').click();
    await expect.poll(async () => (await state(page)).recording, { timeout: 10_000 }).toBe(true);

    const dot = await page.evaluate(() => {
      const el = document.querySelector('.rec-dot') as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), bg: getComputedStyle(el).backgroundColor };
    });
    expect(dot).not.toBeNull();
    expect(dot!.w).toBeGreaterThan(0);
    expect(dot!.h).toBeGreaterThan(0);
    expect(dot!.bg).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('cancelling returns the composer and attaches nothing', async ({ page }) => {
    await openChat(page);
    await page.locator('.mic-btn').click();
    await expect.poll(async () => (await state(page)).recording, { timeout: 10_000 }).toBe(true);

    await page.locator('[data-rec-cancel]').click();
    await expect.poll(async () => (await state(page)).recording, { timeout: 10_000 }).toBe(false);

    const s = await state(page);
    expect(s.textareaVisible).toBe(true);
    expect(s.micVisible).toBe(true);
    expect(s.chips).toBe(0);
  });

  test('confirming returns the composer and leaves a pending voice note', async ({ page }) => {
    await openChat(page);
    await page.locator('.mic-btn').click();
    await expect.poll(async () => (await state(page)).recording, { timeout: 10_000 }).toBe(true);
    await page.waitForTimeout(700);

    await page.locator('[data-rec-stop]').click();
    await expect.poll(async () => (await state(page)).recording, { timeout: 10_000 }).toBe(false);
    await expect.poll(async () => (await state(page)).chips, { timeout: 10_000 }).toBe(1);

    expect((await state(page)).textareaVisible).toBe(true);
  });
});
