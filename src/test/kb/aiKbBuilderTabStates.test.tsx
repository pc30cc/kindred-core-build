/**
 * Phase 6-S5-R7.4 §14 — BEHAVIORAL tests for the AI KB Builder surface.
 *
 * These render the real component against mocked API responses and assert the
 * rendered access state plus which endpoints were called. Regex source checks
 * cannot prove that an upgrade state renders instead of an endless "Loading…",
 * nor that private job data is never requested for a blocked workspace.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useWorkspace', () => ({
  useCurrentWorkspace: () => ({ id: 'ws-1' }),
}));
vi.mock('@/i18n', () => ({ useTranslation: () => ({ locale: 'en', t: (k: string) => k }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const getSource = vi.fn();
const listJobs = vi.fn();
const getJob = vi.fn();

vi.mock('@/lib/ai-kb-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-kb-api')>();
  return {
    ...actual,
    aiKbApi: {
      getSource: (...a: unknown[]) => getSource(...a),
      listJobs: (...a: unknown[]) => listJobs(...a),
      getJob: (...a: unknown[]) => getJob(...a),
      createJob: vi.fn(),
      accept: vi.fn(), reject: vi.fn(), publish: vi.fn(), publishAll: vi.fn(),
    },
  };
});

import AiKbBuilderTab from '@/components/app/knowledge/AiKbBuilderTab';
import { AiKbApiError, type AiKbSourceResponse } from '@/lib/ai-kb-api';

function makeSource(over: Partial<AiKbSourceResponse['modules']> = {}, extra: Partial<AiKbSourceResponse> = {}): AiKbSourceResponse {
  return {
    source: {
      domain: 'example.com', kind: 'workspace_domain', workspace_domain_id: 'wd-1',
      verified: true, is_primary: true, can_scan: true, reason_if_blocked: null,
      available_domains: [],
    },
    plan: {
      slug: 'pro',
      limits: { maxPages: 25, maxDepth: 2, jobsPerMonth: 5, maxArticles: 30, maxChars: 100000, monthlyCredits: 200 },
      jobs_used_this_month: 0,
      can_start_job: true,
    },
    credits: { used: 0, limit: 200, remaining: 200, period: '2026-08' },
    modules: {
      knowledge_base: true, ai_assistant: true, ai_kb_builder: true,
      platform_enabled: true, platform_status_unavailable: false,
      entitlement_status_unavailable: false, platform_denial_code: null,
      ...over,
    },
    ...extra,
  };
}

beforeEach(() => {
  getSource.mockReset(); listJobs.mockReset(); getJob.mockReset();
  listJobs.mockResolvedValue({ jobs: [] });
});

describe('AiKbBuilderTab — access states', () => {
  it('AI Assistant missing → upgrade state, jobs never requested', async () => {
    getSource.mockResolvedValue(makeSource({ ai_assistant: false }, { upgrade_required: true }));
    render(<AiKbBuilderTab />);
    const panel = await screen.findByTestId('aikb-upgrade-required');
    expect(panel.textContent).toMatch(/AI Assistant is not included in this plan/i);
    expect(listJobs).not.toHaveBeenCalled();
  });

  it('ai_assistant=false blocks the builder even when ai_kb_builder=true', async () => {
    getSource.mockResolvedValue(makeSource({ ai_assistant: false, ai_kb_builder: true }));
    render(<AiKbBuilderTab />);
    const panel = await screen.findByTestId('aikb-upgrade-required');
    expect(panel.textContent).toMatch(/AI Assistant/i);
    expect(listJobs).not.toHaveBeenCalled();
  });

  it('Builder FEATURE missing → upgrade state naming it a feature, jobs never requested', async () => {
    getSource.mockResolvedValue(makeSource({ ai_kb_builder: false }));
    render(<AiKbBuilderTab />);
    const panel = await screen.findByTestId('aikb-upgrade-required');
    expect(panel.textContent).toMatch(/AI Knowledge Builder feature is not included/i);
    expect(panel.textContent).not.toMatch(/module/i);
    expect(listJobs).not.toHaveBeenCalled();
  });

  it('platform kill switch (403) → platform-disabled state with no upgrade CTA', async () => {
    getSource.mockRejectedValue(new AiKbApiError(403, { error: 'ai_platform_kill_switch' }));
    render(<AiKbBuilderTab />);
    await screen.findByTestId('aikb-platform-disabled');
    expect(screen.queryByTestId('aikb-upgrade-required')).toBeNull();
    expect(screen.queryByTestId('aikb-loading')).toBeNull();
    expect(listJobs).not.toHaveBeenCalled();
  });

  it('customer visibility disabled (403) → hidden state with no upgrade CTA', async () => {
    getSource.mockRejectedValue(new AiKbApiError(403, { error: 'ai_customer_visibility_disabled' }));
    render(<AiKbBuilderTab />);
    await screen.findByTestId('aikb-customer-hidden');
    expect(screen.queryByTestId('aikb-upgrade-required')).toBeNull();
    expect(listJobs).not.toHaveBeenCalled();
  });

  it('workspace AI disabled (403) → platform-disabled state, no upgrade CTA', async () => {
    getSource.mockRejectedValue(new AiKbApiError(403, { error: 'ai_workspace_disabled' }));
    render(<AiKbBuilderTab />);
    await screen.findByTestId('aikb-platform-disabled');
    expect(screen.queryByTestId('aikb-upgrade-required')).toBeNull();
  });

  it('initial 503 → retry state instead of endless Loading, then recovers', async () => {
    getSource
      .mockRejectedValueOnce(new AiKbApiError(503, { error: 'plan_status_unavailable', retryable: true }))
      .mockResolvedValue(makeSource());
    render(<AiKbBuilderTab />);
    const retry = await screen.findByTestId('aikb-retry');
    expect(screen.queryByTestId('aikb-loading')).toBeNull();
    expect(listJobs).not.toHaveBeenCalled();
    retry.click();
    await waitFor(() => expect(listJobs).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('aikb-temporarily-unavailable')).toBeNull();
  });

  it('unreadable entitlement snapshot → retry state, jobs never requested', async () => {
    getSource.mockResolvedValue(makeSource({ entitlement_status_unavailable: true }));
    render(<AiKbBuilderTab />);
    await screen.findByTestId('aikb-temporarily-unavailable');
    expect(listJobs).not.toHaveBeenCalled();
  });

  it('fully entitled → source, then jobs, then latest job detail', async () => {
    getSource.mockResolvedValue(makeSource());
    listJobs.mockResolvedValue({
      jobs: [{ id: 'job-1', workspace_id: 'ws-1', status: 'completed', source_kind: null, source_domain: null, locale: 'en', progress: 100, total_pages: 1, processed_pages: 1, failed_pages: 0, generated_articles: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: null, error_code: null }],
    });
    getJob.mockResolvedValue({
      job: { id: 'job-1', status: 'completed', progress: 100, created_at: new Date().toISOString(), processed_pages: 1, total_pages: 1, generated_articles: 1, failed_pages: 0, error_code: null },
      pages: [], events: [],
      generated: [{
        id: 'g-1', job_id: 'job-1', title: 'Pricing', slug: 'pricing', excerpt: null, locale: 'en',
        status: 'published', kb_article_id: 'a-1', suggested_category: null, confidence: null,
        created_at: '', updated_at: '', kb_article_slug: 'pricing-2', kb_article_locale: 'en',
        kb_article_status: 'published', public_path: '/help/en/pricing-2',
      }],
    });
    render(<AiKbBuilderTab />);
    await waitFor(() => expect(getJob).toHaveBeenCalledWith('job-1'));
    expect(getSource).toHaveBeenCalled();
    expect(listJobs).toHaveBeenCalled();
    // Canonical Help Center link comes from the authoritative public_path.
    const link = await screen.findByRole('link', { name: /Open in Help Center/i });
    expect(link.getAttribute('href')).toContain('/help/en/pricing-2');
  });
});
