/**
 * A conversation whose last message is an attachment is not an empty one.
 *
 * The visitor sends a photo, and later the conversation's row (home's card,
 * the history's list) said «هنوز پیامی نیست» — "no messages yet" — about
 * the conversation they were in. The row previews the message BODY, and
 * an attachment-only message has none.
 *
 * Real browser because the fix spans the shipped runtime's own localization:
 * the server sends a KIND, the widget writes the sentence.
 */
import { test, expect, type Page } from '@playwright/test';
import { boot, resolveChromium, routeAll, thread } from './harness/widgetHarness';

test.use({ launchOptions: { executablePath: resolveChromium() } });

/** Open the widget's conversation list (the history), with one conversation shaped by the server row. */
async function openHome(page: Page, row: Record<string, unknown>) {
  await routeAll(page, {
    threads: { c1: thread('c1') },
    // Closed on purpose: a LIVE thread (open, pending or resolved) takes the
    // visitor straight into the chat view (new-tab continuity); a closed one
    // is history (one conversation per visitor), where its row is listed.
    statuses: { c1: 'closed' },
    // An attachment-only last message: the server sends no preview text.
    conversationRows: { c1: { preview: '', ...row } },
  });
  await boot(page, {});
  await expect.poll(() => page.locator('[data-body] .home-link[data-view="list"]').count(), { timeout: 15_000 }).toBe(1);
  await page.locator('[data-body] .home-link[data-view="list"]').click();
  await expect.poll(async () => page.locator('.conv-preview').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
}

const previewText = (page: Page) =>
  page.locator('.conv-preview').first().innerText();

test.describe('an attachment-only conversation describes its media', () => {
  for (const [kind, sent, received] of [
    ['image', 'تصویر', 'تصویر'],
    ['audio', 'صوتی', 'صوتی'],
    ['video', 'ویدیو', 'ویدیو'],
    ['file', 'فایل', 'فایل'],
  ] as const) {
    test(`the visitor's own ${kind} reads as something they sent`, async ({ page }) => {
      await openHome(page, { attachmentKind: kind, outbound: true });
      const text = await previewText(page);
      expect(text).toContain(sent);
      expect(text).toContain('ارسال کردید');
      expect(text).not.toContain('هنوز پیامی نیست');
    });

    test(`an incoming ${kind} reads as something they received`, async ({ page }) => {
      await openHome(page, { attachmentKind: kind, outbound: false });
      const text = await previewText(page);
      expect(text).toContain(received);
      expect(text).toContain('دریافت کردید');
      expect(text).not.toContain('هنوز پیامی نیست');
    });
  }

  test('a genuinely empty conversation still says so', async ({ page }) => {
    // The "no messages yet" line is correct when there really are none —
    // the fix must not swallow it.
    await openHome(page, { attachmentKind: null, outbound: false });
    expect(await previewText(page)).toContain('هنوز پیامی نیست');
  });

  test('a caption wins over the media description', async ({ page }) => {
    // A message with BOTH text and an attachment previews its text; the
    // server only sends a kind when the body is empty.
    await openHome(page, { preview: 'این فاکتور است', attachmentKind: null });
    expect(await previewText(page)).toContain('این فاکتور است');
  });
});
