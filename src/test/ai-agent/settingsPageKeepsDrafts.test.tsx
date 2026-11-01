/**
 * SettingsPage mixes a "Save changes" button (name, description, answer
 * rules) with controls that save at once (the intro switch, the per-language
 * messages on blur, keywords). Every save writes the server's copy back into
 * the settings query (useUpdateAiAgentSettings → setQueryData), and the page
 * used to reset its whole form from it: an instant save silently dropped the
 * edits still waiting for "Save changes", and one language's message coming
 * back wiped what was being typed in another. The stub below behaves like
 * that cache: a save replaces the data the page reads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

const store = vi.hoisted(() => ({
  data: { settings: null as Record<string, unknown> | null },
  listeners: new Set<() => void>(),
  patches: [] as Record<string, unknown>[],
}));

vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', default_locale: 'en' }, notFound: false }),
}));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ mode: 'multi', allowedLocales: ['fa', 'en'], canSwitchLanguage: true, currency: 'USD' }),
}));
vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (k: string) => k, dir: 'ltr' }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/ai-agent-api', () => ({
  aiAgentApi: {
    generateBusinessDescription: vi.fn(async () => ({ description: 'generated', source: 'ai' })),
    uploadAvatar: vi.fn(async () => ({ avatar_url: 'https://example.com/a.png' })),
    removeAvatar: vi.fn(async () => ({})),
  },
}));
vi.mock('@/hooks/useAiAgent', async () => {
  const React = await import('react');
  const subscribe = (cb: () => void) => {
    store.listeners.add(cb);
    return () => { store.listeners.delete(cb); };
  };
  return {
    useAiAgentSettings: () => {
      const data = React.useSyncExternalStore(subscribe, () => store.data);
      return { data, isLoading: false };
    },
    useUpdateAiAgentSettings: () => ({
      isPending: false,
      mutateAsync: async (patch: Record<string, unknown>) => {
        store.patches.push(patch);
        // What setQueryData does: the page now reads the server's copy.
        store.data = { settings: { ...store.data.settings, ...patch } };
        store.listeners.forEach((l) => l());
        return store.data;
      },
    }),
  };
});

const SettingsPage = (await import('@/pages/app/ai-agent/SettingsPage')).default;

function baseSettings() {
  return {
    id: 's1',
    workspace_id: 'ws-1',
    enabled: true,
    mode: 'auto_reply_always',
    agent_name: 'AI Assistant',
    agent_logo_url: null,
    business_description: 'We sell widgets.',
    answer_guidance: 'balanced',
    answer_only_from_kb: false,
    strict_topic_scope: false,
    welcome_message: null,
    fallback_message: 'Not sure, let me get a human.',
    handoff_keywords: [],
    allowed_locales: ['fa', 'en'],
    show_sources_to_operator: true,
    ai_intro_enabled: true,
    intro_message_localized: { fa: 'سلام', en: 'Hello' },
    handoff_message_localized: {},
    handoff_prechat_message_localized: {},
  };
}

beforeEach(() => {
  cleanup();
  store.data = { settings: baseSettings() };
  store.patches = [];
});

describe('SettingsPage keeps what the owner is still editing', () => {
  it('an instant save (intro switch) keeps an unsaved name, and "Save changes" still sends it', async () => {
    render(<SettingsPage />);
    fireEvent.change(screen.getByDisplayValue('AI Assistant'), { target: { value: 'Sara' } });

    // The intro switch (in the intro card's header) saves at once.
    const introTitle = screen.getByText('aiAgent.settings.texts.introTitle');
    const intro = introTitle.closest('div')?.querySelector('[role="switch"]') as HTMLElement;
    expect(intro).toBeTruthy();
    await act(async () => { fireEvent.click(intro); });
    await waitFor(() => expect(store.patches).toContainEqual({ ai_intro_enabled: false }));

    // The typed name survived the server's copy coming back.
    expect(screen.getByDisplayValue('Sara')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(store.patches.some((p) => p.agent_name === 'Sara')).toBe(true));
  });

  it("one language's message saving does not wipe the other language being typed", async () => {
    render(<SettingsPage />);
    const fa = screen.getByDisplayValue('سلام');
    const en = screen.getByDisplayValue('Hello');

    fireEvent.change(fa, { target: { value: 'درود' } });
    fireEvent.change(en, { target: { value: 'Hi there' } });
    // Leaving the Persian field saves it; the English one is still being typed.
    await act(async () => { fireEvent.blur(fa); });
    await waitFor(() => expect(store.patches).toContainEqual({ intro_message_localized: { fa: 'درود', en: 'Hello' } }));

    expect(screen.getByDisplayValue('درود')).toBeTruthy();
    expect(screen.getByDisplayValue('Hi there')).toBeTruthy();
  });
});
