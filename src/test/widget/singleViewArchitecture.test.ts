import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Single-view architecture regression guard.
 *
 * The panel is a bare container: at any moment EXACTLY ONE full view is
 * mounted, and that view owns its own header, body, composer and footer.
 * These tests count real DOM nodes per view so the legacy "persistent chat
 * chrome + view inside the body" shell can never come back.
 */

const RUNTIME = readFileSync('public/widget/runtime.js', 'utf8');
const REGISTRY_SRC = readFileSync('public/widget/presentation-registry.js', 'utf8');
const RENDERER_SRC = readFileSync('public/widget/presentation-web-yar.js', 'utf8');

function loadPresentation() {
  // eslint-disable-next-line no-new-func
  new Function(REGISTRY_SRC).call(window);
  // eslint-disable-next-line no-new-func
  new Function(RENDERER_SRC).call(window);
  const mod = (window as any).__gs_presentation_web_yar;
  return mod.create({
    t: (k: string) => k,
    escapeHtml: (v: unknown) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string),
    config: {
      apiBase: 'https://api.test',
      brandName: 'Acme',
      platformName: 'Web Yar',
      logoUrl: '',
      attachments: { enabled: true },
      composer: { emojiEnabled: true },
    },
    locale: 'en',
    primaryColor: '#3B82F6',
  });
}

