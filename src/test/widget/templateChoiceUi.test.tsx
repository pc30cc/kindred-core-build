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
 *     renders the conversation list, and the frame navigates by [data-view];
 *   - WidgetPage saves a pick through mutateAsync, so its refusal handling
 *     runs even when a debounced field save is sent meanwhile.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import { TemplateChoiceCard } from '@/components/app/widget/TemplateChoiceCard';
import { WidgetLivePreview } from '@/components/app/widget/WidgetLivePreview';
import { effectiveWorkspaceTemplate, templatePickerVisible, type WorkspaceWidgetCatalog } from '@/hooks/useWidgetCatalog';

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
      .toEqual({ id: 't1', options: { navStyle: 'vc', navMode: 'none', topics: [] } });
    expect(effectiveWorkspaceTemplate(VIEW, 'iran', null, {}, true).id).toBe('default');
    expect(effectiveWorkspaceTemplate(VIEW, 'iran', 't2', {}, true).id).toBe('default');
  });

  it('a plan without widget_appearance previews the default with no workspace options', () => {
    expect(effectiveWorkspaceTemplate(VIEW, 'iran', 't1', { navMode: 'none' }, false)).toEqual({ id: 'default', options: {} });
    expect(effectiveWorkspaceTemplate({ ...VIEW, defaultId: 't1', planAllowsChoice: false }, 'iran', 'default', { navMode: 'none' }, true))
      .toEqual({ id: 't1', options: { navStyle: 'vc', navMode: 'active', topics: [] } });
  });

  it('the card shows only with two or more templates enabled and 275 applied', () => {
    expect(templatePickerVisible(undefined)).toBe(false);
    expect(templatePickerVisible(VIEW)).toBe(true);
    expect(templatePickerVisible({ ...VIEW, templates: VIEW.templates.slice(0, 1) })).toBe(false);
    expect(templatePickerVisible({ ...VIEW, ready: false })).toBe(false);
    // The plan does not hide it (the card is shown disabled).
    expect(templatePickerVisible({ ...VIEW, planAllowsChoice: false, canChoose: false })).toBe(true);
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

  it('says so when the stored choice is unavailable', async () => {
    await card({ view: { ...VIEW, selectedId: 't2', selectedUnavailable: true }, draftId: 't2' });
    expect(screen.getByText(/not available right now/).textContent).toContain('“Familiar”');
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
    expect(p.capabilities).toMatchObject({ kbNeutral: true, csat: false });
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

  it('the Messages view speaks as production: every list string equals Core\'s, per language', () => {
    // Core's dictionaries (public/widget/runtime.js) come in the order en, fa, tr.
    const core = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
    // (Markup values, such as the `back` icon, are not dictionary entries.)
    const coreValues = (key: string) => [...core.matchAll(new RegExp(`\\b${key}: '([^']*)'`, 'g'))]
      .map((m) => m[1])
      .filter((v) => !v.startsWith('<'));
    const keys = ['wyConversations', 'wyNoConversations', 'wyNewConversation', 'wyStatusOpen', 'wyStatusResolved', 'wyUnread', 'back'];
    for (const [index, language] of (['en', 'fa', 'tr'] as const).entries()) {
      const p = payload(srcdoc({ settings: { widget_language: language }, view: 'list', templateId: 'default' }));
      for (const key of keys) {
        const values = coreValues(key);
        expect(values, key).toHaveLength(3);
        expect(p.dict[key], `${language} ${key}`).toBe(values[index]);
      }
      cleanup();
    }
  });

  it('navigates by the renderer\'s [data-view], named backs and conversation rows', () => {
    const doc = srcdoc();
    expect(doc).toContain("target.closest('[data-view]')");
    expect(doc).toContain("target.closest('[data-view-back]')");
    expect(doc).toContain("target.closest('[data-conversation-open]')");
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
