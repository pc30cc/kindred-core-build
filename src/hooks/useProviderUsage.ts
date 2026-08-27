import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '@/lib/apiBase';

/**
 * Usage reads go through workspace-scoped first-party endpoints
 * (`/api/workspaces/:id/usage/*`). The browser never queries
 * `ai_usage_logs`/`storage_usage_logs` directly: workspace isolation is
 * enforced server-side from the `gs_session` principal.
 */
async function usageFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any).error || `Request failed: ${res.status}`);
  return body as T;
}

export interface AIUsageLog {
  id: string;
  workspace_id: string;
  provider_name: string;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  success: boolean;
  error_message: string | null;
  latency_ms: number | null;
  endpoint: string | null;
  created_at: string;
}

export function useAIUsageLogs(workspaceId?: string, limit = 50) {
  return useQuery({
    queryKey: ['ai-usage-logs', workspaceId, limit],
    queryFn: async () => {
      const body = await usageFetch<{ logs: AIUsageLog[] }>(
        `/api/workspaces/${workspaceId}/usage/ai?limit=${limit}`,
      );
      return body.logs;
    },
    enabled: !!workspaceId,
  });
}

export function useAIUsageStats(workspaceId?: string) {
  return useQuery({
    queryKey: ['ai-usage-stats', workspaceId],
    queryFn: async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const body = await usageFetch<{ logs: AIUsageLog[] }>(
        `/api/workspaces/${workspaceId}/usage/ai?limit=500&since=${encodeURIComponent(since)}`,
      );
      const logs = body.logs || [];
      return {
        totalRequests: logs.length,
        successfulRequests: logs.filter(l => l.success).length,
        failedRequests: logs.filter(l => !l.success).length,
        totalTokens: logs.reduce((sum, l) => sum + (l.total_tokens || 0), 0),
        avgLatencyMs: logs.length > 0
          ? Math.round(logs.reduce((sum, l) => sum + (l.latency_ms || 0), 0) / logs.length)
          : 0,
        byProvider: logs.reduce((acc, l) => {
          acc[l.provider_name] = (acc[l.provider_name] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
      };
    },
    enabled: !!workspaceId,
    refetchInterval: 30_000,
  });
}

export interface StorageUsageLog {
  id: string;
  workspace_id: string;
  provider_name: string;
  operation: string;
  file_key: string | null;
  file_size: number | null;
  content_type: string | null;
  success: boolean;
  error_message: string | null;
  created_at: string;
}

export function useStorageUsageLogs(workspaceId?: string, limit = 50) {
  return useQuery({
    queryKey: ['storage-usage-logs', workspaceId, limit],
    queryFn: async () => {
      const body = await usageFetch<{ logs: StorageUsageLog[] }>(
        `/api/workspaces/${workspaceId}/usage/storage?limit=${limit}`,
      );
      return body.logs;
    },
    enabled: !!workspaceId,
  });
}
