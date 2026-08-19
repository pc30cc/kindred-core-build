import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';
import type { WidgetSettings } from '@/types/models';

export function useWidgetSettings(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['widget-settings', workspaceId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/widget-settings/${workspaceId}`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Load failed: ${res.status}`);
      return json.settings as WidgetSettings;
    },
    enabled: !!workspaceId,
  });
}

export function useUpdateWidgetSettings(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (updates: Partial<WidgetSettings>) => {
      const res = await fetch(`${API_BASE}/api/widget-settings/${workspaceId}`, {
        credentials: 'include',
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Update failed: ${res.status}`);
      return json.settings as WidgetSettings;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['widget-settings', workspaceId] }),
  });
}
