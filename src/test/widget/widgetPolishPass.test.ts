import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Widget polish pass — accessibility, localization and composer contracts.
 *
 * Each case here locks a behaviour that was previously wrong (hardcoded
 * English, a declared-but-never-updated ARIA attribute, an unreachable
 * control) so it cannot regress silently.
 */

const root = path.resolve(process.cwd(), 'public/widget');
const loader = fs.readFileSync(path.join(root, 'loader.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'runtime.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(root, 'presentation-web-yar.js'), 'utf8');
const registrySrc = fs.readFileSync(path.join(root, 'presentation-registry.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'presentation-web-yar.css'), 'utf8');

const LOCALES = ['en', 'fa', 'tr'] as const;

type Renderer = {
  chatFrameHtml: (vm: Record<string, unknown>) => string;
  kbSearchBarHtml: (vm: Record<string, unknown>) => string;
};

/** Reads one locale's slice of runtime.js's I18n table. */
function localeBlock(locale: string): string {
  const start = runtime.indexOf(`      ${locale}: {`);
  expect(start, `locale ${locale} present`).toBeGreaterThan(-1);
  const nextLocale = LOCALES.map((l) => runtime.indexOf(`      ${l}: {`, start + 10))
    .filter((i) => i > start)
    .sort((a, b) => a - b)[0];
  return runtime.slice(start, nextLocale > 0 ? nextLocale : start + 40000);
}

function renderer(locale = 'fa') {
  new Function(registrySrc).call(window);
  new Function(rendererSrc).call(window);
  const registered = (window as unknown as Record<string, { create: (env: unknown) => Renderer }>)
    .__gs_presentation_web_yar;
  return registered.create({
    // Mirrors Core: an unknown key comes back as the key itself.
    t: (k: string) => k,
    escapeHtml: (v: unknown) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string),
    config: {
      brandName: 'Acme',
      attachments: { enabled: true },
      composer: { emojiEnabled: true },
    },
    locale,
    primaryColor: '#1f93ff',
  });
}

function chatFrame() {
  const el = document.createElement('div');
  el.innerHTML = renderer().chatFrameHtml({
    config: { attachments: { enabled: true }, composer: { emojiEnabled: true } },
    chatEnabled: true,
    locale: 'fa',
  });
  return el;
}

describe('widget polish — localization', () => {
  it.each(LOCALES)('%s carries every string the polished controls need', (locale) => {
    const block = localeBlock(locale);
    for (const key of ['send', 'close', 'cancel', 'remove', 'wyUnread', 'newMessages', 'scrollToLatest']) {
      expect(block, `${locale}.${key}`).toMatch(new RegExp(`\\b${key}:\\s*['"]`));
    }
  });

  it('no widget control ships a hardcoded English aria-label', () => {
    // These two were literal attributes in the shipped markup.
    expect(loader).not.toContain('aria-label="close"');
    expect(loader).not.toContain('"aria-label", "Open chat"');
    expect(rendererSrc).not.toContain('aria-label="close"');
    expect(runtime).not.toContain('aria-label="Remove"');
  });

  it('the attachment chip names its remove control in the visitor locale', () => {
    expect(runtime).toContain("Util.escapeHtml(t('remove'))");
  });

  it('the launcher name is localized, state-aware and unread-aware', () => {
    expect(loader).toContain('function syncLauncherLabel()');
    expect(loader).toContain('lt("closeChat")');
    expect(loader).toContain('lt("openChat")');
    expect(loader).toContain('lt("unreadMany")');
    for (const locale of LOCALES) {
      expect(loader, `${locale} launcher strings`).toMatch(
        new RegExp(`${locale}: \\{[\\s\\S]*?openChat:[\\s\\S]*?closeChat:`),
      );
    }
  });
});

describe('widget polish — accessibility', () => {
  it('the panel is a labelled dialog that can receive focus', () => {
    expect(runtime).toContain("panel.setAttribute('role', 'dialog')");
    expect(runtime).toContain("panel.setAttribute('aria-label', brandName || t('chat'))");
    expect(runtime).toContain("panel.setAttribute('tabindex', '-1')");
    // Not modal: the host page behind a corner popover stays usable.
    expect(runtime).not.toContain("panel.setAttribute('aria-modal'");
  });

  it('Escape unwinds the widget without hijacking the host page', () => {
    expect(runtime).toContain("panel.addEventListener('keydown', function (e) {");
    expect(runtime).toContain('closePanelFromWithin();');
    // The old document-level Escape listener is gone.
    expect(runtime).not.toContain(
      "document.addEventListener('keydown', function (e) {\n      if (e.key === 'Escape'",
    );
  });

  it('the launcher exposes disclosure state', () => {
    expect(loader).toContain('launcherEl.setAttribute("aria-haspopup", "dialog")');
    expect(loader).toContain('launcherEl.setAttribute("aria-expanded", isOpen ? "true" : "false")');
    // A bare unread number read on its own means nothing.
    expect(loader).toContain('badge.setAttribute("aria-hidden", "true")');
  });

  it('opening and closing the panel moves focus deliberately', () => {
    expect(runtime).toContain('function focusFirstInPanel()');
    expect(runtime).toContain('function isCoarsePointer()');
    // Closing hands focus back to the launcher rather than stranding it.
    expect(runtime).toMatch(/if \(inPanel && launcher && launcher\.style\.display !== 'none'\) launcher\.focus\(\)/);
  });

  it('the lightbox behaves like the modal it declares itself to be', () => {
    expect(runtime).toContain('var lightboxReturnFocus = null;');
    expect(runtime).toContain("if (e.key !== 'Tab' || !lightboxClose) return;");
    expect(runtime).toContain('if (lightboxClose) { try { lightboxClose.focus(); } catch (_) {} }');
  });

  it('the emoji toggle keeps aria-expanded honest', () => {
    expect(runtime).toContain('function syncEmojiExpanded()');
    expect(runtime).toMatch(/emojiPickerEl\.hidden = !emojiPickerEl\.hidden;\s*\n\s*syncEmojiExpanded\(\);/);
    // The template already styles the active state off that attribute.
    expect(css).toContain(".emoji-btn[aria-expanded='true']");
  });

  it('the article search field has an accessible name', () => {
    const el = document.createElement('div');
    el.innerHTML = renderer().kbSearchBarHtml({ query: '' });
    expect(el.querySelector('.kb-search')?.getAttribute('aria-label')).toBe('searchKb');
  });

  it('an in-flight send spinner is announced, not just drawn', () => {
    expect(rendererSrc).toContain('class="msg-ticks is-sending" aria-label=');
    expect(rendererSrc).toContain('<span class="msg-status-spinner" aria-hidden="true">');
  });

  it('message actions are reachable without a hover-capable pointer', () => {
    expect(css).toMatch(/@media \(hover: none\) \{\s*\n\s*\.msg-actions \{ opacity: 0\.6; \}/);
  });
});

describe('widget polish — composer', () => {
  it('Enter does not send mid-IME-composition', () => {
    expect(runtime).toContain('if (e.isComposing || e.keyCode === 229) return;');
  });

  it('the textarea grows with the draft and collapses after a send', () => {
    expect(runtime).toContain('function autosizeComposer()');
    // Growth is bounded by the stylesheet, never by a JS magic number.
    expect(runtime).toContain("var maxH = parseFloat(getComputedStyle(msgInput).maxHeight);");
    expect(css).toMatch(/\.input \{[\s\S]*?max-height: 15rem/);
  });

  it('a ready attachment counts as a draft, so it has a send button', () => {
    expect(runtime).toContain("|| (att.status === 'ready' && !!att.attachmentId)");
    // The send button is CSS-gated on has-draft, which is why this matters.
    expect(css).toContain('.input-bar:not(.has-draft) .send-btn { display: none; }');
  });
});

describe('widget polish — jump to latest', () => {
  it('the chat frame ships a hidden, labelled jump control', () => {
    const el = chatFrame();
    const btn = el.querySelector('[data-chat-jump]') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.hidden).toBe(true);
    expect(btn!.getAttribute('aria-label')).toBeTruthy();
    // It lives in a positioning host alongside the scroll area — and there is
    // still exactly one message host (single-view architecture).
    expect(el.querySelectorAll('[data-chat-messages]').length).toBe(1);
    expect(el.querySelector('.wy-chat-scroll-host [data-chat-messages]')).not.toBeNull();
  });

  it('a chat-disabled frame renders no jump control', () => {
    const el = document.createElement('div');
    el.innerHTML = renderer().chatFrameHtml({ config: {}, chatEnabled: false, locale: 'fa' });
    expect(el.querySelector('[data-chat-jump]')).toBeNull();
  });

  it('Core owns the visibility and the unseen counter', () => {
    expect(runtime).toContain('function syncJumpButton()');
    expect(runtime).toContain('function noteUnseenForJump()');
    expect(runtime).toContain('function bindJumpScrollTracking()');
    // Counting is gated on the visitor actually being scrolled away.
    expect(runtime).toContain(
      'if (host.scrollHeight > host.clientHeight + 8 && !chatIsNearBottom(host)) jumpUnseen++;',
    );
  });

  it('the pill is styled for both states and respects reduced motion', () => {
    expect(css).toContain('.wy-jump[hidden] { display: none; }');
    expect(css).toMatch(/\.wy-jump\.has-new \{[\s\S]*?background: var\(--wy-accent\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.wy-jump/);
  });
});

describe('widget polish — motion and placement', () => {
  it('the loader honours prefers-reduced-motion', () => {
    expect(loader).toContain('"@media(prefers-reduced-motion:reduce){"');
    expect(loader).toContain('".launcher.pulse{animation:none!important;}"');
    // The Web Animations entry bypasses CSS entirely, so JS opts out too.
    expect(loader).toContain('function prefersReducedMotion()');
    expect(loader).toMatch(/if \(prefersReducedMotion\(\)\) \{\s*\n\s*element\.classList\.remove\("enter"\);/);
  });

  it('the error toast follows the configured corner', () => {
    expect(loader).toContain('".error-toast.toast-left{left:24px;right:auto;}"');
    expect(loader).toContain('errorToastEl.classList.toggle("toast-left", posClass === "bottom-left")');
  });
});
