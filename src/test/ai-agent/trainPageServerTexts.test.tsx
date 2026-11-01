/**
 * Data Hub (TrainPage) in the Persian dashboard. The server sends its
 * warnings, sync-log lines and retrieval-contract lines in English: the known
 * ones are shown in the panel's words (warnings and sync logs in the Overview
 * page's, aiAgent.overview.*), and anything the dashboard does not know is
 * shown as it came rather than hidden or half-translated.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/i18n';
import fa from '@/i18n/locales/fa';

const OVERVIEW = vi.hoisted(() => {
  const log = (id: string, status: string, message: string | null) => ({
    id, status, message, pages_found: 2, chunks_created: 3, created_at: '2026-11-01T10:00:00Z',
  });
  return {
    counts: {
      totalSources: 2, activeSources: 1, pausedSources: 0, failedSources: 1, syncingSources: 0,
      qnaEnabled: 3, qnaDisabled: 1, kbPublished: 0, kbDraft: 2,
      learningPending: 4, learningApproved: 0, learningRejected: 0, learningConvertedQna: 0, learningConvertedKb: 0,
      activeChunks: 10, embeddedChunks: 7, failedEmbeddings: 3, deletedChunks: 0,
    },
    sourcesByType: [{ source_type: 'website', total: 2, active: 1, paused: 0, failed: 1, syncing: 0, last_synced_at: null }],
    knowledgeIndex: {
      activeChunks: 10, embeddedChunks: 7, staleChunks: 0, deletedChunks: 0, bySourceType: { website: 7 }, byLocale: {},
      lastUpdated: null, embeddingProvider: 'noop', embeddingModel: 'noop', embeddingProviderAvailable: false,
    },
    recentSyncLogs: [
      log('l1', 'completed', 'Sync completed'),
      log('l2', 'failed', 'Crawl failed: download_failed'),
      log('l3', 'file_job_failed_non_retryable', 'parse_failed'),
      log('l4', 'queued', null),
      log('l5', 'mystery_status', 'Something new happened'),
    ],
    recentJobs: [],
    warnings: [
      { code: 'failed_embeddings', severity: 'warn', message: '3 active chunk(s) are missing embeddings.' },
      { code: 'website_not_synced', severity: 'warn', message: 'Website source "Shop "A"" has not been synced yet.' },
      { code: 'source_failed', severity: 'error', message: 'Source "Blog" sync failed: download_failed.' },
      { code: 'brand_new_code', severity: 'info', message: 'A server warning nobody translated.' },
    ],
    lastSyncAt: null,
    lastRebuildAt: null,
    retrievalContract: { allowed: ['qna (enabled)', 'a line added later'], blocked: ['cross-workspace data'] },
  };
});

vi.mock('@/lib/ai-agent-api', () => ({
  aiAgentApi: { getTrainOverview: vi.fn(async () => OVERVIEW), rebuildKnowledgeIndex: vi.fn() },
}));
vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', slug: 'acme' }, isLoading: false, notFound: false, workspaces: [] }),
  useWorkspacePath: () => (path: string) => `/acme${path}`,
}));

const TrainPage = (await import('@/pages/app/ai-agent/TrainPage')).default;

/** The page's text with the Persian digits the fa locale renders turned back into ASCII. */
function pageText(): string {
  return (document.body.textContent ?? '').replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}
const fill = (text: string, params: Record<string, string>) =>
  Object.entries(params).reduce((v, [k, x]) => v.split(`{{${k}}}`).join(x), text);

describe('Data Hub shows the server texts in Persian', () => {
  it('words the known warnings, sync lines and contract lines, and keeps unknown ones as sent', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider initialLocale="fa" initialTranslations={fa}>
          <MemoryRouter><TrainPage /></MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
    await screen.findByText(fa.aiAgent.train.title);
    const text = pageText();
    const ov = fa.aiAgent.overview;
    const train = fa.aiAgent.train;

    // Warnings, worded as on the Overview page; a source's own error shown under its warning.
    expect(text).toContain(fill(ov.warning.failed_embeddings, { count: '3' }));
    expect(text).toContain(fill(ov.warning.website_not_synced, { name: 'Shop "A"' }));
    expect(text).toContain(fill(ov.warning.source_failed, { name: 'Blog' }) + ov.syncCode.download_failed);
    expect(text).toContain('A server warning nobody translated.');

    // Sync log: status badges and messages, with no stray braces around a value.
    expect(text).toContain(ov.syncStatus.completed + ov.syncMessage.sync_completed);
    const crawlFailed = ov.syncMessage.crawl_failed.replace(/\{+value\}+/, ov.syncCode.download_failed);
    expect(text).toContain(ov.syncStatus.failed + crawlFailed);
    expect(text).not.toContain(`{${ov.syncCode.download_failed}}`);
    expect(text).toContain(ov.syncStatus.file_job_failed_non_retryable + ov.syncCode.parse_failed);
    expect(text).toContain(ov.syncStatus.queued + fill(train.syncSummary, { pages: '2', chunks: '3' }));
    expect(text).toContain('mystery_statusSomething new happened');

    // Retrieval contract, source types and the index's "noop" provider.
    expect(text).toContain(train.contract.qnaEnabled);
    expect(text).toContain(train.contract.crossWorkspace);
    expect(text).toContain('a line added later');
    expect(text).toContain(`${train.types.webPages}: 7`);
    expect(text).toContain(`${train.index.provider} ${train.index.none}`);
    expect(text).not.toContain('qna (enabled)');
    expect(text).not.toContain('noop');
  });
});
