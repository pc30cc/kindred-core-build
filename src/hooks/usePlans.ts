import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

// ═══════════════════════════════════════════════════════════
// PUBLIC HOOKS
// ═══════════════════════════════════════════════════════════

export function usePlans() {
  return useQuery({
    queryKey: ['plans'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('billing_plans')
        .select('*')
        .eq('is_active', true)
        .order('sort_order');
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useWorkspacePlan(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['workspace-plan', workspaceId],
    queryFn: async () => {
      const { data: sub } = await supabase
        .from('workspace_subscriptions')
        .select('*, billing_plans(*)')
        .eq('workspace_id', workspaceId!)
        .maybeSingle();

      let plan = sub?.billing_plans;
      if (!plan || !sub || !['active', 'trialing'].includes(sub.status || '')) {
        const { data: freePlan } = await supabase
          .from('billing_plans')
          .select('*')
          .eq('slug', 'free')
          .eq('is_active', true)
          .maybeSingle();
        plan = freePlan;
      }

      return {
        plan: plan || null,
        subscription: sub ? { ...sub, billing_plans: undefined } : null,
        entitlements: (plan?.entitlements as Record<string, boolean>) || {},
        limits: (plan?.limits as Record<string, number>) || {},
      };
    },
    enabled: !!workspaceId,
  });
}

export function useWorkspaceUsage(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['workspace-usage', workspaceId],
    queryFn: async () => {
      const period = new Date().toISOString().slice(0, 7);
      const { data, error } = await supabase
        .from('workspace_usage_counters')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .eq('period', period)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!workspaceId,
  });
}

export function useFeatureCheck(workspaceId: string | undefined, feature: string) {
  return useQuery({
    queryKey: ['feature-check', workspaceId, feature],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('check_workspace_entitlement', {
        _workspace_id: workspaceId!,
        _feature: feature,
      });
      if (error) throw error;
      return data as { allowed: boolean; limit?: number; plan?: string };
    },
    enabled: !!workspaceId && !!feature,
    staleTime: 60_000,
  });
}

export function useModuleAccess(workspaceId: string | undefined, moduleKey: string) {
  return useQuery({
    queryKey: ['module-access', workspaceId, moduleKey],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('check_module_access', {
        _workspace_id: workspaceId!,
        _module_key: moduleKey,
      });
      if (error) throw error;
      return data as { allowed: boolean; source: string };
    },
    enabled: !!workspaceId && !!moduleKey,
    staleTime: 60_000,
  });
}

// ═══════════════════════════════════════════════════════════
// ADMIN HOOKS
// ═══════════════════════════════════════════════════════════

export function useAdminPlans() {
  return useQuery({
    queryKey: ['admin-plans'],
    queryFn: async () => {
      const { data, error } = await supabase.from('billing_plans').select('*').order('sort_order');
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useCreatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (plan: any) => {
      const { data, error } = await supabase.from('billing_plans').insert({
        name: plan.name, slug: plan.slug, description: plan.description || null,
        prices: plan.prices || {}, entitlements: plan.entitlements || {}, limits: plan.limits || {},
        localized: plan.localized || {}, is_free: plan.is_free || false,
        is_active: plan.is_active !== false, is_hidden: plan.is_hidden === true,
        sort_order: plan.sort_order || 0,
        trial_days: plan.trial_days || 0, default_currency: plan.default_currency || 'USD',
        provider_price_ids: plan.provider_price_ids || {},
      }).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-plans'] }); qc.invalidateQueries({ queryKey: ['plans'] }); },
  });
}

export function useUpdatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ planId, ...updates }: any) => {
      const { id, created_at, ...clean } = updates;
      const { data, error } = await supabase.from('billing_plans')
        .update({ ...clean, updated_at: new Date().toISOString() })
        .eq('id', planId).select().single();
      if (error) throw error;
      return data;
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
    mutationFn: async (planId: string) => {
      const { error } = await supabase.from('billing_plans')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', planId);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-plans'] }); qc.invalidateQueries({ queryKey: ['plans'] }); },
  });
}

export function useAssignPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { workspaceId: string; planId: string; status?: string; expiresAt?: string }) => {
      // Log old plan
      const { data: oldSub } = await supabase
        .from('workspace_subscriptions')
        .select('plan_id')
        .eq('workspace_id', data.workspaceId)
        .maybeSingle();

      const { data: result, error } = await supabase.from('workspace_subscriptions').upsert({
        workspace_id: data.workspaceId, plan_id: data.planId, provider_name: 'manual',
        status: data.status || 'active',
        current_period_start: new Date().toISOString(),
        current_period_end: data.expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id' }).select().single();
      if (error) throw error;

      // Log plan change
      await supabase.from('plan_change_log').insert({
        workspace_id: data.workspaceId,
        old_plan_id: oldSub?.plan_id || null,
        new_plan_id: data.planId,
        change_type: oldSub ? 'change' : 'initial',
        metadata: { source: 'admin_ui' },
      });

      return result;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-subscriptions'] });
      qc.invalidateQueries({ queryKey: ['workspace-plan'] });
    },
  });
}

export function useRevokePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (workspaceId: string) => {
      const { data: oldSub } = await supabase
        .from('workspace_subscriptions')
        .select('plan_id')
        .eq('workspace_id', workspaceId)
        .maybeSingle();

      if (oldSub) {
        await supabase.from('plan_change_log').insert({
          workspace_id: workspaceId,
          old_plan_id: oldSub.plan_id,
          new_plan_id: null,
          change_type: 'revoke',
          metadata: { source: 'admin_ui' },
        });
      }

      const { error } = await supabase.from('workspace_subscriptions').delete().eq('workspace_id', workspaceId);
      if (error) throw error;
    },
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
      const { data, error } = await supabase
        .from('workspace_subscriptions')
        .select('*, billing_plans(name, slug)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

// ─── Module & Channel Overrides ───

export function useWorkspaceModuleOverrides(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['module-overrides', workspaceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspace_module_overrides')
        .select('*')
        .eq('workspace_id', workspaceId!);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!workspaceId,
  });
}

export function useWorkspaceChannelOverrides(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['channel-overrides', workspaceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspace_channel_overrides')
        .select('*')
        .eq('workspace_id', workspaceId!);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!workspaceId,
  });
}

export function useSetModuleOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { workspaceId: string; moduleKey: string; enabled: boolean; adminNotes?: string }) => {
      const { error } = await supabase.from('workspace_module_overrides').upsert({
        workspace_id: data.workspaceId, module_key: data.moduleKey,
        enabled: data.enabled, admin_notes: data.adminNotes || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id,module_key' });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['module-overrides'] }); },
  });
}

export function useSetChannelOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { workspaceId: string; channelKey: string; enabled: boolean; adminNotes?: string }) => {
      const { error } = await supabase.from('workspace_channel_overrides').upsert({
        workspace_id: data.workspaceId, channel_key: data.channelKey,
        enabled: data.enabled, admin_notes: data.adminNotes || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id,channel_key' });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['channel-overrides'] }); },
  });
}

// ─── Usage ───

export function useAdminWorkspaceUsage(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['admin-workspace-usage', workspaceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspace_usage_counters')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .order('period', { ascending: false })
        .limit(12);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!workspaceId,
  });
}

// ─── Plan Change History ───

export function usePlanChangeHistory(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['plan-changes', workspaceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('plan_change_log')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!workspaceId,
  });
}
