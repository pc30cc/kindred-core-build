/**
 * «Personality & behavior» (BehaviorPage) keeps what the owner is still
 * editing.
 *
 * Every save writes the server's copy back into the settings query
 * (useUpdateAiAgentSettings → setQueryData), and copies also come from
 * refetches. The old Name & messages page reset its form from each one and
 * silently dropped edits still waiting for Save; one language's message
 * coming back wiped another being typed. Here the store behaves like that
 * cache (helpers/personaPage.ts): a save replaces the data the page reads.
 *
 * Also the preview: it shows the unsaved name, picture and welcome message as
 * typed, and one sample exchange marked as a sample; under it the real test
 * (TestAiPanel, the server's test of the saved settings).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  apiError, baseSettings, enText, release, resetStore, serverCopy, store, type Patch,
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
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
const api = vi.hoisted(() => ({
  listGuidance: vi.fn(async () => ({ items: [] })),
  createGuidance: vi.fn(async () => ({ item: {} })),
  updateGuidance: vi.fn(async () => ({ item: {} })),
  deleteGuidance: vi.fn(async () => ({ ok: true })),
  generateBusinessDescription: vi.fn(async () => ({ description: 'generated', source: 'ai' })),
  uploadAvatar: vi.fn(async () => ({ avatar_url: 'https://example.com/a.png' })),
  removeAvatar: vi.fn(async () => ({ ok: true })),
  testAi: vi.fn(async () => ({
    action: 'answer', answer: 'We ship in two days.', confidence_bucket: 'high', sources: [], reason: 'answer',
  })),
}));
vi.mock('@/lib/ai-agent-api', () => ({ aiAgentApi: api }));

const BehaviorPage = (await import('@/pages/app/ai-agent/BehaviorPage')).default;
const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

async function renderPage() {
  const view = render(<MemoryRouter future={ROUTER_FUTURE}><BehaviorPage /></MemoryRouter>);
  await screen.findByRole('button', { name: enText('aiAgent.guidance.addDefaults') });
  return view;
}

const saveButton = () => screen.getByRole('button', { name: 'Save changes' });
const nameField = () => screen.getByLabelText('Name');
const preview = () => document.querySelector('[data-persona-preview]') as HTMLElement;

async function save(): Promise<Patch> {
  const before = store.patches.length;
  fireEvent.click(saveButton());
  await waitFor(() => expect(store.patches.length).toBe(before + 1));
  return store.patches[before];
}

beforeEach(() => {
  resetStore();
  toast.success.mockClear();
  toast.error.mockClear();
  api.uploadAvatar.mockClear();
  api.testAi.mockClear();
});
afterEach(() => {
  cleanup();
});

describe('a server copy never wipes what is being edited', () => {
  it('edits typed while a save is on its way survive its response, and are the next save', async () => {
    store.hold = true;
    await renderPage();
    fireEvent.change(nameField(), { target: { value: 'Nim' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(store.patches).toEqual([{ agent_name: 'Nim' }]));

    // Still typing while it saves.
    fireEvent.change(nameField(), { target: { value: 'Nima' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Short' }));
    await act(async () => { release(); });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));

    expect(nameField()).toHaveValue('Nima');
    expect(screen.getByRole('radio', { name: 'Short' })).toHaveAttribute('data-state', 'checked');
    expect(screen.getByText(enText('aiAgent.persona.save.unsaved'))).toBeInTheDocument();
    expect(await save()).toEqual({ agent_name: 'Nima', instructions: { max_answer_length: 'short' } });
  });

  it('a copy from elsewhere (a refetch, another tab) moves untouched controls and keeps the edited ones', async () => {
    await renderPage();
    fireEvent.change(nameField(), { target: { value: 'Nima' } });
    act(() => serverCopy(baseSettings({ agent_name: 'Changed elsewhere', business_description: 'New description from elsewhere' })));

    expect(nameField()).toHaveValue('Nima');
    expect(screen.getByLabelText('About your business')).toHaveValue('New description from elsewhere');
    expect(await save()).toEqual({ agent_name: 'Nima' });
  });

  it('after a successful save the page is clean and shows the server\'s copy', async () => {
    await renderPage();
    fireEvent.change(nameField(), { target: { value: '  Nima  ' } });
    expect(await save()).toEqual({ agent_name: 'Nima' });
    await waitFor(() => expect(saveButton()).toBeDisabled());
    expect(nameField()).toHaveValue('Nima');
    expect(screen.getByText(enText('aiAgent.persona.save.clean'))).toBeInTheDocument();
  });

  it('a failed save keeps every edit, shows why in the save bar and gives no success toast', async () => {
    store.fail = apiError('update_failed', 500);
    await renderPage();
    fireEvent.change(nameField(), { target: { value: 'Nima' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Formal' }));
    await save();

    const message = enText('aiAgent.persona.errors.generic');
    await waitFor(() => expect(document.querySelector('[data-persona-savebar] [role="alert"]')?.textContent).toContain(message));
    expect(toast.error).toHaveBeenCalledWith(message);
    expect(toast.success).not.toHaveBeenCalled();
    expect(nameField()).toHaveValue('Nima');
    expect(screen.getByRole('radio', { name: 'Formal' })).toHaveAttribute('data-state', 'checked');
    expect(saveButton()).toBeEnabled();

    // Discard clears the edits and the message.
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(nameField()).toHaveValue('Sara');
    expect(document.querySelector('[data-persona-savebar] [role="alert"]')).toBeNull();
  });

  it('the picture saves at once through its own endpoint, says so, and leaves the other edits for Save', async () => {
    await renderPage();
    expect(screen.getByText(enText('aiAgent.persona.identity.avatarInstant'))).toBeInTheDocument();
    fireEvent.change(nameField(), { target: { value: 'Nima' } });

    const input = document.querySelector('[data-persona-avatar-input]') as HTMLInputElement;
    const file = new File(['png'], 'face.png', { type: 'image/png' });
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    await waitFor(() => expect(api.uploadAvatar).toHaveBeenCalledWith('ws-1', file));
    await waitFor(() => expect(preview().querySelector('img')).toHaveAttribute('src', 'https://example.com/a.png'));

    expect(store.patches).toEqual([]);
    expect(nameField()).toHaveValue('Nima');
    const patch = await save();
    expect(patch).toEqual({ agent_name: 'Nima' });
    expect(patch).not.toHaveProperty('agent_logo_url');
  });

  it('a picture that is not an image is refused before any upload', async () => {
    await renderPage();
    const input = document.querySelector('[data-persona-avatar-input]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'notes.pdf', { type: 'application/pdf' })] } });
    expect(toast.error).toHaveBeenCalledWith(enText('aiAgent.settings.uploadOnlyImages'));
    expect(api.uploadAvatar).not.toHaveBeenCalled();
  });
});

describe('the preview', () => {
  it('shows the name and the welcome message as typed, before saving', async () => {
    await renderPage();
    expect(preview().querySelector('[data-preview-name]')).toHaveTextContent('Sara');
    expect(preview().querySelector('[data-preview-welcome]')).toHaveTextContent('Hello from Sara');

    fireEvent.change(nameField(), { target: { value: 'Nima' } });
    fireEvent.change(screen.getByLabelText('Welcome message'), { target: { value: 'Welcome to the shop!' } });
    expect(preview().querySelector('[data-preview-name]')).toHaveTextContent('Nima');
    expect(preview().querySelector('[data-preview-welcome]')).toHaveTextContent('Welcome to the shop!');
    expect(store.patches).toEqual([]);
  });

  it('an empty welcome message previews the built-in greeting; a switched-off one previews none', async () => {
    resetStore(baseSettings({ intro_message_localized: {} }));
    await renderPage();
    expect(preview().querySelector('[data-preview-welcome]')).toHaveTextContent("Hi! I'm Sara, an AI assistant.");
    fireEvent.click(screen.getByRole('switch', { name: enText('aiAgent.persona.identity.welcomeSwitch') }));
    expect(preview().querySelector('[data-preview-welcome]')).toBeNull();
    expect(preview()).toHaveTextContent(enText('aiAgent.persona.preview.welcomeOff'));
  });

  it('one sample exchange, marked as a sample, follows the tone and the length', async () => {
    await renderPage();
    const sample = () => preview().querySelector('[data-preview-sample]') as HTMLElement;
    expect(preview()).toHaveTextContent(enText('aiAgent.persona.preview.sample'));
    expect(preview()).toHaveTextContent(enText('aiAgent.persona.preview.sampleNote'));
    expect(sample()).toHaveTextContent(enText('aiAgent.persona.preview.sampleQuestion'));
    expect(sample()).toHaveTextContent(`${enText('aiAgent.persona.preview.openerFriendly')} ${enText('aiAgent.persona.preview.bodyMedium')}`);

    fireEvent.click(screen.getByRole('radio', { name: 'Formal' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Detailed' }));
    expect(sample()).toHaveTextContent(`${enText('aiAgent.persona.preview.openerFormal')} ${enText('aiAgent.persona.preview.bodyLong')}`);
  });

  it('the real test is the existing one, labelled as using the saved settings', async () => {
    await renderPage();
    expect(screen.getByText(enText('aiAgent.persona.preview.realTestHint'))).toBeInTheDocument();
    fireEvent.change(nameField(), { target: { value: 'Unsaved name' } });
    fireEvent.change(screen.getByPlaceholderText(enText('aiAgent.test.messagePlaceholder')), { target: { value: 'Do you ship to Tabriz?' } });
    fireEvent.click(screen.getByRole('button', { name: enText('aiAgent.test.run') }));
    await waitFor(() => expect(api.testAi).toHaveBeenCalledWith({ workspaceId: 'ws-1', message: 'Do you ship to Tabriz?', pageContext: null }));
    expect(await screen.findByText('We ship in two days.')).toBeInTheDocument();
    // Testing saves nothing.
    expect(store.patches).toEqual([]);
  });
});
