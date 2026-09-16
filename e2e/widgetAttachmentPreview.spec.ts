/**
 * A pending file or image previews inside the composer pill.
 *
 * It used to be a chip in a strip ABOVE the composer, which pushed the whole
 * composer down the moment a file was picked. It is now a row of the pill
 * itself — but unlike a voice note it does not take the pill over: an
 * attachment usually wants a caption, so the textarea stays usable below it.
 *
 * Real browser on purpose: "the preview is inside the pill, above the input,
 * and the input is still clickable" is a layout claim, and jsdom has no
 * layout and no file picker.
 */
import { test, expect, type Page } from '@playwright/test';
import { boot, resolveChromium, routeAll, thread } from './harness/widgetHarness';

test.use({ launchOptions: { executablePath: resolveChromium() } });

/** A real 8x8 PNG, so the thumbnail has something to decode. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAF0lEQVR42mP8z8BQz0AEYBxVSF+'
  + 'FAAcQGAGkTsYYAAAAAElFTkSuQmCC',
  'base64',
);

const ATTACH_CONFIG = {
  attachments: {
    enabled: true, maxSizeMb: 10,
    allowedMimes: ['image/png', 'application/pdf'], voiceNotesEnabled: true,
  },
};

async function openChat(page: Page) {
  await routeAll(page, { threads: { c1: thread('c1') } });
  await boot(page, { resumeCid: 'c1', config: ATTACH_CONFIG });
  await page.locator('[data-msg-input]').waitFor({ timeout: 15_000 });
}

const pick = (page: Page, name: string, mimeType: string, buffer: Buffer) =>
  page.locator('[data-attach-input]').setInputFiles({ name, mimeType, buffer });

const state = (page: Page) => page.evaluate(() => {
  const pill = document.querySelector('.input-wrap') as HTMLElement;
  const prev = document.querySelector('[data-attach-preview]') as HTMLElement | null;
  const input = document.querySelector('[data-msg-input]') as HTMLElement;
  const img = document.querySelector('[data-attach-thumb-img]') as HTMLImageElement | null;
  const doc = document.querySelector('[data-attach-thumb-doc]') as HTMLElement | null;
  const pr = pill.getBoundingClientRect();
  const br = prev?.getBoundingClientRect();
  const ir = input.getBoundingClientRect();
  const shown = (el: Element | null) => !!el && el.getBoundingClientRect().height > 0;
  // What the visitor's pointer actually lands on at the middle of the input.
  const hit = document.elementFromPoint(ir.left + ir.width / 2, ir.top + ir.height / 2);
  return {
    pillHeight: Math.round(pr.height),
    visible: !!br && br.height > 0,
    insidePill: !!br && br.top >= pr.top - 1 && br.bottom <= pr.bottom + 1,
    aboveInput: !!br && br.bottom <= ir.top + 1,
    inputReachable: hit === input,
    inputHeight: Math.round(ir.height),
    imageThumb: shown(img) && !img!.hidden,
    docGlyph: shown(doc) && !doc!.hidden,
    thumbSquare: (() => {
      const t = document.querySelector('.att-preview-thumb') as HTMLElement | null;
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return Math.round(r.width) === Math.round(r.height) ? Math.round(r.width) : -1;
    })(),
    name: document.querySelector('[data-attach-name]')?.textContent ?? '',
    sub: document.querySelector('[data-attach-sub]')?.textContent ?? '',
    removeShown: shown(document.querySelector('[data-attach-remove]')),
    sendShown: shown(document.querySelector('[data-send-btn]')),
  };
});

test.describe('a pending attachment lives in the composer pill', () => {
  test('an image previews as itself, inside the pill and above the input', async ({ page }) => {
    await openChat(page);
    const before = await state(page);
    expect(before.visible).toBe(false);

    await pick(page, 'shot.png', 'image/png', PNG);
    await expect.poll(async () => (await state(page)).visible, { timeout: 10_000 }).toBe(true);

    const s = await state(page);
    expect(s.insidePill).toBe(true);
    expect(s.aboveInput).toBe(true);
    expect(s.imageThumb).toBe(true);
    expect(s.docGlyph).toBe(false);
    expect(s.thumbSquare).toBe(36);
    expect(s.name).toBe('shot.png');
    expect(s.removeShown).toBe(true);
    // The pill grows by exactly one row; the input row keeps its height.
    expect(s.pillHeight).toBeGreaterThan(before.pillHeight);
    expect(s.inputHeight).toBe(before.inputHeight);
  });

  test('a non-image keeps the document glyph, never an inline preview', async ({ page }) => {
    await openChat(page);
    await pick(page, 'invoice.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
    await expect.poll(async () => (await state(page)).visible, { timeout: 10_000 }).toBe(true);

    const s = await state(page);
    expect(s.docGlyph).toBe(true);
    expect(s.imageThumb).toBe(false);
    expect(s.name).toBe('invoice.pdf');
  });

  test('the visitor can still write a caption beside the attachment', async ({ page }) => {
    // The whole reason an attachment does not take the pill over the way a
    // voice note does. A real click first: an unreachable input would pass
    // `fill()` on a covered element but fail a visitor.
    await openChat(page);
    await pick(page, 'shot.png', 'image/png', PNG);
    await expect.poll(async () => (await state(page)).visible, { timeout: 10_000 }).toBe(true);

    expect((await state(page)).inputReachable).toBe(true);
    await page.locator('[data-msg-input]').click();
    await page.locator('[data-msg-input]').type('این فاکتور است');
    expect(await page.locator('[data-msg-input]').inputValue()).toBe('این فاکتور است');
    // Both go together through the one send button.
    expect((await state(page)).sendShown).toBe(true);
    expect((await state(page)).visible).toBe(true);
  });

  test('removing it returns the pill to exactly its original size', async ({ page }) => {
    await openChat(page);
    const before = await state(page);
    await pick(page, 'shot.png', 'image/png', PNG);
    await expect.poll(async () => (await state(page)).visible, { timeout: 10_000 }).toBe(true);

    await page.locator('[data-attach-remove]').click();
    await expect.poll(async () => (await state(page)).visible, { timeout: 10_000 }).toBe(false);
    expect((await state(page)).pillHeight).toBe(before.pillHeight);
  });

  test('a second attachment replaces the first rather than stacking', async ({ page }) => {
    await openChat(page);
    await pick(page, 'shot.png', 'image/png', PNG);
    await expect.poll(async () => (await state(page)).name, { timeout: 10_000 }).toBe('shot.png');
    const oneRow = (await state(page)).pillHeight;

    await pick(page, 'invoice.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
    await expect.poll(async () => (await state(page)).name, { timeout: 10_000 }).toBe('invoice.pdf');

    const s = await state(page);
    expect(s.pillHeight).toBe(oneRow);
    // The image thumbnail must not survive under the new file.
    expect(s.imageThumb).toBe(false);
    expect(s.docGlyph).toBe(true);
    expect(await page.locator('[data-attach-preview]').count()).toBe(1);
  });

  test('a failed upload says so and offers a retry', async ({ page }) => {
    await routeAll(page, { threads: { c1: thread('c1') } });
    // Break only the handshake that mints the attachment id.
    await page.route('**/api/widget/attachments/init', (r) =>
      r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
    await boot(page, { resumeCid: 'c1', config: ATTACH_CONFIG });
    await page.locator('[data-msg-input]').waitFor({ timeout: 15_000 });

    await pick(page, 'shot.png', 'image/png', PNG);
    await expect.poll(
      async () => page.locator('[data-attach-retry]').isVisible(), { timeout: 10_000 },
    ).toBe(true);
    await expect(page.locator('[data-attach-preview]')).toHaveClass(/is-error/);
    // Still removable, and the composer still works.
    expect((await state(page)).inputReachable).toBe(true);
  });
});
