/**
 * AI → Advanced tools: Source health and the AI billing placeholder speak the
 * panel's language. In Persian no English word of the UI is left on screen:
 * source types, statuses, eligibility reasons (kb_locked and
 * kb_disabled_for_ai included), filters, column heads and the placeholder's
 * notice; titles and errors the sources carry are data.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', slug: 'acme' } }),
}));

const row = (over: Record<string, unknown>) => ({
  source_type: 'qna', source_id: Math.random().toString(36).slice(2), title: 'پرسش نمونه', status: 'enabled',
  eligible: true, reason: 'eligible', active_chunks_count: 3, embedded_chunks_count: 3,
  last_indexed_at: '2026-11-01T08:00:00Z', last_error: null, ...over,
});

const api = vi.hoisted(() => ({ getSourceHealth: vi.fn() }));
vi.mock('@/lib/ai-agent-api', () => ({ aiAgentApi: api }));

const { default: SourceHealthPage } = await import('@/pages/app/ai-agent/SourceHealthPage');
const { default: BillingPage } = await import('@/pages/app/ai-agent/BillingPage');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function mount(ui: React.ReactElement, locale: 'fa' | 'en' | 'tr' = 'fa') {
  api.getSourceHealth.mockResolvedValue({
    items: [
      row({}),
      row({ source_type: 'qna', status: 'disabled', eligible: false, reason: 'disabled_qna' }),
      row({ source_type: 'learned_qna', status: 'pending', eligible: false, reason: 'candidate_not_approved', title: 'پرسش یادگرفته' }),
      row({ source_type: 'kb_article', status: 'draft', eligible: false, reason: 'draft_kb', title: 'مقاله ارسال' }),
      row({ source_type: 'kb_article', status: 'published', eligible: false, reason: 'kb_locked', title: 'مقاله قفل' }),
      row({ source_type: 'kb_article', status: 'published', eligible: false, reason: 'kb_disabled_for_ai', title: 'مقاله خاموش' }),
      row({ source_type: 'file', status: 'failed', eligible: false, reason: 'file_not_active', title: 'فهرست قیمت', last_error: 'خواندن فایل ناموفق بود' }),
      row({ source_type: 'website', status: 'syncing', eligible: false, reason: 'website_not_active', title: 'سایت فروشگاه' }),
      row({ source_type: 'web_page', status: 'active', eligible: false, reason: 'embedding_missing', title: 'صفحه تماس', embedded_chunks_count: 0 }),
      row({ source_type: 'web_page', status: null, eligible: false, reason: 'source_missing', title: 'صفحه حذف‌شده' }),
    ],
    summary: {
      eligible: 1, not_eligible: 9, active_chunks_total: 30, embedded_chunks_total: 27, qna_enabled: 1, qna_disabled: 1,
      learned_qna_approved: 0, learned_qna_unapproved: 1, files_active: 0, files_not_active: 1,
      websites_active: 0, websites_not_active: 1, web_pages_eligible: 0, web_pages_not_eligible: 2,
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const messages = locale === 'fa' ? fa : locale === 'tr' ? tr : en;
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale} initialTranslations={messages}>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

function englishWords(root: HTMLElement): string[] {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('pre, code, [dir="ltr"], script, style').forEach((el) => el.remove());
  const texts = [clone.textContent || ''];
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value) texts.push(value);
    }
  });
  return texts.join(' \n ').replace(/⁨[^⁩]*⁩/g, ' ').match(/[A-Za-z]{2,}/g) || [];
}

describe('Source health in Persian', () => {
  it('no English word on the page; types, statuses and reasons in words', async () => {
    mount(<SourceHealthPage />);
    await screen.findByText('مقاله قفل');
    const S = fa.aiAgent.adv.sourceHealth;
    const text = document.body.textContent || '';
    for (const expected of [
      S.title, S.stats.embeddedChunks, S.filters.allTypes, S.cols.lastIndexed, S.notEligible,
      S.reason.kb_locked, S.reason.kb_disabled_for_ai, S.reason.draft_kb, S.reason.candidate_not_approved,
      S.status.syncing, S.status.pending, S.status.published, fa.aiAgent.codes.sourceType.learned_qna,
      fa.aiAgent.codes.sourceType.website,
    ]) {
      expect(text, expected).toContain(expected);
    }
    for (const raw of ['kb_locked', 'learned_qna', 'Source Health', 'Not eligible', 'Embedded chunks', 'All types']) {
      expect(text, raw).not.toContain(raw);
    }
    expect(screen.getByRole('combobox', { name: S.filters.typeLabel })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: S.filters.search })).toBeTruthy();
    expect(englishWords(document.body)).toEqual([]);
  });

  it('in Turkish the reasons are Turkish too', async () => {
    mount(<SourceHealthPage />, 'tr');
    await screen.findByText('مقاله قفل');
    expect(document.body.textContent).toContain(tr.aiAgent.adv.sourceHealth.reason.kb_locked);
    expect(document.body.textContent).toContain(tr.aiAgent.adv.sourceHealth.title);
  });
});

describe('AI billing in Persian', () => {
  it('no English word on the placeholder', () => {
    mount(<BillingPage />);
    const B = fa.aiAgent.adv.billing;
    const text = document.body.textContent || '';
    for (const expected of [B.title, B.description, B.placeholder.badge, B.placeholder.heading, B.placeholder.body, B.bullets.replyCaps]) {
      expect(text, expected).toContain(expected);
    }
    expect(englishWords(document.body)).toEqual([]);
  });
});
