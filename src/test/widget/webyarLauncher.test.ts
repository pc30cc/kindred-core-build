/**
 * WebYar's floating button (the brand kit's floating-button/, ported into the
 * loader's launcher): worn by the chat widget's `default` template ONLY when
 * the bootstrap says the platform is the Iranian edition (`edition: 'iran'`).
 * An unknown edition and an older backend that sends none keep the launcher
 * exactly as it was; the International edition wears RESPOK's own button
 * (respokLauncher.test.ts).
 *
 * Boots the SHIPPED loader.js in jsdom (as publicApiBehavioral.test.ts does)
 * and checks the launcher's markup, classes and badge; and proves the
 * loader's copy of the kit is byte-identical with shared/webyarLauncher.ts,
 * the operator preview's.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  WEBYAR_LAUNCHER_CHAT_GLYPH,
  WEBYAR_LAUNCHER_CLOSE_GLYPH,
  WEBYAR_LAUNCHER_CSS,
} from '../../../shared/webyarLauncher';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const LOADER_SRC = read('public/widget/loader.js');

const OLD_LAUNCHER_HTML =
  '<svg class="chat-icon" viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>' +
  '<svg class="close-icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"></path></svg>';

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
      return Promise.resolve(jsonResponse({ enabled: true, features: { chat: true }, primaryColor: '#3B82F6', templateId: 'default', locale: 'fa', fab: {}, ...config }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  new Function(LOADER_SRC).call(window);
  await flush();
  const root = document.querySelector('gs-widget')!.shadowRoot!;
  return { root, launcher: root.querySelector('.launcher') as HTMLButtonElement };
}

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
    expect(literal('WEBYAR_KIT_CSS')).toBe(WEBYAR_LAUNCHER_CSS);
    expect(literal('WEBYAR_KIT_CHAT_GLYPH')).toBe(WEBYAR_LAUNCHER_CHAT_GLYPH);
    expect(literal('WEBYAR_KIT_CLOSE_GLYPH')).toBe(WEBYAR_LAUNCHER_CLOSE_GLYPH);
    expect(read('src/components/app/widget/WidgetLivePreview.tsx')).toContain('WEBYAR_LAUNCHER_CSS');
  });

  it('honours reduced motion and adds no global script or inline handler', () => {
    expect(WEBYAR_LAUNCHER_CSS).toContain('@media(prefers-reduced-motion:reduce)');
    expect(WEBYAR_LAUNCHER_CSS).toContain('linear-gradient(140deg,#22D3B4,#0B7D6C)');
    expect(WEBYAR_LAUNCHER_CSS).toContain('background:#FFB423');
    expect(LOADER_SRC).not.toContain('WebyarLauncher');
    expect(WEBYAR_LAUNCHER_CHAT_GLYPH + WEBYAR_LAUNCHER_CLOSE_GLYPH).not.toMatch(/\son[a-z]+=/i);
  });
});

describe('the launcher per edition', () => {
  // The International edition wears RESPOK's own button instead
  // (src/test/widget/respokLauncher.test.ts), never WebYar's.
  it('international: never WebYar\'s kit', async () => {
    const { root, launcher } = await boot({ edition: 'international', templateId: 'intl' });
    expect(launcher.classList.contains('wy-kit')).toBe(false);
    expect(root.querySelector('style[data-wy-kit]')).toBeNull();
  });

  it.each([
    ['unknown (null)', { edition: null }],
    ['an older backend (no edition)', {}],
  ])('%s: exactly the old launcher, no kit style', async (_name, extra) => {
    const { root, launcher } = await boot(extra);
    expect(launcher.className.replace(/ enter$/, '')).toBe('launcher bottom-right revealed');
    expect(launcher.innerHTML).toBe(OLD_LAUNCHER_HTML);
    expect(root.querySelector('style[data-wy-kit]')).toBeNull();
    expect(root.querySelector('.shell')!.getAttribute('style')).toContain('--gs-fab-size: 56px');
  });

  it('Iran: the kit\'s gradient, bubble and chevron at 60px, with its stylesheet', async () => {
    const { root, launcher } = await boot({ edition: 'iran' });
    expect(launcher.classList.contains('wy-kit')).toBe(true);
    expect(launcher.classList.contains('wy-kit-brand')).toBe(true);
    expect(launcher.classList.contains('wy-kit-offline')).toBe(false);
    expect(launcher.querySelector('svg.chat-icon.wy-kit-glyph .wy-kit-body')).not.toBeNull();
    expect(launcher.querySelectorAll('svg.chat-icon .wy-kit-dot')).toHaveLength(3);
    expect(launcher.querySelector('svg.close-icon.wy-kit-glyph .wy-kit-chev')).not.toBeNull();
    expect(root.querySelector('style[data-wy-kit]')!.textContent).toBe(WEBYAR_LAUNCHER_CSS);
    expect(root.querySelector('.shell')!.getAttribute('style')).toContain('--gs-fab-size: 60px');
  });

  it('Iran with the International template id (never offered there) still keeps the old launcher', async () => {
    const { launcher } = await boot({ edition: 'iran', templateId: 'intl' });
    expect(launcher.classList.contains('wy-kit')).toBe(false);
  });

  it('Iran honours the workspace\'s colour, icon, size and position', async () => {
    const { root, launcher } = await boot({
      edition: 'iran', primaryColor: '#E11D48', position: 'bottom-left',
      fab: { icon: 'headset', scale: 120, iconColor: '#111111' },
    });
    expect(launcher.classList.contains('wy-kit')).toBe(true);
    expect(launcher.classList.contains('wy-kit-brand')).toBe(false);
    expect(launcher.classList.contains('bottom-left')).toBe(true);
    expect(launcher.style.color).toBe('rgb(17, 17, 17)');
    // Its own icon at rest; the kit's chevron for "open".
    expect(launcher.querySelector('svg.chat-icon')!.classList.contains('wy-kit-glyph')).toBe(false);
    expect(launcher.querySelector('svg.close-icon.wy-kit-glyph')).not.toBeNull();
    expect(root.querySelector('.shell')!.getAttribute('style')).toContain('--gs-fab-size: 72px');
    expect((root.querySelector('.shell') as HTMLElement).style.getPropertyValue('--gs-primary')).toBe('#E11D48');
  });

  it('Iran keeps a custom launcher image over the kit\'s bubble', async () => {
    const { launcher } = await boot({ edition: 'iran', fab: { imageUrl: 'https://cdn.example/fab.png' } });
    expect(launcher.classList.contains('has-image')).toBe(true);
    expect(launcher.querySelector('img.fab-img')!.getAttribute('src')).toBe('https://cdn.example/fab.png');
    expect(launcher.querySelector('svg.chat-icon.wy-kit-glyph')).not.toBeNull();
  });

  it('Iran outside working hours: the kit\'s offline look (only with the kit\'s colours)', async () => {
    const { launcher } = await boot({ edition: 'iran', availability: { state: 'offline' } });
    expect(launcher.classList.contains('wy-kit-offline')).toBe(true);
  });

  it('Iran: the unread badge is saffron-styled with Persian digits in Persian', async () => {
    await boot({ edition: 'iran', locale: 'fa' });
    (window as unknown as { __gs: { push: (c: unknown[]) => void } }).__gs.push(['setUnread', 3]);
    const launcher = document.querySelector('gs-widget')!.shadowRoot!.querySelector('.launcher')!;
    expect(launcher.querySelector('.badge')!.textContent).toBe('۳');
    expect(launcher.classList.contains('wy-kit-nudge')).toBe(true);
  });

  it('International: the badge keeps Latin digits and no nudge', async () => {
    await boot({ edition: 'international', templateId: 'intl', locale: 'fa' });
    (window as unknown as { __gs: { push: (c: unknown[]) => void } }).__gs.push(['setUnread', 3]);
    const launcher = document.querySelector('gs-widget')!.shadowRoot!.querySelector('.launcher')!;
    expect(launcher.querySelector('.badge')!.textContent).toBe('3');
    expect(launcher.classList.contains('wy-kit-nudge')).toBe(false);
  });
});
