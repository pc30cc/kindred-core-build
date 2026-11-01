/**
 * KnowledgePage groups the customer summary's rows (GET
 * /api/ai-agent/knowledge/customer-summary, built by
 * server/services/ai-agent/sourceHealth.ts) by `source_type`. It looked for
 * 'learning_candidate', which the server never sends (it sends
 * 'learned_qna'), so "Learned Answers" was always empty; and the server's
 * individual 'web_page' rows matched no group at all. Renders the real page
 * against the real English catalogue.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
        if (params) {
          for (const [k, v] of Object.entries(params)) value = value.replace(`{{${k}}}`, String(v));
        }
        return value;
      },
    }),
  };
});

vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', slug: 'acme' }, notFound: false }),
  useWorkspacePath: () => (path: string) => `/acme${path}`,
}));

/** The six source types the summary sends, as the server shapes its rows. */
const ITEMS = [
  { source_id: 'q1', source_type: 'qna', title: 'What are your hours?', eligible: true, reason: 'eligible', updated_at: null },
  { source_id: 'site-1', source_type: 'website', title: 'example.com', eligible: true, reason: 'eligible', updated_at: null },
  { source_id: 'site-1:https://example.com/pricing', source_type: 'web_page', title: 'Pricing page', eligible: true, reason: 'eligible', updated_at: null },
  { source_id: 'site-1:https://example.com/about', source_type: 'web_page', title: 'About us page', eligible: false, reason: 'no_active_chunks', updated_at: null },
  { source_id: 'f1', source_type: 'file', title: 'price-list.pdf', eligible: true, reason: 'eligible', updated_at: null },
  { source_id: 'kb1', source_type: 'kb_article', title: 'Shipping policy', eligible: true, reason: 'eligible', updated_at: null },
  { source_id: 'lc1', source_type: 'learned_qna', title: 'Do you ship to Canada?', eligible: true, reason: 'eligible', updated_at: null },
  { source_id: 'lc2', source_type: 'learned_qna', title: 'Can I pay by card?', eligible: false, reason: 'candidate_not_approved', updated_at: null },
];

vi.mock('@/lib/ai-agent-api', () => ({
  aiAgentApi: { knowledgeCustomerSummary: vi.fn(async () => ({ items: ITEMS })) },
}));

const KnowledgePage = (await import('@/pages/app/ai-agent/KnowledgePage')).default;

function Providers({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

async function renderPage() {
  const view = render(<KnowledgePage />, { wrapper: Providers });
  await screen.findByText('Do you ship to Canada?');
  const group = (key: string) => {
    const el = view.container.querySelector(`[data-source-group="${key}"]`);
    if (!el) throw new Error(`no group ${key}`);
    return el as HTMLElement;
  };
  return { group };
}

/** The titles listed in a group, in order. */
function titlesIn(el: HTMLElement): string[] {
  return [...el.querySelectorAll('.truncate.font-medium')].map((n) => n.textContent || '');
}

describe('KnowledgePage — every summary row lands in its group', () => {
  it('learned answers (learned_qna) show under "Learned Answers", pending ones flagged', async () => {
    const { group } = await renderPage();
    const learned = group('learning_candidate');

    expect(within(learned).getByText('Learned Answers')).toBeInTheDocument();
    expect(titlesIn(learned)).toEqual(['Do you ship to Canada?', 'Can I pay by card?']);
    expect(within(learned).getByText('2')).toBeInTheDocument();
    expect(within(learned).getByText('Learned answer not approved')).toBeInTheDocument();
    expect(within(learned).queryByText('No Learned Answers yet.')).not.toBeInTheDocument();
  });

  it('crawled web pages fold into the website group, after their website', async () => {
    const { group } = await renderPage();
    const website = group('website');

    expect(titlesIn(website)).toEqual(['example.com', 'Pricing page', 'About us page']);
    expect(within(website).getByText('3')).toBeInTheDocument();
    expect(within(website).getByText('Not indexed yet')).toBeInTheDocument();
  });

  it('the other groups keep exactly their own rows', async () => {
    const { group } = await renderPage();

    expect(titlesIn(group('qna'))).toEqual(['What are your hours?']);
    expect(titlesIn(group('file'))).toEqual(['price-list.pdf']);
    expect(titlesIn(group('kb_article'))).toEqual(['Shipping policy']);
  });

  it('no row is dropped or shown twice', async () => {
    await renderPage();

    for (const item of ITEMS) {
      expect(screen.getAllByText(item.title)).toHaveLength(1);
    }
  });
});
