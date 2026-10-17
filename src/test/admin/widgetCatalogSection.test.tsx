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
 *     stores them (a topic row still being typed is left out).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';

const toastMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ toast: toastMock, useToast: () => ({ toasts: [], toast: toastMock }) }));

import { WidgetCatalogSection } from '@/components/admin/widget/WidgetCatalogSection';

type Row = Record<string, unknown>;

function catalog(overrides: Row = {}): Row {
  return {
    edition: 'iran',
    ready: true,
    defaultId: 'default',
    templates: [
      { id: 'default', enabled: true, order: 0, name: {}, options: {}, optionSpec: {}, chosenBy: 0 },
      { id: 't1', enabled: false, order: 1, name: {}, options: { navStyle: 'vb', navMode: 'active', topics: [] }, optionSpec: {}, chosenBy: 3 },
      { id: 't2', enabled: false, order: 2, name: {}, options: { topics: [], askExamples: [] }, optionSpec: {}, chosenBy: 0 },
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
const switchOf = (card: HTMLElement) => within(card).getByRole('switch') as HTMLButtonElement;

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
        { id: 't1', enabled: true, order: 1, name: { fa: null, en: 'Sea', tr: null }, options: { navStyle: 'vb', navMode: 'active', topics: [] } },
        { id: 't2', enabled: false, order: 2, name: { fa: null, en: null, tr: null }, options: { topics: [], askExamples: [] } },
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
    expect(p.config.templateOptions).toEqual({ navStyle: 'vb', navMode: 'active', topics: [{ label: 'Shipping', icon: 'truck' }] });
  });
});
