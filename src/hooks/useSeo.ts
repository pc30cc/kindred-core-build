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
