import { useAuth } from '@/features/auth/AuthContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';

async function adminFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body as T;
}

export function useIsGlobalAdmin() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['global-admin', user?.id],
    queryFn: async () => {
      const { isAdmin } = await adminFetch<{ isAdmin: boolean }>('/api/admin-status/is-admin');
      return isAdmin;
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
      const params = new URLSearchParams({
        limit: String(limit), offset: String(offset), search, sort, phoneStatus,
      });
      const { profiles } = await adminFetch<{ profiles: AdminProfileRow[] }>(`/api/admin/management/users?${params}`);
      return profiles ?? [];
    },
  });
}

export function useAdminUserDetail(userId: string | null) {
  return useQuery({
    queryKey: ['admin-user-detail', userId],
    queryFn: () => adminFetch<{
      profile: any;
      roles: string[];
      workspaces: Array<{ id: string; name: string; slug: string; role: string; created_at: string }>;
      account: { id: string; name: string; slug: string; role: string } | null;
    }>(`/api/admin/management/users/${userId}`),
    enabled: !!userId,
  });
}

export function useAdminProfileCount(search = '', phoneStatus: AdminPhoneStatusFilter = 'all') {
  return useQuery({
    queryKey: ['admin-profile-count', search, phoneStatus],
    queryFn: async () => {
      const params = new URLSearchParams({ search, phoneStatus });
      const { count } = await adminFetch<{ count: number }>(`/api/admin/management/users/count?${params}`);
      return count;
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
      const params = new URLSearchParams({
        limit: String(limit), offset: String(offset), search, sort, phoneStatus,
      });
      const { workspaces } = await adminFetch<{ workspaces: AdminWorkspaceRow[] }>(`/api/admin/management/workspaces?${params}`);
      return workspaces ?? [];
    },
  });
}

export function useAdminWorkspaceCount(search = '', phoneStatus: AdminPhoneStatusFilter = 'all') {
  return useQuery({
    queryKey: ['admin-workspace-count', search, phoneStatus],
    queryFn: async () => {
      const params = new URLSearchParams({ search, phoneStatus });
      const { count } = await adminFetch<{ count: number }>(`/api/admin/management/workspaces/count?${params}`);
      return count;
    },
  });
}

export function useAdminWorkspaceDetail(workspaceId: string | null) {
  return useQuery({
    queryKey: ['admin-workspace-detail', workspaceId],
    queryFn: () => adminFetch<{
      workspace: any;
      members: Array<{ id: string; user_id: string; role: string; created_at: string; email: string; full_name: string | null }>;
      branding: any;
      widget_settings: any;
      contact_count: number;
      conversation_count: number;
    }>(`/api/admin/management/workspaces/${workspaceId}`),
    enabled: !!workspaceId,
  });
}

export function useAdminDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) =>
      adminFetch(`/api/admin/management/workspaces/${workspaceId}`, { method: 'DELETE' }),
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
      const { roles } = await adminFetch<{ roles: any[] }>(`/api/admin/management/users/${userId}/roles`);
      return roles;
    },
    enabled: !!userId,
  });
}

export function useAssignRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'admin' | 'moderator' | 'user' }) =>
      adminFetch(`/api/admin/management/users/${userId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-user-roles'] });
      qc.invalidateQueries({ queryKey: ['admin-profiles'] });
    },
  });
}

export function useRemoveRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'admin' | 'moderator' | 'user' }) =>
      adminFetch(`/api/admin/management/users/${userId}/roles/${role}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-user-roles'] });
    },
  });
}

export function useBootstrapAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { promoted } = await adminFetch<{ promoted: boolean }>('/api/admin-status/bootstrap', { method: 'POST' });
      return promoted;
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
      const { flags } = await adminFetch<{ flags: any[] }>('/api/admin/management/feature-flags');
      return flags;
    },
  });
}

export function useAdminAuditLogs(limit = 50) {
  return useQuery({
    queryKey: ['admin-audit-logs', limit],
    queryFn: async () => {
      const { logs } = await adminFetch<{ logs: any[] }>(`/api/admin/management/audit-logs?limit=${limit}`);
      return logs;
    },
  });
}

export function useAdminProviderConfigs() {
  return useQuery({
    queryKey: ['admin-provider-configs'],
    queryFn: async () => {
      const { configs } = await adminFetch<{ configs: any[] }>('/api/admin/management/provider-configs');
      return configs;
    },
  });
}

export function useAdminRuntimeConfig() {
  return useQuery({
    queryKey: ['admin-runtime-config'],
    queryFn: async () => {
      const { config } = await adminFetch<{ config: any[] }>('/api/admin/management/runtime-config');
      return config;
    },
  });
}
