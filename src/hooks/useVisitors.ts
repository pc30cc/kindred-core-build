import { supabase } from '@/lib/supabase';
import { useQuery } from '@tanstack/react-query';
import type { VisitorSession, VisitorPresence } from '@/types/models';
import {
  fetchLiveVisitors,
  fetchVisitorMap,
  fetchVisitorMapConfig,
  fetchVisitorDetail,
  fetchVisitorPageHistory,
} from '@/lib/visitors-api';

/**
 * Resolve the live-refresh interval from the cached map config (which now
 * carries `presence.live_refresh_ms`). Falls back to a fast 5s default so
 * new visitors show up quickly even before the config loads.
 */
function useLiveRefreshMs(workspaceId: string | undefined): number {
  const cfg = useQuery({
    queryKey: ['visitor-intel-map-config', workspaceId],
    queryFn: () => fetchVisitorMapConfig(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
  return Math.max(2_000, cfg.data?.presence?.live_refresh_ms ?? 5_000);
}

export function useOnlineVisitors(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['online-visitors', workspaceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('visitor_presence')
        .select('*, visitor_sessions(*)')
        .eq('workspace_id', workspaceId!)
        .in('status', ['online', 'idle'])
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return data as (VisitorPresence & { visitor_sessions: VisitorSession })[];
    },
    enabled: !!workspaceId,
    refetchInterval: 10000, // Poll every 10s
  });
}

export function useVisitorSessions(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['visitor-sessions', workspaceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('visitor_sessions')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .order('last_seen_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as VisitorSession[];
    },
    enabled: !!workspaceId,
  });
}

/** Phase 1+2: provider-based visitor intelligence (live list). */
export function useLiveVisitors(workspaceId: string | undefined, includeOffline = false) {
  const refetchInterval = useLiveRefreshMs(workspaceId);
  return useQuery({
    queryKey: ['visitor-intel-live', workspaceId, includeOffline],
    queryFn: () => fetchLiveVisitors(workspaceId!, includeOffline),
    enabled: !!workspaceId,
    refetchInterval,
  });
}

/** Map markers (geo-resolved subset). */
export function useVisitorMap(workspaceId: string | undefined) {
  const refetchInterval = Math.max(5_000, useLiveRefreshMs(workspaceId) * 2);
  return useQuery({
    queryKey: ['visitor-intel-map', workspaceId],
    queryFn: () => fetchVisitorMap(workspaceId!),
    enabled: !!workspaceId,
    refetchInterval,
  });
}

/** Resolved map_tiles provider config (with no-map fallback signal). */
export function useVisitorMapConfig(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['visitor-intel-map-config', workspaceId],
    queryFn: () => fetchVisitorMapConfig(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
}

/** Detail for the visitor drawer. */
export function useVisitorDetail(workspaceId: string | undefined, sessionId: string | null) {
  return useQuery({
    queryKey: ['visitor-intel-detail', workspaceId, sessionId],
    queryFn: () => fetchVisitorDetail(workspaceId!, sessionId!),
    enabled: !!workspaceId && !!sessionId,
    refetchInterval: 15_000,
  });
}

/** Page-history timeline for the drawer. */
export function useVisitorPageHistory(
  workspaceId: string | undefined,
  sessionId: string | null,
) {
  return useQuery({
    queryKey: ['visitor-intel-page-history', workspaceId, sessionId],
    queryFn: () => fetchVisitorPageHistory(workspaceId!, sessionId!),
    enabled: !!workspaceId && !!sessionId,
    refetchInterval: 30_000,
  });
}
