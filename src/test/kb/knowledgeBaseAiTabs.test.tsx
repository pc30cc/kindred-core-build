/**
 * The Knowledge Base's assistant tabs (owner, 2026-11-01): the AI section's
 * knowledge pages (the site's pages the assistant crawls, learning from
 * operators, the assistant's knowledge status) are tabs of the Knowledge
 * Base now, the one place knowledge is managed. They show by the AI
 * section's own rule, the one the main menu offers the AI entry by
 * (sectionVisible('aiAgent'): owner or admin, the plan's `ai_assistant`
 * module, the platform's AI switched on and shown to customers); the status
 * tab also by the Super Admin's customer_nav.knowledge. A `?tab=` link opens
 * one. Articles, Q&A and Files never depend on any of it.
 *
 * KnowledgeBasePage runs with the real router, the real useWorkspaceSections,
 * useKnowledgeAiTabs and planAccess rules and the English catalogue; only
 * the plan, role and AI capability answers are stubbed, and the tabs'
 * bodies (their embedded mode: knowledgeAiTabsEmbedded.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const h = vi.hoisted(() => ({
  role: 'owner' as string | null,
  roleFailed: false,
  /** The plan snapshot; null while it loads. */
  plan: null as Record<string, unknown> | null,
  caps: undefined as Record<string, unknown> | undefined,
  refetchArticles: vi.fn(),
}));

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
      t: (key: string, params?: Record<string, string | number>) => {
        const raw = at(key);
        let value = typeof raw === 'string' ? raw : key;
        if (params) for (const [k, v] of Object.entries(params)) value = value.replace(`{{${k}}}`, String(v));
        return value;
      },
    }),
  };
});

vi.mock('@/hooks/useWorkspace', () => ({
  useCurrentWorkspace: () => ({ id: 'ws-1', slug: 'acme' }),
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', slug: 'acme' } }),
  useWorkspacePath: () => (p: string) => `/acme${p}`,
}));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ allowedLocales: ['en'], canSwitchLanguage: false }),
}));
vi.mock('@/hooks/useKnowledgeBase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useKnowledgeBase')>()),
  useKBArticles: () => ({ data: [], isLoading: false, refetch: h.refetchArticles }),
  useDeleteKBArticle: () => ({ mutate: vi.fn() }),
}));

// What decides: the plan, the member's role, the platform's AI switches.
vi.mock('@/hooks/useEntitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useEntitlements')>();
  const { planAccessOf } = await import('@/lib/planAccess');
  return { ...actual, usePlanAccess: () => planAccessOf(h.plan as never, false) };
});
vi.mock('@/hooks/useWorkspaceRole', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useWorkspaceRole')>()),
  useWorkspaceRole: () => ({ data: h.role, isSuccess: !h.roleFailed, isError: h.roleFailed }),
}));
vi.mock('@/hooks/useAiAgentCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAiAgentCapabilities')>()),
  useAiAgentCapabilities: () => ({ data: h.caps, isError: false }),
}));
vi.mock('@/hooks/useCallCenter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useCallCenter')>()),
  useCallCenterCapabilities: () => ({ data: undefined, isError: false }),
}));

// The tabs' bodies: which one opens, and that it opens embedded.
vi.mock('@/components/app/knowledge/KnowledgeQnaTab', () => ({ default: () => <div data-testid="qna-body" /> }));
vi.mock('@/components/app/knowledge/KnowledgeFilesTab', () => ({ default: () => <div data-testid="files-body" /> }));
vi.mock('@/pages/app/ai-agent/WebPagesPage', () => ({
  default: ({ embedded }: { embedded?: boolean }) => <div data-testid="web-body" data-embedded={String(embedded === true)} />,
}));
vi.mock('@/pages/app/ai-agent/LearningCandidatesPage', () => ({
  default: ({ embedded }: { embedded?: boolean }) => <div data-testid="learning-body" data-embedded={String(embedded === true)} />,
}));
vi.mock('@/components/app/knowledge/KnowledgeStatusTab', () => ({ default: () => <div data-testid="status-body" /> }));

