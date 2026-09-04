/**
 * Regression test for the "Start First Audit does nothing" bug report:
 * useStartCrawl's mutation had no onError handler, so any failed
 * POST /api/seo/:workspaceId/crawls (missing migration, plan limit, site
 * removed, etc.) silently disappeared — the button just re-enabled with no
 * feedback. SeoPage.tsx now wires onError through this pure mapper so every
 * known SeoApiError code (and any unrecognized one) always produces a
 * user-visible, translated message.
 */
import { describe, it, expect } from 'vitest';
import { startCrawlErrorMessage } from '../../pages/app/seo/SeoPage';
import { SeoApiError } from '../../lib/seo-api';

const t = (key: string, opts?: Record<string, unknown>) => {
  if (key === 'seo.limits.retryAfter') return `retry-after:${(opts as any)?.minutes}`;
  return key;
};

describe('startCrawlErrorMessage', () => {
  it('maps workspace_concurrency_limit to the existing seo.limits translation key', () => {
    const err = new SeoApiError(429, { error: 'workspace_concurrency_limit' });
    expect(startCrawlErrorMessage(t, err)).toBe('seo.limits.workspace_concurrency_limit');
  });

  it('maps site_concurrency_limit to the existing seo.limits translation key', () => {
    const err = new SeoApiError(429, { error: 'site_concurrency_limit' });
    expect(startCrawlErrorMessage(t, err)).toBe('seo.limits.site_concurrency_limit');
  });

  it('maps frequency_limit to the frequency message plus a retry-after estimate in minutes', () => {
    const err = new SeoApiError(429, { error: 'frequency_limit', retryAfterSeconds: 7200 });
    expect(startCrawlErrorMessage(t, err)).toBe('seo.limits.frequency_limit retry-after:120');
  });

  it('rounds a sub-minute retryAfterSeconds up to at least 1 minute', () => {
    const err = new SeoApiError(429, { error: 'frequency_limit', retryAfterSeconds: 5 });
    expect(startCrawlErrorMessage(t, err)).toBe('seo.limits.frequency_limit retry-after:1');
  });

  it('maps site_not_found to a translated message', () => {
    const err = new SeoApiError(404, { error: 'site_not_found' });
    expect(startCrawlErrorMessage(t, err)).toBe('seo.errors.siteNotFound');
  });

  it('falls back to a generic translated message for an unrecognized SeoApiError code (e.g. a 500 from a missing table)', () => {
    const err = new SeoApiError(500, { error: 'create_crawl_failed', detail: 'relation "background_jobs" does not exist' });
    expect(startCrawlErrorMessage(t, err)).toBe('seo.errors.startFailed');
  });

  it('falls back to the generic message for a non-SeoApiError (e.g. a network failure)', () => {
    expect(startCrawlErrorMessage(t, new TypeError('Failed to fetch'))).toBe('seo.errors.startFailed');
  });

  it('never returns an empty string, so the toast is never silently blank', () => {
    for (const err of [
      new SeoApiError(500, {}),
      new SeoApiError(500, null),
      new Error('anything'),
      'not even an Error',
      undefined,
    ]) {
      expect(startCrawlErrorMessage(t, err)).toBeTruthy();
    }
  });
});
