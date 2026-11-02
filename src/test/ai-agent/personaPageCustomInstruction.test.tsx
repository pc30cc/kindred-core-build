/**
 * «Personality & behavior» (BehaviorPage) → Advanced → Identity and
 * personality → the custom instruction (instructions.custom_system_instruction).
 *
 * The server never returns the saved text, only `has_custom_system_instruction`
 * (server/services/ai-agent/customerSafe.ts), and keeps the stored text when a
 * write leaves the key out. So the page sends the key only when the owner
 * typed a new one, or '' when they Remove it (after asking, at once); an
 * emptied field keeps the saved one. Without a saved one the field shows the
 * legacy `custom_instructions` text the prompt falls back to, exactly as the
 * Instructions page did, and that legacy key is never written.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  baseSettings, enText, resetStore, store, type Patch,
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

const SAVED_NOTE = enText('aiAgent.instructions.advanced.savedNote');
const REMOVE = enText('aiAgent.persona.advanced.removeCustom');

/** What GET /api/ai-agent/settings sends: never the custom instruction's text. */
function serverSettings(hasCustom: boolean, instructions: Record<string, unknown> = {}) {
  return baseSettings({
    has_custom_system_instruction: hasCustom,
    instructions: { tone: 'formal', max_answer_length: 'short', brand_voice: 'Playful but precise.', ...instructions },
  });
}

async function renderPage() {
  render(<MemoryRouter future={ROUTER_FUTURE}><BehaviorPage /></MemoryRouter>);
  await screen.findByRole('button', { name: enText('aiAgent.guidance.addDefaults') });
  const item = document.querySelector('[data-persona-advanced="identity"]') as HTMLElement;
  fireEvent.click(within(item).getAllByRole('button')[0]);
}

const customField = () => document.getElementById('persona-custom-instruction') as HTMLTextAreaElement;
const brandVoice = () => document.getElementById('persona-brand-voice') as HTMLTextAreaElement;
const saveButton = () => screen.getByRole('button', { name: 'Save changes' });

async function save(): Promise<Patch> {
  const before = store.patches.length;
  fireEvent.click(saveButton());
  await waitFor(() => expect(store.patches.length).toBe(before + 1));
  return store.patches[before];
}

let confirmSpy: MockInstance<(message?: string) => boolean>;
beforeEach(() => {
  resetStore();
  toast.success.mockClear();
  toast.error.mockClear();
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  confirmSpy.mockRestore();
  cleanup();
});

describe('C1 — a saved custom instruction is announced, never shown', () => {
  it('the field starts empty (not the legacy text) under a note with a Remove button', async () => {
    resetStore(serverSettings(true, { custom_instructions: 'Legacy free text' }));
    await renderPage();
    expect(customField().value).toBe('');
    expect(screen.getByText(SAVED_NOTE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: REMOVE })).toBeInTheDocument();
  });

  it('without one saved there is no note and no Remove; the field shows the legacy text the prompt falls back to', async () => {
    resetStore(serverSettings(false, { custom_instructions: 'Legacy free text' }));
    await renderPage();
    expect(customField().value).toBe('Legacy free text');
    expect(screen.queryByText(SAVED_NOTE)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: REMOVE })).not.toBeInTheDocument();
  });
});

describe('C2 — the key is sent only when the owner typed a new instruction', () => {
  it('saving another field sends no custom_system_instruction (the saved one stays), and no other instruction key', async () => {
    resetStore(serverSettings(true));
    await renderPage();
    fireEvent.change(brandVoice(), { target: { value: 'Bold and confident.' } });
    expect(await save()).toEqual({ instructions: { brand_voice: 'Bold and confident.' } });
  });

  it('typed text replaces the saved one (trimmed), alone in instructions', async () => {
    resetStore(serverSettings(true));
    await renderPage();
    fireEvent.change(customField(), { target: { value: '  New closing line: stay curious.  ' } });
    expect(await save()).toEqual({ instructions: { custom_system_instruction: 'New closing line: stay curious.' } });
    // The server now has one: the field is empty again, under the note.
    await waitFor(() => expect(screen.getByText(SAVED_NOTE)).toBeInTheDocument());
    expect(customField().value).toBe('');
  });

  it('typing and then emptying the field sends nothing at all: "leave empty to keep it"', async () => {
    resetStore(serverSettings(true));
    await renderPage();
    fireEvent.change(customField(), { target: { value: 'second thoughts' } });
    fireEvent.change(customField(), { target: { value: '   ' } });
    expect(saveButton()).toBeDisabled();
  });

  it('an edited legacy text is saved as the custom instruction; the legacy key itself is never written', async () => {
    resetStore(serverSettings(false, { custom_instructions: 'Legacy free text' }));
    await renderPage();
    fireEvent.change(customField(), { target: { value: 'Legacy free text, sharpened.' } });
    const patch = await save();
    expect(patch).toEqual({ instructions: { custom_system_instruction: 'Legacy free text, sharpened.' } });
    expect(patch.instructions).not.toHaveProperty('custom_instructions');
    // Saved, and the server retired the legacy text: the field is empty under the note.
    await waitFor(() => expect(screen.getByText(SAVED_NOTE)).toBeInTheDocument());
    expect(customField().value).toBe('');
  });
});

describe('C3 — Remove clears it, after asking, at once', () => {
  it("sends exactly { instructions: { custom_system_instruction: '' } }, and no old text comes back", async () => {
    resetStore(serverSettings(true, { custom_instructions: 'Legacy free text' }));
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: REMOVE }));
    await waitFor(() => expect(store.patches).toHaveLength(1));

    expect(confirmSpy).toHaveBeenCalledWith(enText('aiAgent.persona.advanced.removeConfirm'));
    expect(store.patches[0]).toEqual({ instructions: { custom_system_instruction: '' } });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(enText('aiAgent.instructions.advanced.removed')));
    // Gone on the server, legacy text included (settings.ts retires it): no note, an empty field.
    await waitFor(() => expect(screen.queryByText(SAVED_NOTE)).not.toBeInTheDocument());
    expect(customField().value).toBe('');
  });

  it('cancelling the question sends nothing', async () => {
    confirmSpy.mockReturnValue(false);
    resetStore(serverSettings(true));
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: REMOVE }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(store.patches).toEqual([]);
  });

  it('leaves the other unsaved edits on the page for the next Save', async () => {
    resetStore(serverSettings(true));
    await renderPage();
    fireEvent.change(brandVoice(), { target: { value: 'Bold and confident.' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nima' } });
    fireEvent.click(screen.getByRole('button', { name: REMOVE }));
    await waitFor(() => expect(store.patches).toHaveLength(1));
    // Remove writes only its own key...
    expect(store.patches[0]).toEqual({ instructions: { custom_system_instruction: '' } });

    // ...and the other edits are still there to save.
    expect(brandVoice().value).toBe('Bold and confident.');
    expect(await save()).toEqual({ agent_name: 'Nima', instructions: { brand_voice: 'Bold and confident.' } });
  });
});