import KnowledgeBasePage from '@/pages/app/KnowledgeBasePage';

const PLAN_WITH_AI = { modules: { ai_assistant: { value: true } }, channels: {}, features: {}, limits: {} };
const PLAN_WITHOUT_AI = { modules: { ai_assistant: { value: false } }, channels: {}, features: {}, limits: {} };
const CUSTOMER_NAV = { overview: true, knowledge: true, behavior: true, operatorAssist: true, activity: true, settings: true };
const AI_ON = { ai_agent_enabled: true, customer_ai_agent_visible: true, auto_answer_enabled: true, customer_nav: CUSTOMER_NAV };

function Address() {
  const { pathname, search } = useLocation();
  return <output data-testid="address">{pathname + search}</output>;
}

function page(url: string) {
  return (
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/acme/knowledge-base" element={<><KnowledgeBasePage /><Address /></>} />
      </Routes>
    </MemoryRouter>
  );
}
const renderAt = (url = '/acme/knowledge-base') => render(page(url));

const tabIds = () => Array.from(document.querySelectorAll('[data-kb-tab]')).map((el) => el.getAttribute('data-kb-tab'));
const tab = (id: string) => document.querySelector(`[data-kb-tab="${id}"]`);
const openTab = (name: string) => fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false });

beforeEach(() => {
  cleanup();
  h.role = 'owner';
  h.roleFailed = false;
  h.plan = PLAN_WITH_AI;
  h.caps = { ...AI_ON, customer_nav: { ...CUSTOMER_NAV } };
  h.refetchArticles.mockReset();
});

describe('who sees the assistant tabs', () => {
  it('an owner of a workspace with the AI assistant: after Articles, Q&A and Files', () => {
    renderAt();
    expect(tabIds()).toEqual(['articles', 'qna', 'files', 'web', 'learning', 'status']);
    expect(tab('web')?.textContent).toContain('Website pages');
    expect(tab('learning')?.textContent).toContain('Learning from operators');
    expect(tab('status')?.textContent).toContain("Assistant's knowledge status");
  });

  it('an admin too', () => {
    h.role = 'admin';
    renderAt();
    expect(tabIds()).toEqual(['articles', 'qna', 'files', 'web', 'learning', 'status']);
  });

  it.each([['agent'], ['viewer'], [null]])('not a %s: Articles, Q&A and Files only', (role) => {
    h.role = role;
    renderAt();
    expect(tabIds()).toEqual(['articles', 'qna', 'files']);
  });

  it('not a member whose role cannot be read', () => {
    h.role = null;
    h.roleFailed = true;
    renderAt();
    expect(tabIds()).toEqual(['articles', 'qna', 'files']);
  });

  it('not in a workspace whose plan has no AI assistant', () => {
    h.plan = PLAN_WITHOUT_AI;
    renderAt();
    expect(tabIds()).toEqual(['articles', 'qna', 'files']);
  });

  it.each([
    ['switched off', { ai_agent_enabled: false }],
    ['hidden from customers', { customer_ai_agent_visible: false }],
  ])('not while the platform has the AI %s', (_label, change) => {
    h.caps = { ...AI_ON, ...change };
    renderAt();
    expect(tabIds()).toEqual(['articles', 'qna', 'files']);
  });

  it("the Super Admin's knowledge switch hides the status tab only", () => {
    h.caps = { ...AI_ON, customer_nav: { ...CUSTOMER_NAV, knowledge: false } };
    renderAt();
    expect(tabIds()).toEqual(['articles', 'qna', 'files', 'web', 'learning']);
  });

  it('the other customer_nav switches do not touch the Knowledge Base', () => {
    h.caps = {
      ...AI_ON,
      customer_nav: { overview: false, knowledge: true, behavior: false, operatorAssist: false, activity: false, settings: false },
    };
    renderAt();
    expect(tabIds()).toEqual(['articles', 'qna', 'files', 'web', 'learning', 'status']);
  });
});

