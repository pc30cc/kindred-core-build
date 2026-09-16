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
  messagesHtml: (state: Record<string, unknown>, extra: string, view: Record<string, unknown>) => string;
  emptyHtml: () => string;
  homeHtml: (vm: Record<string, unknown>) => string;
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
  // The mic control (and with it the recording row) is gated on real voice
  // support, which jsdom lacks.
  const w0 = window as unknown as Record<string, unknown>;
  w0.MediaRecorder = function () {};
  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: () => {} }, configurable: true,
    });
  }
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
    // Send no longer disappears without a draft — it dims — so this now
    // decides whether an attachment-only message LOOKS sendable.
    expect(css).toContain('.input-bar:not(.has-draft) .send-btn { opacity: 0.4; }');
  });
});

describe('widget polish — nothing swallows a native default', () => {
  it('a navigation trigger is never the delegation root itself', () => {
    // The panel carries `data-view` as a CSS state marker, and
    // Node.contains() reports an element as containing itself — so
    // `closest('[data-view]')` used to resolve to the panel for EVERY click
    // in the widget, and the handler called preventDefault() on all of them.
    // That silently cancelled the attach button's file picker and the
    // powered-by link.
    expect(runtime).toContain('function trigger(target, selector)');
    expect(runtime).toContain('el !== root && root.contains(el)');
    expect(runtime).not.toContain("var view = target.closest('[data-view]');");
    // The marker itself is still written — this is about reading it, not
    // about removing it.
    expect(runtime).toContain("panel.setAttribute('data-view', key)");
  });
});

describe('widget polish — avatars', () => {
  function messageHtml(avatar: string | null) {
    const el = document.createElement('div');
    el.innerHTML = renderer().messagesHtml(
      {
        messages: [
          { sender: 'operator', senderName: 'Sam', senderAvatar: avatar,
            body: 'first', time: new Date(), __id: 'a' },
          { sender: 'operator', senderName: 'Sam', senderAvatar: avatar,
            body: 'second', time: new Date(), __id: 'b' },
        ],
      },
      '',
      {},
    );
    return el;
  }

  it('an operator with no uploaded avatar gets no avatar layer at all', () => {
    const el = messageHtml(null);
    expect(el.querySelectorAll('.msg-avatar').length).toBe(0);
    // Not even the reserved slot the earlier rows used to keep.
    expect(el.querySelectorAll('.msg-avatar-spacer').length).toBe(0);
    expect(el.querySelectorAll('.msg-row.operator').length).toBe(2);
  });

  it('an uploaded avatar still renders, with a spacer for the rows above it', () => {
    const el = messageHtml('https://cdn.test/a.png');
    expect(el.querySelectorAll('.msg-avatar.has-img').length).toBe(1);
    expect(el.querySelectorAll('.msg-avatar-spacer').length).toBe(1);
  });

  it('the welcome bubble follows the same rule', () => {
    const el = document.createElement('div');
    el.innerHTML = renderer().emptyHtml();
    expect(el.querySelectorAll('.msg-avatar').length).toBe(0);
  });

  it('the home CTA shows only operators who actually have one', () => {
    const el = document.createElement('div');
    el.innerHTML = renderer().homeHtml({
      rtl: true, chatEnabled: true, conversations: [], articles: [],
      teamMembers: [
        { name: 'No Avatar', online: true },
        { name: 'Has Avatar', online: true, avatar: 'https://cdn.test/b.png' },
      ],
    });
    expect(el.querySelectorAll('.home-stack-item').length).toBe(1);
    expect(el.querySelectorAll('.home-stack-item.has-img').length).toBe(1);
  });
});

describe('widget polish — voice recording', () => {
  function voiceFrame(enabled = true) {
    const cfg = { attachments: { enabled: true, voiceNotesEnabled: enabled }, composer: { emojiEnabled: true } };
    const el = document.createElement('div');
    el.innerHTML = renderer().chatFrameHtml({ config: cfg, chatEnabled: true, locale: 'fa' });
    return el;
  }

  it('the recording row is part of the composer pill, not a second strip', () => {
    const el = voiceFrame();
    const bar = el.querySelector('[data-rec-bar]');
    expect(bar).not.toBeNull();
    // Inside the pill itself — the attachment tray is a different element
    // that must NOT be where recording happens any more.
    expect(el.querySelector('[data-input-wrap] [data-rec-bar]')).not.toBeNull();
    expect((bar as HTMLElement).hidden).toBe(true);
  });

  it('carries its own cancel, timer and confirm', () => {
    const el = voiceFrame();
    for (const sel of ['[data-rec-cancel]', '[data-rec-timer]', '[data-rec-stop]', '.rec-dot']) {
      expect(el.querySelector(`[data-rec-bar] ${sel}`), sel).not.toBeNull();
    }
  });

  it('is absent entirely when voice notes are off', () => {
    expect(voiceFrame(false).querySelector('[data-rec-bar]')).toBeNull();
  });

  it('Core toggles the mode instead of rebuilding markup', () => {
    expect(runtime).toContain('function setRecordingMode(on)');
    expect(runtime).toContain("inputBar.classList.toggle('is-recording', !!on)");
    // The old tray-chip renderer is gone for good.
    expect(runtime).not.toContain('function renderRecordingUI()');
    expect(runtime).not.toContain('recording-chip');
  });

  it('the stylesheet actually paints the live indicator and hides the composer', () => {
    // `.rec-dot` used to have no rule at all — an invisible zero-size span.
    expect(css).toMatch(/\.rec-dot \{[^}]*background: #e5484d/);
    expect(css).toMatch(/\.input-bar\.is-recording \.input,[\s\S]*?display: none/);
    // Same height as the textarea, so the pill cannot resize on mode change.
    expect(css).toMatch(/\.rec-bar \{[\s\S]*?height: 46px/);
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
