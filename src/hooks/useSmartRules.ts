import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  smartRuleSchema,
  validateSmartRuleForPublish,
  type SmartRuleRow,
  type SmartRuleDraft,
} from '@/lib/widget/smartRules';

const TABLE = 'widget_smart_rules';

const SELECT = 'id, workspace_id, name, description, status, priority, schema_version, published_version, '
  + 'trigger_config, audience_config, content_config, presentation_config, schedule_config, '
  + 'frequency_config, behavior_config, created_at, updated_at, published_at';

export function useSmartRules(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['widget-smart-rules', workspaceId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from(TABLE)
        .select(SELECT)
        .eq('workspace_id', workspaceId!)
        .order('priority', { ascending: false })
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return (data || []) as SmartRuleRow[];
    },
    enabled: !!workspaceId,
  });
}

/** Aggregated per-rule counters used by the rule list. */
export function useSmartRuleStats(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['widget-smart-rule-stats', workspaceId],
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const { data, error } = await (supabase as any)
        .from('widget_smart_events')
        .select('rule_id, event_type')
        .eq('workspace_id', workspaceId!)
        .gte('created_at', since)
        .limit(5000);
      if (error) throw error;
      const map: Record<string, { shown: number; opened: number; dismissed: number; cta: number; conversations: number }> = {};
      for (const row of data || []) {
        const entry = map[row.rule_id] ||= { shown: 0, opened: 0, dismissed: 0, cta: 0, conversations: 0 };
        if (row.event_type === 'shown') entry.shown++;
        else if (row.event_type === 'opened' || row.event_type === 'widget_opened') entry.opened++;
        else if (row.event_type === 'dismissed') entry.dismissed++;
        else if (row.event_type === 'cta_clicked') entry.cta++;
        else if (row.event_type === 'conversation_started') entry.conversations++;
      }
      return map;
    },
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
}

function stripDraft(draft: SmartRuleDraft) {
  const { id, workspace_id, created_at, updated_at, published_at, ...rest } = draft as any;
  return rest;
}

export function useSaveSmartRule(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (draft: SmartRuleDraft) => {
      if (!workspaceId) throw new Error('workspace_required');
      const payload = stripDraft(draft);

      // A rule may only reach `active` when the whole config validates.
      if (payload.status === 'active') {
        const issues = validateSmartRuleForPublish({
          ...payload,
          id: draft.id || '00000000-0000-0000-0000-000000000000',
          workspace_id: workspaceId,
        });
        if (issues.length) {
          const err: any = new Error('validation_failed');
          err.issues = issues;
          throw err;
        }
        payload.published_version = (Number(draft.published_version) || 0) + 1;
        payload.published_at = new Date().toISOString();
      }

      if (draft.id) {
        const { data, error } = await (supabase as any)
          .from(TABLE).update(payload).eq('id', draft.id).eq('workspace_id', workspaceId)
          .select(SELECT).single();
        if (error) throw error;
        return data as SmartRuleRow;
      }
      const { data, error } = await (supabase as any)
        .from(TABLE).insert({ ...payload, workspace_id: workspaceId })
        .select(SELECT).single();
      if (error) throw error;
      return data as SmartRuleRow;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['widget-smart-rules', workspaceId] });
    },
  });
}

export function useSetSmartRuleStatus(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ rule, status }: { rule: SmartRuleRow; status: 'draft' | 'active' | 'paused' }) => {
      const patch: Record<string, any> = { status };
      if (status === 'active') {
        const issues = validateSmartRuleForPublish({ ...rule, status: 'active' });
        if (issues.length) {
          const err: any = new Error('validation_failed');
          err.issues = issues;
          throw err;
        }
        patch.published_version = (Number(rule.published_version) || 0) + 1;
        patch.published_at = new Date().toISOString();
      }
      const { error } = await (supabase as any)
        .from(TABLE).update(patch).eq('id', rule.id).eq('workspace_id', workspaceId!);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['widget-smart-rules', workspaceId] }),
  });
}

export function useDeleteSmartRule(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ruleId: string) => {
      const { error } = await (supabase as any)
        .from(TABLE).delete().eq('id', ruleId).eq('workspace_id', workspaceId!);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['widget-smart-rules', workspaceId] }),
  });
}

export function useDuplicateSmartRule(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rule: SmartRuleRow) => {
      const { id, workspace_id, created_at, updated_at, published_at, ...rest } = rule as any;
      const { error } = await (supabase as any).from(TABLE).insert({
        ...rest,
        workspace_id: workspaceId,
        name: `${rule.name} (copy)`,
        status: 'draft',
        published_version: 0,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['widget-smart-rules', workspaceId] }),
  });
}

export { smartRuleSchema };