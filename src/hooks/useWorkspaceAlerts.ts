/**
 * Operational alerts for the active workspace.
 * Cheap by design: one server-computed request per minute, no realtime.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchWorkspaceAlerts, type WorkspaceAlertsResponse } from '@/lib/workspace-alerts-api';

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