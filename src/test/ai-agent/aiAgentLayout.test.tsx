/**
 * AiAgentLayout renders the AI section's menu (aiAgentMenu.ts): the sections
 * a member may see, the open section's pages as tabs, and the agent's
 * on / suggestions-only / off chip. Mounted with the real router and the
 * English catalogue; the data hooks are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const state = vi.hoisted(() => ({
  caps: {} as Record<string, unknown>,
  settings: null as null | { enabled: boolean; mode: string },
  isAdmin: false,
}));

vi.mock('@/hooks/useWorkspace', () => ({
  useWorkspacePath: () => (p: string) => `/shop${p}`,
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1' } }),
}));
vi.mock('@/hooks/useAiAgentCapabilities', () => ({
  useAiAgentCapabilities: () => ({ data: state.caps, isLoading: false, isError: false }),
}));
vi.mock('@/hooks/useAiAgent', () => ({
  useAiAgentSettings: () => ({ data: state.settings ? { settings: state.settings } : undefined }),
}));
vi.mock('@/hooks/useAdmin', () => ({
  useIsGlobalAdmin: () => ({ data: state.isAdmin }),
}));
vi.mock('@/components/plan/PlanAccessGate', () => ({
  PlanAccessGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/i18n', async () => {
  const en = (await import('@/i18n/locales/en')).default as unknown as Record<string, unknown>;
  const get = (k: string) => k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], en);
  return {
    useTranslation: () => ({
      t: (k: string) => {
        const v = get(k);
        return typeof v === 'string' ? v : k;
      },
      dir: 'ltr',
      locale: 'en',
    }),
  };
});

import { AiAgentLayout } from '@/components/layout/AiAgentLayout';

const ALL_ON = { overview: true, knowledge: true, behavior: true, operatorAssist: true, activity: true, settings: true };

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/shop/ai-agent" element={<AiAgentLayout />}>
          <Route path="*" element={<div data-testid="page">page</div>} />
        </Route>
        <Route path="/shop/inbox" element={<div data-testid="inbox">inbox</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const sectionIds = () =>
  Array.from(document.querySelectorAll('[data-ai-section]')).map((el) => el.getAttribute('data-ai-section'));
const tabPaths = () =>
  Array.from(document.querySelectorAll('[data-ai-tab]')).map((el) => el.getAttribute('data-ai-tab'));

beforeEach(() => {
  cleanup();
  state.caps = {
    ai_agent_enabled: true,
    customer_ai_agent_visible: true,
    customer_nav: { ...ALL_ON },
    max_customer_visible_nav_items: 6,
  };
  state.settings = { enabled: true, mode: 'auto_reply_until_human_joins' };
  state.isAdmin = false;
});

describe('AiAgentLayout', () => {
  it('shows the six customer sections and no advanced one to an owner', () => {
    renderAt('/shop/ai-agent/overview');
    expect(sectionIds()).toEqual(['overview', 'knowledge', 'answers', 'automation', 'operatorAssist', 'activity']);
    expect(screen.getByTestId('page')).toBeTruthy();
  });

  it('marks the open page’s section and shows its pages as tabs', () => {
    renderAt('/shop/ai-agent/guidance');
    const active = document.querySelector('[data-ai-section][data-active="true"]');
    expect(active?.getAttribute('data-ai-section')).toBe('answers');
    expect(tabPaths()).toEqual(['behavior', 'instructions', 'guidance', 'settings']);
    expect(document.querySelector('[data-ai-tab="guidance"]')?.getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('[data-ai-tab="behavior"]')?.getAttribute('aria-current')).toBeNull();
    expect(document.querySelector('[data-ai-tab="guidance"]')?.getAttribute('href')).toBe('/shop/ai-agent/guidance');
  });

  it('a section link opens its first page', () => {
    renderAt('/shop/ai-agent/overview');
    expect(document.querySelector('[data-ai-section="automation"]')?.getAttribute('href')).toBe('/shop/ai-agent/routing');
  });

  it("hides a tab the Super Admin switched off", () => {
    state.caps.customer_nav = { ...ALL_ON, settings: false };
    renderAt('/shop/ai-agent/behavior');
    expect(tabPaths()).toEqual(['behavior', 'instructions', 'guidance']);
  });

  it('keeps the open section’s tabs even when the cap leaves it out of the list', () => {
    state.caps.max_customer_visible_nav_items = 2;
    renderAt('/shop/ai-agent/activity');
    expect(sectionIds()).toEqual(['overview', 'knowledge']);
    expect(tabPaths()).toEqual(['activity', 'analytics']);
  });

  it('shows the advanced section to a platform admin, uncapped', () => {
    state.isAdmin = true;
    state.caps.max_customer_visible_nav_items = 2;
    renderAt('/shop/ai-agent/runs/abc');
    expect(sectionIds()).toContain('advanced');
    expect(sectionIds()).toContain('activity');
    const active = document.querySelector('[data-ai-section][data-active="true"]');
    expect(active?.getAttribute('data-ai-section')).toBe('advanced');
  });

  it.each([
    [{ enabled: true, mode: 'auto_reply_always' }, 'on', 'On, answering visitors'],
    [{ enabled: true, mode: 'suggest_only' }, 'suggest', 'Suggestions to operators only'],
    [{ enabled: true, mode: 'off' }, 'off', 'Off'],
    [{ enabled: false, mode: 'auto_reply_always' }, 'off', 'Off'],
  ])('the chip reads the agent’s state (%o)', (settings, key, text) => {
    state.settings = settings;
    renderAt('/shop/ai-agent/overview');
    const chip = document.querySelector('[data-ai-agent-state]');
    expect(chip?.getAttribute('data-ai-agent-state')).toBe(key);
    expect(chip?.textContent).toBe(text);
    expect(chip?.getAttribute('href')).toBe('/shop/ai-agent/activation');
  });

  it('still sends the member to the inbox when the platform switch is off', () => {
    state.caps.ai_agent_enabled = false;
    renderAt('/shop/ai-agent/overview');
    expect(screen.getByTestId('inbox')).toBeTruthy();
  });
});
