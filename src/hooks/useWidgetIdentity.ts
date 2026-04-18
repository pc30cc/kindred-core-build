/**
 * Widget Identity Hook (panel-side)
 * 
 * Fetches the per-workspace pre-chat policy and lets admins update it.
 * The actual visitor identity flow runs inside the embedded widget runtime
 * (public/widget/runtime.js) and uses the HttpOnly `dvsid` cookie issued by
 * the backend — NOT localStorage.
 */

import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

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
      const { data, error } = await supabase
        .from('widget_prechat_settings')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .maybeSingle();
      if (error) throw error;
      return data as WidgetPrechatSettings | null;
    },
    enabled: !!workspaceId,
  });
}

export function useUpdateWidgetPrechatSettings(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (updates: Partial<WidgetPrechatSettings>) => {
      const { data, error } = await supabase
        .from('widget_prechat_settings')
        .upsert({ workspace_id: workspaceId!, ...updates } as any, { onConflict: 'workspace_id' })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['widget-prechat-settings', workspaceId] }),
  });
}
