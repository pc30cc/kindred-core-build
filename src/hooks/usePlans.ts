import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';

async function plansFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  // The whole answer rides along (e.g. the plan editor shows a 400's `issues`).
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed: ${res.status}`), { status: res.status, body });
  return body as T;
}

/** A `billing_plans` row as the plan endpoints return it. */
export interface PlanRow {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  is_free?: boolean | null;
  is_active?: boolean | null;
  is_hidden?: boolean | null;
  sort_order?: number | null;
  trial_days?: number | null;
  default_currency?: string | null;
  prices?: Record<string, { monthly: number; yearly: number }> | null;
  entitlements?: Record<string, unknown> | null;
  limits?: Record<string, unknown> | null;
  provider_price_ids?: Record<string, unknown> | null;
  localized?: Record<string, { name: string; description: string }> | null;
  /** Days a locked workspace's data is kept before deletion; null = never deleted. */
  locked_data_retention_days?: number | null;
  /** Monthly AI credit per currency, in the AI wallet's unit (IRR: Rial; others: minor units). */
  ai_allowance?: Record<string, number> | null;
}

/** A `workspace_subscriptions` row (with its plan where the endpoint joins it). */
export interface SubscriptionRow {
  id: string;
  workspace_id: string;
  plan_id?: string | null;
  status?: string | null;
  provider_name?: string | null;
  current_period_start?: string | null;
  current_period_end?: string | null;
  trial_end?: string | null;
  cancel_at_period_end?: boolean | null;
  billing_plans?: { id: string; name: string; slug: string } | null;
}

/** A row the page reads loosely (usage counters, overrides, change log). */
export type LooseRow = Record<string, unknown>;

/** The body of a plan create or update: whitelisted columns, checked by the server. */
export type PlanPayload = Record<string, unknown>;

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
      const { plans } = await plansFetch<{ plans: PlanRow[] }>('/api/plans');
      return plans ?? [];
    },
  });
}

export function useWorkspacePlan(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['workspace-plan', workspaceId],
    queryFn: async () => {
      const info = await plansFetch<{ plan: PlanRow | null; subscription: SubscriptionRow | null; entitlements: unknown; limits: unknown }>(
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
      const { usage } = await plansFetch<{ usage: LooseRow[] }>(`/api/plans/workspace/${workspaceId}/usage`);
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
      const { plans } = await plansFetch<{ plans: PlanRow[] }>('/api/plans/admin/all');
      return plans ?? [];
    },
  });
}

export function useCreatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (plan: PlanPayload) => plansFetch<{ plan: PlanRow }>('/api/plans/admin', {
      method: 'POST',
      body: JSON.stringify(plan),
    }).then((r) => r.plan),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-plans'] }); qc.invalidateQueries({ queryKey: ['plans'] }); },
  });
}

export function useUpdatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ planId, ...updates }: { planId: string } & PlanPayload) => {
      const { id, created_at, ...clean } = updates;
      const { plan } = await plansFetch<{ plan: PlanRow }>(`/api/plans/admin/${planId}`, {
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
      plansFetch<{ subscription: SubscriptionRow }>('/api/plans/admin/assign', {
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
      const { subscriptions } = await plansFetch<{ subscriptions: SubscriptionRow[] }>('/api/plans/admin/subscriptions');
      return subscriptions ?? [];
    },
  });
}

// ─── Module & Channel Overrides ───

export function useWorkspaceModuleOverrides(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['module-overrides', workspaceId],
    queryFn: async () => {
      const { modules } = await plansFetch<{ modules: LooseRow[] }>(`/api/plans/admin/overrides/${workspaceId}`);
      return modules ?? [];
    },
    enabled: !!workspaceId,
  });
}

export function useWorkspaceChannelOverrides(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['channel-overrides', workspaceId],
    queryFn: async () => {
      const { channels } = await plansFetch<{ channels: LooseRow[] }>(`/api/plans/admin/overrides/${workspaceId}`);
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
      const { usage } = await plansFetch<{ usage: LooseRow[] }>(`/api/plans/admin/usage/${workspaceId}`);
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
      const { changes } = await plansFetch<{ changes: LooseRow[] }>(`/api/plans/admin/changes/${workspaceId}`);
      return changes ?? [];
    },
    enabled: !!workspaceId,
  });
}
