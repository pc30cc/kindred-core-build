/**
 * LearningCandidatesPage — "View conversation" opened `/<workspace id>/inbox`,
 * but workspace URLs are `/<slug>/…` (src/hooks/useWorkspace.ts,
 * useWorkspacePath), so the link always led to "workspace not found".
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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
        if (params) {
          for (const [k, v] of Object.entries(params)) value = value.replace(`{{${k}}}`, String(v));
        }
        return value;
      },
    }),
  };
});

const WS_ID = '77777777-7777-4777-8777-777777777777';

vi.mock('@/hooks/useWorkspace', () => ({
  useCurrentWorkspace: () => ({ id: WS_ID, slug: 'acme' }),
  useWorkspacePath: () => (path: string) => `/acme${path}`,
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const CANDIDATE = {
  id: 'cand-1',
  workspace_id: WS_ID,
  conversation_id: 'conv-42',
  visitor_message_id: null,
  operator_message_id: null,
  question_text: 'Do you ship to Canada?',
  answer_text: 'Yes, in 5 to 7 days.',
  normalized_question: 'do you ship to canada',
  source_type: 'conversation',
  locale: 'en',
  confidence_score: null,
  status: 'pending',
  suggested_title: null,
  suggested_answer: null,
  suggested_tags: [],
  reviewed_by: null,
  reviewed_at: null,
  metadata: { reason: 'no_answer', page_context: { current_page_url: 'https://example.com/shipping' } },
  created_at: '2026-10-30T10:00:00Z',
  updated_at: '2026-10-30T10:00:00Z',
};

vi.mock('@/lib/ai-agent-api', () => ({
  aiAgentApi: {
    listLearningCandidates: vi.fn(async () => ({ items: [CANDIDATE] })),
    getLearningCandidateStats: vi.fn(async () => ({ pending: 1, approved: 0, converted_to_qna: 0, converted_to_kb: 0, rejected: 0 })),
  },
}));

const LearningCandidatesPage = (await import('@/pages/app/ai-agent/LearningCandidatesPage')).default;

describe('LearningCandidatesPage — View conversation', () => {
  it("opens the conversation under the workspace's slug, never its id", async () => {
    render(<LearningCandidatesPage />, { wrapper: MemoryRouter });

    const link = await screen.findByRole('link', { name: 'View conversation' });
    expect(link).toHaveAttribute('href', '/acme/inbox?c=conv-42');
    expect(link.getAttribute('href')).not.toContain(WS_ID);
  });

  it("still shows the candidate's reason and the page it was asked on", async () => {
    render(<LearningCandidatesPage />, { wrapper: MemoryRouter });

    expect(await screen.findByText('No answer found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://example.com/shipping' }))
      .toHaveAttribute('href', 'https://example.com/shipping');
  });
});
