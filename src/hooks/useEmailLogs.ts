import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';

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

export function useEmailLogs(options?: { limit?: number; status?: string }) {
  const workspace = useCurrentWorkspace();

  return useQuery({
    queryKey: ['email-logs', workspace?.id, options],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(options?.limit || 50) });
      if (options?.status) params.set('status', options.status);
      const { logs } = await integrationsFetch<{ logs: any[] }>(
        `/api/workspace-integrations/${workspace!.id}/email-logs?${params}`,
      );
      return logs;
    },
    enabled: !!workspace?.id,
  });
}
