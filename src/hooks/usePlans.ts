import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';

async function plansFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body as T;
}

// ═══════════════════════════════════════════════════════════
// PUBLIC HOOKS — reuse the existing /api/plans router
// (server/routes/plans.ts), which already implements the exact
// public/workspace/admin authorization split this file used to bypass
// via direct supabase.from()/rpc() calls.
// ═══════════════════════════════════════════════════════════

export function usePlans() {
  return useQuery({
    queryKey: ['plans'],
    queryFn: async () => {
      const { plans } = await plansFetch<{ plans: any[] }>('/api/plans');
      return plans ?? [];
    },
  });
}

export function useWorkspacePlan(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['workspace-plan', workspaceId],
    queryFn: async () => {
      const info = await plansFetch<{ plan: any; subscription: any; entitlements: any; limits: any }>(
        `/api/plans/workspace/${workspaceId}`,
      );
      return {
        plan: info.plan || null,
        subscription: info.subscription || null,
        entitlements: (info.entitlements as Record<string, boolean>) || {},
        limits: (info.limits as Record<string, number>) || {},
      };
    },
    enabled: !!workspaceId,
  });
}

export function useWorkspaceUsage(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['workspace-usage', workspaceId],
    queryFn: async () => {
      const { usage } = await plansFetch<{ usage: any[] }>(`/api/plans/workspace/${workspaceId}/usage`);
      return usage?.[0] ?? null;
    },
    enabled: !!workspaceId,
  });
}

export function useFeatureCheck(workspaceId: string | undefined, feature: string) {
  return useQuery({
    queryKey: ['feature-check', workspaceId, feature],
    queryFn: () => plansFetch<{ allowed: boolean; limit?: number; plan?: string }>(
      `/api/plans/check?workspaceId=${workspaceId}&feature=${encodeURIComponent(feature)}`,
    ),
    enabled: !!workspaceId && !!feature,
    staleTime: 60_000,
  });
}

export function useModuleAccess(workspaceId: string | undefined, moduleKey: string) {
  return useQuery({
    queryKey: ['module-access', workspaceId, moduleKey],
    queryFn: async () => {
      const { modules } = await plansFetch<{ modules: Record<string, { allowed: boolean; source?: string }> }>(
        `/api/plans/workspace/${workspaceId}/modules`,
      );
      const result = modules?.[moduleKey];
      return { allowed: !!result?.allowed, source: result?.source ?? 'default' };
    },
    enabled: !!workspaceId && !!moduleKey,
    staleTime: 60_000,
  });
}

// ═══════════════════════════════════════════════════════════
// ADMIN HOOKS — every route below is under /api/plans/admin/*, which
// server/routes/plans.ts gates at the router level (requirePlatformAdmin
// runs before any handler here).
// ═══════════════════════════════════════════════════════════

export function useAdminPlans() {
  return useQuery({
    queryKey: ['admin-plans'],
    queryFn: async () => {
      const { plans } = await plansFetch<{ plans: any[] }>('/api/plans/admin/all');
      return plans ?? [];
    },
  });
}

export function useCreatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (plan: any) => plansFetch<{ plan: any }>('/api/plans/admin', {
      method: 'POST',
      body: JSON.stringify(plan),
    }).then((r) => r.plan),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-plans'] }); qc.invalidateQueries({ queryKey: ['plans'] }); },
  });
}

export function useUpdatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ planId, ...updates }: any) => {
      const { id, created_at, ...clean } = updates;
      const { plan } = await plansFetch<{ plan: any }>(`/api/plans/admin/${planId}`, {
        method: 'PUT',
        body: JSON.stringify(clean),
      });
      return plan;
    },
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
    mutationFn: (planId: string) => plansFetch(`/api/plans/admin/${planId}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-plans'] }); qc.invalidateQueries({ queryKey: ['plans'] }); },
  });
}

export function useAssignPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { workspaceId: string; planId: string; status?: string; expiresAt?: string }) =>
      plansFetch<{ subscription: any }>('/api/plans/admin/assign', {
        method: 'POST',
        body: JSON.stringify(data),
      }).then((r) => r.subscription),
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
      plansFetch('/api/plans/admin/revoke', { method: 'POST', body: JSON.stringify({ workspaceId }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-subscriptions'] });
      qc.invalidateQueries({ queryKey: ['workspace-plan'] });
    },
  });
}

export function useAdminSubscriptions() {
  return useQuery({
    queryKey: ['admin-subscriptions'],
    queryFn: async () => {
      const { subscriptions } = await plansFetch<{ subscriptions: any[] }>('/api/plans/admin/subscriptions');
      return subscriptions ?? [];
    },
  });
}

// ─── Module & Channel Overrides ───

export function useWorkspaceModuleOverrides(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['module-overrides', workspaceId],
    queryFn: async () => {
      const { modules } = await plansFetch<{ modules: any[] }>(`/api/plans/admin/overrides/${workspaceId}`);
      return modules ?? [];
    },
    enabled: !!workspaceId,
  });
}

export function useWorkspaceChannelOverrides(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['channel-overrides', workspaceId],
    queryFn: async () => {
      const { channels } = await plansFetch<{ channels: any[] }>(`/api/plans/admin/overrides/${workspaceId}`);
      return channels ?? [];
    },
    enabled: !!workspaceId,
  });
}

export function useSetModuleOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { workspaceId: string; moduleKey: string; enabled: boolean; adminNotes?: string }) =>
      plansFetch('/api/plans/admin/overrides/module', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['module-overrides'] }); },
  });
}

export function useSetChannelOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { workspaceId: string; channelKey: string; enabled: boolean; adminNotes?: string }) =>
      plansFetch('/api/plans/admin/overrides/channel', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['channel-overrides'] }); },
  });
}

// ─── Usage ───

export function useAdminWorkspaceUsage(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['admin-workspace-usage', workspaceId],
    queryFn: async () => {
      const { usage } = await plansFetch<{ usage: any[] }>(`/api/plans/admin/usage/${workspaceId}`);
      return usage ?? [];
    },
    enabled: !!workspaceId,
  });
}

// ─── Plan Change History ───

export function usePlanChangeHistory(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['plan-changes', workspaceId],
    queryFn: async () => {
      const { changes } = await plansFetch<{ changes: any[] }>(`/api/plans/admin/changes/${workspaceId}`);
      return changes ?? [];
    },
    enabled: !!workspaceId,
  });
}
