/**
 * InstructionsPage — "Advanced custom instruction" (instructions.custom_system_instruction).
 *
 * The server never returns the saved text, only `has_custom_system_instruction`
 * (server/services/ai-agent/customerSafe.ts), and keeps the stored text when a
 * write leaves the key out (settings.ts updateSettings). So the page must
 * send the key only when the owner typed a new one, or '' when they remove
 * it; an emptied field keeps the saved one. Same rendering conventions as
 * instructionsPageSaveSemantics.test.tsx (real English catalogue).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>();
  const en = (await import('@/i18n/locales/en')).default as Record<string, unknown>;
  const at = (path: string) =>
    path.split('.').reduce<unknown>(
      (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
      en,
    );
  return {
    ...actual,
    useTranslation: () => ({
      locale: 'en' as const,
      dir: 'ltr' as const,
      setLocale: () => {},
      isLoading: false,
      t: (key: string, params?: Record<string, string | number>) => {
        const raw = at(key);
        let value = typeof raw === 'string' ? raw : key;
        if (params) {
          for (const [k, v] of Object.entries(params)) value = value.replace(`{{${k}}}`, String(v));
        }
        return value;
      },
    }),
  };
});

vi.mock('@/hooks/useWorkspace', () => ({
  useCurrentWorkspace: () => ({ id: 'ws-1' }),
}));
const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ toast: (arg: unknown) => toast(arg) }));

type Instr = Record<string, unknown>;
type Patch = Record<string, unknown> & { instructions?: Instr };
const dataHolder: { data: { settings: Record<string, unknown> | null } } = { data: { settings: null } };
const mutateAsync = vi.fn(async (patch: Patch) => ({ settings: { ...dataHolder.data.settings, ...patch } }));

vi.mock('@/hooks/useAiAgent', () => ({
  useAiAgentSettings: () => ({ data: dataHolder.data, isLoading: false }),
  useUpdateAiAgentSettings: () => ({ mutateAsync, isPending: false }),
}));

const InstructionsPage = (await import('@/pages/app/ai-agent/InstructionsPage')).default;

const SAVED_NOTE = 'A custom instruction is saved. Type here to replace it; leave empty to keep it.';

/** What GET /api/ai-agent/settings sends: never the custom instruction's text. */
function serverSettings(hasCustom: boolean, instructions: Instr = {}) {
  return {
    id: 's1',
    workspace_id: 'ws-1',
    business_description: 'We sell widgets.',
    has_custom_system_instruction: hasCustom,
    instructions: {
      tone: 'formal',
      max_answer_length: 'short',
      brand_voice: 'Playful but precise.',
      ...instructions,
    },
  };
}

function customField() {
  return screen.getByPlaceholderText(/free-form additional system instruction/i) as HTMLTextAreaElement;
}

async function clickSave(): Promise<Patch> {
  fireEvent.click(screen.getByRole('button', { name: /save instructions/i }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  return mutateAsync.mock.calls[0][0];
}

let confirmSpy: MockInstance<(message?: string) => boolean>;
beforeEach(() => {
  mutateAsync.mockClear();
  toast.mockClear();
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  confirmSpy.mockRestore();
});

describe('C1 — a saved custom instruction is announced, never shown', () => {
  it('the field starts empty (not the legacy text) under a note with a Remove button', () => {
    dataHolder.data = { settings: serverSettings(true, { custom_instructions: 'Legacy free text' }) };
    render(<InstructionsPage />);

    expect(customField().value).toBe('');
    expect(screen.getByText(SAVED_NOTE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('without one saved there is no note and no Remove; the field shows the legacy text the prompt falls back to', () => {
    dataHolder.data = { settings: serverSettings(false, { custom_instructions: 'Legacy free text' }) };
    render(<InstructionsPage />);

    expect(customField().value).toBe('Legacy free text');
    expect(screen.queryByText(SAVED_NOTE)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });
});

describe('C2 — the key is sent only when the owner typed a new instruction', () => {
  it('saving another field sends no custom_system_instruction (the saved one stays)', async () => {
    dataHolder.data = { settings: serverSettings(true) };
    render(<InstructionsPage />);

    fireEvent.change(screen.getByPlaceholderText(/how should the assistant sound/i), { target: { value: 'Bold and confident.' } });
    const patch = await clickSave();

    expect(patch.instructions?.brand_voice).toBe('Bold and confident.');
    expect(patch.instructions).not.toHaveProperty('custom_system_instruction');
    // The keys this page does not own travel through untouched.
    expect(patch.instructions?.tone).toBe('formal');
    expect(patch.instructions?.max_answer_length).toBe('short');
  });

  it('typed text replaces the saved one (trimmed)', async () => {
    dataHolder.data = { settings: serverSettings(true) };
    render(<InstructionsPage />);

    fireEvent.change(customField(), { target: { value: '  New closing line: stay curious.  ' } });
    const patch = await clickSave();

    expect(patch.instructions?.custom_system_instruction).toBe('New closing line: stay curious.');
    expect(patch.instructions?.tone).toBe('formal');
  });

  it('typing and then emptying the field sends no key at all: "leave empty to keep it"', async () => {
    dataHolder.data = { settings: serverSettings(true) };
    render(<InstructionsPage />);

    fireEvent.change(customField(), { target: { value: 'second thoughts' } });
    fireEvent.change(customField(), { target: { value: '   ' } });
    const patch = await clickSave();

    expect(patch.instructions).not.toHaveProperty('custom_system_instruction');
    expect(patch.instructions?.brand_voice).toBe('Playful but precise.');
  });
});

describe('C3 — Remove clears it, after asking', () => {
  it("sends instructions with custom_system_instruction '' and the other keys unchanged, nothing else", async () => {
    dataHolder.data = { settings: serverSettings(true) };
    render(<InstructionsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const patch = mutateAsync.mock.calls[0][0];

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(Object.keys(patch)).toEqual(['instructions']);
    expect(patch.instructions).toEqual({
      tone: 'formal',
      max_answer_length: 'short',
      brand_voice: 'Playful but precise.',
      custom_system_instruction: '',
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'Custom instruction removed' }));
  });

  it('cancelling the question sends nothing', () => {
    confirmSpy.mockReturnValue(false);
    dataHolder.data = { settings: serverSettings(true) };
    render(<InstructionsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('leaves the other unsaved edits on the page for the next Save', async () => {
    dataHolder.data = { settings: serverSettings(true) };
    render(<InstructionsPage />);

    fireEvent.change(screen.getByPlaceholderText(/how should the assistant sound/i), { target: { value: 'Bold and confident.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    // Remove writes only its own key...
    expect(mutateAsync.mock.calls[0][0].instructions?.brand_voice).toBe('Playful but precise.');

    // ...and the brand voice edit is still there to save.
    fireEvent.click(screen.getByRole('button', { name: /save instructions/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(mutateAsync.mock.calls[1][0].instructions?.brand_voice).toBe('Bold and confident.');
  });
});
