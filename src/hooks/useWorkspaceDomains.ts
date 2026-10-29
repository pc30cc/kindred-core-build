import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';

/** A row of Settings → Domains (workspace_domains). */
export interface WorkspaceDomain {
  id: string;
  domain: string;
  verified: boolean;
  is_primary: boolean | null;
  /** The registered website (the account owner's, verified): never removed, keeps the primary flag. */
  fixed?: boolean;
}

/**
 * The workspace's domains (GET /api/workspaces/:id/domains). Settings →
 * Domains manages them; Widget → Domains lists the verified ones, which also
 * may show the widget while its own list names a site
 * (server/services/widget/public.ts getWorkspaceOriginRules).
 */
export function useWorkspaceDomains(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['domains', workspaceId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/workspaces/${workspaceId}/domains`, { credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed: ${res.status}`);
      return (json.domains || []) as WorkspaceDomain[];
    },
    enabled: !!workspaceId,
  });
}
