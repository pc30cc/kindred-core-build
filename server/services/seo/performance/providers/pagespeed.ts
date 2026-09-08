/**
 * GOOGLE PAGESPEED INSIGHTS ADAPTER
 *
 * Wraps Google's PageSpeed Insights v5 API (`GET
 * https://www.googleapis.com/pagespeedonline/v5/runPagespeed`) — a single
 * synchronous HTTP call that runs a real Lighthouse audit server-side and
 * returns category scores + Core Web Vitals directly. No headless
 * Chrome/Lighthouse install is needed on our own infrastructure; Google
 * runs it and returns JSON.
 *
 * Auth: an optional `key` query param (Google API key). PSI works keyless
 * at a much lower shared quota, so `apiKey` may be null — every call below
 * omits the param entirely when unset rather than sending an empty string.
 *
 * FIELD-MAPPING NOTE: this adapter's response parsing was written against
 * PSI v5's long-stable response envelope and documented Lighthouse audit
 * IDs (`categories.{performance,accessibility,best-practices,seo}.score`,
 * `audits['largest-contentful-paint'|'cumulative-layout-shift'|
 * 'interaction-to-next-paint'|'first-contentful-paint'|
 * 'total-blocking-time'].numericValue`). It could not be verified against a
 * live response from this environment (network policy blocks outbound
 * calls to Google's API from this sandbox), so parsing is deliberately
 * defensive: every field is optional-safe, unknown/renamed audits are
 * ignored rather than throwing, and `interaction-to-next-paint` (INP) falls
 * back to null on Lighthouse versions that don't report it yet. Re-verify
 * field names against a real response on first live test.
 *
 * SECURITY
 * - No credential is ever placed in an error message, log line or return value.
 * - Every call is fail-closed: HTTP errors, malformed JSON, and timeouts all
 *   resolve to a normalized `PerformanceError`.
 */
import {
  PerformanceError,
  type PageSpeedConfig,
  type PerformanceAuditItem,
  type PerformanceStrategy,
} from '../types.js';

export const PAGESPEED_TIMEOUT_MS = 45_000;
export const PAGESPEED_API_BASE = 'https://www.googleapis.com/pagespeedonline/v5';

export interface PageSpeedAdapter {
  auditUrl(input: { url: string; strategy: PerformanceStrategy }): Promise<PerformanceAuditItem>;
}

export interface PageSpeedAdapterOptions {
  /** Test seam — injects a fake fetch. Production leaves this undefined. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  apiBase?: string;
}

const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];

async function getJson(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    if (res.status === 400) throw new PerformanceError('performance_invalid_target');
    if (res.status === 401 || res.status === 403) throw new PerformanceError('performance_auth_failed');
    if (res.status === 429) throw new PerformanceError('performance_rate_limited');
    if (!res.ok) throw new PerformanceError('performance_provider_error');
    try {
      return await res.json();
    } catch {
      throw new PerformanceError('performance_provider_error');
    }
  } catch (err) {
    if (err instanceof PerformanceError) throw err;
    if ((err as { name?: string })?.name === 'AbortError') throw new PerformanceError('performance_timeout');
    throw new PerformanceError('performance_network_error');
  } finally {
    clearTimeout(timer);
  }
}

function readNumber(source: Record<string, unknown> | undefined, key: string): number | null {
  if (!source) return null;
  const v = source[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function categoryScore(categories: Record<string, unknown> | undefined, key: string): number | null {
  if (!categories) return null;
  const cat = categories[key] as Record<string, unknown> | undefined;
  const score = readNumber(cat, 'score');
  return score === null ? null : Math.round(score * 100);
}

function auditNumeric(audits: Record<string, unknown> | undefined, key: string): number | null {
  if (!audits) return null;
  const audit = audits[key] as Record<string, unknown> | undefined;
  return readNumber(audit, 'numericValue');
}

function buildUrl(apiBase: string, apiKey: string | null, target: string, strategy: PerformanceStrategy): string {
  const params = new URLSearchParams();
  params.set('url', target);
  params.set('strategy', strategy);
  for (const c of CATEGORIES) params.append('category', c);
  if (apiKey) params.set('key', apiKey);
  return `${apiBase}/runPagespeed?${params.toString()}`;
}

export function createPageSpeedAdapter(
  config: PageSpeedConfig,
  options: PageSpeedAdapterOptions = {},
): PageSpeedAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PAGESPEED_TIMEOUT_MS;
  const apiBase = options.apiBase ?? PAGESPEED_API_BASE;

  return {
    async auditUrl({ url, strategy }) {
      const body = await getJson(buildUrl(apiBase, config.apiKey, url, strategy), fetchImpl, timeoutMs);
      const envelope = body as Record<string, unknown>;
      const lighthouseResult = envelope.lighthouseResult as Record<string, unknown> | undefined;
      if (!lighthouseResult) throw new PerformanceError('performance_provider_error');

      const categories = lighthouseResult.categories as Record<string, unknown> | undefined;
      const audits = lighthouseResult.audits as Record<string, unknown> | undefined;

      const clsRaw = auditNumeric(audits, 'cumulative-layout-shift');

      return {
        performanceScore: categoryScore(categories, 'performance'),
        accessibilityScore: categoryScore(categories, 'accessibility'),
        bestPracticesScore: categoryScore(categories, 'best-practices'),
        seoScore: categoryScore(categories, 'seo'),
        lcpMs: auditNumeric(audits, 'largest-contentful-paint'),
        cls: clsRaw === null ? null : Math.round(clsRaw * 1000) / 1000,
        inpMs: auditNumeric(audits, 'interaction-to-next-paint') ?? auditNumeric(audits, 'experimental-interaction-to-next-paint'),
        fcpMs: auditNumeric(audits, 'first-contentful-paint'),
        tbtMs: auditNumeric(audits, 'total-blocking-time'),
        rawSummary: { fetchedAt: new Date().toISOString(), finalUrl: (envelope as any).id ?? url },
      };
    },
  };
}
