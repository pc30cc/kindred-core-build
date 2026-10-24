/**
 * The launcher's styles (issue #340, g5-1, option A; WebYar board 11, RESPOK
 * board 10): the pill with its text inside, the classic bubble, two bubbles
 * and the agent's face, under `fab.shape` / `fab.icon`
 * (shared/launcherStyles.ts).
 *
 *   - The loader (every page view) only wires classes and texts onto its own
 *     launcher and asks for public/widget/runtime-fab.css when /config names
 *     it (`fabStyleUrl`, only for a workspace wearing a style): a launcher
 *     without one is byte for byte the one of the round's starting commit
 *     (a95fa39), in every edition. The styled launcher stays unseen until
 *     the stylesheet is in (or failed, after its canonical-name retry, or
 *     3 s passed); its look is all in the stylesheet, so without it today's
 *     launcher shows.
 *   - An icon named after an Object.prototype key draws the chat glyph.
 *   - runtime-fab.css follows the template stylesheet rules (no font, no
 *     host, small inline SVGs), draws the glyphs of LAUNCHER_GLYPHS, moves
 *     nothing (reduced motion) and keeps a keyboard focus ring.
 *
 * @vitest-environment jsdom
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  FAB_ICON_IDS, FAB_SHAPES, LAUNCHER_AVATAR, LAUNCHER_GLYPHS, STYLED_FAB_ICONS, launcherInitial, resolveLauncherStyle,
} from '../../../shared/launcherStyles';
import { PERSON_SILHOUETTE } from '../../../shared/avatarGlyphs';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const LOADER_SRC = read('public/widget/loader.js');
/**
 * What a launcher without a style must still be: the snapshots the loader the
 * round started from (a95fa39) gives, kept as a fixture so the test needs no
 * git history (CI checks out one commit). Regenerate with
 * UPDATE_LAUNCHER_FIXTURE=1 where that commit is in the local history.
 */
