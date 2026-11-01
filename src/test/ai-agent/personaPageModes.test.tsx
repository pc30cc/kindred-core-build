/**
 * «Personality & behavior» (BehaviorPage) — the reply mode, and turning the
 * assistant on.
 *
 * The page offers all five modes the server stores, by their exact values:
 * Off writes `{ enabled: false, mode: 'off' }`, any other `{ enabled: true,
 * mode }`, and only when the owner picked one. A switched-off assistant reads
 * as Off whatever mode it keeps. What turning it on still needs (the
 * readiness checklist) shows under the modes while it is off or not ready,
 * and the server's refusals to turn it on are said in plain words, with every
 * edit kept for the next try.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  apiError, baseDiagnostics, baseSettings, enText, resetStore, store, type Patch,
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

/** The five modes, as the page names them, with the values the server stores. */
const MODES = [
  { value: 'off', name: enText('aiAgent.persona.behavior.modeOff') },
  { value: 'suggest_only', name: enText('aiAgent.persona.behavior.modeSuggest') },
  { value: 'auto_reply_until_human_joins', name: enText('aiAgent.persona.behavior.modeUntilHuman') },
  { value: 'auto_reply_when_offline', name: enText('aiAgent.persona.behavior.modeOffline') },
  { value: 'auto_reply_always', name: enText('aiAgent.persona.behavior.modeAlways') },
] as const;

const modeRadio = (name: string) => screen.getByRole('radio', { name });
const checked = () => MODES.filter((m) => modeRadio(m.name).getAttribute('data-state') === 'checked').map((m) => m.value);

beforeEach(() => {
  resetStore();
  toast.success.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  cleanup();
});

describe('all five modes', () => {
  it('render, with the stored one checked', async () => {
    resetStore(baseSettings({ mode: 'auto_reply_when_offline' }));
    await renderPage();
    for (const m of MODES) expect(modeRadio(m.name)).toBeInTheDocument();
    expect(checked()).toEqual(['auto_reply_when_offline']);
  });

  // Every mode as a target: Off from an answering mode, each answering mode
  // from Off and from another answering mode.
  const TRANSITIONS = MODES.flatMap((to) => (to.value === 'off'
    ? [{ from: 'auto_reply_always', to }]
    : [{ from: 'off', to }, { from: to.value === 'suggest_only' ? 'auto_reply_always' : 'suggest_only', to }]));

  for (const { from, to } of TRANSITIONS) {
    it(`${from} → ${to.value}: saves the exact pair and shows it after a reload`, async () => {
      resetStore(baseSettings(from === 'off' ? { enabled: false, mode: 'off' } : { enabled: true, mode: from }));
      const view = await renderPage();
      fireEvent.click(modeRadio(to.name));
      expect(checked()).toEqual([to.value]);

      expect(await save()).toEqual(to.value === 'off'
        ? { enabled: false, mode: 'off' }
        : { enabled: true, mode: to.value });

      // A fresh page reads the server's copy.
      view.unmount();
      await renderPage();
      expect(checked()).toEqual([to.value]);
      expect(saveButton()).toBeDisabled();
    });
  }

  it('enabled=false shows Off whatever the stored mode, and turning it on again writes enabled true', async () => {
    resetStore(baseSettings({ enabled: false, mode: 'auto_reply_always' }));
    await renderPage();
    expect(checked()).toEqual(['off']);
    fireEvent.click(modeRadio(enText('aiAgent.persona.behavior.modeAlways')));
    expect(await save()).toEqual({ enabled: true, mode: 'auto_reply_always' });
  });

  it("enabled but mode 'off' shows Off too, and picking Off again sends nothing", async () => {
    resetStore(baseSettings({ enabled: true, mode: 'off' }));
    await renderPage();
    expect(checked()).toEqual(['off']);
    fireEvent.click(modeRadio(enText('aiAgent.persona.behavior.modeOff')));
    expect(saveButton()).toBeDisabled();
  });

  it('the header says what is saved, not what is picked', async () => {
    resetStore(baseSettings({ enabled: true, mode: 'suggest_only' }));
    await renderPage();
    const chip = document.querySelector('[data-page-hero] [data-ai-agent-state]');
    expect(chip).toHaveAttribute('data-ai-agent-state', 'suggest');
    fireEvent.click(modeRadio(enText('aiAgent.persona.behavior.modeOff')));
    expect(chip).toHaveAttribute('data-ai-agent-state', 'suggest');
    await save();
    expect(document.querySelector('[data-page-hero] [data-ai-agent-state]')).toHaveAttribute('data-ai-agent-state', 'off');
  });
});

