/**
 * «Personality & behavior» (BehaviorPage) — languages.
 *
 *   - the reply language is `instructions.reply_language` and only that: it
 *     never writes allowed_locales (the old Behavior page's "always the
 *     workspace language" rewrote allowed_locales to one language);
 *   - the allowed languages are allowed_locales and only that (all checked
 *     is no limit, `[]`); on a single-language platform they are read-only;
 *   - the per-language messages: the simple view edits the primary language
 *     (the workspace's default when visitors have it, else their first,
 *     never the dashboard's), Advanced the others; a save sends the latest
 *     server map with only the edited languages changed, so another language
 *     is never dropped or rewritten.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  baseSettings, enText, resetStore, serverCopy, store, type Patch,
} from './helpers/personaPage';

vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>();
  const { enText: t } = await import('./helpers/personaPage');
  return { ...actual, useTranslation: () => ({ locale: 'en' as const, dir: 'ltr' as const, t }) };
});
vi.mock('@/hooks/useWorkspace', async () => {
  const { store: s } = await import('./helpers/personaPage');
  return {
    useActiveWorkspace: () => ({ workspace: s.workspace, notFound: false }),
    useCurrentWorkspace: () => s.workspace,
    useWorkspacePath: () => (path: string) => `/${s.workspace.slug}${path}`,
  };
});
vi.mock('@/hooks/usePlatformRegion', async () => {
  const { store: s } = await import('./helpers/personaPage');
  return { usePlatformRegion: () => ({ mode: 'multi', allowedLocales: s.locales, canSwitchLanguage: s.locales.length > 1, currency: 'USD' }) };
});
vi.mock('@/hooks/useAiAgent', async () => {
  const React = await import('react');
  const h = await import('./helpers/personaPage');
  return {
    useAiAgentSettings: () => ({ data: React.useSyncExternalStore(h.subscribe, () => h.store.data), isLoading: false }),
    useUpdateAiAgentSettings: () => ({ mutateAsync: h.mutate, isPending: false }),
    useAiAgentDiagnostics: () => ({ data: h.store.diag }),
  };
});
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/ai-agent-api', () => ({
  aiAgentApi: {
    listGuidance: vi.fn(async () => ({ items: [] })),
    createGuidance: vi.fn(async () => ({ item: {} })),
    updateGuidance: vi.fn(async () => ({ item: {} })),
    deleteGuidance: vi.fn(async () => ({ ok: true })),
    generateBusinessDescription: vi.fn(async () => ({ description: 'generated', source: 'ai' })),
    uploadAvatar: vi.fn(async () => ({ avatar_url: 'https://example.com/a.png' })),
    removeAvatar: vi.fn(async () => ({ ok: true })),
    testAi: vi.fn(),
  },
}));

const BehaviorPage = (await import('@/pages/app/ai-agent/BehaviorPage')).default;
const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

async function renderPage() {
  const view = render(<MemoryRouter future={ROUTER_FUTURE}><BehaviorPage /></MemoryRouter>);
  await screen.findByRole('button', { name: enText('aiAgent.guidance.addDefaults') });
  return view;
}

const saveButton = () => screen.getByRole('button', { name: 'Save changes' });

async function save(): Promise<Patch> {
  const before = store.patches.length;
  fireEvent.click(saveButton());
  await waitFor(() => expect(store.patches.length).toBe(before + 1));
  return store.patches[before];
}

function openGroup(id: string) {
  const item = document.querySelector(`[data-persona-advanced="${id}"]`) as HTMLElement;
  fireEvent.click(within(item).getAllByRole('button')[0]);
}

function field(id: string): HTMLTextAreaElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is not on the page`);
  return el as HTMLTextAreaElement;
}

const checkbox = (name: string) => screen.getByRole('checkbox', { name });

beforeEach(() => {
  resetStore();
});
afterEach(() => {
  cleanup();
});

describe('reply language', () => {
  it('shows the stored rule; choosing "always your main language" sends only instructions.reply_language', async () => {
    resetStore(baseSettings({ allowed_locales: ['fa', 'en'] }));
    await renderPage();
    expect(screen.getByRole('radio', { name: enText('aiAgent.persona.behavior.replyVisitor') })).toHaveAttribute('data-state', 'checked');
    // It names the workspace's main language.
    expect(screen.getByText(enText('aiAgent.persona.behavior.replyWorkspaceHint', { language: 'English' }))).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: enText('aiAgent.persona.behavior.replyWorkspace') }));
    expect(await save()).toEqual({ instructions: { reply_language: 'workspace_default' } });
  });

  it('back to the visitor\'s language: the same one key, never allowed_locales', async () => {
    resetStore(baseSettings({ allowed_locales: ['en'], instructions: { tone: 'formal', reply_language: 'workspace_default' } }));
    await renderPage();
    fireEvent.click(screen.getByRole('radio', { name: enText('aiAgent.persona.behavior.replyVisitor') }));
    const patch = await save();
    expect(patch).toEqual({ instructions: { reply_language: 'visitor' } });
    expect(patch).not.toHaveProperty('allowed_locales');
  });

  it('is not offered on a single-language platform', async () => {
    store.locales = ['fa'];
    await renderPage();
    expect(screen.queryByRole('radio', { name: enText('aiAgent.persona.behavior.replyWorkspace') })).not.toBeInTheDocument();
  });
});

describe('allowed languages', () => {
  it('no limit shows every platform language checked; unchecking one sends only allowed_locales', async () => {
    resetStore(baseSettings({ allowed_locales: [] }));
    store.locales = ['fa', 'en', 'tr'];
    await renderPage();
    openGroup('languages');
    for (const name of ['Persian', 'English', 'Turkish']) expect(checkbox(name)).toHaveAttribute('data-state', 'checked');
    fireEvent.click(checkbox('Turkish'));
    expect(await save()).toEqual({ allowed_locales: ['fa', 'en'] });
  });

  it('checking them all again is no limit ([]), and the last one cannot be unchecked', async () => {
    resetStore(baseSettings({ allowed_locales: ['fa'] }));
    await renderPage();
    openGroup('languages');
    expect(checkbox('Persian')).toHaveAttribute('data-state', 'checked');
    expect(checkbox('Persian')).toBeDisabled();
    expect(screen.getByText(enText('aiAgent.persona.advanced.allowedLastOne'))).toBeInTheDocument();
    fireEvent.click(checkbox('English'));
    expect(await save()).toEqual({ allowed_locales: [] });
  });

  it('a listed code the platform does not offer is kept when the owner narrows the list', async () => {
    resetStore(baseSettings({ allowed_locales: ['fa', 'ar'] }));
    store.locales = ['fa', 'en', 'tr'];
    await renderPage();
    openGroup('languages');
    fireEvent.click(checkbox('English'));
    expect(await save()).toEqual({ allowed_locales: ['fa', 'en', 'ar'] });
  });

  it('an unrelated edit never resends allowed_locales', async () => {
    resetStore(baseSettings({ allowed_locales: ['fa', 'ar'] }));
    await renderPage();
    fireEvent.click(screen.getByRole('radio', { name: 'Detailed' }));
    expect(await save()).not.toHaveProperty('allowed_locales');
  });

  it('on a single-language platform the language is shown, not edited', async () => {
    resetStore(baseSettings({ allowed_locales: [] }));
    store.locales = ['fa'];
    await renderPage();
    openGroup('languages');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByText(enText('aiAgent.persona.advanced.allowedSingle', { language: 'Persian' }))).toBeInTheDocument();
  });
});

describe('per-language messages', () => {
  it('the simple view edits the primary language (the workspace default); a save keeps every other language as the server has it', async () => {
    resetStore(baseSettings({ intro_message_localized: { en: 'Hello from Sara', fa: 'سلام از سارا', tr: 'Merhaba' } }));
    await renderPage();
    const welcome = screen.getByLabelText('Welcome message');
    expect(welcome).toHaveValue('Hello from Sara');
    fireEvent.change(welcome, { target: { value: 'Hi, I am Sara' } });
    expect(await save()).toEqual({ intro_message_localized: { en: 'Hi, I am Sara', fa: 'سلام از سارا', tr: 'Merhaba' } });
  });

  it('the primary language is the workspace default even when the dashboard is in another language', async () => {
    store.workspace = { id: 'ws-1', slug: 'acme', default_locale: 'fa' };
    await renderPage();
    expect(screen.getByLabelText('Welcome message')).toHaveValue('سلام از سارا');
    expect(screen.getByLabelText('Welcome message')).toHaveAttribute('dir', 'rtl');
  });

  it('a workspace default the visitors do not have falls back to their first language', async () => {
    store.workspace = { id: 'ws-1', slug: 'acme', default_locale: 'tr' };
    store.locales = ['fa', 'en'];
    await renderPage();
    expect(screen.getByLabelText('Welcome message')).toHaveValue('سلام از سارا');
  });

  it('editing one language and another while a server copy changes a third: each edited language goes, the third comes from the latest copy', async () => {
    resetStore(baseSettings({ intro_message_localized: { en: 'Hello', fa: 'سلام', tr: 'Merhaba' } }));
    store.locales = ['en', 'fa', 'tr'];
    await renderPage();
    openGroup('languages');
    fireEvent.change(screen.getByLabelText('Welcome message'), { target: { value: 'Hi there' } });
    fireEvent.change(field('persona-welcome-fa'), { target: { value: 'درود' } });
    // Someone saved Turkish elsewhere meanwhile.
    act(() => serverCopy(baseSettings({ intro_message_localized: { en: 'Hello', fa: 'سلام', tr: 'Selam' } })));
    expect(field('persona-welcome-fa')).toHaveValue('درود');
    expect(field('persona-welcome-tr')).toHaveValue('Selam');
    expect(await save()).toEqual({ intro_message_localized: { en: 'Hi there', fa: 'درود', tr: 'Selam' } });
  });

  it('handoff and contact-details messages are per language too, and an emptied one is sent as ""', async () => {
    await renderPage();
    openGroup('languages');
    fireEvent.change(field('persona-handoff-message-fa'), { target: { value: '' } });
    fireEvent.change(field('persona-prechat-message-en'), { target: { value: 'Leave your details, please.' } });
    expect(await save()).toEqual({
      handoff_message_localized: { en: 'Connecting you now', fa: '' },
      handoff_prechat_message_localized: { en: 'Leave your details, please.' },
    });
  });

  it('an empty message shows the built-in text in its own language as a hint', async () => {
    resetStore(baseSettings({ intro_message_localized: {}, agent_name: 'Sara' }));
    await renderPage();
    expect(screen.getByLabelText('Welcome message').getAttribute('placeholder')).toContain("I'm Sara");
    openGroup('languages');
    expect(field('persona-welcome-fa').getAttribute('placeholder')).toMatch(/^سلام! من Sara هستم/);
    expect(field('persona-handoff-message-fa').getAttribute('placeholder')).toMatch(/[؀-ۿ]/);
  });

  it('the welcome switch is part of the form: turning it off sends ai_intro_enabled false with Save, not at once', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('switch', { name: enText('aiAgent.persona.identity.welcomeSwitch') }));
    expect(store.patches).toEqual([]);
    expect(screen.queryByLabelText('Welcome message')).not.toBeInTheDocument();
    expect(await save()).toEqual({ ai_intro_enabled: false });
  });
});
