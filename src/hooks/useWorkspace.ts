import { supabase } from '@/lib/supabase';
import { useAuth } from '@/features/auth/AuthContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { useMemo, useCallback } from 'react';
import type { Workspace } from '@/types/models';

/** Fetch all workspaces the current user is a member of */
export function useWorkspaces() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['workspaces', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspaces')
        .select('*, workspace_members!inner(user_id)')
        .eq('workspace_members.user_id', user!.id);
      if (error) throw error;
      return data as Workspace[];
    },
    enabled: !!user,
  });
}

/**
 * Route-based active workspace.
 * Reads :slug from /app/w/:slug/* and resolves it against the user's workspaces.
 * Falls back to the first workspace if no slug in URL.
 */
export function useActiveWorkspace() {
  const { slug } = useParams<{ slug: string }>();
  const { data: workspaces, isLoading } = useWorkspaces();

  const workspace = useMemo(() => {
    if (!workspaces?.length) return null;
    if (slug) {
      return workspaces.find(w => w.slug === slug) ?? workspaces[0];
    }
    return workspaces[0];
  }, [workspaces, slug]);

  return { workspace, workspaces: workspaces ?? [], isLoading };
}

/** @deprecated Use useActiveWorkspace instead */
export function useCurrentWorkspace() {
  const { workspace } = useActiveWorkspace();
  return workspace;
}

/** Build a workspace-scoped path */
export function useWorkspacePath() {
  const { workspace } = useActiveWorkspace();
  return useCallback(
    (path: string) => workspace ? `/app/w/${workspace.slug}${path}` : `/app${path}`,
    [workspace]
  );
}

/** Create a workspace atomically via RPC */
export function useCreateWorkspace() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ accountId, name, slug }: { accountId: string; name: string; slug: string }) => {
      const { data, error } = await supabase.rpc('create_workspace_atomic', {
        _account_id: accountId,
        _name: name,
        _slug: slug,
        _user_id: user!.id,
      });
      if (error) throw error;
      return data as string; // workspace id
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
}

/** Fetch the user's account */
export function useAccount() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['account', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('accounts')
        .select('*, account_members!inner(user_id)')
        .eq('account_members.user_id', user!.id)
        .limit(1)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });
}
