/**
 * The chat widget template choice in the dashboard.
 *
 *   - effectiveWorkspaceTemplate / templatePickerVisible
 *     (src/hooks/useWidgetCatalog.ts): what every preview renders, and when
 *     Widget → Appearance shows the card (two or more enabled, 275 applied;
 *     never from a stored id the catalog does not offer);
 *   - TemplateChoiceCard: one card per enabled template, named by the Super
 *     Admin or by the i18n default, the default badged; a pick calls back; a
 *     plan without the Appearance editor sees it disabled with the upgrade
 *     hint; the selected template's options;
 *   - WidgetLivePreview: the effective template and its options reach the
 *     frame (config.templateOptions, as the bootstrap), the Messages view
 *     renders the conversation list, the frame navigates by [data-view] in
 *     Core's order (a named back or a conversation row first), and a
 *     renderer that declares `tabs` / `kbSearch` / `visitorName` gets Core's
 *     view-model fields, its current tab and its unread badge (the default
 *     declares none: unchanged);
 *   - WidgetPage saves a pick through mutateAsync, so its refusal handling
 *     runs even when a debounced field save is sent meanwhile.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import { TemplateChoiceCard } from '@/components/app/widget/TemplateChoiceCard';
import { templateVisitorFeatures } from '@/lib/widgetTemplateNames';
import { WidgetLivePreview } from '@/components/app/widget/WidgetLivePreview';
import { effectiveWorkspaceTemplate, templateCardVisible, templatePickerVisible, type WorkspaceWidgetCatalog } from '@/hooks/useWidgetCatalog';

afterEach(cleanup);

const VIEW: WorkspaceWidgetCatalog = {
  edition: 'iran',
  ready: true,
  defaultId: 'default',
  templates: [
    { id: 'default', name: null, isDefault: true, options: {} },
    { id: 't1', name: 'Sea', isDefault: false, options: { navStyle: 'vc', navMode: 'active', topics: [] } },
  ],
  selectedId: null,
  selectedOptions: {},
  selectedUnavailable: false,
  effectiveId: 'default',
  effectiveOptions: {},
  planAllowsChoice: true,
  canChoose: true,
};

describe('effectiveWorkspaceTemplate', () => {
  it('without the catalog (loading, an older backend): the edition default, whatever is stored', () => {
    expect(effectiveWorkspaceTemplate(undefined, 'iran', 't1', { navMode: 'none' }, true)).toEqual({ id: 'default', options: {} });
    expect(effectiveWorkspaceTemplate(undefined, 'international', 't1', {}, true)).toEqual({ id: 'intl', options: {} });
  });

  it('the drafted choice while enabled, with the merged options', () => {
    expect(effectiveWorkspaceTemplate(VIEW, 'iran', 't1', { navMode: 'none', junk: 1 }, true))
      .toEqual({ id: 't1', options: { navStyle: 'vc', navMode: 'none', topics: [], prechatMode: 'card', transcriptEmail: false } });
    expect(effectiveWorkspaceTemplate(VIEW, 'iran', null, {}, true).id).toBe('default');
    expect(effectiveWorkspaceTemplate(VIEW, 'iran', 't2', {}, true).id).toBe('default');
  });

  it('a plan without widget_appearance previews the default with no workspace options', () => {
    expect(effectiveWorkspaceTemplate(VIEW, 'iran', 't1', { navMode: 'none' }, false)).toEqual({ id: 'default', options: {} });
    expect(effectiveWorkspaceTemplate({ ...VIEW, defaultId: 't1', planAllowsChoice: false }, 'iran', 'default', { navMode: 'none' }, true))
      .toEqual({ id: 't1', options: { navStyle: 'vc', navMode: 'active', topics: [], prechatMode: 'card', transcriptEmail: false } });
  });

  it('the card shows only with two or more templates enabled and 275 applied', () => {
    expect(templatePickerVisible(undefined)).toBe(false);
    expect(templatePickerVisible(VIEW)).toBe(true);
    expect(templatePickerVisible({ ...VIEW, templates: VIEW.templates.slice(0, 1) })).toBe(false);
    expect(templatePickerVisible({ ...VIEW, ready: false })).toBe(false);
    // The plan does not hide it (the card is shown disabled).
    expect(templatePickerVisible({ ...VIEW, planAllowsChoice: false, canChoose: false })).toBe(true);
  });

  it('with a single template enabled the card stays only for that template\'s own options', () => {
    const onlyT1: WorkspaceWidgetCatalog = { ...VIEW, defaultId: 't1', templates: [{ ...VIEW.templates[1], isDefault: true }], effectiveId: 't1', canChoose: false };
    const onlyDefault: WorkspaceWidgetCatalog = { ...VIEW, templates: VIEW.templates.slice(0, 1), canChoose: false };
    expect(templateCardVisible(VIEW, 'default')).toBe(true);
    expect(templateCardVisible(onlyT1, 't1')).toBe(true);
    expect(templateCardVisible(onlyDefault, 'default')).toBe(false);
    // A stored choice that is no longer enabled keeps the card, for its
    // warning, even when the default is all that is left.
    expect(templateCardVisible({ ...onlyDefault, selectedId: 't2', selectedUnavailable: true }, 'default')).toBe(true);
    expect(templateCardVisible({ ...onlyT1, ready: false }, 't1')).toBe(false);
    expect(templateCardVisible(undefined, 't1')).toBe(false);
  });
});

/** Renders the card and waits for the provider's locale to load. */
async function card(props: Partial<Parameters<typeof TemplateChoiceCard>[0]> = {}) {
  const onChoose = vi.fn();
  const onOptionsChange = vi.fn();
  render(
    <I18nProvider>
      <TemplateChoiceCard
        view={VIEW}
        effectiveId="default"
        draftId={null}
        draftOptions={{}}
        planAllows
        onChoose={onChoose}
        onOptionsChange={onOptionsChange}
        {...props}
      />
    </I18nProvider>,
  );
  await screen.findAllByRole('radio');
  return { onChoose, onOptionsChange };
}

