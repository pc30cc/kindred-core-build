import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';

export interface WorkspaceCapacity {
  used: number;
  limit: number | null;
  canCreate: boolean;
  plan: string | null;
}

/**
 * Account-level workspace capacity (plan entitlement `max_workspaces`).
 * Resolved server-side; the UI only mirrors it.
 */
export function useWorkspaceCapacity(enabled = true) {
  return useQuery<WorkspaceCapacity | null>({
    queryKey: ['workspace-capacity'],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/workspaces/capacity`, { credentials: 'include' });
      if (!res.ok) return null;
      return (await res.json()) as WorkspaceCapacity;
    },
  });
}