describe('readiness checklist', () => {
  it('shows under the modes while the assistant is off, all ticked when ready', async () => {
    resetStore(baseSettings({ enabled: false, mode: 'off' }));
    await renderPage();
    const box = document.querySelector('[data-persona-readiness]') as HTMLElement;
    expect(box).not.toBeNull();
    expect([...box.querySelectorAll('[data-readiness]')].map((r) => r.getAttribute('data-readiness'))).toEqual(['ok', 'ok', 'ok']);
    expect(screen.queryByText(enText('aiAgent.persona.behavior.notReady'))).not.toBeInTheDocument();
  });

  it('is hidden while the assistant is on and ready', async () => {
    await renderPage();
    expect(document.querySelector('[data-persona-readiness]')).toBeNull();
  });

  it('warns as soon as a mode is picked that cannot be turned on yet, naming the missing steps', async () => {
    resetStore(baseSettings({ enabled: false, mode: 'off', answer_only_from_kb: true }));
    store.diag = baseDiagnostics({
      ready: false,
      checks: { ai_provider_configured: false, has_knowledge: false, module_enabled: true, settings_enabled: false, mode: 'off' },
    });
    await renderPage();
    fireEvent.click(modeRadio(enText('aiAgent.persona.behavior.modeAlways')));
    expect(screen.getByText(enText('aiAgent.persona.behavior.notReady'))).toBeInTheDocument();
    const rows = [...document.querySelectorAll('[data-persona-readiness] [data-readiness]')].map((r) => r.getAttribute('data-readiness'));
    expect(rows).toEqual(['missing', 'missing', 'ok']);
    expect(screen.getByText(enText('aiAgent.persona.behavior.checkProviderHint'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: enText('aiAgent.persona.behavior.checkKnowledgeLink') })).toHaveAttribute('href', '/acme/knowledge-base');
  });

  it('knowledge is only a hint when the assistant may answer beyond it', async () => {
    resetStore(baseSettings({ enabled: false, mode: 'off', answer_only_from_kb: false }));
    store.diag = baseDiagnostics({
      checks: { ai_provider_configured: true, has_knowledge: false, module_enabled: true, settings_enabled: false, mode: 'off' },
    });
    await renderPage();
    const rows = [...document.querySelectorAll('[data-persona-readiness] [data-readiness]')].map((r) => r.getAttribute('data-readiness'));
    expect(rows).toEqual(['ok', 'optional', 'ok']);
    fireEvent.click(modeRadio(enText('aiAgent.persona.behavior.modeAlways')));
    expect(document.querySelector('[data-persona-readiness]')).toBeNull();
  });
});

describe('turning the assistant on: the server says no', () => {
  const REFUSALS = [
    ['ai_provider_not_configured', 'aiAgent.persona.errors.providerMissing'],
    ['no_published_knowledge', 'aiAgent.persona.errors.noKnowledge'],
    ['module_ai_assistant_not_enabled', 'aiAgent.persona.errors.moduleOff'],
  ] as const;

  for (const [code, key] of REFUSALS) {
    it(`${code}: shown in plain words, no success toast, and every edit kept`, async () => {
      resetStore(baseSettings({ enabled: false, mode: 'off' }));
      store.fail = apiError(code);
      await renderPage();
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nima' } });
      fireEvent.click(modeRadio(enText('aiAgent.persona.behavior.modeAlways')));
      await save();

      const message = enText(key);
      await waitFor(() => expect(document.querySelector('[data-persona-savebar] [role="alert"]')?.textContent).toContain(message));
      expect(toast.error).toHaveBeenCalledWith(message);
      expect(toast.success).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Name')).toHaveValue('Nima');
      expect(checked()).toEqual(['auto_reply_always']);

      // Still there to save: the next try sends the same edits.
      expect(saveButton()).toBeEnabled();
      expect(await save()).toEqual({ agent_name: 'Nima', enabled: true, mode: 'auto_reply_always' });
      expect(toast.success).toHaveBeenCalledWith(enText('aiAgent.persona.save.saved'));
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    });
  }

  it('any other failure is said plainly too, and the edits stay', async () => {
    store.fail = new Error('network_error');
    await renderPage();
    fireEvent.click(screen.getByRole('radio', { name: 'Short' }));
    await save();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(enText('aiAgent.persona.errors.network')));
    expect(screen.getByRole('radio', { name: 'Short' })).toHaveAttribute('data-state', 'checked');
    expect(saveButton()).toBeEnabled();
  });

  it('a success toast comes only once the request succeeded', async () => {
    store.hold = true;
    await renderPage();
    fireEvent.click(screen.getByRole('radio', { name: 'Short' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(store.patches).toHaveLength(1));
    expect(toast.success).not.toHaveBeenCalled();
    const { release } = await import('./helpers/personaPage');
    release();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(enText('aiAgent.persona.save.saved')));
  });
});

describe('operators online, for "only when no operator is online"', () => {
  it('says how many are online and whether the assistant answers now', async () => {
    store.diag = baseDiagnostics({ operator_availability: { state: 'offline', online_count: 0, total_count: 3 } });
    await renderPage();
    expect(screen.queryByText(enText('aiAgent.persona.behavior.answersNow'))).not.toBeInTheDocument();
    fireEvent.click(modeRadio(enText('aiAgent.persona.behavior.modeOffline')));
    expect(screen.getByText(enText('aiAgent.persona.behavior.operatorsNow', { online: '0', total: '3' }))).toBeInTheDocument();
    expect(screen.getByText(enText('aiAgent.persona.behavior.answersNow'))).toBeInTheDocument();
  });
});
