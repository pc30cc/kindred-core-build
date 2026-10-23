/**
 * Where a chat thread sits (owner, 2026-10-23): a short one starts at the top
 * of the panel in every template, as in `default`. t1 and t2 used to anchor
 * it to the message box (the 2026-10 handoff), so the AI's first answer sat
 * at the bottom under an empty panel. A thread longer than the panel still
 * shows its newest message, right above the message box.
 *
 * Real browser (the template harness launches its own Chromium, the phone
 * states with touch); no running stack. Every wait is on a condition.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderTemplateScreens, type ScreenOptions } from './harness/templateScreens';

const VARIANTS: Array<Omit<ScreenOptions, 'outDir' | 'states'>> = [
  { templateId: 'default', locale: 'fa', edition: 'iran' },
  { templateId: 'intl', locale: 'en', edition: 'international' },
  { templateId: 't1', locale: 'fa', edition: 'iran' },
  { templateId: 't1-intl', locale: 'en', edition: 'international' },
  { templateId: 't2', locale: 'fa', edition: 'iran' },
  { templateId: 't2-intl', locale: 'en', edition: 'international' },
];

/** The scroll area, its first and last rows, and how far it is scrolled. */
async function threadBox(page: Page) {
  return page.evaluate(() => {
    const sh = document.getElementById('gs-host')!.shadowRoot!;
    const list = sh.querySelector('[data-chat-messages]')!;
    let host: HTMLElement | null = list as HTMLElement;
    while (host && !(host.scrollHeight > 0 && /auto|scroll/.test(getComputedStyle(host).overflowY))) host = host.parentElement;
    const area = (host || list).getBoundingClientRect();
    // Its rows: the children of the thread (`.messages`, which t1 and t2 grow to fill the area).
    const thread = list.querySelector('.messages') || list;
    const rows = Array.from(thread.children).filter((el) => (el as HTMLElement).offsetHeight > 0);
    const first = rows[0].getBoundingClientRect();
    const last = rows[rows.length - 1].getBoundingClientRect();
    return {
      firstGap: Math.round(first.top - area.top),
      lastGap: Math.round(area.bottom - last.bottom),
      scrolled: host ? host.scrollTop : 0,
      overflows: host ? host.scrollHeight > host.clientHeight + 8 : false,
    };
  });
}

async function onStates(v: (typeof VARIANTS)[number], states: string[], check: (page: Page, state: string) => Promise<void>) {
  const out = mkdtempSync(path.join(os.tmpdir(), `thread-top-${v.templateId}-`));
  const checked: string[] = [];
  try {
    await renderTemplateScreens({ ...v, outDir: out, states, beforeShot: async (page, state) => { await check(page, state); checked.push(state); } });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  expect(checked).toEqual(states);
}

for (const v of VARIANTS) {
  test(`${v.templateId}: a short thread starts at the top of the panel, on a computer and on a phone`, async () => {
    test.setTimeout(120_000);
    await onStates(v, ['chat-ai-intro', 'mobile-chat-ai-intro', 'chat-ai-reply', 'mobile-chat-ai-reply', 'chat-ai-thinking'], async (page, state) => {
      const box = await threadBox(page);
      expect(box.overflows, state).toBe(false);
      // The panel's own padding (14-20 px) and a day label at most.
      expect(box.firstGap, `${state}: ${JSON.stringify(box)}`).toBeLessThanOrEqual(40);
      expect(box.lastGap, `${state}: ${JSON.stringify(box)}`).toBeGreaterThan(80);
    });
  });

  test(`${v.templateId}: a thread longer than the panel shows its newest message above the message box`, async () => {
    test.setTimeout(120_000);
    await onStates(v, ['chat-handover'], async (page, state) => {
      const box = await threadBox(page);
      expect(box.overflows, state).toBe(true);
      expect(box.scrolled, state).toBeGreaterThan(0);
      expect(box.lastGap, `${state}: ${JSON.stringify(box)}`).toBeLessThanOrEqual(30);
    });
  });
}
