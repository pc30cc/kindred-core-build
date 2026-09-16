/**
 * Composer behaviour, avatar rules, and conversation continuity across tabs.
 *
 * Real-browser on purpose: a file picker cannot open in jsdom, and "nothing
 * moves when you start typing" is a layout claim that only a layout engine
 * can answer.
 */
import { test, expect, type Page } from '@playwright/test';
import { activeView, boot, routeAll, thread } from './harness/widgetHarness';

/** Geometry of every composer control, keyed by name. */
async function controls(page: Page) {
  return page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
    };
    return {
      mic: box('.mic-btn'), send: box('.send-btn'),
      attach: box('.attach-btn'), emoji: box('.emoji-btn'),
      textarea: box('.input'),
    };
  });
}

test.describe('the composer never moves under the visitor', () => {
  test('no control shifts when a draft starts', async ({ page }) => {
    await routeAll(page, { threads: { c1: thread('c1') } });
    await boot(page, { resumeCid: 'c1' });
    // Anchor on the REAL composer, not on `.send-btn`: the skeleton draws a
    // send button too, so polling for one can measure `before` on the
    // skeleton and `after` on the real frame and call the handover a shift.
    // Only the real frame has a textarea behind `[data-msg-input]`.
    await page.locator('textarea[data-msg-input]').waitFor({ timeout: 15_000 });

    const before = await controls(page);
    await page.locator('[data-msg-input]').fill('سلام، یک پیام آزمایشی');
    await page.waitForTimeout(250);
    const after = await controls(page);

    // Every control keeps its exact box — including the mic, which used to
    // vanish the moment a draft existed. (The mic itself only renders where
    // MediaRecorder + getUserMedia exist, so it is compared, not required.)
    expect(after).toEqual(before);
    for (const key of ['send', 'attach', 'emoji'] as const) {
      expect(before[key], `${key} should be mounted`).not.toBeNull();
    }
  });

  test('send sits immediately to the right of attach', async ({ page }) => {
    await routeAll(page, { threads: { c1: thread('c1') } });
    await boot(page, { resumeCid: 'c1' });
    await expect.poll(async () => (await controls(page)).send !== null, { timeout: 15_000 }).toBe(true);

    const c = await controls(page);
    expect(c.send!.x).toBeGreaterThan(c.attach!.x);
    // Adjacent: nothing else fits between them.
    expect(c.send!.x - (c.attach!.x + c.attach!.w)).toBeLessThan(8);
  });

  test('the attach button opens a file picker', async ({ page }) => {
    // Regression: the panel carries `data-view` as a state marker, and the
    // navigation delegation used to match the panel itself for every click,
    // calling preventDefault() on all of them — which silently cancelled the
    // file picker (and every other native default inside the widget).
    await routeAll(page, { threads: { c1: thread('c1') } });
    await boot(page, { resumeCid: 'c1' });
    await page.locator('[data-attach-btn]').waitFor({ timeout: 15_000 });

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10_000 }),
      page.locator('[data-attach-btn]').click(),
    ]);
    expect(chooser.isMultiple()).toBe(false);
  });

  test('clicks inside the widget keep their native default', async ({ page }) => {
    await routeAll(page, { threads: { c1: thread('c1') } });
    await boot(page, { resumeCid: 'c1' });
    await page.locator('[data-msg-input]').waitFor({ timeout: 15_000 });

    const prevented = await page.evaluate(async () => {
      const input = document.querySelector('[data-msg-input]') as HTMLElement;
      let seen: boolean | null = null;
      const probe = (e: Event) => { seen = e.defaultPrevented; };
      document.addEventListener('click', probe, false);
      input.click();
      await new Promise((r) => setTimeout(r, 50));
      document.removeEventListener('click', probe, false);
      return seen;
    });
    expect(prevented).toBe(false);
  });
});

test.describe('an operator with no uploaded avatar shows no avatar at all', () => {
  test('no placeholder circle and no reserved gap', async ({ page }) => {
    await routeAll(page, { threads: { c1: thread('c1', { avatar: null }) } });
    await boot(page, { resumeCid: 'c1' });
    // Wait for REAL message rows — the welcome bubble is an operator row too.
    await expect.poll(
      async () => page.locator('.msg-row.operator .msg-col').count(), { timeout: 15_000 },
    ).toBeGreaterThan(0);

    expect(await page.locator('.msg-avatar').count()).toBe(0);
    expect(await page.locator('.msg-avatar-spacer').count()).toBe(0);

    // The bubble starts at the row's own edge — no empty avatar slot. Operator
    // rows sit on the physical LEFT in both LTR and RTL (the row flips its
    // flex direction to keep that true), so the leading edge is `left`.
    const gapPx = await page.evaluate(() => {
      const col = document.querySelector('.msg-row.operator .msg-col') as HTMLElement | null;
      if (!col) return null;
      const row = col.parentElement as HTMLElement;
      return Math.round(col.getBoundingClientRect().left - row.getBoundingClientRect().left);
    });
    expect(gapPx).toBe(0);
  });

  test('an uploaded avatar is still rendered', async ({ page }) => {
    const avatar = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2232%22 height=%2232%22%3E%3C/svg%3E';
    await routeAll(page, { threads: { c1: thread('c1', { avatar }) } });
    await boot(page, { resumeCid: 'c1' });
    await expect.poll(
      async () => page.locator('.msg-avatar.has-img').count(), { timeout: 15_000 },
    ).toBeGreaterThan(0);
  });
});

test.describe('a live conversation continues in a brand-new tab', () => {
  test('lands in the thread with no per-tab hint at all', async ({ page }) => {
    // No sessionStorage hint — exactly what a newly opened tab looks like.
    await routeAll(page, { threads: { c1: thread('c1') } });
    await boot(page);
    await expect.poll(() => activeView(page), { timeout: 15_000 }).toBe('chat');
    await expect.poll(
      async () => page.locator('.msg-row').count(), { timeout: 15_000 },
    ).toBeGreaterThan(1);
  });

  test('a resolved thread still leaves the visitor on home', async ({ page }) => {
    await routeAll(page, { threads: { c1: thread('c1') }, statuses: { c1: 'resolved' } });
    await boot(page);
    await page.waitForTimeout(3000);
    expect(await activeView(page)).toBe('home');
  });
});
