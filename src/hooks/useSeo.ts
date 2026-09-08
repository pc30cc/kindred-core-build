/**
 * React Query hooks for the SEO / Website Audit feature. Crawl progress is
 * polled every 4s while the crawl is non-terminal (queued/running/processing),
 * mirroring usePrivacyJobs.ts's polling pattern, and stops automatically once
 * the crawl reaches a terminal state.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listSeoSites, getSeoLimits, getLatestCrawl, listCrawlHistory, startCrawl, getCrawl,
  cancelCrawl, listCrawlPages, listCrawlIssues, listIssueAffectedUrls, listCrawlLinks,
  listCrawlSitemaps, compareCrawl, TERMINAL_SEO_STATUSES, type SeoCrawl,
  getBacklinksLimits, getLatestBacklinkScan, listBacklinkScanHistory, startBacklinkScan,
  getBacklinkScan, cancelBacklinkScan, listBacklinks, type SeoBacklinkScan,
  getKeywordsLimits, getLatestKeywordRun, listKeywordRunHistory, startKeywordRun,
  getKeywordRun, listKeywordResults, type SeoKeywordRun,
  getRankTrackingLimits, listTrackedKeywords, addTrackedKeyword, removeTrackedKeyword, listRankChecks,
} from '@/lib/seo-api';

export function useSeoSites(workspaceId?: string) {
  return useQuery({
    queryKey: ['seo-sites', workspaceId],
    queryFn: () => listSeoSites(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useSeoLimits(workspaceId?: string) {
  return useQuery({
    queryKey: ['seo-limits', workspaceId],
    queryFn: () => getSeoLimits(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useLatestCrawl(workspaceId?: string, siteId?: string) {
  return useQuery({
    queryKey: ['seo-latest-crawl', workspaceId, siteId],
    queryFn: () => getLatestCrawl(workspaceId!, siteId!),
    enabled: !!workspaceId && !!siteId,
    refetchInterval: (q) => {
      const data = q.state.data as { crawl: SeoCrawl | null } | undefined;
      if (!data?.crawl) return false;
      return TERMINAL_SEO_STATUSES.has(data.crawl.status) ? false : 4000;
    },
  });
}

export function useCrawl(workspaceId?: string, crawlId?: string) {
  return useQuery({
    queryKey: ['seo-crawl', workspaceId, crawlId],
    queryFn: () => getCrawl(workspaceId!, crawlId!),
    enabled: !!workspaceId && !!crawlId,
    refetchInterval: (q) => {
      const data = q.state.data as { crawl: SeoCrawl } | undefined;
      if (!data?.crawl) return 4000;
      return TERMINAL_SEO_STATUSES.has(data.crawl.status) ? false : 4000;
    },
  });
}

export function useCrawlHistory(workspaceId?: string, siteId?: string, limit = 20, offset = 0) {
  return useQuery({
    queryKey: ['seo-crawl-history', workspaceId, siteId, limit, offset],
    queryFn: () => listCrawlHistory(workspaceId!, siteId!, { limit, offset }),
    enabled: !!workspaceId && !!siteId,
  });
}

export function useStartCrawl(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (siteId: string) => startCrawl(workspaceId, siteId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['seo-latest-crawl', workspaceId] });
      qc.invalidateQueries({ queryKey: ['seo-crawl-history', workspaceId] });
    },
  });
}

export function useCancelCrawl(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (crawlId: string) => cancelCrawl(workspaceId, crawlId),
    onSuccess: (_data, crawlId) => {
      qc.invalidateQueries({ queryKey: ['seo-crawl', workspaceId, crawlId] });
      qc.invalidateQueries({ queryKey: ['seo-latest-crawl', workspaceId] });
    },
  });
}

export function useCrawlPages(workspaceId?: string, crawlId?: string, filters: Parameters<typeof listCrawlPages>[2] = {}) {
  return useQuery({
    queryKey: ['seo-pages', workspaceId, crawlId, filters],
    queryFn: () => listCrawlPages(workspaceId!, crawlId!, filters),
    enabled: !!workspaceId && !!crawlId,
  });
}

export function useCrawlIssues(workspaceId?: string, crawlId?: string, filters: Parameters<typeof listCrawlIssues>[2] = {}) {
  return useQuery({
    queryKey: ['seo-issues', workspaceId, crawlId, filters],
    queryFn: () => listCrawlIssues(workspaceId!, crawlId!, filters),
    enabled: !!workspaceId && !!crawlId,
  });
}

export function useIssueAffectedUrls(workspaceId?: string, crawlId?: string, issueId?: string) {
  return useQuery({
    queryKey: ['seo-issue-pages', workspaceId, crawlId, issueId],
    queryFn: () => listIssueAffectedUrls(workspaceId!, crawlId!, issueId!),
    enabled: !!workspaceId && !!crawlId && !!issueId,
  });
}

export function useCrawlLinks(workspaceId?: string, crawlId?: string, filters: Parameters<typeof listCrawlLinks>[2] = {}) {
  return useQuery({
    queryKey: ['seo-links', workspaceId, crawlId, filters],
    queryFn: () => listCrawlLinks(workspaceId!, crawlId!, filters),
    enabled: !!workspaceId && !!crawlId,
  });
}

export function useCrawlSitemaps(workspaceId?: string, crawlId?: string) {
  return useQuery({
    queryKey: ['seo-sitemaps', workspaceId, crawlId],
    queryFn: () => listCrawlSitemaps(workspaceId!, crawlId!),
    enabled: !!workspaceId && !!crawlId,
  });
}

export function useCrawlComparison(workspaceId?: string, crawlId?: string) {
  return useQuery({
    queryKey: ['seo-compare', workspaceId, crawlId],
    queryFn: () => compareCrawl(workspaceId!, crawlId!),
    enabled: !!workspaceId && !!crawlId,
  });
}

// ─── SEO Backlinks ─────────────────────────────────────────────────────

export function useBacklinksLimits(workspaceId?: string) {
  return useQuery({
    queryKey: ['seo-backlinks-limits', workspaceId],
    queryFn: () => getBacklinksLimits(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useLatestBacklinkScan(workspaceId?: string, siteId?: string) {
  return useQuery({
    queryKey: ['seo-latest-backlink-scan', workspaceId, siteId],
    queryFn: () => getLatestBacklinkScan(workspaceId!, siteId!),
    enabled: !!workspaceId && !!siteId,
    refetchInterval: (q) => {
      const data = q.state.data as { scan: SeoBacklinkScan | null } | undefined;
      if (!data?.scan) return false;
      return TERMINAL_SEO_STATUSES.has(data.scan.status) ? false : 4000;
    },
  });
}

export function useBacklinkScan(workspaceId?: string, scanId?: string) {
  return useQuery({
    queryKey: ['seo-backlink-scan', workspaceId, scanId],
    queryFn: () => getBacklinkScan(workspaceId!, scanId!),
    enabled: !!workspaceId && !!scanId,
    refetchInterval: (q) => {
      const data = q.state.data as { scan: SeoBacklinkScan } | undefined;
      if (!data?.scan) return 4000;
      return TERMINAL_SEO_STATUSES.has(data.scan.status) ? false : 4000;
    },
  });
}

export function useBacklinkScanHistory(workspaceId?: string, siteId?: string, limit = 20, offset = 0) {
  return useQuery({
    queryKey: ['seo-backlink-scan-history', workspaceId, siteId, limit, offset],
    queryFn: () => listBacklinkScanHistory(workspaceId!, siteId!, { limit, offset }),
    enabled: !!workspaceId && !!siteId,
  });
}

export function useStartBacklinkScan(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (siteId: string) => startBacklinkScan(workspaceId, siteId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['seo-latest-backlink-scan', workspaceId] });
      qc.invalidateQueries({ queryKey: ['seo-backlink-scan-history', workspaceId] });
    },
  });
}

export function useCancelBacklinkScan(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scanId: string) => cancelBacklinkScan(workspaceId, scanId),
    onSuccess: (_data, scanId) => {
      qc.invalidateQueries({ queryKey: ['seo-backlink-scan', workspaceId, scanId] });
      qc.invalidateQueries({ queryKey: ['seo-latest-backlink-scan', workspaceId] });
    },
  });
}

export function useBacklinks(workspaceId?: string, scanId?: string, filters: Parameters<typeof listBacklinks>[2] = {}) {
  return useQuery({
    queryKey: ['seo-backlinks', workspaceId, scanId, filters],
    queryFn: () => listBacklinks(workspaceId!, scanId!, filters),
    enabled: !!workspaceId && !!scanId,
  });
}

// ─── SEO Keyword Research ─────────────────────────────────────────────

export function useKeywordsLimits(workspaceId?: string) {
  return useQuery({
    queryKey: ['seo-keywords-limits', workspaceId],
    queryFn: () => getKeywordsLimits(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useLatestKeywordRun(workspaceId?: string, siteId?: string) {
  return useQuery({
    queryKey: ['seo-latest-keyword-run', workspaceId, siteId],
    queryFn: () => getLatestKeywordRun(workspaceId!, siteId!),
    enabled: !!workspaceId && !!siteId,
    refetchInterval: (q) => {
      const data = q.state.data as { run: SeoKeywordRun | null } | undefined;
      if (!data?.run) return false;
      return TERMINAL_SEO_STATUSES.has(data.run.status) ? false : 4000;
    },
  });
}

export function useKeywordRunHistory(workspaceId?: string, siteId?: string, limit = 20, offset = 0) {
  return useQuery({
    queryKey: ['seo-keyword-run-history', workspaceId, siteId, limit, offset],
    queryFn: () => listKeywordRunHistory(workspaceId!, siteId!, { limit, offset }),
    enabled: !!workspaceId && !!siteId,
  });
}

export function useStartKeywordRun(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ siteId, seedKeywords }: { siteId: string; seedKeywords: string[] }) => startKeywordRun(workspaceId, siteId, seedKeywords),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['seo-latest-keyword-run', workspaceId] });
      qc.invalidateQueries({ queryKey: ['seo-keyword-run-history', workspaceId] });
    },
  });
}

export function useKeywordResults(workspaceId?: string, runId?: string, filters: Parameters<typeof listKeywordResults>[2] = {}) {
  return useQuery({
    queryKey: ['seo-keyword-results', workspaceId, runId, filters],
    queryFn: () => listKeywordResults(workspaceId!, runId!, filters),
    enabled: !!workspaceId && !!runId,
  });
}

// ─── SEO Rank Tracking ─────────────────────────────────────────────────

export function useRankTrackingLimits(workspaceId?: string) {
  return useQuery({
    queryKey: ['seo-rank-tracking-limits', workspaceId],
    queryFn: () => getRankTrackingLimits(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useTrackedKeywords(workspaceId?: string, siteId?: string) {
  return useQuery({
    queryKey: ['seo-tracked-keywords', workspaceId, siteId],
    queryFn: () => listTrackedKeywords(workspaceId!, siteId!),
    enabled: !!workspaceId && !!siteId,
  });
}

export function useAddTrackedKeyword(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ siteId, keyword, device }: { siteId: string; keyword: string; device?: 'desktop' | 'mobile' }) =>
      addTrackedKeyword(workspaceId, siteId, keyword, device),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['seo-tracked-keywords', workspaceId] });
    },
  });
}

export function useRemoveTrackedKeyword(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keywordId: string) => removeTrackedKeyword(workspaceId, keywordId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['seo-tracked-keywords', workspaceId] });
    },
  });
}

export function useRankChecks(workspaceId?: string, keywordId?: string) {
  return useQuery({
    queryKey: ['seo-rank-checks', workspaceId, keywordId],
    queryFn: () => listRankChecks(workspaceId!, keywordId!),
    enabled: !!workspaceId && !!keywordId,
  });
}
