import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
import {
  smartRuleSchema,
  validateSmartRuleForPublish,
  type SmartRuleRow,
  type SmartRuleDraft,
} from '@/lib/widget/smartRules';

const API_BASE = RESOLVED_API_BASE || '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * All rule reads/writes go through the Express boundary.
 *
 * The browser has no Supabase session in this self-hosted deployment
 * (first-party auth), so the previous direct table access was silently
 * filtered to zero rows by RLS (`is_workspace_member(..., auth.uid())`) and
 * the Smart Engagement tab always looked empty.
 */
function rulesUrl(workspaceId: string, suffix = ''): string {
  return `${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/smart-rules${suffix}`;
}

async function callApi(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { credentials: 'include', ...init });
  const raw = await res.text();
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`Unexpected response (HTTP ${res.status}): ${raw.slice(0, 160)}`);
  }
  if (!res.ok) {
    const err: any = new Error(json?.error || `Request failed: ${res.status}`);
    err.issues = json?.issues;
    throw err;
  }
  return json;
}

/** Server-side publish boundary — never write status:'active' directly. */
async function publishSmartRule(workspaceId: string, ruleId: string): Promise<SmartRuleRow> {
  const json = await callApi(rulesUrl(workspaceId, `/${encodeURIComponent(ruleId)}/publish`), {
    method: 'POST',
    headers: JSON_HEADERS,
  });
  return json.rule as SmartRuleRow;
}

async function unpublishSmartRule(workspaceId: string, ruleId: string): Promise<SmartRuleRow> {
  const json = await callApi(rulesUrl(workspaceId, `/${encodeURIComponent(ruleId)}/unpublish`), {
    method: 'POST',
    headers: JSON_HEADERS,
  });
  return json.rule as SmartRuleRow;
}

export function useSmartRules(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['widget-smart-rules', workspaceId],
    queryFn: async () => {
      const json = await callApi(rulesUrl(workspaceId!));
      return (json.rules || []) as SmartRuleRow[];
    },
    enabled: !!workspaceId,
  });
}

/** Aggregated per-rule counters used by the rule list. */
export function useSmartRuleStats(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['widget-smart-rule-stats', workspaceId],
    queryFn: async () => {
      const json = await callApi(rulesUrl(workspaceId!, '/stats'));
      return (json.stats || {}) as Record<
        string,
        { shown: number; opened: number; dismissed: number; cta: number; conversations: number }
      >;
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
      const wantsPublish = payload.status === 'active';
      // Draft writes never set the rule live directly — `active` is only
      // reachable through the server-side publish endpoint below, which
      // re-validates and owns published_version.
      if (wantsPublish) payload.status = draft.id ? 'paused' : 'draft';

      const json = draft.id
        ? await callApi(rulesUrl(workspaceId, `/${encodeURIComponent(draft.id)}`), {
            method: 'PATCH',
            headers: JSON_HEADERS,
            body: JSON.stringify(payload),
          })
        : await callApi(rulesUrl(workspaceId), {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(payload),
          });
      let saved = json.rule as SmartRuleRow;
      if (wantsPublish) saved = await publishSmartRule(workspaceId, saved.id);
      return saved;
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
      if (!workspaceId) throw new Error('workspace_required');
      if (status === 'active') {
        await publishSmartRule(workspaceId, rule.id);
        return;
      }
      if (status === 'paused' && rule.status === 'active') {
        // Unpublish keeps the published snapshot intact for a re-publish.
        await unpublishSmartRule(workspaceId, rule.id);
        return;
      }
      await callApi(rulesUrl(workspaceId, `/${encodeURIComponent(rule.id)}`), {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ status }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['widget-smart-rules', workspaceId] }),
  });
}

export function useDeleteSmartRule(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ruleId: string) => {
      await callApi(rulesUrl(workspaceId!, `/${encodeURIComponent(ruleId)}`), { method: 'DELETE' });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['widget-smart-rules', workspaceId] }),
  });
}

export function useDuplicateSmartRule(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rule: SmartRuleRow) => {
      if (!workspaceId) throw new Error('workspace_required');
      const { id, workspace_id, created_at, updated_at, published_at, status, ...rest } = rule as any;
      await callApi(rulesUrl(workspaceId), {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...rest, name: `${rule.name} (copy)`, status: 'draft' }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['widget-smart-rules', workspaceId] }),
  });
}

export { smartRuleSchema, validateSmartRuleForPublish };
