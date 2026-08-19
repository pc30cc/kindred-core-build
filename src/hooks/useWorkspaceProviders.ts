import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';

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

async function integrationsFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body as T;
}

function queryKey(workspaceId: string) {
  return ['workspace-provider-settings', workspaceId];
}

export function useWorkspaceProviders(workspaceId: string | undefined) {
  return useQuery({
    queryKey: queryKey(workspaceId!),
    queryFn: async () => {
      const { settings } = await integrationsFetch<{ settings: WsProviderSetting[] }>(
        `/api/workspace-integrations/${workspaceId}/providers`,
      );
      return settings;
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
      const { setting } = await integrationsFetch<{ setting: WsProviderSetting }>(
        `/api/workspace-integrations/${workspaceId}/providers`,
        { method: 'PUT', body: JSON.stringify(payload) },
      );
      return setting;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKey(workspaceId!) }),
  });
}

export function useDeleteWsProvider(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (providerType: WsProviderType) => {
      await integrationsFetch(
        `/api/workspace-integrations/${workspaceId}/providers/${providerType}`,
        { method: 'DELETE' },
      );
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
