/**
 * Regression test for the "SEO page goes blank after cancelling an audit"
 * bug report: SeoPage.tsx had render branches for queued/running/processing,
 * failed, and completed crawl statuses, but none for 'cancelled' — the
 * status the backend sets once a worker acknowledges a cancel request
 * (worker/seo-crawler/index.ts, server/services/seo/crawlService.ts). With
 * `crawl` truthy but status unmatched, nothing rendered below the page
 * header, and there was no way to start a new audit from that state.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (k: string) => k, dir: 'ltr' }) }));
vi.mock('@/hooks/useWorkspace', () => ({ useActiveWorkspace: () => ({ workspace: { id: 'ws-1' } }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const cancelledCrawl = {
  id: 'crawl-1', job_id: 'job-1', workspace_id: 'ws-1', website_id: 'site-1',
  canonical_url: 'https://example.com', status: 'cancelled', progress: 40, progress_stage: 'cancelled',
  pages_discovered: 10, pages_crawled: 4, pages_failed: 0, pages_skipped: 0,
  score: null, score_version: null, score_breakdown: null, robots_summary: null, sitemap_summary: null,
  error_message: null, error_category: null, created_at: '', started_at: '', finished_at: '',
};

vi.mock('@/hooks/useSeo', () => ({
  useSeoSites: () => ({ data: { sites: [{ id: 'site-1', domain: 'example.com', verified: true, is_primary: true, created_at: '' }] }, isLoading: false }),
  useSeoLimits: () => ({ data: undefined }),
  useLatestCrawl: () => ({ data: { crawl: cancelledCrawl }, isLoading: false }),
  useCrawlHistory: () => ({ data: { crawls: [], total: 0 } }),
  useStartCrawl: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelCrawl: () => ({ mutate: vi.fn(), isPending: false }),
  useCrawl: () => ({ data: undefined }),
  useCrawlPages: () => ({ data: undefined, isLoading: false }),
  useCrawlIssues: () => ({ data: undefined }),
  useIssueAffectedUrls: () => ({ data: undefined }),
  useCrawlLinks: () => ({ data: undefined }),
  useCrawlSitemaps: () => ({ data: undefined }),
  useCrawlComparison: () => ({ data: undefined }),
}));

beforeAll(() => {
  (global as any).ResizeObserver = (global as any).ResizeObserver || class {
    observe() {} unobserve() {} disconnect() {}
  };
});

const SeoPage = (await import('@/pages/app/seo/SeoPage')).default;

describe('SeoPage — cancelled crawl status', () => {
  it('renders the cancelled empty-state (not a blank page) when the latest crawl was cancelled', () => {
    render(<SeoPage />);
    expect(screen.getByText('seo.empty.cancelledTitle')).toBeInTheDocument();
    expect(screen.getByText('seo.empty.cancelledCta')).toBeInTheDocument();
  });
});
