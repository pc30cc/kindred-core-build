/**
 * RESPOK's floating button (the brand kit's Thread chat button, ported into
 * the loader's launcher): worn by the chat widget's `intl` template ONLY when
 * the bootstrap says the platform is the International edition
 * (`edition: 'international'`, `templateId: 'intl'`). The Iranian edition
 * keeps WebYar's button (webyarLauncher.test.ts); an unknown edition and an
 * older backend keep the old launcher.
 *
 * Boots the SHIPPED loader.js in jsdom and checks the launcher's markup,
 * classes and badge; and proves the loader's copy of the kit is
 * byte-identical with shared/respokLauncher.ts, the operator preview's.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RESPOK_LAUNCHER_CHAT_GLYPH,
  RESPOK_LAUNCHER_CLOSE_GLYPH,
  RESPOK_LAUNCHER_CSS,
} from '../../../shared/respokLauncher';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const LOADER_SRC = read('public/widget/loader.js');

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(payload), text: () => Promise.resolve(JSON.stringify(payload)), headers: { get: () => null } };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

async function boot(config: Record<string, unknown>) {
  (window as unknown as Record<string, unknown>).__gs_id = 'ws-test';
  (window as unknown as Record<string, unknown>).__gs_api_base = 'https://api.test';
  (window as unknown as { fetch: unknown }).fetch = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('/api/widget/bootstrap')) return Promise.resolve(jsonResponse({ session_token: 't', workspace_id: 'ws-test', availability: { state: 'online' } }));
    if (u.includes('/api/widget/config')) {
      return Promise.resolve(jsonResponse({
        enabled: true, features: { chat: true }, primaryColor: '#3B82F6',
        edition: 'international', templateId: 'intl', locale: 'en', fab: {}, ...config,
      }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  new Function(LOADER_SRC).call(window);
  await flush();
  const root = document.querySelector('gs-widget')!.shadowRoot!;
  return { root, launcher: root.querySelector('.launcher') as HTMLButtonElement };
}
const push = (cmd: unknown[]) => (window as unknown as { __gs: { push: (c: unknown[]) => void } }).__gs.push(cmd);

beforeEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  for (const key of Object.keys(window)) {
    if (key.indexOf('__gs') === 0) delete (window as unknown as Record<string, unknown>)[key];
  }
});
afterEach(() => vi.restoreAllMocks());

describe('the loader carries the kit byte-for-byte', () => {
  it('its CSS and glyphs are the shared module\'s (the preview\'s) exactly', () => {
    const literal = (name: string) => {
      const m = new RegExp(`var ${name} = ("(?:[^"\\\\]|\\\\.)*");`).exec(LOADER_SRC);
      expect(m, name).not.toBeNull();
      return JSON.parse(m![1]) as string;
    };
    expect(literal('RESPOK_KIT_CSS')).toBe(RESPOK_LAUNCHER_CSS);
    expect(literal('RESPOK_KIT_CHAT_GLYPH')).toBe(RESPOK_LAUNCHER_CHAT_GLYPH);
    expect(literal('RESPOK_KIT_CLOSE_GLYPH')).toBe(RESPOK_LAUNCHER_CLOSE_GLYPH);
    expect(read('src/components/app/widget/WidgetLivePreview.tsx')).toContain('RESPOK_LAUNCHER_CSS');
  });

  it('is the kit\'s Thread design, honours reduced motion, adds no global script, handler or font request', () => {
    // The Thread symbol's two pills, exactly as the kit draws them.
    expect(RESPOK_LAUNCHER_CHAT_GLYPH).toContain('viewBox="0 0 104 92"');
    expect(RESPOK_LAUNCHER_CHAT_GLYPH).toContain('M21 0H41A21 21 0 0 1 62 21V21A21 21 0 0 1 41 42H4A4 4 0 0 1 0 38V21A21 21 0 0 1 21 0Z');
    expect(RESPOK_LAUNCHER_CHAT_GLYPH).toContain('M43 50H83A21 21 0 0 1 104 71V88A4 4 0 0 1 100 92H43A21 21 0 0 1 22 71V71A21 21 0 0 1 43 50Z');
    // Ink ground, Signal answer, Signal Deep badge, Away outline.
    expect(RESPOK_LAUNCHER_CSS).toContain('background:#16142B');
    expect(RESPOK_LAUNCHER_CSS).toContain('--rpk-kit-accent:#FF5A3C');
    expect(RESPOK_LAUNCHER_CSS).toContain('background:#D3361A');
    expect(RESPOK_LAUNCHER_CSS).toContain('--rpk-kit-away:#A9A7BC');
    // The answer pill slides in (360ms, the kit's curve).
    expect(RESPOK_LAUNCHER_CSS).toContain('rpk-kit-answer .36s cubic-bezier(.3,1.4,.5,1)');
    expect(RESPOK_LAUNCHER_CSS).toContain('@media(prefers-reduced-motion:reduce)');
    expect(LOADER_SRC).not.toContain('Respok.init');
    expect(LOADER_SRC).not.toContain('fonts.googleapis.com');
    expect(RESPOK_LAUNCHER_CHAT_GLYPH + RESPOK_LAUNCHER_CLOSE_GLYPH).not.toMatch(/\son[a-z]+=/i);
    expect(RESPOK_LAUNCHER_CSS).not.toMatch(/url\(|@import/);
  });
});

describe('the launcher per edition', () => {
  it('International: the kit\'s Ink button, pills and chevron at 60px, with its stylesheet', async () => {
    const { root, launcher } = await boot({});
    expect(launcher.classList.contains('rpk-kit')).toBe(true);
    expect(launcher.classList.contains('rpk-kit-brand')).toBe(true);
    expect(launcher.classList.contains('rpk-kit-away')).toBe(false);
    expect(launcher.classList.contains('wy-kit')).toBe(false);
    expect(launcher.querySelector('svg.chat-icon.rpk-kit-glyph .rpk-kit-q')).not.toBeNull();
    expect(launcher.querySelector('svg.chat-icon.rpk-kit-glyph .rpk-kit-a')).not.toBeNull();
    expect(launcher.querySelector('svg.close-icon.rpk-kit-glyph .rpk-kit-chev')).not.toBeNull();
    expect(root.querySelector('style[data-rpk-kit]')!.textContent).toBe(RESPOK_LAUNCHER_CSS);
    expect(root.querySelector('style[data-wy-kit]')).toBeNull();
    expect(root.querySelector('.shell')!.getAttribute('style')).toContain('--gs-fab-size: 60px');
  });

  it.each([
    ['Iran', { edition: 'iran', templateId: 'default' }],
    ['International with the Iranian template id', { templateId: 'default' }],
    ['unknown (null)', { edition: null, templateId: 'default' }],
    ['an older backend (no edition)', { edition: undefined, templateId: 'default' }],
  ])('%s: never RESPOK\'s kit', async (_name, extra) => {
    const { root, launcher } = await boot(extra);
    expect(launcher.classList.contains('rpk-kit')).toBe(false);
    expect(root.querySelector('style[data-rpk-kit]')).toBeNull();
  });

  it('honours the workspace\'s colour, icon, size and position', async () => {
    const { root, launcher } = await boot({
      primaryColor: '#E11D48', position: 'bottom-left',
      fab: { icon: 'headset', scale: 120, iconColor: '#111111' },
    });
    expect(launcher.classList.contains('rpk-kit')).toBe(true);
    expect(launcher.classList.contains('rpk-kit-brand')).toBe(false);
    expect(launcher.classList.contains('bottom-left')).toBe(true);
    expect(launcher.style.color).toBe('rgb(17, 17, 17)');
    // Its own icon at rest; the kit's chevron for "open".
    expect(launcher.querySelector('svg.chat-icon')!.classList.contains('rpk-kit-glyph')).toBe(false);
    expect(launcher.querySelector('svg.close-icon.rpk-kit-glyph')).not.toBeNull();
    expect(root.querySelector('.shell')!.getAttribute('style')).toContain('--gs-fab-size: 72px');
    expect((root.querySelector('.shell') as HTMLElement).style.getPropertyValue('--gs-primary')).toBe('#E11D48');
  });

  it('keeps a custom launcher image over the kit\'s pills', async () => {
    const { launcher } = await boot({ fab: { imageUrl: 'https://cdn.example/fab.png' } });
    expect(launcher.classList.contains('has-image')).toBe(true);
    expect(launcher.querySelector('img.fab-img')!.getAttribute('src')).toBe('https://cdn.example/fab.png');
    expect(launcher.querySelector('svg.chat-icon.rpk-kit-glyph')).not.toBeNull();
  });

  it('outside working hours: the away look (Away outline; the icon colour with a workspace colour)', async () => {
    const { launcher } = await boot({ availability: { state: 'offline' } });
    expect(launcher.classList.contains('rpk-kit-away')).toBe(true);
    expect(launcher.classList.contains('rpk-kit-brand')).toBe(true);
  });

  it('unread: Latin digits, the answer pill slides in, the badge bumps on the next message and keeps still when the count drops', async () => {
    const { launcher } = await boot({ locale: 'fa' });
    push(['setUnread', 1]);
    expect(launcher.querySelector('.badge')!.textContent).toBe('1');
    expect(launcher.querySelector('.badge')!.className).toBe('badge');
    expect(launcher.classList.contains('rpk-kit-arrive')).toBe(true);
    push(['setUnread', 3]);
    expect(launcher.querySelector('.badge')!.textContent).toBe('3');
    expect(launcher.querySelector('.badge')!.classList.contains('rpk-kit-bump')).toBe(true);
    push(['setUnread', 2]);
    expect(launcher.querySelector('.badge')!.classList.contains('rpk-kit-still')).toBe(true);
    expect(launcher.classList.contains('wy-kit-nudge')).toBe(false);
  });
});
