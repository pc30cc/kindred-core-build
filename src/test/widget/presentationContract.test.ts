import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Widget Presentation Architecture — contract guard.
 *
 * Widget Core (runtime.js) must never build markup itself; the active
 * template renderer is the single source of truth for HTML. These tests
 * pin that boundary so a future patch cannot quietly move markup back
 * into Core.
 */

const RUNTIME = readFileSync('public/widget/runtime.js', 'utf8');
const REGISTRY_SRC = readFileSync('public/widget/presentation-registry.js', 'utf8');
const RENDERER_SRC = readFileSync('public/widget/presentation-classic.js', 'utf8');

function loadPresentation() {
  // eslint-disable-next-line no-new-func
  new Function(REGISTRY_SRC).call(window);
  // eslint-disable-next-line no-new-func
  new Function(RENDERER_SRC).call(window);
  const registry = (window as any).__gs_presentation_registry;
  const desc = registry.resolve('classic');
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
  it('registers the classic template and resolves unknown ids to the default', () => {
    // eslint-disable-next-line no-new-func
    new Function(REGISTRY_SRC).call(window);
    const registry = (window as any).__gs_presentation_registry;
    expect(registry.defaultId).toBe('classic');
    expect(registry.resolve('classic').script).toBe('presentation-classic.js');
    expect(registry.resolve('classic').style).toBe('presentation-classic.css');
    expect(registry.resolve('does-not-exist').id).toBe('classic');
    expect(registry.list().length).toBeGreaterThan(0);
  });
});

describe('widget presentation — classic renderer contract', () => {
  let r: any;
  beforeAll(() => { r = loadPresentation(); });

  it('exposes every surface Core mounts', () => {
    for (const key of [
      'shellHtml', 'homeHtml', 'emptyHtml', 'messagesHtml', 'aiThinkingRowHtml',
      'qnaChipsHtml', 'messageAttachmentHtml', 'callInvitationCardHtml',
      'callEndedRowHtml', 'routingOutcomeRowHtml', 'prechatFieldRowHtml',
      'prechatFormHtml', 'handoffPrechatCardHtml', 'contactFallbackHtml',
      'smartSurfaceHtml',
    ]) {
      expect(typeof r[key], `missing renderer surface: ${key}`).toBe('function');
    }
  });

  it('renders the panel shell with behaviour hooks, not visual selectors', () => {
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
    expect(html).toContain('data-panel-close');
    expect(html).toContain('data-tab="chat"');
    expect(html).toContain('data-att-lightbox');
  });

  it('renders the home view from a pure view-model', () => {
    const html = r.homeHtml({
      rtl: false,
      isOnline: true,
      teamMembers: [{ name: 'Sara', avatar: '', online: true }],
      categories: [{ slug: 'billing', name: 'Billing' }],
      articles: [],
      kbEnabled: true,
      chatEnabled: true,
      primaryColor: '#3B82F6',
      welcomeMessage: 'Hi there',
      smartSurface: null,
    });
    expect(html).toContain('home-root');
    expect(html).toContain('Hi there');
    expect(html).toContain('data-home-action="chat"');
    expect(html).toContain('data-home-cat="billing"');
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
      kbEnabled: false, chatEnabled: true, primaryColor: '#3B82F6',
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
  });

  it('mounts the template through the registry', () => {
    expect(RUNTIME).toContain('__gs_presentation_registry');
    expect(RUNTIME).toContain('resolvePresentation');
  });

  it('keeps template CSS out of the core stylesheet', () => {
    const core = readFileSync('public/widget/runtime.css', 'utf8');
    const template = readFileSync('public/widget/presentation-classic.css', 'utf8');
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
      'kbArticleHtml', 'kbEmptyHtml', 'kbLoadingHtml',
    ]) {
      expect(typeof r[key], `missing KB surface: ${key}`).toBe('function');
    }
  });

  it('renders list, results, article and empty states from a view-model', () => {
    const list = r.kbHtml({ state: 'list', articles: [{ slug: 'a', title: 'Alpha', excerpt: 'x' }], categories: [] });
    expect(list).toContain('data-kb-action="open"');
    expect(list).toContain('data-kb-slug="a"');

    const article = r.kbHtml({ state: 'article', hideSearch: true, article: { title: 'Alpha', contentHtml: '<p>hi</p>' } });
    expect(article).toContain('data-kb-action="back"');
    expect(article).toContain('<p>hi</p>');

    expect(r.kbHtml({ state: 'results', results: [] })).toContain('kb-empty');
    expect(r.kbHtml({ state: 'searching' })).toContain('kb-status');
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
    expect(PREVIEW.includes('presentation-classic.js')).toBe(false);
    expect(PREVIEW.includes('presentation-classic.css')).toBe(false);
    expect(PREVIEW.includes('__gs_presentation_classic')).toBe(false);
  });

  it('resolves the template through the same registry path as production', () => {
    expect(PREVIEW).toContain('presentation-registry.js');
    expect(PREVIEW).toContain('reg.resolve(GS_PREVIEW.templateId)');
    expect(PREVIEW).toContain("'/widget/' + desc.script");
    expect(PREVIEW).toContain("'/widget/' + desc.style");
  });

  it('builds no widget markup of its own (KB included)', () => {
    expect(/class="kb-list"/.test(PREVIEW)).toBe(false);
    expect(/class="kb-article/.test(PREVIEW)).toBe(false);
    expect(/data-preview-article/.test(PREVIEW)).toBe(false);
    expect(PREVIEW).toContain('R.kbHtml(GS_PREVIEW.kbVm)');
    expect(PREVIEW).toContain('R.kbArticleHtml(vm)');
  });
});

describe('widget build pipeline — template-agnostic', () => {
  it('discovers presentation assets instead of listing them', () => {
    const hashScript = readFileSync('scripts/widget-hash.js', 'utf8');
    expect(hashScript).toContain('presentation-');
    expect(/['"]presentation-classic\.js['"]/.test(hashScript)).toBe(false);
    expect(/['"]presentation-classic\.css['"]/.test(hashScript)).toBe(false);
  });

  it('names presentation assets from the resolved template id on the server', () => {
    const route = readFileSync('server/routes/widget.ts', 'utf8');
    expect(route).toContain('resolveWidgetTemplateId');
    expect(route).toContain('widgetTemplateAssetKeys');
    expect(/const templateId = ['"]classic['"]/.test(route)).toBe(false);
  });
});

