/**
 * Operational alerts for the active workspace.
 * Cheap by design: one server-computed request per minute, no realtime.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  dismissWorkspaceAlerts,
  fetchWorkspaceAlerts,
  type WorkspaceAlertsResponse,
} from '@/lib/workspace-alerts-api';

export function useWorkspaceAlerts(workspaceId: string | undefined) {
  return useQuery<WorkspaceAlertsResponse>({
    queryKey: ['workspace-alerts', workspaceId],
    queryFn: () => fetchWorkspaceAlerts(workspaceId!),
    enabled: !!workspaceId,
    refetchInterval: 60_000,
    staleTime: 45_000,
    retry: 1,
  });
}

/** Marks one alert (or every dismissible alert) as read for the current user. */
export function useDismissWorkspaceAlerts(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { alertId?: string; all?: boolean }) =>
      dismissWorkspaceAlerts(workspaceId!, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspace-alerts', workspaceId] });
    },
  });
}