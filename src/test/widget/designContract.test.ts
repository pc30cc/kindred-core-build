import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Web Yar design contract lock.
 *
 * These tests do NOT merely assert that an element exists — they lock the
 * exact values taken from the design source (Web Yar Chat Widget), so a
 * future refactor cannot silently drift the typography, the chat header box
 * or the composer geometry.
 */

const RUNTIME_CSS = readFileSync('public/widget/runtime.css', 'utf8');
const PRES_CSS = readFileSync('public/widget/presentation-web-yar.css', 'utf8');
const RUNTIME_JS = readFileSync('public/widget/runtime.js', 'utf8');
const REGISTRY_SRC = readFileSync('public/widget/presentation-registry.js', 'utf8');
const RENDERER_SRC = readFileSync('public/widget/presentation-web-yar.js', 'utf8');

function renderer(cfgExtra: Record<string, unknown> = {}) {
  // eslint-disable-next-line no-new-func
  new Function(REGISTRY_SRC).call(window);
  // eslint-disable-next-line no-new-func
  new Function(RENDERER_SRC).call(window);
  return (window as any).__gs_presentation_web_yar.create({
    t: (k: string) => k,
    escapeHtml: (v: unknown) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string),
    config: {
      brandName: 'Acme',
      platformName: 'Web Yar',
      launcherText: 'با ما گفتگو کنید',
      attachments: { enabled: true, voiceNotesEnabled: true },
      composer: { emojiEnabled: true },
      ...cfgExtra,
    },
    locale: 'fa',
    primaryColor: '#1f93ff',
  });
}

function chatDom(vm: Record<string, unknown> = {}) {
  // jsdom has neither MediaRecorder nor getUserMedia; the design's mic button
  // is gated on real voice support, so stub it for the markup contract.
  (window as any).MediaRecorder = function () {};
  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => {} }, configurable: true });
  }
  const R = renderer();
  const el = document.createElement('div');
  el.innerHTML = R.chatFrameHtml({
    config: { attachments: { enabled: true, voiceNotesEnabled: true }, composer: { emojiEnabled: true } },
    brandName: 'Acme',
    headerTitle: 'با ما گفتگو کنید',
    chatEnabled: true,
    locale: 'fa',
    ...vm,
  });
  return el;
}

describe('typography ownership', () => {
  it('core runtime.css declares no font-family and loads no webfont', () => {
    expect(RUNTIME_CSS).not.toMatch(/font-family\s*:/);
    expect(RUNTIME_CSS).not.toMatch(/@font-face/);
    expect(RUNTIME_CSS).not.toMatch(/Vazirmatn/);
  });

  it('presentation owns IRANSans (fa) and Inter (ltr)', () => {
    expect(PRES_CSS).toMatch(/@font-face[^}]*'IRANSans'[^}]*font-weight:\s*400[^}]*iransans-400\.woff2/);
    expect(PRES_CSS).toMatch(/@font-face[^}]*'IRANSans'[^}]*font-weight:\s*500[^}]*iransans-500\.woff2/);
    expect(PRES_CSS).toMatch(/@font-face[^}]*'IRANSans'[^}]*font-weight:\s*700[^}]*iransans-700\.woff2/);
    expect(PRES_CSS).toMatch(/\.shell \*\s*\{\s*\n?\s*font-family: 'IRANSans'/);
    expect(PRES_CSS).toMatch(/font-family: 'InterWY'/);
  });

  it('never declares an IRANSans 600 face (no such file ships)', () => {
    const faces = PRES_CSS.match(/@font-face[^}]*'IRANSans'[^}]*}/g) || [];
    expect(faces.some((f) => /font-weight:\s*600/.test(f))).toBe(false);
  });
});

