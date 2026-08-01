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

/** Three real phone states, filtered server-side (never after pagination). */
export type AdminPhoneStatusFilter = 'all' | 'verified' | 'unverified' | 'no_phone';

export type AdminVerificationMethod = 'sms_otp' | 'admin_manual' | null;

export interface AdminProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  company_name: string | null;
  website_domain: string | null;
  ai_mode: string | null;
  preferred_locale: string | null;
  signup_locale: string | null;
  signup_ip: string | null;
  created_at: string | null;
  updated_at: string | null;
  workspace_count: number;
  roles: string[];
  /** Masked only — the list never carries a full number. */
  phone_masked: string | null;
  phone_verified: boolean;
  phone_verified_at: string | null;
  phone_verification_method: AdminVerificationMethod;
}

export interface AdminWorkspaceRow {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  owner_email: string;
  member_count: number;
  contact_count: number;
  conversation_count: number;
  created_at: string;
  updated_at: string;
  owner_phone_masked: string | null;
  owner_phone_verified: boolean;
  owner_phone_verified_at: string | null;
  owner_phone_verification_method: AdminVerificationMethod;
}

export function useAdminProfiles(
  limit = 50,
  offset = 0,
  search = '',
  sort = 'newest',
  phoneStatus: AdminPhoneStatusFilter = 'all',
) {
  return useQuery({
    queryKey: ['admin-profiles', limit, offset, search, sort, phoneStatus],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_list_profiles', {
        _limit: limit,
        _offset: offset,
        _search: search,
        _sort: sort,
        _phone_status: phoneStatus,
      });
      if (error) throw error;
      return (data as unknown as AdminProfileRow[]) ?? [];
    },
  });
}

export function useAdminUserDetail(userId: string | null) {
  return useQuery({
    queryKey: ['admin-user-detail', userId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_get_user_detail', {
        _user_id: userId!,
      });
      if (error) throw error;
      return data as {
        profile: any;
        roles: string[];
        workspaces: Array<{ id: string; name: string; slug: string; role: string; created_at: string }>;
        account: { id: string; name: string; slug: string; role: string } | null;
      };
    },
    enabled: !!userId,
  });
}

export function useAdminProfileCount(search = '', phoneStatus: AdminPhoneStatusFilter = 'all') {
  return useQuery({
    queryKey: ['admin-profile-count', search, phoneStatus],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_count_profiles', {
        _search: search,
        _phone_status: phoneStatus,
      });
      if (error) throw error;
      return data as number;
    },
  });
}

export function useAdminWorkspaces(
  limit = 50,
  offset = 0,
  search = '',
  sort = 'newest',
  phoneStatus: AdminPhoneStatusFilter = 'all',
) {
  return useQuery({
    queryKey: ['admin-workspaces', limit, offset, search, sort, phoneStatus],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_list_workspaces', {
        _limit: limit,
        _offset: offset,
        _search: search,
        _sort: sort,
        _phone_status: phoneStatus,
      });
      if (error) throw error;
      return (data as unknown as AdminWorkspaceRow[]) ?? [];
    },
  });
}

export function useAdminWorkspaceCount(search = '', phoneStatus: AdminPhoneStatusFilter = 'all') {
  return useQuery({
    queryKey: ['admin-workspace-count', search, phoneStatus],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_count_workspaces', {
        _search: search,
        _phone_status: phoneStatus,
      });
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
