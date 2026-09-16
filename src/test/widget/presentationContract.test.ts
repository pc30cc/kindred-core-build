import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Widget Presentation Architecture — contract guard.
 *
 * Widget Core (runtime.js) must never build markup itself; the active
 * template renderer is the single source of truth for HTML. These tests
 * pin that boundary so a future patch cannot quietly move markup back
 * into Core, and they lock "default" as the ONLY shipped template.
 */

const RUNTIME = readFileSync('public/widget/runtime.js', 'utf8');
import {
  resolveWidgetTemplateId, widgetTemplateAssetKeys,
} from '../../../server/services/widget/presentationAssets.js';

const REGISTRY_SRC = readFileSync('public/widget/presentation-registry.js', 'utf8');
const RENDERER_SRC = readFileSync('public/widget/presentation-default.js', 'utf8');

function loadPresentation() {
  // eslint-disable-next-line no-new-func
  new Function(REGISTRY_SRC).call(window);
  // eslint-disable-next-line no-new-func
  new Function(RENDERER_SRC).call(window);
  const registry = (window as any).__gs_presentation_registry;
  const desc = registry.resolve('default');
  const mod = (window as any)[desc.globalKey];
  return mod.create({
    t: (k: string) => k,
    escapeHtml: (v: unknown) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string),
    config: {
      apiBase: 'https://api.test',
      brandName: 'Acme',
      logoUrl: '',
      attachments: { enabled: true },
      composer: { emojiEnabled: true },
      readReceipts: { enabled: true },
    },
    locale: 'en',
    primaryColor: '#3B82F6',
  });
}

describe('widget presentation — template registry', () => {
  it('ships default as the only template and resolves unknown ids to it', () => {
    // eslint-disable-next-line no-new-func
    new Function(REGISTRY_SRC).call(window);
    const registry = (window as any).__gs_presentation_registry;
    expect(registry.defaultId).toBe('default');
    expect(registry.resolve('default').script).toBe('presentation-default.js');
    expect(registry.resolve('default').style).toBe('presentation-default.css');
    expect(registry.resolve('does-not-exist').id).toBe('default');
    expect(registry.list().length).toBe(1);
  });

  it('has no trace of the removed classic template', () => {
    expect(existsSync('public/widget/presentation-classic.js')).toBe(false);
    expect(existsSync('public/widget/presentation-classic.css')).toBe(false);
    expect(REGISTRY_SRC.includes('classic')).toBe(false);
    expect(RUNTIME.includes('presentation-classic')).toBe(false);
    const serverDefault = readFileSync('server/services/widget/presentationAssets.ts', 'utf8');
    expect(serverDefault).toContain("DEFAULT_WIDGET_TEMPLATE_ID = 'default'");
  });
});

