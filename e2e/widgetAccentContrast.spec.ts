/**
 * V-22: the panel wears a readable accent. Core turns the colour on the
 * loader's shell into one whose ink reaches 4.5:1 (runtime.js
 * Util.readableAccent, `--gs-primary-aa` / `--gs-on-primary`) and puts it on
 * the shell, where `default`'s and `intl`'s stylesheets resolve --wy-accent:
 * a custom property inherits its value, so a token set lower down (once on
 * the panel) changed nothing and a light brand colour kept white ink.
 *
 * Real browser, the template screenshot harness (e2e/harness/templateScreens.ts):
 * the colours Chromium draws for the visitor's bubble.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderTemplateScreens } from './harness/templateScreens';

function luminance(rgb: number[]): number {
  const v = rgb.map((x) => { const c = x / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const channels = (css: string) => (css.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);

async function bubbleColours(page: Page): Promise<{ bg: string; ink: string }> {
  return page.evaluate(() => {
    const shadow = document.getElementById('gs-host')!.shadowRoot!;
    const bubble = shadow.querySelector('.msg.visitor') as HTMLElement;
    const cs = getComputedStyle(bubble);
    return { bg: cs.backgroundColor, ink: cs.color };
  });
}

const CASES = [
  // A light brand colour: its own hue, dark ink.
  { templateId: 'default', edition: 'iran', locale: 'fa', accent: '#F5C518', bg: [245, 197, 24] },
  { templateId: 'intl', edition: 'international', locale: 'en', accent: '#F5C518', bg: [245, 197, 24] },
  // A mid colour: darkened until white reaches 4.5:1.
  { templateId: 'default', edition: 'iran', locale: 'fa', accent: '#1F93FF', bg: null },
] as const;

for (const c of CASES) {
  test(`${c.templateId} · ${c.accent}: the visitor's bubble ink reaches 4.5:1`, async () => {
    test.setTimeout(120_000);
    const out = mkdtempSync(path.join(os.tmpdir(), `accent-${c.templateId}-`));
    const seen: Array<{ bg: string; ink: string }> = [];
    try {
      await renderTemplateScreens({
        templateId: c.templateId,
        edition: c.edition,
        locale: c.locale,
        accent: c.accent,
        states: ['chat-operator'],
        outDir: out,
        beforeShot: async (page) => { seen.push(await bubbleColours(page)); },
      });
      expect(seen).toHaveLength(1);
      const bg = channels(seen[0].bg);
      const ink = channels(seen[0].ink);
      expect(contrast(bg, ink)).toBeGreaterThanOrEqual(4.5);
      if (c.bg) expect(bg).toEqual(c.bg);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}

/** A computed colour as 0-255 channels (color-mix() comes back as `color(srgb r g b)`, 0-1). */
function rgbOf(css: string): number[] {
  const n = channels(css);
  return /^color\(srgb/.test(css) ? n.map((x) => Math.round(x * 255)) : n;
}

for (const c of CASES) {
  test(`${c.templateId} · ${c.accent}: the AI's sparkle under its bubble reaches 3:1 on the thread`, async () => {
    test.setTimeout(120_000);
    const out = mkdtempSync(path.join(os.tmpdir(), `accent-ai-${c.templateId}-`));
    const seen: Array<{ icon: string; under: string }> = [];
    try {
      await renderTemplateScreens({
        templateId: c.templateId,
        edition: c.edition,
        locale: c.locale,
        accent: c.accent,
        states: ['chat-handover'],
        outDir: out,
        beforeShot: async (page) => {
          seen.push(await page.evaluate(() => {
            const shadow = document.getElementById('gs-host')!.shadowRoot!;
            const badge = shadow.querySelector('.msg-ai-badge') as HTMLElement;
            // The colour it is drawn on: the first painted background up the tree.
            let el: HTMLElement | null = badge;
            let under = 'rgb(255, 255, 255)';
            while (el) {
              const bg = getComputedStyle(el).backgroundColor;
              if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { under = bg; break; }
              el = el.parentElement;
            }
            return { icon: getComputedStyle(badge).color, under };
          }));
        },
      });
      expect(seen).toHaveLength(1);
      expect(contrast(rgbOf(seen[0].icon), rgbOf(seen[0].under))).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}
