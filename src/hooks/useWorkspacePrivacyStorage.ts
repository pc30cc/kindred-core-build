/**
 * Workspace-level privacy export storage override.
 *
 * Reads/writes provider_configs rows where provider_type = 'privacy_export_storage'.
 * RLS: only workspace owner/admin can manage these (existing policy).
 *
 * The shape of `config` mirrors the platform-level policy in
 * app_runtime_config['privacy_export_storage'].config, so the backend
 * resolver (server/services/privacy/storageResolver.ts → mapDBConfigToStorage)
 * can consume both without branching.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type PrivacyStorageProvider =
  | 'local' | 's3' | 'cloudflare_r2' | 'minio' | 'do_spaces' | 'bunny_storage';

export interface WsPrivacyStorageRow {
  id: string;
  workspace_id: string;
  provider_name: PrivacyStorageProvider;
  is_active: boolean;
  config: Record<string, string | undefined>;
  created_at: string;
  updated_at: string;
}

const PT = 'privacy_export_storage';

function key(workspaceId: string) {
  return ['workspace-privacy-storage', workspaceId];
}

export function useWorkspacePrivacyStorage(workspaceId: string | undefined) {
  return useQuery({
    queryKey: key(workspaceId || 'none'),
    queryFn: async (): Promise<WsPrivacyStorageRow | null> => {
      const { data, error } = await supabase
        .from('provider_configs')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .eq('provider_type', PT)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as WsPrivacyStorageRow) || null;
    },
    enabled: !!workspaceId,
  });
}

export function useUpsertWorkspacePrivacyStorage(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      provider_name: PrivacyStorageProvider;
      config: Record<string, string | undefined>;
    }) => {
      // Deactivate previous overrides, then insert a fresh active row.
      // We don't UPDATE in place because provider_configs is a generic
      // table that does not enforce one-row-per-(workspace,type).
      await supabase
        .from('provider_configs')
        .update({ is_active: false })
        .eq('workspace_id', workspaceId!)
        .eq('provider_type', PT);

      const { data, error } = await supabase
        .from('provider_configs')
        .insert({
          workspace_id: workspaceId!,
          provider_type: PT,
          provider_name: input.provider_name,
          is_active: true,
          config: input.config as any,
        })
        .select('*')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key(workspaceId || 'none') }),
  });
}

export function useClearWorkspacePrivacyStorage(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('provider_configs')
        .delete()
        .eq('workspace_id', workspaceId!)
        .eq('provider_type', PT);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key(workspaceId || 'none') }),
  });
}
