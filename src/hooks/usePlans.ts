import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';

async function planRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/plans${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

// ─── Public hooks ───

export function usePlans() {
  return useQuery({
    queryKey: ['plans'],
    queryFn: () => planRequest<{ plans: any[] }>('/'),
    select: (d) => d.plans,
    enabled: !!API_BASE,
  });
}

export function useWorkspacePlan(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['workspace-plan', workspaceId],
    queryFn: () => planRequest<{
      plan: any;
      subscription: any;
      entitlements: Record<string, boolean>;
      limits: Record<string, number>;
    }>(`/workspace/${workspaceId}`),
    enabled: !!API_BASE && !!workspaceId,
  });
}

export function useFeatureCheck(workspaceId: string | undefined, feature: string) {
  return useQuery({
    queryKey: ['feature-check', workspaceId, feature],
    queryFn: () => planRequest<{ allowed: boolean; limit?: number; plan?: string }>(
      `/check?workspaceId=${workspaceId}&feature=${feature}`
    ),
    enabled: !!API_BASE && !!workspaceId && !!feature,
    staleTime: 60_000,
  });
}

// ─── Admin hooks ───

export function useAdminPlans() {
  return useQuery({
    queryKey: ['admin-plans'],
    queryFn: () => planRequest<{ plans: any[] }>('/admin/all'),
    select: (d) => d.plans,
    enabled: !!API_BASE,
  });
}

export function useCreatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (plan: any) => planRequest('/admin', { method: 'POST', body: JSON.stringify(plan) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-plans'] });
      qc.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

export function useUpdatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ planId, ...updates }: any) =>
      planRequest(`/admin/${planId}`, { method: 'PUT', body: JSON.stringify(updates) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-plans'] });
      qc.invalidateQueries({ queryKey: ['plans'] });
      qc.invalidateQueries({ queryKey: ['workspace-plan'] });
    },
  });
}

export function useDeletePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => planRequest(`/admin/${planId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-plans'] });
      qc.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

export function useAssignPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { workspaceId: string; planId: string; status?: string; expiresAt?: string }) =>
      planRequest('/admin/assign', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-subscriptions'] });
      qc.invalidateQueries({ queryKey: ['workspace-plan'] });
    },
  });
}

export function useRevokePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) =>
      planRequest('/admin/revoke', { method: 'POST', body: JSON.stringify({ workspaceId }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-subscriptions'] });
      qc.invalidateQueries({ queryKey: ['workspace-plan'] });
    },
  });
}

export function useAdminSubscriptions() {
  return useQuery({
    queryKey: ['admin-subscriptions'],
    queryFn: () => planRequest<{ subscriptions: any[] }>('/admin/subscriptions'),
    select: (d) => d.subscriptions,
    enabled: !!API_BASE,
  });
}
