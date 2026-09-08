/**
 * React Query hooks for Bot Analytics. Mirrors useWebAnalytics.ts's shape.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getBotAnalyticsLimits, getBotOverview, getBotCategories, getCrawledPages, getAiBots,
  listBotImports, uploadBotLog, deleteBotImport,
  type DateRangeParams,
} from '@/lib/botAnalytics-api';

export function useBotAnalyticsLimits(workspaceId?: string) {
  return useQuery({
    queryKey: ['bot-analytics-limits', workspaceId],
    queryFn: () => getBotAnalyticsLimits(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useBotOverview(workspaceId: string | undefined, range: DateRangeParams) {
  return useQuery({
    queryKey: ['bot-analytics-overview', workspaceId, range.startDate, range.endDate],
    queryFn: () => getBotOverview(workspaceId!, range),
    enabled: !!workspaceId,
  });
}

export function useBotCategories(workspaceId: string | undefined, range: DateRangeParams) {
  return useQuery({
    queryKey: ['bot-analytics-categories', workspaceId, range.startDate, range.endDate],
    queryFn: () => getBotCategories(workspaceId!, range),
    enabled: !!workspaceId,
  });
}

export function useCrawledPages(workspaceId: string | undefined, range: DateRangeParams) {
  return useQuery({
    queryKey: ['bot-analytics-crawled-pages', workspaceId, range.startDate, range.endDate],
    queryFn: () => getCrawledPages(workspaceId!, range),
    enabled: !!workspaceId,
  });
}

export function useAiBots(workspaceId: string | undefined, range: DateRangeParams) {
  return useQuery({
    queryKey: ['bot-analytics-ai-bots', workspaceId, range.startDate, range.endDate],
    queryFn: () => getAiBots(workspaceId!, range),
    enabled: !!workspaceId,
  });
}

export function useBotImports(workspaceId?: string) {
  return useQuery({
    queryKey: ['bot-analytics-imports', workspaceId],
    queryFn: () => listBotImports(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useUploadBotLog(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ filename, base64Data }: { filename: string; base64Data: string }) => uploadBotLog(workspaceId, filename, base64Data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bot-analytics-imports', workspaceId] });
      qc.invalidateQueries({ queryKey: ['bot-analytics-overview', workspaceId] });
      qc.invalidateQueries({ queryKey: ['bot-analytics-categories', workspaceId] });
      qc.invalidateQueries({ queryKey: ['bot-analytics-crawled-pages', workspaceId] });
      qc.invalidateQueries({ queryKey: ['bot-analytics-ai-bots', workspaceId] });
    },
  });
}

export function useDeleteBotImport(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (importId: string) => deleteBotImport(workspaceId, importId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bot-analytics-imports', workspaceId] });
      qc.invalidateQueries({ queryKey: ['bot-analytics-overview', workspaceId] });
      qc.invalidateQueries({ queryKey: ['bot-analytics-categories', workspaceId] });
      qc.invalidateQueries({ queryKey: ['bot-analytics-crawled-pages', workspaceId] });
      qc.invalidateQueries({ queryKey: ['bot-analytics-ai-bots', workspaceId] });
    },
  });
}
