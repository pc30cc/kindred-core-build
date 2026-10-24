import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

/**
 * Widget Presentation Architecture — contract guard.
 *
 * Widget Core (runtime.js) must never build markup itself; the active
 * template renderer is the single source of truth for HTML. These tests
 * pin that boundary so a future patch cannot quietly move markup back
 * into Core, and they lock "default" as the Iranian edition's template and
 * "intl" (a skin over the same renderer) as the International one's.
 */

const RUNTIME = readFileSync('public/widget/runtime.js', 'utf8');
import {
  resolveWidgetTemplateId, widgetTemplateAssetKeys,
} from '../../../server/services/widget/presentationAssets.js';

const REGISTRY_SRC = readFileSync('public/widget/presentation-registry.js', 'utf8');

/** The browser globals these tests read (the registry and the renderer). */
type Descriptor = { id: string; globalKey: string; script: string; style: string; skin?: string };
type Renderer = Record<string, (...args: unknown[]) => string>;
type WidgetWindow = {
  __gs_presentation_registry: { defaultId: string; resolve: (id: string) => Descriptor; list: () => Descriptor[] };
} & Record<string, { create: (env: unknown) => Renderer }>;
const win = () => window as unknown as WidgetWindow;
const RENDERER_SRC = readFileSync('public/widget/presentation-default.js', 'utf8');

