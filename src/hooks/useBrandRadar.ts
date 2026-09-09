/**
 * React Query hooks for Brand Radar. Mirrors useWebAnalytics.ts/useBotAnalytics.ts's shape.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getBrandRadarLimits, getSettings, saveSettings, listTopics, createTopic, deleteTopic,
  getAiVisibility, getAiVisibilityHistory, runAiVisibility,
  getWebVisibility, runWebVisibility,
  getSearchDemand, getOverview, getCompetitors,
  type DateRangeParams,
} from '@/lib/brandRadar-api';

export function useBrandRadarLimits(workspaceId?: string) {
  return useQuery({
    queryKey: ['brand-radar-limits', workspaceId],
    queryFn: () => getBrandRadarLimits(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useBrandRadarSettings(workspaceId?: string) {
  return useQuery({
    queryKey: ['brand-radar-settings', workspaceId],
    queryFn: () => getSettings(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useSaveBrandRadarSettings(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { brandName: string; competitorNames: string[]; siteId: string | null }) => saveSettings(workspaceId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['brand-radar-settings', workspaceId] });
      qc.invalidateQueries({ queryKey: ['brand-radar-overview', workspaceId] });
      qc.invalidateQueries({ queryKey: ['brand-radar-competitors', workspaceId] });
    },
  });
}

export function useBrandRadarTopics(workspaceId?: string) {
  return useQuery({
    queryKey: ['brand-radar-topics', workspaceId],
    queryFn: () => listTopics(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useCreateTopic(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ label, prompt }: { label: string; prompt: string }) => createTopic(workspaceId, label, prompt),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['brand-radar-topics', workspaceId] }),
  });
}

export function useDeleteTopic(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (topicId: string) => deleteTopic(workspaceId, topicId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['brand-radar-topics', workspaceId] }),
  });
}

function invalidateAll(qc: ReturnType<typeof useQueryClient>, workspaceId: string) {
  qc.invalidateQueries({ queryKey: ['brand-radar-ai-visibility', workspaceId] });
  qc.invalidateQueries({ queryKey: ['brand-radar-web-visibility', workspaceId] });
  qc.invalidateQueries({ queryKey: ['brand-radar-overview', workspaceId] });
  qc.invalidateQueries({ queryKey: ['brand-radar-competitors', workspaceId] });
}

export function useAiVisibility(workspaceId?: string) {
  return useQuery({
    queryKey: ['brand-radar-ai-visibility', workspaceId],
    queryFn: () => getAiVisibility(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useAiVisibilityHistory(workspaceId: string | undefined, topicId?: string) {
  return useQuery({
    queryKey: ['brand-radar-ai-visibility-history', workspaceId, topicId],
    queryFn: () => getAiVisibilityHistory(workspaceId!, topicId),
    enabled: !!workspaceId,
  });
}

export function useRunAiVisibility(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => runAiVisibility(workspaceId),
    onSuccess: () => invalidateAll(qc, workspaceId),
  });
}

export function useWebVisibility(workspaceId?: string) {
  return useQuery({
    queryKey: ['brand-radar-web-visibility', workspaceId],
    queryFn: () => getWebVisibility(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useRunWebVisibility(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => runWebVisibility(workspaceId),
    onSuccess: () => invalidateAll(qc, workspaceId),
  });
}

export function useSearchDemand(workspaceId: string | undefined, range: DateRangeParams) {
  return useQuery({
    queryKey: ['brand-radar-search-demand', workspaceId, range.startDate, range.endDate],
    queryFn: () => getSearchDemand(workspaceId!, range),
    enabled: !!workspaceId,
  });
}

export function useBrandRadarOverview(workspaceId: string | undefined, range: DateRangeParams) {
  return useQuery({
    queryKey: ['brand-radar-overview', workspaceId, range.startDate, range.endDate],
    queryFn: () => getOverview(workspaceId!, range),
    enabled: !!workspaceId,
  });
}

export function useBrandRadarCompetitors(workspaceId: string | undefined, range: DateRangeParams) {
  return useQuery({
    queryKey: ['brand-radar-competitors', workspaceId, range.startDate, range.endDate],
    queryFn: () => getCompetitors(workspaceId!, range),
    enabled: !!workspaceId,
  });
}
