/**
 * SEO / Website Audit — workspace-scoped API client. Auth is the first-party
 * gs_session HttpOnly cookie (credentials: 'include'). The client NEVER
 * sends a URL to the backend — only `workspace_id` + `site_id`; the backend
 * resolves the canonical crawl URL itself from `workspace_domains`.
 */
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = RESOLVED_API_BASE || '';

export type SeoJobStatus = 'queued' | 'running' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface SeoSite {
  id: string;
  domain: string;
  verified: boolean;
  is_primary: boolean;
  created_at: string;
}

export interface SeoCrawl {
  id: string;
  job_id: string;
  workspace_id: string;
  website_id: string;
  canonical_url: string;
  status: SeoJobStatus;
  progress: number;
  progress_stage: string | null;
  pages_discovered: number;
  pages_crawled: number;
  pages_failed: number;
  pages_skipped: number;
  score: number | null;
  score_version: string | null;
  score_breakdown: { totalPenalty: number; entries: Array<{ issueType: string; category: string; severity: string; affectedCount: number; percentOfSite: number; penalty: number; label: string }> } | null;
  robots_summary: { exists: boolean; fetchStatus: number | null; allowDirectiveCount: number; disallowDirectiveCount: number; sitemaps: string[] } | null;
  sitemap_summary: { sitemapCount: number; validSitemapCount: number; invalidSitemapCount: number; totalSitemapUrls: number; crawledButMissingFromSitemap: number; sitemapUrlsNotCrawled: number } | null;
  error_message: string | null;
  error_category: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface SeoPage {
  id: string;
  url: string;
  final_url: string | null;
  http_status: number | null;
  is_indexable: boolean;
  title: string | null;
  meta_description: string | null;
  canonical_status: string | null;
  depth: number;
  response_time_ms: number | null;
  word_count: number;
}

export interface SeoIssue {
  id: string;
  issue_type: string;
  category: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  description: string;
  recommendation: string;
  affected_count: number;
  status: 'new' | 'persistent' | 'resolved';
  first_detected_at: string;
  last_detected_at: string;
}

export interface SeoLink {
  id: string;
  target_url: string;
  is_external: boolean;
  is_broken: boolean;
  http_status: number | null;
  anchor_text: string | null;
  source_page?: { url: string } | null;
}

export interface SeoSitemap {
  id: string;
  url: string;
  discovered_via: string;
  status: 'valid' | 'invalid' | 'unreachable';
  http_status: number | null;
  url_count: number;
  error_message: string | null;
}

export interface SeoLimits {
  planSlug: string | null;
  planName: string | null;
  limits: {
    seo_max_pages_per_crawl: number;
    seo_max_depth: number;
    seo_max_duration_seconds: number;
    seo_crawl_frequency_hours: number;
    [key: string]: number;
  };
}

export class SeoApiError extends Error {
  status: number;
  code: string;
  retryAfterSeconds?: number;
  constructor(status: number, body: any) {
    const code = typeof body?.error === 'string' ? body.error : 'seo_request_failed';
    super(code);
    this.name = 'SeoApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = body?.retryAfterSeconds;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) throw new SeoApiError(res.status, body);
  return body as T;
}

function safeJson(t: string): any {
  try { return JSON.parse(t); } catch { return null; }
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

export function listSeoSites(workspaceId: string) {
  return api<{ sites: SeoSite[] }>(`/api/seo/${workspaceId}/sites`);
}

export function getSeoLimits(workspaceId: string) {
  return api<SeoLimits>(`/api/seo/${workspaceId}/limits`);
}

export function getLatestCrawl(workspaceId: string, siteId: string) {
  return api<{ crawl: SeoCrawl | null }>(`/api/seo/${workspaceId}/sites/${siteId}/latest-crawl`);
}

export function listCrawlHistory(workspaceId: string, siteId: string, opts: { limit?: number; offset?: number } = {}) {
  return api<{ crawls: SeoCrawl[]; total: number }>(`/api/seo/${workspaceId}/sites/${siteId}/crawls${qs(opts)}`);
}

export function startCrawl(workspaceId: string, siteId: string) {
  return api<{ crawl: SeoCrawl }>(`/api/seo/${workspaceId}/crawls`, {
    method: 'POST',
    body: JSON.stringify({ siteId }),
  });
}

export function getCrawl(workspaceId: string, crawlId: string) {
  return api<{ crawl: SeoCrawl }>(`/api/seo/${workspaceId}/crawls/${crawlId}`);
}

export function cancelCrawl(workspaceId: string, crawlId: string) {
  return api<{ ok: boolean }>(`/api/seo/${workspaceId}/crawls/${crawlId}/cancel`, { method: 'POST' });
}

export function listCrawlPages(workspaceId: string, crawlId: string, opts: { httpStatusClass?: string; indexable?: boolean; search?: string; limit?: number; offset?: number } = {}) {
  return api<{ pages: SeoPage[]; total: number }>(`/api/seo/${workspaceId}/crawls/${crawlId}/pages${qs(opts as any)}`);
}

export function listCrawlIssues(workspaceId: string, crawlId: string, opts: { severity?: string; category?: string; status?: string; limit?: number; offset?: number } = {}) {
  return api<{ issues: SeoIssue[]; total: number }>(`/api/seo/${workspaceId}/crawls/${crawlId}/issues${qs(opts as any)}`);
}

export function listIssueAffectedUrls(workspaceId: string, crawlId: string, issueId: string, opts: { limit?: number; offset?: number } = {}) {
  return api<{ urls: Array<{ url: string; page_id: string | null }>; total: number }>(`/api/seo/${workspaceId}/crawls/${crawlId}/issues/${issueId}/pages${qs(opts)}`);
}

export function listCrawlLinks(workspaceId: string, crawlId: string, opts: { external?: boolean; broken?: boolean; limit?: number; offset?: number } = {}) {
  return api<{ links: SeoLink[]; total: number }>(`/api/seo/${workspaceId}/crawls/${crawlId}/links${qs(opts as any)}`);
}

export function listCrawlSitemaps(workspaceId: string, crawlId: string) {
  return api<{ sitemaps: SeoSitemap[] }>(`/api/seo/${workspaceId}/crawls/${crawlId}/sitemaps`);
}

export interface SeoComparison {
  hasPrevious: boolean;
  previousCrawlId?: string;
  previousCrawledAt?: string;
  previousScore?: number | null;
  newIssues: Array<{ issue_type: string; title: string; severity: string }>;
  resolvedIssues: Array<{ issue_type: string; title: string; severity: string }>;
  persistentIssues: Array<{ issue_type: string; title: string; severity: string }>;
}

export function compareCrawl(workspaceId: string, crawlId: string) {
  return api<SeoComparison>(`/api/seo/${workspaceId}/crawls/${crawlId}/compare`);
}

export const TERMINAL_SEO_STATUSES: ReadonlySet<SeoJobStatus> = new Set(['completed', 'failed', 'cancelled']);