describe('widget presentation — default renderer contract', () => {
  let r: any;
  beforeAll(() => { r = loadPresentation(); });

  it('exposes every surface Core mounts', () => {
    for (const key of [
      'shellHtml', 'chatFrameHtml', 'homeHtml', 'emptyHtml', 'messagesHtml', 'aiThinkingRowHtml',
      'qnaChipsHtml', 'messageAttachmentHtml', 'callInvitationCardHtml',
      'callEndedRowHtml', 'routingOutcomeRowHtml', 'prechatFieldRowHtml',
      'prechatFormHtml', 'handoffPrechatCardHtml', 'contactFallbackHtml',
      'smartSurfaceHtml', 'conversationListHtml',
    ]) {
      expect(typeof r[key], `missing renderer surface: ${key}`).toBe('function');
    }
  });

  it('renders a non-visual panel shell — no chat header, composer or footer', () => {
    const html = r.shellHtml({
      config: { attachments: { enabled: false }, composer: {} },
      locale: 'en',
      primaryColor: '#3B82F6',
      brandName: 'Acme',
      headerTitle: 'Acme',
      chatEnabled: true,
      kbEnabled: true,
      activeTab: 'home',
    });
    expect(html).toContain('data-body');
    expect(html).toContain('data-att-lightbox');
    // Single-view architecture: the chat header belongs to the chat VIEW.
    expect(html).not.toContain('data-chat-header');
    expect(html).not.toContain('composer-zone');
    expect(html).not.toContain('wy-footer');
    // The launcher hides while open, so the shell owns the close control.
    expect(html).toContain('data-panel-close');
    expect(html).not.toContain('data-tab="chat"');
  });

  it('renders the home view from a pure view-model', () => {
    const html = r.homeHtml({
      rtl: false,
      isOnline: true,
      teamMembers: [{ name: 'Sara', avatar: '', online: true }],
      categories: [{ slug: 'billing', name: 'Billing' }],
      articles: [{ slug: 'a', title: 'Alpha' }],
      conversations: [],
      kbEnabled: true,
      chatEnabled: true,
      primaryColor: '#3B82F6',
      welcomeMessage: 'Hi there',
      smartSurface: null,
    });
    expect(html).toContain('home-root');
    expect(html).toContain('Hi there');
    expect(html).toContain('data-home-action="chat"');
    expect(html).toContain('data-home-article="a"');
  });

  it('surfaces recent conversations and the list entry point on home', () => {
    const html = r.homeHtml({
      rtl: false, isOnline: true, teamMembers: [], categories: [], articles: [],
      conversations: [{ id: 'c1', status: 'open', preview: 'hello there', unreadCount: 2, timeLabel: '5m' }],
      kbEnabled: false, chatEnabled: true, primaryColor: '#3B82F6',
      welcomeMessage: 'Hi', smartSurface: null,
    });
    expect(html).toContain('data-conversation-open="c1"');
    expect(html).toContain('hello there');
    expect(html).toContain('data-view="list"');
  });

  it('renders the conversation list view', () => {
    const html = r.conversationListHtml({
      rtl: false, loading: false, chatEnabled: true,
      conversations: [{ id: 'c9', status: 'resolved', preview: 'thanks', unreadCount: 0, timeLabel: '2d' }],
    });
    expect(html).toContain('data-view-back="home"');
    expect(html).toContain('data-conversation-open="c9"');
    expect(html).toContain('data-home-action="chat"');
    expect(r.conversationListHtml({ conversations: [] })).toContain('wy-empty');
  });

  it('renders the message list and honours the typewriter/qna view state', () => {
    const html = r.messagesHtml(
      {
        messages: [
          { __id: 'm1', sender: 'visitor', body: 'hello', time: new Date().toISOString() },
          { __id: 'm2', sender: 'operator', senderName: 'Sara', body: 'hi!', time: new Date().toISOString() },
        ],
        aiThinking: false,
      },
      '',
      { typewriter: null, qna: { questions: [], expanded: false, collapsedCount: 3 } },
    );
    expect(html).toContain('class="messages"');
    expect(html).toContain('hello');
    expect(html).toContain('hi!');
  });

  it('renders RTL home markup when the view-model says so', () => {
    const html = r.homeHtml({
      rtl: true, isOnline: false, teamMembers: [], categories: [], articles: [],
      conversations: [], kbEnabled: false, chatEnabled: true, primaryColor: '#3B82F6',
      welcomeMessage: 'سلام', smartSurface: null,
    });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('سلام');
  });
});

