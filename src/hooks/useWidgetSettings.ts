import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { WidgetSettings } from '@/types/models';

export function useWidgetSettings(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['widget-settings', workspaceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('widget_settings')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .single();
      if (error) throw error;
      return data as WidgetSettings;
    },
    enabled: !!workspaceId,
  });
}

export function useUpdateWidgetSettings(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (updates: Partial<WidgetSettings>) => {
      const { data, error } = await supabase
        .from('widget_settings')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId!)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['widget-settings', workspaceId] }),
  });
}
