import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

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
      let query = supabase
        .from('ai_usage_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (workspaceId) {
        query = query.eq('workspace_id', workspaceId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as AIUsageLog[];
    },
    enabled: !!workspaceId || true, // Admin can view all
  });
}

export function useAIUsageStats(workspaceId?: string) {
  return useQuery({
    queryKey: ['ai-usage-stats', workspaceId],
    queryFn: async () => {
      let query = supabase
        .from('ai_usage_logs')
        .select('*')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

      if (workspaceId) {
        query = query.eq('workspace_id', workspaceId);
      }

      const { data, error } = await query;
      if (error) throw error;

      const logs = data || [];
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
      let query = supabase
        .from('storage_usage_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (workspaceId) {
        query = query.eq('workspace_id', workspaceId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as StorageUsageLog[];
    },
  });
}
