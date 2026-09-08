/**
 * React Query hooks for Web Analytics. Mirrors useSeo.ts's shape.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getWebAnalyticsLimits, getOverview, getTrafficSources, getGeography, getBrowsersSystems,
  getPages, getClonedPages, getSiteStructure, getPossible404s,
  getTrackedEvents, getEventPropertyKeys, getEventPropertyBreakdown,
  listFunnels, createFunnel, deleteFunnel, getFunnelResults,
  type DateRangeParams, type TrafficSourceDimension, type GeographyDimension, type BrowsersSystemsDimension, type PagesKind,
  type FunnelStep,
} from '@/lib/webAnalytics-api';

export function useWebAnalyticsLimits(workspaceId?: string) {
  return useQuery({
    queryKey: ['web-analytics-limits', workspaceId],
    queryFn: () => getWebAnalyticsLimits(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useWebAnalyticsOverview(workspaceId: string | undefined, range: DateRangeParams) {
  return useQuery({
    queryKey: ['web-analytics-overview', workspaceId, range.startDate, range.endDate],
    queryFn: () => getOverview(workspaceId!, range),
    enabled: !!workspaceId,
  });
}

export function useWebAnalyticsTrafficSources(workspaceId: string | undefined, dimension: TrafficSourceDimension, range: DateRangeParams) {
  return useQuery({
    queryKey: ['web-analytics-traffic-sources', workspaceId, dimension, range.startDate, range.endDate],
    queryFn: () => getTrafficSources(workspaceId!, dimension, range),
    enabled: !!workspaceId,
  });
}

export function useWebAnalyticsGeography(workspaceId: string | undefined, dimension: GeographyDimension, range: DateRangeParams) {
  return useQuery({
    queryKey: ['web-analytics-geography', workspaceId, dimension, range.startDate, range.endDate],
    queryFn: () => getGeography(workspaceId!, dimension, range),
    enabled: !!workspaceId,
  });
}

export function useWebAnalyticsBrowsersSystems(workspaceId: string | undefined, dimension: BrowsersSystemsDimension, range: DateRangeParams) {
  return useQuery({
    queryKey: ['web-analytics-browsers-systems', workspaceId, dimension, range.startDate, range.endDate],
    queryFn: () => getBrowsersSystems(workspaceId!, dimension, range),
    enabled: !!workspaceId,
  });
}

export function useWebAnalyticsPages(workspaceId: string | undefined, kind: PagesKind, range: DateRangeParams) {
  return useQuery({
    queryKey: ['web-analytics-pages', workspaceId, kind, range.startDate, range.endDate],
    queryFn: () => getPages(workspaceId!, kind, range),
    enabled: !!workspaceId,
  });
}

export function useWebAnalyticsClonedPages(workspaceId: string | undefined, range: DateRangeParams) {
  return useQuery({
    queryKey: ['web-analytics-cloned-pages', workspaceId, range.startDate, range.endDate],
    queryFn: () => getClonedPages(workspaceId!, range),
    enabled: !!workspaceId,
  });
}

export function useWebAnalyticsSiteStructure(workspaceId: string | undefined, range: DateRangeParams) {
  return useQuery({
    queryKey: ['web-analytics-site-structure', workspaceId, range.startDate, range.endDate],
    queryFn: () => getSiteStructure(workspaceId!, range),
    enabled: !!workspaceId,
  });
}

export function useWebAnalyticsPossible404s(workspaceId: string | undefined, range: DateRangeParams) {
  return useQuery({
    queryKey: ['web-analytics-possible-404', workspaceId, range.startDate, range.endDate],
    queryFn: () => getPossible404s(workspaceId!, range),
    enabled: !!workspaceId,
  });
}

export function useWebAnalyticsTrackedEvents(workspaceId: string | undefined, range: DateRangeParams) {
  return useQuery({
    queryKey: ['web-analytics-tracked-events', workspaceId, range.startDate, range.endDate],
    queryFn: () => getTrackedEvents(workspaceId!, range),
    enabled: !!workspaceId,
  });
}

export function useWebAnalyticsEventPropertyKeys(workspaceId: string | undefined, eventName: string | undefined, range: DateRangeParams) {
  return useQuery({
    queryKey: ['web-analytics-event-property-keys', workspaceId, eventName, range.startDate, range.endDate],
    queryFn: () => getEventPropertyKeys(workspaceId!, eventName!, range),
    enabled: !!workspaceId && !!eventName,
  });
}

export function useWebAnalyticsEventPropertyBreakdown(
  workspaceId: string | undefined, eventName: string | undefined, propertyKey: string | undefined, range: DateRangeParams,
) {
  return useQuery({
    queryKey: ['web-analytics-event-property-breakdown', workspaceId, eventName, propertyKey, range.startDate, range.endDate],
    queryFn: () => getEventPropertyBreakdown(workspaceId!, eventName!, propertyKey!, range),
    enabled: !!workspaceId && !!eventName && !!propertyKey,
  });
}

export function useFunnels(workspaceId?: string) {
  return useQuery({
    queryKey: ['web-analytics-funnels', workspaceId],
    queryFn: () => listFunnels(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useCreateFunnel(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, steps }: { name: string; steps: FunnelStep[] }) => createFunnel(workspaceId, name, steps),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['web-analytics-funnels', workspaceId] });
    },
  });
}

export function useDeleteFunnel(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (funnelId: string) => deleteFunnel(workspaceId, funnelId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['web-analytics-funnels', workspaceId] });
    },
  });
}

export function useFunnelResults(workspaceId: string | undefined, funnelId: string | undefined, range: DateRangeParams) {
  return useQuery({
    queryKey: ['web-analytics-funnel-results', workspaceId, funnelId, range.startDate, range.endDate],
    queryFn: () => getFunnelResults(workspaceId!, funnelId!, range),
    enabled: !!workspaceId && !!funnelId,
  });
}