describe('chat header design contract', () => {
  it('titles the header with the workspace brand, never launcher_text', () => {
    const el = chatDom();
    const header = el.querySelector('[data-chat-header]')!;
    expect(header.textContent).toContain('Acme');
    expect(el.innerHTML).not.toContain('با ما گفتگو کنید');
  });

  it('core no longer derives the header title from launcherText', () => {
    expect(RUNTIME_JS).not.toMatch(/headerTitle\s*=\s*\(config\.launcherText/);
  });

  it('locks the design header box', () => {
    expect(PRES_CSS).toMatch(/\.wy-head-chat\s*\{[^}]*padding:\s*16px/);
    expect(PRES_CSS).not.toMatch(/\.wy-head-chat\s*\{[^}]*height:\s*68px/);
    expect(PRES_CSS).not.toMatch(/\.wy-head-chat\s*\{[^}]*border-bottom/);
    expect(PRES_CSS).toMatch(/\.wy-head-chat \.wy-back\s*\{[^}]*padding:\s*4px/);
    expect(PRES_CSS).toMatch(/\.wy-avatar\s*\{[^}]*width:\s*2\.75rem/);
    expect(PRES_CSS).toMatch(/\.wy-head-chat \.wy-head-title\s*\{[^}]*font-size:\s*15px/);
    expect(PRES_CSS).toMatch(/\.wy-head-chat \.wy-head-sub\s*\{[^}]*font-size:\s*12px/);
    expect(PRES_CSS).toMatch(/\.wy-head-chat \.wy-online-dot\s*\{[^}]*width:\s*8px/);
  });
});

describe('typing state', () => {
  it('keeps the typing hooks but renders no visible typing row', () => {
    const el = chatDom();
    expect(el.querySelectorAll('[data-typing-row]').length).toBe(1);
    expect(el.querySelectorAll('[data-typing-label]').length).toBe(1);
    expect(el.querySelector('[data-typing-row]')!.classList.contains('sr-only')).toBe(true);
    expect(el.querySelectorAll('.typing-row').length).toBe(0);
  });
});

describe('composer design contract', () => {
  it('keeps the whole composer in ONE pill: mic, textarea, then actions', () => {
    const el = chatDom();
    const bar = el.querySelector('[data-input-bar]')!;
    const wrap = el.querySelector('[data-input-wrap]')!;
    expect(bar.querySelector(':scope > [data-mic-btn]')).toBeNull();
    // Mic is the first child inside the pill, ahead of the textarea.
    expect(wrap.firstElementChild!.getAttribute('data-mic-btn')).not.toBeNull();
    expect(wrap.querySelector('.composer-actions [data-send-btn]')).toBeTruthy();
    expect(wrap.querySelector('.composer-actions-start [data-attach-btn]')).toBeTruthy();
    expect(wrap.querySelector('.composer-actions-start [data-emoji-btn]')).toBeTruthy();
  });

  it('uses a real single-row textarea', () => {
    const input = chatDom().querySelector('[data-msg-input]') as HTMLTextAreaElement;
    expect(input.tagName).toBe('TEXTAREA');
    expect(input.getAttribute('rows')).toBe('1');
  });

  it('mic and send are mutually exclusive by draft state', () => {
    expect(PRES_CSS).toMatch(/\.input-bar:not\(\.has-draft\) \.send-btn\s*\{\s*display:\s*none/);
    expect(PRES_CSS).toMatch(/\.input-bar\.has-draft \.mic-btn\s*\{\s*display:\s*none/);
  });

  it('locks composer geometry to the design values', () => {
    expect(PRES_CSS).toMatch(/\.composer-zone\s*\{[^}]*background:\s*var\(--wy-surface\)/);
    expect(PRES_CSS).toMatch(/\.composer-zone\s*\{[^}]*padding:\s*8px 16px/);
    expect(PRES_CSS).toMatch(/\.input-bar\s*\{[^}]*align-items:\s*center/);
    expect(PRES_CSS).toMatch(/\.mic-btn\s*\{[^}]*width:\s*32px[^}]*height:\s*32px/);
    expect(PRES_CSS).toMatch(/\.mic-btn svg\s*\{[^}]*width:\s*18px/);
    expect(PRES_CSS).toMatch(/\.input-wrap\s*\{[^}]*border-radius:\s*7px/);
    expect(PRES_CSS).toMatch(/\.input-wrap\s*\{[^}]*padding:\s*0 8px/);
    expect(PRES_CSS).toMatch(/\.input-wrap:focus-within\s*\{[^}]*box-shadow:\s*0 0 0 1px var\(--wy-accent\)/);
    expect(PRES_CSS).toMatch(/\.input\s*\{[^}]*height:\s*44px/);
    expect(PRES_CSS).toMatch(/\.input\s*\{[^}]*max-height:\s*15rem/);
    expect(PRES_CSS).toMatch(/\.input\s*\{[^}]*font-size:\s*14px/);
    expect(PRES_CSS).toMatch(/\.attach-btn svg, \.emoji-btn svg\s*\{[^}]*width:\s*18px/);
    expect(PRES_CSS).toMatch(/\.send-btn svg\s*\{[^}]*width:\s*18px/);
    expect(PRES_CSS).toMatch(/\.composer-zone \.wy-powered\s*\{[^}]*font-size:\s*12px/);
  });

  it('renders exactly one footer under the composer', () => {
    const el = chatDom();
    expect(el.querySelectorAll('.composer-zone .wy-footer').length).toBe(1);
    expect(el.querySelectorAll('.wy-footer').length).toBe(1);
  });
});

describe('workspace appearance settings surface', () => {
  const PAGE = readFileSync('src/pages/app/WidgetPage.tsx', 'utf8');
  it('no longer exposes fixed-template visual settings', () => {
    for (const key of [
      'launcher_text', 'secondary_color', 'fab_shape', 'fab_icon',
      'fab_icon_color', 'fab_scale', 'fab_label', 'fab_animation',
    ]) {
      expect(PAGE).not.toContain(key);
    }
  });
  it('keeps the settings that stay workspace-owned', () => {
    for (const key of ['primary_color', 'position', 'welcome_message', 'show_logo', 'placeholder_text']) {
      expect(PAGE).toContain(key);
    }
  });
});
