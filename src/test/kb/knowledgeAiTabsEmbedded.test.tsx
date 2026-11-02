/**
 * The AI section's knowledge pages inside the Knowledge Base (owner,
 * 2026-11-01): each opens `embedded` in its tab (KnowledgeBasePage.tsx), with
 * no page header of its own (the Knowledge Base's hero and tab name it) and
 * its links pointing at the Knowledge Base's tabs, and otherwise works as it
 * did. The pages run for real against stubbed API answers and the English
 * catalogue; who sees which tab is knowledgeBaseAiTabs.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

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
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', slug: 'acme' }, isLoading: false, notFound: false, workspaces: [] }),
  useWorkspacePath: () => (path: string) => `/acme${path}`,
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const SOURCE = {
  id: 'src-1', workspace_id: 'ws-1', source_type: 'website', name: 'Main site', base_url: 'https://example.com',
  status: 'active', include_rules: [], exclude_rules: [], crawl_depth: 2, max_pages: 50, refresh_interval: 'weekly',
  last_synced_at: null, next_sync_at: null, last_error: null, metadata: {}, created_at: '2026-10-30T10:00:00Z', updated_at: '2026-10-30T10:00:00Z',
};
const CANDIDATE = {
  id: 'cand-1', workspace_id: 'ws-1', conversation_id: 'conv-42', visitor_message_id: null, operator_message_id: null,
  question_text: 'Do you ship to Canada?', answer_text: 'Yes, in 5 to 7 days.', normalized_question: 'do you ship to canada',
  source_type: 'conversation', locale: 'en', confidence_score: null, status: 'pending', suggested_title: null,
  suggested_answer: null, suggested_tags: [], reviewed_by: null, reviewed_at: null, metadata: { reason: 'no_answer' },
  created_at: '2026-10-30T10:00:00Z', updated_at: '2026-10-30T10:00:00Z',
};
const TRAIN = {
  counts: {
    totalSources: 2, activeSources: 1, pausedSources: 0, failedSources: 0, syncingSources: 0,
    qnaEnabled: 3, qnaDisabled: 1, kbPublished: 1, kbDraft: 2,
    learningPending: 4, learningApproved: 0, learningRejected: 0, learningConvertedQna: 0, learningConvertedKb: 0,
    activeChunks: 10, embeddedChunks: 7, failedEmbeddings: 0, deletedChunks: 0,
  },
  sourcesByType: [],
  knowledgeIndex: null,
  recentSyncLogs: [],
  recentJobs: [],
  warnings: [{ code: 'no_qna', severity: 'warn', message: 'No Q&A yet.' }],
  lastSyncAt: null,
  lastRebuildAt: null,
  retrievalContract: { allowed: ['qna (enabled)'], blocked: ['cross-workspace data'] },
};

const api = vi.hoisted(() => ({
  listDataSources: vi.fn(),
  getWorkspaceDomains: vi.fn(),
  getDataSourceLimits: vi.fn(),
  getDataSourceJobs: vi.fn(),
  listLearningCandidates: vi.fn(),
  getLearningCandidateStats: vi.fn(),
  getTrainOverview: vi.fn(),
  rebuildKnowledgeIndex: vi.fn(),
  knowledgeCustomerSummary: vi.fn(),
}));
vi.mock('@/lib/ai-agent-api', () => ({ aiAgentApi: api }));

const WebPagesPage = (await import('@/pages/app/ai-agent/WebPagesPage')).default;
const LearningCandidatesPage = (await import('@/pages/app/ai-agent/LearningCandidatesPage')).default;
const TrainPage = (await import('@/pages/app/ai-agent/TrainPage')).default;
const KnowledgePage = (await import('@/pages/app/ai-agent/KnowledgePage')).default;
const KnowledgeStatusTab = (await import('@/components/app/knowledge/KnowledgeStatusTab')).default;

function Address() {
  const { pathname, search } = useLocation();
  return <output data-testid="address">{pathname + search}</output>;
}

function renderInKb(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/acme/knowledge-base?tab=status']}>
        <Routes>
          <Route path="*" element={<>{ui}<Address /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const pageHeading = () => document.querySelector('h1, [data-page-hero]');

beforeEach(() => {
  cleanup();
  api.listDataSources.mockResolvedValue({ items: [SOURCE] });
  api.getWorkspaceDomains.mockResolvedValue({ domains: [{ domain: 'example.com', is_primary: true, verified: true }] });
  api.getDataSourceLimits.mockResolvedValue({
    planSlug: 'pro', planName: 'Pro', jobs_used_this_month: 1, bypass: false,
    limits: { ai_kb_max_pages: 100, ai_kb_max_depth: 3, ai_kb_jobs_per_month: 20, ai_kb_file_count: 10, ai_kb_file_size_mb: 5 },
    worker: { workerId: 'w', inProcess: true, started: true },
  });
  api.getDataSourceJobs.mockResolvedValue({ items: [] });
  api.listLearningCandidates.mockResolvedValue({ items: [CANDIDATE] });
  api.getLearningCandidateStats.mockResolvedValue({ pending: 1, approved: 0, converted_to_qna: 0, converted_to_kb: 0, rejected: 0 });
  api.getTrainOverview.mockResolvedValue(TRAIN);
  api.knowledgeCustomerSummary.mockResolvedValue({
    items: [{ source_id: 'q1', source_type: 'qna', title: 'What are your hours?', eligible: true, reason: 'eligible', updated_at: null }],
  });
});

describe('Website pages, embedded', () => {
  it('has no page header, keeps its description, its sources and its add button', async () => {
    renderInKb(<WebPagesPage embedded />);
    expect(await screen.findByText('Main site')).toBeInTheDocument();
    expect(pageHeading()).toBeNull();
    expect(screen.getByText(/Crawl pages from your registered website/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add website source/ })).toBeEnabled();
    expect(screen.getByText('Weekly')).toBeInTheDocument();
  });

  it('on its own it still has its header', async () => {
    renderInKb(<WebPagesPage />);
    expect(await screen.findByRole('heading', { level: 1, name: /Web pages/ })).toBeInTheDocument();
  });
});

describe('Learning from operators, embedded', () => {
  it('has no page header, keeps its description, the scan and the candidates', async () => {
    renderInKb(<LearningCandidatesPage embedded />);
    expect(await screen.findByDisplayValue('Do you ship to Canada?')).toBeInTheDocument();
    expect(pageHeading()).toBeNull();
    expect(screen.getByText(/Review questions the AI couldn't confidently answer/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Scan recent runs/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View conversation' })).toHaveAttribute('href', '/acme/inbox?c=conv-42');
  });
});

describe('The assistant’s knowledge status: sync status and each source’s readiness, together', () => {
  it('shows both, with no page header', async () => {
    renderInKb(<KnowledgeStatusTab />);
    expect(await screen.findByText('Total sources')).toBeInTheDocument();
    expect(await screen.findByText('What are your hours?')).toBeInTheDocument();
    expect(pageHeading()).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Knowledge Sources' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Rebuild knowledge index/ })).toBeInTheDocument();
    // The Knowledge Base's own tabs are right above: no links to them here.
    expect(screen.queryByRole('link', { name: /Manage articles/ })).toBeNull();
  });

  it.each([
    ['Add Q&A', '/acme/knowledge-base?tab=qna'],
    ['Add web page source', '/acme/knowledge-base?tab=web'],
    ['Upload file', '/acme/knowledge-base?tab=files'],
    ['Review learning candidates', '/acme/knowledge-base?tab=learning'],
    ['Open Overview', '/acme/ai-agent/overview'],
  ])('“%s” opens %s', async (label, target) => {
    renderInKb(<TrainPage embedded />);
    fireEvent.click(await screen.findByRole('button', { name: label }));
    expect(screen.getByTestId('address').textContent).toBe(target);
  });

  it('on their own the pages keep their headers and the Knowledge Base links', async () => {
    renderInKb(<><TrainPage /><KnowledgePage /></>);
    expect(await screen.findByRole('heading', { level: 1, name: 'Data Hub' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge Sources' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Manage articles/ })).toHaveAttribute('href', '/acme/knowledge-base');
    expect(screen.getByRole('link', { name: /Manage files/ })).toHaveAttribute('href', '/acme/knowledge-base?tab=files');
  });
});
