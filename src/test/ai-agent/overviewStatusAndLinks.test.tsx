/**
 * The AI Overview after the 2026-11-01 round (owner): the Activation page
 * became part of «شخصیت و رفتار» (/ai-agent/behavior), so its status pieces
 * moved here, compact (who holds the conversations; the operators' state and
 * whether the assistant answers now, both from the diagnostics), and the
 * Overview's knowledge links open the Knowledge Base's tabs, where knowledge
 * is managed. Rendered with the real router and the English catalogue; the
 * API answers are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const h = vi.hoisted(() => ({
  diag: undefined as Record<string, unknown> | undefined,
  kbTabs: { known: true, web: true, learning: true, status: true },
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
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', slug: 'acme' } }),
  useWorkspacePath: () => (path: string) => `/acme${path}`,
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/pages/app/ai-agent/TestAiPanel', () => ({ default: () => null }));
vi.mock('@/hooks/useAiAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAiAgent')>()),
  useAiAgentDiagnostics: () => ({ data: h.diag }),
}));
vi.mock('@/components/app/knowledge/useKnowledgeAiTabs', () => ({ useKnowledgeAiTabs: () => h.kbTabs }));

const OVERVIEW = {
  settings: { enabled: true, mode: 'auto_reply_when_offline' },
  counts: {
    guidanceRules: 0, routingRules: 0, topics: 2, workflows: 1, messageTriggers: 3, tools: 0, qna: 5,
    pendingLearningCandidates: 0, dataSources: 1, activeChunks: 10, embeddedChunks: 8,
    aiRuns24h: 4, replies24h: 3, handoffs24h: 1, noAnswer24h: 2, failed24h: 0, outputLanguageRepairs24h: 0,
  },
  knowledgeIndex: null,
  recentRuns: [],
  recentSyncLogs: [],
  warnings: [],
};
vi.mock('@/lib/ai-agent-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai-agent-api')>()),
  aiAgentApi: { getOverview: vi.fn(async () => OVERVIEW), rebuildKnowledgeIndex: vi.fn() },
}));

const OverviewPage = (await import('@/pages/app/ai-agent/OverviewPage')).default;

function Address() {
  const { pathname, search } = useLocation();
  return <output data-testid="address">{pathname + search}</output>;
}

async function renderOverview() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/acme/ai-agent/overview']}>
        <Routes>
          <Route path="*" element={<><OverviewPage /><Address /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByText('Last 24 hours');
}
const address = () => screen.getByTestId('address').textContent;

function diagnostics(over: { enabled?: boolean; mode?: string; availability?: Record<string, unknown> | null } = {}) {
  return {
    checks: {
      ai_provider_configured: true, has_knowledge: true, module_enabled: true,
      settings_enabled: over.enabled ?? true, mode: over.mode ?? 'auto_reply_when_offline',
    },
    operator_availability: over.availability === undefined
      ? { status: 'offline', state: 'offline', online_count: 0, total_count: 4 }
      : over.availability,
    automated_inbox: { ai_managed: 3, needs_human: 1, human_active: 2, last_handoff_reason: null, last_human_takeover_at: null },
  };
}

beforeEach(() => {
  cleanup();
  h.diag = diagnostics();
  h.kbTabs = { known: true, web: true, learning: true, status: true };
});

describe('Right now: what the Activation page showed', () => {
  it('who holds the conversations', async () => {
    await renderOverview();
    const now = document.querySelector('[data-ai-overview-now]') as HTMLElement;
    expect(within(now).getByText('Handled by the assistant').closest('.p-4')?.textContent).toContain('3');
    expect(within(now).getByText('Waiting for an operator').closest('.p-4')?.textContent).toContain('1');
    expect(within(now).getByText('Handled by an operator').closest('.p-4')?.textContent).toContain('2');
  });

  it('the operators, and that the assistant answers now while they are away', async () => {
    await renderOverview();
    const card = document.querySelector('[data-availability-status]') as HTMLElement;
    expect(card.getAttribute('data-availability-status')).toBe('offline');
    expect(card.textContent).toContain('Operators');
    expect(card.textContent).toContain('Offline');
    expect(card.textContent).toContain('0 of 4 online');
    expect(within(card).getByText('The assistant answers now')).toBeInTheDocument();
  });

  it.each([
    ['the agent is off', { enabled: false }],
    ['it answers in another mode', { mode: 'suggest_only' }],
    ['the operators are online', { availability: { status: 'online', online_count: 2, total_count: 4 } }],
    ['their state is unknown', { availability: { status: 'unavailable' } }],
  ])('no “answers now” when %s', async (_label, over) => {
    h.diag = diagnostics(over);
    await renderOverview();
    expect(document.querySelector('[data-ai-answers-now]')).toBeNull();
  });

  it('an unknown state reads Unknown, without counts', async () => {
    h.diag = diagnostics({ availability: { status: 'unavailable' } });
    await renderOverview();
    const card = document.querySelector('[data-availability-status]') as HTMLElement;
    expect(card.getAttribute('data-availability-status')).toBe('unknown');
    expect(card.textContent).toContain('Unknown');
    expect(card.textContent).not.toContain('online');
  });

  it('nothing of it before the diagnostics are in', async () => {
    h.diag = undefined;
    await renderOverview();
    expect(document.querySelector('[data-ai-overview-now]')).toBeNull();
  });
});

describe('where the Overview leads', () => {
  it.each([
    ['Personality & behavior', '/acme/ai-agent/behavior'],
    ['Add web page source', '/acme/knowledge-base?tab=web'],
    ['Review learning candidates', '/acme/knowledge-base?tab=learning'],
    ['Add Q&A', '/acme/knowledge-base?tab=qna'],
  ])('“%s” opens %s', async (name, target) => {
    await renderOverview();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name.replace(/[&]/g, '\\$&')}$`) }));
    expect(address()).toBe(target);
  });

  it.each([
    ['Mode', '/acme/ai-agent/behavior'],
    ['Knowledge chunks', '/acme/knowledge-base?tab=status'],
    ['No answer', '/acme/knowledge-base?tab=learning'],
    ['Q&A pairs', '/acme/knowledge-base?tab=qna'],
  ])('the %s tile opens %s', async (label, target) => {
    await renderOverview();
    fireEvent.click(screen.getByRole('button', { name: `Open: ${label}` }));
    expect(address()).toBe(target);
  });

  it('nothing leads to the old Activation or knowledge pages', async () => {
    await renderOverview();
    for (const button of screen.getAllByRole('button')) {
      fireEvent.click(button);
      expect(address()).not.toMatch(/\/ai-agent\/(activation|knowledge|web-pages|learning-candidates|train)\b/);
    }
  });

  it('the Knowledge tile opens nothing when the knowledge switch hides the status tab', async () => {
    h.kbTabs = { known: true, web: true, learning: true, status: false };
    await renderOverview();
    expect(screen.queryByRole('button', { name: 'Open: Knowledge chunks' })).toBeNull();
    expect(screen.getByText('Knowledge chunks')).toBeInTheDocument();
  });
});
