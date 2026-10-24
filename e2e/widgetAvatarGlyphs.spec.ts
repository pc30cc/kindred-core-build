/**
 * The avatar glyphs are painted (owner, 2026-10-24): a person without a
 * photo is the platform's person silhouette and the workspace without a
 * logo its storefront, never a letter. A renderer emits the tile empty and
 * its stylesheet draws the glyph as a `::before` masked with runtime.css's
 * `--wy-person` / `--wy-workspace`; src/test/widget/avatarGlyphs.test.ts
 * proves the tiles are empty, and this spec that a real browser paints a
 * glyph on each one: every empty tile in the panel (t1/t2 `.av` and the
 * home hero's `.logo`, `default`'s `.wy-avatar`, Core's smart row
 * `.msg-avatar.av`) has a `::before` with a box and the right glyph as its
 * mask, and no letter. Skeletons stay plain placeholders: no glyph on them.
 *
 * The fixture's workspace has no logo and its team no photos (but Sara's in
 * chat-operator); chat-handover's Mehdi has none; chat-ai-reply is the AI,
 * which without a logo of its own wears the workspace's storefront.
 *
 * Real browser (the template harness launches its own Chromium, the phone
 * states with touch); no running stack. Every wait is on a condition.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PERSON_SILHOUETTE, WORKSPACE_MARK } from '../shared/avatarGlyphs';
import { renderTemplateScreens, type ScreenOptions } from './harness/templateScreens';

const VARIANTS: Array<Omit<ScreenOptions, 'outDir' | 'states'>> = [
  { templateId: 'default', locale: 'fa', edition: 'iran' },
  { templateId: 't1', locale: 'fa', edition: 'iran' },
  { templateId: 't2', locale: 'fa', edition: 'iran' },
  { templateId: 't1-intl', locale: 'en', edition: 'international' },
  { templateId: 't2-intl', locale: 'en', edition: 'international' },
];

const STATES = [
  'home-first-visit', 'home-recent-chat', 'chat-operator', 'chat-handover', 'chat-ai-reply',
  'mobile-chat-operator', 'mobile-chat-handover',
];

interface Tile {
  cls: string;
  /** The tile's parent's class: where it sits (the header's `.who`, a message row, the home stack). */
  where: string;
  text: string;
  workspace: boolean;
  content: string;
  width: string;
  height: string;
  mask: string;
}

/**
 * Every empty avatar tile drawn under `scope` (the whole panel by default):
 * no picture in it, rendered, not a skeleton's placeholder.
 */
async function emptyTiles(page: Page, scope?: string): Promise<Tile[]> {
  return page.evaluate((scope) => {
    const sh = document.getElementById('gs-host')!.shadowRoot!;
    const root = scope ? sh.querySelector(scope) : sh;
    if (!root) return [];
    return Array.from(root.querySelectorAll('.av, .logo, .wy-avatar, .msg-avatar.av'))
      .filter((el) => !el.matches('.skc, .wy-sk, .wy-skeleton *') && !el.querySelector('img') && el.getClientRects().length > 0)
      .map((el) => {
        const b = getComputedStyle(el, '::before');
        return {
          cls: el.getAttribute('class') || '',
          where: el.parentElement?.getAttribute('class') || '',
          text: el.textContent || '',
          workspace: el.matches('.c4, .logo, .wy-avatar'),
          content: b.content,
          width: b.width,
          height: b.height,
          mask: b.getPropertyValue('mask-image') || b.getPropertyValue('-webkit-mask-image'),
        };
      });
  }, scope);
}

/** The glyph a mask wears, by its path (shared/avatarGlyphs.ts). */
function glyphOf(mask: string): 'person' | 'workspace' | null {
  let svg = mask;
  try { svg = decodeURIComponent(mask); } catch { /* left encoded: no path matches */ }
  if (svg.includes(PERSON_SILHOUETTE)) return 'person';
  if (svg.includes(WORKSPACE_MARK)) return 'workspace';
  return null;
}

/** Each tile paints its glyph: a `::before` with a box, the right mask, no letter in the tile. */
function expectPainted(tiles: Tile[], label: string) {
  for (const t of tiles) {
    const at = `${label}: <${t.cls}> in <${t.where}> ${JSON.stringify(t)}`;
    expect(t.content, at).not.toBe('none');
    expect(t.mask, at).toContain('svg');
    expect(glyphOf(t.mask), at).toBe(t.workspace ? 'workspace' : 'person');
    expect(parseFloat(t.width), at).toBeGreaterThan(0);
    expect(parseFloat(t.height), at).toBeGreaterThan(0);
    expect(/\p{L}|\p{N}/u.test(t.text), at).toBe(false);
  }
}

/**
 * The renderer's own loading skeletons of the chat and the pre-chat form
 * (whose bar holds an avatar's placeholder), drawn into the panel for a
 * moment: none of their boxes wears a glyph.
 */