describe('widget core — no markup left behind', () => {
  it('does not build page markup with string concatenation', () => {
    expect(RUNTIME.includes('headerHtml + bodyHtml + inputHtml')).toBe(false);
    expect(/class="home-root"/.test(RUNTIME)).toBe(false);
    expect(/class="messages"/.test(RUNTIME)).toBe(false);
    expect(/class="prechat /.test(RUNTIME)).toBe(false);
    expect(/class="conv-row/.test(RUNTIME)).toBe(false);
  });

  it('mounts the template through the registry', () => {
    expect(RUNTIME).toContain('__gs_presentation_registry');
    expect(RUNTIME).toContain('resolvePresentation');
  });

  it('renders the conversation list through the template', () => {
    expect(RUNTIME).toContain('Presentation.conversationListHtml');
  });

  it('keeps template CSS out of the core stylesheet', () => {
    const core = readFileSync('public/widget/runtime.css', 'utf8');
    const template = readFileSync('public/widget/presentation-default.css', 'utf8');
    expect(core.includes('.home-root')).toBe(false);
    expect(core.includes('.msg-bubble')).toBe(false);
    expect(template).toContain('.panel');
  });
});

describe('widget presentation — knowledge base surfaces', () => {
  let r: any;
  beforeAll(() => { r = loadPresentation(); });

  it('exposes every KB surface', () => {
    for (const key of [
      'kbHtml', 'kbSearchBarHtml', 'kbHomeHtml', 'kbSearchResultsHtml',
      'kbArticleHtml', 'kbEmptyHtml', 'kbLoadingHtml', 'kbArticleFeedbackHtml',
    ]) {
      expect(typeof r[key], `missing KB surface: ${key}`).toBe('function');
    }
  });

  it('renders list, results, article and empty states from a view-model', () => {
    const list = r.kbHtml({ state: 'list', articles: [{ slug: 'a', title: 'Alpha', excerpt: 'x' }], categories: [] });
    expect(list).toContain('data-kb-action="open"');
    expect(list).toContain('data-kb-slug="a"');

    const article = r.kbHtml({ state: 'article', hideSearch: true, article: { title: 'Alpha', contentHtml: '<p>hi</p>' } });
    // Generic back control: the shell resolves a real step back and only
    // falls back to a named tab when there is nowhere left to go.
    expect(article).toContain('data-view-back="back"');
    expect(article).toContain('data-view-back-fallback="home"');
    expect(article).toContain('<p>hi</p>');

    expect(r.kbHtml({ state: 'results', results: [] })).toContain('kb-empty');
    // Loading is a skeleton of the real list — never a status line.
    const searching = r.kbHtml({ state: 'searching' });
    expect(searching).toContain('wy-sk');
    expect(searching).not.toContain('kb-status');
  });

  it('renders article feedback only when the capability is enabled', () => {
    expect(r.kbArticleFeedbackHtml({ enabled: false })).toBe('');
    const fb = r.kbArticleFeedbackHtml({ enabled: true, rating: null });
    expect(fb).toContain('data-kb-rate="up"');
    expect(fb).toContain('data-kb-rate="down"');
    const voted = r.kbArticleFeedbackHtml({ enabled: true, rating: 'up' });
    expect(voted).toContain('aria-pressed="true"');
  });

  it('keeps KB markup out of Widget Core', () => {
    expect(/class="kb-list"/.test(RUNTIME)).toBe(false);
    expect(/class="kb-article/.test(RUNTIME)).toBe(false);
    expect(/kb-empty/.test(RUNTIME)).toBe(false);
    expect(RUNTIME).toContain('Presentation.kbHtml');
  });
});

describe('widget preview — template-agnostic single source of truth', () => {
  const PREVIEW = readFileSync('src/components/app/widget/WidgetLivePreview.tsx', 'utf8');

  it('never hard-codes a template asset', () => {
    expect(PREVIEW.includes('presentation-default.js')).toBe(false);
    expect(PREVIEW.includes('presentation-default.css')).toBe(false);
    expect(PREVIEW.includes('__gs_presentation_default')).toBe(false);
    expect(PREVIEW.includes('presentation-classic')).toBe(false);
  });

  it('resolves the template through the same registry path as production', () => {
    expect(PREVIEW).toContain('presentation-registry.js');
    expect(PREVIEW).toContain('reg.resolve(GS_PREVIEW.templateId)');
    expect(PREVIEW).toContain("'/widget/' + scriptFile");
    expect(PREVIEW).toContain("'/widget/' + styleFile");
  });

  it('builds no widget markup of its own (KB included)', () => {
    expect(/class="kb-list"/.test(PREVIEW)).toBe(false);
    expect(/class="kb-article/.test(PREVIEW)).toBe(false);
    expect(/data-preview-article/.test(PREVIEW)).toBe(false);
    expect(PREVIEW).toContain('R.kbHtml(GS_PREVIEW.kbVm)');
    expect(PREVIEW).toContain('R.kbHtml(vm)');
  });
});

describe('widget build pipeline — template-agnostic', () => {
  it('discovers presentation assets instead of listing them', () => {
    const hashScript = readFileSync('scripts/widget-hash.js', 'utf8');
    expect(hashScript).toContain('presentation-');
    // The build must DISCOVER `presentation-<id>.*`, never enumerate ids —
    // otherwise renaming a template means editing the build too.
    expect(/['"]presentation-default\.js['"]/.test(hashScript)).toBe(false);
    expect(/['"]presentation-default\.css['"]/.test(hashScript)).toBe(false);
    expect(hashScript.includes('presentation-classic')).toBe(false);
  });

  it('names presentation assets from the resolved template id on the server', () => {
    const route = readFileSync('server/routes/widget.ts', 'utf8');
    expect(route).toContain('resolveWidgetTemplateId');
    expect(route).toContain('widgetTemplateAssetKeys');
    expect(/const templateId = ['"]default['"]/.test(route)).toBe(false);
  });

  it('ships the licensed template fonts', () => {
    for (const f of ['iransans-400.woff2', 'iransans-500.woff2', 'iransans-700.woff2']) {
      expect(existsSync(`public/widget/fonts/${f}`), `missing font ${f}`).toBe(true);
    }
  });

  it('registers the renderer under exactly the key the registry declares', () => {
    // The template id is baked into the asset file names, the window key and
    // the registry entry. Renaming it in one place and not the others leaves
    // the loader fetching a file that exists and then looking for a global
    // that never appears — so this compares them instead of hardcoding.
    new Function(REGISTRY_SRC).call(window);
    const registry = (window as unknown as {
      __gs_presentation_registry: {
        defaultId: string;
        resolve: (id: string) => { id: string; globalKey: string; script: string; style: string };
      };
    }).__gs_presentation_registry;
    const desc = registry.resolve(registry.defaultId);

    expect(RENDERER_SRC).toContain(`window.${desc.globalKey} = { id: '${desc.id}'`);
    expect(desc.script).toBe(`presentation-${desc.id}.js`);
    expect(desc.style).toBe(`presentation-${desc.id}.css`);
    expect(existsSync(`public/widget/${desc.script}`), desc.script).toBe(true);
    expect(existsSync(`public/widget/${desc.style}`), desc.style).toBe(true);
  });

  it('resolves the legacy id on the server too, where a 404 would result', () => {
    // The browser registry can fall back for ANY unknown id, so a stale id
    // is harmless there. The server builds a FILE NAME out of it, so without
    // an explicit alias it would serve the loader `presentation-web-yar.js`
    // — a file that no longer exists.
    expect(resolveWidgetTemplateId('web-yar')).toBe('default');
    expect(widgetTemplateAssetKeys('web-yar')).toEqual({
      script: 'presentation-default.js',
      style: 'presentation-default.css',
      fonts: 'presentation-default-fonts.css',
    });
  });

  it('still resolves the id this template used to have', () => {
    // A settings row or an embed written before the rename must land on the
    // real assets, not 404 on files that no longer exist.
    new Function(REGISTRY_SRC).call(window);
    const registry = (window as unknown as {
      __gs_presentation_registry: { resolve: (id: string) => { id: string } };
    }).__gs_presentation_registry;
    expect(registry.resolve('web-yar').id).toBe('default');
  });
});
