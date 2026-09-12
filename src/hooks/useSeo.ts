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
  getRankTrackingOverview, getRankTrackingLandscape, getRankTrackingCompetitors,
  getPerformanceLimits, getLatestPerformanceAudit, startPerformanceAudit, listPerformanceResults,
  type SeoPerformanceAudit,
  getGscLimits, getGscConnection, startGscOAuth, disconnectGsc, listGscProperties,
  listGscAvailableSites, linkGscProperty, unlinkGscProperty, setPrimaryGscProperty,
  queryGscSearchAnalytics, type SeoGscDimension,
  getExplorerLimits, getExplorerHistory,
  getLatestExplorerBacklinkScan, startExplorerBacklinkScan, listExplorerBacklinks,
  listExplorerReferringDomains, listExplorerTopPages,
  getLatestExplorerKeywordScan, startExplorerKeywordScan, listExplorerKeywords,
  getLatestExplorerCompetitorScan, startExplorerCompetitorScan, listExplorerCompetitors,
  type SeoExplorerBacklinkScan, type SeoExplorerKeywordScan, type SeoExplorerCompetitorScan,
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

export function useIssueAffectedUrls(
  workspaceId?: string,
  crawlId?: string,
  issueId?: string,
  opts: { limit?: number; offset?: number } = {},
) {
  return useQuery({
    queryKey: ['seo-issue-pages', workspaceId, crawlId, issueId, opts],
    queryFn: () => listIssueAffectedUrls(workspaceId!, crawlId!, issueId!, opts),
    enabled: !!workspaceId && !!crawlId && !!issueId,
    placeholderData: (prev) => prev,
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

export function useRankTrackingOverview(workspaceId?: string, siteId?: string) {
  return useQuery({
    queryKey: ['seo-rank-tracking-overview', workspaceId, siteId],
    queryFn: () => getRankTrackingOverview(workspaceId!, siteId!),
    enabled: !!workspaceId && !!siteId,
  });
}

export function useRankTrackingLandscape(workspaceId?: string, siteId?: string, days?: number) {
  return useQuery({
    queryKey: ['seo-rank-tracking-landscape', workspaceId, siteId, days],
    queryFn: () => getRankTrackingLandscape(workspaceId!, siteId!, { days }),
    enabled: !!workspaceId && !!siteId,
  });
}

export function useRankTrackingCompetitors(workspaceId?: string, siteId?: string) {
  return useQuery({
    queryKey: ['seo-rank-tracking-competitors', workspaceId, siteId],
    queryFn: () => getRankTrackingCompetitors(workspaceId!, siteId!),
    enabled: !!workspaceId && !!siteId,
  });
}

// ─── SEO Performance Auditing ────────────────────────────────────────────

export function usePerformanceLimits(workspaceId?: string) {
  return useQuery({
    queryKey: ['seo-performance-limits', workspaceId],
    queryFn: () => getPerformanceLimits(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useLatestPerformanceAudit(workspaceId?: string, crawlId?: string) {
  return useQuery({
    queryKey: ['seo-latest-performance-audit', workspaceId, crawlId],
    queryFn: () => getLatestPerformanceAudit(workspaceId!, crawlId!),
    enabled: !!workspaceId && !!crawlId,
    refetchInterval: (q) => {
      const data = q.state.data as { audit: SeoPerformanceAudit | null } | undefined;
      if (!data?.audit) return false;
      return TERMINAL_SEO_STATUSES.has(data.audit.status) ? false : 4000;
    },
  });
}

export function useStartPerformanceAudit(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (crawlId: string) => startPerformanceAudit(workspaceId, crawlId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['seo-latest-performance-audit', workspaceId] });
    },
  });
}

export function usePerformanceResults(workspaceId?: string, auditId?: string) {
  return useQuery({
    queryKey: ['seo-performance-results', workspaceId, auditId],
    queryFn: () => listPerformanceResults(workspaceId!, auditId!),
    enabled: !!workspaceId && !!auditId,
  });
}

// ─── SEO GSC Insights ─────────────────────────────────────────────────────

export function useGscLimits(workspaceId?: string) {
  return useQuery({
    queryKey: ['seo-gsc-limits', workspaceId],
    queryFn: () => getGscLimits(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useGscConnection(workspaceId?: string) {
  return useQuery({
    queryKey: ['seo-gsc-connection', workspaceId],
    queryFn: () => getGscConnection(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useStartGscOAuth(workspaceId: string) {
  return useMutation({
    mutationFn: () => startGscOAuth(workspaceId),
  });
}

export function useDisconnectGsc(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => disconnectGsc(workspaceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['seo-gsc-connection', workspaceId] });
      qc.invalidateQueries({ queryKey: ['seo-gsc-properties', workspaceId] });
    },
  });
}

export function useGscProperties(workspaceId?: string) {
  return useQuery({
    queryKey: ['seo-gsc-properties', workspaceId],
    queryFn: () => listGscProperties(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useGscAvailableSites(workspaceId?: string, enabled = true) {
  return useQuery({
    queryKey: ['seo-gsc-available-sites', workspaceId],
    queryFn: () => listGscAvailableSites(workspaceId!),
    enabled: !!workspaceId && enabled,
  });
}

export function useLinkGscProperty(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ siteUrl, websiteId }: { siteUrl: string; websiteId?: string }) => linkGscProperty(workspaceId, siteUrl, websiteId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['seo-gsc-properties', workspaceId] });
    },
  });
}

export function useUnlinkGscProperty(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (propertyId: string) => unlinkGscProperty(workspaceId, propertyId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['seo-gsc-properties', workspaceId] });
    },
  });
}

export function useSetPrimaryGscProperty(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (propertyId: string) => setPrimaryGscProperty(workspaceId, propertyId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['seo-gsc-properties', workspaceId] });
    },
  });
}