describe('a ?tab= link opens its tab', () => {
  it.each([
    ['web', 'web-body', 'Website pages'],
    ['learning', 'learning-body', 'Learning from operators'],
    ['status', 'status-body', "Assistant's knowledge status"],
  ])('?tab=%s', async (id, body, name) => {
    renderAt(`/acme/knowledge-base?tab=${id}`);
    expect(await screen.findByTestId(body)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
    // The Articles tab's own tools (new article, the AI builder) are not on it.
    expect(document.querySelector('[data-hero-tools]')).toBeNull();
  });

  it('the web pages and learning pages open embedded', async () => {
    renderAt('/acme/knowledge-base?tab=web');
    expect(await screen.findByTestId('web-body')).toHaveAttribute('data-embedded', 'true');
    cleanup();
    renderAt('/acme/knowledge-base?tab=learning');
    expect(await screen.findByTestId('learning-body')).toHaveAttribute('data-embedded', 'true');
  });

  it('Q&A and Files open as before', () => {
    renderAt('/acme/knowledge-base?tab=qna');
    expect(screen.getByTestId('qna-body')).toBeInTheDocument();
    cleanup();
    renderAt('/acme/knowledge-base?tab=files');
    expect(screen.getByTestId('files-body')).toBeInTheDocument();
  });

  it('a member who may not see the tab gets Articles', () => {
    h.role = 'agent';
    renderAt('/acme/knowledge-base?tab=web');
    expect(screen.getByRole('tab', { name: /Articles/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('All Articles')).toBeInTheDocument();
    expect(screen.queryByTestId('web-body')).toBeNull();
  });

  it('the status link, with the knowledge switch off, gets Articles', () => {
    h.caps = { ...AI_ON, customer_nav: { ...CUSTOMER_NAV, knowledge: false } };
    renderAt('/acme/knowledge-base?tab=status');
    expect(screen.getByRole('tab', { name: /Articles/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('status-body')).toBeNull();
  });

  it('waits, without showing Articles, until the plan, the role and the AI switches are in', async () => {
    h.plan = null;
    const view = renderAt('/acme/knowledge-base?tab=web');
    expect(document.querySelector('[data-kb-tab-waiting]')).not.toBeNull();
    expect(screen.queryByText('All Articles')).toBeNull();
    expect(tabIds()).toEqual(['articles', 'qna', 'files']);

    h.plan = PLAN_WITH_AI;
    view.rerender(page('/acme/knowledge-base?tab=web'));
    expect(await screen.findByTestId('web-body')).toBeInTheDocument();
    expect(document.querySelector('[data-kb-tab-waiting]')).toBeNull();
  });

  it('an unknown ?tab= value is Articles, at once', () => {
    h.plan = null;
    renderAt('/acme/knowledge-base?tab=nonsense');
    expect(document.querySelector('[data-kb-tab-waiting]')).toBeNull();
    expect(screen.getByText('All Articles')).toBeInTheDocument();
  });
});

describe('choosing a tab', () => {
  it('writes it into the address, and Articles clears it', async () => {
    renderAt();
    openTab('Learning from operators');
    expect(await screen.findByTestId('learning-body')).toBeInTheDocument();
    expect(screen.getByTestId('address').textContent).toBe('/acme/knowledge-base?tab=learning');

    openTab('Q&A');
    expect(screen.getByTestId('address').textContent).toBe('/acme/knowledge-base?tab=qna');

    openTab('Articles');
    expect(screen.getByTestId('address').textContent).toBe('/acme/knowledge-base');
  });

  it('back on Articles, the list is read again: a learned answer may have been published as one meanwhile', async () => {
    renderAt('/acme/knowledge-base?tab=learning');
    expect(await screen.findByTestId('learning-body')).toBeInTheDocument();
    expect(h.refetchArticles).not.toHaveBeenCalled();
    openTab('Articles');
    expect(h.refetchArticles).toHaveBeenCalledTimes(1);
    expect(screen.getByText('All Articles')).toBeInTheDocument();
  });
});
