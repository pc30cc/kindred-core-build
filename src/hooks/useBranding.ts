import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';
import type { WorkspaceBranding } from '@/types/models';

export function useBranding(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['branding', workspaceId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/workspaces/${workspaceId}/branding`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Load failed: ${res.status}`);
      return json.branding as WorkspaceBranding;
    },
    enabled: !!workspaceId,
  });
}

export function useUpdateBranding(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (updates: Partial<WorkspaceBranding>) => {
      const res = await fetch(`${API_BASE}/api/workspaces/${workspaceId}/branding`, {
        credentials: 'include',
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Update failed: ${res.status}`);
      return json.branding;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['branding', workspaceId] }),
  });
}
