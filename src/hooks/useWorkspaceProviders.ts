import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export type WsProviderType = 'email' | 'ai' | 'webhook';

export interface WsProviderSetting {
  id: string;
  workspace_id: string;
  provider_type: WsProviderType;
  provider_name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

function queryKey(workspaceId: string) {
  return ['workspace-provider-settings', workspaceId];
}

export function useWorkspaceProviders(workspaceId: string | undefined) {
  return useQuery({
    queryKey: queryKey(workspaceId!),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspace_provider_settings')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .order('provider_type');
      if (error) throw error;
      return data as WsProviderSetting[];
    },
    enabled: !!workspaceId,
  });
}

export function useUpsertWsProvider(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      provider_type: WsProviderType;
      provider_name: string;
      enabled: boolean;
      config: Record<string, unknown>;
      secrets: Record<string, unknown>;
    }) => {
      const { data, error } = await supabase
        .from('workspace_provider_settings')
        .upsert(
          {
            workspace_id: workspaceId!,
            ...payload,
          },
          { onConflict: 'workspace_id,provider_type' }
        )
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKey(workspaceId!) }),
  });
}

export function useDeleteWsProvider(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (providerType: WsProviderType) => {
      const { error } = await supabase
        .from('workspace_provider_settings')
        .delete()
        .eq('workspace_id', workspaceId!)
        .eq('provider_type', providerType);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKey(workspaceId!) }),
  });
}

/** Mask a secret value — show first 4 chars then ••• */
export function maskSecret(val: unknown): string {
  if (!val || typeof val !== 'string') return '';
  if (val.length <= 4) return '••••••••';
  return val.substring(0, 4) + '••••••••';
}

/** Get status for a provider type */
export function getProviderStatus(
  settings: WsProviderSetting[] | undefined,
  type: WsProviderType
): 'workspace' | 'platform' | 'none' {
  const setting = settings?.find((s) => s.provider_type === type);
  if (setting?.enabled && setting.provider_name !== 'disabled') return 'workspace';
  // We can't know from frontend if platform has config; show 'platform' as fallback
  return 'platform';
}
