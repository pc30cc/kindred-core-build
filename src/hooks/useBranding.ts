import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceBranding } from '@/types/models';

export function useBranding(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['branding', workspaceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspace_branding')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .single();
      if (error) throw error;
      return data as WorkspaceBranding;
    },
    enabled: !!workspaceId,
  });
}

export function useUpdateBranding(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (updates: Partial<WorkspaceBranding>) => {
      const { data, error } = await supabase
        .from('workspace_branding')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId!)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['branding', workspaceId] }),
  });
}
