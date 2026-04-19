/**
 * Returns the current user's role within a workspace, or null if not a member.
 * Used by permission-aware UIs (e.g. canned responses settings).
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/features/auth/AuthContext';

export type WorkspaceRole = 'owner' | 'admin' | 'agent' | string;

export function useWorkspaceRole(workspaceId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['workspace-role', workspaceId, user?.id],
    queryFn: async (): Promise<WorkspaceRole | null> => {
      const { data, error } = await supabase
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', workspaceId!)
        .eq('user_id', user!.id)
        .maybeSingle();
      if (error) throw error;
      return (data?.role as WorkspaceRole) ?? null;
    },
    enabled: !!workspaceId && !!user?.id,
    staleTime: 60_000,
  });
}

export function isWorkspaceAdmin(role: WorkspaceRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}
