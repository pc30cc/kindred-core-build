import { supabase } from '@/lib/supabase';
import { useAuth } from '@/features/auth/AuthContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Workspace } from '@/types/models';

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

export function useCurrentWorkspace() {
  const { data: workspaces } = useWorkspaces();
  // For now, return first workspace. Later: workspace selector
  return workspaces?.[0] ?? null;
}

export function useCreateWorkspace() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ name, slug }: { name: string; slug: string }) => {
      // Create workspace
      const { data: ws, error: wsErr } = await supabase
        .from('workspaces')
        .insert({ name, slug, owner_id: user!.id })
        .select()
        .single();
      if (wsErr) throw wsErr;

      // Add owner as member
      const { error: memErr } = await supabase
        .from('workspace_members')
        .insert({ workspace_id: ws.id, user_id: user!.id, role: 'owner' });
      if (memErr) throw memErr;

      // Create default branding
      await supabase.from('workspace_branding').insert({ workspace_id: ws.id });

      // Create default widget settings
      await supabase.from('widget_settings').insert({ workspace_id: ws.id });

      return ws;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
}