describe('TemplateChoiceCard', () => {
  it('lists the enabled templates by the Super Admin\'s name or the default name, the default badged', async () => {
    await card();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios[0].textContent).toContain('Familiar');
    expect(radios[0].textContent).toContain('Default');
    expect(radios[1].textContent).toContain('Sea');
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
  });

  // V-36: what visitors get differs by template; each one says so.
  it('each template lists what its visitors get', async () => {
    await card();
    const [def, t1] = screen.getAllByRole('radio').map((r) => r.querySelector('[data-tpl-features]')!.textContent || '');
    expect(def).toContain('Operator typing');
    expect(def).not.toContain('Place in the queue');
    expect(t1).toContain('Place in the queue');
    expect(t1).not.toContain('Rating after a chat');
    expect(templateVisitorFeatures('t2')).toEqual(['typing', 'closedLine', 'rating', 'reactions']);
    expect(templateVisitorFeatures('t2-intl')).toEqual(templateVisitorFeatures('t2'));
    expect(templateVisitorFeatures('intl')).toEqual(['typing']);
    expect(templateVisitorFeatures('nope')).toEqual([]);
  });

  it('a pick calls back with the id', async () => {
    const { onChoose } = await card();
    fireEvent.click(screen.getAllByRole('radio')[1]);
    expect(onChoose).toHaveBeenCalledWith('t1');
  });

  it('shows the selected template\'s options (bottom menu for t1), none for default', async () => {
    await card({ effectiveId: 't1', draftId: 't1' });
    expect(screen.getByText('Bottom menu style')).toBeTruthy();
    expect(screen.getByText('Quick topics')).toBeTruthy();
    cleanup();
    await card();
    expect(screen.queryByText('Bottom menu style')).toBeNull();
  });

  it('a plan without the Appearance editor: disabled, with the upgrade hint, no options', async () => {
    const { onChoose } = await card({ planAllows: false, effectiveId: 't1' });
    for (const radio of screen.getAllByRole('radio')) expect((radio as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole('radio')[0]);
    expect(onChoose).not.toHaveBeenCalled();
    expect(screen.getByText('Not included in your plan')).toBeTruthy();
    expect(screen.queryByText('Bottom menu style')).toBeNull();
  });

  it('says so when the stored choice is unavailable, naming it and the default', async () => {
    await card({ view: { ...VIEW, selectedId: 't2', selectedUnavailable: true }, draftId: 't2' });
    const warning = screen.getByText(/not available right now/).textContent;
    expect(warning).toContain('“Breeze”');
    expect(warning).toContain('“Familiar”');
    expect(warning).toContain('Your choice is kept');
  });

  it('picking the catalog\'s default entry stores its id, so a later move of the default does not move it', async () => {
    const { onChoose } = await card({ effectiveId: 't1', draftId: 't1' });
    fireEvent.click(screen.getAllByRole('radio')[0]);
    expect(onChoose).toHaveBeenCalledWith('default');
    cleanup();
    // The Super Admin's default may be another template: the same rule.
    const moved: WorkspaceWidgetCatalog = {
      ...VIEW,
      defaultId: 't1',
      templates: [{ ...VIEW.templates[0], isDefault: false }, { ...VIEW.templates[1], isDefault: true }],
    };
    const second = await card({ view: moved, effectiveId: 'default', draftId: 'default' });
    fireEvent.click(screen.getAllByRole('radio')[1]);
    expect(second.onChoose).toHaveBeenCalledWith('t1');
  });

  it('no pick at all: the default is checked, the card says it follows the platform\'s default, and a click on it keeps it', async () => {
    const { onChoose } = await card({ effectiveId: 'default', draftId: null });
    expect(screen.getByText(/You have not picked a template/).textContent).toContain('“Familiar”');
    const radios = screen.getAllByRole('radio');
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    fireEvent.click(radios[0]);
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith('default');
  });

  it('a stored choice that is unavailable: a click on the (checked) default entry picks the default', async () => {
    const { onChoose } = await card({ view: { ...VIEW, selectedId: 't2', selectedUnavailable: true }, draftId: 't2' });
    const radios = screen.getAllByRole('radio');
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText(/You have not picked a template/)).toBeNull();
    fireEvent.click(radios[0]);
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith('default');
  });

  it('a click on the checked entry otherwise changes nothing', async () => {
    const { onChoose } = await card({ effectiveId: 't1', draftId: 't1' });
    fireEvent.click(screen.getAllByRole('radio')[1]);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('a single template: no picker, but its own options', async () => {
    const onOptionsChange = vi.fn();
    render(
      <I18nProvider>
        <TemplateChoiceCard
          view={{ ...VIEW, defaultId: 't1', templates: [{ ...VIEW.templates[1], isDefault: true }], effectiveId: 't1', canChoose: false }}
          effectiveId="t1"
          draftId={null}
          draftOptions={{}}
          planAllows
          onChoose={vi.fn()}
          onOptionsChange={onOptionsChange}
        />
      </I18nProvider>,
    );
    expect(await screen.findByText('Bottom menu style')).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    fireEvent.click(screen.getByText('Add a topic'));
    expect(onOptionsChange).toHaveBeenCalledWith({ topics: [{ label: '', icon: 'truck' }] });
  });
});

function srcdoc(props: Partial<Parameters<typeof WidgetLivePreview>[0]> = {}) {
  const { container } = render(<WidgetLivePreview settings={{ widget_language: 'en' }} brandName="Acme" view="home" {...props} />);
  return container.querySelector('iframe')!.getAttribute('srcdoc') || '';
}
function payload(doc: string): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const m = /var GS_PREVIEW = (\{.*\});\n/.exec(doc);
  if (!m) throw new Error('no payload');
  return JSON.parse(m[1]);
}

