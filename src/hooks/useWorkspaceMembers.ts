/**
 * Phase 3 — Workspace member directory for the assignee dropdown.
 *
 * Returns the union of (workspace_members JOIN profiles) so the UI can
 * display avatar + name + email and select a uuid for assigned_to.
 *
 * Reuses GET /api/workspace-members (gs_session cookie + service_role,
 * server/routes/workspaceMembers.ts) rather than direct supabase.from()
 * calls — the dashboard's browser session no longer carries a Supabase
 * Auth JWT, so auth.uid()-scoped RLS on a direct query would silently
 * return nothing. Same any-member read access as before.
 */

import { useQuery } from '@tanstack/react-query';

const API_BASE = import.meta.env.VITE_API_BASE_URL;

export interface WorkspaceMember {
  user_id: string;
  role: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

export function useWorkspaceMembers(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['workspace-members', workspaceId],
    queryFn: async (): Promise<WorkspaceMember[]> => {
      const res = await fetch(`${API_BASE}/api/workspace-members?workspaceId=${workspaceId}`, { credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `API error: ${res.status}`);
      }
      const { members } = await res.json();
      return (members ?? []).map((m: any) => ({
        user_id: m.user_id,
        role: m.role,
        full_name: m.profile?.full_name ?? null,
        email: m.profile?.email ?? null,
        avatar_url: m.profile?.avatar_url ?? null,
      }));
    },
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
}
