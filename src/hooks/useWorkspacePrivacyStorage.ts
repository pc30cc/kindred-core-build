/**
 * Workspace-level privacy export storage override.
 *
 * Routed through server/routes/workspaceIntegrations.ts (owner/admin only,
 * matching the RLS policy the direct provider_configs access used to rely
 * on). The shape of `config` mirrors the platform-level policy in
 * app_runtime_config['privacy_export_storage'].config, so the backend
 * resolver (server/services/privacy/storageResolver.ts → mapDBConfigToStorage)
 * can consume both without branching.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';

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

function key(workspaceId: string) {
  return ['workspace-privacy-storage', workspaceId];
}

export function useWorkspacePrivacyStorage(workspaceId: string | undefined) {
  return useQuery({
    queryKey: key(workspaceId || 'none'),
    queryFn: async (): Promise<WsPrivacyStorageRow | null> => {
      const { storage } = await integrationsFetch<{ storage: WsPrivacyStorageRow | null }>(
        `/api/workspace-integrations/${workspaceId}/privacy-storage`,
      );
      return storage;
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
      const { storage } = await integrationsFetch<{ storage: WsPrivacyStorageRow }>(
        `/api/workspace-integrations/${workspaceId}/privacy-storage`,
        { method: 'PUT', body: JSON.stringify(input) },
      );
      return storage;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key(workspaceId || 'none') }),
  });
}

export function useClearWorkspacePrivacyStorage(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await integrationsFetch(
        `/api/workspace-integrations/${workspaceId}/privacy-storage`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key(workspaceId || 'none') }),
  });
}