describe('WidgetLivePreview — the effective template', () => {
  it('the templateId prop wins over a stored id; its options ride in config', () => {
    const p = payload(srcdoc({
      settings: { widget_language: 'en', widget_template_id: 't2' },
      templateId: 't1',
      templateOptions: { navStyle: 'vd', navMode: 'none', topics: [] },
    }));
    expect(p.templateId).toBe('t1');
    expect(p.config.templateId).toBe('t1');
    expect(p.config.templateOptions).toEqual({ navStyle: 'vd', navMode: 'none', topics: [] });
    expect(p.capabilities).toMatchObject({
      kbNeutral: true, csat: true, chatMenu: true, reactions: true, prechatSteps: true, awayThread: true, queuePosition: true,
      orderCard: true, instantAnswers: true, emojiSearch: true, dlProgress: true, kbAuthor: true,
    });
  });

  it('the default preview stays as it was: default template, no options', () => {
    const p = payload(srcdoc({ templateId: 'default', templateOptions: {} }));
    expect(p.templateId).toBe('default');
    expect(p.config.templateOptions).toEqual({});
    expect(p.shellVm.activeTab).toBe('home');
  });

  it('the Messages view renders the conversation list through the renderer', () => {
    const doc = srcdoc({ view: 'list', templateId: 't1' });
    const p = payload(doc);
    expect(p.shellVm.activeTab).toBe('list');
    expect(p.listVm.conversations).toHaveLength(2);
    expect(p.listVm.conversations[0]).toMatchObject({ status: 'open', unreadCount: 1 });
    expect(doc).toContain('R.conversationListHtml(GS_PREVIEW.listVm)');
    expect(doc).toContain("panel.setAttribute('data-view', GS_PREVIEW.shellVm.activeTab)");
  });

  it('the Messages view speaks as production: every list string is Core\'s own, per language', () => {
    // Core's dictionaries (public/widget/runtime.js) come in the order en, fa, tr.
    const core = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
    // (Markup values, such as the `back` icon, are not dictionary entries.)
    const coreValues = (key: string) => [...core.matchAll(new RegExp(`\\b${key}: '([^']*)'`, 'g'))]
      .map((m) => m[1])
      .filter((v) => !v.startsWith('<'));
    const keys = ['wyConversations', 'wyNoConversations', 'wyNewConversation', 'wyStatusOpen', 'wyStatusResolved', 'wyUnread', 'back'];
    for (const [index, language] of (['en', 'fa', 'tr'] as const).entries()) {
      // The frame paints with the runtime's own dictionary, which it loads.
      const page = new JSDOM(srcdoc({ settings: { widget_language: language }, view: 'list', templateId: 'default' }), { runScripts: 'outside-only' });
      const w = page.window as unknown as { eval: (s: string) => void; gsRenderPreview: (mod: unknown) => void };
      w.eval(core);
      w.eval(Array.from((page.window.document as Document).querySelectorAll('script:not([src])')).map((x) => x.textContent).join('\n'));
      let words: ((key: string) => string) | null = null;
      w.gsRenderPreview({
        create: (env: { t: (key: string) => string }) => {
          words = env.t;
          return { shellHtml: () => '<div data-body></div>', conversationListHtml: () => '' };
        },
      });
      for (const key of keys) {
        const values = coreValues(key);
        expect(values, key).toHaveLength(3);
        expect(words!(key), `${language} ${key}`).toBe(values[index]);
      }
      cleanup();
    }
  });

  it('typed text cannot end the frame\'s script: a topic or a welcome with </script> stays data', () => {
    const label = '</script><b>x';
    const doc = srcdoc({
      settings: { widget_language: 'en', welcome_message: '<!-- </script>' },
      templateId: 't1',
      templateOptions: { topics: [{ label, icon: 'chat' }] },
    });
    // No "<" at all in the embedded payload (escaped as <), so no
    // "</script" or "<!--" can end or bend the script; JSON reads it back.
    const start = doc.indexOf('var GS_PREVIEW = ');
    expect(doc.slice(start, doc.indexOf(';\n', start))).not.toContain('<');
    const p = payload(doc);
    expect(p.config.templateOptions.topics[0].label).toBe(label);
  });

  it('navigates by the renderer\'s [data-view], named backs and conversation rows, in Core\'s order', () => {
    // The frame's own navigation script, run in a page of its own.
    const doc = srcdoc();
    const start = doc.indexOf('function gsBindTabs()');
    const source = doc.slice(start, doc.indexOf('// Preview-only: open a real article', start));
    expect(start).toBeGreaterThan(-1);
    const page = new JSDOM(
      '<div class="panel" data-view="home"><div data-body>'
      + '<nav><button id="tab-help" data-view="help">Help</button></nav>'
      + '<section data-view="list">'
      + '<button id="row" data-conversation-open="c1"><span id="row-inner">Hi</span></button>'
      + '<button id="back-home" data-view-back="home">Back</button>'
      + '<button id="step-back" data-view-back="back" data-view-back-fallback="home">Back</button>'
      + '<p id="plain">text</p>'
      + '</section>'
      + '</div></div>',
    );
    const sent: string[] = [];
    const parentStub = { postMessage: (data: { nav: string }) => sent.push(data.nav) };
    new Function('document', 'parent', 'GS_SMART', `${source}\ngsBindTabs();`)(page.window.document, parentStub, { enabled: false });
    const click = (id: string) => {
      const ev = new page.window.MouseEvent('click', { bubbles: true, cancelable: true });
      page.window.document.getElementById(id)!.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(click('tab-help')).toBe(true);
    // A row and a named back inside a section that names a view: the row and the back.
    expect(click('row-inner')).toBe(true);
    expect(click('back-home')).toBe(true);
    // A step back is the article's (gsBindArticles), never the section's view.
    expect(click('step-back')).toBe(false);
    // Anything else inside the section: the section's view (the panel itself is no trigger).
    expect(click('plain')).toBe(true);
    expect(sent).toEqual(['help', 'chat', 'home', 'list']);
  });

  it('the parent maps a frame navigation to its view (list = Messages)', () => {
    const onViewChange = vi.fn();
    render(<WidgetLivePreview settings={{ widget_language: 'en' }} brandName="Acme" view="home" onViewChange={onViewChange} />);
    for (const [nav, view] of [['list', 'list'], ['help', 'kb'], ['home', 'home'], ['chat', 'chat']] as const) {
      window.dispatchEvent(new MessageEvent('message', { data: { source: 'gs-widget-preview', nav } }));
      expect(onViewChange).toHaveBeenLastCalledWith(view);
    }
  });
});

describe('WidgetLivePreview — a renderer\'s declared features, as Core reads them', () => {
  type Vm = Record<string, unknown>;
  /** The frame's own script in a page of its own, painting with a stand-in renderer. */
  function paint(view: 'home' | 'list' | 'kb', features?: Record<string, boolean>) {
    const page = new JSDOM(srcdoc({ view, templateId: 't1' }), { runScripts: 'outside-only' });
    const inline = Array.from((page.window.document as Document).querySelectorAll('script:not([src])')).map((s) => s.textContent).join('\n');
    page.window.eval(inline);
    const seen: Record<string, Vm> = {};
    const R = {
      features,
      format: { badge: (n: number) => `(${n})` },
      shellHtml: () => '<nav>'
        + '<button data-view="home" aria-current="false">H</button>'
        + '<button data-view="list" aria-current="false">M<span data-tab-badge hidden></span></button>'
        + '<button data-view="help" aria-current="false">?</button>'
        + '</nav><div data-body></div>',
      homeHtml: (vm: Vm) => { seen.home = vm; return '<p>home</p>'; },
      conversationListHtml: (vm: Vm) => { seen.list = vm; return '<p>list</p>'; },
      kbHtml: (vm: Vm) => { seen.kb = vm; return '<p>kb</p>'; },
    };
    (page.window as unknown as { gsRenderPreview: (mod: unknown) => void }).gsRenderPreview({ create: () => R });
    const doc = page.window.document as Document;
    const current = Array.from(doc.querySelectorAll('nav [data-view]')).map((el) => `${el.getAttribute('data-view')}:${el.getAttribute('aria-current')}`);
    const badge = doc.querySelector('[data-tab-badge]') as HTMLElement;
    return { seen, current, badge: { text: badge.textContent, hidden: badge.hidden } };
  }

  it('the default (no features): view models and tabs exactly as before', () => {
    for (const view of ['home', 'list', 'kb'] as const) {
      const { seen, current, badge } = paint(view);
      const vm = seen[view]!;
      for (const key of ['unreadTotal', 'hasSearch', 'visitorName']) expect(key in vm, `${view} ${key}`).toBe(false);
      expect(current).toEqual(['home:false', 'list:false', 'help:false']);
      expect(badge).toEqual({ text: '', hidden: true });
    }
  });

  it('chatHeader / chatMenu: the chat bar as Core paints it for an existing conversation (who answers, a closed ⋯); none without them', () => {
    const chat = (features?: Record<string, boolean>) => {
      const page = new JSDOM(srcdoc({ view: 'chat', templateId: 't1', operatorName: 'Sara' }), { runScripts: 'outside-only' });
      const inline = Array.from((page.window.document as Document).querySelectorAll('script:not([src])')).map((s) => s.textContent).join('\n');
      page.window.eval(inline);
      const headers: Vm[] = [];
      const R = {
        features,
        shellHtml: () => '<div data-body></div>',
        chatFrameHtml: () => '<div data-chat-header>frame bar</div><div data-chat-messages></div>',
        messagesHtml: () => '<p>thread</p>',
        chatHeaderHtml: (vm: Vm) => { headers.push(vm); return '<p>bar</p>'; },
      };
      (page.window as unknown as { gsRenderPreview: (mod: unknown) => void }).gsRenderPreview({ create: () => R });
      return { headers, bar: (page.window.document as Document).querySelector('[data-chat-header]')!.innerHTML };
    };
    const none = chat();
    expect(none.headers).toEqual([]);
    expect(none.bar).toBe('frame bar');
    const header = chat({ chatHeader: true });
    expect(header.headers).toHaveLength(1);
    expect(header.headers[0]).toMatchObject({ isNew: false, online: true, operator: { name: 'Sara', online: true }, menu: null });
    expect(header.bar).toBe('<p>bar</p>');
    const menu = chat({ chatHeader: true, chatMenu: true });
    expect(menu.headers[0].menu).toEqual({ open: false, items: [{ action: 'sound', on: true }] });
  });

  it('tabs / kbSearch / visitorName: Core\'s view-model fields, the current tab and the unread badge', () => {
    const features = { tabs: true, kbSearch: true, visitorName: true };
    const home = paint('home', features);
    expect(home.seen.home).toMatchObject({ unreadTotal: 1, hasSearch: true, visitorName: '' });
    expect(home.current).toEqual(['home:page', 'list:false', 'help:false']);
    expect(home.badge).toEqual({ text: '(1)', hidden: false });

    const list = paint('list', features);
    expect(list.seen.list).toMatchObject({ unreadTotal: 1 });
    expect(list.current).toEqual(['home:false', 'list:page', 'help:false']);

    const kb = paint('kb', features);
    expect(kb.seen.kb).toMatchObject({ unreadTotal: 1, hasSearch: true });
    expect(kb.current).toEqual(['home:false', 'list:false', 'help:page']);
  });
});

describe('WidgetLivePreview — the late surfaces, with the real renderers and extras', () => {
  /** The frame's own script in a page of its own, painting with a real renderer that took its extras. */
  function paintReal(id: 't1' | 't2', props: Partial<Parameters<typeof WidgetLivePreview>[0]>) {
    const page = new JSDOM(srcdoc({ templateId: id, ...props }), { runScripts: 'outside-only' });
    const w = page.window as unknown as Record<string, unknown> & { eval: (s: string) => void };
    const inline = Array.from((page.window.document as Document).querySelectorAll('script:not([src])')).map((s) => s.textContent).join('\n');
    w.eval(inline);
    w.eval(readFileSync(resolve(process.cwd(), `public/widget/presentation-${id}.js`), 'utf8'));
    w.eval(readFileSync(resolve(process.cwd(), `public/widget/presentation-${id}-x.js`), 'utf8'));
    (w as unknown as { gsRenderPreview: (mod: unknown) => void }).gsRenderPreview(w[`__gs_presentation_${id}`]);
    return page.window.document as Document;
  }
  const PRECHAT = { ask_name: true, ask_email: true, ask_phone: true, require_name: true, require_email: true, require_phone: false };

  it('t1 with prechatMode steps: the chat view, the questions so far and the last step in the composer\'s place', () => {
    const doc = paintReal('t1', { view: 'prechat', prechat: PRECHAT as never, templateOptions: { prechatMode: 'steps' } });
    const box = doc.querySelector('[data-composer-zone] [data-prechat-step="phone"]')!;
    expect(box).not.toBeNull();
    expect((doc.querySelector('[data-input-bar]') as HTMLElement).style.display).toBe('none');
    expect(box.querySelector('.pre')!.textContent).toBe('+98');
    expect(box.querySelector('[data-prechat-step-skip]')).not.toBeNull();
    expect(doc.querySelectorAll('[data-chat-messages] .msg.fail')).toHaveLength(1);
    expect(doc.querySelector('#pq-phone')).not.toBeNull();
    // The card option (or none) keeps the form.
    const card = paintReal('t1', { view: 'prechat', prechat: PRECHAT as never, templateOptions: { prechatMode: 'card' } });
    expect(card.querySelector('[data-prechat-step]')).toBeNull();
    expect(card.querySelector('[data-prechat="name"]')).not.toBeNull();
  });

  it('away, capturing a message: the visitor\'s message and the automated reply, which asks for no e-mail (t1, t2)', () => {
    // Visitor e-mail is off (shared/visitorEmail.ts): the reply says the
    // answer comes here, in the chat, as runtime-late.js tells the renderer.
    const t1 = paintReal('t1', { view: 'offline' });
    expect(t1.querySelector('.away-reply')).not.toBeNull();
    const t2 = paintReal('t2', { view: 'offline' });
    expect(t2.querySelector('.away-reply')).not.toBeNull();
    expect(t2.querySelector('.away-reply [data-fb="email"]')).toBeNull();
    expect(t2.querySelector('.away-reply [data-fb-skip]')).toBeNull();
  });

  it('away, "show only the offline message": that message alone, no form and no composer', () => {
    for (const id of ['t1', 't2'] as const) {
      const doc = paintReal(id, { view: 'offline', settings: { widget_language: 'en', offline_mode: 'show_offline_message', offline_message: 'Back soon' } });
      expect(doc.querySelector('.away-reply'), id).toBeNull();
      expect(doc.querySelector('[data-chat-messages]')!.textContent, id).toContain('Back soon');
      expect((doc.querySelector('[data-input-bar]') as HTMLElement).style.display, id).toBe('none');
    }
  });

  it('away, "hide the widget": no launcher and no panel, a note says so', () => {
    const doc = paintReal('t1', { view: 'offline', hiddenNote: 'Hidden while you are offline', settings: { widget_language: 'en', offline_mode: 'hide_widget' } });
    expect(doc.querySelector('.shell')!.hasAttribute('hidden')).toBe(true);
    expect(doc.querySelector('.gs-hidden-note')!.textContent).toBe('Hidden while you are offline');
  });
});

describe('WidgetPage — saving a pick', () => {
  it('goes through mutateAsync: mutate\'s per-call callbacks fire only for the latest call', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/pages/app/WidgetPage.tsx'), 'utf8');
    const start = page.indexOf('const chooseTemplate = ');
    expect(start).toBeGreaterThan(-1);
    const body = page.slice(start, page.indexOf('\n  };\n', start));
    expect(body).toContain('updateWidget.mutateAsync({ widget_template_id: id }).then(');
    expect(body).not.toContain('updateWidget.mutate(');
    // A refusal puts the draft back on the stored choice and refetches.
    expect(body).toContain('delete next.widget_template_id');
    expect(body.match(/refetchTemplates\(\)/g)).toHaveLength(2);
  });
});
