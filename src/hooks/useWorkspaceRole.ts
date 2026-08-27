/**
 * Returns the current user's role within a workspace, or null if not a member.
 * Used by permission-aware UIs (e.g. canned responses settings).
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/AuthContext';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = RESOLVED_API_BASE;

export type WorkspaceRole = 'owner' | 'admin' | 'agent' | string;

// Backed by GET /api/workspaces/:workspaceId/role (gs_session cookie) —
// direct supabase.from('workspace_members') relied on RLS scoped to
// auth.uid(), which is NULL without a Supabase Auth session.
export function useWorkspaceRole(workspaceId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['workspace-role', workspaceId, user?.id],
    queryFn: async (): Promise<WorkspaceRole | null> => {
      const res = await fetch(`${API_BASE}/api/workspaces/${workspaceId}/role`, { credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `API error: ${res.status}`);
      }
      const { role } = await res.json();
      return (role as WorkspaceRole) ?? null;
    },
    enabled: !!workspaceId && !!user?.id,
    staleTime: 60_000,
  });
}

export function isWorkspaceAdmin(role: WorkspaceRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}