function loadPresentation() {
  // eslint-disable-next-line no-new-func
  new Function(REGISTRY_SRC).call(window);
  // eslint-disable-next-line no-new-func
  new Function(RENDERER_SRC).call(window);
  const registry = win().__gs_presentation_registry;
  const desc = registry.resolve('default');
  const mod = win()[desc.globalKey];
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
  it('ships default, t1 and t2 (Iran) and intl (International) and resolves unknown ids to default', () => {
    // eslint-disable-next-line no-new-func
    new Function(REGISTRY_SRC).call(window);
    const registry = win().__gs_presentation_registry;
    expect(registry.defaultId).toBe('default');
    expect(registry.resolve('default').script).toBe('presentation-default.js');
    expect(registry.resolve('default').style).toBe('presentation-default.css');
    expect(registry.resolve('default').skin).toBeUndefined();
    expect(registry.resolve('does-not-exist').id).toBe('default');
    // The International edition's template: a skin over the same renderer.
    expect(registry.resolve('intl')).toMatchObject({
      id: 'intl',
      globalKey: '__gs_presentation_default',
      script: 'presentation-default.js',
      style: 'presentation-default.css',
      skin: 'presentation-intl.css',
    });
    // The Iranian edition's other templates: each its own renderer and
    // stylesheet, over the shared fonts stylesheet.
    for (const id of ['t1', 't2']) {
      expect(registry.resolve(id)).toMatchObject({
        id,
        globalKey: `__gs_presentation_${id}`,
        script: `presentation-${id}.js`,
        style: `presentation-${id}.css`,
        fonts: 'presentation-default-fonts.css',
      });
      expect(registry.resolve(id).skin).toBeUndefined();
    }
    // The International edition's skins over them: the renderer (its global,
    // stylesheet and extras) is t1's / t2's, the skin their own.
    for (const base of ['t1', 't2']) {
      expect(registry.resolve(`${base}-intl`)).toMatchObject({
        id: `${base}-intl`,
        globalKey: `__gs_presentation_${base}`,
        script: `presentation-${base}.js`,
        style: `presentation-${base}.css`,
        skin: `presentation-${base}-intl.css`,
        fonts: 'presentation-default-fonts.css',
        extras: `presentation-${base}-x.js`,
      });
    }
    expect(registry.list().map((d) => d.id)).toEqual(['default', 'intl', 't1', 't2', 't1-intl', 't2-intl']);
  });

  it('resolves only its own ids: a name every object inherits is unknown (the default)', () => {
    new Function(REGISTRY_SRC).call(window);
    const registry = win().__gs_presentation_registry;
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(registry.resolve(id).id, id).toBe('default');
    }
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
  let r: Renderer;
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

  // One conversation per visitor: Core passes home the current one (or
  // none) and how many are history; the list is the history. (`t` echoes
  // keys, so the renderer's own English fallbacks show.)
  const homeVm = (over: Record<string, unknown>) => ({
    rtl: false, isOnline: true, teamMembers: [], categories: [], articles: [],
    conversations: [], kbEnabled: false, chatEnabled: true, primaryColor: '#3B82F6',
    welcomeMessage: 'Hi', smartSurface: null, ...over,
  });
  const doc = (html: string) => new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');

  it('home: the current conversation, its one door, and the quiet link into history', () => {
    const html = r.homeHtml(homeVm({
      conversations: [{ id: 'c1', status: 'open', preview: 'hello there', unreadCount: 2, timeLabel: '5m' }],
      pastCount: 1, pastUnread: 3,
    }));
    const d = doc(html);
    expect(html).toContain('data-conversation-open="c1"');
    expect(html).toContain('hello there');
    expect(d.querySelector('.home-section-title')!.textContent).toBe('Your conversation');
    expect(d.querySelector('.home-link[data-view="list"]')!.textContent).toBe('Previous conversations3');
    // ONE main button, to it: never a second, parallel conversation.
    const doors = d.querySelectorAll('[data-home-action="chat"]');
    expect(doors).toHaveLength(1);
    expect(doors[0].textContent).toBe('Continue conversation');
    expect(d.querySelectorAll('.wy-btn')).toHaveLength(1);
    // No unseen answer in history: no count on the link.
    const quiet = doc(r.homeHtml(homeVm({ conversations: [{ id: 'c1', status: 'open' }], pastCount: 2, pastUnread: 0 })));
    expect(quiet.querySelector('.home-link[data-view="list"] .conv-unread')).toBeNull();
  });

  it('home: with nothing current, start (or leave a message) and the link alone; with no history, no link', () => {
    const returning = doc(r.homeHtml(homeVm({ pastCount: 2 })));
    expect(returning.querySelector('[data-conversation-open]')).toBeNull();
    expect(returning.querySelector('.home-section-title')).toBeNull();
    expect(returning.querySelector('[data-view="list"]')).not.toBeNull();
    expect(returning.querySelector('[data-home-action="chat"]')!.textContent).toBe('homeStartChat');
    const away = doc(r.homeHtml(homeVm({ isOnline: false, pastCount: 0 })));
    expect(away.querySelector('[data-view="list"]')).toBeNull();
    expect(away.querySelector('.home-recent')).toBeNull();
    expect(away.querySelector('[data-home-action="chat"]')!.textContent).toBe('homeLeaveMessage');
  });

  it('renders the conversation list view: the history, back where Core says, no new-conversation door, no status words', () => {
    const html = r.conversationListHtml({
      rtl: false, loading: false, chatEnabled: true, back: 'help',
      conversations: [{ id: 'c9', status: 'closed', preview: 'thanks', unreadCount: 0, timeLabel: '2d' }],
    });
    const d = doc(html);
    expect(html).toContain('data-view-back="help"');
    expect(html).toContain('data-conversation-open="c9"');
    expect(d.querySelector('.wy-head-plain')!.textContent).toBe('Previous conversations');
    expect(html).not.toContain('data-home-action="chat"');
    expect(html).not.toMatch(/wyStatus(Open|Resolved)|conv-status/);
    expect(r.conversationListHtml({ conversations: [] })).toContain('data-view-back="home"');
    expect(r.conversationListHtml({ conversations: [] })).toContain('wy-empty');
  });

  it('pastBarHtml: the composer locked, why, and the one way on', () => {
    const cur = doc(r.pastBarHtml({ current: true, online: true }));
    const bar = cur.querySelector('div[data-past-bar]')!;
    expect(bar.querySelector('svg')).not.toBeNull();
    expect(bar.querySelector('.wy-past-text')!.textContent).toBe('This chat has ended and is read-only');
    const go = bar.querySelectorAll('button[data-chat-current]');
    expect(go).toHaveLength(1);
    expect(go[0].textContent).toBe('Current chat');
    expect(doc(r.pastBarHtml({ current: false, online: true })).querySelector('[data-chat-current]')!.textContent).toBe('homeStartChat');
    expect(doc(r.pastBarHtml({ current: false, online: false })).querySelector('[data-chat-current]')!.textContent).toBe('homeLeaveMessage');
  });

  it('the closed line: a quiet divider, by name or the system\'s; the next conversation under it needs no second one', () => {
    const t = new Date().toISOString();
    const closed = (name: string | null) => ({ __id: 'x' + name, sender: 'operator', senderType: 'system', body: '', time: t,
      metadata: { kind: 'conversation_closed', agent_name: name, status: 'closed' } });
    const html = r.messagesHtml({ messages: [
      { __id: 'm1', sender: 'operator', senderName: 'Sara', body: 'bye', time: t },
      closed('Sara'),
      { __id: 'm2', sender: 'visitor', body: 'one more', time: t, threadStart: true },
    ] }, '', {});
    const lines = Array.from(doc(html).querySelectorAll('.msg-day span')).map((e) => e.textContent);
    // The day, the close; no «New conversation» right under it.
    expect(lines.slice(1)).toEqual(['Sara ended the chat']);
    // The operator's run ends at the line: its time is on her bubble.
    expect(doc(html).querySelectorAll('.msg-meta')).toHaveLength(2);
    const nameless = doc(r.messagesHtml({ messages: [closed(null)] }, '', {}));
    expect(Array.from(nameless.querySelectorAll('.msg-day span')).map((e) => e.textContent).pop()).toBe('Chat ended');
    expect(r.closedNotice).toBe(true);
    expect(r.features).toBeUndefined();
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

// The owner-approved fix to `default` (and `intl`, the same renderer) of
// issue #340 (g5-3b): an operator's name reached Core's sentences through
// String.replace (`$&`, `$'`, `` $` ``, `$$` expanded) and the call card
// escaped it twice ("A&B" read "A&amp;B").
describe('widget presentation — default puts names into Core\'s sentences literally', () => {
  const own: Record<string, string> = {
    routingAgentJoined: '{name} پیوست',
    ciHeadlineAudioFrom: '{op} تماس می‌گیرد',
    ciHeadlineVideoFrom: '{op} تماس تصویری می‌گیرد',
  };
  function make() {
    new Function(REGISTRY_SRC).call(window);
    new Function(RENDERER_SRC).call(window);
    const mod = win()[win().__gs_presentation_registry.resolve('default').globalKey];
    // No escapeHtml: the renderer's own (quotes included), as Core's.
    return mod.create({ t: (k: string) => own[k] ?? k, config: {}, locale: 'fa' });
  }
  const parse = (html: string) => {
    const box = document.createElement('div');
    box.innerHTML = html;
    return box;
  };
  const call = (meta: Record<string, unknown>) => ({ senderType: 'system', createdAt: new Date().toISOString(), metadata: { kind: 'call_invitation', invitation_id: 'i1', ...meta } });

  it.each(["A$'B$&C$`D$$E", 'A&B <i>x</i> "q" \'s'])('%s: the join row and the call card say it once, literally', (name) => {
    const r = make();
    const joined = parse(r.routingOutcomeRowHtml({ senderType: 'system', metadata: { kind: 'routing_agent_joined', agent_name: name } }));
    expect(joined.querySelector('.msg-system-pill')!.textContent).toBe(name + ' پیوست');
    const moved = parse(r.routingOutcomeRowHtml({ senderType: 'system', metadata: { kind: 'conversation_transferred', to_name: name } }));
    expect(moved.querySelector('.msg-system-pill')!.textContent).toBe(name + ' پیوست');
    for (const [channel, suffix] of [['audio', ' تماس می‌گیرد'], ['video', ' تماس تصویری می‌گیرد']]) {
      for (const status of ['pending', 'joined']) {
        const card = parse(r.callInvitationCardHtml(call({ channel, status, operator_name: name })));
        expect(card.querySelector('.ci-title')!.textContent, `${channel} ${status}`).toBe(name + suffix);
        expect(card.querySelector('.ci-title i'), 'never markup').toBeNull();
      }
    }
  });

  it('without a name: the generic sentences, as before', () => {
    const r = make();
    expect(parse(r.routingOutcomeRowHtml({ senderType: 'system', metadata: { kind: 'routing_agent_joined' } })).textContent).toBe('routingAgentJoinedGeneric');
    expect(parse(r.callInvitationCardHtml(call({ channel: 'audio', status: 'joined' }))).querySelector('.ci-title')!.textContent).toBe('ciHeadlineAudio');
  });

  it('a call status named after an Object.prototype key draws no state text, never prototype text', () => {
    const r = make();
    for (const status of ['constructor', 'toString', '__proto__', 'valueOf']) {
      const card = parse(r.callInvitationCardHtml(call({ channel: 'audio', status })));
      expect(card.querySelector('.ci-status')!.textContent, status).toBe('');
      expect(card.textContent, status).not.toMatch(/function|native code|\[object/);
    }
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

  it('keeps no word only a retired surface drew (one conversation per visitor: no status pills, no "start new")', () => {
    const renderers = readdirSync('public/widget').filter((f) => /^(presentation|runtime)-[a-z0-9-]+\.js$/.test(f))
      .map((f) => readFileSync(`public/widget/${f}`, 'utf8'));
    for (const key of ['wyStartNew', 'wyRecentConversations', 'wyViewConversations', 'wyConversations', 'wyStatusOpen', 'wyStatusResolved']) {
      expect(RUNTIME, key).not.toMatch(new RegExp(`\\b${key}\\s*:`));
      for (const src of renderers) expect(src, key).not.toMatch(new RegExp(`['"]${key}['"]`));
    }
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
  let r: Renderer;
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
    // GET /config's body is built in the widget config snapshot module.
    const route = readFileSync('server/services/widget/configSnapshot.ts', 'utf8');
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
      skin: null,
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