async function skeletonGlyphs(page: Page, templateId: string, rtl: boolean) {
  return page.evaluate(({ templateId, rtl }) => {
    const sh = document.getElementById('gs-host')!.shadowRoot!;
    const w = window as unknown as Record<string, unknown>;
    const reg = w.__gs_presentation_registry as { resolve: (id: string) => { globalKey: string } };
    const mod = w[reg.resolve(templateId).globalKey] as { create: (env: Record<string, unknown>) => { skeletonHtml: (view: string, vm: Record<string, unknown>) => string } };
    const r = mod.create({ config: { workspaceName: 'Nilufar', showLogo: true, showTeamAvatars: true }, locale: rtl ? 'fa' : 'en' });
    const out: Array<{ view: string; boxes: number; glyphs: string[] }> = [];
    for (const view of ['chat', 'prechat']) {
      const probe = document.createElement('div');
      probe.setAttribute('data-glyph-probe', view);
      probe.innerHTML = r.skeletonHtml(view, { rtl, fields: 2, chatEnabled: true, composer: {} }) || '';
      sh.querySelector('.panel')!.appendChild(probe);
      const els = Array.from(probe.querySelectorAll('*'));
      const glyphs = els.filter((el) => {
        const b = getComputedStyle(el, '::before');
        const mask = b.getPropertyValue('mask-image') || b.getPropertyValue('-webkit-mask-image');
        return b.content !== 'none' && /svg/.test(mask);
      }).map((el) => el.getAttribute('class') || el.tagName);
      out.push({ view, boxes: els.length, glyphs });
      probe.remove();
    }
    return out;
  }, { templateId, rtl });
}

for (const v of VARIANTS) {
  const family = v.templateId === 'default' ? 'default' : 'tn';
  test(`${v.templateId}: every empty avatar paints its glyph (person or storefront), never a letter; skeletons none`, async () => {
    test.setTimeout(240_000);
    const out = mkdtempSync(path.join(os.tmpdir(), `avatar-glyphs-${v.templateId}-`));
    const seen: Record<string, Tile[]> = {};
    let smart: Tile[] = [];
    let skeletons: Awaited<ReturnType<typeof skeletonGlyphs>> = [];
    try {
      await renderTemplateScreens({
        ...v, outDir: out, states: v.templateId!.startsWith('t1') ? [...STATES, 'one-07-history', 'one-08-past-thread'] : STATES,
        beforeShot: async (page, state) => {
          const tiles = await emptyTiles(page, '.panel');
          expectPainted(tiles, `${v.templateId} ${state}`);
          seen[state] = tiles;
          if (state === 'chat-operator') skeletons = await skeletonGlyphs(page, v.templateId!, v.locale === 'fa');
          if (state === 'home-first-visit') {
            // Core's smart row (a proactive message as an operator's line): a
            // person for the team's first member, who has no photo.
            const shown = await page.evaluate(() => (window as unknown as { __inst: { showSmart: (s: Record<string, unknown>) => boolean } })
              .__inst.showSmart({ id: 'rule-1', mode: 'chat_message', body: 'Need a hand?', dismissible: true }));
            expect(shown, 'showSmart').toBe(true);
            await page.locator('.smart-msg-row .msg-avatar').waitFor();
            smart = await emptyTiles(page, '.smart-msg-row');
            expectPainted(smart, `${v.templateId} smart row`);
          }
        },
      });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    expect(Object.keys(seen).slice(0, STATES.length)).toEqual(STATES);
    const count = (state: string, workspace: boolean, where?: RegExp) =>
      seen[state].filter((t) => t.workspace === workspace && (!where || where.test(t.where))).length;

    // Core's smart row: the team's first member without a photo, a person.
    expect(smart.map((t) => t.workspace)).toEqual([false]);
    // The loading skeletons draw boxes, never a glyph (t2's bar avatar is .av.skc).
    expect(skeletons.map((s) => s.view)).toEqual(['chat', 'prechat']);
    for (const s of skeletons) {
      expect(s.boxes, `${s.view} skeleton`).toBeGreaterThan(0);
      expect(s.glyphs, `${s.view} skeleton`).toEqual([]);
    }

    if (family === 'default') {
      // `default` draws the workspace's tile in every header; operators
      // without a photo get no tile of their own in the thread.
      for (const state of STATES) expect(count(state, true, /wy-head/), state).toBe(1);
      return;
    }
    // The home: the hero's logo tile is the storefront, the team's tiles people.
    // t1 (one conversation per visitor): with a conversation, home is its one
    // card (the operator, a person); the team's stack is the first visit's.
    const oneChat = v.templateId!.startsWith('t1');
    for (const state of ['home-first-visit', 'home-recent-chat']) {
      expect(seen[state].filter((t) => /\blogo\b/.test(t.cls)), state).toHaveLength(1);
      expect(count(state, false), state).toBeGreaterThanOrEqual(oneChat && state === 'home-recent-chat' ? 1 : 3);
    }
    if (oneChat) {
      // History: Mehdi and Reza are people, the AI's old conversation the storefront;
      // a past thread's bar is Mehdi, never a presence.
      expect(count('one-07-history', false, /conv-row/)).toBe(2);
      expect(count('one-07-history', true, /conv-row/)).toBe(1);
      expect(count('one-08-past-thread', false, /\bwho\b/)).toBe(1);
    }
    // Mehdi (no photo) answering: the bar's tile and his lines' tiles are people.
    for (const state of ['chat-handover', 'mobile-chat-handover']) {
      expect(count(state, false, /\bwho\b/), state).toBe(1);
      expect(count(state, false, /msg-row/), state).toBeGreaterThanOrEqual(1);
    }
    // The AI without a logo of its own wears the workspace's storefront, in the bar and on its lines.
    expect(count('chat-ai-reply', true, /\bwho\b/)).toBe(1);
    expect(count('chat-ai-reply', false, /\bwho\b/)).toBe(0);
    expect(count('chat-ai-reply', true, /msg-row/)).toBeGreaterThanOrEqual(1);
  });
}
