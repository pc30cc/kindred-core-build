/**
 * Super Admin → Widget settings → Widget templates
 * (src/components/admin/widget/WidgetCatalogSection.tsx) over a stubbed
 * GET / PUT /api/admin/widget-catalog:
 *
 *   - one card per template of the edition, named by the i18n default while
 *     unnamed; nothing to save until something changes;
 *   - enabling a template and saving sends the whole catalog in display order
 *     (names cleared to null, the option defaults);
 *   - disabling a template that workspaces chose asks first;
 *   - the default cannot be disabled (pick another default first);
 *   - a server `code` is explained in the dashboard's language;
 *   - before migration 275: read only, with the note;
 *   - a refetch (the window regaining focus) keeps unsaved edits, and refills
 *     the form while there are none;
 *   - the preview gets the drafted option defaults cleaned as the server
 *     stores them (a topic row still being typed is left out);
 *   - the on/off options (Template 2's rating after a chat, the transcript
 *     by email) are Super Admin defaults like the others;
 *   - the International edition's skins over Templates 1 and 2 (Classic,
 *     Simple) carry the logo direction, a default the save sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';

const toastMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ toast: toastMock, useToast: () => ({ toasts: [], toast: toastMock }) }));
// The visitors' languages (usePlatformRegion().allowedLocales; Iran: Persian
// only), which the preview speaks, apart from the dashboard's own.
const visitorLocales = vi.hoisted(() => ({ list: ['en', 'fa', 'tr'] as string[] }));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ allowedLocales: visitorLocales.list, canSwitchLanguage: visitorLocales.list.length > 1 }),
}));
// The transcript by email / the away email step as they come back once
// visitor email is switched on (shared/visitorEmail.ts; off since 2026-10-21,
// checked as such in src/test/widget/visitorEmailSwitch.test.ts).
vi.mock('../../../shared/visitorEmail.js', () => ({ VISITOR_EMAIL_FEATURES_ENABLED: true, VISITOR_EMAIL_TEMPLATE_OPTIONS: ['transcriptEmail'] }));

import { WidgetCatalogSection } from '@/components/admin/widget/WidgetCatalogSection';

type Row = Record<string, unknown>;

/** The option defaults the server answers with (every key each template reads). */
const T1_OPTIONS = { navStyle: 'vb', navMode: 'active', topics: [], prechatMode: 'card', csat: true, transcriptEmail: true };
const T2_OPTIONS = { topics: [], askExamples: [], csat: true, transcriptEmail: true };

function catalog(overrides: Row = {}): Row {
  return {
    edition: 'iran',
    ready: true,
    defaultId: 'default',
    templates: [
      { id: 'default', enabled: true, order: 0, name: {}, options: {}, optionSpec: {}, chosenBy: 0 },
      { id: 't1', enabled: false, order: 1, name: {}, options: T1_OPTIONS, optionSpec: {}, chosenBy: 3 },
      { id: 't2', enabled: false, order: 2, name: {}, options: T2_OPTIONS, optionSpec: {}, chosenBy: 0 },
    ],
    followingDefault: 12,
    limits: { nameMax: 40, orderMax: 99 },
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  };
}

let current: Row;
let puts: Row[];
let putAnswer: { status: number; body: Row } | null;

