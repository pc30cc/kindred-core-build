import { useAuth } from '@/features/auth/AuthContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export function useIsGlobalAdmin() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['global-admin', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('has_role', {
        _user_id: user!.id,
        _role: 'admin',
      });
      if (error) throw error;
      return data as boolean;
    },
    enabled: !!user,
  });
}

export function useAdminProfiles(limit = 50, offset = 0) {
  return useQuery({
    queryKey: ['admin-profiles', limit, offset],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_list_profiles', {
        _limit: limit,
        _offset: offset,
      });
      if (error) throw error;
      return data as Array<{
        id: string;
        email: string;
        full_name: string | null;
        avatar_url: string | null;
        preferred_locale: string | null;
        created_at: string | null;
        updated_at: string | null;
      }>;
    },
  });
}

export function useAdminProfileCount() {
  return useQuery({
    queryKey: ['admin-profile-count'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_count_profiles');
      if (error) throw error;
      return data as number;
    },
  });
}

export function useAdminWorkspaces(limit = 50, offset = 0) {
  return useQuery({
    queryKey: ['admin-workspaces', limit, offset],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_list_workspaces', {
        _limit: limit,
        _offset: offset,
      });
      if (error) throw error;
      return data as Array<{
        id: string;
        name: string;
        slug: string;
        owner_id: string;
        owner_email: string;
        member_count: number;
        created_at: string;
        updated_at: string;
      }>;
    },
  });
}

export function useAdminWorkspaceCount() {
  return useQuery({
    queryKey: ['admin-workspace-count'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_count_workspaces');
      if (error) throw error;
      return data as number;
    },
  });
}

export function useAdminWorkspaceDetail(workspaceId: string | null) {
  return useQuery({
    queryKey: ['admin-workspace-detail', workspaceId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_get_workspace_detail', {
        _workspace_id: workspaceId!,
      });
      if (error) throw error;
      return data as {
        workspace: any;
        members: Array<{ id: string; user_id: string; role: string; created_at: string; email: string; full_name: string | null }>;
        branding: any;
        widget_settings: any;
        contact_count: number;
        conversation_count: number;
      };
    },
    enabled: !!workspaceId,
  });
}

export function useAdminDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (workspaceId: string) => {
      const { data, error } = await supabase.rpc('admin_delete_workspace', {
        _workspace_id: workspaceId,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-workspaces'] });
      qc.invalidateQueries({ queryKey: ['admin-workspace-count'] });
      qc.invalidateQueries({ queryKey: ['admin-workspace-detail'] });
    },
  });
}

export function useAdminUserRoles(userId: string) {
  return useQuery({
    queryKey: ['admin-user-roles', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('user_roles')
        .select('*')
        .eq('user_id', userId);
      if (error) throw error;
      return data;
    },
    enabled: !!userId,
  });
}

export function useAssignRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: 'admin' | 'moderator' | 'user' }) => {
      const { error } = await supabase
        .from('user_roles')
        .upsert({ user_id: userId, role }, { onConflict: 'user_id,role' });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-user-roles'] });
      qc.invalidateQueries({ queryKey: ['admin-profiles'] });
    },
  });
}

export function useRemoveRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: 'admin' | 'moderator' | 'user' }) => {
      const { error } = await supabase
        .from('user_roles')
        .delete()
        .eq('user_id', userId)
        .eq('role', role);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-user-roles'] });
    },
  });
}

export function useBootstrapAdmin() {
  const { user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('bootstrap_admin', {
        _user_id: user!.id,
      });
      if (error) throw error;
      return data as boolean;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['global-admin'] });
    },
  });
}

export function useAdminFeatureFlags() {
  return useQuery({
    queryKey: ['admin-feature-flags'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('feature_flags')
        .select('*')
        .is('workspace_id', null)
        .order('key');
      if (error) throw error;
      return data;
    },
  });
}

export function useAdminAuditLogs(limit = 50) {
  return useQuery({
    queryKey: ['admin-audit-logs', limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data;
    },
  });
}

export function useAdminProviderConfigs() {
  return useQuery({
    queryKey: ['admin-provider-configs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('provider_configs')
        .select('*')
        .order('provider_type');
      if (error) throw error;
      return data;
    },
  });
}

export function useAdminRuntimeConfig() {
  return useQuery({
    queryKey: ['admin-runtime-config'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('app_runtime_config')
        .select('*')
        .order('key');
      if (error) throw error;
      return data;
    },
  });
}