// ─── SEO Site Explorer ─────────────────────────────────────────────────────

export function useExplorerLimits(workspaceId?: string) {
  return useQuery({
    queryKey: ['seo-explorer-limits', workspaceId],
    queryFn: () => getExplorerLimits(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useExplorerHistory(workspaceId?: string) {
  return useQuery({
    queryKey: ['seo-explorer-history', workspaceId],
    queryFn: () => getExplorerHistory(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useLatestExplorerBacklinkScan(workspaceId?: string, domain?: string) {
  return useQuery({
    queryKey: ['seo-explorer-latest-backlink-scan', workspaceId, domain],
    queryFn: () => getLatestExplorerBacklinkScan(workspaceId!, domain!),
    enabled: !!workspaceId && !!domain,
    refetchInterval: (q) => {
      const data = q.state.data as { scan: SeoExplorerBacklinkScan | null } | undefined;
      if (!data?.scan) return false;
      return TERMINAL_SEO_STATUSES.has(data.scan.status) ? false : 4000;
    },
  });
}

export function useStartExplorerBacklinkScan(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) => startExplorerBacklinkScan(workspaceId, domain),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['seo-explorer-latest-backlink-scan', workspaceId] });
      qc.invalidateQueries({ queryKey: ['seo-explorer-history', workspaceId] });
    },
  });
}

export function useExplorerBacklinks(workspaceId?: string, scanId?: string, opts: { limit?: number; offset?: number } = {}) {
  return useQuery({
    queryKey: ['seo-explorer-backlinks', workspaceId, scanId, opts.limit, opts.offset],
    queryFn: () => listExplorerBacklinks(workspaceId!, scanId!, opts),
    enabled: !!workspaceId && !!scanId,
  });
}

export function useExplorerReferringDomains(workspaceId?: string, scanId?: string, opts: { limit?: number; offset?: number } = {}) {
  return useQuery({
    queryKey: ['seo-explorer-referring-domains', workspaceId, scanId, opts.limit, opts.offset],
    queryFn: () => listExplorerReferringDomains(workspaceId!, scanId!, opts),
    enabled: !!workspaceId && !!scanId,
  });
}

export function useExplorerTopPages(workspaceId?: string, scanId?: string, opts: { limit?: number; offset?: number } = {}) {
  return useQuery({
    queryKey: ['seo-explorer-top-pages', workspaceId, scanId, opts.limit, opts.offset],
    queryFn: () => listExplorerTopPages(workspaceId!, scanId!, opts),
    enabled: !!workspaceId && !!scanId,
  });
}

export function useLatestExplorerKeywordScan(workspaceId?: string, domain?: string) {
  return useQuery({
    queryKey: ['seo-explorer-latest-keyword-scan', workspaceId, domain],
    queryFn: () => getLatestExplorerKeywordScan(workspaceId!, domain!),
    enabled: !!workspaceId && !!domain,
    refetchInterval: (q) => {
      const data = q.state.data as { scan: SeoExplorerKeywordScan | null } | undefined;
      if (!data?.scan) return false;
      return TERMINAL_SEO_STATUSES.has(data.scan.status) ? false : 4000;
    },
  });
}

export function useStartExplorerKeywordScan(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) => startExplorerKeywordScan(workspaceId, domain),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['seo-explorer-latest-keyword-scan', workspaceId] });
      qc.invalidateQueries({ queryKey: ['seo-explorer-history', workspaceId] });
    },
  });
}

export function useExplorerKeywords(workspaceId?: string, scanId?: string, opts: { limit?: number; offset?: number } = {}) {
  return useQuery({
    queryKey: ['seo-explorer-keywords', workspaceId, scanId, opts.limit, opts.offset],
    queryFn: () => listExplorerKeywords(workspaceId!, scanId!, opts),
    enabled: !!workspaceId && !!scanId,
  });
}

export function useLatestExplorerCompetitorScan(workspaceId?: string, domain?: string) {
  return useQuery({
    queryKey: ['seo-explorer-latest-competitor-scan', workspaceId, domain],
    queryFn: () => getLatestExplorerCompetitorScan(workspaceId!, domain!),
    enabled: !!workspaceId && !!domain,
    refetchInterval: (q) => {
      const data = q.state.data as { scan: SeoExplorerCompetitorScan | null } | undefined;
      if (!data?.scan) return false;
      return TERMINAL_SEO_STATUSES.has(data.scan.status) ? false : 4000;
    },
  });
}

export function useStartExplorerCompetitorScan(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) => startExplorerCompetitorScan(workspaceId, domain),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['seo-explorer-latest-competitor-scan', workspaceId] });
      qc.invalidateQueries({ queryKey: ['seo-explorer-history', workspaceId] });
    },
  });
}

export function useExplorerCompetitors(workspaceId?: string, scanId?: string, opts: { limit?: number; offset?: number } = {}) {
  return useQuery({
    queryKey: ['seo-explorer-competitors', workspaceId, scanId, opts.limit, opts.offset],
    queryFn: () => listExplorerCompetitors(workspaceId!, scanId!, opts),
    enabled: !!workspaceId && !!scanId,
  });
}

export function useGscSearchAnalytics(
  workspaceId: string | undefined,
  propertyId: string | undefined,
  params: { startDate: string; endDate: string; dimensions: SeoGscDimension[]; rowLimit?: number },
) {
  return useQuery({
    queryKey: ['seo-gsc-search-analytics', workspaceId, propertyId, params.startDate, params.endDate, params.dimensions.join(','), params.rowLimit],
    queryFn: () => queryGscSearchAnalytics(workspaceId!, propertyId!, params),
    enabled: !!workspaceId && !!propertyId,
  });
}
