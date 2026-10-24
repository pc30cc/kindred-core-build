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

// One conversation per visitor (t1, the owner's decision of 2026-10-23): every
// one-* state renders on the phone (the desktop one in the panel), and each
// screen holds what the decision draws: the bar's middle tab is «گفتگو»,
// home shows one conversation door, history is a barless pushed screen whose
// back and close sit where a thread's do, a past thread is read-only, and a
// close is a line under which the visitor simply writes on.
test('t1: one conversation per visitor (the one-* states)', async () => {
  test.setTimeout(300_000);
  const out = mkdtempSync(path.join(os.tmpdir(), 'screens-t1-one-'));
  const facts: Record<string, Record<string, unknown>> = {};
  const states = Object.keys(SCREEN_STATES).filter((s) => s.startsWith('one-'));
  try {
    const files = await renderTemplateScreens({
      templateId: 't1',
      outDir: out,
      states,
      beforeShot: async (page, state) => {
        facts[state] = await page.evaluate(() => {
          const sr = document.getElementById('gs-host')!.shadowRoot!;
          const q = (sel: string) => sr.querySelector(sel) as HTMLElement | null;
          const at = [q('.panel [data-view-back]'), q('.panel-close')].map((e) => {
            if (!e || !e.offsetParent) return null;
            const r = e.getBoundingClientRect();
            return [Math.round(r.x), Math.round(r.y)];
          });
          const bar = q('[data-input-bar]');
          const hint = q('[data-chat-messages] .cl-h');
          return {
            view: q('.panel')!.getAttribute('data-view'),
            badge: q('.wy-tab[data-view="chat"] [data-tab-badge]:not([hidden])')?.textContent ?? null,
            tabs: !!q('.wy-tabs'),
            caption: q('.cd.rc .cap')?.textContent ?? null,
            team: !!q('.cd.team'),
            more: q('[data-body] .more[data-view="list"]')?.textContent ?? null,
            moreBadge: q('[data-body] .more[data-view="list"] .nb')?.textContent ?? null,
            menuBadge: q('[data-chat-menu-action="history"] .nb')?.textContent ?? null,
            newCard: !!q('.cd.cta:not(.ask)'),
            rows: Array.prototype.map.call(sr.querySelectorAll('.wy-view-list [data-conversation-open]'), (e: Element) => e.getAttribute('data-conversation-open')).join(','),
            pills: sr.querySelectorAll('.tg').length,
            closed: q('[data-chat-messages] .msg-day.cl')?.textContent ?? null,
            hint: !!hint && getComputedStyle(hint).display !== 'none',
            newDivider: Array.prototype.filter.call(sr.querySelectorAll('[data-chat-messages] .msg-day'), (e: Element) => /گفتگوی جدید/.test(e.textContent || '')).length,
            composer: !!bar && bar.style.display !== 'none',
            pastBar: q('[data-past-bar]')?.textContent ?? null,
            pastButton: !!q('[data-past-bar] .btn'),
            headerDot: !!q('[data-chat-header] .who .pr'),
            headerSub: q('[data-chat-header] .hs')?.textContent ?? null,
            menu: Array.prototype.map.call(sr.querySelectorAll('[data-chat-menu-action]'), (e: Element) => e.getAttribute('data-chat-menu-action')).join(','),
            back: at[0],
            close: at[1],
          };
        });
      },
    });
    expect(files).toHaveLength(states.length);
    for (const file of files) {
      const desk = file.endsWith('one-10-home-live-desktop.png');
      expect(pngSize(file), path.basename(file)).toEqual(desk ? { w: 800, h: 1440 } : { w: 780, h: 1688 });
    }
    const f = facts;
    // Home: one door; the tab carries the badge; history a link away.
    expect(f['one-01-home-first-visit']).toMatchObject({ view: 'home', team: true, more: null, newCard: false, badge: null });
    expect(f['one-02-home-live']).toMatchObject({ caption: 'گفتگوی شما', team: false, more: 'گفتگوهای قبلی', moreBadge: null, newCard: false, badge: '۲' });
    // Resolved is not ended for the visitor: still their conversation.
    expect(f['one-20-home-resolved']).toMatchObject({ caption: 'گفتگوی شما', team: false, more: 'گفتگوهای قبلی' });
    // An unseen answer in history: the link and the ⋯ item count it.
    expect(f['one-21-home-history-unread']).toMatchObject({ caption: 'گفتگوی شما', more: 'گفتگوهای قبلی۱', moreBadge: '۱' });
    expect(f['one-22-thread-menu-history-unread']).toMatchObject({ menu: 'history,transcript,sound', menuBadge: '۱' });
    expect(f['one-03-home-returning']).toMatchObject({ caption: null, team: true, more: 'گفتگوهای قبلی', newCard: false });
    expect(f['one-04-home-unread-closed']).toMatchObject({ caption: 'گفتگوی شما', badge: '۱' });
    // The thread's ⋯ offers history; a fresh thread's too.
    expect(f['one-05-thread-menu-open'].menu).toBe('history,transcript,sound');
    expect(f['one-18-fresh-thread-menu'].menu).toBe('history,sound');
    // A close while the visitor reads: the line, its hint, the composer; writing goes on under it.
    expect(f['one-06-thread-closed-line']).toMatchObject({ closed: 'سارا گفتگو را به پایان رساند', hint: true, composer: true });
    expect(f['one-11-thread-write-after-close']).toMatchObject({ closed: 'سارا گفتگو را به پایان رساند', hint: false, composer: true, newDivider: 0 });
    // History: no bar, no pills, finished ones only; back and close where the thread has them.
    expect(f['one-07-history']).toMatchObject({ view: 'list', tabs: false, pills: 0, rows: 'c-mahdi,c-reza,c-ai-old' });
    expect(f['one-07-history'].back).toEqual(f['one-08-past-thread'].back);
    expect(f['one-07-history'].close).toEqual(f['one-08-past-thread'].close);
    // A past thread: read-only, who and when, no presence; its way to the current one.
    expect(f['one-08-past-thread']).toMatchObject({
      composer: false, pastButton: false, headerDot: false, headerSub: 'مهدی · دیروز', menu: 'transcript',
      pastBar: 'این گفتگو به پایان رسیده و فقط خواندنی استگفتگوی فعلی',
    });
    expect(f['one-16-past-thread-no-line']).toMatchObject({ composer: false, closed: null, headerSub: 'رضا · ۵ روز پیش' });
    expect(f['one-17-past-thread-nothing-current']).toMatchObject({ composer: false, pastButton: true });
    // A fresh thread's header: the store and «آنلاین» (its welcome says the reply time).
    expect(f['one-09-fresh-thread']).toMatchObject({ view: 'chat', headerSub: 'آنلاین', composer: true });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});


// One conversation per visitor in t2 (the owner's decision of 2026-10-23/24):
// every one-* state and t2's own (t2-one-*) renders on the phone, and each
// screen holds what the decision draws in t2: home continues the current
// conversation (whatever its status) and links to the earlier ones, with no
// «گفتگوهای شما» count row; history has a back and no floating "new
// conversation" or pills; a past thread is read-only (t2's locked composer,
// who and when in the bar, no presence, the transcript alone in its ⋯, the
// rating card still there); a close is a line under which the visitor
// writes on; a fresh thread's bar is the workspace with its reply time.
test('t2: one conversation per visitor (the one-* and t2-one-* states)', async () => {
  test.setTimeout(300_000);
  const out = mkdtempSync(path.join(os.tmpdir(), 'screens-t2-one-'));
  const facts: Record<string, Record<string, unknown>> = {};
  const states = Object.keys(SCREEN_STATES).filter((s) => s.startsWith('one-') || s.startsWith('t2-one-'));
  try {
    const files = await renderTemplateScreens({
      templateId: 't2',
      outDir: out,
      states,
      beforeShot: async (page, state) => {
        facts[state] = await page.evaluate(() => {
          const sr = document.getElementById('gs-host')!.shadowRoot!;
          const q = (sel: string) => sr.querySelector(sel) as HTMLElement | null;
          // The back shown (a loading view's is the skeleton's placeholder).
          const shown = (sel: string) => (Array.from(sr.querySelectorAll(sel)) as HTMLElement[]).find((e) => !!e.offsetParent) || null;
          const at = [shown('.panel [data-view-back], .panel .wy-skeleton .wy-back'), q('.panel-close')].map((e) => {
            if (!e || !e.offsetParent) return null;
            const r = e.getBoundingClientRect();
            return [Math.round(r.x), Math.round(r.y)];
          });
          const bar = q('[data-input-bar]');
          return {
            view: q('.panel')!.getAttribute('data-view'),
            continue: q('.wy-view-home .list > .r[data-conversation-open]')?.getAttribute('data-conversation-open') ?? null,
            continueBadge: q('.wy-view-home .list > .r[data-conversation-open] .nb')?.textContent ?? null,
            countRow: !!q('.wy-view-home .list [data-view="list"]'),
            more: q('[data-body] .more[data-view="list"]')?.textContent ?? null,
            moreBadge: q('[data-body] .more[data-view="list"] .nb')?.textContent ?? null,
            menuBadge: q('[data-chat-menu-action="history"] .nb')?.textContent ?? null,
            rows: Array.prototype.map.call(sr.querySelectorAll('.wy-view-list [data-conversation-open]'), (e: Element) => e.getAttribute('data-conversation-open')).join(','),
            rowH: Array.prototype.map.call(sr.querySelectorAll('.wy-view-list .inbox .ci, .wy-view-list .inbox .sk'), (e: Element) => Math.round(e.getBoundingClientRect().height)).join(','),
            pills: sr.querySelectorAll('.wy-view-list .pill').length,
            fab: !!q('.fab, .wy-fab'),
            title: q('.wy-view-list .ttl')?.textContent ?? null,
            closed: q('[data-chat-messages] .msg-system-pill')?.textContent ?? null,
            newDivider: Array.prototype.filter.call(sr.querySelectorAll('[data-chat-messages] .msg-day, [data-chat-messages] .msg-system-pill'), (e: Element) => /گفتگوی جدید/.test(e.textContent || '')).length,
            composer: !!bar && bar.style.display !== 'none',
            pastBar: q('[data-past-bar]')?.textContent ?? null,
            pastButton: !!q('[data-past-bar] > .btn[data-chat-current]'),
            pastLink: q('[data-past-bar] .box > .more[data-chat-current]')?.textContent ?? null,
            csat: !!q('[data-csat] [data-csat-rate]'),
            headerName: q('[data-chat-header] .who .nm')?.textContent ?? null,
            headerSub: q('[data-chat-header] .who .st')?.textContent ?? null,
            headerDot: !!q('[data-chat-header] .who .pr, [data-chat-header] .who .ondot'),
            headerStack: !!q('[data-chat-header] .avs'),
            menu: Array.prototype.map.call(sr.querySelectorAll('[data-chat-menu-action]'), (e: Element) => e.getAttribute('data-chat-menu-action')).join(','),
            back: at[0],
            close: at[1],
          };
        });
      },
    });
    expect(files).toHaveLength(states.length);
    for (const file of files) {
      const desk = file.endsWith('one-10-home-live-desktop.png');
      expect(pngSize(file), path.basename(file)).toEqual(desk ? { w: 800, h: 1440 } : { w: 780, h: 1688 });
    }
    const f = facts;
    // Home: the current one continues (whatever its status), history a quiet link; no count row.
    expect(f['one-01-home-first-visit']).toMatchObject({ view: 'home', continue: null, more: null, countRow: false });
    expect(f['one-02-home-live']).toMatchObject({ continue: 'c-sara', continueBadge: '۲', more: 'گفتگوهای قبلی', moreBadge: null, countRow: false });
    expect(f['one-20-home-resolved']).toMatchObject({ continue: 'c-sara', more: 'گفتگوهای قبلی' });
    expect(f['one-04-home-unread-closed']).toMatchObject({ continue: 'c-sara', continueBadge: '۱' });
    expect(f['one-03-home-returning']).toMatchObject({ continue: null, more: 'گفتگوهای قبلی', countRow: false });
    expect(f['one-12-home-live-away']).toMatchObject({ continue: 'c-sara', more: 'گفتگوهای قبلی' });
    // An unseen answer in history: the link and the ⋯ item count it.
    expect(f['one-21-home-history-unread']).toMatchObject({ more: 'گفتگوهای قبلی۱', moreBadge: '۱' });
    expect(f['one-22-thread-menu-history-unread']).toMatchObject({ menu: 'history,transcript,sound', menuBadge: '۱' });
    // The thread's ⋯ offers history first; a fresh thread's too; a past one's the transcript alone.
    expect(f['one-05-thread-menu-open'].menu).toBe('history,transcript,sound');
    expect(f['one-18-fresh-thread-menu'].menu).toBe('history,sound');
    expect(f['t2-one-past-thread-menu'].menu).toBe('transcript');
    // A close while the visitor reads: the line, the composer; writing goes on under it.
    expect(f['one-06-thread-closed-line']).toMatchObject({ closed: 'سارا گفتگو را به پایان رساند', composer: true });
    expect(f['one-11-thread-write-after-close']).toMatchObject({ closed: 'سارا گفتگو را به پایان رساند', composer: true, newDivider: 0 });
    // History: its title and back, no pills, no floating door; back and close where the thread has them.
    expect(f['one-07-history']).toMatchObject({ view: 'list', title: 'گفتگوهای قبلی', pills: 0, fab: false, rows: 'c-mahdi,c-reza,c-ai-old' });
    expect(f['one-13-history-empty']).toMatchObject({ view: 'list', rows: '', fab: false });
    expect(f['one-07-history'].back).toEqual(f['one-08-past-thread'].back);
    expect(f['one-07-history'].close).toEqual(f['one-08-past-thread'].close);
    // Loading, its rows are the loaded rows' boxes (nothing jumps when the list arrives), under the same bar.
    const rowH = String(f['one-07-history'].rowH).split(',');
    expect(rowH).toEqual([rowH[0], rowH[0], rowH[0]]);
    expect(f['one-15-history-loading'].rowH).toBe(Array(5).fill(rowH[0]).join(','));
    for (const state of ['one-13-history-empty', 'one-14-history-error', 'one-15-history-loading']) {
      expect([f[state].back, f[state].close], state).toEqual([f['one-07-history'].back, f['one-07-history'].close]);
    }
    // A past thread: read-only, who and when, no presence; the way to the current one where send sits.
    expect(f['one-08-past-thread']).toMatchObject({
      composer: false, pastButton: false, pastLink: 'گفتگوی فعلی', headerName: 'فروشگاه نیلوفر', headerSub: 'مهدی · دیروز', headerDot: false,
      menu: 'transcript', pastBar: 'این گفتگو به پایان رسیده و فقط خواندنی استگفتگوی فعلی',
    });
    expect(f['one-16-past-thread-no-line']).toMatchObject({ composer: false, closed: null, headerSub: 'رضا · ۵ روز پیش' });
    expect(f['one-17-past-thread-nothing-current']).toMatchObject({ composer: false, pastButton: true, pastLink: null });
    // Within its window the rating card stays under the close, in the past thread too.
    expect(f['t2-one-past-thread-csat']).toMatchObject({ composer: false, csat: true, closed: 'مهدی گفتگو را به پایان رساند' });
    // A fresh thread's bar: the workspace and its reply time, never «گفتگوی جدید» or the team's stack.
    expect(f['one-09-fresh-thread']).toMatchObject({ view: 'chat', headerName: 'فروشگاه نیلوفر', headerStack: false, composer: true });
    expect(f['one-09-fresh-thread'].headerSub).not.toBe('');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