const FIXTURE = resolve(process.cwd(), 'src/test/widget/fixtures/launcherWithoutStyle.json');
const UPDATE_FIXTURE = process.env.UPDATE_LAUNCHER_FIXTURE === '1';
const fixture: Record<string, Snapshot> = UPDATE_FIXTURE ? {} : JSON.parse(read('src/test/widget/fixtures/launcherWithoutStyle.json'));
let startingLoader: string | null = null;
async function startingSnapshot(key: string, config: Record<string, unknown>): Promise<Snapshot> {
  if (!UPDATE_FIXTURE) return settledSnapshot(fixture[key]);
  startingLoader ??= execFileSync('git', ['show', 'a95fa39:public/widget/loader.js'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  fixture[key] = await snapshot(config, startingLoader);
  return fixture[key];
}
afterAll(() => { if (UPDATE_FIXTURE) writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`); });
const FAB_CSS = read('public/widget/runtime-fab.css');
/** The phone shell's rules, behind `max-width: 640px` in the starting commit. */
const PHONE_SHELL = '.shell.gs-mobile-open{top:0;left:0;right:0;bottom:auto;width:100vw;height:var(--gs-vvh,100dvh);}'
  + '.shell.gs-mobile-open .launcher,.shell.gs-mobile-open .fab-label,.shell.gs-mobile-open .smart-nudge{display:none!important;}';
const FAB_URL = 'https://app.test/widget/runtime-fab.0123abcd.css';

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(payload), text: () => Promise.resolve(JSON.stringify(payload)), headers: { get: () => null } };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

function reset() {
  document.body.innerHTML = '';
  for (const key of Object.keys(window)) {
    if (key.indexOf('__gs') === 0) delete (window as unknown as Record<string, unknown>)[key];
  }
}

async function boot(config: Record<string, unknown>, src = LOADER_SRC) {
  const w = window as unknown as Record<string, unknown>;
  w.__gs_id = 'ws-test';
  w.__gs_api_base = 'https://api.test';
  w.fetch = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('/api/widget/bootstrap')) return Promise.resolve(jsonResponse({ session_token: 't', workspace_id: 'ws-test', availability: { state: 'online' } }));
    if (u.includes('/api/widget/config')) {
      return Promise.resolve(jsonResponse({ enabled: true, features: { chat: true }, primaryColor: '#3B82F6', templateId: 'default', locale: 'fa', fab: {}, loaderVersion: 'lv1', ...config }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  new Function(src).call(window);
  await flush();
  const root = document.querySelector('gs-widget')!.shadowRoot!;
  return { root, launcher: root.querySelector('.launcher') as HTMLButtonElement, shell: root.querySelector('.shell') as HTMLElement };
}

type Snapshot = { launcher: string; shell: string; card: string | null; styles: (string | null)[]; links: number };

/**
 * Without element.animate (jsdom) the entry is an `enter` class that two
 * animation frames take off the launcher and its card again; whether a
 * snapshot still holds it depends on the machine's load, so it is left out
 * on both sides (the fixture too).
 */
const settled = (html: string) => html.replace(/class="([^"]*)"/g, (_m, c: string) => `class="${c.split(' ').filter((x) => x !== 'enter').join(' ')}"`);
function settledSnapshot(s: Snapshot): Snapshot {
  return s && { ...s, launcher: settled(s.launcher), card: s.card === null ? null : settled(s.card) };
}

/** What the visitor's page holds of the launcher: its markup, the shell's classes, the kits' stylesheets. */
async function snapshot(config: Record<string, unknown>, src: string): Promise<Snapshot> {
  reset();
  const { root, launcher, shell } = await boot(config, src);
  const out = {
    launcher: settled(launcher.outerHTML),
    shell: shell.className,
    card: (() => { const card = root.querySelector('.gs-fab-label'); return card ? settled(card.outerHTML) : null; })(),
    styles: [...root.querySelectorAll('style')].map((s) => s.textContent),
    links: root.querySelectorAll('link[data-gs-fab]').length,
  };
  reset();
  return out;
}

beforeEach(() => { vi.useRealTimers(); reset(); });
afterEach(() => vi.restoreAllMocks());

describe('shared/launcherStyles', () => {
  it('normalises what a row holds: unknown icon → chat, unknown shape → circle, a pill needs its text', () => {
    expect(resolveLauncherStyle({})).toEqual({ shape: 'circle', icon: 'chat', styled: false });
    expect(resolveLauncherStyle({ shape: 'square', icon: 'headset' })).toEqual({ shape: 'square', icon: 'headset', styled: false });
    expect(resolveLauncherStyle({ shape: 'oval', icon: 'constructor' })).toEqual({ shape: 'circle', icon: 'chat', styled: false });
    expect(resolveLauncherStyle({ icon: '__proto__' }).icon).toBe('chat');
    expect(resolveLauncherStyle({ shape: 'pill', label: '  ' })).toEqual({ shape: 'circle', icon: 'chat', styled: false });
    expect(resolveLauncherStyle({ shape: 'pill', label: 'Questions? Ask us' })).toEqual({ shape: 'pill', icon: 'chat', styled: true });
    for (const icon of STYLED_FAB_ICONS) expect(resolveLauncherStyle({ icon }).styled, icon).toBe(true);
    for (const icon of ['chat', 'message', 'help', 'headset', 'phone', 'sparkles', 'smile']) expect(resolveLauncherStyle({ icon }).styled, icon).toBe(false);
    expect(FAB_SHAPES).toEqual(['circle', 'square', 'pill']);
  });

  it('the icons are the loader\'s own seven, then the three styles', () => {
    const block = LOADER_SRC.slice(LOADER_SRC.indexOf('var FAB_ICONS = {'), LOADER_SRC.indexOf('};', LOADER_SRC.indexOf('var FAB_ICONS = {')));
    const loaderIcons = [...block.matchAll(/^\s+([a-z]+): '/gm)].map((m) => m[1]);
    expect([...loaderIcons, ...STYLED_FAB_ICONS]).toEqual([...FAB_ICON_IDS]);
  });

  it('the initial is the first whole character of the first name that has one', () => {
    expect(launcherInitial(['سارا', 'مهدی'])).toBe('س');
    expect(launcherInitial(['', null, '  reza'])).toBe('r');
    expect(launcherInitial([undefined, '😀 team'])).toBe('😀');
    expect(launcherInitial([])).toBe('');
  });

  it('the initial is a character that shows: a mark pasted before a name is passed over, a name of marks only skipped', () => {
    // An RLM before a Persian name (pasted from an RTL app), a BOM, an LRM, a lone combining mark.
    expect(launcherInitial(['‏سارا'])).toBe('س');
    expect(launcherInitial(['﻿‎Sara'])).toBe('S');
    expect(launcherInitial(['́reza'])).toBe('r');
    // A ZWNJ, an embedding mark or a NUL alone: the next name's.
    expect(launcherInitial(['‌', '‫‬', '\u0000', 'نیلوفر'])).toBe('ن');
    expect(launcherInitial(['‏', null])).toBe('');
  });
});

describe('without a style, the launcher is the starting commit\'s, byte for byte', () => {
  it.each([
    ['no edition', {}],
    ['an older backend, a square, its own icon', { fab: { shape: 'square', icon: 'headset', label: 'Hi', scale: 120 } }],
    ['the Iranian edition (the kit)', { edition: 'iran' }],
    ['the Iranian edition, away, a square and a custom colour', { edition: 'iran', primaryColor: '#E11D48', availability: { state: 'offline' }, fab: { shape: 'square' } }],
    // A row with a style but a server from before the styles: no fabStyleUrl.
    ['a pill named without its stylesheet', { edition: 'iran', fab: { shape: 'pill', icon: 'bubble', label: 'Hi' } }],
  ])('%s', async (name, config) => {
    const before = await startingSnapshot(name, config);
    const after = await snapshot(config, LOADER_SRC);
    expect(after.launcher).toBe(before.launcher);
    expect(after.shell).toBe(before.shell);
    // The card beside it too (a pill not worn keeps its card).
    expect(after.card).toBe(before.card);
    // The kit's 18px square is one rule more in its stylesheet; the phone
    // shell's rules left their `max-width: 640px` block (a phone turned to
    // landscape keeps the full-screen panel, mobileRotation.test.ts): the
    // launcher's own rules are untouched; and a bubble beside it gives way
    // to the open panel (V-27), a rule about the bubble, not the launcher.
    expect(after.styles.map((s) => s!.replace('.launcher.lk-kit.square{border-radius:18px;}', '')
      .replace('.launcher.open~.smart-nudge{display:none!important;}', '')
      .replace(PHONE_SHELL, `@media(max-width:640px){${PHONE_SHELL}}`))).toEqual(before.styles);
    expect(after.links).toBe(0);
  }, 20_000);

  it('the International edition: the same launcher; the shell says the logo is Thread (lg-thread)', async () => {
    const before = await startingSnapshot('the International edition', { edition: 'international', templateId: 'intl' });
    const after = await snapshot({ edition: 'international', templateId: 'intl' }, LOADER_SRC);
    expect(after.launcher).toBe(before.launcher);
    expect(after.shell).toBe(`${before.shell} lg-thread`);
  });

  it('asks for no stylesheet and sets nothing of a style', async () => {
    const { root, launcher } = await boot({ edition: 'iran', fab: { icon: 'headset' } });
    expect(root.querySelector('link[data-gs-fab]')).toBeNull();
    expect(launcher.className).not.toMatch(/\bfx/);
    expect(launcher.hasAttribute('data-fx') || launcher.hasAttribute('data-fi') || launcher.hasAttribute('dir')).toBe(false);
    expect(launcher.style.visibility).toBe('');
  });
});

describe('an icon named after an Object.prototype key', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('%s draws the chat glyph, never prototype text', async (icon) => {
    const { launcher } = await boot({ fab: { icon } });
    expect(launcher.innerHTML).not.toMatch(/function|native code|\[object/);
    expect(launcher.querySelector('svg.chat-icon path')!.getAttribute('d')).toMatch(/^M21 11\.5a8\.38/);
  });
});

describe('a launcher wearing a style', () => {
  const pill = { fabStyleUrl: FAB_URL, fab: { shape: 'pill', icon: 'chat', label: 'سؤالی دارید؟ بپرسید' } };

  it('the pill: its stylesheet, its classes and text, no card beside it, named by its text', async () => {
    const { root, launcher } = await boot({ edition: 'iran', ...pill });
    const link = root.querySelector('link[data-gs-fab]') as HTMLLinkElement;
    expect(link.getAttribute('href')).toBe(FAB_URL);
    expect(link.rel).toBe('stylesheet');
    expect(link.parentNode).toBe(root);
    expect(launcher.classList.contains('lk-kit')).toBe(true);
    expect([...launcher.classList].filter((c) => /^fx/.test(c))).toEqual(['fx', 'fx-chat', 'fx-pill']);
    expect(launcher.getAttribute('data-fx')).toBe('سؤالی دارید؟ بپرسید');
    expect(launcher.dir).toBe('rtl');
    expect(root.querySelector('.gs-fab-label')).toBeNull();
    expect(launcher.getAttribute('aria-label')).toBe('سؤالی دارید؟ بپرسید');
    // The kit's glyph stays in the markup: the stylesheet only places it.
    expect(launcher.querySelector('svg.chat-icon.lk-kit-glyph')).not.toBeNull();
    (window as unknown as { __gs: { push: (c: unknown[]) => void } }).__gs.push(['setUnread', 2]);
    expect(launcher.getAttribute('aria-label')).toMatch(/^سؤالی دارید؟ بپرسید — /);
  });

  it('stays unseen until the stylesheet is in', async () => {
    const { root, launcher } = await boot(pill);
    expect(launcher.style.visibility).toBe('hidden');
    (root.querySelector('link[data-gs-fab]') as HTMLLinkElement).onload!(new Event('load'));
    expect(launcher.style.visibility).toBe('');
  });

  // Found in round 5's verification: the card beside a styled round launcher
  // showed (and slid in) alone while the launcher waited for its stylesheet.
  it('the card beside a styled launcher waits with it', async () => {
    const { root, launcher } = await boot({ fabStyleUrl: FAB_URL, fab: { shape: 'circle', icon: 'bubble', label: 'Hi', subLabel: 'Ask us' } });
    const card = root.querySelector('.gs-fab-label') as HTMLElement;
    expect(card.textContent).toBe('HiAsk us');
    expect(launcher.style.visibility).toBe('hidden');
    expect(card.style.visibility).toBe('hidden');
    const link = root.querySelector('link[data-gs-fab]') as HTMLLinkElement;
    link.onerror!(new Event('error'));
    (root.querySelector('link[data-gs-fab]') as HTMLLinkElement).onload!(new Event('load'));
    expect(launcher.style.visibility).toBe('');
    expect(card.style.visibility).toBe('');
    // A launcher without a style: its card shows at once (its markup is
    // the starting commit's, pinned above).
    reset();
    const plain = await boot({ fab: { label: 'Hi' } });
    expect((plain.root.querySelector('.gs-fab-label') as HTMLElement).style.visibility).toBe('');
  });

  it('a failed stylesheet is asked again once by its canonical name, then today\'s launcher shows', async () => {
    const { root, launcher } = await boot(pill);
    const first = root.querySelector('link[data-gs-fab]') as HTMLLinkElement;
    first.onerror!(new Event('error'));
    const retry = root.querySelector('link[data-gs-fab]') as HTMLLinkElement;
    expect(retry).not.toBe(first);
    expect(retry.getAttribute('href')).toBe('https://app.test/widget/runtime-fab.css?v=lv1');
    expect(root.querySelectorAll('link[data-gs-fab]')).toHaveLength(1);
    expect(launcher.style.visibility).toBe('hidden');
    retry.onerror!(new Event('error'));
    expect(launcher.style.visibility).toBe('');
    expect(launcher.querySelector('svg.chat-icon')).not.toBeNull();
  });

  it('shows after 3 s whatever the stylesheet does', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = window as unknown as Record<string, unknown>;
    w.__gs_id = 'ws-test';
    w.__gs_api_base = 'https://api.test';
    w.fetch = vi.fn((url: string) => Promise.resolve(jsonResponse(String(url).includes('/bootstrap')
      ? { session_token: 't', workspace_id: 'ws-test', availability: { state: 'online' } }
      : { enabled: true, features: { chat: true }, primaryColor: '#3B82F6', templateId: 'default', locale: 'en', ...pill })));
    new Function(LOADER_SRC).call(window);
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);
    const launcher = document.querySelector('gs-widget')!.shadowRoot!.querySelector('.launcher') as HTMLElement;
    expect(launcher.style.visibility).toBe('hidden');
    await vi.advanceTimersByTimeAsync(3000);
    expect(launcher.style.visibility).toBe('');
    expect(launcher.dir).toBe('ltr');
  });

  it('the agent\'s face: never a letter (its stylesheet draws the silhouette), the dot off while the team is away', async () => {
    const on = await boot({ fabStyleUrl: FAB_URL, fab: { shape: 'circle', icon: 'avatar', initial: 'س' } });
    expect(on.launcher.className).toMatch(/ fx fx-avatar fx-circle$/);
    // An older /config still names the letter; the launcher carries none.
    expect(on.launcher.hasAttribute('data-fi')).toBe(false);
    expect(on.launcher.textContent).not.toContain('س');
    // A label beside a round launcher stays a card.
    reset();
    const off = await boot({ fabStyleUrl: FAB_URL, availability: { state: 'offline' }, fab: { shape: 'circle', icon: 'avatar', initial: 'R', label: 'Hi' } });
    expect(off.launcher.className).toMatch(/ fx fx-avatar fx-circle fx-off$/);
    expect(off.root.querySelector('.gs-fab-label')!.textContent).toBe('Hi');
  });

  it('the bubble on RESPOK\'s button: the kit\'s glyph stays in the markup for the stylesheet to set aside', async () => {
    const { launcher, shell } = await boot({ edition: 'international', templateId: 't2-intl', templateOptions: { logoDirection: 'open' }, fabStyleUrl: FAB_URL, fab: { shape: 'square', icon: 'bubble' } });
    for (const c of ['rpk-kit', 'square', 'fx', 'fx-bubble', 'fx-square']) expect(launcher.classList.contains(c), c).toBe(true);
    expect(launcher.querySelector('svg.rpk-kit-o')).not.toBeNull();
    expect(shell.classList.contains('lg-open')).toBe(true);
  });
});

describe('runtime-fab.css', () => {
  it('follows the template stylesheet rules: no font, no host, small inline SVGs, within 2 KB in both builds', async () => {
    expect(FAB_CSS).not.toMatch(/@font-face|\.woff2?\b|@import|https?:\/\//);
    const urls = [...FAB_CSS.matchAll(/url\(\s*(['"]?)([^)]*?)\1\s*\)/g)].map((m) => m[2]);
    // The bubble, the two bubbles, the bubble's dots in a kit's colour, the agent's face.
    expect(urls).toHaveLength(4);
    for (const u of urls) {
      expect(u).toMatch(/^data:image\/svg\+xml,/);
      expect(u.length).toBeLessThanOrEqual(2048);
    }
    for (const brand of ['iran', 'respok']) {
      const out = execFileSync(process.execPath, [resolve(process.cwd(), 'scripts/build/widgetBrand.mjs'), brand, resolve(process.cwd(), 'public/widget/runtime-fab.css')], { encoding: 'utf8' });
      expect(gzipSync(Buffer.from(out), { level: 5 }).length, brand).toBeLessThanOrEqual(2000);
      // The masks survive the minifier with their -webkit- twins.
      expect(out).toContain('-webkit-mask:');
    }
  }, 30_000);

  it('draws exactly the glyphs of LAUNCHER_GLYPHS (the dashboard\'s picker draws the same)', () => {
    const svg = (cls: string) => decodeURIComponent(new RegExp(`\\.launcher\\.${cls} \\{ --fx: url\\("data:image/svg\\+xml,([^"]+)"\\); \\}`).exec(FAB_CSS)![1]);
    expect(svg('fx-bubble')).toContain(`fill-rule='evenodd' d='${LAUNCHER_GLYPHS.bubble}'`);
    expect(svg('fx-duo')).toContain(`d='${LAUNCHER_GLYPHS.duoBack}'`);
    expect(svg('fx-duo')).toContain(`d='${LAUNCHER_GLYPHS.duoFront}'`);
    expect(svg('fx-duo')).toContain("opacity='.75'");
    for (const cls of ['fx-bubble', 'fx-duo']) expect(svg(cls)).toContain("xmlns='http://www.w3.org/2000/svg'");
    expect(LAUNCHER_GLYPHS.bubble.endsWith(LAUNCHER_GLYPHS.bubbleDots)).toBe(true);
    // The agent's face: the platform's person silhouette in the disc's ink, over the disc.
    const face = /\.launcher\.fx-avatar::before \{([^}]+)\}/.exec(FAB_CSS)![1];
    const faceSvg = decodeURIComponent(/url\("data:image\/svg\+xml,([^"]+)"\)/.exec(face)![1]);
    expect(faceSvg).toContain(`fill='${LAUNCHER_AVATAR.ink}'`);
    expect(faceSvg).toContain(`d='${LAUNCHER_GLYPHS.face}'`);
    expect(faceSvg).toContain("xmlns='http://www.w3.org/2000/svg'");
    expect(LAUNCHER_GLYPHS.face).toBe(PERSON_SILHOUETTE);
    expect(face).toContain(`center / 62% no-repeat, ${LAUNCHER_AVATAR.disc};`);
    expect(face).toContain("content: '';");
  });

  // Found in round 5's verification: on RESPOK's own ground the classic
  // bubble's dots are Signal (board 10), not holes showing the Ink ground.
  it('the bubble\'s dots take a brand kit\'s second colour, under the bubble and any image; elsewhere nothing', () => {
    const rule = /\.launcher\.fx-bubble:not\(\.fx-pill\)::after \{([^}]+)\}/.exec(FAB_CSS)![1];
    expect(rule).toContain('background: var(--rpk-kit-accent, var(--lk-kit-dot));');
    expect(rule).toContain('z-index: -1;');
    const dots = decodeURIComponent(/--fx-dots: url\("data:image\/svg\+xml,([^"]+)"\)/.exec(rule)![1]);
    expect(dots).toContain(`d='${LAUNCHER_GLYPHS.bubbleDots}'`);
    // The kits define the colours the layer reads (the loader's own CSS).
    expect(LOADER_SRC).toMatch(/\.launcher\.rpk-kit\.rpk-kit-brand\{[^}]*--rpk-kit-accent:#FF5A3C;/);
    expect(LOADER_SRC).toMatch(/\.launcher\.lk-kit\.lk-kit-brand\{[^}]*--lk-kit-dot:#18AD94;/);
  });

  it('moves nothing of its own, keeps a focus ring, sets RTL by the launcher\'s dir, and guards the masks', () => {
    expect(FAB_CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/animation|transition|@keyframes/);
    expect(FAB_CSS).toMatch(/\.launcher\.fx:not\(\.rpk-kit\):focus-visible \{\s+outline: 2px solid/);
    expect(FAB_CSS).toContain(".launcher.fx-pill[dir='rtl'] { padding: 0 6px 0 20px; }");
    expect(FAB_CSS).toContain('@supports ((-webkit-mask: none) or (mask: none))');
    expect(FAB_CSS).toContain('.launcher.fx-avatar.fx-off::after { display: none; }');
    // Its own text attributes only, never markup; and the face is no letter (owner, 2026-10-24).
    expect(FAB_CSS).toContain('content: attr(data-fx)');
    expect(FAB_CSS).not.toContain('data-fi');
    expect(LOADER_SRC).not.toContain('data-fi');
  });
});
