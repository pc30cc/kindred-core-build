/**
 * The template screenshot harness (e2e/harness/templateScreens.ts) keeps
 * working for every chat template the Iranian edition offers: the renderer
 * lanes compare its PNGs with the design's panels, so a harness that quietly
 * shoots the wrong template, size or scale would mislead them.
 *
 * Real browser (the harness launches its own Chromium); no running stack.
 */
import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCREEN_STATES, renderTemplateScreens } from './harness/templateScreens';

/** The states the renderer lanes asked for (the design's panels). */
const REQUIRED_STATES = [
  'home-first-visit', 'home-recent-chat', 'team-away', 'thread-typing', 'attachments-failed',
  'new-conversation-topics', 'recording', 'voice-preview', 'emoji-open', 'prechat-form-error',
  'away-message', 'messages-list', 'prechat-card-in-thread', 'help-list', 'article',
  'mobile-home', 'mobile-thread',
];

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): { w: number; h: number } {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

test('every state the renderer lanes need is there', () => {
  for (const name of REQUIRED_STATES) expect(SCREEN_STATES[name], name).toBeTruthy();
});

for (const templateId of ['default', 't1', 't2']) {
  test(`${templateId}: the panel at 400×720 and the phone at 390×844, both at 2×`, async () => {
    test.setTimeout(120_000);
    const out = mkdtempSync(path.join(os.tmpdir(), `screens-${templateId}-`));
    const mounted: string[] = [];
    try {
      const files = await renderTemplateScreens({
        templateId,
        outDir: out,
        states: ['home-first-visit', 'thread-typing', 'mobile-home'],
        // The registry resolves the template asked for, and its renderer is
        // the one on the page.
        beforeShot: async (page) => {
          mounted.push(await page.evaluate((id) => {
            const w = window as unknown as Record<string, unknown>;
            const registry = w.__gs_presentation_registry as { resolve: (id: string) => { id: string; globalKey: string } };
            const d = registry.resolve(id);
            return d && w[d.globalKey] ? d.id : 'missing';
          }, templateId));
        },
      });
      expect(files.map((f) => path.basename(f))).toEqual([
        `${templateId}--home-first-visit.png`, `${templateId}--thread-typing.png`, `${templateId}--mobile-home.png`,
      ]);
      expect(mounted).toEqual([templateId, templateId, templateId]);
      expect(pngSize(files[0])).toEqual({ w: 800, h: 1440 });
      expect(pngSize(files[1])).toEqual({ w: 800, h: 1440 });
      expect(pngSize(files[2])).toEqual({ w: 780, h: 1688 });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}

// Issue #340, round 4: once runtime-late.js showed the picker's search field,
// a `:has()` rule outranked `.epk[hidden]` and the CLOSED picker kept 290px
// inside the composer, pushing the thread up. The late pack as the live
// widget gets it (asked for after the first paint), the draft typed and the
// picker closed (06·1).
test('t1: the closed emoji picker takes no room once the late pack is in', async () => {
  test.setTimeout(120_000);
  const out = mkdtempSync(path.join(os.tmpdir(), 'screens-t1-epk-'));
  const checked: string[] = [];
  try {
    await renderTemplateScreens({
      templateId: 't1',
      outDir: out,
      states: ['t1-emoji-draft'],
      lateAfter: true,
      beforeShot: async (page, state) => {
        const picker = page.locator('[data-emoji-picker]');
        const button = page.locator('[data-emoji-btn]');
        const box = () => picker.evaluate((el) => ({ hidden: (el as HTMLElement).hidden, height: el.getBoundingClientRect().height }));
        // The room it takes in the composer's box, its margins and the box's
        // gap included: the box with it, less the box with it out of the
        // layout (put back in the same task, so nothing paints it).
        const room = () => picker.evaluate((el) => {
          const s = (el as HTMLElement).style, prev = s.display, wrap = el.parentElement!;
          const withIt = wrap.getBoundingClientRect().height;
          s.display = 'none';
          const without = wrap.getBoundingClientRect().height;
          s.display = prev;
          return withIt - without;
        });
        const inputTop = () => page.locator('[data-msg-input]').evaluate((el) => el.getBoundingClientRect().top);
        // The pack is in: Core's late module has shown the extras' search field.
        await expect(picker.locator('.ep-sr')).toHaveJSProperty('hidden', false, { timeout: 20_000 });
        expect(await box()).toEqual({ hidden: true, height: 0 });
        expect(await room()).toBe(0);
        const top = await inputTop();
        // Open, it is the taller picker with its field; closed again, no room at all.
        await button.click();
        await expect.poll(box).toEqual({ hidden: false, height: 290 });
        await button.click();
        await expect.poll(box).toEqual({ hidden: true, height: 0 });
        expect(await room()).toBe(0);
        expect(await inputTop()).toBe(top);
        checked.push(state);
      },
    });
    expect(checked).toEqual(['t1-emoji-draft']);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