beforeEach(() => {
  current = catalog();
  puts = [];
  putAnswer = null;
  visitorLocales.list = ['en', 'fa', 'tr'];
  toastMock.mockReset();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Row;
      puts.push(body);
      if (putAnswer) return new Response(JSON.stringify(putAnswer.body), { status: putAnswer.status });
      return new Response(JSON.stringify(current), { status: 200 });
    }
    return new Response(JSON.stringify(current), { status: 200 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

let qc: QueryClient;

async function mount() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <WidgetCatalogSection />
      </I18nProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('Chat widget templates');
  return () => document.querySelector(`[data-catalog-template="t1"]`) as HTMLElement;
}

const saveButton = () => screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
const switchOf = (card: HTMLElement) => within(card).getByRole('switch', { name: 'Enabled' }) as HTMLButtonElement;

describe('WidgetCatalogSection', () => {
  it('one card per template, default names, nothing to save yet', async () => {
    await mount();
    expect(document.querySelectorAll('[data-catalog-template]')).toHaveLength(3);
    for (const name of ['Familiar', 'Turquoise', 'Breeze']) expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    expect(screen.getByText('12 workspaces never chose and wear the default')).toBeTruthy();
    expect(screen.getByText('3 workspaces chose this template')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('enabling a template and saving sends the whole catalog in order', async () => {
    const t1 = await mount();
    fireEvent.click(switchOf(t1()));
    const enName = within(t1()).getByLabelText('Display name (English)');
    fireEvent.change(enName, { target: { value: 'Sea' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      defaultId: 'default',
      templates: [
        { id: 'default', enabled: true, order: 0, name: { fa: null, en: null, tr: null }, options: {} },
        { id: 't1', enabled: true, order: 1, name: { fa: null, en: 'Sea', tr: null }, options: T1_OPTIONS },
        { id: 't2', enabled: false, order: 2, name: { fa: null, en: null, tr: null }, options: T2_OPTIONS },
      ],
    });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Templates saved' })));
  });

  it('disabling a template workspaces chose asks first', async () => {
    current = catalog({
      templates: (catalog().templates as Row[]).map((tpl) => (tpl.id === 't1' ? { ...tpl, enabled: true } : tpl)),
    });
    const t1 = await mount();
    fireEvent.click(switchOf(t1()));
    fireEvent.click(saveButton());
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('3 workspaces chose “Turquoise”');
    expect(puts).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect((puts[0].templates as Row[])[1]).toMatchObject({ id: 't1', enabled: false });
  });

  it('the technical id keeps Latin digits in Persian, and the title row nests no block inside a paragraph', async () => {
    const t1 = await mount();
    const id = within(t1()).getByText('t1');
    expect(id.closest('[data-latin-digits]')).not.toBeNull();
    // Badge renders a <div>: never inside a <p> (validateDOMNesting).
    expect(document.querySelector('[data-widget-catalog] p div')).toBeNull();
  });

  it('in Persian the numbered placeholders use Persian digits, like the text around them', async () => {
    const fa = (await import('@/i18n/locales/fa')).default;
    const { TemplateOptionsFields } = await import('@/components/app/widget/TemplateOptionsFields');
    render(
      <I18nProvider initialLocale="fa" initialTranslations={fa}>
        <TemplateOptionsFields
          templateId="t2"
          value={{ topics: [{ label: '', icon: 'truck' }], askExamples: [] }}
          onChange={() => undefined}
          idPrefix="fa-digits"
        />
      </I18nProvider>,
    );
    expect(await screen.findByPlaceholderText('موضوع ۱')).toBeTruthy();
    expect(screen.getByPlaceholderText('نمونه ۲')).toBeTruthy();
    expect(screen.getByLabelText('حذف موضوع ۱')).toBeTruthy();
  });

  it('moving the default counts every workspace that follows it: never chose, or chose a template that stays disabled', async () => {
    await mount();
    const t2 = document.querySelector('[data-catalog-template="t2"]') as HTMLElement;
    fireEvent.click(switchOf(t2));
    fireEvent.click(within(t2).getByRole('radio'));
    fireEvent.click(saveButton());
    const dialog = await screen.findByRole('alertdialog');
    // 12 never chose; t1's 3 choosers wear the default while t1 is disabled.
    expect(dialog.textContent).toContain('15 workspaces');
    expect(dialog.textContent).toContain('“Breeze”');
    expect(dialog.textContent).toContain('plan');
    expect(puts).toEqual([]);
  });

  it('the default stays enabled; reordering moves the card', async () => {
    await mount();
    const def = document.querySelector('[data-catalog-template="default"]') as HTMLElement;
    expect(switchOf(def).disabled).toBe(true);
    fireEvent.click(within(def).getByRole('button', { name: 'Move down' }));
    const order = [...document.querySelectorAll('[data-catalog-template]')].map((el) => el.getAttribute('data-catalog-template'));
    expect(order).toEqual(['t1', 'default', 't2']);
  });

  it('a server code is explained', async () => {
    putAnswer = { status: 409, body: { error: 'needs 275', code: 'migration_required' } };
    const t1 = await mount();
    fireEvent.click(switchOf(t1()));
    fireEvent.click(saveButton());
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Saving these settings needs database migration 275.',
      variant: 'destructive',
    })));
  });

  it('before migration 275: read only, with the note', async () => {
    current = catalog({ ready: false, followingDefault: null });
    const t1 = await mount();
    expect(screen.getByText(/migration 275 is not applied yet/)).toBeTruthy();
    expect(switchOf(t1()).disabled).toBe(true);
    expect((within(t1()).getByLabelText('Display name (English)') as HTMLInputElement).disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it('a refetch keeps unsaved edits, and refills the form while there are none', async () => {
    const t1 = await mount();
    const enName = () => within(t1()).getByLabelText('Display name (English)') as HTMLInputElement;
    fireEvent.change(enName(), { target: { value: 'Sea' } });
    // Another workspace follows the default now, and another admin named t2.
    current = catalog({
      followingDefault: 13,
      templates: (catalog().templates as Row[]).map((tpl) => (tpl.id === 't2' ? { ...tpl, name: { en: 'Wind' } } : tpl)),
    });
    await qc.refetchQueries({ queryKey: ['admin', 'widget-catalog'] });
    await screen.findByText('13 workspaces never chose and wear the default');
    expect(enName().value).toBe('Sea');
    expect(saveButton().disabled).toBe(false);

    // Discarded: the form is the stored catalog again, and follows the next answer.
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(enName().value).toBe('');
    current = catalog({
      templates: (catalog().templates as Row[]).map((tpl) => (tpl.id === 't1' ? { ...tpl, enabled: true, name: { en: 'Reef' } } : tpl)),
    });
    await qc.refetchQueries({ queryKey: ['admin', 'widget-catalog'] });
    await waitFor(() => expect(enName().value).toBe('Reef'));
    expect(switchOf(t1()).getAttribute('aria-checked')).toBe('true');
    expect(saveButton().disabled).toBe(true);
  });

  it('the preview gets the drafted option defaults cleaned as the server stores them', async () => {
    const t1 = await mount();
    const addTopic = () => within(t1()).getByRole('button', { name: 'Add a topic' });
    fireEvent.click(addTopic());
    fireEvent.click(addTopic());
    fireEvent.change(within(t1()).getByLabelText('Topic 1'), { target: { value: '  Shipping  ' } });
    fireEvent.click(within(t1()).getByRole('button', { name: 'Preview' }));
    const frame = await waitFor(() => {
      const el = document.querySelector('iframe');
      if (!el) throw new Error('no preview frame');
      return el;
    });
    const m = /var GS_PREVIEW = (\{.*\});\n/.exec(frame.getAttribute('srcdoc') || '');
    expect(m).not.toBeNull();
    const p = JSON.parse(m![1]) as { templateId: string; config: { templateOptions: unknown } };
    expect(p.templateId).toBe('t1');
    expect(p.config.templateOptions).toEqual({
      navStyle: 'vb', navMode: 'active', topics: [{ label: 'Shipping', icon: 'truck' }], prechatMode: 'card', csat: true, transcriptEmail: true,
    });
  });

  it('the preview speaks a visitors\' language: Persian on WebYar while the dashboard is English', async () => {
    const previewOf = async () => {
      const t1 = await mount();
      fireEvent.click(within(t1()).getByRole('button', { name: 'Preview' }));
      const frame = await waitFor(() => {
        const el = document.querySelector('iframe');
        if (!el) throw new Error('no preview frame');
        return el;
      });
      const m = /var GS_PREVIEW = (\{.*\});\n/.exec(frame.getAttribute('srcdoc') || '');
      expect(m).not.toBeNull();
      return JSON.parse(m![1]) as { locale: string; rtl: boolean };
    };
    // WebYar (iran): its visitors read Persian only.
    visitorLocales.list = ['fa'];
    expect(await previewOf()).toMatchObject({ locale: 'fa', rtl: true });
    // The template names stay in the dashboard's language.
    expect(screen.getAllByText('Turquoise').length).toBeGreaterThan(0);
    cleanup();
    // RESPOK (multi, en and tr): the dashboard's language, as before.
    visitorLocales.list = ['en', 'tr'];
    expect(await previewOf()).toMatchObject({ locale: 'en', rtl: false });
  });

  it('the rating after a chat and the transcript by email are on/off defaults the save sends', async () => {
    await mount();
    const t2 = document.querySelector('[data-catalog-template="t2"]') as HTMLElement;
    const rating = within(t2).getByRole('switch', { name: 'Rating after a chat' });
    const mail = within(t2).getByRole('switch', { name: 'Email the transcript' });
    expect([rating.getAttribute('aria-checked'), mail.getAttribute('aria-checked')]).toEqual(['true', 'true']);
    fireEvent.click(rating);
    const t1 = document.querySelector('[data-catalog-template="t1"]') as HTMLElement;
    // Template 1 rates too (every template since the inactivity close), and has the transcript (its menu).
    expect(within(t1).getByRole('switch', { name: 'Rating after a chat' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(t1).getByRole('switch', { name: 'Email the transcript' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts).toHaveLength(1));
    const sent = puts[0].templates as Row[];
    expect(sent[1].options).toEqual({ ...T1_OPTIONS, transcriptEmail: false });
    expect(sent[2].options).toEqual({ ...T2_OPTIONS, csat: false });
  });

  it('International: Classic and Simple, with the logo direction (Thread by default) as a default the save sends', async () => {
    const T1I = { logoDirection: 'thread', ...T1_OPTIONS };
    const T2I = { logoDirection: 'thread', ...T2_OPTIONS };
    current = catalog({
      edition: 'international',
      defaultId: 'intl',
      templates: [
        { id: 'intl', enabled: true, order: 0, name: {}, options: {}, optionSpec: {}, chosenBy: 0 },
        { id: 't1-intl', enabled: false, order: 1, name: {}, options: T1I, optionSpec: {}, chosenBy: 0 },
        { id: 't2-intl', enabled: false, order: 2, name: {}, options: T2I, optionSpec: {}, chosenBy: 0 },
      ],
    });
    await mount();
    for (const name of ['Classic', 'Simple']) expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    const t1i = document.querySelector('[data-catalog-template="t1-intl"]') as HTMLElement;
    const t2i = document.querySelector('[data-catalog-template="t2-intl"]') as HTMLElement;
    const group = within(t1i).getByRole('radiogroup', { name: 'Logo style' });
    const [thread, open] = within(group).getAllByRole('radio');
    expect([thread.getAttribute('aria-checked'), open.getAttribute('aria-checked')]).toEqual(['true', 'false']);
    expect(open.textContent).toBe('Open: a bubble and a dot');
    expect(within(t2i).getByRole('radiogroup', { name: 'Logo style' })).toBeTruthy();
    // The catalog's own template has no options, so no logo choice.
    expect(within(document.querySelector('[data-catalog-template="intl"]') as HTMLElement).queryByRole('radiogroup')).toBeNull();
    fireEvent.click(open);
    expect(open.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts).toHaveLength(1));
    const sent = puts[0].templates as Row[];
    expect(sent.map((tpl) => tpl.id)).toEqual(['intl', 't1-intl', 't2-intl']);
    expect(sent[1].options).toEqual({ ...T1I, logoDirection: 'open' });
    expect(sent[2].options).toEqual(T2I);
  });

  it('the preview dialog is described by the template description (no Radix accessibility warning)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const t1 = await mount();
      fireEvent.click(within(t1()).getByRole('button', { name: 'Preview' }));
      const dialog = await screen.findByRole('dialog');
      const describedBy = dialog.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)?.textContent).toBe('A coloured home with cards and a bottom menu: Home, Chat, Help');
      await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
      expect(warn.mock.calls.some((c) => String(c[0]).includes('Description'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
