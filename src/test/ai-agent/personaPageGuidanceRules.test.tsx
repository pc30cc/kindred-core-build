/**
 * «Personality & behavior» (BehaviorPage) → the answer rules
 * (persona/GuidanceRulesList.tsx, the list the Guidance page had).
 *
 * "Add default rules" saves five starter rules whose title and text become
 * the rules themselves (and go into the AI's prompt). They are written in the
 * dashboard's language at that moment: in English they stay byte for byte
 * what they always were, and a Persian dashboard gets Persian rules its owner
 * can read and edit. The rule types sent never change. Rules save through
 * their own calls, at once, never through the page's Save.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import { ENGLISH_DEFAULT_RULES, resetStore, store } from './helpers/personaPage';

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
const api = vi.hoisted(() => ({
  listGuidance: vi.fn(async () => ({ items: [] as unknown[] })),
  createGuidance: vi.fn<(input: Record<string, unknown>) => Promise<{ item: object }>>(async () => ({ item: {} })),
  updateGuidance: vi.fn(async () => ({ item: {} })),
  deleteGuidance: vi.fn(async () => ({ ok: true })),
  generateBusinessDescription: vi.fn(),
  uploadAvatar: vi.fn(),
  removeAvatar: vi.fn(),
  testAi: vi.fn(),
}));
vi.mock('@/lib/ai-agent-api', () => ({ aiAgentApi: api }));

const BehaviorPage = (await import('@/pages/app/ai-agent/BehaviorPage')).default;
const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

function renderIn(locale: 'en' | 'fa') {
  const messages = locale === 'fa' ? fa : en;
  render(
    <I18nProvider initialLocale={locale} initialTranslations={messages}>
      <MemoryRouter future={ROUTER_FUTURE}><BehaviorPage /></MemoryRouter>
    </I18nProvider>,
  );
  return messages;
}

async function seedDefaults(locale: 'en' | 'fa') {
  const messages = renderIn(locale);
  fireEvent.click(await screen.findByRole('button', { name: messages.aiAgent.guidance.addDefaults }));
  await waitFor(() => expect(api.createGuidance).toHaveBeenCalledTimes(5));
  return api.createGuidance.mock.calls.map(([input]) => input);
}

beforeEach(() => {
  resetStore();
  api.listGuidance.mockClear();
  api.createGuidance.mockClear();
});
afterEach(() => {
  cleanup();
});

describe('default rules follow the dashboard language', () => {
  it('in English they are the same five rules as before, byte for byte', async () => {
    expect(await seedDefaults('en')).toEqual(ENGLISH_DEFAULT_RULES);
  });

  it('in Persian they are written in Persian, with the same rule types', async () => {
    const rules = await seedDefaults('fa');
    expect(rules.map((r) => r.rule_type)).toEqual(ENGLISH_DEFAULT_RULES.map((r) => r.rule_type));
    expect(rules[0].title).toBe(fa.aiAgent.guidance.defaults.human.title);
    for (const rule of rules) {
      for (const text of [rule.title, rule.description, rule.instruction]) {
        expect(text).toMatch(/[؀-ۿ]/);
        expect(text).not.toMatch(/[A-Za-z]/);
      }
    }
  });
});

describe('rules save on their own', () => {
  it('adding the default rules sends no settings write and leaves the page clean; the list reloads', async () => {
    const messages = renderIn('en');
    expect(screen.getByText(messages.aiAgent.persona.style.rulesInstant)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: messages.aiAgent.guidance.addDefaults }));
    await waitFor(() => expect(api.createGuidance).toHaveBeenCalledTimes(5));
    await waitFor(() => expect(api.listGuidance).toHaveBeenCalledTimes(2));
    expect(store.patches).toEqual([]);
    expect(screen.getByRole('button', { name: messages.aiAgent.persona.save.save })).toBeDisabled();
  });

  it('the Persian page reads right to left', async () => {
    renderIn('fa');
    await screen.findByRole('button', { name: fa.aiAgent.guidance.addDefaults });
    expect(document.querySelector('[data-page="ai-persona"]')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('heading', { name: fa.aiAgent.persona.title })).toBeInTheDocument();
  });
});
