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

// ─── SEO Backlinks ─────────────────────────────────────────────────────

export interface SeoBacklinksLimits {
  planSlug: string | null;
  planName: string | null;
  limits: {
    seo_backlinks_max_per_scan: number;
    seo_backlinks_workspace_concurrent_scans: number;
    seo_backlinks_scan_frequency_hours: number;
    [key: string]: number;
  };
}

export interface SeoBacklinkScan {
  id: string;
  job_id: string;
  workspace_id: string;
  website_id: string;
  target_url: string;
  provider: string;
  max_backlinks: number;
  status: SeoJobStatus;
  progress: number;
  progress_stage: string | null;
  total_backlinks: number | null;
  referring_domains: number | null;
  dofollow_count: number | null;
  nofollow_count: number | null;
  new_backlinks: number | null;
  lost_backlinks: number | null;
  error_message: string | null;
  error_category: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface SeoBacklink {
  id: string;
  source_url: string;
  source_domain: string;
  target_url: string;
  anchor_text: string | null;
  is_dofollow: boolean;
  is_new: boolean;
  is_lost: boolean;
  page_rank: number | null;
  domain_rank: number | null;
  spam_score: number | null;
  first_seen: string | null;
  last_seen: string | null;
}

export function getBacklinksLimits(workspaceId: string) {
  return api<SeoBacklinksLimits>(`/api/seo/${workspaceId}/backlinks/limits`);
}

export function getLatestBacklinkScan(workspaceId: string, siteId: string) {
  return api<{ scan: SeoBacklinkScan | null }>(`/api/seo/${workspaceId}/sites/${siteId}/backlink-scans/latest`);
}

export function listBacklinkScanHistory(workspaceId: string, siteId: string, opts: { limit?: number; offset?: number } = {}) {
  return api<{ scans: SeoBacklinkScan[]; total: number }>(`/api/seo/${workspaceId}/sites/${siteId}/backlink-scans${qs(opts)}`);
}

export function startBacklinkScan(workspaceId: string, siteId: string) {
  return api<{ scan: SeoBacklinkScan }>(`/api/seo/${workspaceId}/backlink-scans`, {
    method: 'POST',
    body: JSON.stringify({ siteId }),
  });
}

export function getBacklinkScan(workspaceId: string, scanId: string) {
  return api<{ scan: SeoBacklinkScan }>(`/api/seo/${workspaceId}/backlink-scans/${scanId}`);
}

export function cancelBacklinkScan(workspaceId: string, scanId: string) {
  return api<{ ok: boolean }>(`/api/seo/${workspaceId}/backlink-scans/${scanId}/cancel`, { method: 'POST' });
}

export function listBacklinks(workspaceId: string, scanId: string, opts: { dofollow?: boolean; isNew?: boolean; search?: string; limit?: number; offset?: number } = {}) {
  return api<{ backlinks: SeoBacklink[]; total: number }>(`/api/seo/${workspaceId}/backlink-scans/${scanId}/backlinks${qs(opts as any)}`);
}

// ─── SEO Keyword Research ──────────────────────────────────────────────

export interface SeoKeywordsLimits {
  planSlug: string | null;
  planName: string | null;
  limits: {
    seo_keywords_max_per_lookup: number;
    seo_keywords_workspace_concurrent_runs: number;
    seo_keywords_lookup_frequency_hours: number;
    [key: string]: number;
  };
}

export interface SeoKeywordRun {
  id: string;
  job_id: string;
  workspace_id: string;
  website_id: string;
  seed_keywords: string[];
  provider: string;
  max_keywords: number;
  status: SeoJobStatus;
  progress: number;
  progress_stage: string | null;
  total_keywords: number | null;
  error_message: string | null;
  error_category: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface SeoKeywordResult {
  id: string;
  keyword: string;
  search_volume: number | null;
  cpc: number | null;
  competition: number | null;
  competition_level: 'low' | 'medium' | 'high' | null;
  difficulty: number | null;
  is_seed: boolean;
}

export function getKeywordsLimits(workspaceId: string) {
  return api<SeoKeywordsLimits>(`/api/seo/${workspaceId}/keywords/limits`);
}

export function getLatestKeywordRun(workspaceId: string, siteId: string) {
  return api<{ run: SeoKeywordRun | null }>(`/api/seo/${workspaceId}/sites/${siteId}/keyword-runs/latest`);
}

export function listKeywordRunHistory(workspaceId: string, siteId: string, opts: { limit?: number; offset?: number } = {}) {
  return api<{ runs: SeoKeywordRun[]; total: number }>(`/api/seo/${workspaceId}/sites/${siteId}/keyword-runs${qs(opts)}`);
}

export function startKeywordRun(workspaceId: string, siteId: string, seedKeywords: string[]) {
  return api<{ run: SeoKeywordRun }>(`/api/seo/${workspaceId}/keyword-runs`, {
    method: 'POST',
    body: JSON.stringify({ siteId, seedKeywords }),
  });
}

export function getKeywordRun(workspaceId: string, runId: string) {
  return api<{ run: SeoKeywordRun }>(`/api/seo/${workspaceId}/keyword-runs/${runId}`);
}

export function listKeywordResults(workspaceId: string, runId: string, opts: { search?: string; seedOnly?: boolean; limit?: number; offset?: number } = {}) {
  return api<{ results: SeoKeywordResult[]; total: number }>(`/api/seo/${workspaceId}/keyword-runs/${runId}/results${qs(opts as any)}`);
}

// ─── SEO Rank Tracking ──────────────────────────────────────────────────

export interface SeoRankTrackingLimits {
  planSlug: string | null;
  planName: string | null;
  limits: {
    seo_rank_tracking_max_keywords: number;
    seo_rank_tracking_check_frequency_hours: number;
    [key: string]: number;
  };
}

export interface SeoTrackedKeyword {
  id: string;
  keyword: string;
  device: 'desktop' | 'mobile';
  is_active: boolean;
  last_position: number | null;
  last_ranking_url: string | null;
  last_checked_at: string | null;
  next_check_at: string;
  created_at: string;
}

export interface SeoRankCheck {
  id: string;
  position: number | null;
  ranking_url: string | null;
  provider: string;
  checked_at: string;
}

export function getRankTrackingLimits(workspaceId: string) {
  return api<SeoRankTrackingLimits>(`/api/seo/${workspaceId}/rank-tracking/limits`);
}

export function listTrackedKeywords(workspaceId: string, siteId: string, opts: { limit?: number; offset?: number } = {}) {
  return api<{ keywords: SeoTrackedKeyword[]; total: number }>(`/api/seo/${workspaceId}/sites/${siteId}/tracked-keywords${qs(opts)}`);
}

export function addTrackedKeyword(workspaceId: string, siteId: string, keyword: string, device?: 'desktop' | 'mobile') {
  return api<{ keyword: SeoTrackedKeyword }>(`/api/seo/${workspaceId}/tracked-keywords`, {
    method: 'POST',
    body: JSON.stringify({ siteId, keyword, device }),
  });
}

export function removeTrackedKeyword(workspaceId: string, keywordId: string) {
  return api<{ ok: boolean }>(`/api/seo/${workspaceId}/tracked-keywords/${keywordId}`, { method: 'DELETE' });
}

export function listRankChecks(workspaceId: string, keywordId: string, opts: { limit?: number } = {}) {
  return api<{ checks: SeoRankCheck[] }>(`/api/seo/${workspaceId}/tracked-keywords/${keywordId}/checks${qs(opts)}`);
}

export interface SeoPerformanceLimits {
  planSlug: string | null;
  planName: string | null;
  limits: {
    seo_performance_max_pages_per_audit: number;
    seo_performance_audit_frequency_hours: number;
    [key: string]: number;
  };
}

export interface SeoPerformanceAudit {
  id: string;
  crawl_id: string;
  provider: string;
  max_pages: number;
  status: SeoJobStatus;
  progress: number;
  progress_stage: string | null;
  pages_audited: number | null;
  error_message: string | null;
  error_category: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface SeoPerformanceResult {
  id: string;
  url: string;
  status: 'pending' | 'completed' | 'unavailable';
  performance_score: number | null;
  accessibility_score: number | null;
  best_practices_score: number | null;
  seo_score: number | null;
  lcp_ms: number | null;
  cls: number | null;
  inp_ms: number | null;
  fcp_ms: number | null;
  tbt_ms: number | null;
}

export function getPerformanceLimits(workspaceId: string) {
  return api<SeoPerformanceLimits>(`/api/seo/${workspaceId}/performance/limits`);
}

export function getLatestPerformanceAudit(workspaceId: string, crawlId: string) {
  return api<{ audit: SeoPerformanceAudit | null }>(`/api/seo/${workspaceId}/crawls/${crawlId}/performance-audits/latest`);
}

export function startPerformanceAudit(workspaceId: string, crawlId: string) {
  return api<{ audit: SeoPerformanceAudit }>(`/api/seo/${workspaceId}/crawls/${crawlId}/performance-audits`, { method: 'POST' });
}

export function getPerformanceAudit(workspaceId: string, auditId: string) {
  return api<{ audit: SeoPerformanceAudit }>(`/api/seo/${workspaceId}/performance-audits/${auditId}`);
}

export function listPerformanceResults(workspaceId: string, auditId: string) {
  return api<{ results: SeoPerformanceResult[] }>(`/api/seo/${workspaceId}/performance-audits/${auditId}/results`);
}
