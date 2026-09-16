/**
 * Widget chat scroll — the newest message must be fully visible.
 *
 * This is a real-browser test on purpose: the bug it guards is a LAYOUT
 * TIMING bug, and jsdom has no layout at all (`scrollHeight` is always 0,
 * `ResizeObserver` does not exist), so a unit test structurally cannot see
 * it. An image attachment is fetched with an auth header, turned into a
 * blob URL and only THEN laid out — long after any fixed timer — and it
 * grows its bubble from the 84px loading box to as much as 190px. Before
 * the fix that left the newest message ~90px below the visible edge.
 *
 * It needs no dev stack: every request, including the widget assets, is
 * served from disk through `page.route`.
 */
import { test, expect } from '@playwright/test';
import { boot, bottomState, routeAll, thread } from './harness/widgetHarness';

test.describe('widget chat opens scrolled to the newest message', () => {
  test('an image that lands late does not push the newest message out of view', async ({ page }) => {
    await routeAll(page, { threads: { c1: thread('c1', { image: true }) } });
    await boot(page, { resumeCid: 'c1' });

    await expect.poll(async () => (await bottomState(page)).rows, { timeout: 15_000 })
      .toBeGreaterThan(1);
    // Wait for the slow attachment to arrive and lay out at its real height.
    await expect.poll(async () => (await bottomState(page)).imageHeight, { timeout: 15_000 })
      .toBeGreaterThan(150);
    await page.waitForTimeout(500);

    const state = await bottomState(page);
    // Positive overflow means part of the last message is below the fold.
    expect(state.overflowPx).toBeLessThanOrEqual(0);
    expect(state.distanceFromBottom).toBeLessThanOrEqual(1);
  });

  test('a text-only thread opens flush with its last message', async ({ page }) => {
    await routeAll(page, { threads: { c1: thread('c1') } });
    await boot(page, { resumeCid: 'c1' });

    await expect.poll(async () => (await bottomState(page)).rows, { timeout: 15_000 })
      .toBeGreaterThan(1);
    const state = await bottomState(page);
    expect(state.overflowPx).toBeLessThanOrEqual(0);
    expect(state.distanceFromBottom).toBeLessThanOrEqual(1);
  });

  // NOTE: this one passes on the pre-fix runtime too. Re-entering a thread
  // repaints the surface (skeleton, then content), and replacing innerHTML
  // resets scrollTop, which makes the scroll listener recompute "stuck to
  // bottom" as true by accident. `resetScrollAnchor()` makes that intent
  // explicit instead of incidental; this test locks the behaviour so a future
  // change to the repaint path cannot quietly take it away.
  test('opening another thread starts at ITS newest message, not where the last one was scrolled', async ({ page }) => {
    await routeAll(page, { threads: { c1: thread('c1'), c2: thread('c2') } });
    await boot(page, { resumeCid: 'c1' });
    await expect.poll(async () => (await bottomState(page)).rows, { timeout: 15_000 })
      .toBeGreaterThan(1);

    // The visitor scrolls up to re-read something in this thread…
    await page.evaluate(() => {
      const host = document.querySelector('.wy-chat-scroll') as HTMLElement;
      host.scrollTop = 0;
      host.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(150);
    expect((await bottomState(page)).distanceFromBottom).toBeGreaterThan(50);

    // …and then opens a different one.
    await page.evaluate(() => {
      const w = window as unknown as { __inst: { __test: { openConversation: (c: string) => void } } };
      w.__inst.__test.openConversation('c2');
    });
    await expect.poll(async () => (await bottomState(page)).distanceFromBottom, { timeout: 15_000 })
      .toBeLessThanOrEqual(1);
    expect((await bottomState(page)).overflowPx).toBeLessThanOrEqual(0);
  });
});