function dom(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

function counts(html: string) {
  const el = dom(html);
  return {
    headers: el.querySelectorAll('.wy-head').length,
    chatHeaders: el.querySelectorAll('[data-chat-header]').length,
    footers: el.querySelectorAll('.wy-footer').length,
    composers: el.querySelectorAll('.composer-zone').length,
    inputs: el.querySelectorAll('[data-msg-input]').length,
    searchBars: el.querySelectorAll('.kb-search').length,
  };
}

const identity = {
  isAsked: () => true,
  isRequired: () => true,
};

describe('shell — non-visual infrastructure only', () => {
  let r: any;
  beforeAll(() => { r = loadPresentation(); });

  it('carries the view host and the lightbox, and nothing visual', () => {
    const html = r.shellHtml({ config: {}, locale: 'en', chatEnabled: true });
    const c = counts(html);
    expect(html).toContain('data-body');
    expect(html).toContain('data-att-lightbox');
    expect(c.chatHeaders).toBe(0);
    expect(c.headers).toBe(0);
    expect(c.footers).toBe(0);
    expect(c.composers).toBe(0);
  });
});

describe('every view renders exactly one header/footer', () => {
  let r: any;
  beforeAll(() => { r = loadPresentation(); });

  const homeVm = {
    rtl: false, isOnline: true, teamMembers: [], categories: [],
    articles: [{ slug: 'a', title: 'Alpha' }, { slug: 'b', title: 'Beta' }],
    conversations: [
      { id: 'c1', status: 'open', preview: 'one', timeLabel: '1m' },
      { id: 'c2', status: 'open', preview: 'two', timeLabel: '2m' },
      { id: 'c3', status: 'open', preview: 'three', timeLabel: '3m' },
    ],
    kbEnabled: true, chatEnabled: true, primaryColor: '#3B82F6',
    welcomeMessage: 'Hi', smartSurface: null,
  };

  it('Home: 1 header, 1 footer, 0 composer', () => {
    const c = counts(r.homeHtml(homeVm));
    expect(c).toMatchObject({ headers: 1, footers: 1, composers: 0, inputs: 0, chatHeaders: 0 });
  });

  it('Home: at most 3 recent conversations, chips stay visible alongside them', () => {
    const el = dom(r.homeHtml(homeVm));
    expect(el.querySelectorAll('.home-recent [data-conversation-open]').length).toBe(3);
    expect(el.querySelectorAll('.home-chip[data-home-article]').length).toBe(2);
    // No duplicate "Articles" action button — chips are the only entry point.
    expect(el.querySelectorAll('.wy-actions [data-view="help"]').length).toBe(0);
  });

  it('List: 1 header, 1 footer, 0 composer', () => {
    const c = counts(r.conversationListHtml({
      rtl: false, loading: false, chatEnabled: true,
      conversations: [{ id: 'c9', status: 'open', preview: 'x', timeLabel: '2d' }],
    }));
    expect(c).toMatchObject({ headers: 1, footers: 1, composers: 0, inputs: 0, chatHeaders: 0 });
  });

  it('Articles: 1 header, 1 footer, 0 composer, 0 search bar, 0 categories', () => {
    const html = r.kbHtml({
      state: 'list',
      articles: [{ slug: 'a', title: 'Alpha', excerpt: 'x' }],
      categories: [{ slug: 'billing', name: 'Billing', url: 'https://x' }],
    });
    const c = counts(html);
    expect(c).toMatchObject({ headers: 1, footers: 1, composers: 0, searchBars: 0 });
    expect(dom(html).querySelectorAll('.kb-category').length).toBe(0);
    expect(dom(html).querySelectorAll('[data-kb-action="open"]').length).toBe(1);
  });

  it('Article: 1 header, 1 footer, title only in the chrome', () => {
    const html = r.kbHtml({
      state: 'article',
      article: { title: 'Alpha', excerpt: 'ex', contentHtml: '<p>hi</p>', publicUrl: 'https://x' },
      feedback: { enabled: true, rating: null },
    });
    const el = dom(html);
    expect(counts(html)).toMatchObject({ headers: 1, footers: 1, composers: 0, searchBars: 0 });
    expect(el.querySelectorAll('.wy-head-article-title').length).toBe(1);
    expect(el.querySelectorAll('.kb-article-h').length).toBe(0);
    expect(html).not.toContain('kb-open-browser');
    expect(html).not.toContain('kb-article-excerpt-full');
    expect(el.querySelectorAll('[data-kb-rate]').length).toBe(2);
  });

  it('Precontact: source-faithful full-screen view, no footer or chat composer', () => {
    const html = r.prechatFormHtml(identity, {}, 'en');
    const c = counts(html);
    expect(c).toMatchObject({ headers: 1, footers: 0, composers: 0, inputs: 0, chatHeaders: 0 });
    expect(html).not.toContain('prechat-privacy');
    expect(html).not.toContain('prechat-icon');
    expect(dom(html).querySelectorAll('[data-prechat-submit]').length).toBe(1);
  });

  it('Chat: 1 header, 1 composer, 1 footer', () => {
    const html = r.chatFrameHtml({
      config: { attachments: { enabled: true }, composer: { emojiEnabled: true } },
      locale: 'en', chatEnabled: true, headerTitle: 'Acme', primaryColor: '#3B82F6',
    });
    const el = dom(html);
    expect(counts(html)).toMatchObject({ headers: 1, chatHeaders: 1, footers: 1, composers: 1, inputs: 1 });
    expect(el.querySelectorAll('[data-chat-messages]').length).toBe(1);
    expect(el.querySelectorAll('[data-send-btn]').length).toBe(1);
    // Composer input is a single-row textarea per the design file.
    expect((el.querySelector('[data-msg-input]') as HTMLElement).tagName).toBe('TEXTAREA');
    expect(el.querySelector('[data-msg-input]')!.getAttribute('rows')).toBe('1');
    expect(el.querySelectorAll('[data-view-back="home"]').length).toBe(1);
  });

  it('no view ever duplicates chat chrome', () => {
    const views = [
      r.homeHtml(homeVm),
      r.conversationListHtml({ conversations: [], chatEnabled: true }),
      r.kbHtml({ state: 'list', articles: [{ slug: 'a', title: 'A' }], categories: [] }),
      r.kbHtml({ state: 'article', article: { title: 'A', contentHtml: '<p>x</p>' } }),
      r.prechatFormHtml(identity, {}, 'en'),
      r.contactFallbackHtml(identity, {}, 'en', {}),
      r.chatFrameHtml({ config: {}, locale: 'en', chatEnabled: true }),
    ];
    for (const [index, html] of views.entries()) {
      const c = counts(html);
      expect(c.headers).toBe(1);
      // The uploaded source intentionally has no powered-by footer on the
      // full-screen precontact form; every other complete view has one.
      expect(c.footers).toBe(index === 4 ? 0 : 1);
      expect(c.chatHeaders).toBeLessThanOrEqual(1);
      expect(c.composers).toBeLessThanOrEqual(1);
    }
  });
});

describe('core mounts one view at a time', () => {
  it('builds the chat frame once and mounts it only for the chat view', () => {
    expect(RUNTIME).toContain('Presentation.chatFrameHtml(shellVm)');
    expect(RUNTIME).toContain('function mountChatFrame()');
    expect(RUNTIME).toContain('function unmountChatFrame()');
    expect(RUNTIME).toContain("if (key !== 'chat') unmountChatFrame();");
    expect(RUNTIME).toContain('chatUI.renderChat(mountChatFrame() || body)');
    // The old "hide the persistent chat header" hack must be gone.
    expect(RUNTIME).not.toContain("chatHeader.hidden = key !== 'chat'");
  });

  it('binds composer nodes inside the chat frame, not the panel', () => {
    for (const sel of ['[data-msg-input]', '[data-send-btn]', '[data-input-bar]', '[data-emoji-picker]']) {
      expect(RUNTIME).toContain(`chatQ('${sel}')`);
      expect(RUNTIME).not.toContain(`panel.querySelector('${sel}')`);
    }
  });

  it('navigates through panel-level delegation so any future view works', () => {
    expect(RUNTIME).toContain('function bindPanelNavigation(root)');
    expect(RUNTIME).toContain('bindPanelNavigation(panel);');
    expect(RUNTIME).toContain("target.closest('[data-view-back]')");
    expect(RUNTIME).toContain("target.closest('[data-view]')");
  });
});
