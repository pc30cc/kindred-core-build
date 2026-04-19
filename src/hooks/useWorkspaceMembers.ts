/**
 * Phase 3 — Workspace member directory for the assignee dropdown.
 *
 * Returns the union of (workspace_members JOIN profiles) so the UI can
 * display avatar + name + email and select a uuid for assigned_to. RLS
 * already restricts visibility to actual members of the workspace.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

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
      const { data: members, error } = await supabase
        .from('workspace_members')
        .select('user_id, role')
        .eq('workspace_id', workspaceId!);
      if (error) throw error;
      const ids = (members ?? []).map((m: any) => m.user_id).filter(Boolean);
      if (ids.length === 0) return [];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, email, avatar_url')
        .in('id', ids);
      return (members ?? []).map((m: any) => {
        const p = profiles?.find((p: any) => p.id === m.user_id);
        return {
          user_id: m.user_id,
          role: m.role,
          full_name: p?.full_name ?? null,
          email: p?.email ?? null,
          avatar_url: p?.avatar_url ?? null,
        };
      });
    },
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
}
