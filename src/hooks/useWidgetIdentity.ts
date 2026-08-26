/**
 * Widget Identity Hook (panel-side)
 *
 * Fetches the per-workspace pre-chat policy and lets admins update it.
 * The actual visitor identity flow runs inside the embedded widget runtime
 * (public/widget/runtime.js) and uses the HttpOnly `dvsid` cookie issued by
 * the backend — NOT localStorage.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';

export interface WidgetPrechatSettings {
  workspace_id: string;
  ask_name: boolean;
  ask_email: boolean;
  ask_phone: boolean;
  require_name: boolean;
  require_email: boolean;
  require_phone: boolean;
  verify_email: boolean;
  verify_phone: boolean;
  history_continue_window_hours: number;
}

export function useWidgetPrechatSettings(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['widget-prechat-settings', workspaceId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/widget-settings/${workspaceId}/prechat`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Load failed: ${res.status}`);
      return json.settings as WidgetPrechatSettings | null;
    },
    enabled: !!workspaceId,
  });
}

export function useUpdateWidgetPrechatSettings(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (updates: Partial<WidgetPrechatSettings>) => {
      const res = await fetch(`${API_BASE}/api/widget-settings/${workspaceId}/prechat`, {
        credentials: 'include',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Update failed: ${res.status}`);
      return json.settings;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['widget-prechat-settings', workspaceId] }),
  });
}
